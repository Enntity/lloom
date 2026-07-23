#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8100/v1';
const DEFAULT_FIRST_CONTENT_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;

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

function syntheticMessages(promptBytes) {
  const marker = 'Synthetic LLooM canary context. No entity content or continuity state. ';
  const context = marker.repeat(Math.ceil(promptBytes / marker.length)).slice(0, promptBytes);
  return [
    {
      role: 'system',
      content: `${context}\nUse report_status once with status set to ok.`
    },
    {
      role: 'user',
      content: 'Run the synthetic status check now.'
    }
  ];
}

function syntheticTools() {
  return Array.from({ length: 12 }, (_, index) => {
    const name = index === 0 ? 'report_status' : `unused_canary_tool_${index}`;
    return {
      type: 'function',
      function: {
        name,
        description:
          index === 0
            ? 'Report the result of this synthetic model-lane canary.'
            : 'Unused synthetic tool included to exercise representative tool-schema load.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok'] }
          },
          required: ['status'],
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

async function runOne({
  index,
  baseUrl,
  model,
  apiKey,
  promptBytes,
  maxTokens,
  firstContentTimeoutMs,
  totalTimeoutMs
}) {
  const started = Date.now();
  const controller = new AbortController();
  let firstContentAt = null;
  let responseBytes = 0;
  let toolDeltaSeen = false;
  let finishReason = null;
  let firstTimer = setTimeout(
    () => controller.abort(new Error(`no model content after ${firstContentTimeoutMs}ms`)),
    firstContentTimeoutMs
  );
  const totalTimer = setTimeout(
    () => controller.abort(new Error(`canary exceeded ${totalTimeoutMs}ms`)),
    totalTimeoutMs
  );
  firstTimer.unref?.();
  totalTimer.unref?.();

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'x-lloom-client': 'LLooM-Canary'
      },
      body: JSON.stringify({
        model,
        messages: syntheticMessages(promptBytes),
        tools: syntheticTools(),
        tool_choice: 'auto',
        stream: true,
        temperature: 0,
        max_tokens: maxTokens,
        reasoning_effort: 'low',
        chat_template_kwargs: { enable_thinking: true }
      }),
      signal: controller.signal
    });
    if (!response.ok)
      throw new Error(`gateway returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
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
    return {
      index,
      ok: true,
      firstContentMs: firstContentAt - started,
      durationMs: Date.now() - started,
      responseBytes,
      toolDeltaSeen,
      finishReason
    };
  } catch (error) {
    return {
      index,
      ok: false,
      durationMs: Date.now() - started,
      responseBytes,
      error: controller.signal.reason?.message || error?.message || String(error)
    };
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

async function backendMetrics(url) {
  if (!url) return null;
  const text = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`backend metrics returned HTTP ${response.status}`);
    return response.text();
  });
  const number = (name) => {
    const match = text.match(
      new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^\\n]*\\}\\s+([0-9.eE+-]+)$`, 'm')
    );
    return match ? Number(match[1]) : null;
  };
  return {
    running: number('vllm:num_requests_running'),
    waiting: number('vllm:num_requests_waiting'),
    promptTokens: number('vllm:prompt_tokens_total'),
    generationTokens: number('vllm:generation_tokens_total')
  };
}

async function waitForIdle(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await backendMetrics(url);
  while (metrics && (metrics.running !== 0 || metrics.waiting !== 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    metrics = await backendMetrics(url);
  }
  return metrics;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const model = flags.model;
  if (!model) throw new Error('use --model MODEL_ID');
  const concurrency = positiveInteger(flags.concurrency, 2);
  const options = {
    baseUrl: flags['base-url'] || DEFAULT_BASE_URL,
    model,
    apiKey: resolveApiKey(flags),
    promptBytes: positiveInteger(flags['prompt-bytes'], 30_000),
    maxTokens: positiveInteger(flags['max-tokens'], 128),
    firstContentTimeoutMs: positiveInteger(flags['first-content-timeout-ms'], DEFAULT_FIRST_CONTENT_TIMEOUT_MS),
    totalTimeoutMs: positiveInteger(flags['total-timeout-ms'], DEFAULT_TOTAL_TIMEOUT_MS)
  };
  const metricsUrl = flags['backend-metrics-url'] || null;
  const before = await backendMetrics(metricsUrl);
  if (before && (before.running !== 0 || before.waiting !== 0)) {
    throw new Error(`backend is not idle before canary: ${JSON.stringify(before)}`);
  }
  const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => runOne({ ...options, index })));
  const after = await waitForIdle(metricsUrl);
  const pass =
    results.every((result) => result.ok) &&
    (!after || (after.running === 0 && after.waiting === 0)) &&
    (!before || !after || after.generationTokens > before.generationTokens);
  console.log(
    JSON.stringify(
      {
        pass,
        model,
        concurrency,
        promptBytes: options.promptBytes,
        firstContentTimeoutMs: options.firstContentTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        results,
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
