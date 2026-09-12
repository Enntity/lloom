// Model and alias rate limiting.
//
// Two standard primitives, deliberately boring:
// - Concurrency: a counting semaphore (the same shape as NGINX `limit_conn` /
//   Envoy's per-route `max_requests` connection pool limit). Requests over the
//   limit queue in FIFO order instead of being rejected, matching how LLooM
//   already queues runtime slots.
// - Rate: GCRA (Generic Cell Rate Algorithm, the leaky-bucket variant used by
//   NGINX `limit_req`, Envoy's local rate limiter, Redis `GCRA`, and Cloudflare).
//   It bounds the average request rate with a small burst allowance and does
//   not gate the first request: a burst up to the configured burst size starts
//   immediately, then requests are spaced at the configured interval. No
//   background timers; state advances lazily on each request.
//
// A limiter admission returns the delay until the request may proceed, so
// callers gate requests and time out the wait the same way they gate on the
// concurrency semaphore. Waiters keep their queue order (fairness), and an
// aborted request removes itself without consuming rate budget.

const MAX_WAIT_MS = 5 * 60 * 1000;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = positiveNumber(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Normalize a `rateLimit` definition. Returns null when absent or not configured. */
export function normalizeRateLimit(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    return normalizeRateLimit({ rate: value });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rateLimit must be a string like "20/m" or an object');
  }
  const settings = value.rateLimit ?? value;
  const rawMaxConcurrent = settings.maxConcurrent ?? settings.concurrency;
  const maxConcurrent = positiveInteger(rawMaxConcurrent);
  // A fractional or zero value floors to 0, which would silently mean "no
  // limit" instead of the limit the operator asked for.
  if (rawMaxConcurrent != null && (maxConcurrent == null || maxConcurrent < 1)) {
    throw new Error(`rateLimit.maxConcurrent must be a positive integer: ${JSON.stringify(rawMaxConcurrent)}`);
  }
  let rateMs = null;
  let burst = null;
  if (settings.rateMs != null) {
    // Already normalized (idempotent re-validation after hot reload).
    const normalizedRateMs = positiveNumber(settings.rateMs);
    if (normalizedRateMs == null)
      throw new Error(`rateLimit.rateMs must be a positive number: ${JSON.stringify(settings.rateMs)}`);
    rateMs = normalizedRateMs;
    if (settings.burst != null && (!Number.isSafeInteger(settings.burst) || settings.burst < 0)) {
      throw new Error('rateLimit.burst must be a non-negative integer');
    }
    burst = settings.burst ?? 0;
    return { maxConcurrent, burst, rateMs };
  }
  const rate = settings.rate ?? settings.requestsPerMinute ?? settings.requests;
  let rateCount = null;
  if (rate != null) {
    if (typeof rate === 'string') {
      const match = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(s|sec|second|m|min|minute|h|hour|d|day)\s*$/i.exec(rate);
      if (!match) throw new Error(`rateLimit.rate must look like "<n>/(s|m|h|d)": ${JSON.stringify(rate)}`);
      const count = Number(match[1]);
      if (!Number.isFinite(count) || count <= 0) {
        throw new Error(`rateLimit.rate must be a positive number: ${JSON.stringify(rate)}`);
      }
      const unit = match[2].toLowerCase();
      const unitMs =
        unit[0] === 's'
          ? 1000
          : unit[0] === 'm'
            ? 60_000
            : unit[0] === 'h'
              ? 3_600_000
              : unit[0] === 'd'
                ? 86_400_000
                : 0;
      rateMs = unitMs / count;
      rateCount = count;
    } else if (typeof rate === 'number') {
      if (!Number.isFinite(rate) || !(rate > 0))
        throw new Error(`rateLimit.rate must be a positive number: ${JSON.stringify(rate)}`);
      const period = settings.period ?? settings.per;
      const periodMs = period == null ? 60_000 : periodMsValue(period);
      if (periodMs == null) throw new Error(`rateLimit.period must be one of s, m, h, d or milliseconds`);
      rateMs = periodMs / rate;
      rateCount = rate;
    } else {
      throw new Error('rateLimit.rate must be a string like "20/m" or a number');
    }
  }
  if (settings.burst != null) {
    burst = Number.isInteger(settings.burst) && settings.burst >= 0 ? settings.burst : null;
    if (burst == null) {
      throw new Error(`rateLimit.burst must be a non-negative integer: ${JSON.stringify(settings.burst)}`);
    }
  }
  if (maxConcurrent == null && rateMs == null) {
    throw new Error('rateLimit must set maxConcurrent, a rate string like "20/m", or both');
  }
  if (!maxConcurrent && rateMs == null) return null;
  return {
    maxConcurrent,
    // A bare rate "n/period" means "n requests per period": burst n-1 lets the
    // first n requests through back-to-back, then the leaky bucket spaces the
    // rest at the steady interval (GCRA, the nginx limit_req / Envoy model).
    // An explicit burst overrides this.
    burst: rateMs == null ? 0 : (burst ?? Math.max(0, Math.floor(rateCount) - 1)),
    rateMs
  };
}

