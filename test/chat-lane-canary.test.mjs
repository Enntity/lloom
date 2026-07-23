import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

let promptTokens = 100;
let generationTokens = 50;
const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      [
        'vllm:num_requests_running{engine="0",model_name="canary-model"} 0',
        'vllm:num_requests_waiting{engine="0",model_name="canary-model"} 0',
        `vllm:prompt_tokens_total{engine="0",model_name="canary-model"} ${promptTokens}`,
        `vllm:generation_tokens_total{engine="0",model_name="canary-model"} ${generationTokens}`
      ].join('\n')
    );
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  assert.equal(request.model, 'canary-model');
  assert.equal(request.tools.length, 12);
  assert(JSON.stringify(request.messages).length >= 1000);
  promptTokens += 250;
  generationTokens += 8;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { reasoning_content: 'Checking.' }, finish_reason: null }]
    })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_canary',
                function: { name: 'report_status', arguments: '{"status":"ok"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })}\n\n`
  );
  res.end('data: [DONE]\n\n');
});

const port = await listen(server);
try {
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts', 'chat-lane-canary.mjs'),
      '--base-url',
      `http://127.0.0.1:${port}/v1`,
      '--backend-metrics-url',
      `http://127.0.0.1:${port}/metrics`,
      '--model',
      'canary-model',
      '--concurrency',
      '2',
      '--prompt-bytes',
      '1000',
      '--first-content-timeout-ms',
      '1000',
      '--total-timeout-ms',
      '5000'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.pass, true);
  assert.equal(result.results.length, 2);
  assert(result.results.every((entry) => entry.toolDeltaSeen));
  assert.equal(result.backend.after.running, 0);
  assert(result.backend.after.generationTokens > result.backend.before.generationTokens);
} finally {
  await close(server);
}

console.log('chat lane canary tests passed');
