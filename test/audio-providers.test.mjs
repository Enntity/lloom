import assert from 'node:assert/strict';
import test from 'node:test';
import { generateProviderAudio } from '../src/audio-providers.mjs';

const WAV = Buffer.alloc(46);
WAV.write('RIFF');
WAV.writeUInt32LE(38, 4);
WAV.write('WAVEfmt ', 8);
WAV.writeUInt32LE(16, 16);
WAV.writeUInt16LE(1, 20);
WAV.writeUInt16LE(1, 22);
WAV.writeUInt32LE(8000, 24);
WAV.writeUInt32LE(16000, 28);
WAV.writeUInt16LE(2, 32);
WAV.writeUInt16LE(16, 34);
WAV.write('data', 36);
WAV.writeUInt32LE(2, 40);
const MP3 = Buffer.alloc(417);
MP3.set([0xff, 0xfb, 0x90, 0x00]);

/** Build SSE text where each part is delivered as its own bytes chunk. */
function sse(...events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function audioEvent(base64, finish_reason = null) {
  return { choices: [{ index: 0, delta: { audio: { data: base64 } }, finish_reason }] };
}

function bodyFrom(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    cancel() {},
    async *[Symbol.asyncIterator]() {
      while (index < chunks.length) yield encoder.encode(chunks[index++]);
    }
  };
}

function responseFor(chunks, init = {}) {
  if (chunks && typeof chunks !== 'string' && !Array.isArray(chunks)) {
    const response = new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
    Object.defineProperty(response, 'body', { value: chunks });
    return response;
  }
  const response = new Response(null, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init
  });
  // A real Response would wrap and re-read the source; hand the adapter the
  // raw iterator so per-chunk boundaries are deterministic under test.
  Object.defineProperty(response, 'body', { value: bodyFrom(chunks) });
  return response;
}

function collectFetch(chunks, init) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return responseFor(chunks, init);
  };
  return { calls, fetchFn };
}

test('streams one provider event per chunk and returns wav bytes', async () => {
  const { fetchFn } = collectFetch([
    sse({ choices: [{ index: 0, delta: { audio: { data: WAV.subarray(0, 3).toString('base64') } } }] }),
    sse({
      choices: [{ index: 0, delta: { audio: { data: WAV.subarray(3).toString('base64') }, finish_reason: 'stop' } }]
    }),
    'data: [DONE]\n\n'
  ]);
  const response = await generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'test-only' },
    body: { model: 'google/lyria-3-pro-preview', prompt: 'gentle piano' },
    fetchFn
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('x-lloom-provider'), 'openrouter');
  assert.equal(response.headers.get('x-lloom-upstream-model'), 'google/lyria-3-pro-preview');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
});

test('honors mp3 format and maps the exact OpenRouter origin', async () => {
  const { calls, fetchFn } = collectFetch([sse(audioEvent(MP3.toString('base64'), 'stop')), 'data: [DONE]\n\n']);
  const response = await generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'test-only' },
    body: { model: 'google/lyria-3-pro-preview', instructions: 'lofi loop', format: 'mp3' },
    fetchFn
  });
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, 'google/lyria-3-pro-preview');
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.modalities, ['text', 'audio']);
  assert.deepEqual(payload.audio, { format: 'mp3' });
  assert.equal(payload.messages[0].role, 'user');
  assert.equal(payload.messages[0].content, 'lofi loop');
});

test('folds prompt, lyrics, input and duration into a single user message', async () => {
  const { calls, fetchFn } = collectFetch([sse(audioEvent(WAV.toString('base64'), 'stop')), 'data: [DONE]\n\n']);
  await generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'test-only' },
    body: { model: 'google/lyria-3-pro-preview', prompt: 'warm pads', lyrics: 'la la', input: 'BPM 90', duration: 30 },
    fetchFn
  });
  const content = JSON.parse(calls[0].options.body).messages[0].content;
  assert.equal(content, 'warm pads\nla la\nBPM 90\nDuration: 30 seconds.');
});

