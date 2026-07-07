import fs from "node:fs/promises";
import path from "node:path";
import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  selectIntegrationArtifacts,
  writeGeneratedIntegrationArtifacts,
} from "./client-integrations.mjs";
import { defaultBackendVariables, getBackend, loadBackendCatalog, planBackend } from "./backend-catalog.mjs";
import { profileMachine, rankRecipes } from "./machine-profile.mjs";
import { createRegistry } from "./registry.mjs";
import { loadRecipeById, loadRecipes } from "./recipes.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripRuntimeFields(config) {
  const copy = clone(config);
  delete copy.sourcePath;
  return copy;
}

function defaultHome(home = process.env.HOME) {
  return home ? path.join(home, ".switchyard") : path.resolve(".switchyard");
}

export function defaultUserConfigPath(home = process.env.HOME) {
  return path.join(defaultHome(home), "config.json");
}

export function defaultGeneratedRoot(home = process.env.HOME) {
  return path.join(defaultHome(home), "generated");
}

function recipeRuntimeIds(recipe) {
  return [...new Set((recipe.models ?? [])
    .map(model => model.runtime)
    .filter(Boolean))];
}

function defaultKeepWarmRuntime(config, recipe) {
  const defaultModel = config.defaults?.chatModel;
  const defaultRecipeModel = (recipe.models ?? []).find(model => model.gatewayModel === defaultModel);
  if (defaultRecipeModel?.runtime) return defaultRecipeModel.runtime;
  return recipeRuntimeIds(recipe)[0] ?? null;
}

function retargetRuntimeModelArg(runtime, modelRoot, modelId) {
  if (!modelRoot || !Array.isArray(runtime.args)) return;
  const index = runtime.args.indexOf("--model");
  if (index === -1 || index === runtime.args.length - 1) return;
  runtime.args[index + 1] = path.posix.join(modelRoot, modelId);
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function initCommand({
  configPath,
  modelRoot,
  recipeId,
  clientId,
  apply = false,
  integrate = false,
} = {}) {
  const args = ["switchyard", "init"];
  if (recipeId) args.push("--recipe", shellArg(recipeId));
  if (configPath) args.push("--config-out", shellArg(configPath));
  if (modelRoot) args.push("--model-root", shellArg(modelRoot));
  if (clientId && clientId !== "all") args.push("--client", shellArg(clientId));
  if (apply) args.push("--apply", "--yes");
  if (integrate) args.push("--integrate");
  return args.join(" ");
}

export function deriveUserConfig(config, recipe, {
  modelRoot,
  enableRecipeRuntimes = true,
  keepWarmRuntimeId,
} = {}) {
  const derived = stripRuntimeFields(config);
  const runtimeIds = recipeRuntimeIds(recipe);
  const keepWarm = keepWarmRuntimeId ?? defaultKeepWarmRuntime(derived, recipe);

  for (const recipeModel of recipe.models ?? []) {
    const runtimeId = recipeModel.runtime;
    if (!runtimeId || !derived.runtimes?.[runtimeId]) continue;
    if (enableRecipeRuntimes) derived.runtimes[runtimeId].enabled = true;
    retargetRuntimeModelArg(derived.runtimes[runtimeId], modelRoot, recipeModel.model);
  }

  derived.paths = {
    ...(derived.paths ?? {}),
    ...(modelRoot ? { modelRoot } : {}),
  };
  derived.keepWarm = keepWarm ? [keepWarm] : [];
  derived.init = {
    recipeId: recipe.id,
    generatedAt: new Date().toISOString(),
    enabledRuntimes: runtimeIds,
    keepWarmRuntime: keepWarm,
  };
  return derived;
}

async function selectRecipe({ recipeId, recipes, profile }) {
  if (recipeId) return loadRecipeById(recipeId);
  const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
  const selected = ranked.find(candidate => candidate.selectable);
  if (!selected) throw new Error("No selectable recipe for this machine");
  return recipes.find(recipe => recipe.id === selected.recipeId);
}

function integrationPlan(config, home, generatedRoot, clientId = "all") {
  const registry = createRegistry(config);
  const artifacts = buildIntegrationArtifacts(config, registry, { home, generatedRoot });
  const selected = selectIntegrationArtifacts(artifacts, clientId);
  if (!selected.length) throw new Error(`Unknown integration client ${clientId}`);
  return selected.map(artifact => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    mode: artifact.mode,
    generatedPath: artifact.generatedPath,
    targetPath: artifact.targetPath,
    notes: artifact.notes,
  }));
}

