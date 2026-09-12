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
assert(source.includes('const aggregateOutputRate = totals.activeDecodeTokensPerSecond ?? null'));
assert(!source.includes('aggregateRateSamples'));
assert(source.includes('["Rolling average (10 requests)", topologyModel.averageRate == null'));
assert(!source.includes('["Live rate", formatRate(topologyModel.liveRate'));
assert(source.includes('$("#fabric-rate-label").textContent = "avg tok/s"'));
assert(source.includes('outputRate: liveOutputRate'));
assert(!source.includes('summary.outputPending'));
assert(!source.includes('smoothRate("summary:output"'));
assert(source.includes('const clusterResults = formatRate(instantaneousOutputRate)'));
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

// The optional action view keeps the columnar rack available but lays model
// cards out with weighted force physics: the loom holds still, requests stay
// left, models stay right, and activity sets how far in a model sits.
const actionStart = source.indexOf('    const ACTION_WORLD_SCALE =');
const actionEnd = source.indexOf('    function smoothRate(', actionStart);
assert(actionStart >= 0 && actionEnd > actionStart);
const actionContext = {
  state: { actionModelNodes: new Map() },
  hashUnit: columnContext.hashUnit
};
vm.runInNewContext(
  source.slice(actionStart, actionEnd) +
    '\nglobalThis.ACTION_FRAME_WEIGHT = ACTION_FRAME_WEIGHT;' +
    '\nglobalThis.ACTION_ZOOM_MAX = ACTION_ZOOM_MAX;' +
    '\nglobalThis.modelActivityWeight = modelActivityWeight;' +
    '\nglobalThis.actionFrameModels = actionFrameModels;' +
    '\nglobalThis.actionLoomAnchor = actionLoomAnchor;' +
    '\nglobalThis.actionModelSlot = actionModelSlot;' +
    '\nglobalThis.actionCameraFrame = actionCameraFrame;' +
    '\nglobalThis.actionCameraZoom = actionCameraZoom;' +
    '\nglobalThis.updateActionModelLayout = updateActionModelLayout;',
  actionContext
);
const weightNow = Date.parse('2026-09-06T01:00:00Z');
const actionWeight = (model) => actionContext.modelActivityWeight(model, weightNow);
assert.equal(actionWeight({ state: 'serving' }), 1);
assert.equal(actionWeight({ state: 'external-processing' }), 1);
assert(actionWeight({ state: 'warming' }) >= actionContext.ACTION_FRAME_WEIGHT);
assert(
  actionWeight({ state: 'hot', lastActiveAt: new Date(weightNow - 5000).toISOString() }) >=
    actionContext.ACTION_FRAME_WEIGHT
);
assert(
  actionWeight({ state: 'hot', lastActiveAt: new Date(weightNow - 10 * 60000).toISOString() }) <
    actionContext.ACTION_FRAME_WEIGHT
);
assert(actionWeight({ state: 'cold' }) < actionContext.ACTION_FRAME_WEIGHT);
assert(
  actionWeight({ state: 'hot', lastActiveAt: new Date(weightNow - 20000).toISOString() }) >
    actionWeight({ state: 'hot', lastActiveAt: new Date(weightNow - 240000).toISOString() })
);

const actionField = { left: 0, right: 2400, top: 0, bottom: 1400 };
const actionAnchor = actionContext.actionLoomAnchor(actionField);
assert(actionAnchor.x > actionField.left && actionAnchor.x < actionField.right / 2, 'the loom stays left of centre');
assert.equal(actionAnchor.y, 700);

// Serving pulls a model in toward the loom; going quiet pushes it back out.
const actionServing = { id: 'serving-model', actionWeight: 1 };
const actionIdle = { id: 'idle-model', actionWeight: 0 };
const servingSlot = actionContext.actionModelSlot(actionServing, actionField, actionAnchor);
const idleSlot = actionContext.actionModelSlot(actionIdle, actionField, actionAnchor);
assert(servingSlot.x > actionAnchor.x, 'even serving models stay right of the loom');
assert(idleSlot.x > servingSlot.x, 'idle models sit further out than serving models');
assert(idleSlot.x <= actionField.right, 'idle models stay inside the world');
assert.equal(
  actionContext.actionModelSlot(actionServing, actionField, actionAnchor).y,
  servingSlot.y,
  'lanes are stable'
);

