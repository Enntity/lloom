#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8100/v1';
const DEFAULT_TIMEOUT_MS = 1_800_000;

function parseArgs(argv) {
  const flags = { case: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    const key = token.slice(2);
    if (key === 'case') flags.case.push(value);
    else flags[key] = value;
    index += 1;
  }
  return flags;
}

function apiKeyFor(flags) {
  if (flags['api-key-env']) return process.env[flags['api-key-env']] || '';
  if (process.env.LLOOM_API_KEY) return process.env.LLOOM_API_KEY;
  if (!flags.config) return '';
  const config = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
  const key = Array.isArray(config.security?.apiKeys) ? config.security.apiKeys[0] : '';
  return typeof key === 'string' && !key.startsWith('${') ? key : '';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function appendToolDeltas(target, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : 0;
    target[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
    const call = target[index];
    if (delta.id) call.id += delta.id;
    if (delta.type) call.type = delta.type;
    if (delta.function?.name) call.function.name += delta.function.name;
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
  }
}

function exactToolAssessment(testCase, toolCalls) {
  if (!testCase.expectedTool) return null;
  let args = null;
  try {
    args = JSON.parse(toolCalls[0]?.function?.arguments ?? '');
  } catch {
    // Invalid JSON is itself a benchmark result.
  }
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  return {
    callCount: toolCalls.length,
    name: toolCalls[0]?.function?.name ?? null,
    arguments: args,
    validJson: args != null,
    exactMatch:
      toolCalls.length === 1 &&
      toolCalls[0]?.function?.name === testCase.expectedTool.name &&
      JSON.stringify(canonical(args)) === JSON.stringify(canonical(testCase.expectedTool.arguments))
  };
}

async function streamRequest({ baseUrl, apiKey, model, testCase, timeoutMs, warmup = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const request = warmup
    ? {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        temperature: 0,
        max_tokens: 8,
        stream: true,
        stream_options: { include_usage: true }
      }
    : {
        model,
        messages: [
          { role: 'system', content: testCase.system },
          { role: 'user', content: testCase.user }
        ],
        temperature: 0,
        seed: 73,
        stream: true,
        stream_options: { include_usage: true },
        ...(testCase.tools ? { tools: testCase.tools, tool_choice: testCase.toolChoice ?? 'auto' } : {})
      };

  const startedAt = new Date().toISOString();
  const started = performance.now();
  let headersMs = null;
  let firstByteMs = null;
  let firstTokenMs = null;
  let completedMs = null;
  let usage = null;
  let responseModel = null;
  let provider = null;
  let finishReason = null;
  let content = '';
  let reasoningContent = '';
  const toolCalls = [];
  const responseHeaders = {};
  let eventCount = 0;

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'x-lloom-client': 'LLooM-Local-Decision-Benchmark'
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    headersMs = performance.now() - started;
    for (const [key, value] of response.headers.entries()) {
      if (key.startsWith('x-lloom') || ['content-type', 'server'].includes(key)) responseHeaders[key] = value;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 2000)}`);
    }
    if (!response.body) throw new Error('streaming response has no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const read = await reader.read();
      if (read.value?.byteLength && firstByteMs == null) firstByteMs = performance.now() - started;
      buffer += decoder.decode(read.value ?? new Uint8Array(), { stream: !read.done });
      done = read.done;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        eventCount += 1;
        responseModel ??= event.model ?? null;
        provider ??= event.provider ?? event.lloom?.provider ?? null;
        usage = event.usage ?? usage;
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        const semantic = Boolean(delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length);
        if (semantic && firstTokenMs == null) firstTokenMs = performance.now() - started;
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
        else if (typeof delta.reasoning === 'string') reasoningContent += delta.reasoning;
        appendToolDeltas(toolCalls, delta.tool_calls);
      }
    }
    completedMs = performance.now() - started;
    const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;
    const generationSeconds = firstTokenMs == null ? null : Math.max(0.001, (completedMs - firstTokenMs) / 1000);
    return {
      ok: true,
      caseId: warmup ? 'admission-warmup' : testCase.id,
      title: warmup ? 'Cold admission and warmup' : testCase.title,
      startedAt,
      requestShape: {
        stream: true,
        maxTokens: warmup ? 8 : 'omitted',
        reasoning: 'omitted',
        toolChoice: request.tool_choice ?? null
      },
      timing: {
        headersMs: Math.round(headersMs),
        firstByteMs: firstByteMs == null ? null : Math.round(firstByteMs),
        firstTokenMs: firstTokenMs == null ? null : Math.round(firstTokenMs),
        completedMs: Math.round(completedMs),
        generationMs: generationSeconds == null ? null : Math.round(generationSeconds * 1000),
        completionTokens,
        tokensPerSecond: completionTokens == null || generationSeconds == null ? null : Number((completionTokens / generationSeconds).toFixed(2))
      },
      responseModel,
      provider,
      responseHeaders,
      eventCount,
      finishReason,
      usage,
      message: { content, reasoning_content: reasoningContent, tool_calls: toolCalls },
      toolAssessment: exactToolAssessment(testCase, toolCalls),
      rubric: testCase.rubric ?? null
    };
  } catch (error) {
    return {
      ok: false,
      caseId: warmup ? 'admission-warmup' : testCase.id,
      title: warmup ? 'Cold admission and warmup' : testCase.title,
      startedAt,
      timing: {
        headersMs: headersMs == null ? null : Math.round(headersMs),
        firstByteMs: firstByteMs == null ? null : Math.round(firstByteMs),
        firstTokenMs: firstTokenMs == null ? null : Math.round(firstTokenMs),
        completedMs: Math.round(performance.now() - started)
      },
      error: controller.signal.reason?.message ?? error?.message ?? String(error),
      responseHeaders
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.model) throw new Error('use --model LOCAL_MODEL_ID');
  if (!flags.suite) throw new Error('use --suite PATH');
  if (!flags.output) throw new Error('use --output PATH');
  const suitePath = path.resolve(flags.suite);
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  const selected = flags.case.length ? suite.cases.filter((entry) => flags.case.includes(entry.id)) : suite.cases;
  if (!selected.length) throw new Error('no benchmark cases selected');
  const baseUrl = flags['base-url'] || DEFAULT_BASE_URL;
  const apiKey = apiKeyFor(flags);
  const timeoutMs = positiveInteger(flags['timeout-ms'], DEFAULT_TIMEOUT_MS);

  const warmup = await streamRequest({ baseUrl, apiKey, model: flags.model, testCase: {}, timeoutMs, warmup: true });
  process.stderr.write(`${flags.model} admission: ${warmup.ok ? `${warmup.timing.completedMs}ms` : warmup.error}\n`);
  if (!warmup.ok) throw new Error(`model admission failed: ${warmup.error}`);

  const results = [];
  for (const testCase of selected) {
    const result = await streamRequest({ baseUrl, apiKey, model: flags.model, testCase, timeoutMs });
    results.push(result);
    process.stderr.write(
      `${flags.model} ${testCase.id}: ${result.ok ? `TTFB=${result.timing.firstByteMs}ms TTFT=${result.timing.firstTokenMs}ms ${result.timing.tokensPerSecond ?? '?'} tok/s` : result.error}\n`
    );
  }

  const artifact = {
    schemaVersion: 1,
    kind: 'lloom-local-decision-benchmark',
    generatedAt: new Date().toISOString(),
    gateway: baseUrl,
    model: flags.model,
    suite: { id: suite.id, version: suite.version, path: suitePath },
    measurement: {
      ttfb: 'request start to first SSE response-body byte',
      ttft: 'request start to first non-empty content, reasoning, or tool-call delta',
      tokensPerSecond: 'provider completion_tokens divided by wall time from first semantic delta to stream completion',
      qualitativeMaxTokens: 'omitted',
      reasoningControl: 'omitted'
    },
    admissionWarmup: warmup,
    results
  };
  fs.mkdirSync(path.dirname(path.resolve(flags.output)), { recursive: true });
  fs.writeFileSync(path.resolve(flags.output), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.resolve(flags.output), model: flags.model, cases: results.length }, null, 2));
}

await main();
