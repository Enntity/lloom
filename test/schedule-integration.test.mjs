import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createLloomServer } from '../src/server.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { assertMaintenanceStartAllowed } from '../src/model-maintenance.mjs';

const quiet = { info() {}, warn() {}, error() {} };
const cli = fileURLToPath(new URL('../bin/lloom.mjs', import.meta.url));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

// A stand-in owner gateway for a remote node: records admin calls.
async function remoteGateway(t) {
  const calls = [];
  const state = { route: 'local-atlas', failResume: false, suspended: false };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/gateway/routing') {
      res.end(JSON.stringify({ routes: [{ alias: 'omp', activeRoute: state.route }] }));
    } else if (req.url === '/gateway/routes/omp/profile') {
      state.route = body.profile;
      res.end(JSON.stringify({ changed: true, alias: 'omp', activeRoute: body.profile }));
    } else if (req.url === '/gateway/models/pair-model/suspend') {
      // A dry run reports the runtime's current maintenance record.
      res.end(
        JSON.stringify(
          body.apply
            ? { applied: true, status: 'suspended' }
            : { applied: false, state: { 'pair-runtime': state.suspended ? { state: 'suspended' } : null } }
        )
      );
    } else if (req.url === '/gateway/models/pair-model/resume') {
      if (state.failResume) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'runtime failed health check after resume' } }));
      } else res.end(JSON.stringify({ applied: true, status: 'ready' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url, calls, state };
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-schedule-http-'));
  const remote = await remoteGateway(t);
  const raw = {
    server: { host: '127.0.0.1', port: 0 },
    security: { apiKeys: ['synthetic-inference'], adminApiKeys: ['synthetic-admin'] },
    logging: { metricsPersistence: false },
    runtimePolicy: { enabled: false },
    backends: { test: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } },
    runtimes: { resident: { enabled: true, keepWarm: false } },
    models: [
      { id: 'local', backend: 'test', runtime: 'resident', upstreamModel: 'local' },
      { id: 'cloud', backend: 'test', upstreamModel: 'cloud' }
    ],
    aliases: {
      chat: {
        members: ['local', 'cloud'],
        activeRoute: 'local',
        routeProfiles: { local: { members: ['local', 'cloud'] }, cloud: { members: ['cloud'] } }
      }
    },
    cluster: {
      nodeId: 'head',
      nodes: {
        head: { endpoint: 'http://127.0.0.1:1' },
        pairhost: { endpoint: remote.url, apiKey: 'remote-admin' }
      }
    },
    reservations: {
      resources: {
        gpu: { description: 'local GPU', routes: [{ alias: 'chat', profile: 'cloud' }], suspend: ['local'] },
        pair: {
          hosts: ['pairhost'],
          routes: [{ alias: 'omp', profile: 'cloud', node: 'pairhost' }],
          suspend: [{ model: 'pair-model', node: 'pairhost' }]
        }
      }
    }
  };
  const sourcePath = path.join(dir, 'config.json');
  await fs.writeFile(sourcePath, JSON.stringify(raw));
  const config = await loadConfig(sourcePath);
  const manager = new RuntimeManager(config, { logger: quiet });
  let healthy = true;
  manager.status = async () => ({ runtimes: { resident: { status: healthy ? 'running' : 'stopped', healthy } } });
  manager.isHealthy = async () => healthy;
  manager.runtimeAppearsLoaded = async () => healthy;
  manager.ensure = async (id) => assertMaintenanceStartAllowed(manager.config, id);
  manager.stop = async (id) => {
    healthy = false;
    manager.setStatus(id, 'stopped');
  };
  manager.admit = async () => {
    healthy = true;
  };
  const app = createLloomServer(config, { runtimeManager: manager, logger: quiet });
  const url = await listen(app.server);
  t.after(async () => {
    await app.close({ stopRuntimes: false, httpGraceMs: 100 });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const call = async (method, route, body, key = 'synthetic-admin') => {
    const response = await fetch(url + route, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
  };
  return { call, sourcePath, remote, dir, url, isHealthy: () => healthy };
}

test('HTTP reservations route away, suspend, and restore through the local gateway', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('GET', '/gateway/schedule', undefined, null)).status, 401);
  assert.equal((await f.call('GET', '/gateway/schedule', undefined, 'synthetic-inference')).status, 401);

  const preview = await f.call('POST', '/gateway/schedule/reservations', { resource: 'gpu', owner: 'main' });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.applied, false);

  const taken = await f.call('POST', '/gateway/schedule/reservations', {
    resource: 'gpu',
    owner: 'main',
    purpose: 'kernel A/B',
    apply: true,
    yes: true
  });
  assert.equal(taken.status, 200, JSON.stringify(taken.json));
  assert.equal(taken.json.state, 'active');
  let source = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
  assert.equal(source.aliases.chat.activeRoute, 'cloud');
  assert.equal(source.runtimes.resident.maintenance.state, 'suspended');
  assert.equal(f.isHealthy(), false);

  const busy = await f.call('POST', '/gateway/schedule/reservations', {
    resource: 'gpu',
    owner: 'other',
    apply: true,
    yes: true
  });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, 'schedule_busy');
  assert.equal(busy.json.error.details.holders[0].owner, 'main');

  const job = await f.call('POST', '/gateway/schedule/jobs', {
    title: 'kernel A/B',
    owner: 'main',
    resource: 'gpu',
    session: 'claude:abc'
  });
  assert.equal(job.json.reservationId, taken.json.id);
  const progressed = await f.call('POST', `/gateway/schedule/jobs/${job.json.id}`, {
    note: 'arm 1 done',
    progress: { done: 1, total: 2 },
    metrics: { tok_s: 51.5 }
  });
  assert.equal(progressed.json.progress.total, 2);
  const board = await f.call('GET', '/gateway/schedule');
  assert.deepEqual(board.json.resources.find((entry) => entry.id === 'gpu').holders, [taken.json.id]);
  assert.equal(board.json.jobs[0].note, 'arm 1 done');

  const released = await f.call('POST', `/gateway/schedule/reservations/${taken.json.id}/release`, {
    owner: 'main',
    apply: true,
    yes: true
  });
  assert.equal(released.status, 200, JSON.stringify(released.json));
  assert.equal(released.json.state, 'released');
  source = JSON.parse(await fs.readFile(f.sourcePath, 'utf8'));
  assert.equal(source.aliases.chat.activeRoute, 'local');
  assert.equal(source.runtimes.resident.maintenance, undefined);
  assert.equal(f.isHealthy(), true);
  assert.equal((await f.call('GET', '/gateway/schedule/reservations/r-missing')).status, 404);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dir, 'schedule.json'), 'utf8'));
  assert.equal(persisted.reservations[taken.json.id].state, 'released');
});

