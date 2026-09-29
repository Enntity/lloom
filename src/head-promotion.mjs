// Pure, reusable planner for promoting an already-prepared gateway (the
// destination "media" node) to fleet head.
//
// Inputs are trusted operator configs plus a small amount of already-resolved
// metadata (source node id, source gateway URL, and the raw inference key the
// source gateway accepts). The planner never talks to SSH, the network, the
// filesystem, or a live runtime: it returns a candidate destination config
// (`next`), a candidate profile map (`profiles`), and a secret-free `summary`.
//
// Scope of one plan:
//   * Federate the source owner's runtime-backed models through the source
//     gateway. Physical runtimes and raw runtime backends are never copied, and
//     the source runtime owner (e.g. TP2) is not relocated.
//   * Make the destination the fleet head and the cluster leader. The source
//     config is never modified, so its leader stays as-is.
//   * Remap source namespaced IDs (e.g. `media/Model`) onto destination local
//     bare IDs when those IDs exist, and keep stable prefixed compatibility
//     aliases so clients using the old names keep working.
//   * Import source aliases/defaults with full dependency validation.
//   * Snapshot pre-promotion destination semantics into a `standalone` profile
//     and preserve conflicting local aliases behind route profiles.
//   * Add the source inference key to `security.apiKeys` without removing any
//     destination key, and use distinct inference and admin proxy credentials.
//
// The parent workflow owns SSH transport, apply/service restart and relay
// cutover. Nothing here prints secrets or full model/profile bodies.

