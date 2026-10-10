import assert from 'node:assert/strict';
import test from 'node:test';
import { SshDeploymentTransport, SshTransportError } from '../src/ssh-deployment-transport.mjs';

const context = {
  operationId: 'op-ssh',
  generation: 1,
  planHash: 'a'.repeat(64),
  nodeId: 'node-1',
  phase: 'preflight',
  artifact: {
    id: 'release-next',
    path: '/srv/lloom/incoming/release-next.tar',
    manifestPath: '/srv/lloom/incoming/release-next.tar.manifest.json',
    sha256: 'd'.repeat(64),
    manifestSha256: 'e'.repeat(64),
    reviewed: true
  },
  scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' }
};

test('builds a shell-free SSH request and parses the public receipt', async () => {
  const requests = [];
  const transport = new SshDeploymentTransport({
    nodes: { 'node-1': { host: 'gateway-1.internal', user: 'deploy', port: 2222, hostKeyAlias: 'gateway-1' } },
    runSsh: async (node, request) => {
      requests.push({ node, request });
      return {
        code: 0,
        stdout: JSON.stringify({
          operationId: 'op-ssh',
          generation: 1,
          nodeId: 'node-1',
          phase: 'preflight',
          status: 'ok',
          observedAt: '2026-10-10T17:00:00.000Z'
        })
      };
    }
  });
  const receipt = await transport.preflight('node-1', context);
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(requests[0].request.argv, [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'HostKeyAlias=gateway-1',
    '-p',
    '2222',
    'deploy@gateway-1.internal',
    'lloom',
    'node-agent',
    'preflight',
    '--json'
  ]);
  assert.match(requests[0].request.input, /op-ssh/);
});

test('uploads only reviewed paths before stage and does not persist credentials', async () => {
  const seen = [];
  const requests = [];
  const transport = new SshDeploymentTransport({
    nodes: { 'node-1': { host: 'gateway-1.internal' } },
    upload: async (node, value) => {
      seen.push({ node, value });
      return {
        artifactPath: context.artifact.path,
        manifestPath: context.artifact.manifestPath
      };
    },
    runSsh: async (_node, request) => {
      requests.push(request);
      return {
        code: 0,
        stdout: JSON.stringify({
          operationId: 'op-ssh',
          generation: 1,
          nodeId: 'node-1',
          phase: request.phase,
          status: 'ok',
          observedAt: '2026-10-10T17:00:00.000Z',
          staged: request.phase === 'stage'
        })
      };
    }
  });
  await transport.stage('node-1', { ...context, phase: 'stage', secret: 'must-not-be-sent' });
  await transport.swap('node-1', { ...context, phase: 'swap' });
  assert.equal(seen.length, 1);
  assert.equal('secret' in seen[0].value, false);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const input = JSON.parse(request.input);
    assert.equal(input.artifact.path, context.artifact.path);
    assert.equal(input.artifact.manifestPath, context.artifact.manifestPath);
  }
});

test('rejects upload paths that cannot survive a fresh process resume', async () => {
  const transport = new SshDeploymentTransport({
    nodes: { 'node-1': { host: 'gateway-1.internal' } },
    upload: async () => ({ artifactPath: '/tmp/other.tar', manifestPath: '/tmp/other.manifest.json' }),
    runSsh: async () => ({ code: 0, stdout: '{}' })
  });
  await assert.rejects(
    () => transport.stage('node-1', { ...context, phase: 'stage' }),
    (error) => error instanceof SshTransportError && error.code === 'upload_path_mismatch'
  );
});

test('extends SSH drain deadlines from the bounded fence timeout', async () => {
  const timeouts = [];
  const transport = new SshDeploymentTransport({
    nodes: { 'node-1': { host: 'gateway-1.internal' } },
    runSsh: async (_node, request) => {
      timeouts.push(request.timeoutMs);
      return { code: 0, stdout: '{}' };
    }
  });
  await transport.prepare('node-1', { ...context, phase: 'prepare', drainTimeoutMs: 900000 });
  await transport.reprepare('node-1', { ...context, phase: 'reprepare' });
  assert.deepEqual(timeouts, [960000, 360000]);
  await assert.rejects(
    () => transport.prepare('node-1', { ...context, phase: 'prepare', drainTimeoutMs: 3600001 }),
    (error) => error instanceof SshTransportError && error.code === 'invalid_timeout'
  );
});

test('rejects unsafe endpoints and malformed remote receipts', async () => {
  assert.throws(
    () => new SshDeploymentTransport({ nodes: { node: { host: 'bad;host' } } }),
    (error) => error instanceof SshTransportError && error.code === 'invalid_transport_config'
  );
  const transport = new SshDeploymentTransport({
    nodes: { 'node-1': { host: 'gateway-1.internal' } },
    runSsh: async () => ({ code: 0, stdout: 'not-json' })
  });
  await assert.rejects(
    () => transport.preflight('node-1', context),
    (error) => error instanceof SshTransportError && error.code === 'invalid_receipt'
  );
});
