import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCAL_ROUTE, PROMOTED_ROUTE, STANDALONE_PROFILE, planHeadPromotion } from '../src/head-promotion.mjs';
import { composeProfile, normalizeProfileDocument } from '../src/config-profiles.mjs';

const DESTINATION_NODE = 'media';
const SOURCE_NODE = 'spark-src';
const SOURCE_URL = 'http://spark-src.internal:8100';
const SOURCE_KEY = 'synthetic-source-inference-key';

function destinationConfig() {
  return {
    server: { host: '127.0.0.1', port: 8100 },
    security: { apiKeys: ['synthetic-destination-key'] },
    defaults: { chatModel: 'local-chat' },
    backends: {
      local: { type: 'openai', baseUrl: 'http://127.0.0.1:8201/v1' }
    },
    models: [{ id: 'local-chat', backend: 'local', runtime: 'local-rt', kind: 'chat' }],
    runtimes: {
      'local-rt': { command: 'serve-local', port: 8201, keepWarm: true }
    },
    aliases: {
      local: { members: ['local-chat'] }
    },
    profiles: {
      local: {
        routes: { local: 'local-chat' },
        defaults: { chatModel: 'local-chat' },
        residency: { 'local-rt': 'always' }
      }
    },
    cluster: {
      nodeId: DESTINATION_NODE,
      leaderNode: DESTINATION_NODE,
      nodes: {
        [DESTINATION_NODE]: {
          endpoint: 'http://127.0.0.1:8100',
          local: true
        }
      }
    }
  };
}

function sourceConfig({
  models = [
    {
      id: 'remote-chat',
      backend: 'tp2-rt',
      runtime: 'tp2-rt',
      upstreamModel: 'remote-chat-upstream',
      kind: 'chat'
    }
  ],
  aliases = {},
  profiles = {},
  fleet = {},
  defaults = {},
  nodes = {}
} = {}) {
  return {
    defaults,
    backends: {
      'tp2-rt': {
        type: 'openai',
        baseUrl: 'http://127.0.0.1:8301/v1',
        apiKey: 'private-source-backend-key'
      }
    },
    models,
    runtimes: {
      'tp2-rt': { command: 'serve-tp2', port: 8301, keepWarm: true }
    },
    aliases,
    profiles,
    fleet,
    cluster: {
      nodeId: SOURCE_NODE,
      leaderNode: SOURCE_NODE,
      nodes: {
        [SOURCE_NODE]: { endpoint: SOURCE_URL },
        ...nodes
      }
    }
  };
}

function plan(destination = destinationConfig(), source = sourceConfig(), options = {}) {
  return planHeadPromotion(destination, source, {
    sourceNode: SOURCE_NODE,
    sourceUrl: SOURCE_URL,
    sourceInferenceKey: SOURCE_KEY,
    ...options
  });
}

test('migrates canonical string routes and composes them with real fleet-profile semantics', () => {
  const source = sourceConfig({
    aliases: {
      remote: {
        members: ['remote-chat'],
        activeRoute: 'cloud',
        routeProfiles: {
          cloud: { members: ['remote-chat'] },
          backup: { members: ['remote-chat'] }
        }
      }
    },
    profiles: {
      cloud: {
        routes: { remote: 'cloud' },
        defaults: { chatModel: 'remote-chat' },
        residency: { 'tp2-rt': 'always' }
      }
    },
    fleet: { activeProfile: 'cloud' }
  });

  const result = plan(destinationConfig(), source);
  assert.equal(result.summary.ok, true);
  assert.ok(result.summary.profiles.migrated.includes('cloud'));

  const cloud = normalizeProfileDocument(result.profiles.cloud, 'cloud');
  assert.deepEqual(cloud.routes, { remote: 'cloud' });
  assert.deepEqual(cloud.defaults, { chatModel: 'remote-chat' });
  assert.deepEqual(cloud.residency, {}, 'foreign runtime residency must not migrate');

  const composed = composeProfile(structuredClone(result.next), cloud, 'cloud');
  assert.equal(composed.fleet.activeProfile, 'cloud');
  assert.equal(composed.aliases.remote.activeRoute, 'cloud');
  assert.deepEqual(composed.aliases.remote.members, ['remote-chat']);
});

