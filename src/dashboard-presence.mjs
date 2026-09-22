export const presenceStyles = `
    :root { color-scheme:dark; --bg:#080d12; --band:#0d151d; --panel:#111c25; --panel-2:#15232e; --line:#243641; --text:#edf5f8; --muted:#9eb3c0; --accent:#38dff5; --accent-2:#85c8ff; --danger:#fb927e; }
    body { font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:14px; letter-spacing:0; }
    body > header { margin-left:190px; min-height:72px; padding:16px 28px; background:var(--bg); border-bottom:1px solid var(--line); }
    body > header .brand { display:none; }
    .topline { width:100%; justify-content:flex-end; }
    main { margin-left:190px; width:auto; padding:24px 28px; max-width:none; min-width:0; }
    main > * { min-width:0; }
    button.primary { background:#1e4953; border-color:#36717d; }
    button,input,select,textarea { font-family:inherit; border-radius:9px; }
    button { text-transform:none; font-size:13px; letter-spacing:0; font-weight:500; }
    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
    h1,h2,h3,strong { font-weight:500; }
    .pill { text-transform:none; letter-spacing:0; font-size:12px; border-radius:20px; }
    .band,.empty { border-radius:14px; }
    .band-head h2,label { text-transform:none; letter-spacing:0; }
    .band-body { padding:22px; }
    .presence-nav { position:fixed; top:0; bottom:0; left:0; width:190px; padding:26px 18px; background:#0b1219; border-right:1px solid var(--line); display:flex; flex-direction:column; gap:7px; z-index:20; }
    .presence-brand { padding:0 12px 30px; font-size:24px; letter-spacing:-1px; font-weight:500; }
    .presence-brand small { display:block; color:var(--muted); font-size:10px; letter-spacing:2px; margin-top:3px; }
    .presence-nav button { display:flex; align-items:center; gap:12px; text-align:left; background:transparent; border:1px solid transparent; min-height:43px; color:var(--muted); padding:10px 12px; }
    .presence-nav button[aria-current="page"] { color:var(--text); background:#18303a; border-color:#25515e; }
    .presence-nav button:last-child { margin-top:auto; }
    .presence-nav svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.6; }
    .presence-heading { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:24px; }
    .presence-heading h2 { margin:0 0 7px; font-size:clamp(26px,3vw,38px); letter-spacing:-1.2px; font-weight:500; }
    .presence-heading p { margin:0; color:var(--muted); line-height:1.6; }
    .presence-view[hidden], [hidden] { display:none!important; }
    .presence-toolbar { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:22px; }
    .presence-toolbar input { min-width:180px; max-width:380px; flex:1; margin:0; }
    .presence-toolbar select { width:auto; min-width:140px; margin:0; }
    .presence-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(265px,1fr)); gap:16px; }
    .presence-card { background:linear-gradient(140deg,#14222c,#101a23); border:1px solid var(--line); border-radius:16px; padding:22px; display:flex; flex-direction:column; gap:14px; min-width:0; }
    .presence-card h3 { font-size:17px; margin:0; line-height:1.4; overflow-wrap:anywhere; }
    .presence-card p { color:var(--muted); margin:0; line-height:1.65; overflow-wrap:anywhere; }
    .presence-card .actions { margin-top:auto; }
    .presence-eyebrow { font-size:11px; color:var(--muted); letter-spacing:1.1px; text-transform:uppercase; }
    .presence-card-top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .presence-status { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:7px; }
    .presence-status::before { content:""; width:6px; height:6px; background:currentColor; border-radius:50%; flex-shrink:0; }
    .presence-status[data-ready="true"] { color:var(--accent); }
    .presence-card dl { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin:0; font-size:12px; }
    .presence-card dt { color:var(--muted); }
    .presence-card dd { margin:0; text-align:right; overflow-wrap:anywhere; }
    .presence-memory { height:5px; background:#263640; border-radius:4px; overflow:hidden; }
    .presence-memory > span { display:block; height:100%; background:var(--accent); }
    .presence-section-title { font-size:18px; margin:30px 0 16px; }
    .presence-message { color:var(--muted); padding:20px 0; line-height:1.7; max-width:800px; }
    .presence-notice { position:fixed; z-index:60; bottom:20px; left:218px; right:28px; max-width:660px; background:#162b35; color:var(--text); border:1px solid #345767; border-radius:12px; padding:16px 48px 16px 18px; box-shadow:0 10px 35px #0008; overflow-wrap:anywhere; }
    .presence-notice[data-error="true"] { border-color:#a36050; }
    .presence-notice button { position:absolute; right:7px; top:7px; background:none; border:0; }
    .presence-connection { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(260px,1fr); gap:20px; }
    .presence-connection pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; background:#091118; border-radius:10px; padding:18px; max-height:360px; overflow:auto; }
    .presence-connection label { display:block; font-size:12px; margin-top:12px; }
    .presence-connection select { margin-top:8px; }
    .presence-readiness { display:flex; flex-wrap:wrap; gap:6px; }
    .presence-readiness button { flex:1; font-size:12px; padding:9px 7px; }
    .presence-readiness button[aria-pressed="true"] { background:#20414b; border-color:var(--accent); }
    .presence-drawer { position:fixed; z-index:45; inset:0; display:grid; place-items:center; padding:20px; background:#02080cc9; }
    .presence-dialog { width:min(620px,100%); max-height:90vh; overflow:auto; border:1px solid var(--line); background:var(--panel); border-radius:20px; padding:28px; }
    .presence-dialog h2 { margin-top:0; letter-spacing:-.5px; }
    .presence-dialog label { display:block; margin:14px 0; }
    .presence-dialog pre { max-height:230px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
    .presence-dialog details { margin:16px 0; color:var(--muted); }
    .presence-dialog .actions { justify-content:flex-end; flex-wrap:wrap; }
    .presence-trial { margin-top:18px; }
    .presence-trial textarea { width:100%; padding:12px; background:var(--bg); color:var(--text); border:1px solid var(--line); resize:vertical; min-height:90px; }
    .presence-trial pre { white-space:pre-wrap; font-size:13px; line-height:1.7; }
    .topology { border:1px solid var(--line); border-radius:18px; min-height:600px; background:#080f15; box-shadow:none; }
    .topology::before,.topology::after { display:none; }
    .topology-canvas { min-height:600px; height:calc(100vh - 230px); background:transparent; }
    .topology-hud { top:16px; left:16px; right:16px; flex-wrap:wrap; gap:8px; }
    .topology-hud-panel { flex:1 1 220px; }
    .topology-hud-right { flex-wrap:wrap; max-width:100%; }
    .topology-hud-panel .mono { font-family:inherit; font-size:12px; }
    .topology-hud-panel { background:#101b24e8; border-color:var(--line); border-radius:10px; box-shadow:none; }
    .fabric-title { font-family:inherit; font-size:13px; letter-spacing:0; font-weight:500; }
    .topology-model-filter,.topology-metrics,.topology-zoom { border-radius:9px; }
    .fabric-totals { gap:14px; }
    .fabric-total strong { font-family:inherit; font-weight:500; }
    .model-inspector { position:fixed; z-index:40; top:88px; right:24px; bottom:24px; max-height:calc(100vh - 112px); width:min(390px,calc(100vw - 32px)); border-radius:18px; background:#101b24; border-color:#345461; box-shadow:0 24px 80px #0008; }
    .model-inspector:not(.open) { visibility:hidden; }
    .model-inspector-title { font-weight:500; font-size:22px; }
    .model-detail-grid { grid-template-columns:1fr 1fr; }
    .model-detail strong { font-weight:400; }
    .model-inspector-actions { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .operations-dock { margin:0; border-radius:16px; }
    .operations-dock > summary { display:none; }
    .operations-content { padding:0; }
    .operations-content .grid.two { grid-template-columns:1fr; }
    @media(max-width:1000px) { .presence-nav { width:155px; padding:24px 10px; } body > header, main { margin-left:155px; } main { padding:22px 18px; } .presence-notice { left:175px; } .topology-hud { flex-wrap:wrap; gap:8px; } .topology-hud-right { flex-wrap:wrap; } .topology-hud-panel > .muted { display:none; } .presence-connection { grid-template-columns:1fr; } }
    @media(max-width:640px) { .presence-nav { position:sticky; width:100%; top:0; bottom:auto; flex-direction:row; padding:8px; gap:4px; border-right:0; border-bottom:1px solid var(--line); } .presence-brand { display:none; } .presence-nav button { flex:1; flex-direction:column; justify-content:center; padding:6px 2px; gap:4px; font-size:11px; } .presence-nav button:last-child { margin-top:0; } body > header, main { margin-left:0; } body > header { padding:12px 16px; min-height:0; } .topline { justify-content:space-between; gap:8px; } #endpoint { max-width:65%; overflow:hidden; text-overflow:ellipsis; } main { padding:20px 12px; } .topology-hud { top:10px; left:10px; right:10px; } .topology-canvas { min-height:550px; height:65vh; } .topology { min-height:550px; } .topology-zoom { left:8px; right:auto; } .presence-heading { margin-bottom:20px; } .presence-grid { grid-template-columns:1fr; } .presence-notice { left:12px; right:12px; bottom:12px; } .model-inspector { top:76px; bottom:12px; right:12px; width:calc(100vw - 24px); max-height:calc(100vh - 88px); } .presence-dialog { padding:20px; } .presence-drawer { padding:12px; } }
    @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; } }
`;

