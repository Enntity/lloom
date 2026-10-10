import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { buildClientIntegrationManifest, validateClientIntegrationManifest } from '../src/client-integrations.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createLloomServer } from '../src/server.mjs';
import {
  assertStandbyConfig,
  collectStandbyConfigErrors,
  standbyEndpointGate,
  standbyGatewayStatus
} from '../src/standby.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function standbyConfig(port) {
  return {
    name: 'standby-fixture',
    server: { host: '127.0.0.1', port: 0, role: 'standby' },
    security: { apiKeys: ['standby-inference-key'], adminApiKeys: ['standby-admin-key'] },
    defaults: { chatModel: 'standby-chat' },
    backends: {
      serving: {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        healthUrl: `http://127.0.0.1:${port}/health`
      }
    },
    models: [{ id: 'standby-chat', kind: 'chat', backend: 'serving', upstreamModel: 'provider/model' }],
    runtimes: {}
  };
}

test('standby config rejects unknown roles and accepts bracketed private IPv6 endpoints', () => {
  assert.deepEqual(collectStandbyConfigErrors({ server: { role: 'mystery' } }), [
    'server.role must be either primary or standby'
  ]);
  assert.throws(() => assertStandbyConfig({ server: { role: 'mystery' } }), /server\.role/);

  const config = {
    server: { role: 'standby' },
    backends: {
      serving: {
        type: 'openai',
        baseUrl: 'http://[fd00::1]:8201/v1',
        healthUrl: 'http://[fd00::1]:8201/health'
      }
    },
    models: [{ id: 'chat', kind: 'chat', backend: 'serving', upstreamModel: 'provider/model' }]
  };
  assert.deepEqual(collectStandbyConfigErrors(config), []);
  assert.deepEqual(
    collectStandbyConfigErrors({
      ...config,
      backends: {
        serving: {
          ...config.backends.serving,
          baseUrl: 'http://[fe80::1]:8201/v1',
          healthUrl: 'http://[fe80::1]:8201/health'
        }
      }
    }),
    []
  );
  assert.match(
    collectStandbyConfigErrors({
      ...config,
      backends: {
        serving: {
          ...config.backends.serving,
          audioProvider: 'openrouter'
        }
      }
    }).join('\n'),
    /must use its private OpenAI-compatible endpoint directly/
  );
  assert.deepEqual(
    collectStandbyConfigErrors({
      ...config,
      backends: {
        serving: {
          ...config.backends.serving,
          baseUrl: 'http://100.100.0.1:8201/v1',
          healthUrl: 'http://100.100.0.1:8201/health'
        }
      }
    }),
    []
  );
  assert.match(
    collectStandbyConfigErrors({
      ...config,
      backends: {
        serving: {
          ...config.backends.serving,
          baseUrl: 'http://[2001:db8::1]:8201/v1'
        }
      }
    }).join('\n'),
    /must be loopback or private/
  );
});

