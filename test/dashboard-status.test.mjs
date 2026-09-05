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
assert(!source.includes('"LOCAL MODELS"'));
assert(!source.includes('"EXTERNAL MODELS"'));
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
assert(
  source.includes('const bufferedOutputPending = active.some(item => item.stream === false && !item.responseBytes)')
);
assert(
  source.includes(
    'const displayedOutputRate = liveOutputRate > 0 ? liveOutputRate : bufferedOutputPending ? 0 : aggregateOutputRate || 0'
  )
);
assert(source.includes('const clusterResults = summary.outputPending'));
assert(source.includes('? "BUFFERED · " + (summary.recentErrors || 0) + " ERR/1M"'));
assert(source.includes('outputRate: displayedOutputRate'));
assert(source.includes('outputPending: bufferedOutputPending'));
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

const columnStart = source.indexOf('    function shortModel(value)');
const columnEnd = source.indexOf('    function smoothRate(', columnStart);
assert(columnStart >= 0 && columnEnd > columnStart);
const columnContext = { nodeResourceRows: () => [] };
vm.runInNewContext(
  source.slice(columnStart, columnEnd) +
    '\nglobalThis.topologyModelColumns = topologyModelColumns;' +
    '\nglobalThis.assignModelColumnTargets = assignModelColumnTargets;' +
    '\nglobalThis.topologyViewportColumns = topologyViewportColumns;' +
    '\nglobalThis.topologyRequiredWorldScale = topologyRequiredWorldScale;' +
    '\nglobalThis.topologyRackWidth = topologyRackWidth;',
  columnContext
);
const topologyModels = [
  { id: 'qwen3-embedding:4b', name: 'Qwen3 Embedding 4B', placement: 'local', runtimeIds: ['embedding'] },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', placement: 'local', runtimeIds: ['deepseek'] },
  { id: 'cloud/qwen', name: 'Qwen3.8 Flash · OpenRouter', placement: 'external', runtimeIds: [] },
  { id: 'cloud/glm', name: 'GLM 5.2 · OpenRouter', placement: 'external', runtimeIds: [] }
];
const columns = columnContext.topologyModelColumns(topologyModels);
assert.deepEqual(
  Array.from(columns, (column) => [column.id, Array.from(column.models, (model) => model.id)]),
  [
    ['local', ['deepseek-v4-flash', 'qwen3-embedding:4b']],
    ['external', ['cloud/glm', 'cloud/qwen']]
  ]
);
assert.deepEqual(
  Array.from(
    columnContext.topologyModelColumns(topologyModels.filter((model) => model.placement === 'external')),
    (column) => column.id
  ),
  ['external']
);
const columnLayout = columnContext.assignModelColumnTargets(topologyModels, {
  left: 500,
  right: 1100,
  top: 128,
  bottom: 872
});
assert(columnLayout.targets.get('deepseek-v4-flash').x < columnLayout.targets.get('cloud/glm').x);
assert(columnLayout.targets.get('deepseek-v4-flash').y < columnLayout.targets.get('qwen3-embedding:4b').y);
assert(columnLayout.targets.get('cloud/glm').y < columnLayout.targets.get('cloud/qwen').y);
const soloLayout = columnContext.assignModelColumnTargets(
  [{ id: 'only', name: 'Only external', placement: 'external', runtimeIds: [] }],
  { left: 500, right: 1100, top: 128, bottom: 872 }
);
assert.equal(soloLayout.columns.length, 1);
assert.equal(soloLayout.columns[0].id, 'external');
assert.equal(soloLayout.targets.get('only').y, 500);

// Responsive racks keep group order and expand beyond two columns when space permits.
const crowdedModels = [
  ...Array.from({ length: 3 }, (_, i) => ({ id: 'local/' + i, placement: 'local' })),
  ...Array.from({ length: 18 }, (_, i) => ({ id: 'cloud/' + i, placement: 'external' }))
];
const responsiveColumns = (width, height = 586) => columnContext.topologyModelColumns(crowdedModels, width, height);
assert.equal(responsiveColumns(500).length, 2);
assert.equal(responsiveColumns(900).length, 3);
assert.equal(responsiveColumns(1200).length, 4);
assert.equal(responsiveColumns(1600, 300).length, 6);
assert.equal(responsiveColumns(1600, 1800).length, 2);
const wideColumns = responsiveColumns(1200);
assert.deepEqual(
  Array.from(wideColumns, (column) => column.id),
  ['local', 'external', 'external:1', 'external:2']
);
assert.equal(
  new Set(wideColumns.flatMap((column) => column.models.map((model) => model.id))).size,
  crowdedModels.length
);
assert.deepEqual(
  Array.from(wideColumns.flatMap((column) => column.models.map((model) => model.id))),
  Array.from(responsiveColumns(500).flatMap((column) => column.models.map((model) => model.id)))
);
const wideField = { left: 0, right: 1200, top: 0, bottom: 586, columns: wideColumns };
const wideLayout = columnContext.assignModelColumnTargets(crowdedModels, wideField);
for (const [id, point] of wideLayout.targets) {
  assert(point.x - 110 >= wideField.left && point.x + 110 <= wideField.right, id);
  assert(point.y - 34 >= wideField.top && point.y + 34 <= wideField.bottom, id);
  for (const [otherId, other] of wideLayout.targets) {
    if (id !== otherId) assert(Math.abs(point.x - other.x) >= 220 || Math.abs(point.y - other.y) >= 68);
  }
}
assert.equal(columnContext.topologyModelColumns([], 1200, 586).length, 0);

// Ordinary desktop widths can borrow space from ingress, without a transient
// oversized world. Test both resize directions and catalog density changes.
const clusterFixture = [{ id: 'spark1' }, { id: 'spark2' }, { id: 'mac' }];
assert.equal(columnContext.topologyViewportColumns(crowdedModels, 1280, 800, clusterFixture).length, 4);
const layoutState = { modelNodes: new Map(), smoothedRates: new Map() };
columnContext.state = layoutState;
vm.runInNewContext(
  source.slice(source.indexOf('    function updateModelLayout('), source.indexOf('    function drawTopology(')) +
    '\nglobalThis.updateModelLayout = updateModelLayout;',
  columnContext
);
for (const [width, height, models] of [
  [1920, 900, crowdedModels],
  [1280, 800, crowdedModels],
  [800, 640, crowdedModels],
  [1440, 900, crowdedModels],
  [1440, 900, topologyModels],
  [1280, 800, crowdedModels]
]) {
  const columns = columnContext.topologyViewportColumns(models, width, height, clusterFixture);
  const scale = columnContext.topologyRequiredWorldScale(models, clusterFixture, width, height);
  const field = {
    left: width * scale - columnContext.topologyRackWidth(columns),
    right: width * scale - 18,
    top: 128,
    bottom: height * scale - 86,
    columns
  };
  columnContext.updateModelLayout(models, field);
  assert(field.left >= 500);
  for (const point of layoutState.modelNodes.values()) {
    assert((point.x - 110) / scale >= 0 && (point.x + 110) / scale <= width);
    assert((point.y - 34) / scale >= 0 && (point.y + 34) / scale <= height);
  }
  assert.equal(layoutState.modelNodes.size, models.length);
}

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
