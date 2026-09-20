import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRecipes, planRecipe } from '../src/recipes.mjs';

const recipes = await loadRecipes();
const edit = recipes.find((r) => r.id === 'linux-nvidia-qwen-image-2-1-diffusers');
const generation = recipes.find((r) => r.id === 'linux-nvidia-comfyui-qwen-image-2-1');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-diffusers-recipe-'));
try {
  const file = path.join(dir, 'config.json');
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
  const empty = {
    server: { host: '127.0.0.1', port: 8100 },
    models: [],
    backends: {},
    runtimes: {},
    defaults: {},
    aliases: {}
  };
  const before = await apply(empty, generation);
  const after = await apply(before, edit);
  assert.deepEqual(after.defaults, before.defaults);
  assert.deepEqual(after.runtimes['comfyui-media'], before.runtimes['comfyui-media']);
  assert.equal(after.models.length, 2);
  const model = after.models.find((m) => m.id === 'Qwen/Qwen-Image-2.1-Diffusers');
  assert.ok(model);
  assert.equal(model.runtime, 'qwen-image-diffusers');
  assert.deepEqual(model.capabilities, ['image-editing']);
  const runtime = after.runtimes['qwen-image-diffusers'];
  const image = execFileSync('python3', ['backends/qwen-image-diffusers/install.py', '--print-image'], {
    encoding: 'utf8'
  }).trim();
  assert.equal(runtime.bootstrap.image, image);
  assert.match(runtime.bootstrap.createArgs.join(' '), /127\.0\.0\.1:\d+:8000/);
  assert.ok(runtime.bootstrap.createArgs.includes(`${dir}/models:/models:ro`));
  const plan = planRecipe(edit, after, { modelRoot: path.join(dir, 'models'), checkLocalReferences: false });
  assert.deepEqual(plan.validationErrors, []);
  console.log('Qwen Diffusers recipe: separate runtime, preserved generation default, pinned source and weights');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
