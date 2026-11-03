#!/usr/bin/env node
// MIT. LLooM-side fail-closed pin gate for the Atlas SparkGLM lane.
//
// The single pin manifest is backends/atlas-sparkglm/pins.json. This checker
// exits non-zero while any required identity is missing, malformed or still a
// DRAFT/TODO placeholder, so such a manifest can never satisfy a setup step, a
// pull, a build, or a start.
//
// The normal install path addresses the image by its immutable registry
// digest: ghcr.io/enntity/atlas-sparkglm@sha256:.... The tag (the first 12
// characters of the install/ git tree) is retained only as source-build
// metadata and as the local tag produced by an explicit --source-build. A tag
// alone is NOT an immutable artifact identity, and the image's
// io.enntity.sparkglm.install-tree label is a contents check, not an artifact
// identity. Image IDs are deliberately NOT pinned: install.sh verifies the
// local image by its install-tree label and architecture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pins.json');
export const REQUIRED_IMAGE_ARCHITECTURE = 'arm64';
export const IMAGE_REPOSITORY = 'ghcr.io/enntity/atlas-sparkglm';
export const IMAGE_LABEL = 'io.enntity.sparkglm.install-tree';
export const IMAGE_REFERENCE_PATTERN = /^ghcr\.io\/enntity\/atlas-sparkglm@sha256:[a-f0-9]{64}$/;
// Served as published. The earlier nvidia/GLM-5.3-Flash-NVFP4 checkpoint needs
// an MTP overlay this recipe does not prepare, so it is not a valid pin here.
export const MODEL_REPO = 'nvidia/GLM-5.3-Flash-FP4-Local';
export const MODEL_REVISION = '76348ddb2be2e35e39ecfc00e75dc07703f4f3d5';

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

// A release pins its drafters by name (drafters.v80, drafters.dflash2) for the
// recipe's --drafter option; manifests from before that pin one as drafter.
function drafterPins(manifest) {
  if (manifest.drafters && typeof manifest.drafters === 'object') {
    return Object.entries(manifest.drafters).map(([name, pin]) => [`drafters.${name}`, name, pin]);
  }
  return manifest.drafter ? [['drafter', null, manifest.drafter]] : [];
}

export function pinnedDrafter(manifest, name) {
  if (!manifest.drafters) return manifest.drafter;
  if (!Object.hasOwn(manifest.drafters, name)) {
    throw new Error(`pin manifest has no drafter ${name}; it pins ${Object.keys(manifest.drafters).join(', ')}`);
  }
  return manifest.drafters[name];
}

// One image serves every size, so a release lists each profile it must ship.
export function profilePathsOf(manifest) {
  const paths = manifest.image?.profilePaths;
  return Array.isArray(paths) ? paths : [manifest.image?.profilePath];
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
  const drafters = drafterPins(manifest);
  if (!drafters.length) failures.push('drafter is missing');
  for (const [field, name, pin] of drafters) {
    if (name !== null && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      failures.push(`drafter name ${name} must be lowercase letters, digits or -`);
    }
    for (const key of ['repo', 'revision']) {
      const value = pin?.[key];
      if (typeof value !== 'string' || value.length === 0) failures.push(`${field}.${key} is missing`);
      else if (/draft|todo/i.test(value)) failures.push(`${field}.${key} is a placeholder: ${value}`);
      else if (key === 'revision' && !/^[a-f0-9]{40}$/.test(value)) {
        failures.push(`${field}.revision must be a 40-character lowercase git object id, got ${value}`);
      }
    }
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
  // The tag is the first 12 characters of the install tree, as printed by the
  // pinned source's install/build.sh.
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
  const plainPath = (value) => /^\/opt\/atlas\/[A-Za-z0-9_./-]+$/.test(String(value ?? ''));
  if (!plainPath(manifest.image?.entrypoint)) {
    failures.push(`image.entrypoint must be a plain path under /opt/atlas, got ${manifest.image?.entrypoint}`);
  }
  const profiles = profilePathsOf(manifest);
  if (Array.isArray(manifest.image?.profilePaths)) {
    if (!profiles.length) failures.push('image.profilePaths must list at least one profile');
    for (const profile of profiles.filter((value) => !plainPath(value))) {
      failures.push(`image.profilePaths must be plain paths under /opt/atlas, got ${profile}`);
    }
  } else if (!plainPath(profiles[0])) {
    failures.push(`image.profilePath must be a plain path under /opt/atlas, got ${profiles[0]}`);
  }
  if (Object.hasOwn(manifest.image ?? {}, 'id')) {
    failures.push(
      `image.id must not be pinned: image IDs differ between a pull and a local build; identity is the ${IMAGE_LABEL} label`
    );
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
