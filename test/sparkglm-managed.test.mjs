import assert from 'node:assert/strict';
import { materialize } from '../backends/sparkglm/materialize.mjs';
import { planRecipe } from '../src/recipes.mjs';
const image = 'sha256:' + 'a'.repeat(64);
const recipe = await materialize({ image, sourceRevision: 'b'.repeat(40) });
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
assert.equal(recipe.models[0].gatewayModel, 'glm-5.3-flash-exl3');
assert.equal(recipe.models[0].settings.keepWarm, false);
const members = recipe.models[0].settings.placement.members;
assert.deepEqual(
  members.map((v) => v.role),
  ['worker', 'head']
);
for (const m of members) {
  assert.equal(m.runtimeSettings.management, 'managed');
  assert.equal(m.runtimeSettings.bootstrap.image, image);
  assert.equal(m.runtimeSettings.bootstrap.pull, false);
  const args = m.runtimeSettings.bootstrap.createArgs.join(' ');
  assert.match(args, /backends\/sparkglm\/entrypoint.sh/);
  assert.match(args, /EXL3_GROUPED_PREFILL_K4=1/);
  assert.match(args, /GLM53_MIXED_PREFILL_CHUNK=0/);
  assert.doesNotMatch(args, /backends\/glm53-exl3/);
}
await assert.rejects(materialize({ image: 'sparkglm:latest', sourceRevision: 'b'.repeat(40) }));
await assert.rejects(materialize({ image, sourceRevision: 'main' }));
console.log('SparkGLM managed runtime plan passed');

const tiny = await materialize({ image, sourceRevision: 'b'.repeat(40), tiny: true, e3: true });
assert.equal(tiny.models[0].gatewayModel, 'sparkglm-tiny');
assert.deepEqual(tiny.models[0].aliases, []);
assert.equal(tiny.setup.steps.length, 1);
const nv = await materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4: true });
assert.equal(nv.models[0].gatewayModel, 'sparkglm-nvfp4');
assert.deepEqual(nv.models[0].aliases, []);
assert.equal(
  nv.setup.steps.find((v) => v.id === 'download-target').revision,
  '240131d6a447c8d89acd428c5ddfc85598651744'
);
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), tiny: true, nvfp4: true }));
for (const candidate of [tiny, nv]) {
  const p = planRecipe(
    candidate,
    { models: [], runtimes: {} },
    {
      modelRoot: '/models',
      platform: 'linux',
      arch: 'arm64',
      backendIds: new Set(['docker-vllm']),
      checkLocalReferences: false
    }
  );
  assert.deepEqual(p.validationErrors, []);
}

const split = await materialize({ image, workerImage: 'sha256:' + 'c'.repeat(64), sourceRevision: 'b'.repeat(40) });
assert.equal(split.models[0].settings.placement.members[0].runtimeSettings.bootstrap.image, 'sha256:' + 'c'.repeat(64));
assert.equal(split.models[0].settings.placement.members[1].runtimeSettings.bootstrap.image, image);
await assert.rejects(materialize({ image, workerImage: 'latest', sourceRevision: 'b'.repeat(40) }));

const nt = await materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4Tiny: true });
assert.equal(nt.models[0].gatewayModel, 'sparkglm-tiny-nvfp4');
assert.deepEqual(nt.models[0].aliases, []);
assert.deepEqual(
  planRecipe(
    nt,
    { models: [], runtimes: {} },
    {
      modelRoot: '/models',
      platform: 'linux',
      arch: 'arm64',
      backendIds: new Set(['docker-vllm']),
      checkLocalReferences: false
    }
  ).validationErrors,
  []
);
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4Tiny: true, e3: true }));
