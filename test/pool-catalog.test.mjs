// Pool catalog and planner-input tests: recipes, installed config, node status
// and metrics become planner variants, workloads, pins and current state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPoolCatalog,
  buildPoolPlanInputs,
  currentPoolState,
  plannerNodesFromStatus,
  poolPinsFromConfig,
  poolWorkloadsFromConfig,
  recipeServingRequirements
} from '../src/pool-catalog.mjs';
import { planPool } from '../src/pool-planner.mjs';
import { validateRecipe } from '../src/recipes.mjs';

const tp2Recipe = JSON.parse(
  readFileSync(new URL('../recipes/linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm.json', import.meta.url), 'utf8')
);

test('serving requirements are inferred from an existing two-Spark recipe', () => {
  const requirements = recipeServingRequirements(tp2Recipe, tp2Recipe.models[0]);
  assert.equal(requirements.recipeId, tp2Recipe.id);
  assert.equal(requirements.nodeCount, 2);
  assert.equal(requirements.tensorParallel, 2);
  assert.deepEqual(requirements.computeArchs, ['sm_121']);
  assert.deepEqual(requirements.platforms, ['linux-arm64']);
  assert.equal(requirements.memoryGbPerNode, 110);
  assert.equal(requirements.contextWindow, 262144);
  assert.equal(requirements.maxSequences, 8);
  assert.equal(requirements.backend, 'docker-vllm');
  assert.equal(requirements.diskGb, 170);
  assert.deepEqual(requirements.images, [
    'vllm/vllm-openai@sha256:df871f170ee7070fbdce162bde08fb616e311570c948a620be0d4b33fe02f87b'
  ]);
  assert.deepEqual(requirements.inferred.sort(), ['computeArchs', 'maxSequences', 'tensorParallel']);
});

test('explicit recipe serving fields override inference', () => {
  const recipe = {
    id: 'four-way',
    backend: { id: 'vllm' },
    requirements: {
      platforms: ['linux-x64'],
      accelerators: ['cuda'],
      computeArchs: ['sm_100'],
      tensorParallel: 4,
      memoryGb: 300,
      cluster: { nodes: 1 }
    },
    models: [{ model: 'org/m', gatewayModel: 'm', settings: { maxSequences: 16, contextWindow: 8192 } }]
  };
  const requirements = recipeServingRequirements(recipe, recipe.models[0]);
  assert.equal(requirements.nodeCount, 1);
  assert.equal(requirements.tensorParallel, 4);
  assert.deepEqual(requirements.computeArchs, ['sm_100']);
  assert.equal(requirements.memoryGbPerNode, 300);
  assert.equal(requirements.maxSequences, 16);
  assert.deepEqual(requirements.inferred, []);
});

test('recipe validation checks the structured serving fields', () => {
  const recipe = (requirements, settings = {}) => ({
    schemaVersion: 1,
    id: 'r',
    name: 'R',
    backend: { id: 'vllm' },
    requirements,
    models: [{ role: 'default', model: 'org/m', settings }]
  });
  const check = (...args) => validateRecipe(recipe(...args), {}, { checkLocalReferences: false });
  assert.deepEqual(check({ computeArchs: ['sm_121a', 'apple-metal'], tensorParallel: 2 }, { maxSequences: 8 }), []);
  assert.deepEqual(check({ computeArchs: ['blackwell'] }), [
    'recipe r requirements.computeArchs must list sm_<capability> or apple-metal'
  ]);
  assert.deepEqual(check({ tensorParallel: 0 }), ['recipe r requirements.tensorParallel must be a positive integer']);
  assert.deepEqual(check({}, { maxSequences: 1.5 }), [
    'recipe r model default settings.maxSequences must be a positive integer'
  ]);
});