const actionModels = [
  { id: 'live-a', actionWeight: 1 },
  { id: 'live-b', actionWeight: 1 },
  { id: 'idle-a', actionWeight: 0 },
  { id: 'idle-b', actionWeight: 0.05 }
];
for (const model of actionModels) actionContext.state.actionModelNodes.delete(model.id);
for (let step = 0; step < 600; step += 1) actionContext.updateActionModelLayout(actionModels, actionField);
const actionNodes = actionContext.state.actionModelNodes;
for (const model of actionModels) {
  const node = actionNodes.get(model.id);
  assert(node.x > actionAnchor.x, model.id + ' stays right of the loom');
  assert(node.x >= actionField.left + 110 && node.x <= actionField.right - 110, model.id + ' stays in the world');
  assert(node.y >= actionField.top + 34 && node.y <= actionField.bottom - 34, model.id + ' stays in the world');
}
for (const live of ['live-a', 'live-b'])
  for (const idle of ['idle-a', 'idle-b'])
    assert(actionNodes.get(live).x < actionNodes.get(idle).x, live + ' should sit closer to the loom than ' + idle);
for (let left = 0; left < actionModels.length; left += 1)
  for (let right = left + 1; right < actionModels.length; right += 1) {
    const a = actionNodes.get(actionModels[left].id);
    const b = actionNodes.get(actionModels[right].id);
    assert(
      Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 68,
      'action cards separate ' + actionModels[left].id + '/' + actionModels[right].id
    );
  }

// The camera frames the loom and the live models, and leaves quiet ones out.
const actionLoomBox = {
  left: actionAnchor.x - 92,
  right: actionAnchor.x + 92,
  top: actionAnchor.y - 170,
  bottom: actionAnchor.y + 170
};
const actionBounds = actionContext.actionCameraFrame(actionModels, actionLoomBox, []);
for (const live of ['live-a', 'live-b']) {
  const node = actionNodes.get(live);
  assert(node.x >= actionBounds.centerX - actionBounds.width / 2, live + ' is inside the frame');
  assert(node.x <= actionBounds.centerX + actionBounds.width / 2, live + ' is inside the frame');
}
for (const idle of ['idle-a', 'idle-b'])
  assert(actionNodes.get(idle).x > actionBounds.centerX + actionBounds.width / 2, idle + ' is left outside the frame');
const actionThreadBounds = actionContext.actionCameraFrame(actionModels, actionLoomBox, [
  { x: 60, y: 300, labelWidth: 200 }
]);
assert(actionThreadBounds.width > actionBounds.width, 'a live request widens the frame');
assert.equal(actionBounds.centerX - actionBounds.width / 2 <= actionLoomBox.left, true, 'the loom is always in frame');
assert.equal(actionContext.actionFrameModels([{ id: 'cold', actionWeight: 0 }]).length, 0);

// A busy loom widens the live band and the camera pulls back instead of
// stacking cards on top of each other.
const crowdedActive = Array.from({ length: 12 }, (_, index) => ({ id: 'busy/' + index, actionWeight: 1 }));
for (const model of crowdedActive) actionContext.state.actionModelNodes.delete(model.id);
for (let step = 0; step < 600; step += 1) actionContext.updateActionModelLayout(crowdedActive, actionField);
for (let left = 0; left < crowdedActive.length; left += 1)
  for (let right = left + 1; right < crowdedActive.length; right += 1) {
    const a = actionContext.state.actionModelNodes.get(crowdedActive[left].id);
    const b = actionContext.state.actionModelNodes.get(crowdedActive[right].id);
    assert(
      Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 68,
      'busy loom separates ' + crowdedActive[left].id + '/' + crowdedActive[right].id
    );
  }
const crowdedBounds = actionContext.actionCameraFrame(crowdedActive, actionLoomBox, []);
assert(crowdedBounds.height > actionBounds.height, 'more live models pull the camera back');

