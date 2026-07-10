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
      .grid.two, .split, .stats { grid-template-columns: 1fr; }
      main { padding: 18px; }
    }
    @media (max-width: 640px) {
      header { padding: 16px; }
      main { padding: 12px; }
      .form-grid { grid-template-columns: 1fr; }
      .band-head { align-items: flex-start; flex-direction: column; }
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
      output: null,
    };

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
  </script>
</body>
</html>`;

export function renderDashboardPage() {
  return DASHBOARD_HTML;
}
