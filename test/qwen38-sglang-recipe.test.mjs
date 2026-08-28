import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackend, loadBackendCatalog } from '../src/backend-catalog.mjs';
import { loadRecipeById } from '../src/recipes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(root, 'backends', 'qwen38-sglang');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang');

assert.equal(recipe.backend.id, 'docker-sglang');
assert.equal(recipe.models[0].gatewayModel, 'qwen3.8-flash-next');
assert.equal(recipe.models[0].settings.contextWindow, 262144);
assert.equal(recipe.models[0].settings.maxActiveRequests, 6);
assert.equal(recipe.models[0].settings.memoryGb, 96);

const dockerSglang = getBackend(await loadBackendCatalog(), 'docker-sglang');
assert(dockerSglang, 'docker-sglang backend must be packaged');
assert.deepEqual(dockerSglang.commands, ['docker']);
assert.deepEqual(
  dockerSglang.setup.map((step) => step.id),
  ['check-docker']
);

const members = recipe.models[0].settings.placement.members;
assert.deepEqual(
  members.map((member) => member.role),
  ['worker', 'head']
);
for (const member of members) {
  const bootstrap = member.runtimeSettings.bootstrap;
  assert.equal(
    bootstrap.image,
    'lmsysorg/sglang@sha256:14ed582518584c5c830206b5318a2c2769e68229c3422e48a28b952b3a888bd4'
  );
  const rendered = bootstrap.createArgs.join(' ');
  assert.match(rendered, /QWEN_MODEL_REVISION=7b719225242aacd3dbd3f9407468c2ee9a9d2594/);
  assert.match(rendered, /MAX_TOTAL_TOKENS=627648/);
  assert.match(rendered, /SGLANG_API_HOST=0\.0\.0\.0/);
  assert.match(rendered, /MEM_FRACTION_STATIC=0\.76/);
  assert.match(rendered, /SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK=0/);
  assert.match(rendered, /backends\/qwen38-sglang\/qsa_nvfp4_kv\.py/);
  assert.deepEqual(bootstrap.command, ['/opt/lloom/entrypoint.sh']);
}

const entrypoint = await fs.readFile(path.join(backendRoot, 'entrypoint.sh'), 'utf8');
for (const expected of [
  '--kv-cache-dtype nvfp4',
  '--context-length "${CONTEXT_LENGTH:-262144}"',
  '--host "${SGLANG_API_HOST:-0.0.0.0}"',
  '--max-total-tokens "${MAX_TOTAL_TOKENS:-627648}"',
  '--enable-linear-replayssm-spec',
  '--cuda-graph-bs-decode 1 2 3 4 5 6'
]) {
  assert(entrypoint.includes(expected), `missing SGLang launch control: ${expected}`);
}

const sourceHashes = {
  'qsa_fa_fallback.py': '4546423216fbf51f1763753c0865c0fb9eff670db566e83987268918a86b993a',
  'qsa_nvfp4_kv.py': '3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580',
  'apply_nvfp4_patches.py': '128ff089a4e10452a0d9d77b086060e58853e877849d2c2a2d61808506c47548'
};
for (const [name, expected] of Object.entries(sourceHashes)) {
  const bytes = await fs.readFile(path.join(backendRoot, name));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, `${name} drifted`);
}

await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm', 'v1.json'));

console.log('qwen38 sglang recipe tests passed');
