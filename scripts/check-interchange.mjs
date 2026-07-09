#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backendIds, loadBackendCatalog, validateBackendCatalog } from '../src/backend-catalog.mjs';
import { validateBenchmarkSuite } from '../src/benchmarks.mjs';
import { loadConfig, repoRoot } from '../src/config.mjs';
import { createInterchangeValidationReport } from '../src/interchange.mjs';
import { validateRecipeIndex } from '../src/recipe-index.mjs';
import { validateRecipe } from '../src/recipes.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function fail(message, details = []) {
  const suffix = details.length ? `\n${details.map((detail) => `- ${detail}`).join('\n')}` : '';
  throw new Error(`${message}${suffix}`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function jsonFiles(root) {
  // eslint-disable-next-line no-useless-assignment
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

async function validateInterchangeFile(filePath, config, options = {}) {
  const report = await createInterchangeValidationReport(filePath, config, options);
  if (!report.ok) {
    fail(`interchange validation failed for ${path.relative(repoRoot, filePath)}`, report.validationErrors ?? []);
  }
  return report;
}

function recipeModelsById(recipe) {
  const models = new Set();
  for (const model of asArray(recipe.models)) {
    if (model?.model) models.add(model.model);
    if (model?.gatewayModel) models.add(model.gatewayModel);
  }
  return models;
}

async function validateRecipeCollection({ label, indexPath, recipesRoot, benchmarksRoot, config, knownBackendIds }) {
  const errors = [];
  const index = await readJson(indexPath);
  errors.push(...validateRecipeIndex(index));

  const recipeEntries = asArray(index.recipes);
  const indexedPaths = new Set(recipeEntries.map((entry) => entry.path).filter(Boolean));
  const indexedIds = new Set(recipeEntries.map((entry) => entry.id).filter(Boolean));
  const recipesById = new Map();

  for (const entry of recipeEntries) {
    const recipePath = entry.path ? path.resolve(recipesRoot, entry.path) : null;
    if (!recipePath || !(await pathExists(recipePath))) {
      errors.push(
        `${label}: recipe index entry ${entry.id ?? '(missing)'} points to missing file ${entry.path ?? '(missing)'}`
      );
      continue;
    }

    const recipe = await readJson(recipePath);
    recipesById.set(recipe.id, recipe);
    if (recipe.id !== entry.id) {
      errors.push(
        `${label}: recipe file ${entry.path} has id ${recipe.id ?? '(missing)'} but index uses ${entry.id ?? '(missing)'}`
      );
    }
    if (recipe.backend?.id && !knownBackendIds.has(recipe.backend.id)) {
      errors.push(`${label}: recipe ${recipe.id} references unknown backend ${recipe.backend.id}`);
    }
    errors.push(
      ...validateRecipe(recipe, config, {
        backendIds: knownBackendIds,
        checkLocalReferences: false
      }).map((error) => `${label}: recipe ${recipe.id ?? entry.id ?? '(missing)'}: ${error}`)
    );
  }

  const recipeFiles = (await jsonFiles(recipesRoot)).filter((filePath) => path.basename(filePath) !== 'index.json');
  for (const recipeFile of recipeFiles) {
    const relative = path.relative(recipesRoot, recipeFile);
    if (!indexedPaths.has(relative)) {
      const recipe = await readJson(recipeFile);
      errors.push(
        `${label}: recipe file ${relative} is not listed in ${path.basename(indexPath)} as ${recipe.id ?? '(missing)'}`
      );
    }
  }

  for (const benchmarkFile of await jsonFiles(benchmarksRoot)) {
    const suite = await readJson(benchmarkFile);
    errors.push(
      ...validateBenchmarkSuite(suite).map((error) => `${label}: benchmark ${path.basename(benchmarkFile)}: ${error}`)
    );
    for (const result of asArray(suite.results)) {
      const recipe = recipesById.get(result?.recipeId);
      if (!recipe) {
        errors.push(
          `${label}: benchmark ${result?.id ?? '(missing)'} references recipe ${result?.recipeId ?? '(missing)'} not present in ${path.relative(repoRoot, indexPath)}`
        );
        continue;
      }
      if (result?.backendId && recipe.backend?.id && result.backendId !== recipe.backend.id) {
        errors.push(
          `${label}: benchmark ${result.id ?? '(missing)'} uses backend ${result.backendId}, recipe ${recipe.id} uses ${recipe.backend.id}`
        );
      }
      const modelIds = recipeModelsById(recipe);
      if (result?.model && result?.gatewayModel && !modelIds.has(result.model) && !modelIds.has(result.gatewayModel)) {
        errors.push(
          `${label}: benchmark ${result.id ?? '(missing)'} model ${result.model} is not in recipe ${recipe.id}`
        );
      }
    }
  }

  if (errors.length) fail(`${label} recipe data failed consistency checks`, errors);
  return {
    indexRecipeCount: indexedIds.size,
    recipeFileCount: recipeFiles.length,
    benchmarkFileCount: (await jsonFiles(benchmarksRoot)).length
  };
}

async function validateSchemaFiles() {
  const schemaFiles = await jsonFiles(path.join(repoRoot, 'schemas'));
  const errors = [];
  for (const filePath of schemaFiles) {
    const schema = await readJson(filePath);
    if (!schema.$schema) errors.push(`${path.relative(repoRoot, filePath)} is missing $schema`);
    if (!schema.$id) errors.push(`${path.relative(repoRoot, filePath)} is missing $id`);
  }
  if (errors.length) fail('schema files failed basic validation', errors);
  return schemaFiles.length;
}

const config = await loadConfig();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-interchange-'));
try {
  const backendCatalogPath = path.join(repoRoot, 'backends', 'catalog.json');
  const backendCatalog = await loadBackendCatalog(backendCatalogPath);
  const catalogErrors = validateBackendCatalog(backendCatalog);
  if (catalogErrors.length) fail('backend catalog failed validation', catalogErrors);
  const knownBackendIds = backendIds(backendCatalog);

  const recipePackValidationRoots = {
    indexPath: path.join(tempRoot, 'pack-recipes', 'index.json'),
    recipesRoot: path.join(tempRoot, 'pack-recipes'),
    benchmarksRoot: path.join(tempRoot, 'pack-benchmarks')
  };

  const exampleReports = [];
  for (const filePath of await jsonFiles(path.join(repoRoot, 'examples', 'interchange'))) {
    exampleReports.push(await validateInterchangeFile(filePath, config, recipePackValidationRoots));
  }

  const seedReports = [];
  for (const filePath of [
    backendCatalogPath,
    path.join(repoRoot, 'clients', 'examples', 'lloom-integrations.json'),
    path.join(repoRoot, 'recipes', 'index.json'),
    ...(await jsonFiles(path.join(repoRoot, 'recipes'))),
    ...(await jsonFiles(path.join(repoRoot, 'benchmarks', 'community'))),
    path.join(repoRoot, 'community', 'recipes', 'index.json'),
    ...(await jsonFiles(path.join(repoRoot, 'community', 'recipes'))),
    ...(await jsonFiles(path.join(repoRoot, 'community', 'benchmarks')))
  ]) {
    if (
      path.basename(filePath) === 'index.json' &&
      filePath !== path.join(repoRoot, 'recipes', 'index.json') &&
      filePath !== path.join(repoRoot, 'community', 'recipes', 'index.json')
    ) {
      continue;
    }
    seedReports.push(await validateInterchangeFile(filePath, config, recipePackValidationRoots));
  }

  const localRecipes = await validateRecipeCollection({
    label: 'bundled recipes',
    indexPath: path.join(repoRoot, 'recipes', 'index.json'),
    recipesRoot: path.join(repoRoot, 'recipes'),
    benchmarksRoot: path.join(repoRoot, 'benchmarks', 'community'),
    config,
    knownBackendIds
  });
  const communityRecipes = await validateRecipeCollection({
    label: 'community host seed recipes',
    indexPath: path.join(repoRoot, 'community', 'recipes', 'index.json'),
    recipesRoot: path.join(repoRoot, 'community', 'recipes'),
    benchmarksRoot: path.join(repoRoot, 'community', 'benchmarks'),
    config,
    knownBackendIds
  });
  const schemaCount = await validateSchemaFiles();

  console.log(
    [
      'interchange ok:',
      `${exampleReports.length} examples`,
      `${seedReports.length} seed documents`,
      `${schemaCount} schemas`,
      `${localRecipes.indexRecipeCount} bundled recipe(s)`,
      `${communityRecipes.indexRecipeCount} host recipe(s)`
    ].join(' ')
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
