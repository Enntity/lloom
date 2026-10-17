import { currentNodeId } from './cluster.mjs';
import { REQUEST_CLASSES, normalizeSchedulingClass } from './request-class.mjs';

export { REQUEST_CLASSES, normalizeSchedulingClass } from './request-class.mjs';

// Priority scheduling for connected gateway inference requests.
//
// Admission is coordinated per compute group across its models and aliases.
// Priority is strict for "the next available capacity": higher-class work that
// is queued or running always dispatches before lower-class work, and lower
// classes pause while higher work is active plus an idle cooldown, then ramp
// back without a backlog burst. Nothing here pauses or resumes a GPU: an
// accepted request keeps its stream and simply waits its turn.

function classRank(requestClass) {
  return REQUEST_CLASSES.indexOf(normalizeSchedulingClass(requestClass));
}

function nonNegativeInteger(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.min(Math.floor(number), maximum) : fallback;
}

function boundedDelay(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, 3_600_000) : fallback;
}

export class RequestQueueOverflowError extends Error {
  constructor({ group = null, limit = 0 } = {}) {
    super('gateway request queue is full; retry shortly');
    this.name = 'RequestQueueOverflowError';
    this.code = 'REQUEST_QUEUE_FULL';
    this.statusCode = 429;
    this.type = 'rate_limit_error';
    this.retryAfterSeconds = 2;
    this.group = group;
    this.limit = limit;
  }
}

export class RequestSchedulingTimeoutError extends Error {
  constructor({ group = null, timeoutMs = 0 } = {}) {
    super('gateway request scheduling timed out; retry shortly');
    this.name = 'RequestSchedulingTimeoutError';
    this.code = 'REQUEST_SCHEDULING_TIMEOUT';
    this.statusCode = 429;
    this.type = 'rate_limit_error';
    this.retryAfterSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    this.group = group;
  }
}

/**
 * Map a resolved request onto the compute group that actually serializes it:
 * - an explicit `modelGroups` entry (gateway model id or alias) wins;
 * - a federated serving node is its own compute group, so a remote node's
 *   backlog never blocks unrelated local work;
 * - a managed local runtime shares the machine-wide local compute group;
 * - anything else (unmanaged endpoint, external provider) is isolated by
 *   backend so unrelated cloud traffic is never globally blocked.
 */
export function computeGroupForRequest(config, resolved = {}) {
  const explicit = explicitModelGroup(config, resolved);
  if (explicit) return explicit;
  const node = resolved.model?.selectedNode;
  if (node && node !== currentNodeId(config)) return `node:${node}`;
  const runtimeId = resolved.model?.runtime;
  const runtime = runtimeId ? config?.runtimes?.[runtimeId] : null;
  const managedLocal = Boolean(runtimeId && runtime && runtime.enabled !== false && runtime.management !== 'external');
  if (managedLocal) return 'local';
  return `backend:${resolved.model?.backend ?? 'unmanaged'}`;
}

function explicitModelGroup(config, resolved) {
  const groups = config?.server?.requestScheduling?.modelGroups;
  if (!groups || typeof groups !== 'object') return null;
  for (const id of [resolved.requestedId, resolved.resolvedId, resolved.model?.id]) {
    if (id && typeof groups[id] === 'string' && groups[id]) return groups[id];
  }
  return null;
}

/**
 * Resolve the scheduling class for a request.
 *
 * Precedence (highest first):
 * 1. a trusted API-key identity policy (`apiKeyEnv` -> class), which matches
 *    the presented credential against the configured env var without ever
 *    exposing the secret;
 * 2. an explicit `x-lloom-request-class` header;
 * 3. a configured `x-lloom-client`/`x-client-name` caller-family mapping;
 * 4. a no-header recognized coding-client user agent (codex/claude/opencode/
 *    omp/hermes) -> foreground; every other unclassified caller -> standard.
 *
 * Caller identity never overrides an explicit header. No prompt content is
 * inspected.
 */
