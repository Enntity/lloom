import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSchedule, normalizeResource, ScheduleError } from '../src/schedule.mjs';

const MINUTE = 60_000;

function fakeActions({ failResume = 0, failSuspend = false } = {}) {
  const calls = [];
  const routes = { omp: 'local-atlas' };
  return {
    calls,
    routes,
    failResume,
    async activeRoute({ alias, node }) {
      calls.push(['activeRoute', alias, node]);
      return routes[alias] ?? null;
    },
    async setRoute({ alias, profile, node }) {
      calls.push(['setRoute', alias, profile, node]);
      routes[alias] = profile;
    },
    async suspend({ model, node }) {
      calls.push(['suspend', model, node]);
      if (failSuspend) throw new Error('drain timed out');
    },
    async resume({ model, node }) {
      calls.push(['resume', model, node]);
      if (this.failResume > 0) {
        this.failResume -= 1;
        throw new Error('runtime failed health check after resume');
      }
    }
  };
}

const RESOURCES = {
  pair: {
    description: 'two-node pair',
    hosts: ['node-a', 'node-b'],
    routes: [{ alias: 'omp', profile: 'cloud', node: 'node-a' }],
    suspend: [{ model: 'pair-model', node: 'node-a' }]
  },
  builds: { capacity: 2 },
  drafter: { allowIndefinite: true }
};

async function fixture(t, { actions = fakeActions(), resources = RESOURCES, statePath } = {}) {
  const dir = statePath ? path.dirname(statePath) : await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-schedule-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = { now: 1_800_000_000_000 };
  const config = { reservations: { resources } };
  const options = {
    getConfig: () => config,
    statePath: statePath ?? path.join(dir, 'schedule.json'),
    eventsPath: path.join(dir, 'schedule-events.ndjson'),
    actions,
    now: () => clock.now,
    logger: { warn() {}, error() {} }
  };
  const schedule = createSchedule(options);
  t.after(() => schedule.stop());
  return { schedule, actions, clock, config, options, dir };
}

const take = (schedule, body) => schedule.take({ apply: true, yes: true, ...body });
const release = (schedule, id, body) => schedule.release(id, { apply: true, yes: true, ...body });
const kinds = (schedule) => schedule.board().events.map((event) => event.kind);

test('take previews by default, then routes away before suspending', async (t) => {
  const { schedule, actions } = await fixture(t);
  const plan = await schedule.take({ resource: 'pair', owner: 'main' });
  assert.equal(plan.applied, false);
  assert.deepEqual(
    plan.actions.map((action) => action.kind),
    ['route', 'suspend']
  );
  assert.equal(actions.calls.length, 0);

  const held = await take(schedule, { resource: 'pair', owner: 'main', purpose: 'decode A/B' });
  assert.equal(held.state, 'active');
  assert.equal(held.expiresAt - held.startedAt, 30 * MINUTE);
  assert.deepEqual(actions.calls, [
    ['activeRoute', 'omp', 'node-a'],
    ['setRoute', 'omp', 'cloud', 'node-a'],
    ['suspend', 'pair-model', 'node-a']
  ]);
  assert.equal(held.steps[0].previous, 'local-atlas');
  assert.ok(kinds(schedule).includes('reservation.active'));
});

test('a busy resource refuses, or queues and promotes on release', async (t) => {
  const { schedule, actions } = await fixture(t);
  const first = await take(schedule, { resource: 'pair', owner: 'main' });
  await assert.rejects(take(schedule, { resource: 'pair', owner: 'buildopt' }), (error) => {
    assert.ok(error instanceof ScheduleError);
    assert.equal(error.code, 'schedule_busy');
    assert.equal(error.statusCode, 409);
    assert.equal(error.details.holders[0].owner, 'main');
    return true;
  });
  const waiting = await take(schedule, { resource: 'pair', owner: 'buildopt', wait: true });
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.position, 1);

  actions.calls.length = 0;
  const released = await release(schedule, first.id, { owner: 'main' });
  assert.equal(released.state, 'released');
  // Undo runs in reverse: resume (health-checked) before routing traffic back.
  assert.deepEqual(actions.calls.slice(0, 2), [
    ['resume', 'pair-model', 'node-a'],
    ['setRoute', 'omp', 'local-atlas', 'node-a']
  ]);
  await schedule.stop();
  const promoted = schedule.reservation(waiting.id);
  assert.equal(promoted.state, 'active');
  assert.equal(promoted.steps[0].previous, 'local-atlas');
});

