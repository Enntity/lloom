import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NodeReleaseAgent } from '../src/node-release-agent.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const OLD_ARTIFACT = 'old-artifact-content';
const OLD_ARTIFACT_SHA = sha(OLD_ARTIFACT);
const CONFIG = '{"gateway":"reviewed"}\n';
const CONFIG_SHA = sha(CONFIG);
const DEP = '1'.repeat(64);
const CONTRACT = '2'.repeat(64);

async function makeFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-node-agent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'gateway');
  const input = path.join(directory, 'reviewed');
  await fs.mkdir(path.join(root, 'releases', 'old'), { recursive: true });
  await fs.mkdir(input, { recursive: true });
  await fs.symlink('releases/old', path.join(root, 'current'));
  await fs.writeFile(path.join(root, 'config.json'), CONFIG);
  const oldManifest = JSON.stringify({
    releaseId: 'release-old',
    sha256: OLD_ARTIFACT_SHA,
    dependencyDigest: DEP,
    runtimeContractDigest: CONTRACT
  });
  await fs.writeFile(path.join(root, 'current.manifest.json'), oldManifest);
  const artifact = Buffer.from('next-artifact-content');
  const artifactPath = path.join(input, 'release.tar');
  await fs.writeFile(artifactPath, artifact);
  const artifactSha = sha(artifact);
  const manifest = Buffer.from(
    JSON.stringify({
      releaseId: 'release-next',
      sha256: artifactSha,
      dependencyDigest: DEP,
      runtimeContractDigest: CONTRACT
    })
  );
  const manifestPath = path.join(input, 'manifest.json');
  await fs.writeFile(manifestPath, manifest);
  const loaded = { value: 'old' };
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
          : undefined
      };
    },
    async prepare() {
      return { fenced: true, drained: true };
    },
    async reprepare() {
      return { fenced: true, drained: true };
    },
    async release() {
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
        cloudFallback: false
      };
    }
  };
  const run = async (command, argv) => {
    calls.push([command, ...argv]);
    return { code: 0, stdout: 'active\n', stderr: '' };
  };
  const agent = new NodeReleaseAgent({
    nodeId: 'node-1',
    root,
    configPath: path.join(root, 'config.json'),
    platform: 'linux',
    gateway,
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
  const { agent, context, loaded, calls } = fixture;
  const preflight = await agent.preflight('node-1', context);
  assert.equal(preflight.currentIdentity.releaseId, 'release-old');
  const stage = await agent.stage('node-1', context);
  assert.equal(stage.staged, true);
  const prepared = await agent.prepare('node-1', context);
  assert.equal(prepared.fenced, true);
  loaded.value = 'next';
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
  await assert.rejects(
    () => fixture.agent.stage('node-1', bad),
    (error) => error.code === 'artifact_digest_mismatch'
  );
  assert.equal(await fs.stat(path.join(fixture.root, 'releases')).then(() => true), true);
  assert.equal((await fs.readdir(path.join(fixture.root, 'releases'))).length, 1);
});

test('restores a prepared node under a fresh fence and keeps it fenced', async (t) => {
  const fixture = await makeFixture(t);
  const { agent, context, loaded, root } = fixture;
  await agent.preflight('node-1', context);
  await agent.stage('node-1', context);
  await agent.prepare('node-1', context);
  loaded.value = 'next';
  await agent.swap('node-1', context);
  const rollback = await agent.rollback('node-1', context);
  assert.equal(rollback.restored, true);
  assert.equal(rollback.fenced, true);
  const restored = JSON.parse(await fs.readFile(path.join(root, 'current.manifest.json'), 'utf8'));
  assert.equal(restored.releaseId, 'release-old');
  assert.equal(await fs.readlink(path.join(root, 'current')), 'releases/old');
});

test('returns the durable receipt on repeated phase calls', async (t) => {
  const fixture = await makeFixture(t);
  const first = await fixture.agent.preflight('node-1', fixture.context);
  const second = await fixture.agent.preflight('node-1', fixture.context);
  assert.deepEqual(second, first);
  assert.equal(fixture.calls.filter((entry) => entry[2] === 'is-active').length, 1);
});
