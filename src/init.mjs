import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyIntegrationArtifacts,
  buildIntegrationArtifacts,
  selectIntegrationArtifacts,
  writeGeneratedIntegrationArtifacts
} from './client-integrations.mjs';
import { defaultBackendVariables, getBackend, loadBackendCatalog, planBackend } from './backend-catalog.mjs';
import { nextBackendPort } from './model-intake.mjs';
import { detectModelRootForRecipe } from './model-files.mjs';
import { profileMachine, rankRecipes } from './machine-profile.mjs';
import { createRegistry } from './registry.mjs';
import { loadRecipeById, loadRecipes } from './recipes.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripRuntimeFields(config) {
  const copy = clone(config);
  delete copy.sourcePath;
  return copy;
}

function containsEnvReference(value) {
  if (typeof value === 'string') return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
  if (Array.isArray(value)) return value.some(containsEnvReference);
  return false;
}

function preserveEnvBackedSecrets(derived, sourceTemplate) {
  if (!sourceTemplate) return derived;
  for (const key of ['apiKeys', 'adminApiKeys']) {
    const template = sourceTemplate.security?.[key];
    if (containsEnvReference(template)) {
      derived.security ??= {};
      derived.security[key] = clone(template);
    }
  }
  for (const section of ['backends', 'providers']) {
    for (const [id, templateEntry] of Object.entries(sourceTemplate[section] ?? {})) {
      if (!containsEnvReference(templateEntry?.apiKey) || !derived[section]?.[id]) continue;
      derived[section][id].apiKey = templateEntry.apiKey;
    }
  }
  return derived;
}

function defaultHome(home = process.env.HOME) {
  return home ? path.join(home, '.lloom') : path.resolve('.lloom');
}

export function defaultUserConfigPath(home = process.env.HOME) {
  return path.join(defaultHome(home), 'config.json');
}

export function defaultGeneratedRoot(home = process.env.HOME) {
  return path.join(defaultHome(home), 'generated');
}

export function defaultSessionCacheRoot(home = process.env.HOME) {
  return path.join(defaultHome(home), 'session-cache');
}

function recipeRuntimeIds(recipe) {
  return [...new Set((recipe.models ?? []).map((model) => model.runtime).filter(Boolean))];
}

function recipeModelIds(recipe) {
  return new Set((recipe.models ?? []).flatMap((model) => [model.gatewayModel, model.model]).filter(Boolean));
}

function asPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer port from 1 to 65535`);
  }
  return port;
}

function normalizeBackendPortRange(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/^(\d+)-(\d+)$/);
    if (!match) throw new Error('backend port range must use start-end format');
    const start = asPort(match[1], 'backend port range start');
    const end = asPort(match[2], 'backend port range end');
    if (end < start) throw new Error('backend port range end must be >= start');
    return { start, end };
  }
  if (typeof value === 'object') {
    const start = asPort(value.start, 'backend port range start');
    const end = asPort(value.end, 'backend port range end');
    if (end < start) throw new Error('backend port range end must be >= start');
    return { start, end };
  }
  throw new Error('backend port range must use start-end format');
}

function defaultKeepWarmRuntime(config, recipe) {
  const defaultModel = config.defaults?.chatModel;
  const defaultRecipeModel = (recipe.models ?? []).find((model) => model.gatewayModel === defaultModel);
  if (defaultRecipeModel?.runtime) return defaultRecipeModel.runtime;
  return recipeRuntimeIds(recipe)[0] ?? null;
}

function recipeModelSpeed(model) {
  const speed = Number(model?.observed?.generationTokPerSec);
  return Number.isFinite(speed) ? speed : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || 'model'
  );
}

function repoCacheName(modelId) {
  return String(modelId).replace(/\//g, '--');
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function urlWithPort(port, suffix = '/v1') {
  return `http://127.0.0.1:${port}${suffix}`;
}

function isPathLike(value) {
  return typeof value === 'string' && (value.startsWith('/') || value.startsWith('.'));
}

function modelPathForRecipeModel(recipeModel, backendId, modelRoot) {
  const settings = asObject(recipeModel.settings);
  if (settings.modelPath) return settings.modelPath;
  const modelId = recipeModel.model;
  if (!modelRoot || isPathLike(modelId)) return modelId;
  if (backendId === 'ollama') return modelId;
  return path.join(modelRoot, repoCacheName(modelId));
}

function recipeModelKind(recipeModel) {
  const capabilities = new Set(asArray(recipeModel.capabilities));
  if (capabilities.has('video-generation')) return 'video';
  if (capabilities.has('image-generation') || capabilities.has('image-editing')) return 'image';
  if (capabilities.has('audio-speech') || capabilities.has('tts')) return 'audio_speech';
  if (capabilities.has('audio-transcription') || capabilities.has('stt')) return 'audio_transcription';
  if (capabilities.has('embedding')) return 'embedding';
  return 'chat';
}

