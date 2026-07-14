import assert from 'node:assert/strict';
import { applyRuntimePolicyPlan, createRuntimePolicyPlan } from '../src/runtime-policy.mjs';

const runtimePolicyConfig = {
  runtimePolicy: {
    memoryBudgetGb: 40,
    protectActiveRequests: true
  },
  runtimes: {
    warm: {
      enabled: true,
      keepWarm: true,
      memoryGb: 25,
      policy: { priority: 100 }
    },
    big: {
      enabled: true,
      memoryGb: 30,
      policy: { priority: 200 }
    },
    pinned: {
      enabled: true,
      memoryGb: 10,
      policy: { evictable: false }
    }
  }
};

const syntheticPolicyStatus = {
  runtimes: {
    warm: { healthy: true, status: 'running', activeRequests: 0, queuedRequests: 0 },
    big: { healthy: false, status: 'idle', activeRequests: 0, queuedRequests: 0 },
    pinned: { healthy: false, status: 'idle', activeRequests: 0, queuedRequests: 0 }
  }
};

const runtimePolicyPlan = await createRuntimePolicyPlan(runtimePolicyConfig, {
  requestedRuntimeId: 'big',
  status: syntheticPolicyStatus
});
assert.equal(runtimePolicyPlan.admission.allowed, false);
assert.deepEqual(
  runtimePolicyPlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:big']
);
assert.equal(runtimePolicyPlan.admission.projectedMemoryGb, 55);
assert(runtimePolicyPlan.protected.some((entry) => entry.runtimeId === 'warm' && entry.protectedReasons.includes('keep-warm')));

const predictiveConfig = {
  runtimePolicy: {
    maxMemoryUtilization: 0.9,
    protectActiveRequests: true
  },
  runtimes: {
    loaded: { enabled: true, memoryGb: 64 },
    requested: { enabled: true, memoryGb: 64 }
  }
};
const predictiveStatus = {
  runtimes: {
    loaded: { healthy: true, status: 'running', activeRequests: 0 },
    requested: { healthy: false, status: 'idle', activeRequests: 0 }
  }
};
const predictivePlan = await createRuntimePolicyPlan(predictiveConfig, {
  requestedRuntimeId: 'requested',
  status: predictiveStatus,
  profile: { totalMemoryGb: 128, availableMemoryGb: 60 }
});
assert.equal(predictivePlan.admission.predictive, true);
assert.equal(predictivePlan.admission.actualUsedMemoryGb, 68);
assert.equal(predictivePlan.admission.memoryBudgetGb, 115.2);
assert.deepEqual(
  predictivePlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:loaded', 'start:requested']
);

const coexistPlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { maxMemoryUtilization: 0.9 },
    runtimes: {
      loaded: { enabled: true, memoryGb: 20 },
      requested: { enabled: true, memoryGb: 20 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    status: predictiveStatus,
    profile: { totalMemoryGb: 128, availableMemoryGb: 78 }
  }
);
assert.deepEqual(
  coexistPlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:requested']
);

const lruPlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 60 },
    runtimes: {
      old: { enabled: true, memoryGb: 20, policy: { priority: 100 } },
      recent: { enabled: true, memoryGb: 20, policy: { priority: 1 } },
      requested: { enabled: true, memoryGb: 30 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    status: {
      runtimes: {
        old: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-07-13T00:00:00Z' },
        recent: { healthy: true, status: 'running', activeRequests: 0, lastRequestedAt: '2026-07-13T01:00:00Z' },
        requested: { healthy: false, status: 'idle', activeRequests: 0 }
      }
    }
  }
);
assert.equal(lruPlan.actions[0].runtimeId, 'old');

const blockedPolicyPlan = await createRuntimePolicyPlan(runtimePolicyConfig, {
  requestedRuntimeId: 'big',
  status: {
    runtimes: {
      ...syntheticPolicyStatus.runtimes,
      warm: {
        ...syntheticPolicyStatus.runtimes.warm,
        activeRequests: 1
      }
    }
  }
});
assert.equal(blockedPolicyPlan.admission.allowed, false);
assert(
  blockedPolicyPlan.protected.some(
    (entry) => entry.runtimeId === 'warm' && entry.protectedReasons.includes('active-requests')
  )
);

const policyOperations = [];
const evictablePolicyConfig = {
  ...runtimePolicyConfig,
  runtimes: {
    ...runtimePolicyConfig.runtimes,
    warm: { ...runtimePolicyConfig.runtimes.warm, keepWarm: false }
  }
};
const fakePolicyManager = {
  async status() {
    return syntheticPolicyStatus;
  },
  async stop(runtimeId) {
    policyOperations.push(`stop:${runtimeId}`);
    return { runtimeId, stopped: true };
  },
  async start(runtimeId, options) {
    policyOperations.push(`start:${runtimeId}:${options.reason}`);
    return { runtimeId, started: true, options };
  }
};

const dryRun = await applyRuntimePolicyPlan(runtimePolicyConfig, fakePolicyManager, {
  requestedRuntimeId: 'big'
});
assert.equal(dryRun.dryRun, true);

await assert.rejects(
  () =>
    applyRuntimePolicyPlan(runtimePolicyConfig, fakePolicyManager, {
      requestedRuntimeId: 'big',
      dryRun: false
    }),
  /without yes=true/
);

const applied = await applyRuntimePolicyPlan(evictablePolicyConfig, fakePolicyManager, {
  requestedRuntimeId: 'big',
  dryRun: false,
  yes: true,
  reason: 'unit-admit'
});
assert.equal(applied.dryRun, false);
assert.deepEqual(policyOperations, ['stop:warm', 'start:big:unit-admit']);

console.log('runtime-policy tests passed');
