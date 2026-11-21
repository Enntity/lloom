import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { applyInit, deriveUserConfig } from '../src/init.mjs';
import { applyRecipeOptions, loadRecipeById } from '../src/recipes.mjs';

// Changing an installed recipe between its option sets (Enntity/lloom#139):
// the SparkGLM recipe serves from two Sparks or four, with different members.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backendVariables = { repoRoot, backendRoot: '/backend', installRoot: '/install' };
const recipe = await loadRecipeById('linux-nvidia-dgx-spark-glm53-atlas');
const GROUP = 'glm53-flash-atlas-cluster';
const HEAD = 'glm53-flash-atlas-head';
const WORKER = 'glm53-flash-atlas-worker';

const MAINTENANCE = {
  state: 'suspended',
  requestedModel: 'glm-5.3-flash-atlas',
  since: '2026-11-16T09:00:00.000Z',
  operationId: 'op-fixture-139'
};

function sparkNode(index, extra = {}) {
  return {
    endpoint: `http://10.0.0.${index}:8100`,
    backendHost: `10.0.0.${index}`,
    fabricInterface: 'enp1s0f1np1',
    fabricHca: 'rocep1s0f1',
    ...extra
  };
}

// spark03 as it was with the pair it leads (spark04 is its worker).
function pairHostConfig() {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    security: {},
    defaults: {},
    models: [],
    backends: {},
    runtimes: {},
    aliases: {},
    clientCatalog: { modelOrder: [] },
    cluster: {
      nodeId: 'spark03',
      leaderNode: 'spark03',
      nodes: {
        spark03: sparkNode(3),
        spark04: sparkNode(4, { labels: { role: 'worker' } })
      }
    }
  };
}

// The same host once the four are cabled as a chain that spark01 leads.
function withChain(config) {
  const next = structuredClone(config);
  const left = 'rocep1s0f0';
  const right = 'rocep1s0f1';
  const chain = (rank, sides) => ({ rank, interface: 'enp1s0f0np0', ...sides });
  next.cluster.nodes = {
    spark01: sparkNode(1, {
      labels: { role: 'node' },
      fabricChain: chain(0, { address: '198.51.100.1', rightHca: right })
    }),
    spark02: sparkNode(2, { labels: { role: 'node' }, fabricChain: chain(1, { leftHca: left, rightHca: right }) }),
    spark03: { ...next.cluster.nodes.spark03, fabricChain: chain(2, { leftHca: left, rightHca: right }) },
    spark04: { ...next.cluster.nodes.spark04, fabricChain: chain(3, { leftHca: left }) }
  };
  return next;
}

const install = (config, sparks) =>
  deriveUserConfig(config, applyRecipeOptions(recipe, { sparks }), {
    modelRoot: '/models',
    backendVariables,
    additive: true
  });

const recipeRuntimeIds = (config) =>
  Object.entries(config.runtimes)
    .filter(([, runtime]) => runtime.recipe?.id === recipe.id)
    .map(([runtimeId]) => runtimeId)
    .sort();

async function loads(t, config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-size-change-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return loadConfig(file, { env: {} });
}

test('two Sparks to four drops the pair worker, and the config loads', async (t) => {
  const pair = install(pairHostConfig(), '2');
  assert.deepEqual(recipeRuntimeIds(pair), [GROUP, HEAD, WORKER]);
  await loads(t, pair);

  const four = install(withChain(pair), '4');
  assert.deepEqual(recipeRuntimeIds(four), [
    GROUP,
    HEAD,
    `${WORKER}-spark02`,
    `${WORKER}-spark03`,
    `${WORKER}-spark04`
  ]);
  assert.equal(four.runtimes[GROUP].authority.owner, 'spark01');
  assert.deepEqual(four.init.enabledRuntimes.sort(), recipeRuntimeIds(four));
  await loads(t, four);
});

test('four Sparks back to two drops the per-node workers, and the config loads', async (t) => {
  const four = install(withChain(pairHostConfig()), '4');
  const pair = install(four, '2');
  assert.deepEqual(recipeRuntimeIds(pair), [GROUP, HEAD, WORKER]);
  assert.deepEqual(
    pair.runtimes[GROUP].placement.members.map((member) => member.node).sort(),
    ['spark03', 'spark04'],
    'the pair is the cluster leader and its labelled worker, not the chain that was installed'
  );
  assert.deepEqual(pair.init.enabledRuntimes.sort(), recipeRuntimeIds(pair));
  await loads(t, pair);
});

