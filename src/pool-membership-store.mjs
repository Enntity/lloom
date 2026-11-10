// Head-side persistence for pool membership: `pool-membership.json` next to
// the config file. It is loaded on first use and written only by changes an
// operator or an enrolling node makes (tokens, enrollments, cordons), never by
// heartbeats, so a head that never uses membership never writes the file.
// After a restart, members keep their last heartbeat time and show as lost
// until their next heartbeat.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomicJson } from './deployment-fence.mjs';
import { createPoolMembership } from './pool-membership.mjs';

export const POOL_MEMBERSHIP_FILE = 'pool-membership.json';

export function poolMembershipPath(config) {
  return config?.sourcePath ? path.join(path.dirname(path.resolve(config.sourcePath)), POOL_MEMBERSHIP_FILE) : null;
}

export function poolMembershipOptions(config) {
  const settings = config?.pool?.membership ?? {};
  return Object.fromEntries(
    Object.entries({ leaseMs: settings.leaseMs, lostAfterMs: settings.lostAfterMs }).filter(
      ([, value]) => value != null
    )
  );
}

export async function readPoolMembershipState(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Unreadable pool membership state ${filePath}: ${error?.message ?? error}`, { cause: error });
  }
}

export function createPoolMembershipStore({ filePath, options = {}, write = writeAtomicJson } = {}) {
  let membership = null;
  let loading = null;
  let queue = Promise.resolve();

  async function load() {
    if (membership) return membership;
    loading ??= readPoolMembershipState(filePath)
      .then((state) => {
        membership = createPoolMembership({ ...options, state });
        return membership;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  return {
    load,
    // Serialized change plus write. A failed write restores the last persisted
    // state, so a token or enrollment never outlives a failed save.
    mutate(change) {
      const run = queue.then(async () => {
        const current = await load();
        const before = current.toJSON();
        const result = change(current);
        if (filePath) {
          try {
            await write(filePath, current.toJSON());
          } catch (error) {
            membership = createPoolMembership({ ...options, state: before });
            throw error;
          }
        }
        return result;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
}
