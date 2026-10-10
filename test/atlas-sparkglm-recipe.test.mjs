import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackend, loadBackendCatalog, planBackend } from '../src/backend-catalog.mjs';
import { deriveUserConfig } from '../src/init.mjs';
import { loadRecipeById, planRecipe } from '../src/recipes.mjs';
import { createSetupStatus } from '../src/setup-status.mjs';
import { imageTagFor, loadPins, verifyPins } from '../backends/atlas-sparkglm/verify-pins.mjs';
import { conversionHeadroomMiB } from '../backends/atlas-sparkglm/conversion-headroom.mjs';

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
  [
    'check-docker',
    'verify-atlas-pins',
    'download-atlas-model',
    'download-atlas-drafter',
    'build-atlas-image',
    'convert-atlas-overlay',
    'prepare-atlas-prefix-cache'
  ]
);
const gatedSteps = ['verify-atlas-pins', 'build-atlas-image', 'convert-atlas-overlay', 'prepare-atlas-prefix-cache'];
assert.deepEqual(
  recipe.setup.steps
    .filter((step) => step.action !== 'check-command' && step.action !== 'download-model')
    .map((step) => step.id),
  gatedSteps
);
for (const stepId of gatedSteps) {
  assert.equal(
    recipe.setup.steps.find((step) => step.id === stepId).alwaysRun,
    true,
    `${stepId} must revalidate on every apply`
  );
}
assert.equal(backend.setup.find((step) => step.id === 'check-atlas-pins').alwaysRun, true);

