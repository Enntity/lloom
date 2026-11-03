import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { deriveUserConfig } from '../src/init.mjs';
import { applyRecipeMode, loadRecipeById } from '../src/recipes.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(repoRoot, 'bin', 'lloom.mjs');
const backendVariables = { repoRoot, backendRoot: '/backend', installRoot: '/install' };

// Fake credentials are assembled at runtime so no literal looks like a live key.
const join = (...parts) => parts.join('');
const FAKE = {
  openrouter: join('sk-', 'or-', 'v1-', 'feedface'.repeat(8)),
  inference: join('lloom_', 'live_', '0123456789abcdef0123'),
  admin: join('admin-', 'fixture-', 'credential-42'),
  cluster: join('cluster-', 'fixture-', 'credential-42')
};

const MAINTENANCE = {
  state: 'suspended',
  requestedModel: 'qwen3.8-flash-next-atlas',
  since: '2026-11-03T17:00:00.000Z',
  operationId: 'op-fixture-1'
};

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-setup-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeAndLoad(root, config) {
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, config: await loadConfig(configPath, { env: {} }) };
}

function runCli(args, { home } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LLOOM_CONFIG: '' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// The 03/04 SparkQwen pair beside a TP-4 model that is local here and also
// advertised under the same id by the federated peer ennspark01.
async function sparkQwenPairConfig() {
  const recipe = await loadRecipeById('linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas');
  const base = {
    server: { host: '127.0.0.1', port: 8100 },
    security: {},
    defaults: {},
    models: [],
    backends: {},
    runtimes: {},
    aliases: {},
    clientCatalog: { modelOrder: [] },
    cluster: {
      nodeId: 'ennspark03',
      leaderNode: 'ennspark03',
      nodes: {
        ennspark03: {
          endpoint: 'http://10.0.3.1:8100',
          backendHost: '10.0.3.1',
          fabricInterface: 'enp1s0f1np1',
          fabricHca: 'rocep1s0f1'
        },
        ennspark04: {
          endpoint: 'http://10.0.3.2:8100',
          backendHost: '10.0.3.2',
          fabricInterface: 'enp1s0f1np1',
          fabricHca: 'rocep1s0f1',
          labels: { role: 'worker' }
        }
      }
    }
  };
  const config = deriveUserConfig(base, applyRecipeMode(recipe), { modelRoot: '/models', backendVariables });
  config.runtimes['qwen38-flash-next-atlas-cluster'].maintenance = structuredClone(MAINTENANCE);
  config.runtimes['qwen38-flash-next-atlas-cluster'].preferredWarm = true;
  config.cluster.nodes.ennspark01 = {
    endpoint: 'http://10.0.1.1:8100',
    labels: { role: 'peer' },
    proxy: { enabled: true, namespace: false, models: [{ id: 'glm-tp4', as: 'glm-tp4' }, { id: 'peer-only' }] }
  };
  config.backends['glm-tp4-local'] = { type: 'openai', baseUrl: 'http://127.0.0.1:8899/v1', apiKey: 'sk-local-llm' };
  config.runtimes['glm-tp4-cluster'] = {
    enabled: true,
    node: 'ennspark03',
    keepWarm: false,
    memoryGb: 100,
    healthUrl: 'http://127.0.0.1:8899/health',
    recipe: { id: 'unrelated-tp4-recipe', version: 1 }
  };
  config.models.push({
    id: 'glm-tp4',
    kind: 'chat',
    backend: 'glm-tp4-local',
    runtime: 'glm-tp4-cluster',
    targets: [{ id: 'ennspark01', node: 'ennspark01', backend: 'lloom-node-ennspark01', upstreamModel: 'glm-tp4' }]
  });
  return { recipe, config };
}

test('additive re-apply keeps a suspended runtime suspended and other operator state', async (t) => {
  const root = await tempRoot(t);
  const { recipe, config: fixture } = await sparkQwenPairConfig();
  const { config } = await writeAndLoad(root, fixture);
  const derived = deriveUserConfig(config, applyRecipeMode(recipe), {
    modelRoot: '/models',
    additive: true,
    backendVariables
  });
  const cluster = derived.runtimes['qwen38-flash-next-atlas-cluster'];
  assert.deepEqual(cluster.maintenance, MAINTENANCE);
  assert.equal(cluster.preferredWarm, true);
  assert.equal(cluster.recipe.id, recipe.id, 'the recipe still owns the rest of the runtime');
});

test('additive setup leaves models its recipe does not declare as written', async (t) => {
  const root = await tempRoot(t);
  const { recipe, config: fixture } = await sparkQwenPairConfig();
  const { config } = await writeAndLoad(root, fixture);
  const derived = deriveUserConfig(config, applyRecipeMode(recipe), {
    modelRoot: '/models',
    additive: true,
    backendVariables
  });
  const glm = derived.models.find((model) => model.id === 'glm-tp4');
  assert.deepEqual(
    glm,
    fixture.models.find((model) => model.id === 'glm-tp4')
  );
  assert.equal(
    derived.models.some((model) => model.id === 'peer-only'),
    false,
    'federated peer models are derived at load time, never persisted'
  );
});

test('a single-runtime recipe re-apply keeps the maintenance record', async (t) => {
  const root = await tempRoot(t);
  const recipe = {
    schemaVersion: 1,
    id: 'synthetic-maintained',
    version: 1,
    name: 'Synthetic maintained',
    backend: { id: 'mlx-lm' },
    models: [
      {
        role: 'default',
        model: 'synthetic/maintained',
        gatewayModel: 'synthetic/maintained',
        runtime: 'maintained-runtime',
        capabilities: ['chat']
      }
    ]
  };
  const first = deriveUserConfig(
    {
      server: { host: '127.0.0.1', port: 8100 },
      defaults: {},
      models: [],
      backends: {},
      runtimes: {},
      aliases: {},
      clientCatalog: { modelOrder: [] }
    },
    recipe,
    { modelRoot: '/models', backendVariables }
  );
  first.runtimes['maintained-runtime'].maintenance = { ...MAINTENANCE, requestedModel: 'synthetic/maintained' };
  const { config } = await writeAndLoad(root, first);
  const again = deriveUserConfig(config, recipe, { modelRoot: '/models', additive: true, backendVariables });
  assert.deepEqual(again.runtimes['maintained-runtime'].maintenance, {
    ...MAINTENANCE,
    requestedModel: 'synthetic/maintained'
  });
});

test('setup and init never print configured credentials, and still write them', async (t) => {
  const root = await tempRoot(t);
  const home = path.join(root, 'home');
  const recipesRoot = path.join(root, 'recipes');
  const catalogPath = path.join(root, 'backend-catalog.json');
  const recipeId = 'synthetic-setup-redaction';
  const platform = `${process.platform}-${process.arch}`;
  await fs.mkdir(recipesRoot, { recursive: true });
  await fs.writeFile(
    path.join(recipesRoot, `${recipeId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id: recipeId,
      name: 'Synthetic setup redaction',
      version: 1,
      requirements: { platforms: [platform] },
      backend: { id: 'synthetic-backend' },
      setup: { steps: [] },
      models: [
        {
          role: 'default',
          model: 'synthetic/model',
          gatewayModel: 'synthetic/model',
          runtime: 'synthetic-runtime',
          capabilities: ['chat'],
          settings: { runtime: { command: '${installRoot}/server', args: ['--port', '${port}'] } }
        }
      ]
    })
  );
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      schemaVersion: 1,
      backends: [
        {
          id: 'synthetic-backend',
          name: 'Synthetic backend',
          kind: 'openai-compatible-server',
          platforms: [platform],
          commands: [],
          server: { protocol: 'openai', healthPath: '/health' }
        }
      ]
    })
  );
  const { configPath } = await writeAndLoad(root, {
    server: { host: '127.0.0.1', port: 8100 },
    security: { apiKeys: [FAKE.inference], adminApiKeys: [FAKE.admin] },
    providers: { 'local-llm': { baseUrl: 'http://127.0.0.1:8100/v1' } },
    defaults: { chatModel: 'cloud/openrouter/chat' },
    backends: {
      openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: FAKE.openrouter }
    },
    runtimes: {},
    models: [{ id: 'cloud/openrouter/chat', backend: 'openrouter', upstreamModel: 'vendor/chat', kind: 'chat' }],
    aliases: {},
    clientCatalog: { modelOrder: ['cloud/openrouter/chat'] },
    cluster: { nodes: { peer: { apiKey: FAKE.cluster } } }
  });
  const common = [
    '--config',
    configPath,
    '--recipe',
    recipeId,
    '--recipes-root',
    recipesRoot,
    '--backend-catalog',
    catalogPath,
    '--home',
    home,
    '--config-out',
    configPath,
    '--model-root',
    path.join(root, 'models'),
    '--backend-port-range',
    '8230-8299',
    '--additive'
  ];
  const statePath = path.join(root, 'install-state.json');
  const runs = {
    'setup plan': await runCli(['setup', ...common, '--state', statePath], { home }),
    'init plan': await runCli(['init', ...common], { home }),
    'setup apply': await runCli(['setup', ...common, '--state', statePath, '--apply', '--yes'], { home })
  };
  for (const [name, run] of Object.entries(runs)) {
    assert.equal(run.code, 0, `${name}: ${run.stderr}`);
    const output = run.stdout + run.stderr;
    for (const [label, secret] of Object.entries(FAKE)) {
      assert.equal(output.includes(secret), false, `${name} printed the ${label} credential`);
    }
    assert.match(run.stdout, /\[secret\]/, `${name} shows that a credential is configured`);
    JSON.parse(run.stdout);
  }
  const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(written.backends.openrouter.apiKey, FAKE.openrouter, 'the config file keeps the real key');
  assert.deepEqual(written.security.apiKeys, [FAKE.inference]);
  assert.deepEqual(written.security.adminApiKeys, [FAKE.admin]);
  assert(written.models.some((model) => model.id === 'synthetic/model'));
});
