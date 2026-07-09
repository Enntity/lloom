import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultBenchmarksRoot, listBenchmarkFiles, readBenchmarkFile } from './benchmarks.mjs';
import { createRecipePackPlan, createRecipePackSignature } from './recipe-pack.mjs';
import { defaultRecipeIndexPath, loadRecipeIndex } from './recipe-index.mjs';
import { loadRecipes, recipesRoot as defaultRecipesRoot } from './recipes.mjs';

export const RECIPE_PACK_SCHEMA = 'https://lloom.dev/schemas/recipe-pack.v1.schema.json';
export const RECIPE_PACK_PROFILE = 'https://lloom.dev/profiles/interchange/v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanJson(value) {
  if (Array.isArray(value)) return value.map(cleanJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entryValue]) => key !== 'filePath' && entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanJson(entryValue)])
    );
  }
  return value;
}

function defaultPackId(recipeIds) {
  const scope = recipeIds.length === 1 ? recipeIds[0] : 'recipes';
  return `${scope}-pack`;
}

function benchmarkResults(suite) {
  return Array.isArray(suite.results) ? suite.results : [suite];
}

async function loadBenchmarkSuites(root) {
  const files = await listBenchmarkFiles(root);
  const suites = [];
  for (const file of files) {
    suites.push(await readBenchmarkFile(file));
  }
  return suites;
}

function suiteForRecipeIds(suite, recipeIds) {
  const recipeIdSet = new Set(recipeIds);
  const matching = benchmarkResults(suite).filter((result) => recipeIdSet.has(result.recipeId));
  if (!matching.length) return null;
  const fileName = suite.filePath ? path.basename(suite.filePath) : undefined;
  const cleaned = cleanJson(suite);
  if (Array.isArray(cleaned.results)) {
    return {
      ...cleaned,
      ...(fileName ? { fileName } : {}),
      results: matching.map(cleanJson)
    };
  }
  return {
    ...cleanJson(matching[0]),
    ...(fileName ? { fileName } : {})
  };
}

async function maybeReadFile(filePath) {
  if (!filePath) return undefined;
  return fs.readFile(path.resolve(filePath), 'utf8');
}

export async function createRecipePackExport(
  config,
  {
    recipeIds = [],
    indexPath = defaultRecipeIndexPath,
    recipesRoot = defaultRecipesRoot,
    benchmarksRoot = defaultBenchmarksRoot,
    id,
    name,
    publisher,
    includeBenchmarks = true,
    keyId,
    privateKey,
    publicKey,
    privateKeyPath,
    publicKeyPath,
    outputPath
  } = {}
) {
  const index = await loadRecipeIndex(indexPath);
  const recipes = await loadRecipes(recipesRoot);
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const indexById = new Map(asArray(index.recipes).map((entry) => [entry.id, entry]));
  const selectedRecipeIds =
    recipeIds.includes('all') || recipeIds.length === 0 ? asArray(index.recipes).map((entry) => entry.id) : recipeIds;
  if (!selectedRecipeIds.length) throw new Error('recipe pack export needs at least one recipe');

  const benchmarkSuites = includeBenchmarks ? await loadBenchmarkSuites(benchmarksRoot) : [];
  const entries = [];
  const missing = [];
  for (const recipeId of selectedRecipeIds) {
    const recipe = recipeById.get(recipeId);
    const indexEntry = indexById.get(recipeId);
    if (!recipe) {
      missing.push(`missing recipe ${recipeId}`);
      continue;
    }
    if (!indexEntry) {
      missing.push(`missing index entry ${recipeId}`);
      continue;
    }
    entries.push({
      index: cleanJson(indexEntry),
      recipe: cleanJson(recipe),
      benchmarks: benchmarkSuites.map((suite) => suiteForRecipeIds(suite, [recipeId])).filter(Boolean)
    });
  }

  const pack = {
    $schema: RECIPE_PACK_SCHEMA,
    schemaVersion: 1,
    profile: RECIPE_PACK_PROFILE,
    id: id ?? defaultPackId(selectedRecipeIds),
    name: name ?? `${selectedRecipeIds.join(', ')} recipe pack`,
    ...(index.license ? { license: index.license } : {}),
    updatedAt: new Date().toISOString(),
    ...(publisher ? { publisher } : {}),
    provenance: {
      generatedBy: 'lloom recipe-export',
      generatorVersion: '1'
    },
    recipes: entries
  };

  if (keyId || privateKey || publicKey || privateKeyPath || publicKeyPath) {
    if (!keyId) throw new Error('--key-id is required when signing a recipe pack');
    if (!privateKey && !privateKeyPath) throw new Error('--private-key is required when signing a recipe pack');
    pack.signatures = [
      createRecipePackSignature(pack, {
        keyId,
        privateKey: privateKey ?? (await maybeReadFile(privateKeyPath)),
        publicKey: publicKey ?? (await maybeReadFile(publicKeyPath))
      })
    ];
  }

  const plan = await createRecipePackPlan(pack, config, {
    indexPath,
    recipesRoot,
    benchmarksRoot,
    requireSignature: false
  });
  const validationErrors = [...missing, ...plan.validationErrors];

  return {
    ok: validationErrors.length === 0,
    dryRun: true,
    outputPath: outputPath ? path.resolve(outputPath) : null,
    pack: {
      id: pack.id,
      name: pack.name,
      schemaVersion: pack.schemaVersion,
      recipeCount: pack.recipes.length,
      benchmarkCount: pack.recipes.reduce((sum, entry) => sum + asArray(entry.benchmarks).length, 0),
      signed: Boolean(pack.signatures?.length)
    },
    validationErrors,
    importPlan: plan,
    document: pack
  };
}

export async function writeRecipePackExport(config, { dryRun = true, yes = false, outputPath, ...options } = {}) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to write recipe pack export without yes=true. Re-run with --yes after reviewing the dry-run document.'
    );
  }
  const plan = await createRecipePackExport(config, {
    ...options,
    outputPath
  });
  if (!plan.ok) {
    throw new Error(`Recipe pack export is invalid:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`);
  }
  if (dryRun) return plan;
  if (!outputPath) throw new Error('--output is required when applying recipe pack export');
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(plan.document, null, 2)}\n`, 'utf8');
  return {
    ...plan,
    dryRun: false,
    outputPath: resolved,
    written: {
      path: resolved,
      bytes: Buffer.byteLength(`${JSON.stringify(plan.document, null, 2)}\n`)
    }
  };
}
