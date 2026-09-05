import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { terminateProcessTree } from '../src/process-control.mjs';

const supervisor = new URL('../src/runtime-supervisor.mjs', import.meta.url);
const posix = { skip: process.platform === 'win32' };

async function waitFor(fn) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(50);
  }
  assert.fail('timed out waiting for lifecycle condition');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-supervisor-'));
  const receipt = path.join(dir, 'processes.json');
  const backend = path.join(dir, 'backend.mjs');
  await fs.writeFile(
    backend,
    `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"], {stdio:['ignore','pipe','ignore']});
    worker.stdout.once('data',()=>fs.writeFileSync(process.argv[2], JSON.stringify({backend:process.pid,worker:worker.pid})));
    setInterval(()=>{process.stdout.write('backend alive\\n');process.stderr.write('backend alive\\n')},50);
    process.on('SIGUSR1',()=>process.exit(23));
  `
  );
  let ids;
  t.after(async () => {
    if (ids) await terminateProcessTree([ids.backend, ids.worker], { termTimeoutMs: 100 });
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    backend,
    receipt,
    async ready() {
      await waitFor(async () => {
        try {
          ids = JSON.parse(await fs.readFile(receipt, 'utf8'));
          return true;
        } catch {
          return false;
        }
      });
      return ids;
    }
  };
}

test('managed stop removes a backend and its TERM-resistant model worker', posix, async (t) => {
  const f = await fixture(t);
  const manager = new RuntimeManager(
    { runtimes: { demo: { enabled: true, command: process.execPath, args: [f.backend, f.receipt] } } },
    { captureOutput: false, logger: {} }
  );
  // The fixture deliberately has no inference listener; health is not under test.
  manager.waitForHealth = async () => ({ healthy: true });
  t.after(() => manager.stop('demo'));
  await manager.start('demo');
  const ids = await f.ready();
  const wrapper = manager.processes.get('demo').pid;
  await manager.stop('demo');
  await waitFor(() => ![wrapper, ids.backend, ids.worker].some(alive));
});

for (const loseGatewayLogs of [false, true]) {
  test(`backend exit cleans its worker${loseGatewayLogs ? ' after gateway log pipes close' : ''}`, posix, async (t) => {
    const f = await fixture(t);
    const wrapper = spawn(process.execPath, [supervisor.pathname, process.execPath, f.backend, f.receipt], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = new Promise((resolve) => wrapper.once('exit', (code) => resolve(code)));
    t.after(() => terminateProcessTree([wrapper.pid], { termTimeoutMs: 3000 }));
    const ids = await f.ready();
    if (loseGatewayLogs) {
      wrapper.stdout.destroy();
      wrapper.stderr.destroy();
      await delay(250);
      assert(alive(wrapper.pid), 'closed gateway logs must not kill the supervisor');
      assert(alive(ids.backend), 'gateway restart must preserve the backend');
    } else {
      wrapper.stdout.resume();
      wrapper.stderr.resume();
    }
    process.kill(ids.backend, 'SIGUSR1');
    assert.equal(await exited, 23);
    await waitFor(() => !alive(ids.worker));
  });
}

test('a missing backend command fails instead of leaving a supervisor alive', posix, async () => {
  const wrapper = spawn(process.execPath, [supervisor.pathname, '/nonexistent/lloom-backend'], { stdio: 'ignore' });
  assert.equal(await new Promise((resolve) => wrapper.once('exit', resolve)), 1);
});
