import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mutateConfigSource } from './config-mutation.mjs';
import { currentNodeId, federatedNodeConfigFromSnapshot } from './cluster.mjs';

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
    apply = false,
    yes = false,
    fetchFn = fetch
  } = {}
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nodeId ?? '')) throw new Error('Invalid node identity');
  if (nodeId === currentNodeId(config)) throw new Error('Cannot replace the local node with a federation peer');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid node endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Node endpoint must be an HTTP(S) URL without credentials, query, or fragment');
  if (apply && !yes) throw new Error('Adding this node requires --apply --yes');
  const base = url.toString().replace(/\/+$/, '');
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
  const summary = {
    ok: true,
    applied: false,
    nodeId,
    endpoint: base,
    telemetryOnly,
    importedModels: node.proxy.models.length
  };
  if (!apply) return summary;
  const before = await fs.readFile(config.sourcePath, 'utf8');
  if ((await fs.stat(config.sourcePath)).mode & 0o077)
    throw new Error('Credential-bearing config must have private permissions');
  const backupPath = config.sourcePath + '.lloom-before-' + randomUUID();
  await fs.writeFile(backupPath, before, { flag: 'wx', mode: 0o600 });
  await fs.chmod(backupPath, 0o600);
  const { changed } = await mutateConfigSource(config, (raw) => {
    if (JSON.stringify(raw) !== JSON.stringify(JSON.parse(before)))
      throw new Error('Configuration changed after the reviewed snapshot');
    raw.cluster ??= {};
    const local = currentNodeId(config);
    raw.cluster.nodeId ??= local;
    raw.cluster.leaderNode ??= local;
    raw.cluster.nodes ??= { [local]: { name: local } };
    raw.cluster.nodes[nodeId] = node;
  });
  return { ...summary, applied: true, changed, backupPath };
}
