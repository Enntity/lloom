// Pool membership over HTTP: an in-process head on a temp config. Covers the
// auth boundary (enrollment token, node secret, admin keys), persistence and
// the node-side heartbeat loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createPoolHeartbeatLoop, resolvePoolNodeSecret } from '../src/pool-node.mjs';
import { authorizeRequest, classifyRoute } from '../src/security.mjs';
import { createLloomServer } from '../src/server.mjs';

const ADMIN = 'fixture-admin-key';
const INFERENCE = 'fixture-inference-key';
const logger = { info() {}, warn() {}, error() {} };

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-pool-membership-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startHead(t, { dir, pool, serverOptions = {} } = {}) {
  dir ??= await tempDir(t);
  const configPath = path.join(dir, 'config.json');
  const raw = {
    server: { host: '127.0.0.1', port: 0 },
    security: { adminApiKeys: [ADMIN], apiKeys: [INFERENCE] },
    cluster: { nodeId: 'head' },
    ...(pool ? { pool } : {}),
    backends: {},
    models: []
  };
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
  const config = await loadConfig(configPath, { env: {} });
  const app = createLloomServer(config, { logger, ...serverOptions });
  await app.listen();
  t.after(() => app.close({ stopRuntimes: false, httpGraceMs: 0 }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (pathname, { key, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(base + pathname, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, json: await response.json() };
  };
  return { dir, base, call, membershipPath: path.join(dir, 'pool-membership.json') };
}

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false
  );

test('pool node routes authenticate in their handlers, not with API keys', () => {
  assert.equal(classifyRoute('POST', '/gateway/pool/enroll'), 'pool-node');
  assert.equal(classifyRoute('POST', '/gateway/pool/heartbeat'), 'pool-node');
  assert.equal(classifyRoute('GET', '/gateway/pool/enroll'), 'admin-read');
  assert.equal(classifyRoute('GET', '/gateway/pool/members'), 'admin-read');
  assert.equal(classifyRoute('POST', '/gateway/pool/tokens'), 'admin-write');
  assert.equal(classifyRoute('POST', '/gateway/pool/nodes/a/cordon'), 'admin-write');
  assert.equal(classifyRoute('POST', '/gateway/pool/enroll/x'), 'admin-write');
  // A non-loopback head with no remote admin still accepts enrollment and
  // heartbeats; the handler checks the token or secret.
  const remote = { server: { host: '10.0.0.1' }, security: { apiKeys: [INFERENCE] } };
  const req = (pathname, origin) => ({
    headers: { host: '10.0.0.1:8100', ...(origin ? { origin } : {}) },
    method: 'POST',
    url: pathname
  });
  assert.equal(
    authorizeRequest(req('/gateway/pool/enroll'), remote, { method: 'POST', pathname: '/gateway/pool/enroll' }).ok,
    true
  );
  assert.equal(
    authorizeRequest(req('/gateway/pool/tokens'), remote, { method: 'POST', pathname: '/gateway/pool/tokens' }).ok,
    false
  );
  assert.equal(
    authorizeRequest(req('/gateway/pool/enroll', 'https://evil.example'), remote, {
      method: 'POST',
      pathname: '/gateway/pool/enroll'
    }).code,
    'admin_origin_denied',
    'browsers on another origin cannot reach the enrollment route'
  );
});

test('membership stays inert and writes nothing until a token is issued', async (t) => {
  const head = await startHead(t);
  const members = await head.call('/gateway/pool/members', { key: ADMIN });
  assert.equal(members.status, 200);
  assert.deepEqual(members.json.members, []);
  assert.equal((await head.call('/gateway/pool/heartbeat', { body: { nodeId: 'x' }, key: 'lps_x' })).status, 401);
  assert.equal((await head.call('/gateway/pool/enroll', { body: { nodeId: 'x' } })).status, 401);
  assert.equal((await head.call('/gateway/pool/nodes/x/cordon', { key: ADMIN, body: {} })).status, 404);
  assert.equal(await exists(head.membershipPath), false);
});

test('enroll, heartbeat, cordon and restart over HTTP', async (t) => {
  const head = await startHead(t);
  for (const key of [undefined, INFERENCE, 'lps_' + 'A'.repeat(43)]) {
    assert.equal((await head.call('/gateway/pool/tokens', { key, body: {} })).status, 401, `token create as ${key}`);
  }
  const issued = await head.call('/gateway/pool/tokens', { key: ADMIN, body: { ttlMs: 600000, uses: 2 } });
  assert.equal(issued.status, 200);
  assert.match(issued.json.token, /^lpt_/);
  const stat = await fs.stat(head.membershipPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(head.membershipPath, 'utf8')).includes(issued.json.token.split('_').at(-1)));

  // An admin key is not an enrollment token, and enrollment never grants one.
  const asAdmin = await head.call('/gateway/pool/enroll', {
    key: ADMIN,
    body: { nodeId: 'spark-node-01', endpoint: 'http://10.0.0.1:8100' }
  });
  assert.equal(asAdmin.status, 401);
  assert.equal(asAdmin.json.error.code, 'invalid_enrollment_token');
  const self = await head.call('/gateway/pool/enroll', {
    key: issued.json.token,
    body: { nodeId: 'head', endpoint: 'http://10.0.0.1:8100' }
  });
  assert.equal(self.status, 409, 'a node cannot enroll as the head');

  const enrolled = await head.call('/gateway/pool/enroll', {
    key: issued.json.token,
    body: { nodeId: 'spark-node-01', endpoint: 'http://10.0.0.1:8100', labels: { rack: 'a' } }
  });
  assert.equal(enrolled.status, 200);
  const { nodeSecret } = enrolled.json;
  assert.match(nodeSecret, /^lps_/);
  assert.deepEqual(Object.keys(enrolled.json).sort(), ['leaseMs', 'nodeId', 'nodeSecret', 'ok']);
  assert.ok(!(await fs.readFile(head.membershipPath, 'utf8')).includes(nodeSecret.slice(4)));

  // The node secret only works for heartbeats.
  for (const [pathname, body] of [
    ['/gateway/pool/members', undefined],
    ['/gateway/pool/tokens', {}],
    ['/gateway/pool/nodes/spark-node-01/uncordon', {}],
    ['/gateway/status', undefined]
  ]) {
    assert.equal((await head.call(pathname, { key: nodeSecret, body })).status, 401, pathname);
  }
  assert.equal(
    (await head.call('/gateway/pool/heartbeat', { key: ADMIN, body: { nodeId: 'spark-node-01' } })).status,
    401,
    'an admin key is not a node secret'
  );
  const heartbeat = {
    nodeId: 'spark-node-01',
    running: ['small'],
    inventory: { complete: true, computeArchs: ['sm_121'] }
  };
  let beat = await head.call('/gateway/pool/heartbeat', { key: nodeSecret, body: heartbeat });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.cordoned, false);

  const cordoned = await head.call('/gateway/pool/nodes/spark-node-01/drain', {
    key: ADMIN,
    body: { reason: 'swap disks' }
  });
  assert.equal(cordoned.status, 200);
  assert.equal(cordoned.json.member.draining, true);
  beat = await head.call('/gateway/pool/heartbeat', { key: nodeSecret, body: heartbeat });
  assert.equal(beat.json.draining, true);

  const listed = await head.call('/gateway/pool/members', { key: ADMIN });
  assert.equal(listed.json.leaseMs, 30000);
  const [member] = listed.json.members;
  assert.equal(member.id, 'spark-node-01');
  assert.equal(member.state, 'ready');
  assert.equal(member.reason, 'swap disks');
  assert.deepEqual(member.running, ['small']);
  assert.ok(!JSON.stringify(listed.json).includes(nodeSecret));

  const bad = await head.call('/gateway/pool/nodes/spark-node-01/cordon', { key: ADMIN, body: { reason: 7 } });
  assert.equal(bad.status, 400);

  // A restarted head keeps members, cordons and secrets.
  const restarted = await startHead(t, { dir: await tempDir(t) });
  await fs.copyFile(head.membershipPath, restarted.membershipPath);
  beat = await restarted.call('/gateway/pool/heartbeat', { key: nodeSecret, body: heartbeat });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.draining, true);
});