const icons = {
  live: '<circle cx="12" cy="12" r="3"/><circle cx="4" cy="5" r="1.5"/><circle cx="20" cy="5" r="1.5"/><circle cx="20" cy="19" r="1.5"/><path d="M5 6l5 4m4 0 5-4m-5 8 5 4"/>',
  models: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  machines: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  clients: '<path d="m7 5-5 7 5 7m10-14 5 7-5 7M14 4l-4 16"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>'
};
export const presenceNav = `<nav class="presence-nav" aria-label="Main navigation"><div class="presence-brand">LLooM<small>BY ENNTITY</small></div>${Object.entries(
  icons
)
  .map(
    ([id, paths]) =>
      `<button type="button" data-view="${id}" ${id === 'live' ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>${id[0].toUpperCase() + id.slice(1)}</button>`
  )
  .join('')}</nav>`;

export const presenceViews = `
    <section id="view-models" class="presence-view" hidden>
      <div class="presence-heading"><div><h2>Models that fit.</h2><p>Your models, available when you need them.</p></div><button type="button" class="primary" data-add-model>Add model</button></div>
      <div class="presence-toolbar"><input id="presence-search" type="search" aria-label="Search models" placeholder="Find a model…"><select id="presence-kind" aria-label="Model type"><option value="">All models</option><option value="chat">Chat &amp; code</option><option value="image">Images</option><option value="audio">Voice &amp; audio</option><option value="embedding">Embeddings</option><option value="video">Video</option></select><span id="presence-model-count" class="muted"></span></div>
      <div id="presence-models" class="presence-grid"></div>
    </section>
    <section id="view-machines" class="presence-view" hidden>
      <div class="presence-heading"><div><h2>Better together.</h2><p>See the hardware behind your models.</p></div><button id="presence-discover" type="button">Find nearby</button></div>
      <div id="presence-machines" class="presence-grid"></div>
      <h3 class="presence-section-title">Nearby machines</h3><div id="nearby-machines" class="presence-message">Select Find nearby to look for LLooM installations.</div>
      <div class="presence-message">Shared models use the gateway you already connect to. Running one larger model across machines requires a vendor recipe that supports their hardware and connection.</div>
    </section>
    <section id="view-clients" class="presence-view" hidden>
      <div class="presence-heading"><div><h2>Bring your favorite client.</h2><p>One gateway for the tools you already use.</p></div></div>
      <div class="presence-connection"><div class="presence-card"><h3>Connect to LLooM</h3><p>Use an OpenAI-compatible endpoint in your application. Models stay behind the same gateway as your hardware changes.</p><label>Base URL<input id="presence-client-url" readonly></label><label>Gateway model<select id="presence-client-model"></select></label><div class="actions"><button id="presence-copy-url" type="button">Copy URL</button><button id="presence-copy-example" type="button">Copy request</button></div><pre id="presence-client-example"></pre></div><div class="presence-card"><h3>Client integrations</h3><p>Generate configuration through the CLI. Review the proposed files before applying changes.</p><div id="presence-integrations"></div><p id="presence-client-auth"></p></div></div>
    </section>
    <div id="presence-toast" class="presence-notice" role="status" hidden><span></span><button type="button" aria-label="Dismiss notification">×</button></div>
    <div id="presence-add" class="presence-drawer" hidden><section class="presence-dialog" role="dialog" aria-modal="true" aria-labelledby="presence-add-title"><h2 id="presence-add-title">Add a model.</h2><p class="muted">Choose a recommended recipe or bring a model reference. LLooM checks the installation before applying it.</p><div id="presence-recommendation"></div><form id="presence-add-form"><label>Model reference<input id="presence-model-ref" required placeholder="hf.co/organization/model or ollama:model"></label><details><summary>Installation details</summary><label>Backend<input id="presence-model-backend" placeholder="Choose automatically"></label><label>Display name<input id="presence-model-name" placeholder="Optional"></label></details><div id="presence-add-review" hidden><p id="presence-plan-summary"></p><details><summary>Review full plan</summary><pre id="presence-plan-json"></pre></details></div><p id="presence-add-error" role="alert"></p><div class="actions"><button id="presence-add-close" type="button">Cancel</button><button type="submit" class="primary" id="presence-add-plan">Review installation</button><button type="button" class="primary" id="presence-add-apply" hidden>Install model</button></div></form></section></div>
`;
