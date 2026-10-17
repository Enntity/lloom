// Built-in hardware reservations and agent job log.
//
// One gateway (normally the cluster head) owns the schedule. Agents lease
// named resources from `config.reservations.resources`; a lease runs the
// resource's take actions (route aliases away, suspend models) and its release
// undoes them in reverse, finishing only after resumed models pass their
// health check. Leases expire unless renewed, so a vanished agent cannot hold
// hardware forever. Jobs are agent-posted status records (notes, progress,
// metrics, heartbeat) that a board such as Tessera reads instead of asking each
// agent how it is going.
import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicJson } from './deployment-fence.mjs';

export const SCHEDULE_SCHEMA_VERSION = 1;
const MINUTE = 60_000;
export const SCHEDULE_DEFAULTS = Object.freeze({
  ttlMs: 30 * MINUTE,
  maxTtlMs: 8 * 60 * MINUTE,
  queueTtlMs: 30 * MINUTE,
  warnBeforeMs: 5 * MINUTE,
  staleAfterMs: 15 * MINUTE,
  retentionMs: 7 * 24 * 60 * MINUTE,
  drainTimeoutMs: 5 * MINUTE,
  sweepMs: 15_000,
  eventLimit: 500
});

// Held states keep the resource unavailable to others. `stuck` means a
// restore failed or the gateway restarted mid-action: the hardware is not
// known to be back, so it stays held until a release succeeds.
const HELD = new Set(['acquiring', 'active', 'releasing', 'stuck']);
const OPEN = new Set([...HELD, 'queued']);
const JOB_STATES = new Set(['running', 'done', 'failed', 'cancelled']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const NOTE_HISTORY = 20;
const METRIC_LIMIT = 32;
const RUNNING_JOB_LIMIT = 500;
const QUEUE_LIMIT = 50;
// A running job silent this long is abandoned rather than kept stalled forever.
const ABANDON_AFTER_MS = 24 * 60 * MINUTE;
const EVENT_LOG_ROTATE_BYTES = 16 * 1024 * 1024;

export class ScheduleError extends Error {
  constructor(message, { code = 'schedule_error', statusCode = 400, details } = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    this.type = 'schedule_error';
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function name(value, field) {
  const text = String(value ?? '').trim();
  if (!NAME.test(text)) {
    throw new ScheduleError(`${field} is required and must be a short identifier (letters, digits, ._:@/+-)`, {
      code: 'schedule_invalid_request'
    });
  }
  return text;
}

function text(value, field, max, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new ScheduleError(`${field} is required`, { code: 'schedule_invalid_request' });
    return null;
  }
  const result = String(value).trim();
  if (result.length > max) {
    throw new ScheduleError(`${field} must be at most ${max} characters`, { code: 'schedule_invalid_request' });
  }
  return result || null;
}

function duration(value, field, { min = 1000, max = Infinity, allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < min || ms > max) {
    throw new ScheduleError(`${field} must be an integer number of milliseconds from ${min} to ${max}`, {
      code: 'schedule_invalid_request'
    });
  }
  return ms;
}

function newId(prefix, taken) {
  let id;
  do id = `${prefix}-${randomBytes(4).toString('hex')}`;
  while (Object.hasOwn(taken, id));
  return id;
}

function settings(config) {
  const raw = plainObject(config?.reservations) ?? {};
  const out = {};
  for (const [key, fallback] of Object.entries(SCHEDULE_DEFAULTS)) {
    const value = Number(raw[key]);
    out[key] = Number.isInteger(value) && value > 0 ? value : fallback;
  }
  // Model maintenance refuses longer drains.
  out.drainTimeoutMs = Math.min(out.drainTimeoutMs, 2 * 60 * 60 * 1000);
  return out;
}

function nodeOf(entry) {
  return entry.node == null ? null : name(entry.node, 'node');
}

/** Normalize one configured resource. Throws a ScheduleError for an invalid definition. */
export function normalizeResource(id, raw, config = {}) {
  const resource = plainObject(raw);
  if (!resource) throw new ScheduleError(`reservation resource ${id} must be an object`, { code: 'schedule_config' });
  const defaults = settings(config);
  const capacity = resource.capacity == null ? 1 : Number(resource.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new ScheduleError(`reservation resource ${id}: capacity must be a positive integer`, {
      code: 'schedule_config'
    });
  }
  const suspend = (resource.suspend ?? []).map((entry) => {
    const value = typeof entry === 'string' ? { model: entry } : plainObject(entry);
    if (!value) throw new ScheduleError(`reservation resource ${id}: bad suspend entry`, { code: 'schedule_config' });
    return { model: name(value.model, 'suspend.model'), node: nodeOf(value) };
  });
  const routes = (resource.routes ?? []).map((entry) => {
    const value = plainObject(entry);
    if (!value) throw new ScheduleError(`reservation resource ${id}: bad route entry`, { code: 'schedule_config' });
    return {
      alias: name(value.alias, 'routes.alias'),
      profile: name(value.profile, 'routes.profile'),
      node: nodeOf(value)
    };
  });
  // Take actions change shared serving state, which only one holder can own.
  if (capacity > 1 && (suspend.length || routes.length)) {
    throw new ScheduleError(`reservation resource ${id}: suspend/routes require capacity 1`, {
      code: 'schedule_config'
    });
  }
  const onExpiry = resource.onExpiry ?? 'release';
  if (!['release', 'keep'].includes(onExpiry)) {
    throw new ScheduleError(`reservation resource ${id}: onExpiry must be release or keep`, {
      code: 'schedule_config'
    });
  }
  return {
    id,
    description: text(resource.description, 'description', 500),
    hosts: Array.isArray(resource.hosts) ? resource.hosts.map((host) => name(host, 'hosts')) : [],
    capacity,
    ttlMs: resource.ttlMs == null ? defaults.ttlMs : duration(resource.ttlMs, 'ttlMs'),
    maxTtlMs: resource.maxTtlMs == null ? defaults.maxTtlMs : duration(resource.maxTtlMs, 'maxTtlMs'),
    allowIndefinite: resource.allowIndefinite === true,
    onExpiry,
    // Routes move traffic before suspend drains the model; release reverses both.
    actions: [
      ...routes.map((route) => ({ kind: 'route', ...route })),
      ...suspend.map((entry) => ({ kind: 'suspend', ...entry }))
    ]
  };
}

function emptyState() {
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    seq: 0,
    reservations: Object.create(null),
    jobs: Object.create(null),
    events: []
  };
}

function readState(statePath, now) {
  let raw;
  try {
    raw = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
  if (raw?.schemaVersion !== SCHEDULE_SCHEMA_VERSION) {
    throw new Error(`unsupported schedule state schema ${raw?.schemaVersion} in ${statePath}`);
  }
  const state = { ...emptyState(), ...raw };
  state.reservations = Object.assign(Object.create(null), raw.reservations);
  state.jobs = Object.assign(Object.create(null), raw.jobs);
  // An action cannot survive a restart. Its outcome is unknown, so hold the
  // resource until someone releases it (release re-runs the idempotent undo).
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.state === 'acquiring' || reservation.state === 'releasing') {
      reservation.error = `gateway restarted while ${reservation.state}; release to restore`;
      reservation.state = 'stuck';
      reservation.updatedAt = now;
    }
  }
  return state;
}

