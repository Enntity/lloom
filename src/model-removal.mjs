import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultUserModelRoot } from './config.mjs';

function clone(value) {
  return structuredClone(value);
}

function aliasTargets(alias) {
  if (typeof alias === 'string') return [alias];
  if (Array.isArray(alias?.members)) return alias.members.filter(Boolean);
  return [alias?.target, ...(Array.isArray(alias?.fallbacks) ? alias.fallbacks : [])].filter(Boolean);
}

function runtimeLoaded(status) {
  return status?.healthy === true || ['running', 'external', 'starting'].includes(status?.status);
}

function modelPathCandidates(runtime, modelRoot) {
  if (!runtime || !modelRoot) return [];
  const root = path.resolve(modelRoot);
  const candidates = (runtime.args ?? []).filter((value) => typeof value === 'string' && path.isAbsolute(value));
  const underRoot = (candidate) => {
    const relative = path.relative(root, path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  return [...new Set(candidates.filter(underRoot))];
}

// Every weight path the runtime references beneath the configured model root
// that no other model's runtime shares. A multi-component model (diffusion
// weights plus text encoder plus VAE under one directory) owns several
// payloads; returning only the first candidate orphans the rest.
function exclusiveModelPaths(runtime, otherRuntimes, modelRoot) {
  const candidates = modelPathCandidates(runtime, modelRoot);
  const exclusive = [];
  const shared = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const sharedBy = otherRuntimes.filter((other) =>
      modelPathCandidates(other, modelRoot).some((otherPath) => path.resolve(otherPath) === resolved)
    );
    (sharedBy.length ? shared : exclusive).push(resolved);
  }
  return { exclusive: [...new Set(exclusive)], shared: [...new Set(shared)] };
}

// Delete a single reclaimed weight path (a file or a model directory) and
// report how many bytes were actually removed. Returns 0 when the path was
// already absent so a preview/apply round trip stays idempotent.
async function reclaimModelFiles(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      const bytes = await directorySize(target);
      await fs.rm(target, { recursive: true, force: true });
      return bytes;
    }
    await fs.rm(target, { force: true });
    return stat.size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function directorySize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await fs.stat(child)).size;
  }
  return total;
}

function aliasesRemovedWithModel(aliases, modelId) {
  const removedTargets = new Set([modelId]);
  const removedAliases = new Set();
  if (Object.hasOwn(aliases ?? {}, modelId)) removedAliases.add(modelId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [aliasId, alias] of Object.entries(aliases ?? {})) {
      if (!removedAliases.has(aliasId) && aliasTargets(alias).some((target) => removedTargets.has(target))) {
        removedAliases.add(aliasId);
        removedTargets.add(aliasId);
        changed = true;
      }
    }
  }
  return [...removedAliases];
}

function removableDistributedMembers(config, runtimeId, removeRuntime, otherModels) {
  if (!removeRuntime || !runtimeId) return [];
  const memberIds = (config.runtimes?.[runtimeId]?.placement?.members ?? [])
    .map((member) => member?.runtime)
    .filter(Boolean);
  return memberIds.filter((memberId) => {
    if (otherModels.some((model) => model.runtime === memberId)) return false;
    return !Object.entries(config.runtimes ?? {}).some(
      ([candidateId, runtime]) =>
        candidateId !== runtimeId && (runtime?.placement?.members ?? []).some((member) => member?.runtime === memberId)
    );
  });
}

// Every runtime entry removed from `runtimes` by this plan: the dedicated
// runtime plus any exclusively owned distributed members. Stale IDs here would
// otherwise persist in init bookkeeping and be re-unioned by the next additive
// init, or keep a keep-warm pin on a runtime that no longer exists.
function removedRuntimeIds(runtimeId, removeRuntime, runtimeMembers) {
  const ids = removeRuntime && runtimeId ? [runtimeId, ...runtimeMembers] : [...runtimeMembers];
  return [...new Set(ids.filter(Boolean))];
}

