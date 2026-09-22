import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { mutateConfigSource } from '../src/config-mutation.mjs';
import { RuntimeManager, reconfigureRuntimeIds } from '../src/runtime-manager.mjs';
import { createRuntimePreferenceController, updateRuntimePreference } from '../src/runtime-preferences.mjs';

const config = () => ({
  runtimes: { chat: { enabled: true, command: 'unused', memoryGb: 8 } },
  models: []
});

test('readiness changes do not restart a running runtime or erase its request state', async () => {
  const previous = config();
  const manager = new RuntimeManager(previous);
  const current = manager.stateFor('chat');
  current.activeRequests = 1;
  manager.stop = () => {
    throw new Error('must not stop a running request');
  };
  manager.admit = () => {
    throw new Error('policy changes must not force a load');
  };
  for (const policy of ['always', 'preferred', 'auto']) {
    const next = structuredClone(manager.config);
    updateRuntimePreference(next, 'chat', policy);
    assert.deepEqual(reconfigureRuntimeIds(manager.config, next), []);
    const result = await manager.reconfigure(next);
    assert.deepEqual(result.changed, []);
    assert.equal(manager.stateFor('chat').activeRequests, 1);
  }
});

test('unknown, external, disabled, maintained and non-owned runtimes cannot be updated', () => {
  assert.throws(() => updateRuntimePreference(config(), '__proto__', 'auto'), /Unknown/);
  assert.throws(() => updateRuntimePreference(config(), 'chat', 'other'), /Choose/);
  for (const extra of [{ enabled: false }, { managed: false }, { management: 'external' }, { maintenance: {} }]) {
    const raw = config();
    Object.assign(raw.runtimes.chat, extra);
    assert.throws(() => updateRuntimePreference(raw, 'chat', 'always'));
  }
  const raw = config();
  raw.cluster = { nodeId: 'here' };
  raw.runtimes.chat.node = 'elsewhere';
  assert.throws(() => updateRuntimePreference(raw, 'chat', 'always'), /owns/);
});

test('readiness waits for active admission and preserves an independent pause', async () => {
  const manager = new RuntimeManager(config());
  manager.pausedRuntimes.add('chat');
  let release;
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const barrier = new Promise((resolve) => (release = resolve));
  const admission = manager.withAdmissionLock(
    async (signal) => {
      entered();
      await barrier;
      assert.equal(signal?.aborted ?? false, false);
      assert.notEqual(manager.config.runtimes.chat.keepWarm, true);
    },
    { runtimeId: 'chat', preemptible: true }
  );
  await started;
  const next = structuredClone(manager.config);
  updateRuntimePreference(next, 'chat', 'always');
  const reload = manager.reconfigure(next);
  release();
  await Promise.all([admission, reload]);
  assert.equal(manager.config.runtimes.chat.keepWarm, true);
  assert.equal(manager.pausedRuntimes.has('chat'), true);
});

test('concurrent persisted preferences preserve other fields and literal environment placeholders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-preferences-'));
  try {
    const file = path.join(dir, 'config.json');
    const raw = config();
    raw.runtimes.chat.evictable = false;
    raw.runtimes.chat.policy = { evictable: false, priority: 77 };
    raw.runtimes.chat.env = { SAMPLE: '${A_PRIVATE_ENV_VALUE}' };
    await fs.writeFile(file, JSON.stringify(raw), { mode: 0o600 });
    let current = await loadConfig(file);
    let reloadCount = 0;
    const controller = createRuntimePreferenceController({
      getConfig: () => current,
      mutateSource: (fn) => mutateConfigSource(current, fn),
      reload: async () => {
        current = await loadConfig(file);
        reloadCount++;
      }
    });
    await assert.rejects(controller.set('chat', { policy: 'auto' }), /confirm/);
    assert.equal(reloadCount, 0);
    const results = await Promise.all([
      controller.set('chat', { policy: 'preferred', yes: true }),
      controller.set('chat', { policy: 'auto', yes: true })
    ]);
    assert.deepEqual(
      results.map((r) => r.policy),
      ['preferred', 'auto']
    );
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.runtimes.chat.keepWarm, false);
    assert.equal(stored.runtimes.chat.preferredWarm, false);
    assert.equal(stored.runtimes.chat.evictable, undefined);
    assert.deepEqual(stored.runtimes.chat.policy, { priority: 77 });
    assert.equal(stored.runtimes.chat.env.SAMPLE, '${A_PRIVATE_ENV_VALUE}');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed reload can be retried without losing the saved preference', async () => {
  const raw = config();
  raw.sourcePath = '/test/config.json';
  let fail = true;
  const controller = createRuntimePreferenceController({
    getConfig: () => raw,
    mutateSource: async (fn) => {
      fn(raw);
      return { changed: false };
    },
    reload: async () => {
      if (fail) throw new Error('reload failed');
    }
  });
  await assert.rejects(controller.set('chat', { policy: 'preferred', yes: true }), /reload failed/);
  fail = false;
  assert.equal((await controller.set('chat', { policy: 'preferred', yes: true })).policy, 'preferred');
});

