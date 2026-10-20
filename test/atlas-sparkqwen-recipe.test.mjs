import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackend, loadBackendCatalog, planBackend } from '../src/backend-catalog.mjs';
import { deriveUserConfig } from '../src/init.mjs';
import { loadRecipeById, planRecipe } from '../src/recipes.mjs';
import {
  IMAGE_REFERENCE_PATTERN,
  IMAGE_REPOSITORY,
  imageTagFor,
  loadPins,
  verifyPins
} from '../backends/atlas-sparkqwen/verify-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backends', 'atlas-sparkqwen');
const recipeId = 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas';
const recipe = await loadRecipeById(recipeId);
const catalog = await loadBackendCatalog();
const pins = loadPins();
const checkpoint = 'nvidia--Qwen3.8-Flash-Next-FP4-Local';

// ---- backend catalog entry --------------------------------------------------
const backend = getBackend(catalog, 'docker-atlas-sparkqwen');
assert(backend, 'docker-atlas-sparkqwen backend must be packaged');
assert(backend.commands.includes('docker'));
assert.equal(backend.server.protocol, 'openai');
assert.equal(backend.server.healthPath, '/health');
assert.equal(backend.server.chatPath, '/v1/chat/completions');
assert.deepEqual(
  backend.setup.map((step) => step.id),
  ['check-docker', 'check-atlas-pins']
);
assert.equal(backend.setup.find((step) => step.id === 'check-atlas-pins').alwaysRun, true);
assert(backend.features.includes('vision'), 'bounded image evidence is exposed');
const plannedBackend = await planBackend(backend, { checkCommands: false });
assert(plannedBackend.steps.every((step) => !step.command.join(' ').includes('${')));

// ---- recipe shape -----------------------------------------------------------
assert.equal(recipe.id, recipeId);
assert.equal(recipe.version, 2);
assert.equal(recipe.backend.id, 'docker-atlas-sparkqwen');
assert.equal(recipe.license.id, 'MIT');
assert.deepEqual(recipe.requirements.cluster, { nodes: 2, provider: 'nvidia-sync', topology: 'direct' });
assert(recipe.requirements.accelerators.includes('gb10'));
const stepIds = [
  'check-docker',
  'verify-atlas-pins',
  'download-atlas-model',
  'pull-atlas-image',
  'prepare-atlas-cuda-cache',
  'prepare-atlas-ple-cache'
];
assert.deepEqual(
  recipe.setup.steps.map((step) => step.id),
  stepIds
);
for (const stepId of ['verify-atlas-pins', 'pull-atlas-image', 'prepare-atlas-cuda-cache', 'prepare-atlas-ple-cache']) {
  assert.equal(recipe.setup.steps.find((step) => step.id === stepId).alwaysRun, true, `${stepId} must always run`);
}
const downloadStep = recipe.setup.steps.find((step) => step.id === 'download-atlas-model');
assert.equal(downloadStep.provider, 'huggingface');
assert.equal(downloadStep.model, pins.model.repo);
assert.equal(downloadStep.revision, pins.model.revision);
assert.equal(pins.model.revision, 'b9ce18a6887e18c089fdea8509a33e63429a3300');

