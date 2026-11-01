// SPDX-License-Identifier: MIT
// Dependency-free web client. Credentials and coordination content stay in memory.
(() => {
  "use strict";
  const terminal = new Set([
    "done",
    "failed",
    "exited",
    "cancelled",
    "succeeded",
    "released",
  ]);
  const states = new Set([
    "starting",
    "working",
    "idle",
    "waiting",
    "blocked",
    "done",
    "failed",
    "exited",
    "cancelled",
    "unknown",
    "running",
    "active",
    "queued",
    "recovering",
    "releasing",
    "preparing",
    "succeeded",
    "released",
    "unclaimed",
    "held",
  ]);
  const stateLabel = (s) =>
    ({
      unclaimed: "Unclaimed",
      needsInput: "Needs you",
      working: "Working",
      waiting: "Waiting",
      blocked: "Blocked",
      done: "Done",
      unknown: "Unknown",
      recovering: "Recovering",
      releasing: "Releasing",
      held: "Held",
      idle: "Idle",
      starting: "Starting",
      running: "Running",
      active: "Active",
      failed: "Failed",
      queued: "Queued",
      preparing: "Preparing",
      succeeded: "Complete",
      released: "Released",
      exited: "Exited",
      cancelled: "Cancelled",
    })[s] || "Unknown";
  const timestamp = (at) =>
    at == null || at === ""
      ? NaN
      : typeof at === "number"
        ? at
        : /^\d+$/.test(at)
          ? Number(at)
          : Date.parse(at);
  const relative = (at, now = Date.now()) => {
    const value = timestamp(at);
    if (!Number.isFinite(value)) return "Not observed";
    const seconds = Math.max(0, Math.floor((now - value) / 1000));
    return seconds < 60
      ? "just now"
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ago`
          : `${Math.floor(seconds / 86400)}d ago`;
  };
  const short = (s, n = 90) =>
    String(s ?? "").length > n
      ? String(s).slice(0, n - 1) + "…"
      : String(s ?? "");
  const sourceName = (s) =>
    ({ codex: "Codex", claude: "Claude", agent: "Agent", tessera: "Tessera" })[
      s
    ] ||
    (String(s || "Agent").startsWith("product:") ? "Product" : s || "Agent");
  const needsAttention = (s) =>
    !s.private && ["waiting", "blocked", "failed"].includes(s.state);
  function resourceState(r, fresh = true) {
    if (!fresh || r.driver !== "reachable" || r.state === "unknown")
      return "unknown";
    if (
      r.holder &&
      ["revoking", "recovering", "releasing"].includes(r.holder.state)
    )
      return r.holder.state === "revoking" ? "recovering" : r.holder.state;
    return r.holder || r.holders?.length
      ? "held"
      : states.has(r.state)
        ? r.state
        : "unknown";
  }
  function incidentReason(i) {
    const e = i.evidence || {};
    if (e.kind === "quiet-session")
      return `No meaningful progress for ${Math.max(1, Math.floor((e.quietMs || 0) / 60000))} minutes. A check-in has been queued for the session.`;
    if (e.kind === "idle-resource")
      return `${e.resource || i.subject} has remained idle while reserved. Ownership is unchanged.`;
    return (
      e.reason ||
      "The overseer noticed a condition worth checking. Resource ownership is unchanged."
    );
  }
  const questionOptions = (q) => {
    try {
      const a =
        typeof q.options === "string" ? JSON.parse(q.options) : q.options;
      return Array.isArray(a)
        ? a.filter((v) => typeof v === "string").slice(0, 6)
        : [];
    } catch {
      return [];
    }
  };
  function visibleSessions(
    sessions,
    { filter = "all", source = "all", query = "", pins = new Set() } = {},
  ) {
    const text = query.toLowerCase().trim();
    return sessions
      .filter(
        (s) =>
          (source === "all" || s.source === source) &&
          (filter === "all" ||
            (filter === "attention" && needsAttention(s)) ||
            (filter === "working" &&
              ["working", "starting"].includes(s.state)) ||
            (filter === "waiting" &&
              ["waiting", "blocked"].includes(s.state)) ||
            (filter === "done" && terminal.has(s.state)) ||
            (filter === "pinned" && pins.has(s.address))) &&
          (!text ||
            [s.title, s.summary, s.detail, s.location, s.source].some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(text),
            )),
      )
      .sort(
        (a, b) =>
          Number(pins.has(b.address)) - Number(pins.has(a.address)) ||
          b.progressAt - a.progressAt,
      );
  }
  function mergeResources(
    local,
    hosts,
    previous,
    authority,
    directoryAvailable = true,
  ) {
    const remote = [];
    if (!directoryAvailable)
      remote.push(
        ...previous
          .filter((r) => !r.id.startsWith(authority + "/"))
          .map((r) => ({ ...r, state: "unknown", driver: "HOST_UNREACHABLE" })),
      );
    else
      for (const host of hosts) {
        if (host.authority === authority) continue;
        if (host.status === "unknown")
          remote.push(
            ...previous
              .filter((r) => r.id.startsWith(host.authority + "/"))
              .map((r) => ({
                ...r,
                state: "unknown",
                driver: "HOST_UNREACHABLE",
              })),
          );
        else remote.push(...(host.resources || []));
      }
    return [...new Map([...local, ...remote].map((r) => [r.id, r])).values()];
  }
  // A tiny pure surface for protocol/UX regression tests, without a browser dependency.
  if (typeof document === "undefined") {
    if (typeof module !== "undefined")
      module.exports = {
        relative,
        resourceState,
        incidentReason,
        questionOptions,
        visibleSessions,
        needsAttention,
        mergeResources,
        timestamp,
      };
    return;
  }
  const $ = (id) => document.getElementById(id);
  const paths = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    attention: "M12 3 2 21h20L12 3z M12 9v5 M12 17v.1",
    sessions: "M4 5h16v12H4z M8 21h8 M12 17v4 M8 9l3 2-3 2 M13 13h3",
    resource:
      "M4 3h16v7H4z M4 14h16v7H4z M7 6.5h.1 M7 17.5h.1 M14 6.5h3 M14 17.5h3",
    message:
      "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3H21z M7 8h9 M7 12h6",
    activity: "M3 12h4l3-8 4 16 3-8h4",
    search: "m21 21-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    chevron: "m9 5 7 7-7 7",
    refresh:
      "M20 7a9 9 0 0 0-15-2L2 8 M2 3v5h5 M4 17a9 9 0 0 0 15 2l3-3 M22 21v-5h-5",
    close: "m6 6 12 12 M6 18 18 6",
    bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
    moon: "M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M19 5l-1 1 M6 18l-1 1",
    keyboard:
      "M2 5h20v14H2z M5 9h.1 M9 9h.1 M13 9h.1 M17 9h.1 M5 12h.1 M9 12h.1 M13 12h.1 M17 12h.1 M7 16h10",
    pin: "m9 3 6 0-1 6 4 4v2h-5v6l-1-1-1-5H6v-2l4-4-1-6z",
    copy: "M9 9h12v12H9z M5 15H3V3h12v2",
    check: "m5 12 4 4L19 6",
    clock: "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    folder: "M3 5h6l2 3h10v12H3z",
    send: "m22 2-7 20-4-9L2 9 22 2z M11 13 22 2",
    pause: "M8 4v16 M16 4v16",
    play: "m7 3 15 9-15 9V3z",
    menu: "M3 6h18 M3 12h18 M3 18h18",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    link: "m10 13 4-4 M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0 M16 9l2-2a4 4 0 0 0-5-5l-5 5",
    shield: "m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4z M8 12l3 3 5-6",
    more: "M5 12h.1 M12 12h.1 M19 12h.1",
    logout: "M9 3H3v18h6 M10 12h12 M17 7l5 5-5 5",
    spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  };
  function icon(name) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    }))
      s.setAttribute(k, v);
    const p = document.createElementNS(s.namespaceURI, "path");
    p.setAttribute("d", paths[name] || paths.grid);
    s.append(p);
    return s;
  }
  function h(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on") && typeof v === "function")
        n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") n.value = v;
      else if (k === "checked") n.checked = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c != null && c !== false)
        n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function button(label, fn, { kind = "", glyph, ...attrs } = {}) {
    return h(
      "button",
      { type: "button", class: `button ${kind}`, onClick: fn, ...attrs },
      glyph ? icon(glyph) : null,
      label,
    );
  }
  function iconButton(name, label, fn, attrs = {}) {
    return h(
      "button",
      {
        type: "button",
        class: "icon-button",
        title: label,
        "aria-label": label,
        onClick: fn,
        ...attrs,
      },
      icon(name),
    );
  }
  const pref = {
    get(k, fallback) {
      try {
        return JSON.parse(localStorage.getItem("accord.ui." + k)) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("accord.ui." + k, JSON.stringify(v));
      } catch {}
    },
  };
  const S = {
    credential: "",
    me: null,
    host: null,
    connected: false,
    fresh: false,
    loading: false,
    connectionVersion: 0,
    view: "overview",
    filter: "all",
    source: "all",
    query: "",
    searchResults: null,
    searching: false,
    searchSerial: 0,
    data: {
      sessions: [],
      questions: [],
      incidents: [],
      jobs: [],
      participants: [],
      resources: [],
      hosts: [],
      messages: [],
      tasks: [],
      events: [],
    },
    failed: new Set(),
    cursor: 0,
    events: [],
    sent: [],
    lastUpdate: null,
    paused: false,
    pins: new Set(
      Array.isArray(pref.get("pins", [])) ? pref.get("pins", []) : [],
    ),
    drafts: new Map(),
    errors: new Map(),
    intents: new Map(),
    busy: new Set(),
    notified: new Set(),
    notificationBaseline: false,
    notifications: false,
    theme: pref.get("theme", "system"),
    drawer: null,
    detailVersion: 0,
    renderSignature: "",
    refreshTimer: null,
  };
  const viewInfo = {
    overview: ["Overview", "A clear view of work in motion."],
    attention: [
      "Needs you",
      "Decisions, blockers, and check-ins worth your attention.",
    ],
    sessions: ["Sessions", "Find the work, then pick up the conversation."],
    resources: [
      "Resources",
      "Ownership, recovery, and the machines behind the work.",
    ],
    messages: [
      "Messages",
      "Your inbox, with durable delivery across the network.",
    ],
    activity: ["Activity", "A record of what changed and why."],
  };
  // Trusted static shell. All session, question, message and provider content uses text nodes.
  document.body.innerHTML = `<a class="skip" href="#main">Skip to content</a><aside class="rail" aria-label="Main navigation"><div class="brand"><span class="brand-mark" id="brand-mark"></span>Accord</div><div class="rail-caption">Mission control</div><nav class="nav" id="nav"></nav><div class="rail-bottom"><button class="nav-item" id="notifications" type="button"></button><button class="nav-item" id="theme" type="button"></button><button class="nav-item" id="shortcuts" type="button"></button><button class="host-button" id="connection-button" type="button"><span class="host-avatar">AC</span><span class="host-copy"><strong id="host-name">Your Accord</strong><span id="host-caption">Connect to a host</span></span><span id="host-chevron"></span></button></div></aside><button class="nav-scrim" id="nav-scrim" aria-label="Close navigation" hidden></button><div class="workspace"><header class="topbar"><button class="icon-button menu-toggle" id="menu-toggle" aria-label="Open navigation" aria-expanded="false"></button><label class="search-box"><span id="search-icon"></span><input id="search" type="search" maxlength="200" placeholder="Search sessions, activity, or people" aria-label="Search sessions, activity, or people" autocomplete="off"><kbd id="search-key">⌘ K</kbd></label><div class="top-actions"><div class="connection" role="status"><span class="dot" id="connection-dot"></span><span id="connection-status">Not connected</span></div><button class="icon-button" id="refresh" type="button" title="Refresh" aria-label="Refresh"></button><button class="button small" id="connect-button" type="button">Connect</button></div></header><main id="main" class="content" tabindex="-1"><div id="banner" hidden></div><div id="page"></div></main></div><dialog class="dialog" id="connect-dialog" aria-labelledby="connect-title"><div class="dialog-head"><h2 id="connect-title">Enter your Accord</h2><button class="icon-button" data-close="connect-dialog" aria-label="Close connection settings"></button></div><p class="dialog-description">Connect to the host serving this page. Your credential stays in this tab’s memory.</p><form id="connect-form"><label class="field-label" for="token">Host credential</label><input id="token" type="password" autocomplete="off" spellcheck="false" maxlength="512" placeholder="Paste your operator or agent token" required><div class="dialog-footer"><label class="button small file-label" tabindex="0" role="button">Choose credential file<input type="file" id="credential-file" accept=".token,.txt" aria-label="Choose credential file"></label><button class="button primary" id="connect-submit">Connect</button></div><p class="inline-error" id="connect-error" role="alert"></p></form><p class="help">On a default install, the operator credential is in <code>~/.local/share/accord/admin.token</code>. An operator can answer questions and steer admissions. Agent credentials have narrower permissions.</p><div id="connection-details" hidden></div></dialog><dialog class="dialog" id="compose-dialog" aria-labelledby="compose-title"><div class="dialog-head"><h2 id="compose-title">Start a conversation</h2><button class="icon-button" data-close="compose-dialog" aria-label="Close message composer"></button></div><p class="dialog-description">Send a durable message to a collaborator. Delivery does not mean they have read it yet.</p><form id="compose-form"><label class="field-label" for="recipient">To</label><select id="recipient" required></select><label class="field-label" for="recipient-address" id="address-label" hidden>Recipient address</label><input id="recipient-address" placeholder="host-authority/session-id" hidden maxlength="220"><label class="field-label" for="message-text">Message</label><textarea id="message-text" rows="6" maxlength="4000" placeholder="Share context, ask a question, or steer the work…" required></textarea><label class="check-label"><input id="message-notify" type="checkbox">Request attention from the recipient</label><p class="inline-error" id="compose-error" role="alert"></p><div class="dialog-footer"><span class="hint" id="message-count">0 / 4,000</span><button class="button primary" id="message-submit">Send message</button></div></form></dialog><dialog class="dialog drawer" id="detail-dialog" aria-labelledby="detail-title"><div class="drawer-header"><span class="eyebrow" id="detail-kicker">Session activity</span><button class="icon-button" data-close="detail-dialog" aria-label="Close details"></button></div><div class="drawer-content" id="detail-content"></div><div class="drawer-footer" id="detail-actions"></div></dialog><dialog class="dialog" id="help-dialog" aria-labelledby="help-title"><div class="dialog-head"><h2 id="help-title">A little faster</h2><button class="icon-button" data-close="help-dialog" aria-label="Close keyboard shortcuts"></button></div><p class="dialog-description">Everything works with a mouse, touch, or keyboard.</p><div class="shortcut-row"><span>Find sessions and activity</span><kbd>⌘ / Ctrl K</kbd></div><div class="shortcut-row"><span>Focus search</span><kbd>/</kbd></div><div class="shortcut-row"><span>New message</span><kbd>N</kbd></div><div class="shortcut-row"><span>Send a message</span><kbd>⌘ / Ctrl Enter</kbd></div><div class="shortcut-row"><span>Close a panel</span><kbd>Esc</kbd></div><div class="shortcut-row"><span>Keyboard shortcuts</span><kbd>?</kbd></div><p class="help">Browser notifications are optional and work while this page is open. Keep the tab open to receive new-question and overseer alerts. Closed-tab push is not configured.</p></dialog><div id="toasts" class="toast-stack" role="status" aria-live="polite"></div>`;
  $("brand-mark").append(icon("spark"));
  $("host-chevron").append(icon("chevron"));
  $("search-icon").append(icon("search"));
  $("menu-toggle").append(icon("menu"));
  $("refresh").append(icon("refresh"));
  document.querySelectorAll("[data-close]").forEach((b) => {
    b.append(icon("close"));
    b.addEventListener("click", () => closeDialog(b.dataset.close));
  });
  for (const [id, glyph, label] of [
    ["overview", "grid", "Overview"],
    ["attention", "attention", "Needs you"],
    ["sessions", "sessions", "Sessions"],
    ["resources", "resource", "Resources"],
    ["messages", "message", "Messages"],
    ["activity", "activity", "Activity"],
  ])
    $("nav").append(
      h(
        "button",
        {
          type: "button",
          class: "nav-item",
          id: `nav-${id}`,
          "data-view": id,
          onClick: () => navigate(id),
        },
        icon(glyph),
        h("span", {}, label),
        h("span", { class: "count", id: `count-${id}`, hidden: true }),
      ),
    );
  const isAdmin = () => S.me?.role === "admin";
  const hostOf = (address) => String(address ?? "").split("/")[0];
  const actorOf = (address) =>
    String(address ?? "")
      .split("/")
      .slice(1)
      .join("/");
  const myAddress = () => (S.host ? `${S.host.authority}/${S.me?.id}` : "");
  const sessionAt = (address) =>
    S.data.sessions.find((s) => s.address === address);
  const labelFor = (address) =>
    S.data.participants.find((p) => p.address === address)?.label ||
    sessionAt(address)?.title ||
    short(actorOf(address) || address, 22);
  const actorLabel = (id) => labelFor(`${S.host?.authority}/${id}`);
  const hostLabel = (authority) =>
    authority === S.host?.authority
      ? S.host?.name || "This host"
      : short(authority, 12);
  function badge(state, label) {
    const safe = states.has(state) ? state : "unknown";
    return h(
      "span",
      { class: `badge ${safe}` },
      h("span", { class: "dot" }),
      label || stateLabel(state),
    );
  }
  function time(at) {
    const value = timestamp(at),
      known = Number.isFinite(value);
    return h(
      "time",
      {
        "data-time": known ? value : null,
        datetime: known ? new Date(value).toISOString() : null,
        title: known ? new Date(value).toLocaleString() : "Not observed",
      },
      relative(value),
    );
  }
  function toast(text, error = false) {
    const n = h("div", { class: `toast ${error ? "error" : ""}` }, text);
    $("toasts").append(n);
    setTimeout(() => n.remove(), error ? 9000 : 4500);
  }
  function empty(title, description, glyph = "spark", compact = false) {
    return h(
      "div",
      { class: `empty ${compact ? "compact" : ""}` },
      h("div", { class: "empty-icon" }, icon(glyph)),
      h("h3", {}, title),
      h("p", {}, description),
    );
  }
  function section(title, content, { action, count, glyph, subtext } = {}) {
    return h(
      "section",
      { class: "section" },
      h(
        "div",
        { class: "section-head" },
        h(
          "div",
          { class: "section-title" },
          glyph ? icon(glyph) : null,
          h("h2", {}, title),
          count != null ? h("span", { class: "section-count" }, count) : null,
        ),
        action || (subtext ? h("span", { class: "muted" }, subtext) : null),
      ),
      content,
    );
  }
  function panel(title, children, glyph) {
    return h(
      "section",
      { class: "panel" },
      h(
        "div",
        { class: "panel-heading" },
        h("h2", {}, title),
        glyph ? icon(glyph) : null,
      ),
      children,
    );
  }
  function showDialog(id) {
    document.body.classList.remove("nav-open");
    $("nav-scrim").hidden = true;
    const d = $(id);
    if (d.open) return;
    if (d.showModal) d.showModal();
    else {
      d.setAttribute("open", "");
      d.setAttribute("aria-modal", "true");
      d.querySelector("input,button,textarea,select")?.focus();
    }
  }
  function closeDialog(id) {
    const d = $(id);
    if (d.close) d.close();
    else d.removeAttribute("open");
    if (id === "detail-dialog") {
      S.drawer = null;
      S.detailVersion++;
    }
  }
  $("detail-dialog").addEventListener("close", () => {
    S.drawer = null;
    S.detailVersion++;
  });
  function updateTimes() {
    document.querySelectorAll("[data-time]").forEach((n) => {
      n.textContent = relative(n.dataset.time);
    });
  }
  function setTheme() {
    if (S.theme === "system")
      document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = S.theme;
    $("theme").replaceChildren(
      icon(S.theme === "light" ? "sun" : "moon"),
      h(
        "span",
        {},
        `Appearance · ${S.theme[0].toUpperCase() + S.theme.slice(1)}`,
      ),
    );
    pref.set("theme", S.theme);
  }
  function updateChrome() {
    const d = S.data,
      attention =
        d.questions.length +
        d.incidents.filter((i) => i.state === "open").length +
        d.sessions.filter(needsAttention).length;
    for (const id of Object.keys(viewInfo)) {
      $(`nav-${id}`).classList.toggle("active", S.view === id);
      $(`nav-${id}`).setAttribute(
        "aria-current",
        S.view === id ? "page" : "false",
      );
    }
    for (const [id, n] of Object.entries({
      attention,
      sessions: d.sessions.length,
      resources: d.resources.length,
      messages: d.messages.length,
    })) {
      $(`count-${id}`).textContent = n;
      $(`count-${id}`).hidden = !S.connected || n === 0;
    }
    $("refresh").disabled = !S.connected || S.loading;
    $("connection-status").textContent = !S.connected
      ? "Not connected"
      : S.loading && !S.lastUpdate
        ? "Connecting"
        : !S.fresh
          ? "Connection interrupted"
          : S.failed.size
            ? "Partial connection"
            : "Live";
    $("connection-dot").className =
      "dot " +
      (S.connected ? (S.fresh && !S.failed.size ? "live" : "warn") : "");
    $("connect-button").textContent = S.connected ? "Connected" : "Connect";
    $("connect-button").title = S.connected
      ? "Connection settings"
      : "Connect to Accord";
    $("host-name").textContent = S.host?.name || "Your Accord";
    $("host-caption").textContent = S.connected
      ? `${isAdmin() ? "Operator" : "Agent"} · ${1 + new Set(d.hosts.map((h) => h.authority).filter((a) => a !== S.host?.authority)).size} host${d.hosts.some((h) => h.authority !== S.host?.authority) ? "s" : ""}`
      : "Connect to a host";
    document.title =
      (attention && S.connected ? `(${attention}) ` : "") +
      "Accord · " +
      (S.connected ? viewInfo[S.view][0] : "Mission control");
    $("notifications").replaceChildren(
      icon("bell"),
      h(
        "span",
        {},
        S.notifications ? "Notifications on" : "Enable notifications",
      ),
    );
    $("shortcuts").replaceChildren(
      icon("keyboard"),
      h("span", {}, "Keyboard shortcuts"),
    );
    const banner = $("banner");
    banner.replaceChildren();
    banner.hidden = !S.connected || (S.fresh && !S.failed.size && !S.paused);
    if (!banner.hidden) {
      banner.className = "banner";
      banner.append(
        h(
          "span",
          {},
          !S.fresh
            ? "Connection interrupted. Displayed activity is stale; ownership and capacity are unknown."
            : S.failed.size
              ? "Some observations are unavailable. A missing response never means a resource is free."
              : "New admissions are paused. Existing work and recovery continue.",
        ),
        button(
          S.paused && S.fresh ? "Resume admissions" : "Retry",
          () => (S.paused && S.fresh ? toggleAdmissions() : refresh()),
          { kind: "small", disabled: S.paused && !isAdmin() },
        ),
      );
    }
    updateTimes();
  }
  async function api(path, body, { auth = S.credential } = {}) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${auth}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      const data = await r.json();
      if (!r.ok)
        throw Object.assign(
          Error(data.error?.message || `Request failed (${r.status})`),
          { status: r.status, code: data.error?.code },
        );
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  const operation = (operation, args = {}, host) =>
    api("/v1/collaboration", { operation, args, ...(host ? { host } : {}) });
  function operationKey() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join("");
  }
  async function perform(id, op, args, host) {
    const version = S.connectionVersion;
    if (!S.fresh) throw Error("Reconnect before changing shared state.");
    const payload = JSON.stringify({ op, args, host });
    let intent = S.intents.get(id);
    if (intent && intent.payload !== payload)
      throw Error(
        "An earlier request is unconfirmed. Retry its original contents before changing this action.",
      );
    if (!intent) {
      intent = { key: operationKey(), payload };
      S.intents.set(id, intent);
    }
    if (S.busy.has(id)) throw Error("This request is already in progress.");
    S.busy.add(id);
    try {
      const result = await operation(op, { ...args, key: intent.key }, host);
      if (version !== S.connectionVersion)
        throw Error("Connection changed before the result arrived.");
      S.intents.delete(id);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) S.intents.delete(id);
      throw error;
    } finally {
      S.busy.delete(id);
    }
  }
  function notifyChanges() {
    const items = [
      ...S.data.questions.map((q) => ({ id: "q:" + q.id, kind: "question" })),
      ...S.data.incidents
        .filter((i) => i.state === "open")
        .map((i) => ({ id: `i:${i.id}:${i.episode}`, kind: "check-in" })),
    ];
    const fresh = items.filter((i) => !S.notified.has(i.id));
    items.forEach((i) => S.notified.add(i.id));
    if (
      S.notificationBaseline &&
      S.notifications &&
      fresh.length &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      try {
        const n = new Notification("Accord needs your attention", {
          body: `${fresh.length} new ${fresh.length === 1 ? "question or check-in" : "questions or check-ins"}. Open mission control to review.`,
          tag: "accord-attention",
        });
        n.onclick = () => {
          window.focus();
          navigate("attention");
          n.close();
        };
      } catch {
        toast(
          "This browser cannot display system notifications. The tab badge is still active.",
        );
        S.notifications = false;
      }
    }
    S.notificationBaseline = true;
  }
  async function refresh() {
    if (!S.credential || S.loading) return;
    clearTimeout(S.refreshTimer);
    const version = S.connectionVersion;
    S.loading = true;
    updateChrome();
    const requests = [
      ["awareness", () => api("/v1/awareness")],
      ["board", () => api(`/v1/board?after=${S.cursor}`)],
      ["directory", () => operation("find")],
      ["resources", () => operation("resources")],
      ["inbox", () => operation("inbox")],
    ];
    try {
      const results = await Promise.allSettled(requests.map(([, fn]) => fn()));
      if (version !== S.connectionVersion) return;
      const values = {};
      S.failed = new Set();
      for (let i = 0; i < results.length; i++) {
        const r = results[i],
          key = requests[i][0];
        if (r.status === "fulfilled") values[key] = r.value;
        else {
          S.failed.add(key);
          if (r.reason.status === 401) {
            disconnect();
            openConnection(
              "Your session ended or the credential was rejected.",
            );
            return;
          }
        }
      }
      S.fresh = !!values.awareness && !!values.board;
      const a = values.awareness;
      if (a) {
        Object.assign(S.data, {
          sessions: a.sessions || [],
          questions: a.questions || [],
          jobs: a.jobs || [],
          incidents: a.incidents || [],
          adapters: a.adapters,
        });
        S.data.awarenessHosts = a.hosts || [];
        if (S.searchResults)
          S.searchResults = S.searchResults.map(
            (s) =>
              S.data.sessions.find(
                (current) => current.address === s.address,
              ) || s,
          );
        if (S.drawer?.type === "session") {
          const current = sessionAt(S.drawer.address);
          if (current?.private) {
            S.detailVersion++;
            $("detail-content").replaceChildren(
              h("h2", { id: "detail-title" }, "Private session"),
              empty(
                "Activity is not shared",
                "The session owner has made this activity private.",
                "shield",
              ),
            );
            $("detail-actions").replaceChildren();
          }
        }
      }
      if (values.board) {
        S.paused = values.board.paused;
        S.cursor = values.board.cursor;
        S.data.tasks = values.board.tasks || [];
        S.data.claims = values.board.claims || [];
        const events = new Map(S.events.map((e) => [e.seq, e]));
        for (const e of values.board.events || []) events.set(e.seq, e);
        S.events = [...events.values()]
          .sort((a, b) => b.seq - a.seq)
          .slice(0, 200);
      }
      if (
        values.directory?.hosts?.some((h) => h.status === "unknown") ||
        a?.hosts?.some((h) => h.status === "unknown")
      )
        S.failed.add("linked-host");
      if (values.directory) {
        S.data.participants = values.directory.participants || [];
        S.data.hosts = values.directory.hosts || [];
      }
      if (values.resources)
        S.data.resources = mergeResources(
          values.resources.resources || [],
          values.directory?.hosts || [],
          S.data.resources,
          S.host.authority,
          !!values.directory,
        );
      if (values.inbox) S.data.messages = values.inbox.messages || [];
      if (S.fresh) {
        S.lastUpdate = Date.now();
        notifyChanges();
      }
      if (!S.fresh && S.drawer?.type === "session") {
        $("detail-content").replaceChildren(
          h("h2", { id: "detail-title" }, "Connection interrupted"),
          empty(
            "Activity unavailable",
            "Reconnect before reading current session activity.",
            "link",
          ),
        );
        $("detail-actions").replaceChildren();
        S.detailVersion++;
      }
      render();
    } catch (error) {
      if (version === S.connectionVersion) {
        S.fresh = false;
        render();
      }
    } finally {
      if (version === S.connectionVersion) {
        S.loading = false;
        updateChrome();
        if (S.view === "resources") void loadTelemetry();
        S.refreshTimer = setTimeout(
          refresh,
          document.hidden ? 15000 : S.fresh ? 5000 : 10000,
        );
      }
    }
  }

  function sessionCard(s) {
    const pinned = S.pins.has(s.address),
      src = sourceName(s.source);
    return h(
      "article",
      { class: "session-card" },
      h(
        "div",
        { class: "card-top" },
        h(
          "span",
          {
            class: `avatar ${["codex", "claude"].includes(s.source) ? s.source : "agent"}`,
          },
          src.slice(0, 2),
        ),
        h("span", { class: "source" }, src),
        badge(s.state),
      ),
      h(
        "button",
        {
          type: "button",
          class: "card-title clamp",
          onClick: () => openSession(s.address),
        },
        s.private ? "Private session" : s.title || "Untitled session",
      ),
      h(
        "p",
        { class: "card-summary clamp" },
        s.private
          ? "Activity is not shared."
          : s.summary || s.detail || "No activity summary yet.",
      ),
      h(
        "div",
        { class: "card-footer" },
        icon("folder"),
        h(
          "span",
          {
            class: "location",
            title: s.location || hostLabel(hostOf(s.address)),
          },
          s.location?.split("/").filter(Boolean).slice(-2).join("/") ||
            hostLabel(hostOf(s.address)),
        ),
        time(s.progressAt),
        iconButton(
          "pin",
          pinned ? "Unpin session" : "Pin session",
          () => {
            pinned ? S.pins.delete(s.address) : S.pins.add(s.address);
            pref.set("pins", [...S.pins]);
            render(true);
          },
          {
            class: `icon-button ${pinned ? "pinned" : ""}`,
            "aria-pressed": pinned ? "true" : "false",
          },
        ),
      ),
    );
  }
  function sessionCards(list) {
    return list.length
      ? h("div", { class: "cards" }, list.map(sessionCard))
      : empty(
          "No matching sessions",
          "Try another search or filter. Newly discovered agents appear here automatically.",
          "sessions",
        );
  }
  function questionCard(q) {
    const id = `answer-${q.id}`,
      draft = S.drafts.get(id) || "",
      err = S.errors.get(id),
      disabled = !S.fresh || !isAdmin() || S.busy.has(id),
      options = questionOptions(q);
    const field = h("textarea", {
      id,
      rows: 1,
      maxlength: 4000,
      "aria-label": "Answer to " + q.question,
      placeholder: "Choose an option or write your answer…",
      value: draft,
      disabled,
      onInput: (e) => {
        S.drafts.set(id, e.target.value);
      },
    });
    const error = h("p", { class: "inline-error", role: "alert" }, err || "");
    const submit = button(
      "Send answer",
      async () => {
        const answer = field.value.trim();
        if (!answer) {
          error.textContent = "Write an answer or choose an option.";
          field.focus();
          return;
        }
        submit.disabled = true;
        field.disabled = true;
        S.errors.delete(id);
        try {
          await perform(id, "answer", { id: q.id, answer });
          S.drafts.delete(id);
          S.data.questions = S.data.questions.filter((x) => x.id !== q.id);
          toast("Answer saved. The asking agent can now retrieve it.");
          render(true);
          await refresh();
        } catch (e) {
          S.errors.set(id, e.message);
          error.textContent = e.message;
          submit.disabled = !S.fresh;
          field.disabled = !S.fresh;
        }
      },
      { kind: "primary", glyph: "send", disabled },
    );
    const choices = h(
      "div",
      { class: "answer-options" },
      options.map((option) =>
        button(
          option,
          () => {
            field.value = option;
            S.drafts.set(id, option);
            choices
              .querySelectorAll("button")
              .forEach((b) =>
                b.setAttribute(
                  "aria-pressed",
                  b.textContent === option ? "true" : "false",
                ),
              );
            field.focus();
          },
          {
            kind: "small",
            "aria-pressed": draft === option ? "true" : "false",
            disabled,
          },
        ),
      ),
    );
    return h(
      "article",
      { class: "question-card" },
      h(
        "div",
        { class: "question-top" },
        icon("message"),
        h("strong", {}, actorLabel(q.actor)),
        h("span", {}, "asks"),
        time(q.created_at),
      ),
      h("h3", {}, q.question),
      choices,
      h("div", { class: "answer-field" }, field, submit),
      error,
      h(
        "div",
        { class: "question-bottom" },
        h("span", { class: "hint" }, "Your answer is saved in Accord."),
        button(
          "Dismiss",
          async () => {
            if (!confirm("Dismiss this question without answering?")) return;
            try {
              await perform(`dismiss-${q.id}`, "question-dismiss", {
                id: q.id,
              });
              S.data.questions = S.data.questions.filter((x) => x.id !== q.id);
              S.drafts.delete(id);
              render(true);
              await refresh();
            } catch (e) {
              toast(e.message, true);
            }
          },
          { kind: "quiet small", disabled },
        ),
      ),
    );
  }
  function incidentCard(i) {
    const address = i.session_id ? `${S.host.authority}/${i.session_id}` : null,
      s = address && sessionAt(address);
    return h(
      "article",
      { class: "incident" },
      icon("attention"),
      h(
        "div",
        { class: "incident-copy" },
        h("h3", {}, s?.title || "Overseer check-in"),
        h("p", {}, incidentReason(i)),
        h(
          "div",
          { class: "row-meta" },
          time(i.updated_at),
          ` · ${i.attempts || 0} notification attempts`,
        ),
        h(
          "div",
          { class: "actions" },
          s
            ? button("View session", () => openSession(address), {
                kind: "small",
                glyph: "sessions",
              })
            : null,
          button("View evidence", () => openEvidence("Overseer check-in", i), {
            kind: "quiet small",
          }),
        ),
      ),
    );
  }
  function resourceKnown(r) {
    return (
      S.fresh &&
      !S.failed.has("resources") &&
      !(S.failed.has("directory") && hostOf(r.id) !== S.host.authority) &&
      (!r.manager || r.manager.status !== "unknown")
    );
  }
  function resourceCard(r, mini = false) {
    const state = resourceState(r, resourceKnown(r)),
      holders = r.holders?.length ? r.holders : r.holder ? [r.holder] : [],
      owners = holders
        .map((o) => o.label || actorLabel(o.actor) || "Reserved")
        .join(", "),
      name = r.asset?.label || r.asset?.name || r.localId || r.id;
    if (mini)
      return h(
        "div",
        { class: "resource-mini" },
        h("div", { class: "row" }, h("strong", {}, name), badge(state)),
        h(
          "p",
          {},
          state === "unknown"
            ? "Current ownership is unconfirmed"
            : owners
              ? `Held by ${short(owners, 45)}`
              : state === "unclaimed"
                ? "No current holder"
                : "Host-managed resource",
        ),
      );
    const waiting = S.data.tasks.filter(
      (t) =>
        hostOf(r.id) === S.host.authority &&
        (t.resource === r.localId || t.resource === r.id) &&
        ["queued", "blocked"].includes(t.state),
    );
    return h(
      "article",
      { class: "resource-card" },
      h(
        "div",
        { class: "resource-head" },
        icon("resource"),
        h(
          "div",
          {},
          h("h3", {}, name),
          h("small", {}, hostLabel(hostOf(r.id))),
        ),
        badge(state),
      ),
      h(
        "div",
        { class: "owner-box" },
        h(
          "div",
          { class: "eyebrow" },
          state === "unknown" ? "Ownership unconfirmed" : "Current ownership",
        ),
        h(
          "p",
          {},
          state === "unknown"
            ? "The host has not confirmed current state. This resource must not be treated as available."
            : owners || "No current holder",
        ),
        holders[0]?.deadline
          ? h(
              "div",
              { class: "row-meta" },
              "Lease deadline · ",
              new Date(holders[0].deadline).toLocaleTimeString(),
            )
          : null,
      ),
      h(
        "p",
        { class: "resource-note" },
        h("strong", {}, r.enforcement || r.plugin || "Host managed"),
        state === "recovering" || state === "releasing"
          ? " · Recovery must finish before ownership can transfer."
          : " · Ownership is granted by the resource authority.",
      ),
      waiting.length
        ? h(
            "p",
            { class: "resource-note" },
            `${waiting.length} task${waiting.length === 1 ? "" : "s"} waiting`,
          )
        : null,
      h(
        "div",
        { class: "actions" },
        button(
          "Inspect resource",
          () => openEvidence(name, r, "Resource detail"),
          { kind: "small", glyph: "eye" },
        ),
        holders[0]?.actor
          ? button(
              "Message holder",
              () =>
                openComposer(
                  holders[0].actor.includes("/")
                    ? holders[0].actor
                    : `${hostOf(r.id)}/${holders[0].actor}`,
                ),
              { kind: "quiet small", glyph: "message", disabled: !S.fresh },
            )
          : null,
      ),
    );
  }
  function jobRows(jobs) {
    return jobs.length
      ? h(
          "div",
          {},
          jobs.map((j) =>
            h(
              "div",
              { class: "job-row" },
              icon("activity"),
              h(
                "div",
                { class: "job-copy" },
                h("strong", {}, j.title),
                h("p", {}, j.note || "No progress note"),
                Number.isFinite(j.progress?.fraction)
                  ? h("progress", {
                      max: 1,
                      value: j.progress.fraction,
                      "aria-label": "Job progress",
                    })
                  : null,
              ),
              badge(j.state),
            ),
          ),
        )
      : h(
          "p",
          { class: "quiet-note" },
          "No jobs have been reported yet. Agents can publish job progress through Accord.",
        );
  }
  function hostRows() {
    const hosts = new Map([
      [
        S.host.authority,
        {
          authority: S.host.authority,
          status: S.fresh ? "reachable" : "unknown",
          name: S.host.name,
        },
      ],
    ]);
    for (const item of [...S.data.hosts, ...(S.data.awarenessHosts || [])])
      if (item.authority !== S.host.authority)
        hosts.set(item.authority, { ...hosts.get(item.authority), ...item });
    return h(
      "div",
      {},
      [...hosts.values()].map((host) =>
        h(
          "div",
          { class: "host-row" },
          icon("resource"),
          h(
            "div",
            {},
            h("strong", {}, host.name || hostLabel(host.authority)),
            h(
              "small",
              {},
              host.authority === S.host.authority ? "This host" : "Linked host",
            ),
          ),
          badge(
            S.fresh &&
              ["ok", "online", "reachable", "observed"].includes(host.status)
              ? "active"
              : "unknown",
            S.fresh &&
              ["ok", "online", "reachable", "observed"].includes(host.status)
              ? "Connected"
              : "Unknown",
          ),
        ),
      ),
    );
  }
  function overview() {
    const d = S.data,
      working = d.sessions.filter((s) =>
        ["working", "starting"].includes(s.state),
      ).length,
      attention =
        d.questions.length +
        d.incidents.filter((i) => i.state === "open").length +
        d.sessions.filter(needsAttention).length,
      held = d.resources.filter((r) => r.holder || r.holders?.length).length;
    const stats = h(
      "div",
      { class: "stats" },
      [
        ["sessions", "sessions", working, "Sessions working"],
        ["attention", "attention", attention, "Need attention"],
        [
          "resources",
          "resource",
          `${held} / ${d.resources.length}`,
          "Resources held",
        ],
        ["messages", "message", d.messages.length, "Inbox messages"],
      ].map(([view, glyph, n, label]) =>
        h(
          "button",
          {
            type: "button",
            class: `stat ${view}`,
            onClick: () => navigate(view),
          },
          h("span", { class: "stat-icon" }, icon(glyph)),
          h(
            "div",
            {},
            h("div", { class: "stat-number" }, n),
            h("div", { class: "stat-label" }, label),
          ),
        ),
      ),
    );
    const left = h("div", {}),
      right = h("aside", {
        class: "aside-stack",
        "aria-label": "Resources and network",
      });
    if (d.questions.length)
      left.append(
        section(
          "A decision is waiting",
          h("div", {}, d.questions.slice(0, 2).map(questionCard)),
          {
            count: d.questions.length,
            action: button("View all", () => navigate("attention"), {
              kind: "quiet small",
              glyph: "arrow",
            }),
          },
        ),
      );
    else if (d.incidents.some((i) => i.state === "open"))
      left.append(
        section(
          "Worth a check-in",
          incidentCard(d.incidents.find((i) => i.state === "open")),
          {
            action: button("View all", () => navigate("attention"), {
              kind: "quiet small",
              glyph: "arrow",
            }),
          },
        ),
      );
    const list = visibleSessions(d.sessions, { pins: S.pins })
      .sort(
        (a, b) =>
          Number(S.pins.has(b.address)) - Number(S.pins.has(a.address)) ||
          Number(terminal.has(a.state)) - Number(terminal.has(b.state)) ||
          b.progressAt - a.progressAt,
      )
      .slice(0, 6);
    left.append(
      section("In motion", sessionCards(list), {
        count: d.sessions.length,
        action: button("All sessions", () => navigate("sessions"), {
          kind: "quiet small",
          glyph: "arrow",
        }),
      }),
    );
    if (d.jobs.length)
      left.append(
        section(
          "Tracked work",
          panel("Jobs", jobRows(d.jobs.slice(0, 4)), "activity"),
        ),
      );
    right.append(
      panel(
        "Shared resources",
        [
          d.resources.length
            ? d.resources.slice(0, 5).map((r) => resourceCard(r, true))
            : h("p", { class: "quiet-note" }, "No resources registered."),
          h(
            "div",
            { class: "panel-footer" },
            button("Explore resources", () => navigate("resources"), {
              kind: "quiet small",
              glyph: "arrow",
            }),
          ),
        ],
        "resource",
      ),
    );
    right.append(
      panel(
        "Your network",
        [
          hostRows(),
          h(
            "div",
            { class: "panel-footer" },
            h(
              "p",
              { class: "quiet-note" },
              `${d.participants.length} discoverable participants. Agents and resource managers meet here.`,
            ),
          ),
        ],
        "link",
      ),
    );
    right.append(
      panel(
        "Watching the work",
        [
          h(
            "p",
            { class: "quiet-note" },
            "The overseer checks reported progress and configured resource signals, then sends check-ins when something needs attention.",
          ),
          h(
            "div",
            { class: "health-line" },
            h("span", {
              class: `dot ${["ready", "running"].includes(d.adapters?.state) ? "live" : "warn"}`,
            }),
            ["ready", "running"].includes(d.adapters?.state)
              ? "Session observation active"
              : "Observation status not confirmed",
          ),
          h(
            "p",
            { class: "quiet-note panel-footer" },
            "Check-ins do not take ownership or interrupt workloads.",
          ),
        ],
        "eye",
      ),
    );
    return [stats, h("div", { class: "overview-grid" }, left, right)];
  }
  function attentionView() {
    const d = S.data,
      open = d.incidents.filter((i) => i.state === "open"),
      waiting = d.sessions.filter(needsAttention);
    return [
      !isAdmin()
        ? h(
            "div",
            { class: "banner" },
            "Questions for the operator are visible with an operator credential.",
          )
        : null,
      d.questions.length
        ? section("Questions", h("div", {}, d.questions.map(questionCard)), {
            count: d.questions.length,
          })
        : null,
      open.length
        ? section("Overseer check-ins", h("div", {}, open.map(incidentCard)), {
            count: open.length,
          })
        : null,
      waiting.length
        ? section("Waiting or blocked", sessionCards(waiting), {
            count: waiting.length,
          })
        : null,
      !d.questions.length && !open.length && !waiting.length
        ? empty(
            "Nothing needs you right now",
            "Keep the tab open. New questions and check-ins will appear here.",
            "check",
          )
        : null,
    ];
  }
  function sessionView() {
    const results =
        S.query.trim() && S.searchResults !== null
          ? S.searchResults
          : S.data.sessions,
      list = visibleSessions(results, {
        filter: S.filter,
        source: S.source,
        query: S.searchResults !== null ? "" : S.query,
        pins: S.pins,
      });
    const select = h(
      "select",
      {
        class: "select-small",
        "aria-label": "Session source",
        onChange: (e) => {
          S.source = e.target.value;
          render(true);
        },
      },
      h("option", { value: "all" }, "All sources"),
      [...new Set(S.data.sessions.map((s) => s.source))]
        .sort()
        .map((s) => h("option", { value: s }, sourceName(s))),
    );
    select.value = S.source;
    const people = S.query.trim()
      ? S.data.participants.filter((p) =>
          [p.label, p.activity, p.location, ...(p.capabilities || [])].some(
            (v) =>
              String(v || "")
                .toLowerCase()
                .includes(S.query.trim().toLowerCase()),
          ),
        )
      : [];
    return [
      h(
        "div",
        { class: "filters" },
        h(
          "div",
          { class: "chip-group" },
          [
            ["all", "All"],
            ["working", "Working"],
            ["waiting", "Waiting"],
            ["done", "Finished"],
            ["pinned", "Pinned"],
          ].map(([id, title]) =>
            h(
              "button",
              {
                type: "button",
                class: `chip ${S.filter === id ? "active" : ""}`,
                "aria-pressed": S.filter === id ? "true" : "false",
                onClick: () => {
                  S.filter = id;
                  render(true);
                },
              },
              title,
            ),
          ),
        ),
        select,
      ),
      S.query
        ? h(
            "p",
            { class: "hint search-note", role: "status" },
            S.searching
              ? "Searching session history…"
              : `${list.length} result${list.length === 1 ? "" : "s"} for “${S.query}”${S.searchError ? " · Search unavailable; showing local title matches" : ""}`,
          )
        : null,
      sessionCards(list),
      people.length
        ? section(
            "Collaborators",
            h(
              "div",
              { class: "cards" },
              people.map((p) =>
                h(
                  "article",
                  { class: "session-card" },
                  h(
                    "div",
                    { class: "card-top" },
                    h("span", { class: "avatar agent" }, icon("message")),
                    h("h3", {}, p.label),
                    badge(
                      p.presence === "recent" ? "active" : "unknown",
                      p.presence === "recent" ? "Recent" : "Unknown",
                    ),
                  ),
                  h(
                    "p",
                    { class: "card-summary" },
                    p.activity || "No activity reported",
                  ),
                  h(
                    "div",
                    { class: "card-footer" },
                    h(
                      "span",
                      { class: "location" },
                      hostLabel(hostOf(p.address)),
                    ),
                    button("Message", () => openComposer(p.address), {
                      kind: "small",
                      disabled: !S.fresh,
                    }),
                  ),
                ),
              ),
            ),
            { count: people.length },
          )
        : null,
    ];
  }
  function resourceView() {
    const telemetryHost = h(
      "select",
      {
        class: "select-small",
        "aria-label": "Telemetry host",
        onChange: (e) => {
          S.telemetryAuthority = e.target.value;
          S.telemetry = null;
          S.metadata = null;
          S.telemetryFetched = 0;
          void loadTelemetry(true);
        },
      },
      h("option", { value: S.host.authority }, S.host.name),
      S.data.hosts
        .filter((h) => h.authority !== S.host.authority)
        .map((host) =>
          h("option", { value: host.authority }, hostLabel(host.authority)),
        ),
    );
    telemetryHost.value = S.telemetryAuthority || S.host.authority;
    return [
      h(
        "div",
        { class: "resource-grid" },
        S.data.resources.map((r) => resourceCard(r)),
      ),
      !S.data.resources.length
        ? empty(
            "No shared resources yet",
            "Register an asset with a host connector. Its owner and recovery state will appear here.",
            "resource",
          )
        : null,
      section(
        "Machine telemetry",
        h("div", { id: "telemetry-content" }, telemetryPanel()),
        {
          action: h(
            "div",
            { class: "actions" },
            telemetryHost,
            button("Refresh sample", () => loadTelemetry(true), {
              kind: "small",
              glyph: "refresh",
              disabled: !S.fresh,
            }),
          ),
        },
      ),
      section(
        "Queued and running work",
        panel(
          "Tasks",
          S.data.tasks.some((t) => !terminal.has(t.state))
            ? h(
                "div",
                {},
                S.data.tasks
                  .filter((t) => !terminal.has(t.state))
                  .map((t) =>
                    h(
                      "div",
                      { class: "job-row" },
                      icon("clock"),
                      h(
                        "div",
                        { class: "job-copy" },
                        h("strong", {}, t.title),
                        h("p", {}, t.checkpoint || t.blockedBy || t.resource),
                      ),
                      badge(t.state),
                      isAdmin()
                        ? button("Cancel", () => cancelTask(t), {
                            kind: "small danger",
                            disabled: !S.fresh,
                          })
                        : null,
                    ),
                  ),
              )
            : h("p", { class: "quiet-note" }, "No tasks queued on this host."),
        ),
      ),
      section("Network", panel("Connected hosts", hostRows(), "link")),
    ];
  }
  function telemetryPanel() {
    if (!S.telemetry)
      return h(
        "p",
        { class: "quiet-note" },
        S.telemetryLoading
          ? "Requesting a live sample from this host…"
          : S.telemetryError ||
              "Live telemetry is fetched on demand from this host.",
      );
    const t = S.telemetry,
      host = t.host || {},
      metrics = [
        ["CPU", host.cpu?.utilization, "%"],
        ["GPU", host.gpu?.utilization, "%"],
        ["Memory", host.memory?.pressureUtilization, "%"],
        ["Temperature", host.gpu?.temperatureC ?? host.thermal?.hottestC, "°C"],
      ];
    return panel(
      hostLabel(S.telemetryAuthority || S.host.authority),
      [
        S.metadata?.machine
          ? h(
              "p",
              { class: "quiet-note machine-meta" },
              [
                S.metadata.machine.cpu?.model,
                S.metadata.machine.cpu?.logicalCpus
                  ? `${S.metadata.machine.cpu.logicalCpus} logical CPUs`
                  : null,
                Number.isFinite(S.metadata.machine.memory?.totalBytes)
                  ? `${Math.round(S.metadata.machine.memory.totalBytes / 2 ** 30)} GB memory`
                  : null,
                ...(S.metadata.machine.devices || []).map((d) => d.name),
              ]
                .filter(Boolean)
                .join(" · "),
            )
          : null,
        h(
          "div",
          { class: "metric-grid" },
          metrics.map(([label, value, unit]) =>
            h(
              "div",
              { class: "metric" },
              h("span", {}, label),
              h(
                "strong",
                {},
                Number.isFinite(value) ? `${Math.round(value)}${unit}` : "—",
              ),
              Number.isFinite(value)
                ? unit === "%"
                  ? h("progress", {
                      value,
                      max: 100,
                      "aria-label": `${label} utilization`,
                    })
                  : null
                : h("span", {}, "Not reported"),
            ),
          ),
        ),
        h(
          "p",
          { class: "quiet-note panel-footer" },
          t.stale ||
            S.telemetryError ||
            !S.fresh ||
            Date.now() - timestamp(t.sampledAt) > 15000
            ? "Sample is stale or unreachable. Missing telemetry never means idle."
            : "A live sample, separate from resource ownership.",
          t.sampledAt ? h("span", {}, " · ", time(t.sampledAt)) : null,
        ),
      ],
      "activity",
    );
  }
  async function loadTelemetry(force = false) {
    if (
      !S.connected ||
      S.telemetryLoading ||
      !S.fresh ||
      (!force && S.telemetry && Date.now() - (S.telemetryFetched || 0) < 15000)
    )
      return;
    const version = S.connectionVersion,
      authority = S.telemetryAuthority || S.host.authority;
    S.telemetryLoading = true;
    S.telemetryError = null;
    $("telemetry-content")?.replaceChildren(telemetryPanel());
    try {
      const base =
        authority === S.host.authority
          ? "/v1/host"
          : `/v1/hosts/${encodeURIComponent(authority)}`;
      const results = await Promise.allSettled([
        api(base + "/telemetry"),
        api(base + "/metadata"),
      ]);
      if (
        version === S.connectionVersion &&
        authority === (S.telemetryAuthority || S.host.authority)
      ) {
        if (results[0].status === "rejected") throw results[0].reason;
        S.telemetry = results[0].value;
        S.metadata =
          results[1].status === "fulfilled" ? results[1].value : null;
        S.telemetryFetched = Date.now();
      }
    } catch (e) {
      if (version === S.connectionVersion)
        S.telemetryError =
          "Telemetry is unavailable. Ownership remains unchanged.";
    } finally {
      if (version === S.connectionVersion) {
        S.telemetryLoading = false;
        $("telemetry-content")?.replaceChildren(telemetryPanel());
        if (authority !== (S.telemetryAuthority || S.host.authority))
          void loadTelemetry(true);
      }
    }
  }
  function messageCard(m) {
    return h(
      "article",
      { class: "message-card" },
      h(
        "div",
        { class: "message-head" },
        h("span", { class: "avatar agent" }, icon("message")),
        h("strong", {}, labelFor(m.from)),
        h(
          "span",
          { class: "badge" },
          m.kind === "notification" ? "Attention requested" : "Message",
        ),
        time(m.at),
      ),
      h("p", { class: "message-body" }, m.text),
      h(
        "div",
        { class: "actions" },
        button(
          "Mark read",
          async () => {
            try {
              await perform("read-" + m.deliveryId, "read", {
                deliveryId: m.deliveryId,
              });
              S.data.messages = S.data.messages.filter(
                (x) => x.deliveryId !== m.deliveryId,
              );
              render(true);
              await refresh();
            } catch (e) {
              toast(e.message, true);
            }
          },
          { kind: "small", glyph: "check", disabled: !S.fresh },
        ),
        button("Reply", () => openComposer(m.from), {
          kind: "small",
          glyph: "message",
          disabled: !S.fresh,
        }),
      ),
    );
  }
  function messagesView() {
    return [
      h(
        "p",
        { class: "quiet-note search-note" },
        "This inbox belongs to the connected credential. Operator and agent inboxes are separate.",
      ),
      S.data.messages.length
        ? h("div", {}, S.data.messages.map(messageCard))
        : empty(
            "Your inbox is clear",
            "Messages addressed to this operator or agent arrive here.",
            "message",
          ),
      S.sent.length
        ? section(
            "Sent from this tab",
            h(
              "div",
              {},
              S.sent.map((m) =>
                h(
                  "article",
                  { class: "message-card" },
                  h(
                    "div",
                    { class: "message-head" },
                    h("strong", {}, "To " + labelFor(m.to)),
                    badge(
                      m.state === "delivered"
                        ? "done"
                        : m.state === "failed"
                          ? "failed"
                          : "queued",
                      m.state === "delivered"
                        ? "Delivered to inbox"
                        : m.state === "failed"
                          ? "Delivery failed"
                          : "Queued",
                    ),
                    time(m.at),
                  ),
                  h("p", { class: "message-body" }, m.text),
                  button(
                    "Check delivery",
                    async () => {
                      try {
                        const r = await operation("sent", { id: m.id });
                        m.state = r.state;
                        render(true);
                      } catch (e) {
                        toast(e.message, true);
                      }
                    },
                    { kind: "small", disabled: !S.fresh },
                  ),
                ),
              ),
            ),
          )
        : null,
    ];
  }
  function eventTitle(e) {
    return String(e.kind || "event")
      .replace(/[._-]/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
  }
  function activityView() {
    return S.events.length
      ? panel(
          "Host event log",
          h(
            "ol",
            { class: "log-list" },
            S.events.map((e) =>
              h(
                "li",
                { class: "log-row" },
                icon("activity"),
                h(
                  "div",
                  { class: "log-copy" },
                  h("strong", {}, eventTitle(e)),
                  h(
                    "small",
                    {},
                    e.data?.title ||
                      e.data?.note ||
                      (e.data?.actor && actorLabel(e.data.actor)) ||
                      `Event ${e.seq}`,
                  ),
                  h(
                    "details",
                    {},
                    h("summary", {}, "Details"),
                    h("pre", {}, JSON.stringify(e.data, null, 2)),
                  ),
                ),
                time(e.at),
              ),
            ),
          ),
          "activity",
        )
      : empty(
          "The record starts here",
          "Resource, session, and messaging events will appear as work happens.",
          "activity",
        );
  }
  function welcome() {
    return h(
      "div",
      { class: "welcome" },
      h("div", { class: "brand-mark" }, icon("spark")),
      h("div", { class: "eyebrow" }, "A shared place for independent agents"),
      h("h1", {}, "Good work, together."),
      h(
        "p",
        {},
        "See what your agents are doing. Keep conversations moving. Share resources with confidence.",
      ),
      h(
        "div",
        { class: "actions" },
        button("Connect to Accord", () => openConnection(), {
          kind: "primary",
          glyph: "arrow",
        }),
      ),
      h("p", { class: "hint" }, "Standalone. Cross-platform. Yours to steer."),
      h(
        "div",
        { class: "welcome-features" },
        [
          [
            "sessions",
            "See the work",
            "Live sessions, useful summaries, and searchable activity across your tools.",
          ],
          [
            "message",
            "Keep it moving",
            "Answer questions, message collaborators, and catch work that needs a nudge.",
          ],
          [
            "resource",
            "Share with confidence",
            "Know who owns each resource, who is waiting, and when recovery is still in progress.",
          ],
        ].map(([glyph, title, description]) =>
          h(
            "div",
            { class: "welcome-feature" },
            icon(glyph),
            h("h3", {}, title),
            h("p", {}, description),
          ),
        ),
      ),
      h(
        "div",
        { class: "setup" },
        h(
          "p",
          { class: "quiet-note" },
          "Agents join with the Accord skill or MCP connection. This dashboard connects to the host serving this page.",
        ),
      ),
    );
  }
  function render(force = false) {
    updateChrome();
    const signature = JSON.stringify([
      S.connected,
      S.fresh,
      [...S.failed],
      S.view,
      S.filter,
      S.source,
      S.query,
      S.searching,
      S.searchResults,
      S.searchError,
      S.data,
      S.events,
      S.sent,
      [...S.pins],
      S.paused,
    ]);
    if (!force && signature === S.renderSignature) return;
    S.renderSignature = signature;
    const active = document.activeElement,
      focus =
        active?.id && $("page").contains(active)
          ? {
              id: active.id,
              start: active.selectionStart,
              end: active.selectionEnd,
            }
          : null;
    if (!S.connected) {
      $("page").replaceChildren(welcome());
      return;
    }
    const [title, description] = viewInfo[S.view],
      action =
        S.view === "resources" && isAdmin()
          ? button(
              S.paused ? "Resume admissions" : "Pause admissions",
              toggleAdmissions,
              {
                kind: "small",
                glyph: S.paused ? "play" : "pause",
                disabled: !S.fresh,
              },
            )
          : button("New message", () => openComposer(), {
              kind: "primary",
              glyph: "message",
              disabled: !S.fresh,
            });
    const body = {
      overview,
      attention: attentionView,
      sessions: sessionView,
      resources: resourceView,
      messages: messagesView,
      activity: activityView,
    }[S.view]();
    $("page").replaceChildren(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          {},
          h("div", { class: "eyebrow" }, S.host?.name || "Your Accord"),
          h("h1", {}, title),
          h("p", {}, description),
        ),
        h("div", { class: "actions" }, action),
      ),
      ...[body].flat().filter(Boolean),
      h(
        "footer",
        { class: "footnote" },
        h("span", {}, "Accord · Independent agents. Shared understanding."),
        h(
          "span",
          {},
          S.lastUpdate ? "Last confirmed " : "Waiting for observations",
          S.lastUpdate ? time(S.lastUpdate) : null,
        ),
      ),
    );
    if (focus && $(focus.id)) {
      const n = $(focus.id);
      n.focus({ preventScroll: true });
      if (focus.start != null && n.setSelectionRange)
        n.setSelectionRange(focus.start, focus.end);
    }
    if (S.view === "resources") void loadTelemetry();
  }
  function navigate(view) {
    if (!viewInfo[view]) return;
    S.view = view;
    document.body.classList.remove("nav-open");
    $("nav-scrim").hidden = true;
    $("menu-toggle").setAttribute("aria-expanded", "false");
    render(true);
    $("main").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  async function copy(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast("Copied to clipboard.");
      } else throw Error();
    } catch {
      const field = h("textarea", {
        value: text,
        readonly: true,
        "aria-label": "Copy this value",
      });
      $("detail-content").append(field);
      field.focus();
      field.select();
      toast("Select and copy the value shown in the details panel.");
    }
  }
  function openEvidence(title, value, kicker = "Event detail") {
    S.drawer = { type: "evidence" };
    S.detailVersion++;
    $("detail-kicker").textContent = kicker;
    $("detail-content").replaceChildren(
      h("h2", { id: "detail-title" }, title),
      h(
        "p",
        { class: "detail-summary" },
        "Recorded by Accord. Inspecting this record does not change ownership.",
      ),
      h("pre", { class: "evidence-text" }, JSON.stringify(value, null, 2)),
    );
    $("detail-actions").replaceChildren(
      button("Copy details", () => copy(JSON.stringify(value, null, 2)), {
        glyph: "copy",
      }),
    );
    showDialog("detail-dialog");
  }
  async function openSession(address) {
    const s =
      sessionAt(address) || S.searchResults?.find((x) => x.address === address);
    if (!s) return;
    S.drawer = { type: "session", address };
    const version = ++S.detailVersion,
      connection = S.connectionVersion;
    $("detail-kicker").textContent = "Session activity";
    $("detail-content").replaceChildren(
      h(
        "h2",
        { id: "detail-title" },
        s.private ? "Private session" : s.title || "Session",
      ),
      h(
        "p",
        { class: "detail-summary" },
        s.private ? "Activity is not shared." : "Loading activity…",
      ),
    );
    $("detail-actions").replaceChildren();
    showDialog("detail-dialog");
    if (s.private) return;
    if (!S.fresh) {
      $("detail-content").append(
        empty(
          "Connection interrupted",
          "Reconnect before reading current activity.",
          "link",
        ),
      );
      return;
    }
    try {
      const result = await operation(
        "session-read",
        { id: s.id, limit: 100 },
        hostOf(address) === S.host.authority ? undefined : hostOf(address),
      );
      if (version !== S.detailVersion || connection !== S.connectionVersion)
        return;
      const current = result.session;
      if (current.private) {
        $("detail-content").replaceChildren(
          h("h2", { id: "detail-title" }, "Private session"),
          empty(
            "Activity is not shared",
            "The session owner has made this session private.",
            "shield",
          ),
        );
        return;
      }
      $("detail-content").replaceChildren(
        h(
          "div",
          { class: "card-top" },
          h(
            "span",
            { class: "avatar agent" },
            sourceName(current.source).slice(0, 2),
          ),
          h("span", { class: "source" }, sourceName(current.source)),
          badge(current.state),
        ),
        h("h2", { id: "detail-title" }, current.title || "Session"),
        h(
          "p",
          { class: "detail-summary" },
          current.summary || current.detail || "No summary yet.",
        ),
        h(
          "dl",
          { class: "detail-meta" },
          h("dt", {}, "Workspace"),
          h("dd", {}, current.location || "Not reported"),
          h("dt", {}, "Last progress"),
          h("dd", {}, time(current.progressAt)),
          h("dt", {}, "Presence"),
          h("dd", {}, current.presence || "Unknown"),
          h("dt", {}, "Summary"),
          h("dd", {}, current.summaryKind || "Not available"),
        ),
        h("h3", { class: "subhead" }, "Recent activity"),
        ...(result.events?.length
          ? result.events.map((e) =>
              h(
                "div",
                {
                  class: `activity-item ${["tool", "tool-result"].includes(e.kind) ? e.kind : ""}`,
                },
                h(
                  "div",
                  { class: "activity-label" },
                  h("span", {}, eventTitle(e)),
                  time(e.at),
                ),
                h("div", { class: "activity-text" }, e.body),
              ),
            )
          : [
              h(
                "p",
                { class: "quiet-note" },
                "No shared activity has been recorded.",
              ),
            ]),
      );
      $("detail-actions").replaceChildren(
        button("Message session", () => openComposer(address), {
          kind: "primary",
          glyph: "message",
          disabled: !S.fresh,
        }),
        iconButton("copy", "Copy session address", () => copy(address)),
        iconButton("refresh", "Refresh session activity", () =>
          openSession(address),
        ),
        hostOf(address) === S.host.authority && isAdmin()
          ? button(
              "Snooze checks · 1h",
              async () => {
                try {
                  await perform("snooze-" + current.id, "session-snooze", {
                    id: current.id,
                    until: Date.now() + 3600000,
                  });
                  toast("Overseer checks snoozed for one hour.");
                  await refresh();
                } catch (e) {
                  toast(e.message, true);
                }
              },
              { kind: "small", disabled: !S.fresh },
            )
          : document.createTextNode(""),
      );
    } catch (e) {
      if (version !== S.detailVersion) return;
      $("detail-content").replaceChildren(
        h("h2", { id: "detail-title" }, "Activity unavailable"),
        empty("Could not read this session", e.message, "shield"),
      );
    }
  }
  function openConnection(message = "") {
    $("connect-error").textContent = message;
    $("connection-details").hidden = !S.connected;
    $("connect-form").hidden = S.connected;
    $("connect-title").textContent = S.connected
      ? "Connected to Accord"
      : "Enter your Accord";
    if (S.connected) {
      const adapters = S.data.adapters;
      $("connection-details").className = "connection-details";
      $("connection-details").replaceChildren(
        h("p", {}, h("strong", {}, S.host.name)),
        h("p", {}, `${isAdmin() ? "Operator" : "Agent"} · ${location.origin}`),
        h("p", {}, "Credential is held in this tab’s memory only."),
        h("p", {}, `Session observers: ${adapters?.state || "unknown"}`),
        h(
          "div",
          { class: "actions" },
          button(
            "Disconnect",
            () => {
              disconnect();
              closeDialog("connect-dialog");
            },
            { glyph: "logout" },
          ),
        ),
      );
    }
    showDialog("connect-dialog");
    if (!S.connected) $("token").focus();
  }
  function disconnect() {
    S.connectionVersion++;
    clearTimeout(S.refreshTimer);
    S.credential = "";
    S.me = null;
    S.host = null;
    S.connected = false;
    S.fresh = false;
    S.loading = false;
    S.lastUpdate = null;
    S.cursor = 0;
    S.events = [];
    S.sent = [];
    S.telemetry = null;
    S.metadata = null;
    S.telemetryAuthority = null;
    S.telemetryLoading = false;
    S.telemetryError = null;
    S.telemetryFetched = 0;
    S.data = {
      sessions: [],
      questions: [],
      incidents: [],
      jobs: [],
      participants: [],
      resources: [],
      hosts: [],
      messages: [],
      tasks: [],
    };
    S.drafts.clear();
    S.errors.clear();
    S.intents.clear();
    S.busy.clear();
    S.notified.clear();
    S.notificationBaseline = false;
    S.failed.clear();
    S.paused = false;
    S.searchResults = null;
    S.searchSerial++;
    S.searching = false;
    S.query = "";
    $("search").value = "";
    $("token").value = "";
    $("credential-file").value = "";
    $("message-text").value = "";
    $("recipient").replaceChildren();
    $("recipient-address").value = "";
    $("detail-content").replaceChildren();
    $("detail-actions").replaceChildren();
    $("connection-details").replaceChildren();
    $("toasts").replaceChildren();
    for (const id of ["detail-dialog", "compose-dialog"]) closeDialog(id);
    render(true);
  }
  $("connect-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const credential = $("token").value.trim();
    if (!credential) return;
    $("connect-submit").disabled = true;
    $("connect-error").textContent = "";
    const version = ++S.connectionVersion;
    try {
      const [identity, boot] = await Promise.all([
        api("/v1/me", undefined, { auth: credential }),
        api("/v1/bootstrap", undefined, { auth: credential }),
      ]);
      if (version !== S.connectionVersion) return;
      S.credential = credential;
      S.me = identity;
      S.host = boot.host;
      S.connected = true;
      S.lastUpdate = null;
      $("token").value = "";
      $("credential-file").value = "";
      closeDialog("connect-dialog");
      await refresh();
    } catch (error) {
      if (version === S.connectionVersion)
        $("connect-error").textContent = error.message;
    } finally {
      $("connect-submit").disabled = false;
    }
  });
  document.querySelector(".file-label").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("credential-file").click();
    }
  });
  $("credential-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024) {
      $("connect-error").textContent = "Choose a token file smaller than 1 KB.";
      e.target.value = "";
      return;
    }
    $("token").value = (await file.text()).trim();
    e.target.value = "";
    $("connect-submit").focus();
  });
  function recipientVisibility() {
    const manual = $("recipient").value === "manual";
    $("recipient-address").hidden = !manual;
    $("address-label").hidden = !manual;
    $("recipient-address").required = manual;
  }
  function openComposer(address) {
    if (!S.connected) {
      openConnection();
      return;
    }
    if ($("detail-dialog").open) closeDialog("detail-dialog");
    const previous = $("recipient").value;
    const people = new Map(
      S.data.participants.map((p) => [p.address, p.label || p.address]),
    );
    for (const s of S.data.sessions)
      if (!s.private && !people.has(s.address)) people.set(s.address, s.title);
    if (address && !people.has(address)) people.set(address, labelFor(address));
    $("recipient").replaceChildren(
      h("option", { value: "" }, "Choose a collaborator…"),
      ...[...people]
        .filter(([a]) => a !== myAddress())
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([a, label]) =>
          h(
            "option",
            { value: a },
            short(label, 65) + " · " + hostLabel(hostOf(a)),
          ),
        ),
      h("option", { value: "manual" }, "Enter an address…"),
    );
    $("recipient").value = address || previous || "";
    recipientVisibility();
    $("compose-error").textContent = "";
    showDialog("compose-dialog");
    (address ? $("message-text") : $("recipient")).focus();
  }
  $("recipient").addEventListener("change", recipientVisibility);
  $("message-text").addEventListener("input", () => {
    $("message-count").textContent =
      `${$("message-text").value.length.toLocaleString()} / 4,000`;
  });
  $("compose-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const to =
        $("recipient").value === "manual"
          ? $("recipient-address").value.trim()
          : $("recipient").value,
      text = $("message-text").value.trim();
    if (!to || !text) return;
    $("message-submit").disabled = true;
    $("compose-error").textContent = "";
    try {
      const result = await perform("compose", "send", {
        to,
        text,
        kind: $("message-notify").checked ? "notification" : "message",
      });
      S.sent.unshift({
        id: result.id,
        to,
        text,
        state: result.state,
        at: Date.now(),
      });
      $("message-text").value = "";
      $("message-count").textContent = "0 / 4,000";
      $("message-notify").checked = false;
      closeDialog("compose-dialog");
      toast("Message queued for delivery.");
      render(true);
    } catch (error) {
      $("compose-error").textContent = error.message;
    } finally {
      $("message-submit").disabled = false;
    }
  });
  let searchTimer;
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    S.query = $("search").value;
    S.searchResults = null;
    S.searchError = null;
    const serial = ++S.searchSerial,
      connection = S.connectionVersion;
    if (!S.connected) return;
    S.view = "sessions";
    S.searching = !!S.query.trim();
    render(true);
    if (!S.query.trim()) return;
    searchTimer = setTimeout(async () => {
      try {
        const result = await operation("sessions", { query: S.query.trim() });
        if (serial !== S.searchSerial || connection !== S.connectionVersion)
          return;
        S.searchResults = (result.sessions || []).map(
          (s) =>
            S.data.sessions.find(
              (current) => current.address === s.address && current.private,
            ) || s,
        );
      } catch {
        if (serial !== S.searchSerial || connection !== S.connectionVersion)
          return;
        S.searchError = true;
      } finally {
        if (serial === S.searchSerial && connection === S.connectionVersion) {
          S.searching = false;
          render(true);
        }
      }
    }, 350);
  });
  async function cancelTask(task) {
    if (
      !isAdmin() ||
      !S.fresh ||
      !confirm(
        `Cancel “${task.title}”? The host will recover any held resource before handing it to another agent.`,
      )
    )
      return;
    const id = "cancel-" + task.id,
      version = S.connectionVersion;
    if (S.busy.has(id)) return;
    let intent = S.intents.get(id);
    if (!intent) {
      intent = { key: operationKey() };
      S.intents.set(id, intent);
    }
    S.busy.add(id);
    try {
      await api(`/v1/tasks/${encodeURIComponent(task.id)}/cancel`, intent);
      if (version !== S.connectionVersion) return;
      S.intents.delete(id);
      toast("Cancellation requested. The host controls resource recovery.");
      await refresh();
    } catch (e) {
      if (version === S.connectionVersion) {
        if (e.status >= 400 && e.status < 500) S.intents.delete(id);
        toast(e.message, true);
      }
    } finally {
      S.busy.delete(id);
    }
  }
  async function toggleAdmissions() {
    if (!isAdmin() || !S.fresh) return;
    const paused = !S.paused;
    if (
      !confirm(
        paused
          ? "Pause new resource admissions? Existing workloads and recovery will continue."
          : "Resume new resource admissions?",
      )
    )
      return;
    let intent = S.intents.get("admissions");
    if (intent && intent.paused !== paused) {
      toast(
        "A previous change is unconfirmed. Refresh to confirm its outcome.",
        true,
      );
      return;
    }
    if (!intent) {
      intent = { paused, key: operationKey() };
      S.intents.set("admissions", intent);
    }
    try {
      await api("/v1/steer", intent);
      S.intents.delete("admissions");
      S.paused = paused;
      render(true);
      await refresh();
    } catch (e) {
      if (e.status >= 400 && e.status < 500) S.intents.delete("admissions");
      toast(e.message, true);
    }
  }
  $("notifications").addEventListener("click", async () => {
    if (S.notifications) {
      S.notifications = false;
      updateChrome();
      toast("Browser notifications turned off for this tab.");
      return;
    }
    if (!("Notification" in window)) {
      toast(
        "This browser does not support system notifications. Watch the Needs you view and tab count.",
      );
      return;
    }
    try {
      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;
      S.notifications = permission === "granted";
      updateChrome();
      toast(
        S.notifications
          ? "Notifications enabled while this tab is open."
          : "Notifications are blocked in browser settings. The tab count remains active.",
      );
    } catch {
      toast(
        "Notifications are unavailable in this browser. The tab count remains active.",
      );
    }
  });
  $("theme").addEventListener("click", () => {
    S.theme =
      { system: "light", light: "dark", dark: "system" }[S.theme] || "system";
    setTheme();
  });
  $("shortcuts").addEventListener("click", () => showDialog("help-dialog"));
  $("refresh").addEventListener("click", refresh);
  $("connect-button").addEventListener("click", () => openConnection());
  $("connection-button").addEventListener("click", () => openConnection());
  function closeNav() {
    document.body.classList.remove("nav-open");
    $("nav-scrim").hidden = true;
    $("menu-toggle").setAttribute("aria-expanded", "false");
  }
  $("menu-toggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    $("nav-scrim").hidden = !open;
    $("menu-toggle").setAttribute("aria-expanded", String(open));
    if (open) $("nav-overview").focus();
  });
  $("nav-scrim").addEventListener("click", closeNav);
  document.addEventListener("keydown", (e) => {
    const typing =
        /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) ||
        e.target.isContentEditable,
      modal = [...document.querySelectorAll("dialog[open]")].at(-1);
    if (e.key === "Escape") {
      closeNav();
      if (modal && !modal.close) {
        e.preventDefault();
        closeDialog(modal.id);
      }
      return;
    }
    if (modal) {
      if (
        modal.id === "compose-dialog" &&
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter"
      ) {
        e.preventDefault();
        $("compose-form").requestSubmit();
      }
      if (!modal.showModal && e.key === "Tab") {
        const focusable = [
          ...modal.querySelectorAll(
            'button,input,select,textarea,[tabindex="0"]',
          ),
        ].filter((n) => !n.disabled && !n.hidden);
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
      return;
    }
    if (
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") ||
      (!typing && e.key === "/")
    ) {
      e.preventDefault();
      $("search").focus();
      $("search").select();
    } else if (
      !typing &&
      !e.metaKey &&
      !e.ctrlKey &&
      e.key.toLowerCase() === "n"
    ) {
      e.preventDefault();
      openComposer();
    } else if (!typing && e.key === "?") {
      e.preventDefault();
      showDialog("help-dialog");
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.connected) void refresh();
  });
  if (
    !("HTMLDialogElement" in window) ||
    !HTMLDialogElement.prototype.showModal
  )
    document.documentElement.classList.add("dialog-fallback");
  if (!["light", "dark", "system"].includes(S.theme)) S.theme = "system";
  if (!/Mac|iPhone|iPad/.test(navigator.platform))
    $("search-key").textContent = "Ctrl K";
  setTheme();
  render(true);
  setInterval(updateTimes, 30000);
})();
