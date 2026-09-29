// External-model transfer groundwork for preparing an existing standalone
// gateway as a future fleet head.
//
// This module moves only *external cloud* model definitions (OpenAI-compatible
// backends reachable over a public HTTPS hostname) from a local source config
// into a destination config. It never touches SSH, deployment, live runtimes,
// managed backends, or credentials beyond redacted names. The planner
// (`mergeExternalModels`) is pure so the future fleet-head UX can reuse it.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mutateConfigSource } from './config-mutation.mjs';
import { loadConfig } from './config.mjs';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'undefined' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// A public HTTPS endpoint excludes loopback, private IP literals, and
// single-label (internal) hostnames. It says nothing about reachability.
export function isEligibleExternalBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (['.local', '.internal', '.lan', '.home', '.home.arpa'].some((suffix) => host.endsWith(suffix))) return false;
  if (host.includes(':')) return false; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (/^\d+$/.test(host)) return false;
  if (!host.includes('.')) return false; // single-label hostname
  if (!/\.[a-z]{2,}$/.test(host)) return false;
  return true;
}

// Backends that exist only to serve a managed runtime are never eligible.
function managedRuntimeBackendIds(source) {
  const ids = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) ids.add(value);
  };
  for (const runtime of Object.values(asObject(source.runtimes))) {
    if (!runtime || typeof runtime !== 'object') continue;
    add(runtime.backend);
    add(runtime.upstreamBackend);
    if (Array.isArray(runtime.backends)) runtime.backends.forEach(add);
  }
  for (const model of Array.isArray(source.models) ? source.models : []) {
    const targets = Array.isArray(model?.targets) ? model.targets : [];
    const runtimeBound = Boolean(model?.runtime) || targets.some((t) => t?.runtime || t?.remoteRuntime);
    if (!runtimeBound) continue;
    add(model?.backend);
    targets.forEach((target) => add(target?.backend));
  }
  return ids;
}

function classifyModel(model, managedBackends) {
  if (!model || typeof model !== 'object' || !model.id) {
    return { eligible: false, reason: 'model is missing an id' };
  }
  if (model.federated === true || model.node || model.proxyId) {
    return { eligible: false, reason: 'federated or node-owned model' };
  }
  if (model.runtime) return { eligible: false, reason: 'model is bound to a managed runtime' };
  const targets = Array.isArray(model.targets) ? model.targets : [];
  let backendIds;
  if (targets.length) {
    if (targets.some((target) => target?.node)) return { eligible: false, reason: 'target is bound to a cluster node' };
    if (targets.some((target) => target?.runtime || target?.remoteRuntime)) {
      return { eligible: false, reason: 'target is bound to a runtime' };
    }
    backendIds = targets.map((target) => target?.backend).filter(Boolean);
    if (backendIds.length !== targets.length) return { eligible: false, reason: 'target is missing a backend' };
  } else if (model.backend) {
    backendIds = [model.backend];
  } else {
    return { eligible: false, reason: 'model has no backend or targets' };
  }
  for (const backendId of backendIds) {
    if (managedBackends.has(backendId)) {
      return { eligible: false, reason: `backend ${backendId} belongs to a managed runtime` };
    }
  }
  return { eligible: true, backendIds: [...new Set(backendIds)] };
}

