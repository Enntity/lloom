import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createLloomServer } from '../src/server.mjs';
import { openAIStreamChunkGeneratedChars } from '../src/protocol/text.mjs';

const routes = ['/v1/responses', '/v1/messages', '/v1/chat/completions'];
const usage = { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 };
const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
const fragments = [
  { label: 'content', delta: { content: 'hello 🌍' }, chars: 'hello 🌍'.length },
  { label: 'reasoning', delta: { reasoning_content: 'thinking' }, chars: 8 },
  {
    label: 'tools',
    delta: {
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"x":' } }]
    },
    chars: 5,
    last: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }
  }
];
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function sse(delta, extra = {}) {
  return `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}
function body(route, stream) {
  return {
    model: 'external',
    stream,
    ...(route === '/v1/responses'
      ? { input: 'hi', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }
      : {
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 32,
          tools: route === '/v1/messages' ? [{ name: 'lookup', input_schema: { type: 'object' } }] : tools
        })
  };
}
async function waitFor(read, predicate, label) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(`Timed out: ${label}`);
}

async function exercise(route, fragment, stream = true, watchdog = false) {
  const observations = [];
  const ready = deferred(),
    send = deferred(),
    finish = deferred();
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* Consume the request before responding. */
    }
    res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
    res.flushHeaders();
    ready.resolve();
    await send.promise;
    if (stream) res.write(sse(fragment.delta, fragment.extra));
    await finish.promise;
    if (stream) {
      if (fragment.last) res.write(sse(fragment.last));
      res.write(sse({}, { choices: [{ index: 0, delta: {}, finish_reason: fragment.last ? 'tool_calls' : 'stop' }] }));
      res.write(sse({}, { choices: [], usage }));
      res.end('data: [DONE]\n\n');
    } else {
      res.end(
        JSON.stringify({
          id: 'buffered',
          model: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
          usage
        })
      );
    }
  });
  const upstreamPort = await listen(upstream);
  const app = createLloomServer(
    {
      server: { host: '127.0.0.1', port: 0 },
      security: { allowMissingAuth: true },
      logging: { metricsPersistence: false },
      backends: { external: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } },
      models: [
        {
          id: 'external',
          backend: 'external',
          upstreamModel: 'fixture',
          kind: 'chat',
          ...(watchdog ? { runtime: 'test' } : {})
        }
      ],
      runtimes: watchdog
        ? {
            test: {
              enabled: true,
              management: 'managed',
              watchdog: { enabled: true, firstContentTimeoutMs: 2000, idleContentTimeoutMs: 30 }
            }
          }
        : {}
    },
    {
      logger: { error() {}, warn() {} },
      ...(watchdog
        ? {
            runtimeManager: {
              ensure: async () => ({ healthy: true }),
              withSlot: async (_id, fn) => fn(),
              noteRequestOutcome: (_id, outcome) => observations.push(outcome),
              status: async () => ({ runtimes: { test: { status: 'running', healthy: true } } })
            }
          }
        : {})
    }
  );
  const port = await listen(app.server);
  const metrics = async () => (await fetch(`http://127.0.0.1:${port}/gateway/metrics`)).json();
  const request = fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body(route, stream))
  });
  // Consume continuously, including the initial protocol envelope.
  const received = request.then(async (response) => ({ status: response.status, text: await response.text() }));
  try {
    await ready.promise;
    const before = await metrics();
    assert.equal(before.active.length, 1);
    assert.equal(before.active[0].outputChars ?? 0, 0, 'protocol envelopes contain no generated output');
    if (watchdog) {
      await delay(120);
      assert.equal(
        observations.some((o) => o.stalled),
        false,
        'protocol envelope must preserve the first-content timeout'
      );
    }
    send.resolve();
    if (stream) {
      const live = await waitFor(
        metrics,
        (m) => m.active[0]?.outputChars === fragment.chars,
        `${route} ${fragment.label} live progress`
      );
      assert.equal(live.active[0].stream, true);
      assert.ok(live.active[0].responseBytes > 0);
      assert.equal(live.totals.outputTokens, 0, 'live estimate does not change authoritative totals');
    } else {
      const pending = await metrics();
      assert.equal(pending.active[0].outputChars ?? 0, 0, 'buffered request has no live output estimate');
    }
    if (watchdog) {
      await waitFor(
        () => observations,
        (items) => items.some((o) => o.stalled),
        'idle watchdog after real output'
      );
    }
    finish.resolve();
    const response = await received;
    assert.equal(response.status, 200, response.text);
    const completed = await waitFor(
      metrics,
      (m) => m.active.length === 0 && m.recent.length === 1,
      'request completion'
    );
    const record = completed.recent[0];
    if (stream) {
      assert.equal(
        record.outputChars,
        fragment.chars + (fragment.last ? 2 : 0),
        'completed events do not double count generated output'
      );
      assert.equal(
        record.responseBytes,
        Buffer.byteLength(response.text),
        'recorded bytes include the entire emitted stream'
      );
    }
    assert.equal(record.usage.input_tokens, 7);
    assert.equal(record.usage.output_tokens, 11);
    assert.equal(completed.totals.outputTokens, 11, 'final usage is counted once');
  } finally {
    send.resolve();
    finish.resolve();
    await received.catch(() => {});
    await app.close({ stopRuntimes: false, httpGraceMs: 25 });
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

// Completed snapshots and provider usage must not be counted as fresh output.
assert.equal(
  openAIStreamChunkGeneratedChars({
    choices: [
      {
        message: {
          content: 'repeated',
          reasoning_content: 'repeated',
          tool_calls: [{ function: { arguments: 'repeated' } }]
        }
      }
    ],
    usage
  }),
  0
);
assert.equal(openAIStreamChunkGeneratedChars({ choices: [], usage }), 0);
assert.equal(
  openAIStreamChunkGeneratedChars({ choices: [{ delta: { content: 'first' } }, { delta: { content: 'second' } }] }),
  11,
  'chat streams retain output accounting across all choices'
);

for (const route of routes) {
  for (const fragment of fragments) await exercise(route, fragment);
  await exercise(route, fragments[0], false);
  await exercise(route, {
    label: 'multiple choices',
    delta: {},
    chars: route === '/v1/chat/completions' ? 11 : 5,
    extra: {
      choices: [
        { index: 0, delta: { content: 'first' } },
        { index: 1, delta: { content: 'second' } }
      ]
    }
  });
  if (route !== '/v1/chat/completions') await exercise(route, fragments[0], true, true);
}
console.log('stream metrics: live content, reasoning, tools, final bytes/usage, and buffered requests passed');
