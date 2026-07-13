import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultBenchmarksRoot, loadBenchmarkEvidence, validateBenchmarkEvidence } from './benchmarks.mjs';
import { loadRecipes, planRecipe, recipesRoot, validateRecipe } from './recipes.mjs';

export const defaultRecipeIndexPath = path.join(recipesRoot, 'index.json');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function commandString(args) {
  return args
    .map((arg) => {
      const text = String(arg);
      return /^[A-Za-z0-9_./:@=${}~-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
    })
    .join(' ');
}

function pathTraversalError(value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return 'path must be relative';
  const normalized = path.normalize(value);
  if (normalized === '.' || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    return 'path must stay inside the recipes root';
  }
  return null;
}

export async function loadRecipeIndex(indexPath = defaultRecipeIndexPath) {
  const resolvedPath = path.resolve(indexPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  return {
    ...JSON.parse(raw),
    filePath: resolvedPath
  };
}

export function validateRecipeIndex(index) {
  const errors = [];
  if (index.schemaVersion !== 1) errors.push('recipe index schemaVersion must be 1');
  if (!index.id) errors.push('recipe index is missing id');
  if (!index.name) errors.push('recipe index is missing name');
  if (!Array.isArray(index.recipes)) errors.push('recipe index recipes must be an array');

  const ids = new Set();
  const paths = new Set();
  for (const [entryIndex, entry] of asArray(index.recipes).entries()) {
    const prefix = `recipe index recipes[${entryIndex}]`;
    if (!entry?.id) errors.push(`${prefix} is missing id`);
    if (!entry?.path) errors.push(`${prefix} is missing path`);
    if (!entry?.name) errors.push(`${prefix} is missing name`);
    const pathError = pathTraversalError(entry?.path);
    if (pathError) errors.push(`${prefix} ${pathError}`);
    if (entry?.id && ids.has(entry.id)) errors.push(`duplicate recipe index id: ${entry.id}`);
    if (entry?.path && paths.has(entry.path)) errors.push(`duplicate recipe index path: ${entry.path}`);
    if (entry?.id) ids.add(entry.id);
    if (entry?.path) paths.add(entry.path);
    const source = asObject(entry?.source);
    if (entry?.source && !source.type) errors.push(`${prefix} source is missing type`);
    if (entry?.currentVersion != null && (!Number.isInteger(entry.currentVersion) || entry.currentVersion < 1)) {
      errors.push(`${prefix} currentVersion must be a positive integer`);
    }
    if (entry?.versions != null && !Array.isArray(entry.versions)) {
      errors.push(`${prefix} versions must be an array`);
    }
    const versionNumbers = new Set();
    const versionPaths = new Set();
    let currentCount = 0;
    for (const [versionIndex, version] of asArray(entry?.versions).entries()) {
      const versionPrefix = `${prefix} versions[${versionIndex}]`;
      if (!Number.isInteger(version?.version) || version.version < 1) {
        errors.push(`${versionPrefix} version must be a positive integer`);
      }
      if (!version?.path) errors.push(`${versionPrefix} is missing path`);
      const versionPathError = pathTraversalError(version?.path);
      if (versionPathError) errors.push(`${versionPrefix} ${versionPathError}`);
      if (!['current', 'archived'].includes(version?.status)) {
        errors.push(`${versionPrefix} status must be current or archived`);
      }
      if (version?.status === 'current') currentCount += 1;
      if (versionNumbers.has(version?.version)) errors.push(`${prefix} has duplicate version ${version?.version}`);
      if (versionPaths.has(version?.path)) errors.push(`${prefix} has duplicate version path ${version?.path}`);
      versionNumbers.add(version?.version);
      versionPaths.add(version?.path);
    }
    if (asArray(entry?.versions).length) {
      if (currentCount !== 1) errors.push(`${prefix} versions must contain exactly one current entry`);
      const current = entry.versions.find((version) => version.status === 'current');
      if (current && current.path !== entry.path) errors.push(`${prefix} current version path must match path`);
      if (current && current.version !== entry.currentVersion) {
        errors.push(`${prefix} current version must match currentVersion`);
      }
    }
  }

  return errors;
}

async function validateRecipeVersionFiles(index, root) {
  const errorsById = new Map();
  for (const entry of asArray(index.recipes)) {
    const errors = [];
    for (const version of asArray(entry?.versions)) {
      if (!version?.path || pathTraversalError(version.path)) continue;
      const filePath = path.resolve(root, version.path);
      try {
        const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (document.id !== entry.id) {
          errors.push(`recipe ${entry.id} version ${version.version} file has id ${document.id ?? '(missing)'}`);
        }
        if (document.version !== version.version) {
          errors.push(
            `recipe ${entry.id} version ${version.version} file declares version ${document.version ?? '(missing)'}`
          );
        }
      } catch (error) {
        errors.push(`recipe ${entry.id} version ${version.version} could not be read: ${error.message}`);
      }
    }
    errorsById.set(entry.id, errors);
  }
  return errorsById;
}

export async function buildRecipeIndexReport(
  config,
  {
    indexPath = defaultRecipeIndexPath,
    recipesRoot: root = recipesRoot,
    modelRoot = '${LLOOM_MODEL_ROOT}',
    backendIds,
    benchmarksRoot = defaultBenchmarksRoot,
    benchmarkEvidence,
    benchmarkValidationErrors
  } = {}
) {
  const index = await loadRecipeIndex(indexPath);
  const recipes = await loadRecipes(root);
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const evidence = benchmarkEvidence ?? (await loadBenchmarkEvidence(benchmarksRoot));
  const evidenceValidationErrors = benchmarkValidationErrors ?? validateBenchmarkEvidence(evidence);
  const validationErrors = validateRecipeIndex(index);
  const versionErrorsById = await validateRecipeVersionFiles(index, root);

  const entries = asArray(index.recipes).map((entry) => {
    const recipe = recipeById.get(entry.id);
    const expectedPath = entry.path ? path.resolve(root, entry.path) : null;
    const errors = [];

    if (!recipe) {
      errors.push(`recipe ${entry.id ?? '(missing)'} is listed in index but no recipe file was loaded`);
    }
    if (recipe && expectedPath && path.resolve(recipe.filePath) !== expectedPath) {
      errors.push(`recipe ${entry.id} path ${entry.path} resolved to ${expectedPath}, loaded ${recipe.filePath}`);
    }

    const recipeValidationErrors = recipe
      ? validateRecipe(recipe, config, { backendIds, checkLocalReferences: false })
      : [];
    const plan = recipe
      ? planRecipe(recipe, config, {
          modelRoot,
          backendIds,
          checkLocalReferences: false,
          benchmarkEvidence: evidence,
          benchmarksRoot,
          benchmarkValidationErrors: evidenceValidationErrors
        })
      : null;
    const recipeErrors = [...errors, ...recipeValidationErrors, ...(versionErrorsById.get(entry.id) ?? [])];

    return {
      id: entry.id ?? null,
      name: entry.name ?? recipe?.name ?? null,
      summary: entry.summary ?? recipe?.summary ?? null,
      path: entry.path ?? null,
      filePath: expectedPath,
      recipeFilePath: recipe?.filePath ?? null,
      tags: asArray(entry.tags),
      recommendedFor: asArray(entry.recommendedFor),
      source: entry.source ?? null,
      currentVersion: entry.currentVersion ?? recipe?.version ?? null,
      versions: asArray(entry.versions),
      present: Boolean(recipe),
      ok: recipeErrors.length === 0,
      validationErrors: recipeErrors,
      platformSupported: plan?.platformSupported ?? false,
      setupRequired: Boolean(recipe?.setup?.steps?.length),
      backend: plan?.backend ?? null,
      requirements: plan?.requirements ?? {},
      models: plan?.models ?? [],
      benchmarks: plan?.benchmarks ?? null,
      commands: recipe
        ? {
            plan: commandString(['lloom', 'plan', recipe.id, '--model-root', modelRoot]),
            installDryRun: commandString(['lloom', 'install', recipe.id, '--model-root', modelRoot]),
            installApply: commandString(['lloom', 'install', recipe.id, '--model-root', modelRoot, '--apply', '--yes']),
            bootstrapDryRun: commandString(['lloom', 'bootstrap', '--recipe', recipe.id, '--model-root', modelRoot]),
            bootstrapApply: commandString([
              'lloom',
              'bootstrap',
              '--recipe',
              recipe.id,
              '--model-root',
              modelRoot,
              '--apply',
              '--yes'
            ])
          }
        : {}
    };
  });

  const entryErrors = entries.flatMap((entry) => entry.validationErrors);
  return {
    ok: validationErrors.length === 0 && evidenceValidationErrors.length === 0 && entryErrors.length === 0,
    index: {
      id: index.id ?? null,
      name: index.name ?? null,
      schemaVersion: index.schemaVersion ?? null,
      updatedAt: index.updatedAt ?? null,
      filePath: index.filePath,
      count: asArray(index.recipes).length
    },
    recipesRoot: path.resolve(root),
    validationErrors,
    benchmarks: {
      root: benchmarksRoot,
      count: evidence.length,
      validationErrors: evidenceValidationErrors
    },
    recipes: entries
  };
}