function planBackendCredential(backendId, backend, includeSecrets, env) {
  const result = { required: null, unresolved: null, stripLiteralKey: false };
  const envName = typeof backend.apiKeyEnv === 'string' && backend.apiKeyEnv.trim() ? backend.apiKeyEnv.trim() : null;
  const hasLiteralKey = typeof backend.apiKey === 'string' && backend.apiKey.length > 0;
  if (
    backend.apiKeyEnv != null &&
    (typeof backend.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(backend.apiKeyEnv))
  ) {
    result.unresolved = { backend: backendId, reason: 'invalid credential environment name' };
    return result;
  }
  if (Object.hasOwn(backend, 'apiKey') && (!hasLiteralKey || backend.apiKey.includes('${'))) {
    result.unresolved = { backend: backendId, reason: 'empty or unresolved literal credential' };
    return result;
  }
  if (envName) {
    result.required = { backend: backendId, envName };
    result.stripLiteralKey = hasLiteralKey;
    const value = Object.hasOwn(env, envName) ? env[envName] : undefined;
    if (typeof value !== 'string' || value === '') {
      result.unresolved = { backend: backendId, envName, reason: 'environment credential is not set' };
    }
  } else if (hasLiteralKey && !includeSecrets) {
    result.unresolved = { backend: backendId, reason: 'literal apiKey requires --include-secrets' };
  }
  return result;
}

function aliasMembers(alias) {
  if (typeof alias === 'string') return alias ? [alias] : [];
  const value = asObject(alias);
  return [
    ...(Array.isArray(value.members) ? value.members : [value.target, ...(value.fallbacks ?? [])]),
    ...(value.optionalMembers ?? value.optionalFallbacks ?? []),
    ...Object.values(value.routeProfiles ?? {}).flatMap(aliasMembers)
  ].filter(Boolean);
}

/**
 * Pure planner: merge eligible external models/backends/aliases from `source`
 * into `destination`. Returns a plan with a full candidate config (`next`) plus
 * secret-free summaries. Never mutates its inputs.
 */
