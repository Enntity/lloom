import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRecipes, planRecipe } from '../src/recipes.mjs';

const recipes = await loadRecipes();
const recipe = recipes.find((r) => r.id === 'linux-nvidia-ace-step-1-5-xl-diffusers');
assert.ok(recipe, 'ACE-Step Diffusers recipe must be present in the index');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-ace-diffusers-recipe-'));
try {
  const file = path.join(dir, 'config.json');
  async function apply(config, target) {
    await fs.writeFile(file, JSON.stringify(config));
    return (
      await createInitPlan(await loadConfig(file), {
        recipeId: target.id,
        additive: true,
        modelRoot: path.join(dir, 'models'),
        autoDetectModelRoot: false,
        clientId: 'manifest'
      })
    ).config;
  }
  const empty = {
    server: { host: '127.0.0.1', port: 8100 },
    models: [],
    backends: {},
    runtimes: {},
    defaults: {},
    aliases: {}
  };
  const after = await apply(empty, recipe);

  // Two separate lanes: one process serves one ACE checkpoint.
  assert.deepEqual(after.defaults, empty.defaults, 'music recipe must not silently retarget defaults');
  assert.equal(after.models.length, 2);
  const sft = after.models.find((m) => m.id === 'ACE-Step/ACE-Step-1.5-XL-SFT-Diffusers');
  const turbo = after.models.find((m) => m.id === 'ACE-Step/ACE-Step-1.5-XL-Turbo-Diffusers');
  assert.ok(sft && turbo, 'both XL variants must be registered');
  assert.equal(sft.runtime, 'ace-step-sft');
  assert.equal(turbo.runtime, 'ace-step-turbo');
  assert.notEqual(sft.runtime, turbo.runtime, 'variants must not share a runtime');
  assert.deepEqual(sft.capabilities, ['audio-generation', 'music-generation']);
  assert.equal(sft.kind, 'audio_generation');

  const image = execFileSync('python3', ['backends/ace-step-diffusers/install.py', '--print-image'], {
    encoding: 'utf8'
  }).trim();
  for (const [runtimeId, variant] of [
    ['ace-step-sft', 'sft'],
    ['ace-step-turbo', 'turbo']
  ]) {
    const runtime = after.runtimes[runtimeId];
    assert.ok(runtime, `${runtimeId} runtime must be created`);
    assert.equal(runtime.warmup, undefined, 'music runtime must not receive a chat warmup');
    assert.equal(runtime.bootstrap.image, image);
    const args = runtime.bootstrap.createArgs.join(' ');
    assert.match(args, /127\.0\.0\.1:\d+:8000/);
    assert.ok(runtime.bootstrap.createArgs.includes(`${dir}/models:/models:ro`));
    // Each lane must point the container at its own checkpoint.
    assert.ok(args.includes(`LLOOM_ACE_MODEL_PATH=/models/ACE-Step--acestep-v15-xl-${variant}-diffusers`));
  }

  const plan = planRecipe(recipe, after, { modelRoot: path.join(dir, 'models'), checkLocalReferences: false });
  assert.deepEqual(plan.validationErrors, []);
  console.log('ACE-Step Diffusers recipe: separate variant runtimes, preserved defaults, pinned source and weights');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
