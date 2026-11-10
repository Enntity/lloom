// Pool planner tests. Pure planner inputs only: no gateway, runtimes or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planPool } from '../src/pool-planner.mjs';

const fleet = JSON.parse(readFileSync(new URL('./fixtures/pool/spark-fleet.json', import.meta.url), 'utf8'));

function fleetWorkloads() {
  return fleet.workloads.map(({ cognition, ...workload }) => ({
    ...workload,
    candidates: cognition ? fleet.cognitionCandidates : workload.candidates
  }));
}

function currentFromProfile(name, running) {
  const profile = fleet.profiles[name];
  return { routes: profile.routes, residency: profile.residency, running };
}

const RC16_RUNNING = [
  'qwen3.8-flash-next-atlas@spark-node-01+spark-node-02',
  'Qwen/Qwen3-Embedding-4B@spark-node-03',
  'hear@spark-node-03',
  'BennyDaBall/Qwen-Image-2.1-Turbo-NVFP4@spark-node-03',
  'Qwen/Qwen3-TTS-12Hz-1.7B-Base@spark-node-03'
];
const STANDALONE_RUNNING = [
  'qwen38-27b-nvfp4@spark-node-03',
  'Qwen/Qwen3-Embedding-4B@spark-node-03',
  'hear@spark-node-03',
  'BennyDaBall/Qwen-Image-2.1-Turbo-NVFP4@spark-node-03',
  'Qwen/Qwen3-TTS-12Hz-1.7B-Base@spark-node-03'
];

// The hand-written profiles were sized against the admission budget alone, so
// profile reproduction turns the memory-guard ceiling off; the guard has its
// own test below.
function planFleet({ cordon = [], current, pins = {}, nodes = fleet.nodes, policy = {} } = {}) {
  return planPool({
    nodes,
    variants: fleet.variants,
    workloads: fleetWorkloads(),
    pins: { ...fleet.pins, ...pins, cordon },
    current,
    policy: { ...fleet.policy, memorySafetyUtilization: null, ...policy }
  });
}

function plannedRoutes(plan) {
  return Object.fromEntries(Object.entries(plan.routes).map(([alias, route]) => [alias, route.model]));
}

function plannedResidency(plan, expected) {
  return Object.fromEntries(Object.keys(expected).map((runtime) => [runtime, plan.residency[runtime]]));
}

test('whole fleet reproduces the sparkqwen-pair-rc16 profile with no changes', () => {
  const plan = planFleet({ current: currentFromProfile('sparkqwen-pair-rc16', RC16_RUNNING) });
  const profile = fleet.profiles['sparkqwen-pair-rc16'];
  assert.equal(plan.ok, true, JSON.stringify(plan.uncovered));
  assert.deepEqual(plannedRoutes(plan), profile.routes);
  assert.deepEqual(plannedResidency(plan, profile.residency), profile.residency);
  assert.deepEqual(plan.diff.routeChanges, []);
  assert.deepEqual(plan.diff.start, []);
  assert.deepEqual(plan.diff.manual, []);
  assert.deepEqual(plan.diff.release, []);
  assert.equal(plan.score.external, 0);
});

test('cordoning the 01/02 pair reproduces the standalone profile', () => {
  const plan = planFleet({
    cordon: ['spark-node-01', 'spark-node-02'],
    current: currentFromProfile('sparkqwen-pair-rc16', RC16_RUNNING)
  });
  const profile = fleet.profiles.standalone;
  assert.equal(plan.ok, true, JSON.stringify(plan.uncovered));
  assert.deepEqual(plannedRoutes(plan), profile.routes);
  assert.deepEqual(plannedResidency(plan, profile.residency), profile.residency);
  assert.deepEqual(
    plan.diff.start.map((entry) => [entry.placement, entry.residency]),
    [['qwen38-27b-nvfp4@spark-node-03', 'always']]
  );
  assert.deepEqual(plan.diff.manual, [
    {
      action: 'manual-stop',
      placement: 'qwen3.8-flash-next-atlas@spark-node-01+spark-node-02',
      nodes: ['spark-node-01', 'spark-node-02']
    }
  ]);
  assert.equal(plan.diff.routeChanges.length, 7);
  assert.ok(plan.diff.routeChanges.every((change) => change.to === 'qwen38-27b-nvfp4'));
  assert.equal(plan.nodes['spark-node-01'].status, 'cordoned');
  assert.equal(plan.score.external, 0, 'local 27B covers cognition before the cloud member');
  const spark03 = plan.nodes['spark-node-03'].domains[0];
  assert.ok(spark03.residentGb <= spark03.budgetGb);
  assert.ok(spark03.alwaysGb + spark03.largestOnDemandGb <= spark03.budgetGb);
});

