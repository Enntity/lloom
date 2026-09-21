import assert from 'node:assert/strict';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRecipeById } from '../src/recipes.mjs';

const recipe = await loadRecipeById('lloom-hear');
assert.equal(recipe.backend.id, 'hear');
assert.equal(recipe.backend.type, 'openai-compatible-server');
assert.deepEqual(recipe.requirements.commands, ['lloom-hear-server', 'ffmpeg', 'ffprobe']);

// The tool is CPU-only by design; it must not claim an accelerator.
assert.deepEqual(recipe.requirements.accelerators, []);

const model = recipe.models[0];
assert.equal(model.role, 'perception');
assert.equal(model.gatewayModel, 'hear');
assert.deepEqual(model.input, ['text', 'audio']);
assert.deepEqual(model.output, ['text', 'image']);
// The generated warmup block sends an audio-less chat request, which this backend
// rejects by design, so warmup must stay off and the server warms itself at boot.
assert.equal(model.settings.runtime.warmup, false);
// The gateway sizes prompts from the raw request and counts inline base64 audio as
// text tokens (a 30 s clip is ~183K), so the gate has to admit that.
assert.ok(model.settings.contextWindow >= 1048576);

const config = await loadConfig();
const plan = await createInitPlan(config, {
  recipeId: 'lloom-hear',
  additive: true,
  modelRoot: '/tmp/lloom-models'
});
const next = plan.config;
const hear = next.models.find((m) => m.id === 'hear');
assert.ok(hear, 'hear model should be present in the planned config');
assert.equal(hear.kind, 'chat');
assert.equal(hear.runtime, 'hear');
assert.equal(hear.backend, 'hear');
assert.equal(hear.input.includes('audio'), true);

assert.equal(next.runtimes.hear.command, 'lloom-hear-server');
assert.match(next.runtimes.hear.healthUrl, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
assert.deepEqual(next.runtimes.hear.args, ['--host', '127.0.0.1', '--port', String(next.runtimes.hear.port)]);
assert.equal(next.runtimes.hear.env.LLOOM_HEAR_UPSTREAM_URL.endsWith('/v1/chat/completions'), true);
assert.ok(next.runtimes.hear.env.LLOOM_HEAR_UPSTREAM_MODEL);
// No generated warmup: the server pre-warms numba and matplotlib at startup instead.
assert.equal(next.runtimes.hear.warmup, undefined);
assert.match(next.backends.hear.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

assert.deepEqual(next.aliases.hear.members, ['hear']);
assert.deepEqual(next.aliases.listen.members, ['hear']);

console.log('hear-recipe tests passed');
