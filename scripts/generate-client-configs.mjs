#!/usr/bin/env node
import {
  repoExamplesRoot,
  repoGeneratedRoot,
  writeGeneratedIntegrationArtifacts
} from '../src/client-integrations.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/registry.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const generatedRoot =
  argValue('--root') ?? (process.argv.includes('--examples') ? repoExamplesRoot : repoGeneratedRoot);

const config = await loadConfig();
const registry = createRegistry(config);
const artifacts = await writeGeneratedIntegrationArtifacts(config, registry, {
  generatedRoot
});

for (const artifact of artifacts) {
  console.log(`wrote ${artifact.generatedPath}`);
}

if (process.argv.includes('--live-omp')) {
  const { applyIntegrationArtifacts } = await import('../src/client-integrations.mjs');
  const result = await applyIntegrationArtifacts(config, registry, {
    clientId: 'omp',
    dryRun: false,
    yes: true
  });
  for (const entry of result.results) {
    console.log(`${entry.status} ${entry.targetPath}`);
  }
}
