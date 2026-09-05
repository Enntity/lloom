import { expandedAliasMemberIds } from './alias-resolution.mjs';
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

function legacyMembers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return [value.target, ...(Array.isArray(value.fallbacks) ? value.fallbacks : [])].filter(Boolean);
}

function normalizeMemberSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = structuredClone(value);
  if (!Array.isArray(normalized.members)) normalized.members = legacyMembers(normalized);
  if (!Array.isArray(normalized.optionalMembers) && Array.isArray(normalized.optionalFallbacks)) {
    normalized.optionalMembers = [...normalized.optionalFallbacks];
  }
  delete normalized.target;
  delete normalized.fallbacks;
  delete normalized.optionalFallbacks;
  return normalized;
}

export function normalizeLegacyAliases(input) {
  const config = structuredClone(input);
  for (const [aliasId, alias] of Object.entries(asObject(config.aliases))) {
    if (typeof alias === 'string') continue;
    const normalized = normalizeMemberSet(alias);
    if (normalized.routeProfiles && typeof normalized.routeProfiles === 'object') {
      normalized.routeProfiles = Object.fromEntries(
        Object.entries(normalized.routeProfiles).map(([profileName, profile]) => [
          profileName,
          normalizeMemberSet(profile)
        ])
      );
    }
    config.aliases[aliasId] = normalized;
  }
  return config;
}

