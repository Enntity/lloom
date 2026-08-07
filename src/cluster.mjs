import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './process-control.mjs';

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

function safeSystemValue(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

function slug(value) {
  return (
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node'
  );
}

function proxyModels(node = {}) {
  const proxy = asObject(node.proxy);
  return (Array.isArray(proxy.models) ? proxy.models : []).map((entry) =>
    typeof entry === 'string' ? { id: entry } : asObject(entry)
  );
}

export function materializeFederatedNodes(config) {
  config.backends ??= {};
  config.models ??= [];
  for (const [nodeId, node] of Object.entries(asObject(config.cluster?.nodes))) {
    const proxy = asObject(node.proxy);
    const advertised = proxyModels(node);
    if (proxy.enabled === false || !advertised.length) continue;
    if (!node.endpoint && !proxy.baseUrl) continue;
    const backendId = proxy.backend ?? `lloom-node-${slug(nodeId)}`;
    config.backends[backendId] ??= {
      type: 'openai',
      baseUrl: proxy.baseUrl ?? `${trimSlash(node.endpoint)}/v1`,
      ...((node.apiKeyEnv ?? config.cluster?.apiKeyEnv)
        ? { apiKeyEnv: node.apiKeyEnv ?? config.cluster.apiKeyEnv }
        : {}),
      timeoutMs: Number(proxy.timeoutMs ?? 1800000)
    };
    const namespace = proxy.namespace === false ? '' : String(proxy.namespace ?? nodeId).replace(/\/+$/, '');
    for (const advertisedModel of advertised) {
      const remoteId = advertisedModel.id ?? advertisedModel.model;
      if (!remoteId) continue;
      const modelId = advertisedModel.as ?? (namespace ? `${namespace}/${remoteId}` : remoteId);
      const target = {
        id: advertisedModel.targetId ?? nodeId,
        node: nodeId,
        backend: backendId,
        upstreamModel: remoteId,
        weight: advertisedModel.weight ?? 1
      };
      const existing = config.models.find((model) => model.id === modelId);
      if (existing) {
        const targets = modelTargets(existing);
        if (!targets.some((candidate) => candidate.id === target.id && candidate.node === nodeId)) {
          existing.targets = [...targets, target];
        }
        delete existing.backend;
        delete existing.runtime;
        continue;
      }
      const metadata = Object.fromEntries(
        Object.entries(advertisedModel).filter(
          ([key]) => !['id', 'model', 'as', 'targetId', 'weight', 'backend', 'runtime', 'targets'].includes(key)
        )
      );
      config.models.push({
        id: modelId,
        name: advertisedModel.name ?? remoteId.split('/').at(-1),
        kind: advertisedModel.kind ?? 'chat',
        ...metadata,
        upstreamModel: remoteId,
        targets: [target],
        federated: true
      });
    }
  }
  return config;
}

export function federatedNodeConfigFromSnapshot({
  nodeId,
  endpoint,
  snapshot,
  apiKeyEnv = 'LLOOM_CLUSTER_KEY',
  namespace = nodeId,
  merge = false
} = {}) {
  if (!nodeId) throw new Error('federated node id is required');
  if (!endpoint) throw new Error(`federated node ${nodeId} endpoint is required`);
  const node = snapshot?.node ?? snapshot ?? {};
  const profile = asObject(node.profile);
  const system = asObject(node.system);
  const models = (Array.isArray(node.models) ? node.models : [])
    .filter((model) => model?.id && model.federated !== true && model.alias !== true)
    .map((model) => ({
      id: model.id,
      as: merge ? model.id : `${String(namespace ?? nodeId).replace(/\/+$/, '')}/${model.id}`,
      ...(model.name ? { name: model.name } : {}),
      ...(model.kind ? { kind: model.kind } : {}),
      ...(Array.isArray(model.capabilities) ? { capabilities: model.capabilities } : {}),
      ...(Array.isArray(model.input) ? { input: model.input } : {}),
      ...(Array.isArray(model.output) ? { output: model.output } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {})
    }));
  return {
    name: node.name ?? nodeId,
    endpoint: trimSlash(endpoint),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    labels: {
      role: 'node',
      architecture: profile.platformId ?? ([system.platform, system.arch].filter(Boolean).join('-') || 'unknown'),
      ...(profile.accelerators?.[0] ? { accelerator: profile.accelerators[0] } : {})
    },
    resources: {
      ...(Number.isFinite(Number(profile.totalMemoryGb)) ? { memoryGb: Number(profile.totalMemoryGb) } : {})
    },
    proxy: {
      namespace,
      models
    }
  };
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
        backendHost: node?.backendHost ?? null,
        fabricInterface: node?.fabricInterface ?? null,
        sshAlias: node?.sshAlias ?? null,
        apiKeyEnv: node?.apiKeyEnv ?? config.cluster?.apiKeyEnv ?? null,
        labels: asObject(node?.labels),
        resources: asObject(node?.resources),
        proxy: asObject(node?.proxy),
        local: id === localId
      }
    ])
  );
}

