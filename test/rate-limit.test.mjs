import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireRateLimitSlot,
  createGcra,
  createRateLimitRegistry,
  createSemaphore,
  normalizeRateLimit
} from '../src/rate-limit.mjs';
import { createLloomServer } from '../src/server.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

async function chatFixture(aliases, { models = null, handleUpstream = null } = {}) {
  const upstream = http.createServer(async (req, res) => {
    if (handleUpstream) return handleUpstream(req, res);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = {
    name: 'rate-limit-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    defaults: { chatModel: Object.keys(aliases)[0] },
    backends: { fixture: { type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` } },
    models: models ?? [{ id: 'model-a', kind: 'chat', backend: 'fixture', upstreamModel: 'fixture' }],
    aliases
  };
  return { upstream, config };
}

async function chatGateway(fixture) {
  const { config, upstream } = fixture;
  const manager = new RuntimeManager(config);
  manager.ensure = async () => ({ healthy: true });
  manager.isHealthy = async () => true;
  const app = createLloomServer(config, { runtimeManager: manager, logger: { error() {}, warn() {} } });
  const port = await listen(app.server);
  const chat = (model, options = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      ...options
    });
  return {
    chat,
    routing: () => fetch(`http://127.0.0.1:${port}/gateway/routing`).then((r) => r.json()),
    async close() {
      upstream.closeAllConnections();
      upstream.close();
      await app.close({ stopRuntimes: false });
    }
  };
}

test('normalizeRateLimit parses rate strings, counts, concurrency, and rejects junk', () => {
  assert.deepEqual(normalizeRateLimit('20/m'), { maxConcurrent: null, burst: 19, rateMs: 3000 });
  assert.deepEqual(normalizeRateLimit('30/s'), { maxConcurrent: null, burst: 29, rateMs: 1000 / 30 });
  assert.deepEqual(normalizeRateLimit('100/h'), { maxConcurrent: null, burst: 99, rateMs: 36_000 });
  assert.deepEqual(normalizeRateLimit({ rate: 10, period: 'h' }), {
    maxConcurrent: null,
    burst: 9,
    rateMs: 360_000
  });
  assert.deepEqual(normalizeRateLimit({ maxConcurrent: 2 }), { maxConcurrent: 2, burst: 0, rateMs: null });
  assert.deepEqual(normalizeRateLimit({ rate: '5/m', maxConcurrent: 3, burst: 0 }), {
    maxConcurrent: 3,
    burst: 0,
    rateMs: 12_000
  });
  // Idempotent on the normalized shape produced by loadConfig.
  assert.deepEqual(normalizeRateLimit(normalizeRateLimit('20/m')), normalizeRateLimit('20/m'));
  assert.equal(normalizeRateLimit(null), null);
  assert.equal(normalizeRateLimit(undefined), null);
  assert.equal(normalizeRateLimit(''), null);
  assert.throws(() => normalizeRateLimit('fast/m'), /must look like/);
  assert.throws(() => normalizeRateLimit({}), /must set maxConcurrent/);
  assert.throws(() => normalizeRateLimit({ rate: '5' }), /must look like/);
  assert.throws(() => normalizeRateLimit({ rate: 0 }), /positive/);
  assert.throws(() => normalizeRateLimit({ maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => normalizeRateLimit({ rate: '5/m', burst: -1 }), /burst/);
  assert.throws(() => normalizeRateLimit('nope'), /must look like/);
});

test('the token bucket admits exactly n requests back-to-back then spaces by interval', () => {
  for (const [rate, expected] of [
    ['1/m', 1],
    ['2/m', 2],
    ['3/s', 3],
    ['10/m', 10]
  ]) {
    const bucket = createGcra(normalizeRateLimit(rate));
    let immediate = 0;
    for (let i = 0; i < 25; i++) {
      if (bucket.tryAcquire(0).allowed) immediate++;
      else break;
    }
    assert.equal(immediate, expected, `${rate} must admit ${expected} immediate requests`);
  }
  const bucket = createGcra(normalizeRateLimit('2/m'));
  assert.equal(bucket.tryAcquire(0).allowed, true);
  assert.equal(bucket.tryAcquire(0).allowed, true);
  const denied = bucket.tryAcquire(0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 30_000);
  assert.equal(bucket.tryAcquire(30_000).allowed, true, 'one token refills after the interval');
  assert.equal(bucket.tryAcquire(45_000).allowed, false, 'partial refill must not admit early');
  assert.equal(bucket.tryAcquire(60_000).allowed, true, 'the second interval admits again');
  // Steady-state average never exceeds the configured rate over the long run.
  const steady = createGcra(normalizeRateLimit('2/m'));
  let now = 0;
  let count = 0;
  while (now <= 120_000) {
    const decision = steady.tryAcquire(now);
    if (decision.allowed) {
      count++;
      now += 1;
    } else now += decision.retryAfterMs;
  }
  assert.ok(count >= 4 && count <= 5, `2/m must admit 4-5 requests over 120s, saw ${count}`);
});

test('the concurrency semaphore queues FIFO, respects aborts, and releases idempotently', async () => {
  const semaphore = createSemaphore(1);
  const first = await semaphore.acquire();
  assert.equal(semaphore.active, 1);
  const order = [];
  const second = semaphore.acquire().then((release) => {
    order.push('second');
    release();
    release(); // idempotent
  });
  const aborted = new AbortController();
  const third = semaphore.acquire(aborted.signal);
  aborted.abort(Object.assign(new Error('gone'), { name: 'AbortError' }));
  await assert.rejects(third, { name: 'AbortError' });
  first();
  await second;
  assert.deepEqual(order, ['second']);
  assert.equal(semaphore.active, 0);
});

test('registry sync preserves live limiters and prunes removed ones', () => {
  const registry = createRateLimitRegistry({ keep: '2/m', drop: { maxConcurrent: 1 } });
  assert.equal(registry.size, 2);
  registry.limiter('keep').gcra?.tryAcquire(1000);
  registry.sync({ keep: '2/m', added: { maxConcurrent: 4 } });
  assert.equal(registry.size, 2);
  assert.ok(registry.limiter('keep').gcra.active, 'surviving limiter keeps its bucket state');
  assert.equal(registry.limiter('drop'), null);
  assert.equal(registry.limiter('added').semaphore.limit, 4);
  assert.throws(() => registry.sync({ bad: 'nope/not-a-rate' }), /invalid rateLimit for bad/);
  const status = registry.status(1000);
  assert.deepEqual(status.map((entry) => entry.id).sort(), ['added', 'keep']);
});

test('acquireRateLimitSlot passes through unlisted ids and 429s exhausted budgets', async () => {
  const registry = createRateLimitRegistry({ lane: '1/m' });
  const unlisted = await acquireRateLimitSlot(registry, 'other');
  assert.equal(typeof unlisted, 'function');
  unlisted();
  const first = await acquireRateLimitSlot(registry, 'lane');
  first();
  await assert.rejects(acquireRateLimitSlot(registry, 'lane'), (error) => {
    assert.equal(error.name, 'RateBudgetExhaustedError');
    assert.ok(error.retryAfterMs > 0);
    return true;
  });
  const aborted = new AbortController();
  aborted.abort(Object.assign(new Error('gone'), { name: 'AbortError' }));
  await assert.rejects(acquireRateLimitSlot(registry, 'lane', { signal: aborted.signal }), {
    name: 'AbortError'
  });
});

test('config validation rejects malformed rateLimit metadata and normalizes valid values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-rate-limit-'));
  const configPath = path.join(dir, 'config.json');
  const base = {
    name: 'rate-limit-config-test',
    backends: { x: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } },
    models: [{ id: 'a', backend: 'x', rateLimit: { maxConcurrent: 2 } }],
    aliases: { fast: { members: ['a'], rateLimit: '5/m' } }
  };
  await fs.writeFile(configPath, JSON.stringify(base));
  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.models[0].rateLimit, { maxConcurrent: 2, burst: 0, rateMs: null });
  assert.deepEqual(loaded.aliases.fast.rateLimit, { maxConcurrent: null, burst: 4, rateMs: 12_000 });

  for (const mutation of [
    () => (base.aliases.fast.rateLimit = '5/x'),
    () => (base.aliases.fast.rateLimit = { rate: '5/m', burst: -2 }),
    () => (base.models[0].rateLimit = { rate: '5/m', maxConcurrent: 'lots' }),
    () => (base.models[0].rateLimit = 12)
  ]) {
    mutation();
    await fs.writeFile(configPath, JSON.stringify(base));
    await assert.rejects(loadConfig(configPath), /rateLimit/);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('a rate-limited alias returns 429 with retry-after and exposes limiter status', async () => {
  const fixture = await chatGateway(await chatFixture({ 'limited-alias': { members: ['model-a'], rateLimit: '2/m' } }));
  try {
    assert.equal((await fixture.chat('limited-alias')).status, 200);
    assert.equal((await fixture.chat('limited-alias')).status, 200, 'count semantics admit two');
    const third = await fixture.chat('limited-alias');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    const body = await third.json();
    assert.equal(body.error.code, 'MODEL_RATE_LIMITED');
    const routing = await fixture.routing();
    assert.equal(routing.rateLimits.length, 1);
    assert.equal(routing.rateLimits[0].id, 'limited-alias');
    assert.equal(routing.rateLimits[0].rateMs, 30_000);
    assert.equal(routing.rateLimits[0].rateLimited, true);
  } finally {
    await fixture.close();
  }
});

test('a model-level limit is shared by every alias that resolves to the model', async () => {
  const fixture = await chatGateway(
    await chatFixture(
      {
        'lane-one': { members: ['model-a'] },
        'lane-two': { members: ['model-a'] },
        direct: { members: ['model-a'], advertise: true }
      },
      { models: [{ id: 'model-a', kind: 'chat', backend: 'fixture', upstreamModel: 'fixture', rateLimit: '1/m' }] }
    )
  );
  try {
    assert.equal((await fixture.chat('lane-one')).status, 200);
    assert.equal((await fixture.chat('lane-two')).status, 429, 'the second lane draws from the same model budget');
    assert.equal((await fixture.chat('model-a')).status, 429, 'the direct id shares the budget');
    const routing = await fixture.routing();
    assert.deepEqual(
      routing.rateLimits.map((entry) => entry.id),
      ['model-a']
    );
  } finally {
    await fixture.close();
  }
});
test('a concurrency-limited alias queues excess requests and never exceeds the cap', async () => {
  let inFlight = 0;
  let maxSeen = 0;
  const fixture = await chatGateway(
    await chatFixture(
      { capped: { members: ['model-a'], rateLimit: { maxConcurrent: 2 } } },
      {
        handleUpstream: async (req, res) => {
          inFlight++;
          maxSeen = Math.max(maxSeen, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 150));
          req.resume();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} }));
          inFlight--;
        }
      }
    )
  );
  try {
    const requests = await Promise.all(Array.from({ length: 6 }, () => fixture.chat('capped')));
    for (const response of requests) assert.equal(response.status, 200);
    assert.equal(maxSeen, 2, 'upstream concurrency must stay at the configured cap');
    const status = await fixture.routing();
    assert.equal(status.rateLimits[0].maxConcurrent, 2);
  } finally {
    await fixture.close();
  }
});

