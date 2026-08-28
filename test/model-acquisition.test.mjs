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
