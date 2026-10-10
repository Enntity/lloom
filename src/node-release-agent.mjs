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
  const dependencyDigest =
    typeof source.dependencyDigest === 'string' && ID.test(source.dependencyDigest)
      ? source.dependencyDigest
      : sha256(Buffer.from(JSON.stringify(source.dependencies ?? {})));
  const runtimeContractDigest =
    typeof source.runtimeContractDigest === 'string' && ID.test(source.runtimeContractDigest)
      ? source.runtimeContractDigest
      : sha256(Buffer.from(JSON.stringify(source.runtimeContract ?? {})));
  return {
    releaseId: String(releaseId),
    artifactSha256,
    manifestSha256,
    configSha256,
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
      return {
        platform: this.platform,
        serviceManager: this.serviceManager,
        gatewayProtocol: context.gatewayProtocol,
        fenceProtocolVersion: NODE_AGENT_PROTOCOL,
        atomicLayout: true,
        currentIdentity: publicIdentity(currentIdentity, 'currentIdentity', { old: true })
      };
    });
  }

  async stage(nodeId, context) {
    return this.#phase(nodeId, context, 'stage', 'stage', true, async () => {
      this.#assertContext(nodeId, context);
      const artifact = this.#artifact(context);
      const reviewedManifest = await this.#readReviewedManifest(artifact);
      publicIdentity(
        currentIdentityFromManifest(
          reviewedManifest,
          artifact.manifestSha256,
          await fileDigest(this.fs, this.configPath)
        ),
        'reviewed identity'
      );
      const token = releaseToken(artifact.id);
      const destination = path.join(this.root, 'releases', token);
      await this.fs.mkdir(destination, { recursive: true, mode: 0o700 });
      const artifactName = path.basename(artifact.path);
      const manifestName = path.basename(artifact.manifestPath);
      await copyAtomic(this.fs, artifact.path, path.join(destination, artifactName));
      await copyAtomic(this.fs, artifact.manifestPath, path.join(destination, manifestName));
      await writeAtomicJson(this.fs, path.join(destination, 'stage.json'), {
        protocol: NODE_AGENT_PROTOCOL,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        manifestSha256: artifact.manifestSha256,
        artifactName,
        manifestName
      });
      return { staged: true, artifactSha256: artifact.sha256, manifestSha256: artifact.manifestSha256 };
    });
  }

  async prepare(nodeId, context) {
    return this.#phase(nodeId, context, 'prepare', 'prepare', true, async (document) => {
      this.#assertContext(nodeId, context);
      const current = await this.#readCurrentIdentity();
      if (!current || !this.#matchesExpected(current, context.expectedOldIdentity))
        throw new NodeReleaseError('current release identity drifted before prepare', 'identity_drift');
      const fence = this.#assertFence(await this.gateway.prepare(context), 'prepare');
      const backup = await this.#backup(context, current);
      // Keep only public-safe evidence and the old symlink target in the node
      // journal. The backup files are addressable from the operation id and
      // never need absolute paths persisted in a receipt.
      document.backup = {
        relativeTarget: backup.relativeTarget,
        configExisted: backup.configExisted,
        evidence: backup.evidence
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
      const currentPath = atomicLayoutPath(this.root, 'current');
      const temporary = `${currentPath}.tmp-${process.pid}-${randomUUID()}`;
      const relative = path.relative(this.root, staged.destination);
      await this.fs.symlink(relative, temporary);
      await this.fs.rename(temporary, currentPath);
      const manifestPath = atomicLayoutPath(this.root, 'current.manifest.json');
      await copyAtomic(this.fs, path.join(staged.destination, staged.manifestName), manifestPath);
      const identity = publicIdentity(await this.#readCurrentIdentity(), 'swap identity');
      if (
        !identity ||
        identity.artifactSha256 !== context.artifact.sha256 ||
        identity.manifestSha256 !== context.artifact.manifestSha256
      )
        throw new NodeReleaseError('atomic swap did not expose the reviewed identity', 'identity_mismatch');
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
        identity.manifestSha256 !== context.artifact.manifestSha256
      )
        throw new NodeReleaseError(
          'loaded gateway identity does not match the reviewed release',
          'loaded_identity_mismatch'
        );
      if (inspection.loadedIdentity === undefined)
        throw new NodeReleaseError('gateway did not report the loaded release identity', 'loaded_identity_unknown');
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
      return { verified: true, identity, snapshot: document.backup?.evidence ?? this.#evidence(context, identity) };
    });
  }

  async canary(nodeId, context) {
    return this.#phase(nodeId, context, 'canary', 'canary', false, async () => {
      this.#assertContext(nodeId, context);
      const result = asObject(await this.gateway.canary(context));
      if (result.privileged !== true || result.fenced !== true)
        throw new NodeReleaseError('canary was not privileged on the fenced gateway', 'canary_not_fenced');
      return {
        healthy: result.healthy === true,
        gatewayModelId: safeId(result.gatewayModelId, 'canary.gatewayModelId'),
        runtimeId: safeId(result.runtimeId, 'canary.runtimeId'),
        fenced: true,
        privileged: true,
        aliasUsed: result.aliasUsed === false,
        cloudFallback: result.cloudFallback === false,
        source: 'local'
      };
    });
  }

  async promote(nodeId, context) {
    return this.#phase(nodeId, context, 'promote', 'promote', true, async (document) => {
      this.#assertContext(nodeId, context);
      const identity = await this.#loadedIdentity(context);
      if (!identity) throw new NodeReleaseError('cannot promote without loaded identity', 'loaded_identity_unknown');
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
      const currentPath = atomicLayoutPath(this.root, 'current');
      const temporary = `${currentPath}.rollback-${process.pid}-${randomUUID()}`;
      await this.fs.symlink(backup.relativeTarget, temporary);
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

  async #readCurrentIdentity() {
    const manifestPath = atomicLayoutPath(this.root, 'current.manifest.json');
    const manifestBytes = await this.fs.readFile(manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      return null;
    }
    const configSha256 = await fileDigest(this.fs, this.configPath);
    return currentIdentityFromManifest(manifest, sha256(manifestBytes), configSha256);
  }

  async #loadedIdentity(context) {
    const inspection = asObject(await this.gateway.inspect(context));
    return inspection.loadedIdentity ? publicIdentity(inspection.loadedIdentity, 'loaded identity') : null;
  }

  async #staged(context) {
    const artifact = this.#artifact(context);
    const destination = path.join(this.root, 'releases', releaseToken(artifact.id));
    const stage = asObject(JSON.parse(await this.fs.readFile(path.join(destination, 'stage.json'), 'utf8')));
    if (
      stage.artifactId !== artifact.id ||
      stage.artifactSha256 !== artifact.sha256 ||
      stage.manifestSha256 !== artifact.manifestSha256 ||
      !SEGMENT.test(stage.artifactName) ||
      !SEGMENT.test(stage.manifestName)
    ) {
      throw new NodeReleaseError(
        'staged release metadata does not match the reviewed artifact',
        'stage_identity_mismatch'
      );
    }
    return { destination, artifactName: stage.artifactName, manifestName: stage.manifestName };
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
    const evidence = {
      id: snapshotId(context.operationId, this.nodeId, 'snapshot'),
      sha256: sha256(Buffer.from(JSON.stringify({ current, target: relativeTarget })))
    };
    return { relativeTarget, manifestPath, configPath, configExisted, evidence };
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
    const result = await this.run('systemctl', ['--user', action, this.serviceUnit], { timeoutMs: 120000 });
    if (result?.code !== 0) throw new NodeReleaseError(`systemd ${action} failed`, 'systemd_failure');
    return String(result.stdout ?? '');
  }

  async #phase(nodeId, context, phase, method, mutation, work) {
    if (!PHASES.has(phase)) throw new NodeReleaseError(`unsupported node phase ${phase}`, 'invalid_context');
    this.#assertContext(nodeId, context);
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
    if (
      document.operationId !== context.operationId ||
      document.nodeId !== this.nodeId ||
      document.planHash !== context.planHash
    )
      throw new NodeReleaseError('node journal identity mismatch', 'journal_identity_mismatch');
    if (document.generation > context.generation)
      throw new NodeReleaseError('node journal generation is newer than the request', 'stale_generation');
    if (document.generation < context.generation) document.generation = context.generation;
    if (document.receipts[phase]) return clone(document.receipts[phase]);
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
      return receipt;
    } catch (error) {
      document.state = 'unknown';
      document.error = publicError(error, phase);
      document.updatedAt = timestamp(this.clock);
      await writeAtomicJson(this.fs, filePath, document).catch(() => {});
      throw error;
    }
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
