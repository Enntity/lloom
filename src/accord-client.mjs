// LLooM consumes the standalone Accord package. It does not own a second host.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { AccordClient } from '../vendor/accord/src/client.mjs';
import { profileAt } from '../vendor/accord/src/bootstrap.mjs';
import { request } from '../vendor/accord/src/common.mjs';
export { ensureAccord } from '../vendor/accord/src/product-install.mjs';
export function accordProfile(env = process.env) {
  return env.ACCORD_PROFILE || join(env.HOME || homedir(), '.config/accord/connection.json');
}
export function accordConnection(env = process.env) {
  return profileAt(accordProfile(env));
}
export function accordAdmin(env = process.env) {
  const p = accordConnection(env);
  return new AccordClient(p.url, readFileSync(join(dirname(p.endpointFile), 'admin.token'), 'utf8').trim());
}
export async function accordSample(kind, { env = process.env } = {}) {
  const p = accordConnection(env),
    token = readFileSync(p.discoveryFile, 'utf8').trim();
  const s = await request(p.url, token, `/v1/host/${kind}`, undefined, kind === 'memory' ? 850 : 5000);
  if (s.authority !== p.authority || s.stale || s.status === 'unavailable')
    throw Object.assign(Error(`Accord ${kind} is unavailable; capacity is unknown`), {
      code: 'accord_unavailable',
      statusCode: 503
    });
  return s;
}
export function createHostTelemetry() {
  return {
    async snapshot() {
      try {
        const s = await accordSample('telemetry');
        return { ...s.host, sampledAt: new Date(s.sampledAt).toISOString(), authority: s.authority, stale: false };
      } catch {
        return {
          sampledAt: null,
          cpu: null,
          gpu: null,
          memory: null,
          stale: true,
          source: 'accord',
          status: 'unavailable'
        };
      }
    }
  };
}
