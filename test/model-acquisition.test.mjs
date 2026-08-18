import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

console.log('model acquisition tests passed');
