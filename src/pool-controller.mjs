// Pool controller: the loop that plans the pool, decides whether a plan is
// worth acting on, and (in auto mode) reconciles the pool to it.
//
//   off     never plans
//   advise  plans and records proposals; a person applies them
//   auto    applies proposals through the actuator
//
// Moving a model is expensive (minutes of load time), so a non-urgent change
// must be stable across `confirmTicks` consecutive plans, must clear a minimum
// gain, waits out a cooldown after the last change, and stays inside an
// hourly load budget. A plan that restores coverage (a node went away, a lane
// died) is urgent and skips those guards. A lane that fails to start is
// excluded from planning for `failureBackoffMs`.

import { planPool } from './pool-planner.mjs';
import { executeReconcile, planReconcile } from './pool-reconciler.mjs';

export const POOL_CONTROLLER_MODES = Object.freeze(['off', 'advise', 'auto']);

export const DEFAULT_CONTROLLER_POLICY = Object.freeze({
  mode: 'advise',
  confirmTicks: 2,
  cooldownMs: 15 * 60 * 1000,
  // Residency-only changes follow noisy demand; they need a longer, steadier signal.
  maintenanceConfirmTicks: 10,
  maintenanceCooldownMs: 60 * 60 * 1000,
  minGain: 0.1,
  maxLoadGbPerHour: 400,
  failureBackoffMs: 30 * 60 * 1000,
  concurrency: 4,
  historyLimit: 50
});

