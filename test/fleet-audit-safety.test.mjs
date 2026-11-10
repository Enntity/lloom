import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { reconcileImportedModels } from '../src/node-onboarding.mjs';
import { gatewayRequest } from '../src/gateway-client.mjs';

test('maintenance cannot kill a foreign listener even with legacy cleanupPort opt-in', async (t) => {
  const server = http.createServer((_req, res) => res.end('foreign'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = server.address().port;
  const manager = new RuntimeManager({
    runtimes: { stale: { enabled: true, port, healthUrl: `http://127.0.0.1:${port}` } }
  });
  const result = await manager.stop('stale', { cleanupPort: true });
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'runtime-process-ownership');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign');
});

test('federation reconciliation protects references and mixed ownership while refreshing metadata', () => {
  const owned = (id) => ({
    id,
    federated: true,
    context: 123,
    targets: [{ node: 'peer', backend: 'lloom-node-peer', upstreamModel: id }]
  });
  const raw = {
    models: [
      owned('gone'),
      owned('pinned'),
      owned('retained'),
      { ...owned('mixed'), targets: [{ node: 'peer' }, { node: 'local' }] },
      { id: 'manual' }
    ],
    defaults: { chat: 'pinned' }
  };
  const node = {
    endpoint: 'http://127.0.0.1:8101',
    proxy: { namespace: false, models: [{ id: 'retained', context: 65536, capabilities: ['chat'] }] }
  };
  const result = reconcileImportedModels(raw, 'peer', node);
  assert.deepEqual(result.report.removed, ['gone']);
  assert.deepEqual(result.report.protected, ['pinned']);
  assert.deepEqual(result.report.ambiguous, ['mixed']);
  assert.equal(result.models.find((m) => m.id === 'retained').context, 65536);
  assert.equal(
    result.models.find((m) => m.id === 'mixed'),
    raw.models[3]
  );
  assert.equal(raw.models.length, 5);
});

test('CLI gateway errors preserve bounded admission diagnostics and redact credentials', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'runtime_admission_error',
          code: 'runtime_capacity_impossible',
          message: 'budget rejected secret-admin-value',
          details: { credential: 'secret-admin-value' }
        }
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    gatewayRequest(
      { server: { port: server.address().port }, security: { adminApiKeys: ['secret-admin-value'] } },
      '/gateway/models/test/resume'
    ),
    (error) => {
      assert.match(error.message, /budget rejected \[redacted\]/);
      assert.equal(error.upstreamCode, 'runtime_capacity_impossible');
      assert.ok(!JSON.stringify(error).includes('secret-admin-value'));
      return true;
    }
  );
});

test('runtime recipe changes preserve maintenance instead of auto-starting or rejecting reload', async () => {
  const config = {
    runtimes: {
      r: { enabled: true, keepWarm: true, command: '/bin/true', args: ['old'], maintenance: { state: 'suspended' } }
    }
  };
  const manager = new RuntimeManager(config);
  let starts = 0;
  manager.admit = async () => {
    starts++;
    throw new Error('must not start');
  };
  const next = structuredClone(config);
  next.runtimes.r.args = ['new'];
  const result = await manager.reconfigure(next);
  assert.equal(starts, 0);
  assert.ok(result.results.some((entry) => entry.reason === 'maintenance'));
  assert.equal(manager.config.runtimes.r.maintenance.state, 'suspended');
});