export function mergeExternalModels(destination, source, { includeSecrets = false, env = {} } = {}) {
  const dest = asObject(destination);
  const src = asObject(source);
  const destModels = Array.isArray(dest.models) ? dest.models : [];
  const srcModels = Array.isArray(src.models) ? src.models : [];
  const destBackends = asObject(dest.backends);
  const srcBackends = asObject(src.backends);
  const destAliases = asObject(dest.aliases);
  const srcAliases = asObject(src.aliases);

  const managedBackends = managedRuntimeBackendIds(src);
  const destModelIds = new Set(destModels.map((model) => model.id));
  const resolvableModelIds = new Set(destModelIds);
  const destBackendIds = new Set(Object.keys(destBackends));
  const destAliasIds = new Set(Object.keys(destAliases));

  const addedModels = [];
  const addedBackends = {};
  const addedAliases = {};
  const skipped = [];
  const conflicts = [];
  const requiredCredentials = [];
  const unresolvedCredentials = [];
  const conflictKeys = new Set();
  const pushConflict = (type, id, reason) => {
    const key = `${type}:${id}`;
    if (conflictKeys.has(key)) return;
    conflictKeys.add(key);
    conflicts.push({ type, id, reason });
  };

  for (const model of srcModels) {
    const id = model?.id;
    const classification = classifyModel(model, managedBackends);
    if (!classification.eligible) {
      skipped.push({ type: 'model', id: id ?? null, reason: classification.reason });
      continue;
    }
    let backendProblem = null;
    for (const backendId of classification.backendIds) {
      const backend = srcBackends[backendId];
      if (!backend || typeof backend !== 'object') {
        backendProblem = `backend ${backendId} is not defined in the source config`;
        break;
      }
      if (managedBackends.has(backendId)) {
        backendProblem = `backend ${backendId} belongs to a managed runtime`;
        break;
      }
      if (!isEligibleExternalBaseUrl(backend.baseUrl)) {
        backendProblem = `backend ${backendId} is not a public HTTPS endpoint`;
        break;
      }
    }
    if (backendProblem) {
      skipped.push({ type: 'model', id, reason: backendProblem });
      continue;
    }
    if (destModelIds.has(id)) {
      const existing = destModels.find((candidate) => candidate.id === id);
      if (deepEqual(existing, model))
        skipped.push({ type: 'model', id, reason: 'identical definition already present' });
      else pushConflict('model', id, 'model id already exists with a different definition');
    }
    for (const backendId of classification.backendIds) {
      if (destBackendIds.has(backendId)) {
        if (!deepEqual(destBackends[backendId], srcBackends[backendId])) {
          pushConflict('backend', backendId, 'backend id already exists with a different definition');
        }
      }
      if (addedBackends[backendId]) continue;
      const credential = planBackendCredential(backendId, srcBackends[backendId], includeSecrets, env);
      if (credential.required) requiredCredentials.push(credential.required);
      if (credential.unresolved) unresolvedCredentials.push(credential.unresolved);
      if (destBackendIds.has(backendId)) continue;
      const entry = clone(srcBackends[backendId]);
      if (credential.stripLiteralKey) delete entry.apiKey;
      addedBackends[backendId] = entry;
    }
    if (!destModelIds.has(id)) addedModels.push(clone(model));
    destModelIds.add(id);
    resolvableModelIds.add(id);
  }

  // Aliases import only when their transitive member graph resolves against
  // destination + imported models/aliases. Conflicting existing aliases are
  // skipped so the destination definition is preserved.
  const candidateAliases = new Map();
  for (const [aliasId, alias] of Object.entries(srcAliases)) {
    if (destAliasIds.has(aliasId)) {
      const reason = deepEqual(destAliases[aliasId], alias)
        ? 'identical alias already present'
        : 'alias id already exists; destination definition preserved';
      skipped.push({ type: 'alias', id: aliasId, reason });
      continue;
    }
    if (resolvableModelIds.has(aliasId)) {
      skipped.push({ type: 'alias', id: aliasId, reason: 'model id already exists; destination model preserved' });
      continue;
    }
    candidateAliases.set(aliasId, alias);
  }
  const acceptedAliases = new Set();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [aliasId, alias] of candidateAliases) {
      if (acceptedAliases.has(aliasId)) continue;
      const members = aliasMembers(alias);
      if (!members.length) continue;
      const resolves = members.every(
        (member) => resolvableModelIds.has(member) || destAliasIds.has(member) || acceptedAliases.has(member)
      );
      if (resolves) {
        acceptedAliases.add(aliasId);
        progressed = true;
      }
    }
  }
  for (const [aliasId, alias] of candidateAliases) {
    if (acceptedAliases.has(aliasId)) {
      addedAliases[aliasId] = clone(alias);
      continue;
    }
    const missing = aliasMembers(alias).filter(
      (member) => !resolvableModelIds.has(member) && !destAliasIds.has(member) && !acceptedAliases.has(member)
    );
    const reason = aliasMembers(alias).length
      ? `unresolved alias dependency: ${missing.join(', ') || 'cycle'}`
      : 'alias has no members';
    skipped.push({ type: 'alias', id: aliasId, reason });
  }

  const next = clone(dest);
  next.models = [...destModels, ...addedModels];
  next.backends = { ...destBackends, ...addedBackends };
  if (Object.keys(addedAliases).length || Object.hasOwn(dest, 'aliases')) {
    next.aliases = { ...destAliases, ...addedAliases };
  }

  return {
    ok: conflicts.length === 0 && unresolvedCredentials.length === 0,
    changed: addedModels.length > 0 || Object.keys(addedBackends).length > 0 || Object.keys(addedAliases).length > 0,
    next,
    added: {
      models: addedModels.map((model) => model.id),
      backends: Object.keys(addedBackends),
      aliases: Object.keys(addedAliases)
    },
    skipped,
    conflicts,
    requiredCredentials,
    unresolvedCredentials
  };
}

