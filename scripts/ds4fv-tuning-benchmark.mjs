#!/usr/bin/env node
// Controlled synthetic traffic only. Never uses a cloud-capable alias.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [label = 'baseline', mode = 'quality', capArg = '2'] = process.argv.slice(2);
const temperature = Number(process.env.TUNING_TEMPERATURE ?? 0);
if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1)
  throw new Error('TUNING_TEMPERATURE must be between 0 and 1');
const home = process.env.HOME;
const configPath = path.join(home, '.lloom/config.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const env = Object.fromEntries(
  (await fs.readFile(path.join(home, '.config/lloom/env'), 'utf8'))
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')];
    })
);
const expand = (value) => String(value).replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? '');
const base = `http://127.0.0.1:${config.server.port}`;
const headers = { authorization: `Bearer ${expand(config.security.apiKeys[0])}`, 'content-type': 'application/json' };
const model = 'deepseek-v4-flash-vision-exp';
const runtimeId = `${model}-cluster`;
const backend = config.runtimes[runtimeId].healthUrl.replace('/v1/models', '');
const rows = [];
const report = (row) => {
  rows.push(row);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), label, temperature, ...row }));
};
const request = async (url, body, extraHeaders = headers) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: extraHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(900000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
};
function messages(seed, lines) {
  const filler = Array.from(
    { length: lines },
    (_, i) =>
      `Observation ${i}: The garden monitor reports ordinary soil moisture; review outstanding plans and preserve the existing commitments.`
  );
  filler.splice(Math.floor(lines * 0.55), 0, 'CANARY_RECORD: the unique verification code is cobalt-7391.');
  return [
    { role: 'system', content: `Synthetic workload ${seed}. Read the record and follow the final instruction.` },
    {
      role: 'user',
      content: filler.join('\n') + '\nReturn the unique CANARY_RECORD verification code, with no extra text.'
    }
  ];
}
async function sized(seed, tokens) {
  let lines = Math.ceil(tokens / 25);
  for (let i = 0; i < 3; i++) {
    const m = messages(seed, lines);
    const t = await (
      await request(
        `${backend}/tokenize`,
        { model, messages: m, add_generation_prompt: true },
        { 'content-type': 'application/json' }
      )
    ).json();
    if (t.count >= tokens && t.count < tokens * 1.04) return m;
    lines = Math.ceil((lines * (tokens + 50)) / t.count);
  }
  return messages(seed, lines);
}
async function run(name, m, overrides = {}, endpoint = `${base}/v1/chat/completions`) {
  const start = performance.now();
  const r = await request(endpoint, {
    model,
    messages: m,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    max_tokens: 512,
    chat_template_kwargs: { thinking: false },
    ...overrides
  });
  let buffer = '',
    content = '',
    reasoning = '',
    tools = '',
    first = null,
    finish = null,
    usage;
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      const j = JSON.parse(line.slice(5));
      if (j.error) throw new Error(JSON.stringify(j.error));
      usage = j.usage ?? usage;
      const d = j.choices?.[0]?.delta ?? {};
      if (d.content || d.reasoning_content || d.tool_calls?.length) first ??= performance.now();
      content += d.content ?? '';
      reasoning += d.reasoning_content ?? '';
      for (const call of d.tool_calls ?? []) tools += call.function?.arguments ?? '';
      finish = j.choices?.[0]?.finish_reason ?? finish;
    }
  }
  const end = performance.now();
  const row = {
    name,
    ttftMs: first == null ? null : Math.round(first - start),
    durationMs: Math.round(end - start),
    decodeTps:
      first == null || (usage?.completion_tokens ?? 0) < 32 || end - first < 100
        ? null
        : +((1000 * Math.max(0, (usage?.completion_tokens ?? 0) - 1)) / (end - first)).toFixed(2),
    finish,
    usage,
    content: content.slice(0, 500),
    toolArguments: tools,
    reasoningChars: reasoning.length
  };
  report(row);
  return row;
}