export function createModelRemovalPlan(
  config,
  { modelId, configPath = config.sourcePath, deleteFiles = false, runtimeStatus = {}, externalPortListeners = [] } = {}
) {
  if (!modelId) throw new Error('modelId is required');
  const model = (config.models ?? []).find((entry) => entry.id === modelId);
  if (!model) throw new Error(`model ${modelId} does not exist in config`);

  const backendId = model.backend ?? null;
  const runtimeId = model.runtime ?? null;
  const otherModels = (config.models ?? []).filter((entry) => entry.id !== modelId);
  const backendUsers = backendId
    ? otherModels.filter((entry) => entry.backend === backendId).map((entry) => entry.id)
    : [];
  const runtimeUsers = runtimeId
    ? otherModels.filter((entry) => entry.runtime === runtimeId).map((entry) => entry.id)
    : [];
  const removeBackend = Boolean(backendId && config.backends?.[backendId] && backendUsers.length === 0);
  const removeRuntime = Boolean(runtimeId && config.runtimes?.[runtimeId] && runtimeUsers.length === 0);
  const runtimeMembers = removableDistributedMembers(config, runtimeId, removeRuntime, otherModels);
  const status = runtimeId ? (runtimeStatus.runtimes?.[runtimeId] ?? runtimeStatus[runtimeId] ?? {}) : {};
  const activeRequests = Number(status.activeRequests ?? 0);
  const aliases = aliasesRemovedWithModel(config.aliases, modelId);
  const removedTargets = new Set([modelId, ...aliases]);
  const defaultKeys = Object.entries(config.defaults ?? {})
    .filter(([, value]) => removedTargets.has(value))
    .map(([key]) => key);

  const modelRoot = config.paths?.modelRoot ?? defaultUserModelRoot();
  const otherRuntimes = otherModels.map((entry) => config.runtimes?.[entry.runtime]).filter(Boolean);
  const { exclusive, shared } = runtimeId
    ? exclusiveModelPaths(config.runtimes[runtimeId], otherRuntimes, modelRoot)
    : { exclusive: [], shared: [] };
  const sharedOwners = shared.length
    ? otherModels
        .filter((entry) =>
          exclusiveModelPaths(config.runtimes?.[entry.runtime], otherRuntimes, modelRoot).shared.some((path) =>
            shared.includes(path)
          )
        )
        .map((entry) => entry.id)
    : [];
  const validationErrors = [];
  const warnings = [];
  if (removeRuntime && activeRequests > 0) {
    validationErrors.push(`runtime ${runtimeId} has ${activeRequests} active request(s); wait for them to finish`);
  }
  if (deleteFiles && !exclusive.length && !shared.length) {
    validationErrors.push('model files cannot be identified safely under the configured model root');
  }
  if (deleteFiles && shared.length) {
    warnings.push(`preserving model files shared by: ${sharedOwners.join(', ')}`);
  }
  if (backendUsers.length) warnings.push(`preserving shared backend ${backendId}; used by ${backendUsers.join(', ')}`);
  if (runtimeUsers.length) warnings.push(`preserving shared runtime ${runtimeId}; used by ${runtimeUsers.join(', ')}`);
  if (!deleteFiles && (exclusive.length || shared.length)) {
    warnings.push(`preserving model files at: ${[...exclusive, ...shared].join(', ')}`);
  }
  // A stale runtime record (not currently loaded) whose configured port is
  // held by a process this gateway does not own must not trigger port cleanup.
  // Surface the conflict so an operator is not surprised that the listener was
  // left running; the runtime-manager now only cleans up ports it owns.
  if (removeRuntime && !runtimeLoaded(status)) {
    const runtimePort = Number(config.runtimes?.[runtimeId]?.port);
    if (runtimePort && externalPortListeners.includes(runtimePort)) {
      warnings.push(
        `port ${runtimePort} is held by an external process; it will be left running (runtime ${runtimeId} is not loaded by this gateway)`
      );
    }
  }

  const nextConfig = clone(config.sourceTemplate ?? config);
  delete nextConfig.sourcePath;
  nextConfig.models = (nextConfig.models ?? []).filter((entry) => entry.id !== modelId);
  const removedRuntimes = removedRuntimeIds(runtimeId, removeRuntime, runtimeMembers);
  if (removeRuntime) delete nextConfig.runtimes?.[runtimeId];
  for (const memberRuntimeId of runtimeMembers) delete nextConfig.runtimes?.[memberRuntimeId];
  // Prune init bookkeeping for every runtime this removal deletes so the next
  // additive init cannot re-union stale IDs and no keep-warm pin survives on
  // a runtime that is gone. Shared runtimes preserved above are untouched.
  if (removedRuntimes.length) {
    if (nextConfig.init?.enabledRuntimes) {
      nextConfig.init.enabledRuntimes = nextConfig.init.enabledRuntimes.filter((id) => !removedRuntimes.includes(id));
    }
    if (removedRuntimes.includes(nextConfig.init?.keepWarmRuntime)) delete nextConfig.init.keepWarmRuntime;
  }
  if (removeBackend) delete nextConfig.backends?.[backendId];
  for (const aliasId of aliases) delete nextConfig.aliases?.[aliasId];
  if (nextConfig.clientCatalog?.modelOrder) {
    nextConfig.clientCatalog.modelOrder = nextConfig.clientCatalog.modelOrder.filter((id) => !removedTargets.has(id));
  }
  for (const key of defaultKeys) delete nextConfig.defaults?.[key];

  const plan = {
    dryRun: true,
    ok: validationErrors.length === 0,
    modelId,
    model,
    configPath,
    cleanup: {
      model: modelId,
      aliases,
      defaultKeys,
      clientCatalogEntries: [...removedTargets],
      backend: removeBackend ? backendId : null,
      runtime: removeRuntime ? runtimeId : null,
      runtimeMembers,
      stopRuntime: removeRuntime && runtimeLoaded(status),
      // Every exclusively owned payload this removal reclaims. A multi-component
      // model (diffusion plus encoder plus VAE) contributes several entries.
      modelFiles: deleteFiles ? exclusive : null,
      preservedModelFiles: shared
    },
    preserved: {
      backend: backendUsers.length ? { id: backendId, usedBy: backendUsers } : null,
      runtime: runtimeUsers.length ? { id: runtimeId, usedBy: runtimeUsers } : null,
      modelFiles: !deleteFiles && exclusive.length ? exclusive : null
    },
    warnings,
    validationErrors
  };
  Object.defineProperty(plan, 'config', {
    value: nextConfig,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return plan;
}

export async function applyModelRemoval(
  config,
  { dryRun = true, yes = false, configPath = config.sourcePath, stopRuntime, runtimeStatus, ...options } = {}
) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to remove a model without yes=true. Re-run with --apply --yes after reviewing the cleanup plan.'
    );
  }
  const plan = createModelRemovalPlan(config, { ...options, configPath, runtimeStatus });
  if (dryRun) return plan;
  if (plan.validationErrors.length) {
    throw new Error(`Model removal is unsafe:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`);
  }

  let runtimeStop = null;
  if (plan.cleanup.stopRuntime) {
    if (typeof stopRuntime !== 'function') throw new Error('Model removal requires a runtime stopper');
    runtimeStop = await stopRuntime(plan.cleanup.runtime);
    if (runtimeStop?.stopped !== true && runtimeStop?.reason !== 'already-stopped') {
      throw new Error(`Failed to stop runtime ${plan.cleanup.runtime}: ${runtimeStop?.reason ?? 'unknown error'}`);
    }
  }

  const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await fs.copyFile(configPath, backupPath);
  await fs.writeFile(temporaryPath, `${JSON.stringify(plan.config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, configPath);
  const deletedFiles = [];
  let reclaimedBytes = 0;
  for (const target of plan.cleanup.modelFiles ?? []) {
    const bytes = await reclaimModelFiles(target);
    deletedFiles.push(target);
    reclaimedBytes += bytes;
  }
  return {
    ...plan,
    dryRun: false,
    runtimeStop,
    written: { configPath, backupPath },
    deletedFiles,
    reclaimedBytes
  };
}
