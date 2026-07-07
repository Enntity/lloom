import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  backendIds,
  getBackend,
  loadBackendCatalog,
  planBackend,
  planBackendCatalog,
  validateBackendCatalog,
} from "../src/backend-catalog.mjs";
import {
  benchmarkOverview,
  loadBenchmarkEvidence,
  summarizeBenchmarksForRecipe,
  validateBenchmarkEvidence,
} from "../src/benchmarks.mjs";
import { applyBootstrap, createBootstrapPlan } from "../src/bootstrap.mjs";
import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  writeGeneratedIntegrationArtifacts,
} from "../src/client-integrations.mjs";
import { applyInit, createInitPlan, deriveUserConfig } from "../src/init.mjs";
import { applyBackend, applyRecipe, readInstallState } from "../src/installer.mjs";
import { profileMachine, rankRecipes } from "../src/machine-profile.mjs";
import {
  buildRecipeIndexReport,
  loadRecipeIndex,
  validateRecipeIndex,
} from "../src/recipe-index.mjs";
import { loadConfig } from "../src/config.mjs";
import { runCommand } from "../src/process-control.mjs";
import { createRegistry } from "../src/registry.mjs";
import { loadRecipeById, loadRecipes, planRecipe } from "../src/recipes.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { createSwitchyardServer } from "../src/server.mjs";
import { applySetup, createSetupPlan } from "../src/setup.mjs";

