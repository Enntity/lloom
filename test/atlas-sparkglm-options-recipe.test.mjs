import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPins, pinnedDrafter, profilePathsOf, verifyPins } from '../backends/atlas-sparkglm/verify-pins.mjs';
import {
  applyRecipeOptions,
  loadRecipeById,
  loadRecipeVersion,
  recipeOptionCombinations,
  validateRecipe
} from '../src/recipes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipeId = 'linux-nvidia-dgx-spark-glm53-atlas';
const manifestArg = '${repoRoot}/backends/atlas-sparkglm/pins-0.3.1.json';
const pins = loadPins(path.join(root, 'backends/atlas-sparkglm/pins-0.3.1.json'));
const recipe = await loadRecipeById(recipeId);
const resolved = (options) => applyRecipeOptions(recipe, options);
const members = (r) => r.models[0].settings.placement.members;
const envOf = (r) => {
  const args = members(r)[1].runtimeSettings.bootstrap.createArgs;
  return Object.fromEntries(
    args.filter((_, i) => args[i - 1] === '-e').map((entry) => entry.split(/=(.*)/s).slice(0, 2))
  );
};

// The documents a recipe that replaces another must reproduce, compared on what
// LLooM installs: models, requirements and setup commands.
function installed(r) {
  return {
    requirements: r.requirements,
    models: r.models,
    steps: r.setup.steps.map(({ title, ...step }) => step)
  };
}

// The four-Spark lane was a separate recipe with its own names; renamed, and
// with its env in any order (docker does not care), it must match exactly.
function asOneRecipe(r) {
  const renamed = JSON.parse(
    JSON.stringify(installed(r))
      .replaceAll('glm-5.3-flash-atlas-tp4', 'glm-5.3-flash-atlas')
      .replaceAll('glm53-flash-atlas-tp4', 'glm53-flash-atlas')
      .replaceAll('lloom-atlas-sparkglm-tp4-', 'lloom-atlas-sparkglm-')
      .replace(/pins-0\.3\.1-(v80|tp4)\.json/g, 'pins-0.3.1.json')
  );
  for (const member of renamed.models[0].settings.placement.members) {
    const args = member.runtimeSettings.bootstrap.createArgs;
    const units = [];
    for (let i = 0; i < args.length; i += 2) units.push(`${args[i]} ${args[i + 1]}`);
    member.runtimeSettings.bootstrap.createArgs = units.sort();
  }
  return renamed;
}

test('the recipe is valid in every combination and installs SparkGLM 0.3.1', () => {
  assert.deepEqual(validateRecipe(recipe, {}, { checkLocalReferences: false }), []);
  assert.equal(recipe.version, 2);
  assert.deepEqual(recipeOptionCombinations(recipe), [
    { sparks: '2', drafter: 'v81' },
    { sparks: '2', drafter: 'v80' },
    { sparks: '2', drafter: 'dflash2' },
    { sparks: '4', drafter: 'v81' },
    { sparks: '4', drafter: 'v80' },
    { sparks: '4', drafter: 'dflash2' }
  ]);
  assert.deepEqual(recipe.selectedOptions, { sparks: '2', drafter: 'v81' });
  assert.deepEqual(resolved({ sparks: '4' }).selectedOptions, { sparks: '4', drafter: 'dflash2' });
  assert.deepEqual(verifyPins(pins), []);
  assert.equal(pins.source.revision, '33fe02f83a9edf96ae38ebe4fc6a8ec8e7603f90');
  for (const step of recipe.setup.steps.filter((s) => ['verify-atlas-pins', 'build-atlas-image'].includes(s.id))) {
    assert.ok(step.args.includes(manifestArg), `${step.id} checks the one manifest`);
  }
});

test('two Sparks with v80 install exactly what the pair recipe installs', async () => {
  const pair = await loadRecipeVersion('linux-nvidia-dgx-spark-2x-glm53-atlas', 4);
  assert.deepEqual(asOneRecipe(resolved({ sparks: '2', drafter: 'v80' })), asOneRecipe(pair));
  // Same order too: nothing about the existing pair install moves.
  assert.deepEqual(
    members(resolved({ sparks: '2', drafter: 'v80' })).map((m) => m.runtimeSettings.bootstrap.createArgs),
    members(pair).map((m) => m.runtimeSettings.bootstrap.createArgs)
  );
});

