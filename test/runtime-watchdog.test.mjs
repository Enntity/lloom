import assert from 'node:assert/strict';
import http from 'node:http';
import { RuntimeManager, classifyRuntimeWatchdogOutcome, runtimeWatchdogConfig } from '../src/runtime-manager.mjs';
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

const managedRuntime = {
  enabled: true,
  management: 'managed',
  watchdog: {
    enabled: true,
    failureThreshold: 2,
    failureWindowMs: 10000,
    minNoProgressMs: 100,
    cooldownMs: 1000,
    drainTimeoutMs: 20
  }
};

{
  assert.equal(runtimeWatchdogConfig(managedRuntime).enabled, true);
  assert.equal(
    runtimeWatchdogConfig({ ...managedRuntime, management: 'external' }).enabled,
    false,
    'watchdog cannot restart an externally managed runtime'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 499,
      durationMs: 99,
      responseBytes: 0
    }).kind,
    'ignored',
    'quick client cancellations are not backend-stall evidence'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 499,
      durationMs: 100,
      responseBytes: 0
    }).kind,
    'no-progress-failure'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 499,
      durationMs: 1000,
      firstContentMs: 10,
      responseBytes: 8
    }).kind,
    'progress',
    'a client close after streamed content is not a no-progress stall'
  );
  assert.equal(
    classifyRuntimeWatchdogOutcome(managedRuntime, {
      ok: false,
      status: 504,
      durationMs: 1000,
      firstContentMs: 10,
      responseBytes: 8,
      stalled: true
    }).kind,
    'no-progress-failure',
    'an in-flight stall is evaluated from its last progress even if the request emitted earlier content'
  );
}

class TestRuntimeManager extends RuntimeManager {
  constructor(config) {
    super(config, { logger: { error() {} } });
    this.lifecycleCalls = [];
  }

  async stopUnlocked(runtimeId) {
    this.lifecycleCalls.push({ action: 'stop', runtimeId });
    return { runtimeId, stopped: true };
  }

  async startUnlocked(runtimeId, options) {
    this.lifecycleCalls.push({ action: 'start', runtimeId, options });
    return { runtimeId, started: true, healthy: true };
  }
}

{
  const runtimeId = 'test-runtime';
  const manager = new TestRuntimeManager({
    runtimes: {
      [runtimeId]: managedRuntime
    }
  });
  const stalled = {
    ok: false,
    status: 499,
    durationMs: 500,
    firstContentMs: null,
    lastContentMs: null,
    responseBytes: 0
  };

  assert.deepEqual(manager.noteRequestOutcome(runtimeId, stalled), {
    runtimeId,
    action: 'observed',
    reason: 'below-threshold'
  });
  assert.equal(manager.stateFor(runtimeId).watchdog.consecutiveFailures, 1);

  manager.noteRequestOutcome(runtimeId, {
    ok: true,
    status: 200,
    durationMs: 20,
    firstContentMs: 10,
    responseBytes: 20
  });
  assert.equal(manager.stateFor(runtimeId).watchdog.consecutiveFailures, 0, 'progress clears the failure streak');

  manager.noteRequestOutcome(runtimeId, stalled);
  assert.deepEqual(manager.noteRequestOutcome(runtimeId, stalled), {
    runtimeId,
    action: 'restart-requested',
    reason: 'failure-threshold'
  });
  assert.equal(manager.pausedRuntimes.has(runtimeId), true, 'new requests pause as soon as restart is requested');
  await manager.watchdogOperations.get(runtimeId);
  assert.deepEqual(
    manager.lifecycleCalls.map(({ action }) => action),
    ['stop', 'start'],
    'watchdog restarts only the affected runtime through its lifecycle methods'
  );
  assert.equal(manager.lifecycleCalls[1].options.reason, 'watchdog-restart');
  assert.equal(manager.pausedRuntimes.has(runtimeId), false);
  assert.equal(manager.stateFor(runtimeId).watchdog.restarts, 1);

  manager.noteRequestOutcome(runtimeId, stalled);
  assert.equal(manager.noteRequestOutcome(runtimeId, stalled).reason, 'cooldown');
  assert.equal(manager.lifecycleCalls.length, 2, 'cooldown prevents a restart loop');

  const status = await manager.status();
  assert.equal(status.runtimes[runtimeId].watchdog.enabled, true);
  assert.equal(status.runtimes[runtimeId].watchdog.restarts, 1);
  assert(status.events.some((event) => event.event === 'watchdog-restart-completed'));
}

// Buffered responses have no observable byte progress before completion. A
// slow, successful response must not be classified as a runtime stall, while
// the streaming no-progress watchdog remains active.
{
  const observations = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw || '{}');
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (request.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'watchdog-stream',
          object: 'chat.completion.chunk',
          model: 'watchdog-upstream',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }]
        })}\n\n`
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    const body = completion('watchdog-upstream');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const config = {
    name: 'runtime-watchdog-response-mode-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    defaults: { chatModel: 'watchdog-model' },
    backends: {
      watchdog: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, timeoutMs: 1000 }
    },
    models: [
      {
        id: 'watchdog-model',
        kind: 'chat',
        backend: 'watchdog',
        runtime: 'watchdog-runtime',
        upstreamModel: 'watchdog-upstream',
        contextWindow: 8192,
        maxOutputTokens: 1024
      }
    ],
    runtimes: {
      'watchdog-runtime': {
        enabled: true,
        management: 'managed',
        watchdog: {
          enabled: true,
          failureThreshold: 1,
          minNoProgressMs: 20,
          cooldownMs: 1000,
          drainTimeoutMs: 20,
          failureStatuses: [504]
        }
      }
    }
  };
  const runtimeManager = {
    ensure: async () => ({ healthy: true }),
    withSlot: async (_runtimeId, fn) => fn(),
    noteRequestOutcome(_runtimeId, outcome) {
      observations.push(outcome);
    },
    async status() {
      return { runtimes: { 'watchdog-runtime': { status: 'running', healthy: true } } };
    }
  };
  const app = createLloomServer(config, {
    runtimeManager,
    logger: { error() {}, warn() {} }
  });
  const gatewayPort = await listen(app.server);
  const chat = (stream) =>
    fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'watchdog-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8,
        stream
      })
    });

  const buffered = await chat(false);
  assert.equal(buffered.status, 200);
  await buffered.json();
  assert.equal(
    observations.some((outcome) => outcome.stalled === true),
    false,
    'a slow buffered response must not trigger the byte-progress watchdog'
  );

  const streamed = await chat(true);
  assert.equal(streamed.status, 200);
  await streamed.text();
  assert.equal(
    observations.some((outcome) => outcome.stalled === true && outcome.status === 504),
    true,
    'a streaming request with no progress still triggers the watchdog'
  );

  await close(app.server);
  await close(upstream);
}

console.log('runtime watchdog tests passed');
