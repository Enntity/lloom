import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applyModelRemoval, createModelRemovalPlan } from '../src/model-removal.mjs';

function configWithInit(modelId, runtimeId, { shared = false, initKeepWarm = false } = {}) {
  const models = [{ id: modelId, backend: `${runtimeId}-backend`, runtime: runtimeId }];
  const runtimes = {
    [runtimeId]: { enabled: true, port: 8231, args: [] }
  };
  const backends = { [`${runtimeId}-backend`]: { type: 'openai', baseUrl: 'http://127.0.0.1:8231/v1' } };
  if (shared) {
    models.push({ id: 'keep-me', backend: `${runtimeId}-backend`, runtime: runtimeId });
  }
  const init = {
    recipeId: 'synthetic',
    enabledRuntimes: ['stale-runtime', runtimeId],
    ...(initKeepWarm ? { keepWarmRuntime: runtimeId } : {})
  };
  return {
    sourcePath: null,
    paths: { modelRoot: '' },
    models,
    runtimes,
    backends,
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: [modelId] },
    init
  };
}

test('remove-model prunes removed runtime ids from init bookkeeping', () => {
  const config = configWithInit('flux-model', 'flux-runtime', { initKeepWarm: true });
  const plan = createModelRemovalPlan(config, { modelId: 'flux-model' });
  assert.equal(plan.ok, true);

  const next = plan.config;
  assert.equal(next.runtimes['flux-runtime'], undefined);
  assert.deepEqual(
    next.init.enabledRuntimes,
    ['stale-runtime'],
    'the removed dedicated runtime must be pruned while unrelated stale ids survive until a later additive init'
  );
  assert.equal(next.init.keepWarmRuntime, undefined, 'a keep-warm pin on the removed runtime must be cleared');
});

test('remove-model leaves shared runtime bookkeeping untouched', () => {
  const config = {
    sourcePath: null,
    paths: { modelRoot: '' },
    models: [
      { id: 'remove-me', backend: 'shared', runtime: 'shared-runtime' },
      { id: 'keep-me', backend: 'shared', runtime: 'shared-runtime' }
    ],
    backends: { shared: { type: 'openai' } },
    runtimes: { 'shared-runtime': { args: [] } },
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: ['remove-me', 'keep-me'] },
    init: { enabledRuntimes: ['shared-runtime', 'other-runtime'], keepWarmRuntime: 'shared-runtime' }
  };
  const plan = createModelRemovalPlan(config, { modelId: 'remove-me' });
  assert.equal(plan.ok, true);
  assert.equal(plan.cleanup.runtime, null, 'a shared runtime must be preserved');

  const next = plan.config;
  assert.deepEqual(next.init.enabledRuntimes, ['shared-runtime', 'other-runtime']);
  assert.equal(next.init.keepWarmRuntime, 'shared-runtime');
});

