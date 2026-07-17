#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

const additiveKeys = [
  'requests',
  'errors',
  'streams',
  'durationMs',
  'responseBytes',
  'firstContentCount',
  'firstContentMs',
  'generationDurationMs',
  'decodeTokens',
  'decodeSamples',
  'estimatedDecodeSamples',
  'inputTokens',
  'outputTokens',
  'totalTokens'
];

function mergeBucket(target, source) {
  for (const key of additiveKeys) target[key] = Number(target[key] || 0) + Number(source[key] || 0);
  if (source.minFirstContentMs != null) {
    target.minFirstContentMs =
      target.minFirstContentMs == null
        ? Number(source.minFirstContentMs)
        : Math.min(Number(target.minFirstContentMs), Number(source.minFirstContentMs));
  }
  if (source.maxFirstContentMs != null) {
    target.maxFirstContentMs = Math.max(Number(target.maxFirstContentMs || 0), Number(source.maxFirstContentMs));
  }
  target.recentDecodeRates = (target.recentDecodeRates || []).concat(source.recentDecodeRates || []).slice(-10);
  if (source.last && (!target.last || String(source.last.at || '') >= String(target.last.at || '')))
    target.last = source.last;
  target.avgDurationMs = target.requests ? Number((target.durationMs / target.requests).toFixed(2)) : 0;
  target.avgFirstContentMs = target.firstContentCount
    ? Number((target.firstContentMs / target.firstContentCount).toFixed(2))
    : null;
  target.outputTokensPerSecond = target.durationMs
    ? Number((target.outputTokens / (target.durationMs / 1000)).toFixed(2))
    : 0;
  target.decodeTokensPerSecond = target.recentDecodeRates.length
    ? Number(
        (
          target.recentDecodeRates.reduce((sum, rate) => sum + Number(rate || 0), 0) / target.recentDecodeRates.length
        ).toFixed(2)
      )
    : null;
}

function mergeRows(targetRows, sourceRows) {
  const byId = new Map((targetRows || []).map((entry) => [entry.id, entry]));
  for (const source of sourceRows || []) {
    if (!source?.id) continue;
    if (!byId.has(source.id)) byId.set(source.id, { id: source.id });
    mergeBucket(byId.get(source.id), source);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Merge one non-persistent LLooM process snapshot into durable history.

Usage:
  node scripts/merge-live-metrics.mjs --merge-id ID [--url http://127.0.0.1:8100] [--output ~/.lloom/metrics-history.json]

The command refuses persistent live gateways and duplicate merge IDs.`);
  process.exit(0);
}

const mergeId = argumentValue(args, '--merge-id');
if (!mergeId) throw new Error('--merge-id is required');
const gatewayUrl = argumentValue(args, '--url', 'http://127.0.0.1:8100').replace(/\/$/, '');
const outputPath = path.resolve(expandHome(argumentValue(args, '--output', '~/.lloom/metrics-history.json')));
const document = JSON.parse(readFileSync(outputPath, 'utf8'));
if (document.version !== 1 || !document.metrics?.totals) throw new Error('invalid metrics history document');
const mergedProcesses = Array.isArray(document.mergedProcesses) ? document.mergedProcesses : [];
if (mergedProcesses.some((entry) => entry.id === mergeId)) throw new Error(`merge ${mergeId} was already applied`);

const apiKey = process.env.LLOOM_API_KEY;
const response = await fetch(`${gatewayUrl}/gateway/metrics`, {
  headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
});
if (!response.ok) throw new Error(`metrics request failed with HTTP ${response.status}`);
const snapshot = await response.json();
if (!snapshot?.totals || !Array.isArray(snapshot.models) || !Array.isArray(snapshot.routes)) {
  throw new Error('gateway returned an invalid metrics snapshot');
}
if (snapshot.persistence?.enabled) {
  throw new Error('live gateway already reports persistent totals; refusing a potentially duplicative merge');
}
if (Array.isArray(snapshot.active) && snapshot.active.length) {
  throw new Error(`live gateway still has ${snapshot.active.length} active request(s); drain traffic before merging`);
}

mergeBucket(document.metrics.totals, snapshot.totals);
document.metrics.models = mergeRows(document.metrics.models, snapshot.models);
document.metrics.routes = mergeRows(document.metrics.routes, snapshot.routes);
const dayId = String(snapshot.generatedAt || new Date().toISOString()).slice(0, 10);
document.metrics.history ||= { days: [] };
document.metrics.history.days ||= [];
let day = document.metrics.history.days.find((entry) => entry.date === dayId);
if (!day) {
  day = { date: dayId, totals: { id: dayId }, models: [], routes: [] };
  document.metrics.history.days.push(day);
}
mergeBucket(day.totals, snapshot.totals);
day.models = mergeRows(day.models, snapshot.models);
day.routes = mergeRows(day.routes, snapshot.routes);
document.metrics.history.days.sort((a, b) => a.date.localeCompare(b.date));
document.mergedProcesses = mergedProcesses.concat({
  id: mergeId,
  generatedAt: snapshot.generatedAt,
  mergedAt: new Date().toISOString()
});
document.updatedAt = new Date().toISOString();

const temporaryPath = `${outputPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, outputPath);
console.log(
  JSON.stringify(
    {
      mergeId,
      inputTokens: document.metrics.totals.inputTokens,
      outputTokens: document.metrics.totals.outputTokens,
      requests: document.metrics.totals.requests,
      errors: document.metrics.totals.errors
    },
    null,
    2
  )
);
