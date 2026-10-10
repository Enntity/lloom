import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function runCli(file, args, options) {
  try {
    return { status: 0, ...(await exec(file, args, options)) };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
import test from 'node:test';
import { ClusterCoordinator, runtimeReadinessScope } from '../src/cluster.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createLloomServer } from '../src/server.mjs';

const logger = { error() {}, warn() {} };
const localTelemetry = { snapshot: async () => ({ memory: { totalBytes: 1024, availableBytes: 768 } }) };

async function listen(server, t, cleanup = true) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (cleanup) {
    t.after(async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    });
  }
  return `http://127.0.0.1:${server.address().port}`;
}

function createServing() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'chat', object: 'model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, hits: 0 };
}

function createControl(nodeId = 'worker') {
  const state = {
    hits: 0,
    offline: false,
    claimedId: nodeId,
    runtimes: { [nodeId]: { healthy: true, status: 'running' } },
    telemetry: { memory: { totalBytes: 2048, availableBytes: 1536 } }
  };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/gateway/node')) {
      state.hits += 1;
      if (state.offline) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'peer offline fixture' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          node: {
            id: state.claimedId,
            reachable: true,
            telemetry: state.telemetry,
            runtimeManager: { runtimes: state.runtimes }
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

function readinessConfig({ headUrl, workerUrl, federationUrl }) {
  return {
    name: 'cluster-readiness',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['fixture-key'] },
    logging: { metricsPersistence: false },
    cluster: {
      nodeId: 'leader',
      leaderNode: 'leader',
      statusCacheMs: 0,
      nodes: {
        leader: {},
        worker: { endpoint: workerUrl },
        federation: { endpoint: federationUrl }
      }
    },
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

async function boot(t, config) {
  const head = createServing();
  const headUrl = await listen(head.server, t);
  const workerControl = createControl('worker');
  const workerUrl = await listen(workerControl.server, t);
  const federationControl = createControl('federation');
  const federationUrl = await listen(federationControl.server, t);
  const next = config
    ? config({ headUrl, workerUrl, federationUrl })
    : readinessConfig({ headUrl, workerUrl, federationUrl });
  const coordinator = new ClusterCoordinator(next, {
    env: { LLOOM_NODE_ID: 'leader' },
    logger,
    telemetry: localTelemetry
  });
  const manager = new RuntimeManager(next, { logger, clusterCoordinator: coordinator });
  const app = createLloomServer(next, { runtimeManager: manager, clusterCoordinator: coordinator, logger });
  const gatewayUrl = await listen(app.server, t, false);
  t.after(async () => {
    await app.close({ stopRuntimes: false });
  });
  return {
    app,
    manager,
    coordinator,
    head,
    headUrl,
    workerControl,
    workerUrl,
    federationControl,
    federationUrl,
    gatewayUrl,
    config: next
  };
}

test('unrelated optional peer is not queried and healthy distributed scope is ready', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  const readiness = await f.coordinator.runtimeReadiness('split');
  assert.deepEqual(readiness.requiredNodes, ['leader', 'worker']);
  assert.equal(readiness.scope, 'distributed-model');
  assert.equal(readiness.servingHealthy, true);
  assert.equal(readiness.controlHealthy, true);
  assert.equal(readiness.readyForServing, true);
  assert.equal(readiness.readyForControl, true);
  assert.equal(readiness.availabilityState, 'healthy');
  assert.deepEqual(readiness.configErrors, []);
  assert.deepEqual(readiness.optionalWarnings, []);
  assert.ok(readiness.nodeEvidence.worker.identity?.verified);
  assert.equal(f.workerControl.state.hits, 1, 'fresh required node evidence is collected');
  assert.equal(f.federationControl.state.hits, 0, 'optional federation peer is not queried by default');

  const local = await f.coordinator.runtimeReadiness('head');
  assert.equal(local.scope, 'distributed-member');
  assert.deepEqual(local.requiredNodes, ['leader', 'worker']);
  assert.equal(local.servingHealthy, true);
});

test(
  'missing required worker blocks control readiness but logical serving remains available',
  { timeout: 10000 },
  async (t) => {
    const f = await boot(t);
    f.workerControl.state.runtimes = {};
    const readiness = await f.coordinator.runtimeReadiness('split');
    assert.equal(readiness.servingHealthy, true);
    assert.equal(readiness.controlHealthy, false);
    assert.equal(readiness.readyForServing, true);
    assert.equal(readiness.readyForControl, false);
    assert.equal(readiness.availabilityState, 'management-degraded');
    assert.ok(readiness.optionalWarnings.some((warning) => warning.code === 'required_member_missing'));
  }
);

test('wrong remote node identity fails closed with additive evidence', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  f.workerControl.state.claimedId = 'federation';
  const readiness = await f.coordinator.runtimeReadiness('split');
  assert.equal(readiness.nodeEvidence.worker.reachable, false);
  assert.equal(readiness.nodeEvidence.worker.identity.mismatch, true);
  assert.equal(readiness.nodeEvidence.worker.identity.configuredId, 'worker');
  assert.equal(readiness.nodeEvidence.worker.identity.claimedId, 'federation');
  assert.equal(readiness.controlHealthy, false);
  assert.equal(readiness.readyForControl, false);
  assert.equal(readiness.servingHealthy, true, 'the logical serving endpoint is independently healthy');
  assert.equal(readiness.availabilityState, 'management-degraded');
  assert.ok(readiness.diagnostics.some((entry) => entry.code === 'node_probe_failed' && entry.nodeId === 'worker'));
});

test(
  'disabled, unknown, ambiguous, and raw replicated scopes fail before any network probe',
  { timeout: 10000 },
  async (t) => {
    const f = await boot(t);
    const config = structuredClone(f.config);
    config.runtimes.disabled = { enabled: false, management: 'external', node: 'worker' };
    config.runtimes.member = { enabled: true, management: 'external', node: 'worker' };
    config.runtimes.groupA = {
      enabled: true,
      placement: { mode: 'distributed', members: [{ node: 'worker', runtime: 'member' }] }
    };
    config.runtimes.groupB = {
      enabled: true,
      placement: { mode: 'distributed', members: [{ node: 'worker', runtime: 'member' }] }
    };
    config.runtimes.rawReplicated = { enabled: true, management: 'external', placement: { mode: 'replicated' } };
    const coordinator = new ClusterCoordinator(config, {
      env: { LLOOM_NODE_ID: 'leader' },
      logger,
      telemetry: localTelemetry
    });

    const cases = ['does-not-exist', 'disabled', 'member', 'rawReplicated'];
    for (const runtimeId of cases) {
      const readiness = await coordinator.runtimeReadiness(runtimeId);
      assert.equal(readiness.scope, 'config-error', runtimeId);
      assert.ok(readiness.configErrors.length > 0, `${runtimeId} has a diagnostic`);
      assert.equal(readiness.availabilityState, 'config-error');
    }
    assert.equal((await coordinator.runtimeReadiness('member')).groupRuntimeId, null);
    const replicated = runtimeReadinessScope('rawReplicated', config, { LLOOM_NODE_ID: 'leader' });
    assert.deepEqual(replicated.requiredNodes, []);
    assert.ok(replicated.configErrors.join(' ').includes('materialized node'));
    assert.equal(f.workerControl.state.hits, 0);
    assert.equal(f.federationControl.state.hits, 0);
  }
);

test('missing memory telemetry is only a capacity warning', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  f.workerControl.state.telemetry = null;
  const readiness = await f.coordinator.runtimeReadiness('split');
  assert.equal(readiness.readyForServing, true);
  assert.equal(readiness.readyForControl, true);
  assert.equal(readiness.availabilityState, 'healthy');
  assert.ok(
    readiness.optionalWarnings.some(
      (warning) => warning.code === 'memory_telemetry_missing' && warning.nodeId === 'worker'
    )
  );
});

