import assert from 'node:assert/strict';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { getBackend, loadBackendCatalog } from '../src/backend-catalog.mjs';
import { loadRecipeById } from '../src/recipes.mjs';
import { resolveTtsDescriptor } from '../src/tts-catalog.mjs';

const recipe = await loadRecipeById('linux-nvidia-gb10-drama3-tensorfold');
assert.equal(recipe.backend.id, 'drama-tensorfold');
assert.deepEqual(recipe.requirements.platforms, ['linux-arm64']);
assert.ok(getBackend(await loadBackendCatalog(), 'drama-tensorfold'));

const plan = await createInitPlan(await loadConfig(), {
  recipeId: 'linux-nvidia-gb10-drama3-tensorfold',
  additive: true,
  modelRoot: '/tmp/lloom-models'
});
const next = plan.config;
const model = next.models.find((entry) => entry.id === 'fishaudio/drama-3');
assert.ok(model);
assert.equal(model.kind, 'audio_speech');
assert.equal(model.runtime, 'drama-tensorfold');
assert.equal(next.runtimes['drama-tensorfold'].command, 'lloom-drama-server');
assert.equal(next.runtimes['drama-tensorfold'].keepWarm, true);
assert.match(next.backends['drama-tensorfold'].baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
assert.deepEqual(next.aliases['drama-3'].members, ['fishaudio/drama-3']);

const descriptor = resolveTtsDescriptor(model);
assert.equal(descriptor.family, 'drama-3');
assert.equal(descriptor.mode, 'voice_clone');
assert.equal(descriptor.sampleRate, 44100);
assert.deepEqual(descriptor.responseFormats, ['wav', 'pcm']);

console.log('drama3-tensorfold-recipe tests passed');