export function parseNvidiaSyncSshConfig(source = '') {
  const entries = [];
  let entry = null;
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    const host = line.match(/^Host\s+([^*?!\s]+)$/i);
    if (host) {
      if (entry?.createdBySync && entry.hostname) entries.push(entry);
      entry = { alias: host[1], createdBySync: false };
      continue;
    }
    if (!entry) continue;
    if (/^###\s*CreatedBy:\s*NVIDIA Sync$/i.test(line)) entry.createdBySync = true;
    const hostname = line.match(/^Hostname\s+(\S+)$/i);
    if (hostname) entry.hostname = hostname[1];
    const user = line.match(/^User\s+(\S+)$/i);
    if (user) entry.user = user[1];
  }
  if (entry?.createdBySync && entry.hostname) entries.push(entry);
  return entries;
}

function ipv4Prefix(address, prefixlen) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const bits = Number(prefixlen);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const numeric = octets.reduce((value, octet) => (value * 256 + octet) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: numeric & mask, mask };
}

function sameSubnet(left, right, prefixlen) {
  const a = ipv4Prefix(left, prefixlen);
  const b = ipv4Prefix(right, prefixlen);
  return Boolean(a && b && a.network === b.network);
}

export function normalizeIpAddressOutput(value) {
  const devices = Array.isArray(value) ? value : [];
  return devices.flatMap((device) =>
    (device?.addr_info ?? [])
      .filter((address) => address?.family === 'inet' && address?.scope !== 'host')
      .map((address) => ({
        interface: device.ifname,
        address: address.local,
        prefixlen: Number(address.prefixlen ?? 32)
      }))
  );
}

function friendlyNodeId(alias) {
  return String(alias).replace(/-lan$/i, '');
}

export function buildNvidiaSyncDiscovery({ peers = [], localAddresses = [], localNodeId, hostname } = {}) {
  const matches = peers
    .map((peer) => {
      const local = localAddresses.find(
        (address) =>
          address.address?.startsWith('10.100.') && sameSubnet(address.address, peer.hostname, address.prefixlen)
      );
      return local ? { peer, local } : null;
    })
    .filter(Boolean);
  if (!matches.length) return null;
  const preferred = [...matches].sort(
    (left, right) => Number(right.local.address.split('.')[2]) - Number(left.local.address.split('.')[2])
  )[0];
  const id = localNodeId || hostname || os.hostname();
  const peerId = friendlyNodeId(preferred.peer.alias);
  const nodeIds = [id, peerId].sort();
  return {
    detected: true,
    provider: 'nvidia-sync',
    topology: 'direct',
    nodeCount: nodeIds.length,
    nodeId: id,
    leaderNode: nodeIds[0],
    fabric: {
      interface: preferred.local.interface,
      localAddress: preferred.local.address,
      peerAddress: preferred.peer.hostname,
      prefixlen: preferred.local.prefixlen
    },
    nodes: {
      [id]: {
        id,
        local: true,
        backendHost: preferred.local.address,
        fabricInterface: preferred.local.interface
      },
      [peerId]: {
        id: peerId,
        local: false,
        backendHost: preferred.peer.hostname,
        fabricInterface: preferred.local.interface,
        sshAlias: preferred.peer.alias,
        sshUser: preferred.peer.user ?? null
      }
    }
  };
}

