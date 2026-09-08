import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createLloomServer } from '../src/server.mjs';
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const previous = getGlobalDispatcher();
const shortDefault = new Agent({ headersTimeout: 10, bodyTimeout: 10 });
const client = new Agent({ headersTimeout: 5000, bodyTimeout: 5000 });
setGlobalDispatcher(shortDefault);
try {
  for (const phase of ['headers', 'body']) {
    const upstream = http.createServer((req, res) => {
      req.resume();
      if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': waiting\n\n');
      }
      const timer = setTimeout(() => {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }, 1600);
      res.on('close', () => clearTimeout(timer));
    });
    const upPort = await listen(upstream);
    const app = createLloomServer(
      {
        server: { host: '127.0.0.1', port: 0 },
        security: { allowMissingAuth: true, apiKeys: [] },
        defaults: { chatModel: 'test' },
        backends: { local: { type: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, timeoutMs: 5000 } },
        models: [
          { id: 'test', backend: 'local', upstreamModel: 'test', kind: 'chat', contextWindow: 1, maxPromptTokens: 0 }
        ],
        runtimes: {}
      },
      { logger: { error() {}, warn() {} } }
    );
    const port = await listen(app.server);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        dispatcher: client,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'test' }], stream: true })
      });
      const body = await r.text();
      assert.equal(r.status, 200);
      assert.match(body, /"content":"OK"/);
      assert.doesNotMatch(body, /server_error/);
      console.log(`${phase}: cold prefill outlives default transport timeout`);
    } finally {
      await app.close({ stopRuntimes: false });
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  }
} finally {
  setGlobalDispatcher(previous);
  await shortDefault.close();
  await client.close();
}
