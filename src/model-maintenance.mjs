import { expandedAliasMemberIds, aliasMemberIds } from './alias-resolution.mjs';

const MAINTENANCE_STATES = new Set(['suspended', 'resuming']);

function isMaintenanceRecord(value) {
  return Boolean(value) && MAINTENANCE_STATES.has(value.state);
}

/**
 * Return the applicable maintenance record for a runtime id.
 * Checks the runtime itself, then any distributed group that contains it.
 * Suspended takes precedence over resuming across all applicable records.
 */
export function runtimeMaintenance(config, runtimeId) {
  if (!config || typeof config !== 'object') return null;
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) return null;
  const runtimes = config.runtimes;
  if (!runtimes || typeof runtimes !== 'object') return null;
  const own = runtimes[runtimeId];
  const matches = [];
  for (const runtime of Object.values(runtimes)) {
    if (!runtime || typeof runtime !== 'object') continue;
    if (!isMaintenanceRecord(runtime.maintenance)) continue;
    const members = runtime.placement?.members;
    if (!Array.isArray(members)) continue;
    if (members.some((member) => member && member.runtime === runtimeId)) {
      matches.push(runtime.maintenance);
    }
  }
  if (own && isMaintenanceRecord(own.maintenance)) matches.push(own.maintenance);
  const suspended = matches.find((record) => record.state === 'suspended');
  if (suspended) return suspended;
  return matches.length > 0 ? matches[0] : null;
}

/** Maintenance in any valid state blocks routing. */
export function maintenanceBlocksRouting(config, id) {
  return runtimeMaintenance(config, id) !== null;
}

/** Only a suspended state blocks starts. */
export function maintenanceBlocksStart(config, id) {
  return runtimeMaintenance(config, id)?.state === 'suspended';
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !result.includes(value)) result.push(value);
  }
  return result;
}

function groupOwnerIds(config, runtimeId) {
  const runtimes = config.runtimes ?? {};
  const owners = [];
  for (const [id, runtime] of Object.entries(runtimes)) {
    const members = runtime?.placement?.members;
    if (!Array.isArray(members)) continue;
    if (members.some((member) => member && member.runtime === runtimeId)) owners.push(id);
  }
  return owners;
}

function containsRuntime(config, groupId, runtimeId) {
  const runtime = config.runtimes?.[groupId];
  const members = runtime?.placement?.members;
  if (!Array.isArray(members)) return false;
  return members.some((member) => member && member.runtime === runtimeId);
}

function resolveRuntimeOwner(config, runtimeId, ownersSeen) {
  const chain = ownersSeen ?? new Set();
  if (chain.has(runtimeId)) {
    throw new Error(`runtime containment cycle: ${[...chain, runtimeId].join(' -> ')}`);
  }
  const owners = groupOwnerIds(config, runtimeId);
  const groups = owners.filter((owner) => containsRuntime(config, owner, runtimeId));
  if (groups.length > 1) {
    throw new Error(`runtime ${runtimeId} is contained by multiple groups: ${groups.join(', ')}`);
  }
  if (groups.length === 0) return runtimeId;
  if (groups[0] !== runtimeId && groupOwnerIds(config, groups[0]).length) {
    throw new Error(`runtime containment cycle or nested groups: ${runtimeId}`);
  }
  const next = new Set(chain);
  next.add(runtimeId);
  return resolveRuntimeOwner(config, groups[0], next);
}

function runtimeIsUnmanaged(config, runtimeId) {
  const runtime = config.runtimes?.[runtimeId];
  return (runtime?.management ?? (runtime?.managed === false ? 'external' : 'managed')) !== 'managed';
}

function runtimeIsEnabled(config, runtimeId) {
  const runtime = config.runtimes?.[runtimeId];
  return runtime?.enabled === true;
}

function modelTargetIds(model) {
  if (model.targets?.some((target) => target?.remoteRuntime)) {
    throw new Error(`model ${model.id} has remote runtime targets; operate at its owner gateway`);
  }
  const targets =
    Array.isArray(model.targets) && model.targets.length > 0 ? model.targets : model.runtime ? [model.runtime] : [];
  return uniqueStrings(targets.map((target) => (typeof target === 'string' ? target : target?.runtime)));
}

function requireRuntimeRef(config, runtimeId) {
  if (!config.runtimes || !Object.hasOwn(config.runtimes, runtimeId)) {
    throw new Error(`target runtime ${runtimeId} is not configured`);
  }
  if (runtimeIsUnmanaged(config, runtimeId)) {
    throw new Error(`target runtime ${runtimeId} is unmanaged`);
  }
  if (!runtimeIsEnabled(config, runtimeId)) {
    throw new Error(`target runtime ${runtimeId} is not enabled`);
  }
  return runtimeId;
}

function validateOwner(config, runtimeId) {
  if (!config.runtimes || !Object.hasOwn(config.runtimes, runtimeId)) {
    throw new Error(`target runtime ${runtimeId} is not configured`);
  }
  if (runtimeIsUnmanaged(config, runtimeId)) {
    throw new Error(`target runtime ${runtimeId} is unmanaged`);
  }
  if (!runtimeIsEnabled(config, runtimeId)) {
    throw new Error(`target runtime ${runtimeId} is not enabled`);
  }
  return runtimeId;
}

function normalizedTargets(config, model) {
  const targets = modelTargetIds(model);
  if (targets.length === 0) return [];
  const normalized = [];
  for (const target of targets) {
    requireRuntimeRef(config, target);
    const owner = resolveRuntimeOwner(config, target);
    validateOwner(config, owner);
    if (!normalized.includes(owner)) normalized.push(owner);
  }
  return normalized;
}

