import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccordEffects } from '../src/accord-effects.mjs';
import { normalizeResource } from '../src/resource-spec.mjs';
import { accordManifests } from '../src/accord-resources.mjs';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-effects-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = {
    sourcePath: path.join(dir, 'config.json'),
    reservations: {
      resources: {
        gpu: { routes: [{ alias: 'chat', profile: 'cloud' }], suspend: ['resident'], workloads: ['borrowed'] }
      }
    }
  };
  const current = { route: 'local', suspended: false, borrowed: false, stopFails: false, restoreFails: false };
  const calls = [];
  const options = {
    statePath: path.join(dir, 'effects.json'),
    getConfig: () => config,
    actions: {
      activeRoute: async () => current.route,
      isSuspended: async () => current.suspended,
      setRoute: async (x) => {
        calls.push('route:' + x.profile);
        current.route = x.profile;
      },
      suspend: async (x) => {
        calls.push('stop:' + x.model);
        if (x.model === 'borrowed') {
          if (current.stopFails) throw Error('stop unknown');
          current.borrowed = false;
        } else current.suspended = true;
      },
      resume: async (x) => {
        calls.push('start:' + x.model);
        if (x.model === 'borrowed') current.borrowed = true;
        else {
          if (current.restoreFails) throw Error('health failed');
          current.suspended = false;
        }
      }
    }
  };
  return {
    dir,
    config,
    current,
    calls,
    options,
    effects: createAccordEffects(options),
    fence: { authority: 'host', claimId: 'a', generation: 1, epoch: 1 }
  };
}
test('Accord owns reservations; LLooM records exact routing and model effects, stops borrowed workload before restoring', async (t) => {
  const f = await fixture(t),
    { effects: e, fence: b, current: c } = f;
  await e.handle('gpu', 'prepare', b);
  assert.equal(c.route, 'cloud');
  assert(c.suspended);
  await e.handle('gpu', 'prepare', b);
  assert.equal(f.calls.filter((x) => x === 'stop:resident').length, 1);
  await e.handle('gpu', 'start', { ...b, key: 'work' });
  assert(c.borrowed);
  c.stopFails = true;
  await assert.rejects(e.handle('gpu', 'stop', b));
  await assert.rejects(e.handle('gpu', 'restore', b));
  assert.equal(c.route, 'cloud');
  c.stopFails = false;
  await e.handle('gpu', 'stop', b);
  assert(!c.borrowed);
  c.restoreFails = true;
  await assert.rejects(e.handle('gpu', 'restore', b));
  assert.equal(c.route, 'cloud');
  c.restoreFails = false;
  await e.handle('gpu', 'restore', b);
  assert.equal(c.route, 'local');
  assert(!c.suspended);
  await assert.rejects(e.handle('gpu', 'prepare', b));
  await assert.rejects(e.handle('gpu', 'start', { ...b, key: 'old' }));
  await e.handle('gpu', 'prepare', { ...b, claimId: 'b', generation: 2 });
  await assert.rejects(e.handle('gpu', 'stop', b));
  assert(f.calls.indexOf('stop:borrowed') < f.calls.indexOf('start:resident'));
});
test('restoring a hold skips a suspended model that has since been disabled or removed', async (t) => {
  for (const message of [
    'target runtime resident-cluster is not enabled',
    'target runtime resident-cluster is not configured',
    'unknown model or alias: resident'
  ]) {
    const f = await fixture(t);
    await f.effects.handle('gpu', 'prepare', f.fence);
    await f.effects.handle('gpu', 'stop', f.fence);
    f.options.actions.resume = async () => {
      throw Error(message);
    };
    await f.effects.handle('gpu', 'restore', f.fence);
    assert.equal(f.current.route, 'local');
    const step = f.effects.status().resources.gpu.steps.find((s) => s.kind === 'suspend');
    assert.equal(step.status, 'undone');
    assert.equal(step.retired, true);
  }
  const f = await fixture(t);
  await f.effects.handle('gpu', 'prepare', f.fence);
  await f.effects.handle('gpu', 'stop', f.fence);
  f.current.restoreFails = true;
  await assert.rejects(f.effects.handle('gpu', 'restore', f.fence), /health failed/);
  assert.equal(f.current.route, 'cloud');
});
test('restart during prepare holds the resource and exact prior suspension survives restoration', async (t) => {
  const f = await fixture(t);
  f.current.suspended = true;
  f.options.actions.setRoute = async () => {
    throw Error('lost route reply');
  };
  await assert.rejects(f.effects.handle('gpu', 'prepare', f.fence));
  const e = createAccordEffects(f.options);
  await assert.rejects(e.handle('gpu', 'prepare', f.fence));
  f.options.actions.setRoute = async (x) => {
    f.current.route = x.profile;
  };
  await e.handle('gpu', 'stop', f.fence);
  await e.handle('gpu', 'restore', f.fence);
  assert(f.current.suspended);
  await assert.rejects(e.handle('gpu', 'prepare', { ...f.fence, authority: 'other', generation: 2 }));
});
test('live legacy leases cannot be overwritten, expired away, or mistaken for free during migration', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.dir, 'schedule.json'),
    JSON.stringify({
      schemaVersion: 1,
      reservations: {
        old: {
          id: 'old',
          resource: 'gpu',
          state: 'active',
          expiresAt: 1,
          steps: [{ kind: 'suspend', model: 'resident' }]
        }
      }
    })
  );
  await assert.rejects(f.effects.handle('gpu', 'prepare', f.fence), { code: 'legacy_resource_held' });
  await assert.rejects(f.effects.handle('gpu', 'stop', f.fence), { code: 'legacy_resource_held' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.effects.legacy('gpu').length, 1);
});
test('two Sparks holding one model and route share its effects; the last release restores the state before both', async (t) => {
  for (const order of [
    ['spark01', 'spark02'],
    ['spark02', 'spark01']
  ]) {
    const f = await fixture(t);
    const effect = { routes: [{ alias: 'chat', profile: 'cloud' }], suspend: ['resident'] };
    f.config.reservations.resources = { spark01: { ...effect }, spark02: { ...effect } };
    const fence = (claimId) => ({ ...f.fence, claimId });
    await f.effects.handle('spark01', 'prepare', fence('a'));
    await f.effects.handle('spark02', 'prepare', fence('b'));
    assert.deepEqual(f.calls, ['route:cloud', 'stop:resident'], 'the second hold applies nothing new');
    const journal = f.effects.status().resources.spark02.steps;
    assert.equal(journal.find((s) => s.kind === 'route').previous, 'local', 'both holds record the original route');
    assert.equal(journal.find((s) => s.kind === 'suspend').wasSuspended, false);
    const [first, last] = order;
    const claim = { spark01: 'a', spark02: 'b' };
    await f.effects.handle(first, 'stop', fence(claim[first]));
    await f.effects.handle(first, 'restore', fence(claim[first]));
    assert.equal(f.current.route, 'cloud', `${last} still holds the route`);
    assert(f.current.suspended, `${last} still holds the model down`);
    await f.effects.handle(last, 'stop', fence(claim[last]));
    await f.effects.handle(last, 'restore', fence(claim[last]));
    assert.equal(f.current.route, 'local');
    assert(!f.current.suspended);
    assert.deepEqual(f.calls, ['route:cloud', 'stop:resident', 'start:resident', 'route:local']);
  }
});
test('a hold that would move a shared route somewhere else is refused before any effect', async (t) => {
  const f = await fixture(t);
  f.config.reservations.resources = {
    spark01: { routes: [{ alias: 'chat', profile: 'cloud' }] },
    spark02: { routes: [{ alias: 'chat', profile: 'elsewhere' }], suspend: ['resident'] }
  };
  await f.effects.handle('spark01', 'prepare', { ...f.fence, claimId: 'a' });
  await assert.rejects(
    f.effects.handle('spark02', 'prepare', { ...f.fence, claimId: 'b' }),
    /held at cloud by spark01/
  );
  assert.equal(f.current.route, 'cloud');
  assert(!f.current.suspended, 'the refused hold drained nothing');
});
test('capacity slots share no effects and conflicting effectful capacity is refused', () => {
  assert.throws(() => normalizeResource('gpu', { capacity: 2, suspend: ['model'] }), /capacity 1/);
  assert.equal(normalizeResource('slots', { capacity: 2 }).capacity, 2);
});
test('a resource or slot no longer configured tells Accord it is withdrawn, so Accord can forget it', async (t) => {
  const f = await fixture(t);
  f.config.reservations.resources.slots = { capacity: 2 };
  const withdrawn = { code: 'resource_unknown', statusCode: 404 };
  assert.deepEqual(await f.effects.handle('gpu', 'availability', {}), { available: true });
  assert.deepEqual(await f.effects.handle('slots#1', 'availability', {}), { available: true });
  f.config.reservations.resources.slots.capacity = 1;
  await assert.rejects(f.effects.handle('slots#1', 'availability', {}), withdrawn);
  delete f.config.reservations.resources.gpu;
  await assert.rejects(f.effects.handle('gpu', 'availability', {}), withdrawn);
  await assert.rejects(f.effects.handle('gpu', 'prepare', f.fence), withdrawn, 'nothing new is granted on it');
  f.config.reservations.resources.bad = { capacity: 0 };
  await assert.rejects(
    f.effects.handle('bad', 'availability', {}),
    (e) => e.statusCode !== 404,
    'a broken entry is not a withdrawal'
  );
});
test('deployment fences hold recovery without applying effects; removed configuration can still restore its journal', async (t) => {
  const f = await fixture(t);
  let paused = false;
  const e = createAccordEffects({ ...f.options, isPaused: () => paused });
  await e.handle('gpu', 'prepare', f.fence);
  await e.handle('gpu', 'start', { ...f.fence, key: 'work' });
  paused = true;
  const before = f.calls.length;
  await assert.rejects(e.handle('gpu', 'stop', f.fence), /Deployment fence/);
  await assert.rejects(e.handle('gpu', 'restore', f.fence), /Deployment fence/);
  assert.equal(f.calls.length, before);
  assert(f.current.borrowed);
  delete f.config.reservations.resources.gpu;
  paused = false;
  await e.handle('gpu', 'stop', f.fence);
  await e.handle('gpu', 'restore', f.fence);
  assert(!f.current.borrowed);
  assert.equal(f.current.route, 'local');
});

