#!/usr/bin/env node
import {
  backendIds,
  defaultBackendVariables,
  getBackend,
  loadBackendCatalog,
  planBackend,
  planBackendCatalog,
  validateBackendCatalog,
} from "../src/backend-catalog.mjs";
import {
  benchmarkOverview,
  defaultBenchmarksRoot,
  loadBenchmarkEvidence,
  summarizeBenchmarksForRecipe,
  validateBenchmarkEvidence,
} from "../src/benchmarks.mjs";
import { applyBootstrap, createBootstrapPlan } from "../src/bootstrap.mjs";
import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  selectIntegrationArtifacts,
} from "../src/client-integrations.mjs";
import { loadConfig } from "../src/config.mjs";
import { applyInit, defaultUserConfigPath } from "../src/init.mjs";
import { applyBackend, applyRecipe } from "../src/installer.mjs";
import { profileMachine, rankRecipes } from "../src/machine-profile.mjs";
import { applyRecipePack, createRecipePackPlan, loadTrustedKeys } from "../src/recipe-pack.mjs";
import { buildRecipeIndexReport } from "../src/recipe-index.mjs";
import { createRegistry } from "../src/registry.mjs";
import { loadRecipeById, loadRecipes, planRecipe } from "../src/recipes.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { createLloomServer } from "../src/server.mjs";
import { applySetup, createSetupPlan } from "../src/setup.mjs";
import { createSetupStatus } from "../src/setup-status.mjs";

