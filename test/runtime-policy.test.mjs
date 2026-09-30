import assert from 'node:assert/strict';
import {
  applyRuntimePolicyPlan as applyPolicy,
  createRuntimePolicyPlan as createPolicy,
  runtimeAdmissionBlockers
} from '../src/runtime-policy.mjs';

// Keep synthetic capacity tests independent of the developer machine's load.
const profile = { totalMemoryGb: 128, availableMemoryGb: 128 };
const createRuntimePolicyPlan = (config, options) => createPolicy(config, { profile, ...options });
const applyRuntimePolicyPlan = (config, manager, options) => applyPolicy(config, manager, { profile, ...options });

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
    idle: { enabled: true, memoryGb: 10 }
  }
};

const syntheticPolicyStatus = {
  runtimes: {
    warm: { healthy: true, status: 'running', activeRequests: 0, queuedRequests: 0 },
    big: { healthy: false, status: 'idle', activeRequests: 0, queuedRequests: 0 },
    idle: { healthy: false, status: 'idle', activeRequests: 0, queuedRequests: 0 }
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
assert(
  runtimePolicyPlan.protected.some(
    (entry) => entry.runtimeId === 'warm' && entry.protectedReasons.includes('keep-warm-pin')
  )
);

const drainingBlockerPlan = await createRuntimePolicyPlan(
  {
    runtimePolicy: { memoryBudgetGb: 40, protectActiveRequests: true },
    runtimes: {
      sidecar: { enabled: true, keepWarm: true, memoryGb: 10 },
      resident: { enabled: true, memoryGb: 30 },
      requested: { enabled: true, memoryGb: 30 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    status: {
      runtimes: {
        sidecar: { healthy: true, status: 'running', activeRequests: 0 },
        resident: { healthy: true, status: 'running', activeRequests: 1 },
        requested: { healthy: false, status: 'idle', activeRequests: 0 }
      }
    }
  }
);
assert.equal(drainingBlockerPlan.admission.allowed, false);
assert.deepEqual(
  runtimeAdmissionBlockers(drainingBlockerPlan),
  {
    active: [
      {
        runtimeId: 'resident',
        protectedReasons: ['active-requests'],
        runtime: drainingBlockerPlan.runtimes.find((row) => row.runtimeId === 'resident')
      }
    ],
    pinned: [],
    authority: []
  },
  'an active evictable runtime is the causal blocker when draining it preserves the pinned sidecar'
);

const delegatedTpConfig = {
  cluster: {
    nodeId: 'worker',
    leaderNode: 'leader',
    nodes: {
      leader: { resources: { memoryGb: 128, reserveMemoryGb: 8 } },
      worker: { resources: { memoryGb: 128, reserveMemoryGb: 8 } }
    }
  },
  runtimePolicy: { enabled: true, autoEvict: true },
  runtimes: {
    'tp-head': {
      enabled: true,
      node: 'leader',
      memoryGb: 100,
      authority: { owner: 'leader', scope: 'distributed-member', group: 'tp' }
    },
    'tp-worker': {
      enabled: true,
      node: 'worker',
      memoryGb: 100,
      authority: { owner: 'leader', scope: 'distributed-member', group: 'tp' }
    },
    tp: {
      enabled: true,
      authority: { owner: 'leader', scope: 'distributed-model', group: 'tp' },
      placement: {
        mode: 'distributed',
        members: [
          { node: 'leader', runtime: 'tp-head' },
          { node: 'worker', runtime: 'tp-worker' }
        ]
      }
    },
    embedding: { enabled: true, node: 'worker', memoryGb: 30 }
  }
};
const delegatedTpStatus = {
  runtimes: {
    'tp-head': { healthy: true, status: 'running' },
    'tp-worker': { healthy: true, status: 'running' },
    tp: { healthy: true, status: 'running' },
    embedding: { healthy: false, status: 'idle' }
  }
};
const delegatedTpPlan = await createRuntimePolicyPlan(delegatedTpConfig, {
  requestedRuntimeId: 'embedding',
  requesterNode: 'worker',
  status: delegatedTpStatus
});
assert.equal(delegatedTpPlan.admission.allowed, false);
assert.deepEqual(
  delegatedTpPlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:embedding'],
  'worker-local admission must not schedule an eviction of leader-owned TP capacity'
);
assert.deepEqual(
  runtimeAdmissionBlockers(delegatedTpPlan).authority.map((blocker) => blocker.runtimeId),
  ['tp']
);
await assert.rejects(
  () =>
    applyRuntimePolicyPlan(
      delegatedTpConfig,
      {
        async status() {
          return delegatedTpStatus;
        }
      },
      {
        requestedRuntimeId: 'embedding',
        requesterNode: 'worker',
        dryRun: false,
        yes: true
      }
    ),
  (error) => error.code === 'runtime_authority_conflict' && error.temporary === false && /tp/.test(error.message)
);
await assert.rejects(
  () =>
    applyRuntimePolicyPlan(
      {
        runtimePolicy: { memoryBudgetGb: 40, protectActiveRequests: true },
        runtimes: {
          sidecar: { enabled: true, keepWarm: true, memoryGb: 10 },
          resident: { enabled: true, memoryGb: 30 },
          requested: { enabled: true, memoryGb: 30 }
        }
      },
      {
        async status() {
          return {
            runtimes: {
              sidecar: { healthy: true, status: 'running', activeRequests: 0 },
              resident: { healthy: true, status: 'running', activeRequests: 1 },
              requested: { healthy: false, status: 'idle', activeRequests: 0 }
            }
          };
        }
      },
      { requestedRuntimeId: 'requested', dryRun: false, yes: true }
    ),
  (error) =>
    error.temporary === true &&
    error.code === 'runtime_capacity_busy' &&
    /resident \(active-requests\)/.test(error.message) &&
    !error.message.includes('sidecar')
);
await assert.rejects(
  () =>
    applyRuntimePolicyPlan(
      {
        runtimePolicy: { memoryBudgetGb: 40, protectActiveRequests: true },
        runtimes: {
          resident: { enabled: true, memoryGb: 30 },
          requested: { enabled: true, memoryGb: 30 }
        }
      },
      {
        async status() {
          return {
            runtimes: {
              resident: { healthy: true, status: 'running', activeRequests: 1 },
              requested: { healthy: false, status: 'idle', activeRequests: 0 }
            }
          };
        }
      },
      { requestedRuntimeId: 'requested', dryRun: false, yes: true, allowEviction: false }
    ),
  (error) =>
    error.temporary === false &&
    error.code === 'runtime_eviction_forbidden' &&
    /eventually evicting active resident runtime/.test(error.message)
);

const unpinnedPlan = await createRuntimePolicyPlan(
  {
    ...runtimePolicyConfig,
    runtimes: {
      ...runtimePolicyConfig.runtimes,
      warm: { ...runtimePolicyConfig.runtimes.warm, keepWarm: false }
    }
  },
  {
    requestedRuntimeId: 'big',
    status: syntheticPolicyStatus
  }
);
assert.equal(unpinnedPlan.admission.allowed, true);
assert.deepEqual(
  unpinnedPlan.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['stop:warm', 'start:big']
);

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

const macReserveConfig = {
  runtimePolicy: { enabled: true, autoEvict: false, reserveMemoryGb: 12 },
  runtimes: { bonsai: { enabled: true, memoryGb: 16 } }
};
const macIdleStatus = { runtimes: { bonsai: { healthy: false, status: 'idle' } } };
for (const runtimePolicy of [macReserveConfig.runtimePolicy, { enabled: true, memoryBudgetGb: 84 }]) {
  const pressured = await createRuntimePolicyPlan(
    { ...macReserveConfig, runtimePolicy },
    {
      requestedRuntimeId: 'bonsai',
      status: macIdleStatus,
      profile: { totalMemoryGb: 96, availableMemoryGb: 16 }
    }
  );
  assert.equal(pressured.admission.predictive, true);
  assert.equal(pressured.admission.projectedMemoryGb, 96);
  assert.equal(pressured.admission.allowed, false, 'other applications count without a percentage policy');
}
const macEstimateFits = await createRuntimePolicyPlan(macReserveConfig, {
  requestedRuntimeId: 'bonsai',
  status: macIdleStatus,
  profile: { totalMemoryGb: 96, availableMemoryGb: 35 }
});
assert.equal(macEstimateFits.admission.projectedMemoryGb, 77);
assert.equal(macEstimateFits.admission.allowed, true, 'live startup guard must catch an underestimated load later');

const clusteredReserve = await createRuntimePolicyPlan(
  {
    ...macReserveConfig,
    cluster: { nodeId: 'mac', leaderNode: 'mac', nodes: { mac: { resources: { memoryGb: 96 } } } },
    runtimes: { bonsai: { enabled: true, node: 'mac', memoryGb: 16 } }
  },
  {
    requestedRuntimeId: 'bonsai',
    requesterNode: 'mac',
    status: {
      ...macIdleStatus,
      cluster: {
        nodes: {
          mac: {
            local: true,
            reachable: true,
            telemetry: { memory: { totalBytes: 96 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 } }
          }
        }
      }
    },
    profile: { totalMemoryGb: 96, availableMemoryGb: 16 }
  }
);
assert.equal(
  clusteredReserve.admission.allowed,
  false,
  'local cluster node also counts host pressure without a percentage'
);
assert.equal(clusteredReserve.admission.nodes.mac.predictive, true);

const localClusterAdmission = await createRuntimePolicyPlan(
  {
    cluster: {
      nodeId: 'ennspark03',
      leaderNode: 'ennspark03',
      nodes: {
        ennspark01: { resources: { memoryGb: 128 } },
        ennspark02: { resources: { memoryGb: 128 } },
        ennspark03: { resources: { memoryGb: 128 } }
      }
    },
    runtimePolicy: { maxMemoryUtilization: 0.9, autoEvict: true, protectActiveRequests: true },
    runtimes: {
      unrelatedIdle: { enabled: true, node: 'ennspark01', memoryGb: 20 },
      unrelatedBusy: { enabled: true, node: 'ennspark02', memoryGb: 20 },
      requested: { enabled: true, node: 'ennspark03', memoryGb: 46 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    requesterNode: 'ennspark03',
    status: {
      runtimes: {
        unrelatedIdle: { healthy: true, status: 'running', activeRequests: 0 },
        unrelatedBusy: { healthy: true, status: 'running', activeRequests: 1 },
        requested: { healthy: false, status: 'idle', activeRequests: 0 }
      },
      cluster: {
        nodes: {
          ennspark01: {
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 0 } }
          },
          ennspark02: {
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 0 } }
          },
          ennspark03: {
            local: true,
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 68 * 1024 ** 3 } }
          }
        }
      }
    }
  }
);
assert.equal(localClusterAdmission.admission.allowed, true, 'local request ignores unrelated node pressure');
assert.equal(localClusterAdmission.admission.overBudgetGb, 0);
assert.equal(localClusterAdmission.admission.nodes.ennspark01.overBudgetGb, 0);
assert.equal(localClusterAdmission.admission.nodes.ennspark02.overBudgetGb, 0);
assert.equal(localClusterAdmission.admission.nodes.ennspark03.projectedMemoryGb, 106);
assert.deepEqual(
  localClusterAdmission.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:requested'],
  'unrelated pressure must not trigger eviction while the requested node fits'
);
assert.deepEqual(
  runtimeAdmissionBlockers(localClusterAdmission),
  { active: [], pinned: [], authority: [] },
  'active work on an unrelated node is not a blocker for a local request'
);