function aliasLeafModelIds(config, id) {
  return expandedAliasMemberIds(id, config.aliases ?? {}, new Set((config.models ?? []).map((m) => m.id)), {
    includeSuspended: true
  });
}

function aliasesReferencing(config, modelIds) {
  const aliases = config.aliases ?? {};
  const direct = new Set();
  for (const [aliasId, alias] of Object.entries(aliases)) {
    const members = aliasMemberIds(alias);
    if (members.some((member) => modelIds.has(member))) direct.add(aliasId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [aliasId, alias] of Object.entries(aliases)) {
      if (direct.has(aliasId)) continue;
      const list = aliasMemberIds(alias);
      if (list.some((member) => direct.has(member))) {
        direct.add(aliasId);
        changed = true;
      }
    }
  }
  return [...direct].sort();
}

/**
 * Pure planner for `lloom suspend|resume <model-or-alias>` maintenance.
 * Returns a plan object (never mutates config).
 */
export function planModelMaintenance(config, id, action) {
  if (action !== 'suspend' && action !== 'resume') {
    throw new Error(`unsupported maintenance action: ${String(action)}`);
  }
  if (!config || typeof config !== 'object') {
    throw new Error('config is required');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('model or alias id is required');
  }
  const models = Array.isArray(config.models) ? config.models : [];
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const runtimeIds = new Set();
  let selectedModel = null;
  if (modelsById.has(id)) {
    selectedModel = modelsById.get(id);
  } else if (config.runtimes && Object.hasOwn(config.runtimes, id)) {
    requireRuntimeRef(config, id);
    runtimeIds.add(validateOwner(config, resolveRuntimeOwner(config, id)));
  } else if (config.aliases && Object.hasOwn(config.aliases, id)) {
    const leaves = aliasLeafModelIds(config, id);
    const managed = [];
    for (const leaf of leaves) {
      const model = modelsById.get(leaf);
      if (!model) continue;
      const targets = modelTargetIds(model);
      for (const target of targets) requireRuntimeRef(config, target);
      if (targets.length === 0) continue;
      if (!managed.includes(model.id)) managed.push(model.id);
    }
    if (managed.length === 0) {
      throw new Error(`alias ${id} has no managed model members`);
    }
    if (managed.length > 1) {
      throw new Error(`alias ${id} resolves to multiple managed models: ${managed.join(', ')}`);
    }
    selectedModel = modelsById.get(managed[0]);
  } else {
    throw new Error(`unknown model or alias: ${id}`);
  }
  if (selectedModel) {
    const targets = normalizedTargets(config, selectedModel);
    if (targets.length === 0) {
      throw new Error(`model ${selectedModel.id} has no configured runtime target`);
    }
    for (const target of targets) runtimeIds.add(target);
  }
  const runtimeIdList = [...runtimeIds].sort();
  for (const ownerId of runtimeIdList) {
    for (const member of config.runtimes[ownerId].placement?.members ?? []) {
      requireRuntimeRef(config, member.runtime);
      if (resolveRuntimeOwner(config, member.runtime) !== ownerId) {
        throw new Error(`runtime member ${member.runtime} has inconsistent group ownership`);
      }
    }
  }
  const affectedModelIds = [];
  for (const model of models) {
    if (!model || typeof model.id !== 'string') continue;
    const normalized = model.targets?.some((target) => target?.remoteRuntime)
      ? []
      : affectedNormalizedTargets(config, model);
    if (normalized.some((target) => runtimeIdList.includes(target))) {
      affectedModelIds.push(model.id);
    }
  }
  const affectedModels = new Set(affectedModelIds);
  const affectedAliases = aliasesReferencing(config, affectedModels);
  const state = {};
  for (const runtimeId of runtimeIdList) {
    const record = runtimeMaintenance(config, runtimeId);
    state[runtimeId] = record ? snapshotRecord(record) : null;
  }
  return {
    requestedModel: id,
    action,
    runtimeIds: runtimeIdList,
    affectedModelIds: affectedModelIds.sort(),
    affectedAliases,
    state
  };
}

function snapshotRecord(record) {
  const snapshot = { state: record.state, requestedModel: record.requestedModel, since: record.since };
  if (Object.hasOwn(record, 'operationId')) snapshot.operationId = record.operationId;
  return snapshot;
}

// Impact enumeration: do NOT filter out disabled/unmanaged siblings or runtimes;
// only resolve the containing owner group. A named-but-missing runtime still throws.
function affectedNormalizedTargets(config, model) {
  const targets = modelTargetIds(model);
  const normalized = [];
  for (const target of targets) {
    if (config.runtimes && Object.hasOwn(config.runtimes, target)) {
      const owner = resolveRuntimeOwner(config, target);
      if (!normalized.includes(owner)) normalized.push(owner);
    } else {
      throw new Error(`target runtime ${target} is not configured`);
    }
  }
  return normalized;
}

export function maintenanceError(runtimeId) {
  const error = new Error(`runtime ${runtimeId} is suspended for maintenance; use lloom resume to restore it`);
  error.code = 'RUNTIME_MAINTENANCE';
  error.statusCode = 503;
  return error;
}

export function assertMaintenanceStartAllowed(config, runtimeId) {
  if (maintenanceBlocksStart(config, runtimeId)) throw maintenanceError(runtimeId);
}
