import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLloomServer } from '../src/server.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';

const listen = async (s) => {
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${s.address().port}`;
};
const until = async (predicate, message) => {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
async function fixture(t, override = {}) {
  const { foregroundIdleMs = 30, maxConcurrency = 2, modelRateLimit, ...scheduling } = override;
  const hits = [];
  const held = new Map();
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    const name = b.messages?.[0]?.content;
    hits.push(name);
    if (name?.startsWith('hold')) {
      held.set(name, res);
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'prefix' } }] })}\n\n`);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: name }, finish_reason: 'stop' }] }));
  });
  const providerUrl = await listen(provider);
  const config = {
    server: {
      host: '127.0.0.1',
      port: 0,
      foregroundIdleMs,
      requestScheduling: { backgroundMaxConcurrency: 1, rampIntervalMs: 25, ...scheduling }
    },
    security: { allowMissingAuth: false, apiKeys: ['fixture-only'] },
    logging: { metricsPersistence: false },
    backends: {
      synthetic: { type: 'openai', baseUrl: `${providerUrl}/v1` },
      independent: { type: 'openai', baseUrl: `${providerUrl}/v1` }
    },
    models: [
      {
        id: 'chat',
        backend: 'synthetic',
        upstreamModel: 'chat',
        runtime: 'limited',
        ...(modelRateLimit ? { rateLimit: modelRateLimit } : {})
      },
      { id: 'cloud', backend: 'independent', upstreamModel: 'cloud' },
      { id: 'cold', backend: 'synthetic', runtime: 'cold-runtime', upstreamModel: 'cold' }
    ],
    aliases: { 'other-group': { members: ['chat'] } },
    runtimes: { limited: { enabled: true, maxConcurrency }, 'cold-runtime': { enabled: true, maxConcurrency: 1 } }
  };
  const manager = new RuntimeManager(config, { logger: { error() {}, warn() {} } });
  manager.isHealthy = async () => true;
  const app = createLloomServer(config, { runtimeManager: manager, logger: { error() {}, warn() {} } });
  const url = await listen(app.server);
  t.after(async () => {
    for (const res of held.values()) res.end();
    if (app.server.listening) await app.close({ stopRuntimes: false, httpGraceMs: 0 });
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });
  return {
    hits,
    held,
    app,
    config,
    manager,
    request(
      name,
      {
        model = 'chat',
        requestClass = 'standard',
        agent = 'enntity-runtime/0.2.0',
        stream = false,
        signal = AbortSignal.timeout(5000)
      } = {}
    ) {
      return fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fixture-only',
          'user-agent': agent,
          ...(requestClass == null ? {} : { 'x-lloom-request-class': requestClass })
        },
        body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: name }] })
      });
    },
    finish(name, stream = false) {
      const res = held.get(name);
      assert.ok(res, `held ${name}`);
      if (stream)
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'suffix' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
        );
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: name }, finish_reason: 'stop' }] })
        );
      }
      held.delete(name);
    }
  };
}

test(
  'adaptive cold startup keeps the accepted connection waiting until the runtime is healthy',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    f.config.runtimes.limited.requestStartupWaitMs = 1;
    let healthy = false;
    let starts = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.manager.isHealthy = async () => healthy;
    f.manager.ensure = async () => {
      starts++;
      await gate;
      healthy = true;
      return { runtimeId: 'limited', started: true, healthy: true };
    };
    let settled = false;
    const request = f.request('cold-start', { requestClass: 'foreground' }).then((response) => {
      settled = true;
      return response;
    });
    await until(() => starts === 1, 'startup began');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false, 'startup does not return the old retry response');
    assert.deepEqual(f.hits, []);
    release();
    assert.equal((await request).status, 200);
    assert.deepEqual(f.hits, ['cold-start']);
    assert.equal(starts, 1);
  }
);