function listen(server, host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

async function tryListen(server, host = "127.0.0.1", port = 0) {
  try {
    await listen(server, host, port);
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    console.warn(`skipping HTTP listener smoke: ${error.code}`);
    return false;
  }
}

async function allocatePort() {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const listened = await tryListen(server);
  if (!listened) return null;
  const { port } = server.address();
  await closeServer(server);
  return port;
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const config = await loadConfig();
const registry = createRegistry(config);
const backendCatalog = await loadBackendCatalog();
assert.deepEqual(validateBackendCatalog(backendCatalog), []);
assert(backendCatalog.backends.length >= 6);
assert(backendIds(backendCatalog).has("mtplx"));
assert(backendIds(backendCatalog).has("llama-cpp"));
assert(backendIds(backendCatalog).has("ollama"));
const mtplxBackend = getBackend(backendCatalog, "mtplx");
assert(mtplxBackend);
const mtplxPlan = await planBackend(mtplxBackend, { checkCommands: false });
assert.equal(mtplxPlan.id, "mtplx");
assert.equal(mtplxPlan.platform, `${process.platform}-${process.arch}`);
assert(mtplxPlan.features.includes("mtp"));
assert(mtplxPlan.steps.some(step => step.action === "link-command"));
const allBackendPlans = await planBackendCatalog(backendCatalog, { checkCommands: false });
assert(allBackendPlans.some(plan => plan.id === "vllm"));

const models = registry.openAIModels().map(model => model.id);
assert(models.includes("Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"));
assert(models.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16"));
assert(!models.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed"));
assert(!models.includes("qwen36-27b-fastest"));
assert(!models.includes("qwen36-35b-fastest"));

const clientModels = registry.clientModels({ kinds: ["chat"] }).map(model => model.id);
assert.deepEqual(clientModels, [
  "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
  "Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16",
]);

const resolved27b = registry.resolve("qwen36-27b-fastest");
assert.equal(resolved27b.model.id, "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed");

assert.throws(
  () => registry.resolve("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed"),
  /unknown local model/,
);

const recipe = await loadRecipeById("apple-silicon-qwen36");
const loadedRecipes = await loadRecipes();
assert.deepEqual(loadedRecipes.map(candidate => candidate.id), ["apple-silicon-qwen36"]);
const benchmarkEvidence = await loadBenchmarkEvidence();
assert.equal(benchmarkEvidence.length, 2);
assert.deepEqual(validateBenchmarkEvidence(benchmarkEvidence), []);
const benchmarkRanking = benchmarkOverview(benchmarkEvidence);
assert.equal(benchmarkRanking[0].model, "Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16");
assert.equal(benchmarkRanking[1].model, "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed");
const benchmarkSummary = summarizeBenchmarksForRecipe(recipe, benchmarkEvidence);
assert.equal(benchmarkSummary.length, 2);
assert.equal(benchmarkSummary.find(summary => summary.role === "fastest-27b")?.best?.metrics.generationTokPerSec, 25.47);
assert.equal(benchmarkSummary.find(summary => summary.role === "fastest-35b-a3b")?.best?.metrics.generationTokPerSec, 68.58);
const recipePlan = planRecipe(recipe, config, {
  modelRoot: "/models",
  backendIds: backendIds(backendCatalog),
  benchmarkEvidence,
  benchmarksRoot: "benchmarks/community",
  benchmarkValidationErrors: [],
});
assert.equal(recipePlan.platform, `${process.platform}-${process.arch}`);
assert.deepEqual(recipePlan.validationErrors, []);
assert.equal(recipePlan.benchmarks.validationErrors.length, 0);
assert.equal(recipePlan.models.find(model => model.role === "fastest-27b")?.benchmark.best.metrics.generationTokPerSec, 25.47);
assert(recipePlan.steps.some(step => step.action === "download-model" &&
  step.model === "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"));
assert(recipePlan.steps.some(step => step.command?.join(" ") ===
  "mtplx tune --model /models/Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed --retune"));

const recipeIndex = await loadRecipeIndex();
assert.deepEqual(validateRecipeIndex(recipeIndex), []);
const duplicateRecipeIndex = structuredClone(recipeIndex);
duplicateRecipeIndex.recipes.push({
  ...duplicateRecipeIndex.recipes[0],
});
assert(validateRecipeIndex(duplicateRecipeIndex).some(error => error.includes("duplicate recipe index id")));
const recipeIndexReport = await buildRecipeIndexReport(config, {
  modelRoot: "/models",
  backendIds: backendIds(backendCatalog),
  benchmarkEvidence,
  benchmarksRoot: "benchmarks/community",
  benchmarkValidationErrors: [],
});
assert.equal(recipeIndexReport.ok, true);
assert.equal(recipeIndexReport.index.id, "switchyard-community-recipes");
assert.equal(recipeIndexReport.recipes.length, 1);
assert.equal(recipeIndexReport.recipes[0].id, "apple-silicon-qwen36");
assert.equal(recipeIndexReport.recipes[0].ok, true);
assert.equal(recipeIndexReport.recipes[0].commands.plan,
  "switchyard plan apple-silicon-qwen36 --model-root /models");
assert.equal(recipeIndexReport.recipes[0].commands.installApply,
  "switchyard install apple-silicon-qwen36 --model-root /models --apply --yes");
assert.equal(
  recipeIndexReport.recipes[0].models.find(model => model.role === "fastest-35b-a3b")?.benchmark.best.id,
  "qwen36-35b-a3b-mtplx-speed-fp16-m2max-d1",
);

const profile = await profileMachine();
assert.equal(profile.platformId, `${process.platform}-${process.arch}`);
assert(profile.totalMemoryGb > 0);
const rankedRecipes = await rankRecipes([recipe], profile, { checkCommands: false });
assert.equal(rankedRecipes[0].recipeId, "apple-silicon-qwen36");

const installDryRun = await applyRecipe(recipe, config, {
  dryRun: true,
  modelRoot: "/models",
  statePath: path.join(os.tmpdir(), `switchyard-dry-run-${process.pid}.json`),
});
assert.equal(installDryRun.dryRun, true);
assert(installDryRun.results.every(step => step.status === "planned"));

await assert.rejects(
  () => applyRecipe(recipe, config, {
    dryRun: false,
    modelRoot: "/models",
    statePath: path.join(os.tmpdir(), `switchyard-refuse-${process.pid}.json`),
  }),
  /Refusing to execute recipe/,
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "switchyard-installer-"));
const statePath = path.join(tempDir, "state.json");

const derivedConfig = deriveUserConfig(config, recipe, {
  modelRoot: "/models",
});
assert.equal(derivedConfig.sourcePath, undefined);
assert.equal(derivedConfig.runtimes["mtplx-qwen36-27b-speed"].enabled, true);
assert.equal(derivedConfig.runtimes["mtplx-qwen36-27b-speed"].args.at(2),
  "/models/Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed");
assert.deepEqual(derivedConfig.keepWarm, ["mtplx-qwen36-27b-speed"]);

const initPlan = await createInitPlan(config, {
  recipeId: "apple-silicon-qwen36",
  configPath: path.join(tempDir, "config.json"),
  modelRoot: "/models",
  home: tempDir,
  generatedRoot: path.join(tempDir, "generated"),
  clientId: "omp",
  backendVariables: {
    shimDir: path.join(tempDir, "init-bin"),
    backendRoot: path.join(tempDir, "backends"),
    installRoot: path.join(tempDir, "install"),
    repoParent: path.dirname(process.cwd()),
    modelRoot: "/models",
  },
});
assert.equal(initPlan.dryRun, true);
assert.equal(initPlan.configPath, path.join(tempDir, "config.json"));
assert.deepEqual(initPlan.keepWarm, ["mtplx-qwen36-27b-speed"]);
assert.deepEqual(initPlan.integrations.map(integration => integration.id), ["omp-models", "omp-config"]);
assert.equal(initPlan.config.runtimes["mtplx-qwen36-27b-speed"].enabled, true);
assert(initPlan.next.apply.includes("--model-root '/models'"));
assert(initPlan.next.apply.includes("--client 'omp'"));

const initPlanWithDefaultModelRoot = await createInitPlan(config, {
  recipeId: "apple-silicon-qwen36",
  home: tempDir,
  generatedRoot: path.join(tempDir, "generated-default-root"),
  clientId: "omp",
});
assert.equal(initPlanWithDefaultModelRoot.configPath, path.join(tempDir, ".switchyard", "config.json"));
assert.equal(initPlanWithDefaultModelRoot.modelRoot, path.join(tempDir, ".switchyard", "models"));
assert.equal(
  initPlanWithDefaultModelRoot.config.runtimes["mtplx-qwen36-27b-speed"].args.at(2),
  path.join(tempDir, ".switchyard", "models", "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"),
);

await assert.rejects(
  () => applyInit(config, {
    dryRun: false,
    configPath: path.join(tempDir, "refuse-config.json"),
    modelRoot: "/models",
    home: tempDir,
    generatedRoot: path.join(tempDir, "generated-refuse"),
  }),
  /Refusing to initialize Switchyard/,
);

const initApply = await applyInit(config, {
  dryRun: false,
  yes: true,
  recipeId: "apple-silicon-qwen36",
  configPath: path.join(tempDir, "applied-config.json"),
  modelRoot: "/models",
  home: tempDir,
  generatedRoot: path.join(tempDir, "generated-applied"),
  clientId: "omp",
});
assert.equal(initApply.dryRun, false);
const appliedConfig = JSON.parse(await fs.readFile(path.join(tempDir, "applied-config.json"), "utf8"));
assert.equal(appliedConfig.runtimes["mtplx-qwen36-27b-speed"].enabled, true);
assert.deepEqual(appliedConfig.keepWarm, ["mtplx-qwen36-27b-speed"]);
const initGeneratedOmp = await fs.readFile(path.join(tempDir, "generated-applied", "omp-models.yml"), "utf8");
assert(initGeneratedOmp.includes("Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"));
const initGeneratedOmpConfig = await fs.readFile(path.join(tempDir, "generated-applied", "omp-config.yml"), "utf8");
assert(initGeneratedOmpConfig.includes("default: local-llm/Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed:low"));
await assert.rejects(
  () => fs.access(path.join(tempDir, "generated-applied", "opencode.json")),
  /ENOENT/,
);
assert.equal(initApply.written.integrations.results[0].status, "not-applied");

const runtimePort = await allocatePort();
if (runtimePort) {
  const runtimeScript = path.join(tempDir, "synthetic-runtime.mjs");
  await fs.writeFile(runtimeScript, `
import http from "node:http";

const port = Number(process.argv[2]);
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_synthetic",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  const lifecycleConfig = {
    keepWarm: ["synthetic-runtime"],
    runtimes: {
      "synthetic-runtime": {
        enabled: true,
        command: process.execPath,
        args: [runtimeScript, String(runtimePort)],
        port: runtimePort,
        healthUrl: `http://127.0.0.1:${runtimePort}/health`,
        startupTimeoutMs: 5000,
        warmup: {
          url: `http://127.0.0.1:${runtimePort}/v1/chat/completions`,
          body: {
            model: "synthetic",
            messages: [{ role: "user", content: "warm up" }],
            max_tokens: 1,
          },
        },
      },
    },
  };
  const lifecycleManager = new RuntimeManager(lifecycleConfig, {
    logger: { error() {} },
  });
  const startResult = await lifecycleManager.ensure("synthetic-runtime");
  assert.equal(startResult.started, true);
  assert.equal(startResult.healthy, true);
  assert.equal(startResult.warmup.warmed, true);
  const lifecycleStatus = await lifecycleManager.status();
  assert.equal(lifecycleStatus.runtimes["synthetic-runtime"].status, "running");
  assert.equal(lifecycleStatus.runtimes["synthetic-runtime"].healthy, true);
  assert.equal(lifecycleStatus.runtimes["synthetic-runtime"].keepWarm, true);
  assert.equal(lifecycleStatus.runtimes["synthetic-runtime"].lastWarmup.warmed, true);
  const warmupAgain = await lifecycleManager.warmupById("synthetic-runtime");
  assert.equal(warmupAgain.warmed, true);
  const keepWarmResult = await lifecycleManager.startKeepWarm();
  assert.equal(keepWarmResult[0].reason, "already-healthy");
  const stopResult = await lifecycleManager.stop("synthetic-runtime");
  assert.equal(stopResult.stopped, true);

  const cliConfigPath = path.join(tempDir, "runtime-cli-config.json");
  await fs.writeFile(cliConfigPath, `${JSON.stringify(lifecycleConfig, null, 2)}\n`, "utf8");
  const runSwitchyard = async args => runCommand(process.execPath, [
    path.join(process.cwd(), "bin", "switchyard.mjs"),
    ...args,
    "--config",
    cliConfigPath,
  ]);

  const cliStatus = JSON.parse((await runSwitchyard(["runtimes", "synthetic-runtime"])).stdout);
  assert.equal(cliStatus.runtimes["synthetic-runtime"].healthy, false);
  assert.equal(cliStatus.runtimes["synthetic-runtime"].keepWarm, true);

  const cliStart = JSON.parse((await runSwitchyard(["runtime-start", "synthetic-runtime"])).stdout);
  assert.equal(cliStart.started, true);
  assert.equal(cliStart.healthy, true);
  assert.equal(cliStart.warmup.warmed, true);

  const cliWarmup = JSON.parse((await runSwitchyard(["runtime-warmup", "synthetic-runtime"])).stdout);
  assert.equal(cliWarmup.warmed, true);

  const cliKeepWarm = JSON.parse((await runSwitchyard(["keep-warm"])).stdout);
  assert.equal(cliKeepWarm.results[0].runtimeId, "synthetic-runtime");
  assert.equal(cliKeepWarm.results[0].healthy, true);

  const cliRunningStatus = JSON.parse((await runSwitchyard(["runtimes", "synthetic-runtime"])).stdout);
  assert.equal(cliRunningStatus.runtimes["synthetic-runtime"].healthy, true);
  assert.equal(cliRunningStatus.runtimes["synthetic-runtime"].status, "external");

  const cliStop = JSON.parse((await runSwitchyard(["runtime-stop", "synthetic-runtime"])).stdout);
  assert.equal(cliStop.stopped, true);
}

const syntheticRecipe = {
  id: "synthetic",
  name: "Synthetic",
  backend: {
    id: "test",
  },
  models: [
    {
      role: "test",
      model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
      gatewayModel: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
      runtime: "mtplx-qwen36-27b-speed",
    },
  ],
  setup: {
    steps: [
      {
        id: "true",
        action: "command",
        command: "/usr/bin/true",
      },
    ],
  },
};
const applied = await applyRecipe(syntheticRecipe, config, {
  dryRun: false,
  yes: true,
  statePath,
});
assert.equal(applied.results[0].status, "completed");
const appliedAgain = await applyRecipe(syntheticRecipe, config, {
  dryRun: false,
  yes: true,
  statePath,
});
assert.equal(appliedAgain.results[0].status, "skipped");

const hfShim = path.join(tempDir, "hf");
const hfLogPath = path.join(tempDir, "hf.log");
await fs.writeFile(hfShim, `#!/bin/sh
echo "$@" >> ${JSON.stringify(hfLogPath)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--local-dir" ]; then
    shift
    mkdir -p "$1"
    echo downloaded > "$1/config.json"
  fi
  shift
done
`, { mode: 0o755 });
await fs.chmod(hfShim, 0o755);
const previousHfBin = process.env.SWITCHYARD_HF_BIN;
process.env.SWITCHYARD_HF_BIN = hfShim;
try {
  const downloadRecipe = {
    id: "synthetic-download",
    name: "Synthetic Download",
    backend: {
      id: "test",
    },
    models: [
      {
        role: "test",
        model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
        gatewayModel: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
        runtime: "mtplx-qwen36-27b-speed",
      },
    ],
    setup: {
      steps: [
        {
          id: "download",
          action: "download-model",
          provider: "huggingface",
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
        },
      ],
    },
  };
  const downloadModelRoot = path.join(tempDir, "download-models");
  const downloadStatePath = path.join(tempDir, "download-state.json");
  const downloadDryRun = await applyRecipe(downloadRecipe, config, {
    dryRun: true,
    yes: false,
    modelRoot: downloadModelRoot,
    statePath: downloadStatePath,
  });
  assert.equal(downloadDryRun.results[0].status, "planned");
  assert.equal(downloadDryRun.results[0].command[0], hfShim);
  const downloadApplied = await applyRecipe(downloadRecipe, config, {
    dryRun: false,
    yes: true,
    modelRoot: downloadModelRoot,
    statePath: downloadStatePath,
  });
  assert.equal(downloadApplied.results[0].status, "completed");
  assert.equal(downloadApplied.results[0].command[0], hfShim);
  assert.equal(
    await fs.readFile(path.join(downloadModelRoot, "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed", "config.json"), "utf8"),
    "downloaded\n",
  );

  process.env.SWITCHYARD_HF_BIN = path.join(tempDir, "missing-hf");
  const existingStatePath = path.join(tempDir, "download-existing-state.json");
  const existingApplied = await applyRecipe(downloadRecipe, config, {
    dryRun: false,
    yes: true,
    modelRoot: downloadModelRoot,
    statePath: existingStatePath,
  });
  assert.equal(existingApplied.results[0].status, "skipped");
  assert.equal(existingApplied.results[0].reason, "destination-populated");
  const existingState = await readInstallState(existingStatePath);
  assert.equal(existingState.recipes["synthetic-download"].steps.download.status, "completed");
} finally {
  if (previousHfBin == null) {
    delete process.env.SWITCHYARD_HF_BIN;
  } else {
    process.env.SWITCHYARD_HF_BIN = previousHfBin;
  }
}

const syntheticBin = path.join(tempDir, "synthetic-backend");
await fs.writeFile(syntheticBin, "#!/bin/sh\necho synthetic-ok\n", { mode: 0o755 });
await fs.chmod(syntheticBin, 0o755);
const syntheticBackend = {
  id: "synthetic-backend",
  name: "Synthetic Backend",
  kind: "openai-compatible-server",
  platforms: [`${process.platform}-${process.arch}`],
  features: ["chat"],
  commands: ["synthetic-backend"],
  setup: [
    {
      id: "link-synthetic",
      title: "Link synthetic backend",
      action: "link-command",
      commandName: "synthetic-backend",
      sourceCandidates: [syntheticBin],
    },
  ],
};
const backendStatePath = path.join(tempDir, "backend-state.json");
const backendDryRun = await applyBackend(syntheticBackend, {
  dryRun: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, "bin"),
  },
});
assert.equal(backendDryRun.results[0].status, "planned");
await assert.rejects(
  () => applyBackend(syntheticBackend, {
    dryRun: false,
    statePath: backendStatePath,
    variables: {
      shimDir: path.join(tempDir, "bin"),
    },
  }),
  /Refusing to modify backend setup/,
);
const backendApplied = await applyBackend(syntheticBackend, {
  dryRun: false,
  yes: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, "bin"),
  },
});
assert.equal(backendApplied.results[0].status, "completed");
const shimPath = path.join(tempDir, "bin", "synthetic-backend");
const shimResult = await runCommand(shimPath, [], { allowFailure: true });
assert.equal(shimResult.code, 0);
assert.equal(shimResult.stdout.trim(), "synthetic-ok");
const backendAppliedAgain = await applyBackend(syntheticBackend, {
  dryRun: false,
  yes: true,
  statePath: backendStatePath,
  variables: {
    shimDir: path.join(tempDir, "bin"),
  },
});
assert.equal(backendAppliedAgain.results[0].status, "skipped");

