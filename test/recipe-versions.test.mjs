import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRecipeIndex } from '../src/recipe-index.mjs';
import { loadRecipeById, loadRecipeVersion } from '../src/recipes.mjs';
import { setupCommand } from '../src/setup.mjs';

const recipe = (version, image) => ({ schemaVersion: 1, id: 'pair-lane', name: 'Pair lane', version, image });
const entry = () => ({
  id: 'pair-lane',
  name: 'Pair lane',
  path: 'pair-lane.json',
  currentVersion: 1,
  versions: [
    { version: 1, path: 'pair-lane.json', status: 'current' },
    { version: 2, path: 'candidates/pair-lane/v2.json', status: 'candidate' }
  ]
});

async function recipesRoot(index = { recipes: [entry()] }, candidate = recipe(2, 'next')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-recipe-versions-'));
  await fs.mkdir(path.join(root, 'candidates', 'pair-lane'), { recursive: true });
  await fs.writeFile(path.join(root, 'pair-lane.json'), JSON.stringify(recipe(1, 'current')));
  await fs.writeFile(path.join(root, 'candidates', 'pair-lane', 'v2.json'), JSON.stringify(candidate));
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify(index));
  return root;
}

test('a candidate version installs only when asked for by number', async () => {
  const root = await recipesRoot();
  assert.equal((await loadRecipeById('pair-lane', root)).image, 'current');
  assert.equal((await loadRecipeVersion('pair-lane', 2, root)).image, 'next');
  assert.equal((await loadRecipeVersion('pair-lane', '1', root)).image, 'current');
  await fs.rm(root, { recursive: true, force: true });
});

test('an unlisted version, a mismatched file or an escaping path is refused', async () => {
  const root = await recipesRoot();
  await assert.rejects(loadRecipeVersion('pair-lane', 3, root), /pair-lane has no version 3; its versions are 1, 2/);
  await assert.rejects(loadRecipeVersion('other-lane', 1, root), /Unknown recipe other-lane/);
  await fs.rm(root, { recursive: true, force: true });

  const mismatched = await recipesRoot(undefined, recipe(3, 'next'));
  await assert.rejects(loadRecipeVersion('pair-lane', 2, mismatched), /file declares pair-lane version 3/);
  await fs.rm(mismatched, { recursive: true, force: true });

  const escaping = entry();
  escaping.versions[1].path = '../outside.json';
  const outside = await recipesRoot({ recipes: [escaping] });
  await assert.rejects(loadRecipeVersion('pair-lane', 2, outside), /must stay inside the recipes root/);
  await fs.rm(outside, { recursive: true, force: true });
});

test('the index accepts candidates beside exactly one current version', () => {
  const index = (recipes) => ({ schemaVersion: 1, id: 'test', name: 'Test', recipes });
  assert.deepEqual(validateRecipeIndex(index([entry()])), []);
  const promoted = entry();
  promoted.versions[1].status = 'current';
  assert.match(validateRecipeIndex(index([promoted])).join('\n'), /exactly one current entry/);
  const unknown = entry();
  unknown.versions[1].status = 'beta';
  assert.match(validateRecipeIndex(index([unknown])).join('\n'), /status must be current, candidate or archived/);
});

test('the remote member setup command carries the recipe version', () => {
  assert.match(
    setupCommand({ recipeId: 'pair-lane', recipeVersion: 2, mode: 'sidecars', apply: true }),
    /--recipe 'pair-lane' --recipe-version '2' --mode 'sidecars'/
  );
  assert.doesNotMatch(setupCommand({ recipeId: 'pair-lane', apply: true }), /--recipe-version/);
});

