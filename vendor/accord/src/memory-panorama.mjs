// SPDX-License-Identifier: MIT
// The memory panorama indexes each harness's own memory store, read-only.
// Descriptions and provenance are served; bodies stay on their host and are
// fetched only by an explicit read. Native stores are never written.
import { existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { hash, integer, requireThat, text } from './common.mjs';
import { redact } from './session-awareness.mjs';

const DESCRIPTION_MAX = 200, BODY_MAX = 16 * 1024, ENTRY_CAP = 2000, HASH_WINDOW = 1024 * 1024;
const LEARNINGS_MAX = 5, QUERY_MAX = 200;
// Credential-shaped files are refused outright, not merely unindexed.
const FORBIDDEN = /(^|\/)(\.ssh)(\/|$)|credential|token|secret|\.pem$|\.key$/i;

function frontmatter(body) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (!match) return { meta: {}, rest: body };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (field) meta[field[1]] = field[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, rest: body.slice(match[0].length) };
}

function describe(meta, rest) {
  let description = String(meta.description ?? '');
  if (!description) for (const line of rest.split(/\r?\n/)) {
    const candidate = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    // Session bookkeeping lines are identifiers, not knowledge.
    if (!candidate || /^(thread_id|session_id|run_id|id|created_at|updated_at|rollout_path|cwd)\s*[:=]/i.test(candidate)) continue;
    description = candidate; break;
  }
  return redact(description.replace(/\s+/g, ' ').trim()).slice(0, DESCRIPTION_MAX);
}

// Read at most max bytes from the start without loading a whole file.
function readWindow(path, max) {
  const size = statSync(path).size, buffer = Buffer.alloc(Math.min(size, max));
  const fd = openSync(path, 'r');
  try { if (buffer.length) readSync(fd, buffer, 0, buffer.length, 0); }
  finally { closeSync(fd); }
  return buffer;
}

// No link between the root and the file: every folder resolves to where its path says.
function contained(root, path) {
  const rel = relative(root, dirname(path));
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  try { return realpathSync(dirname(path)) === join(realpathSync(root), rel); } catch { return false; }
}

function fileEntry(source, root, path, type) {
  if (FORBIDDEN.test(path)) throw Object.assign(new Error('Refused: credential-shaped path'), { code: 'REFUSED_PATH' });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !contained(root, path)) throw Object.assign(new Error('Refused: symlink'), { code: 'REFUSED_SYMLINK' });
  requireThat(info.isFile(), 'NOT_A_FILE', 'Indexable paths must be regular files');
  const raw = readWindow(path, HASH_WINDOW);
  const { meta, rest } = frontmatter(raw.toString('utf8'));
  // A name written as prose falls back to the file name.
  const slug = value => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
  const declared = String(meta.name ?? '').trim(), file = relative(root, path).replace(/\.md$/, '').split('/').at(-1);
  const name = slug(declared) ? declared : file;
  requireThat(slug(name), 'INVALID_NAME', 'Memory names must be simple slugs');
  return {
    // Full canonical path in the id, so two configured roots can never collide.
    id: hash(`${source}:${resolve(path)}`),
    source, name, type,
    description: describe(meta, rest),
    updated: new Date(Math.floor(info.mtimeMs)).toISOString(),
    hash: hash(raw),
    path: resolve(path),
    scope: meta.scope === 'private' ? 'private' : 'shared',
  };
}

// A file Accord refuses to index is skipped; an I/O failure still fails its source.
const SKIPPED = new Set(['INVALID_NAME', 'REFUSED_PATH', 'REFUSED_SYMLINK', 'NOT_A_FILE']);
function entries(source, root, paths, type) {
  return paths.flatMap(path => {
    try { return [fileEntry(source, root, path, type)]; }
    catch (error) { if (SKIPPED.has(error.code)) return []; throw error; }
  });
}

// One markdown directory, N levels deep. Covers ZCode's project memory layout
// and Claude's memory directories; MEMORY.md style index files are entries too.
// Credential-shaped paths are skipped by the walker, never indexed. Failures
// propagate: a vanished root or unreadable directory must never look like an
// empty store, which would erase previously indexed entries.
function markdownFiles(root, depth = 1) {
  if (FORBIDDEN.test(root)) return [];
  const files = [];
  const items = readdirSync(root, { withFileTypes: true });
  for (const item of items) {
    const path = join(root, item.name);
    if (item.isDirectory() && depth > 0) files.push(...markdownFiles(path, depth - 1));
    else if (item.isFile() && ['.md', '.markdown', '.txt'].includes(extname(item.name)) && !FORBIDDEN.test(path)) files.push(path);
    if (files.length > ENTRY_CAP) throw Object.assign(new Error('Store exceeds the entry cap'), { code: 'ENTRY_CAP' });
  }
  return files.sort();
}

export const DEFAULT_ROOTS = {
  zcode: join(homedir(), '.enntity-zcode', 'cli', 'memories', 'projects'),
  claude: join(homedir(), '.claude', 'projects'),
  codex: join(homedir(), '.codex', 'memories'),
};

