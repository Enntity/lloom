import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMetricsPersistence, createMetricsStore } from '../src/server.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'lloom-metrics-'));
const metricsPath = path.join(root, 'metrics-history.json');
const config = { logging: { metricsPersistence: true, metricsPath } };
const logger = { error() {} };

try {
  const persistence = createMetricsPersistence(config, { logger });
  const metrics = createMetricsStore({ initialSnapshot: persistence.loadSnapshot() });
  metrics.record({
    id: 'conn_1',
    route: '/v1/chat/completions',
    model: 'test-model',
    requestedModel: 'test-model',
    kind: 'chat',
    backend: 'test',
    runtime: 'test-runtime',
    status: 200,
    ok: true,
    stream: false,
    durationMs: 100,
    responseBytes: 80,
    requestBytes: 40,
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
  });
  persistence.schedule(metrics.persistenceSnapshot());
  persistence.flush();

  const document = JSON.parse(readFileSync(metricsPath, 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.metrics.totals.inputTokens, 11);
  assert.equal(document.metrics.totals.outputTokens, 7);
  assert.equal(document.metrics.history.days.length, 1);

  const restoredPersistence = createMetricsPersistence(config, { logger });
  const restored = createMetricsStore({ initialSnapshot: restoredPersistence.loadSnapshot() });
  const restoredSnapshot = restored.snapshot();
  assert.equal(restoredSnapshot.totals.totalTokens, 18);
  assert.equal(restoredSnapshot.models.find((entry) => entry.id === 'test-model')?.requests, 1);
  assert.equal(restoredSnapshot.routes.find((entry) => entry.id === '/v1/chat/completions')?.outputTokens, 7);
  assert.equal(restored.snapshot({ period: 'today' }).totals.inputTokens, 11);
  assert.equal(restored.snapshot({ period: '7d' }).models[0]?.outputTokens, 7);

  const rollingMetrics = createMetricsStore();
  rollingMetrics.record({
    id: 'conn_ok',
    route: '/v1/chat/completions',
    model: 'rolling-model',
    status: 200,
    ok: true,
    durationMs: 10
  });
  rollingMetrics.record({
    id: 'conn_error',
    route: '/v1/chat/completions',
    model: 'rolling-model',
    status: 500,
    ok: false,
    durationMs: 10,
    error: 'test failure'
  });
  const rollingSnapshot = rollingMetrics.snapshot();
  assert.equal(rollingSnapshot.rolling.short.requests, 2);
  assert.equal(rollingSnapshot.rolling.short.errors, 1);
  assert.equal(rollingSnapshot.rolling.minute.errors, 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('metrics persistence tests passed');