function recipeModelInput(recipeModel) {
  if (Array.isArray(recipeModel.input)) return recipeModel.input;
  const capabilities = new Set(asArray(recipeModel.capabilities));
  if (capabilities.has('vision') || capabilities.has('image-text-to-text')) return ['text', 'image'];
  return ['text'];
}

function recipeModelOutput(recipeModel) {
  if (Array.isArray(recipeModel.output)) return recipeModel.output;
  const capabilities = new Set(asArray(recipeModel.capabilities));
  if (capabilities.has('video-generation')) return ['video'];
  if (capabilities.has('image-generation')) return ['image'];
  if (capabilities.has('audio-speech') || capabilities.has('tts')) return ['audio'];
  if (capabilities.has('audio-transcription') || capabilities.has('stt')) return ['text'];
  return ['text'];
}

function warmupForRuntime(port, modelId, pathSuffix = '/v1/chat/completions') {
  return {
    url: urlWithPort(port, pathSuffix),
    method: 'POST',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 2,
      stream: false
    }
  };
}

function appendOptionalArg(args, flag, value) {
  if (value == null || value === false) return;
  args.push(flag, String(value));
}

function templateString(value, variables) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : match
  );
}

function templateValue(value, variables) {
  if (typeof value === 'string') return templateString(value, variables);
  if (Array.isArray(value)) return value.map((item) => templateValue(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, templateValue(item, variables)]));
  }
  return value;
}

function primitiveSettings(settings) {
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([, value]) => value == null || ['string', 'number', 'boolean'].includes(typeof value)
    )
  );
}

function runtimeTemplateVariables({
  recipe,
  recipeModel,
  backendId,
  runtimeId,
  modelPath,
  modelRoot,
  modelId,
  port,
  sessionCacheRoot,
  contextWindow,
  maxOutputTokens,
  maxActiveRequests
}) {
  const settings = asObject(recipeModel.settings);
  const selectedSessionCacheRoot = sessionCacheRoot ?? '${LLOOM_SESSION_CACHE_ROOT}';
  return {
    ...primitiveSettings(settings),
    recipeId: recipe.id,
    backendId,
    runtimeId,
    modelPath,
    modelRoot,
    modelId,
    gatewayModel: modelId,
    upstreamModel: recipeModel.model,
    port,
    host: '127.0.0.1',
    contextWindow,
    maxOutputTokens,
    maxActiveRequests,
    sessionCacheRoot: selectedSessionCacheRoot,
    sessionCacheDir: path.join(selectedSessionCacheRoot, runtimeId)
  };
}

function sessionCacheForSettings(
  settings,
  runtimeId,
  sessionCacheRoot,
  { defaultKind, includeByDefault = false } = {}
) {
  if (settings.sessionCache === false) return { enabled: false };
  const explicit = asObject(settings.sessionCache);
  const hasExplicit = settings.sessionCache === true || Object.keys(explicit).length > 0;
  if (!includeByDefault && !hasExplicit) return null;
  return {
    kind: explicit.kind ?? explicit.type ?? defaultKind,
    mode: explicit.mode ?? settings.sessionCacheMode ?? 'on',
    dir: explicit.dir ?? path.join(sessionCacheRoot ?? '${LLOOM_SESSION_CACHE_ROOT}', runtimeId),
    maxSize: explicit.maxSize ?? settings.sessionCacheMaxSize ?? '100GB',
    minPrefixTokens: positiveInteger(explicit.minPrefixTokens ?? settings.sessionCacheMinPrefixTokens, 512)
  };
}

function explicitWarmup(runtimeSettings, port, modelId, variables) {
  if (runtimeSettings.warmup === false) return null;
  if (runtimeSettings.warmup && typeof runtimeSettings.warmup === 'object') {
    return templateValue(runtimeSettings.warmup, variables);
  }
  return warmupForRuntime(port, modelId, runtimeSettings.warmupPath ?? '/v1/chat/completions');
}

