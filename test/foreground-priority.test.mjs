import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { ForegroundPriority } from '../src/foreground-priority.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createLloomServer } from '../src/server.mjs';

test('configuration validates the foreground idle interval', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-foreground-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  for (const foregroundIdleMs of [0, 60_000, 3_600_000]) {
    await fs.writeFile(file, JSON.stringify({ server: { foregroundIdleMs }, models: [], backends: {}, runtimes: {} }));
    assert.equal((await loadConfig(file)).server.foregroundIdleMs, foregroundIdleMs);
  }
  for (const foregroundIdleMs of [-1, 3_600_001, '60000', 1.5]) {
    await fs.writeFile(file, JSON.stringify({ server: { foregroundIdleMs }, models: [], backends: {}, runtimes: {} }));
    await assert.rejects(loadConfig(file), /server.foregroundIdleMs/);
  }
});

test('foreground cancels background and holds until the last overlapping chat has been idle', () => {
  let now = 1000;
  const gate = new ForegroundPriority({ now: () => now });
  const background = gate.begin('standard');
  const first = gate.begin('foreground');
  assert.equal(background.signal.reason.code, 'INTERACTIVE_PRIORITY');
  now += 120_000;
  assert.throws(() => gate.begin('standard'), { code: 'INTERACTIVE_PRIORITY' });
  const second = gate.begin('foreground');
  first.release();
  first.release();
  now += 120_000;
  assert.throws(() => gate.begin('standard'));
  second.release();
  now += 59_999;
  assert.throws(() => gate.begin('standard'));
  now++;
  gate.begin('standard').release();
  background.release();
  assert.equal(gate.background.size, 0);
});

test('a follow-up renews the hold and lower-priority interactive work stays paused', () => {
  let now = 1000;
  const gate = new ForegroundPriority({ idleMs: () => 100, now: () => now });
  gate.begin('foreground').release();
  now += 99;
  assert.throws(() => gate.begin('interactive'), { code: 'INTERACTIVE_PRIORITY' });
  gate.begin('foreground').release();
  now += 99;
  assert.throws(() => gate.begin('standard'));
  now++;
  gate.begin('standard').release();
});

