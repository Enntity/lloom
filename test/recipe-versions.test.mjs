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

const ENGINE_0_5_0 = '162b4226070fbd3a75a5a0d5910f9290fa96bed2';
const ENGINE_0_5_1 = '5f79b46ba7b0e8b14f8b2966cca9e2546f18560d';
const ENGINE_SPARKQWEN_0_7_0 = '8a193a8667997274096cedd62b13de0d5334c079';

const sparkqwen = {
  id: 'linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas',
  verify: '../backends/atlas-sparkqwen/verify-pins.mjs'
};
const sparkglmPair = {
  id: 'linux-nvidia-dgx-spark-2x-glm53-atlas',
  verify: '../backends/atlas-sparkglm/verify-pins.mjs',
  env: [
    'SPARKGLM_MODE=spark',
    'SPARKGLM_TOPOLOGY=pair',
    'SPARKGLM_PROFILE=4x1m',
    'SPARKGLM_KV_SHARD=1',
    'DRAFTER_PATH=${modelRoot}/Enntity--GLM-5.3-Flash-DFlash2-enntity-v80'
  ],
  keepWarm: true
};
const sparkglmTp4 = {
  id: 'linux-nvidia-dgx-spark-4x-glm53-atlas-tp4',
  verify: '../backends/atlas-sparkglm/verify-pins.mjs',
  env: ['SPARKGLM_MODE=spark', 'SPARKGLM_TOPOLOGY=chain', 'SPARKGLM_PROFILE=4x1m-tp4']
};

const promoted = [
  {
    ...sparkqwen,
    version: 6,
    product: '0.7.0',
    pins: 'atlas-sparkqwen/pins-0.7.0.json',
    engine: ENGINE_SPARKQWEN_0_7_0
  },
  { ...sparkglmPair, version: 4, product: '0.3.1', pins: 'atlas-sparkglm/pins-0.3.1-v80.json', engine: ENGINE_0_5_1 },
  { ...sparkglmTp4, version: 2, product: '0.3.0', pins: 'atlas-sparkglm/pins-0.3.0-tp4.json', engine: ENGINE_0_5_0 }
];
const archived = [
  { ...sparkqwen, version: 5, product: '0.5.1', pins: 'atlas-sparkqwen/pins-0.5.1.json', engine: ENGINE_0_5_1 },
  { ...sparkqwen, version: 4, product: '0.5.0', pins: 'atlas-sparkqwen/pins-0.5.0.json', engine: ENGINE_0_5_0 },
  { ...sparkglmPair, version: 3, product: '0.3.0', pins: 'atlas-sparkglm/pins-0.3.0-v80.json', engine: ENGINE_0_5_0 }
];
const candidates = [
  { ...sparkglmTp4, version: 3, product: '0.3.1', pins: 'atlas-sparkglm/pins-0.3.1-tp4.json', engine: ENGINE_0_5_1 }
];

// Pins, image, env, drafter and per-image caches agree for one release lane.
async function assertRelease(recipe, release) {
  assert.equal(recipe.version, release.version);
  const { loadPins, verifyPins } = await import(release.verify);
  const manifest = loadPins(fileURLToPath(new URL(`../backends/${release.pins}`, import.meta.url)));
  assert.deepEqual(verifyPins(manifest), []);
  assert.equal(manifest.engine.branch, 'spark');
  assert.equal(manifest.engine.commit, release.engine);
  assert.match(manifest.note, new RegExp(`^Pin manifest for Spark\\w+ ${release.product.replaceAll('.', '\\.')}[ ,]`));
  assert.match(manifest.note, new RegExp(` version ${release.version}[.,]`));
  if (release.keepWarm !== undefined) assert.equal(recipe.models[0].settings.keepWarm, release.keepWarm);
  const setup = Array.isArray(recipe.setup) ? recipe.setup : recipe.setup.steps;
  const drafter = setup.find((step) => step.id === 'download-atlas-drafter');
  if (drafter) assert.deepEqual([drafter.model, drafter.revision], [manifest.drafter.repo, manifest.drafter.revision]);
  const digest = manifest.image.reference.split(':')[1];
  const boots = recipe.models[0].settings.placement.members.map((member) => member.runtimeSettings.bootstrap);
  for (const boot of boots) {
    assert.equal(boot.image, manifest.image.reference);
    const env = boot.createArgs.filter((_, i) => boot.createArgs[i - 1] === '-e');
    for (const expected of release.env ?? []) assert.ok(env.includes(expected), `${expected} missing`);
    assert.ok(boot.createArgs.includes('/run/lock/sparkglm:/run/lock/sparkglm'), 'shared carveout lock');
    // A per-image cache must be keyed by this image, never a previous one.
    for (const arg of boot.createArgs.filter((a) => a.includes('atlas-sparkqwen-ple/')))
      assert.ok(arg.includes(digest), arg);
  }
  for (const step of setup.filter((s) =>
    ['verify-atlas-pins', 'build-atlas-image', 'pull-atlas-image'].includes(s.id)
  )) {
    assert.ok(step.args.includes(`\${repoRoot}/backends/${release.pins}`), `${step.id} must check this release's pins`);
  }
  return manifest;
}

for (const release of promoted) {
  test(`${release.id} v${release.version} (${release.product}) is the default`, async () => {
    const recipe = await loadRecipeById(release.id);
    assert.doesNotMatch(recipe.name, /candidate/i);
    assert.match(recipe.name, new RegExp(`Spark\\w+ ${release.product.replaceAll('.', '\\.')}[,)]`));
    const manifest = await assertRelease(recipe, release);
    assert.doesNotMatch(JSON.stringify(recipe) + manifest.note, /Candidate:|not qualified/);
  });
}

for (const release of archived) {
  test(`${release.id} v${release.version} (${release.product}) stays installable by number`, async () => {
    await assertRelease(await loadRecipeVersion(release.id, release.version), release);
  });
}

for (const release of candidates) {
  test(`${release.id} v${release.version} (${release.product}) installs only by number`, async () => {
    const recipe = await loadRecipeVersion(release.id, release.version);
    assert.match(recipe.name, new RegExp(`${release.product.replaceAll('.', '\\.')} candidate`));
    assert.doesNotMatch(JSON.stringify(recipe), /2026-11-03/, 'a candidate carries no qualification claim');
    await assertRelease(recipe, release);
  });
}