// Private entries never enter the index: an already indexed file that becomes
// private drops out on the next scan.
const shared = entries => entries.filter(e => e.scope === 'shared');

export const adapters = {
  zcode: (root = DEFAULT_ROOTS.zcode) => shared(entries('zcode', root, markdownFiles(root, 3)
    .filter(p => p.endsWith('.md') || p.endsWith('.markdown')), 'project')),
  // Claude keeps memory in projects/<project>/memory beside transcripts and tool output,
  // so only those folders are read.
  claude: (root = DEFAULT_ROOTS.claude) => shared(entries('claude', root, readdirSync(root, { withFileTypes: true })
    .filter(item => item.isDirectory() && existsSync(join(root, item.name, 'memory')) && !lstatSync(join(root, item.name, 'memory')).isSymbolicLink())
    .flatMap(item => markdownFiles(join(root, item.name, 'memory'), 0).filter(p => p.endsWith('.md'))), 'project')),
  codex: (root = DEFAULT_ROOTS.codex) => shared(entries('codex', root, markdownFiles(root, 1), 'project')),
  // A root without an AGENTS.md is skipped; it never hides the others.
  'agents-md': roots => shared(roots.flatMap(root => existsSync(join(root, 'AGENTS.md'))
    ? entries('agents-md', root, [join(root, 'AGENTS.md')], 'authority') : [])),
};

// Off by default: memory files can hold free-text secrets no redaction reliably catches,
// so indexing them is the operator's choice.
export function memoryConfig(env = process.env) {
  const enabled = env.ACCORD_MEMORY === 'on';
  const sources = (env.ACCORD_MEMORY_SOURCES ?? 'zcode,claude,codex,agents-md').split(',').map(s => s.trim()).filter(Boolean);
  const pollMs = Math.min(600000, Math.max(250, Number(env.ACCORD_MEMORY_POLL_MS ?? 30000) || 30000));
  const roots = {
    zcode: env.ACCORD_MEMORY_ZCODE, claude: env.ACCORD_MEMORY_CLAUDE,
    codex: env.ACCORD_MEMORY_CODEX,
    'agents-md': env.ACCORD_MEMORY_AGENTS_MD
      ? env.ACCORD_MEMORY_AGENTS_MD.split(':').map(s => s.trim()).filter(Boolean)
      : [process.cwd(), homedir()],
  };
  const learnings = env.ACCORD_MEMORY_LEARNINGS === 'on';
  return { enabled, sources, pollMs, roots, learnings };
}

