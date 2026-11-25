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
  CHECKPOINTS,
  PREPARE_TOOL_FILES,
  imageTagFor,
  loadPins,
  verifyPins
} from '../backends/atlas-sparkling/verify-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backends', 'atlas-sparkling');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sparkling-'));
const writeJson = (name, value) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};
const verifyCli = (manifest) =>
  spawnSync(process.execPath, [path.join(backendDir, 'verify-pins.mjs'), manifest], { encoding: 'utf8' });

// ---- pins: the 0.1.0 manifest is a draft and fails closed ----------------------
const draftPath = path.join(backendDir, 'pins-0.1.0.json');
const draft = loadPins(draftPath);
assert.equal(draft.status, 'draft');
const PLACEHOLDERS = [
  'source.revision',
  'source.installTree',
  'engine.branch',
  'engine.commit',
  'image.reference',
  'image.tag',
  ...PREPARE_TOOL_FILES.map((name) => `prepareTool.${name}`)
];
const draftFailures = verifyPins(draft);
for (const name of ['status', ...PLACEHOLDERS]) {
  assert(
    draftFailures.some((failure) => failure.startsWith(name)),
    `the draft manifest is refused for ${name}`
  );
}
assert(
  draftFailures.every((failure) => ['status', ...PLACEHOLDERS].some((name) => failure.startsWith(name))),
  `only the placeholders fail: ${draftFailures.join('; ')}`
);
assert.deepEqual(draft.checkpoints, CHECKPOINTS);
assert.deepEqual(Object.keys(draft.prepareTool).sort(), [...PREPARE_TOOL_FILES].sort());
const draftCli = verifyCli(draftPath);
assert.equal(draftCli.status, 1, 'verify-pins.mjs exits non-zero on the draft');
assert.match(draftCli.stderr, /status must be final, got draft/);

// The same manifest with well-formed release values passes.
const hex = (seed, length) => crypto.createHash('sha256').update(seed).digest('hex').slice(0, length);
const installTree = hex('tree', 40);
const pins = {
  ...draft,
  status: 'final',
  source: { ...draft.source, revision: hex('revision', 40), installTree },
  engine: { ...draft.engine, branch: 'ling/sparkling-0.1.0', commit: hex('engine', 40) },
  image: {
    ...draft.image,
    reference: `ghcr.io/enntity/atlas-sparkling@sha256:${hex('image', 64)}`,
    tag: `ghcr.io/enntity/atlas-sparkling:${installTree.slice(0, 12)}`
  },
  prepareTool: Object.fromEntries(PREPARE_TOOL_FILES.map((name) => [name, hex(name, 64)]))
};
assert.deepEqual(verifyPins(pins), []);
assert.equal(imageTagFor(pins), pins.image.tag);
const finalPath = writeJson('final.json', pins);
const finalCli = verifyCli(finalPath);
assert.equal(finalCli.status, 0, finalCli.stderr);
assert.match(finalCli.stdout, /atlas-sparkling pins verified/);
const rejects = (manifest, prefix, message) =>
  assert(
    verifyPins(manifest).some((failure) => failure.startsWith(prefix)),
    message ?? `${prefix} is rejected`
  );
rejects({ ...pins, image: { ...pins.image, tag: `${pins.image.tag}-x` } }, 'image.tag', 'the tag has no suffix');
rejects({ ...pins, image: { ...pins.image, reference: pins.image.tag } }, 'image.reference', 'the tag is not a digest');
rejects({ ...pins, image: { ...pins.image, id: 'sha256:abc' } }, 'image.id');
rejects({ ...pins, image: { ...pins.image, label: 'io.enntity.sparkinkling.install-tree' } }, 'image.label');
rejects({ ...pins, engine: { ...pins.engine, commit: 'TODO' } }, 'engine.commit');
rejects({ ...pins, engine: { ...pins.engine, branch: '' } }, 'engine.branch');
rejects({ ...pins, engine: { ...pins.engine, repo: 'Atlas-Inf/atlas' } }, 'engine.repo');
rejects({ ...pins, source: { ...pins.source, repo: 'someone/else' } }, 'source.repo');
rejects({ ...pins, source: { ...pins.source, revision: 'main' } }, 'source.revision');
const moved = structuredClone(CHECKPOINTS);
moved['sante-air-vl'].spark.revision = 'main';
rejects({ ...pins, checkpoints: moved }, 'checkpoints');
rejects({ ...pins, checkpoints: undefined }, 'checkpoints', 'the checkpoint pins are required');
rejects({ ...pins, prepareTool: undefined }, 'prepareTool', 'the prepare tool digests are required');
rejects({ ...pins, prepareTool: { ...pins.prepareTool, 'check_files.py': 'TODO' } }, 'prepareTool.check_files.py');

