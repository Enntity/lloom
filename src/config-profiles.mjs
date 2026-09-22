// Named fleet profiles: one file describes routing + residency for the whole
// deployment; applying it is a single atomic config swap.
//
// A profile lives in <configDir>/profiles/<name>.json and may set:
//   routes.<aliasId>    route profile name (alias.routeProfiles key) or a
//                       plain model/alias id to pin as the sole member
//   residency.<runtime> 'always' | 'preferred' | 'auto' (keep-warm roster)
//   defaults            optional top-level defaults override (chatModel, ...)
// Applying validates the composed config completely before the atomic write
// (mutateConfigSource validates the staged file), so a swap is all-or-nothing.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mutateConfigSource } from './config-mutation.mjs';
import { loadConfig } from './config.mjs';

const RESIDENCY = new Set(['always', 'preferred', 'auto']);
const MAX_PROFILE_BYTES = 256 * 1024;

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) ? name : null;
}

function profilesDir(config) {
  if (!config.sourcePath) throw fail('Fleet profiles need a file-backed LLooM config.', 409);
  return path.join(path.dirname(path.resolve(config.sourcePath)), 'profiles');
}

// Route profile semantics copied from route-control: a profile's `members`
// (legacy `target`/`fallbacks`) becomes the alias's complete member list.
export function resolveRouteTarget(alias, target) {
  if (!object(alias)) throw fail(`Unknown route alias: ${target && object(target) ? '' : target}`);
  const profiles = object(alias.routeProfiles) ?? {};
  if (typeof target === 'string' && profiles[target]) {
    const profile = profiles[target];
    const members = Array.isArray(profile.members) ? profile.members : null;
    if (!members?.length) throw fail(`Route profile ${target} has no members.`);
    const optionalMembers = Array.isArray(profile.optionalMembers) ? profile.optionalMembers : [];
    return { activeRoute: target, members, optionalMembers };
  }
  if (typeof target !== 'string' || !target.trim()) throw fail('Route target must be an id or profile name.');
  const id = target.trim();
  const known = (candidate) =>
    candidate === id || (object(alias.members)?.includes ?? (() => false)).call(alias.members, id);
  if (!known(id) && !Array.isArray(alias.members))
    throw fail(`Alias has no route profile or member named ${id}.`);
  return { activeRoute: null, members: [id], optionalMembers: [] };
}

export function normalizeProfileDocument(raw, name) {
  const doc = object(raw);
  if (!doc) throw fail(`Profile ${name} must be a JSON object.`);
  const allowed = new Set(['name', 'description', 'routes', 'residency', 'defaults']);
  const unknown = Object.keys(doc).filter((key) => !allowed.has(key));
  if (unknown.length) throw fail(`Profile ${name} has unsupported sections: ${unknown.join(', ')}.`);
  const routes = {};
  for (const [aliasId, target] of Object.entries(object(doc.routes) ?? {})) {
    if (typeof aliasId !== 'string' || !aliasId.trim() || aliasId.length > 200)
      throw fail(`Profile ${name} has an invalid alias id.`);
    if (typeof target !== 'string' || !target.trim() || target.length > 500)
      throw fail(`Profile ${name}: route for ${aliasId} must be an id or profile name.`);
    routes[aliasId] = target.trim();
  }
  const residency = {};
  for (const [runtimeId, policy] of Object.entries(object(doc.residency) ?? {})) {
    if (typeof runtimeId !== 'string' || !runtimeId.trim() || runtimeId.length > 200)
      throw fail(`Profile ${name} has an invalid runtime id.`);
    if (!RESIDENCY.has(policy)) throw fail(`Profile ${name}: residency for ${runtimeId} must be always, preferred, or auto.`);
    residency[runtimeId.trim()] = policy;
  }
  const defaults = object(doc.defaults);
  if (defaults) {
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value !== 'string' || value.length > 500) throw fail(`Profile ${name}: defaults.${key} must be a short string.`);
    }
  }
  return {
    name: typeof doc.name === 'string' ? doc.name : name,
    description: typeof doc.description === 'string' ? doc.description.slice(0, 500) : '',
    routes,
    residency,
    defaults: defaults ? { ...defaults } : null
  };
}

