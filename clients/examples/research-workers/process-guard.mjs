// A separate lifeline lets cleanup survive SIGKILL/crashes of the supervisor.
// POSIX only: this process is the leader of the worker's process group.
import { spawn } from 'node:child_process';
import net from 'node:net';

const lifeline = new net.Socket({ fd: 3, readable: true, writable: true });
const stop = () => {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.exit(1);
  }
};
lifeline.on('end', stop);
lifeline.on('error', stop);
lifeline.resume();
const failed = () => lifeline.write('spawn_error\n', () => process.exit(127));
try {
  const [command, ...args] = process.argv.slice(2);
  const child = spawn(command, args, { shell: false, stdio: 'inherit', detached: false });
  child.on('error', failed);
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} catch {
  failed();
}
