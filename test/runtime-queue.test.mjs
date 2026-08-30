import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeManager, RuntimeQueueError } from '../src/runtime-manager.mjs';

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
