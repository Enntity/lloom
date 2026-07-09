import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repoRoot } from './config.mjs';
import { normalizeMachineProfile, profileMachine } from './machine-profile.mjs';
import {
  INTERCHANGE_PROFILE,
  RECOMMENDATION_REQUEST_MEDIA_TYPE,
  RECOMMENDATION_REQUEST_SCHEMA,
  RECOMMENDATION_RESPONSE_MEDIA_TYPE,
  RECOMMENDATION_RESPONSE_SCHEMA,
  validateRecommendationResponse
} from './machine-profile.mjs';
import { SIGNING_KEYS_MEDIA_TYPE, validateSigningKeysDocument } from './interchange.mjs';
import { applyRecipePack, createRecipePackPlan } from './recipe-pack.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOCAL_AUTOSTART_FAILURE_CODES = new Set(['ECONNREFUSED']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
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

function appendListParams(searchParams, name, values) {
  for (const value of listValues(values)) searchParams.append(name, value);
}

function profileDevices(profile) {
  return Array.isArray(profile?.devices)
    ? profile.devices.filter((device) => device && typeof device === 'object')
    : [];
}

function profileGpuDevices(profile) {
  return profileDevices(profile).filter((device) => String(device.kind ?? '').toLowerCase() === 'gpu');
}

function appendProfileHardwareParams(searchParams, profile) {
  appendListParams(searchParams, 'accelerator', profile?.accelerators);
  const gpuDevices = profileGpuDevices(profile);
  if (!gpuDevices.length) return;
  searchParams.set('gpu_count', String(gpuDevices.length));
  const memoryValues = gpuDevices.map((device) => Number(device.memoryGb)).filter((value) => Number.isFinite(value));
  if (memoryValues.length) searchParams.set('gpu_memory_gb', String(Math.max(...memoryValues)));
  appendListParams(
    searchParams,
    'gpu_vendor',
    gpuDevices.map((device) => device.vendor)
  );
  appendListParams(
    searchParams,
    'gpu_backend',
    gpuDevices.map((device) => device.backend)
  );
  appendListParams(
    searchParams,
    'gpu_name',
    gpuDevices.map((device) => device.name)
  );
}

function firstList(...values) {
  for (const value of values) {
    const list = listValues(value);
    if (list.length) return list;
  }
  return [];
}

function recommendationUrl({ hostUrl, recipeFeedPath = '/v1/recipe-packs/recommended' }) {
  if (!hostUrl) throw new Error('community.hostUrl is not configured');
  return new URL(`${stripTrailingSlash(hostUrl)}${recipeFeedPath.startsWith('/') ? '' : '/'}${recipeFeedPath}`);
}

function legacyRecommendationUrl(
  { hostUrl, recipeFeedPath = '/v1/recipe-packs/recommended', limit, workloads, capabilities, tags },
  profile
) {
  const url = recommendationUrl({ hostUrl, recipeFeedPath });
  if (profile?.platformId) url.searchParams.set('platform', profile.platformId);
  if (profile?.arch) url.searchParams.set('arch', profile.arch);
  if (profile?.totalMemoryGb != null) url.searchParams.set('memory_gb', String(profile.totalMemoryGb));
  if (profile?.cpuBrand) url.searchParams.set('cpu', profile.cpuBrand);
  appendProfileHardwareParams(url.searchParams, profile);
  if (limit != null) url.searchParams.set('limit', String(limit));
  appendListParams(url.searchParams, 'workload', workloads);
  appendListParams(url.searchParams, 'capability', capabilities);
  appendListParams(url.searchParams, 'tag', tags);
  return url;
}

function recommendationRequestDocument(effective, profile) {
  const filters = {
    workloads: listValues(effective.workloads),
    capabilities: listValues(effective.capabilities),
    tags: listValues(effective.tags)
  };
  return {
    $schema: RECOMMENDATION_REQUEST_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: `recommend-${profile.id ?? profile.platformId ?? 'machine'}`,
    machineProfile: profile,
    request: { filters },
    ...(effective.limit != null ? { limit: Number(effective.limit) } : {})
  };
}