function periodMsValue(period) {
  if (typeof period === 'number' && Number.isFinite(period) && period > 0) return period;
  if (typeof period === 'string') {
    const unit = period.trim().toLowerCase();
    if (unit === 's' || unit === 'sec' || unit === 'second') return 1000;
    if (unit === 'm' || unit === 'min' || unit === 'minute') return 60_000;
    if (unit === 'h' || unit === 'hour') return 3_600_000;
    if (unit === 'd' || unit === 'day') return 86_400_000;
    const number = Number(unit);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

/**
 * Counting semaphore with a FIFO wait queue. `acquire(signal)` resolves with a
 * release function; `release()` is idempotent.
 */
export function createSemaphore(limit) {
  let max = Math.max(1, Math.floor(Number(limit) || 1));
  let active = 0;
  const waiters = [];
  function tryAdmit(entry) {
    if (active >= max) return false;
    active += 1;
    cleanup(entry);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      release();
    });
    return true;
  }
  function release() {
    if (active > 0) active -= 1;
    if (active < max && waiters.length) tryAdmit(waiters.shift());
  }
  function cleanup(entry) {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
  }
  function fail(entry, error) {
    const index = waiters.indexOf(entry);
    if (index >= 0) waiters.splice(index, 1);
    cleanup(entry);
    entry.reject(error);
  }
  return {
    get active() {
      return active;
    },
    get queued() {
      return waiters.length;
    },
    get limit() {
      return max;
    },
    /** Apply a hot-reloaded limit, admitting queued waiters if it grew. */
    setLimit(next) {
      max = Math.max(1, Math.floor(Number(next) || 1));
      while (active < max && waiters.length) {
        const entry = waiters.shift();
        cleanup(entry);
        tryAdmit(entry);
      }
    },
    acquire(signal = null, { timeoutMs = MAX_WAIT_MS } = {}) {
      signal?.throwIfAborted?.();
      const entry = { signal, timer: null, onAbort: null, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.onAbort = () => fail(entry, signal?.reason ?? abortError());
      if (!tryAdmit(entry)) {
        waiters.push(entry);
        signal?.addEventListener?.('abort', entry.onAbort, { once: true });
        if (signal?.aborted) entry.onAbort();
        else {
          // Every wait is bounded, including the default: cap at MAX_WAIT_MS.
          const waitMs = Math.min(positiveNumber(timeoutMs) ?? MAX_WAIT_MS, MAX_WAIT_MS);
          entry.timer = setTimeout(() => fail(entry, timeoutError(waitMs)), waitMs);
          entry.timer.unref?.();
        }
      }
      return promise;
    }
  };
}
/**
 * Token-bucket (leaky bucket) state for one key — the nginx `limit_req` /
 * Envoy local-rate-limiter model. `burst` tokens may drain instantly; beyond
 * that, tokens refill continuously at one per `intervalMs`. A burst of zero
 * admits one request immediately and spaces the rest at the interval, giving
 * exact "n requests per period" counts. Pure and lazy: no timers, state
 * derived from elapsed time on each request.
 */
export function createGcra({ rateMs, burst }) {
  let intervalMs = Math.max(1, rateMs);
  let capacity = Math.max(0, Math.floor(burst)); // extra burst tokens above the nominal cell
  let tokens = capacity + 1; // start full: one nominal token plus any burst tokens
  let last = null; // last refill/accept time
  function refill(now) {
    if (last == null) return;
    // Refill to the full bucket (nominal token + burst), not merely to the
    // burst allowance: capping at `capacity` starves a zero-burst limiter,
    // which can then never admit again after its first request.
    tokens = Math.min(capacity + 1, tokens + (now - last) / intervalMs);
    last = now;
  }
  return {
    get intervalMs() {
      return intervalMs;
    },
    get burst() {
      return capacity;
    },
    get active() {
      return last != null;
    },
    /** Apply hot-reloaded settings in place, keeping the bucket's timing. */
    reconfigure({ rateMs: nextRateMs, burst: nextBurst }) {
      intervalMs = Math.max(1, nextRateMs);
      capacity = Math.max(0, Math.floor(nextBurst));
      tokens = Math.min(capacity + 1, tokens);
    },
    tryAcquire(now = Date.now()) {
      if (last == null) {
        last = now;
        tokens -= 1;
        return { allowed: true, retryAfterMs: 0, remainingBurst: tokens };
      }
      refill(now);
      if (tokens < 1) {
        return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) * intervalMs), remainingBurst: 0 };
      }
      tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remainingBurst: Math.floor(tokens) };
    },
    /** Peek at the next allowed time without consuming budget. */
    nextAllowedInMs(now = Date.now()) {
      if (last == null) return 0;
      const projected = Math.min(capacity + 1, tokens + Math.max(0, now - (last ?? now)) / intervalMs);
      return projected >= 1 ? 0 : Math.ceil((1 - projected) * intervalMs);
    },
    /** Return a consumed token when a later limiter rejects the same chain. */
    refund() {
      tokens = Math.min(capacity + 1, tokens + 1);
    }
  };
}

