#!/usr/bin/env node

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Capture a running LLooM gateway's process-local metrics before its first persistence-aware restart.

Usage:
  node scripts/capture-live-metrics.mjs [--url http://127.0.0.1:8100] [--output ~/.lloom/metrics-history.json] [--force]

Authentication uses LLOOM_API_KEY when set. The output contains aggregate telemetry only.`);
  process.exit(0);
}

const gatewayUrl = argumentValue(args, '--url', 'http://127.0.0.1:8100').replace(/\/$/, '');
const outputPath = path.resolve(expandHome(argumentValue(args, '--output', '~/.lloom/metrics-history.json')));
const force = args.includes('--force');
if (existsSync(outputPath) && !force) {
  throw new Error(`${outputPath} already exists; refusing to replace durable history without --force`);
}

const apiKey = process.env.LLOOM_API_KEY;
const response = await fetch(`${gatewayUrl}/gateway/metrics`, {
  headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
});
if (!response.ok) throw new Error(`metrics request failed with HTTP ${response.status}`);
const snapshot = await response.json();
if (!snapshot?.totals || !Array.isArray(snapshot.models) || !Array.isArray(snapshot.routes)) {
  throw new Error('gateway returned an invalid metrics snapshot');
}

const capturedAt = new Date().toISOString();
const document = {
  version: 1,
  createdAt: capturedAt,
  updatedAt: capturedAt,
  importedFrom: {
    generatedAt: snapshot.generatedAt ?? null,
    note: 'Pre-persistence process snapshot; exact historical day boundaries are unavailable.'
  },
  metrics: {
    totals: snapshot.totals,
    models: snapshot.models,
    routes: snapshot.routes
  }
};

mkdirSync(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, outputPath);
console.log(
  `Captured ${snapshot.totals.inputTokens ?? 0} input and ${snapshot.totals.outputTokens ?? 0} output tokens.`
);
console.log(`Wrote ${outputPath}`);
