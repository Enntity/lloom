import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agent, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { loadConfig } from '../src/config.mjs';
import { isInternalHost, redactEgressBody, redactSecrets, shouldRedactEgress } from '../src/egress-redaction.mjs';
import { createLloomServer } from '../src/server.mjs';

// Fake credentials are assembled at runtime so no literal in this file looks
// like a live key to secret scanners.
const join = (...parts) => parts.join('');
const FAKE = {
  openai: join('sk-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  anthropic: join('sk-', 'ant-', 'api03-', 'Zy9Xw8Vu7Ts6Rq5Po4Nm3'),
  openrouter: join('sk-', 'or-', 'v1-', '0123456789abcdef'.repeat(4)),
  deepseek: join('sk-', '9f8e7d6c5b4a39281706f5e4'),
  lloom: join('lloom_', 'live_', '0123456789abcdef0123'),
  github: join('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubPat: join('github_', 'pat_', '11ABCDEFG0123456789_abcdefghij'),
  slack: join('xo', 'xb-', '1234567890-abcdefghij'),
  aws: join('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  google: join('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  replicate: join('r8', '_', 'A1b2C3d4E5f6G7h8I9j0K1'),
  huggingface: join('hf', '_', 'A1b2C3d4E5f6G7h8I9j0K1'),
  jina: join('jina', '_', 'A1b2C3d4E5f6G7h8I9j0K1'),
  xai: join('xai', '_', 'A1b2C3d4E5f6G7h8I9j0K1'),
  jwt: join('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
};
const PEM = join(
  '-----BEGIN ',
  'RSA PRIVATE KEY-----\n',
  'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB\n',
  'aFDrBz9vFqU4yQ==\n',
  '-----END ',
  'RSA PRIVATE KEY-----'
);

function redacted(text) {
  return redactSecrets(text).text;
}

test('known credential formats are replaced whole', () => {
  for (const [name, secret] of Object.entries(FAKE)) {
    const result = redactSecrets(`before ${secret} after`);
    assert.equal(result.text, 'before [secret] after', name);
    assert.equal(result.count, 1, name);
  }
});

test('the sk- pattern already covers OpenRouter sk-or-v1 keys', () => {
  assert.equal(redacted(`OpenRouter key ${FAKE.openrouter}.`), 'OpenRouter key [secret].');
});

test('PEM private keys are replaced from BEGIN through END', () => {
  const result = redactSecrets(`key:\n${PEM}\nend of file`);
  assert.equal(result.text, 'key:\n[secret]\nend of file');
  assert.equal(result.count, 1);
  // Public material is not a secret.
  const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  assert.equal(redacted(cert), cert);
});

test('unterminated PEM headers scan in linear time', () => {
  const text = `${'-----BEGIN PRIVATE KEY-----\n'.repeat(40000)}no end`;
  const started = Date.now();
  assert.equal(redactSecrets(text).count, 0);
  assert.ok(Date.now() - started < 1000);
});

test('URL credentials keep scheme, user and host', () => {
  assert.equal(
    redacted('MONGO_URI=mongodb+srv://app:hunter22@cluster0.example.net/db?retryWrites=true'),
    'MONGO_URI=mongodb+srv://app:[secret]@cluster0.example.net/db?retryWrites=true'
  );
  assert.equal(redacted('postgres://admin:p%40ss@db:5432/main'), 'postgres://admin:[secret]@db:5432/main');
  assert.equal(redacted('redis://:s3cret@cache:6379'), 'redis://:[secret]@cache:6379');
  assert.equal(
    redacted(`git clone https://x-access-token:${FAKE.github}@github.com/o/r.git`),
    'git clone https://x-access-token:[secret]@github.com/o/r.git'
  );
  // No password, a port, or an email address is not a URL credential.
  for (const text of ['https://example.com:8443/path', 'ssh://git@github.com/o/r', 'mail me at a@b.co']) {
    assert.equal(redacted(text), text);
  }
});

test('labelled values keep the label', () => {
  const cases = [
    ['Authorization: Bearer abc123def456ghi', 'Authorization: Bearer [secret]'],
    ['curl -H "Authorization: bearer abc123def456"', 'curl -H "Authorization: bearer [secret]"'],
    ['export DB_PASSWORD=hunter22', 'export DB_PASSWORD=[secret]'],
    ['OPENAI_API_KEY="abc123-xyz789"', 'OPENAI_API_KEY="[secret]"'],
    ['api-key: 9f8e7d6c5b', 'api-key: [secret]'],
    ['passwd = Tr0ub4dor&3', 'passwd = [secret]'],
    ["client_secret: 'whatever-it-is'", "client_secret: '[secret]'"],
    ['{"password": "correcthorse", "user": "jo"}', '{"password": "[secret]", "user": "jo"}'],
    ['token=abc123def456,', 'token=[secret],'],
    ['X-API-KEY: 0a1b2c3d4e', 'X-API-KEY: [secret]'],
    ["SECRET_KEY = 'django-insecure-abc'", "SECRET_KEY = '[secret]'"],
    [join('AWS_SECRET_ACCESS_KEY=', 'wJalrXUtnFEMI/K7MDENG/bPxRfi'), 'AWS_SECRET_ACCESS_KEY=[secret]']
  ];
  for (const [input, expected] of cases) assert.equal(redacted(input), expected, input);
});

test('a known token behind a label is counted once', () => {
  const result = redactSecrets(`Authorization: Bearer ${FAKE.openai}\nOPENAI_API_KEY=${FAKE.openai}`);
  assert.equal(result.text, 'Authorization: Bearer [secret]\nOPENAI_API_KEY=[secret]');
  assert.equal(result.count, 2);
});

test('ordinary prose and code stay intact', () => {
  const untouched = [
    'the token budget is 500',
    'The token budget: 500 tokens per request.',
    'max_tokens: 4096',
    'Set max_completion_tokens = 2048 and temperature = 0.2.',
    'Use a password manager and rotate your API key regularly.',
    'The bearer of this letter is a friend.',
    'A secret: the cake is a lie.',
    'tokenizer: "o200k_base"',
    'const token = getToken();',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'api_key = os.environ["OPENAI_API_KEY"]',
    "password = request.form['password']",
    'secret = os.urandom(32)',
    'token = jwt.sign(payload, secret)',
    'token: string;',
    'password: Optional[str] = None',
    'api_key=None',
    'headers = {"Authorization": f"Bearer {token}"}',
    'Authorization: Bearer ${TOKEN}',
    'password: ${{ secrets.DB_PASSWORD }}',
    'TOKEN=$GITHUB_TOKEN',
    'if (token === expected) return;',
    'self.secret_key = settings.SECRET_KEY',
    'sk-learn is fine, task-oriented too',
    'see https://example.com/docs#api-key'
  ];
  for (const text of untouched) {
    const result = redactSecrets(text);
    assert.equal(result.text, text, text);
    assert.equal(result.count, 0, text);
  }
});

test('redaction inside JSON-encoded tool arguments keeps the JSON valid', () => {
  const args = JSON.stringify({
    command: `export DB_PASSWORD=hunter22\\x && curl -H "Authorization: Bearer ${FAKE.openai}"`,
    env: { API_KEY: 'abc123def456' },
    pem: PEM
  });
  const result = redactSecrets(args);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.command.includes('hunter22'), false);
  assert.equal(parsed.command.includes(FAKE.openai), false);
  assert.equal(parsed.pem, '[secret]');
  assert.ok(result.count >= 3);
});

test('non-strings pass through', () => {
  assert.deepEqual(redactSecrets(undefined), { text: undefined, count: 0 });
  assert.deepEqual(redactSecrets(''), { text: '', count: 0 });
});

test('redactEgressBody scrubs every text field the model would see', () => {
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${FAKE.openai}` } };
  const audio = { type: 'input_audio', input_audio: { data: FAKE.openai, format: 'wav' } };
  const body = {
    model: 'cloud/model',
    instructions: `use ${FAKE.deepseek}`,
    system: [{ type: 'text', text: `key ${FAKE.anthropic}` }],
    messages: [
      { role: 'system', content: `secret ${FAKE.lloom}` },
      { role: 'user', content: [{ type: 'text', text: `my key is ${FAKE.openrouter}` }, image, audio] },
      {
        role: 'assistant',
        content: null,
        reasoning_content: `they pasted ${FAKE.github}`,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'shell', arguments: JSON.stringify({ cmd: `echo ${FAKE.aws}` }) }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: `AWS_SECRET=${FAKE.aws}` }
    ],
    tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }]
  };
  const before = structuredClone(body);
  const result = redactEgressBody(body);
  assert.deepEqual(body, before, 'caller body must not be mutated');
  const out = result.body;
  assert.equal(out.instructions, 'use [secret]');
  assert.equal(out.system[0].text, 'key [secret]');
  assert.equal(out.messages[0].content, 'secret [secret]');
  assert.equal(out.messages[1].content[0].text, 'my key is [secret]');
  assert.equal(out.messages[1].content[1], image, 'image parts are untouched');
  assert.equal(out.messages[1].content[2], audio, 'audio parts are untouched');
  assert.equal(out.messages[2].reasoning_content, 'they pasted [secret]');
  assert.deepEqual(JSON.parse(out.messages[2].tool_calls[0].function.arguments), { cmd: 'echo [secret]' });
  assert.equal(out.messages[2].tool_calls[0].function.name, 'shell');
  assert.equal(out.messages[3].content, 'AWS_SECRET=[secret]');
  assert.equal(out.tools, body.tools);
  assert.equal(out.model, 'cloud/model');
  assert.equal(result.count, 7);
});

test('redactEgressBody covers prompt and input shapes', () => {
  assert.deepEqual(redactEgressBody({ prompt: `a ${FAKE.xai}` }).body, { prompt: 'a [secret]' });
  assert.deepEqual(redactEgressBody({ prompt: [`a ${FAKE.xai}`, 'b'] }).body, { prompt: ['a [secret]', 'b'] });
  assert.deepEqual(redactEgressBody({ input: `say ${FAKE.jina}` }).body, { input: 'say [secret]' });
  const items = redactEgressBody({
    input: [
      { role: 'user', content: [{ type: 'input_text', text: `k=${FAKE.replicate}` }] },
      { type: 'function_call', call_id: 'c', name: 'f', arguments: `{"t":"${FAKE.huggingface}"}` },
      { type: 'function_call_output', call_id: 'c', output: `got ${FAKE.google}` },
      { type: 'input_image', image_url: `https://example.com/${FAKE.openai}.png` }
    ]
  }).body.input;
  assert.equal(items[0].content[0].text, 'k=[secret]');
  assert.equal(items[1].arguments, '{"t":"[secret]"}');
  assert.equal(items[2].output, 'got [secret]');
  assert.equal(items[3].image_url, `https://example.com/${FAKE.openai}.png`);
});

