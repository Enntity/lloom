import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const FENCE_SCHEMA_VERSION = 1;
const ACTIVE_STATES = new Set(['draining', 'prepared', 'canary']);
const TERMINAL_STATES = new Set(['released']);
const OP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class DeploymentFenceError extends Error {
  constructor(message, { code = 'deployment_fenced', statusCode = 503, retryAfterSeconds = 5, details } = {}) {
    super(message);
    this.name = 'DeploymentFenceError';
    this.code = code;
    this.type = 'deployment_fence_error';
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    if (details !== undefined) this.details = details;
  }
}

function asOpId(value) {
  const opId = String(value ?? '').trim();
  if (!OP_ID_PATTERN.test(opId)) {
    throw new DeploymentFenceError('deployment operation id is required and must be a safe identifier', {
      code: 'deployment_fence_invalid_operation',
      statusCode: 400,
      retryAfterSeconds: 0
    });
  }
  return opId;
}

function asGeneration(value, { required = false } = {}) {
  if ((value == null || value === '') && !required) return null;
  const generation = Number(value);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new DeploymentFenceError('deployment fence generation must be a positive integer', {
      code: 'deployment_fence_invalid_generation',
      statusCode: 400,
      retryAfterSeconds: 0
    });
  }
  return generation;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJsonFileSync(filePath) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validReleaseManifest(manifest) {
  return Boolean(
    manifest &&
    typeof manifest === 'object' &&
    /^[0-9a-f]{40,64}$/i.test(String(manifest.commit ?? '')) &&
    /^[0-9a-f]{64}$/i.test(String(manifest.sha256 ?? '')) &&
    Array.isArray(manifest.files) &&
    manifest.files.length > 0
  );
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === value.replaceAll('\\', '/') && normalized !== '.' && !normalized.startsWith('../');
}

const RELEASE_METADATA_FILES = new Set(['release-manifest.json', 'current.manifest.json', 'stage.json']);

