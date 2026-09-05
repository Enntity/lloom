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
  caller = 'q38-pub-' + Date.now();
const state = await (await fetch(base + '/gateway/status', { headers })).json();
const runtime = state.runtimeManager.runtimes['qwen38-flash-next-cluster'];
assert(
  runtime.status === 'running' && runtime.activeRequests === 0 && runtime.queuedRequests === 0,
  'Qwen must already be running and idle'
);
const prompt =
  'Write a short paragraph about why sparse attention helps long-context language models. Keep it around eighty words. No bullet points.';
const rows = [];
for (let i = 0; i < 3; i++) {
  const start = performance.now();
  let first = null,
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
      max_tokens: 200,
      temperature: 0,
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
        content += text;
      }
      finish = choice?.finish_reason || finish;
    }
  }
  const end = performance.now();
  assert(done && first !== null && usage?.completion_tokens && finish === 'stop');
  const row = {
    run: i + 1,
    prompt,
    content,
    finish,
    usage,
    ttftSeconds: (first - start) / 1000,
    totalSeconds: (end - start) / 1000,
    decodeTokensPerSecond: (usage.completion_tokens - 1) / ((end - first) / 1000)
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await new Promise((r) => setTimeout(r, 500));
const metrics = await (await fetch(base + '/gateway/metrics', { headers })).json();
const attr = metrics.recent.filter((r) => r.caller === caller);
assert.equal(attr.length, 3);
assert(attr.every((r) => r.status === 200 && r.resolvedModel === 'qwen3.8-flash-next'));
const median = (xs) => xs.sort((a, b) => a - b)[1];
console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'sfxnz bench_decode.py at fe8c291de4efba34d5dcedbc8e19ebcf66bc1bc2',
    configuration: 'unchanged NVIDIA 8a728663, MTP3, disk PLE, FP8 KV, gmu0.75',
    concurrency: 1,
    thinking: false,
    maxTokens: 200,
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
