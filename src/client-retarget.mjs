import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const endpointKeys = new Set([
  'baseUrl',
  'baseURL',
  'base_url',
  'gatewayUrl',
  'gateway_url',
  'LLOOM_BASE_URL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'LLOOM_GATEWAY_URL',
  'LLOOM_OPENAI_BASE_URL',
  'LLOOM_ANTHROPIC_BASE_URL',
  'openAIBaseUrl',
  'anthropicBaseUrl'
]);
const hash = (x) => createHash('sha256').update(x).digest('hex');
function origin(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new Error('Client retarget endpoints must be HTTP(S) origins without paths or credentials');
  return u.origin;
}
export function rewriteClientEndpoints(text, { from, to, format }) {
  from = origin(from);
  to = origin(to);
  let count = 0;
  const replace = (value) => {
    if (typeof value !== 'string' || !(value === from || value.startsWith(from + '/'))) return value;
    count++;
    return to + value.slice(from.length);
  };
  if (format === 'json') {
    const data = JSON.parse(text);
    function walk(value, key) {
      if (Array.isArray(value)) return value.map((item) => walk(item));
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
      return endpointKeys.has(key) ? replace(value) : value;
    }
    const next = walk(data);
    return { text: count ? JSON.stringify(next, null, 2) + '\n' : text, count };
  }
  if (!['yml', 'yaml', 'toml', 'env'].includes(format))
    throw new Error('Supported client files are JSON, YAML, TOML, or env');
  // Limit textual formats to endpoint assignment lines. Preserve all roles,
  // authentication, comments and unrelated client preferences verbatim.
  const next = text.replace(
    /^(\s*(?:export\s+)?(?:baseUrl|baseURL|base_url|gatewayUrl|gateway_url|openAIBaseUrl|anthropicBaseUrl|LLOOM_BASE_URL|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|LLOOM_GATEWAY_URL|LLOOM_OPENAI_BASE_URL|LLOOM_ANTHROPIC_BASE_URL)\s*[:=]\s*)(["']?)(https?:\/\/[^\s"']+)(\2)(.*)$/gm,
    (_line, prefix, quote, url, closing, tail) => prefix + quote + replace(url) + closing + tail
  );
  return { text: next, count };
}
export async function retargetClientFile({ file, from, to, apply = false, yes = false, expectedHash } = {}) {
  const target = path.resolve(file);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Client file must be a regular file, not a symlink');
  if (stat.size > 16 * 1024 * 1024) throw new Error('Client file exceeds 16 MiB');
  const before = await fs.readFile(target, 'utf8');
  const originalHash = hash(before);
  if (expectedHash && expectedHash !== originalHash) throw new Error('Client file changed since the reviewed plan');
  const plan = rewriteClientEndpoints(before, {
    from,
    to,
    format:
      path.basename(target) === '.env' || path.basename(target).startsWith('.env.')
        ? 'env'
        : path.extname(target).slice(1)
  });
  const report = {
    file: target,
    from: origin(from),
    to: origin(to),
    replacements: plan.count,
    originalHash,
    applied: false
  };
  if (!apply || !plan.count) return report;
  if (!yes || !expectedHash) throw new Error('Client retarget requires --apply --yes --expect-file HASH');
  const lock = target + '.lloom-retarget.lock';
  const handle = await fs.open(lock, 'wx', 0o600);
  const backupPath = target + '.lloom-before-' + randomUUID();
  const staged = target + '.lloom-next-' + randomUUID();
  try {
    const current = await fs.lstat(target);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== stat.ino ||
      hash(await fs.readFile(target)) !== originalHash
    )
      throw new Error('Client file changed during retarget');
    await fs.writeFile(backupPath, before, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(staged, plan.text, { mode: stat.mode & 0o777, flag: 'wx' });
    await fs.rename(staged, target);
  } finally {
    await fs.rm(staged, { force: true });
    await handle.close();
    await fs.unlink(lock);
  }
  return { ...report, applied: true, backupPath };
}