// Index state lives in the coordinator store; a failed scan marks entries stale
// instead of deleting them, so transient I/O errors never erase collective knowledge.
export class MemoryPanorama {
  constructor(store, config = memoryConfig()) {
    this.store = store; this.config = config;
    this.status = { enabled: config.enabled, sources: {}, lastScan: null };
    this.scanning = false;
    this.timer = null;
  }
  start() {
    // Off clears everything; a source taken out of the list is cleared too.
    const kept = this.config.enabled ? this.config.sources : [];
    this.store.mutate(() => this.store.db.prepare(`DELETE FROM memory_entries WHERE source NOT IN (${kept.map(() => '?').join(',')})`).run(...kept));
    if (!this.config.enabled) return;
    const tick = () => { if (!this.scanning) void this.scan().catch(() => {}); };
    this.timer = setInterval(tick, this.config.pollMs);
    this.timer.unref?.();
    void this.scan().catch(() => {});
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  sync(source, entries) {
    entries = entries.slice(0, ENTRY_CAP);
    this.store.mutate(() => {
      const known = new Map(this.store.db.prepare('SELECT id,hash FROM memory_entries WHERE source=?').all(source).map(r => [r.id, r.hash]));
      for (const entry of entries) {
        if (known.get(entry.id) === entry.hash) continue;
        this.store.db.prepare(`INSERT INTO memory_entries(id,source,name,type,description,updated,hash,path,scope,stale)
          VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,description=excluded.description,
          updated=excluded.updated,hash=excluded.hash,path=excluded.path,scope=excluded.scope,stale=0`).run(
          entry.id, entry.source, entry.name, entry.type, entry.description, entry.updated, entry.hash, entry.path, entry.scope);
      }
      const keep = new Set(entries.map(e => e.id));
      for (const id of known.keys()) if (!keep.has(id))
        this.store.db.prepare('DELETE FROM memory_entries WHERE id=?').run(id);
      // A completed scan re-observed every surviving entry; stale uncertainty ends here.
      this.store.db.prepare('UPDATE memory_entries SET stale=0 WHERE source=?').run(source);
    });
    this.status.sources[source] = { ok: true, entries: entries.length, at: Date.now() };
  }
  markStale(source, error) {
    this.store.mutate(() => this.store.db.prepare('UPDATE memory_entries SET stale=1 WHERE source=?').run(source));
    this.status.sources[source] = { ok: false, error: error.code ?? 'SCAN_FAILED', at: Date.now() };
  }
  async scan() {
    if (this.scanning || !this.config.enabled) return; this.scanning = true;
    try {
      for (const source of this.config.sources) {
        const adapter = adapters[source];
        if (!adapter) { this.status.sources[source] = { ok: false, error: 'UNKNOWN_SOURCE', at: Date.now() }; continue; }
        const existing = this.store.db.prepare('SELECT count(*) n FROM memory_entries WHERE source=?').get(source).n;
        try {
          const entries = adapter(this.config.roots[source]);
          this.sync(source, entries);
        } catch (error) {
          if (error.code === 'ENOENT' && !existing) {
            // Absent store: the harness is simply not installed here.
            this.status.sources[source] = { ok: true, entries: 0, at: Date.now() };
          } else {
            // A vanished or unreadable store leaves entries stale, never erased.
            this.markStale(source, error);
          }
        }
      }
      this.status.lastScan = Date.now();
    } finally { this.scanning = false; }
  }

  list(args = {}) {
    if (!this.config.enabled) return { entries: [], sources: {}, lastScan: null };
    requireThat(args.query === undefined || typeof args.query === 'string' && args.query.length <= QUERY_MAX,
      'INVALID_INPUT', 'query must be a string of at most 200 characters', 400);
    integer(args.limit ?? 10, 'limit', 1, 20);
    const query = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.store.db.prepare('SELECT * FROM memory_entries ORDER BY updated DESC, name').all().filter(row => this.config.sources.includes(row.source));
    const entries = rows
      .filter(row => query.every(term => `${row.name} ${row.description} ${row.type}`.toLowerCase().includes(term)))
      .slice(0, args.limit ?? 10)
      .map(row => ({ id: row.id, name: row.name, type: row.type, description: row.description, updated: row.updated,
        source: { host: this.store.authority, harness: row.source, label: row.source }, scope: row.scope, stale: Boolean(row.stale) }));
    return { entries, sources: this.status.sources, lastScan: this.status.lastScan };
  }

  read(entryId) {
    requireThat(this.config.enabled, 'DISABLED', 'Memory panorama is disabled', 403);
    text(entryId, 'id', 100);
    const row = this.store.db.prepare('SELECT * FROM memory_entries WHERE id=?').get(entryId);
    requireThat(row && this.config.sources.includes(row.source), 'NOT_FOUND', 'Unknown memory entry', 404);
    requireThat(row.type !== 'authority', 'AUTHORITY_BODY', 'Instruction files are read from disk; the index only locates them', 403);
    // Revalidate the source at read time: the path must still be a regular
    // file with the indexed identity, or the entry is stale.
    let body, truncated = false;
    try {
      const info = lstatSync(row.path), roots = [this.config.roots[row.source] ?? DEFAULT_ROOTS[row.source]].flat().filter(Boolean);
      if (info.isSymbolicLink() || !info.isFile() || FORBIDDEN.test(row.path) || !roots.some(root => contained(root, row.path)))
        throw Object.assign(new Error('Entry source changed'), { code: 'SOURCE_CHANGED' });
      const raw = readWindow(row.path, HASH_WINDOW);
      requireThat(hash(raw) === row.hash, 'SOURCE_CHANGED', 'The entry changed since it was indexed', 410);
      truncated = raw.length > BODY_MAX;
      body = redact(raw.subarray(0, BODY_MAX).toString('utf8'));
    } catch (error) {
      // Only the read entry becomes uncertain; the source itself is still healthy.
      this.store.mutate(() => this.store.db.prepare('UPDATE memory_entries SET stale=1 WHERE id=?').run(row.id));
      throw Object.assign(new Error('The entry body is unavailable or changed on this host'), { code: 'STALE_ENTRY', cause: error.code });
    }
    return { id: row.id, name: row.name, type: row.type, description: row.description, updated: row.updated, hash: row.hash,
      truncated, body, path: row.path };
  }

  learnings() {
    if (!this.config.enabled || !this.config.learnings) return [];
    const rows = this.store.db.prepare("SELECT * FROM memory_entries WHERE stale=0 ORDER BY updated DESC").all().filter(row => this.config.sources.includes(row.source)).slice(0, LEARNINGS_MAX);
    return rows.map(row => ({ name: row.name, type: row.type, description: row.description, updated: row.updated, source: row.source }));
  }
}

// A linked host's answer is untrusted: keep only well-formed shared entries that host
// owns, capped like local ones, before an agent sees them.
const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
export function peerEntries(result, authority) {
  if (!Array.isArray(result?.entries)) return [];
  return result.entries.slice(0, 20).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || entry.source?.host !== authority || entry.scope !== 'shared') return [];
    const fields = { id: clip(entry.id, 100), name: clip(entry.name, 100), type: clip(entry.type, 40), description: clip(entry.description, DESCRIPTION_MAX),
      updated: clip(entry.updated, 40), harness: clip(entry.source.harness, 40), label: clip(entry.source.label, 80) };
    if (Object.values(fields).some(value => value === null)) return [];
    const { harness, label, ...rest } = fields;
    return [{ ...rest, source: { host: authority, harness, label }, scope: 'shared', stale: Boolean(entry.stale) }];
  });
}