function buildExplicitRecipeRuntime({
  recipe,
  recipeModel,
  backendId,
  runtimeId,
  modelPath,
  modelRoot,
  modelId,
  port,
  sessionCacheRoot,
  contextWindow,
  maxOutputTokens,
  maxActiveRequests,
  base
}) {
  const settings = asObject(recipeModel.settings);
  const runtimeSettings = asObject(settings.runtime);
  if (!runtimeSettings.command && !runtimeSettings.bootstrap) return null;
  const variables = runtimeTemplateVariables({
    recipe,
    recipeModel,
    backendId,
    runtimeId,
    modelPath,
    modelRoot,
    modelId,
    port,
    sessionCacheRoot,
    contextWindow,
    maxOutputTokens,
    maxActiveRequests
  });
  const sessionCacheSettings =
    runtimeSettings.sessionCache == null ? settings : { ...settings, sessionCache: runtimeSettings.sessionCache };
  const sessionCache = sessionCacheForSettings(sessionCacheSettings, runtimeId, sessionCacheRoot, {
    defaultKind:
      runtimeSettings.sessionCacheKind ??
      (backendId === 'mtplx' ? 'mtplx-ssd-session' : backendId === 'llama-cpp' ? 'llama-cpp-kv-cache' : undefined),
    includeByDefault: false
  });
  const warmup = explicitWarmup(runtimeSettings, port, modelId, variables);
  return {
    ...base,
    ...(runtimeSettings.command
      ? {
          command: templateString(runtimeSettings.command, variables),
          args: templateValue(asArray(runtimeSettings.args), variables)
        }
      : {}),
    ...(runtimeSettings.cwd ? { cwd: templateString(runtimeSettings.cwd, variables) } : {}),
    ...(runtimeSettings.env ? { env: templateValue(asObject(runtimeSettings.env), variables) } : {}),
    ...(runtimeSettings.adapter ? { adapter: templateString(runtimeSettings.adapter, variables) } : {}),
    ...(runtimeSettings.management ? { management: templateString(runtimeSettings.management, variables) } : {}),
    ...(runtimeSettings.containerName
      ? { containerName: templateString(runtimeSettings.containerName, variables) }
      : {}),
    ...(runtimeSettings.bootstrap ? { bootstrap: templateValue(asObject(runtimeSettings.bootstrap), variables) } : {}),
    recipe: {
      id: recipe.id,
      version: recipe.version ?? 1,
      source: recipe.filePath ?? null
    },
    ...(sessionCache ? { sessionCache } : {}),
    healthUrl: runtimeSettings.healthUrl
      ? templateString(runtimeSettings.healthUrl, variables)
      : urlWithPort(port, runtimeSettings.healthPath ?? '/health'),
    ...(warmup ? { warmup } : {})
  };
}

function buildRecipeRuntime({
  recipe,
  recipeModel,
  backendId,
  runtimeId,
  modelPath,
  modelRoot,
  modelId,
  port,
  sessionCacheRoot
}) {
  const settings = asObject(recipeModel.settings);
  const contextWindow = positiveInteger(settings.contextWindow, 32768);
  const maxOutputTokens = positiveInteger(settings.maxOutputTokens, 8192);
  const maxActiveRequests = positiveInteger(settings.maxActiveRequests, backendId === 'mtplx' ? 10 : 4);
  const memoryGb = Number(settings.memoryGb ?? recipe.requirements?.memoryGb);
  const base = {
    enabled: true,
    port,
    startupTimeoutMs: positiveInteger(settings.startupTimeoutMs, 900000),
    maxConcurrency: maxActiveRequests,
    ...(Number.isFinite(memoryGb) ? { memoryGb } : {}),
    ...(typeof settings.keepWarm === 'boolean' ? { keepWarm: settings.keepWarm } : {}),
    policy: {
      priority: positiveInteger(settings.priority, 50),
      evictable: settings.evictable !== false
    }
  };

  const explicitRuntime = buildExplicitRecipeRuntime({
    recipe,
    recipeModel,
    backendId,
    runtimeId,
    modelPath,
    modelRoot,
    modelId,
    port,
    sessionCacheRoot,
    contextWindow,
    maxOutputTokens,
    maxActiveRequests,
    base
  });
  if (explicitRuntime) return explicitRuntime;

  if (backendId === 'mtplx') {
    const args = ['serve', '--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--model-id', modelId];
    appendOptionalArg(args, '--profile', settings.profile);
    appendOptionalArg(args, '--depth', settings.draftDepth);
    appendOptionalArg(args, '--context-window', contextWindow);
    appendOptionalArg(args, '--max-tokens', maxOutputTokens);
    appendOptionalArg(args, '--reasoning', settings.reasoning ?? 'auto');
    appendOptionalArg(args, '--preserve-thinking', settings.preserveThinking ?? 'auto');
    appendOptionalArg(args, '--batching-preset', settings.batchingPreset ?? 'agent');
    appendOptionalArg(args, '--max-active-requests', maxActiveRequests);
    if (settings.statsFooter !== true) args.push('--no-stats-footer');
    return {
      ...base,
      command: 'mtplx',
      args,
      sessionCache: sessionCacheForSettings(settings, runtimeId, sessionCacheRoot, {
        defaultKind: 'mtplx-ssd-session',
        includeByDefault: true
      }),
      healthUrl: urlWithPort(port, '/health'),
      warmup: warmupForRuntime(port, modelId)
    };
  }

  if (backendId === 'mlx-lm') {
    return {
      ...base,
      command: 'mlx_lm.server',
      args: ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port)],
      healthUrl: urlWithPort(port, '/v1/models'),
      warmup: warmupForRuntime(port, modelId)
    };
  }

  if (backendId === 'llama-cpp') {
    return {
      ...base,
      command: 'llama-server',
      args: ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', String(contextWindow)],
      healthUrl: urlWithPort(port, '/health'),
      warmup: warmupForRuntime(port, modelId)
    };
  }

  if (backendId === 'vllm') {
    // Spark/GB10 class defaults: low concurrent seqs (unified-memory boxes thrash
    // above ~4), chunked prefill, and leave headroom for OS/tools.
    return {
      ...base,
      command: 'vllm',
      args: [
        'serve',
        modelPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--served-model-name',
        modelId,
        '--tensor-parallel-size',
        '1',
        '--max-model-len',
        String(contextWindow),
        '--max-num-seqs',
        '4',
        '--gpu-memory-utilization',
        '0.85',
        '--enable-chunked-prefill',
        '--enable-prefix-caching',
        '--trust-remote-code'
      ],
      healthUrl: urlWithPort(port, '/health'),
      warmup: warmupForRuntime(port, modelId)
    };
  }

  if (backendId === 'sglang') {
    // SGLang is popular for agent/tool loops (RadixAttention prefix cache).
    // Defaults stay conservative; Spark recipes override with tools/MTP flags.
    return {
      ...base,
      command: 'sglang-python',
      args: [
        '-m',
        'sglang.launch_server',
        '--model-path',
        modelPath,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--served-model-name',
        modelId,
        '--tp',
        '1',
        '--context-length',
        String(contextWindow),
        '--mem-fraction-static',
        '0.85',
        '--trust-remote-code'
      ],
      healthUrl: urlWithPort(port, '/health'),
      warmup: warmupForRuntime(port, modelId)
    };
  }

  if (backendId === 'ollama') {
    return {
      ...base,
      command: 'ollama',
      args: ['serve'],
      env: {
        OLLAMA_HOST: `127.0.0.1:${port}`
      },
      healthUrl: urlWithPort(port, '/api/tags'),
      warmup: warmupForRuntime(port, modelId)
    };
  }

  return null;
}

