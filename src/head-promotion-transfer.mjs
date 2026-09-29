// Operator-side transport for fleet-head promotion. Source reads are read-only
// and stream a private JSON envelope over SSH stdin/stdout. The destination
// performs local planning and fail-closed mutation; no source runtime is managed.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { planHeadPromotion, stableStringify } from './head-promotion.mjs';
import { loadConfig } from './config.mjs';
import { mutateConfigSource } from './config-mutation.mjs';
import { normalizeProfileDocument, composeProfile } from './config-profiles.mjs';

const LIMIT = 16 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function validateSshHost(host) {
  if (typeof host !== 'string' || !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)) {
    throw new Error('SSH host must be a hostname or user@hostname');
  }
  return host;
}

export function sshRequest(host, command, input, { spawnFn = spawn, timeoutMs = 120000 } = {}) {
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
    const timer = setTimeout(
      () => stop('SSH operation timed out; verify source and target state before retrying'),
      timeoutMs
    );
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > LIMIT) stop('SSH response exceeds 16 MiB');
      else chunks.push(chunk);
    });
    // Remote diagnostics can contain machine-local values. Do not forward them.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('SSH could not be started'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(new Error(failure ?? 'SSH operation failed; check access and installed LLooM command'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

export async function readPromotionEnvelope(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > LIMIT) throw new Error('promotion envelope exceeds 16 MiB');
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('promotion envelope is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('promotion envelope must be a JSON object');
  }
  if (!value.sourceConfig || typeof value.sourceConfig !== 'object' || Array.isArray(value.sourceConfig)) {
    throw new Error('promotion envelope is missing sourceConfig');
  }
  return value;
}

function normalizeSourceUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new Error('--source-url must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--source-url must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('--source-url cannot contain credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function sourceNodeId(config) {
  const id = config?.cluster?.nodeId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('source config is missing a valid cluster.nodeId');
  }
  return id;
}

export function sourceReadScript() {
  return `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const home=os.homedir(); const c=JSON.parse(fs.readFileSync(path.join(home,'.lloom/config.json'),'utf8'));
const env={...process.env};
try {for(const line of fs.readFileSync(path.join(home,'.config/lloom/env'),'utf8').split(/\\r?\\n/)) {
 const m=line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(!m)continue;
 let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
 env[m[1]]??=v;
}} catch(e) {if(e.code!=='ENOENT')throw Error('cannot read managed environment');}
let chunks=[];for await(const part of process.stdin)chunks.push(Buffer.from(part));
let input={};try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('invalid promotion request')}
let sourceUrl=String(input.sourceUrl??'');try{const u=new URL(sourceUrl);if(u.protocol!=='http:'&&u.protocol!=='https:')throw 0;if(u.username||u.password||u.search||u.hash)throw 0;}catch{throw Error('invalid source URL')}
sourceUrl=sourceUrl.replace(/\\/+$/,'');
const profilesDir=path.join(path.dirname(path.join(home,'.lloom/config.json')),'profiles');
let sourceProfiles={};
try{if(fs.lstatSync(profilesDir).isSymbolicLink())throw Error('unsafe fleet profile directory');for(const entry of fs.readdirSync(profilesDir,{withFileTypes:true})) {
 if(!entry.name.endsWith('.json'))continue;
 if(entry.isSymbolicLink()||!entry.isFile())throw Error('unsafe fleet profile path');
 const name=entry.name.slice(0,-5);
 if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name))throw Error('unsafe fleet profile filename');
 sourceProfiles[name]=JSON.parse(fs.readFileSync(path.join(profilesDir,entry.name),'utf8'));
}}catch(e){if(e.code!=='ENOENT')throw e;}
function resolved(value){return typeof value==='string'?value.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g,(_,k)=>Object.hasOwn(env,k)&&typeof env[k]==='string'?env[k]:''):null}
const keys=(Array.isArray(c.security?.apiKeys)?c.security.apiKeys:[]).map(resolved).filter((v)=>typeof v==='string'&&v.length>0);
process.stdout.write(JSON.stringify({
 sourceConfig:c,
 sourceProfiles,
 sourceInferenceKey:keys[0]??null,
 sourceUrl,
 sourceNode:typeof c.cluster?.nodeId==='string'?c.cluster.nodeId:null
}));`;
}

