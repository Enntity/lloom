import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { RuntimeManager, RuntimeQueueError } from '../src/runtime-manager.mjs';
import { createLloomServer } from '../src/server.mjs';

test('an aborted queued request leaves admission immediately and never executes', async () => {
  const manager = new RuntimeManager({ runtimes: { limited: { maxConcurrency: 1 } } }, { logger: { error() {} } });
  let releaseBlockingSlot;
  const blockingSlot = manager.withSlot('limited', async () => {
    await new Promise((resolve) => {
      releaseBlockingSlot = resolve;
    });
  });
  const admissionAbort = new AbortController();
  const abortedQueuedSlot = manager.withSlot(
    'limited',
    async () => assert.fail('aborted queued request must never execute'),
    { signal: admissionAbort.signal }
  );

  await waitFor(() => manager.stateFor('limited').queuedRequests === 1);
  admissionAbort.abort(namedAbortError());

  await assert.rejects(abortedQueuedSlot, { name: 'AbortError' });
  assert.equal(manager.stateFor('limited').queuedRequests, 0);
  releaseBlockingSlot();
  await blockingSlot;
  assert.equal(manager.stateFor('limited').activeRequests, 0);
});

test('aborting one waiter preserves FIFO order for remaining requests', async () => {
  const manager = new RuntimeManager({ runtimes: { limited: { maxConcurrency: 1 } } }, { logger: { error() {} } });
  const order = [];
  let releaseBlockingSlot;
  const blockingSlot = manager.withSlot('limited', async () => {
    order.push('blocking');
    await new Promise((resolve) => {
      releaseBlockingSlot = resolve;
    });
  });
  const aborted = new AbortController();
  const canceled = manager.withSlot('limited', async () => order.push('canceled'), {
    signal: aborted.signal
  });
  const survivor = manager.withSlot('limited', async () => order.push('survivor'));

  await waitFor(() => manager.stateFor('limited').queuedRequests === 2);
  aborted.abort(namedAbortError());
  await assert.rejects(canceled, { name: 'AbortError' });
  assert.equal(manager.stateFor('limited').queuedRequests, 1);
  releaseBlockingSlot();
  await Promise.all([blockingSlot, survivor]);

  assert.deepEqual(order, ['blocking', 'survivor']);
});

test('a full runtime queue returns a retryable 429 instead of growing without bound', async () => {
  const manager = new RuntimeManager(
    {
      runtimes: {
        limited: {
          maxConcurrency: 1,
          maxQueuedRequests: 1,
          queueRetryAfterSeconds: 7
        }
      }
    },
    { logger: { error() {} } }
  );
  let releaseBlockingSlot;
  const blockingSlot = manager.withSlot('limited', async () => {
    await new Promise((resolve) => {
      releaseBlockingSlot = resolve;
    });
  });
  const queuedSlot = manager.withSlot('limited', async () => 'queued');

  await waitFor(() => manager.stateFor('limited').queuedRequests === 1);
  await assert.rejects(
    manager.withSlot('limited', async () => assert.fail('full queue request must never execute')),
    (error) =>
      error instanceof RuntimeQueueError &&
      error.code === 'RUNTIME_QUEUE_FULL' &&
      error.statusCode === 429 &&
      error.retryAfterSeconds === 7
  );
  assert.equal(manager.stateFor('limited').queuedRequests, 1);

  releaseBlockingSlot();
  assert.equal(await queuedSlot, 'queued');
  await blockingSlot;
});

test('a runtime queue waiter expires with retry guidance and is removed', async () => {
  const manager = new RuntimeManager(
    {
      runtimes: {
        limited: {
          maxConcurrency: 1,
          maxQueuedRequests: 2,
          queueTimeoutMs: 10,
          queueRetryAfterSeconds: 3
        }
      }
    },
    { logger: { error() {} } }
  );
  let releaseBlockingSlot;
  const blockingSlot = manager.withSlot('limited', async () => {
    await new Promise((resolve) => {
      releaseBlockingSlot = resolve;
    });
  });
  const timedOut = manager.withSlot('limited', async () => assert.fail('expired waiter must never execute'));

  await assert.rejects(
    timedOut,
    (error) =>
      error instanceof RuntimeQueueError &&
      error.code === 'RUNTIME_QUEUE_TIMEOUT' &&
      error.statusCode === 429 &&
      error.retryAfterSeconds === 3
  );
  assert.equal(manager.stateFor('limited').queuedRequests, 0);
  releaseBlockingSlot();
  await blockingSlot;
});

