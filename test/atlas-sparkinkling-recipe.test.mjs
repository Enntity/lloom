import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveUserConfig } from '../src/init.mjs';
import {
  applyRecipeMode,
  applyRecipeOptions,
  loadRecipeById,
  planRecipe,
  recipeOptionCombinations,
  validateRecipe
} from '../src/recipes.mjs';
import {
  DFLASH2_REPO,
  DSPARK_TOOL_FILE,
  MODEL_REPO,
  OVERLAY_REPO,
  PREPARE_TOOL_FILES,
  imageTagFor,
  prepareToolFiles,
  loadPins,
  verifyPins
} from '../backends/atlas-sparkinkling/verify-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backends', 'atlas-sparkinkling');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-inkling2-mini-atlas');
const manifestArg = recipe.setup.steps.find((step) => step.id === 'verify-atlas-pins').args[1];
const manifestPath = manifestArg.replace('${repoRoot}', root);
const pins = loadPins(manifestPath);
const checkpoint = 'thinkingmachines--Inkling-2-Mini';
const overlayDir = 'Enntity--Inkling-2-Mini-Spark-NVFP4';
const drafterDir = 'incoai--Inkling-2-Mini-DFlash2';
const forWeights = (weights) => applyRecipeOptions(recipe, { weights });

// ---- pins -------------------------------------------------------------------
assert.deepEqual(verifyPins(pins), []);
assert.equal(pins.model.repo, MODEL_REPO);
assert.equal(pins.overlay.repo, OVERLAY_REPO);
assert.equal(pins.image.tag, `ghcr.io/enntity/atlas-sparkinkling:${pins.source.installTree.slice(0, 12)}`);
assert.equal(imageTagFor(pins), pins.image.tag);
assert.equal(pins.image.profilePath, '/opt/atlas/profiles/default.json');
const rejects = (manifest, prefix, message) =>
  assert(
    verifyPins(manifest).some((failure) => failure.startsWith(prefix)),
    message ?? `${prefix} is rejected`
  );
rejects({ ...pins, image: { ...pins.image, tag: `${pins.image.tag}-27b` } }, 'image.tag', 'the tag has no suffix');
rejects({ ...pins, status: 'draft' }, 'status');
rejects({ ...pins, image: { ...pins.image, reference: 'TODO' } }, 'image.reference');
rejects({ ...pins, engine: { ...pins.engine, commit: 'DRAFT' } }, 'engine.commit');
rejects({ ...pins, model: { ...pins.model, revision: 'main' } }, 'model must');
rejects({ ...pins, overlay: undefined }, 'overlay must', 'the overlay pin is required');
rejects({ ...pins, overlay: { ...pins.overlay, revision: 'main' } }, 'overlay must');
rejects({ ...pins, source: { ...pins.source, repo: 'someone/else' } }, 'source.repo');
rejects({ ...pins, prepareTool: undefined }, 'prepareTool', 'the prepare tool digests are required');
rejects({ ...pins, prepareTool: { ...pins.prepareTool, 'spark_overlay.py': 'TODO' } }, 'prepareTool.spark_overlay.py');
rejects({ ...pins, dflash2: { ...pins.dflash2, revision: 'main' } }, 'dflash2 must');
assert.deepEqual(Object.keys(pins.prepareTool).sort(), [...PREPARE_TOOL_FILES].sort());
assert.deepEqual(prepareToolFiles(pins), PREPARE_TOOL_FILES, '0.5.0 runs no DSpark tool');
// a 0.4.x manifest (no dflash2 pin) still needs the DSpark tool's digest
rejects({ ...pins, dflash2: undefined }, `prepareTool.${DSPARK_TOOL_FILE}`);
for (const archived of ['pins-0.5.0-a9fac42abe15.json', 'pins-0.5.0.json', 'pins-0.4.2.json']) {
  assert.deepEqual(
    verifyPins(loadPins(path.join(backendDir, archived))),
    [],
    `${archived}: the archived version stays installable`
  );
}

