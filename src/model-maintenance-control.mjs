import { randomUUID } from 'node:crypto';
import { planModelMaintenance } from './model-maintenance.mjs';

const ACTIONS = new Set(['suspend', 'resume']);
const MAX_TIMEOUT = 7200000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function flagsOk(apply, yes) {
  return typeof apply === 'boolean' && typeof yes === 'boolean';
}

function timeoutOk(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= MAX_TIMEOUT;
}

function markerOf(config, id) {
  return config?.runtimes?.[id]?.maintenance || null;
}

function appendHistory(rt, entry) {
  rt.maintenanceHistory = [...(Array.isArray(rt.maintenanceHistory) ? rt.maintenanceHistory : []), entry].slice(-20);
}

function sameMarker(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.requestedModel === b.requestedModel &&
    a.since === b.since &&
    a.operationId === b.operationId
  );
}

function placementOwnerMembers(config, ownerId) {
  const placement = config?.runtimes?.[ownerId]?.placement;
  return Array.isArray(placement?.members) ? placement.members : [];
}

function controlledRuntimeIds(plan, config) {
  return [
    ...new Set(
      plan.runtimeIds.flatMap((id) => [id, ...placementOwnerMembers(config, id).map((member) => member.runtime)])
    )
  ];
}

export function createModelMaintenanceController({
  getConfig,
  mutateSource,
  reload,
  manager,
  admit,
  now = () => new Date().toISOString(),
  onChanged
}) {
  let queue = Promise.resolve();

  function serialize(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function currentState(plan) {
    return Object.fromEntries(
      plan.runtimeIds.map((id) => {
        const record = markerOf(getConfig(), id);
        return [
          id,
          record
            ? {
                state: record.state,
                requestedModel: record.requestedModel,
                since: record.since,
                operationId: record.operationId,
                by: record.by
              }
            : null
        ];
      })
    );
  }

  async function latchAll(plan, opId, state, by) {
    let mutated = false;
    await mutateSource((raw) => {
      const config = raw && typeof raw === 'object' ? raw : {};
      const currentPlan = planModelMaintenance(config, plan.requestedModel, plan.action);
      if (JSON.stringify(currentPlan.runtimeIds) !== JSON.stringify(plan.runtimeIds)) {
        throw new Error('managed runtime selection changed externally; retry with a fresh plan');
      }
      for (const id of plan.runtimeIds) {
        const current = markerOf(config, id);
        const snapshot = plan.markers[id];
        if (!sameMarker(current, snapshot)) {
          throw new Error(`maintenance marker for ${id} changed externally`);
        }
      }
      for (const id of plan.runtimeIds) {
        const rt = isPlainObject(config.runtimes[id]) ? config.runtimes[id] : (config.runtimes[id] = {});
        const at = now();
        rt.maintenance = {
          state,
          requestedModel: plan.requestedModel,
          since: at,
          operationId: opId,
          by
        };
        appendHistory(rt, { state, at, by, operationId: opId });
      }
      mutated = true;
      return undefined;
    });
    return mutated;
  }

  async function removeOwned(plan, opId, by) {
    await mutateSource((raw) => {
      const config = raw && typeof raw === 'object' ? raw : {};
      if (!isPlainObject(config.runtimes)) return undefined;
      for (const id of plan.runtimeIds) {
        if (config.runtimes[id]?.maintenance?.operationId !== opId) {
          throw new Error(`maintenance marker for ${id} changed externally`);
        }
      }
      for (const id of plan.runtimeIds) {
        const rt = config.runtimes[id];
        appendHistory(rt, { state: 'resumed', at: now(), by, operationId: opId });
        delete rt.maintenance;
        if (Object.keys(rt).every((key) => key === 'maintenanceHistory')) delete config.runtimes[id];
      }
      return undefined;
    });
  }

  async function reMarkOwned(plan, opId, state, by) {
    try {
      await mutateSource((raw) => {
        const config = raw && typeof raw === 'object' ? raw : {};
        if (!isPlainObject(config.runtimes)) return undefined;
        for (const id of plan.runtimeIds) {
          const rt = config.runtimes[id];
          const marker = rt?.maintenance;
          if (!isPlainObject(rt) || !marker || marker.operationId !== opId) continue;
          const at = now();
          rt.maintenance = {
            state,
            requestedModel: plan.requestedModel,
            since: marker.since || at,
            operationId: opId,
            by
          };
          appendHistory(rt, { state, at, by, operationId: opId });
        }
        return undefined;
      });
    } catch (err) {
      return err;
    }
    return null;
  }

  async function allStopped(ownerIds, config) {
    for (const id of ownerIds) {
      if (await manager.isHealthy(id)) return false;
      if (await manager.runtimeAppearsLoaded(id, { requireConfirmation: true })) return false;
    }
    for (const ownerId of ownerIds) {
      for (const member of placementOwnerMembers(config, ownerId)) {
        const rid = member?.runtime;
        if (rid === undefined || rid === null) continue;
        if (await manager.isHealthy(rid)) return false;
        if (await manager.runtimeAppearsLoaded(rid, { requireConfirmation: true })) return false;
      }
    }
    return true;
  }

  async function runSuspend(plan, opId, opts, ownerIds) {
    await latchAll(plan, opId, 'suspended', opts.by);
    await reload();
    for (const id of controlledRuntimeIds(plan, getConfig())) {
      await manager.drainRuntime(id, {
        timeoutMs: opts.drainTimeoutMs,
        reason: 'maintenance-suspend',
        requestedBy: opts.requesterNode ?? opts.requestedBy
      });
    }
    for (const id of ownerIds) {
      const result = await manager.stop(id, { requestedBy: opts.requesterNode ?? opts.requestedBy });
      if (result?.stopped === false && !['already-stopped', 'container-missing'].includes(result.reason)) {
        throw new Error(`runtime ${id} could not be stopped: ${result.reason}`);
      }
    }
    const clean = await allStopped(ownerIds, getConfig());
    if (!clean) {
      const err = new Error('runtimes still loaded or healthy after suspend');
      const cleanupErr = await reMarkOwned(plan, opId, 'suspended', opts.by);
      await reload();
      if (cleanupErr) err.cleanupError = cleanupErr;
      throw err;
    }
    const health = Object.fromEntries(ownerIds.map((id) => [id, false]));
    return {
      applied: true,
      status: 'suspended',
      changed: true,
      requestedModel: plan.requestedModel,
      action: plan.action,
      runtimeIds: plan.runtimeIds,
      affectedModelIds: plan.affectedModelIds,
      affectedAliases: plan.affectedAliases,
      state: currentState(plan),
      health
    };
  }

  async function runResume(plan, opId, opts, ownerIds) {
    const allHealthy = await (async () => {
      for (const id of ownerIds) if (!(await manager.isHealthy(id))) return false;
      return true;
    })();
    const noneMarked = ownerIds.every((id) => !markerOf(getConfig(), id));
    if (allHealthy && noneMarked) {
      return {
        applied: false,
        status: 'ready',
        changed: false,
        health: Object.fromEntries(ownerIds.map((id) => [id, true]))
      };
    }
    await latchAll(plan, opId, 'resuming', opts.by);
    try {
      await reload();
      for (const id of controlledRuntimeIds(plan, getConfig())) await manager.resumeRuntime(id);
      for (const id of ownerIds) {
        await admit(id, { force: false, warmup: true, requestedBy: opts.requesterNode ?? opts.requestedBy });
      }
      for (const id of ownerIds) {
        if (!(await manager.isHealthy(id))) {
          throw new Error(`runtime ${id} failed health check after resume`);
        }
      }
      await removeOwned(plan, opId, opts.by);
      await reload();
      const health = Object.fromEntries(ownerIds.map((id) => [id, true]));
      return {
        applied: true,
        status: 'ready',
        changed: true,
        health,
        requestedModel: plan.requestedModel,
        action: plan.action,
        runtimeIds: plan.runtimeIds,
        affectedModelIds: plan.affectedModelIds,
        affectedAliases: plan.affectedAliases,
        state: currentState(plan)
      };
    } catch (err) {
      let cleanupErr;
      try {
        cleanupErr = await reMarkOwned(plan, opId, 'suspended', opts.by);
        await reload();
      } catch (cleanupInner) {
        cleanupErr = cleanupInner;
      }
      for (const id of ownerIds) {
        try {
          const cfg = getConfig();
          if (markerOf(cfg, id)?.operationId === opId) {
            await manager.pauseRuntime(id, 'resume-failed', { requestedBy: opts.requesterNode ?? opts.requestedBy });
          }
        } catch (pauseErr) {
          if (!cleanupErr) cleanupErr = pauseErr;
        }
      }
      if (cleanupErr) err.cleanupError = cleanupErr;
      throw err;
    }
  }

  async function invoke(id, action, rawOpts) {
    const opts = rawOpts || {};
    const { apply = false, yes = false, requestedBy, requesterNode, drainTimeoutMs = 300000 } = opts;
    const by = requestedBy === undefined || requestedBy === null ? 'cli' : String(requestedBy).slice(0, 200);
    if (!flagsOk(apply, yes)) throw new TypeError('apply and yes must be booleans');
    if (!timeoutOk(drainTimeoutMs)) throw new RangeError('drainTimeoutMs must be an integer 0..7200000');
    if (action !== undefined && !ACTIONS.has(action)) throw new TypeError('action must be suspend or resume');
    const plan = planModelMaintenance(getConfig(), id, action);
    const ownerIds = plan.runtimeIds;
    plan.markers = {};
    for (const ownerId of ownerIds) plan.markers[ownerId] = markerOf(getConfig(), ownerId);
    if (!apply) {
      const { markers: _markers, ...publicPlan } = plan;
      return { ...publicPlan, applied: false };
    }
    if (!yes) throw new Error('apply requires yes=true');
    for (const ownerId of controlledRuntimeIds(plan, getConfig())) {
      manager.assertRuntimeControl(ownerId, requesterNode ?? requestedBy);
    }
    const opId = randomUUID();
    if (plan.action === 'suspend') return runSuspend(plan, opId, { ...opts, drainTimeoutMs, by }, ownerIds);
    return runResume(plan, opId, { ...opts, drainTimeoutMs, by }, ownerIds);
  }

  return {
    run(id, action, opts = {}) {
      return serialize(() => invoke(id, action, opts)).finally(() => {
        if (opts.apply === true) onChanged?.();
      });
    }
  };
}
