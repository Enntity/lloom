// A detached backend may outlive the gateway. Keep its process-group owner
// alive too, so an exited backend cannot leave model workers behind.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { memorySafetyPolicy, assertMemorySafety, createMemorySafetyGuard } from './runtime-memory-safety.mjs';
import { readHostMemory } from './host-memory.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command || process.platform === 'win32') {
  process.stderr.write('runtime-supervisor requires a command and a POSIX process group\n');
  process.exit(2);
}

let memoryPolicy = null;
try {
  if (process.env.LLOOM_MEMORY_SAFETY_POLICY) {
    memoryPolicy = memorySafetyPolicy({
      runtimePolicy: { memorySafety: JSON.parse(process.env.LLOOM_MEMORY_SAFETY_POLICY) }
    });
    if (memoryPolicy.mode !== 'yolo') assertMemorySafety(memoryPolicy, await readHostMemory({ strict: true }));
  }
} catch (error) {
  process.send?.({ type: 'memory-safety-abort', message: error.message, snapshot: error.snapshot });
  process.stderr.write(`${error.message}\n`);
  process.exit(78);
}

// Separate the backend group from the supervisor, allowing escalation even
// after the backend exits or while a worker ignores SIGTERM.
const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let exitCode = 1;
let stopping = false;
let cleanupPromise;
let memoryGuard;
let memoryComplete = false;
let memoryAborted = false;

function forward(source, destination) {
  source.pipe(destination, { end: false });
  destination.on('error', () => {
    // A gateway restart closes its log pipes, not the runtime's lifetime.
    source.unpipe(destination);
    source.resume();
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

function signalGroup(signal) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

function cleanup() {
  cleanupPromise ??= (async () => {
    await memoryGuard?.stop();
    if (memoryAborted) {
      // SIGKILL was already delivered to the owned group. Reap the child;
      // probing a dying process group can return EPERM on macOS.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && child.exitCode == null && child.signalCode == null) await delay(10);
      process.exit(78);
    }
    signalGroup('SIGTERM');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && signalGroup(0)) await delay(50);
    if (signalGroup(0)) signalGroup('SIGKILL');
    // Do not wait on inherited output pipes: an escaped worker could retain
    // them. The owned process group, not stdout closure, defines cleanup.
    process.exit(stopping ? 0 : exitCode);
  })().catch((error) => {
    if (!process.stderr.destroyed) process.stderr.write(`runtime cleanup failed: ${error.message}\n`);
    process.exit(1);
  });
  return cleanupPromise;
}

function abortForMemory(error) {
  if (memoryAborted || memoryComplete) return;
  memoryAborted = true;
  exitCode = 78;
  if (process.connected)
    process.send({ type: 'memory-safety-abort', message: error.message, snapshot: error.snapshot });
  if (!process.stderr.destroyed) process.stderr.write(`${error.message}\n`);
  // This group belongs to this supervisor. Do not wait for the gateway or a
  // graceful backend shutdown while the host is running out of memory.
  signalGroup('SIGKILL');
  void cleanup();
}

if (memoryPolicy?.mode === 'enforce') {
  memoryGuard = createMemorySafetyGuard({ policy: memoryPolicy, onAbort: abortForMemory });
  memoryGuard.start();
}
process.on('message', (message) => {
  if (message?.type === 'memory-safety-complete') {
    memoryComplete = true;
    void memoryGuard?.stop();
    // Disconnecting synchronously while Node drains queued IPC messages can
    // crash its message dispatcher, leaving the backend without a supervisor.
    setImmediate(() => {
      if (process.connected) process.disconnect();
    });
  } else if (message?.type === 'memory-safety-abort') {
    abortForMemory(new Error('Gateway aborted this load to protect host memory.'));
  }
});
process.on('disconnect', () => {
  if (memoryGuard && !memoryComplete && !memoryAborted)
    abortForMemory(new Error('Gateway disconnected during a guarded load.'));
});

child.on('error', (error) => {
  if (!process.stderr.destroyed) process.stderr.write(`runtime launch failed: ${error.message}\n`);
  void cleanup();
});
child.on('spawn', () => {
  if (process.connected) process.send({ type: 'memory-safety-ready' }, () => {});
});
child.on('exit', (code) => {
  if (!memoryAborted) exitCode = code ?? 1;
  void cleanup();
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    void cleanup();
  });
}
