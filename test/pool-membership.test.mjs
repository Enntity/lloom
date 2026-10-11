// Pool membership: enrollment tokens, node leases and planner node shapes.
// Time is injected, so every lease transition is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolMembership, memberPlannerNode } from '../src/pool-membership.mjs';

function clock(start = Date.parse('2026-10-11T12:00:00Z')) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => {
    at += ms;
  };
  return now;
}

const inventory = {
  version: 1,
  complete: true,
  platformId: 'linux-arm64',
  accelerators: ['cuda', 'gb10'],
  computeArchs: ['sm_121'],
  memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 128 }],
  links: [{ peerNodeId: 'spark-node-02', localInterface: 'enp1s0f0np0' }],
  weights: [
    { recipeId: 'spark-27b', root: '/models', complete: true },
    { recipeId: 'partial', root: '/models', complete: false }
  ],
  backends: { commands: { docker: true }, dockerImages: ['vllm/vllm-openai@sha256:abc'] }
};

function enrolled(options = {}) {
  const now = clock();
  const membership = createPoolMembership({ leaseMs: 30000, now, ...options });
  const { token } = membership.issueEnrollmentToken({});
  const joined = membership.enroll({
    token,
    nodeId: 'spark-node-01',
    endpoint: 'http://10.0.0.1:8100',
    inventory,
    labels: { rack: 'a' }
  });
  return { now, membership, ...joined };
}

const member = (membership, id = 'spark-node-01') => membership.members().find((entry) => entry.id === id);

test('a token enrolls a node with a fresh lease and a secret only the node sees', () => {
  const { membership, nodeId, nodeSecret, leaseMs } = enrolled();
  assert.equal(nodeId, 'spark-node-01');
  assert.equal(leaseMs, 30000);
  assert.match(nodeSecret, /^lps_[A-Za-z0-9_-]{43}$/);
  const entry = member(membership);
  assert.equal(entry.state, 'ready');
  assert.equal(entry.endpoint, 'http://10.0.0.1:8100');
  assert.deepEqual(entry.labels, { rack: 'a' });
  assert.equal(entry.cordoned, false);
  assert.equal(entry.draining, false);
  assert.equal(entry.enrolledAt, '2026-10-11T12:00:00.000Z');
  assert.equal(entry.lastSeenAt, '2026-10-11T12:00:00.000Z');
  assert.equal(entry.leaseExpiresAt, '2026-10-11T12:00:30.000Z');
  assert.deepEqual(entry.inventory.computeArchs, ['sm_121']);
  assert.ok(!JSON.stringify(membership.members()).includes(nodeSecret));
});

test('the lease runs ready, suspect, lost; a heartbeat brings the node back', () => {
  const { now, membership, nodeSecret } = enrolled();
  now.advance(29999);
  assert.equal(member(membership).state, 'ready');
  now.advance(1);
  assert.equal(member(membership).state, 'suspect', 'lease expired, lostAfterMs not reached');
  now.advance(59999);
  assert.equal(member(membership).state, 'suspect');
  now.advance(1);
  assert.equal(member(membership).state, 'lost', 'lost 3 x leaseMs after the last heartbeat');

  const beat = membership.heartbeat({
    nodeId: 'spark-node-01',
    nodeSecret,
    running: ['qwen38-27b-nvfp4'],
    telemetry: { memory: { availableBytes: 1 } }
  });
  assert.deepEqual(beat, {
    ok: true,
    leaseExpiresAt: new Date(now() + 30000).toISOString(),
    cordoned: false,
    draining: false
  });
  const entry = member(membership);
  assert.equal(entry.state, 'ready');
  assert.deepEqual(entry.running, ['qwen38-27b-nvfp4']);
  assert.deepEqual(entry.inventory.computeArchs, ['sm_121'], 'a heartbeat without inventory keeps the last one');
});