// ---- recipe -----------------------------------------------------------------
assert.equal(recipe.version, 5);
assert.equal(recipe.backend.id, 'docker-atlas-sparkinkling');
assert.equal(recipe.requirements.cluster, undefined, 'one Spark, no fabric');
assert.equal(recipe.aliases, undefined, 'additive: no aliases');
assert.deepEqual(validateRecipe(recipe, {}, { checkLocalReferences: false }), []);
assert.deepEqual(recipeOptionCombinations(recipe), [{ weights: 'strict' }, { weights: 'spark' }]);
assert.deepEqual(recipe.selectedOptions, { weights: 'spark' }, 'spark is the default');
assert.equal(recipe.models[0].setDefault, false);

for (const weights of ['strict', 'spark']) {
  const resolved = forWeights(weights);
  assert.equal(resolved.models[0].settings.runtime.bootstrap.image, pins.image.reference, 'the pinned digest runs');
  assert.equal(resolved.models[0].settings.runtime.bootstrap.pull, false);
  const downloads = Object.fromEntries(
    resolved.setup.steps.filter((step) => step.action === 'download-model').map((step) => [step.model, step])
  );
  assert.equal(downloads[MODEL_REPO].revision, pins.model.revision);
  const drafter = downloads[DFLASH2_REPO];
  assert.equal(drafter.revision, pins.dflash2.revision, 'both weights download the DFlash2 drafter');
  assert.deepEqual(
    drafter.include,
    drafter.integrity.files.map((file) => file.path)
  );
  assert.equal(
    drafter.integrity.files.find((file) => file.path === 'model.safetensors').sha256,
    '217980ab00d116693fa5946df7bbfd967caf5fac1f529afd541fbd470ddb54ee'
  );
  if (weights === 'strict') {
    assert.equal(downloads[OVERLAY_REPO], undefined, 'strict downloads no overlay');
  } else {
    const overlay = downloads[OVERLAY_REPO];
    assert.equal(overlay.revision, pins.overlay.revision);
    const files = overlay.integrity.files;
    assert.deepEqual(
      overlay.include,
      files.map((file) => file.path)
    );
    assert(
      files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.sizeBytes > 0),
      'the overlay is digest-pinned'
    );
    assert.equal(
      files.find((file) => file.path === 'spark-nvfp4.safetensors').sha256,
      '974daf0c7df61201e43f6e6550e677277206f9c0c5b7d0787078262cd578f570'
    );
  }

  const plan = planRecipe(
    resolved,
    { models: [], runtimes: {} },
    {
      modelRoot: '/models',
      variables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' },
      platform: 'linux',
      arch: 'arm64',
      backendIds: new Set(['docker-atlas-sparkinkling']),
      checkLocalReferences: false
    }
  );
  assert.deepEqual(plan.validationErrors, []);
  const stepIds = plan.steps.map((step) => step.id);
  const prepareAt = stepIds.indexOf('prepare-atlas-model');
  assert(prepareAt > stepIds.indexOf('pull-atlas-image'), 'the prepare tools run in the image');
  assert(prepareAt > stepIds.indexOf('download-atlas-model'));
  assert(prepareAt > stepIds.indexOf('download-atlas-drafter'));
  if (weights === 'spark') assert(prepareAt > stepIds.indexOf('download-atlas-overlay'));
  else assert(!stepIds.includes('download-atlas-overlay'));
  assert.deepEqual(plan.steps.find((step) => step.id === 'prepare-atlas-model').command, [
    'bash',
    path.join(backendDir, 'prepare.sh'),
    '--manifest',
    manifestPath,
    '--model-root',
    '/models',
    '--weights',
    weights
  ]);
  for (const step of plan.steps.filter((entry) => entry.action === 'command')) {
    assert(!step.command.join(' ').includes('${'), `unresolved recipe template in ${step.id}`);
  }
}

