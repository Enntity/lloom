// Pool catalog and planner inputs. Turns recipes, the installed config, node
// status and gateway metrics into the plain data pool-planner.mjs consumes:
// a model-centric variant catalog, node inventories, workloads, pins and the
// current state. Read-only: nothing here contacts nodes or changes config.
import { aliasRoutableMemberIds, expandedAliasMemberIds } from './alias-resolution.mjs';
import { benchmarkRankingEligible, benchmarkScore } from './benchmarks.mjs';
import { clusterNodes, modelTargets, runtimeResourcesByNode } from './cluster.mjs';
import { resolveRouteTarget } from './config-profiles.mjs';
import { inventoryFromProfile } from './pool-inventory.mjs';
import { memberPlannerNode } from './pool-membership.mjs';
import { residencyPolicy } from './runtime-preferences.mjs';

export const POOL_CATALOG_VERSION = 1;
const LIVE_METRIC_MIN_REQUESTS = 5;
const PERIOD_HOURS = { today: 24, '7d': 168, '30d': 720 };
const RESIDENCY_RANK = { auto: 0, preferred: 1, always: 2 };
const ARCH_BY_ACCELERATOR = { gb10: 'sm_121', 'dgx-spark': 'sm_121' };
const INVENTORY_RANK = { none: 0, config: 0, profile: 1, reported: 2 };

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function num(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && value !== ''))];
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}

function archFromCapability(value) {
  const match = String(value).match(/(\d+)\.(\d+)/);
  return match ? `sm_${match[1]}${match[2]}` : null;
}

function normalizeArch(value) {
  return String(value)
    .toLowerCase()
    .replace(/^(sm_\d+)[af]$/, '$1');
}

// Launch settings carry facts the recipe does not yet state structurally:
// container images, tensor-parallel size, scheduler sequences and target arch.
function launchSignals(settings) {
  const signals = { images: [], env: {}, flags: {} };
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if (key === 'image') signals.images.push(value);
      const env = value.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (env) signals.env[env[1]] ??= env[2];
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'string' && item.startsWith('--') && typeof value[index + 1] === 'string') {
          signals.flags[item] ??= value[index + 1];
        }
        visit(item);
      });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(settings);
  return signals;
}

export function recipeServingRequirements(recipe, model = {}) {
  const requirements = object(recipe?.requirements);
  const settings = object(model.settings);
  const signals = launchSignals(settings);
  const inferred = [];
  const infer = (field, value) => {
    if (value != null && !(Array.isArray(value) && !value.length)) inferred.push(field);
    return value;
  };
  const nodeCount = Math.max(1, Math.floor(num(requirements.cluster?.nodes ?? requirements.cluster?.minNodes) ?? 1));
  const explicitArchs = Array.isArray(requirements.computeArchs) ? requirements.computeArchs : null;
  const signalArchs = unique([
    signals.env.CUTE_DSL_ARCH ? normalizeArch(signals.env.CUTE_DSL_ARCH) : null,
    ...String(signals.env.TORCH_CUDA_ARCH_LIST ?? '')
      .split(/[;,\s]+/)
      .map(archFromCapability)
  ]);
  const acceleratorArchs = unique((requirements.accelerators ?? []).map((name) => ARCH_BY_ACCELERATOR[name]));
  const explicitTp = num(requirements.tensorParallel ?? settings.tensorParallel);
  const signalTp = num(
    signals.flags['--tensor-parallel-size'] ?? signals.env.TENSOR_PARALLEL_SIZE ?? signals.env.TP_SIZE
  );
  const explicitSequences = num(settings.maxSequences);
  const signalSequences = num(signals.flags['--max-num-seqs'] ?? signals.env.MAX_NUM_SEQS);
  const placementMemory = Math.max(
    0,
    ...(settings.placement?.members ?? []).map((member) => num(member?.resources?.memoryGb) ?? 0)
  );
  return {
    recipeId: recipe?.id ?? null,
    nodeCount,
    tensorParallel: explicitTp ?? infer('tensorParallel', signalTp ?? nodeCount),
    computeArchs: explicitArchs
      ? explicitArchs.map(normalizeArch)
      : (infer('computeArchs', signalArchs.length ? signalArchs : acceleratorArchs) ?? []),
    platforms: requirements.platforms ?? [],
    accelerators: requirements.accelerators ?? [],
    backend: recipe?.backend?.id ?? null,
    contextWindow: num(settings.contextWindow ?? model.contextWindow),
    maxSequences: explicitSequences ?? infer('maxSequences', signalSequences ?? num(settings.maxActiveRequests)),
    memoryGbPerNode: num(settings.memoryGb) ?? (placementMemory || num(requirements.memoryGb)),
    diskGb: num(requirements.diskGb),
    images: unique(signals.images).sort(),
    inferred
  };
}

