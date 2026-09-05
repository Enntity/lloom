// Read installed configuration privately; send only synthetic queries to the
// normal local gateway. Refuse to start or load an absent embedding model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const config = JSON.parse(await fs.readFile(path.join(os.homedir(), '.lloom/config.json'), 'utf8'));
const model = config.models.find((entry) => entry.id === 'qwen3-embedding:4b');
if (!model) throw new Error('Expected installed embedding alias is absent');
const backend = config.backends[model.backend];
const residencyUrl = new URL('/api/ps', backend.baseUrl);
if (!['localhost', '127.0.0.1'].includes(residencyUrl.hostname)) throw new Error('Expected local Ollama backend');
const headers = config.security?.apiKeys?.[0] ? { authorization: `Bearer ${config.security.apiKeys[0]}` } : {};
const gateway = `http://127.0.0.1:${config.server.port}`;
async function readJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Probe HTTP status ${response.status}`);
  return response.json();
}
async function state() {
  const residency = await readJson(residencyUrl);
  const loaded = residency.models?.find((entry) => entry.name === model.upstreamModel || entry.model === model.upstreamModel);
  const status = await readJson(`${gateway}/gateway/status`, { headers });
  const runtime = status.runtimeManager?.runtimes?.[model.runtime];
  return { loaded: Boolean(loaded), loadedBytes: loaded?.size, healthy: runtime?.healthy,
    activeRequests: runtime?.activeRequests, queuedRequests: runtime?.queuedRequests, maxConcurrency: runtime?.maxConcurrency };
}
const before = await state();
if (!before.loaded || !before.healthy || before.activeRequests !== 0 || before.queuedRequests !== 0) {
  throw new Error('Embedding model must already be resident, healthy, and idle');
}
const queries = [
  'What did we plant in the garden last weekend?',
  'What was the next step in repairing the kitchen window?',
  'Which observations changed our plan for the radio repair?',
  'What did we learn together while watching the garden grow?',
  'Which promise remains open after our discussion about the house?'
];
const report = { at: new Date().toISOString(), scope: 'Installed Mac gateway baseline; candidate admission changes are not deployed',
  gatewayModel: model.id, upstreamModel: model.upstreamModel, backend: model.backend,
  hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model }, before, samples: [] };
for (const query of queries) {
  const input = `Instruct: Retrieve the most relevant memory passage.\nQuery: ${query}`;
  const started = performance.now();
  const response = await fetch(`${gateway}/v1/embeddings`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'x-lloom-request-class': 'interactive' },
    body: JSON.stringify({ model: model.id, input: [input] }), signal: AbortSignal.timeout(10000) });
  const headersMs = performance.now() - started;
  if (!response.ok) throw new Error(`Embedding probe HTTP status ${response.status}`);
  const body = await response.json();
  const totalMs = performance.now() - started;
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw new Error('Invalid embedding');
  report.samples.push({ query, inputChars: input.length, headersMs, totalMs,
    dimensions: vector.length, usage: body.usage, responseModel: body.model });
}
report.after = await state();
const durations = report.samples.map((entry) => entry.totalMs).sort((a, b) => a - b);
report.summary = { count: durations.length, minMs: durations[0], medianMs: durations[2], maxMs: durations.at(-1) };
await fs.writeFile(new URL('./mac-embedding-baseline.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report.summary, dimensions: report.samples.map((entry) => entry.dimensions), before, after: report.after }));
