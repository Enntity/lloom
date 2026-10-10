import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * The local half of a gateway-only release.  It deliberately owns files and
 * the gateway unit only; model processes and runtime containers are outside
 * this agent's mutation surface.  A caller supplies the command runner and
 * the gateway fence/control adapter, which makes the release logic testable
 * without SSH, systemd, or an inference request.
 */

export const NODE_AGENT_PROTOCOL = 1;

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PHASES = new Set([
  'preflight',
  'stage',
  'prepare',
  'swap',
  'restart',
  'verify',
  'canary',
  'promote',
  'release',
  'reprepare',
  'rollback',
  'discard-stage'
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeId(value, label, pattern = ID) {
  if (typeof value !== 'string' || !value.trim() || !pattern.test(value.trim())) {
    throw new NodeReleaseError(`${label} is invalid`, 'invalid_context');
  }
  return value.trim();
}

function digest(value, label) {
  const result = safeId(value, label).toLowerCase();
  if (!DIGEST.test(result)) throw new NodeReleaseError(`${label} must be a SHA-256 digest`, 'invalid_context');
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestJson(value) {
  return sha256(Buffer.from(stableJson(value)));
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\0')) return false;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return (
    normalized === value.replaceAll('\\', '/') &&
    normalized !== '.' &&
    !normalized.startsWith('../') &&
    normalized !== '..'
  );
}

function archiveEntry(value) {
  if (typeof value !== 'string') return null;
  const raw = value.replace(/^\.\//, '');
  const directory = raw.endsWith('/');
  const relative = directory ? raw.slice(0, -1) : raw;
  if (!safeArchivePath(relative)) return null;
  return { path: relative, directory };
}

function archivePathEntries(listing) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of String(listing ?? '')
    .split(/\r?\n/)
    .filter(Boolean)) {
    const entry = archiveEntry(rawLine.trim());
    if (!entry || seen.has(entry.path))
      throw new NodeReleaseError('reviewed archive has unsafe or duplicate entries', 'archive_invalid');
    seen.add(entry.path);
    entries.push(entry);
  }
  if (!entries.length) throw new NodeReleaseError('reviewed archive has no safe file list', 'archive_invalid');
  return entries;
}

function archiveListingTypes(listing, expectedCount) {
  const lines = String(listing ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (lines.length !== expectedCount)
    throw new NodeReleaseError('reviewed archive listing is inconsistent', 'archive_invalid');
  for (const line of lines) {
    const type = line[0];
    if (!['-', 'd'].includes(type) || /\s(?:hard )?link to\s/i.test(line))
      throw new NodeReleaseError('reviewed archive contains a link or special file', 'archive_unsafe_entry');
  }
}

async function walkRegularFiles(fsImpl, root, prefix = '') {
  const entries = await fsImpl.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkRegularFiles(fsImpl, absolute, relative)));
    else if (entry.isFile()) {
      const stat = await fsImpl.lstat(absolute);
      if (stat.nlink > 1) throw new NodeReleaseError('release archive contains a hard link', 'archive_unsafe_entry');
      files.push({ path: relative.replaceAll(path.sep, '/'), absolute });
    } else throw new NodeReleaseError('release archive contains a link or special file', 'archive_unsafe_entry');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function treeDigest(fsImpl, root) {
  const files = await walkRegularFiles(fsImpl, root);
  const entries = [];
  for (const file of files) entries.push({ path: file.path, sha256: await fileDigest(fsImpl, file.absolute) });
  return { entries, digest: digestJson(entries) };
}

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
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
  const compared = parsed.value;
  const relation = compareVersions(version, compared);
  if (operator === '>=') return relation >= 0;
  if (operator === '>') return relation > 0;
  if (operator === '<=') return relation <= 0;
  if (operator === '<') return relation < 0;
  if (operator === '=') return relation === 0;
  // npm's bare partial versions denote the corresponding major/minor band.
  const upper = upperForBareVersion(parsed);
  return upper ? relation >= 0 && compareVersions(version, upper) < 0 : relation === 0;
}

export function nodeEngineAllows(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const current = parseVersion(process.versions.node)?.value;
  if (!current) return false;
  return value.split(/\s*\|\|\s*/).some((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => satisfiesComparator(current, token));
  });
}

async function fileDigest(fsImpl, filePath) {
  return sha256(await fsImpl.readFile(filePath));
}

function timestamp(clock) {
  const value = typeof clock === 'function' ? clock() : clock?.now?.();
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[a-z][a-z0-9_:-]{0,63}$/.test(code) ? code : 'node_agent_failure';
}

function publicError(error, phase) {
  return { code: errorCode(error), phase: PHASES.has(phase) ? phase : 'unknown', message: 'node operation failed' };
}

function atomicLayoutPath(root, name) {
  return path.join(root, name);
}

