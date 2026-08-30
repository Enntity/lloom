#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8100/v1';
const DEFAULT_PROFILES = [
  { name: 'presence-long', promptBytes: 220_000, offsetMs: 0 },
  { name: 'cognition-medium', promptBytes: 160_000, offsetMs: 20_000 },
  { name: 'followup-short', promptBytes: 80_000, offsetMs: 40_000 }
];

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function resolveApiKey(flags) {
  if (flags['api-key-env']) return process.env[flags['api-key-env']] || '';
  if (process.env.LLOOM_API_KEY) return process.env.LLOOM_API_KEY;
  if (!flags.config) return '';
  const config = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
  return Array.isArray(config.security?.apiKeys) ? config.security.apiKeys[0] || '' : '';
}

function parseProfiles(value) {
  if (!value) return DEFAULT_PROFILES;
  return value.split(',').map((entry) => {
    const [name, bytesValue, offsetValue] = entry.split(':');
    const promptBytes = positiveInteger(bytesValue, 0);
    const offsetMs = Number(offsetValue);
    if (!name || !promptBytes || !Number.isInteger(offsetMs) || offsetMs < 0) {
      throw new Error(`invalid profile ${entry}; expected NAME:PROMPT_BYTES:OFFSET_MS`);
    }
    return { name, promptBytes, offsetMs };
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function syntheticMessages(profile, runId) {
  const header = [
    `Synthetic entity workload ${runId}/${profile.name}.`,
    'No private entity content, memories, messages, or continuity state are present.',
    'Act as a persistent entity runtime performing one Presence cognition cycle.',
    'Reconcile the supplied continuity, observations, commitments, and tool contracts.',
    'Finish by calling report_presence with state set to steady.'
  ].join('\n');
  const vocabulary =
    'continuity observation relationship commitment provenance temporal grounding working memory durable memory conversation context task queue reflection plan uncertainty calm recovery service availability tool result ';
  let context = `${header}\n\n[continuity]\n`;
  for (let index = 0; Buffer.byteLength(context) < profile.promptBytes; index += 1) {
    const section = ['continuity', 'observations', 'commitments', 'recent-events', 'working-set'][index % 5];
    context += `[${section}:${String(index).padStart(6, '0')}] ${vocabulary}${profile.name} ${runId}\n`;
  }
  context = Buffer.from(context).subarray(0, profile.promptBytes).toString();
  return [
    { role: 'system', content: context },
    { role: 'user', content: 'Perform this synthetic Presence cycle and report the stable result.' }
  ];
}

function syntheticTools() {
  return Array.from({ length: 16 }, (_, index) => {
    const name = index === 0 ? 'report_presence' : `synthetic_runtime_tool_${index}`;
    return {
      type: 'function',
      function: {
        name,
        description:
          index === 0
            ? 'Report the outcome of this synthetic entity Presence cycle.'
            : 'Representative unavailable runtime capability included only for schema load.',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['steady'] },
            note: { type: 'string' }
          },
          required: ['state'],
          additionalProperties: false
        }
      }
    };
  });
}

function contentFromChunk(value) {
  const delta = value?.choices?.[0]?.delta || {};
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  return {
    chars: String(delta.content || '').length + String(delta.reasoning_content || '').length,
    toolDelta: toolCalls.some((call) => call?.function?.name || call?.function?.arguments)
  };
}

async function runOne(options) {
  const { index, profile, suiteStarted, baseUrl, model, apiKey, runId } = options;
  await sleep(Math.max(0, suiteStarted + profile.offsetMs - Date.now()));
  const started = Date.now();
  const controller = new AbortController();
  let firstContentAt = null;
  let responseBytes = 0;
  let toolDeltaSeen = false;
  let finishReason = null;
  let usage = null;
  let firstTimer = setTimeout(
    () => controller.abort(new Error(`no model content after ${options.firstContentTimeoutMs}ms`)),
    options.firstContentTimeoutMs
  );
  const totalTimer = setTimeout(
    () => controller.abort(new Error(`request exceeded ${options.totalTimeoutMs}ms`)),
    options.totalTimeoutMs
  );
  firstTimer.unref?.();
  totalTimer.unref?.();

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'x-lloom-client': 'LLooM-Entity-Stagger-Benchmark'
      },
      body: JSON.stringify({
        model,
        messages: syntheticMessages(profile, runId),
        tools: syntheticTools(),
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
        max_tokens: options.maxTokens,
        reasoning_effort: 'low',
        chat_template_kwargs: { enable_thinking: true }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      let code = null;
      try {
        code = JSON.parse(body)?.error?.code || null;
      } catch {}
      return {
        index,
        profile: profile.name,
        ok: false,
        arrivalOffsetMs: started - suiteStarted,
        durationMs: Date.now() - started,
        httpStatus: response.status,
        retryAfter: response.headers.get('retry-after'),
        code,
        error: body
      };
    }
    if (!response.body) throw new Error('gateway returned no response body');

    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of response.body) {
      responseBytes += chunk.byteLength;
      pending += decoder.decode(chunk, { stream: true });
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() || '';
      for (const block of blocks) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const value = JSON.parse(data);
          if (value?.usage) usage = value.usage;
          const content = contentFromChunk(value);
          if ((content.chars > 0 || content.toolDelta) && firstContentAt == null) {
            firstContentAt = Date.now();
            clearTimeout(firstTimer);
            firstTimer = null;
          }
          toolDeltaSeen ||= content.toolDelta;
          finishReason = value?.choices?.[0]?.finish_reason || finishReason;
        }
      }
    }
    if (firstContentAt == null) throw new Error('stream completed without content, reasoning, or tool-call deltas');
    const ended = Date.now();
    const completionTokens = Number(usage?.completion_tokens || 0);
    const decodeMs = Math.max(1, ended - firstContentAt);
    return {
      index,
      profile: profile.name,
      ok: true,
      requestedPromptBytes: profile.promptBytes,
      arrivalOffsetMs: started - suiteStarted,
      firstContentMs: firstContentAt - started,
      durationMs: ended - started,
      decodeMs,
      promptTokens: Number(usage?.prompt_tokens || 0),
      completionTokens,
      completionTokensPerSecond: (completionTokens * 1000) / decodeMs,
      responseBytes,
      toolDeltaSeen,
      finishReason
    };
  } catch (error) {
    return {
      index,
      profile: profile.name,
      ok: false,
      arrivalOffsetMs: started - suiteStarted,
      durationMs: Date.now() - started,
      responseBytes,
      error: controller.signal.reason?.message || error?.message || String(error)
    };
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

function metricValue(text, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...text.matchAll(new RegExp(`^${escaped}(?:\\{[^\\n]*\\})?\\s+([0-9.eE+-]+)$`, 'gm'))];
    if (matches.length) return matches.reduce((sum, match) => sum + Number(match[1]), 0);
  }
  return null;
}