function ensureRecipeConfigEntries(config, recipe, { modelRoot, sessionCacheRoot } = {}) {
  const backendId = recipe.backend?.id;
  if (!backendId) return;
  config.backends ??= {};
  config.runtimes ??= {};
  config.models ??= [];
  config.aliases ??= {};
  config.clientCatalog ??= {};
  config.clientCatalog.modelOrder ??= [];

  for (const recipeModel of recipe.models ?? []) {
    const modelId = recipeModel.gatewayModel ?? recipeModel.model;
    if (!modelId) continue;
    const modelSlug = slug(modelId);
    const existingModel = config.models.find((model) => model.id === modelId);
    const runtimeId = existingModel?.runtime ?? recipeModel.runtime ?? `${backendId}-${modelSlug}`;
    const backendConfigId = existingModel?.backend ?? recipeModel.backendConfig ?? `${backendId}-${modelSlug}`;
    const port = Number(config.runtimes?.[runtimeId]?.port) || nextBackendPort(config);
    const modelPath = modelPathForRecipeModel(recipeModel, backendId, modelRoot);

    if (!config.backends[backendConfigId]) {
      const settings = asObject(recipeModel.settings);
      const runtimeSettings = asObject(settings.runtime);
      config.backends[backendConfigId] = {
        type: 'openai',
        baseUrl: settings.baseUrl ?? urlWithPort(port, runtimeSettings.baseUrlPath ?? settings.baseUrlPath ?? '/v1'),
        apiKey: settings.apiKey ?? 'sk-local-llm',
        timeoutMs: positiveInteger(settings.timeoutMs, 1800000)
      };
    }

    const existingRuntime = config.runtimes[runtimeId];
    if (!existingRuntime || existingRuntime.recipe?.id === recipe.id) {
      const runtime = buildRecipeRuntime({
        recipe,
        recipeModel,
        backendId,
        runtimeId,
        modelPath,
        modelRoot,
        modelId,
        port,
        sessionCacheRoot
      });
      if (runtime) config.runtimes[runtimeId] = runtime;
    }

    const materializedModel = {
      id: modelId,
      name: recipeModel.name ?? modelId.split('/').at(-1),
      backend: backendConfigId,
      ...(config.runtimes[runtimeId] ? { runtime: runtimeId } : {}),
      upstreamModel: recipeModel.model,
      kind: recipeModelKind(recipeModel),
      input: recipeModelInput(recipeModel),
      output: recipeModelOutput(recipeModel),
      capabilities: asArray(recipeModel.capabilities),
      reasoning: asArray(recipeModel.capabilities).includes('reasoning') || undefined,
      supportsTools: asArray(recipeModel.capabilities).includes('tools') || undefined,
      contextWindow: positiveInteger(asObject(recipeModel.settings).contextWindow, 32768),
      maxOutputTokens: positiveInteger(asObject(recipeModel.settings).maxOutputTokens, 8192),
      advertise: true,
      tags: [
        ...new Set([recipe.backend?.id, ...asArray(recipe.keywords), ...asArray(recipe.capabilities)].filter(Boolean))
      ]
    };
    if (!existingModel) {
      config.models.push(materializedModel);
    } else if (config.runtimes[runtimeId]?.recipe?.id === recipe.id) {
      Object.assign(existingModel, materializedModel);
    }

    if (!config.clientCatalog.modelOrder.includes(modelId)) {
      config.clientCatalog.modelOrder.push(modelId);
    }
    if (recipeModel.setDefault === true) {
      config.defaults ??= {};
      const kind = materializedModel.kind;
      if (kind === 'image') config.defaults.imageModel = modelId;
      else if (kind === 'video') config.defaults.videoModel = modelId;
      else if (kind === 'embedding') config.defaults.embeddingModel = modelId;
      else if (kind === 'audio_speech') config.defaults.speechModel = modelId;
      else if (kind === 'audio_transcription') config.defaults.transcriptionModel = modelId;
      else config.defaults.chatModel = modelId;
    }
    if (recipeModel.role === 'default-video' && !config.defaults?.videoModel) {
      config.defaults ??= {};
      config.defaults.videoModel = modelId;
    }
    if (recipeModel.role === 'embedding' && !config.defaults?.embeddingModel) {
      config.defaults ??= {};
      config.defaults.embeddingModel = modelId;
    }
  }
}