const model = recipe.models[0];
assert.equal(model.role, 'default');
assert.equal(model.model, 'nvidia/GLM-5.3-Flash-NVFP4');
assert.equal(model.settings.port, 8893);
assert.equal(model.settings.baseUrl, 'http://127.0.0.1:8893/v1');
assert.equal(model.settings.healthUrl, 'http://127.0.0.1:8893/health');
assert.equal(model.settings.contextWindow, 1048576);
assert.equal(model.settings.maxOutputTokens, 131072);
assert.equal(model.settings.timeoutMs, 14400000);
assert.equal(model.settings.maxActiveRequests, 4);
assert.equal(model.settings.memoryGb, 114);
assert.equal(model.settings.priority, 150);
assert.equal(model.settings.startupTimeoutMs, 7200000);
assert.equal(model.settings.watchdog.oomGuardMb ?? 4096, 4096);
assert.deepEqual(model.input, ['text', 'image', 'video']);
// The prefix cache on disk ships on (48 GiB per node) beside the KV shard; 0
// turns it off, 16-100 is its size. The image's serve.py validates both.
assert.equal(model.settings.prefixCacheGb, 48);
assert(model.capabilities.includes('vision'));
assert(model.capabilities.includes('structured-output'));
const downloadStep = recipe.setup.steps.find((step) => step.id === 'download-atlas-model');
assert.equal(downloadStep.model, 'nvidia/GLM-5.3-Flash-NVFP4');
assert.equal(downloadStep.revision, '423acf37583782c51c142d145aef733d72943d93');
const drafterStep = recipe.setup.steps.find((step) => step.id === 'download-atlas-drafter');
assert.equal(drafterStep.action, 'download-model');
assert.equal(drafterStep.model, pins.drafter.repo);
assert.equal(drafterStep.revision, pins.drafter.revision);

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
    // The GB10 display carveout: the launcher drops SYS_ADMIN before the server starts.
    '--cap-add SYS_ADMIN',
    'type=bind,src=${installRoot}/atlas-carveout-lock,dst=/run/lock/sparkglm',
    'SPARKGLM_DISPLAY_CARVEOUT=1',
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
    'ATLAS_CONTEXT_WINDOW=1048576',
    'type=bind,src=${modelRoot}/incoai--GLM-5.3-Flash-DFlash2,dst=${modelRoot}/incoai--GLM-5.3-Flash-DFlash2,readonly',
    'DRAFTER_PATH=${modelRoot}/incoai--GLM-5.3-Flash-DFlash2',
    'SERVED_MODEL_NAME=glm-5.3-flash-atlas',
    'NCCL_IB_HCA=rocep1s0f0',
    'NCCL_IB_ADDR_FAMILY=AF_INET',
    'NCCL_CROSS_NIC=0',
    'NCCL_SOCKET_IFNAME=${fabricInterface}',
    'type=bind,src=${installRoot}/atlas-prefix-cache,dst=/prefix-cache',
    'SPARKGLM_PREFIX_CACHE_GB=${prefixCacheGb}',
    'SPARKGLM_KV_SHARD=1',
    'SPARKGLM_PROFILE=4x1m'
  ]) {
    assert(rendered.includes(expected), `missing Atlas launch control: ${expected}`);
  }
  // Tier settings come only from serve.py, identical on both ranks.
  assert(!/ATLAS_(KV_NVME|SSM_TIER|GLM_NVME)/.test(rendered));
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
assert(readme.includes(pins.image.profilePath));
assert.equal(pins.image.profilePath, '/opt/atlas/profiles/4x1m.json');
for (const key of [
  'NODE_RANK',
  'MASTER_ADDR',
  'MASTER_PORT',
  'FABRIC_INTERFACE',
  'MODEL_PATH',
  'SPARKGLM_PREFIX_CACHE_GB',
  'SPARKGLM_KV_SHARD',
  'SPARKGLM_PROFILE'
]) {
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
  [
    'check-docker',
    'verify-atlas-pins',
    'download-atlas-model',
    'download-atlas-drafter',
    'build-atlas-image',
    'convert-atlas-overlay',
    'prepare-atlas-prefix-cache'
  ]
);
assert.deepEqual(plan.steps.find((step) => step.id === 'prepare-atlas-prefix-cache').command, [
  'mkdir',
  '-p',
  '/install/atlas-prefix-cache/kv',
  '/install/atlas-prefix-cache/ssm',
  '/install/atlas-carveout-lock'
]);
// The drafter lands exactly where both members mount it as DRAFTER_PATH.
assert.equal(
  plan.steps.find((step) => step.id === 'download-atlas-drafter').destination,
  '/models/incoai--GLM-5.3-Flash-DFlash2'
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

// Recorded completion cannot make an always-run revalidation gate ready. This
// guards the setup-status view against advertising a stale image or overlay
// after the recipe pins or host artifacts change.
const statusRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-status-'));
const statusStatePath = path.join(statusRoot, 'install-state.json');
await fs.promises.writeFile(
  statusStatePath,
  `${JSON.stringify(
    {
      backends: {
        [backend.id]: {
          steps: {
            'check-atlas-pins': { status: 'completed', completedAt: new Date().toISOString() }
          }
        }
      },
      recipes: {
        [recipe.id]: {
          steps: Object.fromEntries(
            ['verify-atlas-pins', 'build-atlas-image', 'convert-atlas-overlay'].map((id) => [
              id,
              { status: 'completed' }
            ])
          )
        }
      }
    },
    null,
    2
  )}\n`,
  'utf8'
);
const status = await createSetupStatus(
  {
    sourcePath: path.join(statusRoot, 'config.json'),
    server: { host: '127.0.0.1', port: 8100 },
    defaults: {},
    models: [],
    aliases: {},
    backends: {},
    runtimes: {},
    paths: { modelRoot: path.join(statusRoot, 'models') }
  },
  {
    recipeId: recipe.id,
    modelRoot: path.join(statusRoot, 'models'),
    home: statusRoot,
    generatedRoot: path.join(statusRoot, 'generated'),
    clientId: 'codex',
    includeRuntimes: false,
    recipeDocuments: [recipe],
    recipesRoot: path.join(statusRoot, 'no-recipes'),
    statePath: statusStatePath,
    backendVariables: {
      repoRoot: root,
      backendRoot: path.join(root, 'backends'),
      installRoot: path.join(statusRoot, 'backends'),
      modelRoot: path.join(statusRoot, 'models')
    }
  }
);
for (const stepId of ['verify-atlas-pins', 'build-atlas-image', 'convert-atlas-overlay']) {
  const step = status.recipe.steps.find((candidate) => candidate.id === stepId);
  assert.equal(step.status, 'revalidation-required', `${stepId} status must require a fresh run`);
  assert.equal(step.ready, true, 'recorded completion remains ready for status display');
  assert.equal(step.requiresRevalidation, true);
  assert.equal(step.reason, 'always-run-next-apply');
}
const backendPinStatus = status.backend.steps.find((step) => step.id === 'check-atlas-pins');
assert.equal(backendPinStatus.status, 'revalidation-required');
assert.equal(backendPinStatus.ready, true);
assert.equal(backendPinStatus.reason, 'always-run-next-apply');
fs.rmSync(statusRoot, { recursive: true, force: true });

// Runtime materialization must resolve the same managed paths used by setup.
// Absolute source/output mounts are required because the converter can emit
// absolute symlinks into the overlay.
const materialize = (recipeDocument) =>
  deriveUserConfig(
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
    recipeDocument,
    {
      modelRoot: '/models',
      additive: true,
      backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
    }
  );
const materialized = materialize(recipe);
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
  assert(args.includes('src=/install/atlas-prefix-cache,dst=/prefix-cache'));
  assert(args.includes('-e SPARKGLM_PREFIX_CACHE_GB=48 '));
  assert(args.includes('-e SPARKGLM_KV_SHARD=1 '));
  assert(args.includes('-e SPARKGLM_PROFILE=4x1m '));
}
// A size reaches both ranks alike (the mount stays either way).
const diskCacheRecipe = structuredClone(recipe);
diskCacheRecipe.models[0].settings.prefixCacheGb = 0;
const diskCache = materialize(diskCacheRecipe);
for (const runtimeId of ['glm53-flash-atlas-worker', 'glm53-flash-atlas-head']) {
  const args = diskCache.runtimes[runtimeId].bootstrap.createArgs.join(' ');
  assert(args.includes('-e SPARKGLM_PREFIX_CACHE_GB=0 '), `${runtimeId} must pass the size through`);
  assert(args.includes('src=/install/atlas-prefix-cache,dst=/prefix-cache'));
}

