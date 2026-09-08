// Passive, bounded observations of actual gateway requests. Never launches inference.
export function createPerformanceSampler({ now = Date.now, windowMs = 600000, maxSamples = 256 } = {}) {
  const samples = new Map();
  const active = new Map();
  const selected = new Map();
  let selection = 0;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  function recent(model) {
    const entries = (samples.get(model) ?? []).filter((entry) => now() - entry.at < windowMs);
    if (entries.length) samples.set(model, entries);
    else samples.delete(model);
    return entries;
  }
  function begin(id, entry) {
    const model = entry.resolvedModel ?? entry.model;
    active.set(id, { model, runtime: entry.runtime });
    selected.set(model, ++selection);
  }
  function end(id) {
    active.delete(id);
  }
  function record(entry) {
    const model = entry.resolvedModel ?? entry.model;
    if (!model || !finite(entry.durationMs)) return;
    const first = entry.stream === true && finite(entry.firstContentMs) ? entry.firstContentMs : null;
    const output = Number(entry.usage?.output_tokens ?? entry.usage?.completion_tokens ?? 0);
    const decodeMs = first == null ? null : (entry.lastContentMs ?? entry.durationMs) - first;
    const rate = output > 1 && decodeMs > 0 ? ((output - 1) * 1000) / decodeMs : null;
    const entries = recent(model);
    entries.push({
      at: now(),
      ok: entry.ok === true,
      durationMs: entry.durationMs,
      firstContentMs: first,
      outputTokens: output,
      tokensPerSecond: rate
    });
    samples.set(model, entries.slice(-maxSamples));
  }
  function stats(model) {
    const entries = recent(model);
    const success = entries.filter((entry) => entry.ok);
    const durations = success.map((entry) => entry.durationMs).sort((a, b) => a - b);
    return {
      samples: entries.length,
      successes: success.length,
      errors: entries.length - success.length,
      lastSampleAt: entries.at(-1)?.at ?? null,
      activeRequests: [...active.values()].filter((entry) => entry.model === model).length,
      meanDurationMs: mean(durations),
      p95DurationMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
      meanFirstContentMs: mean(success.map((entry) => entry.firstContentMs).filter(finite)),
      meanOutputTokens: mean(success.map((entry) => entry.outputTokens)),
      tokensPerSecond: mean(success.map((entry) => entry.tokensPerSecond).filter(finite))
    };
  }
  function rank(candidates, { metric = 'completion', outputTokens = 256, runtimes = {} } = {}) {
    const ranked = candidates.map((candidate, index) => {
      const model = candidate.resolvedId;
      const sample = stats(model);
      const runtimeId = candidate.model.runtime;
      const runtime = runtimes[runtimeId] ?? {};
      const observedLoad = [...active.values()].filter((entry) =>
        runtimeId ? entry.runtime === runtimeId : entry.model === model
      ).length;
      const load = Math.max(observedLoad, Number(runtime.activeRequests ?? 0) + Number(runtime.queuedRequests ?? 0));
      const latency =
        metric === 'first-token'
          ? (sample.meanFirstContentMs ?? sample.meanDurationMs)
          : sample.meanFirstContentMs != null && sample.tokensPerSecond > 0
            ? sample.meanFirstContentMs + (Math.max(0, outputTokens - 1) * 1000) / sample.tokensPerSecond
            : sample.meanDurationMs;
      // Unknown/stale members get real traffic to learn, preferring idle members
      // for exploration. Failed calls never become fast success samples.
      const score =
        latency == null
          ? load
            ? Infinity
            : sample.errors
              ? Number.MAX_VALUE
              : -1
          : latency * (1 + load) * (1 + sample.errors / Math.max(1, sample.samples));
      return { candidate, index, score, last: selected.get(model) ?? 0 };
    });
    ranked.sort((a, b) => a.score - b.score || a.last - b.last || a.index - b.index);
    return ranked.map(({ candidate, score }) => ({
      ...candidate,
      performanceScoreMs: Number.isFinite(score) && score >= 0 ? score : null
    }));
  }
  function snapshot(model) {
    const ids = model
      ? [model]
      : [...new Set([...samples.keys(), ...[...active.values()].map((entry) => entry.model)])];
    return { windowMs, maxSamplesPerModel: maxSamples, models: Object.fromEntries(ids.map((id) => [id, stats(id)])) };
  }
  return { begin, end, record, stats, rank, snapshot };
}