const model = recipe.models[0];
assert.equal(recipe.models.length, 1);
assert.equal(model.model, 'nvidia/Qwen3.8-Flash-Next-FP4-Local');
assert.equal(model.gatewayModel, 'qwen3.8-flash-next-atlas');
assert.equal(model.upstreamModel, 'qwen3.8-flash-next-atlas');
assert.equal(model.runtime, 'qwen38-flash-next-atlas-cluster');
// Additive lane: never take over the default route, never add aliases.
assert.equal(model.setDefault, false);
assert(!Object.hasOwn(model, 'aliases'));
assert.equal(model.settings.keepWarm, false);
assert.deepEqual(model.input, ['text', 'image']);
for (const capability of ['tools', 'reasoning', 'streaming', 'structured-output']) {
  assert(model.capabilities.includes(capability), `missing capability ${capability}`);
}
assert(model.capabilities.includes('vision'));
assert(recipe.capabilities.includes('vision'));
assert(recipe.hardware.notes.some((n) => n.includes('header admission only')));
// serve.py binds rank 0 to 127.0.0.1:8893; the port is not configurable.
assert.equal(model.settings.port, 8893);
assert.equal(model.settings.baseUrl, 'http://127.0.0.1:8893/v1');
assert.equal(model.settings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(model.settings.contextWindow, 262144);
assert.equal(model.settings.maxActiveRequests, 8);
assert.equal(model.settings.memoryGb, 104);

// ---- distributed placement --------------------------------------------------
const members = model.settings.placement.members;
assert.equal(model.settings.placement.mode, 'distributed');
assert.deepEqual(
  members.map((member) => [member.nodeRole, member.role, member.order]),
  [
    ['worker', 'worker', 10],
    ['leader', 'head', 20]
  ]
);
const [worker, leader] = members;
assert.equal(worker.healthStrategy, 'container');
assert.equal(worker.runtimeSettings.warmup, false);
assert.equal(leader.runtimeSettings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(leader.runtimeSettings.warmup.method, 'POST');
assert.equal(leader.runtimeSettings.warmup.body.model, 'qwen3.8-flash-next-atlas');

const expectedCreateArgs = [
  '--restart no',
  '--network host',
  '--ipc host',
  '--shm-size 32g',
  '--memory 104g',
  '--gpus all',
  '--device /dev/infiniband:/dev/infiniband',
  '--cap-add IPC_LOCK',
  '--cap-add SYS_NICE',
  '--ulimit memlock=-1:-1',
  '--security-opt no-new-privileges=true',
  '--stop-timeout 60',
  `--mount type=bind,src=\${modelRoot}/${checkpoint},dst=\${modelRoot}/${checkpoint},readonly`,
  '--mount type=bind,src=${installRoot}/atlas-sparkqwen-cuda-cache,dst=/atlas-cuda-cache',
  '--mount type=bind,src=${installRoot}/atlas-sparkqwen-ple/a0cebe89737898692964d3923477bef293a4ebde9dd32e27202697c54f763c9d/b9ce18a6887e18c089fdea8509a33e63429a3300,dst=/atlas-ple',
  '-e NODE_RANK=${nodeRank}',
  '-e MASTER_ADDR=${leaderAddress}',
  '-e MASTER_PORT=29510',
  '-e FABRIC_INTERFACE=${fabricInterface}',
  '-e FABRIC_HCA=${fabricHca}',
  '-e FABRIC_SIBLINGS=0',
  `-e MODEL_PATH=\${modelRoot}/${checkpoint}`,
  '-e SERVED_MODEL_NAME=qwen3.8-flash-next-atlas',
  '-e SPARKQWEN_PROFILE=8x262k',
  '-e SPARKQWEN_GPU_MEMORY_UTILIZATION=0.80',
  '-e SPARKQWEN_FP8_GDN=0',
  '-e NCCL_SOCKET_IFNAME=${fabricInterface}',
  '-e GLOO_SOCKET_IFNAME=${fabricInterface}',
  '-e NCCL_IB_HCA=${fabricHca}',
  '-e CUDA_CACHE_PATH=/atlas-cuda-cache',
  '-e CUDA_CACHE_MAXSIZE=4294967296'
];
for (const member of members) {
  const settings = member.runtimeSettings;
  assert.equal(member.resources.memoryGb, 104);
  assert.equal(settings.adapter, 'docker');
  assert.equal(settings.management, 'managed');
  assert.equal(settings.containerName, 'lloom-atlas-sparkqwen-${nodeId}');
  assert.equal(settings.bootstrap.image, pins.image.reference);
  assert.equal(settings.bootstrap.pull, false, 'only the prepared image is started');
  assert.deepEqual(settings.bootstrap.command ?? [], [], 'use the image entrypoint');
  const rendered = settings.bootstrap.createArgs.join(' ');
  for (const expected of expectedCreateArgs) assert(rendered.includes(expected), `missing ${expected}`);
  // The profile owns every engine tuning value; serve.py drops ambient ATLAS_*.
  // LLooM supplies the exact rails: no guessable default, no hard-coded device.
  assert(!/\bATLAS_|rocep1s0f0/.test(rendered));
  assert(!/\b10\.\d+\.\d+\.\d+\b/.test(rendered));
  assert(!/spark0\d/.test(rendered));
}
assert.deepEqual(worker.runtimeSettings.bootstrap.createArgs, leader.runtimeSettings.bootstrap.createArgs);

// ---- plan validity ----------------------------------------------------------
const plan = planRecipe(
  recipe,
  { models: [], runtimes: {} },
  {
    modelRoot: '/models',
    variables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' },
    platform: 'linux',
    arch: 'arm64',
    backendIds: new Set(['docker-atlas-sparkqwen']),
    checkLocalReferences: false
  }
);
assert.deepEqual(plan.validationErrors, []);
assert.deepEqual(
  plan.steps.map((step) => step.id),
  stepIds
);
assert.equal(plan.steps.find((step) => step.id === 'download-atlas-model').destination, `/models/${checkpoint}`);
assert.deepEqual(plan.steps.find((step) => step.id === 'pull-atlas-image').command, [
  'bash',
  `${root}/backends/atlas-sparkqwen/install.sh`
]);
assert.deepEqual(plan.steps.find((step) => step.id === 'prepare-atlas-cuda-cache').command, [
  'mkdir',
  '-p',
  '/install/atlas-sparkqwen-cuda-cache'
]);
for (const step of plan.steps.filter((entry) => entry.action === 'command')) {
  assert(!step.command.join(' ').includes('${'), `unresolved recipe template in ${step.id}`);
}

// ---- materialization on the 03/04 pair (TP link on port 1) -----------------
const pairConfig = (nodes, extra = {}) => ({
  server: { host: '127.0.0.1', port: 8100 },
  security: {},
  defaults: {},
  models: [],
  backends: {},
  runtimes: {},
  aliases: {},
  clientCatalog: { modelOrder: [] },
  cluster: { leaderNode: 'ennspark03', nodes },
  ...extra
});
const materialize = (config) =>
  deriveUserConfig(config, recipe, {
    modelRoot: '/models',
    additive: true,
    backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
  });
const envOf = (runtime) => {
  const args = runtime.bootstrap.createArgs;
  return Object.fromEntries(
    args
      .flatMap((arg, index) => (args[index - 1] === '-e' ? [arg] : []))
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])
  );
};

