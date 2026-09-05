import assert from 'node:assert/strict';
const root = process.env.LLOOM_ROOT || new URL('../../../', import.meta.url).pathname;
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const c = await loadConfig(process.env.HOME + '/.lloom/config.json');
const headers = {
  authorization: 'Bearer ' + (c.security.adminApiKeys?.[0] || c.security.apiKeys[0]),
  'content-type': 'application/json'
};
const base = 'http://127.0.0.1:8100',
  caller = 'q38-hash-' + Date.now();
const state = await (await fetch(base + '/gateway/status', { headers })).json();
const runtime = state.runtimeManager.runtimes['qwen38-flash-next-cluster'];
assert(
  runtime.status === 'running' && runtime.activeRequests === 0 && runtime.queuedRequests === 0,
  'Qwen must already be running and idle'
);
const prompt =
  'Write a detailed step-by-step explanation of how a hash map works, including collision handling, resizing, and time complexity. Be thorough.';
async function speculation() {
  const text = await (await fetch(process.env.QWEN_BACKEND_METRICS || 'http://127.0.0.1:8889/metrics')).text();
  const out = {};
  for (const name of ['num_drafts', 'num_draft_tokens', 'num_accepted_tokens']) {
    const line = text.split('\n').find((x) => x.startsWith('vllm:spec_decode_' + name + '_total{'));
    if (line) out[name] = Number(line.split(' ').at(-1));
  }
  return out;
}
const before = await speculation();
const rows = [];
for (let i = -1; i < 3; i++) {
  const start = performance.now();
  let first = null,
    last = null,
    content = '',
    usage = null,
    pending = '',
    done = false,
    finish = null;
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'x-lloom-client': caller },
    body: JSON.stringify({
      model: 'q38fn-local',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: i < 0 ? 32 : 400,
      ...(i < 0 ? {} : { min_tokens: 400, ignore_eos: true, stop: [] }),
      temperature: 0,
      top_p: 1,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false }
    }),
    signal: AbortSignal.timeout(90000)
  });
  assert.equal(r.status, 200);
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') {
        done = true;
        continue;
      }
      if (!raw) continue;
      const j = JSON.parse(raw);
      assert(!j.error);
      usage = j.usage || usage;
      const choice = j.choices?.[0];
      const text = choice?.delta?.content || '';
      if (text) {
        first ??= performance.now();
        last = performance.now();
        content += text;
      }
      finish = choice?.finish_reason || finish;
    }
  }
  const end = performance.now();
  assert(done && first !== null && usage?.completion_tokens && ['stop', 'length'].includes(finish));
  if (i < 0) continue;
  assert.equal(usage.completion_tokens, 400);
  const row = {
    run: i + 1,
    prompt,
    content,
    finish,
    usage,
    ttftSeconds: (first - start) / 1000,
    totalSeconds: (end - start) / 1000,
    decodeTokensPerSecond: (usage.completion_tokens - 1) / ((last - first) / 1000)
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await new Promise((r) => setTimeout(r, 500));
const metrics = await (await fetch(base + '/gateway/metrics', { headers })).json();
const attr = metrics.recent.filter((r) => r.caller === caller);
assert.equal(attr.length, 4);
assert(attr.every((r) => r.status === 200 && r.resolvedModel === 'qwen3.8-flash-next'));
const median = (xs) => xs.sort((a, b) => a - b)[1];
const after = await speculation();
const delta = Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]));
console.log(
  JSON.stringify({
    speculation: {
      ...delta,
      acceptance: delta.num_accepted_tokens / delta.num_draft_tokens,
      meanAcceptedLength: 1 + delta.num_accepted_tokens / delta.num_drafts
    },
    timestamp: new Date().toISOString(),
    source:
      'sparkDash protocol at cc44d3527e7ddd339f513bb205dce4f37072beff; 32-token warmup, 400 forced tokens, first-to-last content window, three repeats; Mia capture maxTokens not published',
    configuration: {
      image: c.runtimes['qwen38-flash-next-head'].bootstrap.image,
      recipe: {
        id: c.runtimes['qwen38-flash-next-head'].recipe?.id,
        version: c.runtimes['qwen38-flash-next-head'].recipe?.version
      },
      controls: c.runtimes['qwen38-flash-next-head'].bootstrap.createArgs.filter((x) =>
        /^(MTP_|KV_CACHE_|QWEN4EXP_PLE_MMAP=|GPU_MEMORY_)/.test(x)
      )
    },
    concurrency: 1,
    thinking: false,
    maxTokens: 400,
    medianDecodeTokensPerSecond: median(rows.map((r) => r.decodeTokensPerSecond)),
    medianTTFTSeconds: median(rows.map((r) => r.ttftSeconds)),
    attribution: attr.map((r) => ({
      requestedModel: r.requestedModel,
      resolvedModel: r.resolvedModel,
      backend: r.backend,
      status: r.status
    }))
  })
);
