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
  .scene-memory-panel {position:relative;z-index:6;background:linear-gradient(150deg,#0a1a2299,#060d12d8);padding:22px 24px 20px}
  .scene-memory-panel h3 {display:flex;justify-content:space-between;gap:14px;font-size:15px;margin:0 0 6px;align-items:baseline;flex-wrap:wrap}
  .scene-memory-panel h3 small {font-size:11px;color:#7d99ac;font-weight:400}
  .scene-memory-panel select {width:auto;max-width:190px;font-size:11px;padding:5px 8px;background:#0a161e}
  .scene-mem-sub {font-size:11.5px;color:#8ea9bb;margin:0 0 16px;line-height:1.5;max-width:66ch}
  .scene-mem-head {display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 14px}
  .scene-mem-total {display:flex;align-items:baseline;gap:9px;font-size:26px;font-weight:600;letter-spacing:-.6px;line-height:1}
  .scene-mem-total span {font-size:12px;font-weight:400;color:#7f9cb0;letter-spacing:0;display:block;line-height:1.15}
  .scene-mem-total em {font-style:normal;font-size:13px;color:#9fc4d6;font-weight:400}
  .scene-mem-readouts {display:flex;gap:18px;flex-wrap:wrap;justify-content:flex-end}
  .scene-mem-readout {text-align:right;min-width:86px}
  .scene-mem-readout b {display:block;font-size:15px;font-weight:600;letter-spacing:-.2px;line-height:1.15}
  .scene-mem-readout span {font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:#6f8b9e}
  .scene-mem-readout.used b {color:#e6f4fa}
  .scene-mem-readout.free b {color:#5fe6d0}
  .scene-mem-readout span.scene-mem-dot {display:inline-flex;align-items:center;gap:6px}
  .scene-mem-readout span.scene-mem-dot::before {content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
  .scene-mem-readout.free span.scene-mem-dot {color:#4fd8c4}
  .scene-mem-readout.used span.scene-mem-dot {color:#8fb2c5}
  .scene-mem-instrument {position:relative;border:1px solid #1f3a47;border-radius:12px;background:linear-gradient(180deg,#08131a,#060e13);overflow:hidden;isolation:isolate}
  .scene-mem-ruler {position:relative;height:20px;border-bottom:1px solid #16303d}
  .scene-mem-ticks {position:absolute;inset:0;display:flex;pointer-events:none}
  .scene-mem-tick {flex:1 0 0;min-width:0;border-left:1px solid #16303d;position:relative}
  .scene-mem-tick span {position:absolute;left:6px;top:5px;font-size:9px;color:#5d7c8e;white-space:nowrap}
  .scene-mem-grid {position:absolute;inset:20px 0 0;pointer-events:none;display:flex;opacity:.5}
  .scene-mem-grid i {flex:1 0 0;min-width:0;border-left:1px solid #11eaf50a}
  .scene-mem-bar {position:relative;display:flex;height:142px;cursor:default;margin-top:2px}
  .scene-mem-bar[data-known="false"] {height:70px}
  .scene-mem-block {position:relative;flex:0 0 auto;min-width:0;border:0;padding:0;margin:0;background:transparent;color:#dceaf2;font:inherit;text-align:left;overflow:hidden;cursor:pointer;transition:filter .22s ease,opacity .22s ease}
  .scene-mem-block > .scene-mem-fill {position:absolute;inset:0;background:var(--seg-fill);opacity:.9;transition:opacity .22s ease,box-shadow .22s ease}
  .scene-mem-block > .scene-mem-rim {position:absolute;inset:0;border-right:1px solid #04121a99;background:linear-gradient(180deg,#ffffff14,#ffffff00 42%,#00000038)}
  .scene-mem-block > .scene-mem-face {position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;height:100%;padding:11px 12px;gap:6px}
  .scene-mem-block em {font-style:normal;font-size:10px;letter-spacing:.5px;color:#eaf7fc;text-shadow:0 1px 3px #04121ad9;white-space:nowrap}
  .scene-mem-block em i {font-style:normal;opacity:.72;margin-left:5px;font-size:9px}
  .scene-mem-block b {font-size:15px;font-weight:600;letter-spacing:-.2px;text-shadow:0 1px 3px #04121ad9;white-space:nowrap}
  .scene-mem-block.wide > .scene-mem-face {padding:11px 14px}
  .scene-mem-block.narrow em,.scene-mem-block.narrow b {display:none}
  .scene-mem-block[data-kind="available"] {color:#eafffb}
  .scene-mem-block[data-kind="available"] > .scene-mem-rim {background:linear-gradient(180deg,#ffffff1f,#ffffff00 40%,#0000001f)}
  .scene-mem-block.system > .scene-mem-fill {background-image:repeating-linear-gradient(135deg,#ffffff10 0 7px,#ffffff00 7px 14px)}
  .scene-mem-block[data-estimated="true"] > .scene-mem-fill {opacity:.72;background-image:repeating-linear-gradient(115deg,#ffffff12 0 6px,#ffffff00 6px 13px)}
  .scene-mem-block:hover > .scene-mem-fill,.scene-mem-block[data-preview="true"] > .scene-mem-fill {opacity:1;box-shadow:inset 0 0 30px #ffffff1f}
  .scene-mem-block[data-selected="true"] > .scene-mem-rim {box-shadow:inset 0 0 0 1px #ffffff4d}
  .scene-mem-block:focus-visible {outline:2px solid #6ff0ff;outline-offset:-2px}
  .scene-mem-ghost {position:absolute;top:0;bottom:0;left:0;width:0;pointer-events:none;transition:width .34s cubic-bezier(.22,1,.36,1),left .34s cubic-bezier(.22,1,.36,1)}
  .scene-mem-ghost > .scene-mem-ghost-fill {position:absolute;inset:0;border:1px dashed #7ce8ffd9;border-left:0;border-radius:0 8px 8px 0;background:repeating-linear-gradient(115deg,#7ce8ff2e 0 6px,#7ce8ff0d 6px 12px);box-shadow:0 0 22px #23dcf61f,inset 0 0 24px #23dcf614}
  .scene-mem-ghost[data-overflow="true"] > .scene-mem-ghost-fill {border-color:#ffb487ee;background:repeating-linear-gradient(115deg,#ff9d6a3a 0 6px,#ff9d6a12 6px 12px);box-shadow:0 0 22px #ff9d6a26}
  .scene-mem-ghost[data-mode="resident"] > .scene-mem-ghost-fill,.scene-mem-ghost[data-mode="external"] > .scene-mem-ghost-fill {border-style:solid;border-color:#7ce8ff77;background:#7ce8ff14}
  .scene-mem-ghost-label {position:absolute;right:8px;bottom:8px;font-size:10px;color:#bdf1ff;background:#062028e0;border:1px solid #2a6273;border-radius:7px;padding:4px 8px;white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px #0006}
  .scene-mem-ghost[data-overflow="true"] .scene-mem-ghost-label {color:#ffd6bd;border-color:#9b5a39;background:#2a140ce8}
  .scene-mem-overflow {position:absolute;inset:0;z-index:3;pointer-events:none;opacity:0;transition:opacity .25s ease;background:repeating-linear-gradient(135deg,#ff9d6a1c 0 8px,#ff9d6a00 8px 16px)}
  .scene-mem-overflow[data-on="true"] {opacity:1}
  .scene-mem-overflow b {position:absolute;right:8px;top:8px;font-size:10px;font-weight:500;color:#ffd0b4;background:#2a120ae0;border:1px solid #9b5a39;border-radius:7px;padding:4px 8px;white-space:nowrap}
  .scene-mem-overlay {position:absolute;top:0;bottom:0;pointer-events:none;border-left:1px dashed #48e9c7aa;background:linear-gradient(90deg,#48e9c729,#48e9c700 75%);transition:opacity .22s ease}
  .scene-mem-overlay b {position:absolute;left:7px;top:8px;font-size:9px;letter-spacing:.5px;color:#8bf0da;white-space:nowrap;text-shadow:0 1px 3px #04121ad9}
  .scene-mem-reserve {position:absolute;top:0;bottom:0;left:auto;right:0;pointer-events:none}
  .scene-mem-reserve::before {content:"";position:absolute;top:0;bottom:0;left:0;width:1px;background:linear-gradient(180deg,#ffd79a00,#ffd79acc 18%,#ffd79acc 82%,#ffd79a00)}
  .scene-mem-reserve b {position:absolute;left:0;bottom:6px;font-size:9px;letter-spacing:.5px;color:#e7bd82;white-space:nowrap;transform:translateX(-100%) translateX(-6px);text-shadow:0 1px 3px #04121ad9}
  .scene-mem-bar[data-mode="external"] .scene-mem-overlay,.scene-mem-bar[data-mode="unknown"] .scene-mem-overlay {background:linear-gradient(90deg,#8fa8b833,#8fa8b800 75%);border-left-color:#9fb6c4aa}
  .scene-mem-forecast {margin:13px 0 0;font-size:12px;line-height:1.55;color:#a9c3d3;display:flex;gap:9px;align-items:flex-start}
  .scene-mem-forecast .scene-mem-forecast-icon {flex-shrink:0;width:8px;height:8px;margin-top:5px;border-radius:50%;background:#7f9aab}
  .scene-mem-forecast[data-status="fits"] .scene-mem-forecast-icon {background:#3fe3cf;box-shadow:0 0 10px #3fe3cf7a}
  .scene-mem-forecast[data-status="tight"] .scene-mem-forecast-icon {background:#f5c86a;box-shadow:0 0 10px #f5c86a7a}
  .scene-mem-forecast[data-status="blocked"] .scene-mem-forecast-icon {background:#ff9d6a;box-shadow:0 0 10px #ff9d6a7a}
  .scene-mem-forecast[data-status="resident"] .scene-mem-forecast-icon {background:#4fe0f2;box-shadow:0 0 10px #4fe0f27a}
  .scene-mem-forecast[data-status="external"] .scene-mem-forecast-icon,.scene-mem-forecast[data-status="other-node"] .scene-mem-forecast-icon {background:#9db7c7}
  .scene-mem-forecast strong {color:#eaf6fb;font-weight:500}
  .scene-mem-forecast p {margin:0;flex:1}
  .scene-mem-forecast .scene-mem-hint {color:#7d99ac;font-size:11px;margin-top:4px;display:block}
  .scene-mem-legend {display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:6px;margin:15px 0 0}
  .scene-mem-key {display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 11px;border:1px solid #1c333f;border-radius:10px;background:#0a151c;color:#d3e4ee;font:inherit;font-size:12px;min-height:38px;transition:border-color .2s ease,background .2s ease,box-shadow .2s ease}
  .scene-mem-key:hover {border-color:#2c6072;background:#0d1d26}
  .scene-mem-key[data-selected="true"] {border-color:#3ed4ea;box-shadow:0 0 0 1px #28b9d126,0 6px 20px #0ad0f014}
  .scene-mem-key[data-preview="true"] {border-color:#2e7f92;background:#0e222c}
  .scene-mem-key:focus-visible {outline:2px solid #6ff0ff;outline-offset:2px}
  .scene-mem-swatch {width:12px;height:12px;border-radius:4px;flex-shrink:0;background:var(--seg-fill);box-shadow:0 0 0 1px #ffffff1a}
  .scene-mem-key-name {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .scene-mem-key-size {font-size:11px;color:#9db9c9;white-space:nowrap}
  .scene-mem-key[data-estimated="true"] .scene-mem-key-size::after {content:" est.";color:#7d99ac}
  .scene-mem-key em {font-style:normal;font-size:10px;color:#7d99ac;letter-spacing:.4px}
  .scene-mem-rel {font-size:10px;color:#7d99ac;padding:4px 7px;border:1px solid #24404d;border-radius:7px;white-space:nowrap}
  .scene-mem-key[data-preview="true"] .scene-mem-rel {color:#8bf0da;border-color:#2b6f7d}
  .scene-mem-note {font-size:11px;color:#7d99ac;line-height:1.6;margin:13px 0 0;display:flex;gap:9px;flex-wrap:wrap;align-items:center}
  .scene-mem-note span.scene-mem-chip {display:inline-flex;align-items:center;gap:6px;border:1px solid #1f3a47;border-radius:20px;padding:4px 10px;background:#08131a}
  .scene-mem-note span.scene-mem-chip::before {content:"";width:8px;height:8px;border-radius:3px;background:#3d5b6b}
  .scene-mem-note span.scene-mem-chip.measured::before {background:#2ec9e0}
  .scene-mem-note span.scene-mem-chip.estimated::before {background:repeating-linear-gradient(115deg,#f3c268 0 3px,#f3c26800 3px 6px)}
  .scene-mem-empty {padding:22px;font-size:12px;color:#93aebe;line-height:1.6}
  @keyframes sceneMemBreathe {0%,100%{opacity:.7}50%{opacity:1}}
  .scene-mem-bar[data-preview="true"] .scene-mem-ghost > .scene-mem-ghost-fill {animation:sceneMemBreathe 2.6s ease-in-out infinite}
  .scene-mem-sticky {position:sticky;top:12px;align-self:start;margin-bottom:16px}
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
  @media(max-width:680px) {.presence-brand{display:none}.presence-nav{padding:8px}.presence-nav button[aria-current]::before{left:12px;right:12px;top:auto;bottom:0;width:auto;height:2px}body > header{display:none}main{padding-top:22px}.presence-heading h2{font-size:29px}.scene-columns{grid-template-columns:1fr 1fr;gap:18px;padding:20px;min-height:0}.scene-gateway-column{grid-column:2;grid-row:1}.scene-client-column{grid-column:1;grid-row:1}.scene-machine-column{grid-column:1/-1}.scene-gateway-wrap{min-height:210px;padding:30px 0 0}.scene-clients{padding:25px 0;gap:12px}.scene-diagram{min-height:0}.scene-machines{padding-top:16px}.scene-analytics{grid-template-columns:1fr;gap:22px}.scene-chart + .scene-chart{border-left:0;border-top:1px solid #20323e;padding:20px 0 0}.scene-chart svg{height:74px}.scene-model-row{grid-template-columns:34px minmax(0,1fr) auto;padding:15px 12px;gap:10px}.scene-model-row .scene-row-policy{display:none}.scene-row-status{font-size:10px}.scene-memory-panel{padding:17px 15px 15px}.scene-mem-sticky{position:static}.scene-mem-bar{height:112px}.scene-mem-bar[data-known="false"]{height:60px}.scene-mem-legend{grid-template-columns:1fr}.scene-mem-readouts{gap:14px}.scene-mem-total{font-size:23px}.scene-mem-readout{min-width:72px}.scene-add-capability{padding:18px;flex-wrap:wrap}.scene-add-capability button{width:100%;margin:0}.scene-network{padding:25px 18px;justify-content:flex-start}.scene-machine-list .presence-card{grid-template-columns:40px 1fr;gap:14px;padding:18px}.scene-machine-list .presence-card .actions{grid-column:1/-1}.scene-machine-list .presence-card .machine-memory{grid-column:1/-1;grid-row:auto}.scene-links{opacity:.85}.scene-model-name{font-size:12px}.scene-model-state{font-size:10px}}
  @media(max-width:1050px){.scene-detail:has(.model-inspector.open){position:fixed;z-index:80;left:12px;right:12px;bottom:12px;height:auto;max-height:calc(100dvh - 96px);background:linear-gradient(145deg,#122530,#09141c);box-shadow:0 -20px 70px #0009,0 0 0 1px #42616b66;padding:22px}.scene-detail:has(.model-inspector.open) .model-inspector-header{position:sticky;top:-22px;margin-top:-22px;padding-top:22px;background:#10212b;z-index:1}}
  @media(prefers-reduced-motion:reduce){.scene-gateway{animation:none!important}.scene-links .scene-particle{display:none}.scene-model{transition:none}}
  .scene-memory-panel {padding:18px 20px;margin-bottom:20px;background:#0b151d}
  .scene-memory-panel h3 {margin-bottom:14px}.scene-memory-panel h3 small{display:block;color:#67dbe7;margin-top:5px}.scene-memory-panel h3 small[hidden]{display:none}
  .scene-mem-head {margin-bottom:12px}.scene-mem-total {font-size:22px}.scene-mem-total b {font-weight:500}
  .scene-mem-bar {height:76px}.scene-mem-block {border-radius:0;transition:width .38s cubic-bezier(.22,1,.36,1),filter .2s,opacity .2s}
  .scene-mem-face em {max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:10px}
  .scene-mem-legend {grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:5px;margin-top:10px}
  .scene-mem-key {padding:7px 9px;font-size:11px;min-height:44px;gap:7px}.scene-mem-key-size {font-size:10px}
  .scene-mem-note {font-size:10px;margin:9px 0 0}.scene-mem-forecast {margin-top:10px;min-height:36px;font-size:12px}
  .scene-mem-ruler {overflow:hidden}.scene-mem-tick {position:absolute;top:0;bottom:0;width:0}.scene-mem-tick:last-child span {left:auto;right:5px}
  .scene-mem-reserve {right:0;background:repeating-linear-gradient(120deg,#edbe6c0d 0 5px,transparent 5px 10px)}
  .scene-mem-reserve b {transform:none;left:6px;bottom:6px;font-size:8px;white-space:normal;line-height:1.2}
  .scene-mem-ghost {z-index:3}.scene-mem-reserve {z-index:4}
  .scene-model-row[data-preview="true"],.scene-model[data-preview="true"] {border-color:#53cada;box-shadow:inset 0 0 25px #36d9e507,0 0 20px #31b6ce0b}
  .scene-row-footprint {color:#7dbbc8;font-size:11px;white-space:nowrap}
  @media(min-width:1051px){.scene-memory-panel{position:sticky;top:12px;z-index:7}#scene-model-detail{align-self:start;position:sticky;top:12px;max-height:calc(100dvh - 24px);height:auto;min-height:440px}.scene-model-row{scroll-margin-top:390px}}
  @media(max-width:680px){.scene-memory-panel{padding:16px 12px}.scene-mem-bar{height:64px}.scene-mem-legend{grid-template-columns:repeat(2,minmax(0,1fr))}.scene-mem-key{min-width:0}.scene-mem-head{gap:8px}.scene-mem-readouts{gap:10px}.scene-mem-total{font-size:20px}.scene-mem-forecast{font-size:11px}.scene-mem-reserve b{font-size:7px}.scene-mem-block.compact .scene-mem-face{display:none}.scene-row-footprint{display:block;margin-top:4px}}
  @media(prefers-reduced-motion:reduce){.scene-mem-block,.scene-mem-ghost{transition:none!important}.scene-mem-ghost-fill{animation:none!important}}

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
    scene.innerHTML='<div class="scene-layout"><div class="scene-diagram"><svg id="scene-links" class="scene-links" aria-hidden="true"></svg><div class="scene-columns"><div class="scene-column scene-client-column"><h3>Clients</h3><p id="scene-client-count">Waiting for telemetry</p><div id="scene-clients" class="scene-clients"></div></div><div class="scene-column scene-gateway-column"><h3>LLooM Gateway</h3><p>Routes and balances</p><div class="scene-gateway-wrap"><div id="scene-gateway" class="scene-gateway">'+sceneLogo+'</div><strong>Gateway</strong><small id="scene-active">Connecting…</small></div></div><div class="scene-column scene-machine-column"><h3>Models on your machines</h3><p id="scene-machine-count"></p><div id="scene-machines" class="scene-machines"></div></div></div></div><aside id="scene-live-detail" class="scene-detail"><div class="scene-placeholder">'+sceneIcon('model')+'<h3>Your AI, together.</h3><p>Choose a model to try it or connect an app.</p></div></aside></div><div class="scene-analytics"><div class="scene-chart"><h3>Requests <span id="scene-requests-label"></span></h3><svg id="scene-request-chart" aria-label="Observed active requests over this session"></svg><div class="scene-chart-caption">Observed during this session</div></div><div class="scene-chart"><h3>Response time <span id="scene-latency-label"></span></h3><svg id="scene-latency-chart" aria-label="Observed completed request durations"></svg><div class="scene-chart-caption">Recent completed requests · includes generation time</div></div><div class="scene-chart"><h3>Machine memory <span>Used / total</span></h3><div id="scene-memory-list"></div></div></div><div class="scene-tools"><span id="scene-health">Waiting for gateway telemetry</span><div class="actions"><label class="scene-follow"><input type="checkbox" id="scene-follow">Follow activity</label><button type="button" id="scene-diagnostic">Detailed topology</button></div></div>';
    $('.topology').before(scene);
    $('.topology').dataset.presencePanel='diagnostic';$('.topology').hidden=true;
    const modelLeft=document.createElement('div');modelLeft.className='scene-model-main';
    const modelLayout=document.createElement('div');modelLayout.className='scene-model-layout';$('#view-models').append(modelLayout);modelLayout.append(modelLeft);
    const memoryPanel=document.createElement('section');memoryPanel.className='scene-memory-panel';memoryPanel.innerHTML='<h3><span>Room for your AI <small id="scene-memory-context" hidden></small></span><select id="scene-memory-machine" aria-label="Memory by machine"></select></h3><div id="scene-memory-bar"></div><div id="scene-memory-forecast" class="scene-mem-forecast" role="status"><span class="scene-mem-forecast-icon" aria-hidden="true"></span><p>Point to a model to preview its memory.</p></div>';
    modelLeft.append(memoryPanel);
    const modelTabs=document.createElement('div');modelTabs.className='scene-model-tabs';modelTabs.innerHTML='<strong>Installed</strong><button type="button" data-add-model>Discover</button>';
    modelLeft.append(modelTabs,$('.presence-toolbar'));
    const chips=document.createElement('div');chips.className='scene-chips';chips.innerHTML=[['','All'],['chat','Chat & code'],['image','Images'],['audio','Voice'],['embedding','Search'],['video','Video']].map(([id,name])=>'<button type="button" data-scene-kind="'+id+'" aria-pressed="'+String(!id)+'">'+name+'</button>').join('');
    modelLeft.append(chips,$('#presence-models'));$('#presence-models').className='scene-model-list';$('#presence-kind').hidden=true;
    const capability=document.createElement('div');capability.className='scene-add-capability';capability.innerHTML=sceneIcon('plus')+'<div><strong>Add a capability</strong><p>Get more done with another model.</p></div><button class="primary" type="button" data-add-model>Find a model</button>';modelLeft.append(capability);
    const modelDetail=document.createElement('aside');modelDetail.id='scene-model-detail';modelDetail.className='scene-detail';modelDetail.innerHTML='<div class="scene-placeholder">'+sceneIcon('model')+'<h3>Ready when you are.</h3><p>Choose a model to try it or connect an app. LLooM takes care of getting it ready.</p></div>';
    modelLayout.append(modelLeft,modelDetail);$('#view-models').append(modelLayout);
    const network=document.createElement('div');network.id='scene-network';network.className='scene-network';$('#presence-machines').before(network);$('#presence-machines').className='scene-machine-list';
    const inspectorMemory=document.createElement('div');inspectorMemory.className='scene-inspector-memory';inspectorMemory.id='scene-inspector-memory';$('#presence-availability').after(inspectorMemory);
    let sceneClientKey='',sceneMachineKey='',sceneModelKey='',sceneNodeKey='',sceneLinkKey='',sceneSamples=[],sceneSampleAt=0;
    let sceneMemoryNode=null,sceneFollowing=false;
    let sceneMemPointer=null,sceneMemFocus=null,sceneMemShape='',sceneMemPaint=false;
    const sceneMemColors=['#25bbd8','#53d5b6','#709eec','#a58ceb','#e1b176','#dc93bd','#79c5ce','#a0bb78'];
    function sceneMemColor(segment){return segment.kind==='system'?'#304955':segment.kind==='available'?'#123337':sceneMemColors[Math.abs(segment.colorIndex||0)%sceneMemColors.length];}
    function sceneMemModelNode(id){
      const model=(state.physicalModels||[]).find(m=>m.id===id),rt=model&&presenceRuntime(model);
      if(!model?.runtime)return model?.targets?.find(target=>target.node)?.node||null;
      return rt?.node||rt?.placement?.node||(!rt?.remote?sceneNodes().find(n=>n.local)?.id:null);
    }
    function sceneMemSnapshot(id=sceneMemPointer||sceneMemFocus||state.selectedModelId,ownNode=false){
      const nodes=sceneNodes(),follow=sceneMemPointer||sceneMemFocus;
      const target=ownNode?sceneMemModelNode(id):follow&&sceneMemModelNode(follow);
      const node=nodes.find(n=>n.id===(target||sceneMemoryNode))||nodes.find(n=>n.local)||nodes[0];
      return buildMemoryMap({node,runtimes:state.status?.runtimeManager?.runtimes||{},models:state.physicalModels||[],previewModelId:id,memorySafety:state.status?.runtimeManager?.memorySafety});
    }
    function sceneMemFormat(value){return typeof value==='number'&&Number.isFinite(value)?formatBytes(Math.max(0,value)):'—';}
    function sceneMemText(memory){
      const p=memory.preview;
      if(!p)return 'Point to a model to see where it would fit. Nothing starts until you use it.';
      const status={fits:'Expected to fit',tight:'Little room to spare',blocked:'Needs more room',resident:'Already available',external:'Runs elsewhere','other-node':'Runs on another machine',unknown:'Footprint not yet known',paused:'Paused'}[p.status]||'Checking room';
      const delta=p.additionalBytes>0?' · about '+sceneMemFormat(p.additionalBytes)+' more':'';
      const remaining=p.additionalBytes>0&&p.remainingBytes!=null?' · '+(p.remainingBytes<0?sceneMemFormat(-p.remainingBytes)+' over capacity':sceneMemFormat(p.remainingBytes)+' available after'):'';
      return p.label+' · '+status+delta+remaining;
    }
    function sceneMemSchedule(){if(sceneMemPaint)return;sceneMemPaint=true;requestAnimationFrame(()=>{sceneMemPaint=false;sceneMemRender();});}
    function sceneMemRender(){
      const host=$('#scene-memory-bar');if(!host||typeof buildMemoryMap!=='function')return;
      const memory=sceneMemSnapshot(),segments=memory.segments||[],p=memory.preview;
      const select=$('#scene-memory-machine'),nodes=sceneNodes(),base=sceneMemoryNode||nodes.find(n=>n.local)?.id||nodes[0]?.id; if(base)select.value=base;const context=$('#scene-memory-context');context.hidden=memory.nodeId===base;context.textContent=context.hidden?'':'Preview · '+sceneNodeName(nodes.find(n=>n.id===memory.nodeId)||{id:memory.nodeId});
      const shape=JSON.stringify([memory.nodeId,memory.known,segments.map(s=>[s.id,s.kind,s.modelIds])]);
      if(shape!==sceneMemShape){
        const focused=host.contains(document.activeElement)?document.activeElement.dataset.memoryFocus:null;
        sceneMemShape=shape;
        host.innerHTML=memory.known?'<div class="scene-mem-head"><div class="scene-mem-total"><b id="scene-mem-total"></b><span>total memory</span></div><div class="scene-mem-readouts"><div class="scene-mem-readout used"><b id="scene-mem-used"></b><span>In use</span></div><div class="scene-mem-readout free"><b id="scene-mem-free"></b><span>Available</span></div></div></div><div class="scene-mem-instrument"><div id="scene-mem-ruler" class="scene-mem-ruler"></div><div class="scene-mem-bar" id="scene-mem-track" role="group" aria-label="Memory blocks">'+segments.map((s,i)=>{const model=s.modelIds?.[0],tag=model?'button':'div';return '<'+tag+(model?' type="button" data-presence-model="'+escapeHtml(model)+'"':'')+' class="scene-mem-block" data-memory-index="'+i+'" data-memory-focus="block-'+i+'" data-kind="'+escapeHtml(s.kind)+'"><span class="scene-mem-fill"></span><span class="scene-mem-rim"></span><span class="scene-mem-face"><em></em><b></b></span></'+tag+'>';}).join('')+'<span id="scene-mem-ghost" class="scene-mem-ghost" hidden><span class="scene-mem-ghost-fill"></span></span><span id="scene-mem-reserve" class="scene-mem-reserve"><b>Protected headroom</b></span></div></div><div id="scene-mem-legend" class="scene-mem-legend">'+segments.map((s,i)=>{const model=s.modelIds?.[0],tag=model?'button':'div';return '<'+tag+(model?' type="button" data-presence-model="'+escapeHtml(model)+'"':'')+' class="scene-mem-key" data-memory-key="'+i+'" data-memory-focus="key-'+i+'"><span class="scene-mem-swatch"></span><span class="scene-mem-key-name"></span><span class="scene-mem-key-size"></span></'+tag+'>';}).join('')+'</div><p id="scene-mem-note" class="scene-mem-note"></p>':'<div class="scene-mem-empty">Waiting for a memory reading from this machine.</div>';
        if(focused)host.querySelector('[data-memory-focus="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
      }
      if(memory.known){
        $('#scene-mem-total').textContent=sceneMemFormat(memory.totalBytes);
        $('#scene-mem-used').textContent=sceneMemFormat(memory.usedBytes);
        $('#scene-mem-free').textContent=sceneMemFormat(memory.availableBytes);
        const ruler=$('#scene-mem-ruler'),rulerKey=String(memory.totalBytes);
        if(ruler.dataset.total!==rulerKey){ruler.dataset.total=rulerKey;ruler.innerHTML=Array.from({length:5},(_,i)=>'<span class="scene-mem-tick" style="left:'+i*25+'%"><span>'+escapeHtml(sceneMemFormat(memory.totalBytes*i/4))+'</span></span>').join('');}
        for(const [i,s] of segments.entries()){
          const block=host.querySelector('[data-memory-index="'+i+'"]'),key=host.querySelector('[data-memory-key="'+i+'"]');
          const isPreview=Boolean(p&&s.modelIds?.includes(p.modelId)),selected=Boolean(state.selectedModelId&&s.modelIds?.includes(state.selectedModelId));
          for(const el of [block,key]){el.style.setProperty('--seg-fill',sceneMemColor(s));el.dataset.estimated=String(Boolean(s.estimated));el.dataset.selected=String(selected);el.dataset.preview=String(isPreview);el.setAttribute('aria-label',s.label+', '+sceneMemFormat(s.bytes)+(s.estimated?', approximate':''));el.title=s.label+' · '+sceneMemFormat(s.bytes)+(s.estimated?' (estimate)':'');}
          block.style.width=Math.max(0,Math.min(100,s.percent||0))+'%';block.classList.toggle('narrow',s.percent<10);block.classList.toggle('compact',s.percent<20);
          block.querySelector('em').textContent=s.label;block.querySelector('b').textContent=sceneMemFormat(s.bytes);
          key.querySelector('.scene-mem-key-name').textContent=s.label;key.querySelector('.scene-mem-key-size').textContent=sceneMemFormat(s.bytes);
        }
        const ghost=$('#scene-mem-ghost'),delta=p?.additionalBytes;
        ghost.hidden=!(delta>0);ghost.style.left=memory.usedBytes/memory.totalBytes*100+'%';ghost.style.width=Math.max(0,Math.min(delta||0,memory.availableBytes))/memory.totalBytes*100+'%';ghost.dataset.overflow=String(p?.status==='blocked');
        $('#scene-mem-track').dataset.preview=String(Boolean(p));
        const reserve=$('#scene-mem-reserve');reserve.hidden=!(memory.reserveBytes>0);reserve.style.width=memory.reserveBytes/memory.totalBytes*100+'%';reserve.title=sceneMemFormat(memory.reserveBytes)+' protected for your machine';reserve.querySelector('b').textContent=sceneMemFormat(memory.reserveBytes)+' reserved';
        $('#scene-mem-note').textContent=memory.attributionNote||'Live memory use. Hover previews are estimates.';
      }
      const forecast=$('#scene-memory-forecast');forecast.dataset.status=p?.status||'idle';const forecastText=memory.known?sceneMemText(memory):'Memory is not available yet. LLooM will check before preparing a model.';if(forecast.querySelector('p').textContent!==forecastText)forecast.querySelector('p').textContent=forecastText;
      for(const el of document.querySelectorAll('.scene-model-row,.scene-model'))el.dataset.preview=String(el.dataset.presenceModel===p?.modelId);
      if(state.selectedModelId){const own=sceneMemSnapshot(state.selectedModelId,true).preview;$('#scene-inspector-memory').innerHTML='<span>'+(own?.additionalBytes>0?'Expected extra memory':'Memory')+'</span><strong>'+escapeHtml(own?.additionalBytes>0?'About '+sceneMemFormat(own.additionalBytes):own?.status==='resident'?'Already available':own?.status==='external'?'Runs elsewhere':'Checked when needed')+'</strong>';}
    }
    const sceneMemTarget=target=>target?.closest?.('[data-presence-model]')?.dataset.presenceModel||null;
    document.addEventListener('pointerover',event=>{if(event.pointerType==='touch')return;const id=sceneMemTarget(event.target);if(id&&id!==sceneMemPointer){sceneMemPointer=id;sceneMemSchedule();}});
    document.addEventListener('pointerout',event=>{if(event.pointerType==='touch')return;if(sceneMemTarget(event.target)&&sceneMemTarget(event.relatedTarget)!==sceneMemPointer){sceneMemPointer=sceneMemTarget(event.relatedTarget);sceneMemSchedule();}});
    document.addEventListener('focusin',event=>{const id=sceneMemTarget(event.target);if(id)sceneMemPointer=null;if(id!==sceneMemFocus){sceneMemFocus=id;sceneMemSchedule();}});
    document.addEventListener('focusout',event=>{sceneMemFocus=sceneMemTarget(event.relatedTarget);sceneMemSchedule();});
    function sceneMoveInspector(){
      const slot=presenceView==='models'?modelDetail:$('#scene-live-detail');
      if($('#model-inspector').parentElement!==slot)slot.append($('#model-inspector'));
      document.querySelectorAll('.scene-placeholder').forEach(item=>item.hidden=Boolean(state.selectedModelId)&&item.parentElement===slot);
      if(state.selectedModelId){const model=state.physicalModels.find(m=>m.id===state.selectedModelId),rt=model&&presenceRuntime(model);inspectorMemory.innerHTML='<span>Memory estimate</span><strong>'+(rt?.memoryGb!=null?escapeHtml(rt.memoryGb)+' GB':'Not reported')+'</strong>';}
    }
    const scenePreviousView=presenceSetView;
    presenceSetView=function(name){sceneMemPointer=null;sceneMemFocus=null;scenePreviousView(name);sceneMoveInspector();renderScene();};
    const scenePreviousInspector=renderModelInspector;
    renderModelInspector=function(){scenePreviousInspector();sceneMoveInspector();sceneMemSchedule();};
    renderPresenceModels=function(){
      const search=$('#presence-search').value.trim().toLowerCase(),kind=$('#presence-kind').value;
      const models=(state.physicalModels||[]).filter(m=>(!search||(m.name+' '+m.id).toLowerCase().includes(search))&&(!kind||(m.kind||'chat').startsWith(kind))).sort((a,b)=>Number(Boolean(b.runtime))-Number(Boolean(a.runtime))||Number(Boolean(presenceRuntime(b)?.healthy))-Number(Boolean(presenceRuntime(a)?.healthy)));
      $('#presence-model-count').textContent=models.length+(models.length===1?' model':' models');
      const key=JSON.stringify(models.map(m=>[m.id,m.name,sceneKind(m),presenceModelLabel(m),presencePolicy(presenceRuntime(m)),state.selectedModelId===m.id]));if(key===sceneModelKey)return;sceneModelKey=key;
      const catalog=$('#presence-models'),focused=catalog.contains(document.activeElement)?document.activeElement.closest('[data-presence-model]')?.dataset.presenceModel:null;
      $('#presence-models').innerHTML=models.map(model=>{const rt=presenceRuntime(model);return '<button type="button" class="scene-model-row" data-presence-model="'+escapeHtml(model.id)+'" data-selected="'+String(state.selectedModelId===model.id)+'" data-ready="'+String(presenceModelResident(model)||Boolean(rt?.activeRequests))+'">'+sceneIcon(sceneModelIcon(model))+'<div><h3>'+escapeHtml(model.name||model.id)+'</h3><p>'+escapeHtml(sceneKind(model))+'</p></div><span class="scene-row-status">'+escapeHtml(presenceModelLabel(model))+'</span><span class="scene-row-policy">'+escapeHtml(rt?presencePolicyNames[presencePolicy(rt)]:'Upstream')+'</span></button>';}).join('')||'<div class="empty">No models match. Choose another filter or add a model.</div>';
      if(focused)catalog.querySelector('[data-presence-model="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
      if(sceneMemPointer&&!models.some(m=>m.id===sceneMemPointer))sceneMemPointer=null;
      sceneMemSchedule();
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
      sceneMemRender();
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
    document.addEventListener('click',event=>{const kind=event.target.closest('[data-scene-kind]');if(kind){$('#presence-kind').value=kind.dataset.sceneKind;document.querySelectorAll('[data-scene-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b===kind)));renderPresenceModels();}if(event.target.closest('[data-scene-all]'))presenceSetView('models');const selected=event.target.closest('[data-presence-model]');if(selected){sceneMemoryNode=sceneMemModelNode(selected.dataset.presenceModel)||sceneMemoryNode;sceneModelKey='';sceneMachineKey='';renderPresenceModels();renderScene();}});
    $('#scene-machines').addEventListener('scroll',()=>{sceneLinkKey='';requestAnimationFrame(sceneDrawLinks);});
    window.addEventListener('resize',()=>{sceneLinkKey='';requestAnimationFrame(sceneDrawLinks);});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){sceneLinkKey='';renderScene();}});
    presenceSetView(location.hash.slice(1));
`;
