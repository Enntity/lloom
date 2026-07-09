import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function validateConfig(config, sourcePath) {
  const errors = [];
  const modelIds = new Set();

  for (const [index, model] of (config.models ?? []).entries()) {
    if (!model?.id) errors.push(`models[${index}] is missing id`);
    if (!model?.backend) errors.push(`models[${index}] ${model?.id ?? ''} is missing backend`);
    if (model?.id && modelIds.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
    if (model?.id) modelIds.add(model.id);
    if (model?.backend && !config.backends?.[model.backend]) {
      errors.push(`model ${model.id} references unknown backend ${model.backend}`);
    }
  }

  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    const target = typeof alias === 'string' ? alias : alias.target;
    if (!target) errors.push(`alias ${aliasId} is missing target`);
    if (target && !modelIds.has(target)) {
      errors.push(`alias ${aliasId} targets unknown model ${target}`);
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
  const parsed = JSON.parse(raw);
  const expanded = expandEnvValue(parsed, configEnv(env));
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
      apiKeys: [],
      adminApiKeys: [],
      ...asObject(expanded.security)
    },
    logging: {
      requestLog: false,
      requestLogPath: null,
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
      embeddingModel: undefined,
      speechModel: undefined,
      transcriptionModel: undefined,
      ...asObject(expanded.defaults)
    },
    providers: asObject(expanded.providers),
    backends: asObject(expanded.backends),
    aliases: asObject(expanded.aliases),
    runtimes: asObject(expanded.runtimes),
    keepWarm: Array.isArray(expanded.keepWarm) ? expanded.keepWarm : [],
    models: Array.isArray(expanded.models) ? expanded.models : [],
    clientCatalog: {
      providerId: 'local-llm',
      providerName: 'LLooM Local',
      includeAliases: false,
      modelOrder: [],
      ...asObject(expanded.clientCatalog)
    }
  };

  validateConfig(config, resolvedPath);
  return config;
}