// ---- final portable pins and explicit invalid-manifest fixture -------------
assert.equal(pins.model.revision, '423acf37583782c51c142d145aef733d72943d93');
assert.equal(pins.model.repo, 'nvidia/GLM-5.3-Flash-NVFP4');
assert.equal(pins.source.repo, 'Enntity/sparkglm');
assert.equal(pins.status, 'final');
assert.equal(pins.source.revision, 'b6bed25903578b4f4ed4f0e7204c80700ad5b8d9');
assert.equal(pins.source.installTree, '4046c81baa071cb109e55c3206ed1fca3bd3db9a');
assert.equal(pins.source.buildScript, 'install/build.sh');
assert.equal(pins.image.tag, 'ghcr.io/enntity/atlas-sparkglm:4046c81baa07');
assert.equal(pins.image.label, 'io.enntity.sparkglm.install-tree');
assert.equal(pins.image.architecture, 'arm64');
assert.equal(pins.image.entrypoint, '/opt/atlas/serve.py');
// The image identity is portable; no host-local receipt or derived-tag prefix.
assert(!Object.hasOwn(pins, 'installer'));
assert(!Object.hasOwn(pins.image, 'tagPrefix'));
assert(pins.overlay.marker.includes('conversion.complete.json'));
assert.deepEqual(verifyPins(pins), []);

const verifyRun = spawnSync('node', [path.join(backendDir, 'verify-pins.mjs')], { encoding: 'utf8' });
assert.equal(verifyRun.status, 0, 'the checked-in candidate manifest must verify');
assert.match(verifyRun.stdout, /pins verified/);