const candidates = [
  {
    id: 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas',
    version: 4,
    product: '0.5.0',
    pins: 'atlas-sparkqwen/pins-0.5.0.json',
    verify: '../backends/atlas-sparkqwen/verify-pins.mjs'
  },
  {
    id: 'linux-nvidia-dgx-spark-2x-glm53-atlas',
    version: 2,
    product: '0.3.0',
    pins: 'atlas-sparkglm/pins-0.3.0.json',
    verify: '../backends/atlas-sparkglm/verify-pins.mjs',
    env: ['SPARKGLM_MODE=spark', 'SPARKGLM_TOPOLOGY=pair', 'SPARKGLM_PROFILE=4x1m', 'SPARKGLM_KV_SHARD=1']
  },
  {
    id: 'linux-nvidia-dgx-spark-2x-glm53-atlas',
    version: 3,
    product: '0.3.0',
    pins: 'atlas-sparkglm/pins-0.3.0.json',
    verify: '../backends/atlas-sparkglm/verify-pins.mjs',
    env: [
      'SPARKGLM_MODE=spark',
      'SPARKGLM_TOPOLOGY=pair',
      'SPARKGLM_PROFILE=4x1m',
      'SPARKGLM_KV_SHARD=1',
      'DRAFTER_PATH=${modelRoot}/Enntity--GLM-5.3-Flash-DFlash2-enntity-v80'
    ],
    drafter: {
      model: 'Enntity/GLM-5.3-Flash-DFlash2-enntity-v80',
      revision: '8416cdfbf4cfb302b86a058cb5f5b89f891350c0'
    },
    keepWarm: true
  },
  {
    id: 'linux-nvidia-dgx-spark-4x-glm53-atlas-tp4',
    version: 2,
    product: '0.3.0',
    pins: 'atlas-sparkglm/pins-0.3.0-tp4.json',
    verify: '../backends/atlas-sparkglm/verify-pins.mjs',
    env: ['SPARKGLM_MODE=spark', 'SPARKGLM_TOPOLOGY=chain', 'SPARKGLM_PROFILE=4x1m-tp4']
  }
];

for (const candidate of candidates) {
  test(`${candidate.id} v${candidate.version} (${candidate.product}) is a candidate behind the current version`, async () => {
    const current = await loadRecipeById(candidate.id);
    assert.ok(current.version < candidate.version, 'the candidate must not be the default');
    const recipe = await loadRecipeVersion(candidate.id, candidate.version);
    const { loadPins, verifyPins } = await import(candidate.verify);
    const manifest = loadPins(fileURLToPath(new URL(`../backends/${candidate.pins}`, import.meta.url)));
    assert.deepEqual(verifyPins(manifest), []);
    assert.equal(manifest.engine.branch, 'spark');
    assert.equal(manifest.engine.commit, '162b4226070fbd3a75a5a0d5910f9290fa96bed2');
    const boots = recipe.models[0].settings.placement.members.map((member) => member.runtimeSettings.bootstrap);
    for (const boot of boots) {
      assert.equal(boot.image, manifest.image.reference);
      const env = boot.createArgs.filter((_, i) => boot.createArgs[i - 1] === '-e');
      for (const expected of candidate.env ?? []) assert.ok(env.includes(expected), `${expected} missing`);
      assert.ok(boot.createArgs.includes('/run/lock/sparkglm:/run/lock/sparkglm'), 'shared carveout lock');
    }
    if (candidate.keepWarm !== undefined) assert.equal(recipe.models[0].settings.keepWarm, candidate.keepWarm);
    const setup = Array.isArray(recipe.setup) ? recipe.setup : recipe.setup.steps;
    if (candidate.drafter) {
      const drafter = setup.find((step) => step.id === 'download-atlas-drafter');
      assert.deepEqual({ model: drafter.model, revision: drafter.revision }, candidate.drafter);
      const folder = candidate.drafter.model.replace('/', '--');
      for (const boot of boots) {
        const mounts = boot.createArgs.filter((arg) => arg.includes('DFlash2'));
        assert.ok(
          mounts.length && mounts.every((arg) => arg.includes(folder)),
          'drafter comes only from its own folder'
        );
      }
    }
    for (const step of setup.filter((s) =>
      ['verify-atlas-pins', 'build-atlas-image', 'pull-atlas-image'].includes(s.id)
    )) {
      assert.ok(
        step.args.includes(`\${repoRoot}/backends/${candidate.pins}`),
        `${step.id} must check the candidate pins`
      );
    }
  });
}