export function profilePaths(config) {
  return { dir: profilesDir(config), fileFor: (name) => path.join(profilesDir(config), name + '.json') };
}

export async function listProfiles(config) {
  const dir = profilesDir(config);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  names.sort((left, right) => left.localeCompare(right));
  const active = await activeProfileName(config);
  const profiles = [];
  for (const name of names) {
    if (!safeName(name)) continue;
    try {
      profiles.push(await readProfile(config, name, active));
    } catch {
      profiles.push({ name, error: 'unreadable profile' });
    }
  }
  return { dir, active, profiles };
}

export async function readProfile(config, name, activeName = null) {
  const safe = safeName(name);
  if (!safe) throw fail('Invalid profile name.');
  const file = path.join(profilesDir(config), safe + '.json');
  const raw = await fs.readFile(file, 'utf8');
  if (raw.length > MAX_PROFILE_BYTES) throw fail('Profile file is too large.', 413);
  const doc = normalizeProfileDocument(JSON.parse(raw), safe);
  return { ...doc, file, active: activeName != null ? safe === activeName : undefined };
}

async function readRawProfile(config, name) {
  const safe = safeName(name);
  if (!safe) throw fail('Invalid profile name.');
  const file = path.join(profilesDir(config), safe + '.json');
  const raw = await fs.readFile(file, 'utf8');
  if (raw.length > MAX_PROFILE_BYTES) throw fail('Profile file is too large.', 413);
  return { safe, doc: JSON.parse(raw), file };
}

// The active profile name is recorded in the config under fleet.activeProfile
// when applied; hand-written configs simply have no marker.
async function activeProfileName(config) {
  const raw = JSON.parse(await fs.readFile(path.resolve(config.sourcePath), 'utf8'));
  const marker = object(raw.fleet)?.activeProfile;
  return safeName(marker) ? marker : null;
}

export function planProfileChanges(config, doc) {
  const changes = { routes: [], residency: [], defaults: [], unchanged: [] };
  const aliases = object(config.aliases) ?? {};
  for (const [aliasId, target] of Object.entries(doc.routes)) {
    const alias = aliases[aliasId];
    if (!object(alias)) throw fail(`Config has no alias ${aliasId}.`, 409);
    const resolved = resolveRouteTarget(alias, target);
    const same =
      JSON.stringify(alias.members ?? []) === JSON.stringify(resolved.members) &&
      JSON.stringify(alias.optionalMembers ?? []) === JSON.stringify(resolved.optionalMembers) &&
      (alias.activeRoute ?? null) === resolved.activeRoute;
    if (same) changes.unchanged.push({ kind: 'route', id: aliasId, value: target });
    else changes.routes.push({ id: aliasId, from: alias.activeRoute ?? alias.members, to: target, ...resolved });
  }
  const runtimes = object(config.runtimes) ?? {};
  for (const [runtimeId, policy] of Object.entries(doc.residency)) {
    const runtime = runtimes[runtimeId];
    if (!object(runtime)) throw fail(`Config has no runtime ${runtimeId}.`, 409);
    const current = runtime.keepWarm === true ? 'always' : runtime.preferredWarm === true ? 'preferred' : 'auto';
    if (current === policy) changes.unchanged.push({ kind: 'residency', id: runtimeId, value: policy });
    else changes.residency.push({ id: runtimeId, from: current, to: policy });
  }
  for (const [key, value] of Object.entries(doc.defaults ?? {})) {
    const current = object(config.defaults)?.[key];
    if (current === value) changes.unchanged.push({ kind: 'default', id: key, value });
    else changes.defaults.push({ id: key, from: current ?? null, to: value });
  }
  return changes;
}