// /gateway/metrics returns id-keyed bucket arrays; accept a plain map too.
function metricBucket(buckets, id) {
  if (Array.isArray(buckets)) return buckets.find((bucket) => bucket?.id === id) ?? null;
  return object(buckets)[id] ?? null;
}

function livePerformance(metrics, gatewayModel) {
  const bucket = metricBucket(metrics?.models, gatewayModel);
  if (!bucket || (num(bucket.requests) ?? 0) < LIVE_METRIC_MIN_REQUESTS) return null;
  return compact({
    ttftMs: num(bucket.avgFirstContentMs),
    decodeTps: num(bucket.decodeTokensPerSecond) ?? num(bucket.activeDecodeTokensPerSecond),
    durationMs: num(bucket.avgDurationMs) || null,
    source: 'live-metrics'
  });
}

function benchmarkPerformance(benchmarks, { gatewayModel, recipeId, model }) {
  const best = benchmarks
    .filter((result) => benchmarkRankingEligible(result))
    .filter(
      (result) =>
        (result.gatewayModel && result.gatewayModel === gatewayModel) ||
        (recipeId && result.recipeId === recipeId && (!model || result.model === model))
    )
    .sort((left, right) => benchmarkScore(right) - benchmarkScore(left))[0];
  if (!best) return null;
  const metrics = object(best.metrics);
  return compact({
    ttftMs: num(metrics.timeToFirstTokenMs),
    decodeTps: num(metrics.generationTokPerSec),
    durationMs: num(metrics.generationSeconds) != null ? num(metrics.generationSeconds) * 1000 : null,
    source: `benchmark:${best.id}`
  });
}

function measuredMemoryGb(nodeStatuses, nodes, runtimeIds) {
  let largest = 0;
  for (const nodeId of nodes) {
    const runtimes = object(nodeStatuses?.[nodeId]?.runtimeManager?.runtimes);
    for (const runtimeId of runtimeIds) {
      const bytes = num(runtimes[runtimeId]?.memoryUsage?.residentBytes);
      if (bytes) largest = Math.max(largest, bytes / 1024 ** 3);
    }
  }
  return largest ? round(largest) : null;
}

function memberRuntimeIds(runtime, runtimeId) {
  const members = runtime?.placement?.mode === 'distributed' ? (runtime.placement.members ?? []) : [];
  return members.length ? members.map((member) => member.runtime).filter(Boolean) : [runtimeId];
}

