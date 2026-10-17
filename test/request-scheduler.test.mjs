import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {
  RequestQueueOverflowError,
  RequestScheduler,
  RequestSchedulingTimeoutError,
  computeGroupForRequest,
  resolveRequestClass
} from '../src/request-scheduler.mjs';
import { loadConfig } from '../src/config.mjs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('capacity waits wake on demand, cancellation and close, cleaning up all listeners', async () => {
  const gate = scheduler();
  const demandWait = gate.waitForChange({ timeoutMs: 60_000 });
  const foreground = await gate.admit({ requestClass: 'foreground', groupId: 'local' });
  await demandWait;
  assert.equal(gate.changeWaiters.size, 0);
  assert.equal(gate.listeners.size, 0);
  const controller = new AbortController();
  const abortedWait = gate.waitForChange({ signal: controller.signal, timeoutMs: 60_000 });
  controller.abort();
  await abortedWait;
  assert.equal(gate.changeWaiters.size, 0);
  assert.equal(gate.listeners.size, 0);
  const closedWait = gate.waitForChange({ timeoutMs: 60_000 });
  gate.close();
  await closedWait;
  assert.equal(gate.changeWaiters.size, 0);
  assert.equal(gate.listeners.size, 0);
  foreground.release();
});

function scheduler({ now = () => Date.now(), ...settings } = {}) {
  return new RequestScheduler({
    mode: 'adaptive',
    now,
    settings: () => ({
      maxQueuedRequests: 16,
      queueTimeoutMs: 0,
      backgroundMaxConcurrency: 2,
      rampIntervalMs: 0,
      foregroundIdleMs: 50,
      ...settings
    })
  });
}

test('caller policy gives trusted credentials precedence and defaults coding clients to foreground', () => {
  const config = {
    server: {
      requestScheduling: {
        apiKeyEnv: { LLOOM_FOREGROUND_KEY: 'foreground' },
        clients: { 'batch-runner': 'standard' }
      }
    }
  };
  assert.equal(
    resolveRequestClass(
      { headers: { authorization: 'Bearer foreground', 'x-lloom-request-class': 'standard' } },
      {},
      { config, env: { LLOOM_FOREGROUND_KEY: 'foreground' } }
    ),
    'foreground'
  );
  assert.equal(
    resolveRequestClass({ headers: { 'user-agent': 'codex_cli_rs/fixture' } }, {}, { config }),
    'foreground'
  );
  assert.equal(
    resolveRequestClass({ headers: { 'x-lloom-client': 'batch-runner', 'user-agent': 'codex' } }, {}, { config }),
    'standard'
  );
  assert.equal(
    resolveRequestClass({ headers: { 'x-lloom-request-class': 'interactive' } }, {}, { config }),
    'interactive'
  );
  assert.equal(resolveRequestClass({ headers: { 'x-lloom-request-class': 'bogus' } }, {}, { config }), 'standard');
});

test('config validates scheduling bounds and class maps before applying them', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-request-scheduler-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const base = {
    server: {
      requestScheduling: {
        mode: 'adaptive',
        maxQueuedRequests: 0,
        queueTimeoutMs: 0,
        backgroundMaxConcurrency: 1,
        rampIntervalMs: 0,
        clients: { worker: 'standard' },
        apiKeyEnv: { FOREGROUND_KEY: 'foreground' },
        modelGroups: { chat: 'local' }
      }
    },
    models: [],
    backends: {},
    runtimes: {}
  };
  await fs.writeFile(file, JSON.stringify(base));
  assert.equal((await loadConfig(file)).server.requestScheduling.maxQueuedRequests, 0);
  for (const requestScheduling of [
    { mode: 'preempt' },
    { maxQueuedRequests: -1 },
    { queueTimeoutMs: 1.5 },
    { backgroundMaxConcurrency: 0 },
    { rampIntervalMs: 3_600_001 },
    { clients: { worker: 'elevated' } },
    { apiKeyEnv: { KEY: 'elevated' } },
    { modelGroups: { chat: '   ' } }
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...base, server: { requestScheduling } }));
    await assert.rejects(loadConfig(file), /server\.requestScheduling/);
  }
});

