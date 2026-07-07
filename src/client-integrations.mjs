import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";

export const defaultGeneratedRoot = path.join(repoRoot, "clients/generated");

function jsonString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function yamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  if (/^[A-Za-z0-9._:/ -]+$/.test(value)) return String(value);
  return JSON.stringify(value);
}

function yamlInlineArray(values = []) {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function providerSettings(config) {
  const providerId = config.clientCatalog?.providerId ?? "local-llm";
  const provider = config.providers?.[providerId] ?? {};
  const baseUrl = provider.baseUrl ?? `http://${config.server.host}:${config.server.port}/v1`;
  const apiKey = provider.apiKey ?? "sk-switchyard-local";
  const chatModel = config.defaults?.chatModel;
  return {
    providerId,
    providerName: config.clientCatalog?.providerName ?? provider.name ?? "Switchyard Local",
    baseUrl,
    anthropicBaseUrl: baseUrl.replace(/\/v1$/, "/v1"),
    apiKey,
    chatModel,
  };
}

function thinkingConfig(model) {
  if (model.reasoning !== true) return null;
  const qwen = /(^|\/)Qwen3\.6-/.test(model.id) || /qwen3\.6/i.test(model.name ?? "");
  return {
    mode: "effort",
    efforts: qwen ? ["minimal", "low"] : ["minimal", "low", "medium", "high", "xhigh"],
    defaultLevel: "low",
    supportsDisplay: true,
  };
}

function pushYamlModel(lines, model) {
  lines.push(`      - id: ${yamlScalar(model.id)}`);
  lines.push(`        name: ${yamlScalar(model.name ?? model.id)}`);
  lines.push(`        reasoning: ${model.reasoning === true ? "true" : "false"}`);
  const thinking = thinkingConfig(model);
  if (thinking) {
    lines.push("        thinking:");
    lines.push(`          mode: ${thinking.mode}`);
    lines.push(`          efforts: ${yamlInlineArray(thinking.efforts)}`);
    lines.push(`          defaultLevel: ${thinking.defaultLevel}`);
    lines.push(`          supportsDisplay: ${thinking.supportsDisplay}`);
  }
  lines.push(`        input: ${yamlInlineArray(model.input ?? ["text"])}`);
  lines.push(`        supportsTools: ${model.supportsTools === true ? "true" : "false"}`);
  lines.push(`        contextWindow: ${model.contextWindow ?? 128000}`);
  lines.push(`        maxTokens: ${model.maxOutputTokens ?? 8192}`);
  lines.push("        cost:");
  lines.push("          input: 0");
  lines.push("          output: 0");
  lines.push("          cacheRead: 0");
  lines.push("          cacheWrite: 0");
}

export function renderOmpModelsYaml(config, models) {
  const { providerId, baseUrl, apiKey } = providerSettings(config);
  const lines = [
    "providers:",
    `  ${providerId}:`,
    `    baseUrl: ${baseUrl}`,
    "    api: openai-completions",
    `    apiKey: ${apiKey}`,
    "    auth: apiKey",
    "    compat:",
    "      supportsStore: false",
    "      supportsDeveloperRole: false",
    "      supportsReasoningEffort: false",
    "      supportsUsageInStreaming: false",
    "      maxTokensField: max_tokens",
    "      supportsStrictMode: false",
    "      toolStrictMode: none",
    "      thinkingFormat: qwen-chat-template",
    "    models:",
  ];
  for (const model of models) pushYamlModel(lines, model);
  return `${lines.join("\n")}\n`;
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
        output: model.maxOutputTokens ?? 8192,
      },
    };
  }
  const defaultModel = config.defaults?.chatModel ?? models[0]?.id;
  return jsonString({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: providerName,
        options: {
          baseURL: baseUrl,
          apiKey,
          timeout: false,
          headerTimeout: false,
        },
        models: opencodeModels,
      },
    },
    model: `${providerId}/${defaultModel}`,
  });
}

