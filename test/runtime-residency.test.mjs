import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimePolicyPlan, applyRuntimePolicyPlan } from '../src/runtime-policy.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createPreferredResidencyReconciler } from '../src/runtime-residency.mjs';
import { loadConfig } from '../src/config.mjs';

// Promise.withResolvers is unavailable on the supported Node 20 runtime.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Eviction tiers: keep-warm pins are never candidates, preferred runtimes are
// reclaimed only after ordinary idle evictables, even when the preferred
// runtime is the oldest by LRU.
// ---------------------------------------------------------------------------

const tierConfig = {
  runtimePolicy: { memoryBudgetGb: 60, protectActiveRequests: true },
  runtimes: {
    pin: { enabled: true, keepWarm: true, memoryGb: 10 },
    image: { enabled: true, preferredWarm: true, memoryGb: 20, policy: { priority: 100 } },
    music: { enabled: true, memoryGb: 20, policy: { priority: 1 } },
    requested: { enabled: true, memoryGb: 30 }
  }
};
const tierStatus = {
  runtimes: {
    pin: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-07-13T00:00:00Z' },
    // image is the OLDEST by LRU; a naive priority bump would not protect it.
    image: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-01-01T00:00:00Z' },
    music: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-08-01T00:00:00Z' },
    requested: { healthy: false, status: 'idle', activeRequests: 0 }
  }
};

const tierPlan = await createRuntimePolicyPlan(tierConfig, {
  requestedRuntimeId: 'requested',
  status: tierStatus
});
assert.equal(tierPlan.runtimes.find((row) => row.runtimeId === 'image').preferredWarm, true);
assert.equal(tierPlan.runtimes.find((row) => row.runtimeId === 'music').preferredWarm, false);
// Preferred tier never carries a keep-warm protected reason.
assert(
  !tierPlan.protected.some((entry) => entry.runtimeId === 'image' && entry.protectedReasons.includes('keep-warm-pin'))
);
// Only one eviction is needed; it must be the ordinary evictable even though
// image is older.
assert.deepEqual(
  tierPlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:music', 'start:requested']
);

// Same layout, but the preferred runtime is the only thing that can free
// enough memory: it may evict, and it does so after music is exhausted.
const pressurePlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 40, protectActiveRequests: true },
    runtimes: {
      image: { enabled: true, preferredWarm: true, memoryGb: 25 },
      music: { enabled: true, memoryGb: 20 },
      requested: { enabled: true, memoryGb: 30 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    status: {
      runtimes: {
        image: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-01-01T00:00:00Z' },
        music: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-08-01T00:00:00Z' },
        requested: { healthy: false, status: 'idle', activeRequests: 0 }
      }
    }
  }
);
assert.deepEqual(
  pressurePlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:music', 'stop:image', 'start:requested']
);

// No pressure: nothing is stopped.
const noPressurePlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 200 },
    runtimes: {
      image: { enabled: true, preferredWarm: true, memoryGb: 25 },
      requested: { enabled: true, memoryGb: 30 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    status: {
      runtimes: {
        image: { healthy: true, status: 'running', activeRequests: 0 },
        requested: { healthy: false, status: 'idle', activeRequests: 0 }
      }
    }
  }
);
assert.deepEqual(
  noPressurePlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:requested']
);

// ---------------------------------------------------------------------------
// applyRuntimePolicyPlan honours allowEviction: background restore may not
// evict a resident runtime, even under pressure.
// ---------------------------------------------------------------------------

const evictionOperations = [];
const evictionManager = {
  async status() {
    return tierStatus;
  },
  async stop(runtimeId) {
    evictionOperations.push(`stop:${runtimeId}`);
    return { runtimeId, stopped: true };
  },
  async start(runtimeId, options) {
    evictionOperations.push(`start:${runtimeId}`);
    return { runtimeId, started: true, options };
  }
};

await assert.rejects(
  () =>
    applyRuntimePolicyPlan(tierConfig, evictionManager, {
      requestedRuntimeId: 'requested',
      dryRun: false,
      yes: true,
      allowEviction: false
    }),
  (error) => error.code === 'runtime_eviction_forbidden' && /without evicting resident runtime/.test(error.message)
);
assert.deepEqual(evictionOperations, []);

