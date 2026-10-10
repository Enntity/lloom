import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createDeploymentFence, DeploymentFenceError, readReleaseIdentity } from '../src/deployment-fence.mjs';
import { createLloomServer } from '../src/server.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createPreferredResidencyReconciler } from '../src/runtime-residency.mjs';

const logger = { error() {}, warn() {}, info() {} };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-deployment-fence-'));
  const sourcePath = path.join(directory, 'config.json');
  await fs.writeFile(sourcePath, '{}\n', { mode: 0o600 });
  return { directory, sourcePath };
}

function requestWithBody(port, pathname, { body, token, method = 'POST', defer = false } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  const request = http.request(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });
  const response = new Promise((resolve, reject) => {
    request.once('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf8') }));
      res.once('error', reject);
    });
    request.once('error', reject);
  });
  if (payload) request.end(payload);
  else if (!defer) request.end();
  return { request, response };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

test('deployment fence drains bodies and streams before preparing', async () => {
  const { directory, sourcePath } = await tempConfig();
  let upstreamTimer;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
      if (!body.stream) {
        res.end(JSON.stringify({ id: 'fence', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        return;
      }
      res.write('data: {"id":"fence","choices":[{"delta":{"content":"ok"}}]}\n\n');
      upstreamTimer = setTimeout(() => res.end('data: [DONE]\n\n'), 150);
    });
  });
  const upstreamPort = await listen(upstream);
  const config = {
    sourcePath,
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['infer'], adminApiKeys: ['admin'] },
    defaults: { chatModel: 'local-model' },
    backends: {
      local: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
      cloud: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKeyEnv: 'FENCE_CLOUD_KEY' }
    },
    models: [
      { id: 'local-model', backend: 'local', upstreamModel: 'local', kind: 'chat' },
      { id: 'cold-model', backend: 'local', upstreamModel: 'cold', runtime: 'cold', kind: 'chat' },
      { id: 'cloud-model', backend: 'cloud', upstreamModel: 'cloud', kind: 'chat' }
    ],
    runtimes: { cold: { enabled: true, command: 'false' } }
  };
  const app = createLloomServer(config, { logger });
  const port = await listen(app.server);
  const operationId = 'fence-body-stream';
  try {
    const slowBody = JSON.stringify({ model: 'local-model', messages: [{ role: 'user', content: 'slow' }] });
    const slow = requestWithBody(port, '/v1/chat/completions', { token: 'infer', defer: true });
    slow.request.setHeader('content-type', 'application/json');
    slow.request.setHeader('content-length', Buffer.byteLength(slowBody));
    slow.request.write(slowBody.slice(0, Math.max(1, Math.floor(slowBody.length / 2))));
    await wait(25);

    let prepared = false;
    const prepare = requestWithBody(port, '/gateway/deployment-fence/prepare', {
      token: 'admin',
      body: { opId: operationId, timeoutMs: 2000 }
    }).response.then((result) => {
      prepared = true;
      return result;
    });
    await wait(40);
    assert.equal(prepared, false, 'prepare must wait for the admitted request body and response');

    slow.request.end(slowBody.slice(Math.max(1, Math.floor(slowBody.length / 2))));
    const slowResult = await slow.response;
    assert.equal(slowResult.res.statusCode, 200);
    const preparedResult = await prepare;
    assert.equal(preparedResult.res.statusCode, 200);
    const preparedBody = JSON.parse(preparedResult.text);
    assert.equal(preparedBody.state, 'prepared');

    const blocked = await requestWithBody(port, '/v1/chat/completions', {
      token: 'infer',
      body: { model: 'local-model', messages: [{ role: 'user', content: 'blocked' }] }
    }).response;
    assert.equal(blocked.res.statusCode, 503);
    assert.equal(JSON.parse(blocked.text).error.code, 'deployment_fenced');

    const status = await requestWithBody(port, '/gateway/deployment-fence/status', { token: 'admin', method: 'GET' })
      .response;
    assert.equal(status.res.statusCode, 200);
    assert.equal(JSON.parse(status.text).state, 'prepared');

    const wrongCanary = await requestWithBody(port, '/gateway/deployment-fence/canary', {
      token: 'infer',
      body: { opId: operationId, request: { model: 'local-model', messages: [{ role: 'user', content: 'x' }] } }
    }).response;
    assert.equal(wrongCanary.res.statusCode, 401);

    const coldCanary = await requestWithBody(port, '/gateway/deployment-fence/canary', {
      token: 'admin',
      body: {
        opId: operationId,
        generation: preparedBody.generation,
        request: { model: 'cold-model', messages: [{ role: 'user', content: 'x' }] }
      }
    }).response;
    assert.equal(coldCanary.res.statusCode, 409);
    assert.equal(JSON.parse(coldCanary.text).error.code, 'deployment_fence_canary_runtime_unhealthy');

    const cloudCanary = await requestWithBody(port, '/gateway/deployment-fence/canary', {
      token: 'admin',
      body: {
        opId: operationId,
        generation: preparedBody.generation,
        request: { model: 'cloud-model', messages: [{ role: 'user', content: 'x' }] }
      }
    }).response;
    assert.equal(cloudCanary.res.statusCode, 409);
    assert.equal(JSON.parse(cloudCanary.text).error.code, 'deployment_fence_canary_target_invalid');

    const release = await requestWithBody(port, '/gateway/deployment-fence/release', {
      token: 'admin',
      body: { opId: operationId, generation: preparedBody.generation }
    }).response;
    assert.equal(release.res.statusCode, 200);
    const releaseRetry = await requestWithBody(port, '/gateway/deployment-fence/release', {
      token: 'admin',
      body: { opId: operationId, generation: preparedBody.generation }
    }).response;
    assert.equal(releaseRetry.res.statusCode, 200);
    assert.equal(JSON.parse(releaseRetry.text).idempotent, true);

    const streamBody = { model: 'local-model', messages: [{ role: 'user', content: 'stream' }], stream: true };
    const stream = requestWithBody(port, '/v1/chat/completions', { token: 'infer', body: streamBody });
    await wait(40);
    let streamPrepareSettled = false;
    const streamPrepare = requestWithBody(port, '/gateway/deployment-fence/prepare', {
      token: 'admin',
      body: { opId: 'fence-stream', timeoutMs: 2000 }
    }).response.then((result) => {
      streamPrepareSettled = true;
      return result;
    });
    await wait(40);
    assert.equal(streamPrepareSettled, false);
    const streamResult = await stream.response;
    assert.equal(streamResult.res.statusCode, 200);
    const streamPreparedResult = await streamPrepare;
    const streamPreparedBody = JSON.parse(streamPreparedResult.text);
    assert.equal(streamPreparedBody.state, 'prepared');
    await requestWithBody(port, '/gateway/deployment-fence/release', {
      token: 'admin',
      body: { opId: 'fence-stream', generation: streamPreparedBody.generation }
    }).response;
  } finally {
    if (upstreamTimer) clearTimeout(upstreamTimer);
    await app.close({ stopRuntimes: false }).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('gateway status is truthful and fenced canary returns observed local attribution', async () => {
  const { directory, sourcePath } = await tempConfig();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'canary', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const config = {
    sourcePath,
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['infer'], adminApiKeys: ['admin'] },
    defaults: { chatModel: 'local-model' },
    backends: { local: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } },
    models: [{ id: 'local-model', backend: 'local', upstreamModel: 'local', runtime: 'hot', kind: 'chat' }],
    runtimes: { hot: { enabled: true, command: 'false' } }
  };
  const app = createLloomServer(config, { logger });
  app.runtimeManager.isHealthy = async (runtimeId) => runtimeId === 'hot';
  app.runtimeManager.withSlot = async (_runtimeId, fn) => fn();
  app.runtimeManager.startKeepWarm = async () => ({ skipped: 'synthetic-test' });
  app.runtimeManager.status = async () => ({
    runtimes: { hot: { status: 'running', healthy: true } },
    events: []
  });
  const port = await listen(app.server);
  const operationId = 'canary-receipt';
  try {
    const openStatus = await requestWithBody(port, '/gateway/deployment-fence/status', {
      token: 'admin',
      method: 'GET'
    }).response;
    const openBody = JSON.parse(openStatus.text);
    assert.equal(openBody.protocol, 1);
    assert.equal(openBody.fenceProtocolVersion, 1);
    assert.equal(openBody.releaseIdentity, null);
    assert.equal(openBody.identity.atomicLayout, false);

    const gatewayStatus = await requestWithBody(port, '/gateway/status', { token: 'admin', method: 'GET' }).response;
    const gatewayBody = JSON.parse(gatewayStatus.text);
    assert.equal(gatewayBody.gatewayProtocol, 1);
    assert.equal(gatewayBody.serviceActive, true);
    assert.equal(gatewayBody.atomicLayout, false);
    assert.equal(gatewayBody.loadedIdentity, null);
    assert.deepEqual(gatewayBody.runtimeSnapshot.runtimes.hot, { status: 'running', healthy: true });

    const prepared = await requestWithBody(port, '/gateway/deployment-fence/prepare', {
      token: 'admin',
      body: { opId: operationId, timeoutMs: 1000 }
    }).response;
    const preparedBody = JSON.parse(prepared.text);
    const canary = await requestWithBody(port, '/gateway/deployment-fence/canary', {
      token: 'admin',
      body: {
        opId: operationId,
        generation: preparedBody.generation,
        request: { model: 'local-model', messages: [{ role: 'user', content: 'synthetic' }], stream: false }
      }
    }).response;
    assert.equal(canary.res.statusCode, 200);
    assert.deepEqual(JSON.parse(canary.text), {
      healthy: true,
      fenced: true,
      privileged: true,
      aliasUsed: false,
      cloudFallback: false,
      source: 'local',
      gatewayModelId: 'local-model',
      runtimeId: 'hot',
      responseStatus: 200,
      responseFinished: true
    });
    await requestWithBody(port, '/gateway/deployment-fence/release', {
      token: 'admin',
      body: { opId: operationId, generation: preparedBody.generation }
    }).response;
  } finally {
    await app.close({ stopRuntimes: false }).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('deployment fence persists, rejects manager mutations, and allows only matching canary scope', async () => {
  const { directory, sourcePath } = await tempConfig();
  const config = {
    sourcePath,
    cluster: { nodeId: 'node-1' },
    runtimes: {},
    server: { host: '127.0.0.1', port: 0 }
  };
  const manager = new RuntimeManager(config, { logger });
  const stuckLifecycle = deferred();
  const lifecycle = manager.withRuntimeLifecycleLock('held-runtime', () => stuckLifecycle.promise);
  await wait(5);
  await assert.rejects(
    () => manager.waitForQuiescence({ timeoutMs: 25 }),
    (error) => error.code === 'RUNTIME_QUIESCENCE_TIMEOUT'
  );
  stuckLifecycle.resolve({ ok: true });
  await lifecycle;
  const fence = createDeploymentFence({
    config,
    configPath: sourcePath,
    runtimeManager: manager,
    packageRoot: directory
  });
  manager.attachDeploymentFence(fence);
  const hookState = { paused: 0, resumed: 0 };
  fence.setHooks({
    pauseResidency: () => hookState.paused++,
    resumeResidency: () => hookState.resumed++
  });
  const held = deferred();
  const admitted = manager.withAdmissionLock(() => held.promise, { runtimeId: 'r1' });
  await wait(10);
  const preparing = fence.prepare({ opId: 'persisted-op', timeoutMs: 1000 });
  assert.equal(fence.status().state, 'draining', 'prepare closes admission before its first sidecar await');
  await assert.rejects(
    () => fence.prepare({ opId: 'different-concurrent-op', timeoutMs: 1000 }),
    (error) => error.code === 'deployment_fence_prepare_in_progress'
  );
  await wait(25);
  assert.equal(fence.status().state, 'draining');
  assert.equal(hookState.paused, 1);
  held.resolve({ ok: true });
  await admitted;
  const prepared = await preparing;
  assert.equal(prepared.state, 'prepared');

  const restarted = createDeploymentFence({
    config,
    configPath: sourcePath,
    runtimeManager: manager,
    packageRoot: directory
  });
  assert.equal(restarted.status().state, 'prepared');
  assert.equal(restarted.status().identity.release.known, false);
  await assert.rejects(
    () => manager.start('missing'),
    (error) => error instanceof DeploymentFenceError
  );
  await assert.rejects(
    () => manager.startUnlocked('missing'),
    (error) => error instanceof DeploymentFenceError
  );
  await assert.rejects(
    () => manager.stopUnlocked('missing'),
    (error) => error instanceof DeploymentFenceError
  );
  await assert.rejects(
    () => manager.reconfigureUnlocked(config),
    (error) => error instanceof DeploymentFenceError
  );
  assert.deepEqual(manager.noteRequestOutcome('missing', { ok: false }), {
    runtimeId: 'missing',
    action: 'observed',
    reason: 'deployment-fenced'
  });
  await assert.rejects(
    () => restarted.runCanary({ opId: 'wrong-op', generation: prepared.generation, run: async () => {} }),
    /matching prepared fence/
  );
  await assert.rejects(
    () =>
      fence.runCanary({
        opId: 'persisted-op',
        generation: prepared.generation,
        run: async () => ({ status: 502, ok: false })
      }),
    (error) => error.code === 'deployment_fence_canary_failed'
  );
  assert.equal(fence.status().state, 'prepared');
  const canaryResult = await fence.runCanary({
    opId: 'persisted-op',
    generation: prepared.generation,
    run: async (context) => {
      assert.equal(fence.isCanaryAuthorized(context), true);
      return { ok: true };
    }
  });
  assert.deepEqual(canaryResult, { ok: true });
  const released = await fence.release({ opId: 'persisted-op', generation: prepared.generation });
  assert.equal(released.released, true);
  assert.equal(fence.status().state, 'open');
  assert.equal(hookState.resumed, 1);

  const reused = await fence.prepare({ opId: 'persisted-op', timeoutMs: 1000 });
  assert.equal(reused.generation, prepared.generation + 1);
  await assert.rejects(
    () => fence.release({ opId: 'persisted-op', generation: prepared.generation }),
    /generation does not match/
  );
  await fence.release({ opId: 'persisted-op', generation: reused.generation });

  const restorePrepared = await fence.prepare({ opId: 'restore-op', timeoutMs: 1000 });
  const sidecarPath = `${sourcePath}.deployment-fence.json`;
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  sidecar.state = 'draining';
  await fs.writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`);
  const restored = createDeploymentFence({
    config,
    configPath: sourcePath,
    runtimeManager: manager,
    packageRoot: directory,
    drainTimeoutMs: 1000
  });
  restored.setHooks({ pauseResidency: () => {}, resumeResidency: () => {} });
  for (let attempt = 0; attempt < 20 && restored.status().state !== 'prepared'; attempt++) await wait(10);
  assert.equal(restored.status().state, 'prepared');
  await restored.release({ opId: 'restore-op', generation: restorePrepared.generation });
  await fs.rm(directory, { recursive: true, force: true });
});

test('residency pauses and manager lifecycle/watchdog guards follow the fence', async () => {
  const config = { runtimes: {}, runtimePolicy: { preferredWarmIntervalMs: 10 } };
  const manager = new RuntimeManager(config, { logger });
  const reconciler = createPreferredResidencyReconciler(manager, { logger, intervalMs: 10 });
  reconciler.start();
  assert.equal(reconciler.paused, false);
  await reconciler.pause();
  assert.equal(reconciler.paused, true);
  reconciler.resume();
  assert.equal(reconciler.paused, false);
  await reconciler.stop();

  const { directory, sourcePath } = await tempConfig();
  const fenceConfig = { ...config, sourcePath };
  const fence = createDeploymentFence({
    config: fenceConfig,
    configPath: sourcePath,
    runtimeManager: manager,
    packageRoot: directory
  });
  manager.attachDeploymentFence(fence);
  await fence.prepare({ opId: 'guard-op', timeoutMs: 1000 });
  await assert.rejects(() => manager.startKeepWarm(), /blocked by deployment fence/);
  await assert.rejects(() => manager.reconfigure(fenceConfig), /blocked by deployment fence/);
  await fence.release({ opId: 'guard-op', generation: 1 });
  await fs.rm(directory, { recursive: true, force: true });
});

test('release identity is known only after installed manifest files verify', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-release-identity-'));
  const packageJson = { name: 'lloom', version: '1.2.3' };
  const source = Buffer.from('installed-byte-fixture\n');
  const packageBytes = Buffer.from(`${JSON.stringify(packageJson)}\n`);
  const sourcePath = path.join(directory, 'src', 'entry.mjs');
  const manifestPath = path.join(directory, 'current.manifest.json');
  try {
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), packageBytes);
    await fs.writeFile(sourcePath, source);
    const manifest = {
      schemaVersion: 1,
      package: packageJson.name,
      version: packageJson.version,
      commit: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
      files: [
        {
          path: 'package.json',
          size: packageBytes.length,
          sha256: createHash('sha256').update(packageBytes).digest('hex')
        },
        { path: 'src/entry.mjs', size: source.length, sha256: createHash('sha256').update(source).digest('hex') }
      ]
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.equal(readReleaseIdentity({ packageRoot: directory, releaseManifestPath: manifestPath }).known, true);
    // Equal-size edits must fail the byte proof, even when every listed path
    // and size remains unchanged.
    await fs.writeFile(sourcePath, Buffer.alloc(source.length, 'x'));
    const tampered = readReleaseIdentity({ packageRoot: directory, releaseManifestPath: manifestPath });
    assert.equal(tampered.known, false);

    const missingHash = {
      ...manifest,
      files: manifest.files.map((entry) => (entry.path === 'src/entry.mjs' ? { ...entry, sha256: undefined } : entry))
    };
    await fs.writeFile(sourcePath, source);
    await fs.writeFile(manifestPath, `${JSON.stringify(missingHash)}\n`);
    assert.equal(readReleaseIdentity({ packageRoot: directory, releaseManifestPath: manifestPath }).known, false);

    const subset = { ...manifest, files: manifest.files.filter((entry) => entry.path !== 'src/entry.mjs') };
    await fs.writeFile(manifestPath, `${JSON.stringify(subset)}\n`);
    assert.equal(readReleaseIdentity({ packageRoot: directory, releaseManifestPath: manifestPath }).known, false);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-release-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'entry.mjs'), source);
      await fs.rm(path.join(directory, 'src'), { recursive: true, force: true });
      await fs.symlink(outside, path.join(directory, 'src'), 'dir');
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      assert.equal(readReleaseIdentity({ packageRoot: directory, releaseManifestPath: manifestPath }).known, false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