test('standby endpoint checks are health-first, bounded, exact, and do not follow redirects', async (t) => {
  let mode = 'redirect';
  let modelsHits = 0;
  let healthAuthorization;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/health' });
      res.end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.url === '/v1/models') {
      modelsHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'huge') {
        res.end(JSON.stringify({ data: [{ id: 'x' }], padding: 'x'.repeat(70 * 1024) }));
      } else {
        res.end(JSON.stringify({ data: [{ id: mode === 'match' ? 'provider/model' : 'other/model' }] }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(upstream);
  const unrelatedHealth = http.createServer((_req, res) => {
    healthAuthorization = _req.headers.authorization;
    res.writeHead(200);
    res.end('ok');
  });
  const unrelatedHealthPort = await listen(unrelatedHealth);
  t.after(async () => {
    await close(upstream);
    await close(unrelatedHealth);
  });
  const config = standbyConfig(port);
  config.backends.serving.apiKey = 'standby-upstream-secret';
  config.backends.serving.healthUrl = `http://127.0.0.1:${port}/redirect`;
  const resolved = { model: config.models[0], backend: config.backends.serving };

  const redirectGate = await standbyEndpointGate(config, resolved, { timeoutMs: 500 });
  assert.equal(redirectGate.status, 503);
  assert.equal(modelsHits, 0, 'model identity must not be queried after a failed health check');

  config.backends.serving.healthUrl = `http://127.0.0.1:${unrelatedHealthPort}/health`;
  mode = 'mismatch';
  const unrelatedHealthGate = await standbyEndpointGate(config, resolved, { timeoutMs: 500 });
  assert.equal(unrelatedHealthGate.body.error.code, 'standby_model_mismatch');
  assert.equal(healthAuthorization, undefined, 'health probes must not leak backend credentials cross-origin');

  config.backends.serving.healthUrl = `http://127.0.0.1:${port}/health`;
  mode = 'mismatch';
  const mismatchGate = await standbyEndpointGate(config, resolved, { timeoutMs: 500 });
  assert.equal(mismatchGate.body.error.code, 'standby_model_mismatch');
  assert.equal(standbyGatewayStatus(config).inferenceReady, false);

  mode = 'huge';
  const hugeGate = await standbyEndpointGate(config, resolved, { timeoutMs: 500 });
  assert.equal(hugeGate.status, 503);
  assert.match(hugeGate.body.error.message, /safety limit/);

  mode = 'match';
  assert.equal(await standbyEndpointGate(config, resolved, { timeoutMs: 500 }), null);
  const readyStatus = standbyGatewayStatus(config);
  assert.equal(readyStatus.inferenceReady, true);
  assert.match(readyStatus.lastProbeAt, /^20\d\d-/);

  const missingCredentialConfig = structuredClone(config);
  missingCredentialConfig.backends.serving.apiKey = undefined;
  missingCredentialConfig.backends.serving.apiKeyEnv = 'STANDBY_TEST_MISSING_KEY';
  const missingCredential = await standbyEndpointGate(
    missingCredentialConfig,
    { model: missingCredentialConfig.models[0], backend: missingCredentialConfig.backends.serving },
    { timeoutMs: 500, env: {} }
  );
  assert.equal(missingCredential.body.error.code, 'standby_backend_unavailable');
});

test('standby proxies authenticated text and streaming inference while denying writes and lifecycle startup', async (t) => {
  let modelMode = 'match';
  let inferenceMode = 'normal';
  let inferenceHits = 0;
  let redirectedInferenceHits = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: modelMode === 'match' ? 'provider/model' : 'other/model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      inferenceHits += 1;
      if (inferenceMode === 'redirect') {
        res.writeHead(302, { location: '/v1/redirected' });
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        setTimeout(() => res.end('data: [DONE]\n\n'), 40);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'standby-response', choices: [{ message: { content: 'ok' } }] }));
      }
      return;
    }
    if (req.url === '/v1/redirected') {
      redirectedInferenceHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'redirected' } }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const primary = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('primary');
  });
  await listen(primary);
  const config = standbyConfig(upstreamPort);
  const manager = new RuntimeManager(config, { logger: { error() {}, warn() {} } });
  const app = createLloomServer(config, { runtimeManager: manager, logger: { error() {}, warn() {} } });
  assert.throws(() => {
    config.server.role = 'primary';
  }, TypeError);
  const gatewayPort = await listen(app.server);
  t.after(async () => {
    await app.close({ stopRuntimes: false, httpGraceMs: 25 });
    await close(upstream);
    await close(primary);
  });

  const statusBefore = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/status`, {
    headers: { authorization: 'Bearer standby-admin-key' }
  });
  assert.equal(statusBefore.status, 200);
  assert.equal((await statusBefore.json()).gateway.inferenceReady, false);

  const unauthenticatedWrite = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/runtimes/nope/stop`, {
    method: 'POST'
  });
  assert.equal(unauthenticatedWrite.status, 401);
  const authenticatedWrite = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/runtimes/nope/stop`, {
    method: 'POST',
    headers: { authorization: 'Bearer standby-admin-key' }
  });
  assert.equal(authenticatedWrite.status, 403);
  assert.equal((await authenticatedWrite.json()).error.code, 'standby_read_only');

  const unauthenticatedInference = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'standby-chat', messages: [{ role: 'user', content: 'must authenticate' }] })
  });
  assert.equal(unauthenticatedInference.status, 401);

  const blockedWeb = await fetch(`http://127.0.0.1:${gatewayPort}/v1/web/search`, {
    method: 'POST',
    headers: { authorization: 'Bearer standby-inference-key', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'must remain local' })
  });
  assert.equal(blockedWeb.status, 503);
  assert.equal((await blockedWeb.json()).error.code, 'standby_endpoint_unsupported');

  const blockedCommunity = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/community/recommendations`, {
    headers: { authorization: 'Bearer standby-admin-key' }
  });
  assert.equal(blockedCommunity.status, 503);
  assert.equal((await blockedCommunity.json()).error.code, 'standby_endpoint_unsupported');

  modelMode = 'mismatch';
  const beforeMismatch = inferenceHits;
  const mismatch = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer standby-inference-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'standby-chat', messages: [{ role: 'user', content: 'nope' }] })
  });
  assert.equal(mismatch.status, 503);
  assert.equal(inferenceHits, beforeMismatch, 'model mismatch must fail before inference POST');

  modelMode = 'match';
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer standby-inference-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'standby-chat', messages: [{ role: 'user', content: 'hello' }] })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'ok');

  inferenceMode = 'redirect';
  const redirectResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer standby-inference-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'standby-chat', messages: [{ role: 'user', content: 'no redirect' }] })
  });
  assert.notEqual(redirectResponse.status, 200);
  await redirectResponse.arrayBuffer();
  assert.equal(redirectedInferenceHits, 0, 'standby inference must reject redirects');
  inferenceMode = 'normal';

  const statusReady = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/status`, {
    headers: { authorization: 'Bearer standby-admin-key' }
  });
  assert.equal((await statusReady.json()).gateway.inferenceReady, true);

  const streamResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer standby-inference-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'standby-chat', stream: true, messages: [{ role: 'user', content: 'stream' }] })
  });
  assert.equal(streamResponse.status, 200);
  await close(primary);
  const streamText = await streamResponse.text();
  assert.match(streamText, /partial/);
  assert.match(streamText, /\[DONE\]/);
});

