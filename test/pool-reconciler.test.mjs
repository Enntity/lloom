// Pool reconciler tests: step ordering (make before break, swaps, residency)
// and the dependency-aware executor. Pure inputs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planPool } from '../src/pool-planner.mjs';
import { executeReconcile, planReconcile } from '../src/pool-reconciler.mjs';

const fleet = JSON.parse(readFileSync(new URL('./fixtures/pool/spark-fleet.json', import.meta.url), 'utf8'));

function fleetWorkloads() {
  return fleet.workloads.map(({ cognition, ...workload }) => ({
    ...workload,
    candidates: cognition ? fleet.cognitionCandidates : workload.candidates
  }));
}

const RC16_RUNNING = [
  'qwen3.8-flash-next-atlas@spark-node-01+spark-node-02',
  'Qwen/Qwen3-Embedding-4B@spark-node-03',
  'hear@spark-node-03',
  'BennyDaBall/Qwen-Image-2.1-Turbo-NVFP4@spark-node-03',
  'Qwen/Qwen3-TTS-12Hz-1.7B-Base@spark-node-03'
];

function placementsFor(keys, variants) {
  return keys.map((key) => {
    const variant = variants.find((candidate) => candidate.id === key);
    return {
      key,
      models: [variant.gatewayModel],
      runtime: variant.runtime ?? null,
      nodes: variant.nodes,
      memoryGbPerNode: variant.requirements.memoryGbPerNode,
      managed: variant.managed !== false,
      state: 'ready'
    };
  });
}

function index(steps) {
  return Object.fromEntries(steps.map((step, position) => [step.id, { ...step, position }]));
}

function dependsOn(steps, id, dependency) {
  const byId = index(steps);
  const seen = new Set();
  const walk = (current) => {
    for (const parent of byId[current]?.after ?? []) {
      if (parent === dependency) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        if (walk(parent)) return true;
      }
    }
    return false;
  };
  return walk(id);
}

test('a pool that already matches the plan needs no steps', () => {
  const profile = fleet.profiles['sparkqwen-pair-rc16'];
  const current = { routes: profile.routes, residency: profile.residency, running: RC16_RUNNING };
  const plan = planPool({
    nodes: fleet.nodes,
    variants: fleet.variants,
    workloads: fleetWorkloads(),
    pins: fleet.pins,
    current,
    policy: fleet.policy
  });
  const result = planReconcile({
    plan,
    current: { ...current, placements: placementsFor(RC16_RUNNING, fleet.variants) }
  });
  assert.equal(result.empty, true, JSON.stringify(result.steps));
});

test('taking the pair starts the 27B before moving cognition, and stops the pair only after the moves', () => {
  const profile = fleet.profiles['sparkqwen-pair-rc16'];
  const current = { routes: profile.routes, residency: profile.residency, running: RC16_RUNNING };
  const plan = planPool({
    nodes: fleet.nodes,
    variants: fleet.variants,
    workloads: fleetWorkloads(),
    pins: { ...fleet.pins, cordon: ['spark-node-01', 'spark-node-02'] },
    current,
    policy: fleet.policy
  });
  const { steps, interruptions, blocked } = planReconcile({
    plan,
    current: { ...current, placements: placementsFor(RC16_RUNNING, fleet.variants) },
    workloads: fleetWorkloads()
  });
  assert.deepEqual(interruptions, []);
  assert.deepEqual(blocked, []);
  const start = steps.find((step) => step.type === 'start');
  assert.equal(start.placement, 'qwen38-27b-nvfp4@spark-node-03');
  const routeSteps = steps.filter((step) => step.type === 'route');
  assert.equal(routeSteps.length, 7);
  for (const route of routeSteps) {
    assert.equal(route.to, 'qwen38-27b-nvfp4');
    assert.ok(route.after.includes(start.id), `${route.id} waits for the start`);
  }
  const stop = steps.find((step) => step.type === 'manual-stop');
  assert.equal(stop.placement, 'qwen3.8-flash-next-atlas@spark-node-01+spark-node-02');
  for (const route of routeSteps) assert.ok(dependsOn(steps, stop.id, route.id), `stop waits for ${route.id}`);
  const upgrade = steps.find((step) => step.type === 'residency' && step.runtime === 'qwen38-27b-nvfp4');
  assert.deepEqual([upgrade.from, upgrade.to], ['auto', 'always']);
  assert.ok(upgrade.after.includes(start.id));
});

// One node with room for one big lane: moving alias `x` from A to B is a swap.
const SWAP_NODE = {
  id: 'n1',
  computeArchs: ['sm_121'],
  memoryDomains: [{ id: 'u', kind: 'unified', capacityGb: 100 }]
};
const swapVariants = [
  {
    id: 'A@n1',
    gatewayModel: 'A',
    runtime: 'a',
    nodes: ['n1'],
    kind: 'chat',
    requirements: { memoryGbPerNode: 60 },
    performance: { ttftMs: 2000, decodeTps: 20 }
  },
  {
    id: 'B@n1',
    gatewayModel: 'B',
    runtime: 'b',
    nodes: ['n1'],
    kind: 'chat',
    requirements: { memoryGbPerNode: 60 },
    performance: { ttftMs: 300, decodeTps: 80 }
  },
  { id: 'cloud', gatewayModel: 'cloud', external: true, kind: 'chat', performance: { ttftMs: 700, decodeTps: 100 } }
];