test('only the owner releases unless forced; taking twice renews', async (t) => {
  const { schedule, clock } = await fixture(t);
  const held = await take(schedule, { resource: 'pair', owner: 'main' });
  clock.now += 10 * MINUTE;
  const again = await take(schedule, { resource: 'pair', owner: 'main' });
  assert.equal(again.id, held.id);
  assert.equal(again.expiresAt, clock.now + 30 * MINUTE);
  await assert.rejects(release(schedule, held.id, { owner: 'other' }), { code: 'schedule_not_owner' });
  const preview = await schedule.release(held.id, { owner: 'other' });
  assert.equal(preview.applied, false);
  assert.equal((await release(schedule, held.id, { owner: 'other', force: true })).state, 'released');
});

test('a failed restore keeps the resource held until a release succeeds', async (t) => {
  const actions = fakeActions({ failResume: 1 });
  const { schedule } = await fixture(t, { actions });
  const held = await take(schedule, { resource: 'pair', owner: 'main' });
  const stuck = await release(schedule, held.id, { owner: 'main' });
  assert.equal(stuck.state, 'stuck');
  assert.match(stuck.error, /health check/);
  // Traffic was not routed back to the unhealthy model.
  assert.equal(actions.routes.omp, 'cloud');
  await assert.rejects(take(schedule, { resource: 'pair', owner: 'buildopt' }), { code: 'schedule_busy' });
  assert.ok(kinds(schedule).includes('reservation.stuck'));
  const retried = await release(schedule, held.id, { owner: 'main' });
  assert.equal(retried.state, 'released');
  assert.equal(actions.routes.omp, 'local-atlas');
});

test('a failed take rolls back what it did and frees the resource', async (t) => {
  const actions = fakeActions({ failSuspend: true });
  const { schedule } = await fixture(t, { actions });
  const failed = await take(schedule, { resource: 'pair', owner: 'main' });
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /drain timed out/);
  assert.equal(actions.routes.omp, 'local-atlas');
  actions.calls.length = 0;
  actions.failResume = 0;
  const failSuspend = actions.suspend;
  actions.suspend = async (args) => actions.calls.push(['suspend', args.model, args.node]);
  assert.equal((await take(schedule, { resource: 'pair', owner: 'buildopt' })).state, 'active');
  actions.suspend = failSuspend;
});

test('leases warn, then expire and restore; renewals and job heartbeats extend them', async (t) => {
  const { schedule, clock, actions } = await fixture(t);
  const held = await take(schedule, { resource: 'pair', owner: 'main', ttlMs: 20 * MINUTE });
  clock.now += 10 * MINUTE;
  const job = await schedule.startJob({ title: 'decode sweep', owner: 'main', resource: 'pair' });
  assert.equal(job.reservationId, held.id);
  await schedule.updateJob(job.id, { progress: { done: 1, total: 4, unit: 'arms' } });
  assert.equal(schedule.reservation(held.id).expiresAt, clock.now + 20 * MINUTE);

  clock.now += 16 * MINUTE;
  await schedule.sweep();
  assert.ok(kinds(schedule).includes('reservation.expiring'));
  await schedule.renew(held.id, { owner: 'main' });
  assert.equal(schedule.reservation(held.id).expiresAt, clock.now + 20 * MINUTE);

  clock.now += 21 * MINUTE;
  actions.calls.length = 0;
  await schedule.sweep();
  assert.equal(schedule.reservation(held.id).state, 'released');
  assert.equal(schedule.reservation(held.id).endReason, 'expired');
  assert.deepEqual(actions.calls[0], ['resume', 'pair-model', 'node-a']);
  assert.ok(kinds(schedule).includes('reservation.expired'));
});

