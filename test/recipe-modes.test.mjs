import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveUserConfig, installedRecipeMode } from '../src/init.mjs';
import { applyRecipeMode, validateRecipe } from '../src/recipes.mjs';
import { setupCommand } from '../src/setup.mjs';

const recipe = () => ({
  schemaVersion: 1,
  id: 'pair-lane',
  name: 'Pair lane',
  version: 2,
  backend: { id: 'docker-pair' },
  modes: [
    {
      id: 'dedicated',
      default: true,
      summary: 'The pair serves this model alone.',
      settings: { util: '0.88', memoryGb: 114 }
    },
    { id: 'sidecars', summary: 'Leaves room for sidecar services.', settings: { util: '0.74', memoryGb: 96 } }
  ],
  models: [
    {
      role: 'default',
      model: 'org/pair-model',
      gatewayModel: 'pair-model',
      runtime: 'pair-cluster',
      settings: {
        port: 8893,
        memoryGb: 1,
        placement: {
          mode: 'distributed',
          members: [
            {
              nodeRole: 'worker',
              runtime: 'pair-worker',
              role: 'worker',
              order: 10,
              runtimeSettings: {
                adapter: 'docker',
                containerName: 'pair-${nodeId}',
                bootstrap: { adapter: 'docker', image: 'pair@sha256:x', createArgs: ['-e', 'UTIL=${util}'] }
              }
            },
            {
              nodeRole: 'leader',
              runtime: 'pair-head',
              role: 'head',
              order: 20,
              runtimeSettings: {
                adapter: 'docker',
                containerName: 'pair-${nodeId}',
                bootstrap: { adapter: 'docker', image: 'pair@sha256:x', createArgs: ['-e', 'UTIL=${util}'] }
              }
            }
          ]
        }
      }
    }
  ]
});

const pairConfig = () => ({
  server: { host: '127.0.0.1', port: 8100 },
  security: {},
  defaults: {},
  models: [],
  backends: {},
  runtimes: {},
  aliases: {},
  clientCatalog: { modelOrder: [] },
  cluster: {
    leaderNode: 'a',
    nodes: { a: { backendHost: '10.0.0.1' }, b: { backendHost: '10.0.0.2', labels: { role: 'worker' } } }
  }
});

const materialize = (config, selected) => deriveUserConfig(config, selected, { modelRoot: '/models', additive: true });
const utilOf = (runtime) => runtime.bootstrap.createArgs[runtime.bootstrap.createArgs.indexOf('-e') + 1];

test('no mode selects the default and an explicit mode overrides every model', () => {
  const source = recipe();
  const snapshot = structuredClone(source);
  assert.equal(applyRecipeMode(source).mode, 'dedicated');
  const sidecars = applyRecipeMode(source, 'sidecars');
  assert.equal(sidecars.mode, 'sidecars');
  assert.equal(sidecars.models[0].settings.util, '0.74');
  assert.equal(sidecars.models[0].settings.memoryGb, 96);
  assert.equal(sidecars.models[0].settings.port, 8893);
  assert.deepEqual(source, snapshot, 'selecting a mode must not mutate the recipe');
});

test('an unknown mode, or a mode for a recipe without modes, is refused', () => {
  assert.throws(
    () => applyRecipeMode(recipe(), 'turbo'),
    /pair-lane has no mode turbo; its modes are dedicated, sidecars/
  );
  const plain = recipe();
  delete plain.modes;
  assert.equal(applyRecipeMode(plain), plain);
  assert.throws(() => applyRecipeMode(plain, 'sidecars'), /pair-lane declares no modes/);
});

test('validation requires unique ids, one default and primitive settings', () => {
  const check = (mutate) => {
    const candidate = recipe();
    mutate(candidate.modes);
    return validateRecipe(candidate, {}, { checkLocalReferences: false }).join('\n');
  };
  assert.equal(
    check(() => {}),
    ''
  );
  assert.match(
    check((modes) => (modes[1].id = 'dedicated')),
    /mode dedicated is declared twice/
  );
  assert.match(
    check((modes) => delete modes[0].default),
    /exactly one default mode/
  );
  assert.match(
    check((modes) => (modes[1].default = true)),
    /exactly one default mode/
  );
  assert.match(
    check((modes) => (modes[1].settings.placement = {})),
    /mode sidecars setting placement must be a string, number or boolean/
  );
  assert.match(
    check((modes) => delete modes[1].id),
    /mode without id/
  );
});

test('the selected mode is materialized and recorded on every runtime', () => {
  const config = materialize(pairConfig(), applyRecipeMode(recipe(), 'sidecars'));
  const cluster = config.runtimes['pair-cluster'];
  assert.equal(cluster.recipe.mode, 'sidecars');
  assert.equal(cluster.memoryGb, 96);
  // Members without their own reservation inherit the mode's, so admission matches it.
  assert.deepEqual(
    cluster.placement.members.map((member) => member.resources.memoryGb),
    [96, 96]
  );
  for (const id of ['pair-worker', 'pair-head']) {
    assert.equal(config.runtimes[id].recipe.mode, 'sidecars');
    assert.equal(config.runtimes[id].memoryGb, 96);
    assert.equal(utilOf(config.runtimes[id]), 'UTIL=0.74');
  }
  assert.equal(installedRecipeMode(config, 'pair-lane'), 'sidecars');
  assert.equal(installedRecipeMode(config, 'other-lane'), undefined);
});

test('rerunning setup without a mode keeps the installed one', () => {
  const installed = materialize(pairConfig(), applyRecipeMode(recipe(), 'sidecars'));
  const rerun = materialize(installed, applyRecipeMode(recipe(), installedRecipeMode(installed, 'pair-lane')));
  assert.equal(rerun.runtimes['pair-cluster'].recipe.mode, 'sidecars');
  const switched = materialize(installed, applyRecipeMode(recipe(), 'dedicated'));
  assert.equal(switched.runtimes['pair-cluster'].memoryGb, 114);
  assert.equal(utilOf(switched.runtimes['pair-head']), 'UTIL=0.88');
});

test('the remote member setup command carries the mode', () => {
  assert.match(
    setupCommand({ recipeId: 'pair-lane', mode: 'sidecars', apply: true }),
    /--recipe 'pair-lane' --mode 'sidecars'/
  );
  assert.doesNotMatch(setupCommand({ recipeId: 'pair-lane', apply: true }), /--mode/);
});