// ---- recipes ----------------------------------------------------------------
const LANES = [
  {
    id: 'linux-nvidia-dgx-spark-ling32-air-atlas',
    model: 'ling-3.2-air',
    served: 'ling-3.2-air-atlas',
    runtime: 'ling32-air-atlas',
    container: 'lloom-atlas-sparkling-ling32-air',
    window: 262144,
    env: {
      spark: {
        SPARKLING_DRAFTER: 'mtp',
        SPARKLING_QUANT: 'publisher',
        SPARKLING_PREFILL_PRECISION: 'nvfp4',
        SPARKLING_DECODE_PRECISION: 'nvfp4'
      },
      strict: {
        SPARKLING_DRAFTER: 'none',
        SPARKLING_QUANT: 'publisher',
        SPARKLING_PREFILL_PRECISION: 'checkpoint',
        SPARKLING_DECODE_PRECISION: 'checkpoint'
      }
    }
  },
  {
    id: 'linux-nvidia-dgx-spark-lingsante-air-vl-atlas',
    model: 'sante-air-vl',
    served: 'lingsante-air-vl',
    runtime: 'lingsante-air-vl-atlas',
    container: 'lloom-atlas-sparkling-lingsante-air-vl',
    window: 131072,
    env: {
      spark: {
        SPARKLING_DRAFTER: 'none',
        SPARKLING_QUANT: 'nvfp4',
        SPARKLING_PREFILL_PRECISION: 'checkpoint',
        SPARKLING_DECODE_PRECISION: 'checkpoint'
      },
      strict: {
        SPARKLING_DRAFTER: 'none',
        SPARKLING_QUANT: 'publisher',
        SPARKLING_PREFILL_PRECISION: 'checkpoint',
        SPARKLING_DECODE_PRECISION: 'checkpoint'
      }
    }
  }
];
const envOf = (runtime) => {
  const args = runtime.bootstrap.createArgs;
  return Object.fromEntries(
    args
      .flatMap((arg, index) => (args[index - 1] === '-e' ? [arg] : []))
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])
  );
};
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

