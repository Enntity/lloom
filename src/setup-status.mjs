import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  backendIds,
  defaultBackendVariables,
  getBackend,
  loadBackendCatalog,
  planBackend,
} from "./backend-catalog.mjs";
import {
  buildIntegrationArtifacts,
  selectIntegrationArtifacts,
} from "./client-integrations.mjs";
import { repoRoot } from "./config.mjs";
import { defaultGeneratedRoot as defaultUserGeneratedRoot } from "./init.mjs";
import { defaultInstallStatePath, readInstallState } from "./installer.mjs";
import { profileMachine, rankRecipes } from "./machine-profile.mjs";
import { createRegistry } from "./registry.mjs";
import { loadRecipeById, loadRecipes, planRecipe } from "./recipes.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function modelRootFor(config, modelRoot) {
  return modelRoot
    ?? config.paths?.modelRoot
    ?? process.env.SWITCHYARD_MODEL_ROOT
    ?? process.env.SWITCHYARD_MTPLX_MODEL_ROOT
    ?? path.join(repoRoot, "models");
}

async function selectRecipe({ recipeId, recipes, profile }) {
  if (recipeId) return loadRecipeById(recipeId);
  const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
  const selected = ranked.find(candidate => candidate.selectable);
  if (!selected) throw new Error("No selectable recipe for this machine");
  return recipes.find(recipe => recipe.id === selected.recipeId);
}

async function pathExecutable(filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function directoryStatus(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return {
      path: dirPath,
      exists: true,
      populated: entries.length > 0,
      entries: entries.length,
      status: entries.length > 0 ? "present" : "empty",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      path: dirPath,
      exists: false,
      populated: false,
      entries: 0,
      status: "missing",
    };
  }
}

async function fileMatchStatus(filePath, expectedContent) {
  if (!filePath) {
    return {
      path: null,
      exists: false,
      matchesExpected: false,
      status: "unavailable",
    };
  }
  try {
    const content = await fs.readFile(filePath, "utf8");
    const matchesExpected = content === expectedContent;
    return {
      path: filePath,
      exists: true,
      matchesExpected,
      status: matchesExpected ? "current" : "drifted",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      path: filePath,
      exists: false,
      matchesExpected: false,
      status: "missing",
    };
  }
}

function storedStep(state, stepId) {
  return asObject(state.steps)[stepId] ?? null;
}

function readyStatus(status) {
  return ["completed", "satisfied", "not-needed"].includes(status);
}

async function backendStepStatus(step, backendPlan, state) {
  const previous = storedStep(state, step.id);
  let status = previous?.status ?? "pending";
  let ready = readyStatus(status);
  let link = step.link ?? null;

  if (!previous && backendPlan.runnable) {
    status = "not-needed";
    ready = true;
  } else if (!previous && step.action === "link-command" && step.link?.target) {
    const targetExists = await pathExecutable(step.link.target);
    link = {
      ...step.link,
      targetExists,
    };
    if (targetExists) {
      status = "satisfied";
      ready = true;
    }
  }

  return {
    id: step.id,
    title: step.title,
    action: step.action,
    status,
    ready,
    command: previous?.command ?? step.command ?? null,
    link,
    startedAt: previous?.startedAt,
    completedAt: previous?.completedAt,
    reason: previous?.reason,
    message: previous?.message,
  };
}

async function recipeStepStatus(step, state) {
  const previous = storedStep(state, step.id);
  let status = previous?.status ?? "pending";
  let ready = readyStatus(status);
  let destination = null;

  if (step.action === "download-model" && step.destination) {
    destination = await directoryStatus(step.destination);
    if (!previous && destination.populated) {
      status = "satisfied";
      ready = true;
    }
  }

  return {
    id: step.id,
    title: step.title,
    action: step.action,
    status,
    ready,
    command: previous?.command ?? step.command ?? null,
    destination,
    startedAt: previous?.startedAt,
    completedAt: previous?.completedAt,
    reason: previous?.reason,
  };
}

async function recipeModelStatus(recipePlan, selectedModelRoot) {
  const downloads = new Map(recipePlan.steps
    .filter(step => step.action === "download-model" && step.model && step.destination)
    .map(step => [step.model, step.destination]));
  const models = [];
  for (const model of recipePlan.models) {
    const destination = downloads.get(model.model) ?? path.posix.join(selectedModelRoot, model.model);
    models.push({
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      runtime: model.runtime,
      destination: await directoryStatus(destination),
    });
  }
  return models;
}

async function integrationStatus(artifacts) {
  const results = [];
  for (const artifact of artifacts) {
    const target = await fileMatchStatus(artifact.targetPath, artifact.content);
    const generated = await fileMatchStatus(artifact.generatedPath, artifact.content);
    results.push({
      id: artifact.id,
      name: artifact.name,
      kind: artifact.kind,
      mode: artifact.mode,
      targetPath: artifact.targetPath,
      generatedPath: artifact.generatedPath,
      target,
      generated,
      current: artifact.targetPath ? target.matchesExpected : generated.matchesExpected,
      notes: artifact.notes,
    });
  }
  return results;
}