function configVariants(config, { nodeStatuses, env }) {
  const variants = [];
  for (const model of config.models ?? []) {
    if (!model?.id) continue;
    const base = {
      gatewayModel: model.id,
      model: model.pool?.model ?? model.upstreamModel ?? model.id,
      kind: model.kind ?? 'chat',
      capabilities: model.capabilities ?? [],
      source: 'config'
    };
    if (model.pool?.nodes?.length) {
      const nodes = [...model.pool.nodes].sort();
      variants.push({
        ...base,
        id: `${model.id}@${nodes.join('+')}`,
        managed: model.pool.managed === true,
        nodes,
        requirements: compact({
          nodeCount: nodes.length,
          memoryGbPerNode: num(model.pool.memoryGbPerNode),
          contextWindow: num(model.contextWindow)
        })
      });
      continue;
    }
    const runtime = model.runtime ? config.runtimes?.[model.runtime] : null;
    if (model.runtime) {
      if (!runtime || runtime.enabled === false) continue;
      const resources = runtimeResourcesByNode(runtime, config, env);
      const nodes = Object.keys(resources).sort();
      if (!nodes.length) continue;
      const configuredGb = Math.max(0, ...nodes.map((nodeId) => resources[nodeId].memoryGb));
      const measuredGb = measuredMemoryGb(nodeStatuses, nodes, memberRuntimeIds(runtime, model.runtime));
      variants.push({
        ...base,
        id: `${model.id}@${nodes.join('+')}`,
        runtime: model.runtime,
        managed: runtime.managed !== false && runtime.management !== 'external',
        nodes,
        requirements: compact({
          nodeCount: nodes.length,
          memoryGbPerNode: Math.max(configuredGb, measuredGb ?? 0) || null,
          contextWindow: num(model.contextWindow ?? runtime.contextWindow),
          maxSequences: num(runtime.maxActiveRequests),
          recipeId: runtime.recipe?.id ?? null,
          images: runtime.bootstrap?.image ? [runtime.bootstrap.image] : null
        }),
        ...(measuredGb ? { measured: { memoryGbPerNode: measuredGb, source: 'live-rss' } } : {})
      });
      continue;
    }
    const federated = modelTargets(model).filter((target) => target.node && target.remoteRuntime);
    if (federated.length) {
      for (const target of federated) {
        const remote = object(nodeStatuses?.[target.node]?.runtimeManager?.runtimes?.[target.remoteRuntime]);
        const members = remote.placement?.mode === 'distributed' ? (remote.placement.members ?? []) : [];
        const nodes = unique(members.length ? members.map((member) => member.node) : [target.node]).sort();
        const memberMemory = members.map((member) => num(member.resources?.memoryGb) ?? 0);
        variants.push({
          ...base,
          id: `${model.id}@${nodes.join('+')}`,
          remoteRuntime: target.remoteRuntime,
          controlNode: target.node,
          managed: true,
          nodes,
          requirements: compact({
            nodeCount: nodes.length,
            memoryGbPerNode: Math.max(num(remote.memoryGb) ?? 0, ...memberMemory) || null,
            contextWindow: num(model.contextWindow)
          })
        });
      }
      continue;
    }
    variants.push({ ...base, id: model.id, external: true, managed: false, requirements: {} });
  }
  return variants;
}

function recipeVariants(recipes) {
  return recipes.flatMap((recipe) =>
    (recipe.models ?? []).map((model) => {
      const gatewayModel = model.gatewayModel ?? model.model;
      return {
        id: `recipe:${recipe.id}:${gatewayModel}`,
        gatewayModel,
        model: model.model,
        kind: model.kind ?? (model.capabilities?.includes('chat') ? 'chat' : (recipe.kind ?? 'chat')),
        capabilities: model.capabilities ?? recipe.capabilities ?? [],
        source: 'recipe',
        managed: true,
        requirements: recipeServingRequirements(recipe, model)
      };
    })
  );
}

