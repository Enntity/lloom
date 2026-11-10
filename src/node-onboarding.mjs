import { normalizeNodeEndpoint, validNodeId } from './pool-membership.mjs';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mutateConfigSource } from './config-mutation.mjs';
import {
  currentNodeId,
  federatedNodeConfigFromSnapshot,
  updateFederatedBackendTimeout,
  materializeFederatedNodes
} from './cluster.mjs';

export function parsePositiveTimeoutMs(value) {
  if (value == null || value === '') return undefined;
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error('--timeout-ms must be a positive integer');
  const timeoutMs = Number(text);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  return timeoutMs;
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function readBoundedStdinCredential(stream, { maxBytes = 16384 } = {}) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new Error('Credential input exceeds the size limit');
    chunks.push(bytes);
  }
  const key = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (!key || /[\x00-\x20\x7f]/.test(key)) throw new Error('Expected one nonempty credential on stdin');
  return key;
}

export async function addAuthenticatedNode(
  config,
  {
    nodeId,
    endpoint,
    apiKey,
    apiKeyEnv,
    telemetryOnly = false,
    namespace = nodeId,
    merge = false,
    includeExternal = false,
    reconcileImports = false,
    apply = false,
    yes = false,
    timeoutMs: requestedTimeoutMs,
    fetchFn = fetch
  } = {}
) {
  const timeoutMs = parsePositiveTimeoutMs(requestedTimeoutMs);
  if (!validNodeId(nodeId)) throw new Error('Invalid node identity');
  if (nodeId === currentNodeId(config)) throw new Error('Cannot replace the local node with a federation peer');
  const base = normalizeNodeEndpoint(endpoint);
  if (apply && !yes) throw new Error('Adding this node requires --apply --yes');
  let response;
  try {
    response = await fetchFn(base + '/gateway/node', {
      headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error('Node inspection failed; verify endpoint reachability');
  }
  if (!response.ok) throw new Error('Node inspection rejected the credential or request');
  let snapshot;
  try {
    snapshot = await response.json();
  } catch {
    throw new Error('Node returned an invalid snapshot');
  }
  if (snapshot?.node?.id !== nodeId) throw new Error('Node identity does not match the requested peer');
  const node = federatedNodeConfigFromSnapshot({
    nodeId,
    endpoint: base,
    snapshot,
    apiKeyEnv,
    namespace,
    merge,
    includeExternal
  });
  if (apiKeyEnv == null && apiKey) {
    delete node.apiKeyEnv;
    node.apiKey = apiKey;
  }
  if (telemetryOnly) node.proxy = { enabled: false, models: [] };
  if (timeoutMs !== undefined) node.proxy.timeoutMs = timeoutMs;
  const reconciliation = reconcileImportedModels(config.sourceTemplate ?? config, nodeId, node);
  const summary = {
    reconciliation: reconciliation.report,
    ok: true,
    applied: false,
    nodeId,
    endpoint: base,
    telemetryOnly,
    importedModels: node.proxy.models.length,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
  if (!apply) return summary;
  const before = await fs.readFile(config.sourcePath, 'utf8');
  if ((await fs.stat(config.sourcePath)).mode & 0o077)
    throw new Error('Credential-bearing config must have private permissions');
  const backupPath = config.sourcePath + '.lloom-before-' + randomUUID();
  await fs.writeFile(backupPath, before, { flag: 'wx', mode: 0o600 });
  await fs.chmod(backupPath, 0o600);
  let backendId;
  let backendTimeoutUpdated = false;
  const { changed } = await mutateConfigSource(config, (raw) => {
    if (JSON.stringify(raw) !== JSON.stringify(JSON.parse(before)))
      throw new Error('Configuration changed after the reviewed snapshot');
    raw.cluster ??= {};
    const local = currentNodeId(config);
    raw.cluster.nodeId ??= local;
    raw.cluster.leaderNode ??= local;
    raw.cluster.nodes ??= { [local]: { name: local } };
    const existingNode = objectRecord(raw.cluster.nodes[nodeId]);
    const existingProxy = objectRecord(existingNode.proxy);
    const nextNode = {
      ...existingNode,
      ...node,
      labels: {
        ...objectRecord(existingNode.labels),
        ...objectRecord(node.labels)
      },
      resources: {
        ...objectRecord(existingNode.resources),
        ...objectRecord(node.resources)
      },
      proxy: {
        ...existingProxy,
        ...objectRecord(node.proxy)
      }
    };
    if (!telemetryOnly && !Object.hasOwn(node.proxy, 'enabled') && existingProxy.enabled === false) {
      delete nextNode.proxy.enabled;
    }
    if (apiKeyEnv == null && apiKey) {
      delete nextNode.apiKeyEnv;
      nextNode.apiKey = apiKey;
    } else if (apiKeyEnv) {
      delete nextNode.apiKey;
      nextNode.apiKeyEnv = apiKeyEnv;
    }
    if (timeoutMs !== undefined) {
      const update = updateFederatedBackendTimeout(raw, { nodeId, node: nextNode, timeoutMs });
      if (update.sharedNodeIds.length) {
        throw new Error(
          `Cannot set --timeout-ms for ${nodeId}: federation backend ${update.backendId} is shared by ${update.sharedNodeIds.join(', ')}`
        );
      }
      backendId = update.backendId;
      backendTimeoutUpdated = update.updated;
    }
    if (reconcileImports) {
      const reconciled = reconcileImportedModels(raw, nodeId, nextNode);
      raw.models = reconciled.models;
      if (raw.clientCatalog?.modelOrder)
        raw.clientCatalog.modelOrder = raw.clientCatalog.modelOrder.filter(
          (id) => !reconciled.report.removed.includes(id)
        );
    }
    raw.cluster.nodes[nodeId] = nextNode;
  });
  return {
    ...summary,
    applied: true,
    changed,
    backupPath,
    ...(timeoutMs === undefined ? {} : { backendId, backendTimeoutUpdated })
  };
}

// Reconcile only persisted imports whose targets prove exclusive node ownership.
export function reconcileImportedModels(raw, nodeId, node) {
  const generated = materializeFederatedNodes({ cluster: { nodes: { [nodeId]: node } }, models: [] }).models;
  const byId = new Map(generated.map((model) => [model.id, model]));
  const references = new Set(Object.values(raw.defaults ?? {}));
  for (const alias of Object.values(raw.aliases ?? {})) {
    for (const id of typeof alias === 'string'
      ? [alias]
      : [alias?.target, ...(alias?.members ?? []), ...(alias?.fallbacks ?? [])])
      references.add(id);
  }
  const report = { removed: [], refreshed: [], protected: [], ambiguous: [] };
  const models = [];
  for (const original of raw.models ?? []) {
    const targets = original.targets ?? [];
    const owned =
      original.federated === true && targets.length > 0 && targets.every((target) => target.node === nodeId);
    if (!owned) {
      if (targets.some((target) => target.node === nodeId)) report.ambiguous.push(original.id);
      models.push(original);
      continue;
    }
    const fresh = byId.get(original.id);
    if (fresh) {
      models.push(fresh);
      if (JSON.stringify(original) !== JSON.stringify(fresh)) report.refreshed.push(original.id);
    } else if (references.has(original.id)) {
      models.push(original);
      report.protected.push(original.id);
    } else report.removed.push(original.id);
  }
  return { models, report };
}
