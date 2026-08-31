import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
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
assert.equal(recipe.models[0].settings.maxActiveRequests, 2);
assert.equal(recipe.models[0].settings.maxQueuedRequests, 8);
assert.equal(recipe.models[0].settings.queueTimeoutMs, 240000);
assert.equal(recipe.models[0].settings.queueRetryAfterSeconds, 3);
assert.equal(recipe.models[0].settings.requestStartupWaitMs, 1000);
assert.equal(recipe.models[0].settings.startupRetryAfterSeconds, 15);
assert.equal(recipe.models[0].settings.healthTimeoutMs, 5000);
assert.equal(recipe.version, 19);
assert.equal(recipe.models[0].aliases[0].id, 'q38fn');
assert.deepEqual(recipe.models[0].aliases[0].members, ['qwen3.8-flash-next', 'cloud/openrouter/q38fn']);
assert(!recipe.models[0].aliases.some((alias) => alias === 'qwen38f-next' || alias.id === 'qwen38f-next'));
assert.equal(recipe.models[0].settings.memoryGb, 80);
assert.equal(recipe.models[0].settings.keepWarm, false);
assert.equal(recipe.capabilities.includes('mtp'), false);
assert.equal(recipe.models[0].capabilities.includes('mtp'), false);

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
  assert.match(rendered, /MAX_RUNNING_REQUESTS=2/);
  assert.match(rendered, /MAX_MAMBA_CACHE_SIZE=16/);
  assert.match(rendered, /SGLANG_API_HOST=0\.0\.0\.0/);
  assert.match(rendered, /SGLANG_API_PORT=8889/);
  assert.doesNotMatch(rendered, /SGLANG_PORT=/);
  assert.match(rendered, /MEM_FRACTION_STATIC=0\.80/);
  assert.match(rendered, /SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK=0/);
  assert.match(rendered, /SGLANG_SANITIZE_NAN_LOGITS=1/);
  assert.match(rendered, /NCCL_IB_HCA=rocep1s0f0/);
  assert.match(rendered, /NCCL_IB_ADDR_FAMILY=AF_INET/);
  assert.doesNotMatch(rendered, /NCCL_IB_GID_INDEX=/);
  assert.match(rendered, /ENABLE_SPECULATIVE=0/);
  assert.match(rendered, /ENABLE_THINKING_BUDGETS=0/);
  assert.match(rendered, /DEFAULT_CHAT_TEMPLATE_KWARGS=\{"reasoning_effort":"low"\}/);
  assert.match(rendered, /backends\/qwen38-sglang\/sm121_varlen\.py/);
  assert.match(rendered, /backends\/qwen38-sglang\/qsa_nvfp4_kv\.py/);
  assert.match(rendered, /backends\/qwen38-sglang\/apply_disconnect_lifecycle_fix\.py/);
  assert.deepEqual(bootstrap.command, ['/opt/lloom/entrypoint.sh']);
}
assert.equal(members.find((member) => member.role === 'head').runtimeSettings.healthTimeoutMs, 5000);

const entrypoint = await fs.readFile(path.join(backendRoot, 'entrypoint.sh'), 'utf8');
for (const expected of [
  '--kv-cache-dtype nvfp4',
  '--context-length "${CONTEXT_LENGTH:-262144}"',
  '--host "${SGLANG_API_HOST:-0.0.0.0}"',
  '--port "${api_port}"',
  '--max-total-tokens "${MAX_TOTAL_TOKENS:-627648}"',
  '--max-mamba-cache-size "${MAX_MAMBA_CACHE_SIZE:-16}"',
  '--max-running-requests "${MAX_RUNNING_REQUESTS:-2}"',
  '--mamba-ssm-dtype float32',
  'if [[ "${ENABLE_SPECULATIVE:-0}" == "1" ]]',
  'if [[ "${ENABLE_THINKING_BUDGETS:-0}" == "1" ]]',
  '--enable-linear-replayssm-spec',
  '--enable-custom-logit-processor',
  'default_chat_template_kwargs="${DEFAULT_CHAT_TEMPLATE_KWARGS:-}"',
  'default_chat_template_kwargs=\'{"reasoning_effort":"low"}\'',
  '--default-chat-template-kwargs "${default_chat_template_kwargs}"',
  '--cuda-graph-bs-decode 1 2'
]) {
  assert(entrypoint.includes(expected), `missing SGLang launch control: ${expected}`);
}
assert(entrypoint.includes('unset SGLANG_PORT'), 'legacy SGLANG_PORT must not leak into SGLang');
assert.match(entrypoint, /apply_disconnect_lifecycle_fix\.py/);
assert.match(entrypoint, /sglang\/srt\/managers\/tokenizer_manager\.py/);
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
  'and self.chunked_req is None',
  'and (last_batch is None or last_batch.is_empty())',
  'and (not self.enable_overlap or len(self.result_queue) == 0)',
  'self.tree_cache.reset()',
  'self.req_to_token_pool.clear()',
  'self.token_to_kv_pool_allocator.clear()',
  'self.draft_worker.clear_cache_pool()'
]) {
  assert(nvfp4Patch.includes(expected), `missing token-id-0 guard: ${expected}`);
}

const disconnectPatchPath = path.join(backendRoot, 'apply_disconnect_lifecycle_fix.py');
const disconnectPatch = await fs.readFile(disconnectPatchPath, 'utf8');
for (const expected of [
  'except (asyncio.CancelledError, GeneratorExit):',
  'obj._dispatched_rids = dispatched_rids.copy()',
  'self.abort_request(rid, force=True)',
  'if dispatched_rids is None or rid not in dispatched_rids:',
  'expected exactly one match'
]) {
  assert(disconnectPatch.includes(expected), `missing disconnect lifecycle guard: ${expected}`);
}

const badFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-sglang-disconnect-'));
const badFixture = path.join(badFixtureRoot, 'tokenizer_manager.py');
await fs.writeFile(badFixture, 'class TokenizerManager:\n    pass\n');
const refusedPatch = spawnSync('python3', [disconnectPatchPath, badFixture], { encoding: 'utf8' });
assert.notEqual(refusedPatch.status, 0, 'disconnect patch must fail closed on unknown SGLang source');
assert.match(refusedPatch.stderr, /expected exactly one match/);
await fs.rm(badFixtureRoot, { recursive: true, force: true });

assert.deepEqual(recipe.models[0].settings.behaviorOverrides, {
  chatTemplateKwargs: { reasoning_effort: 'low' }
});

const sourceHashes = {
  'sm121_varlen.py': '562610cf63f90ae666106c9f364812978ef039ac02ec9e7efc31e52a9de78e2b',
  'qsa_nvfp4_kv.py': '3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580',
  'apply_nvfp4_patches.py': 'd4e04ca0a6eb9c87899f30be9ed361e63155664182ff2e77aed7ad6ea20d2a3e',
  'apply_disconnect_lifecycle_fix.py': '83b4c439589dac47cda64633cf48638cdf4462d1777f08fc025ba4c5acee6c60'
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
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v14.json')
);
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v15.json')
);
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v16.json')
);
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v17.json')
);

console.log('qwen38 sglang recipe tests passed');