test('an unreachable pair is planned around exactly like a cordoned one', () => {
  const nodes = fleet.nodes.map((node) => (node.id === 'spark-node-03' ? node : { ...node, available: false }));
  const plan = planFleet({ nodes, current: currentFromProfile('sparkqwen-pair-rc16', RC16_RUNNING) });
  assert.deepEqual(plannedRoutes(plan), fleet.profiles.standalone.routes);
  assert.equal(plan.nodes['spark-node-02'].status, 'unavailable');
});

test('a free pair moves cognition back to SparkQwen as a manual start', () => {
  const plan = planFleet({ current: currentFromProfile('standalone', STANDALONE_RUNNING) });
  const profile = fleet.profiles['sparkqwen-pair-rc16'];
  assert.deepEqual(plannedRoutes(plan), profile.routes);
  assert.equal(plan.residency['qwen38-27b-nvfp4'], 'auto');
  assert.deepEqual(
    plan.diff.manual.map((entry) => entry.action + ' ' + entry.placement),
    ['manual-start qwen3.8-flash-next-atlas@spark-node-01+spark-node-02']
  );
  assert.deepEqual(plan.diff.release, [{ action: 'release', placement: 'qwen38-27b-nvfp4@spark-node-03' }]);
  assert.deepEqual(plan.diff.residencyChanges, [{ runtime: 'qwen38-27b-nvfp4', from: 'always', to: 'auto' }]);
});

test('the memory guard ceiling shows standalone cannot load video next to a keep-warm 27B', () => {
  const plan = planFleet({
    cordon: ['spark-node-01', 'spark-node-02'],
    current: currentFromProfile('sparkqwen-pair-rc16', RC16_RUNNING),
    policy: { memorySafetyUtilization: 0.9 }
  });
  // 128 GB x 0.9 guard ceiling - 4 GB headroom = 111.2 GB; keep-warm 27B,
  // embeddings and hear hold 64 GB, and the 48 GB video lane needs 112.
  assert.equal(plan.nodes['spark-node-03'].domains[0].budgetGb, 111.2);
  assert.deepEqual(
    plan.uncovered.map((entry) => entry.workload),
    ['video']
  );
  assert.equal(plan.routes['chat-capable'].model, 'qwen38-27b-nvfp4');
});

test('a high churn weight keeps the running lane when the gain is small', () => {
  const plan = planFleet({
    current: currentFromProfile('standalone', STANDALONE_RUNNING),
    policy: { churnWeight: 100000 }
  });
  assert.deepEqual(plannedRoutes(plan), fleet.profiles.standalone.routes);
  assert.deepEqual(plan.diff.routeChanges, []);
});

test('pinned routes and residency are hard constraints', () => {
  const plan = planFleet({
    current: currentFromProfile('sparkqwen-pair-rc16', RC16_RUNNING),
    pins: { routes: { omp: 'qwen38-27b-nvfp4' } }
  });
  assert.equal(plan.routes.omp.model, 'qwen38-27b-nvfp4');
  assert.equal(plan.routes.omp.reason, 'pinned');
  assert.equal(plan.routes['chat-capable'].model, 'qwen3.8-flash-next-atlas');
  assert.equal(plan.residency['qwen3-embedding-4b'], 'always');
  assert.equal(plan.residency.hear, 'always');

  const impossible = planFleet({
    current: {},
    pins: { routes: { omp: 'qwen3.8-flash-next-atlas' } },
    cordon: ['spark-node-01']
  });
  assert.equal(impossible.ok, false);
  assert.equal(impossible.uncovered[0].workload, 'omp');
  assert.equal(impossible.uncovered[0].pinned, 'qwen3.8-flash-next-atlas');
});

