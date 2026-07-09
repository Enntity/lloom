import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
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
import { defaultLloomHome } from './config.mjs';
import { createDoctorReport } from './doctor.mjs';
import { MACHINE_PROFILE_MEDIA_TYPE, profileMachine, rankRecipes, validateMachineProfile } from './machine-profile.mjs';
import { applyModelImport, createModelImportPlan } from './model-intake.mjs';
import { applyOnboarding, createOnboardingPlan } from './onboarding.mjs';
import { applyRecipePack, createRecipePackPlan } from './recipe-pack.mjs';
import { buildRecipeIndexReport } from './recipe-index.mjs';
import { loadRecipes } from './recipes.mjs';
import { createRegistry, UnknownModelError } from './registry.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { applyRuntimePolicyPlan, createRuntimePolicyPlan } from './runtime-policy.mjs';
import { applySetup, createSetupPlan } from './setup.mjs';
import { createSetupStatus } from './setup-status.mjs';
import { renderDashboardPage } from './dashboard.mjs';
import { applyBackend } from './installer.mjs';
import {
  anthropicMessagesToOpenAI,
  encodeSseBlock,
  metricUsageFromOpenAI,
  normalizeOpenAIChatCompletionBody,
  normalizeOpenAIChatCompletionChunk,
  normalizeOpenAIChatRequestBody,
  openAIStreamChunkHasContent,
  openAIToAnthropic,
  openAIToResponses,
  parseSseBlock,
  readSseEvents,
  responsesToOpenAIChat,
  rewriteJsonModelText,
  streamAnthropicFromOpenAI,
  streamResponsesFromOpenAI,
  usageFromJsonBuffer,
  usageFromJsonText
} from './protocol/index.mjs';
import { assertBindAllowed, authorizeRequest, corsHeaders, securityPublicStatus } from './security.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
const SSE_TYPE = 'text/event-stream; charset=utf-8';

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
      return sendJson(res, status, errorBody(message, { type, code, model: error?.model }), {}, config);
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

function estimateMessageTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 3.5);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateMessageTokens(item), 0);
  if (typeof value === 'object') {
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

function estimateRequestPromptTokens(body = {}) {
  const parts = [
    body.messages,
    body.input,
    body.instructions,
    body.system,
    body.prompt
  ];
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
    numberOrNull(model.maxPromptTokens) ??
    numberOrNull(model.safeContextWindow) ??
    numberOrNull(model.contextWindow);
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

function isClientClosedError(error) {
  return error instanceof ClientClosedError || error?.name === 'ClientClosedError' || error?.code === 'client_closed';
}

function clientClosedStatus(error) {
  return isClientClosedError(error) ? 499 : 0;
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
  return {
    markFirstContent() {
      if (firstContentMs == null) firstContentMs = Date.now() - startedAt;
      return firstContentMs;
    },
    get firstContentMs() {
      return firstContentMs;
    }
  };
}

function markFirstContent(timing) {
  return timing?.markFirstContent?.();
}

function createMetricsStore({ maxRecent = 200 } = {}) {
  const recent = [];
  const totals = emptyMetricBucket('all');
  const models = new Map();
  const routes = new Map();

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
      bucket.generationDurationMs += Math.max(0, entry.durationMs - entry.firstContentMs);
    }
    bucket.inputTokens += entry.usage?.input_tokens ?? 0;
    bucket.outputTokens += entry.usage?.output_tokens ?? 0;
    bucket.totalTokens += entry.usage?.total_tokens ?? 0;
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
    record(raw) {
      const entry = {
        at: new Date().toISOString(),
        route: raw.route,
        model: raw.model,
        requestedModel: raw.requestedModel,
        upstreamModel: raw.upstreamModel,
        kind: raw.kind,
        backend: raw.backend,
        runtime: raw.runtime,
        status: raw.status ?? 0,
        ok: raw.ok === true,
        stream: raw.stream === true,
        durationMs: raw.durationMs ?? 0,
        firstContentMs: raw.firstContentMs ?? null,
        responseBytes: raw.responseBytes ?? 0,
        usage: raw.usage ?? null,
        error: raw.error
      };
      recent.push(entry);
      if (recent.length > maxRecent) recent.shift();
      apply(totals, entry);
      if (entry.model) apply(bucketFor(models, entry.model), entry);
      if (entry.route) apply(bucketFor(routes, entry.route), entry);
    },
    snapshot({ model } = {}) {
      const selectedModel = model ? (models.get(model) ?? null) : null;
      return {
        object: 'gateway.metrics',
        generatedAt: new Date().toISOString(),
        totals: finalizeMetricBucket(totals),
        models: model
          ? selectedModel
            ? [finalizeMetricBucket(selectedModel)]
            : []
          : [...models.values()].map(finalizeMetricBucket).sort((a, b) => a.id.localeCompare(b.id)),
        routes: [...routes.values()].map(finalizeMetricBucket).sort((a, b) => a.id.localeCompare(b.id)),
        recent: recent.filter((entry) => !model || entry.model === model).slice(-50)
      };
    }
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
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    last: null
  };
}

