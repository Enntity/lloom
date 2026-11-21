import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { applySetup, createSetupPlan } from '../src/setup.mjs';

// The gateway hot-reloads its config and tears down a changed runtime, so a
// setup that writes the config before downloading takes a serving runtime down
// for the whole download. Setup must write the live config last.
const LIVE = '{"live":"config as the gateway serves it"}\n';

async function fixture(t, recipeSteps) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-setup-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, LIVE);
  const backendCatalogPath = path.join(root, 'backends.json');
  await fs.writeFile(
    backendCatalogPath,
    JSON.stringify({
      schemaVersion: 1,
      id: 'order-test-catalog',
      name: 'Order Test Catalog',
      backends: [
        {
          id: 'order-test',
          name: 'Order Test Backend',
          kind: 'openai-compatible-server',
          platforms: [`${process.platform}-${process.arch}`],
          setup: [{ id: 'backend-ok', action: 'command', command: '/usr/bin/true' }]
        }
      ]
    })
  );
  const recipe = {
    schemaVersion: 1,
    id: 'order-test-recipe',
    name: 'Order Test Recipe',
    backend: { id: 'order-test' },
    models: [
      {
        role: 'default',
        model: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
        gatewayModel: 'Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed',
        runtime: 'mtplx-qwen36-27b-speed'
      }
    ],
    setup: { steps: recipeSteps(root, configPath) }
  };
  const options = {
    recipeId: recipe.id,
    recipeDocuments: [recipe],
    recipesRoot: path.join(root, 'no-recipes'),
    backendCatalogPath,
    configPath,
    modelRoot: '/models',
    clientId: 'omp',
    dryRun: false,
    yes: true,
    statePath: path.join(root, 'state.json'),
    home: root,
    generatedRoot: path.join(root, 'generated'),
    backendVariables: {
      shimDir: path.join(root, 'bin'),
      backendRoot: path.join(root, 'backends'),
      installRoot: path.join(root, 'install'),
      repoParent: root,
      modelRoot: '/models'
    }
  };
  return { root, configPath, options, config: await loadConfig() };
}

test('a failed setup step leaves the live config file untouched', async (t) => {
  const { root, configPath, options, config } = await fixture(t, () => [
    { id: 'download-fails', action: 'command', command: '/usr/bin/false', args: [] }
  ]);
  const result = await applySetup(config, options);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(await fs.readFile(configPath, 'utf8'), LIVE, 'the gateway must keep serving its config');
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
    [],
    'no half-written config is left behind'
  );
  // The reviewed init evidence still reports what would have been written.
  assert.equal(result.phases.init.configPath, configPath);
  assert.ok(result.phases.init.config.runtimes['mtplx-qwen36-27b-speed']);
});

test('setup runs every bootstrap step before it writes the config', async (t) => {
  const { configPath, options, config } = await fixture(t, (root, file) => [
    {
      id: 'observe-config',
      action: 'command',
      command: '/bin/cp',
      args: [file, path.join(root, 'seen-during-bootstrap.json')]
    }
  ]);
  const result = await applySetup(config, options);
  assert.equal(result.ok, true, JSON.stringify(result.phases.bootstrap.summary));
  const seen = await fs.readFile(path.join(path.dirname(configPath), 'seen-during-bootstrap.json'), 'utf8');
  assert.equal(seen, LIVE, 'the live config was replaced before the steps finished');
  const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.ok(written.runtimes['mtplx-qwen36-27b-speed'], 'the planned config is written once the steps succeed');
  assert.equal(result.phases.init.written.configPath, configPath);
  assert.equal(result.phases.bootstrap.ok, true);
});

test('a planned config that would not load is refused before any download', async (t) => {
  const { root, configPath, options, config } = await fixture(t, (dir, file) => [
    { id: 'download', action: 'command', command: '/bin/cp', args: [file, path.join(dir, 'downloaded')] }
  ]);
  const { dryRun: _dryRun, yes: _yes, statePath: _statePath, ...planOptions } = options;
  const plan = await createSetupPlan(config, planOptions);
  plan.phases.init.config.keepWarm = true; // a top-level pin does not load
  await assert.rejects(applySetup(config, { ...options, reviewedPlan: plan }), /Not writing .*top-level keepWarm/);
  await assert.rejects(fs.access(path.join(root, 'downloaded')), { code: 'ENOENT' }, 'no step ran');
  assert.equal(await fs.readFile(configPath, 'utf8'), LIVE);
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
    []
  );
});