function packageFileInventory(root) {
  const rootStat = fsSync.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('package root is not a real directory');
  const rootReal = fsSync.realpathSync(root);
  const entries = [];

  function walk(directory, relativeDirectory = '') {
    for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = fsSync.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error(`package contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        walk(child, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`package contains a non-regular file: ${relative}`);
      const real = fsSync.realpathSync(child);
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`))
        throw new Error(`package file resolves outside package root: ${relative}`);
      if (relativeDirectory === '' && RELEASE_METADATA_FILES.has(entry.name)) continue;
      const bytes = fsSync.readFileSync(child);
      entries.push({ path: relative, size: stat.size, sha256: sha256(bytes) });
    }
  }

  walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function verifyReleaseManifest(packageRoot, manifest) {
  if (!packageRoot || !validReleaseManifest(manifest)) return { known: false, reason: 'manifest-unverified' };
  const root = path.resolve(packageRoot);
  try {
    const packageJson = JSON.parse(fsSync.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.package && packageJson.name !== manifest.package) return { known: false, reason: 'package-mismatch' };
    if (manifest.version && packageJson.version !== manifest.version)
      return { known: false, reason: 'version-mismatch' };
    const expected = [];
    const expectedPaths = new Set();
    for (const entry of manifest.files) {
      if (!entry || !safeManifestPath(entry.path)) return { known: false, reason: 'manifest-path-invalid' };
      if (RELEASE_METADATA_FILES.has(entry.path) || expectedPaths.has(entry.path))
        return { known: false, reason: 'manifest-file-inventory-invalid' };
      if (!/^[0-9a-f]{64}$/i.test(String(entry.sha256 ?? '')))
        return { known: false, reason: 'manifest-file-digest-invalid' };
      expectedPaths.add(entry.path);
      expected.push({
        path: entry.path,
        ...(entry.size == null ? {} : { size: Number(entry.size) }),
        sha256: String(entry.sha256).toLowerCase()
      });
    }
    if (expected.some((entry) => entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)))
      return { known: false, reason: 'manifest-file-size-invalid' };
    const actual = packageFileInventory(root);
    const normalizedExpected = expected
      .map(({ path: file, sha256: digest, size }) => ({
        path: file,
        ...(size === undefined ? {} : { size }),
        sha256: digest
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (
      actual.length !== normalizedExpected.length ||
      normalizedExpected.some(
        (entry, index) =>
          actual[index]?.path !== entry.path ||
          actual[index]?.sha256 !== entry.sha256 ||
          (entry.size !== undefined && actual[index]?.size !== entry.size)
      )
    )
      return { known: false, reason: 'installed-file-inventory-mismatch' };
    return { known: true, verifiedFiles: actual.length };
  } catch {
    return { known: false, reason: 'installed-package-unreadable' };
  }
}

/**
 * Read release identity only from bytes that were actually loaded from a
 * release manifest. package.json, a directory name, and an unverified pointer
 * are deliberately insufficient to claim a release identity.
 */
export function readReleaseIdentity({ packageRoot, releaseManifestPath } = {}) {
  const candidates = [
    releaseManifestPath,
    packageRoot ? path.join(packageRoot, 'release-manifest.json') : null,
    packageRoot ? path.join(packageRoot, 'current.manifest.json') : null
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const bytes = fsSync.readFileSync(candidate);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!validReleaseManifest(manifest)) continue;
      const verification = verifyReleaseManifest(packageRoot, manifest);
      if (!verification.known) continue;
      return {
        known: true,
        source: path.basename(candidate),
        commit: String(manifest.commit),
        releaseDigest: String(manifest.sha256),
        version: manifest.version ?? null,
        manifestBytesDigest: sha256(bytes),
        dependencyDigest: /^[0-9a-f]{64}$/i.test(String(manifest.dependencyDigest ?? ''))
          ? String(manifest.dependencyDigest).toLowerCase()
          : null,
        runtimeContractDigest: /^[0-9a-f]{64}$/i.test(String(manifest.runtimeContractDigest ?? ''))
          ? String(manifest.runtimeContractDigest).toLowerCase()
          : null,
        verifiedFiles: verification.verifiedFiles,
        verification: 'installed-files'
      };
    } catch {
      // A missing, unreadable, or malformed optional manifest leaves identity
      // unknown. The deployer must refuse an unknown identity.
    }
  }
  return {
    known: false,
    source: null,
    commit: null,
    releaseDigest: null,
    version: null,
    manifestBytesDigest: null,
    dependencyDigest: null,
    runtimeContractDigest: null,
    verifiedFiles: 0,
    verification: null,
    reason: 'manifest-unverified'
  };
}

function configFileDigest(configPath) {
  if (!configPath) return null;
  try {
    return sha256(fsSync.readFileSync(configPath));
  } catch {
    return null;
  }
}

function completeReleaseIdentity(release, configSha256) {
  if (
    !release?.known ||
    !release.commit ||
    !/^[0-9a-f]{64}$/i.test(String(release.releaseDigest ?? '')) ||
    !/^[0-9a-f]{64}$/i.test(String(release.manifestBytesDigest ?? '')) ||
    !/^[0-9a-f]{64}$/i.test(String(configSha256 ?? '')) ||
    !/^[0-9a-f]{64}$/i.test(String(release.dependencyDigest ?? '')) ||
    !/^[0-9a-f]{64}$/i.test(String(release.runtimeContractDigest ?? ''))
  )
    return null;
  return {
    releaseId: String(release.commit),
    artifactSha256: String(release.releaseDigest).toLowerCase(),
    manifestSha256: String(release.manifestBytesDigest).toLowerCase(),
    configSha256: String(configSha256).toLowerCase(),
    dependencyDigest: String(release.dependencyDigest).toLowerCase(),
    runtimeContractDigest: String(release.runtimeContractDigest).toLowerCase()
  };
}

