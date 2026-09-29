import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  applyHeadPromotion,
  profilesPathForConfig,
  runHeadPromotionTransfer,
  sourceReadCommand,
  sourceReadScript,
  targetCommand,
  validateSshHost
} from '../src/head-promotion-transfer.mjs';

const SECRET = 'sk-fixture-source-1111';
const ADMIN_SECRET = 'sk-fixture-source-admin-2222';
const DEST_KEY = 'sk-fixture-destination-0000';

function destinationConfig(overrides = {}) {
  return {
    server: { port: 8200 },
    security: { apiKeys: [DEST_KEY] },
    cluster: {
      nodeId: 'head',
      leaderNode: 'head',
      nodes: { head: { labels: { role: 'leader' } } }
    },
    models: [{ id: 'local-model', backend: 'local-backend' }],
    backends: { 'local-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' } },
    aliases: { chat: { members: ['local-model'] } },
    defaults: { chatModel: 'local-model' },
    ...overrides
  };
}

function sourceConfig(overrides = {}) {
  return {
    cluster: {
      nodeId: 'media',
      leaderNode: 'media',
      nodes: { media: { labels: { role: 'leader' } } }
    },
    models: [{ id: 'tp-model', backend: 'tp-backend' }],
    runtimes: { 'tp2-runtime': { backend: 'tp-backend', keepWarm: true } },
    backends: { 'tp-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:8299/v1' } },
    aliases: {
      chat: { members: ['tp-model'] },
      'media/tp-model': { members: ['media/local-model'] }
    },
    defaults: { chatModel: 'tp-model' },
    fleet: { activeProfile: 'fast' },
    profiles: {
      fast: {
        defaults: { chatModel: 'tp-model' },
        routes: { chat: 'tp-model' }
      }
    },
    ...overrides
  };
}

function envelope(overrides = {}) {
  return {
    sourceConfig: sourceConfig(),
    sourceProfiles: sourceConfig().profiles,
    sourceInferenceKey: SECRET,
    sourceAdminKey: ADMIN_SECRET,
    sourceUrl: 'http://media.example.test:8100',
    sourceNode: 'media',
    ...overrides
  };
}

async function tempConfig(t, config = destinationConfig(), profiles = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'head-promotion-transfer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const profilesPath = profilesPathForConfig(configPath);
  if (Object.keys(profiles).length) {
    await fs.mkdir(profilesPath, { mode: 0o700 });
    for (const [name, profile] of Object.entries(profiles))
      await fs.writeFile(path.join(profilesPath, name + '.json'), JSON.stringify(profile), { mode: 0o600 });
  }
  return { dir, configPath, profilesPath };
}

function runScript(input, env = {}, includeSecrets = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', sourceReadScript(includeSecrets)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => (out += part));
    child.stderr.on('data', (part) => (err += part));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    child.stdin.end(JSON.stringify(input));
  });
}

test('SSH hosts reject injection and source/target commands stay fixed', async () => {
  for (const host of ['-oProxyCommand=x', 'bad;id', '$(id)', 'a b', 'a\nb']) {
    assert.throws(() => validateSshHost(host));
  }
  assert.equal(validateSshHost('operator@media'), 'operator@media');
  assert.equal(
    targetCommand({}),
    'export PATH="$HOME/.local/bin:$PATH"; node "$HOME/.local/lib/node_modules/lloom/bin/lloom.mjs" cluster promote-head --from - --json'
  );
  assert.equal(
    targetCommand({ includeSecrets: true, apply: true, yes: true, expectedDestinationHash: 'a'.repeat(64) }),
    'export PATH="$HOME/.local/bin:$PATH"; node "$HOME/.local/lib/node_modules/lloom/bin/lloom.mjs" cluster promote-head --from - --json --include-secrets --apply --yes --expect-destination ' +
      'a'.repeat(64)
  );
  assert.throws(() => targetCommand({ apply: true, yes: false, includeSecrets: true }), /--yes/);
  assert.throws(() => targetCommand({ apply: true, yes: true }), /--expect-destination/);
  assert.throws(() => targetCommand({ apply: true, yes: true, includeSecrets: true }), /--expect-destination/);
  assert.throws(() => targetCommand({ expectedDestinationHash: 'not-a-hash' }), /expect-destination/);
});

