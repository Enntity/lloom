import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveUserConfig } from '../src/init.mjs';
import { loadRecipeById, planRecipe } from '../src/recipes.mjs';
import { dockerCreateArgs } from '../src/runtime-manager.mjs';
import { imageTagFor, loadPins, verifyPins } from '../backends/atlas-sparkglm/verify-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backends', 'atlas-sparkglm');
const tp4PinsPath = path.join(backendDir, 'pins-tp4.json');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-4x-glm53-atlas-tp4');
const pairRecipe = await loadRecipeById('linux-nvidia-dgx-spark-2x-glm53-atlas');
const pins = loadPins(tp4PinsPath);
const pairPins = loadPins();
const checkpointDir = 'nvidia--GLM-5.3-Flash-FP4-Local';
const gatewayModel = 'glm-5.3-flash-atlas-tp4';

// ---- recipe shape ---------------------------------------------------------
assert.equal(recipe.version, 1);
assert.equal(recipe.backend.id, pairRecipe.backend.id, 'the TP-4 lane reuses the Atlas SparkGLM backend');
assert.equal(recipe.license.id, 'MIT');
assert.deepEqual(recipe.requirements.cluster, { nodes: 4, topology: 'chain' });
assert.deepEqual(recipe.requirements.accelerators, pairRecipe.requirements.accelerators);
assert.deepEqual(
  recipe.setup.steps.map((step) => step.id),
  pairRecipe.setup.steps.map((step) => step.id)
);
for (const step of recipe.setup.steps) {
  const pairStep = pairRecipe.setup.steps.find((candidate) => candidate.id === step.id);
  assert.equal(step.alwaysRun, pairStep.alwaysRun, `${step.id} keeps the pair lane's revalidation`);
  if (step.action === 'download-model') assert.deepEqual(step, pairStep, 'same checkpoint and drafter as the pair');
}
const manifestArg = '${repoRoot}/backends/atlas-sparkglm/pins-tp4.json';
assert.deepEqual(recipe.setup.steps.find((step) => step.id === 'verify-atlas-pins').args, [
  '${repoRoot}/backends/atlas-sparkglm/verify-pins.mjs',
  manifestArg
]);
assert.deepEqual(recipe.setup.steps.find((step) => step.id === 'build-atlas-image').args, [
  '${repoRoot}/backends/atlas-sparkglm/install.sh',
  '--manifest',
  manifestArg,
  '--backend-root',
  '${backendRoot}',
  '--install-root',
  '${installRoot}'
]);

