import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { firstRunPage } from './first-run-page.mjs';

const MAX_BODY = 8192;
const TTL = 30 * 60 * 1000;
const WORKLOADS = new Set(['chat', 'code', 'images', 'voice']);
const digest = (value) => createHash('sha256').update(String(value)).digest();
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function shouldOpenSetup(args, { installed = false, interactive = false } = {}) {
  if (
    installed ||
    args.some((arg) => ['--json', '--offline', '--no-browser', '--go', '--apply', '--recipe', '--format'].includes(arg))
  )
    return false;
  return args.includes('--browser') || interactive;
}

export function openLocalBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw failure('Expected application/json.', 415);
  let bytes = 0,
    text = '';
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw failure('Request body too large.', 413);
    text += chunk;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw failure('Invalid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Expected a JSON object.');
  return body;
}

export function createFirstRunServer({
  planBuilder,
  applyRunner,
  gatewayStarter,
  gatewayProbe,
  now = Date.now,
  port = 0,
  host = '127.0.0.1',
  planTtlMs = TTL,
  logger = console
}) {
  if (host !== '127.0.0.1' && host !== '::1') throw failure('Setup must bind to loopback.');
  if (typeof planBuilder !== 'function' || typeof applyRunner !== 'function')
    throw failure('Setup requires a planner and installer.');
  const secret = randomBytes(32).toString('base64url');
  const plans = new Map();
  let job = null;
  let activeRun = null;
  let activeEntry = null;
  const hostname = host === '::1' ? '[::1]' : host;
  const origin = () => 'http://' + hostname + ':' + server.address().port;
  const reply = (res, status, body) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    res.end(JSON.stringify(body));
  };
  const snapshot = () => (job ? structuredClone(job) : null);
  function progress(event) {
    if (!job || job.status !== 'running') return;
    const detail = String(event?.message ?? event?.detail ?? event?.label ?? event?.type ?? 'Installing').slice(
      0,
      1500
    );
    const id = String(event?.phase ?? event?.stage ?? event?.id ?? 'install').slice(0, 120);
    job.stage = { id, status: 'active', detail };
    if (job.stages.at(-1)?.id !== id) job.stages.push({ id, title: detail, status: 'active' });
    else job.stages.at(-1).title = detail;
    if (job.stages.length > 50) job.stages.shift();
  }
  async function run(entry) {
    try {
      const report = await applyRunner(entry.plan, { onProgress: progress });
      if (report?.ok === false)
        throw new Error(
          report.error ||
            report.stages?.find((s) => ['failed', 'blocked'].includes(s.status))?.summary ||
            'Installation did not complete. Run lloom doctor for details.'
        );
      job.stage = { id: 'gateway', status: 'active', detail: 'Starting the gateway' };
      const gateway = gatewayStarter ? await gatewayStarter(report.configPath ?? entry.plan.configPath) : null;
      if (gateway?.ok === false || gateway?.status === 'failed')
        throw new Error(gateway.error || 'The gateway did not start.');
      job.stage = { id: 'verify', status: 'active', detail: 'Checking a request through the gateway' };
      const probe = gatewayProbe ? await gatewayProbe(report, entry.plan, gateway) : {};
      job.inferenceVerified = probe?.inferenceVerified === true;
      job.ready = job.inferenceVerified;
      job.healthy = probe?.healthy === true;
      job.endpoint = probe?.endpoint ?? gateway?.url ?? report.dashboardUrl ?? null;
      job.detail = probe?.detail ?? 'Installed. Model inference has not been verified yet.';
      job.status = 'succeeded';
      job.stages.forEach((stage) => (stage.status = 'complete'));
      job.stage = { id: 'verify', status: job.ready ? 'complete' : 'pending', detail: job.detail };
      const verifyStage = job.stages.find((stage) => stage.id === 'verify');
      const finalVerify = {
        id: 'verify',
        title: job.ready ? 'Inference verified' : 'Inference not verified',
        status: job.ready ? 'complete' : 'pending'
      };
      if (verifyStage) Object.assign(verifyStage, finalVerify);
      else job.stages.push(finalVerify);
    } catch (error) {
      job.status = 'failed';
      job.error = String(error.message).slice(0, 1500);
      job.stage = { ...job.stage, status: 'failed', detail: job.error };
      if (job.stages.length) job.stages.at(-1).status = 'failed';
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Exact authority stops DNS rebinding and alternate-port attacks.
      if (req.headers.host !== new URL(origin()).host)
        throw failure('Use the local setup address from your terminal.', 403);
      const url = new URL(req.url, origin());
      if (url.origin !== origin()) throw failure('Invalid setup address.', 403);
      if (req.headers.origin !== undefined && req.headers.origin !== origin())
        throw failure('Cross-site setup requests are denied.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw failure('Cross-site setup requests are denied.', 403);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        });
        res.end(firstRunPage());
        return;
      }
      const token = String(req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1] || '';
      if (!timingSafeEqual(digest(token), digest(secret)))
        throw failure('Setup session expired. Reopen setup from your terminal.', 401);
      if (req.method === 'GET' && url.pathname === '/gateway/first-run/job') {
        reply(res, 200, { ok: true, job: snapshot() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/gateway/first-run/plan') {
        if (job?.status === 'running')
          throw failure('Installation is already running. Resume its progress instead.', 409);
        const workloadId = url.searchParams.get('workload') || 'chat';
        const recipeId = url.searchParams.get('recipe') || undefined;
        if (!WORKLOADS.has(workloadId) || (recipeId && recipeId.length > 200))
          throw failure('Unknown workload or recipe.');
        const retry =
          job?.status === 'failed' &&
          activeEntry?.view.workloadId === workloadId &&
          (!recipeId || activeEntry.view.selected.id === recipeId);
        if (retry && now() - activeEntry.createdAt > planTtlMs)
          throw failure('The reviewed recovery plan expired. Continue with lloom bootstrap from your terminal.', 410);
        const built = retry ? activeEntry : await planBuilder({ workloadId, recipeId });
        if (!built?.plan || !built?.view?.selected?.id)
          throw failure('No compatible recipe was found for this machine.', 422);
        for (const [id, value] of plans) if (now() - value.createdAt > planTtlMs) plans.delete(id);
        while (plans.size >= 12) plans.delete(plans.keys().next().value);
        const planId = randomBytes(24).toString('base64url');
        plans.set(planId, { plan: built.plan, view: built.view, createdAt: retry ? activeEntry.createdAt : now() });
        reply(res, 200, { ok: true, plan: { ...built.view, workloadId, planId } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/gateway/first-run/apply') {
        const body = await readBody(req);
        if (Object.keys(body).some((key) => !['planId', 'yes', 'workloadId'].includes(key)))
          throw failure('Apply accepts only a reviewed plan, workload, and confirmation.');
        if (body.yes !== true) throw failure('Review and confirm the plan before installing.');
        if (job?.planId === body.planId) {
          reply(res, 200, { ok: true, job: snapshot(), resumed: true });
          return;
        }
        if (job?.status === 'running') throw failure('Another installation is already running.', 409);
        const entry = plans.get(body.planId);
        if (!entry) throw failure('Plan not found. Review a fresh plan.', 404);
        if (now() - entry.createdAt > planTtlMs) throw failure('This plan expired. Review a fresh plan.', 410);
        if (body.workloadId && body.workloadId !== entry.view.workloadId)
          throw failure('The workload differs from the reviewed plan.', 409);
        plans.delete(body.planId);
        activeEntry = entry;
        job = {
          id: randomBytes(16).toString('hex'),
          planId: body.planId,
          status: 'running',
          stages: [],
          stage: { id: 'install', status: 'active', detail: 'Installing the reviewed recipe' },
          ready: false,
          inferenceVerified: false,
          healthy: false,
          error: null,
          endpoint: null,
          detail: null
        };
        activeRun = run(entry);
        reply(res, 202, { ok: true, job: snapshot() });
        return;
      }
      throw failure('Setup endpoint not found.', 404);
    } catch (error) {
      if (!error.statusCode) logger.error?.('Setup request failed: ' + error.message);
      reply(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });
  server.requestTimeout = 30000;
  return {
    server,
    bootstrapUrl: () => origin() + '/#setup=' + secret,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return this;
    },
    async close() {
      await activeRun;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    }
  };
}
