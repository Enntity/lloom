import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRecipes, planRecipe } from '../src/recipes.mjs';
const recipe = (await loadRecipes()).find((r) => r.id === 'linux-nvidia-ltx-2-5-native');
assert.ok(recipe);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-ltx-recipe-'));
try {
  const empty = {
    server: { host: '127.0.0.1', port: 8100 },
    models: [],
    backends: {},
    runtimes: {},
    defaults: {},
    aliases: {}
  };
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(empty));
  const plan = await createInitPlan(await loadConfig(file), {
    recipeId: recipe.id,
    additive: true,
    modelRoot: path.join(dir, 'models'),
    autoDetectModelRoot: false,
    clientId: 'manifest'
  });
  const c = plan.config;
  assert.deepEqual(c.defaults, empty.defaults);
  assert.deepEqual(c.aliases, empty.aliases);
  assert.equal(c.models.length, 2);
  assert.deepEqual(c.models.map((m) => m.id).sort(), ['Lightricks/LTX-2.5-Distilled', 'Lightricks/LTX-2.5-Full']);
  assert.deepEqual([...new Set(c.models.map((m) => m.runtime))], ['ltx-pipelines']);
  for (const m of c.models) {
    assert.ok(!/-(Dev|Dev-HQ|A2V|Keyframes|Retake|DFR)$/.test(m.id), `stale IDs must not survive: ${m.id}`);
    for (const capability of [
      'video-generation',
      'text-to-video',
      'image-to-video',
      ...(m.id.endsWith('Full') ? ['audio-to-video', 'keyframe-interpolation'] : ['video-to-video', 'video-editing'])
    ])
      assert.ok(m.capabilities.includes(capability), `${m.id} must aggregate ${capability}`);
    for (const input of ['text', 'image', m.id.endsWith('Full') ? 'audio' : 'video'])
      assert.ok(m.input.includes(input), `${m.id} must accept ${input}`);
    for (const output of ['video', 'audio']) assert.ok(m.output.includes(output), `${m.id} must emit ${output}`);
  }
  const runtime = c.runtimes['ltx-pipelines'];
  assert.equal(runtime.maxConcurrency, 1);
  assert.equal(runtime.keepWarm, false);
  assert.equal(runtime.warmup, undefined);
  const image = execFileSync('python3', ['backends/ltx-pipelines/install.py', '--print-image'], {
    encoding: 'utf8'
  }).trim();
  assert.equal(runtime.bootstrap.image, image);
  assert.match(runtime.bootstrap.createArgs.join(' '), /127\.0\.0\.1:\d+:8000/);
  assert.ok(runtime.bootstrap.createArgs.includes(`${dir}/models:/models:ro`));
  for (const m of c.models) assert.equal(m.upstreamModel, m.id);
  assert.deepEqual(
    planRecipe(recipe, c, { modelRoot: path.join(dir, 'models'), checkLocalReferences: false }).validationErrors,
    []
  );
  console.log('LTX recipe: two public IDs, aggregated capabilities, one serialized runtime, no aliases/defaults');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
