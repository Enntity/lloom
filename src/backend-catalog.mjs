import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultLloomHome, defaultUserModelRoot, repoRoot } from './config.mjs';
import { runCommand } from './process-control.mjs';

export const defaultBackendCatalogPath = path.join(repoRoot, 'backends/catalog.json');
export function defaultShimDirFor(env = process.env) {
  return path.join(defaultLloomHome(env), 'bin');
}
export const defaultShimDir = defaultShimDirFor();
export const BACKEND_CATALOG_SCHEMA = 'https://lloom.dev/schemas/backend-catalog.v1.schema.json';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function machineId({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`;
}

function expandTemplate(value, variables) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => variables[name] ?? '');
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

async function pathExecutable(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command, variables = {}) {
  const result = await runCommand('/usr/bin/which', [command], { allowFailure: true });
  if (result.code === 0 && Boolean(result.stdout.trim())) return true;
  if (variables.shimDir && (await pathExecutable(path.join(variables.shimDir, command)))) return true;
  return false;
}

function pythonExecutableForVenv(venvPath) {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

function setupCommand(step, variables = {}) {
  if (step.action === 'python-venv') {
    const venvPath = expandTemplate(step.path ?? step.venv ?? '', variables);
    if (!venvPath) return null;
    return [expandTemplate(step.python ?? 'python3', variables), '-m', 'venv', venvPath];
  }
  if (step.action === 'pip-install') {
    const venvPath = expandTemplate(step.venv ?? '', variables);
    const python = expandTemplate(step.python ?? (venvPath ? pythonExecutableForVenv(venvPath) : 'python3'), variables);
    const packages = asList(step.packages ?? step.package).map((entry) => expandTemplate(entry, variables));
    return [
      python,
      '-m',
      'pip',
      'install',
      ...asArray(step.args).map((arg) => expandTemplate(arg, variables)),
      ...packages
    ];
  }
  if (step.action === 'git-clone') {
    const repo = expandTemplate(step.repo ?? '', variables);
    const destination = expandTemplate(step.destination ?? '', variables);
    if (!repo || !destination) return null;
    return [
      'git',
      'clone',
      ...asArray(step.depth ? ['--depth', String(step.depth)] : []),
      ...asArray(step.ref ? ['--branch', expandTemplate(step.ref, variables)] : []),
      repo,
      destination
    ];
  }
  if (step.action === 'cmake-configure') {
    const source = expandTemplate(step.source ?? '', variables);
    const build = expandTemplate(step.build ?? '', variables);
    if (!source || !build) return null;
    return ['cmake', '-S', source, '-B', build, ...asArray(step.args).map((arg) => expandTemplate(arg, variables))];
  }
  if (step.action === 'cmake-build') {
    const build = expandTemplate(step.build ?? '', variables);
    if (!build) return null;
    return ['cmake', '--build', build, ...asArray(step.args).map((arg) => expandTemplate(arg, variables))];
  }
  if (step.action === 'brew-install') {
    const packages = asList(step.packages ?? step.package).map((entry) => expandTemplate(entry, variables));
    if (!packages.length) return null;
    return ['brew', 'install', ...packages];
  }
  if (!step.command) return null;
  return [expandTemplate(step.command, variables), ...asArray(step.args).map((arg) => expandTemplate(arg, variables))];
}

function expandPathList(value, variables = {}) {
  return asList(value)
    .map((entry) => expandTemplate(entry, variables))
    .filter(Boolean);
}

async function setupSkip(step, variables = {}) {
  const commands = asList(step.skipIfCommandAvailable)
    .map((command) => expandTemplate(command, variables))
    .filter(Boolean);
  for (const command of commands) {
    if (await commandExists(command, variables)) {
      return {
        skip: true,
        reason: 'command-available',
        matched: command
      };
    }
  }

  for (const filePath of expandPathList(step.skipIfExecutableExists, variables)) {
    if (await pathExecutable(filePath)) {
      return {
        skip: true,
        reason: 'executable-exists',
        matched: filePath
      };
    }
  }

  for (const filePath of expandPathList(step.skipIfPathExists, variables)) {
    if (await pathExists(filePath)) {
      return {
        skip: true,
        reason: 'path-exists',
        matched: filePath
      };
    }
  }

  if (step.action === 'python-venv') {
    const venvPath = expandTemplate(step.path ?? step.venv ?? '', variables);
    const python = venvPath ? pythonExecutableForVenv(venvPath) : null;
    if (await pathExecutable(python)) {
      return {
        skip: true,
        reason: 'venv-exists',
        matched: python
      };
    }
  }

  if (step.action === 'git-clone') {
    const destination = expandTemplate(step.destination ?? '', variables);
    if (destination && (await pathExists(path.join(destination, '.git')))) {
      return {
        skip: true,
        reason: 'repository-exists',
        matched: destination
      };
    }
  }

  return null;
}

async function linkCommandPlan(step, variables = {}) {
  const sourceCandidates = asArray(step.sourceCandidates)
    .map((candidate) => expandTemplate(candidate, variables))
    .filter(Boolean);
  let source = null;
  for (const candidate of sourceCandidates) {
    if (await pathExecutable(candidate)) {
      source = candidate;
      break;
    }
  }
  const shimDir = variables.shimDir ?? defaultShimDir;
  const commandName = expandTemplate(step.commandName ?? path.basename(source ?? ''), variables);
  return {
    commandName,
    source,
    sourceCandidates,
    target: commandName ? path.join(shimDir, commandName) : null
  };
}

function setupStepAudit(step, planned) {
  const effects = new Set();
  const writes = [];
  // eslint-disable-next-line no-useless-assignment
  let risk = 'low';

  function addWrite(value) {
    if (value) writes.push(value);
  }

  if (planned.command) effects.add('executes-command');

  switch (step.action) {
    case 'check-command':
      risk = 'low';
      break;
    case 'python-venv':
      risk = 'medium';
      effects.add('writes-files');
      addWrite(planned.path ?? planned.venv);
      break;
    case 'pip-install':
      risk = 'high';
      effects.add('writes-files');
      effects.add('uses-network');
      addWrite(planned.venv);
      break;
    case 'git-clone':
      risk = 'high';
      effects.add('writes-files');
      effects.add('uses-network');
      addWrite(planned.destination);
      break;
    case 'cmake-configure':
    case 'cmake-build':
      risk = 'medium';
      effects.add('writes-files');
      effects.add('builds-source');
      addWrite(planned.build);
      break;
    case 'brew-install':
      risk = 'high';
      effects.add('uses-network');
      effects.add('modifies-system-package-manager');
      break;
    case 'link-command':
      risk = 'medium';
      effects.add('writes-files');
      effects.add('creates-shim');
      addWrite(planned.link?.target);
      break;
    case 'manual':
      risk = 'manual';
      effects.add('manual-required');
      break;
    case 'command':
    default:
      risk = planned.command ? 'high' : 'manual';
      if (!planned.command) effects.add('manual-required');
      break;
  }

  if (planned.skip?.skip) {
    return {
      risk: 'low',
      effects: ['skipped'],
      writes: [],
      network: false,
      executes: false,
      modifiesSystem: false,
      summary: `Step is skipped because ${planned.skip.reason}.`
    };
  }

  const effectList = [...effects].sort();
  const network = effectList.includes('uses-network');
  const executes = effectList.includes('executes-command');
  const modifiesSystem = effectList.includes('modifies-system-package-manager');

  return {
    risk,
    effects: effectList,
    writes: [...new Set(writes.filter(Boolean))],
    network,
    executes,
    modifiesSystem,
    summary: auditSummary(step.action, { network, executes, modifiesSystem })
  };
}

function auditSummary(action, { network, executes, modifiesSystem } = {}) {
  if (action === 'manual') return 'Requires a manual setup action outside LLooM.';
  if (modifiesSystem) return 'May install or modify system-level packages.';
  if (network) return 'Downloads code or packages from the network into a managed location.';
  if (executes) return 'Executes a local command during backend setup.';
  return 'Writes local backend setup files.';
}

function setupAuditSummary(steps) {
  const risks = {
    low: 0,
    medium: 0,
    high: 0,
    manual: 0
  };
  const effects = new Set();
  let network = false;
  let modifiesSystem = false;
  let writesFilesystem = false;
  let executes = false;

  for (const step of steps) {
    const audit = step.audit ?? {};
    if (Object.hasOwn(risks, audit.risk)) risks[audit.risk] += 1;
    for (const effect of asArray(audit.effects)) effects.add(effect);
    network ||= audit.network === true;
    modifiesSystem ||= audit.modifiesSystem === true;
    writesFilesystem ||= asArray(audit.effects).includes('writes-files') || asArray(audit.writes).length > 0;
    executes ||= audit.executes === true;
  }

  return {
    risks,
    effects: [...effects].sort(),
    network,
    modifiesSystem,
    writesFilesystem,
    executes
  };
}

export async function loadBackendCatalog(filePath = defaultBackendCatalogPath) {
  const raw = isUrl(filePath)
    ? await fetch(filePath).then(async (response) => {
        if (!response.ok) throw new Error(`Failed to fetch backend catalog ${filePath}: HTTP ${response.status}`);
        return response.text();
      })
    : await fs.readFile(filePath, 'utf8');
  const catalog = JSON.parse(raw);
  return {
    ...catalog,
    filePath,
    backends: asArray(catalog.backends)
  };
}

export function backendIds(catalog) {
  return new Set(asArray(catalog.backends).map((backend) => backend.id));
}

export function validateBackendCatalog(catalog) {
  const errors = [];
  const ids = new Set();
  if (catalog.$schema && catalog.$schema !== BACKEND_CATALOG_SCHEMA) {
    errors.push(`backend catalog has unsupported $schema ${catalog.$schema}`);
  }
  if (catalog.schemaVersion !== 1) errors.push('backend catalog schemaVersion must be 1');
  if (!Array.isArray(catalog.backends)) errors.push('backend catalog backends must be an array');
  for (const [index, backend] of asArray(catalog.backends).entries()) {
    if (!backend.id) errors.push(`backends[${index}] is missing id`);
    if (!backend.name) errors.push(`backend ${backend.id ?? index} is missing name`);
    if (!backend.kind) errors.push(`backend ${backend.id ?? index} is missing kind`);
    if (backend.id && ids.has(backend.id)) errors.push(`duplicate backend id: ${backend.id}`);
    if (backend.id) ids.add(backend.id);
    for (const step of asArray(backend.setup)) {
      if (!step.id) errors.push(`backend ${backend.id} has setup step without id`);
      if (!step.action) errors.push(`backend ${backend.id} setup step ${step.id ?? '(missing)'} has no action`);
      if (['command', 'check-command'].includes(step.action) && !step.command) {
        errors.push(`backend ${backend.id} setup step ${step.id} requires command`);
      }
      if (step.action === 'python-venv' && !(step.path || step.venv)) {
        errors.push(`backend ${backend.id} setup step ${step.id} python-venv requires path or venv`);
      }
      if (step.action === 'pip-install' && !(step.packages || step.package)) {
        errors.push(`backend ${backend.id} setup step ${step.id} pip-install requires packages`);
      }
      if (step.action === 'git-clone' && !(step.repo && step.destination)) {
        errors.push(`backend ${backend.id} setup step ${step.id} git-clone requires repo and destination`);
      }
      if (step.action === 'cmake-configure' && !(step.source && step.build)) {
        errors.push(`backend ${backend.id} setup step ${step.id} cmake-configure requires source and build`);
      }
      if (step.action === 'cmake-build' && !step.build) {
        errors.push(`backend ${backend.id} setup step ${step.id} cmake-build requires build`);
      }
      if (step.action === 'brew-install' && !(step.packages || step.package)) {
        errors.push(`backend ${backend.id} setup step ${step.id} brew-install requires packages`);
      }
      if (step.action === 'link-command' && !step.commandName) {
        errors.push(`backend ${backend.id} setup step ${step.id} link-command requires commandName`);
      }
    }
  }
  return errors;
}

export function getBackend(catalog, backendId) {
  return asArray(catalog.backends).find((backend) => backend.id === backendId) ?? null;
}

export async function planBackend(
  backend,
  { platform = process.platform, arch = process.arch, variables = defaultBackendVariables(), checkCommands = true } = {}
) {
  const platformId = machineId({ platform, arch });
  const platforms = asArray(backend.platforms);
  const platformSupported = !platforms.length || platforms.includes(platformId);
  const commandChecks = [];
  for (const command of asArray(backend.commands)) {
    commandChecks.push({
      command,
      available: checkCommands ? await commandExists(command, variables) : null
    });
  }
  const missingCommands = commandChecks
    .filter((command) => command.available === false)
    .map((command) => command.command);
  const setupRequired = platformSupported && missingCommands.length > 0;

  const steps = await Promise.all(
    asArray(backend.setup)
      .filter((step) => {
        const stepPlatforms = asArray(step.platforms);
        return !stepPlatforms.length || stepPlatforms.includes(platformId);
      })
      .map(async (step) => {
        const planned = {
          id: step.id,
          title: step.title ?? step.id,
          action: step.action,
          description: step.description,
          command: setupCommand(step, variables)
        };
        const skip = await setupSkip(step, variables);
        if (skip) planned.skip = skip;
        if (step.action === 'link-command') {
          planned.link = await linkCommandPlan(step, variables);
        }
        for (const field of ['path', 'venv', 'repo', 'destination', 'source', 'build']) {
          if (step[field]) planned[field] = expandTemplate(step[field], variables);
        }
        planned.audit = setupStepAudit(step, planned);
        return planned;
      })
  );

  return {
    id: backend.id,
    name: backend.name,
    kind: backend.kind,
    description: backend.description,
    platform: platformId,
    platformSupported,
    features: asArray(backend.features),
    commands: commandChecks,
    missingCommands,
    setupRequired,
    runnable: platformSupported && !setupRequired,
    server: backend.server ?? null,
    setupAudit: setupAuditSummary(steps),
    steps
  };
}

export async function planBackendCatalog(catalog, options = {}) {
  const plans = [];
  for (const backend of asArray(catalog.backends)) {
    plans.push(await planBackend(backend, options));
  }
  return plans.sort((a, b) => {
    if (a.platformSupported !== b.platformSupported) return a.platformSupported ? -1 : 1;
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function defaultBackendVariables(env = process.env) {
  const lloomHome = defaultLloomHome(env);
  return {
    repoRoot,
    repoParent: path.resolve(repoRoot, '..'),
    lloomHome,
    installRoot: env.LLOOM_INSTALL_ROOT ?? path.join(lloomHome, 'backends'),
    backendRoot: env.LLOOM_BACKEND_ROOT ?? path.join(lloomHome, 'backends'),
    modelRoot: env.LLOOM_MODEL_ROOT ?? defaultUserModelRoot(env),
    shimDir: env.LLOOM_SHIM_DIR ?? defaultShimDirFor(env),
    LLOOM_MTPLX_BIN: env.LLOOM_MTPLX_BIN ?? '',
    LLOOM_LLAMA_SERVER_BIN: env.LLOOM_LLAMA_SERVER_BIN ?? '',
    LLOOM_VLLM_BIN: env.LLOOM_VLLM_BIN ?? '',
    LLOOM_SGLANG_PYTHON: env.LLOOM_SGLANG_PYTHON ?? ''
  };
}
