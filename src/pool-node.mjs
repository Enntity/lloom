// Node side of pool membership: `lloom pool join` enrolls this node with a
// head and stores the node secret in a private file; `serve` then keeps the
// lease with a heartbeat loop when `pool.head` is configured.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentNodeId } from './cluster.mjs';
import { mutateConfigSource } from './config-mutation.mjs';
import { normalizeNodeEndpoint, validNodeId } from './pool-membership.mjs';

export const POOL_NODE_SECRET_FILE = 'pool-node-secret';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000;
const MAX_BACKOFF_MS = 300000;
const REQUEST_TIMEOUT_MS = 10000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function headBaseUrl(url) {
  try {
    return normalizeNodeEndpoint(url);
  } catch {
    throw new Error('Pool head URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
}

// The enrollment token and the node secret are bearer credentials. Plain HTTP
// is fine on loopback or a tailnet (WireGuard encrypts it), not across a LAN.
export function cleartextWarning(head) {
  const url = new URL(head);
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  const tailnet = /\.ts\.net$/i.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  return loopback || tailnet
    ? null
    : `pool head ${head} is plain HTTP: the enrollment token and node secret cross the network unencrypted; use HTTPS or a tailnet address`;
}

const configDir = (configPath) => path.dirname(path.resolve(String(configPath)));

// `pool.head.secretEnv` names an environment variable; `pool.head.secretFile`
// is a private regular file, relative to the config directory.
export async function resolvePoolNodeSecret(head = {}, { configPath, env = process.env } = {}) {
  if (head.secretEnv) {
    if (!ENV_NAME.test(head.secretEnv)) throw new Error('pool.head.secretEnv must be an environment variable name');
    const value = env[head.secretEnv];
    if (!value) throw new Error(`pool.head.secretEnv ${head.secretEnv} is empty or unset`);
    return value.trim();
  }
  if (head.secretFile) {
    const file = path.resolve(configDir(configPath), String(head.secretFile));
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error('pool.head.secretFile must be a regular file');
    if (stat.mode & 0o077) throw new Error('pool.head.secretFile must have private (0600) permissions');
    return (await fs.readFile(file, 'utf8')).trim();
  }
  throw new Error('pool.head needs secretEnv or secretFile');
}

async function writePrivateFile(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function errorMessage(response) {
  try {
    const message = (await response.json())?.error?.message;
    return typeof message === 'string' ? message.slice(0, 300) : '';
  } catch {
    return '';
  }
}

export async function joinPool(
  config,
  { headUrl, token, nodeId = currentNodeId(config), endpoint, labels, apply = false, yes = false, fetchFn = fetch } = {}
) {
  const head = headBaseUrl(headUrl);
  if (!validNodeId(nodeId)) throw new Error('Invalid node identity; pass --node-id');
  const advertised = endpoint ?? config.cluster?.nodes?.[nodeId]?.endpoint;
  if (!advertised) throw new Error("Pass --endpoint with this node's gateway URL as the head should reach it");
  const nodeEndpoint = normalizeNodeEndpoint(advertised);
  if (!config.sourcePath) throw new Error('Joining a pool requires an installed config file');
  const secretPath = path.join(configDir(config.sourcePath), POOL_NODE_SECRET_FILE);
  const summary = {
    ok: true,
    applied: false,
    head,
    nodeId,
    endpoint: nodeEndpoint,
    configPath: config.sourcePath,
    secretFile: secretPath
  };
  if (!apply)
    return { ...summary, next: 'Re-run with --apply --yes and the enrollment token on stdin (--token-stdin).' };
  if (!yes) throw new Error('Joining a pool requires --apply --yes');
  if (!token) throw new Error('Pass the enrollment token on stdin with --token-stdin');
  let response;
  try {
    response = await fetchFn(`${head}/gateway/pool/enroll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, endpoint: nodeEndpoint, ...(labels ? { labels } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new Error(`Pool head ${head} is unreachable`);
  }
  if (!response.ok) {
    const detail = await errorMessage(response);
    throw new Error(`Pool head rejected the enrollment (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const result = await response.json().catch(() => null);
  if (typeof result?.nodeSecret !== 'string' || !/^lps_[A-Za-z0-9_-]{43}$/.test(result.nodeSecret)) {
    throw new Error('Pool head returned an invalid enrollment response');
  }
  await writePrivateFile(secretPath, `${result.nodeSecret}\n`);
  let changed;
  try {
    ({ changed } = await mutateConfigSource(config, (raw) => {
      raw.pool ??= {};
      raw.pool.head = { url: head, nodeId, secretFile: POOL_NODE_SECRET_FILE };
    }));
  } catch (error) {
    // The token is spent and the secret saved; say how to finish by hand.
    throw new Error(
      `Enrolled as ${nodeId}, and the node secret is saved in ${secretPath}, but the config update failed ` +
        `(${error.message}). Set pool.head to ${JSON.stringify({ url: head, nodeId, secretFile: POOL_NODE_SECRET_FILE })} by hand.`,
      { cause: error }
    );
  }
  return {
    ...summary,
    applied: true,
    changed,
    leaseMs: result.leaseMs ?? null,
    ...(cleartextWarning(head) ? { warning: cleartextWarning(head) } : {})
  };
}

// One heartbeat per interval, with exponential backoff (and +/-10% jitter)
// while the head is unreachable or rejects the node. The head config is read
// on every tick, so a config reload adds, changes or removes it.
export function createPoolHeartbeatLoop({
  getHead,
  configPath,
  collect,
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random
} = {}) {
  let timer = null;
  let inFlight = null;
  let started = false;
  let stopped = false;
  let failures = 0;
  let last = null;

  async function beat(head) {
    const secret = await resolvePoolNodeSecret(head, { configPath, env });
    const body = { nodeId: head.nodeId, ...(await collect()) };
    const response = await fetchImpl(`${headBaseUrl(head.url)}/gateway/pool/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      const detail = await errorMessage(response);
      throw new Error(`pool head answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
  }

  async function tick() {
    const head = getHead();
    const intervalMs = Number(head?.intervalMs) > 0 ? Number(head.intervalMs) : DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (head?.url) {
      inFlight = beat(head);
      try {
        last = { at: new Date().toISOString(), ...(await inFlight) };
        if (failures) logger.info?.(`pool heartbeat to ${head.url} recovered`);
        failures = 0;
      } catch (error) {
        failures += 1;
        // Log the first failure and then every tenth, not every retry.
        if (failures === 1 || failures % 10 === 0) {
          logger.warn?.(`pool heartbeat to ${head.url} failed (${failures}x): ${error?.message ?? error}`);
        }
      } finally {
        inFlight = null;
      }
    }
    if (stopped) return;
    const backoff = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
    timer = schedule(() => tick().catch(() => {}), Math.round(backoff * (0.9 + random() * 0.2)));
    timer?.unref?.();
  }

  return {
    tick,
    // Idempotent: a config reload may call it again while the loop runs.
    start() {
      if (started) return;
      started = true;
      stopped = false;
      timer = schedule(() => tick().catch(() => {}), 0);
      timer?.unref?.();
    },
    async stop() {
      started = false;
      stopped = true;
      if (timer) cancel(timer);
      timer = null;
      await inFlight?.catch(() => {});
    },
    status() {
      return { failures, last };
    }
  };
}
