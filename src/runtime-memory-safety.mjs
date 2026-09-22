import os from 'node:os';
import { readHostMemory } from './host-memory.mjs';

const GiB = 1024 ** 3;

export class RuntimeMemorySafetyError extends Error {
  constructor(message, { runtimeId, snapshot, policy } = {}) {
    super(message);
    this.name = 'RuntimeMemorySafetyError';
    this.code = 'runtime_memory_safety_abort';
    this.type = 'runtime_memory_safety_error';
    this.statusCode = 503;
    this.temporary = false;
    this.runtimeId = runtimeId;
    this.snapshot = snapshot;
    this.policy = policy;
  }
}

export function memorySafetyPolicy(config, totalMemoryGb = os.totalmem() / GiB) {
  const input = config.runtimePolicy?.memorySafety ?? {};
  const configuredReserve = config.runtimePolicy?.reserveMemoryGb;
  const minAvailableMemoryGb = input.minAvailableMemoryGb ?? Math.min(configuredReserve ?? 8, totalMemoryGb * 0.15);
  const maxMemoryUtilization = Math.min(
    input.maxMemoryUtilization ?? 0.9,
    config.runtimePolicy?.maxMemoryUtilization ?? 0.9
  );
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const mode = input.mode ?? 'enforce';
  if (
    !['enforce', 'yolo'].includes(mode) ||
    !Number.isFinite(minAvailableMemoryGb) ||
    minAvailableMemoryGb <= 0 ||
    !Number.isFinite(maxMemoryUtilization) ||
    maxMemoryUtilization <= 0 ||
    maxMemoryUtilization >= 1 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > 1000
  ) {
    throw new RuntimeMemorySafetyError('Invalid memory safety limits; refusing to load a model.');
  }
  return { mode, minAvailableMemoryGb, maxMemoryUtilization, pollIntervalMs };
}

export function assertMemorySafety(policy, snapshot, runtimeId) {
  if (policy.mode === 'yolo') return;
  const total = snapshot?.totalBytes;
  const available = snapshot?.availableBytes;
  let detail;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available) || available < 0 || available > total) {
    detail = 'host memory could not be measured';
  } else if (available <= policy.minAvailableMemoryGb * GiB) {
    detail = `${(available / GiB).toFixed(1)} GB available reached the ${policy.minAvailableMemoryGb.toFixed(1)} GB hard reserve`;
  } else if (1 - available / total >= policy.maxMemoryUtilization) {
    detail = `host memory use reached the ${(policy.maxMemoryUtilization * 100).toFixed(1)}% hard ceiling`;
  }
  if (detail)
    throw new RuntimeMemorySafetyError(`Load aborted to protect this machine: ${detail}.`, {
      runtimeId,
      snapshot,
      policy
    });
}

// One operation owns one guard. Samples never overlap, and stop() waits for a
// pending sample so a stale callback cannot kill a later operation.
export function createMemorySafetyGuard({
  policy,
  runtimeId,
  sample = () => readHostMemory({ strict: true }),
  onAbort = () => {}
}) {
  const controller = new AbortController();
  let stopped = false;
  let timer;
  let inFlight;
  const trip = (cause) => {
    if (stopped || controller.signal.aborted) return;
    const error =
      cause instanceof RuntimeMemorySafetyError
        ? cause
        : new RuntimeMemorySafetyError('Load aborted: host memory could not be measured.', { runtimeId, policy });
    controller.abort(error);
    onAbort(error);
  };
  const check = () => {
    if (policy.mode === 'yolo' || stopped) return Promise.resolve();
    controller.signal.throwIfAborted();
    if (!inFlight) {
      inFlight = (async () => {
        // A stuck sampler is also unsafe; do not leave the load unguarded.
        let deadline;
        try {
          const snapshot = await Promise.race([
            Promise.resolve().then(sample),
            new Promise((_, reject) => {
              deadline = setTimeout(() => reject(new Error('Memory sampler timed out')), 1000);
            })
          ]);
          if (!stopped) assertMemorySafety(policy, snapshot, runtimeId);
        } catch (error) {
          trip(error);
        } finally {
          clearTimeout(deadline);
        }
      })().finally(() => {
        inFlight = null;
      });
    }
    return inFlight.then(() => controller.signal.throwIfAborted());
  };
  const tick = async () => {
    try {
      await check();
    } catch {
      return;
    }
    if (!stopped) {
      timer = setTimeout(tick, policy.pollIntervalMs);
      timer.unref?.();
    }
  };
  return {
    signal: controller.signal,
    check,
    trip,
    start() {
      if (!stopped && policy.mode !== 'yolo') void tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    }
  };
}