test('multi-component removal reclaims every exclusively owned weight and reports bytes', async () => {
  const modelRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-removal-weights-'));
  try {
    const modelDir = path.join(modelRoot, 'flux2-klein-4b');
    await fs.mkdir(path.join(modelDir, 'split_files', 'text_encoders'), { recursive: true });
    await fs.mkdir(path.join(modelDir, 'split_files', 'vae'), { recursive: true });
    const diffusion = path.join(modelDir, 'flux-2-klein-4b-Q8_0.gguf');
    const encoder = path.join(modelDir, 'split_files', 'text_encoders', 'qwen_3_4b.safetensors');
    const vae = path.join(modelDir, 'split_files', 'vae', 'flux2-vae.safetensors');
    await fs.writeFile(diffusion, 'x'.repeat(100));
    await fs.writeFile(encoder, 'y'.repeat(50));
    await fs.writeFile(vae, 'z'.repeat(25));

    const configPath = path.join(modelRoot, 'config.json');
    const config = {
      sourcePath: configPath,
      paths: { modelRoot },
      models: [{ id: 'black-forest-labs/FLUX.2-klein-4B', backend: 'flux-backend', runtime: 'flux-runtime' }],
      backends: { 'flux-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:8232/v1' } },
      runtimes: {
        'flux-runtime': {
          enabled: true,
          port: 8232,
          args: ['--diffusion-model', diffusion, '--llm', encoder, '--vae', vae, '--cfg-scale', '1.0']
        }
      },
      aliases: {},
      defaults: {},
      clientCatalog: { modelOrder: ['black-forest-labs/FLUX.2-klein-4B'] },
      init: { enabledRuntimes: ['flux-runtime'] }
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const plan = createModelRemovalPlan(config, {
      modelId: 'black-forest-labs/FLUX.2-klein-4B',
      deleteFiles: true,
      configPath
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(
      plan.cleanup.modelFiles,
      [diffusion, encoder, vae],
      'every exclusively owned component must be reclaimed, not just the first argument'
    );

    const applied = await applyModelRemoval(config, {
      modelId: 'black-forest-labs/FLUX.2-klein-4B',
      deleteFiles: true,
      configPath,
      runtimeStatus: { runtimes: { 'flux-runtime': { status: 'stopped', activeRequests: 0 } } },
      dryRun: false,
      yes: true
    });
    assert.deepEqual(applied.deletedFiles, [diffusion, encoder, vae]);
    assert.equal(applied.reclaimedBytes, 175);
    await assert.rejects(() => fs.access(diffusion));
    await assert.rejects(() => fs.access(encoder));
    await assert.rejects(() => fs.access(vae));
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(written.runtimes['flux-runtime'], undefined);
    assert.deepEqual(written.init.enabledRuntimes, []);
  } finally {
    await fs.rm(modelRoot, { recursive: true, force: true });
  }
});

test('shared weight components are preserved and reported', () => {
  const modelRoot = '/tmp/lloom-shared-weights';
  const config = {
    sourcePath: null,
    paths: { modelRoot },
    models: [
      { id: 'flux-model', backend: 'flux-backend', runtime: 'flux-runtime' },
      { id: 'other-image-model', backend: 'other-backend', runtime: 'other-runtime' }
    ],
    backends: {
      'flux-backend': { type: 'openai' },
      'other-backend': { type: 'openai' }
    },
    runtimes: {
      'flux-runtime': {
        args: [
          path.join(modelRoot, 'shared', 'diffusion.gguf'),
          path.join(modelRoot, 'shared', 'encoder.safetensors'),
          path.join(modelRoot, 'flux-only', 'vae.safetensors')
        ]
      },
      'other-runtime': {
        args: [path.join(modelRoot, 'shared', 'diffusion.gguf'), path.join(modelRoot, 'shared', 'encoder.safetensors')]
      }
    },
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: ['flux-model', 'other-image-model'] }
  };
  const plan = createModelRemovalPlan(config, { modelId: 'flux-model', deleteFiles: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.cleanup.modelFiles,
    [path.join(modelRoot, 'flux-only', 'vae.safetensors')],
    'only the exclusively owned component is reclaimed'
  );
  assert.deepEqual(
    plan.cleanup.preservedModelFiles,
    [path.join(modelRoot, 'shared', 'diffusion.gguf'), path.join(modelRoot, 'shared', 'encoder.safetensors')],
    'components still used by another model are preserved'
  );
  assert.ok(
    plan.warnings.some((warning) => warning.includes('other-image-model')),
    'shared components are attributed to the other model'
  );
});

test('delete-files without any identifiable weights remains a validation error', () => {
  const config = {
    sourcePath: null,
    paths: { modelRoot: '/tmp/lloom-empty-root' },
    models: [{ id: 'external-model', backend: 'external-backend', runtime: 'external-runtime' }],
    backends: { 'external-backend': { type: 'openai', baseUrl: 'https://external.example/v1' } },
    runtimes: { 'external-runtime': { args: [] } },
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: ['external-model'] }
  };
  const plan = createModelRemovalPlan(config, { modelId: 'external-model', deleteFiles: true });
  assert.equal(plan.ok, false);
  assert.match(plan.validationErrors[0], /cannot be identified safely/);
});

test('external listener conflict on a stale runtime is surfaced', () => {
  const config = {
    sourcePath: null,
    paths: { modelRoot: '/tmp/lloom-conflict' },
    models: [{ id: 'stale-model', backend: 'stale-backend', runtime: 'stale-runtime' }],
    backends: { 'stale-backend': { type: 'openai' } },
    runtimes: { 'stale-runtime': { enabled: true, port: 9371, args: [] } },
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: ['stale-model'] }
  };
  const plan = createModelRemovalPlan(config, {
    modelId: 'stale-model',
    runtimeStatus: { runtimes: { 'stale-runtime': { status: 'stopped', activeRequests: 0 } } },
    externalPortListeners: [9371]
  });
  assert.ok(
    plan.warnings.some((warning) => warning.includes('9371') && warning.includes('external process')),
    'a port held by another process is reported rather than silently left running'
  );
});
