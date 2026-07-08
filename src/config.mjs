import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");
export const defaultConfigPath = path.join(repoRoot, "config/default.json");

export function expandEnvValue(value, env = process.env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(item => expandEnvValue(item, env));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEnvValue(item, env)]),
    );
  }
  return value;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function validateConfig(config, sourcePath) {
  const errors = [];
  const modelIds = new Set();

  for (const [index, model] of (config.models ?? []).entries()) {
    if (!model?.id) errors.push(`models[${index}] is missing id`);
    if (!model?.backend) errors.push(`models[${index}] ${model?.id ?? ""} is missing backend`);
    if (model?.id && modelIds.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
    if (model?.id) modelIds.add(model.id);
    if (model?.backend && !config.backends?.[model.backend]) {
      errors.push(`model ${model.id} references unknown backend ${model.backend}`);
    }
  }

  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    const target = typeof alias === "string" ? alias : alias.target;
    if (!target) errors.push(`alias ${aliasId} is missing target`);
    if (target && !modelIds.has(target)) {
      errors.push(`alias ${aliasId} targets unknown model ${target}`);
    }
  }

  if (errors.length) {
    throw new Error(`Invalid LLooM config ${sourcePath}:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }
}

export async function loadConfig(configPath = process.env.LLOOM_CONFIG || defaultConfigPath, {
  env = process.env,
} = {}) {
  const resolvedPath = path.resolve(configPath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  const expanded = expandEnvValue(parsed, env);
  const config = {
    ...expanded,
    sourcePath: resolvedPath,
    server: {
      host: "127.0.0.1",
      port: 8100,
      ...asObject(expanded.server),
    },
    security: {
      allowMissingAuth: true,
      apiKeys: [],
      ...asObject(expanded.security),
    },
    defaults: {
      chatModel: undefined,
      imageModel: undefined,
      embeddingModel: undefined,
      speechModel: undefined,
      transcriptionModel: undefined,
      ...asObject(expanded.defaults),
    },
    providers: asObject(expanded.providers),
    backends: asObject(expanded.backends),
    aliases: asObject(expanded.aliases),
    runtimes: asObject(expanded.runtimes),
    keepWarm: Array.isArray(expanded.keepWarm) ? expanded.keepWarm : [],
    models: Array.isArray(expanded.models) ? expanded.models : [],
    clientCatalog: {
      providerId: "local-llm",
      providerName: "LLooM Local",
      includeAliases: false,
      modelOrder: [],
      ...asObject(expanded.clientCatalog),
    },
  };

  validateConfig(config, resolvedPath);
  return config;
}
