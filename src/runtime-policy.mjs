import os from 'node:os';
import { readHostMemory } from './host-memory.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { clusterNodes, runtimeResourcesByNode } from './cluster.mjs';

export class RuntimeAdmissionError extends Error {
  constructor(message, { plan, temporary = false, retryAfterSeconds = 2 } = {}) {
    super(message);
    this.name = 'RuntimeAdmissionError';
    this.plan = plan;
    this.temporary = temporary;
    this.retryAfterSeconds = retryAfterSeconds;
    this.statusCode = temporary ? 429 : 503;
    this.code = temporary ? 'runtime_capacity_busy' : 'runtime_capacity_impossible';
    this.type = 'runtime_admission_error';
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function runtimeMemoryGb(runtime) {
  return (
    numberOrNull(runtime?.memoryGb) ??
    numberOrNull(runtime?.resources?.memoryGb) ??
    numberOrNull(runtime?.resourceEstimate?.memoryGb) ??
    numberOrNull(runtime?.estimatedMemoryGb) ??
    0
  );
}

function runtimePriority(runtime, { requested = false, keepWarm = false } = {}) {
  if (requested) return 100000;
  const explicit = numberOrNull(runtime?.policy?.priority ?? runtime?.priority);
  if (explicit != null) return explicit;
  return keepWarm ? 100 : 0;
}

function runtimeEvictable(runtime) {
  return runtime?.policy?.evictable !== false && runtime?.evictable !== false;
}

function isRuntimeLoaded(status) {
  return status?.healthy === true || ['running', 'external', 'starting'].includes(status?.status);
}

async function liveMemoryProfile(profile = {}) {
  if (numberOrNull(profile.totalMemoryGb) != null && numberOrNull(profile.availableMemoryGb) != null) return profile;
  const memory = await readHostMemory();
  return {
    ...profile,
    totalMemoryGb: numberOrNull(profile.totalMemoryGb) ?? memory.totalBytes / 1024 / 1024 / 1024,
    availableMemoryGb: numberOrNull(profile.availableMemoryGb) ?? memory.availableBytes / 1024 / 1024 / 1024
  };
}

function policyConfig(config, profile = {}) {
  const policy = config.runtimePolicy ?? {};
  const totalMemoryGb = numberOrNull(profile.totalMemoryGb) ?? Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const reserveMemoryGb = numberOrNull(policy.reserveMemoryGb) ?? 8;
  const maxMemoryUtilization = numberOrNull(policy.maxMemoryUtilization);
  const memoryBudgetGb =
    numberOrNull(policy.memoryBudgetGb) ??
    (maxMemoryUtilization != null
      ? Math.max(0, totalMemoryGb * maxMemoryUtilization)
      : Math.max(0, totalMemoryGb - reserveMemoryGb));
  return {
    enabled: policy.enabled !== false,
    autoEvict: policy.autoEvict === true,
    totalMemoryGb,
    reserveMemoryGb,
    memoryBudgetGb,
    maxMemoryUtilization,
    protectActiveRequests: policy.protectActiveRequests !== false,
    protectKeepWarm: true
  };
}

function runtimeRows(config, status, requestedRuntimeId) {
  const distributedMembers = new Set(
    Object.values(config.runtimes ?? {}).flatMap((runtime) =>
      runtime?.placement?.mode === 'distributed'
        ? (runtime.placement.members ?? []).map((member) => member.runtime).filter(Boolean)
        : []
    )
  );
  const keepWarm = new Set(
    Object.entries(config.runtimes ?? {})
      .filter(([, runtime]) => runtime.keepWarm === true)
      .map(([runtimeId]) => runtimeId)
  );
  return Object.entries(config.runtimes ?? {}).map(([runtimeId, runtime]) => {
    const runtimeStatus = status?.runtimes?.[runtimeId] ?? {};
    const requested = runtimeId === requestedRuntimeId;
    const loaded = isRuntimeLoaded(runtimeStatus);
    const ownedByDistributedGroup = distributedMembers.has(runtimeId);
    const memoryGb = ownedByDistributedGroup ? 0 : runtimeMemoryGb(runtime);
    return {
      runtimeId,
      enabled: runtime.enabled === true,
      requested,
      keepWarm: keepWarm.has(runtimeId),
      loaded,
      healthy: runtimeStatus.healthy === true,
      status: runtimeStatus.status ?? 'unknown',
      activeRequests: runtimeStatus.activeRequests ?? 0,
      queuedRequests: runtimeStatus.queuedRequests ?? 0,
      lastRequestedAt: runtimeStatus.lastRequestedAt ?? null,
      lastIdleAt: runtimeStatus.lastIdleAt ?? null,
      memoryGb,
      resourcesByNode: ownedByDistributedGroup ? {} : runtimeResourcesByNode(runtime, config),
      ownedByDistributedGroup,
      priority: runtimePriority(runtime, {
        requested,
        keepWarm: keepWarm.has(runtimeId)
      }),
      evictable: runtimeEvictable(runtime),
      command: runtime.command ?? null,
      port: runtime.port ?? null
    };
  });
}

function protectedReasons(row, policy) {
  const reasons = [];
  if (row.requested) reasons.push('requested');
  if (!row.evictable) reasons.push('pinned');
  if (policy.protectActiveRequests && row.activeRequests > 0) reasons.push('active-requests');
  // keepWarm is a hard pin: request-time admission may never evict it.
  if (row.keepWarm) reasons.push('keep-warm');
  return reasons;
}

function clusterAdmissionEnabled(config) {
  return (
    Object.keys(config.cluster?.nodes ?? {}).length > 0 ||
    Object.values(config.runtimes ?? {}).some((runtime) => runtime?.node || runtime?.placement)
  );
}

function bytesToGb(value) {
  const number = numberOrNull(value);
  return number == null ? null : number / 1024 / 1024 / 1024;
}

function nodeMemoryProfile(config, nodeId, clusterStatus, fallbackProfile) {
  const configured = clusterNodes(config)[nodeId]?.resources ?? {};
  const node = clusterStatus?.nodes?.[nodeId] ?? {};
  const telemetry = node.telemetry?.memory ?? {};
  return {
    reachable: node.reachable !== false,
    totalMemoryGb:
      bytesToGb(telemetry.totalBytes) ??
      numberOrNull(configured.memoryGb) ??
      (node.local === true ? numberOrNull(fallbackProfile?.totalMemoryGb) : null),
    availableMemoryGb:
      bytesToGb(telemetry.availableBytes) ??
      numberOrNull(configured.availableMemoryGb) ??
      (node.local === true ? numberOrNull(fallbackProfile?.availableMemoryGb) : null),
    gpuMemoryUsedGb: bytesToGb(
      node.telemetry?.gpu?.memoryUsedMb == null ? null : node.telemetry.gpu.memoryUsedMb * 1024 * 1024
    ),
    gpuMemoryTotalGb: bytesToGb(
      node.telemetry?.gpu?.memoryTotalMb == null ? null : node.telemetry.gpu.memoryTotalMb * 1024 * 1024
    )
  };
}

function clusterRuntimePolicyPlan(config, { requestedRuntimeId, profile, status, memoryProfile }) {
  const policyTemplate = config.runtimePolicy ?? {};
  const rows = runtimeRows(config, status, requestedRuntimeId);
  const requested = requestedRuntimeId ? rows.find((row) => row.runtimeId === requestedRuntimeId) : null;
  const validationErrors = [];
  const warnings = [];
  if (requestedRuntimeId && !requested) validationErrors.push(`unknown runtime ${requestedRuntimeId}`);
  const configuredNodes = clusterNodes(config);
  const clusterStatus = status?.cluster ?? profile?.cluster ?? {};
  const nodes = {};

  for (const nodeId of Object.keys(configuredNodes)) {
    const nodeProfile = nodeMemoryProfile(config, nodeId, clusterStatus, memoryProfile);
    if (nodeProfile.totalMemoryGb == null) {
      warnings.push(
        `cluster node ${nodeId} has no live or configured memory capacity; admission is blocked for new work on that node`
      );
    }
    const totalMemoryGb = nodeProfile.totalMemoryGb ?? 0;
    const reserveMemoryGb =
      numberOrNull(configuredNodes[nodeId].resources?.reserveMemoryGb) ??
      numberOrNull(policyTemplate.reserveMemoryGb) ??
      8;
    const maxMemoryUtilization = numberOrNull(
      configuredNodes[nodeId].resources?.maxMemoryUtilization ?? policyTemplate.maxMemoryUtilization
    );
    const memoryBudgetGb =
      numberOrNull(configuredNodes[nodeId].resources?.memoryBudgetGb) ??
      numberOrNull(policyTemplate.memoryBudgetGb) ??
      (maxMemoryUtilization != null
        ? Math.max(0, totalMemoryGb * maxMemoryUtilization)
        : Math.max(0, totalMemoryGb - reserveMemoryGb));
    const loadedMemoryGb = rows
      .filter((row) => row.loaded)
      .reduce((sum, row) => sum + numberOrNull(row.resourcesByNode?.[nodeId]?.memoryGb), 0);
    const requestedAddsMemoryGb =
      requested && !requested.loaded ? (numberOrNull(requested.resourcesByNode?.[nodeId]?.memoryGb) ?? 0) : 0;
    const actualUsedMemoryGb = Math.max(
      0,
      totalMemoryGb - (numberOrNull(nodeProfile.availableMemoryGb) ?? totalMemoryGb)
    );
    const predictive = maxMemoryUtilization != null && nodeProfile.availableMemoryGb != null;
    const projectedMemoryGb = (predictive ? actualUsedMemoryGb : loadedMemoryGb) + requestedAddsMemoryGb;
    const overBudgetGb = Math.max(0, projectedMemoryGb - memoryBudgetGb);
    nodes[nodeId] = {
      ...nodeProfile,
      reserveMemoryGb,
      maxMemoryUtilization,
      memoryBudgetGb,
      loadedMemoryGb,
      actualUsedMemoryGb,
      requestedAddsMemoryGb,
      projectedMemoryGb,
      predictive,
      // Admission protects *new* allocations. A request for an already-loaded
      // runtime consumes no additional model memory and must not wait on the
      // very active request that is asking to use it.
      overBudgetGb: requested?.loaded ? 0 : overBudgetGb
    };
  }

  const actions = [];
  if (requested && !requested.loaded) {
    actions.push({
      type: 'start',
      runtimeId: requested.runtimeId,
      reason: 'requested-runtime',
      memoryGb: requested.memoryGb,
      resourcesByNode: requested.resourcesByNode
    });
  }

  const policy = {
    enabled: policyTemplate.enabled !== false,
    autoEvict: policyTemplate.autoEvict === true,
    protectActiveRequests: policyTemplate.protectActiveRequests !== false,
    protectKeepWarm: true,
    clustered: true
  };
  const candidates = rows
    .filter((row) => row.loaded)
    .filter((row) => protectedReasons(row, policy).length === 0)
    .sort((left, right) => {
      const leftUsed = Date.parse(left.lastRequestedAt || left.lastIdleAt || 0) || 0;
      const rightUsed = Date.parse(right.lastRequestedAt || right.lastIdleAt || 0) || 0;
      if (leftUsed !== rightUsed) return leftUsed - rightUsed;
      if (left.priority !== right.priority) return left.priority - right.priority;
      return right.memoryGb - left.memoryGb;
    });

  const evictions = [];
  for (const row of candidates) {
    const freesConstrainedNode = Object.entries(row.resourcesByNode).some(
      ([nodeId, resources]) => nodes[nodeId]?.overBudgetGb > 0 && numberOrNull(resources.memoryGb) > 0
    );
    if (!freesConstrainedNode) continue;
    evictions.push({
      type: 'stop',
      runtimeId: row.runtimeId,
      reason: 'node-memory-budget',
      freesMemoryGb: row.memoryGb,
      resourcesByNode: row.resourcesByNode,
      priority: row.priority
    });
    for (const [nodeId, resources] of Object.entries(row.resourcesByNode)) {
      if (nodes[nodeId]) nodes[nodeId].overBudgetGb = Math.max(0, nodes[nodeId].overBudgetGb - resources.memoryGb);
    }
    if (Object.values(nodes).every((node) => node.overBudgetGb <= 0)) break;
  }
  actions.unshift(...evictions);

  const requestedNodes = Object.keys(requested?.resourcesByNode ?? {});
  for (const nodeId of requestedNodes) {
    if (!nodes[nodeId]?.totalMemoryGb) validationErrors.push(`cluster node ${nodeId} has no known memory capacity`);
    if (clusterStatus.nodes?.[nodeId]?.reachable === false)
      validationErrors.push(`cluster node ${nodeId} is unreachable`);
  }
  const blockedRows = rows
    .filter((row) => row.loaded)
    .map((row) => ({ runtimeId: row.runtimeId, protectedReasons: protectedReasons(row, policy) }))
    .filter((row) => row.protectedReasons.length);
  const overBudgetGb = Object.values(nodes).reduce((sum, node) => sum + node.overBudgetGb, 0);
  const allowed = validationErrors.length === 0 && overBudgetGb <= 0;
  if (!allowed && overBudgetGb > 0) {
    warnings.push(
      `requested runtime exceeds per-node memory budgets by ${Math.round(overBudgetGb * 10) / 10} GB after safe evictions`
    );
  }

  return {
    ok: validationErrors.length === 0,
    policy,
    requestedRuntimeId: requestedRuntimeId ?? null,
    admission: {
      allowed,
      clustered: true,
      overBudgetGb,
      nodes
    },
    runtimes: rows,
    actions,
    protected: blockedRows,
    warnings,
    validationErrors
  };
}

export async function createRuntimePolicyPlan(config, { requestedRuntimeId, profile, status } = {}) {
  const runtimeStatus =
    status ??
    (await new RuntimeManager(config, {
      captureOutput: false,
      logger: { error() {} }
    }).status());
  const memoryProfile = await liveMemoryProfile(profile);
  if (clusterAdmissionEnabled(config)) {
    return clusterRuntimePolicyPlan(config, { requestedRuntimeId, profile, status: runtimeStatus, memoryProfile });
  }
  const policy = policyConfig(config, memoryProfile);
  const rows = runtimeRows(config, runtimeStatus, requestedRuntimeId);
  const requested = requestedRuntimeId ? rows.find((row) => row.runtimeId === requestedRuntimeId) : null;
  const validationErrors = [];
  const warnings = [];
  if (requestedRuntimeId && !requested) validationErrors.push(`unknown runtime ${requestedRuntimeId}`);

  const loadedMemoryGb = rows.filter((row) => row.loaded).reduce((sum, row) => sum + row.memoryGb, 0);
  const requestedAddsMemory = requested && !requested.loaded ? requested.memoryGb : 0;
  const actualUsedMemoryGb = Math.max(
    0,
    policy.totalMemoryGb - (numberOrNull(memoryProfile.availableMemoryGb) ?? policy.totalMemoryGb)
  );
  const predictive = policy.maxMemoryUtilization != null;
  const projectedMemoryGb = (predictive ? actualUsedMemoryGb : loadedMemoryGb) + requestedAddsMemory;
  let overBudgetGb = requested?.loaded ? 0 : Math.max(0, projectedMemoryGb - policy.memoryBudgetGb);

  const actions = [];
  const evictions = [];
  if (requested && !requested.loaded) {
    actions.push({
      type: 'start',
      runtimeId: requested.runtimeId,
      reason: 'requested-runtime',
      memoryGb: requested.memoryGb
    });
  }

  const candidates = rows
    .filter((row) => row.loaded)
    .filter((row) => protectedReasons(row, policy).length === 0)
    .sort((left, right) => {
      const leftUsed = Date.parse(left.lastRequestedAt || left.lastIdleAt || 0) || 0;
      const rightUsed = Date.parse(right.lastRequestedAt || right.lastIdleAt || 0) || 0;
      if (leftUsed !== rightUsed) return leftUsed - rightUsed;
      if (left.priority !== right.priority) return left.priority - right.priority;
      if (left.memoryGb !== right.memoryGb) return right.memoryGb - left.memoryGb;
      return left.runtimeId.localeCompare(right.runtimeId);
    });

  for (const row of candidates) {
    if (overBudgetGb <= 0) break;
    evictions.push({
      type: 'stop',
      runtimeId: row.runtimeId,
      reason: 'memory-budget',
      freesMemoryGb: row.memoryGb,
      priority: row.priority
    });
    overBudgetGb = Math.max(0, overBudgetGb - row.memoryGb);
  }

  if (projectedMemoryGb > policy.memoryBudgetGb) {
    actions.unshift(...evictions);
  }

  if (!rows.some((row) => row.memoryGb > 0)) {
    warnings.push('runtime memory estimates are missing; admission plan cannot make memory-aware eviction decisions');
  } else if (requested && requested.memoryGb <= 0) {
    warnings.push(
      `runtime ${requested.runtimeId} has no memory estimate; admission cannot predict how much capacity it needs`
    );
  }
  const blockedRows = rows
    .filter((row) => row.loaded)
    .map((row) => ({
      runtimeId: row.runtimeId,
      protectedReasons: protectedReasons(row, policy)
    }))
    .filter((row) => row.protectedReasons.length);

  const allowed = validationErrors.length === 0 && overBudgetGb <= 0;
  if (!allowed && projectedMemoryGb > policy.memoryBudgetGb) {
    warnings.push(
      `projected runtime memory exceeds policy budget by ${Math.round(overBudgetGb * 10) / 10} GB after all safe evictions`
    );
  }

  return {
    ok: validationErrors.length === 0,
    policy,
    requestedRuntimeId: requestedRuntimeId ?? null,
    admission: {
      allowed,
      overBudgetGb,
      loadedMemoryGb,
      actualUsedMemoryGb,
      availableMemoryGb: numberOrNull(memoryProfile.availableMemoryGb),
      predictive,
      requestedAddsMemoryGb: requestedAddsMemory,
      projectedMemoryGb,
      memoryBudgetGb: policy.memoryBudgetGb
    },
    runtimes: rows,
    actions,
    protected: blockedRows,
    warnings,
    validationErrors
  };
}

export async function applyRuntimePolicyPlan(
  config,
  runtimeManager,
  { requestedRuntimeId, dryRun = true, yes = false, warmup = true, force = false, reason = 'runtime-admission' } = {}
) {
  if (!requestedRuntimeId) throw new Error('requested runtime id is required');

  const applyPlan = async () => {
    const status = await runtimeManager.status();
    if (runtimeManager.clusterCoordinator) status.cluster = await runtimeManager.clusterCoordinator.status();
    const plan = await createRuntimePolicyPlan(config, {
      requestedRuntimeId,
      status
    });
    if (dryRun) {
      return {
        dryRun: true,
        plan,
        results: plan.actions.map((action) => ({
          ...action,
          status: 'planned'
        }))
      };
    }
    if (!yes) {
      throw new Error(
        'Refusing to apply runtime admission plan without yes=true. Re-run with --apply --yes after reviewing the dry-run plan.'
      );
    }
    if (plan.validationErrors.length) {
      throw new Error(
        `Runtime admission plan is invalid:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`
      );
    }
    if (!plan.policy.enabled) {
      return {
        dryRun: false,
        plan,
        results: [
          await runtimeManager.start(requestedRuntimeId, {
            force,
            warmup,
            reason
          })
        ]
      };
    }
    if (!plan.admission.allowed) {
      const activeBlockers = plan.protected.filter((item) => item.protectedReasons.includes('active-requests'));
      const permanentBlockers = plan.protected.filter((item) =>
        item.protectedReasons.some((reason) => reason === 'pinned' || reason === 'keep-warm')
      );
      const temporary = activeBlockers.length > 0;
      const blockerText = [...activeBlockers, ...permanentBlockers]
        .map((item) => `${item.runtimeId} (${item.protectedReasons.join(', ')})`)
        .join(', ');
      throw new RuntimeAdmissionError(
        temporary
          ? `Runtime ${requestedRuntimeId} is queued for capacity; waiting for active runtime(s) to drain: ${blockerText}`
          : plan.admission.clustered
            ? `Runtime ${requestedRuntimeId} cannot fit within the per-node cluster memory budgets; protected runtime(s): ${blockerText || 'none'}`
            : `Runtime ${requestedRuntimeId} cannot fit within the ${plan.policy.memoryBudgetGb.toFixed(1)} GB memory budget; protected runtime(s): ${blockerText || 'none'}`,
        { plan, temporary }
      );
    }

    const results = [];
    for (const action of plan.actions) {
      if (action.type === 'stop') {
        if (typeof runtimeManager.drainRuntime === 'function') await runtimeManager.drainRuntime(action.runtimeId);
        try {
          results.push({
            ...action,
            status: 'applied',
            result: await runtimeManager.stop(action.runtimeId)
          });
        } finally {
          runtimeManager.resumeRuntime?.(action.runtimeId);
        }
      } else if (action.type === 'start') {
        results.push({
          ...action,
          status: 'applied',
          result: await runtimeManager.start(action.runtimeId, {
            force,
            warmup,
            reason
          })
        });
      }
    }
    if (!results.some((result) => result.type === 'start')) {
      results.push({
        type: 'start',
        runtimeId: requestedRuntimeId,
        reason: 'already-admitted',
        status: 'applied',
        result: await runtimeManager.start(requestedRuntimeId, {
          force,
          warmup,
          reason
        })
      });
    }

    return {
      dryRun: false,
      plan,
      results
    };
  };

  if (!dryRun && typeof runtimeManager.withAdmissionLock === 'function') {
    return runtimeManager.withAdmissionLock(applyPlan);
  }
  return applyPlan();
}
