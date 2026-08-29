import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeFederatedNodes,
  modelTargets,
  runtimeAuthority,
  runtimePlacement,
  validateClusterConfig
} from './cluster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..');
export const defaultConfigPath = path.join(repoRoot, 'config/default.json');

export function defaultLloomHome(env = process.env) {
  if (env.LLOOM_HOME) return env.LLOOM_HOME;
  return env.HOME ? path.join(env.HOME, '.lloom') : path.resolve('.lloom');
}

export function defaultUserModelRoot(env = process.env) {
  return path.join(defaultLloomHome(env), 'models');
}

export function defaultUserSessionCacheRoot(env = process.env) {
  return path.join(defaultLloomHome(env), 'session-cache');
}

export function expandEnvValue(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvValue(item, env));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvValue(item, env)]));
  }
  return value;
}

function configEnv(env = process.env) {
  const modelRoot = env.LLOOM_MODEL_ROOT ?? defaultUserModelRoot(env);
  return {
    LLOOM_MODEL_ROOT: modelRoot,
    LLOOM_MTPLX_MODEL_ROOT: env.LLOOM_MTPLX_MODEL_ROOT ?? modelRoot,
    LLOOM_SESSION_CACHE_ROOT: defaultUserSessionCacheRoot(env),
    ...env
  };
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function envBoolean(env, name) {
  const value = env[name];
  if (value == null || value === '') return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be one of true/false, yes/no, on/off, or 1/0`);
}

function residencyFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const fields = ['keepWarm', 'pinned', 'evictable'].filter((field) => Object.hasOwn(value, field));
  if (value.policy && typeof value.policy === 'object' && !Array.isArray(value.policy)) {
    fields.push(
      ...['keepWarm', 'pinned', 'evictable']
        .filter((field) => Object.hasOwn(value.policy, field))
        .map((field) => `policy.${field}`)
    );
  }
  return fields;
}

export function normalizeLegacyResidencyPolicy(input) {
  const config = structuredClone(input);
  if (config.runtimePolicy && typeof config.runtimePolicy === 'object') {
    delete config.runtimePolicy.protectKeepWarm;
  }
  for (const runtime of Object.values(asObject(config.runtimes))) {
    const legacyPinned = runtime?.evictable === false || runtime?.policy?.evictable === false;
    if (legacyPinned) runtime.keepWarm = true;
    if (runtime && typeof runtime === 'object') delete runtime.evictable;
    if (runtime?.policy && typeof runtime.policy === 'object') {
      delete runtime.policy.evictable;
      if (!Object.keys(runtime.policy).length) delete runtime.policy;
    }
  }
  return config;
}

function validateConfig(config, sourcePath, env) {
  const errors = [];
  const modelIds = new Set();

  for (const [index, model] of (config.models ?? []).entries()) {
    if (!model?.id) errors.push(`models[${index}] is missing id`);
    if (!model?.backend && !model?.targets?.length) {
      errors.push(`models[${index}] ${model?.id ?? ''} is missing backend or targets`);
    }
    if (model?.id && modelIds.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
    if (model?.id) modelIds.add(model.id);
    const modelResidencyFields = residencyFields(model);
    if (modelResidencyFields.length) {
      errors.push(
        `model ${model?.id ?? index} cannot declare ${modelResidencyFields.join(', ')}; keepWarm is only valid on a managed internal runtime`
      );
    }
    if (model?.runtime && !config.runtimes?.[model.runtime]) {
      errors.push(`model ${model.id} references unknown runtime ${model.runtime}`);
    }
    for (const target of modelTargets(model)) {
      if (target.backend && !config.backends?.[target.backend]) {
        errors.push(`model ${model.id} references unknown backend ${target.backend}`);
      }
    }
  }

  errors.push(...validateClusterConfig(config, env));

  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    const target = typeof alias === 'string' ? alias : alias?.target;
    const fallbacks = typeof alias === 'string' ? [] : alias?.fallbacks;
    const optionalFallbacks = typeof alias === 'string' ? [] : alias?.optionalFallbacks;
    if (!target) errors.push(`alias ${aliasId} is missing target`);
    const aliasResidencyFields = residencyFields(alias);
    if (aliasResidencyFields.length) {
      errors.push(
        `alias ${aliasId} cannot declare ${aliasResidencyFields.join(', ')}; aliases resolve models and cannot pin compute`
      );
    }
    if (fallbacks != null && !Array.isArray(fallbacks)) {
      errors.push(`alias ${aliasId} fallbacks must be an array`);
    }
    if (optionalFallbacks != null && !Array.isArray(optionalFallbacks)) {
      errors.push(`alias ${aliasId} optionalFallbacks must be an array`);
    }
    const targets = [target, ...(Array.isArray(fallbacks) ? fallbacks : [])].filter(Boolean);
    const optionalTargets = new Set(Array.isArray(optionalFallbacks) ? optionalFallbacks : []);
    if (new Set(targets).size !== targets.length) {
      errors.push(`alias ${aliasId} has duplicate targets`);
    }
    for (const candidate of optionalTargets) {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        errors.push(`alias ${aliasId} has an invalid optional fallback`);
      } else if (!fallbacks?.includes(candidate)) {
        errors.push(`alias ${aliasId} optional fallback ${candidate} is not present in fallbacks`);
      }
    }
    for (const candidate of targets) {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        errors.push(`alias ${aliasId} has an invalid target`);
      } else if (!modelIds.has(candidate) && !optionalTargets.has(candidate)) {
        errors.push(`alias ${aliasId} targets unknown model ${candidate}`);
      }
    }
    const kinds = new Set(
      targets
        .map((candidate) => (config.models ?? []).find((model) => model.id === candidate))
        .filter(Boolean)
        .map((model) => model.kind ?? 'chat')
    );
    if (kinds.size > 1) {
      errors.push(`alias ${aliasId} targets models with different kinds: ${[...kinds].join(', ')}`);
    }
  }

  for (const [runtimeId, runtime] of Object.entries(config.runtimes ?? {})) {
    if (runtime.keepWarm != null && typeof runtime.keepWarm !== 'boolean') {
      errors.push(`runtime ${runtimeId} keepWarm must be a boolean`);
    }
    if (runtime.authority != null) {
      if (!runtime.authority || typeof runtime.authority !== 'object' || Array.isArray(runtime.authority)) {
        errors.push(`runtime ${runtimeId} authority must be an object`);
      } else {
        const owner = runtime.authority.owner;
        const scope = runtime.authority.scope;
        if (typeof owner !== 'string' || !owner.trim()) {
          errors.push(`runtime ${runtimeId} authority.owner must be a non-empty node id`);
        } else if (config.cluster?.nodes && !config.cluster.nodes[owner]) {
          errors.push(`runtime ${runtimeId} authority owner ${owner} is not declared in cluster.nodes`);
        }
        if (scope != null && !['local', 'distributed-model', 'distributed-member'].includes(scope)) {
          errors.push(`runtime ${runtimeId} authority.scope is invalid: ${scope}`);
        }
        if (runtime.authority.group != null && typeof runtime.authority.group !== 'string') {
          errors.push(`runtime ${runtimeId} authority.group must be a runtime id`);
        }
      }
    }
  }

  const distributedMemberGroups = new Map();
  for (const [runtimeId, runtime] of Object.entries(config.runtimes ?? {})) {
    if (runtime?.placement?.mode !== 'distributed') continue;
    const authority = runtimeAuthority(config, runtimeId, env);
    const leader = config.cluster?.leaderNode;
    if (runtime.authority?.owner != null && runtime.authority.owner !== authority?.owner) {
      errors.push(`distributed runtime ${runtimeId} authority owner must be cluster leader ${authority?.owner}`);
    }
    if (runtime.authority?.scope != null && runtime.authority.scope !== 'distributed-model') {
      errors.push(`distributed runtime ${runtimeId} must use authority.scope distributed-model`);
    }
    if (runtime.authority?.group != null && runtime.authority.group !== runtimeId) {
      errors.push(`distributed runtime ${runtimeId} authority.group must be ${runtimeId}`);
    }
    if (leader && authority?.owner !== leader) {
      errors.push(`distributed runtime ${runtimeId} must be owned by cluster leader ${leader}`);
    }
    for (const member of runtime.placement.members ?? []) {
      if (distributedMemberGroups.has(member.runtime) && distributedMemberGroups.get(member.runtime) !== runtimeId) {
        errors.push(
          `distributed member ${member.runtime} is shared by ${distributedMemberGroups.get(member.runtime)} and ${runtimeId}`
        );
      }
      distributedMemberGroups.set(member.runtime, runtimeId);
      const memberAuthority = runtimeAuthority(config, member.runtime, env);
      const explicit = config.runtimes?.[member.runtime]?.authority;
      if (explicit?.owner != null && explicit.owner !== authority?.owner) {
        errors.push(`distributed member ${member.runtime} authority owner must be ${authority?.owner}`);
      }
      if (explicit?.scope != null && explicit.scope !== 'distributed-member') {
        errors.push(`distributed member ${member.runtime} must use authority.scope distributed-member`);
      }
      if (explicit?.group != null && explicit.group !== runtimeId) {
        errors.push(`distributed member ${member.runtime} authority.group must be ${runtimeId}`);
      }
      if (memberAuthority?.owner !== authority?.owner || memberAuthority?.scope !== 'distributed-member') {
        errors.push(`distributed member ${member.runtime} has inconsistent derived authority`);
      }
    }
  }

  for (const [runtimeId, runtime] of Object.entries(config.runtimes ?? {})) {
    if (!runtime.authority || runtime?.placement?.mode === 'distributed' || distributedMemberGroups.has(runtimeId)) {
      continue;
    }
    const node = runtimePlacement(runtime, config, env).node;
    if (runtime.authority.owner !== node) {
      errors.push(`local runtime ${runtimeId} authority owner must be its host node ${node}`);
    }
    if (runtime.authority.scope != null && runtime.authority.scope !== 'local') {
      errors.push(`local runtime ${runtimeId} must use authority.scope local`);
    }
    if (runtime.authority.group != null) {
      errors.push(`local runtime ${runtimeId} cannot declare authority.group`);
    }
  }

  if (errors.length) {
    throw new Error(`Invalid LLooM config ${sourcePath}:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
}

export async function loadConfig(
  configPath = process.env.LLOOM_CONFIG || defaultConfigPath,
  { env = process.env } = {}
) {
  const resolvedPath = path.resolve(configPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const parsed = normalizeLegacyResidencyPolicy(JSON.parse(raw));
  const expanded = expandEnvValue(parsed, configEnv(env));
  if (Object.hasOwn(expanded, 'keepWarm')) {
    throw new Error(
      `Invalid LLooM config ${resolvedPath}: top-level keepWarm is not supported; use runtimes.<id>.keepWarm`
    );
  }
  const community = asObject(expanded.community);
  const requireSignedPacks = envBoolean(env, 'LLOOM_COMMUNITY_REQUIRE_SIGNED_PACKS');
  const config = {
    ...expanded,
    sourcePath: resolvedPath,
    server: {
      host: '127.0.0.1',
      port: 8100,
      ...asObject(expanded.server)
    },
    security: {
      allowMissingAuth: true,
      allowRemoteAdmin: false,
      allowWildcardCors: false,
      allowNonLoopbackBind: false,
      publicTelemetry: false,
      apiKeys: [],
      adminApiKeys: [],
      ...asObject(expanded.security)
    },
    logging: {
      requestLog: false,
      requestLogPath: null,
      metricsPersistence: true,
      metricsPath: null,
      ...asObject(expanded.logging),
      ...(envBoolean(env, 'LLOOM_REQUEST_LOG') == null
        ? {}
        : { requestLog: envBoolean(env, 'LLOOM_REQUEST_LOG') === true }),
      ...(env.LLOOM_REQUEST_LOG_PATH ? { requestLogPath: env.LLOOM_REQUEST_LOG_PATH } : {})
    },
    community: {
      hostUrl: null,
      recipeFeedPath: '/v1/recipe-packs/recommended',
      signingKeysPath: '/v1/keys',
      trustHostKeys: true,
      leaderboardPath: '/v1/leaderboard',
      submissionPath: '/v1/benchmarks',
      recipePackSubmissionPath: '/v1/recipe-packs',
      requireSignedPacks: true,
      // Source checkouts auto-start the local seed host; packaged/production installs should point at a public host.
      autoStartLocalHost: env.NODE_ENV === 'production' ? false : true,
      localHostStartupTimeoutMs: 5000,
      workloads: ['agentic-coding'],
      capabilities: ['tools', 'reasoning', 'long-context'],
      tags: [],
      trustedKeys: [],
      ...community,
      ...(env.LLOOM_COMMUNITY_HOST_URL ? { hostUrl: env.LLOOM_COMMUNITY_HOST_URL } : {}),
      ...(requireSignedPacks == null ? {} : { requireSignedPacks })
    },
    communityHost: {
      indexPath: 'community/recipes/index.json',
      recipesRoot: 'community/recipes',
      benchmarksRoot: 'community/benchmarks',
      backendCatalogPath: 'backends/catalog.json',
      publisher: 'lloom-dev-host',
      keyId: 'lloom-dev-seed',
      privateKeyPath: 'community/keys/lloom-dev-signing-private.pem',
      publicKeyPath: 'community/keys/lloom-dev-signing-public.pem',
      ...asObject(expanded.communityHost)
    },
    defaults: {
      chatModel: undefined,
      imageModel: undefined,
      videoModel: undefined,
      embeddingModel: undefined,
      speechModel: undefined,
      transcriptionModel: undefined,
      ...asObject(expanded.defaults)
    },
    providers: asObject(expanded.providers),
    backends: asObject(expanded.backends),
    aliases: asObject(expanded.aliases),
    runtimes: asObject(expanded.runtimes),
    cluster: {
      ...asObject(expanded.cluster),
      nodes: asObject(expanded.cluster?.nodes)
    },
    models: Array.isArray(expanded.models) ? expanded.models : [],
    clientCatalog: {
      providerId: 'local-llm',
      providerName: 'LLooM Local',
      includeAliases: false,
      modelOrder: [],
      ...asObject(expanded.clientCatalog)
    }
  };

  Object.defineProperty(config, 'sourceTemplate', {
    value: parsed,
    enumerable: false,
    configurable: false,
    writable: false
  });

  materializeFederatedNodes(config);
  validateConfig(config, resolvedPath, env);
  return config;
}