test('jobs carry notes, progress and metrics; silence marks them stalled', async (t) => {
  const { schedule, clock, dir } = await fixture(t);
  const job = await schedule.startJob({
    title: 'FP4 NLL receipts',
    owner: 'glm-fp4l',
    session: 'claude:abc123',
    note: 'building',
    staleAfterMs: 10 * MINUTE
  });
  assert.equal(job.health, 'ok');
  await schedule.updateJob(job.id, { note: 'arm 2 of 5', metrics: { tok_s: 58.2, image: 'f399caa' } });
  clock.now += 11 * MINUTE;
  await schedule.sweep();
  assert.equal(schedule.job(job.id).health, 'stalled');
  await schedule.updateJob(job.id, { note: 'back' });
  assert.equal(schedule.job(job.id).health, 'ok');
  const done = await schedule.updateJob(job.id, { state: 'done', receipt: 'receipts/fp4l.json', note: 'NLL +0.002' });
  assert.equal(done.state, 'done');
  assert.deepEqual(
    done.notes.map((note) => note.text),
    ['building', 'arm 2 of 5', 'back', 'NLL +0.002']
  );
  assert.equal(done.metrics.tok_s, 58.2);
  await assert.rejects(schedule.updateJob(job.id, { note: 'late' }), { code: 'schedule_not_open' });
  const events = schedule.board().events.map((event) => event.kind);
  assert.deepEqual(events, ['job.started', 'job.stalled', 'job.recovered', 'job.done']);
  // Notes reach the durable log but not the board's event ring.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const log = await fs.readFile(path.join(dir, 'schedule-events.ndjson'), 'utf8');
  assert.equal(
    log
      .trim()
      .split('\n')
      .filter((line) => JSON.parse(line).kind === 'job.note').length,
    4
  );
});

test('state survives restart and an interrupted action stays held', async (t) => {
  const first = await fixture(t);
  const held = await take(first.schedule, { resource: 'pair', owner: 'main' });
  await first.schedule.stop();
  const raw = JSON.parse(await fs.readFile(first.options.statePath, 'utf8'));
  raw.reservations[held.id].state = 'releasing';
  await fs.writeFile(first.options.statePath, JSON.stringify(raw));

  const second = createSchedule(first.options);
  t.after(() => second.stop());
  const recovered = second.reservation(held.id);
  assert.equal(recovered.state, 'stuck');
  assert.match(recovered.error, /restarted/);
  assert.equal((await release(second, held.id, { owner: 'main' })).state, 'released');
});

test('queue entries expire unless renewed; board lists events after a cursor', async (t) => {
  const { schedule, clock } = await fixture(t);
  await take(schedule, { resource: 'pair', owner: 'main', ttlMs: 2 * 60 * MINUTE });
  const waiting = await take(schedule, { resource: 'pair', owner: 'buildopt', wait: true });
  const cursor = schedule.board().seq;
  clock.now += 20 * MINUTE;
  await schedule.renew(waiting.id, { owner: 'buildopt' });
  clock.now += 20 * MINUTE;
  await schedule.sweep();
  assert.equal(schedule.reservation(waiting.id).state, 'queued');
  clock.now += 31 * MINUTE;
  await schedule.sweep();
  assert.equal(schedule.reservation(waiting.id).endReason, 'queue-timeout');
  const board = schedule.board({ since: cursor });
  assert.ok(board.events.every((event) => event.seq > cursor));
  assert.deepEqual(
    board.events.map((event) => event.kind),
    ['reservation.withdrawn']
  );
  const pair = board.resources.find((entry) => entry.id === 'pair');
  assert.equal(pair.holders.length, 1);
  assert.equal(pair.queue.length, 0);
});

