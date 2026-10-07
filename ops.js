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
  var STATUS_ORDER = ["investigating", "building", "reviewing", "soaking", "monitoring", "watching", "decision_needed", "scheduled", "planned", "idea", "deferred", "blocked", "done", "rejected"];
  var CATEGORIES = ["backend", "frontend", "agent", "security", "infrastructure", "maintenance", "docs", "data", "other"];
  var OWNER_TITLE = { claude: "With Claude", you: "With You" };
  var EVENT_VERB = {
    created: "added this", proposed: "proposed this", updated: "changed this", moved: "moved this", note: "added a note",
    done: "marked this done", reopened: "reopened this", approved: "approved this proposal", rejected: "rejected this proposal"
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
    done: "finished", reopened: "reopened", approved: "approved", rejected: "rejected"
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
    describeChanges: describeChanges, describeEvent: describeEvent, reduceMessage: reduceMessage,
    newer: newer, changedFields: changedFields, parseTargets: parseTargets
  };

  // ---- 2. transport ---------------------------------------------------------

  function apiError(res, data) {
    var err = new Error((data && data.error) || "request_failed");
    err.status = res.status;
    err.code = (data && data.error) || null;
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
      decide: function (id, approve, note) { return request("POST", "/items/" + id + "/decide", note ? { approve: approve, note: note } : { approve: approve }); },
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

  function errorMessage(err) {
    if (err && err.status === 401) return "Your session has expired. Log in again.";
    if (err && err.status === 403) return "Your account can’t change the board.";
    if (err && err.code) return "Not saved (" + err.code.replace(/_/g, " ") + ").";
    return "Couldn’t reach the server. Try again.";
  }

  function mount(root, transport) {
    var state = {
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
    clear(root);
    var statusPill = el("span", "ops-live ops-live-connecting", "Connecting…");
    statusPill.setAttribute("role", "status");
    var toolbar = el("div", "ops-toolbar");
    var tabs = el("div", "ops-tabs");
    tabs.setAttribute("role", "tablist");
    var addBtn = el("button", "ops-btn ops-btn-primary", "+ Add item");
    addBtn.type = "button";
    var toolbarRight = el("div", "ops-toolbar-right");
    toolbarRight.appendChild(statusPill);
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

    // -- connection pill
    function setConnection(status) {
      state.connection = status;
      var labels = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…", offline: "Offline" };
      statusPill.className = "ops-live ops-live-" + status;
      statusPill.textContent = labels[status] || status;
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
        if (state.tab === "done") loadDone();
        render();
        // Only a change this tab has not already folded in (its own write's
        // echo is "seen") should rebuild the open drawer, or a just-saved
        // "Saved." message would be wiped by its own echo.
        if (state.selectedId === action.item.id && fresh) refreshDrawer();
      }
    }

    function loadDone() {
      transport.done().then(function (res) { state.doneItems = res.items; if (state.tab === "done") render(); }).catch(function () { /* shown as empty */ });
    }

    // -- rendering: tabs, stats, filters, lanes
    function renderTabs() {
      clear(tabs);
      var defs = [
        { key: "work", label: "Work" },
        { key: "proposals", label: "Proposals", count: proposalList().length },
        { key: "done", label: "Completed", count: state.doneCount }
      ];
      defs.forEach(function (d) {
        var b = el("button", "ops-tab" + (state.tab === d.key ? " is-active" : ""), d.label);
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
    }

    function renderStats(now, today) {
      var s = computeStats(itemList(), now, today);
      var defs = [
        ["In progress", s.in_progress, ""], ["Soaking", s.soaking, ""], ["Waiting on you", s.waiting, s.waiting ? "is-attention" : ""],
        ["Backlog", s.backlog, ""], ["Due in 7 days", s.dueSoon, s.dueSoon ? "is-warn" : ""],
        ["Overdue", s.overdue, s.overdue ? "is-alert" : ""], ["Aged 30+ days", s.aged, s.aged ? "is-warn" : ""]
      ];
      var row = el("div", "ops-stats");
      defs.forEach(function (d) {
        var box = el("div", "ops-stat " + d[2]);
        box.appendChild(el("div", "ops-stat-n", String(d[1])));
        box.appendChild(el("div", "ops-stat-l", d[0]));
        row.appendChild(box);
      });
      return row;
    }

    function toggleFilter(group, value) {
      var list = state.filters[group];
      var at = list.indexOf(value);
      if (at === -1) list.push(value); else list.splice(at, 1);
      render();
    }

    function renderFilters(items) {
      var wrap = el("div", "ops-filters");
      var any = false;
      [["category", "Category"], ["target", "Target"], ["status", "Status"]].forEach(function (g) {
        var values = facet(items, g[0]);
        if (!values.length) return;
        var row = el("div", "ops-filter-row");
        row.appendChild(el("span", "ops-filter-label", g[1]));
        values.forEach(function (v) {
          var active = state.filters[g[0]].indexOf(v.value) !== -1;
          if (active) any = true;
          var label = g[0] === "status" ? (STATUS_TITLE[v.value] || v.value) : v.value;
          var b = el("button", "ops-filter" + (active ? " is-active" : ""), label.replace(/_/g, " "));
          b.type = "button";
          b.setAttribute("aria-pressed", active ? "true" : "false");
          b.appendChild(el("span", "ops-filter-n", String(v.count)));
          b.addEventListener("click", function () { toggleFilter(g[0], v.value); });
          row.appendChild(b);
        });
        wrap.appendChild(row);
      });
      var anyActive = state.filters.category.length + state.filters.target.length + state.filters.status.length > 0;
      if (anyActive) {
        var reset = el("button", "ops-btn ops-btn-quiet", "Clear filters");
        reset.type = "button";
        reset.addEventListener("click", function () { state.filters = { category: [], target: [], status: [] }; render(); });
        wrap.appendChild(reset);
      }
      return wrap;
    }

    function renderUpcoming(items, today) {
      var dated = upcoming(items, today).slice(0, 6);
      var panel = el("section", "ops-panel");
      var head = el("div", "ops-panel-head");
      head.appendChild(el("h2", "ops-panel-title", "Coming up"));
      head.appendChild(el("span", "ops-panel-sub", "Dated items, soonest first"));
      panel.appendChild(head);
      if (!dated.length) { panel.appendChild(el("p", "ops-empty", "Nothing is dated.")); return panel; }
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

    function renderTile(it, now, today) {
      var tile = el("button", "ops-tile" + (it.owner === "you" ? " is-yours" : "") + (it.priority === "high" ? " is-high" : "") + (state.flashed[it.id] ? " ops-flash" : ""));
      tile.type = "button";
      tile.setAttribute("data-id", it.id);
      var top = el("span", "ops-tile-top");
      top.appendChild(el("span", "ops-tile-title", it.title));
      top.appendChild(chip((STATUS_TITLE[it.status] || it.status).toUpperCase(), "ops-chip-status status-" + it.status));
      tile.appendChild(top);
      var tags = el("span", "ops-tile-tags");
      if (it.priority === "high") tags.appendChild(chip("high priority", "ops-chip-high"));
      tags.appendChild(chip(it.category, "ops-chip-cat"));
      it.targets.forEach(function (t) { tags.appendChild(chip(t, "ops-chip-target")); });
      tile.appendChild(tags);
      if (it.next) {
        var next = el("span", "ops-tile-next");
        next.appendChild(el("span", "ops-tile-next-label", "NEXT"));
        next.appendChild(document.createTextNode(" " + it.next));
        tile.appendChild(next);
      }
      var foot = el("span", "ops-tile-foot");
      var info = dueInfo(it.due, today);
      foot.appendChild(el("span", "ops-tile-due" + (info ? " tone-" + info.tone : ""), info ? "DUE " + info.text : "No due date"));
      foot.appendChild(el("span", "ops-tile-owner", OWNER_TITLE[it.owner] || it.owner));
      tile.appendChild(foot);
      var meta = el("span", "ops-tile-meta");
      meta.appendChild(el("span", null, "ADDED " + shortDate(dateString(new Date(it.addedAt))) + " · " + ageText(it.addedAt, now)));
      meta.appendChild(el("span", "ops-tile-open", "Details ›"));
      tile.appendChild(meta);
      tile.addEventListener("click", function () { openDrawer(it.id, tile); });
      return tile;
    }

    function renderWork(now, today) {
      var all = itemList();
      var open = openItems(all);
      var frag = document.createDocumentFragment();
      frag.appendChild(renderStats(now, today));
      frag.appendChild(renderFilters(open));
      frag.appendChild(renderUpcoming(filterItems(open, state.filters), today));
      var board = el("div", "ops-lanes");
      var visible = filterItems(open, state.filters);
      LANES.forEach(function (lane) {
        var inLane = sortForLane(visible.filter(function (i) { return i.lane === lane.key; }));
        var col = el("section", "ops-lane lane-" + lane.key);
        var head = el("div", "ops-lane-head");
        head.appendChild(el("h2", "ops-lane-title", lane.title));
        head.appendChild(el("span", "ops-lane-count", String(inLane.length)));
        col.appendChild(head);
        col.appendChild(el("p", "ops-lane-blurb", lane.blurb));
        if (!inLane.length) col.appendChild(el("p", "ops-empty", open.length && !visible.length ? "Nothing matches the filters." : "Nothing here."));
        inLane.forEach(function (it) { col.appendChild(renderTile(it, now, today)); });
        board.appendChild(col);
      });
      frag.appendChild(board);
      return frag;
    }

    function renderProposals(now, today) {
      var list = proposalList();
      var wrap = el("section", "ops-panel");
      var head = el("div", "ops-panel-head");
      head.appendChild(el("h2", "ops-panel-title", "Proposals"));
      head.appendChild(el("span", "ops-panel-sub", "Ideas Claude has suggested. Approve to add them to the backlog."));
      wrap.appendChild(head);
      if (!list.length) wrap.appendChild(el("p", "ops-empty", "No proposals waiting."));
      list.forEach(function (it) {
        var card = el("div", "ops-proposal");
        var open = el("button", "ops-proposal-main");
        open.type = "button";
        open.setAttribute("data-id", it.id);
        open.appendChild(el("span", "ops-tile-title", it.title));
        if (it.next) open.appendChild(el("span", "ops-proposal-next", it.next));
        open.appendChild(el("span", "ops-proposal-meta", it.category + " · proposed " + relativeTime(it.addedAt, now)));
        open.addEventListener("click", function () { openDrawer(it.id, open); });
        var actions = el("div", "ops-proposal-actions");
        var yes = el("button", "ops-btn ops-btn-primary", "Approve");
        var no = el("button", "ops-btn", "Reject");
        yes.type = no.type = "button";
        yes.addEventListener("click", function () { decide(it.id, true, yes, no); });
        no.addEventListener("click", function () { decide(it.id, false, yes, no); });
        actions.appendChild(yes);
        actions.appendChild(no);
        card.appendChild(open);
        card.appendChild(actions);
        wrap.appendChild(card);
      });
      return wrap;
    }

    function renderDone(now, today) {
      var wrap = el("section", "ops-panel");
      var head = el("div", "ops-panel-head");
      head.appendChild(el("h2", "ops-panel-title", "Completed"));
      head.appendChild(el("span", "ops-panel-sub", "Finished and rejected items stay here with their full log."));
      wrap.appendChild(head);
      if (state.doneItems === null) { wrap.appendChild(el("p", "ops-empty", "Loading…")); return wrap; }
      if (!state.doneItems.length) wrap.appendChild(el("p", "ops-empty", "Nothing completed yet."));
      state.doneItems.forEach(function (it) {
        var row = el("button", "ops-done-row");
        row.type = "button";
        row.setAttribute("data-id", it.id);
        row.appendChild(el("span", "ops-done-date", it.doneAt ? shortDate(dateString(new Date(it.doneAt))) : ""));
        row.appendChild(el("span", "ops-done-title", it.title));
        row.appendChild(chip((STATUS_TITLE[it.status] || it.status).toUpperCase(), "ops-chip-status status-" + it.status));
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
    }

    // -- actions
    function decide(id, approve, yes, no) {
      yes.disabled = no.disabled = true;
      transport.decide(id, approve).then(function (res) {
        upsert(res.item);
        if (res.event) seenEvents[res.event.seq] = true;
        state.version = Math.max(state.version, res.version);
        if (res.item.lane === "done") state.doneCount++;
        render();
      }).catch(function (err) {
        yes.disabled = no.disabled = false;
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

      if (item && item.proposal) {
        var prop = el("div", "ops-banner", "This is a proposal. Approve it to add it to the backlog, or reject it.");
        var pa = el("div", "ops-banner-actions");
        var yes = el("button", "ops-btn ops-btn-primary", "Approve");
        var no = el("button", "ops-btn", "Reject");
        yes.type = no.type = "button";
        yes.addEventListener("click", function () { decide(item.id, true, yes, no); closeDrawer(); });
        no.addEventListener("click", function () { decide(item.id, false, yes, no); closeDrawer(); });
        pa.appendChild(yes);
        pa.appendChild(no);
        prop.appendChild(pa);
        drawer.appendChild(prop);
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
      } else {
        logBox = null;
      }
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

    transport.snapshot().then(function (snap) {
      applySnapshot(snap);
      render();
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
      // A 403 on the very first read means "logged in, but not in the group".
      transport.snapshot().then(function () {
        mount(root, transport);
      }).catch(function (err) {
        if (err && err.status === 403) gate("You’re logged in, but your account isn’t allowed to view the ops board.");
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