test(
  'higher demand arriving during a background health probe prevents its cold start',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    let releaseProbe;
    const probe = new Promise((resolve) => {
      releaseProbe = resolve;
    });
    let probes = 0;
    let starts = 0;
    f.manager.isHealthy = async () => {
      const first = ++probes === 1;
      if (first) await probe;
      return !first;
    };
    f.manager.ensure = async () => {
      starts++;
      throw new Error('background must not start during higher demand');
    };
    const background = f.request('background-after-probe');
    await until(() => probes === 1, 'background probe began');
    const foreground = f.request('hold-foreground', { requestClass: 'foreground' });
    await until(() => f.held.has('hold-foreground'), 'foreground began');
    releaseProbe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(starts, 0);
    assert.deepEqual(f.hits, ['hold-foreground']);
    f.finish('hold-foreground');
    assert.equal((await foreground).status, 200);
    assert.equal((await background).status, 200);
    assert.equal(starts, 0);
  }
);

test(
  'adaptive requests retry known lifecycle contention without duplicate inference',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    let starts = 0;
    let healthy = false;
    f.manager.isHealthy = async () => healthy;
    f.manager.ensure = async () => {
      const code = ['RUNTIME_ADMISSION_BUSY', 'RUNTIME_ADMISSION_PREEMPTED'][starts++];
      if (code) throw Object.assign(new Error('synthetic lifecycle contention'), { code });
      healthy = true;
      return { runtimeId: 'limited', started: true, healthy: true };
    };
    assert.equal((await f.request('cold-contention', { requestClass: 'foreground' })).status, 200);
    assert.equal(starts, 3);
    assert.deepEqual(f.hits, ['cold-contention']);
  }
);

test(
  'unmodified coding client wins admission; connected background completes exactly once after idle',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const background = f.request('hold-background');
    await until(() => f.held.has('hold-background'), 'background started');
    const foreground = f.request('hold-coding', { requestClass: null, agent: 'codex_cli_rs/fixture' });
    await until(() => f.held.has('hold-coding'), 'coding request admitted');
    const queued = f.request('queued-background');
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(!f.hits.includes('queued-background'));
    f.finish('hold-background');
    assert.equal((await background).status, 200, 'active background is preserved');
    assert.ok(!f.hits.includes('queued-background'));
    f.finish('hold-coding');
    assert.equal((await foreground).status, 200);
    assert.equal((await queued).status, 200);
    assert.equal(f.hits.filter((v) => v === 'queued-background').length, 1);
    assert.ok(f.app.metrics.snapshot().recent.some((r) => r.requestClass === 'foreground'));
  }
);

test('active background SSE reaches clean completion while foreground runs', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const stream = await f.request('hold-stream', { stream: true });
  assert.equal(stream.status, 200);
  const textPromise = stream.text();
  assert.equal((await f.request('foreground', { requestClass: 'foreground' })).status, 200);
  f.finish('hold-stream', true);
  const text = await textPromise;
  assert.match(text, /prefix/);
  assert.match(text, /suffix/);
  assert.match(text, /\[DONE\]/);
  assert.doesNotMatch(text, /INTERACTIVE_PRIORITY|"error"/);
});

test('invalid foreground request does not pause valid background work', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { foregroundIdleMs: 2000 });
  const missing = await f.request('missing', { model: 'does-not-exist', requestClass: 'foreground' });
  assert.ok(missing.status >= 400);
  const start = Date.now();
  assert.equal((await f.request('valid')).status, 200);
  assert.ok(Date.now() - start < 1000);
  assert.deepEqual(f.hits, ['valid']);
});

test(
  'single-slot runtime drains current work then admits foreground ahead of background',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { maxConcurrency: 1 });
    const active = f.request('hold-background');
    await until(() => f.held.has('hold-background'), 'background started');
    const queuedBackground = f.request('queued-background');
    const foreground = f.request('hold-foreground', { requestClass: 'foreground' });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(f.hits, ['hold-background']);
    f.finish('hold-background');
    assert.equal((await active).status, 200);
    await until(() => f.held.has('hold-foreground'), 'foreground won next slot');
    assert.deepEqual(f.hits, ['hold-background', 'hold-foreground']);
    f.finish('hold-foreground');
    assert.equal((await foreground).status, 200);
    assert.equal((await queuedBackground).status, 200);
  }
);