export function resolveRequestClass(req, _resolved = {}, { config, env = process.env } = {}) {
  const identity = identityClass(req, { config, env });
  if (identity) return identity;
  const header = req?.headers?.['x-lloom-request-class'];
  if (header != null) return normalizeSchedulingClass(header);
  const family = callerFamily(req);
  const mapped = familyClass(config, family);
  if (mapped) return mapped;
  return 'standard';
}

function identityClass(req, { config, env }) {
  const map = config?.server?.requestScheduling?.apiKeyEnv;
  if (!map || typeof map !== 'object') return null;
  const presented = presentedKey(req);
  if (!presented) return null;
  for (const [envName, requestClass] of Object.entries(map)) {
    const secret = env?.[envName];
    if (typeof secret === 'string' && secret.length > 0 && secret === presented) {
      return REQUEST_CLASSES.includes(requestClass) ? requestClass : null;
    }
  }
  return null;
}

function presentedKey(req) {
  const bearer = String(req?.headers?.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const xApiKey = req?.headers?.['x-api-key'];
  if (xApiKey == null || xApiKey === '') return null;
  return Array.isArray(xApiKey) ? xApiKey[0] : String(xApiKey);
}

function callerFamily(req) {
  const explicit = safeToken(req?.headers?.['x-lloom-client'] ?? req?.headers?.['x-client-name']);
  if (explicit) return explicit;
  const userAgent = String(req?.headers?.['user-agent'] ?? '').toLowerCase();
  const families = [
    ['codex', 'codex'],
    ['oh-my-pi', 'omp'],
    ['open-code', 'opencode'],
    ['opencode', 'opencode'],
    ['claude', 'claude'],
    ['hermes', 'hermes'],
    ['curl/', 'curl'],
    ['undici', 'node'],
    ['python', 'python'],
    ['node', 'node'],
    ['go-http-client', 'go']
  ];
  const family = families.find(([needle]) => userAgent.includes(needle))?.[1];
  return family ?? safeToken(req?.headers?.['x-stainless-lang']);
}

function safeToken(value) {
  const text = String(Array.isArray(value) ? value[0] : (value ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 64);
  return text.toLowerCase() || null;
}

// Coding clients that are recognized as interactive-aware foreground work even
// when they send no scheduling header. Includes hermes, a family this gateway
// recognizes by name rather than by a user-agent needle.
const RECOGNIZED_CODING_FAMILIES = new Set(['codex', 'claude', 'opencode', 'omp', 'hermes']);

function familyClass(config, family) {
  const map = config?.server?.requestScheduling?.clients;
  if (
    map &&
    typeof map === 'object' &&
    family &&
    typeof map[family] === 'string' &&
    REQUEST_CLASSES.includes(map[family])
  ) {
    return map[family];
  }
  return RECOGNIZED_CODING_FAMILIES.has(family) ? 'foreground' : null;
}

const MODES = new Set(['adaptive', 'interrupt', 'off']);

export function normalizeSchedulingMode(value) {
  return typeof value === 'string' && MODES.has(value) ? value : 'adaptive';
}

export class RequestScheduler {
  constructor({ mode = 'adaptive', now = Date.now, settings = () => ({}) } = {}) {
    this.mode = normalizeSchedulingMode(mode);
    this.now = now;
    this.settings = settings;
    this.groups = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.dispatchWaiters = new Set();
    this.changeWaiters = new Set();
    this.nudging = false;
    this.nudgeAgain = false;
  }

  settingsFor() {
    return normalizeSchedulingSettings(this.settings());
  }

  stateFor(id) {
    if (!this.groups.has(id))
      this.groups.set(id, {
        leases: new Set(),
        waiters: [],
        timer: null,
        foregroundUntil: 0,
        interactiveUntil: 0,
        nextBackgroundAt: 0
      });
    return this.groups.get(id);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitForChange({ signal = null, timeoutMs = 2000 } = {}) {
    if (this.closed || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', finish);
        this.changeWaiters.delete(finish);
        resolve();
      };
      const unsubscribe = this.subscribe(finish);
      this.changeWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, Math.max(1, timeoutMs));
    });
  }

  refresh(mode, { notify = true } = {}) {
    this.mode = normalizeSchedulingMode(mode);
    if (notify) this.nudge();
  }

  capacity(state) {
    const { backgroundMaxConcurrency: max, rampIntervalMs: interval } = this.settingsFor();
    const idleAt = Math.max(state.foregroundUntil, state.interactiveUntil);
    if (!idleAt || !interval) return max;
    return Math.min(max, 1 + Math.floor(Math.max(0, this.now() - idleAt) / interval));
  }

  held(state, requestClass) {
    const rank = classRank(requestClass);
    const higher = (entry) => classRank(entry.requestClass) > rank;
    if ([...state.leases, ...state.waiters].some(higher)) return true;
    if (rank < 2 && this.now() < state.foregroundUntil) return true;
    return rank < 1 && this.now() < state.interactiveUntil;
  }

  readyFor(lease) {
    if (!lease || lease.released || this.closed) return false;
    if (this.mode !== 'adaptive' || lease.started) return true;
    const state = this.stateFor(lease.groupId);
    if (this.held(state, lease.requestClass)) return false;
    if (lease.requestClass !== 'standard') return true;
    if (this.now() < state.nextBackgroundAt) return false;
    const standard = [...state.leases].filter((entry) => entry.requestClass === 'standard');
    return standard.indexOf(lease) < this.capacity(state);
  }

  higherDemandForScopes(lease, scopeIds, appliesToClass = () => true) {
    if (this.mode !== 'adaptive' || !scopeIds.length) return false;
    const scopes = new Set(scopeIds);
    const rank = classRank(lease.requestClass);
    for (const state of this.groups.values()) {
      if (
        [...state.leases, ...state.waiters].some(
          (entry) =>
            classRank(entry.requestClass) > rank &&
            entry.scopeIds?.some((id) => scopes.has(id) && appliesToClass(id, entry.requestClass))
        )
      )
        return true;
    }
    return false;
  }

  admit({ requestClass = 'standard', groupId = 'local', scopeIds = [], signal = null } = {}) {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(closedError());
    const state = this.stateFor(groupId);
    const entry = {
      requestClass: normalizeSchedulingClass(requestClass),
      groupId,
      scopeIds: [...new Set(scopeIds)],
      signal
    };
    return new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject, timer: null, onAbort: null });
      entry.onAbort = () => {
        this.removeWaiter(state, entry);
        reject(signal.reason ?? abortError());
        this.nudge();
      };
      const queued =
        state.waiters.filter((waiter) => waiter.requestClass === entry.requestClass).length +
        [...state.leases].filter((lease) => !lease.started && lease.requestClass === entry.requestClass).length;
      if (queued >= this.settingsFor().maxQueuedRequests && queued > 0) {
        reject(new RequestQueueOverflowError({ group: groupId, limit: this.settingsFor().maxQueuedRequests }));
        return;
      }
      state.waiters.push(entry);
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      const timeout = this.settingsFor().queueTimeoutMs;
      if (timeout)
        entry.timer = setTimeout(() => {
          this.removeWaiter(state, entry);
          reject(new RequestSchedulingTimeoutError({ group: groupId, timeoutMs: timeout }));
          this.nudge();
        }, timeout);
      this.nudge();
      // An immediately runnable request needs no waiting-room capacity.
      if (
        state.waiters.includes(entry) &&
        state.waiters.filter((waiter) => waiter.requestClass === entry.requestClass).length >
          this.settingsFor().maxQueuedRequests
      ) {
        this.removeWaiter(state, entry);
        reject(new RequestQueueOverflowError({ group: groupId, limit: this.settingsFor().maxQueuedRequests }));
        this.nudge();
      }
    });
  }

  removeWaiter(state, entry) {
    const index = state.waiters.indexOf(entry);
    if (index >= 0) state.waiters.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
  }

  activate(state, entry) {
    this.removeWaiter(state, entry);
    const lease = {
      requestClass: entry.requestClass,
      groupId: entry.groupId,
      scopeIds: entry.scopeIds,
      started: false,
      released: false,
      release: () => {
        if (lease.released) return;
        lease.released = true;
        state.leases.delete(lease);
        if (lease.requestClass !== 'standard') {
          const field = lease.requestClass === 'foreground' ? 'foregroundUntil' : 'interactiveUntil';
          state[field] = this.now() + this.settingsFor().foregroundIdleMs;
          state.nextBackgroundAt = 0;
        }
        this.nudge();
      }
    };
    state.leases.add(lease);
    entry.resolve(lease);
  }

  markStarted(lease) {
    lease.started = true;
    if (lease.requestClass === 'standard') {
      const state = this.stateFor(lease.groupId);
      const { rampIntervalMs: interval, backgroundMaxConcurrency: max } = this.settingsFor();
      const idleAt = Math.max(state.foregroundUntil, state.interactiveUntil);
      if (idleAt && this.now() < idleAt + interval * max) state.nextBackgroundAt = this.now() + interval;
    }
    // Slot activation follows this synchronous callback. Notify other queues
    // afterward so a nested pump cannot consume capacity before it is recorded.
    queueMicrotask(() => this.nudge());
  }

  waitFor(lease, predicate, signal) {
    signal?.throwIfAborted();
    if (this.closed || lease.released) return Promise.reject(closedError());
    try {
      if (predicate()) return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.settingsFor().maxQueuedRequests === 0) {
      return Promise.reject(new RequestQueueOverflowError({ group: lease.groupId, limit: 0 }));
    }
    return new Promise((resolve, reject) => {
      const entry = { lease, predicate, resolve, reject, timer: null, signal, onAbort: null };
      entry.onAbort = () => this.finishDispatch(entry, signal.reason ?? abortError());
      this.dispatchWaiters.add(entry);
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      const timeout = this.settingsFor().queueTimeoutMs;
      if (timeout)
        entry.timer = setTimeout(
          () =>
            this.finishDispatch(entry, new RequestSchedulingTimeoutError({ group: lease.groupId, timeoutMs: timeout })),
          timeout
        );
      this.nudge();
    });
  }

  finishDispatch(entry, error = null) {
    if (!this.dispatchWaiters.delete(entry)) return;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (error) entry.reject(error);
    else entry.resolve();
  }

  nudge() {
    if (this.closed) return;
    if (this.nudging) {
      this.nudgeAgain = true;
      return;
    }
    this.nudging = true;
    try {
      this.pump();
    } finally {
      this.nudging = false;
      if (this.nudgeAgain) {
        this.nudgeAgain = false;
        queueMicrotask(() => this.nudge());
      }
    }
  }

  pump() {
    for (const [id, state] of this.groups) {
      clearTimeout(state.timer);
      state.timer = null;
      const ordered = [...state.waiters].sort((a, b) => classRank(b.requestClass) - classRank(a.requestClass));
      for (const entry of ordered) {
        if (this.mode === 'adaptive' && this.held(state, entry.requestClass)) continue;
        if (this.mode === 'adaptive' && entry.requestClass === 'standard') {
          const active = [...state.leases].filter((lease) => lease.requestClass === 'standard').length;
          if (active >= this.capacity(state) || this.now() < state.nextBackgroundAt) continue;
        }
        this.activate(state, entry);
      }
      const pending = state.waiters.length || [...state.leases].some((lease) => !lease.started);
      if (pending && this.mode === 'adaptive') {
        const now = this.now();
        const until = Math.max(state.foregroundUntil, state.interactiveUntil);
        const interval = this.settingsFor().rampIntervalMs;
        const deadlines = [state.foregroundUntil, state.interactiveUntil, state.nextBackgroundAt];
        if (until && interval && this.capacity(state) < this.settingsFor().backgroundMaxConcurrency) {
          deadlines.push(until + this.capacity(state) * interval);
        }
        const next = Math.min(...deadlines.filter((at) => at > now));
        if (Number.isFinite(next)) state.timer = setTimeout(() => this.nudge(), Math.max(1, next - now));
      }
      // Briefly idle background work must not reset recovery to a full burst.
      // Retain the quiet group through cooldown, ramp, and start pacing, then
      // expire it even if no further request arrives.
      if (!pending && !state.leases.size) {
        const { rampIntervalMs: interval, backgroundMaxConcurrency: max } = this.settingsFor();
        const idleAt = Math.max(state.foregroundUntil, state.interactiveUntil);
        const forgetAt = Math.max(idleAt ? idleAt + interval * max : 0, state.nextBackgroundAt);
        if (this.now() >= forgetAt) this.groups.delete(id);
        else if (!state.timer) state.timer = setTimeout(() => this.nudge(), Math.max(1, forgetAt - this.now()));
      }
    }
    for (const entry of [...this.dispatchWaiters].sort(
      (a, b) => classRank(b.lease.requestClass) - classRank(a.lease.requestClass)
    )) {
      try {
        if (entry.predicate()) this.finishDispatch(entry);
      } catch (error) {
        this.finishDispatch(entry, error);
      }
    }
    for (const fn of this.listeners) fn();
  }

  status() {
    return {
      mode: this.mode,
      groups: Object.fromEntries(
        [...this.groups].map(([id, state]) => {
          const active = Object.fromEntries(
            REQUEST_CLASSES.map((c) => [c, [...state.leases].filter((v) => v.requestClass === c && v.started).length])
          );
          const queued = Object.fromEntries(
            REQUEST_CLASSES.map((c) => [
              c,
              state.waiters.filter((v) => v.requestClass === c).length +
                [...state.leases].filter((v) => v.requestClass === c && !v.started).length
            ])
          );
          return [
            id,
            {
              active,
              queued,
              backgroundCapacity: this.capacity(state),
              cooldownUntil: Math.max(state.foregroundUntil, state.interactiveUntil),
              recovering: this.capacity(state) < this.settingsFor().backgroundMaxConcurrency
            }
          ];
        })
      )
    };
  }

  close(error = closedError()) {
    this.closed = true;
    for (const state of this.groups.values()) {
      clearTimeout(state.timer);
      for (const entry of [...state.waiters]) {
        this.removeWaiter(state, entry);
        entry.reject(error);
      }
    }
    for (const entry of [...this.dispatchWaiters]) this.finishDispatch(entry, error);
    for (const finish of [...this.changeWaiters]) finish();
    this.listeners.clear();
  }
}

export function normalizeSchedulingSettings(raw = {}) {
  return {
    maxQueuedRequests: nonNegativeInteger(raw.maxQueuedRequests, 1024),
    queueTimeoutMs: nonNegativeInteger(raw.queueTimeoutMs, 0),
    backgroundMaxConcurrency: nonNegativeInteger(raw.backgroundMaxConcurrency, 4, { minimum: 1 }),
    rampIntervalMs: nonNegativeInteger(raw.rampIntervalMs, 1000),
    foregroundIdleMs: boundedDelay(raw.foregroundIdleMs, 60_000)
  };
}

function abortError() {
  return Object.assign(new Error('request cancelled while waiting for admission'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  });
}
function closedError() {
  return Object.assign(new Error('gateway is closing'), { code: 'REQUEST_SCHEDULER_CLOSED', statusCode: 503 });
}
export function isSchedulingBackpressure(error) {
  return ['REQUEST_QUEUE_FULL', 'REQUEST_SCHEDULING_TIMEOUT', 'REQUEST_SCHEDULER_CLOSED'].includes(error?.code);
}
