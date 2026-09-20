import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRecipes, planRecipe } from '../src/recipes.mjs';
import { createModelImportPlan } from '../src/model-intake.mjs';
import { createSetupStatus } from '../src/setup-status.mjs';

const recipes = (await loadRecipes()).filter((r) => r.id.startsWith('linux-nvidia-comfyui-'));
assert.equal(recipes.length, 14);
const image = execFileSync('python3', ['backends/comfyui-media/install.py', '--print-image'], {
  encoding: 'utf8'
}).trim();
const roots = JSON.parse(await fs.readFile('backends/comfyui-media/model-roots.json', 'utf8'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-comfyui-recipes-'));
try {
  const file = path.join(dir, 'config.json');
  const empty = {
    server: { host: '127.0.0.1', port: 8100 },
    models: [],
    backends: {},
    runtimes: {},
    defaults: {},
    aliases: {}
  };
  async function apply(config, recipe) {
    await fs.writeFile(file, JSON.stringify(config));
    return (
      await createInitPlan(await loadConfig(file), {
        recipeId: recipe.id,
        additive: true,
        modelRoot: path.join(dir, 'models'),
        autoDetectModelRoot: false,
        clientId: 'manifest'
      })
    ).config;
  }
  for (const recipe of recipes) {
    assert.equal(recipe.models.length, 1);
    assert.doesNotMatch(
      JSON.stringify({ ...recipe, filePath: undefined }),
      /ennspark|spark03|enntitysparkadmin|\/Users\/|\/home\/|192\.168\.|100\.78\./
    );
    const standalone = await apply(empty, recipe);
    assert.equal(standalone.models.length, 1);
    assert.equal(Object.keys(standalone.runtimes).length, 1);
    assert.equal(standalone.runtimes['comfyui-media'].bootstrap.image, image);
    assert.match(standalone.runtimes['comfyui-media'].bootstrap.createArgs.join(' '), /127\.0\.0\.1:\d+:8000/);
    const model = standalone.models[0];
    assert.equal(
      model.kind,
      recipe.capabilities.includes('music-generation') ? 'audio_generation' : recipe.models[0].kind
    );
    for (const step of recipe.setup.steps.filter((s) => s.action === 'download-model')) {
      assert.match(step.revision, /^[a-f0-9]{40}$/);
      assert.deepEqual(
        step.include,
        step.integrity.files.map((f) => f.path)
      );
      for (const entry of step.integrity.files) {
        assert.match(entry.sha256, /^[a-f0-9]{64}$/);
        const parts = entry.path.split('/');
        const root = [step.model.replaceAll('/', '--'), ...parts.slice(0, -2)].join('/');
        assert.ok(roots[root], `unmapped download ${root}`);
      }
    }
    const plan = planRecipe(recipe, standalone, { modelRoot: path.join(dir, 'models'), checkLocalReferences: false });
    assert.deepEqual(plan.validationErrors, []);
  }
  for (const order of [recipes, recipes.toReversed()]) {
    let config = await apply(empty, order[0]);
    const runtime = structuredClone(config.runtimes['comfyui-media']);
    const backend = structuredClone(config.backends['comfyui-media']);
    for (const recipe of order.slice(1)) {
      config = await apply(config, recipe);
      assert.deepEqual(config.runtimes['comfyui-media'], runtime);
      assert.deepEqual(config.backends['comfyui-media'], backend);
    }
    assert.equal(config.models.length, 14);
    assert.equal(config.models.filter((m) => m.kind === 'audio_generation').length, 4);
    assert.deepEqual(Object.keys(config.runtimes), ['comfyui-media']);
  }
  assert.throws(
    () => createModelImportPlan(empty, { modelRef: 'mlx-community/ACE-Step', backend: 'mlx-audio' }),
    /dedicated ComfyUI recipe/
  );

  // Explicit recipe selection refreshes legacy music classification while
  // preserving a shared engine's established route and container settings.
  const musicRecipe = recipes.find((recipe) => recipe.id.endsWith('ace-step-1-5-xl-turbo'));
  const legacy = await apply(empty, musicRecipe);
  const legacyModel = legacy.models[0];
  legacyModel.kind = 'audio_speech';
  legacyModel.capabilities = ['audio-speech', 'music-generation'];
  legacyModel.tts = { family: 'generic' };
  legacyModel.upstreamModel = 'existing-upstream-name';
  legacy.defaults.speechModel = legacyModel.id;
  legacy.runtimes['comfyui-media'].recipe.id = 'existing-media-install';
  const preservedRuntime = structuredClone(legacy.runtimes['comfyui-media']);
  const preservedBackend = structuredClone(legacy.backends['comfyui-media']);
  const migrated = await apply(legacy, musicRecipe);
  assert.deepEqual(migrated.runtimes['comfyui-media'], preservedRuntime);
  assert.deepEqual(migrated.backends['comfyui-media'], preservedBackend);
  assert.equal(migrated.models[0].kind, 'audio_generation');
  assert.equal(migrated.models[0].upstreamModel, 'existing-upstream-name');
  assert.equal(migrated.models[0].tts, undefined);
  assert.equal(migrated.defaults.speechModel, undefined);
  assert.equal(migrated.defaults.audioGenerationModel, legacyModel.id);

  // Setup status must compose the actual download dependencies even when the
  // gateway model ID has no matching directory of its own.
  const dependencyRoot = path.join(dir, 'composed-models');
  const dependencyRevision = 'abcdef0123456789abcdef0123456789abcdef01';
  const dependencyFiles = [
    { model: 'owner/base', file: 'split_files/base.safetensors' },
    { model: 'owner/adapter', file: 'loras/adapter.safetensors' }
  ];
  for (const dependency of dependencyFiles) {
    const destination = path.join(dependencyRoot, dependency.model.replaceAll('/', '--'));
    await fs.mkdir(path.join(destination, path.dirname(dependency.file)), { recursive: true });
    await fs.writeFile(path.join(destination, dependency.file), 'weights\n');
  }
  const composedRecipe = {
    schemaVersion: 1,
    id: 'composed-dependency-status-fixture',
    name: 'Composed dependency status fixture',
    requirements: { platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'] },
    backend: { id: 'openai-compatible' },
    models: [{ role: 'composed', model: 'gateway/composed' }],
    setup: {
      steps: dependencyFiles.map(({ model, file }, index) => ({
        id: `download-${index}`,
        action: 'download-model',
        provider: 'huggingface',
        model,
        revision: dependencyRevision,
        include: [file],
        integrity: { files: [{ path: file, sizeBytes: 8 }] }
      }))
    }
  };
  const setupStatus = await createSetupStatus(
    {
      sourcePath: path.join(dir, 'config.json'),
      server: { host: '127.0.0.1', port: 8100 },
      defaults: {},
      models: [],
      aliases: {},
      backends: {},
      runtimes: {},
      paths: { modelRoot: dependencyRoot }
    },
    {
      recipeId: composedRecipe.id,
      modelRoot: dependencyRoot,
      home: dir,
      generatedRoot: path.join(dir, 'generated'),
      clientId: 'codex',
      includeRuntimes: false,
      recipeDocuments: [composedRecipe],
      recipesRoot: path.join(dir, 'no-recipes'),
      statePath: path.join(dir, 'composed-state.json')
    }
  );
  assert.equal(setupStatus.recipe.models.length, 1);
  const composedDestination = setupStatus.recipe.models[0].destination;
  assert.equal(composedDestination.complete, true, JSON.stringify(composedDestination));
  assert.deepEqual(
    composedDestination.dependencies.map((dependency) => dependency.path),
    dependencyFiles.map(({ model }) => path.join(dependencyRoot, model.replaceAll('/', '--')))
  );
  assert.ok(composedDestination.dependencies.every((dependency) => dependency.complete));

  console.log('ComfyUI recipes: all 14 standalone; shared runtime and backend unchanged in both application orders');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