test('capacity, indefinite leases and resource validation', async (t) => {
  const { schedule } = await fixture(t);
  await take(schedule, { resource: 'builds', owner: 'a' });
  await take(schedule, { resource: 'builds', owner: 'b' });
  await assert.rejects(take(schedule, { resource: 'builds', owner: 'c' }), { code: 'schedule_busy' });
  await assert.rejects(take(schedule, { resource: 'pair', owner: 'a', ttlMs: null }), {
    code: 'schedule_invalid_request'
  });
  const forever = await take(schedule, { resource: 'drafter', owner: 'drafter', ttlMs: null });
  assert.equal(forever.expiresAt, null);
  await assert.rejects(take(schedule, { resource: 'nope', owner: 'a' }), { code: 'schedule_unknown_resource' });
  await assert.rejects(schedule.take({ resource: 'pair', owner: 'a', apply: true }), { code: 'schedule_confirm' });
  assert.throws(() => normalizeResource('x', { capacity: 2, suspend: ['m'] }), /capacity 1/);
  assert.throws(() => normalizeResource('x', { onExpiry: 'explode' }), /onExpiry/);
});

test('routes and suspensions that were already in place are left as they were', async (t) => {
  const actions = fakeActions();
  actions.isSuspended = async ({ model }) => model === 'pair-model';
  const { schedule } = await fixture(t, { actions });
  actions.routes.omp = 'cloud';
  const held = await take(schedule, { resource: 'pair', owner: 'main' });
  assert.equal(held.state, 'active');
  assert.deepEqual(actions.calls, [['activeRoute', 'omp', 'node-a']]);
  actions.calls.length = 0;
  assert.equal((await release(schedule, held.id, { owner: 'main' })).state, 'released');
  assert.deepEqual(actions.calls, []);
  assert.equal(actions.routes.omp, 'cloud');

  // A route with no active profile has nothing exact to restore, so the take refuses.
  delete actions.routes.omp;
  const refused = await take(schedule, { resource: 'pair', owner: 'main' });
  assert.equal(refused.state, 'failed');
  assert.match(refused.error, /no active profile/);
});

test('resources that control the same model are unusable until fixed', async (t) => {
  const { schedule } = await fixture(t, {
    resources: { a: { suspend: ['shared'] }, b: { suspend: ['shared'] }, c: {} }
  });
  await assert.rejects(take(schedule, { resource: 'a', owner: 'x' }), { code: 'schedule_config' });
  const board = schedule.board();
  assert.match(board.resources.find((entry) => entry.id === 'b').error, /a, b both control shared/);
  assert.equal(board.resources.find((entry) => entry.id === 'c').error, undefined);
});

