const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_IDLE_MS = 30000;

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Preferred-residency reconciliation is intentionally thin. It finds runtimes
// the operator marked `preferredWarm: true` and asks the normal admission path
// to restore them. It does not prefilter by host memory or by loaded/busy
// status: all capacity decisions (memory budget, eviction tiers, idle grace,
// protected runtimes) are made by the authoritative admission planner under
// the admission mutex. The reconciler may request eviction of idle ordinary
// runtimes only after the idle grace window, and the planner still refuses to
// evict pins, active/queued requests, delegated authority, or another
// preferred runtime for background restoration.
export function createPreferredResidencyReconciler(runtimeManager, { intervalMs = DEFAULT_INTERVAL_MS, logger } = {}) {
  const period = numberOrNull(intervalMs) ?? DEFAULT_INTERVAL_MS;
  let running = false;
  let timer = null;
  let closed = false;
  let activePass = Promise.resolve();

  function idleMs() {
    const configured = numberOrNull(runtimeManager.config?.runtimePolicy?.preferredWarmIdleMs);
    return configured != null && configured >= 0 ? configured : DEFAULT_IDLE_MS;
  }

  async function runPass() {
    if (closed) return { skipped: 'closed' };
    if (running) return { skipped: 'overlap' };
    const preferredIds = runtimeManager.preferredWarmRuntimeIds?.() ?? [];
    if (preferredIds.length === 0) return { skipped: 'no-preferred-runtimes' };
    running = true;
    const results = [];
    try {
      // Hard pins settle first. While any owned, enabled keep-warm pin is
      // still pending (not healthy/loaded), preferred restoration stays out of
      // the way so image cannot steal the space an essential runtime needs.
      const status = await runtimeManager.status();
      if (closed) return { skipped: 'closed' };
      const pinsPending = runtimeManager
        .keepWarmRuntimeIds?.()
        .filter((runtimeId) => runtimeManager.config?.runtimes?.[runtimeId]?.enabled === true)
        .filter(
          (runtimeId) =>
            runtimeManager.config?.runtimes?.[runtimeId]?.enabled === true &&
            runtimeManager.residencyOwnership?.(runtimeId)?.owned !== false
        )
        .some((runtimeId) => {
          const row = status.runtimes?.[runtimeId];
          return row?.healthy !== true;
        });
      if (pinsPending) return { skipped: 'pins-pending' };

      for (const runtimeId of preferredIds) {
        if (closed) break;
        if (runtimeId == null) continue;
        if (status.runtimes?.[runtimeId]?.healthy === true) continue;
        const ownership = runtimeManager.residencyOwnership?.(runtimeId);
        if (ownership?.owned === false) {
          results.push({ runtimeId, started: false, reason: ownership.reason ?? 'not-owned' });
          continue;
        }
        try {
          const result = await runtimeManager.admit(runtimeId, {
            warmup: true,
            force: false,
            reason: 'preferred-warm-reconcile',
            allowEviction: true,
            preferredRestore: true,
            admissionGuard: () => !closed,
            preferredWarmIdleMs: idleMs()
          });
          results.push({
            runtimeId,
            started: Boolean(result?.plan?.actions?.some((action) => action.type === 'start') ?? result?.started),
            result
          });
        } catch (error) {
          results.push({
            runtimeId,
            started: false,
            reason: error?.code === 'runtime_eviction_forbidden' ? 'insufficient-memory' : 'admission-failed',
            warning: error?.message ?? String(error)
          });
        }
      }
      return { reconciled: results };
    } catch (error) {
      return { error: error?.message ?? String(error) };
    } finally {
      running = false;
    }
  }

  function reconcileOnce() {
    if (running) return Promise.resolve({ skipped: 'overlap' });
    activePass = runPass();
    return activePass;
  }

  return {
    reconcileOnce,
    start() {
      if (timer || closed) return;
      timer = setInterval(() => {
        reconcileOnce().catch((error) => logger?.warn?.(`preferred residency reconcile failed: ${error?.message}`));
      }, period);
      timer.unref?.();
    },
    stop() {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return activePass;
    },
    get running() {
      return running;
    },
    get closed() {
      return closed;
    }
  };
}

export { DEFAULT_INTERVAL_MS as PREFERRED_RESIDENCY_INTERVAL_MS, DEFAULT_IDLE_MS as PREFERRED_WARM_IDLE_MS };
