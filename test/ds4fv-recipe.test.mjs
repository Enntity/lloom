import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipeById } from '../src/recipes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipeId = 'linux-nvidia-dgx-spark-2x-deepseek-v4-flash-vision-mia-vllm';
const packRoot = path.join(root, 'backends', 'dspark-vllm', 'packs', 'miaai-ds4fv-9414dd58-sp');
const recipe = await loadRecipeById(recipeId);

assert.equal(recipe.version, 4);
assert.equal(recipe.models[0].model, 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp');
assert.equal(recipe.models[0].gatewayModel, 'deepseek-v4-flash-vision-exp');
assert.equal(recipe.models[0].runtime, 'deepseek-v4-flash-vision-exp-cluster');
assert.deepEqual(recipe.models[0].input, ['text', 'image']);
assert(recipe.models[0].capabilities.includes('vision'));
assert.equal(recipe.models[0].settings.keepWarm, true);
assert.equal(recipe.models[0].settings.healthPath, '/v1/models');
assert.equal(recipe.models[0].settings.healthModel, 'deepseek-v4-flash-vision-exp');
assert.equal(recipe.models[0].settings.contextWindow, 262144);
assert.equal(recipe.models[0].settings.maxOutputTokens, 65536);
assert.equal(recipe.models[0].settings.maxActiveRequests, 2);
assert.equal(recipe.models[0].settings.maxQueuedRequests, 8);
assert.equal(recipe.models[0].settings.queueTimeoutMs, 0);
assert.equal(recipe.models[0].settings.queueRetryAfterSeconds, 5);
assert.deepEqual(recipe.models[0].aliases[1].members, ['deepseek-v4-flash-vision-exp', 'cloud/openrouter/ds4fv']);

const members = recipe.models[0].settings.placement.members;
assert.deepEqual(
  members.map((member) => member.role),
  ['worker', 'head']
);
for (const member of members) {
  assert.equal(member.runtimeSettings.management, 'managed');
  assert.equal(member.runtimeSettings.containerName, 'lloom-ds4fv-${nodeId}');
  assert.equal(
    member.runtimeSettings.bootstrap.image,
    'ghcr.io/anemll/dspark-vllm-gx10:0.1.1@sha256:a83948492cf13df455170fb42885f5ef4db54fefe0feff0f841ecbff464ac9d8'
  );
  assert.equal(member.runtimeSettings.bootstrap.pull, false);
  const rendered = member.runtimeSettings.bootstrap.createArgs.join(' ');
  for (const expected of [
    'DSPARK_MODEL=deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    'DSPARK_MODEL_REVISION=86f746b36186f0e567729a5c06a8c918caba82a9',
    'SERVED_MODEL_NAME=deepseek-v4-flash-vision-exp',
    'LIMIT_MM_PER_PROMPT=image=8',
    'MAX_MODEL_LEN=262144',
    'MAX_NUM_SEQS=4',
    'MAX_NUM_BATCHED_TOKENS=16384',
    'MTP_NUM_TOKENS=5',
    'DSPARK_ENABLE_ROPE_SWA_FIX=1',
    'DSPARK_ENABLE_DSPARK_SWA_PREFIX=1',
    'DSPARK_ENABLE_SP_INDEXER=1',
    'DSPARK_MAX_INFLIGHT_PREFILLS=1',
    'DSPARK_ENABLE_DEEPGEMM_SM121_ALIAS=1',
    'DRAFT_SAMPLE_METHOD=probabilistic',
    'DSPARK_ISSUE191_TOOLCALL_MODE=failclosed',
    'miaai-ds4fv-9414dd58',
    'dst=/opt/dspark-patches,readonly'
  ]) {
    assert(rendered.includes(expected), `missing Vision launch control: ${expected}`);
  }
}
const head = members.find((member) => member.role === 'head');
const spTests = spawnSync('python3', [path.join(root, 'test/ds4fv-sp-pack.py')], { encoding: 'utf8' });
assert.equal(spTests.status, 0, spTests.stderr);
assert.equal(head.runtimeSettings.healthUrl, 'http://${leaderAddress}:8888/v1/models');
assert.equal(head.runtimeSettings.healthModel, 'deepseek-v4-flash-vision-exp');

const manifest = JSON.parse(await fs.readFile(path.join(packRoot, 'manifest.json'), 'utf8'));
assert.equal(manifest.upstream.commit, '9414dd58b0b34548032dfd30f5aa13c37f6b93b8');
assert.equal(manifest.compatibility.model, recipe.models[0].model);
assert.equal(manifest.compatibility.modelRevision, '86f746b36186f0e567729a5c06a8c918caba82a9');
assert.deepEqual(
  manifest.patches.filter((entry) => entry.enabled).map((entry) => entry.file),
  ['apply-runtime.sh']
);
for (const entry of manifest.patches) {
  const bytes = await fs.readFile(path.join(packRoot, entry.file));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.file} checksum`);
}

const packCheck = spawnSync(
  'python3',
  [
    path.join(root, 'backends', 'dspark-vllm', 'apply-patch-pack.py'),
    '--manifest',
    path.join(packRoot, 'manifest.json'),
    '--runtime-image',
    manifest.compatibility.runtimeImage,
    '--model',
    manifest.compatibility.model,
    '--model-revision',
    manifest.compatibility.modelRevision,
    '--check-only'
  ],
  { encoding: 'utf8' }
);
assert.equal(packCheck.status, 0, packCheck.stderr);

// Retain upstream transform/idempotency/drift checks against image fixtures.
// Upstream Compose wiring is replaced by the managed recipe checks above.
for (const script of ['test-rope-swa-fix.py', 'test-dspark-swa-prefix.py']) {
  const source = await fs.readFile(path.join(packRoot, 'scripts', script), 'utf8');
  const classes = [...source.matchAll(/^class (\w+)\(unittest.TestCase\):/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'Wiring');
  const result = spawnSync('python3', [path.join(packRoot, 'scripts', script), ...classes], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${script}: ${result.stderr}`);
}

for (const script of [
  'apply-runtime.sh',
  ...manifest.patches.filter((entry) => entry.file.endsWith('.sh')).map((entry) => entry.file)
]) {
  const syntax = spawnSync('bash', ['-n', path.join(packRoot, script)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${script}: ${syntax.stderr}`);
}

const index = JSON.parse(await fs.readFile(path.join(root, 'recipes', 'index.json'), 'utf8'));
const indexEntry = index.recipes.find((entry) => entry.id === recipeId);
assert.equal(indexEntry.currentVersion, 4);
assert.deepEqual(
  indexEntry.versions.map(({ version, status }) => ({ version, status })),
  [
    { version: 1, status: 'archived' },
    { version: 2, status: 'archived' },
    { version: 3, status: 'archived' },
    { version: 4, status: 'current' },
    { version: 5, status: 'archived' }
  ]
);
assert(indexEntry.capabilities.includes('vision'));

console.log('DS4FV recipe tests passed');