export function sourceReadCommand() {
  return (
    'export PATH="$HOME/.local/bin:$PATH" LLOOM_SOURCE_SCRIPT_B64=' +
    `'${Buffer.from(sourceReadScript()).toString('base64')}'` +
    "; exec node --input-type=module --eval 'const mod = await import(`data:text/javascript;base64,${process.env.LLOOM_SOURCE_SCRIPT_B64}`);'"
  );
}

function redactedEnvelope(envelope) {
  const clean = structuredClone(envelope);
  delete clean.sourceInferenceKey;
  const scrub = (value) => {
    if (Array.isArray(value)) {
      value.forEach(scrub);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'apiKey')) value.apiKey = '${LLOOM_IMPORT_CREDENTIAL_REQUIRED}';
    Object.values(value).forEach(scrub);
  };
  scrub(clean.sourceConfig);
  scrub(clean.sourceProfiles);
  return clean;
}

export function targetCommand({
  includeSecrets = false,
  apply = false,
  yes = false,
  expectedDestinationHash = null
} = {}) {
  if (apply && !yes) throw new Error('refusing to apply without --yes');
  if (apply && !expectedDestinationHash) throw new Error('apply requires --expect-destination');
  if (apply && !includeSecrets) throw new Error('apply requires --include-secrets');
  if (expectedDestinationHash && !HASH_PATTERN.test(expectedDestinationHash))
    throw new Error('Invalid --expect-destination hash');
  let command =
    'export PATH="$HOME/.local/bin:$PATH"; ' +
    'node "$HOME/.local/lib/node_modules/lloom/bin/lloom.mjs" cluster promote-head --from - --json';
  if (includeSecrets) command += ' --include-secrets';
  if (apply) command += ' --apply --yes';
  if (expectedDestinationHash) command += ` --expect-destination ${expectedDestinationHash}`;
  return command;
}

export function profilesPathForConfig(configPath) {
  const resolved = path.resolve(String(configPath));
  return path.join(path.dirname(resolved), 'profiles');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function privateBackup(originalPath, raw) {
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath);
  const backupPath = path.join(dir, `.${base}.head-promotion-${Date.now()}-${process.pid}.bak`);
  await fs.writeFile(backupPath, raw, { mode: 0o600, flag: 'wx' });
  await fs.chmod(backupPath, 0o600);
  return backupPath;
}

function safeProfileName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) ? name : null;
}

