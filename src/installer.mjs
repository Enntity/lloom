import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { planBackend } from './backend-catalog.mjs';
import { defaultLloomHome, defaultUserModelRoot } from './config.mjs';
import { modelDirectoryComplete } from './model-files.mjs';
import { runCommand } from './process-control.mjs';
import { planRecipe } from './recipes.mjs';

export function defaultInstallStatePathFor(env = process.env) {
  return path.join(defaultLloomHome(env), 'install-state.json');
}
export const defaultInstallStatePath = defaultInstallStatePathFor();

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExecutable(filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
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
      backends: {}
    };
  }
  const raw = await fs.readFile(statePath, 'utf8');
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

function asList(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function recipeState(state, recipeId) {
  state.recipes[recipeId] ??= {
    steps: {}
  };
  return state.recipes[recipeId];
}

function backendState(state, backendId) {
  state.backends[backendId] ??= {
    steps: {}
  };
  return state.backends[backendId];
}

function huggingFaceCommandCandidates(step) {
  const configured = process.env.LLOOM_HF_BIN || process.env.HF_HUB_CLI;
  return [configured, 'hf', 'huggingface-cli']
    .filter(Boolean)
    .map((command) => [command, 'download', step.model, '--local-dir', step.destination]);
}

async function commandAvailable(command, { env = process.env } = {}) {
  if (command.includes('/') || path.isAbsolute(command)) {
    return pathExecutable(command);
  }
  const result = await runCommand('/usr/bin/which', [command], { allowFailure: true, env });
  return result.code === 0 && Boolean(result.stdout.trim());
}

function pythonExecutableForVenv(venvPath) {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

async function resolveHuggingFaceDownloadCommand(step, { env = process.env } = {}) {
  for (const candidate of huggingFaceCommandCandidates(step)) {
    if (await commandAvailable(candidate[0], { env })) return candidate;
  }
  return null;
}

function stepCommand(step, { preferConfigured = true } = {}) {
  if (step.action === 'download-model') {
    if (step.provider !== 'huggingface') {
      throw new Error(`Unsupported download provider ${step.provider}`);
    }
    const candidates = huggingFaceCommandCandidates(step);
    return preferConfigured ? candidates[0] : candidates.at(-1);
  }
  if (Array.isArray(step.command)) return step.command;
  return null;
}

async function executeCommand(commandLine, { env = process.env, stdio } = {}) {
  const [command, ...args] = commandLine;
  if (!command) throw new Error('missing command');
  const result = await runCommand(command, args, { allowFailure: true, env, stdio });
  return {
    command: commandLine,
    code: result.code,
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function writeCommandShim({ source, target }) {
  if (!source || !target) {
    return {
      ok: false,
      error: 'missing source or target'
    };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = `#!/bin/sh\nexec ${JSON.stringify(source)} "$@"\n`;
  await fs.writeFile(target, content, { mode: 0o755 });
  await fs.chmod(target, 0o755);
  return {
    ok: true,
    source,
    target
  };
}

async function executeDownloadModel(step, { env = process.env, stdio } = {}) {
  if (await modelDirectoryComplete(step.destination)) {
    return {
      ok: true,
      status: 'skipped',
      reason: 'destination-populated',
      command: stepCommand(step),
      stdout: `model destination already has files: ${step.destination}`,
      stderr: ''
    };
  }

  const command = await resolveHuggingFaceDownloadCommand(step, { env });
  if (!command) {
    return {
      ok: false,
      status: 'failed',
      command: stepCommand(step),
      stdout: '',
      stderr: 'No Hugging Face download CLI found. Install `huggingface_hub[cli]` or set LLOOM_HF_BIN.'
    };
  }
  return executeCommand(command, { env, stdio });
}

async function executePlannedStep(step, { env = process.env, stdio } = {}) {
  if (step.skip?.skip) {
    return {
      ok: true,
      status: 'skipped',
      reason: step.skip.reason,
      stdout: `skipped ${step.id}: ${step.skip.reason}${step.skip.matched ? ` (${step.skip.matched})` : ''}`,
      stderr: ''
    };
  }
  if (step.skipIfPathExists && (await pathExists(step.skipIfPathExists))) {
    return {
      ok: true,
      status: 'skipped',
      reason: 'skip-path-exists',
      matched: step.skipIfPathExists,
      stdout: `skipped ${step.id}: ${step.skipIfPathExists} exists`,
      stderr: ''
    };
  }
  if (step.action === 'manual') {
    return {
      ok: false,
      status: 'manual-required',
      message: step.description ?? 'Manual setup required.'
    };
  }
  if (step.action === 'link-command') {
    if (!step.link?.source) {
      const candidates = asList(step.link?.sourceCandidates).filter(Boolean);
      return {
        ok: false,
        status: 'failed',
        stdout: '',
        stderr: `No executable source found for ${step.link?.commandName ?? step.id}. Tried: ${candidates.join(', ') || '(none)'}`,
        link: step.link
      };
    }
    const result = await writeCommandShim(step.link ?? {});
    return {
      ok: result.ok,
      status: result.ok ? 'completed' : 'failed',
      stdout: result.ok ? `linked ${result.target} -> ${result.source}` : '',
      stderr: result.ok ? '' : result.error,
      link: step.link
    };
  }
  if (step.action === 'download-model') {
    return executeDownloadModel(step, { env, stdio });
  }
  const command = stepCommand(step);
  if (!command) {
    return {
      ok: false,
      status: 'failed',
      stdout: '',
      stderr: `Unsupported setup action ${step.action}`
    };
  }
  const execution = await executeCommand(command, { env, stdio });
  return {
    ...execution,
    status: execution.ok ? 'completed' : 'failed'
  };
}

async function previousRecipeStepStillApplies(step) {
  if (step.action === 'download-model' && step.destination) {
    return modelDirectoryComplete(step.destination);
  }
  if (step.skipIfPathExists) {
    return pathExists(step.skipIfPathExists);
  }
  return true;
}

async function previousBackendStepStillApplies(step, { env = process.env } = {}) {
  if (step.skip?.skip) return true;

  if (step.action === 'link-command') {
    const targetOk = await pathExecutable(step.link?.target);
    const sourceOk = step.link?.source ? await pathExecutable(step.link.source) : false;
    return targetOk && sourceOk;
  }

  if (step.action === 'python-venv') {
    const venvPath = step.path ?? step.venv;
    return venvPath ? pathExecutable(pythonExecutableForVenv(venvPath)) : true;
  }

  if (step.action === 'pip-install') {
    const venvPath = step.venv;
    return venvPath ? pathExecutable(pythonExecutableForVenv(venvPath)) : true;
  }

  if (step.action === 'git-clone') {
    return step.destination ? pathExists(path.join(step.destination, '.git')) : true;
  }

  if (step.action === 'cmake-configure' || step.action === 'cmake-build') {
    return step.build ? pathExists(step.build) : true;
  }

  if (step.action === 'check-command') {
    const command = Array.isArray(step.command) ? step.command[0] : step.command;
    return command ? commandAvailable(command, { env }) : true;
  }

  return true;
}

export async function applyRecipe(
  recipe,
  config,
  {
    dryRun = true,
    yes = false,
    modelRoot = process.env.LLOOM_MODEL_ROOT ?? process.env.LLOOM_MTPLX_MODEL_ROOT ?? defaultUserModelRoot(),
    statePath = defaultInstallStatePath,
    onlyStep,
    env = process.env,
    onProgress,
    stdio
  } = {}
) {
  if (!dryRun && !yes) {
    throw new Error('Refusing to execute recipe without yes=true. Re-run with --yes after reviewing the dry-run plan.');
  }

  const plan = planRecipe(recipe, config, { modelRoot });
  if (plan.validationErrors.length) {
    throw new Error(
      `Recipe ${recipe.id} is invalid:\n${plan.validationErrors.map((error) => `- ${error}`).join('\n')}`
    );
  }
  const state = await readInstallState(statePath);
  const currentRecipeState = recipeState(state, recipe.id);
  const results = [];

  for (const step of plan.steps) {
    if (onlyStep && step.id !== onlyStep) continue;
    const previous = currentRecipeState.steps[step.id];
    const command = stepCommand(step);
    if (previous?.status === 'completed' && (await previousRecipeStepStillApplies(step))) {
      results.push({
        ...step,
        command,
        status: 'skipped',
        reason: 'already-completed'
      });
      continue;
    }

    if (dryRun) {
      results.push({
        ...step,
        command,
        status: 'planned'
      });
      continue;
    }

    const startedAt = nowIso();
    onProgress?.({
      phase: 'recipe',
      event: 'step-start',
      step,
      command
    });
    currentRecipeState.steps[step.id] = {
      status: 'running',
      startedAt,
      command
    };
    await writeInstallState(state, statePath);

    const execution = await executePlannedStep(step, { env, stdio });
    const completedAt = nowIso();
    const status = execution.status ?? (execution.ok ? 'completed' : 'failed');
    const executedCommand = execution.command ?? command;
    currentRecipeState.steps[step.id] = {
      status:
        status === 'skipped' && ['destination-populated', 'skip-path-exists'].includes(execution.reason)
          ? 'completed'
          : status,
      startedAt,
      completedAt,
      command: executedCommand,
      code: execution.code,
      stdoutTail: String(execution.stdout ?? '').slice(-4000),
      stderrTail: String(execution.stderr ?? '').slice(-4000),
      reason: execution.reason
    };
    await writeInstallState(state, statePath);
    results.push({
      ...step,
      command: executedCommand,
      reason: execution.reason,
      status,
      code: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr,
      matched: execution.matched
    });
    onProgress?.({
      phase: 'recipe',
      event: execution.ok ? 'step-complete' : 'step-failed',
      step,
      status,
      reason: execution.reason
    });
    if (!execution.ok) break;
  }

  return {
    dryRun,
    statePath,
    plan,
    results
  };
}

export async function applyBackend(
  backend,
  { dryRun = true, yes = false, statePath = defaultInstallStatePath, onlyStep, variables, env = process.env } = {}
) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to modify backend setup without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }

  const plan = await planBackend(backend, {
    variables,
    checkCommands: true
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
    if (previous?.status === 'completed' && (await previousBackendStepStillApplies(step, { env }))) {
      results.push({
        ...step,
        status: 'skipped',
        reason: 'already-completed'
      });
      continue;
    }

    if (dryRun) {
      results.push({
        ...step,
        status: step.skip?.skip ? 'skipped' : 'planned',
        reason: step.skip?.reason
      });
      continue;
    }

    const startedAt = nowIso();
    currentBackendState.steps[step.id] = {
      status: 'running',
      startedAt,
      command: step.command ?? null,
      link: step.link ?? null,
      audit: step.audit ?? null
    };
    await writeInstallState(state, statePath);

    const execution = await executePlannedStep(step, { env });
    const completedAt = nowIso();
    const status =
      step.action === 'check-command' && !execution.ok
        ? 'missing'
        : (execution.status ?? (execution.ok ? 'completed' : 'failed'));
    const persistedStatus = status === 'skipped' && execution.ok ? 'completed' : status;
    currentBackendState.steps[step.id] = {
      status: persistedStatus,
      startedAt,
      completedAt,
      command: step.command ?? null,
      link: step.link ?? null,
      audit: step.audit ?? null,
      code: execution.code,
      stdoutTail: String(execution.stdout ?? '').slice(-4000),
      stderrTail: String(execution.stderr ?? '').slice(-4000),
      message: execution.message,
      reason: execution.reason,
      matched: execution.matched
    };
    await writeInstallState(state, statePath);
    results.push({
      ...step,
      status,
      code: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr,
      message: execution.message,
      reason: execution.reason,
      matched: execution.matched
    });

    if (step.action !== 'check-command' && !execution.ok) break;
  }

  return {
    dryRun,
    statePath,
    plan,
    results
  };
}