test('live concurrency increases release queued work without a runtime restart', async () => {
  const config = { runtimes: { limited: { enabled: true, maxConcurrency: 1 } } };
  const manager = new RuntimeManager(structuredClone(config), { logger: { error() {} } });
  const releaseFirst = await manager.acquireSlot('limited');
  const queuedRelease = manager.acquireSlot('limited');
  await waitFor(() => manager.stateFor('limited').queuedRequests === 1);

  const nextConfig = structuredClone(config);
  nextConfig.runtimes.limited.maxConcurrency = 2;
  const result = await manager.reconfigure(nextConfig);
  const releaseSecond = await queuedRelease;

  assert.deepEqual(result, {
    changed: [],
    liveAdmissionChanged: ['limited'],
    results: []
  });
  assert.equal(manager.stateFor('limited').activeRequests, 2);
  assert.equal(manager.stateFor('limited').queuedRequests, 0);
  releaseFirst();
  releaseSecond();
});

test('live concurrency decreases do not admit another waiter above the new cap', async () => {
  const config = { runtimes: { limited: { enabled: true, maxConcurrency: 3 } } };
  const manager = new RuntimeManager(structuredClone(config), { logger: { error() {} } });
  const releases = await Promise.all([
    manager.acquireSlot('limited'),
    manager.acquireSlot('limited'),
    manager.acquireSlot('limited')
  ]);
  const queuedRelease = manager.acquireSlot('limited');
  await waitFor(() => manager.stateFor('limited').queuedRequests === 1);

  const nextConfig = structuredClone(config);
  nextConfig.runtimes.limited.maxConcurrency = 2;
  await manager.reconfigure(nextConfig);
  releases.shift()();
  assert.equal(manager.stateFor('limited').activeRequests, 2);
  assert.equal(manager.stateFor('limited').queuedRequests, 1);

  releases.shift()();
  const admittedRelease = await queuedRelease;
  assert.equal(manager.stateFor('limited').activeRequests, 2);
  assert.equal(manager.stateFor('limited').queuedRequests, 0);
  releases.shift()();
  admittedRelease();
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function namedAbortError() {
  return Object.assign(new Error('client closed'), { name: 'AbortError' });
}

test('interactive work overtakes FIFO background work with bounded fairness', async () => {
  const manager = new RuntimeManager({ runtimes: { limited: { maxConcurrency: 1, maxQueuedRequests: 10 } } });
  const release = await manager.acquireSlot('limited');
  const order = [];
  const requests = ['a', 'b'].map((name) => manager.withSlot('limited', async () => order.push(name)));
  for (let i = 1; i <= 5; i++) {
    requests.push(manager.withSlot('limited', async () => order.push(`i${i}`), { requestClass: 'interactive' }));
  }
  release();
  await Promise.all(requests);
  assert.deepEqual(order, ['i1', 'i2', 'i3', 'i4', 'a', 'i5', 'b']);
  assert.equal(manager.stateFor('limited').activeInteractiveRequests, 0);
  assert.equal(manager.stateFor('limited').activeRequests, 0);
});

test('a reserved slot stays available to interaction while standard work waits', async () => {
  const manager = new RuntimeManager({ runtimes: { limited: { maxConcurrency: 2, interactiveReservedSlots: 1 } } });
  const releaseBackground = await manager.acquireSlot('limited');
  const queued = manager.acquireSlot('limited');
  assert.equal(manager.stateFor('limited').queuedRequests, 1);
  const releaseInteractive = await manager.acquireSlot('limited', { requestClass: 'interactive' });
  assert.equal(manager.stateFor('limited').activeRequests, 2);
  releaseInteractive();
  releaseInteractive(); // A repeated transport cleanup must not free another request's slot.
  assert.equal(manager.stateFor('limited').activeRequests, 1);
  assert.equal(manager.stateFor('limited').queuedRequests, 1);
  releaseBackground();
  const releaseQueued = await queued;
  releaseQueued();
  assert.equal(manager.stateFor('limited').activeRequests, 0);
});

test('reserved queue capacity rejects standard overflow but accepts interaction within the total cap', async () => {
  const manager = new RuntimeManager({
    runtimes: {
      limited: {
        maxConcurrency: 1,
        maxQueuedRequests: 2,
        interactiveReservedQueueSlots: 1
      }
    }
  });
  const release = await manager.acquireSlot('limited');
  const standard = manager.acquireSlot('limited');
  await assert.rejects(
    manager.withSlot('limited', () => assert.fail('must not run'), { requestClass: 'urgent' }),
    (error) => error.statusCode === 429 && error.code === 'RUNTIME_QUEUE_FULL'
  );
  const interactive = manager.acquireSlot('limited', { requestClass: 'interactive' });
  await assert.rejects(
    manager.withSlot('limited', () => assert.fail('must not run'), { requestClass: 'interactive' }),
    (error) => error.statusCode === 429
  );
  assert.equal(manager.stateFor('limited').queuedRequests, 2);
  release();
  (await interactive)();
  (await standard)();
});

test('interactive cancellation and provider failure preserve slot accounting through pause and resume', async () => {
  const manager = new RuntimeManager({ runtimes: { limited: { maxConcurrency: 2, interactiveReservedSlots: 1 } } });
  manager.pausedRuntimes.add('limited');
  const abort = new AbortController();
  const canceled = manager.withSlot('limited', () => assert.fail('must not run'), {
    requestClass: 'interactive',
    signal: abort.signal
  });
  const cancellation = assert.rejects(canceled, { name: 'AbortError' });
  abort.abort(namedAbortError());
  await cancellation;
  const standard = manager.acquireSlot('limited');
  const waiting = manager.acquireSlot('limited');
  const failure = manager.withSlot(
    'limited',
    () => {
      throw new Error('provider failed');
    },
    { requestClass: 'interactive' }
  );
  const failed = assert.rejects(failure, /provider failed/);
  manager.resumeRuntime('limited');
  const release = await standard;
  await failed;
  assert.equal(manager.stateFor('limited').activeInteractiveRequests, 0);
  assert.equal(manager.stateFor('limited').activeRequests, 1);
  assert.equal(manager.stateFor('limited').queuedRequests, 1);
  release();
  (await waiting)();
});

test('reservation changes are live, clamp to capacity, and preserve already active requests', async () => {
  const config = { runtimes: { limited: { enabled: true, maxConcurrency: 2, maxQueuedRequests: 2 } } };
  const manager = new RuntimeManager(structuredClone(config));
  const first = await manager.acquireSlot('limited');
  const second = await manager.acquireSlot('limited');
  const queued = manager.acquireSlot('limited');
  const reserved = structuredClone(config);
  reserved.runtimes.limited.interactiveReservedSlots = 99;
  reserved.runtimes.limited.interactiveReservedQueueSlots = 99;
  const result = await manager.reconfigure(reserved);
  assert.deepEqual(result, { changed: [], liveAdmissionChanged: ['limited'], results: [] });
  assert.equal(manager.stateFor('limited').activeRequests, 2);
  first();
  assert.equal(manager.stateFor('limited').queuedRequests, 1);
  const interactive = await manager.acquireSlot('limited', { requestClass: 'interactive' });
  second();
  (await queued)();
  interactive();
  const single = new RuntimeManager({ runtimes: { limited: { maxConcurrency: 1, interactiveReservedSlots: 99 } } });
  const normal = await single.acquireSlot('limited');
  normal();
});

test('gateway embeddings carry interactive admission through to completed metrics', { timeout: 10000 }, async (t) => {
  const upstreamHeaders = [];
  const upstream = http.createServer((req, res) => {
    upstreamHeaders.push(req.headers);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [1, 0] }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const config = {
    name: 'interactive-admission-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    defaults: { embeddingModel: 'memory' },
    backends: { fixture: { type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` } },
    models: [{ id: 'memory', kind: 'embedding', backend: 'fixture', runtime: 'limited', upstreamModel: 'fixture' }],
    runtimes: { limited: { enabled: true, maxConcurrency: 2, interactiveReservedSlots: 1 } }
  };
  const manager = new RuntimeManager(config);
  // The fixture backend is already running; lifecycle is separate from queue admission.
  manager.ensure = async () => ({ healthy: true });
  manager.isHealthy = async () => true;
  const app = createLloomServer(config, { runtimeManager: manager, logger: { error() {}, warn() {} } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close({ stopRuntimes: false }));
  const release = await manager.acquireSlot('limited');
  t.after(release);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const request = (requestClass) =>
    fetch(`http://127.0.0.1:${app.server.address().port}/v1/embeddings`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'content-type': 'application/json', 'x-lloom-request-class': requestClass },
      body: JSON.stringify({ model: 'memory', input: ['synthetic recall'] })
    });
  const standard = request('unknown');
  standard.catch(() => {});
  await Promise.race([
    waitFor(() => manager.stateFor('limited').queuedRequests === 1),
    standard.then(async (response) =>
      assert.fail(`standard request completed before queueing: ${response.status} ${await response.text()}`)
    )
  ]);
  const interactive = await request('interactive');
  assert.equal(interactive.status, 200);
  assert.deepEqual((await interactive.json()).data[0].embedding, [1, 0]);
  assert.equal(manager.stateFor('limited').queuedRequests, 1, 'background must still be waiting');
  const recent = app.metrics.snapshot().recent;
  assert.equal(recent.at(-1).requestClass, 'interactive');
  assert.ok(Number.isFinite(recent.at(-1).queueWaitMs));
  assert.ok(recent.at(-1).queueWaitMs >= 0);
  assert.equal(upstreamHeaders.length, 1);
  assert.equal(
    upstreamHeaders[0]['x-lloom-request-class'],
    undefined,
    'gateway metadata stays out of provider headers'
  );
  release();
  assert.equal((await standard).status, 200);
  await waitFor(() => app.metrics.snapshot().recent.length === 2);
  assert.equal(app.metrics.snapshot().recent.at(-1).requestClass, 'standard');
  assert.ok(app.metrics.snapshot().recent.at(-1).queueWaitMs >= recent.at(-1).queueWaitMs);
});