function isChatRecipeModel(model) {
  const capabilities = new Set(Array.isArray(model?.capabilities) ? model.capabilities : []);
  return (
    Boolean(model?.gatewayModel) &&
    (capabilities.has('chat') || capabilities.has('responses') || capabilities.has('anthropic-messages'))
  );
}

function preferredRecipeModel(config, recipe) {
  const chatModels = (recipe.models ?? []).filter(isChatRecipeModel);
  if (!chatModels.length) return null;
  const fastestObserved = chatModels
    .filter((model) => recipeModelSpeed(model) > 0)
    .sort((left, right) => recipeModelSpeed(right) - recipeModelSpeed(left))[0];
  if (fastestObserved) return fastestObserved;
  const defaultModel = config.defaults?.chatModel;
  return chatModels.find((model) => model.gatewayModel === defaultModel) ?? chatModels[0];
}

function retargetRuntimeModelArg(runtime, modelRoot, modelId) {
  if (!modelRoot || !Array.isArray(runtime.args)) return;
  const index = runtime.args.indexOf('--model');
  if (index === -1 || index === runtime.args.length - 1) return;
  const currentModelPath = String(runtime.args[index + 1] ?? '');
  const mtplxCacheSegment = modelId.replace(/\//g, '--');
  const pathSegment = path.basename(currentModelPath) === mtplxCacheSegment ? mtplxCacheSegment : modelId;
  runtime.args[index + 1] = path.join(modelRoot, pathSegment);
}

function replaceArgValue(args, flag, value) {
  if (!Array.isArray(args)) return;
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return;
  args[index + 1] = String(value);
}

function rewriteUrlPort(value, port) {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.port = String(port);
    return url.toString();
  } catch {
    return value;
  }
}

function retargetRuntimePort(runtime, port) {
  if (!runtime) return;
  runtime.port = port;
  runtime.healthUrl = rewriteUrlPort(runtime.healthUrl, port);
  replaceArgValue(runtime.args, '--port', port);
  if (runtime.warmup?.url) runtime.warmup.url = rewriteUrlPort(runtime.warmup.url, port);
}

function retargetRuntimeSessionCache(runtime, sessionCacheRoot, runtimeId) {
  if (!sessionCacheRoot || !runtime?.sessionCache) return;
  runtime.sessionCache.dir = path.join(sessionCacheRoot, runtimeId);
}

function retargetGatewayPort(config, gatewayPort) {
  if (!gatewayPort) return null;
  const port = asPort(gatewayPort, 'gateway port');
  config.server = {
    host: '127.0.0.1',
    ...(config.server ?? {}),
    port
  };
  const provider = config.providers?.['local-llm'];
  if (provider) {
    provider.baseUrl = rewriteUrlPort(provider.baseUrl ?? `http://${config.server.host}:${port}/v1`, port);
  }
  return port;
}

