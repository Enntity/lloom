import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addAuthenticatedNode, readBoundedStdinCredential } from '../src/node-onboarding.mjs';

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