test('local, pinned replica, and same-node distributed members resolve minimum scopes', async () => {
  const env = { LLOOM_NODE_ID: 'leader' };
  const config = {
    cluster: { nodeId: 'leader', nodes: { leader: {}, worker: {} } },
    runtimes: {
      local: { enabled: true, management: 'external' },
      pinned: { enabled: true, management: 'external', node: 'worker' },
      replica: { enabled: true, management: 'external', node: 'worker', placement: { mode: 'replicated' } },
      shared: {
        enabled: true,
        placement: {
          mode: 'distributed',
          members: [
            { node: 'worker', runtime: 'memberA', role: 'head' },
            { node: 'worker', runtime: 'memberB', role: 'worker' }
          ]
        }
      },
      memberA: { enabled: true, management: 'external', node: 'worker' },
      memberB: { enabled: true, management: 'external', node: 'worker' }
    }
  };
  assert.deepEqual(runtimeReadinessScope('local', config, env), {
    runtimeId: 'local',
    groupRuntimeId: null,
    scope: 'local',
    requiredNodes: ['leader'],
    members: [{ node: 'leader', runtime: 'local', role: 'runtime', order: 0 }],
    configErrors: [],
    diagnostics: []
  });
  assert.deepEqual(runtimeReadinessScope('pinned', config, env).requiredNodes, ['worker']);
  const replica = runtimeReadinessScope('replica', config, env);
  assert.equal(replica.scope, 'replica');
  assert.deepEqual(replica.requiredNodes, ['worker']);
  assert.equal(replica.groupRuntimeId, null);
  const shared = runtimeReadinessScope('shared', config, env);
  assert.equal(shared.scope, 'distributed-model');
  assert.deepEqual(shared.requiredNodes, ['worker'], 'explicit member nodes are deduplicated');
  const member = runtimeReadinessScope('memberA', config, env);
  assert.equal(member.groupRuntimeId, 'shared');
  assert.equal(member.scope, 'distributed-member');
  assert.deepEqual(member.requiredNodes, ['worker']);
});