export async function createInitPlan(config, {
  recipeId,
  home = process.env.HOME,
  configPath,
  modelRoot,
  generatedRoot = defaultGeneratedRoot(home),
  clientId = "all",
  enableRecipeRuntimes = true,
  backendVariables = defaultBackendVariables(process.env),
} = {}) {
  const effectiveConfigPath = configPath ?? defaultUserConfigPath(home);
  const effectiveModelRoot = modelRoot ?? path.join(defaultHome(home), "models");
  const profile = await profileMachine();
  const recipes = await loadRecipes();
  const recipe = await selectRecipe({ recipeId, recipes, profile });
  const catalog = await loadBackendCatalog();
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);
  const userConfig = deriveUserConfig(config, recipe, {
    modelRoot: effectiveModelRoot,
    enableRecipeRuntimes,
  });

  return {
    dryRun: true,
    profile,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id,
    },
    configPath: effectiveConfigPath,
    modelRoot: effectiveModelRoot,
    enabledRuntimes: recipeRuntimeIds(recipe),
    keepWarm: userConfig.keepWarm,
    backend: await planBackend(backend, {
      variables: backendVariables,
      checkCommands: true,
    }),
    integrations: integrationPlan(userConfig, home, generatedRoot, clientId),
    next: {
      review: initCommand({
        recipeId: recipe.id,
        configPath: effectiveConfigPath,
        modelRoot: effectiveModelRoot,
        clientId,
      }),
      apply: initCommand({
        recipeId: recipe.id,
        configPath: effectiveConfigPath,
        modelRoot: effectiveModelRoot,
        clientId,
        apply: true,
      }),
      integrate: initCommand({
        recipeId: recipe.id,
        configPath: effectiveConfigPath,
        modelRoot: effectiveModelRoot,
        clientId,
        apply: true,
        integrate: true,
      }),
      bootstrap: `switchyard bootstrap --config ${shellArg(effectiveConfigPath)} --apply --yes`,
      serve: `switchyard serve --config ${shellArg(effectiveConfigPath)}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`,
    },
    config: userConfig,
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function applyInit(config, {
  dryRun = true,
  yes = false,
  integrate = false,
  ...options
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to initialize Switchyard without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }
  const plan = await createInitPlan(config, options);
  if (dryRun) return plan;

  await writeJson(plan.configPath, plan.config);
  const registry = createRegistry(plan.config);
  const generatedClients = await writeGeneratedIntegrationArtifacts(plan.config, registry, {
    clientId: options.clientId ?? "all",
    home: options.home ?? process.env.HOME,
    generatedRoot: options.generatedRoot ?? defaultGeneratedRoot(options.home ?? process.env.HOME),
  });
  const integrationResult = integrate
    ? await applyIntegrationArtifacts(plan.config, registry, {
      clientId: options.clientId ?? "all",
      dryRun: false,
      yes,
      home: options.home ?? process.env.HOME,
      generatedRoot: options.generatedRoot ?? defaultGeneratedRoot(options.home ?? process.env.HOME),
    })
    : { dryRun: true, results: plan.integrations.map(integration => ({ ...integration, status: "not-applied" })) };

  return {
    ...plan,
    dryRun: false,
    written: {
      configPath: plan.configPath,
      generatedClients,
      integrations: integrationResult,
    },
  };
}
