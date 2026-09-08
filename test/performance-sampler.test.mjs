import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createPerformanceSampler } from '../src/performance-sampler.mjs';
import { createLloomServer } from '../src/server.mjs';

const candidate = (id, runtime) => ({ resolvedId: id, model: { id, runtime } });
const success = (model, durationMs, extra = {}) => ({ model, ok: true, durationMs, ...extra });

test('bounded recent stats expire and isolate concrete models from aliases', () => {
  let time = 100;
  const sampler = createPerformanceSampler({ now: () => time, windowMs: 1000, maxSamples: 2 });
  for (const duration of [10, 20, 30]) sampler.record(success('alias', duration, { resolvedModel: 'a' }));
  assert.equal(sampler.stats('a').meanDurationMs, 25);
  assert.equal(sampler.stats('alias').samples, 0);
  sampler.record({ model: 'a', ok: false, durationMs: 1 });
  assert.equal(sampler.stats('a').meanDurationMs, 30);
  assert.equal(sampler.stats('a').errors, 1);
  time += 1000;
  assert.equal(sampler.stats('a').samples, 0);
});

test('selection learns all members, uses speed, accounts for shared load, and retries stale members', () => {
  let time = 0;
  const sampler = createPerformanceSampler({ now: () => time, windowMs: 1000 });
  const pool = [candidate('a', 'shared'), candidate('b')];
  sampler.record(success('a', 100));
  assert.equal(sampler.rank(pool)[0].resolvedId, 'b');
  sampler.record(success('b', 150));
  assert.equal(sampler.rank(pool)[0].resolvedId, 'a');
  sampler.begin('1', { model: 'another-model', runtime: 'shared' });
  assert.equal(sampler.rank(pool)[0].resolvedId, 'b');
  sampler.end('1');
  assert.equal(sampler.rank(pool)[0].resolvedId, 'a');
  assert.equal(sampler.rank(pool, { runtimes: { shared: { queuedRequests: 2 } } })[0].resolvedId, 'b');
  time = 900;
  sampler.record(success('a', 100));
  time = 1001;
  assert.equal(sampler.rank(pool)[0].resolvedId, 'b');
});

test('completion and first-token metrics choose differently; buffered samples never invent TTFT', () => {
  const sampler = createPerformanceSampler();
  sampler.record(
    success('a', 1100, { stream: true, firstContentMs: 100, lastContentMs: 1100, usage: { output_tokens: 11 } })
  );
  sampler.record(
    success('b', 600, { stream: true, firstContentMs: 500, lastContentMs: 600, usage: { output_tokens: 11 } })
  );
  const pool = [candidate('a'), candidate('b')];
  assert.equal(sampler.rank(pool, { metric: 'first-token' })[0].resolvedId, 'a');
  assert.equal(sampler.rank(pool, { outputTokens: 100 })[0].resolvedId, 'b');
  sampler.record(success('buffered', 50, { firstContentMs: 50 }));
  assert.equal(sampler.stats('buffered').meanFirstContentMs, null);
});

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });

test('gateway samples buffered and streaming calls, balances concurrent load, and preserves ordered aliases', async () => {
  const hits = [];
  let failA = false;
  let release;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const backend = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    hits.push(body.model);
    if (failA && body.model === 'a') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unavailable' } }));
      return;
    }
    if (body.messages?.[0]?.content === 'hold') {
      notifyStarted();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'test', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`
      );
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'test',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    }
  });
  const port = await listen(backend);
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    defaults: { chatModel: 'fast' },
    aliases: {
      fast: { members: ['a', 'b'], strategy: 'fastest' },
      ordered: { members: ['a', 'b'] },
      suspended: { members: ['a', 'b'], strategy: 'fastest', suspendedMembers: ['a'] }
    },
    backends: { test: { type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` } },
    models: ['a', 'b'].map((id) => ({ id, backend: 'test', kind: 'chat', contextWindow: 8192 })),
    runtimes: {}
  };
  const runtimeManager = {
    async ensure() {},
    withSlot: (_id, fn) => fn(),
    async status() {
      return { runtimes: {} };
    },
    noteRequestOutcome() {}
  };
  const app = createLloomServer(config, { runtimeManager, logger: { error() {}, warn() {} } });
  const gateway = await listen(app.server);
  const request = async (model, stream = false, content = 'hello') => {
    const response = await fetch(`http://127.0.0.1:${gateway}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content }] })
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    await request('a');
    await request('b', true);
    assert.equal(app.metrics.snapshot().performance.models.a.successes, 1);
    assert.equal(app.metrics.snapshot().performance.models.b.successes, 1);
    // Deterministic performance history avoids wall-clock timing assertions.
    for (let i = 0; i < 256; i++) {
      app.metrics.record(success('a', 100));
      app.metrics.record(success('b', 150));
    }
    const body = JSON.parse(await request('fast'));
    assert.equal(hits.at(-1), 'a');
    assert.equal(body.model, 'fast');
    const held = request('fast', false, 'hold');
    await started;
    await request('fast', true);
    assert.equal(hits.at(-1), 'b');
    await request('ordered');
    assert.equal(hits.at(-1), 'a');
    await request('suspended');
    assert.equal(hits.at(-1), 'b');
    release();
    await held;
    failA = true;
    const beforeFailure = hits.length;
    await request('fast');
    assert.deepEqual(hits.slice(beforeFailure), ['a', 'b']);
    await request('fast');
    assert.equal(hits.at(-1), 'b');
    assert.equal(app.metrics.snapshot().performance.models.a.errors, 1);
    const response = await fetch(`http://127.0.0.1:${gateway}/gateway/metrics/models/a`);
    const metrics = await response.json();
    assert.deepEqual(Object.keys(metrics.performance.models), ['a']);
    assert.equal(metrics.performance.models.a.activeRequests, 0);
  } finally {
    release?.();
    await close(app.server);
    await close(backend);
  }
});

test('configuration accepts fastest aliases and rejects misspelled policies', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lloom-perf-config-'));
  const file = path.join(directory, 'config.json');
  const config = {
    backends: { test: { baseUrl: 'http://127.0.0.1:1/v1' } },
    models: [{ id: 'a', backend: 'test' }],
    aliases: { fast: { members: ['a'], strategy: 'fastest', performanceMetric: 'first-token' } }
  };
  try {
    await writeFile(file, JSON.stringify(config));
    assert.equal((await loadConfig(file)).aliases.fast.strategy, 'fastest');
    config.aliases.fast.strategy = 'fastset';
    await writeFile(file, JSON.stringify(config));
    await assert.rejects(loadConfig(file), /strategy must be ordered or fastest/);
    config.aliases.fast.strategy = 'fastest';
    config.aliases.fast.performanceMetric = 'tokens';
    await writeFile(file, JSON.stringify(config));
    await assert.rejects(loadConfig(file), /performanceMetric must be completion or first-token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
