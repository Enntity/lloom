import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/registry.mjs';
import { createLloomServer } from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function completion(model, content = 'ok') {
  return JSON.stringify({
    id: `completion-${model}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
}

function embedding(model, value) {
  return JSON.stringify({
    object: 'list',
    model,
    data: [{ object: 'embedding', index: 0, embedding: [value] }],
    usage: { prompt_tokens: 1, total_tokens: 1 }
  });
}

async function createFixture({
  primaryStatus = 503,
  primaryHeaders = {},
  cloudStatus = 200,
  runtimeStatus = 'running',
  preserveResident = false,
  inferenceEnabled = true
} = {}) {
  const hits = { primary: 0, cloud: 0, ensures: 0 };
  const operations = [];
  const admissionOptions = [];
  const primary = http.createServer((_req, res) => {
    hits.primary += 1;
    const body =
      primaryStatus === 200
        ? completion('local-upstream', 'local')
        : JSON.stringify({ error: { message: `primary status ${primaryStatus}` } });
    res.writeHead(primaryStatus, { 'content-type': 'application/json', ...primaryHeaders });
    res.end(body);
  });
  const cloud = http.createServer(async (req, res) => {
    hits.cloud += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw || '{}');
    if (cloudStatus !== 200) {
      res.writeHead(cloudStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `cloud status ${cloudStatus}` } }));
      return;
    }
    if (request.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'cloud-stream',
          object: 'chat.completion.chunk',
          model: 'cloud-upstream',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'cloud' }, finish_reason: null }]
        })}\n\n`
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    const body = completion('cloud-upstream', 'cloud');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const primaryPort = await listen(primary);
  const cloudPort = await listen(cloud);
  const config = {
    name: 'model-failover-test',
    server: { host: '127.0.0.1', port: 0, inferenceEnabled },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    cluster: { routingStatusCacheMs: 0 },
    ...(preserveResident
      ? {
          runtimePolicy: {
            enabled: true,
            autoEvict: true,
            memoryBudgetGb: 40,
            protectActiveRequests: true
          }
        }
      : {}),
    defaults: { chatModel: 'stable-chat' },
    aliases: {
      'stable-chat': {
        target: 'stable-chat',
        fallbacks: ['cloud-chat'],
        advertise: false
      }
    },
    backends: {
      primary: { type: 'openai', baseUrl: `http://127.0.0.1:${primaryPort}/v1`, timeoutMs: 5000 },
      cloud: { type: 'openai', baseUrl: `http://127.0.0.1:${cloudPort}/v1`, timeoutMs: 5000 }
    },
    models: [
      {
        id: 'stable-chat',
        kind: 'chat',
        backend: 'primary',
        runtime: 'primary-runtime',
        upstreamModel: 'local-upstream',
        contextWindow: 8192,
        maxOutputTokens: 1024
      },
      {
        id: 'cloud-chat',
        kind: 'chat',
        backend: 'cloud',
        upstreamModel: 'cloud-upstream',
        contextWindow: 8192,
        maxOutputTokens: 1024
      }
    ],
    runtimes: {
      'primary-runtime': { enabled: true, memoryGb: preserveResident ? 30 : 0 },
      ...(preserveResident ? { 'resident-runtime': { enabled: true, memoryGb: 30 } } : {})
    }
  };
  const runtimeManager = {
    ensure: async () => {
      hits.ensures += 1;
      operations.push('ensure:primary-runtime');
      return { healthy: true };
    },
    withSlot: async (runtimeId, fn) => {
      if (runtimeId) operations.push(`slot:${runtimeId}`);
      return fn();
    },
    noteRequestOutcome() {},
    withAdmissionLock(fn, options) {
      admissionOptions.push(options);
      return fn();
    },
    async status() {
      return {
        runtimes: {
          'primary-runtime': { status: runtimeStatus, healthy: runtimeStatus === 'running' },
          ...(preserveResident ? { 'resident-runtime': { status: 'running', healthy: true, activeRequests: 0 } } : {})
        }
      };
    },
    async stop(runtimeId) {
      operations.push(`stop:${runtimeId}`);
      return { runtimeId, stopped: true };
    },
    async start(runtimeId) {
      operations.push(`start:${runtimeId}`);
      return { runtimeId, started: true };
    }
  };
  const logs = [];
  const app = createLloomServer(config, {
    runtimeManager,
    logger: {
      error() {},
      warn(message) {
        logs.push(message);
      }
    }
  });
  const gatewayPort = await listen(app.server);
  return {
    app,
    hits,
    admissionOptions,
    logs,
    operations,
    url: `http://127.0.0.1:${gatewayPort}`,
    async close() {
      await close(app.server);
      await close(primary);
      await close(cloud);
    }
  };
}

async function createEmbeddingFixture({
  sparkStatus = 200,
  macStatus = 200,
  cloudStatus = 200,
  runtimeStatus = 'running',
  preserveResident = false,
  clusteredPredictive = false
} = {}) {
  const hits = { spark: 0, mac: 0, cloud: 0, ensures: 0 };
  const operations = [];
  const admissionOptions = [];
  const upstreams = [];

  async function addUpstream(name, status, value) {
    const server = http.createServer((_req, res) => {
      hits[name] += 1;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        status === 200
          ? embedding(`${name}-embedding`, value)
          : JSON.stringify({ error: { message: `${name} status ${status}` } })
      );
    });
    const port = await listen(server);
    upstreams.push(server);
    return { type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 5000 };
  }

  const backends = {
    spark: await addUpstream('spark', sparkStatus, 1),
    mac: await addUpstream('mac', macStatus, 2),
    cloud: await addUpstream('cloud', cloudStatus, 3)
  };
  const config = {
    name: 'embedding-failover-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    cluster: {
      routingStatusCacheMs: 0,
      ...(clusteredPredictive ? { nodes: { spark: { resources: { memoryGb: 128 } } } } : {})
    },
    ...(preserveResident || clusteredPredictive
      ? {
          runtimePolicy: {
            enabled: true,
            autoEvict: true,
            ...(clusteredPredictive ? { maxMemoryUtilization: 0.95 } : { memoryBudgetGb: 40 }),
            protectActiveRequests: true
          }
        }
      : {}),
    defaults: { embeddingModel: 'embeddings' },
    aliases: {
      embeddings: {
        target: 'spark-embedding',
        fallbacks: ['macbook-embedding', 'cloud-embedding']
      }
    },
    backends,
    models: [
      {
        id: 'spark-embedding',
        kind: 'embedding',
        backend: 'spark',
        runtime: 'spark-embedding-runtime',
        upstreamModel: 'spark-embedding'
      },
      {
        id: 'macbook-embedding',
        kind: 'embedding',
        backend: 'mac',
        upstreamModel: 'macbook-embedding'
      },
      {
        id: 'cloud-embedding',
        kind: 'embedding',
        backend: 'cloud',
        upstreamModel: 'cloud-embedding'
      }
    ],
    runtimes: {
      'spark-embedding-runtime': {
        enabled: true,
        memoryGb: clusteredPredictive ? 12 : preserveResident ? 30 : 0,
        ...(clusteredPredictive ? { node: 'spark' } : {})
      },
      ...(preserveResident || clusteredPredictive
        ? {
            'resident-runtime': {
              enabled: true,
              memoryGb: clusteredPredictive ? 100 : 30,
              ...(clusteredPredictive ? { node: 'spark' } : {})
            }
          }
        : {})
    }
  };
  const runtimeManager = {
    async ensure() {
      hits.ensures += 1;
      operations.push('ensure:spark-embedding-runtime');
      return { healthy: true };
    },
    async withSlot(runtimeId, fn) {
      if (runtimeId) operations.push(`slot:${runtimeId}`);
      return fn();
    },
    noteRequestOutcome() {},
    withAdmissionLock(fn, options) {
      admissionOptions.push(options);
      return fn();
    },
    async status() {
      return {
        runtimes: {
          'spark-embedding-runtime': { status: runtimeStatus, healthy: runtimeStatus === 'running' },
          ...(preserveResident || clusteredPredictive
            ? { 'resident-runtime': { status: 'running', healthy: true, activeRequests: 0 } }
            : {})
        }
      };
    },
    async stop(runtimeId) {
      operations.push(`stop:${runtimeId}`);
      return { runtimeId, stopped: true };
    },
    async start(runtimeId) {
      operations.push(`start:${runtimeId}`);
      return { runtimeId, started: true };
    }
  };
  const clusterCoordinator = clusteredPredictive
    ? {
        attachRuntimeManager() {},
        attachModelCatalog() {},
        reconfigure() {},
        selectTarget() {
          return null;
        },
        async withTarget(_resolved, fn) {
          return fn();
        },
        noteTargetOutcome() {},
        async nodeStatus() {
          return null;
        },
        async status() {
          return {
            nodes: {
              spark: {
                reachable: true,
                local: true,
                telemetry: {
                  memory: {
                    totalBytes: 128 * 1024 ** 3,
                    availableBytes: 10 * 1024 ** 3
                  }
                }
              }
            }
          };
        }
      }
    : undefined;
  const app = createLloomServer(config, {
    runtimeManager,
    ...(clusterCoordinator ? { clusterCoordinator } : {}),
    logger: { error() {}, warn() {} }
  });
  const gatewayPort = await listen(app.server);
  return {
    app,
    hits,
    operations,
    admissionOptions,
    url: `http://127.0.0.1:${gatewayPort}`,
    async close() {
      await close(app.server);
      await Promise.all(upstreams.map(close));
    }
  };
}