// A final manifest with a mismatched image identity must still be rejected.
const finalManifest = {
  ...pins,
  status: 'final',
  source: { ...pins.source, revision: 'a'.repeat(40), installTree: 'b'.repeat(40) },
  image: { ...pins.image },
  overlay: { ...pins.overlay }
};
finalManifest.image.tag = imageTagFor(finalManifest);
assert.deepEqual(verifyPins(finalManifest), []);
assert.equal(imageTagFor(finalManifest), `ghcr.io/enntity/atlas-sparkglm:${'b'.repeat(12)}`);
assert(
  verifyPins({ ...finalManifest, source: { ...finalManifest.source, revision: 'main' } }).length > 0,
  'a branch name must not be accepted as a pin'
);
assert(
  verifyPins({ ...finalManifest, source: { ...finalManifest.source, installTree: 'b'.repeat(12) } }).length > 0,
  'the install tree must be a full 40-character git object id'
);
assert(
  verifyPins({ ...finalManifest, image: { ...finalManifest.image, tag: `lloom/atlas-sparkglm:${'b'.repeat(12)}` } })
    .length > 0,
  'the image tag must be the GHCR repository plus the install tree prefix'
);
assert(
  verifyPins({ ...finalManifest, image: { ...finalManifest.image, label: 'org.opencontainers.image.revision' } })
    .length > 0,
  'the identity label must be the install-tree label'
);
assert(
  verifyPins({ ...finalManifest, image: { ...finalManifest.image, id: 'sha256:' + 'b'.repeat(64) } }).length > 0,
  'an image ID must not be pinned: pulls and local builds differ'
);
assert(
  verifyPins({ ...finalManifest, model: { ...finalManifest.model, revision: 'main' } }).length > 0,
  'the model revision must stay pinned'
);

// The installers must refuse a temporary invalid manifest before touching
// Docker, source checkouts, or model/overlay state.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pins-'));
const invalidManifestPath = path.join(tmpRoot, 'invalid-pins.json');
const invalidManifest = JSON.parse(JSON.stringify(pins));
invalidManifest.status = 'draft';
invalidManifest.source.revision = 'DRAFT_SOURCE_REVISION';
invalidManifest.image.tag = 'ghcr.io/enntity/atlas-sparkglm:DRAFT';
fs.writeFileSync(invalidManifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`);
const invalidVerifyRun = spawnSync('node', [path.join(backendDir, 'verify-pins.mjs'), invalidManifestPath], {
  encoding: 'utf8'
});
assert.equal(invalidVerifyRun.status, 1, 'an invalid manifest must fail closed');
assert.match(`${invalidVerifyRun.stdout}${invalidVerifyRun.stderr}`, /not final|DRAFT|draft/i);

const installRun = spawnSync(
  'bash',
  [path.join(backendDir, 'install.sh'), '--backend-root', tmpRoot, '--manifest', invalidManifestPath],
  { encoding: 'utf8' }
);
assert.notEqual(installRun.status, 0, 'install.sh must fail closed while DRAFT');
assert.match(`${installRun.stdout}${installRun.stderr}`, /DRAFT|draft/i);

const convertRun = spawnSync(
  'bash',
  [
    path.join(backendDir, 'convert-overlay.sh'),
    '--backend-root',
    tmpRoot,
    '--install-root',
    tmpRoot,
    '--model-root',
    path.join(tmpRoot, 'models'),
    '--manifest',
    invalidManifestPath
  ],
  { encoding: 'utf8' }
);
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
for (const unsafeOverlay of ['/', tmpRoot]) {
  const rejected = spawnSync(
    'bash',
    [
      path.join(backendDir, 'convert-overlay.sh'),
      '--backend-root',
      tmpRoot,
      '--model-root',
      path.join(tmpRoot, 'models'),
      '--overlay-root',
      unsafeOverlay,
      '--force'
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /overlay must be separate/);
}
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---- shell scripts and installers must parse -------------------------------
for (const script of ['install.sh', 'convert-overlay.sh']) {
  const check = spawnSync('bash', ['-n', path.join(backendDir, script)], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${script}: ${check.stderr}`);
}