const tightZoom = actionContext.actionCameraZoom({ width: 400, height: 300 }, 1920, 1080);
const wideZoom = actionContext.actionCameraZoom({ width: 4200, height: 3200 }, 1920, 1080);
assert(tightZoom > wideZoom);
assert(tightZoom <= actionContext.ACTION_ZOOM_MAX);
assert.equal(actionContext.actionCameraZoom({ width: 1, height: 1 }, 1920, 1080), actionContext.ACTION_ZOOM_MAX);
assert(
  source.includes('const actionWeight = modelActivityWeight({ state: stateLabel, liveRate, lastActiveAt }, sampleAt)')
);
assert(source.includes('state: stateLabel, actionWeight, lastActiveAt, agedOut'));

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

// Labels collide with the central column using their measured width, even
// when old coordinates or a resize would place them inside the node cards.
const threadContext = { state: { threadNodes: new Map(), smoothedRates: new Map() }, hashUnit: columnContext.hashUnit };
vm.runInNewContext(
  source.slice(source.indexOf('    function updateThreadLayout('), source.indexOf('    function updateModelLayout(')) +
    '\nglobalThis.updateThreadLayout = updateThreadLayout;',
  threadContext
);
const threads = [
  { id: 'conn_1', labelWidth: 210 },
  { id: 'conn_2', labelWidth: 120 }
];
threadContext.state.threadNodes.set('conn_1', { x: 800, y: 200, vx: 100, vy: 0 });
for (const right of [400, 270, 500]) {
  for (let frame = 0; frame < 50; frame++) {
    threadContext.updateThreadLayout(threads, { left: 24, right, top: 100, bottom: 700 });
    for (const thread of threads) {
      const node = threadContext.state.threadNodes.get(thread.id);
      assert(node.x >= 24);
      assert(node.x + 10 + thread.labelWidth <= right);
    }
  }
}

// A buffered request never masks the selected period's average, including
// after switching ranges while an old browser sample exists.
const hudElements = new Map();
const hudContext = {
  state: { metrics: {}, trafficSample: null },
  $: (selector) => {
    if (!hudElements.has(selector)) hudElements.set(selector, {});
    return hudElements.get(selector);
  },
  performance: { now: () => 1000 },
  formatCompact: String,
  formatNumber: String,
  formatRate: String
};
vm.runInNewContext(
  source.slice(source.indexOf('    function renderActivity()'), source.indexOf('      const recentById = new Map();')) +
    '\n}\nglobalThis.renderActivity = renderActivity;',
  hudContext
);
for (const [period, rate] of [
  ['all', 28],
  ['today', 50],
  ['7d', null]
]) {
  hudContext.state.metrics = {
    period,
    totals: { activeDecodeTokensPerSecond: rate },
    active: [{ id: 'buffered', stream: false, responseBytes: 0 }]
  };
  hudContext.renderActivity();
  assert.equal(hudElements.get('#fabric-rate').textContent, rate == null ? '—' : String(rate));
  assert.equal(hudElements.get('#fabric-rate-label').textContent, 'avg tok/s');
}

// Concurrent streaming output is summed even while another request is buffered.
const sampleAt = Date.parse('2026-09-06T01:00:00Z');
hudContext.state.trafficSample = {
  at: sampleAt - 2000,
  active: new Map([
    ['a', { outputChars: 400 }],
    ['b', { outputChars: 800 }]
  ])
};
hudContext.state.metrics = {
  generatedAt: new Date(sampleAt).toISOString(),
  period: 'all',
  totals: { activeDecodeTokensPerSecond: 999 },
  active: [
    { id: 'a', stream: true, outputChars: 800 },
    { id: 'b', stream: true, outputChars: 1600 },
    { id: 'buffered', stream: false, responseBytes: 0 }
  ]
};
hudContext.renderActivity();
assert.equal(hudContext.state.topologySummary.outputRate, 150);
hudContext.state.metrics.generatedAt = new Date(sampleAt + 2000).toISOString();
hudContext.renderActivity();
assert.equal(hudContext.state.topologySummary.outputRate, 0);
hudContext.state.metrics.active = [];
hudContext.renderActivity();
assert.equal(hudContext.state.topologySummary.outputRate, 0);
assert.equal(hudElements.get('#fabric-rate').textContent, '999');