test(
  'foreground waits for hard rate budget and overtakes an older background budget waiter',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { backgroundMaxConcurrency: 4, modelRateLimit: { rate: '5/s', burst: 0 } });
    assert.equal((await f.request('initial-budget')).status, 200);
    const background = f.request('background-budget-wait');
    await new Promise((r) => setTimeout(r, 25));
    const foreground = f.request('foreground-budget-wait', { requestClass: 'foreground' });
    const high = await foreground;
    assert.equal(high.status, 200, 'priority never rejects because background spent the budget');
    assert.equal((await background).status, 200);
    assert.deepEqual(f.hits, ['initial-budget', 'foreground-budget-wait', 'background-budget-wait']);
  }
);

test('foreground on local compute does not pause independent cloud work', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const foreground = f.request('hold-foreground', { requestClass: 'foreground' });
  await until(() => f.held.has('hold-foreground'), 'foreground started');
  assert.equal((await f.request('independent', { model: 'cloud' })).status, 200);
  f.finish('hold-foreground');
  assert.equal((await foreground).status, 200);
});

test('cancelled queued background never reaches upstream', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const foreground = f.request('hold-foreground', { requestClass: 'foreground' });
  await until(() => f.held.has('hold-foreground'), 'foreground started');
  const controller = new AbortController();
  const queued = f.request('cancel-me', { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 15));
  controller.abort();
  await assert.rejects(queued, (e) => e.name === 'AbortError');
  f.finish('hold-foreground');
  await foreground;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!f.hits.includes('cancel-me'));
});

test('waiting background cannot occupy a model limiter slot ahead of foreground', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { maxConcurrency: 2, backgroundMaxConcurrency: 4, modelRateLimit: { maxConcurrent: 1 } });
  const active = f.request('hold-active');
  await until(() => f.held.has('hold-active'), 'first model limiter slot');
  const background = f.request('waiting-background');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const foreground = f.request('hold-foreground', { requestClass: 'foreground' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(f.hits, ['hold-active']);
  f.finish('hold-active');
  assert.equal((await active).status, 200);
  await until(() => f.held.has('hold-foreground'), 'foreground won shared concurrency limiter');
  assert.deepEqual(f.hits, ['hold-active', 'hold-foreground']);
  f.finish('hold-foreground');
  assert.equal((await foreground).status, 200);
  assert.equal((await background).status, 200);
  assert.deepEqual(f.hits, ['hold-active', 'hold-foreground', 'waiting-background']);
});

test('foreground queue admission cannot reenter and exceed runtime capacity', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { maxConcurrency: 1 });
  const active = f.request('hold-background');
  await until(() => f.held.has('hold-background'), 'background started');
  const first = f.request('hold-first', { requestClass: 'foreground' });
  await until(() => f.manager.queueFor('limited').length === 1, 'first foreground queued');
  const second = f.request('hold-second', { requestClass: 'foreground' });
  await until(() => f.manager.queueFor('limited').length === 2, 'second foreground queued');
  f.finish('hold-background');
  assert.equal((await active).status, 200);
  await until(() => f.held.has('hold-first'), 'first foreground admitted');
  assert.equal(f.manager.stateFor('limited').activeRequests, 1);
  assert.deepEqual(f.hits, ['hold-background', 'hold-first']);
  f.finish('hold-first');
  assert.equal((await first).status, 200);
  await until(() => f.held.has('hold-second'), 'second foreground admitted');
  assert.equal(f.manager.stateFor('limited').activeRequests, 1);
  f.finish('hold-second');
  assert.equal((await second).status, 200);
});