test('foreground cancels legacy interactive work as well as standard work', () => {
  const gate = new ForegroundPriority();
  const lowerPriority = gate.begin('interactive');
  const chat = gate.begin('foreground');
  assert.equal(lowerPriority.signal.reason.code, 'INTERACTIVE_PRIORITY');
  lowerPriority.release();
  chat.release();
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(predicate) {
  const until = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, { managed = true, idleMs = 100 } = {}) {
  const hits = [];
  const held = [];
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    hits.push({ headers: req.headers, body });
    if (body.messages?.[0]?.content === 'hold') {
      held.push(res);
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }] })
    );
  });
  const providerUrl = await listen(provider);
  const config = {
    server: { host: '127.0.0.1', port: 0, foregroundIdleMs: idleMs },
    security: { apiKeys: ['fixture-key'], allowMissingAuth: false },
    logging: { metricsPersistence: false },
    backends: { provider: { type: 'openai', baseUrl: `${providerUrl}/v1` } },
    models: ['chat', 'other'].map((id) => ({
      id,
      backend: 'provider',
      upstreamModel: id,
      ...(managed ? { runtime: 'limited' } : {})
    })),
    runtimes: managed ? { limited: { enabled: true, maxConcurrency: 1 } } : {}
  };
  const manager = new RuntimeManager(config, { logger: { error() {}, warn() {} } });
  manager.isHealthy = async () => true;
  const gateway = createLloomServer(config, { runtimeManager: manager, logger: { error() {}, warn() {} } });
  const url = await listen(gateway.server);
  t.after(async () => {
    held.forEach((res) => res.end());
    await gateway.close({ stopRuntimes: false, httpGraceMs: 0 });
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });
  return {
    hits,
    held,
    manager,
    gateway,
    config,
    url,
    request({
      requestClass = 'standard',
      content = 'answer',
      stream = false,
      auth = 'fixture-key',
      signal,
      model = 'chat'
    } = {}) {
      return fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth}`,
          'x-lloom-request-class': requestClass
        },
        body: JSON.stringify({ model, stream, messages: [{ role: 'user', content }] })
      });
    }
  };
}

test('foreground on one model interrupts and holds requests for other models', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { managed: false });
  const background = f.request({ model: 'other', content: 'hold' });
  await waitFor(() => f.held.length === 1);
  assert.equal((await f.request({ requestClass: 'foreground' })).status, 200);
  assert.equal((await background).status, 409);
  assert.equal((await f.request({ model: 'other' })).status, 409);
  assert.equal(f.hits.length, 2);
  const observed = f.gateway.metrics.snapshot();
  assert.equal(observed.totals.errors, 0);
  assert.equal(observed.performance.models.chat.errors, 0);
  assert.ok(observed.recent.some((entry) => entry.interrupted && entry.errorCode === 'INTERACTIVE_PRIORITY'));
});

test(
  'preempted requests stop waiting for shared cold startup and never dispatch afterward',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    let healthy = false;
    let started = false;
    let finishStartup;
    f.manager.isHealthy = async () => healthy;
    f.manager.ensure = () => {
      started = true;
      return new Promise((resolve) => {
        finishStartup = () => {
          healthy = true;
          resolve({ healthy: true });
        };
      });
    };
    const background = f.request({ content: 'hold' });
    await waitFor(() => started);
    const chat = f.request({ requestClass: 'foreground' });
    assert.equal((await background).status, 409, 'interruption does not wait for cold startup');
    assert.equal(f.hits.length, 0);
    finishStartup();
    assert.equal((await chat).status, 200);
    assert.equal(f.hits.length, 1, 'canceled request never runs after the shared startup completes');
  }
);

for (const managed of [true, false]) {
  for (const stream of [true, false]) {
    test(
      `foreground aborts ${managed ? 'managed' : 'unmanaged'} ${stream ? 'streamed' : 'buffered'} background work`,
      { timeout: 10_000 },
      async (t) => {
        const f = await fixture(t, { managed });
        const background = f.request({ content: 'hold', stream });
        await waitFor(() => f.held.length === 1);
        let body;
        if (stream) body = (await background).text();
        const chat = await f.request({ requestClass: 'foreground' });
        assert.equal(chat.status, 200, await chat.clone().text());
        const interrupted = stream ? await body : await (await background).text();
        assert.match(interrupted, /INTERACTIVE_PRIORITY/);
        await waitFor(() => f.held[0].destroyed);
        const held = await f.request();
        assert.equal(held.status, 409);
        assert.equal(held.headers.get('x-lloom-error-code'), 'INTERACTIVE_PRIORITY');
        assert.ok(Number(held.headers.get('retry-after')) >= 1);
        assert.equal(f.hits.length, 2);
        assert.equal(f.hits[1].headers['x-lloom-request-class'], undefined);
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal((await f.request()).status, 200);
        if (managed) assert.equal(f.manager.stateFor('limited').activeRequests, 0);
      }
    );
  }
}

test('foreground removes queued background requests before they dispatch', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const running = f.request({ content: 'hold' });
  await waitFor(() => f.hits.length === 1);
  const queued = f.request();
  await waitFor(() => f.manager.stateFor('limited').queuedRequests === 1);
  assert.equal((await f.request({ requestClass: 'foreground' })).status, 200);
  assert.equal((await running).status, 409);
  assert.equal((await queued).status, 409);
  assert.equal(f.hits.length, 2);
  assert.equal(f.manager.stateFor('limited').queuedRequests, 0);
});

test('unauthorized priority requests cannot interrupt background work', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { managed: false });
  const controller = new AbortController();
  const running = f.request({ content: 'hold', signal: controller.signal });
  running.catch(() => {});
  await waitFor(() => f.hits.length === 1);
  assert.equal((await f.request({ requestClass: 'foreground', auth: 'invalid' })).status, 401);
  assert.equal(f.held[0].destroyed, false);
  controller.abort();
  await assert.rejects(running);
});

test(
  'a canceled foreground request releases its window after idle, while health remains available',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const running = f.request({ requestClass: 'foreground', content: 'hold', signal: controller.signal });
    running.catch(() => {});
    await waitFor(() => f.held.length === 1);
    assert.equal((await fetch(`${f.url}/health`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await f.request()).status, 409, 'active chat does not expire');
    controller.abort();
    await assert.rejects(running);
    await waitFor(() => f.held[0].destroyed);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await f.request()).status, 200);
  }
);