test('a parent alias limit gates requests that traverse it and the child keeps its own', async () => {
  const fixture = await chatGateway(
    await chatFixture({
      parent: { members: ['child'], rateLimit: '1/m' },
      child: { members: ['model-a'], rateLimit: '5/m' },
      sibling: { members: ['model-a'] }
    })
  );
  try {
    assert.equal((await fixture.chat('parent')).status, 200);
    assert.equal(
      (await fixture.chat('parent')).status,
      429,
      'the second request through the parent is limited by the parent 1/m budget'
    );
    assert.equal((await fixture.chat('child')).status, 200, 'the child keeps its own 5/m budget');
    const routing = await fixture.routing();
    assert.deepEqual(routing.rateLimits.map((entry) => entry.id).sort(), ['child', 'parent']);
  } finally {
    await fixture.close();
  }
});

test('a client that disconnects while queued never reaches upstream and releases its slot', async () => {
  const upstreamHits = [];
  const fixture = await chatFixture({
    capped: { members: ['model-a'], rateLimit: { maxConcurrent: 1 } }
  });
  const { upstream } = fixture;
  upstream.removeAllListeners('request');
  upstream.on('request', async (req, res) => {
    upstreamHits.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 300));
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} }));
  });
  const { chat, close } = await chatGateway(fixture);
  try {
    const blocker = chat('capped');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const abort = new AbortController();
    const queued = chat('capped', { signal: abort.signal }).catch((error) => {
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await assert.rejects(queued, () => true, 'the aborted queued request rejects');
    assert.equal((await blocker).status, 200);
    assert.equal(upstreamHits.length, 1, 'the aborted request must never reach upstream');
  } finally {
    await close();
  }
});
