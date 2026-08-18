import crypto from 'node:crypto';

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeDomain(domain = {}) {
  const capacityGb = finiteNumber(domain.capacityGb ?? domain.memoryGb ?? domain.totalMemoryGb);
  const availableGb = finiteNumber(domain.availableGb ?? domain.availableMemoryGb);
  return {
    id: String(domain.id ?? domain.name ?? 'memory'),
    kind: String(domain.kind ?? domain.type ?? 'system'),
    ...(domain.backend ? { backend: String(domain.backend) } : {}),
    ...(capacityGb != null ? { capacityGb } : {}),
    ...(availableGb != null ? { availableGb } : {}),
    deviceIds: [...new Set((Array.isArray(domain.deviceIds) ? domain.deviceIds : []).map(String))].sort()
  };
}

export function memoryDomainsForProfile(profile = {}) {
  if (Array.isArray(profile.memoryDomains) && profile.memoryDomains.length) {
    return profile.memoryDomains.map(normalizeDomain);
  }
  const devices = Array.isArray(profile.devices) ? profile.devices : [];
  const totalMemoryGb = finiteNumber(profile.totalMemoryGb);
  const availableMemoryGb = finiteNumber(profile.availableMemoryGb);
  if (profile.isAppleSilicon) {
    return [
      normalizeDomain({
        id: 'unified:0',
        kind: 'unified',
        backend: 'metal',
        capacityGb: totalMemoryGb,
        availableGb: availableMemoryGb,
        deviceIds: ['cpu:0', ...devices.map((device) => device.id).filter(Boolean)]
      })
    ];
  }
  const domains = [];
  if (totalMemoryGb != null) {
    domains.push(
      normalizeDomain({
        id: 'system:0',
        kind: 'system',
        capacityGb: totalMemoryGb,
        availableGb: availableMemoryGb,
        deviceIds: ['cpu:0']
      })
    );
  }
  for (const device of devices) {
    const capacityGb = finiteNumber(device.memoryGb);
    if (capacityGb == null) continue;
    domains.push(
      normalizeDomain({
        id: `device:${device.id}`,
        kind: 'device',
        backend: device.backend,
        capacityGb,
        availableGb: device.availableMemoryGb,
        deviceIds: [device.id]
      })
    );
  }
  return domains;
}

export function machineTopologyFingerprint(profile = {}) {
  const domains = memoryDomainsForProfile(profile)
    .map(({ availableGb: _availableGb, ...domain }) => domain)
    .sort((left, right) => left.id.localeCompare(right.id));
  const devices = (Array.isArray(profile.devices) ? profile.devices : [])
    .map((device) => ({
      id: device.id,
      kind: device.kind,
      vendor: device.vendor,
      name: device.name,
      backend: device.backend,
      memoryGb: device.memoryGb,
      computeCapability: device.computeCapability
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const stable = {
    platform: profile.platform,
    arch: profile.arch,
    cpuBrand: profile.cpuBrand,
    logicalCpus: profile.logicalCpus,
    domains,
    devices
  };
  return `sha256:${crypto.createHash('sha256').update(stableJson(stable)).digest('hex')}`;
}

export function normalizeResourceEstimate(value = {}) {
  const estimate = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const memoryGb = finiteNumber(estimate.memoryGb ?? estimate.totalMemoryGb);
  const reserveGb = finiteNumber(estimate.reserveGb) ?? 0;
  const domains = (Array.isArray(estimate.domains) ? estimate.domains : [])
    .map((domain) => {
      const normalized = normalizeDomain(domain);
      const requiredGb = finiteNumber(domain.requiredGb ?? domain.memoryGb);
      return requiredGb == null ? null : { ...normalized, requiredGb };
    })
    .filter(Boolean);
  return {
    version: 1,
    ...(memoryGb != null ? { memoryGb } : {}),
    reserveGb,
    domains,
    source: String(estimate.source ?? 'recipe'),
    confidence: String(estimate.confidence ?? 'declared'),
    ...(estimate.contextWindow ? { contextWindow: Number(estimate.contextWindow) } : {}),
    ...(estimate.provenance ? { provenance: estimate.provenance } : {})
  };
}

function domainMatches(requirement, domain) {
  if (requirement.id && requirement.id !== 'memory' && requirement.id !== domain.id) return false;
  if (requirement.kind && requirement.kind !== domain.kind) return false;
  if (requirement.backend && requirement.backend !== domain.backend) return false;
  if (requirement.deviceIds.length && !requirement.deviceIds.some((id) => domain.deviceIds.includes(id))) return false;
  return true;
}

export function evaluateResourceFit(profile = {}, value = {}) {
  const estimate = normalizeResourceEstimate(value);
  const domains = memoryDomainsForProfile(profile);
  const requirements = estimate.domains.length
    ? estimate.domains
    : estimate.memoryGb != null
      ? [
          {
            id: 'memory',
            kind: profile.isAppleSilicon ? 'unified' : 'system',
            deviceIds: [],
            requiredGb: estimate.memoryGb
          }
        ]
      : [];
  if (!requirements.length) {
    return {
      version: 1,
      status: 'unknown',
      stableFit: null,
      currentlyLoadable: null,
      estimate,
      domains: [],
      reason: 'resource estimate is missing'
    };
  }
  const rows = requirements.map((requirement) => {
    const domain = domains.find((candidate) => domainMatches(requirement, candidate));
    const requiredGb = round(requirement.requiredGb + estimate.reserveGb);
    const capacityGb = finiteNumber(domain?.capacityGb);
    const availableGb = finiteNumber(domain?.availableGb);
    return {
      id: domain?.id ?? requirement.id,
      kind: domain?.kind ?? requirement.kind,
      ...(requirement.backend ? { backend: requirement.backend } : {}),
      requiredGb,
      capacityGb,
      availableGb,
      capacityMarginGb: capacityGb == null ? null : round(capacityGb - requiredGb),
      availableMarginGb: availableGb == null ? null : round(availableGb - requiredGb),
      fit: capacityGb == null ? null : capacityGb >= requiredGb,
      currentlyLoadable: availableGb == null ? null : availableGb >= requiredGb
    };
  });
  const stableFit = rows.some((row) => row.fit === false) ? false : rows.every((row) => row.fit === true) ? true : null;
  const currentlyLoadable = rows.some((row) => row.currentlyLoadable === false)
    ? false
    : rows.every((row) => row.currentlyLoadable === true)
      ? true
      : null;
  return {
    version: 1,
    status: stableFit === true ? 'fits' : stableFit === false ? 'does-not-fit' : 'unknown',
    stableFit,
    currentlyLoadable,
    estimate,
    topologyFingerprint: profile.topologyFingerprint ?? machineTopologyFingerprint(profile),
    domains: rows
  };
}
