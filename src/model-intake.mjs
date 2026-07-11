import fs from 'node:fs/promises';
import path from 'node:path';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expandHome(value, home = process.env.HOME) {
  if (typeof value === 'string' && value.startsWith('~/') && home) {
    return path.join(home, value.slice(2));
  }
  return value;
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

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellCommand(command) {
  return command.map(shellArg).join(' ');
}

function repoCacheName(repoId) {
  return repoId.replace(/\//g, '--');
}

function canonicalHuggingFaceRef({ repoId, revision, filePath }) {
  const ref = revision && revision !== 'main' ? `${repoId}@${revision}` : repoId;
  return filePath ? `${ref}/${filePath}` : ref;
}

function isHuggingFaceRepoId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function parseHuggingFaceUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!['huggingface.co', 'www.huggingface.co', 'hf.co', 'www.hf.co'].includes(url.hostname)) {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repoId = `${parts[0]}/${parts[1]}`;
  const markerIndex = parts.findIndex((part) => ['blob', 'resolve', 'tree'].includes(part));
  const marker = markerIndex >= 0 ? parts[markerIndex] : null;
  const revision = marker ? (parts[markerIndex + 1] ?? null) : null;
  const filePath = marker && marker !== 'tree' ? parts.slice(markerIndex + 2).join('/') || null : null;
  return {
    type: 'huggingface',
    input,
    repoId,
    modelId: repoId,
    filePath,
    revision,
    canonical: canonicalHuggingFaceRef({ repoId, revision, filePath })
  };
}

function ensureOpenAIBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid OpenAI-compatible base URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`OpenAI-compatible base URL must use http or https: ${value}`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function parseExternalOpenAIReference(value) {
  if (!value.startsWith('openai:')) return null;
  const raw = value.slice('openai:'.length);
  const hashIndex = raw.lastIndexOf('#');
  if (hashIndex <= 0 || hashIndex === raw.length - 1) {
    throw new Error('OpenAI-compatible model references must use openai:<base-url>#<model-id>');
  }
  const baseUrl = ensureOpenAIBaseUrl(raw.slice(0, hashIndex));
  const modelId = decodeURIComponent(raw.slice(hashIndex + 1)).trim();
  if (!modelId) throw new Error('OpenAI-compatible model reference is missing model id');
  return {
    type: 'openai-compatible',
    input: value,
    modelId,
    baseUrl,
    canonical: `openai:${baseUrl}#${encodeURIComponent(modelId)}`
  };
}

function parseLmStudioReference(value) {
  const match = value.match(/^lm-?studio:(.+)$/i);
  if (!match) return null;
  const modelId = match[1].trim();
  if (!modelId) throw new Error('LM Studio model reference is missing model id');
  return {
    type: 'lm-studio',
    input: value,
    modelId,
    baseUrl: 'http://127.0.0.1:1234/v1',
    canonical: `lmstudio:${modelId}`
  };
}

export function normalizeModelReference(input, { home = process.env.HOME } = {}) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('model reference is required');

  const openAIReference = parseExternalOpenAIReference(value);
  if (openAIReference) return openAIReference;

  const lmStudioReference = parseLmStudioReference(value);
  if (lmStudioReference) return lmStudioReference;

  const hfUrl = parseHuggingFaceUrl(value);
  if (hfUrl) return hfUrl;

  if (isHuggingFaceRepoId(value)) {
    return {
      type: 'huggingface',
      input: value,
      repoId: value,
      modelId: value,
      filePath: null,
      revision: null,
      canonical: value
    };
  }

  if (/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(value)) {
    return {
      type: 'ollama',
      input: value,
      modelId: value,
      canonical: value
    };
  }

  const expanded = expandHome(value, home);
  if (expanded.startsWith('/') || expanded.startsWith('.')) {
    const localPath = path.resolve(expanded);
    return {
      type: 'local',
      input: value,
      localPath,
      modelId: path.basename(localPath),
      canonical: localPath
    };
  }

  throw new Error(`unsupported model reference: ${input}`);
}