// ---- image identity, installer re-entry and converter compatibility --------
// A fake Docker CLI keeps this test CPU-only while exercising the real shell
// control flow and pin checks. The image "exists" unless ATLAS_TEST_IMAGE_DIR
// is set, in which case only `docker pull` creates it. ATLAS_TEST_IDENTITY
// overrides the inspected "<architecture> <install-tree label>".
const converterRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-converter-'));
const fakeBin = path.join(converterRoot, 'bin');
const fakeDocker = path.join(fakeBin, 'docker');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(
  fakeDocker,
  `#!/usr/bin/env bash
set -euo pipefail
present() { [[ -z "\${ATLAS_TEST_IMAGE_DIR:-}" || -f "\${ATLAS_TEST_IMAGE_DIR}/present" ]]; }
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  present || { echo "No such image" >&2; exit 1; }
  case "\${4:-}" in
    *'.Architecture'*'${pins.image.label}'*) echo "\${ATLAS_TEST_IDENTITY:-arm64 ${pins.source.installTree}}" ;;
    *) echo "unexpected inspect format: \${4:-}" >&2; exit 2 ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == "pull" ]]; then
  [[ -n "\${ATLAS_TEST_IMAGE_DIR:-}" ]] && touch "\${ATLAS_TEST_IMAGE_DIR}/present"
  exit 0
fi
if [[ "\${1:-}" == "ps" ]]; then exit 0; fi
if [[ "\${1:-}" == "run" ]]; then
  joined="$*"
  if [[ "\${ATLAS_TEST_MISSING_CONTRACT:-0}" == "1" ]]; then exit 1; fi
  if [[ "\${joined}" == *sha256sum* ]]; then
    echo "${'c'.repeat(64)}  ${pins.converter.inImagePath}"
    echo "${'d'.repeat(64)}  ${pins.converter.library}"
  fi
  exit 0
fi
echo "unexpected fake docker invocation: $*" >&2
exit 2
`,
  { mode: 0o755 }
);

const converterInstallRoot = path.join(converterRoot, 'install');
const converterModelRoot = path.join(converterRoot, 'models');
const converterBackendRoot = path.join(converterRoot, 'backend');
const converterOverlayRoot = path.join(converterRoot, 'overlay');
const modelPath = path.join(converterModelRoot, 'nvidia--GLM-5.3-Flash-NVFP4');
fs.mkdirSync(modelPath, { recursive: true });
fs.writeFileSync(path.join(modelPath, 'config.json'), '{}\n');
fs.writeFileSync(
  path.join(modelPath, '.lloom-acquisition.json'),
  `${JSON.stringify({ revision: pins.model.revision })}\n`
);

const converterScriptSha = 'c'.repeat(64);
const converterLibrarySha = 'd'.repeat(64);
const writeConversionIdentity = (manifest, overlayPath = converterOverlayRoot) =>
  fs.writeFileSync(
    path.join(overlayPath, `${manifest.overlay.marker}.identity.json`),
    `${JSON.stringify({
      version: 1,
      model: { repo: manifest.model.repo, revision: manifest.model.revision },
      converter: {
        path: manifest.converter.inImagePath,
        sha256: converterScriptSha,
        library: manifest.converter.library,
        librarySha256: converterLibrarySha
      }
    })}\n`
  );
const writeConversionFixture = (manifest, overlayPath = converterOverlayRoot) => {
  fs.mkdirSync(overlayPath, { recursive: true });
  fs.writeFileSync(
    path.join(overlayPath, manifest.overlay.marker),
    `${JSON.stringify({
      converted_matrices: manifest.converter.expectedMatrices,
      shards: { fixture: {} },
      source: modelPath,
      output: overlayPath,
      finished: 1
    })}\n`
  );
  writeConversionIdentity(manifest, overlayPath);
};

writeConversionFixture(pins);
const fakeEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
const wrongTreeEnv = { ...fakeEnv, ATLAS_TEST_IDENTITY: `arm64 ${'f'.repeat(40)}` };
const runInstaller = (env = fakeEnv, extra = []) =>
  spawnSync(
    'bash',
    [
      path.join(backendDir, 'install.sh'),
      '--backend-root',
      converterBackendRoot,
      '--install-root',
      converterInstallRoot,
      ...extra
    ],
    { encoding: 'utf8', env }
  );
