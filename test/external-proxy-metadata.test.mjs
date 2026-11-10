import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveUserConfig } from '../src/init.mjs';

function recipe({ contextWindow = 65536, capabilities = ['chat', 'tools'] } = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-external-refresh',
    version: 2,
    backend: { id: 'openai' },
    models: [
      {
        role: 'default',
        model: 'external/proxy-model',
        gatewayModel: 'external/proxy-model',
        upstreamModel: 'external/proxy-model',
        capabilities,
        settings: { contextWindow }
      }
    ]
  };
}

// An external (runtime-less) model that the recipe first materialized, recorded
// with its owning recipe identity.
function externalConfig() {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    backends: { 'external-backend': { type: 'openai', baseUrl: 'https://external.example/v1', timeoutMs: 1800000 } },
    models: [
      {
        id: 'external/proxy-model',
        upstreamModel: 'external/proxy-model',
        backend: 'external-backend',
        capabilities: ['chat'],
        contextWindow: 32768,
        advertise: true,
        recipe: { id: 'synthetic-external-refresh', version: 1 }
      }
    ],
    runtimes: {},
    aliases: {},
    defaults: {},
    clientCatalog: { modelOrder: ['external/proxy-model'] },
    init: { recipeId: 'synthetic-external-refresh', enabledRuntimes: [], additive: true }
  };
}

test('additive init refreshes metadata on an owned external model', () => {
  const before = externalConfig();
  const derived = deriveUserConfig(before, recipe(), { additive: true, modelRoot: '/tmp/lloom-ext' });

  assert.equal(derived.models[0].contextWindow, 65536, 'the requested context must be applied');
  assert.deepEqual(derived.models[0].capabilities, ['chat', 'tools']);
  // The route itself is untouched — only the advertised contract changes.
  assert.equal(derived.models[0].backend, 'external-backend');
  assert.equal(derived.backends['external-backend'].baseUrl, 'https://external.example/v1');
  assert.equal(derived.models[0].recipe.id, 'synthetic-external-refresh');
  assert.equal(derived.models[0].recipe.version, 2);
});

test('additive init reports unowned external metadata instead of silently accepting it', () => {
  const before = externalConfig();
  before.models[0].recipe = { id: 'someone-elses-recipe', version: 1 };
  const snapshot = structuredClone(before);
  assert.throws(
    () => deriveUserConfig(before, recipe(), { additive: true, modelRoot: '/tmp/lloom-ext' }),
    /cannot be refreshed without recipe ownership/
  );
  assert.deepEqual(before, snapshot);
});

test('non-additive init does not refresh an external model', () => {
  const before = externalConfig();
  const derived = deriveUserConfig(before, recipe(), { additive: false, modelRoot: '/tmp/lloom-ext' });

  assert.equal(
    derived.models[0].contextWindow,
    32768,
    'a full (non-additive) init restricts the advertised catalog to the recipe and does not touch unrelated external metadata'
  );
});
