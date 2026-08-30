import http from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unwatchFile,
  watchFile,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent as UndiciAgent } from 'undici';
import {
  backendIds,
  defaultBackendVariables,
  getBackend,
  loadBackendCatalog,
  planBackend,
  planBackendCatalog
} from './backend-catalog.mjs';
import { defaultBenchmarksRoot, loadBenchmarkEvidence, validateBenchmarkEvidence } from './benchmarks.mjs';
import {
  buildClientIntegrationManifest,
  CLIENT_INTEGRATIONS_MEDIA_TYPE,
  createClientIntegrationStatus,
  validateClientIntegrationManifest
} from './client-integrations.mjs';
import {
  applyCommunityRecommendations,
  benchmarkDocumentsFromCommunityPlan,
  createCommunityPlan,
  recipeDocumentsFromCommunityPlan,
  selectedRecipeIdFromCommunityPlan
} from './community-client.mjs';
import { defaultLloomHome, loadConfig } from './config.mjs';
import { createDoctorReport } from './doctor.mjs';
import { readHostMemory } from './host-memory.mjs';
import { MACHINE_PROFILE_MEDIA_TYPE, profileMachine, rankRecipes, validateMachineProfile } from './machine-profile.mjs';
import { applyModelImport, createModelImportPlan } from './model-intake.mjs';
import { applyOnboarding, createOnboardingPlan } from './onboarding.mjs';
import { applyRecipePack, createRecipePackPlan } from './recipe-pack.mjs';
import { buildRecipeIndexReport } from './recipe-index.mjs';
import { loadRecipes } from './recipes.mjs';
import { createRegistry, UnknownModelError } from './registry.mjs';
import { RuntimeManager, runtimeWatchdogConfig } from './runtime-manager.mjs';
import {
  applyRuntimePolicyPlan,
  createRuntimePolicyPlan,
  runtimeAdmissionBlockers,
  RuntimeAdmissionError
} from './runtime-policy.mjs';
import { applySetup, createSetupPlan } from './setup.mjs';
import { createSetupStatus } from './setup-status.mjs';
import { renderDashboardPage } from './dashboard.mjs';
import { applyBackend } from './installer.mjs';
import { normalizeSpeechRequestBody, resolveTtsDescriptor } from './tts-catalog.mjs';
import { defaultVoicesRoot, listVoiceProfiles, listVoicesDiscovery, resolveSpeechVoice } from './voice-profiles.mjs';
import {
  anthropicMessagesToOpenAI,
  encodeSseBlock,
  metricUsageFromOpenAI,
  normalizeOpenAIChatCompletionBody,
  normalizeOpenAIChatCompletionChunk,
  normalizeStructuredOutputChatCompletion,
  normalizeOpenAIChatRequestBody,
  translateReasoningEffortForBackend,
  openAIStreamChunkHasContent,
  openAIToAnthropic,
  openAIToResponses,
  parseSseBlock,
  prepareStructuredOutputForBackend,
  readSseEvents,
  responsesToOpenAIChat,
  rewriteJsonModelText,
  StructuredOutputError,
  streamAnthropicFromOpenAI,
  streamResponsesFromOpenAI,
  usageFromJsonBuffer,
  usageFromJsonText
} from './protocol/index.mjs';
import { assertBindAllowed, authorizeRequest, corsHeaders, securityPublicStatus } from './security.mjs';
import { ClusterCoordinator, currentNodeId } from './cluster.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
const SSE_TYPE = 'text/event-stream; charset=utf-8';
const execFileAsync = promisify(execFile);
const longRunningMediaDispatcher = new UndiciAgent({
  headersTimeout: 1800000,
  bodyTimeout: 1800000
});

function createHostTelemetry({ sampleIntervalMs = 2000 } = {}) {
  let cached = null;
  let sampledAt = 0;
  let pending = null;
  let previousCpu = null;

  function cpuTimes() {
    return os.cpus().reduce(
      (totals, cpu) => {
        const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
        return { idle: totals.idle + cpu.times.idle, total: totals.total + total };
      },
      { idle: 0, total: 0 }
    );
  }

  async function collect() {
    const currentCpu = cpuTimes();
    const cpuDelta = previousCpu
      ? { idle: currentCpu.idle - previousCpu.idle, total: currentCpu.total - previousCpu.total }
      : null;
    previousCpu = currentCpu;
    let gpu = null;
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        [
          '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,pstate,clocks.current.sm,clocks.current.memory',
          '--format=csv,noheader,nounits'
        ],
        { timeout: 1500 }
      );
      const metric = (value) => {
        const number = Number(String(value ?? '').trim());
        return Number.isFinite(number) ? number : null;
      };
      const devices = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line, fallbackIndex) => {
          const [
            index,
            name,
            utilization,
            memoryUsed,
            memoryTotal,
            temperature,
            powerDraw,
            performanceState,
            smClock,
            memoryClock
          ] = line.split(',').map((value) => value.trim());
          return {
            index: metric(index) ?? fallbackIndex,
            name,
            utilization: metric(utilization),
            memoryUsedMb: metric(memoryUsed),
            memoryTotalMb: metric(memoryTotal),
            temperatureC: metric(temperature),
            powerDrawW: metric(powerDraw),
            performanceState: performanceState || null,
            smClockMhz: metric(smClock),
            memoryClockMhz: metric(memoryClock)
          };
        });
      if (devices.length) {
        const values = (key) => devices.map((device) => device[key]).filter(Number.isFinite);
        const sum = (items) => (items.length ? items.reduce((total, value) => total + value, 0) : null);
        const average = (items) => (items.length ? sum(items) / items.length : null);
        gpu = {
          vendor: 'nvidia',
          backend: 'nvidia-smi',
          devices,
          utilization: average(values('utilization')),
          memoryUsedMb: sum(values('memoryUsedMb')),
          memoryTotalMb: sum(values('memoryTotalMb')),
          temperatureC: values('temperatureC').length ? Math.max(...values('temperatureC')) : null,
          powerDrawW: sum(values('powerDrawW'))
        };
      }
    } catch {
      // NVIDIA telemetry is optional on non-CUDA hosts.
    }
    const availableMemory = await readHostMemory();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = Math.max(0, totalMemory - freeMemory);
    return {
      sampledAt: new Date().toISOString(),
      cpu: {
        utilization: cpuDelta?.total > 0 ? (1 - cpuDelta.idle / cpuDelta.total) * 100 : null,
        logicalCpus: os.cpus().length,
        model: os.cpus()[0]?.model ?? null
      },
      memory: {
        usedBytes: usedMemory,
        freeBytes: freeMemory,
        availableBytes: availableMemory.availableBytes,
        totalBytes: totalMemory,
        utilization: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
        pressureUtilization: availableMemory.utilization,
        source: availableMemory.source
      },
      gpu
    };
  }

  return {
    async snapshot() {
      if (cached && Date.now() - sampledAt < sampleIntervalMs) return cached;
      if (!pending)
        pending = collect()
          .then((value) => {
            cached = value;
            sampledAt = Date.now();
            return value;
          })
          .finally(() => {
            pending = null;
          });
      return pending;
    }
  };
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function setCors(res, config = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const headers = corsHeaders(config);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function canWriteHead(res) {
  return Boolean(res) && !res.headersSent && !res.writableEnded && !res.destroyed;
}

function canWriteBody(res) {
  return Boolean(res) && !res.writableEnded && !res.destroyed;
}

function sendJson(res, status, value, headers = {}, config = {}) {
  if (!canWriteHead(res)) {
    // Stream already opened (or client gone). Best-effort close without throwing.
    if (canWriteBody(res)) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    return false;
  }
  setCors(res, config);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    ...headers
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
  return true;
}

function sendHtml(res, status, html, headers = {}, config = {}) {
  if (!canWriteHead(res)) {
    if (canWriteBody(res)) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    return false;
  }
  setCors(res, config);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    ...headers
  });
  res.end(html);
  return true;
}

