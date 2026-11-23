import assert from 'node:assert/strict';
import { createInitPlan } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { getBackend, loadBackendCatalog } from '../src/backend-catalog.mjs';
import { loadRecipeById } from '../src/recipes.mjs';

const recipeId = 'linux-x64-radeon-680m-qwen3-embedding-4b-embrandt';
const modelId = 'embrandt/Qwen3-Embedding-4B-Q8_0';
const recipe = await loadRecipeById(recipeId);
assert.equal(recipe.backend.id, 'embrandt');
assert.deepEqual(recipe.requirements.platforms, ['linux-x64']);
const backend = getBackend(await loadBackendCatalog(), 'embrandt');
// Setup skips a completed install step unless it always runs, and then a new pinned commit is never built.
assert.equal(backend.setup.find((step) => step.id === 'install-embrandt').alwaysRun, true);

const before = await loadConfig();
const next = (await createInitPlan(before, { recipeId, additive: true, modelRoot: '/tmp/lloom-models' })).config;
const model = next.models.find((entry) => entry.id === modelId);
assert.ok(model);
assert.equal(model.kind, 'embedding');
assert.equal(model.runtime, 'embrandt');
assert.equal(model.upstreamModel, 'Qwen/Qwen3-Embedding-4B');
assert.equal(next.runtimes.embrandt.command, 'lloom-embrandt');
assert.match(next.backends.embrandt.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

// Installing it must not start it or send it any traffic: it is not kept warm, it takes over
// no alias, and its id is not the one a fleet's embeddings route already serves.
assert.equal(next.runtimes.embrandt.keepWarm, false);
assert.deepEqual(next.aliases, before.aliases);
assert.notEqual(modelId, 'Qwen/Qwen3-Embedding-4B');

console.log('embrandt-recipe tests passed');