const zeroEstimateLocal = await createRuntimePolicyPlan(
  {
    cluster: {
      nodeId: 'ennspark03',
      leaderNode: 'ennspark03',
      nodes: {
        ennspark01: { resources: { memoryGb: 128 } },
        ennspark03: { resources: { memoryGb: 128 } }
      }
    },
    runtimePolicy: { maxMemoryUtilization: 0.9, autoEvict: true },
    runtimes: {
      unrelatedIdle: { enabled: true, node: 'ennspark01', memoryGb: 20 },
      requested: { enabled: true, node: 'ennspark03', memoryGb: 0 }
    }
  },
  {
    requestedRuntimeId: 'requested',
    requesterNode: 'ennspark03',
    status: {
      runtimes: {
        unrelatedIdle: { healthy: true, status: 'running', activeRequests: 0 },
        requested: { healthy: false, status: 'idle', activeRequests: 0 }
      },
      cluster: {
        nodes: {
          ennspark01: {
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 0 } }
          },
          ennspark03: {
            local: true,
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 0 } }
          }
        }
      }
    }
  }
);
assert.equal(zeroEstimateLocal.admission.allowed, false, 'zero-estimate local placement still checks its target node');
assert(zeroEstimateLocal.admission.nodes.ennspark03.overBudgetGb > 0);
assert.equal(zeroEstimateLocal.admission.nodes.ennspark01.overBudgetGb, 0);
assert.deepEqual(
  zeroEstimateLocal.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:requested'],
  'zero-estimate local admission must not evict unrelated pressure'
);