test('verified production baseline reconciliation preserves journal, requires exact lease and drained fence, and never runs undo', async (t) => {
  const { reconcileLegacyHold, digest, leaseDigest } = await import('../src/accord-migration.mjs');
  const f = await fixture(t);
  await fs.writeFile(f.config.sourcePath, JSON.stringify(f.config));
  const lease = {
    id: 'old',
    owner: 'owner',
    resource: 'gpu',
    state: 'active',
    steps: [{ kind: 'suspend', model: 'obsolete' }]
  };
  const file = path.join(f.dir, 'schedule.json');
  const old = JSON.stringify({ schemaVersion: 1, reservations: { old: lease } });
  await fs.writeFile(file, old);
  const plan = {
    leaseId: 'old',
    owner: 'owner',
    leaseSHA256: leaseDigest(lease),
    configSHA256: digest(await fs.readFile(f.config.sourcePath)),
    ownerConfirmation: 'verified owner chat',
    baselineEvidence: 'current processes and routes',
    noBorrowedWorkload: true,
    opId: 'migration',
    generation: 4
  };
  const fence = { state: 'prepared', activeHandlers: 0, operation: { opId: 'migration' }, generation: 4 };
  const run = (overrides = {}) => reconcileLegacyHold({ config: f.config, plan, fence, ...overrides });
  await run();
  assert.equal(f.effects.legacy('gpu').length, 1);
  await assert.rejects(run({ fence: { ...fence, activeHandlers: 1 }, apply: true }));
  await assert.rejects(run({ plan: { ...plan, noBorrowedWorkload: false }, apply: true }));
  await assert.rejects(run({ plan: { ...plan, leaseSHA256: 'changed' }, apply: true }));
  const effectsFile = path.join(f.dir, 'schedule-accord-effects.json');
  await fs.writeFile(effectsFile, JSON.stringify({ schema: 1, resources: { gpu: { phase: 'active' } } }));
  await assert.rejects(run({ apply: true }), /Existing Accord effects/);
  await fs.unlink(effectsFile);
  await run({ apply: true });
  await run({ apply: true });
  assert.equal(f.effects.legacy('gpu').length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), old);
  assert.deepEqual(f.calls, []);
  await f.effects.handle('gpu', 'prepare', f.fence);
  assert(f.calls.includes('stop:resident')); // Future grants still drain current baseline.
  lease.updatedAt = 42;
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, reservations: { old: lease } }));
  assert.equal(f.effects.legacy('gpu').length, 1);
});

test("Accord registration declares each resource's hold limit within the range Accord accepts", () => {
  const day = 86400000;
  const config = {
    reservations: {
      resources: {
        pair: { maxTtlMs: 43200000 },
        'drafter-0304': { allowIndefinite: true },
        plain: {},
        brief: { maxTtlMs: 1000 },
        month: { maxTtlMs: 40 * day }
      }
    }
  };
  const limits = Object.fromEntries(
    accordManifests(config, 4321, '/tmp/provider.token').map((m) => [
      m.label.replace('LLooM ', ''),
      [m.maxOwnershipMs, m.allowIndefinite]
    ])
  );
  assert.deepEqual(limits, {
    pair: [43200000, false],
    'drafter-0304': [28800000, true],
    plain: [28800000, false],
    brief: [60000, false],
    month: [30 * day, false]
  });
});
