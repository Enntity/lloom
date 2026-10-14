// Pool membership: nodes join a head with a one-time enrollment token and keep
// a lease with heartbeats, so the pool planner knows who is in the pool.
// Pure: no I/O and an injectable clock. Persistence (`toJSON()` / `state`)
// holds SHA-256 hashes of tokens and node secrets, never the values. Both are
// 256-bit random strings, so an unsalted hash is not guessable.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const POOL_MEMBERSHIP_VERSION = 1;

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_PATTERN = /^lpt_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const SECRET_PATTERN = /^lps_[A-Za-z0-9_-]{43}$/;
const LABEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const MAX_LABELS = 32;
const MAX_TEXT = 256;
const MAX_LIST = 4096;
const MAX_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_TOKEN_USES = 1000;
const MAX_TELEMETRY_CHARS = 65536;
// Compared when a node id is unknown, so a miss costs the same as a mismatch.
const DUMMY_HASH = sha256('lloom-pool-membership');

function membershipError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

const invalid = (message) => membershipError(400, 'invalid_request', message);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function hashMatches(value, expectedHash) {
  const actual = Buffer.from(sha256(value), 'hex');
  const expected = Buffer.from(typeof expectedHash === 'string' ? expectedHash : DUMMY_HASH, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function validNodeId(value) {
  return typeof value === 'string' && NODE_ID_PATTERN.test(value);
}

// Shared with `lloom cluster add-node`: an HTTP(S) URL with no credentials,
// query or fragment, returned without a trailing slash.
export function normalizeNodeEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid('Invalid node endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw invalid('Node endpoint must be an HTTP(S) URL without credentials, query, or fragment');
  return url.toString().replace(/\/+$/, '');
}

function text(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT)
    throw invalid(`${name} must be text up to ${MAX_TEXT} characters`);
  return value;
}

function normalizeLabels(labels) {
  if (labels == null) return {};
  const entries = labels && typeof labels === 'object' && !Array.isArray(labels) ? Object.entries(labels) : null;
  if (
    !entries ||
    entries.length > MAX_LABELS ||
    entries.some(([key, value]) => !LABEL_KEY_PATTERN.test(key) || typeof value !== 'string' || value.length > MAX_TEXT)
  ) {
    throw invalid(`labels must map up to ${MAX_LABELS} names to text values`);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// Node-reported text reaches admin terminals; control characters (escape
// sequences) are dropped rather than printed.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const cleanText = (item) => typeof item === 'string' && item && item.length <= MAX_TEXT && !CONTROL.test(item);
const strings = (value) => (Array.isArray(value) ? value : []).filter(cleanText).slice(0, MAX_LIST);
const objects = (value, map) =>
  (Array.isArray(value) ? value : [])
    .slice(0, MAX_LIST)
    .map((item) => (isObject(item) || typeof item === 'string' ? map(item) : null))
    .filter(Boolean);
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
const pickText = (value) => (cleanText(value) ? value : null);

// A node reports its own inventory, so keep only the fields the planner reads,
// with the types it expects (see collectNodeInventory in pool-inventory.mjs).
function sanitizeInventory(inventory) {
  if (!isObject(inventory)) return null;
  const has = (key) => Object.hasOwn(inventory, key);
  const backends = isObject(inventory.backends) ? inventory.backends : null;
  return compact({
    version: finite(inventory.version),
    complete: inventory.complete === true,
    collectedAt: pickText(inventory.collectedAt),
    platformId: pickText(inventory.platformId),
    computeArchs: has('computeArchs') ? strings(inventory.computeArchs) : null,
    accelerators: has('accelerators') ? strings(inventory.accelerators) : null,
    memoryDomains: has('memoryDomains')
      ? objects(inventory.memoryDomains, (domain) =>
          pickText(domain.id) && finite(domain.capacityGb) != null
            ? compact({ id: domain.id, kind: pickText(domain.kind), capacityGb: domain.capacityGb })
            : null
        )
      : null,
    links: has('links')
      ? objects(inventory.links, (link) => {
          const peerNodeId = typeof link === 'string' ? link : link.peerNodeId;
          return validNodeId(peerNodeId)
            ? compact({
                peerNodeId,
                localInterface: pickText(link.localInterface),
                peerAddress: pickText(link.peerAddress)
              })
            : null;
        })
      : null,
    disks: has('disks')
      ? objects(inventory.disks, (disk) =>
          pickText(disk.root)
            ? compact({ root: disk.root, freeGb: finite(disk.freeGb), totalGb: finite(disk.totalGb) })
            : null
        )
      : null,
    weights: has('weights')
      ? objects(inventory.weights, (entry) =>
          pickText(entry.recipeId)
            ? compact({ recipeId: entry.recipeId, root: pickText(entry.root), complete: entry.complete === true })
            : null
        )
      : null,
    backends: backends
      ? {
          commands: Object.fromEntries(
            Object.entries(isObject(backends.commands) ? backends.commands : {})
              .filter(([name, value]) => value === true && name.length <= MAX_TEXT)
              .slice(0, MAX_LIST)
          ),
          dockerImages: strings(backends.dockerImages)
        }
      : null
  });
}

function sanitizeTelemetry(telemetry) {
  if (!isObject(telemetry)) return null;
  return JSON.stringify(telemetry).length <= MAX_TELEMETRY_CHARS ? telemetry : null;
}

function positiveInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw invalid(`${name} must be an integer from 1 to ${max}`);
  return value;
}

const iso = (ms) => new Date(ms).toISOString();

// Planner node shape (see plannerNodesFromStatus in pool-catalog.mjs). Lost and
// left nodes host nothing; cordoned and draining nodes take no placements.
export function memberPlannerNode(member) {
  const inventory = member.inventory ?? null;
  return compact({
    id: member.id,
    available: !['lost', 'left'].includes(member.state),
    cordoned: member.cordoned === true || member.draining === true,
    membership: member.state,
    platformId: inventory?.platformId ?? null,
    computeArchs: inventory?.computeArchs ?? [],
    accelerators: inventory?.accelerators ?? [],
    memoryDomains: inventory?.memoryDomains ?? [],
    links: [...new Set((inventory?.links ?? []).map((link) => link.peerNodeId))].sort(),
    weights: (inventory?.weights ?? []).filter((entry) => entry.complete).map((entry) => entry.recipeId),
    images: inventory?.backends?.dockerImages ?? [],
    inventory: inventory ? (inventory.complete ? 'reported' : 'profile') : 'none'
  });
}

function restoreState(state) {
  if (state == null) return { tokens: new Map(), nodes: new Map() };
  if (state.version !== POOL_MEMBERSHIP_VERSION) {
    throw new Error(`Unsupported pool membership state version ${state.version}`);
  }
  const tokens = new Map(
    (Array.isArray(state.tokens) ? state.tokens : [])
      .filter((token) => /^[0-9a-f]{12}$/.test(token?.id ?? '') && /^[0-9a-f]{64}$/.test(token.hash ?? ''))
      .map((token) => [token.id, { ...token, labels: normalizeLabels(token.labels) }])
  );
  const nodes = new Map(
    (Array.isArray(state.nodes) ? state.nodes : [])
      .filter((node) => validNodeId(node?.id))
      .map((node) => [
        node.id,
        {
          ...node,
          labels: normalizeLabels(node.labels),
          inventory: sanitizeInventory(node.inventory),
          running: strings(node.running),
          telemetry: null
        }
      ])
  );
  return { tokens, nodes };
}

export function createPoolMembership({ leaseMs = 30000, lostAfterMs = 3 * leaseMs, now = Date.now, state } = {}) {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive number');
  if (!Number.isFinite(lostAfterMs) || lostAfterMs < leaseMs) throw new Error('lostAfterMs must be at least leaseMs');
  const { tokens, nodes } = restoreState(state);

  function liveToken(token, at) {
    return token && token.used < token.uses && Date.parse(token.expiresAt) > at;
  }

  function memberState(node, at) {
    if (node.left) return 'left';
    const lastSeen = Date.parse(node.lastSeenAt);
    if (at < lastSeen + leaseMs) return 'ready';
    return at < lastSeen + lostAfterMs ? 'suspect' : 'lost';
  }

  function view(node, at = now()) {
    return {
      id: node.id,
      endpoint: node.endpoint,
      labels: { ...node.labels },
      state: memberState(node, at),
      cordoned: node.cordoned,
      draining: node.draining,
      reason: node.reason,
      enrolledAt: node.enrolledAt,
      lastSeenAt: node.lastSeenAt,
      leaseExpiresAt: iso(Date.parse(node.lastSeenAt) + leaseMs),
      inventory: node.inventory ? structuredClone(node.inventory) : null,
      running: [...node.running],
      telemetry: node.telemetry ? structuredClone(node.telemetry) : null
    };
  }

  function requireNode(nodeId) {
    const node = typeof nodeId === 'string' ? nodes.get(nodeId) : null;
    if (!node) throw membershipError(404, 'unknown_pool_node', `unknown pool node ${nodeId}`);
    return node;
  }

  function newSecret() {
    return 'lps_' + randomBytes(32).toString('base64url');
  }

  return {
    leaseMs,
    lostAfterMs,

    // A token bound to `nodeId` enrolls only that node, and is the only way to
    // re-enroll a node that is enrolled (or configured on the head).
    issueEnrollmentToken({ ttlMs = 3600000, uses = 1, labels = {}, nodeId = null } = {}) {
      positiveInteger(ttlMs, 'ttlMs', MAX_TOKEN_TTL_MS);
      positiveInteger(uses, 'uses', MAX_TOKEN_USES);
      if (nodeId != null && !validNodeId(nodeId)) throw invalid('Invalid node identity');
      const tokenLabels = normalizeLabels(labels);
      const at = now();
      for (const [id, token] of tokens) if (!liveToken(token, at)) tokens.delete(id);
      let id;
      do id = randomBytes(6).toString('hex');
      while (tokens.has(id));
      const token = `lpt_${id}_${randomBytes(32).toString('base64url')}`;
      const expiresAt = iso(at + ttlMs);
      tokens.set(id, {
        id,
        hash: sha256(token),
        createdAt: iso(at),
        expiresAt,
        uses,
        used: 0,
        labels: tokenLabels,
        ...(nodeId ? { nodeId } : {})
      });
      return { token, id, expiresAt, ...(nodeId ? { nodeId } : {}) };
    },

    enroll({ token, nodeId, endpoint, inventory, labels, protectedNodeIds = [] } = {}) {
      const at = now();
      const match = typeof token === 'string' ? token.match(TOKEN_PATTERN) : null;
      const record = match ? tokens.get(match[1]) : null;
      // One generic failure: an attacker learns nothing about which check failed.
      const tokenOk =
        hashMatches(token ?? '', record?.hash) && liveToken(record, at) && (!record.nodeId || record.nodeId === nodeId);
      if (!tokenOk) {
        throw membershipError(401, 'invalid_enrollment_token', 'enrollment token is invalid, expired, or used up');
      }
      if (!validNodeId(nodeId)) throw invalid('Invalid node identity');
      const existing = nodes.get(nodeId) ?? null;
      // Claiming a live or configured identity would hand its liveness,
      // endpoint and reported capacity to whoever holds any token.
      const claimed =
        (existing && !existing.left) || (Array.isArray(protectedNodeIds) && protectedNodeIds.includes(nodeId));
      if (claimed && record.nodeId !== nodeId) {
        throw membershipError(
          409,
          'pool_node_conflict',
          `node ${nodeId} is already in the pool; re-enroll it with a token issued for it (lloom pool token create --node-id ${nodeId})`
        );
      }
      const normalizedEndpoint = normalizeNodeEndpoint(endpoint);
      const nodeLabels = { ...normalizeLabels(labels), ...record.labels };
      const nodeSecret = newSecret();
      record.used += 1;
      nodes.set(nodeId, {
        id: nodeId,
        endpoint: normalizedEndpoint,
        labels: normalizeLabels(nodeLabels),
        secretHash: sha256(nodeSecret),
        tokenId: record.id,
        enrolledAt: iso(at),
        lastSeenAt: iso(at),
        cordoned: existing?.cordoned === true,
        draining: existing?.draining === true,
        reason: existing?.reason ?? null,
        left: false,
        inventory: sanitizeInventory(inventory) ?? existing?.inventory ?? null,
        running: existing?.running ?? [],
        telemetry: null
      });
      return { nodeId, nodeSecret, leaseMs };
    },

    heartbeat({ nodeId, nodeSecret, inventory, running, telemetry } = {}) {
      const node = typeof nodeId === 'string' ? nodes.get(nodeId) : null;
      const secretOk =
        typeof nodeSecret === 'string' && SECRET_PATTERN.test(nodeSecret) && hashMatches(nodeSecret, node?.secretHash);
      if (!secretOk || !node || node.left) {
        throw membershipError(401, 'invalid_node_credential', 'pool node credential is invalid');
      }
      const at = now();
      node.lastSeenAt = iso(at);
      const nextInventory = sanitizeInventory(inventory);
      if (nextInventory) node.inventory = nextInventory;
      if (running !== undefined) node.running = strings(running);
      if (telemetry !== undefined) node.telemetry = sanitizeTelemetry(telemetry);
      return { ok: true, leaseExpiresAt: iso(at + leaseMs), cordoned: node.cordoned, draining: node.draining };
    },

    cordon(nodeId, { reason } = {}) {
      const node = requireNode(nodeId);
      const nextReason = text(reason, 'reason');
      node.cordoned = true;
      node.reason = nextReason ?? node.reason;
      return view(node);
    },

    uncordon(nodeId) {
      const node = requireNode(nodeId);
      Object.assign(node, { cordoned: false, draining: false, reason: null });
      return view(node);
    },

    drain(nodeId, { reason } = {}) {
      const node = requireNode(nodeId);
      const nextReason = text(reason, 'reason');
      node.draining = true;
      node.reason = nextReason ?? node.reason;
      return view(node);
    },

    leave(nodeId) {
      const node = requireNode(nodeId);
      Object.assign(node, { left: true, secretHash: null, running: [], telemetry: null });
      return view(node);
    },

    members() {
      const at = now();
      return [...nodes.values()].map((node) => view(node, at)).sort((a, b) => a.id.localeCompare(b.id));
    },

    plannerNodes() {
      return this.members().map(memberPlannerNode);
    },

    toJSON() {
      const at = now();
      return {
        version: POOL_MEMBERSHIP_VERSION,
        tokens: [...tokens.values()]
          .filter((token) => liveToken(token, at))
          .map((token) => ({ ...token }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        nodes: [...nodes.values()]
          .map(({ telemetry: _telemetry, ...node }) => ({ ...node }))
          .sort((a, b) => a.id.localeCompare(b.id))
      };
    }
  };
}
