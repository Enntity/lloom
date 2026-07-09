import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultLloomHome, repoRoot } from './config.mjs';

export const repoGeneratedRoot = path.join(repoRoot, 'clients/generated');
export const repoExamplesRoot = path.join(repoRoot, 'clients/examples');
export function defaultGeneratedRootFor(home = process.env.HOME) {
  return path.join(defaultLloomHome({ ...process.env, ...(home ? { HOME: home } : {}) }), 'generated');
}
export const defaultGeneratedRoot = defaultGeneratedRootFor();
export const CLIENT_INTEGRATIONS_SCHEMA = 'https://lloom.dev/schemas/client-integrations.v1.schema.json';
export const CLIENT_INTEGRATIONS_MEDIA_TYPE = 'application/vnd.lloom.client-integrations+json;version=1';
export const CLIENT_INTEGRATIONS_PROFILE = 'https://lloom.dev/profiles/interchange/v1';

function gatewayUrlForBaseUrl(baseUrl) {
  return String(baseUrl ?? '').replace(/\/v1\/?$/, '');
}

function jsonString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return 'null';
  if (/^[A-Za-z0-9._:/ -]+$/.test(value)) return String(value);
  return JSON.stringify(value);
}

function yamlInlineArray(values = []) {
  return `[${values.map(yamlScalar).join(', ')}]`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function providerSettings(config) {
  const providerId = config.clientCatalog?.providerId ?? 'local-llm';
  const provider = config.providers?.[providerId] ?? {};
  const baseUrl = provider.baseUrl ?? `http://${config.server.host}:${config.server.port}/v1`;
  const gatewayUrl = provider.gatewayUrl ?? gatewayUrlForBaseUrl(baseUrl);
  const apiKey = provider.apiKey ?? 'sk-lloom-local';
  const chatModel = config.defaults?.chatModel;
  return {
    providerId,
    providerName: config.clientCatalog?.providerName ?? provider.name ?? 'LLooM Local',
    gatewayUrl,
    baseUrl,
    openAIBaseUrl: baseUrl,
    anthropicBaseUrl: provider.anthropicBaseUrl ?? gatewayUrl,
    apiKey,
    chatModel
  };
}

function thinkingConfig(model) {
  if (model.reasoning !== true) return null;
  const qwen = /(^|\/)Qwen3\.6-/.test(model.id) || /qwen3\.6/i.test(model.name ?? '');
  return {
    mode: 'effort',
    efforts: qwen ? ['minimal', 'low'] : ['minimal', 'low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'low',
    supportsDisplay: true
  };
}

function pushYamlModel(lines, model) {
  lines.push(`      - id: ${yamlScalar(model.id)}`);
  lines.push(`        name: ${yamlScalar(model.name ?? model.id)}`);
  lines.push(`        reasoning: ${model.reasoning === true ? 'true' : 'false'}`);
  const thinking = thinkingConfig(model);
  if (thinking) {
    lines.push('        thinking:');
    lines.push(`          mode: ${thinking.mode}`);
    lines.push(`          efforts: ${yamlInlineArray(thinking.efforts)}`);
    lines.push(`          defaultLevel: ${thinking.defaultLevel}`);
    lines.push(`          supportsDisplay: ${thinking.supportsDisplay}`);
  }
  lines.push(`        input: ${yamlInlineArray(model.input ?? ['text'])}`);
  lines.push(`        supportsTools: ${model.supportsTools === true ? 'true' : 'false'}`);
  lines.push(`        contextWindow: ${model.contextWindow ?? 128000}`);
  lines.push(`        maxTokens: ${model.maxOutputTokens ?? 8192}`);
  lines.push('        cost:');
  lines.push('          input: 0');
  lines.push('          output: 0');
  lines.push('          cacheRead: 0');
  lines.push('          cacheWrite: 0');
}

export function renderOmpModelsYaml(config, models) {
  const { providerId, baseUrl, apiKey } = providerSettings(config);
  const lines = [
    'providers:',
    `  ${providerId}:`,
    `    baseUrl: ${baseUrl}`,
    '    api: openai-completions',
    `    apiKey: ${apiKey}`,
    '    auth: apiKey',
    '    compat:',
    '      supportsStore: false',
    '      supportsDeveloperRole: false',
    '      supportsReasoningEffort: false',
    '      supportsUsageInStreaming: true',
    '      maxTokensField: max_tokens',
    '      supportsStrictMode: false',
    '      toolStrictMode: none',
    '      thinkingFormat: qwen-chat-template',
    '    models:'
  ];
  for (const model of models) pushYamlModel(lines, model);
  return `${lines.join('\n')}\n`;
}

const ompRoleNames = ['default', 'smol', 'slow', 'plan', 'commit', 'designer', 'advisor', 'tiny', 'vision', 'task'];

export function renderOmpConfigYaml(config) {
  const { providerId, chatModel } = providerSettings(config);
  const modelRef = `${providerId}/${chatModel}`;
  const timeoutSeconds = config.clientCatalog?.omp?.streamTimeoutSeconds ?? 1800;
  const lines = ['modelRoles:'];
  for (const role of ompRoleNames) {
    const value = role === 'default' ? `${modelRef}:low` : modelRef;
    lines.push(`  ${role}: ${yamlScalar(value)}`);
  }
  lines.push('defaultThinkingLevel: auto');
  lines.push('hideThinkingBlock: true');
  lines.push('startup:');
  lines.push('  setupWizard: false');
  lines.push('setupVersion: 1');
  lines.push('compaction:');
  lines.push('  strategy: context-full');
  lines.push('providers:');
  lines.push(`  streamFirstEventTimeoutSeconds: ${timeoutSeconds}`);
  lines.push(`  streamIdleTimeoutSeconds: ${timeoutSeconds}`);
  return `${lines.join('\n')}\n`;
}

export function renderOpenCodeJson(config, models) {
  const { providerId, providerName, baseUrl, apiKey } = providerSettings(config);
  const opencodeModels = {};
  for (const model of models) {
    opencodeModels[model.id] = {
      name: model.name ?? model.id,
      tool_call: model.supportsTools === true,
      temperature: true,
      limit: {
        context: model.contextWindow ?? 128000,
        output: model.maxOutputTokens ?? 8192
      }
    };
  }
  const defaultModel = config.defaults?.chatModel ?? models[0]?.id;
  return jsonString({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: providerName,
        options: {
          baseURL: baseUrl,
          apiKey,
          timeout: false,
          headerTimeout: false
        },
        models: opencodeModels
      }
    },
    model: `${providerId}/${defaultModel}`
  });
}

