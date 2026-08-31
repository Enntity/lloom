import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mergeSparkRouteCatalog } from '../scripts/apply-spark-route-catalog.mjs';

const catalog = JSON.parse(await fs.readFile(new URL('../deploy/dgx-spark/config.json', import.meta.url), 'utf8'));
const installed = {
  server: { host: '0.0.0.0', port: 8100 },
  aliases: {
    'qwen38f-next': { target: 'qwen3.8-flash-next', advertise: true },
    q38fn: { target: 'qwen3.8-flash-next', advertise: true },
    glm53f: { target: 'glm-5.3-flash-exl3', advertise: true }
  },
  backends: {
    local: { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' }
  },
  models: [
    { id: 'qwen3.8-flash-next', kind: 'chat', backend: 'local', upstreamModel: 'qwen' },
    { id: 'glm-5.3-flash-exl3', kind: 'chat', backend: 'local', upstreamModel: 'glm' },
    { id: 'deepseek-v4-flash-0731', kind: 'chat', backend: 'local', upstreamModel: 'deepseek' }
  ],
  clientCatalog: { omp: { roles: { default: 'old-model:low' } } }
};

const merged = mergeSparkRouteCatalog(installed, catalog);
assert.equal(merged.server.inferenceEnabled, true);
assert.equal(merged.aliases['qwen38f-next'], undefined);
assert.deepEqual(merged.aliases.q38fn.members, ['qwen3.8-flash-next', 'cloud/openrouter/q38fn']);
assert.deepEqual(merged.aliases.ds4f.members, ['deepseek-v4-flash-0731', 'cloud/openrouter/ds4f']);
assert.deepEqual(merged.aliases.ds4fv.members, ['cloud/openrouter/ds4fv']);
assert.deepEqual(merged.aliases.glm53f.members, ['glm-5.3-flash-exl3', 'cloud/openrouter/glm53f']);
assert.equal(merged.clientCatalog.omp.roles.default, 'q38fn:low');
for (const modelId of ['ds4f', 'ds4fv', 'q38fn', 'glm53f']) {
  assert(merged.models.some((model) => model.id === `cloud/openrouter/${modelId}`));
}

const legacyCloudOnly = structuredClone(merged);
legacyCloudOnly.aliases.q38fn = { target: 'cloud/openrouter/q38fn', advertise: true };
const reapplied = mergeSparkRouteCatalog(legacyCloudOnly, catalog);
assert.deepEqual(reapplied.aliases.q38fn.members, ['qwen3.8-flash-next', 'cloud/openrouter/q38fn']);
assert.equal(reapplied.aliases.q38fn.target, undefined);

console.log('spark route catalog tests passed');
