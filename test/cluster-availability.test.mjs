import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClusterCoordinator } from '../src/cluster.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createLloomServer } from '../src/server.mjs';

const logger = { error() {}, warn() {} };

// Bind a synthetic loopback server and register its teardown on the test the
// moment the listener exists. Registering cleanup right after `listen` (rather
// than after a successful boot) guarantees a setup failure still closes the
// listener instead of leaking it into later tests.
async function listen(server, t, cleanup = true) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (cleanup)
    t.after(async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    });
  return `http://127.0.0.1:${server.address().port}`;
}

// A synthetic distributed head serving endpoint. It answers the logical health
// probe and a real chat completion so the gateway path below exercises actual
// HTTP inference rather than a stubbed runtime.
function createHeadServing() {
  const state = { healthy: true, chatHits: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (!state.healthy) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'serving endpoint unhealthy' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'chat', object: 'model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        state.chatHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fixture-distributed',
            object: 'chat.completion',
            model: 'chat',
            choices: [{ index: 0, message: { role: 'assistant', content: 'distributed reply' }, finish_reason: 'stop' }]
          })
        );
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, state };
}

// A synthetic member control gateway. It answers the coordinator's node status
// probe at `/gateway/node`, so a real ClusterCoordinator observes worker control
// reachability through real HTTP rather than a mocked coordinator.
function createWorkerControl() {
  const state = { reachable: true, statusHits: 0 };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/gateway/node')) {
      state.statusHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          node: {
            id: 'worker',
            reachable: true,
            runtimeManager: { runtimes: { worker: { healthy: true, status: 'running' } } }
          }
        })
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, state };
}

function distributedConfig({ headUrl, workerUrl }) {
  return {
    name: 'cluster-availability',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['fixture-key'] },
    logging: { metricsPersistence: false },
    defaults: { chatModel: 'chat' },
    cluster: {
      nodeId: 'leader',
      leaderNode: 'leader',
      statusCacheMs: 0,
      nodes: { leader: {}, worker: { endpoint: workerUrl } }
    },
    backends: { head: { type: 'openai', baseUrl: `${headUrl}/v1`, apiKey: 'head-fixture-key' } },
    models: [{ id: 'chat', kind: 'chat', backend: 'head', runtime: 'split', upstreamModel: 'chat' }],
    runtimes: {
      head: {
        enabled: true,
        management: 'external',
        node: 'leader',
        healthUrl: `${headUrl}/v1/models`,
        healthModel: 'chat'
      },
      worker: { enabled: true, management: 'external', node: 'worker' },
      split: {
        enabled: true,
        management: 'external',
        healthUrl: `${headUrl}/v1/models`,
        healthModel: 'chat',
        placement: {
          mode: 'distributed',
          members: [
            { node: 'leader', runtime: 'head', role: 'head', order: 20 },
            { node: 'worker', runtime: 'worker', role: 'worker', order: 10 }
          ]
        }
      }
    }
  };
}

async function boot(t) {
  const head = createHeadServing();
  const headUrl = await listen(head.server, t);
  const workerControl = createWorkerControl();
  const workerUrl = await listen(workerControl.server, t);

  const config = distributedConfig({ headUrl, workerUrl });
  const coordinator = new ClusterCoordinator(config, { env: { LLOOM_NODE_ID: 'leader' }, logger });
  const manager = new RuntimeManager(config, { logger, clusterCoordinator: coordinator });
  const app = createLloomServer(config, { runtimeManager: manager, clusterCoordinator: coordinator, logger });
  const gatewayUrl = await listen(app.server, t, false);
  t.after(async () => {
    await app.close({ stopRuntimes: false });
  });
  return { app, manager, coordinator, head, headUrl, workerControl, workerUrl, gatewayUrl };
}

function infer(gatewayUrl) {
  return fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer fixture-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'are you serving?' }] })
  });
}

test('distributed inference survives member control-gateway disconnect', { timeout: 10000 }, async (t) => {
  const f = await boot(t);

  // Prime a real successful inference so lifecycle counters reflect steady state.
  const warm = await infer(f.gatewayUrl);
  assert.equal(warm.status, 200, 'distributed inference serves through the gateway');
  assert.equal((await warm.json()).model, 'chat');

  const startsBefore = f.manager.stateFor('split').starts;
  const stopsBefore = f.manager.stateFor('split').stops;
  const headStartsBefore = f.manager.stateFor('head').starts;
  const workerStartsBefore = f.manager.stateFor('worker').starts;

  // Disconnect only the worker's LLooM control gateway; the head serving
  // endpoint stays up. The real coordinator's node status probe now fails.
  await new Promise((resolve) => f.workerControl.server.close(resolve));
  f.workerControl.server.closeAllConnections?.();

  const during = await infer(f.gatewayUrl);
  assert.equal(during.status, 200, 'inference keeps serving while a member control gateway is down');
  assert.equal((await during.json()).model, 'chat');
  assert.equal(f.head.state.chatHits, 2, 'the head serving endpoint handled both inference requests');

  // No member lifecycle work is re-entered for an already-serving aggregate.
  assert.equal(f.manager.stateFor('split').starts, startsBefore, 'aggregate start count unchanged');
  assert.equal(f.manager.stateFor('split').stops, stopsBefore, 'aggregate stop count unchanged');
  assert.equal(f.manager.stateFor('head').starts, headStartsBefore, 'head member start count unchanged');
  assert.equal(f.manager.stateFor('worker').starts, workerStartsBefore, 'worker member start count unchanged');

  // Telemetry reports serving health separately from control availability.
  const status = await f.manager.status();
  const split = status.runtimes.split;
  assert.equal(split.servingHealthy, true, 'serving health follows the logical endpoint');
  assert.equal(split.controlHealthy, false, 'control health reflects the unreachable member gateway');
  assert.equal(split.availabilityState, 'management-degraded', 'serving runtime is degraded, not unavailable');
  assert.equal(split.healthy, true, 'the runtime is not called unavailable');
  assert.equal(split.status, 'running');
});

