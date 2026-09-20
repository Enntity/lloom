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

// Hugging Face uses Python fnmatch: '*' and '?' also match path separators.
function globMatcher(pattern) {
  const text = pattern.endsWith('/') ? pattern + '*' : pattern;
  let expression = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '*') expression += '.*';
    else if (char === '?') expression += '.';
    else if (char === '[') {
      const end = text.indexOf(']', index + (text[index + 1] === '!' ? 2 : 1));
      if (end < 0) expression += '\\[';
      else {
        const value = text.slice(index + 1, end);
        expression +=
          '[' + (value.startsWith('!') ? '^' + value.slice(1) : value.startsWith('^') ? '\\' + value : value) + ']';
        index = end;
      }
    } else expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const regex = new RegExp('^' + expression + '$', 's');
  return (relativePath) => regex.test(relativePath);
}

function normalizeSelector(include) {
  if (include == null) return [];
  if (typeof include === 'string') return [include];
  if (Array.isArray(include)) return include.map((entry) => String(entry)).filter(Boolean);
  throw new TypeError('include must be a string or an array of strings');
}

export function validModelFilePattern(pattern) {
  try {
    globMatcher(pattern);
    return true;
  } catch {
    return false;
  }
}

// Relative path used for include matching. A missing directory yields no matches
// rather than inventing paths.
async function walkRelativeFiles(dirPath, { maxDepth = 12, maxEntries = 200000 } = {}) {
  const files = [];
  async function visit(current, relative, remainingDepth) {
    if (files.length >= maxEntries) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        files.push(childRelative);
      } else if (entry.isDirectory() && entry.name !== '.cache' && remainingDepth > 0) {
        await visit(child, childRelative, remainingDepth - 1);
      }
    }
  }
  await visit(dirPath, '', maxDepth);
  return files;
}

// Each include pattern must resolve to at least one real file. A generic
// `model.safetensors` left over from an earlier run must not satisfy a pattern
// that names a file the repository has not delivered yet.
export async function matchIncludedFiles(dirPath, include) {
  const patterns = normalizeSelector(include);
  const results = patterns.map((pattern) => ({
    pattern,
    matcher: validModelFilePattern(pattern) ? globMatcher(pattern) : () => false,
    matches: []
  }));
  if (!patterns.length) return results;
  const files = await walkRelativeFiles(dirPath);
  for (const file of files) {
    for (const result of results) {
      if (result.matcher?.(file)) result.matches.push(file);
    }
  }
  return results;
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

export async function modelDirectoryStatus(dirPath, { include } = {}) {
  try {
    const entries = await fs.readdir(dirPath);
    const payloadFiles = await findPayloadFiles(dirPath);
    const selections = await matchIncludedFiles(dirPath, include);
    // A declared selection is the contract: it is satisfied only when every
    // pattern resolves to a real file, and those files themselves prove the
    // directory is populated even when their names do not look like a generic
    // checkpoint. Nothing may fall back to the filename heuristic in that case.
    const selectedFiles = [...new Set(selections.flatMap((selection) => selection.matches))];
    const pending = selections.filter((selection) => !selection.matches.length).map((selection) => selection.pattern);
    const populated = selections.length ? selectedFiles.length > 0 : payloadFiles.length > 0;
    const complete = selections.length ? selectedFiles.length > 0 && pending.length === 0 : populated;
    return {
      path: dirPath,
      exists: true,
      populated,
      complete,
      entries: entries.length,
      payloadFiles: payloadFiles.length + (selections.length ? selectedFiles.length : 0),
      ...(selections.length ? { selectedFiles, missingIncludes: pending } : {}),
      status: complete ? 'present' : entries.length ? 'partial' : 'empty'
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
      ...(include == null ? {} : { selectedFiles: [], missingIncludes: normalizeSelector(include) }),
      status: 'missing'
    };
  }
}

export async function modelDirectoryComplete(dirPath, { include } = {}) {
  return (await modelDirectoryStatus(dirPath, { include })).complete === true;
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
    const selections = (recipe.setup?.steps ?? [])
      .filter((step) => step?.action === 'download-model' && step.model === model)
      .flatMap((step) =>
        normalizeSelector(step.include).length
          ? normalizeSelector(step.include)
          : (step.integrity?.files ?? []).map((file) => file.path)
      );
    statuses.push({
      model,
      destination,
      status: await modelDirectoryStatus(destination, { include: unique(selections) })
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