export function inferBackend(reference, { backend, platform = process.platform, arch = process.arch } = {}) {
  if (backend) {
    return {
      backend,
      confidence: 'override',
      reason: 'explicit backend override'
    };
  }

  if (reference.type === 'ollama') {
    return { backend: 'ollama', confidence: 'high', reason: 'Ollama tag syntax' };
  }
  if (reference.type === 'lm-studio') {
    return { backend: 'lm-studio', confidence: 'high', reason: 'LM Studio model reference' };
  }
  if (reference.type === 'openai-compatible') {
    return { backend: 'openai-compatible', confidence: 'high', reason: 'explicit OpenAI-compatible endpoint' };
  }

  const text = [reference.repoId, reference.filePath, reference.localPath, reference.modelId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (text.includes('.gguf') || text.includes('gguf')) {
    return { backend: 'llama-cpp', confidence: 'high', reason: 'GGUF artifact' };
  }
  if (text.includes('mtplx')) {
    return { backend: 'mtplx', confidence: 'high', reason: 'MTPLX-optimized artifact' };
  }
  if (text.includes('vllm')) {
    return { backend: 'vllm', confidence: 'medium', reason: 'vLLM model reference' };
  }
  if (text.includes('sglang')) {
    return { backend: 'sglang', confidence: 'medium', reason: 'SGLang model reference' };
  }
  if (
    text.includes('tts') ||
    text.includes('whisper') ||
    text.includes('asr') ||
    text.includes('parakeet') ||
    text.includes('kokoro') ||
    text.includes('speech')
  ) {
    return { backend: 'mlx-audio', confidence: 'high', reason: 'audio TTS/STT model naming' };
  }
  if (text.includes('mlx-community/') || text.includes('mlx') || text.includes('-4bit') || text.includes('-8bit')) {
    return { backend: 'mlx-lm', confidence: 'medium', reason: 'MLX-style model naming' };
  }
  if (text.includes('optiq')) {
    return {
      backend: 'mlx-lm',
      confidence: 'low',
      reason: 'OptiQ artifact; MLX LM is the nearest generic Apple backend'
    };
  }

  if (platform === 'darwin' && arch === 'arm64') {
    return { backend: 'mlx-lm', confidence: 'low', reason: 'Apple Silicon default' };
  }
  return { backend: 'llama-cpp', confidence: 'low', reason: 'portable default backend' };
}

function urlWithPort(port, suffix = '/v1') {
  return `http://127.0.0.1:${port}${suffix}`;
}

function portFromBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!url.port) return null;
    return Number(url.port);
  } catch {
    return null;
  }
}

function baseUrlWithPort(baseUrl, port) {
  if (port == null) return ensureOpenAIBaseUrl(baseUrl);
  const url = new URL(ensureOpenAIBaseUrl(baseUrl));
  url.port = String(port);
  return url.toString().replace(/\/+$/, '');
}

