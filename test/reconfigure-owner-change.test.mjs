import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';
import { RuntimeManager } from '../src/runtime-manager.mjs';

// Issue #139 sub-problem 4: a config reload that moves distributed leadership
// to the local node must not fail because the previous config still denies
// control of the runtime (and its members) to this node.

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('reload may take leadership of a distributed runtime from another node', async () => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const backendUrl = await listen(backend);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-reload-owner-'));

  const memberRuntime = (node) => ({
    management: 'managed',
    healthUrl: `${backendUrl}/health`,
    port: 0,
    placement: { node }
  });
  const clusterRuntime = {
    keepWarm: true,
    enabled: true,
    healthUrl: `${backendUrl}/health`,
    placement: {
      mode: 'distributed',
      leaderNode: 'b',
      members: [
        { runtime: 'gl-worker', node: 'a', role: 'worker', order: 1 },
        { runtime: 'gl-head', node: 'b', role: 'head', order: 2 }
      ]
    }
  };
  const nodes = () => ({
    a: { endpoint: 'http://127.0.0.1:1', labels: { role: 'worker' } },
    b: { endpoint: 'http://127.0.0.1:2', labels: { role: 'node' } }
  });
  const previousConfig = {
    server: { host: '127.0.0.1', port: 0 },
    models: [],
    backends: {},
    aliases: {},
    cluster: { nodeId: 'a', leaderNode: 'b', nodes: nodes() },
    runtimes: { 'gl-worker': memberRuntime('a'), 'gl-head': memberRuntime('b'), 'gl-cluster': { ...clusterRuntime } }
  };
  const nextConfig = structuredClone(previousConfig);
  nextConfig.cluster.leaderNode = 'a';
  nextConfig.runtimes['gl-cluster'].placement.leaderNode = 'a';
  nextConfig.runtimes['gl-cluster'].keepWarm = false;
  // Disable the cluster in the new config so the reload reconciles (drain +
  // stop) without re-admitting it; the takeover path is what we exercise.
  nextConfig.runtimes['gl-cluster'].enabled = false;
  // A lifecycle difference is what makes the reload reconcile the runtime.
  nextConfig.runtimes['gl-worker'].healthUrl = `${backendUrl}/health?v=2`;

  const manager = new RuntimeManager(previousConfig, {
    logger: { error() {}, warn() {}, info() {} },
    stateFile: path.join(dir, 'state.json')
  });

  const result = await manager.reconfigure(nextConfig, { drainTimeoutMs: 5000 });
  assert.ok(Array.isArray(result.changed));
  assert.ok(result.changed.includes('gl-cluster'));
  assert.ok(result.changed.includes('gl-worker'));
  const clusterResult = result.results.find((entry) => entry.runtimeId === 'gl-cluster');
  assert.ok(clusterResult, 'cluster reload recorded a result');
  assert.equal(clusterResult.started, false);
  assert.equal(clusterResult.reason, 'runtime-disabled');

  backend.close();
  await fs.rm(dir, { recursive: true, force: true });
});