function renderEnvProfile(config, clientId, { anthropic = false } = {}) {
  const { gatewayUrl, baseUrl, openAIBaseUrl, anthropicBaseUrl, apiKey, chatModel } = providerSettings(config);
  const lines = [
    `# LLooM managed profile for ${clientId}`,
    `export LLOOM_GATEWAY_URL=${shellQuote(gatewayUrl)}`,
    `export LLOOM_BASE_URL=${shellQuote(baseUrl)}`,
    `export LLOOM_OPENAI_BASE_URL=${shellQuote(openAIBaseUrl)}`,
    `export LLOOM_ANTHROPIC_BASE_URL=${shellQuote(anthropicBaseUrl)}`,
    `export LLOOM_API_KEY=${shellQuote(apiKey)}`,
    `export LLOOM_MODEL=${shellQuote(chatModel)}`,
    `export OPENAI_BASE_URL=${shellQuote(openAIBaseUrl)}`,
    `export OPENAI_API_KEY=${shellQuote(apiKey)}`,
    `export OPENAI_MODEL=${shellQuote(chatModel)}`
  ];
  if (anthropic) {
    lines.push(`export ANTHROPIC_BASE_URL=${shellQuote(anthropicBaseUrl)}`);
    lines.push(`export ANTHROPIC_API_KEY=${shellQuote(apiKey)}`);
    lines.push(`export ANTHROPIC_MODEL=${shellQuote(chatModel)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderLauncherScript({ clientId, profileFileName, binaryName, binaryEnv }) {
  return `#!/bin/sh
set -eu
lloom_home="\${LLOOM_HOME:-$HOME/.lloom}"
profile="$lloom_home/integrations/${profileFileName}"
if [ ! -f "$profile" ]; then
  echo "LLooM profile missing: $profile" >&2
  echo "Run: lloom integrate ${clientId} --apply --yes" >&2
  exit 1
fi
. "$profile"
exec "\${${binaryEnv}:-${binaryName}}" "$@"
`;
}

function gatewayEndpoints(baseUrl) {
  const root = String(baseUrl ?? '').replace(/\/+$/, '');
  return {
    models: `${root}/models`,
    chatCompletions: `${root}/chat/completions`,
    responses: `${root}/responses`,
    anthropicMessages: `${root}/messages`,
    images: `${root}/images/generations`,
    embeddings: `${root}/embeddings`,
    speech: `${root}/audio/speech`,
    transcriptions: `${root}/audio/transcriptions`
  };
}

function clientProfiles() {
  return [
    {
      id: 'omp',
      name: 'Oh My Pi / OMP',
      kind: 'native-config',
      protocols: ['openai-chat-completions'],
      artifacts: [
        { id: 'omp-models', kind: 'native-config', mode: 'replace' },
        { id: 'omp-config', kind: 'native-config', mode: 'replace' }
      ],
      notes: ['Uses exact LLooM model IDs and long local-model streaming timeouts.']
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'native-config',
      protocols: ['openai-chat-completions'],
      artifacts: [
        { id: 'opencode', kind: 'native-config', mode: 'replace' },
        { id: 'lloom-opencode', kind: 'launcher-script', mode: 'managed-launcher', executable: true }
      ],
      notes: [
        'Native OpenCode provider config with client-side timeouts disabled.',
        'Launcher pins OpenCode to the LLooM default model.'
      ]
    },
    {
      id: 'codex',
      name: 'Codex-compatible clients',
      kind: 'env-profile',
      protocols: ['openai-chat-completions', 'openai-responses'],
      artifacts: [
        { id: 'codex', kind: 'env-profile', mode: 'managed-profile' },
        { id: 'lloom-codex', kind: 'launcher-script', mode: 'managed-launcher', executable: true }
      ],
      notes: ['Exports OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL.']
    },
    {
      id: 'claude',
      name: 'Claude-compatible clients',
      kind: 'env-profile',
      protocols: ['anthropic-messages'],
      artifacts: [
        { id: 'claude', kind: 'env-profile', mode: 'managed-profile' },
        { id: 'lloom-claude', kind: 'launcher-script', mode: 'managed-launcher', executable: true }
      ],
      notes: ["Exports Anthropic-compatible variables backed by LLooM's /v1/messages bridge."]
    },
    {
      id: 'hermes',
      name: 'Hermes',
      kind: 'env-profile',
      protocols: ['openai-chat-completions'],
      artifacts: [
        { id: 'hermes', kind: 'env-profile', mode: 'managed-profile' },
        { id: 'lloom-hermes', kind: 'launcher-script', mode: 'managed-launcher', executable: true }
      ],
      notes: ['Uses the OpenAI-compatible environment profile until Hermes publishes a stable native config contract.']
    },
    {
      id: 'zero',
      name: 'Zero',
      kind: 'env-profile',
      protocols: ['openai-chat-completions'],
      artifacts: [
        { id: 'zero', kind: 'env-profile', mode: 'managed-profile' },
        { id: 'lloom-zero', kind: 'launcher-script', mode: 'managed-launcher', executable: true }
      ],
      notes: ['Uses the OpenAI-compatible environment profile until Zero publishes a stable native config contract.']
    }
  ];
}

export function buildClientIntegrationManifest(config, models) {
  const settings = providerSettings(config);
  return {
    $schema: CLIENT_INTEGRATIONS_SCHEMA,
    schemaVersion: 1,
    profile: CLIENT_INTEGRATIONS_PROFILE,
    id: 'lloom-local-integrations',
    name: 'LLooM Local Client Integrations',
    summary: 'Discovery document for clients connecting to this LLooM gateway.',
    license: 'MIT',
    provenance: {
      generatedBy: 'lloom'
    },
    provider: {
      id: settings.providerId,
      name: settings.providerName,
      gatewayUrl: settings.gatewayUrl,
      baseUrl: settings.baseUrl,
      openAIBaseUrl: settings.openAIBaseUrl,
      anthropicBaseUrl: settings.anthropicBaseUrl,
      apiKey: settings.apiKey,
      auth: {
        type: settings.apiKey ? 'bearer' : 'none',
        header: 'authorization',
        apiKeyEnv: 'LLOOM_API_KEY'
      },
      protocols: ['openai-chat-completions', 'openai-responses', 'anthropic-messages'],
      features: {
        streaming: true,
        usage: true,
        streamingUsage: true,
        tools: true,
        reasoning: true
      },
      endpoints: gatewayEndpoints(settings.baseUrl),
      defaultModel: settings.chatModel
    },
    clients: clientProfiles(),
    models: models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      input: model.input ?? ['text'],
      output: model.output ?? ['text'],
      capabilities: model.capabilities ?? [],
      supportsTools: model.supportsTools === true,
      reasoning: model.reasoning === true,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens
    }))
  };
}

export function validateClientIntegrationManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['client integrations manifest must be an object'];
  }
  if (manifest.$schema && manifest.$schema !== CLIENT_INTEGRATIONS_SCHEMA) {
    errors.push(`client integrations manifest has unsupported $schema ${manifest.$schema}`);
  }
  if (manifest.schemaVersion !== 1) errors.push('client integrations manifest schemaVersion must be 1');
  if (!manifest.id) errors.push('client integrations manifest id is required');
  if (!manifest.name) errors.push('client integrations manifest name is required');
  if (!manifest.provider || typeof manifest.provider !== 'object' || Array.isArray(manifest.provider)) {
    errors.push('client integrations manifest provider is required');
  } else {
    if (!manifest.provider.id) errors.push('client integrations manifest provider.id is required');
    if (!manifest.provider.name) errors.push('client integrations manifest provider.name is required');
    if (!manifest.provider.baseUrl) errors.push('client integrations manifest provider.baseUrl is required');
    if (!manifest.provider.defaultModel) errors.push('client integrations manifest provider.defaultModel is required');
    if (!Array.isArray(manifest.provider.protocols) || !manifest.provider.protocols.length) {
      errors.push('client integrations manifest provider.protocols must be a non-empty array');
    }
  }
  if (!Array.isArray(manifest.models) || !manifest.models.length) {
    errors.push('client integrations manifest models must be a non-empty array');
  } else {
    const seenModels = new Set();
    for (const [index, model] of manifest.models.entries()) {
      if (!model?.id) errors.push(`client integrations manifest models[${index}].id is required`);
      if (!model?.name) errors.push(`client integrations manifest models[${index}].name is required`);
      if (model?.id && seenModels.has(model.id)) errors.push(`duplicate client integrations model id ${model.id}`);
      if (model?.id) seenModels.add(model.id);
    }
    if (manifest.provider?.defaultModel && !seenModels.has(manifest.provider.defaultModel)) {
      errors.push(
        `client integrations manifest provider.defaultModel ${manifest.provider.defaultModel} is not in models`
      );
    }
  }
  if (manifest.clients != null) {
    if (!Array.isArray(manifest.clients)) {
      errors.push('client integrations manifest clients must be an array when provided');
    } else {
      const seenClients = new Set();
      for (const [index, client] of manifest.clients.entries()) {
        if (!client?.id) errors.push(`client integrations manifest clients[${index}].id is required`);
        if (!client?.name) errors.push(`client integrations manifest clients[${index}].name is required`);
        if (!client?.kind) errors.push(`client integrations manifest clients[${index}].kind is required`);
        if (client?.id && seenClients.has(client.id))
          errors.push(`duplicate client integrations client id ${client.id}`);
        if (client?.id) seenClients.add(client.id);
      }
    }
  }
  return errors;
}

function renderIntegrationManifest(config, models) {
  return jsonString(buildClientIntegrationManifest(config, models));
}

function managedTarget(home, fileName) {
  return home ? path.join(home, '.lloom', 'integrations', fileName) : null;
}

function managedBinTarget(home, fileName) {
  return home ? path.join(home, '.lloom', 'bin', fileName) : null;
}

function launcherArtifact({ id, name, clientId, generatedRoot, home, profileFileName, binaryName, binaryEnv }) {
  return {
    id,
    clientId,
    name,
    kind: 'launcher-script',
    generatedPath: path.join(generatedRoot, id),
    targetPath: managedBinTarget(home, id),
    mode: 'managed-launcher',
    executable: true,
    content: renderLauncherScript({
      clientId,
      profileFileName,
      binaryName,
      binaryEnv
    }),
    notes: [
      `Runs ${binaryName} with the LLooM-managed ${profileFileName} environment profile.`,
      'Add ~/.lloom/bin to PATH or run this script directly.'
    ]
  };
}

function renderOpenCodeLauncher(config) {
  const { providerId, chatModel } = providerSettings(config);
  const modelRef = `${providerId}/${chatModel}`;
  return `#!/bin/sh
set -eu
config="\${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
if [ ! -f "$config" ]; then
  echo "OpenCode config missing: $config" >&2
  echo "Run: lloom integrate opencode --apply --yes" >&2
  exit 1
fi
exec "\${LLOOM_OPENCODE_BIN:-opencode}" --model "\${LLOOM_OPENCODE_MODEL:-${modelRef}}" "$@"
`;
}

function opencodeTarget(home) {
  return home ? path.join(home, '.config', 'opencode', 'opencode.json') : null;
}

export function buildIntegrationArtifacts(
  config,
  registry,
  { home = process.env.HOME, generatedRoot = defaultGeneratedRootFor(home) } = {}
) {
  const models = registry.clientModels({ kinds: ['chat'] });
  return [
    {
      id: 'omp-models',
      clientId: 'omp',
      name: 'Oh My Pi / OMP model catalog',
      kind: 'native-config',
      generatedPath: path.join(generatedRoot, 'omp-models.yml'),
      targetPath: home ? path.join(home, '.omp', 'agent', 'models.yml') : null,
      mode: 'replace',
      content: renderOmpModelsYaml(config, models),
      notes: ['Native model catalog. Exact advertised model IDs only.']
    },
    {
      id: 'omp-config',
      clientId: 'omp',
      name: 'Oh My Pi / OMP role config',
      kind: 'native-config',
      generatedPath: path.join(generatedRoot, 'omp-config.yml'),
      targetPath: home ? path.join(home, '.omp', 'agent', 'config.yml') : null,
      mode: 'replace',
      content: renderOmpConfigYaml(config),
      notes: [
        `Pins OMP roles to ${config.defaults?.chatModel}.`,
        'Keeps long local-model stream timeouts aligned with LLooM defaults.'
      ]
    },
    {
      id: 'opencode',
      clientId: 'opencode',
      name: 'OpenCode',
      kind: 'native-config',
      generatedPath: path.join(generatedRoot, 'opencode.json'),
      targetPath: opencodeTarget(home),
      mode: 'replace',
      content: renderOpenCodeJson(config, models),
      notes: [
        'Native OpenCode config with the LLooM provider and exact model IDs.',
        'Existing drifted config files are backed up before LLooM rewrites them.'
      ]
    },
    {
      id: 'lloom-opencode',
      clientId: 'opencode',
      name: 'OpenCode launcher',
      kind: 'launcher-script',
      generatedPath: path.join(generatedRoot, 'lloom-opencode'),
      targetPath: managedBinTarget(home, 'lloom-opencode'),
      mode: 'managed-launcher',
      executable: true,
      content: renderOpenCodeLauncher(config),
      notes: [
        'Runs opencode with the LLooM default model via --model.',
        'Set LLOOM_OPENCODE_BIN or LLOOM_OPENCODE_MODEL to override.'
      ]
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'env-profile',
      generatedPath: path.join(generatedRoot, 'codex.env'),
      targetPath: managedTarget(home, 'codex.env'),
      mode: 'managed-profile',
      content: renderEnvProfile(config, 'codex'),
      notes: ['OpenAI-compatible environment profile for clients that can target a custom OpenAI base URL.']
    },
    launcherArtifact({
      id: 'lloom-codex',
      name: 'Codex launcher',
      clientId: 'codex',
      generatedRoot,
      home,
      profileFileName: 'codex.env',
      binaryName: 'codex',
      binaryEnv: 'LLOOM_CODEX_BIN'
    }),
    {
      id: 'claude',
      name: 'Claude-compatible clients',
      kind: 'env-profile',
      generatedPath: path.join(generatedRoot, 'claude.env'),
      targetPath: managedTarget(home, 'claude.env'),
      mode: 'managed-profile',
      content: renderEnvProfile(config, 'claude', { anthropic: true }),
      notes: ['Anthropic-compatible environment profile for clients that can target a custom Anthropic base URL.']
    },
    launcherArtifact({
      id: 'lloom-claude',
      name: 'Claude launcher',
      clientId: 'claude',
      generatedRoot,
      home,
      profileFileName: 'claude.env',
      binaryName: 'claude',
      binaryEnv: 'LLOOM_CLAUDE_BIN'
    }),
    {
      id: 'hermes',
      name: 'Hermes',
      kind: 'env-profile',
      generatedPath: path.join(generatedRoot, 'hermes.env'),
      targetPath: managedTarget(home, 'hermes.env'),
      mode: 'managed-profile',
      content: renderEnvProfile(config, 'hermes'),
      notes: [
        'OpenAI-compatible profile. Native Hermes config writes should be added when its stable config contract is pinned.'
      ]
    },
    launcherArtifact({
      id: 'lloom-hermes',
      name: 'Hermes launcher',
      clientId: 'hermes',
      generatedRoot,
      home,
      profileFileName: 'hermes.env',
      binaryName: 'hermes',
      binaryEnv: 'LLOOM_HERMES_BIN'
    }),
    {
      id: 'zero',
      name: 'Zero',
      kind: 'env-profile',
      generatedPath: path.join(generatedRoot, 'zero.env'),
      targetPath: managedTarget(home, 'zero.env'),
      mode: 'managed-profile',
      content: renderEnvProfile(config, 'zero'),
      notes: [
        'OpenAI-compatible profile. Native Zero config writes should be added when its stable config contract is pinned.'
      ]
    },
    launcherArtifact({
      id: 'lloom-zero',
      name: 'Zero launcher',
      clientId: 'zero',
      generatedRoot,
      home,
      profileFileName: 'zero.env',
      binaryName: 'zero',
      binaryEnv: 'LLOOM_ZERO_BIN'
    }),
    {
      id: 'manifest',
      name: 'LLooM Integration Manifest',
      kind: 'manifest',
      generatedPath: path.join(generatedRoot, 'lloom-integrations.json'),
      targetPath: managedTarget(home, 'lloom-integrations.json'),
      mode: 'managed-profile',
      content: renderIntegrationManifest(config, models),
      notes: ['Machine-readable integration manifest for tools that want to discover LLooM directly.']
    }
  ];
}

function matchesClient(artifact, clientId) {
  return artifact.id === clientId || artifact.clientId === clientId || artifact.clientIds?.includes(clientId);
}

export function selectIntegrationArtifacts(artifacts, clientId = 'all') {
  if (clientId === 'all') return artifacts;
  return artifacts.filter((artifact) => matchesClient(artifact, clientId));
}

function selectArtifacts(artifacts, clientId = 'all') {
  return selectIntegrationArtifacts(artifacts, clientId);
}

async function fileMatchStatus(filePath, expectedContent) {
  if (!filePath) {
    return {
      path: null,
      exists: false,
      matchesExpected: false,
      status: 'unavailable'
    };
  }
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const matchesExpected = content === expectedContent;
    return {
      path: filePath,
      exists: true,
      matchesExpected,
      status: matchesExpected ? 'current' : 'drifted'
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      path: filePath,
      exists: false,
      matchesExpected: false,
      status: 'missing'
    };
  }
}

export async function integrationArtifactStatus(artifact) {
  const target = await fileMatchStatus(artifact.targetPath, artifact.content);
  const generated = await fileMatchStatus(artifact.generatedPath, artifact.content);
  const current = artifact.targetPath ? target.matchesExpected : generated.matchesExpected;
  return {
    id: artifact.id,
    clientId: artifact.clientId ?? artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    mode: artifact.mode,
    executable: artifact.executable === true,
    targetPath: artifact.targetPath,
    generatedPath: artifact.generatedPath,
    target,
    generated,
    current,
    status: current
      ? 'current'
      : artifact.targetPath && !target.exists
        ? 'missing'
        : artifact.targetPath && target.exists
          ? 'drifted'
          : generated.status,
    notes: artifact.notes
  };
}

function summarizeArtifactStatuses(artifacts) {
  const summary = {
    total: artifacts.length,
    current: 0,
    missing: 0,
    drifted: 0,
    unavailable: 0
  };
  for (const artifact of artifacts) {
    if (artifact.current) summary.current += 1;
    else if (artifact.status === 'missing') summary.missing += 1;
    else if (artifact.status === 'drifted') summary.drifted += 1;
    else summary.unavailable += 1;
  }
  return summary;
}

export async function createClientIntegrationStatus(
  config,
  registry,
  { clientId = 'all', home = process.env.HOME, generatedRoot = defaultGeneratedRootFor(home) } = {}
) {
  const artifacts = selectArtifacts(
    buildIntegrationArtifacts(config, registry, {
      home,
      generatedRoot
    }),
    clientId
  );
  if (!artifacts.length) {
    throw new Error(`Unknown integration client ${clientId}`);
  }
  const data = [];
  for (const artifact of artifacts) {
    data.push(await integrationArtifactStatus(artifact));
  }
  const summary = summarizeArtifactStatuses(data);
  const provider = providerSettings(config);
  return {
    schemaVersion: 1,
    id: 'lloom-client-integration-status',
    ok: summary.current === summary.total,
    clientId,
    provider: {
      id: provider.providerId,
      name: provider.providerName,
      baseUrl: provider.baseUrl,
      anthropicBaseUrl: provider.anthropicBaseUrl,
      defaultModel: provider.chatModel
    },
    generatedRoot,
    home,
    summary,
    data,
    next: {
      review: `lloom integrations ${clientId}`,
      apply: `lloom integrate ${clientId} --apply --yes`
    }
  };
}

async function writeFile(filePath, content, { executable = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  if (executable) await fs.chmod(filePath, 0o755);
}

function backupPathFor(filePath, date = new Date()) {
  const stamp = date
    .toISOString()
    .replace(/[^0-9A-Za-z]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${filePath}.bak-${stamp}`;
}

async function backupIfDrifted(filePath, expectedContent) {
  try {
    const current = await fs.readFile(filePath, 'utf8');
    if (current === expectedContent) return null;
    const backupPath = backupPathFor(filePath);
    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeGeneratedIntegrationArtifacts(config, registry, { clientId = 'all', ...options } = {}) {
  const artifacts = selectArtifacts(buildIntegrationArtifacts(config, registry, options), clientId);
  if (!artifacts.length) {
    throw new Error(`Unknown integration client ${clientId}`);
  }
  for (const artifact of artifacts) {
    await writeFile(artifact.generatedPath, artifact.content, {
      executable: artifact.executable === true
    });
  }
  return artifacts.map((artifact) => ({
    id: artifact.id,
    generatedPath: artifact.generatedPath
  }));
}

export async function applyIntegrationArtifacts(
  config,
  registry,
  {
    clientId = 'all',
    dryRun = true,
    yes = false,
    home = process.env.HOME,
    generatedRoot = defaultGeneratedRootFor(home)
  } = {}
) {
  if (!dryRun && !yes) {
    throw new Error(
      'Refusing to modify client integration files without yes=true. Re-run with --yes after reviewing the dry-run plan.'
    );
  }
  const artifacts = selectArtifacts(
    buildIntegrationArtifacts(config, registry, {
      home,
      generatedRoot
    }),
    clientId
  );
  if (!artifacts.length) {
    throw new Error(`Unknown integration client ${clientId}`);
  }

  const results = [];
  for (const artifact of artifacts) {
    const targetPath = artifact.targetPath ?? artifact.generatedPath;
    const result = {
      id: artifact.id,
      name: artifact.name,
      kind: artifact.kind,
      mode: artifact.mode,
      executable: artifact.executable === true,
      generatedPath: artifact.generatedPath,
      targetPath,
      notes: artifact.notes
    };
    if (dryRun) {
      results.push({
        ...result,
        status: 'planned'
      });
      continue;
    }
    const backupPath = await backupIfDrifted(targetPath, artifact.content);
    await writeFile(targetPath, artifact.content, {
      executable: artifact.executable === true
    });
    results.push({
      ...result,
      status: 'written',
      ...(backupPath ? { backupPath } : {})
    });
  }
  return {
    dryRun,
    results
  };
}
