import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackend, loadBackendCatalog } from '../src/backend-catalog.mjs';
import { loadRecipeById } from '../src/recipes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(root, 'backends', 'qwen38-vllm');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm');

assert.equal(recipe.backend.id, 'docker-vllm');
assert.equal(recipe.version, 3);
assert.equal(recipe.models[0].gatewayModel, 'qwen3.8-flash-next');
assert.equal(recipe.models[0].settings.contextWindow, 262144);
assert.equal(recipe.models[0].settings.maxActiveRequests, 2);
assert.equal(recipe.models[0].settings.maxQueuedRequests, 8);
assert.equal(recipe.models[0].settings.memoryGb, 108);
assert.equal(recipe.models[0].settings.keepWarm, false);
assert(recipe.capabilities.includes('mtp'));
assert(recipe.models[0].capabilities.includes('mtp'));
assert.equal(recipe.models[0].aliases[0].id, 'q38fn');
assert.deepEqual(recipe.models[0].aliases[0].members, ['qwen3.8-flash-next', 'cloud/openrouter/q38fn']);
assert.equal(recipe.models[0].aliases[1].id, 'q38fn-local');
assert.equal(recipe.models[0].aliases[1].advertise, false);

const dockerVllm = getBackend(await loadBackendCatalog(), 'docker-vllm');
assert(dockerVllm, 'docker-vllm backend must be packaged');
assert.deepEqual(dockerVllm.commands, ['docker']);

const members = recipe.models[0].settings.placement.members;
assert.deepEqual(
  members.map((member) => member.role),
  ['worker', 'head']
);
for (const member of members) {
  assert.equal(member.resources.memoryGb, 108);
  const bootstrap = member.runtimeSettings.bootstrap;
  assert.equal(
    bootstrap.image,
    'vllm/vllm-openai@sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e'
  );
  const rendered = bootstrap.createArgs.join(' ');
  for (const expected of [
    '--restart no',
    'QWEN_MODEL_REVISION=7b719225242aacd3dbd3f9407468c2ee9a9d2594',
    'MAX_MODEL_LEN=262144',
    'MAX_NUM_SEQS=8',
    'MAX_NUM_BATCHED_TOKENS=8192',
    'GPU_MEMORY_UTILIZATION=0.835',
    'KV_CACHE_DTYPE=auto',
    'MTP_NUM_SPECULATIVE_TOKENS=3',
    'NCCL_IB_HCA=rocep1s0f0',
    'NCCL_IB_ADDR_FAMILY=AF_INET',
    'NCCL_IB_ROCE_VERSION_NUM=2',
    'HF_HUB_OFFLINE=1',
    'TRANSFORMERS_OFFLINE=1',
    'backends/qwen38-vllm/entrypoint.sh',
    'backends/qwen38-vllm/apply-ple-fp8-patch.py'
  ]) {
    assert(rendered.includes(expected), `missing vLLM launch control: ${expected}`);
  }
  assert(!rendered.includes('YARN'));
  assert(!rendered.includes('NCCL_IB_GID_INDEX'));
  assert.deepEqual(bootstrap.command, ['/opt/lloom/entrypoint.sh']);
}
assert.equal(members.find((member) => member.role === 'head').runtimeSettings.healthTimeoutMs, 5000);

const entrypoint = await fs.readFile(path.join(backendRoot, 'entrypoint.sh'), 'utf8');
for (const expected of [
  '--revision "${QWEN_MODEL_REVISION}"',
  '--distributed-executor-backend mp',
  '--enable-expert-parallel --all2all-backend allgather_reducescatter',
  '--kv-cache-dtype "${KV_CACHE_DTYPE:-auto}"',
  '--enable-prefix-caching',
  'MTP_NUM_SPECULATIVE_TOKENS',
  '"cudagraph_mode":"FULL_DECODE_ONLY"',
  '--reasoning-parser qwen3',
  '--tool-call-parser qwen3_coder'
]) {
  assert(entrypoint.includes(expected), `missing vLLM entrypoint control: ${expected}`);
}
assert.match(entrypoint, /method\\":\\"mtp/);
const shellCheck = spawnSync('bash', ['-n', path.join(backendRoot, 'entrypoint.sh')], { encoding: 'utf8' });
assert.equal(shellCheck.status, 0, shellCheck.stderr);

const plePatchPath = path.join(backendRoot, 'apply-ple-fp8-patch.py');
const plePatch = await fs.readFile(plePatchPath, 'utf8');
assert.match(plePatch, /a71144c1d36e06f22a2da1b1ada900076597fe5e824a911e7ada86249a0993e7/);
assert.match(plePatch, /refusing unknown PLE source/);
assert.match(plePatch, /PLE_FORCE_FP8/);

const badRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-qwen38-vllm-'));
const badSource = path.join(badRoot, 'ple_layer.py');
await fs.writeFile(badSource, 'class UnknownPLE:\n    pass\n');
const badPatch = spawnSync('python3', [plePatchPath, badSource], { encoding: 'utf8' });
assert.notEqual(badPatch.status, 0, 'PLE patch must fail closed on unknown image source');
await fs.rm(badRoot, { recursive: true, force: true });

assert.deepEqual(recipe.models[0].settings.behaviorOverrides, {
  chatTemplateKwargs: { reasoning_effort: 'low' }
});
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm', 'v1.json'));
await fs.access(path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm', 'v2.json'));
await fs.access(
  path.join(root, 'recipes', 'archive', 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-sglang', 'v19.json')
);

console.log('qwen38 vllm recipe tests passed');