const generatedOmp = await fs.readFile(path.join("clients", "examples", "omp-models.yml"), "utf8");
assert(generatedOmp.includes("Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"));
assert(generatedOmp.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16"));
assert(!generatedOmp.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n"));
const generatedOmpConfig = await fs.readFile(path.join("clients", "examples", "omp-config.yml"), "utf8");
assert(generatedOmpConfig.includes("default: local-llm/Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed:low"));
assert(!generatedOmpConfig.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed"));

const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "switchyard-generated-"));
const integrationArtifacts = buildIntegrationArtifacts(config, registry, {
  home: tempDir,
  generatedRoot,
});
assert.deepEqual(
  integrationArtifacts.map(artifact => artifact.id),
  ["omp-models", "omp-config", "opencode", "codex", "claude", "hermes", "zero", "manifest"],
);
assert(integrationArtifacts.every(artifact =>
  artifact.content.includes("Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed")));
assert(integrationArtifacts.every(artifact =>
  !artifact.content.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n")));

await writeGeneratedIntegrationArtifacts(config, registry, {
  home: tempDir,
  generatedRoot,
});
const generatedCodex = await fs.readFile(path.join(generatedRoot, "codex.env"), "utf8");
assert(generatedCodex.includes("OPENAI_BASE_URL"));
assert(generatedCodex.includes("OPENAI_MODEL='Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed'"));

const integrationDryRun = await applyIntegrationArtifacts(config, registry, {
  clientId: "all",
  dryRun: true,
  home: tempDir,
  generatedRoot,
});
assert(integrationDryRun.results.every(result => result.status === "planned"));

await assert.rejects(
  () => applyIntegrationArtifacts(config, registry, {
    clientId: "omp",
    dryRun: false,
    home: tempDir,
    generatedRoot,
  }),
  /Refusing to modify client integration files/,
);

const integrationApply = await applyIntegrationArtifacts(config, registry, {
  clientId: "omp",
  dryRun: false,
  yes: true,
  home: tempDir,
  generatedRoot,
});
assert.equal(integrationApply.results[0].status, "written");
assert.equal(integrationApply.results[1].status, "written");
const tempOmp = await fs.readFile(path.join(tempDir, ".omp", "agent", "models.yml"), "utf8");
assert(tempOmp.includes("Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"));
assert(!tempOmp.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed\n"));
const tempOmpConfig = await fs.readFile(path.join(tempDir, ".omp", "agent", "config.yml"), "utf8");
assert(tempOmpConfig.includes("default: local-llm/Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed:low"));
assert(!tempOmpConfig.includes("Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed"));

const bootstrapPlan = await createBootstrapPlan(config, {
  recipeId: "apple-silicon-qwen36",
  modelRoot: "/models",
  clientId: "omp",
  home: tempDir,
  backendVariables: {
    shimDir: path.join(tempDir, "bootstrap-bin"),
    backendRoot: path.join(tempDir, "backends"),
    installRoot: path.join(tempDir, "install"),
    repoParent: path.dirname(process.cwd()),
    modelRoot: "/models",
  },
});
assert.equal(bootstrapPlan.selectedRecipe.id, "apple-silicon-qwen36");
assert.equal(bootstrapPlan.backend.id, "mtplx");
assert.equal(bootstrapPlan.recipe.validationErrors.length, 0);
assert.equal(bootstrapPlan.benchmarks.validationErrors.length, 0);
assert.equal(bootstrapPlan.recipe.models.find(model => model.role === "fastest-27b")?.benchmark.best.id,
  "qwen36-27b-mtplx-speed-m2max-d3");
assert.deepEqual(bootstrapPlan.integrations.map(integration => integration.id), ["omp-models", "omp-config"]);
assert(bootstrapPlan.next.pathHint.includes("bootstrap-bin"));

const bootstrapDryRun = await applyBootstrap(config, {
  recipeId: "apple-silicon-qwen36",
  modelRoot: "/models",
  clientId: "omp",
  dryRun: true,
  statePath: path.join(tempDir, "bootstrap-state.json"),
  home: tempDir,
  backendVariables: {
    shimDir: path.join(tempDir, "bootstrap-bin"),
    backendRoot: path.join(tempDir, "backends"),
    installRoot: path.join(tempDir, "install"),
    repoParent: path.dirname(process.cwd()),
    modelRoot: "/models",
  },
});
assert.equal(bootstrapDryRun.dryRun, true);
assert(bootstrapDryRun.backend.results.every(result => result.status === "planned"));
assert(bootstrapDryRun.recipe.results.every(result => result.status === "planned"));
assert(bootstrapDryRun.integrations.results.every(result => result.status === "planned"));
await assert.rejects(
  () => applyBootstrap(config, {
    recipeId: "apple-silicon-qwen36",
    modelRoot: "/models",
    clientId: "omp",
    dryRun: false,
    statePath: path.join(tempDir, "bootstrap-refuse-state.json"),
    home: tempDir,
  }),
  /Refusing to bootstrap/,
);

const setupBackendVariables = {
  shimDir: path.join(tempDir, "setup-bin"),
  backendRoot: path.join(tempDir, "setup-backends"),
  installRoot: path.join(tempDir, "setup-install"),
  repoParent: path.dirname(process.cwd()),
  modelRoot: "/models",
};
const setupPlan = await createSetupPlan(config, {
  recipeId: "apple-silicon-qwen36",
  configPath: path.join(tempDir, "setup-config.json"),
  modelRoot: "/models",
  clientId: "omp",
  home: tempDir,
  generatedRoot: path.join(tempDir, "setup-generated"),
  backendVariables: setupBackendVariables,
});
assert.equal(setupPlan.dryRun, true);
assert.equal(setupPlan.configPath, path.join(tempDir, "setup-config.json"));
assert.equal(setupPlan.selectedRecipe.id, "apple-silicon-qwen36");
assert.deepEqual(setupPlan.keepWarm, ["mtplx-qwen36-27b-speed"]);
assert.equal(setupPlan.phases.init.config.runtimes["mtplx-qwen36-27b-speed"].enabled, true);
assert.equal(setupPlan.phases.bootstrap.recipe.validationErrors.length, 0);
assert(setupPlan.phases.bootstrap.integrations.every(integration =>
  integration.generatedPath.startsWith(path.join(tempDir, "setup-generated"))));
assert(setupPlan.next.apply.includes("switchyard setup"));
assert(setupPlan.next.applyAndStart.includes("--start"));

const setupDryRun = await applySetup(config, {
  recipeId: "apple-silicon-qwen36",
  configPath: path.join(tempDir, "setup-apply-config.json"),
  modelRoot: "/models",
  clientId: "omp",
  dryRun: true,
  home: tempDir,
  generatedRoot: path.join(tempDir, "setup-apply-generated"),
  backendVariables: setupBackendVariables,
});
assert.equal(setupDryRun.dryRun, true);
assert.equal(setupDryRun.phases.bootstrap.backend.id, "mtplx");
assert(setupDryRun.phases.bootstrap.integrations.every(integration =>
  integration.generatedPath.startsWith(path.join(tempDir, "setup-apply-generated"))));

await assert.rejects(
  () => applySetup(config, {
    recipeId: "apple-silicon-qwen36",
    configPath: path.join(tempDir, "setup-refuse-config.json"),
    modelRoot: "/models",
    clientId: "omp",
    dryRun: false,
    home: tempDir,
    backendVariables: setupBackendVariables,
  }),
  /Refusing to run setup/,
);

const setupCli = await runCommand(process.execPath, [
  path.join(process.cwd(), "bin", "switchyard.mjs"),
  "setup",
  "--recipe",
  "apple-silicon-qwen36",
  "--config-out",
  path.join(tempDir, "setup-cli-config.json"),
  "--model-root",
  "/models",
  "--client",
  "omp",
]);
const setupCliJson = JSON.parse(setupCli.stdout);
assert.equal(setupCliJson.selectedRecipe.id, "apple-silicon-qwen36");
assert.equal(setupCliJson.phases.init.configPath, path.join(tempDir, "setup-cli-config.json"));
assert.equal(setupCliJson.phases.bootstrap.recipe.validationErrors.length, 0);

const testConfig = structuredClone(config);
testConfig.server = {
  host: "127.0.0.1",
  port: 0,
};
const app = createSwitchyardServer(testConfig, {
  logger: {
    error() {},
  },
});
const listened = await tryListen(app.server);

if (listened) {
  const { port } = app.server.address();
  try {
    const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    const modelsJson = await modelsResponse.json();
    assert(modelsJson.data.some(model => model.id === "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed"));
    assert(modelsJson.data.some(model => model.id === "Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16"));
    assert(!modelsJson.data.some(model => model.id === "Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed"));
    assert(!modelsJson.data.some(model => model.id === "qwen36-27b-fastest"));
    assert(!modelsJson.data.some(model => model.id === "qwen36-35b-fastest"));

    const staleResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(staleResponse.status, 404);
  } finally {
    await closeServer(app.server);
  }
}

const adminRuntimePort = await allocatePort();
if (adminRuntimePort) {
  const adminRuntimeScript = path.join(tempDir, "synthetic-admin-runtime.mjs");
  await fs.writeFile(adminRuntimeScript, `
import http from "node:http";

const port = Number(process.argv[2]);
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_admin",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  const adminConfig = structuredClone(config);
  adminConfig.server = {
    host: "127.0.0.1",
    port: 0,
  };
  adminConfig.runtimes = {
    "synthetic-admin-runtime": {
      enabled: false,
      command: process.execPath,
      args: [adminRuntimeScript, String(adminRuntimePort)],
      port: adminRuntimePort,
      healthUrl: `http://127.0.0.1:${adminRuntimePort}/health`,
      startupTimeoutMs: 5000,
      warmup: {
        url: `http://127.0.0.1:${adminRuntimePort}/v1/chat/completions`,
        body: {
          model: "synthetic",
          messages: [{ role: "user", content: "warm up" }],
          max_tokens: 1,
        },
      },
    },
  };
  adminConfig.keepWarm = ["synthetic-admin-runtime"];
  const adminApp = createSwitchyardServer(adminConfig, {
    logger: { error() {} },
  });
  const adminListened = await tryListen(adminApp.server);
  if (adminListened) {
    const { port } = adminApp.server.address();
    try {
      const startResponse = await fetch(`http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warmup: true }),
      });
      assert.equal(startResponse.status, 200);
      const startJson = await startResponse.json();
      assert.equal(startJson.started, true);
      assert.equal(startJson.warmup.warmed, true);

      const warmupResponse = await fetch(`http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/warmup`, {
        method: "POST",
      });
      assert.equal(warmupResponse.status, 200);
      const warmupJson = await warmupResponse.json();
      assert.equal(warmupJson.warmed, true);

      const statusResponse = await fetch(`http://127.0.0.1:${port}/gateway/status`);
      assert.equal(statusResponse.status, 200);
      const statusJson = await statusResponse.json();
      assert.equal(statusJson.runtimeManager.runtimes["synthetic-admin-runtime"].healthy, true);
      assert.equal(statusJson.runtimeManager.runtimes["synthetic-admin-runtime"].keepWarm, true);

      const stopResponse = await fetch(`http://127.0.0.1:${port}/gateway/runtimes/synthetic-admin-runtime/stop`, {
        method: "POST",
      });
      assert.equal(stopResponse.status, 200);
      const stopJson = await stopResponse.json();
      assert.equal(stopJson.stopped, true);
    } finally {
      await closeServer(adminApp.server);
    }
  }
}

const mockUpstream = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const body = await readJsonBody(req);
  assert.equal(body.model, "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed");
  if (body.tools) {
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.name, "get_weather");
    assert.equal(body.tools[0].function.parameters.type, "object");
    assert.equal(body.tool_choice.type, "function");
    assert.equal(body.tool_choice.function.name, "get_weather");
    if (body.stream === true) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_weather",
              type: "function",
              function: {
                name: "get_weather",
                arguments: "{\"city\"",
              },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: ":\"Phoenix\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 17,
          completion_tokens: 4,
          total_tokens: 21,
        },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      id: "chatcmpl_tool",
      object: "chat.completion",
      created: 1,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: "{\"city\":\"Phoenix\"}",
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 17,
        completion_tokens: 4,
        total_tokens: 21,
      },
    }));
    return;
  }
  if (body.stream !== true) {
    assert(Array.isArray(body.messages));
    const toolResultMessage = body.messages.find(message => message.role === "tool");
    if (toolResultMessage) {
      const assistantToolMessage = body.messages.find(message => message.role === "assistant" && message.tool_calls);
      assert.equal(assistantToolMessage.tool_calls[0].id, "call_weather");
      assert.equal(assistantToolMessage.tool_calls[0].function.name, "get_weather");
      assert.equal(assistantToolMessage.tool_calls[0].function.arguments, "{\"city\":\"Phoenix\"}");
      assert.equal(toolResultMessage.tool_call_id, "call_weather");
      assert.equal(toolResultMessage.content, "sunny");
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({
        id: "chatcmpl_tool_result",
        object: "chat.completion",
        created: 1,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "It is sunny.",
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 19,
          completion_tokens: 4,
          total_tokens: 23,
        },
      }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      id: "chatcmpl_mock",
      object: "chat.completion",
      created: 1,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "hello",
        },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
      },
    }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: "hel" }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    },
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

