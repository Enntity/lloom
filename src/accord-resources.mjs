import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { accordAdmin } from './accord-client.mjs';
import { normalizeResource, schedulePaths } from './resource-spec.mjs';
const hash = (s) => createHash('sha256').update(s).digest('hex');
function assetFor(config, id) {
  return config.reservations?.resources?.[id]?.asset ?? `lloom:${os.hostname()}:${id}`;
}
export function resourceID(config, id, slot = 0) {
  return `lloom-${id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 24)}-${hash(assetFor(config, id)).slice(0, 10)}-${slot}`;
}
export function effectCredential(config) {
  const file = path.join(path.dirname(schedulePaths(config).statePath), 'accord-provider.token');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file))
    try {
      fs.writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  return file;
}
export function effectAuthorized(req, file) {
  const a = Buffer.from(req.headers.authorization ?? ''),
    b = Buffer.from('Bearer ' + fs.readFileSync(file, 'utf8').trim());
  return (
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    !req.headers.origin &&
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}
export function accordManifests(config, port, tokenFile) {
  const manifests = [];
  for (const [id, raw] of Object.entries(config.reservations?.resources ?? {})) {
    const spec = normalizeResource(id, raw, config);
    for (let slot = 0; slot < spec.capacity; slot++)
      manifests.push({
        schema: 1,
        id: resourceID(config, id, slot),
        asset: `${assetFor(config, id)}:slot:${slot}`,
        plugin: 'managed-http',
        label: spec.capacity > 1 ? `LLooM ${id} #${slot + 1}` : `LLooM ${id}`,
        hosts: spec.hosts,
        endpoint: `http://127.0.0.1:${port}/gateway/accord/resources/${encodeURIComponent(id + '#' + slot)}`,
        tokenFile,
        // Accord ends a reservation's ownership here; it accepts one minute to 30 days.
        maxOwnershipMs: Math.min(Math.max(spec.maxTtlMs, 60000), 2592000000),
        allowIndefinite: spec.allowIndefinite
      });
  }
  return manifests;
}
export async function registerResources(config, port, tokenFile) {
  const client = accordAdmin();
  const registered = [];
  for (const manifest of accordManifests(config, port, tokenFile)) {
    await client.registerResource(manifest, `lloom-register:${hash(JSON.stringify(manifest))}`);
    registered.push(manifest.id);
  }
  return registered;
}
export async function scheduleView(config, effects) {
  const client = accordAdmin();
  const [catalog, jobs] = await Promise.all([client.host(), client.collaborate('jobs')]);
  const resources = [],
    reservations = [];
  for (const [id, raw] of Object.entries(config.reservations?.resources ?? {})) {
    const spec = normalizeResource(id, raw, config);
    for (let slot = 0; slot < spec.capacity; slot++) {
      const r = catalog.resources.find((r) => r.localId === resourceID(config, id, slot));
      const displayId = spec.capacity > 1 ? `${id}#${slot}` : id;
      const legacy = effects?.legacy(id) ?? [];
      const held = [];
      const queue = [];
      for (const old of legacy) {
        reservations.push({ ...old, migration: 'held pending verified recovery', state: 'stuck' });
        held.push(old.id);
      }
      if (r?.holder) {
        const h = r.holder;
        held.push(h.claim);
        reservations.push({
          id: h.claim,
          resource: displayId,
          owner: h.label ?? h.actor,
          session: h.actor,
          state: h.state === 'running' ? 'active' : 'stuck',
          expiresAt: h.deadline,
          createdAt: null,
          purpose: 'Accord reservation',
          steps: []
        });
      }
      for (const q of r?.queue ?? []) {
        queue.push(q.id);
        reservations.push({
          id: q.id,
          resource: displayId,
          owner: q.actor,
          state: 'queued',
          purpose: q.purpose,
          queuedUntil: q.queuedUntil,
          steps: []
        });
      }
      resources.push({
        ...spec,
        id: displayId,
        capacity: 1,
        address: r?.id ?? null,
        holders: held,
        queue,
        ...(!r || r.state === 'unknown' ? { error: 'Accord ownership unknown' } : {})
      });
    }
  }
  return {
    schemaVersion: 1,
    authority: 'accord',
    capabilities: ['accord-owned-v1'],
    now: Date.now(),
    resources,
    reservations,
    jobs: jobs.jobs.map((j) => ({
      ...j,
      owner: j.actor,
      state: j.state === 'working' ? 'running' : j.state,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
      endedAt: ['done', 'failed', 'cancelled'].includes(j.state) ? j.updated_at : null,
      notes: [],
      health: j.state
    }))
  };
}

// Old records remain immutable evidence. Publish them as observations, never as
// authenticated new agents or new grants. Active legacy hardware stays blocked.
export async function importScheduleHistory(config) {
  const file = schedulePaths(config).statePath;
  if (!file || !fs.existsSync(file)) return { imported: 0 };
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (old.schemaVersion !== 1) throw Error('Unknown legacy schedule schema');
  const client = accordAdmin();
  let imported = 0;
  for (const j of Object.values(old.jobs ?? {})) {
    await client.collaborate('session-report', {
      source: 'lloom-history',
      externalId: hash(file) + ':' + j.id,
      title: String(j.title ?? j.id).slice(0, 200),
      sourceProgressAt: Math.max(0, Math.min(Date.now(), Number.isSafeInteger(j.updatedAt) ? j.updatedAt : 0)),
      state: ['done', 'failed', 'cancelled'].includes(j.state) ? j.state : 'unknown',
      detail: JSON.stringify({
        legacyId: j.id,
        owner: j.owner,
        note: j.note,
        progress: j.progress,
        metrics: j.metrics,
        updatedAt: j.updatedAt
      }).slice(0, 4000),
      events: (j.notes ?? [])
        .slice(-50)
        .map((n, i) => ({ key: `${j.id}:${n.at}:${i}`, kind: 'progress', text: String(n.text).slice(0, 16000) }))
    });
    imported++;
  }
  return { imported };
}
