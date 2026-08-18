import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDirectoryComplete } from './model-files.mjs';

export const MODEL_ACQUISITION_MANIFEST = '.lloom-acquisition.json';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
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
    files: (Array.isArray(integrity.files) ? integrity.files : []).map((file) => ({
      path: String(file.path ?? ''),
      ...(Number.isFinite(Number(file.sizeBytes)) ? { sizeBytes: Number(file.sizeBytes) } : {}),
      ...(file.sha256 ? { sha256: String(file.sha256).toLowerCase() } : {})
    }))
  };
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

export async function modelAcquisitionStatus(step = {}) {
  const destination = step.destination;
  const spec = acquisitionSpec(step);
  const payloadComplete = Boolean(destination && (await modelDirectoryComplete(destination)));
  if (!payloadComplete) return { complete: false, payloadComplete: false, verified: false, reason: 'payload-missing' };
  const constrained = Boolean(spec.revision || spec.files.length);
  if (!constrained) return { complete: true, payloadComplete: true, verified: false, reason: 'payload-present' };
  const manifest = await readManifest(destination);
  if (spec.revision && manifest?.revision !== spec.revision) {
    return { complete: false, payloadComplete: true, verified: false, reason: 'revision-unverified', manifest };
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
  const destination = step.destination;
  const incomplete = `${destination}.incomplete`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const destinationExists = await pathExists(destination);
  const incompleteExists = await pathExists(incomplete);
  if (destinationExists && incompleteExists) {
    throw new Error(`both partial model paths exist; reconcile ${destination} and ${incomplete} before retrying`);
  }
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
  if (destinationExists) await fs.rename(destination, incomplete);
  await fs.mkdir(incomplete, { recursive: true });
  return { destination, workPath: incomplete, spec };
}

export async function finalizeModelAcquisition(step, prepared) {
  const workStep = { ...step, destination: prepared.workPath };
  const manifest = {
    version: 1,
    provider: prepared.spec.provider,
    model: prepared.spec.model,
    ...(prepared.spec.revision ? { revision: prepared.spec.revision } : {}),
    files: prepared.spec.files,
    completedAt: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(prepared.workPath, MODEL_ACQUISITION_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const status = await modelAcquisitionStatus(workStep);
  if (!status.complete) throw new Error(`download verification failed for ${step.model}: ${status.reason}`);
  await fs.rename(prepared.workPath, prepared.destination);
  return { ...status, manifest, destination: prepared.destination };
}
