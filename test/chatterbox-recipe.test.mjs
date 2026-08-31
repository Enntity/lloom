import assert from 'node:assert/strict';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRecipeById } from '../src/recipes.mjs';
import { resolveTtsDescriptor } from '../src/tts-catalog.mjs';

const apple = await loadRecipeById('apple-silicon-chatterbox');
const dgx = await loadRecipeById('linux-nvidia-gb10-chatterbox');
assert.equal(apple.backend.id, 'chatterbox');
assert.equal(dgx.backend.id, 'chatterbox');
assert.equal(apple.requirements.platforms[0], 'darwin-arm64');
assert.ok(dgx.requirements.platforms.includes('linux-arm64'));
assert.equal(apple.models[0].settings.runtime.env.LLOOM_CHATTERBOX_DEVICE, 'mps');
assert.equal(dgx.models[0].settings.runtime.env.LLOOM_CHATTERBOX_DEVICE, 'cuda');

const config = await loadConfig();
const plan = await createInitPlan(config, {
  recipeId: 'apple-silicon-chatterbox',
  additive: true,
  modelRoot: '/tmp/lloom-models'
});
const next = plan.config;
const english = next.models.find((model) => model.id === 'ResembleAI/chatterbox');
const multilingual = next.models.find((model) => model.id === 'ResembleAI/chatterbox-multilingual');
const turbo = next.models.find((model) => model.id === 'ResembleAI/chatterbox-turbo');
assert.ok(english);
assert.equal(english.kind, 'audio_speech');
assert.equal(english.runtime, 'chatterbox');
assert.equal(english.tts.family, 'chatterbox');
assert.equal(next.runtimes.chatterbox.command, 'lloom-chatterbox-server');
assert.equal(next.runtimes.chatterbox.env.LLOOM_CHATTERBOX_DEVICE, 'mps');
assert.equal(next.runtimes.chatterbox.warmup, undefined);
assert.match(next.backends.chatterbox.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
assert.deepEqual(next.aliases.chatterbox.members, ['ResembleAI/chatterbox']);
assert.deepEqual(next.aliases['chatterbox-multilingual'].members, ['ResembleAI/chatterbox-multilingual']);
assert.deepEqual(next.aliases['chatterbox-turbo'].members, ['ResembleAI/chatterbox-turbo']);

const descriptor = resolveTtsDescriptor(english);
assert.equal(descriptor.params.exaggeration.default, 0.5);
assert.equal(resolveTtsDescriptor(multilingual).variant, 'multilingual');
assert.equal(resolveTtsDescriptor(turbo).variant, 'turbo');

console.log('chatterbox-recipe tests passed');
