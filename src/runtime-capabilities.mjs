import contract from './runtime-capabilities.json' with { type: 'json' };

/** Publish stable client names without inventing cloud routes or replacing explicit aliases. */
export function applyRuntimeAliases(config) {
  const aliases = { ...config.aliases };
  const ids = new Set([...(config.models || []).map((m) => m.id), ...Object.keys(aliases)]);
  const targets = {
    [contract.models.presence]: config.defaults?.presenceModel || config.defaults?.chatModel,
    [contract.models.communication]:
      config.defaults?.chatCapableModel ||
      (ids.has('cloud/openrouter/chat-capable') ? 'cloud/openrouter/chat-capable' : null),
    [contract.models.embedding]: config.defaults?.embeddingModel,
    [contract.models.perception]:
      config.defaults?.multimodalModel ||
      (ids.has('google/gemini-3.1-flash-lite') ? 'google/gemini-3.1-flash-lite' : null)
  };
  for (const [name, target] of Object.entries(targets)) {
    if (!ids.has(name) && target && target !== name && ids.has(target))
      aliases[name] = { members: [target], advertise: true };
  }
  config.aliases = aliases;
  return config;
}

export function runtimeCapabilityModels(config) {
  const ids = new Set([...(config.models || []).map((m) => m.id), ...Object.keys(config.aliases || {})]);
  return Object.fromEntries(
    Object.entries(contract.models).map(([role, model]) => [role, { model, configured: ids.has(model) }])
  );
}
