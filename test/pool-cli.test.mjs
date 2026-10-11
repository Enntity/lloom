// `lloom pool plan` report tests. Gateway calls and local probes are injected;
// the spawned CLI checks only argument handling and the offline JSON shape.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPoolPlanReport,
  formatPoolMembers,
  formatPoolPlanReport,
  parseDurationMs,
  poolPlanOptions,
  poolTokenOptions
} from '../src/pool-cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { createPoolMembership } from '../src/pool-membership.mjs';
import { createLloomServer } from '../src/server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'bin', 'lloom.mjs');
const directories = [];
after(async () => {
  await Promise.all(directories.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function config() {
  return {
    cluster: { nodeId: 'head', nodes: { head: {}, pair: { endpoint: 'http://pair:8100' } } },
    runtimePolicy: { maxMemoryUtilization: 0.95 },
    backends: { local: { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' } },
    runtimes: { small: { enabled: true, memoryGb: 40 } },
    models: [
      { id: 'small', kind: 'chat', backend: 'local', runtime: 'small' },
      { id: 'big', kind: 'chat', backend: 'local', pool: { nodes: ['pair'], memoryGbPerNode: 100 } }
    ],
    aliases: { chat: { members: ['big'], routeProfiles: { local: { members: ['small'] } } } }
  };
}

const spark = (memoryGb = 128) => ({
  reachable: true,
  profile: {
    platformId: 'linux-arm64',
    accelerators: ['cuda', 'gb10'],
    devices: [{ id: 'cuda:0', computeCapability: '12.1' }],
    memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: memoryGb }]
  }
});

const deps = (gatewayRequest) => ({
  gatewayRequest,
  gatewayUrl: 'http://127.0.0.1:8100',
  loadRecipes: async () => [],
  loadBenchmarkEvidence: async () => [],
  profileMachine: async () => spark().profile,
  collectNodeInventory: async ({ nodeId }) => ({ version: 1, complete: true, nodeId, computeArchs: ['sm_121'] }),
  modelRootCandidates: async () => [],
  readProfile: async (_config, name) => ({ name, routes: { chat: 'small' }, residency: {} }),
  readPoolMembership: async () => null
});

test('pool plan options parse cordons, pins and policy flags', () => {
  assert.deepEqual(
    poolPlanOptions({
      cordon: ['a,b', 'c'],
      pins: ['chat=small'],
      headroomGb: '6',
      external: 'never',
      offline: true
    }),
    {
      cordon: ['a', 'b', 'c'],
      routes: { chat: 'small' },
      profileName: null,
      considerInstalls: false,
      offline: true,
      policy: { headroomGb: 6, external: 'never' }
    }
  );
  assert.throws(() => poolPlanOptions({ pins: ['chat'] }), /ALIAS=MODEL/);
  assert.throws(() => poolPlanOptions({ external: 'sometimes' }), /fallback, allow, or never/);
  assert.throws(() => poolPlanOptions({ churnWeight: '-1' }), /non-negative/);
});

test('a gateway report plans from live status and metrics', async () => {
  const requested = [];
  const report = await createPoolPlanReport(
    config(),
    poolPlanOptions({}),
    deps(async (_config, pathname) => {
      requested.push(pathname);
      if (pathname.startsWith('/gateway/cluster')) {
        return { cluster: { nodes: { head: spark(), pair: spark() } } };
      }
      return { period: '7d', models: [], routes: [], requested: [{ id: 'chat', requests: 336 }] };
    })
  );
  assert.deepEqual(requested, ['/gateway/cluster?inventory=1', '/gateway/metrics?period=7d', '/gateway/pool/members']);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.source, {
    mode: 'gateway',
    gateway: 'http://127.0.0.1:8100',
    metricsPeriod: '7d',
    note: null
  });
  assert.equal(report.plan.routes.chat.model, 'big');
  assert.equal(report.plan.routes.chat.residency, 'always', '2 requests per hour makes the lane hot');
  const text = formatPoolPlanReport(report);
  assert.match(text, /dry run; nothing was changed/);
  assert.match(text, /always +big@pair 100\.0 GB\/node \(unmanaged\) <- chat/);
  assert.match(text, /Changes from current\n {2}\(none\)/, 'a routed unmanaged lane is assumed to be serving');
});

test('cordons and profile pins reach the planner', async () => {
  const report = await createPoolPlanReport(
    config(),
    poolPlanOptions({ cordon: ['pair'], profile: 'standalone' }),
    deps(async (_config, pathname) =>
      pathname.startsWith('/gateway/cluster') ? { cluster: { nodes: { head: spark(), pair: spark() } } } : null
    )
  );
  assert.equal(report.profile, 'standalone');
  assert.deepEqual(report.pins.routes, { chat: 'small' });
  assert.equal(report.nodes.find((node) => node.id === 'pair').cordoned, true);
  assert.equal(report.plan.routes.chat.model, 'small');
  assert.equal(report.plan.routes.chat.reason, 'pinned');
  assert.match(formatPoolPlanReport(report), /route +chat: big -> small/);
});

test('an unreachable gateway falls back to config and local inventory', async () => {
  const report = await createPoolPlanReport(
    config(),
    poolPlanOptions({}),
    deps(async () => {
      throw new Error('connect ECONNREFUSED');
    })
  );
  assert.equal(report.source.mode, 'config');
  assert.match(report.source.note, /ECONNREFUSED/);
  assert.deepEqual(
    report.nodes.map((node) => [node.id, node.inventory]),
    [
      ['head', 'reported'],
      ['pair', 'config']
    ]
  );
  assert.match(formatPoolPlanReport(report), /Source: config only — gateway unavailable/);
});

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, timeout: 60000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

test('the CLI prints an offline JSON plan and rejects unknown actions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-pool-'));
  directories.push(dir);
  const configPath = path.join(dir, 'config.json');
  const cliConfig = {
    ...config(),
    cluster: undefined,
    models: [config().models[0]],
    aliases: { chat: { members: ['small'] } }
  };
  await fs.writeFile(configPath, JSON.stringify(cliConfig, null, 2));
  const env = { ...process.env, HOME: dir, LLOOM_MODEL_ROOT: path.join(dir, 'models') };
  const result = await runCli(['pool', 'plan', '--offline', '--json', '--config', configPath], env);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.source.mode, 'config');
  assert.equal(report.plan.routes.chat.model, 'small');

  const bad = await runCli(['pool', 'apply', '--config', configPath], env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /Usage: lloom pool plan/);
});

