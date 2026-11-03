// SPDX-License-Identifier: MIT
// Token hashing/equality adapted from enntity-messenger/src/auth.js (08a788e).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import http from 'node:http';

export const id = () => randomUUID();
export const token = () => `accord_${randomBytes(32).toString('base64url')}`;
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export function monotonicWallClock() {
  const wall = Date.now(), monotonic = performance.now();
  return () => Math.floor(wall + performance.now() - monotonic);
}
export function equal(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function fail(code, message, status = 409) {
  throw Object.assign(new Error(message), { code, status });
}
export function requireThat(condition, code, message, status = 409) {
  if (!condition) fail(code, message, status);
}
export function text(value, name, max = 2000) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max,
    'INVALID_INPUT', `${name} must be a nonempty string of at most ${max} characters`, 400);
  return value;
}
export function integer(value, name, min, max) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max,
    'INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`, 400);
  return value;
}
export function bearer(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  requireThat(match, 'AUTH_REQUIRED', 'A bearer credential is required', 401);
  return match[1];
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function database(file, sql) {
  // HTTP-only clients must not initialize SQLite (or emit its runtime warning).
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const migrations = Array.isArray(sql) ? sql : [sql];
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)');
    transaction(db, () => {
      const rows = db.prepare('SELECT * FROM migrations ORDER BY version').all();
      requireThat(rows.every((row, i) => row.version === i + 1 && migrations[i] && row.checksum === hash(migrations[i])),
        'SCHEMA_MISMATCH', 'Unsupported or changed database migration', 503);
      for (let i = rows.length; i < migrations.length; i++) {
        db.exec(migrations[i]);
        db.prepare('INSERT INTO migrations VALUES(?,?)').run(i + 1, hash(migrations[i]));
      }
    });
    return db;
  } catch (error) { db.close(); throw error; }
}
export async function readBody(req) {
  requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE', 'Use application/json', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    requireThat(bytes <= 32768, 'BODY_TOO_LARGE', 'Body exceeds 32 KiB', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON', 'Expected an object', 400);
    return value;
  } catch (e) { if (e.code) throw e; fail('INVALID_JSON', 'Invalid JSON', 400); }
}
export function createHttp(handler) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // A local SSH forward can use a different port from the listening socket.
      // Keep the loopback hostname restriction and exact browser origin match.
      const host = req.headers.host || '';
      requireThat(/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(host) && Number(host.split(':')[1]) <= 65535,
        'BAD_HOST', 'Unexpected Host', 403);
      requireThat(!req.headers.origin || req.headers.origin === `http://${host}`, 'BAD_ORIGIN', 'Cross-origin requests refused', 403);
      const url = new URL(req.url, 'http://localhost');
      const result = await handler(req, res, url);
      if (!res.writableEnded) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result ?? {}));
      }
    } catch (error) {
      if (!res.writableEnded) {
        res.statusCode = error.status || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error; no success acknowledged' }, ...(error.inboxPending?{inboxPending:error.inboxPending}:{}),...(error.deliveryProblems?{deliveryProblems:error.deliveryProblems}:{}) }));
      }
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}
export function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
// A local client talks over a socket in the private data directory. Any user can hold a
// loopback port while the service is down, so a client must never prove itself to one.
export async function listenLocal(server, directory) {
  if (process.platform === 'win32') return null;
  const path = directory + '/accord.sock';
  requireThat(Buffer.byteLength(path) < 104, 'DATA_PATH', 'Data directory path is too long for a local socket', 400);
  chmodSync(directory, 0o700); rmSync(path, { force: true });
  const local = http.createServer((req, res) => server.emit('request', req, res));
  await new Promise((resolve, reject) => { local.once('error', reject); local.listen(path, resolve); });
  chmodSync(path, 0o600);
  return { url: `unix:${path}`, close() { local.closeAllConnections(); local.close(); rmSync(path, { force: true }); } };
}
function overSocket(url, credential, path, body, timeout) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath: url.slice(5), path, method: payload === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeout),
      headers: { Host: 'localhost:8787', Authorization: `Bearer ${credential}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode < 300, json: async () => JSON.parse(Buffer.concat(chunks)) }));
    });
    outgoing.on('error', reject); outgoing.end(payload);
  });
}
export async function request(url, credential, path, body, timeout = 2000) {
  const response = url.startsWith('unix:') ? await overSocket(url, credential, path, body, timeout) : await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout), redirect: 'error'
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Request failed'), { code: result.error?.code, status: response.status, ...(result.inboxPending?{inboxPending:result.inboxPending}:{}),...(result.deliveryProblems?{deliveryProblems:result.deliveryProblems}:{}) });
  return result;
}

export function loopbackUrl(value) {
  if (value.startsWith('unix:') && isAbsolute(value.slice(5))) return value;
  const url = new URL(value);
  requireThat(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'BAD_ENDPOINT', 'Use a loopback HTTP origin; remote hosts require an authenticated SSH tunnel', 400);
  return url.origin;
}
