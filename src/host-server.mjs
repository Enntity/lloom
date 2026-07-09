import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { defaultBackendCatalogPath, loadBackendCatalog, validateBackendCatalog } from './backend-catalog.mjs';
import {
  BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  benchmarkOverview,
  benchmarkScore,
  createBenchmarkSubmissionResponse,
  defaultBenchmarksRoot,
  loadBenchmarkEvidence,
  validateBenchmarkSuite
} from './benchmarks.mjs';
import {
  buildRecommendationResponse,
  evaluateRecipe,
  normalizeMachineProfile,
  RECOMMENDATION_REQUEST_MEDIA_TYPE,
  RECOMMENDATION_REQUEST_SCHEMA,
  RECOMMENDATION_RESPONSE_MEDIA_TYPE,
  validateMachineProfile,
  validateRecommendationRequest,
  validateRecommendationResponse
} from './machine-profile.mjs';
import {
  INTERCHANGE_REGISTRY_MEDIA_TYPE,
  INTERCHANGE_MEDIA_TYPES,
  ERROR_RESPONSE_MEDIA_TYPE,
  SIGNING_KEYS_MEDIA_TYPE,
  createErrorResponse,
  createInterchangeRegistry,
  createSigningKeysDocument
} from './interchange.mjs';
import {
  RECIPE_PACK_MEDIA_TYPE,
  RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE,
  createRecipePackPlan,
  createRecipePackSubmissionResponse
} from './recipe-pack.mjs';
import { createRecipePackExport } from './recipe-pack-export.mjs';
import { loadRecipeIndex } from './recipe-index.mjs';
import { repoRoot } from './config.mjs';
import { loadRecipes, recipesRoot as defaultRecipesRoot } from './recipes.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstQueryParam(searchParams, names) {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function listValues(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstList(...values) {
  for (const value of values) {
    const list = listValues(value);
    if (list.length) return list;
  }
  return [];
}

function queryValues(searchParams, names) {
  return [...new Set(names.flatMap((name) => searchParams.getAll(name)).flatMap(listValues))];
}