test('redactEgressBody returns the same object when nothing matches', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'the token budget is 500' }] };
  const result = redactEgressBody(body);
  assert.equal(result.body, body);
  assert.equal(result.count, 0);
  for (const value of [null, undefined, 'text', [1, 2]]) assert.equal(redactEgressBody(value).body, value);
});

test('isInternalHost classifies local, private and tailnet hosts', () => {
  const internal = [
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '127.9.9.9',
    '[::1]',
    '::1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.20',
    '169.254.10.10',
    '100.64.0.1',
    '100.127.255.254',
    'fc00::1',
    'fd12:3456::1',
    '[fe80::1]',
    '::ffff:10.1.2.3',
    '::ffff:a01:203',
    'ennspark03',
    'ennspark03.tail1234.ts.net',
    'nas.local',
    'gpu.internal',
    'NAS.LOCAL.'
  ];
  const external = [
    'api.deepseek.com',
    'openrouter.ai',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '100.128.0.1',
    '100.63.255.255',
    '192.169.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    'ts.net.example.com',
    'evil-ts.net',
    ''
  ];
  for (const host of internal) assert.equal(isInternalHost(host), true, host);
  for (const host of external) assert.equal(isInternalHost(host), false, host);
});

test('shouldRedactEgress honours the global switch, overrides and federation', () => {
  const cloud = { type: 'openai', baseUrl: 'https://api.deepseek.com/v1' };
  const lan = { type: 'openai', baseUrl: 'http://192.168.1.20:8000/v1' };
  const tailnet = { type: 'openai', baseUrl: 'http://ennspark03:8000/v1' };
  const config = (redactEgress, extra = {}) => ({ security: { redactEgress }, backends: {}, ...extra });

  assert.equal(shouldRedactEgress(config(undefined), 'cloud', cloud), false, 'off by default');
  assert.equal(shouldRedactEgress(config(false), 'cloud', cloud), false);
  assert.equal(shouldRedactEgress(config(true), 'cloud', cloud), true);
  assert.equal(shouldRedactEgress(config(true), 'lan', lan), false);
  assert.equal(shouldRedactEgress(config(true), 'tailnet', tailnet), false);
  assert.equal(shouldRedactEgress(config(true), 'bad', { baseUrl: 'not a url' }), true, 'unknown hosts fail safe');

  // A per-backend override wins in either direction.
  assert.equal(shouldRedactEgress(config(false), 'lan', { ...lan, redact: true }), true);
  assert.equal(shouldRedactEgress(config(true), 'cloud', { ...cloud, redact: false }), false);

  // Provider adapters call their fixed cloud origin whatever baseUrl says.
  assert.equal(shouldRedactEgress(config(true), 'music', { ...lan, audioProvider: 'openrouter' }), true);
  assert.equal(shouldRedactEgress(config(true), 'video', { videoProvider: 'replicate' }), true);

  // Another LLooM gateway applies its own policy when it egresses.
  const federated = config(true, {
    cluster: { nodes: { edge: { endpoint: 'https://edge.example.com', proxy: { models: ['m'] } } } }
  });
  const federatedBackend = { type: 'openai', baseUrl: 'https://edge.example.com/v1' };
  assert.equal(shouldRedactEgress(federated, 'lloom-node-edge', federatedBackend), false);
  assert.equal(shouldRedactEgress(federated, 'lloom-node-edge', { ...federatedBackend, redact: true }), true);
  assert.equal(shouldRedactEgress(federated, 'other', federatedBackend), true);
});

