import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipeById, planRecipe } from '../src/recipes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(root, 'backends', 'glm53-exl3');
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-2x-glm53-flash-exl3-vllm');

assert.equal(recipe.version, 10);
assert.equal(recipe.models[0].gatewayModel, 'glm-5.3-flash-exl3');
assert.equal(recipe.models[0].settings.contextWindow, 1000000);
assert.equal(recipe.models[0].settings.memoryGb, 100);
assert.equal(recipe.models[0].settings.maxActiveRequests, 4);
assert.equal(recipe.models[0].settings.keepWarm, true);
assert.equal(recipe.models[0].aliases[0].id, 'glm53f');
assert.equal(recipe.models[0].aliases[1].id, 'glm53f-local');
assert.equal(recipe.models[0].aliases[2], 'glm53-flash');

const plan = planRecipe(
  recipe,
  { models: [], runtimes: {} },
  {
    modelRoot: '/models',
    platform: 'linux',
    arch: 'arm64',
    backendIds: new Set(['docker-vllm']),
    checkLocalReferences: false
  }
);
assert.deepEqual(plan.validationErrors, []);
assert.equal(plan.platformSupported, true);
assert.deepEqual(
  plan.steps
    .filter((step) => step.action === 'download-model')
    .map((step) => [step.model, step.revision, step.destination]),
  [
    [
      'Mia-AiLab/GLM-5.3-Flash-EXL3-TR3-4bpw',
      '25a44fdbf16862a46b7cc9921142c6c81350af2f',
      '/models/Mia-AiLab--GLM-5.3-Flash-EXL3-TR3-4bpw'
    ],
    [
      'incoai/GLM-5.3-Flash-DFlash2',
      '7d74cdd881ed7e32c31175984a67823127b66cfe',
      '/models/incoai--GLM-5.3-Flash-DFlash2'
    ]
  ]
);

const members = recipe.models[0].settings.placement.members;
assert.deepEqual(
  members.map((member) => member.role),
  ['worker', 'head']
);
for (const member of members) {
  const bootstrap = member.runtimeSettings.bootstrap;
  assert.equal(bootstrap.image, 'lloom-glm53-mia-eb0469:exl3');
  assert.equal(bootstrap.pull, false);
  const rendered = bootstrap.createArgs.join(' ');
  assert.match(rendered, /MODEL_DIR=\/models\/Mia-AiLab--GLM-5\.3-Flash-EXL3-TR3-4bpw/);
  assert.match(rendered, /DFLASH_MODEL_DIR=\/models\/incoai--GLM-5\.3-Flash-DFlash2/);
  assert.match(rendered, /SPEC_METHOD=dflash/);
  assert.match(rendered, /DFLASH_TOKENS=7/);
  assert.match(rendered, /DFLASH_DRAFT_TP=2/);
  assert.match(rendered, /MAX_MODEL_LEN=1000000/);
  assert.match(rendered, /GPU_MEMORY_UTILIZATION=0\.87/);
  assert.doesNotMatch(rendered, /KV_CACHE_MEMORY_BYTES=/);
  assert.match(rendered, /MAX_NUM_BATCHED_TOKENS=7168/);
  assert.match(rendered, /GLM53_MIXED_PREFILL_CHUNK=skip/);
  assert.match(rendered, /GLM53_INDEXER_WORKSPACE=rightsize/);
  assert.match(rendered, /GLM53_SPINWAIT_MS=stock/);
  assert.match(rendered, /EXL3_FAT_KERNEL=1/);
  assert.match(rendered, /ABLIT=0/);
  assert.match(rendered, /NCCL_IB_ADDR_FAMILY=AF_INET/);
  assert.match(rendered, /NCCL_CROSS_NIC=1/);
  assert.match(rendered, /NCCL_IB_MERGE_NICS=1/);
  assert.doesNotMatch(rendered, /NCCL_IB_GID_INDEX=/);
  assert.doesNotMatch(rendered, /patch_glm5_drafter_group\.py.*readonly/);
  assert.deepEqual(bootstrap.command, ['/opt/lloom/entrypoint.sh']);
}

const entrypoint = await fs.readFile(path.join(backendRoot, 'entrypoint.sh'), 'utf8');
for (const expected of [
  '--tool-call-parser glm47',
  '--reasoning-parser glm45',
  '--quantization exl3',
  '--kv-cache-memory-bytes',
  '--cudagraph-capture-sizes 1 2 4 8 16 24 32',
  'printf -v spec \'{"method":"dflash"',
  'Do not launch Python here',
  'patch_glm5_drafter_group.py',
  'patch_hybrid_prefix_hit.py',
  'patch_xgrammar_termination.py',
  'patch_kpool_tail_slotmap.py',
  'patch_spinwait.py',
  'patch_indexer_workspace.py',
  'patch_ablit.py',
  '/opt/glm53/chat_template.jinja',
  'DFLASH_DRAFT_TP:-2',
  'MAX_NUM_BATCHED_TOKENS:-7168',
  '--headless'
]) {
  assert(entrypoint.includes(expected), `missing GLM launch control: ${expected}`);
}

const sourceHashes = {
  'chat_template.jinja': '96ed83160b243de213e95eb2fa19bde4ac13b676661cfec477d18e45e9fcca3a',
  'patch_glm_video_placeholders.py': '60c1ae1df640cf9d332299d6bbc4378a1e7ca929cad146f47d6dc68c4a4f67ee',
  'patch_suppress_stops_in_reasoning.py': '14602ea4350bad1eb8a6e76de3e17e2d5ef1229340bcd199351e20334f5e15d7',
  'patch_scheduler_decode_floor.py': '0e117f2c8210d674e79d98a34a26e8b5dc6f956bfb566e3cd3a830b37f6e76de',
  'patch_glm5_drafter_group.py': '1835bfbd64fbb5f063a1c9d5ea2d70cc3558312f45d4470a58d00c2e24b3806e',
  'patch_hybrid_prefix_hit.py': 'bce9e20e67dc71d968cd8519a9eadd4f889d35e3ec7584ba8e9f8430ccdcee52',
  'patch_xgrammar_termination.py': 'e6e5928eaf74dbb6bf0e9511105987c9f74848278c2cba7c28c506ca58ee90f5'
};
for (const [name, expected] of Object.entries(sourceHashes)) {
  const bytes = await fs.readFile(path.join(backendRoot, name));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, `${name} drifted from Mia 79f10b91`);
}

const builder = await fs.readFile(path.join(backendRoot, 'build-mia-image.sh'), 'utf8');
assert.match(builder, /eb0469fbb2b49fd7c025f594a3339a121e58f7a9/);
assert.match(builder, /lloom-glm53-mia-eb0469:exl3/);
assert.match(builder, /docker build/);

console.log('glm53 exl3 recipe tests passed');
