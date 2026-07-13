import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 8188);
const remoteHost = process.env.LLOOM_REMOTE_HOST?.trim();
const remoteEnvFile = process.env.LLOOM_REMOTE_ENV_FILE?.trim() || '$HOME/.config/lloom/env';
const imageModel = process.env.LLOOM_IMAGE_MODEL?.trim() || 'cyberdelia/CyberRealisticPony-v18';
const page = await readFile(new URL('./index.html', import.meta.url));

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function generate(payload) {
  return new Promise((resolve, reject) => {
    const remote = [
      'set -a;',
      '. "$HOME/.config/lloom/env";',
      'set +a;',
      'exec curl -sS --fail-with-body',
      '-H "Authorization: Bearer $LLOOM_API_KEY"',
      '-H "Content-Type: application/json"',
      '--data-binary @-',
      'http://127.0.0.1:8100/v1/images/generations'
    ].join(' ');
    if (!remoteHost) {
      reject(new Error('Set LLOOM_REMOTE_HOST to the LLooM SSH host.'));
      return;
    }
    const remoteCommand = remote.replace('$HOME/.config/lloom/env', remoteEnvFile);
    const child = spawn('ssh', [remoteHost, remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString('utf8') || output || `ssh exited ${code}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      send(res, 200, page, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'POST' && req.url === '/generate') {
      const input = JSON.parse(await readBody(req));
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) {
        send(res, 400, JSON.stringify({ error: 'Prompt is required.' }));
        return;
      }
      const size = ['512x512', '768x1024', '832x1216', '896x1152', '1024x768', '1024x1024'].includes(input.size)
        ? input.size
        : '832x1216';
      const output = await generate({
        model: imageModel,
        prompt,
        size,
        n: 1,
        response_format: 'b64_json'
      });
      send(res, 200, output);
      return;
    }
    send(res, 404, JSON.stringify({ error: 'Not found.' }));
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error?.message ?? String(error) }));
  }
}).listen(port, host, () => {
  console.log(`LLooM image playground: http://${host}:${port}`);
});
