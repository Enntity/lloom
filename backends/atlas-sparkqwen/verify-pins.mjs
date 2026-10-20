#!/usr/bin/env node
// MIT. LLooM-side fail-closed pin gate for the Atlas SparkQwen lane.
//
// The single pin manifest is backends/atlas-sparkqwen/pins.json. This checker
// exits non-zero while any required identity is missing, malformed or still a
// DRAFT/TODO placeholder, so such a manifest can never satisfy a setup step, a
// pull, or a start.
//
// The normal install path addresses the image by its immutable registry
// digest: ghcr.io/enntity/atlas-sparkqwen@sha256:.... The tag (the first 12
// characters of the install/ git tree) is source-build metadata only, and the
// image's io.enntity.sparkqwen.install-tree label is a contents check, not an
// artifact identity. Image IDs are deliberately NOT pinned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pins.json');
export const REQUIRED_IMAGE_ARCHITECTURE = 'arm64';
export const IMAGE_REPOSITORY = 'ghcr.io/enntity/atlas-sparkqwen';
export const IMAGE_LABEL = 'io.enntity.sparkqwen.install-tree';
export const IMAGE_REFERENCE_PATTERN = /^ghcr\.io\/enntity\/atlas-sparkqwen@sha256:[a-f0-9]{64}$/;
export const MODEL_REPO = 'nvidia/Qwen3.8-Flash-Next-FP4-Local';
export const MODEL_REVISION = 'b9ce18a6887e18c089fdea8509a33e63429a3300';

const REQUIRED_PINS = [
  ['status', (m) => m.status],
  ['source.revision', (m) => m.source?.revision],
  ['source.installTree', (m) => m.source?.installTree],
  ['engine.commit', (m) => m.engine?.commit],
  ['image.reference', (m) => m.image?.reference],
  ['image.tag', (m) => m.image?.tag],
  ['model.repo', (m) => m.model?.repo],
  ['model.revision', (m) => m.model?.revision]
];

export function loadPins(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function imageTagFor(manifest) {
  return `${IMAGE_REPOSITORY}:${String(manifest.source?.installTree ?? '').slice(0, 12)}`;
}

export function verifyPins(manifest) {
  const failures = [];
  for (const [name, select] of REQUIRED_PINS) {
    const value = select(manifest);
    if (typeof value !== 'string' || value.length === 0) failures.push(`${name} is missing`);
    else if (/draft|todo/i.test(value)) failures.push(`${name} is a placeholder: ${value}`);
  }
  if (String(manifest.status).toLowerCase() !== 'final') {
    failures.push(`status must be final, got ${manifest.status}`);
  }
  for (const [name, value] of [
    ['source.revision', manifest.source?.revision],
    ['source.installTree', manifest.source?.installTree],
    ['engine.commit', manifest.engine?.commit]
  ]) {
    if (typeof value === 'string' && !/^[a-f0-9]{40}$/.test(value)) {
      failures.push(`${name} must be a 40-character lowercase git object id, got ${value}`);
    }
  }
  if (typeof manifest.image?.tag === 'string' && manifest.image.tag !== imageTagFor(manifest)) {
    failures.push(`image.tag must be ${imageTagFor(manifest)}, got ${manifest.image.tag}`);
  }
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
  // install.sh interpolates these into an in-image check command.
  for (const name of ['entrypoint', 'profilePath']) {
    if (!/^\/opt\/atlas\/[A-Za-z0-9_./-]+$/.test(String(manifest.image?.[name] ?? ''))) {
      failures.push(`image.${name} must be a plain path under /opt/atlas, got ${manifest.image?.[name]}`);
    }
  }
  if (Object.hasOwn(manifest.image ?? {}, 'id')) {
    failures.push(`image.id must not be pinned: image IDs differ between a pull and a local build`);
  }
  if (manifest.model?.repo !== MODEL_REPO || manifest.model?.revision !== MODEL_REVISION) {
    failures.push(`model must stay on ${MODEL_REPO}@${MODEL_REVISION}`);
  }
  return failures;
}

function main() {
  const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : MANIFEST_PATH;
  let manifest;
  try {
    manifest = loadPins(manifestPath);
  } catch (error) {
    process.stderr.write(`atlas-sparkqwen pins unreadable at ${manifestPath}: ${error.message}\n`);
    process.exit(2);
  }
  const failures = verifyPins(manifest);
  if (failures.length > 0) {
    process.stderr.write('atlas-sparkqwen pins are not installable:\n');
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`atlas-sparkqwen pins verified (${manifest.image.reference})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
