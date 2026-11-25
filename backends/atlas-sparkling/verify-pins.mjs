#!/usr/bin/env node
// MIT. LLooM-side fail-closed pin gate for the Atlas SparkLing lane.
//
// This checker exits non-zero while any required identity in a pin manifest
// (backends/atlas-sparkling/pins-<version>.json) is missing, malformed or
// still a DRAFT/TODO placeholder, so such a manifest can never satisfy a setup
// step, a pull, or a start.
//
// The install path addresses the image by its immutable registry digest:
// ghcr.io/enntity/atlas-sparkling@sha256:.... The tag (the first 12
// characters of the install/ git tree) is source-build metadata only, and the
// image's io.enntity.sparkling.install-tree label is a contents check, not
// an artifact identity. Image IDs are deliberately NOT pinned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pins-0.1.0.json');
export const REQUIRED_IMAGE_ARCHITECTURE = 'arm64';
export const SOURCE_REPO = 'Enntity/SparkLing';
export const ENGINE_REPO = 'Enntity/atlas';
export const IMAGE_REPOSITORY = 'ghcr.io/enntity/atlas-sparkling';
export const IMAGE_LABEL = 'io.enntity.sparkling.install-tree';
export const IMAGE_REFERENCE_PATTERN = /^ghcr\.io\/enntity\/atlas-sparkling@sha256:[a-f0-9]{64}$/;
// The checkpoint each SparkLing model serves per weights choice, and the
// SparkLing pin file (install/<manifest>) that check_files.py verifies it with.
export const CHECKPOINTS = {
  'ling-3.2-air': {
    strict: {
      repo: 'inclusionAI/Ling-3.2-air',
      revision: 'ff099487f6f57165e6fa9386ad61fddfafc78b76',
      manifest: 'checkpoint.json'
    },
    spark: {
      repo: 'primitive-ai/Ling-3.2-air-NVFP4A16',
      revision: '3a78e58506316b5b9b7d06037910c3f4abdd291f',
      manifest: 'checkpoint.json'
    }
  },
  'sante-air-vl': {
    strict: {
      repo: 'inclusionAI/LingSante-3.1-air-VL',
      revision: '1f398c937d6069994a156689636832c47d8c09be',
      manifest: 'checkpoint-sante-air-vl.json'
    },
    spark: {
      repo: 'Enntity/LingSante-3.1-air-VL-NVFP4',
      revision: '2702935791ac4f04b2b103c748a19de89f6df940',
      manifest: 'checkpoint-sante-nvfp4.json'
    }
  }
};
// The SparkLing install files prepare.sh fetches at source.revision and runs
// in the image; each must carry its sha256 in prepareTool.
export const PREPARE_TOOL_FILES = [
  'check_files.py',
  'checkpoint.json',
  'checkpoint-sante-air-vl.json',
  'checkpoint-sante-nvfp4.json'
];

const REQUIRED_PINS = [
  ['status', (m) => m.status],
  ['source.repo', (m) => m.source?.repo],
  ['source.revision', (m) => m.source?.revision],
  ['source.installTree', (m) => m.source?.installTree],
  ['engine.repo', (m) => m.engine?.repo],
  ['engine.branch', (m) => m.engine?.branch],
  ['engine.commit', (m) => m.engine?.commit],
  ['image.reference', (m) => m.image?.reference],
  ['image.tag', (m) => m.image?.tag]
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
  // prepare.sh interpolates source.repo into the URL it fetches the tools from.
  if (typeof manifest.source?.repo === 'string' && manifest.source.repo !== SOURCE_REPO) {
    failures.push(`source.repo must be ${SOURCE_REPO}, got ${manifest.source.repo}`);
  }
  if (typeof manifest.engine?.repo === 'string' && manifest.engine.repo !== ENGINE_REPO) {
    failures.push(`engine.repo must be ${ENGINE_REPO}, got ${manifest.engine.repo}`);
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
  // prepare.sh reads the checkpoint directory and the pin file from here.
  if (JSON.stringify(manifest.checkpoints) !== JSON.stringify(CHECKPOINTS)) {
    failures.push(`checkpoints must stay on ${JSON.stringify(CHECKPOINTS)}`);
  }
  const tool = manifest.prepareTool ?? {};
  for (const name of PREPARE_TOOL_FILES) {
    if (!/^[a-f0-9]{64}$/.test(String(tool[name] ?? ''))) {
      failures.push(`prepareTool.${name} must be a 64-character lowercase sha256`);
    }
  }
  return failures;
}

function main() {
  const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : MANIFEST_PATH;
  let manifest;
  try {
    manifest = loadPins(manifestPath);
  } catch (error) {
    process.stderr.write(`atlas-sparkling pins unreadable at ${manifestPath}: ${error.message}\n`);
    process.exit(2);
  }
  const failures = verifyPins(manifest);
  if (failures.length > 0) {
    process.stderr.write('atlas-sparkling pins are not installable:\n');
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`atlas-sparkling pins verified (${manifest.image.reference})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
