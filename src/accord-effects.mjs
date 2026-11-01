// LLooM's only reservation state is an effect journal, never a queue or lease.
// Accord supplies fenced ownership; this module preserves exact model/route undo.
import fs from 'node:fs';
import { reconciledLease } from './accord-migration.mjs';
import path from 'node:path';
import { writeAtomicJson } from './deployment-fence.mjs';
import { normalizeResource, schedulePaths } from './resource-spec.mjs';
const fail = (message, code = 'accord_effects_unconfirmed') => Object.assign(Error(message), { code, statusCode: 409 });
export function createAccordEffects({ getConfig, statePath, actions, isPaused = () => false }) {
  let state = { schema: 1, resources: {} };
  if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.schema !== 1) throw Error('Unsupported Accord effect journal');
  for (const r of Object.values(state.resources))
    if (['preparing', 'starting'].includes(r.phase)) r.phase = 'recovering';
  let tail = Promise.resolve();
  const flights = new Map();
  const save = () => writeAtomicJson(statePath, state);
  const serialize = (key, fn) => {
    if (flights.has(key)) return flights.get(key);
    const p = tail.then(fn);
    tail = p.catch(() => {});
    flights.set(key, p);
    p.finally(() => flights.delete(key)).catch(() => {});
    return p;
  };
  function base(id) {
    return id.split('#')[0];
  }
  function spec(id) {
    const raw = getConfig().reservations?.resources?.[base(id)];
    const s = normalizeResource(base(id), raw, getConfig());
    const slot = Number(id.split('#')[1] ?? 0);
    if (!Number.isInteger(slot) || slot < 0 || slot >= s.capacity) throw fail('Invalid capacity slot');
    return s;
  }

  function legacy(id) {
    const file = schedulePaths(getConfig()).statePath;
    if (!file || !fs.existsSync(file)) return [];
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.schemaVersion !== 1) throw Error('Unknown legacy schedule; resources remain held');
    return Object.values(old.reservations ?? {}).filter(
      (r) =>
        r.resource === base(id) &&
        ['active', 'acquiring', 'releasing', 'stuck'].includes(r.state) &&
        !reconciledLease(getConfig(), r)
    );
  }
  function check(id, b) {
    if (
      !b ||
      typeof b.authority !== 'string' ||
      typeof b.claimId !== 'string' ||
      !Number.isSafeInteger(b.generation) ||
      b.generation < 1
    )
      throw fail('Invalid Accord fence');
    const r = state.resources[id];
    if (
      r &&
      (r.authority !== b.authority ||
        b.generation < r.generation ||
        (b.generation === r.generation && r.claimId !== b.claimId))
    )
      throw fail('Stale or different resource authority', 'stale_fence');
    if (legacy(id).length)
      throw fail(
        'Pre-migration workload remains held; reconcile its recorded effects before activating Accord',
        'legacy_resource_held'
      );
    return r;
  }
  async function undo(r) {
    for (const step of [...r.steps].reverse()) {
      if (step.status === 'undone') continue;
      if (step.kind === 'suspend') {
        if (!step.wasSuspended) await actions.resume(step);
      } else if (step.previous !== step.profile) await actions.setRoute({ ...step, profile: step.previous });
      step.status = 'undone';
      await save();
    }
  }
  async function handle(id, action, b) {
    if (action === 'availability') {
      spec(id);
      return { available: !isPaused() && !legacy(id).length };
    }
    return serialize(`${id}:${action}:${b?.authority}:${b?.generation}:${b?.claimId}:${b?.key ?? ''}`, async () => {
      // Deployment owns model effects while fenced. Accord keeps the grant held
      // until recovery can verify stop and restoration after deployment.
      if (action !== 'inspect' && isPaused()) throw fail('Deployment fence is active');
      const s = action === 'prepare' ? spec(id) : null;
      let r = check(id, b);
      const reply = (extra) => ({
        authority: b.authority,
        generation: b.generation,
        claimId: b.claimId,
        [action]: true,
        ...extra
      });
      if (action === 'prepare') {
        if (isPaused()) throw fail('Deployment fence blocks resource preparation');
        if (r?.generation === b.generation) {
          if (r.phase === 'active') return reply();
          throw fail('Interrupted or revoked generation requires recovery');
        }
        if (r && r.phase !== 'idle') throw fail('Previous restoration is unconfirmed');
        r = {
          authority: b.authority,
          generation: b.generation,
          claimId: b.claimId,
          phase: 'preparing',
          steps: [],
          workloads: s.workloads.map((w) => ({ ...w, stopped: false })),
          allowedWorkloads: s.workloads,
          startKey: null
        };
        state.resources[id] = r;
        await save();
        for (const step of s.actions) {
          const recorded = { ...step, status: 'pending' };
          if (step.kind === 'route') {
            recorded.previous = await actions.activeRoute(step);
            if (recorded.previous == null) throw fail('Route has no exact profile to restore');
          } else recorded.wasSuspended = (await actions.isSuspended(step)) === true;
          r.steps.push(recorded);
          await save();
          if (step.kind === 'route') {
            if (recorded.previous !== step.profile) await actions.setRoute(step);
          } else if (!recorded.wasSuspended)
            await actions.suspend({ ...step, drainTimeoutMs: getConfig().reservations?.drainTimeoutMs ?? 300000 });
          recorded.status = 'done';
          await save();
        }
        // Establish a stopped baseline before granting this generation, even
        // if a configured workload was already running before registration.
        for (const w of r.workloads) {
          await actions.suspend({ ...w, drainTimeoutMs: getConfig().reservations?.drainTimeoutMs ?? 300000 });
          w.stopped = true;
          await save();
        }
        r.phase = 'active';
        await save();
        return reply();
      }
      // A revoke may arrive before prepare; persist the tombstone before acknowledging.
      if (!r || b.generation > r.generation) {
        if (r && r.phase !== 'idle') throw fail('Previous effects remain held');
        r = {
          authority: b.authority,
          generation: b.generation,
          claimId: b.claimId,
          phase: 'stopping',
          steps: [],
          workloads: []
        };
        state.resources[id] = r;
        await save();
      }
      if (action === 'start') {
        if (isPaused() || r.phase !== 'active') throw fail('Resource is not active');
        if (!r.allowedWorkloads?.length) throw fail('No managed workloads configured for this resource');
        if (r.startKey) {
          if (r.startKey !== b.key) throw fail('One workload per grant; retry its original key');
          return reply({ state: 'running' });
        }
        r.startKey = b.key;
        r.phase = 'starting';
        r.workloads = r.allowedWorkloads.map((w) => ({ ...w, stopped: false }));
        await save();
        for (const w of r.workloads) await actions.resume(w);
        r.phase = 'active';
        await save();
        return reply({ state: 'running' });
      }
      if (action === 'inspect') {
        if (r.phase !== 'active') throw fail('Resource is not active');
        return reply({ state: r.startKey ? 'running' : 'not-started' });
      }
      if (action === 'stop') {
        if (r.phase === 'idle') return reply();
        r.phase = 'stopping';
        await save();
        for (const w of r.workloads) {
          if (w.stopped) continue;
          await actions.suspend({ ...w, drainTimeoutMs: getConfig().reservations?.drainTimeoutMs ?? 300000 });
          w.stopped = true;
          await save();
        }
        r.phase = 'stopped';
        await save();
        return reply();
      }
      if (action === 'restore') {
        if (!['stopped', 'idle'].includes(r.phase)) throw fail('Workload stop has not been confirmed');
        await undo(r);
        r.phase = 'idle';
        await save();
        return reply();
      }
      throw fail('Unknown resource effect');
    });
  }
  return {
    handle,
    legacy,
    async close() {
      await tail;
    },
    status: () => structuredClone(state),
    directory: path.dirname(statePath)
  };
}
