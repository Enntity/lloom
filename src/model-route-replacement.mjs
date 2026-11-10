import { mutateConfigSource } from './config-mutation.mjs';

export async function replaceModelRoute(
  config,
  { modelId, backendId, upstreamModel, apply = false, yes = false } = {}
) {
  const raw = config.sourceTemplate ?? config;
  const model = raw.models?.find((m) => m.id === modelId);
  if (!model) throw new Error('Replacement requires an existing persisted model ID');
  const backend = raw.backends?.[backendId];
  if (!backend || backend.type !== 'openai' || !backend.baseUrl)
    throw new Error('Replacement requires a configured OpenAI-compatible backend');
  if (!upstreamModel || typeof upstreamModel !== 'string') throw new Error('Replacement requires --upstream-model');
  const next = { ...model, backend: backendId, upstreamModel };
  delete next.runtime;
  delete next.targets;
  delete next.federated;
  delete next.recipe;
  const report = { modelId, applied: false, before: model, after: next, preservedRuntime: model.runtime ?? null };
  if (!apply) return report;
  if (!yes) throw new Error('Route replacement requires --apply --yes');
  await mutateConfigSource(config, (current) => {
    const index = current.models?.findIndex((m) => m.id === modelId) ?? -1;
    if (
      index < 0 ||
      JSON.stringify(current.models[index]) !== JSON.stringify(model) ||
      JSON.stringify(current.backends?.[backendId]) !== JSON.stringify(backend)
    )
      throw new Error('Route changed after preview');
    current.models[index] = next;
  });
  return { ...report, applied: true };
}