/**
 * Registry of limiters keyed by string ids (one limiter per alias chain /
 * model). `limits` maps id -> normalized rateLimit settings. Entries for ids
 * that no longer appear in `limits` are dropped, so hot config reloads prune
 * stale state; surviving entries keep their buckets.
 */
export function createRateLimitRegistry(limits = {}) {
  const limiters = new Map();
  function sync(limitsNow) {
    // Validate and normalize the full incoming map BEFORE touching live state so
    // a malformed value cannot half-apply and strand in-flight releases.
    const normalized = new Map();
    for (const [id, rawSettings] of Object.entries(limitsNow)) {
      // Settings may arrive unnormalized when a server is constructed from a
      // hand-built config (tests, CLI fixtures): normalize defensively here.
      let settings;
      try {
        settings = normalizeRateLimit(rawSettings);
      } catch (error) {
        throw new Error(`invalid rateLimit for ${id}: ${error.message}`, { cause: error });
      }
      if (settings) normalized.set(id, settings);
    }
    for (const id of [...limiters.keys()]) {
      if (!normalized.has(id)) {
        const entry = limiters.get(id);
        entry.gcra = null;
        entry.semaphore?.setLimit(Number.MAX_SAFE_INTEGER);
        limiters.delete(id);
      }
    }
    for (const [id, settings] of normalized) {
      const entry = limiters.get(id);
      if (!entry) {
        limiters.set(id, {
          settings,
          semaphore: settings.maxConcurrent ? createSemaphore(settings.maxConcurrent) : null,
          gcra: settings.rateMs ? createGcra(settings) : null
        });
        continue;
      }
      // A surviving id keeps its live slots, queue, and bucket state, but a
      // changed limit must still take effect on reload. Reconfigure in place so
      // tightening concurrency cannot transiently over-admit.
      if (
        entry.settings.maxConcurrent === settings.maxConcurrent &&
        entry.settings.rateMs === settings.rateMs &&
        entry.settings.burst === settings.burst
      ) {
        continue;
      }
      if (settings.maxConcurrent) {
        if (entry.semaphore) entry.semaphore.setLimit(settings.maxConcurrent);
        else entry.semaphore = createSemaphore(settings.maxConcurrent);
      } else {
        entry.semaphore?.setLimit(Number.MAX_SAFE_INTEGER);
        entry.semaphore = null;
      }
      if (settings.rateMs) {
        if (entry.gcra) entry.gcra.reconfigure(settings);
        else entry.gcra = createGcra(settings);
      } else entry.gcra = null;
      entry.settings = settings;
    }
  }
  sync(limits);
  return {
    sync,
    limiter(id) {
      return limiters.get(id) ?? null;
    },
    get size() {
      return limiters.size;
    },
    status(now = Date.now()) {
      return [...limiters.entries()].map(([id, entry]) => ({
        id,
        maxConcurrent: entry.settings.maxConcurrent ?? null,
        rateMs: entry.settings.rateMs ?? null,
        burst: entry.settings.burst ?? null,
        active: entry.semaphore?.active ?? 0,
        queued: entry.semaphore?.queued ?? 0,
        rateLimited: entry.gcra ? entry.gcra.nextAllowedInMs(now) > 0 : false,
        nextAllowedInMs: entry.gcra ? entry.gcra.nextAllowedInMs(now) : 0
      }));
    }
  };
}

