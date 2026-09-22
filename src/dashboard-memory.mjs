function buildMemoryMap({ node = null, runtimes = {}, models = [], previewModelId = null, memorySafety = null } = {}) {
  if (node?.local !== true && node?.runtimeManager?.runtimes) {
    runtimes = { ...runtimes };
    for (const [id, observed] of Object.entries(node.runtimeManager.runtimes)) {
      runtimes[id] = { ...runtimes[id], ...observed, node: node.id, remote: false };
    }
  }
  const GiB = 1024 * 1024 * 1024;

  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function nonNegativeOrNull(value) {
    const number = numberOrNull(value);
    return number !== null && number >= 0 ? number : null;
  }

  function bounded(value, minimum, maximum) {
    const number = numberOrNull(value);
    return number === null || number < minimum || number > maximum ? null : number;
  }

  function positiveOrNull(value) {
    const number = numberOrNull(value);
    return number !== null && number > 0 ? number : null;
  }

  function sameNode(runtime, currentNode) {
    if (
      !runtime ||
      runtime.remote === true ||
      runtime.distributed === true ||
      runtime.placement?.mode === 'distributed'
    )
      return false;
    const placementNode = runtimeNode(runtime);
    if (placementNode) return placementNode === currentNode;
    return node?.local === true;
  }

  function runtimeNode(runtime) {
    return runtime?.node ?? runtime?.placement?.node ?? null;
  }

  function safetyReserve(policy, total) {
    if (!policy) return null;
    if (policy.mode === 'yolo') return 0;
    const minAvailable = nonNegativeOrNull(policy.minAvailableMemoryGb);
    const maxUtilization = nonNegativeOrNull(policy.maxMemoryUtilization);
    if (minAvailable === null || maxUtilization === null || maxUtilization > 1) return null;
    return Math.min(total, Math.max(minAvailable * GiB, total * (1 - maxUtilization)));
  }

  function colorIndex(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = (hash * 16777619) >>> 0;
    }
    return hash % 8;
  }

  function targetNodes(model) {
    return (Array.isArray(model?.targets) ? model.targets : [])
      .map((target) => {
        if (typeof target === 'string') return target;
        return target?.node ?? target?.id ?? null;
      })
      .filter(Boolean);
  }

  function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));
  }

  function roundPercent(value) {
    return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  }

  const nodeId = node?.id ?? null;
  const telemetryMemory = node?.telemetry?.memory;
  const totalBytes = nonNegativeOrNull(telemetryMemory?.totalBytes);
  const availableBytes = telemetryMemory ? bounded(telemetryMemory.availableBytes, 0, totalBytes) : null;
  const reportedUsedBytes = telemetryMemory ? bounded(telemetryMemory.usedBytes, 0, totalBytes) : null;
  const hasCapacity = typeof totalBytes === 'number' && totalBytes > 0;
  const invalidAvailable = telemetryMemory?.availableBytes != null && availableBytes === null;
  const invalidUsed = telemetryMemory?.usedBytes != null && reportedUsedBytes === null;
  const hasMemoryFacts =
    hasCapacity && !invalidAvailable && !invalidUsed && (availableBytes !== null || reportedUsedBytes !== null);
  const known =
    (node?.reachable === true || (node?.local === true && node?.reachable !== false)) && hasCapacity && hasMemoryFacts;
  let usedBytes;
  let availableMemoryBytes;
  if (hasCapacity && availableBytes !== null) {
    availableMemoryBytes = availableBytes;
    usedBytes = totalBytes - availableBytes;
  } else if (hasCapacity && reportedUsedBytes !== null) {
    usedBytes = reportedUsedBytes;
    availableMemoryBytes = totalBytes - usedBytes;
  } else {
    usedBytes = null;
    availableMemoryBytes = null;
  }
  const activePolicy = node?.local === true ? memorySafety : node?.runtimeManager?.memorySafety;
  const reserveBytes = hasMemoryFacts ? safetyReserve(activePolicy, totalBytes) : null;
  const usableBytes = hasMemoryFacts && reserveBytes !== null ? Math.max(0, availableMemoryBytes - reserveBytes) : null;

  if (!known) {
    return {
      known: false,
      totalBytes: hasCapacity ? totalBytes : null,
      usedBytes: null,
      availableBytes: hasCapacity ? availableBytes : null,
      reserveBytes: null,
      usableBytes: null,
      nodeId,
      segments: [],
      attributionNote: 'Memory telemetry is unavailable; no allocation is inferred.',
      preview: null
    };
  }

  const runtimeIds = Object.keys(runtimes ?? {}).sort((left, right) => left.localeCompare(right));
  const includedRuntimeIds = [];
  for (const runtimeId of runtimeIds) {
    const runtime = runtimes[runtimeId];
    const status = String(runtime?.status ?? '').toLowerCase();
    const active = ['running', 'healthy', 'starting', 'warming', 'external', 'stopping', 'draining'].includes(status);
    if (!active || runtime?.paused === true) continue;
    if (!sameNode(runtime, nodeId)) continue;
    includedRuntimeIds.push(runtimeId);
  }

  const runtimeGroups = new Map();
  for (const runtimeId of includedRuntimeIds) {
    const runtime = runtimes[runtimeId];
    const usage = runtime?.memoryUsage;
    const groupId = typeof usage?.groupId === 'string' && usage.groupId ? usage.groupId : `runtime:${runtimeId}`;
    if (!runtimeGroups.has(groupId)) {
      runtimeGroups.set(groupId, { runtimeIds: [], usage: null });
    }
    const group = runtimeGroups.get(groupId);
    group.runtimeIds.push(runtimeId);
    if (!group.usage) group.usage = usage ?? null;
  }

  const attributed = [];
  for (const [groupId, group] of runtimeGroups) {
    const primaryRuntimeId = group.runtimeIds[0];
    const runtime = runtimes[primaryRuntimeId];
    const usages = group.runtimeIds.map((runtimeId) => runtimes[runtimeId]?.memoryUsage).filter(Boolean);
    const rssValues = usages.map((usage) => nonNegativeOrNull(usage.residentBytes)).filter((value) => value !== null);
    const rssBytes = rssValues.length ? Math.max(...rssValues) : null;
    const estimateValues = group.runtimeIds
      .map((runtimeId) => positiveOrNull(runtimes[runtimeId]?.memoryGb))
      .filter((value) => value !== null)
      .map((value) => value * GiB);
    const bytes = rssBytes !== null ? rssBytes : estimateValues.length ? Math.max(...estimateValues) : null;
    if (bytes === null) continue;
    const modelIds = new Set();
    for (const runtimeId of group.runtimeIds) {
      for (const model of models ?? []) {
        if (model?.runtime === runtimeId) {
          if (model.id) modelIds.add(model.id);
        }
      }
    }
    const names = uniqueSorted([...modelIds].map((id) => models.find((model) => model.id === id)?.name || id));
    const label = names.length
      ? names.slice(0, 2).join(' + ') + (names.length > 2 ? ' +' + (names.length - 2) : '')
      : (runtime?.id ?? primaryRuntimeId);
    const estimated = rssBytes === null;
    attributed.push({
      id: groupId,
      kind: 'runtime',
      label,
      bytes: Math.round(bytes),
      percent: roundPercent((bytes / totalBytes) * 100),
      runtimeId: primaryRuntimeId,
      modelIds: uniqueSorted([...modelIds]),
      estimated
    });
  }

  let reconciliationScale = 1;
  let attributedBytes = attributed.reduce((sum, segment) => sum + segment.bytes, 0);
  if (attributedBytes > usedBytes) {
    reconciliationScale = usedBytes / attributedBytes;
    for (const segment of attributed) {
      segment.bytes = Math.round(segment.bytes * reconciliationScale);
      segment.estimated = true;
    }
    attributedBytes = attributed.reduce((sum, segment) => sum + segment.bytes, 0);
  }
  attributed.sort((left, right) => String(left.runtimeId).localeCompare(String(right.runtimeId)));
  const colors = new Set();
  for (const segment of attributed) {
    let index = colorIndex(segment.runtimeId);
    if (colors.size < 8) while (colors.has(index)) index = (index + 1) % 8;
    colors.add(index);
    segment.colorIndex = index;
    segment.percent = roundPercent((segment.bytes / totalBytes) * 100);
  }

  if (attributedBytes > usedBytes && attributed.length) {
    const excess = attributedBytes - usedBytes;
    const largest = attributed.reduce((left, right) => (right.bytes > left.bytes ? right : left));
    largest.bytes = Math.max(0, largest.bytes - excess);
    attributedBytes = attributed.reduce((sum, segment) => sum + segment.bytes, 0);
  }
  for (const segment of attributed) segment.percent = roundPercent((segment.bytes / totalBytes) * 100);
  const systemBytes = Math.max(0, usedBytes - attributedBytes);

  const segments = [...attributed];
  if (systemBytes > 0 || usedBytes === 0) {
    segments.push({
      id: 'system',
      kind: 'system',
      label: 'System & other apps',
      bytes: systemBytes,
      percent: roundPercent((systemBytes / totalBytes) * 100),
      runtimeId: null,
      modelIds: [],
      estimated: false,
      colorIndex: 8
    });
  }
  const availableSegmentBytes = totalBytes - usedBytes;
  segments.push({
    id: 'available',
    kind: 'available',
    label: 'Available',
    bytes: availableSegmentBytes,
    percent: roundPercent((availableSegmentBytes / totalBytes) * 100),
    runtimeId: null,
    modelIds: [],
    estimated: false,
    colorIndex: 9
  });

  const attributionParts = ['Live process memory is approximate. Shared models use one block. Previews are estimates.'];
  if (reconciliationScale !== 1)
    attributionParts.push('App measurements overlap; blocks are adjusted to match total memory in use.');
  if (
    [...runtimeGroups.values()].some((group) =>
      group.runtimeIds.every((runtimeId) => {
        const usage = runtimes[runtimeId]?.memoryUsage;
        return !usage || nonNegativeOrNull(usage.residentBytes) === null;
      })
    )
  )
    attributionParts.push('Striped blocks use an estimate until a live reading is available.');

  const preview = previewModelId ? previewModel(previewModelId) : null;
  function previewModel(modelId) {
    const model = (models ?? []).find((item) => item?.id === modelId);
    if (!model) return null;
    const runtimeId = model.runtime ?? null;
    const runtime = runtimeId ? runtimes[runtimeId] : null;
    const label = model.name ?? model.id;
    const base = {
      modelId,
      label,
      runtimeId,
      status: 'unknown',
      additionalBytes: null,
      remainingBytes: null,
      projectedUsedBytes: null,
      percent: null,
      nodeId,
      shared: false,
      message: ''
    };
    const targets = targetNodes(model);
    const otherTargets = targets.filter((target) => target !== nodeId);
    const allTargetsAreOther = targets.length > 0 && otherTargets.length === targets.length;
    const runtimePlacementNode = runtime ? runtimeNode(runtime) : null;
    const runtimeIsOtherNode =
      (runtime?.remote === true && runtimePlacementNode === null) ||
      (runtimePlacementNode !== null && runtimePlacementNode !== nodeId);
    if (runtimeIsOtherNode || allTargetsAreOther) {
      return {
        ...base,
        status: 'other-node',
        additionalBytes: 0,
        projectedUsedBytes: usedBytes,
        remainingBytes: availableMemoryBytes,
        percent: roundPercent((usedBytes / totalBytes) * 100),
        nodeId: targets[0] ?? runtimePlacementNode,
        message: `Runs on node ${targets[0] ?? runtimePlacementNode ?? 'another node'}; no impact on this machine.`
      };
    }
    if (runtime?.distributed === true || runtime?.placement?.mode === 'distributed' || new Set(targets).size > 1) {
      return { ...base, status: 'unknown', shared: true, message: 'Needs room on each machine.' };
    }
    if (
      runtime?.maintenance ||
      runtime?.enabled === false ||
      runtime?.paused === true ||
      runtime?.status === 'paused' ||
      model.paused === true
    ) {
      return { ...base, status: 'paused', message: 'Paused; automatic starts are disabled.' };
    }
    if (!runtimeId) {
      return {
        ...base,
        status: 'external',
        additionalBytes: 0,
        projectedUsedBytes: usedBytes,
        remainingBytes: availableMemoryBytes,
        percent: roundPercent((usedBytes / totalBytes) * 100),
        message: 'No local model load is expected.'
      };
    }
    if (!runtime) {
      return { ...base, status: 'unknown', message: 'No runtime status is available.' };
    }
    const usage = runtime.memoryUsage;
    const loadedIds = Array.isArray(usage?.loadedModelIds) ? usage.loadedModelIds : null;
    const wantedId = model.upstreamModel ?? model.id;
    const residentConfirmed =
      runtime.healthy === true &&
      usage?.residencyKnown === true &&
      loadedIds !== null &&
      (loadedIds.includes(wantedId) || loadedIds.includes(model.id));
    const commandParts = String(runtime.command ?? '')
      .trim()
      .split(/\s+/);
    const commandBase = commandParts[0]?.split(/[\\/]/).pop() ?? '';
    const lazyBackend = [commandBase, ...(runtime.args ?? [])].some((part) =>
      /(?:^|[/\\])(ollama|lloom-audio-server|lloom_audio_server(?:\.py)?)$/.test(String(part))
    );
    const sharedBackend = usage?.sharedRuntimeIds?.length > 1 || lazyBackend;
    const modelsOnRuntime = (models ?? []).filter((item) => item?.runtime === runtimeId);
    const runtimeIsSharedGroup = runtimeGroups.get(usage?.groupId ?? `runtime:${runtimeId}`)?.runtimeIds.length > 1;
    if (residentConfirmed) {
      return {
        ...base,
        status: 'resident',
        additionalBytes: 0,
        projectedUsedBytes: usedBytes,
        remainingBytes: availableMemoryBytes,
        percent: roundPercent((usedBytes / totalBytes) * 100),
        shared: sharedBackend || runtimeIsSharedGroup,
        message:
          sharedBackend || runtimeIsSharedGroup
            ? 'Already available; shared backend footprint can change.'
            : 'Already available'
      };
    }
    if (sharedBackend && runtime.healthy === true && !(usage?.residencyKnown && loadedIds !== null)) {
      return { ...base, status: 'unknown', shared: true, message: 'Shared backend residency is unknown.' };
    }
    const memoryGb = positiveOrNull(runtime.memoryGb);
    if (memoryGb === null) {
      return { ...base, status: 'unknown', message: 'Cold start estimate is unknown.' };
    }
    // A healthy server may load weights lazily. Only confirmed model-cache
    // observations promise residency; otherwise forecast growth toward its peak.
    const measured =
      !sharedBackend && !runtimeIsSharedGroup && modelsOnRuntime.length === 1 && runtime.healthy === true
        ? nonNegativeOrNull(usage?.residentBytes)
        : null;
    const incoming = Math.max(0, memoryGb * GiB - (measured ?? 0));
    const remaining = availableMemoryBytes - incoming;
    const reserve = reserveBytes ?? null;
    if (reserve === null) {
      return {
        ...base,
        status: 'unknown',
        additionalBytes: incoming,
        remainingBytes: remaining,
        projectedUsedBytes: usedBytes + incoming,
        percent: roundPercent((incoming / totalBytes) * 100),
        shared: sharedBackend,
        message: 'Memory reserve is unknown; no fit is guaranteed.'
      };
    }
    if (remaining <= reserve) {
      return {
        ...base,
        status: 'blocked',
        additionalBytes: incoming,
        remainingBytes: remaining,
        projectedUsedBytes: usedBytes + incoming,
        percent: roundPercent((incoming / totalBytes) * 100),
        shared: sharedBackend,
        message: 'Does not fit within the reserve.'
      };
    }
    const tightLimit = reserve + Math.max(GiB, totalBytes * 0.02);
    const tight = remaining <= tightLimit;
    return {
      ...base,
      status: tight ? 'tight' : 'fits',
      additionalBytes: incoming,
      remainingBytes: remaining,
      projectedUsedBytes: usedBytes + incoming,
      percent: roundPercent((incoming / totalBytes) * 100),
      shared: sharedBackend,
      message: tight ? 'Expected to fit, with little reserve headroom.' : 'Expected to fit'
    };
  }

  return {
    known: true,
    totalBytes,
    usedBytes,
    availableBytes: availableMemoryBytes,
    reserveBytes,
    usableBytes,
    nodeId,
    segments,
    attributionNote: attributionParts.join(' '),
    preview
  };
}

export { buildMemoryMap };
