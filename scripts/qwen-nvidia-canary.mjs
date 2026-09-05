#!/usr/bin/env node
// Synthetic gateway validation only; never reads entity prompts or continuity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const c = await loadConfig(process.env.HOME + '/.lloom/config.json');
const headers = {
  authorization: 'Bearer ' + (c.security.adminApiKeys?.[0] || c.security.apiKeys[0]),
  'content-type': 'application/json'
};
const base = process.env.QWEN_GATEWAY || 'http://127.0.0.1:8100';
const model = process.env.QWEN_MODEL_ALIAS || 'q38fn-local';
const phase = process.argv[2] || 'smoke';
const caller = `qwen-${phase}-${Date.now()}`;
const results = [];
async function run(name, body, check = () => {}) {
  const start = performance.now();
  let first = null,
    last = null,
    gap = 0,
    content = '',
    reasoningChars = 0,
    finish = null,
    usage = null,
    done = false;
  const calls = new Map();
  const response = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'x-lloom-client': caller },
    body: JSON.stringify({
      model,
      temperature: 0,
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: true },
      max_tokens: 768,
      ...body,
      stream: true,
      stream_options: { include_usage: true }
    }),
    signal: AbortSignal.timeout(600000)
  });
  assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
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
      assert(!j.error, JSON.stringify(j.error));
      const choice = j.choices?.[0];
      const d = choice?.delta || {};
      if (d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length) {
        const now = performance.now();
        first ??= now;
        if (last) gap = Math.max(gap, now - last);
        last = now;
      }
      content += d.content || '';
      reasoningChars += (d.reasoning_content || d.reasoning || '').length;
      for (const t of d.tool_calls || []) {
        const current = calls.get(t.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        current.id ||= t.id || '';
        current.function.name += t.function?.name || '';
        current.function.arguments += t.function?.arguments || '';
        calls.set(t.index, current);
      }
      finish = choice?.finish_reason || finish;
      usage = j.usage || usage;
    }
  }
  const result = {
    name,
    elapsedMs: performance.now() - start,
    ttftMs: first ? first - start : null,
    maxGapMs: gap,
    content,
    reasoningChars,
    calls: [...calls.values()],
    finish,
    usage,
    done
  };
  assert(done, 'SSE missing DONE');
  assert(finish && finish !== 'length', 'incomplete completion');
  assert(!/<\/?think>|<tool_call>/.test(content), 'raw reasoning/tool syntax leaked into content');
  check(result);
  result.generatedTokensPerSecond =
    usage?.completion_tokens && last > first ? usage.completion_tokens / ((last - first) / 1000) : null;
  results.push(result);
  console.log(JSON.stringify(result));
  return result;
}
const messages = (text) => [{ role: 'user', content: text }];
const tools = [
  {
    type: 'function',
    function: {
      name: 'report_status',
      description: 'Report the requested synthetic check result.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['ok'] }, code: { type: 'string' } },
        required: ['status', 'code'],
        additionalProperties: false
      }
    }
  }
];
function checkTool(code) {
  return (r) => {
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, 'report_status');
    assert(r.calls[0].id);
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { status: 'ok', code });
    assert.equal(r.finish, 'tool_calls');
  };
}
if (phase === 'smoke') {
  await run(
    'thinking-off',
    { messages: messages('Reply with exactly QWEN_LOCAL_OK.'), chat_template_kwargs: { enable_thinking: false } },
    (r) => {
      assert.equal(r.content.trim(), 'QWEN_LOCAL_OK');
      assert.equal(r.reasoningChars, 0);
    }
  );
  await run(
    'reasoning',
    { messages: messages('Compute (37 * 19) - 86. Give only the integer as your final answer.') },
    (r) => assert.equal(r.content.trim(), '617')
  );
  const tool = await run(
    'streaming-tool',
    {
      messages: messages(
        'Call report_status exactly once with status ok and code SPARK_NVIDIA. Do not answer in prose.'
      ),
      tools,
      tool_choice: 'auto'
    },
    checkTool('SPARK_NVIDIA')
  );
  await run(
    'tool-roundtrip',
    {
      messages: [
        ...messages('Call report_status exactly once with status ok and code SPARK_NVIDIA. Do not answer in prose.'),
        { role: 'assistant', content: null, tool_calls: tool.calls },
        {
          role: 'tool',
          tool_call_id: tool.calls[0].id,
          content: 'The synthetic check succeeded. Reply with exactly TOOL_ROUNDTRIP_OK.'
        }
      ],
      tools
    },
    (r) => assert.equal(r.content.trim(), 'TOOL_ROUNDTRIP_OK')
  );
  if (process.env.QWEN_VISION_IMAGE) {
    const data = fs.readFileSync(process.env.QWEN_VISION_IMAGE).toString('base64');
    await run(
      'vision',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What single solid color fills this image? Reply with one word.' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } }
            ]
          }
        ]
      },
      (r) => assert.match(r.content.trim(), /^red[.!]?$/i)
    );
  }
} else if (phase === 'load') {
  const concurrent = Number(process.env.QWEN_CONCURRENCY || 4);
  const queueCheck = process.env.QWEN_QUEUE_CHECK === '1';
  const admission = { maxActive: 0, maxQueued: 0, samples: 0 };
  let monitoring = queueCheck;
  const monitor = (async () => {
    while (monitoring) {
      const status = await (await fetch(base + '/gateway/status', { headers })).json();
      const runtime = status.runtimeManager.runtimes['qwen38-flash-next-cluster'];
      admission.maxActive = Math.max(admission.maxActive, runtime.activeRequests || 0);
      admission.maxQueued = Math.max(admission.maxQueued, runtime.queuedRequests || 0);
      admission.samples++;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  try {
    await Promise.all(
      Array.from({ length: concurrent }, async (_, i) => {
        const records = Array.from(
          { length: i === 0 ? 3000 : 120 * (i + 1) },
          (_, n) => `record-${n}: value-${(n * 7919) % 100003}.`
        );
        const code = `NEEDLE_${i}_48291`;
        records.splice(Math.floor(records.length / 2), 0, `The authoritative verification code is ${code}.`);
        const body = {
          messages: messages(
            records.join('\n') +
              '\nFind the authoritative verification code and call report_status with status ok and that exact code. Ignore other records.'
          ),
          tools,
          tool_choice: 'auto'
        };
        await run('mixed-context-' + i, body, checkTool(code));
        await run('repeated-context-' + i, body, checkTool(code));
      })
    );
  } finally {
    monitoring = false;
    await monitor;
  }
  if (queueCheck) {
    assert(admission.maxActive <= 4, 'configured admission limit exceeded');
    assert(admission.maxQueued > 0, 'queue was not exercised');
    const status = await (await fetch(base + '/gateway/status', { headers })).json();
    const runtime = status.runtimeManager.runtimes['qwen38-flash-next-cluster'];
    assert.equal(runtime.activeRequests, 0);
    assert.equal(runtime.queuedRequests, 0);
    console.log(JSON.stringify({ admission, drained: true }));
  }
} else if (phase === 'benchmark') {
  const prompts = [
    'Explain how you would diagnose a service that returns intermittent 503 responses while CPU usage is low. Give a practical sequence of checks in about 150 words.',
    'Write a short Python function that merges two sorted lists without mutating either input. Explain its time and space complexity.',
    'A train leaves at 09:15 and travels 135 km at 90 km/h, stops for 12 minutes, then travels 84 km at 70 km/h. Determine arrival time and explain the calculation.'
  ];
  for (let repeat = 0; repeat < 2; repeat++)
    for (let i = 0; i < prompts.length; i++)
      await run(`workload-${repeat}-${i}`, { messages: messages(prompts[i]), max_tokens: 1536 }, (r) =>
        assert(r.content.length > 80)
      );
} else throw new Error('unknown phase');
const metrics = await (await fetch(base + '/gateway/metrics', { headers })).json();
const attributed = (metrics.recent || [])
  .filter((x) => x.caller === caller)
  .map((x) =>
    Object.fromEntries(
      ['requestedModel', 'resolvedModel', 'upstreamModel', 'backend', 'status', 'routeSelectionReason'].map((k) => [
        k,
        x[k]
      ])
    )
  );
assert(attributed.length, 'missing gateway attribution');
if (model === 'q38fn-local')
  assert(
    attributed.every((x) => x.resolvedModel === 'qwen3.8-flash-next'),
    'strict canary did not resolve locally'
  );
console.log(JSON.stringify({ phase, caller, model, passed: results.length, attributed }));
