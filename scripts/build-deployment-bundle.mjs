#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DIGEST = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const PACKAGE_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._~-]*|@[A-Za-z0-9][A-Za-z0-9._~-]*\/[A-Za-z0-9][A-Za-z0-9._~-]*)$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// This is intentionally the same canonical form used by the node release
// agent. It keeps dependency and file-tree digests portable across nodes.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestJson(value) {
  return sha256(Buffer.from(stableJson(value)));
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`);
    const [name, inline] = raw.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[name] = argv[++index];
    else flags[name] = true;
  }
  return flags;
}

function requiredDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function asPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function regularFiles(root, relative = '') {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await regularFiles(child, childRelative)));
    else if (entry.isFile()) {
      const stat = await fs.lstat(child);
      if (stat.nlink > 1) throw new Error(`hard link is not allowed in bundle: ${childRelative}`);
      files.push({
        path: childRelative.replaceAll(path.sep, '/'),
        absolute: child,
        bytes: await fs.readFile(child),
        mode: stat.mode & 0o777
      });
    } else throw new Error(`symlinks and special files are not allowed in bundle: ${childRelative}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function copyTree(source, destination) {
  const files = await regularFiles(source);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(destination, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.bytes, { mode: file.mode });
    await fs.chmod(target, file.mode);
  }
}

async function resetArchiveTimes(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await resetArchiveTimes(child);
    else await fs.utimes(child, 0, 0);
  }
  await fs.utimes(root, 0, 0);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function readPackage(packageRoot) {
  return readJson(path.join(packageRoot, 'package.json'), `package metadata at ${packageRoot}`);
}

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(value));
  if (!match) return null;
  return {
    value: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    components: match[3] === undefined ? (match[2] === undefined ? 1 : 2) : 3
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function upperForBareVersion(parsed) {
  if (parsed.components === 1) return [parsed.value[0] + 1, 0, 0];
  if (parsed.components === 2) return [parsed.value[0], parsed.value[1] + 1, 0];
  return null;
}

function satisfiesComparator(version, token) {
  const match = /^(<=|>=|<|>|=|~|\^)?(v?\d+(?:\.\d+){0,2})$/.exec(token);
  if (!match) return false;
  const operator = match[1] ?? '';
  const parsed = parseVersion(match[2]);
  if (!parsed) return false;
  if (operator === '^' || operator === '~') {
    if (parsed.components !== 3) return false;
    const upper =
      operator === '~'
        ? [parsed.value[0], parsed.value[1] + 1, 0]
        : parsed.value[0] > 0
          ? [parsed.value[0] + 1, 0, 0]
          : parsed.value[1] > 0
            ? [0, parsed.value[1] + 1, 0]
            : [0, 0, parsed.value[2] + 1];
    return compareVersions(version, parsed.value) >= 0 && compareVersions(version, upper) < 0;
  }
  const relation = compareVersions(version, parsed.value);
  if (operator === '>=') return relation >= 0;
  if (operator === '>') return relation > 0;
  if (operator === '<=') return relation <= 0;
  if (operator === '<') return relation < 0;
  if (operator === '=') return relation === 0;
  const upper = upperForBareVersion(parsed);
  return upper ? relation >= 0 && compareVersions(version, upper) < 0 : relation === 0;
}

// Keep this range grammar deliberately small. A bundle must be verifiable on
// a disconnected node, so registry aliases, git/file/workspace links,
// wildcards, and other npm-specific range syntax fail closed.
export function dependencyVersionAllows(range, installedVersion) {
  if (typeof range !== 'string' || !range.trim()) return false;
  const parsed = parseVersion(String(installedVersion ?? '').trim());
  if (!parsed || parsed.components !== 3) return false;
  return range.split(/\s*\|\|\s*/).some((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => satisfiesComparator(parsed.value, token));
  });
}

async function resolvePackage(fromRoot, name) {
  if (!PACKAGE_NAME.test(name) || name.includes('..')) throw new Error(`unsafe dependency name: ${name}`);
  let cursor = path.resolve(fromRoot);
  while (true) {
    const candidate = path.join(cursor, 'node_modules', name);
    try {
      const candidateStat = await fs.lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink())
        throw new Error(`dependency ${name} is a symlink or not a directory`);
      const metadataStat = await fs.lstat(path.join(candidate, 'package.json'));
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink())
        throw new Error(`dependency ${name} has unsafe package metadata`);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`installed dependency ${name} is missing from the locked workspace`);
}

