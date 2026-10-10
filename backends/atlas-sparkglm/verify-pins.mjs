#!/usr/bin/env node
// MIT. LLooM-side fail-closed pin gate for the Atlas SparkGLM lane.
//
// The single pin manifest is backends/atlas-sparkglm/pins.json. This checker
// exits non-zero while any required identity is still a DRAFT placeholder, so
// a DRAFT manifest can never satisfy a setup step, a build, or a start.
//
// Every pin is portable. The normal install path addresses the image by its
// immutable registry digest: ghcr.io/enntity/atlas-sparkglm@sha256:.... The
// tag (the first 12 characters of the install/ git tree) is retained only as
// source-build metadata and as the local tag produced by an explicit
// --source-build. A tag alone is NOT an immutable artifact identity, and the
// image's io.enntity.sparkglm.install-tree label is a contents check, not an
// artifact identity. Image IDs are deliberately NOT pinned: install.sh
// verifies the local image by its install-tree label and architecture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pins.json');

export const REQUIRED_PINS = [
  ['status', (m) => m.status],
  ['source.revision', (m) => m.source?.revision],
  ['source.installTree', (m) => m.source?.installTree],
  ['image.reference', (m) => m.image?.reference],
  ['image.tag', (m) => m.image?.tag],
  ['model.repo', (m) => m.model?.repo],
  ['model.revision', (m) => m.model?.revision]
];

export const REQUIRED_IMAGE_ARCHITECTURE = 'arm64';
export const IMAGE_REPOSITORY = 'ghcr.io/enntity/atlas-sparkglm';
export const IMAGE_LABEL = 'io.enntity.sparkglm.install-tree';
export const IMAGE_REFERENCE_PATTERN = /^ghcr\.io\/enntity\/atlas-sparkglm@sha256:[a-f0-9]{64}$/;

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
  for (const [name, value] of [
    ['source.revision', manifest.source?.revision],
    ['source.installTree', manifest.source?.installTree]
  ]) {
    if (typeof value === 'string' && !/^[a-fA-F0-9]{40}$/.test(value)) {
      failures.push(`${name} must be a 40-character git object id, got ${value}`);
    }
  }
  // The tag is the first 12 characters of the install tree, as printed by the
  // pinned source's install/build.sh.
  if (typeof manifest.image?.tag === 'string' && manifest.image.tag !== imageTagFor(manifest)) {
    failures.push(`image.tag must be ${imageTagFor(manifest)}, got ${manifest.image.tag}`);
  }
  // The normal install path must address the immutable registry digest. The
  // tag is source-build metadata and a tag alone is never the artifact
  // identity.
  const reference = manifest.image?.reference;
  if (typeof reference === 'string' && !IMAGE_REFERENCE_PATTERN.test(reference)) {
    failures.push(`image.reference must be ${IMAGE_REPOSITORY}@sha256:<64 lowercase hex>, got ${reference}`);
  }
  if (manifest.image?.label !== IMAGE_LABEL) {
    failures.push(`image.label must be ${IMAGE_LABEL}, got ${manifest.image?.label}`);
  }
  if (manifest.image?.architecture !== REQUIRED_IMAGE_ARCHITECTURE) {
    failures.push(`image.architecture must be ${REQUIRED_IMAGE_ARCHITECTURE}, got ${manifest.image?.architecture}`);
  }
  if (Object.hasOwn(manifest.image ?? {}, 'id')) {
    failures.push(
      `image.id must not be pinned: image IDs differ between a pull and a local build; identity is the ${IMAGE_LABEL} label`
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
  return `${IMAGE_REPOSITORY}:${String(manifest.source?.installTree ?? '').slice(0, 12)}`;
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
  process.stdout.write(`atlas-sparkglm pins verified (${manifest.image.reference})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
