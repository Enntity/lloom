import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { normalizeProfileDocument } from '../src/config-profiles.mjs';
import { applyHeadPromotion, profilesPathForConfig, sourceReadScript } from '../src/head-promotion-transfer.mjs';

const DESTINATION_KEY = 'synthetic-destination-key';
const SOURCE_KEY = 'synthetic-source-inference-key';
const SOURCE_URL = 'http://media-source.internal:8100';

function destinationConfig() {
  return {
    name: 'transfer acceptance destination',
    server: { host: '127.0.0.1', port: 8100 },
    security: {
      allowMissingAuth: true,
      allowRemoteAdmin: false,
      allowWildcardCors: false,
      allowNonLoopbackBind: false,
      apiKeys: [DESTINATION_KEY],
      adminApiKeys: []
    },
    backends: {
      local: { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' }
    },
    models: [{ id: 'local-model', backend: 'local', runtime: 'local-runtime', kind: 'chat' }],
    runtimes: {
      'local-runtime': {
        backend: 'local',
        keepWarm: true,
        authority: { owner: 'head', scope: 'local' }
      }
    },
    aliases: {
      chat: {
        members: ['local-model'],
        activeRoute: 'local',
        routeProfiles: { local: { members: ['local-model'] } }
      }
    },
    defaults: { chatModel: 'local-model', preservedDefault: 'keep-me' },
    fleet: { activeProfile: 'base' },
    cluster: {
      nodeId: 'head',
      leaderNode: 'head',
      nodes: { head: { labels: { role: 'leader' } } }
    }
  };
}

function sourceConfig({ profiles = undefined, fleet = undefined, security = { apiKeys: [SOURCE_KEY] } } = {}) {
  return {
    security,
    backends: {
      'tp-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:8299/v1' }
    },
    models: [
      {
        id: 'tp-model',
        backend: 'tp-backend',
        runtime: 'tp-runtime',
        upstreamModel: 'tp-upstream-model',
        kind: 'chat'
      }
    ],
    runtimes: {
      'tp-runtime': {
        backend: 'tp-backend',
        keepWarm: true,
        authority: { owner: 'media', scope: 'local' }
      }
    },
    aliases: {},
    defaults: {},
    ...(profiles === undefined ? {} : { profiles }),
    ...(fleet === undefined ? {} : { fleet }),
    cluster: {
      nodeId: 'media',
      leaderNode: 'media',
      nodes: { media: { labels: { role: 'worker' } } }
    }
  };
}

function envelope(overrides = {}) {
  return {
    sourceConfig: sourceConfig(),
    sourceProfiles: {},
    sourceInferenceKey: SOURCE_KEY,
    sourceUrl: SOURCE_URL,
    sourceNode: 'media',
    ...overrides
  };
}

function canonicalProfile(name, overrides = {}) {
  return {
    name,
    description: `${name} synthetic profile`,
    routes: { chat: 'local' },
    residency: { 'local-runtime': 'always' },
    defaults: { chatModel: 'local-model' },
    ...overrides
  };
}

