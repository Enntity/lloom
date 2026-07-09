import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  backendIds,
  defaultBackendVariables,
  getBackend,
  loadBackendCatalog,
  planBackend
} from './backend-catalog.mjs';
import { createClientIntegrationStatus } from './client-integrations.mjs';
import { defaultUserModelRoot } from './config.mjs';
import { defaultGeneratedRoot as defaultUserGeneratedRoot } from './init.mjs';
import { defaultInstallStatePath, defaultInstallStatePathFor, readInstallState } from './installer.mjs';
import { profileMachine, rankRecipes } from './machine-profile.mjs';
import { modelDirectoryStatus } from './model-files.mjs';
import { createRegistry } from './registry.mjs';
import { loadRecipeById, loadRecipes, planRecipe } from './recipes.mjs';
import { RuntimeManager } from './runtime-manager.mjs';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function modelRootFor(config, modelRoot) {
  return (
    modelRoot ??
    config.paths?.modelRoot ??
    process.env.LLOOM_MODEL_ROOT ??
    process.env.LLOOM_MTPLX_MODEL_ROOT ??
    defaultUserModelRoot()
  );
}

async function selectRecipe({ recipeId, recipes, profile, recipesRoot }) {
  if (recipeId) {
    return recipes.find((candidate) => candidate.id === recipeId) ?? loadRecipeById(recipeId, recipesRoot);
  }
  const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
  const selected = ranked.find((candidate) => candidate.selectable);
  if (!selected) throw new Error('No selectable recipe for this machine');
  return recipes.find((recipe) => recipe.id === selected.recipeId);
}