const pair = materialize(
  pairConfig(
    {
      ennspark03: { backendHost: '10.0.3.1', fabricInterface: 'enp1s0f1np1', fabricHca: 'rocep1s0f1' },
      ennspark04: {
        backendHost: '10.0.3.2',
        fabricInterface: 'enp1s0f1np1',
        fabricHca: 'rocep1s0f1',
        labels: { role: 'worker' }
      }
    },
    {
      defaults: { chatModel: 'existing-model' },
      models: [{ id: 'existing-model', advertise: true }],
      aliases: { existing: { members: ['existing-model'], advertise: true } },
      clientCatalog: { modelOrder: ['existing-model'] }
    }
  )
);
// Additive: the existing default and alias are untouched.
assert.equal(pair.defaults.chatModel, 'existing-model');
assert.deepEqual(pair.aliases.existing, { members: ['existing-model'], advertise: true });
assert(pair.clientCatalog.modelOrder.includes('qwen3.8-flash-next-atlas'));
assert.equal(pair.backends['qwen38-flash-next-atlas'].baseUrl, 'http://127.0.0.1:8893/v1');
const cluster = pair.runtimes['qwen38-flash-next-atlas-cluster'];
assert.equal(cluster.keepWarm, false);
assert.equal(cluster.healthUrl, 'http://127.0.0.1:8893/health');
assert.deepEqual(
  cluster.placement.members.map((member) => [member.node, member.runtime, member.role, member.order]),
  [
    ['ennspark04', 'qwen38-flash-next-atlas-worker', 'worker', 10],
    ['ennspark03', 'qwen38-flash-next-atlas-head', 'head', 20]
  ]
);
const head = pair.runtimes['qwen38-flash-next-atlas-head'];
const tail = pair.runtimes['qwen38-flash-next-atlas-worker'];
assert.equal(head.node, 'ennspark03');
assert.equal(tail.node, 'ennspark04');
assert.equal(tail.healthStrategy, 'container');
for (const [runtime, nodeId, rank] of [
  [head, 'ennspark03', '0'],
  [tail, 'ennspark04', '1']
]) {
  assert(!JSON.stringify(runtime).includes('${'), `${nodeId} runtime has an unresolved template`);
  assert.equal(runtime.containerName, `lloom-atlas-sparkqwen-${nodeId}`);
  const env = envOf(runtime);
  assert.equal(env.NODE_RANK, rank);
  assert.equal(env.MASTER_ADDR, '10.0.3.1');
  assert.equal(env.FABRIC_INTERFACE, 'enp1s0f1np1');
  assert.equal(env.FABRIC_HCA, 'rocep1s0f1', `${nodeId} must use the explicit per-node RoCE device`);
  assert.equal(env.NCCL_IB_HCA, 'rocep1s0f1', `${nodeId} must pass its RoCE device to NCCL`);
  assert.equal(env.FABRIC_SIBLINGS, '0', `${nodeId} must forbid implicit sibling rails`);
  assert.equal(env.NCCL_SOCKET_IFNAME, 'enp1s0f1np1');
  assert.equal(env.MODEL_PATH, `/models/${checkpoint}`);
  const args = runtime.bootstrap.createArgs.join(' ');
  assert(args.includes(`src=/models/${checkpoint},dst=/models/${checkpoint},readonly`));
  assert(args.includes('src=/install/atlas-sparkqwen-cuda-cache,dst=/atlas-cuda-cache'));
}

