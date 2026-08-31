import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mergeSparkRouteCatalog } from '../scripts/apply-spark-route-catalog.mjs';

const catalog = JSON.parse(await fs.readFile(new URL('../deploy/dgx-spark/config.json', import.meta.url), 'utf8'));
const installed = {
  server: { host: '0.0.0.0', port: 8100 },
  aliases: {
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
assert.equal(merged.aliases.q38fn.activeRoute, 'local-first');
assert.equal(merged.aliases.q38fn.target, 'qwen3.8-flash-next');
assert.deepEqual(merged.aliases.q38fn.fallbacks, ['cloud/openrouter/q38fn']);
assert.equal(merged.aliases.ds4f.activeRoute, 'local-first');
assert.equal(merged.aliases.ds4fv.activeRoute, 'cloud');
assert.equal(merged.aliases.ds4fv.target, 'cloud/openrouter/ds4fv');
assert.equal(merged.aliases.glm53f.activeRoute, 'local-first');
assert.equal(merged.clientCatalog.omp.roles.default, 'q38fn:low');
for (const modelId of ['ds4f', 'ds4fv', 'q38fn', 'glm53f']) {
  assert(merged.models.some((model) => model.id === `cloud/openrouter/${modelId}`));
}

const maintenance = structuredClone(merged);
maintenance.aliases.q38fn.activeRoute = 'cloud';
maintenance.aliases.q38fn.target = 'cloud/openrouter/q38fn';
delete maintenance.aliases.q38fn.fallbacks;
const reapplied = mergeSparkRouteCatalog(maintenance, catalog);
assert.equal(reapplied.aliases.q38fn.activeRoute, 'cloud');
assert.equal(reapplied.aliases.q38fn.target, 'cloud/openrouter/q38fn');

console.log('spark route catalog tests passed');