async function chat(url, body = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'stable-chat',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8,
      ...body
    })
  });
}

async function embed(url, body = {}) {
  return fetch(`${url}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embeddings', input: ['hello'], ...body })
  });
}

// Alias chains resolve in order, including an alias that intentionally shadows
// its primary model ID.
{
  const registry = createRegistry({
    aliases: { local: { target: 'local', fallbacks: ['cloud'] } },
    backends: { local: {}, cloud: {} },
    runtimes: { local: { enabled: true } },
    models: [
      { id: 'local', backend: 'local', runtime: 'local', kind: 'chat' },
      { id: 'cloud', backend: 'cloud', kind: 'chat' }
    ]
  });
  assert.deepEqual(
    registry.resolveCandidates('local').map((candidate) => candidate.resolvedId),
    ['local', 'cloud']
  );
  assert.equal(registry.catalogModels({ includeAliases: true }).filter((model) => model.id === 'local').length, 1);
}

// Config validation catches unknown, duplicate, and cross-kind fallback targets.
{
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lloom-alias-validation-'));
  const configPath = path.join(directory, 'config.json');
  const base = {
    backends: { chat: { baseUrl: 'http://127.0.0.1:1/v1' }, image: { baseUrl: 'http://127.0.0.1:2/v1' } },
    models: [
      { id: 'chat', kind: 'chat', backend: 'chat' },
      { id: 'image', kind: 'image', backend: 'image' }
    ],
    aliases: { stable: { target: 'chat', fallbacks: ['missing'] } }
  };
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /targets unknown model missing/);
  base.aliases.stable.optionalFallbacks = ['missing'];
  await writeFile(configPath, JSON.stringify(base));
  const optionalFallback = await loadConfig(configPath);
  assert.deepEqual(optionalFallback.aliases.stable.fallbacks, ['missing']);
  delete base.aliases.stable.optionalFallbacks;
  base.aliases.stable.fallbacks = ['chat'];
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /has duplicate targets/);
  base.aliases.stable.fallbacks = ['image'];
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /models with different kinds/);
  base.aliases.stable = { target: 'chat', keepWarm: true };
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /aliases resolve models and cannot pin compute/);

  base.aliases.stable = { target: 'chat' };
  base.runtimePolicy = { protectKeepWarm: false };
  base.runtimes = {
    legacyPin: { keepWarm: false, policy: { priority: 7, evictable: false } },
    legacyUnpinned: { policy: { evictable: true } }
  };
  await writeFile(configPath, JSON.stringify(base));
  const migrated = await loadConfig(configPath);
  assert.equal(migrated.runtimes.legacyPin.keepWarm, true);
  assert.deepEqual(migrated.runtimes.legacyPin.policy, { priority: 7 });
  assert.equal(migrated.runtimes.legacyUnpinned.policy, undefined);
  assert.equal(migrated.runtimePolicy.protectKeepWarm, undefined);
  assert.equal(migrated.sourceTemplate.runtimes.legacyPin.keepWarm, true);

  const forgedAuthority = {
    ...base,
    cluster: {
      nodeId: 'leader',
      leaderNode: 'leader',
      nodes: { leader: {}, worker: { endpoint: 'http://worker:8100' } }
    },
    runtimes: {
      workerLocal: {
        enabled: true,
        node: 'worker',
        authority: { owner: 'leader', scope: 'local' }
      }
    }
  };
  await writeFile(configPath, JSON.stringify(forgedAuthority));
  await assert.rejects(
    loadConfig(configPath),
    /local runtime workerLocal authority owner must be its host node worker/
  );
  await rm(directory, { recursive: true, force: true });
}

// A retryable primary response fails over, while preserving the requested alias
// in the OpenAI response and recording both attempts.
{
  const fixture = await createFixture({ primaryStatus: 503 });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, 'stable-chat');
  assert.equal(body.choices[0].message.content, 'cloud');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  const recent = fixture.app.metrics.snapshot().recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].resolvedModel, 'stable-chat');
  assert.equal(recent[0].status, 503);
  assert.equal(recent[1].resolvedModel, 'cloud-chat');
  assert.equal(recent[1].failedOver, true);
  assert.deepEqual(fixture.operations.slice(0, 2), ['ensure:primary-runtime', 'slot:primary-runtime']);
  assert(fixture.logs.some((line) => line.includes('stable-chat -> cloud-chat')));
  await fixture.close();
}

// Retry-After opens a target circuit. New requests calmly bypass the known-bad
// target until its advertised cooldown expires instead of hammering it.
{
  const fixture = await createFixture({ primaryStatus: 429, primaryHeaders: { 'retry-after': '30' } });
  assert.equal((await chat(fixture.url)).status, 200);
  assert.equal((await chat(fixture.url)).status, 200);
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 2, ensures: 1 });
  const routing = await fetch(`${fixture.url}/gateway/routing`).then((response) => response.json());
  const backoff = routing.targetBackoffs.find((entry) => entry.model === 'stable-chat');
  assert.equal(backoff.state, 'open');
  assert(backoff.retryAfterSeconds >= 29);
  await fixture.close();
}

// A worker/control-plane LLooM remains healthy and administrable but refuses
// direct inference, making an accidental client connection fail visibly.
{
  const fixture = await createFixture({ primaryStatus: 200, inferenceEnabled: false });
  const response = await chat(fixture.url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.equal((await response.json()).error.code, 'worker_control_plane_only');
  assert.deepEqual(fixture.hits, { primary: 0, cloud: 0, ensures: 0 });
  assert.equal((await fetch(`${fixture.url}/health`)).status, 200);
  assert.equal((await fetch(`${fixture.url}/gateway/routing`)).status, 200);
  await fixture.close();
}

// A cold primary with an available fallback does not evict an unrelated
// resident runtime just to satisfy the local-first preference.
{
  const fixture = await createFixture({
    primaryStatus: 200,
    runtimeStatus: 'stopped',
    preserveResident: true
  });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'cloud');
  assert.deepEqual(fixture.hits, { primary: 0, cloud: 1, ensures: 0 });
  assert.deepEqual(fixture.operations, []);
  const recent = fixture.app.metrics.snapshot().recent;
  assert.equal(recent[0].resolvedModel, 'cloud-chat');
  assert.equal(recent[0].failoverAttempt, 1);
  assert.equal(recent[0].failoverReason, 'preserve-residency');
  assert.equal(recent[0].failedOver, true);
  await fixture.close();
}

// Once a conflicting admission begins draining a local runtime, new alias
// traffic bypasses that runtime and uses its external fallback. Existing
// requests can finish without allowing fresh local work to starve the swap.
{
  const fixture = await createFixture({ primaryStatus: 200, runtimeStatus: 'draining' });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'cloud');
  assert.deepEqual(fixture.hits, { primary: 0, cloud: 1, ensures: 0 });
  assert.deepEqual(fixture.operations, []);
  await fixture.close();
}

// Provider-specific payment/capacity failure is an availability failure: if
// the cloud shortcut cannot serve, LLooM returns to the local primary and
// performs the previously deferred admission as the last resort.
{
  const fixture = await createFixture({
    primaryStatus: 200,
    cloudStatus: 402,
    runtimeStatus: 'stopped',
    preserveResident: true
  });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'local');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 0 });
  assert.deepEqual(fixture.operations, ['stop:resident-runtime', 'start:primary-runtime', 'slot:primary-runtime']);
  assert.equal(
    fixture.admissionOptions[0].preemptible,
    false,
    'after the ready cloud route fails, the last local route has no remaining live alternative'
  );
  const recent = fixture.app.metrics.snapshot().recent;
  assert.equal(recent[0].resolvedModel, 'cloud-chat');
  assert.equal(recent[0].status, 402);
  assert.equal(recent[1].resolvedModel, 'stable-chat');
  assert.equal(recent[1].failoverAttempt, 2);
  await fixture.close();
}

// Embeddings honor the same ordered alias chain as chat: Spark is first while
// it is resident and healthy.
{
  const fixture = await createEmbeddingFixture();
  const response = await embed(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data[0].embedding, [1]);
  assert.deepEqual(fixture.hits, { spark: 1, mac: 0, cloud: 0, ensures: 1 });
  await fixture.close();
}

// If admitting Spark would evict another resident model, LLooM tries every
// ready non-evicting destination in route order. A dead MacBook falls through
// to cloud without stopping or starting a Spark runtime.
{
  const fixture = await createEmbeddingFixture({
    macStatus: 503,
    runtimeStatus: 'stopped',
    preserveResident: true
  });
  const response = await embed(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data[0].embedding, [3]);
  assert.deepEqual(fixture.hits, { spark: 0, mac: 1, cloud: 1, ensures: 0 });
  assert.deepEqual(fixture.operations, []);
  const recent = fixture.app.metrics.snapshot().recent;
  assert.deepEqual(
    recent.map((entry) => [entry.resolvedModel, entry.status, entry.failoverReason]),
    [
      ['macbook-embedding', 503, 'preserve-residency'],
      ['cloud-embedding', 200, 'preserve-residency']
    ]
  );
  await fixture.close();
}

// Cluster admission previews use live node telemetry, not only configured
// memory estimates. This catches the Spark case where static model estimates
// appear to coexist but current unified-memory pressure requires eviction.
{
  const fixture = await createEmbeddingFixture({
    runtimeStatus: 'stopped',
    clusteredPredictive: true
  });
  const response = await embed(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data[0].embedding, [2]);
  assert.deepEqual(fixture.hits, { spark: 0, mac: 1, cloud: 0, ensures: 0 });
  assert.deepEqual(fixture.operations, []);
  const recent = fixture.app.metrics.snapshot().recent;
  assert.equal(recent[0].resolvedModel, 'macbook-embedding');
  assert.equal(recent[0].failoverReason, 'preserve-residency');
  assert.equal(recent[0].failedOver, true);
  await fixture.close();
}

// Embeddings never evict resident runtimes. If MacBook and cloud both fail,
// the request fails too; the Spark embedding runtime remains stopped.
{
  const fixture = await createEmbeddingFixture({
    macStatus: 503,
    cloudStatus: 503,
    runtimeStatus: 'stopped',
    preserveResident: true
  });
  const response = await embed(fixture.url);
  assert.equal(response.status, 503);
  assert.deepEqual(fixture.hits, { spark: 0, mac: 1, cloud: 1, ensures: 0 });
  assert.deepEqual(fixture.operations, []);
  assert.equal(
    fixture.admissionOptions[0].preemptible,
    false,
    'the exact Spark route is attempted only after both non-evicting alternatives have failed'
  );
  await fixture.close();
}

// The no-eviction guarantee also applies when a caller bypasses the alias and
// requests the exact Spark embedding model ID.
{
  const fixture = await createEmbeddingFixture({
    runtimeStatus: 'stopped',
    clusteredPredictive: true
  });
  const response = await embed(fixture.url, { model: 'spark-embedding' });
  assert.equal(response.status, 503);
  assert.deepEqual(fixture.hits, { spark: 0, mac: 0, cloud: 0, ensures: 0 });
  assert.deepEqual(fixture.operations, []);
  assert.equal(fixture.admissionOptions[0].preemptible, false);
  await fixture.close();
}

// Streaming may change targets only before gateway headers or content are sent.
{
  const fixture = await createFixture({ primaryStatus: 503 });
  const response = await chat(fixture.url, { stream: true });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(text.includes('"model":"stable-chat"'));
  assert(text.includes('"content":"cloud"'));
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  await fixture.close();
}

// The same alias chain is honored by the Responses and Anthropic bridges.
{
  const fixture = await createFixture({ primaryStatus: 503 });
  const responses = await fetch(`${fixture.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stable-chat', input: 'hello', max_output_tokens: 8 })
  });
  assert.equal(responses.status, 200);
  const responsesBody = await responses.json();
  assert.equal(responsesBody.model, 'stable-chat');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  await fixture.close();
}

{
  const fixture = await createFixture({ primaryStatus: 503 });
  const messages = await fetch(`${fixture.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'stable-chat',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8
    })
  });
  assert.equal(messages.status, 200);
  const messagesBody = await messages.json();
  assert.equal(messagesBody.model, 'stable-chat');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  await fixture.close();
}

// Ordinary request errors are returned from the primary without trying cloud.
{
  const fixture = await createFixture({ primaryStatus: 400 });
  const response = await chat(fixture.url);
  assert.equal(response.status, 400);
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 0, ensures: 1 });
  await fixture.close();
}

// New work bypasses a runtime that LLooM already knows is upgrading/warming.
{
  const fixture = await createFixture({ primaryStatus: 200, runtimeStatus: 'warming' });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'cloud');
  assert.deepEqual(fixture.hits, { primary: 0, cloud: 1, ensures: 0 });
  assert(fixture.logs.some((line) => line.includes('is warming')));
  await fixture.close();
}

console.log('model failover tests passed');
