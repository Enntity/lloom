// Pool placement planner. Pure: given node inventories, a variant catalog,
// workloads (aliases with demand and residency intent), pins and the current
// state, it proposes which variants run where, how each alias routes, and
// the diff from what is running now. It never starts, stops or reroutes
// anything; the per-node admission planner (runtime-policy.mjs) remains the
// safety layer that decides whether a start is allowed at request time.
//
// Objective, compared lexicographically:
//   1. cover every required workload and honour every pin
//   2. use external (cloud) members only when nothing local covers a workload
//   3. meet workload latency SLOs
//   4. minimise demand-weighted latency plus the load cost of every change
// Search is a greedy pass followed by single-workload local search.

import { memoryBudgetGb } from './resource-fit.mjs';

export const POOL_PLAN_VERSION = 1;

export const DEFAULT_POOL_POLICY = Object.freeze({
  maxMemoryUtilization: null,
  memorySafetyUtilization: 0.9,
  reserveGb: 8,
  headroomGb: 4,
  horizonHours: 24,
  churnWeight: 10,
  routeChangeMs: 1000,
  outputTokens: 256,
  minDemandPerHour: 0.1,
  unknownLatencyMs: 10000,
  external: 'fallback',
  loadBaseSeconds: 30,
  loadSecondsPerGb: 2,
  fetchMBps: 100,
  imagePullSeconds: 300,
  manualActionSeconds: 600,
  localSearchPasses: 3
});

const RESIDENCY_RANK = { auto: 0, preferred: 1, always: 2 };
const EXTERNAL_MODES = new Set(['fallback', 'allow', 'never']);

function num(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== '') : [];
}

function normalizeArch(value) {
  return String(value)
    .toLowerCase()
    .replace(/^(sm_\d+)[af]$/, '$1');
}

function maxResidency(left, right) {
  return RESIDENCY_RANK[right] > RESIDENCY_RANK[left] ? right : left;
}

function normalizeResidency(value, fallback = 'auto') {
  return Object.hasOwn(RESIDENCY_RANK, value) ? value : fallback;
}

export function normalizePoolPolicy(policy = {}) {
  const merged = { ...DEFAULT_POOL_POLICY };
  for (const [key, value] of Object.entries(policy ?? {})) {
    if (value === undefined) continue;
    if (key === 'external') merged.external = EXTERNAL_MODES.has(value) ? value : DEFAULT_POOL_POLICY.external;
    else if (key in DEFAULT_POOL_POLICY) merged[key] = value === null ? null : (num(value) ?? merged[key]);
  }
  return merged;
}

// The runtime memory safety guard aborts a load once host memory use reaches
// min(memorySafety.maxMemoryUtilization, runtimePolicy.maxMemoryUtilization),
// 0.9 by default (runtime-memory-safety.mjs). Admission may allow more, so a
// plan that only fits under the admission budget would be aborted mid-load.
function memorySafetyCeiling(node, policy) {
  const safety = num(policy.memorySafetyUtilization);
  if (safety == null) return null;
  const utilization = num(node.maxMemoryUtilization) ?? num(policy.maxMemoryUtilization) ?? safety;
  return Math.min(safety, utilization);
}

function domainBudgets(node, policy) {
  const headroomGb = num(node.headroomGb) ?? num(policy.headroomGb) ?? 0;
  const ceiling = memorySafetyCeiling(node, policy);
  return list(node.memoryDomains).map((domain) => {
    const capacityGb = num(domain.capacityGb) ?? 0;
    let budgetGb = memoryBudgetGb({
      totalMemoryGb: capacityGb,
      memoryBudgetGb: domain.budgetGb,
      maxMemoryUtilization: num(node.maxMemoryUtilization) ?? num(policy.maxMemoryUtilization),
      reserveMemoryGb: num(node.reserveGb) ?? num(policy.reserveGb) ?? 0
    });
    if (ceiling != null && domain.kind !== 'device') budgetGb = Math.min(budgetGb, capacityGb * ceiling);
    return {
      id: String(domain.id ?? domain.kind ?? 'memory'),
      kind: String(domain.kind ?? 'system'),
      capacityGb,
      budgetGb: round(Math.max(0, budgetGb - headroomGb))
    };
  });
}