/** Acquire semaphore and rate budget for `id`; returns a release function. */
export async function acquireRateLimitSlot(
  registry,
  id,
  { signal = null, timeoutMs = MAX_WAIT_MS, rateBudget = true } = {}
) {
  const entry = registry.limiter(id);
  if (!entry) return () => {};
  // Concurrency waits in a bounded FIFO queue, exactly like runtime slots.
  signal?.throwIfAborted?.();
  const releaseSemaphore = entry.semaphore ? await entry.semaphore.acquire(signal, { timeoutMs }) : () => {};
  try {
    signal?.throwIfAborted?.();
    if (rateBudget && entry.gcra) {
      // Rate budget fails fast with the delay until the next conforming
      // arrival, so callers surface a retryable rejection instead of silently
      // queueing for minutes (the nginx limit_req default without burst delay).
      const decision = entry.gcra.tryAcquire();
      if (!decision.allowed) {
        const error = new Error(
          `rate budget for ${id} exhausted; retry in ${Math.ceil(decision.retryAfterMs / 1000)} seconds`
        );
        error.name = 'RateBudgetExhaustedError';
        error.retryAfterMs = decision.retryAfterMs;
        throw error;
      }
    }
  } catch (error) {
    releaseSemaphore();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSemaphore();
  };
}

/**
 * Consume the rate budget of every id in a resolution chain. The check is
 * atomic: if any limiter rejects, every token already taken is refunded, so a
 * request that never reached a model costs no budget on the scopes it passed.
 */
export function consumeRateBudget(registry, ids) {
  const consumed = [];
  for (const id of ids) {
    const gcra = registry.limiter(id)?.gcra;
    if (!gcra) continue;
    const decision = gcra.tryAcquire();
    if (decision.allowed) {
      consumed.push(gcra);
      continue;
    }
    for (const taken of consumed) taken.refund();
    const error = new Error(
      `rate budget for ${id} exhausted; retry in ${Math.ceil(decision.retryAfterMs / 1000)} seconds`
    );
    error.name = 'RateBudgetExhaustedError';
    error.retryAfterMs = decision.retryAfterMs;
    throw error;
  }
}

function abortError() {
  const error = new Error('client closed while waiting for a model rate limit slot');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function timeoutError(timeoutMs) {
  const error = new Error(`rate limit wait timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = 'ABORT_ERR';
  return error;
}
