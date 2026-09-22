import { randomBytes } from 'node:crypto';

const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

// Installation survives a browser refresh; bootstrap's persisted stage state
// remains responsible for resuming downloads after a gateway restart.
export function createInstallationJobs({ plan, apply, now = Date.now, ttlMs = 1800000 }) {
  const plans = new Map();
  let job = null;
  let running = null;
  const snapshot = () => (job ? structuredClone(job) : null);
  return {
    snapshot,
    async review(input) {
      if (job?.status === 'running') throw failure('An installation is already running.');
      const prepared = await plan(input);
      for (const [id, value] of plans) if (now() - value.at > ttlMs) plans.delete(id);
      while (plans.size >= 12) plans.delete(plans.keys().next().value);
      const planId = randomBytes(24).toString('hex');
      plans.set(planId, { prepared, at: now() });
      return { planId, ...prepared.view };
    },
    start({ planId, yes, ...extra } = {}) {
      if (yes !== true || Object.keys(extra).length) throw failure('Apply only the reviewed plan with yes: true.', 400);
      if (job?.planId === planId) return snapshot();
      if (job?.status === 'running') throw failure('An installation is already running.');
      const entry = plans.get(planId);
      if (!entry || now() - entry.at > ttlMs) throw failure('Review a fresh installation plan before continuing.');
      plans.delete(planId);
      job = {
        id: randomBytes(16).toString('hex'),
        planId,
        status: 'running',
        detail: 'Preparing the reviewed installation',
        error: null
      };
      running = Promise.resolve()
        .then(() =>
          apply(entry.prepared, (event) => {
            job.detail = String(event?.message ?? event?.detail ?? event?.label ?? event?.phase ?? 'Installing').slice(
              0,
              1500
            );
          })
        )
        .then((result) => {
          if (result?.ok === false)
            throw new Error(result.error || 'Installation needs attention. Run lloom doctor for details.');
          job.status = 'succeeded';
          job.detail = result?.message || 'Installation complete. Load the model to verify it through the gateway.';
        })
        .catch((error) => {
          job.status = 'failed';
          job.error = String(error.message).slice(0, 1500);
        });
      return snapshot();
    },
    async wait() {
      await running;
      return snapshot();
    }
  };
}
