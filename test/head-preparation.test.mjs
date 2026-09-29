import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyHeadPreparation,
  isEligibleExternalBaseUrl,
  mergeExternalModels,
  summarizeHeadPreparationPlan
} from '../src/head-preparation.mjs';
import { loadConfig } from '../src/config.mjs';

const directories = [];
after(async () => {
  await Promise.all(directories.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headprep-'));
  directories.push(dir);
  return dir;
}

// Destination mirroring a minimal valid standalone gateway config.
function destinationConfig(overrides = {}) {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    security: { apiKeys: ['dest-key'] },
    defaults: { chatModel: 'local-chat' },
    models: [{ id: 'local-chat', backend: 'local-rt', upstreamModel: 'local-chat', kind: 'chat' }],
    backends: { 'local-rt': { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1', apiKey: 'sk-local' } },
    runtimes: { 'local-rt': { command: 'serve', port: 8201 } },
    aliases: { 'local-default': { target: 'local-chat' } },
    cluster: { nodeId: 'node1', leaderNode: 'node1', nodes: { node1: { endpoint: 'https://node1.example.com' } } },
    ...overrides
  };
}

// Source with one eligible external model/backend/alias plus ineligible noise.
function sourceConfig() {
  return {
    backends: {
      openrouter: {
        type: 'openai',
        baseUrl: 'https://openrouter.example.com/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY'
      },
      'local-rt': { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1', apiKey: 'sk-local' },
      'private-http': { type: 'openai', baseUrl: 'http://cloud.example.com/v1', apiKeyEnv: 'PRIVATE_KEY' },
      'single-label': { type: 'openai', baseUrl: 'https://internal-gw/v1', apiKeyEnv: 'X' }
    },
    models: [
      {
        id: 'moonshot/kimi-k2',
        name: 'Kimi K2',
        backend: 'openrouter',
        upstreamModel: 'moonshot/kimi-k2',
        kind: 'chat',
        input: ['text', 'image'],
        output: ['text'],
        capabilities: ['chat', 'tools', 'reasoning'],
        reasoning: true,
        supportsTools: true,
        contextWindow: 262144,
        maxOutputTokens: 32768,
        providerRestriction: 'openrouter-only',
        advertise: true
      },
      { id: 'rt-model', name: 'Local', backend: 'local-rt', runtime: 'local-rt', kind: 'chat' },
      {
        id: 'node-model',
        name: 'Node',
        targets: [{ id: 't1', node: 'node1', backend: 'openrouter' }],
        kind: 'chat'
      },
      { id: 'private-model', name: 'Private', backend: 'private-http', kind: 'chat' },
      { id: 'single-label-model', name: 'Internal', backend: 'single-label', kind: 'chat' }
    ],
    aliases: {
      kimi: { target: 'moonshot/kimi-k2', advertise: true },
      local: { target: 'rt-model' },
      dangling: { target: 'rt-model', fallbacks: ['not-present'] }
    }
  };
}

test('eligible external base URL predicate excludes private/internal hosts', () => {
  assert.equal(isEligibleExternalBaseUrl('https://api.example.com/v1'), true);
  assert.equal(isEligibleExternalBaseUrl('http://api.example.com/v1'), false);
  assert.equal(isEligibleExternalBaseUrl('https://localhost/v1'), false);
  assert.equal(isEligibleExternalBaseUrl('https://127.0.0.1/v1'), false);
  assert.equal(isEligibleExternalBaseUrl('https://10.0.0.4/v1'), false);
  assert.equal(isEligibleExternalBaseUrl('https://gateway/v1'), false);
  assert.equal(isEligibleExternalBaseUrl('https://[::1]/v1'), false);
});

test('imports only eligible external models and preserves destination state', () => {
  const dest = destinationConfig();
  const destSnapshot = structuredClone(dest);
  const plan = mergeExternalModels(dest, sourceConfig(), { env: { OPENROUTER_API_KEY: 'set' } });

  assert.deepEqual(dest, destSnapshot, 'destination input must not be mutated');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.added.models, ['moonshot/kimi-k2']);
  assert.deepEqual(plan.added.backends, ['openrouter']);
  assert.deepEqual(plan.added.aliases, ['kimi']);

  const importedModel = plan.next.models.find((model) => model.id === 'moonshot/kimi-k2');
  assert.equal(importedModel.providerRestriction, 'openrouter-only');
  assert.deepEqual(importedModel.input, ['text', 'image']);
  assert.deepEqual(importedModel.capabilities, ['chat', 'tools', 'reasoning']);
  assert.equal(importedModel.contextWindow, 262144);
  assert.equal(importedModel.supportsTools, true);

  // Destination-only state survives untouched.
  assert.deepEqual(plan.next.server, dest.server);
  assert.deepEqual(plan.next.security, dest.security);
  assert.deepEqual(plan.next.defaults, dest.defaults);
  assert.deepEqual(plan.next.cluster, dest.cluster);
  assert.deepEqual(plan.next.runtimes, dest.runtimes);
  assert.equal(plan.next.models.find((model) => model.id === 'local-chat').backend, 'local-rt');
  assert.equal(plan.next.backends['local-rt'].baseUrl, 'http://127.0.0.1:8201/v1');
  assert.deepEqual(plan.next.aliases['local-default'], { target: 'local-chat' });

  // Local / node / ineligible models are excluded.
  assert.deepEqual(
    plan.skipped
      .filter((s) => s.type === 'model')
      .map((s) => s.id)
      .sort(),
    ['node-model', 'private-model', 'rt-model', 'single-label-model']
  );
});

test('secret-free preview: no literal or env key values leak', () => {
  const source = sourceConfig();
  source.backends.openrouter.apiKey = 'super-secret-value';
  delete source.backends.openrouter.apiKeyEnv;
  const plan = mergeExternalModels(destinationConfig(), source, { env: {} });
  const preview = JSON.stringify(summarizeHeadPreparationPlan(plan));
  assert.equal(preview.includes('super-secret-value'), false);
  assert.equal(preview.includes('OPENROUTER_API_KEY'), false, 'env credential names only in required list');
  assert.equal(plan.unresolvedCredentials.length, 1);
  assert.equal(plan.unresolvedCredentials[0].backend, 'openrouter');
});

test('ids conflict fails closed unless canonically equal', () => {
  const source = sourceConfig();
  const dest = destinationConfig();
  dest.models.push({ id: 'moonshot/kimi-k2', backend: 'other', kind: 'chat' });
  const conflictPlan = mergeExternalModels(dest, source, { env: { OPENROUTER_API_KEY: 'x' } });
  assert.equal(conflictPlan.ok, false);
  assert.ok(conflictPlan.conflicts.some((c) => c.type === 'model' && c.id === 'moonshot/kimi-k2'));

  // Canonically equal model => no-op.
  const equalDest = destinationConfig();
  equalDest.models.push(structuredClone(source.models[0]));
  equalDest.backends.openrouter = structuredClone(source.backends.openrouter);
  const equalPlan = mergeExternalModels(equalDest, source, { env: { OPENROUTER_API_KEY: 'x' } });
  assert.equal(equalPlan.ok, true);
  assert.deepEqual(equalPlan.added.models, []);
  assert.ok(equalPlan.skipped.some((s) => s.type === 'model' && s.id === 'moonshot/kimi-k2'));

  // Different backend definition under same id => conflict.
  const backendConflict = destinationConfig();
  backendConflict.backends.openrouter = { type: 'openai', baseUrl: 'https://other.example.com/v1' };
  const backendPlan = mergeExternalModels(backendConflict, source, { env: { OPENROUTER_API_KEY: 'x' } });
  assert.equal(backendPlan.ok, false);
  assert.ok(backendPlan.conflicts.some((c) => c.type === 'backend'));
});

test('alias import requires resolving dependency graph and respects conflicts/cycles', () => {
  const base = sourceConfig();
  // Chain alias resolves through the imported external model.
  const source = structuredClone(base);
  source.aliases = {
    kimi: { target: 'moonshot/kimi-k2' },
    'kimi-primary': { target: 'kimi', fallbacks: ['moonshot/kimi-k2'] },
    cycleA: { target: 'cycleB' },
    cycleB: { target: 'cycleA' }
  };
  const plan = mergeExternalModels(destinationConfig(), source, { env: { OPENROUTER_API_KEY: 'x' } });
  assert.deepEqual(plan.added.aliases.sort(), ['kimi', 'kimi-primary']);
  assert.ok(plan.skipped.some((s) => s.type === 'alias' && s.id === 'cycleA'));
  assert.ok(plan.skipped.some((s) => s.type === 'alias' && s.id === 'cycleB'));

  // Conflicting existing alias is preserved in destination.
  const dest = destinationConfig();
  dest.aliases.kimi = { target: 'local-chat' };
  const conflict = mergeExternalModels(dest, source, { env: { OPENROUTER_API_KEY: 'x' } });
  assert.equal(conflict.next.aliases.kimi.target, 'local-chat');
  assert.ok(conflict.skipped.some((s) => s.type === 'alias' && s.id === 'kimi'));
});

test('apply guards: --yes, conflicts, missing credentials, stale destination', async () => {
  const dir = await tmpDir();
  const sourcePath = path.join(dir, 'source.json');
  const destPath = path.join(dir, 'dest.json');
  await fs.writeFile(sourcePath, JSON.stringify(sourceConfig()), { mode: 0o600 });
  await fs.writeFile(destPath, `${JSON.stringify(destinationConfig(), null, 2)}\n`, { mode: 0o600 });

  const preview = await applyHeadPreparation({ configPath: destPath, sourcePath, env: {} });
  assert.equal(preview.ok, false);
  assert.equal(preview.unresolvedCredentials.length, 1);
  await assert.rejects(
    applyHeadPreparation({ configPath: destPath, sourcePath, apply: true, yes: true, env: {} }),
    /unresolved credentials/
  );

  // Destination now conflicts, so apply must refuse even with --yes.
  const conflictDest = destinationConfig();
  conflictDest.models.push({ id: 'moonshot/kimi-k2', backend: 'other', kind: 'chat' });
  await fs.writeFile(destPath, `${JSON.stringify(conflictDest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    applyHeadPreparation({
      configPath: destPath,
      sourcePath,
      apply: true,
      yes: true,
      env: { OPENROUTER_API_KEY: 'x' }
    }),
    /conflicting id/
  );

  // Clean destination, credentials resolved, missing --yes refused.
  await fs.writeFile(destPath, `${JSON.stringify(destinationConfig(), null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    applyHeadPreparation({
      configPath: destPath,
      sourcePath,
      apply: true,
      yes: false,
      env: { OPENROUTER_API_KEY: 'x' }
    }),
    /--yes/
  );
});

test('apply writes atomically to destination, backs up, and is idempotent', async () => {
  const dir = await tmpDir();
  const sourcePath = path.join(dir, 'source.json');
  const destPath = path.join(dir, 'dest.json');
  await fs.writeFile(sourcePath, JSON.stringify(sourceConfig()), { mode: 0o600 });
  await fs.writeFile(destPath, `${JSON.stringify(destinationConfig(), null, 2)}\n`, { mode: 0o600 });

  const env = { OPENROUTER_API_KEY: 'x' };
  const applied = await applyHeadPreparation({ configPath: destPath, sourcePath, apply: true, yes: true, env });
  assert.equal(applied.applied, true);
  assert.ok(applied.backupPath);
  const backup = JSON.parse(await fs.readFile(applied.backupPath, 'utf8'));
  assert.deepEqual(
    backup.models.map((m) => m.id),
    ['local-chat']
  );

  const written = await loadConfig(destPath, { env });
  const backendEntry = JSON.parse(await fs.readFile(destPath, 'utf8')).backends.openrouter;
  assert.equal(backendEntry.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(backendEntry.apiKey, undefined);
  assert.ok(written.models.some((m) => m.id === 'moonshot/kimi-k2'));
  assert.ok(written.aliases.kimi);

  const second = await applyHeadPreparation({ configPath: destPath, sourcePath, apply: false, env });
  assert.equal(second.changed, false);
  assert.equal(second.added.models.length, 0);
});

test('literal apiKey only imported with --include-secrets and never printed', async () => {
  const source = sourceConfig();
  delete source.backends.openrouter.apiKeyEnv;
  source.backends.openrouter.apiKey = 'literal-secret';
  const dest = destinationConfig();

  const blocked = mergeExternalModels(dest, source, { env: {} });
  assert.equal(blocked.unresolvedCredentials.length, 1);

  const included = mergeExternalModels(dest, source, { includeSecrets: true, env: {} });
  assert.equal(included.unresolvedCredentials.length, 0);
  assert.equal(included.next.backends.openrouter.apiKey, 'literal-secret');
  assert.equal(summarizeHeadPreparationPlan(included).requiredCredentials.length, 0);
  assert.equal(JSON.stringify(summarizeHeadPreparationPlan(included)).includes('literal-secret'), false);
});

test('identical models still detect changed backend credentials or endpoints', () => {
  const src = sourceConfig();
  const dest = destinationConfig();
  dest.models.push(src.models[0]);
  dest.backends.openrouter = { ...src.backends.openrouter, baseUrl: 'https://changed.example.com/v1' };
  assert.equal(mergeExternalModels(dest, src).ok, false);
});
test('inactive route profiles and optional members must also resolve', () => {
  const src = sourceConfig();
  src.aliases.kimi.routeProfiles = { local: { members: ['missing-local'] } };
  src.aliases.optional = { members: ['moonshot/kimi-k2'], optionalMembers: ['missing'] };
  const plan = mergeExternalModels(destinationConfig(), src, { env: { OPENROUTER_API_KEY: 'x' } });
  assert.deepEqual(plan.added.aliases, []);
});
test('reviewed destination hash rejects stale apply without writing', async () => {
  const dir = await tmpDir();
  const destPath = path.join(dir, 'config.json');
  const data = JSON.stringify(destinationConfig());
  await fs.writeFile(destPath, data, { mode: 0o600 });
  await assert.rejects(
    applyHeadPreparation({
      configPath: destPath,
      sourceData: JSON.stringify(sourceConfig()),
      expectedDestinationHash: '0'.repeat(64),
      apply: true,
      yes: true
    }),
    /changed since reviewed/
  );
  assert.equal(await fs.readFile(destPath, 'utf8'), data);
});
test('invalid candidate leaves original config intact and errors redact source values', async () => {
  const dir = await tmpDir();
  const destPath = path.join(dir, 'config.json');
  const data = JSON.stringify(destinationConfig());
  await fs.writeFile(destPath, data, { mode: 0o600 });
  const src = sourceConfig();
  src.models[0].kind = 'secret-invalid-kind';
  src.models[0].keepWarm = true;
  await assert.rejects(
    applyHeadPreparation({
      configPath: destPath,
      sourceData: JSON.stringify(src),
      apply: true,
      yes: true,
      env: { OPENROUTER_API_KEY: 'x' }
    }),
    /prepared configuration failed validation/
  );
  assert.equal(await fs.readFile(destPath, 'utf8'), data);
});

test('existing external backends require credentials for new and existing models', () => {
  const src = sourceConfig();
  const dest = destinationConfig();
  dest.backends.openrouter = src.backends.openrouter;
  let plan = mergeExternalModels(dest, src, { env: {} });
  assert.equal(plan.ok, false);
  assert.equal(plan.unresolvedCredentials.length, 1);
  dest.models.push(src.models[0]);
  plan = mergeExternalModels(dest, src, { env: {} });
  assert.equal(plan.ok, false);
});
test('credential environment names cannot contain whitespace', () => {
  const src = sourceConfig();
  src.backends.openrouter.apiKeyEnv = ' OPENROUTER_API_KEY ';
  const plan = mergeExternalModels(destinationConfig(), src, { env: { OPENROUTER_API_KEY: 'set' } });
  assert.equal(plan.ok, false);
});

test('credential bindings reject coerced names and inherited environment values', () => {
  for (const name of [['MISSING'], 'toString', 'constructor']) {
    const src = sourceConfig();
    src.backends.openrouter.apiKeyEnv = name;
    assert.equal(mergeExternalModels(destinationConfig(), src, { env: {} }).ok, false);
  }
});
