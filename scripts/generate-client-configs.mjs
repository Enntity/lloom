#!/usr/bin/env node
import { writeGeneratedIntegrationArtifacts } from "../src/client-integrations.mjs";
import { loadConfig } from "../src/config.mjs";
import { createRegistry } from "../src/registry.mjs";

const config = await loadConfig();
const registry = createRegistry(config);
const artifacts = await writeGeneratedIntegrationArtifacts(config, registry);

for (const artifact of artifacts) {
  console.log(`wrote ${artifact.generatedPath}`);
}

if (process.argv.includes("--live-omp")) {
  const { applyIntegrationArtifacts } = await import("../src/client-integrations.mjs");
  const result = await applyIntegrationArtifacts(config, registry, {
    clientId: "omp",
    dryRun: false,
    yes: true,
  });
  for (const entry of result.results) {
    console.log(`${entry.status} ${entry.targetPath}`);
  }
}
