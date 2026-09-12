import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelMaintenanceController } from '../src/model-maintenance-control.mjs';
import { planModelMaintenance } from '../src/model-maintenance.mjs';

function baseConfig() {
  return {
    runtimes: {
      'local-main': { enabled: true, keepWarm: true, provider: 'local' },
      'cloud-fallback': { enabled: true, keepWarm: false, provider: 'cloud' }
    },
    models: [
      { id: 'local-model', runtime: 'local-main' },
      { id: 'cloud-model', runtime: 'cloud-fallback' }
    ],
    aliases: { chat: { members: ['local-model'] } },
    profiles: { default: {} },
    recipes: { r1: {} },
    someField: 'keep'
  };
}

function makeHarness(overrides = {}) {
  let config = baseConfig();
  const store = { raw: JSON.parse(JSON.stringify(config)) };
  const events = [];
  const state = Object.fromEntries(Object.keys(store.raw.runtimes).map((id) => [id, false]));
  const unhealthy = new Set();
  const manager = {
    assertRuntimeControl(id, by) {
      events.push(['assert', id, by]);
      if (overrides.refuseAuthority === id) throw new Error('authority refused');
    },
    async drainRuntime(id, o) {
      events.push(['drain', id, o.reason]);
      if (overrides.drainThrow === id) throw new Error('drain timeout');
    },
    async stop(id) {
      events.push(['stop', id]);
      state[id] = false;
      return overrides.falseStop ? false : undefined;
    },
    async resumeRuntime(id) {
      events.push(['resumeRuntime', id]);
      state[id] = false;
    },
    async pauseRuntime(id, reason) {
      events.push(['pause', id, reason]);
      state[id] = false;
    },
    async isHealthy(id) {
      events.push(['healthy', id]);
      if (overrides.unhealthyAll) return false;
      if (unhealthy.has(id)) return false;
      return state[id];
    },
    runtimeAppearsLoaded(id) {
      events.push(['loaded', id]);
      if (overrides.peerAlive && id === overrides.peerAlive) return true;
      return state[id];
    }
  };
  const admitted = [];
  let controller;
  const hooks = { onAdmit: null, onReload: null };
  controller = createModelMaintenanceController({
    getConfig: () => config,
    mutateSource(sync) {
      const draft = JSON.parse(JSON.stringify(store.raw));
      sync(draft);
      store.raw = draft;
      events.push(['mutate']);
    },
    async reload() {
      events.push(['reload']);
      if (hooks.onReload) hooks.onReload();
      if (overrides.reloadFail && hooks.failReload) throw new Error('reload failed');
      config = JSON.parse(JSON.stringify(store.raw));
    },
    manager,
    async admit(id, o) {
      events.push(['admit', id, o.force]);
      admitted.push(id);
      if (hooks.onAdmit) hooks.onAdmit();
      if (overrides.admitFail === id) throw new Error('admission failed');
      state[id] = true;
    },
    now: () => '2024-01-01T00:00:00.000Z'
  });
  function touchExternal(mut) {
    mut(store.raw);
  }
  return { controller, manager, store, events, state, unhealthy, admitted, touchExternal, hooks };
}

test('validation rejects bad flags and timeout with no effects', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.controller.run('local-main', 'suspend', { apply: 'x' }), /boolean/);
  await assert.rejects(
    () => h.controller.run('local-main', 'suspend', { drainTimeoutMs: 1.5, apply: true, yes: true }),
    /integer/
  );
  await assert.rejects(
    () => h.controller.run('local-main', 'suspend', { drainTimeoutMs: 7200001, apply: true, yes: true }),
    /integer/
  );
  assert.equal(h.events.length, 0);
});

test('dry run returns plan applied false with no effects', async () => {
  const h = makeHarness();
  const res = await h.controller.run('local-main', 'suspend');
  assert.equal(res.applied, false);
  assert.equal(h.events.length, 0);
});

test('apply requires yes', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.controller.run('local-main', 'suspend', { apply: true }), /yes/);
  assert.equal(h.events.length, 0);
});

test('suspend exact sequence, authority before write, latch and stop', async () => {
  const h = makeHarness();
  const res = await h.controller.run('local-main', 'suspend', { apply: true, yes: true, requestedBy: 'op' });
  assert.equal(res.applied, true);
  assert.equal(res.status, 'suspended');
  assert.deepEqual(
    h.events.map((e) => e[0]),
    ['assert', 'mutate', 'reload', 'drain', 'stop', 'healthy', 'loaded']
  );
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.state, 'suspended');
});

test('drain failure leaves latch and does not stop', async () => {
  const h = makeHarness({ drainThrow: 'local-main' });
  await assert.rejects(() => h.controller.run('local-main', 'suspend', { apply: true, yes: true }), /drain timeout/);
  assert.ok(!h.events.some((e) => e[0] === 'stop'));
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.state, 'suspended');
});