test('source read script resolves one accepted inference key and never writes source files', async (t) => {
  const script = sourceReadScript();
  assert.match(sourceReadCommand(), /^export PATH="\$HOME\/\.local\/bin:\$PATH" LLOOM_SOURCE_SCRIPT_B64=/);
  assert.equal(
    Buffer.from(sourceReadCommand().match(/LLOOM_SOURCE_SCRIPT_B64='([^']+)'/)?.[1] ?? '', 'base64').toString('utf8'),
    script
  );
  assert.ok(script.includes('$HOME/.local/bin') === false, 'PATH wrapper belongs in the SSH command');
  assert.ok(script.includes('process.stdout.write'));
  assert.ok(!script.includes('writeFile'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.lloom'), { recursive: true });
  await fs.mkdir(path.join(dir, '.config/lloom'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.lloom/config.json'),
    JSON.stringify(
      sourceConfig({
        security: {
          apiKeys: ['${LLOOM_PROMOTION_TEST_KEY}'],
          adminApiKeys: ['${LLOOM_PROMOTION_TEST_ADMIN_KEY}']
        }
      })
    )
  );
  await fs.writeFile(
    path.join(dir, '.config/lloom/env'),
    'LLOOM_PROMOTION_TEST_KEY=resolved-source-key\nLLOOM_PROMOTION_TEST_ADMIN_KEY=resolved-source-admin-key\n'
  );
  await fs.mkdir(path.join(dir, '.lloom/profiles'));
  await fs.writeFile(path.join(dir, '.lloom/profiles/fast.json'), JSON.stringify(sourceConfig().profiles.fast));
  const result = await runScript(
    { sourceUrl: 'http://media.example.test:8100/' },
    {
      HOME: dir,
      LLOOM_PROMOTION_TEST_KEY: 'resolved-source-key',
      LLOOM_PROMOTION_TEST_ADMIN_KEY: 'resolved-source-admin-key'
    }
  );
  assert.equal(result.sourceNode, 'media');
  assert.equal(result.sourceUrl, 'http://media.example.test:8100');
  assert.equal(result.sourceInferenceKey, 'resolved-source-key');
  assert.equal(result.sourceAdminKey, 'resolved-source-admin-key');
  assert.deepEqual(Object.keys(result.sourceProfiles), ['fast']);
});

test('SSH transport uses stdin and redacts unresolved secrets on dry runs', async () => {
  const calls = [];
  const transport = async (host, command, input) => {
    calls.push({ host, command, input: input.toString() });
    return calls.length === 1
      ? JSON.stringify(
          envelope({
            sourceConfig: { ...sourceConfig(), security: { apiKeys: [SECRET], adminApiKeys: [ADMIN_SECRET] } }
          })
        )
      : JSON.stringify({ ok: true, applied: false, dryRun: true });
  };
  const result = await runHeadPromotionTransfer({
    sourceSsh: 'source',
    targetSsh: 'target',
    sourceUrl: 'http://review.example.test:8100',
    transport
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.host),
    ['source', 'target']
  );
  assert.match(calls[0].command, /^export PATH="\$HOME\/\.local\/bin:\$PATH" LLOOM_SOURCE_SCRIPT_B64=/);
  assert.match(calls[0].command, /exec node --input-type=module --eval/);
  assert.ok(calls[0].input.includes('review.example.test'));
  assert.ok(calls[0].input.length < 200, 'source request contains no source config');
  assert.ok(calls[1].command.includes('--from -'));
  assert.ok(calls[1].input.includes('review.example.test'));
  assert.ok(!calls[1].command.includes(SECRET));
  assert.ok(!calls[1].input.includes(SECRET));
  assert.ok(!calls[1].command.includes(ADMIN_SECRET));
  assert.ok(!calls[1].input.includes(ADMIN_SECRET));
});

test('local dry run is secret-free and mutates neither config nor profiles', async (t) => {
  const { configPath, profilesPath } = await tempConfig(t);
  const before = await fs.readFile(configPath, 'utf8');
  const result = await applyHeadPromotion({
    configPath,
    envelope: envelope(),
    sourceUrl: 'http://media.example.test:8100'
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.counts.federatedModels, 1);
  assert.equal(result.counts.migratedProfiles, 1);
  assert.match(JSON.stringify(result), /tp-model/);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
  await assert.rejects(() => fs.access(profilesPath), /ENOENT/);
});

test('promotion apply preserves destination state and is idempotent', async (t) => {
  const { configPath, profilesPath } = await tempConfig(
    t,
    destinationConfig({
      aliases: { chat: { members: ['local-model'] }, special: { members: ['local-model'] } }
    })
  );
  const expectedHash = (await applyHeadPromotion({ configPath, envelope: envelope(), includeSecrets: true }))
    .destinationHash;
  const first = await applyHeadPromotion({
    configPath,
    envelope: envelope(),
    sourceUrl: 'http://media.example.test:8100',
    expectedDestinationHash: expectedHash,
    includeSecrets: true,
    apply: true,
    yes: true
  });
  assert.equal(first.ok, true);
  assert.equal(first.applied, true);
  assert.ok(!JSON.stringify(first).includes(SECRET));
  assert.ok(!JSON.stringify(first).includes(ADMIN_SECRET));

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(raw.security.apiKeys, [DEST_KEY, SECRET]);
  assert.equal(raw.cluster.fleetHeadNode, 'head');
  assert.equal(raw.cluster.leaderNode, 'head');
  assert.equal(
    raw.models.some((model) => model.id === 'local-model'),
    true
  );
  assert.equal(
    raw.models.some((model) => model.id === 'tp-model'),
    false
  );
  assert.equal(raw.runtimes, undefined);
  assert.equal(raw.backends['lloom-node-media'].apiKey, SECRET);
  assert.equal(raw.security.apiKeys.includes(ADMIN_SECRET), false);
  assert.deepEqual(raw.backends['lloom-node-media'].baseUrl, 'http://media.example.test:8100/v1');
  const proxy = raw.cluster.nodes.media.proxy;
  assert.deepEqual(proxy.models, [
    { id: 'tp-model', as: 'tp-model', kind: 'chat', remoteRuntime: 'tp2-runtime', upstreamModel: 'tp-model' }
  ]);
  assert.equal(raw.cluster.nodes.media.apiKey, ADMIN_SECRET);
  assert.equal(raw.aliases.chat.members[0], 'tp-model');
  assert.deepEqual(raw.aliases.chat.routeProfiles.local.members, ['local-model']);
  assert.equal(raw.aliases['media/tp-model'].members[0], 'local-model');
  assert.equal(raw.aliases['media/local-model'].members[0], 'local-model');
  assert.equal(raw.defaults.chatModel, 'tp-model');
  assert.equal(raw.profiles, undefined);
  assert.equal(raw.fleet.activeProfile, 'fast');

  const profiles = Object.fromEntries(
    await Promise.all(
      (await fs.readdir(profilesPath))
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => [n.slice(0, -5), JSON.parse(await fs.readFile(path.join(profilesPath, n), 'utf8'))])
    )
  );
  assert.equal(profiles.standalone.defaultsMode, 'replace');
  assert.equal(raw.fleet.headPromotion.origin.sourceNode, 'media');
  assert.deepEqual(profiles.standalone.defaults.chatModel, 'local-model');
  assert.deepEqual(profiles.fast.defaults.chatModel, 'tp-model');
  const configMode = (await fs.stat(configPath)).mode & 0o777;
  const profilesMode = (await fs.stat(path.join(profilesPath, 'standalone.json'))).mode & 0o777;
  assert.equal(configMode, 0o600);
  assert.equal(profilesMode, 0o600);
  assert.equal(first.backups.profiles, undefined);
  for (const backupPath of [first.backups.config]) {
    assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  }

  const currentHash = (await applyHeadPromotion({ configPath, envelope: envelope(), includeSecrets: true }))
    .destinationHash;
  const repeat = await applyHeadPromotion({
    configPath,
    envelope: envelope(),
    sourceUrl: 'http://media.example.test:8100',
    expectedDestinationHash: currentHash,
    includeSecrets: true,
    apply: true,
    yes: true
  });
  assert.equal(repeat.applied, false);
  assert.equal(repeat.summary.changed, false);
  assert.equal(repeat.summary.profiles.standalone, 'retained');
});

test('apply guards, hash checks, conflicts, and validation rollback fail closed', async (t) => {
  const guard = await tempConfig(t);
  const guardEnvelope = envelope();
  await assert.rejects(
    applyHeadPromotion({
      configPath: guard.configPath,
      envelope: guardEnvelope,
      apply: true,
      yes: true,
      includeSecrets: true
    }),
    /expect-destination/
  );
  await assert.rejects(
    applyHeadPromotion({
      configPath: guard.configPath,
      envelope: guardEnvelope,
      expectedDestinationHash: 'a'.repeat(64),
      apply: true,
      yes: true
    }),
    /include-secrets/
  );
  await assert.rejects(
    applyHeadPromotion({
      configPath: guard.configPath,
      envelope: guardEnvelope,
      expectedDestinationHash: 'a'.repeat(64),
      includeSecrets: true,
      apply: true
    }),
    /--yes/
  );
  await assert.rejects(
    applyHeadPromotion({
      configPath: guard.configPath,
      envelope: { ...guardEnvelope, sourceInferenceKey: null },
      expectedDestinationHash: 'a'.repeat(64),
      includeSecrets: true,
      apply: true,
      yes: true
    }),
    /inference key/
  );
  await assert.rejects(
    applyHeadPromotion({
      configPath: guard.configPath,
      envelope: { ...guardEnvelope, sourceAdminKey: null },
      expectedDestinationHash: 'a'.repeat(64),
      includeSecrets: true,
      apply: true,
      yes: true
    }),
    /admin key/
  );

  const changed = await tempConfig(t);
  await assert.rejects(
    applyHeadPromotion({
      configPath: changed.configPath,
      envelope: envelope(),
      sourceUrl: 'http://media.example.test:8100',
      expectedDestinationHash: 'b'.repeat(64),
      includeSecrets: true,
      apply: true,
      yes: true
    }),
    /changed since reviewed plan/
  );

  const conflict = await tempConfig(
    t,
    destinationConfig({
      backends: {
        'local-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' },
        'lloom-node-media': { type: 'openai', baseUrl: 'http://other.example.test/v1' }
      }
    })
  );
  const conflictDry = await applyHeadPromotion({
    configPath: conflict.configPath,
    envelope: envelope(),
    sourceUrl: 'http://media.example.test:8100'
  });
  assert.equal(conflictDry.ok, false);
  assert.ok(conflictDry.errors.some((error) => error.type === 'backend'));
  await assert.rejects(
    applyHeadPromotion({
      configPath: conflict.configPath,
      envelope: envelope(),
      sourceUrl: 'http://media.example.test:8100',
      expectedDestinationHash: conflictDry.destinationHash,
      includeSecrets: true,
      apply: true,
      yes: true
    }),
    /conflicting/
  );

  // This imported alias is syntactically accepted by the pure planner but is
  // rejected by the destination's full validator. Neither paired file moves.
  const rollback = await tempConfig(t);
  const configBefore = await fs.readFile(rollback.configPath, 'utf8');
  const profilesBefore = await fs.readFile(rollback.profilesPath, 'utf8').catch(() => null);
  const invalidEnvelope = envelope({
    sourceConfig: sourceConfig({
      aliases: {
        chat: { members: ['tp-model'] },
        broken: { members: ['tp-model'], strategy: 'invalid-strategy' }
      }
    })
  });
  await assert.rejects(
    applyHeadPromotion({
      configPath: rollback.configPath,
      envelope: invalidEnvelope,
      sourceUrl: 'http://media.example.test:8100',
      expectedDestinationHash: (
        await applyHeadPromotion({ configPath: rollback.configPath, envelope: invalidEnvelope, includeSecrets: true })
      ).destinationHash,
      includeSecrets: true,
      apply: true,
      yes: true
    }),
    /failed validation/
  );
  assert.equal(await fs.readFile(rollback.configPath, 'utf8'), configBefore);
  assert.equal(await fs.readFile(rollback.profilesPath, 'utf8').catch(() => null), profilesBefore);
  const leftovers = (await fs.readdir(path.dirname(rollback.configPath))).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('stdin target transport accepts an envelope without exposing dry-run secrets', async (t) => {
  const { configPath } = await tempConfig(t);
  const result = await runHeadPromotionTransfer({
    configPath,
    sourcePath: '-',
    sourceUrl: 'http://media.example.test:8100',
    stdin: Readable.from([JSON.stringify(envelope())])
  });
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(ADMIN_SECRET));
});

test('apply repairs a legacy inference-only source node credential once', async (t) => {
  const promoted = destinationConfig({
    security: { apiKeys: [DEST_KEY, SECRET] },
    backends: {
      'local-backend': { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' },
      'lloom-node-media': {
        type: 'openai',
        baseUrl: 'http://media.example.test:8100/v1',
        apiKey: SECRET,
        timeoutMs: 1800000
      }
    },
    cluster: {
      nodeId: 'head',
      leaderNode: 'head',
      fleetHeadNode: 'head',
      nodes: {
        head: { labels: { role: 'leader' } },
        media: {
          endpoint: 'http://media.example.test:8100',
          apiKey: SECRET,
          labels: { role: 'node' },
          proxy: {
            enabled: true,
            backend: 'lloom-node-media',
            baseUrl: 'http://media.example.test:8100/v1',
            models: []
          }
        }
      }
    }
  });
  const { configPath } = await tempConfig(t, promoted);
  const hash = (await applyHeadPromotion({ configPath, envelope: envelope(), includeSecrets: true })).destinationHash;
  const repair = await applyHeadPromotion({
    configPath,
    envelope: envelope(),
    sourceUrl: 'http://media.example.test:8100',
    expectedDestinationHash: hash,
    includeSecrets: true,
    apply: true,
    yes: true
  });
  assert.equal(repair.applied, true);
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(raw.cluster.nodes.media.apiKey, ADMIN_SECRET);
  assert.equal(raw.backends['lloom-node-media'].apiKey, SECRET);
  assert.equal(raw.security.apiKeys.includes(ADMIN_SECRET), false);
  const repeat = await applyHeadPromotion({
    configPath,
    envelope: envelope(),
    sourceUrl: 'http://media.example.test:8100',
    expectedDestinationHash: (await applyHeadPromotion({ configPath, envelope: envelope(), includeSecrets: true }))
      .destinationHash,
    includeSecrets: true,
    apply: true,
    yes: true
  });
  assert.equal(repeat.applied, false);
});

test('source SSH reader redacts before transport and supports legacy effective admin credentials', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'head-reader-credentials-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.lloom'));
  const file = path.join(dir, '.lloom/config.json');
  const source = sourceConfig({
    security: { apiKeys: [SECRET], adminApiKeys: [ADMIN_SECRET] },
    runtimes: { owned: { args: ['runtime-private-value'] } }
  });
  await fs.writeFile(file, JSON.stringify(source));
  const hidden = await runScript({ sourceUrl: 'http://source.test:8100' }, { HOME: dir }, false);
  const wire = JSON.stringify(hidden);
  for (const value of [SECRET, ADMIN_SECRET, 'runtime-private-value']) assert.equal(wire.includes(value), false);
  assert.equal(hidden.sourceAdminKeyResolved, true);
  assert.equal(hidden.sourceInferenceKeyResolved, true);
  assert.deepEqual(hidden.sourceConfig.runtimes, { owned: {} });
  source.security.adminApiKeys = [];
  await fs.writeFile(file, JSON.stringify(source));
  const legacy = await runScript({ sourceUrl: 'http://source.test:8100' }, { HOME: dir }, true);
  assert.equal(legacy.sourceAdminKey, SECRET);
  source.security.adminApiKeys = ['${MISSING_PROMOTION_ADMIN_TEST}'];
  await fs.writeFile(file, JSON.stringify(source));
  const unresolved = await runScript({ sourceUrl: 'http://source.test:8100' }, { HOME: dir }, true);
  assert.equal(unresolved.sourceAdminKey, null);
});

test('curated source snapshot retains metadata needed for inferred runtime federation', async (t) => {
  const { planHeadPromotion } = await import('../src/head-promotion.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'head-inferred-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.lloom'));
  const source = sourceConfig({
    models: [{ id: 'inferred', backend: 'special' }],
    runtimes: { r: { backend: 'special', args: ['private-command'] } },
    backends: { special: { type: 'openai', baseUrl: 'http://127.0.0.1:8202/v1' } },
    nodeModelIndex: { media: { model: 'inferred' } }
  });
  await fs.writeFile(path.join(dir, '.lloom/config.json'), JSON.stringify(source));
  const envelope = await runScript({ sourceUrl: 'http://source.test:8100' }, { HOME: dir }, false);
  assert.deepEqual(envelope.sourceConfig.runtimes, { r: { backend: 'special' } });
  assert.deepEqual(envelope.sourceConfig.nodeModelIndex, source.nodeModelIndex);
  const plan = planHeadPromotion(destinationConfig(), envelope.sourceConfig, {
    sourceNode: 'media',
    sourceUrl: 'http://source.test:8100'
  });
  assert.ok(plan.summary.federated.modelIds.includes('inferred'));
});
