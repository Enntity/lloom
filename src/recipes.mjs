import fs from "node:fs/promises";
import path from "node:path";
import { summarizeBenchmarksForRecipe } from "./benchmarks.mjs";
import { repoRoot } from "./config.mjs";

export const recipesRoot = path.join(repoRoot, "recipes");

function machineId({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return `${platform}-${arch}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function commandLine(step, variables = {}) {
  const args = asArray(step.args).map(arg => expandTemplate(String(arg), variables));
  return [step.command, ...args].filter(Boolean);
}

function expandTemplate(value, variables) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => variables[name] ?? "");
}

function configModelIds(config) {
  return new Set((config.models ?? []).map(model => model.id));
}

function configRuntimeIds(config) {
  return new Set(Object.keys(config.runtimes ?? {}));
}

export async function listRecipeFiles(root = recipesRoot) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(root, entry.name))
    .sort();
}

export async function readRecipe(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const recipe = JSON.parse(raw);
  return {
    ...recipe,
    filePath,
  };
}

export async function loadRecipes(root = recipesRoot) {
  const files = await listRecipeFiles(root);
  return Promise.all(files.map(file => readRecipe(file)));
}

export function validateRecipe(recipe, config, {
  backendIds,
} = {}) {
  const errors = [];
  if (!recipe.id) errors.push("recipe is missing id");
  if (!recipe.name) errors.push(`recipe ${recipe.id ?? "(missing)"} is missing name`);
  if (!recipe.backend?.id) errors.push(`recipe ${recipe.id ?? "(missing)"} is missing backend.id`);
  if (recipe.backend?.id && backendIds && !backendIds.has(recipe.backend.id)) {
    errors.push(`recipe ${recipe.id ?? "(missing)"} references unknown backend ${recipe.backend.id}`);
  }
  if (!asArray(recipe.models).length) errors.push(`recipe ${recipe.id ?? "(missing)"} has no models`);

  const modelIds = configModelIds(config);
  const runtimeIds = configRuntimeIds(config);
  for (const model of asArray(recipe.models)) {
    if (!model.role) errors.push(`recipe ${recipe.id} has model without role`);
    if (!model.model) errors.push(`recipe ${recipe.id} model ${model.role ?? "(missing)"} is missing model`);
    if (model.gatewayModel && !modelIds.has(model.gatewayModel)) {
      errors.push(`recipe ${recipe.id} references unknown gateway model ${model.gatewayModel}`);
    }
    if (model.runtime && !runtimeIds.has(model.runtime)) {
      errors.push(`recipe ${recipe.id} references unknown runtime ${model.runtime}`);
    }
  }

  for (const step of asArray(recipe.setup?.steps)) {
    if (!step.id) errors.push(`recipe ${recipe.id} has setup step without id`);
    if (!step.action) errors.push(`recipe ${recipe.id} setup step ${step.id ?? "(missing)"} has no action`);
    if (["command", "check-command"].includes(step.action) && !step.command) {
      errors.push(`recipe ${recipe.id} setup step ${step.id} action ${step.action} requires command`);
    }
    if (step.action === "download-model" && !step.model) {
      errors.push(`recipe ${recipe.id} setup step ${step.id} download-model requires model`);
    }
  }

  return errors;
}

export function planRecipe(recipe, config, {
  modelRoot = "${SWITCHYARD_MODEL_ROOT}",
  platform = process.platform,
  arch = process.arch,
  backendIds,
  benchmarkEvidence,
  benchmarksRoot,
  benchmarkValidationErrors = [],
} = {}) {
  const platformId = machineId({ platform, arch });
  const supportedPlatforms = asArray(recipe.requirements?.platforms);
  const platformSupported = !supportedPlatforms.length || supportedPlatforms.includes(platformId);
  const validationErrors = validateRecipe(recipe, config, { backendIds });
  const benchmarkSummaries = benchmarkEvidence
    ? new Map(summarizeBenchmarksForRecipe(recipe, benchmarkEvidence)
      .map(summary => [summary.role, summary]))
    : null;
  const steps = asArray(recipe.setup?.steps).map(step => {
    const planned = {
      id: step.id,
      title: step.title ?? step.id,
      action: step.action,
    };
    if (step.action === "download-model") {
      planned.provider = step.provider ?? "huggingface";
      planned.model = step.model;
      planned.destination = path.posix.join(modelRoot, step.model);
    } else if (["command", "check-command"].includes(step.action)) {
      planned.command = commandLine(step, { modelRoot });
    }
    return planned;
  });

  return {
    id: recipe.id,
    name: recipe.name,
    version: recipe.version ?? 1,
    platform: platformId,
    platformSupported,
    requirements: recipe.requirements ?? {},
    backend: recipe.backend ?? null,
    validationErrors,
    ...(benchmarkSummaries ? {
      benchmarks: {
        root: benchmarksRoot ?? null,
        validationErrors: benchmarkValidationErrors,
        models: [...benchmarkSummaries.values()],
      },
    } : {}),
    models: asArray(recipe.models).map(model => ({
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      runtime: model.runtime,
      settings: model.settings ?? {},
      observed: model.observed ?? {},
      ...(benchmarkSummaries ? { benchmark: benchmarkSummaries.get(model.role) ?? null } : {}),
    })),
    steps,
  };
}

export async function loadRecipeById(recipeId, root = recipesRoot) {
  const recipes = await loadRecipes(root);
  const recipe = recipes.find(candidate => candidate.id === recipeId);
  if (!recipe) {
    const known = recipes.map(candidate => candidate.id).join(", ");
    throw new Error(`Unknown recipe ${recipeId}. Known recipes: ${known || "(none)"}`);
  }
  return recipe;
}