test('standby runtime manager rejects every lifecycle entry point', async () => {
  const config = { server: { role: 'standby' }, runtimes: {}, models: [], backends: {} };
  const manager = new RuntimeManager(config, { logger: { error() {}, warn() {} } });
  const rejected = { code: 'standby_read_only' };
  await assert.rejects(manager.reconfigure({ ...config }), rejected);
  await assert.rejects(manager.stopUnlocked('runtime'), rejected);
  await assert.rejects(manager.warmupById('runtime'), rejected);
  await assert.rejects(manager.startKeepWarm(), rejected);
  await assert.rejects(manager.stopAll(), rejected);
  assert.throws(() => manager.resumeRuntime('runtime'), rejected);
  assert.throws(() => manager.withAdmissionLock(() => {}), rejected);
  const primary = new RuntimeManager(
    { server: { role: 'primary' }, runtimes: {}, models: [], backends: {} },
    {
      logger: { error() {}, warn() {} }
    }
  );
  await assert.rejects(
    primary.reconfigure({ server: { role: 'standby' }, runtimes: {}, models: [], backends: {} }),
    rejected
  );
});

test('client discovery validates the standby failover contract', () => {
  const model = { id: 'standby-chat', kind: 'chat', capabilities: ['text'], input: ['text'], output: ['text'] };
  const manifest = buildClientIntegrationManifest(
    {
      server: { role: 'standby', host: '127.0.0.1', port: 8110 },
      defaults: { chatModel: model.id },
      models: [model],
      providers: {}
    },
    [model]
  );
  assert.deepEqual(validateClientIntegrationManifest(manifest), []);
  assert.equal(manifest.gateway.failover.streamMigration, false);
  assert.deepEqual(validateClientIntegrationManifest({ ...manifest, gateway: { role: 'standby' } }).length > 0, true);
  assert.deepEqual(
    validateClientIntegrationManifest({
      ...manifest,
      gateway: { ...manifest.gateway, role: 'standby', lifecycleAuthority: 'primary' }
    }).length > 0,
    true
  );
});