test(
  'lower runtime waiters yield residency and recheck health after a foreground cold start',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { maxConcurrency: 1, backgroundMaxConcurrency: 2 });
    let coldHealthy = false;
    let starts = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.manager.isHealthy = async (id) => id !== 'cold-runtime' || coldHealthy;
    f.manager.ensure = async () => {
      starts++;
      assert.equal(f.manager.queueFor('limited').length, 0, 'held lower work no longer pins residency');
      await gate;
      coldHealthy = true;
      return { started: true, healthy: true };
    };
    const active = f.request('hold-background');
    await until(() => f.held.has('hold-background'), 'active background');
    const queued = f.request('queued-background');
    await until(() => f.manager.queueFor('limited').length === 1, 'lower runtime waiter');
    const foreground = f.request('cold-foreground', { model: 'cold', requestClass: 'foreground' });
    await until(() => starts === 1, 'foreground loading');
    assert.equal(f.manager.queueFor('limited').length, 0);
    f.finish('hold-background');
    assert.equal((await active).status, 200);
    assert.deepEqual(f.hits, ['hold-background']);
    release();
    assert.equal((await foreground).status, 200);
    assert.equal((await queued).status, 200);
    assert.deepEqual(f.hits, ['hold-background', 'cold-foreground', 'queued-background']);
  }
);

test(
  'a configured admission deadline bounds cold startup without dispatching inference',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { queueTimeoutMs: 30 });
    let healthy = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.manager.isHealthy = async () => healthy;
    f.manager.ensure = async () => {
      await gate;
      healthy = true;
      return { started: true, healthy: true };
    };
    const response = await f.request('startup-deadline', { requestClass: 'foreground' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'REQUEST_SCHEDULING_TIMEOUT');
    assert.deepEqual(f.hits, []);
    release();
  }
);

test('shared model budgets withdraw lower runtime waiters across configured groups', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, {
    maxConcurrency: 1,
    backgroundMaxConcurrency: 2,
    modelRateLimit: { maxConcurrent: 1 },
    modelGroups: { chat: 'background-pool', 'other-group': 'foreground-pool' }
  });
  const active = f.request('hold-active');
  await until(() => f.held.has('hold-active'), 'active request');
  const background = f.request('background-waiter');
  await until(() => f.manager.queueFor('limited').length === 1, 'background runtime waiter');
  const foreground = f.request('hold-foreground', { model: 'other-group', requestClass: 'foreground' });
  await until(
    () => f.manager.queueFor('limited').length === 1 && f.manager.queueFor('limited')[0].foreground === true,
    'lower waiter relinquishes its runtime claim across groups'
  );
  f.finish('hold-active');
  assert.equal((await active).status, 200);
  await until(() => f.held.has('hold-foreground'), 'foreground admitted first');
  assert.deepEqual(f.hits, ['hold-active', 'hold-foreground']);
  f.finish('hold-foreground');
  assert.equal((await foreground).status, 200);
  assert.equal((await background).status, 200);
  assert.deepEqual(f.hits, ['hold-active', 'hold-foreground', 'background-waiter']);
});

test('shutdown cancels a pending cold-start admission without dispatching inference', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  let starting = false;
  f.manager.isHealthy = async () => false;
  f.manager.ensure = () =>
    f.manager.withRuntimeLifecycleLock(
      'limited',
      (signal) =>
        new Promise((resolve, reject) => {
          starting = true;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
  const pending = f.request('cold-start', { requestClass: 'foreground' }).catch(() => null);
  await until(() => starting, 'cold start began');
  await f.app.close({ stopRuntimes: false, httpGraceMs: 0 });
  const response = await pending;
  if (response) assert.equal(response.status, 503);
  assert.equal(f.manager.lifecycleControllers.size, 0);
  assert.deepEqual(f.hits, []);
});

for (const mode of ['interrupt', 'off']) {
  test(`${mode} preserves explicit-header-only caller classification`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { mode });
    const active = f.request('hold-background');
    await until(() => f.held.has('hold-background'), 'active background');
    const unmodified = await f.request('unmodified-codex', { requestClass: null, agent: 'codex_cli_rs/test' });
    assert.equal(unmodified.status, 200);
    assert.equal((await f.request('background-still-eligible')).status, 200);
    assert.deepEqual(f.hits, ['hold-background', 'unmodified-codex', 'background-still-eligible']);
    f.finish('hold-background');
    assert.equal((await active).status, 200);
  });
}

