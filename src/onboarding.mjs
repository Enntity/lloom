import path from 'node:path';
import { defaultBackendVariables } from './backend-catalog.mjs';
import { applyCommunityRecommendations, createCommunityPlan } from './community-client.mjs';
import { createDoctorReport } from './doctor.mjs';
import { applySetup, createSetupPlan } from './setup.mjs';

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandLine(command, parts = []) {
  return [command, ...parts.filter(Boolean)].join(' ');
}

function customHomeArg(home) {
  return home && home !== process.env.HOME ? `--home ${shellArg(home)}` : null;
}

function onboardCommand({
  recipeId,
  configPath,
  modelRoot,
  gatewayPort,
  backendPortRange,
  backendCatalogPath,
  clientId,
  hostUrl,
  recipeFeedPath,
  signingKeysPath,
  trustHostKeys,
  indexPath,
  recipesRoot,
  benchmarksRoot,
  workloads,
  capabilities,
  tags,
  limit,
  requireSignature,
  offline,
  home,
  generatedRoot,
  statePath,
  apply = false,
  start = false
} = {}) {
  return commandLine('lloom onboard', [
    recipeId ? `--recipe ${shellArg(recipeId)}` : null,
    hostUrl ? `--host ${shellArg(hostUrl)}` : null,
    recipeFeedPath ? `--recipe-feed-path ${shellArg(recipeFeedPath)}` : null,
    signingKeysPath ? `--signing-keys-path ${shellArg(signingKeysPath)}` : null,
    trustHostKeys === false ? '--no-trust-host-keys' : null,
    indexPath ? `--index ${shellArg(indexPath)}` : null,
    recipesRoot ? `--recipes-root ${shellArg(recipesRoot)}` : null,
    benchmarksRoot ? `--benchmarks-root ${shellArg(benchmarksRoot)}` : null,
    ...(Array.isArray(workloads) ? workloads : []).map((workload) => `--workload ${shellArg(workload)}`),
    ...(Array.isArray(capabilities) ? capabilities : []).map((capability) => `--capability ${shellArg(capability)}`),
    ...(Array.isArray(tags) ? tags : []).map((tag) => `--tag ${shellArg(tag)}`),
    limit ? `--limit ${shellArg(limit)}` : null,
    requireSignature === true ? '--require-signature' : null,
    requireSignature === false ? '--no-require-signature' : null,
    offline ? '--offline' : null,
    customHomeArg(home),
    generatedRoot ? `--generated-root ${shellArg(generatedRoot)}` : null,
    statePath ? `--state ${shellArg(statePath)}` : null,
    configPath ? `--config-out ${shellArg(configPath)}` : null,
    modelRoot ? `--model-root ${shellArg(modelRoot)}` : null,
    gatewayPort ? `--port ${shellArg(gatewayPort)}` : null,
    backendPortRange ? `--backend-port-range ${shellArg(backendPortRange)}` : null,
    backendCatalogPath ? `--backend-catalog ${shellArg(backendCatalogPath)}` : null,
    clientId && clientId !== 'all' ? `--client ${shellArg(clientId)}` : null,
    apply ? '--apply --yes' : null,
    start ? '--start' : null
  ]);
}

function configWithSource(config, sourcePath) {
  return {
    ...config,
    sourcePath
  };
}

function phaseById(doctor, id) {
  return doctor.phases.find((phase) => phase.id === id) ?? null;
}

function communityEnabled(config, options = {}) {
  if (options.recipeId) return false;
  if (options.offline) return false;
  return Boolean(options.hostUrl ?? config.community?.hostUrl);
}

function communitySetupBaseConfig(config) {
  const next = structuredClone(config);
  next.defaults = {};
  next.backends = {};
  next.runtimes = {};
  next.models = [];
  next.aliases = {};
  for (const runtime of Object.values(next.runtimes ?? {})) runtime.keepWarm = false;
  delete next.keepWarm;
  next.clientCatalog = {
    providerId: config.clientCatalog?.providerId ?? 'local-llm',
    providerName: config.clientCatalog?.providerName ?? config.providers?.['local-llm']?.name ?? 'LLooM Local',
    includeAliases: false,
    modelOrder: []
  };
  return next;
}

function defaultLloomHome(home = process.env.HOME) {
  return home ? path.join(home, '.lloom') : path.resolve('.lloom');
}

