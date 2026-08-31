import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { routeProfileStatus, writeRouteProfile } from '../src/route-control.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-route-control-'));
const configPath = path.join(directory, 'config.json');
const source = {
  server: { host: '127.0.0.1', port: 8100 },
  security: { allowMissingAuth: true },
  defaults: { chatModel: 'stable' },
  backends: {
    local: { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' },
    cloud: {
      type: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY'
    }
  },
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
  await fs.writeFile(configPath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  const config = await loadConfig(configPath, { env: { ...process.env, OPENROUTER_API_KEY: 'test' } });
  assert.deepEqual(routeProfileStatus(config, 'stable'), [
    {
      alias: 'stable',
      activeRoute: 'local-first',
      target: 'local-model',
      fallbacks: ['cloud-model'],
      profiles: ['local-first', 'cloud']
    }
  ]);

  const changed = await writeRouteProfile(config, 'stable', 'cloud');
  assert.equal(changed.changed, true);
  const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(written.aliases.stable.activeRoute, 'cloud');
  assert.equal(written.aliases.stable.target, 'cloud-model');
  assert.equal(written.aliases.stable.fallbacks, undefined);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

  const restored = await writeRouteProfile(config, 'stable', 'local-first');
  assert.equal(restored.changed, true);
  const restoredSource = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(restoredSource.aliases.stable.activeRoute, 'local-first');
  assert.equal(restoredSource.aliases.stable.target, 'local-model');
  assert.deepEqual(restoredSource.aliases.stable.fallbacks, ['cloud-model']);

  const reloaded = await loadConfig(configPath, { env: { ...process.env, OPENROUTER_API_KEY: 'test' } });
  const unchanged = await writeRouteProfile(reloaded, 'stable', 'local-first');
  assert.equal(unchanged.changed, false);
  await assert.rejects(writeRouteProfile(reloaded, 'stable', 'missing'), /unknown route profile/);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log('route control tests passed');
