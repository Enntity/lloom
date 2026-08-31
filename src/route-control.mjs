import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizedProfile(profile) {
  const value = object(profile);
  if (!value || typeof value.target !== 'string' || !value.target.trim()) return null;
  return {
    target: value.target,
    fallbacks: Array.isArray(value.fallbacks) ? [...value.fallbacks] : [],
    optionalFallbacks: Array.isArray(value.optionalFallbacks) ? [...value.optionalFallbacks] : []
  };
}

export function routeProfileStatus(config, aliasId = null) {
  const aliases = config.aliases ?? {};
  const entries = aliasId == null ? Object.entries(aliases) : [[aliasId, aliases[aliasId]]];
  return entries
    .filter(([, alias]) => object(alias)?.routeProfiles)
    .map(([id, alias]) => ({
      alias: id,
      activeRoute: alias.activeRoute ?? null,
      target: alias.target,
      fallbacks: Array.isArray(alias.fallbacks) ? [...alias.fallbacks] : [],
      profiles: Object.keys(alias.routeProfiles ?? {})
    }));
}

export async function writeRouteProfile(config, aliasId, profileName) {
  if (!config.sourcePath) throw new Error('route switching requires a file-backed LLooM config');
  const source = structuredClone(config.sourceTemplate ?? JSON.parse(await fs.readFile(config.sourcePath, 'utf8')));
  const alias = object(source.aliases?.[aliasId]);
  if (!alias) throw new Error(`unknown profiled route alias: ${aliasId}`);
  const selected = normalizedProfile(alias.routeProfiles?.[profileName]);
  if (!selected) throw new Error(`unknown route profile ${profileName} for alias ${aliasId}`);

  const changed =
    alias.activeRoute !== profileName ||
    alias.target !== selected.target ||
    JSON.stringify(alias.fallbacks ?? []) !== JSON.stringify(selected.fallbacks) ||
    JSON.stringify(alias.optionalFallbacks ?? []) !== JSON.stringify(selected.optionalFallbacks);
  if (!changed) {
    return {
      changed: false,
      alias: aliasId,
      activeRoute: profileName,
      target: selected.target,
      fallbacks: selected.fallbacks
    };
  }

  alias.activeRoute = profileName;
  alias.target = selected.target;
  if (selected.fallbacks.length) alias.fallbacks = selected.fallbacks;
  else delete alias.fallbacks;
  if (selected.optionalFallbacks.length) alias.optionalFallbacks = selected.optionalFallbacks;
  else delete alias.optionalFallbacks;

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
    target: selected.target,
    fallbacks: selected.fallbacks
  };
}