test('remote steps go through the owner node admin API; a failed resume stays held', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const body = { resource: 'pair', owner: 'main', apply: true, yes: true };
  const taken = await f.call('POST', '/gateway/schedule/reservations', body);
  assert.equal(taken.json.state, 'active', JSON.stringify(taken.json));
  assert.deepEqual(
    f.remote.calls.map((entry) => `${entry.method} ${entry.url}`),
    [
      'GET /gateway/routing',
      'POST /gateway/routes/omp/profile',
      'POST /gateway/models/pair-model/suspend',
      'POST /gateway/models/pair-model/suspend'
    ]
  );
  assert.deepEqual(
    f.remote.calls.slice(2).map((entry) => entry.body.apply),
    [false, true]
  );
  assert.ok(f.remote.calls.every((entry) => entry.auth === 'Bearer remote-admin'));
  assert.equal(f.remote.state.route, 'cloud');

  f.remote.state.failResume = true;
  const route = `/gateway/schedule/reservations/${taken.json.id}/release`;
  const stuck = await f.call('POST', route, { owner: 'main', apply: true, yes: true });
  assert.equal(stuck.json.state, 'stuck');
  assert.equal(f.remote.state.route, 'cloud');
  f.remote.state.failResume = false;
  const released = await f.call('POST', route, { owner: 'main', apply: true, yes: true });
  assert.equal(released.json.state, 'released');
  assert.equal(f.remote.state.route, 'local-atlas');
});

