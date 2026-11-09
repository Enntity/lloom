import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { RuntimeManager } from '../src/runtime-manager.mjs';

// A managed OpenAI-compatible runtime whose catalog health is up but whose model
// warmup fails (HTTP 409) — the case where an incompatible weight layout makes
// the catalog endpoint healthy before model loading succeeds.
function createServer({ catalogOk, warmupStatus }) {
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('/v1/models')) {
      response.writeHead(catalogOk ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mtp-model' }] }));
    } else {
      response.writeHead(warmupStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'incompatible optional MTP weight layout' }));
    }
  });
  return server;
}

function managerFor(server, port, { warmup = true } = {}) {
  return new RuntimeManager({
    runtimes: {
      'mtp-runtime': {
        management: 'managed',
        enabled: true,
        port,
        healthUrl: `http://127.0.0.1:${port}/v1/models`,
        healthModel: 'mtp-model',
        ...(warmup ? { warmup: { url: `http://127.0.0.1:${port}/v1/chat/completions`, method: 'POST' } } : {})
      }
    }
  });
}

test('a failed explicit warmup is not flattened to healthy on an already-healthy catalog', async () => {
  const server = createServer({ catalogOk: true, warmupStatus: 409 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manager = managerFor(server, port);
  try {
    const result = await manager.start('mtp-runtime', { warmup: true });
    assert.equal(result.started, false);
    assert.equal(result.healthy, false, 'a failed warmup must not report the model as admitted');
    assert.equal(result.reason, 'warmup-failed');
    assert.equal(result.warmup.warmed, false);
    assert.equal(result.warmup.status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a successful warmup on an already-healthy catalog stays healthy', async () => {
  const server = createServer({ catalogOk: true, warmupStatus: 200 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manager = managerFor(server, port);
  try {
    const result = await manager.start('mtp-runtime', { warmup: true });
    assert.equal(result.healthy, true);
    assert.equal(result.reason, 'already-healthy');
    assert.equal(result.warmup.warmed, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a runtime without a configured warmup is read from catalog health alone', async () => {
  const server = createServer({ catalogOk: true, warmupStatus: 409 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manager = managerFor(server, port, { warmup: false });
  try {
    const result = await manager.start('mtp-runtime', { warmup: true });
    assert.equal(result.healthy, true, 'no-warmup is not a readiness failure');
    assert.equal(result.reason, 'already-healthy');
    assert.equal(result.warmup.reason, 'no-warmup');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