for (const lane of LANES) {
  const recipe = await loadRecipeById(lane.id);
  const manifestArg = recipe.setup.steps.find((step) => step.id === 'verify-atlas-pins').args[1];
  const manifestPath = manifestArg.replace('${repoRoot}', root);
  assert.equal(manifestPath, draftPath, `${lane.id} checks the 0.1.0 pins`);
  assert.equal(recipe.version, 1);
  assert.equal(recipe.backend.id, 'docker-atlas-sparkling');
  assert.equal(recipe.requirements.cluster, undefined, 'one Spark, no fabric');
  assert.equal(recipe.aliases, undefined, 'additive: no aliases');
  assert.deepEqual(validateRecipe(recipe, {}, { checkLocalReferences: false }), []);
  assert.deepEqual(recipeOptionCombinations(recipe), [{ weights: 'spark' }, { weights: 'strict' }]);
  assert.deepEqual(recipe.selectedOptions, { weights: 'spark' }, 'spark is the default, as in start.sh');
  assert.equal(recipe.models.length, 1);
  assert.equal(recipe.models[0].setDefault, false);
  assert.deepEqual(recipe.models[0].input, ['text', 'image', 'video']);

  for (const weights of ['spark', 'strict']) {
    const checkpoint = CHECKPOINTS[lane.model][weights];
    const checkpointDir = checkpoint.repo.replace('/', '--');
    const resolved = applyRecipeOptions(recipe, { weights });
    const model = resolved.models[0];
    assert.equal(model.model, checkpoint.repo);
    assert.equal(model.gatewayModel, lane.served);
    assert.equal(model.upstreamModel, lane.served);
    assert.equal(model.settings.runtime.bootstrap.image, draft.image.reference, 'the pinned digest runs');
    assert.equal(model.settings.runtime.bootstrap.pull, false);
    assert.equal(model.capabilities.includes('speculative-decoding'), lane.env[weights].SPARKLING_DRAFTER !== 'none');
    const downloads = resolved.setup.steps.filter((step) => step.action === 'download-model');
    assert.deepEqual(
      downloads.map((step) => [step.model, step.revision]),
      [[checkpoint.repo, checkpoint.revision]],
      `${lane.id} ${weights} downloads only its pinned checkpoint`
    );

    const plan = planRecipe(
      resolved,
      { models: [], runtimes: {} },
      {
        modelRoot: '/models',
        variables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' },
        platform: 'linux',
        arch: 'arm64',
        backendIds: new Set(['docker-atlas-sparkling']),
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
        'pull-atlas-image',
        'prepare-atlas-model',
        'prepare-atlas-cuda-cache'
      ]
    );
    assert.deepEqual(plan.steps.find((step) => step.id === 'prepare-atlas-model').command, [
      'bash',
      path.join(backendDir, 'prepare.sh'),
      '--manifest',
      draftPath,
      '--model-root',
      '/models',
      '--model',
      lane.model,
      '--weights',
      weights
    ]);
    assert.deepEqual(plan.steps.find((step) => step.id === 'pull-atlas-image').command, [
      'bash',
      path.join(backendDir, 'install.sh'),
      '--manifest',
      draftPath
    ]);
    for (const step of plan.steps.filter((entry) => entry.action === 'command')) {
      assert(!step.command.join(' ').includes('${'), `unresolved recipe template in ${step.id}`);
    }

    // ---- modes materialize to the image's profiles ------------------------------
    const expected = {
      saver: ['saver', 92, 1, 8192],
      default: ['default', 104, 8, lane.window],
      max: ['max', 114, 16, lane.window]
    };
    assert.deepEqual(
      resolved.modes.map((mode) => mode.id),
      Object.keys(expected)
    );
    assert.equal(resolved.modes.find((mode) => mode.default).id, 'default');
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
        applyRecipeMode(resolved, mode),
        {
          modelRoot: '/models',
          additive: true,
          backendVariables: { repoRoot: root, backendRoot: '/backend', installRoot: '/install' }
        }
      );
      assert.equal(config.defaults.chatModel, 'existing-model', 'additive: the default model is kept');
      assert.deepEqual(config.aliases, {}, 'additive: no aliases');
      assert.equal(config.backends[lane.runtime].baseUrl, 'http://127.0.0.1:8897/v1');
      const runtime = config.runtimes[lane.runtime];
      assert.equal(runtime.recipe.mode, mode);
      assert.equal(runtime.memoryGb, memoryGb);
      assert.equal(runtime.maxConcurrency, requests);
      const served = config.models.find((entry) => entry.id === lane.served);
      assert.equal(served.contextWindow, contextWindow);
      assert(served.maxOutputTokens < contextWindow, 'output fits the window');
      const env = envOf(runtime);
      assert.deepEqual(env, {
        MODEL_PATH: '/model',
        SERVED_MODEL_NAME: lane.served,
        SPARKLING_MODEL: lane.model,
        SPARKLING_MODE: weights,
        SPARKLING_PROFILE: profile,
        ...lane.env[weights],
        SPARKLING_TOOL_GUARD: 'stream',
        SPARKLING_TOOL_GUARD_MAX_BYTES: '1048576',
        SPARKLING_TOOL_GUARD_ALLOW_HOSTS: '',
        SPARKLING_TOOL_GUARD_DENY_HOSTS: '',
        CUDA_CACHE_PATH: '/atlas-cuda-cache',
        CUDA_CACHE_MAXSIZE: '4294967296'
      });
      const args = runtime.bootstrap.createArgs;
      assert.equal(flagValue(args, '--memory'), '114g');
      assert.equal(flagValue(args, '--gpus'), 'device=0');
      assert.equal(flagValue(args, '--network'), 'host');
      assert.equal(flagValue(args, '--ipc'), 'host');
      assert.equal(flagValue(args, '--security-opt'), 'no-new-privileges=true');
      const mounts = args.filter((_, index) => args[index - 1] === '--mount');
      assert.deepEqual(mounts, [
        `type=bind,src=/models/${checkpointDir},dst=/model,readonly`,
        'type=bind,src=/install/atlas-sparkling-cuda-cache,dst=/atlas-cuda-cache'
      ]);
      assert.equal(runtime.bootstrap.containerName ?? runtime.containerName, lane.container);
      assert(!args.join(' ').includes('${'), `unresolved template in ${lane.id} ${weights} ${mode}`);
    }
  }
}

