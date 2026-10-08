// Ops Board page (ops.html) -- the account's live progress tracker.
//
// Talks to the Worker's /ops/* routes (see ClaudeRepo's cloudflare-worker
// README, "Ops Board setup"): a REST snapshot for the first paint, then a
// WebSocket that pushes every change as it happens, so a tile moves on screen
// the moment Claude (or you, in another tab) changes it. Behind login: the
// page asks auth-gate.js for the session first and shows a login prompt (or a
// "not in the group" notice) instead of ever rendering the board.
//
// Every string that came from the server is put on the page with textContent,
// never innerHTML -- the board's content is data, not markup -- and the page's
// CSP (see ops.html) has no 'unsafe-inline', so there is nothing to fall back
// on if that rule were ever broken.
//
// Layout of this file:
//   1. pure helpers   -- dates, stats, sorting, filtering, the change reducer;
//                        exported for test/ops.test.js (no DOM, no network)
//   2. transport      -- REST + WebSocket, with reconnect
//   3. UI             -- mount(root, transport): builds and updates the DOM
//   4. boot           -- login check, then mount

(function () {
  "use strict";

  var API_BASE = "https://api.barnyard.site/ops";
  var WS_URL = "wss://api.barnyard.site/ops/stream";
  var DAY_MS = 24 * 60 * 60 * 1000;

  // ---- 1. pure helpers ------------------------------------------------------

  var LANES = [
    { key: "in_progress", title: "In progress", blurb: "Being built, reviewed or deployed now." },
    { key: "soaking", title: "Soaking & monitoring", blurb: "Live and being watched before the next step." },
    { key: "waiting", title: "Waiting on you", blurb: "Needs an operator action or decision." },
    { key: "backlog", title: "Backlog", blurb: "Agreed, not started. Oldest first within each priority." }
  ];
  var LANE_TITLE = { in_progress: "In progress", soaking: "Soaking & monitoring", waiting: "Waiting on you", backlog: "Backlog", done: "Done" };
  var STATUS_TITLE = {
    investigating: "Investigating", building: "Building", reviewing: "Reviewing", soaking: "Soaking",
    monitoring: "Monitoring", watching: "Watching", decision_needed: "Decision needed", scheduled: "Scheduled",
    planned: "Planned", idea: "Idea", deferred: "Deferred", blocked: "Blocked", done: "Done", rejected: "Rejected"
  };
  var STATUS_TONE = { investigating: "info", building: "info", reviewing: "info", soaking: "ok", monitoring: "ok", watching: "ok", decision_needed: "attn", scheduled: "attn", planned: "hollow", idea: "hollow", deferred: "hollow", blocked: "alert" };
  var STATUS_ORDER = ["investigating", "building", "reviewing", "soaking", "monitoring", "watching", "decision_needed", "scheduled", "planned", "idea", "deferred", "blocked", "done", "rejected"];
  var CATEGORIES = ["backend", "frontend", "agent", "security", "infrastructure", "maintenance", "docs", "data", "other"];
  var OWNER_TITLE = { claude: "With Claude", you: "With You" };
  var EVENT_VERB = {
    created: "added this", proposed: "proposed this", updated: "changed this", moved: "moved this", note: "added a note",
    done: "marked this done", reopened: "reopened this", approved: "approved this proposal", rejected: "rejected this proposal",
    redacted: "redacted this"
  };
  var FIELD_TITLE = {
    title: "Title", lane: "Lane", status: "Status", category: "Category", owner: "Owner", priority: "Priority",
    targets: "Targets", next: "Next step", details: "Details", due: "Due", proposal: "Proposal"
  };

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  // Local calendar date as YYYY-MM-DD -- due dates are plain dates, so "today"
  // has to be the viewer's today, not UTC's.
  function dateString(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function dayNumber(s) {
    var p = s.split("-");
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS);
  }

  // Whole days from `today` to `due` (negative = overdue), or null for no date.
  function daysUntil(due, today) {
    if (!due) return null;
    return dayNumber(due) - dayNumber(today);
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(s) {
    var p = s.split("-");
    return MONTHS[+p[1] - 1] + " " + (+p[2]);
  }

  function dueInfo(due, today) {
    var n = daysUntil(due, today);
    if (n === null) return null;
    var rel;
    if (n === 0) rel = "today";
    else if (n === 1) rel = "tomorrow";
    else if (n === -1) rel = "yesterday";
    else if (n > 1) rel = "in " + n + " days";
    else rel = Math.abs(n) + " days overdue";
    return { text: shortDate(due) + " · " + rel, tone: n < 0 ? "overdue" : n <= 2 ? "soon" : "later", days: n };
  }

  function ageDays(ts, now) {
    return Math.max(0, Math.floor((now - ts) / DAY_MS));
  }

  function ageText(ts, now) {
    var d = ageDays(ts, now);
    return d === 0 ? "new today" : d === 1 ? "1 day old" : d + " days old";
  }

  function relativeTime(ts, now) {
    var s = Math.round((now - ts) / 1000);
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    var d = Math.round(h / 24);
    return d === 1 ? "yesterday" : d < 31 ? d + " days ago" : shortDate(dateString(new Date(ts)));
  }

  function openItems(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].lane !== "done" && !items[i].proposal) out.push(items[i]);
    }
    return out;
  }

  function computeStats(items, now, today) {
    var s = { in_progress: 0, soaking: 0, waiting: 0, backlog: 0, dueSoon: 0, overdue: 0, aged: 0 };
    var open = openItems(items);
    for (var i = 0; i < open.length; i++) {
      var it = open[i];
      s[it.lane]++;
      var n = daysUntil(it.due, today);
      if (n !== null && n < 0) s.overdue++;
      else if (n !== null && n <= 7) s.dueSoon++;
      if (now - it.addedAt >= 30 * DAY_MS) s.aged++;
    }
    return s;
  }

  // High priority first, then oldest first -- stable and easy to predict.
  function sortForLane(items) {
    return items.slice().sort(function (a, b) {
      var pa = a.priority === "high" ? 0 : 1;
      var pb = b.priority === "high" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
      return a.id < b.id ? -1 : 1;
    });
  }

  // filters: { category: [..], target: [..], status: [..] }; within a group the
  // choices are OR, across groups they are AND. An empty group matches all.
  function matchesFilters(item, filters) {
    if (filters.category.length && filters.category.indexOf(item.category) === -1) return false;
    if (filters.status.length && filters.status.indexOf(item.status) === -1) return false;
    if (filters.target.length) {
      var hit = false;
      for (var i = 0; i < item.targets.length; i++) if (filters.target.indexOf(item.targets[i]) !== -1) hit = true;
      if (!hit) return false;
    }
    return true;
  }

  function filterItems(items, filters) {
    var out = [];
    for (var i = 0; i < items.length; i++) if (matchesFilters(items[i], filters)) out.push(items[i]);
    return out;
  }

  // [{value, count}] for one facet over `items`, most common first.
  function facet(items, key) {
    var counts = {};
    for (var i = 0; i < items.length; i++) {
      var values = key === "target" ? items[i].targets : [items[i][key === "category" ? "category" : "status"]];
      for (var j = 0; j < values.length; j++) counts[values[j]] = (counts[values[j]] || 0) + 1;
    }
    var out = Object.keys(counts).map(function (v) { return { value: v, count: counts[v] }; });
    out.sort(function (a, b) {
      if (key === "status") return STATUS_ORDER.indexOf(a.value) - STATUS_ORDER.indexOf(b.value);
      return b.count - a.count || (a.value < b.value ? -1 : 1);
    });
    return out;
  }

  // Dated open items, soonest first (the "Coming up" panel).
  function upcoming(items, today) {
    var out = [];
    var open = openItems(items);
    for (var i = 0; i < open.length; i++) if (open[i].due) out.push(open[i]);
    out.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.addedAt - b.addedAt; });
    return out;
  }

  // The items that have waited longest for the owner (lane "waiting", owned by "you"), oldest first.
  // Shown in the side rail on wide screens so the oldest decision is never buried in a lane.
  function longestWaiting(items, limit) {
    var out = [];
    var open = openItems(items);
    for (var i = 0; i < open.length; i++) if (open[i].lane === "waiting" && open[i].owner === "you") out.push(open[i]);
    out.sort(function (a, b) { return a.addedAt - b.addedAt; });
    return out.slice(0, limit);
  }

  // Finished items from the last `days` days, newest first (the side rail's "Recently done").
  function recentlyDone(doneItems, now, days, limit) {
    var out = [];
    var since = now - days * 86400000;
    for (var i = 0; i < (doneItems || []).length; i++) {
      var it = doneItems[i];
      if (it.doneAt && it.doneAt >= since && it.doneAt <= now + 60000) out.push(it);
    }
    out.sort(function (a, b) { return b.doneAt - a.doneAt; });
    return out.slice(0, limit);
  }

  function describeChange(field, pair) {
    var title = FIELD_TITLE[field] || field;
    var from = pair[0];
    var to = pair[1];
    if (field === "lane") { from = LANE_TITLE[from] || from; to = LANE_TITLE[to] || to; }
    if (field === "status") { from = STATUS_TITLE[from] || from; to = STATUS_TITLE[to] || to; }
    if (field === "owner") { from = OWNER_TITLE[from] || from; to = OWNER_TITLE[to] || to; }
    if (field === "details" || field === "next") return title + " updated";
    return title + ": " + (from === "" ? "(none)" : from) + " → " + (to === "" ? "(none)" : to);
  }

  function describeChanges(changes) {
    var out = [];
    var keys = Object.keys(changes || {});
    for (var i = 0; i < keys.length; i++) out.push(describeChange(keys[i], changes[keys[i]]));
    return out;
  }

  function actorName(actor) { return actor === "claude" ? "Claude" : "You"; }

  // "Claude moved 'Heartbeat batching' to Waiting on you" -- the toast / live
  // announcement text for a pushed change.
  var EVENT_TOAST = {
    created: "added", proposed: "proposed", updated: "updated", moved: "moved", note: "added a note to",
    done: "finished", reopened: "reopened", approved: "approved", rejected: "rejected", redacted: "redacted"
  };

  function describeEvent(event, item) {
    var tail = "";
    if (event.kind === "moved" && event.changes && event.changes.lane) tail = " to " + (LANE_TITLE[event.changes.lane[1]] || event.changes.lane[1]);
    return actorName(event.actor) + " " + (EVENT_TOAST[event.kind] || "changed") + " “" + item.title + "”" + tail;
  }

  // The reducer for pushed messages. Pure: returns what to do, mutates nothing.
  //   snapshot -> replace everything
  //   change   -> upsert the item; if the version skipped ahead we missed a
  //               message, so ask for a fresh snapshot instead of trusting
  //               a possibly inconsistent view
  // `state` is { version }. Returns { kind: "snapshot"|"upsert"|"resync"|"ignore", ... }.
  function reduceMessage(state, msg) {
    if (!msg || typeof msg !== "object") return { kind: "ignore" };
    if (msg.type === "snapshot" && Array.isArray(msg.items)) {
      return { kind: "snapshot", items: msg.items, version: msg.version, doneCount: msg.doneCount };
    }
    if (msg.type === "change" && msg.item && typeof msg.version === "number") {
      if (msg.version > state.version + 1) return { kind: "resync" };
      return { kind: "upsert", item: msg.item, event: msg.event || null, version: Math.max(state.version, msg.version) };
    }
    return { kind: "ignore" };
  }

  // Keep the newer of two copies of an item (a REST reply and the WebSocket
  // echo of the same change can arrive in either order).
  function newer(existing, incoming) {
    return !existing || incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  }

  // Which fields of the edit form differ from the item, as a PATCH body.
  function changedFields(item, form) {
    var out = {};
    var keys = ["title", "lane", "status", "category", "owner", "priority", "due", "next", "details"];
    for (var i = 0; i < keys.length; i++) {
      if (form[keys[i]] !== undefined && form[keys[i]] !== item[keys[i]]) out[keys[i]] = form[keys[i]];
    }
    if (form.targets !== undefined && JSON.stringify(form.targets) !== JSON.stringify(item.targets)) out.targets = form.targets;
    return out;
  }

  function parseTargets(text) {
    var seen = [];
    var parts = String(text || "").split(",");
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t && seen.indexOf(t) === -1) seen.push(t);
    }
    return seen;
  }

  var helpers = {
    LANES: LANES, STATUS_TITLE: STATUS_TITLE, CATEGORIES: CATEGORIES,
    dateString: dateString, daysUntil: daysUntil, dueInfo: dueInfo, ageDays: ageDays, ageText: ageText,
    relativeTime: relativeTime, openItems: openItems, computeStats: computeStats, sortForLane: sortForLane,
    matchesFilters: matchesFilters, filterItems: filterItems, facet: facet, upcoming: upcoming,
    longestWaiting: longestWaiting, recentlyDone: recentlyDone,
    describeChanges: describeChanges, describeEvent: describeEvent, reduceMessage: reduceMessage,
    newer: newer, changedFields: changedFields, parseTargets: parseTargets,
    errorMessage: errorMessage, piiText: piiText
  };

  // ---- 2. transport ---------------------------------------------------------

  function apiError(res, data) {
    var err = new Error((data && data.error) || "request_failed");
    err.status = res.status;
    err.code = (data && data.error) || null;
    // secret_detected says which field and what kind of secret (never the text).
    err.field = (data && data.field) || null;
    err.kind = (data && data.kind) || null;
    return err;
  }

  function request(method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw apiError(res, data);
        return data;
      });
    });
  }

  // Opens the stream and keeps it open: pings to stay alive, reconnects with a
  // growing delay (and some jitter) when it drops. handlers: onMessage(msg),
  // onStatus("live"|"connecting"|"reconnecting"). Returns { close() }.
  function openStream(handlers) {
    var ws = null;
    var closed = false;
    var attempt = 0;
    var pingTimer = null;
    var retryTimer = null;

    function schedule() {
      if (closed) return;
      handlers.onStatus("reconnecting");
      var delay = Math.min(30000, 1000 * Math.pow(2, attempt)) * (0.75 + Math.random() * 0.5);
      attempt++;
      retryTimer = setTimeout(connect, delay);
    }

    function connect() {
      if (closed) return;
      handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
      try { ws = new WebSocket(WS_URL); } catch (e) { schedule(); return; }
      ws.onopen = function () {
        attempt = 0;
        handlers.onStatus("live");
        clearInterval(pingTimer);
        pingTimer = setInterval(function () {
          try { if (ws.readyState === 1) ws.send("ping"); } catch (e) { /* the close handler reconnects */ }
        }, 25000);
      };
      ws.onmessage = function (ev) {
        if (ev.data === "pong") return;
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        handlers.onMessage(msg);
      };
      ws.onclose = function () { clearInterval(pingTimer); schedule(); };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* already closing */ } };
    }

    connect();
    return {
      close: function () {
        closed = true;
        clearTimeout(retryTimer);
        clearInterval(pingTimer);
        try { if (ws) ws.close(); } catch (e) { /* already closed */ }
      }
    };
  }

  function createTransport() {
    return {
      snapshot: function () { return request("GET", "/board"); },
      item: function (id) { return request("GET", "/items/" + id); },
      done: function () { return request("GET", "/done?limit=100"); },
      create: function (body) { return request("POST", "/items", body); },
      patch: function (id, body) { return request("PATCH", "/items/" + id, body); },
      note: function (id, text) { return request("POST", "/items/" + id + "/note", { note: text }); },
      finish: function (id, note) { return request("POST", "/items/" + id + "/finish", note ? { note: note } : {}); },
      reopen: function (id, lane) { return request("POST", "/items/" + id + "/reopen", { lane: lane }); },
      // run: false means "approve only" (no agent run); leave it out to approve and, if the board has
      // agent runs switched on, start one.
      decide: function (id, approve, note, run) {
        var body = { approve: approve };
        if (note) body.note = note;
        if (run === false) body.run = false;
        return request("POST", "/items/" + id + "/decide", body);
      },
      startRun: function (id) { return request("POST", "/items/" + id + "/run", {}); },
      fireRun: function (runId) { return request("POST", "/runs/" + runId + "/fire", {}); },
      // Taking an item's data out; the item's own id is the typed confirmation.
      redact: function (id) { return request("POST", "/items/" + id + "/redact", { confirm: id }); },
      remove: function (id) { return request("POST", "/items/" + id + "/delete", { confirm: id }); },
      connect: openStream
    };
  }

  // ---- 3. UI ----------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function chip(text, className) { return el("span", "ops-chip" + (className ? " " + className : ""), text); }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var SECRET_KIND = {
    private_key: "a private key", agent_key: "an agent key", bearer_token: "an access token", aws_key: "a cloud key",
    github_token: "a GitHub token", slack_token: "a Slack token", google_key: "a Google key", stripe_key: "a payment key",
    api_key: "an API key", jwt: "a login token", url_password: "a password in a web address", credential: "a password or key"
  };
  var FIELD_NAME = { title: "title", next: "next step", details: "details", targets: "targets", note: "note" };

  // What to tell the person when the server refuses a write. Specific refusals come
  // first (they share status codes with the generic ones below).
  function errorMessage(err) {
    var code = err && err.code;
    if (code === "secret_detected") {
      return "Not saved: the " + (FIELD_NAME[err.field] || "text") + " looks like it contains " + (SECRET_KIND[err.kind] || "a password or key") +
        ". Take it out and keep it in a password manager, then save again.";
    }
    if (code === "recent_sign_in_required") return "For safety this needs a recent sign-in. Sign in again, then try again.";
    if (code === "session_revoked") return "You were signed out of this board. Log in again.";
    if (code === "key_expired") return "That agent key has expired. Make a new one in Settings.";
    if (code === "read_only_key") return "That agent key is read-only.";
    if (code === "confirm_required") return "Type the confirmation exactly as shown.";
    if (code === "session_required") return "This can only be done by you, signed in, not by an agent.";
    if (err && err.status === 401) return "Your session has expired. Log in again.";
    if (err && err.status === 403) return "Your account can’t change the board.";
    if (err && err.code) return "Not saved (" + err.code.replace(/_/g, " ") + ").";
    return "Couldn’t reach the server. Try again.";
  }

  var PII_TEXT = {
    email: "an email address", phone: "a phone number", card: "a card number", tfn: "a tax file number",
    medicare: "a Medicare number", ssn: "a social security number"
  };

  function piiText(kinds) {
    var out = [];
    for (var i = 0; i < kinds.length; i++) out.push(PII_TEXT[kinds[i]] || kinds[i]);
    return out.join(", ");
  }

  // A link that starts a fresh login and returns here (the Worker checks return_to
  // against its own list of allowed sites).
  function signInAgainLink() {
    var a = document.createElement("a");
    a.href = "https://api.barnyard.site/auth/login?return_to=" + encodeURIComponent(location.href);
    a.textContent = " Sign in again";
    return a;
  }

  function mount(root, transport) {
    var Runs = window.OpsAgentRuns;
    var state = {
      dispatch: null,       // this board's agent-run settings, once loaded
      items: {},            // id -> item (open items, plus any done item that has been opened)
      version: 0,
      doneCount: 0,
      tab: "work",          // work | proposals | done
      filters: { category: [], target: [], status: [] },
      doneItems: null,      // loaded on demand
      selectedId: null,     // id, "new", or null
      connection: "connecting",
      loaded: false,
      flashed: {}           // id -> true while a tile highlights a fresh change
    };
    var seenEvents = {};
    var stream = null;
    var drawerDirty = false;
    var returnFocusTo = null;
    var returnFocusId = null;

    // -- skeleton
    var Shell = typeof window !== "undefined" ? window.BarnyardShell : null;
    var Theme = typeof window !== "undefined" ? window.BarnyardTheme : null;
    var saved = Theme ? Theme.get() : { opsLayout: "board", foldBacklog: null };
    state.layout = saved.opsLayout === "list" ? "list" : "board";
    state.folded = { backlog: saved.foldBacklog === null ? window.innerWidth < 1500 : !!saved.foldBacklog };
    state.moreFilters = false;
    clear(root);
    var connBanner = el("div", "ops-conn");
    connBanner.setAttribute("role", "status");
    connBanner.hidden = true;
    var toolbar = el("div", "ops-toolbar");
    var tabs = el("div", "ops-tabs");
    tabs.setAttribute("role", "tablist");
    var layoutToggle = el("div", "ops-tabs");
    layoutToggle.setAttribute("role", "group");
    layoutToggle.setAttribute("aria-label", "Layout");
    var addBtn = el("button", "ops-btn ops-btn-primary", "Add item");
    addBtn.type = "button";
    var toolbarRight = el("div", "ops-toolbar-right");
    toolbarRight.appendChild(layoutToggle);
    toolbarRight.appendChild(addBtn);
    toolbar.appendChild(tabs);
    toolbar.appendChild(toolbarRight);
    var content = el("div", "ops-content");
    var toasts = el("div", "ops-toasts");
    toasts.setAttribute("role", "status");
    toasts.setAttribute("aria-live", "polite");
    var backdrop = el("div", "ops-backdrop");
    var drawer = el("aside", "ops-drawer");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-hidden", "true");
    drawer.tabIndex = -1;
    root.appendChild(connBanner);
    root.appendChild(toolbar);
    root.appendChild(content);
    root.appendChild(toasts);
    root.appendChild(backdrop);
    root.appendChild(drawer);

    function itemList() { return Object.keys(state.items).map(function (k) { return state.items[k]; }); }
    function proposalList() {
      return sortForLane(itemList().filter(function (i) { return i.proposal && i.lane !== "done"; }));
    }

    // -- toasts
    function toast(text) {
      var t = el("div", "ops-toast", text);
      toasts.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
    }

    // -- connection state: the shell's Live pill, a banner when it matters, and
    // no editing while offline (the writes would only fail)
    function setConnection(status) {
      state.connection = status;
      if (Shell) Shell.setConnection(status);
      var off = status === "offline";
      connBanner.hidden = !(status === "reconnecting" || off);
      connBanner.className = "ops-conn is-" + status;
      connBanner.textContent = off
        ? "You’re offline. Editing is paused until the connection returns."
        : "Connection lost. What you see may be out of date. Reconnecting…";
      addBtn.disabled = off;
      setDrawerEditable(!off);
    }

    function setDrawerEditable(on) {
      var nodes = drawer.querySelectorAll("input, select, textarea, button");
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].classList.contains("ops-close")) continue;
        nodes[i].disabled = !on;
      }
    }

    // -- applying data
    function applySnapshot(snap) {
      state.items = {};
      for (var i = 0; i < snap.items.length; i++) state.items[snap.items[i].id] = snap.items[i];
      state.version = snap.version;
      state.doneCount = snap.doneCount || 0;
      state.loaded = true;
    }

    function upsert(item) {
      state.items[item.id] = newer(state.items[item.id], item);
    }

    function flash(id) {
      state.flashed[id] = true;
      setTimeout(function () {
        delete state.flashed[id];
        var node = content.querySelector('[data-id="' + id + '"]');
        if (node) node.classList.remove("ops-flash");
      }, 2600);
    }

    function handleMessage(msg) {
      var action = reduceMessage(state, msg);
      if (action.kind === "snapshot") {
        applySnapshot(action);
        render();
        if (state.selectedId && state.selectedId !== "new") refreshDrawer();
      } else if (action.kind === "resync") {
        transport.snapshot().then(function (snap) { applySnapshot(snap); render(); }).catch(function () { /* the next push or reconnect retries */ });
      } else if (action.kind === "upsert") {
        var before = state.items[action.item.id];
        upsert(action.item);
        state.version = action.version;
        if (action.item.lane === "done" && (!before || before.lane !== "done")) state.doneCount++;
        if (before && before.lane === "done" && action.item.lane !== "done") state.doneCount = Math.max(0, state.doneCount - 1);
        var fresh = action.event && !seenEvents[action.event.seq];
        if (action.event) seenEvents[action.event.seq] = true;
        if (fresh) {
          flash(action.item.id);
          if (action.event.actor === "claude") toast(describeEvent(action.event, action.item));
        }
        // Keep the finished list (and the side rail's "Done in the last two weeks") current.
        if (state.tab === "done" || action.item.lane === "done" || (before && before.lane === "done")) loadDone();
        render();
        // Only a change this tab has not already folded in (its own write's
        // echo is "seen") should rebuild the open drawer, or a just-saved
        // "Saved." message would be wiped by its own echo.
        if (state.selectedId === action.item.id && fresh) refreshDrawer();
      }
    }

    function loadDone() {
      transport.done().then(function (res) { state.doneItems = res.items; if (state.tab === "done" || state.tab === "work") render(); }).catch(function () { /* shown as empty */ });
    }

    // -- rendering: tabs, summary, filters, lanes
    var CHEVRON = function () { return Shell ? Shell.controls.svg("down") : document.createTextNode("▾"); };

    function statusDot(status) {
      var s = el("span", "st " + (STATUS_TONE[status] || ""));
      s.appendChild(el("i"));
      s.appendChild(document.createTextNode(STATUS_TITLE[status] || status));
      return s;
    }

    function renderTabs() {
      clear(tabs);
      var defs = [
        { key: "work", label: "Work" },
        { key: "proposals", label: "Proposals", count: proposalList().length },
        { key: "done", label: "Completed", count: state.doneCount }
      ];
      defs.forEach(function (d) {
        var b = el("button", "ops-tab", d.label);
        b.type = "button";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", state.tab === d.key ? "true" : "false");
        if (d.count) b.appendChild(el("span", "ops-tab-count", String(d.count)));
        b.addEventListener("click", function () {
          state.tab = d.key;
          if (d.key === "done" && state.doneItems === null) loadDone();
          render();
        });
        tabs.appendChild(b);
      });
      clear(layoutToggle);
      layoutToggle.hidden = state.tab !== "work";
      [["board", "Board"], ["list", "List"]].forEach(function (d) {
        var b = el("button", "ops-tab", d[1]);
        b.type = "button";
        b.setAttribute("aria-pressed", state.layout === d[0] ? "true" : "false");
        b.addEventListener("click", function () {
          state.layout = d[0];
          if (Theme) Theme.set({ opsLayout: d[0] });
          render();
        });
        layoutToggle.appendChild(b);
      });
    }

    // One line of counts instead of a row of tiles: the lanes already show the
    // same numbers, so this only says what needs attention.
    function renderSummary(now, today) {
      var s = computeStats(itemList(), now, today);
      var row = el("div", "ops-summary");
      [[s.in_progress, "in progress", ""], [s.soaking, "soaking", ""], [s.waiting, "waiting on you", "is-attention"],
       [s.backlog, "in the backlog", ""], [s.overdue, "overdue", "is-alert"], [s.aged, "older than 30 days", ""]].forEach(function (d) {
        if (!d[0] && d[2] !== "is-attention") return;
        var span = el("span", d[2]);
        span.appendChild(el("b", null, String(d[0])));
        span.appendChild(document.createTextNode(d[1]));
        row.appendChild(span);
      });
      return row;
    }

    function toggleFilter(group, value) {
      var list = state.filters[group];
      var at = list.indexOf(value);
      if (at === -1) list.push(value); else list.splice(at, 1);
      render();
    }

    function filterRow(items, group, wrap) {
      var values = facet(items, group);
      if (!values.length) return;
      var row = el("div", "ops-filter-row");
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", "Filter by " + group);
      values.forEach(function (v) {
        var active = state.filters[group].indexOf(v.value) !== -1;
        var label = group === "status" ? (STATUS_TITLE[v.value] || v.value) : v.value;
        var b = el("button", "ops-filter", label.replace(/_/g, " "));
        b.type = "button";
        b.setAttribute("aria-pressed", active ? "true" : "false");
        b.appendChild(el("span", "ops-filter-n", String(v.count)));
        b.addEventListener("click", function () { toggleFilter(group, v.value); });
        row.appendChild(b);
      });
      wrap.appendChild(row);
    }

    // Category is always shown; target and status sit behind "More filters" so
    // the board stays near the top of the page.
    function renderFilters(items) {
      var wrap = el("div", "ops-filters");
      filterRow(items, "category", wrap);
      var extra = state.filters.target.length + state.filters.status.length;
      var more = el("button", "ops-btn ops-btn-quiet ops-btn-sm", state.moreFilters ? "Fewer filters" : "More filters" + (extra ? " (" + extra + ")" : ""));
      more.type = "button";
      more.setAttribute("aria-expanded", state.moreFilters ? "true" : "false");
      more.addEventListener("click", function () { state.moreFilters = !state.moreFilters; render(); });
      var controls = el("div", "ops-filter-controls");
      controls.appendChild(more);
      var anyActive = state.filters.category.length + extra > 0;
      if (anyActive) {
        var reset = el("button", "ops-btn ops-btn-quiet ops-btn-sm", "Clear filters");
        reset.type = "button";
        reset.addEventListener("click", function () { state.filters = { category: [], target: [], status: [] }; render(); });
        controls.appendChild(reset);
      }
      wrap.appendChild(controls);
      if (state.moreFilters) { filterRow(items, "target", wrap); filterRow(items, "status", wrap); }
      return wrap;
    }

    function renderUpcoming(items, today) {
      var dated = upcoming(items, today).slice(0, 6);
      if (!dated.length) return null;
      var panel = el("section", "ops-upcoming-list");
      panel.setAttribute("aria-label", "Coming up");
      var head = el("div", "ops-section-head");
      head.appendChild(el("h2", null, "Coming up"));
      head.appendChild(el("span", "ops-sub", "Dated items, soonest first"));
      panel.appendChild(head);
      dated.forEach(function (it) {
        var info = dueInfo(it.due, today);
        var row = el("button", "ops-upcoming");
        row.type = "button";
        row.setAttribute("data-id", it.id);
        row.appendChild(el("span", "ops-upcoming-date tone-" + info.tone, shortDate(it.due)));
        row.appendChild(el("span", "ops-upcoming-rel", info.text.split(" · ")[1]));
        row.appendChild(el("span", "ops-upcoming-title", it.title));
        row.appendChild(chip(LANE_TITLE[it.lane] || it.lane, "ops-chip-lane"));
        row.addEventListener("click", function () { openDrawer(it.id, row); });
        panel.appendChild(row);
      });
      return panel;
    }

    // Right-hand rail. On a wide screen it sits beside the board and uses the space the board
    // does not need (the tiles keep their size); below that width only "Coming up" shows, above
    // the board, exactly as before (the other panels are hidden by CSS).
    function railSection(title, sub, className) {
      var s = el("section", "ops-rail-section " + (className || ""));
      var head = el("div", "ops-section-head");
      head.appendChild(el("h2", null, title));
      if (sub) head.appendChild(el("span", "ops-sub", sub));
      s.appendChild(head);
      return s;
    }

    function railRow(it, when, whenClass) {
      var row = el("button", "ops-rail-row");
      row.type = "button";
      row.setAttribute("data-id", it.id);
      row.appendChild(el("span", "ops-rail-title", it.title));
      row.appendChild(el("span", "ops-rail-when " + (whenClass || ""), when));
      row.addEventListener("click", function () { state.items[it.id] = newer(state.items[it.id], it); openDrawer(it.id, row); });
      return row;
    }

    function renderRail(visible, all, now, today) {
      var rail = el("aside", "ops-rail");
      rail.setAttribute("aria-label", "At a glance");
      var up = renderUpcoming(visible, today);
      if (up) { up.classList.add("ops-rail-section"); rail.appendChild(up); }
      var waiting = longestWaiting(all, 4);
      if (waiting.length) {
        var w = railSection("Waiting longest on you", "Oldest first", "ops-rail-extra");
        waiting.forEach(function (it) { w.appendChild(railRow(it, ageText(it.addedAt, now), "tone-" + (ageDays(it.addedAt, now) >= 7 ? "soon" : "later"))); });
        rail.appendChild(w);
      }
      var done = renderRecentlyDone(now);
      if (done) rail.appendChild(done);
      return rail.childNodes.length ? rail : null;
    }

    function renderRecentlyDone(now) {
      if (state.doneItems === null) { if (!state.doneRequested) { state.doneRequested = true; loadDone(); } return null; }
      var recent = recentlyDone(state.doneItems, now, 14, 6);
      if (!recent.length) return null;
      var s = railSection("Done in the last two weeks", state.doneCount + " in total", "ops-rail-extra");
      recent.forEach(function (it) { s.appendChild(railRow(it, shortDate(dateString(new Date(it.doneAt))), "")); });
      return s;
    }

    function renderTile(it, now, today) {
      var tile = el("button", "ops-tile" + (it.owner === "you" ? " is-yours" : "") + (state.flashed[it.id] ? " ops-flash" : ""));
      tile.type = "button";
      tile.setAttribute("data-id", it.id);
      tile.appendChild(el("span", "ops-tile-title", it.title));
      var meta = el("span", "ops-tile-meta");
      meta.appendChild(statusDot(it.status));
      if (it.priority === "high") meta.appendChild(chip("High priority", "ops-chip-high"));
      if (it.pii && it.pii.length) meta.appendChild(chip("Personal data", "ops-chip-pii"));
      var rc = Runs ? Runs.helpers.runChip(it.run) : null;
      if (rc) meta.appendChild(chip(rc.text, "ops-chip-run-" + rc.tone));
      tile.appendChild(meta);
      if (it.next) tile.appendChild(el("span", "ops-tile-next", it.next));
      var foot = el("span", "ops-tile-foot");
      var info = dueInfo(it.due, today);
      if (info) foot.appendChild(el("span", "ops-due tone-" + info.tone, info.text.replace(" · ", ", ")));
      else foot.appendChild(el("span", "ops-tile-added", "Added " + ageText(it.addedAt, now)));
      foot.appendChild(el("span", "ops-tile-owner", OWNER_TITLE[it.owner] || it.owner));
      tile.appendChild(foot);
      tile.addEventListener("click", function () { openDrawer(it.id, tile); });
      return tile;
    }

    function renderLane(lane, visible, open, now, today) {
      var inLane = sortForLane(visible.filter(function (i) { return i.lane === lane.key; }));
      var folded = !!state.folded[lane.key];
      var col = el("section", "ops-lane lane-" + lane.key);
      col.setAttribute("data-lane", lane.key);
      col.setAttribute("aria-label", lane.title);
      var head = el("div", "ops-lane-head");
      var title = el("h2", "ops-lane-title", lane.title);
      title.appendChild(el("span", "ops-lane-count", String(inLane.length)));
      var fold = el("button", "ops-fold");
      fold.type = "button";
      fold.setAttribute("aria-expanded", folded ? "false" : "true");
      fold.setAttribute("aria-label", (folded ? "Show " : "Hide ") + lane.title);
      fold.appendChild(CHEVRON());
      fold.addEventListener("click", function () { state.folded[lane.key] = !folded; if (lane.key === "backlog" && Theme) Theme.set({ foldBacklog: !folded }); render(); });
      head.appendChild(title);
      head.appendChild(fold);
      col.appendChild(head);
      if (folded) { col.appendChild(el("p", "ops-empty", inLane.length + (inLane.length === 1 ? " item hidden" : " items hidden"))); return col; }
      if (!inLane.length) col.appendChild(el("p", "ops-empty", open.length && !visible.length ? "Nothing matches the filters." : "Nothing here."));
      inLane.forEach(function (it) { col.appendChild(renderTile(it, now, today)); });
      return col;
    }

    // Phones show one lane at a time-ish: a strip of buttons that jump to a lane.
    function renderLaneJump(visible) {
      var strip = el("div", "ops-lane-jump");
      strip.setAttribute("aria-label", "Jump to a lane");
      LANES.forEach(function (lane) {
        var n = visible.filter(function (i) { return i.lane === lane.key; }).length;
        var b = el("button", "ops-filter", lane.title);
        b.type = "button";
        b.appendChild(el("span", "ops-filter-n", String(n)));
        b.addEventListener("click", function () {
          state.folded[lane.key] = false;
          render();
          var target = content.querySelector('[data-lane="' + lane.key + '"]');
          if (target) target.scrollIntoView({ block: "start" });
        });
        strip.appendChild(b);
      });
      return strip;
    }

    function renderList(visible, today) {
      var wrap = el("div", "ops-list");
      var table = el("table");
      var thead = el("thead"), hr = el("tr");
      ["Item", "Status", "Owner", "Due"].forEach(function (t) { hr.appendChild(el("th", null, t)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var body = el("tbody");
      LANES.forEach(function (lane) {
        var inLane = sortForLane(visible.filter(function (i) { return i.lane === lane.key; }));
        var lr = el("tr", "ops-list-lane"), lc = el("td", null, lane.title + "  " + inLane.length);
        lc.colSpan = 4;
        lr.appendChild(lc);
        body.appendChild(lr);
        inLane.forEach(function (it) {
          var tr = el("tr", "ops-list-row");
          tr.tabIndex = 0;
          tr.setAttribute("data-id", it.id);
          var t = el("td"); t.appendChild(el("b", null, it.title)); tr.appendChild(t);
          var s = el("td"); s.appendChild(statusDot(it.status)); tr.appendChild(s);
          tr.appendChild(el("td", "ops-dim", OWNER_TITLE[it.owner] || it.owner));
          var d = el("td"), info = dueInfo(it.due, today);
          if (info) d.appendChild(el("span", "ops-due tone-" + info.tone, info.text.replace(" · ", ", "))); else d.appendChild(el("span", "ops-dim", "No date"));
          tr.appendChild(d);
          tr.addEventListener("click", function () { openDrawer(it.id, tr); });
          tr.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDrawer(it.id, tr); } });
          body.appendChild(tr);
        });
      });
      table.appendChild(body);
      wrap.appendChild(table);
      return wrap;
    }

    function renderWork(now, today) {
      var all = itemList();
      var open = openItems(all);
      var frag = document.createDocumentFragment();
      frag.appendChild(renderSummary(now, today));
      frag.appendChild(renderFilters(open));
      var visible = filterItems(open, state.filters);
      // The board (or list) and the side rail share a grid: one column normally (the rail's
      // "Coming up" sits above, as it always did), two on a very wide screen.
      var rail = renderRail(visible, all, now, today);
      var space = el("div", "ops-workspace" + (rail ? " has-rail" : ""));
      if (rail) space.appendChild(rail);
      var main = el("div", "ops-main");
      if (state.layout === "list") main.appendChild(renderList(visible, today));
      else {
        main.appendChild(renderLaneJump(visible));
        var board = el("div", "ops-lanes");
        LANES.forEach(function (lane) { board.appendChild(renderLane(lane, visible, open, now, today)); });
        main.appendChild(board);
      }
      space.appendChild(main);
      frag.appendChild(space);
      return frag;
    }

    function renderProposals(now, today) {
      var list = proposalList();
      var wrap = el("section", "ops-panel");
      if (!list.length) {
        var empty = el("div", "ops-blank");
        empty.appendChild(el("b", null, "No proposals to review"));
        empty.appendChild(document.createTextNode("When Claude has an idea that needs your yes or no, it appears here before it joins the backlog."));
        wrap.appendChild(empty);
      }
      list.forEach(function (it) {
        var card = el("div", "ops-proposal");
        var open = el("button", "ops-proposal-main");
        open.type = "button";
        open.setAttribute("data-id", it.id);
        open.appendChild(el("span", "ops-tile-title", it.title));
        if (it.next) open.appendChild(el("span", "ops-proposal-next", it.next));
        open.appendChild(el("span", "ops-proposal-meta", it.category + ", proposed " + relativeTime(it.addedAt, now)));
        open.addEventListener("click", function () { openDrawer(it.id, open); });
        var actions = el("div", "ops-proposal-actions");
        var runsOn = !!(state.dispatch && state.dispatch.available && state.dispatch.enabled);
        var yes = el("button", "ops-btn ops-btn-primary", runsOn ? "Approve and run" : "Approve");
        var only = runsOn ? el("button", "ops-btn", "Approve only") : null;
        var no = el("button", "ops-btn", "Reject");
        yes.type = no.type = "button";
        var all = only ? [yes, only, no] : [yes, no];
        yes.addEventListener("click", function () { decide(it.id, true, all); });
        if (only) { only.type = "button"; only.addEventListener("click", function () { decide(it.id, true, all, false); }); }
        no.addEventListener("click", function () { decide(it.id, false, all); });
        all.forEach(function (b) { actions.appendChild(b); });
        card.appendChild(open);
        card.appendChild(actions);
        wrap.appendChild(card);
      });
      return wrap;
    }

    function renderDone(now, today) {
      var wrap = el("section", "ops-panel");
      if (state.doneItems === null) { wrap.appendChild(el("p", "ops-empty", "Loading…")); return wrap; }
      if (!state.doneItems.length) {
        var empty = el("div", "ops-blank");
        empty.appendChild(el("b", null, "Nothing completed yet"));
        empty.appendChild(document.createTextNode("Finished and rejected items stay here with their full change log."));
        wrap.appendChild(empty);
      }
      state.doneItems.forEach(function (it) {
        var row = el("button", "ops-done-row");
        row.type = "button";
        row.setAttribute("data-id", it.id);
        row.appendChild(el("span", "ops-done-date", it.doneAt ? shortDate(dateString(new Date(it.doneAt))) : ""));
        row.appendChild(el("span", "ops-done-title", it.title));
        row.appendChild(statusDot(it.status));
        row.addEventListener("click", function () { state.items[it.id] = newer(state.items[it.id], it); openDrawer(it.id, row); });
        wrap.appendChild(row);
      });
      return wrap;
    }

    function render() {
      var active = document.activeElement;
      var focusId = !state.selectedId && active && active.getAttribute ? active.getAttribute("data-id") : null;
      var now = Date.now();
      var today = dateString(new Date(now));
      renderTabs();
      clear(content);
      if (!state.loaded) content.appendChild(el("p", "ops-empty", "Loading the board…"));
      else if (state.tab === "work") content.appendChild(renderWork(now, today));
      else if (state.tab === "proposals") content.appendChild(renderProposals(now, today));
      else content.appendChild(renderDone(now, today));
      if (focusId) {
        var again = content.querySelector('[data-id="' + focusId + '"]');
        if (again) again.focus();
      }
      if (Shell && state.loaded) Shell.setBadge(computeStats(itemList(), now, today).waiting);
    }

    // -- actions
    // buttons: every button that started this, so they can all be locked until it settles.
    function decide(id, approve, buttons, run) {
      buttons.forEach(function (b) { b.disabled = true; });
      transport.decide(id, approve, undefined, run).then(function (res) {
        upsert(res.item);
        if (res.event) seenEvents[res.event.seq] = true;
        state.version = Math.max(state.version, res.version);
        if (res.item.lane === "done") state.doneCount++;
        render();
        if (Runs) toast(Runs.helpers.approveMessage(approve, res));
        if (Runs && approve) loadDispatch();
      }).catch(function (err) {
        buttons.forEach(function (b) { b.disabled = false; });
        toast(errorMessage(err));
      });
    }

    // This board's agent-run settings (whether to offer "Approve and run"). A board where
    // they can't be read simply doesn't offer it.
    function loadDispatch() {
      if (!Runs) return;
      Runs.loadConfig({ request: request }).then(function (cfg) { state.dispatch = cfg; render(); });
    }

    // Start (or try again) an agent run for an item from its drawer.
    function runAction(kind, item, button) {
      var p = kind === "fire" ? transport.fireRun(item.run.id) : transport.startRun(item.id);
      p.then(function () { return transport.item(item.id); }).then(function (res) {
        state.items[item.id] = Object.assign({}, state.items[item.id], res.item);
        render();
        if (state.selectedId === item.id) buildDrawer();
        loadDispatch();
        toast(kind === "fire" ? "Tried again." : "Agent run started.");
      }).catch(function (err) {
        if (button) button.disabled = false;
        toast(errorMessage(err));
      });
    }

    // -- drawer
    function field(labelText, control, hint) {
      var wrap = el("label", "ops-field");
      wrap.appendChild(el("span", "ops-field-label", labelText));
      wrap.appendChild(control);
      if (hint) wrap.appendChild(el("span", "ops-field-hint", hint));
      return wrap;
    }

    function select(options, value, titleOf) {
      var s = el("select", "ops-input");
      options.forEach(function (o) {
        var opt = el("option", null, titleOf ? titleOf(o) : o);
        opt.value = o;
        if (o === value) opt.selected = true;
        s.appendChild(opt);
      });
      return s;
    }

    function openDrawer(id, opener) {
      state.selectedId = id;
      returnFocusTo = opener || null;
      // Saving re-renders the board, replacing the tile that opened the drawer,
      // so remember it by id as well as by element.
      returnFocusId = opener && opener.getAttribute ? opener.getAttribute("data-id") : null;
      drawerDirty = false;
      backdrop.classList.add("is-open");
      drawer.classList.add("is-open");
      drawer.setAttribute("aria-hidden", "false");
      document.body.classList.add("ops-noscroll");
      // The page behind a modal drawer must not be reachable by keyboard or
      // screen reader while it is open.
      toolbar.setAttribute("inert", "");
      content.setAttribute("inert", "");
      buildDrawer();
      drawer.focus();
      if (id !== "new") loadLog(id);
    }

    function closeDrawer() {
      state.selectedId = null;
      backdrop.classList.remove("is-open");
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
      document.body.classList.remove("ops-noscroll");
      toolbar.removeAttribute("inert");
      content.removeAttribute("inert");
      clear(drawer);
      var again = returnFocusId ? content.querySelector('[data-id="' + returnFocusId + '"]') : null;
      if (again) again.focus();
      else if (returnFocusTo && document.body.contains(returnFocusTo)) returnFocusTo.focus();
      returnFocusTo = null;
      returnFocusId = null;
      // A link such as ops.html#it_abcd1234 opened this item; drop it from the
      // address so a refresh does not reopen the drawer.
      if (/^#it_[a-z0-9]{8}$/.test(location.hash) && window.history && window.history.replaceState) window.history.replaceState(null, "", location.pathname + location.search);
    }

    var logBox = null;
    var noticeBox = null;

    function buildDrawer() {
      clear(drawer);
      var isNew = state.selectedId === "new";
      var item = isNew ? null : state.items[state.selectedId];
      if (!isNew && !item) { closeDrawer(); return; }

      var head = el("div", "ops-drawer-head");
      var title = el("h2", "ops-drawer-title", isNew ? "New item" : item.title);
      title.id = "ops-drawer-title";
      drawer.setAttribute("aria-labelledby", "ops-drawer-title");
      var close = el("button", "ops-btn ops-btn-quiet ops-close", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", closeDrawer);
      head.appendChild(title);
      head.appendChild(close);
      drawer.appendChild(head);

      noticeBox = el("p", "ops-notice");
      noticeBox.hidden = true;
      drawer.appendChild(noticeBox);

      if (item && item.pii && item.pii.length) {
        drawer.appendChild(el("div", "ops-banner ops-banner-pii",
          "This item contains personal data (" + piiText(item.pii) + "). Keep this board to work notes. Use “Remove data” at the bottom to redact it for good."));
      }

      if (item && item.proposal) {
        var prop = el("div", "ops-banner", "This is a proposal. Approve it to add it to the backlog, or reject it.");
        var pa = el("div", "ops-banner-actions");
        var runsOnHere = !!(state.dispatch && state.dispatch.available && state.dispatch.enabled);
        var yes = el("button", "ops-btn ops-btn-primary", runsOnHere ? "Approve and run" : "Approve");
        var only = runsOnHere ? el("button", "ops-btn", "Approve only") : null;
        var no = el("button", "ops-btn", "Reject");
        yes.type = no.type = "button";
        var everyButton = only ? [yes, only, no] : [yes, no];
        yes.addEventListener("click", function () { decide(item.id, true, everyButton); closeDrawer(); });
        if (only) { only.type = "button"; only.addEventListener("click", function () { decide(item.id, true, everyButton, false); closeDrawer(); }); }
        no.addEventListener("click", function () { decide(item.id, false, everyButton); closeDrawer(); });
        everyButton.forEach(function (b) { pa.appendChild(b); });
        prop.appendChild(pa);
        drawer.appendChild(prop);
      }

      // The agent run for an approved item: its state, a link to the session, and the buttons that apply.
      if (item && Runs) {
        var box = Runs.runBox(item, state.dispatch, function (kind, button) { runAction(kind, item, button); });
        if (box) drawer.appendChild(box);
      }

      var form = el("form", "ops-form");
      form.noValidate = true;
      var src = item || { title: "", lane: "backlog", status: "planned", category: "other", owner: "claude", priority: "normal", due: "", next: "", details: "", targets: [] };

      var fTitle = el("input", "ops-input"); fTitle.type = "text"; fTitle.maxLength = 120; fTitle.value = src.title;
      var fLane = select(["in_progress", "soaking", "waiting", "backlog"].concat(item && item.lane === "done" ? ["done"] : []), src.lane, function (v) { return LANE_TITLE[v]; });
      var fStatus = select(STATUS_ORDER, src.status, function (v) { return STATUS_TITLE[v]; });
      var fCategory = select(CATEGORIES, src.category);
      var fOwner = select(["claude", "you"], src.owner, function (v) { return OWNER_TITLE[v]; });
      var fPriority = select(["normal", "high"], src.priority);
      var fDue = el("input", "ops-input"); fDue.type = "date"; fDue.value = src.due;
      var fTargets = el("input", "ops-input"); fTargets.type = "text"; fTargets.value = src.targets.join(", ");
      var fNext = el("textarea", "ops-input"); fNext.rows = 2; fNext.maxLength = 400; fNext.value = src.next;
      var fDetails = el("textarea", "ops-input ops-details"); fDetails.rows = 6; fDetails.maxLength = 6000; fDetails.value = src.details;

      form.appendChild(field("Title", fTitle));
      var grid = el("div", "ops-form-grid");
      grid.appendChild(field("Lane", fLane));
      grid.appendChild(field("Status", fStatus));
      grid.appendChild(field("Category", fCategory));
      grid.appendChild(field("Owner", fOwner));
      grid.appendChild(field("Priority", fPriority));
      grid.appendChild(field("Due", fDue));
      form.appendChild(grid);
      form.appendChild(field("Targets", fTargets, "Comma-separated, up to 6."));
      form.appendChild(field("Next step", fNext));
      form.appendChild(field("Details", fDetails));

      var controls = { title: fTitle, lane: fLane, status: fStatus, category: fCategory, owner: fOwner, priority: fPriority, due: fDue, targets: fTargets, next: fNext, details: fDetails };
      Object.keys(controls).forEach(function (k) {
        controls[k].addEventListener("input", function () { drawerDirty = true; });
        controls[k].addEventListener("change", function () { drawerDirty = true; });
      });
      // Moving a tile to another lane also moves its status label, as the
      // server would -- show that before saving rather than after.
      fLane.addEventListener("change", function () {
        var defaults = { in_progress: "building", soaking: "soaking", waiting: "decision_needed", backlog: "planned", done: "done" };
        fStatus.value = defaults[fLane.value] || fStatus.value;
      });

      var msg = el("p", "ops-form-msg");
      msg.setAttribute("role", "status");
      var actions = el("div", "ops-form-actions");
      var save = el("button", "ops-btn ops-btn-primary", isNew ? "Create item" : "Save changes");
      save.type = "submit";
      actions.appendChild(save);
      if (item && item.lane !== "done" && !item.proposal) {
        var finish = el("button", "ops-btn", "Mark done");
        finish.type = "button";
        finish.addEventListener("click", function () {
          finish.disabled = true;
          transport.finish(item.id).then(function (res) { applyReply(res); msg.textContent = "Marked done."; }).catch(function (err) { finish.disabled = false; msg.textContent = errorMessage(err); });
        });
        actions.appendChild(finish);
      }
      if (item && item.lane === "done") {
        var reopen = el("button", "ops-btn", "Reopen in Backlog");
        reopen.type = "button";
        reopen.addEventListener("click", function () {
          reopen.disabled = true;
          transport.reopen(item.id, "backlog").then(function (res) { applyReply(res); loadDone(); msg.textContent = "Reopened."; }).catch(function (err) { reopen.disabled = false; msg.textContent = errorMessage(err); });
        });
        actions.appendChild(reopen);
      }
      form.appendChild(actions);
      form.appendChild(msg);

      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var values = {
          title: fTitle.value.trim(), lane: fLane.value, status: fStatus.value, category: fCategory.value, owner: fOwner.value,
          priority: fPriority.value, due: fDue.value, next: fNext.value.trim(), details: fDetails.value.trim(), targets: parseTargets(fTargets.value)
        };
        if (!values.title) { msg.textContent = "Give it a title."; fTitle.focus(); return; }
        save.disabled = true;
        msg.textContent = "Saving…";
        var req;
        if (isNew) {
          req = transport.create(values);
        } else {
          var diff = changedFields(item, values);
          if (!Object.keys(diff).length) { save.disabled = false; msg.textContent = "Nothing changed."; return; }
          req = transport.patch(item.id, diff);
        }
        req.then(function (res) {
          applyReply(res);
          drawerDirty = false;
          if (isNew) { state.selectedId = res.item.id; buildDrawer(); loadLog(res.item.id); }
          else msg.textContent = "Saved.";
        }).catch(function (err) { save.disabled = false; msg.textContent = errorMessage(err); });
      });
      drawer.appendChild(form);

      if (!isNew) {
        var noteForm = el("form", "ops-note-form");
        var noteText = el("textarea", "ops-input"); noteText.rows = 2; noteText.maxLength = 2000; noteText.placeholder = "Add a note to the log…";
        noteText.setAttribute("aria-label", "New log note");
        var noteBtn = el("button", "ops-btn", "Add note");
        noteBtn.type = "submit";
        var noteMsg = el("p", "ops-form-msg");
        noteForm.appendChild(noteText);
        noteForm.appendChild(noteBtn);
        noteForm.appendChild(noteMsg);
        noteForm.addEventListener("submit", function (ev) {
          ev.preventDefault();
          var text = noteText.value.trim();
          if (!text) return;
          noteBtn.disabled = true;
          transport.note(item.id, text).then(function (res) { applyReply(res); noteText.value = ""; noteBtn.disabled = false; noteMsg.textContent = ""; })
            .catch(function (err) { noteBtn.disabled = false; noteMsg.textContent = errorMessage(err); });
        });
        drawer.appendChild(noteForm);

        var logHead = el("h3", "ops-log-title", "Change log");
        logBox = el("ol", "ops-log");
        logBox.appendChild(el("li", "ops-empty", "Loading…"));
        drawer.appendChild(logHead);
        drawer.appendChild(logBox);
        drawer.appendChild(removeSection(item));
      } else {
        logBox = null;
      }
      setDrawerEditable(state.connection !== "offline");
    }

    // "Remove data": redact an item (clear it and wipe its whole history) or delete it.
    // Both are permanent and need a recent sign-in; the item's id is typed to confirm.
    function removeSection(item) {
      var box = el("details", "ops-remove");
      box.appendChild(el("summary", null, "Remove data"));
      box.appendChild(el("p", "ops-remove-hint", "Redact clears this item’s text and wipes its whole change log, leaving an empty tile. Delete removes the item and its history. Neither can be undone, and both need a recent sign-in."));
      var form = el("form", "ops-remove-form");
      var typed = el("input", "ops-input");
      typed.type = "text";
      typed.autocomplete = "off";
      typed.placeholder = item.id;
      typed.setAttribute("aria-label", "Type " + item.id + " to confirm");
      var redactBtn = el("button", "ops-btn", "Redact");
      var deleteBtn = el("button", "ops-btn ops-btn-danger", "Delete");
      redactBtn.type = deleteBtn.type = "button";
      var msg = el("p", "ops-form-msg");
      msg.setAttribute("role", "status");
      function fail(err) {
        redactBtn.disabled = deleteBtn.disabled = false;
        msg.textContent = errorMessage(err);
        if (err && err.code === "recent_sign_in_required") msg.appendChild(signInAgainLink());
      }
      function run(kind) {
        if (typed.value.trim() !== item.id) { msg.textContent = "Type " + item.id + " in the box to confirm."; typed.focus(); return; }
        redactBtn.disabled = deleteBtn.disabled = true;
        msg.textContent = "Working…";
        if (kind === "redact") {
          transport.redact(item.id).then(function (res) {
            applyReply(res);
            drawerDirty = false;
            buildDrawer();
            loadLog(item.id);
            toast("Redacted.");
          }).catch(fail);
        } else {
          transport.remove(item.id).then(function () {
            delete state.items[item.id];
            closeDrawer();
            render();
            toast("Item deleted.");
          }).catch(fail);
        }
      }
      redactBtn.addEventListener("click", function () { run("redact"); });
      deleteBtn.addEventListener("click", function () { run("delete"); });
      form.addEventListener("submit", function (ev) { ev.preventDefault(); });
      form.appendChild(typed);
      form.appendChild(redactBtn);
      form.appendChild(deleteBtn);
      box.appendChild(form);
      box.appendChild(msg);
      return box;
    }

    // The reply to one of this tab's own writes: fold it in now (the WebSocket
    // echo of the same change is then recognised as already seen).
    function applyReply(res) {
      if (!res || !res.item) return;
      var wasDone = state.items[res.item.id] && state.items[res.item.id].lane === "done";
      upsert(res.item);
      if (res.event) seenEvents[res.event.seq] = true;
      if (typeof res.version === "number") state.version = Math.max(state.version, res.version);
      if (res.item.lane === "done" && !wasDone) state.doneCount++;
      render();
      if (state.selectedId === res.item.id && res.event && logBox) loadLog(res.item.id);
    }

    function loadLog(id) {
      transport.item(id).then(function (res) {
        if (state.selectedId !== id || !logBox) return;
        state.items[id] = newer(state.items[id], res.item);
        renderLog(res.events);
      }).catch(function () {
        if (state.selectedId === id && logBox) { clear(logBox); logBox.appendChild(el("li", "ops-empty", "Couldn’t load the log.")); }
      });
    }

    function renderLog(events) {
      var now = Date.now();
      clear(logBox);
      if (!events.length) { logBox.appendChild(el("li", "ops-empty", "No history yet.")); return; }
      events.forEach(function (ev) {
        var li = el("li", "ops-log-row actor-" + ev.actor);
        var top = el("div", "ops-log-top");
        top.appendChild(chip(actorName(ev.actor), "ops-chip-actor actor-" + ev.actor));
        top.appendChild(el("span", "ops-log-what", EVENT_VERB[ev.kind] || ev.kind));
        var time = el("span", "ops-log-time", relativeTime(ev.ts, now));
        time.title = new Date(ev.ts).toLocaleString();
        top.appendChild(time);
        li.appendChild(top);
        describeChanges(ev.changes).forEach(function (line) { li.appendChild(el("div", "ops-log-change", line)); });
        if (ev.note) li.appendChild(el("div", "ops-log-note", ev.note));
        logBox.appendChild(li);
      });
    }

    // A change to the open item arrived over the stream: refresh the log, and
    // the fields too unless the user is mid-edit (then warn instead).
    function refreshDrawer() {
      if (!state.selectedId || state.selectedId === "new") return;
      var item = state.items[state.selectedId];
      if (!item) return;
      if (drawerDirty) {
        if (noticeBox) { noticeBox.hidden = false; noticeBox.textContent = "This item changed elsewhere. Saving will overwrite those fields."; }
      } else {
        var scroll = drawer.scrollTop;
        buildDrawer();
        drawer.scrollTop = scroll;
      }
      loadLog(state.selectedId);
    }

    // -- wiring
    addBtn.addEventListener("click", function () { openDrawer("new", addBtn); });
    backdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && state.selectedId) closeDrawer();
    });

    // Re-render once a minute so "2 days old" / "tomorrow" stay true on a page
    // left open overnight.
    var tick = setInterval(function () { if (state.loaded) render(); }, 60000);

    // ops.html#it_xxxxxxxx (from the Overview or the search box) opens that item.
    function openFromHash() {
      var m = /^#(it_[a-z0-9]{8})$/.exec(location.hash);
      if (!m || !state.loaded || state.selectedId === m[1]) return;
      var id = m[1];
      if (state.items[id]) { openDrawer(id, null); return; }
      transport.item(id).then(function (res) { state.items[id] = newer(state.items[id], res.item); openDrawer(id, null); }).catch(function () { /* an unknown id just shows the board */ });
    }
    window.addEventListener("hashchange", openFromHash);

    if (Shell) {
      Shell.setSearchSource(function () {
        return openItems(itemList()).map(function (i) {
          return { title: i.title, hint: LANE_TITLE[i.lane] || "", go: function () { state.tab = "work"; render(); openDrawer(i.id, null); } };
        });
      });
      // Agent runs (switch on, connect a routine) is its own tab, for everyone with a board.
      if (Runs) Runs.registerSettingsTab({ request: request, Shell: Shell, toast: toast }, function (cfg) { state.dispatch = cfg; render(); });
      // The board's own settings live in the shell's Settings panel.
      Shell.registerTab({
        id: "board", title: "Ops board",
        render: function (body) {
          var now = Theme.get();
          body.appendChild(Shell.controls.radios("opsl", "Default view", "How the Ops board opens.", [{ value: "board", title: "Board" }, { value: "list", title: "List" }], now.opsLayout, function (v) {
            Theme.set({ opsLayout: v });
            state.layout = v;
            render();
          }));
          var fs = el("fieldset");
          fs.appendChild(el("legend", null, "Backlog"));
          var row = el("div", "opt-row"), left = el("div");
          left.appendChild(el("b", null, "Fold the backlog when the board opens"));
          left.appendChild(el("span", "d", "Keeps the lanes you act on wider. Open it any time with the arrow."));
          row.appendChild(left);
          row.appendChild(Shell.controls.toggle("Fold the backlog when the board opens", now.foldBacklog === null ? window.innerWidth < 1500 : now.foldBacklog, function (on) {
            Theme.set({ foldBacklog: on });
            state.folded.backlog = on;
            render();
          }));
          fs.appendChild(row);
          body.appendChild(fs);
        }
      });
    }

    transport.snapshot().then(function (snap) {
      applySnapshot(snap);
      render();
      loadDispatch();
      openFromHash();
    }).catch(function (err) {
      clear(content);
      content.appendChild(el("p", "ops-empty", errorMessage(err)));
    });
    render();

    stream = transport.connect({ onMessage: handleMessage, onStatus: setConnection });

    return {
      destroy: function () { clearInterval(tick); if (stream) stream.close(); },
      state: state
    };
  }

  // ---- 4. boot --------------------------------------------------------------

  function boot() {
    var root = document.getElementById("ops-root");
    if (!root) return;
    var gate = function (message, linkText, href) {
      clear(root);
      var card = el("div", "ops-gate");
      card.appendChild(el("p", null, message));
      if (href) {
        var a = el("a", "ops-btn ops-btn-primary", linkText);
        a.href = href;
        card.appendChild(a);
      }
      root.appendChild(card);
    };
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) {
        gate("The ops board is private. Log in to see it.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null);
        return;
      }
      var transport = createTransport();
      var Shell = window.BarnyardShell;
      // What agent-setup.js needs from this file: the request function, a toast,
      // the shell (for the Agent access settings tab) and a way to start over.
      var agentCtx = {
        request: request,
        toast: function (text) { if (Shell && Shell.toast) Shell.toast(text); },
        Shell: Shell,
        reload: boot
      };
      var Agent = window.OpsAgentSetup;
      // A 403 on the very first read means "logged in, but not in the group"
      // (or, with code board_disabled, that this person's board was switched off).
      // A 404 no_board means they have no board of their own yet.
      transport.snapshot().then(function () {
        mount(root, transport);
        try { if (Agent) Agent.afterMount(root, agentCtx); } catch (e) { /* the board works without the setup panel */ }
      }).catch(function (err) {
        if (err && err.code === "no_board" && Agent) Agent.mountOnboarding(root, agentCtx);
        else if (err && err.code === "board_disabled") gate("Your board has been switched off. Ask the person who runs this hub.");
        else if (err && err.status === 403) gate("You’re logged in, but your account isn’t allowed to view the ops board.");
        else if (err && err.status === 401) gate("Your session has expired.", "Log in again", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null);
        else gate("Couldn’t reach the ops board. Try again in a moment.");
      });
    });
  }

  if (typeof document !== "undefined" && document.getElementById && !window.__OPS_NO_BOOT) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  if (typeof window !== "undefined") window.OpsBoard = { mount: mount, helpers: helpers };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }
})();
