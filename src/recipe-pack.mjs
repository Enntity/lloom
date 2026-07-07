import fs from "node:fs/promises";
import path from "node:path";
import { backendIds as catalogBackendIds, loadBackendCatalog } from "./backend-catalog.mjs";
import { validateBenchmarkEvidence } from "./benchmarks.mjs";
import {
  defaultRecipeIndexPath,
  loadRecipeIndex,
  validateRecipeIndex,
} from "./recipe-index.mjs";
import { recipesRoot as defaultRecipesRoot, validateRecipe } from "./recipes.mjs";
import { defaultBenchmarksRoot } from "./benchmarks.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ""));
}

function ensureRelativePath(relativePath, label) {
  if (!relativePath) throw new Error(`${label} is missing path`);
  if (path.isAbsolute(relativePath)) throw new Error(`${label} path must be relative`);
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
    throw new Error(`${label} path must stay inside the target root`);
  }
  return normalized;
}

function resolveInside(root, relativePath, label) {
  const normalized = ensureRelativePath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} path escapes target root`);
  }
  return resolved;
}

function defaultIndexEntry(recipeEntry) {
  const recipe = recipeEntry.recipe ?? {};
  return {
    id: recipe.id,
    path: `${recipe.id}.json`,
    name: recipe.name,
    summary: recipe.summary,
    tags: asArray(recipeEntry.tags),
    recommendedFor: asArray(recipeEntry.recommendedFor),
    source: recipeEntry.source ?? {
      type: "recipe-pack",
    },
  };
}

function safeJsonFileName(value) {
  const safe = String(value ?? "benchmark")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safe || "benchmark"}.json`;
}