test('config defaults redactEgress to false and validates both keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-egress-config-'));
  const write = async (extra) => {
    const file = path.join(dir, `config-${Math.random().toString(16).slice(2)}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({
        backends: { cloud: { type: 'openai', baseUrl: 'https://api.deepseek.com/v1' } },
        models: [{ id: 'm', backend: 'cloud' }],
        ...extra
      })
    );
    return file;
  };
  try {
    const defaults = await loadConfig(await write({}), { env: {} });
    assert.equal(defaults.security.redactEgress, false);
    const enabled = await loadConfig(await write({ security: { redactEgress: true } }), { env: {} });
    assert.equal(enabled.security.redactEgress, true);
    await assert.rejects(
      loadConfig(await write({ security: { redactEgress: 'yes' } }), { env: {} }),
      /security\.redactEgress must be a boolean/
    );
    await assert.rejects(
      loadConfig(await write({ backends: { cloud: { type: 'openai', baseUrl: 'https://x.example/v1', redact: 1 } } }), {
        env: {}
      }),
      /backends\.cloud\.redact must be a boolean/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gateway integration: the outgoing upstream body is captured through a mocked
// undici dispatcher, so no request leaves the machine.
// ---------------------------------------------------------------------------

const CHAT_REPLY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};
const STREAM_REPLY = [
  'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  ''
].join('\n');

async function readBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function withGateway({ redactEgress, backend = {} }, fn) {
  const previous = getGlobalDispatcher();
  const mockAgent = new MockAgent({ agent: new Agent({ headersTimeout: 60000, bodyTimeout: 60000 }) });
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect((host) => typeof host === 'string' && host.startsWith('127.0.0.1'));
  setGlobalDispatcher(mockAgent);
  const seen = [];
  const pool = mockAgent.get('https://api.deepseek.com');
  // One upstream reply per gateway call, shaped for the route and stream flag.
  const expectUpstream = (route, stream) =>
    pool.intercept({ path: route, method: 'POST' }).reply(
      200,
      async (opts) => {
        seen.push({ route, body: JSON.parse(await readBody(opts.body)) });
        if (route === '/v1/embeddings') return { object: 'list', data: [{ index: 0, embedding: [0.1] }] };
        if (route === '/v1/audio/transcriptions') return { text: 'ok' };
        return stream ? STREAM_REPLY : CHAT_REPLY;
      },
      { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } }
    );
  const app = createLloomServer(
    {
      server: { host: '127.0.0.1', port: 0 },
      security: { allowMissingAuth: true, apiKeys: [], redactEgress },
      defaults: { chatModel: 'deepseek-chat' },
      backends: { deepseek: { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', ...backend } },
      models: [
        { id: 'deepseek-chat', backend: 'deepseek', upstreamModel: 'deepseek-chat', kind: 'chat' },
        { id: 'deepseek-embed', backend: 'deepseek', upstreamModel: 'embed', kind: 'embedding' },
        { id: 'deepseek-stt', backend: 'deepseek', upstreamModel: 'stt', kind: 'audio_transcription' }
      ],
      runtimes: {}
    },
    { logger: { error() {}, warn() {}, info() {}, log() {} }, upstreamDispatcher: mockAgent }
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body, headers = {}) => {
    const passthrough = ['/v1/embeddings', '/v1/audio/transcriptions'].includes(route);
    expectUpstream(passthrough ? route : '/v1/chat/completions', body.stream === true);
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return text;
  };
  try {
    await fn({ post, seen });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    setGlobalDispatcher(previous);
    await mockAgent.close();
  }
}

const userSecret = `deploy with ${FAKE.openai}`;

test('gateway redacts chat, Responses and Anthropic requests sent to an external backend, not embeddings or transcriptions', async () => {
  await withGateway({ redactEgress: true }, async ({ post, seen }) => {
    await post('/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: userSecret }] });
    await post('/v1/chat/completions', {
      model: 'deepseek-chat',
      stream: true,
      messages: [{ role: 'user', content: userSecret }]
    });
    await post('/v1/responses', { model: 'deepseek-chat', instructions: userSecret, input: userSecret });
    await post(
      '/v1/messages',
      { model: 'deepseek-chat', max_tokens: 16, system: userSecret, messages: [{ role: 'user', content: userSecret }] },
      { 'anthropic-version': '2023-06-01' }
    );
    await post('/v1/embeddings', { model: 'deepseek-embed', input: userSecret });
    await post('/v1/audio/transcriptions', {
      model: 'deepseek-stt',
      file: 'data:audio/wav;base64,AAAA',
      prompt: userSecret
    });

    const chat = seen.filter((entry) => entry.route === '/v1/chat/completions');
    assert.equal(chat.length, 4);
    for (const { body } of chat) {
      const outbound = JSON.stringify(body.messages);
      assert.equal(outbound.includes(FAKE.openai), false, outbound);
      assert.match(outbound, /deploy with \[secret\]/);
    }
    const embedding = seen.find((entry) => entry.route === '/v1/embeddings');
    assert.equal(embedding.body.input, userSecret, 'embeddings are never rewritten');
    const transcription = seen.find((entry) => entry.route === '/v1/audio/transcriptions');
    assert.equal(transcription.body.prompt, userSecret, 'transcriptions are never rewritten');
  });
});

test('gateway leaves external requests untouched when redaction is off or overridden', async () => {
  for (const options of [{ redactEgress: false }, { redactEgress: true, backend: { redact: false } }]) {
    await withGateway(options, async ({ post, seen }) => {
      await post('/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: userSecret }] });
      assert.equal(seen[0].body.messages[0].content, userSecret);
    });
  }
});
