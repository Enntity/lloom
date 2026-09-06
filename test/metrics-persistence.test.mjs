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

  // Global throughput is time-weighted and counts concurrent generation once.
  const RealDate = Date;
  let clock = RealDate.parse('2026-09-05T12:00:00Z');
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  };
  try {
    const flow = createMetricsStore();
    const recordFlow = (store, model, durationMs, tokens) =>
      store.record({
        model,
        route: '/v1/chat/completions',
        ok: true,
        stream: true,
        durationMs,
        firstContentMs: 1000,
        lastContentMs: durationMs,
        usage: { output_tokens: tokens + 1 }
      });
    recordFlow(flow, 'a', 3000, 100); // 2 seconds at 50 tok/s
    recordFlow(flow, 'b', 2000, 100); // overlaps the final second
    assert.equal(flow.snapshot().totals.activeDecodeTokensPerSecond, 100);
    assert.equal(flow.snapshot().models.find((item) => item.id === 'a').decodeTokensPerSecond, 50);
    clock += 3600_000; // idle time must not dilute the average
    recordFlow(flow, 'a', 9000, 80); // 8 seconds at 10 tok/s
    assert.equal(flow.snapshot().totals.activeDecodeTokensPerSecond, 28);
    assert.equal(flow.snapshot().models.find((item) => item.id === 'a').decodeTokensPerSecond, 30);
    flow.record({ model: 'buffered', stream: false, ok: true, durationMs: 5000, usage: { output_tokens: 9999 } });
    assert.equal(flow.snapshot().totals.activeDecodeTokensPerSecond, 28);
    assert.equal(flow.snapshot().totals.activeDecodeRateEstimated, false);
    assert.equal(flow.snapshot().totals.generationIntervals, undefined);

    const saved = flow.persistenceSnapshot();
    const resumed = createMetricsStore({ initialSnapshot: saved });
    assert.equal(resumed.snapshot().totals.activeDecodeTokensPerSecond, 28);
    clock += 86400_000;
    recordFlow(resumed, 'a', 2000, 50);
    assert.equal(resumed.snapshot({ period: 'today' }).totals.activeDecodeTokensPerSecond, 50);
    assert.equal(resumed.snapshot({ period: '7d' }).totals.activeDecodeTokensPerSecond, 30);
    assert.equal(resumed.snapshot({ period: 'all' }).totals.activeDecodeTokensPerSecond, 30);

    const legacy = createMetricsStore({
      initialSnapshot: {
        totals: { generationDurationMs: 2000, decodeTokens: 100, decodeSamples: 1 }
      }
    });
    assert.equal(legacy.snapshot().totals.activeDecodeTokensPerSecond, 50);
    assert.equal(legacy.snapshot().totals.activeDecodeRateEstimated, true);
    recordFlow(legacy, 'a', 2000, 20);
    assert.equal(legacy.snapshot().totals.activeDecodeTokensPerSecond, 40);
    assert.equal(createMetricsStore().snapshot().totals.activeDecodeTokensPerSecond, null);
  } finally {
    globalThis.Date = RealDate;
  }

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