function finalizeMetricBucket(bucket) {
  const durationSeconds = bucket.durationMs / 1000;
  const generationSeconds = bucket.generationDurationMs / 1000;
  return {
    ...bucket,
    avgDurationMs: bucket.requests ? Number((bucket.durationMs / bucket.requests).toFixed(2)) : 0,
    avgFirstContentMs: bucket.firstContentCount
      ? Number((bucket.firstContentMs / bucket.firstContentCount).toFixed(2))
      : null,
    outputTokensPerSecond: durationSeconds > 0 ? Number((bucket.outputTokens / durationSeconds).toFixed(2)) : 0,
    decodeTokensPerSecond: generationSeconds > 0 ? Number((bucket.outputTokens / generationSeconds).toFixed(2)) : 0
  };
}

async function fetchUpstream({ backend, path, body, headers = {}, signal }) {
  const timeoutMs = backend.timeoutMs ?? 1800000;
  const fetchSignal = upstreamSignal(signal, timeoutMs);
  try {
    return await fetch(upstreamUrl(backend, path), {
      method: 'POST',
      headers: backendHeaders(backend, headers),
      body: JSON.stringify(body),
      signal: fetchSignal
    });
  } catch (error) {
    throw normalizeAbortError(error, fetchSignal, timeoutMs);
  }
}

