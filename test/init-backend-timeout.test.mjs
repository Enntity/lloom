import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveUserConfig } from '../src/init.mjs';

function recipe() {
  return {
    schemaVersion: 1,
    id: 'synthetic-qwen-timeout',
    version: 1,
    name: 'Synthetic Qwen timeout',
    backend: { id: 'mlx-lm' },
    models: [
      {
        role: 'default',
        model: 'synthetic/qwen',
        gatewayModel: 'synthetic/qwen',
        runtime: 'qwen-runtime',
        capabilities: ['chat'],
        settings: {
          timeoutMs: 3_600_000,
          contextWindow: 131_072
        }
      }
    ]
  };
}

function config({ unrelatedModel = false, unrelatedRuntime = false } = {}) {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    providers: { 'local-llm': { baseUrl: 'http://127.0.0.1:8100/v1' } },
    defaults: { chatModel: 'synthetic/qwen' },
    backends: {
      'managed-qwen': {
        type: 'openai',
        baseUrl: 'http://127.0.0.1:8235/v1',
        apiKey: 'preserve-me',
        timeoutMs: 1_800_000,
        headers: { 'x-preserve': 'yes' }
      }
    },
    runtimes: {
      'qwen-runtime': {
        enabled: true,
        port: 8235,
        recipe: { id: 'synthetic-qwen-timeout', version: 1 },
        backend: 'managed-qwen'
      },
      ...(unrelatedRuntime
        ? {
            'other-runtime': {
              enabled: true,
              port: 8236,
              recipe: { id: 'other-recipe', version: 1 },
              backend: 'managed-qwen'
            }
          }
        : {})
    },
    models: [
      {
        id: 'synthetic/qwen',
        name: 'Synthetic Qwen',
        backend: 'managed-qwen',
        runtime: 'qwen-runtime',
        advertise: true
      },
      ...(unrelatedModel
        ? [
            {
              id: 'other/model',
              name: 'Other model',
              backend: 'managed-qwen',
              runtime: 'other-runtime',
              advertise: true
            }
          ]
        : [])
    ],
    aliases: {},
    clientCatalog: { modelOrder: ['synthetic/qwen'] }
  };
}

function derive(input) {
  return deriveUserConfig(input, recipe(), {
    modelRoot: '/models',
    sessionCacheRoot: '/session-cache'
  });
}

test('refreshes an existing recipe-owned backend timeout without replacing its contract', () => {
  const before = config();
  const derived = derive(before);

  assert.equal(derived.backends['managed-qwen'].timeoutMs, 3_600_000);
  assert.equal(derived.backends['managed-qwen'].baseUrl, before.backends['managed-qwen'].baseUrl);
  assert.equal(derived.backends['managed-qwen'].apiKey, before.backends['managed-qwen'].apiKey);
  assert.deepEqual(derived.backends['managed-qwen'].headers, before.backends['managed-qwen'].headers);
});

test('leaves a backend timeout unchanged when another model or runtime shares it', () => {
  for (const options of [{ unrelatedModel: true }, { unrelatedRuntime: true }]) {
    const derived = derive(config(options));
    assert.equal(
      derived.backends['managed-qwen'].timeoutMs,
      1_800_000,
      `shared backend must remain unchanged for ${JSON.stringify(options)}`
    );
  }
});

test('does not invent a timeout when the recipe omits timeoutMs', () => {
  const noTimeoutRecipe = recipe();
  delete noTimeoutRecipe.models[0].settings.timeoutMs;
  const derived = deriveUserConfig(config(), noTimeoutRecipe, {
    modelRoot: '/models',
    sessionCacheRoot: '/session-cache'
  });
  assert.equal(derived.backends['managed-qwen'].timeoutMs, 1_800_000);
});
