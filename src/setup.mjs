import { createBootstrapPlan, applyBootstrap } from './bootstrap.mjs';
import { defaultBackendVariables } from './backend-catalog.mjs';
import { createInitPlan, applyInit } from './init.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { runCommand } from './process-control.mjs';

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function customHomeArg(home) {
  return home && home !== process.env.HOME ? ['--home', shellArg(home)] : [];
}

function setupCommand({
  recipeId,
  configPath,
  modelRoot,
  gatewayPort,
  backendPortRange,
  clientId,
  home,
  generatedRoot,
  statePath,
  recipesRoot,
  benchmarksRoot,
  backendCatalogPath,
  additive = false,
  restoreCatalog = false,
  apply = false,
  start = false
} = {}) {
  const args = ['lloom', 'setup'];
  if (recipeId) args.push('--recipe', shellArg(recipeId));
  args.push(...customHomeArg(home));
  if (generatedRoot) args.push('--generated-root', shellArg(generatedRoot));
  if (statePath) args.push('--state', shellArg(statePath));
  if (configPath) args.push('--config-out', shellArg(configPath));
  if (modelRoot) args.push('--model-root', shellArg(modelRoot));
  if (gatewayPort) args.push('--port', shellArg(gatewayPort));
  if (backendPortRange) args.push('--backend-port-range', shellArg(backendPortRange));
  if (recipesRoot) args.push('--recipes-root', shellArg(recipesRoot));
  if (benchmarksRoot) args.push('--benchmarks-root', shellArg(benchmarksRoot));
  if (backendCatalogPath) args.push('--backend-catalog', shellArg(backendCatalogPath));
  if (clientId && clientId !== 'all') args.push('--client', shellArg(clientId));
  if (additive) args.push('--additive');
  if (restoreCatalog) args.push('--restore-catalog');
  if (apply) args.push('--apply', '--yes');
  if (start) args.push('--start');
  return args.join(' ');
}

function configWithSource(config, sourcePath) {
  return {
    ...config,
    sourcePath
  };
}

export async function createSetupPlan(
  config,
  {
    recipeId,
    configPath,
    modelRoot,
    gatewayPort,
    backendPortRange,
    clientId = 'all',
    home = process.env.HOME,
    generatedRoot,
    backendVariables = defaultBackendVariables(process.env),
    benchmarksRoot,
    benchmarkDocuments = [],
    recipesRoot,
    recipeDocuments = [],
    backendCatalogPath,
    statePath,
    autoDetectModelRoot,
    additive = false,
    restoreCatalog = false
  } = {}
) {
  const init = await createInitPlan(config, {
    recipeId,
    configPath,
    modelRoot,
    gatewayPort,
    backendPortRange,
    clientId,
    home,
    generatedRoot,
    backendVariables,
    benchmarksRoot,
    recipesRoot,
    recipeDocuments,
    backendCatalogPath,
    autoDetectModelRoot,
    additive,
    restoreCatalog
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
    benchmarkDocuments,
    recipesRoot,
    recipeDocuments,
    backendCatalogPath
  });

  return {
    dryRun: true,
    selectedRecipe: init.selectedRecipe,
    configPath: init.configPath,
    modelRoot: init.modelRoot,
    modelRootDetected: init.modelRootDetected,
    modelRootCandidates: init.modelRootCandidates,
    ports: init.ports,
    keepWarm: init.keepWarm,
    phases: {
      init,
      bootstrap
    },
    next: {
      apply: setupCommand({
        recipeId: init.selectedRecipe.id,
        configPath: init.configPath,
        modelRoot: init.modelRoot,
        gatewayPort,
        backendPortRange,
        home,
        generatedRoot,
        statePath,
        recipesRoot,
        benchmarksRoot,
        backendCatalogPath,
        clientId,
        additive,
        restoreCatalog,
        apply: true
      }),
      applyAndStart: setupCommand({
        recipeId: init.selectedRecipe.id,
        configPath: init.configPath,
        modelRoot: init.modelRoot,
        gatewayPort,
        backendPortRange,
        home,
        generatedRoot,
        statePath,
        recipesRoot,
        benchmarksRoot,
        backendCatalogPath,
        clientId,
        additive,
        restoreCatalog,
        apply: true,
        start: true
      }),
      serve: `lloom serve --config ${shellArg(init.configPath)}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`
    }
  };
}

