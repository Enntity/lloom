import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createInitPlan, deriveUserConfig } from '../src/init.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(repoRoot, 'bin', 'lloom.mjs');

function runCli(args, { home } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(home ? { HOME: home } : {})
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function emptyConfig() {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    providers: { 'local-llm': { baseUrl: 'http://127.0.0.1:8100/v1' } },
    defaults: {},
    backends: {},
    runtimes: {},
    models: [],
    aliases: {},
    clientCatalog: { modelOrder: [] }
  };
}

test('CLI recipe operations honor an explicit recipes root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-recipes-root-cli-'));
  const recipesRoot = path.join(root, 'recipes');
  const home = path.join(root, 'home');
  const modelRoot = path.join(root, 'models');
  const configPath = path.join(root, 'config.json');
  const statePath = path.join(root, 'install-state.json');
  const recipeId = 'synthetic-cli-recipes-root';
  const recipe = {
    schemaVersion: 1,
    id: recipeId,
    name: 'Synthetic CLI recipes root',
    version: 1,
    requirements: { platforms: [`${process.platform}-${process.arch}`] },
    backend: { id: 'synthetic-backend' },
    setup: { steps: [] },
    models: [
      {
        role: 'default',
        model: 'synthetic/model',
        gatewayModel: 'synthetic/model',
        runtime: 'synthetic-runtime',
        capabilities: ['chat'],
        settings: {
          runtime: {
            command: '${installRoot}/server',
            args: ['--port', '${port}']
          }
        }
      }
    ]
  };
  const catalogPath = path.join(root, 'backend-catalog.json');
  const catalog = {
    schemaVersion: 1,
    backends: [
      {
        id: 'synthetic-backend',
        name: 'Synthetic backend',
        kind: 'openai-compatible-server',
        platforms: [`${process.platform}-${process.arch}`],
        commands: [],
        server: { protocol: 'openai', healthPath: '/health' }
      }
    ]
  };

  try {
    await fs.mkdir(recipesRoot, { recursive: true });
    await fs.writeFile(path.join(recipesRoot, `${recipeId}.json`), `${JSON.stringify(recipe)}\n`);
    await fs.writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);

    const init = await runCli(
      [
        'init',
        '--recipe',
        recipeId,
        '--recipes-root',
        recipesRoot,
        '--backend-catalog',
        catalogPath,
        '--backend-port-range',
        '8230-8299',
        '--home',
        home,
        '--config-out',
        configPath,
        '--model-root',
        modelRoot
      ],
      { home }
    );
    assert.equal(init.code, 0, init.stderr);
    const initPlan = JSON.parse(init.stdout);
    assert.equal(initPlan.selectedRecipe.id, recipeId);
    assert.deepEqual(initPlan.ports.backends.range, { start: 8230, end: 8299 });
    assert(initPlan.next.apply.includes(`--recipes-root '${recipesRoot}'`));
    assert(initPlan.next.apply.includes(`--backend-catalog '${catalogPath}'`));
    assert(initPlan.next.bootstrap.includes(`--recipes-root '${recipesRoot}'`));
    assert(initPlan.next.bootstrap.includes(`--backend-catalog '${catalogPath}'`));

    const additiveConfig = emptyConfig();
    additiveConfig.defaults = { chatModel: 'existing-chat' };
    additiveConfig.models = [{ id: 'existing-chat', kind: 'chat', advertise: true }];
    additiveConfig.clientCatalog = { modelOrder: ['existing-chat'] };
    const additivePlan = await createInitPlan(additiveConfig, {
      recipeId,
      recipesRoot,
      backendCatalogPath: catalogPath,
      configPath,
      modelRoot,
      backendPortRange: '8230-8299',
      home,
      additive: true
    });
    assert(additivePlan.next.review.includes('--additive'));
    assert(additivePlan.next.apply.includes('--additive'));
    assert(additivePlan.next.integrate.includes('--additive'));
    assert.equal(additivePlan.config.defaults.chatModel, 'existing-chat');
    assert.deepEqual(additivePlan.config.clientCatalog.modelOrder.slice(0, 1), ['existing-chat']);
    assert(additivePlan.config.clientCatalog.modelOrder.includes('synthetic/model'));
    assert(additivePlan.config.models.some((model) => model.id === 'existing-chat'));

    const plan = await runCli(['plan', recipeId, '--recipes-root', recipesRoot, '--backend-catalog', catalogPath], {
      home
    });
    assert.equal(plan.code, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).id, recipeId);

    const install = await runCli(
      ['install', recipeId, '--recipes-root', recipesRoot, '--model-root', modelRoot, '--state', statePath],
      { home }
    );
    assert.equal(install.code, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).plan.id, recipeId);

    await fs.writeFile(configPath, `${JSON.stringify(emptyConfig())}\n`);
    const bootstrap = await runCli(
      [
        'bootstrap',
        '--config',
        configPath,
        '--recipe',
        recipeId,
        '--recipes-root',
        recipesRoot,
        '--backend-catalog',
        catalogPath,
        '--model-root',
        modelRoot,
        '--state',
        statePath
      ],
      { home }
    );
    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    assert.equal(JSON.parse(bootstrap.stdout).selectedRecipe.id, recipeId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ordinary recipe runtimes receive backend template variables', () => {
  const config = deriveUserConfig(
    emptyConfig(),
    {
      schemaVersion: 1,
      id: 'synthetic-explicit-runtime',
      name: 'Synthetic explicit runtime',
      backend: { id: 'synthetic-backend' },
      models: [
        {
          role: 'default',
          model: 'synthetic/model',
          gatewayModel: 'synthetic/model',
          runtime: 'synthetic-runtime',
          capabilities: ['chat'],
          settings: {
            runtime: {
              command: '${installRoot}/server',
              args: ['--shim', '${shimDir}']
            }
          }
        }
      ]
    },
    {
      modelRoot: '/models',
      backendVariables: {
        installRoot: '/isolated/install',
        shimDir: '/isolated/bin'
      }
    }
  );
  assert.equal(config.runtimes['synthetic-runtime'].command, '/isolated/install/server');
  assert.deepEqual(config.runtimes['synthetic-runtime'].args, ['--shim', '/isolated/bin']);
});