const spark = (id, links = []) => ({
  id,
  platformId: 'linux-arm64',
  computeArchs: ['sm_121'],
  accelerators: ['cuda', 'gb10'],
  memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 128 }],
  links
});
const mac = {
  id: 'studio',
  platformId: 'darwin-arm64',
  computeArchs: ['apple-metal'],
  accelerators: ['metal', 'apple-gpu'],
  memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 192 }]
};
const tp2 = {
  id: 'recipe:tp2',
  gatewayModel: 'big-moe',
  kind: 'chat',
  requirements: { nodeCount: 2, tensorParallel: 2, computeArchs: ['sm_121a'], memoryGbPerNode: 100 },
  performance: { ttftMs: 500, decodeTps: 50 }
};
const one = (workload) => [
  { id: 'chat', candidates: ['big-moe'], residency: 'always', demandPerHour: 10, ...workload }
];

test('tensor-parallel variants only span directly linked nodes', () => {
  const plan = planPool({
    nodes: [spark('a', ['b']), spark('b'), spark('c')],
    variants: [tp2],
    workloads: one(),
    policy: { maxMemoryUtilization: 0.95 }
  });
  assert.deepEqual(plan.routes.chat.nodes, ['a', 'b']);
  assert.equal(plan.placements[0].placement, 'recipe:tp2@a+b');

  const unlinked = planPool({
    nodes: [spark('a'), spark('b'), spark('c')],
    variants: [tp2],
    workloads: one(),
    policy: { maxMemoryUtilization: 0.95 }
  });
  assert.equal(unlinked.ok, false);
  assert.ok(unlinked.uncovered[0].reasons.some((reason) => reason.includes('no directly linked set of 2')));
});

test('compute architecture must match the variant', () => {
  const single = { ...tp2, id: 'recipe:one', requirements: { computeArchs: ['sm_121'], memoryGbPerNode: 60 } };
  const macOnly = planPool({ nodes: [mac], variants: [single], workloads: one() });
  assert.equal(macOnly.ok, false);
  assert.ok(macOnly.uncovered[0].reasons.some((reason) => reason.includes('needs compute arch sm_121')));
  const mixed = planPool({ nodes: [mac, spark('s')], variants: [single], workloads: one() });
  assert.deepEqual(mixed.routes.chat.nodes, ['s']);
});

test('memory headroom is conservative', () => {
  const large = { ...tp2, id: 'recipe:large', requirements: { memoryGbPerNode: 117 } };
  const fits = planPool({
    nodes: [spark('s')],
    variants: [large],
    workloads: one(),
    policy: { maxMemoryUtilization: 0.95, headroomGb: 4, memorySafetyUtilization: null }
  });
  assert.equal(fits.ok, true);
  const tight = planPool({
    nodes: [spark('s')],
    variants: [large],
    workloads: one(),
    policy: { maxMemoryUtilization: 0.95, headroomGb: 8, memorySafetyUtilization: null }
  });
  assert.equal(tight.ok, false);
  assert.ok(tight.uncovered[0].reasons.some((reason) => reason.includes('does not fit as always')));
  const admissionOnly = planPool({
    nodes: [spark('s')],
    variants: [large],
    workloads: one(),
    policy: { memorySafetyUtilization: null }
  });
  assert.equal(admissionOnly.ok, false, 'admission budget is capacity minus reserve minus headroom');
  assert.equal(admissionOnly.nodes.s.domains[0].budgetGb, 116);
  // By default the runtime memory guard's 90% ceiling caps unified memory too.
  const guarded = planPool({ nodes: [spark('s')], variants: [large], workloads: one() });
  assert.equal(guarded.nodes.s.domains[0].budgetGb, 111.2);
  const guardedAt95 = planPool({
    nodes: [spark('s')],
    variants: [large],
    workloads: one(),
    policy: { maxMemoryUtilization: 0.95, headroomGb: 4 }
  });
  assert.equal(guardedAt95.ok, false, 'the guard aborts a load the 95% admission budget would allow');
});

