import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/dashboard.mjs', import.meta.url), 'utf8');

assert(!source.includes('setHealth(false, "checking")'));
assert(source.includes('healthPill?.classList.add("refreshing")'));
assert(source.includes('healthPill?.classList.remove("refreshing")'));
assert(source.includes('setInterval(refresh, 2000)'));
assert(source.includes('const TOPOLOGY_MIN_ZOOM = .18'));
assert(source.includes('const TOPOLOGY_MAX_ZOOM = 1.5'));
assert(source.includes('const beforeZoom = fitZoom * beforeManual'));
assert(source.includes('camera.manual = nextZoom / fitZoom'));
assert(!source.includes('class="topology-key"'));
assert(!source.includes('aria-label="Topology legend"'));
assert(
  source.includes(
    'transitioning || (runtimeLoaded ? "hot" : isExternal ? "external" : runtimeStatus === "failed" ? "failed" : "cold")'
  )
);
assert(source.includes('state.models = models.models || []'));
assert(source.includes('state.physicalModels = physicalTopologyModels(state.models)'));
assert(source.includes('for (const model of route.memberModels || [])'));
assert(source.includes('const topologyModels = (state.physicalModels || []).map(model => {'));
assert(source.includes('model: item.resolvedModel || item.model'));
assert(!source.includes('const catalogModelIds = new Set'));
assert(!source.includes('["Ordered members", (model.aliasMembers || []).join(" → ") || "—"]'));
assert(!source.includes('transitioning || (liveConnections.length ? "serving"'));
assert(source.includes('Number(totals.decodeTokensPerSecond) > 0'));
assert(source.includes('const displayedOutputRate = liveOutputRate > 0 ? liveOutputRate : aggregateOutputRate || 0'));
assert(source.includes('outputRate: displayedOutputRate'));
assert(source.includes('const instantaneousModelRate = Math.max(0, Number(point.model.liveRate || 0))'));
assert(source.includes('const modelRateText = processing && instantaneousModelRate > .05'));
assert(!source.includes('smoothRate("model:" + point.model.id + ":display"'));
assert(!source.includes('state.smoothedRates.delete("model:" + id + ":display")'));
assert(!source.includes('live ? displayedLiveRate : point.model.averageRate'));
assert(source.includes('function nodeUsesUnifiedMemory(node)'));
assert(source.includes('/\\bgb10\\b|\\bdgx[ -]spark\\b/'));
assert(source.includes('function nodeHasDedicatedGpuMemory(node)'));
assert(source.includes('if (nodeHasGpu(node)) rows.push(["GPU", telemetry.gpu?.utilization])'));
assert(source.includes('if (nodeHasDedicatedGpuMemory(node))'));
assert(source.includes('height: Math.max(100, 82 + resources.length * 18)'));
assert(source.includes('ctx.roundRect(cardLeft, cardTop, nodeCardWidth, point.cardHeight, 6)'));
assert(!source.includes('[["CPU", cpu], ["RAM", ram], ["GPU", gpu], ["VRAM", gpuMemory]]'));
assert(!source.includes('gpuMemory == null ? "shared / unavailable"'));
assert(
  source.includes(
    'const connectorActive = selected && (point.model.state === "serving" || point.model.state === "external-processing")'
  )
);
assert(
  source.includes(
    'const selected = source.id == null || activeNodeIds.has(source.id) || (activeNodeIds.size === 0 && sources.length === 1)'
  )
);
assert(
  source.includes(
    '...(liveConnections.length ? (runtimeState.members || []).map(member => member.node).filter(Boolean) : [])'
  )
);
assert(
  source.includes('const processingRgb = point.model.state === "external-processing" ? "192,153,255" : "243,189,79"')
);
assert(source.includes('ctx.setLineDash([7, 5])'));
assert(source.includes('ctx.shadowColor = "rgba(" + processingRgb + ",.78)"'));
assert(source.includes('(summary.recentErrors || 0) + " ERR/1M"'));
assert(source.includes('["ERRORS/1M", summary.recentErrors || 0]'));
assert(source.includes('recentErrors: Math.max(0, Number(metrics.rolling?.minute?.errors || 0))'));
assert(!source.includes('errors: totals.errors || 0'));

