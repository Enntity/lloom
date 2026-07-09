import {
  benchmarkOverview,
  defaultBenchmarksRoot,
  loadBenchmarkEvidenceWithDocuments,
  validateBenchmarkEvidence
} from './benchmarks.mjs';
import { createRegistry } from './registry.mjs';
import { createSetupStatus } from './setup-status.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function phase({ id, title, ready, summary, actions = [], warnings = [], blockers = [], details = {} }) {
  const status = blockers.length
    ? 'blocked'
    : ready === true
      ? 'ready'
      : ready === null
        ? 'skipped'
        : actions.length
          ? 'action-needed'
          : 'pending';
  return {
    id,
    title,
    status,
    ready,
    summary,
    blockers,
    warnings,
    actions,
    details
  };
}

function modelCatalogStatus(config, registry) {
  const models = registry.catalogModels({ includeAliases: true });
  const chatModels = registry.clientModels({ kinds: ['chat'] });
  const defaultChatModel = config.defaults?.chatModel ?? null;
  const knownModelIds = new Set(models.map((model) => model.id));
  const blockers = [];
  const warnings = [];
  if (!models.length) blockers.push('model registry is empty');
  if (!chatModels.length) blockers.push('model registry has no advertised chat models');
  if (!defaultChatModel) {
    blockers.push('defaults.chatModel is not configured');
  } else if (!knownModelIds.has(defaultChatModel)) {
    blockers.push(`defaults.chatModel ${defaultChatModel} is not in the model registry`);
  }
  if ((config.clientCatalog?.includeAliases ?? false) === true) {
    warnings.push('client catalog is configured to advertise aliases; exact IDs are safer for agent clients');
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    details: {
      defaultChatModel,
      modelCount: models.length,
      chatModelCount: chatModels.length,
      advertisedChatModels: chatModels.map((model) => model.id)
    }
  };
}

function setupStatusBlockers(setupStatus) {
  const blockers = [];
  if (!setupStatus.ok) blockers.push('setup status is not valid for the selected recipe');
  if (!setupStatus.backend.platformSupported) {
    blockers.push(`backend ${setupStatus.backend.id} is not supported on this platform`);
  }
  if (!setupStatus.recipe.platformSupported) {
    blockers.push(`recipe ${setupStatus.recipe.id} is not supported on this platform`);
  }
  for (const error of asArray(setupStatus.recipe.validationErrors)) {
    blockers.push(`recipe validation: ${error}`);
  }
  return blockers;
}

function modelInstallPhase(setupStatus) {
  const missingModels = asArray(setupStatus.recipe.models).filter((model) => !model.destination?.populated);
  const pendingSteps = asArray(setupStatus.recipe.steps).filter((step) => !step.ready);
  const actions = [];
  if (missingModels.length || pendingSteps.length) {
    actions.push({
      id: 'install-recipe',
      label: 'Install recipe models and tuning steps',
      command: setupStatus.next.recipeInstall
    });
  }
  return phase({
    id: 'models',
    title: 'Models',
    ready: missingModels.length === 0 && pendingSteps.length === 0,
    summary: missingModels.length
      ? `${missingModels.length} model file set(s) missing`
      : pendingSteps.length
        ? `${pendingSteps.length} recipe step(s) pending`
        : 'All selected recipe model files are present',
    actions,
    details: {
      missingModels: missingModels.map((model) => ({
        role: model.role,
        model: model.model,
        destination: model.destination?.path
      })),
      pendingSteps: pendingSteps.map((step) => ({
        id: step.id,
        action: step.action,
        status: step.status
      }))
    }
  });
}

