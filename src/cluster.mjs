import os from 'node:os';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function currentNodeId(config, env = process.env) {
  return env.LLOOM_NODE_ID || config.cluster?.nodeId || os.hostname();
}

export function clusterNodes(config, env = process.env) {
  const configured = asObject(config.cluster?.nodes);
  const localId = currentNodeId(config, env);
  if (!Object.keys(configured).length) {
    return {
      [localId]: {
        id: localId,
        name: localId,
        local: true,
        labels: {}
      }
    };
  }
  return Object.fromEntries(
    Object.entries(configured).map(([id, node]) => [
      id,
      {
        id,
        name: node?.name ?? id,
        endpoint: node?.endpoint ? trimSlash(node.endpoint) : null,
        apiKeyEnv: node?.apiKeyEnv ?? config.cluster?.apiKeyEnv ?? null,
        labels: asObject(node?.labels),
        resources: asObject(node?.resources),
        local: id === localId
      }
    ])
  );
}

export function runtimePlacement(runtime, config, env = process.env) {
  const placement = asObject(runtime?.placement);
  const mode = placement.mode ?? (runtime?.node ? 'pinned' : 'local');
  if (mode === 'distributed') {
    const members = Array.isArray(placement.members)
      ? placement.members.map((member, index) => ({
          node: member?.node,
          runtime: member?.runtime,
          role: member?.role ?? 'worker',
          order: Number.isFinite(Number(member?.order)) ? Number(member.order) : index,
          resources: asObject(member?.resources)
        }))
      : [];
    return { mode, nodes: [...new Set(members.map((member) => member.node).filter(Boolean))], members };
  }
  const node = runtime?.node ?? placement.node ?? currentNodeId(config, env);
  return { mode, node, nodes: node ? [node] : [], members: [] };
}

export function runtimeResourcesByNode(runtime, config, env = process.env) {
  const placement = runtimePlacement(runtime, config, env);
  if (placement.mode === 'distributed') {
    const resources = {};
    for (const member of placement.members) {
      if (!member.node) continue;
      const memberRuntime = config.runtimes?.[member.runtime];
      resources[member.node] ??= { memoryGb: 0, gpuMemoryGb: 0 };
      resources[member.node].memoryGb += numberOrZero(
        member.resources.memoryGb ?? memberRuntime?.memoryGb ?? memberRuntime?.resources?.memoryGb
      );
      resources[member.node].gpuMemoryGb += numberOrZero(
        member.resources.gpuMemoryGb ?? memberRuntime?.gpuMemoryGb ?? memberRuntime?.resources?.gpuMemoryGb
      );
    }
    return resources;
  }
  if (!placement.node) return {};
  return {
    [placement.node]: {
      memoryGb: numberOrZero(runtime?.memoryGb ?? runtime?.resources?.memoryGb),
      gpuMemoryGb: numberOrZero(runtime?.gpuMemoryGb ?? runtime?.resources?.gpuMemoryGb)
    }
  };
}

export function modelTargets(model) {
  if (Array.isArray(model?.targets) && model.targets.length) {
    return model.targets.map((target, index) => ({
      id: target.id ?? `${target.node ?? 'target'}-${index + 1}`,
      node: target.node ?? null,
      backend: target.backend,
      runtime: target.runtime ?? null,
      weight: Math.min(100, Math.max(1, Math.floor(Number(target.weight) || 1)))
    }));
  }
  return model?.backend
    ? [{ id: 'default', node: null, backend: model.backend, runtime: model.runtime ?? null, weight: 1 }]
    : [];
}