// LLooM never infers an HCA from the NIC name: each node must declare its own
// exact, node-local set (names and physical ports can differ between nodes).
// Distinct explicit lists stay exactly as configured, and NCCL_IB_HCA mirrors
// the same per-node value.
const perNodeFabric = materialize(
  pairConfig({
    ennspark03: { backendHost: '10.0.3.1', fabricInterface: 'enp1s0f1np1', fabricHca: 'roceP2p1s0f1' },
    ennspark04: { backendHost: '10.0.3.2', fabricInterface: 'ens7', fabricHca: 'mlx5_7,mlx5_9', labels: {} }
  })
);
assert.equal(envOf(perNodeFabric.runtimes['qwen38-flash-next-atlas-head']).FABRIC_HCA, 'roceP2p1s0f1');
assert.equal(envOf(perNodeFabric.runtimes['qwen38-flash-next-atlas-head']).NCCL_IB_HCA, 'roceP2p1s0f1');
assert.equal(envOf(perNodeFabric.runtimes['qwen38-flash-next-atlas-worker']).FABRIC_HCA, 'mlx5_7,mlx5_9');
assert.equal(envOf(perNodeFabric.runtimes['qwen38-flash-next-atlas-worker']).NCCL_IB_HCA, 'mlx5_7,mlx5_9');

