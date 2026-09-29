// SSH is an operator-side transport. Planning/application stay in the reusable
// head-preparation module; no gateway HTTP handler executes SSH commands.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { applyHeadPreparation } from './head-preparation.mjs';

const LIMIT = 16 * 1024 * 1024;
export function validateSshHost(host) {
  if (typeof host !== 'string' || !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)) {
    throw new Error('SSH host must be a hostname or user@hostname');
  }
  return host;
}

export function sshRequest(host, command, input, { spawnFn = spawn, timeoutMs = 60000 } = {}) {
  validateSshHost(host);
  return new Promise((resolve, reject) => {
    const child = spawnFn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', host, command],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const chunks = [];
    let length = 0;
    let failure = null;
    const stop = (reason) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('SSH operation timed out; verify target state before retrying'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > LIMIT) stop('SSH response exceeds 16 MiB');
      else chunks.push(chunk);
    });
    // Remote errors may include config values: never forward raw stderr.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('SSH could not be started'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(new Error(failure ?? 'SSH operation failed; check host trust, access, and the installed LLooM command'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

// Read only. No remote package is installed and no source-host file is written.
// Only model mapping sections are returned; gateway auth and runtime commands
// are not transferred. Only eligible cloud backends need provider credentials.
export function sourceReadScript(includeSecrets = false) {
  return `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const home=os.homedir(); const c=JSON.parse(fs.readFileSync(path.join(home,'.lloom/config.json'),'utf8'));
const env={...process.env};
try {for(const line of fs.readFileSync(path.join(home,'.config/lloom/env'),'utf8').split(/\\r?\\n/)) {
 const m=line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(!m)continue;
 let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
 env[m[1]]??=v;
}} catch(e) {if(e.code!=='ENOENT')throw Error('Cannot read source managed environment');}
const backends={};
for(const [id,b] of Object.entries(c.backends??{})) {
 let url;try{url=new URL(b.baseUrl)}catch{continue} if(url.protocol!=='https:')continue;
 const entry=structuredClone(b);
 if(!${JSON.stringify(includeSecrets)} && Object.hasOwn(entry,'apiKey'))entry.apiKey='\${LLOOM_IMPORT_CREDENTIAL_REQUIRED}';
 if(${JSON.stringify(includeSecrets)}) {
   if(typeof entry.apiKeyEnv==='string' && Object.hasOwn(env,entry.apiKeyEnv) && typeof env[entry.apiKeyEnv]==='string' && env[entry.apiKeyEnv]) {entry.apiKey=env[entry.apiKeyEnv];delete entry.apiKeyEnv;}
   if(typeof entry.apiKey==='string')entry.apiKey=entry.apiKey.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g,(_,k)=>Object.hasOwn(env,k)&&typeof env[k]==='string'?env[k]:'');
 }
 backends[id]=entry;
}
const runtimes=Object.fromEntries(Object.entries(c.runtimes??{}).map(([id,r])=>[id,{backend:r.backend,upstreamBackend:r.upstreamBackend,backends:r.backends}]));
process.stdout.write(JSON.stringify({models:c.models,aliases:c.aliases,backends,runtimes}));`;
}

export async function readHeadPreparationInput(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > LIMIT) throw new Error('source config exceeds 16 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function runHeadPreparation({
  configPath,
  sourcePath,
  sourceSsh,
  targetSsh,
  includeSecrets = false,
  apply = false,
  yes = false,
  expectedDestinationHash,
  stdin = process.stdin,
  transport = sshRequest
} = {}) {
  if (Boolean(sourcePath) === Boolean(sourceSsh)) throw new Error('Specify exactly one of --from or --from-ssh');
  if (apply && !yes) throw new Error('refusing to apply without --yes');
  if (sourceSsh) validateSshHost(sourceSsh);
  if (targetSsh) validateSshHost(targetSsh);
  if (expectedDestinationHash && !/^[a-f0-9]{64}$/.test(expectedDestinationHash))
    throw new Error('Invalid --expect-destination hash');
  let sourceData = sourceSsh
    ? await transport(sourceSsh, 'node --input-type=module', sourceReadScript(includeSecrets))
    : sourcePath === '-'
      ? await readHeadPreparationInput(stdin)
      : targetSsh
        ? await readHeadPreparationInput(createReadStream(sourcePath))
        : null;
  if (targetSsh) {
    if (!includeSecrets && sourceData) {
      let redacted;
      try {
        redacted = JSON.parse(sourceData);
      } catch {
        throw new Error('Source config is not valid JSON');
      }
      for (const backend of Object.values(redacted.backends ?? {}))
        if (Object.hasOwn(backend, 'apiKey')) backend.apiKey = '${LLOOM_IMPORT_CREDENTIAL_REQUIRED}';
      sourceData = JSON.stringify(redacted);
    }
    if (!sourceData) throw new Error('--target-ssh requires --from-ssh or --from -');
    const command =
      'node "$HOME/.local/lib/node_modules/lloom/bin/lloom.mjs" cluster prepare-head --from - --json' +
      (includeSecrets ? ' --include-secrets' : '') +
      (apply ? ' --apply --yes' : '') +
      (expectedDestinationHash ? ' --expect-destination ' + expectedDestinationHash : '');
    const output = await transport(targetSsh, command, sourceData);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('Target returned an invalid preparation report');
    }
  }
  return applyHeadPreparation({
    configPath,
    sourcePath: sourcePath === '-' ? undefined : sourcePath,
    sourceData,
    includeSecrets,
    apply,
    yes,
    expectedDestinationHash
  });
}