export function atomicLayoutProof(packageRoot) {
  if (!packageRoot) return false;
  try {
    const packagePath = path.resolve(packageRoot);
    const packageStat = fsSync.lstatSync(packagePath);
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) return false;
    if (path.basename(path.dirname(packagePath)) !== 'releases') return false;
    const deploymentRoot = path.dirname(path.dirname(packagePath));
    const currentPath = path.join(deploymentRoot, 'current');
    const currentStat = fsSync.lstatSync(currentPath);
    if (!currentStat.isSymbolicLink()) return false;
    if (fsSync.realpathSync(currentPath) !== fsSync.realpathSync(packagePath)) return false;
    return fsSync.lstatSync(path.join(deploymentRoot, 'current.manifest.json')).isFile();
  } catch {
    return false;
  }
}

export function createProcessIdentity({ config = {}, configPath, packageRoot, releaseManifestPath } = {}) {
  const release = readReleaseIdentity({ packageRoot, releaseManifestPath });
  const configSha256 = configFileDigest(configPath);
  return {
    bootId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nodeId: config.cluster?.nodeId ?? null,
    hostname: os.hostname(),
    release: { ...release, configSha256 },
    releaseIdentity: completeReleaseIdentity(release, configSha256),
    atomicLayout: atomicLayoutProof(packageRoot)
  };
}

export function isDeploymentFencePath(pathname) {
  return /^\/gateway\/deployment-fence(?:\/|$)/.test(String(pathname ?? ''));
}

function activeState(state) {
  return ACTIVE_STATES.has(state);
}

function fenceRecordShape(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.schemaVersion !== FENCE_SCHEMA_VERSION) return null;
  if (!activeState(record.state) && !TERMINAL_STATES.has(record.state)) return null;
  if (!OP_ID_PATTERN.test(String(record.opId ?? ''))) return null;
  if (!Number.isInteger(record.generation) || record.generation < 1) return null;
  return record;
}

async function writeAtomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    handle = await fs.open(temporary, 'r');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    try {
      const directoryHandle = await fs.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is unavailable on a few supported filesystems. The
      // file itself was fsynced and atomically renamed, so keep the receipt.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function configDigest(config) {
  try {
    return sha256(Buffer.from(JSON.stringify(config ?? {})));
  } catch {
    return null;
  }
}

/**
 * A process-local deployment fence. A supervisor may coordinate several
 * instances, but each gateway owns one independent sidecar and one operation
 * id. The controller intentionally does not implement distributed locking.
 */
