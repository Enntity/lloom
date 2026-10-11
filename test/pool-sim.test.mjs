// Pool simulator tests: the engine's model of today's LLooM behaviour, and the
// fleet scenarios under test/fixtures/pool/scenarios run with and without the
// pool controller. Everything is simulated; nothing touches a gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkExpectations, runPoolSimulation } from '../src/pool-sim.mjs';
import { formatPoolSimulation, loadPoolScenario, runPoolSimulateCommand } from '../src/pool-sim-cli.mjs';

const SCENARIOS = fileURLToPath(new URL('./fixtures/pool/scenarios/', import.meta.url));

const spark = (id, extra = {}) => ({
  id,
  platformId: 'linux-arm64',
  computeArchs: ['sm_121'],
  memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 128 }],
  links: [],
  ...extra
});

const chat = (id, node, extra = {}) => ({
  id: `${id}@${node}`,
  gatewayModel: id,
  kind: 'chat',
  runtime: id,
  nodes: [node],
  requirements: { memoryGbPerNode: 40 },
  performance: { ttftMs: 500, decodeTps: 50 },
  sim: { loadSeconds: 60, maxSequences: 4 },
  ...extra
});

function tiny(overrides = {}) {
  return {
    name: 'tiny',
    seed: 3,
    durationHours: 2,
    policy: { reserveGb: 8, headroomGb: 4 },
    nodes: [spark('s1')],
    variants: [chat('m', 's1')],
    workloads: [{ id: 'chat', candidates: ['m'], residency: 'auto', demand: { perHour: 60 }, slo: { ttftMs: 2000 } }],
    initial: { running: [], routes: { chat: 'm' }, residency: { m: 'auto' } },
    ...overrides
  };
}

test('a cold on-demand lane loads once, and the first requests wait for it', async () => {
  const report = await runPoolSimulation(tiny(), { mode: 'off' });
  assert.equal(report.lanes.loads, 1);
  assert.ok(report.requests.total > 80);
  assert.equal(report.requests.failed, 0);
  assert.equal(report.requests.coldWaits, 1);
  // The first request waited for the 60 s load; everything else was warm.
  assert.ok(report.workloads.chat.ttftP95Ms < 2000);
  assert.ok(report.requests.sloAttainment < 1);
});

test('the simulation is deterministic for a seed', async () => {
  const first = await runPoolSimulation(tiny(), { mode: 'auto' });
  const second = await runPoolSimulation(tiny(), { mode: 'auto' });
  assert.deepEqual(first, second);
  const reseeded = await runPoolSimulation(tiny({ seed: 4 }), { mode: 'auto' });
  assert.notEqual(reseeded.requests.total, first.requests.total);
});

test('admission evicts an idle on-demand lane but never a keep-warm lane', async () => {
  const scenario = tiny({
    nodes: [spark('s1')],
    variants: [
      chat('warm', 's1', { requirements: { memoryGbPerNode: 60 } }),
      chat('idle', 's1', { requirements: { memoryGbPerNode: 40 } }),
      chat('burst', 's1', { requirements: { memoryGbPerNode: 40 } })
    ],
    workloads: [
      { id: 'w', candidates: ['warm'], residency: 'always', demand: { perHour: 30 } },
      { id: 'b', candidates: ['burst'], residency: 'auto', demand: { perHour: 6 } }
    ],
    initial: {
      running: ['warm@s1', 'idle@s1'],
      routes: { w: 'warm', b: 'burst' },
      residency: { warm: 'always', idle: 'auto', burst: 'auto' }
    }
  });
  const report = await runPoolSimulation(scenario, { mode: 'off' });
  assert.equal(report.lanes.evictions, 1);
  assert.ok(report.final.lanes.includes('warm@s1'));
  assert.ok(!report.final.lanes.includes('idle@s1'));
  assert.equal(report.workloads.w.failed, 0);
});

test('a failed node fails in-flight requests and fails queued ones over to another member', async () => {
  const scenario = tiny({
    nodes: [spark('s1'), spark('s2')],
    variants: [chat('a', 's1'), chat('b', 's2')],
    workloads: [
      { id: 'chat', candidates: ['a', 'b'], residency: 'always', outputTokens: 2000, demand: { perHour: 120 } }
    ],
    initial: { running: ['a@s1', 'b@s2'], routes: { chat: 'a' }, residency: { a: 'always', b: 'always' } },
    events: [{ atHours: 1, type: 'fail', nodes: ['s1'] }]
  });
  const report = await runPoolSimulation(scenario, { mode: 'off' });
  assert.ok(report.requests.failed > 0, 'requests in flight on s1 fail');
  assert.ok(report.requests.failed < 10);
  assert.ok(report.workloads.chat.served > report.requests.total * 0.95, 'the rest move to b on s2');
});

test('an unmanaged lane is never cold started; an external member covers instead', async () => {
  const scenario = tiny({
    variants: [
      chat('pair', 's1', { managed: false }),
      { id: 'cloud', gatewayModel: 'cloud', external: true, kind: 'chat', performance: { ttftMs: 800, decodeTps: 100 } }
    ],
    workloads: [{ id: 'chat', candidates: ['pair', 'cloud'], residency: 'auto', demand: { perHour: 30 } }],
    initial: { running: [], routes: { chat: 'pair' }, residency: {} }
  });
  const report = await runPoolSimulation(scenario, { mode: 'off' });
  assert.equal(report.lanes.loads, 0);
  assert.equal(report.requests.external, report.requests.total);
});