test('lostAfterMs is configurable but never shorter than the lease', () => {
  const { now, membership } = enrolled({ lostAfterMs: 45000 });
  now.advance(44999);
  assert.equal(member(membership).state, 'suspect');
  now.advance(1);
  assert.equal(member(membership).state, 'lost');
  assert.throws(() => createPoolMembership({ leaseMs: 30000, lostAfterMs: 1000 }), /lostAfterMs/);
  assert.throws(() => createPoolMembership({ leaseMs: 0 }), /leaseMs/);
});

test('a bad secret, an unknown node and a malformed secret are all rejected the same way', () => {
  const { membership, nodeSecret } = enrolled();
  const rejected = (call) =>
    assert.throws(call, (error) => error.statusCode === 401 && error.code === 'invalid_node_credential');
  rejected(() => membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret: nodeSecret.slice(0, -1) + 'x' }));
  rejected(() => membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret: 'short' }));
  rejected(() => membership.heartbeat({ nodeId: 'spark-node-01' }));
  rejected(() => membership.heartbeat({ nodeId: 'other', nodeSecret }));
});

test('tokens expire and run out of uses', () => {
  const now = clock();
  const membership = createPoolMembership({ now });
  const rejected = (call) =>
    assert.throws(call, (error) => error.statusCode === 401 && error.code === 'invalid_enrollment_token');
  const single = membership.issueEnrollmentToken({ ttlMs: 60000 });
  assert.match(single.token, /^lpt_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.equal(single.expiresAt, '2026-10-11T12:01:00.000Z');
  membership.enroll({ token: single.token, nodeId: 'a', endpoint: 'http://a:8100' });
  rejected(() => membership.enroll({ token: single.token, nodeId: 'b', endpoint: 'http://b:8100' }));

  const twice = membership.issueEnrollmentToken({ uses: 2, ttlMs: 60000 });
  membership.enroll({ token: twice.token, nodeId: 'b', endpoint: 'http://b:8100' });
  membership.enroll({ token: twice.token, nodeId: 'c', endpoint: 'http://c:8100' });
  rejected(() => membership.enroll({ token: twice.token, nodeId: 'd', endpoint: 'http://d:8100' }));

  const expiring = membership.issueEnrollmentToken({ ttlMs: 60000 });
  now.advance(60000);
  rejected(() => membership.enroll({ token: expiring.token, nodeId: 'e', endpoint: 'http://e:8100' }));
  rejected(() =>
    membership.enroll({ token: 'lpt_000000000000_' + 'A'.repeat(43), nodeId: 'e', endpoint: 'http://e:8100' })
  );
  rejected(() => membership.enroll({ token: 'not-a-token', nodeId: 'e', endpoint: 'http://e:8100' }));
  rejected(() => membership.enroll({ nodeId: 'e', endpoint: 'http://e:8100' }));
  assert.deepEqual(
    membership.members().map((entry) => entry.id),
    ['a', 'b', 'c']
  );
});

test('token options and enrollment input are validated before a use is consumed', () => {
  const membership = createPoolMembership({ now: clock() });
  assert.throws(() => membership.issueEnrollmentToken({ ttlMs: 0 }), /ttlMs/);
  assert.throws(() => membership.issueEnrollmentToken({ uses: 1.5 }), /uses/);
  assert.throws(() => membership.issueEnrollmentToken({ labels: { bad: 1 } }), /labels/);
  const { token } = membership.issueEnrollmentToken({});
  const invalid = (input, pattern) =>
    assert.throws(
      () => membership.enroll({ token, endpoint: 'http://a:8100', nodeId: 'a', ...input }),
      (error) => error.statusCode === 400 && pattern.test(error.message)
    );
  invalid({ nodeId: '../etc' }, /node identity/);
  invalid({ nodeId: '' }, /node identity/);
  invalid({ endpoint: 'ftp://a' }, /HTTP\(S\)/);
  invalid({ endpoint: 'http://user:pass@a:8100' }, /HTTP\(S\)/);
  invalid({ endpoint: 'http://a:8100/?x=1' }, /HTTP\(S\)/);
  invalid({ endpoint: 'not a url' }, /endpoint/);
  invalid({ labels: { k: { nested: true } } }, /labels/);
  // The token is still unused after every rejected attempt.
  membership.enroll({ token, nodeId: 'a', endpoint: 'http://a:8100/' });
  assert.equal(member(membership, 'a').endpoint, 'http://a:8100');
});

test('token labels win over node-supplied labels', () => {
  const membership = createPoolMembership({ now: clock() });
  const { token } = membership.issueEnrollmentToken({ labels: { role: 'gpu' } });
  membership.enroll({ token, nodeId: 'a', endpoint: 'http://a:8100', labels: { role: 'head', zone: 'x' } });
  assert.deepEqual(member(membership, 'a').labels, { role: 'gpu', zone: 'x' });
});

test('re-enrolling needs a new token and rotates the secret', () => {
  const { membership, nodeSecret } = enrolled();
  const reuse = membership.issueEnrollmentToken({ uses: 3 });
  const first = membership.enroll({ token: reuse.token, nodeId: 'spark-node-02', endpoint: 'http://b:8100' });
  assert.throws(
    () => membership.enroll({ token: reuse.token, nodeId: 'spark-node-02', endpoint: 'http://b:8100' }),
    (error) => error.statusCode === 401 && error.code === 'invalid_enrollment_token',
    'the token that enrolled a node cannot re-enroll it'
  );
  membership.cordon('spark-node-01', { reason: 'maintenance' });
  const { token } = membership.issueEnrollmentToken({});
  const rotated = membership.enroll({ token, nodeId: 'spark-node-01', endpoint: 'http://10.0.0.9:8100' });
  assert.notEqual(rotated.nodeSecret, nodeSecret);
  assert.throws(() => membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret }), /credential/);
  assert.equal(membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret: rotated.nodeSecret }).cordoned, true);
  const entry = member(membership);
  assert.equal(entry.endpoint, 'http://10.0.0.9:8100');
  assert.equal(entry.cordoned, true, 'a node cannot re-enroll its way out of a cordon');
  assert.equal(entry.reason, 'maintenance');
  assert.equal(
    membership.heartbeat({ nodeId: 'spark-node-02', nodeSecret: first.nodeSecret }).ok,
    true,
    'other nodes keep their secrets'
  );
});