/** Redacted, print-safe summary of a plan. Never contains secrets or values. */
export function summarizeHeadPreparationPlan(plan) {
  return {
    ok: plan.ok,
    changed: plan.changed,
    added: plan.added,
    skipped: plan.skipped,
    conflicts: plan.conflicts,
    requiredCredentials: plan.requiredCredentials,
    unresolvedCredentials: plan.unresolvedCredentials
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createPrivateBackup(destinationPath, raw) {
  const dir = path.dirname(destinationPath);
  const base = path.basename(destinationPath);
  const backupPath = path.join(dir, `.${base}.head-prep-${Date.now()}-${process.pid}.bak`);
  await fs.writeFile(backupPath, raw, { mode: 0o600 });
  await fs.chmod(backupPath, 0o600);
  return backupPath;
}

/**
 * Plan (dry-run) or apply an external-model import from a local source config
 * into an explicit destination config. Apply is fail-closed, atomic, and
 * gated on --apply --yes. No runtime or service operations are performed.
 */
export async function applyHeadPreparation({
  configPath,
  sourcePath,
  sourceData,
  expectedDestinationHash,
  includeSecrets = false,
  apply = false,
  yes = false,
  env = process.env
} = {}) {
  if (!configPath) throw new Error('a destination config is required (--config <path>)');
  if (!sourcePath && sourceData == null) throw new Error('a source config is required (--from <path>)');
  const resolvedDestination = path.resolve(String(configPath));
  const resolvedSource = sourcePath ? path.resolve(String(sourcePath)) : null;
  if (resolvedDestination === resolvedSource) throw new Error('source and destination config must differ');

  const sourceBytes = sourceData == null ? await fs.readFile(resolvedSource) : Buffer.from(sourceData);
  if (sourceBytes.length > 16 * 1024 * 1024) throw new Error('source config exceeds 16 MiB');
  let source;
  try {
    source = JSON.parse(sourceBytes.toString('utf8'));
  } catch {
    throw new Error('source config is not valid JSON');
  }
  const destinationRaw = await fs.readFile(resolvedDestination, 'utf8');
  const destination = JSON.parse(destinationRaw);
  const destinationHash = sha256(destinationRaw);
  const expectedDestination = stableStringify(destination);
  if (expectedDestinationHash && expectedDestinationHash !== destinationHash)
    throw new Error('destination config changed since reviewed plan');

  const plan = mergeExternalModels(destination, source, { includeSecrets, env });
  const summary = summarizeHeadPreparationPlan(plan);
  const base = { ...summary, sourceHash: sha256(sourceBytes), destinationHash };

  if (!apply) return { ...base, applied: false, dryRun: true };
  if (!yes) throw new Error('refusing to apply without --yes');
  if (plan.conflicts.length) throw new Error(`refusing to apply: ${plan.conflicts.length} conflicting id(s)`);
  if (plan.unresolvedCredentials.length) {
    const names = plan.unresolvedCredentials.map((item) => item.envName ?? item.backend).join(', ');
    throw new Error(`refusing to apply: unresolved credentials (${names})`);
  }
  if (!plan.changed) return { ...base, applied: false, dryRun: false };

  const mode = (await fs.stat(resolvedDestination)).mode & 0o777;
  if (mode & 0o077) throw new Error('destination config must be private (0600) before import');
  const backupPath = await createPrivateBackup(resolvedDestination, destinationRaw);
  await mutateConfigSource(
    { sourcePath: resolvedDestination },
    (parsed) => {
      if (stableStringify(parsed) !== expectedDestination) {
        throw new Error('destination config changed after planning; re-run to replan');
      }
      const fresh = mergeExternalModels(parsed, source, { includeSecrets, env });
      if (fresh.conflicts.length) throw new Error('destination changed after planning: conflicting ids now present');
      if (fresh.unresolvedCredentials.length)
        throw new Error('destination changed after planning: unresolved credentials');
      parsed.models = fresh.next.models;
      parsed.backends = fresh.next.backends;
      if (fresh.next.aliases !== undefined) parsed.aliases = fresh.next.aliases;
    },
    {
      validate: async (stagedPath) => {
        try {
          await loadConfig(stagedPath, { env });
        } catch {
          throw new Error('prepared configuration failed validation; destination was not changed');
        }
      }
    }
  );

  return { ...base, applied: true, dryRun: false, backupPath };
}
