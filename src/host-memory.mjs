import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function memorySnapshot(totalBytes, availableBytes, source) {
  const total = Math.round(Math.max(0, Number(totalBytes) || 0));
  const available = Math.round(clamp(Number(availableBytes) || 0, 0, total));
  const used = Math.max(0, total - available);
  return {
    usedBytes: used,
    availableBytes: available,
    totalBytes: total,
    utilization: total > 0 ? (used / total) * 100 : 0,
    source
  };
}

export function parseLinuxMeminfo(text) {
  const values = Object.fromEntries(
    [...String(text).matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)].map((match) => [
      match[1],
      Number(match[2]) * 1024
    ])
  );
  if (!values.MemTotal || values.MemAvailable == null) return null;
  return memorySnapshot(values.MemTotal, values.MemAvailable, 'linux-memavailable');
}

export function parseMacMemoryPressure(text, totalBytes) {
  const match = String(text).match(/System-wide memory free percentage:\s*([\d.]+)%/i);
  const percentage = Number(match?.[1]);
  if (!Number.isFinite(percentage)) return null;
  return memorySnapshot(totalBytes, (Number(totalBytes) * clamp(percentage, 0, 100)) / 100, 'macos-memory-pressure');
}

export async function readHostMemory({
  platform = process.platform,
  totalBytes = os.totalmem(),
  freeBytes = os.freemem(),
  readFile = fs.readFile,
  execFileImpl = execFileAsync
} = {}) {
  if (platform === 'linux') {
    try {
      const snapshot = parseLinuxMeminfo(await readFile('/proc/meminfo', 'utf8'));
      if (snapshot) return snapshot;
    } catch {
      // Fall through to the portable free-memory estimate.
    }
  }
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileImpl('/usr/bin/memory_pressure', ['-Q'], { timeout: 1500 });
      const snapshot = parseMacMemoryPressure(stdout, totalBytes);
      if (snapshot) return snapshot;
    } catch {
      // Fall through when memory_pressure is unavailable.
    }
  }
  return memorySnapshot(totalBytes, freeBytes, 'os-freemem');
}