function usage() {
  return `Usage:
  lloom serve [--config path]
  lloom models [--config path]
  lloom backends [backend-id|all]
  lloom backend-plan <backend-id>
  lloom backend-install <backend-id> [--apply --yes] [--step step-id]
  lloom setup [--recipe recipe-id] [--config-out path] [--model-root path] [--client client-id|all] [--apply --yes] [--start]
  lloom init [--recipe recipe-id] [--config-out path] [--model-root path] [--client client-id|all] [--apply --yes] [--integrate]
  lloom bootstrap [--recipe recipe-id] [--model-root path] [--client client-id|all] [--apply --yes]
  lloom setup-status [--recipe recipe-id] [--model-root path] [--client client-id|all] [--state path] [--home path] [--no-runtimes]
  lloom benchmarks [recipe-id|all] [--benchmarks-root path]
  lloom profile [--config path]
  lloom recipes [--config path]
  lloom recipe-index [--index path] [--recipes-root path] [--benchmarks-root path] [--model-root path]
  lloom recipe-import <pack-file-or-url> [--index path] [--recipes-root path] [--benchmarks-root path] [--trusted-key key-id=pubkey.pem] [--require-signature] [--apply --yes]
  lloom select [--config path]
  lloom plan <recipe-id> [--config path] [--model-root path]
  lloom install <recipe-id> [--config path] [--model-root path] [--apply --yes]
  lloom integrations [client-id|all] [--config path]
  lloom integrate [client-id|all] [--config path] [--apply --yes]
  lloom runtimes [runtime-id|all] [--config path]
  lloom runtime-start <runtime-id> [--config path] [--no-warmup] [--no-force]
  lloom runtime-warmup <runtime-id> [--config path]
  lloom runtime-stop <runtime-id> [--config path]
  lloom keep-warm [--config path]
  lloom doctor [--config path]

Environment:
  LLOOM_CONFIG  Path to config JSON
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function positional(args) {
  return args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    const previous = args[index - 1];
    return !previous?.startsWith("--");
  });
}

async function loadBenchmarksForCli(args) {
  const root = argValue(args, "--benchmarks-root") ?? defaultBenchmarksRoot;
  const evidence = await loadBenchmarkEvidence(root);
  const validationErrors = validateBenchmarkEvidence(evidence);
  return {
    root,
    evidence,
    validationErrors,
  };
}

function runtimeManagerForCli(config) {
  return new RuntimeManager(config, {
    captureOutput: false,
    logger: {
      error(message) {
        console.error(message);
      },
    },
  });
}

function requireRuntimeId(args, command) {
  const runtimeId = positional(args)[1];
  if (!runtimeId) {
    console.error(`Missing runtime id for ${command}`);
    console.error(usage());
    process.exitCode = 2;
    return null;
  }
  return runtimeId;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "serve";
  const configPath = argValue(args, "--config") ?? process.env.LLOOM_CONFIG;
  const config = await loadConfig(configPath);

  if (command === "serve") {
    const app = createLloomServer(config);
    await app.listen();
    console.log(`LLooM listening on http://${config.server.host}:${config.server.port}`);
    return;
  }

  if (command === "models") {
    const registry = createRegistry(config);
    console.log(JSON.stringify({ data: registry.openAIModels() }, null, 2));
    return;
  }

  if (command === "backends") {
    const backendId = positional(args)[1] ?? "all";
    const catalog = await loadBackendCatalog();
    const errors = validateBackendCatalog(catalog);
    if (errors.length) {
      throw new Error(`Invalid backend catalog:\n${errors.map(error => `- ${error}`).join("\n")}`);
    }
    const backends = backendId === "all"
      ? catalog.backends
      : catalog.backends.filter(backend => backend.id === backendId);
    if (!backends.length) throw new Error(`Unknown backend ${backendId}`);
    console.log(JSON.stringify({
      data: backends.map(backend => ({
        id: backend.id,
        name: backend.name,
        kind: backend.kind,
        platforms: backend.platforms,
        features: backend.features,
        commands: backend.commands,
        server: backend.server,
      })),
    }, null, 2));
    return;
  }

  if (command === "backend-plan") {
    const backendId = positional(args)[1];
    if (!backendId) {
      console.error("Missing backend id");
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const catalog = await loadBackendCatalog();
    const backend = getBackend(catalog, backendId);
    if (!backend) throw new Error(`Unknown backend ${backendId}`);
    console.log(JSON.stringify(await planBackend(backend, {
      variables: defaultBackendVariables(process.env),
      checkCommands: true,
    }), null, 2));
    return;
  }

  if (command === "backend-install") {
    const backendId = positional(args)[1];
    if (!backendId) {
      console.error("Missing backend id");
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const catalog = await loadBackendCatalog();
    const backend = getBackend(catalog, backendId);
    if (!backend) throw new Error(`Unknown backend ${backendId}`);
    const statePath = argValue(args, "--state");
    const onlyStep = argValue(args, "--step");
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    console.log(JSON.stringify(await applyBackend(backend, {
      dryRun: !apply,
      yes,
      ...(statePath ? { statePath } : {}),
      ...(onlyStep ? { onlyStep } : {}),
      variables: defaultBackendVariables(process.env),
    }), null, 2));
    return;
  }

  if (command === "setup") {
    const recipeId = argValue(args, "--recipe");
    const configOut = argValue(args, "--config-out") ?? defaultUserConfigPath();
    const modelRoot = argValue(args, "--model-root");
    const clientId = argValue(args, "--client") ?? "all";
    const statePath = argValue(args, "--state");
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    const start = hasFlag(args, "--start");
    const options = {
      recipeId,
      configPath: configOut,
      ...(modelRoot ? { modelRoot } : {}),
      clientId,
      backendVariables: defaultBackendVariables(process.env),
      benchmarksRoot: argValue(args, "--benchmarks-root"),
      ...(statePath ? { statePath } : {}),
    };
    console.log(JSON.stringify(apply
      ? await applySetup(config, {
        ...options,
        dryRun: false,
        yes,
        start,
      })
      : await createSetupPlan(config, options), null, 2));
    return;
  }

  if (command === "init") {
    const recipeId = argValue(args, "--recipe");
    const configOut = argValue(args, "--config-out") ?? defaultUserConfigPath();
    const modelRoot = argValue(args, "--model-root");
    const clientId = argValue(args, "--client") ?? "all";
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    const integrate = hasFlag(args, "--integrate");
    console.log(JSON.stringify(await applyInit(config, {
      recipeId,
      configPath: configOut,
      ...(modelRoot ? { modelRoot } : {}),
      clientId,
      dryRun: !apply,
      yes,
      integrate,
      backendVariables: defaultBackendVariables(process.env),
    }), null, 2));
    return;
  }

  if (command === "bootstrap") {
    const recipeId = argValue(args, "--recipe");
    const modelRoot = argValue(args, "--model-root");
    const clientId = argValue(args, "--client") ?? "all";
    const statePath = argValue(args, "--state");
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    if (!apply) {
      console.log(JSON.stringify(await createBootstrapPlan(config, {
        recipeId,
        modelRoot,
        clientId,
        backendVariables: defaultBackendVariables(process.env),
        benchmarksRoot: argValue(args, "--benchmarks-root"),
      }), null, 2));
      return;
    }
    console.log(JSON.stringify(await applyBootstrap(config, {
      recipeId,
      modelRoot,
      clientId,
      dryRun: false,
      yes,
        ...(statePath ? { statePath } : {}),
        backendVariables: defaultBackendVariables(process.env),
      }), null, 2));
    return;
  }

  if (command === "setup-status" || command === "status") {
    const recipeId = argValue(args, "--recipe");
    const modelRoot = argValue(args, "--model-root");
    const clientId = argValue(args, "--client") ?? "all";
    const statePath = argValue(args, "--state");
    const generatedRoot = argValue(args, "--generated-root");
    const home = argValue(args, "--home") ?? process.env.HOME;
    console.log(JSON.stringify(await createSetupStatus(config, {
      recipeId,
      modelRoot,
      clientId,
      generatedRoot,
      home,
      includeRuntimes: !hasFlag(args, "--no-runtimes"),
      backendVariables: defaultBackendVariables(process.env),
      ...(statePath ? { statePath } : {}),
    }), null, 2));
    return;
  }

  if (command === "benchmarks") {
    const recipeId = positional(args)[1] ?? "all";
    const {
      root,
      evidence,
      validationErrors,
    } = await loadBenchmarksForCli(args);
    if (recipeId === "all") {
      console.log(JSON.stringify({
        ok: validationErrors.length === 0,
        root,
        count: evidence.length,
        validationErrors,
        data: benchmarkOverview(evidence),
      }, null, 2));
      return;
    }
    const recipe = await loadRecipeById(recipeId);
    console.log(JSON.stringify({
      ok: validationErrors.length === 0,
      root,
      recipeId: recipe.id,
      count: evidence.filter(result => result.recipeId === recipe.id).length,
      validationErrors,
      data: summarizeBenchmarksForRecipe(recipe, evidence),
    }, null, 2));
    return;
  }

  if (command === "profile") {
    const profile = await profileMachine();
    const recipes = await loadRecipes();
    const catalog = await loadBackendCatalog();
    console.log(JSON.stringify({
      profile,
      recipes: await rankRecipes(recipes, profile, { checkCommands: true }),
      backends: await planBackendCatalog(catalog, { checkCommands: true }),
    }, null, 2));
    return;
  }

  if (command === "recipes") {
    const recipes = await loadRecipes();
    console.log(JSON.stringify({
      data: recipes.map(recipe => ({
        id: recipe.id,
        name: recipe.name,
        version: recipe.version ?? 1,
        backend: recipe.backend,
        requirements: recipe.requirements,
        models: (recipe.models ?? []).map(model => ({
          role: model.role,
          model: model.model,
          gatewayModel: model.gatewayModel,
          runtime: model.runtime,
        })),
      })),
    }, null, 2));
    return;
  }

  if (command === "recipe-index") {
    const catalog = await loadBackendCatalog();
    const {
      evidence: benchmarkEvidence,
      validationErrors: benchmarkValidationErrors,
      root: benchmarksRoot,
    } = await loadBenchmarksForCli(args);
    console.log(JSON.stringify(await buildRecipeIndexReport(config, {
      indexPath: argValue(args, "--index"),
      recipesRoot: argValue(args, "--recipes-root"),
      modelRoot: argValue(args, "--model-root") ?? "${LLOOM_MODEL_ROOT}",
      backendIds: backendIds(catalog),
      benchmarksRoot,
      benchmarkEvidence,
      benchmarkValidationErrors,
    }), null, 2));
    return;
  }

  if (command === "recipe-import" || command === "recipe-pack") {
    const source = positional(args)[1];
    if (!source) {
      console.error("Missing recipe pack source");
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    const trustedKeys = await loadTrustedKeys(argValues(args, "--trusted-key"));
    const options = {
      indexPath: argValue(args, "--index"),
      recipesRoot: argValue(args, "--recipes-root"),
      benchmarksRoot: argValue(args, "--benchmarks-root"),
      requireSignature: hasFlag(args, "--require-signature"),
      trustedKeys,
    };
    console.log(JSON.stringify(apply
      ? await applyRecipePack(source, config, {
        ...options,
        dryRun: false,
        yes,
      })
      : await createRecipePackPlan(source, config, options), null, 2));
    return;
  }

  if (command === "select") {
    const profile = await profileMachine();
    const recipes = await loadRecipes();
    const ranked = await rankRecipes(recipes, profile, { checkCommands: true });
    console.log(JSON.stringify({
      profile,
      selected: ranked.find(recipe => recipe.selectable) ?? null,
      candidates: ranked,
    }, null, 2));
    return;
  }

  if (command === "plan") {
    const recipeId = positional(args)[1];
    if (!recipeId) {
      console.error("Missing recipe id");
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const recipe = await loadRecipeById(recipeId);
    const catalog = await loadBackendCatalog();
    const modelRoot = argValue(args, "--model-root") ?? "${LLOOM_MODEL_ROOT}";
    const {
      evidence: benchmarkEvidence,
      validationErrors: benchmarkValidationErrors,
      root: benchmarksRoot,
    } = await loadBenchmarksForCli(args);
    console.log(JSON.stringify(planRecipe(recipe, config, {
      modelRoot,
      backendIds: backendIds(catalog),
      benchmarkEvidence,
      benchmarksRoot,
      benchmarkValidationErrors,
    }), null, 2));
    return;
  }

  if (command === "install") {
    const recipeId = positional(args)[1];
    if (!recipeId) {
      console.error("Missing recipe id");
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const recipe = await loadRecipeById(recipeId);
    const modelRoot = argValue(args, "--model-root") ?? process.env.LLOOM_MODEL_ROOT;
    const statePath = argValue(args, "--state");
    const onlyStep = argValue(args, "--step");
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    const result = await applyRecipe(recipe, config, {
      dryRun: !apply,
      yes,
      ...(modelRoot ? { modelRoot } : {}),
      ...(statePath ? { statePath } : {}),
      ...(onlyStep ? { onlyStep } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "integrations") {
    const clientId = positional(args)[1] ?? "all";
    const registry = createRegistry(config);
    const artifacts = buildIntegrationArtifacts(config, registry);
    const selected = selectIntegrationArtifacts(artifacts, clientId);
    if (!selected.length) {
      throw new Error(`Unknown integration client ${clientId}`);
    }
    console.log(JSON.stringify({
      data: selected.map(artifact => ({
        id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        mode: artifact.mode,
        generatedPath: artifact.generatedPath,
        targetPath: artifact.targetPath,
        notes: artifact.notes,
      })),
    }, null, 2));
    return;
  }

  if (command === "integrate") {
    const clientId = positional(args)[1] ?? "all";
    const registry = createRegistry(config);
    const apply = hasFlag(args, "--apply");
    const yes = hasFlag(args, "--yes");
    console.log(JSON.stringify(await applyIntegrationArtifacts(config, registry, {
      clientId,
      dryRun: !apply,
      yes,
    }), null, 2));
    return;
  }

  if (command === "runtimes" || command === "runtime-status") {
    const runtimeId = positional(args)[1] ?? "all";
    const manager = runtimeManagerForCli(config);
    const status = await manager.status();
    const runtimes = runtimeId === "all"
      ? status.runtimes
      : { [runtimeId]: status.runtimes[runtimeId] };
    if (runtimeId !== "all" && !status.runtimes[runtimeId]) {
      throw new Error(`Unknown runtime ${runtimeId}`);
    }
    console.log(JSON.stringify({
      config: config.sourcePath,
      defaults: config.defaults,
      keepWarm: config.keepWarm ?? [],
      runtimes,
      events: status.events,
    }, null, 2));
    return;
  }

  if (command === "runtime-start") {
    const runtimeId = requireRuntimeId(args, command);
    if (!runtimeId) return;
    const manager = runtimeManagerForCli(config);
    console.log(JSON.stringify(await manager.start(runtimeId, {
      force: !hasFlag(args, "--no-force"),
      warmup: !hasFlag(args, "--no-warmup"),
      reason: "cli-start",
    }), null, 2));
    return;
  }

  if (command === "runtime-warmup") {
    const runtimeId = requireRuntimeId(args, command);
    if (!runtimeId) return;
    const manager = runtimeManagerForCli(config);
    console.log(JSON.stringify(await manager.warmupById(runtimeId), null, 2));
    return;
  }

  if (command === "runtime-stop") {
    const runtimeId = requireRuntimeId(args, command);
    if (!runtimeId) return;
    const manager = runtimeManagerForCli(config);
    console.log(JSON.stringify(await manager.stop(runtimeId), null, 2));
    return;
  }

  if (command === "keep-warm") {
    const manager = runtimeManagerForCli(config);
    console.log(JSON.stringify({
      keepWarm: config.keepWarm ?? [],
      results: await manager.startKeepWarm(),
    }, null, 2));
    return;
  }

  if (command === "doctor") {
    const registry = createRegistry(config);
    const recipes = await loadRecipes();
    const profile = await profileMachine();
    const integrationArtifacts = buildIntegrationArtifacts(config, registry);
    const catalog = await loadBackendCatalog();
    const {
      evidence: benchmarkEvidence,
      validationErrors: benchmarkValidationErrors,
      root: benchmarksRoot,
    } = await loadBenchmarksForCli(args);
    console.log(JSON.stringify({
      ok: benchmarkValidationErrors.length === 0,
      config: config.sourcePath,
      models: registry.catalogModels({ includeAliases: true }).map(model => model.id),
      profile,
      backendCatalog: await planBackendCatalog(catalog, { checkCommands: true }),
      recipes: recipes.map(recipe => planRecipe(recipe, config, {
        backendIds: backendIds(catalog),
        benchmarkEvidence,
        benchmarksRoot,
        benchmarkValidationErrors,
      })),
      benchmarks: {
        root: benchmarksRoot,
        count: benchmarkEvidence.length,
        validationErrors: benchmarkValidationErrors,
        overview: benchmarkOverview(benchmarkEvidence),
      },
      integrations: integrationArtifacts.map(artifact => ({
        id: artifact.id,
        kind: artifact.kind,
        targetPath: artifact.targetPath,
      })),
      defaults: config.defaults,
      configuredBackends: Object.keys(config.backends ?? {}),
      runtimes: Object.keys(config.runtimes ?? {}),
    }, null, 2));
    return;
  }

  console.error(usage());
  process.exitCode = 2;
}

main().catch(error => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