// ---- modes x weights materialize to the image's profiles ----------------------
const envOf = (runtime) => {
  const args = runtime.bootstrap.createArgs;
  return Object.fromEntries(
    args
      .flatMap((arg, index) => (args[index - 1] === '-e' ? [arg] : []))
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])
  );
};
const expected = {
  saver: ['saver', 66, 8, 786432],
  default: ['default', 104, 8, 1048576],
  max: ['max', 110, 32, 1048576]
};
assert.deepEqual(
  recipe.modes.map((mode) => mode.id),
  Object.keys(expected)
);
assert.equal(recipe.modes.find((mode) => mode.default).id, 'default');
for (const weights of ['strict', 'spark']) {
  for (const [mode, [profile, memoryGb, requests, contextWindow]] of Object.entries(expected)) {
    const config = deriveUserConfig(
      {
        server: { host: '127.0.0.1', port: 8100 },
        security: {},
        defaults: { chatModel: 'existing-model' },
        models: [{ id: 'existing-model', advertise: true }],
        backends: {},
        runtimes: {},
        aliases: {},
        clientCatalog: { modelOrder: ['existing-model'] }
      },
      applyRecipeMode(forWeights(weights), mode),
      {
        modelRoot: '/models',
        additive: true,
        backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
      }
    );
    assert.equal(config.defaults.chatModel, 'existing-model', 'additive: the default model is kept');
    assert.deepEqual(config.aliases, {}, 'additive: no aliases');
    assert.equal(config.backends['inkling2-mini-atlas'].baseUrl, 'http://127.0.0.1:8895/v1');
    const runtime = config.runtimes['inkling2-mini-atlas'];
    assert.equal(runtime.recipe.mode, mode);
    assert.equal(runtime.memoryGb, memoryGb);
    assert.equal(runtime.maxConcurrency, requests);
    assert.equal(config.models.find((model) => model.id === 'inkling-2-mini-atlas').contextWindow, contextWindow);
    const env = envOf(runtime);
    assert.equal(env.SPARKINKLING_PROFILE, profile);
    assert.equal(env.SPARKINKLING_MODE, weights);
    assert.equal(env.SPARKINKLING_DRAFTER, 'dflash2');
    assert.equal(env.DRAFTER_PATH, `/models/${drafterDir}`);
    assert.equal(env.MODEL_PATH, `/models/${checkpoint}${weights === 'spark' ? '+spark-nvfp4' : ''}`);
    assert.equal(env.SERVED_MODEL_NAME, 'inkling-2-mini-atlas');
    assert.equal(env.SPARKINKLING_TOOL_GUARD, 'stream');
    assert.equal(env.SPARKINKLING_TOOL_GUARD_MAX_BYTES, '1048576');
    assert.equal(env.SPARKINKLING_TOOL_GUARD_ALLOW_HOSTS, '');
    assert.equal(env.SPARKINKLING_TOOL_GUARD_DENY_HOSTS, '');
    assert.equal(env.HF_HUB_OFFLINE, '1');
    assert.equal(env.CUDA_CACHE_PATH, '/atlas-cuda-cache');
    const mounts = runtime.bootstrap.createArgs.filter((_, index, args) => args[index - 1] === '--mount');
    const readOnly = [`/models/${checkpoint}`, `/models/${drafterDir}`];
    const sparkOnly = [`/models/${overlayDir}`, `/models/${checkpoint}+spark-nvfp4`];
    for (const dir of weights === 'spark' ? [...readOnly, ...sparkOnly] : readOnly) {
      assert(mounts.includes(`type=bind,src=${dir},dst=${dir},readonly`), `${dir} is mounted read-only`);
    }
    if (weights === 'strict') {
      for (const dir of sparkOnly) assert(!mounts.some((mount) => mount.includes(dir)), `strict mounts no ${dir}`);
    }
    assert(mounts.includes('type=bind,src=/install/atlas-sparkinkling-cuda-cache,dst=/atlas-cuda-cache'));
    assert.equal(mounts.length, weights === 'spark' ? 5 : 3);
    assert.equal(runtime.bootstrap.containerName ?? runtime.containerName, 'lloom-atlas-sparkinkling');
    assert(!runtime.bootstrap.createArgs.join(' ').includes('${'), `unresolved template in ${weights} ${mode}`);
  }
}

// ---- prepare.sh (fake curl and docker) ----------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sparkinkling-'));
const bin = path.join(tmp, 'bin');
const src = path.join(tmp, 'src');
const models = path.join(tmp, 'models');
fs.mkdirSync(bin);
fs.mkdirSync(src);
for (const dir of [checkpoint, overlayDir, drafterDir]) fs.mkdirSync(path.join(models, dir), { recursive: true });
for (const name of [...PREPARE_TOOL_FILES, DSPARK_TOOL_FILE]) fs.writeFileSync(path.join(src, name), `# ${name}\n`);
const digest = (name) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(src, name)))
    .digest('hex');