// ---------------------------------------------------------------------------
// Config validation: preferredWarm type, keepWarm+preferredWarm conflict,
// and model/alias/top-level residency declarations.
// ---------------------------------------------------------------------------

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-residency-config-'));
async function loadRaw(raw) {
  const file = path.join(directory, `config-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(file, JSON.stringify(raw));
  return loadConfig(file, { env: {} });
}

const validConfig = await loadRaw({
  runtimes: {
    essentials: { enabled: true, keepWarm: true, command: 'sleep', port: 8201 },
    image: { enabled: true, preferredWarm: true, command: 'sleep', port: 8202 },
    music: { enabled: true, command: 'sleep', port: 8203 }
  },
  models: []
});
assert.equal(validConfig.runtimes.image.preferredWarm, true);
assert.equal(validConfig.runtimes.music.preferredWarm, undefined);

await assert.rejects(
  () =>
    loadRaw({
      runtimes: { both: { enabled: true, keepWarm: true, preferredWarm: true, command: 'sleep', port: 8201 } },
      models: []
    }),
  /cannot set both keepWarm and preferredWarm/
);

await assert.rejects(
  () =>
    loadRaw({
      runtimes: { bad: { enabled: true, preferredWarm: 'yes', command: 'sleep', port: 8201 } },
      models: []
    }),
  /preferredWarm must be a boolean/
);

await assert.rejects(
  () =>
    loadRaw({
      runtimes: { ok: { enabled: true, command: 'sleep', port: 8201 } },
      models: [{ id: 'm', backend: 'b', preferredWarm: true }],
      backends: { b: { adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:1' } }
    }),
  /cannot declare preferredWarm/
);

await assert.rejects(
  () =>
    loadRaw({
      runtimes: { ok: { enabled: true, command: 'sleep', port: 8201 } },
      aliases: { a: { members: ['m'], preferredWarm: true } },
      models: []
    }),
  /cannot declare preferredWarm/
);

await assert.rejects(
  () => loadRaw({ preferredWarm: true, runtimes: {}, models: [] }),
  /top-level preferredWarm is not supported/
);

// ---------------------------------------------------------------------------
// runtime.preferredWarm is a live-admission field: toggling it must not
// restart a running container.
// ---------------------------------------------------------------------------

const baseRuntimeConfig = {
  runtimes: {
    image: { enabled: true, command: 'sleep', port: 8202, maxConcurrency: 1 }
  }
};
const previousConfig = { ...baseRuntimeConfig, runtimes: { image: { ...baseRuntimeConfig.runtimes.image } } };
const nextConfig = {
  ...baseRuntimeConfig,
  runtimes: { image: { ...baseRuntimeConfig.runtimes.image, preferredWarm: true } }
};
const manager = new RuntimeManager(previousConfig, { logger: { error() {}, warn() {} } });
const changed = manager.constructor.name ? await manager.reconfigure(nextConfig) : null;
assert.deepEqual(changed.changed, []);
assert.deepEqual(changed.liveAdmissionChanged, ['image']);
assert.equal(manager.config.runtimes.image.preferredWarm, true);

// Status rows expose preferredWarm and the IDs helper orders pins first.
assert.deepEqual(manager.preferredWarmRuntimeIds(), ['image']);
assert.equal(manager.residencyOwnership('image').owned, true);

// ---------------------------------------------------------------------------
// Background reconciliation delegates everything to admission, preserves
// overlap/close behavior, and is a no-op with no preferred entries.
// ---------------------------------------------------------------------------

const reconcileCalls = [];
const reconcileManager = {
  config: {
    runtimes: {
      image: { enabled: true, preferredWarm: true, memoryGb: 10 }
    },
    runtimePolicy: { reserveMemoryGb: 1 }
  },
  preferredWarmRuntimeIds() {
    return ['image'];
  },
  residencyOwnership() {
    return { owned: true, reason: null };
  },
  async status() {
    return { runtimes: { image: { status: 'stopped', healthy: false, activeRequests: 0, queuedRequests: 0 } } };
  },
  async admit(runtimeId, options) {
    reconcileCalls.push(`admit:${runtimeId}:${options.reason}:${options.allowEviction}`);
    return { runtimeId, plan: { actions: [{ type: 'start', runtimeId }] } };
  }
};
const reconciler = createPreferredResidencyReconciler(reconcileManager, { intervalMs: 100000 });
const once = await reconciler.reconcileOnce();
assert.equal(once.reconciled.length, 1);
assert.deepEqual(reconcileCalls, ['admit:image:preferred-warm-reconcile:true']);

// Healthy preferred runtimes do not repeat warmup on every timer tick.
reconcileCalls.length = 0;
reconcileManager.status = async () => ({
  runtimes: { image: { status: 'running', healthy: true, activeRequests: 0, queuedRequests: 0 } }
});
const loaded = await reconciler.reconcileOnce();
assert.deepEqual(loaded.reconciled, []);
assert.deepEqual(reconcileCalls, []);

// Busy: skip.
reconcileManager.status = async () => ({
  runtimes: { image: { status: 'stopped', healthy: false, activeRequests: 1, queuedRequests: 0 } }
});
const busy = await reconciler.reconcileOnce();
assert.equal(busy.reconciled[0].started, true);

// Remotely owned / maintenance suspended: skip.
reconcileManager.residencyOwnership = () => ({ owned: false, reason: 'leader-owned' });
const unowned = await reconciler.reconcileOnce();
assert.equal(unowned.reconciled[0].reason, 'leader-owned');
reconcileManager.residencyOwnership = () => ({ owned: false, reason: 'maintenance-suspended' });
const suspended = await reconciler.reconcileOnce();
assert.equal(suspended.reconciled[0].reason, 'maintenance-suspended');

// No preferred entries: no-op.
const emptyManager = {
  config: { runtimes: {}, runtimePolicy: {} },
  preferredWarmRuntimeIds: () => []
};
const emptyReconciler = createPreferredResidencyReconciler(emptyManager);
assert.equal((await emptyReconciler.reconcileOnce()).skipped, 'no-preferred-runtimes');

// Overlap guard: a slow reconcile blocks a second concurrent run.
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const overlapManager = {
  config: { runtimes: { image: { enabled: true, preferredWarm: true, memoryGb: 1 } }, runtimePolicy: {} },
  preferredWarmRuntimeIds: () => ['image'],
  residencyOwnership: () => ({ owned: true, reason: null }),
  async status() {
    await gate;
    return { runtimes: { image: { status: 'stopped', healthy: false, activeRequests: 0, queuedRequests: 0 } } };
  },
  async admit(runtimeId) {
    return { runtimeId };
  }
};
const overlapReconciler = createPreferredResidencyReconciler(overlapManager, { intervalMs: 100000 });
const first = overlapReconciler.reconcileOnce();
const second = await overlapReconciler.reconcileOnce();
assert.equal(second.skipped, 'overlap');
release();
await first;
assert.equal(overlapReconciler.running, false);

// After stop, reconciliation does not run.
const stoppedReconciler = createPreferredResidencyReconciler(reconcileManager, { intervalMs: 100000 });
stoppedReconciler.stop();
assert.equal((await stoppedReconciler.reconcileOnce()).skipped, 'closed');

// ---------------------------------------------------------------------------
// Deterministic preferred-restore plans: spare capacity, idle-only ordinary
// eviction after grace, and atomic protection for active/preferred runtimes.
// ---------------------------------------------------------------------------

const now = Date.now();
const oldIdle = new Date(now - 60_000).toISOString();
const freshIdle = new Date(now - 1_000).toISOString();
const runtimeStatus = (extra = {}) => ({
  healthy: true,
  status: 'running',
  activeRequests: 0,
  queuedRequests: 0,
  admissionQueuedRequests: 0,
  lastRequestedAt: oldIdle,
  lastIdleAt: oldIdle,
  ...extra
});

const sparePlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 40 },
    runtimes: {
      pin: { enabled: true, keepWarm: true, memoryGb: 10 },
      image: { enabled: true, preferredWarm: true, memoryGb: 10 },
      ordinary: { enabled: true, memoryGb: 10 }
    }
  },
  {
    requestedRuntimeId: 'image',
    profile: { totalMemoryGb: 40, availableMemoryGb: 35 },
    status: {
      runtimes: {
        pin: runtimeStatus(),
        ordinary: runtimeStatus(),
        image: runtimeStatus({ healthy: false, status: 'stopped' })
      }
    }
  }
);
assert.deepEqual(
  sparePlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:image']
);

const gracePlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 25 },
    runtimes: {
      image: { enabled: true, preferredWarm: true, memoryGb: 10 },
      otherImage: { enabled: true, preferredWarm: true, memoryGb: 10 },
      oldOrdinary: { enabled: true, memoryGb: 10 },
      freshOrdinary: { enabled: true, memoryGb: 10 }
    }
  },
  {
    requestedRuntimeId: 'image',
    profile: { totalMemoryGb: 40, availableMemoryGb: 25 },
    preferredRestore: true,
    preferredWarmIdleMs: 30_000,
    status: {
      runtimes: {
        image: runtimeStatus({ healthy: false, status: 'stopped' }),
        otherImage: runtimeStatus(),
        oldOrdinary: runtimeStatus({ lastIdleAt: oldIdle }),
        freshOrdinary: runtimeStatus({ lastIdleAt: freshIdle })
      }
    }
  }
);
assert.deepEqual(
  gracePlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:oldOrdinary', 'start:image']
);

const activePlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 25, protectActiveRequests: true },
    runtimes: {
      image: { enabled: true, preferredWarm: true, memoryGb: 10 },
      busy: { enabled: true, memoryGb: 10 },
      queued: { enabled: true, memoryGb: 10 },
      idle: { enabled: true, memoryGb: 10 }
    }
  },
  {
    requestedRuntimeId: 'image',
    profile: { totalMemoryGb: 40, availableMemoryGb: 25 },
    preferredRestore: true,
    preferredWarmIdleMs: 30_000,
    status: {
      runtimes: {
        image: runtimeStatus({ healthy: false, status: 'stopped' }),
        busy: runtimeStatus({ activeRequests: 1 }),
        queued: runtimeStatus({ queuedRequests: 1 }),
        idle: runtimeStatus({ lastIdleAt: oldIdle })
      }
    }
  }
);
assert.deepEqual(
  activePlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:idle', 'start:image']
);
assert.deepEqual(activePlan.admissionQueuedRequests ?? [], []);

// ---------------------------------------------------------------------------
// The preferred-restore admission option runs the guard and plan under the
// same admission mutex, after queued status awaits, using live manager config.
// ---------------------------------------------------------------------------

const oldStatus = {
  runtimes: { image: runtimeStatus({ healthy: false, status: 'stopped' }) }
};
function fakeAdmissionManager(initialConfig) {
  const manager = {
    config: initialConfig,
    shuttingDown: false,
    admissionQueue: Promise.resolve(),
    statusCalls: 0,
    sideEffects: [],
    async status() {
      manager.statusCalls += 1;
      await manager.gate.promise;
      return oldStatus;
    },
    resolveAdmissionGuard({ runtimeId, reason }) {
      if (manager.shuttingDown) {
        return { ok: false, code: 'runtime_manager_shutdown', message: 'shutting down' };
      }
      if (reason === 'preferred-warm-reconcile') {
        const runtime = manager.config.runtimes?.[runtimeId];
        if (runtime?.enabled !== true || runtime?.preferredWarm !== true) {
          return { ok: false, code: 'preferred_warm_revoked', message: 'preferred warm removed' };
        }
      }
      return { ok: true };
    },
    async stop(runtimeId) {
      manager.sideEffects.push(`stop:${runtimeId}`);
      return { runtimeId, stopped: true };
    },
    async start(runtimeId) {
      manager.sideEffects.push(`start:${runtimeId}`);
      return { runtimeId, started: true };
    },
    withAdmissionLock(fn) {
      const run = manager.admissionQueue.catch(() => {}).then(() => fn(new AbortController().signal));
      manager.admissionQueue = run.catch(() => {});
      return run;
    }
  };
  return manager;
}

const toggleManager = fakeAdmissionManager({
  runtimePolicy: { memoryBudgetGb: 40 },
  runtimes: { image: { enabled: true, preferredWarm: true, memoryGb: 10 } }
});
toggleManager.gate = deferred();
const queuedToggle = applyRuntimePolicyPlan(toggleManager.config, toggleManager, {
  requestedRuntimeId: 'image',
  dryRun: false,
  yes: true,
  reason: 'preferred-warm-reconcile',
  preferredRestore: true,
  preferredWarmIdleMs: 30_000,
  profile: { totalMemoryGb: 40, availableMemoryGb: 35 }
});
await Promise.resolve();
toggleManager.config = {
  ...toggleManager.config,
  runtimes: { image: { ...toggleManager.config.runtimes.image, preferredWarm: false } }
};
toggleManager.gate.resolve();
await assert.rejects(
  () => queuedToggle,
  (error) => error.code === 'preferred_warm_revoked'
);
assert.deepEqual(toggleManager.sideEffects, []);

const shutdownManager = fakeAdmissionManager(toggleManager.config);
shutdownManager.gate = deferred();
const queuedShutdown = applyRuntimePolicyPlan(shutdownManager.config, shutdownManager, {
  requestedRuntimeId: 'image',
  dryRun: false,
  yes: true,
  reason: 'preferred-warm-reconcile',
  preferredRestore: true,
  preferredWarmIdleMs: 30_000,
  profile: { totalMemoryGb: 40, availableMemoryGb: 35 }
});
await Promise.resolve();
shutdownManager.shuttingDown = true;
shutdownManager.gate.resolve();
await assert.rejects(
  () => queuedShutdown,
  (error) => error.code === 'runtime_manager_shutdown'
);
assert.deepEqual(shutdownManager.sideEffects, []);

// Guards directly cover disabled and unowned preferred lanes, including a
// runtime maintenance suspension.
const guardedManager = new RuntimeManager(
  {
    runtimes: {
      image: {
        enabled: false,
        preferredWarm: true,
        command: 'sleep',
        port: 8204,
        maintenance: { state: 'suspended', requestedModel: 'm', since: '2026-01-01T00:00:00Z', operationId: 'op' }
      }
    }
  },
  { logger: { error() {}, warn() {} } }
);
assert.equal(
  guardedManager.resolveAdmissionGuard({ runtimeId: 'image', reason: 'preferred-warm-reconcile' }).code,
  'preferred_warm_revoked'
);
assert.equal(guardedManager.residencyOwnership('image').owned, false);

// A residency boot pass starts every hard pin before any preferred runtime and
// passes the configured idle grace only to the restore/reconcile path.
const bootConfig = {
  runtimePolicy: { preferredWarmIdleMs: 1234 },
  runtimes: {
    secondPin: { enabled: true, keepWarm: true, command: 'sleep', port: 8205 },
    firstPin: { enabled: true, keepWarm: true, command: 'sleep', port: 8206 },
    image: { enabled: true, preferredWarm: true, command: 'sleep', port: 8207 }
  }
};
const bootManager = new RuntimeManager(bootConfig, { logger: { error() {}, warn() {} } });
const bootCalls = [];
bootManager.admit = async (runtimeId, options) => {
  bootCalls.push([runtimeId, options.reason, options.allowEviction, options.preferredWarmIdleMs]);
  return { runtimeId };
};
await bootManager.startKeepWarm();
assert.deepEqual(
  bootCalls.map(([runtimeId, reason]) => `${runtimeId}:${reason}`),
  ['secondPin:keep-warm', 'firstPin:keep-warm', 'image:preferred-warm']
);
assert.deepEqual(
  bootCalls.map(([, , allowEviction, idleMs]) => [allowEviction, idleMs]),
  [
    [true, 0],
    [true, 0],
    [false, 0]
  ]
);

// All owned enabled pins must settle before the reconciler requests a
// preferred restore. This prevents a soft image startup from stealing space
// while an essential pin is still pending.
const pinCalls = [];
const pinsManager = {
  config: { runtimes: { pin: { enabled: true, keepWarm: true }, image: { enabled: true, preferredWarm: true } } },
  preferredWarmRuntimeIds: () => ['image'],
  keepWarmRuntimeIds: () => ['pin'],
  residencyOwnership: () => ({ owned: true, reason: null }),
  async status() {
    return { runtimes: { pin: { healthy: false, status: 'starting' }, image: { healthy: false, status: 'stopped' } } };
  },
  async admit(runtimeId) {
    pinCalls.push(runtimeId);
    return { runtimeId };
  }
};
const pinReconciler = createPreferredResidencyReconciler(pinsManager, { intervalMs: 100000 });
assert.equal((await pinReconciler.reconcileOnce()).skipped, 'pins-pending');
assert.deepEqual(pinCalls, []);

// Closing waits for an admission queued behind another operation and revokes
// its permission before it can start a process.
const closingManager = fakeAdmissionManager({
  runtimePolicy: { memoryBudgetGb: 40 },
  runtimes: { image: { enabled: true, preferredWarm: true, memoryGb: 10 } }
});
const admissionBarrier = deferred();
const admissionQueued = deferred();
closingManager.admissionQueue = admissionBarrier.promise;
closingManager.status = async () => oldStatus;
closingManager.preferredWarmRuntimeIds = () => ['image'];
closingManager.keepWarmRuntimeIds = () => [];
closingManager.residencyOwnership = () => ({ owned: true });
closingManager.admit = (runtimeId, options) => {
  admissionQueued.resolve();
  return applyRuntimePolicyPlan(closingManager.config, closingManager, {
    ...options,
    requestedRuntimeId: runtimeId,
    dryRun: false,
    yes: true,
    profile: { totalMemoryGb: 40, availableMemoryGb: 35 }
  });
};
const closingReconciler = createPreferredResidencyReconciler(closingManager);
const closingPass = closingReconciler.reconcileOnce();
await admissionQueued.promise;
let closeSettled = false;
const closeWait = closingReconciler.stop().then(() => {
  closeSettled = true;
});
await Promise.resolve();
assert.equal(closeSettled, false);
admissionBarrier.resolve();
await closeWait;
await closingPass;
assert.deepEqual(closingManager.sideEffects, []);
assert.equal((await closingReconciler.reconcileOnce()).skipped, 'closed');

// Background restoration cannot be configured to evict active work, even if
// an operator disables active protection for ordinary explicit admissions.
for (const protection of [{ activeRequests: 1 }, { queuedRequests: 1 }]) {
  const plan = await createRuntimePolicyPlan(
    {
      runtimePolicy: { memoryBudgetGb: 15, protectActiveRequests: false },
      runtimes: {
        image: { enabled: true, preferredWarm: true, memoryGb: 10 },
        busy: { enabled: true, memoryGb: 10 }
      }
    },
    {
      requestedRuntimeId: 'image',
      preferredRestore: true,
      preferredWarmIdleMs: 30000,
      profile: { totalMemoryGb: 40, availableMemoryGb: 25 },
      status: { runtimes: { image: { status: 'stopped' }, busy: runtimeStatus(protection) } }
    }
  );
  assert.equal(plan.admission.allowed, false);
  assert.equal(
    plan.actions.some((action) => action.type === 'stop'),
    false
  );
}

// An adopted cached runtime gets an idle grace after gateway restart even
// though its previous request timestamps are unavailable.
const adoptedPlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 15 },
    runtimes: { image: { enabled: true, preferredWarm: true, memoryGb: 10 }, adopted: { enabled: true, memoryGb: 10 } }
  },
  {
    requestedRuntimeId: 'image',
    preferredRestore: true,
    preferredWarmIdleMs: 30000,
    profile: { totalMemoryGb: 40, availableMemoryGb: 25 },
    status: {
      runtimes: { image: { status: 'stopped' }, adopted: runtimeStatus({ lastIdleAt: null, statusSince: oldIdle }) }
    }
  }
);
assert.equal(adoptedPlan.actions[0].runtimeId, 'adopted');
assert.equal(adoptedPlan.actions[0].type, 'stop');
guardedManager.shuttingDown = true;
await assert.rejects(guardedManager.startUnlocked('image'), (error) => error.code === 'runtime_manager_shutdown');
// Draining an already-idle victim changes lifecycle statusSince, not its
// request-idle age. That transition must not make every restore self-cancel.
function idleDrainManager() {
  const manager = fakeAdmissionManager({
    runtimePolicy: { memoryBudgetGb: 15 },
    runtimes: { image: { enabled: true, preferredWarm: true, memoryGb: 10 }, victim: { enabled: true, memoryGb: 10 } }
  });
  const victim = runtimeStatus({ lastIdleAt: null, statusSince: oldIdle });
  manager.status = async () => ({ runtimes: { image: { status: 'stopped' }, victim } });
  manager.stateFor = () => victim;
  manager.drainRuntime = async () => {
    victim.statusSince = new Date().toISOString();
  };
  return manager;
}
const idleDrain = idleDrainManager();
const restoreOptions = {
  requestedRuntimeId: 'image',
  reason: 'preferred-warm-reconcile',
  preferredRestore: true,
  preferredWarmIdleMs: 30000,
  dryRun: false,
  yes: true,
  profile: { totalMemoryGb: 40, availableMemoryGb: 25 }
};
await applyRuntimePolicyPlan(idleDrain.config, idleDrain, restoreOptions);
assert.deepEqual(idleDrain.sideEffects, ['stop:victim', 'start:image']);
const changedDuringDrain = idleDrainManager();
changedDuringDrain.drainRuntime = async () => {
  changedDuringDrain.config = { ...changedDuringDrain.config, runtimePolicy: { memoryBudgetGb: 1 } };
};
await assert.rejects(
  applyRuntimePolicyPlan(changedDuringDrain.config, changedDuringDrain, restoreOptions),
  (error) => error.code === 'runtime_residency_changed'
);
assert.deepEqual(changedDuringDrain.sideEffects, []);

console.log('runtime-residency tests passed');