function usedPorts(config) {
  const ports = new Set();
  for (const runtime of Object.values(config.runtimes ?? {})) {
    if (Number.isInteger(Number(runtime.port))) ports.add(Number(runtime.port));
  }
  for (const backend of Object.values(config.backends ?? {})) {
    const port = portFromBaseUrl(backend.baseUrl);
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

export function nextBackendPort(config, preferredPort) {
  if (preferredPort != null) {
    const port = Number(preferredPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port must be an integer from 1 to 65535');
    }
    return port;
  }
  const start = Number(config.ports?.backends?.start ?? config.ports?.backends?.range?.start ?? 8201);
  const end = Number(config.ports?.backends?.end ?? config.ports?.backends?.range?.end ?? 8299);
  const taken = usedPorts(config);
  for (let port = start; port <= end; port += 1) {
    if (!taken.has(port)) return port;
  }
  throw new Error(`no free backend port in configured range ${start}-${end}`);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function modelPathFor(reference, backend, modelRoot) {
  if (['openai-compatible', 'lm-studio'].includes(reference.type)) return reference.modelId;
  if (reference.type === 'ollama') return reference.modelId;
  if (reference.type === 'local') return reference.localPath;
  const root = modelRoot ?? '${LLOOM_MODEL_ROOT}';
  const base = path.join(root, repoCacheName(reference.repoId));
  if (reference.filePath) return path.join(base, reference.filePath);
  if (backend === 'mtplx') return base;
  return base;
}

function downloadCommandFor(reference, modelRoot) {
  if (reference.type === 'ollama') return ['ollama', 'pull', reference.modelId];
  if (reference.type !== 'huggingface') return null;
  const destination = path.join(modelRoot ?? '${LLOOM_MODEL_ROOT}', repoCacheName(reference.repoId));
  return [
    'hf',
    'download',
    reference.repoId,
    ...(reference.filePath ? [reference.filePath] : []),
    ...(reference.revision && reference.revision !== 'main' ? ['--revision', reference.revision] : []),
    '--local-dir',
    destination
  ];
}

function runtimeForBackend({ backend, runtimeId, modelPath, port, modelId, contextWindow, sessionCacheRoot }) {
  if (['openai-compatible', 'lm-studio'].includes(backend)) return null;

  const healthPath = backend === 'mlx-lm' ? '/v1/models' : '/health';
  const warmup = {
    url: urlWithPort(port, '/v1/chat/completions'),
    method: 'POST',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 2,
      stream: false
    }
  };

  if (backend === 'mtplx') {
    return {
      enabled: true,
      command: 'mtplx',
      args: ['serve', '--model', modelPath, '--host', '127.0.0.1', '--port', String(port)],
      sessionCache: {
        kind: 'mtplx-ssd-session',
        mode: 'on',
        dir: path.join(sessionCacheRoot ?? '${LLOOM_SESSION_CACHE_ROOT}', runtimeId),
        maxSize: '100GB',
        minPrefixTokens: 512
      },
      port,
      healthUrl: urlWithPort(port, healthPath),
      startupTimeoutMs: 900000,
      maxConcurrency: 10,
      warmup
    };
  }

  if (backend === 'mlx-lm') {
    return {
      enabled: true,
      command: 'mlx_lm.server',
      args: ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port)],
      port,
      healthUrl: urlWithPort(port, healthPath),
      startupTimeoutMs: 900000,
      maxConcurrency: 4,
      warmup
    };
  }

  if (backend === 'mlx-audio') {
    return {
      enabled: true,
      command: 'lloom-audio-server',
      args: ['--host', '127.0.0.1', '--port', String(port)],
      port,
      healthUrl: urlWithPort(port, '/health'),
      startupTimeoutMs: 900000,
      maxConcurrency: 1,
      memoryGb: 6
    };
  }

  if (backend === 'llama-cpp') {
    return {
      enabled: true,
      command: 'llama-server',
      args: ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', String(contextWindow)],
      sessionCache: {
        kind: 'llama-cpp-kv-cache',
        mode: 'on',
        dir: path.join(sessionCacheRoot ?? '${LLOOM_SESSION_CACHE_ROOT}', runtimeId),
        minPrefixTokens: 256
      },
      port,
      healthUrl: urlWithPort(port, healthPath),
      startupTimeoutMs: 900000,
      maxConcurrency: 4,
      warmup
    };
  }

  if (backend === 'vllm') {
    return {
      enabled: true,
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
      port,
      healthUrl: urlWithPort(port, '/health'),
      startupTimeoutMs: 900000,
      maxConcurrency: 4,
      memoryGb: 96,
      warmup
    };
  }

  if (backend === 'sglang') {
    return {
      enabled: true,
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
      port,
      healthUrl: urlWithPort(port, '/health'),
      startupTimeoutMs: 900000,
      maxConcurrency: 4,
      memoryGb: 96,
      warmup
    };
  }

  if (backend === 'ollama') {
    return {
      enabled: true,
      command: 'ollama',
      args: ['serve'],
      env: {
        OLLAMA_HOST: `127.0.0.1:${port}`
      },
      port,
      healthUrl: urlWithPort(port, '/api/tags'),
      startupTimeoutMs: 300000,
      maxConcurrency: 4,
      warmup
    };
  }

  throw new Error(`add-model does not know how to start backend ${backend}`);
}

