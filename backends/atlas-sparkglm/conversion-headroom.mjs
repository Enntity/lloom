// MIT. GB10 shares system memory; nvidia-smi may report N/A for memory.free.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function conversionHeadroomMiB(memoryFree, gpuNames, meminfo) {
  const values = memoryFree.trim().split(/\r?\n/);
  if (values.length && values.every((value) => /^\d+$/.test(value.trim()))) {
    return Math.min(...values.map(Number));
  }
  const names = gpuNames.trim().split(/\r?\n/);
  if (!names.length || names.some((name) => !/^NVIDIA GB10$/.test(name.trim()))) {
    throw new Error('GPU free memory is unavailable and the device is not GB10');
  }
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!available) throw new Error('GB10 MemAvailable is unavailable');
  return Math.floor(Number(available[1]) / 1024);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const query = (field) =>
      execFileSync('nvidia-smi', [`--query-gpu=${field}`, '--format=csv,noheader,nounits'], { encoding: 'utf8' });
    console.log(conversionHeadroomMiB(query('memory.free'), query('name'), readFileSync('/proc/meminfo', 'utf8')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