async function tempDestination(t, { config = destinationConfig(), profiles = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'head-promotion-transfer-acceptance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  const profilesPath = profilesPathForConfig(configPath);
  if (Object.keys(profiles).length) {
    await fs.mkdir(profilesPath, { recursive: true, mode: 0o750 });
    await fs.chmod(profilesPath, 0o750);
    for (const [name, profile] of Object.entries(profiles)) {
      await fs.writeFile(path.join(profilesPath, `${name}.json`), `${JSON.stringify(profile, null, 2)}\n`, {
        mode: 0o640
      });
      await fs.chmod(path.join(profilesPath, `${name}.json`), 0o640);
    }
  }
  return { dir, configPath, profilesPath };
}

async function applyArgs(configPath, options = {}) {
  return applyHeadPromotion({
    configPath,
    envelope: envelope(),
    sourceUrl: SOURCE_URL,
    ...options
  });
}

function runSourceScript(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', sourceReadScript()], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (errorOutput += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(errorOutput || `source reader exited with ${code}`));
      else {
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('preview reads profiles but writes neither config nor profile files', async (t) => {
  const destination = await tempDestination(t, {
    profiles: {
      base: canonicalProfile('base'),
      unrelated: canonicalProfile('unrelated', { description: 'must survive preview' })
    }
  });
  const configBefore = await fs.readFile(destination.configPath);
  const unrelatedBefore = await fs.readFile(path.join(destination.profilesPath, 'unrelated.json'));
  const result = await applyArgs(destination.configPath);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(await fs.readFile(destination.configPath), configBefore);
  assert.deepEqual(await fs.readFile(path.join(destination.profilesPath, 'unrelated.json')), unrelatedBefore);
  await assert.rejects(() => fs.access(path.join(destination.profilesPath, 'standalone.json')), { code: 'ENOENT' });
});

test('apply publishes canonical standalone profile and preserves unrelated profile bytes and modes', async (t) => {
  const destination = await tempDestination(t, {
    profiles: {
      base: canonicalProfile('base'),
      unrelated: canonicalProfile('unrelated', { description: 'preserve this profile' })
    }
  });
  const unrelatedPath = path.join(destination.profilesPath, 'unrelated.json');
  const unrelatedBefore = await fs.readFile(unrelatedPath);
  const unrelatedMode = (await fs.stat(unrelatedPath)).mode & 0o777;
  const directoryMode = (await fs.stat(destination.profilesPath)).mode & 0o777;
  const preview = await applyArgs(destination.configPath);
  assert.equal(preview.ok, true);

  const result = await applyArgs(destination.configPath, {
    expectedDestinationHash: preview.destinationHash,
    includeSecrets: true,
    apply: true,
    yes: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.deepEqual(await fs.readFile(unrelatedPath), unrelatedBefore);
  assert.equal((await fs.stat(unrelatedPath)).mode & 0o777, unrelatedMode);
  assert.equal((await fs.stat(destination.profilesPath)).mode & 0o777, directoryMode);

  const standalonePath = path.join(destination.profilesPath, 'standalone.json');
  const standaloneRaw = JSON.parse(await fs.readFile(standalonePath, 'utf8'));
  const standalone = normalizeProfileDocument(standaloneRaw, 'standalone');
  assert.equal(standalone.routes.chat, 'local');
  assert.deepEqual(standalone.defaults, { chatModel: 'local-model', preservedDefault: 'keep-me' });
  assert.deepEqual(standalone.residency, { 'local-runtime': 'always' });
  assert.equal(standalone.defaultsMode, 'replace');
  assert.equal('kind' in standaloneRaw, false);
  assert.equal('origin' in standaloneRaw, false);
  assert.equal('aliases' in standaloneRaw, false);
  assert.equal((await fs.stat(standalonePath)).mode & 0o777, 0o600);

  const loaded = await loadConfig(destination.configPath);
  assert.equal(loaded.cluster.leaderNode, 'head');
  assert.equal(loaded.fleet.headPromotion.origin.sourceNode, 'media');
  assert.equal(loaded.defaults.chatModel, 'local-model');
  assert.equal(loaded.aliases.chat.activeRoute, 'local');
});

test('a second apply is an idempotent no-op', async (t) => {
  const destination = await tempDestination(t, { profiles: { base: canonicalProfile('base') } });
  const preview = await applyArgs(destination.configPath);
  assert.equal(preview.ok, true);
  const first = await applyArgs(destination.configPath, {
    expectedDestinationHash: preview.destinationHash,
    includeSecrets: true,
    apply: true,
    yes: true
  });
  assert.equal(first.applied, true);
  const configBefore = await fs.readFile(destination.configPath);
  const standaloneBefore = await fs.readFile(path.join(destination.profilesPath, 'standalone.json'));
  const repeatPreview = await applyArgs(destination.configPath);
  assert.equal(repeatPreview.ok, true);
  const repeat = await applyArgs(destination.configPath, {
    expectedDestinationHash: repeatPreview.destinationHash,
    includeSecrets: true,
    apply: true,
    yes: true
  });

  assert.equal(repeat.ok, true);
  assert.equal(repeat.applied, false);
  assert.equal(repeat.dryRun, false);
  assert.equal(repeat.summary.changed, false);
  assert.equal(repeat.summary.profiles.standalone, 'retained');
  assert.deepEqual(await fs.readFile(destination.configPath), configBefore);
  assert.deepEqual(await fs.readFile(path.join(destination.profilesPath, 'standalone.json')), standaloneBefore);
});

test('apply refuses a stale destination hash before writing', async (t) => {
  const destination = await tempDestination(t);
  const preview = await applyArgs(destination.configPath);
  assert.equal(preview.ok, true);
  await fs.appendFile(destination.configPath, '\n');
  const changedBefore = await fs.readFile(destination.configPath);

  await assert.rejects(
    applyArgs(destination.configPath, {
      expectedDestinationHash: preview.destinationHash,
      includeSecrets: true,
      apply: true,
      yes: true
    }),
    /changed since reviewed plan/
  );
  assert.deepEqual(await fs.readFile(destination.configPath), changedBefore);
  await assert.rejects(() => fs.access(path.join(destination.profilesPath, 'standalone.json')), { code: 'ENOENT' });
});

test('malformed and symlinked profile files are rejected before planning', async (t) => {
  const malformed = await tempDestination(t);
  await fs.mkdir(malformed.profilesPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(malformed.profilesPath, 'broken.json'), '{"routes":');
  await assert.rejects(() => applyArgs(malformed.configPath), /not valid JSON/);

  const symlinked = await tempDestination(t);
  await fs.mkdir(symlinked.profilesPath, { recursive: true, mode: 0o700 });
  const target = path.join(symlinked.dir, 'outside.json');
  await fs.writeFile(target, `${JSON.stringify(canonicalProfile('linked'))}\n`);
  await fs.symlink(target, path.join(symlinked.profilesPath, 'linked.json'));
  await assert.rejects(() => applyArgs(symlinked.configPath), /unsafe destination fleet profile/);
});

test('sourceReadScript reads config, environment, and canonical profile files without writing source state', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'head-promotion-source-acceptance-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.lloom');
  const envDir = path.join(home, '.config', 'lloom');
  const profilesDir = path.join(configDir, 'profiles');
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(envDir, { recursive: true });
  await fs.mkdir(profilesDir, { recursive: true });
  const sourceConfigPath = path.join(configDir, 'config.json');
  const envName = 'TRANSFER_ACCEPTANCE_SOURCE_KEY';
  const sourceConfigRaw = `${JSON.stringify(sourceConfig({ security: { apiKeys: [`\${${envName}}`] } }), null, 2)}\n`;
  const profileRaw = `${JSON.stringify(canonicalProfile('source-profile'), null, 2)}\n`;
  await fs.writeFile(sourceConfigPath, sourceConfigRaw, { mode: 0o600 });
  await fs.writeFile(path.join(envDir, 'env'), `${envName}=resolved-source-key\n`, { mode: 0o600 });
  await fs.writeFile(path.join(profilesDir, 'source-profile.json'), profileRaw, { mode: 0o600 });
  const beforeConfig = await fs.readFile(sourceConfigPath);
  const beforeProfile = await fs.readFile(path.join(profilesDir, 'source-profile.json'));
  const childEnv = { ...process.env, HOME: home };
  delete childEnv[envName];

  const result = await runSourceScript({ sourceUrl: `${SOURCE_URL}/` }, childEnv);

  assert.equal(result.sourceNode, 'media');
  assert.equal(result.sourceUrl, SOURCE_URL);
  assert.equal(result.sourceInferenceKey, 'resolved-source-key');
  assert.deepEqual(Object.keys(result.sourceProfiles), ['source-profile']);
  assert.deepEqual(result.sourceProfiles['source-profile'], JSON.parse(profileRaw));
  assert.deepEqual(await fs.readFile(sourceConfigPath), beforeConfig);
  assert.deepEqual(await fs.readFile(path.join(profilesDir, 'source-profile.json')), beforeProfile);
});