// A node missing a usable fabricHca/fabricInterface override is refused rather
// than silently defaulted; planning must also leave the input untouched.
const strictNodes = {
  ennspark03: { backendHost: '10.0.3.1', fabricInterface: 'enp1s0f1np1', fabricHca: 'rocep1s0f1' },
  ennspark04: { backendHost: '10.0.3.2', fabricInterface: 'enp1s0f1np1', fabricHca: 'rocep1s0f1', labels: {} }
};
for (const invalid of [
  undefined,
  '',
  'rocep1s0f1,',
  'rocep1s0f1,rocep1s0f1',
  'rocep1s0f1:1',
  'rocep1s0f1;true',
  ' rocep1s0f1',
  ['rocep1s0f1']
]) {
  const config = pairConfig(structuredClone(strictNodes));
  config.cluster.nodes.ennspark04.fabricHca = invalid;
  const snapshot = structuredClone(config);
  assert.throws(() => materialize(config), /cluster\.nodes\[ennspark04\]\.fabricHca/);
  assert.deepEqual(config, snapshot, 'planning must not mutate input');
}
for (const invalid of [undefined, '', 'eth0;true', ['eth0']]) {
  const config = pairConfig(structuredClone(strictNodes));
  config.cluster.nodes.ennspark04.fabricInterface = invalid;
  assert.throws(() => materialize(config), /cluster\.nodes\[ennspark04\]\.fabricInterface/);
}
// A node with no fabricHca at all (not just an invalid value) is refused too.
const missingFabric = pairConfig(structuredClone(strictNodes));
delete missingFabric.cluster.nodes.ennspark04.fabricHca;
assert.throws(() => materialize(missingFabric), /cluster\.nodes\[ennspark04\]\.fabricHca/);

// ---- pins: final identities, pending digest, fail-closed gate ---------------
assert.equal(pins.source.repo, 'Enntity/sparkqwen');
assert.equal(pins.source.revision, '050743206a7fd921eaa5acf1cbe50653b9f155cc');
assert.equal(pins.source.installTree, '70890529ba64dede889814f99f21b3c9a981d9bc');
assert.equal(pins.engine.commit, '63bebfa60d5086de9fc8cc07c21e5fbe38f3b742');
assert.equal(pins.image.tag, 'ghcr.io/enntity/atlas-sparkqwen:70890529ba64');
assert.equal(pins.image.tag, imageTagFor(pins));
assert.equal(pins.image.label, 'io.enntity.sparkqwen.install-tree');
assert.equal(pins.image.profilePath, '/opt/atlas/profiles/8x262k.json');
assert.equal(pins.image.reference.split('@')[0], IMAGE_REPOSITORY);
const digestPending = !IMAGE_REFERENCE_PATTERN.test(pins.image.reference);
const verifyRun = spawnSync('node', [path.join(backendDir, 'verify-pins.mjs')], { encoding: 'utf8' });
if (digestPending) {
  // TODO(image digest): the gate must refuse until the GHCR digest is pinned.
  assert.match(pins.image.reference, /TODO/);
  assert(verifyPins(pins).some((failure) => failure.startsWith('image.reference')));
  assert.equal(verifyRun.status, 1, 'verify-pins must fail while the digest is a TODO');
  assert.match(verifyRun.stderr, /image\.reference is a placeholder/);
} else {
  assert.deepEqual(verifyPins(pins), []);
  assert.equal(verifyRun.status, 0, verifyRun.stderr);
}

// A manifest with a real-looking digest passes; each malformed identity fails.
const finalManifest = structuredClone(pins);
finalManifest.status = 'final';
finalManifest.image.reference = `${IMAGE_REPOSITORY}@sha256:${'a'.repeat(64)}`;
assert.deepEqual(verifyPins(finalManifest), []);
const variant = (mutate) => {
  const manifest = structuredClone(finalManifest);
  mutate(manifest);
  return verifyPins(manifest);
};
for (const [label, mutate] of [
  ['draft status', (m) => (m.status = 'draft')],
  ['branch as revision', (m) => (m.source.revision = 'main')],
  ['short engine commit', (m) => (m.engine.commit = '84e7c734')],
  ['shell in profile path', (m) => (m.image.profilePath = "/opt/atlas/x' ; rm -rf / ; '")],
  ['short install tree', (m) => (m.source.installTree = m.source.installTree.slice(0, 12))],
  ['tag not derived from tree', (m) => (m.image.tag = `${IMAGE_REPOSITORY}:latest`)],
  ['tag as reference', (m) => (m.image.reference = m.image.tag)],
  ['other repository', (m) => (m.image.reference = `ghcr.io/enntity/other@sha256:${'a'.repeat(64)}`)],
  ['uppercase digest', (m) => (m.image.reference = `${IMAGE_REPOSITORY}@sha256:${'A'.repeat(64)}`)],
  ['short digest', (m) => (m.image.reference = `${IMAGE_REPOSITORY}@sha256:${'a'.repeat(63)}`)],
  ['missing reference', (m) => delete m.image.reference],
  ['wrong label', (m) => (m.image.label = 'io.enntity.sparkglm.install-tree')],
  ['wrong architecture', (m) => (m.image.architecture = 'amd64')],
  ['pinned image id', (m) => (m.image.id = `sha256:${'b'.repeat(64)}`)],
  ['floating model revision', (m) => (m.model.revision = 'main')]
]) {
  assert(variant(mutate).length > 0, `${label} must be rejected`);
}

