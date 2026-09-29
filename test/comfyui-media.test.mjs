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
assert.equal(recipes.length, 16);
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
    const runtimeId = recipe.models[0].runtime;
    assert.equal(standalone.models.length, 1);
    assert.equal(Object.keys(standalone.runtimes).length, 1);
    assert.equal(standalone.runtimes[runtimeId].bootstrap.image, image);
    assert.match(standalone.runtimes[runtimeId].bootstrap.createArgs.join(' '), /127\.0\.0\.1:\d+:8000/);
    const args = standalone.runtimes[runtimeId].bootstrap.createArgs;
    assert.ok(args.includes(`LLOOM_MEDIA_MODEL=${recipe.models[0].model}`));
    assert.ok(args.includes('LLOOM_MODELS_ROOT=/opt/ComfyUI/models'));
    assert.ok(!args.some((arg) => arg.includes(':/opt/lloom-models')));
    const fileMounts = args.filter((arg) => arg.startsWith('type=bind,'));
    const downloads = recipe.setup.steps.filter((step) => step.action === 'download-model');
    assert.equal(
      fileMounts.length,
      downloads.reduce((n, step) => n + step.include.length, 0)
    );
    for (const step of downloads)
      for (const file of step.include) {
        assert.ok(
          fileMounts.some(
            (mount) =>
              mount.includes(`/${step.model.replaceAll('/', '--')}/${file},dst=/opt/ComfyUI/models/`) &&
              mount.endsWith(',readonly')
          )
        );
      }
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
    let config = structuredClone(empty);
    for (const recipe of order) {
      const previousRuntimes = structuredClone(config.runtimes);
      const previousBackends = structuredClone(config.backends);
      config = await apply(config, recipe);
      for (const [id, value] of Object.entries(previousRuntimes)) assert.deepEqual(config.runtimes[id], value);
      for (const [id, value] of Object.entries(previousBackends)) assert.deepEqual(config.backends[id], value);
    }
    assert.equal(config.models.length, recipes.length);
    assert.equal(config.models.filter((m) => m.kind === 'audio_generation').length, 4);
    assert.equal(Object.keys(config.runtimes).length, recipes.length);
    assert.equal(Object.keys(config.backends).length, recipes.length);
    assert.equal(new Set(Object.values(config.runtimes).map((runtime) => runtime.port)).size, recipes.length);
    assert.equal(new Set(config.models.map((model) => model.runtime)).size, recipes.length);
    const modelByRuntime = new Map(config.models.map((model) => [model.runtime, model.id]));
    for (const [runtimeId, runtime] of Object.entries(config.runtimes)) {
      assert.ok(
        runtime.bootstrap.createArgs.includes(`LLOOM_MEDIA_MODEL=${modelByRuntime.get(runtimeId)}`),
        `${runtimeId} serves the wrong model`
      );
    }
    assert.ok(
      config.runtimes['qwen-image-21-nvfp4'].bootstrap.createArgs.includes(
        'LLOOM_MEDIA_MODEL=BennyDaBall/Qwen-Image-2.1-NVFP4'
      )
    );
  }
  assert.throws(
    () => createModelImportPlan(empty, { modelRef: 'mlx-community/ACE-Step', backend: 'mlx-audio' }),
    /dedicated ComfyUI recipe/
  );

  // Explicit recipe selection refreshes legacy music classification while
  // preserving the model's established route and container settings.
  const musicRecipe = recipes.find((recipe) => recipe.id.endsWith('ace-step-1-5-xl-turbo'));
  const legacy = await apply(empty, musicRecipe);
  const legacyModel = legacy.models[0];
  const musicRuntime = musicRecipe.models[0].runtime;
  legacyModel.kind = 'audio_speech';
  legacyModel.capabilities = ['audio-speech', 'music-generation'];
  legacyModel.tts = { family: 'generic' };
  legacyModel.upstreamModel = 'existing-upstream-name';
  legacy.defaults.speechModel = legacyModel.id;
  legacy.runtimes[musicRuntime].recipe.id = 'existing-media-install';
  const preservedRuntime = structuredClone(legacy.runtimes[musicRuntime]);
  const preservedBackend = structuredClone(legacy.backends[musicRuntime]);
  const migrated = await apply(legacy, musicRecipe);
  assert.deepEqual(migrated.runtimes[musicRuntime], preservedRuntime);
  assert.deepEqual(migrated.backends[musicRuntime], preservedBackend);
  assert.equal(migrated.models[0].kind, 'audio_generation');
  assert.equal(migrated.models[0].upstreamModel, 'existing-upstream-name');
  assert.equal(migrated.models[0].tts, undefined);
  assert.equal(migrated.defaults.speechModel, undefined);
  assert.equal(migrated.defaults.audioGenerationModel, legacyModel.id);

  // A catalog from the retired shared runtime moves each re-applied model to
  // its own runtime; the shared one is dropped once no model references it.
  const [imageRecipe, videoRecipe] = ['flux-2-klein-4b', 'minimax-h3'].map((suffix) =>
    recipes.find((recipe) => recipe.id.endsWith(suffix))
  );
  const shared = await apply(await apply(empty, imageRecipe), videoRecipe);
  const sharedRuntime = structuredClone(shared.runtimes[imageRecipe.models[0].runtime]);
  sharedRuntime.bootstrap.createArgs = sharedRuntime.bootstrap.createArgs.filter(
    (arg) => !arg.startsWith('LLOOM_MEDIA_MODEL=')
  );
  shared.runtimes = { 'comfyui-media': sharedRuntime };
  shared.backends = { 'comfyui-media': shared.backends[imageRecipe.models[0].backendConfig] };
  for (const model of shared.models) Object.assign(model, { runtime: 'comfyui-media', backend: 'comfyui-media' });
  const partlyMoved = await apply(shared, imageRecipe);
  assert.equal(partlyMoved.models[0].runtime, imageRecipe.models[0].runtime);
  assert.equal(partlyMoved.models[0].backend, imageRecipe.models[0].backendConfig);
  assert.equal(partlyMoved.models[1].runtime, 'comfyui-media');
  assert.ok(partlyMoved.runtimes['comfyui-media']);
  const fullyMoved = await apply(partlyMoved, videoRecipe);
  assert.deepEqual(
    fullyMoved.models.map((model) => model.runtime),
    [imageRecipe, videoRecipe].map((recipe) => recipe.models[0].runtime)
  );
  assert.equal(fullyMoved.runtimes['comfyui-media'], undefined);
  assert.equal(fullyMoved.backends['comfyui-media'], undefined);

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

  console.log('ComfyUI recipes: all 16 have independent runtimes and file mounts in both application orders');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
