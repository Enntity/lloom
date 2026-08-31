import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizedProfile(profile) {
  const value = object(profile);
  if (!value) return null;
  const members = Array.isArray(value.members)
    ? [...value.members]
    : [value.target, ...(Array.isArray(value.fallbacks) ? value.fallbacks : [])].filter(Boolean);
  if (!members.length || members.some((member) => typeof member !== 'string' || !member.trim())) return null;
  return {
    members,
    optionalMembers: Array.isArray(value.optionalMembers)
      ? [...value.optionalMembers]
      : Array.isArray(value.optionalFallbacks)
        ? [...value.optionalFallbacks]
        : []
  };
}

export function routeProfileStatus(config, aliasId = null) {
  const aliases = config.aliases ?? {};
  const entries = aliasId == null ? Object.entries(aliases) : [[aliasId, aliases[aliasId]]];
  return entries
    .filter(([, alias]) => object(alias)?.members)
    .map(([id, alias]) => ({
      alias: id,
      activeRoute: alias.activeRoute ?? null,
      members: Array.isArray(alias.members) ? [...alias.members] : [],
      profiles: Object.keys(alias.routeProfiles ?? {})
    }));
}

export async function writeRouteProfile(config, aliasId, profileName) {
  if (!config.sourcePath) throw new Error('route switching requires a file-backed LLooM config');
  // The running config object is hot-reloaded in place and intentionally keeps
  // non-enumerable loader metadata out of that mutation. Always read the
  // current source file so a second route flip cannot act on the startup
  // template and falsely report that an outdated profile is already active.
  const source = JSON.parse(await fs.readFile(config.sourcePath, 'utf8'));
  const alias = object(source.aliases?.[aliasId]);
  if (!alias) throw new Error(`unknown profiled route alias: ${aliasId}`);
  const selected = normalizedProfile(alias.routeProfiles?.[profileName]);
  if (!selected) throw new Error(`unknown route profile ${profileName} for alias ${aliasId}`);

  const changed =
    alias.activeRoute !== profileName ||
    JSON.stringify(alias.members ?? []) !== JSON.stringify(selected.members) ||
    JSON.stringify(alias.optionalMembers ?? []) !== JSON.stringify(selected.optionalMembers);
  if (!changed) {
    return {
      changed: false,
      alias: aliasId,
      activeRoute: profileName,
      members: selected.members
    };
  }

  alias.activeRoute = profileName;
  alias.members = selected.members;
  if (selected.optionalMembers.length) alias.optionalMembers = selected.optionalMembers;
  else delete alias.optionalMembers;
  delete alias.target;
  delete alias.fallbacks;
  delete alias.optionalFallbacks;

  const mode = (await fs.stat(config.sourcePath)).mode;
  const temporary = path.join(
    path.dirname(config.sourcePath),
    `.${path.basename(config.sourcePath)}.${process.pid}.${Date.now()}.route`
  );
  try {
    await fs.writeFile(temporary, `${JSON.stringify(source, null, 2)}\n`, { mode });
    await loadConfig(temporary);
    await fs.rename(temporary, config.sourcePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }

  return {
    changed: true,
    alias: aliasId,
    activeRoute: profileName,
    members: selected.members
  };
}
