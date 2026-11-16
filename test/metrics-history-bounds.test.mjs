import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMetricsPersistence, createMetricsStore } from '../src/server.mjs';

const DAY_MS = 86400_000;
const logger = { error() {} };

function withStore(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lloom-metrics-bounds-'));
  const metricsPath = path.join(root, 'metrics-history.json');
  const open = () => {
    const persistence = createMetricsPersistence({ logging: { metricsPersistence: true, metricsPath } }, { logger });
    return { persistence, metrics: createMetricsStore({ initialSnapshot: persistence.loadSnapshot() }) };
  };
  return Promise.resolve(run({ metricsPath, open })).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function withClock(start, run) {
  const RealDate = Date;
  const clock = { now: start };
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
    static now() {
      return clock.now;
    }
  };
  try {
    return await run(clock);
  } finally {
    globalThis.Date = RealDate;
  }
}

function stream(decodeMs, model = 'model-a') {
  return {
    route: '/v1/chat/completions',
    model,
    requestedModel: 'alias-a',
    ok: true,
    stream: true,
    durationMs: decodeMs,
    firstContentMs: 0,
    lastContentMs: decodeMs,
    usage: { output_tokens: 11 }
  };
}

function bucket(id, generationIntervals = []) {
  return {
    id,
    requests: 426127,
    errors: 34081,
    streams: 155043,
    durationMs: 9804334676,
    responseBytes: 33900906606,
    firstContentCount: 392711,
    firstContentMs: 5598344288,
    minFirstContentMs: 3,
    maxFirstContentMs: 1337414,
    generationDurationMs: 2998393290,
    untrackedGenerationMs: 0,
    generationIntervals,
    decodeTokens: 123456789,
    decodeSamples: 150000,
    estimatedDecodeSamples: 0,
    recentDecodeRates: [31.5, 32.25, 30.75, 33.5, 29.25, 31.5, 32.25, 30.75, 33.5, 29.25],
    inputTokens: 9876543210,
    outputTokens: 123456789,
    totalTokens: 9999999999,
    last: { at: '2026-01-01T00:00:00.000Z', status: 200, ok: true, durationMs: 1234, firstContentMs: 321 }
  };
}

// Disjoint 30 s intervals, one a minute, ending `endOffsetMs` before `end`.
function intervals(count, end, endOffsetMs = 2 * 3600_000) {
  return Array.from({ length: count }, (_, index) => {
    const start = end - endOffsetMs - (count - index) * 60_000;
    return [start, start + 30_000];
  });
}

function group(end, { models, routes, requested, perBucketIntervals }) {
  const ids = (prefix, count) =>
    Array.from({ length: count }, (_, index) =>
      bucket(`${prefix}-${String(index).padStart(2, '0')}`, intervals(perBucketIntervals, end))
    );
  return {
    totals: bucket('all', intervals(perBucketIntervals, end)),
    models: ids('model', models),
    routes: ids('/v1/route', routes),
    requested: ids('alias', requested)
  };
}

// The shape that grew to 56 MB in the field: every interval ever recorded is kept.
function legacyDocument(now, { dayCount, perDayIntervals, allTimeIntervals }) {
  const days = Array.from({ length: dayCount }, (_, index) => {
    const dayEnd = now - (dayCount - index - 1) * DAY_MS;
    return {
      date: new Date(dayEnd).toISOString().slice(0, 10),
      ...group(dayEnd, { models: 11, routes: 5, requested: 18, perBucketIntervals: perDayIntervals })
    };
  });
  const all = group(now, { models: 20, routes: 10, requested: 28, perBucketIntervals: allTimeIntervals });
  return {
    version: 1,
    createdAt: new Date(now - dayCount * DAY_MS).toISOString(),
    metrics: { ...all, history: { days } }
  };
}

function countIntervals(document) {
  const groups = [document.metrics, ...document.metrics.history.days];
  return groups
    .flatMap((entry) => [entry.totals, ...entry.models, ...entry.routes, ...entry.requested])
    .reduce((sum, entry) => sum + entry.generationIntervals.length, 0);
}

async function maxLoopStallMs(run) {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await run();
  await sleep(5);
  histogram.disable();
  return histogram.max / 1e6;
}

test('generation intervals stay bounded and active time stays exact', async () => {
  await withClock(Date.parse('2026-09-05T00:00:00Z'), (clock) => {
    const metrics = createMetricsStore();
    for (let index = 0; index < 3000; index += 1) {
      clock.now += 60_000;
      metrics.record(stream(2000));
    }
    const snapshot = metrics.persistenceSnapshot();
    assert.equal(snapshot.history.days.length, 3);
    for (const day of snapshot.history.days.slice(0, -1)) assert.equal(day.totals.generationIntervals.length, 0);
    assert.ok(snapshot.totals.generationIntervals.length <= 61, `${snapshot.totals.generationIntervals.length}`);
    assert.ok(countIntervals({ metrics: snapshot }) <= 8 * 61);
    assert.equal(snapshot.totals.activeGenerationMs, 3000 * 2000);
    assert.equal(metrics.snapshot().totals.activeGenerationMs, 3000 * 2000);
    assert.equal(metrics.snapshot({ period: '30d' }).totals.activeGenerationMs, 3000 * 2000);
    assert.equal(metrics.snapshot().totals.activeDecodeRateEstimated, false);

    // Back-to-back traffic inside the overlap horizon is capped by count.
    const busy = createMetricsStore();
    for (let index = 0; index < 3000; index += 1) {
      clock.now += 1000;
      busy.record(stream(500));
    }
    assert.equal(busy.persistenceSnapshot().totals.generationIntervals.length, 1024);
    assert.equal(busy.snapshot().totals.activeGenerationMs, 3000 * 500);
  });
});