test('accepted readiness stays observable while admission is busy and rejects queued preferred restore', async () => {
  const raw = config();
  raw.sourcePath = '/test/config';
  raw.runtimes.chat.preferredWarm = true;
  const manager = new RuntimeManager(structuredClone(raw));
  let finish;
  const barrier = new Promise((resolve) => {
    finish = resolve;
  });
  const controller = createRuntimePreferenceController({
    getConfig: () => manager.config,
    mutateSource: async (fn) => {
      fn(raw);
      return { changed: true };
    },
    reload: async () => {
      await barrier;
      await manager.reconfigure(structuredClone(raw));
    },
    onPersisted: (id, policy, generation) => manager.noteDesiredResidency(id, policy, generation),
    onApplied: (id, policy, generation) => manager.settleDesiredResidency(id, policy, generation)
  });
  const result = await controller.request('chat', { policy: 'auto', yes: true });
  assert.equal(result.status, 'pending');
  assert.equal(manager.config.runtimes.chat.preferredWarm, true);
  assert.equal(manager.resolveAdmissionGuard({ runtimeId: 'chat', reason: 'preferred-warm' }).ok, false);
  assert.equal(controller.snapshot('chat').status, 'pending');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot('chat').status, 'succeeded');
  assert.equal(manager.config.runtimes.chat.preferredWarm, false);
  assert.equal(manager.desiredResidencyPolicy('chat'), undefined);
});

test('pending Always ready protects a resident model from admission eviction', async () => {
  const { applyRuntimePolicyPlan } = await import('../src/runtime-policy.mjs');
  const raw = {
    runtimePolicy: { enabled: true, memoryBudgetGb: 40, protectActiveRequests: true },
    runtimes: { resident: { enabled: true, memoryGb: 30 }, incoming: { enabled: true, memoryGb: 30 } }
  };
  const manager = new RuntimeManager(raw);
  manager.noteDesiredResidency('resident', 'always', 1);
  manager.status = async () => ({
    runtimes: {
      resident: { status: 'running', healthy: true, activeRequests: 0 },
      incoming: { status: 'idle', healthy: false }
    }
  });
  manager.stop = async () => {
    throw new Error('must not evict pending pin');
  };
  await assert.rejects(
    applyRuntimePolicyPlan(raw, manager, { requestedRuntimeId: 'incoming', dryRun: false, yes: true }),
    (error) => error.code === 'runtime_keep_warm_conflict'
  );
  manager.noteDesiredResidency('resident', 'auto', 2);
  manager.settleDesiredResidency('resident', 'always', 1);
  assert.equal(manager.desiredResidencyPolicy('resident'), 'auto', 'older completion cannot erase newer intent');
});

test('hard-pin startup keeps admission enabled even when the general policy is disabled', async () => {
  const { applyRuntimePolicyPlan } = await import('../src/runtime-policy.mjs');
  const raw = {
    runtimePolicy: { enabled: false, memoryBudgetGb: 40 },
    runtimes: {
      resident: { enabled: true, keepWarm: true, memoryGb: 30 },
      incoming: { enabled: true, keepWarm: true, memoryGb: 30 }
    }
  };
  const manager = new RuntimeManager(raw);
  manager.status = async () => ({
    runtimes: { resident: { healthy: true, status: 'running' }, incoming: { healthy: false, status: 'idle' } }
  });
  manager.start = async () => {
    throw new Error('must not bypass admission');
  };
  await assert.rejects(
    applyRuntimePolicyPlan(raw, manager, {
      requestedRuntimeId: 'incoming',
      reason: 'keep-warm',
      dryRun: false,
      yes: true
    }),
    (error) => error.code === 'runtime_keep_warm_conflict'
  );
  manager.noteDesiredResidency('incoming', 'auto', 1);
  assert.equal(manager.resolveAdmissionGuard({ runtimeId: 'incoming', reason: 'keep-warm' }).ok, false);
});