async function tailscaleSelfName() {
  const result = await runCommand('tailscale', ['status', '--json'], { allowFailure: true });
  if (result.code !== 0) return null;
  try {
    const status = JSON.parse(result.stdout);
    return String(status?.Self?.DNSName ?? status?.Self?.HostName ?? '').split('.')[0] || null;
  } catch {
    return null;
  }
}

export async function detectNvidiaSyncCluster({ home = process.env.HOME, hostname = os.hostname() } = {}) {
  if (process.platform !== 'linux' || !home) return null;
  let sshConfig;
  try {
    sshConfig = await fs.readFile(path.join(home, '.ssh', 'config'), 'utf8');
  } catch {
    return null;
  }
  const peers = parseNvidiaSyncSshConfig(sshConfig);
  if (!peers.length) return null;
  const addressesResult = await runCommand('ip', ['-j', '-4', 'address', 'show'], { allowFailure: true });
  if (addressesResult.code !== 0) return null;
  let localAddresses;
  try {
    localAddresses = normalizeIpAddressOutput(JSON.parse(addressesResult.stdout));
  } catch {
    return null;
  }
  return buildNvidiaSyncDiscovery({
    peers,
    localAddresses,
    localNodeId: (await tailscaleSelfName()) ?? hostname,
    hostname
  });
}

