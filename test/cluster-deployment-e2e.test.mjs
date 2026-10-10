import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { ClusterDeploymentCoordinator, DeploymentError, DeploymentJournal } from '../src/cluster-deployment.mjs';
import { createLloomServer } from '../src/server.mjs';
import { NodeGatewayAdapter } from '../src/node-gateway-adapter.mjs';
import { NodeReleaseAgent } from '../src/node-release-agent.mjs';

const execFileAsync = promisify(execFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const OLD_COMMIT = 'a'.repeat(40);
const NEXT_COMMIT = 'd'.repeat(40);
const DEPENDENCY_DIGEST = sha(JSON.stringify({ dep: '1.0.0' }));
const RUNTIME_CONTRACT_DIGEST = 'b'.repeat(64);
const ADMIN_KEY = 'admin';

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
}

async function inventory(root) {
  const entries = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, relative);
      else {
        assert.equal(entry.isFile(), true);
        const bytes = await fs.readFile(target);
        entries.push({ path: relative, size: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function treeDigest(files) {
  return sha(JSON.stringify(files.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest }))));
}

async function archive(root, destination) {
  await execFileAsync('tar', ['--create', '--file', destination, '--directory', root, '.']);
  return fs.readFile(destination);
}

function request(port, pathname, { method = 'GET', token = ADMIN_KEY, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
    }
  });
  const response = new Promise((resolve, reject) => {
    req.once('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
      res.once('error', reject);
    });
    req.once('error', reject);
  });
  if (payload) req.end(payload);
  else req.end();
  return response;
}

function identityFields(identity) {
  return {
    releaseId: identity.releaseId,
    artifactSha256: identity.artifactSha256,
    manifestSha256: identity.manifestSha256,
    configSha256: identity.configSha256,
    effectiveConfigSha256: identity.effectiveConfigSha256,
    dependencyDigest: identity.dependencyDigest,
    runtimeContractDigest: identity.runtimeContractDigest
  };
}