export function validateClusterConfig(config, env = process.env) {
  const errors = [];
  const nodes = clusterNodes(config, env);
  const configuredCluster = Object.keys(asObject(config.cluster?.nodes)).length > 0;
  const localId = currentNodeId(config, env);
  if (configuredCluster && !nodes[localId]) errors.push(`cluster nodeId ${localId} is not declared in cluster.nodes`);
  for (const [id, node] of Object.entries(nodes)) {
    if (!node.local && !node.endpoint) errors.push(`cluster node ${id} is missing endpoint`);
  }
  for (const [runtimeId, runtime] of Object.entries(config.runtimes ?? {})) {
    const placement = runtimePlacement(runtime, config, env);
    for (const nodeId of placement.nodes) {
      if (!nodes[nodeId]) errors.push(`runtime ${runtimeId} references unknown cluster node ${nodeId}`);
    }
    if (placement.mode === 'distributed') {
      if (!placement.members.length) errors.push(`distributed runtime ${runtimeId} has no placement members`);
      for (const member of placement.members) {
        if (!member.runtime) errors.push(`distributed runtime ${runtimeId} has a member without runtime`);
        else if (!config.runtimes?.[member.runtime]) {
          errors.push(`distributed runtime ${runtimeId} references unknown member runtime ${member.runtime}`);
        } else if (member.runtime === runtimeId) {
          errors.push(`distributed runtime ${runtimeId} cannot contain itself`);
        }
        if (!member.node) errors.push(`distributed runtime ${runtimeId} has a member without node`);
      }
    }
  }
  const visitedGroups = new Set();
  const visitingGroups = new Set();
  function visitGroup(runtimeId, path = []) {
    if (visitingGroups.has(runtimeId)) {
      errors.push(`distributed runtime cycle: ${[...path, runtimeId].join(' -> ')}`);
      return;
    }
    if (visitedGroups.has(runtimeId)) return;
    const runtime = config.runtimes?.[runtimeId];
    if (runtime?.placement?.mode !== 'distributed') return;
    visitingGroups.add(runtimeId);
    for (const member of runtime.placement.members ?? []) visitGroup(member.runtime, [...path, runtimeId]);
    visitingGroups.delete(runtimeId);
    visitedGroups.add(runtimeId);
  }
  for (const runtimeId of Object.keys(config.runtimes ?? {})) visitGroup(runtimeId);
  for (const model of config.models ?? []) {
    const targets = modelTargets(model);
    if (!targets.length) errors.push(`model ${model.id ?? '(missing)'} has no backend targets`);
    for (const target of targets) {
      if (!target.backend) errors.push(`model ${model.id} target ${target.id} is missing backend`);
      else if (!config.backends?.[target.backend]) {
        errors.push(`model ${model.id} target ${target.id} references unknown backend ${target.backend}`);
      }
      if (target.runtime && !config.runtimes?.[target.runtime]) {
        errors.push(`model ${model.id} target ${target.id} references unknown runtime ${target.runtime}`);
      }
      if (target.node && !nodes[target.node]) {
        errors.push(`model ${model.id} target ${target.id} references unknown cluster node ${target.node}`);
      }
      if (target.node && target.runtime) {
        const placement = runtimePlacement(config.runtimes[target.runtime], config, env);
        if (!placement.nodes.includes(target.node)) {
          errors.push(
            `model ${model.id} target ${target.id} node ${target.node} does not match runtime ${target.runtime}`
          );
        }
      }
    }
  }
  return errors;
}