test('compute groups isolate federated nodes and unmanaged backends while sharing managed local capacity', () => {
  const config = {
    cluster: { nodeId: 'local' },
    runtimes: { managed: { enabled: true }, disabled: { enabled: false } },
    server: { requestScheduling: { modelGroups: { alias: 'shared' } } }
  };
  assert.equal(
    computeGroupForRequest(config, {
      requestedId: 'alias',
      model: { id: 'model', runtime: 'managed', backend: 'local' }
    }),
    'shared'
  );
  assert.equal(computeGroupForRequest(config, { model: { runtime: 'managed', backend: 'local' } }), 'local');
  assert.equal(computeGroupForRequest(config, { model: { runtime: 'disabled', backend: 'local' } }), 'backend:local');
  assert.equal(computeGroupForRequest(config, { model: { selectedNode: 'peer', backend: 'federated' } }), 'node:peer');
  assert.equal(computeGroupForRequest(config, { model: { backend: 'cloud' } }), 'backend:cloud');
});

test('higher priority gets the next admission without interrupting an active lower stream', async () => {
  const gate = scheduler({ backgroundMaxConcurrency: 1 });
  const background = await gate.admit({ requestClass: 'standard', groupId: 'local' });
  gate.markStarted(background);

  const foreground = await gate.admit({ requestClass: 'foreground', groupId: 'local' });
  assert.equal(gate.readyFor(foreground), true);
  assert.equal(gate.readyFor(background), true, 'an already-started stream remains valid');
  background.release();
  foreground.release();
  gate.close();
});

test('foreground cooldown and ramp admit one background request per interval', async () => {
  let now = 0;
  const gate = scheduler({
    now: () => now,
    backgroundMaxConcurrency: 3,
    rampIntervalMs: 10,
    foregroundIdleMs: 20
  });
  const foreground = await gate.admit({ requestClass: 'foreground', groupId: 'local' });
  gate.markStarted(foreground);
  foreground.release();

  let firstResolved = false;
  let secondResolved = false;
  const firstPromise = gate.admit({ requestClass: 'standard', groupId: 'local' }).then((lease) => {
    firstResolved = true;
    return lease;
  });
  const secondPromise = gate.admit({ requestClass: 'standard', groupId: 'local' }).then((lease) => {
    secondResolved = true;
    return lease;
  });
  await sleep(0);
  assert.equal(firstResolved, false);
  assert.equal(secondResolved, false);

  now = 20;
  gate.nudge();
  const first = await firstPromise;
  assert.equal(secondResolved, false);
  gate.markStarted(first);

  now = 29;
  gate.nudge();
  assert.equal(secondResolved, false);
  now = 30;
  gate.nudge();
  const second = await secondPromise;
  gate.markStarted(second);
  first.release();
  second.release();
  gate.close();
});

test('queue overflow, timeout, cancellation, and close reject pending work without dispatch', async () => {
  const gate = scheduler({ maxQueuedRequests: 1, queueTimeoutMs: 15 });
  const foreground = await gate.admit({ requestClass: 'foreground', groupId: 'local' });
  gate.markStarted(foreground);

  const controller = new AbortController();
  const canceled = gate.admit({ requestClass: 'standard', groupId: 'local', signal: controller.signal });
  await assert.rejects(
    gate.admit({ requestClass: 'standard', groupId: 'local' }),
    (error) => error instanceof RequestQueueOverflowError && error.code === 'REQUEST_QUEUE_FULL'
  );
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });

  const timedOut = gate.admit({ requestClass: 'standard', groupId: 'local' });
  await assert.rejects(
    timedOut,
    (error) => error instanceof RequestSchedulingTimeoutError && error.code === 'REQUEST_SCHEDULING_TIMEOUT'
  );
  foreground.release();
  gate.close();
  await assert.rejects(gate.admit({ requestClass: 'standard', groupId: 'local' }), {
    code: 'REQUEST_SCHEDULER_CLOSED'
  });
});

test('independent resource groups continue admitting while another group is in cooldown', async () => {
  let now = 0;
  const gate = scheduler({ now: () => now, foregroundIdleMs: 100 });
  const foreground = await gate.admit({ requestClass: 'foreground', groupId: 'local' });
  gate.markStarted(foreground);
  foreground.release();
  const cloud = await gate.admit({ requestClass: 'standard', groupId: 'backend:cloud' });
  assert.equal(gate.readyFor(cloud), true);
  cloud.release();
  now = 100;
  gate.nudge();
  gate.close();
});

