import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  selectIntegrationArtifacts,
  writeGeneratedIntegrationArtifacts
} from './client-integrations.mjs';
import { applyBackend, applyRecipe, defaultInstallStatePathFor } from './installer.mjs';
import {
  backendIds,
  defaultBackendVariables,
  getBackend,
  loadBackendCatalog,
  planBackend
} from './backend-catalog.mjs';
import {
  defaultBenchmarksRoot,
  loadBenchmarkEvidenceWithDocuments,
  summarizeBenchmarksForRecipe,
  validateBenchmarkEvidence
} from './benchmarks.mjs';
import { profileMachine, rankRecipes } from './machine-profile.mjs';
import { createRegistry } from './registry.mjs';
import { loadRecipeById, loadRecipes, planRecipe } from './recipes.mjs';

function integrationSummary(artifacts, clientId = 'all') {
  const selected = selectIntegrationArtifacts(artifacts, clientId);
  if (!selected.length) throw new Error(`Unknown integration client ${clientId}`);
  return selected.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    mode: artifact.mode,
    targetPath: artifact.targetPath,
    generatedPath: artifact.generatedPath,
    notes: artifact.notes
  }));
}

async function selectRecipe({ recipeId, recipes, profile, recipesRoot }) {
  if (recipeId) {
    return recipes.find((candidate) => candidate.id === recipeId) ?? loadRecipeById(recipeId, recipesRoot);
  }
  const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
  const selected = ranked.find((candidate) => candidate.selectable);
  if (!selected) {
    throw new Error('No selectable recipe for this machine');
  }
  return recipes.find((recipe) => recipe.id === selected.recipeId);
}

function phaseSummary(name, result) {
  const results = result?.results ?? [];
  const failed = results.filter((entry) => ['failed', 'manual-required'].includes(entry.status));
  const planned = results.filter((entry) => entry.status === 'planned');
  const skipped = results.filter((entry) => entry.status === 'skipped');
  const completed = results.filter((entry) => ['completed', 'written'].includes(entry.status));
  const status = failed.length
    ? 'failed'
    : planned.length
      ? 'planned'
      : results.length && skipped.length === results.length
        ? 'skipped'
        : 'completed';
  return {
    name,
    status,
    ok: failed.length === 0,
    total: results.length,
    completed: completed.length,
    skipped: skipped.length,
    planned: planned.length,
    failed: failed.length,
    failedSteps: failed.map((entry) => ({
      id: entry.id,
      action: entry.action,
      status: entry.status,
      code: entry.code,
      message: entry.message,
      stderr: entry.stderr
    }))
  };
}

function blockedPhase(name, reason, { dryRun, results = [] } = {}) {
  return {
    dryRun,
    blocked: true,
    reason,
    results,
    summary: {
      name,
      status: 'blocked',
      ok: false,
      total: results.length,
      completed: 0,
      skipped: 0,
      planned: 0,
      failed: 0,
      failedSteps: []
    }
  };
}

function bootstrapSummary(phases) {
  const summaries = Object.values(phases)
    .map((phase) => phase?.summary)
    .filter(Boolean);
  const failed = summaries.filter((summary) => summary.status === 'failed');
  const blocked = summaries.filter((summary) => summary.status === 'blocked');
  const planned = summaries.filter((summary) => summary.status === 'planned');
  return {
    ok: failed.length === 0 && blocked.length === 0,
    status: failed.length
      ? 'failed'
      : blocked.length
        ? 'blocked'
        : planned.length
          ? 'planned'
          : summaries.every((summary) => summary.status === 'skipped')
            ? 'skipped'
            : 'completed',
    phases: summaries,
    failedPhases: failed.map((summary) => summary.name),
    blockedPhases: blocked.map((summary) => summary.name)
  };
}

function envWithPathPrefix(prefix, env = process.env) {
  if (!prefix) return env;
  return {
    ...env,
    PATH: `${prefix}${env.PATH ? `:${env.PATH}` : ''}`
  };
}