function member(id, overrides = {}) {
  return {
    id,
    endpoint: `http://${id}:8100`,
    labels: {},
    state: 'ready',
    cordoned: false,
    draining: false,
    reason: null,
    enrolledAt: '2026-10-11T12:00:00.000Z',
    lastSeenAt: '2026-10-11T12:00:00.000Z',
    leaseExpiresAt: '2026-10-11T12:00:30.000Z',
    inventory: null,
    running: [],
    ...overrides
  };
}

test('a plan reflects membership drains and flags enrolled-only nodes', async () => {
  const report = await createPoolPlanReport(
    config(),
    poolPlanOptions({}),
    deps(async (_config, pathname) => {
      if (pathname.startsWith('/gateway/cluster')) return { cluster: { nodes: { head: spark(), pair: spark() } } };
      if (pathname === '/gateway/pool/members') {
        return { members: [member('pair', { draining: true, reason: 'swap' }), member('extra')] };
      }
      return null;
    })
  );
  const nodes = Object.fromEntries(report.nodes.map((node) => [node.id, node]));
  assert.equal(nodes.pair.cordoned, true);
  assert.equal(nodes.pair.membership, 'ready');
  assert.equal(nodes.pair.routable, true);
  assert.equal(nodes.extra.routable, false);
  assert.equal(report.plan.routes.chat.model, 'small', 'the drained pair takes no placement');
  assert.match(report.plan.warnings[0], /extra joined the pool by enrollment only/);
  const text = formatPoolPlanReport(report);
  assert.match(text, /pair +cordoned .*\[member ready\]/);
  assert.match(text, /extra +.*\[member ready, enrolled only\]/);
});

test('an offline plan applies cordons from the saved membership file', async () => {
  const membership = createPoolMembership();
  const { token } = membership.issueEnrollmentToken({});
  membership.enroll({ token, nodeId: 'pair', endpoint: 'http://pair:8100' });
  membership.cordon('pair', { reason: 'maintenance' });
  const state = membership.toJSON();
  const report = await createPoolPlanReport(config(), poolPlanOptions({ offline: true }), {
    ...deps(async () => {
      throw new Error('offline plans do not call the gateway');
    }),
    readPoolMembership: async () => state
  });
  assert.equal(report.nodes.find((node) => node.id === 'pair').cordoned, true);
});

test('token options parse durations, uses and labels', () => {
  assert.equal(parseDurationMs('90'), 90000);
  assert.equal(parseDurationMs('30m'), 1800000);
  assert.equal(parseDurationMs('2h'), 7200000);
  assert.equal(parseDurationMs('7d'), 604800000);
  assert.throws(() => parseDurationMs('soon'), /duration/);
  assert.throws(() => parseDurationMs('0'), /duration/);
  assert.deepEqual(poolTokenOptions({ ttl: '10m', uses: '3', labels: ['role=gpu', 'zone=a'] }), {
    ttlMs: 600000,
    uses: 3,
    labels: { role: 'gpu', zone: 'a' }
  });
  assert.deepEqual(poolTokenOptions({}), {});
  assert.throws(() => poolTokenOptions({ uses: 'many' }), /--uses/);
  assert.throws(() => poolTokenOptions({ labels: ['novalue'] }), /KEY=VALUE/);
});