const model = recipe.models[0];
const pairModel = pairRecipe.models[0];
assert.equal(model.model, pins.model.repo);
assert.equal(model.gatewayModel, gatewayModel);
assert.equal(model.upstreamModel, gatewayModel);
assert.equal(model.setDefault, false);
assert(!Object.hasOwn(model, 'aliases'));
// A separate lane: nothing it materializes may collide with the pair lane.
for (const key of ['gatewayModel', 'runtime', 'backendConfig']) assert.notEqual(model[key], pairModel[key]);
assert.equal(model.settings.port, 8893, "serve.py fixes rank 0's port");
assert.equal(model.settings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(model.settings.warmup.body.model, gatewayModel);
assert.equal(model.settings.contextWindow, 1048576);
assert.equal(model.settings.maxActiveRequests, 4);
assert.equal(model.settings.memoryGb, 114);
assert.equal(model.settings.keepWarm, false);
// Not qualified at four ranks yet: the disk tier is off (the mount stays).
assert.equal(model.settings.prefixCacheGb, 0);

// ---- placement: workers from the far end of the chain, then the leader ------
const members = model.settings.placement.members;
assert.equal(model.settings.placement.mode, 'distributed');
assert.deepEqual(
  members.map((member) => [member.nodeRole, member.role, member.order, member.rankOrder]),
  [
    ['worker', 'worker', 10, 'descending'],
    ['leader', 'head', 20, undefined]
  ]
);
const [worker, leader] = members;
assert.equal(worker.healthStrategy, 'container');
assert.equal(worker.runtimeSettings.warmup, false);
assert.equal(leader.runtimeSettings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(leader.runtimeSettings.warmup.body.model, gatewayModel);

// Same hardening, limits and mounts as the pair lane; only the environment
// differs, and it is exactly what serve.py reads at four ranks.
const flagsOf = (args) => args.slice(0, args.indexOf('-e'));
const envOf = (args) => args.slice(args.indexOf('-e')).filter((arg, index) => index % 2 === 1);
const pairArgs = pairModel.settings.placement.members[0].runtimeSettings.bootstrap.createArgs;
const expectedEnv = [
  'NODE_RANK=${nodeRank}',
  'MASTER_ADDR=${leaderAddress}',
  'MASTER_PORT=29510',
  'FABRIC_INTERFACE=${fabricInterface}',
  'FABRIC_LEFT_HCA=${fabricLeftHca}',
  'FABRIC_RIGHT_HCA=${fabricRightHca}',
  'FABRIC_SIBLINGS=0',
  `MODEL_PATH=\${modelRoot}/${checkpointDir}`,
  'DRAFTER_PATH=${modelRoot}/incoai--GLM-5.3-Flash-DFlash2',
  `SERVED_MODEL_NAME=${gatewayModel}`,
  'SPARKGLM_PROFILE=4x1m-tp4',
  'SPARKGLM_GPU_MEMORY_UTILIZATION=0.88',
  'SPARKGLM_KV_SHARD=0',
  'SPARKGLM_DISPLAY_CARVEOUT=0',
  'SPARKGLM_PREFIX_CACHE_GB=${prefixCacheGb}',
  'NCCL_SOCKET_IFNAME=${fabricInterface}',
  'GLOO_SOCKET_IFNAME=${fabricInterface}',
  'HF_HUB_OFFLINE=1',
  'TRANSFORMERS_OFFLINE=1',
  'CUDA_CACHE_PATH=/atlas-cuda-cache'
];
for (const member of members) {
  const settings = member.runtimeSettings;
  const args = settings.bootstrap.createArgs;
  assert.equal(settings.adapter, 'docker');
  assert.equal(settings.management, 'managed');
  assert.equal(settings.containerName, 'lloom-atlas-sparkglm-tp4-${nodeId}', 'never the pair lane container');
  assert.equal(settings.bootstrap.image, pins.image.reference);
  assert.equal(settings.bootstrap.pull, false);
  assert.deepEqual(settings.bootstrap.command ?? [], []);
  assert.deepEqual(flagsOf(args), flagsOf(pairArgs));
  assert.deepEqual(
    args.slice(flagsOf(args).length).filter((arg, index) => index % 2 === 0),
    expectedEnv.map(() => '-e')
  );
  assert.deepEqual(envOf(args), expectedEnv);
  const rendered = args.join(' ');
  // Engine switches belong in the image's profile; serve.py drops ATLAS_* anyway.
  assert(!rendered.includes('ATLAS_'), 'no ATLAS_ variable in the recipe');
  // A chain takes per-side rails, and the profile owns NCCL's transport.
  assert(!/FABRIC_HCA=|NCCL_IB_HCA|NCCL_NET=|\$\{fabricHca\}/.test(rendered));
  assert(!rendered.includes('SYS_ADMIN'));
  assert(!/\b10\.\d+\.\d+\.\d+\b/.test(rendered), 'no host addresses');
  assert(!/spark0\d|ennspark/.test(rendered), 'no host names');
  assert(!/roce|mlx5|enp|enP/.test(rendered), 'no host device names');
}

// ---- pins: draft until a TP-4 release image exists --------------------------
assert.equal(pins.status, 'draft');
assert.equal(pins.image.profilePath, '/opt/atlas/profiles/4x1m-tp4.json');
assert.deepEqual(pins.model, pairPins.model);
assert.deepEqual(pins.drafter, pairPins.drafter);
for (const key of ['label', 'entrypoint', 'architecture']) assert.equal(pins.image[key], pairPins.image[key]);
assert.deepEqual(
  verifyPins(pins)
    .map((failure) => failure.split(' ')[0])
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort(),
  ['engine.commit', 'image.reference', 'image.tag', 'source.installTree', 'source.revision', 'status'],
  'only the release identities remain to fill in'
);
// Filling those identities is the only step left before the lane can install.
const filled = structuredClone(pins);
filled.status = 'final';
filled.source.revision = 'a'.repeat(40);
filled.source.installTree = 'b'.repeat(40);
filled.engine = { ...filled.engine, branch: 'sparkglm/atlas-tp4', commit: 'c'.repeat(40) };
filled.image.reference = `ghcr.io/enntity/atlas-sparkglm@sha256:${'d'.repeat(64)}`;
filled.image.tag = imageTagFor(filled);
assert.deepEqual(verifyPins(filled), []);
assert(!JSON.stringify({ ...filled, note: '' }).includes('TODO'));
for (const step of ['verify-atlas-pins', 'build-atlas-image']) {
  assert(recipe.setup.steps.find((entry) => entry.id === step).alwaysRun, `${step} gates every apply`);
}

const verifyRun = spawnSync('node', [path.join(backendDir, 'verify-pins.mjs'), tp4PinsPath], { encoding: 'utf8' });
assert.equal(verifyRun.status, 1, 'the draft manifest must fail closed');
assert.match(verifyRun.stderr, /TODO-TP4-RC/);
// The installer refuses the draft manifest before touching Docker.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tp4-'));
const fakeBin = path.join(tmpRoot, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'docker'), `#!/bin/sh\ntouch '${tmpRoot}/docker-called'\nexit 1\n`, {
  mode: 0o755
});
const installRun = spawnSync(
  'bash',
  [path.join(backendDir, 'install.sh'), '--manifest', tp4PinsPath, '--backend-root', tmpRoot],
  { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }
);
assert.notEqual(installRun.status, 0);
assert.match(installRun.stderr, /not a final immutable install manifest/);
assert(!fs.existsSync(path.join(tmpRoot, 'docker-called')), 'Docker must not run for a draft manifest');
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---- plan validity ---------------------------------------------------------
const plan = planRecipe(
  recipe,
  { models: [], runtimes: {} },
  {
    modelRoot: '/models',
    variables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' },
    platform: 'linux',
    arch: 'arm64',
    backendIds: new Set([recipe.backend.id]),
    checkLocalReferences: false
  }
);
assert.deepEqual(plan.validationErrors, []);
assert.deepEqual(plan.steps.find((step) => step.id === 'verify-atlas-pins').command, [
  'node',
  `${root}/backends/atlas-sparkglm/verify-pins.mjs`,
  tp4PinsPath
]);
assert.equal(plan.steps.find((step) => step.id === 'download-atlas-model').destination, `/models/${checkpointDir}`);

// ---- materialized chain: the hand-run launcher's wiring --------------------
// Four Sparks cabled 0-1-2-3, each port two RDMA devices (one per PCIe half).
// Addresses are documentation placeholders.
const portA = 'rocep1s0f0,roceP2p1s0f0';
const portB = 'rocep1s0f1,roceP2p1s0f1';
const chainNodes = {
  'spark-1': { iface: 'enP2p1s0f0np0', left: '', right: portA },
  'spark-2': { iface: 'enP2p1s0f0np0', left: portA, right: portB },
  'spark-3': { iface: 'enP2p1s0f1np1', left: portA, right: portB },
  'spark-4': { iface: 'enP2p1s0f1np1', left: portB, right: '' }
};
const cluster = {
  leaderNode: 'spark-1',
  nodes: Object.fromEntries(
    Object.entries(chainNodes).map(([id, wiring], rank) => [
      id,
      {
        backendHost: `192.0.2.${rank + 1}`,
        // The pair lane's own fabric settings stay untouched beside the chain.
        fabricInterface: 'enp1s0f0np0',
        fabricHca: 'rocep1s0f0',
        // The pair lane's worker; a chain takes its members from fabricChain.
        ...(rank === 1 ? { labels: { role: 'worker' } } : {}),
        fabricChain: {
          rank,
          interface: wiring.iface,
          ...(rank === 0 ? { address: '198.51.100.2' } : {}),
          ...(wiring.left ? { leftHca: wiring.left } : {}),
          ...(wiring.right ? { rightHca: wiring.right } : {})
        }
      }
    ])
  )
};
const baseConfig = {
  server: { host: '127.0.0.1', port: 8100 },
  security: {},
  defaults: {},
  models: [],
  backends: {},
  runtimes: {},
  aliases: {},
  clientCatalog: { modelOrder: [] },
  cluster
};
const options = {
  modelRoot: '/models',
  additive: true,
  backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
};
// Both lanes in one config: the pair keeps its own runtimes and containers.
const both = deriveUserConfig(deriveUserConfig(baseConfig, pairRecipe, options), recipe, options);
const logical = both.runtimes['glm53-flash-atlas-tp4-cluster'];
assert(both.runtimes['glm53-flash-atlas-cluster'], 'the pair lane remains');
assert.deepEqual(
  both.models.map((entry) => entry.id),
  ['glm-5.3-flash-atlas', gatewayModel]
);
assert.equal(logical.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(logical.warmup.body.model, gatewayModel);
const started = [...logical.placement.members].sort((left, right) => left.order - right.order);
assert.deepEqual(
  started.map((member) => [member.node, member.runtime, member.order]),
  [
    ['spark-4', 'glm53-flash-atlas-tp4-worker-spark-4', 10],
    ['spark-3', 'glm53-flash-atlas-tp4-worker-spark-3', 11],
    ['spark-2', 'glm53-flash-atlas-tp4-worker-spark-2', 12],
    ['spark-1', 'glm53-flash-atlas-tp4-head', 20]
  ]
);
const containers = new Set();
for (const member of started) {
  const runtime = both.runtimes[member.runtime];
  assert(!JSON.stringify(runtime).includes('${'), `${member.runtime} has an unresolved template`);
  const args = dockerCreateArgs(runtime);
  containers.add(args[args.indexOf('--name') + 1]);
  const envs = args.filter((arg, index) => args[index - 1] === '-e');
  const value = (key) => envs.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  const rank = Object.keys(chainNodes).indexOf(member.node);
  const wiring = chainNodes[member.node];
  assert.equal(value('NODE_RANK'), String(rank));
  assert.equal(value('MASTER_ADDR'), '198.51.100.2', "every rank meets at rank 0's chain address");
  assert.equal(value('FABRIC_INTERFACE'), wiring.iface);
  assert.equal(value('NCCL_SOCKET_IFNAME'), wiring.iface);
  assert.equal(value('GLOO_SOCKET_IFNAME'), wiring.iface);
  assert.equal(value('FABRIC_LEFT_HCA'), wiring.left);
  assert.equal(value('FABRIC_RIGHT_HCA'), wiring.right);
  assert.equal(value('SPARKGLM_PREFIX_CACHE_GB'), '0');
  assert.equal(value('MODEL_PATH'), `/models/${checkpointDir}`);
  assert.equal(args.at(-1), pins.image.reference, 'the image entrypoint runs unchanged');
  assert.equal(runtime.healthStrategy, rank === 0 ? 'http' : 'container');
}
assert.deepEqual(
  [...containers],
  ['spark-4', 'spark-3', 'spark-2', 'spark-1'].map((node) => `lloom-atlas-sparkglm-tp4-${node}`)
);
for (const runtimeId of ['glm53-flash-atlas-head', 'glm53-flash-atlas-worker']) {
  assert.equal(both.runtimes[runtimeId].containerName.startsWith('lloom-atlas-sparkglm-tp4-'), false);
}
assert.deepEqual(
  both.runtimes['glm53-flash-atlas-cluster'].placement.members.map((member) => member.node),
  ['spark-2', 'spark-1'],
  'the pair lane stays on its two Sparks'
);
// Without the worker label the pair recipe would select every other node; its
// declared node count refuses that instead of materializing a broken pair.
const unlabeled = structuredClone(baseConfig);
delete unlabeled.cluster.nodes['spark-2'].labels;
assert.throws(() => deriveUserConfig(unlabeled, pairRecipe, options), /needs 2 cluster nodes but selects 4/);

// ---- the recipe must be indexed -------------------------------------------
const index = JSON.parse(await fs.promises.readFile(path.join(root, 'recipes', 'index.json'), 'utf8'));
const entry = index.recipes.find((item) => item.id === recipe.id);
assert(entry, 'the TP-4 recipe must be listed in recipes/index.json');
assert.equal(entry.path, 'linux-nvidia-dgx-spark-4x-glm53-atlas-tp4.json');
assert.equal(entry.currentVersion, recipe.version);
assert.equal(entry.versions.filter((version) => version.status === 'current').length, 1);
assert.match(`${entry.summary} ${entry.versions[0].notes}`, /draft|DRAFT/);

console.log('Atlas SparkGLM TP-4 recipe checks passed');
