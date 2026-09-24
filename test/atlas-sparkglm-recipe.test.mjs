import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackend, loadBackendCatalog, planBackend } from '../src/backend-catalog.mjs';
import { deriveUserConfig } from '../src/init.mjs';
import { loadRecipeById, planRecipe } from '../src/recipes.mjs';
import { imageTagFor, loadPins, verifyPins } from '../backends/atlas-sparkglm/verify-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backends', 'atlas-sparkglm');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-2x-glm53-atlas');
const catalog = await loadBackendCatalog();
const pins = loadPins();

// ---- backend catalog entry ------------------------------------------------
const backend = getBackend(catalog, 'docker-atlas-sparkglm');
assert(backend, 'docker-atlas-sparkglm backend must be packaged');
assert(backend.commands.includes('docker'));
assert.equal(backend.server.protocol, 'openai');
assert.equal(backend.server.healthPath, '/health');
assert.equal(backend.server.chatPath, '/v1/chat/completions');
assert.deepEqual(
  backend.setup.map((step) => step.id),
  ['check-docker', 'check-atlas-pins']
);

const plannedBackendPlan = await planBackend(backend, { checkCommands: false });
assert(
  plannedBackendPlan.steps.every((step) => !step.command.join(' ').includes('${')),
  'backend setup templates must be fully rendered'
);

// ---- recipe shape ---------------------------------------------------------
assert.equal(recipe.id, 'linux-nvidia-dgx-spark-2x-glm53-atlas');
assert.equal(recipe.version, 1);
assert.equal(recipe.backend.id, 'docker-atlas-sparkglm');
assert.equal(recipe.license.id, 'MIT');
assert.deepEqual(recipe.requirements.cluster, {
  nodes: 2,
  provider: 'nvidia-sync',
  topology: 'direct'
});
assert(recipe.requirements.accelerators.includes('gb10'));
assert.deepEqual(
  recipe.setup.steps.map((step) => step.id),
  ['check-docker', 'verify-atlas-pins', 'download-atlas-model', 'build-atlas-image', 'convert-atlas-overlay']
);