test('uses apiKeyEnv when configured and rejects a missing credential', async () => {
  process.env.LLOOM_TEST_AUDIO_KEY = 'env-key';
  try {
    const { calls, fetchFn } = collectFetch([sse(audioEvent(WAV.toString('base64'), 'stop'))]);
    await generateProviderAudio({
      backend: { audioProvider: 'openrouter', apiKeyEnv: 'LLOOM_TEST_AUDIO_KEY' },
      body: { model: 'google/lyria-3-pro-preview', prompt: 'p' },
      fetchFn
    });
    assert.equal(calls[0].options.headers.Authorization, 'Bearer env-key');
  } finally {
    delete process.env.LLOOM_TEST_AUDIO_KEY;
  }
  await assert.rejects(
    generateProviderAudio({
      backend: { audioProvider: 'openrouter', apiKeyEnv: 'LLOOM_TEST_AUDIO_MISSING' },
      body: { model: 'google/lyria-3-pro-preview', prompt: 'p' },
      fetchFn: async () => {
        throw new Error('must not call');
      }
    }),
    /credential is not configured/
  );
});

test('rejects unsupported provider and unsupported local controls', async () => {
  await assert.rejects(
    generateProviderAudio({
      backend: { audioProvider: 'local' },
      body: { model: 'm', prompt: 'p' },
      fetchFn: async () => {
        throw new Error('must not call');
      }
    }),
    /Unsupported audio provider/
  );
  for (const field of ['steps', 'cfg', 'seed', 'negative_prompt']) {
    await assert.rejects(
      generateProviderAudio({
        backend: { audioProvider: 'openrouter', apiKey: 'k' },
        body: { model: 'm', prompt: 'p', [field]: 1 },
        fetchFn: async () => {
          throw new Error('must not call');
        }
      }),
      new RegExp(`does not support field "${field}"`)
    );
  }
});

test('applies the configured OpenRouter provider policy', async () => {
  const { calls, fetchFn } = collectFetch([sse(audioEvent(WAV.toString('base64'), 'stop'))]);
  await generateProviderAudio({
    backend: {
      audioProvider: 'openrouter',
      apiKey: 'k',
      baseUrl: 'https://stale.example/api/v1',
      openrouterProvider: { only: ['google-vertex'], allow_fallbacks: false }
    },
    body: { model: 'google/lyria-3-pro-preview', prompt: 'p' },
    fetchFn
  });
  assert.deepEqual(JSON.parse(calls[0].options.body).provider, { only: ['google-vertex'], allow_fallbacks: false });
});

