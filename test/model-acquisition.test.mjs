import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRecipe } from '../src/installer.mjs';
import {
  finalizeModelAcquisition,
  MODEL_ACQUISITION_MANIFEST,
  modelAcquisitionStatus,
  prepareModelAcquisition,
  validateAcquisitionStep
} from '../src/model-acquisition.mjs';
import { planRecipe } from '../src/recipes.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-acquisition-'));
const destination = path.join(root, 'owner--model');
const contents = 'verified weights\n';
const digest = crypto.createHash('sha256').update(contents).digest('hex');
const revision = '0123456789abcdef0123456789abcdef01234567';
const step = {
  action: 'download-model',
  provider: 'huggingface',
  model: 'owner/model',
  revision,
  destination,
  integrity: {
    files: [{ path: 'model.gguf', sizeBytes: Buffer.byteLength(contents), sha256: digest }]
  }
};

assert.deepEqual(validateAcquisitionStep(step), []);
assert.equal(validateAcquisitionStep({ ...step, revision: 'main' }).length, 1);
assert.equal(validateAcquisitionStep({ ...step, integrity: { files: [{ path: '../escape.gguf' }] } }).length, 1);

const prepared = await prepareModelAcquisition(step);
assert.equal(prepared.workPath, `${destination}.incomplete`);
await fs.writeFile(path.join(prepared.workPath, 'model.gguf'), contents);
const finalized = await finalizeModelAcquisition(step, prepared);
assert.equal(finalized.complete, true);
assert.equal(await fs.readFile(path.join(destination, 'model.gguf'), 'utf8'), contents);
assert.equal(
  JSON.parse(await fs.readFile(path.join(destination, MODEL_ACQUISITION_MANIFEST), 'utf8')).revision,
  revision
);

const verified = await modelAcquisitionStatus(step);
assert.equal(verified.complete, true);
assert.equal(verified.verified, true);

await fs.writeFile(path.join(destination, 'model.gguf'), 'tampered\n');
const tampered = await modelAcquisitionStatus(step);
assert.equal(tampered.complete, false);
assert.equal(tampered.reason, 'size-mismatch:model.gguf');

const recipeRoot = path.join(root, 'recipe-models');
const recipeHf = path.join(recipeRoot, '.hf-cli', 'bin', 'hf');
await fs.mkdir(path.dirname(recipeHf), { recursive: true });
await fs.writeFile(
  recipeHf,
  '#!/bin/sh\nfor last do :; done\nmkdir -p "$last"\nprintf "recipe owned hf\\n" > "$last/config.json"\nprintf "weights\\n" > "$last/model.safetensors"\n',
  { mode: 0o755 }
);
await fs.chmod(recipeHf, 0o755);
const recipeResult = await applyRecipe(
  {
    schemaVersion: 1,
    id: 'recipe-owned-hf-test',
    name: 'Recipe-owned HF test',
    backend: { id: 'test-backend' },
    setup: {
      steps: [
        {
          id: 'download',
          action: 'download-model',
          provider: 'huggingface',
          model: 'owner/recipe-model',
          revision
        }
      ]
    },
    models: [{ role: 'default', model: 'owner/recipe-model' }]
  },
  { models: [], runtimes: {} },
  {
    dryRun: false,
    yes: true,
    modelRoot: recipeRoot,
    statePath: path.join(root, 'recipe-install-state.json'),
    env: { ...process.env, PATH: '/usr/bin:/bin', LLOOM_HF_BIN: '', HF_HUB_CLI: '' }
  }
);
assert.equal(recipeResult.results[0].status, 'completed', JSON.stringify(recipeResult.results[0]));
assert.equal(recipeResult.results[0].command[0], recipeHf);
assert.equal(
  await fs.readFile(path.join(recipeRoot, 'owner--recipe-model', 'config.json'), 'utf8'),
  'recipe owned hf\n'
);

console.log('model acquisition tests passed');

// -- per-file acquisition -----------------------------------------------------
// Model repositories carry every quantization of a model, so a recipe that serves
// one checkpoint names its files instead of pulling the whole repository.

const selective = {
  ...step,
  include: ['diffusion_models/model_int8.safetensors', 'text_encoders/encoder_fp8*.safetensors']
};
assert.deepEqual(validateAcquisitionStep(selective), []);
assert.equal(validateAcquisitionStep({ ...selective, include: ['../escape.safetensors'] }).length, 1);
assert.equal(validateAcquisitionStep({ ...selective, include: ['/absolute.safetensors'] }).length, 1);
assert.equal(validateAcquisitionStep({ ...selective, include: [''] }).length, 1);
assert.match(
  validateAcquisitionStep({ ...selective, include: ['[z-a].safetensors'] }).join('\n'),
  /invalid glob pattern/
);
assert.deepEqual(validateAcquisitionStep({ ...step, include: undefined }), []);

