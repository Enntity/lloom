import os from 'node:os';
import { runCommand } from './process-control.mjs';

export const MACHINE_PROFILE_SCHEMA = 'https://lloom.dev/schemas/machine-profile.v1.schema.json';
export const MACHINE_PROFILE_MEDIA_TYPE = 'application/vnd.lloom.machine-profile+json;version=1';
export const RECOMMENDATION_REQUEST_SCHEMA = 'https://lloom.dev/schemas/recommendation-request.v1.schema.json';
export const RECOMMENDATION_REQUEST_MEDIA_TYPE = 'application/vnd.lloom.recommendation-request+json;version=1';
export const RECOMMENDATION_RESPONSE_SCHEMA = 'https://lloom.dev/schemas/recommendation-response.v1.schema.json';
export const RECOMMENDATION_RESPONSE_MEDIA_TYPE = 'application/vnd.lloom.recommendation-response+json;version=1';
export const INTERCHANGE_PROFILE = 'https://lloom.dev/profiles/interchange/v1';

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function commandOutput(command, args) {
  const result = await runCommand(command, args, { allowFailure: true });
  if (result.code !== 0) return '';
  return result.stdout.trim();
}

function listValues(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

async function cpuBrand() {
  if (process.platform === 'darwin') {
    return await commandOutput('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']);
  }
  if (process.platform === 'linux') {
    const lines = await commandOutput('/bin/cat', ['/proc/cpuinfo']);
    return lines.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? '';
  }
  return os.cpus()[0]?.model ?? '';
}

async function commandExists(command) {
  const result = await runCommand('/usr/bin/which', [command], { allowFailure: true });
  return result.code === 0 && Boolean(result.stdout.trim());
}

function numericValue(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function deviceAccelerators(device) {
  const values = listValues(device.accelerators);
  const vendor = String(device.vendor ?? '').toLowerCase();
  const backend = String(device.backend ?? '').toLowerCase();
  const kind = String(device.kind ?? '').toLowerCase();
  const name = String(device.name ?? '').toLowerCase();
  const computeCapability = String(device.computeCapability ?? device.compute_cap ?? '');
  const major = Number(computeCapability.split('.')[0]);
  if (vendor === 'apple' && kind === 'gpu') values.push('apple-gpu', 'metal');
  if (vendor === 'apple' && (kind === 'npu' || backend === 'ane')) values.push('apple-neural-engine', 'ane');
  if (vendor === 'nvidia') values.push('nvidia-gpu');
  if (backend === 'cuda') values.push('cuda');
  if (backend === 'metal') values.push('metal');
  // DGX Spark / GB10 class (Blackwell, SM 12.x) and name heuristics.
  if (Number.isFinite(major) && major >= 12) values.push('blackwell');
  if (/\bgb10\b|\bdgx\s*spark\b|\bspark\b.*\bnvidia\b|\bnvidia\b.*\bspark\b/.test(name)) {
    values.push('blackwell', 'dgx-spark', 'gb10');
  }
  if (name.includes('blackwell')) values.push('blackwell');
  return [...new Set(values)];
}

function normalizeDevice(device = {}) {
  if (!device || typeof device !== 'object' || Array.isArray(device)) return null;
  const kind = device.kind ?? device.type;
  const vendor = device.vendor ?? device.manufacturer;
  const backend = device.backend ?? device.runtime;
  const memoryGb = numericValue(device.memoryGb, device.memory_gb, device.vramGb, device.vram_gb, device.totalMemoryGb);
  const normalized = {
    ...(device.id ? { id: String(device.id) } : {}),
    ...(kind ? { kind: String(kind) } : {}),
    ...(vendor ? { vendor: String(vendor) } : {}),
    ...(device.name ? { name: String(device.name) } : {}),
    ...(backend ? { backend: String(backend) } : {}),
    ...(memoryGb != null ? { memoryGb } : {}),
    ...(device.computeCapability ? { computeCapability: String(device.computeCapability) } : {})
  };
  const accelerators = deviceAccelerators({ ...device, ...normalized });
  if (accelerators.length) normalized.accelerators = accelerators;
  if (!normalized.id && normalized.kind && normalized.vendor) {
    normalized.id = `${normalized.vendor}-${normalized.kind}`.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-');
  }
  return Object.keys(normalized).length ? normalized : null;
}

function appleSiliconDevices() {
  return [
    normalizeDevice({
      id: 'apple-gpu',
      kind: 'gpu',
      vendor: 'apple',
      name: 'Apple GPU',
      backend: 'metal',
      accelerators: ['apple-gpu', 'metal']
    }),
    normalizeDevice({
      id: 'apple-neural-engine',
      kind: 'npu',
      vendor: 'apple',
      name: 'Apple Neural Engine',
      backend: 'ane',
      accelerators: ['apple-neural-engine', 'ane']
    })
  ].filter(Boolean);
}

function mergeAccelerators({ accelerators, devices, isAppleSilicon }) {
  const merged = new Set(listValues(accelerators));
  if (isAppleSilicon) {
    merged.add('apple-gpu');
    merged.add('apple-neural-engine');
  }
  for (const device of devices) {
    for (const accelerator of deviceAccelerators(device)) merged.add(accelerator);
  }
  return [...merged];
}

async function detectCudaDevices() {
  if (!(await commandExists('nvidia-smi'))) return [];
  const output = await commandOutput('nvidia-smi', [
    '--query-gpu=index,name,memory.total,compute_cap',
    '--format=csv,noheader,nounits'
  ]);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, memoryMiB, computeCapability] = line.split(',').map((value) => value.trim());
      const memoryGb = numericValue(memoryMiB) == null ? undefined : round(Number(memoryMiB) / 1024, 1);
      const accelerators = ['cuda', 'nvidia-gpu'];
      const major = Number(String(computeCapability ?? '').split('.')[0]);
      if (Number.isFinite(major) && major >= 12) accelerators.push('blackwell');
      const nameLower = String(name ?? '').toLowerCase();
      if (/\bgb10\b|\bdgx\s*spark\b|blackwell/.test(nameLower)) {
        accelerators.push('blackwell', 'dgx-spark', 'gb10');
      }
      return normalizeDevice({
        id: `cuda:${index}`,
        kind: 'gpu',
        vendor: 'nvidia',
        name,
        backend: 'cuda',
        memoryGb,
        computeCapability,
        accelerators: [...new Set(accelerators)]
      });
    })
    .filter(Boolean);
}

