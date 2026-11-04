import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyRecipeOptions,
  installedRecipeOptions,
  loadRecipeVersion,
  prepareRecipeDocument,
  readRecipe,
  recipeOptionCombinations,
  recipeWithInstalledOptions,
  validateRecipe
} from '../src/recipes.mjs';
import { setupCommand } from '../src/setup.mjs';

// A two-option document in the shape the SparkGLM recipe uses: the size picks
// whole blocks, the drafter fills ${...} strings, and the drafter's default
// depends on the size.
function lane() {
  return {
    schemaVersion: 1,
    id: 'opt-lane',
    version: 1,
    name: 'Option lane',
    backend: { id: 'docker' },
    options: {
      sparks: {
        default: '2',
        values: {
          2: { description: 'pair', variables: { profile: '4x1m' } },
          4: { description: 'chain', variables: { profile: '4x1m-tp4' } }
        }
      },
      drafter: {
        default: { $option: 'sparks', 2: 'v80', 4: 'dflash2' },
        values: {
          v80: { variables: { drafterRepo: 'Enntity/v80', drafterDir: 'Enntity--v80' } },
          dflash2: { variables: { drafterRepo: 'incoai/dflash2', drafterDir: 'incoai--dflash2' } }
        }
      }
    },
    requirements: {
      cluster: {
        nodes: { $option: 'sparks', 2: 2, 4: 4 },
        topology: { $option: 'sparks', 2: 'direct', 4: 'chain' },
        provider: { $option: 'sparks', 2: 'nvidia-sync', 4: null }
      }
    },
    setup: { steps: [{ id: 'drafter', action: 'download-model', model: '${drafterRepo}' }] },
    models: [
      {
        role: 'chat',
        model: 'm',
        settings: {
          createArgs: [
            '-e',
            'SPARKGLM_PROFILE=${profile}',
            { $option: 'sparks', 2: ['-e', 'FABRIC_HCA=${fabricHca}'], 4: ['-e', 'FABRIC_LEFT_HCA=${fabricLeftHca}'] },
            '-e',
            'DRAFTER_PATH=${modelRoot}/${drafterDir}'
          ]
        }
      }
    ]
  };
}

test('defaults resolve every option node and template, leaving runtime templates alone', () => {
  const recipe = prepareRecipeDocument(lane());
  assert.deepEqual(recipe.selectedOptions, { sparks: '2', drafter: 'v80' });
  assert.deepEqual(recipe.requirements.cluster, { nodes: 2, topology: 'direct', provider: 'nvidia-sync' });
  assert.equal(recipe.setup.steps[0].model, 'Enntity/v80');
  assert.deepEqual(recipe.models[0].settings.createArgs, [
    '-e',
    'SPARKGLM_PROFILE=4x1m',
    '-e',
    'FABRIC_HCA=${fabricHca}',
    '-e',
    'DRAFTER_PATH=${modelRoot}/Enntity--v80'
  ]);
  assert.ok(recipe.options.sparks, 'the declaration stays for listings');
  assert.deepEqual(validateRecipe(recipe, {}, { checkLocalReferences: false }), []);
});

test('a requested value re-resolves from the source, and dependent defaults follow it', () => {
  const four = applyRecipeOptions(prepareRecipeDocument(lane()), { sparks: 4 });
  assert.deepEqual(four.selectedOptions, { sparks: '4', drafter: 'dflash2' });
  assert.deepEqual(four.requirements.cluster, { nodes: 4, topology: 'chain' }, 'a null branch drops the key');
  assert.deepEqual(four.models[0].settings.createArgs.slice(2, 4), ['-e', 'FABRIC_LEFT_HCA=${fabricLeftHca}']);

  const mixed = applyRecipeOptions(four, { sparks: '4', drafter: 'v80' });
  assert.deepEqual(mixed.selectedOptions, { sparks: '4', drafter: 'v80' });
  assert.equal(mixed.setup.steps[0].model, 'Enntity/v80');
  assert.equal(mixed.models[0].settings.createArgs.at(-1), 'DRAFTER_PATH=${modelRoot}/Enntity--v80');
});

