import assert from 'node:assert/strict';
import { applyRuntimePolicyPlan, createRuntimePolicyPlan } from '../src/runtime-policy.mjs';

const runtimePolicyConfig = {
  runtimePolicy: {
    memoryBudgetGb: 40,
    protectActiveRequests: true
  },
  keepWarm: ['warm'],
  runtimes: {
    warm: {
      enabled: true,
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
assert.equal(runtimePolicyPlan.admission.allowed, true);
assert.deepEqual(
  runtimePolicyPlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:warm', 'start:big']
);
assert.equal(runtimePolicyPlan.admission.projectedMemoryGb, 55);

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

const applied = await applyRuntimePolicyPlan(runtimePolicyConfig, fakePolicyManager, {
  requestedRuntimeId: 'big',
  dryRun: false,
  yes: true,
  reason: 'unit-admit'
});
assert.equal(applied.dryRun, false);
assert.deepEqual(policyOperations, ['stop:warm', 'start:big:unit-admit']);

console.log('runtime-policy tests passed');