async function writeAtomicJson(fsImpl, filePath, value) {
  const directory = path.dirname(filePath);
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    handle = await fsImpl.open(temporary, 'r');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, filePath);
    try {
      const directoryHandle = await fsImpl.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // The file itself was fsynced and atomically renamed. Some filesystems
      // do not permit opening a directory for fsync.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsImpl.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function copyAtomic(fsImpl, source, target) {
  const directory = path.dirname(target);
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsImpl.copyFile(source, temporary);
    const handle = await fsImpl.open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsImpl.rename(temporary, target);
  } catch (error) {
    await fsImpl.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function pathExists(fsImpl, target) {
  try {
    await fsImpl.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function pathToken(value) {
  return sha256(Buffer.from(value)).slice(0, 32);
}

function releaseToken(id) {
  return pathToken(id);
}

function snapshotId(operationId, nodeId, kind) {
  return `${kind}-${pathToken(`${operationId}:${nodeId}:${kind}`).slice(0, 20)}`;
}

function currentIdentityFromManifest(manifest, manifestSha256, configSha256) {
  const source = asObject(manifest);
  const artifactSha256 = typeof source.sha256 === 'string' ? source.sha256.toLowerCase() : '';
  const releaseId = source.releaseId ?? source.commit ?? source.id;
  if (!ID.test(String(releaseId ?? '')) || !DIGEST.test(artifactSha256)) return null;
  if (!DIGEST.test(String(manifestSha256 ?? '').toLowerCase())) return null;
  if (!DIGEST.test(String(configSha256 ?? '').toLowerCase())) return null;
  const dependencyDigest = typeof source.dependencyDigest === 'string' ? source.dependencyDigest.toLowerCase() : '';
  const runtimeContractDigest =
    typeof source.runtimeContractDigest === 'string' ? source.runtimeContractDigest.toLowerCase() : '';
  if (!DIGEST.test(dependencyDigest) || !DIGEST.test(runtimeContractDigest)) return null;
  return {
    releaseId: String(releaseId),
    artifactSha256,
    manifestSha256: manifestSha256.toLowerCase(),
    configSha256: configSha256.toLowerCase(),
    dependencyDigest,
    runtimeContractDigest
  };
}

function publicIdentity(value, label, { old = false } = {}) {
  const source = asObject(value);
  const result = {};
  for (const field of [
    'releaseId',
    'artifactSha256',
    'manifestSha256',
    'configSha256',
    'dependencyDigest',
    'runtimeContractDigest'
  ]) {
    if (source[field] === undefined) continue;
    if (field === 'releaseId') result[field] = safeId(source[field], `${label}.${field}`);
    else result[field] = digest(source[field], `${label}.${field}`);
  }
  for (const field of old
    ? ['releaseId', 'artifactSha256', 'manifestSha256']
    : ['releaseId', 'artifactSha256', 'manifestSha256', 'configSha256', 'dependencyDigest', 'runtimeContractDigest']) {
    if (result[field] === undefined) throw new NodeReleaseError(`${label}.${field} is missing`, 'identity_incomplete');
  }
  return result;
}

export class NodeReleaseError extends Error {
  constructor(message, code = 'node_agent_failure') {
    super(message);
    this.name = 'NodeReleaseError';
    this.code = code;
  }
}

/**
 * `gateway` is the same-node fence boundary. It must expose:
 *
 * - `inspect(context)` -> `{ gatewayProtocol, fenceProtocolVersion,
 *   atomicLayout, currentIdentity, loadedIdentity, serviceActive }`
 * - `prepare(context)` -> `{ fenced: true, drained: true }`
 * - `reprepare(context)` -> `{ fenced: true, drained: true }`
 * - `release(context)` -> `{ fenced: false }`
 * - `canary(context)` -> exact local model/runtime result
 *
 * The command runner is called only for the configured gateway unit, never a
 * model or runtime process. It receives `(command, argv, options)` and must
 * return `{ code, stdout, stderr }`.
 */
export class NodeReleaseAgent {
  constructor({
    nodeId,
    root,
    configPath,
    serviceUnit = 'lloom.service',
    platform = process.platform,
    serviceManager = 'systemd',
    fsImpl = fs,
    run = null,
    extractArchive = null,
    unitPath = null,
    dropInPaths = [],
    environmentPaths = [],
    gateway,
    clock = () => new Date()
  } = {}) {
    this.nodeId = safeId(nodeId, 'nodeId', SEGMENT);
    if (!root) throw new NodeReleaseError('release root is required', 'invalid_context');
    if (!configPath) throw new NodeReleaseError('configPath is required', 'invalid_context');
    if (platform !== 'linux' || serviceManager !== 'systemd')
      throw new NodeReleaseError('node agent supports Linux systemd gateways only', 'unsupported_scope');
    if (!gateway || typeof gateway !== 'object')
      throw new NodeReleaseError('gateway fence adapter is required', 'invalid_context');
    for (const method of ['inspect', 'prepare', 'reprepare', 'release', 'canary']) {
      if (typeof gateway[method] !== 'function')
        throw new NodeReleaseError(`gateway.${method} is required`, 'invalid_context');
    }
    if (typeof run !== 'function') throw new NodeReleaseError('systemd command runner is required', 'invalid_context');
    this.root = path.resolve(root);
    this.configPath = path.resolve(configPath);
    this.serviceUnit = safeId(serviceUnit, 'serviceUnit', SEGMENT);
    this.platform = platform;
    this.serviceManager = serviceManager;
    this.fs = fsImpl;
    this.run = run;
    this.extractArchive = extractArchive;
    this.unitPath = unitPath ? path.resolve(unitPath) : null;
    this.dropInPaths = Array.isArray(dropInPaths) ? dropInPaths.map((value) => path.resolve(value)) : [];
    this.environmentPaths = Array.isArray(environmentPaths) ? environmentPaths.map((value) => path.resolve(value)) : [];
    this.gateway = gateway;
    this.clock = clock;
  }

  async preflight(nodeId, context) {
    return this.#phase(nodeId, context, 'preflight', 'preflight', false, async () => {
      this.#assertContext(nodeId, context);
      const inspection = asObject(await this.gateway.inspect(context));
      const currentIdentity = await this.#readCurrentIdentity();
      const unit = await this.#systemd('is-active');
      if (unit.trim() !== 'active' || inspection.serviceActive === false)
        throw new NodeReleaseError('gateway systemd unit is not active', 'service_inactive');
      if (inspection.gatewayProtocol !== context.gatewayProtocol)
        throw new NodeReleaseError('gateway protocol does not match the reviewed plan', 'protocol_mismatch');
      if (inspection.fenceProtocolVersion !== NODE_AGENT_PROTOCOL)
        throw new NodeReleaseError('gateway fence protocol is missing or unsupported', 'fence_protocol_mismatch');
      if (inspection.atomicLayout !== true && inspection.atomicLayout !== 'atomic')
        throw new NodeReleaseError('gateway lacks the required atomic release layout', 'atomic_layout_required');
      if (!currentIdentity) throw new NodeReleaseError('current release identity is unknown', 'identity_unknown');
      if (!inspection.loadedIdentity)
        throw new NodeReleaseError('gateway did not report its loaded identity', 'loaded_identity_unknown');
      const loadedIdentity = publicIdentity(inspection.loadedIdentity, 'loaded identity', { old: true });
      if (
        !this.#matchesExpected(currentIdentity, context.expectedOldIdentity) ||
        !this.#matchesExpected(loadedIdentity, context.expectedOldIdentity)
      )
        throw new NodeReleaseError('loaded gateway identity drifted from the current release', 'loaded_identity_drift');
      if (inspection.fenced === true || inspection.drained === true)
        throw new NodeReleaseError('gateway is already fenced by another operation', 'fence_conflict');
      return {
        platform: this.platform,
        serviceManager: this.serviceManager,
        gatewayProtocol: context.gatewayProtocol,
        fenceProtocolVersion: NODE_AGENT_PROTOCOL,
        atomicLayout: true,
        currentIdentity: publicIdentity(currentIdentity, 'currentIdentity')
      };
    });
  }

  async stage(nodeId, context) {
    return this.#phase(nodeId, context, 'stage', 'stage', true, async (document) => {
      this.#assertContext(nodeId, context);
      const artifact = this.#artifact(context);
      const reviewedManifest = await this.#readReviewedManifest(artifact);
      const configSha256 = await fileDigest(this.fs, this.configPath);
      const reviewedIdentity = publicIdentity(
        currentIdentityFromManifest(reviewedManifest, artifact.manifestSha256, configSha256),
        'reviewed identity'
      );
      this.#assertContractBaseline(document, reviewedIdentity, 'stage');
      const token = releaseToken(artifact.id);
      const destination = path.join(this.root, 'releases', token);
      const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
      await this.fs.rm(temporary, { recursive: true, force: true });
      await this.fs.mkdir(temporary, { recursive: true, mode: 0o700 });
      await this.#extractArchive(artifact.path, temporary);
      const packageProof = await this.#validatePackage(temporary, reviewedManifest, artifact);
      const manifestName = 'release-manifest.json';
      // Preserve the reviewed bytes: the manifest digest is an identity field,
      // so reserializing equivalent JSON would create a different release.
      await copyAtomic(this.fs, artifact.manifestPath, path.join(temporary, manifestName));
      await writeAtomicJson(this.fs, path.join(temporary, 'stage.json'), {
        protocol: NODE_AGENT_PROTOCOL,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        manifestSha256: artifact.manifestSha256,
        manifestName,
        treeSha256: packageProof.treeSha256,
        dependencyDigest: packageProof.dependencyDigest,
        runtimeContractDigest: packageProof.runtimeContractDigest
      });
      let currentTarget;
      try {
        currentTarget = await this.fs.readlink(atomicLayoutPath(this.root, 'current'));
      } catch {
        currentTarget = null;
      }
      const resolvedDestination = path.resolve(destination);
      const resolvedCurrent = currentTarget ? path.resolve(this.root, currentTarget) : null;
      if (resolvedCurrent && resolvedCurrent === resolvedDestination)
        throw new NodeReleaseError('cannot replace the active release in place', 'stage_active_release');
      await this.fs.rm(destination, { recursive: true, force: true });
      await this.fs.rename(temporary, destination);
      return {
        staged: true,
        artifactSha256: artifact.sha256,
        manifestSha256: artifact.manifestSha256,
        treeSha256: packageProof.treeSha256,
        dependencyDigest: packageProof.dependencyDigest,
        runtimeContractDigest: packageProof.runtimeContractDigest
      };
    });
  }

  async prepare(nodeId, context) {
    return this.#phase(nodeId, context, 'prepare', 'prepare', true, async (document) => {
      this.#assertContext(nodeId, context);
      const current = await this.#readCurrentIdentity();
      if (!current || !this.#matchesExpected(current, context.expectedOldIdentity))
        throw new NodeReleaseError('current release identity drifted before prepare', 'identity_drift');
      const inspection = asObject(await this.gateway.inspect(context));
      this.#assertInspectionFence(inspection, current, context, 'prepare');
      const fence = this.#assertFence(await this.gateway.prepare(context), 'prepare');
      const backup = await this.#backup(context, current);
      // Keep only public-safe evidence and the old symlink target in the node
      // journal. The backup files are addressable from the operation id and
      // never need absolute paths persisted in a receipt.
      document.backup = {
        relativeTarget: backup.relativeTarget,
        configExisted: backup.configExisted,
        evidence: backup.evidence,
        files: backup.files
      };
      // Persist the backup descriptor before the coordinator can observe a
      // successful prepare. A crash between the filesystem snapshot and the
      // receipt write must still leave rollback enough evidence to proceed.
      await writeAtomicJson(this.fs, this.#journalPath(context), document);
      return { ...fence, backup: backup.evidence, snapshot: backup.evidence };
    });
  }

  async swap(nodeId, context) {
    return this.#phase(nodeId, context, 'swap', 'swap', true, async (document) => {
      this.#assertContext(nodeId, context);
      const staged = await this.#staged(context);
      if (!document.backup) throw new NodeReleaseError('swap requires a durable prepare backup', 'prepare_required');
      const inspection = asObject(await this.gateway.inspect(context));
      const current = await this.#readCurrentIdentity();
      this.#assertInspectionFence(inspection, current, context, 'swap');
      const currentPathBefore = await this.fs.readlink(atomicLayoutPath(this.root, 'current'));
      if (currentPathBefore !== document.backup.relativeTarget)
        throw new NodeReleaseError('current release target changed after prepare', 'layout_drift');
      const currentPath = atomicLayoutPath(this.root, 'current');
      const temporary = `${currentPath}.tmp-${process.pid}-${randomUUID()}`;
      const relative = path.relative(this.root, staged.destination);
      const manifestPath = atomicLayoutPath(this.root, 'current.manifest.json');
      const oldManifestSha256 = await fileDigest(this.fs, manifestPath);
      const newManifestSha256 = await fileDigest(this.fs, path.join(staged.destination, staged.manifestName));
      document.swapIntent = {
        oldTarget: currentPathBefore,
        newTarget: relative,
        oldManifestSha256,
        newManifestSha256
      };
      // This intent is durable before either pointer can change. Recovery can
      // therefore distinguish a complete swap from either half of the two
      // pointer updates without trusting an absent receipt.
      await writeAtomicJson(this.fs, this.#journalPath(context), document);
      await this.fs.symlink(relative, temporary);
      await this.fs.rename(temporary, currentPath);
      document.swapPointerApplied = true;
      await writeAtomicJson(this.fs, this.#journalPath(context), document);
      await copyAtomic(this.fs, path.join(staged.destination, staged.manifestName), manifestPath);
      document.swapManifestApplied = true;
      await writeAtomicJson(this.fs, this.#journalPath(context), document);
      const identity = publicIdentity(await this.#readCurrentIdentity(), 'swap identity');
      this.#assertContractBaseline(document, identity, 'swap');
      if (
        !identity ||
        identity.artifactSha256 !== context.artifact.sha256 ||
        identity.manifestSha256 !== context.artifact.manifestSha256
      )
        throw new NodeReleaseError('atomic swap did not expose the reviewed identity', 'identity_mismatch');
      document.postSwapIdentity = identity;
      return { applied: true, identity, snapshot: document.backup.evidence };
    });
  }

  async restart(nodeId, context) {
    return this.#phase(nodeId, context, 'restart', 'restart', true, async (document) => {
      this.#assertContext(nodeId, context);
      await this.#systemd('restart');
      const unit = await this.#systemd('is-active');
      if (unit.trim() !== 'active')
        throw new NodeReleaseError('gateway did not return active after restart', 'service_unhealthy');
      const inspection = asObject(await this.gateway.inspect(context));
      const identity = publicIdentity(
        inspection.loadedIdentity ?? (await this.#readCurrentIdentity()),
        'loaded identity'
      );
      if (
        !identity ||
        identity.artifactSha256 !== context.artifact.sha256 ||
        identity.manifestSha256 !== context.artifact.manifestSha256 ||
        identity.dependencyDigest !== document.postSwapIdentity?.dependencyDigest ||
        identity.runtimeContractDigest !== document.postSwapIdentity?.runtimeContractDigest
      )
        throw new NodeReleaseError(
          'loaded gateway identity does not match the reviewed release',
          'loaded_identity_mismatch'
        );
      this.#assertContractBaseline(document, identity, 'restart');
      if (inspection.loadedIdentity === undefined)
        throw new NodeReleaseError('gateway did not report the loaded release identity', 'loaded_identity_unknown');
      if (inspection.fenced !== true || inspection.drained !== true)
        throw new NodeReleaseError('gateway lost its deployment fence during restart', 'fence_not_ready');
      return {
        serviceRestarted: true,
        healthy: true,
        identity,
        snapshot: document.backup?.evidence ?? this.#evidence(context, identity)
      };
    });
  }

  async verify(nodeId, context) {
    return this.#phase(nodeId, context, 'verify', 'verify', false, async (document) => {
      this.#assertContext(nodeId, context);
      const inspection = asObject(await this.gateway.inspect(context));
      const identity = publicIdentity(inspection.loadedIdentity, 'loaded identity');
      if (
        !identity ||
        identity.artifactSha256 !== context.artifact.sha256 ||
        identity.manifestSha256 !== context.artifact.manifestSha256
      )
        throw new NodeReleaseError(
          'verification did not prove the loaded reviewed release',
          'loaded_identity_mismatch'
        );
      this.#assertContractBaseline(document, identity, 'verify');
      if (inspection.fenced !== true || inspection.drained !== true)
        throw new NodeReleaseError('verification requires the gateway to remain fenced', 'fence_not_ready');
      return { verified: true, identity, snapshot: document.backup?.evidence ?? this.#evidence(context, identity) };
    });
  }

  async canary(nodeId, context) {
    return this.#phase(nodeId, context, 'canary', 'canary', false, async () => {
      this.#assertContext(nodeId, context);
      const result = asObject(await this.gateway.canary(context));
      if (
        result.privileged !== true ||
        result.fenced !== true ||
        result.healthy !== true ||
        result.aliasUsed !== false ||
        result.cloudFallback !== false ||
        result.source !== 'local' ||
        result.gatewayModelId !== context.canary?.gatewayModelId ||
        result.runtimeId !== context.canary?.runtimeId
      )
        throw new NodeReleaseError('canary was not privileged on the fenced gateway', 'canary_not_fenced');
      return {
        healthy: true,
        gatewayModelId: safeId(result.gatewayModelId, 'canary.gatewayModelId'),
        runtimeId: safeId(result.runtimeId, 'canary.runtimeId'),
        fenced: true,
        privileged: true,
        aliasUsed: false,
        cloudFallback: false,
        source: 'local'
      };
    });
  }

  async promote(nodeId, context) {
    return this.#phase(nodeId, context, 'promote', 'promote', true, async (document) => {
      this.#assertContext(nodeId, context);
      const identity = await this.#loadedIdentity(context);
      if (!identity) throw new NodeReleaseError('cannot promote without loaded identity', 'loaded_identity_unknown');
      this.#assertContractBaseline(document, identity, 'promote');
      await writeAtomicJson(this.fs, path.join(this.#operationDirectory(context), 'promoted.json'), {
        operationId: context.operationId,
        generation: context.generation,
        nodeId: this.nodeId,
        identity
      });
      return { promoted: true, identity, snapshot: document.backup?.evidence ?? this.#evidence(context, identity) };
    });
  }

  async release(nodeId, context) {
    return this.#phase(nodeId, context, 'release', 'release', true, async () => {
      this.#assertContext(nodeId, context);
      const identity = await this.#loadedIdentity(context);
      if (
        !identity ||
        identity.artifactSha256 !== context.artifact.sha256 ||
        identity.manifestSha256 !== context.artifact.manifestSha256
      )
        throw new NodeReleaseError(
          'release requires the reviewed gateway identity to be loaded',
          'loaded_identity_mismatch'
        );
      const result = asObject(await this.gateway.release(context));
      if (result.fenced !== false)
        throw new NodeReleaseError('gateway did not affirm public release', 'release_not_affirmed');
      return { released: true, fenced: false };
    });
  }

  async reprepare(nodeId, context) {
    return this.#phase(nodeId, context, 'reprepare', 'reprepare', true, async () => {
      this.#assertContext(nodeId, context);
      return this.#assertFence(await this.gateway.reprepare(context), 'reprepare');
    });
  }

  async rollback(nodeId, context) {
    return this.#phase(nodeId, context, 'rollback', 'rollback', true, async (document) => {
      this.#assertContext(nodeId, context);
      const backup = document.backup;
      const fence = await this.gateway.reprepare(context);
      if (fence?.fenced !== true || fence?.drained !== true)
        throw new NodeReleaseError('rollback requires a fresh fence and drain', 'fence_not_ready');
      if (!backup) {
        // A prepare may have fenced the gateway before its filesystem backup
        // descriptor was journaled. Prove that the old identity is still on
        // disk; otherwise leave the node fenced and fail closed.
        const identity = publicIdentity(await this.#readCurrentIdentity(), 'rollback identity', { old: true });
        if (!this.#matchesExpected(identity, context.expectedOldIdentity))
          throw new NodeReleaseError('rollback has no durable backup for the changed identity', 'backup_missing');
        return { restored: true, fenced: true, identity };
      }
      await this.#repairPartialSwap(context, document);
      const current = await this.#readCurrentIdentity();
      const loaded = await this.#loadedIdentity(context);
      if (document.postSwapIdentity) {
        const currentIsExpectedOld = this.#matchesExpected(current, context.expectedOldIdentity);
        const loadedIsExpectedOld = this.#matchesExpected(loaded, context.expectedOldIdentity);
        if (
          (!this.#identitiesEqual(current, document.postSwapIdentity) && !currentIsExpectedOld) ||
          (!this.#identitiesEqual(loaded, document.postSwapIdentity) && !loadedIsExpectedOld)
        )
          throw new NodeReleaseError(
            'rollback found an unreviewed live identity; refusing overwrite',
            'rollback_cas_failed'
          );
      }
      const currentConfigSha256 = await fileDigest(this.fs, this.configPath);
      if (backup.files?.configSha256 && currentConfigSha256 !== backup.files.configSha256)
        throw new NodeReleaseError('rollback config changed after prepare', 'rollback_cas_failed');
      const currentPath = atomicLayoutPath(this.root, 'current');
      const backupRelease = path.join(this.#operationDirectory(context), 'previous-release');
      const rollbackRelease = path.join(this.root, 'releases', `rollback-${releaseToken(context.operationId)}`);
      if (!backup.files || !backup.files.releaseTreeSha256)
        throw new NodeReleaseError('rollback snapshot evidence is incomplete', 'backup_incomplete');
      const backupProof = await treeDigest(this.fs, backupRelease);
      if (backupProof.digest !== backup.files.releaseTreeSha256)
        throw new NodeReleaseError('rollback snapshot bytes changed', 'snapshot_digest_mismatch');
      for (const [label, filePath] of [
        ['unit', this.unitPath],
        ...this.dropInPaths.map((value, index) => [`dropIn-${index}`, value]),
        ...this.environmentPaths.map((value, index) => [`environment-${index}`, value])
      ]) {
        const expected = backup.files[`${label}Sha256`];
        if (!expected || !filePath) continue;
        if (!(await pathExists(this.fs, filePath)) || (await fileDigest(this.fs, filePath)) !== expected)
          throw new NodeReleaseError(`${label} changed after prepare`, 'rollback_cas_failed');
      }
      await this.fs.rm(rollbackRelease, { recursive: true, force: true });
      await this.#copyTree(backupRelease, rollbackRelease);
      const temporary = `${currentPath}.rollback-${process.pid}-${randomUUID()}`;
      await this.fs.symlink(path.relative(this.root, rollbackRelease), temporary);
      await this.fs.rename(temporary, currentPath);
      const operationDirectory = this.#operationDirectory(context);
      await copyAtomic(
        this.fs,
        path.join(operationDirectory, 'current.manifest.json'),
        atomicLayoutPath(this.root, 'current.manifest.json')
      );
      if (backup.configExisted)
        await copyAtomic(this.fs, path.join(operationDirectory, 'config.json'), this.configPath);
      await this.#systemd('restart');
      const identity = publicIdentity(await this.#readCurrentIdentity(), 'rollback identity', { old: true });
      if (!identity || !this.#matchesExpected(identity, context.expectedOldIdentity))
        throw new NodeReleaseError('rollback did not restore the expected old identity', 'rollback_identity_mismatch');
      const inspection = asObject(await this.gateway.inspect(context));
      const loadedAfter = publicIdentity(inspection.loadedIdentity, 'rollback loaded identity', { old: true });
      if (!this.#matchesExpected(loadedAfter, context.expectedOldIdentity) || inspection.serviceActive === false)
        throw new NodeReleaseError(
          'rollback did not restore the loaded old identity',
          'rollback_loaded_identity_mismatch'
        );
      if (inspection.runtimeSnapshot && digestJson(inspection.runtimeSnapshot) !== backup.files.runtimeSnapshotSha256)
        throw new NodeReleaseError(
          'rollback runtime snapshot does not match the prepared gateway',
          'rollback_runtime_mismatch'
        );
      return { restored: true, fenced: true, identity };
    });
  }

  async discardStage(nodeId, context) {
    return this.#phase(nodeId, context, 'discard-stage', 'discardStage', true, async () => {
      this.#assertContext(nodeId, context);
      const destination = path.join(this.root, 'releases', releaseToken(context.artifact.id));
      const current = await this.fs.readlink(atomicLayoutPath(this.root, 'current')).catch(() => null);
      if (current && path.resolve(this.root, current) === path.resolve(destination))
        throw new NodeReleaseError('refusing to discard the active release', 'active_release');
      await this.fs.rm(destination, { recursive: true, force: true });
      return { stageDiscarded: true };
    });
  }

  async #repairPartialSwap(context, document) {
    const intent = asObject(document.swapIntent);
    if (
      !intent.oldTarget ||
      !intent.newTarget ||
      !DIGEST.test(String(intent.oldManifestSha256 ?? '')) ||
      !DIGEST.test(String(intent.newManifestSha256 ?? ''))
    )
      return;
    const currentPath = atomicLayoutPath(this.root, 'current');
    const manifestPath = atomicLayoutPath(this.root, 'current.manifest.json');
    const pointer = await this.fs.readlink(currentPath).catch(() => null);
    if (pointer !== intent.oldTarget && pointer !== intent.newTarget)
      throw new NodeReleaseError('rollback found an unknown current release pointer', 'rollback_cas_failed');
    let manifestSha256;
    try {
      manifestSha256 = await fileDigest(this.fs, manifestPath);
    } catch {
      throw new NodeReleaseError('rollback found an unknown current manifest', 'rollback_cas_failed');
    }
    if (manifestSha256 !== intent.oldManifestSha256 && manifestSha256 !== intent.newManifestSha256)
      throw new NodeReleaseError('rollback found an unknown current manifest', 'rollback_cas_failed');
    if (manifestSha256 === intent.newManifestSha256)
      await copyAtomic(this.fs, path.join(this.#operationDirectory(context), 'current.manifest.json'), manifestPath);
    if (pointer === intent.newTarget) {
      const observed = await this.fs.readlink(currentPath).catch(() => null);
      if (observed !== intent.newTarget)
        throw new NodeReleaseError('rollback current release pointer changed during recovery', 'rollback_cas_failed');
      const temporary = `${currentPath}.repair-${process.pid}-${randomUUID()}`;
      await this.fs.symlink(intent.oldTarget, temporary);
      await this.fs.rename(temporary, currentPath);
    }
  }

  #assertContext(nodeId, context) {
    if (nodeId !== this.nodeId || context?.nodeId !== this.nodeId)
      throw new NodeReleaseError('node identity does not match the agent', 'node_identity_mismatch');
    safeId(context.operationId, 'operationId');
    if (!Number.isInteger(context.generation) || context.generation < 1)
      throw new NodeReleaseError('generation is invalid', 'invalid_context');
    digest(context.planHash, 'planHash');
    if (
      context.scope?.platform !== 'linux' ||
      context.scope?.serviceManager !== 'systemd' ||
      context.scope?.mode !== 'gateway'
    )
      throw new NodeReleaseError('unsupported gateway scope', 'unsupported_scope');
    if (
      !context.artifact ||
      !DIGEST.test(String(context.artifact.sha256 ?? '')) ||
      !DIGEST.test(String(context.artifact.manifestSha256 ?? ''))
    )
      throw new NodeReleaseError('reviewed artifact identity is incomplete', 'invalid_context');
    if (context.artifact.reviewed !== true) throw new NodeReleaseError('artifact was not reviewed', 'invalid_context');
    publicIdentity(context.expectedOldIdentity, 'expectedOldIdentity', { old: true });
  }

  #artifact(context) {
    const artifact = asObject(context.artifact);
    const artifactPath = safeId(artifact.path, 'artifact.path', /^[^\r\n]+$/);
    const manifestPath = safeId(artifact.manifestPath, 'artifact.manifestPath', /^[^\r\n]+$/);
    return {
      id: safeId(artifact.id, 'artifact.id'),
      path: path.resolve(artifactPath),
      manifestPath: path.resolve(manifestPath),
      sha256: digest(artifact.sha256, 'artifact.sha256'),
      manifestSha256: digest(artifact.manifestSha256, 'artifact.manifestSha256')
    };
  }

  async #readReviewedManifest(artifact) {
    const [artifactDigest, manifestBytes] = await Promise.all([
      fileDigest(this.fs, artifact.path),
      this.fs.readFile(artifact.manifestPath)
    ]);
    if (artifactDigest !== artifact.sha256)
      throw new NodeReleaseError('reviewed artifact digest mismatch', 'artifact_digest_mismatch');
    if (sha256(manifestBytes) !== artifact.manifestSha256)
      throw new NodeReleaseError('reviewed manifest digest mismatch', 'manifest_digest_mismatch');
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new NodeReleaseError('reviewed manifest is not valid JSON', 'manifest_invalid');
    }
    if (manifest.sha256 !== artifact.sha256)
      throw new NodeReleaseError('manifest does not name the reviewed artifact', 'manifest_identity_mismatch');
    return manifest;
  }

  async #extractArchive(artifactPath, destination) {
    if (this.extractArchive) {
      await this.extractArchive({ artifactPath, destination, fs: this.fs });
      return;
    }
    const listing = await this.#archiveCommand(['--list', '--file', artifactPath]);
    // Reject links, hard links, special files, traversal and duplicate names
    // from the verbose type listing before tar gets a chance to write any
    // bytes.  A fresh destination alone is not sufficient: a symlink entry
    // can become an ancestor for a later regular-file entry.
    const entries = archivePathEntries(listing.stdout);
    const typedListing = await this.#archiveCommand(['--list', '--verbose', '--numeric-owner', '--file', artifactPath]);
    archiveListingTypes(typedListing.stdout, entries.length);
    await this.#archiveCommand([
      '--extract',
      '--no-same-owner',
      '--no-same-permissions',
      '--file',
      artifactPath,
      '--directory',
      destination
    ]);
  }

  async #archiveCommand(argv) {
    const result = await this.run('tar', argv, { timeoutMs: 120000 });
    if (result?.code !== 0)
      throw new NodeReleaseError('reviewed archive could not be safely extracted', 'archive_extract_failed');
    return result;
  }

  async #validatePackage(destination, manifest, artifact) {
    const packagePath = path.join(destination, 'package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(await this.fs.readFile(packagePath, 'utf8'));
    } catch {
      throw new NodeReleaseError('reviewed archive has no valid package.json', 'package_invalid');
    }
    if (!nodeEngineAllows(manifest.engines?.node ?? packageJson.engines?.node))
      throw new NodeReleaseError('reviewed package requires an unsupported Node engine', 'node_engine_mismatch');
    const closure = asObject(manifest.dependencyClosure ?? manifest.dependencies);
    if (!Object.keys(closure).length)
      throw new NodeReleaseError('reviewed manifest has no dependency closure', 'dependency_closure_missing');
    const dependencyDigest =
      typeof manifest.dependencyDigest === 'string' ? manifest.dependencyDigest.toLowerCase() : '';
    if (!DIGEST.test(dependencyDigest) || dependencyDigest !== digestJson(closure))
      throw new NodeReleaseError('reviewed dependency closure digest is invalid', 'dependency_digest_mismatch');
    const declared = asObject(packageJson.dependencies);
    if (
      Object.keys(packageJson.optionalDependencies ?? {}).length ||
      Object.keys(packageJson.peerDependencies ?? {}).length
    )
      throw new NodeReleaseError(
        'optional and peer dependencies are unsupported in a reviewed gateway release',
        'dependency_closure_mismatch'
      );
    const declaredNames = Object.keys(declared).sort();
    const closureNames = Object.keys(closure).sort();
    if (stableJson(declaredNames) !== stableJson(closureNames))
      throw new NodeReleaseError(
        'reviewed dependency closure does not exactly match package.json',
        'dependency_closure_mismatch'
      );
    for (const [name, version] of Object.entries(closure)) {
      if (
        !/^(?:[A-Za-z0-9][A-Za-z0-9._~-]*|@[A-Za-z0-9][A-Za-z0-9._~-]*\/[A-Za-z0-9][A-Za-z0-9._~-]*)$/.test(name) ||
        name.includes('..')
      )
        throw new NodeReleaseError('reviewed dependency name is unsafe', 'dependency_closure_mismatch');
      if (declared[name] !== version)
        throw new NodeReleaseError(`dependency ${name} is absent from package.json`, 'dependency_closure_mismatch');
      const dependencyPackage = path.join(destination, 'node_modules', name, 'package.json');
      let installed;
      try {
        installed = JSON.parse(await this.fs.readFile(dependencyPackage, 'utf8'));
      } catch {
        throw new NodeReleaseError(
          `dependency ${name} is absent from the reviewed package`,
          'dependency_closure_mismatch'
        );
      }
      if (installed.version !== version)
        throw new NodeReleaseError(`dependency ${name} version is not reviewed`, 'dependency_closure_mismatch');
    }
    if (!DIGEST.test(String(manifest.runtimeContractDigest ?? '').toLowerCase()))
      throw new NodeReleaseError('runtime contract digest is missing', 'runtime_contract_missing');
    const expectedFiles = Array.isArray(manifest.files)
      ? manifest.files
          .map((entry) => ({ path: entry?.path, sha256: String(entry?.sha256 ?? '').toLowerCase() }))
          .sort((a, b) => String(a.path).localeCompare(String(b.path)))
      : null;
    if (
      !expectedFiles?.length ||
      expectedFiles.some((entry) => !safeArchivePath(entry.path) || !DIGEST.test(entry.sha256))
    )
      throw new NodeReleaseError('reviewed manifest file inventory is missing or invalid', 'file_inventory_missing');
    const actual = await treeDigest(this.fs, destination);
    const actualEntries = actual.entries.filter(
      (entry) => entry.path !== 'stage.json' && entry.path !== 'release-manifest.json'
    );
    if (stableJson(actualEntries) !== stableJson(expectedFiles))
      throw new NodeReleaseError('reviewed archive bytes do not match its file inventory', 'file_inventory_mismatch');
    const treeSha256 = digestJson(actualEntries);
    if (manifest.treeSha256 !== treeSha256)
      throw new NodeReleaseError('reviewed archive tree digest does not match its manifest', 'tree_digest_mismatch');
    if (manifest.sha256 !== artifact.sha256)
      throw new NodeReleaseError('reviewed package identity does not match artifact', 'manifest_identity_mismatch');
    return {
      treeSha256,
      dependencyDigest,
      runtimeContractDigest: manifest.runtimeContractDigest.toLowerCase()
    };
  }

  async #readCurrentIdentity() {
    const manifestPath = atomicLayoutPath(this.root, 'current.manifest.json');
    const manifestBytes = await this.fs.readFile(manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      return null;
    }
    const currentTarget = await this.fs.readlink(atomicLayoutPath(this.root, 'current'));
    if (!currentTarget || path.isAbsolute(currentTarget) || currentTarget.split(path.sep).includes('..')) return null;
    const packageRoot = path.resolve(this.root, currentTarget);
    if (!packageRoot.startsWith(`${this.root}${path.sep}`)) return null;
    const packagedManifestPath = path.join(packageRoot, 'release-manifest.json');
    let packagedManifest;
    let packagedManifestBytes;
    try {
      packagedManifestBytes = await this.fs.readFile(packagedManifestPath);
      packagedManifest = JSON.parse(packagedManifestBytes.toString('utf8'));
    } catch {
      return null;
    }
    if (packagedManifest.sha256 !== manifest.sha256) return null;
    const configSha256 = await fileDigest(this.fs, this.configPath);
    if (Array.isArray(packagedManifest.files)) {
      await this.#validatePackage(packageRoot, packagedManifest, { sha256: packagedManifest.sha256 });
    } else {
      return null;
    }
    const diskIdentity = currentIdentityFromManifest(manifest, sha256(manifestBytes), configSha256);
    const verifiedIdentity = currentIdentityFromManifest(packagedManifest, sha256(packagedManifestBytes), configSha256);
    if (
      !diskIdentity ||
      !verifiedIdentity ||
      !['releaseId', 'artifactSha256', 'dependencyDigest', 'runtimeContractDigest'].every(
        (field) => diskIdentity[field] === verifiedIdentity[field]
      )
    )
      return null;
    return diskIdentity;
  }

  async #loadedIdentity(context) {
    const inspection = asObject(await this.gateway.inspect(context));
    return inspection.loadedIdentity ? publicIdentity(inspection.loadedIdentity, 'loaded identity') : null;
  }

  async #staged(context) {
    const artifact = this.#artifact(context);
    const destination = path.join(this.root, 'releases', releaseToken(artifact.id));
    let stage;
    try {
      stage = asObject(JSON.parse(await this.fs.readFile(path.join(destination, 'stage.json'), 'utf8')));
    } catch {
      throw new NodeReleaseError('staged release metadata is missing', 'stage_missing');
    }
    if (
      stage.artifactId !== artifact.id ||
      stage.artifactSha256 !== artifact.sha256 ||
      stage.manifestSha256 !== artifact.manifestSha256 ||
      stage.manifestName !== 'release-manifest.json' ||
      !DIGEST.test(String(stage.treeSha256 ?? '')) ||
      !DIGEST.test(String(stage.dependencyDigest ?? '')) ||
      !DIGEST.test(String(stage.runtimeContractDigest ?? ''))
    ) {
      throw new NodeReleaseError(
        'staged release metadata does not match the reviewed artifact',
        'stage_identity_mismatch'
      );
    }
    const manifest = JSON.parse(await this.fs.readFile(path.join(destination, stage.manifestName), 'utf8'));
    const proof = await this.#validatePackage(destination, manifest, artifact);
    if (
      proof.treeSha256 !== stage.treeSha256 ||
      proof.dependencyDigest !== stage.dependencyDigest ||
      proof.runtimeContractDigest !== stage.runtimeContractDigest
    )
      throw new NodeReleaseError('staged release bytes changed after verification', 'stage_digest_mismatch');
    return { destination, manifestName: stage.manifestName, treeSha256: proof.treeSha256 };
  }

  async #backup(context, current) {
    const operationDirectory = this.#operationDirectory(context);
    await this.fs.mkdir(operationDirectory, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(operationDirectory, 'current.manifest.json');
    await copyAtomic(this.fs, atomicLayoutPath(this.root, 'current.manifest.json'), manifestPath);
    const configExisted = await pathExists(this.fs, this.configPath);
    const configPath = path.join(operationDirectory, 'config.json');
    if (configExisted) await copyAtomic(this.fs, this.configPath, configPath);
    const target = await this.fs.readlink(atomicLayoutPath(this.root, 'current'));
    const relativeTarget = target.replace(/^\.?\//, '');
    if (!relativeTarget || path.isAbsolute(relativeTarget) || relativeTarget.split(path.sep).includes('..'))
      throw new NodeReleaseError('current release target is unsafe', 'layout_invalid');
    const sourceRelease = path.resolve(this.root, relativeTarget);
    if (!sourceRelease.startsWith(`${this.root}${path.sep}`))
      throw new NodeReleaseError('current release target escapes the release root', 'layout_invalid');
    const backupRelease = path.join(operationDirectory, 'previous-release');
    await this.fs.rm(backupRelease, { recursive: true, force: true });
    await this.#copyTree(sourceRelease, backupRelease);
    const files = { configSha256: configExisted ? await fileDigest(this.fs, this.configPath) : null };
    const ancillary = path.join(operationDirectory, 'ancillary');
    const ancillarySources = [
      ['unit', this.unitPath],
      ...this.dropInPaths.map((filePath, index) => [`dropIn-${index}`, filePath]),
      ...this.environmentPaths.map((filePath, index) => [`environment-${index}`, filePath])
    ];
    for (const [label, filePath] of ancillarySources) {
      if (!filePath || !(await pathExists(this.fs, filePath))) continue;
      const destination = path.join(ancillary, label);
      await copyAtomic(this.fs, filePath, destination);
      files[`${label}Sha256`] = await fileDigest(this.fs, filePath);
    }
    const releaseProof = await treeDigest(this.fs, backupRelease);
    files.releaseTreeSha256 = releaseProof.digest;
    const inspection = asObject(await this.gateway.inspect(context));
    if (!inspection.runtimeSnapshot || typeof inspection.runtimeSnapshot !== 'object')
      throw new NodeReleaseError('gateway did not provide a runtime snapshot', 'runtime_snapshot_missing');
    files.runtimeSnapshotSha256 = digestJson(inspection.runtimeSnapshot);
    await writeAtomicJson(this.fs, path.join(operationDirectory, 'runtime-snapshot.json'), inspection.runtimeSnapshot);
    const evidence = {
      id: snapshotId(context.operationId, this.nodeId, 'snapshot'),
      sha256: digestJson({ current, target: relativeTarget, files })
    };
    return { relativeTarget, manifestPath, configPath, configExisted, evidence, files };
  }

  async #copyTree(source, destination) {
    const stat = await this.fs.lstat(source);
    if (!stat.isDirectory()) throw new NodeReleaseError('release snapshot is not a directory', 'snapshot_invalid');
    await this.fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const entries = await this.fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) await this.#copyTree(from, to);
      else if (entry.isFile()) await copyAtomic(this.fs, from, to);
      else throw new NodeReleaseError('release snapshot contains a link or special file', 'snapshot_invalid');
    }
  }

  #operationDirectory(context) {
    return path.join(this.root, 'operations', pathToken(context.operationId), this.nodeId);
  }

  #journalPath(context) {
    return path.join(this.#operationDirectory(context), 'journal.json');
  }

  #matchesExpected(actual, expected) {
    return Object.entries(asObject(expected)).every(([key, value]) => actual?.[key] === value);
  }

  #identitiesEqual(left, right) {
    if (!left || !right) return false;
    return [
      'releaseId',
      'artifactSha256',
      'manifestSha256',
      'configSha256',
      'dependencyDigest',
      'runtimeContractDigest'
    ].every((field) => left[field] === right[field]);
  }

  #assertContractBaseline(document, identity, phase) {
    const baseline = document.receipts?.preflight?.currentIdentity;
    if (!baseline) return;
    for (const field of ['configSha256', 'dependencyDigest', 'runtimeContractDigest']) {
      if (baseline[field] !== undefined && identity?.[field] !== baseline[field])
        throw new NodeReleaseError(`${phase} changed the reviewed gateway contract`, 'runtime_contract_mismatch');
    }
  }

  #assertInspectionFence(inspection, current, context, phase) {
    if (!inspection || inspection.gatewayProtocol !== context.gatewayProtocol)
      throw new NodeReleaseError(`${phase} gateway protocol changed`, 'protocol_mismatch');
    if (
      inspection.fenceProtocolVersion !== NODE_AGENT_PROTOCOL ||
      (inspection.atomicLayout !== true && inspection.atomicLayout !== 'atomic')
    )
      throw new NodeReleaseError(`${phase} gateway fence/layout contract is unsupported`, 'fence_protocol_mismatch');
    if (
      !inspection.loadedIdentity ||
      !this.#matchesExpected(
        publicIdentity(inspection.loadedIdentity, 'loaded identity', { old: true }),
        context.expectedOldIdentity
      )
    )
      throw new NodeReleaseError(`${phase} loaded gateway identity drifted`, 'loaded_identity_drift');
    if (!this.#matchesExpected(current, context.expectedOldIdentity))
      throw new NodeReleaseError(`${phase} current release identity drifted`, 'identity_drift');
    if (phase !== 'prepare' && (inspection.fenced !== true || inspection.drained !== true))
      throw new NodeReleaseError(`${phase} requires a fenced drained gateway`, 'fence_not_ready');
  }

  #evidence(context, identity) {
    return {
      id: snapshotId(context.operationId, this.nodeId, 'snapshot'),
      sha256: sha256(Buffer.from(JSON.stringify(identity)))
    };
  }

  #assertFence(result, phase) {
    const value = asObject(result);
    if (value.fenced !== true || value.drained !== true) {
      throw new NodeReleaseError(`${phase} did not affirm a fenced drained gateway`, 'fence_not_ready');
    }
    return { fenced: true, drained: true };
  }

  async #systemd(action) {
    if (!['is-active', 'restart'].includes(action))
      throw new NodeReleaseError('node agent may only inspect or restart its gateway unit', 'unsupported_mutation');
    const result = await this.run('systemctl', ['--user', action, this.serviceUnit], { timeoutMs: 120000 });
    if (result?.code !== 0) throw new NodeReleaseError(`systemd ${action} failed`, 'systemd_failure');
    return String(result.stdout ?? '');
  }

  async #phase(nodeId, context, phase, method, mutation, work) {
    if (!PHASES.has(phase)) throw new NodeReleaseError(`unsupported node phase ${phase}`, 'invalid_context');
    this.#assertContext(nodeId, context);
    await this.#acquireLock(context);
    try {
      await this.#acquireInvocationLock(context);
      try {
        const filePath = this.#journalPath(context);
        const document = (await this.#load(filePath)) ?? {
          protocol: NODE_AGENT_PROTOCOL,
          operationId: context.operationId,
          generation: context.generation,
          planHash: context.planHash,
          nodeId: this.nodeId,
          receipts: {},
          pendingAction: null,
          state: 'preflight',
          backup: null,
          updatedAt: timestamp(this.clock)
        };
        document.receipts ??= {};
        if (
          document.operationId !== context.operationId ||
          document.nodeId !== this.nodeId ||
          document.planHash !== context.planHash
        )
          throw new NodeReleaseError('node journal identity mismatch', 'journal_identity_mismatch');
        if (document.generation > context.generation)
          throw new NodeReleaseError('node journal generation is newer than the request', 'stale_generation');
        if (document.generation < context.generation) {
          if (document.receipts[phase] && !['reprepare', 'rollback'].includes(phase))
            throw new NodeReleaseError('phase receipt belongs to an older generation', 'stale_generation');
          document.generation = context.generation;
          if (['reprepare', 'rollback'].includes(phase)) delete document.receipts[phase];
        }
        if (document.receipts[phase]) {
          if (document.receipts[phase].generation !== context.generation)
            throw new NodeReleaseError('phase receipt generation is stale', 'stale_generation');
          if (['release', 'rollback', 'discard-stage'].includes(phase)) await this.#releaseLock(context);
          return clone(document.receipts[phase]);
        }
        this.#assertPhaseOrder(document, phase);
        if (document.pendingAction && !['reprepare', 'rollback'].includes(phase))
          throw new NodeReleaseError('node journal contains an uncertain pending action', 'operation_uncertain');
        if (document.pendingAction) {
          document.uncertainAction = document.pendingAction;
          document.pendingAction = null;
        }
        document.pendingAction = phase;
        document.mutationPossible = Boolean(document.mutationPossible || mutation);
        document.updatedAt = timestamp(this.clock);
        await writeAtomicJson(this.fs, filePath, document);
        try {
          const body = await work(document);
          const receipt = {
            operationId: context.operationId,
            generation: context.generation,
            nodeId: this.nodeId,
            phase,
            status: 'ok',
            observedAt: timestamp(this.clock),
            ...this.#publicBody(body)
          };
          document.receipts[phase] = receipt;
          document.pendingAction = null;
          document.state = phase === 'discard-stage' ? 'rolled-back' : phase;
          document.updatedAt = timestamp(this.clock);
          await writeAtomicJson(this.fs, filePath, document);
          if (['release', 'rollback', 'discard-stage'].includes(phase)) await this.#releaseLock(context);
          return receipt;
        } catch (error) {
          document.state = 'unknown';
          document.error = publicError(error, phase);
          document.updatedAt = timestamp(this.clock);
          await writeAtomicJson(this.fs, filePath, document).catch(() => {});
          throw error;
        }
      } finally {
        await this.#releaseInvocationLock(context);
      }
    } catch (error) {
      // A failed preflight has not been allowed to mutate or fence anything;
      // do not strand a persistent reservation that no recovery action could
      // safely use.
      if (phase === 'preflight' && !mutation) await this.#releaseLock(context);
      throw error;
    }
  }

  async #acquireLock(context) {
    const lockPath = path.join(this.root, '.deployment-agent.lock');
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await this.fs.mkdir(lockPath, { mode: 0o700 });
      await writeAtomicJson(this.fs, path.join(lockPath, 'owner.json'), {
        operationId: context.operationId,
        generation: context.generation,
        nodeId: this.nodeId
      });
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST')
        throw new NodeReleaseError('deployment agent lock could not be acquired', 'lock_failed');
    }
    let owner;
    try {
      owner = JSON.parse(await this.fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    } catch {
      throw new NodeReleaseError('deployment agent lock owner is unreadable', 'lock_uncertain');
    }
    if (owner.operationId !== context.operationId)
      throw new NodeReleaseError('another deployment operation owns this node', 'lock_held');
  }

  async #acquireInvocationLock(context) {
    const filePath = path.join(this.root, '.deployment-agent.lock', 'invocation.lock');
    let handle;
    try {
      handle = await this.fs.open(filePath, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ operationId: context.operationId, generation: context.generation, pid: process.pid })
      );
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === 'EEXIST') throw new NodeReleaseError('another phase invocation owns this node', 'lock_held');
      throw new NodeReleaseError('deployment invocation lock could not be acquired', 'lock_failed');
    }
  }

  async #releaseInvocationLock() {
    await this.fs.unlink(path.join(this.root, '.deployment-agent.lock', 'invocation.lock')).catch(() => {});
  }

  #assertPhaseOrder(document, phase) {
    const receipts = document.receipts ?? {};
    const has = (...names) => names.some((name) => receipts[name]);
    const invalid = () => {
      throw new NodeReleaseError(`${phase} was requested out of order`, 'phase_order_invalid');
    };
    if (phase === 'stage' && !has('preflight') && document.pendingAction !== 'preflight') invalid();
    if (phase === 'prepare' && !has('stage') && document.pendingAction !== 'stage') invalid();
    if (phase === 'swap' && !has('prepare') && document.pendingAction !== 'prepare') invalid();
    if (phase === 'restart' && !has('swap') && document.pendingAction !== 'swap') invalid();
    if (phase === 'verify' && !has('restart') && document.pendingAction !== 'restart') invalid();
    if (phase === 'canary' && !has('verify') && document.pendingAction !== 'verify') invalid();
    if (phase === 'promote' && !has('canary') && document.pendingAction !== 'canary') invalid();
    if (phase === 'release' && !has('promote') && document.pendingAction !== 'promote') invalid();
    if (
      phase === 'discard-stage' &&
      (!has('stage') || has('prepare', 'swap', 'restart', 'verify', 'canary', 'promote', 'release'))
    )
      invalid();
    if (phase === 'reprepare' && !document.mutationPossible && !has('prepare') && !document.pendingAction) invalid();
    if (
      phase === 'rollback' &&
      !document.mutationPossible &&
      !has('prepare', 'swap', 'restart', 'verify', 'canary', 'promote', 'release') &&
      !document.pendingAction
    )
      invalid();
  }

  async #releaseLock(context) {
    const lockPath = path.join(this.root, '.deployment-agent.lock');
    const owner = await this.#load(path.join(lockPath, 'owner.json'));
    if (owner?.operationId === context.operationId) await this.fs.rm(lockPath, { recursive: true, force: true });
  }

  async #load(filePath) {
    try {
      return JSON.parse(await this.fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new NodeReleaseError('node journal could not be read', 'journal_read_failed');
    }
  }

  #publicBody(body) {
    const value = asObject(body);
    const allowed = [
      'platform',
      'serviceManager',
      'gatewayProtocol',
      'fenceProtocolVersion',
      'atomicLayout',
      'currentIdentity',
      'identity',
      'artifactSha256',
      'manifestSha256',
      'treeSha256',
      'dependencyDigest',
      'runtimeContractDigest',
      'snapshot',
      'backup',
      'fenced',
      'drained',
      'staged',
      'applied',
      'serviceRestarted',
      'healthy',
      'verified',
      'promoted',
      'released',
      'stageDiscarded',
      'restored',
      'gatewayModelId',
      'runtimeId',
      'aliasUsed',
      'cloudFallback',
      'source',
      'privileged'
    ];
    const result = {};
    for (const key of allowed) if (value[key] !== undefined) result[key] = clone(value[key]);
    return result;
  }
}

export const createNodeReleaseAgent = (options) => new NodeReleaseAgent(options);