function fleetConfig() {
  return {
    cluster: {
      nodeId: 'spark-node-03',
      nodes: {
        'spark-node-03': { resources: { memoryGb: 128, accelerators: ['cuda', 'gb10'] } },
        'spark-node-01': { endpoint: 'http://01:8100', resources: { memoryGb: 128, maxMemoryUtilization: 0.9 } },
        'spark-node-02': { endpoint: 'http://02:8100', resources: { memoryGb: 128 } }
      },
      discovery: { links: [{ nodeId: 'spark-node-01', peerNodeId: 'spark-node-02' }] }
    },
    runtimePolicy: { maxMemoryUtilization: 0.95 },
    backends: {
      q27: { type: 'openai', baseUrl: 'http://127.0.0.1:8213/v1' },
      emb: { type: 'openai', baseUrl: 'http://127.0.0.1:8214/v1' },
      atlas: { type: 'openai', baseUrl: 'http://192.0.2.10:8894/v1' },
      openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
      old: { type: 'openai', baseUrl: 'http://127.0.0.1:8299/v1' }
    },
    runtimes: {
      'qwen38-27b-nvfp4': { enabled: true, memoryGb: 46, maxActiveRequests: 2, recipe: { id: 'spark-27b' } },
      'qwen3-embedding-4b': { enabled: true, memoryGb: 16, keepWarm: true },
      retired: { enabled: false, memoryGb: 60 }
    },
    models: [
      { id: 'qwen38-27b-nvfp4', kind: 'chat', backend: 'q27', runtime: 'qwen38-27b-nvfp4', contextWindow: 262144 },
      { id: 'Qwen/Qwen3-Embedding-4B', kind: 'embedding', backend: 'emb', runtime: 'qwen3-embedding-4b' },
      {
        id: 'qwen3.8-flash-next-atlas',
        kind: 'chat',
        backend: 'atlas',
        contextWindow: 262144,
        pool: { nodes: ['spark-node-01', 'spark-node-02'], memoryGbPerNode: 110 }
      },
      { id: 'cloud/openrouter/q38fn', kind: 'chat', backend: 'openrouter' },
      { id: 'retired-model', kind: 'chat', backend: 'old', runtime: 'retired' }
    ],
    aliases: {
      'chat-capable': {
        members: ['qwen3.8-flash-next-atlas'],
        routeProfiles: {
          local: { members: ['qwen38-27b-nvfp4'] },
          cloud: { members: ['q38fn'] },
          pair: { members: ['qwen3.8-flash-next-atlas'] }
        },
        activeRoute: 'pair'
      },
      q38fn: { members: ['cloud/openrouter/q38fn'] },
      embeddings: { members: ['Qwen/Qwen3-Embedding-4B'] },
      quiet: { members: ['qwen38-27b-nvfp4', 'retired-model'], suspendedMembers: ['retired-model'] }
    },
    pool: {
      workloads: { quiet: { residency: 'auto', required: false, slo: { ttftMs: 2000 } } },
      cordon: ['spark-node-02']
    }
  };
}

const sparkProfile = (memoryGb = 119.7) => ({
  platformId: 'linux-arm64',
  totalMemoryGb: memoryGb,
  accelerators: ['cuda', 'nvidia-gpu', 'blackwell', 'gb10'],
  devices: [{ id: 'cuda:0', kind: 'gpu', vendor: 'nvidia', backend: 'cuda', computeCapability: '12.1' }],
  memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: memoryGb }]
});

function fleetStatuses() {
  return {
    'spark-node-03': {
      reachable: true,
      profile: sparkProfile(),
      inventory: {
        computeArchs: ['sm_121'],
        memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 119.7 }],
        weights: [{ recipeId: 'spark-27b', complete: true }],
        backends: { dockerImages: ['vllm/vllm-openai@sha256:abc'] },
        links: []
      },
      runtimeManager: {
        runtimes: {
          'qwen3-embedding-4b': { status: 'running', memoryUsage: { residentBytes: 20 * 1024 ** 3 } },
          'qwen38-27b-nvfp4': { status: 'stopped' },
          'tts-sidecar': { status: 'external' }
        }
      }
    },
    'spark-node-01': { reachable: true, profile: sparkProfile() },
    'spark-node-02': { reachable: false, profile: null }
  };
}

// Shape of GET /gateway/metrics?period=7d: id-keyed bucket arrays.
const metrics = {
  period: '7d',
  models: [
    { id: 'qwen38-27b-nvfp4', requests: 50, avgFirstContentMs: 900, decodeTokensPerSecond: 28, avgDurationMs: 9000 },
    { id: 'qwen3.8-flash-next-atlas', requests: 2, avgFirstContentMs: 100, decodeTokensPerSecond: 500 }
  ],
  routes: [{ id: '/v1/chat/completions', requests: 1764 }],
  requested: [
    { id: 'chat-capable', requests: 1680 },
    { id: 'embeddings', requests: 84 },
    { id: 'quiet', requests: 0 }
  ]
};