const checkedImage = runInstaller(fakeEnv, ['--check-only']);
assert.equal(checkedImage.status, 0, `${checkedImage.stdout}\n${checkedImage.stderr}`);
assert.match(checkedImage.stdout, new RegExp(`${pins.image.label}=${pins.source.installTree}`));
const missingImageContract = runInstaller({ ...fakeEnv, ATLAS_TEST_MISSING_CONTRACT: '1' }, ['--check-only']);
assert.notEqual(missingImageContract.status, 0, 'a matching label must not hide missing image artifacts');
assert.match(missingImageContract.stderr, /missing the Atlas entrypoint\/profile contract/);
for (const identity of [`arm64 ${'f'.repeat(40)}`, `amd64 ${pins.source.installTree}`, 'arm64 <no value>']) {
  const mismatched = runInstaller({ ...fakeEnv, ATLAS_TEST_IDENTITY: identity }, ['--check-only']);
  assert.notEqual(mismatched.status, 0, `--check-only must reject image identity ${identity}`);
  assert.match(mismatched.stderr, /expected 'arm64 4046c81baa071cb109e55c3206ed1fca3bd3db9a'/);
}
const noImageDir = fs.mkdtempSync(path.join(converterRoot, 'no-image-'));
const checkedMissingImage = runInstaller({ ...fakeEnv, ATLAS_TEST_IMAGE_DIR: noImageDir }, ['--check-only']);
assert.notEqual(checkedMissingImage.status, 0, '--check-only must not pull a missing image');
assert.match(checkedMissingImage.stderr, /not present locally/);
assert(!fs.existsSync(path.join(noImageDir, 'present')));

// Re-entry verifies the present image without pulling or building.
const reentered = runInstaller();
assert.equal(reentered.status, 0, `${reentered.stdout}\n${reentered.stderr}`);
assert.match(reentered.stdout, /existing image .* verified; skipping pull and build/);
// A missing image is pulled from GHCR and then verified.
const pullImageDir = fs.mkdtempSync(path.join(converterRoot, 'pull-'));
const pulled = runInstaller({ ...fakeEnv, ATLAS_TEST_IMAGE_DIR: pullImageDir });
assert.equal(pulled.status, 0, `${pulled.stdout}\n${pulled.stderr}`);
assert.match(pulled.stdout, /pulling ghcr\.io\/enntity\/atlas-sparkglm:4046c81baa07/);
assert.match(pulled.stdout, /image prepared/);
// An image with the wrong label is never trusted: the installer falls through
// to the source build, whose non-destructive checkout guard refuses to touch a
// non-git directory at the source root.
const blockedSource = path.join(converterInstallRoot, 'sources', `atlas-sparkglm-${pins.source.revision}`);
fs.mkdirSync(blockedSource, { recursive: true });
const fellThrough = runInstaller(wrongTreeEnv);
assert.notEqual(fellThrough.status, 0);
assert.match(fellThrough.stdout, /building from the pinned source/);
assert.match(fellThrough.stderr, /exists but is not a git checkout; refusing to overwrite it/);
fs.rmSync(path.join(converterInstallRoot, 'sources'), { recursive: true, force: true });

const runConverter = (manifestPath = path.join(backendDir, 'pins.json'), env = fakeEnv, extra = []) =>
  spawnSync(
    'bash',
    [
      path.join(backendDir, 'convert-overlay.sh'),
      '--backend-root',
      converterBackendRoot,
      '--install-root',
      converterInstallRoot,
      '--model-root',
      converterModelRoot,
      '--overlay-root',
      converterOverlayRoot,
      '--manifest',
      manifestPath,
      ...extra
    ],
    { encoding: 'utf8', env }
  );

const reused = runConverter();
assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
assert.match(reused.stdout, /already carries.*skipping/);
assert(fs.existsSync(path.join(converterOverlayRoot, pins.overlay.marker)));