async function pathExecutable(filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function storedStep(state, stepId) {
  return asObject(state.steps)[stepId] ?? null;
}

function readyStatus(status) {
  return ['completed', 'satisfied', 'not-needed'].includes(status);
}

function pythonExecutableForVenv(venvPath) {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

async function pathStatus(filePath) {
  try {
    await fs.access(filePath);
    return {
      path: filePath,
      exists: true,
      status: 'present'
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      path: filePath,
      exists: false,
      status: 'missing'
    };
  }
}

async function backendStepArtifactStatus(step) {
  if (step.action === 'link-command' && step.link?.target) {
    const targetExists = await pathExecutable(step.link.target);
    const sourceExists = step.link.source ? await pathExecutable(step.link.source) : false;
    return {
      satisfied: targetExists && sourceExists,
      link: {
        ...step.link,
        targetExists,
        sourceExists
      }
    };
  }

  if (step.action === 'python-venv' || step.action === 'pip-install') {
    const venvPath = step.path ?? step.venv;
    const pythonPath = venvPath ? pythonExecutableForVenv(venvPath) : null;
    return {
      satisfied: pythonPath ? await pathExecutable(pythonPath) : null,
      venv: pythonPath
        ? {
            path: venvPath,
            python: pythonPath,
            exists: await pathExecutable(pythonPath)
          }
        : null
    };
  }

  if (step.action === 'git-clone' && step.destination) {
    const gitPath = path.join(step.destination, '.git');
    const status = await pathStatus(gitPath);
    return {
      satisfied: status.exists,
      repository: {
        path: step.destination,
        gitPath,
        exists: status.exists
      }
    };
  }

  if ((step.action === 'cmake-configure' || step.action === 'cmake-build') && step.build) {
    const status = await pathStatus(step.build);
    return {
      satisfied: status.exists,
      build: status
    };
  }

  if (step.skip?.skip) {
    return {
      satisfied: true,
      skip: step.skip
    };
  }

  return {
    satisfied: null
  };
}

async function backendStepStatus(step, backendPlan, state) {
  const previous = storedStep(state, step.id);
  let status = previous?.status ?? 'pending';
  let ready = readyStatus(status);
  let link = step.link ?? null;
  const artifact = await backendStepArtifactStatus(step);
  if (artifact.link) link = artifact.link;

  if (previous?.status === 'completed' && artifact.satisfied === false) {
    status = 'pending';
    ready = false;
  } else if (!ready && artifact.satisfied === true) {
    status = 'satisfied';
    ready = true;
  } else if (!previous && backendPlan.runnable) {
    status = 'not-needed';
    ready = true;
  }

  return {
    id: step.id,
    title: step.title,
    action: step.action,
    status,
    ready,
    command: step.command ?? previous?.command ?? null,
    link,
    artifact,
    startedAt: previous?.startedAt,
    completedAt: previous?.completedAt,
    reason:
      previous?.status === 'completed' && artifact.satisfied === false
        ? 'state-artifact-missing-for-current-backend'
        : previous?.reason,
    message: previous?.message
  };
}

async function recipeStepStatus(step, state) {
  const previous = storedStep(state, step.id);
  let status = previous?.status ?? 'pending';
  let ready = readyStatus(status);
  let destination = null;
  let skipPath = null;
  let currentArtifactSatisfied = null;

  if (step.action === 'download-model' && step.destination) {
    destination = await modelDirectoryStatus(step.destination);
    currentArtifactSatisfied = destination.populated;
  } else if (step.skipIfPathExists) {
    skipPath = await pathStatus(step.skipIfPathExists);
    currentArtifactSatisfied = skipPath.exists;
  }

  if (currentArtifactSatisfied != null) {
    if (status === 'completed' && !currentArtifactSatisfied) {
      status = 'pending';
      ready = false;
    } else if (!ready && currentArtifactSatisfied) {
      status = 'satisfied';
      ready = true;
    }
  }

  return {
    id: step.id,
    title: step.title,
    action: step.action,
    status,
    ready,
    command: step.command ?? previous?.command ?? null,
    destination,
    skipPath,
    startedAt: previous?.startedAt,
    completedAt: previous?.completedAt,
    reason:
      previous?.status === 'completed' && currentArtifactSatisfied === false
        ? 'state-artifact-missing-for-current-root'
        : previous?.reason
  };
}

async function recipeModelStatus(recipePlan, selectedModelRoot) {
  const downloads = new Map(
    recipePlan.steps
      .filter((step) => step.action === 'download-model' && step.model && step.destination)
      .map((step) => [step.model, step.destination])
  );
  const models = [];
  for (const model of recipePlan.models) {
    const destination = downloads.get(model.model) ?? path.posix.join(selectedModelRoot, model.model);
    models.push({
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      runtime: model.runtime,
      destination: await modelDirectoryStatus(destination)
    });
  }
  return models;
}

function commandLine(command, parts = []) {
  return [command, ...parts.filter(Boolean)].join(' ');
}

function customHomeArg(home) {
  return home && home !== process.env.HOME ? `--home ${shellArg(home)}` : null;
}

function nextCommands({
  backendId,
  recipeId,
  modelRoot,
  clientId,
  statePath,
  configPath,
  home,
  generatedRoot,
  recipesRoot,
  backendCatalogPath,
  includeClient
} = {}) {
  const common = [
    recipeId ? `--recipe ${shellArg(recipeId)}` : null,
    modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
    clientId && clientId !== 'all' ? `--client ${shellArg(clientId)}` : null,
    customHomeArg(home),
    generatedRoot ? `--generated-root ${shellArg(generatedRoot)}` : null,
    statePath && statePath !== defaultInstallStatePath ? `--state ${shellArg(statePath)}` : null,
    recipesRoot ? `--recipes-root ${shellArg(recipesRoot)}` : null,
    backendCatalogPath ? `--backend-catalog ${shellArg(backendCatalogPath)}` : null,
    configPath ? `--config ${shellArg(configPath)}` : null
  ];
  return {
    review: commandLine('lloom setup-status', common),
    setup: commandLine('lloom setup', [
      recipeId ? `--recipe ${shellArg(recipeId)}` : null,
      modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
      customHomeArg(home),
      generatedRoot ? `--generated-root ${shellArg(generatedRoot)}` : null,
      statePath && statePath !== defaultInstallStatePath ? `--state ${shellArg(statePath)}` : null,
      configPath ? `--config-out ${shellArg(configPath)}` : null,
      recipesRoot ? `--recipes-root ${shellArg(recipesRoot)}` : null,
      backendCatalogPath ? `--backend-catalog ${shellArg(backendCatalogPath)}` : null,
      includeClient && clientId && clientId !== 'all' ? `--client ${shellArg(clientId)}` : null,
      '--apply --yes'
    ]),
    backendInstall: `lloom backend-install ${backendId ?? '<selected-backend-id>'} --apply --yes`,
    recipeInstall: commandLine(`lloom install ${recipeId ?? '<selected-recipe-id>'}`, [
      modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
      recipesRoot ? `--recipes-root ${shellArg(recipesRoot)}` : null,
      '--apply --yes'
    ]),
    integrate: commandLine('lloom integrate', [
      clientId ?? 'all',
      customHomeArg(home),
      generatedRoot ? `--generated-root ${shellArg(generatedRoot)}` : null,
      '--apply --yes'
    ]),
    keepWarm: 'lloom keep-warm'
  };
}

export async function createSetupStatus(
  config,
  {
    recipeId,
    modelRoot,
    clientId = 'all',
    home = process.env.HOME,
    generatedRoot = defaultUserGeneratedRoot(home),
    backendVariables = defaultBackendVariables(process.env),
    includeRuntimes = true,
    recipesRoot,
    recipeDocuments = [],
    backendCatalogPath,
    statePath = defaultInstallStatePathFor({ ...process.env, HOME: home })
  } = {}
) {
  const profile = await profileMachine();
  const selectedRecipeId = recipeId ?? config.init?.recipeId;
  const selectedRecipesRoot = recipesRoot ?? config.init?.recipesRoot;
  const selectedBackendCatalogPath = backendCatalogPath ?? config.init?.backendCatalogPath;
  const recipes = [...recipeDocuments, ...(await loadRecipes(selectedRecipesRoot))];
  const recipe = await selectRecipe({ recipeId: selectedRecipeId, recipes, profile, recipesRoot: selectedRecipesRoot });
  const catalog = await loadBackendCatalog(selectedBackendCatalogPath);
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);

  const selectedModelRoot = modelRootFor(config, modelRoot);
  const installState = await readInstallState(statePath);
  const backendPlan = await planBackend(backend, {
    variables: backendVariables,
    checkCommands: true
  });
  const recipePlan = planRecipe(recipe, config, {
    modelRoot: selectedModelRoot,
    backendIds: backendIds(catalog)
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
  const integrationReport = await createClientIntegrationStatus(config, registry, {
    clientId,
    home,
    generatedRoot
  });
  const integrations = integrationReport.data;

  const runtimes = includeRuntimes ? await new RuntimeManager(config, { logger: { error() {} } }).status() : null;
  const keepWarm = new Set(config.keepWarm ?? []);
  const keepWarmRuntimeStatus = runtimes
    ? Object.fromEntries(Object.entries(runtimes.runtimes).filter(([runtimeId]) => keepWarm.has(runtimeId)))
    : null;
  const backendReady = backendPlan.runnable || backendSteps.every((step) => step.ready);
  const recipeReady =
    recipePlan.platformSupported && recipePlan.validationErrors.length === 0 && recipeSteps.every((step) => step.ready);
  const integrationsReady = integrations.every((integration) => integration.current);
  const runtimesReady = keepWarmRuntimeStatus
    ? Object.values(keepWarmRuntimeStatus).every((runtime) => runtime.healthy)
    : null;
  const valid =
    recipePlan.platformSupported && recipePlan.validationErrors.length === 0 && backendPlan.platformSupported;

  return {
    ok: valid,
    complete: backendReady && recipeReady && integrationsReady && (runtimesReady ?? true),
    config: config.sourcePath,
    statePath,
    profile,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id
    },
    modelRoot: selectedModelRoot,
    backend: {
      ...backendPlan,
      ready: backendReady,
      steps: backendSteps
    },
    recipe: {
      ...recipePlan,
      ready: recipeReady,
      steps: recipeSteps,
      models: await recipeModelStatus(recipePlan, selectedModelRoot)
    },
    integrations: {
      ready: integrationsReady,
      clientId,
      summary: integrationReport.summary,
      data: integrations
    },
    runtimes: runtimes
      ? {
          ready: runtimesReady,
          keepWarm: keepWarmRuntimeStatus,
          events: runtimes.events
        }
      : null,
    next: nextCommands({
      backendId: backend.id,
      recipeId: recipe.id,
      modelRoot: selectedModelRoot,
      clientId,
      statePath,
      configPath: config.sourcePath,
      home,
      generatedRoot,
      recipesRoot: selectedRecipesRoot,
      backendCatalogPath: selectedBackendCatalogPath,
      includeClient: true
    })
  };
}