function swap({ candidates }) {
  const workloads = [{ id: 'x', candidates, residency: 'always', demandPerHour: 50 }];
  const current = { routes: { x: 'A' }, residency: { a: 'always', b: 'auto' }, running: ['A@n1'] };
  const plan = planPool({
    nodes: [SWAP_NODE],
    variants: swapVariants,
    workloads,
    current,
    policy: { reserveGb: 0, headroomGb: 0, churnWeight: 0 }
  });
  assert.equal(plan.routes.x.model, 'B');
  return planReconcile({
    plan,
    current: { ...current, placements: placementsFor(['A@n1'], swapVariants) },
    workloads,
    variants: swapVariants
  });
}

test('a swap moves the alias to an interim member, drains the old lane, then starts the new one', () => {
  const { steps, interruptions } = swap({ candidates: ['B', 'A', 'cloud'] });
  assert.deepEqual(interruptions, []);
  const byType = (type) => steps.find((step) => step.type === type);
  const interim = byType('interim-route');
  assert.deepEqual([interim.alias, interim.to], ['x', 'cloud']);
  const stop = byType('stop');
  assert.equal(stop.placement, 'A@n1');
  assert.ok(stop.after.includes(interim.id));
  const downgrade = steps.find((step) => step.type === 'residency' && step.runtime === 'a');
  assert.ok(stop.after.includes(downgrade.id), 'keep-warm is dropped before the stop');
  const start = byType('start');
  assert.ok(start.after.includes(stop.id));
  const route = byType('route');
  assert.deepEqual([route.to, route.after.includes(start.id)], ['B', true]);
});

test('a swap with no interim member reports the interruption', () => {
  const { steps, interruptions } = swap({ candidates: ['B', 'A'] });
  assert.deepEqual(interruptions, [{ alias: 'x', placement: 'A@n1', until: 'B@n1' }]);
  assert.ok(steps.some((step) => step.type === 'stop'));
  assert.ok(!steps.some((step) => step.type === 'interim-route'));
});

test('a new placement on a node without the weights prefetches first', () => {
  const node = { ...SWAP_NODE, id: 'mac', computeArchs: ['apple-metal'], weights: [] };
  const variants = [
    {
      id: 'E',
      gatewayModel: 'E',
      runtime: 'e',
      kind: 'embedding',
      requirements: { memoryGbPerNode: 8, computeArchs: ['apple-metal'], recipeId: 'mlx-e' },
      performance: { durationMs: 50 }
    }
  ];
  const workloads = [{ id: 'emb', candidates: ['E'], residency: 'always', demandPerHour: 100 }];
  const plan = planPool({ nodes: [node], variants, workloads, current: {}, policy: { reserveGb: 0 } });
  const { steps } = planReconcile({
    plan,
    current: { placements: [], routes: {} },
    workloads,
    variants,
    nodes: [node]
  });
  const prefetch = steps.find((step) => step.type === 'prefetch');
  const start = steps.find((step) => step.type === 'start');
  assert.equal(prefetch.placement, 'E@mac');
  assert.ok(start.after.includes(prefetch.id));
});

test('a failed start skips the route flip and the old lane stop, so the old lane keeps serving', async () => {
  const { steps } = swap({ candidates: ['B', 'A', 'cloud'] });
  const calls = [];
  const actuator = {
    prefetch: async () => {},
    start: async (step) => {
      calls.push(step.id);
      throw new Error('admission refused');
    },
    stop: async (step) => calls.push(step.id),
    route: async (step) => calls.push(step.id),
    residency: async (step) => calls.push(step.id),
    manual: async () => {}
  };
  const result = await executeReconcile(steps, actuator);
  assert.equal(result.ok, false);
  const route = steps.find((step) => step.type === 'route');
  assert.equal(result.status[route.id], 'skipped');
  assert.match(result.errors[steps.find((step) => step.type === 'start').id], /admission refused/);
});

test('make-before-break: a start that fits runs before the old lane stops', async () => {
  const profile = fleet.profiles['sparkqwen-pair-rc16'];
  const current = { routes: profile.routes, residency: profile.residency, running: RC16_RUNNING };
  const plan = planPool({
    nodes: fleet.nodes,
    variants: fleet.variants,
    workloads: fleetWorkloads(),
    pins: { ...fleet.pins, cordon: ['spark-node-01', 'spark-node-02'] },
    current,
    policy: fleet.policy
  });
  const { steps } = planReconcile({
    plan,
    current: { ...current, placements: placementsFor(RC16_RUNNING, fleet.variants) },
    workloads: fleetWorkloads()
  });
  const order = [];
  const record = async (step) => order.push(step.id);
  const result = await executeReconcile(
    steps,
    { prefetch: record, start: record, stop: record, route: record, residency: record, manual: record },
    { concurrency: 1 }
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const at = (type) => order.findIndex((id) => id.startsWith(`${type}:`));
  assert.ok(at('start') < at('route'));
  assert.ok(at('route') < at('manual-stop'));
  assert.equal(order.length, steps.length);
});
