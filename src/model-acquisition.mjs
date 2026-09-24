import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchIncludedFiles, modelDirectoryComplete, validModelFilePattern } from './model-files.mjs';

export const MODEL_ACQUISITION_MANIFEST = '.lloom-acquisition.json';

async function pathState(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return { exists: true, stat };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: null, error };
  }
}

function samePathIdentity(left, right) {
  return Boolean(
    left?.exists && right?.exists && left.stat?.dev === right.stat?.dev && left.stat?.ino === right.stat?.ino
  );
}

async function directoryWritableByWrite(directory) {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  let scratch;
  try {
    // mkdtemp owns the generated name. Never unlink a fixed probe path that
    // could have belonged to the model or a concurrent downloader.
    scratch = await fs.mkdtemp(path.join(directory, '.lloom-write-probe-'));
    return true;
  } catch {
    return false;
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// Downloaders write below `<destination>/.cache`. The checkpoint directory may
// already exist with a nested cache the current user cannot write; moving the
// destination aside would then hide the only copy of the checkpoint and the
// download would fail into an unusable work path. Probe the cache directories we
// know about before any rename and fail with a remediation message instead.
async function assertCacheWritable(destination, model) {
  const candidates = [
    destination,
    path.join(destination, '.cache'),
    path.join(destination, '.cache', 'huggingface'),
    path.join(destination, '.cache', 'huggingface', 'download')
  ];
  for (const candidate of candidates) {
    const state = await pathState(candidate);
    if (state.error) {
      throw new Error(
        `cannot inspect ${candidate} for ${model}: ${state.error.message}; the existing model directory or its download cache may not be accessible to the current user. Fix ownership or permissions for that directory (no automatic chmod/chown is performed), or move it aside manually, then retry.`
      );
    }
    if (!state.exists) continue;
    if (await directoryWritableByWrite(candidate)) continue;
    throw new Error(
      `cannot write to ${candidate} for ${model}; the existing model directory or its download cache is not writable by the current user. Fix ownership or permissions for that directory (no automatic chmod/chown is performed), or move it aside manually, then retry.`
    );
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function acquisitionSpec(step = {}) {
  const integrity = asObject(step.integrity);
  return {
    provider: step.provider ?? 'huggingface',
    model: step.model,
    ...(step.revision ? { revision: String(step.revision) } : {}),
    ...(Number.isFinite(Number(step.downloadSizeBytes)) ? { downloadSizeBytes: Number(step.downloadSizeBytes) } : {}),
    // `include` is either absent (download everything) or a list of repository
    // paths/globs. Non-string entries are rejected by validation, so they are
    // dropped here rather than coerced into surprising patterns.
    include: (Array.isArray(step.include) ? step.include : []).filter((entry) => typeof entry === 'string'),
    files: (Array.isArray(integrity.files) ? integrity.files : []).map((file) => ({
      path: String(file.path ?? ''),
      ...(Number.isFinite(Number(file.sizeBytes)) ? { sizeBytes: Number(file.sizeBytes) } : {}),
      ...(file.sha256 ? { sha256: String(file.sha256).toLowerCase() } : {})
    }))
  };
}

function includeEntries(step) {
  if (step.include == null) return [];
  if (!Array.isArray(step.include)) return null;
  return step.include;
}

// A repository-relative path or glob. Absolute paths and parent traversal would
// let a recipe reach outside its own destination directory.
function unsafeRepositoryPath(value) {
  const text = String(value ?? '');
  return !text || path.isAbsolute(text) || text.split(/[\\/]/).includes('..');
}

export function validateAcquisitionStep(step = {}) {
  const errors = [];
  if (step.revision && !/^[a-f0-9]{40,64}$/i.test(String(step.revision))) {
    errors.push('revision must be an immutable 40-64 character hexadecimal commit digest');
  }
  if (
    step.downloadSizeBytes != null &&
    (!Number.isInteger(Number(step.downloadSizeBytes)) || Number(step.downloadSizeBytes) < 0)
  ) {
    errors.push('downloadSizeBytes must be a non-negative integer');
  }
  const include = includeEntries(step);
  if (include == null) {
    errors.push('include must be an array of repository-relative paths or globs');
  } else {
    for (const [index, entry] of include.entries()) {
      if (typeof entry !== 'string') {
        errors.push(`include[${index}] must be a string`);
      } else if (unsafeRepositoryPath(entry)) {
        errors.push(`include[${index}] must be a repository-relative path or glob`);
      } else if (!validModelFilePattern(entry)) {
        errors.push(`include[${index}] contains an invalid glob pattern`);
      }
    }
  }
  for (const [index, file] of acquisitionSpec(step).files.entries()) {
    if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) {
      errors.push(`integrity.files[${index}].path must be a relative path within the model directory`);
    }
    if (file.sizeBytes != null && (!Number.isInteger(file.sizeBytes) || file.sizeBytes < 0)) {
      errors.push(`integrity.files[${index}].sizeBytes must be a non-negative integer`);
    }
    if (file.sha256 && !/^[a-f0-9]{64}$/.test(file.sha256)) {
      errors.push(`integrity.files[${index}].sha256 must be a 64 character hexadecimal digest`);
    }
  }
  return errors;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function readManifest(destination) {
  try {
    return JSON.parse(await fs.readFile(path.join(destination, MODEL_ACQUISITION_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

async function stagePreviousManifest(destination) {
  const manifestPath = path.join(destination, MODEL_ACQUISITION_MANIFEST);
  let raw;
  try {
    raw = await fs.readFile(manifestPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const backupDirectory = await fs.mkdtemp(
    path.join(path.dirname(destination), `.lloom-acquisition-previous-${path.basename(destination)}-`)
  );
  const backupPath = path.join(backupDirectory, MODEL_ACQUISITION_MANIFEST);
  try {
    // Move the marker out while the canonical directory is still in place. If
    // this fails, no rename has happened and the completed destination stays
    // visible with its original provenance.
    await fs.rename(manifestPath, backupPath);
  } catch (error) {
    await fs.rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let manifest = null;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    // Preserve malformed bytes for inspection, but do not reuse them as
    // acquisition metadata during this attempt.
  }
  return { backupDirectory, backupPath, manifest };
}

async function restorePreviousManifest(previous, destination, { expectedIdentity } = {}) {
  if (!previous?.backupPath) return { restored: true };
  const manifestPath = path.join(destination, MODEL_ACQUISITION_MANIFEST);
  const destinationState = await pathState(destination);
  if (destinationState.error) return { restored: false, error: destinationState.error };
  if (expectedIdentity && !samePathIdentity(destinationState, expectedIdentity)) {
    return { restored: false, error: new Error(`${destination} changed while acquisition was being prepared`) };
  }
  const state = await pathState(manifestPath);
  if (state.error) return { restored: false, error: state.error };
  if (state.exists) return { restored: false, error: new Error(`${manifestPath} already exists`) };
  try {
    await fs.rename(previous.backupPath, manifestPath);
    return { restored: true };
  } catch (error) {
    return { restored: false, error };
  }
}

async function cleanupPreviousManifest(previous) {
  if (previous?.backupDirectory) {
    await fs.rm(previous.backupDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function modelAcquisitionStatus(step = {}, { manifestOverride } = {}) {
  const destination = step.destination;
  const spec = acquisitionSpec(step);
  const payloadComplete = Boolean(
    destination &&
    (await modelDirectoryComplete(destination, {
      include: spec.include.length ? spec.include : spec.files.map((file) => file.path)
    }))
  );
  if (!payloadComplete) return { complete: false, payloadComplete: false, verified: false, reason: 'payload-missing' };
  const constrained = Boolean(spec.revision || spec.files.length || spec.include.length);
  if (!constrained) return { complete: true, payloadComplete: true, verified: false, reason: 'payload-present' };
  const manifest = manifestOverride ?? (await readManifest(destination));
  if (spec.revision && manifest?.revision !== spec.revision) {
    return { complete: false, payloadComplete: true, verified: false, reason: 'revision-unverified', manifest };
  }
  const selections = await matchIncludedFiles(destination, spec.include);
  // A recorded superset can satisfy a smaller recipe. Exact requested hashes
  // also prove an already-present selection without downloading it again.
  const recorded = spec.include.every((pattern) => manifest?.include?.includes(pattern));
  const hashCovered =
    selections.length > 0 &&
    selections.every(
      (selection) =>
        selection.matches.length > 0 &&
        selection.matches.every((file) => spec.files.some((expected) => expected.path === file && expected.sha256))
    );
  if (spec.include.length && !recorded && !hashCovered) {
    return { complete: false, payloadComplete: true, verified: false, reason: 'include-unverified', manifest };
  }
  for (const selection of selections) {
    if (!selection.matches.length) {
      return {
        complete: false,
        payloadComplete: true,
        verified: false,
        reason: `missing-include:${selection.pattern}`,
        manifest
      };
    }
  }
  for (const expected of spec.files) {
    const filePath = path.join(destination, expected.path);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch {
      return {
        complete: false,
        payloadComplete: true,
        verified: false,
        reason: `missing-file:${expected.path}`,
        manifest
      };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        complete: false,
        payloadComplete: true,
        verified: false,
        reason: `not-file:${expected.path}`,
        manifest
      };
    }
    if (expected.sizeBytes != null && stat.size !== expected.sizeBytes) {
      return {
        complete: false,
        payloadComplete: true,
        verified: false,
        reason: `size-mismatch:${expected.path}`,
        manifest
      };
    }
    if (expected.sha256 && (await sha256File(filePath)) !== expected.sha256) {
      return {
        complete: false,
        payloadComplete: true,
        verified: false,
        reason: `sha256-mismatch:${expected.path}`,
        manifest
      };
    }
  }
  return { complete: true, payloadComplete: true, verified: true, reason: 'verified', manifest };
}

export async function prepareModelAcquisition(step = {}) {
  const errors = validateAcquisitionStep(step);
  if (errors.length) throw new Error(errors.join('; '));
  const destination = step.destination;
  const incomplete = `${destination}.incomplete`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const destinationState = await pathState(destination);
  const incompleteState = await pathState(incomplete);
  if (destinationState.error) {
    throw new Error(`cannot inspect existing model destination ${destination}: ${destinationState.error.message}`);
  }
  if (incompleteState.error) {
    throw new Error(`cannot inspect partial model destination ${incomplete}: ${incompleteState.error.message}`);
  }
  const destinationExists = destinationState.exists;
  const incompleteExists = incompleteState.exists;
  if (destinationExists && incompleteExists) {
    throw new Error(`both partial model paths exist; reconcile ${destination} and ${incomplete} before retrying`);
  }
  // Probe the destinations' download caches before touching anything. If the
  // existing checkpoint (or a cache under it) is not writable, fail here while
  // the canonical destination is still visible instead of renaming a checkpoint
  // we cannot actually reuse.
  if (destinationExists) await assertCacheWritable(destination, step.model);
  if (incompleteExists) await assertCacheWritable(incomplete, step.model);
  const spec = acquisitionSpec(step);
  if (spec.downloadSizeBytes != null) {
    const stats = await fs.statfs(path.dirname(destination));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserveBytes = Math.max(1024 ** 3, Math.round((freeBytes + spec.downloadSizeBytes) * 0.05));
    if (freeBytes - reserveBytes < spec.downloadSizeBytes) {
      throw new Error(
        `insufficient disk space for ${step.model}: need ${spec.downloadSizeBytes} bytes plus ${reserveBytes} bytes reserve, have ${freeBytes} bytes free`
      );
    }
  }
  const previousManifest = destinationExists ? await stagePreviousManifest(destination) : null;
  const originalDestinationIdentity = destinationState;
  let priorDestinationMoved = false;
  try {
    if (destinationExists) {
      await fs.rename(destination, incomplete);
      priorDestinationMoved = true;
    }
    await fs.mkdir(incomplete, { recursive: true });
  } catch (error) {
    if (priorDestinationMoved) {
      const destinationStateAfterFailure = await pathState(destination);
      const incompleteStateAfterFailure = await pathState(incomplete);
      if (
        !destinationStateAfterFailure.error &&
        !destinationStateAfterFailure.exists &&
        samePathIdentity(incompleteStateAfterFailure, originalDestinationIdentity)
      ) {
        try {
          await fs.rename(incomplete, destination);
        } catch {
          // Keep the staged directory and previous marker backup visible for
          // manual recovery when a concurrent writer won the destination.
        }
      }
    }
    if (previousManifest) {
      const restored = await restorePreviousManifest(previousManifest, destination, {
        expectedIdentity: originalDestinationIdentity
      });
      if (!restored.restored) {
        throw new Error(
          `${error?.message ?? String(error)}; could not restore previous acquisition manifest: ${
            restored.error?.message ?? String(restored.error)
          }; preserved bytes remain at ${previousManifest.backupPath}`,
          { cause: error }
        );
      }
      await cleanupPreviousManifest(previousManifest);
    }
    throw error;
  }
  return { destination, workPath: incomplete, spec, priorDestinationMoved, previousManifest };
}

export async function finalizeModelAcquisition(step, prepared) {
  const workStep = { ...step, destination: prepared.workPath };
  const previous = prepared.previousManifest?.manifest ?? (await readManifest(prepared.workPath));
  const reusable =
    previous?.provider === prepared.spec.provider &&
    previous?.model === prepared.spec.model &&
    previous?.revision === prepared.spec.revision;
  const include = [...new Set([...(reusable ? (previous.include ?? []) : []), ...prepared.spec.include])];
  const manifest = {
    version: 1,
    provider: prepared.spec.provider,
    model: prepared.spec.model,
    ...(prepared.spec.revision ? { revision: prepared.spec.revision } : {}),
    ...(include.length ? { include } : {}),
    files: prepared.spec.files,
    completedAt: new Date().toISOString()
  };
  const status = await modelAcquisitionStatus(workStep, { manifestOverride: manifest });
  if (!status.complete) throw new Error(`download verification failed for ${step.model}: ${status.reason}`);
  // Do not publish acquisition provenance until the payload has passed every
  // requested check. A failed verification must never leave a completion
  // manifest behind when the staged directory is restored.
  await fs.writeFile(
    path.join(prepared.workPath, MODEL_ACQUISITION_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  // A concurrent installer may have published a destination between our rename
  // aside and now. Refuse to clobber it; keep the staged copy for manual review.
  const destinationState = await pathState(prepared.destination);
  if (destinationState.error) {
    throw new Error(
      `could not inspect ${prepared.destination}: ${destinationState.error.message}; refusing to publish while the destination state is unknown`
    );
  }
  if (destinationState.exists) {
    throw new Error(
      `refusing to overwrite ${prepared.destination}: another destination appeared while ${step.model} was downloading; reconcile the staged copy at ${prepared.workPath} before retrying`
    );
  }
  await fs.rename(prepared.workPath, prepared.destination);
  await cleanupPreviousManifest(prepared.previousManifest);
  return { ...status, manifest, destination: prepared.destination };
}

// Restores the checkpoint that prepareModelAcquisition moved aside when a later
// download/verify/finalize step fails. Only restores when the canonical
// destination is absent, so a concurrent writer is never overwritten. A fresh
// failed download (no prior destination) stays staged under `<destination>.incomplete`
// so its partial payload can be resumed.
export async function recoverModelAcquisitionDestination(prepared = {}) {
  if (!prepared?.priorDestinationMoved) return { restored: false };
  const destination = prepared.destination;
  const workPath = prepared.workPath;
  const destinationState = destination ? await pathState(destination) : { exists: false };
  if (destinationState.error) {
    return {
      restored: false,
      recoveryError: `could not inspect ${destination}: ${destinationState.error.message}; the staged checkpoint remains at ${workPath}`
    };
  }
  if (!destinationState.exists) {
    const workState = workPath ? await pathState(workPath) : { exists: false };
    if (workState.error) {
      return {
        restored: false,
        recoveryError: `could not inspect staged checkpoint ${workPath}: ${workState.error.message}; it was left untouched`
      };
    }
    const stagedPresent = workState.exists;
    if (stagedPresent) {
      try {
        await fs.rename(workPath, destination);
        return { restored: true };
      } catch (error) {
        return {
          restored: false,
          recoveryError: `could not restore ${destination}: ${error?.message ?? String(error)}; the staged checkpoint remains at ${workPath}`
        };
      }
    }
  }
  return {
    restored: false,
    recoveryError: destinationState.exists
      ? `could not restore ${destination}: another model directory appeared during download; the previous checkpoint remains staged at ${workPath}`
      : `could not restore ${destination}: the staged checkpoint at ${workPath} is missing`
  };
}
