import assert from 'node:assert/strict';
import test from 'node:test';
import { SshDeploymentTransport, SshTransportError } from '../src/ssh-deployment-transport.mjs';

const context = {
  operationId: 'op-ssh',
  generation: 1,
  planHash: 'a'.repeat(64),
  nodeId: 'node-1',
  phase: 'preflight',
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
  const transport = new SshDeploymentTransport({
    nodes: { 'node-1': { host: 'gateway-1.internal' } },
    upload: async (node, value) => {
      seen.push({ node, value });
      return { artifactPath: '/srv/lloom/incoming/release.tar', manifestPath: '/srv/lloom/incoming/manifest.json' };
    },
    runSsh: async (_node, _request) => ({
      code: 0,
      stdout: JSON.stringify({
        operationId: 'op-ssh',
        generation: 1,
        nodeId: 'node-1',
        phase: 'stage',
        status: 'ok',
        observedAt: '2026-10-10T17:00:00.000Z',
        staged: true
      })
    })
  });
  await transport.stage('node-1', { ...context, phase: 'stage', secret: 'must-not-be-sent' });
  assert.equal(seen.length, 1);
  assert.equal('secret' in seen[0].value, false);
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