test('enrollment attempts are rate limited per client', async (t) => {
  const head = await startHead(t);
  const statuses = [];
  for (let index = 0; index < 14; index += 1) {
    const response = await head.call('/gateway/pool/enroll', {
      key: 'lpt_000000000000_' + 'A'.repeat(43),
      body: { nodeId: 'x', endpoint: 'http://x:8100' }
    });
    statuses.push(response.status);
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      assert.equal(response.json.error.code, 'pool_enroll_rate_limited');
    }
  }
  assert.ok(statuses.slice(0, 10).every((status) => status === 401));
  assert.equal(statuses.at(-1), 429);
});

test('oversized and malformed pool bodies are rejected', async (t) => {
  const head = await startHead(t);
  const huge = await fetch(head.base + '/gateway/pool/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: 'x', inventory: { padding: 'x'.repeat(2 * 1024 * 1024) } })
  });
  assert.equal(huge.status, 413);
  const malformed = await fetch(head.base + '/gateway/pool/heartbeat', { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
});

test('a node with pool.head heartbeats to the head from serve', async (t) => {
  const head = await startHead(t);
  const issued = await head.call('/gateway/pool/tokens', { key: ADMIN, body: {} });
  const enrolled = await head.call('/gateway/pool/enroll', {
    key: issued.json.token,
    body: { nodeId: 'worker', endpoint: 'http://10.0.0.2:8100' }
  });
  const nodeDir = await tempDir(t);
  await fs.writeFile(path.join(nodeDir, 'pool-node-secret'), enrolled.json.nodeSecret + '\n', { mode: 0o600 });
  await startHead(t, {
    dir: nodeDir,
    pool: { head: { url: head.base, nodeId: 'worker', secretFile: 'pool-node-secret', intervalMs: 50 } },
    serverOptions: {
      nodeInventory: { get: async () => ({ nodeId: 'worker', complete: true, computeArchs: ['sm_121'] }) }
    }
  });
  const deadline = Date.now() + 20000;
  let member;
  while (Date.now() < deadline) {
    [member] = (await head.call('/gateway/pool/members', { key: ADMIN })).json.members;
    if (member.inventory) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(member.state, 'ready');
  assert.equal(member.inventory.nodeId, undefined, 'only planner fields are kept');
  assert.deepEqual(member.inventory.computeArchs, ['sm_121']);
  assert.deepEqual(member.running, []);
});

test('node secrets come from an env var or a private file', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.json');
  const secret = 'lps_' + 'B'.repeat(43);
  assert.equal(
    await resolvePoolNodeSecret({ secretEnv: 'POOL_SECRET' }, { configPath, env: { POOL_SECRET: secret } }),
    secret
  );
  await assert.rejects(resolvePoolNodeSecret({ secretEnv: 'POOL_SECRET' }, { configPath, env: {} }), /POOL_SECRET/);
  const file = path.join(dir, 'secret');
  await fs.writeFile(file, secret + '\n', { mode: 0o600 });
  assert.equal(await resolvePoolNodeSecret({ secretFile: 'secret' }, { configPath }), secret);
  await fs.chmod(file, 0o644);
  await assert.rejects(resolvePoolNodeSecret({ secretFile: 'secret' }, { configPath }), /private/);
  await fs.chmod(file, 0o600);
  await fs.symlink(file, path.join(dir, 'link'));
  await assert.rejects(resolvePoolNodeSecret({ secretFile: 'link' }, { configPath }), /regular file/);
  await assert.rejects(resolvePoolNodeSecret({}, { configPath }), /secretEnv or secretFile/);
});

test('the heartbeat loop backs off on failure and resets on success', async () => {
  const delays = [];
  let failures = 2;
  const sent = [];
  const loop = createPoolHeartbeatLoop({
    getHead: () => ({ url: 'http://head.test:8100', nodeId: 'worker', secretEnv: 'S', intervalMs: 1000 }),
    configPath: '/nonexistent/config.json',
    env: { S: 'lps_' + 'C'.repeat(43) },
    collect: async () => ({ inventory: { complete: true }, running: ['a'], telemetry: null }),
    fetchImpl: async (url, options) => {
      sent.push({ url, options });
      if (failures-- > 0) return new Response('{}', { status: 503 });
      return Response.json({ ok: true, cordoned: false, draining: false });
    },
    logger,
    schedule: (fn, ms) => {
      delays.push(ms);
      return { unref() {}, fn };
    },
    cancel: () => {},
    random: () => 0.5
  });
  for (let index = 0; index < 3; index += 1) await loop.tick();
  assert.deepEqual(delays, [2000, 4000, 1000]);
  assert.equal(sent[0].url, 'http://head.test:8100/gateway/pool/heartbeat');
  assert.equal(sent[0].options.headers.authorization, 'Bearer lps_' + 'C'.repeat(43));
  assert.equal(sent[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(sent[0].options.body), {
    nodeId: 'worker',
    inventory: { complete: true },
    running: ['a'],
    telemetry: null
  });
  assert.equal(loop.status().failures, 0);
  await loop.stop();
});