test('members print state, cordons and inventory at a glance', () => {
  const text = formatPoolMembers(
    {
      leaseMs: 30000,
      members: [
        member('spark-node-01', {
          inventory: {
            complete: true,
            computeArchs: ['sm_121'],
            memoryDomains: [{ id: 'unified:0', capacityGb: 128 }]
          },
          running: ['q27']
        }),
        member('spark-node-02', { state: 'lost', draining: true, reason: 'disk swap' })
      ]
    },
    { now: () => Date.parse('2026-10-11T12:01:00.000Z') }
  );
  assert.match(text, /spark-node-01 +ready +http:\/\/spark-node-01:8100 +60s ago +sm_121, 128 GB +q27/);
  assert.match(text, /spark-node-02 +lost, draining \(disk swap\)/);
  assert.equal(formatPoolMembers({ members: [] }), 'No pool members. Issue a token with `lloom pool token create`.');
});

function runCliWithInput(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('the CLI issues tokens, joins a node, lists members and cordons', async (t) => {
  const admin = 'fixture-pool-admin';
  const headDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-pool-head-'));
  const nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-pool-node-'));
  directories.push(headDir, nodeDir);
  const headConfigPath = path.join(headDir, 'config.json');
  const headRaw = {
    server: { host: '127.0.0.1', port: 0 },
    security: { adminApiKeys: [admin] },
    cluster: { nodeId: 'head' },
    backends: {},
    models: []
  };
  await fs.writeFile(headConfigPath, JSON.stringify(headRaw), { mode: 0o600 });
  const app = createLloomServer(await loadConfig(headConfigPath, { env: {} }), {
    logger: { info() {}, warn() {}, error() {} }
  });
  await app.listen();
  t.after(() => app.close({ stopRuntimes: false, httpGraceMs: 0 }));
  const port = app.server.address().port;
  // The CLI reaches the head through its configured port.
  await fs.writeFile(headConfigPath, JSON.stringify({ ...headRaw, server: { host: '127.0.0.1', port } }), {
    mode: 0o600
  });
  const nodeConfigPath = path.join(nodeDir, 'config.json');
  await fs.writeFile(nodeConfigPath, JSON.stringify({ cluster: { nodeId: 'worker' }, backends: {}, models: [] }), {
    mode: 0o600
  });
  const env = { ...process.env, HOME: headDir, LLOOM_ADMIN_API_KEY: admin, LLOOM_CONFIG: '' };
  delete env.LLOOM_NODE_ID;
  const head = ['--config', headConfigPath];
  const node = ['--config', nodeConfigPath];

  const created = await runCli(['pool', 'token', 'create', '--ttl', '10m', '--json', ...head], env);
  assert.equal(created.code, 0, created.stderr);
  const { token } = JSON.parse(created.stdout);
  assert.match(token, /^lpt_/);

  const headUrl = `http://127.0.0.1:${port}`;
  const preview = await runCliWithInput(
    ['pool', 'join', headUrl, '--token-stdin', '--endpoint', 'http://10.0.0.2:8100', ...node],
    env,
    token
  );
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  const joined = await runCliWithInput(
    ['pool', 'join', headUrl, '--token-stdin', '--endpoint', 'http://10.0.0.2:8100', '--apply', '--yes', ...node],
    env,
    token + '\n'
  );
  assert.equal(joined.code, 0, joined.stderr);
  const result = JSON.parse(joined.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.nodeId, 'worker');
  assert.ok(!joined.stdout.includes('lps_'), 'the node secret is never printed');
  const secretFile = path.join(nodeDir, 'pool-node-secret');
  assert.equal((await fs.stat(secretFile)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(secretFile, 'utf8'), /^lps_/);
  const nodeConfig = JSON.parse(await fs.readFile(nodeConfigPath, 'utf8'));
  assert.deepEqual(nodeConfig.pool.head, { url: headUrl, nodeId: 'worker', secretFile: 'pool-node-secret' });

  const reused = await runCliWithInput(
    ['pool', 'join', headUrl, '--token-stdin', '--endpoint', 'http://10.0.0.2:8100', '--apply', '--yes', ...node],
    env,
    token
  );
  assert.notEqual(reused.code, 0);
  assert.match(reused.stderr, /rejected the enrollment \(401\)/);
  assert.ok(!reused.stderr.includes(token));

  const cordoned = await runCli(['pool', 'drain', 'worker', '--reason', 'rebalance', ...head], env);
  assert.equal(cordoned.code, 0, cordoned.stderr);
  assert.equal(JSON.parse(cordoned.stdout).member.draining, true);

  const members = await runCli(['pool', 'members', '--json', ...head], env);
  assert.equal(members.code, 0, members.stderr);
  const [listed] = JSON.parse(members.stdout).members;
  assert.equal(listed.id, 'worker');
  assert.equal(listed.draining, true);
  const table = await runCli(['pool', 'members', ...head], env);
  assert.match(table.stdout, /worker +ready, draining \(rebalance\) +http:\/\/10\.0\.0\.2:8100/);

  const usage = await runCli(['pool', 'cordon', ...head], env);
  assert.notEqual(usage.code, 0);
  assert.match(usage.stderr, /lloom pool cordon\|uncordon\|drain <node>/);
});