test('standalone snapshot restores original aliases, defaults, and local residency', () => {
  const destination = destinationConfig();
  destination.defaults = { chatModel: 'local-chat' };
  destination.aliases = {
    local: { members: ['local-chat'] },
    shared: { members: ['local-chat'] },
    direct: 'local-chat'
  };
  const source = sourceConfig({
    defaults: { chatModel: 'remote-chat' },
    aliases: {
      shared: { members: ['remote-chat'] }
    }
  });

  const result = plan(destination, source);
  assert.equal(result.summary.ok, true);
  const standalone = normalizeProfileDocument(result.profiles[STANDALONE_PROFILE], STANDALONE_PROFILE);
  assert.equal(standalone.routes.shared, LOCAL_ROUTE);
  assert.ok(Object.values(standalone.routes).every((target) => typeof target === 'string'));
  assert.deepEqual(standalone.defaults, { chatModel: 'local-chat' });
  assert.deepEqual(standalone.residency, { 'local-rt': 'always' });

  const restored = structuredClone(result.next);
  restored.runtimes['local-rt'].keepWarm = false;
  restored.runtimes['local-rt'].preferredWarm = false;
  const composed = composeProfile(restored, standalone, STANDALONE_PROFILE);
  assert.equal(composed.fleet.activeProfile, STANDALONE_PROFILE);
  assert.deepEqual(composed.defaults, { chatModel: 'local-chat' });
  assert.deepEqual(composed.aliases.shared.members, ['local-chat']);
  assert.equal(composed.aliases.shared.activeRoute, LOCAL_ROUTE);
  assert.equal(restored.runtimes['local-rt'].keepWarm, true);
});

test('rejects a source alias cycle masked by a destination alias', () => {
  const destination = destinationConfig();
  destination.aliases.a = { members: ['local-chat'] };
  const source = sourceConfig({
    aliases: {
      a: { members: ['b'] },
      b: { members: ['a'] }
    }
  });

  const result = plan(destination, source);
  assert.equal(result.summary.ok, false, 'a masked source cycle must fail closed');
  assert.ok(
    result.summary.conflicts.some((conflict) => conflict.type === 'alias' && /cycle|dependency/i.test(conflict.reason))
  );
  assert.deepEqual(result.next, destination, 'a rejected plan must not return a cyclic candidate');
});

test('preserves source route profiles when composing a conflicting alias', () => {
  const destination = destinationConfig();
  destination.aliases.shared = { members: ['local-chat'] };
  const source = sourceConfig({
    models: [
      {
        id: 'remote-chat',
        backend: 'tp2-rt',
        runtime: 'tp2-rt',
        kind: 'chat'
      },
      {
        id: 'remote-fallback',
        backend: 'tp2-rt',
        runtime: 'tp2-rt',
        kind: 'chat'
      }
    ],
    aliases: {
      shared: {
        members: ['remote-chat'],
        activeRoute: 'cloud',
        routeProfiles: {
          cloud: { members: ['remote-chat'] },
          fallback: { members: ['remote-fallback'] }
        }
      }
    }
  });

  const result = plan(destination, source);
  assert.equal(result.summary.ok, true);
  const routes = result.next.aliases.shared.routeProfiles;
  assert.deepEqual(routes.cloud, { members: ['remote-chat'] });
  assert.deepEqual(routes.fallback, { members: ['remote-fallback'] });
  assert.deepEqual(routes[PROMOTED_ROUTE], { members: ['remote-chat'] });
  assert.deepEqual(routes[LOCAL_ROUTE], { members: ['local-chat'] });
});

test('remaps only target-owned prefixes', () => {
  const destination = destinationConfig();
  destination.models.push({
    id: 'chat',
    backend: 'local',
    runtime: 'local-rt',
    kind: 'chat'
  });
  const source = sourceConfig({
    aliases: {
      targetOwned: { members: [`${DESTINATION_NODE}/chat`] },
      foreignNode: { members: ['spark-worker/chat'] }
    },
    nodes: {
      'spark-worker': { endpoint: 'http://spark-worker.internal:8100' }
    }
  });

  const result = plan(destination, source);
  assert.deepEqual(result.next.aliases.targetOwned, { members: ['chat'] });
  assert.equal(result.next.aliases.foreignNode, undefined);
  assert.ok(result.summary.aliases.skipped.some((entry) => entry.id === 'foreignNode'));
});

test('deduplicates members that collapse onto one local model during remapping', () => {
  const destination = destinationConfig();
  destination.models.push({
    id: 'chat',
    backend: 'local',
    runtime: 'local-rt',
    kind: 'chat'
  });
  const source = sourceConfig({
    models: [
      {
        id: 'chat',
        backend: 'tp2-rt',
        runtime: 'tp2-rt',
        kind: 'chat'
      }
    ],
    aliases: {
      duplicateAfterMapping: {
        members: [`${DESTINATION_NODE}/chat`, `${SOURCE_NODE}/chat`]
      }
    }
  });

  const result = plan(destination, source);
  assert.equal(result.summary.ok, true);
  assert.deepEqual(result.next.aliases.duplicateAfterMapping, { members: ['chat'] });
});

test('does not activate a profile that was not transferred or retained', () => {
  const destination = destinationConfig();
  const source = sourceConfig({ fleet: { activeProfile: 'missing-profile' } });
  const result = plan(destination, source, { sourceProfiles: {} });

  assert.equal(result.summary.ok, false);
  assert.ok(
    result.summary.conflicts.some((conflict) => conflict.type === 'profile' && conflict.id === 'activeProfile')
  );
  assert.deepEqual(result.next, destination);
});
