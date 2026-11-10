import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveUserConfig } from '../src/init.mjs';
import { applyRecipeMode, loadRecipeById, planRecipe, validateRecipe } from '../src/recipes.mjs';
import { MODEL_27B_REPO, imageTagFor, loadPins, verifyPins } from '../backends/atlas-sparkqwen/verify-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backends', 'atlas-sparkqwen');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-qwen38-27b-atlas');
const manifestArg = recipe.setup.steps.find((step) => step.id === 'verify-atlas-pins').args[1];
const manifestPath = manifestArg.replace('${repoRoot}', root);
const pins = loadPins(manifestPath);
const checkpoint = 'nvidia--Qwen3.8-27B-NVFP4';
const overlay = `/models/${checkpoint}+tandem-gdn-attn`;

// ---- pins -------------------------------------------------------------------
assert.deepEqual(verifyPins(pins), []);
assert.equal(pins.model.repo, MODEL_27B_REPO);
assert.equal(pins.image.tag, `ghcr.io/enntity/atlas-sparkqwen:${pins.source.installTree.slice(0, 12)}-27b`);
assert.equal(imageTagFor(pins), pins.image.tag);
assert.equal(pins.image.profilePath, '/opt/atlas/profiles/27b.json');
assert(
  verifyPins({ ...pins, image: { ...pins.image, tag: imageTagFor(pins).replace('-27b', '') } }).some((f) =>
    f.startsWith('image.tag')
  ),
  'a 27B image keeps its -27b tag'
);
assert(
  verifyPins({ ...pins, overlayTool: { 'tandem_overlay.py': 'TODO' } }).some((f) => f.startsWith('overlayTool')),
  'the overlay tool digests are required for the 27B checkpoint'
);
assert(verifyPins({ ...pins, model: { ...pins.model, revision: 'main' } }).some((f) => f.startsWith('model must')));

// ---- recipe -----------------------------------------------------------------
assert.equal(recipe.version, 5);
assert.equal(recipe.backend.id, 'docker-atlas-sparkqwen');
assert.equal(recipe.requirements.cluster, undefined, 'one Spark, no fabric');
assert.deepEqual(validateRecipe(recipe, {}, { checkLocalReferences: false }), []);
const image = recipe.models[0].settings.runtime.bootstrap.image;
assert.equal(image, pins.image.reference, 'the runtime starts the pinned digest');
assert.equal(recipe.models[0].setDefault, false);
const downloads = Object.fromEntries(
  recipe.setup.steps.filter((step) => step.action === 'download-model').map((step) => [step.model, step])
);
assert.equal(downloads[MODEL_27B_REPO].revision, pins.model.revision);
for (const repo of ['tencent/Qwen3.8-27B-DSpine-b16', '0xBakeer/TandemLLM-Qwen3.8-27B-NVFP4']) {
  const files = downloads[repo].integrity.files;
  assert.deepEqual(
    downloads[repo].include,
    files.map((file) => file.path)
  );
  assert(
    files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.sizeBytes > 0),
    `${repo} is digest-pinned`
  );
}

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
const stepIds = plan.steps.map((step) => step.id);
assert(stepIds.indexOf('build-atlas-overlay') > stepIds.indexOf('download-atlas-overlay-weights'));
assert(stepIds.indexOf('build-atlas-overlay') > stepIds.indexOf('pull-atlas-image'), 'the overlay runs in the image');
assert.deepEqual(plan.steps.find((step) => step.id === 'build-atlas-overlay').command, [
  'bash',
  path.join(backendDir, 'overlay-27b.sh'),
  '--manifest',
  manifestPath,
  '--model-root',
  '/models'
]);
for (const step of plan.steps.filter((entry) => entry.action === 'command')) {
  assert(!step.command.join(' ').includes('${'), `unresolved recipe template in ${step.id}`);
}

