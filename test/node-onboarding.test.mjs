import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addAuthenticatedNode, parsePositiveTimeoutMs, readBoundedStdinCredential } from '../src/node-onboarding.mjs';

const key = 'fixture-node-secret';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-peer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'config.json');
  const raw = {
    server: { host: '127.0.0.1', port: 8100 },
    cluster: { nodeId: 'head', leaderNode: 'head', nodes: { head: {} } },
    models: [],
    backends: {}
  };
  const bytes = JSON.stringify(raw);
  await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
  return { sourcePath, bytes, config: { ...raw, sourcePath } };
}
function snapshot(id = 'peer') {
  return { ok: true, json: async () => ({ node: { id, models: [{ id: 'model', runtime: 'runtime' }] } }) };
}
test('stdin credentials are bounded and single-line without leaking rejected input', async () => {
  assert.equal(await readBoundedStdinCredential(Readable.from([key + '\n'])), key);
  for (const input of ['', key + '\nsecond', key.repeat(10000)])
    await assert.rejects(readBoundedStdinCredential(Readable.from([input])), (e) => !e.message.includes(key));
});
test('node preview authenticates but never persists or returns the key', async (t) => {
  const f = await fixture(t);
  const result = await addAuthenticatedNode(f.config, {
    nodeId: 'peer',
    endpoint: 'http://peer.test:8100',
    apiKey: key,
    fetchFn: async (url, opts) => {
      assert.equal(opts.headers.authorization, 'Bearer ' + key);
      assert.equal(opts.redirect, 'error');
      return snapshot();
    }
  });
  assert.equal(result.applied, false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(await fs.readFile(f.sourcePath, 'utf8'), f.bytes);
});
test('node apply retains a private pre-change backup and disables telemetry-only inference', async (t) => {
  const f = await fixture(t);
  const result = await addAuthenticatedNode(f.config, {
    nodeId: 'peer',
    endpoint: 'http://peer.test:8100',
    apiKey: key,
    telemetryOnly: true,
    apply: true,
    yes: true,
    fetchFn: async () => snapshot()
  });
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), f.bytes);
  assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o600);
  const current = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
  assert.equal(current.cluster.nodes.peer.apiKey, key);
  assert.deepEqual(current.cluster.nodes.peer.proxy, { enabled: false, models: [] });
  assert.equal(current.cluster.leaderNode, 'head');
  assert.equal(JSON.stringify(result).includes(key), false);
});
test('node identity mismatch, self replacement, and missing confirmation refuse mutation', async (t) => {
  const f = await fixture(t);
  const options = {
    nodeId: 'peer',
    endpoint: 'http://peer.test:8100',
    apiKey: key,
    apply: true,
    yes: true,
    fetchFn: async () => snapshot('wrong')
  };
  await assert.rejects(addAuthenticatedNode(f.config, options), /identity/);
  await assert.rejects(addAuthenticatedNode(f.config, { ...options, nodeId: 'head' }), /local node/);
  await assert.rejects(addAuthenticatedNode(f.config, { ...options, yes: false }), /--apply --yes/);
  assert.equal(await fs.readFile(f.sourcePath, 'utf8'), f.bytes);
});

