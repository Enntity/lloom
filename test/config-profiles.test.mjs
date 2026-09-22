import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import {
  composeProfile,
  createFleetProfileController,
  listProfiles,
  normalizeProfileDocument,
  planProfileChanges,
  readProfile
} from '../src/config-profiles.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-fleet-profiles-'));
const configPath = path.join(directory, 'config.json');
const source = {
  server: { host: '127.0.0.1', port: 8100 },
  security: { allowMissingAuth: true },
  defaults: { chatModel: 'local-model' },
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
  runtimes: {
    'local-model': { command: 'vllm', port: 8201, enabled: true, managed: true, keepWarm: true }
  },
  aliases: {
    omp: {
      members: ['local-model', 'cloud-model'],
      activeRoute: 'local-first',
      routeProfiles: {
        'local-first': { members: ['local-model', 'cloud-model'] },
        cloud: { members: ['cloud-model'] }
      }
    },
    simple: { members: ['local-model'] }
  }
};

const writeProfileFile = async (name, doc) => {
  const dir = path.join(directory, 'profiles');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name + '.json'), `${JSON.stringify(doc, null, 2)}\n`);
};

try {
  await fs.writeFile(configPath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  const config = await loadConfig(configPath, { env: { ...process.env, OPENROUTER_API_KEY: 'test' } });

  // -- document normalization ------------------------------------------------
  assert.deepEqual(normalizeProfileDocument({ routes: { omp: 'cloud' } }, 'p'), {
    name: 'p',
    description: '',
    routes: { omp: 'cloud' },
    residency: {},
    defaults: null
  });
  assert.throws(() => normalizeProfileDocument({ nope: true }, 'p'), /unsupported sections/);
  assert.throws(() => normalizeProfileDocument({ residency: { x: 'sometimes' } }, 'p'), /always, preferred, or auto/);

  // -- planning ---------------------------------------------------------------
  const localProfile = normalizeProfileDocument(
    { routes: { omp: 'local-first', simple: 'local-model' }, residency: { 'local-model': 'preferred' } },
    'local'
  );
  const cloudProfile = normalizeProfileDocument(
    { routes: { omp: 'cloud' }, residency: { 'local-model': 'auto' }, defaults: { chatModel: 'cloud-model' } },
    'cloud'
  );
  const localPlan = planProfileChanges(config, localProfile);
  assert.equal(localPlan.unchanged.length, 2, 'omp route + residency are no-ops; simple pins members (members rewrite)');
  const cloudPlan = planProfileChanges(config, cloudProfile);
  assert.equal(cloudPlan.routes.length, 1);
  assert.deepEqual(cloudPlan.routes[0], {
    id: 'omp',
    from: 'local-first',
    to: 'cloud',
    activeRoute: 'cloud',
    members: ['cloud-model'],
    optionalMembers: []
  });
  assert.deepEqual(cloudPlan.residency, [{ id: 'local-model', from: 'always', to: 'auto' }]);
  assert.deepEqual(cloudPlan.defaults, [{ id: 'chatModel', from: 'local-model', to: 'cloud-model' }]);
  assert.throws(() => planProfileChanges(config, normalizeProfileDocument({ routes: { ghost: 'cloud' } }, 'x')), /no alias ghost/);
  assert.throws(
    () => planProfileChanges(config, normalizeProfileDocument({ residency: { ghost: 'auto' } }, 'x')),
    /no runtime ghost/
  );

  // -- compose ------------------------------------------------------------------
  const composed = composeProfile(structuredClone(source), cloudProfile, 'cloud');
  assert.equal(composed.fleet.activeProfile, 'cloud');
  assert.deepEqual(composed.aliases.omp.members, ['cloud-model']);
  assert.equal(composed.aliases.omp.activeRoute, 'cloud');
  assert.equal(composed.runtimes['local-model'].keepWarm, false);
  assert.equal(composed.runtimes['local-model'].preferredWarm, false);
  assert.equal(composed.defaults.chatModel, 'cloud-model');

  // Composed output must survive real config validation (validate-all-then-apply
  // relies on loadConfig accepting the staged candidate).
  const staged = path.join(directory, 'staged.json');
  await fs.writeFile(staged, `${JSON.stringify(composed, null, 2)}\n`);
  const reloaded = await loadConfig(staged, { env: { ...process.env, OPENROUTER_API_KEY: 'test' } });
  assert.equal(reloaded.aliases.omp.activeRoute, 'cloud');

  // -- controller: apply flips the file atomically and hot-marks active ----------
  const controller = createFleetProfileController({
    getConfig: () => config,
    reload: () => {},
    env: { ...process.env, OPENROUTER_API_KEY: 'test' }
  });
  await writeProfileFile('cloud', cloudProfile);
  await writeProfileFile('local', localProfile);

  await assert.rejects(controller.apply('cloud', { yes: false }), /confirm with yes/);
  await assert.rejects(controller.apply('missing', { yes: true }), /ENOENT|no such file/i);

  const applied = await controller.apply('cloud', { yes: true });
  assert.equal(applied.profile, 'cloud');
  assert.equal(applied.routes.length, 1);
  assert.equal(applied.unchanged.length, 0, 'second plan sees no changes after apply? no: apply recomputes against raw');
  const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(onDisk.fleet.activeProfile, 'cloud');
  assert.deepEqual(onDisk.aliases.omp.members, ['cloud-model']);

  // Listing reflects the active marker.
  const listing = await listProfiles(config);
  assert.equal(listing.active, 'cloud');
  const cloudEntry = listing.profiles.find((profile) => profile.name === 'cloud');
  assert.equal(cloudEntry.active, true);

  // Applying the equal-content local profile is a clean no-op write.
  const rerun = await controller.apply('local', { yes: true });
  assert.equal(rerun.profile, 'local');

  // -- save captures the live config --------------------------------------------
  const saved = await controller.save('snapshot', { yes: true, description: 'point in time' });
  assert.equal(saved.profile, 'snapshot');
  const snapshotDoc = JSON.parse(await fs.readFile(saved.file, 'utf8'));
  assert.equal(snapshotDoc.routes.omp, 'local-first', 'save records the active route profile');
  assert.equal(snapshotDoc.residency['local-model'], 'preferred', 'the applied local profile set preferred');
  await assert.rejects(controller.save('snapshot', { yes: true }), /already exists/);
  await controller.save('snapshot', { yes: true, overwrite: true });

  // readProfile normalizes documents for display.
  const shown = await readProfile(config, 'snapshot');
  assert.equal(shown.name, 'snapshot');
  await assert.rejects(() => readProfile(config, '../escape'), /Invalid profile name/);
  await assert.rejects(() => readProfile(config, 'missing'), /ENOENT/);

  console.log('fleet profile tests passed');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
