#!/usr/bin/env node
// MIT. LLooM-side fail-closed pin gate for the Atlas SparkGLM lane.
//
// The single pin manifest is backends/atlas-sparkglm/pins.json. This checker
// exits non-zero while any required identity is still a DRAFT placeholder, so
// a DRAFT manifest can never satisfy a setup step, a build, or a start.
//
// Pins split in two:
//   * portable pins (source revision, model revision, conversion marker)
//     are the same on every host, so they live in the manifest;
//   * the image ID is deliberately NOT pinned globally. Source builds of the
//     parent installer can produce different image IDs on different machines,
//     so each host keeps only a local receipt (image-<revision>.json) whose ID
//     must equal this host's `docker image inspect` output. Local image
//     identity is verified by install.sh, never by this manifest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pins.json');

export const REQUIRED_PINS = [
  ['status', (m) => m.status],
  ['source.revision', (m) => m.source?.revision],
  ['image.tag', (m) => m.image?.tag],
  ['model.repo', (m) => m.model?.repo],
  ['model.revision', (m) => m.model?.revision]
];

export const REQUIRED_IMAGE_ARCHITECTURE = 'arm64';

export function loadPins(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function draftPins(manifest) {
  const drafts = [];
  for (const [name, select] of REQUIRED_PINS) {
    const value = select(manifest);
    if (typeof value !== 'string' || value.length === 0) {
      drafts.push({ name, value, reason: 'missing' });
      continue;
    }
    if (/draft/i.test(value)) {
      drafts.push({ name, value, reason: 'draft-placeholder' });
    }
  }
  if (String(manifest.status).toLowerCase() !== 'final') {
    drafts.push({ name: 'status', value: manifest.status, reason: 'not-final' });
  }
  return drafts;
}

export function verifyPins(manifest) {
  const failures = draftPins(manifest).map(
    (draft) => `${draft.name} is not a final pin (${draft.reason}: ${draft.value})`
  );
  const revision = manifest.source?.revision;
  if (typeof revision === 'string' && !/^[a-fA-F0-9]{40}$/.test(revision)) {
    failures.push(`source.revision must be a 40-character commit, got ${revision}`);
  }
  // The local image tag is derived from portable revision plus a stable local
  // tag prefix; it never carries a host-specific identity.
  if (typeof manifest.image?.tag === 'string' && manifest.image.tag !== imageTagFor(manifest)) {
    failures.push(`image.tag must be ${imageTagFor(manifest)}, got ${manifest.image.tag}`);
  }
  if (manifest.image?.architecture !== REQUIRED_IMAGE_ARCHITECTURE) {
    failures.push(`image.architecture must be ${REQUIRED_IMAGE_ARCHITECTURE}, got ${manifest.image?.architecture}`);
  }
  if (Object.hasOwn(manifest.image ?? {}, 'id')) {
    failures.push(
      'image.id must not be pinned globally: source builds do not guarantee identical image IDs across hosts; verify identity per host against the local receipt'
    );
  }
  if (manifest.model?.revision !== '423acf37583782c51c142d145aef733d72943d93') {
    failures.push('model.revision must stay on the pinned GLM-5.3-Flash-NVFP4 revision');
  }
  if (manifest.overlay?.marker !== 'conversion.complete.json') {
    failures.push(`overlay.marker must be conversion.complete.json, got ${manifest.overlay?.marker}`);
  }
  if (Number(manifest.converter?.expectedMatrices) !== 864) {
    failures.push(`converter.expectedMatrices must be 864, got ${manifest.converter?.expectedMatrices}`);
  }
  return failures;
}

export function imageTagFor(manifest) {
  return `${manifest.image?.tagPrefix ?? 'lloom/atlas-sparkglm:'}${manifest.source?.revision}`;
}

// A host receipt is written by the parent build script
// (research/atlas/install/build.sh) as image-<SOURCE_REVISION>.json.
export function receiptPathFor(installRoot, revision) {
  return path.join(installRoot, `image-${revision}.json`);
}

export function receiptFailures(receipt, { tag, revision, imageId, architecture }) {
  const failures = [];
  const value = (key) => receipt?.[key];
  if (value('image') !== tag) failures.push(`receipt image ${value('image')} != local tag ${tag}`);
  if (value('source_revision') !== revision) {
    failures.push(`receipt source_revision ${value('source_revision')} != pinned ${revision}`);
  }
  if (!/^sha256:[a-fA-F0-9]{64}$/.test(String(value('image_id') ?? ''))) {
    failures.push(`receipt image_id ${value('image_id')} is not a complete sha256: identity`);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(String(value('manifest_sha256') ?? ''))) {
    failures.push(`receipt manifest_sha256 ${value('manifest_sha256')} is not a sha256 digest`);
  }
  if (imageId && value('image_id') !== imageId) {
    failures.push(`receipt image_id ${value('image_id')} != local image inspect ${imageId}`);
  }
  if (architecture && architecture !== REQUIRED_IMAGE_ARCHITECTURE) {
    failures.push(`local image architecture ${architecture} must be ${REQUIRED_IMAGE_ARCHITECTURE}`);
  }
  return failures;
}

function main() {
  const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : MANIFEST_PATH;
  let manifest;
  try {
    manifest = loadPins(manifestPath);
  } catch (error) {
    process.stderr.write(`atlas-sparkglm pins unreadable at ${manifestPath}: ${error.message}\n`);
    process.exit(2);
  }
  const failures = verifyPins(manifest);
  if (failures.length > 0) {
    process.stderr.write('atlas-sparkglm pins are not installable:\n');
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`atlas-sparkglm pins verified (${imageTagFor(manifest)})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