export function nvidiaSyncClusterConfig(discovery, { id, port = 8100, apiKeyEnv = 'LLOOM_CLUSTER_KEY' } = {}) {
  if (!discovery?.detected || discovery.provider !== 'nvidia-sync') {
    throw new Error('NVIDIA Sync cluster was not detected');
  }
  const clusterId = id || `${discovery.leaderNode}-cluster`;
  return {
    id: clusterId,
    provider: discovery.provider,
    topology: discovery.topology,
    nodeId: discovery.nodeId,
    leaderNode: discovery.leaderNode,
    apiKeyEnv,
    nodes: Object.fromEntries(
      Object.entries(discovery.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          name: nodeId,
          endpoint: `http://${node.backendHost}:${port}`,
          backendHost: node.backendHost,
          fabricInterface: node.fabricInterface,
          ...(node.sshAlias ? { sshAlias: node.sshAlias } : {}),
          labels: {
            provider: 'nvidia-sync',
            role: nodeId === discovery.leaderNode ? 'leader' : 'worker',
            hardware: 'dgx-spark'
          },
          resources: { memoryGb: 128, accelerators: ['cuda', 'nvidia-gpu', 'blackwell', 'gb10'] }
        }
      ])
    )
  };
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
      upstreamModel: target.upstreamModel ?? model.upstreamModel ?? model.id ?? null,
      weight: Math.min(100, Math.max(1, Math.floor(Number(target.weight) || 1)))
    }));
  }
  return model?.backend
    ? [
        {
          id: 'default',
          node: null,
          backend: model.backend,
          runtime: model.runtime ?? null,
          upstreamModel: model.upstreamModel ?? model.id ?? null,
          weight: 1
        }
      ]
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
    if (node.proxy?.models != null && !Array.isArray(node.proxy.models)) {
      errors.push(`cluster node ${id} proxy.models must be an array`);
    }
    for (const [index, model] of proxyModels(node).entries()) {
      if (!model.id && !model.model) errors.push(`cluster node ${id} proxy.models[${index}] is missing id`);
    }
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
  constructor(
    config,
    { env = process.env, fetchImpl = fetch, logger = console, telemetry = null, profile = null, models = null } = {}
  ) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.telemetry = telemetry;
    this.profile = profile;
    this.models = models;
    this.runtimeManager = null;
    this.targetCursor = new Map();
    this.targetLoads = new Map();
    this.targetFailures = new Map();
    this.nodeCache = new Map();
  }

  reconfigure(config) {
    this.config = config;
    this.nodeCache.clear();
  }

  attachRuntimeManager(runtimeManager) {
    this.runtimeManager = runtimeManager;
  }

  attachModelCatalog(models) {
    this.models = models;
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
    const profile = typeof this.profile === 'function' ? await this.profile() : this.profile;
    const models = typeof this.models === 'function' ? await this.models() : this.models;
    return {
      id: this.nodeId,
      name: this.nodes[this.nodeId]?.name ?? this.nodeId,
      local: true,
      reachable: true,
      labels: this.nodes[this.nodeId]?.labels ?? {},
      resources: this.nodes[this.nodeId]?.resources ?? {},
      system: {
        hostname: safeSystemValue(() => os.hostname()),
        platform: process.platform,
        arch: process.arch,
        release: safeSystemValue(() => os.release()),
        uptimeSeconds: safeSystemValue(() => os.uptime())
      },
      profile: profile ?? null,
      models: Array.isArray(models) ? models : [],
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

  targetKey(resolved, target) {
    return `${resolved.resolvedId}:${target.id}`;
  }

  targetLoad(resolved, target, runtimeStatus = {}) {
    const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
    return (
      Number(status?.activeRequests ?? 0) +
      Number(status?.queuedRequests ?? 0) +
      Number(this.targetLoads.get(this.targetKey(resolved, target)) ?? 0)
    );
  }

  async withTarget(resolved, fn) {
    const target = resolved?.target;
    if (!target) return fn();
    const key = this.targetKey(resolved, target);
    this.targetLoads.set(key, Number(this.targetLoads.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const remaining = Math.max(0, Number(this.targetLoads.get(key) ?? 1) - 1);
      if (remaining) this.targetLoads.set(key, remaining);
      else this.targetLoads.delete(key);
    }
  }

  noteTargetOutcome(resolved, outcome = {}) {
    const target = resolved?.target;
    if (!target) return;
    const key = this.targetKey(resolved, target);
    if (outcome.ok) {
      this.targetFailures.delete(key);
      return;
    }
    if (Number(outcome.status ?? 0) >= 500) {
      const cooldownMs = Math.max(0, Number(this.config.cluster?.targetFailureCooldownMs ?? 5000));
      this.targetFailures.set(key, Date.now() + cooldownMs);
    }
  }

  selectTarget(resolved, runtimeStatus = {}, nodeStatus = {}) {
    const targets = modelTargets(resolved.model);
    if (targets.length <= 1) return targets[0] ?? null;
    const nodeAvailable = (target) => !target.node || nodeStatus.nodes?.[target.node]?.reachable !== false;
    const outsideCooldown = (target) =>
      Number(this.targetFailures.get(this.targetKey(resolved, target)) ?? 0) <= Date.now();
    const available = targets.filter((target) => {
      const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
      const runtimeAvailable =
        !target.runtime || status?.healthy === true || ['running', 'external'].includes(status?.status);
      return nodeAvailable(target) && outsideCooldown(target) && runtimeAvailable;
    });
    const reachable = targets.filter((target) => {
      const status = target.runtime ? runtimeStatus.runtimes?.[target.runtime] : null;
      return nodeAvailable(target) && outsideCooldown(target) && !['failed', 'unreachable'].includes(status?.status);
    });
    const pool = available.length ? available : reachable.length ? reachable : targets;
    const minimumLoad = Math.min(...pool.map((target) => this.targetLoad(resolved, target, runtimeStatus)));
    const leastLoaded = pool.filter((target) => this.targetLoad(resolved, target, runtimeStatus) === minimumLoad);
    const weighted = leastLoaded.flatMap((target) => Array.from({ length: target.weight }, () => target));
    const cursor = this.targetCursor.get(resolved.resolvedId) ?? 0;
    const selected = weighted[cursor % weighted.length];
    this.targetCursor.set(resolved.resolvedId, cursor + 1);
    return selected;
  }
}