test('an option change removes only runtimes of this recipe that nothing routes to', () => {
  const pair = install(pairHostConfig(), '2');
  pair.runtimes['other-recipe-runtime'] = { enabled: true, memoryGb: 1, recipe: { id: 'another-recipe', version: 1 } };
  pair.runtimes['operator-runtime'] = { enabled: true, memoryGb: 1 };
  // An earlier version of this recipe served a second model that the operator still routes to.
  pair.runtimes['glm53-flash-atlas-legacy'] = { enabled: true, memoryGb: 1, recipe: { id: recipe.id, version: 1 } };
  pair.backends.legacy = { type: 'openai', baseUrl: 'http://127.0.0.1:8999/v1' };
  pair.models.push({ id: 'legacy-model', backend: 'legacy', runtime: 'glm53-flash-atlas-legacy' });

  const four = install(withChain(pair), '4');
  for (const runtimeId of ['other-recipe-runtime', 'operator-runtime', 'glm53-flash-atlas-legacy']) {
    assert.ok(four.runtimes[runtimeId], `${runtimeId} stays`);
  }
  assert.equal(four.runtimes[WORKER], undefined);
});

test('changing --model swaps the checkpoint in place: same runtimes, one gateway id', async (t) => {
  const withModel = (config, model) =>
    deriveUserConfig(config, applyRecipeOptions(recipe, { model }), {
      modelRoot: '/models',
      backendVariables,
      additive: true
    });
  const modelPath = (config) => config.runtimes[HEAD].bootstrap.createArgs.find((arg) => arg.startsWith('MODEL_PATH='));

  const glm = withModel(pairHostConfig(), 'glm53-flash');
  assert.equal(modelPath(glm), 'MODEL_PATH=/models/nvidia--GLM-5.3-Flash-FP4-Local');
  glm.runtimes[GROUP].maintenance = structuredClone(MAINTENANCE);

  const sage = withModel(glm, 'sage-s21-flash');
  assert.equal(modelPath(sage), 'MODEL_PATH=/models/Enntity--Sage-S2.1-Flash-NVFP4');
  assert.deepEqual(recipeRuntimeIds(sage), [GROUP, HEAD, WORKER]);
  assert.deepEqual(
    sage.models.map((model) => model.id),
    ['glm-5.3-flash-atlas'],
    'routes and aliases keep naming one model'
  );
  assert.equal(sage.runtimes[GROUP].recipe.options.model, 'sage-s21-flash');
  assert.deepEqual(sage.runtimes[GROUP].maintenance, MAINTENANCE, 'a suspension stands through the swap');
  await loads(t, sage);

  const back = withModel(sage, 'glm53-flash');
  assert.equal(modelPath(back), modelPath(glm));
  assert.deepEqual(back.runtimes[HEAD].bootstrap, glm.runtimes[HEAD].bootstrap);
});

test('a maintenance record is dropped when the runtime changes owner, and kept when it does not', () => {
  const pair = install(pairHostConfig(), '2');
  assert.equal(pair.runtimes[GROUP].authority.owner, 'spark03');
  pair.runtimes[GROUP].maintenance = structuredClone(MAINTENANCE);
  pair.runtimes[GROUP].preferredWarm = true;

  const again = install(pair, '2');
  assert.deepEqual(again.runtimes[GROUP].maintenance, MAINTENANCE, 'spark03 still leads: its suspension stands');

  // spark01 leads the chain; spark03 can neither enforce nor clear a record
  // it wrote as the pair's leader, and spark01's resume never sees it.
  const four = install(withChain(pair), '4');
  assert.equal(four.runtimes[GROUP].authority.owner, 'spark01');
  assert.equal(four.runtimes[GROUP].maintenance, undefined);
  assert.equal(pair.runtimes[GROUP].keepWarm, true);
  assert.equal(four.runtimes[GROUP].keepWarm, false, 'other recipe options let the recipe decide residency again');
  assert.equal(four.runtimes[GROUP].preferredWarm, true, 'a readiness choice is not tied to the owner');
});

test('init refuses to write a config that does not load', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-size-change-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, '.lloom', 'config.json');
  const valid = install(pairHostConfig(), '2');
  // A pair worker left behind by a four-Spark install, as #139 found it.
  const broken = structuredClone(valid);
  broken.runtimes['glm53-flash-atlas-stale'] = structuredClone(broken.runtimes[WORKER]);
  const apply = (config) =>
    applyInit(
      {},
      {
        dryRun: false,
        yes: true,
        home: root,
        reviewedPlan: { configPath, config, integrations: [] }
      }
    );

  await assert.rejects(
    apply(broken),
    (error) =>
      error.message.includes(configPath) &&
      /local runtime glm53-flash-atlas-stale authority owner must be its host node spark04/.test(error.message)
  );
  await assert.rejects(fs.access(configPath), { code: 'ENOENT' }, 'nothing was written');

  await apply(valid);
  const written = await fs.readFile(configPath, 'utf8');
  await assert.rejects(apply(broken), /must use authority\.scope local/);
  assert.equal(await fs.readFile(configPath, 'utf8'), written, 'the config that loads is left in place');
  assert.deepEqual(
    (await fs.readdir(path.dirname(configPath))).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary file is left behind'
  );
});