test('cordon, drain, uncordon and leave', () => {
  const { membership, nodeSecret } = enrolled();
  assert.equal(membership.cordon('spark-node-01', { reason: 'disk swap' }).cordoned, true);
  let beat = membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret });
  assert.equal(beat.cordoned, true);
  assert.equal(beat.draining, false);
  assert.equal(member(membership).reason, 'disk swap');

  const drained = membership.drain('spark-node-01', { reason: 'rebalance' });
  assert.equal(drained.draining, true);
  assert.equal(drained.reason, 'rebalance');
  beat = membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret });
  assert.equal(beat.draining, true);

  const cleared = membership.uncordon('spark-node-01');
  assert.equal(cleared.cordoned, false);
  assert.equal(cleared.draining, false);
  assert.equal(cleared.reason, null);

  const left = membership.leave('spark-node-01');
  assert.equal(left.state, 'left');
  assert.throws(() => membership.heartbeat({ nodeId: 'spark-node-01', nodeSecret }), /credential/);
  for (const action of ['cordon', 'uncordon', 'drain', 'leave']) {
    assert.throws(
      () => membership[action]('missing'),
      (error) => error.statusCode === 404
    );
  }
  assert.throws(() => membership.cordon('spark-node-01', { reason: 'x'.repeat(1000) }), /reason/);
});

