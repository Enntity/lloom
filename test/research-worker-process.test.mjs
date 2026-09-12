import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess as execute } from '../clients/examples/research-workers/process.mjs';

const runProcess = (options) =>
  execute({
    stdoutPath: path.join(options.cwd, 'stdout'),
    stderrPath: path.join(options.cwd, 'stderr'),
    timeoutMs: 4000,
    ...options
  });
const NODE = process.execPath;
const STARTUP = 500; // generous enough for CI startup, still fast

/** Create a temp workspace with cleanup registered on t. */
async function tmpWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'proc-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** True if pid is alive (does not throw ESRCH). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    return true; // EPERM etc: process exists
  }
}

/** Poll until pid is dead or timeout elapses. */
async function waitDead(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(20);
  }
  return !alive(pid);
}

// A tiny helper script runners can require.

// ---------------------------------------------------------------------------
// success path
// ---------------------------------------------------------------------------

test('resolves success with code 0, null reason, durationMs', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const res = await runProcess({
    command: NODE,
    args: ['-e', 'console.log("hello"); console.error("world")'],
    cwd: dir
  });
  assert.equal(res.code, 0);
  assert.equal(res.reason, null);
  assert.equal(res.signal, null);
  assert.equal(typeof res.durationMs, 'number');
  assert.ok(res.durationMs >= 0);
});

// ---------------------------------------------------------------------------
// stdin EOF + final unterminated line delivered to onLine
// ---------------------------------------------------------------------------

test('delivers stdin then EOF and last unterminated line via onLine', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const lines = [];
  // Echo stdin back, and report when EOF was seen so we can assert ordering.
  const script = `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => {
      process.stdout.write(buf);
      process.stdout.write('\\nEOF_SEEN');
    });
  `;
  const res = await runProcess({
    command: NODE,
    args: ['-e', script],
    cwd: dir,
    stdin: 'line-one\nline-two-with-no-newline',
    onLine: (line) => lines.push(line)
  });
  assert.equal(res.code, 0);
  assert.equal(res.reason, null);
  // Last line has no trailing newline and must still be delivered.
  assert.deepEqual(lines, ['line-one', 'line-two-with-no-newline', 'EOF_SEEN']);
});

// ---------------------------------------------------------------------------
// nonzero exit
// ---------------------------------------------------------------------------

test('reports nonzero exit code without a failure reason', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const res = await runProcess({
    command: NODE,
    args: ['-e', 'process.exit(3)'],
    cwd: dir
  });
  assert.equal(res.code, 3);
  assert.equal(res.reason, null);
});

// ---------------------------------------------------------------------------
// missing command -> spawn_error
// ---------------------------------------------------------------------------

test('missing command yields spawn_error', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const res = await runProcess({
    command: path.join(dir, 'definitely-not-here-1234'),
    args: [],
    cwd: dir
  });
  assert.equal(res.reason, 'spawn_error');
});

// ---------------------------------------------------------------------------
// pre-aborted signal: no spawn marker (process must never run)
// ---------------------------------------------------------------------------

test('pre-aborted signal prevents spawn', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const marker = path.join(dir, 'spawned.marker');
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`;
  const ac = new AbortController();
  ac.abort();
  const res = await runProcess({
    command: NODE,
    args: ['-e', script],
    cwd: dir,
    signal: ac.signal
  });
  assert.equal(res.reason, 'aborted');
  assert.equal(res.code, null);
  let spawned = true;
  try {
    await stat(marker);
  } catch {
    spawned = false;
  }
  assert.equal(spawned, false, 'process must not have spawned after pre-abort');
});

// ---------------------------------------------------------------------------
// timeout kills SIGTERM-ignoring process
// ---------------------------------------------------------------------------

test('timeout kills a SIGTERM-ignoring process', { timeout: 8000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const pidFile = path.join(dir, 'pid.txt');
  const script = `
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const start = Date.now();
  const res = await runProcess({
    command: NODE,
    args: ['-e', script],
    cwd: dir,
    timeoutMs: STARTUP + 200
  });
  assert.equal(res.reason, 'timeout');
  assert.equal(res.code, null);
  assert.ok(Date.now() - start >= STARTUP, 'timeout fired too early');

  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(await waitDead(pid), true, 'process should have been killed');
});

// ---------------------------------------------------------------------------
// combined stdout+stderr byte cap kills output process
// ---------------------------------------------------------------------------

test('combined stdout+stderr byte cap triggers output_limit', { timeout: 8000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const pidFile = path.join(dir, 'pid2.txt');
  // Write pid, ignore SIGTERM, then flood both streams forever.
  const script = `
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => {});
    const chunk = 'x'.repeat(1024);
    setInterval(() => {
      process.stdout.write(chunk);
      process.stderr.write(chunk);
    }, 5);
  `;
  const res = await runProcess({
    command: NODE,
    args: ['-e', script],
    cwd: dir,
    maxOutputBytes: 4096
  });
  assert.equal(res.reason, 'output_limit');
  assert.ok((await stat(path.join(dir, 'stdout'))).size + (await stat(path.join(dir, 'stderr'))).size <= 4096);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(await waitDead(pid), true, 'flooding process should have been killed');
});