// Sliced-function tests cannot catch a ReferenceError inside the render loop,
// which silently stops animation and leaves the canvas blank in every view.
// Execute the whole dashboard script against fixture payloads and draw frames.
assert(source.includes('function drawTopology(now, reducedMotion = false)'));

const renderCanvasContext = new Proxy(
  {},
  {
    get(target, property) {
      if (property === 'measureText') return () => ({ width: 42 });
      if (property === 'createLinearGradient') return () => ({ addColorStop() {} });
      return target[property] ?? (() => {});
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }
);
const renderElement = (selector) => ({
  selector,
  textContent: '',
  innerHTML: '',
  title: '',
  value: '',
  hidden: false,
  disabled: false,
  style: {},
  dataset: {},
  isConnected: true,
  clientWidth: 1451,
  clientHeight: 976,
  width: 1451,
  height: 976,
  classList: {
    values: new Set(),
    add(...names) {
      names.forEach((name) => this.values.add(name));
    },
    remove(...names) {
      names.forEach((name) => this.values.delete(name));
    },
    toggle(name, on) {
      if (on === undefined) this.values.has(name) ? this.values.delete(name) : this.values.add(name);
      else if (on) this.values.add(name);
      else this.values.delete(name);
    },
    contains(name) {
      return this.values.has(name);
    }
  },
  setAttribute() {},
  getAttribute() {
    return null;
  },
  addEventListener() {},
  focus() {},
  blur() {},
  querySelector: () => renderElement(selector + ' child'),
  querySelectorAll: () => [],
  closest: () => null,
  contains: () => false,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1451, height: 976 }),
  getContext: () => renderCanvasContext
});
const renderElements = new Map();
const renderDocument = {
  hidden: false,
  activeElement: null,
  querySelector(selector) {
    if (!renderElements.has(selector)) renderElements.set(selector, renderElement(selector));
    return renderElements.get(selector);
  },
  addEventListener() {}
};
const renderFixtureAt = '2026-09-12T06:00:00Z';
const renderPayloads = {
  '/gateway/security': { authRequired: false, adminAuthRequired: false },
  '/health': { ok: true, name: 'lloom' },
  '/gateway/models': {
    models: [
      { id: 'local/active', name: 'Active local', runtime: 'vllm-a', kind: 'chat', contextWindow: 8192 },
      { id: 'local/idle', name: 'Idle local', runtime: 'vllm-b', kind: 'chat', contextWindow: 8192 },
      { id: 'cloud/idle', name: 'External idle', kind: 'chat', contextWindow: 8192 }
    ]
  },
  '/gateway/status': {
    defaults: { chatModel: 'local/active' },
    runtimeManager: {
      runtimes: {
        'vllm-a': {
          status: 'running',
          healthy: true,
          activeRequests: 1,
          maxConcurrency: 2,
          port: 8201,
          members: [{ node: 'spark1' }]
        },
        'vllm-b': {
          status: 'stopped',
          healthy: false,
          activeRequests: 0,
          maxConcurrency: 1,
          port: 8202,
          members: [{ node: 'spark2' }]
        }
      }
    },
    cluster: {
      enabled: true,
      id: 'lab',
      leaderNode: 'spark1',
      nodes: {
        spark1: {
          id: 'spark1',
          name: 'spark1',
          reachable: true,
          local: true,
          labels: { role: 'leader' },
          profile: { accelerators: ['cuda', 'gb10'] },
          telemetry: { cpu: { utilization: 20 }, memory: { pressureUtilization: 40 }, gpu: { utilization: 50 } }
        },
        spark2: {
          id: 'spark2',
          name: 'spark2',
          reachable: true,
          labels: { role: 'worker' },
          profile: { accelerators: ['cuda'] },
          telemetry: { cpu: { utilization: 10 }, memory: { pressureUtilization: 30 }, gpu: { utilization: 5 } }
        }
      }
    }
  },
  '/gateway/library': {},
  '/gateway/backends': { backends: [] },
  '/gateway/metrics': {
    generatedAt: renderFixtureAt,
    period: 'all',
    totals: { inputTokens: 1000, outputTokens: 2000, activeDecodeTokensPerSecond: 10 },
    rolling: { minute: { errors: 0 } },
    models: [
      {
        id: 'local/active',
        inputTokens: 900,
        outputTokens: 1900,
        decodeTokensPerSecond: 12,
        last: { at: renderFixtureAt }
      },
      { id: 'local/idle', inputTokens: 50, outputTokens: 60, last: { at: '2026-09-12T05:00:00Z' } },
      { id: 'cloud/idle', inputTokens: 50, outputTokens: 40, last: { at: '2026-09-12T05:00:00Z' } }
    ],
    active: [
      {
        id: 'conn_1',
        model: 'local/active',
        resolvedModel: 'local/active',
        caller: 'Runtime',
        stream: true,
        outputChars: 400,
        requestBytes: 400,
        durationMs: 5000,
        node: 'spark1'
      }
    ],
    recent: []
  }
};
const renderSandbox = {
  document: renderDocument,
  window: { matchMedia: () => ({ matches: false }), confirm: () => false, addEventListener() {} },
  location: { origin: 'http://127.0.0.1:8123' },
  navigator: { clipboard: { writeText: async () => {} } },
  performance: { now: () => 1000 },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async (path) => {
    const body = renderPayloads[String(path).split('?')[0]];
    assert(body !== undefined, 'dashboard fetched an unexpected endpoint: ' + path);
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  },
  setTimeout: () => 0,
  setInterval: () => 0,
  clearTimeout() {},
  clearInterval() {},
  console
};
vm.runInNewContext(
  source.match(/<script>([\s\S]*?)<\/script>/)[1] +
    '\nglobalThis.__render = { state, refresh, refreshActivity, drawTopology };',
  renderSandbox,
  { filename: 'dashboard-render.js' }
);
await renderSandbox.__render.refresh();
await renderSandbox.__render.refreshActivity();
const renderState = renderSandbox.__render.state;
assert.equal(renderState.topologyCatalogModels.length, 3);
assert.equal(renderState.topologyModels.length, 3);
assert.equal(renderState.topologyModels.find((model) => model.id === 'local/active').actionWeight, 1);