function communityCachePaths(home, { indexPath, recipesRoot, benchmarksRoot } = {}) {
  const root = path.join(defaultLloomHome(home), 'community');
  const selectedRecipesRoot = recipesRoot ?? path.join(root, 'recipes');
  return {
    indexPath: indexPath ?? path.join(selectedRecipesRoot, 'index.json'),
    recipesRoot: selectedRecipesRoot,
    benchmarksRoot: benchmarksRoot ?? path.join(root, 'benchmarks')
  };
}

function firstRecipeAction(plan) {
  for (const entry of plan?.plans ?? []) {
    const action = entry?.plan?.actions?.find((candidate) => candidate.type === 'recipe' && candidate.id);
    if (action) return action;
  }
  return null;
}

function selectedRecipeIdFromCommunity(plan) {
  return firstRecipeAction(plan)?.id ?? null;
}

function recipeDocumentsFromCommunity(plan) {
  return (plan?.plans ?? [])
    .flatMap((entry) => entry?.plan?.recipes ?? [])
    .map((entry) => entry.recipe)
    .filter(Boolean);
}

function benchmarkDocumentsFromCommunity(plan) {
  return (plan?.plans ?? [])
    .flatMap((entry) => entry?.plan?.recipes ?? [])
    .flatMap((entry) => entry.benchmarks ?? [])
    .filter(Boolean);
}

function onboardingCommandOptions({
  community,
  setup,
  hostUrl,
  recipeFeedPath,
  signingKeysPath,
  trustHostKeys,
  indexPath,
  recipesRoot,
  benchmarksRoot,
  workloads,
  capabilities,
  tags,
  limit,
  requireSignature,
  offline,
  configPath,
  modelRoot,
  home,
  generatedRoot,
  statePath,
  gatewayPort,
  backendPortRange,
  backendCatalogPath,
  clientId
}) {
  return {
    recipeId: community ? undefined : setup.selectedRecipe.id,
    hostUrl: community?.host?.url ?? hostUrl,
    recipeFeedPath: community?.host?.recipeFeedPath ?? recipeFeedPath,
    signingKeysPath,
    trustHostKeys,
    indexPath,
    recipesRoot,
    benchmarksRoot,
    workloads: community?.request?.workloads ?? workloads,
    capabilities: community?.request?.capabilities ?? capabilities,
    tags: community?.request?.tags ?? tags,
    limit: community?.selectedCount ?? limit,
    requireSignature: community?.requireSignature ?? requireSignature,
    offline,
    configPath,
    modelRoot,
    home,
    generatedRoot,
    statePath,
    gatewayPort,
    backendPortRange,
    backendCatalogPath,
    clientId
  };
}

function communitySummary(community) {
  if (!community) return null;
  const recipeId = selectedRecipeIdFromCommunity(community);
  const host = community.host?.url ?? 'community host';
  if (!community.ok) {
    return `Community recommendation from ${host} has ${community.validationErrors?.length ?? 0} validation error(s)`;
  }
  return recipeId
    ? `Selected ${recipeId} from ${host}`
    : `Loaded ${community.selectedCount ?? 0} recommendation(s) from ${host}`;
}

function phaseStage(doctor, id, fallback) {
  const current = phaseById(doctor, id);
  if (!current) return fallback;
  return {
    id,
    title: current.title,
    status: current.status,
    ready: current.ready,
    summary: current.summary,
    actions: current.actions,
    blockers: current.blockers,
    warnings: current.warnings
  };
}

