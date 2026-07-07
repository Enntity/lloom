import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  selectIntegrationArtifacts,
  writeGeneratedIntegrationArtifacts,
} from "./client-integrations.mjs";
import { applyBackend, applyRecipe, defaultInstallStatePath } from "./installer.mjs";
import { backendIds, defaultBackendVariables, getBackend, loadBackendCatalog, planBackend } from "./backend-catalog.mjs";
import {
  defaultBenchmarksRoot,
  loadBenchmarkEvidence,
  summarizeBenchmarksForRecipe,
  validateBenchmarkEvidence,
} from "./benchmarks.mjs";
import { profileMachine, rankRecipes } from "./machine-profile.mjs";
import { createRegistry } from "./registry.mjs";
import { loadRecipeById, loadRecipes, planRecipe } from "./recipes.mjs";

function integrationSummary(artifacts, clientId = "all") {
  const selected = selectIntegrationArtifacts(artifacts, clientId);
  if (!selected.length) throw new Error(`Unknown integration client ${clientId}`);
  return selected.map(artifact => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    mode: artifact.mode,
    targetPath: artifact.targetPath,
    generatedPath: artifact.generatedPath,
    notes: artifact.notes,
  }));
}

async function selectRecipe({ recipeId, recipes, profile }) {
  if (recipeId) {
    return loadRecipeById(recipeId);
  }
  const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
  const selected = ranked.find(candidate => candidate.selectable);
  if (!selected) {
    throw new Error("No selectable recipe for this machine");
  }
  return recipes.find(recipe => recipe.id === selected.recipeId);
}

export async function createBootstrapPlan(config, {
  recipeId,
  modelRoot,
  clientId = "all",
  home = process.env.HOME,
  generatedRoot,
  backendVariables = defaultBackendVariables(process.env),
  benchmarksRoot,
} = {}) {
  const profile = await profileMachine();
  const recipes = await loadRecipes();
  const recipe = await selectRecipe({ recipeId, recipes, profile });
  const catalog = await loadBackendCatalog();
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);

  const registry = createRegistry(config);
  const integrations = integrationSummary(buildIntegrationArtifacts(config, registry, { home, generatedRoot }), clientId);
  const selectedModelRoot = modelRoot ?? process.env.SWITCHYARD_MODEL_ROOT ?? "${SWITCHYARD_MODEL_ROOT}";
  const selectedBenchmarksRoot = benchmarksRoot ?? defaultBenchmarksRoot;
  const benchmarkEvidence = await loadBenchmarkEvidence(selectedBenchmarksRoot);
  const benchmarkErrors = validateBenchmarkEvidence(benchmarkEvidence);

  return {
    profile,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id,
    },
    backend: await planBackend(backend, {
      variables: backendVariables,
      checkCommands: true,
    }),
    recipe: planRecipe(recipe, config, {
      modelRoot: selectedModelRoot,
      backendIds: backendIds(catalog),
      benchmarkEvidence,
      benchmarksRoot: selectedBenchmarksRoot,
      benchmarkValidationErrors: benchmarkErrors,
    }),
    benchmarks: {
      root: selectedBenchmarksRoot,
      validationErrors: benchmarkErrors,
      recipe: summarizeBenchmarksForRecipe(recipe, benchmarkEvidence),
    },
    integrations,
    next: {
      serve: `switchyard serve --config ${config.sourcePath}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`,
    },
  };
}

export async function applyBootstrap(config, {
  recipeId,
  modelRoot,
  clientId = "all",
  dryRun = true,
  yes = false,
  statePath = defaultInstallStatePath,
  home = process.env.HOME,
  generatedRoot,
  backendVariables = defaultBackendVariables(process.env),
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to bootstrap without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }

  const profile = await profileMachine();
  const recipes = await loadRecipes();
  const recipe = await selectRecipe({ recipeId, recipes, profile });
  const catalog = await loadBackendCatalog();
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);

  const registry = createRegistry(config);
  const backendResult = await applyBackend(backend, {
    dryRun,
    yes,
    statePath,
    variables: backendVariables,
  });
  const recipeResult = await applyRecipe(recipe, config, {
    dryRun,
    yes,
    statePath,
    ...(modelRoot ? { modelRoot } : {}),
  });
  const integrationResult = await applyIntegrationArtifacts(config, registry, {
    clientId,
    dryRun,
    yes,
    home,
    generatedRoot,
  });
  const generatedClients = dryRun
    ? []
    : await writeGeneratedIntegrationArtifacts(config, registry, { clientId, home, generatedRoot });

  return {
    dryRun,
    statePath,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id,
    },
    backend: backendResult,
    recipe: recipeResult,
    integrations: integrationResult,
    generatedClients,
    next: {
      serve: `switchyard serve --config ${config.sourcePath}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`,
    },
  };
}