function num(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeControllerPolicy(policy = {}) {
  const merged = { ...DEFAULT_CONTROLLER_POLICY };
  for (const [key, value] of Object.entries(policy ?? {})) {
    if (value === undefined || !(key in DEFAULT_CONTROLLER_POLICY)) continue;
    if (key === 'mode') merged.mode = POOL_CONTROLLER_MODES.includes(value) ? value : DEFAULT_CONTROLLER_POLICY.mode;
    else merged[key] = num(value) ?? merged[key];
  }
  return merged;
}

// What the plan changes, independent of scores: two plans with the same
// signature would make the same moves.
export function planSignature(plan) {
  const routes = Object.entries(plan.routes ?? {})
    .map(([alias, route]) => `${alias}=${route.model}`)
    .sort();
  const placements = (plan.placements ?? [])
    .filter((placement) => !placement.external && placement.residency !== 'auto')
    .map((placement) => `${placement.placement}:${placement.residency}`)
    .sort();
  return JSON.stringify([routes, placements]);
}

function excludeFailures(variants, failures, now) {
  return variants.map((variant) => {
    const excluded = [...failures.entries()]
      .filter(([, entry]) => entry.until > now && entry.variant === variant.id)
      .flatMap(([, entry]) => entry.nodes);
    if (!excluded.length) return variant;
    if ((variant.nodes ?? []).length) return { ...variant, excludeNodes: variant.nodes };
    return { ...variant, excludeNodes: [...new Set([...(variant.excludeNodes ?? []), ...excluded])] };
  });
}

// The score of keeping today's routes: the plan with every viable current
// route pinned. If keeping them leaves a required workload uncovered, the new
// plan is urgent.
function stayPlan(inputs) {
  const routes = { ...(inputs.current?.routes ?? {}) };
  const viable = Object.fromEntries(
    Object.entries(routes).filter(([alias]) => (inputs.workloads ?? []).some((workload) => workload.id === alias))
  );
  return planPool({ ...inputs, pins: { ...inputs.pins, routes: { ...viable, ...(inputs.pins?.routes ?? {}) } } });
}

export function decide({ plan, stay, reconcile, state, policy, now }) {
  if (reconcile.empty) return { act: false, reason: 'no changes' };
  const restoresCoverage =
    plan.score.uncovered < stay.score.uncovered ||
    (stay.pinViolations?.length ?? 0) > (plan.pinViolations?.length ?? 0);
  if (restoresCoverage) return { act: true, urgent: true, reason: 'restores coverage' };
  if (plan.score.uncovered > stay.score.uncovered) return { act: false, reason: 'plan covers less than today' };
  const quality = plan.score.sloMisses < stay.score.sloMisses || plan.score.external < stay.score.external;
  const gain = stay.score.cost > 0 ? (stay.score.cost - plan.score.cost) / stay.score.cost : 0;
  // Without route moves the plan only follows demand (residency, warm lanes,
  // releases); a longer stable signal and cooldown are its hysteresis, not a cost gain.
  const maintenance =
    !quality && !reconcile.steps.some((step) => step.type === 'route' || step.type === 'interim-route');
  const confirmTicks = maintenance ? policy.maintenanceConfirmTicks : policy.confirmTicks;
  if (state.stableTicks < confirmTicks) {
    return { act: false, reason: `waiting for a stable plan (${state.stableTicks}/${confirmTicks})` };
  }
  if (!quality && !maintenance && gain < policy.minGain) {
    return { act: false, reason: `gain ${(gain * 100).toFixed(1)}% below ${(policy.minGain * 100).toFixed(0)}%` };
  }
  const cooldownMs = maintenance ? policy.maintenanceCooldownMs : policy.cooldownMs;
  if (state.lastActionAt != null && now - state.lastActionAt < cooldownMs) {
    return { act: false, reason: 'cooldown after the last change' };
  }
  const loadGb = reconcile.steps
    .filter((step) => step.type === 'start')
    .reduce((sum, step) => sum + (num(step.memoryGbPerNode) ?? 0) * (step.nodes?.length ?? 1), 0);
  const recentGb = state.loads.filter((entry) => now - entry.at < 3600000).reduce((sum, entry) => sum + entry.gb, 0);
  if (recentGb + loadGb > policy.maxLoadGbPerHour) {
    return {
      act: false,
      reason: `hourly load budget (${Math.round(recentGb + loadGb)} GB > ${policy.maxLoadGbPerHour} GB)`
    };
  }
  const reason = quality
    ? 'improves SLOs or local coverage'
    : maintenance
      ? 'residency follows demand'
      : `gain ${(gain * 100).toFixed(1)}%`;
  return { act: true, urgent: false, reason };
}

/**
 * timer(ms): optional promise-returning delay for step timeouts (a simulated
 *   clock passes its own).
 * observe(): Promise<{ nodes, variants, workloads, pins, policy, current }>
 *   current = { routes, residency, running: [placement keys],
 *               placements: [{ key, models, runtime, nodes, memoryGbPerNode, managed, state }],
 *               missingWeights: { placementKey: true } }
 * actuator: see executeReconcile().
 */
export function createPoolController({
  observe,
  actuator,
  policy = {},
  now = Date.now,
  timer,
  onEvent = () => {}
} = {}) {
  const controllerPolicy = normalizeControllerPolicy(policy);
  const state = {
    signature: null,
    stableTicks: 0,
    lastActionAt: null,
    loads: [],
    failures: new Map(),
    executing: null,
    history: []
  };
  const record = (entry) => {
    state.history.push(entry);
    if (state.history.length > controllerPolicy.historyLimit) state.history.shift();
    onEvent(entry);
    return entry;
  };

  async function tick() {
    const at = now();
    if (controllerPolicy.mode === 'off') return record({ at, action: 'off' });
    if (state.executing) return record({ at, action: 'busy' });
    const observed = await observe();
    const inputs = { ...observed, variants: excludeFailures(observed.variants ?? [], state.failures, at) };
    const plan = planPool(inputs);
    const signature = planSignature(plan);
    state.stableTicks = signature === state.signature ? state.stableTicks + 1 : 1;
    state.signature = signature;
    const stay = stayPlan(inputs);
    const reconcile = planReconcile({
      plan,
      current: inputs.current,
      workloads: inputs.workloads,
      variants: inputs.variants,
      nodes: inputs.nodes
    });
    const decision = decide({ plan, stay, reconcile, state, policy: controllerPolicy, now: at });
    const entry = {
      at,
      action: decision.act ? (controllerPolicy.mode === 'auto' ? 'apply' : 'propose') : 'hold',
      reason: decision.reason,
      urgent: Boolean(decision.urgent),
      score: plan.score,
      stayScore: stay.score,
      steps: reconcile.steps,
      interruptions: reconcile.interruptions,
      blocked: reconcile.blocked,
      plan
    };
    if (!decision.act || controllerPolicy.mode !== 'auto') return record(entry);
    record(entry);
    state.lastActionAt = at;
    state.stableTicks = 0;
    for (const step of reconcile.steps.filter((candidate) => candidate.type === 'start')) {
      state.loads.push({ at, gb: (num(step.memoryGbPerNode) ?? 0) * (step.nodes?.length ?? 1) });
    }
    state.loads = state.loads.filter((load) => at - load.at < 3600000);
    state.executing = executeReconcile(reconcile.steps, actuator, {
      concurrency: controllerPolicy.concurrency,
      ...(timer ? { timer } : {}),
      onStep: ({ step, status, error }) => {
        onEvent({ at: now(), action: 'step', step: step.id, status, ...(error ? { error } : {}) });
        if (status === 'failed' && (step.type === 'start' || step.type === 'manual-start')) {
          const placement = plan.placements.find((entry) => entry.placement === step.placement);
          state.failures.set(step.placement, {
            variant: placement?.variant ?? step.placement,
            nodes: step.nodes ?? [],
            until: now() + controllerPolicy.failureBackoffMs
          });
        }
      }
    }).then((result) => {
      state.executing = null;
      record({ at: now(), action: 'applied', ok: result.ok, errors: result.errors });
      return result;
    });
    return entry;
  }

  return {
    policy: controllerPolicy,
    tick,
    get executing() {
      return state.executing;
    },
    history: () => [...state.history],
    failures: () => Object.fromEntries(state.failures)
  };
}