export function createDeploymentFence({
  config = {},
  configPath = null,
  runtimeManager = null,
  packageRoot = null,
  releaseManifestPath = null,
  drainTimeoutMs = 300000
} = {}) {
  const fencePath = configPath ? `${path.resolve(configPath)}.deployment-fence.json` : null;
  const identity = createProcessIdentity({ config, configPath, packageRoot, releaseManifestPath });
  let persistenceError = null;
  let loaded = null;
  try {
    loaded = fencePath ? readJsonFileSync(fencePath) : null;
  } catch (error) {
    persistenceError = error;
  }
  let lastRecord = loaded;
  if (!persistenceError && fencePath && loaded && !fenceRecordShape(loaded)) {
    persistenceError = new Error('deployment fence sidecar is malformed or has an unsupported schema');
  }
  let record = fenceRecordShape(loaded) && activeState(loaded.state) ? { ...loaded } : null;
  let state = persistenceError ? 'blocked' : (record?.state ?? 'open');
  let lastError = persistenceError?.message ?? null;
  let fenceEpoch = record ? 1 : 0;
  let activeHandlerId = 0;
  const activeHandlers = new Map();
  let canaryInFlight = 0;
  let hooks = {};
  let operationQueue = Promise.resolve();
  let preparePromise = null;
  let preparingOpId = null;
  let recoveryPromise = null;

  function isFenced() {
    return state !== 'open';
  }

  function status(extra = {}) {
    const operationRecord = record ?? (lastRecord?.state === 'released' ? lastRecord : null);
    return {
      protocol: FENCE_SCHEMA_VERSION,
      fenceProtocolVersion: FENCE_SCHEMA_VERSION,
      ok: !persistenceError,
      state,
      fenced: isFenced(),
      drained: state === 'prepared' || state === 'canary',
      persistent: Boolean(fencePath),
      generation: operationRecord?.generation ?? lastRecord?.generation ?? 0,
      operation: operationRecord
        ? {
            opId: operationRecord.opId,
            generation: operationRecord.generation,
            state: operationRecord.state,
            preparedAt: operationRecord.preparedAt ?? null,
            createdAt: operationRecord.createdAt ?? null,
            releasedAt: operationRecord.releasedAt ?? null,
            ownerBootId: operationRecord.owner?.bootId ?? null,
            releaseDigest: operationRecord.release?.releaseDigest ?? null,
            commit: operationRecord.release?.commit ?? null,
            error: operationRecord.error ?? null
          }
        : null,
      identity: {
        bootId: identity.bootId,
        pid: identity.pid,
        nodeId: identity.nodeId,
        hostname: identity.hostname,
        startedAt: identity.startedAt,
        release: identity.release,
        releaseIdentity: identity.releaseIdentity,
        atomicLayout: identity.atomicLayout
      },
      releaseIdentity: identity.releaseIdentity,
      activeHandlers: activeHandlers.size,
      canaryInFlight,
      persistenceError: persistenceError?.message ?? null,
      lastError,
      ...extra
    };
  }

  function currentError(operation = 'gateway operation') {
    if (persistenceError) {
      return new DeploymentFenceError(`deployment fence is unavailable: ${persistenceError.message}`, {
        code: 'deployment_fence_unavailable',
        statusCode: 503,
        details: { operation }
      });
    }
    return new DeploymentFenceError(`${operation} is blocked by deployment fence`, {
      details: { operation, opId: record?.opId ?? null, generation: record?.generation ?? null }
    });
  }

  function mutationTokenValid(token) {
    return Boolean(
      token &&
      token.type === 'deployment-mutation' &&
      token.bootId === identity.bootId &&
      token.epoch === fenceEpoch - 1 &&
      token.capturedBeforeFence === true
    );
  }

  function captureMutation({ operation = 'runtime mutation', token = null } = {}) {
    if (!isFenced() && !persistenceError) {
      return (
        token ?? {
          type: 'deployment-mutation',
          bootId: identity.bootId,
          epoch: fenceEpoch,
          capturedBeforeFence: true,
          operation
        }
      );
    }
    if (mutationTokenValid(token)) return token;
    throw currentError(operation);
  }

  function assertMutationAllowed({ operation = 'runtime mutation', token = null } = {}) {
    captureMutation({ operation, token });
    return true;
  }

  function managerMutationAllowed({ operation = 'runtime mutation', token = null } = {}) {
    return assertMutationAllowed({ operation, token });
  }

  function requestAdmission({ routeKind, method, pathname, canary = false } = {}) {
    const mutating =
      (routeKind === 'inference' && String(method ?? 'GET').toUpperCase() === 'POST') || routeKind === 'admin-write';
    if (!mutating || isDeploymentFencePath(pathname) || canary) return { release() {} };
    const mutationToken = captureMutation({ operation: 'request admission' });
    const id = ++activeHandlerId;
    let released = false;
    activeHandlers.set(id, { id, routeKind, method, pathname, admittedAt: new Date().toISOString() });
    return {
      id,
      mutationToken,
      release() {
        if (released) return;
        released = true;
        activeHandlers.delete(id);
      }
    };
  }

  function canaryContextValid(context) {
    return Boolean(
      context &&
      record &&
      state === 'canary' &&
      context.opId === record.opId &&
      context.generation === record.generation &&
      context.token &&
      context.token === record.canaryToken
    );
  }

  function pause() {
    hooks.pauseResidency?.();
    hooks.pauseWatchdog?.();
  }

  function resume() {
    hooks.resumeWatchdog?.();
    hooks.resumeResidency?.();
  }

  async function persist(next) {
    if (!fencePath) {
      throw new DeploymentFenceError('deployment fence requires a config path for its atomic sidecar', {
        code: 'deployment_fence_persistence_unavailable',
        statusCode: 503
      });
    }
    await writeAtomicJson(fencePath, next);
    lastRecord = next;
    record = activeState(next.state) ? { ...next } : null;
    state = next.state;
  }

  async function waitForDrain(timeoutMs) {
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || drainTimeoutMs);
    const remaining = () => Math.max(1, deadline - Date.now());
    if (typeof hooks.waitForReload === 'function') {
      const wait = Promise.resolve().then(() => hooks.waitForReload({ timeoutMs: remaining() }));
      let timer;
      try {
        await Promise.race([
          wait,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('timed out waiting for gateway configuration reload to settle');
              error.code = 'DEPLOYMENT_FENCE_RELOAD_TIMEOUT';
              reject(error);
            }, remaining());
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (runtimeManager?.waitForQuiescence) {
      await runtimeManager.waitForQuiescence({
        timeoutMs: remaining(),
        getActiveHandlers: () => activeHandlers.size
      });
      return;
    }
    while (activeHandlers.size > 0) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for gateway handlers to drain');
      await delay(Math.min(25, remaining()));
    }
  }

  function resumePersistedDrain(timeoutMs = drainTimeoutMs) {
    if (!record || !activeState(record.state) || record.state === 'prepared' || recoveryPromise) return recoveryPromise;
    const opId = record.opId;
    const generation = record.generation;
    recoveryPromise = enqueue(async () => {
      if (!record || record.opId !== opId || record.generation !== generation || record.state === 'prepared')
        return status();
      const resumed = { ...record, state: 'draining', error: null };
      // A canary in flight cannot survive a process restart. Its token is
      // invalidated before the restored process drains again.
      delete resumed.canaryToken;
      resumed.recoveryStartedAt = new Date().toISOString();
      try {
        await persist(resumed);
      } catch (error) {
        persistenceError = error;
        state = 'blocked';
        lastError = error?.message ?? String(error);
        throw error;
      }
      pause();
      try {
        await waitForDrain(timeoutMs);
        await persist({
          ...resumed,
          state: 'prepared',
          preparedAt: new Date().toISOString(),
          recoveryCompletedAt: new Date().toISOString()
        });
        lastError = null;
        return status();
      } catch (error) {
        lastError = error?.message ?? String(error);
        try {
          await persist({ ...resumed, state: 'draining', error: lastError });
        } catch (persistError) {
          persistenceError = persistError;
          state = 'blocked';
          lastError = persistError?.message ?? String(persistError);
        }
        throw error;
      }
    }).finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  }

  function enqueue(operation) {
    const run = operationQueue.catch(() => {}).then(operation);
    operationQueue = run.catch(() => {});
    return run;
  }

  async function prepare({ opId: requestedOpId, timeoutMs = drainTimeoutMs } = {}) {
    const opId = asOpId(requestedOpId);
    if (record && record.opId === opId && activeState(record.state)) {
      if (record.state === 'prepared') return status();
      if (preparePromise) return preparePromise;
      if (recoveryPromise) return recoveryPromise;
      return resumePersistedDrain(timeoutMs);
    }
    if (preparePromise && preparingOpId !== opId) {
      throw new DeploymentFenceError('another deployment prepare is already in progress', {
        code: 'deployment_fence_prepare_in_progress',
        statusCode: 409,
        retryAfterSeconds: 0,
        details: { activeOpId: preparingOpId, requestedOpId: opId }
      });
    }
    if (isFenced()) throw currentError('prepare');
    if (preparePromise) return preparePromise;
    if (!fencePath) {
      throw new DeploymentFenceError('deployment prepare requires a persistent config-adjacent sidecar', {
        code: 'deployment_fence_persistence_unavailable',
        statusCode: 503
      });
    }
    const generation = Math.max(0, Number(lastRecord?.generation ?? 0)) + 1;
    const now = new Date().toISOString();
    const next = {
      schemaVersion: FENCE_SCHEMA_VERSION,
      state: 'draining',
      opId,
      generation,
      createdAt: now,
      owner: {
        bootId: identity.bootId,
        pid: identity.pid,
        nodeId: identity.nodeId
      },
      release: {
        known: identity.release.known,
        commit: identity.release.commit,
        releaseDigest: identity.release.releaseDigest,
        manifestBytesDigest: identity.release.manifestBytesDigest
      },
      configDigest: configDigest(config)
    };
    // Close in-memory admission synchronously, before enqueueing any async
    // persistence work. Already admitted work retains the previous epoch
    // token and can finish; new work is rejected immediately.
    fenceEpoch += 1;
    lastRecord = next;
    record = { ...next };
    state = 'draining';
    preparingOpId = opId;
    preparePromise = enqueue(async () => {
      try {
        await persist(next);
      } catch (error) {
        persistenceError = error;
        state = 'blocked';
        lastError = error?.message ?? String(error);
        throw error;
      }
      pause();
      try {
        await waitForDrain(timeoutMs);
        const prepared = {
          ...next,
          state: 'prepared',
          preparedAt: new Date().toISOString()
        };
        await persist(prepared);
        lastError = null;
        return status();
      } catch (error) {
        lastError = error?.message ?? String(error);
        try {
          await persist({ ...next, state: 'draining', error: lastError });
        } catch (persistError) {
          persistenceError = persistError;
          state = 'blocked';
        }
        throw error;
      }
    }).finally(() => {
      preparePromise = null;
      preparingOpId = null;
    });
    return preparePromise;
  }

  async function release({ opId: requestedOpId, generation: requestedGeneration } = {}) {
    const opId = asOpId(requestedOpId);
    const generation = asGeneration(requestedGeneration, { required: true });
    return enqueue(async () => {
      if (!record || !activeState(record.state)) {
        if (lastRecord?.state === 'released' && lastRecord.opId === opId && lastRecord.generation === generation) {
          return status({
            released: true,
            idempotent: true,
            terminalReceipt: {
              opId: lastRecord.opId,
              generation: lastRecord.generation,
              releasedAt: lastRecord.releasedAt ?? null,
              ownerBootId: lastRecord.owner?.bootId ?? null
            }
          });
        }
        throw new DeploymentFenceError('no active deployment fence exists', {
          code: 'deployment_fence_not_active',
          statusCode: 409,
          retryAfterSeconds: 0,
          details:
            lastRecord?.state === 'released'
              ? {
                  lastOpId: lastRecord.opId,
                  lastGeneration: lastRecord.generation,
                  releasedAt: lastRecord.releasedAt ?? null
                }
              : undefined
        });
      }
      if (record.opId !== opId) {
        throw new DeploymentFenceError('deployment operation id does not match the active fence', {
          code: 'deployment_fence_operation_mismatch',
          statusCode: 409,
          retryAfterSeconds: 0,
          details: { activeOpId: record.opId, requestedOpId: opId }
        });
      }
      if (record.generation !== generation) {
        throw new DeploymentFenceError('deployment fence generation does not match the active fence', {
          code: 'deployment_fence_generation_mismatch',
          statusCode: 409,
          retryAfterSeconds: 0,
          details: { activeGeneration: record.generation, requestedGeneration: generation }
        });
      }
      if (record.state !== 'prepared') {
        throw new DeploymentFenceError(`deployment fence is ${record.state}; release requires prepared state`, {
          code: 'deployment_fence_not_prepared',
          statusCode: 409,
          retryAfterSeconds: 0
        });
      }
      if (activeHandlers.size || canaryInFlight) {
        throw new DeploymentFenceError('deployment fence still has active handlers', {
          code: 'deployment_fence_busy',
          statusCode: 409,
          retryAfterSeconds: 0
        });
      }
      const released = {
        ...record,
        state: 'released',
        releasedAt: new Date().toISOString(),
        error: null
      };
      // Write the terminal state before opening admission. A crash in this
      // window remains fenced rather than exposing a half-released gateway.
      try {
        await persist(released);
      } catch (error) {
        persistenceError = error;
        state = 'blocked';
        lastError = error?.message ?? String(error);
        throw error;
      }
      state = 'open';
      record = null;
      persistenceError = null;
      lastError = null;
      resume();
      return status({ released: true });
    });
  }

  async function runCanary({ opId: requestedOpId, generation: requestedGeneration, run } = {}) {
    const opId = asOpId(requestedOpId);
    const generation = asGeneration(requestedGeneration, { required: true });
    if (typeof run !== 'function') throw new TypeError('deployment canary runner is required');
    return enqueue(async () => {
      if (!record || record.opId !== opId || record.state !== 'prepared') {
        throw new DeploymentFenceError('deployment canary requires the matching prepared fence', {
          code: 'deployment_fence_canary_not_ready',
          statusCode: 409,
          retryAfterSeconds: 0
        });
      }
      if (record.generation !== generation) {
        throw new DeploymentFenceError('deployment fence generation does not match the active fence', {
          code: 'deployment_fence_generation_mismatch',
          statusCode: 409,
          retryAfterSeconds: 0,
          details: { activeGeneration: record.generation, requestedGeneration: generation }
        });
      }
      const canaryToken = randomUUID();
      const canaryRecord = { ...record, state: 'canary', canaryToken, canaryStartedAt: new Date().toISOString() };
      try {
        await persist(canaryRecord);
      } catch (error) {
        persistenceError = error;
        state = 'blocked';
        lastError = error?.message ?? String(error);
        throw error;
      }
      canaryInFlight += 1;
      try {
        const result = await run({
          opId,
          generation: canaryRecord.generation,
          token: canaryToken
        });
        const resultStatus = Number(result?.status ?? result?.statusCode ?? 0);
        const resultOk =
          typeof result?.ok === 'boolean' ? result.ok : resultStatus ? resultStatus >= 200 && resultStatus < 400 : true;
        if (!resultOk || (resultStatus && (resultStatus < 200 || resultStatus >= 400))) {
          throw new DeploymentFenceError('deployment canary returned an unsuccessful response', {
            code: 'deployment_fence_canary_failed',
            statusCode: 502,
            retryAfterSeconds: 0,
            details: { status: resultStatus || null, result: result ?? null }
          });
        }
        const prepared = {
          ...canaryRecord,
          state: 'prepared',
          canaryToken: null,
          canaryFinishedAt: new Date().toISOString(),
          canaryResult: { ok: true, ...(resultStatus ? { status: resultStatus } : {}) }
        };
        delete prepared.canaryToken;
        await persist(prepared);
        return result;
      } catch (error) {
        lastError = error?.message ?? String(error);
        try {
          const prepared = {
            ...canaryRecord,
            state: 'prepared',
            canaryToken: null,
            canaryFinishedAt: new Date().toISOString(),
            canaryResult: { ok: false, error: lastError },
            error: lastError
          };
          delete prepared.canaryToken;
          await persist(prepared);
        } catch (persistError) {
          persistenceError = persistError;
          state = 'blocked';
          lastError = persistError?.message ?? String(persistError);
        }
        throw error;
      } finally {
        canaryInFlight = Math.max(0, canaryInFlight - 1);
      }
    });
  }

  function setHooks(nextHooks = {}) {
    hooks = { ...hooks, ...nextHooks };
    if (isFenced()) {
      pause();
      void resumePersistedDrain(drainTimeoutMs)?.catch((error) => {
        hooks.logger?.warn?.(`restored deployment fence drain failed: ${error?.message ?? error}`);
      });
    }
    return status();
  }

  return {
    identity,
    fencePath,
    status,
    isFenced,
    isCanaryAuthorized: canaryContextValid,
    requestAdmission,
    captureMutation,
    assertMutationAllowed,
    managerMutationAllowed,
    prepare,
    release,
    runCanary,
    setHooks,
    get activeHandlerCount() {
      return activeHandlers.size;
    }
  };
}
