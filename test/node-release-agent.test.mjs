import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NodeReleaseAgent, nodeEngineAllows } from '../src/node-release-agent.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const OLD_ARTIFACT = 'old-artifact-content';
const OLD_ARTIFACT_SHA = sha(OLD_ARTIFACT);
const CONFIG = '{"gateway":"reviewed"}\n';
const CONFIG_SHA = sha(CONFIG);
const DEP = sha(JSON.stringify({ dep: '1.0.0' }));
const CONTRACT = '2'.repeat(64);
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const [NODE_MAJOR_NUMBER, NODE_MINOR_NUMBER, NODE_PATCH_NUMBER] = process.versions.node.split('.').map(Number);

function fileInventory(files) {
  return Object.entries(files)
    .map(([filePath, bytes]) => ({ path: filePath, sha256: sha(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function treeDigest(entries) {
  return sha(JSON.stringify(entries));
}

test('evaluates the complete Node engine range instead of only its first comparator', () => {
  const [major, minor, patch] = [NODE_MAJOR_NUMBER, NODE_MINOR_NUMBER, NODE_PATCH_NUMBER];
  assert.equal(nodeEngineAllows(`>=${major}.${minor}.${patch} <${major + 1}.0.0`), true);
  assert.equal(nodeEngineAllows(`>=${major}.${minor + 1}.0 <${major + 1}.0.0`), false);
  assert.equal(nodeEngineAllows(`>=${major}.0.0 <${major}.0.0`), false);
  assert.equal(nodeEngineAllows(`^${major}.${minor}.${patch}`), true);
  assert.equal(nodeEngineAllows(`~${major}.${minor + 1}.0`), false);
  assert.equal(nodeEngineAllows('>=22.19.0 nonsense'), false);
});

async function makeFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-node-agent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'gateway');
  const input = path.join(directory, 'reviewed');
  await fs.mkdir(path.join(root, 'releases', 'old'), { recursive: true });
  await fs.mkdir(input, { recursive: true });
  const oldFiles = {
    'package.json': JSON.stringify({
      name: 'lloom',
      version: 'old',
      engines: { node: `>=${NODE_MAJOR}` },
      dependencies: { dep: '1.0.0' }
    }),
    'app.js': 'old\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' })
  };
  for (const [filePath, bytes] of Object.entries(oldFiles)) {
    await fs.mkdir(path.dirname(path.join(root, 'releases', 'old', filePath)), { recursive: true });
    await fs.writeFile(path.join(root, 'releases', 'old', filePath), bytes);
  }
  await fs.symlink('releases/old', path.join(root, 'current'));
  await fs.writeFile(path.join(root, 'config.json'), CONFIG);
  const oldManifest = JSON.stringify({
    releaseId: 'release-old',
    sha256: OLD_ARTIFACT_SHA,
    dependencyDigest: DEP,
    runtimeContractDigest: CONTRACT
  });
  const oldPackagedManifest = {
    releaseId: 'release-old',
    sha256: OLD_ARTIFACT_SHA,
    dependencyDigest: DEP,
    runtimeContractDigest: CONTRACT,
    dependencyClosure: { dep: '1.0.0' },
    files: fileInventory(oldFiles),
    treeSha256: treeDigest(fileInventory(oldFiles)),
    engines: { node: `>=${NODE_MAJOR}` }
  };
  await fs.writeFile(path.join(root, 'releases', 'old', 'release-manifest.json'), JSON.stringify(oldPackagedManifest));
  await fs.writeFile(path.join(root, 'current.manifest.json'), oldManifest);
  const artifact = Buffer.from('next-artifact-content');
  const artifactPath = path.join(input, 'release.tar');
  await fs.writeFile(artifactPath, artifact);
  const artifactSha = sha(artifact);
  const nextFiles = {
    'package.json': JSON.stringify({
      name: 'lloom',
      version: 'next',
      engines: { node: `>=${NODE_MAJOR}` },
      dependencies: { dep: '1.0.0' }
    }),
    'app.js': 'next\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' })
  };
  const manifest = Buffer.from(
    JSON.stringify({
      releaseId: 'release-next',
      sha256: artifactSha,
      dependencyDigest: DEP,
      runtimeContractDigest: CONTRACT,
      dependencyClosure: { dep: '1.0.0' },
      files: fileInventory(nextFiles),
      treeSha256: treeDigest(fileInventory(nextFiles)),
      engines: { node: `>=${NODE_MAJOR}` }
    })
  );
  const manifestPath = path.join(input, 'manifest.json');
  await fs.writeFile(manifestPath, manifest);
  const loaded = { value: 'old', fenced: false };
  const calls = [];
  const gateway = {
    async inspect() {
      const next = loaded.value === 'next';
      return {
        gatewayProtocol: 1,
        fenceProtocolVersion: 1,
        atomicLayout: true,
        serviceActive: true,
        loadedIdentity: next
          ? {
              releaseId: 'release-next',
              artifactSha256: artifactSha,
              manifestSha256: sha(manifest),
              configSha256: CONFIG_SHA,
              dependencyDigest: DEP,
              runtimeContractDigest: CONTRACT
            }
          : {
              releaseId: 'release-old',
              artifactSha256: OLD_ARTIFACT_SHA,
              manifestSha256: sha(oldManifest),
              configSha256: CONFIG_SHA,
              dependencyDigest: DEP,
              runtimeContractDigest: CONTRACT
            },
        fenced: loaded.fenced,
        drained: loaded.fenced,
        runtimeSnapshot: { gateway: 'old' }
      };
    },
    async prepare() {
      loaded.fenced = true;
      return { fenced: true, drained: true };
    },
    async reprepare() {
      loaded.fenced = true;
      return { fenced: true, drained: true };
    },
    async release() {
      loaded.fenced = false;
      return { fenced: false };
    },
    async canary() {
      return {
        healthy: true,
        gatewayModelId: 'atlas/local',
        runtimeId: 'atlas-runtime',
        fenced: true,
        privileged: true,
        aliasUsed: false,
        cloudFallback: false,
        source: 'local'
      };
    }
  };
  const run = async (command, argv) => {
    calls.push([command, ...argv]);
    if (argv[1] === 'restart') {
      const target = await fs.readlink(path.join(root, 'current'));
      loaded.value = target.includes('rollback') || target.includes('/old') ? 'old' : 'next';
    }
    return { code: 0, stdout: 'active\n', stderr: '' };
  };
  const agent = new NodeReleaseAgent({
    nodeId: 'node-1',
    root,
    configPath: path.join(root, 'config.json'),
    platform: 'linux',
    gateway,
    extractArchive: async ({ destination }) => {
      for (const [filePath, bytes] of Object.entries(nextFiles)) {
        await fs.mkdir(path.dirname(path.join(destination, filePath)), { recursive: true });
        await fs.writeFile(path.join(destination, filePath), bytes);
      }
    },
    run,
    clock: () => new Date('2026-10-10T17:00:00.000Z')
  });
  const context = {
    operationId: 'op-node',
    generation: 1,
    planHash: 'a'.repeat(64),
    nodeId: 'node-1',
    phase: 'preflight',
    scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' },
    gatewayProtocol: 1,
    artifact: {
      id: 'release-next',
      path: artifactPath,
      manifestPath,
      sha256: artifactSha,
      manifestSha256: sha(manifest),
      reviewed: true
    },
    expectedOldIdentity: {
      releaseId: 'release-old',
      artifactSha256: OLD_ARTIFACT_SHA,
      manifestSha256: sha(oldManifest)
    },
    canary: { gatewayModelId: 'atlas/local', runtimeId: 'atlas-runtime' }
  };
  return { agent, context, root, loaded, calls, artifactSha, manifestSha: sha(manifest), gateway };
}