test('v81 is pinned to the versionless Enntity repository and changes only the drafter', async () => {
  assert.deepEqual(pinnedDrafter(pins, 'v81'), {
    repo: 'Enntity/GLM-5.3-Flash-DFlash2-enntity',
    revision: 'ee5ed56e3ed2e59fd2d5177fe6773b2f6fb4aa80'
  });
  // v80 keeps the repository name it was installed from (the old name
  // redirects), so its folder and acquisition record on existing hosts stand.
  assert.equal(pinnedDrafter(pins, 'v80').repo, 'Enntity/GLM-5.3-Flash-DFlash2-enntity-v80');
  const asV80 = JSON.parse(
    JSON.stringify(installed(resolved({ sparks: '2', drafter: 'v81' })))
      .replaceAll('ee5ed56e3ed2e59fd2d5177fe6773b2f6fb4aa80', '8416cdfbf4cfb302b86a058cb5f5b89f891350c0')
      .replaceAll('GLM-5.3-Flash-DFlash2-enntity', 'GLM-5.3-Flash-DFlash2-enntity-v80')
  );
  assert.deepEqual(asV80, installed(resolved({ sparks: '2', drafter: 'v80' })));
});

test('version 1 still installs v80 by default on two Sparks', async () => {
  const v1 = await loadRecipeVersion(recipeId, 1);
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.selectedOptions, { sparks: '2', drafter: 'v80' });
  assert.deepEqual(installed(v1), installed(resolved({ sparks: '2', drafter: 'v80' })));
});

test('four Sparks with dflash2 install what the 0.3.1 TP-4 recipe installs, under one name', async () => {
  const tp4 = await loadRecipeVersion('linux-nvidia-dgx-spark-4x-glm53-atlas-tp4', 3);
  assert.deepEqual(asOneRecipe(resolved({ sparks: '4', drafter: 'dflash2' })), asOneRecipe(tp4));
});

test('each drafter is acquired, mounted and served from its pin, at either size', () => {
  for (const options of recipeOptionCombinations(recipe)) {
    const r = resolved(options);
    const pinned = pinnedDrafter(pins, options.drafter);
    const directory = pinned.repo.replace('/', '--');
    const step = r.setup.steps.find((s) => s.id === 'download-atlas-drafter');
    assert.deepEqual([step.model, step.revision], [pinned.repo, pinned.revision], JSON.stringify(options));
    for (const member of members(r)) {
      const args = member.runtimeSettings.bootstrap.createArgs;
      assert.ok(args.includes(`DRAFTER_PATH=\${modelRoot}/${directory}`));
      assert.ok(args.includes(`type=bind,src=\${modelRoot}/${directory},dst=\${modelRoot}/${directory},readonly`));
      assert.ok(
        !args.some((arg) => /DFlash2(-enntity(-v80)?)?[,/]/.test(arg) && !arg.includes(directory)),
        'no other drafter'
      );
    }
    const env = envOf(r);
    const four = options.sparks === '4';
    assert.equal(env.SPARKGLM_PROFILE, four ? '4x1m-tp4' : '4x1m');
    assert.equal(env.SPARKGLM_TOPOLOGY, four ? 'chain' : 'pair');
    assert.equal(r.requirements.cluster.nodes, four ? 4 : 2);
    assert.ok(
      profilePathsOf(pins).includes(`/opt/atlas/profiles/${env.SPARKGLM_PROFILE}.json`),
      'the profile is pinned'
    );
  }
});

test('the pin checker takes a drafter map and a profile list, and keeps the old single forms', () => {
  assert.throws(() => pinnedDrafter(pins, 'eagle'), /no drafter eagle; it pins v81, v80, dflash2/);
  const legacy = loadPins(path.join(root, 'backends/atlas-sparkglm/pins-0.3.0-v80.json'));
  assert.deepEqual(verifyPins(legacy), []);
  assert.equal(pinnedDrafter(legacy).repo, 'Enntity/GLM-5.3-Flash-DFlash2-enntity-v80');
  assert.deepEqual(profilePathsOf(legacy), ['/opt/atlas/profiles/4x1m.json']);
  const broken = structuredClone(pins);
  broken.drafters.dflash2.revision = 'TODO';
  broken.drafters['Bad Name'] = { repo: 'x/y', revision: 'a'.repeat(40) };
  broken.image.profilePaths.push('/tmp/elsewhere.json');
  const failures = verifyPins(broken).join('\n');
  assert.match(failures, /drafters\.dflash2\.revision is a placeholder/);
  assert.match(failures, /drafter name Bad Name must be lowercase/);
  assert.match(failures, /image\.profilePaths must be plain paths under \/opt\/atlas, got \/tmp\/elsewhere\.json/);
  const none = structuredClone(pins);
  delete none.drafters;
  assert.match(verifyPins(none).join('\n'), /drafter is missing/);
});
