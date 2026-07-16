function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeUrl(value, fallback) {
  try {
    const url = new URL(String(value ?? fallback));
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

export function renderCommunitySite({ publisher = 'LLooM Community', contributionUrl, apiBase = '/v1' } = {}) {
  const submitUrl = safeUrl(contributionUrl, 'https://github.com/Enntity/lloom/issues');
  const title = escapeHtml(publisher);
  const api = escapeHtml(apiBase);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Curated, signed local-LLM recipes and reproducible benchmark evidence.">
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; --bg:#10151d; --surface:#18212d; --ink:#ecf3fb; --muted:#a8bbcf; --accent:#65d3a4; --line:#2f4054; }
      * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      main { max-width:1040px; margin:auto; padding:56px 24px 72px; } h1 { font-size:clamp(2.25rem,6vw,4.75rem); line-height:1; letter-spacing:-.045em; max-width:800px; margin:0 0 24px; } h2 { margin-top:48px; font-size:1.4rem; } p { max-width:780px; color:var(--muted); } a { color:var(--accent); } .badge { color:var(--accent); font-weight:700; letter-spacing:.08em; text-transform:uppercase; font-size:.78rem; } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:16px; margin-top:24px; } .card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:20px; } .card h3 { margin:0 0 8px; } .card p { margin:0; font-size:.93rem; } button { appearance:none; border:1px solid var(--accent); color:#062317; background:var(--accent); padding:11px 15px; border-radius:9px; font:inherit; font-weight:700; cursor:pointer; } pre { overflow:auto; background:#0b1017; border:1px solid var(--line); padding:16px; border-radius:10px; color:#d9e8f7; } .error { color:#ffb4ab; }
    </style>
  </head>
  <body>
    <main>
      <div class="badge">Signed, admin-curated registry</div>
      <h1>${title}</h1>
      <p>Hardware-matched local-LLM recipes backed by reproducible benchmarks. Recipes are metadata, not remotely executed code: your LLooM gateway previews every local change before it can apply one.</p>
      <p><a href="${escapeHtml(submitUrl)}">Propose a recipe or benchmark on GitHub</a>. Public HTTP submission is intentionally disabled while the registry is curated.</p>
      <div class="grid">
        <section class="card"><h3>Stable recipes</h3><p>Only maintainer-signed releases belong in default recommendations.</p></section>
        <section class="card"><h3>Evidence first</h3><p>Leaderboards distinguish hardware, workload, backend settings, and measurement method.</p></section>
        <section class="card"><h3>Transparent review</h3><p>Contribution history and discussion live in the public source repository.</p></section>
      </div>
      <h2>Browse</h2>
      <div class="grid" id="recipes"><p>Loading recipes…</p></div>
      <h2>API</h2>
      <p>The machine-readable API remains available for LLooM clients at <code>${api}</code>. It publishes signed recipe packs, signing keys, recommendation responses, and benchmark evidence.</p>
      <pre id="status">Loading registry status…</pre>
    </main>
    <script>
      const api = ${JSON.stringify(apiBase)};
      const recipeRoot = document.getElementById('recipes');
      const statusRoot = document.getElementById('status');
      const text = (value) => document.createTextNode(String(value ?? ''));
      async function load() {
        const [health, recipes] = await Promise.all([fetch('/health'), fetch(api + '/recipes')]);
        const healthJson = await health.json();
        const recipeJson = await recipes.json();
        statusRoot.textContent = JSON.stringify(healthJson, null, 2);
        recipeRoot.replaceChildren(...(recipeJson.data || []).map((recipe) => {
          const card = document.createElement('article'); card.className = 'card';
          const title = document.createElement('h3'); title.append(text(recipe.name || recipe.id));
          const summary = document.createElement('p'); summary.append(text(recipe.summary || 'No summary published.'));
          card.append(title, summary); return card;
        }));
      }
      load().catch((error) => { recipeRoot.innerHTML = '<p class="error">Registry data is temporarily unavailable.</p>'; statusRoot.textContent = String(error); });
    </script>
  </body>
</html>`;
}
