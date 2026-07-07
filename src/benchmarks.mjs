import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";

export const defaultBenchmarksRoot = path.join(repoRoot, "benchmarks/community");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function listBenchmarkFiles(root = defaultBenchmarksRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(root, entry.name))
    .sort();
}

export async function readBenchmarkFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    filePath,
  };
}

export async function loadBenchmarkEvidence(root = defaultBenchmarksRoot) {
  const files = await listBenchmarkFiles(root);
  const loaded = [];
  for (const file of files) {
    const entry = await readBenchmarkFile(file);
    if (Array.isArray(entry.results)) {
      for (const result of entry.results) {
        loaded.push({
          ...result,
          suite: {
            id: entry.id,
            name: entry.name,
            source: entry.source,
            submittedAt: entry.submittedAt,
            filePath: file,
          },
        });
      }
    } else {
      loaded.push(entry);
    }
  }
  return loaded;
}

export function validateBenchmarkResult(result) {
  const errors = [];
  if (!result.id) errors.push("benchmark result is missing id");
  if (!result.recipeId) errors.push(`benchmark ${result.id ?? "(missing)"} is missing recipeId`);
  if (!result.backendId) errors.push(`benchmark ${result.id ?? "(missing)"} is missing backendId`);
  if (!result.model) errors.push(`benchmark ${result.id ?? "(missing)"} is missing model`);
  if (!result.machine?.platformId) errors.push(`benchmark ${result.id ?? "(missing)"} is missing machine.platformId`);
  if (!result.metrics) errors.push(`benchmark ${result.id ?? "(missing)"} is missing metrics`);
  const generation = numberOrNull(result.metrics?.generationTokPerSec);
  const prefill = numberOrNull(result.metrics?.prefillTokPerSec);
  if (generation == null && prefill == null) {
    errors.push(`benchmark ${result.id ?? "(missing)"} needs generationTokPerSec or prefillTokPerSec`);
  }
  if (generation != null && generation < 0) errors.push(`benchmark ${result.id} generationTokPerSec must be positive`);
  if (prefill != null && prefill < 0) errors.push(`benchmark ${result.id} prefillTokPerSec must be positive`);
  return errors;
}

export function validateBenchmarkEvidence(results) {
  return asArray(results).flatMap(result => validateBenchmarkResult(result));
}

export function benchmarkScore(result) {
  const generation = numberOrNull(result.metrics?.generationTokPerSec) ?? 0;
  const prefill = numberOrNull(result.metrics?.prefillTokPerSec) ?? 0;
  const context = numberOrNull(result.metrics?.contextWindow) ?? 0;
  return generation * 1000 + prefill + context / 100000;
}

export function summarizeBenchmarksForRecipe(recipe, results) {
  const recipeResults = asArray(results).filter(result => result.recipeId === recipe.id);
  return asArray(recipe.models).map(model => {
    const matching = recipeResults
      .filter(result => result.model === model.model || result.gatewayModel === model.gatewayModel)
      .sort((a, b) => benchmarkScore(b) - benchmarkScore(a));
    const best = matching[0] ?? null;
    return {
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      count: matching.length,
      best: best ? {
        id: best.id,
        backendId: best.backendId,
        machine: best.machine,
        settings: best.settings ?? {},
        metrics: best.metrics ?? {},
        source: best.suite?.source ?? best.source,
        submittedAt: best.suite?.submittedAt ?? best.submittedAt,
        score: benchmarkScore(best),
      } : null,
    };
  });
}

export function benchmarkOverview(results) {
  return asArray(results)
    .map(result => ({
      id: result.id,
      recipeId: result.recipeId,
      backendId: result.backendId,
      model: result.model,
      machine: result.machine,
      metrics: result.metrics,
      score: benchmarkScore(result),
      source: result.suite?.source ?? result.source,
      submittedAt: result.suite?.submittedAt ?? result.submittedAt,
    }))
    .sort((a, b) => b.score - a.score);
}