async function backendMetrics(url) {
  if (!url) return null;
  const text = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`backend metrics returned HTTP ${response.status}`);
    return response.text();
  });
  return {
    running: metricValue(text, ['sglang:num_running_reqs', 'vllm:num_requests_running']),
    waiting: metricValue(text, ['sglang:num_queue_reqs', 'vllm:num_requests_waiting']),
    promptTokens: metricValue(text, ['sglang:prompt_tokens_total', 'vllm:prompt_tokens_total']),
    generationTokens: metricValue(text, ['sglang:generation_tokens_total', 'vllm:generation_tokens_total'])
  };
}

async function waitForIdle(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await backendMetrics(url);
  while (metrics && (metrics.running !== 0 || metrics.waiting !== 0) && Date.now() < deadline) {
    await sleep(250);
    metrics = await backendMetrics(url);
  }
  return metrics;
}

async function sampleGateway({ url, runtimeId, apiKey, isDone }) {
  if (!url || !runtimeId) return null;
  const samples = [];
  while (!isDone()) {
    try {
      const response = await fetch(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const runtime = body?.runtimeManager?.runtimes?.[runtimeId];
      if (runtime) {
        samples.push({
          at: Date.now(),
          healthy: runtime.healthy === true,
          status: runtime.status || null,
          active: Number(runtime.activeRequests || 0),
          queued: Number(runtime.queuedRequests || 0),
          admissionQueued: Number(runtime.admissionQueuedRequests || 0)
        });
      }
    } catch (error) {
      samples.push({ at: Date.now(), error: error?.message || String(error) });
    }
    await sleep(250);
  }
  const valid = samples.filter((sample) => !sample.error);
  return {
    samples: samples.length,
    errors: samples.length - valid.length,
    maxActive: Math.max(0, ...valid.map((sample) => sample.active)),
    maxQueued: Math.max(0, ...valid.map((sample) => sample.queued)),
    maxAdmissionQueued: Math.max(0, ...valid.map((sample) => sample.admissionQueued)),
    statuses: [...new Set(valid.map((sample) => `${sample.status}/${sample.healthy}`))]
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const model = flags.model;
  if (!model) throw new Error('use --model MODEL_ID');
  const profiles = parseProfiles(flags.profiles);
  const apiKey = resolveApiKey(flags);
  const baseUrl = flags['base-url'] || DEFAULT_BASE_URL;
  const gatewayStatusUrl =
    flags['gateway-status-url'] || `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/gateway/status`;
  const options = {
    baseUrl,
    model,
    apiKey,
    runId: flags['run-id'] || `${Date.now()}-${process.pid}`,
    maxTokens: positiveInteger(flags['max-tokens'], 384),
    firstContentTimeoutMs: positiveInteger(flags['first-content-timeout-ms'], 600_000),
    totalTimeoutMs: positiveInteger(flags['total-timeout-ms'], 900_000)
  };
  const metricsUrl = flags['backend-metrics-url'] || null;
  const before = await backendMetrics(metricsUrl);
  if (before && (before.running !== 0 || before.waiting !== 0)) {
    throw new Error(`backend is not idle before benchmark: ${JSON.stringify(before)}`);
  }

  const suiteStarted = Date.now();
  let done = false;
  const gatewayPromise = sampleGateway({
    url: gatewayStatusUrl,
    runtimeId: flags.runtime,
    apiKey,
    isDone: () => done
  });
  const results = await Promise.all(
    profiles.map((profile, index) => runOne({ ...options, index, profile, suiteStarted }))
  );
  done = true;
  const gateway = await gatewayPromise;
  const ended = Date.now();
  const after = await waitForIdle(metricsUrl);
  const promptTokens = results.reduce((sum, result) => sum + Number(result.promptTokens || 0), 0);
  const completionTokens = results.reduce((sum, result) => sum + Number(result.completionTokens || 0), 0);
  const pass =
    results.every((result) => result.ok && result.promptTokens > 0 && result.completionTokens > 0) &&
    (!after || (after.running === 0 && after.waiting === 0)) &&
    (!before || !after || after.generationTokens > before.generationTokens);
  console.log(
    JSON.stringify(
      {
        pass,
        runId: options.runId,
        model,
        runtime: flags.runtime || null,
        profiles,
        maxTokens: options.maxTokens,
        makespanMs: ended - suiteStarted,
        promptTokens,
        completionTokens,
        aggregateCompletionTokensPerSecond: (completionTokens * 1000) / Math.max(1, ended - suiteStarted),
        results,
        gateway,
        backend: before && after ? { before, after } : null
      },
      null,
      2
    )
  );
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ pass: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
