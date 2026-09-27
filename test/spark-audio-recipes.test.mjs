import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { getBackend, loadBackendCatalog } from '../src/backend-catalog.mjs';
import { loadRecipes, planRecipe } from '../src/recipes.mjs';
import { resolveSttDescriptor, resolveTtsDescriptor } from '../src/tts-catalog.mjs';

const expected = {
  'linux-nvidia-spark-audio-qwen3-tts-1-7b-customvoice': {
    kind: 'audio_speech',
    model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
    mode: 'custom_voice',
    modelPath: '/models/model'
  },
  'linux-nvidia-spark-audio-qwen3-tts-1-7b-base': {
    kind: 'audio_speech',
    model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    mode: 'voice_clone',
    modelPath: '/models/model'
  },
  'linux-nvidia-spark-audio-qwen3-tts-1-7b-voicedesign': {
    kind: 'audio_speech',
    model: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    mode: 'voice_design',
    modelPath: '/models/model'
  },
  'linux-nvidia-spark-audio-whisper-large-v3-turbo': {
    kind: 'audio_transcription',
    model: 'openai/whisper-large-v3-turbo',
    modelPath: '/models/model/large-v3-turbo.pt'
  }
};

const recipes = (await loadRecipes()).filter((r) => r.id.startsWith('linux-nvidia-spark-audio-'));
assert.deepEqual(recipes.map((r) => r.id).toSorted(), Object.keys(expected).toSorted());
const image = execFileSync('python3', ['backends/spark-audio/install.py', '--print-image'], {
  encoding: 'utf8'
}).trim();
assert.match(image, /^lloom\/spark-audio:source-[a-f0-9]{64}$/);
const backend = getBackend(await loadBackendCatalog(), 'spark-audio');
assert.ok(backend);
assert.ok(backend.setup.some((step) => step.args?.[0] === '${repoRoot}/backends/spark-audio/install.py'));

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-spark-audio-recipes-'));
try {
  // The image identity covers the build inputs only: tests and docs must not
  // force a rebuild, while any change to the served adapter must.
  const copy = path.join(dir, 'spark-audio');
  await fs.cp('backends/spark-audio', copy, { recursive: true });
  const copyImage = () =>
    execFileSync('python3', [path.join(copy, 'install.py'), '--print-image'], { encoding: 'utf8' }).trim();
  assert.equal(copyImage(), image);
  await fs.appendFile(path.join(copy, 'test_lloom_audio_cuda_server.py'), '\n# changed\n');
  await fs.appendFile(path.join(copy, 'README.md'), '\nchanged\n');
  assert.equal(copyImage(), image);
  await fs.appendFile(path.join(copy, 'lloom_audio_cuda_server.py'), '\n# changed\n');
  assert.notEqual(copyImage(), image);

  const modelRoot = path.join(dir, 'models');
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
        modelRoot,
        autoDetectModelRoot: false,
        clientId: 'manifest'
      })
    ).config;
  }
  function checkModel(config, recipe) {
    const want = expected[recipe.id];
    const recipeModel = recipe.models[0];
    const model = config.models.find((m) => m.id === want.model);
    assert.ok(model, `${recipe.id} did not materialize ${want.model}`);
    assert.equal(model.kind, want.kind);
    assert.equal(model.upstreamModel, want.model);
    assert.equal(model.runtime, recipeModel.runtime);
    if (want.kind === 'audio_speech') {
      const descriptor = resolveTtsDescriptor(model);
      assert.equal(descriptor.family, 'qwen3-tts');
      assert.equal(descriptor.mode, want.mode);
      assert.equal(descriptor.capabilities.includes('tts-voice-clone'), want.mode === 'voice_clone');
    } else {
      assert.equal(resolveSttDescriptor(model).family, 'whisper');
    }
    const runtime = config.runtimes[recipeModel.runtime];
    assert.equal(runtime.warmup, undefined, 'audio runtime must not receive a chat warmup');
    assert.equal(runtime.maxConcurrency, 1);
    assert.equal(runtime.containerName, `lloom-${recipeModel.runtime}`);
    assert.equal(runtime.healthUrl, `http://127.0.0.1:${runtime.port}/health`);
    assert.equal(config.backends[model.backend].baseUrl, `http://127.0.0.1:${runtime.port}/v1`);
    assert.equal(runtime.bootstrap.image, image);
    assert.equal(runtime.bootstrap.pull, false);
    const createArgs = runtime.bootstrap.createArgs;
    assert.ok(createArgs.join(' ').includes(`127.0.0.1:${runtime.port}:8000`));
    const download = recipe.setup.steps.find((s) => s.action === 'download-model');
    const mounts = createArgs.filter((arg, index) => ['-v', '--mount'].includes(createArgs[index - 1]));
    assert.deepEqual(mounts, [`${path.join(modelRoot, download.model.replaceAll('/', '--'))}:/models/model:ro`]);
    const command = runtime.bootstrap.command;
    assert.deepEqual(command, [
      '--kind',
      want.kind === 'audio_speech' ? 'tts' : 'stt',
      '--model',
      want.model,
      '--model-path',
      want.modelPath,
      '--host',
      '0.0.0.0',
      '--port',
      '8000'
    ]);
    if (want.modelPath !== '/models/model') {
      assert.ok(download.include.includes(path.posix.relative('/models/model', want.modelPath)));
    }
  }

  const ports = new Set();
  for (const recipe of recipes) {
    assert.equal(recipe.models.length, 1);
    assert.equal(recipe.backend.id, 'spark-audio');
    assert.doesNotMatch(
      JSON.stringify({ ...recipe, filePath: undefined }),
      /ennspark|spark03|enntitysparkadmin|\/Users\/|\/home\/|192\.168\.|100\.78\./
    );
    for (const step of recipe.setup.steps.filter((s) => s.action === 'download-model')) {
      assert.equal(step.provider, 'huggingface');
      assert.match(step.revision, /^[a-f0-9]{40}$/);
      assert.deepEqual(
        step.include,
        step.integrity.files.map((f) => f.path)
      );
      assert.equal(
        step.downloadSizeBytes,
        step.integrity.files.reduce((sum, f) => sum + f.sizeBytes, 0)
      );
      for (const entry of step.integrity.files) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    const standalone = await apply(empty, recipe);
    assert.equal(standalone.models.length, 1);
    assert.deepEqual(Object.keys(standalone.runtimes), [recipe.models[0].runtime]);
    assert.deepEqual(standalone.defaults, {});
    checkModel(standalone, recipe);
    const plan = planRecipe(recipe, standalone, { modelRoot, checkLocalReferences: false });
    assert.deepEqual(plan.validationErrors, []);
  }

  for (const order of [recipes, recipes.toReversed()]) {
    let config = await apply(empty, order[0]);
    for (const recipe of order.slice(1)) {
      const before = structuredClone(config);
      config = await apply(config, recipe);
      for (const [id, runtime] of Object.entries(before.runtimes)) assert.deepEqual(config.runtimes[id], runtime);
      for (const [id, backendConfig] of Object.entries(before.backends))
        assert.deepEqual(config.backends[id], backendConfig);
      assert.deepEqual(config.defaults, before.defaults);
    }
    assert.equal(config.models.length, 4);
    assert.equal(Object.keys(config.runtimes).length, 4);
    for (const recipe of recipes) checkModel(config, recipe);
    const runtimePorts = Object.values(config.runtimes).map((runtime) => runtime.port);
    assert.equal(new Set(runtimePorts).size, 4);
    runtimePorts.forEach((port) => ports.add(port));
    assert.equal(new Set(Object.values(config.runtimes).map((runtime) => runtime.containerName)).size, 4);
    assert.equal(config.models.filter((m) => m.kind === 'audio_speech').length, 3);
    assert.equal(config.models.filter((m) => m.kind === 'audio_transcription').length, 1);
  }
  assert.ok(![...ports].includes(8100));

  console.log('Spark audio recipes: 4 standalone and additive in both orders; independent runtimes, pinned image');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