function numberParam(searchParams, names) {
  const value = firstQueryParam(searchParams, names);
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function hardwareDevicesFromQuery(searchParams) {
  const gpuCount = numberParam(searchParams, ['gpu_count', 'gpu-count', 'gpus']);
  const gpuMemoryGb = numberParam(searchParams, ['gpu_memory_gb', 'gpu-memory-gb', 'vram_gb', 'vram-gb']);
  const gpuVendors = queryValues(searchParams, ['gpu_vendor', 'gpu-vendor']);
  const gpuBackends = queryValues(searchParams, ['gpu_backend', 'gpu-backend']);
  const gpuNames = queryValues(searchParams, ['gpu_name', 'gpu-name']);
  const count = Math.max(
    Number.isInteger(gpuCount) ? gpuCount : 0,
    gpuVendors.length,
    gpuBackends.length,
    gpuNames.length,
    gpuMemoryGb == null ? 0 : 1
  );
  return Array.from({ length: count }, (_, index) => ({
    id: gpuBackends[index] ? `${gpuBackends[index]}:${index}` : `gpu:${index}`,
    kind: 'gpu',
    ...(gpuVendors[index] ? { vendor: gpuVendors[index] } : {}),
    ...(gpuNames[index] ? { name: gpuNames[index] } : {}),
    ...(gpuBackends[index] ? { backend: gpuBackends[index] } : {}),
    ...(gpuMemoryGb != null && index === 0 ? { memoryGb: gpuMemoryGb } : {})
  }));
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function errorBody(message, { status = 500, endpoint, ...extra } = {}) {
  return createErrorResponse(message, {
    status,
    host: {
      service: 'lloom-host',
      ...(endpoint ? { endpoint } : {})
    },
    ...extra
  });
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, errorBody(message, { status, ...extra }), {
    'content-type': `${ERROR_RESPONSE_MEDIA_TYPE}; charset=utf-8`
  });
}

function requestError(message, extra = {}) {
  const error = new Error(message);
  error.status = extra.status ?? 400;
  error.code = extra.code ?? 'bad_request';
  error.endpoint = extra.endpoint;
  error.validationErrors = extra.validationErrors;
  return error;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function machineProfileFromQuery(searchParams) {
  const platformId = firstQueryParam(searchParams, ['platform', 'platform_id', 'platform-id']);
  const [platform, arch] = platformId?.includes('-')
    ? platformId.split('-', 2)
    : [
        firstQueryParam(searchParams, ['os', 'platform_name', 'platform-name']),
        firstQueryParam(searchParams, ['arch'])
      ];
  const accelerators = queryValues(searchParams, ['accelerator', 'accelerators']);
  const devices = hardwareDevicesFromQuery(searchParams);
  return normalizeMachineProfile({
    platform: platform ?? process.platform,
    arch: arch ?? process.arch,
    platformId: platformId ?? `${platform ?? process.platform}-${arch ?? process.arch}`,
    totalMemoryGb: numberParam(searchParams, ['memory_gb', 'memory-gb', 'memory']),
    cpuBrand: firstQueryParam(searchParams, ['cpu', 'cpu_brand', 'cpu-brand']) ?? '',
    ...(accelerators.length ? { accelerators } : {}),
    ...(devices.length ? { devices } : {})
  });
}

function matchesText(value, query) {
  if (!query) return true;
  return String(value ?? '')
    .toLowerCase()
    .includes(query.toLowerCase());
}

function recipeSearchResult(indexEntry, recipe) {
  return {
    id: indexEntry.id,
    name: indexEntry.name ?? recipe?.name,
    summary: indexEntry.summary ?? recipe?.summary,
    tags: asArray(indexEntry.tags),
    recommendedFor: asArray(indexEntry.recommendedFor),
    capabilities: asArray(indexEntry.capabilities ?? recipe?.capabilities),
    source: indexEntry.source ?? null,
    requirements: recipe?.requirements ?? {},
    backend: recipe?.backend ?? null,
    models: asArray(recipe?.models).map((model) => ({
      role: model.role,
      model: model.model,
      gatewayModel: model.gatewayModel,
      capabilities: asArray(model.capabilities),
      settings: model.settings ?? {}
    }))
  };
}

function filterRecipes(index, recipeById, searchParams) {
  const q = firstQueryParam(searchParams, ['q', 'query']);
  const tag = firstQueryParam(searchParams, ['tag']);
  const capability = firstQueryParam(searchParams, ['capability']);
  const platform = firstQueryParam(searchParams, ['platform', 'platform_id', 'platform-id']);
  return asArray(index.recipes)
    .map((entry) => [entry, recipeById.get(entry.id)])
    .filter(([entry, recipe]) => {
      const tags = asArray(entry.tags);
      const capabilities = asArray(entry.capabilities ?? recipe?.capabilities);
      const platforms = asArray(recipe?.requirements?.platforms);
      const searchable = [
        entry.id,
        entry.name,
        entry.summary,
        recipe?.name,
        recipe?.summary,
        ...tags,
        ...capabilities
      ].join(' ');
      return (
        matchesText(searchable, q) &&
        (!tag || tags.includes(tag)) &&
        (!capability || capabilities.includes(capability)) &&
        (!platform || !platforms.length || platforms.includes(platform))
      );
    })
    .map(([entry, recipe]) => recipeSearchResult(entry, recipe));
}

function filterLeaderboard(results, searchParams) {
  const recipeId = firstQueryParam(searchParams, ['recipe', 'recipe_id', 'recipe-id']);
  const backendId = firstQueryParam(searchParams, ['backend', 'backend_id', 'backend-id']);
  const model = firstQueryParam(searchParams, ['model']);
  const platform = firstQueryParam(searchParams, ['platform', 'platform_id', 'platform-id']);
  const workloads = queryValues(searchParams, ['workload', 'workloads', 'use_case', 'use-case']);
  return benchmarkOverview(results)
    .filter((result) => !recipeId || result.recipeId === recipeId)
    .filter((result) => !backendId || result.backendId === backendId)
    .filter((result) => !model || result.model === model || result.gatewayModel === model)
    .filter((result) => !platform || result.machine?.platformId === platform)
    .filter((result) => !workloads.length || benchmarkMatchesWorkload(result, workloads));
}

function normalizedToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function tokenSet(values) {
  return new Set(asArray(values).map(normalizedToken).filter(Boolean));
}

function recipeTokens(recipe, indexEntry) {
  return tokenSet([
    recipe.id,
    recipe.name,
    recipe.backend?.id,
    ...asArray(recipe.keywords),
    ...asArray(recipe.capabilities),
    ...asArray(indexEntry?.tags),
    ...asArray(indexEntry?.capabilities),
    ...asArray(recipe.models).flatMap((model) => asArray(model.capabilities))
  ]);
}

function benchmarkWorkloadTokens(result) {
  const workload = result?.workload ?? {};
  return tokenSet([workload.type, workload.category, workload.useCase, workload.scenario, ...asArray(workload.tags)]);
}

function benchmarkMatchesWorkload(result, workloads) {
  if (!workloads.length) return true;
  const tokens = benchmarkWorkloadTokens(result);
  return listValues(workloads).some((workload) => tokens.has(normalizedToken(workload)));
}

function hardwareTokensFromDevices(devices) {
  return asArray(devices).flatMap((device) => [
    device?.vendor,
    device?.backend,
    device?.vendor && device?.kind ? `${device.vendor}-${device.kind}` : null,
    ...asArray(device?.accelerators)
  ]);
}

function profileHardwareTokens(profile) {
  return tokenSet([...asArray(profile?.accelerators), ...hardwareTokensFromDevices(profile?.devices)]);
}

function machineHardwareTokens(machine) {
  return tokenSet([...asArray(machine?.accelerators), ...hardwareTokensFromDevices(machine?.devices)]);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function setOverlap(left, right) {
  return [...left].filter((value) => right.has(value));
}

function benchmarkMachineMatch(result, profile = {}) {
  const machine = result?.machine ?? {};
  const profileTokens = profileHardwareTokens(profile);
  const machineTokens = machineHardwareTokens(machine);
  const acceleratorOverlap = setOverlap(profileTokens, machineTokens);
  const platformMatched = Boolean(
    machine.platformId && profile.platformId && machine.platformId === profile.platformId
  );
  const platformMismatched = Boolean(
    machine.platformId && profile.platformId && machine.platformId !== profile.platformId
  );
  const profileMemoryGb = finiteNumber(profile.totalMemoryGb);
  const machineMemoryGb = finiteNumber(machine.memoryGb);
  const memoryDeltaGb =
    profileMemoryGb != null && machineMemoryGb != null
      ? Math.round((profileMemoryGb - machineMemoryGb) * 10) / 10
      : null;
  let score = 0;
  if (platformMatched) score += 10000;
  if (platformMismatched) score -= 10000;
  if (profileTokens.size && machineTokens.size) {
    score += acceleratorOverlap.length * 500;
    if (!acceleratorOverlap.length) score -= 1000;
  }
  if (memoryDeltaGb != null) {
    score += Math.max(0, 100 - Math.abs(memoryDeltaGb));
    if (memoryDeltaGb < 0) score -= Math.min(500, Math.abs(memoryDeltaGb) * 5);
  }
  return {
    score,
    platformMatched,
    ...(platformMismatched ? { platformMismatched: true } : {}),
    acceleratorOverlap,
    memoryDeltaGb
  };
}

function recommendationFilters(searchParams) {
  return {
    workloads: queryValues(searchParams, ['workload', 'workloads', 'use_case', 'use-case']),
    capabilities: queryValues(searchParams, ['capability', 'capabilities']),
    tags: queryValues(searchParams, ['tag', 'tags'])
  };
}

function recommendationFiltersFromBody(body = {}) {
  const request = asObject(body.request);
  const filters = asObject(body.filters ?? request.filters);
  return {
    workloads: firstList(
      body.workloads,
      body.workload,
      request.workloads,
      request.workload,
      filters.workloads,
      filters.workload
    ),
    capabilities: firstList(
      body.capabilities,
      body.capability,
      request.capabilities,
      request.capability,
      filters.capabilities,
      filters.capability
    ),
    tags: firstList(body.tags, body.tag, request.tags, request.tag, filters.tags, filters.tag)
  };
}

function positiveInteger(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw requestError(`${label} must be a positive integer`);
  }
  return parsed;
}

function machineProfileFromBody(body = {}) {
  const source = body.machineProfile ?? body.machine_profile ?? body.profile;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw requestError('recommendation request body must include machineProfile');
  }
  const profile = normalizeMachineProfile(source);
  const errors = validateMachineProfile(profile);
  if (errors.length) {
    throw requestError(`machineProfile failed validation:\n${errors.map((error) => `- ${error}`).join('\n')}`, {
      validationErrors: errors
    });
  }
  return profile;
}

function isRecommendationRequestDocument(body = {}, req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  return (
    body.$schema === RECOMMENDATION_REQUEST_SCHEMA ||
    contentType.includes(RECOMMENDATION_REQUEST_MEDIA_TYPE) ||
    body.schemaVersion != null
  );
}

function validateRecommendationRequestBody(body = {}, req) {
  if (!isRecommendationRequestDocument(body, req)) return;
  const errors = validateRecommendationRequest(body);
  if (errors.length) {
    throw requestError(`recommendation request failed validation:\n${errors.map((error) => `- ${error}`).join('\n')}`, {
      validationErrors: errors
    });
  }
}

function recipeMatchesFilters(recipe, indexEntry, filters) {
  const tokens = recipeTokens(recipe, indexEntry);
  return (
    listValues(filters.capabilities).every((capability) => tokens.has(normalizedToken(capability))) &&
    listValues(filters.tags).every((tag) => tokens.has(normalizedToken(tag))) &&
    (!filters.workloads.length ||
      listValues(filters.workloads).some((workload) => tokens.has(normalizedToken(workload))))
  );
}

function benchmarkResultsForRecipe(recipe, benchmarkEvidence, filters = {}, profile = {}) {
  const models = new Set(asArray(recipe.models).flatMap((model) => [model.model, model.gatewayModel].filter(Boolean)));
  const matching = benchmarkEvidence
    .filter((result) => result.recipeId === recipe.id)
    .filter((result) => models.has(result.model) || models.has(result.gatewayModel))
    .filter((result) => benchmarkMatchesWorkload(result, filters.workloads ?? []));
  const candidates = matching.length
    ? matching
    : benchmarkEvidence
        .filter((result) => result.recipeId === recipe.id)
        .filter((result) => models.has(result.model) || models.has(result.gatewayModel));
  return candidates.sort((left, right) => {
    const leftMachineScore = benchmarkMachineMatch(left, profile).score;
    const rightMachineScore = benchmarkMachineMatch(right, profile).score;
    if (leftMachineScore !== rightMachineScore) return rightMachineScore - leftMachineScore;
    return benchmarkScore(right) - benchmarkScore(left);
  });
}

function bestBenchmarkResult(recipe, benchmarkEvidence, filters = {}, profile = {}) {
  return benchmarkResultsForRecipe(recipe, benchmarkEvidence, filters, profile)[0] ?? null;
}

function benchmarkSelectionSummary(result, profile) {
  if (!result) return null;
  return {
    id: result.id,
    suiteId: result.suite?.id ?? null,
    source: result.suite?.source ?? null,
    submittedAt: result.suite?.submittedAt ?? null,
    backendId: result.backendId,
    model: result.model,
    gatewayModel: result.gatewayModel ?? null,
    machine: result.machine ?? {},
    workload: result.workload ?? {},
    settings: result.settings ?? {},
    metrics: result.metrics ?? {},
    score: benchmarkScore(result),
    ...(profile ? { machineMatch: benchmarkMachineMatch(result, profile) } : {})
  };
}

async function createRecommendationDocument(
  config,
  options,
  { profile, filters, limit = 1, endpoint = '/v1/recipe-packs/recommended' } = {}
) {
  const index = await loadRecipeIndex(options.indexPath);
  const indexEntryById = new Map(asArray(index.recipes).map((entry) => [entry.id, entry]));
  const recipes = await loadRecipes(options.recipesRoot);
  const evidence = await loadBenchmarkEvidence(options.benchmarksRoot);
  const evaluations = [];
  for (const recipe of recipes) {
    const indexEntry = indexEntryById.get(recipe.id);
    const evaluation = await evaluateRecipe(recipe, profile, { checkCommands: false });
    const matchesFilters = recipeMatchesFilters(recipe, indexEntry, filters);
    const bestBenchmark = bestBenchmarkResult(recipe, evidence, filters, profile);
    const bestBenchmarkScore = bestBenchmark ? benchmarkScore(bestBenchmark) : 0;
    evaluations.push({
      recipe,
      indexEntry,
      evaluation,
      matchesFilters,
      bestBenchmark,
      benchmarkScore: bestBenchmarkScore
    });
  }
  const selected = evaluations
    .filter((entry) => entry.evaluation.selectable)
    .filter((entry) => entry.matchesFilters)
    .sort((left, right) => {
      if (left.benchmarkScore !== right.benchmarkScore) return right.benchmarkScore - left.benchmarkScore;
      if (left.evaluation.score !== right.evaluation.score) return right.evaluation.score - left.evaluation.score;
      return String(left.recipe.name).localeCompare(String(right.recipe.name));
    })
    .slice(0, limit);
  const recommendations = [];
  for (const entry of selected) {
    recommendations.push({
      id: `${entry.recipe.id}-pack`,
      recipeId: entry.recipe.id,
      summary: entry.recipe.summary ?? null,
      score: entry.benchmarkScore + entry.evaluation.score,
      request: {
        workloads: filters.workloads,
        capabilities: filters.capabilities,
        tags: filters.tags
      },
      evaluation: {
        ...entry.evaluation,
        selection: {
          totalScore: entry.benchmarkScore + entry.evaluation.score,
          compatibilityScore: entry.evaluation.score,
          benchmarkScore: entry.benchmarkScore,
          filters,
          matchedTags: asArray(entry.indexEntry?.tags),
          matchedCapabilities: asArray(entry.indexEntry?.capabilities ?? entry.recipe.capabilities),
          ranking:
            'requested workload/capability/tag filters, then machine-matched benchmarkScore desc, compatibilityScore desc, recipe name asc'
        }
      },
      benchmark: benchmarkSelectionSummary(entry.bestBenchmark, profile),
      pack: await packForRecipe(config, entry.recipe.id, options)
    });
  }
  const response = buildRecommendationResponse({
    id: 'lloom-host-recommendations',
    name: 'LLooM Host Recipe Recommendations',
    machineProfile: profile,
    recommendations,
    provenance: {
      generatedBy: 'lloom-host',
      source: 'local recipe index and benchmark evidence'
    },
    request: {
      filters
    }
  });
  const validationErrors = validateRecommendationResponse(response);
  if (validationErrors.length) {
    const error = new Error('generated recommendation response is invalid');
    error.code = 'internal_error';
    error.status = 500;
    error.endpoint = endpoint;
    error.validationErrors = validationErrors;
    throw error;
  }
  return response;
}

function resolveRepoPath(value, fallback) {
  const selected = value ?? fallback;
  if (!selected) return undefined;
  return path.isAbsolute(selected) ? selected : path.resolve(repoRoot, selected);
}

async function maybeReadFile(filePath) {
  if (!filePath) return undefined;
  return fs.readFile(path.resolve(filePath), 'utf8');
}

function exportPem(key, type) {
  return key.export({ type, format: 'pem' });
}

function createEphemeralSigningKey(keyId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: keyId ?? 'lloom-ephemeral-dev',
    privateKey: exportPem(privateKey, 'pkcs8'),
    publicKey: exportPem(publicKey, 'spki'),
    ephemeral: true
  };
}

