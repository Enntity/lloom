import {
  buildSpeechModelsSummary,
  listVoicesForModel,
  modelDiscoveryMetadata,
  resolveSttDescriptor,
  resolveTtsDescriptor,
  speechSchemaForModel,
  transcriptionSchemaForModel
} from './tts-catalog.mjs';
import { currentNodeId, modelTargets, runtimeAuthority } from './cluster.mjs';

export class UnknownModelError extends Error {
  constructor(modelId) {
    super(`unknown local model: ${modelId}`);
    this.name = 'UnknownModelError';
    this.statusCode = 404;
    this.code = 'unknown_model';
    this.modelId = modelId;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function advertised(value) {
  return value?.advertise !== false;
}

function targetVisibleHere(config, target) {
  const localNode = currentNodeId(config);
  if (target.remoteRuntime && target.node) {
    return localNode === (config.cluster?.leaderNode ?? localNode) && target.node !== localNode;
  }
  if (!target.runtime) return true;
  return runtimeAuthority(config, target.runtime)?.owner === localNode;
}

function availableTargets(config, model, { requireRuntimeEnabled = true } = {}) {
  return modelTargets(model).filter(
    (target) =>
      targetVisibleHere(config, target) &&
      (!requireRuntimeEnabled || !target.runtime || config.runtimes?.[target.runtime]?.enabled !== false)
  );
}

function callableTargets(config, model) {
  return availableTargets(config, model);
}

function runtimeEnabled(config, model) {
  return callableTargets(config, model).length > 0;
}

function publiclyAvailable(config, model, { requireRuntimeEnabled = true } = {}) {
  return advertised(model) && availableTargets(config, model, { requireRuntimeEnabled }).length > 0;
}

function modelAvailableHere(config, model, { requireRuntimeEnabled = true } = {}) {
  const targets = availableTargets(config, model, { requireRuntimeEnabled });
  if (!Array.isArray(model.targets)) return clone(model);
  const selected = targets[0];
  const available = {
    ...clone(model),
    targets: clone(targets),
    ...(selected?.backend ? { backend: selected.backend } : {}),
    ...(selected?.upstreamModel ? { upstreamModel: selected.upstreamModel } : {}),
    ...(selected?.runtime ? { runtime: selected.runtime } : {})
  };
  if (!selected?.runtime) delete available.runtime;
  return available;
}

function normalizeAlias(aliasId, alias) {
  if (typeof alias === 'string') {
    return {
      id: aliasId,
      target: alias,
      advertise: true
    };
  }
  return {
    id: aliasId,
    ...alias
  };
}

export function aliasTargetIds(alias) {
  const normalized = typeof alias === 'string' ? { target: alias } : (alias ?? {});
  return [normalized.target, ...(Array.isArray(normalized.fallbacks) ? normalized.fallbacks : [])].filter(
    (target, index, targets) => typeof target === 'string' && target.length > 0 && targets.indexOf(target) === index
  );
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
      upstreamModel: model.upstreamModel ?? model.id
    });
  }

  for (const [aliasId, alias] of Object.entries(config.aliases ?? {})) {
    aliasMap.set(aliasId, normalizeAlias(aliasId, alias));
  }

  function resolveCandidates(modelId = config.defaults?.chatModel) {
    const requestedId = modelId || config.defaults?.chatModel;
    if (!requestedId) throw new UnknownModelError('(missing)');

    const alias = aliasMap.get(requestedId);
    const targetIds = alias ? aliasTargetIds(alias) : [requestedId];
    const candidates = [];
    for (const [aliasTargetIndex, targetId] of targetIds.entries()) {
      const model = modelMap.get(targetId);
      if (!model || !runtimeEnabled(config, model)) continue;
      const availableTargets = callableTargets(config, model);
      const target = availableTargets[0];
      const backend = config.backends?.[target?.backend];
      if (!backend) throw new Error(`model ${model.id} references missing backend ${target?.backend ?? '(missing)'}`);
      const resolvedModel = {
        ...model,
        backend: target.backend,
        upstreamModel: target.upstreamModel ?? model.upstreamModel ?? model.id,
        ...(Array.isArray(model.targets) ? { targets: availableTargets } : {}),
        ...(target.runtime ? { runtime: target.runtime } : {})
      };
      if (!target.runtime) delete resolvedModel.runtime;
      candidates.push({
        requestedId,
        resolvedId: model.id,
        aliasTargetIndex,
        aliasTargetCount: targetIds.length,
        alias: alias ? clone(alias) : null,
        model: clone(resolvedModel),
        backend: clone(backend),
        runtime: target.runtime ? clone(config.runtimes?.[target.runtime] ?? null) : null
      });
    }
    if (!candidates.length) throw new UnknownModelError(requestedId);
    return candidates;
  }

  function resolve(modelId = config.defaults?.chatModel) {
    return resolveCandidates(modelId)[0];
  }

  function directModels({ kinds, advertisedOnly = true, requireRuntimeEnabled = true } = {}) {
    let models = [...modelMap.values()];
    if (advertisedOnly)
      models = models.filter((model) =>
        publiclyAvailable(config, model, {
          requireRuntimeEnabled
        })
      );
    if (kinds?.length) models = models.filter((model) => kinds.includes(model.kind ?? 'chat'));
    return models.map((model) => modelAvailableHere(config, model, { requireRuntimeEnabled }));
  }

  function aliasModels({ kinds, advertisedOnly = true, requireRuntimeEnabled = true } = {}) {
    const entries = [];
    for (const alias of aliasMap.values()) {
      if (advertisedOnly && !advertised(alias)) continue;
      const target = aliasTargetIds(alias)
        .map((targetId) => modelMap.get(targetId))
        .find(
          (model) =>
            model &&
            (!advertisedOnly ||
              publiclyAvailable(config, model, {
                requireRuntimeEnabled
              }))
        );
      if (!target) continue;
      if (kinds?.length && !kinds.includes(target.kind ?? 'chat')) continue;
      const availableTarget = modelAvailableHere(config, target, { requireRuntimeEnabled });
      entries.push({
        ...availableTarget,
        id: alias.id,
        alias: true,
        aliasTarget: alias.target,
        aliasFallbacks: clone(alias.fallbacks ?? []),
        name: alias.name ?? target.name ?? alias.id,
        description: alias.description
      });
    }
    return entries;
  }

  function catalogModels({ includeAliases = true, kinds, advertisedOnly = true, requireRuntimeEnabled = true } = {}) {
    const models = directModels({ kinds, advertisedOnly, requireRuntimeEnabled });
    if (includeAliases) models.push(...aliasModels({ kinds, advertisedOnly, requireRuntimeEnabled }));
    return sortForCatalog(
      models.filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index),
      config.clientCatalog?.modelOrder ?? []
    );
  }

  function clientModels({ kinds = ['chat'] } = {}) {
    const includeAliases = config.clientCatalog?.includeAliases === true;
    return catalogModels({
      includeAliases,
      kinds,
      advertisedOnly: true,
      requireRuntimeEnabled: false
    });
  }

  function openAIModels() {
    const now = Math.floor(Date.now() / 1000);
    return catalogModels({ includeAliases: false, advertisedOnly: true }).map((model) => ({
      id: model.id,
      object: 'model',
      created: now,
      owned_by: 'lloom',
      metadata: modelDiscoveryMetadata(model)
    }));
  }

  function resolveSpeechModel(modelId = config.defaults?.speechModel) {
    const resolved = resolve(modelId ?? config.defaults?.speechModel);
    if ((resolved.model.kind ?? 'chat') !== 'audio_speech') {
      const error = new Error(`model ${resolved.requestedId} is not a speech model`);
      error.statusCode = 400;
      error.code = 'wrong_model_kind';
      error.modelId = resolved.requestedId;
      throw error;
    }
    return {
      ...resolved,
      tts: resolveTtsDescriptor(resolved.model)
    };
  }

  function resolveTranscriptionModel(modelId = config.defaults?.transcriptionModel) {
    const resolved = resolve(modelId ?? config.defaults?.transcriptionModel);
    if ((resolved.model.kind ?? 'chat') !== 'audio_transcription') {
      const error = new Error(`model ${resolved.requestedId} is not a transcription model`);
      error.statusCode = 400;
      error.code = 'wrong_model_kind';
      error.modelId = resolved.requestedId;
      throw error;
    }
    return {
      ...resolved,
      stt: resolveSttDescriptor(resolved.model)
    };
  }

  function speechCatalog({ voiceProfiles = [] } = {}) {
    const models = catalogModels({
      includeAliases: true,
      kinds: ['audio_speech'],
      advertisedOnly: true
    });
    return {
      object: 'speech.catalog',
      defaultModel: config.defaults?.speechModel ?? null,
      endpoints: {
        speech: '/v1/audio/speech',
        voices: '/v1/audio/voices',
        schema: '/v1/audio/speech/schema',
        models: '/v1/models'
      },
      models: buildSpeechModelsSummary(models),
      voices: voiceProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        source: 'profile',
        mode: profile.kind,
        model: profile.model,
        speechExample: {
          voice: profile.id,
          input: 'Hello from a named LLooM voice.'
        }
      }))
    };
  }

  function voices(modelId) {
    const resolved = resolveSpeechModel(modelId);
    return listVoicesForModel(resolved.model);
  }

  function speechSchema(modelId) {
    const resolved = resolveSpeechModel(modelId);
    return speechSchemaForModel(resolved.model);
  }

  function transcriptionSchema(modelId) {
    const resolved = resolveTranscriptionModel(modelId);
    return transcriptionSchemaForModel(resolved.model);
  }

  return {
    config,
    resolve,
    resolveCandidates,
    resolveSpeechModel,
    resolveTranscriptionModel,
    directModels,
    aliasModels,
    catalogModels,
    clientModels,
    openAIModels,
    speechCatalog,
    voices,
    speechSchema,
    transcriptionSchema
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
