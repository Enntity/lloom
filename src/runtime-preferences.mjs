import { keepWarmOwnership } from './runtime-manager.mjs';

export const RESIDENCY_POLICIES = new Set(['auto', 'preferred', 'always']);

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: 'invalid_residency_policy' });
}

export function residencyPolicy(runtime) {
  if (runtime?.keepWarm === true || runtime?.evictable === false || runtime?.policy?.evictable === false) {
    return 'always';
  }
  return runtime?.preferredWarm === true ? 'preferred' : 'auto';
}

export function updateRuntimePreference(raw, runtimeId, policy) {
  if (!RESIDENCY_POLICIES.has(policy)) throw invalid('Choose auto, preferred, or always.');
  if (!Object.hasOwn(raw.runtimes ?? {}, runtimeId)) throw invalid('Unknown managed runtime.', 404);
  const runtime = raw.runtimes[runtimeId];
  if (!runtime || runtime.enabled !== true || runtime.managed === false || runtime.management === 'external') {
    throw invalid('Readiness is available only for enabled, managed runtimes.');
  }
  const ownership = keepWarmOwnership(raw, runtimeId);
  if (!ownership.owned) throw invalid('Change readiness on the machine that owns this runtime.', 409);
  if (runtime.maintenance) throw invalid('Resume this model before changing its readiness.', 409);
  const previousPolicy = residencyPolicy(runtime);
  // Remove the legacy pin aliases, otherwise normalization silently restores
  // the pin even after a user chooses Auto.
  delete runtime.evictable;
  if (runtime.policy && typeof runtime.policy === 'object') {
    delete runtime.policy.evictable;
  }
  runtime.keepWarm = policy === 'always';
  runtime.preferredWarm = policy === 'preferred';
  return { runtimeId, policy, previousPolicy };
}

export function createRuntimePreferenceController({
  getConfig,
  mutateSource,
  reload,
  assertControl,
  onPersisted,
  onApplied
}) {
  let writes = Promise.resolve(),
    reconciles = Promise.resolve(),
    sequence = 0;
  const jobs = new Map();
  const snapshot = (id) => {
    const job = jobs.get(id);
    return job ? { ...job, completion: undefined } : null;
  };
  async function submit(runtimeId, { policy, yes = false, requestedBy } = {}) {
    const write = writes.then(async () => {
      if (yes !== true) throw invalid('Review the readiness policy and confirm with yes: true.');
      if (!RESIDENCY_POLICIES.has(policy)) throw invalid('Choose auto, preferred, or always.');
      if (!getConfig().sourcePath) throw invalid('This gateway has no writable installed configuration.', 409);
      assertControl?.(runtimeId, requestedBy);
      let result;
      const mutation = await mutateSource((raw) => {
        result = updateRuntimePreference(raw, runtimeId, policy);
      });
      for (const id of jobs.keys()) if (!Object.hasOwn(getConfig().runtimes ?? {}, id)) jobs.delete(id);
      const job = { ...result, id: ++sequence, changed: mutation.changed, status: 'pending', error: null };
      jobs.set(runtimeId, job);
      onPersisted?.(runtimeId, policy, job.id);
      const completion = reconciles.then(async () => {
        try {
          await reload();
          if (jobs.get(runtimeId) !== job || residencyPolicy(getConfig().runtimes?.[runtimeId]) !== policy) {
            job.status = 'superseded';
            return { ok: true, ...result, status: 'superseded', message: 'Replaced by a newer readiness change.' };
          }
          onApplied?.(runtimeId, policy, job.id);
          job.status = 'succeeded';
          return {
            ok: true,
            ...result,
            changed: mutation.changed,
            message: 'Readiness saved. Loading still uses normal memory admission.'
          };
        } catch (error) {
          job.status = 'failed';
          job.error = error.message;
          throw error;
        }
      });
      job.completion = completion;
      reconciles = completion.catch(() => {});
      return job;
    });
    writes = write.then(
      () => {},
      () => {}
    );
    return write;
  }
  return {
    snapshot,
    async request(id, options) {
      const job = await submit(id, options);
      return { ok: true, ...job, completion: undefined };
    },
    async set(id, options) {
      return (await submit(id, options)).completion;
    }
  };
}