function resolveSigningKey({ keyId, privateKeyPath, publicKeyPath } = {}) {
  const hasPrivateKeyPath = Boolean(privateKeyPath && existsSync(privateKeyPath));
  const hasPublicKeyPath = Boolean(publicKeyPath && existsSync(publicKeyPath));
  if (hasPrivateKeyPath) {
    return {
      keyId,
      privateKeyPath,
      publicKeyPath: hasPublicKeyPath ? publicKeyPath : undefined,
      ephemeral: false
    };
  }
  return createEphemeralSigningKey(keyId);
}

function safeFileName(value) {
  return (
    String(value ?? 'benchmark-suite')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160) || 'benchmark-suite'
  );
}

async function persistBenchmarkSuites(suites, submissionsRoot) {
  if (!submissionsRoot) return [];
  const root = path.resolve(submissionsRoot);
  await fs.mkdir(root, { recursive: true });
  const persisted = [];
  for (const suite of suites) {
    const fileName = `${safeFileName(suite.id)}.json`;
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, `${JSON.stringify(suite, null, 2)}\n`);
    persisted.push({
      id: suite.id,
      status: 'persisted',
      fileName,
      path: filePath
    });
  }
  return persisted;
}

async function persistRecipePack(pack, submissionsRoot) {
  if (!submissionsRoot) return [];
  const root = path.join(path.resolve(submissionsRoot), 'recipe-packs');
  await fs.mkdir(root, { recursive: true });
  const fileName = `${safeFileName(pack.id ?? 'recipe-pack')}.json`;
  const filePath = path.join(root, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(pack, null, 2)}\n`);
  return [
    {
      id: pack.id ?? null,
      status: 'persisted',
      recipeCount: asArray(pack.recipes).length,
      benchmarkCount: asArray(pack.recipes).reduce((sum, entry) => sum + asArray(entry?.benchmarks).length, 0),
      fileName,
      path: filePath
    }
  ];
}

async function packForRecipe(
  config,
  recipeId,
  {
    indexPath,
    recipesRoot,
    benchmarksRoot,
    publisher,
    keyId,
    privateKey,
    publicKey,
    privateKeyPath,
    publicKeyPath
  } = {}
) {
  const exportPlan = await createRecipePackExport(config, {
    recipeIds: [recipeId],
    indexPath,
    recipesRoot,
    benchmarksRoot,
    id: `${recipeId}-pack`,
    name: `${recipeId} recipe pack`,
    publisher,
    ...(privateKey || privateKeyPath
      ? {
          keyId,
          privateKey,
          publicKey,
          privateKeyPath,
          publicKeyPath
        }
      : {})
  });
  return exportPlan.document;
}

async function signedKeyMetadata({ keyId, publicKey, publicKeyPath, ephemeral } = {}) {
  const resolvedPublicKey = publicKey ?? (await maybeReadFile(publicKeyPath));
  return resolvedPublicKey
    ? [
        {
          keyId: keyId ?? 'default',
          algorithm: 'ed25519',
          publicKey: resolvedPublicKey,
          status: 'active',
          ...(ephemeral ? { ephemeral: true } : {})
        }
      ]
    : [];
}

async function hostDataSummary(options) {
  const [catalog, recipes, evidence] = await Promise.all([
    loadBackendCatalog(options.backendCatalogPath),
    loadRecipes(options.recipesRoot),
    loadBenchmarkEvidence(options.benchmarksRoot)
  ]);
  return {
    backendCount: asArray(catalog.backends).length,
    recipeCount: recipes.length,
    benchmarkCount: evidence.length,
    leaderboardCount: benchmarkOverview(evidence).length
  };
}

export function createLloomHostServer(
  config,
  {
    host = '127.0.0.1',
    port = 8110,
    indexPath,
    recipesRoot,
    benchmarksRoot,
    backendCatalogPath,
    submissionsRoot,
    publisher,
    keyId,
    privateKeyPath,
    publicKeyPath
  } = {}
) {
  const hostData = config.communityHost ?? {};
  const selectedRecipesRoot = resolveRepoPath(recipesRoot, hostData.recipesRoot ?? defaultRecipesRoot);
  const selectedBenchmarksRoot = resolveRepoPath(benchmarksRoot, hostData.benchmarksRoot ?? defaultBenchmarksRoot);
  const selectedIndexPath = resolveRepoPath(
    indexPath,
    hostData.indexPath ?? path.join(selectedRecipesRoot, 'index.json')
  );
  const selectedBackendCatalogPath = resolveRepoPath(
    backendCatalogPath,
    hostData.backendCatalogPath ?? defaultBackendCatalogPath
  );
  const selectedPublisher = publisher ?? hostData.publisher ?? 'lloom-host';
  const selectedKeyId = keyId ?? hostData.keyId;
  const selectedPrivateKeyPath = resolveRepoPath(privateKeyPath, hostData.privateKeyPath);
  const selectedPublicKeyPath = resolveRepoPath(publicKeyPath, hostData.publicKeyPath);
  const signingKey = resolveSigningKey({
    keyId: selectedKeyId,
    privateKeyPath: selectedPrivateKeyPath,
    publicKeyPath: selectedPublicKeyPath
  });
  const options = {
    indexPath: selectedIndexPath,
    recipesRoot: selectedRecipesRoot,
    benchmarksRoot: selectedBenchmarksRoot,
    backendCatalogPath: selectedBackendCatalogPath,
    submissionsRoot,
    publisher: selectedPublisher,
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
    publicKey: signingKey.publicKey,
    privateKeyPath: signingKey.privateKeyPath,
    publicKeyPath: signingKey.publicKeyPath,
    ephemeral: signingKey.ephemeral
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        sendJson(res, 200, {
          ok: true,
          service: 'lloom-host',
          version: 1,
          data: await hostDataSummary(options)
        });
        return;
      }

      if (
        req.method === 'GET' &&
        (url.pathname === '/v1/interchange' || url.pathname === '/.well-known/lloom-interchange')
      ) {
        sendJson(
          res,
          200,
          createInterchangeRegistry({
            serviceUrl: `${url.protocol}//${url.host}`
          }),
          {
            'content-type': `${INTERCHANGE_REGISTRY_MEDIA_TYPE}; charset=utf-8`
          }
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/keys') {
        sendJson(
          res,
          200,
          createSigningKeysDocument(await signedKeyMetadata(options), {
            id: `${selectedPublisher}-signing-keys`,
            name: `${selectedPublisher} Signing Keys`,
            publisher: {
              id: selectedPublisher,
              name: selectedPublisher
            },
            provenance: {
              generatedBy: 'lloom-host',
              source: options.ephemeral ? 'process-local ephemeral key' : 'configured public key'
            }
          }),
          {
            'content-type': `${SIGNING_KEYS_MEDIA_TYPE}; charset=utf-8`
          }
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/backends') {
        const catalog = await loadBackendCatalog(options.backendCatalogPath);
        const validationErrors = validateBackendCatalog(catalog);
        sendJson(res, 200, {
          ok: validationErrors.length === 0,
          schemaVersion: catalog.schemaVersion,
          id: catalog.id ?? null,
          name: catalog.name ?? null,
          validationErrors,
          count: catalog.backends.length,
          data: catalog.backends.map((backend) => ({
            id: backend.id,
            name: backend.name,
            kind: backend.kind,
            description: backend.description,
            platforms: backend.platforms ?? [],
            features: backend.features ?? [],
            commands: backend.commands ?? [],
            server: backend.server ?? null
          }))
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/backends/catalog') {
        const catalog = await loadBackendCatalog(options.backendCatalogPath);
        sendJson(res, 200, catalog, {
          'content-type': `${INTERCHANGE_MEDIA_TYPES.backendCatalog}; charset=utf-8`
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/recipes') {
        const index = await loadRecipeIndex(options.indexPath);
        const recipes = await loadRecipes(options.recipesRoot);
        const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
        const data = filterRecipes(index, recipeById, url.searchParams);
        sendJson(res, 200, {
          schemaVersion: 1,
          count: data.length,
          data
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/leaderboard') {
        const evidence = await loadBenchmarkEvidence(options.benchmarksRoot);
        const data = filterLeaderboard(evidence, url.searchParams);
        sendJson(res, 200, {
          schemaVersion: 1,
          count: data.length,
          data
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/recipe-packs/recommended') {
        const profile = machineProfileFromQuery(url.searchParams);
        const limit = positiveInteger(numberParam(url.searchParams, ['limit']), 1, 'limit');
        const filters = recommendationFilters(url.searchParams);
        sendJson(
          res,
          200,
          await createRecommendationDocument(config, options, {
            profile,
            filters,
            limit,
            endpoint: '/v1/recipe-packs/recommended'
          }),
          {
            'content-type': `${RECOMMENDATION_RESPONSE_MEDIA_TYPE}; charset=utf-8`
          }
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/recipe-packs/recommended') {
        const body = await readJson(req);
        validateRecommendationRequestBody(body, req);
        const profile = machineProfileFromBody(body);
        const limit = positiveInteger(body.limit ?? body.request?.limit, 1, 'limit');
        const filters = recommendationFiltersFromBody(body);
        sendJson(
          res,
          200,
          await createRecommendationDocument(config, options, {
            profile,
            filters,
            limit,
            endpoint: '/v1/recipe-packs/recommended'
          }),
          {
            'content-type': `${RECOMMENDATION_RESPONSE_MEDIA_TYPE}; charset=utf-8`
          }
        );
        return;
      }

      const packMatch = url.pathname.match(/^\/v1\/recipe-packs\/([^/]+)$/);
      if (req.method === 'GET' && packMatch) {
        const packId = decodeURIComponent(packMatch[1]);
        const recipeId = packId.endsWith('-pack') ? packId.slice(0, -5) : packId;
        const recipes = await loadRecipes(options.recipesRoot);
        if (!recipes.some((recipe) => recipe.id === recipeId)) {
          sendError(res, 404, `unknown recipe pack ${packId}`, {
            code: 'not_found',
            endpoint: url.pathname
          });
          return;
        }
        sendJson(res, 200, await packForRecipe(config, recipeId, options), {
          'content-type': `${RECIPE_PACK_MEDIA_TYPE}; charset=utf-8`
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/benchmarks') {
        const body = await readJson(req);
        const suites = Array.isArray(body) ? body : Array.isArray(body.suites) ? body.suites : [body];
        const validationErrors = suites.flatMap((suite) => validateBenchmarkSuite(suite));
        const submissions = validationErrors.length
          ? suites.map((suite) => ({
              id: suite?.id ?? null,
              status: 'rejected'
            }))
          : await persistBenchmarkSuites(suites, options.submissionsRoot);
        sendJson(
          res,
          validationErrors.length ? 400 : 202,
          createBenchmarkSubmissionResponse({
            accepted: validationErrors.length === 0,
            persisted: validationErrors.length === 0 && Boolean(options.submissionsRoot),
            validationErrors,
            submissions: submissions.length
              ? submissions
              : suites.map((suite) => ({
                  id: suite?.id ?? null,
                  status: validationErrors.length ? 'rejected' : 'validated'
                })),
            host: {
              service: 'lloom-host',
              endpoint: '/v1/benchmarks'
            },
            message: validationErrors.length
              ? 'benchmark submission failed validation'
              : options.submissionsRoot
                ? 'benchmark submission accepted and persisted for review'
                : 'benchmark submission validated; persistence is not configured in the static host'
          }),
          {
            'content-type': `${BENCHMARK_SUBMISSION_RESPONSE_MEDIA_TYPE}; charset=utf-8`
          }
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/recipe-packs') {
        const body = await readJson(req);
        const plan = await createRecipePackPlan(body, config, {
          indexPath: options.indexPath,
          recipesRoot: options.recipesRoot,
          benchmarksRoot: options.benchmarksRoot,
          requireSignature: false
        });
        const validationErrors = plan.validationErrors ?? [];
        const submissions = validationErrors.length
          ? [
              {
                id: body?.id ?? null,
                status: 'rejected',
                recipeCount: Array.isArray(body?.recipes) ? body.recipes.length : 0,
                benchmarkCount: Array.isArray(body?.recipes)
                  ? body.recipes.reduce((sum, entry) => sum + asArray(entry?.benchmarks).length, 0)
                  : 0
              }
            ]
          : await persistRecipePack(body, options.submissionsRoot);
        sendJson(
          res,
          validationErrors.length ? 400 : 202,
          createRecipePackSubmissionResponse({
            accepted: validationErrors.length === 0,
            persisted: validationErrors.length === 0 && Boolean(options.submissionsRoot),
            validationErrors,
            submissions: submissions.length
              ? submissions
              : [
                  {
                    id: body?.id ?? null,
                    status: validationErrors.length ? 'rejected' : 'validated',
                    recipeCount: plan.pack?.recipeCount ?? 0,
                    benchmarkCount: plan.pack?.benchmarkCount ?? 0
                  }
                ],
            host: {
              service: 'lloom-host',
              endpoint: '/v1/recipe-packs'
            },
            message: validationErrors.length
              ? 'recipe pack submission failed validation'
              : options.submissionsRoot
                ? 'recipe pack accepted and persisted for review'
                : 'recipe pack validated; persistence is not configured in the static host'
          }),
          {
            'content-type': `${RECIPE_PACK_SUBMISSION_RESPONSE_MEDIA_TYPE}; charset=utf-8`
          }
        );
        return;
      }

      sendError(res, 404, `not found: ${url.pathname}`, {
        code: 'not_found',
        endpoint: url.pathname
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendError(res, status, error?.message ?? String(error), {
        code: error?.code ?? (status >= 500 ? 'internal_error' : 'bad_request'),
        ...(error?.endpoint ? { endpoint: error.endpoint } : {}),
        ...(error?.validationErrors ? { validationErrors: error.validationErrors } : {})
      });
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return this;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
