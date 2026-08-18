import assert from 'node:assert/strict';
import { evaluateRecipe, normalizeMachineProfile, validateMachineProfile } from '../src/machine-profile.mjs';
import { evaluateResourceFit, machineTopologyFingerprint } from '../src/resource-fit.mjs';

const apple = normalizeMachineProfile({
  platform: 'darwin',
  arch: 'arm64',
  platformId: 'darwin-arm64',
  cpuBrand: 'Apple M2 Max',
  logicalCpus: 12,
  totalMemoryGb: 96,
  availableMemoryGb: 40,
  isAppleSilicon: true
});

assert.deepEqual(validateMachineProfile(apple), []);
assert.equal(apple.memoryDomains.length, 1);
assert.equal(apple.memoryDomains[0].kind, 'unified');
assert.equal(apple.memoryDomains[0].capacityGb, 96);
assert.match(apple.topologyFingerprint, /^sha256:[a-f0-9]{64}$/);

const sameTopology = { ...apple, availableMemoryGb: 8, memoryDomains: [{ ...apple.memoryDomains[0], availableGb: 8 }] };
assert.equal(machineTopologyFingerprint(apple), machineTopologyFingerprint(sameTopology));

const fit = evaluateResourceFit(apple, {
  memoryGb: 32,
  reserveGb: 4,
  contextWindow: 131072,
  source: 'backend-preflight',
  confidence: 'measured'
});
assert.equal(fit.status, 'fits');
assert.equal(fit.stableFit, true);
assert.equal(fit.currentlyLoadable, true);
assert.equal(fit.domains[0].requiredGb, 36);
assert.equal(fit.domains[0].capacityMarginGb, 60);
assert.equal(fit.domains[0].availableMarginGb, 4);

const loaded = evaluateResourceFit(sameTopology, { memoryGb: 32, reserveGb: 4 });
assert.equal(loaded.stableFit, true);
assert.equal(loaded.currentlyLoadable, false);

const discrete = normalizeMachineProfile({
  platform: 'linux',
  arch: 'x64',
  totalMemoryGb: 64,
  devices: [{ id: 'cuda:0', kind: 'gpu', vendor: 'nvidia', backend: 'cuda', memoryGb: 24 }]
});
const deviceFit = evaluateResourceFit(discrete, {
  domains: [{ id: 'device:cuda:0', kind: 'device', backend: 'cuda', memoryGb: 20 }]
});
assert.equal(deviceFit.stableFit, true);
assert.equal(deviceFit.domains[0].capacityMarginGb, 4);

const recipe = {
  id: 'fit-test',
  name: 'Fit test',
  requirements: {
    platforms: ['darwin-arm64'],
    resourceEstimate: {
      memoryGb: 100,
      source: 'backend-preflight'
    }
  }
};
const evaluation = await evaluateRecipe(recipe, apple, { checkCommands: false });
assert.equal(evaluation.selectable, false);
assert.equal(evaluation.memorySupported, false);
assert.equal(evaluation.resourceFit.status, 'does-not-fit');
assert(evaluation.reasons.some((reason) => reason.includes('requires 100 GB in unified:0')));

console.log('resource fit tests passed');
