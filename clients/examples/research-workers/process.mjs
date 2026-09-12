import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
const guard = fileURLToPath(new URL('./process-guard.mjs', import.meta.url));

// DeepSeek draft, revised after parent lifecycle and output-bound review.
export function runProcess({
  command,
  args = [],
  cwd,
  env,
  stdin,
  stdoutPath,
  stderrPath,
  timeoutMs = 600000,
  maxOutputBytes = 4000000,
  onLine,
  signal
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child,
      outFd,
      errFd,
      timer,
      grace,
      reason = null,
      written = 0,
      buffer = '',
      done = false;
    const decoder = new StringDecoder('utf8');
    const kill = (sig) => {
      if (!child?.pid) return;
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        /* process group is gone */
      }
    };
    const stop = (why) => {
      if (done || reason) return;
      reason = why;
      kill('SIGTERM');
      grace = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const abort = () => stop('aborted');
    const finish = (code, sig) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', abort);
      for (const fd of [outFd, errFd])
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* best effort after IO error */
          }
        }
      resolve({ code, signal: sig, reason, durationMs: Date.now() - started });
    };
    if (signal?.aborted) {
      reason = 'aborted';
      finish(null, null);
      return;
    }
    const line = (value) => {
      if (reason) return;
      try {
        if (onLine?.(value) === false) stop('callback_stop');
      } catch {
        stop('callback_stop');
      }
    };
    const output = (fd, chunk, stdout) => {
      const remaining = Math.max(0, maxOutputBytes - written);
      const part = chunk.subarray(0, remaining);
      written += part.length;
      try {
        let n = 0;
        while (n < part.length) n += writeSync(fd, part, n, part.length - n);
      } catch {
        stop('io_error');
      }
      if (part.length < chunk.length) stop('output_limit');
      if (stdout && onLine && !reason) {
        buffer += decoder.write(part);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          line(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      }
    };
    try {
      outFd = openSync(stdoutPath, 'w', 0o600);
      errFd = openSync(stderrPath, 'w', 0o600);
      if (process.platform === 'win32') throw Error('Research worker process supervision requires POSIX');
      child = spawn(process.execPath, [guard, command, ...args], {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe', 'pipe']
      });
    } catch {
      reason = 'spawn_error';
      finish(null, null);
      return;
    }
    child.stdio[3].on('data', (data) => {
      if (data.toString().includes('spawn_error')) reason ??= 'spawn_error';
    });
    child.stdio[3].on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    child.stdout.on('data', (chunk) => output(outFd, chunk, true));
    child.stderr.on('data', (chunk) => output(errFd, chunk, false));
    child.stdout.on('error', () => stop('io_error'));
    child.stderr.on('error', () => stop('io_error'));
    child.on('error', () => {
      reason ??= 'spawn_error';
    });
    // Background children sharing the worker's group cannot outlive the worker.
    child.on('exit', () => kill('SIGKILL'));
    child.on('close', (code, sig) => {
      kill('SIGKILL');
      buffer += decoder.end();
      if (buffer) line(buffer);
      finish(code, sig);
    });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