export async function createBootstrapPlan(
  config,
  {
    recipeId,
    modelRoot,
    clientId = 'all',
    home = process.env.HOME,
    generatedRoot,
    backendVariables = defaultBackendVariables(process.env),
    benchmarksRoot,
    benchmarkDocuments = [],
    recipesRoot,
    recipeDocuments = [],
    backendCatalogPath,
    _onProgress,
    _stdio
  } = {}
) {
  const profile = await profileMachine();
  const recipes = [...recipeDocuments, ...(await loadRecipes(recipesRoot))];
  const recipe = await selectRecipe({ recipeId, recipes, profile, recipesRoot });
  const catalog = await loadBackendCatalog(backendCatalogPath);
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);

  const registry = createRegistry(config);
  const integrations = integrationSummary(
    buildIntegrationArtifacts(config, registry, { home, generatedRoot }),
    clientId
  );
  const selectedModelRoot = modelRoot ?? process.env.LLOOM_MODEL_ROOT ?? '${LLOOM_MODEL_ROOT}';
  const selectedBenchmarksRoot = benchmarksRoot ?? defaultBenchmarksRoot;
  const benchmarkEvidence = await loadBenchmarkEvidenceWithDocuments(selectedBenchmarksRoot, benchmarkDocuments);
  const benchmarkErrors = validateBenchmarkEvidence(benchmarkEvidence);

  return {
    profile,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id
    },
    backend: await planBackend(backend, {
      variables: backendVariables,
      checkCommands: true
    }),
    recipe: planRecipe(recipe, config, {
      modelRoot: selectedModelRoot,
      backendIds: backendIds(catalog),
      benchmarkEvidence,
      benchmarksRoot: selectedBenchmarksRoot,
      benchmarkValidationErrors: benchmarkErrors
    }),
    benchmarks: {
      root: selectedBenchmarksRoot,
      validationErrors: benchmarkErrors,
      recipe: summarizeBenchmarksForRecipe(recipe, benchmarkEvidence)
    },
    integrations,
    next: {
      serve: `lloom serve --config ${config.sourcePath}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`
    }
  };
}

export async function applyBootstrap(
  config,
  {
    recipeId,
    modelRoot,
    clientId = 'all',
    dryRun = true,
    yes = false,
    home = process.env.HOME,
    statePath = defaultInstallStatePathFor({ ...process.env, HOME: home }),
    generatedRoot,
    backendVariables = defaultBackendVariables(process.env),
    _benchmarkDocuments = [],
    recipesRoot,
    recipeDocuments = [],
    backendCatalogPath,
    onProgress,
    stdio
  } = {}
) {
  if (!dryRun && !yes) {
    throw new Error('Refusing to bootstrap without yes=true. Re-run with --yes after reviewing the dry-run plan.');
  }

  const profile = await profileMachine();
  const recipes = [...recipeDocuments, ...(await loadRecipes(recipesRoot))];
  const recipe = await selectRecipe({ recipeId, recipes, profile, recipesRoot });
  const catalog = await loadBackendCatalog(backendCatalogPath);
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);

  const registry = createRegistry(config);
  const commandEnv = envWithPathPrefix(backendVariables.shimDir);
  const backendResult = await applyBackend(backend, {
    dryRun,
    yes,
    statePath,
    variables: backendVariables,
    env: commandEnv
  });
  backendResult.summary = phaseSummary('backend', backendResult);

  const recipeResult = backendResult.summary.ok
    ? await applyRecipe(recipe, config, {
        dryRun,
        yes,
        statePath,
        env: commandEnv,
        onProgress,
        stdio,
        ...(modelRoot ? { modelRoot } : {})
      })
    : blockedPhase('recipe', 'backend phase failed', { dryRun });
  recipeResult.summary ??= phaseSummary('recipe', recipeResult);

  const integrationResult = recipeResult.summary.ok
    ? await applyIntegrationArtifacts(config, registry, {
        clientId,
        dryRun,
        yes,
        home,
        generatedRoot
      })
    : blockedPhase('integrations', 'recipe phase failed', { dryRun });
  integrationResult.summary ??= phaseSummary('integrations', integrationResult);

  const generatedClients =
    dryRun || !integrationResult.summary.ok
      ? []
      : await writeGeneratedIntegrationArtifacts(config, registry, { clientId, home, generatedRoot });
  const summary = bootstrapSummary({
    backend: backendResult,
    recipe: recipeResult,
    integrations: integrationResult
  });

  return {
    dryRun,
    statePath,
    ok: summary.ok,
    status: summary.status,
    summary,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id
    },
    backend: backendResult,
    recipe: recipeResult,
    integrations: integrationResult,
    generatedClients,
    next: {
      serve: `lloom serve --config ${config.sourcePath}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`
    }
  };
}