function renderEnvProfile(config, clientId, {
  anthropic = false,
} = {}) {
  const { baseUrl, apiKey, chatModel } = providerSettings(config);
  const lines = [
    `# Switchyard managed profile for ${clientId}`,
    `export SWITCHYARD_BASE_URL=${shellQuote(baseUrl)}`,
    `export SWITCHYARD_API_KEY=${shellQuote(apiKey)}`,
    `export SWITCHYARD_MODEL=${shellQuote(chatModel)}`,
    `export OPENAI_BASE_URL=${shellQuote(baseUrl)}`,
    `export OPENAI_API_KEY=${shellQuote(apiKey)}`,
    `export OPENAI_MODEL=${shellQuote(chatModel)}`,
  ];
  if (anthropic) {
    lines.push(`export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}`);
    lines.push(`export ANTHROPIC_API_KEY=${shellQuote(apiKey)}`);
    lines.push(`export ANTHROPIC_MODEL=${shellQuote(chatModel)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderIntegrationManifest(config, models) {
  const settings = providerSettings(config);
  return jsonString({
    schemaVersion: 1,
    provider: {
      id: settings.providerId,
      name: settings.providerName,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      defaultModel: settings.chatModel,
    },
    models: models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      input: model.input ?? ["text"],
      output: model.output ?? ["text"],
      supportsTools: model.supportsTools === true,
      reasoning: model.reasoning === true,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    })),
  });
}

function managedTarget(home, fileName) {
  return home ? path.join(home, ".switchyard", "integrations", fileName) : null;
}

export function buildIntegrationArtifacts(config, registry, {
  home = process.env.HOME,
  generatedRoot = defaultGeneratedRoot,
} = {}) {
  const models = registry.clientModels({ kinds: ["chat"] });
  return [
    {
      id: "omp",
      name: "Oh My Pi / OMP",
      kind: "native-config",
      generatedPath: path.join(generatedRoot, "omp-models.yml"),
      targetPath: home ? path.join(home, ".omp", "agent", "models.yml") : null,
      mode: "replace",
      content: renderOmpModelsYaml(config, models),
      notes: [
        "Native model catalog. Exact advertised model IDs only.",
      ],
    },
    {
      id: "opencode",
      name: "OpenCode",
      kind: "native-config",
      generatedPath: path.join(generatedRoot, "opencode.json"),
      targetPath: managedTarget(home, "opencode.json"),
      mode: "managed-profile",
      content: renderOpenCodeJson(config, models),
      notes: [
        "Generated OpenCode provider block. Merge or point OpenCode at this managed profile.",
      ],
    },
    {
      id: "codex",
      name: "Codex",
      kind: "env-profile",
      generatedPath: path.join(generatedRoot, "codex.env"),
      targetPath: managedTarget(home, "codex.env"),
      mode: "managed-profile",
      content: renderEnvProfile(config, "codex"),
      notes: [
        "OpenAI-compatible environment profile for clients that can target a custom OpenAI base URL.",
      ],
    },
    {
      id: "claude",
      name: "Claude-compatible clients",
      kind: "env-profile",
      generatedPath: path.join(generatedRoot, "claude.env"),
      targetPath: managedTarget(home, "claude.env"),
      mode: "managed-profile",
      content: renderEnvProfile(config, "claude", { anthropic: true }),
      notes: [
        "Anthropic-compatible environment profile for clients that can target a custom Anthropic base URL.",
      ],
    },
    {
      id: "hermes",
      name: "Hermes",
      kind: "env-profile",
      generatedPath: path.join(generatedRoot, "hermes.env"),
      targetPath: managedTarget(home, "hermes.env"),
      mode: "managed-profile",
      content: renderEnvProfile(config, "hermes"),
      notes: [
        "OpenAI-compatible profile. Native Hermes config writes should be added when its stable config contract is pinned.",
      ],
    },
    {
      id: "zero",
      name: "Zero",
      kind: "env-profile",
      generatedPath: path.join(generatedRoot, "zero.env"),
      targetPath: managedTarget(home, "zero.env"),
      mode: "managed-profile",
      content: renderEnvProfile(config, "zero"),
      notes: [
        "OpenAI-compatible profile. Native Zero config writes should be added when its stable config contract is pinned.",
      ],
    },
    {
      id: "manifest",
      name: "Switchyard Integration Manifest",
      kind: "manifest",
      generatedPath: path.join(generatedRoot, "switchyard-integrations.json"),
      targetPath: managedTarget(home, "switchyard-integrations.json"),
      mode: "managed-profile",
      content: renderIntegrationManifest(config, models),
      notes: [
        "Machine-readable integration manifest for tools that want to discover Switchyard directly.",
      ],
    },
  ];
}

function selectArtifacts(artifacts, clientId = "all") {
  if (clientId === "all") return artifacts;
  return artifacts.filter(artifact => artifact.id === clientId);
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

export async function writeGeneratedIntegrationArtifacts(config, registry, options = {}) {
  const artifacts = buildIntegrationArtifacts(config, registry, options);
  for (const artifact of artifacts) {
    await writeFile(artifact.generatedPath, artifact.content);
  }
  return artifacts.map(artifact => ({
    id: artifact.id,
    generatedPath: artifact.generatedPath,
  }));
}

export async function applyIntegrationArtifacts(config, registry, {
  clientId = "all",
  dryRun = true,
  yes = false,
  home = process.env.HOME,
  generatedRoot = defaultGeneratedRoot,
} = {}) {
  if (!dryRun && !yes) {
    throw new Error("Refusing to modify client integration files without yes=true. Re-run with --yes after reviewing the dry-run plan.");
  }
  const artifacts = selectArtifacts(buildIntegrationArtifacts(config, registry, {
    home,
    generatedRoot,
  }), clientId);
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
      generatedPath: artifact.generatedPath,
      targetPath,
      notes: artifact.notes,
    };
    if (dryRun) {
      results.push({
        ...result,
        status: "planned",
      });
      continue;
    }
    await writeFile(targetPath, artifact.content);
    results.push({
      ...result,
      status: "written",
    });
  }
  return {
    dryRun,
    results,
  };
}
