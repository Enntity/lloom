import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";
import { runCommand } from "./process-control.mjs";

export const defaultBackendCatalogPath = path.join(repoRoot, "backends/catalog.json");
export const defaultShimDir = path.join(repoRoot, "data/bin");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function machineId({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return `${platform}-${arch}`;
}

function expandTemplate(value, variables) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => variables[name] ?? "");
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

async function commandExists(command) {
  const result = await runCommand("/usr/bin/which", [command], { allowFailure: true });
  return result.code === 0 && Boolean(result.stdout.trim());
}

function setupCommand(step, variables = {}) {
  if (!step.command) return null;
  return [
    expandTemplate(step.command, variables),
    ...asArray(step.args).map(arg => expandTemplate(arg, variables)),
  ];
}

async function linkCommandPlan(step, variables = {}) {
  const sourceCandidates = asArray(step.sourceCandidates)
    .map(candidate => expandTemplate(candidate, variables))
    .filter(Boolean);
  let source = null;
  for (const candidate of sourceCandidates) {
    if (await pathExecutable(candidate)) {
      source = candidate;
      break;
    }
  }
  const shimDir = variables.shimDir ?? defaultShimDir;
  const commandName = expandTemplate(step.commandName ?? path.basename(source ?? ""), variables);
  return {
    commandName,
    source,
    sourceCandidates,
    target: commandName ? path.join(shimDir, commandName) : null,
  };
}

export async function loadBackendCatalog(filePath = defaultBackendCatalogPath) {
  const raw = await fs.readFile(filePath, "utf8");
  const catalog = JSON.parse(raw);
  return {
    ...catalog,
    filePath,
    backends: asArray(catalog.backends),
  };
}

export function backendIds(catalog) {
  return new Set(asArray(catalog.backends).map(backend => backend.id));
}

export function validateBackendCatalog(catalog) {
  const errors = [];
  const ids = new Set();
  for (const [index, backend] of asArray(catalog.backends).entries()) {
    if (!backend.id) errors.push(`backends[${index}] is missing id`);
    if (!backend.name) errors.push(`backend ${backend.id ?? index} is missing name`);
    if (!backend.kind) errors.push(`backend ${backend.id ?? index} is missing kind`);
    if (backend.id && ids.has(backend.id)) errors.push(`duplicate backend id: ${backend.id}`);
    if (backend.id) ids.add(backend.id);
    for (const step of asArray(backend.setup)) {
      if (!step.id) errors.push(`backend ${backend.id} has setup step without id`);
      if (!step.action) errors.push(`backend ${backend.id} setup step ${step.id ?? "(missing)"} has no action`);
      if (["command", "check-command"].includes(step.action) && !step.command) {
        errors.push(`backend ${backend.id} setup step ${step.id} requires command`);
      }
      if (step.action === "link-command" && !step.commandName) {
        errors.push(`backend ${backend.id} setup step ${step.id} link-command requires commandName`);
      }
    }
  }
  return errors;
}

export function getBackend(catalog, backendId) {
  return asArray(catalog.backends).find(backend => backend.id === backendId) ?? null;
}

export async function planBackend(backend, {
  platform = process.platform,
  arch = process.arch,
  variables = defaultBackendVariables(),
  checkCommands = true,
} = {}) {
  const platformId = machineId({ platform, arch });
  const platforms = asArray(backend.platforms);
  const platformSupported = !platforms.length || platforms.includes(platformId);
  const commandChecks = [];
  for (const command of asArray(backend.commands)) {
    commandChecks.push({
      command,
      available: checkCommands ? await commandExists(command) : null,
    });
  }
  const missingCommands = commandChecks
    .filter(command => command.available === false)
    .map(command => command.command);
  const setupRequired = platformSupported && missingCommands.length > 0;

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
    steps: await Promise.all(asArray(backend.setup).map(async step => {
      const planned = {
        id: step.id,
        title: step.title ?? step.id,
        action: step.action,
        description: step.description,
        command: setupCommand(step, variables),
      };
      if (step.action === "link-command") {
        planned.link = await linkCommandPlan(step, variables);
      }
      return planned;
    })),
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
  return {
    repoRoot,
    repoParent: path.resolve(repoRoot, ".."),
    installRoot: env.SWITCHYARD_INSTALL_ROOT ?? path.join(repoRoot, "data/backends"),
    backendRoot: env.SWITCHYARD_BACKEND_ROOT ?? path.resolve(repoRoot, ".."),
    modelRoot: env.SWITCHYARD_MODEL_ROOT ?? path.join(repoRoot, "models"),
    shimDir: env.SWITCHYARD_SHIM_DIR ?? defaultShimDir,
    SWITCHYARD_MTPLX_BIN: env.SWITCHYARD_MTPLX_BIN ?? "",
    SWITCHYARD_LLAMA_SERVER_BIN: env.SWITCHYARD_LLAMA_SERVER_BIN ?? "",
  };
}
