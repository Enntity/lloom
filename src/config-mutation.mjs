// Serialized config mutation store.
//
// CONCURRENCY LIMIT: this provides in-process serialization per resolved path
// plus a bounded external-change check (re-read before rename). It is NOT a
// cross-process file lock and does not provide a full compare-and-swap
// guarantee against writers outside this process.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';

// tail of the promise chain, keyed by resolved source path
const queues = new Map();

function rejectIfPromise(v, msg) {
  if (v && typeof v.then === 'function') {
    // Consume any eventual rejection so it does not surface as an
    // unhandled rejection when we synchronously throw instead.
    if (typeof v.catch === 'function') {
      v.catch(() => {});
    }
    throw new TypeError(msg);
  }
  return v;
}

async function mutateOnce(config, mutate, validate) {
  const sourcePath = config && config.sourcePath;
  if (!sourcePath) {
    throw new TypeError('config.sourcePath is required');
  }
  const resolved = path.resolve(String(sourcePath));
  const dir = path.dirname(resolved);
  // Reject symlinks rather than overwriting the link target.
  const st = await fs.lstat(resolved);
  if (st.isSymbolicLink()) {
    throw new Error('refusing to mutate symlink source: ' + resolved);
  }
  if (!st.isFile()) {
    throw new Error('source is not a regular file: ' + resolved);
  }
  const mode = st.mode & 0o777;
  // Read raw bytes (not expanded config/sourceTemplate) inside the lock.
  const initialRaw = await fs.readFile(resolved, 'utf8');
  const parsed = JSON.parse(initialRaw);
  // Capture normalized JSON of the pre-mutation object for no-op detection.
  const beforeNormalized = JSON.stringify(parsed, null, 2) + '\n';
  // The mutator may mutate `parsed` in place and return undefined; ignore the
  // return value for content purposes and serialize the (possibly mutated)
  // `parsed` object instead of the mutator's return value.
  rejectIfPromise(mutate(parsed), 'mutator must be synchronous; async mutators are rejected');
  const candidate = JSON.stringify(parsed, null, 2) + '\n';
  if (candidate === beforeNormalized) {
    return { changed: false };
  }
  // Unique temp file in same directory, original permission bits, 'wx'.
  const tmp = path.join(
    dir,
    '.' + path.basename(resolved) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
  );
  let fh;
  let published = false;
  let created = false;
  try {
    fh = await fs.open(tmp, 'wx', mode);
    created = true;
    // Restore exact original permission bits despite any restrictive umask.
    // A failure here must surface (rather than silently publishing wrong
    // permissions), so do not swallow the error.
    await fh.chmod(mode);
    await fh.writeFile(candidate);
    await fh.close();
    fh = undefined;
    await validate(tmp);
    // Bounded external-change detection: original bytes must be unchanged.
    const before = await fs.readFile(resolved, 'utf8');
    if (before !== initialRaw) {
      throw new Error('source modified externally during validation; refusing to overwrite: ' + resolved);
    }
    await fs.rename(tmp, resolved);
    published = true;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
    if (created && !published) {
      await fs.rm(tmp, { force: true });
    }
  }
  return { changed: true };
}

export async function mutateConfigSource(config, mutate, { validate = loadConfig } = {}) {
  if (typeof mutate !== 'function') {
    throw new TypeError('mutate must be a function');
  }
  const sourcePath = config && config.sourcePath;
  if (!sourcePath) {
    throw new TypeError('config.sourcePath is required');
  }
  const resolved = path.resolve(String(sourcePath));
  const prev = queues.get(resolved) || Promise.resolve();
  const run = prev.then(
    () => mutateOnce(config, mutate, validate),
    () => mutateOnce(config, mutate, validate)
  );
  // Failures release the queue: later operations on this path still run.
  const tail = run.then(
    () => {},
    () => {}
  );
  queues.set(resolved, tail);
  // Drop the tail once settled, but only if it is still the current entry so
  // later operations are not mistakenly removed.
  tail.then(() => {
    if (queues.get(resolved) === tail) {
      queues.delete(resolved);
    }
  });
  return run;
}