test('memory is accounted per domain on discrete GPUs', () => {
  const pc = {
    id: 'pc',
    platformId: 'linux-x64',
    computeArchs: ['sm_89'],
    accelerators: ['cuda'],
    memoryDomains: [
      { id: 'system:0', kind: 'system', capacityGb: 64 },
      { id: 'device:cuda:0', kind: 'device', capacityGb: 24 }
    ]
  };
  const small = {
    id: 'small',
    gatewayModel: 'small',
    requirements: { memoryGbPerNode: 18, systemMemoryGbPerNode: 30 }
  };
  const big = { id: 'big', gatewayModel: 'big', requirements: { memoryGbPerNode: 30 } };
  const plan = planPool({
    nodes: [pc],
    variants: [small, big],
    workloads: [
      { id: 'a', candidates: ['small'], residency: 'always' },
      { id: 'b', candidates: ['big'], residency: 'always' }
    ],
    policy: { reserveGb: 0, headroomGb: 0 }
  });
  assert.equal(plan.routes.a.model, 'small');
  assert.deepEqual(
    plan.nodes.pc.domains.map((domain) => [domain.id, domain.residentGb]),
    [
      ['system:0', 30],
      ['device:cuda:0', 18]
    ]
  );
  assert.equal(plan.uncovered[0].workload, 'b');
});