function buildStages({ setup, doctor, dryRun, start, includeRuntimes, community, applyCommand, applyAndStartCommand }) {
  const setupOk = setup.ok !== false;
  const communityDryRun = Boolean(community && dryRun);
  const applyOnboardingAction = {
    id: 'apply-community-onboarding',
    label: 'Import recommendation and continue setup',
    command: start ? applyAndStartCommand : applyCommand
  };
  const applySetupAction = {
    id: 'apply-onboarding',
    label: 'Apply onboarding plan',
    command: start ? applyAndStartCommand : applyCommand
  };
  const communityDeferredStage = (stage) => {
    if (!communityDryRun || !Array.isArray(stage.actions) || !stage.actions.length) return stage;
    return {
      ...stage,
      actions: [applyOnboardingAction]
    };
  };
  const runtimeStage = () => {
    if (dryRun) {
      return {
        id: 'runtimes',
        title: 'Keep-Warm Runtimes',
        status: start ? 'planned' : 'skipped',
        ready: null,
        summary: start
          ? 'Keep-warm runtimes will start after setup applies'
          : 'Runtime startup waits until setup applies; pass --start to warm keep-warm runtimes',
        actions: [
          {
            id: 'apply-and-start',
            label: 'Apply setup and start keep-warm runtimes',
            command: applyAndStartCommand
          }
        ],
        blockers: [],
        warnings: []
      };
    }
    if (start || includeRuntimes) {
      return communityDeferredStage(
        phaseStage(doctor, 'runtimes', {
          id: 'runtimes',
          title: 'Keep-Warm Runtimes',
          status: 'pending',
          ready: false,
          summary: 'Runtime readiness not available',
          actions: [],
          blockers: [],
          warnings: []
        })
      );
    }
    return {
      id: 'runtimes',
      title: 'Keep-Warm Runtimes',
      status: 'skipped',
      ready: null,
      summary: 'Runtime startup is optional; pass --start to start keep-warm runtimes',
      actions: [
        {
          id: 'apply-and-start',
          label: 'Apply setup and start keep-warm runtimes',
          command: applyAndStartCommand
        }
      ],
      blockers: [],
      warnings: []
    };
  };
  const stages = [
    {
      id: 'inspect',
      title: 'Inspect Machine',
      status: 'ready',
      ready: true,
      summary: `Detected ${doctor.profile?.platformId ?? setup.phases.bootstrap.profile?.platformId ?? 'current machine'}`,
      actions: [],
      blockers: [],
      warnings: []
    },
    ...(community
      ? [
          {
            id: 'community',
            title: 'Community Recipe',
            status: community.ok ? (dryRun ? 'planned' : 'ready') : 'blocked',
            ready: dryRun ? null : community.ok,
            summary: communitySummary(community),
            actions: dryRun ? [applyOnboardingAction] : [],
            blockers: community.validationErrors ?? [],
            warnings: []
          }
        ]
      : []),
    {
      id: 'configure',
      title: 'Write LLooM Config',
      status: dryRun ? 'planned' : 'ready',
      ready: !dryRun,
      summary: dryRun ? `Will write user config to ${setup.configPath}` : `User config written to ${setup.configPath}`,
      actions: dryRun ? [communityDryRun ? applyOnboardingAction : applySetupAction] : [],
      blockers: [],
      warnings: []
    },
    communityDeferredStage(
      phaseStage(doctor, 'backend', {
        id: 'backend',
        title: 'Backend',
        status: 'pending',
        ready: false,
        summary: 'Backend readiness not available',
        actions: [],
        blockers: [],
        warnings: []
      })
    ),
    communityDeferredStage(
      phaseStage(doctor, 'models', {
        id: 'models',
        title: 'Models',
        status: 'pending',
        ready: false,
        summary: 'Model file readiness not available',
        actions: [],
        blockers: [],
        warnings: []
      })
    ),
    communityDeferredStage(
      phaseStage(doctor, 'clients', {
        id: 'clients',
        title: 'Agent Clients',
        status: 'pending',
        ready: false,
        summary: 'Client integration readiness not available',
        actions: [],
        blockers: [],
        warnings: []
      })
    ),
    runtimeStage(),
    {
      id: 'verify',
      title: 'Verify',
      status: communityDryRun
        ? 'planned'
        : !setupOk
          ? 'blocked'
          : doctor.complete
            ? 'ready'
            : doctor.ok
              ? 'action-needed'
              : 'blocked',
      ready: communityDryRun ? null : doctor.complete,
      summary: communityDryRun
        ? 'Apply onboarding to import the community recipe and run setup'
        : !setupOk
          ? `Setup apply ended with status ${setup.status ?? 'failed'}`
          : doctor.complete
            ? 'LLooM is installed, integrated, and ready'
            : doctor.ok
              ? `${doctor.summary.actions} remaining action(s) before LLooM is fully ready`
              : `${doctor.summary.blockers} blocker(s) need attention`,
      actions: communityDryRun ? [applyOnboardingAction] : doctor.actions,
      blockers: [
        ...(setupOk
          ? []
          : [
              {
                phase: 'setup',
                message: `Setup apply ended with status ${setup.status ?? 'failed'}`,
                summary: setup.phases?.bootstrap?.summary ?? null
              }
            ]),
        ...doctor.blockers
      ],
      warnings: doctor.warnings
    }
  ];
  return stages;
}