// Model weights live in unified memory on Apple Silicon and Spark, and in the
// largest device memory otherwise; host-side state lives in system memory.
function acceleratorDomain(domains) {
  return (
    domains.find((domain) => domain.kind === 'unified') ??
    [...domains].filter((domain) => domain.kind === 'device').sort((a, b) => b.budgetGb - a.budgetGb)[0] ??
    domains.find((domain) => domain.kind === 'system') ??
    null
  );
}

function systemDomain(domains) {
  return domains.find((domain) => domain.kind === 'system') ?? acceleratorDomain(domains);
}

function memoryDemands(variant, domains) {
  const requirements = variant.requirements ?? {};
  const demands = new Map();
  const add = (domain, gb) => {
    if (!domain || !(gb > 0)) return;
    demands.set(domain.id, (demands.get(domain.id) ?? 0) + gb);
  };
  add(acceleratorDomain(domains), num(requirements.memoryGbPerNode) ?? 0);
  add(systemDomain(domains), num(requirements.systemMemoryGbPerNode) ?? 0);
  return demands;
}

function variantMemoryGb(variant) {
  return (num(variant.requirements?.memoryGbPerNode) ?? 0) + (num(variant.requirements?.systemMemoryGbPerNode) ?? 0);
}

function nodeIneligibility(variant, node) {
  if (node.cordoned) return 'cordoned';
  if (node.available === false) return 'unavailable';
  if (list(variant.excludeNodes).includes(node.id)) return 'excluded after a failed start';
  const requirements = variant.requirements ?? {};
  const platforms = list(requirements.platforms);
  if (platforms.length && !platforms.includes(node.platformId)) return `needs platform ${platforms.join('|')}`;
  const archs = list(requirements.computeArchs).map(normalizeArch);
  const nodeArchs = new Set(list(node.computeArchs).map(normalizeArch));
  if (archs.length && !archs.some((arch) => nodeArchs.has(arch))) return `needs compute arch ${archs.join('|')}`;
  const accelerators = new Set(list(node.accelerators));
  const missing = list(requirements.accelerators).filter((accelerator) => !accelerators.has(accelerator));
  if (missing.length) return `needs accelerator ${missing.join(', ')}`;
  if (!list(node.memoryDomains).length) return 'no memory capacity reported';
  return null;
}

function linked(left, right) {
  return list(left.links).includes(right.id) || list(right.links).includes(left.id);
}

function combinations(items, size) {
  if (size === 0) return [[]];
  const result = [];
  items.forEach((item, index) => {
    for (const rest of combinations(items.slice(index + 1), size - 1)) result.push([item, ...rest]);
  });
  return result;
}