async function makeFleet(t, { failRestartNode = null, failReleaseNode = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-cluster-e2e-'));
  const reviewedRoot = path.join(directory, 'reviewed');
  const nextRoot = path.join(directory, 'next');
  await fs.mkdir(reviewedRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(nextRoot, { recursive: true, mode: 0o700 });

  const oldFiles = {
    'package.json': JSON.stringify({
      name: 'lloom',
      version: 'old',
      engines: { node: '>=22.19.0' },
      dependencies: { dep: '1.0.0' }
    }),
    'server.mjs': 'export const release = "old";\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' })
  };
  const nextFiles = {
    'package.json': JSON.stringify({
      name: 'lloom',
      version: 'next',
      engines: { node: '>=22.19.0' },
      dependencies: { dep: '^1.0.0' }
    }),
    'server.mjs': 'export const release = "next";\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' })
  };
  await writeFiles(nextRoot, nextFiles);
  const nextInventory = await inventory(nextRoot);
  const artifactPath = path.join(reviewedRoot, 'lloom-gateway.tar');
  const artifactBytes = await archive(nextRoot, artifactPath);
  const nextManifest = {
    schemaVersion: 1,
    package: 'lloom',
    version: 'next',
    releaseId: NEXT_COMMIT,
    commit: NEXT_COMMIT,
    sha256: sha(artifactBytes),
    dependencyClosure: { dep: '1.0.0' },
    dependencyDigest: DEPENDENCY_DIGEST,
    runtimeContractDigest: RUNTIME_CONTRACT_DIGEST,
    files: nextInventory,
    treeSha256: treeDigest(nextInventory),
    engines: { node: '>=22.19.0' }
  };
  const manifestPath = path.join(reviewedRoot, 'release-manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(nextManifest)}\n`);
  await fs.writeFile(manifestPath, manifestBytes, { mode: 0o600 });

  const nodes = {};
  const nodeEntries = [
    ['worker-1', 'worker'],
    ['leader', 'leader']
  ];

  for (const [nodeId, role] of nodeEntries) {
    const nodeDirectory = path.join(directory, nodeId);
    const root = path.join(nodeDirectory, 'gateway');
    const oldRoot = path.join(root, 'releases', 'old');
    await fs.mkdir(oldRoot, { recursive: true, mode: 0o700 });
    await writeFiles(oldRoot, oldFiles);
    const oldInventory = await inventory(oldRoot);
    const oldArtifactSha256 = sha(Buffer.from(`old-artifact-${nodeId}`));
    const oldManifest = {
      schemaVersion: 1,
      package: 'lloom',
      version: 'old',
      releaseId: OLD_COMMIT,
      commit: OLD_COMMIT,
      sha256: oldArtifactSha256,
      dependencyClosure: { dep: '1.0.0' },
      dependencyDigest: DEPENDENCY_DIGEST,
      runtimeContractDigest: RUNTIME_CONTRACT_DIGEST,
      files: oldInventory,
      treeSha256: treeDigest(oldInventory),
      engines: { node: '>=22.19.0' }
    };
    const oldManifestBytes = Buffer.from(`${JSON.stringify(oldManifest)}\n`);
    await fs.writeFile(path.join(oldRoot, 'release-manifest.json'), oldManifestBytes, { mode: 0o600 });
    await fs.symlink('releases/old', path.join(root, 'current'));
    await fs.writeFile(path.join(root, 'current.manifest.json'), oldManifestBytes, { mode: 0o600 });

    const configPath = path.join(root, 'config.json');
    const config = {
      sourcePath: configPath,
      releaseManifestPath: path.join(root, 'current.manifest.json'),
      server: { host: '127.0.0.1', port: 0 },
      security: { allowMissingAuth: false, apiKeys: ['infer'], adminApiKeys: [ADMIN_KEY] },
      defaults: { chatModel: 'local-model' },
      backends: {},
      models: [{ id: 'local-model', backend: 'local', upstreamModel: 'local', runtime: 'hot', kind: 'chat' }],
      runtimes: { hot: { enabled: true, command: 'false' } }
    };
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

    const requests = [];
    let app = null;
    let port = null;
    let activeRelease = 'old';
    let restartAttempts = 0;
    let releaseFailureInjected = false;
    let adapterCreations = 0;

    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          // The gateway should reject malformed requests before reaching this fixture.
        }
        requests.push({
          release: activeRelease,
          fenceState: app?.deploymentFence.status().state ?? null,
          model: body.model,
          path: req.url
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion',
            model: body.model ?? 'local',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
      });
    });
    const upstreamPort = await listen(upstream);
    config.backends.local = { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` };
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

    async function startGateway(packageRoot) {
      const nextApp = createLloomServer(config, {
        logger: { error() {}, warn() {}, info() {} },
        deploymentPackageRoot: packageRoot
      });
      const stableRuntime = {
        status: 'running',
        healthy: true,
        pid: 41000 + nodeEntries.findIndex(([id]) => id === nodeId),
        node: nodeId,
        containerName: `lloom-${nodeId}`,
        container: {
          id: `container-${nodeId}`,
          name: `lloom-${nodeId}`,
          image: 'lloom-e2e:reviewed',
          imageId: 'e'.repeat(64),
          running: true,
          status: 'running'
        }
      };
      nextApp.runtimeManager.isHealthy = async (runtimeId) => runtimeId === 'hot';
      nextApp.runtimeManager.withSlot = async (...args) => {
        const fn = args.find((value) => typeof value === 'function');
        return typeof fn === 'function' ? fn() : undefined;
      };
      nextApp.runtimeManager.startKeepWarm = async () => ({ skipped: 'synthetic-e2e' });
      nextApp.runtimeManager.waitForQuiescence = async () => {};
      nextApp.runtimeManager.status = async () => ({
        runtimes: { hot: stableRuntime },
        events: [{ at: Date.now(), event: 'synthetic-runtime-status' }]
      });
      await listen(nextApp.server, 0);
      port = nextApp.server.address().port;
      activeRelease =
        path.basename(packageRoot) === 'old' || path.basename(packageRoot).startsWith('rollback-') ? 'old' : 'next';
      app = nextApp;
      return nextApp;
    }

    async function restartGateway() {
      await app?.close({ stopRuntimes: false, httpGraceMs: 100 });
      const currentRoot = await fs.realpath(path.join(root, 'current'));
      await startGateway(currentRoot);
    }

    const gatewayAdapter = () => {
      adapterCreations += 1;
      return new NodeGatewayAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        adminApiKey: ADMIN_KEY,
        timeoutMs: 5000,
        drainTimeoutMs: 5000
      });
    };
    const gateway = {
      inspect: (...args) => gatewayAdapter().inspect(...args),
      prepare: async (...args) => gatewayAdapter().prepare(...args),
      reprepare: async (...args) => gatewayAdapter().reprepare(...args),
      canary: (...args) => gatewayAdapter().canary(...args),
      release: async (context) => {
        if (failReleaseNode === nodeId && !releaseFailureInjected && context.rollbackRelease !== true) {
          releaseFailureInjected = true;
          const error = new Error('synthetic forward release failure');
          error.code = 'release_failed';
          throw error;
        }
        return gatewayAdapter().release(context);
      }
    };

    const unitPath = path.join(nodeDirectory, 'lloom.service');
    await fs.writeFile(
      unitPath,
      `[Service]\nExecStart=/usr/bin/node ${path.join(root, 'current', 'server.mjs')}\nKillMode=process\n`,
      { mode: 0o600 }
    );

    const run = async (command, args) => {
      if (command === 'tar') {
        const result = await execFileAsync(command, args);
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      }
      if (command === 'systemctl' && args[1] === 'show') {
        return {
          code: 0,
          stdout: [
            'ActiveState=active',
            'UnitFileState=enabled',
            `FragmentPath=${unitPath}`,
            `ExecStart=/usr/bin/node ${path.join(root, 'current', 'server.mjs')}`,
            'KillMode=process',
            ''
          ].join('\n'),
          stderr: ''
        };
      }
      if (command === 'systemctl' && args[1] === 'restart') {
        restartAttempts += 1;
        if (failRestartNode === nodeId && restartAttempts === 1) {
          return { code: 1, stdout: '', stderr: 'synthetic restart failure' };
        }
        await restartGateway();
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'loginctl') return { code: 0, stdout: 'Linger=yes\n', stderr: '' };
      if (args[1] === 'is-active') return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: 'active\n', stderr: '' };
    };

    await startGateway(oldRoot);
    const configBytes = await fs.readFile(configPath);
    const effectiveConfigSha256 = sha(JSON.stringify(config));
    const expectedOldIdentity = {
      releaseId: OLD_COMMIT,
      artifactSha256: oldManifest.sha256,
      manifestSha256: sha(oldManifestBytes),
      configSha256: sha(configBytes),
      dependencyDigest: DEPENDENCY_DIGEST,
      runtimeContractDigest: RUNTIME_CONTRACT_DIGEST
    };
    const expectedOldLoadedIdentity = {
      ...expectedOldIdentity,
      effectiveConfigSha256
    };
    const expectedNextIdentity = {
      releaseId: NEXT_COMMIT,
      artifactSha256: nextManifest.sha256,
      manifestSha256: sha(manifestBytes),
      configSha256: expectedOldIdentity.configSha256,
      effectiveConfigSha256,
      dependencyDigest: DEPENDENCY_DIGEST,
      runtimeContractDigest: RUNTIME_CONTRACT_DIGEST
    };

    const agent = new NodeReleaseAgent({
      nodeId,
      root,
      configPath,
      unitPath,
      serviceUser: 'e2e-user',
      platform: 'linux',
      gateway,
      run
    });

    nodes[nodeId] = {
      nodeId,
      role,
      root,
      configPath,
      unitPath,
      app: () => app,
      adapter: () => gatewayAdapter(),
      agent,
      expectedOldIdentity,
      expectedOldLoadedIdentity,
      expectedNextIdentity,
      requests,
      get activeRelease() {
        return activeRelease;
      },
      get adapterCreations() {
        return adapterCreations;
      },
      async close() {
        await app?.close({ stopRuntimes: false, httpGraceMs: 100 }).catch(() => {});
        await new Promise((resolve) => upstream.close(() => resolve()));
      }
    };
  }

  const plan = {
    scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' },
    gatewayProtocol: 1,
    reviewedArtifact: {
      id: 'release-next',
      path: artifactPath,
      manifestPath,
      sha256: nextManifest.sha256,
      manifestSha256: sha(manifestBytes),
      reviewed: true
    },
    targetNodes: nodeEntries.map(([id, role], order) => ({ id, role, order })),
    expectedOldIdentity: nodes['worker-1'].expectedOldIdentity,
    expectedOldIdentityByNode: Object.fromEntries(nodeEntries.map(([id]) => [id, nodes[id].expectedOldIdentity])),
    canary: { gatewayModelId: 'local-model', runtimeId: 'hot' },
    drainTimeoutMs: 5000
  };

  const journal = new DeploymentJournal(path.join(directory, 'coordinator-journal.json'));
  const calls = [];
  const barrierObservations = [];
  const methods = [
    'preflight',
    'stage',
    'prepare',
    'swap',
    'restart',
    'verify',
    'canary',
    'promote',
    'release',
    'reprepare',
    'rollback',
    'discardStage'
  ];
  const transport = {};
  for (const method of methods) {
    transport[method] = async (nodeId, context) => {
      calls.push({ method, nodeId, context: { ...context } });
      if (method === 'rollback') {
        const snapshots = {};
        for (const [id, node] of Object.entries(nodes)) {
          const inspection = await node.adapter().inspect();
          snapshots[id] = { fenced: inspection.fenced, drained: inspection.drained, release: node.activeRelease };
        }
        barrierObservations.push({ nodeId, snapshots });
      }
      return nodes[nodeId].agent[method](nodeId, context);
    };
  }
  const coordinator = new ClusterDeploymentCoordinator({
    journal,
    transport,
    operationIdFactory: () => 'cluster-e2e-operation',
    clock: () => new Date('2026-10-10T17:00:00.000Z')
  });

  t.after(async () => {
    await Promise.all(Object.values(nodes).map((node) => node.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  return { directory, nodes, plan, coordinator, calls, barrierObservations };
}

async function rejectedDeployment(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof DeploymentError, true);
    return true;
  });
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('deployment unexpectedly succeeded');
}

function receiptOrder(report, phases) {
  return report.events
    .filter((event) => event.type === 'receipt' && phases.includes(event.phase))
    .map((event) => `${event.phase}:${event.nodeId}`);
}

test('promotes two real gateway nodes through fresh adapters and preserves model identity', async (t) => {
  const fleet = await makeFleet(t);
  const before = {};
  for (const [nodeId, node] of Object.entries(fleet.nodes)) {
    const inspection = await node.adapter().inspect();
    before[nodeId] = inspection.preservationSnapshot;
    assert.deepEqual(identityFields(inspection.loadedIdentity), node.expectedOldLoadedIdentity);
  }

  const result = await fleet.coordinator.deploy(fleet.plan, { operationId: 'cluster-e2e-success' });
  assert.equal(result.operationState, 'completed');
  assert.deepEqual(
    Object.values(result.nodes).map((node) => node.state),
    ['released', 'released']
  );

  for (const [nodeId, node] of Object.entries(fleet.nodes)) {
    const inspection = await node.adapter().inspect();
    assert.equal(inspection.fenced, false);
    assert.equal(inspection.drained, false);
    assert.deepEqual(identityFields(inspection.loadedIdentity), node.expectedNextIdentity);
    assert.deepEqual(inspection.preservationSnapshot, before[nodeId]);
    assert.equal(node.activeRelease, 'next');
    assert.ok(node.adapterCreations >= 9, `${nodeId} did not use fresh adapters per phase`);
  }
  assert.ok(
    fleet.nodes.leader.requests.some(
      (entry) => entry.release === 'next' && entry.fenceState === 'canary' && entry.model === 'local'
    ),
    'successful deployment did not issue a fenced next-release leader canary'
  );
});

test('restores the old fleet after a second-node restart failure, then canaries before release', async (t) => {
  const fleet = await makeFleet(t, { failRestartNode: 'leader' });
  const error = await rejectedDeployment(
    fleet.coordinator.deploy(fleet.plan, { operationId: 'cluster-e2e-restart-failure' })
  );
  const report = error.report;
  assert.equal(report.operationState, 'rolled-back');
  assert.equal(report.rollback.manualIntervention, false);

  const order = receiptOrder(report, ['reprepare', 'rollback', 'canary', 'release']);
  const firstRollback = order.findIndex((entry) => entry.startsWith('rollback:'));
  const firstCanary = order.findIndex((entry, index) => index > firstRollback && entry === 'canary:leader');
  const firstRelease = order.findIndex((entry, index) => index > firstCanary && entry.startsWith('release:'));
  assert.ok(firstRollback >= 0);
  assert.ok(firstCanary > firstRollback);
  assert.ok(firstRelease > firstCanary);
  assert.deepEqual(order.slice(firstRollback, firstRelease), ['rollback:leader', 'rollback:worker-1', 'canary:leader']);

  for (const node of Object.values(fleet.nodes)) {
    const inspection = await node.adapter().inspect();
    assert.equal(inspection.fenced, false);
    assert.equal(inspection.drained, false);
    assert.deepEqual(identityFields(inspection.loadedIdentity), node.expectedOldLoadedIdentity);
    assert.equal(node.activeRelease, 'old');
  }
  assert.ok(
    fleet.nodes.leader.requests.some(
      (entry) => entry.release === 'old' && entry.fenceState === 'canary' && entry.model === 'local'
    ),
    'rollback did not canary the old leader while fenced'
  );
});

test('re-fences every node before restoring after a partial forward release', async (t) => {
  const fleet = await makeFleet(t, { failReleaseNode: 'leader' });
  const error = await rejectedDeployment(
    fleet.coordinator.deploy(fleet.plan, { operationId: 'cluster-e2e-release-failure' })
  );
  const report = error.report;
  assert.equal(report.operationState, 'rolled-back');
  assert.equal(report.rollback.manualIntervention, false);

  assert.ok(fleet.barrierObservations.length >= 1, 'rollback did not observe a fleet barrier');
  const firstRestore = fleet.barrierObservations[0];
  assert.deepEqual(
    Object.values(firstRestore.snapshots).map((snapshot) => [snapshot.fenced, snapshot.drained]),
    [
      [true, true],
      [true, true]
    ]
  );

  const order = receiptOrder(report, ['reprepare', 'rollback', 'canary', 'release']);
  const firstRollback = order.findIndex((entry) => entry.startsWith('rollback:'));
  const lastReprepare = Math.max(...order.map((entry, index) => (entry.startsWith('reprepare:') ? index : -1)));
  const firstCanary = order.findIndex((entry, index) => index > firstRollback && entry === 'canary:leader');
  const firstRelease = order.findIndex((entry, index) => index > firstCanary && entry.startsWith('release:'));
  assert.ok(firstRollback > lastReprepare, 'a restore began before all nodes were re-fenced');
  assert.ok(firstCanary > firstRollback);
  assert.ok(firstRelease > firstCanary);

  for (const node of Object.values(fleet.nodes)) {
    const inspection = await node.adapter().inspect();
    assert.equal(inspection.fenced, false);
    assert.deepEqual(identityFields(inspection.loadedIdentity), node.expectedOldLoadedIdentity);
    assert.equal(node.activeRelease, 'old');
  }
  assert.ok(
    fleet.nodes.leader.requests.some((entry) => entry.release === 'old' && entry.fenceState === 'canary'),
    'partial-release rollback did not use the old leader canary'
  );
});
