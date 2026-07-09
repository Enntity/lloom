import os from 'node:os';
import { RuntimeManager } from './runtime-manager.mjs';

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function policyConfig(config, profile = {}) {
  const policy = config.runtimePolicy ?? {};
  const totalMemoryGb = numberOrNull(profile.totalMemoryGb) ?? Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const reserveMemoryGb = numberOrNull(policy.reserveMemoryGb) ?? 8;
  const memoryBudgetGb = numberOrNull(policy.memoryBudgetGb) ?? Math.max(0, totalMemoryGb - reserveMemoryGb);
  return {
    enabled: policy.enabled !== false,
    autoEvict: policy.autoEvict === true,
    totalMemoryGb,
    reserveMemoryGb,
    memoryBudgetGb,
    protectActiveRequests: policy.protectActiveRequests !== false,
    protectKeepWarm: policy.protectKeepWarm === true
  };
}

function runtimeRows(config, status, requestedRuntimeId) {
  const keepWarm = new Set(
    unique([
      ...asArray(config.keepWarm),
      ...Object.entries(config.runtimes ?? {})
        .filter(([, runtime]) => runtime.keepWarm === true)
        .map(([runtimeId]) => runtimeId)
    ])
  );
  return Object.entries(config.runtimes ?? {}).map(([runtimeId, runtime]) => {
    const runtimeStatus = status?.runtimes?.[runtimeId] ?? {};
    const requested = runtimeId === requestedRuntimeId;
    const loaded = isRuntimeLoaded(runtimeStatus);
    const memoryGb = runtimeMemoryGb(runtime);
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
      memoryGb,
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
  if (policy.protectKeepWarm && row.keepWarm) reasons.push('keep-warm');
  return reasons;
}

export async function createRuntimePolicyPlan(config, { requestedRuntimeId, profile, status } = {}) {
  const runtimeStatus =
    status ??
    (await new RuntimeManager(config, {
      captureOutput: false,
      logger: { error() {} }
    }).status());
  const policy = policyConfig(config, profile);
  const rows = runtimeRows(config, runtimeStatus, requestedRuntimeId);
  const requested = requestedRuntimeId ? rows.find((row) => row.runtimeId === requestedRuntimeId) : null;
  const validationErrors = [];
  const warnings = [];
  if (requestedRuntimeId && !requested) validationErrors.push(`unknown runtime ${requestedRuntimeId}`);

  const loadedMemoryGb = rows.filter((row) => row.loaded).reduce((sum, row) => sum + row.memoryGb, 0);
  const requestedAddsMemory = requested && !requested.loaded ? requested.memoryGb : 0;
  const projectedMemoryGb = loadedMemoryGb + requestedAddsMemory;
  let overBudgetGb = Math.max(0, projectedMemoryGb - policy.memoryBudgetGb);

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
    const plan = await createRuntimePolicyPlan(config, {
      requestedRuntimeId,
      status: await runtimeManager.status()
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
      throw new Error(`Runtime admission denied: projected memory exceeds budget by ${plan.admission.overBudgetGb} GB`);
    }

    const results = [];
    for (const action of plan.actions) {
      if (action.type === 'stop') {
        results.push({
          ...action,
          status: 'applied',
          result: await runtimeManager.stop(action.runtimeId)
        });
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