function inferAudioKind(reference) {
  const text = [reference.repoId, reference.filePath, reference.localPath, reference.modelId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (
    text.includes('whisper') ||
    text.includes('asr') ||
    text.includes('parakeet') ||
    text.includes('transcri') ||
    text.includes('stt')
  ) {
    return 'audio_transcription';
  }
  if (text.includes('tts') || text.includes('kokoro') || text.includes('speech')) {
    return 'audio_speech';
  }
  return null;
}

function modelCapabilitiesForBackend(backend, reference) {
  if (backend === 'mlx-audio') {
    const kind = inferAudioKind(reference);
    if (kind === 'audio_transcription') return ['audio-transcription', 'stt', 'mlx'];
    return ['audio-speech', 'tts', 'mlx'];
  }
  const capabilities = ['chat', 'streaming'];
  if (['openai-compatible', 'lm-studio'].includes(backend)) capabilities.push('usage', 'tools');
  if (['mtplx', 'llama-cpp'].includes(backend)) capabilities.push('usage', 'tools', 'long-context');
  if (['vllm', 'sglang'].includes(backend)) capabilities.push('usage', 'tools', 'long-context', 'batching');
  if (backend === 'mtplx') capabilities.push('reasoning', 'mtp');
  if (backend === 'mlx-lm') capabilities.push('mlx');
  if (backend === 'llama-cpp') capabilities.push('gguf');
  if (backend === 'vllm') capabilities.push('cuda');
  if (backend === 'sglang') capabilities.push('cuda', 'rocm');
  if (reference.filePath?.toLowerCase().includes('vision') || reference.modelId.toLowerCase().includes('vl')) {
    capabilities.push('vision');
  }
  return [...new Set(capabilities)];
}

function addModelCommand({
  modelRef,
  configPath,
  backend,
  modelRoot,
  sessionCacheRoot,
  modelId,
  name,
  port,
  contextWindow,
  maxOutputTokens,
  apiKeyEnv,
  keepWarm,
  setDefault,
  apply = false
} = {}) {
  const args = ['lloom', 'add-model', shellArg(modelRef)];
  if (configPath) args.push('--config', shellArg(configPath));
  if (backend) args.push('--backend', shellArg(backend));
  if (modelRoot && !String(modelRoot).includes('${')) args.push('--model-root', shellArg(modelRoot));
  if (sessionCacheRoot && !String(sessionCacheRoot).includes('${')) {
    args.push('--session-cache-root', shellArg(sessionCacheRoot));
  }
  if (modelId) args.push('--model-id', shellArg(modelId));
  if (name) args.push('--name', shellArg(name));
  if (port != null) args.push('--port', shellArg(port));
  if (contextWindow != null) args.push('--context-window', shellArg(contextWindow));
  if (maxOutputTokens != null) args.push('--max-output-tokens', shellArg(maxOutputTokens));
  if (apiKeyEnv) args.push('--api-key-env', shellArg(apiKeyEnv));
  if (keepWarm) args.push('--keep-warm');
  if (setDefault) args.push('--default');
  if (apply) args.push('--apply', '--yes');
  return args.join(' ');
}

export function createModelImportPlan(
  config,
  {
    modelRef,
    backend,
    modelRoot = config.paths?.modelRoot ?? '${LLOOM_MODEL_ROOT}',
    sessionCacheRoot = config.paths?.sessionCacheRoot ?? '${LLOOM_SESSION_CACHE_ROOT}',
    configPath = config.sourcePath,
    modelId,
    name,
    port,
    contextWindow = 32768,
    maxOutputTokens = 8192,
    apiKeyEnv,
    keepWarm = false,
    setDefault = false,
    platform = process.platform,
    arch = process.arch
  } = {}
) {
  const reference = normalizeModelReference(modelRef);
  const inference = inferBackend(reference, { backend, platform, arch });
  const backendId = inference.backend;
  const selectedApiKeyEnv = apiKeyEnv == null ? null : String(apiKeyEnv).trim();
  if (selectedApiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(selectedApiKeyEnv)) {
    throw new Error('apiKeyEnv must be a valid environment variable name');
  }
  if (selectedApiKeyEnv && !['openai-compatible', 'lm-studio'].includes(backendId)) {
    throw new Error('apiKeyEnv is only supported for external OpenAI-compatible backends');
  }
  const selectedContextWindow = positiveInteger(contextWindow, 'contextWindow');
  const selectedMaxOutputTokens = positiveInteger(maxOutputTokens, 'maxOutputTokens');
  const resolvedModelId = modelId ?? reference.modelId;
  const idSlug = slug(resolvedModelId);
  const backendConfigId = `${backendId}-${idSlug}`;
  const runtimeId = `${backendId}-${idSlug}`;
  const externalBaseUrl = ['openai-compatible', 'lm-studio'].includes(backendId)
    ? baseUrlWithPort(reference.baseUrl, port)
    : null;
  const selectedPort = externalBaseUrl
    ? portFromBaseUrl(externalBaseUrl)
    : backendId === 'ollama' && port == null
      ? nextBackendPort(config, 11434)
      : nextBackendPort(config, port);
  const modelPath = modelPathFor(reference, backendId, modelRoot);
  const downloadCommand = downloadCommandFor(reference, modelRoot);
  const runtime = runtimeForBackend({
    backend: backendId,
    runtimeId,
    modelPath,
    port: selectedPort,
    modelId: resolvedModelId,
    contextWindow: selectedContextWindow,
    sessionCacheRoot
  });

  if (config.models?.some((model) => model.id === resolvedModelId)) {
    throw new Error(`model ${resolvedModelId} already exists in config`);
  }
  if (config.backends?.[backendConfigId]) {
    throw new Error(`backend ${backendConfigId} already exists in config`);
  }
  if (runtime && config.runtimes?.[runtimeId]) {
    throw new Error(`runtime ${runtimeId} already exists in config`);
  }

  const nextConfig = clone(config.sourceTemplate ?? config);
  delete nextConfig.sourcePath;
  nextConfig.backends ??= {};
  nextConfig.runtimes ??= {};
  nextConfig.models ??= [];
  nextConfig.aliases ??= {};
  nextConfig.clientCatalog ??= {};
  nextConfig.clientCatalog.modelOrder ??= [];
  nextConfig.paths ??= {};
  if (modelRoot && !String(modelRoot).includes('${')) nextConfig.paths.modelRoot = modelRoot;
  if (sessionCacheRoot && !String(sessionCacheRoot).includes('${'))
    nextConfig.paths.sessionCacheRoot = sessionCacheRoot;

  nextConfig.backends[backendConfigId] = {
    type: 'openai',
    baseUrl: externalBaseUrl ?? urlWithPort(selectedPort, '/v1'),
    ...(selectedApiKeyEnv ? { apiKeyEnv: selectedApiKeyEnv } : { apiKey: 'sk-local-llm' }),
    timeoutMs: 1800000
  };
  if (runtime) nextConfig.runtimes[runtimeId] = runtime;
  const capabilities = modelCapabilitiesForBackend(backendId, reference);
  const audioKind = backendId === 'mlx-audio' ? inferAudioKind(reference) : null;
  const kind = audioKind ?? 'chat';
  const input = kind === 'audio_transcription' ? ['audio'] : ['text'];
  const output = kind === 'audio_speech' ? ['audio'] : ['text'];
  nextConfig.models.push({
    id: resolvedModelId,
    name: name ?? resolvedModelId.split('/').at(-1),
    backend: backendConfigId,
    ...(runtime ? { runtime: runtimeId } : {}),
    upstreamModel: resolvedModelId,
    kind,
    input,
    output,
    capabilities,
    contextWindow: selectedContextWindow,
    maxOutputTokens: selectedMaxOutputTokens,
    advertise: true,
    tags: [...new Set([backendId, reference.type])]
  });
  if (!nextConfig.clientCatalog.modelOrder.includes(resolvedModelId)) {
    nextConfig.clientCatalog.modelOrder.push(resolvedModelId);
  }
  if (keepWarm && runtime) {
    nextConfig.keepWarm = [...new Set([...(nextConfig.keepWarm ?? []), runtimeId])];
  }
  if (setDefault) {
    nextConfig.defaults ??= {};
    if (kind === 'audio_speech') nextConfig.defaults.speechModel = resolvedModelId;
    else if (kind === 'audio_transcription') nextConfig.defaults.transcriptionModel = resolvedModelId;
    else nextConfig.defaults.chatModel = resolvedModelId;
  }

  return {
    dryRun: true,
    input: modelRef,
    reference,
    inference,
    modelRoot,
    download: downloadCommand
      ? {
          command: downloadCommand,
          shellCommand: shellCommand(downloadCommand)
        }
      : null,
    additions: {
      backendId: backendConfigId,
      runtimeId: runtime ? runtimeId : null,
      modelId: resolvedModelId,
      port: selectedPort,
      modelPath,
      baseUrl: externalBaseUrl ?? urlWithPort(selectedPort, '/v1'),
      apiKeyEnv: selectedApiKeyEnv
    },
    config: nextConfig,
    next: {
      apply: addModelCommand({
        modelRef,
        configPath,
        backend,
        modelRoot,
        sessionCacheRoot,
        modelId,
        name,
        port: selectedPort,
        contextWindow: selectedContextWindow,
        maxOutputTokens: selectedMaxOutputTokens,
        apiKeyEnv: selectedApiKeyEnv,
        keepWarm,
        setDefault,
        apply: true
      }),
      setupBackend: `lloom backend-install ${shellArg(backendId)} --apply --yes`,
      download: downloadCommand ? shellCommand(downloadCommand) : null,
      start: runtime ? `lloom runtime-start ${runtimeId}` : null,
      integrate: 'lloom integrate all --apply --yes'
    }
  };
}

export async function applyModelImport(
  config,
  { dryRun = true, yes = false, configPath = config.sourcePath, ...options } = {}
) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to modify LLooM config without yes=true. Re-run with --apply --yes after reviewing the dry-run plan.'
    );
  }
  const plan = createModelImportPlan(config, {
    ...options,
    configPath
  });
  if (dryRun) return plan;
  await fs.writeFile(configPath, `${JSON.stringify(plan.config, null, 2)}\n`);
  return {
    ...plan,
    dryRun: false,
    written: {
      configPath
    }
  };
}