function profileId(profile) {
  const memory =
    profile.totalMemoryGb == null ? 'unknown-memory' : `${String(profile.totalMemoryGb).replace(/\./g, '_')}gb`;
  return `${profile.platformId ?? 'unknown-platform'}-${memory}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function normalizeMachineProfile(profile = {}) {
  const platform = profile.platform ?? profile.os ?? process.platform;
  const arch = profile.arch ?? process.arch;
  const platformId = profile.platformId ?? `${platform}-${arch}`;
  const totalMemoryGb = numericValue(profile.totalMemoryGb, profile.memoryGb, profile.memory_gb);
  const isAppleSilicon = profile.isAppleSilicon ?? (platform === 'darwin' && arch === 'arm64');
  const devices = Array.isArray(profile.devices)
    ? profile.devices.map(normalizeDevice).filter(Boolean)
    : isAppleSilicon
      ? appleSiliconDevices()
      : [];
  return {
    $schema: MACHINE_PROFILE_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id: profile.id ?? profileId({ platformId, totalMemoryGb }),
    platform,
    arch,
    platformId,
    cpuBrand: profile.cpuBrand ?? profile.cpu ?? '',
    totalMemoryGb,
    logicalCpus: profile.logicalCpus ?? profile.cpuCount,
    accelerators: mergeAccelerators({
      accelerators: profile.accelerators,
      devices,
      isAppleSilicon
    }),
    devices,
    isAppleSilicon,
    ...(profile.modelRoot ? { 'x-local-modelRoot': profile.modelRoot } : {})
  };
}

export function validateMachineProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return ['machine profile must be an object'];
  }
  if (profile.$schema && profile.$schema !== MACHINE_PROFILE_SCHEMA) {
    errors.push(`machine profile has unsupported $schema ${profile.$schema}`);
  }
  if (profile.schemaVersion !== 1) errors.push('machine profile schemaVersion must be 1');
  if (!profile.id) errors.push('machine profile id is required');
  if (!profile.platform) errors.push('machine profile platform is required');
  if (!profile.arch) errors.push('machine profile arch is required');
  if (!profile.platformId) errors.push('machine profile platformId is required');
  if (profile.totalMemoryGb != null && !Number.isFinite(Number(profile.totalMemoryGb))) {
    errors.push('machine profile totalMemoryGb must be a number');
  } else if (profile.totalMemoryGb != null && Number(profile.totalMemoryGb) < 0) {
    errors.push('machine profile totalMemoryGb must be greater than or equal to 0');
  }
  if (profile.logicalCpus != null && !Number.isInteger(Number(profile.logicalCpus))) {
    errors.push('machine profile logicalCpus must be an integer when provided');
  }
  if (profile.accelerators != null && !Array.isArray(profile.accelerators)) {
    errors.push('machine profile accelerators must be an array when provided');
  }
  if (profile.devices != null && !Array.isArray(profile.devices)) {
    errors.push('machine profile devices must be an array when provided');
  }
  return errors;
}

function validateStringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) return [`${label} must be an array when provided`];
  return value
    .map((item, index) =>
      typeof item === 'string' && item.trim() ? null : `${label}[${index}] must be a non-empty string`
    )
    .filter(Boolean);
}

export function validateRecommendationRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return ['recommendation request must be an object'];
  }
  if (request.$schema && request.$schema !== RECOMMENDATION_REQUEST_SCHEMA) {
    errors.push(`recommendation request has unsupported $schema ${request.$schema}`);
  }
  if (request.schemaVersion !== 1) errors.push('recommendation request schemaVersion must be 1');
  if (!request.id) errors.push('recommendation request id is required');
  errors.push(...validateMachineProfile(request.machineProfile).map((error) => `machineProfile: ${error}`));
  if (request.request != null && (typeof request.request !== 'object' || Array.isArray(request.request))) {
    errors.push('recommendation request request must be an object when provided');
  }
  const intent =
    request.request && typeof request.request === 'object' && !Array.isArray(request.request) ? request.request : {};
  if (intent.filters != null && (typeof intent.filters !== 'object' || Array.isArray(intent.filters))) {
    errors.push('recommendation request request.filters must be an object when provided');
  }
  const filters =
    intent.filters && typeof intent.filters === 'object' && !Array.isArray(intent.filters) ? intent.filters : {};
  errors.push(...validateStringList(intent.workloads, 'request.workloads'));
  errors.push(...validateStringList(intent.capabilities, 'request.capabilities'));
  errors.push(...validateStringList(intent.tags, 'request.tags'));
  errors.push(...validateStringList(filters.workloads, 'request.filters.workloads'));
  errors.push(...validateStringList(filters.capabilities, 'request.filters.capabilities'));
  errors.push(...validateStringList(filters.tags, 'request.filters.tags'));
  if (request.limit != null && (!Number.isInteger(Number(request.limit)) || Number(request.limit) < 1)) {
    errors.push('recommendation request limit must be a positive integer when provided');
  }
  return errors;
}

export function buildRecommendationResponse({
  id = 'lloom-recommendations',
  name = 'LLooM Recipe Recommendations',
  machineProfile,
  recommendations = [],
  request,
  provenance
} = {}) {
  return {
    $schema: RECOMMENDATION_RESPONSE_SCHEMA,
    schemaVersion: 1,
    profile: INTERCHANGE_PROFILE,
    id,
    name,
    machineProfile: normalizeMachineProfile(machineProfile),
    recommendationCount: recommendations.length,
    ...(request ? { request } : {}),
    recommendations,
    provenance: provenance ?? {
      generatedBy: 'lloom-host'
    }
  };
}

export function validateRecommendationResponse(response) {
  const errors = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return ['recommendation response must be an object'];
  }
  if (response.$schema && response.$schema !== RECOMMENDATION_RESPONSE_SCHEMA) {
    errors.push(`recommendation response has unsupported $schema ${response.$schema}`);
  }
  if (response.schemaVersion !== 1) errors.push('recommendation response schemaVersion must be 1');
  if (!response.id) errors.push('recommendation response id is required');
  if (!response.name) errors.push('recommendation response name is required');
  errors.push(...validateMachineProfile(response.machineProfile).map((error) => `machineProfile: ${error}`));
  if (!Array.isArray(response.recommendations)) {
    errors.push('recommendation response recommendations must be an array');
  } else {
    for (const [index, recommendation] of response.recommendations.entries()) {
      if (!recommendation?.id) errors.push(`recommendations[${index}].id is required`);
      if (!recommendation?.recipeId) errors.push(`recommendations[${index}].recipeId is required`);
      if (!recommendation?.pack && !recommendation?.url && !recommendation?.source && !recommendation?.href) {
        errors.push(`recommendations[${index}] must include pack, url, source, or href`);
      }
    }
    if (response.recommendationCount != null && response.recommendationCount !== response.recommendations.length) {
      errors.push('recommendation response recommendationCount must match recommendations length');
    }
  }
  return errors;
}

export async function profileMachine({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const totalMemoryGb = round(os.totalmem() / 1024 / 1024 / 1024, 1);
  const logicalCpus = os.cpus().length;
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';
  const devices = [...(isAppleSilicon ? appleSiliconDevices() : []), ...(await detectCudaDevices())];
  return normalizeMachineProfile({
    platform,
    arch,
    cpuBrand: await cpuBrand(),
    totalMemoryGb,
    logicalCpus,
    isAppleSilicon,
    devices,
    modelRoot: env.LLOOM_MODEL_ROOT ?? env.LLOOM_MTPLX_MODEL_ROOT ?? ''
  });
}

export async function evaluateRecipe(recipe, profile, { checkCommands = true } = {}) {
  const requirements = recipe.requirements ?? {};
  const platforms = Array.isArray(requirements.platforms) ? requirements.platforms : [];
  const requiredCommands = Array.isArray(requirements.commands) ? requirements.commands : [];
  const requiredAccelerators = Array.isArray(requirements.accelerators) ? requirements.accelerators : [];
  const memoryRequired = Number(requirements.memoryGb ?? 0);
  const platformSupported = !platforms.length || platforms.includes(profile.platformId);
  const profileMemoryGb = Number(profile.totalMemoryGb);
  const memoryKnown = Number.isFinite(profileMemoryGb);
  const memorySupported = !memoryRequired ? true : memoryKnown ? profileMemoryGb >= memoryRequired : null;
  const profileAccelerators = new Set(Array.isArray(profile.accelerators) ? profile.accelerators : []);
  const missingAccelerators = requiredAccelerators.filter((accelerator) => !profileAccelerators.has(accelerator));
  const acceleratorsSupported = missingAccelerators.length === 0;
  const commands = [];
  for (const command of requiredCommands) {
    commands.push({
      command,
      available: checkCommands ? await commandExists(command) : null
    });
  }
  const missingCommands = commands.filter((command) => command.available === false).map((command) => command.command);
  const selectable = platformSupported && memorySupported !== false && acceleratorsSupported;
  const setupRequired = selectable && missingCommands.length > 0;
  const runnable = selectable && !setupRequired;
  const score = [
    platformSupported ? 50 : 0,
    memorySupported === true ? 25 : memorySupported === null ? 8 : 0,
    acceleratorsSupported ? 10 : 0,
    missingCommands.length === 0 ? 15 : 0,
    Number(recipe.version ?? 1)
  ].reduce((sum, value) => sum + value, 0);

  return {
    recipeId: recipe.id,
    name: recipe.name,
    platformSupported,
    memorySupported,
    memoryRequiredGb: memoryRequired || null,
    acceleratorsSupported,
    requiredAccelerators,
    missingAccelerators,
    commands,
    missingCommands,
    selectable,
    setupRequired,
    runnable,
    score,
    reasons: [
      ...(platformSupported ? [] : [`requires platform ${platforms.join(', ')}`]),
      ...(memorySupported === false ? [`requires ${memoryRequired} GB memory`] : []),
      ...(memorySupported === null ? [`memory unknown; recipe requires ${memoryRequired} GB`] : []),
      ...missingAccelerators.map((accelerator) => `requires accelerator ${accelerator}`),
      ...missingCommands.map((command) => `missing command ${command}`)
    ]
  };
}

export async function rankRecipes(recipes, profile, options = {}) {
  const evaluations = [];
  for (const recipe of recipes) {
    evaluations.push(await evaluateRecipe(recipe, profile, options));
  }
  return evaluations.sort((a, b) => {
    if (a.selectable !== b.selectable) return a.selectable ? -1 : 1;
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return String(a.name).localeCompare(String(b.name));
  });
}