const plan = planRecipe(
  {
    id: 'selective-fixture',
    name: 'Selective fixture',
    version: 1,
    requirements: { platforms: ['linux-x64', 'linux-arm64', 'darwin-arm64'] },
    backend: { id: 'openai-compatible' },
    setup: { steps: [{ id: 'download', action: 'download-model', ...selective }] },
    models: [{ role: 'fixture', model: 'owner/model', gatewayModel: 'owner/model', runtime: 'fixture-runtime' }]
  },
  { backends: {}, runtimes: {} },
  { backendIds: new Set(['openai-compatible']), checkLocalReferences: false }
);
const plannedDownload = plan.steps.find((entry) => entry.id === 'download');
assert.deepEqual(plannedDownload.include, selective.include);
const includeFlags = plannedDownload.commands.map((command) => command[command.indexOf('--include') + 1]);
assert.deepEqual(includeFlags, selective.include);
assert.ok(plannedDownload.command.includes('--revision'));
assert.ok(plannedDownload.command.includes('--local-dir'));

// Execute the recipe through a CLI that deliberately behaves like legacy
// argparse (last --include wins). One invocation per pattern also works on Typer.
await fs.writeFile(
  recipeHf,
  `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const destination = args[args.indexOf('--local-dir') + 1];
const index = args.lastIndexOf('--include');
const file = index >= 0 ? args[index + 1] : 'unexpected-full-download';
if (process.env.FAIL_FILE === file) process.exit(9);
fs.mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
fs.writeFileSync(path.join(destination, file), 'weights\\n');
`,
  { mode: 0o755 }
);
const selectedFiles = ['split_files/diffusion_models/a.safetensors', 'split_files/vae/b.safetensors'];
const selectiveRecipe = {
  schemaVersion: 1,
  id: 'selected-cli',
  name: 'Selected CLI',
  backend: { id: 'test-backend' },
  models: [{ role: 'default', model: 'owner/selected' }],
  setup: {
    steps: [
      {
        id: 'download',
        action: 'download-model',
        model: 'owner/selected',
        revision,
        include: selectedFiles,
        integrity: { files: selectedFiles.map((file) => ({ path: file, sizeBytes: 8 })) }
      }
    ]
  }
};
const options = {
  dryRun: false,
  yes: true,
  modelRoot: recipeRoot,
  statePath: path.join(root, 'selected-state.json'),
  env: { ...process.env, PATH: '/usr/bin:/bin' }
};
const failed = await applyRecipe(
  selectiveRecipe,
  { models: [], runtimes: {} },
  { ...options, env: { ...options.env, FAIL_FILE: selectedFiles[1] } }
);
assert.equal(failed.results[0].status, 'failed');
assert.equal(
  await fs.stat(path.join(recipeRoot, 'owner--selected.incomplete', selectedFiles[0])).then(() => true),
  true
);
assert.equal(
  await fs.stat(path.join(recipeRoot, 'owner--selected')).then(
    () => true,
    () => false
  ),
  false
);
const resumed = await applyRecipe(selectiveRecipe, { models: [], runtimes: {} }, options);
assert.equal(resumed.results[0].status, 'completed', JSON.stringify(resumed.results));
for (const file of selectedFiles)
  assert.equal(await fs.readFile(path.join(recipeRoot, 'owner--selected', file), 'utf8'), 'weights\n');
assert.equal((await applyRecipe(selectiveRecipe, { models: [], runtimes: {} }, options)).results[0].status, 'skipped');

// A later recipe may request a subset of a previously recorded selection. The
// existing manifest is a superset, so the installer must not invoke hf again.
const subsetRecipe = {
  ...selectiveRecipe,
  id: 'selected-subset',
  setup: {
    steps: [
      {
        ...selectiveRecipe.setup.steps[0],
        id: 'download-subset',
        include: [selectedFiles[0]],
        integrity: { files: [{ path: selectedFiles[0], sizeBytes: 8 }] }
      }
    ]
  }
};
const subset = await applyRecipe(
  subsetRecipe,
  { models: [], runtimes: {} },
  {
    ...options,
    statePath: path.join(root, 'subset-state.json'),
    env: { ...options.env, FAIL_FILE: selectedFiles[0] }
  }
);
assert.equal(subset.results[0].status, 'skipped', JSON.stringify(subset.results));