function backendIdsForRuntime(config, runtimeId) {
  return [
    ...new Set(
      (config.models ?? [])
        .filter((model) => model.runtime === runtimeId && model.backend)
        .map((model) => model.backend)
    )
  ];
}

function retargetBackendBaseUrls(config, runtimeId, port) {
  for (const backendId of backendIdsForRuntime(config, runtimeId)) {
    const backend = config.backends?.[backendId];
    if (backend?.baseUrl) backend.baseUrl = rewriteUrlPort(backend.baseUrl, port);
  }
}

function setAliasAdvertise(alias, advertise) {
  if (typeof alias === 'string') {
    return {
      target: alias,
      advertise
    };
  }
  return {
    ...alias,
    advertise
  };
}

function restrictAdvertisedModelsToRecipe(config, recipe) {
  const selectedModelIds = recipeModelIds(recipe);
  const advertisedModelIds = new Set();
  for (const model of config.models ?? []) {
    const selected =
      selectedModelIds.has(model.id) ||
      selectedModelIds.has(model.gatewayModel) ||
      selectedModelIds.has(model.upstreamModel);
    model.advertise = selected;
    if (selected) advertisedModelIds.add(model.id);
  }

  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    const target = typeof alias === 'string' ? alias : alias.target;
    const selected = selectedModelIds.has(aliasId) || selectedModelIds.has(target) || advertisedModelIds.has(target);
    config.aliases[aliasId] = setAliasAdvertise(alias, selected);
  }

  for (const key of ['chatModel', 'imageModel', 'videoModel', 'embeddingModel', 'speechModel', 'transcriptionModel']) {
    const modelId = config.defaults?.[key];
    if (modelId && !advertisedModelIds.has(modelId)) delete config.defaults[key];
  }
}

