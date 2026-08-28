import { readFileSync } from 'node:fs';
import path from 'node:path';

export function parseManagedEnvironmentFile(source) {
  const values = {};
  for (const rawLine of String(source ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

export function loadManagedServiceEnvironment({ home = process.env.HOME, env = process.env } = {}) {
  if (!home) return { loaded: false, path: null, keys: [] };
  const filePath = path.join(home, '.config', 'lloom', 'env');
  let values;
  try {
    values = parseManagedEnvironmentFile(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { loaded: false, path: filePath, keys: [] };
    throw error;
  }
  const loadedKeys = [];
  for (const [name, value] of Object.entries(values)) {
    if (Object.hasOwn(env, name)) continue;
    env[name] = value;
    loadedKeys.push(name);
  }
  return { loaded: true, path: filePath, keys: loadedKeys };
}

export function resolveManagedEnvironmentValue(value, env = process.env) {
  const match = typeof value === 'string' ? value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) : null;
  return match && Object.hasOwn(env, match[1]) ? env[match[1]] : value;
}
