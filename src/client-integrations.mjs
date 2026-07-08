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
  const apiKey = provider.apiKey ?? "sk-lloom-local";
  const chatModel = config.defaults?.chatModel;
  return {
    providerId,
    providerName: config.clientCatalog?.providerName ?? provider.name ?? "LLooM Local",
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

const ompRoleNames = [
  "default",
  "smol",
  "slow",
  "plan",
  "commit",
  "designer",
  "advisor",
  "tiny",
  "vision",
  "task",
];

export function renderOmpConfigYaml(config) {
  const { providerId, chatModel } = providerSettings(config);
  const modelRef = `${providerId}/${chatModel}`;
  const timeoutSeconds = config.clientCatalog?.omp?.streamTimeoutSeconds ?? 1800;
  const lines = [
    "modelRoles:",
  ];
  for (const role of ompRoleNames) {
    const value = role === "default" ? `${modelRef}:low` : modelRef;
    lines.push(`  ${role}: ${yamlScalar(value)}`);
  }
  lines.push("defaultThinkingLevel: auto");
  lines.push("hideThinkingBlock: true");
  lines.push("startup:");
  lines.push("  setupWizard: false");
  lines.push("setupVersion: 1");
  lines.push("compaction:");
  lines.push("  strategy: context-full");
  lines.push("providers:");
  lines.push(`  streamFirstEventTimeoutSeconds: ${timeoutSeconds}`);
  lines.push(`  streamIdleTimeoutSeconds: ${timeoutSeconds}`);
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
    `# LLooM managed profile for ${clientId}`,
    `export LLOOM_BASE_URL=${shellQuote(baseUrl)}`,
    `export LLOOM_API_KEY=${shellQuote(apiKey)}`,
    `export LLOOM_MODEL=${shellQuote(chatModel)}`,
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

function renderLauncherScript({
  clientId,
  profileFileName,
  binaryName,
  binaryEnv,
}) {
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
  return home ? path.join(home, ".lloom", "integrations", fileName) : null;
}

function managedBinTarget(home, fileName) {
  return home ? path.join(home, ".lloom", "bin", fileName) : null;
}

function launcherArtifact({ id, name, clientId, generatedRoot, home, profileFileName, binaryName, binaryEnv }) {
  return {
    id,
    clientId,
    name,
    kind: "launcher-script",
    generatedPath: path.join(generatedRoot, id),
    targetPath: managedBinTarget(home, id),
    mode: "managed-launcher",
    executable: true,
    content: renderLauncherScript({
      clientId,
      profileFileName,
      binaryName,
      binaryEnv,
    }),
    notes: [
      `Runs ${binaryName} with the LLooM-managed ${profileFileName} environment profile.`,
      "Add ~/.lloom/bin to PATH or run this script directly.",
    ],
  };
}

export function buildIntegrationArtifacts(config, registry, {
  home = process.env.HOME,
  generatedRoot = defaultGeneratedRoot,
} = {}) {
  const models = registry.clientModels({ kinds: ["chat"] });
  return [
    {
      id: "omp-models",
      clientId: "omp",
      name: "Oh My Pi / OMP model catalog",
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
      id: "omp-config",
      clientId: "omp",
      name: "Oh My Pi / OMP role config",
      kind: "native-config",
      generatedPath: path.join(generatedRoot, "omp-config.yml"),
      targetPath: home ? path.join(home, ".omp", "agent", "config.yml") : null,
      mode: "replace",
      content: renderOmpConfigYaml(config),
      notes: [
        `Pins OMP roles to ${config.defaults?.chatModel}.`,
        "Keeps long local-model stream timeouts aligned with LLooM defaults.",
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
    launcherArtifact({
      id: "lloom-codex",
      name: "Codex launcher",
      clientId: "codex",
      generatedRoot,
      home,
      profileFileName: "codex.env",
      binaryName: "codex",
      binaryEnv: "LLOOM_CODEX_BIN",
    }),
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
    launcherArtifact({
      id: "lloom-claude",
      name: "Claude launcher",
      clientId: "claude",
      generatedRoot,
      home,
      profileFileName: "claude.env",
      binaryName: "claude",
      binaryEnv: "LLOOM_CLAUDE_BIN",
    }),
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
    launcherArtifact({
      id: "lloom-hermes",
      name: "Hermes launcher",
      clientId: "hermes",
      generatedRoot,
      home,
      profileFileName: "hermes.env",
      binaryName: "hermes",
      binaryEnv: "LLOOM_HERMES_BIN",
    }),
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
    launcherArtifact({
      id: "lloom-zero",
      name: "Zero launcher",
      clientId: "zero",
      generatedRoot,
      home,
      profileFileName: "zero.env",
      binaryName: "zero",
      binaryEnv: "LLOOM_ZERO_BIN",
    }),
    {
      id: "manifest",
      name: "LLooM Integration Manifest",
      kind: "manifest",
      generatedPath: path.join(generatedRoot, "lloom-integrations.json"),
      targetPath: managedTarget(home, "lloom-integrations.json"),
      mode: "managed-profile",
      content: renderIntegrationManifest(config, models),
      notes: [
        "Machine-readable integration manifest for tools that want to discover LLooM directly.",
      ],
    },
  ];
}

function matchesClient(artifact, clientId) {
  return artifact.id === clientId || artifact.clientId === clientId || artifact.clientIds?.includes(clientId);
}

export function selectIntegrationArtifacts(artifacts, clientId = "all") {
  if (clientId === "all") return artifacts;
  return artifacts.filter(artifact => matchesClient(artifact, clientId));
}

function selectArtifacts(artifacts, clientId = "all") {
  return selectIntegrationArtifacts(artifacts, clientId);
}

async function writeFile(filePath, content, {
  executable = false,
} = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  if (executable) await fs.chmod(filePath, 0o755);
}

export async function writeGeneratedIntegrationArtifacts(config, registry, {
  clientId = "all",
  ...options
} = {}) {
  const artifacts = selectArtifacts(buildIntegrationArtifacts(config, registry, options), clientId);
  if (!artifacts.length) {
    throw new Error(`Unknown integration client ${clientId}`);
  }
  for (const artifact of artifacts) {
    await writeFile(artifact.generatedPath, artifact.content, {
      executable: artifact.executable === true,
    });
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
      executable: artifact.executable === true,
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
    await writeFile(targetPath, artifact.content, {
      executable: artifact.executable === true,
    });
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
