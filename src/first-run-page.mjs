/**
 * Self-contained first-run setup page.
 *
 * No CDN, no external fonts, no network UI dependencies: everything is inline
 * so the loopback setup server works offline. All dynamic content is inserted
 * with textContent (never innerHTML) and every stage/reason string is escaped
 * as data before it reaches the DOM.
 *
 * Visual design only: the markup carries no fake evidence. Decorative graphics
 * (chip, logo, lock, workload/check icons) are aria-hidden. Hardware name,
 * facts, model, sizes, and readiness all come from real dynamic data.
 */

export const PRESENCE_THEME = {
  background: '#050c10',
  surface: '#08141a',
  accent: '#21d8f3',
  danger: '#ff6b6b'
};

export function firstRunPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<title>LLooM first-run setup</title>
<style>
:root{
  --bg:#050c10; --panel:#08141a; --panel-2:#0a1a22; --border:#14313d; --border-soft:#0f2731;
  --accent:#21d8f3; --accent-soft:rgba(33,216,243,.12);
  --text:#e7f6fb; --muted:#7f98a6; --danger:#ff6b6b; --ok:#2ea043;
  --radius:16px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text);
  font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  min-height:100vh; padding:22px 20px 72px; -webkit-font-smoothing:antialiased;
}
.shell{max-width:1440px;margin:0 auto}
p{margin:0 0 10px}
a{color:var(--accent)}
code{background:#050a0e;padding:2px 6px;border-radius:5px;overflow-wrap:anywhere}

/* ---------- top bar ---------- */
.topbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:4px 4px 24px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{width:42px;height:42px;flex:none;filter:drop-shadow(0 0 10px rgba(33,216,243,.45))}
.logo svg{width:100%;height:100%;display:block}
.brand-text{display:flex;flex-direction:column;line-height:1.12;min-width:0}
.brand-text strong{font-size:17px;font-weight:600;letter-spacing:.01em}
.brand-text small{color:var(--muted);font-size:12px;letter-spacing:.05em}
.progress{display:flex;align-items:center;gap:10px;font-size:13px;letter-spacing:.02em}
.pstep{color:var(--muted);display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.pstep::before{content:'';width:7px;height:7px;border-radius:50%;background:#1d3b46;transition:background .25s,box-shadow .25s}
.pstep[data-active="true"]{color:var(--accent)}
.pstep[data-active="true"]::before{background:var(--accent);box-shadow:0 0 10px rgba(33,216,243,.85)}
.psep{width:20px;height:1px;background:linear-gradient(90deg,transparent,#1d3b46,transparent)}
.local{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);
  border:1px solid var(--border);border-radius:999px;padding:7px 14px;background:rgba(9,20,26,.55);white-space:nowrap}
.local svg{width:14px;height:14px;flex:none}

/* ---------- steps ---------- */
.step{display:none}
.step[data-active="true"]{display:block;animation:fade .35s ease}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* ---------- shared panels ---------- */
.card,.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
  padding:22px;margin-bottom:18px;min-width:0}
.panel-title{font-size:20px;font-weight:600;letter-spacing:-0.01em;margin:0 0 10px}

/* ---------- choose layout ---------- */
.choose-grid{display:grid;grid-template-columns:minmax(260px,300px) minmax(0,1fr);gap:30px;align-items:start}
.choose-main{min-width:0}
.hero{font-size:clamp(34px,4.4vw,54px);font-weight:600;letter-spacing:-0.035em;line-height:1.04;margin:2px 0 14px;max-width:16ch}
.hero.sm{font-size:clamp(27px,3.4vw,42px);max-width:26ch}
.hero-sub{color:var(--muted);font-size:16px;margin:0 0 26px;max-width:62ch}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---------- hardware panel ---------- */
.machine{min-height:620px;display:flex;flex-direction:column;padding:24px 22px;
  background:linear-gradient(180deg,rgba(10,26,34,.92),rgba(7,17,22,.92))}
.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:0 0 7px}
.machine-name{font-size:19px;font-weight:600;letter-spacing:-0.01em;margin:0 0 4px;overflow-wrap:anywhere}
.chip-wrap{display:flex;align-items:center;justify-content:center;margin:16px 0 22px;flex:1 1 auto;min-height:200px}
.chip{width:100%;max-width:200px;height:auto;overflow:visible}
.machine dl{display:grid;grid-template-columns:auto 1fr;gap:9px 16px;margin:0;font-size:13.5px}
.machine dt{color:var(--muted);white-space:nowrap}
.machine dd{margin:0;overflow-wrap:anywhere}

/* chip visualization (decorative) */
.ring{fill:none;stroke:rgba(33,216,243,.22);stroke-width:1;stroke-dasharray:2 7}
.ring-2{stroke:rgba(33,216,243,.15);stroke-dasharray:1 10}
.ring-3{stroke:rgba(33,216,243,.11)}
.pin{stroke:#15505f;stroke-width:2;stroke-linecap:round}
.body{fill:#08222b;stroke:#21d8f3;stroke-width:1.6;filter:drop-shadow(0 0 6px rgba(33,216,243,.55))}
.glyph{fill:none;stroke:#7fe9fb;stroke-width:1.4;opacity:.92}
.orbit{transform-box:fill-box;transform-origin:center;animation:chipSpin 26s linear infinite}
.orbit-rev{animation-duration:38s;animation-direction:reverse}
.orbit-dot{fill:var(--accent);filter:drop-shadow(0 0 6px rgba(33,216,243,.9))}
.scan{stroke:var(--accent);stroke-width:1.4;stroke-linecap:round;opacity:0;animation:chipScan 5s ease-in-out infinite}
@keyframes chipSpin{to{transform:rotate(360deg)}}
@keyframes chipScan{
  0%{transform:translateY(-30px);opacity:0}
  12%{opacity:.85}
  50%{opacity:.7}
  88%{opacity:.15}
  100%{transform:translateY(30px);opacity:0}
}

/* ---------- workload choices ---------- */
.choices{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:24px}
.choice{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:16px;
  min-height:170px;text-align:left;background:linear-gradient(180deg,rgba(12,26,34,.78),rgba(8,18,24,.78));
  color:inherit;border:1px solid var(--border);border-radius:14px;padding:20px 16px;cursor:pointer;font:inherit;
  transition:border-color .2s,transform .2s,background .2s,box-shadow .2s}
.choice:hover{border-color:#22505f;transform:translateY(-1px)}
.choice[aria-pressed="true"]{border-color:var(--accent);
  background:linear-gradient(180deg,rgba(16,42,52,.92),rgba(9,22,28,.92));
  box-shadow:0 0 0 1px rgba(33,216,243,.35),0 14px 34px -20px rgba(33,216,243,.75)}
.wk-icon{width:52px;height:52px;border-radius:13px;border:1px solid #1b3d4a;display:flex;align-items:center;
  justify-content:center;color:var(--accent);background:rgba(33,216,243,.05);transition:.2s}
.wk-icon svg{width:26px;height:26px;display:block}
.choice[aria-pressed="true"] .wk-icon{border-color:rgba(33,216,243,.6);background:rgba(33,216,243,.12);
  box-shadow:0 0 18px -6px rgba(33,216,243,.85)}
.reco h3{color:var(--text)}
.wk-body{display:flex;flex-direction:column;gap:5px;min-width:0}
.wk-body strong{font-size:17px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere}
.wk-desc{color:var(--muted);font-size:13.5px;display:block;overflow-wrap:anywhere}
.wk-check{position:absolute;right:12px;top:12px;width:22px;height:22px;border-radius:50%;border:1px solid #21404c;display:flex;align-items:center;
  justify-content:center;justify-self:end;color:transparent;transition:.2s}
.wk-check::after{content:'';width:11px;height:6px;border-left:1.8px solid currentColor;border-bottom:1.8px solid currentColor;
  transform:rotate(-45deg) translate(.5px,-1px)}
.choice[aria-pressed="true"] .wk-check{border-color:var(--accent);color:#04141a;background:var(--accent)}
.choice:focus-visible,button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* ---------- recommendation ---------- */
#recommendation{min-width:0}
.card.reco{border-color:rgba(33,216,243,.42);padding:26px 26px 22px;
  background:linear-gradient(180deg,rgba(9,26,34,.94),rgba(6,16,21,.94));
  box-shadow:0 26px 64px -44px rgba(33,216,243,.85)}
.reco-icon{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:11px;
  border:1px solid rgba(33,216,243,.45);background:rgba(33,216,243,.09);color:var(--accent);margin-bottom:14px}
.reco-icon svg{width:21px;height:21px;display:block}
.card.reco h3{font-size:23px;font-weight:600;letter-spacing:-0.015em;text-transform:none;margin:12px 0 8px}
.reco .mono{color:var(--muted)}
.badge{display:inline-flex;align-items:center;font-size:11.5px;border-radius:999px;padding:4px 11px;
  border:1px solid var(--border);color:var(--muted);margin:4px 6px 0 0;background:rgba(255,255,255,.02)}
.badge.ok{color:var(--accent);border-color:rgba(33,216,243,.5)}
.badge.warn{color:#ffd166;border-color:rgba(255,209,102,.35)}
.badge.bad{color:var(--danger);border-color:rgba(255,107,107,.45)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere}
h3{font-size:14px;margin:0 0 6px;letter-spacing:.02em;color:var(--muted)}
ul.plain{margin:0;padding-left:18px}
ul.plain li{margin-bottom:6px}

/* ---------- details / disclosures ---------- */
details{margin-top:16px}
summary{cursor:pointer;color:var(--accent);font-size:14px;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:'+ ';color:var(--accent);font-weight:600}
details[open] summary::before{content:'\\2013  '}

/* ---------- buttons ---------- */
.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:6px}
.actions.center{justify-content:center}
button{font:inherit;border-radius:11px;padding:13px 22px;cursor:pointer;border:1px solid var(--border);
  background:var(--panel-2);color:var(--text)}
button:hover:not(:disabled){border-color:#25515f}
button.primary{background:var(--accent);color:#031318;border-color:var(--accent);font-weight:600}
button.cta{font-size:16.5px;padding:16px 40px;border-radius:14px;box-shadow:0 14px 36px -16px rgba(33,216,243,.9)}
button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}

/* ---------- status ---------- */
.status{color:var(--muted);min-height:20px;margin:12px 0 0}
.status[data-kind="error"]{color:var(--danger)}
.status[data-kind="ok"]{color:var(--accent)}
.center-text{text-align:center;max-width:70ch;margin-left:auto;margin-right:auto}

/* ---------- stages / readiness ---------- */
.stages{list-style:none;margin:0;padding:0}
.stages li{display:flex;gap:14px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--border-soft);font-size:14.5px}
.stages li:last-child{border-bottom:0}
.stages .dot{width:10px;height:10px;border-radius:50%;background:#24404b;margin-top:6px;flex:none}
.stages li[data-state="active"] .dot{background:var(--accent);box-shadow:0 0 0 4px rgba(33,216,243,.15)}
.stages li[data-state="complete"] .dot{background:var(--ok)}
.stages li[data-state="failed"] .dot{background:var(--danger)}
.verify{font-weight:600;margin:0 0 6px}
.verify[data-state="verified"]{color:var(--accent)}
.verify[data-state="installed"]{color:#ffd166}
.verify[data-state="failed"]{color:var(--danger)}
footer{color:var(--muted);font-size:12px;margin-top:26px;text-align:center}

/* ---------- responsive ---------- */
@media (max-width:1000px){
  .choose-grid{grid-template-columns:minmax(210px,240px) minmax(0,1fr);gap:22px}
  .machine{min-height:0;padding:20px}
  .chip{max-width:168px}
}
@media (max-width:720px){
  body{padding:18px 14px 56px}
  .topbar{flex-wrap:wrap;gap:12px 16px}
  .progress{order:3;width:100%;font-size:12.5px}
  .choose-grid{grid-template-columns:1fr;gap:20px}
  .machine{min-height:0;flex-direction:row;flex-wrap:wrap;align-items:center;gap:14px 18px;padding:18px}
  .machine .eyebrow,.machine-name{width:100%;margin-bottom:0}
  .chip-wrap{flex:0 0 auto;width:132px;margin:0;min-height:0}
  .chip{max-width:132px}
  .machine dl{flex:1 1 200px;gap:6px 12px}
  .choices{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .choice{min-height:160px;padding:16px;gap:12px}
  .wk-icon{width:44px;height:44px}
  .wk-icon svg{width:22px;height:22px}
  .wk-check{display:none}
  .hero,.hero.sm{max-width:100%}
}
@media (max-width:520px){
  .hero{font-size:30px}
  .actions button{width:100%}
  .actions.center{flex-direction:column-reverse}
}
@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  .orbit,.scan{animation:none!important}
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="logo" aria-hidden="true">
        <svg viewBox="0 0 32 32" focusable="false">
          <defs>
            <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#8ff4ff"/>
              <stop offset="60%" stop-color="#21d8f3"/>
              <stop offset="100%" stop-color="#0f7f96"/>
            </linearGradient>
          </defs>
          <rect x="3" y="3" width="26" height="26" rx="8" fill="none" stroke="url(#logoGrad)" stroke-width="1.5"/>
          <path d="M12.4 9.4v11.4h7.6" fill="none" stroke="url(#logoGrad)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="brand-text"><strong>LLooM</strong><small>by Enntity</small></span>
    </div>
    <nav class="progress" aria-label="Setup progress">
      <span class="pstep" data-stage="discover">Discover</span>
      <span class="psep" aria-hidden="true"></span>
      <span class="pstep" data-stage="choose">Choose</span>
      <span class="psep" aria-hidden="true"></span>
      <span class="pstep" data-stage="review">Review</span>
      <span class="psep" aria-hidden="true"></span>
      <span class="pstep" data-stage="ready">Ready</span>
    </nav>
    <div class="local">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/>
        <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>
      </svg>
      Local setup
    </div>
  </header>

  <main>
    <section class="step" id="step-discover" data-active="false" aria-labelledby="discover-title">
      <div class="panel">
        <h2 class="panel-title">Discover local weight sources</h2>
        <p id="discover-note" class="status">Looking for already-downloaded models and compatible recipes locally. This stays on this computer.</p>
        <div class="actions">
          <button class="primary" id="to-choose" type="button">Continue</button>
        </div>
      </div>
    </section>

    <section class="step" id="step-choose" data-active="true" aria-labelledby="choose-title">
      <div class="choose-grid">
        <div class="machine-slot" id="machine-slot">
          <div class="card machine">
            <p class="eyebrow">Local hardware</p>
            <h2 id="discover-title" class="machine-name">Detecting hardware…</h2>
            <div class="chip-wrap">
              <svg class="chip" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
                <defs>
                  <radialGradient id="chipCore" cx="50%" cy="50%" r="62%">
                    <stop offset="0%" stop-color="#0d2b36"/>
                    <stop offset="100%" stop-color="#071820"/>
                  </radialGradient>
                  <linearGradient id="chipEdge" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#7cf0ff"/>
                    <stop offset="55%" stop-color="#21d8f3"/>
                    <stop offset="100%" stop-color="#0f7f96"/>
                  </linearGradient>
                </defs>
                <g class="orbit">
                  <circle class="ring" cx="100" cy="100" r="93"/>
                  <circle class="orbit-dot" cx="100" cy="7" r="2.7"/>
                </g>
                <g class="orbit orbit-rev">
                  <circle class="ring ring-2" cx="100" cy="100" r="82"/>
                  <circle class="orbit-dot" cx="100" cy="182" r="2.2"/>
                </g>
                <circle class="ring ring-3" cx="100" cy="100" r="70"/>
                <g class="pins">
                  <line class="pin" x1="52" y1="76" x2="64" y2="76"/>
                  <line class="pin" x1="52" y1="88" x2="64" y2="88"/>
                  <line class="pin" x1="52" y1="100" x2="64" y2="100"/>
                  <line class="pin" x1="52" y1="112" x2="64" y2="112"/>
                  <line class="pin" x1="52" y1="124" x2="64" y2="124"/>
                  <line class="pin" x1="136" y1="76" x2="148" y2="76"/>
                  <line class="pin" x1="136" y1="88" x2="148" y2="88"/>
                  <line class="pin" x1="136" y1="100" x2="148" y2="100"/>
                  <line class="pin" x1="136" y1="112" x2="148" y2="112"/>
                  <line class="pin" x1="136" y1="124" x2="148" y2="124"/>
                  <line class="pin" x1="76" y1="52" x2="76" y2="64"/>
                  <line class="pin" x1="88" y1="52" x2="88" y2="64"/>
                  <line class="pin" x1="100" y1="52" x2="100" y2="64"/>
                  <line class="pin" x1="112" y1="52" x2="112" y2="64"/>
                  <line class="pin" x1="124" y1="52" x2="124" y2="64"/>
                  <line class="pin" x1="76" y1="136" x2="76" y2="148"/>
                  <line class="pin" x1="88" y1="136" x2="88" y2="148"/>
                  <line class="pin" x1="100" y1="136" x2="100" y2="148"/>
                  <line class="pin" x1="112" y1="136" x2="112" y2="148"/>
                  <line class="pin" x1="124" y1="136" x2="124" y2="148"/>
                </g>
                <rect class="body" x="64" y="64" width="72" height="72" rx="14"/>
                <rect class="glyph" x="86" y="86" width="28" height="28" rx="7"/>
                <circle class="orbit-dot" cx="100" cy="100" r="4"/>
                <line class="scan" x1="70" y1="100" x2="130" y2="100"/>
              </svg>
            </div>
            <dl id="machine-facts"><dt>Scanning</dt><dd>Detecting hardware…</dd></dl>
          </div>
        </div>

        <div class="choose-main">
          <h1 class="hero">What will you create?</h1>
          <p class="hero-sub">AI chosen for your hardware. Review the recommendation, then let LLooM set it up.</p>
          <h2 id="choose-title" class="visually-hidden">What will you use it for?</h2>
          <div class="choices" id="workloads" role="group" aria-label="Workload"></div>
          <div id="recommendation" aria-live="polite">
            <p class="status">Choose a workload to see a recommendation.</p>
          </div>
          <div class="actions center">
            <button id="back-discover" type="button">Back</button>
            <button class="primary cta" id="to-review" type="button" disabled>Review plan</button>
          </div>
        </div>
      </div>
    </section>

    <section class="step" id="step-review" aria-labelledby="review-title">
      <h1 class="hero sm" id="review-title">Review the plan</h1>
      <p class="hero-sub">Nothing installs until you approve it. This is the last step before any writes.</p>
      <div id="plan-review" aria-live="polite"></div>
      <div class="actions center">
        <button id="back-choose" type="button">Back</button>
        <button class="primary cta" id="authorize" type="button">Set up my AI</button>
      </div>
      <p class="status center-text" id="authorize-note">This installs the reviewed vendor recipe, downloads its models, and configures LLooM.</p>
    </section>

    <section class="step" id="step-ready" aria-labelledby="ready-title">
      <h1 class="hero sm" id="ready-title">Setup progress</h1>
      <p class="hero-sub">Real stages, reported as they happen. Nothing here is estimated in advance.</p>
      <div class="panel">
        <ul class="stages" id="stages"></ul>
        <p class="status" id="install-status" role="status" aria-live="polite"></p>
      </div>
      <div class="panel" id="result-card" hidden>
        <h3>Result</h3>
        <p class="verify" id="verify-state" data-state="pending"></p>
        <p id="result-detail" class="status"></p>
        <p id="endpoint-line" class="mono" hidden></p>
        <div class="actions">
          <button class="primary" id="open-lloom" type="button" disabled>Open LLooM</button>
          <button id="retry" type="button" hidden>Retry setup</button>
        </div>
      </div>
      <footer>Local setup server. It stops when this process exits.</footer>
    </section>
  </main>
</div>
<script>
(function(){
  'use strict';
  var STORAGE_KEY='lloom.firstRunToken';
  var stage={workloadId:'chat',plan:null,job:null};
  var planSequence=0;
  var SVGNS='http://www.w3.org/2000/svg';
  var el=function(id){return document.getElementById(id)};

  function readToken(){
    var hash=window.location.hash||'';
    var match=hash.match(/setup=([^&]+)/);
    var token=match?decodeURIComponent(match[1]):null;
    if(token){
      try{ window.sessionStorage.setItem(STORAGE_KEY,token); }catch(e){}
      // Strip the secret from the address bar and history immediately.
      try{ window.history.replaceState(null,'',window.location.pathname+window.location.search); }catch(e){}
      return token;
    }
    try{ return window.sessionStorage.getItem(STORAGE_KEY); }catch(e){ return null; }
  }

  var token=readToken();

  function api(path,options){
    var opts=options||{};
    return fetch(path,{
      method:opts.method||'GET',
      headers:Object.assign({'authorization':'Bearer '+(token||''),'accept':'application/json'},
        opts.body?{'content-type':'application/json'}:{}),
      body:opts.body?JSON.stringify(opts.body):undefined,
      credentials:'omit',
      cache:'no-store'
    }).then(function(res){
      return res.json().catch(function(){return {};}).then(function(data){
        if(!res.ok||data.ok===false){throw new Error(data.error||('Request failed ('+res.status+')'));}
        return data;
      });
    });
  }

  function text(node,value){node.textContent=value==null?'':String(value);return node}
  function clear(node){while(node.firstChild)node.removeChild(node.firstChild);return node}
  function humanBytes(bytes){
    var n=Number(bytes);
    if(!isFinite(n)||n<=0)return null;
    var units=['B','KB','MB','GB','TB'],i=0;
    while(n>=1024&&i<units.length-1){n=n/1024;i+=1}
    return (Math.round(n*10)/10)+' '+units[i];
  }
  function svgEl(name,attrs){
    var node=document.createElementNS(SVGNS,name);
    if(attrs){for(var k in attrs){if(Object.prototype.hasOwnProperty.call(attrs,k))node.setAttribute(k,attrs[k]);}}
    return node;
  }
  function svgIcon(kind){
    var svg=svgEl('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',
      'stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round',focusable:'false'});
    if(kind==='chat'){
      svg.appendChild(svgEl('path',{d:'M4.5 5.5h15v9.4h-8L7.6 18.7V14.9H4.5z'}));
      svg.appendChild(svgEl('path',{d:'M8.2 9.1h7.6'}));
    }else if(kind==='code'){
      svg.appendChild(svgEl('path',{d:'M9.2 8.2 5.6 12l3.6 3.8'}));
      svg.appendChild(svgEl('path',{d:'M14.8 8.2 18.4 12l-3.6 3.8'}));
      svg.appendChild(svgEl('path',{d:'M13.2 6.6 10.8 17.4'}));
    }else if(kind==='images'){
      svg.appendChild(svgEl('rect',{x:'4',y:'5',width:'16',height:'14',rx:'2.2'}));
      svg.appendChild(svgEl('circle',{cx:'9',cy:'9.5',r:'1.5'}));
      svg.appendChild(svgEl('path',{d:'M4.8 17.2 9.4 12.6l3.2 3.1 2.5-2.4 4 3.9'}));
    }else{
      svg.appendChild(svgEl('path',{d:'M5 10.5v3'}));
      svg.appendChild(svgEl('path',{d:'M8.4 7.6v8.8'}));
      svg.appendChild(svgEl('path',{d:'M11.8 5.6v12.8'}));
      svg.appendChild(svgEl('path',{d:'M15.2 7.6v8.8'}));
      svg.appendChild(svgEl('path',{d:'M18.6 10.5v3'}));
    }
    return svg;
  }
  function sparkIcon(){
    var svg=svgEl('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',
      'stroke-width':'1.5','stroke-linejoin':'round',focusable:'false'});
    svg.appendChild(svgEl('path',{d:'M12 3.4 13.6 9 19.4 10.5 13.6 12 12 17.6 10.4 12 4.6 10.5 10.4 9z'}));
    return svg;
  }
  function updateProgress(stepId){
    var current=String(stepId||'').replace('step-','');
    if(current==='install')current='review';
    var items=document.querySelectorAll('.progress .pstep');
    for(var i=0;i<items.length;i+=1){
      items[i].setAttribute('data-active',items[i].getAttribute('data-stage')===current?'true':'false');
    }
  }
  function show(id){
    var steps=document.querySelectorAll('.step');
    for(var i=0;i<steps.length;i+=1){steps[i].setAttribute('data-active',steps[i].id===id?'true':'false');}
    updateProgress(id);
  }

  function setStatus(node,message,kind){
    text(node,message);
    if(kind){node.setAttribute('data-kind',kind)}else{node.removeAttribute('data-kind')}
  }

  function renderMachine(plan){
    var list=clear(el('machine-facts'));
    var machine=plan.machine||{};
    var title=el('discover-title');
    if(title){text(title,machine.name||'This machine');}
    var facts=[
      ['Name',machine.name||'Unknown'],
      ['Platform',machine.platformId||'Unknown'],
      ['Memory',machine.totalMemoryGb?machine.totalMemoryGb+' GB':'Unknown'],
      ['Accelerator',(machine.accelerators&&machine.accelerators.length)?machine.accelerators.join(', '):'None detected']
    ];
    facts.forEach(function(entry){
      var dt=document.createElement('dt');text(dt,entry[0]);
      var dd=document.createElement('dd');text(dd,entry[1]);
      list.appendChild(dt);list.appendChild(dd);
    });
  }

  function optionCard(option,selected){
    var card=document.createElement('div');
    card.className='card'+(selected?' reco':'');
    if(selected){
      var icon=document.createElement('span');
      icon.className='reco-icon';icon.setAttribute('aria-hidden','true');
      icon.appendChild(sparkIcon());
      card.appendChild(icon);
    }
    var title=document.createElement('h3');text(title,option.name||option.id);card.appendChild(title);
    if(option.id){var id=document.createElement('p');id.className='mono';text(id,option.id);card.appendChild(id)}
    if(option.reason){var reason=document.createElement('p');text(reason,option.reason);card.appendChild(reason)}
    var badges=document.createElement('p');
    var footprint=humanBytes(option.downloadSizeBytes);
    var mem=option.memoryRequiredGb?option.memoryRequiredGb+' GB memory':'Memory requirement unknown';
    [
      {label:footprint?('Download '+footprint):'Download size unknown',cls:footprint?'ok':'warn'},
      {label:mem,cls:option.memoryRequiredGb?'':'warn'},
      {label:option.credentials?(option.credentials.required?'Credentials: '+option.credentials.required:'Credentials: none declared'):'Credentials: check vendor requirements',cls:option.credentials&&option.credentials.required?'warn':''},
      {label:option.license?('Recipe license: '+option.license):'Licenses: see vendor recipe',cls:''}
    ].forEach(function(badge){
      var span=document.createElement('span');
      span.className='badge'+(badge.cls?' '+badge.cls:'');
      text(span,badge.label);
      badges.appendChild(span);
    });
    card.appendChild(badges);
    return card;
  }

  function renderRecommendation(plan){
    var host=clear(el('recommendation'));
    var selected=plan.selected;
    if(!selected){setStatus(host,'No compatible recipe was found for this machine.','error');return}
    host.appendChild(optionCard(selected,true));
    if(plan.alternatives&&plan.alternatives.length){
      var details=document.createElement('details');
      var summary=document.createElement('summary');text(summary,'Other compatible options ('+plan.alternatives.length+')');
      details.appendChild(summary);
      plan.alternatives.slice(0,6).forEach(function(option){
        var line=document.createElement('p');
        text(line,option.name+' — '+option.id+(option.reason?' — '+option.reason:''));
        var choose=document.createElement('button');choose.type='button';text(choose,'Choose this recipe');
        choose.addEventListener('click',function(){loadPlan(stage.workloadId,option.id);});
        line.appendChild(choose);
        details.appendChild(line);
      });
      host.appendChild(details);
    }
    el('to-review').disabled=false;
  }

  function renderReview(plan){
    var host=clear(el('plan-review'));
    host.appendChild(optionCard(plan.selected,true));
    var adv=document.createElement('details');
    var summary=document.createElement('summary');text(summary,'Advanced details: packages, config, and paths');
    adv.appendChild(summary);
    var stages=(plan.review&&plan.review.stages)||[];
    if(stages.length){
      var title=document.createElement('h3');text(title,'Planned stages');adv.appendChild(title);
      var list=document.createElement('ul');list.className='plain';
      stages.forEach(function(stage){
        var item=document.createElement('li');
        text(item,(stage.title||stage.id)+(stage.summary?' — '+stage.summary:''));
        list.appendChild(item);
      });
      adv.appendChild(list);
    }
    var paths=plan.paths||{};
    [['Config path',paths.configPath],['Model root',paths.modelRoot]].forEach(function(entry){
      if(!entry[1])return;
      var p=document.createElement('p');
      text(p,entry[0]+': ');
      var code=document.createElement('code');text(code,entry[1]);
      p.appendChild(code);adv.appendChild(p);
    });
    if(plan.ports){
      var ports=document.createElement('p');
      text(ports,'Ports: gateway '+plan.ports.gateway+' / backend range '+plan.ports.backendStart+'-'+plan.ports.backendEnd);
      adv.appendChild(ports);
    }
    if(plan.review&&plan.review.doctorCommands){
      var cmd=document.createElement('p');
      text(cmd,'Verify later: ');
      var code2=document.createElement('code');text(code2,plan.review.doctorCommands);
      cmd.appendChild(code2);adv.appendChild(cmd);
    }
    host.appendChild(adv);
    var note=document.createElement('p');
    note.className='status';
    text(note,'Installs and downloads are authorized only by the button below. Nothing has run yet.');
    host.appendChild(note);
  }

  function renderStages(stages){
    var list=clear(el('stages'));
    (stages||[]).forEach(function(stage){
      var item=document.createElement('li');
      item.setAttribute('data-state',stage.status||'pending');
      var dot=document.createElement('span');dot.className='dot';
      var label=document.createElement('span');
      text(label,(stage.title||stage.id||'Stage')+(stage.status?' ('+stage.status+')':''));
      item.appendChild(dot);item.appendChild(label);
      list.appendChild(item);
    });
  }

  function applyResult(job){
    el('result-card').hidden=false;
    var verify=el('verify-state');
    var detail=el('result-detail');
    var endpoint=el('endpoint-line');
    var open=el('open-lloom');
    var retry=el('retry');
    endpoint.hidden=true;
    open.disabled=true;
    retry.hidden=true;
    if(job.status==='failed'){
      verify.setAttribute('data-state','failed');
      text(verify,'Setup failed');
      setStatus(detail,job.error||'Setup did not complete. Retry, or run lloom doctor for details.','error');
      retry.hidden=false;
      return;
    }
    if(job.inferenceVerified){
      updateProgress('step-ready');
      verify.setAttribute('data-state','verified');
      text(verify,'Ready — inference verified through the LLooM gateway.');
      setStatus(detail,job.detail||'The gateway answered a real model request.',null);
    }else{
      verify.setAttribute('data-state','installed');
      text(verify,job.healthy?'Installed — gateway running, inference not yet verified.':'Installed — verification needs attention.');
      setStatus(detail,job.detail||'Files and configuration are in place. Verify the model through the gateway.','error');
    }
    if(job.endpoint){
      text(endpoint,'Endpoint: '+job.endpoint);
      endpoint.hidden=false;
      open.disabled=false;
    }
    retry.hidden=true;
  }

  function pollJob(){
    api('/gateway/first-run/job').then(function(data){
      var job=data.job;
      if(!job){setStatus(el('install-status'),'No active setup job.',null);return}
      stage.job=job;
      renderStages(job.stages);
      if(job.stage&&job.stage.detail){setStatus(el('install-status'),job.stage.detail,null)}
      else if(job.status==='running'){setStatus(el('install-status'),'Working…',null)}
      if(job.status==='running'||job.status==='pending'){
        window.setTimeout(pollJob,1200);
        return;
      }
      setStatus(el('install-status'),job.status==='succeeded'?'Setup finished.':'Setup stopped.','');
      applyResult(job);
    }).catch(function(error){
      setStatus(el('install-status'),'Lost contact with the setup server: '+error.message,'error');
    });
  }

  function loadPlan(workloadId,recipeId){
    var sequence=++planSequence;
    stage.plan=null;
    el('authorize').disabled=true;
    el('to-review').disabled=true;
    setStatus(el('recommendation'),'Reviewing compatible recipes for this machine…',null);
    return api('/gateway/first-run/plan?workload='+encodeURIComponent(workloadId)+(recipeId?'&recipe='+encodeURIComponent(recipeId):'')).then(function(data){
      if(sequence!==planSequence)return;
      stage.plan=data.plan;
      el('authorize').disabled=false;
      renderMachine(stage.plan);
      renderRecommendation(stage.plan);
      renderReview(stage.plan);
    }).catch(function(error){
      if(sequence!==planSequence)return;
      setStatus(el('recommendation'),'Could not build a plan: '+error.message,'error');
    });
  }

  function initWorkloads(){
    var host=clear(el('workloads'));
    var workloads=[
      {id:'chat',label:'Chat & write',description:'Everyday conversation, drafting, and reasoning.'},
      {id:'code',label:'Code',description:'Editor and agent assistants that read and write code.'},
      {id:'images',label:'Images',description:'Image generation and editing models.'},
      {id:'voice',label:'Voice',description:'Speech synthesis and transcription.'}
    ];
    workloads.forEach(function(workload){
      var button=document.createElement('button');
      button.type='button';
      button.className='choice';
      button.setAttribute('aria-pressed',workload.id===stage.workloadId?'true':'false');
      var icon=document.createElement('span');
      icon.className='wk-icon';icon.setAttribute('aria-hidden','true');
      icon.appendChild(svgIcon(workload.id));
      var body=document.createElement('span');body.className='wk-body';
      var label=document.createElement('strong');text(label,workload.label);
      var description=document.createElement('span');description.className='wk-desc';text(description,workload.description);
      body.appendChild(label);body.appendChild(description);
      var check=document.createElement('span');check.className='wk-check';check.setAttribute('aria-hidden','true');
      button.appendChild(icon);button.appendChild(body);button.appendChild(check);
      button.addEventListener('click',function(){
        stage.workloadId=workload.id;
        var all=host.querySelectorAll('.choice');
        for(var i=0;i<all.length;i+=1){all[i].setAttribute('aria-pressed',all[i]===button?'true':'false')}
        loadPlan(workload.id);
      });
      host.appendChild(button);
    });
  }

  el('to-choose').addEventListener('click',function(){show('step-choose')});
  el('back-discover').addEventListener('click',function(){show('step-discover')});
  el('to-review').addEventListener('click',function(){show('step-review')});
  el('back-choose').addEventListener('click',function(){show('step-choose')});
  el('authorize').addEventListener('click',function(){
    if(!stage.plan||!stage.plan.planId){setStatus(el('authorize-note'),'No reviewed plan is loaded. Go back and plan again.','error');return}
    var button=el('authorize');
    button.disabled=true;
    setStatus(el('authorize-note'),'Authorizing the reviewed plan. This is the only step that installs anything.',null);
    api('/gateway/first-run/apply',{method:'POST',body:{planId:stage.plan.planId,yes:true,workloadId:stage.workloadId}})
      .then(function(data){
        show('step-ready');
        stage.job=data.job;
        renderStages(data.job&&data.job.stages);
        setStatus(el('install-status'),'Setup started. Progress is reported by real stages below.',null);
        pollJob();
      })
      .catch(function(error){
        button.disabled=false;
        setStatus(el('authorize-note'),'Could not start setup: '+error.message,'error');
      });
  });
  el('retry').addEventListener('click',function(){
    el('result-card').hidden=true;
    setStatus(el('install-status'),'Reloading the plan to retry.',null);
    show('step-choose');
    loadPlan(stage.workloadId).then(function(){show('step-review')});
  });
  el('open-lloom').addEventListener('click',function(){
    if(stage.job&&stage.job.endpoint){
      window.open(stage.job.endpoint,'_blank','noopener');
    }
  });

  initWorkloads();
  var machineCard=document.querySelector('.machine');
  var machineSlot=el('machine-slot');
  if(machineCard&&machineSlot){machineSlot.appendChild(machineCard);}
  el('back-discover').hidden=true;
  show('step-choose');
  if(!token){
    setStatus(el('recommendation'),'This setup session is missing its local token. Re-run lloom from a terminal to reopen setup.','error');
  }else{
    api('/gateway/first-run/job').then(function(data){
      if(data.job){stage.job=data.job;show('step-ready');pollJob();}
      else loadPlan(stage.workloadId);
    }).catch(function(error){setStatus(el('recommendation'),error.message,'error');});
  }
})();
</script>
</body>
</html>`;
}
