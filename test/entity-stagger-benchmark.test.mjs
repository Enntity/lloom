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
let active = 0;
let maxActive = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      [
        `sglang:num_running_reqs{model_name="entity-model"} ${active}`,
        'sglang:num_queue_reqs{model_name="entity-model"} 0',
        `sglang:prompt_tokens_total{model_name="entity-model"} ${promptTokens}`,
        `sglang:generation_tokens_total{model_name="entity-model"} ${generationTokens}`
      ].join('\n')
    );
    return;
  }
  if (req.url === '/gateway/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        runtimeManager: {
          runtimes: {
            entity: {
              healthy: true,
              status: 'running',
              activeRequests: active,
              queuedRequests: 0,
              admissionQueuedRequests: 0
            }
          }
        }
      })
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
  assert.equal(request.model, 'entity-model');
  assert.equal(request.tools.length, 16);
  assert.equal(request.stream_options.include_usage, true);
  assert(JSON.stringify(request.messages).length >= 1000);
  const reportedPromptTokens = JSON.stringify(request.messages).length >= 100_000 ? 20_000 : 250;
  active += 1;
  maxActive = Math.max(maxActive, active);
  promptTokens += reportedPromptTokens;
  generationTokens += 8;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { reasoning_content: 'Checking.' }, finish_reason: null }]
    })}\n\n`
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  res.write(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_presence',
                function: { name: 'report_presence', arguments: '{"state":"steady"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: reportedPromptTokens,
        completion_tokens: 8,
        total_tokens: reportedPromptTokens + 8
      }
    })}\n\n`
  );
  active -= 1;
  res.end('data: [DONE]\n\n');
});

const port = await listen(server);
try {
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts', 'entity-stagger-benchmark.mjs'),
      '--base-url',
      `http://127.0.0.1:${port}/v1`,
      '--gateway-status-url',
      `http://127.0.0.1:${port}/gateway/status`,
      '--backend-metrics-url',
      `http://127.0.0.1:${port}/metrics`,
      '--model',
      'entity-model',
      '--runtime',
      'entity',
      '--profiles',
      'long:2000:0,medium:1500:5,short:1000:10',
      '--max-tokens',
      '8',
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
  assert.equal(result.results.length, 3);
  assert.equal(result.promptTokens, 750);
  assert.equal(result.completionTokens, 24);
  assert(result.results.every((entry) => entry.toolDeltaSeen));
  assert(result.gateway.samples > 0);
  assert(result.backend.after.generationTokens > result.backend.before.generationTokens);
  assert(maxActive >= 2);

  const presetChild = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts', 'entity-stagger-benchmark.mjs'),
      '--base-url',
      `http://127.0.0.1:${port}/v1`,
      '--model',
      'entity-model',
      '--preset',
      'continuity-16k-stagger',
      '--max-tokens',
      '8',
      '--first-content-timeout-ms',
      '1000',
      '--total-timeout-ms',
      '5000'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let presetStdout = '';
  let presetStderr = '';
  presetChild.stdout.on('data', (chunk) => {
    presetStdout += chunk;
  });
  presetChild.stderr.on('data', (chunk) => {
    presetStderr += chunk;
  });
  const presetExitCode = await new Promise((resolve) => presetChild.once('exit', resolve));
  assert.equal(presetExitCode, 0, presetStderr);
  const presetResult = JSON.parse(presetStdout);
  assert.equal(presetResult.pass, true);
  assert.equal(presetResult.preset, 'continuity-16k-stagger');
  assert.deepEqual(
    presetResult.profiles.map((profile) => profile.offsetMs),
    [0, 1000, 2000, 3000]
  );
  assert(presetResult.results.every((entry) => entry.promptTokens >= 16_384));
  assert.equal(typeof presetResult.ttftMs.mean, 'number');
  assert(presetResult.ttftMs.max >= presetResult.ttftMs.min);
} finally {
  await close(server);
}

console.log('entity stagger benchmark tests passed');