async function readJsonSource(source) {
  if (!source) throw new Error("recipe pack source is required");
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch recipe pack ${source}: HTTP ${response.status}`);
    return {
      source,
      json: await response.json(),
    };
  }
  const filePath = path.resolve(source);
  return {
    source: filePath,
    json: JSON.parse(await fs.readFile(filePath, "utf8")),
  };
}

async function existingIndex(indexPath) {
  try {
    return await loadRecipeIndex(indexPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      id: "switchyard-community-recipes",
      name: "Switchyard Community Recipe Index",
      recipes: [],
      filePath: path.resolve(indexPath),
    };
  }
}

async function fileStatus(filePath, expectedContent) {
  try {
    const current = await fs.readFile(filePath, "utf8");
    return current === expectedContent ? "current" : "replace";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return "create";
  }
}

function mergeIndex(index, entries, updatedAt) {
  const byId = new Map(asArray(index.recipes).map(entry => [entry.id, entry]));
  for (const entry of entries) byId.set(entry.id, entry);
  return {
    ...index,
    updatedAt: updatedAt ?? index.updatedAt ?? new Date().toISOString(),
    recipes: [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

function benchmarkResults(suite) {
  return Array.isArray(suite.results) ? suite.results : [suite];
}

function validatePackEntry(entry, config, backendIds) {
  const errors = [];
  const recipe = entry.recipe;
  const index = entry.index ?? defaultIndexEntry(entry);
  if (!recipe) {
    errors.push("recipe pack entry is missing recipe");
    return { index, errors };
  }
  if (!index.id) errors.push(`recipe pack entry for ${recipe.id ?? "(missing)"} is missing index.id`);
  if (index.id && recipe.id && index.id !== recipe.id) {
    errors.push(`recipe pack entry ${index.id} recipe id mismatch: ${recipe.id}`);
  }
  try {
    ensureRelativePath(index.path, `recipe pack entry ${index.id ?? recipe.id ?? "(missing)"}`);
  } catch (error) {
    errors.push(error.message);
  }
  errors.push(...validateRecipe(recipe, config, { backendIds }));

  const recipeModels = new Set(asArray(recipe.models).flatMap(model => [
    model.model,
    model.gatewayModel,
  ].filter(Boolean)));
  for (const suite of asArray(entry.benchmarks)) {
    for (const result of benchmarkResults(suite)) {
      if (result.recipeId !== recipe.id) {
        errors.push(`benchmark ${result.id ?? "(missing)"} recipeId must be ${recipe.id}`);
      }
      const identifiers = [result.model, result.gatewayModel].filter(Boolean);
      if (identifiers.length && !identifiers.some(identifier => recipeModels.has(identifier))) {
        errors.push(`benchmark ${result.id ?? "(missing)"} model does not match recipe ${recipe.id}`);
      }
    }
    errors.push(...validateBenchmarkEvidence(benchmarkResults(suite)));
  }
  return { index, errors };
}

export async function loadRecipePack(source) {
  const loaded = await readJsonSource(source);
  return {
    ...loaded.json,
    source: loaded.source,
  };
}

async function buildRecipePackPlan(source, config, {
  indexPath = defaultRecipeIndexPath,
  recipesRoot = defaultRecipesRoot,
  benchmarksRoot = defaultBenchmarksRoot,
} = {}) {
  const pack = typeof source === "string" ? await loadRecipePack(source) : source;
  const catalog = await loadBackendCatalog();
  const knownBackendIds = catalogBackendIds(catalog);
  const index = await existingIndex(indexPath);
  const validationErrors = [];
  if (pack.schemaVersion !== 1) validationErrors.push("recipe pack schemaVersion must be 1");
  if (!pack.id) validationErrors.push("recipe pack is missing id");
  if (!Array.isArray(pack.recipes)) validationErrors.push("recipe pack recipes must be an array");

  const entries = [];
  const recipeActions = [];
  const benchmarkActions = [];
  for (const [entryIndex, entry] of asArray(pack.recipes).entries()) {
    const { index: indexEntry, errors } = validatePackEntry(entry, config, knownBackendIds);
    validationErrors.push(...errors.map(error => `recipes[${entryIndex}]: ${error}`));
    if (!entry.recipe || !indexEntry.id || !indexEntry.path) continue;

    const recipeFilePath = resolveInside(recipesRoot, indexEntry.path, `recipe pack entry ${indexEntry.id}`);
    const recipeContent = jsonString(entry.recipe);
    entries.push(indexEntry);
    recipeActions.push({
      type: "recipe",
      id: indexEntry.id,
      path: recipeFilePath,
      relativePath: indexEntry.path,
      status: await fileStatus(recipeFilePath, recipeContent),
      content: recipeContent,
    });

    for (const suite of asArray(entry.benchmarks)) {
      const fileName = safeJsonFileName(suite.fileName ?? suite.id ?? `${indexEntry.id}-benchmark`);
      const benchmarkPath = resolveInside(benchmarksRoot, fileName, `benchmark suite ${suite.id ?? indexEntry.id}`);
      const benchmarkContent = jsonString(suite);
      benchmarkActions.push({
        type: "benchmark",
        id: suite.id ?? fileName.replace(/\.json$/, ""),
        path: benchmarkPath,
        relativePath: fileName,
        status: await fileStatus(benchmarkPath, benchmarkContent),
        content: benchmarkContent,
      });
    }
  }

  const mergedIndex = mergeIndex(index, entries, pack.updatedAt);
  const indexValidationErrors = validateRecipeIndex(mergedIndex);
  validationErrors.push(...indexValidationErrors.map(error => `index: ${error}`));
  const indexContent = jsonString({
    ...mergedIndex,
    filePath: undefined,
  });
  const actions = [
    {
      type: "index",
      id: mergedIndex.id,
      path: path.resolve(indexPath),
      status: await fileStatus(indexPath, indexContent),
      content: indexContent,
    },
    ...recipeActions,
    ...benchmarkActions,
  ];

  return {
    ok: validationErrors.length === 0,
    source: pack.source ?? null,
    pack: {
      id: pack.id ?? null,
      name: pack.name ?? null,
      schemaVersion: pack.schemaVersion ?? null,
      recipeCount: asArray(pack.recipes).length,
      benchmarkCount: benchmarkActions.length,
    },
    roots: {
      indexPath: path.resolve(indexPath),
      recipesRoot: path.resolve(recipesRoot),
      benchmarksRoot: path.resolve(benchmarksRoot),
    },
    validationErrors,
    actions: actions.map(({ content, ...action }) => action),
    writableActions: actions,
  };
}

export async function createRecipePackPlan(source, config, options = {}) {
  const {
    writableActions: _writableActions,
    ...plan
  } = await buildRecipePackPlan(source, config, options);
  return plan;
}

export async function applyRecipePack(source, config, {
  dryRun = true,
  yes = false,
  ...options
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to import recipe pack without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }
  const plan = await buildRecipePackPlan(source, config, options);
  if (!plan.ok) {
    throw new Error(`Recipe pack is invalid:\n${plan.validationErrors.map(error => `- ${error}`).join("\n")}`);
  }
  if (dryRun) {
    return {
      ...plan,
      dryRun: true,
      writableActions: undefined,
    };
  }

  const results = [];
  for (const action of plan.writableActions) {
    await fs.mkdir(path.dirname(action.path), { recursive: true });
    await fs.writeFile(action.path, action.content);
    results.push({
      type: action.type,
      id: action.id,
      path: action.path,
      status: action.status === "current" ? "unchanged" : "written",
      previousStatus: action.status,
    });
  }

  return {
    ...plan,
    dryRun: false,
    writableActions: undefined,
    results,
  };
}