test(
  'explicit federation includes optional warnings without failing required readiness',
  { timeout: 10000 },
  async (t) => {
    const f = await boot(t);
    f.federationControl.state.offline = true;
    const readiness = await f.coordinator.runtimeReadiness('split', { includeFederation: true });
    assert.equal(f.workerControl.state.hits, 1);
    assert.ok(f.federationControl.state.hits > 0);
    assert.equal(readiness.readyForServing, true);
    assert.equal(readiness.readyForControl, true);
    assert.equal(readiness.availabilityState, 'healthy');
    assert.ok(
      readiness.optionalWarnings.some(
        (warning) => warning.code === 'optional_peer_offline' && warning.nodeId === 'federation'
      )
    );
  }
);

test(
  'scoped HTTP readiness and doctor share the same JSON contract and auth failure is not masked',
  { timeout: 10000 },
  async (t) => {
    const f = await boot(t);
    const readJson = async (pathname, authorization = 'Bearer fixture-key') => {
      const response = await fetch(`${f.gatewayUrl}${pathname}`, { headers: { authorization } });
      return { status: response.status, body: await response.json() };
    };
    const readiness = await readJson('/gateway/cluster/readiness?runtime=split');
    const doctor = await readJson('/gateway/doctor?runtime=split&includeFederation=1');
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.ok, true);
    assert.equal(readiness.body.runtimeId, 'split');
    assert.equal(readiness.body.scope, 'distributed-model');
    assert.equal(doctor.status, 200);
    assert.deepEqual(doctor.body, { ...readiness.body });
    const unauthorized = await readJson('/gateway/cluster/readiness?runtime=split', 'Bearer wrong-key');
    assert.equal(unauthorized.status, 401);
    assert.ok(unauthorized.body.error?.message);
  }
);

test('CLI scoped doctor and cluster doctor emit gateway JSON', { timeout: 10000 }, async (t) => {
  const f = await boot(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lloom-readiness-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, 'config.json');
  const cliConfig = structuredClone(f.config);
  cliConfig.server.port = f.app.server.address().port;
  fs.writeFileSync(configPath, JSON.stringify(cliConfig));
  const binPath = path.join(process.cwd(), 'bin', 'lloom.mjs');

  const doctor = await runCli(
    process.execPath,
    [binPath, 'doctor', '--runtime', 'split', '--json', '--config', configPath],
    {
      encoding: 'utf8',
      timeout: 8000
    }
  );
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const doctorJson = JSON.parse(doctor.stdout);
  assert.equal(doctorJson.runtimeId, 'split');
  assert.equal(doctorJson.availabilityState, 'healthy');

  const clusterDoctor = await runCli(
    process.execPath,
    [binPath, 'cluster', 'doctor', '--runtime', 'split', '--json', '--config', configPath],
    { encoding: 'utf8', timeout: 8000 }
  );
  assert.equal(clusterDoctor.status, 0, clusterDoctor.stderr || clusterDoctor.stdout);
  assert.equal(JSON.parse(clusterDoctor.stdout).availabilityState, doctorJson.availabilityState);
  assert.equal(f.federationControl.state.hits, 0, 'scoped CLI must not request whole-topology status');

  const badAuthConfig = structuredClone(cliConfig);
  badAuthConfig.security.apiKeys = ['not-the-key'];
  const badAuthPath = path.join(tempDir, 'bad-auth.json');
  fs.writeFileSync(badAuthPath, JSON.stringify(badAuthConfig));
  const authFailure = await runCli(
    process.execPath,
    [binPath, 'doctor', '--runtime', 'split', '--json', '--config', badAuthPath],
    {
      encoding: 'utf8',
      timeout: 8000
    }
  );
  assert.notEqual(authFailure.status, 0);
  assert.match(`${authFailure.stderr}${authFailure.stdout}`, /gateway returned|unauthorized|auth/i);
});

test('invalid distributed members fail before required or optional probes', async (t) => {
  const f = await boot(t);
  for (const mutate of [
    (config) => {
      config.runtimes.split.placement.members = [];
    },
    (config) => {
      config.runtimes.worker.enabled = false;
    },
    (config) => {
      config.runtimes.worker.node = 'federation';
    },
    (config) => {
      config.runtimes.split.placement.members.push(config.runtimes.split.placement.members[0]);
    }
  ]) {
    const config = structuredClone(f.config);
    mutate(config);
    const coordinator = new ClusterCoordinator(config, { env: { LLOOM_NODE_ID: 'leader' }, logger });
    const report = await coordinator.runtimeReadiness('split', { includeFederation: true });
    assert.equal(report.availabilityState, 'config-error');
    assert.ok(report.configErrors.length);
    assert.equal(report.readyForServing, false);
  }
  assert.equal(f.workerControl.state.hits, 0);
  assert.equal(f.federationControl.state.hits, 0);
});

test('whole-topology status marks optional offline peers without changing required readiness', async (t) => {
  const f = await boot(t);
  f.federationControl.state.offline = true;
  const status = await f.coordinator.status();
  assert.equal(status.nodes.federation.required, false);
  assert.equal(status.nodes.federation.availabilityState, 'optional-offline');
  assert.equal(status.nodes.worker.required, true);
  assert.ok(status.nodes.worker.requiredByRuntime.includes('split'));
  assert.deepEqual((await f.manager.status()).runtimes.split.requiredNodes, ['leader', 'worker']);
});
