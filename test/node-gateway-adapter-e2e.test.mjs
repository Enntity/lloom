import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { createLloomServer } from '../src/server.mjs';
import { NodeGatewayAdapter } from '../src/node-gateway-adapter.mjs';
import { NodeReleaseAgent } from '../src/node-release-agent.mjs';

const execFileAsync = promisify(execFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const COMMIT = 'a'.repeat(40);
const DEP = sha(JSON.stringify({ dep: '1.0.0' }));
const CONTRACT = 'b'.repeat(64);

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

function request(port, pathname, { method = 'GET', token, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const request = http.request(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
    }
  });
  const response = new Promise((resolve, reject) => {
    request.once('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.once('error', reject);
    });
    request.once('error', reject);
  });
  if (payload) request.end(payload);
  else request.end();
  return response;
}

test('uses a fresh adapter per phase against createLloomServer and stages a real tar archive', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-node-adapter-e2e-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'gateway');
  const oldRoot = path.join(root, 'releases', 'old');
  const reviewedRoot = path.join(directory, 'reviewed');
  const nextRoot = path.join(directory, 'next');
  await fs.mkdir(oldRoot, { recursive: true, mode: 0o700 });
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
  await writeFiles(oldRoot, oldFiles);
  const oldInventory = await inventory(oldRoot);
  const oldManifest = {
    schemaVersion: 1,
    package: 'lloom',
    version: 'old',
    releaseId: COMMIT,
    commit: COMMIT,
    sha256: 'c'.repeat(64),
    dependencyClosure: { dep: '1.0.0' },
    dependencyDigest: DEP,
    runtimeContractDigest: CONTRACT,
    files: oldInventory,
    treeSha256: treeDigest(oldInventory),
    engines: { node: '>=22.19.0' }
  };
  const oldManifestBytes = Buffer.from(`${JSON.stringify(oldManifest)}\n`);
  await fs.writeFile(path.join(oldRoot, 'release-manifest.json'), oldManifestBytes, { mode: 0o600 });
  await fs.symlink('releases/old', path.join(root, 'current'));
  await fs.writeFile(path.join(root, 'current.manifest.json'), oldManifestBytes, { mode: 0o600 });
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, '{"gateway":"e2e"}\n', { mode: 0o600 });

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
  const manifest = {
    schemaVersion: 1,
    package: 'lloom',
    version: 'next',
    releaseId: 'd'.repeat(40),
    commit: 'd'.repeat(40),
    sha256: sha(artifactBytes),
    dependencyClosure: { dep: '1.0.0' },
    dependencyDigest: DEP,
    runtimeContractDigest: CONTRACT,
    files: nextInventory,
    treeSha256: treeDigest(nextInventory),
    engines: { node: '>=22.19.0' }
  };
  const manifestPath = path.join(reviewedRoot, 'release-manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await fs.writeFile(manifestPath, manifestBytes, { mode: 0o600 });

  const unitPath = path.join(directory, 'lloom.service');
  await fs.writeFile(
    unitPath,
    `[Service]\nExecStart=/usr/bin/node ${path.join(root, 'current', 'server.mjs')}\nKillMode=process\n`,
    { mode: 0o600 }
  );
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'e2e', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  const upstreamPort = await listen(upstream);
  const config = {
    sourcePath: configPath,
    releaseManifestPath: path.join(root, 'current.manifest.json'),
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['infer'], adminApiKeys: ['admin'] },
    defaults: { chatModel: 'local-model' },
    backends: { local: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } },
    models: [{ id: 'local-model', backend: 'local', upstreamModel: 'local', runtime: 'hot', kind: 'chat' }],
    runtimes: { hot: { enabled: true, command: 'false' } }
  };
  let app = null;
  let port = null;
  async function startGateway(packageRoot) {
    const nextApp = createLloomServer(config, {
      logger: { error() {}, warn() {}, info() {} },
      deploymentPackageRoot: packageRoot
    });
    nextApp.runtimeManager.isHealthy = async (runtimeId) => runtimeId === 'hot';
    nextApp.runtimeManager.withSlot = async (_runtimeId, fn) => fn();
    nextApp.runtimeManager.startKeepWarm = async () => ({ skipped: 'synthetic-e2e' });
    nextApp.runtimeManager.waitForQuiescence = async () => {};
    nextApp.runtimeManager.status = async () => ({
      runtimes: { hot: { status: 'running', healthy: true } },
      events: []
    });
    await listen(nextApp.server, port ?? 0);
    port = nextApp.server.address().port;
    app = nextApp;
    return nextApp;
  }
  async function restartGateway() {
    await app?.close({ stopRuntimes: false });
    const currentRoot = await fs.realpath(path.join(root, 'current'));
    await startGateway(currentRoot);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let status;
      try {
        status = await request(port, '/gateway/deployment-fence/status', { token: 'admin' });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (status.body.state === 'prepared') return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('synthetic gateway did not recover its durable fence');
  }
  await startGateway(oldRoot);
  const expectedOldIdentity = {
    releaseId: COMMIT,
    artifactSha256: oldManifest.sha256,
    manifestSha256: sha(oldManifestBytes),
    configSha256: sha(await fs.readFile(configPath)),
    effectiveConfigSha256: sha(JSON.stringify(config)),
    dependencyDigest: DEP,
    runtimeContractDigest: CONTRACT
  };
  const reviewedContext = {
    operationId: 'e2e-node-release',
    generation: 1,
    planHash: 'e'.repeat(64),
    nodeId: 'gateway-1',
    role: 'leader',
    phase: 'preflight',
    scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' },
    gatewayProtocol: 1,
    artifact: {
      id: 'release-next',
      path: artifactPath,
      manifestPath,
      sha256: manifest.sha256,
      manifestSha256: sha(manifestBytes),
      reviewed: true
    },
    manifestSha256: sha(manifestBytes),
    expectedOldIdentity,
    canary: { gatewayModelId: 'local-model', runtimeId: 'hot' }
  };
  try {
    const freshAdapter = () => new NodeGatewayAdapter({ baseUrl: `http://127.0.0.1:${port}`, adminApiKey: 'admin' });
    // The node agent receives a fresh authenticated adapter for every phase,
    // matching separate node-agent invocations. The durable fence sidecar is
    // the only source of the operation generation after a restart.
    const gateway = Object.fromEntries(
      ['inspect', 'prepare', 'reprepare', 'release', 'canary'].map((method) => [
        method,
        (...args) => freshAdapter()[method](...args)
      ])
    );
    const agent = new NodeReleaseAgent({
      nodeId: 'gateway-1',
      root,
      configPath,
      unitPath,
      serviceUser: 'e2e-user',
      platform: 'linux',
      gateway,
      run: async (command, args) => {
        if (command === 'tar') {
          const result = await execFileAsync(command, args);
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        }
        if (command === 'systemctl' && args[1] === 'show')
          return {
            code: 0,
            stdout: [
              'ActiveState=active',
              'UnitFileState=enabled',
              `FragmentPath=${unitPath}`,
              `ExecStart=/usr/bin/node ${path.join(root, 'current', 'server.mjs')}`,
              'KillMode=process',
              ''
            ].join('\n')
          };
        if (command === 'systemctl' && args[1] === 'restart') {
          await restartGateway();
          return { code: 0, stdout: '' };
        }
        if (command === 'loginctl') return { code: 0, stdout: 'Linger=yes\n' };
        return { code: 0, stdout: 'active\n' };
      }
    });
    const preflight = await agent.preflight('gateway-1', reviewedContext);
    assert.deepEqual(preflight.currentIdentity, expectedOldIdentity);
    assert.equal(preflight.effectiveConfigSha256, expectedOldIdentity.effectiveConfigSha256);
    const staged = await agent.stage('gateway-1', { ...reviewedContext, phase: 'stage' });
    assert.equal(staged.staged, true);
    assert.equal(staged.artifactSha256, manifest.sha256);
    await agent.prepare('gateway-1', { ...reviewedContext, phase: 'prepare' });
    await agent.swap('gateway-1', { ...reviewedContext, phase: 'swap' });
    // This restart closes the old createLloomServer instance, resolves the
    // reviewed atomic current pointer, and boots a fresh instance. Both the
    // next-release loaded identity and the persisted fence are then observed
    // through a new adapter before verification and canary.
    await agent.restart('gateway-1', { ...reviewedContext, phase: 'restart' });
    await agent.verify('gateway-1', { ...reviewedContext, phase: 'verify' });
    await agent.canary('gateway-1', { ...reviewedContext, phase: 'canary' });
    await agent.promote('gateway-1', { ...reviewedContext, phase: 'promote' });

    // Exercise the compensating path too: restore the old release, restart a
    // fresh server from the restored pointer, verify its loaded identity and
    // only then release the old fence publicly.
    await agent.rollback('gateway-1', { ...reviewedContext, generation: 2, phase: 'rollback' });
    const rollbackRelease = await agent.release('gateway-1', {
      ...reviewedContext,
      generation: 2,
      phase: 'release',
      rollbackRelease: true
    });
    assert.equal(rollbackRelease.rollbackReleased, true);
    const inspect = await freshAdapter().inspect();
    assert.deepEqual(inspect.currentIdentity, expectedOldIdentity);
    assert.equal(inspect.fenced, false);
    const status = await request(port, '/gateway/deployment-fence/status', { token: 'admin' });
    assert.equal(status.body.state, 'open');
  } finally {
    await app?.close({ stopRuntimes: false }).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
  }
});