export const STANDALONE_PROFILE = 'standalone';
export const STANDALONE_PROFILE_KIND = 'lloom-head-promotion-standalone';
export const PROMOTED_ROUTE = 'fleet';
export const LOCAL_ROUTE = 'local';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function slug(value) {
  return (
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node'
  );
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

import { normalizeProfileDocument } from './config-profiles.mjs';

// Canonical JSON used only for change detection and idempotence checks.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'undefined' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// Normalize an alias (string or legacy object form) into the member-set shape
// the gateway validates after `normalizeLegacyAliases`.
function aliasObject(value) {
  if (typeof value === 'string') return { members: value ? [value] : [] };
  const obj = asObject(value);
  const members = Array.isArray(obj.members)
    ? [...obj.members]
    : [obj.target, ...asArray(obj.fallbacks)].filter(Boolean);
  let optionalMembers;
  if (obj.optionalMembers === undefined)
    optionalMembers = Array.isArray(obj.optionalFallbacks) ? [...obj.optionalFallbacks] : [];
  else if (Array.isArray(obj.optionalMembers)) optionalMembers = [...obj.optionalMembers];
  else throw new Error(`optionalMembers for ${obj.id ?? 'alias'} must be an array`);
  const out = { ...obj, members };
  delete out.optionalFallbacks;
  if (optionalMembers.length) out.optionalMembers = optionalMembers;
  else delete out.optionalMembers;
  return out;
}

function optionalMemberList(value) {
  return Array.isArray(value) ? [...value] : [];
}

function optionalMembersOutput(value) {
  if (typeof value === 'boolean') return value;
  return optionalMemberList(value).length ? [...value] : undefined;
}

// The model id of a model that is bound to a managed runtime on the source.
// Explicit runtime fields win; otherwise we match a source runtime's backend.
function sourceRuntimeId(model, source) {
  if (str(model?.runtime)) return str(model.runtime);
  for (const target of asArray(model?.targets)) {
    if (str(target?.runtime)) return str(target.runtime);
  }
  const backends = new Set(
    [model?.backend, ...asArray(model?.targets).map((target) => target?.backend)].filter(Boolean)
  );
  if (!backends.size) return null;
  for (const [runtimeId, runtime] of Object.entries(asObject(source.runtimes))) {
    const runtimeBackends = [runtime?.backend, runtime?.upstreamBackend, ...asArray(runtime?.backends)].filter(Boolean);
    if (runtimeBackends.some((backendId) => backends.has(backendId))) return runtimeId;
  }
  return null;
}

function hasDistributedRuntimes(config) {
  return Object.entries(asObject(config.runtimes)).filter(
    ([, runtime]) => asObject(runtime?.placement).mode === 'distributed'
  );
}

// Local residency that should survive inside the standalone snapshot. Foreign
// (source) residency is never copied anywhere.
function collectResidency(config) {
  const out = {};
  for (const [runtimeId, runtime] of Object.entries(asObject(config.runtimes))) {
    const entry = {};
    for (const key of ['keepWarm', 'preferredWarm', 'residency', 'keepWarmPolicy']) {
      if (runtime?.[key] !== undefined) entry[key] = clone(runtime[key]);
    }
    if (Object.keys(entry).length) out[runtimeId] = entry;
  }
  return out;
}

/**
 * Pure planner: promote `source`'s resources onto `destination` as a fleet
 * head. Returns `{ next, profiles, summary }`.
 *
 *  - `next`: candidate destination config (private; may contain keys).
 *  - `profiles`: candidate profile map (private; may contain keys).
 *  - `summary`: secret-free report safe to print or log.
 */
export function planHeadPromotion(destination, source, options = {}) {
  const dest = asObject(destination);
  const src = asObject(source);
  const sourceNode = str(options.sourceNode);
  const sourceUrl = str(options.sourceUrl);
  const sourceInferenceKey =
    typeof options.sourceInferenceKey === 'string' && options.sourceInferenceKey.length
      ? options.sourceInferenceKey
      : null;
  const sourceInferenceKeyResolved =
    typeof options.sourceInferenceKeyResolved === 'boolean'
      ? options.sourceInferenceKeyResolved
      : sourceInferenceKey !== null;
  const sourceAdminKey =
    typeof options.sourceAdminKey === 'string' && options.sourceAdminKey.length ? options.sourceAdminKey : null;
  const sourceAdminKeyResolved =
    typeof options.sourceAdminKeyResolved === 'boolean' ? options.sourceAdminKeyResolved : sourceAdminKey !== null;
  if (!sourceNode) throw new Error('planHeadPromotion requires a sourceNode');
  if (!sourceUrl) throw new Error('planHeadPromotion requires a sourceUrl');
  let sourceEndpointUrl;
  try {
    sourceEndpointUrl = new URL(sourceUrl);
  } catch {
    throw new Error('sourceUrl must be an absolute URL');
  }
  if (
    (sourceEndpointUrl.protocol !== 'http:' && sourceEndpointUrl.protocol !== 'https:') ||
    sourceEndpointUrl.username ||
    sourceEndpointUrl.password ||
    sourceEndpointUrl.search ||
    sourceEndpointUrl.hash
  ) {
    throw new Error('sourceUrl must be an HTTP(S) URL without credentials, query, or fragment');
  }

  // The transport supplies named profile documents read from profiles/*.json.
  // Embedded maps remain usable for synthetic pure-planner callers.
  const conflicts = [];
  const skipped = [];
  const pushConflict = (type, id, reason) => conflicts.push({ type, id, reason });
  const pushSkipped = (type, id, reason) => skipped.push({ type, id: id ?? null, reason });
  const rawDestProfiles = { ...clone(asObject(dest.profiles)), ...clone(asObject(options.destinationProfiles)) };
  const destProfiles = {};
  const destProfileErrors = [];
  for (const [name, profile] of Object.entries(rawDestProfiles)) {
    try {
      destProfiles[name] = normalizeProfileDocument(profile, name);
    } catch (error) {
      destProfileErrors.push({ type: 'profile', id: name, reason: error.message, severity: 'conflict' });
    }
  }
  const sourceProfiles = {};
  const rawSourceProfiles = {
    ...(asObject(src.profiles) ?? {}),
    ...(asObject(options.sourceProfiles) ?? {})
  };
  for (const [name, profile] of Object.entries(rawSourceProfiles)) {
    try {
      sourceProfiles[name] = normalizeProfileDocument(profile, name);
    } catch (error) {
      pushConflict('profile', name, error.message);
    }
  }
  destProfileErrors.forEach(pushConflict);

  const destCluster = asObject(dest.cluster);
  const srcCluster = asObject(src.cluster);
  const destinationNodeId = str(destCluster.nodeId) ?? str(destCluster.leaderNode);
  if (!destinationNodeId) {
    pushConflict('cluster', 'nodeId', 'destination cluster.nodeId is required to name the fleet head');
  }
  if (destinationNodeId && destinationNodeId === sourceNode) {
    pushConflict('cluster', 'sourceNode', 'sourceNode must differ from the destination cluster node id');
  }

  const distributed = hasDistributedRuntimes(dest);
  if (distributed.length) {
    pushConflict(
      'cluster',
      'distributed-runtimes',
      `destination declares distributed runtimes (${distributed.map(([id]) => id).join(', ')}); promote only a plain head`
    );
  }

  const destModels = asArray(dest.models);
  const destModelIds = new Set(destModels.map((model) => model?.id).filter(Boolean));
  const existingFederatedIds = new Set(
    Object.values(asObject(dest.cluster?.nodes)).flatMap((node) =>
      asArray(node?.proxy?.models).map((m) =>
        typeof m === 'string' ? `${node.proxy.namespace ?? ''}/${m}` : (m.as ?? `${node.proxy.namespace ?? ''}/${m.id}`)
      )
    )
  );
  const destBackends = asObject(dest.backends);
  const destAliases = asObject(dest.aliases);
  const destAliasIds = new Set(Object.keys(destAliases));
  // Only the destination and the known source owner may have their node-
  // prefixed references remapped to existing bare destination ids. Third-party
  // worker references stay unresolved and fail closed.
  const namespaces = new Set([destinationNodeId, sourceNode].filter(Boolean));

  // --- Federate source runtime-backed, non-federated models ---------------
  const federatedEntries = [];
  const federatedModelIds = [];
  for (const model of asArray(src.models)) {
    const id = str(model?.id);
    if (!id) continue;
    if (model.federated === true) {
      pushSkipped('model', id, 'already federated; not re-exported');
      continue;
    }
    const runtimeId = sourceRuntimeId(model, src);
    if (!runtimeId) continue;
    if (!Object.hasOwn(asObject(src.runtimes), runtimeId)) {
      pushConflict('runtime', runtimeId, 'source model references a missing runtime');
      continue;
    }
    if (destModelIds.has(id) || (destAliasIds.has(id) && !existingFederatedIds.has(id))) {
      pushSkipped('model', id, 'id already exists locally; local definition preserved');
      continue;
    }
    const entry = {
      id,
      as: id,
      kind: model.kind ?? 'chat',
      remoteRuntime: runtimeId,
      upstreamModel: id
    };
    if (model.name) entry.name = model.name;
    for (const field of ['capabilities', 'input', 'output', 'contextWindow', 'maxOutputTokens'])
      if (model[field] !== undefined) entry[field] = clone(model[field]);
    federatedEntries.push(entry);
    federatedModelIds.push(id);
  }

  const modelCatalog = new Set([...destModelIds, ...existingFederatedIds, ...federatedModelIds]);
  const aliasCatalog = new Set([...destAliasIds].filter((id) => !Object.hasOwn(asObject(src.aliases), id)));
  // Bare local ids reachable through a namespaced (`<node>/<bare>`) reference.
  // Seeding these lets aliases that only reference `media/Model` resolve down to
  // the destination's real local `Model` even on the first pass.
  for (const [prefix, local] of Object.entries(asObject(src.nodeModelIndex))) {
    for (const [bare, node] of Object.entries(asObject(local))) {
      if (typeof bare !== 'string' || !bare) continue;
      if (String(node) !== destinationNodeId && String(node) !== sourceNode) continue;
      if (destModelIds.has(bare)) modelCatalog.add(bare);
      else if (destAliasIds.has(bare)) aliasCatalog.add(bare);
    }
  }
  const compatibilityCandidates = new Map();
  const mappings = new Map();
  for (const model of asArray(src.models)) {
    const prefix = destinationNodeId + '/';
    if (!model.id?.startsWith(prefix)) continue;
    const bare = model.id.slice(prefix.length);
    const served = [
      ...new Set(
        asArray(model.targets)
          .filter((target) => target.node === destinationNodeId)
          .map((target) => target.servedModel ?? target.upstreamModel)
          .filter((id) => destModelIds.has(id))
      )
    ];
    const local = destModelIds.has(bare) ? bare : served.length === 1 ? served[0] : null;
    if (local) {
      mappings.set(model.id, local);
      compatibilityCandidates.set(model.id, local);
    }
  }

  // A source-local bare id whose exact bare id already exists on the
  // destination is local there too. Map its node-prefixed spelling to that
  // destination model before validating aliases/defaults.
  function resolveMember(id, ctx) {
    if (typeof id !== 'string' || !id.trim()) return { id, resolved: false };
    if (ctx.mappings.has(id)) {
      const mapped = ctx.mappings.get(id);
      return { id: mapped, resolved: true, mappedFrom: id };
    }
    const slash = id.indexOf('/');
    if (slash > 0) {
      const prefix = id.slice(0, slash);
      const bare = id.slice(slash + 1);
      if (bare && ctx.namespaces.has(prefix) && (ctx.modelIds.has(bare) || ctx.aliasIds.has(bare))) {
        ctx.mappings.set(id, bare);
        if (ctx.modelIds.has(bare)) ctx.compatibility.set(id, bare);
        return { id: bare, resolved: true, mappedFrom: id };
      }
    }
    if (ctx.modelIds.has(id) || ctx.aliasIds.has(id)) return { id, resolved: true };
    return { id, resolved: false };
  }

  function mapMembers(list, ctx) {
    const out = [];
    for (const member of asArray(list)) {
      const resolved = resolveMember(member, ctx);
      if (!resolved.resolved) ctx.unresolved.add(member);
      if (!out.includes(resolved.id)) out.push(resolved.id);
    }
    return out;
  }

  function mapAlias(value, ctx) {
    const obj = aliasObject(value);
    const mapped = { ...obj, members: mapMembers(obj.members, ctx) };
    if (obj.optionalMembers !== undefined) {
      const optionalMembers = mapMembers(obj.optionalMembers, ctx);
      if (optionalMembers.length) mapped.optionalMembers = optionalMembers;
      else delete mapped.optionalMembers;
    }
    if (Array.isArray(obj.suspendedMembers)) {
      const suspended = mapMembers(obj.suspendedMembers, ctx);
      if (suspended.length) mapped.suspendedMembers = suspended;
      else delete mapped.suspendedMembers;
    }
    if (obj.routeProfiles && typeof obj.routeProfiles === 'object' && !Array.isArray(obj.routeProfiles)) {
      const routeProfiles = {};
      for (const [name, profile] of Object.entries(obj.routeProfiles)) {
        const p = aliasObject(profile);
        const routeContext = { ...ctx, unresolved: new Set() };
        const routeProfile = { members: mapMembers(p.members, routeContext) };
        if (p.optionalMembers !== undefined) routeProfile.optionalMembers = mapMembers(p.optionalMembers, routeContext);
        // Historical alternate routes may refer to retired models. Retain the
        // current valid route and report unavailable alternates separately.
        if (routeContext.unresolved.size) {
          pushSkipped('route-profile', name, `unresolved alternate route: ${[...routeContext.unresolved].join(', ')}`);
          continue;
        }
        routeProfiles[name] = routeProfile;
      }
      mapped.routeProfiles = routeProfiles;
    }
    delete mapped.target;
    delete mapped.fallbacks;
    delete mapped.optionalFallbacks;
    return mapped;
  }

  function newMappingContext() {
    return {
      modelIds: modelCatalog,
      aliasIds: new Set(aliasCatalog),
      namespaces,
      unresolved: new Set(),
      mappings,
      compatibility: compatibilityCandidates
    };
  }

  // Resolve which source aliases are fully satisfiable. Source aliases may
  // reference each other, so iterate to a fixpoint before committing.
  const sourceAliasEntries = Object.entries(asObject(src.aliases));
  const mappedAliases = new Map();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [aliasId, alias] of sourceAliasEntries) {
      if (mappedAliases.has(aliasId)) continue;
      const ctx = newMappingContext();
      const value = mapAlias(alias, ctx);
      if (ctx.unresolved.size) continue;
      if (!asArray(value.members).length) continue;
      mappedAliases.set(aliasId, value);
      aliasCatalog.add(aliasId);
      progressed = true;
    }
  }

  const addedAliases = {};
  const importedAliases = [];
  const composedAliases = [];

  function localDefinition(existing) {
    const obj = aliasObject(existing);
    const savedLocal = asObject(asObject(obj.routeProfiles)[LOCAL_ROUTE]);
    if (asArray(savedLocal.members).length) {
      return {
        members: [...savedLocal.members],
        optionalMembers: optionalMemberList(savedLocal.optionalMembers)
      };
    }
    return { members: [...obj.members], optionalMembers: optionalMemberList(obj.optionalMembers) };
  }

  function composeAlias(existing, promoted) {
    const obj = aliasObject(existing);
    const local = localDefinition(existing);
    // Preserve source route profiles for later exact switches. Destination's
    // reserved local/promoted entries win if an id collision occurs.
    for (const name of [PROMOTED_ROUTE, LOCAL_ROUTE]) {
      if (Object.hasOwn(asObject(promoted.routeProfiles), name))
        pushConflict('alias', name, 'source route profile collides with reserved promotion route');
    }
    const routeProfiles = {
      ...asObject(obj.routeProfiles),
      ...asObject(promoted.routeProfiles)
    };
    routeProfiles[PROMOTED_ROUTE] = {
      members: [...promoted.members],
      ...(optionalMembersOutput(promoted.optionalMembers) === undefined
        ? {}
        : { optionalMembers: optionalMembersOutput(promoted.optionalMembers) })
    };
    routeProfiles[LOCAL_ROUTE] = {
      members: local.members,
      ...(optionalMembersOutput(local.optionalMembers) === undefined
        ? {}
        : { optionalMembers: optionalMembersOutput(local.optionalMembers) })
    };
    const out = {
      ...obj,
      members: [...promoted.members],
      activeRoute: PROMOTED_ROUTE,
      routeProfiles
    };
    const promotedOptional = optionalMembersOutput(promoted.optionalMembers);
    if (promotedOptional !== undefined) out.optionalMembers = promotedOptional;
    else delete out.optionalMembers;
    const suspended = asArray(obj.suspendedMembers).filter((member) => promoted.members.includes(member));
    if (suspended.length) out.suspendedMembers = suspended;
    else delete out.suspendedMembers;
    delete out.target;
    delete out.fallbacks;
    delete out.optionalFallbacks;
    return out;
  }

  for (const [aliasId, alias] of sourceAliasEntries) {
    const promoted = mappedAliases.get(aliasId);
    if (!promoted) {
      const ctx = newMappingContext();
      mapAlias(alias, ctx);
      const missing = [...ctx.unresolved];
      pushSkipped(
        'alias',
        aliasId,
        missing.length ? `unresolved alias dependency: ${missing.join(', ')}` : 'alias has no resolvable members'
      );
      continue;
    }
    const existing = destAliases[aliasId];
    if (existing === undefined) {
      if (deepEqual(asObject({}), asObject(promoted)) || !asArray(promoted.members).length) {
        pushSkipped('alias', aliasId, 'source alias has no members');
        continue;
      }
      const candidate = aliasObject(promoted);
      // Keep the source's own active route/profile naming when present.
      if (candidate.routeProfiles && Object.keys(candidate.routeProfiles).length) {
        const names = Object.keys(candidate.routeProfiles);
        const active =
          candidate.activeRoute && candidate.routeProfiles[candidate.activeRoute] ? candidate.activeRoute : names[0];
        candidate.activeRoute = active;
        candidate.members = [...candidate.routeProfiles[active].members];
        const optional = asArray(candidate.routeProfiles[active].optionalMembers);
        if (optional.length) candidate.optionalMembers = [...optional];
        else delete candidate.optionalMembers;
      }
      addedAliases[aliasId] = candidate;
      importedAliases.push(aliasId);
      continue;
    }
    if (deepEqual(aliasObject(existing), promoted)) continue; // already matched
    const candidate = composeAlias(existing, promoted);
    if (deepEqual(candidate, existing)) continue; // idempotent repeat
    addedAliases[aliasId] = candidate;
    composedAliases.push(aliasId);
  }

  // Stable prefixed compatibility aliases: keep the old namespaced client ids
  // resolving to the destination's local bare model.
  const compatibilityAliases = [];
  const finalAliasIds = new Set([...destAliasIds, ...Object.keys(addedAliases)]);
  for (const [prefixed, bare] of compatibilityCandidates) {
    if (finalAliasIds.has(prefixed) || destModelIds.has(prefixed)) continue;
    if (!modelCatalog.has(bare) || !destModelIds.has(bare)) continue;
    addedAliases[prefixed] = { members: [bare], advertise: true };
    finalAliasIds.add(prefixed);
    compatibilityAliases.push(prefixed);
  }

  // --- Defaults (mapped, dependency-checked) ------------------------------
  const nextDefaults = { ...clone(asObject(dest.defaults)) };
  const appliedDefaults = {};
  const skippedDefaults = [];
  for (const [kind, value] of Object.entries(asObject(src.defaults))) {
    if (typeof value !== 'string' || !value) continue;
    const ctx = newMappingContext();
    const resolved = resolveMember(value, ctx);
    if (!resolved.resolved) {
      skippedDefaults.push({ kind, id: value, reason: 'default does not resolve in the destination catalog' });
      continue;
    }
    if (nextDefaults[kind] !== resolved.id) appliedDefaults[kind] = resolved.id;
    nextDefaults[kind] = resolved.id;
  }

  // --- Security: add only the source inference key, never remove target keys.
  // The source admin credential is scoped to the cluster node and is never
  // granted to the destination's inference security.
  const nextSecurity = { ...clone(asObject(dest.security)) };
  const existingKeys = asArray(nextSecurity.apiKeys).filter((key) => typeof key === 'string');
  let apiKeysAdded = 0;
  if (sourceInferenceKey && !existingKeys.includes(sourceInferenceKey)) {
    nextSecurity.apiKeys = [...existingKeys, sourceInferenceKey];
    apiKeysAdded = 1;
  } else if (Array.isArray(nextSecurity.apiKeys)) {
    nextSecurity.apiKeys = [...nextSecurity.apiKeys];
  }

  // --- Cluster federation ------------------------------------------------
  const proxyBackendId = `lloom-node-${slug(sourceNode)}`;
  const proxyBaseUrl = `${trimSlash(sourceUrl)}/v1`;
  const proxyBackend = {
    type: 'openai',
    baseUrl: proxyBaseUrl,
    ...(sourceInferenceKey
      ? { apiKey: sourceInferenceKey }
      : destBackends[proxyBackendId]?.apiKey
        ? { apiKey: destBackends[proxyBackendId].apiKey }
        : {}),
    timeoutMs: 1800000
  };

  const nextCluster = { ...clone(destCluster) };
  nextCluster.nodes = { ...clone(asObject(destCluster.nodes)) };
  if (destinationNodeId) {
    nextCluster.nodeId = destCluster.nodeId ?? destinationNodeId;
    nextCluster.leaderNode = destinationNodeId;
    nextCluster.fleetHeadNode = destinationNodeId;
    nextCluster.nodes[destinationNodeId] = {
      ...asObject(nextCluster.nodes[destinationNodeId]),
      labels: { ...asObject(nextCluster.nodes[destinationNodeId]?.labels), role: 'leader' }
    };
  }

  const existingNode = asObject(asObject(destCluster.nodes)[sourceNode]);
  if (existingNode.endpoint && trimSlash(existingNode.endpoint) !== trimSlash(sourceUrl)) {
    pushConflict('cluster-node', sourceNode, 'existing node endpoint differs from the source URL');
  }
  const adminKeyMissing = !sourceAdminKey && !sourceAdminKeyResolved;
  if (existingNode.apiKey && sourceAdminKey && existingNode.apiKey !== sourceAdminKey) {
    const legacySourceInferenceCredential = existingNode.apiKey === sourceInferenceKey;
    if (!legacySourceInferenceCredential) {
      pushConflict('cluster-node', sourceNode, 'existing node credential differs from the source admin key');
    }
  }
  if (existingNode.proxy?.enabled === false) {
    pushConflict('cluster-node', sourceNode, 'existing node proxy is disabled');
  }

  const existingProxyModels = asArray(asObject(existingNode.proxy).models);
  const mergedProxyModels = [...existingProxyModels];
  let federatedAdded = 0;
  for (const entry of federatedEntries) {
    const match = existingProxyModels.find((candidate) => (candidate?.id ?? candidate) === entry.id);
    if (match) {
      if (deepEqual(match, entry)) continue; // already federated identically
      pushConflict('cluster-proxy-model', entry.id, 'existing proxy entry differs from the federated definition');
      continue;
    }
    mergedProxyModels.push(entry);
    federatedAdded += 1;
  }

  const existingBackend = destBackends[proxyBackendId];
  const backendIdentical = existingBackend !== undefined && deepEqual(existingBackend, proxyBackend);
  if (existingBackend !== undefined && !backendIdentical) {
    pushConflict('backend', proxyBackendId, 'existing backend id differs from the federated proxy backend');
  }

  const nextBackends = { ...clone(destBackends) };
  let backendAdded = 0;
  if (!backendIdentical && existingBackend === undefined && federatedEntries.length) {
    nextBackends[proxyBackendId] = proxyBackend;
    backendAdded = 1;
  }
  if (federatedEntries.length) {
    const node = { ...existingNode };
    node.endpoint = trimSlash(sourceUrl);
    if (sourceAdminKey) node.apiKey = sourceAdminKey;
    node.labels = { ...asObject(node.labels) };
    if (node.labels.role === undefined) node.labels.role = 'node';
    node.proxy = {
      ...asObject(node.proxy),
      enabled: true,
      backend: proxyBackendId,
      baseUrl: proxyBaseUrl,
      models: mergedProxyModels
    };
    nextCluster.nodes[sourceNode] = node;
  } else if (
    sourceAdminKey &&
    existingNode.proxy?.backend === proxyBackendId &&
    existingNode.proxy?.enabled !== false
  ) {
    // Guarded repair for a node promoted by an older build that used the
    // inference credential for node administration.
    const node = { ...existingNode };
    node.apiKey = sourceAdminKey;
    nextCluster.nodes[sourceNode] = node;
  }

  // --- Profiles ----------------------------------------------------------
  const nextProfiles = { ...clone(destProfiles) };
  const existingStandalone = destProfiles[STANDALONE_PROFILE];
  const promotionOrigin = { sourceNode, headNode: destinationNodeId ?? null, standaloneProfile: STANDALONE_PROFILE };
  let standaloneStatus;
  const hasPromotionOrigin =
    asObject(asObject(dest.fleet).headPromotion).standaloneProfile === STANDALONE_PROFILE &&
    deepEqual(asObject(asObject(dest.fleet).headPromotion).origin, promotionOrigin);
  if (existingStandalone !== undefined && !hasPromotionOrigin) {
    pushConflict(
      'profile',
      STANDALONE_PROFILE,
      'existing standalone profile is not a head-promotion snapshot; refusing to overwrite'
    );
    standaloneStatus = 'conflict';
  } else if (existingStandalone !== undefined) {
    standaloneStatus = 'retained';
  } else {
    const standaloneRoutes = {};
    for (const [aliasId, alias] of Object.entries(destAliases)) {
      const obj = aliasObject(alias);
      const routeProfiles = asObject(obj.routeProfiles);
      standaloneRoutes[aliasId] =
        Object.hasOwn(routeProfiles, LOCAL_ROUTE) || composedAliases.includes(aliasId)
          ? LOCAL_ROUTE
          : obj.activeRoute && routeProfiles[obj.activeRoute]
            ? obj.activeRoute
            : String(asArray(obj.members)[0] ?? '');
    }
    nextProfiles[STANDALONE_PROFILE] = normalizeProfileDocument(
      {
        name: STANDALONE_PROFILE,
        description: 'Pre-promotion destination fleet semantics',
        routes: standaloneRoutes,
        residency: Object.fromEntries(
          Object.entries(asObject(dest.runtimes)).map(([id, runtime]) => [
            id,
            runtime?.keepWarm === true ? 'always' : runtime?.preferredWarm === true ? 'preferred' : 'auto'
          ])
        ),
        defaults: clone(asObject(dest.defaults)),
        defaultsMode: 'replace'
      },
      STANDALONE_PROFILE
    );
    standaloneStatus = 'created';
  }

  const migratedProfiles = [];
  const preservedProfiles = [];
  const skippedProfiles = [];
  for (const name of Object.keys(destProfiles)) {
    if (name !== STANDALONE_PROFILE) preservedProfiles.push(name);
  }
  for (const [name, profile] of Object.entries(sourceProfiles)) {
    if (name === STANDALONE_PROFILE) continue;
    const mappedRoutes = {};
    const ctx = newMappingContext();
    for (const [aliasId, target] of Object.entries(profile.routes)) {
      const mergedAlias = Object.hasOwn(addedAliases, aliasId) ? addedAliases[aliasId] : destAliases[aliasId];
      const mergedRouteNames = new Set(Object.keys(asObject(asObject(mergedAlias).routeProfiles)));

      if (mergedRouteNames.has(target)) {
        mappedRoutes[aliasId] = target;
      } else {
        const resolved = resolveMember(target, ctx);
        if (!resolved.resolved) ctx.unresolved.add(target);
        else mappedRoutes[aliasId] = resolved.id;
      }
    }
    const mappedDefaults = {};
    for (const [kind, value] of Object.entries(profile.defaults ?? {})) {
      if (typeof value !== 'string' || !value) continue;
      const resolved = resolveMember(value, ctx);
      if (resolved.resolved) mappedDefaults[kind] = resolved.id;
      else ctx.unresolved.add(value);
    }
    if (ctx.unresolved.size) {
      skippedProfiles.push({ name, reason: `unresolved profile dependency: ${[...ctx.unresolved].join(', ')}` });
      continue;
    }
    const existing = asObject(destProfiles[name]);
    const migrated = {
      ...profile,
      routes: mappedRoutes,
      defaults: profile.defaults ? mappedDefaults : null
    };
    // Never copy foreign runtime residency. When the destination already has a
    // same-named profile, its local residency wins.
    delete migrated.residency;
    delete migrated.runtimePolicy;
    if (existing.residency !== undefined) migrated.residency = existing.residency;
    const merged = { ...existing, ...migrated };
    if (deepEqual(merged, destProfiles[name])) continue;
    nextProfiles[name] = merged;
    if (Object.hasOwn(destProfiles, name)) {
      if (!migratedProfiles.includes(name)) migratedProfiles.push(name);
    } else {
      migratedProfiles.push(name);
    }
  }

  // --- Assemble ----------------------------------------------------------
  const sourceFleet = asObject(src.fleet);
  const activeProfile = sourceFleet.activeProfile ?? null;
  const fleet = { ...clone(asObject(dest.fleet)) };
  if (activeProfile === STANDALONE_PROFILE)
    pushConflict('profile', activeProfile, 'source active profile uses the reserved standalone name');
  if (activeProfile != null) fleet.activeProfile = activeProfile;
  if (standaloneStatus === 'created') {
    fleet.headPromotion = { origin: promotionOrigin, standaloneProfile: STANDALONE_PROFILE };
  } else if (asObject(dest.fleet).headPromotion !== undefined) {
    fleet.headPromotion = clone(asObject(dest.fleet).headPromotion);
  }
  if (activeProfile != null && !Object.hasOwn(nextProfiles, activeProfile)) {
    pushConflict(
      'profile',
      'activeProfile',
      `active profile ${activeProfile} is not a valid migrated or preserved profile`
    );
  }

  // Source/final alias cycles. This intentionally catches a source dependency
  // that appears resolved only because a destination alias masks it.
  function detectAliasCycles(aliases, models = modelCatalog) {
    const state = new Map();
    let found = null;
    const visit = (id, stack) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'active') {
        const cycle = stack.slice(stack.indexOf(id)).concat(id);
        found ??= cycle;
        return;
      }
      const obj = aliasObject(aliases[id]);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      state.set(id, 'active');
      const nextStack = [...stack, id];
      for (const member of [...asArray(obj.members), ...asArray(obj.optionalMembers)]) {
        if (Object.hasOwn(aliases, member) && !(member === id && models.has(member))) visit(member, nextStack);
      }
      for (const profile of Object.values(asObject(obj.routeProfiles))) {
        for (const member of asArray(profile?.members)) {
          if (Object.hasOwn(aliases, member) && !(member === id && models.has(member))) visit(member, nextStack);
        }
      }
      state.set(id, 'done');
    };
    for (const id of Object.keys(aliases)) visit(id, []);
    return found;
  }

  const candidateAliases = { ...clone(destAliases), ...clone(addedAliases) };
  const cycle =
    detectAliasCycles(asObject(src.aliases), new Set(asArray(src.models).map((m) => m.id))) ??
    detectAliasCycles(candidateAliases);
  if (cycle) {
    pushConflict('alias', cycle[0], `source/final alias cycle: ${cycle.join(' -> ')}`);
  }

  const ok = conflicts.length === 0;
  const next = clone(dest);
  delete next.profiles;
  next.models = clone(destModels);
  next.backends = nextBackends;
  if (Object.keys(destAliases).length || Object.keys(addedAliases).length) {
    next.aliases = { ...clone(destAliases), ...addedAliases };
  }
  next.defaults = nextDefaults;
  if (dest.security !== undefined || apiKeysAdded) next.security = nextSecurity;
  next.cluster = nextCluster;
  if (Object.keys(fleet).length) next.fleet = fleet;

  const baseline = clone(dest);
  delete baseline.profiles;
  const changed =
    ok &&
    (stableStringify(next) !== stableStringify(baseline) ||
      stableStringify(nextProfiles) !== stableStringify(destProfiles));

  const retainedRuntimeIds = [
    ...new Set([
      ...Object.keys(asObject(src.runtimes)),
      ...Object.values(sourceProfiles).flatMap((profile) => Object.keys(asObject(asObject(profile).residency)))
    ])
  ].sort();

  const summary = {
    ok,
    changed,
    fleet: {
      headNode: destinationNodeId ?? null,
      leaderNode: destinationNodeId ?? null,
      sourceNode,
      sourceLeaderNode: str(srcCluster.leaderNode)
    },
    warnings: [
      ...(adminKeyMissing
        ? ['Source admin credential is missing; preview only. Apply requires a resolved credential.']
        : []),
      ...(!sourceInferenceKey && !sourceInferenceKeyResolved
        ? ['Source inference credential is missing; preview only. Apply requires a resolved credential.']
        : [])
    ],
    sourceCredentials: {
      inferenceKey: sourceInferenceKey ? 'resolved' : sourceInferenceKeyResolved ? 'redacted' : 'missing',
      adminKey: sourceAdminKey ? 'resolved' : sourceAdminKeyResolved ? 'redacted' : 'missing'
    },
    federated: { node: sourceNode, modelIds: [...federatedModelIds] },
    aliases: {
      imported: [...importedAliases].sort(),
      composed: [...composedAliases].sort(),
      compatibility: [...compatibilityAliases].sort(),
      skipped: skipped.filter((entry) => entry.type === 'alias')
    },
    defaults: { applied: appliedDefaults, skipped: skippedDefaults },
    security: { apiKeysAdded },
    profiles: {
      standalone: standaloneStatus ?? null,
      migrated: [...migratedProfiles].sort(),
      preserved: [...preservedProfiles].sort(),
      skipped: skippedProfiles,
      activeProfile
    },
    runtimePolicyRetainedOnSource: retainedRuntimeIds,
    federation: { modelsAdded: federatedAdded, backendAdded },
    skipped: skipped.filter((entry) => entry.type !== 'alias'),
    conflicts,
    sourceUnchanged: true
  };

  if (!ok) {
    return { next: clone(dest), profiles: clone(destProfiles), summary };
  }
  return { next, profiles: nextProfiles, summary };
}
