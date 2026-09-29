import { test } from 'node:test';
import { normalizeProfileDocument, composeProfile } from '../src/config-profiles.mjs';
import assert from 'node:assert/strict';
import {
  planHeadPromotion,
  stableStringify,
  STANDALONE_PROFILE,
  PROMOTED_ROUTE,
  LOCAL_ROUTE
} from '../src/head-promotion.mjs';

// --- Synthetic fixtures ---------------------------------------------------
// All ids, keys and URLs are invented; nothing here touches a live host.

const SOURCE_NODE = 'spark-src';
const SOURCE_URL = 'http://spark-src.internal:8100';
const SOURCE_KEY = 'sk-src-inference-0000';
const DEST_KEY = 'sk-dest-keep-me-1111';

// Destination: the already-prepared media node. It already holds a copy of the
// shared cloud model maps and its own local media runtime/backends.
function destinationConfig() {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    security: { apiKeys: [DEST_KEY] },
    defaults: { chatModel: 'media-chat', imageModel: 'media-image' },
    backends: {
      'media-rt': { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1', apiKey: 'sk-media-local' },
      openrouter: { type: 'openai', baseUrl: 'https://openrouter.invalid/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }
    },
    models: [
      { id: 'media-chat', backend: 'media-rt', runtime: 'media-rt', upstreamModel: 'media-chat', kind: 'chat' },
      { id: 'media-image', backend: 'media-rt', runtime: 'media-rt', upstreamModel: 'flux', kind: 'image' },
      { id: 'moonshot/kimi-k2', backend: 'openrouter', upstreamModel: 'moonshot/kimi-k2', kind: 'chat' }
    ],
    runtimes: { 'media-rt': { command: 'serve-media', port: 8201, keepWarm: true } },
    aliases: {
      'media-default': { members: ['media-chat'] },
      shared: { members: ['media-chat'] }
    },
    profiles: {
      media: {
        defaults: { chatModel: 'media-chat' },
        routes: { shared: 'media-chat' },
        residency: { 'media-rt': 'always' }
      }
    },
    cluster: {
      nodeId: 'media-node',
      leaderNode: 'media-node',
      nodes: { 'media-node': { endpoint: 'http://127.0.0.1:8100', local: true } }
    }
  };
}

// Source owner (e.g. Spark) with a TP2 distributed runtime whose models are the
// ones being federated. It owns its own leader and its own namespaced aliases.
function sourceConfig() {
  return {
    security: { apiKeys: ['sk-src-other-2222'] },
    defaults: { chatModel: `${SOURCE_NODE}/kimi`, imageModel: `${SOURCE_NODE}/media-image` },
    backends: {
      openrouter: { type: 'openai', baseUrl: 'https://openrouter.invalid/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
      'tp2-rt': { type: 'openai', baseUrl: 'http://127.0.0.1:8301/v1', apiKey: 'sk-tp2' }
    },
    models: [
      {
        id: 'kimi',
        name: 'Kimi',
        backend: 'tp2-rt',
        runtime: 'tp2-rt',
        upstreamModel: 'moonshot/kimi-k2',
        kind: 'chat'
      },
      { id: 'media-image', name: 'Image', backend: 'tp2-rt', runtime: 'tp2-rt', upstreamModel: 'flux', kind: 'image' },
      { id: 'dangling-model', name: 'Dangling', backend: 'tp2-rt', runtime: 'tp2-rt', kind: 'chat' }
    ],
    runtimes: {
      'tp2-rt': {
        command: 'serve-tp2',
        port: 8301,
        keepWarm: true,
        placement: {
          mode: 'distributed',
          members: [
            { runtime: 'tp2-a', node: SOURCE_NODE },
            { runtime: 'tp2-b', node: SOURCE_NODE }
          ]
        }
      },
      'tp2-a': { command: 'serve-a', node: SOURCE_NODE },
      'tp2-b': { command: 'serve-b', node: SOURCE_NODE }
    },
    aliases: {
      kimi: { members: [`${SOURCE_NODE}/kimi`] },
      image: { members: [`${SOURCE_NODE}/media-image`] },
      dangling: { members: ['does-not-exist'] }
    },
    profiles: {
      spark: {
        defaults: { chatModel: `${SOURCE_NODE}/kimi` },
        routes: {
          kimi: `${SOURCE_NODE}/kimi`,
          image: `${SOURCE_NODE}/media-image`
        },
        residency: { 'tp2-rt': 'always' }
      }
    },
    fleet: { activeProfile: 'spark' },
    cluster: {
      nodeId: SOURCE_NODE,
      leaderNode: SOURCE_NODE,
      nodes: { [SOURCE_NODE]: { endpoint: SOURCE_URL } }
    }
  };
}

function plan(dest = destinationConfig(), src = sourceConfig(), options = {}) {
  return planHeadPromotion(dest, src, {
    sourceNode: SOURCE_NODE,
    sourceUrl: SOURCE_URL,
    sourceInferenceKey: SOURCE_KEY,
    ...options
  });
}

function assertNoSecrets(summary) {
  const text = JSON.stringify(summary);
  assert.equal(text.includes(SOURCE_KEY), false, 'summary leaked the source inference key');
  assert.equal(text.includes(DEST_KEY), false, 'summary leaked a destination key');
  assert.equal(text.includes('sk-tp2'), false, 'summary leaked a backend key');
  return text;
}

// --- Tests ----------------------------------------------------------------

test('preserves destination runtimes, paths, local models and security keys', () => {
  const dest = destinationConfig();
  const snapshot = structuredClone(dest);
  const result = plan(dest);

  assert.deepEqual(dest, snapshot, 'destination input must not be mutated');
  assert.equal(result.summary.ok, true);

  const next = result.next;
  assert.deepEqual(next.runtimes, dest.runtimes, 'destination runtimes preserved');
  assert.deepEqual(next.server, dest.server, 'listener preserved');
  assert.deepEqual(next.security.apiKeys, [DEST_KEY, SOURCE_KEY], 'destination key kept, source key appended');
  assert.equal(next.models.find((model) => model.id === 'media-chat').backend, 'media-rt');
  assert.equal(next.models.find((model) => model.id === 'media-image').runtime, 'media-rt');
  assert.equal(next.backends['media-rt'].baseUrl, 'http://127.0.0.1:8201/v1');
  assert.deepEqual(result.profiles.media.residency, { 'media-rt': 'always' });
  assert.equal('profiles' in next, false, 'profiles live in the returned profile map, not the config');
});

test('federates source distributed runtime models and never copies runtime authority', () => {
  const result = plan();
  const next = result.next;

  // `media-image` collides with a local destination id, so it stays local.
  assert.deepEqual(result.summary.federated.modelIds.sort(), ['dangling-model', 'kimi']);
  const node = next.cluster.nodes[SOURCE_NODE];
  assert.equal(node.endpoint, SOURCE_URL);
  assert.equal(node.apiKey, SOURCE_KEY, 'inline node credential for parent integration');
  const proxyModels = node.proxy.models;
  const kimi = proxyModels.find((entry) => entry.id === 'kimi');
  assert.deepEqual(kimi, {
    id: 'kimi',
    as: 'kimi',
    kind: 'chat',
    remoteRuntime: 'tp2-rt',
    upstreamModel: 'kimi',
    name: 'Kimi'
  });
  assert.equal(
    proxyModels.some((entry) => entry.id === 'media-image'),
    false
  );
  const backendId = `lloom-node-${SOURCE_NODE}`;
  assert.equal(next.backends[backendId].apiKey, SOURCE_KEY, 'inline backend credential');
  assert.equal(next.backends[backendId].baseUrl, `${SOURCE_URL}/v1`);

  // No physical runtimes or raw runtime backends copied; TP owner stays on the source.
  assert.deepEqual(next.runtimes, destinationConfig().runtimes);
  assert.equal(next.runtimes['tp2-rt'], undefined);
  assert.equal(next.backends['tp2-rt'], undefined);
  assert.equal(result.summary.fleet.sourceLeaderNode, SOURCE_NODE);
  assert.deepEqual(result.summary.runtimePolicyRetainedOnSource, ['tp2-a', 'tp2-b', 'tp2-rt']);
  assert.equal(result.summary.sourceUnchanged, true);
});

test('remaps namespaced local ids onto bare destination ids and keeps compat aliases', () => {
  const result = plan();
  const next = result.next;

  // `media-image` exists locally -> the bare local model wins, none federated.
  assert.equal(
    next.models.some((model) => model.id === 'media-image' && model.backend === 'media-rt'),
    true
  );
  assert.deepEqual(next.aliases.image, { members: ['media-image'] });
  // `kimi` does not exist locally -> federated under its own name.
  assert.deepEqual(next.aliases.kimi, { members: ['kimi'] });
  assert.deepEqual(result.summary.aliases.imported.sort(), ['image', 'kimi']);
});

test('skips aliases and defaults with unresolved dependencies', () => {
  const result = plan();
  const aliasSkips = result.summary.aliases.skipped;
  assert.ok(aliasSkips.some((entry) => entry.id === 'dangling' && /unresolved/.test(entry.reason)));
  assert.equal(result.next.aliases.dangling, undefined);
  // Defaults still resolve because both source defaults map onto local catalogs.
  assert.deepEqual(result.summary.defaults.applied, { chatModel: 'kimi' });
  assert.deepEqual(result.next.defaults, { chatModel: 'kimi', imageModel: 'media-image' });
});

test('composes conflicting local aliases and lets the standalone profile restore them', () => {
  const dest = destinationConfig();
  dest.aliases.shared = { members: ['media-chat'] }; // conflicts with source alias member set
  const src = sourceConfig();
  src.aliases.shared = { members: ['kimi'] };
  const result = plan(dest, src);
  const composed = result.next.aliases.shared;

  assert.equal(composed.activeRoute, PROMOTED_ROUTE);
  assert.deepEqual(composed.members, ['kimi']);
  assert.deepEqual(composed.routeProfiles[LOCAL_ROUTE], { members: ['media-chat'] });
  assert.deepEqual(composed.routeProfiles[PROMOTED_ROUTE], { members: ['kimi'] });

  // Standalone snapshot holds the original local semantics for round-trip.
  const standalone = result.profiles[STANDALONE_PROFILE];
  assert.equal(standalone.routes.shared, LOCAL_ROUTE);
  assert.deepEqual(standalone.defaults, dest.defaults);
  assert.deepEqual(standalone.residency, { 'media-rt': 'always' });
});

test('standalone applies local routing through the canonical composer', () => {
  const dest = destinationConfig();
  const src = sourceConfig();
  src.aliases.shared = { members: ['kimi'] };
  const result = plan(dest, src);
  const doc = normalizeProfileDocument(result.profiles.standalone, 'standalone');
  const restored = composeProfile(structuredClone(result.next), doc, 'standalone');
  assert.deepEqual(restored.defaults, dest.defaults);
  assert.deepEqual(restored.aliases.shared.members, ['media-chat']);
  assert.equal(restored.runtimes['media-rt'].keepWarm, true);
});

test('migrates source profile routes but keeps destination local residency', () => {
  const dest = destinationConfig();
  dest.profiles.spark = { defaults: { chatModel: 'media-chat' }, residency: { 'media-rt': 'preferred' } };
  const result = plan(dest);

  assert.deepEqual(result.summary.profiles.migrated, ['spark']);
  const spark = result.profiles.spark;
  assert.equal(spark.routes.kimi, 'kimi');
  assert.equal(spark.routes.image, 'media-image');
  assert.deepEqual(spark.defaults, { chatModel: 'kimi' });
  // Destination's same-name local residency wins; the foreign `tp2-rt` entry is not copied.
  assert.deepEqual(spark.residency, { 'media-rt': 'preferred' });
  assert.equal(JSON.stringify(result.profiles).includes('tp2-rt'), false);
});

test('preserves other destination profiles and records active profile', () => {
  const dest = destinationConfig();
  const result = plan(dest);
  assert.deepEqual(result.profiles.media, normalizeProfileDocument(dest.profiles.media, 'media'));
  assert.ok(result.summary.profiles.preserved.includes('media'));
  assert.equal(result.summary.profiles.activeProfile, 'spark');
  assert.equal(result.next.fleet.activeProfile, 'spark');
});

test('makes destination the fleet head/leader and leaves source leader untouched', () => {
  const result = plan();
  assert.equal(result.next.cluster.fleetHeadNode, 'media-node');
  assert.equal(result.next.cluster.leaderNode, 'media-node');
  assert.equal(result.next.cluster.nodeId, 'media-node');
  assert.equal(result.summary.fleet.sourceLeaderNode, SOURCE_NODE);
});

test('repeat planning is idempotent and does not regenerate the standalone snapshot', () => {
  const first = plan();
  assert.equal(first.summary.changed, true);

  const second = planHeadPromotion(first.next, sourceConfig(), {
    sourceNode: SOURCE_NODE,
    sourceUrl: SOURCE_URL,
    sourceInferenceKey: SOURCE_KEY,
    destinationProfiles: first.profiles
  });
  assert.equal(second.summary.ok, true);
  assert.equal(second.summary.changed, false);
  assert.equal(second.summary.profiles.standalone, 'retained');
  assert.deepEqual(second.profiles[STANDALONE_PROFILE], first.profiles[STANDALONE_PROFILE]);
  assert.deepEqual(second.next.fleet.headPromotion.origin, {
    sourceNode: SOURCE_NODE,
    headNode: 'media-node',
    standaloneProfile: STANDALONE_PROFILE
  });
  assert.equal(second.summary.federation.modelsAdded, 0);
  assert.equal(second.summary.federation.backendAdded, 0);
});

test('summary is secret-free and omits full model/profile bodies', () => {
  const text = assertNoSecrets(plan().summary);
  assert.equal(text.includes('serve-tp2'), false, 'no commands');
  assert.equal(text.includes('openrouter.invalid'), false, 'no backend URLs');
});

test('rejects a mismatched pre-existing proxy or backend definition', () => {
  const backendId = `lloom-node-${SOURCE_NODE}`;
  const dest = destinationConfig();
  dest.cluster.nodes[SOURCE_NODE] = {
    endpoint: 'http://other-host:8100',
    proxy: { enabled: true, models: [{ id: 'kimi' }] }
  };
  const result = plan(dest);
  assert.equal(result.summary.ok, false);
  assert.ok(result.summary.conflicts.some((c) => c.type === 'cluster-node'));
  assert.deepEqual(result.next, dest, 'conflict returns the destination unchanged');
});

test('rejects a pre-existing backend id that differs from the federated proxy backend', () => {
  const backendId = `lloom-node-${SOURCE_NODE}`;
  const dest = destinationConfig();
  dest.backends[backendId] = { type: 'openai', baseUrl: 'http://elsewhere:9999/v1' };
  const result = plan(dest);
  assert.equal(result.summary.ok, false);
  assert.ok(result.summary.conflicts.some((c) => c.type === 'backend' && c.id === backendId));
});

test('refuses to overwrite a non-snapshot standalone profile', () => {
  const dest = destinationConfig();
  dest.profiles[STANDALONE_PROFILE] = { defaults: { chatModel: 'media-chat' } };
  const result = plan(dest);
  assert.equal(result.summary.ok, false);
  assert.equal(result.summary.profiles.standalone, 'conflict');
  assert.ok(result.summary.conflicts.some((c) => c.type === 'profile' && c.id === STANDALONE_PROFILE));
});

test('rejects promoting a destination that owns distributed runtimes', () => {
  const dest = destinationConfig();
  dest.runtimes = {
    ...dest.runtimes,
    'media-tp': {
      command: 'serve',
      placement: { mode: 'distributed', members: [{ runtime: 'media-rt', node: 'media-node' }] }
    }
  };
  const result = plan(dest);
  assert.equal(result.summary.ok, false);
  assert.ok(result.summary.conflicts.some((c) => c.type === 'cluster' && c.id === 'distributed-runtimes'));
});

test('rejects a source node equal to the destination node id', () => {
  const result = planHeadPromotion(destinationConfig(), sourceConfig(), {
    sourceNode: 'media-node',
    sourceUrl: SOURCE_URL,
    sourceInferenceKey: SOURCE_KEY
  });
  assert.equal(result.summary.ok, false);
  assert.ok(result.summary.conflicts.some((c) => c.type === 'cluster' && c.id === 'sourceNode'));
});

test('never mutates the source config', () => {
  const src = sourceConfig();
  const snapshot = structuredClone(src);
  plan(destinationConfig(), src);
  assert.deepEqual(src, snapshot, 'source config must be untouched');
});

test('does not add a duplicate federated model that collides with a local id', () => {
  const src = sourceConfig();
  src.models.push({ id: 'media-chat', backend: 'tp2-rt', runtime: 'tp2-rt', kind: 'chat' });
  const result = plan(destinationConfig(), src);
  assert.equal(result.summary.federated.modelIds.includes('media-chat'), false);
  assert.ok(result.summary.skipped.some((s) => s.type === 'model' && s.id === 'media-chat'));
});

test('stableStringify is canonical regardless of key order', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test('unresolved source aliases cannot resolve through a conflicting destination alias', () => {
  const dest = destinationConfig(),
    src = sourceConfig();
  src.aliases.shared = { members: ['missing'] };
  src.aliases.dependent = { members: ['shared'] };
  src.defaults.chatModel = 'dependent';
  const result = plan(dest, src);
  assert.equal(result.next.aliases.dependent, undefined);
  assert.ok(result.summary.defaults.skipped.some((x) => x.kind === 'chatModel'));
});
test('retired alternate routes do not remove a valid current alias', () => {
  const src = sourceConfig();
  src.aliases.remote = {
    members: ['kimi'],
    routeProfiles: { retired: { members: ['gone'] }, valid: { members: ['kimi'] } }
  };
  const result = plan(destinationConfig(), src);
  assert.deepEqual(result.next.aliases.remote.members, ['kimi']);
  assert.equal(result.next.aliases.remote.routeProfiles.retired, undefined);
  assert.ok(result.summary.skipped.some((x) => x.type === 'route-profile'));
});
test('target-owned gateway IDs follow explicit served-model metadata', () => {
  const src = sourceConfig();
  src.models.push({
    id: 'media-node/old-image',
    federated: true,
    targets: [{ node: 'media-node', servedModel: 'media-image' }]
  });
  src.aliases.photo = { members: ['media-node/old-image'] };
  const result = plan(destinationConfig(), src);
  assert.deepEqual(result.next.aliases.photo.members, ['media-image']);
  assert.deepEqual(result.next.aliases['media-node/old-image'].members, ['media-image']);
});
