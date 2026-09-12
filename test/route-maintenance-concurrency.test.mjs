import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { mutateConfigSource } from '../src/config-mutation.mjs';
import { writeRouteProfile } from '../src/route-control.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-route-maintenance-'));
const configPath = path.join(directory, 'config.json');
const placeholder = '$' + '{OPENROUTER_API_KEY}';
const source = {
  server: { host: '127.0.0.1', port: 8110 },
  security: { allowMissingAuth: true },
  defaults: { chatModel: 'stable' },
  backends: {
    local: { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' },
    cloud: {
      type: 'openai',
      baseUrl: 'http://127.0.0.1:8202/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY'
    }
  },
  runtimes: { resident: { enabled: true, keepWarm: true } },
  models: [
    { id: 'local-model', kind: 'chat', backend: 'local', upstreamModel: 'local-model' },
    { id: 'cloud-model', kind: 'chat', backend: 'cloud', upstreamModel: 'cloud-model' }
  ],
  aliases: {
    stable: {
      target: 'local-model',
      fallbacks: ['cloud-model'],
      activeRoute: 'local-first',
      routeProfiles: {
        'local-first': { target: 'local-model', fallbacks: ['cloud-model'] },
        cloud: { target: 'cloud-model' }
      }
    }
  }
};

try {
  await fs.writeFile(
    configPath,
    `${JSON.stringify(source, null, 2)}\n`.replace(
      '"apiKeyEnv": "OPENROUTER_API_KEY"',
      `"apiKeyEnv": "${placeholder}"`
    ),
    { mode: 0o600 }
  );
  const config = await loadConfig(configPath, { env: { ...process.env, OPENROUTER_API_KEY: 'test-secret' } });

  const [flip, maintenance] = await Promise.all([
    writeRouteProfile(config, 'stable', 'cloud'),
    mutateConfigSource(config, (raw) => {
      raw.runtimes.resident.maintenance = {
        state: 'suspended',
        requestedModel: 'local-model',
        since: '2026-01-01T00:00:00Z',
        operationId: 'synthetic'
      };
    })
  ]);

  assert.equal(flip.changed, true);
  assert.equal(flip.alias, 'stable');
  assert.equal(flip.activeRoute, 'cloud');
  assert.deepEqual(flip.members, ['cloud-model']);
  assert.equal(maintenance.changed, true);

  const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(written.aliases.stable.activeRoute, 'cloud');
  assert.deepEqual(written.aliases.stable.members, ['cloud-model']);
  assert.equal(written.runtimes.resident.maintenance.state, 'suspended');
  assert.equal(written.backends.cloud.apiKeyEnv, placeholder);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

  const reloaded = await loadConfig(configPath, { env: { ...process.env, OPENROUTER_API_KEY: 'test-secret' } });
  assert.equal(reloaded.aliases.stable.activeRoute, 'cloud');
  assert.deepEqual(reloaded.aliases.stable.members, ['cloud-model']);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log('route maintenance concurrency tests passed');