const physicalStart = source.indexOf('    function physicalTopologyModels(models)');
const physicalEnd = source.indexOf('    function renderModels()', physicalStart);
assert(physicalStart >= 0 && physicalEnd > physicalStart);
const physicalContext = {};
vm.runInNewContext(
  source.slice(physicalStart, physicalEnd) + '\nglobalThis.physicalTopologyModels = physicalTopologyModels;',
  physicalContext
);
const physicalModels = physicalContext.physicalTopologyModels([
  { id: 'qwen3.8-flash-next', name: 'Qwen local' },
  {
    id: 'q38fn',
    alias: true,
    memberModels: [
      { id: 'qwen3.8-flash-next', name: 'Qwen local duplicate' },
      { id: 'cloud/openrouter/q38fn', name: 'Qwen external' }
    ]
  },
  { id: 'qwen38f-next', alias: true, memberModels: [] }
]);
assert.deepEqual(
  Array.from(physicalModels, (model) => model.id),
  ['qwen3.8-flash-next', 'cloud/openrouter/q38fn']
);
assert.deepEqual(Array.from(physicalModels[0].routeIds), ['q38fn']);
assert.deepEqual(Array.from(physicalModels[1].routeIds), ['q38fn']);

const clusterStart = source.indexOf('    function shortModel(value)');
const clusterEnd = source.indexOf('    function modelFieldDelta(', clusterStart);
assert(clusterStart >= 0 && clusterEnd > clusterStart);
const clusterContext = {};
vm.runInNewContext(
  source.slice(clusterStart, clusterEnd) + '\nglobalThis.clusterModelsByName = clusterModelsByName;',
  clusterContext
);
const clusters = clusterContext.clusterModelsByName([
  {
    id: 'qwen3.8-flash-next',
    name: 'Qwen3.8 Flash Next NVFP4',
    upstreamModel: 'qwen3.8-flash-next',
    routeIds: ['q38fn']
  },
  {
    id: 'cloud/openrouter/q38fn',
    name: 'Qwen3.8 Flash · OpenRouter',
    upstreamModel: 'qwen/qwen3.8-flash',
    routeIds: ['q38fn']
  },
  { id: 'z-ai/glm-5.2', name: 'GLM 5.2 · OpenRouter', upstreamModel: 'z-ai/glm-5.2', routeIds: [] }
]);
assert.deepEqual(
  Array.from(clusters, (cluster) => Array.from(cluster)),
  [['cloud/openrouter/q38fn', 'qwen3.8-flash-next'], ['z-ai/glm-5.2']]
);

const helperStart = source.indexOf('    function nodeAcceleratorSignals(node)');
const helperEnd = source.indexOf('    function renderModelInspector()', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart);
const helperContext = {};
vm.runInNewContext(
  source.slice(helperStart, helperEnd) + '\nglobalThis.nodeResourceRows = nodeResourceRows;',
  helperContext
);
const resourceLabels = (node) => Array.from(helperContext.nodeResourceRows(node), ([label]) => label);
const telemetry = {
  cpu: { utilization: 20 },
  memory: { pressureUtilization: 30 },
  gpu: { utilization: 40, memoryUsedMb: 1024, memoryTotalMb: 8192 }
};
assert.deepEqual(resourceLabels({ profile: { accelerators: [] }, telemetry: { ...telemetry, gpu: null } }), [
  'CPU',
  'RAM'
]);
assert.deepEqual(resourceLabels({ profile: { accelerators: ['cuda', 'dgx-spark', 'gb10'] }, telemetry }), [
  'CPU',
  'RAM',
  'GPU'
]);
assert.deepEqual(
  resourceLabels({ profile: { accelerators: ['cuda'], memoryDomains: [{ kind: 'unified' }] }, telemetry }),
  ['CPU', 'RAM', 'GPU']
);
assert.deepEqual(resourceLabels({ profile: { accelerators: ['cuda'] }, telemetry }), ['CPU', 'RAM', 'GPU', 'VRAM']);

console.log('dashboard status tests passed');