const zeroEstimateDistributed = await createRuntimePolicyPlan(
  {
    cluster: {
      nodeId: 'leader',
      leaderNode: 'leader',
      nodes: {
        leader: { resources: { memoryGb: 128 } },
        worker: { resources: { memoryGb: 128 } },
        unrelated: { resources: { memoryGb: 128 } }
      }
    },
    runtimePolicy: { maxMemoryUtilization: 0.9, autoEvict: true },
    runtimes: {
      'group-head': { enabled: true, node: 'leader', memoryGb: 0 },
      'group-worker': { enabled: true, node: 'worker', memoryGb: 0 },
      group: {
        enabled: true,
        placement: {
          mode: 'distributed',
          members: [
            { node: 'leader', runtime: 'group-head' },
            { node: 'worker', runtime: 'group-worker' }
          ]
        }
      },
      unrelatedIdle: { enabled: true, node: 'unrelated', memoryGb: 20 }
    }
  },
  {
    requestedRuntimeId: 'group',
    requesterNode: 'leader',
    status: {
      runtimes: {
        'group-head': { healthy: false, status: 'idle' },
        'group-worker': { healthy: false, status: 'idle' },
        group: { healthy: false, status: 'idle' },
        unrelatedIdle: { healthy: true, status: 'running', activeRequests: 0 }
      },
      cluster: {
        nodes: {
          leader: {
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 128 * 1024 ** 3 } }
          },
          worker: {
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 0 } }
          },
          unrelated: {
            reachable: true,
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 0 } }
          }
        }
      }
    }
  }
);
assert.equal(
  zeroEstimateDistributed.admission.allowed,
  false,
  'zero-estimate distributed member placement still checks its target node'
);
assert(zeroEstimateDistributed.admission.nodes.worker.overBudgetGb > 0);
assert.equal(zeroEstimateDistributed.admission.nodes.unrelated.overBudgetGb, 0);
assert.deepEqual(
  zeroEstimateDistributed.actions.map((action) => `${action.type}:${action.runtimeId}`),
  ['start:group'],
  'distributed zero-estimate admission must not evict unrelated pressure'
);

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
const unpinnedPolicyConfig = {
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

await assert.rejects(
  () =>
    applyRuntimePolicyPlan(runtimePolicyConfig, fakePolicyManager, {
      requestedRuntimeId: 'big',
      dryRun: false,
      yes: true
    }),
  (error) =>
    error.code === 'runtime_keep_warm_conflict' &&
    error.temporary === false &&
    /would evict keep-warm runtime\(s\): warm/.test(error.message)
);

const applied = await applyRuntimePolicyPlan(unpinnedPolicyConfig, fakePolicyManager, {
  requestedRuntimeId: 'big',
  dryRun: false,
  yes: true,
  reason: 'unit-admit'
});
assert.equal(applied.dryRun, false);
assert.deepEqual(policyOperations, ['stop:warm', 'start:big:unit-admit']);

console.log('runtime-policy tests passed');