export function buildPoolCatalog({
  config = {},
  recipes = [],
  benchmarks = [],
  metrics = null,
  nodeStatuses = {},
  env = process.env
} = {}) {
  const variants = [...configVariants(config, { nodeStatuses, env }), ...recipeVariants(recipes)]
    .map((variant) => {
      const performance =
        livePerformance(metrics, variant.gatewayModel) ??
        benchmarkPerformance(benchmarks, {
          gatewayModel: variant.gatewayModel,
          recipeId: variant.requirements?.recipeId,
          model: variant.source === 'recipe' ? variant.model : null
        });
      return performance ? { ...variant, performance } : variant;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const groups = new Map();
  for (const variant of variants) {
    if (!groups.has(variant.model)) {
      groups.set(variant.model, {
        model: variant.model,
        kind: variant.kind,
        capabilities: variant.capabilities,
        variants: []
      });
    }
    groups.get(variant.model).variants.push(variant);
  }
  return {
    version: POOL_CATALOG_VERSION,
    variants,
    models: [...groups.values()].sort((left, right) => left.model.localeCompare(right.model))
  };
}

function aliasLeaves(config, ids) {
  const aliases = object(config.aliases);
  const modelIds = new Set((config.models ?? []).map((model) => model.id));
  return unique(
    ids.flatMap((id) => {
      if (!Object.hasOwn(aliases, id)) return modelIds.has(id) ? [id] : [];
      try {
        return expandedAliasMemberIds(id, aliases, modelIds).filter((leaf) => modelIds.has(leaf));
      } catch {
        return [];
      }
    })
  );
}

function currentRouteModel(config, alias) {
  return aliasLeaves(config, aliasRoutableMemberIds(alias))[0] ?? null;
}

function maxResidency(left, right) {
  return RESIDENCY_RANK[right] > RESIDENCY_RANK[left] ? right : left;
}

export function poolWorkloadsFromConfig(config = {}, { metrics = null, periodHours } = {}) {
  const pool = object(config.pool);
  const policy = object(pool.policy);
  const hours = num(periodHours) ?? PERIOD_HOURS[metrics?.period] ?? null;
  const alwaysAt = num(policy.alwaysAtRequestsPerHour) ?? 1;
  const preferredAt = num(policy.preferredAtRequestsPerHour) ?? 0.125;
  // Older gateways only aggregate by resolved model; split each model's demand
  // evenly across the aliases currently routed to it.
  const perAlias = Array.isArray(metrics?.requested);
  const routedTo = new Map();
  for (const alias of Object.values(object(config.aliases))) {
    const model = currentRouteModel(config, alias);
    if (model) routedTo.set(model, (routedTo.get(model) ?? 0) + 1);
  }
  const requestsFor = (aliasId, alias) => {
    if (perAlias) return num(metricBucket(metrics.requested, aliasId)?.requests) ?? 0;
    const model = currentRouteModel(config, alias);
    // A model with no bucket in the window had no traffic.
    return model ? (num(metricBucket(metrics.models, model)?.requests) ?? 0) / routedTo.get(model) : 0;
  };
  const workloads = [];
  for (const [aliasId, alias] of Object.entries(object(config.aliases))) {
    const profileMembers = Object.values(object(alias?.routeProfiles)).flatMap((profile) =>
      Array.isArray(profile?.members) ? profile.members : []
    );
    const candidates = aliasLeaves(config, [...aliasRoutableMemberIds(alias), ...profileMembers]);
    if (!candidates.length) continue;
    const override = object(object(pool.workloads)[aliasId]);
    const requests = metrics ? requestsFor(aliasId, alias) : null;
    const demandPerHour = hours && requests != null ? round(requests / hours, 3) : null;
    const demandResidency =
      demandPerHour == null
        ? 'auto'
        : demandPerHour >= alwaysAt
          ? 'always'
          : demandPerHour >= preferredAt
            ? 'preferred'
            : 'auto';
    const target = (config.models ?? []).find((model) => model.id === currentRouteModel(config, alias));
    const targetRuntime = target?.runtime ? config.runtimes?.[target.runtime] : null;
    const currentResidency = targetRuntime ? residencyPolicy(targetRuntime) : 'auto';
    workloads.push(
      compact({
        id: aliasId,
        candidates,
        residency:
          RESIDENCY_RANK[override.residency] != null
            ? override.residency
            : maxResidency(demandResidency, currentResidency),
        demandPerHour,
        required: override.required === false ? false : true,
        outputTokens: num(override.outputTokens),
        slo: override.slo && typeof override.slo === 'object' ? override.slo : null
      })
    );
  }
  return workloads.sort((left, right) => left.id.localeCompare(right.id));
}

function pinnedModel(config, aliasId, target) {
  const alias = object(config.aliases)[aliasId];
  if (!alias) return target;
  try {
    return aliasLeaves(config, resolveRouteTarget(alias, target).members)[0] ?? target;
  } catch {
    return target;
  }
}

export function poolPinsFromConfig(config = {}, { profile = null, cordon = [], routes = {} } = {}) {
  const pool = object(config.pool);
  const pinned = { ...object(object(pool.pins).routes), ...object(profile?.routes), ...object(routes) };
  const residency = {};
  for (const [runtimeId, runtime] of Object.entries(object(config.runtimes))) {
    if (runtime?.enabled === false) continue;
    if (residencyPolicy(runtime) === 'always') residency[runtimeId] = 'always';
  }
  for (const [runtimeId, policy] of Object.entries(object(profile?.residency))) {
    if (policy === 'always' && config.runtimes?.[runtimeId]) residency[runtimeId] = 'always';
  }
  return {
    routes: Object.fromEntries(
      Object.entries(pinned).map(([aliasId, target]) => [aliasId, pinnedModel(config, aliasId, target)])
    ),
    residency,
    cordon: unique([...(pool.cordon ?? []), ...cordon]).sort()
  };
}

// `external` is a healthy process LLooM did not start; it is serving all the same.
const SERVING_STATUSES = new Set(['running', 'external']);

function runtimeRunning(nodeStatuses, nodeId, runtimeId) {
  return SERVING_STATUSES.has(nodeStatuses?.[nodeId]?.runtimeManager?.runtimes?.[runtimeId]?.status);
}

export function currentPoolState(config = {}, { nodeStatuses = {}, variants = [] } = {}) {
  const routes = {};
  for (const [aliasId, alias] of Object.entries(object(config.aliases))) {
    const model = currentRouteModel(config, alias);
    if (model) routes[aliasId] = model;
  }
  const routed = new Set(Object.values(routes));
  const residency = {};
  const running = [];
  for (const variant of variants) {
    if (variant.external || variant.source === 'recipe') continue;
    if (variant.runtime && variant.managed) {
      const runtime = config.runtimes?.[variant.runtime];
      residency[variant.runtime] = residencyPolicy(runtime);
      const members = runtime?.placement?.mode === 'distributed' ? (runtime.placement.members ?? []) : [];
      const isRunning = members.length
        ? members.every((member) => runtimeRunning(nodeStatuses, member.node, member.runtime))
        : variant.nodes.some((nodeId) => runtimeRunning(nodeStatuses, nodeId, variant.runtime));
      if (isRunning) running.push(variant.id);
    } else if (variant.remoteRuntime) {
      if (runtimeRunning(nodeStatuses, variant.controlNode, variant.remoteRuntime)) running.push(variant.id);
    } else if (!variant.managed && routed.has(variant.gatewayModel)) {
      // An unmanaged lane that traffic is routed to is assumed to be up.
      running.push(variant.id);
    }
  }
  return { routes, residency, running: running.sort() };
}

function nodeLinks(config, nodeId, inventory) {
  const discovered = (config.cluster?.discovery?.links ?? []).flatMap((link) =>
    link?.nodeId === nodeId ? [link.peerNodeId] : link?.peerNodeId === nodeId ? [link.nodeId] : []
  );
  return unique([...(inventory?.links ?? []).map((link) => link.peerNodeId), ...discovered]).sort();
}

export function plannerNodesFromStatus(config = {}, nodeStatuses = {}, { env = process.env } = {}) {
  return Object.entries(clusterNodes(config, env))
    .map(([nodeId, node]) => {
      const status = nodeStatuses?.[nodeId] ?? null;
      const resources = object(node.resources);
      const inventory = status?.inventory ?? (status?.profile ? inventoryFromProfile(status.profile) : null);
      const configuredGb = num(resources.memoryGb);
      const memoryDomains = inventory?.memoryDomains?.length
        ? inventory.memoryDomains
        : configuredGb
          ? [{ id: 'memory', kind: 'unified', capacityGb: configuredGb }]
          : [];
      const accelerators = status?.profile?.accelerators ?? resources.accelerators ?? [];
      const computeArchs = inventory?.computeArchs?.length
        ? inventory.computeArchs
        : unique(accelerators.map((name) => ARCH_BY_ACCELERATOR[name]));
      const budgetGb = num(resources.memoryBudgetGb);
      return compact({
        id: nodeId,
        local: node.local === true,
        available: status ? status.reachable !== false : true,
        platformId: status?.profile?.platformId ?? null,
        computeArchs,
        accelerators,
        memoryDomains:
          budgetGb != null && memoryDomains.length === 1 ? [{ ...memoryDomains[0], budgetGb }] : memoryDomains,
        maxMemoryUtilization: num(resources.maxMemoryUtilization),
        reserveGb: num(resources.reserveMemoryGb),
        links: nodeLinks(config, nodeId, inventory),
        weights: (inventory?.weights ?? []).filter((entry) => entry.complete).map((entry) => entry.recipeId),
        images: inventory?.backends?.dockerImages ?? [],
        inventory: inventory ? (inventory.complete ? 'reported' : 'profile') : 'config'
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function preferred(value, fallback) {
  return (Array.isArray(value) ? value.length : value != null) ? value : fallback;
}

// Nodes that joined through pool membership (see pool-membership.mjs). A
// configured cluster node keeps its endpoint, credentials and resources;
// membership adds liveness, cordon/drain and its inventory when that is more
// complete than what the head already knows. The head has no credential or
// model catalog for an enrolled-only node, so it is planned but not routable
// until `lloom cluster add-node`. With `liveness: false` (saved state, no live
// gateway) lease ages are not evidence; only cordons and departures apply.
export function mergeMembershipNodes(nodes = [], members = [], { liveness = true } = {}) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const warnings = [];
  for (const member of members) {
    const joined = memberPlannerNode(member);
    const available = liveness ? joined.available : member.state !== 'left';
    const configured = byId.get(member.id);
    if (!configured) {
      byId.set(member.id, { ...joined, available, routable: false });
      if (member.state !== 'left') {
        warnings.push(
          `${member.id} joined the pool by enrollment only; placements there need ` +
            `\`lloom cluster add-node ${member.id} ${member.endpoint} --apply --yes\` before the head can route to it`
        );
      }
      continue;
    }
    let inventory = {};
    if (INVENTORY_RANK[joined.inventory] > INVENTORY_RANK[configured.inventory]) {
      const budgetGb = configured.memoryDomains?.length === 1 ? configured.memoryDomains[0].budgetGb : undefined;
      const memoryDomains = preferred(joined.memoryDomains, configured.memoryDomains);
      inventory = {
        platformId: preferred(joined.platformId, configured.platformId),
        computeArchs: preferred(joined.computeArchs, configured.computeArchs),
        accelerators: preferred(joined.accelerators, configured.accelerators),
        memoryDomains:
          budgetGb != null && memoryDomains.length === 1 ? [{ ...memoryDomains[0], budgetGb }] : memoryDomains,
        weights: joined.weights,
        images: joined.images,
        inventory: joined.inventory
      };
    }
    byId.set(
      member.id,
      compact({
        ...configured,
        ...inventory,
        links: unique([...(configured.links ?? []), ...joined.links]).sort(),
        available: configured.available !== false && available,
        cordoned: configured.cordoned === true || joined.cordoned || null,
        membership: member.state
      })
    );
  }
  return { nodes: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)), warnings };
}

export function buildPoolPlanInputs({
  config = {},
  nodeStatuses = {},
  metrics = null,
  recipes = [],
  benchmarks = [],
  profile = null,
  cordon = [],
  routes = {},
  considerInstalls = false,
  policy = {},
  members = [],
  membershipLiveness = true,
  env = process.env
} = {}) {
  const catalog = buildPoolCatalog({ config, recipes, benchmarks, metrics, nodeStatuses, env });
  const variants = considerInstalls ? catalog.variants : catalog.variants.filter((v) => v.source !== 'recipe');
  const { nodes, warnings } = mergeMembershipNodes(plannerNodesFromStatus(config, nodeStatuses, { env }), members, {
    liveness: membershipLiveness
  });
  return {
    nodes,
    warnings,
    variants,
    workloads: poolWorkloadsFromConfig(config, { metrics }),
    pins: poolPinsFromConfig(config, { profile, cordon, routes }),
    current: currentPoolState(config, { nodeStatuses, variants }),
    policy: compact({
      maxMemoryUtilization: num(config.runtimePolicy?.maxMemoryUtilization),
      reserveGb: num(config.runtimePolicy?.reserveMemoryGb),
      ...object(config.pool?.policy),
      ...policy
    }),
    catalog
  };
}