test('explicit backend port range is used before retargeting an additive runtime', () => {
  const config = emptyConfig();
  config.ports = { backends: { start: 8234, end: 8234 } };
  config.defaults = { chatModel: 'existing-chat' };
  config.models = [{ id: 'existing-chat', kind: 'chat', runtime: 'existing-runtime', advertise: true }];
  config.backends = {
    existing: { type: 'openai', baseUrl: 'http://127.0.0.1:8234/v1', apiKey: 'sk-local-llm' }
  };
  config.runtimes = {
    'existing-runtime': { enabled: true, port: 8234, keepWarm: true, memoryGb: 12 }
  };
  config.clientCatalog = { modelOrder: ['existing-chat'] };

  const derived = deriveUserConfig(
    config,
    {
      schemaVersion: 1,
      id: 'synthetic-port-override',
      name: 'Synthetic port override',
      backend: { id: 'synthetic-backend' },
      models: [
        {
          role: 'default',
          model: 'synthetic/model',
          gatewayModel: 'synthetic/model',
          runtime: 'synthetic-runtime',
          capabilities: ['chat'],
          settings: {
            runtime: { command: '${installRoot}/server', args: ['--port', '${port}'] }
          }
        }
      ]
    },
    {
      modelRoot: '/models',
      backendPortRange: '8235-8235',
      additive: true,
      backendVariables: { installRoot: '/isolated/install' }
    }
  );

  assert.equal(derived.runtimes['synthetic-runtime'].port, 8235);
  assert.deepEqual(derived.ports.backends.range, { start: 8235, end: 8235 });
  assert.equal(derived.runtimes['existing-runtime'].port, 8234);
  assert.equal(derived.runtimes['existing-runtime'].keepWarm, true);
  assert.equal(derived.runtimes['existing-runtime'].memoryGb, 12);
  assert.equal(derived.defaults.chatModel, 'existing-chat');
  assert.equal(derived.backends['synthetic-backend-synthetic-model'].baseUrl, 'http://127.0.0.1:8235/v1');
});