// ---- install.sh -------------------------------------------------------------
const bashCheck = spawnSync('bash', ['-n', path.join(backendDir, 'install.sh')], { encoding: 'utf8' });
assert.equal(bashCheck.status, 0, bashCheck.stderr);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sparkqwen-'));
const fakeBin = path.join(tmpRoot, 'bin');
fs.mkdirSync(fakeBin);
const finalManifestPath = path.join(tmpRoot, 'pins.json');
fs.writeFileSync(finalManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
// A fake Docker CLI keeps the test CPU-only. The image exists unless
// SQ_IMAGE_DIR is set, in which case only `docker pull` creates it.
const dockerLog = path.join(tmpRoot, 'docker.log');
fs.writeFileSync(
  path.join(fakeBin, 'docker'),
  `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> '${dockerLog}'
present() { [[ -z "\${SQ_IMAGE_DIR:-}" || -f "\${SQ_IMAGE_DIR}/present" ]]; }
case "\${1:-}" in
  image)
    [[ "\${5:-}" == '${finalManifest.image.reference}' ]] || { echo "unexpected image target \${5:-}" >&2; exit 2; }
    present || { echo "No such image" >&2; exit 1; }
    echo "\${SQ_IDENTITY:-arm64 ${pins.source.installTree}}" ;;
  pull)
    [[ "\${2:-}" == '${finalManifest.image.reference}' ]] || { echo "refusing mutable pull" >&2; exit 2; }
    [[ "\${SQ_PULL_FAIL:-0}" == 1 ]] && { echo "denied" >&2; exit 1; }
    [[ -n "\${SQ_IMAGE_DIR:-}" ]] && touch "\${SQ_IMAGE_DIR}/present"; exit 0 ;;
  run)
    [[ "$*" == *'${finalManifest.image.reference}'* ]] || { echo "run must use the digest" >&2; exit 2; }
    [[ "$*" == *'${pins.image.profilePath}'* && "$*" == *'${pins.engine.commit}'* ]] || exit 3
    [[ "\${SQ_MISSING_CONTRACT:-0}" == 1 ]] && exit 1; exit 0 ;;
  *) echo "unexpected fake docker invocation: $*" >&2; exit 2 ;;
esac
`,
  { mode: 0o755 }
);
const fakeEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
const runInstaller = (env = {}, extra = [], manifest = finalManifestPath) => {
  fs.rmSync(dockerLog, { force: true });
  const result = spawnSync('bash', [path.join(backendDir, 'install.sh'), '--manifest', manifest, ...extra], {
    encoding: 'utf8',
    env: { ...fakeEnv, ...env }
  });
  result.docker = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, 'utf8') : '';
  return result;
};

