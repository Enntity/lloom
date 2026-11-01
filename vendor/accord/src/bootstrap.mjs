// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { AccordClient } from './client.mjs';
import { loopbackUrl, request, requireThat } from './common.mjs';

export function profileAt(path) {
  const profile = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(profile.schema === 1 && typeof profile.authority === 'string', 'PROFILE_INVALID', 'Unsupported Accord connection profile');
  const endpoint = profile.endpointFile ? JSON.parse(readFileSync(profile.endpointFile, 'utf8')).coordinator : profile.url;
  return {...profile, url:loopbackUrl(endpoint)};
}
export async function discover(profile) {
  const descriptor = await request(profile.url, '', '/.well-known/accord');
  requireThat(descriptor.authority === profile.authority, 'AUTHORITY_MISMATCH', 'Pinned host identity changed');
  const host = await request(profile.url, readFileSync(profile.discoveryFile, 'utf8').trim(), '/v1/host');
  requireThat(host.authority === profile.authority, 'AUTHORITY_MISMATCH', 'Pinned host identity changed');
  return host;
}
export async function enrollProfile(path, {label = 'agent', harness = 'cli', ttlMs, key} = {}) {
  const profile = profileAt(path);
  const client = await AccordClient.enroll(profile.url, readFileSync(profile.enrollmentFile, 'utf8').trim(),
    {authority:profile.authority, label, harness, ttlMs, key});
  await bindNativeSession(profile,client);
  return client;
}
export function notice(host) {
  // Untrusted labels stay JSON-escaped, including terminal escape/control characters.
  const resources=(host.resources??[host.resource]).map(r=>`${r.id}: ${r.state}; driver=${r.driver}\n`+
    (r.holder?`Owner ${JSON.stringify(r.holder.label)}; generation ${r.holder.generation}; ${r.holder.state}\n`:''));
  return `Accord ${JSON.stringify(host.name)} (${host.authority})\n${resources.join('')}`+
    `Observed ${new Date(host.observedAt).toISOString()}. Acquire through Accord before controlled work.\n`;
}
export async function runAgent(profilePath, command, args) {
  requireThat(command, 'COMMAND_REQUIRED', 'Use accord run -- COMMAND [ARGS]', 400);
  const client = await enrollProfile(profilePath, {label:command, harness:command});
  const profile = profileAt(profilePath);
  const root = profile.sessionDirectory || join(dirname(resolve(profilePath)), 'sessions');
  mkdirSync(root, {recursive:true, mode:0o700});
  const directory = mkdtempSync(join(root, 'run-'));
  let child,heartbeat;
  try {
    const sessionFile = join(directory, 'session.json');
    writeFileSync(sessionFile, JSON.stringify({schema:1,url:client.url,...client.session}), {mode:0o600,flag:'wx'});
    const contextFile = join(directory, 'context.json');
    const context = await client.bootstrap();
    await client.collaborate('session-report',{key:'launcher-start',title:command,state:'working',location:process.cwd(),detail:'Managed agent session started'});
    heartbeat=setInterval(()=>client.collaborate('heartbeat').catch(()=>{}),30000);heartbeat.unref();
    writeFileSync(contextFile, JSON.stringify(context, null, 2), {mode:0o600,flag:'wx'});
    process.stderr.write(notice(context.host));
    child = spawn(command, args, {stdio:'inherit', shell:false, env:{...process.env,
      ACCORD_SESSION_FILE:sessionFile, ACCORD_CONTEXT_FILE:contextFile, ACCORD_SESSION_ID:client.session.sessionId,
      ACCORD_URL:client.url, ACCORD_PROFILE:resolve(profilePath)}});
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
    try {
      return await new Promise((resolve, reject) => {child.once('error',reject);child.once('exit',(code,signal)=>resolve(code ?? (signal ? 130 : 1)));});
    } finally {process.off('SIGTERM',terminate);process.off('SIGINT',terminate);}
  } finally {
    clearInterval(heartbeat);
    try {await client.closeSession();} catch {process.stderr.write('Accord session close unconfirmed; leases remain subject to recovery.\n');}
    rmSync(directory, {recursive:true, force:true});
  }
}
export function inheritedClient() {
  requireThat(process.env.ACCORD_SESSION_FILE, 'NO_SESSION', 'Start with accord run or use the MCP session', 400);
  const session = JSON.parse(readFileSync(process.env.ACCORD_SESSION_FILE,'utf8'));
  const client = new AccordClient(loopbackUrl(session.url), session.credential);client.session=session;return client;
}


// A trusted local launcher supplies native IDs from its environment, never from
// a model tool argument or a guessed working-directory/name match.
export async function bindNativeSession(profile,client){
  if(!profile.endpointFile)return;
  const bindings=[['codex',process.env.CODEX_THREAD_ID],['claude',process.env.CLAUDE_SESSION_ID],['tessera',process.env.TESSERA_TILE_ID]].filter(([,id])=>id);
  if(!bindings.length)return;
  const admin=readFileSync(join(dirname(profile.endpointFile),'admin.token'),'utf8').trim();
  for(const [source,externalId] of bindings)await request(profile.url,admin,'/v1/collaboration',{operation:'session-bind',args:{key:`bind:${client.session.sessionId}:${source}`,source,externalId,actor:client.session.sessionId}});
}