test('local search trades a faster model for full coverage', () => {
  const fast = {
    id: 'fast',
    gatewayModel: 'fast',
    requirements: { memoryGbPerNode: 80 },
    performance: { durationMs: 100 }
  };
  const slow = {
    id: 'slow',
    gatewayModel: 'slow',
    requirements: { memoryGbPerNode: 30 },
    performance: { durationMs: 900 }
  };
  const media = { id: 'media', gatewayModel: 'media', requirements: { memoryGbPerNode: 50 } };
  const plan = planPool({
    nodes: [spark('s')],
    variants: [fast, slow, media],
    workloads: [
      { id: 'chat', candidates: ['fast', 'slow'], residency: 'always', demandPerHour: 100 },
      { id: 'video', candidates: ['media'], residency: 'always', demandPerHour: 1 }
    ],
    policy: { maxMemoryUtilization: 0.95 }
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.routes.chat.model, 'slow');
  assert.equal(plan.routes.video.model, 'media');
});

test('external members are a fallback unless allowed or disabled', () => {
  const cloud = { id: 'cloud', gatewayModel: 'cloud', external: true, performance: { ttftMs: 100, decodeTps: 500 } };
  const local = { ...tp2, id: 'local', gatewayModel: 'local', requirements: { memoryGbPerNode: 40 } };
  const workloads = [{ id: 'chat', candidates: ['cloud', 'local'], residency: 'always', demandPerHour: 10 }];
  const fallback = planPool({ nodes: [spark('s')], variants: [cloud, local], workloads });
  assert.equal(fallback.routes.chat.model, 'local');
  const allowed = planPool({ nodes: [spark('s')], variants: [cloud, local], workloads, policy: { external: 'allow' } });
  assert.equal(allowed.routes.chat.model, 'cloud');
  const cordoned = planPool({
    nodes: [spark('s')],
    variants: [cloud, local],
    workloads,
    pins: { cordon: ['s'] }
  });
  assert.equal(cordoned.routes.chat.model, 'cloud');
  assert.equal(cordoned.score.external, 1);
  const never = planPool({
    nodes: [spark('s')],
    variants: [cloud, local],
    workloads,
    pins: { cordon: ['s'] },
    policy: { external: 'never' }
  });
  assert.equal(never.ok, false);
});

test('workload context and latency SLOs filter and rank variants', () => {
  const short = {
    ...tp2,
    id: 'short',
    gatewayModel: 'short',
    requirements: { memoryGbPerNode: 20, contextWindow: 32768 }
  };
  const long = {
    ...tp2,
    id: 'long',
    gatewayModel: 'long',
    requirements: { memoryGbPerNode: 40, contextWindow: 262144 }
  };
  const plan = planPool({
    nodes: [spark('s')],
    variants: [short, long],
    workloads: [{ id: 'chat', candidates: ['short', 'long'], slo: { contextWindow: 131072 } }]
  });
  assert.equal(plan.routes.chat.model, 'long');

  const quick = {
    ...tp2,
    id: 'quick',
    gatewayModel: 'quick',
    requirements: { memoryGbPerNode: 20 },
    performance: { ttftMs: 200, decodeTps: 10 }
  };
  const steady = {
    ...tp2,
    id: 'steady',
    gatewayModel: 'steady',
    requirements: { memoryGbPerNode: 20 },
    performance: { ttftMs: 1500, decodeTps: 200 }
  };
  const slo = planPool({
    nodes: [spark('s')],
    variants: [quick, steady],
    workloads: [{ id: 'voice', candidates: ['steady', 'quick'], slo: { ttftMs: 500 } }]
  });
  assert.equal(slo.routes.voice.model, 'quick');
  assert.equal(slo.score.sloMisses, 0);
});

test('missing weights and images add load cost to recipe placements', () => {
  const recipe = {
    ...tp2,
    id: 'recipe:fresh',
    gatewayModel: 'fresh',
    requirements: { memoryGbPerNode: 40, recipeId: 'fresh-recipe', diskGb: 40, images: ['vllm@sha256:1'] }
  };
  const cached = { ...spark('cached'), weights: ['fresh-recipe'], images: ['vllm@sha256:1'] };
  const plan = planPool({
    nodes: [spark('bare'), cached],
    variants: [recipe],
    workloads: [{ id: 'chat', candidates: ['fresh'], residency: 'always' }]
  });
  assert.deepEqual(plan.routes.chat.nodes, ['cached']);
  assert.deepEqual(
    plan.diff.start.map((entry) => entry.placement),
    ['recipe:fresh@cached']
  );
});

test('planning is deterministic', () => {
  const current = currentFromProfile('sparkqwen-pair-rc16', RC16_RUNNING);
  assert.deepEqual(planFleet({ current }), planFleet({ current }));
});

test('models served by one runtime share a single placement', () => {
  const image = {
    id: 'image@s',
    gatewayModel: 'image',
    runtime: 'comfy',
    nodes: ['s'],
    requirements: { memoryGbPerNode: 60 }
  };
  const edit = {
    id: 'edit@s',
    gatewayModel: 'edit',
    runtime: 'comfy',
    nodes: ['s'],
    requirements: { memoryGbPerNode: 60 }
  };
  const chat = {
    id: 'chat@s',
    gatewayModel: 'chat',
    runtime: 'llm',
    nodes: ['s'],
    requirements: { memoryGbPerNode: 50 }
  };
  const plan = planPool({
    nodes: [spark('s')],
    variants: [image, edit, chat],
    workloads: [
      { id: 'image-fast', candidates: ['image'], residency: 'always' },
      { id: 'image-edit', candidates: ['edit'], residency: 'always' },
      { id: 'chat', candidates: ['chat'], residency: 'always' }
    ],
    current: { running: ['image@s', 'edit@s'] },
    policy: { maxMemoryUtilization: 0.95 }
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.uncovered));
  assert.equal(plan.nodes.s.domains[0].residentGb, 110);
  const comfy = plan.placements.find((placement) => placement.runtime === 'comfy');
  assert.deepEqual(comfy.models, ['edit', 'image']);
  assert.deepEqual(comfy.workloads, ['image-edit', 'image-fast']);
  assert.equal(plan.routes['image-edit'].placement, plan.routes['image-fast'].placement);
  assert.deepEqual(plan.diff.release, []);
  assert.deepEqual(
    plan.diff.start.map((entry) => entry.placement),
    ['chat@s']
  );
  assert.equal(plan.residency.comfy, 'always');
});
