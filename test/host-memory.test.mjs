import assert from 'node:assert/strict';
import { parseLinuxMeminfo, parseMacMemoryPressure, readHostMemory } from '../src/host-memory.mjs';

const gibibyte = 1024 ** 3;

const linux = parseLinuxMeminfo(`
MemTotal:       100663296 kB
MemFree:          1048576 kB
MemAvailable:    50331648 kB
`);
assert.equal(linux.totalBytes, 96 * gibibyte);
assert.equal(linux.availableBytes, 48 * gibibyte);
assert.equal(linux.usedBytes, 48 * gibibyte);
assert.equal(linux.utilization, 50);
assert.equal(linux.source, 'linux-memavailable');

const mac = parseMacMemoryPressure(
  `The system has 103079215104 (6291456 pages with a page size of 16384).
System-wide memory free percentage: 44%`,
  96 * gibibyte
);
assert.equal(mac.availableBytes, Math.round(96 * gibibyte * 0.44));
assert(Math.abs(mac.utilization - 56) < 0.000001);
assert.equal(mac.source, 'macos-memory-pressure');

const sampledMac = await readHostMemory({
  platform: 'darwin',
  totalBytes: 96 * gibibyte,
  freeBytes: gibibyte,
  execFileImpl: async () => ({ stdout: 'System-wide memory free percentage: 25%' })
});
assert.equal(sampledMac.availableBytes, 24 * gibibyte);
assert.equal(sampledMac.utilization, 75);

const fallback = await readHostMemory({
  platform: 'darwin',
  totalBytes: 96 * gibibyte,
  freeBytes: 6 * gibibyte,
  execFileImpl: async () => {
    throw new Error('unavailable');
  }
});
assert.equal(fallback.availableBytes, 6 * gibibyte);
assert.equal(fallback.utilization, 93.75);
assert.equal(fallback.source, 'os-freemem');

console.log('host memory tests passed');