function validateConfig(config, sourcePath, env) {
  const errors = [];
  const modelIds = new Set();

  if (config.server?.inferenceEnabled != null && typeof config.server.inferenceEnabled !== 'boolean') {
    errors.push('server.inferenceEnabled must be a boolean');
  }

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

  const aliases = config.aliases ?? {};
  function expandedMembers(aliasId, profileMembers) {
    try {
      return expandedAliasMemberIds(
        aliasId,
        profileMembers ? { ...aliases, [aliasId]: { members: profileMembers } } : aliases,
        modelIds,
        { includeSuspended: true }
      );
    } catch (error) {
      if (!errors.includes(error.message)) errors.push(error.message);
      return [];
    }
  }
  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    const members = typeof alias === 'string' ? [alias] : alias?.members;
    const optionalMembers = typeof alias === 'string' ? [] : alias?.optionalMembers;
    const suspendedMembers = typeof alias === 'string' ? [] : alias?.suspendedMembers;
    if (!Array.isArray(members) || !members.length) errors.push(`alias ${aliasId} must declare at least one member`);
    const aliasResidencyFields = residencyFields(alias);
    if (aliasResidencyFields.length) {
      errors.push(
        `alias ${aliasId} cannot declare ${aliasResidencyFields.join(', ')}; aliases resolve models and cannot pin compute`
      );
    }
    if (members != null && !Array.isArray(members)) {
      errors.push(`alias ${aliasId} members must be an array`);
    }
    if (optionalMembers != null && !Array.isArray(optionalMembers)) {
      errors.push(`alias ${aliasId} optionalMembers must be an array`);
    }
    if (suspendedMembers != null && !Array.isArray(suspendedMembers)) {
      errors.push(`alias ${aliasId} suspendedMembers must be an array`);
    }
    const memberIds = Array.isArray(members) ? members : [];
    const optionalMemberIds = new Set(Array.isArray(optionalMembers) ? optionalMembers : []);
    const suspendedMemberIds = Array.isArray(suspendedMembers) ? suspendedMembers : [];
    if (new Set(memberIds).size !== memberIds.length) {
      errors.push(`alias ${aliasId} has duplicate members`);
    }
    if (new Set(suspendedMemberIds).size !== suspendedMemberIds.length) {
      errors.push(`alias ${aliasId} has duplicate suspended members`);
    }
    for (const candidate of suspendedMemberIds) {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        errors.push(`alias ${aliasId} has an invalid suspended member`);
      } else if (!memberIds.includes(candidate)) {
        errors.push(`alias ${aliasId} suspended member ${candidate} is not present in members`);
      }
    }
    for (const candidate of optionalMemberIds) {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        errors.push(`alias ${aliasId} has an invalid optional member`);
      } else if (!memberIds.includes(candidate)) {
        errors.push(`alias ${aliasId} optional member ${candidate} is not present in members`);
      }
    }
    for (const candidate of memberIds) {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        errors.push(`alias ${aliasId} has an invalid member`);
      } else if (!modelIds.has(candidate) && !Object.hasOwn(aliases, candidate) && !optionalMemberIds.has(candidate)) {
        errors.push(`alias ${aliasId} references unknown model ${candidate}`);
      }
    }
    const kinds = new Set(
      expandedMembers(aliasId)
        .map((candidate) => (config.models ?? []).find((model) => model.id === candidate))
        .filter(Boolean)
        .map((model) => model.kind ?? 'chat')
    );
    if (kinds.size > 1) {
      errors.push(`alias ${aliasId} contains models with different kinds: ${[...kinds].join(', ')}`);
    }

    const routeProfiles = typeof alias === 'string' ? null : alias?.routeProfiles;
    if (routeProfiles != null) {
      if (!routeProfiles || typeof routeProfiles !== 'object' || Array.isArray(routeProfiles)) {
        errors.push(`alias ${aliasId} routeProfiles must be an object`);
      } else {
        const profileNames = Object.keys(routeProfiles);
        if (!profileNames.length) errors.push(`alias ${aliasId} routeProfiles must not be empty`);
        if (typeof alias.activeRoute !== 'string' || !routeProfiles[alias.activeRoute]) {
          errors.push(`alias ${aliasId} activeRoute must name a configured route profile`);
        }
        for (const [profileName, profile] of Object.entries(routeProfiles)) {
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
            errors.push(`alias ${aliasId} route profile ${profileName} must be an object`);
            continue;
          }
          const profileMembers = profile.members;
          if (!Array.isArray(profileMembers) || !profileMembers.length) {
            errors.push(`alias ${aliasId} route profile ${profileName} must declare at least one member`);
          }
          if (profileMembers != null && !Array.isArray(profileMembers)) {
            errors.push(`alias ${aliasId} route profile ${profileName} members must be an array`);
          }
          const profileMemberIds = Array.isArray(profileMembers) ? profileMembers : [];
          if (new Set(profileMemberIds).size !== profileMemberIds.length) {
            errors.push(`alias ${aliasId} route profile ${profileName} has duplicate members`);
          }
          for (const candidate of profileMemberIds) {
            if (typeof candidate !== 'string' || !candidate.trim()) {
              errors.push(`alias ${aliasId} route profile ${profileName} has an invalid member`);
            } else if (!modelIds.has(candidate) && !Object.hasOwn(aliases, candidate)) {
              errors.push(`alias ${aliasId} route profile ${profileName} references unknown model ${candidate}`);
            }
          }
          const profileKinds = new Set(
            expandedMembers(aliasId, profileMemberIds)
              .map((candidate) => (config.models ?? []).find((model) => model.id === candidate))
              .filter(Boolean)
              .map((model) => model.kind ?? 'chat')
          );
          if (profileKinds.size > 1) {
            errors.push(
              `alias ${aliasId} route profile ${profileName} contains models with different kinds: ${[
                ...profileKinds
              ].join(', ')}`
            );
          }
        }
        const active = routeProfiles[alias.activeRoute];
        if (active && JSON.stringify(alias.members ?? []) !== JSON.stringify(active.members ?? [])) {
          errors.push(`alias ${aliasId} active member order does not match route profile ${alias.activeRoute}`);
        }
      }
    } else if (typeof alias !== 'string' && alias?.activeRoute != null) {
      errors.push(`alias ${aliasId} activeRoute requires routeProfiles`);
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
  const parsed = normalizeLegacyAliases(normalizeLegacyResidencyPolicy(JSON.parse(raw)));
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
