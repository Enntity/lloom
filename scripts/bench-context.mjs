#!/usr/bin/env node
/**
 * Local context/performance ladder for LLooM gateways.
 * Usage:
 *   node scripts/bench-context.mjs [--base http://127.0.0.1:8100] [--model id] [--sizes 2k,32k,64k,100k,131k]
 */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const BASE = arg('--base', 'http://127.0.0.1:8100');
const MODEL = arg('--model', '');
const KEY = arg('--key', 'sk-lloom-local');
const SIZES = arg('--sizes', '2k,32k,64k,100k,131k')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GEN_TOKENS = Number(arg('--gen-tokens', '128'));

function parseSize(label) {
  const m = String(label).toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) throw new Error(`bad size ${label}`);
  let n = Number(m[1]);
  if (m[2] === 'k') n *= 1000;
  if (m[2] === 'm') n *= 1_000_000;
  return Math.floor(n);
}

function buildCorpus(targetTokens) {
  // ~0.28 tokens/char observed on prior runs with section text
  const chars = Math.floor(targetTokens / 0.28);
  let out = '';
  let i = 0;
  while (out.length < chars) {
    out +=
      `Section ${i}: record_id=${i} epoch=${1000 + (i % 97)} checksum=${(i * 2654435761) >>> 0} ` +
      `notes=hash maps B-trees vector clocks batch ${i} concurrency ${1 + (i % 8)} ` +
      `latency ${5 + (i % 40)}ms payload alpha beta gamma delta epsilon zeta eta theta. end_${i}.\n`;
    i += 1;
  }
  return out.slice(0, chars);
}

async function resolveModel() {
  if (MODEL) return MODEL;
  const res = await fetch(`${BASE}/v1/models`);
  const json = await res.json();
  const id = json.data?.[0]?.id;
  if (!id) throw new Error('no models advertised');
  return id;
}

async function streamOnce({ model, wantTokens, label }) {
  const slice = buildCorpus(wantTokens);
  const started = performance.now();
  let first = null;
  let usage = null;
  let content = '';
  let finish = null;
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Answer with only the integer requested. Be brief.' },
        {
          role: 'user',
          content: `DOCUMENT\n${slice}\nEND\n\nIn Section 5, what is record_id? Integer only.`
        }
      ],
      max_tokens: GEN_TOKENS,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      label,
      ok: false,
      status: res.status,
      error: text.slice(0, 400),
      elapsedMs: Math.round(performance.now() - started)
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.error) {
            return {
              label,
              ok: false,
              streamError: chunk.error,
              firstContentMs: first,
              elapsedMs: Math.round(performance.now() - started),
              usage
            };
          }
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta ?? {};
          const piece = delta.content ?? delta.reasoning_content ?? '';
          if (piece) {
            if (first == null) first = Math.round(performance.now() - started);
            content += piece;
          }
          if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        }
      }
    }
  } catch (error) {
    return {
      label,
      ok: false,
      error: error?.message ?? String(error),
      firstContentMs: first,
      elapsedMs: Math.round(performance.now() - started),
      usage
    };
  }
  const elapsedMs = Math.round(performance.now() - started);
  const out = usage?.completion_tokens ?? 0;
  const inp = usage?.prompt_tokens ?? 0;
  const after = Math.max(1, elapsedMs - (first ?? 0));
  return {
    label,
    ok: true,
    promptTokens: inp,
    completionTokens: out,
    firstContentMs: first,
    elapsedMs,
    prefillTokPerSec: first ? Number((inp / (first / 1000)).toFixed(2)) : null,
    decodeTokPerSec: Number((out / (after / 1000)).toFixed(2)),
    wallTokPerSec: Number((out / (elapsedMs / 1000)).toFixed(2)),
    finish,
    preview: content.replace(/\s+/g, ' ').slice(0, 100)
  };
}

async function shortBench(model) {
  const started = performance.now();
  let first = null;
  let usage = null;
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Write continuously.' },
        {
          role: 'user',
          content: 'Write a ~200 word technical overview of hash maps. No preamble.'
        }
      ],
      max_tokens: 256,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true }
    })
  });
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta ?? {};
        const piece = delta.content ?? delta.reasoning_content ?? '';
        if (piece && first == null) first = Math.round(performance.now() - started);
      }
    }
  }
  const elapsedMs = Math.round(performance.now() - started);
  const out = usage?.completion_tokens ?? 0;
  const after = Math.max(1, elapsedMs - (first ?? 0));
  return {
    ok: true,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: out,
    firstContentMs: first,
    elapsedMs,
    decodeTokPerSec: Number((out / (after / 1000)).toFixed(2)),
    wallTokPerSec: Number((out / (elapsedMs / 1000)).toFixed(2))
  };
}

const model = await resolveModel();
console.log(JSON.stringify({ base: BASE, model, sizes: SIZES, genTokens: GEN_TOKENS }, null, 2));

// warmup
await shortBench(model).catch(() => null);

const short = await shortBench(model);
console.log('SHORT', JSON.stringify(short));

const results = [];
for (const label of SIZES) {
  const want = parseSize(label);
  console.log(`\n=== ${label} (~${want} tokens target) ===`);
  const r = await streamOnce({ model, wantTokens: want, label });
  console.log(JSON.stringify(r, null, 2));
  results.push(r);
  const health = await fetch(`${BASE}/health`).then((x) => x.ok).catch(() => false);
  console.log('gateway_health', health);
  if (!r.ok || !health) break;
}

console.log('\n===== SUMMARY =====');
console.log(JSON.stringify({ model, short, ladder: results }, null, 2));