test('the memory guard aborts an underestimated load; with the guard off the node hangs', async () => {
  const scenario = tiny({
    variants: [
      chat('m', 's1', { requirements: { memoryGbPerNode: 40 }, sim: { loadSeconds: 60, memoryGbPerNode: 130 } })
    ]
  });
  const guarded = await runPoolSimulation(scenario, { mode: 'off' });
  assert.equal(guarded.safety.memoryViolations.length, 0);
  assert.ok(guarded.lanes.guardAborts > 0);
  const unguarded = await runPoolSimulation({ ...scenario, memoryGuard: { enabled: false } }, { mode: 'off' });
  assert.ok(unguarded.safety.memoryViolations.length > 0);
  assert.ok(unguarded.safety.nodeHangs > 0);
});

test('expectations check paths with min, max, equals and includes', () => {
  const report = { a: { b: 2 }, list: ['x'], routes: { r: 'm' } };
  const checks = checkExpectations(report, {
    'a.b': { min: 1, max: 2 },
    list: { includes: 'x' },
    'routes.r': { equals: 'm' },
    'a.missing': { min: 0 }
  });
  assert.deepEqual(
    checks.map((check) => check.ok),
    [true, true, true, false]
  );
});

test('scenarios inherit a base and merge arrays by id', async () => {
  const scenario = await loadPoolScenario(`${SCENARIOS}mac-joins.json`);
  assert.equal(scenario.name, 'mac-joins');
  assert.ok(scenario.nodes.some((node) => node.id === 'mac-studio'));
  assert.ok(!scenario.nodes.some((node) => node.id === 'spark-node-01'));
  const video = scenario.workloads.find((workload) => workload.id === 'video');
  assert.deepEqual(video.candidates, ['Wan-AI/Wan2.2-TI2V-5B-Diffusers'], 'base workloads are kept');
  const chatCapable = scenario.workloads.find((workload) => workload.id === 'chat-capable');
  assert.equal(chatCapable.candidates[0], 'qwen3.8-flash-next-mlx');
  assert.equal(chatCapable.slo.ttftMs, 3000, 'overlay fields merge into the base workload');
});

// Every scenario's own expectations, in the modes it states them for.
const scenarioFiles = readdirSync(SCENARIOS).filter((file) => file.endsWith('.json') && !file.includes('base'));

for (const file of scenarioFiles) {
  test(`scenario ${file} meets its expectations`, async () => {
    const reports = await runPoolSimulateCommand(`${SCENARIOS}${file}`, { modes: ['off', 'advise', 'auto'] });
    for (const [mode, report] of Object.entries(reports)) {
      assert.equal(report.safety.memoryViolations.length, 0, `${mode}: no memory violations`);
      const failed = report.checks.filter((check) => !check.ok);
      assert.deepEqual(failed, [], `${mode}: ${JSON.stringify(failed)}`);
    }
    // Advise never changes the fleet: it serves exactly what off serves.
    assert.deepEqual(reports.advise.requests, reports.off.requests);
    assert.deepEqual(reports.advise.final.lanes, reports.off.final.lanes);
    assert.ok(formatPoolSimulation(reports).includes(reports.auto.scenario));
  });
}

test('pair crash: the controller keeps cognition local and warm where today it cold starts and spills to the cloud', async () => {
  const { off, auto } = await runPoolSimulateCommand(`${SCENARIOS}pair-crash.json`, { modes: ['off', 'auto'] });
  const cognition = ['chat-capable', 'chat-fast', 'chat-classifier', 'multimodal', 'enntity-presence', 'omp', 'ds4f'];
  const p95 = (report) => Math.max(...cognition.map((id) => report.workloads[id].ttftP95Ms));
  assert.ok(off.requests.external > 0, 'today some cognition spills to the cloud');
  assert.equal(auto.requests.external, 0);
  assert.ok(p95(auto) < p95(off) / 5, `cognition p95 ${p95(auto)} ms vs ${p95(off)} ms`);
  assert.ok(auto.lanes.loadGb < off.lanes.loadGb, 'fewer reloads');
  assert.equal(auto.final.routes['chat-capable'], 'qwen3.8-flash-next-atlas', 'back on the pair after recovery');
});

test('mac joins: weights are prefetched, cognition moves without dropping a request, and 03 is freed', async () => {
  const { auto } = await runPoolSimulateCommand(`${SCENARIOS}mac-joins.json`, { modes: ['auto'] });
  const apply = auto.controller.decisions.find((entry) => entry.action === 'apply');
  const types = apply.steps.map((step) => step.type);
  assert.ok(types.indexOf('prefetch') < types.indexOf('start'));
  assert.ok(types.lastIndexOf('route') < types.indexOf('stop'));
  assert.equal(auto.requests.failed, 0);
  assert.ok(!auto.final.lanes.includes('qwen38-27b-nvfp4@spark-node-03'));
});

test('admission that keeps the memory guard margin free ends the abort-and-latch cycle', async () => {
  const scenario = await loadPoolScenario(`${SCENARIOS}pair-crash.json`);
  const legacy = await runPoolSimulation({ ...scenario, legacyAdmission: true }, { mode: 'off' });
  const fixed = await runPoolSimulation(scenario, { mode: 'off' });
  assert.ok(legacy.lanes.guardAborts > 0, 'legacy admission lets in loads the guard then aborts');
  assert.equal(fixed.lanes.guardAborts, 0);
  assert.ok(fixed.requests.failed < legacy.requests.failed);
});