function retargetBackendPorts(config, runtimeIds, backendPortRange) {
  const range = normalizeBackendPortRange(backendPortRange);
  if (!range) return null;
  const needed = runtimeIds.length;
  const available = range.end - range.start + 1;
  if (needed > available) {
    throw new Error(`backend port range has ${available} ports but ${needed} recipe runtimes need ports`);
  }
  const assigned = {};
  runtimeIds.forEach((runtimeId, index) => {
    const port = range.start + index;
    assigned[runtimeId] = port;
    retargetRuntimePort(config.runtimes?.[runtimeId], port);
    retargetBackendBaseUrls(config, runtimeId, port);
  });
  return {
    range,
    assigned
  };
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function customHomeArg(home) {
  return home && home !== process.env.HOME ? ['--home', shellArg(home)] : [];
}

function initCommand({
  configPath,
  modelRoot,
  gatewayPort,
  backendPortRange,
  recipeId,
  clientId,
  home,
  generatedRoot,
  apply = false,
  integrate = false
} = {}) {
  const args = ['lloom', 'init'];
  if (recipeId) args.push('--recipe', shellArg(recipeId));
  args.push(...customHomeArg(home));
  if (generatedRoot) args.push('--generated-root', shellArg(generatedRoot));
  if (configPath) args.push('--config-out', shellArg(configPath));
  if (modelRoot) args.push('--model-root', shellArg(modelRoot));
  if (gatewayPort) args.push('--port', shellArg(gatewayPort));
  if (backendPortRange) args.push('--backend-port-range', shellArg(backendPortRange));
  if (clientId && clientId !== 'all') args.push('--client', shellArg(clientId));
  if (apply) args.push('--apply', '--yes');
  if (integrate) args.push('--integrate');
  return args.join(' ');
}

export function deriveUserConfig(
  config,
  recipe,
  {
    modelRoot,
    sessionCacheRoot,
    gatewayPort,
    backendPortRange,
    enableRecipeRuntimes = true,
    keepWarmRuntimeId,
    recipesRoot,
    benchmarksRoot,
    backendCatalogPath,
    additive = false
  } = {}
) {
  const sourceTemplate = config.sourceTemplate;
  const derived = stripRuntimeFields(config);
  const runtimeIds = recipeRuntimeIds(recipe);
  if (additive) {
    derived.clientCatalog ??= {};
    derived.clientCatalog.modelOrder ??= [];
    for (const model of derived.models ?? []) {
      if (model?.id && model.advertise !== false && !derived.clientCatalog.modelOrder.includes(model.id)) {
        derived.clientCatalog.modelOrder.push(model.id);
      }
    }
  }
  ensureRecipeConfigEntries(derived, recipe, {
    modelRoot,
    sessionCacheRoot
  });
  const preferredModel = preferredRecipeModel(derived, recipe);
  if (!additive && preferredModel?.gatewayModel) {
    derived.defaults = {
      ...(derived.defaults ?? {}),
      chatModel: preferredModel.gatewayModel
    };
  }
  if (!additive) restrictAdvertisedModelsToRecipe(derived, recipe);
  const existingKeepWarm = Object.entries(derived.runtimes ?? {})
    .filter(([, runtime]) => runtime.keepWarm === true)
    .map(([runtimeId]) => runtimeId);
  const requestedRecipeKeepWarm = (recipe.models ?? [])
    .filter((model) => model.settings?.keepWarm === true && model.runtime)
    .map((model) => model.runtime);
  const recipeHasExplicitKeepWarm = (recipe.models ?? []).some(
    (model) => typeof model.settings?.keepWarm === 'boolean'
  );
  const keepWarm =
    keepWarmRuntimeId !== undefined
      ? keepWarmRuntimeId
      : recipeHasExplicitKeepWarm
        ? (requestedRecipeKeepWarm[0] ?? null)
        : (preferredModel?.runtime ?? defaultKeepWarmRuntime(derived, recipe));

  for (const recipeModel of recipe.models ?? []) {
    const runtimeId = recipeModel.runtime;
    if (!runtimeId || !derived.runtimes?.[runtimeId]) continue;
    if (enableRecipeRuntimes) derived.runtimes[runtimeId].enabled = true;
    retargetRuntimeModelArg(derived.runtimes[runtimeId], modelRoot, recipeModel.model);
    retargetRuntimeSessionCache(derived.runtimes[runtimeId], sessionCacheRoot, runtimeId);
  }

  derived.paths = {
    ...(derived.paths ?? {}),
    ...(modelRoot ? { modelRoot } : {}),
    ...(sessionCacheRoot ? { sessionCacheRoot } : {})
  };
  const ports = {
    ...(derived.ports ?? {}),
    ...(gatewayPort ? { gateway: retargetGatewayPort(derived, gatewayPort) } : {})
  };
  const backendPorts = retargetBackendPorts(derived, runtimeIds, backendPortRange);
  if (backendPorts) ports.backends = backendPorts;
  if (Object.keys(ports).length) derived.ports = ports;
  const keepWarmRuntimeIds = additive
    ? [...new Set([...existingKeepWarm, ...requestedRecipeKeepWarm])]
    : keepWarm
      ? [keepWarm]
      : [];
  for (const [runtimeId, runtime] of Object.entries(derived.runtimes ?? {})) {
    runtime.keepWarm = keepWarmRuntimeIds.includes(runtimeId);
  }
  delete derived.keepWarm;
  derived.init = {
    ...(derived.init ?? {}),
    recipeId: recipe.id,
    generatedAt: new Date().toISOString(),
    enabledRuntimes: additive ? [...new Set([...(derived.init?.enabledRuntimes ?? []), ...runtimeIds])] : runtimeIds,
    keepWarmRuntime: additive ? null : keepWarm,
    additive,
    ...(recipesRoot ? { recipesRoot } : {}),
    ...(benchmarksRoot ? { benchmarksRoot } : {}),
    ...(backendCatalogPath ? { backendCatalogPath } : {})
  };
  return preserveEnvBackedSecrets(derived, sourceTemplate);
}

async function selectRecipe({ recipeId, recipes, profile, recipesRoot }) {
  if (recipeId) {
    return recipes.find((candidate) => candidate.id === recipeId) ?? loadRecipeById(recipeId, recipesRoot);
  }
  // First-run onboarding selects a conversational baseline. Additive capability
  // recipes (embeddings, image, video, audio) remain explicit installs and must
  // not become the default merely because they have smaller requirements.
  const ranked = await rankRecipes(
    recipes.filter((recipe) => (recipe.models ?? []).some(isChatRecipeModel)),
    profile,
    { checkCommands: true }
  );
  const selected = ranked.find((candidate) => candidate.selectable);
  if (!selected) throw new Error('No selectable recipe for this machine');
  return recipes.find((recipe) => recipe.id === selected.recipeId);
}

function integrationPlan(config, home, generatedRoot, clientId = 'all') {
  const registry = createRegistry(config);
  const artifacts = buildIntegrationArtifacts(config, registry, { home, generatedRoot });
  const selected = selectIntegrationArtifacts(artifacts, clientId);
  if (!selected.length) throw new Error(`Unknown integration client ${clientId}`);
  return selected.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    mode: artifact.mode,
    generatedPath: artifact.generatedPath,
    targetPath: artifact.targetPath,
    notes: artifact.notes
  }));
}