test('refreshing to off drains queued work and listeners are notified on state changes', async () => {
  const gate = scheduler({ backgroundMaxConcurrency: 1 });
  let notifications = 0;
  gate.subscribe(() => notifications++);
  const foreground = await gate.admit({ requestClass: 'foreground', groupId: 'local' });
  gate.markStarted(foreground);
  const queued = gate.admit({ requestClass: 'standard', groupId: 'local' });
  gate.refresh('off');
  const lower = await queued;
  assert.equal(gate.readyFor(lower), true);
  assert.ok(notifications > 0);
  lower.release();
  foreground.release();
  gate.close();
});

test('released or closed leases can never reserve capacity through a late callback', async () => {
  const gate = scheduler();
  const released = await gate.admit();
  gate.markStarted(released);
  released.release();
  assert.equal(gate.readyFor(released), false);
  const running = await gate.admit();
  gate.markStarted(running);
  gate.close();
  assert.equal(gate.readyFor(running), false);
  running.release();
});

test('shared limiter scopes prioritize higher demand even across separate compute groups', async () => {
  const gate = scheduler({ foregroundIdleMs: 0 });
  const lower = await gate.admit({ groupId: 'device-a', scopeIds: ['shared-model'], requestClass: 'standard' });
  const higher = await gate.admit({ groupId: 'device-b', scopeIds: ['shared-model'], requestClass: 'foreground' });
  assert.equal(gate.readyFor(lower), true, 'its independent compute group is available');
  assert.equal(gate.higherDemandForScopes(lower, ['shared-model']), true, 'its shared budget belongs to higher demand');
  assert.equal(
    gate.higherDemandForScopes(lower, ['shared-model'], (_id, requestClass) => requestClass === 'standard'),
    false,
    'a standard-only budget does not belong to an exempt higher class in another compute group'
  );
  assert.equal(gate.higherDemandForScopes(lower, ['independent-model']), false);
  assert.equal(gate.higherDemandForScopes(higher, ['shared-model']), false);
  higher.release();
  assert.equal(gate.higherDemandForScopes(lower, ['shared-model']), false);
  lower.release();
  gate.close();
});

test('a full background waiting room does not consume foreground queue capacity', async () => {
  const gate = scheduler({ maxQueuedRequests: 1, foregroundIdleMs: 0 });
  const first = await gate.admit({ requestClass: 'foreground' });
  gate.markStarted(first);
  const background = gate.admit({ requestClass: 'standard' });
  await assert.rejects(gate.admit({ requestClass: 'standard' }), { code: 'REQUEST_QUEUE_FULL' });
  const next = await gate.admit({ requestClass: 'foreground' });
  gate.markStarted(next);
  first.release();
  next.release();
  const lower = await background;
  lower.release();
  gate.close();
});

test('late dispatch waits fail after close and zero waiting-room capacity rejects blocked dispatch', async () => {
  const gate = scheduler({ maxQueuedRequests: 0 });
  const lease = await gate.admit({ requestClass: 'foreground' });
  await assert.rejects(
    gate.waitFor(lease, () => false),
    { code: 'REQUEST_QUEUE_FULL' }
  );
  gate.close();
  await assert.rejects(
    gate.waitFor(lease, () => true),
    { code: 'REQUEST_SCHEDULER_CLOSED' }
  );
  lease.release();
});

test('brief idle gaps retain the recovery ramp and start pacing', async () => {
  let now = 1000;
  const gate = scheduler({ now: () => now, foregroundIdleMs: 10, backgroundMaxConcurrency: 4, rampIntervalMs: 20 });
  const foreground = await gate.admit({ requestClass: 'foreground' });
  gate.markStarted(foreground);
  foreground.release();
  now = 1010;
  const first = await gate.admit({ requestClass: 'standard' });
  gate.markStarted(first);
  first.release();
  assert.equal(gate.status().groups.local.backgroundCapacity, 1);
  let started = false;
  const next = gate.admit({ requestClass: 'standard' }).then((lease) => {
    started = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(started, false, 'an idle gap does not bypass paced starts');
  now = 1030;
  gate.nudge();
  const lease = await next;
  assert.equal(gate.status().groups.local.backgroundCapacity, 2);
  lease.release();
  now = 1090;
  gate.nudge();
  assert.deepEqual(gate.status().groups, {});
  gate.close();
});
