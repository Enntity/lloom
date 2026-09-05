// A detached backend may outlive the gateway. Keep its process-group owner
// alive too, so an exited backend cannot leave model workers behind.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [command, ...args] = process.argv.slice(2);
if (!command || process.platform === 'win32') {
  process.stderr.write('runtime-supervisor requires a command and a POSIX process group\n');
  process.exit(2);
}

// Separate the backend group from the supervisor, allowing escalation even
// after the backend exits or while a worker ignores SIGTERM.
const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let exitCode = 1;
let stopping = false;
let cleanupPromise;

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

child.on('error', (error) => {
  if (!process.stderr.destroyed) process.stderr.write(`runtime launch failed: ${error.message}\n`);
  void cleanup();
});
child.on('exit', (code) => {
  exitCode = code ?? 1;
  void cleanup();
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    void cleanup();
  });
}
