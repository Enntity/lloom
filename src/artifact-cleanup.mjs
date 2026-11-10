import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const inside = (root, target) => target !== root && target.startsWith(root + path.sep);
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a);
const digest = (text) => createHash('sha256').update(text).digest('hex');

async function noSymlinks(target) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Artifact path crosses a symlink: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function absoluteReferences(value, result = []) {
  if (typeof value === 'string' && path.isAbsolute(value)) result.push(path.resolve(value));
  else if (Array.isArray(value)) value.forEach((v) => absoluteReferences(v, result));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => absoluteReferences(v, result));
  return result;
}

async function payload(target) {
  const files = [];
  async function walk(file) {
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${file}`);
    if (stat.isDirectory()) for (const entry of await fs.readdir(file)) await walk(path.join(file, entry));
    else if (stat.isFile())
      files.push({ path: file, bytes: stat.size, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` });
    else throw new Error(`Artifact is not a regular file: ${file}`);
  }
  await noSymlinks(target);
  await walk(target);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Explicit manifests cover legacy roots and backend caches without guessing
// ownership from filenames. Every consumer config must be registered here.
export async function planArtifactCleanup(manifestPath, { removeModelId, configPath } = {}) {
  const source = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source);
  if (
    manifest.schema !== 1 ||
    !Array.isArray(manifest.roots) ||
    !Array.isArray(manifest.configs) ||
    !Array.isArray(manifest.artifacts)
  )
    throw new Error('Invalid artifact manifest');
  if (!manifest.configs.length || !manifest.roots.length)
    throw new Error('Artifact manifest requires roots and consumer configs');
  const roots = manifest.roots.map((root) => {
    if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root)
      throw new Error('Artifact roots must be explicit non-root absolute paths');
    return path.resolve(root);
  });
  const configs = [];
  for (const file of manifest.configs) {
    if (!path.isAbsolute(file)) throw new Error('Consumer config paths must be absolute');
    const text = await fs.readFile(file, 'utf8');
    const config = JSON.parse(text);
    configs.push({ path: path.resolve(file), digest: digest(text), config });
  }
  if (removeModelId && !configs.some((c) => c.path === path.resolve(configPath)))
    throw new Error('Removal config is not registered in the artifact manifest');
  const active = new Set(
    configs.flatMap((c) =>
      (c.config.models ?? [])
        .filter((m) => !(c.path === path.resolve(configPath ?? '/') && m.id === removeModelId))
        .map((m) => m.id)
    )
  );
  const entries = manifest.artifacts.map((entry) => {
    if (
      !path.isAbsolute(entry.path ?? '') ||
      !Array.isArray(entry.models) ||
      !entry.models.length ||
      entry.models.some((id) => typeof id !== 'string' || !id)
    )
      throw new Error('Each artifact needs an absolute path and explicit model owners');
    const target = path.resolve(entry.path);
    if (!roots.some((root) => inside(root, target))) throw new Error(`Artifact is outside registered roots: ${target}`);
    if (configs.some((c) => overlaps(c.path, target)) || overlaps(path.resolve(manifestPath), target))
      throw new Error('Artifact overlaps cleanup metadata');
    return { ...entry, path: target };
  });
  const artifacts = [];
  for (const entry of entries) {
    const eligible = !removeModelId || entry.models.includes(removeModelId);
    const shared = entries
      .filter((other) => overlaps(other.path, entry.path))
      .flatMap((other) => other.models)
      .filter((id) => active.has(id));
    // References from a different registered config protect payloads even if
    // an operator forgot to record the additional model owner in this manifest.
    const referencedBy = configs
      .filter(
        (c) =>
          c.path !== path.resolve(configPath ?? '/') &&
          absoluteReferences({ models: c.config.models, runtimes: c.config.runtimes }).some((ref) =>
            overlaps(ref, entry.path)
          )
      )
      .map((c) => c.path);
    const files = await payload(entry.path);
    artifacts.push({
      path: entry.path,
      models: entry.models,
      sharedWith: [...new Set(shared)],
      referencedBy,
      remove: eligible && !shared.length && !referencedBy.length,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0)
    });
  }
  const plan = {
    schema: 1,
    manifestPath: path.resolve(manifestPath),
    manifestDigest: digest(source),
    configs: configs.map(({ path, digest }) => ({ path, digest })),
    artifacts
  };
  return { ...plan, digest: digest(JSON.stringify(plan)) };
}

export async function applyArtifactCleanup(
  manifestPath,
  { apply = false, yes = false, expectedDigest, ...options } = {}
) {
  const plan = await planArtifactCleanup(manifestPath, options);
  if (!apply) return plan;
  if (!yes || !expectedDigest || expectedDigest !== plan.digest)
    throw new Error('Artifact cleanup requires --apply --yes --expect-plan with the current preview digest');
  let reclaimedBytes = 0;
  const deletedFiles = [];
  // Delete individually verified regular files, never recursively traverse a
  // potentially replaced directory or remove unlisted contents.
  for (const artifact of plan.artifacts.filter((a) => a.remove))
    for (const file of artifact.files) {
      if (deletedFiles.includes(file.path)) continue;
      await noSymlinks(file.path);
      const stat = await fs.lstat(file.path);
      if (!stat.isFile() || `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` !== file.identity)
        throw new Error('Artifact changed after preview');
      await fs.unlink(file.path);
      reclaimedBytes += file.bytes;
      deletedFiles.push(file.path);
    }
  return { ...plan, applied: true, deletedFiles, reclaimedBytes };
}