function commandLine(command, parts = []) {
  return [command, ...parts.filter(Boolean)].join(" ");
}

function nextCommands({
  backendId,
  recipeId,
  modelRoot,
  clientId,
  statePath,
  configPath,
  includeClient,
} = {}) {
  const common = [
    recipeId ? `--recipe ${shellArg(recipeId)}` : null,
    modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
    clientId && clientId !== "all" ? `--client ${shellArg(clientId)}` : null,
    statePath && statePath !== defaultInstallStatePath ? `--state ${shellArg(statePath)}` : null,
    configPath ? `--config ${shellArg(configPath)}` : null,
  ];
  return {
    review: commandLine("switchyard setup-status", common),
    setup: commandLine("switchyard setup", [
      recipeId ? `--recipe ${shellArg(recipeId)}` : null,
      modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
      includeClient && clientId && clientId !== "all" ? `--client ${shellArg(clientId)}` : null,
      "--apply --yes",
    ]),
    backendInstall: `switchyard backend-install ${backendId ?? "<selected-backend-id>"} --apply --yes`,
    recipeInstall: commandLine(`switchyard install ${recipeId ?? "<selected-recipe-id>"}`, [
      modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
      "--apply --yes",
    ]),
    integrate: commandLine("switchyard integrate", [
      clientId ?? "all",
      "--apply --yes",
    ]),
    keepWarm: "switchyard keep-warm",
  };
}

export async function createSetupStatus(config, {
  recipeId,
  modelRoot,
  clientId = "all",
  home = process.env.HOME,
  generatedRoot = defaultUserGeneratedRoot(home),
  statePath = defaultInstallStatePath,
  backendVariables = defaultBackendVariables(process.env),
  includeRuntimes = true,
} = {}) {
  const profile = await profileMachine();
  const recipes = await loadRecipes();
  const recipe = await selectRecipe({ recipeId, recipes, profile });
  const catalog = await loadBackendCatalog();
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);

  const selectedModelRoot = modelRootFor(config, modelRoot);
  const installState = await readInstallState(statePath);
  const backendPlan = await planBackend(backend, {
    variables: backendVariables,
    checkCommands: true,
  });
  const recipePlan = planRecipe(recipe, config, {
    modelRoot: selectedModelRoot,
    backendIds: backendIds(catalog),
  });
  const backendState = asObject(installState.backends)[backend.id] ?? {};
  const recipeState = asObject(installState.recipes)[recipe.id] ?? {};
  const backendSteps = [];
  for (const step of backendPlan.steps) {
    backendSteps.push(await backendStepStatus(step, backendPlan, backendState));
  }
  const recipeSteps = [];
  for (const step of recipePlan.steps) {
    recipeSteps.push(await recipeStepStatus(step, recipeState));
  }

  const registry = createRegistry(config);
  const artifacts = selectIntegrationArtifacts(buildIntegrationArtifacts(config, registry, {
    home,
    generatedRoot,
  }), clientId);
  if (!artifacts.length) throw new Error(`Unknown integration client ${clientId}`);
  const integrations = await integrationStatus(artifacts);

  const runtimes = includeRuntimes
    ? await new RuntimeManager(config, { logger: { error() {} } }).status()
    : null;
  const keepWarm = new Set(config.keepWarm ?? []);
  const keepWarmRuntimeStatus = runtimes
    ? Object.fromEntries(Object.entries(runtimes.runtimes)
      .filter(([runtimeId]) => keepWarm.has(runtimeId)))
    : null;
  const backendReady = backendPlan.runnable || backendSteps.every(step => step.ready);
  const recipeReady = recipePlan.platformSupported
    && recipePlan.validationErrors.length === 0
    && recipeSteps.every(step => step.ready);
  const integrationsReady = integrations.every(integration => integration.current);
  const runtimesReady = keepWarmRuntimeStatus
    ? Object.values(keepWarmRuntimeStatus).every(runtime => runtime.healthy)
    : null;
  const valid = recipePlan.platformSupported
    && recipePlan.validationErrors.length === 0
    && backendPlan.platformSupported;

  return {
    ok: valid,
    complete: backendReady
      && recipeReady
      && integrationsReady
      && (runtimesReady ?? true),
    config: config.sourcePath,
    statePath,
    profile,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id,
    },
    modelRoot: selectedModelRoot,
    backend: {
      ...backendPlan,
      ready: backendReady,
      steps: backendSteps,
    },
    recipe: {
      ...recipePlan,
      ready: recipeReady,
      steps: recipeSteps,
      models: await recipeModelStatus(recipePlan, selectedModelRoot),
    },
    integrations: {
      ready: integrationsReady,
      clientId,
      data: integrations,
    },
    runtimes: runtimes ? {
      ready: runtimesReady,
      keepWarm: keepWarmRuntimeStatus,
      events: runtimes.events,
    } : null,
    next: nextCommands({
      backendId: backend.id,
      recipeId: recipe.id,
      modelRoot: selectedModelRoot,
      clientId,
      statePath,
      configPath: config.sourcePath,
      includeClient: true,
    }),
  };
}
