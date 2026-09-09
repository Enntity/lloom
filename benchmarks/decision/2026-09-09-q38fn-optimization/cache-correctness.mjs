import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.env.LLOOM_ROOT || '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
loadManagedServiceEnvironment();
const model = process.env.TEST_MODEL || 'q38fn-prefix-test';
const base = 'http://127.0.0.1:8100',
  caller = 'q38cache-' + Date.now();
const headers = {
  authorization: 'Bearer ' + process.env.LLOOM_API_KEY,
  'content-type': 'application/json',
  'x-lloom-client': caller
};
const metricsURL = process.env.METRICS_URL || 'http://10.100.16.2:8894/metrics';
async function hits() {
  const t = await (await fetch(metricsURL)).text();
  return t
    .split('\n')
    .filter((x) => x.startsWith('vllm:prefix_cache_hits_total{'))
    .reduce((a, x) => a + Number(x.split(' ').at(-1)), 0);
}
const fixtureCount = Number(process.env.FIXTURE_COUNT || 3);
const ledgerLines = Number(process.env.LEDGER_LINES || 1600);
assert([1, 3].includes(fixtureCount));
assert(Number.isInteger(ledgerLines) && ledgerLines >= 1600 && ledgerLines <= 12000);
const fixtures = Array.from({ length: fixtureCount }, (_, n) => {
  const first = ['CEDAR-59173', 'VIOLET-82046', 'ONYX-34719'][n],
    middle = ['MICA-70824', 'OAK-46391', 'LILAC-92605'][n];
  const lines = Array.from(
    { length: ledgerLines },
    (_, i) => `Entry ${i}: department gamma, amount ${(i * 29 + n * 13) % 991}, verification complete.\n`
  );
  lines.unshift(`Suite ${caller}, ledger ${n}. The ROOT_KEY is ${first}.\n`);
  lines.splice(Math.floor(ledgerLines / 2) + 10, 0, `The INNER_KEY is ${middle}.\n`);
  return { content: lines.join(''), expected: first + '|' + middle };
});
async function run(n, label, tool = false) {
  const f = fixtures[n],
    start = performance.now();
  const body = {
    model,
    messages: [
      { role: 'system', content: 'Extract the requested exact values from the ledger. Do not infer or invent keys.' },
      { role: 'user', content: f.content + '\nReturn ROOT_KEY then INNER_KEY separated by |, with no other text.' }
    ],
    temperature: 0,
    max_tokens: 100,
    chat_template_kwargs: { enable_thinking: false }
  };
  if (tool) {
    body.messages[1].content = f.content + '\nUse submit_keys to submit ROOT_KEY followed by INNER_KEY separated by |.';
    body.tools = [
      {
        type: 'function',
        function: {
          name: 'submit_keys',
          parameters: {
            type: 'object',
            properties: { keys: { type: 'string' } },
            required: ['keys'],
            additionalProperties: false
          }
        }
      }
    ];
    body.tool_choice = { type: 'function', function: { name: 'submit_keys' } };
  }
  const before = await hits();
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240000)
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  const m = d.choices?.[0]?.message;
  if (tool) {
    assert.equal(m.tool_calls.length, 1);
    assert.equal(m.tool_calls[0].function.name, 'submit_keys');
  }
  const actual = tool ? JSON.parse(m.tool_calls[0].function.arguments).keys : m.content.trim();
  assert.equal(actual, f.expected, label);
  // The pinned backend also returns stop for named forced tools on baseline.
  // Require the real call and exact arguments above, and reject truncation.
  assert(['stop', ...(tool ? ['tool_calls'] : [])].includes(d.choices[0].finish_reason));
  const row = {
    label,
    fixture: n,
    tool,
    finish: d.choices[0].finish_reason,
    actual,
    expected: f.expected,
    totalMs: performance.now() - start,
    usage: d.usage,
    hash: createHash('sha256').update(JSON.stringify(m)).digest('hex'),
    prefixHitDelta: (await hits()) - before
  };
  console.log(JSON.stringify(row));
  return row;
}
const cold = [];
for (let i = 0; i < fixtureCount; i++) cold.push(await run(i, 'cold-' + i));
for (let i = fixtureCount - 1; i >= 0; i--) {
  const warm = await run(i, 'warm-' + i);
  assert.equal(warm.hash, cold[i].hash, 'Cache hit changed greedy response');
  assert(warm.prefixHitDelta > 0, 'No demonstrated cache hit');
}
await Promise.all([
  run(0, 'parallel-a'),
  run(1 % fixtureCount, 'parallel-b'),
  run(2 % fixtureCount, 'parallel-c'),
  run(0, 'parallel-d')
]);
for (let i = 0; i < fixtureCount; i++) await run(i, 'tool-' + i, true);
const m = await (await fetch(base + '/gateway/metrics', { headers })).json();
const attr = m.recent.filter((x) => x.caller === caller);
assert.equal(attr.length, fixtureCount * 3 + 4);
assert(
  attr.every(
    (x) => x.status === 200 && x.resolvedModel === (process.env.EXPECTED_MODEL || 'qwen3.8-flash-next-prefix-test')
  )
);
console.log(
  JSON.stringify({
    summary: true,
    checks: fixtureCount * 3 + 4,
    ledgerLines,
    caller,
    at: new Date().toISOString(),
    attribution: attr.map((x) => ({ resolvedModel: x.resolvedModel, backend: x.backend, status: x.status }))
  })
);