function backendPhase(setupStatus) {
  const actions = setupStatus.backend.ready
    ? []
    : [
        {
          id: 'install-backend',
          label: `Install or expose ${setupStatus.backend.name}`,
          command: setupStatus.next.backendInstall
        }
      ];
  return phase({
    id: 'backend',
    title: 'Backend',
    ready: setupStatus.backend.ready,
    summary: setupStatus.backend.ready
      ? `${setupStatus.backend.name} is ready`
      : `${setupStatus.backend.name} needs setup`,
    actions,
    blockers: setupStatus.backend.platformSupported
      ? []
      : [`backend ${setupStatus.backend.id} is not supported on this platform`],
    details: {
      id: setupStatus.backend.id,
      name: setupStatus.backend.name,
      missingCommands: setupStatus.backend.missingCommands ?? [],
      steps: setupStatus.backend.steps.map((step) => ({
        id: step.id,
        action: step.action,
        status: step.status,
        ready: step.ready
      }))
    }
  });
}

function recipePhase(setupStatus) {
  return phase({
    id: 'recipe',
    title: 'Recipe',
    ready: setupStatus.ok,
    summary: setupStatus.ok
      ? `${setupStatus.selectedRecipe.name} is selectable for this machine`
      : `${setupStatus.selectedRecipe.name} is not ready for this machine`,
    blockers: setupStatusBlockers(setupStatus),
    details: {
      id: setupStatus.selectedRecipe.id,
      backendId: setupStatus.selectedRecipe.backendId,
      platformSupported: setupStatus.recipe.platformSupported,
      validationErrors: setupStatus.recipe.validationErrors
    }
  });
}

function integrationsPhase(setupStatus) {
  const actions = setupStatus.integrations.ready
    ? []
    : [
        {
          id: 'write-client-integrations',
          label: 'Write or refresh client integration files',
          command: setupStatus.next.integrate
        }
      ];
  const drifted = setupStatus.integrations.data
    .filter((integration) => !integration.current)
    .map((integration) => ({
      id: integration.id,
      targetPath: integration.targetPath,
      status: integration.target.status
    }));
  return phase({
    id: 'clients',
    title: 'Agent Clients',
    ready: setupStatus.integrations.ready,
    summary: setupStatus.integrations.ready
      ? 'Selected client integration files are current'
      : `${drifted.length} client config file(s) missing or out of date`,
    actions,
    details: {
      clientId: setupStatus.integrations.clientId,
      drifted
    }
  });
}

function runtimesPhase(setupStatus) {
  if (!setupStatus.runtimes) {
    return phase({
      id: 'runtimes',
      title: 'Runtimes',
      ready: null,
      summary: 'Runtime health check skipped'
    });
  }
  const unhealthy = Object.entries(setupStatus.runtimes.keepWarm ?? {})
    .filter(([, runtime]) => !runtime.healthy)
    .map(([id, runtime]) => ({
      id,
      state: runtime.state,
      healthy: runtime.healthy,
      lastError: runtime.lastError
    }));
  return phase({
    id: 'runtimes',
    title: 'Keep-Warm Runtimes',
    ready: setupStatus.runtimes.ready,
    summary: setupStatus.runtimes.ready
      ? 'Keep-warm runtimes are healthy'
      : `${unhealthy.length} keep-warm runtime(s) unhealthy or stopped`,
    actions: setupStatus.runtimes.ready
      ? []
      : [
          {
            id: 'start-keep-warm',
            label: 'Start keep-warm runtimes',
            command: setupStatus.next.keepWarm
          }
        ],
    details: {
      unhealthy
    }
  });
}

function benchmarksPhase(benchmarkEvidence, benchmarkValidationErrors, benchmarksRoot) {
  const warnings = benchmarkEvidence.length
    ? []
    : ['no benchmark evidence found; recipe ranking will use requirements only'];
  return phase({
    id: 'benchmarks',
    title: 'Benchmark Evidence',
    ready: benchmarkValidationErrors.length === 0,
    summary: `${benchmarkEvidence.length} benchmark result(s) loaded`,
    warnings,
    blockers: benchmarkValidationErrors,
    details: {
      root: benchmarksRoot,
      count: benchmarkEvidence.length
    }
  });
}