function hostPathUrl(hostUrl, routePath) {
  if (!hostUrl) return undefined;
  return `${stripTrailingSlash(hostUrl)}${routePath.startsWith('/') ? '' : '/'}${routePath}`;
}

function hostPathURL(hostUrl, routePath) {
  const url = hostPathUrl(hostUrl, routePath);
  return url ? new URL(url) : null;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function parsedHostUrl(hostUrl) {
  try {
    return new URL(hostUrl);
  } catch {
    return null;
  }
}

function hostPort(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === 'http:') return 80;
  if (url.protocol === 'https:') return 443;
  return null;
}

function resolveRepoPath(value) {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

export function isLoopbackCommunityHost(hostUrl) {
  const url = parsedHostUrl(hostUrl);
  return Boolean(url && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.port);
}

function fetchFailureCode(error) {
  return error?.cause?.code ?? error?.code ?? null;
}

function shouldAutoStartLocalHost(hostUrl, error, { autoStartLocalHost = true } = {}) {
  return (
    autoStartLocalHost !== false &&
    isLoopbackCommunityHost(hostUrl) &&
    LOCAL_AUTOSTART_FAILURE_CODES.has(fetchFailureCode(error))
  );
}

function communityFetchError(url, error) {
  const code = fetchFailureCode(error);
  const detail = code ? `${code}: ${error.message}` : error.message;
  return new Error(`community host request failed for ${url.toString()}: ${detail}`, { cause: error });
}

export function localHostServeCommand(
  config,
  { hostUrl, indexPath, recipesRoot, benchmarksRoot, backendCatalogPath } = {}
) {
  const hostData = asObject(config.communityHost);
  const url = parsedHostUrl(hostUrl);
  if (!url) throw new Error(`invalid community host URL ${hostUrl}`);
  const host = url.hostname === '::1' ? '::1' : url.hostname;
  const port = hostPort(url);
  const args = [path.join(repoRoot, 'bin', 'lloom-host.mjs'), 'serve', '--host', host, '--port', String(port)];
  if (config.sourcePath) args.push('--config', config.sourcePath);
  const selectedIndexPath = resolveRepoPath(indexPath ?? hostData.indexPath);
  const selectedRecipesRoot = resolveRepoPath(recipesRoot ?? hostData.recipesRoot);
  const selectedBenchmarksRoot = resolveRepoPath(benchmarksRoot ?? hostData.benchmarksRoot);
  const selectedBackendCatalogPath = resolveRepoPath(
    backendCatalogPath && !isHttpUrl(backendCatalogPath) ? backendCatalogPath : hostData.backendCatalogPath
  );
  if (selectedIndexPath) args.push('--index', selectedIndexPath);
  if (selectedRecipesRoot) args.push('--recipes-root', selectedRecipesRoot);
  if (selectedBenchmarksRoot) args.push('--benchmarks-root', selectedBenchmarksRoot);
  if (selectedBackendCatalogPath) args.push('--backend-catalog', selectedBackendCatalogPath);
  return {
    command: process.execPath,
    args,
    cwd: repoRoot,
    url: `${url.protocol}//${url.host}`,
    host,
    port
  };
}

async function waitForLocalHostHealth(baseUrl, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(1000, timeoutMs))
      });
      if (response.ok) return response.json().catch(() => ({}));
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${baseUrl}/health${lastError ? `: ${lastError.message}` : ''}`);
}

async function startLocalRecommendationHost(config, effective) {
  const planned = localHostServeCommand(config, {
    hostUrl: effective.hostUrl,
    indexPath: effective.localHostIndexPath,
    recipesRoot: effective.localHostRecipesRoot,
    benchmarksRoot: effective.localHostBenchmarksRoot,
    backendCatalogPath: effective.localHostBackendCatalogPath
  });
  const child = spawn(planned.command, planned.args, {
    cwd: planned.cwd,
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', () => {});
  child.unref();
  const health = await waitForLocalHostHealth(planned.url, {
    timeoutMs: effective.localHostStartupTimeoutMs ?? 5000
  });
  return {
    pid: child.pid ?? null,
    url: planned.url,
    command: [planned.command, ...planned.args],
    health
  };
}

function packSourceFromRecommendation(recommendation) {
  if (typeof recommendation === 'string') return { id: recommendation, source: recommendation, kind: 'url' };
  if (!recommendation || typeof recommendation !== 'object') {
    throw new Error('community recommendation must be a URL, pack object, or object with url/source/pack');
  }
  if (recommendation.schemaVersion === 1 && Array.isArray(recommendation.recipes)) {
    return {
      id: recommendation.id ?? null,
      source: recommendation,
      kind: 'inline-pack'
    };
  }
  const source = recommendation.url ?? recommendation.source ?? recommendation.href;
  const metadata = {
    recipeId: recommendation.recipeId ?? null,
    summary: recommendation.summary ?? null,
    score: recommendation.score ?? null,
    request: recommendation.request ?? null,
    evaluation: recommendation.evaluation ?? null,
    benchmark: recommendation.benchmark ?? null
  };
  if (source) {
    return {
      id: recommendation.id ?? source,
      source,
      kind: 'url',
      ...metadata
    };
  }
  if (recommendation.pack) {
    return {
      id: recommendation.id ?? recommendation.pack.id ?? null,
      source: recommendation.pack,
      kind: 'inline-pack',
      ...metadata
    };
  }
  throw new Error('community recommendation is missing url, source, href, or pack');
}

function normalizeRecommendations(payload) {
  if (payload?.schemaVersion === 1 && Array.isArray(payload.recipes)) return [packSourceFromRecommendation(payload)];
  const values =
    payload?.packs ?? payload?.recipePacks ?? payload?.recommendations ?? payload?.data ?? payload?.packUrls;
  if (values) return (Array.isArray(values) ? values : [values]).map(packSourceFromRecommendation);
  if (payload?.pack || payload?.url || payload?.source || payload?.href) return [packSourceFromRecommendation(payload)];
  throw new Error('community response must contain packs, recipePacks, recommendations, data, packUrls, pack, or url');
}

function validateStandardRecommendationPayload(payload) {
  if (payload?.$schema !== RECOMMENDATION_RESPONSE_SCHEMA) return;
  const validationErrors = validateRecommendationResponse(payload);
  if (validationErrors.length) {
    throw new Error(
      `community recommendation response failed validation:\n${validationErrors.map((error) => `- ${error}`).join('\n')}`
    );
  }
}

function communityOptions(config, options = {}) {
  const community = asObject(config.community);
  const trustedKeys = options.trustedKeys ?? community.trustedKeys ?? [];
  const hostUrl = options.hostUrl ?? community.hostUrl;
  return {
    hostUrl,
    recipeFeedPath: options.recipeFeedPath ?? community.recipeFeedPath ?? '/v1/recipe-packs/recommended',
    signingKeysPath: options.signingKeysPath ?? community.signingKeysPath ?? '/v1/keys',
    indexPath: options.indexPath,
    recipesRoot: options.recipesRoot,
    benchmarksRoot: options.benchmarksRoot,
    trustedKeys: Array.isArray(trustedKeys) ? trustedKeys : [trustedKeys].filter(Boolean),
    trustHostKeys: options.trustHostKeys ?? community.trustHostKeys ?? true,
    requireSignature: options.requireSignature ?? community.requireSignedPacks ?? false,
    timeoutMs: options.timeoutMs ?? community.timeoutMs ?? 30000,
    limit: options.limit ?? 1,
    workloads: firstList(options.workloads, options.workload, community.workloads, community.workload),
    capabilities: firstList(options.capabilities, options.capability, community.capabilities, community.capability),
    tags: firstList(options.tags, options.tag, community.tags, community.tag),
    autoStartLocalHost: options.autoStartLocalHost ?? community.autoStartLocalHost ?? true,
    localHostStartupTimeoutMs: options.localHostStartupTimeoutMs ?? community.localHostStartupTimeoutMs ?? 5000,
    backendCatalogPath:
      options.backendCatalogPath ?? community.backendCatalogPath ?? hostPathUrl(hostUrl, '/v1/backends/catalog')
  };
}

function normalizeHostSigningKeys(payload) {
  const validationErrors =
    payload?.$schema || payload?.schemaVersion || payload?.id ? validateSigningKeysDocument(payload) : [];
  if (validationErrors.length) {
    throw new Error(
      `community signing keys failed validation:\n${validationErrors.map((error) => `- ${error}`).join('\n')}`
    );
  }
  const keys = Array.isArray(payload?.data) ? payload.data : [];
  return keys
    .filter((key) => key?.keyId && key?.publicKey)
    .filter((key) => !['retired', 'revoked'].includes(String(key.status ?? 'active').toLowerCase()))
    .map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicKey,
      ...(key.algorithm ? { algorithm: key.algorithm } : {}),
      ...(key.status ? { status: key.status } : {}),
      ...(key.ephemeral ? { ephemeral: true } : {})
    }));
}

async function fetchHostSigningKeys(effective) {
  if (!effective.trustHostKeys || !effective.hostUrl || !effective.signingKeysPath) {
    return {
      enabled: Boolean(effective.trustHostKeys),
      status: 'disabled',
      keys: []
    };
  }
  const url = hostPathURL(effective.hostUrl, effective.signingKeysPath);
  try {
    const response = await fetch(url, {
      headers: {
        accept: `${SIGNING_KEYS_MEDIA_TYPE}, application/json`
      },
      signal: AbortSignal.timeout(effective.timeoutMs)
    });
    if (!response.ok) {
      return {
        enabled: true,
        status: 'unavailable',
        statusCode: response.status,
        url: url.toString(),
        keys: []
      };
    }
    const payload = await response.json();
    const keys = normalizeHostSigningKeys(payload);
    return {
      enabled: true,
      status: keys.length ? 'loaded' : 'empty',
      url: url.toString(),
      keyCount: keys.length,
      keyIds: keys.map((key) => key.keyId),
      ephemeral: keys.some((key) => key.ephemeral),
      keys
    };
  } catch (error) {
    return {
      enabled: true,
      status: 'error',
      url: url.toString(),
      error: error?.message ?? String(error),
      keys: []
    };
  }
}

function combinedTrustedKeys(effective, signingKeys) {
  return [...effective.trustedKeys, ...asArray(signingKeys?.keys)];
}

const LEGACY_GET_FALLBACK_STATUSES = new Set([404, 405, 415, 501]);

async function fetchRecommendationResponseByGet(url, effective) {
  const response = await fetch(url, {
    headers: {
      accept: `${RECOMMENDATION_RESPONSE_MEDIA_TYPE}, application/json`
    },
    signal: AbortSignal.timeout(effective.timeoutMs)
  });
  if (!response.ok) throw new Error(`community recommendation request failed: HTTP ${response.status}`);
  return response;
}

async function fetchRecommendationResponseByPost(url, request, effective) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': RECOMMENDATION_REQUEST_MEDIA_TYPE,
      accept: `${RECOMMENDATION_RESPONSE_MEDIA_TYPE}, application/json`
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(effective.timeoutMs)
  });
  if (!response.ok) throw new Error(`community recommendation request failed: HTTP ${response.status}`);
  return response;
}

async function fetchRecommendationResponse(url, fallbackUrl, request, effective) {
  try {
    const response = await fetchRecommendationResponseByPost(url, request, effective);
    return {
      response,
      method: 'POST',
      requestUrl: url.toString(),
      request
    };
  } catch (error) {
    const status = Number(String(error.message ?? '').match(/HTTP (\d+)/)?.[1]);
    if (!LEGACY_GET_FALLBACK_STATUSES.has(status)) throw error;
    const response = await fetchRecommendationResponseByGet(fallbackUrl, effective);
    return {
      response,
      method: 'GET',
      requestUrl: fallbackUrl.toString(),
      request,
      fallbackFromStatus: status
    };
  }
}

export async function fetchCommunityRecommendations(config, { profile, ...options } = {}) {
  const effective = communityOptions(config, options);
  const machineProfile = normalizeMachineProfile(profile ?? (await profileMachine()));
  const url = recommendationUrl(effective, machineProfile);
  const fallbackUrl = legacyRecommendationUrl(effective, machineProfile);
  const request = recommendationRequestDocument(effective, machineProfile);
  let autoStartedHost = null;
  let fetched;
  try {
    fetched = await fetchRecommendationResponse(url, fallbackUrl, request, effective);
  } catch (error) {
    if (!shouldAutoStartLocalHost(effective.hostUrl, error, effective)) throw communityFetchError(url, error);
    autoStartedHost = await startLocalRecommendationHost(config, effective);
    try {
      fetched = await fetchRecommendationResponse(url, fallbackUrl, request, effective);
    } catch (retryError) {
      throw communityFetchError(url, retryError);
    }
  }
  const { response } = fetched;
  const payload = await response.json();
  validateStandardRecommendationPayload(payload);
  return {
    host: {
      url: effective.hostUrl,
      recipeFeedPath: effective.recipeFeedPath,
      requestMethod: fetched.method,
      requestUrl: fetched.requestUrl,
      request,
      fallbackRequestUrl: fallbackUrl.toString(),
      ...(fetched.fallbackFromStatus ? { fallbackFromStatus: fetched.fallbackFromStatus } : {}),
      backendCatalogPath: effective.backendCatalogPath,
      autoStarted: autoStartedHost
    },
    profile: machineProfile,
    payload,
    recommendations: normalizeRecommendations(payload)
  };
}

export async function createCommunityPlan(config, options = {}) {
  const effective = communityOptions(config, options);
  const fetched = await fetchCommunityRecommendations(config, options);
  const signingKeys = await fetchHostSigningKeys(effective);
  const trustedKeys = combinedTrustedKeys(effective, signingKeys);
  const selected = fetched.recommendations.slice(0, Math.max(1, Number(effective.limit) || 1));
  const plans = [];
  for (const recommendation of selected) {
    plans.push({
      recommendation: {
        id: recommendation.id,
        recipeId: recommendation.recipeId ?? null,
        kind: recommendation.kind,
        summary: recommendation.summary ?? null,
        score: recommendation.score ?? null,
        request: recommendation.request ?? null,
        evaluation: recommendation.evaluation ?? null,
        benchmark: recommendation.benchmark ?? null
      },
      plan: await createRecipePackPlan(recommendation.source, config, {
        ...effective,
        trustedKeys
      })
    });
  }
  const validationErrors = plans.flatMap((entry) => entry.plan.validationErrors ?? []);
  if (!selected.length) validationErrors.push('community host returned no recipe-pack recommendations');
  return {
    ok: selected.length > 0 && plans.every((entry) => entry.plan.ok),
    host: {
      ...fetched.host,
      signingKeys: {
        enabled: signingKeys.enabled,
        status: signingKeys.status,
        ...(signingKeys.url ? { url: signingKeys.url } : {}),
        ...(signingKeys.statusCode ? { statusCode: signingKeys.statusCode } : {}),
        ...(signingKeys.keyCount != null ? { keyCount: signingKeys.keyCount } : {}),
        ...(signingKeys.keyIds ? { keyIds: signingKeys.keyIds } : {}),
        ...(signingKeys.ephemeral ? { ephemeral: true } : {}),
        ...(signingKeys.error ? { error: signingKeys.error } : {})
      }
    },
    profile: fetched.profile,
    recommendationCount: fetched.recommendations.length,
    selectedCount: selected.length,
    requireSignature: effective.requireSignature,
    backendCatalogPath: effective.backendCatalogPath,
    request: {
      workloads: effective.workloads,
      capabilities: effective.capabilities,
      tags: effective.tags
    },
    validationErrors,
    plans
  };
}

function firstRecipeAction(plan) {
  for (const entry of plan?.plans ?? []) {
    const action = entry?.plan?.actions?.find((candidate) => candidate.type === 'recipe' && candidate.id);
    if (action) return action;
  }
  return null;
}

export function selectedRecipeIdFromCommunityPlan(plan) {
  return (
    firstRecipeAction(plan)?.id ??
    (plan?.plans ?? []).find((entry) => entry?.recommendation?.recipeId)?.recommendation.recipeId ??
    null
  );
}

export function recipeDocumentsFromCommunityPlan(plan) {
  return (plan?.plans ?? [])
    .flatMap((entry) => entry?.plan?.recipes ?? [])
    .map((entry) => entry.recipe)
    .filter(Boolean);
}

export function benchmarkDocumentsFromCommunityPlan(plan) {
  return (plan?.plans ?? [])
    .flatMap((entry) => entry?.plan?.recipes ?? [])
    .flatMap((entry) => entry.benchmarks ?? [])
    .filter(Boolean);
}

export async function applyCommunityRecommendations(config, { dryRun = true, yes = false, ...options } = {}) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to import community recommendations without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }
  if (dryRun) return createCommunityPlan(config, options);
  const effective = communityOptions(config, options);
  const fetched = await fetchCommunityRecommendations(config, options);
  const signingKeys = await fetchHostSigningKeys(effective);
  const trustedKeys = combinedTrustedKeys(effective, signingKeys);
  const selected = fetched.recommendations.slice(0, Math.max(1, Number(effective.limit) || 1));
  if (!selected.length) throw new Error('community host returned no recipe-pack recommendations');

  const results = [];
  for (const recommendation of selected) {
    results.push({
      recommendation: {
        id: recommendation.id,
        recipeId: recommendation.recipeId ?? null,
        kind: recommendation.kind,
        summary: recommendation.summary ?? null,
        score: recommendation.score ?? null,
        request: recommendation.request ?? null,
        evaluation: recommendation.evaluation ?? null,
        benchmark: recommendation.benchmark ?? null
      },
      result: await applyRecipePack(recommendation.source, config, {
        ...effective,
        trustedKeys,
        dryRun: false,
        yes
      })
    });
  }
  return {
    ok: results.every((entry) => entry.result.ok),
    dryRun: false,
    host: {
      ...fetched.host,
      signingKeys: {
        enabled: signingKeys.enabled,
        status: signingKeys.status,
        ...(signingKeys.url ? { url: signingKeys.url } : {}),
        ...(signingKeys.statusCode ? { statusCode: signingKeys.statusCode } : {}),
        ...(signingKeys.keyCount != null ? { keyCount: signingKeys.keyCount } : {}),
        ...(signingKeys.keyIds ? { keyIds: signingKeys.keyIds } : {}),
        ...(signingKeys.ephemeral ? { ephemeral: true } : {}),
        ...(signingKeys.error ? { error: signingKeys.error } : {})
      }
    },
    profile: fetched.profile,
    recommendationCount: fetched.recommendations.length,
    selectedCount: selected.length,
    requireSignature: effective.requireSignature,
    backendCatalogPath: effective.backendCatalogPath,
    request: {
      workloads: effective.workloads,
      capabilities: effective.capabilities,
      tags: effective.tags
    },
    results
  };
}