// Compose the profile onto the raw source. Pure and synchronous so
// mutateConfigSource can stage + validate the exact candidate.
export function composeProfile(raw, doc, name) {
  const fleet = object(raw.fleet) ?? {};
  raw.fleet = { ...fleet, activeProfile: name };
  const aliases = object(raw.aliases) ?? {};
  for (const [aliasId, target] of Object.entries(doc.routes)) {
    const alias = object(aliases[aliasId]);
    if (!alias) throw fail(`Config has no alias ${aliasId}.`, 409);
    const resolved = resolveRouteTarget({ ...alias }, target);
    alias.members = resolved.members;
    if (resolved.optionalMembers.length) alias.optionalMembers = resolved.optionalMembers;
    else delete alias.optionalMembers;
    if (resolved.activeRoute) alias.activeRoute = resolved.activeRoute;
    else delete alias.activeRoute;
    // A fresh route invalidates stale per-member suspensions.
    delete alias.suspendedMembers;
    aliases[aliasId] = alias;
  }
  raw.aliases = aliases;
  const runtimes = object(raw.runtimes) ?? {};
  for (const [runtimeId, policy] of Object.entries(doc.residency)) {
    const runtime = object(runtimes[runtimeId]);
    if (!runtime) throw fail(`Config has no runtime ${runtimeId}.`, 409);
    runtime.keepWarm = policy === 'always';
    runtime.preferredWarm = policy === 'preferred';
    runtimes[runtimeId] = runtime;
  }
  raw.runtimes = runtimes;
  if (doc.defaults) raw.defaults = { ...(object(raw.defaults) ?? {}), ...doc.defaults };
  return raw;
}

export function createFleetProfileController({ getConfig, reload, env = process.env }) {
  async function apply(name, { yes = false } = {}) {
    if (yes !== true) throw fail('Review the profile and confirm with yes: true.');
    if (!getConfig().sourcePath) throw fail('This gateway has no writable installed configuration.', 409);
    const { safe, doc } = await readRawProfile(getConfig(), name);
    const profile = normalizeProfileDocument(doc, safe);
    let outcome = null;
    await mutateConfigSource(getConfig(), (raw) => {
      // Plan against raw source state for accurate reporting, then compose.
      outcome = planProfileChanges({ ...raw, sourcePath: getConfig().sourcePath }, profile);
      composeProfile(raw, profile, safe);
    });
    reload?.();
    return { profile: safe, ...outcome };
  }

  async function save(name, { description = '', overwrite = false, yes = false } = {}) {
    if (yes !== true) throw fail('Confirm capturing the current configuration with yes: true.');
    const safe = safeName(name);
    if (!safe) throw fail('Profile names use letters, numbers, dots, dashes, underscores.');
    const config = getConfig();
    if (!config.sourcePath) throw fail('This gateway has no file-backed configuration.', 409);
    const dir = profilesDir(config);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, safe + '.json');
    if (!overwrite) {
      try {
        await fs.access(file);
        throw fail(`Profile ${safe} already exists; pass overwrite: true to replace it.`, 409);
      } catch (error) {
        if (error.statusCode === 409) throw error;
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const source = await loadConfig(config.sourcePath);
    const routes = {};
    for (const [aliasId, alias] of Object.entries(object(source.aliases) ?? {})) {
      if (Array.isArray(alias.members) && (alias.routeProfiles || alias.activeRoute)) {
        routes[aliasId] = alias.activeRoute ?? alias.members[0];
      }
    }
    const residency = {};
    for (const [runtimeId, runtime] of Object.entries(object(source.runtimes) ?? {})) {
      if (runtime.keepWarm === true) residency[runtimeId] = 'always';
      else if (runtime.preferredWarm === true) residency[runtimeId] = 'preferred';
    }
    const doc = {
      name: safe,
      description: String(description).slice(0, 500),
      routes,
      residency,
      defaults: object(source.defaults) ? { ...object(source.defaults) } : undefined
    };
    for (const key of Object.keys(doc)) if (doc[key] == null) delete doc[key];
    const tmp = file + '.tmp-' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
    await fs.rename(tmp, file);
    return { profile: safe, file, routes: Object.keys(routes).length, residency: Object.keys(residency).length };
  }

  return {
    list: () => listProfiles(getConfig()),
    read: (name) => readProfile(getConfig(), name),
    plan: async (name) => {
      const { safe, doc } = await readRawProfile(getConfig(), name);
      const profile = normalizeProfileDocument(doc, safe);
      return { profile: safe, ...planProfileChanges(getConfig(), profile) };
    },
    apply,
    save
  };
}
