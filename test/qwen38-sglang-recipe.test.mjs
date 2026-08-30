import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
assert.equal(recipe.models[0].settings.maxActiveRequests, 12);
assert.equal(recipe.version, 12);
assert.equal(recipe.models[0].settings.memoryGb, 80);
assert.equal(recipe.models[0].settings.keepWarm, false);
assert.equal(recipe.capabilities.includes('mtp'), true);
assert.equal(recipe.models[0].capabilities.includes('mtp'), true);

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
  assert.equal(member.resources.memoryGb, 80);
  const bootstrap = member.runtimeSettings.bootstrap;
  assert.equal(
    bootstrap.image,
    'lmsysorg/sglang@sha256:14ed582518584c5c830206b5318a2c2769e68229c3422e48a28b952b3a888bd4'
  );
  const rendered = bootstrap.createArgs.join(' ');
  assert.match(rendered, /QWEN_MODEL_REVISION=7b719225242aacd3dbd3f9407468c2ee9a9d2594/);
  assert.match(rendered, /MAX_TOTAL_TOKENS=627648/);
  assert.match(rendered, /MAX_RUNNING_REQUESTS=12/);
  assert.match(rendered, /MAX_MAMBA_CACHE_SIZE=60/);
  assert.match(rendered, /SGLANG_API_HOST=0\.0\.0\.0/);
  assert.match(rendered, /SGLANG_API_PORT=8889/);
  assert.doesNotMatch(rendered, /SGLANG_PORT=/);
  assert.match(rendered, /MEM_FRACTION_STATIC=0\.80/);
  assert.match(rendered, /SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK=0/);
  assert.match(rendered, /SGLANG_SANITIZE_NAN_LOGITS=1/);
  assert.match(rendered, /ENABLE_SPECULATIVE=1/);
  assert.match(rendered, /ENABLE_THINKING_BUDGETS=0/);
  assert.match(rendered, /DEFAULT_CHAT_TEMPLATE_KWARGS=\{"reasoning_effort":"low"\}/);
  assert.match(rendered, /backends\/qwen38-sglang\/sm121_varlen\.py/);
  assert.match(rendered, /backends\/qwen38-sglang\/qsa_nvfp4_kv\.py/);
  assert.deepEqual(bootstrap.command, ['/opt/lloom/entrypoint.sh']);
}

const entrypoint = await fs.readFile(path.join(backendRoot, 'entrypoint.sh'), 'utf8');
for (const expected of [
  '--kv-cache-dtype nvfp4',
  '--context-length "${CONTEXT_LENGTH:-262144}"',
  '--host "${SGLANG_API_HOST:-0.0.0.0}"',
  '--port "${api_port}"',
  '--max-total-tokens "${MAX_TOTAL_TOKENS:-627648}"',
  '--max-mamba-cache-size "${MAX_MAMBA_CACHE_SIZE:-60}"',
  '--max-running-requests "${MAX_RUNNING_REQUESTS:-12}"',
  '--mamba-ssm-dtype float32',
  'if [[ "${ENABLE_SPECULATIVE:-0}" == "1" ]]',
  'if [[ "${ENABLE_THINKING_BUDGETS:-0}" == "1" ]]',
  '--enable-linear-replayssm-spec',
  '--enable-custom-logit-processor',
  'default_chat_template_kwargs="${DEFAULT_CHAT_TEMPLATE_KWARGS:-}"',
  'default_chat_template_kwargs=\'{"reasoning_effort":"low"}\'',
  '--default-chat-template-kwargs "${default_chat_template_kwargs}"',
  '--cuda-graph-bs-decode 1 2 3 4 5 6 7 8 10 12'
]) {
  assert(entrypoint.includes(expected), `missing SGLang launch control: ${expected}`);
}
assert(entrypoint.includes('unset SGLANG_PORT'), 'legacy SGLANG_PORT must not leak into SGLang');
const templateAssignment = entrypoint.match(
  /default_chat_template_kwargs="\$\{DEFAULT_CHAT_TEMPLATE_KWARGS:-\}"[\s\S]*?\nfi/
)?.[0];
assert(templateAssignment, 'chat-template default assignment must stay executable in isolation');
for (const [configured, expected] of [
  ['', '{"reasoning_effort":"low"}'],
  ['{"reasoning_effort":"medium"}', '{"reasoning_effort":"medium"}']
]) {
  const rendered = spawnSync('bash', ['-c', `${templateAssignment}\nprintf '%s' "$default_chat_template_kwargs"`], {
    encoding: 'utf8',
    env: { ...process.env, DEFAULT_CHAT_TEMPLATE_KWARGS: configured }
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, expected);
}

const sm121Patch = await fs.readFile(path.join(backendRoot, 'apply-sm121-patches.py'), 'utf8');
assert.match(sm121Patch, /THINKING_START_TOKEN_ID: int = 248068/);
assert.match(sm121Patch, /THINKING_END_TOKEN_ID: int = 248069/);
assert.match(sm121Patch, /SM121 must not use TRT-LLM sparse decode/);
assert.match(sm121Patch, /qsa\.sm121_varlen/);
assert.match(sm121Patch, /refusing an unsafe patch/);

const sm121Kernel = await fs.readFile(path.join(backendRoot, 'sm121_varlen.py'), 'utf8');
assert.match(sm121Kernel, /valid = \(kv_end > kv_start\) & \(running_sum > 0\.0\)/);
assert.match(sm121Kernel, /output = tl\.where\(finite & valid, output, 0\.0\)/);

const nvfp4Patch = await fs.readFile(path.join(backendRoot, 'apply_nvfp4_patches.py'), 'utf8');
for (const expected of [
  'TOKEN0_RUN = 16',
  'def patch_token0_guard()',
  'self._check_token0_loop_finish()',
  'is_insert = False',
  'dspark_consume_token0_flush',
  'self.tree_cache.reset()'
]) {
  assert(nvfp4Patch.includes(expected), `missing token-id-0 guard: ${expected}`);
}

assert.deepEqual(recipe.models[0].settings.behaviorOverrides, {
  chatTemplateKwargs: { reasoning_effort: 'low' }
});

const sourceHashes = {
  'sm121_varlen.py': '562610cf63f90ae666106c9f364812978ef039ac02ec9e7efc31e52a9de78e2b',
  'qsa_nvfp4_kv.py': '3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580',
  'apply_nvfp4_patches.py': '14f8aa89871bd212032d0e03ae9d68738b73ae1822ac762225eedc9e1c8d2bfd'
};
for (const [name, expected] of Object.entries(sourceHashes)) {
  const bytes = await fs.readFile(path.join(backendRoot, name));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, `${name} drifted`);
}

await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm', 'v1.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v3.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v4.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v5.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v6.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v7.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v8.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v9.json'));
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v10.json')
);
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v11.json')
);

console.log('qwen38 sglang recipe tests passed');