function buildOnboardingReport({ dryRun, setup, doctor, start, includeRuntimes, community, options }) {
  const host = setup.phases.init.config.server?.host ?? '127.0.0.1';
  const port = setup.phases.init.config.server?.port ?? 8100;
  const dashboardUrl = `http://${host}:${port}/`;
  const planCommand = onboardCommand(options);
  const applyCommand = onboardCommand({ ...options, apply: true });
  const applyAndStartCommand = onboardCommand({ ...options, apply: true, start: true });
  const communityDryRun = Boolean(community && dryRun);
  return {
    schemaVersion: 1,
    dryRun,
    objective: 'install-from-zero',
    ok: setup.ok === false ? false : doctor.ok,
    complete: setup.ok === false ? false : doctor.complete,
    status: setup.status ?? (dryRun ? 'planned' : 'applied'),
    source: community ? 'community' : 'local',
    community: community ?? null,
    selectedRecipe: setup.selectedRecipe,
    configPath: setup.configPath,
    modelRoot: setup.modelRoot,
    ports: setup.ports,
    keepWarm: setup.keepWarm,
    dashboardUrl,
    stages: buildStages({
      setup,
      doctor,
      dryRun,
      start,
      includeRuntimes,
      community,
      applyCommand,
      applyAndStartCommand
    }),
    next: {
      plan: planCommand,
      apply: applyCommand,
      applyAndStart: applyAndStartCommand,
      doctor: communityDryRun
        ? null
        : commandLine('lloom doctor', [
            setup.selectedRecipe?.id ? `--recipe ${shellArg(setup.selectedRecipe.id)}` : null,
            setup.modelRoot ? `--model-root ${shellArg(setup.modelRoot)}` : null,
            options.clientId && options.clientId !== 'all' ? `--client ${shellArg(options.clientId)}` : null,
            customHomeArg(options.home),
            options.generatedRoot ? `--generated-root ${shellArg(options.generatedRoot)}` : null,
            options.statePath ? `--state ${shellArg(options.statePath)}` : null,
            '--no-runtimes'
          ]),
      serve: setup.next.serve,
      dashboard: dashboardUrl,
      pathHint: setup.next.pathHint
    },
    setup,
    doctor
  };
}

export async function createOnboardingPlan(
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
    statePath,
    backendVariables = defaultBackendVariables(process.env),
    benchmarksRoot,
    hostUrl,
    recipeFeedPath,
    signingKeysPath,
    trustHostKeys,
    indexPath,
    recipesRoot,
    trustedKeys,
    requireSignature,
    limit,
    timeoutMs,
    backendCatalogPath,
    offline = false,
    includeRuntimes = false,
    start = false,
    autoDetectModelRoot = false
  } = {}
) {
  const communityRoots = communityCachePaths(home, {
    indexPath,
    recipesRoot,
    benchmarksRoot
  });
  const useCommunity = communityEnabled(config, { recipeId, hostUrl, offline });
  const community = useCommunity
    ? await createCommunityPlan(config, {
        hostUrl,
        recipeFeedPath,
        signingKeysPath,
        trustHostKeys,
        indexPath: communityRoots.indexPath,
        recipesRoot: communityRoots.recipesRoot,
        benchmarksRoot: communityRoots.benchmarksRoot,
        trustedKeys,
        requireSignature,
        limit,
        timeoutMs,
        backendCatalogPath
      })
    : null;
  if (community && !community.ok) {
    throw new Error(
      `Community recommendation failed validation:\n${community.validationErrors.map((error) => `- ${error}`).join('\n')}`
    );
  }
  const effectiveBackendCatalogPath = backendCatalogPath ?? community?.backendCatalogPath;
  const effectiveRecipesRoot = useCommunity ? communityRoots.recipesRoot : recipesRoot;
  const effectiveBenchmarksRoot = useCommunity ? communityRoots.benchmarksRoot : benchmarksRoot;
  const selectedRecipeId = recipeId ?? selectedRecipeIdFromCommunity(community);
  const recipeDocuments = recipeDocumentsFromCommunity(community);
  const benchmarkDocuments = benchmarkDocumentsFromCommunity(community);
  const setupConfig = useCommunity ? communitySetupBaseConfig(config) : config;
  const setup = await createSetupPlan(setupConfig, {
    recipeId: selectedRecipeId,
    configPath,
    modelRoot,
    gatewayPort,
    backendPortRange,
    clientId,
    home,
    generatedRoot,
    backendVariables,
    benchmarksRoot: effectiveBenchmarksRoot,
    benchmarkDocuments,
    recipesRoot: effectiveRecipesRoot,
    recipeDocuments,
    backendCatalogPath: effectiveBackendCatalogPath,
    autoDetectModelRoot
  });
  const plannedConfig = configWithSource(setup.phases.init.config, setup.configPath);
  const doctor = await createDoctorReport(plannedConfig, {
    recipeId: setup.selectedRecipe.id,
    modelRoot: setup.modelRoot,
    clientId,
    home,
    generatedRoot,
    statePath,
    backendVariables,
    benchmarksRoot: effectiveBenchmarksRoot,
    benchmarkDocuments,
    recipesRoot: effectiveRecipesRoot,
    recipeDocuments,
    backendCatalogPath: effectiveBackendCatalogPath,
    includeRuntimes
  });
  return buildOnboardingReport({
    dryRun: true,
    setup,
    doctor,
    start,
    includeRuntimes,
    community,
    options: onboardingCommandOptions({
      community,
      setup,
      hostUrl,
      recipeFeedPath,
      signingKeysPath,
      trustHostKeys,
      indexPath,
      recipesRoot,
      benchmarksRoot,
      limit,
      requireSignature,
      offline,
      home,
      generatedRoot,
      statePath,
      configPath: setup.configPath,
      modelRoot: setup.modelRoot,
      gatewayPort,
      backendPortRange,
      backendCatalogPath: effectiveBackendCatalogPath,
      clientId
    })
  });
}

