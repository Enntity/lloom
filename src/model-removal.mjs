import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultUserModelRoot } from './config.mjs';

function clone(value) {
  return structuredClone(value);
}

function aliasTarget(alias) {
  return typeof alias === 'string' ? alias : alias?.target;
}

function runtimeLoaded(status) {
  return status?.healthy === true || ['running', 'external', 'starting'].includes(status?.status);
}

function safeModelPath(runtime, modelRoot) {
  if (!runtime || !modelRoot) return null;
  const root = path.resolve(modelRoot);
  const candidates = (runtime.args ?? []).filter((value) => typeof value === 'string' && path.isAbsolute(value));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return resolved;
  }
  return null;
}

function aliasesRemovedWithModel(aliases, modelId) {
  const removed = new Set([modelId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [aliasId, alias] of Object.entries(aliases ?? {})) {
      if (!removed.has(aliasId) && removed.has(aliasTarget(alias))) {
        removed.add(aliasId);
        changed = true;
      }
    }
  }
  removed.delete(modelId);
  return [...removed];
}

export function createModelRemovalPlan(
  config,
  { modelId, configPath = config.sourcePath, deleteFiles = false, runtimeStatus = {} } = {}
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
  const status = runtimeId ? (runtimeStatus.runtimes?.[runtimeId] ?? runtimeStatus[runtimeId] ?? {}) : {};
  const activeRequests = Number(status.activeRequests ?? 0);
  const aliases = aliasesRemovedWithModel(config.aliases, modelId);
  const removedTargets = new Set([modelId, ...aliases]);
  const defaultKeys = Object.entries(config.defaults ?? {})
    .filter(([, value]) => removedTargets.has(value))
    .map(([key]) => key);

  const modelRoot = config.paths?.modelRoot ?? defaultUserModelRoot();
  const modelPath = runtimeId ? safeModelPath(config.runtimes?.[runtimeId], modelRoot) : null;
  const sharedPathUsers = modelPath
    ? otherModels
        .filter((entry) => safeModelPath(config.runtimes?.[entry.runtime], modelRoot) === modelPath)
        .map((entry) => entry.id)
    : [];
  const validationErrors = [];
  const warnings = [];
  if (removeRuntime && activeRequests > 0) {
    validationErrors.push(`runtime ${runtimeId} has ${activeRequests} active request(s); wait for them to finish`);
  }
  if (deleteFiles && !modelPath) {
    validationErrors.push('model files cannot be identified safely under the configured model root');
  }
  if (deleteFiles && sharedPathUsers.length) {
    validationErrors.push(`model files are shared by: ${sharedPathUsers.join(', ')}`);
  }
  if (backendUsers.length) warnings.push(`preserving shared backend ${backendId}; used by ${backendUsers.join(', ')}`);
  if (runtimeUsers.length) warnings.push(`preserving shared runtime ${runtimeId}; used by ${runtimeUsers.join(', ')}`);
  if (!deleteFiles && modelPath) warnings.push(`preserving model files at ${modelPath}`);

  const nextConfig = clone(config.sourceTemplate ?? config);
  delete nextConfig.sourcePath;
  nextConfig.models = (nextConfig.models ?? []).filter((entry) => entry.id !== modelId);
  if (removeRuntime) delete nextConfig.runtimes?.[runtimeId];
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
      stopRuntime: removeRuntime && runtimeLoaded(status),
      modelFiles: deleteFiles ? modelPath : null
    },
    preserved: {
      backend: backendUsers.length ? { id: backendId, usedBy: backendUsers } : null,
      runtime: runtimeUsers.length ? { id: runtimeId, usedBy: runtimeUsers } : null,
      modelFiles: !deleteFiles && modelPath ? modelPath : null
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
  if (plan.cleanup.modelFiles) await fs.rm(plan.cleanup.modelFiles, { recursive: true, force: true });

  return {
    ...plan,
    dryRun: false,
    runtimeStop,
    written: { configPath, backupPath },
    deletedFiles: plan.cleanup.modelFiles
  };
}
