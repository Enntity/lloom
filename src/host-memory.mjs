// One sensor implementation, owned by Accord. Injected probes remain available
// for deterministic platform tests; production admission uses the host daemon.
import { readHostMemory as probe } from '../vendor/accord/vendor/lloom/host-memory.mjs';
import { accordSample } from './accord-client.mjs';
export { parseLinuxMeminfo, parseMacMemoryPressure } from '../vendor/accord/vendor/lloom/host-memory.mjs';
export async function readHostMemory(options = {}) {
  if (options.readFile || options.execFileImpl) return probe(options);
  const sample = await accordSample('memory');
  if (!sample.memory || !Number.isFinite(sample.memory.availableBytes) || sample.ageMs > 1000)
    throw Error('Accord memory is stale or unavailable; model admission refused');
  return sample.memory;
}