test('unhealthy logical distributed endpoint fails closed for health and requests', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  const warm = await infer(f.gatewayUrl);
  assert.equal(warm.status, 200);

  // The logical endpoint becomes unhealthy even though members are alive.
  f.head.state.healthy = false;
  assert.equal(await f.manager.isHealthy('split'), false, 'unhealthy logical endpoint is not called healthy');

  const status = await f.manager.status();
  assert.equal(status.runtimes.split.servingHealthy, false);
  assert.equal(status.runtimes.split.availabilityState, 'unavailable');
  assert.equal(status.runtimes.split.healthy, false);

  await new Promise((resolve) => f.workerControl.server.close(resolve));
  const failed = await infer(f.gatewayUrl);
  assert.equal(failed.status, 503);
  assert.equal(f.head.state.chatHits, 1, 'unhealthy logical endpoint receives no further inference');
  await failed.text();
});

test('control-plane errors deny lifecycle mutation and fail closed', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  await new Promise((resolve) => f.workerControl.server.close(resolve));
  f.workerControl.server.closeAllConnections?.();

  await assert.rejects(
    f.manager.start('split', { force: true, warmup: false, requestedBy: 'leader' }),
    (error) => error.code === 'RUNTIME_CONTROL_UNAVAILABLE',
    'an unreachable member control gateway blocks distributed lifecycle start'
  );
  await assert.rejects(
    f.manager.stop('split', { requestedBy: 'leader' }),
    (error) => error.code === 'RUNTIME_CONTROL_UNAVAILABLE'
  );
  const next = structuredClone(f.manager.config);
  next.runtimes.split.healthModel = 'changed';
  await assert.rejects(f.manager.reconfigure(next), (error) => error.code === 'RUNTIME_CONTROL_UNAVAILABLE');
  assert.notEqual(f.manager.config, next, 'failed reconfiguration preserves the previous snapshot');
  assert.equal(f.manager.stateFor('split').starts, 0);
  assert.equal(f.manager.stateFor('head').stops, 0);
  assert.equal((await f.manager.start('split', { warmup: false })).reason, 'already-healthy');

  const status = await f.manager.status();
  assert.equal(status.runtimes.split.controlHealthy, false, 'control error surfaces as degraded control health');
  // The head endpoint still serves, so the aggregate is not called unavailable.
  assert.notEqual(status.runtimes.split.availabilityState, 'unavailable');
});

test('member telemetry reconciles after the control gateway returns', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  const workerPort = new URL(f.workerUrl).port;

  await new Promise((resolve) => f.workerControl.server.close(resolve));
  f.workerControl.server.closeAllConnections?.();
  const degraded = await f.manager.status();
  assert.equal(degraded.runtimes.split.controlHealthy, false, 'unreachable worker degrades control health');
  assert.equal(degraded.runtimes.split.availabilityState, 'management-degraded');

  // Bring the same worker control gateway back on the same endpoint.
  const restarted = createWorkerControl();
  await new Promise((resolve) => restarted.server.listen(Number(workerPort), '127.0.0.1', resolve));
  t.after(async () => {
    restarted.server.closeAllConnections?.();
    await new Promise((resolve) => restarted.server.close(resolve));
  });
  f.workerControl.server = restarted.server;

  const recovered = await f.manager.status();
  assert.equal(recovered.runtimes.split.controlHealthy, true, 'member control health reconciles');
  assert.equal(recovered.runtimes.split.availabilityState, 'healthy', 'aggregate returns to healthy');
  assert.equal(recovered.runtimes.split.servingHealthy, true);
});

test('endpoint-free legacy groups retain member health aggregation', async (t) => {
  const f = await boot(t);
  delete f.manager.config.runtimes.split.healthUrl;
  assert.equal(await f.manager.isHealthy('split'), true);
  await new Promise((resolve) => f.workerControl.server.close(resolve));
  assert.equal(await f.manager.isHealthy('split'), false);
});

test('logical HTTP health is authoritative even with container health strategy', async (t) => {
  const f = await boot(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-logical-health-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(dir, 'docker'),
    `#!/bin/sh
printf '%s\\n' '{"State":{"Running":true,"Status":"running"}}'
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
  Object.assign(f.manager.config.runtimes.split, {
    adapter: 'docker',
    containerName: 'logical-fixture',
    healthStrategy: 'container'
  });
  f.head.state.healthy = false;
  assert.equal(await f.manager.isHealthy('split'), false);
  assert.equal((await f.manager.status()).runtimes.split.servingHealthy, false);
  assert.equal((await f.coordinator.runtimeReadiness('split')).servingHealthy, false);
});

test('coupled control endpoint and runtime edits fail before lifecycle changes', async (t) => {
  const f = await boot(t);
  const next = structuredClone(f.manager.config);
  next.cluster.nodes.worker.endpoint = 'http://127.0.0.1:1';
  next.runtimes.split.healthModel = 'new-model';
  await assert.rejects(f.manager.reconfigure(next), { code: 'RUNTIME_CONTROL_TOPOLOGY_CHANGED' });
  assert.equal(f.workerControl.state.statusHits, 0);
  assert.equal(f.manager.stateFor('head').stops, 0);
  assert.equal(f.manager.stateFor('worker').stops, 0);
  assert.notEqual(f.manager.config, next);
});