// The checked-in manifest is refused before Docker is touched while pending.
const checkedIn = runInstaller({}, [], path.join(backendDir, 'pins.json'));
if (digestPending) {
  assert.notEqual(checkedIn.status, 0);
  assert.match(checkedIn.stderr, /not a final immutable install manifest/);
  assert.equal(checkedIn.docker, '', 'no docker call before the pin gate passes');
}
const checked = runInstaller({}, ['--check-only']);
assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
assert.match(checked.stdout, new RegExp(`${pins.image.label}=${pins.source.installTree}`));
assert(!checked.docker.includes('pull'), '--check-only never pulls');
for (const identity of [`arm64 ${'f'.repeat(40)}`, `amd64 ${pins.source.installTree}`, 'arm64 <no value>']) {
  const mismatched = runInstaller({ SQ_IDENTITY: identity }, ['--check-only']);
  assert.notEqual(mismatched.status, 0, `must reject image identity ${identity}`);
  assert.match(mismatched.stderr, new RegExp(`expected 'arm64 ${pins.source.installTree}'`));
}
const missingContract = runInstaller({ SQ_MISSING_CONTRACT: '1' }, ['--check-only']);
assert.notEqual(missingContract.status, 0, 'a matching label must not hide a missing contract');
assert.match(missingContract.stderr, /is missing \/opt\/atlas\/serve\.py/);
const noImage = fs.mkdtempSync(path.join(tmpRoot, 'none-'));
const checkMissing = runInstaller({ SQ_IMAGE_DIR: noImage }, ['--check-only']);
assert.notEqual(checkMissing.status, 0);
assert.match(checkMissing.stderr, /not present locally/);
assert(!fs.existsSync(path.join(noImage, 'present')));

const reused = runInstaller();
assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
assert.match(reused.stdout, /verified; skipping pull/);
assert(!reused.docker.includes('pull'));
const pullDir = fs.mkdtempSync(path.join(tmpRoot, 'pull-'));
const pulled = runInstaller({ SQ_IMAGE_DIR: pullDir });
assert.equal(pulled.status, 0, `${pulled.stdout}\n${pulled.stderr}`);
assert.match(pulled.stdout, /pulling ghcr\.io\/enntity\/atlas-sparkqwen@sha256:/);
assert.match(pulled.stdout, /image prepared/);
assert(!pulled.docker.includes(pins.image.tag), 'the mutable tag is never addressed');
const failedPull = runInstaller({ SQ_IMAGE_DIR: noImage, SQ_PULL_FAIL: '1' });
assert.notEqual(failedPull.status, 0);
assert.match(failedPull.stderr, /refusing to fall back/);
const wrongContents = runInstaller({ SQ_IDENTITY: `arm64 ${'f'.repeat(40)}` });
assert.notEqual(wrongContents.status, 0);
assert.match(wrongContents.stderr, /failed the install-tree contents check/);
assert.match(runInstaller({}, ['--bogus']).stderr, /unexpected argument/);
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---- docs and index ---------------------------------------------------------
const readme = await fs.promises.readFile(path.join(backendDir, 'README.md'), 'utf8');
for (const needle of ['AGPL-3.0-only', 'NVIDIA Open Model', '127.0.0.1:8893', '127.0.0.1:8894', 'FABRIC_HCA', 'TODO']) {
  assert(readme.includes(needle), `backend README must mention ${needle}`);
}
const index = JSON.parse(await fs.promises.readFile(path.join(root, 'recipes', 'index.json'), 'utf8'));
const entry = index.recipes.find((item) => item.id === recipe.id);
assert(entry, 'the recipe must be listed in recipes/index.json');
assert.equal(entry.path, `${recipeId}.json`);
assert.equal(entry.currentVersion, recipe.version);
assert.equal(entry.versions.find((version) => version.status === 'current').path, entry.path);

console.log('Atlas SparkQwen recipe/backend checks passed');

const pleStep = recipe.setup.steps.find((s) => s.id === 'prepare-atlas-ple-cache');
assert.deepEqual(pleStep.args, [
  '-p',
  '${installRoot}/atlas-sparkqwen-ple/a0cebe89737898692964d3923477bef293a4ebde9dd32e27202697c54f763c9d/b9ce18a6887e18c089fdea8509a33e63429a3300'
]);
for (const member of members) {
  const args = member.runtimeSettings.bootstrap.createArgs;
  assert.equal(args.filter((x) => x.includes('dst=/atlas-ple')).length, 1);
}