function nextActions(setupStatus, phases) {
  const actions = [];
  for (const current of phases) {
    for (const action of current.actions) {
      actions.push({
        phase: current.id,
        ...action
      });
    }
  }
  if (setupStatus && !setupStatus.complete) {
    if (!actions.length) {
      actions.push({
        phase: 'setup',
        id: 'review-status',
        label: 'Review current install status',
        command: setupStatus.next.review
      });
    }
    actions.push({
      phase: 'setup',
      id: 'apply-all',
      label: 'Apply remaining setup',
      command: setupStatus.next.setup
    });
  }
  return actions;
}

function flatten(field, phases) {
  return phases.flatMap((current) =>
    asArray(current[field]).map((entry) => ({
      phase: current.id,
      message: typeof entry === 'string' ? entry : (entry.message ?? entry.label ?? JSON.stringify(entry)),
      ...(typeof entry === 'object' ? entry : {})
    }))
  );
}

export async function createDoctorReport(
  config,
  {
    recipeId,
    modelRoot,
    clientId = 'all',
    home = process.env.HOME,
    generatedRoot,
    statePath,
    includeRuntimes = true,
    backendVariables,
    benchmarksRoot,
    benchmarkDocuments = [],
    recipesRoot,
    recipeDocuments,
    backendCatalogPath
  } = {}
) {
  const registry = createRegistry(config);
  const catalogStatus = modelCatalogStatus(config, registry);
  const selectedBenchmarksRoot = benchmarksRoot ?? config.init?.benchmarksRoot ?? defaultBenchmarksRoot;
  const benchmarkEvidence = await loadBenchmarkEvidenceWithDocuments(selectedBenchmarksRoot, benchmarkDocuments);
  const benchmarkValidationErrors = validateBenchmarkEvidence(benchmarkEvidence);

  const phases = [
    phase({
      id: 'registry',
      title: 'Model Registry',
      ready: catalogStatus.ready,
      summary: `${catalogStatus.details.chatModelCount} advertised chat model(s), default ${catalogStatus.details.defaultChatModel ?? '(none)'}`,
      blockers: catalogStatus.blockers,
      warnings: catalogStatus.warnings,
      details: catalogStatus.details
    })
  ];

  let setupStatus = null;
  let setupError = null;
  try {
    setupStatus = await createSetupStatus(config, {
      recipeId,
      modelRoot,
      clientId,
      home,
      generatedRoot,
      statePath,
      includeRuntimes,
      ...(backendVariables ? { backendVariables } : {}),
      recipesRoot,
      recipeDocuments,
      backendCatalogPath
    });
    phases.push(
      recipePhase(setupStatus),
      backendPhase(setupStatus),
      modelInstallPhase(setupStatus),
      integrationsPhase(setupStatus),
      runtimesPhase(setupStatus)
    );
  } catch (error) {
    setupError = error;
    phases.push(
      phase({
        id: 'setup',
        title: 'Setup Plan',
        ready: false,
        summary: 'Setup status could not be created',
        blockers: [error?.message ?? String(error)]
      })
    );
  }

  phases.push(benchmarksPhase(benchmarkEvidence, benchmarkValidationErrors, selectedBenchmarksRoot));

  const blockers = flatten('blockers', phases);
  const warnings = flatten('warnings', phases);
  const actions = nextActions(setupStatus, phases);

  return {
    ok: blockers.length === 0,
    complete: setupStatus?.complete === true && blockers.length === 0,
    generatedAt: new Date().toISOString(),
    config: config.sourcePath,
    selectedRecipe: setupStatus?.selectedRecipe ?? null,
    profile: setupStatus?.profile ?? null,
    summary: {
      blockers: blockers.length,
      warnings: warnings.length,
      actions: actions.length,
      phasesReady: phases.filter((current) => current.ready === true).length,
      phasesTotal: phases.length
    },
    blockers,
    warnings,
    actions,
    phases,
    next: setupStatus?.next ?? {},
    details: {
      setupStatus,
      setupError: setupError
        ? {
            message: setupError.message ?? String(setupError)
          }
        : null,
      benchmarks: {
        root: selectedBenchmarksRoot,
        count: benchmarkEvidence.length,
        validationErrors: benchmarkValidationErrors,
        overview: benchmarkOverview(benchmarkEvidence)
      }
    }
  };
}
