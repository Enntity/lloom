import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { memorySafetyPolicy, assertMemorySafety, createMemorySafetyGuard } from '../src/runtime-memory-safety.mjs';
import { readHostMemory } from '../src/host-memory.mjs';
import { terminateProcessTree } from '../src/process-control.mjs';

const GiB = 1024 ** 3;
const snapshot = (available) => ({ totalBytes: 96 * GiB, availableBytes: available * GiB });
const healthy = snapshot(60);
const pressure = snapshot(3);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for small test process');
}

async function fixture(t, { warmup = false, yolo = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-memory-guard-'));
  const receipt = path.join(dir, 'receipt.json');
  const marker = path.join(dir, 'warmup');
  const code = path.join(dir, 'backend.mjs');
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  await fs.writeFile(
    code,
    `
    import http from 'node:http';
    import fs from 'node:fs';
    import {spawn} from 'node:child_process';
    const worker=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync(process.argv[2],JSON.stringify({backend:process.pid,worker:worker.pid}));
    http.createServer((req,res)=>{
      if(req.url==='/warmup'){fs.writeFileSync(process.argv[3],'warming');return;}
      res.writeHead(${warmup || yolo ? 200 : 503});res.end('{}');
    }).listen(${port},'127.0.0.1');
  `
  );
  const config = {
    runtimePolicy: {
      enabled: false,
      reserveMemoryGb: 12,
      memorySafety: { mode: yolo ? 'yolo' : 'enforce', pollIntervalMs: 50 }
    },
    runtimes: {
      demo: {
        enabled: true,
        command: process.execPath,
        args: [code, receipt, marker],
        port,
        healthUrl: `http://127.0.0.1:${port}/health`,
        startupTimeoutMs: 5000,
        ...(warmup ? { warmup: { url: `http://127.0.0.1:${port}/warmup`, method: 'POST', body: {} } } : {})
      }
    }
  };
  const manager = new RuntimeManager(config, { logger: { error() {} }, memorySampler: async () => healthy });
  const ids = async () => JSON.parse(await fs.readFile(receipt, 'utf8'));
  t.after(async () => {
    const pids = await ids().catch(() => null);
    if (pids) await terminateProcessTree([pids.backend, pids.worker], { termTimeoutMs: 100 });
    const supervisor = manager.processes.get('demo');
    if (supervisor?.pid) await terminateProcessTree([supervisor.pid], { termTimeoutMs: 100 });
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { manager, receipt, marker, ids, port };
}

test('hard limits include the host reserve, reject malformed telemetry, and use inclusive boundaries', () => {
  const policy = memorySafetyPolicy({ runtimePolicy: { reserveMemoryGb: 12 } }, 96);
  assert.equal(policy.minAvailableMemoryGb, 12);
  assert.throws(() => assertMemorySafety(policy, snapshot(12)), /hard reserve/);
  assert.throws(() => assertMemorySafety(policy, { totalBytes: 1, availableBytes: 2 }), /could not be measured/);
  assert.throws(() => assertMemorySafety(policy, null), /could not be measured/);
  assert.doesNotThrow(() => assertMemorySafety(policy, healthy));
  assert.equal(
    memorySafetyPolicy({ runtimePolicy: { memorySafety: { minAvailableMemoryGb: 20 } } }, 96).minAvailableMemoryGb,
    20
  );
  assert.throws(() => memorySafetyPolicy({ runtimePolicy: { memorySafety: { mode: 'YOLO-ish' } } }), /Invalid/);
});

test('strict Mac telemetry fails closed instead of substituting free memory', async () => {
  await assert.rejects(
    readHostMemory({
      platform: 'darwin',
      strict: true,
      execFileImpl: async () => {
        throw new Error('sampler unavailable');
      }
    }),
    /sampler unavailable/
  );
  await assert.rejects(
    readHostMemory({ platform: 'darwin', strict: true, execFileImpl: async () => ({ stdout: 'invalid' }) }),
    /unavailable/
  );
});

test('force and disabled predictive policy cannot bypass hard preflight', async (t) => {
  const f = await fixture(t);
  f.manager.memorySampler = async () => pressure;
  await assert.rejects(f.manager.start('demo', { force: true }), (e) => e.code === 'runtime_memory_safety_abort');
  assert.equal(f.manager.processes.size, 0);
  assert.equal(
    await fs.access(f.receipt).then(
      () => true,
      () => false
    ),
    false
  );
});

for (const warmup of [false, true])
  test(`pressure during blocked ${warmup ? 'warmup' : 'health'} kills only the new process tree`, async (t) => {
    const f = await fixture(t, { warmup });
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    t.after(() => terminateProcessTree([sentinel.pid], { termTimeoutMs: 100 }));
    let trip = false;
    f.manager.memorySampler = async () => (trip ? pressure : healthy);
    const starting = f.manager.start('demo', { reason: 'model-request' });
    const rejected = assert.rejects(starting, (e) => e.code === 'runtime_memory_safety_abort' && !e.temporary);
    await until(() =>
      fs.access(warmup ? f.marker : f.receipt).then(
        () => true,
        () => false
      )
    );
    const pids = await f.ids();
    assert(alive(pids.backend));
    trip = true;
    await rejected;
    await until(() => !alive(pids.backend) && !alive(pids.worker));
    assert(alive(sentinel.pid), 'unrelated process must survive');
    assert.equal(f.manager.stateFor('demo').status, 'failed');
    assert.match(f.manager.stateFor('demo').lastError, /protect this machine/);
    f.manager.memorySampler = async () => healthy;
    await assert.rejects(
      f.manager.start('demo', { reason: 'model-request' }),
      (e) => e.code === 'runtime_memory_safety_abort'
    );
    assert.equal(f.manager.stateFor('demo').starts, 1, 'automatic retry must not spawn again');
  });

test('a reused healthy endpoint remains usable under pressure', async (t) => {
  const server = http.createServer((req, res) => res.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const manager = new RuntimeManager(
    { runtimes: { existing: { enabled: true, healthUrl: `http://127.0.0.1:${server.address().port}/health` } } },
    { memorySampler: async () => pressure }
  );
  const result = await manager.start('existing', { warmup: false });
  assert.equal(result.reason, 'already-healthy');
  assert(server.listening);
});

test('explicit YOLO is the only guard bypass', async (t) => {
  const f = await fixture(t, { yolo: true });
  f.manager.memorySampler = async () => {
    throw new Error('must not be sampled in YOLO');
  };
  const result = await f.manager.start('demo');
  assert.equal(result.healthy, true);
  assert.equal((await f.manager.status()).memorySafety.mode, 'yolo');
  assert(alive((await f.ids()).backend));
});

test('a stale sample cannot abort a completed operation', async () => {
  let release;
  let aborts = 0;
  const guard = createMemorySafetyGuard({
    policy: memorySafetyPolicy({}),
    sample: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    onAbort: () => aborts++
  });
  const checking = guard.check();
  await until(() => Boolean(release));
  const stopping = guard.stop();
  release(pressure);
  await Promise.all([checking, stopping]);
  assert.equal(aborts, 0);
});

test('the independent supervisor enforces the transmitted reserve without gateway sampling', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-independent-guard-'));
  const source = path.resolve('src');
  for (const name of ['runtime-supervisor.mjs', 'runtime-memory-safety.mjs'])
    await fs.copyFile(path.join(source, name), path.join(dir, name));
  // Replace only the OS telemetry dependency in this isolated subprocess test.
  await fs.writeFile(
    path.join(dir, 'host-memory.mjs'),
    `import fs from 'node:fs/promises'; export async function readHostMemory(){ return JSON.parse(await fs.readFile(process.env.SAMPLE_FILE,'utf8')); }`
  );
  const sampleFile = path.join(dir, 'sample.json');
  const receipt = path.join(dir, 'receipt.json');
  await fs.writeFile(sampleFile, JSON.stringify(healthy));
  const backend = `const fs=require('fs'),{spawn}=require('child_process');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({backend:process.pid,worker:worker.pid}));setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    [path.join(dir, 'runtime-supervisor.mjs'), process.execPath, '-e', backend, receipt],
    {
      env: {
        ...process.env,
        SAMPLE_FILE: sampleFile,
        LLOOM_MEMORY_SAFETY_POLICY: JSON.stringify({
          mode: 'enforce',
          minAvailableMemoryGb: 20,
          maxMemoryUtilization: 0.9,
          pollIntervalMs: 50
        })
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  let aborted;
  child.on('message', (message) => {
    if (message.type === 'memory-safety-abort') aborted = message;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    const pids = await fs.readFile(receipt, 'utf8').then(JSON.parse, () => ({}));
    await terminateProcessTree([child.pid, pids.backend, pids.worker].filter(Boolean), { termTimeoutMs: 100 });
    await fs.rm(dir, { recursive: true, force: true });
  });
  await until(() =>
    fs.access(receipt).then(
      () => true,
      () => false
    )
  );
  const pids = JSON.parse(await fs.readFile(receipt, 'utf8'));
  await fs.writeFile(sampleFile, JSON.stringify(snapshot(18)));
  const result = await Promise.race([
    exited,
    delay(3000).then(() => {
      throw new Error('Independent cutoff did not fire');
    })
  ]);
  assert.equal(result.code, 78, stderr);
  assert.match(aborted?.message ?? '', /20.0 GB hard reserve/);
  await until(() => !alive(pids.backend) && !alive(pids.worker));
});

test('owned Docker startup is killed by immutable container ID on a hard breach', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-docker-memory-'));
  const started = path.join(dir, 'started');
  const killed = path.join(dir, 'killed');
  const docker = path.join(dir, 'docker');
  await fs.writeFile(
    docker,
    `#!/usr/bin/env node
const fs=require('fs');const started=${JSON.stringify(started)},killed=${JSON.stringify(killed)};
switch(process.argv[2]) {
case 'inspect': console.log(JSON.stringify({Id:'owned-id',State:{Running:fs.existsSync(started)&&!fs.existsSync(killed),Status:'created'}})); break;
case 'start': fs.writeFileSync(started,'started'); break;
case 'kill': if(process.argv[3]!=='owned-id')process.exit(3);fs.writeFileSync(killed,'killed');break;
default: process.exit(4);
}
`,
    { mode: 0o755 }
  );
  const oldPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + oldPath;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const manager = new RuntimeManager(
    {
      runtimePolicy: { memorySafety: { pollIntervalMs: 50 } },
      runtimes: {
        demo: {
          enabled: true,
          adapter: 'docker',
          management: 'managed',
          containerName: 'test-name',
          healthUrl: 'http://127.0.0.1:1/health',
          healthTimeoutMs: 50
        }
      }
    },
    {
      logger: { error() {} },
      memorySampler: async () =>
        await fs.access(started).then(
          () => pressure,
          () => healthy
        )
    }
  );
  await assert.rejects(manager.start('demo'), (e) => e.code === 'runtime_memory_safety_abort');
  assert.equal(await fs.readFile(killed, 'utf8'), 'killed');
});

test('supervisor preflight rejection cannot race an immediate health success', async (t) => {
  const f = await fixture(t);
  const totalBytes = os.totalmem();
  f.manager.config.runtimePolicy.memorySafety.minAvailableMemoryGb = totalBytes / GiB;
  f.manager.memorySampler = async () => ({ totalBytes: totalBytes * 4, availableBytes: totalBytes * 3 });
  let probed = false;
  f.manager.waitForHealth = async () => {
    probed = true;
    return { healthy: true };
  };
  await assert.rejects(f.manager.start('demo'), (e) => e.code === 'runtime_memory_safety_abort');
  assert.equal(probed, false);
  assert.equal(
    await fs.access(f.receipt).then(
      () => true,
      () => false
    ),
    false
  );
});

test('late health success after a safety abort cannot become a successful load', async (t) => {
  const f = await fixture(t);
  let release;
  f.manager.waitForHealth = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  let trip = false;
  f.manager.memorySampler = async () => (trip ? pressure : healthy);
  const starting = f.manager.start('demo');
  const rejected = assert.rejects(starting, (e) => e.code === 'runtime_memory_safety_abort');
  await until(() =>
    fs.access(f.receipt).then(
      () => Boolean(release),
      () => false
    )
  );
  const pids = await f.ids();
  trip = true;
  await until(() => !alive(pids.backend));
  release({ healthy: true });
  await rejected;
  assert.equal(f.manager.stateFor('demo').status, 'failed');
});
