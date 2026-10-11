// `lloom pool plan` report tests. Gateway calls and local probes are injected;
// the spawned CLI checks only argument handling and the offline JSON shape.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoolPlanReport, formatPoolPlanReport, poolPlanOptions } from '../src/pool-cli.mjs';

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
  readProfile: async (_config, name) => ({ name, routes: { chat: 'small' }, residency: {} })
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
  assert.deepEqual(requested, ['/gateway/cluster?inventory=1', '/gateway/metrics?period=7d']);
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