test('the catalog groups installed lanes, recipes and evidence by model', () => {
  const catalog = buildPoolCatalog({
    config: fleetConfig(),
    recipes: [tp2Recipe],
    benchmarks: [
      {
        id: 'bench-atlas',
        recipeId: 'none',
        gatewayModel: 'qwen3.8-flash-next-atlas',
        metrics: { timeToFirstTokenMs: 450, generationTokPerSec: 75 }
      }
    ],
    metrics,
    nodeStatuses: fleetStatuses()
  });
  const byId = Object.fromEntries(catalog.variants.map((variant) => [variant.id, variant]));

  const q27 = byId['qwen38-27b-nvfp4@spark-node-03'];
  assert.deepEqual(q27.nodes, ['spark-node-03']);
  assert.equal(q27.runtime, 'qwen38-27b-nvfp4');
  assert.equal(q27.requirements.memoryGbPerNode, 46);
  assert.equal(q27.requirements.recipeId, 'spark-27b');
  assert.equal(q27.requirements.maxSequences, 2);
  assert.deepEqual(q27.performance, { ttftMs: 900, decodeTps: 28, durationMs: 9000, source: 'live-metrics' });

  const embedding = byId['Qwen/Qwen3-Embedding-4B@spark-node-03'];
  assert.equal(embedding.requirements.memoryGbPerNode, 20, 'measured footprint above the estimate wins');
  assert.deepEqual(embedding.measured, { memoryGbPerNode: 20, source: 'live-rss' });

  const atlas = byId['qwen3.8-flash-next-atlas@spark-node-01+spark-node-02'];
  assert.equal(atlas.managed, false);
  assert.deepEqual(atlas.nodes, ['spark-node-01', 'spark-node-02']);
  assert.equal(atlas.requirements.memoryGbPerNode, 110);
  assert.deepEqual(atlas.performance, { ttftMs: 450, decodeTps: 75, source: 'benchmark:bench-atlas' });

  assert.equal(byId['cloud/openrouter/q38fn'].external, true);
  assert.ok(!catalog.variants.some((variant) => variant.runtime === 'retired'));

  const recipeVariant = byId[`recipe:${tp2Recipe.id}:qwen3.8-flash-next`];
  assert.equal(recipeVariant.nodes, undefined);
  assert.equal(recipeVariant.requirements.nodeCount, 2);
  assert.equal(recipeVariant.source, 'recipe');

  const flashNext = catalog.models.find((model) => model.model === 'nvidia/Qwen3.8-Flash-Next-NVFP4');
  assert.deepEqual(
    flashNext.variants.map((variant) => variant.id),
    [`recipe:${tp2Recipe.id}:qwen3.8-flash-next`]
  );
});

test('a memory-safety abort raises the footprint to its lower bound and latches the lane out of the plan', () => {
  const statuses = fleetStatuses();
  statuses['spark-node-03'].runtimeManager.runtimes['qwen38-27b-nvfp4'] = {
    status: 'failed',
    memorySafetyLatched: true,
    memorySafetyAbort: { at: '2026-10-11T00:00:00.000Z', usedGb: 115, consumedGb: 61 }
  };
  const catalog = buildPoolCatalog({
    config: fleetConfig(),
    recipes: [],
    benchmarks: [],
    metrics,
    nodeStatuses: statuses
  });
  const q27 = catalog.variants.find((variant) => variant.id === 'qwen38-27b-nvfp4@spark-node-03');
  assert.equal(q27.requirements.memoryGbPerNode, 61, 'the aborted load needed at least 61 GB');
  assert.deepEqual(q27.excludeNodes, ['spark-node-03']);
  assert.match(q27.excludeReason, /memory safety abort/);

  // Once someone retries it by hand the latch clears, but the evidence stays.
  statuses['spark-node-03'].runtimeManager.runtimes['qwen38-27b-nvfp4'].memorySafetyLatched = false;
  const retried = buildPoolCatalog({
    config: fleetConfig(),
    recipes: [],
    benchmarks: [],
    metrics,
    nodeStatuses: statuses
  });
  const after = retried.variants.find((variant) => variant.id === 'qwen38-27b-nvfp4@spark-node-03');
  assert.equal(after.requirements.memoryGbPerNode, 61);
  assert.equal(after.excludeNodes, undefined);
});