test('stages, swaps, restarts, verifies and releases only the gateway unit', async (t) => {
  const fixture = await makeFixture(t);
  const { agent, context, calls } = fixture;
  const preflight = await agent.preflight('node-1', context);
  assert.equal(preflight.currentIdentity.releaseId, 'release-old');
  const stage = await agent.stage('node-1', context);
  assert.equal(stage.staged, true);
  const prepared = await agent.prepare('node-1', context);
  assert.equal(prepared.fenced, true);
  const swapped = await agent.swap('node-1', context);
  assert.equal(swapped.applied, true);
  assert.equal((await agent.restart('node-1', context)).healthy, true);
  assert.equal((await agent.verify('node-1', context)).verified, true);
  assert.equal((await agent.canary('node-1', context)).source, 'local');
  assert.equal((await agent.promote('node-1', context)).promoted, true);
  assert.equal((await agent.release('node-1', context)).released, true);
  assert.deepEqual(
    calls.map((entry) => entry.slice(0, 4)),
    [
      ['systemctl', '--user', 'is-active', 'lloom.service'],
      ['systemctl', '--user', 'restart', 'lloom.service'],
      ['systemctl', '--user', 'is-active', 'lloom.service']
    ]
  );
  assert.equal(
    calls.some((entry) => entry.includes('model') || entry.includes('runtime')),
    false
  );
});

test('rejects reviewed digest mismatch before creating a stage', async (t) => {
  const fixture = await makeFixture(t);
  const bad = { ...fixture.context, artifact: { ...fixture.context.artifact, sha256: 'f'.repeat(64) } };
  await fixture.agent.preflight('node-1', fixture.context);
  await assert.rejects(
    () => fixture.agent.stage('node-1', bad),
    (error) => error.code === 'artifact_digest_mismatch'
  );
  assert.equal(await fs.stat(path.join(fixture.root, 'releases')).then(() => true), true);
  assert.equal((await fs.readdir(path.join(fixture.root, 'releases'))).length, 1);
});

