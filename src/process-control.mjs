import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const LSOF = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';

export function runCommand(command, args, { allowFailure = false, env = process.env, stdio = 'pipe' } = {}) {
  return new Promise((resolve, reject) => {
    const streamOutput = stdio === 'inherit';
    const child = spawn(command, args, {
      stdio: streamOutput ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      env
    });
    let stdout = '';
    let stderr = '';
    if (!streamOutput) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', (error) => {
      if (allowFailure) {
        resolve({ code: null, stdout, stderr: stderr || error.message });
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

export function parsePids(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ];
}

export async function findPortListenerPids(port) {
  if (!port) return [];
  const result = await runCommand(LSOF, [`-nP`, `-tiTCP:${port}`, '-sTCP:LISTEN'], {
    allowFailure: true
  });
  if (result.code !== 0 && !result.stdout) return [];
  return parsePids(result.stdout);
}

export async function listProcessRows() {
  const result = await runCommand('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  return result.stdout
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*([0-9]+)\s+([0-9]+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      };
    })
    .filter(Boolean);
}

export function expandProcessTree(rootPids, rows) {
  const all = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (all.has(row.ppid) && !all.has(row.pid)) {
        all.add(row.pid);
        changed = true;
      }
    }
  }
  return [...all].filter((pid) => pid !== process.pid);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const survivors = pids.filter(processAlive);
    if (!survivors.length) return [];
    await delay(100);
  }
  return pids.filter(processAlive);
}

function signalPids(pids, signal) {
  const signaled = [];
  const failed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        failed.push({ pid, error: error?.message || String(error) });
      }
    }
  }
  return { signaled, failed };
}

export async function terminateProcessTree(rootPids, { termTimeoutMs = 2000, killTimeoutMs = 1000 } = {}) {
  const roots = parsePids(Array.isArray(rootPids) ? rootPids.join('\n') : rootPids);
  if (!roots.length) {
    return { roots: [], pids: [], terminated: [], killed: [], survivors: [], failed: [] };
  }

  const rows = await listProcessRows().catch(() => []);
  const pids = expandProcessTree(roots, rows);
  if (!pids.length) {
    return { roots, pids: [], terminated: [], killed: [], survivors: [], failed: [] };
  }

  const term = signalPids(pids, 'SIGTERM');
  let survivors = await waitForGone(pids, termTimeoutMs);
  let killed = [];
  let killFailed = [];
  if (survivors.length) {
    const kill = signalPids(survivors, 'SIGKILL');
    killed = kill.signaled;
    killFailed = kill.failed;
    survivors = await waitForGone(survivors, killTimeoutMs);
  }

  return {
    roots,
    pids,
    terminated: term.signaled,
    killed,
    survivors,
    failed: [...term.failed, ...killFailed]
  };
}

export async function cleanupPortListener(port, options = {}) {
  const roots = await findPortListenerPids(port);
  if (!roots.length) {
    return { port, roots: [], pids: [], terminated: [], killed: [], survivors: [], failed: [] };
  }
  return {
    port,
    ...(await terminateProcessTree(roots, options))
  };
}