if (mode === 'diagnostic') {
  const m = await sized('quality-131072', 131072);
  for (const [name, url] of [
    ['raw', backend],
    ['gateway', base]
  ]) {
    const start = performance.now();
    const result = await (
      await request(`${url}/v1/chat/completions`, {
        model,
        messages: m,
        temperature,
        max_tokens: 512,
        chat_template_kwargs: { thinking: false }
      })
    ).json();
    report({
      name: `${name}-buffered-128k`,
      durationMs: Math.round(performance.now() - start),
      choices: result.choices,
      usage: result.usage
    });
  }
  await run('raw-stream-128k', m, {}, `${backend}/v1/chat/completions`);
  m[1].content += '\nSpell out all four digits of the code. Do not omit the final digit. Explain briefly.';
  await run('clarified-128k', m);
} else if (mode === 'cache') {
  for (const tokens of [16384, 65536]) {
    const m = await sized(`cache-quality-${tokens}`, tokens);
    m[1].content +=
      '\nAfter stating the complete code, write a detailed 200-word summary of how to track garden observations and outstanding commitments.';
    for (let trial = 0; trial < 3; trial++) {
      const row = await run(`cache-paragraph-${tokens}-${trial}`, m);
      if (!row.content.includes('cobalt-7391') || row.finish !== 'stop' || row.usage.completion_tokens < 128)
        process.exitCode = 1;
    }
  }
} else if (mode === 'reasoning') {
  const row = await run(
    'reasoning-tool-stream',
    [{ role: 'user', content: 'Compute 17 times 23, then call record_code with the decimal answer.' }],
    {
      chat_template_kwargs: { thinking: true },
      reasoning_effort: 'low',
      max_tokens: 2048,
      tools: [
        {
          type: 'function',
          function: {
            name: 'record_code',
            parameters: {
              type: 'object',
              properties: { code: { type: 'string' } },
              required: ['code'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: 'auto'
    }
  );
  if (row.finish !== 'tool_calls' || JSON.parse(row.toolArguments).code !== '391')
    throw new Error('Reasoning tool correctness failed');
} else if (mode === 'quality') {
  for (const tokens of [16384, 131072]) {
    const m = await sized(`quality-${tokens}`, tokens);
    for (let i = 0; i < 3; i++) {
      const row = await run(`retrieve-${tokens}-${i}`, m);
      if (row.content.trim() !== 'cobalt-7391' || row.finish !== 'stop') process.exitCode = 1;
    }
  }
  const row = await run('tool-stream', [{ role: 'user', content: 'Call record_code with code cobalt-7391.' }], {
    tools: [
      {
        type: 'function',
        function: {
          name: 'record_code',
          parameters: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
            additionalProperties: false
          }
        }
      }
    ],
    tool_choice: 'required'
  });
  if (row.finish !== 'tool_calls' || JSON.parse(row.toolArguments).code !== 'cobalt-7391')
    throw new Error('Tool correctness failed');
} else if (mode === 'vision') {
  const image = await fs.readFile('/tmp/ds4fv-vision-canary.png');
  const row = await run('vision', [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the large cyan heading near the upper left. Reply with only that heading.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } }
      ]
    }
  ]);
  if (!row.content.toUpperCase().includes('LIVE TOPOLOGY')) throw new Error('Vision correctness failed');
} else if (mode === 'wave') {
  const cap = Number(capArg);
  if (![2, 3, 4].includes(cap)) throw new Error('Admission cap must be 2, 3 or 4');
  const trials = Number(process.env.TUNING_TRIALS ?? 2);
  if (![1, 2, 3].includes(trials)) throw new Error('TUNING_TRIALS must be 1, 2 or 3');
  const original = config.runtimes[runtimeId].maxConcurrency;
  async function setCap(value) {
    const current = JSON.parse(await fs.readFile(configPath, 'utf8'));
    current.runtimes[runtimeId].maxConcurrency = value;
    const tmp = `${configPath}.ds4fv-benchmark-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(current, null, 2) + '\n', { mode: (await fs.stat(configPath)).mode });
    await fs.rename(tmp, configPath);
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const state = await (await fetch(`${base}/gateway/status`)).json();
      if (state.runtimeManager.runtimes[runtimeId].maxConcurrency === value) return;
    }
    throw new Error('Admission reload did not apply');
  }
  try {
    await setCap(cap);
    for (const tokens of [16384, 65536]) {
      for (let trial = 0; trial < trials; trial++) {
        const all = await Promise.all(
          Array.from({ length: 4 }, (_, i) => sized(`${label}-${cap}-${tokens}-${trial}-${i}`, tokens))
        );
        for (const m of all)
          m[1].content +=
            '\nAfter stating the code, write a detailed 250-word summary of how to track garden observations and outstanding commitments.';
        const start = performance.now();
        const wave = await Promise.all(
          all.map(async (m, i) => {
            await sleep(i * 1000);
            return run(`wave-${cap}-${tokens}-${trial}-${i}`, m);
          })
        );
        const elapsed = performance.now() - start;
        report({
          name: 'wave-summary',
          cap,
          tokens,
          trial,
          durationMs: Math.round(elapsed),
          aggregateTps: +((wave.reduce((a, r) => a + r.usage.completion_tokens, 0) * 1000) / elapsed).toFixed(2),
          worstTtftMs: Math.max(...wave.map((r) => r.ttftMs)),
          correct: wave.every((r) => r.content.includes('cobalt-7391') && r.finish === 'stop')
        });
      }
    }
  } finally {
    await setCap(original);
  }
} else throw new Error('Unknown mode');
report({ name: 'complete', mode, cap: Number(capArg) });