/**
 * Create the schedule. `actions` performs take/undo steps:
 * `activeRoute({alias,node})`, `setRoute({alias,profile,node})`,
 * `suspend({model,node,drainTimeoutMs})`, `resume({model,node})`.
 */
export function createSchedule({
  getConfig,
  statePath,
  eventsPath = null,
  actions,
  now = Date.now,
  logger = console,
  isPaused = () => false
}) {
  if (!statePath) throw new Error('schedule requires a state path');
  const state = readState(statePath, now());
  let queue = Promise.resolve();
  let timer = null;
  let closed = false;
  let pausedSince = null;
  let logWrites = Promise.resolve();
  let logBytes = null;
  const running = new Set();

  function open() {
    if (closed) throw new ScheduleError('the gateway is closing', { code: 'schedule_closed', statusCode: 503 });
  }

  function serialize(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  async function persist() {
    await writeAtomicJson(statePath, state);
  }

  function emit(kind, { severity = 'info', message, reservation, job, ring = true } = {}) {
    const event = {
      seq: ++state.seq,
      at: now(),
      kind,
      severity,
      message,
      ...(reservation
        ? { reservationId: reservation.id, resource: reservation.resource, owner: reservation.owner }
        : {}),
      ...(job ? { jobId: job.id, owner: job.owner, ...(job.resource ? { resource: job.resource } : {}) } : {})
    };
    if (ring) {
      state.events.push(event);
      const limit = settings(getConfig()).eventLimit;
      if (state.events.length > limit) state.events.splice(0, state.events.length - limit);
    }
    if (eventsPath) {
      const line = `${JSON.stringify(event)}\n`;
      logWrites = logWrites
        .then(async () => {
          if (logBytes == null) {
            await fs.mkdir(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
            logBytes = (await fs.stat(eventsPath).catch(() => null))?.size ?? 0;
          }
          if (logBytes > EVENT_LOG_ROTATE_BYTES) {
            await fs.rename(eventsPath, `${eventsPath}.1`);
            logBytes = 0;
          }
          await fs.appendFile(eventsPath, line, { mode: 0o600 });
          logBytes += Buffer.byteLength(line);
        })
        .catch((error) => logger.warn?.(`schedule event log write failed: ${error?.message ?? error}`));
    }
    return event;
  }

  function resources() {
    const config = getConfig();
    const specs = Object.entries(plainObject(config?.reservations?.resources) ?? {}).map(([id, raw]) => {
      try {
        return normalizeResource(id, raw, config);
      } catch (error) {
        return { id, error: error.message };
      }
    });
    // Two resources that suspend the same model or move the same route would
    // undo each other's leases, so neither is usable until one is changed.
    const claims = new Map();
    for (const spec of specs) {
      for (const action of spec.actions ?? []) {
        const key = `${action.kind}:${action.node ?? ''}:${action.model ?? action.alias}`;
        claims.set(key, [...(claims.get(key) ?? []), spec]);
      }
    }
    for (const [key, owners] of claims) {
      if (owners.length < 2) continue;
      for (const spec of owners) {
        spec.error ??= `reservation resources ${owners.map((owner) => owner.id).join(', ')} both control ${key.split(':').slice(2).join(':')}`;
      }
    }
    return specs;
  }

  function resource(id) {
    const found = resources().find((entry) => entry.id === id);
    if (!found) {
      throw new ScheduleError(`unknown reservation resource ${id}`, {
        code: 'schedule_unknown_resource',
        statusCode: 404
      });
    }
    if (found.error) throw new ScheduleError(found.error, { code: 'schedule_config', statusCode: 500 });
    return found;
  }

  function reservationsFor(resourceId, states) {
    return Object.values(state.reservations)
      .filter((entry) => entry.resource === resourceId && states.has(entry.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function reservation(id) {
    const found = Object.hasOwn(state.reservations, id) ? state.reservations[id] : null;
    if (!found)
      throw new ScheduleError(`unknown reservation ${id}`, { code: 'schedule_unknown_reservation', statusCode: 404 });
    return found;
  }

  function job(id) {
    const found = Object.hasOwn(state.jobs, id) ? state.jobs[id] : null;
    if (!found) throw new ScheduleError(`unknown job ${id}`, { code: 'schedule_unknown_job', statusCode: 404 });
    return found;
  }

  function assertOwner(entry, owner, force) {
    if (force === true || entry.owner === owner) return;
    throw new ScheduleError(`reservation ${entry.id} is held by ${entry.owner}`, {
      code: 'schedule_not_owner',
      statusCode: 409,
      details: { owner: entry.owner }
    });
  }

  function ttlFor(spec, requested) {
    if (requested === undefined) return spec.ttlMs;
    if (requested === null) {
      if (!spec.allowIndefinite) {
        throw new ScheduleError(`resource ${spec.id} does not allow indefinite reservations`, {
          code: 'schedule_invalid_request'
        });
      }
      return null;
    }
    return duration(requested, 'ttlMs', { min: 60_000, max: spec.maxTtlMs });
  }

  function view(entry) {
    if (!entry) return null;
    const time = now();
    const out = { ...entry, steps: entry.steps.map((step) => ({ ...step })) };
    if (entry.state === 'active' && entry.expiresAt != null) out.remainingMs = Math.max(0, entry.expiresAt - time);
    if (entry.state === 'queued') {
      out.position = reservationsFor(entry.resource, new Set(['queued'])).findIndex((item) => item.id === entry.id) + 1;
    }
    return out;
  }

  function jobView(entry) {
    const out = { ...entry, notes: [...entry.notes] };
    out.heartbeatAgeMs = Math.max(0, now() - entry.heartbeatAt);
    out.health = entry.state !== 'running' ? entry.state : entry.stalledAt != null ? 'stalled' : 'ok';
    return out;
  }

  // ---- take / undo -------------------------------------------------------

  async function runTake(entry, spec) {
    const { drainTimeoutMs } = settings(getConfig());
    try {
      for (const action of spec.actions) {
        if (action.kind === 'route') {
          const previous = (await actions.activeRoute(action)) ?? null;
          // Without an active profile there is nothing exact to restore.
          if (previous == null) {
            throw new Error(`route ${action.alias} has no active profile to restore; select one first`);
          }
          entry.steps.push({ ...action, previous, status: 'pending' });
          await serialize(persist);
          if (previous !== action.profile) await actions.setRoute(action);
        } else {
          // A model someone already suspended stays suspended after release.
          const wasSuspended = (await actions.isSuspended?.(action)) === true;
          entry.steps.push({ ...action, wasSuspended, status: 'pending' });
          await serialize(persist);
          if (!wasSuspended) await actions.suspend({ ...action, drainTimeoutMs });
        }
        entry.steps.at(-1).status = 'done';
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      const undoError = await runUndo(entry);
      return serialize(async () => {
        entry.updatedAt = now();
        if (!undoError) entry.endedAt = entry.updatedAt;
        entry.error = undoError ? `${message}; restore failed: ${undoError}` : message;
        entry.state = undoError ? 'stuck' : 'failed';
        emit(undoError ? 'reservation.stuck' : 'reservation.failed', {
          severity: 'error',
          message: `${spec.id} take failed: ${entry.error}`,
          reservation: entry
        });
        await persist();
        if (!undoError) promote(spec.id);
        return view(entry);
      });
    }
    return serialize(async () => {
      const time = now();
      entry.state = 'active';
      entry.startedAt = entry.updatedAt = time;
      entry.expiresAt = entry.ttlMs == null ? null : time + entry.ttlMs;
      emit('reservation.active', {
        message: `${entry.owner} holds ${spec.id}${entry.purpose ? `: ${entry.purpose}` : ''}`,
        reservation: entry
      });
      await persist();
      return view(entry);
    });
  }

  /** Undo every recorded step in reverse. Returns an error message, or null. */
  async function runUndo(entry) {
    for (const step of [...entry.steps].reverse()) {
      if (step.status === 'undone') continue;
      try {
        if (step.kind === 'suspend') {
          if (!step.wasSuspended) await actions.resume(step);
        } else if (step.previous && step.previous !== step.profile) {
          await actions.setRoute({ alias: step.alias, profile: step.previous, node: step.node });
        }
        step.status = 'undone';
      } catch (error) {
        step.error = error?.message ?? String(error);
        await serialize(persist).catch(() => {});
        return `${step.kind} ${step.model ?? step.alias}: ${step.error}`;
      }
    }
    return null;
  }

  function track(promise) {
    running.add(promise);
    promise.finally(() => running.delete(promise)).catch(() => {});
    return promise;
  }

  // Start queued reservations while capacity allows. Called inside serialize.
  function promote(resourceId) {
    let spec;
    try {
      spec = resource(resourceId);
    } catch {
      return;
    }
    if (isPaused()) return;
    const free = spec.capacity - reservationsFor(resourceId, HELD).length;
    for (const next of reservationsFor(resourceId, new Set(['queued'])).slice(0, Math.max(0, free))) {
      next.state = 'acquiring';
      next.updatedAt = now();
      delete next.queuedUntil;
      emit('reservation.acquiring', { message: `${next.owner} is next on ${resourceId}`, reservation: next });
      track(runTake(next, spec));
    }
  }

  // ---- public operations -------------------------------------------------

  function preview(body) {
    const spec = resource(name(body.resource, 'resource'));
    return {
      applied: false,
      resource: spec.id,
      description: spec.description,
      hosts: spec.hosts,
      ttlMs: ttlFor(spec, body.ttlMs),
      actions: spec.actions,
      holders: reservationsFor(spec.id, HELD).map(view),
      queue: reservationsFor(spec.id, new Set(['queued'])).map(view)
    };
  }

  async function take(body = {}) {
    open();
    if (body.apply !== true) return preview(body);
    if (body.yes !== true) throw new ScheduleError('take requires apply and yes', { code: 'schedule_confirm' });
    const spec = resource(name(body.resource, 'resource'));
    const owner = name(body.owner, 'owner');
    const purpose = text(body.purpose, 'purpose', 500);
    const session = text(body.session, 'session', 200);
    const ttlMs = ttlFor(spec, body.ttlMs);
    const started = await serialize(async () => {
      // Taking again is idempotent for the same holder (owner, and session when
      // both name one): renew instead of queueing twice.
      const mine = reservationsFor(spec.id, OPEN).find(
        (entry) => entry.owner === owner && (!session || !entry.session || entry.session === session)
      );
      if (mine) return { existing: mine };
      const held = reservationsFor(spec.id, HELD);
      const queued = reservationsFor(spec.id, new Set(['queued']));
      if (queued.length >= QUEUE_LIMIT) {
        throw new ScheduleError(`${spec.id} already has ${QUEUE_LIMIT} waiting`, {
          code: 'schedule_queue_full',
          statusCode: 429
        });
      }
      const free = held.length < spec.capacity && queued.length === 0;
      if (!free && body.wait !== true) {
        throw new ScheduleError(`${spec.id} is held by ${held.map((entry) => entry.owner).join(', ') || 'the queue'}`, {
          code: 'schedule_busy',
          statusCode: 409,
          details: { holders: held.map(view), queue: queued.map(view) }
        });
      }
      const time = now();
      const entry = {
        id: newId('r', state.reservations),
        resource: spec.id,
        owner,
        purpose,
        session,
        state: free ? 'acquiring' : 'queued',
        ttlMs,
        createdAt: time,
        updatedAt: time,
        startedAt: null,
        expiresAt: null,
        endedAt: null,
        endReason: null,
        warnedAt: null,
        error: null,
        steps: []
      };
      if (!free) entry.queuedUntil = time + settings(getConfig()).queueTtlMs;
      state.reservations[entry.id] = entry;
      emit(free ? 'reservation.acquiring' : 'reservation.queued', {
        message: free ? `${owner} is taking ${spec.id}` : `${owner} queued for ${spec.id}`,
        reservation: entry
      });
      await persist();
      return { entry, free };
    });
    if (started.existing) {
      // Mid-take, mid-release or stuck: report it as it is rather than renew.
      if (!['active', 'queued'].includes(started.existing.state)) return view(started.existing);
      return renew(started.existing.id, { owner, ttlMs: body.ttlMs });
    }
    if (!started.free) return view(started.entry);
    return track(runTake(started.entry, spec));
  }

  function renew(id, body = {}) {
    open();
    return serialize(async () => {
      const entry = reservation(id);
      assertOwner(entry, body.owner, body.force);
      const time = now();
      if (entry.state === 'queued') {
        entry.queuedUntil = time + settings(getConfig()).queueTtlMs;
      } else if (entry.state === 'active') {
        if (body.ttlMs !== undefined) entry.ttlMs = ttlFor(resource(entry.resource), body.ttlMs);
        entry.expiresAt = entry.ttlMs == null ? null : time + entry.ttlMs;
        entry.warnedAt = null;
      } else {
        throw new ScheduleError(`reservation ${id} is ${entry.state}`, { code: 'schedule_not_open', statusCode: 409 });
      }
      entry.updatedAt = time;
      await persist();
      return view(entry);
    });
  }

  async function release(id, body = {}, { reason = 'released', system = false } = {}) {
    const entry = reservation(id);
    if (!system) {
      open();
      if (body.apply !== true) return { applied: false, reservation: view(entry), undo: [...entry.steps].reverse() };
      if (body.yes !== true) throw new ScheduleError('release requires apply and yes', { code: 'schedule_confirm' });
    }
    const begin = await serialize(async () => {
      if (!system) assertOwner(entry, body.owner, body.force);
      if (entry.state === 'queued') {
        entry.state = 'released';
        entry.endedAt = entry.updatedAt = now();
        entry.endReason = reason;
        emit('reservation.withdrawn', {
          message: `${entry.owner} left the ${entry.resource} queue`,
          reservation: entry
        });
        await persist();
        return { done: view(entry) };
      }
      if (entry.state === 'acquiring' || entry.state === 'releasing') {
        throw new ScheduleError(`reservation ${id} is ${entry.state}; wait for it to settle`, {
          code: 'schedule_busy',
          statusCode: 409
        });
      }
      if (!HELD.has(entry.state)) return { done: view(entry) };
      // A renewal may land between the sweep and this release.
      if (reason === 'expired' && (entry.state !== 'active' || entry.expiresAt == null || entry.expiresAt > now())) {
        return { done: view(entry) };
      }
      entry.state = 'releasing';
      entry.updatedAt = now();
      entry.endReason = reason;
      await persist();
      return { run: true };
    });
    if (begin.done) return begin.done;
    const undoError = await runUndo(entry);
    return serialize(async () => {
      entry.updatedAt = now();
      if (undoError) {
        entry.state = 'stuck';
        entry.error = `restore failed: ${undoError}`;
        emit('reservation.stuck', {
          severity: 'error',
          message: `${entry.resource} restore failed (${entry.owner}): ${undoError}`,
          reservation: entry
        });
      } else {
        entry.state = 'released';
        entry.endedAt = entry.updatedAt;
        entry.error = null;
        emit(reason === 'expired' ? 'reservation.expired' : 'reservation.released', {
          severity: reason === 'expired' ? 'attention' : 'info',
          message:
            reason === 'expired'
              ? `${entry.owner}'s ${entry.resource} lease expired; restored`
              : `${entry.owner} released ${entry.resource}`,
          reservation: entry
        });
        promote(entry.resource);
      }
      await persist();
      return view(entry);
    });
  }

  function startJob(body = {}) {
    open();
    return serialize(async () => {
      const owner = name(body.owner, 'owner');
      if (Object.values(state.jobs).filter((entry) => entry.state === 'running').length >= RUNNING_JOB_LIMIT) {
        throw new ScheduleError(`at most ${RUNNING_JOB_LIMIT} jobs run at once; end some first`, {
          code: 'schedule_too_many_jobs',
          statusCode: 429
        });
      }
      let reservationId = body.reservationId == null ? null : name(body.reservationId, 'reservationId');
      let resourceId = body.resource == null ? null : name(body.resource, 'resource');
      if (reservationId) {
        const lease = reservation(reservationId);
        // Its reports keep the lease alive, so only the holder's jobs attach.
        assertOwner(lease, owner, body.force);
        resourceId = lease.resource;
      } else if (resourceId) {
        // Attach to the owner's open lease on that resource when there is one.
        reservationId = reservationsFor(resourceId, OPEN).find((entry) => entry.owner === owner)?.id ?? null;
      }
      const time = now();
      const entry = {
        id: newId('j', state.jobs),
        title: text(body.title, 'title', 200, { required: true }),
        owner,
        session: text(body.session, 'session', 200),
        reservationId,
        resource: resourceId,
        state: 'running',
        startedAt: time,
        heartbeatAt: time,
        endedAt: null,
        staleAfterMs:
          body.staleAfterMs == null
            ? settings(getConfig()).staleAfterMs
            : duration(body.staleAfterMs, 'staleAfterMs', { min: 60_000, max: 24 * 60 * MINUTE }),
        stalledAt: null,
        note: null,
        notes: [],
        progress: null,
        metrics: {},
        receipt: null
      };
      applyJobUpdate(entry, body, time);
      state.jobs[entry.id] = entry;
      emit('job.started', { message: `${owner} started: ${entry.title}`, job: entry });
      await persist();
      return jobView(entry);
    });
  }

  /** Validates the whole update before changing anything, so a refused update leaves no trace. */
  function applyJobUpdate(entry, body, time) {
    const note = text(body.note, 'note', 2000);
    let progress;
    if (body.progress !== undefined) {
      const raw = plainObject(body.progress);
      const done = Number(raw?.done);
      const total = raw?.total == null ? null : Number(raw.total);
      if (!raw || !Number.isFinite(done) || done < 0 || (total != null && (!Number.isFinite(total) || total <= 0))) {
        throw new ScheduleError('progress needs a non-negative done and an optional positive total', {
          code: 'schedule_invalid_request'
        });
      }
      progress = { done, total, unit: text(raw.unit, 'progress.unit', 40) };
    }
    let metrics;
    if (body.metrics !== undefined) {
      const raw = plainObject(body.metrics);
      if (!raw) throw new ScheduleError('metrics must be an object', { code: 'schedule_invalid_request' });
      metrics = { ...entry.metrics };
      for (const [key, value] of Object.entries(raw)) {
        name(key, 'metric name');
        if (
          !(typeof value === 'number' && Number.isFinite(value)) &&
          !(typeof value === 'string' && value.length <= 200)
        ) {
          throw new ScheduleError(`metric ${key} must be a finite number or a short string`, {
            code: 'schedule_invalid_request'
          });
        }
        metrics[key] = value;
      }
      if (Object.keys(metrics).length > METRIC_LIMIT) {
        throw new ScheduleError(`a job keeps at most ${METRIC_LIMIT} metrics`, { code: 'schedule_invalid_request' });
      }
    }
    const receipt = text(body.receipt, 'receipt', 500);
    if (note) {
      entry.note = note;
      entry.notes.push({ at: time, text: note });
      if (entry.notes.length > NOTE_HISTORY) entry.notes.splice(0, entry.notes.length - NOTE_HISTORY);
      emit('job.note', { message: note, job: entry, ring: false });
    }
    if (progress) entry.progress = progress;
    if (metrics) entry.metrics = metrics;
    if (receipt) entry.receipt = receipt;
  }

  function updateJob(id, body = {}) {
    open();
    return serialize(async () => {
      const entry = job(id);
      if (body.owner != null && body.owner !== entry.owner && body.force !== true) {
        throw new ScheduleError(`job ${id} belongs to ${entry.owner}`, { code: 'schedule_not_owner', statusCode: 409 });
      }
      if (entry.state !== 'running') {
        throw new ScheduleError(`job ${id} already ended (${entry.state})`, {
          code: 'schedule_not_open',
          statusCode: 409
        });
      }
      const nextState = body.state ?? 'running';
      if (typeof nextState !== 'string' || !JOB_STATES.has(nextState)) {
        throw new ScheduleError('state must be running, done, failed or cancelled', {
          code: 'schedule_invalid_request'
        });
      }
      const time = now();
      applyJobUpdate(entry, body, time);
      entry.heartbeatAt = time;
      if (entry.stalledAt != null) {
        entry.stalledAt = null;
        emit('job.recovered', { message: `${entry.title} is reporting again`, job: entry });
      }
      if (nextState !== 'running') {
        entry.state = nextState;
        entry.endedAt = time;
        emit(`job.${nextState}`, {
          severity: nextState === 'failed' ? 'error' : nextState === 'done' ? 'attention' : 'info',
          message: `${entry.title}${entry.note ? `: ${entry.note}` : ''}`,
          job: entry
        });
      }
      // A heartbeating job proves its holder is alive, so it keeps its lease.
      const lease =
        entry.reservationId && Object.hasOwn(state.reservations, entry.reservationId)
          ? state.reservations[entry.reservationId]
          : null;
      if (nextState === 'running' && lease?.state === 'active' && lease.ttlMs != null) {
        const until = time + lease.ttlMs;
        if (until > lease.expiresAt) {
          lease.expiresAt = until;
          lease.warnedAt = null;
          lease.updatedAt = time;
        }
      }
      await persist();
      return jobView(entry);
    });
  }

  function board({ since = 0 } = {}) {
    const after = Number(since) || 0;
    const reservations = Object.values(state.reservations).sort((a, b) => b.createdAt - a.createdAt);
    return {
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      now: now(),
      seq: state.seq,
      resources: resources().map((spec) => ({
        ...spec,
        holders: spec.error ? [] : reservationsFor(spec.id, HELD).map((entry) => entry.id),
        queue: spec.error ? [] : reservationsFor(spec.id, new Set(['queued'])).map((entry) => entry.id)
      })),
      reservations: reservations.map(view),
      jobs: Object.values(state.jobs)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(jobView),
      events: state.events.filter((event) => event.seq > after)
    };
  }

  // ---- sweep -------------------------------------------------------------

  async function sweep() {
    const expired = await serialize(async () => {
      const time = now();
      const config = settings(getConfig());
      const due = [];
      let changed = false;
      // A deployment fence blocks renewals and actions, so leases neither
      // expire nor start while it holds; afterwards they get the time back.
      if (isPaused()) {
        pausedSince ??= time;
        return due;
      }
      if (pausedSince != null) {
        for (const entry of Object.values(state.reservations)) {
          if (entry.state === 'active' && entry.expiresAt != null) entry.expiresAt += time - pausedSince;
          if (entry.state === 'queued') entry.queuedUntil += time - pausedSince;
        }
        pausedSince = null;
        changed = true;
      }
      for (const entry of Object.values(state.reservations)) {
        if (entry.state === 'queued' && entry.queuedUntil <= time) {
          entry.state = 'released';
          entry.endedAt = entry.updatedAt = time;
          entry.endReason = 'queue-timeout';
          emit('reservation.withdrawn', {
            message: `${entry.owner} dropped from the ${entry.resource} queue (not renewed)`,
            reservation: entry
          });
          changed = true;
        } else if (entry.state === 'active' && entry.expiresAt != null) {
          let onExpiry = 'release';
          try {
            onExpiry = resource(entry.resource).onExpiry;
          } catch {
            // A resource removed from config still expires and restores.
          }
          if (entry.expiresAt <= time && onExpiry === 'release') due.push(entry.id);
          else if (entry.warnedAt == null && entry.expiresAt - time <= config.warnBeforeMs) {
            entry.warnedAt = time;
            emit(entry.expiresAt <= time ? 'reservation.overdue' : 'reservation.expiring', {
              severity: 'attention',
              message: `${entry.owner}'s ${entry.resource} lease ${entry.expiresAt <= time ? 'is overdue' : 'expires soon'}; renew to keep it`,
              reservation: entry
            });
            changed = true;
          }
        }
      }
      for (const entry of Object.values(state.jobs)) {
        if (entry.state === 'running' && time - entry.heartbeatAt > ABANDON_AFTER_MS) {
          entry.state = 'failed';
          entry.endedAt = time;
          entry.note = `abandoned: no report for ${Math.round((time - entry.heartbeatAt) / (60 * MINUTE))} h`;
          emit('job.failed', { severity: 'error', message: `${entry.title}: ${entry.note}`, job: entry });
          changed = true;
          continue;
        }
        if (entry.state === 'running' && entry.stalledAt == null && time - entry.heartbeatAt > entry.staleAfterMs) {
          entry.stalledAt = time;
          emit('job.stalled', {
            severity: 'attention',
            message: `${entry.title}: no report for ${Math.round((time - entry.heartbeatAt) / MINUTE)} min`,
            job: entry
          });
          changed = true;
        }
      }
      for (const [id, entry] of Object.entries(state.reservations)) {
        if (!OPEN.has(entry.state) && entry.endedAt != null && time - entry.endedAt > config.retentionMs) {
          delete state.reservations[id];
          changed = true;
        }
      }
      for (const [id, entry] of Object.entries(state.jobs)) {
        if (entry.state !== 'running' && time - entry.endedAt > config.retentionMs) {
          delete state.jobs[id];
          changed = true;
        }
      }
      for (const spec of resources()) if (!spec.error) promote(spec.id);
      if (changed) await persist();
      return due;
    });
    for (const id of expired) {
      await release(id, {}, { reason: 'expired', system: true }).catch((error) => {
        // Someone else's release got there first.
        if (error?.code !== 'schedule_busy')
          logger.error?.(`schedule expiry release ${id} failed: ${error?.message ?? error}`);
      });
    }
  }

  return {
    board,
    take,
    renew,
    release: (id, body) => release(id, body),
    reservation: (id) => view(reservation(id)),
    startJob,
    updateJob,
    job: (id) => jobView(job(id)),
    sweep: () => (closed ? Promise.resolve() : track(sweep())),
    start() {
      if (timer) return;
      timer = setInterval(() => {
        track(sweep()).catch((error) => logger.error?.(`schedule sweep failed: ${error?.message ?? error}`));
      }, settings(getConfig()).sweepMs);
      timer.unref?.();
    },
    /** Refuses new work and waits a little for actions in flight; any still running are
     * recovered as `stuck` on the next start, since every step is recorded before it runs. */
    async stop({ waitMs = 5000 } = {}) {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      let timeout;
      await Promise.race([
        Promise.allSettled([...running]).then(() => queue),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, waitMs);
          timeout.unref?.();
        })
      ]);
      clearTimeout(timeout);
      await logWrites;
    }
  };
}

/** Default state and event log locations beside a file-backed config. */
export function schedulePaths(config) {
  const configured = plainObject(config?.reservations) ?? {};
  const root = config?.sourcePath ? path.dirname(config.sourcePath) : null;
  const resolve = (value) => (root && !path.isAbsolute(value) ? path.join(root, value) : value);
  const statePath = configured.statePath
    ? resolve(configured.statePath)
    : root
      ? path.join(root, 'schedule.json')
      : null;
  const eventsPath = configured.eventsPath
    ? resolve(configured.eventsPath)
    : statePath
      ? statePath.replace(/\.json$/, '') + '-events.ndjson'
      : null;
  return { statePath, eventsPath };
}