test('changes accept both [DONE] and a finish_reason marker', async () => {
  for (const chunks of [
    [sse(audioEvent(WAV.toString('base64'))), 'data: [DONE]\n\n'],
    [sse(audioEvent(WAV.toString('base64'), 'stop'))]
  ]) {
    const { fetchFn } = collectFetch(chunks);
    const response = await generateProviderAudio({
      backend: { audioProvider: 'openrouter', apiKey: 'k' },
      body: { model: 'm', prompt: 'p' },
      fetchFn
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
  }
});

test('rejects provider errors, malformed events and non-SSE responses', async () => {
  const base = { backend: { audioProvider: 'openrouter', apiKey: 'k' }, body: { model: 'm', prompt: 'p' } };
  await assert.rejects(
    generateProviderAudio({ ...base, fetchFn: async () => responseFor([sse({ error: { message: 'boom' } })]) }),
    /error event/
  );
  await assert.rejects(
    generateProviderAudio({ ...base, fetchFn: async () => responseFor(['data: {oops}\n\n']) }),
    /malformed event/
  );
  await assert.rejects(
    generateProviderAudio({
      ...base,
      fetchFn: async () =>
        new Response('{"error":"nope"}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
    /non-SSE/
  );
});

test('rejects upstream HTTP failures without leaking the provider body', async () => {
  const { fetchFn } = collectFetch([], { status: 500 });
  const error = await generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'k' },
    body: { model: 'm', prompt: 'p' },
    fetchFn
  }).then(
    () => null,
    (e) => e
  );
  assert.match(error.message, /returned HTTP 500/);
  assert.equal(error.statusCode, 500);
});

test('rejects truncated streams, empty audio and missing completion markers', async () => {
  const base = { backend: { audioProvider: 'openrouter', apiKey: 'k' }, body: { model: 'm', prompt: 'p' } };
  await assert.rejects(
    generateProviderAudio({ ...base, fetchFn: async () => responseFor([sse(audioEvent(WAV.toString('base64')))]) }),
    /without a completion marker/
  );
  await assert.rejects(
    generateProviderAudio({
      ...base,
      fetchFn: async () => responseFor([sse(audioEvent(WAV.toString('base64'))), 'data: {"choices":[]}'])
    }),
    /mid-event|completion marker/
  );
  await assert.rejects(
    generateProviderAudio({
      ...base,
      fetchFn: async () => responseFor([sse({ choices: [{ delta: {} }] }), 'data: [DONE]\n\n'])
    }),
    /returned no audio/
  );
});

test('enforces the decoded size cap and cancels the upstream body', async () => {
  let cancelled = false;
  const event = 'data: ' + JSON.stringify(audioEvent(WAV.toString('base64'))) + '\n\n';
  const encoder = new TextEncoder();
  let sent = false;
  // One logical SSE event per chunk; the adapter must stop as soon as the
  // decoded total crosses the cap and cancel the remaining stream.
  const events = [event, event, event, event];
  const body = {
    async *[Symbol.asyncIterator]() {
      if (sent) return;
      sent = true;
      for (const chunk of events) yield encoder.encode(chunk);
    },
    cancel() {
      cancelled = true;
    }
  };
  await assert.rejects(
    generateProviderAudio({
      backend: { audioProvider: 'openrouter', apiKey: 'k' },
      body: { model: 'm', prompt: 'p' },
      maxBytes: 4,
      fetchFn: async () => responseFor(body)
    }),
    /size limit/
  );
  assert.equal(cancelled, true);
});

test('propagates an already-aborted signal and cancels the body', async () => {
  let cancelled = false;
  const controller = new AbortController();
  controller.abort();
  const encoder = new TextEncoder();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode(sse(audioEvent(WAV.toString('base64'))));
    },
    cancel() {
      cancelled = true;
    }
  };
  await assert.rejects(
    generateProviderAudio({
      backend: { audioProvider: 'openrouter', apiKey: 'k' },
      body: { model: 'm', prompt: 'p' },
      signal: controller.signal,
      fetchFn: async () => responseFor(body)
    })
  );
  assert.equal(cancelled, true);
});

test('tolerates CRLF, blank-line splits and multiline SSE blocks', async () => {
  const half = WAV.subarray(0, 4).toString('base64');
  const rest = WAV.subarray(4).toString('base64');
  const text =
    `event: message\r\ndata: ${JSON.stringify(audioEvent(half))}\r\n\r\n` +
    `data: ${JSON.stringify(audioEvent(rest))}\r\n\r\n` +
    'data: [DONE]\r\n\r\n';
  // Split mid-way through an event boundary to exercise leftover buffering.
  const parts = [text.slice(0, 17), text.slice(17, 60), text.slice(60)];
  const { fetchFn } = collectFetch(parts);
  const response = await generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'k' },
    body: { model: 'm', prompt: 'p' },
    fetchFn
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
});