// ---- modes materialize to the image's profiles --------------------------------
const envOf = (runtime) => {
  const args = runtime.bootstrap.createArgs;
  return Object.fromEntries(
    args
      .flatMap((arg, index) => (args[index - 1] === '-e' ? [arg] : []))
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])
  );
};
const expected = {
  default: ['27b', 'dflash2', 112, 64],
  saver: ['27b-saver', 'dflash2', 78, 8],
  max: ['27b-max', 'both', 112, 32]
};
assert.deepEqual(
  recipe.modes.map((mode) => mode.id),
  Object.keys(expected)
);
for (const [mode, [profile, drafter, memoryGb, requests]] of Object.entries(expected)) {
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
    applyRecipeMode(recipe, mode),
    {
      modelRoot: '/models',
      additive: true,
      backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
    }
  );
  assert.equal(config.defaults.chatModel, 'existing-model', 'additive: the default model is kept');
  assert.equal(config.backends['qwen38-27b-atlas'].baseUrl, 'http://127.0.0.1:8893/v1');
  const runtime = config.runtimes['qwen38-27b-atlas'];
  assert.equal(runtime.recipe.mode, mode);
  assert.equal(runtime.memoryGb, memoryGb);
  assert.equal(runtime.maxConcurrency, requests);
  const env = envOf(runtime);
  assert.equal(env.SPARKQWEN_PROFILE, profile);
  assert.equal(env.SPARKQWEN_DRAFTER, drafter);
  assert.equal(env.MODEL_PATH, overlay);
  assert.equal(env.SERVED_MODEL_NAME, 'qwen3.8-27b-atlas');
  const mounts = runtime.bootstrap.createArgs.filter((_, index, args) => args[index - 1] === '--mount');
  for (const dir of [overlay, `/models/${checkpoint}`, env.DRAFT_PATH, env.DSPINE_PATH]) {
    assert(mounts.includes(`type=bind,src=${dir},dst=${dir},readonly`), `${dir} is mounted read-only`);
  }
  assert(!runtime.bootstrap.createArgs.join(' ').includes('${'), `unresolved template in ${mode}`);
}

// ---- overlay-27b.sh (fake curl and docker) ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sparkqwen-27b-'));
const bin = path.join(tmp, 'bin');
const src = path.join(tmp, 'src');
const models = path.join(tmp, 'models');
fs.mkdirSync(bin);
fs.mkdirSync(src);
for (const dir of [checkpoint, '0xBakeer--TandemLLM-Qwen3.8-27B-NVFP4']) {
  fs.mkdirSync(path.join(models, dir), { recursive: true });
}
fs.writeFileSync(path.join(src, 'tandem_overlay.py'), '# tool\n');
fs.writeFileSync(path.join(src, 'checkpoint-27b.json'), JSON.stringify({ overlay: { revision: 'rev-1' } }));
const digest = (name) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(src, name)))
    .digest('hex');
const testPins = path.join(tmp, 'pins.json');
fs.writeFileSync(
  testPins,
  JSON.stringify({
    ...pins,
    overlayTool: {
      'tandem_overlay.py': digest('tandem_overlay.py'),
      'checkpoint-27b.json': digest('checkpoint-27b.json')
    }
  })
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
[[ "$*" == *'--network none'* && "$*" == *'${pins.image.reference}'* ]] || exit 3
overlay="\${@: -1}"; mkdir -p "$overlay"; echo rev-1 > "$overlay/.sparkqwen-overlay"
`,
  { mode: 0o755 }
);
const runOverlay = (manifest = testPins) => {
  fs.rmSync(log, { force: true });
  const result = spawnSync(
    'bash',
    [path.join(backendDir, 'overlay-27b.sh'), '--manifest', manifest, '--model-root', models],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
  );
  result.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return result;
};
const built = runOverlay();
assert.equal(built.status, 0, built.stderr);
assert.match(built.calls, /docker run --rm --network none/);
assert.equal(
  fs.readFileSync(path.join(models, `${checkpoint}+tandem-gdn-attn`, '.sparkqwen-overlay'), 'utf8'),
  'rev-1\n'
);
const reused = runOverlay();
assert.equal(reused.status, 0, reused.stderr);
assert.match(reused.stdout, /is current \(rev-1\); reusing it/);
assert.doesNotMatch(reused.calls, /docker/);
const tampered = path.join(tmp, 'tampered.json');
fs.writeFileSync(
  tampered,
  JSON.stringify({
    ...pins,
    overlayTool: { ...JSON.parse(fs.readFileSync(testPins, 'utf8')).overlayTool, 'tandem_overlay.py': 'a'.repeat(64) }
  })
);
const refused = runOverlay(tampered);
assert.equal(refused.status, 1);
assert.match(refused.stderr, /install\/tandem_overlay\.py has sha256 [a-f0-9]{64}; the manifest pins a{64}/);
assert.doesNotMatch(refused.calls, /docker/, 'an unpinned tool never runs');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('atlas-sparkqwen 27B recipe tests passed');
