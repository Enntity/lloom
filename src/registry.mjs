export class UnknownModelError extends Error {
  constructor(modelId) {
    super(`unknown local model: ${modelId}`);
    this.name = "UnknownModelError";
    this.statusCode = 404;
    this.code = "unknown_model";
    this.modelId = modelId;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function advertised(value) {
  return value?.advertise !== false;
}

function normalizeAlias(aliasId, alias) {
  if (typeof alias === "string") {
    return {
      id: aliasId,
      target: alias,
      advertise: true,
    };
  }
  return {
    id: aliasId,
    ...alias,
  };
}

function rankMap(values = []) {
  return new Map(values.map((value, index) => [value, index]));
}

export function createRegistry(config) {
  const modelMap = new Map();
  const aliasMap = new Map();

  for (const model of config.models ?? []) {
    modelMap.set(model.id, {
      advertise: true,
      ...model,
      upstreamModel: model.upstreamModel ?? model.id,
    });
  }

  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    aliasMap.set(aliasId, normalizeAlias(aliasId, alias));
  }

  function resolve(modelId = config.defaults?.chatModel) {
    const requestedId = modelId || config.defaults?.chatModel;
    if (!requestedId) throw new UnknownModelError("(missing)");

    const alias = aliasMap.get(requestedId);
    const targetId = alias?.target ?? requestedId;
    const model = modelMap.get(targetId);
    if (!model) throw new UnknownModelError(requestedId);
    const backend = config.backends?.[model.backend];
    if (!backend) throw new Error(`model ${model.id} references missing backend ${model.backend}`);
    return {
      requestedId,
      resolvedId: model.id,
      alias: alias ? clone(alias) : null,
      model: clone(model),
      backend: clone(backend),
      runtime: model.runtime ? clone(config.runtimes?.[model.runtime] ?? null) : null,
    };
  }

  function directModels({ kinds, advertisedOnly = true } = {}) {
    let models = [...modelMap.values()];
    if (advertisedOnly) models = models.filter(advertised);
    if (kinds?.length) models = models.filter(model => kinds.includes(model.kind ?? "chat"));
    return models.map(model => clone(model));
  }

  function aliasModels({ kinds, advertisedOnly = true } = {}) {
    const entries = [];
    for (const alias of aliasMap.values()) {
      if (advertisedOnly && !advertised(alias)) continue;
      const target = modelMap.get(alias.target);
      if (!target) continue;
      if (kinds?.length && !kinds.includes(target.kind ?? "chat")) continue;
      entries.push({
        ...clone(target),
        id: alias.id,
        alias: true,
        aliasTarget: alias.target,
        name: alias.name ?? target.name ?? alias.id,
        description: alias.description,
      });
    }
    return entries;
  }

  function catalogModels({ includeAliases = true, kinds, advertisedOnly = true } = {}) {
    const models = directModels({ kinds, advertisedOnly });
    if (includeAliases) models.push(...aliasModels({ kinds, advertisedOnly }));
    return sortForCatalog(models, config.clientCatalog?.modelOrder ?? []);
  }

  function clientModels({ kinds = ["chat"] } = {}) {
    const includeAliases = config.clientCatalog?.includeAliases === true;
    return catalogModels({ includeAliases, kinds, advertisedOnly: true });
  }

  function openAIModels() {
    const now = Math.floor(Date.now() / 1000);
    return catalogModels({ includeAliases: false, advertisedOnly: true }).map(model => ({
      id: model.id,
      object: "model",
      created: now,
      owned_by: "switchyard",
      metadata: {
        name: model.name ?? model.id,
        kind: model.kind ?? "chat",
        input: model.input ?? ["text"],
        output: model.output ?? ["text"],
        capabilities: model.capabilities ?? [],
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        aliasTarget: model.aliasTarget,
      },
    }));
  }

  return {
    config,
    resolve,
    directModels,
    aliasModels,
    catalogModels,
    clientModels,
    openAIModels,
  };
}

export function sortForCatalog(models, order = []) {
  const ranks = rankMap(order);
  return [...models].sort((a, b) => {
    const ar = ranks.has(a.id) ? ranks.get(a.id) : Number.MAX_SAFE_INTEGER;
    const br = ranks.has(b.id) ? ranks.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
  });
}
