// Pool controller tests: modes, urgency, hysteresis and failure backoff, with
// a fake observer and actuator. No gateway, runtimes or timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPoolController, decide, normalizeControllerPolicy } from '../src/pool-controller.mjs';

const fleet = JSON.parse(readFileSync(new URL('./fixtures/pool/spark-fleet.json', import.meta.url), 'utf8'));

const RC16_RUNNING = [
  'qwen3.8-flash-next-atlas@spark-node-01+spark-node-02',
  'Qwen/Qwen3-Embedding-4B@spark-node-03',
  'hear@spark-node-03',
  'BennyDaBall/Qwen-Image-2.1-Turbo-NVFP4@spark-node-03',
  'Qwen/Qwen3-TTS-12Hz-1.7B-Base@spark-node-03'
];

// A tiny in-memory fleet the fake actuator mutates, so successive ticks see
// the effect of the previous apply.
function fakeFleet({ cordon = [], failStarts = [] } = {}) {
  const profile = fleet.profiles['sparkqwen-pair-rc16'];
  const state = {
    routes: { ...profile.routes },
    residency: { ...profile.residency },
    running: new Set(RC16_RUNNING),
    cordon: new Set(cordon),
    calls: []
  };
  const variant = (key) => fleet.variants.find((candidate) => candidate.id === key);
  const observe = async () => ({
    nodes: fleet.nodes.map((node) => ({ ...node, cordoned: state.cordon.has(node.id) })),
    variants: fleet.variants,
    workloads: fleet.workloads.map(({ cognition, ...workload }) => ({
      ...workload,
      candidates: cognition ? fleet.cognitionCandidates : workload.candidates
    })),
    pins: fleet.pins,
    policy: { ...fleet.policy, memorySafetyUtilization: null },
    current: {
      routes: { ...state.routes },
      residency: { ...state.residency },
      running: [...state.running],
      placements: [...state.running].map((key) => ({
        key,
        models: [variant(key).gatewayModel],
        runtime: variant(key).runtime ?? null,
        nodes: variant(key).nodes,
        memoryGbPerNode: variant(key).requirements.memoryGbPerNode,
        managed: variant(key).managed !== false,
        state: 'ready'
      }))
    }
  });
  const actuator = {
    prefetch: async () => {},
    start: async (step) => {
      state.calls.push(step.id);
      if (failStarts.includes(step.placement)) throw new Error('admission refused');
      state.running.add(step.placement);
    },
    stop: async (step) => {
      state.calls.push(step.id);
      state.running.delete(step.placement);
    },
    route: async (step) => {
      state.calls.push(step.id);
      state.routes[step.alias] = step.to;
    },
    residency: async (step) => {
      state.calls.push(step.id);
      state.residency[step.runtime] = step.to;
    },
    manual: async (step) => {
      state.calls.push(step.id);
      if (step.type === 'manual-stop') state.running.delete(step.placement);
      else state.running.add(step.placement);
    }
  };
  return { state, observe, actuator };
}

test('policy normalisation keeps known keys and valid modes only', () => {
  const policy = normalizeControllerPolicy({ mode: 'yolo', confirmTicks: '3', unknown: 1 });
  assert.equal(policy.mode, 'advise');
  assert.equal(policy.confirmTicks, 3);
  assert.equal('unknown' in policy, false);
});

test('off mode never observes or acts', async () => {
  let observed = 0;
  const controller = createPoolController({ observe: async () => observed++, actuator: {}, policy: { mode: 'off' } });
  const entry = await controller.tick();
  assert.equal(entry.action, 'off');
  assert.equal(observed, 0);
});

test('a fleet that matches its plan holds', async () => {
  const { observe, actuator, state } = fakeFleet();
  const controller = createPoolController({ observe, actuator, policy: { mode: 'auto' } });
  const entry = await controller.tick();
  assert.equal(entry.action, 'hold');
  assert.equal(entry.reason, 'no changes');
  assert.deepEqual(state.calls, []);
});

