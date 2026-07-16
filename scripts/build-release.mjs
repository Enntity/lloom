#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, parseArgs } from './release-lib.mjs';

const flags = parseArgs(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await buildRelease({ root, allowDirty: !!flags['allow-dirty'], runTests: !flags['skip-tests'] });
console.log(
  JSON.stringify(
    {
      artifact: result.artifact,
      manifest: result.manifestPath,
      sha256: result.manifest.sha256,
      commit: result.manifest.commit
    },
    null,
    2
  )
);