const mockListened = await tryListen(mockUpstream);
if (mockListened) {
  const mockPort = mockUpstream.address().port;
  const streamConfig = structuredClone(config);
  streamConfig.server = {
    host: "127.0.0.1",
    port: 0,
  };
  streamConfig.backends["mtplx-27b"] = {
    ...streamConfig.backends["mtplx-27b"],
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
  };
  const streamApp = createSwitchyardServer(streamConfig, {
    logger: {
      error() {},
    },
  });
  const streamListened = await tryListen(streamApp.server);
  if (streamListened) {
    const { port } = streamApp.server.address();
    try {
      const responsesResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          instructions: "Be terse.",
          input: "say hello",
          max_output_tokens: 8,
        }),
      });
      assert.equal(responsesResponse.status, 200);
      const responsesJson = await responsesResponse.json();
      assert.equal(responsesJson.object, "response");
      assert.equal(responsesJson.output_text, "hello");
      assert.equal(responsesJson.usage.input_tokens, 7);
      assert.equal(responsesJson.usage.output_tokens, 2);

      const responsesStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          input: [{
            role: "user",
            content: [{
              type: "input_text",
              text: "say hello",
            }],
          }],
          max_output_tokens: 8,
          stream: true,
        }),
      });
      assert.equal(responsesStreamResponse.status, 200);
      assert.match(responsesStreamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
      const responsesStreamText = await responsesStreamResponse.text();
      assert(responsesStreamText.includes("event: response.created"));
      assert(responsesStreamText.includes("event: response.output_text.delta"));
      assert(responsesStreamText.includes('"delta":"hel"'));
      assert(responsesStreamText.includes('"delta":"lo"'));
      assert(responsesStreamText.includes("event: response.completed"));
      assert(responsesStreamText.includes('"input_tokens":11'));

      const responsesToolResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          input: "weather please",
          max_output_tokens: 32,
          tools: [{
            type: "function",
            name: "get_weather",
            description: "Get local weather.",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          }],
          tool_choice: {
            type: "function",
            name: "get_weather",
          },
        }),
      });
      assert.equal(responsesToolResponse.status, 200);
      const responsesToolJson = await responsesToolResponse.json();
      assert.equal(responsesToolJson.output_text, "");
      assert.deepEqual(responsesToolJson.output, [{
        id: "call_weather",
        type: "function_call",
        status: "completed",
        call_id: "call_weather",
        name: "get_weather",
        arguments: "{\"city\":\"Phoenix\"}",
      }]);
      assert.equal(responsesToolJson.usage.input_tokens, 17);

      const responsesToolResultResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          input: [
            {
              type: "function_call",
              call_id: "call_weather",
              name: "get_weather",
              arguments: "{\"city\":\"Phoenix\"}",
            },
            {
              type: "function_call_output",
              call_id: "call_weather",
              output: "sunny",
            },
          ],
          max_output_tokens: 32,
        }),
      });
      assert.equal(responsesToolResultResponse.status, 200);
      const responsesToolResultJson = await responsesToolResultResponse.json();
      assert.equal(responsesToolResultJson.output_text, "It is sunny.");
      assert.equal(responsesToolResultJson.usage.input_tokens, 19);

      const responsesToolStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          input: "weather please",
          max_output_tokens: 32,
          stream: true,
          tools: [{
            type: "function",
            name: "get_weather",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          }],
          tool_choice: {
            type: "function",
            name: "get_weather",
          },
        }),
      });
      assert.equal(responsesToolStreamResponse.status, 200);
      assert.match(responsesToolStreamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
      const responsesToolStreamText = await responsesToolStreamResponse.text();
      assert(responsesToolStreamText.includes("event: response.output_item.added"));
      assert(responsesToolStreamText.includes('"type":"function_call"'));
      assert(responsesToolStreamText.includes('"name":"get_weather"'));
      assert(responsesToolStreamText.includes("event: response.function_call_arguments.delta"));
      assert(responsesToolStreamText.includes('"delta":"{\\"city\\""'));
      assert(responsesToolStreamText.includes('"delta":":\\"Phoenix\\"}"'));
      assert(responsesToolStreamText.includes("event: response.function_call_arguments.done"));
      assert(responsesToolStreamText.includes('"arguments":"{\\"city\\":\\"Phoenix\\"}"'));
      assert(responsesToolStreamText.includes('"input_tokens":17'));

      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          max_tokens: 8,
          stream: true,
          messages: [
            {
              role: "user",
              content: "say hello",
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const streamText = await response.text();
      assert(streamText.includes("event: message_start"));
      assert(streamText.includes("event: content_block_delta"));
      assert(streamText.includes('"text":"hel"'));
      assert(streamText.includes('"text":"lo"'));
      assert(streamText.includes('"input_tokens":11'));
      assert(streamText.includes("event: message_stop"));

      const toolResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          max_tokens: 32,
          tools: [{
            name: "get_weather",
            description: "Get local weather.",
            input_schema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          }],
          tool_choice: {
            type: "tool",
            name: "get_weather",
          },
          messages: [
            {
              role: "user",
              content: "weather please",
            },
          ],
        }),
      });
      assert.equal(toolResponse.status, 200);
      const toolJson = await toolResponse.json();
      assert.equal(toolJson.stop_reason, "tool_use");
      assert.equal(toolJson.usage.input_tokens, 17);
      assert.equal(toolJson.usage.output_tokens, 4);
      assert.deepEqual(toolJson.content, [{
        type: "tool_use",
        id: "call_weather",
        name: "get_weather",
        input: {
          city: "Phoenix",
        },
      }]);

      const toolResultResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          max_tokens: 32,
          messages: [
            {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "call_weather",
                name: "get_weather",
                input: {
                  city: "Phoenix",
                },
              }],
            },
            {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "call_weather",
                content: "sunny",
              }],
            },
          ],
        }),
      });
      assert.equal(toolResultResponse.status, 200);
      const toolResultJson = await toolResultResponse.json();
      assert.equal(toolResultJson.content[0].text, "It is sunny.");
      assert.equal(toolResultJson.usage.input_tokens, 19);

      const toolStreamResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed",
          max_tokens: 32,
          stream: true,
          tools: [{
            name: "get_weather",
            input_schema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          }],
          tool_choice: {
            type: "tool",
            name: "get_weather",
          },
          messages: [
            {
              role: "user",
              content: "weather please",
            },
          ],
        }),
      });
      assert.equal(toolStreamResponse.status, 200);
      assert.match(toolStreamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
      const toolStreamText = await toolStreamResponse.text();
      assert(toolStreamText.includes("event: content_block_start"));
      assert(toolStreamText.includes('"type":"tool_use"'));
      assert(toolStreamText.includes('"name":"get_weather"'));
      assert(toolStreamText.includes('"type":"input_json_delta"'));
      assert(toolStreamText.includes('"partial_json":"{\\"city\\""'));
      assert(toolStreamText.includes('"partial_json":":\\"Phoenix\\"}"'));
      assert(toolStreamText.includes('"stop_reason":"tool_use"'));
      assert(toolStreamText.includes('"input_tokens":17'));
    } finally {
      await closeServer(streamApp.server);
      await closeServer(mockUpstream);
    }
  } else {
    await closeServer(mockUpstream);
  }
}

console.log("smoke ok");