test('planner nodes carry liveness, cordon and inventory in the planner shape', () => {
  const { now, membership } = enrolled();
  let [node] = membership.plannerNodes();
  assert.deepEqual(node, {
    id: 'spark-node-01',
    available: true,
    cordoned: false,
    membership: 'ready',
    platformId: 'linux-arm64',
    computeArchs: ['sm_121'],
    accelerators: ['cuda', 'gb10'],
    memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 128 }],
    links: ['spark-node-02'],
    weights: ['spark-27b'],
    images: ['vllm/vllm-openai@sha256:abc'],
    inventory: 'reported'
  });
  now.advance(30000);
  assert.equal(membership.plannerNodes()[0].available, true, 'a suspect node is still planned on');
  now.advance(60000);
  assert.equal(membership.plannerNodes()[0].available, false, 'lost');
  membership.drain('spark-node-01', {});
  [node] = membership.plannerNodes();
  assert.equal(node.cordoned, true, 'draining nodes take no new placements');
  membership.leave('spark-node-01');
  assert.equal(membership.plannerNodes()[0].available, false);
  assert.equal(memberPlannerNode({ id: 'bare', state: 'ready' }).inventory, 'none');
});

test('untrusted inventory is reduced to the fields the planner reads', () => {
  const membership = createPoolMembership({ now: clock() });
  const { token } = membership.issueEnrollmentToken({});
  membership.enroll({
    token,
    nodeId: 'a',
    endpoint: 'http://a:8100',
    inventory: {
      complete: 'yes',
      computeArchs: ['sm_121', 7, { x: 1 }],
      memoryDomains: [{ id: 'm', kind: 'unified', capacityGb: 'lots' }, { id: 'n', capacityGb: 64 }, 'bad'],
      links: ['b', { peerNodeId: 'c' }, { nope: true }],
      weights: 'all',
      secret: 'do not keep',
      backends: { dockerImages: [1, 'img'], commands: { docker: 'true', uv: true } }
    }
  });
  const { inventory: stored } = member(membership, 'a');
  assert.deepEqual(stored, {
    complete: false,
    computeArchs: ['sm_121'],
    memoryDomains: [{ id: 'n', capacityGb: 64 }],
    links: [{ peerNodeId: 'b' }, { peerNodeId: 'c' }],
    weights: [],
    backends: { commands: { uv: true }, dockerImages: ['img'] }
  });
  assert.throws(
    () => membership.heartbeat({ nodeId: 'a', nodeSecret: 'x', running: 'nope' }),
    /credential/,
    'authentication comes before input validation'
  );
});

test('persisted state has hashes but no secrets or tokens, and restores', () => {
  const now = clock();
  const membership = createPoolMembership({ now });
  const pending = membership.issueEnrollmentToken({ uses: 2, labels: { role: 'gpu' } });
  const { nodeSecret } = membership.enroll({ token: pending.token, nodeId: 'a', endpoint: 'http://a:8100', inventory });
  membership.cordon('a', { reason: 'test' });
  membership.heartbeat({ nodeId: 'a', nodeSecret, telemetry: { load: 1 } });
  const state = JSON.parse(JSON.stringify(membership.toJSON()));
  const text = JSON.stringify(state);
  assert.ok(!text.includes(nodeSecret));
  assert.ok(!text.includes(pending.token));
  assert.ok(!text.includes(nodeSecret.slice(4)), 'not even the secret body');
  assert.ok(!text.includes(pending.token.split('_').at(-1)));
  assert.ok(!text.includes('"load"'), 'telemetry is live state only');
  assert.equal(state.version, 1);

  const restored = createPoolMembership({ now, state });
  assert.deepEqual(
    restored.members().map(({ telemetry: _telemetry, ...entry }) => entry),
    membership.members().map(({ telemetry: _telemetry, ...entry }) => entry)
  );
  assert.equal(restored.heartbeat({ nodeId: 'a', nodeSecret }).cordoned, true, 'the restored secret hash verifies');
  restored.enroll({ token: pending.token, nodeId: 'b', endpoint: 'http://b:8100' });
  assert.throws(() => restored.enroll({ token: pending.token, nodeId: 'c', endpoint: 'http://c:8100' }), /token/);

  now.advance(3600000);
  assert.deepEqual(restored.toJSON().tokens, [], 'spent and expired tokens are pruned');
  assert.throws(() => createPoolMembership({ state: { version: 99 } }), /version/);
});
