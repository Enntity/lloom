import path from 'node:path';
export const SCHEDULE_DEFAULTS = {
  ttlMs: 300000,
  maxTtlMs: 28800000,
  queueTtlMs: 1800000,
  warnBeforeMs: 300000,
  staleAfterMs: 900000,
  retentionMs: 604800000,
  drainTimeoutMs: 300000,
  sweepMs: 15000,
  eventLimit: 500
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
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
  const workloads = (resource.workloads ?? []).map((entry) => {
    const value = typeof entry === 'string' ? { model: entry } : plainObject(entry);
    if (!value) throw new ScheduleError(`reservation resource ${id}: bad workload entry`, { code: 'schedule_config' });
    return { model: name(value.model, 'workloads.model'), node: nodeOf(value) };
  });
  // Take actions change shared serving state, which only one holder can own.
  if (capacity > 1 && (suspend.length || routes.length || workloads.length)) {
    throw new ScheduleError(`reservation resource ${id}: suspend/routes/workloads require capacity 1`, {
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
    workloads,
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