export async function applySetup(
  config,
  {
    dryRun = true,
    yes = false,
    start = false,
    startKeepWarm,
    afterApply,
    statePath,
    onProgress,
    stdio,
    ...options
  } = {}
) {
  if (!dryRun && !yes) {
    throw new Error('Refusing to run setup without yes=true. Re-run with --yes after reviewing the dry-run plan.');
  }

  const plan = await createSetupPlan(config, options);
  if (dryRun) return plan;

  const init = await applyInit(config, {
    ...options,
    recipeId: plan.selectedRecipe.id,
    configPath: plan.configPath,
    modelRoot: plan.modelRoot,
    clientId: options.clientId ?? 'all',
    dryRun: false,
    yes,
    integrate: false
  });
  const appliedConfig = configWithSource(init.config, plan.configPath);
  const bootstrap = await applyBootstrap(appliedConfig, {
    recipeId: plan.selectedRecipe.id,
    modelRoot: plan.modelRoot,
    clientId: options.clientId ?? 'all',
    home: options.home ?? process.env.HOME,
    generatedRoot: options.generatedRoot,
    backendVariables: options.backendVariables ?? defaultBackendVariables(process.env),
    benchmarkDocuments: options.benchmarkDocuments,
    recipesRoot: options.recipesRoot,
    recipeDocuments: options.recipeDocuments,
    backendCatalogPath: options.backendCatalogPath,
    onProgress,
    stdio,
    ...(statePath ? { statePath } : {}),
    dryRun: false,
    yes
  });
  const clusterSync = bootstrap.ok && typeof afterApply === 'function' ? await afterApply(appliedConfig, plan) : null;
  const runtimeStart =
    start && bootstrap.ok
      ? typeof startKeepWarm === 'function'
        ? await startKeepWarm(appliedConfig)
        : await new RuntimeManager(appliedConfig, {
            captureOutput: false
          }).startKeepWarm()
      : null;

  return {
    ...plan,
    dryRun: false,
    ok: bootstrap.ok,
    status: bootstrap.ok ? (runtimeStart ? 'started' : 'applied') : bootstrap.status,
    phases: {
      init,
      bootstrap,
      ...(clusterSync ? { clusterSync } : {})
    },
    runtimeStart
  };
}

export async function syncClusterSetupMembers(
  config,
  {
    coordinator,
    recipeId,
    additive = false,
    restoreCatalog = false,
    clientId = 'all',
    modelRoot,
    generatedRoot,
    statePath,
    recipesRoot,
    benchmarksRoot,
    backendCatalogPath,
    timeoutMs = 1_800_000
  } = {}
) {
  if (!coordinator || coordinator.nodeId !== config.cluster?.leaderNode) return { synced: [], skipped: true };
  const remoteNodeIds = [
    ...new Set(
      Object.values(config.runtimes ?? {})
        .filter((runtime) => runtime?.recipe?.id === recipeId && runtime?.placement?.mode === 'distributed')
        .flatMap((runtime) => runtime.placement.members ?? [])
        .map((member) => member?.node)
        .filter((nodeId) => nodeId && !coordinator.isLocalNode(nodeId))
    )
  ];
  const synced = [];
  for (const nodeId of remoteNodeIds) {
    const body = {
      recipeId,
      additive,
      restoreCatalog,
      clientId,
      yes: true,
      start: false,
      ...(modelRoot ? { modelRoot } : {}),
      ...(generatedRoot ? { generatedRoot } : {}),
      ...(statePath ? { statePath } : {}),
      ...(recipesRoot ? { recipesRoot } : {}),
      ...(benchmarksRoot ? { benchmarksRoot } : {}),
      ...(backendCatalogPath ? { backendCatalogPath } : {})
    };
    const node = coordinator.nodes[nodeId];
    let result;
    if (node?.sshAlias) {
      const remoteCommand = `PATH="$HOME/.local/bin:/usr/bin:/bin" ${setupCommand({
        recipeId,
        modelRoot,
        clientId,
        generatedRoot,
        statePath,
        recipesRoot,
        benchmarksRoot,
        backendCatalogPath,
        additive,
        restoreCatalog,
        apply: true,
        start: false
      })} --json`;
      const executed = await runCommand('ssh', [node.sshAlias, remoteCommand]);
      try {
        result = JSON.parse(executed.stdout);
      } catch {
        throw new Error(`cluster setup on ${nodeId} returned invalid JSON: ${executed.stdout || executed.stderr}`);
      }
    } else {
      result = await coordinator.requestNode(nodeId, '/gateway/setup/apply', {
        method: 'POST',
        timeoutMs,
        body
      });
    }
    if (result?.ok === false) throw new Error(`cluster setup failed on ${nodeId}`);
    synced.push({ nodeId, ok: result?.ok !== false, status: result?.status ?? 'applied' });
  }
  return { synced, skipped: false };
}