test('losing the pair is urgent: auto applies on the first tick', async () => {
  const { observe, actuator, state } = fakeFleet({ cordon: ['spark-node-01', 'spark-node-02'] });
  const controller = createPoolController({ observe, actuator, policy: { mode: 'auto', confirmTicks: 5 } });
  const entry = await controller.tick();
  assert.equal(entry.action, 'apply');
  assert.equal(entry.urgent, true);
  await controller.executing;
  assert.equal(state.routes['chat-capable'], 'qwen38-27b-nvfp4');
  assert.equal(state.residency['qwen38-27b-nvfp4'], 'always');
  assert.ok(!state.running.has('qwen3.8-flash-next-atlas@spark-node-01+spark-node-02'));
  const next = await controller.tick();
  assert.equal(next.reason, 'no changes', 'the pool settles');
});

test('advise mode proposes the same change and never touches the actuator', async () => {
  const { observe, actuator, state } = fakeFleet({ cordon: ['spark-node-01', 'spark-node-02'] });
  const controller = createPoolController({ observe, actuator, policy: { mode: 'advise' } });
  const entry = await controller.tick();
  assert.equal(entry.action, 'propose');
  assert.ok(entry.steps.length > 0);
  assert.deepEqual(state.calls, []);
});

test('a non-urgent improvement waits for a stable plan and then for the cooldown', async () => {
  // Standalone with the pair free: moving back is a gain, not a coverage fix.
  const { observe, actuator, state } = fakeFleet();
  Object.assign(state.routes, fleet.profiles.standalone.routes);
  Object.assign(state.residency, fleet.profiles.standalone.residency);
  state.running.delete('qwen3.8-flash-next-atlas@spark-node-01+spark-node-02');
  state.running.add('qwen38-27b-nvfp4@spark-node-03');
  let clock = 0;
  const controller = createPoolController({
    observe,
    actuator,
    now: () => clock,
    policy: { mode: 'auto', confirmTicks: 2, cooldownMs: 600000 }
  });
  const first = await controller.tick();
  assert.equal(first.action, 'hold');
  assert.match(first.reason, /stable plan \(1\/2\)/);
  clock += 60000;
  const second = await controller.tick();
  assert.equal(second.action, 'apply');
  assert.equal(second.urgent, false);
  await controller.executing;
  assert.equal(state.routes['chat-capable'], 'qwen3.8-flash-next-atlas');
});

test('the hourly load budget holds back a non-urgent move but never an urgent one', () => {
  const policy = normalizeControllerPolicy({ maxLoadGbPerHour: 400 });
  const reconcile = {
    empty: false,
    steps: [
      { type: 'start', memoryGbPerNode: 60, nodes: ['a'] },
      { type: 'route', alias: 'x' }
    ]
  };
  const state = { stableTicks: 5, lastActionAt: null, loads: [{ at: 0, gb: 350 }] };
  const better = { score: { uncovered: 0, external: 0, sloMisses: 0, cost: 50 } };
  const today = { score: { uncovered: 0, external: 0, sloMisses: 0, cost: 100 } };
  const held = decide({ plan: better, stay: today, reconcile, state, policy, now: 1000 });
  assert.equal(held.act, false);
  assert.match(held.reason, /hourly load budget/);
  const later = decide({ plan: better, stay: today, reconcile, state, policy, now: 3600001 });
  assert.equal(later.act, true, 'the budget is a rolling hour');
  const uncovered = { score: { ...today.score, uncovered: 1 } };
  assert.equal(decide({ plan: better, stay: uncovered, reconcile, state, policy, now: 1000 }).urgent, true);
});