// Installing disjoint selections into the same repository preserves the first
// selection and unions both entries into the acquisition manifest.
const unionRoot = path.join(root, 'union-models');
const unionFiles = ['parts/base.safetensors', 'parts/adapter.safetensors'];
const selectionRecipe = (id, file) => ({
  schemaVersion: 1,
  id,
  name: id,
  backend: { id: 'test-backend' },
  models: [{ role: 'default', model: 'owner/union' }],
  setup: {
    steps: [
      {
        id: `download-${id}`,
        action: 'download-model',
        provider: 'huggingface',
        model: 'owner/union',
        revision,
        include: [file],
        integrity: { files: [{ path: file, sizeBytes: 8 }] }
      }
    ]
  }
});
const unionOptions = {
  dryRun: false,
  yes: true,
  modelRoot: unionRoot,
  env: { ...options.env, LLOOM_HF_BIN: recipeHf },
  statePath: path.join(root, 'union-first-state.json')
};
await fs.mkdir(path.join(unionRoot, '.hf-cli', 'bin'), { recursive: true });
await fs.copyFile(recipeHf, path.join(unionRoot, '.hf-cli', 'bin', 'hf'));
await fs.chmod(path.join(unionRoot, '.hf-cli', 'bin', 'hf'), 0o755);
const unionFirst = await applyRecipe(
  selectionRecipe('union-first', unionFiles[0]),
  { models: [], runtimes: {} },
  unionOptions
);
assert.equal(unionFirst.results[0].status, 'completed', JSON.stringify(unionFirst.results));
assert.equal(
  (
    await applyRecipe(
      selectionRecipe('union-second', unionFiles[1]),
      { models: [], runtimes: {} },
      {
        ...unionOptions,
        statePath: path.join(root, 'union-second-state.json')
      }
    )
  ).results[0].status,
  'completed'
);
const unionDestination = path.join(unionRoot, 'owner--union');
for (const file of unionFiles) assert.equal(await fs.readFile(path.join(unionDestination, file), 'utf8'), 'weights\n');
const unionManifest = JSON.parse(await fs.readFile(path.join(unionDestination, MODEL_ACQUISITION_MANIFEST), 'utf8'));
assert.deepEqual(unionManifest.include, unionFiles);
const unionSubset = await applyRecipe(
  selectionRecipe('union-subset', unionFiles[0]),
  { models: [], runtimes: {} },
  {
    ...unionOptions,
    statePath: path.join(root, 'union-subset-state.json'),
    env: { ...unionOptions.env, FAIL_FILE: unionFiles[0] }
  }
);
assert.equal(unionSubset.results[0].status, 'skipped', JSON.stringify(unionSubset.results));

// Re-entry and recovery safety. Existing checkpoints are moved aside only
// after every known downloader cache directory is writable. A failed update
// must restore the old checkpoint, while a concurrent publisher must retain
// both copies for manual reconciliation.
const recoveryRoot = path.join(root, 'recovery-models');
const recoveryHf = path.join(root, 'recovery-hf');
await fs.writeFile(
  recoveryHf,
  `#!/bin/sh
for last do :; done
case "${'${RECOVERY_MODE:-}'}" in
  fail)
    mkdir -p "$last"
    printf 'staged partial\\n' > "$last/partial.gguf"
    exit 9
    ;;
  verify)
    mkdir -p "$last"
    printf 'wrong download\\n' > "$last/wrong.gguf"
    exit 0
    ;;
  mutate)
    mkdir -p "$last"
    printf 'mutated payload\\n' > "$last/model.gguf"
    exit 9
    ;;
  concurrent)
    mkdir -p "$last" "$CONCURRENT_DEST"
    printf 'staged concurrent\\n' > "$last/staged.gguf"
    printf 'published concurrently\\n' > "$CONCURRENT_DEST/concurrent.gguf"
    exit 9
    ;;
esac
mkdir -p "$last"
printf 'unexpected downloader invocation\\n' > "$last/unexpected.gguf"
`,
  { mode: 0o755 }
);
await fs.chmod(recoveryHf, 0o755);

const recoveryRevision = 'fedcba9876543210fedcba9876543210fedcba98';
const recoveryStep = (id, model, files) => ({
  id,
  action: 'download-model',
  provider: 'huggingface',
  model,
  revision: recoveryRevision,
  integrity: { files }
});
const recoveryRecipe = (id, stepEntry, model) => ({
  schemaVersion: 1,
  id,
  name: id,
  backend: { id: 'test-backend' },
  models: [{ role: 'default', model }],
  setup: { steps: [stepEntry] }
});
const recoveryOptions = (id, extraEnv = {}) => ({
  dryRun: false,
  yes: true,
  modelRoot: recoveryRoot,
  statePath: path.join(root, `${id}-state.json`),
  env: {
    ...process.env,
    PATH: '/usr/bin:/bin',
    LLOOM_HF_BIN: recoveryHf,
    HF_HUB_CLI: '',
    ...extraEnv
  }
});
const oldPayload = 'old checkpoint\n';
const oldPayloadSize = Buffer.byteLength(oldPayload);

