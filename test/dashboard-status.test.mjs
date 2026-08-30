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
    'transitioning || (runtimeLoaded ? liveConnections.length ? "serving" : "hot" : runtimeStatus === "failed" ? "failed" : "cold")'
  )
);
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
