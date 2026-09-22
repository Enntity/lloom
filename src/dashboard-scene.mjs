// The product composition: physical machines around a single gateway, with
// motion driven by observed requests. The old diagnostic canvas stays available.
export const sceneStyles = `
  body { background:radial-gradient(ellipse at 48% 8%,#0a1c24 0,transparent 48%),#050b0f; }
  body > header { min-height:38px;padding:8px 26px;background:transparent;border:0; }
  body > header .topline {font-size:11px;opacity:.65}
  body > header #refresh {padding:4px 10px;font-size:11px}
  main {padding-top:8px}
  .presence-nav {background:linear-gradient(180deg,#081218,#070d12);padding-top:24px}
  .presence-nav button[aria-current] {color:#2be1f6;background:linear-gradient(90deg,#11313c,#102029);position:relative;border-color:#193540}
  .presence-nav button[aria-current]::before {content:"";position:absolute;left:-9px;top:8px;bottom:8px;width:3px;border-radius:4px;background:#2be1f6;box-shadow:0 0 14px #2be1f666}
  .presence-brand {display:flex;gap:12px;align-items:center;padding:0 8px 30px;font-weight:600;letter-spacing:-.6px}
  .presence-brand small {font-weight:400;text-transform:none;letter-spacing:0;font-size:12px}
  .presence-brand .scene-logo {width:30px;height:40px;filter:drop-shadow(0 0 8px #29dff344)}
  .presence-heading h2 {font-size:36px;font-weight:600;letter-spacing:-1.1px}
  .presence-heading {margin-bottom:22px}
  button.primary,.scene-primary {background:linear-gradient(115deg,#29def3,#26cfee);border:1px solid #64e5f3;color:#03202a;box-shadow:0 5px 23px #0dcced16;font-weight:600}
  button.primary:hover,.scene-primary:hover {background:#72eafb;box-shadow:0 0 22px #2ddaf32b}
  .scene-icon {display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
  .scene-icon svg {width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .scene-layout {display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:14px;align-items:stretch}
  .scene-diagram,.scene-detail,.scene-analytics,.scene-memory-panel,.scene-network {border:1px solid #24343f;border-radius:16px;background:linear-gradient(135deg,#0b171d88,#060d12b0);box-shadow:inset 0 1px #8ad7f304}
  .scene-diagram {position:relative;height:clamp(440px,calc(100vh - 320px),620px);overflow:hidden}
  .scene-columns {position:relative;z-index:1;display:grid;grid-template-columns:minmax(130px,.78fr) minmax(100px,.66fr) minmax(240px,1.42fr);gap:18px;height:100%;padding:22px 20px}
  .scene-column {min-width:0;min-height:0;display:flex;flex-direction:column}
  .scene-column > h3 {font-size:14px;margin:0 0 6px;font-weight:500}
  .scene-column > p {font-size:12px;color:#9fb5c7;margin:0}
  .scene-clients {display:flex;flex:1;flex-direction:column;justify-content:space-evenly;gap:18px;padding:38px 0}
  .scene-client {display:flex;gap:12px;align-items:center;padding:17px 13px;border:1px solid #284553;border-radius:13px;background:linear-gradient(135deg,#162933aa,#08151bec);box-shadow:0 12px 24px #0002;min-height:72px}
  .scene-client .scene-icon {width:34px;height:38px;border-radius:9px;background:linear-gradient(135deg,#263a47,#11212c);color:#c9ecf8}
  .scene-client strong {display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere}
  .scene-client small {display:block;margin-top:6px;color:#9cb5c7;font-size:11px;line-height:1.4}
  .scene-client[data-active="true"] {border-color:#2d7283}
  .scene-gateway-column {text-align:center}
  .scene-gateway-wrap {flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-bottom:28px}
  .scene-gateway {position:relative;width:98px;height:98px;border-radius:50%;border:2px solid #32def7;background:radial-gradient(circle at 32% 25%,#143642,#03131c 70%);display:grid;place-items:center;box-shadow:0 0 0 7px #0a2c3629,0 0 26px #14d3f22b,inset 0 0 24px #10cbea13;isolation:isolate}
  .scene-gateway::before,.scene-gateway::after {content:"";position:absolute;inset:-12px;border-radius:50%;border:1px solid #28d4ef18;pointer-events:none}
  .scene-gateway::after {inset:-28px;border-color:#27d9f208}
  .scene-gateway[data-active="true"] {animation:scene-breathe 3s ease-in-out infinite;box-shadow:0 0 0 7px #0a2c3629,0 0 38px #14d3f258,inset 0 0 28px #10cbea25}
  .scene-gateway svg {width:37px;height:48px;filter:drop-shadow(0 0 8px #21dff36b)}
  .scene-gateway-wrap > strong {font-size:17px;margin-top:18px;font-weight:500}
  .scene-gateway-wrap > small {font-size:12px;color:#a4c0d2;margin-top:8px;text-align:center}
  .scene-machines {display:flex;flex-direction:column;justify-content:center;gap:12px;flex:1;min-height:0;overflow:auto;padding-top:18px;justify-content:flex-start}
  .scene-machine {border:1px solid #29404d;border-radius:13px;background:linear-gradient(125deg,#10222d80,#0a141cdb);padding:13px;min-width:0}
  .scene-machine-header {display:flex;gap:10px;align-items:center;margin-bottom:12px}
  .scene-machine-header .scene-icon {color:#b9d8e9}
  .scene-machine-header strong {display:block;font-size:13px;font-weight:500}
  .scene-machine-header small {display:block;color:#9bb6c8;font-size:11px;margin-top:4px;line-height:1.4}
  .scene-machine-header > div:nth-child(2) {flex:1;min-width:0;overflow-wrap:anywhere}
  .scene-mini-memory {width:76px;text-align:right;flex-shrink:0}
  .scene-mini-memory > i {height:5px;border-radius:5px;background:#1a303e;display:block;overflow:hidden;margin-bottom:5px}
  .scene-mini-memory b {height:100%;display:block;border-radius:5px;background:linear-gradient(90deg,#0dc7e7,#4ce5f5);box-shadow:0 0 8px #37d7f85c}
  .scene-mini-memory small {font-size:10px!important}
  .scene-model {width:100%;display:flex;align-items:center;gap:10px;margin-top:7px;border:1px solid #203440;border-radius:10px;background:linear-gradient(100deg,#11212a8a,#09151ad9);padding:10px 9px;text-align:left;min-height:43px;box-shadow:inset 0 1px #b5eaff03}
  .scene-model[data-serving="true"],.scene-model[data-selected="true"] {border-color:#27cbe6;background:linear-gradient(100deg,#07303e,#0a1720);box-shadow:inset 0 0 20px #22dffa07,0 0 15px #19cfea0a}
  .scene-model > .scene-icon svg {width:18px;height:18px}
  .scene-model-name {flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
  .scene-model-state {font-size:10px;color:#a9c2d4;background:#1a2c37;border:1px solid #223d4b;border-radius:15px;padding:4px 8px;white-space:nowrap}
  [data-serving="true"] > .scene-model-state {color:#49e5ee;border-color:#087d91;background:#06313b}
  .scene-more {border:0;background:none;font-size:11px;color:#9ec2d4;padding:10px 4px 0;display:block}
  .scene-links {position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;overflow:visible}
  .scene-detail {min-width:0;padding:22px;height:clamp(440px,calc(100vh - 320px),620px);overflow:auto}
  .scene-placeholder {height:100%;display:flex;flex-direction:column;justify-content:center;text-align:center;align-items:center;gap:18px}
  .scene-placeholder .scene-icon {width:72px;height:72px;border:1px solid #28414e;border-radius:50%;color:#7fdfea;background:radial-gradient(circle at 40% 30%,#203d4b,#0b1922)}
  .scene-placeholder .scene-icon svg {width:32px;height:32px}
  .scene-placeholder h3 {font-size:22px;margin:0}
  .scene-placeholder p {font-size:13px;color:#99b2c5;line-height:1.7;margin:0}
  .scene-detail .model-inspector {position:static;visibility:visible;width:100%;max-height:none;height:auto;border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}
  .scene-detail .model-inspector:not(.open) {display:none}
  .scene-detail .model-inspector-header {padding:0 0 22px;border-bottom:1px solid #233642}
  .scene-detail .model-inspector-body {padding:0;overflow:visible}
  .scene-detail .model-inspector-title {font-size:22px;line-height:1.35}
  .scene-detail .model-inspector-state {margin-bottom:12px}
  .scene-detail #presence-policy {padding:20px 0;border-bottom:1px solid #233642}
  .scene-detail #presence-policy h3 {font-size:14px;margin:0 0 14px}
  .presence-readiness {gap:0;border:1px solid #2c4757;border-radius:10px;overflow:hidden}
  .presence-readiness button {border-radius:0;border:0;border-right:1px solid #243c49;padding:12px 4px;background:transparent;font-size:11px;white-space:nowrap}
  .presence-readiness button:last-child {border:0}
  .presence-readiness button[aria-pressed="true"] {background:#25d3ee;color:#012333}
  #presence-policy-hint {font-size:12px;line-height:1.6;margin:16px 0 0}
  .scene-detail .model-inspector-actions {padding:20px 0;gap:7px}
  .scene-detail details {border-top:1px solid #233642;padding-top:18px;margin-top:18px}
  .scene-detail summary {font-size:13px;cursor:pointer}
  .scene-inspector-memory {padding:18px 0;border-bottom:1px solid #233642;display:flex;justify-content:space-between;gap:12px;font-size:12px;color:#a9c1cf}
  .scene-inspector-memory strong {color:#e1f2f6;font-weight:400}
  .scene-analytics {margin-top:14px;display:grid;grid-template-columns:1fr 1fr 1fr;padding:20px 24px;gap:24px}
  .scene-chart {min-width:0}
  .scene-chart + .scene-chart {border-left:1px solid #20323e;padding-left:24px}
  .scene-chart h3 {display:flex;justify-content:space-between;gap:10px;margin:0 0 16px;font-size:13px;font-weight:500}
  .scene-chart h3 span {font-size:11px;color:#9cbed2;font-weight:400}
  .scene-chart svg {width:100%;height:80px;overflow:visible}
  .scene-chart-caption {font-size:10px;color:#6e899d;margin-top:6px}
  .scene-memory-row {display:grid;grid-template-columns:minmax(70px,1fr) 1.4fr auto;align-items:center;gap:12px;font-size:11px;margin:12px 0;color:#b9cedb}
  .scene-memory-row > span:first-child {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .scene-memory-row i {height:7px;border-radius:4px;background:#182f3c;overflow:hidden}
  .scene-memory-row b {display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#11ccea,#53e7f6)}
  .scene-tools {display:flex;align-items:center;justify-content:space-between;gap:12px;margin:17px 0 4px;color:#7998ad;font-size:11px;flex-wrap:wrap}
  .scene-tools .actions {align-items:center;gap:8px;margin:0}
  .scene-tools button {padding:8px 12px;font-size:11px;background:#0b171f;border-color:#223a48}
  .scene-follow {display:flex;gap:8px;align-items:center;font-size:11px;color:#acccdc}
  .scene-follow input {accent-color:#22d9f3;width:auto;margin:0}
  .scene-memory-panel {padding:22px;margin-bottom:24px}
  .scene-memory-panel h3 {display:flex;justify-content:space-between;font-size:16px;margin:0 0 18px;align-items:center}
  .scene-memory-panel select {width:auto;max-width:180px;font-size:11px;padding:5px 8px;background:#0a161e}
  .scene-memory-bar {display:flex;gap:2px;min-height:72px;border-radius:10px;overflow:hidden}
  .scene-memory-segment {min-width:100px;flex:1;padding:14px 18px;background:linear-gradient(110deg,#35444f,#253945);color:#dde9f0;font-size:12px}
  .scene-memory-segment strong {display:block;font-size:23px;margin-top:6px;font-weight:600}
  .scene-memory-segment.available {background:linear-gradient(100deg,#349f9c,#55b4a7);color:#042322}
  .scene-model-layout {display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:22px}
  .scene-model-list {display:flex;flex-direction:column;gap:9px}
  .scene-model-row {display:grid;grid-template-columns:44px minmax(130px,1.4fr) minmax(75px,.7fr) auto;gap:16px;align-items:center;border:1px solid #203541;border-radius:13px;padding:19px;background:linear-gradient(120deg,#111d2490,#09141b80);cursor:pointer;text-align:left;min-height:92px}
  .scene-model-row[data-selected="true"] {border-color:#29d3eb;background:linear-gradient(100deg,#0a2a37c0,#0c1c2690)}
  .scene-model-row > .scene-icon {width:44px;height:48px;background:linear-gradient(135deg,#24374688,#101d2a);border:1px solid #2b414d;border-radius:11px;color:#d6e9f4}
  .scene-model-row > .scene-icon svg {width:25px;height:25px}
  .scene-model-row h3 {margin:0;font-size:16px;overflow-wrap:anywhere;font-weight:500;line-height:1.35}
  .scene-model-row p {font-size:12px;color:#96aebe;margin:6px 0 0}
  .scene-row-status {font-size:12px;color:#a6c2d1;display:flex;align-items:center;gap:7px}
  .scene-row-status::before {content:"";width:7px;height:7px;border-radius:50%;background:#718b9c;flex-shrink:0}
  .scene-model-row[data-ready="true"] .scene-row-status::before {background:#44dccf;box-shadow:0 0 8px #44dccf22}
  .scene-row-policy {font-size:10px;color:#a1bbc9;border:1px solid #28414e;border-radius:8px;padding:7px 9px;white-space:nowrap}
  .scene-model-tabs {display:flex;align-items:center;gap:25px;border-bottom:1px solid #273b45;margin:0 0 18px}
  .scene-model-tabs strong {padding:0 0 13px;font-size:16px;border-bottom:3px solid #1ed5f0}
  .scene-model-tabs button {background:none;border:0;color:#8aa5b7;padding:0 0 15px}
  .scene-chips {display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}
  .scene-chips button {border-radius:22px;padding:8px 16px;background:#0b141a;font-size:12px;border-color:#34454e}
  .scene-chips button[aria-pressed="true"] {border-color:#29dcee;background:#0d2c36;color:#55e9f5}
  .scene-add-capability {display:flex;gap:15px;align-items:center;border:1px dashed #35515d;border-radius:13px;padding:22px;margin-top:18px;background:#09131977}
  .scene-add-capability > .scene-icon {width:40px;height:40px;border:1px solid #8aa9b8;border-radius:50%}
  .scene-add-capability strong {font-size:16px;font-weight:500;display:block}
  .scene-add-capability p {font-size:12px;color:#98b3c4;margin:7px 0 0}
  .scene-add-capability button {margin-left:auto;padding:11px 16px}
  .scene-network {display:flex;align-items:center;justify-content:center;gap:0;padding:40px 30px;margin-bottom:30px;min-height:190px;overflow:auto}
  .scene-device {min-width:110px;text-align:center}
  .scene-device .scene-icon {display:flex;filter:drop-shadow(0 0 12px #20d3f72b);color:#a7edff;margin-bottom:12px}
  .scene-device svg {width:88px;height:70px;stroke-width:.65}
  .scene-device strong {font-size:13px;font-weight:500}
  .scene-wire {height:1px;min-width:60px;flex:1;max-width:160px;background:linear-gradient(90deg,#22d3f4,#1c8fa5);box-shadow:0 0 9px #20d5ed60;position:relative;margin:0 16px 22px}
  .scene-wire::before,.scene-wire::after {content:"";position:absolute;top:-3px;width:7px;height:7px;border-radius:50%;background:#28def4;box-shadow:0 0 12px #25d5ee}
  .scene-wire::after {right:0}
  .scene-wire span {position:absolute;top:-22px;left:0;right:0;text-align:center;font-size:10px;color:#72dbe9;white-space:nowrap}
  .scene-machine-list {display:flex;flex-direction:column;gap:12px}
  .scene-machine-list .presence-card {display:grid;grid-template-columns:54px minmax(120px,1fr) minmax(150px,1fr) auto;gap:24px;align-items:center;padding:23px}
  .scene-machine-list .presence-card > .scene-icon {color:#aae9f8;filter:drop-shadow(0 0 9px #1cc5df40)}
  .scene-machine-list .presence-card > .scene-icon svg {width:52px;height:45px;stroke-width:.8}
  .scene-machine-list .presence-card h3 {font-size:17px}
  .scene-machine-list .presence-card p {font-size:12px;margin-top:7px}
  @keyframes scene-breathe {50%{box-shadow:0 0 0 10px #0a2c3630,0 0 46px #14d3f262,inset 0 0 28px #10cbea25}}
  @media(min-width:1650px) {.scene-layout,.scene-model-layout {grid-template-columns:minmax(0,1fr) 360px}.scene-columns {gap:30px;padding:30px}.scene-diagram,.scene-columns,.scene-detail {min-height:610px}.scene-model-name{font-size:13px}}
  @media(max-width:1220px) {.scene-layout,.scene-model-layout {grid-template-columns:minmax(0,1fr) 280px;gap:12px}.scene-columns {grid-template-columns:120px 90px minmax(210px,1fr);gap:8px;padding:20px 15px}.scene-gateway {width:78px;height:78px}.scene-detail {padding:18px}.scene-mini-memory{width:58px}.scene-model-row {grid-template-columns:35px minmax(0,1fr) auto;gap:12px;padding:15px}.scene-row-policy{display:none}.scene-model-row > .scene-icon{width:35px;height:40px}.scene-model-row h3{font-size:14px}.scene-model-state{font-size:9px;padding:4px 6px}.scene-model-name{font-size:11px}}
  @media(max-width:1050px) {.scene-layout,.scene-model-layout {grid-template-columns:1fr}.scene-detail {min-height:0}.scene-detail:has(.scene-placeholder:not([hidden])){display:none}.scene-columns{grid-template-columns:minmax(125px,.8fr) minmax(100px,.8fr) minmax(230px,1.4fr);gap:20px}.scene-analytics{padding:20px;gap:18px}.scene-chart + .scene-chart{padding-left:18px}.scene-machine-list .presence-card{grid-template-columns:44px 1fr auto;gap:18px}.scene-machine-list .presence-card .machine-memory{grid-column:2 / -1;grid-row:2}.scene-model-row {grid-template-columns:40px minmax(0,1fr) auto auto}.scene-row-policy{display:block}}
  @media(max-width:680px) {.presence-brand{display:none}.presence-nav{padding:8px}.presence-nav button[aria-current]::before{left:12px;right:12px;top:auto;bottom:0;width:auto;height:2px}body > header{display:none}main{padding-top:22px}.presence-heading h2{font-size:29px}.scene-columns{grid-template-columns:1fr 1fr;gap:18px;padding:20px;min-height:0}.scene-gateway-column{grid-column:2;grid-row:1}.scene-client-column{grid-column:1;grid-row:1}.scene-machine-column{grid-column:1/-1}.scene-gateway-wrap{min-height:210px;padding:30px 0 0}.scene-clients{padding:25px 0;gap:12px}.scene-diagram{min-height:0}.scene-machines{padding-top:16px}.scene-analytics{grid-template-columns:1fr;gap:22px}.scene-chart + .scene-chart{border-left:0;border-top:1px solid #20323e;padding:20px 0 0}.scene-chart svg{height:74px}.scene-model-row{grid-template-columns:34px minmax(0,1fr) auto;padding:15px 12px;gap:10px}.scene-model-row .scene-row-policy{display:none}.scene-row-status{font-size:10px}.scene-memory-panel{padding:18px}.scene-memory-segment{padding:12px;font-size:11px;min-width:80px}.scene-memory-segment strong{font-size:21px}.scene-add-capability{padding:18px;flex-wrap:wrap}.scene-add-capability button{width:100%;margin:0}.scene-network{padding:25px 18px;justify-content:flex-start}.scene-machine-list .presence-card{grid-template-columns:40px 1fr;gap:14px;padding:18px}.scene-machine-list .presence-card .actions{grid-column:1/-1}.scene-machine-list .presence-card .machine-memory{grid-column:1/-1;grid-row:auto}.scene-links{opacity:.85}.scene-model-name{font-size:12px}.scene-model-state{font-size:10px}}
  @media(max-width:680px){.scene-detail:has(.model-inspector.open){position:fixed;z-index:80;left:12px;right:12px;bottom:12px;height:auto;max-height:calc(100dvh - 96px);background:linear-gradient(145deg,#122530,#09141c);box-shadow:0 -20px 70px #0009,0 0 0 1px #42616b66;padding:22px}.scene-detail:has(.model-inspector.open) .model-inspector-header{position:sticky;top:-22px;margin-top:-22px;padding-top:22px;background:#10212b;z-index:1}}
  @media(prefers-reduced-motion:reduce){.scene-gateway{animation:none!important}.scene-links .scene-particle{display:none}.scene-model{transition:none}}
`;