export async function createInitPlan(
  config,
  {
    recipeId,
    home = process.env.HOME,
    configPath,
    modelRoot,
    gatewayPort,
    backendPortRange,
    generatedRoot = defaultGeneratedRoot(home),
    clientId = 'all',
    enableRecipeRuntimes = true,
    backendVariables = defaultBackendVariables(process.env),
    benchmarksRoot,
    recipesRoot,
    recipeDocuments = [],
    backendCatalogPath,
    autoDetectModelRoot = false,
    additive = false
  } = {}
) {
  const effectiveConfigPath = configPath ?? defaultUserConfigPath(home);
  const effectiveSessionCacheRoot = defaultSessionCacheRoot(home);
  const profile = await profileMachine();
  const recipes = [...recipeDocuments, ...(await loadRecipes(recipesRoot))];
  const recipe = await selectRecipe({ recipeId, recipes, profile, recipesRoot });
  const catalog = await loadBackendCatalog(backendCatalogPath);
  const backend = getBackend(catalog, recipe.backend?.id);
  if (!backend) throw new Error(`Recipe ${recipe.id} references unknown backend ${recipe.backend?.id}`);
  const modelRootDetection = autoDetectModelRoot
    ? await detectModelRootForRecipe(recipe, {
        config,
        explicitModelRoot: modelRoot,
        home
      })
    : {
        modelRoot: modelRoot ?? path.join(defaultHome(home), 'models'),
        detected: false,
        candidates: []
      };
  const effectiveModelRoot = modelRootDetection.modelRoot;
  const userConfig = deriveUserConfig(config, recipe, {
    modelRoot: effectiveModelRoot,
    sessionCacheRoot: effectiveSessionCacheRoot,
    gatewayPort,
    backendPortRange,
    enableRecipeRuntimes,
    recipesRoot,
    benchmarksRoot,
    backendCatalogPath,
    additive
  });

  return {
    dryRun: true,
    profile,
    selectedRecipe: {
      id: recipe.id,
      name: recipe.name,
      backendId: recipe.backend?.id
    },
    configPath: effectiveConfigPath,
    modelRoot: effectiveModelRoot,
    modelRootDetected: modelRootDetection.detected,
    modelRootCandidates: modelRootDetection.candidates,
    sessionCacheRoot: effectiveSessionCacheRoot,
    ports: userConfig.ports ?? {},
    enabledRuntimes: recipeRuntimeIds(recipe),
    keepWarm: Object.entries(userConfig.runtimes ?? {})
      .filter(([, runtime]) => runtime.keepWarm === true)
      .map(([runtimeId]) => runtimeId),
    backend: await planBackend(backend, {
      variables: backendVariables,
      checkCommands: true
    }),
    integrations: integrationPlan(userConfig, home, generatedRoot, clientId),
    next: {
      review: initCommand({
        recipeId: recipe.id,
        configPath: effectiveConfigPath,
        modelRoot: effectiveModelRoot,
        gatewayPort,
        backendPortRange,
        clientId,
        home,
        generatedRoot
      }),
      apply: initCommand({
        recipeId: recipe.id,
        configPath: effectiveConfigPath,
        modelRoot: effectiveModelRoot,
        gatewayPort,
        backendPortRange,
        clientId,
        home,
        generatedRoot,
        apply: true
      }),
      integrate: initCommand({
        recipeId: recipe.id,
        configPath: effectiveConfigPath,
        modelRoot: effectiveModelRoot,
        gatewayPort,
        backendPortRange,
        clientId,
        home,
        generatedRoot,
        apply: true,
        integrate: true
      }),
      bootstrap: `lloom bootstrap --config ${shellArg(effectiveConfigPath)} --apply --yes`,
      serve: `lloom serve --config ${shellArg(effectiveConfigPath)}`,
      pathHint: `export PATH="${backendVariables.shimDir}:$PATH"`
    },
    config: userConfig
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function applyInit(config, { dryRun = true, yes = false, integrate = false, ...options } = {}) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to initialize LLooM without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }
  const plan = await createInitPlan(config, options);
  if (dryRun) return plan;

  await writeJson(plan.configPath, plan.config);
  const registry = createRegistry(plan.config);
  const generatedClients = await writeGeneratedIntegrationArtifacts(plan.config, registry, {
    clientId: options.clientId ?? 'all',
    home: options.home ?? process.env.HOME,
    generatedRoot: options.generatedRoot ?? defaultGeneratedRoot(options.home ?? process.env.HOME)
  });
  const integrationResult = integrate
    ? await applyIntegrationArtifacts(plan.config, registry, {
        clientId: options.clientId ?? 'all',
        dryRun: false,
        yes,
        home: options.home ?? process.env.HOME,
        generatedRoot: options.generatedRoot ?? defaultGeneratedRoot(options.home ?? process.env.HOME)
      })
    : { dryRun: true, results: plan.integrations.map((integration) => ({ ...integration, status: 'not-applied' })) };

  return {
    ...plan,
    dryRun: false,
    written: {
      configPath: plan.configPath,
      generatedClients,
      integrations: integrationResult
    }
  };
}