// A nested Hugging Face download cache that is not a directory is rejected
// before rename. Fixed names resembling the old probe are user data and must
// survive the failed preflight unchanged.
const preflightModel = 'owner/preflight-model';
const preflightDestination = path.join(recoveryRoot, 'owner--preflight-model');
await fs.mkdir(path.join(preflightDestination, '.cache', 'huggingface'), { recursive: true });
await fs.writeFile(path.join(preflightDestination, 'model.gguf'), oldPayload);
await fs.writeFile(path.join(preflightDestination, '.lloom-write-probe'), 'keep this file\n');
await fs.writeFile(path.join(preflightDestination, '.lloom-write-probe-tmp'), 'keep this temp\n');
await fs.writeFile(path.join(preflightDestination, '.cache', 'huggingface', 'download'), 'not a directory\n');
const preflightResult = await applyRecipe(
  recoveryRecipe(
    'recovery-preflight',
    recoveryStep('download', preflightModel, [{ path: 'model.gguf', sizeBytes: oldPayloadSize }]),
    preflightModel
  ),
  { models: [], runtimes: {} },
  recoveryOptions('recovery-preflight')
);
assert.equal(preflightResult.results[0].status, 'failed', JSON.stringify(preflightResult.results));
assert.equal(await fs.readFile(path.join(preflightDestination, 'model.gguf'), 'utf8'), oldPayload);
assert.equal(await fs.readFile(path.join(preflightDestination, '.lloom-write-probe'), 'utf8'), 'keep this file\n');
assert.equal(await fs.readFile(path.join(preflightDestination, '.lloom-write-probe-tmp'), 'utf8'), 'keep this temp\n');
assert.equal(
  await fs.stat(`${preflightDestination}.incomplete`).then(
    () => true,
    () => false
  ),
  false
);
assert.match(preflightResult.results[0].stderr, /cannot write .*download/);

// A downloader that exits non-zero after writing a partial payload restores an
// existing checkpoint. The new partial file is retained inside that restored
// directory for inspection/resume; the old model data never disappears.
const failedModel = 'owner/failed-model';
const failedDestination = path.join(recoveryRoot, 'owner--failed-model');
await fs.mkdir(failedDestination, { recursive: true });
await fs.writeFile(path.join(failedDestination, 'model.gguf'), oldPayload);
const failedResult = await applyRecipe(
  recoveryRecipe(
    'recovery-downloader-failure',
    recoveryStep('download', failedModel, [{ path: 'model.gguf', sizeBytes: oldPayloadSize }]),
    failedModel
  ),
  { models: [], runtimes: {} },
  recoveryOptions('recovery-downloader-failure', { RECOVERY_MODE: 'fail' })
);
assert.equal(failedResult.results[0].status, 'failed', JSON.stringify(failedResult.results));
assert.equal(await fs.readFile(path.join(failedDestination, 'model.gguf'), 'utf8'), oldPayload);
assert.equal(await fs.readFile(path.join(failedDestination, 'partial.gguf'), 'utf8'), 'staged partial\n');
assert.equal(
  await fs.stat(`${failedDestination}.incomplete`).then(
    () => true,
    () => false
  ),
  false
);

// Verification failures also restore the old directory and never publish a
// completion manifest for a payload that did not pass its declared digest.
const verifyModel = 'owner/verify-model';
const verifyDestination = path.join(recoveryRoot, 'owner--verify-model');
await fs.mkdir(verifyDestination, { recursive: true });
await fs.writeFile(path.join(verifyDestination, 'model.gguf'), oldPayload);
const verifyExpected = 'new verified checkpoint\n';
const verifyResult = await applyRecipe(
  recoveryRecipe(
    'recovery-verification-failure',
    recoveryStep('download', verifyModel, [
      {
        path: 'model.gguf',
        sizeBytes: Buffer.byteLength(verifyExpected),
        sha256: crypto.createHash('sha256').update(verifyExpected).digest('hex')
      }
    ]),
    verifyModel
  ),
  { models: [], runtimes: {} },
  recoveryOptions('recovery-verification-failure', { RECOVERY_MODE: 'verify' })
);
assert.equal(verifyResult.results[0].status, 'failed', JSON.stringify(verifyResult.results));
assert.equal(await fs.readFile(path.join(verifyDestination, 'model.gguf'), 'utf8'), oldPayload);
assert.equal(
  await fs.stat(path.join(verifyDestination, MODEL_ACQUISITION_MANIFEST)).then(
    () => true,
    () => false
  ),
  false
);
assert.equal(
  await fs.stat(`${verifyDestination}.incomplete`).then(
    () => true,
    () => false
  ),
  false
);
assert.match(verifyResult.results[0].stderr, /download verification failed/);

