import assert from 'node:assert/strict';
import { materialize } from '../backends/sparkglm/materialize.mjs';
import { planRecipe } from '../src/recipes.mjs';
import { classifyRuntimeWatchdogOutcome } from '../src/runtime-manager.mjs';
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
  const createArgs = m.runtimeSettings.bootstrap.createArgs;
  assert.equal(createArgs[createArgs.indexOf('--restart') + 1], 'no');
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
  for (const member of candidate.models[0].settings.placement.members) {
    if (member.runtimeSettings.warmup?.body) {
      assert.equal(member.runtimeSettings.warmup.body.model, candidate.models[0].upstreamModel);
    }
  }
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

const matched = await materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4Budget: true });
assert.equal(matched.models[0].gatewayModel, recipe.models[0].gatewayModel);
assert.equal(matched.models[0].settings.contextWindow, nv.models[0].settings.contextWindow);
for (let rank = 0; rank < 2; rank += 1) {
  const exl = matched.models[0].settings.placement.members[rank];
  const fp4 = nv.models[0].settings.placement.members[rank];
  const budget = (member) =>
    member.runtimeSettings.bootstrap.createArgs.filter((v) =>
      /^(MAX_MODEL_LEN|KV_CACHE_MEMORY_BYTES|GPU_MEMORY_UTILIZATION|MAX_NUM_BATCHED_TOKENS|MAX_NUM_SEQS)=/.test(v)
    );
  assert.deepEqual(budget(exl), budget(fp4));
  assert.equal(exl.resources.memoryGb, fp4.resources.memoryGb);
}
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), tiny: true, nvfp4Budget: true }));

const tuned = await materialize({
  image,
  sourceRevision: 'b'.repeat(40),
  nvfp4: true,
  mxfp8Draft: true,
  draftTp: 2,
  prefillTokens: 1024,
  moeBackend: 'humming'
});
assert.deepEqual(
  planRecipe(
    tuned,
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
const draft = tuned.setup.steps.find((step) => step.id === 'download-dflash2');
assert.equal(draft.revision, '610aa967a92bfeb97e3d848dcb8693553e8b6a55');
for (const member of tuned.models[0].settings.placement.members) {
  const args = member.runtimeSettings.bootstrap.createArgs;
  assert(args.includes('DFLASH_MODEL_DIR=/models/' + draft.model.replace('/', '--')));
  assert(args.includes('DFLASH_DRAFT_TP=2'));
  assert(args.includes('MAX_NUM_BATCHED_TOKENS=1024'));
}
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), draftTp: 3 }));
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), prefillTokens: NaN }));
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), tiny: true, mxfp8Draft: true }));
const concurrent = await materialize({
  image,
  sourceRevision: 'b'.repeat(40),
  e3: true,
  tiny: true,
  e3Policy: 'concurrent',
  e3Trace: true
});
for (const member of concurrent.models[0].settings.placement.members) {
  assert(member.runtimeSettings.bootstrap.createArgs.includes('SPARKGLM_EXL3_E3_POLICY=concurrent'));
}
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), e3Policy: 'concurrent' }));

const bounded = await materialize({
  image,
  sourceRevision: 'b'.repeat(40),
  nvfp4: true,
  contextTokens: 49152,
  kvCacheGiB: 6
});
assert.equal(bounded.models[0].settings.contextWindow, 49152);
assert.equal(bounded.models[0].settings.maxPromptTokens, 0);
assert.equal(bounded.models[0].settings.memoryGb, nv.models[0].settings.memoryGb);
const largerCache = await materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4: true, kvCacheGiB: 16 });
assert.equal(largerCache.models[0].settings.memoryGb, nv.models[0].settings.memoryGb + 8);
assert.ok(largerCache.models[0].settings.placement.members.every((m) => m.resources.memoryGb === 120));
for (const member of bounded.models[0].settings.placement.members) {
  const args = member.runtimeSettings.bootstrap.createArgs;
  assert.equal(args.filter((v) => String(v).startsWith('KV_CACHE_MEMORY_BYTES=')).length, 1);
  assert.ok(args.includes('KV_CACHE_MEMORY_BYTES=6442450944'));
  assert.ok(args.includes('MAX_MODEL_LEN=49152'));
}
for (const opts of [{ contextTokens: 0 }, { contextTokens: 1048577 }, { kvCacheGiB: 0 }, { kvCacheGiB: 2.5 }])
  await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), ...opts }));
await materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4Tiny: true, moeBackend: 'humming' });

const lowerCap = await materialize({ image, sourceRevision: 'b'.repeat(40), e3: true, exl3TempRows: 32 });
assert.ok(
  lowerCap.models[0].settings.placement.members.every((m) =>
    m.runtimeSettings.bootstrap.createArgs.includes('EXL3_TEMP_ROWS_FUSED=32')
  )
);
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), exl3TempRows: 0 }));
await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4: true, exl3TempRows: 32 }));

await assert.rejects(materialize({ image, sourceRevision: 'b'.repeat(40), draftTp: 1 }), /not implemented/);

// A different GLM or synthetic fixture on the same appliance port is not healthy
// for this profile. Cover every model identity after its final rewrite.
for (const candidate of [
  recipe,
  tiny,
  nv,
  await materialize({ image, sourceRevision: 'b'.repeat(40), nvfp4Tiny: true })
]) {
  const model = candidate.models[0];
  assert.equal(model.settings.healthPath, '/v1/models');
  assert.equal(model.settings.healthModel, model.upstreamModel);
  const head = model.settings.placement.members.find((member) => member.role === 'head');
  assert.equal(head.runtimeSettings.healthUrl, 'http://${leaderAddress}:8890/v1/models');
  assert.equal(head.runtimeSettings.healthModel, model.upstreamModel);
  assert.equal(model.settings.placement.members.find((member) => member.role === 'worker').healthStrategy, 'container');
}

const fullWindow = await materialize({
  image,
  sourceRevision: 'b'.repeat(40),
  nvfp4: true,
  contextTokens: 1048576,
  kvCacheGiB: 11
});
assert.equal(fullWindow.models[0].settings.watchdog.minNoProgressMs, 1800000);
assert.equal(fullWindow.models[0].settings.watchdog.enabled, true);

const fullWindowRuntime = { ...fullWindow.models[0].settings, management: 'managed' };
assert.equal(
  classifyRuntimeWatchdogOutcome(fullWindowRuntime, { status: 504, durationMs: 600012, stream: true }).kind,
  'ignored'
);
assert.equal(
  classifyRuntimeWatchdogOutcome(fullWindowRuntime, { status: 504, durationMs: 1800000, stream: true }).kind,
  'no-progress-failure'
);
