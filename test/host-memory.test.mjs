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

// Full memory_pressure output: page counts (free+inactive+speculative+purgeable)
// must win over the opaque free percentage.
const paged = parseMacMemoryPressure(
  `The system has 103079215104 (6291456 pages with a page size of 16384).

Stats:
Pages free: 100000
Pages purgeable: 20000
Pages purged: 349093517

Page Q counts:
Pages active: 2130087
Pages inactive: 30000
Pages speculative: 5000
Pages throttled: 0
Pages wired down: 495904

System-wide memory free percentage: 1%`,
  96 * gibibyte
);
assert.equal(paged.source, 'macos-memory-pages');
assert.equal(paged.availableBytes, 155000 * 16384);

// Percentage-only output keeps the legacy path.
const percentOnly = parseMacMemoryPressure('System-wide memory free percentage: 44%', 96 * gibibyte);
assert.equal(percentOnly.source, 'macos-memory-pressure');
assert.equal(percentOnly.availableBytes, Math.round(96 * gibibyte * 0.44));

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