const testPins = path.join(tmp, 'pins.json');
fs.writeFileSync(
  testPins,
  JSON.stringify({ ...pins, prepareTool: Object.fromEntries(PREPARE_TOOL_FILES.map((name) => [name, digest(name)])) })
);
const log = path.join(tmp, 'calls.log');
fs.writeFileSync(
  path.join(bin, 'curl'),
  `#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> '${log}'
out=""; url=""
while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
[[ "$url" == "https://raw.githubusercontent.com/${pins.source.repo}/${pins.source.revision}/install/"* ]] || exit 22
cp '${src}'/"\${url##*/}" "$out"
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(bin, 'docker'),
  `#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> '${log}'
[[ "$*" == *'--network none'* && "$*" == *'--entrypoint python3'* && "$*" == *'${pins.image.reference}'* ]] || exit 3
`,
  { mode: 0o755 }
);
const runPrepare = (weights, manifest = testPins) => {
  fs.rmSync(log, { force: true });
  const result = spawnSync(
    'bash',
    [path.join(backendDir, 'prepare.sh'), '--manifest', manifest, '--model-root', models, '--weights', weights],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
  );
  result.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  result.tools = [
    ...result.calls.matchAll(/^docker .*\/sparkinkling-tool\/(\S+) \/sparkinkling-tool\/checkpoint\.json (.*)$/gm)
  ].map((match) => `${match[1]} ${match[2]}`);
  return result;
};
const cp = path.join(models, checkpoint);
const ov = path.join(models, overlayDir);
const dr = path.join(models, drafterDir);
const spark = runPrepare('spark');
assert.equal(spark.status, 0, spark.stderr);
assert.equal((spark.calls.match(/^curl /gm) ?? []).length, PREPARE_TOOL_FILES.length);
assert.match(spark.calls, /docker run --rm --network none --user \d+:\d+ --entrypoint python3/);
assert(spark.calls.includes(`type=bind,src=${models},dst=${models}`), 'the model root is mounted at its own path');
assert.deepEqual(spark.tools, [
  `check_files.py ${cp}`,
  `check_files.py ${dr} dflash2`,
  `check_files.py ${ov} overlay`,
  `spark_overlay.py ${cp} ${ov} ${cp}+spark-nvfp4`
]);
const strict = runPrepare('strict');
assert.equal(strict.status, 0, strict.stderr);
assert.deepEqual(strict.tools, [`check_files.py ${cp}`, `check_files.py ${dr} dflash2`]);
// an archived 0.4.x manifest (no dflash2 pin) assembles the DSpark drafter as before
const legacyPins = path.join(tmp, 'legacy.json');
const { dflash2: _drop, ...legacy } = JSON.parse(fs.readFileSync(testPins, 'utf8'));
fs.writeFileSync(
  legacyPins,
  JSON.stringify({ ...legacy, prepareTool: { ...legacy.prepareTool, [DSPARK_TOOL_FILE]: digest(DSPARK_TOOL_FILE) } })
);
const legacyRun = runPrepare('strict', legacyPins);
assert.equal(legacyRun.status, 0, legacyRun.stderr);
assert.deepEqual(legacyRun.tools, [`check_files.py ${cp}`, `dspark_drafter.py ${cp} ${cp}+dspark`]);
const unknown = runPrepare('fast');
assert.equal(unknown.status, 2);
assert.doesNotMatch(unknown.calls, /docker/);
const tampered = path.join(tmp, 'tampered.json');
fs.writeFileSync(
  tampered,
  JSON.stringify({
    ...pins,
    prepareTool: { ...JSON.parse(fs.readFileSync(testPins, 'utf8')).prepareTool, 'check_files.py': 'a'.repeat(64) }
  })
);
const refused = runPrepare('spark', tampered);
assert.equal(refused.status, 1);
assert.match(refused.stderr, /install\/check_files\.py has sha256 [a-f0-9]{64}; the manifest pins a{64}/);
assert.doesNotMatch(refused.calls, /docker/, 'an unpinned tool never runs');
fs.rmSync(ov, { recursive: true });
const noOverlay = runPrepare('spark');
assert.equal(noOverlay.status, 1);
assert.match(noOverlay.stderr, /overlay .* is missing/);
assert.doesNotMatch(noOverlay.calls, /docker/);
fs.rmSync(dr, { recursive: true });
const noDrafter = runPrepare('strict');
assert.equal(noDrafter.status, 1);
assert.match(noDrafter.stderr, /drafter .* is missing/);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('atlas-sparkinkling recipe tests passed');
