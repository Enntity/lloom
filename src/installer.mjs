import fs from "node:fs/promises";
import path from "node:path";
import { planBackend } from "./backend-catalog.mjs";
import { repoRoot } from "./config.mjs";
import { runCommand } from "./process-control.mjs";
import { planRecipe } from "./recipes.mjs";

export const defaultInstallStatePath = path.join(repoRoot, "data/install-state.json");

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readInstallState(statePath = defaultInstallStatePath) {
  if (!(await pathExists(statePath))) {
    return {
      version: 1,
      recipes: {},
      backends: {},
    };
  }
  const raw = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  state.recipes ??= {};
  state.backends ??= {};
  return state;
}

export async function writeInstallState(state, statePath = defaultInstallStatePath) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function recipeState(state, recipeId) {
  state.recipes[recipeId] ??= {
    steps: {},
  };
  return state.recipes[recipeId];
}

function backendState(state, backendId) {
  state.backends[backendId] ??= {
    steps: {},
  };
  return state.backends[backendId];
}

function stepCommand(step) {
  if (step.action === "download-model") {
    if (step.provider !== "huggingface") {
      throw new Error(`Unsupported download provider ${step.provider}`);
    }
    return [
      "huggingface-cli",
      "download",
      step.model,
      "--local-dir",
      step.destination,
    ];
  }
  if (Array.isArray(step.command)) return step.command;
  return null;
}

async function executeCommand(commandLine) {
  const [command, ...args] = commandLine;
  if (!command) throw new Error("missing command");
  const result = await runCommand(command, args, { allowFailure: true });
  return {
    command: commandLine,
    code: result.code,
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function writeCommandShim({ source, target }) {
  if (!source || !target) {
    return {
      ok: false,
      error: "missing source or target",
    };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = `#!/bin/sh\nexec ${JSON.stringify(source)} "$@"\n`;
  await fs.writeFile(target, content, { mode: 0o755 });
  await fs.chmod(target, 0o755);
  return {
    ok: true,
    source,
    target,
  };
}

async function executePlannedStep(step) {
  if (step.action === "manual") {
    return {
      ok: false,
      status: "manual-required",
      message: step.description ?? "Manual setup required.",
    };
  }
  if (step.action === "link-command") {
    const result = await writeCommandShim(step.link ?? {});
    return {
      ok: result.ok,
      status: result.ok ? "completed" : "failed",
      stdout: result.ok ? `linked ${result.target} -> ${result.source}` : "",
      stderr: result.ok ? "" : result.error,
      link: step.link,
    };
  }
  const command = stepCommand(step);
  if (!command) {
    return {
      ok: false,
      status: "failed",
      stderr: `Unsupported setup action ${step.action}`,
    };
  }
  const execution = await executeCommand(command);
  return {
    ...execution,
    status: execution.ok ? "completed" : "failed",
  };
}

export async function applyRecipe(recipe, config, {
  dryRun = true,
  yes = false,
  modelRoot = process.env.SWITCHYARD_MODEL_ROOT ?? process.env.SWITCHYARD_MTPLX_MODEL_ROOT ?? path.join(repoRoot, "models"),
  statePath = defaultInstallStatePath,
  onlyStep,
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to execute recipe without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }

  const plan = planRecipe(recipe, config, { modelRoot });
  if (plan.validationErrors.length) {
    throw new Error(`Recipe ${recipe.id} is invalid:\n${plan.validationErrors.map(error => `- ${error}`).join("\n")}`);
  }
  const state = await readInstallState(statePath);
  const currentRecipeState = recipeState(state, recipe.id);
  const results = [];

  for (const step of plan.steps) {
    if (onlyStep && step.id !== onlyStep) continue;
    const previous = currentRecipeState.steps[step.id];
    const command = stepCommand(step);
    if (previous?.status === "completed") {
      results.push({
        ...step,
        command,
        status: "skipped",
        reason: "already-completed",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        ...step,
        command,
        status: "planned",
      });
      continue;
    }

    const startedAt = nowIso();
    currentRecipeState.steps[step.id] = {
      status: "running",
      startedAt,
      command,
    };
    await writeInstallState(state, statePath);

    const execution = await executePlannedStep(step);
    const completedAt = nowIso();
    const status = execution.status ?? (execution.ok ? "completed" : "failed");
    currentRecipeState.steps[step.id] = {
      status,
      startedAt,
      completedAt,
      command,
      code: execution.code,
      stdoutTail: execution.stdout.slice(-4000),
      stderrTail: execution.stderr.slice(-4000),
    };
    await writeInstallState(state, statePath);
    results.push({
      ...step,
      command,
      status,
      code: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr,
    });
    if (!execution.ok) break;
  }

  return {
    dryRun,
    statePath,
    plan,
    results,
  };
}

export async function applyBackend(backend, {
  dryRun = true,
  yes = false,
  statePath = defaultInstallStatePath,
  onlyStep,
  variables,
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to modify backend setup without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }

  const plan = await planBackend(backend, {
    variables,
    checkCommands: true,
  });
  if (!plan.platformSupported) {
    throw new Error(`Backend ${backend.id} is not supported on ${plan.platform}`);
  }

  const state = await readInstallState(statePath);
  const currentBackendState = backendState(state, backend.id);
  const results = [];

  for (const step of plan.steps) {
    if (onlyStep && step.id !== onlyStep) continue;
    const previous = currentBackendState.steps[step.id];
    if (previous?.status === "completed") {
      results.push({
        ...step,
        status: "skipped",
        reason: "already-completed",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        ...step,
        status: "planned",
      });
      continue;
    }

    const startedAt = nowIso();
    currentBackendState.steps[step.id] = {
      status: "running",
      startedAt,
      command: step.command ?? null,
      link: step.link ?? null,
    };
    await writeInstallState(state, statePath);

    const execution = await executePlannedStep(step);
    const completedAt = nowIso();
    const status = execution.status ?? (execution.ok ? "completed" : "failed");
    currentBackendState.steps[step.id] = {
      status,
      startedAt,
      completedAt,
      command: step.command ?? null,
      link: step.link ?? null,
      code: execution.code,
      stdoutTail: String(execution.stdout ?? "").slice(-4000),
      stderrTail: String(execution.stderr ?? "").slice(-4000),
      message: execution.message,
    };
    await writeInstallState(state, statePath);
    results.push({
      ...step,
      status,
      code: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr,
      message: execution.message,
    });

    if (step.action === "command" && !execution.ok) break;
  }

  return {
    dryRun,
    statePath,
    plan,
    results,
  };
}