const model = recipe.models[0];
assert.equal(model.role, 'default');
assert.equal(model.model, 'nvidia/GLM-5.3-Flash-NVFP4');
assert.equal(model.settings.port, 8893);
assert.equal(model.settings.baseUrl, 'http://127.0.0.1:8893/v1');
assert.equal(model.settings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(model.settings.contextWindow, 32768);
assert.equal(model.settings.maxActiveRequests, 4);
assert.equal(model.settings.memoryGb, 114);
assert.equal(model.settings.priority, 150);
assert.equal(model.settings.startupTimeoutMs, 7200000);
assert.equal(model.settings.watchdog.oomGuardMb ?? 4096, 4096);
assert.deepEqual(model.input, ['text', 'image']);
assert(model.capabilities.includes('vision'));
const downloadStep = recipe.setup.steps.find((step) => step.id === 'download-atlas-model');
assert.equal(downloadStep.model, 'nvidia/GLM-5.3-Flash-NVFP4');
assert.equal(downloadStep.revision, '423acf37583782c51c142d145aef733d72943d93');

// Additive lane: never take over the default route, never overwrite aliases.
assert.equal(model.setDefault, false);
assert.equal(model.aliases, undefined);
assert(!Object.hasOwn(model, 'aliases'));

// ---- distributed placement -------------------------------------------------
const members = model.settings.placement.members;
assert.equal(model.settings.placement.mode, 'distributed');
assert.deepEqual(
  members.map((member) => member.role),
  ['worker', 'head']
);
const worker = members.find((member) => member.role === 'worker');
const leader = members.find((member) => member.role === 'head');
assert.equal(worker.nodeRole, 'worker');
assert.equal(worker.order, 10);
assert.equal(worker.healthStrategy, 'container');
assert.equal(worker.runtimeSettings.warmup, false);
assert.equal(worker.resources.memoryGb, 114);
assert.equal(leader.nodeRole, 'leader');
assert.equal(leader.order, 20);
assert.equal(leader.resources.memoryGb, 114);
assert.equal(leader.runtimeSettings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(leader.runtimeSettings.warmup.method, 'POST');
assert.equal(leader.runtimeSettings.warmup.url, 'http://127.0.0.1:8893/v1/chat/completions');
assert(worker.order < leader.order, 'the worker must be admitted before the leader');

for (const member of members) {
  const bootstrap = member.runtimeSettings.bootstrap;
  assert.equal(member.runtimeSettings.adapter, 'docker');
  assert.equal(member.runtimeSettings.management, 'managed');
  assert.equal(member.runtimeSettings.containerName, 'lloom-atlas-sparkglm-${nodeId}');
  assert.equal(bootstrap.adapter, 'docker');
  assert.equal(bootstrap.image, pins.image.tag);
  assert.equal(bootstrap.pull, false, 'the prepared local image must not be pulled');
  assert.deepEqual(bootstrap.command ?? [], [], 'use the image entrypoint exactly once');

  const rendered = bootstrap.createArgs.join(' ');
  for (const expected of [
    '--restart no',
    '--network host',
    '--memory 114g',
    '--gpus all',
    '/dev/infiniband:/dev/infiniband',
    '--cap-add IPC_LOCK',
    '--cap-add SYS_NICE',
    '--ulimit memlock=-1:-1',
    '--security-opt no-new-privileges=true',
    '--stop-timeout 60',
    'type=bind,src=${modelRoot}/nvidia--GLM-5.3-Flash-NVFP4,dst=${modelRoot}/nvidia--GLM-5.3-Flash-NVFP4,readonly',
    'type=bind,src=${installRoot}/atlas-overlay,dst=${installRoot}/atlas-overlay,readonly',
    'MODEL_PATH=${installRoot}/atlas-overlay',
    'FABRIC_HCA=rocep1s0f0',
    'NODE_RANK=${nodeRank}',
    'MASTER_ADDR=${leaderAddress}',
    'MASTER_PORT=29510',
    'FABRIC_INTERFACE=${fabricInterface}',
    '-e FABRIC_HCA=rocep1s0f0',
    'ATLAS_WORLD_SIZE=2',
    'ATLAS_TP_SIZE=2',
    'ATLAS_EP_SIZE=2',
    'ATLAS_CONTEXT_WINDOW=32768',
    'SERVED_MODEL_NAME=glm-5.3-flash-atlas',
    'NCCL_IB_HCA=rocep1s0f0',
    'NCCL_IB_ADDR_FAMILY=AF_INET',
    'NCCL_CROSS_NIC=0',
    'NCCL_SOCKET_IFNAME=${fabricInterface}'
  ]) {
    assert(rendered.includes(expected), `missing Atlas launch control: ${expected}`);
  }
  // The baseline launched with the tool grammar disabled; functionality wins.
  assert(!rendered.includes('disable-tool-grammar'), 'tool grammar must stay enabled');
  assert(!rendered.includes('--ipc private'), 'the private-ipc baseline flag must not be copied');
  // Nothing host-specific or private from the baseline evidence.
  assert(!/\b10\.\d+\.\d+\.\d+\b/.test(rendered));
  assert(!rendered.includes('spark01'));
  assert(!rendered.includes('spark02'));
}
assert(!leader.runtimeSettings.bootstrap.createArgs.includes('--port'));

// ---- private listeners -----------------------------------------------------
const leaderPrivatePort = leader.runtimeSettings.healthUrl.match(/:(\d+)\//);
assert.equal(leaderPrivatePort[1], '8893');
assert.equal(leader.runtimeSettings.bootstrap.createArgs.join(' ').includes('PORT=8894'), false);
// The worker's private listener is declared through the image contract, since
// the worker has no HTTP health surface LLooM can poll.
const readme = await fs.promises.readFile(path.join(backendDir, 'README.md'), 'utf8');
assert(readme.includes('127.0.0.1:8893'));
assert(readme.includes('127.0.0.1:8894'));
assert(readme.includes('/opt/atlas/serve.py'));
assert(readme.includes('/opt/atlas/profile.json'));
for (const key of ['NODE_RANK', 'MASTER_ADDR', 'MASTER_PORT', 'FABRIC_INTERFACE', 'MODEL_PATH']) {
  assert(readme.includes(key), `the image env contract must document ${key}`);
}

// ---- plan validity ---------------------------------------------------------
const plan = planRecipe(
  recipe,
  { models: [], runtimes: {} },
  {
    modelRoot: '/models',
    variables: {
      repoRoot: root,
      backendRoot: '/backend',
      installRoot: '/install'
    },
    platform: 'linux',
    arch: 'arm64',
    backendIds: new Set(['docker-atlas-sparkglm']),
    checkLocalReferences: false
  }
);
assert.deepEqual(plan.validationErrors, []);
assert.deepEqual(
  plan.steps.map((step) => step.id),
  ['check-docker', 'verify-atlas-pins', 'download-atlas-model', 'build-atlas-image', 'convert-atlas-overlay']
);
for (const step of plan.steps.filter((entry) => entry.action === 'command')) {
  assert(!step.command.join(' ').includes('${'), `unresolved recipe template in ${step.id}`);
}
assert.equal(
  plan.steps.find((step) => step.id === 'download-atlas-model').destination,
  '/models/nvidia--GLM-5.3-Flash-NVFP4'
);
assert.deepEqual(plan.steps.find((step) => step.id === 'build-atlas-image').command, [
  'bash',
  `${root}/backends/atlas-sparkglm/install.sh`,
  '--backend-root',
  '/backend',
  '--install-root',
  '/install'
]);
assert.deepEqual(plan.steps.find((step) => step.id === 'convert-atlas-overlay').command, [
  'bash',
  `${root}/backends/atlas-sparkglm/convert-overlay.sh`,
  '--backend-root',
  '/backend',
  '--install-root',
  '/install',
  '--model-root',
  '/models'
]);

// Runtime materialization must resolve the same managed paths used by setup.
// Absolute source/output mounts are required because the converter can emit
// absolute symlinks into the overlay.
const materialized = deriveUserConfig(
  {
    server: { host: '127.0.0.1', port: 8100 },
    security: {},
    defaults: {},
    models: [],
    backends: {},
    runtimes: {},
    aliases: {},
    clientCatalog: { modelOrder: [] },
    cluster: {
      leaderNode: 'spark01',
      nodes: {
        spark01: { backendHost: '10.0.0.1', fabricInterface: 'eth0' },
        spark02: { backendHost: '10.0.0.2', fabricInterface: 'eth0', labels: { role: 'worker' } }
      }
    }
  },
  recipe,
  {
    modelRoot: '/models',
    additive: true,
    backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
  }
);
const additiveExisting = deriveUserConfig(
  {
    server: { host: '127.0.0.1', port: 8100 },
    security: {},
    defaults: { chatModel: 'existing-model' },
    models: [{ id: 'existing-model', advertise: true }],
    backends: {},
    runtimes: {},
    aliases: {
      existing: { members: ['existing-model'], advertise: true }
    },
    clientCatalog: { modelOrder: ['existing-model'] },
    cluster: {
      leaderNode: 'spark01',
      nodes: {
        spark01: { backendHost: '10.0.0.1', fabricInterface: 'eth0' },
        spark02: { backendHost: '10.0.0.2', fabricInterface: 'eth0', labels: { role: 'worker' } }
      }
    }
  },
  recipe,
  {
    modelRoot: '/models',
    additive: true,
    backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
  }
);
assert.equal(additiveExisting.defaults.chatModel, 'existing-model');
assert.deepEqual(additiveExisting.aliases.existing, { members: ['existing-model'], advertise: true });
assert(additiveExisting.clientCatalog.modelOrder.includes('existing-model'));
assert(additiveExisting.clientCatalog.modelOrder.includes('glm-5.3-flash-atlas'));
assert.deepEqual(
  materialized.runtimes['glm53-flash-atlas-cluster'].placement.members.map((member) => [member.role, member.order]),
  [
    ['worker', 10],
    ['head', 20]
  ]
);
assert.equal(materialized.backends['glm53-flash-atlas'].baseUrl, 'http://127.0.0.1:8893/v1');
assert.equal(materialized.runtimes['glm53-flash-atlas-cluster'].healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(
  materialized.runtimes['glm53-flash-atlas-cluster'].warmup.url,
  'http://127.0.0.1:8893/v1/chat/completions'
);
for (const runtimeId of ['glm53-flash-atlas-worker', 'glm53-flash-atlas-head']) {
  const runtime = materialized.runtimes[runtimeId];
  assert(runtime);
  assert(!JSON.stringify(runtime).includes('${'), `${runtimeId} has an unresolved runtime template`);
  const args = runtime.bootstrap.createArgs.join(' ');
  assert(args.includes('src=/models/nvidia--GLM-5.3-Flash-NVFP4,dst=/models/nvidia--GLM-5.3-Flash-NVFP4'));
  assert(args.includes('src=/install/atlas-overlay,dst=/install/atlas-overlay'));
  assert(args.includes('MODEL_PATH=/install/atlas-overlay'));
}

// ---- fail-closed DRAFT pins ------------------------------------------------
assert.equal(pins.model.revision, '423acf37583782c51c142d145aef733d72943d93');
assert.equal(pins.model.repo, 'nvidia/GLM-5.3-Flash-NVFP4');
assert.equal(pins.source.repo, 'Enntity/sparkglm');
assert.equal(pins.image.entrypoint, '/opt/atlas/serve.py');
assert(pins.overlay.marker.includes('conversion.complete.json'));
const draftFailures = verifyPins(pins);
assert(draftFailures.length > 0, 'a DRAFT manifest must not verify');

const verifyRun = spawnSync('node', [path.join(backendDir, 'verify-pins.mjs')], { encoding: 'utf8' });
assert.equal(verifyRun.status, 1, 'the CLI pin gate must fail closed while DRAFT');
assert.match(verifyRun.stderr, /not installable|DRAFT|draft/i);

// A final manifest with a mismatched image identity must still be rejected.
const finalManifest = {
  ...pins,
  status: 'final',
  source: { ...pins.source, revision: 'a'.repeat(40) },
  image: { ...pins.image },
  overlay: { ...pins.overlay }
};
finalManifest.image.tag = imageTagFor(finalManifest);
assert.deepEqual(verifyPins(finalManifest), []);
assert.equal(imageTagFor(finalManifest), `lloom/atlas-sparkglm:${'a'.repeat(40)}`);
assert(
  verifyPins({ ...finalManifest, source: { ...finalManifest.source, revision: 'main' } }).length > 0,
  'a branch name must not be accepted as a pin'
);
assert(
  verifyPins({ ...finalManifest, image: { ...finalManifest.image, id: 'sha256:' + 'b'.repeat(64) } }).length > 0,
  'a host-local image ID must not be pinned globally'
);
assert(
  verifyPins({ ...finalManifest, model: { ...finalManifest.model, revision: 'main' } }).length > 0,
  'the model revision must stay pinned'
);

// ---- the installers must refuse to run while DRAFT --------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pins-'));
const installRun = spawnSync('bash', [path.join(backendDir, 'install.sh'), '--backend-root', tmpRoot], {
  encoding: 'utf8'
});
assert.notEqual(installRun.status, 0, 'install.sh must fail closed while DRAFT');
assert.match(`${installRun.stdout}${installRun.stderr}`, /DRAFT|draft/i);

const convertRun = spawnSync('bash', [path.join(backendDir, 'convert-overlay.sh'), '--backend-root', tmpRoot], {
  encoding: 'utf8'
});
assert.notEqual(convertRun.status, 0, 'convert-overlay.sh must fail closed while DRAFT');
assert.match(`${convertRun.stdout}${convertRun.stderr}`, /DRAFT|draft/i);

// A directory alone never counts as a converted overlay.
const overlayRoot = path.join(tmpRoot, 'atlas-overlay');
fs.mkdirSync(overlayRoot, { recursive: true });
const verifyOverlay = spawnSync(
  'bash',
  [
    path.join(backendDir, 'convert-overlay.sh'),
    '--backend-root',
    tmpRoot,
    '--install-root',
    tmpRoot,
    '--overlay-root',
    overlayRoot,
    '--verify-only'
  ],
  { encoding: 'utf8' }
);
assert.notEqual(verifyOverlay.status, 0, 'an empty overlay directory must not verify');
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---- shell scripts and installers must parse -------------------------------
for (const script of ['install.sh', 'convert-overlay.sh']) {
  const check = spawnSync('bash', ['-n', path.join(backendDir, script)], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${script}: ${check.stderr}`);
}

// ---- the recipe must be indexed -------------------------------------------
const index = JSON.parse(await fs.promises.readFile(path.join(root, 'recipes', 'index.json'), 'utf8'));
const entry = index.recipes.find((item) => item.id === recipe.id);
assert(entry, 'the Atlas recipe must be listed in recipes/index.json');
assert.equal(entry.path, 'linux-nvidia-dgx-spark-2x-glm53-atlas.json');
assert.equal(entry.currentVersion, recipe.version);
assert.equal(entry.versions.filter((version) => version.status === 'current').length, 1);
assert.equal(entry.versions.find((version) => version.status === 'current').path, entry.path);

console.log('Atlas SparkGLM recipe/backend integration checks passed');