async function readProfileDirectory(dir) {
  try {
    const directoryStat = await fs.lstat(dir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('destination fleet-profile path must be a regular directory');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, files: new Map(), parsed: {} };
    throw error;
  }
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const files = new Map();
  for (const filename of names) {
    const name = filename.slice(0, -5);
    if (!safeProfileName(name)) throw new Error(`unsafe destination fleet-profile filename: ${filename}`);
    const file = path.join(dir, filename);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe destination fleet profile: ${filename}`);
    const raw = await fs.readFile(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`destination fleet profile is not valid JSON: ${filename}`);
    }
    files.set(name, { file, raw, parsed, mode: stat.mode & 0o777 });
  }
  return { exists: true, files, parsed: Object.fromEntries([...files].map(([name, v]) => [name, v.parsed])) };
}

async function profileSnapshotChanged(snapshot, dir, name) {
  const file = path.join(dir, name + '.json');
  const before = snapshot?.files?.get(name);
  if (!before) {
    try {
      await fs.lstat(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  let current;
  try {
    current = await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  return !current.equals(Buffer.from(before.raw));
}

function reportFromSummary(summary, destinationHash, extra = {}) {
  return {
    ok: summary.ok,
    applied: false,
    dryRun: true,
    destinationHash,
    counts: {
      federatedModels: summary.federation.modelsAdded,
      proxyBackends: summary.federation.backendAdded,
      importedAliases: summary.aliases.imported.length + summary.aliases.composed.length,
      compatibilityAliases: summary.aliases.compatibility.length,
      migratedProfiles: summary.profiles.migrated.length
    },
    errors: [
      ...summary.conflicts.map((entry) => ({ ...entry, severity: 'conflict' })),
      ...summary.aliases.skipped.map((entry) => ({ ...entry, severity: 'skipped' })),
      ...summary.defaults.skipped.map((entry) => ({
        type: 'default',
        id: entry.kind,
        reason: entry.reason,
        severity: 'skipped'
      })),
      ...summary.profiles.skipped.map((entry) => ({
        type: 'profile',
        id: entry.name,
        reason: entry.reason,
        severity: 'skipped'
      }))
    ],
    summary,
    ...extra
  };
}

export async function applyHeadPromotion({
  configPath,
  envelope,
  sourceUrl,
  expectedDestinationHash,
  includeSecrets = false,
  apply = false,
  yes = false,
  env = process.env
} = {}) {
  if (!configPath) throw new Error('a destination config is required');
  if (!envelope || typeof envelope !== 'object') throw new Error('a promotion envelope is required');
  if (apply && !yes) throw new Error('refusing to apply without --yes');
  if (apply && !includeSecrets) throw new Error('refusing to apply without --include-secrets');
  if (apply && !expectedDestinationHash) throw new Error('refusing to apply without --expect-destination');
  if (expectedDestinationHash && !HASH_PATTERN.test(expectedDestinationHash)) {
    throw new Error('Invalid --expect-destination hash');
  }

  const resolvedConfig = path.resolve(String(configPath));
  const destinationRaw = await fs.readFile(resolvedConfig, 'utf8');
  const profilesPath = profilesPathForConfig(resolvedConfig);
  const existingProfiles = await readProfileDirectory(profilesPath);
  const destinationHash = sha256(
    JSON.stringify({ config: destinationRaw, profiles: [...existingProfiles.files].map(([n, v]) => [n, v.raw]) })
  );
  const url = normalizeSourceUrl(sourceUrl ?? envelope.sourceUrl);
  const sourceConfig = envelope.sourceConfig;
  const sourceNode = sourceNodeId(sourceConfig);
  const sourceInferenceKey =
    includeSecrets && typeof envelope.sourceInferenceKey === 'string' ? envelope.sourceInferenceKey : null;
  if (apply && !sourceInferenceKey) throw new Error('promotion envelope has no resolved source inference key');
  if (apply && destinationHash !== expectedDestinationHash) {
    throw new Error('destination changed since reviewed plan; expected hash does not match');
  }

  let plan = planHeadPromotion(JSON.parse(destinationRaw), sourceConfig, {
    sourceNode: envelope.sourceNode ?? sourceNode,
    sourceUrl: url,
    sourceInferenceKey,
    sourceProfiles: envelope.sourceProfiles ?? {},
    destinationProfiles: existingProfiles.parsed
  });
  let base = reportFromSummary(plan.summary, destinationHash, { profilesPath });

  if (!apply) return base;
  if (!plan.summary.ok)
    throw new Error(`refusing to apply: ${plan.summary.conflicts.length} conflicting definition(s)`);
  if (!plan.summary.changed) return { ...base, applied: false, dryRun: false };

  const configStat = await fs.lstat(resolvedConfig);
  if (configStat.isSymbolicLink() || !configStat.isFile()) throw new Error('destination config must be a regular file');
  const configMode = configStat.mode & 0o777;
  if (configMode & 0o077) throw new Error('destination config must be private (0600) before promotion');

  const configBackup = await privateBackup(resolvedConfig, destinationRaw);
  const expectedDestination = JSON.parse(destinationRaw);
  const profileBackups = [];
  const stagedProfiles = [];
  const publishedProfiles = [];
  const rollbackProfiles = async () => {
    for (const entry of [...publishedProfiles].reverse()) {
      const current = await fs.readFile(entry.file, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (current !== entry.raw) throw new Error('Published profile changed externally; manual rollback required');
      if (!entry.previous) await fs.unlink(entry.file);
      else {
        const tmp = entry.file + '.rollback-' + process.pid;
        await fs.writeFile(tmp, entry.previous.raw, { mode: entry.previous.mode, flag: 'wx' });
        await fs.chmod(tmp, entry.previous.mode);
        await fs.rename(tmp, entry.file);
      }
    }
  };
  const lockPath = resolvedConfig + '.head-promotion.lock';
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    await mutateConfigSource(
      { sourcePath: resolvedConfig },
      (parsed) => {
        if (stableStringify(parsed) !== stableStringify(expectedDestination))
          throw new Error('destination changed after planning; re-run promotion');
        for (const key of Object.keys(parsed)) delete parsed[key];
        Object.assign(parsed, structuredClone(plan.next));
      },
      {
        validate: async (stagedPath) => {
          try {
            await loadConfig(stagedPath, { env });
            for (const [name, profile] of Object.entries(plan.profiles))
              composeProfile(structuredClone(plan.next), normalizeProfileDocument(profile, name), name);
          } catch (cause) {
            throw new Error('promoted configuration failed validation; destination was not changed', { cause });
          }
          await fs.mkdir(profilesPath, { recursive: true, mode: 0o700 });
          const now = await readProfileDirectory(profilesPath);
          if (
            stableStringify([...now.files].map(([n, v]) => [n, v.raw])) !==
            stableStringify([...existingProfiles.files].map(([n, v]) => [n, v.raw]))
          )
            throw new Error('destination profiles changed after planning');
          for (const [name, profile] of Object.entries(plan.profiles)) {
            if (!safeProfileName(name)) throw new Error('unsafe profile name');
            const previous = existingProfiles.files.get(name);
            if (previous && stableStringify(profile) === stableStringify(previous.parsed)) continue;
            const file = path.join(profilesPath, name + '.json');
            const raw = JSON.stringify(profile, null, 2) + '\n';
            const mode = previous?.mode ?? 0o600;
            if (previous) profileBackups.push(await privateBackup(file, previous.raw));
            const tmp = file + '.tmp-' + process.pid;
            await fs.writeFile(tmp, raw, { mode, flag: 'wx' });
            await fs.chmod(tmp, mode);
            stagedProfiles.push({ file, raw, tmp, previous, name });
          }
          for (const entry of stagedProfiles) {
            if (await profileSnapshotChanged(existingProfiles, profilesPath, entry.name))
              throw new Error('destination profiles changed during publication');
            await fs.rename(entry.tmp, entry.file);
            publishedProfiles.push(entry);
          }
        }
      }
    );
  } catch (error) {
    try {
      await rollbackProfiles();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Promotion failed and profile rollback requires inspection', {
        cause: rollbackError
      });
    }
    throw error;
  } finally {
    await Promise.all(stagedProfiles.map((entry) => fs.rm(entry.tmp, { force: true })));
    await lock.close();
    await fs.unlink(lockPath);
  }

  base = reportFromSummary(plan.summary, destinationHash, { profilesPath });
  return {
    ...base,
    applied: true,
    dryRun: false,
    backups: {
      config: configBackup,
      ...(profileBackups.length ? { profiles: profileBackups } : {})
    }
  };
}

export async function runHeadPromotionTransfer({
  configPath,
  sourcePath,
  sourceSsh,
  targetSsh,
  sourceUrl,
  expectedDestinationHash,
  includeSecrets = false,
  apply = false,
  yes = false,
  stdin = process.stdin,
  transport = sshRequest
} = {}) {
  if (Boolean(sourcePath) === Boolean(sourceSsh)) throw new Error('Specify exactly one of --from or --from-ssh');
  if (apply && !yes) throw new Error('refusing to apply without --yes');
  if (apply && !includeSecrets) throw new Error('refusing to apply without --include-secrets');
  if (apply && !expectedDestinationHash) throw new Error('refusing to apply without --expect-destination');
  if (sourceSsh) validateSshHost(sourceSsh);
  if (targetSsh) validateSshHost(targetSsh);
  if (expectedDestinationHash && !HASH_PATTERN.test(expectedDestinationHash))
    throw new Error('Invalid --expect-destination hash');
  if (sourceUrl != null) normalizeSourceUrl(sourceUrl);

  if (targetSsh) {
    let envelope = sourceSsh
      ? JSON.parse(await transport(sourceSsh, sourceReadCommand(), JSON.stringify({ sourceUrl })))
      : sourcePath === '-'
        ? await readPromotionEnvelope(stdin)
        : await readPromotionEnvelope((await fs.readFile(path.resolve(sourcePath))).toString('utf8'));
    if (sourceUrl) envelope.sourceUrl = sourceUrl;
    normalizeSourceUrl(envelope.sourceUrl);
    if (!includeSecrets) envelope = redactedEnvelope(envelope);
    const output = await transport(
      targetSsh,
      targetCommand({ includeSecrets, apply, yes, expectedDestinationHash }),
      JSON.stringify(envelope)
    );
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('target returned an invalid promotion report');
    }
  }

  const envelope =
    sourcePath === '-'
      ? await readPromotionEnvelope(stdin)
      : await readPromotionEnvelope((await fs.readFile(path.resolve(sourcePath))).toString('utf8'));
  return applyHeadPromotion({
    configPath,
    envelope,
    sourceUrl,
    expectedDestinationHash,
    includeSecrets,
    apply,
    yes,
    env: process.env
  });
}
