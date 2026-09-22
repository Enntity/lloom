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
  const text_ = String(text);
  const page = (name) => Number(text_.match(new RegExp('^Pages ' + name + ':\\s*(\\d+)', 'm'))?.[1]);
  const pageSize = Number(text_.match(/page size of (\d+)/)?.[1]) || 16384;
  const free = page('free');
  const inactive = page('inactive');
  const speculative = page('speculative');
  const purgeable = page('purgeable');
  // XNU considers free + inactive + speculative + purgeable pages available;
  // the "System-wide memory free percentage" is an opaque kernel estimate that
  // can understate true availability while the file cache holds pages.
  if ([free, inactive, speculative, purgeable].every(Number.isFinite)) {
    return memorySnapshot(totalBytes, Math.min(totalBytes, (free + inactive + speculative + purgeable) * pageSize), 'macos-memory-pages');
  }
  const match = text_.match(/System-wide memory free percentage:\s*([\d.]+)%/i);
  const percentage = Number(match?.[1]);
  if (!Number.isFinite(percentage)) return null;
  return memorySnapshot(totalBytes, (totalBytes * clamp(percentage, 0, 100)) / 100, 'macos-memory-pressure');
}

export async function readHostMemory({
  platform = process.platform,
  totalBytes = os.totalmem(),
  freeBytes = os.freemem(),
  strict = false,
  readFile = fs.readFile,
  execFileImpl = execFileAsync
} = {}) {
  if (platform === 'linux') {
    try {
      const snapshot = parseLinuxMeminfo(await readFile('/proc/meminfo', 'utf8'));
      if (snapshot) return snapshot;
    } catch (error) {
      if (strict) throw error;
      // Fall through to the portable free-memory estimate.
    }
    if (strict) throw new Error('Linux available-memory telemetry is unavailable');
  }
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileImpl('/usr/bin/memory_pressure', [], { timeout: strict ? 750 : 1500 });
      const snapshot = parseMacMemoryPressure(stdout, totalBytes);
      if (snapshot) return snapshot;
    } catch (error) {
      if (strict) throw error;
      // Fall through when memory_pressure is unavailable.
    }
    if (strict) throw new Error('macOS memory-pressure telemetry is unavailable');
  }
  return memorySnapshot(totalBytes, freeBytes, 'os-freemem');
}
