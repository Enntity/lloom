import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultUserModelRoot } from './config.mjs';
import { modelPathSegmentForRecipe } from './recipes.mjs';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isModelPayloadFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return (
    /^model(?:-\d+-of-\d+)?\.safetensors$/.test(name) ||
    /^model.*\.bin$/.test(name) ||
    /^pytorch_model.*\.bin$/.test(name) ||
    name.endsWith('.gguf')
  );
}

async function findPayloadFiles(dirPath, { depth = 2 } = {}) {
  const payloads = [];
  async function visit(current, remainingDepth) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isFile() && isModelPayloadFile(child)) {
        payloads.push(child);
      } else if (entry.isDirectory() && remainingDepth > 0 && entry.name !== '.cache') {
        await visit(child, remainingDepth - 1);
      }
    }
  }
  await visit(dirPath, depth);
  return payloads;
}

export async function modelDirectoryStatus(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    const payloadFiles = await findPayloadFiles(dirPath);
    const populated = payloadFiles.length > 0;
    return {
      path: dirPath,
      exists: true,
      populated,
      complete: populated,
      entries: entries.length,
      payloadFiles: payloadFiles.length,
      status: populated ? 'present' : entries.length ? 'partial' : 'empty'
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      path: dirPath,
      exists: false,
      populated: false,
      complete: false,
      entries: 0,
      payloadFiles: 0,
      status: 'missing'
    };
  }
}

export async function modelDirectoryComplete(dirPath) {
  return (await modelDirectoryStatus(dirPath)).complete === true;
}

export function recipeModelDestination(recipe, modelRoot, modelId) {
  return path.join(modelRoot, modelPathSegmentForRecipe(recipe, modelId));
}

export async function modelRootStatusForRecipe(recipe, modelRoot) {
  const downloadModels = (recipe.setup?.steps ?? [])
    .filter((step) => step?.action === 'download-model' && step.model)
    .map((step) => step.model);
  const models = downloadModels.length
    ? downloadModels
    : (recipe.models ?? []).map((model) => model.model).filter(Boolean);
  const statuses = [];
  for (const model of unique(models)) {
    const destination = recipeModelDestination(recipe, modelRoot, model);
    statuses.push({
      model,
      destination,
      status: await modelDirectoryStatus(destination)
    });
  }
  return {
    modelRoot,
    complete: statuses.length > 0 && statuses.every((item) => item.status.complete),
    models: statuses
  };
}

async function volumeModelRootCandidates() {
  if (process.platform !== 'darwin' || !(await pathExists('/Volumes'))) return [];
  let volumes;
  try {
    volumes = await fs.readdir('/Volumes');
  } catch {
    return [];
  }
  return volumes.flatMap((volume) => {
    const root = path.join('/Volumes', volume);
    return [path.join(root, 'LLM', 'mtplx', 'models'), path.join(root, 'LLM', 'models')];
  });
}

function cwdModelRootCandidates(cwd = process.cwd()) {
  const parent = path.dirname(cwd);
  return [
    path.join(cwd, 'models'),
    path.join(cwd, 'mtplx', 'models'),
    path.join(parent, 'models'),
    path.join(parent, 'mtplx', 'models')
  ];
}

export async function modelRootCandidates({
  config,
  home = process.env.HOME,
  env = process.env,
  cwd = process.cwd()
} = {}) {
  return unique([
    env.LLOOM_MODEL_ROOT,
    env.LLOOM_MTPLX_MODEL_ROOT,
    config?.paths?.modelRoot,
    defaultUserModelRoot({ ...env, HOME: home }),
    ...cwdModelRootCandidates(cwd),
    ...(await volumeModelRootCandidates())
  ]);
}

export async function detectModelRootForRecipe(
  recipe,
  { config, explicitModelRoot, home = process.env.HOME, env = process.env, cwd = process.cwd() } = {}
) {
  if (explicitModelRoot) {
    return {
      modelRoot: explicitModelRoot,
      detected: false,
      candidates: []
    };
  }

  const candidates = await modelRootCandidates({ config, home, env, cwd });
  const checked = [];
  for (const candidate of candidates) {
    const status = await modelRootStatusForRecipe(recipe, candidate);
    checked.push(status);
    if (status.complete) {
      return {
        modelRoot: candidate,
        detected: candidate !== config?.paths?.modelRoot,
        candidates: checked
      };
    }
  }

  return {
    modelRoot:
      config?.paths?.modelRoot ??
      env.LLOOM_MODEL_ROOT ??
      env.LLOOM_MTPLX_MODEL_ROOT ??
      defaultUserModelRoot({ ...env, HOME: home }),
    detected: false,
    candidates: checked
  };
}