export class ClusterCoordinator {
  constructor(config, { env = process.env, fetchImpl = fetch, logger = console, telemetry = null } = {}) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.telemetry = telemetry;
    this.runtimeManager = null;
    this.targetCursor = new Map();
    this.nodeCache = new Map();
  }

  reconfigure(config) {
    this.config = config;
    this.nodeCache.clear();
  }

  attachRuntimeManager(runtimeManager) {
    this.runtimeManager = runtimeManager;
  }

  get nodeId() {
    return currentNodeId(this.config, this.env);
  }

  get nodes() {
    return clusterNodes(this.config, this.env);
  }

  isLocalNode(nodeId) {
    return !nodeId || nodeId === this.nodeId;
  }

  headersFor(node) {
    const key = node.apiKeyEnv ? this.env[node.apiKeyEnv] : null;
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  async requestNode(nodeId, pathname, { method = 'GET', body, timeoutMs = 5000 } = {}) {
    const node = this.nodes[nodeId];
    if (!node) throw new Error(`unknown cluster node ${nodeId}`);
    if (!node.endpoint) throw new Error(`cluster node ${nodeId} has no endpoint`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${node.endpoint}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body == null ? {} : { 'content-type': 'application/json' }),
          ...this.headersFor(node)
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload?.error?.message ?? payload?.message ?? `${response.status} ${response.statusText}`);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async localNodeStatus({ runtimeStatus = null } = {}) {
    return {
      id: this.nodeId,
      name: this.nodes[this.nodeId]?.name ?? this.nodeId,
      local: true,
      reachable: true,
      labels: this.nodes[this.nodeId]?.labels ?? {},
      resources: this.nodes[this.nodeId]?.resources ?? {},
      telemetry: this.telemetry ? await this.telemetry.snapshot() : null,
      runtimeManager:
        runtimeStatus ??
        (this.runtimeManager ? await this.runtimeManager.status({ localOnly: true }) : { runtimes: {} })
    };
  }

  async nodeStatus(nodeId, { refresh = false } = {}) {
    if (this.isLocalNode(nodeId)) return this.localNodeStatus();
    const node = this.nodes[nodeId];
    const ttlMs = Math.max(0, Number(this.config.cluster?.statusCacheMs ?? 1000));
    const cached = this.nodeCache.get(nodeId);
    if (!refresh && cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (!refresh && cached?.pending) return cached.pending;
    const pending = (async () => {
      try {
        const result = await this.requestNode(nodeId, '/gateway/node');
        return {
          ...result.node,
          id: nodeId,
          name: node.name,
          local: false,
          reachable: true,
          labels: node.labels,
          resources: node.resources
        };
      } catch (error) {
        return {
          id: nodeId,
          name: node.name,
          local: false,
          reachable: false,
          labels: node.labels,
          resources: node.resources,
          telemetry: null,
          runtimeManager: { runtimes: {} },
          error: error?.message ?? String(error)
        };
      }
    })();
    this.nodeCache.set(nodeId, { at: cached?.at ?? 0, value: cached?.value, pending });
    const value = await pending;
    this.nodeCache.set(nodeId, { at: Date.now(), value, pending: null });
    return value;
  }

  async status({ localRuntimeStatus = null } = {}) {
    const entries = await Promise.all(
      Object.keys(this.nodes).map(async (id) => [
        id,
        this.isLocalNode(id) && localRuntimeStatus
          ? await this.localNodeStatus({ runtimeStatus: localRuntimeStatus })
          : await this.nodeStatus(id)
      ])
    );
    return {
      enabled: Object.keys(this.config.cluster?.nodes ?? {}).length > 0,
      id: this.config.cluster?.id ?? 'local',
      nodeId: this.nodeId,
      leaderNode: this.config.cluster?.leaderNode ?? this.nodeId,
      nodes: Object.fromEntries(entries)
    };
  }

  async runtimeAction(nodeId, runtimeId, action, body = {}) {
    if (this.isLocalNode(nodeId)) throw new Error(`runtimeAction for ${runtimeId} was routed back to the local node`);
    const result = await this.requestNode(nodeId, `/gateway/runtimes/${encodeURIComponent(runtimeId)}/${action}`, {
      method: 'POST',
      body,
      timeoutMs: action === 'start' || action === 'warmup' ? 1800000 : 120000
    });
    this.nodeCache.delete(nodeId);
    return result;
  }

  selectTarget(resolved, runtimeStatus = {}) {
    const targets = modelTargets(resolved.model);
    if (targets.length <= 1) return targets[0] ?? null;
    const available = targets.filter((target) => {
      const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
      return status?.healthy === true || ['running', 'external'].includes(status?.status);
    });
    const reachable = targets.filter((target) => {
      const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
      return !['failed', 'unreachable'].includes(status?.status);
    });
    const pool = available.length ? available : reachable.length ? reachable : targets;
    const minimumLoad = Math.min(
      ...pool.map((target) => {
        const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
        return Number(status?.activeRequests ?? 0) + Number(status?.queuedRequests ?? 0);
      })
    );
    const leastLoaded = pool.filter((target) => {
      const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
      return Number(status?.activeRequests ?? 0) + Number(status?.queuedRequests ?? 0) === minimumLoad;
    });
    const weighted = leastLoaded.flatMap((target) => Array.from({ length: target.weight }, () => target));
    const cursor = this.targetCursor.get(resolved.resolvedId) ?? 0;
    const selected = weighted[cursor % weighted.length];
    this.targetCursor.set(resolved.resolvedId, cursor + 1);
    return selected;
  }
}