test('accepts one inline PNG reference image and rejects other inputs', async () => {
  const image = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  const { calls, fetchFn } = collectFetch([sse(audioEvent(WAV.toString('base64'), 'stop'))]);
  await generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'k' },
    body: { model: 'google/lyria-3-pro-preview', prompt: 'with art', image },
    fetchFn
  });
  const content = JSON.parse(calls[0].options.body).messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: image } });

  for (const bad of ['https://example.com/x.png', 'data:image/gif;base64,YQ==', '/tmp/x.png']) {
    await assert.rejects(
      generateProviderAudio({
        backend: { audioProvider: 'openrouter', apiKey: 'k' },
        body: { model: 'm', prompt: 'p', image: bad },
        fetchFn: async () => {
          throw new Error('must not call');
        }
      }),
      /inline PNG or JPEG/
    );
  }
});

test('rejects invalid format and duration without calling the provider', async () => {
  const base = { backend: { audioProvider: 'openrouter', apiKey: 'k' } };
  const noCall = {
    fetchFn: async () => {
      throw new Error('must not call');
    }
  };
  await assert.rejects(
    generateProviderAudio({ ...base, body: { model: 'm', prompt: 'p', format: 'flac' }, ...noCall }),
    /wav or mp3/
  );
  await assert.rejects(
    generateProviderAudio({ ...base, body: { model: 'm', prompt: 'p', duration: 0 }, ...noCall }),
    /duration/i
  );
  await assert.rejects(
    generateProviderAudio({ ...base, body: { model: 'm', prompt: 'p', duration: 601 }, ...noCall }),
    /duration/i
  );
  await assert.rejects(
    generateProviderAudio({ ...base, body: { model: 'm', prompt: 'p', duration: '30' }, ...noCall }),
    /duration/i
  );
});

test('never returns audio before the stream completes', async () => {
  const encoder = new TextEncoder();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const body = {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode(sse(audioEvent(WAV.toString('base64'))));
      await gate;
      yield encoder.encode('data: [DONE]\n\n');
    },
    cancel() {}
  };
  let settled = false;
  const pending = generateProviderAudio({
    backend: { audioProvider: 'openrouter', apiKey: 'k' },
    body: { model: 'm', prompt: 'p' },
    fetchFn: async () => responseFor(body)
  }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);
  release();
  assert.deepEqual(Buffer.from(await (await pending).arrayBuffer()), WAV);
});

