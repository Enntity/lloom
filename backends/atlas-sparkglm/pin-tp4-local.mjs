#!/usr/bin/env node
// MIT. Pins the TP-4 chain lane to an unpublished release candidate.
//
//   node backends/atlas-sparkglm/pin-tp4-local.mjs --rc rc2 --engine <commit> \
//     [--engine-branch sparkglm/tp4-integ] [--sparkglm <checkout> | --revision <commit> --install-tree <tree>]
//
// Writes pins-tp4.json (status final, image.source local) and mirrors its
// image reference into the recipe's bootstrap images, then runs the pin gate.
// The image reference is the local tag localhost/atlas-sparkglm:tp4-<rc>-<engine12>,
// which install.sh never pulls: tag the candidate's image with it on every node
// (with the pinned install-tree label and engine commit) before setup.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_IMAGE_PATTERN, LOCAL_IMAGE_REPOSITORY, verifyPins } from './verify-pins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pinsPath = path.join(here, 'pins-tp4.json');
const recipePath = path.join(here, '..', '..', 'recipes', 'linux-nvidia-dgx-spark-4x-glm53-atlas-tp4.json');

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)$/.exec(argv[index]);
    if (!match || argv[index + 1] == null) throw new Error(`unexpected argument ${argv[index]}`);
    out[match[1]] = argv[(index += 1)];
  }
  return out;
}

export function pinLocalCandidate(pins, { rc, engine, engineBranch, revision, installTree }) {
  const reference = `${LOCAL_IMAGE_REPOSITORY}:tp4-${rc}-${String(engine).slice(0, 12)}`;
  if (!LOCAL_IMAGE_PATTERN.test(reference)) throw new Error(`--rc gives an invalid local tag ${reference}`);
  return {
    ...pins,
    status: 'final',
    note:
      `Pin manifest for the four-Spark TP-4 daisy-chain lane (recipe linux-nvidia-dgx-spark-4x-glm53-atlas-tp4), ` +
      `pinned to the unpublished release candidate ${rc}. image.source local: the image is the local tag ` +
      `${reference}, never pulled; install.sh accepts it only when every node already has it with the pinned ` +
      `install-tree label, /opt/atlas/serve.py, the 4x1m-tp4 profile and engine ${engine} in ` +
      `/opt/atlas/source-manifest.json. Publishing it means a GHCR digest and image.source registry.`,
    source: { ...pins.source, revision, installTree },
    engine: { ...pins.engine, ...(engineBranch ? { branch: engineBranch } : {}), commit: engine },
    image: { ...pins.image, source: 'local', reference, tag: reference }
  };
}

export function mirrorRecipeImage(recipe, reference) {
  const next = structuredClone(recipe);
  for (const member of next.models[0].settings.placement.members) {
    member.runtimeSettings.bootstrap.image = reference;
  }
  return next;
}

function gitRead(checkout, ...rest) {
  return execFileSync('git', ['-C', checkout, ...rest], { encoding: 'utf8' }).trim();
}

function main() {
  const options = args(process.argv.slice(2));
  if (!options.rc || !options.engine) throw new Error('--rc and --engine are required');
  let { revision, 'install-tree': installTree } = options;
  if (options.sparkglm) {
    if (gitRead(options.sparkglm, 'status', '--porcelain', '--', 'install')) {
      throw new Error(`${options.sparkglm} has uncommitted changes under install/`);
    }
    revision = gitRead(options.sparkglm, 'rev-parse', 'HEAD');
    installTree = gitRead(options.sparkglm, 'rev-parse', 'HEAD:install');
  }
  if (!revision || !installTree) throw new Error('pass --sparkglm <checkout>, or --revision and --install-tree');
  const pins = pinLocalCandidate(JSON.parse(fs.readFileSync(pinsPath, 'utf8')), {
    rc: options.rc,
    engine: options.engine,
    engineBranch: options['engine-branch'],
    revision,
    installTree
  });
  const failures = verifyPins(pins);
  if (failures.length) throw new Error(`pins would not verify:\n  - ${failures.join('\n  - ')}`);
  const recipe = mirrorRecipeImage(JSON.parse(fs.readFileSync(recipePath, 'utf8')), pins.image.reference);
  fs.writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
  fs.writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  process.stdout.write(`${pins.image.reference}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`pin-tp4-local: ${error.message}\n`);
    process.exit(1);
  }
}