const wrongImage = runConverter(undefined, wrongTreeEnv);
assert.notEqual(wrongImage.status, 0, 'conversion must refuse an image without the pinned install tree');
assert.match(wrongImage.stderr, /Rerun install\.sh/);
const missingImage = runConverter(undefined, { ...fakeEnv, ATLAS_TEST_IMAGE_DIR: noImageDir });
assert.notEqual(missingImage.status, 0);
assert.match(missingImage.stderr, /is not present; run backends\/atlas-sparkglm\/install\.sh/);

fs.writeFileSync(
  path.join(modelPath, '.lloom-acquisition.json'),
  `${JSON.stringify({ revision: 'wrong-acquisition' })}\n`
);
const staleModel = runConverter();
assert.notEqual(staleModel.status, 0);
assert.match(`${staleModel.stdout}${staleModel.stderr}`, /not pinned|acquisition revision/);
assert(
  fs.existsSync(path.join(converterOverlayRoot, pins.overlay.marker)),
  'stale acquisition must not remove the overlay'
);
fs.writeFileSync(
  path.join(modelPath, '.lloom-acquisition.json'),
  `${JSON.stringify({ revision: pins.model.revision })}\n`
);

const identityPath = path.join(converterOverlayRoot, `${pins.overlay.marker}.identity.json`);
const incompatibleIdentity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
incompatibleIdentity.converter.sha256 = 'e'.repeat(64);
fs.writeFileSync(identityPath, `${JSON.stringify(incompatibleIdentity)}\n`);
const staleConverter = runConverter();
assert.notEqual(staleConverter.status, 0);
assert.match(`${staleConverter.stdout}${staleConverter.stderr}`, /incompatible|--force/);
assert(fs.existsSync(identityPath), 'incompatible conversion must be preserved for explicit recovery');

// Change only the source revision and install tree (and so the image). The
// same model revision and converter content still make the completed overlay
// reusable.
const movedPins = JSON.parse(JSON.stringify(pins));
movedPins.source.revision = 'a'.repeat(40);
movedPins.source.installTree = 'b'.repeat(40);
movedPins.image.tag = imageTagFor(movedPins);
const movedManifestPath = path.join(converterRoot, 'moved-pins.json');
fs.writeFileSync(movedManifestPath, `${JSON.stringify(movedPins, null, 2)}\n`);
// Restore a compatible identity for this independent source revision case.
writeConversionIdentity(pins);
const reusedAfterSourceMove = runConverter(movedManifestPath, {
  ...fakeEnv,
  ATLAS_TEST_IDENTITY: `arm64 ${movedPins.source.installTree}`
});
assert.equal(reusedAfterSourceMove.status, 0, `${reusedAfterSourceMove.stdout}\n${reusedAfterSourceMove.stderr}`);
assert.match(reusedAfterSourceMove.stdout, /already carries.*skipping/);
fs.rmSync(converterRoot, { recursive: true, force: true });

// ---- the recipe must be indexed -------------------------------------------
const index = JSON.parse(await fs.promises.readFile(path.join(root, 'recipes', 'index.json'), 'utf8'));
const entry = index.recipes.find((item) => item.id === recipe.id);
assert(entry, 'the Atlas recipe must be listed in recipes/index.json');
assert.equal(entry.path, 'linux-nvidia-dgx-spark-2x-glm53-atlas.json');
assert.equal(entry.currentVersion, recipe.version);
assert.equal(entry.versions.filter((version) => version.status === 'current').length, 1);
assert.equal(entry.versions.find((version) => version.status === 'current').path, entry.path);

console.log('Atlas SparkGLM recipe/backend integration checks passed');

assert.equal(conversionHeadroomMiB('9000\n8500\n', 'NVIDIA A100\nNVIDIA A100', ''), 8500);
assert.equal(conversionHeadroomMiB('[N/A]\n', 'NVIDIA GB10\n', 'MemAvailable: 9437184 kB\n'), 9216);
assert.throws(() => conversionHeadroomMiB('[N/A]', 'NVIDIA A100', 'MemAvailable: 9437184 kB'), /not GB10/);
assert.throws(() => conversionHeadroomMiB('[N/A]', 'NVIDIA GB10', ''), /MemAvailable/);
