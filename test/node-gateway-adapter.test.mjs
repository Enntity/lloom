import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeGatewayAdapter, NodeGatewayAdapterError } from '../src/node-gateway-adapter.mjs';

const digest = (letter) => letter.repeat(64);
const IDENTITY = {
  releaseId: 'release-next',
  artifactSha256: digest('a'),
  manifestSha256: digest('b'),
  configSha256: digest('c'),
  dependencyDigest: digest('d'),
  runtimeContractDigest: digest('e')
};

function response(payload, status = 200) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name === 'content-length' ? String(Buffer.byteLength(text)) : null;
      }
    },
    async text() {
      return text;
    },
    async json() {
      return payload;
    }
  };
}

test('uses authenticated loopback fence API and preserves strict receipts', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/deployment-fence/status'))
      return response({
        protocol: 1,
        ok: true,
        state: requests.some(({ url }) => url.endsWith('/prepare')) ? 'prepared' : 'open',
        fenced: false,
        releaseIdentity: IDENTITY,
        operation: { opId: 'op-1', generation: 7 }
      });
    if (url.endsWith('/gateway/status'))
      return response({
        protocol: 1,
        atomicLayout: true,
        serviceActive: true,
        releaseIdentity: IDENTITY,
        runtimeSnapshot: { pid: 3 }
      });
    if (url.endsWith('/deployment-fence/prepare'))
      return response({ protocol: 1, state: 'prepared', fenced: true, drained: true, generation: 7 });
    if (url.endsWith('/deployment-fence/canary'))
      return response({
        healthy: true,
        fenced: true,
        privileged: true,
        aliasUsed: false,
        cloudFallback: false,
        source: 'local',
        gatewayModelId: 'atlas/local',
        runtimeId: 'atlas-runtime'
      });
    if (url.endsWith('/deployment-fence/release')) return response({ released: true, fenced: false });
    return response({}, 404);
  };
  const adapter = new NodeGatewayAdapter({ adminApiKey: 'synthetic-key', fetchFn });
  const inspection = await adapter.inspect();
  assert.equal(inspection.atomicLayout, true);
  assert.deepEqual(inspection.loadedIdentity, IDENTITY);
  await adapter.prepare({ operationId: 'op-1' });
  // A real node-agent phase is a fresh process. Generation recovery must come
  // from the authenticated durable fence status, not this adapter's memory.
  const resumedAdapter = new NodeGatewayAdapter({ adminApiKey: 'synthetic-key', fetchFn });
  const canary = await resumedAdapter.canary({
    operationId: 'op-1',
    canary: { gatewayModelId: 'atlas/local', runtimeId: 'atlas-runtime' }
  });
  assert.equal(canary.source, 'local');
  await resumedAdapter.release({ operationId: 'op-1' });
  assert.ok(requests.every(({ options }) => options.headers.authorization === 'Bearer synthetic-key'));
  assert.deepEqual(JSON.parse(requests.find(({ url }) => url.endsWith('/prepare')).options.body), { opId: 'op-1' });
  const canaryRequest = requests.find(({ url }) => url.endsWith('/canary'));
  const canaryBody = JSON.parse(canaryRequest.options.body);
  assert.equal(canaryBody.request.max_tokens, 8);
  assert.equal(canaryBody.request.stream, false);
  assert.equal(canaryBody.request.runtimeId, undefined);
});

test('refuses remote gateways and unsupported fence protocol', async () => {
  assert.throws(
    () => new NodeGatewayAdapter({ baseUrl: 'https://gateway.example', adminApiKey: 'key' }),
    (error) => {
      assert.equal(error.code, 'unsupported_gateway_url');
      return true;
    }
  );
  const adapter = new NodeGatewayAdapter({
    adminApiKey: 'key',
    fetchFn: async () => response({ protocol: 0, ok: true, state: 'open', fenced: false })
  });
  await assert.rejects(
    () => adapter.inspect(),
    (error) => error instanceof NodeGatewayAdapterError && error.code === 'fence_protocol_mismatch'
  );
});

test('accepts bracketed IPv6 loopback and cancels oversized chunked responses', async () => {
  assert.doesNotThrow(() => new NodeGatewayAdapter({ baseUrl: 'http://[::1]:8100', adminApiKey: 'key' }));
  let cancelled = false;
  const adapter = new NodeGatewayAdapter({
    adminApiKey: 'key',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              return { done: false, value: Buffer.alloc(1024 * 1024 + 1, 65) };
            },
            async cancel() {
              cancelled = true;
            },
            releaseLock() {}
          };
        }
      }
    })
  });
  await assert.rejects(
    () => adapter.inspect(),
    (error) => error instanceof NodeGatewayAdapterError && error.code === 'response_too_large'
  );
  assert.equal(cancelled, true);
});