function relativePackagePath(root, packageRoot) {
  const relative = path.relative(root, packageRoot).replaceAll(path.sep, '/');
  if (!relative || relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative))
    throw new Error(`dependency ${packageRoot} is outside the reviewed workspace`);
  return relative;
}

function assertDependencyMap(packageJson, label) {
  const declared = asPlainObject(packageJson.dependencies ?? {}, `${label}.dependencies`);
  for (const [name, range] of Object.entries(declared)) {
    if (!PACKAGE_NAME.test(name) || name.includes('..')) throw new Error(`unsafe dependency name in ${label}: ${name}`);
    if (typeof range !== 'string' || !range.trim())
      throw new Error(`dependency ${name} has no supported range in ${label}`);
  }
  if (Object.keys(packageJson.optionalDependencies ?? {}).length)
    throw new Error(`optional dependencies are unsupported in ${label}`);
  if (Object.keys(packageJson.peerDependencies ?? {}).length)
    throw new Error(`peer dependencies are unsupported in ${label}`);
  if (packageJson.bundledDependencies || packageJson.bundleDependencies)
    throw new Error(`bundled dependencies are unsupported in ${label}`);
  return declared;
}

async function verifyLockRoot(root, packageJson) {
  const lock = await readJson(path.join(root, 'package-lock.json'), 'package-lock.json');
  const lockRoot = asPlainObject(lock.packages?.[''], 'package-lock root');
  const declared = assertDependencyMap(packageJson, 'package.json');
  const locked = asPlainObject(lockRoot.dependencies ?? {}, 'package-lock root.dependencies');
  if (stableJson(locked) !== stableJson(declared))
    throw new Error('package-lock root dependencies do not exactly match package.json');
  return lock;
}

async function collectDependencies(root, packageJson, lock, bundleRoot) {
  const declared = assertDependencyMap(packageJson, 'package.json');
  const closure = {};
  const resolved = new Map();
  const visit = async (name, range, fromRoot, parentLabel) => {
    const packageRoot = await resolvePackage(fromRoot, name);
    const lockPath = relativePackagePath(root, packageRoot);
    const lockEntry = lock.packages?.[lockPath];
    if (!lockEntry || lockEntry.link || typeof lockEntry.version !== 'string')
      throw new Error(`dependency ${name} is not represented by a locked package entry: ${lockPath}`);
    const dependencyPackage = await readPackage(packageRoot);
    const label = `${parentLabel} -> ${name}`;
    if (!VERSION.test(String(dependencyPackage.version ?? '')))
      throw new Error(`dependency ${name} has no pinned semver version (${label})`);
    if (lockEntry.version !== dependencyPackage.version)
      throw new Error(`dependency ${name} differs from package-lock at ${lockPath}`);
    if (!dependencyVersionAllows(range, dependencyPackage.version))
      throw new Error(`dependency ${name}@${dependencyPackage.version} is outside ${range} (${label})`);
    assertDependencyMap(dependencyPackage, `dependency ${name}`);
    const previous = resolved.get(name);
    if (previous) {
      if (previous.version !== dependencyPackage.version)
        throw new Error(`dependency ${name} resolves to multiple versions`);
      return;
    }
    resolved.set(name, { packageRoot, version: dependencyPackage.version });
    if (Object.hasOwn(declared, name)) closure[name] = dependencyPackage.version;
    for (const [child, childRange] of Object.entries(dependencyPackage.dependencies ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      await visit(child, childRange, packageRoot, label);
    }
  };
  for (const name of Object.keys(declared).sort()) await visit(name, declared[name], root, 'package.json');
  for (const name of [...resolved.keys()].sort()) {
    const destination = path.join(bundleRoot, 'node_modules', name);
    await copyTree(resolved.get(name).packageRoot, destination);
  }
  const closureNames = Object.keys(declared).sort();
  if (closureNames.some((name) => closure[name] === undefined))
    throw new Error('a declared dependency was not resolved into the reviewed closure');
  return Object.fromEntries(closureNames.map((name) => [name, closure[name]]));
}

async function fileInventory(root) {
  return (await regularFiles(root)).map(({ path: file, bytes }) => ({
    path: file,
    size: bytes.length,
    sha256: sha256(bytes)
  }));
}

function archiveMemberPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.startsWith('/')) return null;
  const raw = value.replace(/^\.\//, '');
  if (!raw || raw === '.') return { path: '', directory: true };
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  if (
    normalized !== raw.replaceAll('\\', '/') ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.includes('\n') ||
    normalized.includes('\r')
  )
    return null;
  return { path: normalized.replace(/\/$/, ''), directory: raw.endsWith('/') };
}

