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
        first ??= performance.now();
        last = performance.now();
        content += c.delta.content;
      }
      for (const t of c?.delta?.tool_calls || []) {
        first ??= performance.now();
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
const before = await counters();
const prose =
  'Write a short paragraph about why sparse attention helps long-context language models. Keep it around eighty words. No bullet points.';
for (let i = 0; i < 3; i++) await run('prose-' + i, [{ role: 'user', content: prose }]);
await run(
  'code',
  [
    {
      role: 'user',
      content:
        'Write a Python merge_sorted(a,b) function that merges two sorted lists without modifying either input. Include assertions for empty lists and duplicate values. No markdown.'
    }
  ],
  { max_tokens: 350 }
);
const copy = 'Qz7_!X@19 abCDE-049 Ωmega café 東京 314159265358979323846264338327950288419716939937510';
const copied = await run('copy', [
  { role: 'user', content: 'Copy exactly this string, with no quotes or extra text:\n' + copy }
]);
assert.equal(copied.content.trim(), copy);
// Synthetic repeated-prefix context; immutable across configurations and repeats.
const context =
  Array.from(
    { length: 1600 },
    (_, i) => `Record ${i}: sector amber, quantity ${(i * 17) % 997}, status reviewed.\n`
  ).join('') + '\nThe final access code is ORCHID-7391.\n';
const longMessages = [
  { role: 'system', content: 'Read the supplied ledger and follow the final instruction exactly.' },
  { role: 'user', content: context + '\nWhat is the final access code? Reply with the code alone.' }
];
const long = [];
for (let i = 0; i < 3; i++) {
  const row = await run('long-repeat-' + i, longMessages, { max_tokens: 32 });
  assert.equal(row.content.trim(), 'ORCHID-7391');
  long.push(row);
}
assert(
  long.every((r) => r.content === long[0].content),
  'Repeated prefix changed answer'
);
const toolExtra = {
  tools: [
    {
      type: 'function',
      function: {
        name: 'record_code',
        description: 'Record the access code from the ledger.',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
          additionalProperties: false
        }
      }
    }
  ],
  tool_choice: { type: 'function', function: { name: 'record_code' } },
  max_tokens: 100
};
for (let i = 0; i < 2; i++) {
  const r = await run(
    'long-tool-' + i,
    [longMessages[0], { role: 'user', content: context + '\nCall record_code with the final access code.' }],
    toolExtra
  );
  assert.equal(Object.values(r.tools)[0]?.name, 'record_code');
  assert.deepEqual(JSON.parse(Object.values(r.tools)[0].arguments), { code: 'ORCHID-7391' });
}
await Promise.all(
  Array.from({ length: 4 }, (_, i) =>
    run('concurrent-' + i, [
      { role: 'user', content: i % 2 ? prose : 'Calculate 17 * 23, then explain your arithmetic in one sentence.' }
    ])
  )
);
const after = await counters();
const m = await (await fetch(base + '/gateway/metrics', { headers })).json();
const attribution = m.recent
  .filter((x) => x.caller === caller)
  .map((x) => ({
    requestedModel: x.requestedModel,
    resolvedModel: x.resolvedModel,
    backend: x.backend,
    status: x.status
  }));
assert.equal(attribution.length, rows.length);
assert(
  attribution.every((x) => x.resolvedModel === expected && x.status === 200),
  'Non-local or wrong-model attribution'
);
console.log(
  JSON.stringify({
    summary: true,
    at: new Date().toISOString(),
    model,
    caller,
    checks: rows.length,
    counterDelta: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] || 0)])),
    attribution
  })
);
