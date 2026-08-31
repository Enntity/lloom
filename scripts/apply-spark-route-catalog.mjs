#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const STABLE_ROUTES = Object.freeze({
  ds4f: { localModel: 'deepseek-v4-flash-0731', cloudModel: 'cloud/openrouter/ds4f' },
  ds4fv: { localModel: null, cloudModel: 'cloud/openrouter/ds4fv' },
  q38fn: { localModel: 'qwen3.8-flash-next', cloudModel: 'cloud/openrouter/q38fn' },
  glm53f: { localModel: 'glm-5.3-flash-exl3', cloudModel: 'cloud/openrouter/glm53f' }
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function upsertById(items, incoming) {
  const next = Array.isArray(items) ? [...items] : [];
  const index = next.findIndex((item) => item?.id === incoming.id);
  if (index < 0) next.push(structuredClone(incoming));
  else next[index] = { ...next[index], ...structuredClone(incoming) };
  return next;
}

export function mergeSparkRouteCatalog(installedInput, catalogInput) {
  const installed = structuredClone(installedInput);
  const catalog = structuredClone(catalogInput);
  const catalogModels = new Map((catalog.models ?? []).map((model) => [model.id, model]));

  installed.backends = asObject(installed.backends);
  installed.models = Array.isArray(installed.models) ? installed.models : [];
  for (const { cloudModel } of Object.values(STABLE_ROUTES)) {
    const model = catalogModels.get(cloudModel);
    if (!model) throw new Error(`Spark route catalog is missing model ${cloudModel}`);
    const backend = catalog.backends?.[model.backend];
    if (!backend) throw new Error(`Spark route catalog is missing backend ${model.backend}`);
    installed.backends[model.backend] = backend;
    installed.models = upsertById(installed.models, model);
  }

  const installedModelIds = new Set(installed.models.map((model) => model.id));
  installed.aliases = asObject(installed.aliases);
  for (const [aliasId, { localModel, cloudModel }] of Object.entries(STABLE_ROUTES)) {
    const current = asObject(installed.aliases[aliasId]);
    const catalogAlias = asObject(catalog.aliases?.[aliasId]);
    if (!catalogAlias.target) throw new Error(`Spark route catalog is missing alias ${aliasId}`);
    const routeProfiles = {
      ...(localModel && installedModelIds.has(localModel)
        ? {
            'local-first': {
              target: localModel,
              fallbacks: [cloudModel]
            }
          }
        : {}),
      cloud: { target: cloudModel }
    };
    const activeRoute = routeProfiles[current.activeRoute]
      ? current.activeRoute
      : localModel && installedModelIds.has(localModel) && (!current.target || current.target === localModel)
        ? 'local-first'
        : 'cloud';
    const active = routeProfiles[activeRoute];
    installed.aliases[aliasId] = {
      ...current,
      ...catalogAlias,
      target: active.target,
      ...(active.fallbacks?.length ? { fallbacks: active.fallbacks } : {}),
      activeRoute,
      routeProfiles
    };
    if (!active.fallbacks?.length) delete installed.aliases[aliasId].fallbacks;
  }

  installed.server = {
    ...asObject(installed.server),
    inferenceEnabled: true
  };
  installed.routing = {
    ...asObject(installed.routing),
    ...asObject(catalog.routing)
  };
  installed.clientCatalog = {
    ...asObject(installed.clientCatalog),
    omp: {
      ...asObject(installed.clientCatalog?.omp),
      roles: structuredClone(asObject(catalog.clientCatalog?.omp?.roles))
    }
  };
  return installed;
}

export async function applySparkRouteCatalog(configPath, catalogPath) {
  const installed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const merged = mergeSparkRouteCatalog(installed, catalog);
  const mode = (await fs.stat(configPath)).mode;
  const temporary = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.spark-routes`
  );
  try {
    await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode });
    await loadConfig(temporary);
    await fs.rename(temporary, configPath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return {
    configPath,
    aliases: Object.fromEntries(
      Object.keys(STABLE_ROUTES).map((aliasId) => [
        aliasId,
        {
          activeRoute: merged.aliases[aliasId].activeRoute,
          target: merged.aliases[aliasId].target
        }
      ])
    )
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const configPath = process.argv[2];
  const catalogPath = process.argv[3];
  const apply = process.argv.includes('--apply');
  const yes = process.argv.includes('--yes');
  if (!configPath || !catalogPath)
    throw new Error('usage: apply-spark-route-catalog <config> <catalog> [--apply --yes]');
  if (!apply) {
    console.log(JSON.stringify({ apply: false, configPath, catalogPath }, null, 2));
  } else {
    if (!yes) throw new Error('refusing to update the Spark route catalog without --yes');
    console.log(JSON.stringify(await applySparkRouteCatalog(configPath, catalogPath), null, 2));
  }
}