function writeSse(res, event, data, { signal } = {}) {
  throwIfClientClosed(signal, res);
  if (!canWriteBody(res)) throw new ClientClosedError();
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** End an in-flight SSE/JSON response without throwing if headers already went out. */
function endResponseWithError(res, error, { stream = false, config = {}, status = 500 } = {}) {
  const message = error?.message ?? String(error);
  const code = error?.code ?? 'server_error';
  const type = error?.type ?? (status === 400 ? 'invalid_request_error' : 'server_error');
  if (!canWriteBody(res)) return false;
  try {
    if (!res.headersSent) {
      const headers = error?.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {};
      return sendJson(res, status, errorBody(message, { type, code, model: error?.model }), headers, config);
    }
    if (stream) {
      // OpenAI-style stream error chunk, then DONE.
      res.write(
        `data: ${JSON.stringify({
          error: { message, type, code }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
    }
    res.end();
    return true;
  } catch {
    try {
      res.destroy(error instanceof Error ? error : undefined);
    } catch {
      // ignore
    }
    return false;
  }
}

const DEFAULT_IMAGE_TOKEN_ESTIMATE = 4096;
const LOW_DETAIL_IMAGE_TOKEN_ESTIMATE = 1024;

function estimateImageTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const type = String(value.type ?? '').toLowerCase();
  const source = value.source && typeof value.source === 'object' ? value.source : null;
  const hasImagePayload =
    type === 'image' ||
    type === 'image_url' ||
    type === 'input_image' ||
    value.image_url != null ||
    (source && (source.type === 'base64' || String(source.media_type ?? '').startsWith('image/')));
  if (!hasImagePayload) return null;
  const detail = String(value.detail ?? value.image_url?.detail ?? '').toLowerCase();
  return detail === 'low' ? LOW_DETAIL_IMAGE_TOKEN_ESTIMATE : DEFAULT_IMAGE_TOKEN_ESTIMATE;
}

function estimateMessageTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') {
    // Base64 is opaque media, not prompt text. Counting every encoded byte as
    // language tokens rejects normal multimodal requests before the backend's
    // vision processor can turn pixels into its much smaller token sequence.
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return DEFAULT_IMAGE_TOKEN_ESTIMATE;
    return Math.ceil(value.length / 3.5);
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateMessageTokens(item), 0);
  if (typeof value === 'object') {
    const imageTokens = estimateImageTokens(value);
    if (imageTokens != null) return imageTokens;
    if (typeof value.text === 'string') return estimateMessageTokens(value.text);
    if (typeof value.content === 'string' || Array.isArray(value.content)) {
      return estimateMessageTokens(value.content);
    }
    if (typeof value.input === 'string' || Array.isArray(value.input)) {
      return estimateMessageTokens(value.input);
    }
    return Math.ceil(JSON.stringify(value).length / 3.5);
  }
  return Math.ceil(String(value).length / 3.5);
}

export function estimateRequestPromptTokens(body = {}) {
  const parts = [body.messages, body.input, body.instructions, body.system, body.prompt];
  return parts.reduce((sum, part) => sum + estimateMessageTokens(part), 0);
}

class PromptTooLargeError extends Error {
  constructor(message, { estimatedTokens, limit, modelId } = {}) {
    super(message);
    this.name = 'PromptTooLargeError';
    this.statusCode = 400;
    this.code = 'prompt_too_large';
    this.type = 'invalid_request_error';
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
    this.model = modelId;
  }
}

function assertPromptWithinBudget(resolved, body, { logger } = {}) {
  const model = resolved?.model ?? {};
  const hardLimit =
    numberOrNull(model.maxPromptTokens) ?? numberOrNull(model.safeContextWindow) ?? numberOrNull(model.contextWindow);
  if (!hardLimit || hardLimit <= 0) return null;
  const estimated = estimateRequestPromptTokens(body);
  // Soft warn at 80%; hard reject at 98% of configured budget (token estimate is approximate).
  if (estimated >= hardLimit * 0.8) {
    logger?.warn?.(
      `prompt size estimate ${estimated} tokens approaching limit ${hardLimit} for ${resolved.requestedId}`
    );
  }
  if (estimated > hardLimit * 0.98) {
    throw new PromptTooLargeError(
      `estimated prompt size ${estimated} tokens exceeds model budget ${hardLimit} for ${resolved.requestedId}. ` +
        `Reduce context or raise model.maxPromptTokens / contextWindow after ensuring backend memory headroom ` +
        `(Apple Silicon MTPLX: prefer --paged-kv-quantization q8 and max-active-requests 1).`,
      {
        estimatedTokens: estimated,
        limit: hardLimit,
        modelId: resolved.requestedId
      }
    );
  }
  return { estimated, limit: hardLimit };
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorBody(message, { type = 'invalid_request_error', code = 'error', model } = {}) {
  return {
    error: {
      message,
      type,
      code,
      model
    }
  };
}

class ClientClosedError extends Error {
  constructor(message = 'client closed before upstream response completed') {
    super(message);
    this.name = 'ClientClosedError';
    this.statusCode = 499;
    this.code = 'client_closed';
  }
}

class RuntimeStartingError extends Error {
  constructor(runtimeId, retryAfterSeconds = 15) {
    super(`runtime ${runtimeId} is starting; retry after ${retryAfterSeconds} seconds`);
    this.name = 'RuntimeStartingError';
    this.statusCode = 429;
    this.code = 'RUNTIME_STARTING';
    this.type = 'runtime_admission_error';
    this.retryAfterSeconds = retryAfterSeconds;
    this.runtimeId = runtimeId;
  }
}

class RuntimeUnavailableError extends Error {
  constructor(runtimeId, reason = 'not ready') {
    super(`runtime ${runtimeId} cannot currently serve requests: ${reason}`);
    this.name = 'RuntimeUnavailableError';
    this.statusCode = 503;
    this.code = 'RUNTIME_UNAVAILABLE';
    this.type = 'runtime_admission_error';
    this.runtimeId = runtimeId;
  }
}

function isClientClosedError(error) {
  return error instanceof ClientClosedError || error?.name === 'ClientClosedError' || error?.code === 'client_closed';
}

function clientClosedStatus(error) {
  return isClientClosedError(error) ? 499 : 0;
}

const MODEL_FAILOVER_STATUS_CODES = new Set([402, 408, 425, 429, 500, 502, 503, 504]);
const MODEL_FAILOVER_RUNTIME_STATES = new Set([
  'starting',
  'warming',
  'stopping',
  'draining',
  'queued',
  'failed',
  'unreachable',
  'unknown'
]);

function errorStatusCode(error) {
  const status = Number(error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 0;
}

export function shouldFailoverModelRequest(error, res = null) {
  if (res?.headersSent || res?.writableEnded || res?.destroyed) return false;
  if (isClientClosedError(error) || error instanceof PromptTooLargeError || error instanceof StructuredOutputError) {
    return false;
  }
  const status = errorStatusCode(error);
  if (status) return MODEL_FAILOVER_STATUS_CODES.has(status);
  if (error instanceof RuntimeAdmissionError) return true;
  const name = String(error?.name ?? '');
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  return (
    ['AbortError', 'TimeoutError', 'TypeError'].includes(name) ||
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code) ||
    /fetch failed|socket|connection|timed out|runtime .* (failed|exited|healthy|start)|did not become healthy/i.test(
      message
    )
  );
}

async function upstreamStatusError(upstream) {
  const text = await upstream.text();
  let message = text;
  try {
    message = JSON.parse(text)?.error?.message ?? text;
  } catch {
    // Keep the raw upstream response as the diagnostic message.
  }
  return Object.assign(new Error(message || `upstream status ${upstream.status}`), {
    code: 'upstream_error',
    statusCode: upstream.status
  });
}

function createClientCloseTracker(req, res) {
  const controller = new AbortController();
  let closed = false;
  const markClosed = () => {
    if (closed || res.writableEnded) return;
    closed = true;
    controller.abort(new ClientClosedError());
  };
  req.on('aborted', markClosed);
  res.on('close', markClosed);
  if (req.aborted || (res.destroyed && !res.writableEnded)) markClosed();
  return {
    signal: controller.signal,
    get closed() {
      return closed;
    },
    dispose() {
      req.off('aborted', markClosed);
      res.off('close', markClosed);
    }
  };
}

function upstreamSignal(parentSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function normalizeAbortError(error, signal, timeoutMs) {
  if (!signal?.aborted) return error;
  if (isClientClosedError(signal.reason)) return signal.reason;
  if (signal.reason?.name === 'TimeoutError') {
    return new Error(`upstream request timed out after ${timeoutMs}ms`);
  }
  return error;
}

function throwIfClientClosed(signal, res) {
  if (signal?.aborted && isClientClosedError(signal.reason)) throw signal.reason;
  if (res?.destroyed && !res.writableEnded) throw new ClientClosedError();
}

async function readBody(req, { limitBytes = 64 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(`request body exceeds ${limitBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBodyBuffer(req, { limitBytes = 512 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(`request body exceeds ${limitBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function upstreamUrl(backend, path) {
  const suffix = path.startsWith('/v1/') ? path.slice(3) : path;
  return `${stripTrailingSlash(backend.baseUrl)}${suffix}`;
}

function backendHeaders(backend, extra = {}) {
  const apiKey = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : backend.apiKey;
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra
  };
}

function copyResponseHeaders(upstream) {
  const headers = {};
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function contentType(req) {
  return String(req.headers['content-type'] ?? '');
}

function parseMultipartBoundary(type) {
  const match = String(type).match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2]?.trim() ?? null;
}

function multipartPartName(headers) {
  const match = String(headers).match(/content-disposition:[^\r\n]*\bname="([^"]+)"/i);
  return match?.[1] ?? null;
}

function bufferEndsWith(buffer, suffix) {
  return buffer.length >= suffix.length && buffer.subarray(buffer.length - suffix.length).equals(suffix);
}

function parseMultipartBody(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const trailingLineBreak = Buffer.from('\r\n');
  const parts = [];
  let cursor = buffer.indexOf(delimiter);

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    if (buffer.subarray(partStart, partStart + 2).toString('utf8') === '--') break;
    if (buffer.subarray(partStart, partStart + 2).equals(trailingLineBreak)) partStart += 2;
    const next = buffer.indexOf(delimiter, partStart);
    if (next === -1) break;
    let part = buffer.subarray(partStart, next);
    if (bufferEndsWith(part, trailingLineBreak)) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(separator);
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + separator.length);
      parts.push({
        headers,
        name: multipartPartName(headers),
        content
      });
    }
    cursor = next;
  }

  return parts;
}

function renderMultipartBody(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`, 'utf8'));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(String(part.content), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function multipartTextField(buffer, contentTypeValue, fieldName) {
  const boundary = parseMultipartBoundary(contentTypeValue);
  if (!boundary) return null;
  const part = parseMultipartBody(buffer, boundary).find((candidate) => candidate.name === fieldName);
  return part ? part.content.toString('utf8').trim() : null;
}

function multipartWithTextField(buffer, contentTypeValue, fieldName, value) {
  const boundary = parseMultipartBoundary(contentTypeValue);
  if (!boundary) throw new Error('multipart request is missing boundary');
  const parts = parseMultipartBody(buffer, boundary);
  if (!parts.length) throw new Error('multipart request contains no parseable parts');
  const existing = parts.find((part) => part.name === fieldName);
  if (existing) {
    existing.content = Buffer.from(String(value), 'utf8');
  } else {
    parts.unshift({
      headers: `Content-Disposition: form-data; name="${fieldName}"`,
      name: fieldName,
      content: Buffer.from(String(value), 'utf8')
    });
  }
  return renderMultipartBody(parts, boundary);
}

function firstQueryParam(searchParams, names) {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function listValues(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function queryValues(searchParams, names) {
  return [...new Set(names.flatMap((name) => searchParams.getAll(name)).flatMap(listValues))];
}

function queryBool(searchParams, names, defaultValue = false) {
  const value = firstQueryParam(searchParams, names);
  if (value == null) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function optionalNumber(value, name) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
  return number;
}

function sseHeaders(extra = {}) {
  return {
    'content-type': SSE_TYPE,
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...extra
  };
}

function createResponseTiming(startedAt) {
  let firstContentMs = null;
  let lastContentMs = null;
  return {
    markFirstContent() {
      const elapsed = Date.now() - startedAt;
      if (firstContentMs == null) firstContentMs = elapsed;
      lastContentMs = elapsed;
      return firstContentMs;
    },
    get firstContentMs() {
      return firstContentMs;
    },
    get lastContentMs() {
      return lastContentMs;
    }
  };
}

function markFirstContent(timing) {
  return timing?.markFirstContent?.();
}

function metricOutputTokens(entry) {
  const reported = Number(entry.usage?.output_tokens);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const observedChars = Number(entry.outputChars ?? 0);
  if (observedChars > 0) return Math.max(0, Math.round(observedChars / 4));
  if (entry.kind === 'embedding') return Math.max(0, Math.round(Number(entry.responseBytes ?? 0) / 4));
  return 0;
}

function safeCallerPart(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/[^a-z0-9._+-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || null;
}

function requestCallerLabel(req) {
  const explicit = safeCallerPart(req.headers['x-lloom-client'] ?? req.headers['x-client-name']);
  if (explicit) return explicit;
  const userAgent = String(req.headers['user-agent'] ?? '').toLowerCase();
  const families = [
    ['codex', 'codex'],
    ['oh-my-pi', 'omp'],
    ['open-code', 'opencode'],
    ['opencode', 'opencode'],
    ['claude', 'claude'],
    ['curl/', 'curl'],
    ['undici', 'node'],
    ['python', 'python'],
    ['node', 'node'],
    ['go-http-client', 'go']
  ];
  const family = families.find(([needle]) => userAgent.includes(needle))?.[1];
  return family ?? safeCallerPart(req.headers['x-stainless-lang']);
}

function requestEnntityAttribution(req) {
  return {
    entity: safeAttributionPart(req.headers['x-enntity-entity']),
    purpose: safeAttributionPart(req.headers['x-enntity-purpose'])
  };
}

function safeAttributionPart(value) {
  const text = String(Array.isArray(value) ? value[0] : (value ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 128);
  return text || null;
}

function runtimeRequesterNode(req, config) {
  const header = req.headers['x-lloom-requester-node'];
  const requester = Array.isArray(header) ? header[0] : header;
  return String(requester ?? '').trim() || currentNodeId(config);
}

function restoreMetricBucket(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(target)) {
    if (key === 'id') continue;
    if (key === 'recentDecodeRates') {
      target[key] = Array.isArray(source[key]) ? source[key].slice(-10).map(Number).filter(Number.isFinite) : [];
      continue;
    }
    if (key === 'last') {
      target[key] = source[key] && typeof source[key] === 'object' ? source[key] : null;
      continue;
    }
    if (source[key] != null && Number.isFinite(Number(source[key]))) target[key] = Number(source[key]);
  }
  return target;
}

function restoreMetricMap(entries) {
  return new Map(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.id)
      .map((entry) => [entry.id, restoreMetricBucket(emptyMetricBucket(entry.id), entry)])
  );
}

function createMetricGroup(id = 'all') {
  return { totals: emptyMetricBucket(id), models: new Map(), routes: new Map() };
}

function restoreMetricGroup(source, id = 'all') {
  return {
    totals: restoreMetricBucket(emptyMetricBucket(id), source?.totals),
    models: restoreMetricMap(source?.models),
    routes: restoreMetricMap(source?.routes)
  };
}

function mergeMetricBucket(target, source) {
  if (!source) return target;
  for (const key of [
    'requests',
    'errors',
    'streams',
    'durationMs',
    'responseBytes',
    'firstContentCount',
    'firstContentMs',
    'generationDurationMs',
    'decodeTokens',
    'decodeSamples',
    'estimatedDecodeSamples',
    'inputTokens',
    'outputTokens',
    'totalTokens'
  ]) {
    target[key] += Number(source[key] || 0);
  }
  if (source.minFirstContentMs != null) {
    target.minFirstContentMs =
      target.minFirstContentMs == null
        ? Number(source.minFirstContentMs)
        : Math.min(target.minFirstContentMs, Number(source.minFirstContentMs));
  }
  if (source.maxFirstContentMs != null) {
    target.maxFirstContentMs = Math.max(target.maxFirstContentMs ?? 0, Number(source.maxFirstContentMs));
  }
  target.recentDecodeRates = target.recentDecodeRates.concat(source.recentDecodeRates || []).slice(-10);
  if (source.last && (!target.last || String(source.last.at || '') >= String(target.last.at || '')))
    target.last = source.last;
  return target;
}

function mergeMetricMaps(target, source) {
  for (const [id, bucket] of source.entries()) {
    if (!target.has(id)) target.set(id, emptyMetricBucket(id));
    mergeMetricBucket(target.get(id), bucket);
  }
}

function serializeMetricGroup(group) {
  return {
    totals: finalizeMetricBucket(group.totals),
    models: [...group.models.values()].map(finalizeMetricBucket).sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...group.routes.values()].map(finalizeMetricBucket).sort((a, b) => a.id.localeCompare(b.id))
  };
}

export function createMetricsStore({ maxRecent = 200, initialSnapshot = null } = {}) {
  const recent = [];
  const active = new Map();
  let nextConnectionId = 1;
  const totals = restoreMetricBucket(emptyMetricBucket('all'), initialSnapshot?.totals);
  const models = restoreMetricMap(initialSnapshot?.models);
  const routes = restoreMetricMap(initialSnapshot?.routes);
  const days = new Map(
    (Array.isArray(initialSnapshot?.history?.days) ? initialSnapshot.history.days : [])
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry?.date || ''))
      .map((entry) => [entry.date, restoreMetricGroup(entry, entry.date)])
  );

  function bucketFor(map, key) {
    if (!map.has(key)) map.set(key, emptyMetricBucket(key));
    return map.get(key);
  }

  function apply(bucket, entry) {
    bucket.requests += 1;
    if (!entry.ok) bucket.errors += 1;
    if (entry.stream) bucket.streams += 1;
    bucket.durationMs += entry.durationMs;
    bucket.responseBytes += entry.responseBytes ?? 0;
    if (entry.firstContentMs != null) {
      bucket.firstContentCount += 1;
      bucket.firstContentMs += entry.firstContentMs;
      bucket.minFirstContentMs =
        bucket.minFirstContentMs == null
          ? entry.firstContentMs
          : Math.min(bucket.minFirstContentMs, entry.firstContentMs);
      bucket.maxFirstContentMs =
        bucket.maxFirstContentMs == null
          ? entry.firstContentMs
          : Math.max(bucket.maxFirstContentMs, entry.firstContentMs);
      const outputTokens = metricOutputTokens(entry);
      if (entry.stream && outputTokens > 1 && entry.lastContentMs != null) {
        const decodeDurationMs = Math.max(1, entry.lastContentMs - entry.firstContentMs);
        const decodeRate = (outputTokens - 1) / (decodeDurationMs / 1000);
        bucket.decodeTokens += outputTokens - 1;
        bucket.generationDurationMs += decodeDurationMs;
        bucket.decodeSamples += 1;
        bucket.recentDecodeRates.push(decodeRate);
        if (bucket.recentDecodeRates.length > 10) bucket.recentDecodeRates.shift();
        if (entry.usage?.output_tokens == null) bucket.estimatedDecodeSamples += 1;
      }
    }
    bucket.inputTokens += entry.usage?.input_tokens ?? 0;
    const outputTokens = metricOutputTokens(entry);
    bucket.outputTokens += outputTokens;
    bucket.totalTokens += entry.usage?.total_tokens ?? (entry.usage?.input_tokens ?? 0) + outputTokens;
    bucket.last = {
      at: entry.at,
      status: entry.status,
      ok: entry.ok,
      durationMs: entry.durationMs,
      firstContentMs: entry.firstContentMs,
      error: entry.error
    };
  }

  return {
    begin(raw) {
      const id = `conn_${nextConnectionId++}`;
      active.set(id, {
        id,
        startedAt: new Date().toISOString(),
        route: raw.route,
        model: raw.model,
        requestedModel: raw.requestedModel,
        upstreamModel: raw.upstreamModel,
        kind: raw.kind,
        backend: raw.backend,
        runtime: raw.runtime,
        resolvedModel: raw.resolvedModel ?? raw.model,
        failoverAttempt: raw.failoverAttempt ?? null,
        failoverTargets: raw.failoverTargets ?? null,
        failoverReason: raw.failoverReason ?? null,
        failedOver: raw.failedOver === true,
        target: raw.target ?? null,
        node: raw.node ?? null,
        caller: raw.caller ?? null,
        entity: raw.entity ?? null,
        purpose: raw.purpose ?? null,
        requestBytes: raw.requestBytes ?? 0,
        stream: raw.stream === true
      });
      return id;
    },
    end(id) {
      if (id) active.delete(id);
    },
    update(id, patch = {}) {
      const entry = active.get(id);
      if (!entry) return;
      entry.responseBytes = (entry.responseBytes ?? 0) + (patch.responseBytesDelta ?? 0);
      entry.outputChars = (entry.outputChars ?? 0) + (patch.outputCharsDelta ?? 0);
      entry.lastActivityAt = new Date().toISOString();
    },
    record(raw) {
      const live = active.get(raw.id);
      const entry = {
        id: raw.id,
        at: new Date().toISOString(),
        route: raw.route,
        model: raw.model,
        requestedModel: raw.requestedModel,
        upstreamModel: raw.upstreamModel,
        kind: raw.kind,
        backend: raw.backend,
        runtime: raw.runtime,
        resolvedModel: raw.resolvedModel ?? raw.model,
        failoverAttempt: raw.failoverAttempt ?? live?.failoverAttempt ?? null,
        failoverTargets: raw.failoverTargets ?? live?.failoverTargets ?? null,
        failoverReason: raw.failoverReason ?? live?.failoverReason ?? null,
        failedOver: raw.failedOver === true || live?.failedOver === true,
        target: raw.target ?? live?.target ?? null,
        node: raw.node ?? live?.node ?? null,
        caller: raw.caller ?? live?.caller ?? null,
        entity: raw.entity ?? live?.entity ?? null,
        purpose: raw.purpose ?? live?.purpose ?? null,
        status: raw.status ?? 0,
        ok: raw.ok === true,
        stream: raw.stream === true,
        durationMs: raw.durationMs ?? 0,
        firstContentMs: raw.firstContentMs ?? null,
        lastContentMs: raw.lastContentMs ?? null,
        responseBytes: raw.responseBytes ?? 0,
        requestBytes: raw.requestBytes ?? 0,
        outputChars: live?.outputChars ?? 0,
        usage: raw.usage ?? null,
        error: raw.error
      };
      recent.push(entry);
      if (recent.length > maxRecent) recent.shift();
      apply(totals, entry);
      if (entry.model) apply(bucketFor(models, entry.model), entry);
      if (entry.route) apply(bucketFor(routes, entry.route), entry);
      const dayId = entry.at.slice(0, 10);
      if (!days.has(dayId)) days.set(dayId, createMetricGroup(dayId));
      const day = days.get(dayId);
      apply(day.totals, entry);
      if (entry.model) apply(bucketFor(day.models, entry.model), entry);
      if (entry.route) apply(bucketFor(day.routes, entry.route), entry);
      while (days.size > 400) days.delete([...days.keys()].sort()[0]);
    },
    snapshot({ model, period = 'all' } = {}) {
      const normalizedPeriod = ['today', '7d', '30d', 'all'].includes(period) ? period : 'all';
      let selectedGroup = { totals, models, routes };
      if (normalizedPeriod !== 'all') {
        const dayCount = normalizedPeriod === 'today' ? 1 : Number.parseInt(normalizedPeriod, 10);
        const cutoff = new Date();
        cutoff.setUTCHours(0, 0, 0, 0);
        cutoff.setUTCDate(cutoff.getUTCDate() - dayCount + 1);
        selectedGroup = createMetricGroup(normalizedPeriod);
        for (const [date, day] of days) {
          if (Date.parse(`${date}T00:00:00Z`) < cutoff.getTime()) continue;
          mergeMetricBucket(selectedGroup.totals, day.totals);
          mergeMetricMaps(selectedGroup.models, day.models);
          mergeMetricMaps(selectedGroup.routes, day.routes);
        }
      }
      const selectedModel = model ? (selectedGroup.models.get(model) ?? null) : null;
      const now = Date.now();
      const rolling = rollingMetricWindows(recent, now, model);
      return {
        object: 'gateway.metrics',
        generatedAt: new Date().toISOString(),
        period: normalizedPeriod,
        totals: finalizeMetricBucket(selectedGroup.totals),
        models: model
          ? selectedModel
            ? [finalizeMetricBucket(selectedModel)]
            : []
          : [...selectedGroup.models.values()].map(finalizeMetricBucket).sort((a, b) => a.id.localeCompare(b.id)),
        routes: [...selectedGroup.routes.values()].map(finalizeMetricBucket).sort((a, b) => a.id.localeCompare(b.id)),
        active: [...active.values()].map((entry) => ({
          ...entry,
          elapsedMs: Math.max(0, Date.now() - Date.parse(entry.startedAt))
        })),
        rolling,
        recent: recent.filter((entry) => !model || entry.model === model).slice(-50)
      };
    },
    persistenceSnapshot() {
      return {
        ...serializeMetricGroup({ totals, models, routes }),
        history: {
          days: [...days.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, group]) => ({
              date,
              ...serializeMetricGroup(group)
            }))
        }
      };
    }
  };
}

function defaultMetricsHistoryPath() {
  const home = process.env.HOME ? `${process.env.HOME}/.lloom` : './.lloom';
  return `${home}/metrics-history.json`;
}

export function createMetricsPersistence(config, { logger = console } = {}) {
  const enabled = config.logging?.metricsPersistence !== false && process.env.LLOOM_METRICS_PERSISTENCE !== '0';
  const filePath = config.logging?.metricsPath || process.env.LLOOM_METRICS_PATH || defaultMetricsHistoryPath();
  let latestSnapshot = null;
  let flushTimer = null;
  let createdAt = new Date().toISOString();

  function loadSnapshot() {
    if (!enabled || !existsSync(filePath)) return null;
    try {
      const document = JSON.parse(readFileSync(filePath, 'utf8'));
      if (document.version !== 1 || !document.metrics?.totals) throw new Error('unsupported metrics history format');
      createdAt = document.createdAt || createdAt;
      return document.metrics;
    } catch (error) {
      logger.error?.(`could not load LLooM metrics history ${filePath}: ${error?.message ?? error}`);
      return null;
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!enabled || !latestSnapshot) return;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(
          {
            version: 1,
            createdAt,
            updatedAt: new Date().toISOString(),
            metrics: {
              totals: latestSnapshot.totals,
              models: latestSnapshot.models,
              routes: latestSnapshot.routes,
              history: latestSnapshot.history
            }
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
      renameSync(temporaryPath, filePath);
    } catch (error) {
      logger.error?.(`could not persist LLooM metrics history ${filePath}: ${error?.message ?? error}`);
    }
  }

  function schedule(snapshot) {
    if (!enabled) return;
    latestSnapshot = snapshot;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 1000);
    flushTimer.unref?.();
  }

  return {
    enabled,
    filePath,
    loadSnapshot,
    schedule,
    flush,
    metadata() {
      return { enabled, scope: enabled ? 'all-time' : 'process', since: createdAt };
    }
  };
}

function rollingMetricWindow(entries, now, windowMs, model) {
  const cutoff = now - windowMs;
  const selected = entries.filter((entry) => (!model || entry.model === model) && Date.parse(entry.at) >= cutoff);
  const outputTokens = selected.reduce((sum, entry) => sum + metricOutputTokens(entry), 0);
  const decodeTokens = selected.reduce((sum, entry) => {
    const tokens = metricOutputTokens(entry);
    return sum + (entry.stream && entry.lastContentMs != null && tokens > 1 ? tokens - 1 : 0);
  }, 0);
  const generationDurationMs = selected.reduce((sum, entry) => {
    const tokens = metricOutputTokens(entry);
    if (!entry.stream || tokens <= 1 || entry.firstContentMs == null || entry.lastContentMs == null) return sum;
    return sum + Math.max(1, entry.lastContentMs - entry.firstContentMs);
  }, 0);
  return {
    windowMs,
    requests: selected.length,
    outputTokens,
    decodeTokens,
    outputTokensPerSecond:
      generationDurationMs > 0 ? Number((decodeTokens / (generationDurationMs / 1000)).toFixed(2)) : 0
  };
}

function rollingMetricWindows(entries, now, model) {
  return {
    short: rollingMetricWindow(entries, now, 10_000, model),
    minute: rollingMetricWindow(entries, now, 60_000, model)
  };
}

function emptyMetricBucket(id) {
  return {
    id,
    requests: 0,
    errors: 0,
    streams: 0,
    durationMs: 0,
    responseBytes: 0,
    firstContentCount: 0,
    firstContentMs: 0,
    minFirstContentMs: null,
    maxFirstContentMs: null,
    generationDurationMs: 0,
    decodeTokens: 0,
    decodeSamples: 0,
    estimatedDecodeSamples: 0,
    recentDecodeRates: [],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    last: null
  };
}

function finalizeMetricBucket(bucket) {
  const durationSeconds = bucket.durationMs / 1000;
  const recentDecodeRate = bucket.recentDecodeRates.length
    ? bucket.recentDecodeRates.reduce((sum, rate) => sum + rate, 0) / bucket.recentDecodeRates.length
    : null;
  return {
    ...bucket,
    avgDurationMs: bucket.requests ? Number((bucket.durationMs / bucket.requests).toFixed(2)) : 0,
    avgFirstContentMs: bucket.firstContentCount
      ? Number((bucket.firstContentMs / bucket.firstContentCount).toFixed(2))
      : null,
    outputTokensPerSecond: durationSeconds > 0 ? Number((bucket.outputTokens / durationSeconds).toFixed(2)) : 0,
    decodeTokensPerSecond: recentDecodeRate == null ? null : Number(recentDecodeRate.toFixed(2))
  };
}

async function fetchUpstream({ backend, path, body, headers = {}, signal, dispatcher }) {
  const timeoutMs = backend.timeoutMs ?? 1800000;
  const fetchSignal = upstreamSignal(signal, timeoutMs);
  try {
    return await fetch(upstreamUrl(backend, path), {
      method: 'POST',
      headers: backendHeaders(backend, headers),
      body: JSON.stringify(body),
      signal: fetchSignal,
      dispatcher
    });
  } catch (error) {
    throw normalizeAbortError(error, fetchSignal, timeoutMs);
  }
}

async function fetchRawUpstream({ backend, path, body, headers = {}, signal, dispatcher }) {
  const timeoutMs = backend.timeoutMs ?? 1800000;
  const fetchSignal = upstreamSignal(signal, timeoutMs);
  try {
    return await fetch(upstreamUrl(backend, path), {
      method: 'POST',
      headers: backendHeaders(backend, headers),
      body,
      signal: fetchSignal,
      dispatcher
    });
  } catch (error) {
    throw normalizeAbortError(error, fetchSignal, timeoutMs);
  }
}

// eslint-disable-next-line no-unused-vars
async function proxyUpstreamStream(res, upstream, { signal, timing, corsConfig } = {}) {
  throwIfClientClosed(signal, res);
  setCors(res, corsConfig);
  res.writeHead(upstream.status, copyResponseHeaders(upstream));
  if (!upstream.body) {
    throwIfClientClosed(signal, res);
    res.end();
    return {
      status: upstream.status,
      stream: true,
      responseBytes: 0,
      usage: null
    };
  }
  const decoder = new TextDecoder();
  let pending = '';
  let responseBytes = 0;
  let usage = null;

  function scan(buffer, final = false) {
    let cursor = 0;
    let splitAt;
    while ((splitAt = buffer.slice(cursor).search(/\r?\n\r?\n/)) !== -1) {
      const absolute = cursor + splitAt;
      const block = buffer.slice(cursor, absolute);
      const match = buffer.slice(absolute).match(/^\r?\n\r?\n/);
      cursor = absolute + (match?.[0].length ?? 2);
      const event = parseSseBlock(block);
      if (event.data && event.data !== '[DONE]') {
        try {
          usage = metricUsageFromOpenAI(JSON.parse(event.data).usage) ?? usage;
        } catch {
          // Ignore non-JSON SSE payloads in pass-through streams.
        }
      }
    }
    const rest = buffer.slice(cursor);
    if (final && rest.trim()) {
      const event = parseSseBlock(rest);
      if (event.data && event.data !== '[DONE]') {
        try {
          usage = metricUsageFromOpenAI(JSON.parse(event.data).usage) ?? usage;
        } catch {
          // Ignore non-JSON SSE payloads in pass-through streams.
        }
      }
      return '';
    }
    return rest;
  }

  for await (const chunk of upstream.body) {
    throwIfClientClosed(signal, res);
    const buffer = Buffer.from(chunk);
    if (buffer.length) markFirstContent(timing);
    responseBytes += buffer.length;
    pending = scan(pending + decoder.decode(buffer, { stream: true }));
    res.write(buffer);
  }
  throwIfClientClosed(signal, res);
  scan(pending + decoder.decode(), true);
  res.end();
  return {
    status: upstream.status,
    stream: true,
    responseBytes,
    usage
  };
}

async function proxyRawResponse(res, upstream, { signal, timing, corsConfig } = {}) {
  const body = Buffer.from(await upstream.arrayBuffer());
  throwIfClientClosed(signal, res);
  const headers = copyResponseHeaders(upstream);
  setCors(res, corsConfig);
  res.writeHead(upstream.status, headers);
  if (body.length) markFirstContent(timing);
  res.end(body);
  return {
    status: upstream.status,
    stream: false,
    responseBytes: body.length,
    usage: usageFromJsonBuffer(body, headers)
  };
}

async function proxyOpenAIChatResponse(
  res,
  upstream,
  requestedModel,
  { signal, timing, progress, corsConfig, structuredOutput = null } = {}
) {
  const body = Buffer.from(await upstream.arrayBuffer());
  throwIfClientClosed(signal, res);
  const headers = copyResponseHeaders(upstream);
  let output = body;
  let usage = usageFromJsonBuffer(body, headers);
  if (upstream.ok && String(headers['content-type'] ?? '').includes('json')) {
    const rewritten = rewriteJsonModelText(body.toString('utf8'), requestedModel);
    let value = rewritten.value;
    if (value && typeof value === 'object') {
      value = normalizeOpenAIChatCompletionBody(value);
      value = normalizeStructuredOutputChatCompletion(value, structuredOutput);
    }
    if (value && typeof value === 'object') {
      const text = `${JSON.stringify(value)}\n`;
      output = Buffer.from(text);
      usage = metricUsageFromOpenAI(value.usage) ?? usage;
    } else if (rewritten.rewritten) {
      const text = `${rewritten.text}\n`;
      output = Buffer.from(text);
      usage = metricUsageFromOpenAI(rewritten.value?.usage) ?? usage;
    }
  }
  setCors(res, corsConfig);
  res.writeHead(upstream.status, headers);
  if (output.length) markFirstContent(timing);
  progress?.({
    responseBytesDelta: output.length,
    outputCharsDelta: usage?.output_tokens ? usage.output_tokens * 4 : 0
  });
  res.end(output);
  return {
    status: upstream.status,
    stream: false,
    responseBytes: output.length,
    usage
  };
}

async function proxyOpenAIChatStream(res, upstream, requestedModel, { signal, timing, progress, corsConfig } = {}) {
  throwIfClientClosed(signal, res);
  setCors(res, corsConfig);
  res.writeHead(upstream.status, copyResponseHeaders(upstream));
  if (!upstream.body) {
    throwIfClientClosed(signal, res);
    res.end();
    return {
      status: upstream.status,
      stream: true,
      responseBytes: 0,
      usage: null
    };
  }

  let responseBytes = 0;
  let usage = null;
  for await (const event of readSseEvents(upstream.body)) {
    throwIfClientClosed(signal, res);
    // eslint-disable-next-line no-useless-assignment
    let output = '';
    let outputChars = 0;
    if (event.data && event.data !== '[DONE]') {
      const rewritten = rewriteJsonModelText(event.data, requestedModel);
      let value = rewritten.value;
      if (value && typeof value === 'object') {
        value = normalizeOpenAIChatCompletionChunk(value);
      }
      if (value?.usage) {
        usage = metricUsageFromOpenAI(value.usage) ?? usage;
      }
      if (openAIStreamChunkHasContent(value)) {
        markFirstContent(timing);
      }
      outputChars = (value?.choices ?? []).reduce((sum, choice) => {
        const delta = choice?.delta ?? {};
        return sum + String(delta.content ?? '').length + String(delta.reasoning_content ?? '').length;
      }, 0);
      const dataText = value && typeof value === 'object' ? JSON.stringify(value) : rewritten.text;
      output = encodeSseBlock({
        ...event,
        data: dataText
      });
    } else {
      output = encodeSseBlock(event);
    }
    responseBytes += Buffer.byteLength(output);
    progress?.({ responseBytesDelta: Buffer.byteLength(output), outputCharsDelta: outputChars ?? 0 });
    res.write(output);
  }
  throwIfClientClosed(signal, res);
  res.end();
  return {
    status: upstream.status,
    stream: true,
    responseBytes,
    usage
  };
}

async function createLibraryPlan(config, searchParams) {
  const catalog = await loadBackendCatalog();
  const selectedBenchmarksRoot =
    firstQueryParam(searchParams, ['benchmarks_root', 'benchmarks-root']) ?? defaultBenchmarksRoot;
  const benchmarkEvidence = await loadBenchmarkEvidence(selectedBenchmarksRoot);
  const benchmarkValidationErrors = validateBenchmarkEvidence(benchmarkEvidence);
  const selectedRecipesRoot = firstQueryParam(searchParams, ['recipes_root', 'recipes-root']);
  const report = await buildRecipeIndexReport(config, {
    indexPath: firstQueryParam(searchParams, ['index', 'index_path', 'index-path']),
    ...(selectedRecipesRoot ? { recipesRoot: selectedRecipesRoot } : {}),
    modelRoot: firstQueryParam(searchParams, ['model_root', 'model-root']) ?? '${LLOOM_MODEL_ROOT}',
    backendIds: backendIds(catalog),
    benchmarksRoot: selectedBenchmarksRoot,
    benchmarkEvidence,
    benchmarkValidationErrors
  });
  const profile = await profileMachine();
  const recipes = await loadRecipes(selectedRecipesRoot);
  const candidates = await rankRecipes(recipes, profile, { checkCommands: true });
  return {
    ...report,
    profile,
    selected: candidates.find((candidate) => candidate.selectable) ?? null,
    candidates
  };
}

function setupPlanOptionsFromQuery(searchParams) {
  return {
    recipeId: firstQueryParam(searchParams, ['recipe', 'recipe_id', 'recipe-id']),
    configPath: firstQueryParam(searchParams, ['config_out', 'config-out', 'config_path', 'config-path']),
    modelRoot: firstQueryParam(searchParams, ['model_root', 'model-root']),
    gatewayPort: firstQueryParam(searchParams, ['port', 'gateway_port', 'gateway-port']),
    backendPortRange: firstQueryParam(searchParams, ['backend_port_range', 'backend-port-range']),
    backendCatalogPath: firstQueryParam(searchParams, [
      'backend_catalog',
      'backend-catalog',
      'backend_catalog_path',
      'backend-catalog-path'
    ]),
    clientId: firstQueryParam(searchParams, ['client', 'client_id', 'client-id']) ?? 'all',
    home: firstQueryParam(searchParams, ['home']),
    generatedRoot: firstQueryParam(searchParams, ['generated_root', 'generated-root']),
    recipesRoot: firstQueryParam(searchParams, ['recipes_root', 'recipes-root']),
    benchmarksRoot: firstQueryParam(searchParams, ['benchmarks_root', 'benchmarks-root'])
  };
}

function onboardingOptionsFromQuery(config, searchParams) {
  const noRuntimes = queryBool(searchParams, ['no_runtimes', 'no-runtimes'], false);
  const runtimes = firstQueryParam(searchParams, ['runtimes']);
  return {
    ...setupPlanOptionsFromQuery(searchParams),
    ...communityOptionsFromQuery(config, searchParams),
    statePath: firstQueryParam(searchParams, ['state', 'state_path', 'state-path']),
    offline: queryBool(searchParams, ['offline'], false),
    includeRuntimes: runtimes == null ? !noRuntimes : !['0', 'false', 'no', 'off'].includes(runtimes.toLowerCase()),
    start: queryBool(searchParams, ['start'], false)
  };
}

function doctorOptionsFromQuery(searchParams) {
  const noRuntimes = queryBool(searchParams, ['no_runtimes', 'no-runtimes'], false);
  const runtimes = firstQueryParam(searchParams, ['runtimes']);
  return {
    recipeId: firstQueryParam(searchParams, ['recipe', 'recipe_id', 'recipe-id']),
    modelRoot: firstQueryParam(searchParams, ['model_root', 'model-root']),
    clientId: firstQueryParam(searchParams, ['client', 'client_id', 'client-id']) ?? 'all',
    statePath: firstQueryParam(searchParams, ['state', 'state_path', 'state-path']),
    generatedRoot: firstQueryParam(searchParams, ['generated_root', 'generated-root']),
    home: firstQueryParam(searchParams, ['home']),
    recipesRoot: firstQueryParam(searchParams, ['recipes_root', 'recipes-root']),
    benchmarksRoot: firstQueryParam(searchParams, ['benchmarks_root', 'benchmarks-root']),
    backendCatalogPath: firstQueryParam(searchParams, [
      'backend_catalog',
      'backend-catalog',
      'backend_catalog_path',
      'backend-catalog-path'
    ]),
    includeRuntimes: runtimes == null ? !noRuntimes : !['0', 'false', 'no', 'off'].includes(runtimes.toLowerCase())
  };
}

function setupOptionsFromBody(config, body = {}) {
  return {
    recipeId: body.recipeId ?? body.recipe_id ?? body.recipe,
    ...communityOptionsFromBody(config, body),
    configPath: body.configPath ?? body.config_path ?? body.configOut ?? body.config_out,
    modelRoot: body.modelRoot ?? body.model_root,
    gatewayPort: body.gatewayPort ?? body.gateway_port ?? body.port,
    backendPortRange: body.backendPortRange ?? body.backend_port_range,
    backendCatalogPath:
      body.backendCatalogPath ?? body.backend_catalog_path ?? body.backendCatalog ?? body.backend_catalog,
    clientId: body.clientId ?? body.client_id ?? body.client ?? 'all',
    home: body.home,
    generatedRoot: body.generatedRoot ?? body.generated_root,
    recipesRoot: body.recipesRoot ?? body.recipes_root,
    benchmarksRoot: body.benchmarksRoot ?? body.benchmarks_root,
    statePath: body.statePath ?? body.state_path,
    additive: body.additive === true,
    restoreCatalog: body.restoreCatalog === true || body.restore_catalog === true,
    start: body.start === true,
    offline: body.offline === true,
    includeRuntimes: body.includeRuntimes ?? body.include_runtimes
  };
}

function backendVariablesFromBody(body = {}) {
  return {
    ...defaultBackendVariables(process.env),
    ...(body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : {})
  };
}

function modelImportOptionsFromBody(config, body = {}) {
  const modelRef = body.modelRef ?? body.model_ref ?? body.model ?? body.ref;
  if (!modelRef) throw new Error('modelRef is required');
  return {
    modelRef,
    backend: body.backend,
    modelRoot: body.modelRoot ?? body.model_root ?? config.paths?.modelRoot,
    sessionCacheRoot: body.sessionCacheRoot ?? body.session_cache_root ?? config.paths?.sessionCacheRoot,
    configPath: body.configPath ?? body.config_path ?? config.sourcePath,
    modelId: body.modelId ?? body.model_id,
    name: body.name,
    port: optionalNumber(body.port, 'port'),
    contextWindow: optionalNumber(body.contextWindow ?? body.context_window, 'contextWindow'),
    maxOutputTokens: optionalNumber(body.maxOutputTokens ?? body.max_output_tokens, 'maxOutputTokens'),
    apiKeyEnv: body.apiKeyEnv ?? body.api_key_env,
    keepWarm: body.keepWarm ?? body.keep_warm ?? false,
    setDefault: body.setDefault ?? body.set_default ?? body.default ?? false
  };
}

function recipePackSourceFromBody(body = {}) {
  const source = body.source ?? body.url ?? body.path ?? body.pack;
  if (!source) throw new Error('recipe pack source is required');
  return source;
}

function recipePackOptionsFromBody(config, body = {}) {
  const trustedKeys = body.trustedKeys ?? body.trusted_keys ?? config.community?.trustedKeys ?? [];
  return {
    indexPath: body.indexPath ?? body.index_path,
    recipesRoot: body.recipesRoot ?? body.recipes_root,
    benchmarksRoot: body.benchmarksRoot ?? body.benchmarks_root,
    trustedKeys: Array.isArray(trustedKeys) ? trustedKeys : [trustedKeys].filter(Boolean),
    requireSignature: body.requireSignature ?? body.require_signature ?? config.community?.requireSignedPacks ?? false
  };
}

function communityOptionsFromQuery(config, searchParams) {
  const requireSignature = firstQueryParam(searchParams, ['require_signature', 'require-signature']);
  const trustHostKeys = firstQueryParam(searchParams, ['trust_host_keys', 'trust-host-keys']);
  return {
    hostUrl: firstQueryParam(searchParams, ['host_url', 'host-url', 'host']),
    recipeFeedPath: firstQueryParam(searchParams, ['recipe_feed_path', 'recipe-feed-path']),
    signingKeysPath: firstQueryParam(searchParams, ['signing_keys_path', 'signing-keys-path']),
    indexPath: firstQueryParam(searchParams, ['index', 'index_path', 'index-path']),
    recipesRoot: firstQueryParam(searchParams, ['recipes_root', 'recipes-root']),
    benchmarksRoot: firstQueryParam(searchParams, ['benchmarks_root', 'benchmarks-root']),
    backendCatalogPath: firstQueryParam(searchParams, [
      'backend_catalog',
      'backend-catalog',
      'backend_catalog_path',
      'backend-catalog-path'
    ]),
    workloads: queryValues(searchParams, ['workload', 'workloads', 'use_case', 'use-case']),
    capabilities: queryValues(searchParams, ['capability', 'capabilities']),
    tags: queryValues(searchParams, ['tag', 'tags']),
    trustedKeys: config.community?.trustedKeys ?? [],
    ...(requireSignature == null
      ? {}
      : { requireSignature: ['1', 'true', 'yes', 'on'].includes(requireSignature.toLowerCase()) }),
    ...(trustHostKeys == null
      ? {}
      : { trustHostKeys: ['1', 'true', 'yes', 'on'].includes(trustHostKeys.toLowerCase()) }),
    limit: optionalNumber(firstQueryParam(searchParams, ['limit']), 'limit')
  };
}

function communityOptionsFromBody(config, body = {}) {
  const trustedKeys = body.trustedKeys ?? body.trusted_keys ?? config.community?.trustedKeys ?? [];
  return {
    hostUrl: body.hostUrl ?? body.host_url ?? body.host,
    recipeFeedPath: body.recipeFeedPath ?? body.recipe_feed_path,
    signingKeysPath: body.signingKeysPath ?? body.signing_keys_path,
    indexPath: body.indexPath ?? body.index_path,
    recipesRoot: body.recipesRoot ?? body.recipes_root,
    benchmarksRoot: body.benchmarksRoot ?? body.benchmarks_root,
    backendCatalogPath:
      body.backendCatalogPath ?? body.backend_catalog_path ?? body.backendCatalog ?? body.backend_catalog,
    workloads: listValues(body.workloads ?? body.workload ?? body.useCase ?? body.use_case),
    capabilities: listValues(body.capabilities ?? body.capability),
    tags: listValues(body.tags ?? body.tag),
    trustedKeys: Array.isArray(trustedKeys) ? trustedKeys : [trustedKeys].filter(Boolean),
    trustHostKeys: body.trustHostKeys ?? body.trust_host_keys,
    requireSignature: body.requireSignature ?? body.require_signature,
    limit: optionalNumber(body.limit, 'limit')
  };
}

function communityCacheOptionsFromQuery(config, searchParams) {
  const home = firstQueryParam(searchParams, ['home']);
  const env = home ? { ...process.env, HOME: home } : process.env;
  const root = path.join(defaultLloomHome(env), 'community');
  const recipesRoot =
    firstQueryParam(searchParams, ['recipes_root', 'recipes-root']) ??
    config.init?.recipesRoot ??
    path.join(root, 'recipes');
  return {
    indexPath:
      firstQueryParam(searchParams, ['index', 'index_path', 'index-path']) ??
      config.init?.indexPath ??
      path.join(recipesRoot, 'index.json'),
    recipesRoot,
    benchmarksRoot:
      firstQueryParam(searchParams, ['benchmarks_root', 'benchmarks-root']) ??
      config.init?.benchmarksRoot ??
      path.join(root, 'benchmarks')
  };
}

async function communityStatusContextFromQuery(config, searchParams, { recipeId } = {}) {
  if (recipeId || queryBool(searchParams, ['offline'], false)) return {};
  const hostUrl = firstQueryParam(searchParams, ['host_url', 'host-url', 'host']) ?? config.community?.hostUrl;
  if (!hostUrl) return {};
  const cacheOptions = communityCacheOptionsFromQuery(config, searchParams);
  const plan = await createCommunityPlan(config, {
    ...communityOptionsFromQuery(config, searchParams),
    ...cacheOptions,
    hostUrl
  });
  if (!plan.ok) {
    throw new Error(
      `Community recommendation failed validation:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`
    );
  }
  const selectedRecipeId = selectedRecipeIdFromCommunityPlan(plan);
  return {
    communityPlan: plan,
    recipeId: selectedRecipeId,
    recipeDocuments: recipeDocumentsFromCommunityPlan(plan),
    benchmarkDocuments: benchmarkDocumentsFromCommunityPlan(plan),
    recipesRoot: cacheOptions.recipesRoot,
    benchmarksRoot: cacheOptions.benchmarksRoot,
    backendCatalogPath:
      firstQueryParam(searchParams, [
        'backend_catalog',
        'backend-catalog',
        'backend_catalog_path',
        'backend-catalog-path'
      ]) ?? plan.backendCatalogPath
  };
}

function communityStatusSummary(context) {
  if (!context?.communityPlan) return undefined;
  return {
    host: context.communityPlan.host,
    recommendationCount: context.communityPlan.recommendationCount,
    selectedCount: context.communityPlan.selectedCount,
    selectedRecipeId: context.recipeId
  };
}

function configReloadSupersededRuntimeAction(error) {
  return /superseded by config reload/i.test(error?.message ?? String(error));
}

export async function retryRuntimeActionAfterConfigReload(action, getReloadInFlight) {
  try {
    return await action();
  } catch (error) {
    if (!configReloadSupersededRuntimeAction(error)) throw error;
    await getReloadInFlight();
    return action();
  }
}

export function createLloomServer(config, { logger = console, runtimeManager = null, clusterCoordinator = null } = {}) {
  const hostTelemetry = createHostTelemetry();
  const machineProfile = profileMachine().catch((error) => {
    logger.error?.(`Machine profile collection failed: ${error?.message ?? error}`);
    return null;
  });
  clusterCoordinator ??= new ClusterCoordinator(config, {
    logger,
    telemetry: hostTelemetry,
    profile: () => machineProfile
  });
  runtimeManager ??= new RuntimeManager(config, { logger, clusterCoordinator });
  if (!runtimeManager.clusterCoordinator) {
    runtimeManager.clusterCoordinator = clusterCoordinator;
    clusterCoordinator.attachRuntimeManager(runtimeManager);
  }
  let registry = createRegistry(config);
  clusterCoordinator.attachModelCatalog(() =>
    registry.catalogModels({ includeAliases: false, advertisedOnly: true, requireRuntimeEnabled: false })
  );
  let reloadInFlight = Promise.resolve();
  let routingStatusCache = { at: 0, value: null, pending: null };
  const runtimeStartOperations = new Map();
  const configPath = config.sourcePath;

  function reloadConfig() {
    if (!configPath) return;
    reloadInFlight = reloadInFlight
      .catch(() => {})
      .then(async () => {
        const nextConfig = await loadConfig(configPath);
        // Model discovery is control-plane state and must not wait behind a
        // multi-hour model drain, image pull, or distributed cold start. Adopt
        // the validated on-disk catalog immediately while runtimeManager
        // reconciles physical processes against its previous snapshot.
        registry = createRegistry(nextConfig);
        const result = await runtimeManager.reconfigure(nextConfig);
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, nextConfig);
        clusterCoordinator.reconfigure(config);
        routingStatusCache = { at: 0, value: null, pending: null };
        logger.info?.(`reloaded LLooM config; changed runtimes: ${result.changed.join(', ') || 'none'}`);
      })
      .catch((error) => logger.error?.(`LLooM config reload failed: ${error?.message ?? error}`));
  }

  function runRuntimeAdminAction(action) {
    return retryRuntimeActionAfterConfigReload(action, () => reloadInFlight);
  }

  async function routingStatus() {
    const cacheMs = Math.max(0, Number(config.cluster?.routingStatusCacheMs ?? 250));
    let runtimeStatus = routingStatusCache.value;
    if (!runtimeStatus || Date.now() - routingStatusCache.at >= cacheMs) {
      if (!routingStatusCache.pending) {
        routingStatusCache.pending = Promise.resolve(
          typeof runtimeManager.status === 'function' ? runtimeManager.status() : { runtimes: {} }
        )
          .then((value) => {
            routingStatusCache = { at: Date.now(), value, pending: null };
            return value;
          })
          .catch((error) => {
            routingStatusCache = { at: 0, value: null, pending: null };
            throw error;
          });
      }
      runtimeStatus = await routingStatusCache.pending;
    }
    return runtimeStatus;
  }

  async function resolveRequestCandidate(resolved) {
    if (!Array.isArray(resolved.model.targets) || resolved.model.targets.length <= 1) {
      const target = clusterCoordinator.selectTarget(resolved, { runtimes: {} });
      return {
        ...resolved,
        model: {
          ...resolved.model,
          ...(target?.upstreamModel ? { upstreamModel: target.upstreamModel } : {}),
          selectedTarget: target?.id,
          selectedNode: target?.node
        },
        target
      };
    }
    const runtimeStatus = await routingStatus();
    const nodeIds = [...new Set(resolved.model.targets.map((target) => target.node).filter(Boolean))];
    const nodeEntries = await Promise.all(
      nodeIds.map(async (nodeId) => [nodeId, await clusterCoordinator.nodeStatus(nodeId)])
    );
    const target = clusterCoordinator.selectTarget(resolved, runtimeStatus, { nodes: Object.fromEntries(nodeEntries) });
    if (!target) return resolved;
    return {
      ...resolved,
      model: {
        ...resolved.model,
        backend: target.backend,
        ...(target.runtime ? { runtime: target.runtime } : { runtime: undefined }),
        ...(target.upstreamModel ? { upstreamModel: target.upstreamModel } : {}),
        selectedTarget: target.id,
        selectedNode: target.node
      },
      backend: config.backends[target.backend],
      runtime: target.runtime ? (config.runtimes[target.runtime] ?? null) : null,
      target
    };
  }

  async function resolveRequestModels(modelId) {
    const candidates = await Promise.all(registry.resolveCandidates(modelId).map(resolveRequestCandidate));
    if (candidates.length <= 1) {
      return candidates.map((candidate) => ({
        ...candidate,
        ...(candidate.aliasTargetCount > 1
          ? {
              failover: {
                attempt: 1,
                targets: candidate.aliasTargetCount,
                primaryModel: candidate.alias?.target,
                used: candidate.aliasTargetIndex > 0,
                readyAlternativeAvailable: false
              }
            }
          : {})
      }));
    }
    let status;
    try {
      status = await routingStatus();
    } catch (error) {
      logger.warn?.(`could not inspect runtimes before model failover routing: ${error?.message ?? error}`);
      status = { runtimes: {} };
    }
    let admissionStatus = status;
    try {
      if (typeof clusterCoordinator.status === 'function') {
        admissionStatus = { ...status, cluster: await clusterCoordinator.status() };
      }
    } catch (error) {
      logger.warn?.(`could not inspect cluster capacity before model failover routing: ${error?.message ?? error}`);
    }
    const available = candidates.filter((candidate, index) => {
      if (index === candidates.length - 1 || !candidate.model.runtime) return true;
      const runtimeState = status?.runtimes?.[candidate.model.runtime]?.status;
      if (!MODEL_FAILOVER_RUNTIME_STATES.has(runtimeState)) return true;
      logger.warn?.(
        `skipping model target ${candidate.resolvedId} for ${candidate.requestedId}: runtime ${candidate.model.runtime} is ${runtimeState}`
      );
      return false;
    });
    let ordered = available;
    let routeReason = null;
    const primary = available[0];
    const readyFallbacks = available.slice(1).filter((candidate) => {
      if (!candidate.model.runtime) return true;
      const runtime = status?.runtimes?.[candidate.model.runtime];
      return runtime?.healthy === true || ['running', 'external'].includes(runtime?.status);
    });
    if (config.runtimePolicy?.autoEvict === true && primary?.model.runtime && readyFallbacks.length > 0) {
      try {
        const plan = await createRuntimePolicyPlan(config, {
          requestedRuntimeId: primary.model.runtime,
          status: admissionStatus
        });
        const requiresEviction = plan.actions.some((action) => action.type === 'stop');
        if (requiresEviction || !plan.admission.allowed) {
          const preferred = new Set(readyFallbacks);
          ordered = [...readyFallbacks, ...available.filter((candidate) => !preferred.has(candidate))];
          routeReason = requiresEviction ? 'preserve-residency' : 'capacity-fallback';
        }
      } catch (error) {
        logger.warn?.(
          `could not preview admission for ${primary.resolvedId}; retaining primary-first routing: ${error?.message ?? error}`
        );
      }
    }

    return ordered.map((candidate, attemptIndex) => ({
      ...candidate,
      failover: {
        attempt: attemptIndex + 1,
        targets: candidate.aliasTargetCount ?? ordered.length,
        primaryModel: candidate.alias?.target ?? candidates[0].resolvedId,
        used: candidate.aliasTargetIndex > 0 || candidate.resolvedId !== candidates[0].resolvedId,
        readyAlternativeAvailable: ordered
          .slice(attemptIndex + 1)
          .some((alternative) => readyFallbacks.includes(alternative)),
        ...(routeReason ? { reason: routeReason } : {})
      }
    }));
  }

  async function resolveRequestModel(modelId) {
    return (await resolveRequestModels(modelId))[0];
  }
  function appendRequestLog(entry) {
    if (config.logging?.requestLog !== true && process.env.LLOOM_REQUEST_LOG !== '1') return;
    const home = process.env.HOME ? `${process.env.HOME}/.lloom/logs` : './.lloom/logs';
    const logPath = config.logging?.requestLogPath || `${home}/requests.ndjson`;
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      logger.error?.(error);
    }
  }

  const metricsPersistence = createMetricsPersistence(config, { logger });
  const baseMetrics = createMetricsStore({ initialSnapshot: metricsPersistence.loadSnapshot() });
  const metrics = {
    begin(entry) {
      return baseMetrics.begin(entry);
    },
    end(id) {
      baseMetrics.end(id);
    },
    update(id, patch) {
      baseMetrics.update(id, patch);
    },
    record(entry) {
      baseMetrics.record(entry);
      appendRequestLog({
        route: entry.route,
        model: entry.requestedModel ?? entry.model,
        resolvedModel: entry.resolvedModel ?? entry.model,
        failoverAttempt: entry.failoverAttempt ?? undefined,
        failoverTargets: entry.failoverTargets ?? undefined,
        failoverReason: entry.failoverReason ?? undefined,
        failedOver: entry.failedOver === true || undefined,
        caller: entry.caller ?? undefined,
        entity: entry.entity ?? undefined,
        purpose: entry.purpose ?? undefined,
        status: entry.status,
        durationMs: entry.durationMs,
        firstContentMs: entry.firstContentMs,
        stream: entry.stream === true,
        inputTokens: entry.usage?.input_tokens ?? 0,
        outputTokens: metricOutputTokens(entry),
        totalTokens: entry.usage?.total_tokens ?? (entry.usage?.input_tokens ?? 0) + metricOutputTokens(entry),
        error: entry.ok === false ? (entry.error ?? entry.status) : undefined
      });
      metricsPersistence.schedule(baseMetrics.persistenceSnapshot());
    },
    snapshot(...args) {
      return { ...baseMetrics.snapshot(...args), persistence: metricsPersistence.metadata() };
    },
    flush() {
      metricsPersistence.flush();
    }
  };

  async function startRuntime(runtimeId, { alternativeAvailable = false, allowEviction = true } = {}) {
    if (config.runtimePolicy?.autoEvict === true) {
      const waitMs = Math.max(0, Number(config.runtimePolicy?.admissionWaitMs ?? 120000));
      const deadline = Date.now() + waitMs;
      let queued = false;
      const pausedBlockers = new Set();
      try {
        while (true) {
          try {
            return await applyRuntimePolicyPlan(config, runtimeManager, {
              requestedRuntimeId: runtimeId,
              dryRun: false,
              yes: true,
              warmup: true,
              force: false,
              reason: 'model-request',
              alternativeAvailable,
              allowEviction: allowEviction && !alternativeAvailable
            });
          } catch (error) {
            if (alternativeAvailable && error instanceof RuntimeAdmissionError) throw error;
            if (!(error instanceof RuntimeAdmissionError) || !error.temporary || Date.now() >= deadline) throw error;
            if (!queued) {
              runtimeManager.markAdmissionQueued(runtimeId, true, 'waiting-for-capacity');
              queued = true;
            }
            for (const blocker of runtimeAdmissionBlockers(error.plan).active) {
              if (pausedBlockers.has(blocker.runtimeId)) continue;
              runtimeManager.pauseRuntime?.(blocker.runtimeId, `capacity-for:${runtimeId}`);
              pausedBlockers.add(blocker.runtimeId);
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(error.retryAfterSeconds * 1000, deadline - Date.now()))
            );
          }
        }
      } finally {
        if (queued) runtimeManager.markAdmissionQueued(runtimeId, false);
        for (const blocker of pausedBlockers) runtimeManager.resumeRuntime?.(blocker);
      }
    }
    return runtimeManager.ensure(runtimeId);
  }

  async function ensureRuntime(runtimeId, { alternativeAvailable = false, allowEviction = true } = {}) {
    if (!runtimeId) return { runtimeId, started: false, reason: 'no-runtime' };
    if (typeof runtimeManager.isHealthy === 'function' && (await runtimeManager.isHealthy(runtimeId))) {
      return { runtimeId, started: false, healthy: true, reason: 'already-healthy' };
    }

    let operation = runtimeStartOperations.get(runtimeId);
    if (!operation) {
      operation = startRuntime(runtimeId, { alternativeAvailable, allowEviction });
      runtimeStartOperations.set(runtimeId, operation);
      operation
        .catch((error) => logger.error?.(`runtime ${runtimeId} background start failed: ${error?.message ?? error}`))
        .finally(() => {
          if (runtimeStartOperations.get(runtimeId) === operation) runtimeStartOperations.delete(runtimeId);
        });
    }

    const runtime = config.runtimes?.[runtimeId] ?? {};
    const foregroundWaitMs = Math.max(0, Number(runtime.requestStartupWaitMs ?? 1000));
    if (foregroundWaitMs > 0) {
      const stillStarting = Symbol('runtime-still-starting');
      const result = await Promise.race([
        operation,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(stillStarting), foregroundWaitMs);
          timer.unref?.();
        })
      ]);
      if (result !== stillStarting) {
        if (typeof runtimeManager.isHealthy !== 'function' || (await runtimeManager.isHealthy(runtimeId))) {
          return result;
        }
        const reason =
          result?.reason ??
          result?.results?.find?.((entry) => entry.runtimeId === runtimeId && entry.type === 'start')?.result?.reason ??
          'startup completed without a healthy endpoint';
        throw new RuntimeUnavailableError(runtimeId, reason);
      }
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(Number(runtime.startupRetryAfterSeconds ?? 15)));
    throw new RuntimeStartingError(runtimeId, retryAfterSeconds);
  }

  function noteRuntimeRequestOutcome(runtimeId, outcome) {
    try {
      runtimeManager.noteRequestOutcome?.(runtimeId, outcome);
    } catch (error) {
      logger.error?.(`Runtime watchdog observation failed for ${runtimeId}: ${error?.message ?? error}`);
    }
  }

  async function recordModelRequest({ route, resolved, stream, req, res }, fn, { deferUnsentErrors = false } = {}) {
    const started = Date.now();
    const requestBytes = Number(req.headers['content-length']) || 0;
    const attribution = requestEnntityAttribution(req);
    const connectionId = metrics.begin({
      route,
      model: resolved.model.id,
      requestedModel: resolved.requestedId,
      upstreamModel: resolved.model.upstreamModel,
      kind: resolved.model.kind ?? 'chat',
      backend: resolved.model.backend,
      runtime: resolved.model.runtime,
      resolvedModel: resolved.resolvedId,
      failoverAttempt: resolved.failover?.attempt,
      failoverTargets: resolved.failover?.targets,
      failoverReason: resolved.failover?.reason,
      failedOver: resolved.failover?.used === true,
      target: resolved.model.selectedTarget,
      node: resolved.model.selectedNode,
      caller: requestCallerLabel(req),
      ...attribution,
      requestBytes,
      stream
    });
    const timing = createResponseTiming(started);
    const client = createClientCloseTracker(req, res);
    const watchdogConfig = runtimeWatchdogConfig(config.runtimes?.[resolved.model.runtime]);
    let watchdogTimer = null;
    let watchdogArmed = false;
    let runtimeStartedAt = null;
    let lastProgressAt = started;
    const clearWatchdogTimer = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };
    const armWatchdogTimer = () => {
      // Buffered responses cannot expose upstream progress before their complete
      // body is available. Treating that silence as a stall can restart a
      // healthy runtime during an otherwise successful long request.
      if (!watchdogConfig.enabled || stream !== true) return;
      watchdogArmed = true;
      clearWatchdogTimer();
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null;
        noteRuntimeRequestOutcome(resolved.model.runtime, {
          id: connectionId,
          route,
          model: resolved.model.id,
          status: 504,
          ok: false,
          durationMs: Date.now() - started,
          runtimeDurationMs: runtimeStartedAt == null ? 0 : Date.now() - runtimeStartedAt,
          stallDurationMs: Date.now() - lastProgressAt,
          responseBytes: 0,
          stalled: true
        });
      }, watchdogConfig.minNoProgressMs);
      watchdogTimer.unref?.();
    };
    const progress = (patch) => {
      metrics.update(connectionId, patch);
      if (!watchdogArmed) return;
      const bytes = Number(patch?.responseBytesDelta ?? 0);
      const chars = Number(patch?.outputCharsDelta ?? 0);
      if (bytes > 0 || chars > 0) {
        lastProgressAt = Date.now();
        armWatchdogTimer();
      }
    };
    const watchdog = { arm: armWatchdogTimer };
    try {
      const result = await clusterCoordinator.withTarget(resolved, async () => {
        await ensureRuntime(resolved.model.runtime, {
          alternativeAvailable: resolved.failover?.readyAlternativeAvailable === true,
          allowEviction: resolved.model.kind !== 'embedding'
        });
        return runtimeManager.withSlot(
          resolved.model.runtime,
          () => {
            runtimeStartedAt = Date.now();
            lastProgressAt = runtimeStartedAt;
            return fn({
              signal: client.signal,
              timing,
              progress,
              watchdog
            });
          },
          { signal: client.signal }
        );
      });
      const status = result?.status ?? 200;
      const outcome = {
        id: connectionId,
        route,
        model: resolved.model.id,
        requestedModel: resolved.requestedId,
        upstreamModel: resolved.model.upstreamModel,
        kind: resolved.model.kind ?? 'chat',
        backend: resolved.model.backend,
        runtime: resolved.model.runtime,
        resolvedModel: resolved.resolvedId,
        failoverAttempt: resolved.failover?.attempt,
        failoverTargets: resolved.failover?.targets,
        failoverReason: resolved.failover?.reason,
        failedOver: resolved.failover?.used === true,
        target: resolved.model.selectedTarget,
        node: resolved.model.selectedNode,
        caller: requestCallerLabel(req),
        ...attribution,
        status,
        ok: status >= 200 && status < 400,
        stream: result?.stream ?? stream,
        durationMs: Date.now() - started,
        runtimeDurationMs: runtimeStartedAt == null ? 0 : Date.now() - runtimeStartedAt,
        firstContentMs: result?.firstContentMs ?? timing.firstContentMs,
        lastContentMs: result?.lastContentMs ?? timing.lastContentMs,
        responseBytes: result?.responseBytes ?? 0,
        requestBytes,
        usage: result?.usage ?? null
      };
      metrics.record(outcome);
      noteRuntimeRequestOutcome(resolved.model.runtime, outcome);
      clusterCoordinator.noteTargetOutcome(resolved, outcome);
      return result;
    } catch (error) {
      const status = client.closed
        ? 499
        : clientClosedStatus(error) ||
          errorStatusCode(error) ||
          (error instanceof PromptTooLargeError || error instanceof StructuredOutputError ? error.statusCode : 0) ||
          502;
      const outcome = {
        id: connectionId,
        route,
        model: resolved.model.id,
        requestedModel: resolved.requestedId,
        upstreamModel: resolved.model.upstreamModel,
        kind: resolved.model.kind ?? 'chat',
        backend: resolved.model.backend,
        runtime: resolved.model.runtime,
        resolvedModel: resolved.resolvedId,
        failoverAttempt: resolved.failover?.attempt,
        failoverTargets: resolved.failover?.targets,
        failoverReason: resolved.failover?.reason,
        failedOver: resolved.failover?.used === true,
        target: resolved.model.selectedTarget,
        node: resolved.model.selectedNode,
        caller: requestCallerLabel(req),
        ...attribution,
        status,
        ok: false,
        stream,
        durationMs: Date.now() - started,
        runtimeDurationMs: runtimeStartedAt == null ? 0 : Date.now() - runtimeStartedAt,
        firstContentMs: timing.firstContentMs,
        lastContentMs: timing.lastContentMs,
        responseBytes: 0,
        requestBytes,
        error: error?.message ?? String(error)
      };
      metrics.record(outcome);
      noteRuntimeRequestOutcome(resolved.model.runtime, outcome);
      clusterCoordinator.noteTargetOutcome(resolved, outcome);
      if (status === 499 || isClientClosedError(error)) {
        endResponseWithError(res, error, { stream, config, status: 499 });
        return {
          status: 499,
          stream,
          responseBytes: 0,
          usage: null
        };
      }
      if (
        deferUnsentErrors &&
        !res.headersSent &&
        !res.writableEnded &&
        !res.destroyed &&
        shouldFailoverModelRequest(error, res)
      ) {
        throw error;
      }
      // Upstream death mid-stream (Metal abort, connection reset): finish SSE/JSON without
      // rethrowing into the outer handler (which would try writeHead again and crash Node).
      if (res.headersSent || stream) {
        endResponseWithError(res, error, {
          stream: true,
          config,
          status
        });
        return {
          status,
          stream: true,
          responseBytes: 0,
          usage: null,
          error: error?.message ?? String(error)
        };
      }
      throw error;
    } finally {
      clearWatchdogTimer();
      metrics.end(connectionId);
      client.dispose();
    }
  }

  async function recordModelRequestWithFailover({ route, modelId, stream, req, res, kind = 'chat' }, fn) {
    const candidates = await resolveRequestModels(modelId);
    if ((candidates[0].model.kind ?? 'chat') !== kind) {
      sendJson(
        res,
        400,
        errorBody(`model ${candidates[0].requestedId} is not a ${kind} model`, {
          code: 'wrong_model_kind',
          model: candidates[0].requestedId
        })
      );
      return;
    }
    for (const [index, resolved] of candidates.entries()) {
      const hasNext = index < candidates.length - 1;
      try {
        return await recordModelRequest(
          { route, resolved, stream, req, res },
          (context) => fn(resolved, { ...context, hasNext }),
          { deferUnsentErrors: hasNext }
        );
      } catch (error) {
        if (!hasNext || !shouldFailoverModelRequest(error, res)) throw error;
        logger.warn?.(
          `model failover ${resolved.requestedId}: ${resolved.resolvedId} -> ${candidates[index + 1].resolvedId} (${error?.message ?? error})`
        );
      }
    }
    throw new UnknownModelError(modelId);
  }

  async function handleOpenAIChat(req, res) {
    const body = await readJson(req);
    await recordModelRequestWithFailover(
      {
        route: '/v1/chat/completions',
        modelId: body.model ?? config.defaults?.chatModel,
        stream: body.stream === true,
        req,
        res
      },
      async (resolved, { signal, timing, progress, watchdog, hasNext }) => {
        assertPromptWithinBudget(resolved, body, { logger });
        watchdog.arm();
        // Normalize history so reasoning_content is OpenAI-shaped before MTPLX render.
        const normalizedRequest = prepareStructuredOutputForBackend(
          translateReasoningEffortForBackend(normalizeOpenAIChatRequestBody(body), resolved),
          resolved
        );
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/chat/completions',
          signal,
          body: {
            ...normalizedRequest.body,
            model: resolved.model.upstreamModel
          }
        });
        if (!upstream.ok && (body.stream === true || (hasNext && MODEL_FAILOVER_STATUS_CODES.has(upstream.status)))) {
          // Avoid opening an SSE response for an already-failed upstream.
          throw await upstreamStatusError(upstream);
        }
        return body.stream === true
          ? proxyOpenAIChatStream(res, upstream, resolved.requestedId, { signal, timing, progress, corsConfig: config })
          : proxyOpenAIChatResponse(res, upstream, resolved.requestedId, {
              signal,
              timing,
              progress,
              structuredOutput: normalizedRequest.output,
              corsConfig: config
            });
      }
    );
  }

  async function handleOpenAIImages(req, res) {
    const body = await readJson(req);
    const modelId = body.model ?? config.defaults?.imageModel;
    const resolved = await resolveRequestModel(modelId);
    if ((resolved.model.kind ?? 'chat') !== 'image') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not an image-generation model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      );
      return;
    }
    await recordModelRequest(
      {
        route: '/v1/images/generations',
        resolved,
        stream: false,
        req,
        res
      },
      async ({ signal, timing, watchdog }) => {
        watchdog.arm();
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/images/generations',
          signal,
          dispatcher: longRunningMediaDispatcher,
          body: {
            ...body,
            model: resolved.model.upstreamModel
          }
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAIImageEdits(req, res) {
    const type = contentType(req);
    if (!/^multipart\/form-data\b/i.test(type)) {
      sendJson(
        res,
        400,
        errorBody('image edit request must use multipart/form-data', {
          code: 'invalid_content_type'
        })
      );
      return;
    }

    const raw = await readBodyBuffer(req);
    const modelId = multipartTextField(raw, type, 'model') ?? config.defaults?.imageModel;
    const resolved = await resolveRequestModel(modelId);
    if ((resolved.model.kind ?? 'chat') !== 'image') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not an image-generation model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      );
      return;
    }
    const modelInputs = new Set(resolved.model.input ?? []);
    const modelCapabilities = new Set(resolved.model.capabilities ?? []);
    if (!modelInputs.has('image') && !modelCapabilities.has('image-editing')) {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} does not support image editing`, {
          code: 'unsupported_model_capability',
          model: resolved.requestedId,
          capability: 'image-editing'
        })
      );
      return;
    }

    let upstreamBody;
    try {
      upstreamBody = multipartWithTextField(raw, type, 'model', resolved.model.upstreamModel);
    } catch (error) {
      sendJson(
        res,
        400,
        errorBody(error?.message ?? 'invalid multipart request', {
          code: 'invalid_multipart'
        })
      );
      return;
    }

    await recordModelRequest(
      {
        route: '/v1/images/edits',
        resolved,
        stream: false,
        req,
        res
      },
      async ({ signal, timing, watchdog }) => {
        watchdog.arm();
        const upstream = await fetchRawUpstream({
          backend: resolved.backend,
          path: '/v1/images/edits',
          signal,
          dispatcher: longRunningMediaDispatcher,
          headers: { 'content-type': type },
          body: upstreamBody
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAIVideos(req, res) {
    const body = await readJson(req);
    const modelId = body.model ?? config.defaults?.videoModel;
    if (!modelId) {
      sendJson(res, 400, errorBody('video request requires model', { code: 'missing_model' }));
      return;
    }
    const resolved = await resolveRequestModel(modelId);
    if ((resolved.model.kind ?? 'chat') !== 'video') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not a video-generation model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      );
      return;
    }
    await recordModelRequest(
      {
        route: '/v1/videos/generations',
        resolved,
        stream: false,
        req,
        res
      },
      async ({ signal, timing, watchdog }) => {
        watchdog.arm();
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/videos/generations',
          signal,
          dispatcher: longRunningMediaDispatcher,
          body: {
            ...body,
            model: resolved.model.upstreamModel
          }
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAIEmbeddings(req, res) {
    const body = await readJson(req);
    const modelId = body.model ?? config.defaults?.embeddingModel;
    if (!modelId) {
      sendJson(
        res,
        400,
        errorBody('embedding request requires model', {
          code: 'missing_model'
        })
      );
      return;
    }
    await recordModelRequestWithFailover(
      {
        route: '/v1/embeddings',
        modelId,
        stream: false,
        req,
        res,
        kind: 'embedding'
      },
      async (resolved, { signal, timing, watchdog, hasNext }) => {
        watchdog.arm();
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/embeddings',
          signal,
          body: {
            ...body,
            model: resolved.model.upstreamModel
          }
        });
        if (!upstream.ok && hasNext && MODEL_FAILOVER_STATUS_CODES.has(upstream.status)) {
          throw await upstreamStatusError(upstream);
        }
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function resolveSpeechModelOrError(modelId) {
    try {
      const resolved = await resolveRequestModel(modelId);
      if ((resolved.model.kind ?? 'chat') !== 'audio_speech') {
        const error = new Error(`model ${resolved.requestedId} is not a speech model`);
        error.code = 'wrong_model_kind';
        error.modelId = resolved.requestedId;
        throw error;
      }
      return { resolved: { ...resolved, tts: resolveTtsDescriptor(resolved.model) } };
    } catch (error) {
      if (error?.code === 'wrong_model_kind') {
        return {
          error: errorBody(error.message, {
            code: 'wrong_model_kind',
            model: error.modelId
          })
        };
      }
      if (error instanceof UnknownModelError || error?.code === 'unknown_model') {
        return {
          error: errorBody(error.message, {
            code: 'unknown_model',
            model: error.modelId
          })
        };
      }
      throw error;
    }
  }

  function voicesRoot() {
    return config.paths?.voicesRoot ?? process.env.LLOOM_VOICES_ROOT ?? defaultVoicesRoot(process.env);
  }

  async function expandSpeechBody(body) {
    return resolveSpeechVoice(body, { voicesRoot: voicesRoot() });
  }

  async function proxySpeechJson(req, res, body, { profile = null } = {}) {
    const modelId = body.model ?? config.defaults?.speechModel;
    if (!modelId) {
      sendJson(
        res,
        400,
        errorBody('speech request requires model (or an installed voice profile)', {
          code: 'missing_model'
        })
      );
      return;
    }
    const { resolved, error } = await resolveSpeechModelOrError(modelId);
    if (error) {
      sendJson(res, error.error?.code === 'unknown_model' ? 404 : 400, error);
      return;
    }
    const normalized = normalizeSpeechRequestBody(body, {
      upstreamModel: resolved.model.upstreamModel
    });
    // Keep named profile id in voice for logging; clone backends ignore unknown speakers.
    if (profile?.id) normalized.voice = profile.id;
    await recordModelRequest(
      {
        route: '/v1/audio/speech',
        resolved,
        stream: false,
        req,
        res,
        voiceProfile: profile?.id ?? null
      },
      async ({ signal, timing, watchdog }) => {
        watchdog.arm();
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/audio/speech',
          signal,
          body: normalized
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAISpeech(req, res) {
    const type = contentType(req);

    // Multipart: may be raw clone upload OR named voice profile (+ optional overrides).
    if (/^multipart\/form-data\b/i.test(type)) {
      const raw = await readBodyBuffer(req);
      const fields = {
        model: multipartTextField(raw, type, 'model'),
        voice: multipartTextField(raw, type, 'voice'),
        input: multipartTextField(raw, type, 'input') ?? multipartTextField(raw, type, 'text'),
        instructions: multipartTextField(raw, type, 'instructions') ?? multipartTextField(raw, type, 'instruct'),
        instruct: multipartTextField(raw, type, 'instruct'),
        ref_text: multipartTextField(raw, type, 'ref_text') ?? multipartTextField(raw, type, 'refText'),
        language: multipartTextField(raw, type, 'language') ?? multipartTextField(raw, type, 'lang_code'),
        temperature: multipartTextField(raw, type, 'temperature'),
        top_p: multipartTextField(raw, type, 'top_p'),
        top_k: multipartTextField(raw, type, 'top_k'),
        repetition_penalty: multipartTextField(raw, type, 'repetition_penalty'),
        exaggeration: multipartTextField(raw, type, 'exaggeration'),
        cfg_weight: multipartTextField(raw, type, 'cfg_weight') ?? multipartTextField(raw, type, 'cfgWeight'),
        min_p: multipartTextField(raw, type, 'min_p'),
        language_id: multipartTextField(raw, type, 'language_id'),
        audio_prompt_path: multipartTextField(raw, type, 'audio_prompt_path'),
        response_format: multipartTextField(raw, type, 'response_format')
      };
      const expanded = await expandSpeechBody(fields);
      // Named profile: expand to JSON clone request (ref on disk) so clients only send voice+input.
      if (expanded.applied) {
        await proxySpeechJson(req, res, expanded.body, { profile: expanded.profile });
        return;
      }

      const modelId = fields.model ?? config.defaults?.speechModel;
      const { resolved, error } = await resolveSpeechModelOrError(modelId);
      if (error) {
        sendJson(res, error.error?.code === 'unknown_model' ? 404 : 400, error);
        return;
      }
      let upstreamBody;
      try {
        upstreamBody = multipartWithTextField(raw, type, 'model', resolved.model.upstreamModel);
        const instruct =
          multipartTextField(upstreamBody, type, 'instruct') ?? multipartTextField(upstreamBody, type, 'instructions');
        if (instruct != null) {
          upstreamBody = multipartWithTextField(upstreamBody, type, 'instruct', instruct);
          upstreamBody = multipartWithTextField(upstreamBody, type, 'instructions', instruct);
        }
      } catch (multipartError) {
        sendJson(
          res,
          400,
          errorBody(multipartError?.message ?? 'invalid multipart request', {
            code: 'invalid_multipart'
          })
        );
        return;
      }
      await recordModelRequest(
        {
          route: '/v1/audio/speech',
          resolved,
          stream: false,
          req,
          res
        },
        async ({ signal, timing, watchdog }) => {
          watchdog.arm();
          const upstream = await fetchRawUpstream({
            backend: resolved.backend,
            path: '/v1/audio/speech',
            body: upstreamBody,
            signal,
            headers: {
              'content-type': type
            }
          });
          return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
        }
      );
      return;
    }

    if (!/^application\/json\b/i.test(type) && type) {
      sendJson(
        res,
        415,
        errorBody('speech request must use application/json or multipart/form-data', {
          code: 'unsupported_content_type'
        })
      );
      return;
    }

    const body = await readJson(req);
    const expanded = await expandSpeechBody(body);
    await proxySpeechJson(req, res, expanded.body, { profile: expanded.profile });
  }

  async function handleSpeechVoices(req, res, url) {
    const modelId = firstQueryParam(url.searchParams, ['model', 'model_id', 'model-id']);
    const profiles = await listVoiceProfiles({ voicesRoot: voicesRoot() });

    let modelVoices = null;
    if (modelId) {
      try {
        modelVoices = registry.voices(modelId);
      } catch {
        modelVoices = null;
      }
    } else {
      // Default speech model built-ins (CustomVoice list) plus all profiles.
      const defaultSpeech = config.defaults?.speechModel;
      if (defaultSpeech) {
        try {
          modelVoices = registry.voices(defaultSpeech);
        } catch {
          modelVoices = null;
        }
      }
    }

    sendJson(
      res,
      200,
      listVoicesDiscovery({
        profiles,
        modelVoices,
        modelId: modelId ?? config.defaults?.speechModel ?? null
      })
    );
  }

  async function handleSpeechSchema(req, res, url) {
    const modelId =
      firstQueryParam(url.searchParams, ['model', 'model_id', 'model-id']) ?? config.defaults?.speechModel;
    if (!modelId) {
      sendJson(
        res,
        400,
        errorBody('speech schema request requires model', {
          code: 'missing_model'
        })
      );
      return;
    }
    const { resolved, error } = await resolveSpeechModelOrError(modelId);
    if (error) {
      sendJson(res, error.error?.code === 'unknown_model' ? 404 : 400, error);
      return;
    }
    sendJson(res, 200, registry.speechSchema(resolved.requestedId));
  }

  function handleTranscriptionSchema(req, res, url) {
    const modelId =
      firstQueryParam(url.searchParams, ['model', 'model_id', 'model-id']) ?? config.defaults?.transcriptionModel;
    if (!modelId) {
      sendJson(
        res,
        400,
        errorBody('transcription schema request requires model', {
          code: 'missing_model'
        })
      );
      return;
    }
    try {
      sendJson(res, 200, registry.transcriptionSchema(modelId));
    } catch (error) {
      if (error?.code === 'wrong_model_kind' || error instanceof UnknownModelError) {
        sendJson(
          res,
          error instanceof UnknownModelError ? 404 : 400,
          errorBody(error.message, {
            code: error.code ?? 'unknown_model',
            model: error.modelId
          })
        );
        return;
      }
      throw error;
    }
  }

  async function handleSpeechCatalog(_req, res) {
    const profiles = await listVoiceProfiles({ voicesRoot: voicesRoot() });
    sendJson(res, 200, registry.speechCatalog({ voiceProfiles: profiles }));
  }

  async function resolveTranscriptionModel(modelId) {
    if (!modelId) {
      return {
        error: errorBody('transcription request requires model', {
          code: 'missing_model'
        })
      };
    }
    const resolved = await resolveRequestModel(modelId);
    if ((resolved.model.kind ?? 'chat') !== 'audio_transcription') {
      return {
        error: errorBody(`model ${resolved.requestedId} is not a transcription model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      };
    }
    return { resolved };
  }

  async function handleOpenAITranscription(req, res) {
    const type = contentType(req);
    if (/^application\/json\b/i.test(type)) {
      const body = await readJson(req);
      const { resolved, error } = await resolveTranscriptionModel(body.model ?? config.defaults?.transcriptionModel);
      if (error) {
        sendJson(res, 400, error);
        return;
      }
      await recordModelRequest(
        {
          route: '/v1/audio/transcriptions',
          resolved,
          stream: false,
          req,
          res
        },
        async ({ signal, timing, watchdog }) => {
          watchdog.arm();
          const upstream = await fetchUpstream({
            backend: resolved.backend,
            path: '/v1/audio/transcriptions',
            signal,
            body: {
              ...body,
              model: resolved.model.upstreamModel
            }
          });
          return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
        }
      );
      return;
    }

    if (!/^multipart\/form-data\b/i.test(type)) {
      sendJson(
        res,
        415,
        errorBody('transcription request must use multipart/form-data or application/json', {
          code: 'unsupported_content_type'
        })
      );
      return;
    }

    const raw = await readBodyBuffer(req);
    const modelId = multipartTextField(raw, type, 'model') ?? config.defaults?.transcriptionModel;
    const { resolved, error } = await resolveTranscriptionModel(modelId);
    if (error) {
      sendJson(res, 400, error);
      return;
    }
    let upstreamBody;
    try {
      upstreamBody = multipartWithTextField(raw, type, 'model', resolved.model.upstreamModel);
    } catch (error) {
      sendJson(
        res,
        400,
        errorBody(error?.message ?? 'invalid multipart request', {
          code: 'invalid_multipart'
        })
      );
      return;
    }
    await recordModelRequest(
      {
        route: '/v1/audio/transcriptions',
        resolved,
        stream: false,
        req,
        res
      },
      async ({ signal, timing, watchdog }) => {
        watchdog.arm();
        const upstream = await fetchRawUpstream({
          backend: resolved.backend,
          path: '/v1/audio/transcriptions',
          body: upstreamBody,
          signal,
          headers: {
            'content-type': type
          }
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAIResponses(req, res) {
    const body = await readJson(req);
    await recordModelRequestWithFailover(
      {
        route: '/v1/responses',
        modelId: body.model ?? config.defaults?.chatModel,
        stream: body.stream === true,
        req,
        res
      },
      async (resolved, { signal, timing, watchdog, hasNext }) => {
        watchdog.arm();
        const normalizedRequest = prepareStructuredOutputForBackend(responsesToOpenAIChat(body, resolved), resolved);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/chat/completions',
          signal,
          body: normalizedRequest.body
        });
        if (!upstream.ok && hasNext && MODEL_FAILOVER_STATUS_CODES.has(upstream.status)) {
          throw await upstreamStatusError(upstream);
        }
        if (body.stream === true) {
          if (!upstream.ok) return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
          return streamResponsesFromOpenAI(res, upstream, resolved.requestedId, {
            signal,
            timing,
            writeSse,
            throwIfClientClosed,
            setCors: (r) => setCors(r, config),
            sseHeaders,
            markFirstContent
          });
        }
        const text = await upstream.text();
        throwIfClientClosed(signal, res);
        if (!upstream.ok) {
          setCors(res, config);
          res.writeHead(upstream.status, copyResponseHeaders(upstream));
          res.end(text);
          return {
            status: upstream.status,
            stream: false,
            responseBytes: Buffer.byteLength(text),
            usage: usageFromJsonText(text)
          };
        }
        const responseJson = normalizeStructuredOutputChatCompletion(JSON.parse(text), normalizedRequest.output);
        sendJson(res, 200, openAIToResponses(responseJson, resolved.requestedId));
        return {
          status: 200,
          stream: false,
          responseBytes: Buffer.byteLength(text),
          usage: metricUsageFromOpenAI(responseJson.usage)
        };
      }
    );
  }

  async function handleAnthropicMessages(req, res) {
    const body = await readJson(req);
    await recordModelRequestWithFailover(
      {
        route: '/v1/messages',
        modelId: body.model ?? config.defaults?.chatModel,
        stream: body.stream === true,
        req,
        res
      },
      async (resolved, { signal, timing, watchdog, hasNext }) => {
        watchdog.arm();
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/chat/completions',
          signal,
          body: anthropicMessagesToOpenAI(body, resolved)
        });
        if (!upstream.ok && hasNext && MODEL_FAILOVER_STATUS_CODES.has(upstream.status)) {
          throw await upstreamStatusError(upstream);
        }
        if (body.stream === true) {
          if (!upstream.ok) return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
          return streamAnthropicFromOpenAI(res, upstream, resolved.requestedId, {
            signal,
            timing,
            writeSse,
            throwIfClientClosed,
            setCors: (r) => setCors(r, config),
            sseHeaders,
            markFirstContent
          });
        }
        const text = await upstream.text();
        throwIfClientClosed(signal, res);
        if (!upstream.ok) {
          setCors(res, config);
          res.writeHead(upstream.status, copyResponseHeaders(upstream));
          res.end(text);
          return {
            status: upstream.status,
            stream: false,
            responseBytes: Buffer.byteLength(text),
            usage: usageFromJsonText(text)
          };
        }
        const responseJson = JSON.parse(text);
        sendJson(res, 200, openAIToAnthropic(responseJson, resolved.requestedId));
        return {
          status: 200,
          stream: false,
          responseBytes: Buffer.byteLength(text),
          usage: metricUsageFromOpenAI(responseJson.usage)
        };
      }
    );
  }

  async function handleRequest(req, res) {
    setCors(res, config);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      const auth = authorizeRequest(req, config, {
        method: req.method,
        pathname: url.pathname
      });
      if (!auth.ok) {
        sendJson(
          res,
          auth.status,
          errorBody(auth.message, {
            type: auth.status === 403 ? 'permission_error' : 'authentication_error',
            code: auth.code
          })
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, name: config.name ?? 'LLooM' }, {}, config);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/security') {
        sendJson(res, 200, securityPublicStatus(config), {}, config);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/gateway/dashboard')) {
        sendHtml(res, 200, renderDashboardPage(), {}, config);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, {
          object: 'list',
          data: registry.openAIModels()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/models') {
        sendJson(res, 200, {
          models: registry.catalogModels({ includeAliases: true })
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/routing') {
        sendJson(res, 200, {
          aliases: config.aliases ?? {},
          defaults: config.defaults ?? {}
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/status') {
        const runtimeStatus = await runtimeManager.status();
        const clustered = Object.keys(config.cluster?.nodes ?? {}).length > 0;
        const localRuntimeStatus = clustered
          ? {
              runtimes: Object.fromEntries(
                Object.entries(runtimeStatus.runtimes ?? {}).filter(
                  ([, runtime]) => runtime.remote !== true && runtime.distributed !== true
                )
              ),
              events: runtimeStatus.events
            }
          : runtimeStatus;
        sendJson(res, 200, {
          ok: true,
          server: config.server,
          defaults: config.defaults,
          runtimeManager: runtimeStatus,
          cluster: await clusterCoordinator.status({ localRuntimeStatus })
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/node') {
        sendJson(res, 200, {
          ok: true,
          node: await clusterCoordinator.localNodeStatus()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/cluster') {
        sendJson(res, 200, {
          ok: true,
          cluster: await clusterCoordinator.status()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/runtimes/plan') {
        const runtimeStatus = await runtimeManager.status();
        runtimeStatus.cluster = await clusterCoordinator.status();
        sendJson(
          res,
          200,
          await createRuntimePolicyPlan(config, {
            requestedRuntimeId: firstQueryParam(url.searchParams, ['runtime', 'runtime_id', 'runtime-id']),
            status: runtimeStatus
          })
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/profile') {
        const profile = await profileMachine();
        const validationErrors = validateMachineProfile(profile);
        if (validationErrors.length) {
          sendJson(
            res,
            500,
            errorBody('generated machine profile is invalid', {
              code: 'internal_error',
              validationErrors
            })
          );
          return;
        }
        sendJson(res, 200, profile, {
          'content-type': `${MACHINE_PROFILE_MEDIA_TYPE}; charset=utf-8`
        });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/gateway/integrations' || url.pathname === '/v1/integrations')) {
        const manifest = buildClientIntegrationManifest(
          config,
          registry.clientModels({
            kinds: ['chat', 'audio_speech', 'audio_transcription', 'image', 'video', 'embedding']
          })
        );
        const validationErrors = validateClientIntegrationManifest(manifest);
        if (validationErrors.length) {
          sendJson(
            res,
            500,
            errorBody('generated client integrations manifest is invalid', {
              code: 'internal_error',
              validationErrors
            })
          );
          return;
        }
        sendJson(res, 200, manifest, {
          'content-type': `${CLIENT_INTEGRATIONS_MEDIA_TYPE}; charset=utf-8`
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/integrations/status') {
        sendJson(
          res,
          200,
          await createClientIntegrationStatus(config, registry, {
            clientId: firstQueryParam(url.searchParams, ['client', 'client_id', 'client-id']) ?? 'all',
            home: firstQueryParam(url.searchParams, ['home']) ?? process.env.HOME,
            generatedRoot: firstQueryParam(url.searchParams, ['generated_root', 'generated-root'])
          })
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/metrics') {
        const snapshot = metrics.snapshot({
          model: firstQueryParam(url.searchParams, ['model']),
          period: firstQueryParam(url.searchParams, ['period']) ?? 'all'
        });
        snapshot.host = await hostTelemetry.snapshot();
        sendJson(res, 200, snapshot);
        return;
      }

      const metricsModelMatch = url.pathname.match(/^\/gateway\/metrics\/models\/(.+)$/);
      if (req.method === 'GET' && metricsModelMatch) {
        sendJson(
          res,
          200,
          metrics.snapshot({
            model: decodeURIComponent(metricsModelMatch[1]),
            period: firstQueryParam(url.searchParams, ['period']) ?? 'all'
          })
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/setup/status') {
        const noRuntimes = queryBool(url.searchParams, ['no_runtimes', 'no-runtimes'], false);
        const runtimes = firstQueryParam(url.searchParams, ['runtimes']);
        const recipeId = firstQueryParam(url.searchParams, ['recipe', 'recipe_id', 'recipe-id']);
        const communityContext = await communityStatusContextFromQuery(config, url.searchParams, { recipeId });
        const status = await createSetupStatus(config, {
          recipeId: communityContext.recipeId ?? recipeId,
          modelRoot: firstQueryParam(url.searchParams, ['model_root', 'model-root']),
          clientId: firstQueryParam(url.searchParams, ['client', 'client_id', 'client-id']) ?? 'all',
          statePath: firstQueryParam(url.searchParams, ['state', 'state_path', 'state-path']),
          generatedRoot: firstQueryParam(url.searchParams, ['generated_root', 'generated-root']),
          home: firstQueryParam(url.searchParams, ['home']),
          recipesRoot:
            communityContext.recipesRoot ?? firstQueryParam(url.searchParams, ['recipes_root', 'recipes-root']),
          recipeDocuments: communityContext.recipeDocuments,
          backendCatalogPath:
            communityContext.backendCatalogPath ??
            firstQueryParam(url.searchParams, [
              'backend_catalog',
              'backend-catalog',
              'backend_catalog_path',
              'backend-catalog-path'
            ]),
          includeRuntimes:
            runtimes == null ? !noRuntimes : !['0', 'false', 'no', 'off'].includes(runtimes.toLowerCase())
        });
        const community = communityStatusSummary(communityContext);
        if (community) status.community = community;
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/doctor') {
        const options = doctorOptionsFromQuery(url.searchParams);
        const communityContext = await communityStatusContextFromQuery(config, url.searchParams, {
          recipeId: options.recipeId
        });
        const report = await createDoctorReport(config, {
          ...options,
          recipeId: communityContext.recipeId ?? options.recipeId,
          benchmarksRoot: communityContext.benchmarksRoot ?? options.benchmarksRoot,
          benchmarkDocuments: communityContext.benchmarkDocuments,
          recipesRoot: communityContext.recipesRoot ?? options.recipesRoot,
          recipeDocuments: communityContext.recipeDocuments,
          backendCatalogPath: communityContext.backendCatalogPath ?? options.backendCatalogPath
        });
        const community = communityStatusSummary(communityContext);
        if (community) report.community = community;
        sendJson(res, 200, report);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/onboarding/plan') {
        sendJson(res, 200, await createOnboardingPlan(config, onboardingOptionsFromQuery(config, url.searchParams)));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/library') {
        sendJson(res, 200, await createLibraryPlan(config, url.searchParams));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/community/recommendations') {
        try {
          sendJson(res, 200, await createCommunityPlan(config, communityOptionsFromQuery(config, url.searchParams)));
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/backends') {
        const catalog = await loadBackendCatalog();
        sendJson(res, 200, {
          catalog: {
            schemaVersion: catalog.schemaVersion,
            filePath: catalog.filePath,
            count: catalog.backends.length
          },
          backends: await planBackendCatalog(catalog, {
            checkCommands: true
          })
        });
        return;
      }

      const backendPlanMatch = url.pathname.match(/^\/gateway\/backends\/([^/]+)\/plan$/);
      if (req.method === 'GET' && backendPlanMatch) {
        const backendId = decodeURIComponent(backendPlanMatch[1]);
        const catalog = await loadBackendCatalog();
        const backend = getBackend(catalog, backendId);
        if (!backend) {
          sendJson(
            res,
            404,
            errorBody(`unknown backend: ${backendId}`, {
              code: 'not_found'
            })
          );
          return;
        }
        sendJson(
          res,
          200,
          await planBackend(backend, {
            checkCommands: true
          })
        );
        return;
      }

      const backendInstallMatch = url.pathname.match(/^\/gateway\/backends\/([^/]+)\/install$/);
      if (req.method === 'POST' && backendInstallMatch) {
        const backendId = decodeURIComponent(backendInstallMatch[1]);
        const body = await readJson(req);
        const catalog = await loadBackendCatalog();
        const backend = getBackend(catalog, backendId);
        if (!backend) {
          sendJson(
            res,
            404,
            errorBody(`unknown backend: ${backendId}`, {
              code: 'not_found'
            })
          );
          return;
        }
        try {
          sendJson(
            res,
            200,
            await applyBackend(backend, {
              dryRun: false,
              yes: body.yes === true,
              statePath: body.statePath ?? body.state_path,
              onlyStep: body.step ?? body.onlyStep ?? body.only_step,
              variables: backendVariablesFromBody(body)
            })
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/setup/plan') {
        sendJson(res, 200, await createSetupPlan(config, setupPlanOptionsFromQuery(url.searchParams)));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/onboarding/apply') {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await applyOnboarding(config, {
              ...setupOptionsFromBody(config, body),
              dryRun: false,
              yes: body.yes === true
            })
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/setup/apply') {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await applySetup(config, {
              ...setupOptionsFromBody(config, body),
              dryRun: false,
              yes: body.yes === true
            })
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/models/import-plan') {
        const body = await readJson(req);
        try {
          sendJson(res, 200, createModelImportPlan(config, modelImportOptionsFromBody(config, body)));
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/models/import') {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await applyModelImport(config, {
              ...modelImportOptionsFromBody(config, body),
              dryRun: false,
              yes: body.yes === true
            })
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/recipe-packs/plan') {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await createRecipePackPlan(recipePackSourceFromBody(body), config, recipePackOptionsFromBody(config, body))
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/recipe-packs/import') {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await applyRecipePack(recipePackSourceFromBody(body), config, {
              ...recipePackOptionsFromBody(config, body),
              dryRun: false,
              yes: body.yes === true
            })
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/community/import') {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await applyCommunityRecommendations(config, {
              ...communityOptionsFromBody(config, body),
              dryRun: false,
              yes: body.yes === true
            })
          );
        } catch (error) {
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/runtimes/stop-all') {
        sendJson(res, 200, await runtimeManager.stopAll());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/gateway/runtimes/keep-warm') {
        const body = await readJson(req);
        if (body.reloadConfig === true) {
          reloadConfig();
          await reloadInFlight;
        }
        sendJson(res, 200, {
          keepWarm: runtimeManager.keepWarmRuntimeIds(),
          results: await runRuntimeAdminAction(() => runtimeManager.startKeepWarm())
        });
        return;
      }

      const stopMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        sendJson(
          res,
          200,
          await runtimeManager.stop(decodeURIComponent(stopMatch[1]), {
            requestedBy: runtimeRequesterNode(req, config)
          })
        );
        return;
      }

      const startMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/start$/);
      if (req.method === 'POST' && startMatch) {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          await runRuntimeAdminAction(() =>
            runtimeManager.start(decodeURIComponent(startMatch[1]), {
              force: body.force !== false,
              warmup: body.warmup !== false,
              reason: 'admin-start',
              requestedBy: runtimeRequesterNode(req, config)
            })
          )
        );
        return;
      }

      const admitMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/admit$/);
      if (req.method === 'POST' && admitMatch) {
        const body = await readJson(req);
        try {
          sendJson(
            res,
            200,
            await runRuntimeAdminAction(() =>
              applyRuntimePolicyPlan(config, runtimeManager, {
                requestedRuntimeId: decodeURIComponent(admitMatch[1]),
                dryRun: body.apply !== true,
                yes: body.yes === true,
                force: body.force !== false,
                warmup: body.warmup !== false,
                reason: 'admin-admit',
                requesterNode: runtimeRequesterNode(req, config)
              })
            )
          );
        } catch (error) {
          if (error?.statusCode) throw error;
          sendJson(
            res,
            400,
            errorBody(error?.message ?? String(error), {
              code: 'bad_request'
            })
          );
        }
        return;
      }

      const warmupMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/warmup$/);
      if (req.method === 'POST' && warmupMatch) {
        sendJson(res, 200, await runtimeManager.warmupById(decodeURIComponent(warmupMatch[1])));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleOpenAIChat(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
        await handleOpenAIImages(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/images/edits') {
        await handleOpenAIImageEdits(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/videos/generations') {
        await handleOpenAIVideos(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        await handleOpenAIEmbeddings(req, res);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/v1/audio/voices' || url.pathname === '/gateway/audio/voices')) {
        await handleSpeechVoices(req, res, url);
        return;
      }

      if (
        req.method === 'GET' &&
        (url.pathname === '/v1/audio/speech/schema' || url.pathname === '/gateway/audio/speech/schema')
      ) {
        await handleSpeechSchema(req, res, url);
        return;
      }

      if (
        req.method === 'GET' &&
        (url.pathname === '/v1/audio/speech/models' ||
          url.pathname === '/v1/audio/models' ||
          url.pathname === '/gateway/audio/speech/models')
      ) {
        await handleSpeechCatalog(req, res);
        return;
      }

      if (
        req.method === 'GET' &&
        (url.pathname === '/v1/audio/transcriptions/schema' || url.pathname === '/gateway/audio/transcriptions/schema')
      ) {
        handleTranscriptionSchema(req, res, url);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
        await handleOpenAISpeech(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        await handleOpenAITranscription(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        await handleOpenAIResponses(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        await handleAnthropicMessages(req, res);
        return;
      }

      sendJson(
        res,
        404,
        errorBody(`unknown route: ${url.pathname}`, {
          code: 'not_found'
        })
      );
    } catch (error) {
      if (isClientClosedError(error) || req.aborted || (res.destroyed && !res.writableEnded)) {
        endResponseWithError(res, error, { stream: false, config, status: 499 });
        return;
      }
      if (error instanceof UnknownModelError) {
        sendJson(
          res,
          error.statusCode,
          errorBody(error.message, {
            code: error.code,
            model: error.modelId
          })
        );
        return;
      }
      if (error instanceof PromptTooLargeError) {
        sendJson(
          res,
          error.statusCode,
          errorBody(error.message, {
            type: error.type,
            code: error.code,
            model: error.model
          })
        );
        return;
      }
      if (error instanceof StructuredOutputError) {
        sendJson(
          res,
          error.statusCode,
          errorBody(error.message, {
            code: error.code
          })
        );
        return;
      }
      if (error instanceof RuntimeAdmissionError) {
        endResponseWithError(res, error, {
          stream: res.headersSent,
          config,
          status: error.statusCode
        });
        return;
      }
      logger.error?.(error);
      endResponseWithError(res, error, {
        stream: res.headersSent,
        config,
        status: errorStatusCode(error) || 500
      });
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (isClientClosedError(error) || req.aborted || (res.destroyed && !res.writableEnded)) {
        endResponseWithError(res, error, { stream: res.headersSent, config, status: 499 });
        return;
      }
      logger.error?.(error);
      // Never throw from the HTTP server callback — a second writeHead takes down the process.
      endResponseWithError(res, error, {
        stream: res.headersSent,
        config,
        status: 500
      });
    });
  });
  // Inference deadlines belong to the selected backend/runtime contract. The
  // Node server default (five minutes) otherwise severs healthy long-prefill
  // or long-generation requests before the configured upstream timeout.
  server.requestTimeout = 0;
  server.on('clientError', (error, socket) => {
    logger.error?.(error);
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      // ignore
    }
  });

  return {
    server,
    registry,
    runtimeManager,
    metrics,
    listen() {
      const bind = assertBindAllowed(config, { logger });
      if (!bind.ok) {
        return Promise.reject(new Error(bind.message));
      }
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          reject(error);
        };
        server.once('error', onError);
        server.listen(config.server.port, config.server.host, () => {
          server.off('error', onError);
          runtimeManager.startKeepWarm().catch((error) => logger.error?.(error));
          if (configPath) watchFile(configPath, { interval: 500 }, reloadConfig);
          resolve(server);
        });
      });
    },
    async close({ stopRuntimes = true, httpGraceMs = 5000 } = {}) {
      if (configPath) unwatchFile(configPath, reloadConfig);
      metrics.flush();
      let runtimeError = null;
      if (stopRuntimes) {
        try {
          await runtimeManager.stopAll();
        } catch (error) {
          runtimeError = error;
        }
      }
      await new Promise((resolve, reject) => {
        const forceClose = setTimeout(() => server.closeAllConnections?.(), Math.max(0, httpGraceMs));
        forceClose.unref?.();
        server.close((error) => {
          clearTimeout(forceClose);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
      });
      metrics.flush();
      if (runtimeError) throw runtimeError;
    }
  };
}