// A failed new-revision update may have modified the old payload in place.
// Recovery must leave those bytes staged back at the canonical path without
// reviving the old completion marker; the exact old marker bytes stay in the
// unique acquisition-owned backup for manual reconciliation.
const staleModel = 'owner/stale-model';
const staleDestination = path.join(recoveryRoot, 'owner--stale-model');
const oldRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const oldManifestRaw = `${JSON.stringify({
  version: 1,
  provider: 'huggingface',
  model: staleModel,
  revision: oldRevision
})}\n`;
await fs.mkdir(staleDestination, { recursive: true });
await fs.writeFile(path.join(staleDestination, 'model.gguf'), oldPayload);
await fs.writeFile(path.join(staleDestination, MODEL_ACQUISITION_MANIFEST), oldManifestRaw);
const staleResult = await applyRecipe(
  recoveryRecipe(
    'recovery-stale-provenance',
    recoveryStep('download', staleModel, [{ path: 'model.gguf', sizeBytes: oldPayloadSize }]),
    staleModel
  ),
  { models: [], runtimes: {} },
  recoveryOptions('recovery-stale-provenance', { RECOVERY_MODE: 'mutate' })
);
assert.equal(staleResult.results[0].status, 'failed', JSON.stringify(staleResult.results));
assert.equal(await fs.readFile(path.join(staleDestination, 'model.gguf'), 'utf8'), 'mutated payload\n');
assert.equal(
  await fs.stat(path.join(staleDestination, MODEL_ACQUISITION_MANIFEST)).then(
    () => true,
    () => false
  ),
  false
);
assert.equal((await modelAcquisitionStatus({ destination: staleDestination, revision: oldRevision })).complete, false);
const staleBackups = (await fs.readdir(recoveryRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('.lloom-acquisition-previous-owner--stale-model-'))
  .map((entry) => path.join(recoveryRoot, entry.name));
assert.equal(staleBackups.length, 1);
assert.equal(await fs.readFile(path.join(staleBackups[0], MODEL_ACQUISITION_MANIFEST), 'utf8'), oldManifestRaw);

// A destination published while the old checkpoint is staged wins admission,
// but the staged copy is preserved instead of being recursively deleted.
const concurrentModel = 'owner/concurrent-model';
const concurrentDestination = path.join(recoveryRoot, 'owner--concurrent-model');
await fs.mkdir(concurrentDestination, { recursive: true });
await fs.writeFile(path.join(concurrentDestination, 'model.gguf'), oldPayload);
const concurrentResult = await applyRecipe(
  recoveryRecipe(
    'recovery-concurrent-destination',
    recoveryStep('download', concurrentModel, [{ path: 'model.gguf', sizeBytes: oldPayloadSize }]),
    concurrentModel
  ),
  { models: [], runtimes: {} },
  recoveryOptions('recovery-concurrent-destination', {
    RECOVERY_MODE: 'concurrent',
    CONCURRENT_DEST: concurrentDestination
  })
);
assert.equal(concurrentResult.results[0].status, 'failed', JSON.stringify(concurrentResult.results));
assert.equal(
  await fs.readFile(path.join(concurrentDestination, 'concurrent.gguf'), 'utf8'),
  'published concurrently\n'
);
assert.equal(await fs.readFile(path.join(`${concurrentDestination}.incomplete`, 'model.gguf'), 'utf8'), oldPayload);
assert.equal(
  await fs.readFile(path.join(`${concurrentDestination}.incomplete`, 'staged.gguf'), 'utf8'),
  'staged concurrent\n'
);

assert.equal((await modelAcquisitionStatus({ destination, include: ['missing.gguf'] })).complete, false);
assert.ok(validateAcquisitionStep({ include: 'file' }).length);
assert.ok(validateAcquisitionStep({ include: [123] }).length);
const { matchIncludedFiles } = await import('../src/model-files.mjs');
const selections = await matchIncludedFiles(path.join(recipeRoot, 'owner--selected'), [
  '*.safetensors',
  'split_files/vae/[ab].safetensors'
]);
assert.deepEqual(
  selections.map((entry) => entry.matches.length),
  [2, 1]
);
await fs.rm(root, { recursive: true, force: true });