// ---- prepare.sh (fake curl and docker) ----------------------------------------
const bin = path.join(tmp, 'bin');
const src = path.join(tmp, 'src');
const models = path.join(tmp, 'models');
fs.mkdirSync(bin);
fs.mkdirSync(src);
for (const model of Object.values(CHECKPOINTS)) {
  for (const checkpoint of Object.values(model)) {
    fs.mkdirSync(path.join(models, checkpoint.repo.replace('/', '--')), { recursive: true });
  }
}
for (const name of PREPARE_TOOL_FILES) fs.writeFileSync(path.join(src, name), `# ${name}\n`);
const digest = (name) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(src, name)))
    .digest('hex');
const testPins = writeJson('pins.json', {
  ...pins,
  prepareTool: Object.fromEntries(PREPARE_TOOL_FILES.map((name) => [name, digest(name)]))
});
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
const runPrepare = (model, weights, manifest = testPins) => {
  fs.rmSync(log, { force: true });
  const result = spawnSync(
    'bash',
    [
      path.join(backendDir, 'prepare.sh'),
      '--manifest',
      manifest,
      '--model-root',
      models,
      '--model',
      model,
      '--weights',
      weights
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
  );
  result.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  result.fetched = [...result.calls.matchAll(/^curl .*\/install\/(\S+)$/gm)].map((match) => match[1]);
  result.checks = [...result.calls.matchAll(/^docker .*\/sparkling-tool\/check_files\.py (.*)$/gm)].map(
    (match) => match[1]
  );
  return result;
};
for (const [model, byWeights] of Object.entries(CHECKPOINTS)) {
  for (const [weights, checkpoint] of Object.entries(byWeights)) {
    const dir = path.join(models, checkpoint.repo.replace('/', '--'));
    const run = runPrepare(model, weights);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.fetched, ['check_files.py', checkpoint.manifest], `${model} ${weights} fetches its pin file`);
    assert.match(run.calls, /docker run --rm --network none --user \d+:\d+ --entrypoint python3/);
    assert(run.calls.includes(`type=bind,src=${dir},dst=${dir},readonly`), 'only the checkpoint is mounted, read-only');
    assert.deepEqual(run.checks, [`${weights} ${dir} --manifest /sparkling-tool/${checkpoint.manifest}`]);
  }
}
for (const [model, weights] of [
  ['ling-3.2-air', 'fast'],
  ['ling-4', 'spark']
]) {
  const unknown = runPrepare(model, weights);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.calls, '', 'a bad argument runs nothing');
}
const refusedDraft = runPrepare('ling-3.2-air', 'spark', draftPath);
assert.equal(refusedDraft.status, 1);
assert.match(refusedDraft.stderr, /is not installable/);
assert.equal(refusedDraft.calls, '', 'the draft manifest fetches and runs nothing');
const tampered = writeJson('tampered.json', {
  ...pins,
  prepareTool: { ...JSON.parse(fs.readFileSync(testPins, 'utf8')).prepareTool, 'check_files.py': 'a'.repeat(64) }
});
const refused = runPrepare('sante-air-vl', 'spark', tampered);
assert.equal(refused.status, 1);
assert.match(refused.stderr, /install\/check_files\.py has sha256 [a-f0-9]{64}; the manifest pins a{64}/);
assert.doesNotMatch(refused.calls, /docker/, 'an unpinned tool never runs');
fs.rmSync(path.join(models, 'inclusionAI--LingSante-3.1-air-VL'), { recursive: true });
const missing = runPrepare('sante-air-vl', 'strict');
assert.equal(missing.status, 1);
assert.match(missing.stderr, /checkpoint .* is missing/);
assert.equal(missing.calls, '');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('atlas-sparkling recipe tests passed');