test('names a recipe does not declare are ignored; a bad value names the choices', () => {
  const recipe = prepareRecipeDocument(lane());
  assert.deepEqual(applyRecipeOptions(recipe, { port: '9000', recipe: 'x' }).selectedOptions, {
    sparks: '2',
    drafter: 'v80'
  });
  assert.throws(
    () => applyRecipeOptions(recipe, { drafter: 'eagle' }),
    /option drafter has no value eagle; its values are v80, dflash2/
  );
  const plain = { id: 'plain', models: [] };
  assert.equal(applyRecipeOptions(plain, { drafter: 'v80' }), plain, 'a recipe without options is returned as is');
});

test('every combination is checked, and broken declarations are refused', () => {
  assert.deepEqual(
    recipeOptionCombinations(lane()).map((c) => `${c.sparks}/${c.drafter}`),
    ['2/v80', '2/dflash2', '4/v80', '4/dflash2']
  );
  const errorsFor = (mutate) => {
    const document = lane();
    mutate(document);
    try {
      return validateRecipe(prepareRecipeDocument(document), {}, { checkLocalReferences: false }).join('\n');
    } catch (error) {
      return error.message;
    }
  };
  assert.match(
    errorsFor((d) => (d.options.port = d.options.sparks)),
    /option port clashes with a setup flag/
  );
  assert.match(
    errorsFor((d) => (d.options.sparks.default = '8')),
    /option sparks default 8 is not one of its values/
  );
  assert.match(
    errorsFor((d) => (d.options.drafter.values.v80.variables.drafterDir = ['x'])),
    /variable drafterDir must be a string, number or boolean/
  );
  assert.match(
    errorsFor((d) => (d.requirements.cluster.nodes = { $option: 'size', 2: 2 })),
    /selects on undeclared option size/
  );
  assert.match(
    errorsFor((d) => delete d.requirements.cluster.topology[4]),
    /has no branch for sparks=4/
  );
});

test('files load resolved, and a version keeps its options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-recipe-options-'));
  await fs.writeFile(path.join(root, 'opt-lane.json'), JSON.stringify(lane()));
  await fs.writeFile(
    path.join(root, 'index.json'),
    JSON.stringify({
      recipes: [
        {
          id: 'opt-lane',
          path: 'opt-lane.json',
          currentVersion: 1,
          versions: [{ version: 1, path: 'opt-lane.json', status: 'current' }]
        }
      ]
    })
  );
  const read = await readRecipe(path.join(root, 'opt-lane.json'));
  assert.equal(read.requirements.cluster.nodes, 2);
  const versioned = await loadRecipeVersion('opt-lane', 1, root);
  assert.equal(applyRecipeOptions(versioned, { sparks: '4' }).requirements.cluster.nodes, 4);
  // structuredClone keeps the resolved document but not its source, so the
  // options can no longer be changed; that must fail loudly, not silently.
  assert.throws(() => applyRecipeOptions(structuredClone(versioned), { sparks: '4' }), /lost its option source/);
});

test('setup remembers the options it installed and hands them to cluster members', () => {
  const config = {
    runtimes: {
      other: { recipe: { id: 'elsewhere', options: { sparks: '4' } } },
      head: { recipe: { id: 'opt-lane', version: 1, options: { sparks: '4', drafter: 'v80' } } }
    }
  };
  assert.deepEqual(installedRecipeOptions(config, 'opt-lane'), { sparks: '4', drafter: 'v80' });
  assert.deepEqual(installedRecipeOptions(config, 'missing'), {});
  // Status and bootstrap read the recipe as it was installed, not with its defaults.
  const asInstalled = recipeWithInstalledOptions(prepareRecipeDocument(lane()), config);
  assert.deepEqual(asInstalled.selectedOptions, { sparks: '4', drafter: 'v80' });
  const stale = { runtimes: { head: { recipe: { id: 'opt-lane', options: { sparks: '8', drafter: 'dflash2' } } } } };
  assert.deepEqual(recipeWithInstalledOptions(prepareRecipeDocument(lane()), stale).selectedOptions, {
    sparks: '2',
    drafter: 'dflash2'
  });
  const command = setupCommand({
    recipeId: 'opt-lane',
    recipeOptions: { sparks: '4', drafter: 'dflash2' },
    apply: true
  });
  assert.match(command, /--recipe '?opt-lane'? --sparks '?4'? --drafter '?dflash2'? .*--apply --yes/);
});