async function fetchRawUpstream({ backend, path, body, headers = {}, signal }) {
  const timeoutMs = backend.timeoutMs ?? 1800000;
  const fetchSignal = upstreamSignal(signal, timeoutMs);
  try {
    return await fetch(upstreamUrl(backend, path), {
      method: 'POST',
      headers: backendHeaders(backend, headers),
      body,
      signal: fetchSignal
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

async function proxyOpenAIChatResponse(res, upstream, requestedModel, { signal, timing, corsConfig } = {}) {
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
  res.end(output);
  return {
    status: upstream.status,
    stream: false,
    responseBytes: output.length,
    usage
  };
}

async function proxyOpenAIChatStream(res, upstream, requestedModel, { signal, timing, corsConfig } = {}) {
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
      const dataText =
        value && typeof value === 'object' ? JSON.stringify(value) : rewritten.text;
      output = encodeSseBlock({
        ...event,
        data: dataText
      });
    } else {
      output = encodeSseBlock(event);
    }
    responseBytes += Buffer.byteLength(output);
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

export function createLloomServer(
  config,
  { logger = console, runtimeManager = new RuntimeManager(config, { logger }) } = {}
) {
  const registry = createRegistry(config);
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

  const baseMetrics = createMetricsStore();
  const metrics = {
    record(entry) {
      baseMetrics.record(entry);
      appendRequestLog({
        route: entry.route,
        model: entry.requestedModel ?? entry.model,
        status: entry.status,
        durationMs: entry.durationMs,
        firstContentMs: entry.firstContentMs,
        stream: entry.stream === true,
        error: entry.ok === false ? (entry.error ?? entry.status) : undefined
      });
    },
    snapshot(...args) {
      return baseMetrics.snapshot(...args);
    }
  };

  async function ensureRuntime(runtimeId) {
    if (!runtimeId) return { runtimeId, started: false, reason: 'no-runtime' };
    if (config.runtimePolicy?.autoEvict === true) {
      return applyRuntimePolicyPlan(config, runtimeManager, {
        requestedRuntimeId: runtimeId,
        dryRun: false,
        yes: true,
        warmup: true,
        force: false,
        reason: 'model-request'
      });
    }
    return runtimeManager.ensure(runtimeId);
  }

  async function recordModelRequest({ route, resolved, stream, req, res }, fn) {
    const started = Date.now();
    const timing = createResponseTiming(started);
    const client = createClientCloseTracker(req, res);
    try {
      const result = await runtimeManager.withSlot(resolved.model.runtime, () =>
        fn({
          signal: client.signal,
          timing
        })
      );
      const status = result?.status ?? 200;
      metrics.record({
        route,
        model: resolved.model.id,
        requestedModel: resolved.requestedId,
        upstreamModel: resolved.model.upstreamModel,
        kind: resolved.model.kind ?? 'chat',
        backend: resolved.model.backend,
        runtime: resolved.model.runtime,
        status,
        ok: status >= 200 && status < 400,
        stream: result?.stream ?? stream,
        durationMs: Date.now() - started,
        firstContentMs: result?.firstContentMs ?? timing.firstContentMs,
        responseBytes: result?.responseBytes ?? 0,
        usage: result?.usage ?? null
      });
      return result;
    } catch (error) {
      const status = client.closed
        ? 499
        : clientClosedStatus(error) ||
          (error instanceof PromptTooLargeError ? error.statusCode : 0) ||
          502;
      metrics.record({
        route,
        model: resolved.model.id,
        requestedModel: resolved.requestedId,
        upstreamModel: resolved.model.upstreamModel,
        kind: resolved.model.kind ?? 'chat',
        backend: resolved.model.backend,
        runtime: resolved.model.runtime,
        status,
        ok: false,
        stream,
        durationMs: Date.now() - started,
        firstContentMs: timing.firstContentMs,
        error: error?.message ?? String(error)
      });
      if (status === 499 || isClientClosedError(error)) {
        endResponseWithError(res, error, { stream, config, status: 499 });
        return {
          status: 499,
          stream,
          responseBytes: 0,
          usage: null
        };
      }
      // Upstream death mid-stream (Metal abort, connection reset): finish SSE/JSON without
      // rethrowing into the outer handler (which would try writeHead again and crash Node).
      if (res.headersSent || stream) {
        endResponseWithError(res, error, {
          stream: true,
          config,
          status: error instanceof PromptTooLargeError ? 400 : 502
        });
        return {
          status: error instanceof PromptTooLargeError ? 400 : 502,
          stream: true,
          responseBytes: 0,
          usage: null,
          error: error?.message ?? String(error)
        };
      }
      throw error;
    } finally {
      client.dispose();
    }
  }

  async function handleOpenAIChat(req, res) {
    const body = await readJson(req);
    const resolved = registry.resolve(body.model ?? config.defaults?.chatModel);
    if ((resolved.model.kind ?? 'chat') !== 'chat') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not a chat model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      );
      return;
    }
    try {
      assertPromptWithinBudget(resolved, body, { logger });
    } catch (error) {
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
      throw error;
    }
    await recordModelRequest(
      {
        route: '/v1/chat/completions',
        resolved,
        stream: body.stream === true,
        req,
        res
      },
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
        // Normalize history so reasoning_content is OpenAI-shaped before MTPLX render.
        const normalizedRequest = normalizeOpenAIChatRequestBody(body);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/chat/completions',
          signal,
          body: {
            ...normalizedRequest,
            model: resolved.model.upstreamModel
          }
        });
        if (!upstream.ok && body.stream === true) {
          // Avoid opening an SSE response for an already-failed upstream.
          const text = await upstream.text();
          let message = text;
          try {
            message = JSON.parse(text)?.error?.message ?? text;
          } catch {
            // keep raw
          }
          throw Object.assign(new Error(message || `upstream status ${upstream.status}`), {
            code: 'upstream_error',
            statusCode: upstream.status
          });
        }
        return body.stream === true
          ? proxyOpenAIChatStream(res, upstream, resolved.requestedId, { signal, timing, corsConfig: config })
          : proxyOpenAIChatResponse(res, upstream, resolved.requestedId, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAIImages(req, res) {
    const body = await readJson(req);
    const modelId = body.model ?? config.defaults?.imageModel;
    const resolved = registry.resolve(modelId);
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
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/images/generations',
          signal,
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
    const resolved = registry.resolve(modelId);
    if ((resolved.model.kind ?? 'chat') !== 'embedding') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not an embedding model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      );
      return;
    }
    await recordModelRequest(
      {
        route: '/v1/embeddings',
        resolved,
        stream: false,
        req,
        res
      },
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/embeddings',
          signal,
          body: {
            ...body,
            model: resolved.model.upstreamModel
          }
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  async function handleOpenAISpeech(req, res) {
    const body = await readJson(req);
    const modelId = body.model ?? config.defaults?.speechModel;
    if (!modelId) {
      sendJson(
        res,
        400,
        errorBody('speech request requires model', {
          code: 'missing_model'
        })
      );
      return;
    }
    const resolved = registry.resolve(modelId);
    if ((resolved.model.kind ?? 'chat') !== 'audio_speech') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not a speech model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
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
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/audio/speech',
          signal,
          body: {
            ...body,
            model: resolved.model.upstreamModel
          }
        });
        return proxyRawResponse(res, upstream, { signal, timing, corsConfig: config });
      }
    );
  }

  function resolveTranscriptionModel(modelId) {
    if (!modelId) {
      return {
        error: errorBody('transcription request requires model', {
          code: 'missing_model'
        })
      };
    }
    const resolved = registry.resolve(modelId);
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
      const { resolved, error } = resolveTranscriptionModel(body.model ?? config.defaults?.transcriptionModel);
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
        async ({ signal, timing }) => {
          await ensureRuntime(resolved.model.runtime);
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
    const { resolved, error } = resolveTranscriptionModel(modelId);
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
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
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
    const resolved = registry.resolve(body.model ?? config.defaults?.chatModel);
    if ((resolved.model.kind ?? 'chat') !== 'chat') {
      sendJson(
        res,
        400,
        errorBody(`model ${resolved.requestedId} is not a chat model`, {
          code: 'wrong_model_kind',
          model: resolved.requestedId
        })
      );
      return;
    }
    await recordModelRequest(
      {
        route: '/v1/responses',
        resolved,
        stream: body.stream === true,
        req,
        res
      },
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/chat/completions',
          signal,
          body: responsesToOpenAIChat(body, resolved)
        });
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
        const responseJson = JSON.parse(text);
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
    const resolved = registry.resolve(body.model ?? config.defaults?.chatModel);
    await recordModelRequest(
      {
        route: '/v1/messages',
        resolved,
        stream: body.stream === true,
        req,
        res
      },
      async ({ signal, timing }) => {
        await ensureRuntime(resolved.model.runtime);
        const upstream = await fetchUpstream({
          backend: resolved.backend,
          path: '/v1/chat/completions',
          signal,
          body: anthropicMessagesToOpenAI(body, resolved)
        });
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
        sendJson(res, 200, {
          ok: true,
          server: config.server,
          defaults: config.defaults,
          runtimeManager: await runtimeManager.status()
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/gateway/runtimes/plan') {
        sendJson(
          res,
          200,
          await createRuntimePolicyPlan(config, {
            requestedRuntimeId: firstQueryParam(url.searchParams, ['runtime', 'runtime_id', 'runtime-id']),
            status: await runtimeManager.status()
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
        const manifest = buildClientIntegrationManifest(config, registry.clientModels({ kinds: ['chat'] }));
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
        sendJson(
          res,
          200,
          metrics.snapshot({
            model: firstQueryParam(url.searchParams, ['model'])
          })
        );
        return;
      }

      const metricsModelMatch = url.pathname.match(/^\/gateway\/metrics\/models\/(.+)$/);
      if (req.method === 'GET' && metricsModelMatch) {
        sendJson(
          res,
          200,
          metrics.snapshot({
            model: decodeURIComponent(metricsModelMatch[1])
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

      const stopMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        sendJson(res, 200, await runtimeManager.stop(decodeURIComponent(stopMatch[1])));
        return;
      }

      const startMatch = url.pathname.match(/^\/gateway\/runtimes\/([^/]+)\/start$/);
      if (req.method === 'POST' && startMatch) {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          await runtimeManager.start(decodeURIComponent(startMatch[1]), {
            force: body.force !== false,
            warmup: body.warmup !== false,
            reason: 'admin-start'
          })
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
            await applyRuntimePolicyPlan(config, runtimeManager, {
              requestedRuntimeId: decodeURIComponent(admitMatch[1]),
              dryRun: body.apply !== true,
              yes: body.yes === true,
              force: body.force !== false,
              warmup: body.warmup !== false,
              reason: 'admin-admit'
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

      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        await handleOpenAIEmbeddings(req, res);
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
      logger.error?.(error);
      endResponseWithError(res, error, {
        stream: res.headersSent,
        config,
        status: 500
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
          resolve(server);
        });
      });
    }
  };
}