const base = { backend: { audioProvider: 'openrouter', apiKey: 'test-only' }, body: { model: 'm', prompt: 'p' } };
test('handles headerless Lyria streams, large events, combined stop and DONE, and every CRLF split', async () => {
  const large = Buffer.concat([WAV, Buffer.alloc(1600000)]);
  large.writeUInt32LE(large.length - 8, 4);
  large.writeUInt32LE(large.length - 44, 40);
  const response = await generateProviderAudio({
    ...base,
    fetchFn: async () =>
      responseFor([sse(audioEvent(large.toString('base64'), 'stop')) + 'data: [DONE]\n\n'], { headers: {} })
  });
  assert.equal((await response.arrayBuffer()).byteLength, large.length);
  const text = sse(audioEvent(WAV.toString('base64'), 'stop')).replaceAll('\n', '\r\n') + 'data: [DONE]\r\n\r\n';
  for (let at = 0; at < text.length; at++) {
    const response = await generateProviderAudio({
      ...base,
      fetchFn: async () => responseFor([text.slice(0, at), text.slice(at)])
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
  }
});

test('does not accept truncated, failed, foreign-choice or non-audio completions', async () => {
  for (const stream of [
    sse(audioEvent(WAV.toString('base64'), 'length')) + 'data: [DONE]\n\n',
    sse(audioEvent(WAV.toString('base64'), 'stop'), { error: { message: 'private' } }),
    sse({ choices: [{ index: 1, delta: { audio: { data: WAV.toString('base64') } }, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n',
    sse(audioEvent(Buffer.from('not audio').toString('base64'), 'stop')),
    sse(audioEvent(WAV.toString('base64'), 'stop')) + 'data: {',
    sse(audioEvent('YR==', 'stop')),
    sse(audioEvent(Buffer.from('ID3abcdefghi').toString('base64'), 'stop')),
    sse(audioEvent(WAV.subarray(0, 44).toString('base64'), 'stop')),
    sse(audioEvent(MP3.subarray(0, 100).toString('base64'), 'stop'))
  ])
    await assert.rejects(generateProviderAudio({ ...base, fetchFn: async () => responseFor([stream]) }));
});

test('validates callers before network IO and sanitizes network exceptions', async () => {
  for (const body of [
    { ...base.body, seed: 1 },
    { ...base.body, format: 'mp3', response_format: 'wav' }
  ]) {
    await assert.rejects(generateProviderAudio({ ...base, body, fetchFn: () => assert.fail('network call') }), {
      statusCode: 400
    });
  }
  await assert.rejects(
    generateProviderAudio({
      ...base,
      fetchFn: () => {
        throw new Error('secret');
      }
    }),
    (error) => !error.message.includes('secret')
  );
});

test('cancellation interrupts a stalled stream read', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    start() {},
    cancel() {
      cancelled = true;
    }
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const promise = generateProviderAudio({ ...base, signal: controller.signal, fetchFn: async () => response });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(promise, /cancelled/);
  assert.equal(cancelled, true);
});

test('ffmpeg normalizes provider format and final WAV length', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const encoded = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'],
    { input: WAV }
  );
  if (encoded.error?.code === 'ENOENT') {
    t.skip('ffmpeg not installed');
    return;
  }
  assert.equal(encoded.status, 0);
  const response = await generateProviderAudio({
    ...base,
    body: { ...base.body, response_format: 'wav' },
    fetchFn: async () => responseFor([sse(audioEvent(encoded.stdout.toString('base64'), 'stop'))])
  });
  const output = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(output.toString('ascii', 8, 12), 'WAVE');
  assert.equal(output.readUInt32LE(4), output.length - 8);
  await assert.rejects(
    generateProviderAudio({
      ...base,
      maxBytes: encoded.stdout.length,
      fetchFn: async () => responseFor([sse(audioEvent(encoded.stdout.toString('base64'), 'stop'))])
    }),
    /size limit/
  );
});

test('gateway resolves the music alias and default through the adapter', async (t) => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
  const { once } = await import('node:events');
  const { createLloomServer } = await import('../src/server.mjs');
  const original = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/);
  setGlobalDispatcher(mock);
  const calls = [];
  mock
    .get('https://openrouter.ai')
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .reply((options) => {
      const text = typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8');
      calls.push(JSON.parse(text));
      return {
        statusCode: 200,
        data: sse(audioEvent(WAV.toString('base64'), 'stop')) + 'data: [DONE]\n\n',
        responseOptions: { headers: { 'content-type': 'text/event-stream' } }
      };
    })
    .times(2);
  const app = createLloomServer(
    {
      server: { host: '127.0.0.1', port: 0 },
      security: { allowMissingAuth: true, apiKeys: [] },
      logging: { metricsPersistence: false },
      telemetry: { performanceSampler: false },
      defaults: { audioGenerationModel: 'music' },
      aliases: { music: { members: ['lyria'] } },
      backends: {
        cloud: {
          type: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          audioProvider: 'openrouter',
          apiKey: 'test-only'
        }
      },
      models: [{ id: 'lyria', backend: 'cloud', kind: 'audio_generation', upstreamModel: 'google/lyria-3-pro-preview' }]
    },
    { logger: { error() {}, warn() {} }, upstreamDispatcher: mock }
  );
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close({ stopRuntimes: false });
    setGlobalDispatcher(original);
    await mock.close();
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/v1/audio/generations`;
  for (const model of ['music', undefined]) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'p', response_format: 'wav' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
  }
  assert.deepEqual(
    calls.map((c) => c.model),
    ['google/lyria-3-pro-preview', 'google/lyria-3-pro-preview']
  );
  const bad = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'p', seed: 1 })
  });
  assert.equal(bad.status, 400);
  mock.assertNoPendingInterceptors();
});
