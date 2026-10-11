// Pool simulator: a deterministic discrete-event model of a LLooM fleet, used
// to test pool planning and reconciliation without touching a live gateway.
//
// The simulator owns the "truth" (real memory footprints, load times, request
// service times, failures) and drives the real planner, reconciler and
// controller through a simulated actuator. It also models what LLooM already
// does without a pool controller, so `off` is today's behaviour:
//
//   - requests go to the alias's routed member, else the first ready candidate,
//     else a cold start that per-node admission allows, else an external member;
//   - admission evicts idle on-demand lanes (then idle preferred lanes) LRU and
//     never evicts keep-warm lanes;
//   - keep-warm and preferred lanes are restored on their configured nodes;
//   - the memory safety guard aborts a managed load that would push the host
//     past `memoryGuard.maxMemoryUtilization` (default 0.9) of physical memory.
//
// A lane whose true footprint overflows a node's physical memory (an
// unguarded load, or the guard turned off) is a memory violation: the node
// hangs, as a Spark does on unified-memory exhaustion, and is unavailable for
// `hangMinutes`. Plans should never cause one.

import { createPoolController } from './pool-controller.mjs';
import { createPoolMembership } from './pool-membership.mjs';
import { memoryBudgetGb } from './resource-fit.mjs';
import { memorySafetyCeiling } from './runtime-memory-safety.mjs';

export const POOL_SIM_VERSION = 1;

const HOUR = 3600000;
const MINUTE = 60000;
const RESIDENCY_RANK = { auto: 0, preferred: 1, always: 2 };

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== '') : [];
}