export async function applyOnboarding(
  config,
  { dryRun = true, yes = false, start = false, includeRuntimes, onProgress, stdio, ...options } = {}
) {
  if (!dryRun && !yes) {
    throw new Error('Refusing to onboard without yes=true. Re-run with --yes after reviewing the dry-run plan.');
  }
  if (dryRun) {
    return createOnboardingPlan(config, {
      ...options,
      start,
      includeRuntimes: includeRuntimes ?? false
    });
  }
  let community = null;
  let recipeId = options.recipeId;
  const home = options.home ?? process.env.HOME;
  const communityRoots = communityCachePaths(home, options);
  const useCommunity = communityEnabled(config, options);
  if (useCommunity) {
    community = await createCommunityPlan(config, {
      ...options,
      ...communityRoots
    });
    if (!community.ok) {
      throw new Error(
        `Community recommendation failed validation:\n${community.validationErrors.map((error) => `- ${error}`).join('\n')}`
      );
    }
    recipeId = selectedRecipeIdFromCommunity(community);
    await applyCommunityRecommendations(config, {
      ...options,
      ...communityRoots,
      recipeId: undefined,
      dryRun: false,
      yes
    });
  }
  const effectiveBackendCatalogPath = options.backendCatalogPath ?? community?.backendCatalogPath;
  const effectiveRecipesRoot = useCommunity ? communityRoots.recipesRoot : options.recipesRoot;
  const effectiveBenchmarksRoot = useCommunity ? communityRoots.benchmarksRoot : options.benchmarksRoot;
  const setupConfig = useCommunity ? communitySetupBaseConfig(config) : config;
  const setup = await applySetup(setupConfig, {
    ...options,
    recipesRoot: effectiveRecipesRoot,
    benchmarksRoot: effectiveBenchmarksRoot,
    recipeId,
    backendCatalogPath: effectiveBackendCatalogPath,
    dryRun: false,
    yes,
    start,
    onProgress,
    stdio
  });
  const appliedConfig = configWithSource(setup.phases.init.config, setup.configPath);
  const clientId = options.clientId ?? 'all';
  const doctor = await createDoctorReport(appliedConfig, {
    recipeId: setup.selectedRecipe.id,
    modelRoot: setup.modelRoot,
    clientId,
    home,
    generatedRoot: options.generatedRoot,
    statePath: options.statePath,
    backendVariables: options.backendVariables ?? defaultBackendVariables(process.env),
    benchmarksRoot: effectiveBenchmarksRoot,
    recipesRoot: effectiveRecipesRoot,
    backendCatalogPath: effectiveBackendCatalogPath,
    includeRuntimes: includeRuntimes ?? start
  });
  return buildOnboardingReport({
    dryRun: false,
    setup,
    doctor,
    start,
    includeRuntimes: includeRuntimes ?? start,
    community,
    options: onboardingCommandOptions({
      community,
      setup,
      hostUrl: options.hostUrl,
      recipeFeedPath: options.recipeFeedPath,
      signingKeysPath: options.signingKeysPath,
      trustHostKeys: options.trustHostKeys,
      indexPath: options.indexPath,
      recipesRoot: options.recipesRoot,
      benchmarksRoot: options.benchmarksRoot,
      limit: options.limit,
      requireSignature: options.requireSignature,
      offline: options.offline,
      home,
      generatedRoot: options.generatedRoot,
      statePath: options.statePath,
      configPath: setup.configPath,
      modelRoot: setup.modelRoot,
      gatewayPort: options.gatewayPort,
      backendPortRange: options.backendPortRange,
      backendCatalogPath: effectiveBackendCatalogPath,
      clientId
    })
  });
}
