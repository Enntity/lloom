import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/registry.mjs';
import { createLloomServer } from '../src/server.mjs';
import { RuntimeManager, reconfigureRuntimeIds } from '../src/runtime-manager.mjs';
import { applyRuntimePolicyPlan } from '../src/runtime-policy.mjs';
import { maintenanceBlocksRouting, assertMaintenanceStartAllowed } from '../src/model-maintenance.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-maintenance-http-'));
  const held = deferred();
  const entered = deferred();
  const draining = deferred();
  const admitting = deferred();
  const load = deferred();
  const events = [];
  const backend = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (body.messages?.[0]?.content === 'hold') {
      entered.resolve();
      await held.promise;
    }
    const content = body.model;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`
      );
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'synthetic',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        })
      );
    }
  });
  const baseUrl = await listen(backend);
  const raw = {
    server: { host: '127.0.0.1', port: 0 },
    security: { apiKeys: ['synthetic-inference'], adminApiKeys: ['synthetic-admin'] },
    logging: { metricsPersistence: false },
    runtimePolicy: { enabled: false },
    backends: { test: { type: 'openai', baseUrl: `${baseUrl}/v1` } },
    runtimes: { resident: { enabled: true, keepWarm: true, maxConcurrency: 2 } },
    models: [
      { id: 'local', backend: 'test', runtime: 'resident', upstreamModel: 'local' },
      { id: 'cloud', backend: 'test', upstreamModel: 'cloud' }
    ],
    aliases: { stable: { members: ['local', 'cloud'], strategy: 'ordered' }, nested: { members: ['stable'] } }
  };
  const sourcePath = path.join(dir, 'config.json');
  await fs.writeFile(sourcePath, JSON.stringify(raw));
  const config = await loadConfig(sourcePath);
  const manager = new RuntimeManager(config, { logger: { info() {}, warn() {}, error() {} } });
  let healthy = true;
  manager.status = async () => ({
    runtimes: {
      resident: {
        status: healthy ? 'running' : 'stopped',
        healthy,
        activeRequests: manager.stateFor('resident').activeRequests
      }
    }
  });
  const controls = { failDrain: false, failLoad: false, delayLoad: false };
  manager.isHealthy = async () => healthy;
  manager.runtimeAppearsLoaded = async () => healthy;
  manager.ensure = async (id) => {
    assertMaintenanceStartAllowed(manager.config, id);
  };
  manager.stop = async (id) => {
    assert.equal(manager.stateFor(id).activeRequests, 0);
    events.push('stop');
    healthy = false;
    manager.setStatus(id, 'stopped');
  };
  const drain = manager.drainRuntime.bind(manager);
  manager.drainRuntime = async (id, opts) => {
    events.push('drain');
    draining.resolve();
    if (controls.failDrain) throw new Error('synthetic drain timeout');
    await drain(id, opts);
  };
  manager.admit = async (id, opts) => {
    assert.equal(opts.force, false);
    assert.equal(opts.warmup, true);
    assert.equal(maintenanceBlocksRouting(manager.config, id), true);
    events.push('admit');
    admitting.resolve();
    if (controls.delayLoad) await load.promise;
    if (controls.failLoad) throw new Error('synthetic load failure');
    healthy = true;
  };
  const app = createLloomServer(config, { runtimeManager: manager, logger: { info() {}, warn() {}, error() {} } });
  const url = await listen(app.server);
  raw.server.port = Number(new URL(url).port);
  await fs.writeFile(sourcePath, JSON.stringify(raw));
  t.after(async () => {
    held.resolve();
    load.resolve();
    await app.close({ stopRuntimes: false, httpGraceMs: 100 });
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const post = async (route, body, key = 'synthetic-admin') => {
    const response = await fetch(url + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    return { status: response.status, text: await response.text() };
  };
  const operation = (action, opts = {}, id = 'stable', key) =>
    post(`/gateway/models/${id}/${action}`, { apply: true, yes: true, ...opts }, key);
  const request = (model = 'nested', content = 'hello', stream = false) =>
    post('/v1/chat/completions', { model, stream, messages: [{ role: 'user', content }] }, 'synthetic-inference');
  return {
    config,
    manager,
    sourcePath,
    raw,
    controls,
    events,
    held,
    entered,
    draining,
    admitting,
    load,
    operation,
    request
  };
}

test(
  'HTTP suspension drains existing work, hot-fails over, and restores only after health',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    assert.match((await f.request()).text, /"content":"local"/);
    const held = f.request('nested', 'hold');
    await f.entered.promise;
    const suspended = f.operation('suspend');
    await f.draining.promise;
    assert.equal(f.events.includes('stop'), false);
    assert.match((await f.request()).text, /"content":"cloud"/);
    assert.match((await f.request('stable', 'hello', true)).text, /cloud/);
    assert.equal((await f.request('local')).status, 404);
    f.held.resolve();
    assert.match((await held).text, /"content":"local"/);
    const result = await suspended;
    assert.equal(result.status, 200, result.text);
    assert.equal(f.events.includes('stop'), true);
    const persisted = await loadConfig(f.sourcePath);
    assert.equal(createRegistry(persisted).resolve('stable').model.id, 'cloud');
    const restarted = new RuntimeManager(persisted);
    assert.deepEqual(restarted.keepWarmRuntimeIds(), []);
    await assert.rejects(restarted.start('resident', { force: true }), /maintenance/);
    f.controls.delayLoad = true;
    const resumed = f.operation('resume');
    await f.admitting.promise;
    assert.match((await f.request()).text, /"content":"cloud"/);
    f.load.resolve();
    const ready = await resumed;
    assert.equal(ready.status, 200, ready.text);
    assert.match((await f.request()).text, /"content":"local"/);
    const after = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
    assert.deepEqual(after, f.raw);
  }
);

test('failed drain never stops; failed resume keeps fallback and permits retry', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.controls.failDrain = true;
  assert.equal((await f.operation('suspend')).status, 500);
  assert.equal(f.events.includes('stop'), false);
  assert.match((await f.request()).text, /cloud/);
  f.controls.failDrain = false;
  assert.equal((await f.operation('suspend')).status, 200);
  f.controls.failLoad = true;
  assert.equal((await f.operation('resume')).status, 500);
  assert.equal((await loadConfig(f.sourcePath)).runtimes.resident.maintenance.state, 'suspended');
  assert.match((await f.request()).text, /cloud/);
  f.controls.failLoad = false;
  assert.equal((await f.operation('resume')).status, 200);
});

test('admin authorization and dry run are mutation-free', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.operation('suspend', {}, 'stable', 'synthetic-inference')).status, 401);
  assert.equal((await f.operation('suspend', { apply: false })).status, 200);
  assert.notEqual((await f.operation('suspend', { yes: false })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(f.sourcePath, 'utf8')), f.raw);
  assert.deepEqual(f.events, []);
});

test('maintenance reload never restarts; stale calls and forced admission cannot bypass suspension', async () => {
  const base = { runtimes: { r: { enabled: true, keepWarm: true } } };
  const next = structuredClone(base);
  next.runtimes.r.maintenance = { state: 'suspended', requestedModel: 'model', since: 'now', operationId: 'test' };
  assert.deepEqual(reconfigureRuntimeIds(base, next), []);
  const manager = new RuntimeManager(next);
  assert.throws(() => manager.acquireSlot('r'), /maintenance/);
  assert.equal(manager.canAdmitRequest('r', 'standard'), false);
  await assert.rejects(manager.start('r', { force: true }), /maintenance/);
  await assert.rejects(manager.startUnlocked('r', { force: true }), /maintenance/);
  await assert.rejects(manager.admit('r', { force: true }), /maintenance/);
  await assert.rejects(
    applyRuntimePolicyPlan(next, manager, { requestedRuntimeId: 'r', dryRun: false, yes: true, force: true }),
    /maintenance/
  );
});

test('CLI paired commands reach the owner gateway and report failure detail', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/lloom.mjs', import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args, '--config', f.sourcePath, '--json']);
  const dry = JSON.parse((await run('suspend', 'stable')).stdout);
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.runtimeIds, ['resident']);
  assert.equal(JSON.parse((await run('suspend', 'stable', '--apply', '--yes')).stdout).status, 'suspended');
  assert.match((await f.request()).text, /cloud/);
  assert.equal(JSON.parse((await run('resume', 'stable', '--apply', '--yes')).stdout).status, 'ready');
  await assert.rejects(run('suspend', 'stable', '--apply'), (error) => {
    assert.match(error.stderr, /yes/);
    return true;
  });
});

test('remote unload confirmation rejects unreachable or ambiguous peers', async () => {
  const config = {
    cluster: { nodeId: 'owner', leaderNode: 'owner' },
    runtimes: { peer: { enabled: true, placement: { node: 'worker' } } }
  };
  let response = { reachable: false };
  const clusterCoordinator = {
    attachRuntimeManager() {},
    isLocalNode: () => false,
    async nodeStatus(_id, options) {
      assert.equal(options.refresh, true);
      return response;
    }
  };
  const manager = new RuntimeManager(config, { clusterCoordinator });
  await assert.rejects(manager.runtimeAppearsLoaded('peer', { requireConfirmation: true }), /cannot confirm/);
  response = { reachable: true, runtimeManager: { runtimes: { peer: { healthy: false, status: 'stopped' } } } };
  assert.equal(await manager.runtimeAppearsLoaded('peer', { requireConfirmation: true }), false);
  response.runtimeManager.runtimes.peer.status = 'exited';
  response.runtimeManager.runtimes.peer.container = { exists: true, running: false };
  assert.equal(await manager.runtimeAppearsLoaded('peer', { requireConfirmation: true }), false);
  response.runtimeManager.runtimes.peer.container = { exists: false, error: 'Cannot connect to the Docker daemon' };
  await assert.rejects(manager.runtimeAppearsLoaded('peer', { requireConfirmation: true }), /cannot inspect/);
  delete response.runtimeManager.runtimes.peer.container;
  response.runtimeManager.runtimes.peer.status = 'unknown';
  assert.equal(await manager.runtimeAppearsLoaded('peer', { requireConfirmation: true }), true);
});