test('workloads come from alias routes, pool overrides and observed demand', () => {
  const workloads = Object.fromEntries(
    poolWorkloadsFromConfig(fleetConfig(), { metrics }).map((workload) => [workload.id, workload])
  );
  assert.deepEqual(workloads['chat-capable'].candidates, [
    'qwen3.8-flash-next-atlas',
    'qwen38-27b-nvfp4',
    'cloud/openrouter/q38fn'
  ]);
  assert.equal(workloads['chat-capable'].demandPerHour, 10);
  assert.equal(workloads['chat-capable'].residency, 'always');
  assert.equal(workloads.embeddings.residency, 'always');
  assert.deepEqual(workloads.quiet.candidates, ['qwen38-27b-nvfp4']);
  assert.equal(workloads.quiet.residency, 'auto');
  assert.equal(workloads.quiet.required, false);
  assert.deepEqual(workloads.quiet.slo, { ttftMs: 2000 });

  // Gateways that predate per-alias metrics: a model's demand is split across
  // the aliases routed to it.
  const legacy = Object.fromEntries(
    poolWorkloadsFromConfig(fleetConfig(), {
      metrics: { period: '7d', models: [{ id: 'qwen38-27b-nvfp4', requests: 336 }] }
    }).map((workload) => [workload.id, workload])
  );
  assert.equal(legacy.quiet.demandPerHour, 2);
  assert.equal(legacy.embeddings.demandPerHour, 0);

  const offline = Object.fromEntries(poolWorkloadsFromConfig(fleetConfig()).map((workload) => [workload.id, workload]));
  assert.equal(offline.embeddings.residency, 'always', 'without metrics the current keep-warm runtime decides');
  assert.equal(offline['chat-capable'].residency, 'auto');
});

test('pins, cordons and current state come from config and node status', () => {
  const config = fleetConfig();
  const pins = poolPinsFromConfig(config, {
    profile: { routes: { embeddings: 'Qwen/Qwen3-Embedding-4B' } },
    cordon: ['spark-node-01'],
    routes: { 'chat-capable': 'qwen38-27b-nvfp4' }
  });
  assert.deepEqual(pins.residency, { 'qwen3-embedding-4b': 'always' });
  assert.deepEqual(pins.routes, {
    embeddings: 'Qwen/Qwen3-Embedding-4B',
    'chat-capable': 'qwen38-27b-nvfp4'
  });
  assert.deepEqual(pins.cordon, ['spark-node-01', 'spark-node-02']);

  const catalog = buildPoolCatalog({ config, nodeStatuses: fleetStatuses() });
  const current = currentPoolState(config, { nodeStatuses: fleetStatuses(), variants: catalog.variants });
  assert.equal(current.routes['chat-capable'], 'qwen3.8-flash-next-atlas');
  assert.equal(current.routes.quiet, 'qwen38-27b-nvfp4');
  assert.deepEqual(current.residency, { 'qwen38-27b-nvfp4': 'auto', 'qwen3-embedding-4b': 'always' });
  assert.deepEqual(current.running.sort(), [
    'Qwen/Qwen3-Embedding-4B@spark-node-03',
    'qwen3.8-flash-next-atlas@spark-node-01+spark-node-02'
  ]);
});

test('planner nodes merge inventory, profiles, configured resources and links', () => {
  const nodes = Object.fromEntries(
    plannerNodesFromStatus(fleetConfig(), fleetStatuses()).map((node) => [node.id, node])
  );
  assert.deepEqual(nodes['spark-node-03'].weights, ['spark-27b']);
  assert.deepEqual(nodes['spark-node-03'].images, ['vllm/vllm-openai@sha256:abc']);
  assert.deepEqual(
    nodes['spark-node-01'].computeArchs,
    ['sm_121'],
    'derived from the profile when inventory is absent'
  );
  assert.deepEqual(nodes['spark-node-01'].links, ['spark-node-02']);
  assert.equal(nodes['spark-node-01'].maxMemoryUtilization, 0.9);
  assert.equal(nodes['spark-node-02'].available, false);
  assert.deepEqual(nodes['spark-node-02'].memoryDomains, [{ id: 'memory', kind: 'unified', capacityGb: 128 }]);
});

test('planner inputs from config produce a coherent plan', () => {
  const inputs = buildPoolPlanInputs({
    config: fleetConfig(),
    nodeStatuses: fleetStatuses(),
    metrics,
    recipes: [tp2Recipe]
  });
  assert.equal(inputs.policy.maxMemoryUtilization, 0.95);
  assert.ok(!inputs.variants.some((variant) => variant.source === 'recipe'), 'installs are opt-in');
  const plan = planPool(inputs);
  // spark-node-02 is cordoned and unreachable, so the pair lane cannot serve.
  assert.equal(plan.routes['chat-capable'].model, 'qwen38-27b-nvfp4');
  assert.equal(plan.routes.embeddings.model, 'Qwen/Qwen3-Embedding-4B');
  assert.equal(plan.residency['qwen38-27b-nvfp4'], 'always');
  assert.deepEqual(plan.diff.routeChanges, [
    { alias: 'chat-capable', from: 'qwen3.8-flash-next-atlas', to: 'qwen38-27b-nvfp4' }
  ]);
  assert.deepEqual(
    plan.diff.manual.map((entry) => entry.action),
    ['manual-stop']
  );
});
