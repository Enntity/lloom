const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLooM</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101215;
      --band: #16191e;
      --panel: #1c2027;
      --line: #333945;
      --text: #f2f5f7;
      --muted: #99a3b0;
      --accent: #2fe6c8;
      --accent-2: #8fb4ff;
      --warn: #f3bd4f;
      --bad: #ff6f7d;
      --ok: #42d77d;
      --shadow: 0 18px 60px rgba(0, 0, 0, .28);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(180deg, rgba(47, 230, 200, .05), transparent 260px),
        var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 22px 28px;
      border-bottom: 1px solid var(--line);
      background: rgba(16, 18, 21, .9);
      position: sticky;
      top: 0;
      z-index: 5;
      backdrop-filter: blur(18px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .mark {
      width: 28px;
      height: 28px;
      border: 1px solid rgba(47, 230, 200, .7);
      display: grid;
      place-items: center;
      color: var(--accent);
      font-weight: 800;
      box-shadow: 0 0 22px rgba(47, 230, 200, .18);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
      white-space: nowrap;
    }
    main {
      width: min(1480px, 100%);
      margin: 0 auto;
      padding: 28px;
      display: grid;
      gap: 22px;
    }
    .topline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    button, input, select {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: #222832;
      color: var(--text);
      padding: 8px 11px;
      min-height: 36px;
      cursor: pointer;
      border-radius: 6px;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: #0b6b60;
      border-color: #139383;
    }
    button.danger:hover { border-color: var(--bad); }
    input, select {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      background: #11151b;
      color: var(--text);
      padding: 8px 10px;
      border-radius: 6px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .02em;
      text-transform: uppercase;
    }
    .grid {
      display: grid;
      gap: 22px;
    }
    .grid.two {
      grid-template-columns: minmax(0, 1fr) minmax(360px, .72fr);
    }
    .band {
      background: var(--band);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .band h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }
    .band-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }
    .band-body {
      padding: 16px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      padding: 14px;
      min-height: 82px;
    }
    .stat strong {
      display: block;
      font-size: 21px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .stat span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .02em;
    }
    .live-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; }
    .metric-value { font-size:26px; font-weight:800; letter-spacing:-.04em; }
    .metric-sub { color:var(--muted); font-size:12px; margin-top:4px; }
    .chart { width:100%; height:150px; display:block; overflow:visible; }
    .chart-line { fill:none; stroke:var(--accent); stroke-width:2.5; vector-effect:non-scaling-stroke; }
    .chart-area { fill:url(#activity-gradient); opacity:.45; }
    .connection-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:12px; }
    .connection { background:var(--panel); border:1px solid var(--line); padding:14px; min-width:0; }
    .connection.live { border-color:rgba(47,230,200,.65); box-shadow:inset 3px 0 var(--accent); }
    .connection-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
    .connection-model { font-weight:750; overflow-wrap:anywhere; }
    .connection-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:14px; }
    .connection-stats strong { display:block; font-size:17px; }
    .connection-stats span { color:var(--muted); font-size:10px; text-transform:uppercase; }
    .fabric-card { position:relative; overflow:hidden; background:#080c0d; border:1px solid rgba(47,230,200,.38); min-height:270px; box-shadow:inset 0 0 70px rgba(47,230,200,.045),0 0 28px rgba(47,230,200,.07); }
    .fabric-card::before { content:""; position:absolute; inset:0; pointer-events:none; background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(47,230,200,.025) 4px); }
    .fabric-head { position:relative; z-index:2; display:flex; justify-content:space-between; gap:18px; align-items:flex-start; padding:16px 18px 0; }
    .fabric-title { font:800 16px "SFMono-Regular",monospace; letter-spacing:.16em; color:var(--accent); text-shadow:0 0 14px rgba(47,230,200,.55); }
    .fabric-totals { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px 20px; }
    .fabric-total { text-align:right; }
    .fabric-total strong { display:block; font:800 19px "SFMono-Regular",monospace; color:var(--text); }
    .fabric-total span { color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
    .token-canvas { display:block; width:100%; height:205px; }
    .connection-grid { grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); }
    .connection { position:relative; overflow:hidden; padding:0; background:#080c0d; }
    .connection .connection-head,.connection .connection-stats { position:relative; z-index:2; }
    .connection .connection-head { padding:13px 14px 0; }
    .connection .connection-stats { margin:0; padding:0 14px 12px; }
    .connection .token-canvas { height:125px; }
    .connection-id { color:var(--accent-2); font:700 11px "SFMono-Regular",monospace; letter-spacing:.04em; }
    .topology { position:relative; min-height:560px; overflow:hidden; background:#070b0c; border:1px solid rgba(47,230,200,.38); box-shadow:inset 0 0 90px rgba(47,230,200,.04); }
    .topology::before { content:""; position:absolute; inset:0; pointer-events:none; background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(47,230,200,.022) 4px); }
    .topology-head { position:absolute; z-index:2; left:16px; right:16px; top:14px; display:flex; justify-content:space-between; align-items:flex-start; gap:18px; pointer-events:none; }
    .topology-canvas { display:block; width:100%; height:560px; cursor:grab; touch-action:none; }
    .topology-canvas.is-panning { cursor:grabbing; }
    .topology-zoom { position:absolute; z-index:3; right:14px; bottom:14px; display:flex; align-items:center; gap:5px; padding:5px; border:1px solid rgba(47,230,200,.28); background:rgba(7,11,12,.88); backdrop-filter:blur(8px); }
    .topology-zoom button { min-width:30px; min-height:28px; padding:2px 8px; font:700 14px "SFMono-Regular",monospace; }
    .topology-zoom-output { min-width:48px; color:var(--muted); text-align:center; font:700 10px "SFMono-Regular",monospace; }
    .pulse { animation:pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity:.35; transform:scale(.78); } }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      background: #11151b;
      min-height: 28px;
      padding: 4px 8px;
      color: var(--muted);
      border-radius: 999px;
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
      flex: 0 0 auto;
    }
    .dot.ok { background: var(--ok); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--bad); }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .02em;
      font-weight: 700;
      background: #141820;
      position: sticky;
      top: 0;
    }
    td {
      color: #dce3ea;
    }
    td code, pre, .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    code {
      color: #d9e4ff;
      overflow-wrap: anywhere;
    }
    .muted { color: var(--muted); }
    .accent { color: var(--accent); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .ok { color: var(--ok); }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .form-grid .wide { grid-column: 1 / -1; }
    .check-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 10px;
      color: var(--muted);
    }
    .check-row label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      text-transform: none;
      letter-spacing: 0;
      font-size: 13px;
    }
    .check-row input {
      width: auto;
      min-height: 0;
    }
    pre {
      margin: 0;
      min-height: 180px;
      max-height: 460px;
      overflow: auto;
      background: #0d1015;
      border: 1px solid var(--line);
      padding: 14px;
      color: #dce3ea;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 22px;
    }
    .empty {
      padding: 16px;
      color: var(--muted);
      border: 1px dashed var(--line);
      background: rgba(255,255,255,.02);
    }
    @media (max-width: 1040px) {
      header { align-items: flex-start; flex-direction: column; }
      .topline { justify-content: flex-start; }
      .grid.two, .split, .stats, .live-grid { grid-template-columns: 1fr; }
      main { padding: 18px; }
    }
    @media (max-width: 640px) {
      header { padding: 16px; }
      main { padding: 12px; }
      .form-grid { grid-template-columns: 1fr; }
      .band-head { align-items: flex-start; flex-direction: column; }
      .fabric-head { flex-direction:column; }
      .fabric-totals { justify-content:flex-start; }
      .topology { min-height:470px; }
      .topology-canvas { height:470px; }
      .topology-head { position:relative; padding-bottom:8px; flex-direction:column; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="mark">L</div>
      <h1>LLooM</h1>
      <span id="health" class="pill"><span class="dot"></span><span>checking</span></span>
    </div>
    <div class="topline">
      <span id="endpoint" class="pill"></span>
      <label style="display:flex;align-items:center;gap:8px;text-transform:none;margin:0;color:var(--muted);font-size:12px;">
        API key
        <input id="api-key" type="password" placeholder="optional" autocomplete="off"
          style="width:160px;min-height:32px;margin:0;" />
      </label>
      <button id="refresh" class="primary" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <section class="stats" aria-label="Gateway summary">
      <div class="stat"><span>Models</span><strong id="stat-models">-</strong></div>
      <div class="stat"><span>Runtimes</span><strong id="stat-runtimes">-</strong></div>
      <div class="stat"><span>Active</span><strong id="stat-active">-</strong></div>
      <div class="stat"><span>Queued</span><strong id="stat-queued">-</strong></div>
    </section>

    <section class="band" aria-label="Live activity">
      <div class="band-head">
        <div><h2>Live Activity</h2><div class="muted">Streaming gateway telemetry · updates every second</div></div>
        <span id="activity-state" class="pill"><span class="dot pulse"></span><span>connecting</span></span>
      </div>
      <div class="band-body grid">
        <article class="topology" aria-label="Live LLooM connection and model topology">
          <div class="topology-head"><div><div class="fabric-title">LLooM // LIVE TOPOLOGY</div><div class="muted mono">connections → gateway → models</div></div>
            <div class="fabric-totals"><div class="fabric-total"><strong id="fabric-in">0</strong><span>tokens in</span></div><div class="fabric-total"><strong id="fabric-out">0</strong><span>tokens out</span></div><div class="fabric-total"><strong id="fabric-rate">—</strong><span id="fabric-rate-label">tok/s</span></div><div class="fabric-total"><strong id="fabric-active">0</strong><span>active</span></div></div>
          </div>
          <canvas id="topology-canvas" class="topology-canvas" aria-label="Animated connections flowing through LLooM to configured models"></canvas>
          <div class="topology-zoom" aria-label="Topology zoom and pan controls"><button id="topology-zoom-out" type="button" aria-label="Zoom out">−</button><span id="topology-zoom-output" class="topology-zoom-output">100%</span><button id="topology-zoom-in" type="button" aria-label="Zoom in">+</button><button id="topology-zoom-reset" type="button" aria-label="Reset view">↺</button></div>
        </article>
      </div>
    </section>

    <section class="grid two">
      <div class="band">
        <div class="band-head">
          <h2>Runtimes</h2>
          <div class="actions">
            <button id="warm-all" type="button">Warm</button>
          </div>
        </div>
        <div class="band-body table-wrap">
          <table>
            <thead>
              <tr><th>Runtime</th><th>Status</th><th>Concurrency</th><th>Port</th><th></th></tr>
            </thead>
            <tbody id="runtime-rows"></tbody>
          </table>
        </div>
      </div>

      <div class="band">
        <div class="band-head">
          <h2>Library Pick</h2>
          <span id="library-state" class="pill"><span class="dot"></span><span>loading</span></span>
        </div>
        <div class="band-body">
          <div id="library-pick" class="grid"></div>
        </div>
      </div>
    </section>

    <section class="band">
      <div class="band-head">
        <h2>Models</h2>
        <span id="default-model" class="pill"></span>
      </div>
      <div class="band-body table-wrap">
        <table>
          <thead>
            <tr><th>Model</th><th>Kind</th><th>Context</th><th>Runtime</th><th>Capabilities</th></tr>
          </thead>
          <tbody id="model-rows"></tbody>
        </table>
      </div>
    </section>

    <section class="band">
      <div class="band-head">
        <h2>Backends</h2>
        <span id="backend-state" class="pill"><span class="dot"></span><span>loading</span></span>
      </div>
      <div class="band-body table-wrap">
        <table>
          <thead>
            <tr><th>Backend</th><th>Status</th><th>Commands</th><th>Features</th><th></th></tr>
          </thead>
          <tbody id="backend-rows"></tbody>
        </table>
      </div>
    </section>

    <section class="split">
      <div class="band">
        <div class="band-head"><h2>Onboarding</h2></div>
        <div class="band-body">
          <form id="setup-form" class="form-grid">
            <label>Gateway port<input name="port" inputmode="numeric" placeholder="8100"></label>
            <label>Backend range<input name="backend_port_range" placeholder="8201-8299"></label>
            <label class="wide">Model root<input name="model_root" placeholder="~/.lloom/models"></label>
            <label>Recipe<input name="recipe" placeholder="apple-silicon-qwen36"></label>
            <label>Client<select name="client"><option value="all">all</option><option value="omp">omp</option><option value="opencode">opencode</option><option value="codex">codex</option><option value="claude">claude</option><option value="hermes">hermes</option><option value="zero">zero</option></select></label>
            <div class="wide check-row">
              <label><input type="checkbox" name="start"> start keep-warm</label>
            </div>
            <div class="wide actions">
              <button id="onboard-plan" class="primary" type="button">Onboard</button>
              <button type="submit">Setup Plan</button>
              <button data-apply="onboard" type="button">Apply</button>
            </div>
          </form>
        </div>
      </div>
      <div class="band">
        <div class="band-head"><h2>Add Model</h2></div>
        <div class="band-body">
          <form id="model-form" class="form-grid">
            <label class="wide">Model reference<input name="modelRef" placeholder="hf.co/org/model, qwen3:8b, lmstudio:id, or openai:url#model"></label>
            <label>Backend<input name="backend" placeholder="auto"></label>
            <label>Port<input name="port" inputmode="numeric" placeholder="auto"></label>
            <label>Context<input name="contextWindow" inputmode="numeric" placeholder="32768"></label>
            <label>Model root<input name="modelRoot" placeholder="~/.lloom/models"></label>
            <label>Display name<input name="name" placeholder="optional"></label>
            <label>API key env<input name="apiKeyEnv" placeholder="OPENROUTER_API_KEY"></label>
            <div class="wide check-row">
              <label><input type="checkbox" name="keepWarm"> keep warm</label>
              <label><input type="checkbox" name="setDefault"> default</label>
            </div>
            <div class="wide actions">
              <button class="primary" type="submit">Plan</button>
              <button data-apply="model" type="button">Apply</button>
            </div>
          </form>
        </div>
      </div>
    </section>

    <section class="band">
      <div class="band-head"><h2>Community Feed</h2></div>
      <div class="band-body">
        <form id="community-form" class="form-grid">
          <label class="wide">Host URL<input name="host" placeholder="https://community.example"></label>
          <label>Feed path<input name="recipe_feed_path" placeholder="/v1/recipe-packs/recommended"></label>
          <label>Limit<input name="limit" inputmode="numeric" placeholder="1"></label>
          <div class="wide check-row">
            <label><input type="checkbox" name="require_signature" checked> require signature</label>
          </div>
          <div class="wide actions">
            <button class="primary" type="submit">Plan</button>
            <button data-apply="community" type="button">Import</button>
          </div>
        </form>
      </div>
    </section>

    <section class="band">
      <div class="band-head"><h2>Recipe Pack</h2></div>
      <div class="band-body">
        <form id="pack-form" class="form-grid">
          <label class="wide">Pack source<input name="source" placeholder="https://community.example/v1/recipe-packs/apple-silicon.json or ./pack.json"></label>
          <label>Index path<input name="indexPath" placeholder="recipes/index.json"></label>
          <label>Recipes root<input name="recipesRoot" placeholder="recipes"></label>
          <label>Benchmarks root<input name="benchmarksRoot" placeholder="benchmarks/community"></label>
          <div class="wide check-row">
            <label><input type="checkbox" name="requireSignature"> require signature</label>
          </div>
          <div class="wide actions">
            <button class="primary" type="submit">Plan</button>
            <button data-apply="pack" type="button">Import</button>
          </div>
        </form>
      </div>
    </section>

    <section class="band">
      <div class="band-head">
        <h2>Plan Output</h2>
        <button id="copy-output" type="button">Copy</button>
      </div>
      <div class="band-body">
        <pre id="output">Waiting for data.</pre>
      </div>
    </section>
  </main>
  <script>
    const state = {
      models: [],
      backends: [],
      status: null,
      library: null,
      security: null,
      metrics: null,
      throughput: [],
      flows: new Map(),
      trafficSample: null,
      aggregateRateSamples: [],
      smoothedRates: new Map(),
      connectionKey: "",
      threadNodes: new Map(),
      modelNodes: new Map(),
      modelLayoutKey: "",
      modelLayoutStableFrames: 0,
      modelLayoutSettled: false,
      topologyWorldScale: 1,
      topologyCamera: { manual: 1, current: 1, panX: 0, panY: 0 },
      topologyPanDrag: null,
      topologyRaisedModelId: null,
      topologyView: null,
      topologyHitCards: [],
      output: null,
    };

    // Higher values draw later (on top). Serving stays above idle hot/external cards
    // so overlaps favor live traffic; click temporarily overrides via topologyRaisedModelId.
    const MODEL_CARD_STATE_Z = { cold: 0, warming: 1, evicting: 1, hot: 2, external: 2, serving: 3 };
    function modelCardZ(model) {
      if (state.topologyRaisedModelId && model.id === state.topologyRaisedModelId) return 1000;
      return MODEL_CARD_STATE_Z[model.state] ?? 0;
    }

    const $ = selector => document.querySelector(selector);
    const endpoint = location.origin;
    $("#endpoint").textContent = endpoint;

    function readApiKeyInput() {
      const input = $("#api-key");
      return input && input.value ? input.value.trim() : "";
    }

    function headers() {
      const fromInput = readApiKeyInput();
      if (fromInput) {
        sessionStorage.setItem("lloom_api_key", fromInput);
        return { authorization: "Bearer " + fromInput };
      }
      const token = localStorage.getItem("lloom_api_key") || sessionStorage.getItem("lloom_api_key");
      return token ? { authorization: "Bearer " + token } : {};
    }

    function ensureAdminKeyIfNeeded() {
      if (!state.security?.adminAuthRequired && !state.security?.authRequired) return true;
      if (headers().authorization) return true;
      const input = $("#api-key");
      if (input) {
        input.focus();
        showOutput({
          error: "API key required for admin actions on this host. Enter it in the header field, then retry."
        });
      }
      return false;
    }

    {
      const saved = sessionStorage.getItem("lloom_api_key") || localStorage.getItem("lloom_api_key");
      if (saved && $("#api-key")) $("#api-key").value = saved;
    }

    async function getJson(path) {
      const response = await fetch(path, { headers: headers() });
      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!response.ok) throw new Error(json.error?.message || response.statusText);
      return json;
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!response.ok) throw new Error(json.error?.message || response.statusText);
      return json;
    }

    function setHealth(ok, label) {
      const root = $("#health");
      root.querySelector(".dot").className = "dot " + (ok ? "ok" : "bad");
      root.querySelector("span:last-child").textContent = label;
    }

    function runtimeClass(runtime) {
      if (runtime.healthy || runtime.status === "running" || runtime.status === "external") return "ok";
      if (runtime.status === "starting") return "warn";
      if (runtime.status === "failed") return "bad";
      return "";
    }

    function tags(values) {
      return (values || []).slice(0, 6)
        .map(value => '<span class="pill">' + escapeHtml(value) + '</span>')
        .join(" ");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }

    function renderModels() {
      const rows = $("#model-rows");
      const models = state.models || [];
      $("#stat-models").textContent = String(models.length);
      $("#default-model").textContent = state.status?.defaults?.chatModel || "no default";
      rows.innerHTML = models.length ? models.map(model =>
        '<tr>' +
          '<td><code>' + escapeHtml(model.id) + '</code><div class="muted">' + escapeHtml(model.name || "") + '</div></td>' +
          '<td>' + escapeHtml(model.kind || "chat") + '</td>' +
          '<td>' + escapeHtml(model.contextWindow || "-") + '</td>' +
          '<td><code>' + escapeHtml(model.runtime || "-") + '</code></td>' +
          '<td>' + tags(model.capabilities || model.tags) + '</td>' +
        '</tr>'
      ).join("") : '<tr><td colspan="5"><div class="empty">No models.</div></td></tr>';
    }

    function renderRuntimes() {
      const runtimes = state.status?.runtimeManager?.runtimes || {};
      const entries = Object.entries(runtimes);
      $("#stat-runtimes").textContent = String(entries.length);
      $("#stat-active").textContent = String(entries.reduce((sum, [, runtime]) => sum + Number(runtime.activeRequests || 0), 0));
      $("#stat-queued").textContent = String(entries.reduce((sum, [, runtime]) => sum + Number(runtime.queuedRequests || 0), 0));
      $("#runtime-rows").innerHTML = entries.length ? entries.map(([id, runtime]) =>
        '<tr>' +
          '<td><code>' + escapeHtml(id) + '</code><div class="muted">' + escapeHtml(runtime.command || "") + '</div></td>' +
          '<td><span class="pill"><span class="dot ' + runtimeClass(runtime) + '"></span><span>' + escapeHtml(runtime.status || "idle") + '</span></span></td>' +
          '<td>' + escapeHtml(runtime.activeRequests || 0) + ' / ' + escapeHtml(runtime.maxConcurrency || 1) +
            '<div class="muted">queue ' + escapeHtml(runtime.queuedRequests || 0) + '</div></td>' +
          '<td>' + escapeHtml(runtime.port || "-") + '</td>' +
          '<td><div class="actions">' +
            '<button data-action="start" data-runtime="' + escapeHtml(id) + '" type="button">Start</button>' +
            '<button data-action="warmup" data-runtime="' + escapeHtml(id) + '" type="button">Warm</button>' +
            '<button data-action="stop" data-runtime="' + escapeHtml(id) + '" class="danger" type="button">Stop</button>' +
          '</div></td>' +
        '</tr>'
      ).join("") : '<tr><td colspan="5"><div class="empty">No runtimes.</div></td></tr>';
    }

    function renderBackends() {
      const rows = $("#backend-rows");
      const marker = $("#backend-state");
      const backends = state.backends || [];
      const runnable = backends.filter(backend => backend.runnable).length;
      marker.querySelector(".dot").className = "dot " + (runnable ? "ok" : "warn");
      marker.querySelector("span:last-child").textContent = runnable + " ready / " + backends.length;
      rows.innerHTML = backends.length ? backends.map(backend => {
        const statusClass = backend.runnable ? "ok" : backend.platformSupported ? "warn" : "bad";
        const label = backend.runnable ? "ready" : backend.platformSupported ? "setup" : "unsupported";
        const commands = (backend.commands || []).map(command =>
          escapeHtml(command.command) + (command.available === true ? " ok" : command.available === false ? " missing" : "")
        ).join("<br>");
        return '<tr>' +
          '<td><code>' + escapeHtml(backend.id) + '</code><div class="muted">' + escapeHtml(backend.name || "") + '</div></td>' +
          '<td><span class="pill"><span class="dot ' + statusClass + '"></span><span>' + label + '</span></span></td>' +
          '<td class="mono">' + (commands || "-") + '</td>' +
          '<td>' + tags(backend.features) + '</td>' +
          '<td><div class="actions">' +
            '<button data-backend-action="plan" data-backend="' + escapeHtml(backend.id) + '" type="button">Plan</button>' +
            '<button data-backend-action="install" data-backend="' + escapeHtml(backend.id) + '" type="button">Install</button>' +
          '</div></td>' +
        '</tr>';
      }).join("") : '<tr><td colspan="5"><div class="empty">No backends.</div></td></tr>';
    }

    function renderLibrary() {
      const root = $("#library-pick");
      const marker = $("#library-state");
      const selected = state.library?.selected;
      marker.querySelector(".dot").className = "dot " + (selected ? "ok" : "warn");
      marker.querySelector("span:last-child").textContent = selected ? "selected" : "none";
      if (!selected) {
        root.innerHTML = '<div class="empty">No compatible recipe.</div>';
        return;
      }
      const recipe = (state.library.recipes || []).find(candidate => candidate.id === selected.recipeId);
      const models = (recipe?.models || []).map(model =>
        '<tr><td>' + escapeHtml(model.role) + '</td><td><code>' +
        escapeHtml(model.gatewayModel || model.model) + '</code></td><td>' +
        escapeHtml(model.benchmark?.best?.metrics?.generationTokPerSec || "-") + '</td></tr>'
      ).join("");
      root.innerHTML =
        '<div>' +
          '<div class="muted">Recipe</div>' +
          '<div><strong>' + escapeHtml(selected.name || selected.recipeId) + '</strong></div>' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table>' +
            '<thead><tr><th>Role</th><th>Model</th><th>Tok/s</th></tr></thead>' +
            '<tbody>' + (models || '<tr><td colspan="3">-</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
        '<pre>' + escapeHtml(recipe?.commands?.installApply || selected.reason || "") + '</pre>';
    }

    function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
    function formatRate(value) { return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
    function formatCompact(value) {
      const number = Number(value || 0);
      if (Math.abs(number) < 1000) return String(Math.trunc(number));
      const unit = [[1e9, "B"], [1e6, "M"], [1e3, "K"]].find(([size]) => Math.abs(number) >= size);
      const scaled = number / unit[0];
      return (scaled >= 100 ? Math.trunc(scaled) : Math.trunc(scaled * 10) / 10) + unit[1];
    }
    function fitCanvasText(ctx, value, maxWidth) {
      const text = String(value || "");
      if (ctx.measureText(text).width <= maxWidth) return text;
      const suffix = "…";
      let low = 0, high = text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (ctx.measureText(text.slice(0, middle) + suffix).width <= maxWidth) low = middle;
        else high = middle - 1;
      }
      return text.slice(0, low) + suffix;
    }
    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " KB";
      return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB";
    }
    function shortModel(value) { const parts = String(value || "unknown").split("/"); return parts[parts.length - 1]; }
    function modelVendor(value) { const parts = String(value || "local").split("/"); return parts.length > 1 ? parts[0] : "local"; }

    function smoothRate(key, target, now) {
      const desired = Math.max(0, Number(target || 0));
      let sample = state.smoothedRates.get(key);
      if (!sample) {
        sample = { value: desired, at: now };
        state.smoothedRates.set(key, sample);
        return sample.value;
      }
      const elapsed = Math.max(0, Math.min(500, now - sample.at));
      const timeConstant = desired > sample.value ? 550 : 1100;
      sample.value += (desired - sample.value) * (1 - Math.exp(-elapsed / timeConstant));
      if (Math.abs(desired - sample.value) < .05) sample.value = desired;
      sample.at = now;
      return sample.value;
    }

    function hashUnit(seed) {
      const value = Math.sin(seed * 91.733) * 43758.5453;
      return value - Math.floor(value);
    }

    function pointOnPath(from, via, to, progress) {
      if (progress < .5) {
        const t = progress * 2;
        return { x: from.x + (via.x - from.x) * t, y: from.y + (via.y - from.y) * t };
      }
      const t = (progress - .5) * 2;
      return { x: via.x + (to.x - via.x) * t, y: via.y + (to.y - via.y) * t };
    }

    function pointOnPolyline(points, progress) {
      const segment = Math.min(points.length - 2, Math.floor(progress * (points.length - 1)));
      const t = progress * (points.length - 1) - segment;
      return { x: points[segment].x + (points[segment + 1].x - points[segment].x) * t, y: points[segment].y + (points[segment + 1].y - points[segment].y) * t };
    }

    function pointOnCurve(from, control, to, progress) {
      const inverse = 1 - progress;
      return { x: inverse * inverse * from.x + 2 * inverse * progress * control.x + progress * progress * to.x, y: inverse * inverse * from.y + 2 * inverse * progress * control.y + progress * progress * to.y };
    }

    function pointOnCubicCurve(from, controlOne, controlTwo, to, progress) {
      const inverse = 1 - progress;
      return {
        x: inverse ** 3 * from.x + 3 * inverse * inverse * progress * controlOne.x + 3 * inverse * progress * progress * controlTwo.x + progress ** 3 * to.x,
        y: inverse ** 3 * from.y + 3 * inverse * inverse * progress * controlOne.y + 3 * inverse * progress * progress * controlTwo.y + progress ** 3 * to.y
      };
    }

    function updateThreadLayout(connections, field) {
      const activeIds = new Set(connections.map(item => item.id));
      for (const id of state.threadNodes.keys()) if (!activeIds.has(id)) state.threadNodes.delete(id);
      const centerX = (field.left + field.right) / 2, centerY = (field.top + field.bottom) / 2;
      connections.forEach((connection, index) => {
        const seed = Number(String(connection.id).replace(/\D/g, "")) || index + 1;
        let node = state.threadNodes.get(connection.id);
        if (!node) {
          node = { x: field.left + hashUnit(seed * 3) * (field.right - field.left), y: field.top + hashUnit(seed * 11) * (field.bottom - field.top), vx: 0, vy: 0 };
          state.threadNodes.set(connection.id, node);
        }
        node.vx += (centerX - node.x) * .0012;
        node.vy += (centerY - node.y) * .0012;
      });
      const nodes = connections.map(item => state.threadNodes.get(item.id));
      for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) {
        const a = nodes[left], b = nodes[right], dx = b.x - a.x, dy = b.y - a.y;
        const distanceSquared = Math.max(100, dx * dx + dy * dy), distance = Math.sqrt(distanceSquared);
        if (distance < 280) {
          const charge = 2200 / distanceSquared;
          a.vx -= dx / distance * charge; a.vy -= dy / distance * charge;
          b.vx += dx / distance * charge; b.vy += dy / distance * charge;
        }
        const xOverlap = 170 - Math.abs(dx), yOverlap = 40 - Math.abs(dy);
        if (xOverlap > 0 && yOverlap > 0) {
          const force = .35 + 1.2 * Math.max(xOverlap / 170, yOverlap / 40);
          const angle = Math.atan2(dy || .1, dx || .1);
          a.vx -= Math.cos(angle) * force; a.vy -= Math.sin(angle) * force;
          b.vx += Math.cos(angle) * force; b.vy += Math.sin(angle) * force;
        }
      }
      for (const node of nodes) {
        const margin = 38;
        if (node.x < field.left + margin) node.vx += (field.left + margin - node.x) * .018;
        if (node.x > field.right - margin) node.vx -= (node.x - field.right + margin) * .018;
        if (node.y < field.top + margin) node.vy += (field.top + margin - node.y) * .018;
        if (node.y > field.bottom - margin) node.vy -= (node.y - field.bottom + margin) * .018;
        node.vx *= .86; node.vy *= .86; node.x += node.vx; node.y += node.vy;
        node.x = Math.max(field.left, Math.min(field.right, node.x)); node.y = Math.max(field.top, Math.min(field.bottom, node.y));
      }
    }

    function updateModelLayout(models, field) {
      const activeIds = new Set(models.map(model => model.id));
      for (const id of state.modelNodes.keys()) if (!activeIds.has(id)) state.modelNodes.delete(id);
      const layoutKey = models.map(model => model.id).sort().join("|") + ":" + [field.left, field.right, field.top, field.bottom].map(Math.round).join(":");
      if (layoutKey !== state.modelLayoutKey) {
        state.modelLayoutKey = layoutKey;
        state.modelLayoutStableFrames = 0;
        state.modelLayoutSettled = false;
      }
      const centerX = (field.left + field.right) / 2, centerY = (field.top + field.bottom) / 2;
      models.forEach((model, index) => {
        const seed = [...model.id].reduce((sum, character) => sum + character.charCodeAt(0), index + 1);
        const targetX = field.left + 110 + hashUnit(seed * 7) * Math.max(1, field.right - field.left - 220);
        const targetY = field.top + 34 + hashUnit(seed * 13) * Math.max(1, field.bottom - field.top - 68);
        let node = state.modelNodes.get(model.id);
        if (!node) {
          node = { x: centerX, y: centerY, vx: 0, vy: 0, targetX, targetY };
          state.modelNodes.set(model.id, node);
          state.modelLayoutSettled = false;
          state.modelLayoutStableFrames = 0;
        }
        node.targetX = targetX;
        node.targetY = targetY;
      });
      if (state.modelLayoutSettled) return;
      const nodes = models.map(model => state.modelNodes.get(model.id));
      for (const node of nodes) {
        node.vx += (node.targetX - node.x) * .003;
        node.vy += (node.targetY - node.y) * .003;
      }
      for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) {
        const a = nodes[left], b = nodes[right], dx = b.x - a.x, dy = b.y - a.y;
        const xOverlap = 232 - Math.abs(dx), yOverlap = 82 - Math.abs(dy);
        if (xOverlap <= 0 || yOverlap <= 0) continue;
        const horizontal = xOverlap / 232, vertical = yOverlap / 82;
        if (horizontal < vertical) {
          const direction = Math.sign(dx) || (hashUnit(left * 17 + right * 31) > .5 ? 1 : -1);
          const force = .22 + horizontal * 1.15;
          a.vx -= direction * force; b.vx += direction * force;
        } else {
          const direction = Math.sign(dy) || (hashUnit(left * 29 + right * 11) > .5 ? 1 : -1);
          const force = .22 + vertical * 1.15;
          a.vy -= direction * force; b.vy += direction * force;
        }
      }
      const previousPositions = nodes.map(node => ({ x: node.x, y: node.y }));
      for (const node of nodes) {
        const halfWidth = 110, halfHeight = 34;
        if (node.x < field.left + halfWidth) node.vx += (field.left + halfWidth - node.x) * .03;
        if (node.x > field.right - halfWidth) node.vx -= (node.x - field.right + halfWidth) * .03;
        if (node.y < field.top + halfHeight) node.vy += (field.top + halfHeight - node.y) * .03;
        if (node.y > field.bottom - halfHeight) node.vy -= (node.y - field.bottom + halfHeight) * .03;
        node.vx *= .78; node.vy *= .78;
        node.x += node.vx; node.y += node.vy;
        node.x = Math.max(field.left + halfWidth, Math.min(field.right - halfWidth, node.x));
        node.y = Math.max(field.top + halfHeight, Math.min(field.bottom - halfHeight, node.y));
      }
      // Project overlapping cards apart after applying the softer forces. This
      // makes non-overlap a layout constraint whenever the field has room,
      // while still allowing the boundary to win in an impossibly dense field.
      for (let pass = 0; pass < 8; pass++) {
        let separated = true;
        for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) {
          const a = nodes[left], b = nodes[right], dx = b.x - a.x, dy = b.y - a.y;
          const xOverlap = 232 - Math.abs(dx), yOverlap = 82 - Math.abs(dy);
          if (xOverlap <= 0 || yOverlap <= 0) continue;
          separated = false;
          if (xOverlap < yOverlap) {
            const direction = Math.sign(dx) || (hashUnit(left * 17 + right * 31) > .5 ? 1 : -1);
            const shift = xOverlap / 2 + .05;
            a.x -= direction * shift; b.x += direction * shift;
            a.vx = 0; b.vx = 0;
          } else {
            const direction = Math.sign(dy) || (hashUnit(left * 29 + right * 11) > .5 ? 1 : -1);
            const shift = yOverlap / 2 + .05;
            a.y -= direction * shift; b.y += direction * shift;
            a.vy = 0; b.vy = 0;
          }
          a.x = Math.max(field.left + 110, Math.min(field.right - 110, a.x));
          b.x = Math.max(field.left + 110, Math.min(field.right - 110, b.x));
          a.y = Math.max(field.top + 34, Math.min(field.bottom - 34, a.y));
          b.y = Math.max(field.top + 34, Math.min(field.bottom - 34, b.y));
        }
        if (separated) break;
      }
      const maxMovement = nodes.reduce((maximum, node, index) => Math.max(maximum, Math.abs(node.x - previousPositions[index].x), Math.abs(node.y - previousPositions[index].y)), 0);
      state.modelLayoutStableFrames = maxMovement < .035 ? state.modelLayoutStableFrames + 1 : 0;
      if (state.modelLayoutStableFrames >= 24) {
        for (const node of nodes) { node.vx = 0; node.vy = 0; }
        state.modelLayoutSettled = true;
      }
    }

    function drawTopology(now) {
      const canvas = $("#topology-canvas");
      if (!canvas || !canvas.isConnected) return;
      const viewportWidth = Math.max(1, canvas.clientWidth), viewportHeight = Math.max(1, canvas.clientHeight);
      if (canvas.width !== Math.round(viewportWidth) || canvas.height !== Math.round(viewportHeight)) { canvas.width = Math.round(viewportWidth); canvas.height = Math.round(viewportHeight); }
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, viewportWidth, viewportHeight);
      const modelCount = (state.topologyModels || []).length;
      const connectionCount = (state.topologyConnections || []).length;
      const targetWorldScale = Math.max(1, Math.sqrt(Math.max(1, modelCount / 6)), Math.sqrt(Math.max(1, connectionCount / 14)));
      const worldEase = targetWorldScale > state.topologyWorldScale ? .18 : .06;
      state.topologyWorldScale += (targetWorldScale - state.topologyWorldScale) * worldEase;
      if (Math.abs(targetWorldScale - state.topologyWorldScale) < .002) state.topologyWorldScale = targetWorldScale;
      const fitZoom = 1 / state.topologyWorldScale;
      const targetZoom = Math.max(.18, Math.min(1.6, fitZoom * state.topologyCamera.manual));
      state.topologyCamera.current += (targetZoom - state.topologyCamera.current) * .12;
      const zoom = state.topologyCamera.current;
      const panX = state.topologyCamera.panX || 0, panY = state.topologyCamera.panY || 0;
      const zoomOutput = $("#topology-zoom-output");
      if (zoomOutput) zoomOutput.textContent = Math.round(zoom * 100) + "%";
      // Content density owns the logical world size. The camera only chooses
      // how much of that stable world is visible and never changes its bounds.
      const width = viewportWidth * state.topologyWorldScale, height = viewportHeight * state.topologyWorldScale;
      ctx.save();
      ctx.translate(viewportWidth / 2 + panX, viewportHeight / 2 + panY);
      ctx.scale(zoom, zoom);
      ctx.translate(-width / 2, -height / 2);
      ctx.font = '10px "SFMono-Regular",monospace'; ctx.textAlign = "left";
      ctx.fillStyle = "#8fb4ff"; ctx.beginPath(); ctx.arc(50, 91, 3, 0, Math.PI * 2); ctx.fill(); ctx.fillText("INPUT  →", 59, 95);
      ctx.fillStyle = "#2fe6c8"; ctx.beginPath(); ctx.arc(132, 91, 3, 0, Math.PI * 2); ctx.fill(); ctx.fillText("←  OUTPUT", 141, 95);
      const models = state.topologyModels || [];
      const rackFraction = Math.min(.5, .27 + Math.max(0, models.length - 3) * .045);
      const modelField = { left: width * (1 - rackFraction), right: width - 18, top: 105, bottom: height - 28 };
      const center = { x: modelField.left - 105, y: height * .53 };
      const gate = { left: center.x - 82, right: center.x + 82, top: center.y - 170, bottom: center.y + 170 };
      updateModelLayout(models, modelField);
      const modelPoints = new Map(models.map(model => {
        const node = state.modelNodes.get(model.id);
        return [model.id, { x: node.x, y: node.y, cardWidth: Math.min(220, modelField.right - modelField.left), model }];
      }));
      ctx.font = '11px "SFMono-Regular",monospace';
      ctx.textAlign = "left";
      const modelList = [...modelPoints.values()].sort((a, b) => a.y - b.y);
      modelList.forEach((point, index) => {
        const portY = center.y - Math.min(94, (modelList.length - 1) * 32) / 2 + index * Math.min(47, 94 / Math.max(1, modelList.length - 1));
        const from = { x: gate.right, y: portY }, to = { x: point.x - point.cardWidth / 2, y: point.y };
        const inputRate = smoothRate("model:" + point.model.id + ":in", point.model.liveInputRate, now);
        const outputRate = smoothRate("model:" + point.model.id + ":out", point.model.liveOutputRate, now);
        const rate = Math.max(inputRate, outputRate);
        const cumulative = Number(point.model.inputTokens || 0) + Number(point.model.outputTokens || 0);
        ctx.strokeStyle = rate > 0 ? "rgba(47,230,200,.82)" : cumulative > 0 ? "rgba(47,230,200,.32)" : "rgba(153,163,176,.15)";
        ctx.lineWidth = 1 + Math.min(2.5, Math.sqrt(rate) / 8);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        [[inputRate, false, "rgba(143,180,255,.94)"], [outputRate, true, "rgba(47,230,200,.94)"]].forEach(([directionRate, reverse, color], direction) => {
          const particles = directionRate > 0 ? Math.min(12, Math.max(2, Math.ceil(Math.sqrt(directionRate)))) : 0;
          for (let particle = 0; particle < particles; particle++) {
            let progress = (now * (.00012 + Math.min(directionRate, 180) * .0000015) + hashUnit(particle + index * 31 + direction * 71)) % 1;
            if (reverse) progress = 1 - progress;
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress, 1.5 + Math.min(2, directionRate / 90), 0, Math.PI * 2); ctx.fill();
          }
        });
      });
      const cardDrawList = [...modelPoints.values()].sort((a, b) => {
        const zDiff = modelCardZ(a.model) - modelCardZ(b.model);
        if (zDiff !== 0) return zDiff;
        return a.y - b.y || String(a.model.id).localeCompare(String(b.model.id));
      });
      if (state.topologyRaisedModelId && !modelPoints.has(state.topologyRaisedModelId)) state.topologyRaisedModelId = null;
      const hitCards = [];
      for (const point of cardDrawList) {
        const displayedLiveRate = smoothRate("model:" + point.model.id + ":display", point.model.liveRate, now);
        const live = displayedLiveRate > .05;
        const serving = point.model.state === "serving";
        const external = point.model.state === "external";
        const warming = point.model.state === "warming";
        const evicting = point.model.state === "evicting";
        const hot = point.model.state === "hot" || serving;
        const pulse = warming || evicting ? .35 + (Math.sin(now * .006) + 1) * .3 : 1;
        ctx.strokeStyle = serving ? "rgba(47,230,200,.95)" : external ? "rgba(192,153,255,.65)" : hot ? "rgba(47,230,200,.6)" : warming ? "rgba(243,189,79," + pulse + ")" : evicting ? "rgba(255,126,102," + pulse + ")" : "rgba(143,180,255,.22)";
        ctx.fillStyle = hot ? "rgba(7,18,17,.98)" : external ? "rgba(15,10,24,.96)" : warming ? "rgba(24,19,9,.97)" : evicting ? "rgba(25,11,9,.97)" : "rgba(8,10,15,.94)";
        const cardWidth = point.cardWidth, cardLeft = point.x - cardWidth / 2, cardTop = point.y - 34;
        hitCards.push({ id: point.model.id, left: cardLeft, top: cardTop, width: cardWidth, height: 68 });
        ctx.beginPath(); ctx.roundRect(cardLeft, cardTop, cardWidth, 68, 5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = serving ? "#42d77d" : external ? "#c099ff" : hot ? "#2fe6c8" : warming ? "#f3bd4f" : evicting ? "#ff7e66" : "#8fb4ff"; ctx.fillRect(cardLeft, cardTop, 4, 68);
        ctx.fillStyle = "rgba(242,245,247,.92)"; ctx.fillText(fitCanvasText(ctx, shortModel(point.model.id), cardWidth - 68), cardLeft + 12, point.y - 15);
        const vendor = modelVendor(point.model.id).toUpperCase();
        ctx.textAlign = "right"; ctx.fillStyle = "rgba(143,180,255,.78)"; ctx.fillText(fitCanvasText(ctx, vendor, 54), cardLeft + cardWidth - 10, point.y - 15); ctx.textAlign = "left";
        ctx.fillStyle = "rgba(153,163,176,.9)";
        ctx.fillText(formatCompact(point.model.inputTokens) + " in · " + formatCompact(point.model.outputTokens) + " out", cardLeft + 12, point.y + 4);
        ctx.fillStyle = serving ? "#42d77d" : external ? "#c099ff" : hot ? "#2fe6c8" : warming ? "#f3bd4f" : evicting ? "#ff7e66" : "rgba(143,180,255,.7)";
        const displayedModelRate = live ? displayedLiveRate : point.model.averageRate;
        const modelRateText = displayedModelRate == null ? "" : formatRate(displayedModelRate) + " tok/s";
        const modelStateText = serving ? "SERVING" : point.model.state.toUpperCase();
        ctx.fillText(fitCanvasText(ctx, modelStateText + (modelRateText ? " · " + modelRateText : ""), cardWidth - 22), cardLeft + 12, point.y + 23);
      }
      state.topologyHitCards = hitCards;
      state.topologyView = { viewportWidth, viewportHeight, width, height, zoom, panX, panY };
      const connections = state.topologyConnections || [];
      const orderedConnections = connections.slice().sort((a, b) => {
        const aSeed = Number(String(a.id).replace(/\D/g, "")) || 1;
        const bSeed = Number(String(b.id).replace(/\D/g, "")) || 1;
        return hashUnit(aSeed * 29) - hashUnit(bSeed * 29);
      });
      const threadField = { left: 62, right: gate.left - 170, top: 112, bottom: height - 45 };
      updateThreadLayout(orderedConnections, threadField);
      orderedConnections.forEach((connection, index) => {
        const seed = Number(String(connection.id).replace(/\D/g, "")) || index + 1;
        const from = state.threadNodes.get(connection.id);
        const slotCount = Math.max(1, Math.min(10, orderedConnections.length));
        const slotY = center.y - 136 + (index % slotCount) * (272 / Math.max(1, slotCount - 1));
        const ingress = { x: gate.left, y: slotY };
        const controlOne = { x: from.x + (ingress.x - from.x) * .38, y: from.y };
        const controlTwo = { x: from.x + (ingress.x - from.x) * .72, y: ingress.y };
        const inputRate = smoothRate("connection:" + connection.id + ":in", connection.inputRate, now);
        const outputRate = smoothRate("connection:" + connection.id + ":out", connection.outputRate, now);
        const rate = Math.max(inputRate, outputRate);
        const alpha = connection.live ? 1 : Math.max(0, 1 - (now - connection.fadeStartedAt) / 22500);
        ctx.strokeStyle = rate > 0 ? "rgba(47,230,200," + (.2 + alpha * .55) + ")" : "rgba(153,163,176," + alpha * .22 + ")";
        ctx.lineWidth = 1 + Math.min(2.5, Math.sqrt(rate) / 8);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.bezierCurveTo(controlOne.x, controlOne.y, controlTwo.x, controlTwo.y, ingress.x, ingress.y); ctx.stroke();
        [[inputRate, false, "rgba(143,180,255," + alpha * .94 + ")"], [outputRate, true, "rgba(47,230,200," + alpha * .94 + ")"]].forEach(([directionRate, reverse, color], direction) => {
          const particles = directionRate > 0 ? Math.min(10, Math.max(2, Math.ceil(Math.sqrt(directionRate)))) : 0;
          for (let particle = 0; particle < particles; particle++) {
            let progress = (now * (.00009 + Math.min(directionRate, 150) * .0000014) + hashUnit(particle + index * 17 + direction * 59)) % 1;
            if (reverse) progress = 1 - progress;
            const point = pointOnCubicCurve(from, controlOne, controlTwo, ingress, progress);
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(point.x, point.y, 1.5 + Math.min(2, directionRate / 80), 0, Math.PI * 2); ctx.fill();
          }
        });
        ctx.fillStyle = connection.live ? "#42d77d" : "rgba(153,163,176," + alpha * .7 + ")";
        ctx.beginPath(); ctx.arc(from.x, from.y, connection.live ? 6 : 4, 0, Math.PI * 2); ctx.fill();
        ctx.textAlign = "left"; ctx.fillStyle = "rgba(242,245,247," + alpha * .88 + ")";
        const connectionLabel = connection.caller ? connection.caller + " · " + connection.id : connection.id;
        ctx.fillText(connectionLabel, from.x + 10, from.y - 8);
        ctx.fillStyle = "rgba(153,163,176," + alpha * .9 + ")";
        const connectionRate = outputRate > .05 ? formatRate(outputRate) + " ~tok/s" : formatRate(connection.averageRate) + " avg tok/s";
        const liveStats = connection.outputPending ? " · awaiting JSON" : " · " + connectionRate;
        ctx.fillText(formatNumber(connection.inputTokens) + " in · " + formatNumber(connection.outputTokens) + " out" + liveStats, from.x + 10, from.y + 13);
      });
      ctx.textAlign = "center";
      const chassis = ctx.createLinearGradient(gate.left, 0, gate.right, 0);
      chassis.addColorStop(0, "rgba(7,11,12,.98)"); chassis.addColorStop(.5, "rgba(20,64,63,.96)"); chassis.addColorStop(1, "rgba(7,11,12,.98)");
      ctx.fillStyle = chassis; ctx.strokeStyle = "rgba(47,230,200,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(gate.left, gate.top, gate.right - gate.left, gate.bottom - gate.top, 9); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "rgba(143,180,255,.35)"; ctx.lineWidth = 1;
      for (let i = 0; i < 9; i++) { const y = gate.top + 30 + i * 25; ctx.beginPath(); ctx.moveTo(gate.left + 13, y); ctx.lineTo(gate.right - 13, y); ctx.stroke(); }
      ctx.fillStyle = "#e9fffb"; ctx.font = '700 18px "SFMono-Regular",monospace'; ctx.fillText("LLooM", center.x, gate.top + 39);
      ctx.fillStyle = "rgba(153,163,176,.9)"; ctx.font = '10px "SFMono-Regular",monospace'; ctx.fillText("ROUTING LOOM", center.x, gate.top + 57);
      const summary = state.topologySummary || {};
      const smoothedInputRate = smoothRate("summary:input", summary.inputRate, now);
      const smoothedOutputRate = smoothRate("summary:output", summary.outputRate, now);
      const statRows = [["ACTIVE", summary.active || 0], ["INPUT", formatRate(smoothedInputRate) + " ~t/s"], ["OUTPUT", formatRate(smoothedOutputRate) + " ~t/s"], ["ERRORS", summary.errors || 0]];
      ctx.font = '11px "SFMono-Regular",monospace';
      statRows.forEach((row, index) => { const y = gate.top + 94 + index * 27; ctx.textAlign = "left"; ctx.fillStyle = "rgba(153,163,176,.9)"; ctx.fillText(row[0], gate.left + 18, y); ctx.textAlign = "right"; ctx.fillStyle = "rgba(242,245,247,.95)"; ctx.fillText(String(row[1]), gate.right - 18, y); });
      const host = summary.host || {};
      const resourceRows = [
        ["CPU", host.cpu?.utilization],
        ["RAM", host.memory?.utilization],
        ["GPU", host.gpu?.utilization]
      ];
      ctx.font = '9px "SFMono-Regular",monospace';
      resourceRows.forEach((row, index) => {
        const y = gate.top + 218 + index * 24, value = row[1];
        ctx.textAlign = "left"; ctx.fillStyle = "rgba(153,163,176,.9)"; ctx.fillText(row[0], gate.left + 17, y);
        ctx.fillStyle = "rgba(143,180,255,.13)"; ctx.fillRect(gate.left + 51, y - 8, 74, 7);
        if (value != null) { ctx.fillStyle = value > 90 ? "#ff6f7d" : value > 70 ? "#f3bd4f" : "#2fe6c8"; ctx.fillRect(gate.left + 51, y - 8, 74 * Math.max(0, Math.min(100, value)) / 100, 7); }
        ctx.textAlign = "right"; ctx.fillStyle = "rgba(242,245,247,.9)"; ctx.fillText(value == null ? "–" : Math.round(value) + "%", gate.right - 17, y);
      });
      if (host.gpu) { ctx.textAlign = "center"; ctx.fillStyle = "rgba(153,163,176,.8)"; ctx.fillText(Math.round(host.gpu.temperatureC) + "°C · " + Math.round(host.gpu.powerDrawW) + "W", center.x, gate.bottom - 13); }
      ctx.restore();
    }

    function animateTopology() {
      if (!document.hidden) drawTopology(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : performance.now());
      setTimeout(animateTopology, 50);
    }
    animateTopology();

    function renderActivity() {
      const metrics = state.metrics || { totals: {}, models: [], active: [] };
      const totals = metrics.totals || {};
      const active = metrics.active || [];
      const sampleAt = Date.parse(metrics.generatedAt) || Date.now();
      const previous = state.trafficSample;
      const intervalSeconds = previous ? Math.max(.25, (sampleAt - previous.at) / 1000) : 1;
      const previousActive = previous?.active ?? new Map();
      const activeIds = new Set(active.map(item => item.id));
      const completedEstimate = [...previousActive.entries()].filter(([id]) => !activeIds.has(id)).reduce((sum, [, item]) => ({
        input: sum.input + Number(item.requestBytes || 0) / 4
      }), { input: 0 });
      const inputRate = previous ? Math.max(0, Number(totals.inputTokens || 0) - previous.inputTokens - completedEstimate.input) / intervalSeconds : 0;
      const activeRates = new Map(active.map(item => {
        const prior = previousActive.get(item.id);
        return [item.id, {
          input: prior ? 0 : Number(item.requestBytes || 0) / 4 / intervalSeconds,
          output: Math.max(0, Number(item.outputChars || 0) - Number(prior?.outputChars || 0)) / 4 / intervalSeconds
        }];
      }));
      state.trafficSample = {
        at: sampleAt,
        inputTokens: Number(totals.inputTokens || 0),
        outputTokens: Number(totals.outputTokens || 0),
        active: new Map(active.map(item => [item.id, { outputChars: item.outputChars || 0, requestBytes: item.requestBytes || 0 }]))
      };
      $("#fabric-in").textContent = formatCompact(Math.round(Number(totals.inputTokens || 0)));
      $("#fabric-out").textContent = formatCompact(Math.round(Number(totals.outputTokens || 0)));
      const liveInputRate = inputRate + [...activeRates.values()].reduce((sum, item) => sum + item.input, 0);
      // Completed totals include one-shot embedding and non-streaming payload estimates.
      // They count toward cumulative output volume, but are not generative decode throughput.
      const liveOutputRate = [...activeRates.values()].reduce((sum, item) => sum + item.output, 0);
      const totalDurationSeconds = Math.max(.001, Number(totals.durationMs || 0) / 1000);
      const averageInputRate = Number(totals.inputTokens || 0) / totalDurationSeconds;
      if (liveOutputRate > 0) {
        state.aggregateRateSamples.push(liveOutputRate);
        if (state.aggregateRateSamples.length > 10) state.aggregateRateSamples.shift();
      }
      const aggregateOutputRate = state.aggregateRateSamples.length
        ? state.aggregateRateSamples.reduce((sum, rate) => sum + rate, 0) / state.aggregateRateSamples.length
        : null;
      $("#fabric-rate").textContent = aggregateOutputRate == null ? "—" : formatRate(aggregateOutputRate);
      $("#fabric-active").textContent = formatNumber(active.length);
      state.topologySummary = {
        active: active.length,
        inputRate: liveInputRate,
        outputRate: liveOutputRate,
        averageInputRate,
        averageOutputRate: aggregateOutputRate || 0,
        errors: totals.errors || 0,
        host: metrics.host || null
      };
      const recentById = new Map();
      for (const entry of (metrics.recent || []).slice().reverse()) if (entry.id && !recentById.has(entry.id)) recentById.set(entry.id, entry);
      const topologyCanvas = $("#topology-canvas");
      const availableArea = Math.max(1, (topologyCanvas?.clientWidth || 1200) * .52 * Math.max(1, (topologyCanvas?.clientHeight || 560) - 150));
      const fieldCapacity = Math.max(8, Math.min(24, Math.floor(availableArea / (170 * 48))));
      const inactiveCapacity = Math.max(0, fieldCapacity - active.length);
      const fading = [...recentById.values()].filter(item => !activeIds.has(item.id) && sampleAt - Date.parse(item.at) < 22500).slice(0, inactiveCapacity);
      const connections = active.map(item => ({ ...item, live: true, ageMs: 0 })).concat(fading.map(item => ({ ...item, ageMs: Math.max(0, sampleAt - Date.parse(item.at)) })));
      state.topologyConnections = connections.map(item => ({
        ...item,
        fadeStartedAt: item.live ? performance.now() : performance.now() - item.ageMs,
        inputTokens: Math.round(Number(item.usage?.input_tokens || (item.requestBytes || 0) / 4)),
        outputTokens: Math.round(Number(item.usage?.output_tokens || item.outputChars / 4 || 0)),
        averageRate: Number(item.durationMs || item.elapsedMs) > 0 ? Number(item.usage?.output_tokens || item.outputChars / 4 || 0) / (Number(item.durationMs || item.elapsedMs) / 1000) : 0,
        inputRate: item.live ? activeRates.get(item.id)?.input || 0 : 0,
        outputRate: item.live ? activeRates.get(item.id)?.output || 0 : 0,
        outputPending: item.live === true && !item.stream && !item.responseBytes
      }));
      const modelMetrics = new Map((metrics.models || []).map(model => [model.id, model]));
      const runtimeStates = state.status?.runtimeManager?.runtimes || {};
      state.topologyModels = (state.models || []).map(model => {
        const data = modelMetrics.get(model.id) || {};
        const liveConnections = state.topologyConnections.filter(item => item.live && item.model === model.id);
        const liveInputRate = liveConnections.reduce((sum, item) => sum + item.inputRate, 0);
        const liveOutputRate = liveConnections.reduce((sum, item) => sum + item.outputRate, 0);
        const liveRate = liveOutputRate;
        const activeInput = liveConnections.reduce((sum, item) => sum + item.inputTokens, 0);
        const activeOutput = liveConnections.reduce((sum, item) => sum + item.outputTokens, 0);
        const runtimeStatus = runtimeStates[model.runtime]?.status || "idle";
        const stateLabel = liveConnections.length ? "serving" : !model.runtime ? "external" : runtimeStatus === "running" ? "hot" : runtimeStatus === "starting" ? "warming" : runtimeStatus === "stopping" ? "evicting" : "cold";
        return { id: model.id, inputTokens: Number(data.inputTokens || 0) + activeInput, outputTokens: Number(data.outputTokens || 0) + activeOutput, liveRate, liveInputRate, liveOutputRate, averageRate: data.decodeTokensPerSecond == null ? null : Number(data.decodeTokensPerSecond), state: stateLabel };
      });
    }

    async function refreshActivity() {
      try {
        state.metrics = await getJson("/gateway/metrics");
        renderActivity();
        const marker = $("#activity-state");
        marker.querySelector(".dot").className = "dot ok pulse";
        marker.querySelector("span:last-child").textContent = "live · " + new Date().toLocaleTimeString();
      } catch (error) {
        const marker = $("#activity-state");
        marker.querySelector(".dot").className = "dot bad";
        marker.querySelector("span:last-child").textContent = "telemetry offline";
      }
    }

    function showOutput(value) {
      state.output = value;
      $("#output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }

    async function refresh() {
      setHealth(false, "checking");
      try {
        const security = await getJson("/gateway/security");
        state.security = security;
        if ((security.authRequired || security.adminAuthRequired) && !headers().authorization) {
          // Best-effort: models/status may 401 until a key is provided.
        }
        const [health, models, status, library, backends] = await Promise.all([
          getJson("/health"),
          getJson("/gateway/models").catch(error => ({ models: [], error: error.message })),
          getJson("/gateway/status").catch(error => ({ error: error.message })),
          getJson("/gateway/library").catch(error => ({ error: error.message })),
          getJson("/gateway/backends").catch(error => ({ backends: [], error: error.message })),
        ]);
        state.models = models.models || [];
        state.status = status;
        state.library = library;
        state.backends = backends.backends || [];
        renderModels();
        renderRuntimes();
        renderBackends();
        renderLibrary();
        const authHint = security.adminAuthRequired
          ? "admin auth on"
          : security.authRequired
            ? "auth required"
            : "local open";
        setHealth(Boolean(health.ok), (health.name || "online") + " · " + authHint);
      } catch (error) {
        setHealth(false, "offline");
        showOutput({ error: error.message });
      }
    }

    function formPayload(form) {
      const data = new FormData(form);
      const payload = {};
      for (const [key, value] of data.entries()) {
        if (value !== "") payload[key] = value;
      }
      for (const input of form.querySelectorAll('input[type="checkbox"]')) {
        payload[input.name] = input.checked;
      }
      for (const key of ["port", "contextWindow"]) {
        if (payload[key] != null) payload[key] = Number(payload[key]);
      }
      return payload;
    }

    $("#refresh").addEventListener("click", refresh);
    function resetTopologyCamera() {
      state.topologyCamera.manual = 1;
      state.topologyCamera.panX = 0;
      state.topologyCamera.panY = 0;
    }
    function adjustTopologyZoom(delta, anchor) {
      const camera = state.topologyCamera;
      const view = state.topologyView;
      const beforeManual = camera.manual;
      camera.manual = Math.max(.55, Math.min(1.6, beforeManual + delta));
      if (!view || !anchor || camera.manual === beforeManual || !view.zoom) return;
      const fitZoom = 1 / Math.max(.001, state.topologyWorldScale);
      const beforeZoom = Math.max(.18, Math.min(1.6, fitZoom * beforeManual));
      const afterZoom = Math.max(.18, Math.min(1.6, fitZoom * camera.manual));
      const ratio = afterZoom / Math.max(.001, beforeZoom);
      const sx = anchor.x - view.viewportWidth / 2;
      const sy = anchor.y - view.viewportHeight / 2;
      camera.panX = sx - (sx - (camera.panX || 0)) * ratio;
      camera.panY = sy - (sy - (camera.panY || 0)) * ratio;
    }
    function topologyScreenPoint(event, canvas) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    function topologyWorldFromScreen(screenX, screenY, view) {
      const panX = view.panX || 0, panY = view.panY || 0;
      return {
        x: (screenX - view.viewportWidth / 2 - panX) / view.zoom + view.width / 2,
        y: (screenY - view.viewportHeight / 2 - panY) / view.zoom + view.height / 2
      };
    }
    function hitTopologyModelCard(screenX, screenY) {
      const view = state.topologyView;
      const cards = state.topologyHitCards || [];
      if (!view || !cards.length) return null;
      const world = topologyWorldFromScreen(screenX, screenY, view);
      for (let index = cards.length - 1; index >= 0; index--) {
        const card = cards[index];
        if (world.x >= card.left && world.x <= card.left + card.width && world.y >= card.top && world.y <= card.top + card.height) return card.id;
      }
      return null;
    }
    $("#topology-zoom-out").addEventListener("click", () => adjustTopologyZoom(-.1));
    $("#topology-zoom-in").addEventListener("click", () => adjustTopologyZoom(.1));
    $("#topology-zoom-reset").addEventListener("click", resetTopologyCamera);
    $("#topology-canvas").addEventListener("wheel", event => {
      event.preventDefault();
      const canvas = event.currentTarget;
      adjustTopologyZoom(event.deltaY > 0 ? -.08 : .08, topologyScreenPoint(event, canvas));
    }, { passive: false });
    $("#topology-canvas").addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const canvas = event.currentTarget;
      const point = topologyScreenPoint(event, canvas);
      state.topologyPanDrag = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        originPanX: state.topologyCamera.panX || 0,
        originPanY: state.topologyCamera.panY || 0,
        moved: false
      };
      canvas.setPointerCapture(event.pointerId);
    });
    $("#topology-canvas").addEventListener("pointermove", event => {
      const drag = state.topologyPanDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const canvas = event.currentTarget;
      const point = topologyScreenPoint(event, canvas);
      const dx = point.x - drag.startX, dy = point.y - drag.startY;
      if (!drag.moved && (dx * dx + dy * dy) < 25) return;
      drag.moved = true;
      canvas.classList.add("is-panning");
      state.topologyCamera.panX = drag.originPanX + dx;
      state.topologyCamera.panY = drag.originPanY + dy;
    });
    function endTopologyPan(event) {
      const drag = state.topologyPanDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const canvas = event.currentTarget;
      canvas.classList.remove("is-panning");
      state.topologyPanDrag = null;
      if (drag.moved) return;
      const point = topologyScreenPoint(event, canvas);
      state.topologyRaisedModelId = hitTopologyModelCard(point.x, point.y);
    }
    $("#topology-canvas").addEventListener("pointerup", endTopologyPan);
    $("#topology-canvas").addEventListener("pointercancel", endTopologyPan);
    $("#copy-output").addEventListener("click", async () => {
      await navigator.clipboard.writeText($("#output").textContent);
    });
    $("#setup-form").addEventListener("submit", async event => {
      event.preventDefault();
      const params = new URLSearchParams(formPayload(event.currentTarget));
      showOutput(await getJson("/gateway/setup/plan?" + params));
    });
    $("#onboard-plan").addEventListener("click", async () => {
      const params = new URLSearchParams(formPayload($("#setup-form")));
      showOutput(await getJson("/gateway/onboarding/plan?" + params));
    });
    $("#model-form").addEventListener("submit", async event => {
      event.preventDefault();
      showOutput(await postJson("/gateway/models/import-plan", formPayload(event.currentTarget)));
    });
    $("#community-form").addEventListener("submit", async event => {
      event.preventDefault();
      const params = new URLSearchParams(formPayload(event.currentTarget));
      showOutput(await getJson("/gateway/community/recommendations?" + params));
    });
    $("#pack-form").addEventListener("submit", async event => {
      event.preventDefault();
      showOutput(await postJson("/gateway/recipe-packs/plan", formPayload(event.currentTarget)));
    });
    document.addEventListener("click", async event => {
      const apply = event.target.closest("button[data-apply]");
      if (!apply) return;
      const targets = {
        setup: {
          form: $("#setup-form"),
          path: "/gateway/setup/apply",
          confirm: "Apply this LLooM setup change now?",
        },
        onboard: {
          form: $("#setup-form"),
          path: "/gateway/onboarding/apply",
          confirm: "Run the LLooM onboarding flow now?",
        },
        model: {
          form: $("#model-form"),
          path: "/gateway/models/import",
          confirm: "Apply this LLooM model change now?",
        },
        pack: {
          form: $("#pack-form"),
          path: "/gateway/recipe-packs/import",
          confirm: "Import this recipe pack now?",
        },
        community: {
          form: $("#community-form"),
          path: "/gateway/community/import",
          confirm: "Import the selected community recommendation now?",
        },
      };
      const target = targets[apply.dataset.apply];
      if (!target) return;
      if (!ensureAdminKeyIfNeeded()) return;
      if (!window.confirm(target.confirm)) return;
      const payload = { ...formPayload(target.form), yes: true };
      showOutput(await postJson(target.path, payload));
      await refresh();
    });
    document.addEventListener("click", async event => {
      const button = event.target.closest("button[data-backend-action]");
      if (!button) return;
      const backend = button.dataset.backend;
      if (button.dataset.backendAction === "plan") {
        showOutput(await getJson("/gateway/backends/" + encodeURIComponent(backend) + "/plan"));
        return;
      }
      if (!ensureAdminKeyIfNeeded()) return;
      if (!window.confirm("Install or link backend " + backend + " now?")) return;
      showOutput(await postJson("/gateway/backends/" + encodeURIComponent(backend) + "/install", { yes: true }));
      await refresh();
    });
    document.addEventListener("click", async event => {
      const button = event.target.closest("button[data-runtime]");
      if (!button) return;
      if (!ensureAdminKeyIfNeeded()) return;
      const runtime = button.dataset.runtime;
      const action = button.dataset.action;
      const path = "/gateway/runtimes/" + encodeURIComponent(runtime) + "/" + action;
      showOutput(await postJson(path, action === "start" ? { warmup: true } : {}));
      await refresh();
    });
    $("#warm-all").addEventListener("click", async () => {
      const runtimes = Object.keys(state.status?.runtimeManager?.runtimes || {});
      const results = [];
      for (const runtime of runtimes) {
        results.push(await postJson("/gateway/runtimes/" + encodeURIComponent(runtime) + "/warmup", {}));
      }
      showOutput(results);
      await refresh();
    });

    refresh();
    refreshActivity();
    setInterval(refreshActivity, 1000);
    setInterval(refresh, 10000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        refresh();
        refreshActivity();
      }
    });
  </script>
</body>
</html>`;

export function renderDashboardPage() {
  return DASHBOARD_HTML;
}