renderSandbox.__render.drawTopology(1000, false);
assert.equal(renderState.topologyHitCards.length, 3, 'columnar view draws every model card');
assert.equal(renderState.topologyHitNodeCards.length, 2, 'columnar view draws every cluster node card');

renderState.topologyViewMode = 'action';
renderState.topologySceneKey = '';
for (let frame = 0; frame < 150; frame += 1) renderSandbox.__render.drawTopology(1000 + frame * 50, false);
assert.equal(renderState.topologyHitCards.length, 3, 'action view draws every model card');
const renderActive = renderState.actionModelNodes.get('local/active');
const renderIdle = renderState.actionModelNodes.get('local/idle');
const renderExternal = renderState.actionModelNodes.get('cloud/idle');
assert(renderActive.x < renderIdle.x, 'the serving model sits closer to the loom than a quiet local model');
assert(renderActive.x < renderExternal.x, 'the serving model sits closer to the loom than a quiet external model');
// Project into screen space: the camera must hold the live model and drop the
// quiet ones outside the viewport entirely.
const renderScreen = (point) => ({
  x:
    (point.x - renderState.topologyView.width / 2) * renderState.topologyView.zoom +
    renderState.topologyView.viewportWidth / 2 +
    renderState.topologyView.panX,
  y:
    (point.y - renderState.topologyView.height / 2) * renderState.topologyView.zoom +
    renderState.topologyView.viewportHeight / 2 +
    renderState.topologyView.panY
});
const renderVisible = (point) => {
  const screen = renderScreen(point);
  return (
    screen.x >= 0 &&
    screen.x <= renderState.topologyView.viewportWidth &&
    screen.y >= 0 &&
    screen.y <= renderState.topologyView.viewportHeight
  );
};
assert(renderVisible(renderActive), 'serving model is inside the camera frame');
assert(!renderVisible(renderIdle), 'quiet local model is outside the camera frame');
assert(!renderVisible(renderExternal), 'quiet external model is outside the camera frame');
assert.equal(renderState.topologyCamera.autoFollow, true);
// Reduced motion settles the layout in one pass instead of easing it.
renderSandbox.__render.drawTopology(0, true);
assert(renderState.topologyCamera.autoFollow, 'reduced motion keeps following');