// ---------------------------------------------------------------------------
// onLine returning false stops the process (callback_stop)
// ---------------------------------------------------------------------------

test('onLine returning false stops the run with callback_stop', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const script = `
    let i = 0;
    setInterval(() => console.log('line-' + (i++)), 10);
  `;
  const seen = [];
  const res = await runProcess({
    command: NODE,
    args: ['-e', script],
    cwd: dir,
    onLine: (line) => {
      seen.push(line);
      if (seen.length >= 2) return false;
      return true;
    }
  });
  assert.equal(res.reason, 'callback_stop');
  assert.ok(seen.length >= 2);
});

// ---------------------------------------------------------------------------
// descendant cleanup when parent exits
// ---------------------------------------------------------------------------

test('cleans up descendants when parent exits', { timeout: 10000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const childPidFile = path.join(dir, 'descendant-pid.txt');
  const parentScript = path.join(dir, 'parent.cjs');
  const childScript = path.join(dir, 'child.cjs');

  await writeFile(
    childScript,
    `require('fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));\n` +
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`
  );
  await writeFile(
    parentScript,
    `const { spawn } = require('child_process');\n` +
      `const c = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });\n` +
      `c.unref();\n` +
      `setTimeout(() => process.exit(0), 300);\n`
  );

  const res = await runProcess({
    command: NODE,
    args: [parentScript],
    cwd: dir,
    timeoutMs: STARTUP + 2000
  });
  assert.equal(res.code, 0);
  assert.equal(res.reason, null);

  // Wait for the child pid file, then verify the descendant is gone.
  let pid = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pid === null) {
    try {
      pid = Number(await readFile(childPidFile, 'utf8'));
    } catch {
      await delay(20);
    }
  }
  assert.ok(Number.isInteger(pid) && pid > 0, 'descendant pid should have been recorded');
  assert.equal(await waitDead(pid, 3000), true, 'descendant should be killed with parent');
});

test('omitted timeout uses a bounded default instead of killing immediately', { timeout: 5000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const result = await execute({
    command: NODE,
    args: ['-e', "setTimeout(()=>console.log('done'),100)"],
    cwd: dir,
    stdoutPath: path.join(dir, 'out'),
    stderrPath: path.join(dir, 'err')
  });
  assert.equal(result.code, 0);
  assert.equal(result.reason, null);
});

// ---------------------------------------------------------------------------
// supervisor death: lifeline guardian must kill the worker
// ---------------------------------------------------------------------------

test('worker dies with its supervisor when the supervisor is SIGKILLed', { timeout: 10000 }, async (t) => {
  const dir = await tmpWorkspace(t);
  const workerScript = path.join(dir, 'worker.cjs');
  const supervisorScript = path.join(dir, 'supervisor.mjs');
  const workerPidFile = path.join(dir, 'worker-pid.txt');
  const procModule = fileURLToPath(new URL('../clients/examples/research-workers/process.mjs', import.meta.url));

  await writeFile(
    workerScript,
    `require('fs').writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));\n` +
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`
  );
  await writeFile(
    supervisorScript,
    `import fs from 'node:fs';\n` +
      `import { setTimeout as delay } from 'node:timers/promises';\n` +
      `import { runProcess } from ${JSON.stringify(procModule)};\n` +
      `const dir = ${JSON.stringify(dir)};\n` +
      `await runProcess({\n` +
      `  command: process.execPath,\n` +
      `  args: [${JSON.stringify(workerScript)}],\n` +
      `  cwd: dir,\n` +
      `  stdoutPath: dir + '/sup-stdout',\n` +
      `  stderrPath: dir + '/sup-stderr',\n` +
      `  timeoutMs: 60000\n` +
      `}).then((res) => { fs.writeFileSync(dir + '/sup-result.json', JSON.stringify(res)); process.exit(0); });\n` +
      `setInterval(() => {}, 1000);\n` +
      `fs.writeFileSync(dir + '/sup-pid.txt', String(process.pid));\n` +
      `await delay(60000);\n`
  );

  // detached:true gives the synthetic supervisor its own process group so that
  // negative-pid cleanup (`process.kill(-supervisor.pid, ...)`) can reach it.
  const supervisor = spawn(NODE, [supervisorScript], { cwd: dir, stdio: 'ignore', detached: true });
  t.after(() => {
    try {
      process.kill(-supervisor.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  });

  const pidDeadline = Date.now() + 5000;
  while (Date.now() < pidDeadline && !(await stat(workerPidFile).catch(() => null))) await delay(20);
  const workerPid = Number(await readFile(workerPidFile, 'utf8'));
  assert.ok(Number.isInteger(workerPid) && workerPid > 0, 'worker pid should be recorded');
  assert.equal(alive(workerPid), true, 'worker should be alive while the supervisor runs');

  process.kill(supervisor.pid, 'SIGKILL');
  assert.equal(await waitDead(workerPid, 5000), true, 'lifeline guardian should kill the worker');
  try {
    process.kill(-supervisor.pid, 'SIGKILL');
  } catch {
    /* process group already gone */
  }
});
