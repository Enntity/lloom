// Node inventory for pool planning: what a node could run without new
// downloads or installs. Collection is read-only and every probe is
// injectable; a failing probe yields a partial inventory, never an error.
import { promises as fs } from 'node:fs';
import { runCommand } from './process-control.mjs';
import { memoryDomainsForProfile } from './resource-fit.mjs';
import { modelRootStatusForRecipe } from './model-files.mjs';

export const NODE_INVENTORY_VERSION = 1;
export const NODE_INVENTORY_TTL_MS = 300000;

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function computeArchsForProfile(profile = {}) {
  const archs = (Array.isArray(profile.devices) ? profile.devices : [])
    .map((device) => String(device?.computeCapability ?? '').match(/^(\d+)\.(\d+)/))
    .filter(Boolean)
    .map(([, major, minor]) => `sm_${major}${minor}`);
  if (profile.isAppleSilicon) archs.push('apple-metal');
  return unique(archs).sort();
}

function profileLinks(profile = {}) {
  const links = Array.isArray(profile.cluster?.links) ? profile.cluster.links : [];
  return links
    .filter((link) => link?.peerNodeId)
    .map((link) => ({
      peerNodeId: String(link.peerNodeId),
      ...(link.localInterface ? { localInterface: String(link.localInterface) } : {}),
      ...(link.peerAddress ? { peerAddress: String(link.peerAddress) } : {})
    }));
}

function capacityDomains(profile) {
  return memoryDomainsForProfile(profile).map(({ id, kind, capacityGb }) => ({ id, kind, capacityGb }));
}

// The planner can work from a machine profile alone (older gateways do not
// report inventory); it just cannot see cached weights, disks or images.
export function inventoryFromProfile(profile = {}) {
  return {
    version: NODE_INVENTORY_VERSION,
    complete: false,
    computeArchs: computeArchsForProfile(profile),
    memoryDomains: capacityDomains(profile),
    links: profileLinks(profile)
  };
}

async function statfsGb(root) {
  const stats = await fs.statfs(root);
  return {
    freeGb: round((stats.bavail * stats.bsize) / 1024 ** 3),
    totalGb: round((stats.blocks * stats.bsize) / 1024 ** 3)
  };
}

async function commandExists(command) {
  const result = await runCommand('/usr/bin/which', [command], { allowFailure: true });
  return result.code === 0 && Boolean(result.stdout.trim());
}

async function dockerImages() {
  const result = await runCommand(
    'docker',
    ['image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}}|{{.Repository}}@{{.Digest}}'],
    { allowFailure: true }
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .flatMap((line) => line.trim().split('|'))
    .filter((ref) => ref && !ref.includes('<none>'));
}

function recipeFitsPlatform(recipe, platformId) {
  const platforms = recipe?.requirements?.platforms;
  return !Array.isArray(platforms) || !platforms.length || platforms.includes(platformId);
}

const message = (error) => error?.message ?? String(error);

export async function collectNodeInventory({ nodeId, profile = {}, recipes = [], modelRoots = [], probes = {} } = {}) {
  const probe = {
    statfs: statfsGb,
    modelRootStatus: modelRootStatusForRecipe,
    commandExists,
    dockerImages,
    now: () => new Date().toISOString(),
    ...probes
  };
  const errors = [];
  const disks = [];
  for (const root of unique(modelRoots)) {
    try {
      disks.push({ root, ...(await probe.statfs(root)) });
    } catch {
      // A candidate root that does not exist on this node is not an error.
    }
  }
  const compatible = recipes.filter((recipe) => recipe?.id && recipeFitsPlatform(recipe, profile.platformId));
  const weights = [];
  for (const recipe of compatible) {
    for (const { root } of disks) {
      try {
        if ((await probe.modelRootStatus(recipe, root))?.complete === true) {
          weights.push({ recipeId: recipe.id, root, complete: true });
          break;
        }
      } catch (error) {
        errors.push(`weights ${recipe.id}: ${message(error)}`);
        break;
      }
    }
  }
  const commands = {};
  for (const command of unique(compatible.flatMap((recipe) => recipe.requirements?.commands ?? [])).sort()) {
    if (await probe.commandExists(command).catch(() => false)) commands[command] = true;
  }
  let images = [];
  if (commands.docker) {
    try {
      images = unique(await probe.dockerImages()).sort();
    } catch (error) {
      errors.push(`docker images: ${message(error)}`);
    }
  }
  return {
    ...inventoryFromProfile(profile),
    complete: true,
    nodeId,
    collectedAt: probe.now(),
    disks,
    weights,
    backends: { commands, dockerImages: images },
    ...(errors.length ? { errors } : {})
  };
}

export function createNodeInventoryCache({ collect, ttlMs = NODE_INVENTORY_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  let pending = null;
  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      pending ??= (async () => {
        try {
          const value = await collect();
          cached = { at: now(), value };
          return value;
        } finally {
          pending = null;
        }
      })();
      return pending;
    }
  };
}