// Candidate node sets for one variant, plus the reasons other sets were ruled
// out. Configured runtimes are fixed to their node(s); recipe variants may run
// on any eligible set, and tensor-parallel sets must be directly linked.
function candidateNodeSets(variant, nodesById) {
  const reasons = [];
  if (variant.external) return { sets: [[]], reasons };
  if (list(variant.nodes).length) {
    const nodes = variant.nodes.map((id) => nodesById.get(id));
    const missing = variant.nodes.filter((id, index) => !nodes[index]);
    if (missing.length) return { sets: [], reasons: [`unknown node ${missing.join(', ')}`] };
    const blocked = nodes
      .map((node) => [node.id, nodeIneligibility(variant, node)])
      .filter(([, reason]) => reason)
      .map(([id, reason]) => `${id} ${reason}`);
    return blocked.length ? { sets: [], reasons: blocked } : { sets: [variant.nodes.slice()], reasons };
  }
  const size = Math.max(1, Math.floor(num(variant.requirements?.nodeCount) ?? 1));
  const eligible = [];
  for (const node of [...nodesById.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const reason = nodeIneligibility(variant, node);
    if (reason) reasons.push(`${node.id} ${reason}`);
    else eligible.push(node);
  }
  if (eligible.length < size) {
    reasons.push(`needs ${size} eligible node${size === 1 ? '' : 's'}, found ${eligible.length}`);
    return { sets: [], reasons };
  }
  const sets = combinations(eligible, size)
    .filter((set) => set.every((node, index) => set.slice(index + 1).every((other) => linked(node, other))))
    .map((set) => set.map((node) => node.id));
  if (!sets.length) reasons.push(`no directly linked set of ${size} eligible nodes`);
  return { sets, reasons };
}

// Memory belongs to the serving process, so models that share a runtime (or a
// remote runtime) on the same nodes share one placement and one charge.
function slotKey(variant, nodes) {
  if (variant.runtime) return `runtime:${variant.runtime}|${nodes.join('+')}`;
  if (variant.remoteRuntime) return `remote:${variant.controlNode ?? ''}/${variant.remoteRuntime}`;
  return placementKey(variant, nodes);
}

function placementKey(variant, nodes) {
  return list(variant.nodes).length || variant.external ? variant.id : `${variant.id}@${nodes.join('+')}`;
}

function latencyMs(variant, workload, policy) {
  const performance = variant.performance ?? {};
  const ttft = num(performance.ttftMs);
  const tps = num(performance.decodeTps);
  const outputTokens = num(workload.outputTokens) ?? policy.outputTokens;
  if (ttft != null && tps > 0) return ttft + (Math.max(0, outputTokens - 1) * 1000) / tps;
  return num(performance.durationMs) ?? ttft ?? policy.unknownLatencyMs;
}

function loadSeconds(variant, nodes, nodesById, policy) {
  if (variant.external) return 0;
  const memoryGb = variantMemoryGb(variant);
  let seconds = num(variant.loadSeconds) ?? policy.loadBaseSeconds + memoryGb * policy.loadSecondsPerGb;
  if (variant.managed === false) seconds += policy.manualActionSeconds;
  // Configured lanes are installed on their nodes; only new placements fetch.
  if (list(variant.nodes).length) return seconds;
  for (const nodeId of nodes) {
    const node = nodesById.get(nodeId);
    const recipeId = variant.requirements?.recipeId;
    if (recipeId && !list(node?.weights).includes(recipeId)) {
      const diskGb = num(variant.requirements?.diskGb) ?? memoryGb;
      seconds += (diskGb * 1024) / Math.max(1, policy.fetchMBps);
    }
    const images = list(variant.requirements?.images);
    if (images.some((image) => !list(node?.images).includes(image))) seconds += policy.imagePullSeconds;
  }
  return seconds;
}

function emptyState(nodes, policy) {
  const usage = new Map();
  const domains = new Map();
  for (const node of nodes) {
    const budgets = domainBudgets(node, policy);
    domains.set(node.id, budgets);
    usage.set(node.id, new Map(budgets.map((domain) => [domain.id, { always: 0, preferred: 0 }])));
  }
  return { domains, usage, placements: new Map(), routes: {}, uncovered: [], warnings: [], pinViolations: [] };
}

// The largest on-demand placement that must still be admissible next to the
// hard-resident set on one memory domain.
function largestOnDemandGb(state, nodeId, domainId, excludeKey = null) {
  let largest = 0;
  for (const placement of state.placements.values()) {
    if (placement.residency !== 'auto' || placement.slot === excludeKey || placement.variant.external) continue;
    if (!placement.nodes.includes(nodeId)) continue;
    const gb = memoryDemands(placement.variant, state.domains.get(nodeId) ?? []).get(domainId) ?? 0;
    largest = Math.max(largest, gb);
  }
  return largest;
}

function fitsAt(variant, nodes, residency, state, existing = null) {
  for (const nodeId of nodes) {
    const budgets = state.domains.get(nodeId) ?? [];
    const usage = state.usage.get(nodeId);
    for (const [domainId, gb] of memoryDemands(variant, budgets)) {
      const budget = budgets.find((domain) => domain.id === domainId).budgetGb;
      const used = usage.get(domainId);
      // An upgrade re-counts a placement that is already resident.
      const prior = existing && existing.residency !== 'auto' ? gb : 0;
      const resident = used.always + used.preferred - prior;
      const always = used.always - (existing?.residency === 'always' ? gb : 0);
      const onDemand = largestOnDemandGb(state, nodeId, domainId, existing?.slot);
      if (residency === 'always' && (resident + gb > budget || always + gb + onDemand > budget)) return false;
      if (residency === 'preferred' && resident + gb > budget) return false;
      if (residency === 'auto' && always + gb > budget) return false;
    }
  }
  return true;
}

function charge(variant, nodes, residency, state, sign = 1) {
  if (residency === 'auto') return;
  for (const nodeId of nodes) {
    const budgets = state.domains.get(nodeId) ?? [];
    const usage = state.usage.get(nodeId);
    for (const [domainId, gb] of memoryDemands(variant, budgets)) usage.get(domainId)[residency] += sign * gb;
  }
}

function place(state, variant, nodes, residency, workloadId = null) {
  const slot = slotKey(variant, nodes);
  let placement = state.placements.get(slot);
  if (!placement) {
    placement = {
      slot,
      key: placementKey(variant, nodes),
      variant,
      nodes,
      residency,
      variants: new Map(),
      workloads: []
    };
    state.placements.set(slot, placement);
    if (!variant.external) charge(variant, nodes, residency, state);
  } else if (RESIDENCY_RANK[residency] > RESIDENCY_RANK[placement.residency]) {
    if (!variant.external) charge(variant, nodes, placement.residency, state, -1);
    placement.residency = residency;
    if (!variant.external) charge(variant, nodes, residency, state);
  }
  placement.variants.set(variant.id, variant);
  if (workloadId) placement.workloads.push(workloadId);
  return placement;
}

// Every way a workload could be served right now: an existing placement it
// can share, or a new placement on a node set that fits.
function workloadOptions(workload, candidates, ctx, state) {
  const { variantsByModel, nodesById, policy, current } = ctx;
  const options = [];
  const reasons = [];
  const demand = Math.max(num(workload.demandPerHour) ?? 0, policy.minDemandPerHour);
  const wanted = normalizeResidency(workload.residency);
  const contextWindow = num(workload.slo?.contextWindow);
  candidates.forEach((model, preference) => {
    const variants = variantsByModel.get(model) ?? [];
    if (!variants.length) reasons.push(`${model}: no variant in the pool catalog`);
    for (const variant of variants) {
      if (variant.external && policy.external === 'never') {
        reasons.push(`${model}: external members are disabled`);
        continue;
      }
      if (contextWindow && (num(variant.requirements?.contextWindow) ?? 0) < contextWindow) {
        reasons.push(`${variant.id}: context window below ${contextWindow}`);
        continue;
      }
      const latency = latencyMs(variant, workload, policy);
      const sloTtft = num(workload.slo?.ttftMs);
      const ttft = num(variant.performance?.ttftMs) ?? latency;
      const base = {
        model,
        variant,
        preference,
        latencyMs: latency,
        external: Boolean(variant.external),
        sloMiss: sloTtft != null && ttft > sloTtft ? 1 : 0,
        cost:
          demand * latency * policy.horizonHours +
          (current.routes?.[workload.id] != null && current.routes[workload.id] !== model ? policy.routeChangeMs : 0)
      };
      const { sets, reasons: setReasons } = candidateNodeSets(variant, nodesById);
      reasons.push(...setReasons.map((reason) => `${variant.id}: ${reason}`));
      for (const nodes of sets) {
        const existing = state.placements.get(slotKey(variant, nodes));
        const key = existing?.key ?? placementKey(variant, nodes);
        const residency = variant.external ? 'auto' : existing ? maxResidency(existing.residency, wanted) : wanted;
        let chosen = residency;
        if (!variant.external && !fitsAt(variant, nodes, residency, state, existing)) {
          // Preferred residency is soft: fall back to on-demand when it fits.
          if (residency === 'preferred' && fitsAt(variant, nodes, 'auto', state, existing)) chosen = 'auto';
          else if (existing && fitsAt(variant, nodes, existing.residency, state, existing)) {
            chosen = existing.residency;
          } else {
            reasons.push(`${key}: does not fit as ${residency} on ${nodes.join('+')}`);
            continue;
          }
        }
        const isNew = !existing;
        const running = current.running?.has(placementKey(variant, nodes)) || current.running?.has(variant.id);
        const churnSeconds = isNew && !running ? loadSeconds(variant, nodes, nodesById, policy) : 0;
        options.push({
          ...base,
          nodes,
          key,
          residency: chosen,
          downgraded: chosen !== residency,
          churnSeconds,
          cost: base.cost + churnSeconds * 1000 * policy.churnWeight
        });
      }
    }
  });
  return { options, reasons };
}

function better(left, right) {
  for (const key of ['uncovered', 'external', 'sloMisses']) {
    if (left[key] !== right[key]) return left[key] < right[key];
  }
  return left.cost < right.cost - Math.max(1e-6, Math.abs(right.cost) * 1e-9);
}

function optionOrder(left, right, policy) {
  if (policy.external === 'fallback' && left.external !== right.external) return left.external ? 1 : -1;
  if (left.sloMiss !== right.sloMiss) return left.sloMiss - right.sloMiss;
  if (left.cost !== right.cost) return left.cost - right.cost;
  return left.preference - right.preference || left.key.localeCompare(right.key);
}

function workloadOrder(pins) {
  return (left, right) => {
    const pinned = Number(Boolean(pins.routes?.[right.id])) - Number(Boolean(pins.routes?.[left.id]));
    if (pinned) return pinned;
    const residency =
      RESIDENCY_RANK[normalizeResidency(right.residency)] - RESIDENCY_RANK[normalizeResidency(left.residency)];
    if (residency) return residency;
    const required = Number(right.required !== false) - Number(left.required !== false);
    if (required) return required;
    return (num(right.demandPerHour) ?? 0) - (num(left.demandPerHour) ?? 0) || left.id.localeCompare(right.id);
  };
}

function greedy(ctx, forced) {
  const { workloads, pins, policy, nodes, variants } = ctx;
  const state = emptyState(nodes, policy);
  let cost = 0;
  let external = 0;
  let sloMisses = 0;

  for (const [runtimeId, residency] of Object.entries(pins.residency ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (residency !== 'always') continue;
    const variant = variants.find((candidate) => candidate.runtime === runtimeId && list(candidate.nodes).length);
    if (!variant) continue;
    const { sets, reasons } = candidateNodeSets(variant, ctx.nodesById);
    const key = placementKey(variant, sets[0] ?? []);
    if (!sets.length || !fitsAt(variant, sets[0], 'always', state, state.placements.get(slotKey(variant, sets[0])))) {
      state.pinViolations.push({ runtime: runtimeId, reasons: reasons.length ? reasons : ['does not fit'] });
      continue;
    }
    const running = ctx.current.running?.has(key) || ctx.current.running?.has(variant.id);
    if (!running) cost += loadSeconds(variant, sets[0], ctx.nodesById, policy) * 1000 * policy.churnWeight;
    place(state, variant, sets[0], 'always');
  }

  for (const workload of workloads) {
    const pinned = pins.routes?.[workload.id];
    const candidates = pinned ? [pinned] : forced[workload.id] ? [forced[workload.id]] : list(workload.candidates);
    const { options, reasons } = workloadOptions(workload, candidates, ctx, state);
    options.sort((left, right) => optionOrder(left, right, policy));
    const option = options[0];
    if (!option) {
      state.uncovered.push({
        workload: workload.id,
        required: workload.required !== false,
        ...(pinned ? { pinned } : {}),
        reasons: [...new Set(reasons)].slice(0, 12)
      });
      continue;
    }
    if (option.downgraded) {
      state.warnings.push(
        `${workload.id}: ${option.key} kept ${option.residency} because ${normalizeResidency(workload.residency)} residency does not fit`
      );
    }
    place(state, option.variant, option.nodes, option.residency, workload.id);
    state.routes[workload.id] = {
      model: option.model,
      variant: option.variant.id,
      placement: option.key,
      nodes: option.nodes,
      residency: option.residency,
      external: option.external,
      latencyMs: round(option.latencyMs),
      reason: pinned ? 'pinned' : option.external ? 'external' : 'planned'
    };
    cost += option.cost;
    external += option.external && policy.external === 'fallback' ? 1 : 0;
    sloMisses += option.sloMiss;
  }

  state.score = {
    uncovered: state.uncovered.filter((entry) => entry.required).length + state.pinViolations.length,
    external,
    sloMisses,
    cost: round(cost)
  };
  return state;
}

function search(ctx) {
  let forced = {};
  let best = greedy(ctx, forced);
  for (let pass = 0; pass < ctx.policy.localSearchPasses; pass += 1) {
    let improved = false;
    for (const workload of ctx.workloads) {
      if (ctx.pins.routes?.[workload.id]) continue;
      for (const model of list(workload.candidates)) {
        if (best.routes[workload.id]?.model === model || forced[workload.id] === model) continue;
        const trialForced = { ...forced, [workload.id]: model };
        const trial = greedy(ctx, trialForced);
        if (better(trial.score, best.score)) {
          best = trial;
          forced = trialForced;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function summarizeNodes(ctx, state) {
  return Object.fromEntries(
    ctx.nodes.map((node) => {
      const domains = state.domains.get(node.id).map((domain) => {
        const used = state.usage.get(node.id).get(domain.id);
        const residentGb = round(used.always + used.preferred);
        return {
          id: domain.id,
          kind: domain.kind,
          capacityGb: domain.capacityGb,
          budgetGb: domain.budgetGb,
          alwaysGb: round(used.always),
          residentGb,
          largestOnDemandGb: round(largestOnDemandGb(state, node.id, domain.id)),
          freeGb: round(domain.budgetGb - residentGb)
        };
      });
      return [
        node.id,
        {
          status: node.cordoned ? 'cordoned' : node.available === false ? 'unavailable' : 'available',
          domains,
          placements: [...state.placements.values()]
            .filter((placement) => placement.nodes.includes(node.id))
            .map((placement) => placement.key)
            .sort()
        }
      ];
    })
  );
}

function planDiff(ctx, state, residency) {
  const { current } = ctx;
  const running = current.running ?? new Set();
  const placements = [...state.placements.values()].filter((placement) => !placement.variant.external);
  const planned = new Set(placements.flatMap((placement) => [placement.key, ...placement.variants.keys()]));
  const start = [];
  const manual = [];
  const keep = [];
  for (const placement of placements) {
    const isRunning = running.has(placement.key) || [...placement.variants.keys()].some((id) => running.has(id));
    if (isRunning) keep.push(placement.key);
    else if (placement.residency !== 'auto') {
      (placement.variant.managed === false ? manual : start).push({
        action: placement.variant.managed === false ? 'manual-start' : 'start',
        placement: placement.key,
        nodes: placement.nodes,
        residency: placement.residency
      });
    }
  }
  const release = [...running]
    .filter((key) => !planned.has(key))
    .sort()
    .map((key) => {
      const variant = ctx.variants.find((candidate) => candidate.id === key || key.startsWith(`${candidate.id}@`));
      if (variant?.managed === false) {
        manual.push({ action: 'manual-stop', placement: key, nodes: variant.nodes ?? [] });
        return null;
      }
      return { action: 'release', placement: key };
    })
    .filter(Boolean);
  const routeChanges = Object.entries(state.routes)
    .filter(([alias, route]) => (current.routes?.[alias] ?? null) !== route.model)
    .map(([alias, route]) => ({ alias, from: current.routes?.[alias] ?? null, to: route.model }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  const residencyChanges = Object.entries(residency)
    .filter(([runtime, policy]) => current.residency?.[runtime] != null && current.residency[runtime] !== policy)
    .map(([runtime, policy]) => ({ runtime, from: current.residency[runtime], to: policy }))
    .sort((a, b) => a.runtime.localeCompare(b.runtime));
  return { start, manual, release, keep: keep.sort(), routeChanges, residencyChanges };
}

export function planPool({ nodes = [], variants = [], workloads = [], pins = {}, current = {}, policy = {} } = {}) {
  const normalizedPolicy = normalizePoolPolicy(policy);
  const cordoned = new Set(list(pins.cordon));
  const plannerNodes = list(nodes)
    .map((node) => ({ ...node, cordoned: node.cordoned === true || cordoned.has(node.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sortedVariants = list(variants)
    .map((variant) => ({ managed: true, ...variant }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const variantsByModel = new Map();
  for (const variant of sortedVariants) {
    if (!variantsByModel.has(variant.gatewayModel)) variantsByModel.set(variant.gatewayModel, []);
    variantsByModel.get(variant.gatewayModel).push(variant);
  }
  const ctx = {
    nodes: plannerNodes,
    nodesById: new Map(plannerNodes.map((node) => [node.id, node])),
    variants: sortedVariants,
    variantsByModel,
    workloads: [...list(workloads)].sort(workloadOrder(pins)),
    pins,
    policy: normalizedPolicy,
    current: {
      routes: current.routes ?? {},
      residency: current.residency ?? {},
      running: new Set(list(current.running instanceof Set ? [...current.running] : current.running))
    }
  };
  const state = search(ctx);

  const residency = {};
  for (const variant of sortedVariants) {
    if (variant.runtime && variant.managed !== false && !variant.external) residency[variant.runtime] ??= 'auto';
  }
  for (const placement of state.placements.values()) {
    const runtime = placement.variant.runtime;
    if (runtime && placement.variant.managed !== false) {
      residency[runtime] = maxResidency(residency[runtime] ?? 'auto', placement.residency);
    }
  }

  const placements = [...state.placements.values()]
    .map((placement) => ({
      placement: placement.key,
      variant: placement.variant.id,
      models: [...new Set([...placement.variants.values()].map((variant) => variant.gatewayModel))].sort(),
      runtime: placement.variant.runtime ?? null,
      nodes: placement.nodes,
      residency: placement.residency,
      managed: placement.variant.managed !== false,
      external: Boolean(placement.variant.external),
      memoryGbPerNode: variantMemoryGb(placement.variant),
      workloads: [...placement.workloads].sort()
    }))
    .sort((a, b) => a.placement.localeCompare(b.placement));

  return {
    version: POOL_PLAN_VERSION,
    ok: state.score.uncovered === 0,
    policy: normalizedPolicy,
    placements,
    routes: Object.fromEntries(Object.entries(state.routes).sort(([a], [b]) => a.localeCompare(b))),
    residency: Object.fromEntries(Object.entries(residency).sort(([a], [b]) => a.localeCompare(b))),
    uncovered: state.uncovered.sort((a, b) => a.workload.localeCompare(b.workload)),
    pinViolations: state.pinViolations,
    nodes: summarizeNodes(ctx, state),
    diff: planDiff(ctx, state, residency),
    score: state.score,
    warnings: state.warnings
  };
}