test('a failed start is retried elsewhere after backoff instead of repeating', async () => {
  const { observe, actuator, state } = fakeFleet({
    cordon: ['spark-node-01', 'spark-node-02'],
    failStarts: ['qwen38-27b-nvfp4@spark-node-03']
  });
  let clock = 0;
  const controller = createPoolController({ observe, actuator, now: () => clock, policy: { mode: 'auto' } });
  const first = await controller.tick();
  assert.equal(first.action, 'apply');
  const result = await controller.executing;
  assert.equal(result.ok, false);
  assert.equal(
    state.routes['chat-capable'],
    'qwen3.8-flash-next-atlas',
    'routes did not move to a lane that never started'
  );
  assert.ok(controller.failures()['qwen38-27b-nvfp4@spark-node-03']);
  clock += 60000;
  const second = await controller.tick();
  // With the 27B excluded, the only cover left for cognition is the cloud member.
  assert.equal(second.plan.routes['chat-capable'].model, 'cloud/openrouter/q38fn');
  assert.equal(second.action, 'apply');
});

test('an urgent new target cancels a change stuck in progress; the same target never preempts itself', async () => {
  const { observe, actuator, state } = fakeFleet({ cordon: ['spark-node-01', 'spark-node-02'] });
  const hung = [];
  actuator.start = (step) =>
    new Promise(() => {
      hung.push(step.id);
    });
  const events = [];
  let clock = 0;
  const controller = createPoolController({
    observe,
    actuator,
    now: () => clock,
    onEvent: (entry) => events.push(entry.action),
    policy: { mode: 'auto' }
  });
  assert.equal((await controller.tick()).action, 'apply');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hung, ['start:qwen38-27b-nvfp4@spark-node-03']);
  clock += 60000;
  assert.equal((await controller.tick()).action, 'busy', 'the same target waits for the start');
  // Now spark-node-03 goes too: only the cloud member is left for cognition.
  state.cordon.add('spark-node-03');
  clock += 60000;
  const entry = await controller.tick();
  assert.equal(entry.action, 'apply');
  assert.ok(events.includes('preempted'));
  await controller.executing;
  assert.equal(state.routes['chat-capable'], 'cloud/openrouter/q38fn');
});

test('ticks do not overlap, throwing observers do not wedge it, and one large move fits an empty hour', async () => {
  const { observe, actuator, state } = fakeFleet({ cordon: ['spark-node-01', 'spark-node-02'] });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const controller = createPoolController({
    observe: async () => {
      await gate;
      return observe();
    },
    actuator,
    onEvent: () => {
      throw new Error('observer bug');
    },
    policy: { mode: 'auto', concurrency: 0 }
  });
  assert.equal(controller.policy.concurrency, 1);
  const first = controller.tick();
  const second = await controller.tick();
  assert.equal(second.action, 'busy');
  release();
  assert.equal((await first).action, 'apply');
  const result = await controller.executing;
  assert.equal(result.ok, true);
  assert.equal(state.routes['chat-capable'], 'qwen38-27b-nvfp4');

  const policy = normalizeControllerPolicy({ maxLoadGbPerHour: 10 });
  const big = { empty: false, steps: [{ type: 'start', memoryGbPerNode: 110, nodes: ['a', 'b'] }, { type: 'route' }] };
  const score = { uncovered: 0, external: 0, sloMisses: 0 };
  const quiet = { stableTicks: 5, lastActionAt: null, loads: [] };
  const decision = decide({
    plan: { score: { ...score, cost: 10 } },
    stay: { score: { ...score, cost: 100 } },
    reconcile: big,
    state: quiet,
    policy,
    now: 0
  });
  assert.equal(decision.act, true, 'a 220 GB move is not impossible under a 10 GB budget');
  const resumed = {
    empty: false,
    steps: [{ type: 'start', resume: true, memoryGbPerNode: 110, nodes: ['a'] }, { type: 'route' }]
  };
  const busyHour = { ...quiet, loads: [{ at: 0, gb: 5 }] };
  assert.equal(
    decide({
      plan: { score: { ...score, cost: 10 } },
      stay: { score: { ...score, cost: 100 } },
      reconcile: resumed,
      state: busyHour,
      policy,
      now: 1
    }).act,
    true,
    'a lane already loading is not counted again'
  );
});
