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
  caller = 'q38-pref-' + Date.now();
const state = await (await fetch(base + '/gateway/status', { headers })).json();
const runtime = state.runtimeManager.runtimes['qwen38-flash-next-cluster'];
assert(
  runtime.status === 'running' && runtime.activeRequests === 0 && runtime.queuedRequests === 0,
  'Qwen must already be running and idle'
);
const prompt =
  'Read this filler and report the final passcode. ' +
  'The observatory records clear skies and steady readings. '.repeat(3000) +
  ' Final passcode: Q38_PREFILL_OK. Reply only with Q38_PREFILL_OK.';
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
for (let i = 0; i < 1; i++) {
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
      max_tokens: 32,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false }
    }),
    signal: AbortSignal.timeout(180000)
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
  assert(content.includes('Q38_PREFILL_OK'));
  const row = {
    run: i + 1,
    promptDescription: '3000 repeated observatory sentences plus final passcode; prefix cache disabled',
    content,
    finish,
    usage,
    prefillTokensPerSecond: usage.prompt_tokens / ((first - start) / 1000),
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
assert.equal(attr.length, 1);
assert(attr.every((r) => r.status === 200 && r.resolvedModel === 'qwen3.8-flash-next'));
const median = (xs) => xs.sort((a, b) => a - b)[0];
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
    source: 'LLooM single-request cold prefill probe; not a matched upstream prefill prompt',
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
    maxTokens: 32,
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