async function reloadFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-priority-reload-'));
  const configPath = path.join(directory, 'config.json');
  const base = {
    server: { host: '127.0.0.1', port: 0, requestScheduling: { mode: 'adaptive' } },
    security: { allowMissingAuth: true, apiKeys: [] },
    backends: { test: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } },
    models: [{ id: 'old', backend: 'test', rateLimit: { maxConcurrent: 1 } }],
    runtimes: {}
  };
  const events = [];
  const errors = [];
  const cleanup = [];
  const manager = {
    keepWarmRuntimeIds: () => [],
    startKeepWarm: async () => [],
    stopAll: async () => {
      events.push('stopAll');
    },
    reconfigure: async () => ({ changed: [] })
  };
  await fs.writeFile(configPath, JSON.stringify(base));
  const config = { ...structuredClone(base), sourcePath: configPath };
  const app = createLloomServer(config, {
    runtimeManager: manager,
    logger: {
      error(message) {
        errors.push(message);
      },
      warn() {},
      info(message) {
        events.push(message);
      }
    }
  });
  await app.listen();
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    for (const release of cleanup) release();
    if (app.server.listening) await app.close({ stopRuntimes: false, httpGraceMs: 0 });
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    base,
    config,
    manager,
    errors,
    events,
    cleanup,
    async read(route) {
      return (await fetch(`${url}${route}`)).json();
    },
    async reload(next) {
      await fs.writeFile(configPath, JSON.stringify(next));
      return fetch(`${url}/gateway/runtimes/keep-warm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reloadConfig: true })
      });
    }
  };
}

test(
  'failed hot reload restores the catalog and retains the prior scheduling policy and budget',
  { timeout: 10000 },
  async (t) => {
    const f = await reloadFixture(t);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.cleanup.push(release);
    let started = false;
    f.manager.reconfigure = async () => {
      started = true;
      await gate;
      throw new Error('synthetic reconfiguration rejected');
    };
    const pending = f.reload({
      ...f.base,
      server: { ...f.base.server, requestScheduling: { mode: 'off' } },
      models: [{ id: 'new', backend: 'test' }]
    });
    await until(() => started, 'reload reconciliation started');
    assert.deepEqual(
      (await f.read('/gateway/models')).models.map((model) => model.id),
      ['new']
    );
    const staged = await f.read('/gateway/routing');
    assert.equal(staged.requestScheduling.mode, 'adaptive');
    assert.equal(staged.rateLimits[0].id, 'old');
    release();
    await pending;
    assert.ok(f.errors.some((message) => message.includes('synthetic reconfiguration rejected')));
    assert.deepEqual(
      (await f.read('/gateway/models')).models.map((model) => model.id),
      ['old']
    );
    const retained = await f.read('/gateway/routing');
    assert.equal(retained.requestScheduling.mode, 'adaptive');
    assert.equal(retained.rateLimits[0].id, 'old');
  }
);

test('shutdown waits for a running reload and prevents its scheduling publication', { timeout: 10000 }, async (t) => {
  const f = await reloadFixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.cleanup.push(release);
  f.manager.reconfigure = async () => {
    f.events.push('reconfigure:start');
    await gate;
    f.events.push('reconfigure:end');
    return { changed: [] };
  };
  const pending = f
    .reload({ ...f.base, server: { ...f.base.server, requestScheduling: { mode: 'off' } } })
    .catch(() => null);
  await until(() => f.events.includes('reconfigure:start'), 'running reload');
  let closed = false;
  const closing = f.app.close({ httpGraceMs: 0 }).then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false, 'owned mutation settles before runtimes stop');
  release();
  await closing;
  await pending;
  assert.deepEqual(f.events, ['reconfigure:start', 'reconfigure:end', 'stopAll']);
  assert.equal(f.config.server.requestScheduling.mode, 'adaptive');
});
