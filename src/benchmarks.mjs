import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './config.mjs';

export const defaultBenchmarksRoot = path.join(repoRoot, 'benchmarks/community');
export const BENCHMARK_SUITE_SCHEMA = 'https://lloom.dev/schemas/benchmark-suite.v1.schema.json';
export const BENCHMARK_SUITE_MEDIA_TYPE = 'application/vnd.lloom.benchmark-suite+json;version=1';
export const BENCHMARK_SUBMISSION_RESPONSE_SCHEMA =
  'https://lloom.dev/schemas/benchmark-submission-response.v1.schema.json';
export const BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE =
  'application/vnd.lloom.benchmark-submission-response+json;version=1';
export const INTERCHANGE_PROFILE = 'https://lloom.dev/profiles/interchange/v1';
export const defaultBenchmarkSubmissionPath = '/v1/benchmarks';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function submissionUrl({ hostUrl, submissionPath = defaultBenchmarkSubmissionPath }) {
  if (!hostUrl) throw new Error('community.hostUrl is not configured');
  return `${stripTrailingSlash(hostUrl)}${submissionPath.startsWith('/') ? '' : '/'}${submissionPath}`;
}

async function readJsonSource(source) {
  if (!source) throw new Error('benchmark submission source is required');
  if (typeof source === 'object') {
    return {
      source: null,
      document: source
    };
  }
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch benchmark submission ${source}: HTTP ${response.status}`);
    return {
      source,
      document: await response.json()
    };
  }
  const filePath = path.resolve(source);
  return {
    source: filePath,
    document: JSON.parse(await fs.readFile(filePath, 'utf8'))
  };
}

function benchmarkSubmissionOptions(config, options = {}) {
  const community = asObject(config?.community);
  return {
    hostUrl: options.hostUrl ?? community.hostUrl,
    submissionPath: options.submissionPath ?? community.submissionPath ?? defaultBenchmarkSubmissionPath,
    timeoutMs: options.timeoutMs ?? community.timeoutMs ?? 30000
  };
}

function submissionRequestBody(suites) {
  return suites.length === 1 ? suites[0] : { suites };
}

export function normalizeBenchmarkSubmissionSuites(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.suites)) return document.suites;
  return [document];
}

export async function readBenchmarkSubmission(source) {
  const loaded = await readJsonSource(source);
  return {
    ...loaded,
    suites: normalizeBenchmarkSubmissionSuites(loaded.document)
  };
}

export async function listBenchmarkFiles(root = defaultBenchmarksRoot) {
  // eslint-disable-next-line no-useless-assignment
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export async function readBenchmarkFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    filePath
  };
}

export async function loadBenchmarkEvidence(root = defaultBenchmarksRoot) {
  const files = await listBenchmarkFiles(root);
  const loaded = [];
  for (const file of files) {
    const entry = await readBenchmarkFile(file);
    loaded.push(...benchmarkSuitesToEvidence([entry], { filePath: file }));
  }
  return loaded;
}

export function benchmarkSuitesToEvidence(suites = [], { filePath } = {}) {
  const loaded = [];
  for (const suite of asArray(suites)) {
    if (!suite) continue;
    if (Array.isArray(suite.results)) {
      for (const result of suite.results) {
        loaded.push({
          ...result,
          suite: {
            id: suite.id,
            name: suite.name,
            source: suite.source,
            submittedAt: suite.submittedAt,
            ...(filePath ? { filePath } : {})
          }
        });
      }
    } else {
      loaded.push(suite);
    }
  }
  return loaded;
}

function benchmarkEvidenceKey(result) {
  return [result?.id, result?.recipeId, result?.backendId, result?.model, result?.gatewayModel]
    .map((value) => String(value ?? ''))
    .join('\u0000');
}

function dedupeBenchmarkEvidence(evidence) {
  const seen = new Set();
  const deduped = [];
  for (const result of evidence) {
    const key = benchmarkEvidenceKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

export async function loadBenchmarkEvidenceWithDocuments(root = defaultBenchmarksRoot, benchmarkDocuments = []) {
  return dedupeBenchmarkEvidence([
    ...(await loadBenchmarkEvidence(root)),
    ...benchmarkSuitesToEvidence(benchmarkDocuments)
  ]);
}

export function validateBenchmarkSuite(suite) {
  const errors = [];
  if (suite.schemaVersion !== 1) errors.push('benchmark suite schemaVersion must be 1');
  if (!suite.id) errors.push('benchmark suite is missing id');
  if (!suite.name) errors.push(`benchmark suite ${suite.id ?? '(missing)'} is missing name`);
  if (!suite.submittedAt) errors.push(`benchmark suite ${suite.id ?? '(missing)'} is missing submittedAt`);
  if (!Array.isArray(suite.results)) {
    errors.push(`benchmark suite ${suite.id ?? '(missing)'} results must be an array`);
    return errors;
  }
  if (!suite.results.length) errors.push(`benchmark suite ${suite.id ?? '(missing)'} results must not be empty`);
  return [...errors, ...validateBenchmarkEvidence(suite.results)];
}

export function validateBenchmarkSuites(suites) {
  return asArray(suites).flatMap((suite) => validateBenchmarkSuite(suite));
}

export function createBenchmarkSubmissionResponse({
  accepted,
  persisted = false,
  validationErrors = [],
  submissions = [],
  message,
  host,
  submittedAt = new Date().toISOString()
} = {}) {
  return {
    $schema: BENCHMARK_SUBMISSION_RESPONSE_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: `benchmark-submission-${submittedAt.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '')}`,
    accepted: Boolean(accepted),
    persisted: Boolean(persisted),
    count: submissions.length,
    submittedAt,
    ...(host ? { host } : {}),
    validationErrors: asArray(validationErrors),
    submissions: asArray(submissions),
    ...(message ? { message } : {})
  };
}

export function validateBenchmarkSubmissionResponse(response) {
  const errors = [];
  if (response.schemaVersion !== 1) errors.push('benchmark submission response schemaVersion must be 1');
  if (response.$schema && response.$schema !== BENCHMARK_SUBMISSION_RESPONSE_SCHEMA) {
    errors.push(`benchmark submission response has unsupported $schema ${response.$schema}`);
  }
  if (!response.id) errors.push('benchmark submission response is missing id');
  if (typeof response.accepted !== 'boolean')
    errors.push(`benchmark submission response ${response.id ?? '(missing)'} accepted must be boolean`);
  if (typeof response.persisted !== 'boolean')
    errors.push(`benchmark submission response ${response.id ?? '(missing)'} persisted must be boolean`);
  if (!response.submittedAt)
    errors.push(`benchmark submission response ${response.id ?? '(missing)'} is missing submittedAt`);
  if (!Number.isInteger(response.count) || response.count < 0) {
    errors.push(`benchmark submission response ${response.id ?? '(missing)'} count must be a non-negative integer`);
  }
  if (!Array.isArray(response.validationErrors)) {
    errors.push(`benchmark submission response ${response.id ?? '(missing)'} validationErrors must be an array`);
  }
  if (!Array.isArray(response.submissions)) {
    errors.push(`benchmark submission response ${response.id ?? '(missing)'} submissions must be an array`);
  }
  for (const [index, submission] of asArray(response.submissions).entries()) {
    if (!Object.hasOwn(submission ?? {}, 'id'))
      errors.push(`benchmark submission response submissions[${index}] is missing id`);
    if (!submission?.status) errors.push(`benchmark submission response submissions[${index}] is missing status`);
  }
  return errors;
}

export async function createBenchmarkSubmissionPlan(source, config, options = {}) {
  const effective = benchmarkSubmissionOptions(config, options);
  const loaded = await readBenchmarkSubmission(source);
  const validationErrors = loaded.suites.flatMap((suite) => validateBenchmarkSuite(suite));
  const requestUrl = submissionUrl(effective);
  return {
    ok: validationErrors.length === 0,
    dryRun: true,
    source: loaded.source,
    host: {
      url: effective.hostUrl,
      submissionPath: effective.submissionPath,
      requestUrl
    },
    request: {
      mediaType: BENCHMARK_SUITE_MEDIA_TYPE,
      bodyShape: loaded.suites.length === 1 ? 'benchmark-suite.v1' : 'benchmark-suite-envelope.v1'
    },
    count: loaded.suites.length,
    suites: loaded.suites.map((suite) => ({
      id: suite?.id ?? null,
      name: suite?.name ?? null,
      resultCount: Array.isArray(suite?.results) ? suite.results.length : 0
    })),
    validationErrors,
    next: {
      submitApply: 'lloom benchmark-submit <suite.json> --apply --yes'
    }
  };
}

export async function submitBenchmarkSuites(source, config, { dryRun = true, yes = false, ...options } = {}) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to submit benchmark suites without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }
  const plan = await createBenchmarkSubmissionPlan(source, config, options);
  if (dryRun || plan.validationErrors.length) return plan;

  const response = await fetch(plan.host.requestUrl, {
    method: 'POST',
    headers: {
      accept: `${BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE}, application/json`,
      'content-type': BENCHMARK_SUITE_MEDIA_TYPE
    },
    body: JSON.stringify(submissionRequestBody((await readBenchmarkSubmission(source)).suites)),
    signal: AbortSignal.timeout(benchmarkSubmissionOptions(config, options).timeoutMs)
  });
  const rawResponse = await response.text();
  // eslint-disable-next-line no-useless-assignment
  let body = null;
  try {
    body = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    body = { message: rawResponse };
  }
  const responseValidationErrors =
    body && typeof body === 'object'
      ? validateBenchmarkSubmissionResponse(body)
      : ['benchmark submission response must be a JSON object'];
  return {
    ...plan,
    ok: response.ok && responseValidationErrors.length === 0 && body?.accepted !== false,
    dryRun: false,
    submitted: response.ok,
    status: response.status,
    response: body,
    validationErrors: responseValidationErrors
  };
}

export function validateBenchmarkResult(result) {
  const errors = [];
  if (!result.id) errors.push('benchmark result is missing id');
  if (!result.recipeId) errors.push(`benchmark ${result.id ?? '(missing)'} is missing recipeId`);
  if (!result.backendId) errors.push(`benchmark ${result.id ?? '(missing)'} is missing backendId`);
  if (!result.model) errors.push(`benchmark ${result.id ?? '(missing)'} is missing model`);
  if (!result.machine?.platformId) errors.push(`benchmark ${result.id ?? '(missing)'} is missing machine.platformId`);
  if (!result.metrics) errors.push(`benchmark ${result.id ?? '(missing)'} is missing metrics`);
  const generation = numberOrNull(result.metrics?.generationTokPerSec);
  const prefill = numberOrNull(result.metrics?.prefillTokPerSec);
  if (generation == null && prefill == null) {
    errors.push(`benchmark ${result.id ?? '(missing)'} needs generationTokPerSec or prefillTokPerSec`);
  }
  if (generation != null && generation < 0) errors.push(`benchmark ${result.id} generationTokPerSec must be positive`);
  if (prefill != null && prefill < 0) errors.push(`benchmark ${result.id} prefillTokPerSec must be positive`);
  return errors;
}

export function validateBenchmarkEvidence(results) {
  return asArray(results).flatMap((result) => validateBenchmarkResult(result));
}

export function benchmarkScore(result) {
  const generation = numberOrNull(result.metrics?.generationTokPerSec) ?? 0;
  const prefill = numberOrNull(result.metrics?.prefillTokPerSec) ?? 0;
  const context = numberOrNull(result.metrics?.contextWindow) ?? 0;
  return generation * 1000 + prefill + context / 100000;
}

export function summarizeBenchmarksForRecipe(recipe, results) {
  const recipeResults = asArray(results).filter((result) => result.recipeId === recipe.id);
  return asArray(recipe.models).map((model) => {
    const matching = recipeResults
      .filter((result) => result.model === model.model || result.gatewayModel === model.gatewayModel)
      .sort((a, b) => benchmarkScore(b) - benchmarkScore(a));
    const best = matching[0] ?? null;
    return {
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      count: matching.length,
      best: best
        ? {
            id: best.id,
            backendId: best.backendId,
            machine: best.machine,
            settings: best.settings ?? {},
            metrics: best.metrics ?? {},
            source: best.suite?.source ?? best.source,
            submittedAt: best.suite?.submittedAt ?? best.submittedAt,
            score: benchmarkScore(best)
          }
        : null
    };
  });
}

export function benchmarkOverview(results) {
  return asArray(results)
    .map((result) => ({
      id: result.id,
      recipeId: result.recipeId,
      backendId: result.backendId,
      model: result.model,
      gatewayModel: result.gatewayModel,
      machine: result.machine,
      workload: result.workload ?? {},
      settings: result.settings ?? {},
      metrics: result.metrics,
      score: benchmarkScore(result),
      source: result.suite?.source ?? result.source,
      submittedAt: result.suite?.submittedAt ?? result.submittedAt
    }))
    .sort((a, b) => b.score - a.score);
}