function num(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

class EventQueue {
  constructor() {
    this.heap = [];
    this.seq = 0;
  }
  push(at, fn) {
    const item = { at, seq: this.seq++, fn };
    const heap = this.heap;
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.less(heap[parent], item)) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  }
  less(a, b) {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
  pop() {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = left < heap.length && this.less(heap[left], last) ? left : -1;
        if (right < heap.length && this.less(heap[right], next < 0 ? last : heap[next])) next = right;
        if (next < 0) break;
        heap[index] = heap[next];
        index = next;
      }
      heap[index] = last;
    }
    return top;
  }
  get size() {
    return this.heap.length;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function placementKey(variant, nodes) {
  return list(variant.nodes).length || variant.external ? variant.id : `${variant.id}@${nodes.join('+')}`;
}

function demandRate(workload, at) {
  const demand = workload.demand ?? {};
  let rate = num(demand.perHour) ?? num(workload.demandPerHour) ?? 0;
  const diurnal = demand.diurnal;
  if (diurnal) {
    const hour = (at / HOUR) % 24;
    const amplitude = num(diurnal.amplitude) ?? 0;
    rate *= 1 + amplitude * Math.cos(((hour - (num(diurnal.peakHour) ?? 14)) / 24) * 2 * Math.PI);
  }
  for (const change of list(demand.changes)) {
    if (at >= change.atHours * HOUR) rate = num(change.perHour) ?? rate;
  }
  for (const burst of list(demand.bursts)) {
    const start = burst.atHours * HOUR;
    if (at >= start && at < start + burst.hours * HOUR) rate *= num(burst.multiplier) ?? 1;
  }
  return Math.max(0, rate);
}

function maxDemandRate(workload) {
  const demand = workload.demand ?? {};
  let rate = num(demand.perHour) ?? num(workload.demandPerHour) ?? 0;
  for (const change of list(demand.changes)) rate = Math.max(rate, num(change.perHour) ?? 0);
  rate *= 1 + Math.abs(num(demand.diurnal?.amplitude) ?? 0);
  const burst = Math.max(1, ...list(demand.bursts).map((entry) => num(entry.multiplier) ?? 1));
  return rate * burst;
}

/**
 * Run one scenario in one controller mode. Returns a report; never throws for
 * scenario-level failures (they show up as failed requests and violations).
 */
export async function runPoolSimulation(scenario, { mode = 'auto', controller: controllerOverrides = {} } = {}) {
  const random = mulberry32(num(scenario.seed) ?? 1);
  const queue = new EventQueue();
  const durationMs = (num(scenario.durationHours) ?? 24) * HOUR;
  const tickMs = (num(scenario.tickMinutes) ?? 1) * MINUTE;
  const policy = scenario.policy ?? {};
  const queueTimeoutMs = (num(scenario.queueTimeoutSeconds) ?? 600) * 1000;
  const drainTimeoutMs = (num(scenario.drainTimeoutSeconds) ?? 600) * 1000;
  const hangMs = (num(scenario.hangMinutes) ?? 30) * MINUTE;
  const demandWindowMs = (num(scenario.demandWindowHours) ?? 24) * HOUR;
  const operator = scenario.operator ?? {};
  const memoryGuard = scenario.memoryGuard ?? {};
  const guardUtilization =
    memorySafetyCeiling({
      maxMemoryUtilization: num(policy.maxMemoryUtilization) ?? undefined,
      memorySafety: { maxMemoryUtilization: num(memoryGuard.maxMemoryUtilization) ?? undefined }
    }) ?? 1;
  const osGb = num(scenario.osMemoryGb) ?? 4;
  let now = 0;

  const report = {
    version: POOL_SIM_VERSION,
    scenario: scenario.name ?? 'scenario',
    mode,
    durationHours: durationMs / HOUR,
    requests: { total: 0, served: 0, failed: 0, external: 0, coldWaits: 0, sloMet: 0 },
    workloads: {},
    lanes: { loads: 0, loadGb: 0, stops: 0, startFailures: 0, guardAborts: 0, admissionRefusals: 0, evictions: 0 },
    safety: { memoryViolations: [], nodeHangs: 0 },
    controller: {
      ticks: 0,
      proposals: 0,
      applies: 0,
      urgentApplies: 0,
      steps: 0,
      stepFailures: 0,
      interruptions: 0,
      firstProposal: null,
      decisions: [],
      holds: []
    },
    timeline: []
  };
  const ttfts = {};
  const timeline = (kind, detail = {}) => {
    if (report.timeline.length < (num(scenario.timelineLimit) ?? 400)) {
      report.timeline.push({ atMinutes: round(now / MINUTE, 2), kind, ...detail });
    }
  };

  // --- fleet state -----------------------------------------------------------
  const nodes = new Map(
    list(scenario.nodes).map((node) => [
      node.id,
      {
        spec: node,
        joined: node.joinAtHours == null,
        available: node.available !== false,
        cordoned: node.cordoned === true,
        hungUntil: 0,
        weights: new Set(list(node.weights)),
        images: new Set(list(node.images))
      }
    ])
  );
  const variants = list(scenario.variants).map((variant) => ({ managed: true, ...variant }));
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const variantsForModel = (model) => variants.filter((variant) => variant.gatewayModel === model);
  const workloads = list(scenario.workloads);
  const routes = { ...(scenario.initial?.routes ?? {}) };
  const residency = { ...(scenario.initial?.residency ?? {}) };
  const lanes = new Map();
  const learnedMemory = new Map();
  const served = new Map();
  const arrivals = new Map(workloads.map((workload) => [workload.id, []]));
  const flexiblePlacements = new Map();
  const latched = new Set();

  // With `membership`, nodes enroll with the head and heartbeat; the planner
  // learns that a node is gone only when its lease is lost, as a real head
  // would. Without it, the planner sees node failures immediately.
  const membershipConfig = scenario.membership ?? null;
  const SIM_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
  const membership = membershipConfig
    ? createPoolMembership({
        leaseMs: (num(membershipConfig.leaseSeconds) ?? 30) * 1000,
        lostAfterMs: (num(membershipConfig.lostAfterSeconds) ?? 90) * 1000,
        now: () => SIM_EPOCH + now
      })
    : null;
  const heartbeatMs = (num(membershipConfig?.heartbeatSeconds) ?? 10) * 1000;
  const nodeSecrets = new Map();
  function enroll(id) {
    if (!membership) return;
    const { token } = membership.issueEnrollmentToken();
    const { nodeSecret } = membership.enroll({ token, nodeId: id, endpoint: `http://${id}.pool.test:8100` });
    nodeSecrets.set(id, nodeSecret);
    const beat = () => {
      const node = nodes.get(id);
      if (!node.joined || nodeSecrets.get(id) !== nodeSecret) return;
      // A crashed, hung or partitioned node stops heartbeating but stays enrolled.
      if (node.available && node.hungUntil <= now && !(node.partitionedUntil > now)) {
        membership.heartbeat({ nodeId: id, nodeSecret, running: lanesOn(id).map((lane) => lane.key) });
      }
      queue.push(now + heartbeatMs, beat);
    };
    queue.push(now + heartbeatMs, beat);
  }
  const memberById = () => new Map((membership?.members() ?? []).map((member) => [member.id, member]));

  const truth = (variant) => variant.sim ?? {};
  const memoryTruth = (variant) =>
    num(truth(variant).memoryGbPerNode) ?? num(variant.requirements?.memoryGbPerNode) ?? 0;
  const memoryEstimate = (variant) =>
    Math.max(num(variant.requirements?.memoryGbPerNode) ?? 0, learnedMemory.get(variant.id) ?? 0);
  const nodeUsable = (id) => {
    const node = nodes.get(id);
    return Boolean(node?.joined && node.available && !node.cordoned && node.hungUntil <= now);
  };
  const capacity = (id) => {
    const domain = list(nodes.get(id)?.spec.memoryDomains)[0];
    return num(domain?.capacityGb) ?? 0;
  };
  const budget = (id) =>
    memoryBudgetGb({
      totalMemoryGb: capacity(id),
      maxMemoryUtilization: num(nodes.get(id)?.spec.maxMemoryUtilization) ?? num(policy.maxMemoryUtilization),
      reserveMemoryGb: num(policy.reserveGb) ?? 8
    });
  // Admission's host check keeps this much free after a load. Legacy admission
  // kept only the reserve, below the guard's margin, so it could admit loads
  // the guard was certain to abort.
  const hostReserve = (id) => {
    const reserve = num(policy.reserveGb) ?? 8;
    if (scenario.legacyAdmission === true || memoryGuard.enabled === false) return reserve;
    return Math.max(reserve, capacity(id) * (1 - guardUtilization));
  };
  const admissionLimit = (id) => Math.min(budget(id), capacity(id) - osGb - hostReserve(id));
  const lanesOn = (id) => [...lanes.values()].filter((lane) => lane.nodes.includes(id));
  const usedTruth = (id) => lanesOn(id).reduce((sum, lane) => sum + lane.memoryGb, 0);
  const laneModels = (variant, laneNodes) =>
    new Set(
      variants
        .filter(
          (other) =>
            other.id === variant.id ||
            (variant.runtime &&
              other.runtime === variant.runtime &&
              list(other.nodes).join('+') === laneNodes.join('+'))
        )
        .map((other) => other.gatewayModel)
    );
  const tierOf = (lane) => residency[lane.variant.runtime] ?? 'auto';

  // --- lanes -----------------------------------------------------------------
  function newLane(variant, laneNodes, { state, reason }) {
    const sim = truth(variant);
    return {
      key: placementKey(variant, laneNodes),
      variant,
      model: variant.gatewayModel,
      models: laneModels(variant, laneNodes),
      nodes: laneNodes,
      memoryGb: memoryTruth(variant),
      state,
      maxSequences:
        num(sim.maxSequences) ?? num(variant.requirements?.maxSequences) ?? (variant.kind === 'chat' ? 4 : 1),
      active: new Set(),
      queue: [],
      waiters: [],
      onReady: [],
      onRemoved: [],
      lastUsedAt: now,
      reason
    };
  }

  function serveNext(lane) {
    while (lane.state !== 'loading' && lane.queue.length && lane.active.size < lane.maxSequences) {
      const request = lane.queue.shift();
      if (request.done) continue;
      begin(lane, request);
    }
    if (lane.state === 'draining' && !lane.active.size && !lane.queue.length) removeLane(lane, 'drained');
  }

  function begin(lane, request) {
    const sim = truth(lane.variant);
    const performance = lane.variant.performance ?? {};
    const ttft = num(sim.ttftMs) ?? num(performance.ttftMs);
    const tps = num(sim.decodeTps) ?? num(performance.decodeTps);
    let ttftMs;
    let totalMs;
    if (ttft != null && tps > 0) {
      const penalty = num(sim.concurrencyPenalty) ?? 0.15;
      const perSeq = tps / (1 + penalty * lane.active.size);
      ttftMs = ttft;
      totalMs = ttft + (Math.max(0, (request.outputTokens ?? 256) - 1) * 1000) / perSeq;
    } else {
      totalMs = num(sim.durationMs) ?? num(performance.durationMs) ?? 1000;
      ttftMs = totalMs;
    }
    lane.active.add(request);
    lane.lastUsedAt = now;
    request.lane = lane;
    request.started = true;
    request.serviceTtftMs = ttftMs;
    const startedAt = now;
    queue.push(now + totalMs, () => {
      if (request.done || !lane.active.has(request)) return;
      lane.active.delete(request);
      lane.lastUsedAt = now;
      complete(request, { ttftMs: startedAt - request.arrival + ttftMs, model: lane.model ?? request.model, lane });
      serveNext(lane);
    });
  }

  function removeLane(lane, reason) {
    if (lane.removed) return;
    lane.removed = true;
    if (lanes.get(lane.key) === lane) lanes.delete(lane.key);
    report.lanes.stops += reason === 'evicted' || reason === 'drained' || reason === 'stopped' ? 1 : 0;
    timeline('lane-stop', { lane: lane.key, reason });
    for (const resolve of lane.onRemoved.splice(0)) resolve();
  }

  function killLane(lane, reason) {
    const active = [...lane.active];
    const pending = [...lane.queue, ...lane.waiters];
    lane.active.clear();
    lane.queue = [];
    lane.waiters = [];
    // In-flight requests fail; requests not started yet fail over to another member.
    for (const request of active) fail(request, reason);
    for (const request of pending) dispatch(request, { avoid: lane.key });
    for (const { reject } of lane.onReady.splice(0)) reject(new Error(reason));
    removeLane(lane, reason);
  }

  // Per-node admission: the estimate must fit next to what is resident now,
  // evicting idle on-demand lanes first, then idle preferred lanes. Keep-warm
  // lanes, loading lanes and busy lanes are never evicted.
  function admit(variant, laneNodes, { evict = true, protect = 0 } = {}) {
    const need = memoryEstimate(variant);
    const evictions = [];
    for (const id of laneNodes) {
      let used =
        usedTruth(id) - evictions.filter((lane) => lane.nodes.includes(id)).reduce((s, l) => s + l.memoryGb, 0);
      if (used + need <= admissionLimit(id)) continue;
      if (!evict) return null;
      const idle = lanesOn(id)
        .filter(
          (lane) => !evictions.includes(lane) && lane.state === 'ready' && !lane.active.size && !lane.queue.length
        )
        .filter((lane) => RESIDENCY_RANK[tierOf(lane)] <= protect)
        .sort((a, b) => RESIDENCY_RANK[tierOf(a)] - RESIDENCY_RANK[tierOf(b)] || a.lastUsedAt - b.lastUsedAt);
      for (const lane of idle) {
        if (used + need <= admissionLimit(id)) break;
        evictions.push(lane);
        used -= lane.memoryGb;
      }
      if (used + need > admissionLimit(id)) return null;
    }
    return evictions;
  }

  function startLane(variant, laneNodes, { reason, protect = 1, fetch = true, background = false } = {}) {
    const key = placementKey(variant, laneNodes);
    const existing = lanes.get(key);
    // A lane being retired is not restarted under it; requests go elsewhere.
    if (existing) return existing.state === 'draining' ? null : existing;
    if (!laneNodes.every(nodeUsable)) return null;
    // After a memory-safety abort LLooM refuses automatic restarts until a
    // manual start (runtime-manager memorySafetyFailures).
    const manual = reason === 'operator';
    if (latched.has(variant.id) && !manual) return null;
    latched.delete(variant.id);
    const evictions = admit(variant, laneNodes, { protect });
    if (!evictions) {
      // The residency reconciler retries every 30 s; only count refusals someone waits on.
      if (!background) {
        report.lanes.admissionRefusals += 1;
        timeline('admission-refused', { lane: key, reason });
      }
      return null;
    }
    for (const lane of evictions) {
      report.lanes.evictions += 1;
      removeLane(lane, 'evicted');
    }
    const sim = truth(variant);
    const memoryGb = memoryTruth(variant);
    let seconds = num(sim.loadSeconds) ?? num(variant.loadSeconds) ?? 30 + memoryGb * 2;
    const recipeId = variant.requirements?.recipeId;
    if (fetch && recipeId) {
      for (const id of laneNodes) {
        if (!nodes.get(id).weights.has(recipeId)) {
          const diskGb = num(variant.requirements?.diskGb) ?? memoryGb;
          seconds += (diskGb * 1024) / (num(nodes.get(id).spec.fetchMBps) ?? num(policy.fetchMBps) ?? 100);
          nodes.get(id).weights.add(recipeId);
        }
      }
    }
    const lane = newLane(variant, laneNodes, { state: 'loading', reason });
    lanes.set(key, lane);
    report.lanes.loads += 1;
    report.lanes.loadGb += memoryGb * laneNodes.length;
    timeline('lane-load', { lane: key, reason, seconds: Math.round(seconds) });
    // The memory safety guard watches managed loads and aborts one that pushes
    // the host past its limit, before the node can hang.
    const guarded = variant.managed !== false && memoryGuard.enabled !== false;
    const overGuard = laneNodes.find((id) => usedTruth(id) + osGb > capacity(id) * guardUtilization);
    if (guarded && overGuard) {
      // The load had taken this much when host use crossed the ceiling: a
      // lower bound on its footprint, which the catalog learns.
      const consumedGb = Math.max(0, capacity(overGuard) * guardUtilization - (usedTruth(overGuard) - memoryGb + osGb));
      queue.push(now + seconds * 500, () => {
        if (lanes.get(key) !== lane || lane.state !== 'loading') return;
        report.lanes.guardAborts += 1;
        report.lanes.startFailures += 1;
        latched.add(variant.id);
        learnedMemory.set(variant.id, Math.max(learnedMemory.get(variant.id) ?? 0, round(consumedGb, 1)));
        timeline('memory-guard-abort', { lane: key, node: overGuard, usedGb: round(usedTruth(overGuard) + osGb, 1) });
        killLane(lane, 'memory safety abort');
      });
    } else {
      for (const id of laneNodes) checkMemory(id, key);
    }
    queue.push(now + seconds * 1000, () => {
      if (lanes.get(key) !== lane || lane.state !== 'loading') return;
      const failures = list(sim.failsOn);
      const failRate = num(sim.startFailRate) ?? 0;
      if (failures.some((id) => laneNodes.includes(id)) || (failRate && random() < failRate)) {
        report.lanes.startFailures += 1;
        timeline('lane-failed', { lane: key });
        killLane(lane, 'start failed');
        return;
      }
      lane.state = 'ready';
      lane.lastUsedAt = now;
      // A ready lane's resident size is measured; the catalog learns it.
      learnedMemory.set(variant.id, Math.max(learnedMemory.get(variant.id) ?? 0, lane.memoryGb));
      for (const { resolve } of lane.onReady.splice(0)) resolve(lane);
      const waiters = lane.waiters.splice(0);
      for (const request of waiters) if (!request.done) lane.queue.push(request);
      serveNext(lane);
    });
    return lane;
  }

  function checkMemory(id, cause) {
    const used = usedTruth(id);
    if (used + osGb <= capacity(id)) return;
    report.safety.memoryViolations.push({
      atMinutes: round(now / MINUTE, 2),
      node: id,
      usedGb: round(used, 1),
      capacityGb: capacity(id),
      cause
    });
    report.safety.nodeHangs += 1;
    timeline('memory-violation', { node: id, usedGb: round(used, 1) });
    hangNode(id);
  }

  function hangNode(id) {
    const node = nodes.get(id);
    node.hungUntil = now + hangMs;
    for (const lane of lanesOn(id)) killLane(lane, `node ${id} down`);
    queue.push(node.hungUntil, () => timeline('node-recovered', { node: id }));
  }

  // --- requests --------------------------------------------------------------
  function complete(request, { ttftMs, model, lane = null, external = false }) {
    if (request.done) return;
    request.done = true;
    const workload = request.workload;
    const stats = report.workloads[workload.id];
    report.requests.served += 1;
    stats.served += 1;
    if (external) {
      report.requests.external += 1;
      stats.external += 1;
    }
    const slo = num(workload.slo?.ttftMs) ?? num(workload.slo?.durationMs);
    if (slo == null || ttftMs <= slo) {
      report.requests.sloMet += 1;
      stats.sloMet += 1;
    }
    ttfts[workload.id].push(ttftMs);
    if (lane) {
      const perf = served.get(model) ?? [];
      perf.push(request.serviceTtftMs ?? ttftMs);
      if (perf.length > 50) perf.shift();
      served.set(model, perf);
    }
  }

  function fail(request, reason) {
    if (request.done) return;
    request.done = true;
    report.requests.failed += 1;
    report.workloads[request.workload.id].failed += 1;
    const reasons = report.workloads[request.workload.id].failReasons;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  function readyLane(model, avoid) {
    return [...lanes.values()]
      .filter((lane) => lane.state === 'ready' && lane.models.has(model) && lane.key !== avoid)
      .sort(
        (a, b) => (a.active.size + a.queue.length) / a.maxSequences - (b.active.size + b.queue.length) / b.maxSequences
      )[0];
  }

  function knownPlacement(variant) {
    if (list(variant.nodes).length) return variant.nodes;
    return flexiblePlacements.get(variant.id) ?? null;
  }

  function dispatch(request, { avoid = null } = {}) {
    if (request.done) return;
    const workload = request.workload;
    const order = [...new Set([routes[workload.id], ...list(workload.candidates)].filter(Boolean))];
    for (const model of order) {
      const lane = readyLane(model, avoid);
      if (lane) {
        request.model = model;
        lane.queue.push(request);
        serveNext(lane);
        return;
      }
    }
    // The routed member is loading: wait for it.
    const loading = [...lanes.values()].find(
      (lane) => lane.state === 'loading' && lane.models.has(routes[workload.id]) && lane.key !== avoid
    );
    if (loading) {
      request.coldWait = true;
      loading.waiters.push(request);
      return;
    }
    for (const model of order) {
      for (const variant of variantsForModel(model)) {
        if (variant.external) {
          const performance = variant.performance ?? {};
          const ttft = num(performance.ttftMs) ?? num(performance.durationMs) ?? 1000;
          request.started = true;
          queue.push(now + ttft, () => complete(request, { ttftMs: now - request.arrival, model, external: true }));
          return;
        }
        if (variant.managed === false) continue;
        const laneNodes = knownPlacement(variant);
        if (!laneNodes) continue;
        const lane = startLane(variant, laneNodes, { reason: `demand:${workload.id}`, protect: 1 });
        if (lane && lane.key !== avoid) {
          request.coldWait = true;
          report.requests.coldWaits += 1;
          if (lane.state === 'ready') lane.queue.push(request);
          else lane.waiters.push(request);
          serveNext(lane);
          return;
        }
      }
    }
    fail(request, 'no member available');
  }

  function scheduleArrival(workload) {
    const maxRate = maxDemandRate(workload);
    if (!(maxRate > 0)) return;
    let at = now;
    for (;;) {
      at += (-Math.log(1 - random()) / maxRate) * HOUR;
      if (at >= durationMs) return;
      if (random() * maxRate <= demandRate(workload, at)) break;
    }
    queue.push(at, () => {
      const request = { workload, arrival: now, outputTokens: num(workload.outputTokens) ?? 256 };
      report.requests.total += 1;
      report.workloads[workload.id].requests += 1;
      arrivals.get(workload.id).push(now);
      queue.push(now + queueTimeoutMs, () => {
        if (!request.done && !request.started) {
          fail(request, 'queue timeout');
        }
      });
      dispatch(request);
      scheduleArrival(workload);
    });
  }

  // --- what LLooM already does: keep-warm and preferred restoration -----------
  function residencyReconcile() {
    for (const variant of variants) {
      if (variant.managed === false || variant.external || !variant.runtime) continue;
      const tier = residency[variant.runtime] ?? 'auto';
      if (tier === 'auto') continue;
      const laneNodes = knownPlacement(variant);
      if (!laneNodes || !laneNodes.every(nodeUsable)) continue;
      const key = placementKey(variant, laneNodes);
      if (lanes.has(key)) continue;
      // Keep-warm may evict on-demand and preferred lanes; preferred only on-demand ones.
      startLane(variant, laneNodes, {
        reason: `residency:${tier}`,
        protect: tier === 'always' ? 1 : 0,
        background: true
      });
    }
  }

  // --- the controller's view and hands ------------------------------------------
  function observedVariants() {
    return variants.map((variant) => {
      const samples = served.get(variant.gatewayModel) ?? [];
      const learned = learnedMemory.get(variant.id);
      let next = variant;
      if (learned != null && learned > (num(variant.requirements?.memoryGbPerNode) ?? 0)) {
        next = { ...next, requirements: { ...next.requirements, memoryGbPerNode: learned } };
      }
      if (samples.length >= 5 && !variant.external && num(variant.performance?.ttftMs) != null) {
        const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        next = { ...next, performance: { ...next.performance, ttftMs: Math.round(mean), source: 'observed' } };
      }
      if (latched.has(variant.id)) {
        next = {
          ...next,
          excludeNodes: knownPlacement(variant) ?? [],
          excludeReason: 'memory safety abort; start it by hand to retry'
        };
      }
      const { sim: _sim, ...plannerVariant } = next;
      return plannerVariant;
    });
  }

  function observedWorkloads() {
    const alwaysAt = num(policy.alwaysAtRequestsPerHour) ?? 1;
    const preferredAt = num(policy.preferredAtRequestsPerHour) ?? 0.125;
    return workloads.map((workload) => {
      const times = arrivals.get(workload.id);
      while (times.length && times[0] < now - demandWindowMs) times.shift();
      const prior = num(workload.demandPerHour) ?? num(workload.demand?.perHour) ?? 0;
      const priorShare = Math.max(0, demandWindowMs - now) / demandWindowMs;
      const demandPerHour = round(prior * priorShare + times.length / (demandWindowMs / HOUR), 3);
      let tier = workload.residency;
      if (tier == null || tier === 'demand') {
        tier = demandPerHour >= alwaysAt ? 'always' : demandPerHour >= preferredAt ? 'preferred' : 'auto';
      }
      const { demand: _demand, ...plannerWorkload } = workload;
      return { ...plannerWorkload, residency: tier, demandPerHour };
    });
  }

  function observe() {
    const members = memberById();
    const plannerNodes = [...nodes.values()]
      .filter((node) =>
        membership ? members.has(node.spec.id) && members.get(node.spec.id).state !== 'left' : node.joined
      )
      .map((node) => ({
        ...node.spec,
        available: membership ? members.get(node.spec.id).state !== 'lost' : node.available && node.hungUntil <= now,
        cordoned: membership ? members.get(node.spec.id).cordoned || members.get(node.spec.id).draining : node.cordoned,
        weights: [...node.weights],
        images: [...node.images]
      }));
    const placements = [...lanes.values()]
      .filter((lane) => lane.state !== 'draining')
      .map((lane) => ({
        key: lane.key,
        models: [...lane.models],
        runtime: lane.variant.runtime ?? null,
        nodes: lane.nodes,
        memoryGbPerNode: lane.memoryGb,
        managed: lane.variant.managed !== false,
        state: lane.state === 'loading' ? 'starting' : 'ready'
      }));
    return {
      nodes: plannerNodes,
      variants: observedVariants(),
      workloads: observedWorkloads(),
      pins: scenario.pins ?? {},
      policy,
      current: {
        routes: { ...routes },
        residency: { ...residency },
        running: placements.map((placement) => placement.key),
        placements
      }
    };
  }

  const waitFor = (fn) => new Promise((resolve, reject) => fn(resolve, reject));
  const variantForPlacement = (key) =>
    variantById.get(key) ?? variants.find((variant) => key.startsWith(`${variant.id}@`));

  const actuator = {
    prefetch: (step) =>
      waitFor((resolve) => {
        const variant = variantForPlacement(step.placement);
        const recipeId = variant?.requirements?.recipeId;
        let seconds = 0;
        for (const id of step.nodes ?? []) {
          if (recipeId && !nodes.get(id)?.weights.has(recipeId)) {
            const diskGb = num(variant.requirements?.diskGb) ?? memoryTruth(variant);
            seconds = Math.max(
              seconds,
              (diskGb * 1024) / (num(nodes.get(id).spec.fetchMBps) ?? num(policy.fetchMBps) ?? 100)
            );
          }
        }
        queue.push(now + seconds * 1000, () => {
          for (const id of step.nodes ?? []) if (recipeId) nodes.get(id)?.weights.add(recipeId);
          resolve();
        });
      }),
    start: (step) =>
      waitFor((resolve, reject) => {
        const variant = variantForPlacement(step.placement);
        if (!variant) return reject(new Error(`unknown placement ${step.placement}`));
        if (!list(variant.nodes).length) flexiblePlacements.set(variant.id, step.nodes);
        const lane = startLane(variant, step.nodes, { reason: 'controller', protect: 0 });
        if (!lane) return reject(new Error('admission refused'));
        if (lane.state === 'ready') return resolve();
        lane.onReady.push({ resolve: () => resolve(), reject });
      }),
    stop: (step) =>
      waitFor((resolve) => {
        const lane = lanes.get(step.placement);
        if (!lane) return resolve();
        lane.onRemoved.push(resolve);
        if (lane.state === 'loading') return killLane(lane, 'stopped');
        lane.state = 'draining';
        timeline('lane-drain', { lane: lane.key });
        // Requests already waiting on this lane go back through routing.
        const requeue = lane.queue.splice(0);
        for (const request of requeue) dispatch(request, { avoid: lane.key });
        serveNext(lane);
        queue.push(now + drainTimeoutMs, () => {
          if (lanes.get(lane.key) === lane) killLane(lane, 'drain timeout');
        });
      }),
    route: async (step) => {
      routes[step.alias] = step.to;
      timeline(step.type, { alias: step.alias, to: step.to });
    },
    residency: async (step) => {
      residency[step.runtime] = step.to;
    },
    manual: (step) =>
      waitFor((resolve, reject) => {
        timeline('manual-requested', { action: step.type, lane: step.placement });
        const delay = num(operator.manualDelayMinutes);
        if (delay == null) {
          queue.push(now + (num(operator.manualTimeoutMinutes) ?? 60) * MINUTE, () =>
            reject(new Error('operator did not act'))
          );
          return;
        }
        queue.push(now + delay * MINUTE, () => {
          if (step.type === 'manual-stop') {
            const lane = lanes.get(step.placement);
            if (lane) {
              lane.onRemoved.push(resolve);
              killLane(lane, 'stopped');
            } else resolve();
            return;
          }
          const variant = variantForPlacement(step.placement);
          const lane = variant && startLane(variant, step.nodes, { reason: 'operator', protect: 0 });
          if (!lane) return reject(new Error('operator start refused'));
          if (lane.state === 'ready') resolve();
          else lane.onReady.push({ resolve: () => resolve(), reject });
        });
      })
  };

  const controller =
    mode === 'off'
      ? null
      : createPoolController({
          observe: async () => observe(),
          actuator,
          now: () => now,
          timer: (ms) => new Promise((resolve) => queue.push(now + ms, resolve)),
          policy: {
            ...(scenario.controller ?? {}),
            ...controllerOverrides,
            mode: mode === 'advise' ? 'advise' : 'auto'
          },
          onEvent: (entry) => {
            // Each change in why the controller is holding, so a run explains itself.
            if ((entry.action === 'hold' && entry.reason !== 'no changes') || entry.action === 'busy') {
              const reason = (entry.reason ?? 'still applying the last change').replace(/\(\d+\/\d+\)|[\d.]+%/g, '#');
              const holds = report.controller.holds;
              if (holds.at(-1)?.reason !== reason && holds.length < 200) {
                holds.push({ atMinutes: round(entry.at / MINUTE, 2), reason });
              }
            }
            if (entry.action === 'apply' || entry.action === 'propose') {
              if (entry.action === 'propose') report.controller.proposals += 1;
              else report.controller.applies += 1;
              if (entry.urgent && entry.action === 'apply') report.controller.urgentApplies += 1;
              report.controller.interruptions += entry.interruptions.length;
              report.controller.firstProposal ??= round(entry.at / MINUTE, 2);
              if (report.controller.decisions.length < 100) {
                report.controller.decisions.push({
                  atMinutes: round(entry.at / MINUTE, 2),
                  action: entry.action,
                  reason: entry.reason,
                  urgent: entry.urgent,
                  steps: entry.steps,
                  interruptions: entry.interruptions,
                  blocked: entry.blocked
                });
              }
              timeline(entry.action, {
                reason: entry.reason,
                urgent: entry.urgent,
                steps: entry.steps.map((step) => step.id),
                ...(entry.blocked.length ? { blocked: entry.blocked } : {})
              });
            } else if (entry.action === 'step') {
              if (entry.status === 'done') report.controller.steps += 1;
              if (entry.status === 'failed') {
                report.controller.stepFailures += 1;
                timeline('step-failed', { step: entry.step, error: entry.error });
              }
            }
          }
        });

  // --- initial state and scenario events ---------------------------------------
  for (const workload of workloads) {
    report.workloads[workload.id] = { requests: 0, served: 0, failed: 0, external: 0, sloMet: 0, failReasons: {} };
    ttfts[workload.id] = [];
  }
  for (const entry of list(scenario.initial?.running)) {
    const variant = variantById.get(typeof entry === 'string' ? entry : entry.variant);
    if (!variant) throw new Error(`initial.running: unknown variant ${JSON.stringify(entry)}`);
    const laneNodes = list(variant.nodes).length ? variant.nodes : list(entry.nodes);
    if (!list(variant.nodes).length) flexiblePlacements.set(variant.id, laneNodes);
    const lane = newLane(variant, laneNodes, { state: 'ready', reason: 'initial' });
    lanes.set(lane.key, lane);
    learnedMemory.set(variant.id, Math.max(learnedMemory.get(variant.id) ?? 0, lane.memoryGb));
  }

  const applyEvent = (event) => {
    const ids = list(event.nodes ?? (event.node ? [event.node] : []));
    timeline(`event:${event.type}`, {
      ...(ids.length ? { nodes: ids } : {}),
      ...(event.note ? { note: event.note } : {})
    });
    switch (event.type) {
      case 'cordon':
        for (const id of ids) {
          nodes.get(id).cordoned = true;
          membership?.cordon(id, { reason: event.note });
        }
        break;
      case 'uncordon':
        for (const id of ids) {
          nodes.get(id).cordoned = false;
          membership?.uncordon(id);
        }
        break;
      case 'partition':
        for (const id of ids) nodes.get(id).partitionedUntil = now + (num(event.minutes) ?? 1) * MINUTE;
        break;
      case 'fail':
        for (const id of ids) {
          nodes.get(id).available = false;
          for (const lane of lanesOn(id)) killLane(lane, `node ${id} failed`);
        }
        break;
      case 'recover':
        for (const id of ids) nodes.get(id).available = true;
        break;
      case 'join':
        for (const id of ids) {
          nodes.get(id).joined = true;
          enroll(id);
        }
        break;
      case 'leave':
        for (const id of ids) {
          nodes.get(id).joined = false;
          if (membership) {
            membership.leave(id);
            nodeSecrets.delete(id);
          }
          for (const lane of lanesOn(id)) killLane(lane, `node ${id} left`);
        }
        break;
      case 'stop-lane': {
        const lane = lanes.get(event.placement);
        if (lane) killLane(lane, 'operator stop');
        break;
      }
      case 'start-lane': {
        const variant = variantForPlacement(event.placement);
        if (variant)
          startLane(variant, list(variant.nodes).length ? variant.nodes : list(event.nodes), {
            reason: 'operator',
            protect: 0
          });
        break;
      }
      case 'apply-profile':
        Object.assign(routes, event.routes ?? {});
        Object.assign(residency, event.residency ?? {});
        break;
      default:
        throw new Error(`unknown scenario event ${event.type}`);
    }
  };

  // `modes` limits an event to some runs, e.g. an operator's manual fleet switch
  // that only happens when there is no pool controller. In advise mode nothing
  // is applied for the operator, so their manual (`off`) events still happen.
  const eventMode = mode === 'advise' ? 'off' : mode;
  for (const event of list(scenario.events)) {
    if (event.modes && !event.modes.includes(eventMode)) continue;
    queue.push(event.atHours * HOUR, () => applyEvent(event));
  }
  for (const node of nodes.values()) {
    if (node.joined) enroll(node.spec.id);
    if (node.spec.joinAtHours != null)
      queue.push(node.spec.joinAtHours * HOUR, () => applyEvent({ type: 'join', nodes: [node.spec.id] }));
  }
  for (const workload of workloads) scheduleArrival(workload);
  for (let at = 0; at < durationMs; at += 30000) queue.push(at, residencyReconcile);
  if (controller) {
    for (let at = tickMs; at < durationMs; at += tickMs) {
      queue.push(at, async () => {
        report.controller.ticks += 1;
        await controller.tick();
      });
    }
  }

  // --- run ---------------------------------------------------------------------
  while (queue.size) {
    const item = queue.pop();
    if (item.at > durationMs) break;
    now = item.at;
    await item.fn();
    await flush();
  }

  // --- summary -------------------------------------------------------------------
  const all = Object.values(ttfts).flat();
  report.requests.sloAttainment = report.requests.total ? round(report.requests.sloMet / report.requests.total) : 1;
  report.requests.ttftP50Ms = Math.round(percentile(all, 50) ?? 0);
  report.requests.ttftP95Ms = Math.round(percentile(all, 95) ?? 0);
  for (const [id, stats] of Object.entries(report.workloads)) {
    stats.sloAttainment = stats.requests ? round(stats.sloMet / stats.requests) : 1;
    stats.ttftP50Ms = Math.round(percentile(ttfts[id], 50) ?? 0);
    stats.ttftP95Ms = Math.round(percentile(ttfts[id], 95) ?? 0);
  }
  report.lanes.loadGb = round(report.lanes.loadGb, 1);
  report.final = {
    routes: { ...routes },
    residency: { ...residency },
    lanes: [...lanes.values()].map((lane) => lane.key).sort()
  };
  report.checks = checkExpectations(report, scenario.expect?.[mode] ?? scenario.expect?.all ?? {});
  report.ok = report.checks.every((check) => check.ok);
  return report;
}

function pathValue(object, path) {
  return String(path)
    .split('.')
    .reduce((value, key) => (value == null ? undefined : value[key]), object);
}

// expect: { "safety.memoryViolations.length": { "max": 0 }, "final.routes.chat": { "equals": "m" } }
export function checkExpectations(report, expect = {}) {
  return Object.entries(expect).map(([path, rule]) => {
    const value = pathValue(report, path);
    const failures = [];
    if (rule.min != null && !(value >= rule.min)) failures.push(`>= ${rule.min}`);
    if (rule.max != null && !(value <= rule.max)) failures.push(`<= ${rule.max}`);
    if (Object.hasOwn(rule, 'equals') && JSON.stringify(value) !== JSON.stringify(rule.equals)) {
      failures.push(`== ${JSON.stringify(rule.equals)}`);
    }
    if (rule.includes != null && !(Array.isArray(value) && value.includes(rule.includes))) {
      failures.push(`includes ${JSON.stringify(rule.includes)}`);
    }
    return { path, value, ok: failures.length === 0, ...(failures.length ? { expected: failures.join(', ') } : {}) };
  });
}

export async function comparePoolSimulation(scenario, { modes = ['off', 'auto'], controller } = {}) {
  const reports = {};
  for (const mode of modes) reports[mode] = await runPoolSimulation(scenario, { mode, controller });
  return reports;
}
