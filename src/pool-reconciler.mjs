// Pool reconciler. Pure: turns a pool plan (pool-planner.mjs) and the observed
// state into ordered steps that move the pool to the plan without dropping a
// route:
//
//   prefetch weights -> start new lanes -> flip routes -> drain + stop old lanes
//
// A start that only fits once an old lane is gone is a swap: the old lane's
// aliases move to an interim member that is already serving (or are reported
// as interrupted), the old lane drains and stops, the new lane starts, and the
// aliases flip to it. Residency downgrades come before stops, so a keep-warm
// tier never restarts a lane that is being retired; upgrades come after starts.
//
// executeReconcile() runs the steps against an actuator. A step whose
// dependency failed is skipped, so a lane that fails to start never strands
// its aliases: the old lane keeps serving because its stop depended on the
// route flip, which depended on the start.

export const POOL_RECONCILE_VERSION = 1;

const RESIDENCY_RANK = { auto: 0, preferred: 1, always: 2 };

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== '') : [];
}

function num(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Weights live in unified memory, else the largest device domain; this mirrors
// the planner's accelerator domain and is the one that decides whether lanes fit.
function nodeBudgetGb(planNode) {
  const domains = list(planNode?.domains);
  const domain =
    domains.find((entry) => entry.kind === 'unified') ??
    [...domains].filter((entry) => entry.kind === 'device').sort((a, b) => b.budgetGb - a.budgetGb)[0] ??
    domains.find((entry) => entry.kind === 'system');
  return num(domain?.budgetGb) ?? Infinity;
}

function routeChanges(plan, current) {
  return Object.entries(plan.routes ?? {})
    .filter(([alias, route]) => (current.routes?.[alias] ?? null) !== route.model)
    .map(([alias, route]) => ({ alias, from: current.routes?.[alias] ?? null, to: route.model }));
}

/**
 * Order the work that moves `current` to `plan`.
 *
 * current = {
 *   placements: [{ key, models: [gatewayModel], runtime, nodes, memoryGbPerNode, managed, state }],
 *   routes: { alias: model }, residency: { runtime: tier }, missingWeights?: { placementKey: true }
 * }
 * workloads: planner workloads (for interim members during a swap).
 * variants, nodes: planner inputs; a start on a node whose inventory lacks the
 *   variant's recipe weights gets a prefetch step first.
 */
export function planReconcile({ plan, current = {}, workloads = [], variants = [], nodes = [] } = {}) {
  const steps = [];
  const interruptions = [];
  const blocked = [];
  const ids = new Map();
  const add = (step, after = []) => {
    const id = `${step.type}:${step.placement ?? step.alias ?? step.runtime}`;
    const unique = ids.has(id) ? `${id}#${ids.get(id) + 1}` : id;
    ids.set(id, (ids.get(id) ?? 0) + 1);
    steps.push({ id: unique, ...step, after: [...new Set(after.filter(Boolean))] });
    return unique;
  };

  const running = new Map(
    list(current.placements)
      .filter((placement) => placement.state !== 'stopping')
      .map((placement) => [placement.key, { ...placement, models: list(placement.models) }])
  );
  const planned = list(plan.placements).filter((placement) => !placement.external);
  const plannedKeys = new Set(planned.map((placement) => placement.placement));
  const plannedByModel = new Map();
  for (const placement of planned) {
    for (const model of placement.models) if (!plannedByModel.has(model)) plannedByModel.set(model, placement);
  }
  const externalModels = new Set([
    ...list(plan.placements)
      .filter((placement) => placement.external)
      .flatMap((placement) => placement.models),
    ...list(variants)
      .filter((variant) => variant.external)
      .map((variant) => variant.gatewayModel)
  ]);
  const budgets = new Map(Object.entries(plan.nodes ?? {}).map(([id, node]) => [id, nodeBudgetGb(node)]));
  const usage = new Map([...budgets.keys()].map((id) => [id, 0]));
  for (const placement of running.values()) {
    for (const node of placement.nodes) usage.set(node, (usage.get(node) ?? 0) + (num(placement.memoryGbPerNode) ?? 0));
  }

  // Where each model is (or will be) ready, and which step makes it ready.
  const readyStep = new Map();
  for (const placement of running.values()) {
    if (placement.state === 'ready' || placement.state == null) {
      for (const model of placement.models) readyStep.set(model, null);
    }
  }
  const releaseStep = new Map();
  const routes = { ...(current.routes ?? {}) };
  const routeStep = new Map();

  // Residency downgrades first: a lane leaving keep-warm must not be restarted
  // by the residency reconciler while it drains.
  const residencyDown = [];
  const residencyUp = [];
  for (const [runtime, tier] of Object.entries(plan.residency ?? {})) {
    const from = current.residency?.[runtime];
    if (from == null || from === tier) continue;
    (RESIDENCY_RANK[tier] < RESIDENCY_RANK[from] ? residencyDown : residencyUp).push({ runtime, from, to: tier });
  }
  const downgradeSteps = residencyDown
    .sort((a, b) => a.runtime.localeCompare(b.runtime))
    .map((change) => add({ type: 'residency', ...change }));

  const pendingStarts = planned
    .filter((placement) => placement.residency !== 'auto' && !running.has(placement.placement))
    .sort(
      (a, b) => RESIDENCY_RANK[b.residency] - RESIDENCY_RANK[a.residency] || a.placement.localeCompare(b.placement)
    );
  let pendingRoutes = routeChanges(plan, current).sort((a, b) => a.alias.localeCompare(b.alias));
  const startStep = new Map();
  const prefetchStep = new Map();
  const nodeWeights = new Map(list(nodes).map((node) => [node.id, new Set(list(node.weights))]));
  const missingWeights = (placement) => {
    if (current.missingWeights?.[placement.placement]) return true;
    const recipeId = list(variants).find((variant) => variant.id === placement.variant)?.requirements?.recipeId;
    return (
      Boolean(recipeId) && placement.nodes.some((node) => nodeWeights.has(node) && !nodeWeights.get(node).has(recipeId))
    );
  };
  for (const placement of pendingStarts) {
    if (missingWeights(placement)) {
      prefetchStep.set(
        placement.placement,
        add({ type: 'prefetch', placement: placement.placement, nodes: placement.nodes })
      );
    }
  }

  const aliasesOn = (placement) =>
    Object.entries(routes)
      .filter(([, model]) => placement.models.includes(model))
      .map(([alias]) => alias);
  const fits = (placement, freed = new Map()) =>
    placement.nodes.every(
      (node) =>
        (usage.get(node) ?? 0) - (freed.get(node) ?? 0) + (num(placement.memoryGbPerNode) ?? 0) <=
        (budgets.get(node) ?? Infinity) + 1e-9
    );
  const startAfter = (placement) => [
    prefetchStep.get(placement.placement),
    ...downgradeSteps,
    ...placement.nodes.flatMap((node) =>
      [...releaseStep.values()].filter((entry) => entry.nodes.includes(node)).map((entry) => entry.id)
    )
  ];

  const release = (placement, after = []) => {
    const id = add(
      {
        type: placement.managed === false ? 'manual-stop' : 'stop',
        placement: placement.key,
        nodes: placement.nodes,
        drain: true
      },
      [...after, ...downgradeSteps]
    );
    releaseStep.set(placement.key, { id, nodes: placement.nodes });
    for (const node of placement.nodes) usage.set(node, (usage.get(node) ?? 0) - (num(placement.memoryGbPerNode) ?? 0));
    for (const model of placement.models) {
      if (readyStep.get(model) === null) readyStep.delete(model);
    }
    running.delete(placement.key);
    return id;
  };

  const routeTo = (alias, to, type = 'route') => {
    const target = plannedByModel.get(to);
    const after = [readyStep.get(to), ...downgradeSteps];
    const id = add(
      { type, alias, from: routes[alias] ?? null, to, ...(target ? { placement: target.placement } : {}) },
      after
    );
    routes[alias] = to;
    routeStep.set(alias, id);
    return id;
  };

  for (let guard = 0; guard < 1000; guard += 1) {
    let progress = false;

    // Flip routes whose target is serving, will be served on demand, or is external.
    pendingRoutes = pendingRoutes.filter(({ alias, to }) => {
      const target = plannedByModel.get(to);
      const onDemand = target && target.residency === 'auto' && !running.has(target.placement);
      if (!readyStep.has(to) && !externalModels.has(to) && !onDemand) return true;
      routeTo(alias, to);
      progress = true;
      return false;
    });

    // Retire lanes that are not planned and no longer routed to.
    for (const placement of [...running.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      if (plannedKeys.has(placement.key) || aliasesOn(placement).length) continue;
      const after = Object.entries(routes)
        .filter(([alias]) => routeStep.has(alias))
        .filter(([alias]) => placement.models.includes(current.routes?.[alias]))
        .map(([alias]) => routeStep.get(alias));
      release(placement, after);
      progress = true;
    }

    // Start lanes that fit next to everything still running (make before break).
    for (const placement of [...pendingStarts]) {
      if (startStep.has(placement.placement) || !fits(placement)) continue;
      const id = add(
        {
          type: placement.managed === false ? 'manual-start' : 'start',
          placement: placement.placement,
          nodes: placement.nodes,
          runtime: placement.runtime,
          residency: placement.residency,
          memoryGbPerNode: placement.memoryGbPerNode
        },
        startAfter(placement)
      );
      startStep.set(placement.placement, id);
      for (const node of placement.nodes)
        usage.set(node, (usage.get(node) ?? 0) + (num(placement.memoryGbPerNode) ?? 0));
      for (const model of placement.models) readyStep.set(model, id);
      running.set(placement.placement, { key: placement.placement, ...placement, state: 'starting' });
      pendingStarts.splice(pendingStarts.indexOf(placement), 1);
      progress = true;
    }
    if (progress) continue;
    if (!pendingStarts.length && !pendingRoutes.length) break;

    // Nothing moves: free memory for the first blocked start. On-demand lanes
    // go first (they simply cold start later), then unplanned lanes, whose
    // aliases take an interim member while the swap happens.
    const blockedStart = pendingStarts[0];
    if (!blockedStart) {
      for (const change of pendingRoutes)
        blocked.push({ alias: change.alias, to: change.to, reason: 'target never starts' });
      break;
    }
    const victims = [...running.values()]
      .filter(
        (placement) =>
          placement.state !== 'starting' && placement.nodes.some((node) => blockedStart.nodes.includes(node))
      )
      .filter((placement) => {
        const plannedPlacement = planned.find((entry) => entry.placement === placement.key);
        return !plannedPlacement || plannedPlacement.residency === 'auto';
      })
      .sort((a, b) => {
        const aPlanned = plannedKeys.has(a.key) ? 0 : 1;
        const bPlanned = plannedKeys.has(b.key) ? 0 : 1;
        return (
          aPlanned - bPlanned ||
          (num(b.memoryGbPerNode) ?? 0) - (num(a.memoryGbPerNode) ?? 0) ||
          a.key.localeCompare(b.key)
        );
      });
    const freed = new Map();
    const chosen = [];
    for (const victim of victims) {
      chosen.push(victim);
      for (const node of victim.nodes) freed.set(node, (freed.get(node) ?? 0) + (num(victim.memoryGbPerNode) ?? 0));
      if (fits(blockedStart, freed)) break;
    }
    if (!chosen.length || !fits(blockedStart, freed)) {
      blocked.push({
        placement: blockedStart.placement,
        reason: 'does not fit even after releasing every movable lane'
      });
      pendingStarts.shift();
      continue;
    }
    for (const victim of chosen) {
      const interimAfter = [];
      for (const alias of aliasesOn(victim)) {
        const workload = workloads.find((entry) => entry.id === alias);
        const interim = list(workload?.candidates).find(
          (model) =>
            !victim.models.includes(model) &&
            (externalModels.has(model) ||
              [...running.values()].some(
                (placement) =>
                  placement.state !== 'starting' &&
                  placement.key !== victim.key &&
                  !chosen.includes(placement) &&
                  placement.models.includes(model)
              ))
        );
        if (interim) interimAfter.push(routeTo(alias, interim, 'interim-route'));
        else interruptions.push({ alias, placement: victim.key, until: blockedStart.placement });
      }
      release(victim, interimAfter);
    }
  }

  for (const change of residencyUp.sort((a, b) => a.runtime.localeCompare(b.runtime))) {
    const placement = planned.find((entry) => entry.runtime === change.runtime);
    add({ type: 'residency', ...change }, [placement && startStep.get(placement.placement)]);
  }

  return {
    version: POOL_RECONCILE_VERSION,
    steps,
    interruptions,
    blocked,
    manual: steps.filter((step) => step.type.startsWith('manual-')),
    empty: steps.length === 0
  };
}

/**
 * Run reconcile steps against an actuator, honouring dependencies.
 *
 * actuator: { prefetch(step), start(step), stop(step), route(step), residency(step), manual(step) }
 * Every method returns a promise that settles when the step is done (a start
 * when the lane is ready, a stop when it has drained). Manual steps resolve
 * when the actuator observes the operator's change or rejects on timeout.
 */
export async function executeReconcile(steps, actuator, { concurrency = 4, onStep = () => {} } = {}) {
  const status = new Map(steps.map((step) => [step.id, 'pending']));
  const errors = {};
  const byId = new Map(steps.map((step) => [step.id, step]));
  const running = new Set();
  const method = (type) =>
    ({
      prefetch: 'prefetch',
      start: 'start',
      stop: 'stop',
      route: 'route',
      'interim-route': 'route',
      residency: 'residency',
      'manual-start': 'manual',
      'manual-stop': 'manual'
    })[type];

  return new Promise((resolve) => {
    const finish = () =>
      resolve({
        ok: [...status.values()].every((value) => value === 'done'),
        status: Object.fromEntries(status),
        errors
      });
    const pump = () => {
      for (const step of steps) {
        if (status.get(step.id) !== 'pending') continue;
        const deps = step.after.map((id) => status.get(id));
        if (deps.some((value) => value === 'failed' || value === 'skipped')) {
          status.set(step.id, 'skipped');
          onStep({ step, status: 'skipped' });
          continue;
        }
        if (deps.some((value) => value !== 'done' && value !== undefined)) continue;
        if (running.size >= concurrency) break;
        status.set(step.id, 'running');
        running.add(step.id);
        onStep({ step, status: 'running' });
        Promise.resolve()
          .then(() => actuator[method(step.type)](step))
          .then(
            () => {
              status.set(step.id, 'done');
              onStep({ step, status: 'done' });
            },
            (error) => {
              status.set(step.id, 'failed');
              errors[step.id] = String(error?.message ?? error);
              onStep({ step, status: 'failed', error: errors[step.id] });
            }
          )
          .finally(() => {
            running.delete(step.id);
            pump();
          });
      }
      // Skips can cascade without any step running; settle once nothing is left.
      if (!running.size) {
        const stillPending = [...status.entries()].some(([id, value]) => value === 'pending' && byId.get(id));
        if (stillPending) {
          const progressed = steps.some(
            (step) =>
              status.get(step.id) === 'pending' &&
              step.after.every((id) => ['done', 'failed', 'skipped', undefined].includes(status.get(id)))
          );
          if (progressed) return pump();
          for (const [id, value] of status) if (value === 'pending') status.set(id, 'skipped');
        }
        finish();
      }
    };
    pump();
  });
}