test('refused updates leave no trace; leases and jobs keep to their holders', async (t) => {
  const { schedule } = await fixture(t);
  const lease = await take(schedule, { resource: 'pair', owner: 'main' });
  await assert.rejects(schedule.startJob({ title: 'x', owner: 'other', reservationId: lease.id }), {
    code: 'schedule_not_owner'
  });
  const job = await schedule.startJob({ title: 'sweep', owner: 'main' });
  const tooMany = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}`, i]));
  await assert.rejects(schedule.updateJob(job.id, { note: 'kept?', metrics: tooMany }), {
    code: 'schedule_invalid_request'
  });
  const after = schedule.job(job.id);
  assert.deepEqual(after.metrics, {});
  assert.equal(after.notes.length, 0);
  await assert.rejects(schedule.updateJob(job.id, { owner: 'other', note: 'mine now' }), {
    code: 'schedule_not_owner'
  });
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => schedule.reservation(id), { code: 'schedule_unknown_reservation' });
    assert.throws(() => schedule.job(id), { code: 'schedule_unknown_job' });
  }
  // A second agent under the same owner name is a different holder when both name a session.
  const shared = await take(schedule, { resource: 'drafter', owner: 'team', session: 'claude:a', ttlMs: null });
  await assert.rejects(take(schedule, { resource: 'drafter', owner: 'team', session: 'claude:b' }), {
    code: 'schedule_busy'
  });
  assert.equal((await take(schedule, { resource: 'drafter', owner: 'team', session: 'claude:a' })).id, shared.id);
});

test('a stuck lease is reported, not renewed', async (t) => {
  const actions = fakeActions({ failResume: 1 });
  const { schedule } = await fixture(t, { actions });
  const held = await take(schedule, { resource: 'pair', owner: 'main' });
  await release(schedule, held.id, { owner: 'main' });
  await assert.rejects(schedule.renew(held.id, { owner: 'main' }), { code: 'schedule_not_open' });
  assert.equal((await take(schedule, { resource: 'pair', owner: 'main' })).state, 'stuck');
});

test('a deployment fence holds expiry and gives the time back', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-schedule-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = { now: 1_800_000_000_000 };
  let fenced = false;
  const schedule = createSchedule({
    getConfig: () => ({ reservations: { resources: RESOURCES } }),
    statePath: path.join(dir, 'schedule.json'),
    actions: fakeActions(),
    now: () => clock.now,
    isPaused: () => fenced
  });
  t.after(() => schedule.stop());
  const held = await take(schedule, { resource: 'builds', owner: 'ci' });
  fenced = true;
  clock.now += 10 * MINUTE;
  await schedule.sweep();
  clock.now += 40 * MINUTE;
  await schedule.sweep();
  assert.equal(schedule.reservation(held.id).state, 'active');
  fenced = false;
  await schedule.sweep();
  assert.equal(schedule.reservation(held.id).remainingMs, 20 * MINUTE);
});

// Different resource names cannot grant the same physical hosts concurrently.
test('host overlap blocks take and appears in preview and board, even for the same owner', async (t) => {
  const resources = { pair: { hosts: ['a', 'b'] }, tp4: { hosts: ['a', 'b', 'c', 'd'] } };
  const { schedule, actions } = await fixture(t, { resources });
  const held = await take(schedule, { resource: 'pair', owner: 'main' });
  await assert.rejects(take(schedule, { resource: 'tp4', owner: 'main' }), (error) => {
    assert.equal(error.code, 'schedule_busy');
    assert.deepEqual(
      error.details.holders.map((entry) => entry.id),
      [held.id]
    );
    return true;
  });
  assert.deepEqual(
    (await schedule.take({ resource: 'tp4' })).holders.map((entry) => entry.id),
    [held.id]
  );
  assert.deepEqual(schedule.board().resources.find((entry) => entry.id === 'tp4').blockingReservations, [held.id]);
  assert.equal(actions.calls.length, 0);
});

test('four-host queued resource promotes only after both disjoint leases release', async (t) => {
  const resources = {
    pair: { hosts: ['a', 'b'] },
    drafter: { hosts: ['c', 'd'] },
    tp4: { hosts: ['a', 'b', 'c', 'd'] }
  };
  const { schedule } = await fixture(t, { resources });
  const a = await take(schedule, { resource: 'pair', owner: 'a' });
  const b = await take(schedule, { resource: 'drafter', owner: 'b' });
  const queued = await take(schedule, { resource: 'tp4', owner: 'c', wait: true });
  assert.equal(queued.state, 'queued');
  await release(schedule, a.id, { owner: 'a' });
  assert.equal(schedule.reservation(queued.id).state, 'queued');
  await release(schedule, b.id, { owner: 'b' });
  await schedule.stop();
  assert.equal(schedule.reservation(queued.id).state, 'active');
});

test('simultaneous overlapping acquisitions grant exactly one lease', async (t) => {
  const { schedule } = await fixture(t, {
    resources: { pair: { hosts: ['a', 'b'] }, tp4: { hosts: ['a', 'b', 'c', 'd'] } }
  });
  const results = await Promise.allSettled([
    take(schedule, { resource: 'pair', owner: 'one' }),
    take(schedule, { resource: 'tp4', owner: 'two' })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'schedule_busy');
});

test('held host snapshot survives resource edits/removal and returned-view mutation', async (t) => {
  const { schedule, config } = await fixture(t, {
    resources: { pair: { hosts: ['a', 'b'] }, other: { hosts: ['a'] } }
  });
  const held = await take(schedule, { resource: 'pair', owner: 'one' });
  held.hosts.length = 0;
  config.reservations.resources.pair.hosts = ['z'];
  await assert.rejects(take(schedule, { resource: 'other', owner: 'two' }), { code: 'schedule_busy' });
  delete config.reservations.resources.pair;
  await assert.rejects(take(schedule, { resource: 'other', owner: 'two' }), { code: 'schedule_busy' });
  await release(schedule, held.id, { owner: 'one' });
  assert.equal((await take(schedule, { resource: 'other', owner: 'two' })).state, 'active');
});

test('a stuck restore blocks overlapping hosts until successful retry', async (t) => {
  const actions = fakeActions({ failResume: 1 });
  const { schedule } = await fixture(t, {
    actions,
    resources: { pair: { hosts: ['a'], suspend: ['model'] }, tp4: { hosts: ['a', 'b'] } }
  });
  const held = await take(schedule, { resource: 'pair', owner: 'one' });
  assert.equal((await release(schedule, held.id, { owner: 'one' })).state, 'stuck');
  await assert.rejects(take(schedule, { resource: 'tp4', owner: 'two' }), { code: 'schedule_busy' });
  await release(schedule, held.id, { owner: 'one' });
  assert.equal((await take(schedule, { resource: 'tp4', owner: 'two' })).state, 'active');
});

test('same-resource capacity remains valid while different host-sharing resource waits', async (t) => {
  const { schedule } = await fixture(t, {
    resources: { builds: { hosts: ['a'], capacity: 2 }, exclusive: { hosts: ['a'] } }
  });
  await take(schedule, { resource: 'builds', owner: 'one' });
  await take(schedule, { resource: 'builds', owner: 'two' });
  await assert.rejects(take(schedule, { resource: 'exclusive', owner: 'three' }), { code: 'schedule_busy' });
});

test('legacy leases derive hosts and fail closed if their resource disappears', async (t) => {
  const f = await fixture(t, {
    resources: { pair: { hosts: ['a'] }, overlap: { hosts: ['a'] }, disjoint: { hosts: ['z'] } }
  });
  const held = await take(f.schedule, { resource: 'pair', owner: 'one' });
  await f.schedule.stop();
  // Construct a persisted pre-upgrade fixture; this is not a live state migration.
  const state = JSON.parse(await fs.readFile(f.options.statePath, 'utf8'));
  delete state.reservations[held.id].hosts;
  await fs.writeFile(f.options.statePath, JSON.stringify(state));
  const recovered = createSchedule(f.options);
  t.after(() => recovered.stop());
  await assert.rejects(take(recovered, { resource: 'overlap', owner: 'two' }), { code: 'schedule_busy' });
  delete f.config.reservations.resources.pair;
  await assert.rejects(take(recovered, { resource: 'disjoint', owner: 'two' }), { code: 'schedule_busy' });
  await release(recovered, held.id, { owner: 'one' });
  assert.equal((await take(recovered, { resource: 'disjoint', owner: 'two' })).state, 'active');
});

test('acquiring and releasing actions retain cross-resource host exclusion', async (t) => {
  let finishSuspend;
  let finishResume;
  const actions = fakeActions();
  actions.suspend = () =>
    new Promise((resolve) => {
      finishSuspend = resolve;
    });
  actions.resume = () =>
    new Promise((resolve) => {
      finishResume = resolve;
    });
  const { schedule } = await fixture(t, {
    actions,
    resources: { pair: { hosts: ['a'], suspend: ['model'] }, tp4: { hosts: ['a', 'b'] } }
  });
  const acquiring = take(schedule, { resource: 'pair', owner: 'one' });
  while (!finishSuspend) await new Promise(setImmediate);
  await assert.rejects(take(schedule, { resource: 'tp4', owner: 'two' }), { code: 'schedule_busy' });
  finishSuspend();
  const held = await acquiring;
  const releasing = release(schedule, held.id, { owner: 'one' });
  while (!finishResume) await new Promise(setImmediate);
  await assert.rejects(take(schedule, { resource: 'tp4', owner: 'two' }), { code: 'schedule_busy' });
  finishResume();
  await releasing;
});
