import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.env.LLOOM_ROOT || '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
loadManagedServiceEnvironment();
const model = process.env.TEST_MODEL || 'q38fn-local';
const expected = process.env.EXPECTED_MODEL || 'qwen3.8-flash-next';
const base = 'http://127.0.0.1:8100';
const caller = 'q38opt-' + Date.now();
const headers = {
  authorization: 'Bearer ' + process.env.LLOOM_API_KEY,
  'content-type': 'application/json',
  'x-lloom-client': caller
};
const rows = [];
async function counters() {
  const text = await (await fetch(process.env.METRICS_URL || 'http://127.0.0.1:8889/metrics')).text();
  return Object.fromEntries(
    text
      .split('\n')
      .filter((x) =>
        /^vllm:(prefix_cache_(hits|queries)|spec_decode_(num_drafts|num_draft_tokens|num_accepted_tokens))_total\{/.test(
          x
        )
      )
      .map((x) => [x.slice(0, x.lastIndexOf(' ')), Number(x.slice(x.lastIndexOf(' ') + 1))])
  );
}
async function run(name, messages, extra = {}) {
  const start = performance.now();
  let first = null,
    last = null,
    maxGapMs = 0,
    usage,
    pending = '',
    content = '',
    done = false,
    finish,
    tools = {};
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 200,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
      ...extra
    }),
    signal: AbortSignal.timeout(240000)
  });
  assert.equal(r.status, 200, await (r.status === 200 ? Promise.resolve('') : r.text()));
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
      const d = JSON.parse(raw);
      assert(!d.error, JSON.stringify(d.error));
      usage = d.usage || usage;
      const c = d.choices?.[0];
      finish = c?.finish_reason || finish;
      if (c?.delta?.content) {
        if (first === null) {
          first = performance.now();
          extra.onFirst?.();
        }
        if (last !== null) maxGapMs = Math.max(maxGapMs, performance.now() - last);
        last = performance.now();
        content += c.delta.content;
      }
      for (const t of c?.delta?.tool_calls || []) {
        if (first === null) {
          first = performance.now();
          extra.onFirst?.();
        }
        if (last !== null) maxGapMs = Math.max(maxGapMs, performance.now() - last);
        last = performance.now();
        const p = (tools[t.index] ??= { name: '', arguments: '' });
        p.name += t.function?.name || '';
        p.arguments += t.function?.arguments || '';
      }
    }
  }
  const end = performance.now();
  assert(done && first !== null && usage?.completion_tokens, 'Incomplete stream');
  const row = {
    name,
    model,
    ttftMs: first - start,
    maxGapMs,
    totalMs: end - start,
    decodeTokensPerSecond: (usage.completion_tokens - 1) / ((end - first) / 1000),
    content,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    tools,
    usage,
    finish
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  return row;
}
// Speed-only probes: output caps are deliberate, not complete-answer quality gates.
for (let i = 0; i < 2; i++) {
  let resolveStarted;
  const started = new Promise((r) => {
    resolveStarted = r;
  });
  const first = run(
    'decoding-' + i,
    [
      {
        role: 'user',
        content:
          'Write a detailed 1500-word original story about a botanist exploring an abandoned orbital greenhouse. Use continuous prose, no headings.'
      }
    ],
    { max_tokens: 900, onFirst: resolveStarted }
  );
  await Promise.race([
    started,
    first.then(() => {
      throw new Error('First stream completed before content barrier');
    })
  ]);
  await new Promise((r) => setTimeout(r, 500));
  const long =
    'Unique ledger trial ' +
    i +
    ':\n' +
    Array.from(
      { length: 3200 },
      (_, n) => 'Item ' + n + ': batch indigo, value ' + ((n * 19 + i * 31) % 997) + ', status archived.\n'
    ).join('') +
    '\nFinal marker: STAGGER_' +
    i +
    '. Return the final marker alone.';
  const second = run('prefilling-' + i, [{ role: 'user', content: long }], { max_tokens: 32 });
  const both = await Promise.all([first, second]);
  assert.equal(both[1].content.trim(), 'STAGGER_' + i);
}
const m = await (await fetch(base + '/gateway/metrics', { headers })).json();
const attribution = m.recent
  .filter((x) => x.caller === caller)
  .map((x) => ({ resolvedModel: x.resolvedModel, status: x.status }));
assert.equal(attribution.length, 4);
assert(attribution.every((x) => x.status === 200 && x.resolvedModel === expected));
console.log(JSON.stringify({ summary: true, at: new Date().toISOString(), model, caller, attribution }));
