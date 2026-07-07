import { createBootstrapPlan, applyBootstrap } from "./bootstrap.mjs";
import { defaultBackendVariables } from "./backend-catalog.mjs";
import { createInitPlan, applyInit } from "./init.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function setupCommand({
  recipeId,
  configPath,
  modelRoot,
  clientId,
  apply = false,
  start = false,
} = {}) {
  const args = ["switchyard", "setup"];
  if (recipeId) args.push("--recipe", shellArg(recipeId));
  if (configPath) args.push("--config-out", shellArg(configPath));
  if (modelRoot) args.push("--model-root", shellArg(modelRoot));
  if (clientId && clientId !== "all") args.push("--client", shellArg(clientId));
  if (apply) args.push("--apply", "--yes");
  if (start) args.push("--start");
  return args.join(" ");
}

function configWithSource(config, sourcePath) {
  return {
    ...config,
    sourcePath,
  };
}

export async function createSetupPlan(config, {
  recipeId,
  configPath,
  modelRoot,
  clientId = "all",
  home = process.env.HOME,
  generatedRoot,
  backendVariables = defaultBackendVariables(process.env),
  benchmarksRoot,
} = {}) {
  const init = await createInitPlan(config, {
    recipeId,
    configPath,
    modelRoot,
    clientId,
    home,
    generatedRoot,
    backendVariables,
  });
  const plannedConfig = configWithSource(init.config, init.configPath);
  const bootstrap = await createBootstrapPlan(plannedConfig, {
    recipeId: init.selectedRecipe.id,
    modelRoot: init.modelRoot,
    clientId,
    home,
    generatedRoot,
    backendVariables,
    benchmarksRoot,
  });

  return {
    dryRun: true,
    selectedRecipe: init.selectedRecipe,
    configPath: init.configPath,
    modelRoot: init.modelRoot,
    keepWarm: init.keepWarm,
    phases: {
      init,
      bootstrap,
    },
    next: {
      apply: setupCommand({
        recipeId: init.selectedRecipe.id,
        configPath: init.configPath,
        modelRoot: init.modelRoot,
        clientId,
        apply: true,
      }),
      applyAndStart: setupCommand({
        recipeId: init.selectedRecipe.id,
        configPath: init.configPath,
        modelRoot: init.modelRoot,
        clientId,
        apply: true,
        start: true,
      }),
      serve: `switchyard serve --config ${shellArg(init.configPath)}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`,
    },
  };
}

export async function applySetup(config, {
  dryRun = true,
  yes = false,
  start = false,
  statePath,
  ...options
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to run setup without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }

  const plan = await createSetupPlan(config, options);
  if (dryRun) return plan;

  const init = await applyInit(config, {
    ...options,
    recipeId: plan.selectedRecipe.id,
    configPath: plan.configPath,
    modelRoot: plan.modelRoot,
    clientId: options.clientId ?? "all",
    dryRun: false,
    yes,
    integrate: false,
  });
  const appliedConfig = configWithSource(init.config, plan.configPath);
  const bootstrap = await applyBootstrap(appliedConfig, {
    recipeId: plan.selectedRecipe.id,
    modelRoot: plan.modelRoot,
    clientId: options.clientId ?? "all",
    home: options.home ?? process.env.HOME,
    generatedRoot: options.generatedRoot,
    backendVariables: options.backendVariables ?? defaultBackendVariables(process.env),
    ...(statePath ? { statePath } : {}),
    dryRun: false,
    yes,
  });
  const runtimeStart = start
    ? await new RuntimeManager(appliedConfig, {
      captureOutput: false,
    }).startKeepWarm()
    : null;

  return {
    ...plan,
    dryRun: false,
    phases: {
      init,
      bootstrap,
    },
    runtimeStart,
  };
}