test('rejects archive links before invoking tar extraction', async (t) => {
  const fixture = await makeFixture(t);
  const tarCalls = [];
  const agent = new NodeReleaseAgent({
    nodeId: 'node-1',
    root: fixture.root,
    configPath: path.join(fixture.root, 'config.json'),
    platform: 'linux',
    gateway: fixture.gateway,
    run: async (command, argv, options) => {
      if (command === 'tar') {
        tarCalls.push(argv);
        return {
          code: 0,
          stdout: argv.includes('--verbose')
            ? 'lrwxrwxrwx 0/0 0 2026-10-10 17:00 package.js -> /outside\n'
            : 'package.js\n',
          stderr: ''
        };
      }
      return fixture.agent.run(command, argv, options);
    },
    clock: () => new Date('2026-10-10T17:00:00.000Z')
  });
  await agent.preflight('node-1', fixture.context);
  await assert.rejects(
    () => agent.stage('node-1', fixture.context),
    (error) => error.code === 'archive_unsafe_entry'
  );
  assert.equal(
    tarCalls.some((argv) => argv.includes('--extract')),
    false
  );
});

test('restores a prepared node under a fresh fence and keeps it fenced', async (t) => {
  const fixture = await makeFixture(t);
  const { agent, context, root } = fixture;
  await agent.preflight('node-1', context);
  await agent.stage('node-1', context);
  await agent.prepare('node-1', context);
  await agent.swap('node-1', context);
  const rollback = await agent.rollback('node-1', context);
  assert.equal(rollback.restored, true);
  assert.equal(rollback.fenced, true);
  const restored = JSON.parse(await fs.readFile(path.join(root, 'current.manifest.json'), 'utf8'));
  assert.equal(restored.releaseId, 'release-old');
  assert.match(await fs.readlink(path.join(root, 'current')), /^releases\/rollback-/);
});

test('returns the durable receipt on repeated phase calls', async (t) => {
  const fixture = await makeFixture(t);
  const first = await fixture.agent.preflight('node-1', fixture.context);
  const second = await fixture.agent.preflight('node-1', fixture.context);
  assert.deepEqual(second, first);
  assert.equal(fixture.calls.filter((entry) => entry[2] === 'is-active').length, 1);
});

test('does not retry a lost prepare response and blocks a second operation on the node', async (t) => {
  const fixture = await makeFixture(t);
  const { agent, context, root, gateway } = fixture;
  await agent.preflight('node-1', context);
  await agent.stage('node-1', context);
  let first = true;
  const originalPrepare = gateway.prepare;
  gateway.prepare = async (...args) => {
    if (first) {
      first = false;
      await originalPrepare(...args);
      throw Object.assign(new Error('lost response'), { code: 'disconnect' });
    }
    return originalPrepare(...args);
  };
  await assert.rejects(
    () => agent.prepare('node-1', context),
    (error) => error.code === 'disconnect'
  );
  await assert.rejects(
    () => agent.prepare('node-1', context),
    (error) => error.code === 'operation_uncertain'
  );
  const recovered = await agent.reprepare('node-1', context);
  assert.equal(recovered.fenced, true);
  const second = new NodeReleaseAgent({
    nodeId: 'node-1',
    root,
    configPath: path.join(root, 'config.json'),
    platform: 'linux',
    gateway,
    run: fixture.agent.run,
    clock: () => new Date('2026-10-10T17:00:00.000Z')
  });
  await assert.rejects(
    () => second.preflight('node-1', { ...context, operationId: 'op-other' }),
    (error) => error.code === 'lock_held'
  );
});

test('rejects direct phase calls out of order and serializes same-operation invocations', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    () => fixture.agent.restart('node-1', fixture.context),
    (error) => error.code === 'phase_order_invalid'
  );
  const inspect = fixture.gateway.inspect;
  fixture.gateway.inspect = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return inspect.apply(fixture.gateway, args);
  };
  const results = await Promise.allSettled([
    fixture.agent.preflight('node-1', fixture.context),
    fixture.agent.preflight('node-1', fixture.context)
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected')[0].reason.code, 'lock_held');
});

test('replaying a cached terminal receipt releases the invocation and operation locks', async (t) => {
  const fixture = await makeFixture(t);
  const { agent, context, root } = fixture;
  await agent.preflight('node-1', context);
  await agent.stage('node-1', context);
  await agent.prepare('node-1', context);
  await agent.swap('node-1', context);
  await agent.restart('node-1', context);
  await agent.verify('node-1', context);
  await agent.canary('node-1', context);
  await agent.promote('node-1', context);
  await agent.release('node-1', context);
  const replay = await agent.release('node-1', context);
  assert.equal(replay.phase, 'release');
  await assert.rejects(() => fs.access(path.join(root, '.deployment-agent.lock')));
});
