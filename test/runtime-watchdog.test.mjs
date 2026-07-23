import assert from 'node:assert/strict';
import { RuntimeManager, classifyRuntimeWatchdogOutcome, runtimeWatchdogConfig } from '../src/runtime-manager.mjs';

const managedRuntime = {
  enabled: true,
  management: 'managed',
  watchdog: {
    enabled: true,
    failureThreshold: 2,
    failureWindowMs: 10000,
    minNoProgressMs: 100,
    cooldownMs: 1000,
    drainTimeoutMs: 20
  }
};

{
  assert.equal(runtimeWatchdogConfig(managedRuntime).enabled, true);
  assert.equal(
    runtimeWatchdogConfig({ ...managedRuntime, management: 'external' }).enabled,
    false,
    'watchdog cannot restart an externally managed runtime'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 499,
      durationMs: 99,
      responseBytes: 0
    }).kind,
    'ignored',
    'quick client cancellations are not backend-stall evidence'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 499,
      durationMs: 100,
      responseBytes: 0
    }).kind,
    'no-progress-failure'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 499,
      durationMs: 1000,
      firstContentMs: 10,
      responseBytes: 8
    }).kind,
    'progress',
    'a client close after streamed content is not a no-progress stall'
  );
}

class TestRuntimeManager extends RuntimeManager {
  constructor(config) {
    super(config, { logger: { error() {} } });
    this.lifecycleCalls = [];
  }

  async stopUnlocked(runtimeId) {
    this.lifecycleCalls.push({ action: 'stop', runtimeId });
    return { runtimeId, stopped: true };
  }

  async startUnlocked(runtimeId, options) {
    this.lifecycleCalls.push({ action: 'start', runtimeId, options });
    return { runtimeId, started: true, healthy: true };
  }
}

{
  const runtimeId = 'test-runtime';
  const manager = new TestRuntimeManager({
    runtimes: {
      [runtimeId]: managedRuntime
    }
  });
  const stalled = {
    ok: false,
    status: 499,
    durationMs: 500,
    firstContentMs: null,
    lastContentMs: null,
    responseBytes: 0
  };

  assert.deepEqual(manager.noteRequestOutcome(runtimeId, stalled), {
    runtimeId,
    action: 'observed',
    reason: 'below-threshold'
  });
  assert.equal(manager.stateFor(runtimeId).watchdog.consecutiveFailures, 1);

  manager.noteRequestOutcome(runtimeId, {
    ok: true,
    status: 200,
    durationMs: 20,
    firstContentMs: 10,
    responseBytes: 20
  });
  assert.equal(manager.stateFor(runtimeId).watchdog.consecutiveFailures, 0, 'progress clears the failure streak');

  manager.noteRequestOutcome(runtimeId, stalled);
  assert.deepEqual(manager.noteRequestOutcome(runtimeId, stalled), {
    runtimeId,
    action: 'restart-requested',
    reason: 'failure-threshold'
  });
  assert.equal(manager.pausedRuntimes.has(runtimeId), true, 'new requests pause as soon as restart is requested');
  await manager.watchdogOperations.get(runtimeId);
  assert.deepEqual(
    manager.lifecycleCalls.map(({ action }) => action),
    ['stop', 'start'],
    'watchdog restarts only the affected runtime through its lifecycle methods'
  );
  assert.equal(manager.lifecycleCalls[1].options.reason, 'watchdog-restart');
  assert.equal(manager.pausedRuntimes.has(runtimeId), false);
  assert.equal(manager.stateFor(runtimeId).watchdog.restarts, 1);

  manager.noteRequestOutcome(runtimeId, stalled);
  assert.equal(manager.noteRequestOutcome(runtimeId, stalled).reason, 'cooldown');
  assert.equal(manager.lifecycleCalls.length, 2, 'cooldown prevents a restart loop');

  const status = await manager.status();
  assert.equal(status.runtimes[runtimeId].watchdog.enabled, true);
  assert.equal(status.runtimes[runtimeId].watchdog.restarts, 1);
  assert(status.events.some((event) => event.event === 'watchdog-restart-completed'));
}

console.log('runtime watchdog tests passed');