test('repeated suspend retries stop when already latched and stopped', async () => {
  const h = makeHarness();
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  const before = h.events.filter((e) => e[0] === 'stop').length;
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  const after = h.events.filter((e) => e[0] === 'stop').length;
  assert.ok(after > before);
});

test('suspend refuses success when a peer runtime stays loaded', async () => {
  const h = makeHarness({ peerAlive: 'local-main' });
  await assert.rejects(() => h.controller.run('local-main', 'suspend', { apply: true, yes: true }), /still loaded/);
});

test('resume healthy idempotence returns ready unchanged', async () => {
  const h = makeHarness();
  h.state['local-main'] = true;
  const res = await h.controller.run('local-main', 'resume', { apply: true, yes: true });
  assert.equal(res.status, 'ready');
  assert.equal(res.changed, false);
});

test('resume checks health before clearing gate', async () => {
  const h = makeHarness();
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  const res = await h.controller.run('local-main', 'resume', { apply: true, yes: true });
  assert.equal(res.status, 'ready');
  assert.equal(res.health['local-main'], true);
});

test('resume admission failure keeps gate and rethrows', async () => {
  const h = makeHarness({ admitFail: 'local-main' });
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  await assert.rejects(() => h.controller.run('local-main', 'resume', { apply: true, yes: true }), /admission failed/);
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.state, 'suspended');
});

test('resume false health keeps gate closed', async () => {
  const h = makeHarness({ unhealthyAll: true });
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  await assert.rejects(() => h.controller.run('local-main', 'resume', { apply: true, yes: true }), /health/);
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.state, 'suspended');
});

test('serialize racing runs and failure releases queue', async () => {
  const h = makeHarness({ drainThrow: 'local-main' });
  const p1 = h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  const p2 = h.controller.run('local-main', 'resume', { apply: true, yes: true });
  await assert.rejects(() => p1, /drain timeout/);
  assert.equal((await p2).status, 'ready');
});

test('external marker change during admit is preserved', async () => {
  const h = makeHarness();
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  h.hooks.onAdmit = () => {
    h.touchExternal((raw) => {
      raw.runtimes['local-main'].maintenance = {
        state: 'suspended',
        requestedModel: 'local-model',
        since: '2024-02-02T00:00:00.000Z',
        operationId: 'external-op'
      };
    });
  };
  await assert.rejects(() => h.controller.run('local-main', 'resume', { apply: true, yes: true }));
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.operationId, 'external-op');
});

test('unrelated fields updated during admit are preserved', async () => {
  const h = makeHarness();
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  h.touchExternal((raw) => {
    raw.someField = 'changed';
  });
  await h.controller.run('local-main', 'resume', { apply: true, yes: true });
  assert.equal(h.store.raw.someField, 'changed');
});

test('failed reload during resume preserves original error and keeps gate', async () => {
  const h = makeHarness({ reloadFail: true });
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  h.hooks.failReload = true;
  await assert.rejects(() => h.controller.run('local-main', 'resume', { apply: true, yes: true }), /reload failed/);
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.state, 'suspended');
});

test('authority refusal happens before any mutation', async () => {
  const h = makeHarness({ refuseAuthority: 'local-main' });
  await assert.rejects(
    () => h.controller.run('local-main', 'suspend', { apply: true, yes: true }),
    /authority refused/
  );
  assert.ok(!h.events.some((e) => e[0] === 'mutate'));
  assert.equal(h.store.raw.runtimes['local-main'].maintenance, undefined);
});

test('pending concurrency serializes after failure', async () => {
  const h = makeHarness({ drainThrow: 'local-main' });
  const p1 = h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  const p2 = h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  await assert.rejects(() => p1, /drain timeout/);
  await assert.rejects(() => p2, /drain timeout/);
  assert.equal(h.store.raw.runtimes['local-main'].maintenance.state, 'suspended');
});

test('planner plan exposes owner runtimes and inference models', async () => {
  const cfg = baseConfig();
  const plan = planModelMaintenance(cfg, 'local-main', 'suspend');
  assert.deepEqual(plan.runtimeIds, ['local-main']);
  assert.ok(plan.affectedModelIds.includes('local-model'));
});

test('suspend verifies physical members after stopping the owner group', async () => {
  const h = makeHarness();
  h.store.raw.runtimes['local-main'].placement = { members: [{ runtime: 'cloud-fallback' }] };
  const res = await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  assert.equal(res.status, 'suspended');
  assert.deepEqual(
    h.events.filter((e) => e[0] === 'stop').map((e) => e[1]),
    ['local-main']
  );
  assert.ok(h.events.some((e) => e[0] === 'loaded' && e[1] === 'cloud-fallback'));
});
