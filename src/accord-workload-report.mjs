// LLooM reports its configured runtimes to the local Accord host so reservations
// can show manager state as an observation. Every failure mode — missing Accord,
// an older host that rejects the operation, timeouts — is logged once and never
// affects the gateway or admission.
import { accordAdmin } from './accord-client.mjs';
import { runtimeMaintenance } from './model-maintenance.mjs';
import { dockerContainerName } from './runtime-manager.mjs';

const REPORT_STATES = new Map([
  ['running', 'running'],
  ['external', 'running'],
  ['starting', 'starting'],
  ['warming', 'starting'],
  ['queued', 'starting'],
  ['stopping', 'stopping'],
  ['draining', 'stopping'],
  ['stopped', 'stopped'],
  ['exited', 'stopped'],
  ['created', 'stopped'],
  ['idle', 'stopped'],
  ['dead', 'stopped'],
  ['paused', 'stopped'],
  ['failed', 'failed']
]);

function reportState(status, maintenance) {
  if (maintenance?.state === 'suspended') return 'suspended';
  if (maintenance?.state === 'resuming') return 'starting';
  return REPORT_STATES.get(status) ?? 'unknown';
}

function epochMs(value) {
  if (value == null) return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function createAccordWorkloadReporter({
  getConfig,
  manager,
  logger = console,
  clientFor = () => accordAdmin(),
  intervalMs = 60000,
  debounceMs = 2000,
  ttlMs = 180000,
  source = 'lloom'
} = {}) {
  let interval = null;
  let debounce = null;
  let inflight = null;
  let stopped = false;
  const logged = new Set();

  function modelFor(config, runtimeId) {
    return (config.models ?? []).find((model) => model.runtime === runtimeId)?.id ?? undefined;
  }

  async function items() {
    const config = getConfig();
    const status = typeof manager?.status === 'function' ? await manager.status().catch(() => null) : null;
    const list = [];
    for (const [id, runtime] of Object.entries(config.runtimes ?? {})) {
      if (runtime?.enabled !== true) continue;
      const maintenance = runtimeMaintenance(config, id);
      const live = status?.runtimes?.[id] ?? null;
      const item = {
        id,
        kind: 'runtime',
        state: reportState(live?.status, maintenance)
      };
      const node = runtime.node ?? runtime.placement?.node;
      if (node) item.node = node;
      const container = dockerContainerName(runtime);
      if (container) item.container = container;
      const model = modelFor(config, id);
      if (model) item.model = model;
      const since = epochMs(maintenance?.since) ?? epochMs(live?.statusSince) ?? epochMs(live?.startedAt);
      if (since != null) item.since = since;
      if (maintenance?.by) item.by = maintenance.by;
      if (maintenance?.operationId) item.operationId = maintenance.operationId;
      list.push(item);
    }
    return list;
  }

  async function send() {
    if (stopped) return;
    try {
      await clientFor().collaborate('workload-report', {
        source,
        ttlMs,
        items: await items()
      });
    } catch (error) {
      const message = `Accord workload report failed; runtime state is unaffected: ${error?.message ?? error}`;
      if (!logged.has(message)) {
        logged.add(message);
        logger.error?.(message);
      }
    }
  }

  function report() {
    inflight ??= send().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    start() {
      if (stopped || interval) return;
      interval = setInterval(report, intervalMs);
      interval.unref?.();
      void report();
    },
    notifyChanged() {
      if (stopped) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        report();
      }, debounceMs);
      debounce.unref?.();
    },
    sendNow: report,
    async stop() {
      stopped = true;
      if (interval) clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      interval = null;
      debounce = null;
      await inflight;
    }
  };
}