export const sceneScript = String.raw`
    const scenePaths={
      model:'<path d="m12 2 9 5-9 5-9-5 9-5Zm-9 5v10l9 5 9-5V7M12 12v10"/>',
      chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 1 1 21 11.5Z"/><path d="M7 9h9M7 13h6"/>',
      code:'<path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18"/>',
      image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.4"/><path d="m3 17 5-5 4 4 3-4 6 6"/>',
      audio:'<path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>',
      laptop:'<rect x="4" y="3" width="16" height="14" rx="1.5"/><path d="M4 17 1 20h22l-3-3M9 20h6"/>',
      server:'<path d="m6 3 11-2 3 2v18l-3 2-11-2V3Zm0 0 3 2 11-2M9 5v17"/><path d="M12 16v2m3-2v2"/>',
      cloud:'<path d="M6 19a5 5 0 0 1-1-9.9A7 7 0 0 1 18.7 8 5.5 5.5 0 0 1-.2 11H6Z"/>',
      terminal:'<path d="m4 7 5 5-5 5m8 0h8"/>',
      plus:'<path d="M12 4v16M4 12h16"/>'
    };
    function sceneIcon(kind){return '<span class="scene-icon" aria-hidden="true"><svg viewBox="0 0 24 24">'+(scenePaths[kind]||scenePaths.model)+'</svg></span>';}
    const sceneLogo='<svg class="scene-logo" viewBox="0 0 36 48" fill="none" aria-hidden="true"><path d="M6 3h8v33h17v9H6V3Z" stroke="#57e6f7" stroke-width="2"/><path d="M10 7v33h17" stroke="#1c7486" stroke-width="1"/></svg>';
    function sceneKind(model){return ({chat:'Chat & code',embedding:'Search & retrieval',audio_speech:'Speech',audio_transcription:'Transcription',audio_generation:'Music & audio',image:'Generate & edit',video:'Video'})[model.kind] || model.kind || 'Chat & code';}
    function sceneModelIcon(model){return (model.kind||'').startsWith('audio')?'audio':(model.kind||'').startsWith('image')?'image':model.kind==='chat'?'model':'code';}
    function sceneMemory(node){
      const memory=node?.telemetry?.memory || {};
      const total=Number(memory.totalBytes), available=Number(memory.availableBytes), rawUsed=Number(memory.usedBytes);
      const used=memory.availableBytes!=null&&Number.isFinite(available)?total-available:memory.usedBytes!=null?rawUsed:NaN;
      return {total,used,available,known:total>0&&Number.isFinite(used),percent:Math.max(0,Math.min(100,used/total*100))};
    }
    function sceneNodes(){const nodes=Object.values(state.status?.cluster?.nodes || {});return nodes.length?nodes:state.topologySummary?.host?[{id:'local',local:true,name:'This machine',telemetry:state.topologySummary.host}]:[];}
    function sceneNodeName(node){return node.local?'This machine':node.name || node.id;}
    function sceneMiniMemory(node){const m=sceneMemory(node);return m.known?'<div class="scene-mini-memory"><i><b style="width:'+m.percent+'%"></b></i><small>'+escapeHtml(formatBytes(m.used))+' / '+escapeHtml(formatBytes(m.total))+'</small></div>':'';}
    function sceneDeviceIcon(node){return node.local || /apple|mac/i.test(node.profile?.platformId || node.profile?.cpuBrand || '')?'laptop':'server';}
    document.querySelector('.presence-brand').innerHTML=sceneLogo+'<span>LLooM<small>by Enntity</small></span>';
    const scene=document.createElement('section');scene.id='presence-scene';scene.dataset.presencePanel='live';
    scene.innerHTML='<div class="scene-layout"><div class="scene-diagram"><svg id="scene-links" class="scene-links" aria-hidden="true"></svg><div class="scene-columns"><div class="scene-column scene-client-column"><h3>Clients</h3><p id="scene-client-count">Waiting for telemetry</p><div id="scene-clients" class="scene-clients"></div></div><div class="scene-column scene-gateway-column"><h3>LLooM Gateway</h3><p>Routes and balances</p><div class="scene-gateway-wrap"><div id="scene-gateway" class="scene-gateway">'+sceneLogo+'</div><strong>Gateway</strong><small id="scene-active">Connecting…</small></div></div><div class="scene-column scene-machine-column"><h3>Models on your machines</h3><p id="scene-machine-count"></p><div id="scene-machines" class="scene-machines"></div></div></div></div><aside id="scene-live-detail" class="scene-detail"><div class="scene-placeholder">'+sceneIcon('model')+'<h3>Your AI, together.</h3><p>Select a model to manage its memory, availability, and vendor recipe.</p></div></aside></div><div class="scene-analytics"><div class="scene-chart"><h3>Requests <span id="scene-requests-label"></span></h3><svg id="scene-request-chart" aria-label="Observed active requests over this session"></svg><div class="scene-chart-caption">Observed during this session</div></div><div class="scene-chart"><h3>Response time <span id="scene-latency-label"></span></h3><svg id="scene-latency-chart" aria-label="Observed completed request durations"></svg><div class="scene-chart-caption">Recent completed requests · includes generation time</div></div><div class="scene-chart"><h3>Machine memory <span>Used / total</span></h3><div id="scene-memory-list"></div></div></div><div class="scene-tools"><span id="scene-health">Waiting for gateway telemetry</span><div class="actions"><label class="scene-follow"><input type="checkbox" id="scene-follow">Follow activity</label><button type="button" id="scene-diagnostic">Detailed topology</button></div></div>';
    $('.topology').before(scene);
    $('.topology').dataset.presencePanel='diagnostic';$('.topology').hidden=true;
    const modelLeft=document.createElement('div');modelLeft.className='scene-model-main';
    const modelLayout=document.createElement('div');modelLayout.className='scene-model-layout';$('#view-models').append(modelLayout);modelLayout.append(modelLeft);
    const memoryPanel=document.createElement('section');memoryPanel.className='scene-memory-panel';memoryPanel.innerHTML='<h3>Your memory <select id="scene-memory-machine" aria-label="Memory by machine"></select></h3><div id="scene-memory-bar" class="scene-memory-bar"></div><p class="muted" style="font-size:11px;margin:13px 0 0">Downloads stay on disk when models leave memory.</p>';
    modelLeft.append(memoryPanel);
    const modelTabs=document.createElement('div');modelTabs.className='scene-model-tabs';modelTabs.innerHTML='<strong>Installed</strong><button type="button" data-add-model>Discover</button>';
    modelLeft.append(modelTabs,$('.presence-toolbar'));
    const chips=document.createElement('div');chips.className='scene-chips';chips.innerHTML=[['','All'],['chat','Chat & code'],['image','Images'],['audio','Voice'],['embedding','Search'],['video','Video']].map(([id,name])=>'<button type="button" data-scene-kind="'+id+'" aria-pressed="'+String(!id)+'">'+name+'</button>').join('');
    modelLeft.append(chips,$('#presence-models'));$('#presence-models').className='scene-model-list';$('#presence-kind').hidden=true;
    const capability=document.createElement('div');capability.className='scene-add-capability';capability.innerHTML=sceneIcon('plus')+'<div><strong>Add a capability</strong><p>Get more done with another model.</p></div><button class="primary" type="button" data-add-model>Find a model</button>';modelLeft.append(capability);
    const modelDetail=document.createElement('aside');modelDetail.id='scene-model-detail';modelDetail.className='scene-detail';modelDetail.innerHTML='<div class="scene-placeholder">'+sceneIcon('model')+'<h3>Make room for more.</h3><p>Select a model to choose how it uses memory. Your downloaded files stay on disk.</p></div>';
    modelLayout.append(modelLeft,modelDetail);$('#view-models').append(modelLayout);
    const network=document.createElement('div');network.id='scene-network';network.className='scene-network';$('#presence-machines').before(network);$('#presence-machines').className='scene-machine-list';
    const inspectorMemory=document.createElement('div');inspectorMemory.className='scene-inspector-memory';inspectorMemory.id='scene-inspector-memory';$('#presence-policy').before(inspectorMemory);
    let sceneClientKey='',sceneMachineKey='',sceneModelKey='',sceneNodeKey='',sceneLinkKey='',sceneSamples=[],sceneSampleAt=0;
    let sceneMemoryNode=null,sceneFollowing=false;
    function sceneMoveInspector(){
      const slot=presenceView==='models'?modelDetail:$('#scene-live-detail');
      if($('#model-inspector').parentElement!==slot)slot.append($('#model-inspector'));
      document.querySelectorAll('.scene-placeholder').forEach(item=>item.hidden=Boolean(state.selectedModelId)&&item.parentElement===slot);
      if(state.selectedModelId){const model=state.physicalModels.find(m=>m.id===state.selectedModelId),rt=model&&presenceRuntime(model);inspectorMemory.innerHTML='<span>Memory estimate</span><strong>'+(rt?.memoryGb!=null?escapeHtml(rt.memoryGb)+' GB':'Not reported')+'</strong>';}
    }
    const scenePreviousView=presenceSetView;
    presenceSetView=function(name){scenePreviousView(name);sceneMoveInspector();renderScene();};
    const scenePreviousInspector=renderModelInspector;
    renderModelInspector=function(){scenePreviousInspector();sceneMoveInspector();};
    renderPresenceModels=function(){
      const search=$('#presence-search').value.trim().toLowerCase(),kind=$('#presence-kind').value;
      const models=(state.physicalModels||[]).filter(m=>(!search||(m.name+' '+m.id).toLowerCase().includes(search))&&(!kind||(m.kind||'chat').startsWith(kind))).sort((a,b)=>Number(Boolean(b.runtime))-Number(Boolean(a.runtime))||Number(Boolean(presenceRuntime(b)?.healthy))-Number(Boolean(presenceRuntime(a)?.healthy)));
      $('#presence-model-count').textContent=models.length+(models.length===1?' model':' models');
      const key=JSON.stringify(models.map(m=>[m.id,m.name,sceneKind(m),presenceModelLabel(m),presencePolicy(presenceRuntime(m)),state.selectedModelId===m.id]));if(key===sceneModelKey)return;sceneModelKey=key;
      $('#presence-models').innerHTML=models.map(model=>{const rt=presenceRuntime(model);return '<button type="button" class="scene-model-row" data-presence-model="'+escapeHtml(model.id)+'" data-selected="'+String(state.selectedModelId===model.id)+'" data-ready="'+String(Boolean(rt?.healthy||rt?.activeRequests))+'">'+sceneIcon(sceneModelIcon(model))+'<div><h3>'+escapeHtml(model.name||model.id)+'</h3><p>'+escapeHtml(sceneKind(model))+'</p></div><span class="scene-row-status">'+escapeHtml(presenceModelLabel(model))+'</span><span class="scene-row-policy">'+escapeHtml(rt?presencePolicyNames[presencePolicy(rt)]:'Upstream')+'</span></button>';}).join('')||'<div class="empty">No models match. Choose another filter or add a model.</div>';
    };
    renderPresenceMachines=function(){
      const nodes=sceneNodes(),key=JSON.stringify(nodes.map(n=>[n.id,n.name,n.local,n.reachable,n.profile?.cpuBrand,sceneMemory(n)]));if(key===sceneNodeKey)return;sceneNodeKey=key;
      network.innerHTML=nodes.map((node,index)=>(index?'<div class="scene-wire"><span>'+(node.reachable===false?'Unavailable':'Configured connection')+'</span></div>':'')+'<div class="scene-device">'+sceneIcon(sceneDeviceIcon(node))+'<strong>'+escapeHtml(sceneNodeName(node))+'</strong></div>').join('')||'<p class="muted">Waiting for machine telemetry</p>';
      $('#presence-machines').innerHTML=nodes.map(node=>{const m=sceneMemory(node);return '<article class="presence-card">'+sceneIcon(sceneDeviceIcon(node))+'<div><h3>'+escapeHtml(sceneNodeName(node))+'</h3><p>'+escapeHtml(node.profile?.cpuBrand||node.id)+' · '+(node.reachable===false?'Unavailable':node.local?'This computer':'Configured peer')+'</p></div><div class="machine-memory"><p>'+(m.known?escapeHtml(formatBytes(m.total))+' memory':'Memory unavailable')+'</p><div class="presence-memory"><span style="width:'+(m.known?m.percent:0)+'%"></span></div><p>'+(m.known?escapeHtml(formatBytes(m.used))+' used / '+escapeHtml(formatBytes(m.total)):'No reading')+'</p></div><div class="actions"><button type="button" data-presence-node="'+escapeHtml(node.id)+'">Manage →</button></div></article>';}).join('');
    };
    function sceneChart(selector,values,color){
      const svg=$(selector),width=300,height=78,max=Math.max(1,...values),points=values.map((value,index)=>[values.length>1?index/(values.length-1)*width:0,height-4-(value/max)*(height-10)]);
      const path=points.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
      svg.setAttribute('viewBox','0 0 300 80');svg.setAttribute('preserveAspectRatio','none');
      svg.innerHTML='<defs><linearGradient id="'+selector.slice(1)+'-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="'+color+'" stop-opacity=".18"/><stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>'+[0,26,52,78].map(y=>'<path d="M0 '+y+'H300" stroke="#203946" stroke-width=".5"/>').join('')+(values.length>1?'<path d="'+path+' L300,80 L0,80Z" fill="url('+selector+'-fill)"/><path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="1.6" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 3px '+color+'55)"/>':'');
    }
    function renderScene(){
      if(!scene.isConnected)return;
      const nodes=sceneNodes(),models=state.physicalModels||[],connections=(state.topologyConnections||[]).filter(c=>c.live),summary=state.topologySummary||{};
      const clients=new Map();for(const connection of connections){const id=connection.caller||connection.requester||'API client';if(!clients.has(id))clients.set(id,{name:id,count:0});clients.get(id).count++;}
      const clientRows=[...clients.values()].slice(0,4),clientKey=JSON.stringify(clientRows);
      if(clientKey!==sceneClientKey||!$('#scene-clients').children.length){sceneClientKey=clientKey;$('#scene-clients').innerHTML=clientRows.map(client=>'<div class="scene-client" data-active="true">'+sceneIcon(/code|terminal|cli|agent/i.test(client.name)?'terminal':'chat')+'<div><strong>'+escapeHtml(client.name)+'</strong><small>'+client.count+' active request'+(client.count===1?'':'s')+'</small></div></div>').join('')||'<div class="scene-client" data-active="false">'+sceneIcon('terminal')+'<div><strong>Ready for a client</strong><small>Connect an app to see its requests here.</small></div></div>';sceneLinkKey='';}
      $('#scene-client-count').textContent=connections.length?clients.size+' active client'+(clients.size===1?'':'s'):'No active requests';
      $('#scene-active').textContent=(summary.active||0)?summary.active+' active request'+(summary.active===1?'':'s'):'Ready when you are';$('#scene-gateway').dataset.active=String(Boolean(summary.active));
      $('#scene-machine-count').textContent=nodes.length+' machine'+(nodes.length===1?'':'s')+' · '+models.length+' models';
      const groups=nodes.map(node=>({node,models:models.filter(model=>{const topology=(state.topologyCatalogModels||[]).find(m=>m.id===model.id);const rt=presenceRuntime(model),ids=[...new Set([...(topology?.nodes||[]),...(model.targets||[]).map(t=>t.node),...(rt?.members||[]).map(m=>m.node),rt?.node].filter(Boolean))];return ids.includes(node.id)||(!ids.length&&Boolean(model.runtime)&&node.local);})}));
      const assigned=new Set(groups.flatMap(g=>g.models.map(m=>m.id)));const external=models.filter(m=>!assigned.has(m.id));if(external.length)groups.push({node:{id:'external',name:'External providers'},models:external,external:true});
      const visibleGroups=groups.map(group=>({...group,models:group.models.slice().sort((a,b)=>Number(presenceRuntime(b)?.activeRequests>0)-Number(presenceRuntime(a)?.activeRequests>0)||Number(Boolean(presenceRuntime(b)?.healthy))-Number(Boolean(presenceRuntime(a)?.healthy)))}));
      const machineKey=JSON.stringify(visibleGroups.map(g=>[g.node.id,g.node.reachable,g.models.map(m=>[m.id,m.name,presenceModelLabel(m),connections.some(c=>c.model===m.id),m.id===state.selectedModelId]),sceneFollowing]));
      if(machineKey!==sceneMachineKey){sceneMachineKey=machineKey;$('#scene-machines').innerHTML=visibleGroups.filter(g=>!sceneFollowing||!summary.active||g.models.some(m=>presenceRuntime(m)?.activeRequests>0||connections.some(c=>c.model===m.id))).map(group=>{
        const ranked=sceneFollowing&&summary.active?group.models.filter(m=>presenceRuntime(m)?.activeRequests>0||connections.some(c=>c.model===m.id)):group.models;
        const shown=ranked.slice(0,group.external?2:3);
        return '<div class="scene-machine" data-scene-node="'+escapeHtml(group.node.id)+'"><div class="scene-machine-header">'+sceneIcon(group.external?'cloud':sceneDeviceIcon(group.node))+'<div><strong>'+escapeHtml(sceneNodeName(group.node))+'</strong><small>'+escapeHtml(group.external?'Through your gateway':group.node.profile?.cpuBrand||group.node.id)+'</small></div>'+sceneMiniMemory(group.node)+'</div>'+shown.map(model=>{const label=presenceModelLabel(model),active=connections.some(c=>c.model===model.id),serving=label==='Serving'||(active&&!model.runtime&&!model.federated);return '<button type="button" class="scene-model" data-presence-model="'+escapeHtml(model.id)+'" data-serving="'+String(serving)+'" data-active="'+String(active)+'" data-selected="'+String(model.id===state.selectedModelId)+'">'+sceneIcon(sceneModelIcon(model))+'<span class="scene-model-name" title="'+escapeHtml(model.name||model.id)+'">'+escapeHtml(model.name||model.id)+'</span><span class="scene-model-state">'+escapeHtml(serving?'Serving':label==='External provider'?'External':label)+'</span></button>';}).join('')+(group.models.length>shown.length?'<button type="button" class="scene-more" data-scene-all>View all '+group.models.length+' models →</button>':'')+'</div>';
      }).join('')||'<div class="empty">Add a model to bring your hardware to life.</div>';sceneLinkKey='';}
      for(const group of visibleGroups){const box=[...document.querySelectorAll('[data-scene-node]')].find(el=>el.dataset.sceneNode===group.node.id),mini=box?.querySelector('.scene-mini-memory');if(mini){const m=sceneMemory(group.node);mini.querySelector('b').style.width=m.percent+'%';mini.querySelector('small').textContent=formatBytes(m.used)+' / '+formatBytes(m.total);}}
      const minute=state.metrics?.rolling?.minute||{};$('#scene-requests-label').textContent=(summary.active||0)+' active'+(minute.requests!=null?' · '+minute.requests+'/min':'');
      const now=Date.now();if(now-sceneSampleAt>1900){sceneSamples.push(Number(summary.active||0));if(sceneSamples.length>60)sceneSamples.shift();sceneSampleAt=now;}
      sceneChart('#scene-request-chart',sceneSamples,'#29d9f5');
      const durations=(state.metrics?.recent||[]).slice(0,40).reverse().map(r=>Number(r.durationMs)/1000).filter(n=>Number.isFinite(n)&&n>=0);sceneChart('#scene-latency-chart',durations,'#47e7cc');$('#scene-latency-label').textContent=durations.length?(durations.reduce((a,b)=>a+b,0)/durations.length).toFixed(1)+'s avg':'No completed requests';
      $('#scene-memory-list').innerHTML=nodes.slice(0,4).map(node=>{const m=sceneMemory(node);return '<div class="scene-memory-row"><span>'+escapeHtml(sceneNodeName(node))+'</span><i><b style="width:'+(m.known?m.percent:0)+'%"></b></i><span>'+(m.known?escapeHtml(formatBytes(m.used))+' / '+escapeHtml(formatBytes(m.total)):'Unknown')+'</span></div>';}).join('')||'<p class="muted">Memory telemetry unavailable</p>';
      $('#scene-health').textContent=state.status?.error?'Gateway telemetry needs attention':nodes.length?'Live gateway telemetry · '+(summary.recentErrors||0)+' errors in the last minute':'Connecting to your gateway…';
      const machineSelect=$('#scene-memory-machine');const optionsKey=nodes.map(n=>n.id).join('|');if(machineSelect.dataset.nodes!==optionsKey){machineSelect.dataset.nodes=optionsKey;machineSelect.innerHTML=nodes.map(n=>'<option value="'+escapeHtml(n.id)+'">'+escapeHtml(sceneNodeName(n))+'</option>').join('');if(nodes.some(n=>n.id===sceneMemoryNode))machineSelect.value=sceneMemoryNode;}
      sceneMemoryNode=machineSelect.value;const memory=sceneMemory(nodes.find(n=>n.id===sceneMemoryNode));$('#scene-memory-bar').innerHTML=memory.known?'<div class="scene-memory-segment" style="flex:'+Math.max(1,memory.percent)+'">In use<strong>'+escapeHtml(formatBytes(memory.used))+'</strong></div><div class="scene-memory-segment available" style="flex:'+Math.max(1,100-memory.percent)+'">Available<strong>'+escapeHtml(formatBytes(memory.total-memory.used))+'</strong></div>':'<div class="scene-memory-segment">Waiting for a physical machine memory reading.</div>';
      sceneMoveInspector();requestAnimationFrame(sceneDrawLinks);
    }
    function sceneDrawLinks(){
      if(scene.hidden||document.hidden)return;
      const root=$('.scene-diagram'),bounds=root.getBoundingClientRect(),gateway=$('#scene-gateway').getBoundingClientRect(),gx=gateway.left-bounds.left+gateway.width/2,gy=gateway.top-bounds.top+gateway.height/2;
      const curves=[];for(const client of document.querySelectorAll('.scene-client')){const box=client.getBoundingClientRect();curves.push({x:box.right-bounds.left,y:box.top-bounds.top+box.height/2,toX:gx-gateway.width/2,toY:gy,active:client.dataset.active==='true'});}
      for(const model of document.querySelectorAll('#scene-machines .scene-model')){const box=model.getBoundingClientRect(),viewport=$('#scene-machines').getBoundingClientRect();if(box.top<viewport.top||box.bottom>viewport.bottom)continue;curves.push({x:gx+gateway.width/2,y:gy,toX:box.left-bounds.left,toY:box.top-bounds.top+box.height/2,active:model.dataset.active==='true'});}
      const key=JSON.stringify(curves.map(c=>[Math.round(c.x),Math.round(c.y),Math.round(c.toX),Math.round(c.toY),c.active]));if(key===sceneLinkKey)return;sceneLinkKey=key;
      const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('#scene-links').setAttribute('viewBox','0 0 '+bounds.width+' '+bounds.height);
      $('#scene-links').innerHTML='<defs><filter id="scene-glow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="3"/></filter></defs>'+curves.map((c,index)=>{const bend=(c.toX-c.x)*.5;const d='M'+c.x+','+c.y+' C'+(c.x+bend)+','+c.y+' '+(c.toX-bend)+','+c.toY+' '+c.toX+','+c.toY;return (c.active?'<path d="'+d+'" fill="none" stroke="#13d9f3" stroke-width="4" opacity=".2" filter="url(#scene-glow)"/>':'')+'<path id="scene-flow-'+index+'" d="'+d+'" fill="none" stroke="'+(c.active?'#23def5':'#294653')+'" stroke-opacity="'+(c.active?'1':'.5')+'" stroke-width="'+(c.active?'1.3':'1')+'"/>'+(c.active&&!reduced?[0,1,2].map(n=>'<circle class="scene-particle" r="'+(n===1?3:2)+'" fill="#9cf8ff" style="filter:drop-shadow(0 0 5px #37e9ff)"><animateMotion dur="3s" begin="-'+n+'s" repeatCount="indefinite" path="'+d+'"/></circle>').join(''):'')+'<circle cx="'+c.toX+'" cy="'+c.toY+'" r="'+(c.active?4:2.5)+'" fill="'+(c.active?'#45e5f3':'#34505e')+'"/>';}).join('');
    }
    const sceneOriginalPresence=renderPresence;renderPresence=function(){sceneOriginalPresence();renderScene();};
    const sceneOriginalActivity=renderActivity;renderActivity=function(){sceneOriginalActivity();renderScene();};
    $('#scene-memory-machine').addEventListener('change',()=>{sceneMemoryNode=$('#scene-memory-machine').value;renderScene();});
    $('#scene-follow').addEventListener('change',()=>{sceneFollowing=$('#scene-follow').checked;sceneMachineKey='';renderScene();});
    $('#scene-diagnostic').addEventListener('click',()=>{const detail=$('.topology');detail.hidden=!detail.hidden;if(!detail.hidden)detail.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});});
    document.addEventListener('click',event=>{const kind=event.target.closest('[data-scene-kind]');if(kind){$('#presence-kind').value=kind.dataset.sceneKind;document.querySelectorAll('[data-scene-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b===kind)));renderPresenceModels();}if(event.target.closest('[data-scene-all]'))presenceSetView('models');const selected=event.target.closest('[data-presence-model]');if(selected){sceneModelKey='';sceneMachineKey='';renderPresenceModels();renderScene();}});
    $('#scene-machines').addEventListener('scroll',()=>{sceneLinkKey='';requestAnimationFrame(sceneDrawLinks);});
    window.addEventListener('resize',()=>{sceneLinkKey='';requestAnimationFrame(sceneDrawLinks);});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){sceneLinkKey='';renderScene();}});
    presenceSetView(location.hash.slice(1));
`;
