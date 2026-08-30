import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeManager } from '../src/runtime-manager.mjs';

test('an aborted queued request leaves admission immediately and never executes', async () => {
  const manager = new RuntimeManager(
    { runtimes: { limited: { maxConcurrency: 1 } } },
    { logger: { error() {} } }
  );
  let releaseBlockingSlot;
  const blockingSlot = manager.withSlot('limited', async () => {
    await new Promise((resolve) => { releaseBlockingSlot = resolve; });
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
  const manager = new RuntimeManager(
    { runtimes: { limited: { maxConcurrency: 1 } } },
    { logger: { error() {} } }
  );
  const order = [];
  let releaseBlockingSlot;
  const blockingSlot = manager.withSlot('limited', async () => {
    order.push('blocking');
    await new Promise((resolve) => { releaseBlockingSlot = resolve; });
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