test('an oversized history file is compacted on first start without losing recent data', async () => {
  await withStore(({ metricsPath, open }) =>
    withClock(Date.parse('2026-11-13T12:00:00Z'), async (clock) => {
      const legacy = legacyDocument(clock.now, { dayCount: 57, perDayIntervals: 400, allTimeIntervals: 2000 });
      // A stream that ended five minutes ago can still overlap one that finishes now.
      const recent = [clock.now - 600_000, clock.now - 300_000];
      legacy.metrics.totals.generationIntervals.push(recent);
      legacy.metrics.history.days.at(-1).totals.generationIntervals.push(recent);
      writeFileSync(metricsPath, `${JSON.stringify(legacy, null, 2)}\n`);
      assert.ok(statSync(metricsPath).size > 20_000_000);
      const activeBefore = 2000 * 30_000 + 300_000;

      const { persistence, metrics } = open();
      assert.equal(metrics.snapshot().totals.activeGenerationMs, activeBefore);
      assert.equal(metrics.snapshot({ period: 'today' }).totals.activeGenerationMs, 400 * 30_000 + 300_000);
      metrics.record(stream(420_000));
      assert.equal(metrics.snapshot().totals.activeGenerationMs, activeBefore + 300_000);
      assert.equal(metrics.snapshot({ period: 'today' }).totals.activeGenerationMs, 400 * 30_000 + 600_000);
      persistence.schedule(metrics.persistenceSnapshot);
      await persistence.flushAsync();

      const compacted = JSON.parse(readFileSync(metricsPath, 'utf8'));
      assert.ok(statSync(metricsPath).size < 2_000_000, `${statSync(metricsPath).size} bytes`);
      assert.equal(statSync(metricsPath).mode & 0o777, 0o600);
      assert.equal(compacted.createdAt, legacy.createdAt);
      assert.equal(compacted.metrics.history.days.length, 57);
      assert.equal(compacted.metrics.models.length, 21);
      assert.equal(compacted.metrics.totals.requests, legacy.metrics.totals.requests + 1);
      assert.ok(countIntervals(compacted) <= 8);
      assert.equal(existsSync(`${metricsPath}.tmp`), false);

      const reopened = open().metrics.snapshot();
      assert.equal(reopened.totals.activeGenerationMs, activeBefore + 300_000);
      assert.equal(reopened.totals.activeDecodeRateEstimated, false);
    })
  );
});

test('a corrupt history file is set aside and persistence continues', async () => {
  await withStore(async ({ metricsPath, open }) => {
    writeFileSync(metricsPath, '{"version":1,"metrics":{"totals":{"requests":12');
    const { persistence, metrics } = open();
    assert.equal(metrics.snapshot().totals.requests, 0);
    assert.equal(readFileSync(`${metricsPath}.corrupt`, 'utf8'), '{"version":1,"metrics":{"totals":{"requests":12');
    metrics.record(stream(100));
    persistence.schedule(metrics.persistenceSnapshot);
    await persistence.flushAsync();
    assert.equal(JSON.parse(readFileSync(metricsPath, 'utf8')).metrics.totals.requests, 1);
  });
});

test('a shutdown flush during a background write leaves the newest history', async () => {
  await withStore(async ({ metricsPath, open }) => {
    const { persistence, metrics } = open();
    metrics.record(stream(100));
    persistence.schedule(metrics.persistenceSnapshot);
    const background = persistence.flushAsync();
    metrics.record(stream(100));
    persistence.flush();
    await background;
    assert.equal(JSON.parse(readFileSync(metricsPath, 'utf8')).metrics.totals.requests, 2);
    assert.equal(existsSync(`${metricsPath}.tmp`), false);
    assert.equal(existsSync(`${metricsPath}.sync.tmp`), false);
  });
});

for (const [name, shape] of [
  // About the 600,000 intervals and 57 days of the 56 MB file seen in the field.
  ['restored from an oversized legacy file', { dayCount: 57, perDayIntervals: 200, allTimeIntervals: 3500 }],
  // The largest history the store keeps: 400 daily rollups of 35 buckets.
  ['at the 400 day retention limit', { dayCount: 400, perDayIntervals: 0, allTimeIntervals: 0 }]
]) {
  test(`recording and persisting does not stall the event loop ${name}`, async () => {
    await withStore(async ({ metricsPath, open }) => {
      writeFileSync(metricsPath, `${JSON.stringify(legacyDocument(Date.now(), shape), null, 2)}\n`);
      const legacyBytes = statSync(metricsPath).size;
      const { persistence, metrics } = open();
      // The gateway rewrites a restored history once at start, before serving.
      persistence.schedule(metrics.persistenceSnapshot);
      await persistence.flushAsync();

      const stallMs = await maxLoopStallMs(async () => {
        for (let index = 0; index < 20; index += 1) {
          metrics.record(stream(100, `model-${String(index % 11).padStart(2, '0')}`));
          persistence.schedule(metrics.persistenceSnapshot);
          await persistence.flushAsync();
          await sleep(5);
        }
      });
      const bytes = statSync(metricsPath).size;
      console.log(
        `metrics history ${name}: ${legacyBytes} -> ${bytes} bytes, max event-loop stall ${stallMs.toFixed(1)} ms`
      );
      assert.equal(JSON.parse(readFileSync(metricsPath, 'utf8')).metrics.history.days.length, shape.dayCount);
      assert.ok(bytes < 16_000_000, `${bytes} bytes`);
      assert.ok(stallMs < 50, `event loop stalled for ${stallMs.toFixed(1)} ms`);
    });
  });
}