function validateArchiveListing(listing, verboseListing) {
  const entries = String(listing ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set();
  let fileCount = 0;
  for (const value of entries) {
    const entry = archiveMemberPath(value);
    if (!entry || (entry.path && seen.has(entry.path))) throw new Error('bundle archive has unsafe or duplicate paths');
    if (entry.path) seen.add(entry.path);
    if (!entry.directory && entry.path) fileCount += 1;
  }
  const typed = String(verboseListing ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (typed.length !== entries.length || fileCount === 0) throw new Error('bundle archive listing is incomplete');
  for (const value of typed) {
    if (!['-', 'd'].includes(value[0]) || /\s(?:hard )?link to\s/i.test(value))
      throw new Error('bundle archive contains a link or special file');
  }
}

async function immutableFile(pathname, bytes, mode = 0o600) {
  const temporary = `${pathname}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, bytes, { mode });
  try {
    const handle = await fs.open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, pathname);
      await fs.unlink(temporary);
      return 'created';
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingStat = await fs.lstat(pathname);
      if (!existingStat.isFile() || !(await fs.readFile(pathname)).equals(bytes))
        throw new Error(`refusing to replace existing reviewed bundle file: ${pathname}`, { cause: error });
      return 'existing';
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function publishImmutablePair(artifactPath, artifactBytes, manifestPath, manifestBytes) {
  const artifactResult = await immutableFile(artifactPath, artifactBytes, 0o600);
  // The artifact is independently immutable. A concurrent builder may have
  // published a valid sidecar for the same bytes, so never remove a bundle
  // after a sidecar conflict; leave the pair for explicit recovery/audit.
  const manifestResult = await immutableFile(manifestPath, manifestBytes, 0o600);
  return { artifactResult, manifestResult };
}

async function writeArchive(bundleRoot, files, artifactPath, temporary) {
  const fileListPath = path.join(temporary, 'archive-files.list');
  for (const file of files) {
    if (!file.path || file.path.includes('\0') || file.path.includes('\n') || file.path.includes('\r'))
      throw new Error(`bundle path cannot be represented safely in an archive: ${file.path}`);
  }
  // List files explicitly instead of archiving `.`. This avoids a synthetic
  // `./` directory entry, which older node agents correctly reject as an
  // unreviewed archive object, while tar still creates parent directories on
  // extraction.
  await fs.writeFile(fileListPath, files.map(({ path: file }) => `${file}\0`).join(''));
  await execFileAsync('tar', [
    '--create',
    '--format',
    'ustar',
    '--file',
    artifactPath,
    '--directory',
    bundleRoot,
    '--null',
    '--files-from',
    fileListPath
  ]);
}

export async function buildDeploymentBundle({
  root,
  runtimeContractDigest,
  allowDirty = false,
  outputDir = null
} = {}) {
  if (!root) throw new Error('root is required');
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: root });
  if (status.trim() && !allowDirty) throw new Error('refusing to package a dirty tree; commit the release first');
  const { stdout: commitOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commit = commitOutput.trim();
  if (!COMMIT.test(commit)) throw new Error('release HEAD is not a full commit SHA');
  const packageJson = await readJson(path.join(root, 'package.json'), 'package.json');
  const lock = await verifyLockRoot(root, packageJson);
  const temporary = await fs.mkdtemp(path.join(root, '.deployment-bundle-'));
  try {
    const npmOutput = await execFileAsync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      {
        cwd: root,
        env: { ...process.env, NPM_CONFIG_CACHE: path.join(root, '.cache', 'npm-release') },
        maxBuffer: 10 * 1024 * 1024
      }
    );
    const packed = JSON.parse(npmOutput.stdout)[0];
    if (!packed?.filename) throw new Error('npm pack did not produce an artifact');
    const npmArtifact = path.join(temporary, packed.filename);
    const extracted = path.join(temporary, 'extracted');
    await fs.mkdir(extracted, { mode: 0o700 });
    await execFileAsync('tar', [
      '--extract',
      '--no-same-owner',
      '--no-same-permissions',
      '--file',
      npmArtifact,
      '--directory',
      extracted
    ]);
    const packageRoot = path.join(extracted, 'package');
    const bundleRoot = path.join(temporary, 'bundle');
    await copyTree(packageRoot, bundleRoot);
    const dependencyClosure = await collectDependencies(root, packageJson, lock, bundleRoot);
    const files = await fileInventory(bundleRoot);
    const treeSha256 = digestJson(files.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest })));
    const dependencyDigest = digestJson(dependencyClosure);
    const releaseOutputDir = outputDir ?? path.join(root, 'dist', 'releases', commit.slice(0, 12));
    await fs.mkdir(releaseOutputDir, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(
      releaseOutputDir,
      `${packageJson.name}-${packageJson.version}-${commit.slice(0, 12)}-gateway.tar`
    );
    const temporaryArtifactPath = path.join(temporary, path.basename(artifactPath));
    await resetArchiveTimes(bundleRoot);
    await writeArchive(bundleRoot, files, temporaryArtifactPath, temporary);
    const artifactBytes = await fs.readFile(temporaryArtifactPath);
    const manifest = {
      schemaVersion: 1,
      package: packageJson.name,
      version: packageJson.version,
      releaseId: commit,
      commit,
      dirty: Boolean(status.trim()),
      artifact: path.basename(artifactPath),
      sha256: sha256(artifactBytes),
      size: artifactBytes.length,
      files,
      treeSha256,
      dependencyClosure,
      dependencyDigest,
      runtimeContractDigest: requiredDigest(runtimeContractDigest, '--runtime-contract-digest'),
      engines: packageJson.engines ?? {}
    };
    const manifestPath = `${artifactPath}.manifest.json`;
    await publishImmutablePair(
      artifactPath,
      artifactBytes,
      manifestPath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    );
    return { artifact: artifactPath, manifestPath, manifest };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function inspectDeploymentBundle({ artifact, manifestPath } = {}) {
  const artifactBytes = await fs.readFile(artifact);
  const manifest = await readJson(manifestPath, 'deployment manifest');
  if (manifest.sha256 !== sha256(artifactBytes)) throw new Error('manifest artifact digest mismatch');
  const temporary = await fs.mkdtemp(path.join(path.dirname(artifact), '.inspect-bundle-'));
  try {
    const listing = await execFileAsync('tar', ['--list', '--file', artifact]);
    const verboseListing = await execFileAsync('tar', ['--list', '--verbose', '--numeric-owner', '--file', artifact]);
    validateArchiveListing(listing.stdout, verboseListing.stdout);
    await execFileAsync('tar', [
      '--extract',
      '--no-same-owner',
      '--no-same-permissions',
      '--file',
      artifact,
      '--directory',
      temporary
    ]);
    const files = await fileInventory(temporary);
    if (stableJson(files) !== stableJson(manifest.files)) throw new Error('manifest file inventory mismatch');
    const treeSha256 = digestJson(files.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest })));
    if (treeSha256 !== manifest.treeSha256) throw new Error('manifest tree digest mismatch');
    if (digestJson(manifest.dependencyClosure) !== manifest.dependencyDigest)
      throw new Error('manifest dependency digest mismatch');
    const packageJson = await readJson(path.join(temporary, 'package.json'), 'bundled package.json');
    const declared = assertDependencyMap(packageJson, 'bundled package.json');
    if (stableJson(Object.keys(declared).sort()) !== stableJson(Object.keys(manifest.dependencyClosure).sort()))
      throw new Error('bundled dependency closure does not match package.json');
    for (const [name, version] of Object.entries(manifest.dependencyClosure)) {
      const dependency = await readPackage(path.join(temporary, 'node_modules', name));
      if (dependency.version !== version || !dependencyVersionAllows(declared[name], version))
        throw new Error(`bundled dependency ${name} is not the reviewed version`);
    }
    return { manifest, files, packageJson };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!flags['runtime-contract-digest'])
    throw new Error('--runtime-contract-digest is required and must be reviewed separately');
  const result = await buildDeploymentBundle({
    root,
    runtimeContractDigest: flags['runtime-contract-digest'],
    allowDirty: Boolean(flags['allow-dirty'])
  });
  console.log(
    JSON.stringify({ artifact: result.artifact, manifest: result.manifestPath, ...result.manifest }, null, 2)
  );
}