test('agents drive the schedule from the CLI against a remote head', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-schedule-cli-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    LLOOM_HEAD_URL: f.url,
    LLOOM_OWNER: 'main',
    LLOOM_HEAD_API_KEY: 'synthetic-admin'
  };
  delete env.LLOOM_CONFIG;
  delete env.LLOOM_ADMIN_API_KEY;
  const lloom = async (args, extra = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args], {
        env: { ...env, ...extra }
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };

  const unkeyed = await lloom(['schedule'], { LLOOM_HEAD_API_KEY: '' });
  assert.notEqual(unkeyed.code, 0);
  assert.match(unkeyed.stderr, /LLOOM_HEAD_API_KEY/);

  const preview = await lloom(['reserve', 'gpu', '--purpose', 'kernel A/B']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Would take gpu .*\n {2}on take: route chat -> cloud; suspend local/);

  const taken = await lloom(['reserve', 'gpu', '--purpose', 'kernel A/B', '--ttl', '45m', '--apply', '--yes']);
  assert.equal(taken.code, 0, taken.stderr);
  assert.match(taken.stdout, /^r-[0-9a-f]{8} {2}gpu {2}main \(active, 45m left\) — kernel A\/B/);

  const busy = await lloom(['reserve', 'gpu', '--apply', '--yes'], { LLOOM_OWNER: 'buildopt' });
  assert.notEqual(busy.code, 0);
  assert.match(busy.stderr, /gpu is held by main \(HTTP 409\)/);

  const started = await lloom(['job', 'start', 'kernel', 'A/B', '--on', 'gpu', '--note', 'building']);
  const jobId = started.stdout.trim();
  assert.match(jobId, /^j-[0-9a-f]{8}$/);
  assert.equal((await lloom(['job', 'progress', jobId, '2/5', '--unit', 'arms', 'arm', '2'])).code, 0);
  assert.equal((await lloom(['job', 'metric', jobId, 'tok_s=58.2', 'image=f399caa'])).code, 0);
  const board = await lloom(['schedule']);
  assert.match(board.stdout, /gpu — local GPU\n {4}r-[0-9a-f]{8} {2}gpu {2}main \(active, 45m left\)/);
  assert.match(board.stdout, new RegExp(`${jobId}  ok .*kernel A/B — arm 2  \\[2/5 arms\\]  tok_s=58.2 image=f399caa`));
  const done = await lloom(['job', 'done', jobId, 'NLL', 'flat', '--receipt', 'receipts/ab.json']);
  assert.match(done.stdout, /done .*kernel A\/B — NLL flat/);
  const json = JSON.parse((await lloom(['job', 'show', jobId, '--json'])).stdout);
  assert.equal(json.receipt, 'receipts/ab.json');
  assert.deepEqual(json.metrics, { tok_s: 58.2, image: 'f399caa' });

  assert.equal((await lloom(['renew', 'gpu', '--ttl', '1h'])).code, 0);
  const released = await lloom(['release', 'gpu', '--apply', '--yes']);
  assert.equal(released.code, 0, released.stderr);
  assert.match(released.stdout, /gpu {2}main \(released\)/);
  assert.equal(f.isHealthy(), true);
  const nothing = await lloom(['release', 'gpu', '--apply', '--yes']);
  assert.match(nothing.stderr, /main holds no reservation on gpu/);
});

test('reserve --wait queues, then returns once the holder releases', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, LLOOM_HEAD_URL: f.url, LLOOM_HEAD_API_KEY: 'synthetic-admin', LLOOM_OWNER: 'buildopt' };
  const held = await f.call('POST', '/gateway/schedule/reservations', {
    resource: 'gpu',
    owner: 'main',
    apply: true,
    yes: true
  });
  const waiter = promisify(execFile)(
    process.execPath,
    [cli, 'reserve', 'gpu', '--wait', '--poll', '1s', '--apply', '--yes'],
    { env }
  );
  let queued = [];
  for (let attempt = 0; attempt < 50 && !queued.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    queued = (await f.call('GET', '/gateway/schedule')).json.resources.find((entry) => entry.id === 'gpu').queue;
  }
  assert.equal(queued.length, 1);
  await f.call('POST', `/gateway/schedule/reservations/${held.json.id}/release`, {
    owner: 'main',
    apply: true,
    yes: true
  });
  const { stdout, stderr } = await waiter;
  assert.match(stderr, /queued for gpu \(#1\)/);
  assert.match(stdout, /gpu {2}buildopt \(active/);
});

test(
  'a head cannot echo the key it was sent, or terminal escapes, back through the CLI',
  { timeout: 15000 },
  async (t) => {
    const head = http.createServer((req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type: 'schedule_error',
            code: 'schedule_busy',
            message: `pair is held by ${req.headers.authorization} \u001b[31mred\u001b[0m`
          }
        })
      );
    });
    const url = await listen(head);
    t.after(() => new Promise((resolve) => head.close(resolve)));
    const env = { ...process.env, LLOOM_HEAD_URL: url, LLOOM_HEAD_API_KEY: 'head-secret-key', LLOOM_OWNER: 'main' };
    const failed = await promisify(execFile)(process.execPath, [cli, 'reserve', 'pair', '--apply', '--yes'], {
      env
    }).catch((error) => error);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /pair is held by Bearer \[redacted\]/);
    assert.doesNotMatch(failed.stderr, /head-secret-key|\u001b/);
  }
);