test('environment credential mode uses the same identity, apply, and privacy guards', async (t) => {
  const f = await fixture(t);
  const opts = {
    nodeId: 'peer',
    endpoint: 'http://peer.test:8100',
    apiKey: key,
    apiKeyEnv: 'FIXTURE_PEER_KEY',
    fetchFn: async () => snapshot()
  };
  await assert.rejects(addAuthenticatedNode(f.config, { ...opts, apply: true }), /--yes/);
  const result = await addAuthenticatedNode(f.config, { ...opts, apply: true, yes: true });
  const peer = JSON.parse(await fs.readFile(f.sourcePath, 'utf8')).cluster.nodes.peer;
  assert.equal(peer.apiKeyEnv, 'FIXTURE_PEER_KEY');
  assert.equal(peer.apiKey, undefined);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('timeout-ms persists on the node and updates only its dedicated backend', async (t) => {
  const f = await fixture(t);
  const raw = JSON.parse(f.bytes);
  raw.cluster.nodes.peer = {
    name: 'Existing peer',
    endpoint: 'http://old-peer.test:8100',
    backendHost: 'old-peer.test',
    labels: { custom: 'preserve' },
    resources: { memoryGb: 96 },
    proxy: {
      backend: 'peer-federation',
      namespace: 'old-namespace',
      timeoutMs: 1_800_000,
      models: []
    }
  };
  raw.backends['peer-federation'] = {
    type: 'openai',
    baseUrl: 'http://old-peer.test:8100/v1',
    apiKeyEnv: 'OLD_PEER_KEY',
    headers: { 'x-fixture': 'preserve' },
    timeoutMs: 1_800_000
  };
  await fs.writeFile(f.sourcePath, JSON.stringify(raw), { mode: 0o600 });
  const result = await addAuthenticatedNode(f.config, {
    nodeId: 'peer',
    endpoint: 'http://peer.test:8100',
    apiKey: key,
    apiKeyEnv: 'NEW_PEER_KEY',
    timeoutMs: '3600000',
    apply: true,
    yes: true,
    fetchFn: async () => snapshot()
  });
  assert.equal(result.timeoutMs, 3_600_000);
  assert.equal(result.backendId, 'peer-federation');
  assert.equal(result.backendTimeoutUpdated, true);
  const current = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
  const peer = current.cluster.nodes.peer;
  assert.equal(peer.endpoint, 'http://peer.test:8100');
  assert.equal(peer.backendHost, 'old-peer.test');
  assert.equal(peer.labels.custom, 'preserve');
  assert.equal(peer.resources.memoryGb, 96);
  assert.equal(peer.apiKeyEnv, 'NEW_PEER_KEY');
  assert.equal(peer.apiKey, undefined);
  assert.equal(peer.proxy.backend, 'peer-federation');
  assert.equal(peer.proxy.timeoutMs, 3_600_000);
  assert.equal(current.backends['peer-federation'].baseUrl, 'http://old-peer.test:8100/v1');
  assert.equal(current.backends['peer-federation'].apiKeyEnv, 'OLD_PEER_KEY');
  assert.deepEqual(current.backends['peer-federation'].headers, { 'x-fixture': 'preserve' });
  assert.equal(current.backends['peer-federation'].timeoutMs, 3_600_000);
});

test('omitting timeout-ms preserves an existing node and backend timeout', async (t) => {
  const f = await fixture(t);
  const raw = JSON.parse(f.bytes);
  raw.cluster.nodes.peer = {
    proxy: { backend: 'peer-federation', timeoutMs: 3_600_000, models: [] }
  };
  raw.backends['peer-federation'] = {
    type: 'openai',
    baseUrl: 'http://peer.test:8100/v1',
    timeoutMs: 3_600_000
  };
  await fs.writeFile(f.sourcePath, JSON.stringify(raw), { mode: 0o600 });
  await addAuthenticatedNode(f.config, {
    nodeId: 'peer',
    endpoint: 'http://peer.test:8100',
    apiKey: key,
    apply: true,
    yes: true,
    fetchFn: async () => snapshot()
  });
  const current = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
  assert.equal(current.cluster.nodes.peer.proxy.timeoutMs, 3_600_000);
  assert.equal(current.backends['peer-federation'].timeoutMs, 3_600_000);
});

test('timeout-ms refuses a backend shared by another federation node', async (t) => {
  const f = await fixture(t);
  const raw = JSON.parse(f.bytes);
  raw.cluster.nodes.peer = { proxy: { backend: 'shared-federation', models: [] } };
  raw.cluster.nodes.other = { proxy: { backend: 'shared-federation', models: [] } };
  raw.backends['shared-federation'] = {
    type: 'openai',
    baseUrl: 'http://shared.test:8100/v1',
    timeoutMs: 1_800_000
  };
  await fs.writeFile(f.sourcePath, JSON.stringify(raw), { mode: 0o600 });
  await assert.rejects(
    addAuthenticatedNode(f.config, {
      nodeId: 'peer',
      endpoint: 'http://peer.test:8100',
      apiKey: key,
      timeoutMs: 3_600_000,
      apply: true,
      yes: true,
      fetchFn: async () => snapshot()
    }),
    /shared-federation.*other/
  );
  const current = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
  assert.equal(current.cluster.nodes.peer.proxy.timeoutMs, undefined);
  assert.equal(current.backends['shared-federation'].timeoutMs, 1_800_000);
});

test('timeout-ms accepts only positive safe integers', () => {
  assert.equal(parsePositiveTimeoutMs('3600000'), 3_600_000);
  assert.equal(parsePositiveTimeoutMs(3_600_000), 3_600_000);
  for (const value of [undefined, null, '', 0, -1, '0', '1.5', '1e3', Number.MAX_SAFE_INTEGER + 1]) {
    if (value == null || value === '') assert.equal(parsePositiveTimeoutMs(value), undefined);
    else assert.throws(() => parsePositiveTimeoutMs(value), /positive integer/);
  }
});
