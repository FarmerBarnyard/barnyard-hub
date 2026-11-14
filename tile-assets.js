// The Assets & services tile: what the owner runs (servers, domains, certificates, accounts, apps, licences,
// subscriptions), who looks after it, when it renews and what it costs. The tile shows the numbers and what renews soon;
// "Open register" opens the whole list in a drawer, where an entry is added, changed or removed.
//
// Talks to /reg/* on the Worker (ClaudeRepo's cloudflare-worker/src/registry-routes.js, owner only):
//   GET /reg/summary, GET /reg/assets, POST /reg/assets, PATCH /reg/assets/<id>, DELETE /reg/assets/<id>?confirm=1,
//   POST /reg/seed (the starting list), POST /reg/domains/check (ask the registrars now).
// The data lives on the server (the registry Durable Object) and in the hub backup; the browser keeps nothing.
// A date that comes from the registrar says so; a renewal date that lives on the Ops board (the Calendar) is linked, not copied.
//
// Needs tile-kit.js first. Pure helpers are exported for test/tile-assets.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // ---- 1. pure helpers ------------------------------------------------------------------------------------------

  var KINDS = [
    ["server", "Server", "Servers"], ["domain", "Domain", "Domains"], ["certificate", "Certificate", "Certificates"],
    ["account", "Account", "Accounts and tenants"], ["identity", "Identity app or setting", "Identity apps and settings"], ["app", "App or site", "Apps and sites"], ["licence", "Licence", "Licences"],
    ["subscription", "Subscription", "Subscriptions"], ["network", "Network", "Network"], ["other", "Other", "Other"]
  ];
  var KIND_ONE = {}, KIND_MANY = {};
  KINDS.forEach(function (k) { KIND_ONE[k[0]] = k[1]; KIND_MANY[k[0]] = k[2]; });
  var CRITICALITY = [["", "Not set"], ["critical", "Critical"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]];
  var DATE_STATES = [["", "Known"], ["estimated", "Estimated"], ["needed", "Needed"], ["auto", "Renews itself"]];
  var PERIODS = [["month", "a month"], ["year", "a year"], ["once", "once"]];
  var MONITORS = [["", "None"], ["app02", "app02"], ["cld01", "BARNYARDCLD01"], ["vtt", "VTT server"], ["vmh01", "BARNYARDVMH01 (VMware host)"], ["worker-api", "Barnyard API (the Worker)"], ["site-dashboard", "Dashboard site"], ["site-study", "Study site"], ["site-campaign", "Campaign site"], ["site-stocks", "Stocks site"]];
  var NEED_WORDS = { expires: "a date", cost: "a cost", owner: "an owner", runbook: "a runbook" };

  // ---- accepted gaps (the Worker's dependency-logic.js and registry-logic.js hold the rules; these mirror them for the form) ----
  // A gap the owner decides to live with: { gap, reason, review }. It stays listed on the map and the Weakest links tile, and counts
  // again once its review day has passed. Which gaps a kind of asset is ever asked for:
  var GAPS = [["monitor", "no monitor"], ["backup", "no backup job names it"], ["runbook", "no runbook"], ["watch", "no expiry watch"]];
  var GAP_KINDS = { monitor: ["server", "app", "network"], backup: ["server", "app"], runbook: ["server", "app", "network", "identity"], watch: ["identity"] };
  var REASON_MAX = 140, MAX_ACCEPTED = 4;
  function gapsFor(kind) { return GAPS.filter(function (g) { return GAP_KINDS[g[0]].indexOf(kind) !== -1; }); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  // The farthest review day the Worker accepts (twelve months from today, UTC) and a sensible first choice (90 days on).
  function farthestReview(now) { var d = new Date(now); d.setUTCFullYear(d.getUTCFullYear() + 1); return ymd(d); }
  function defaultReview(now) { return ymd(new Date(now + 90 * 86400000)); }
  // The list as the form built it ([{ gap, reason, review }], only the ticked rows) checked for the kind. -> { value } | { error, field }
  function checkAccepted(list, kind, now) {
    var out = [], seen = {};
    var far = farthestReview(now == null ? Date.now() : now);
    for (var i = 0; i < (list || []).length; i++) {
      var a = list[i], reason = String(a.reason || "").replace(/\s+/g, " ").trim();
      if (gapsFor(kind).every(function (g) { return g[0] !== a.gap; }) || seen[a.gap]) continue;
      seen[a.gap] = true;
      if (!reason) return { error: "Say why you are accepting this gap (a short sentence, no passwords or keys).", field: "accept-" + a.gap + "-reason" };
      if (reason.length > REASON_MAX) return { error: "Keep the reason to " + REASON_MAX + " characters.", field: "accept-" + a.gap + "-reason" };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.review || "")) || isNaN(Date.parse(a.review + "T00:00:00Z"))) return { error: "Pick the day to look at this again.", field: "accept-" + a.gap + "-review" };
      if (a.review > far) return { error: "The review day can be at most 12 months away (" + far + ").", field: "accept-" + a.gap + "-review" };
      out.push({ gap: a.gap, reason: reason, review: a.review });
    }
    return { value: out.slice(0, MAX_ACCEPTED) };
  }
  function sameAccepted(a, b) { return JSON.stringify(a || []) === JSON.stringify(b || []); }

  // "needs a date and a cost"
  function needText(missing) {
    var w = (missing || []).map(function (m) { return NEED_WORDS[m] || m; });
    if (!w.length) return "";
    return "needs " + (w.length === 1 ? w[0] : w.slice(0, -1).join(", ") + " and " + w[w.length - 1]);
  }

  // Free accounts, subscriptions and licences have no renewal to act on: a date on one is a review or sign-in reminder, not money or an
  // outage. They are left out of the renewing list and its count (a free certificate or domain still counts: those really do lapse).
  // An asset is free when its cost is entered as 0 (the register's "Free"); the Worker may also say so with `free: true`.
  var FREE_KINDS = ["account", "subscription", "licence"];
  function isFreeNoRenewal(entry, asset) {
    if (!entry || FREE_KINDS.indexOf(entry.kind) === -1) return false;
    if (entry.free === true) return true;
    return !!asset && asset.costCents === 0;
  }
  // The expiring list without the free ones: { list, freeCount }. `byId` maps an asset id to its register entry (from GET /reg/assets);
  // without it nothing is left out, so a failed or missing answer never hides a renewal.
  function renewals(expiring, byId) {
    var list = [], free = 0;
    (expiring || []).forEach(function (e) {
      if (isFreeNoRenewal(e, byId && byId[e.id])) free++; else list.push(e);
    });
    return { list: list, freeCount: free };
  }

  // The numbers on the tile, from GET /reg/summary (and, when it is known, the register entries by id, so free ones are not counted).
  function glance(summary, byId) {
    var a = summary && summary.assets ? summary.assets : { count: 0, neededCount: 0, expiring: [], totals: [] };
    var r = renewals(a.expiring, byId);
    var soon = r.list.length ? r.list[0] : null;
    var cost = a.totals && a.totals.length ? a.totals.map(function (t) { return K.moneyText(t.monthlyCents, t.currency); }).join(" + ") : "";
    return {
      count: a.count || 0, needed: a.neededCount || 0, expiring: r.list.length, freeCount: r.freeCount, renewing: r.list,
      soonestDays: soon ? soon.daysLeft : null, costMonthly: cost,
      annual: a.totals && a.totals.length ? a.totals.map(function (t) { return K.moneyText(t.annualCents, t.currency); }).join(" + ") : ""
    };
  }

  // The tile's status pill and the sentence under it: { tone, pill, text }. A renewal within a week (or already late) is red, anything
  // else to do (details missing, a renewal within 60 days) is amber, and nothing to do is calm green.
  function statusLine(g) {
    var week = g.renewing.filter(function (e) { return e.daysLeft <= 7; }).length;
    if (week) return { tone: "alert", pill: "Renewal due", text: K.plural(week, "item") + " renew" + (week === 1 ? "s" : "") + " within 7 days." + (g.needed ? " " + K.plural(g.needed, "item") + " still need details." : "") };
    var bits = [];
    if (g.expiring) bits.push(g.expiring + " renewing within 60 days");
    if (g.needed) bits.push(K.plural(g.needed, "item") + " still " + (g.needed === 1 ? "needs" : "need") + " details");
    if (bits.length) return { tone: "attn", pill: "Needs a look", text: bits.join(", ") + "." };
    return { tone: "ok", pill: "All good", text: "Nothing renews in the next 60 days and every item has its details." };
  }

  // One expiry as the tile and the list say it: { text, tone, source }.
  function expiryModel(asset, now) {
    var date = asset.rdapExpires || asset.expires || "";
    // A free account's date is a reminder to look at it, not a renewal: no countdown, no warning colour.
    if (isFreeNoRenewal(asset, asset)) return { text: date ? "Free, no renewal (date " + K.dateText(date) + ")" : "Free, no renewal", tone: "", source: "" };
    if (!date) return { text: asset.dateState === "auto" ? "Renews itself" : "No date", tone: asset.dateState === "auto" ? "" : "attn", source: "" };
    var days = K.dayDiff(date, now);
    return {
      text: K.dateText(date) + (days === null ? "" : " (" + K.daysText(days) + ")"), tone: K.urgency(days),
      source: asset.rdapExpires ? "registrar" : asset.dateState === "estimated" ? "estimated" : asset.dateState === "needed" ? "estimated" : ""
    };
  }

  function costLine(asset) {
    if (asset.costCents === null || asset.costCents === undefined) return "";
    if (asset.costCents === 0) return "Free";
    return K.moneyText(asset.costCents, asset.currency) + (asset.costPeriod ? " " + (asset.costPeriod === "once" ? "once" : "a " + asset.costPeriod) : "");
  }

  function filterAssets(list, f) {
    var q = String((f && f.q) || "").trim().toLowerCase();
    return (list || []).filter(function (a) {
      if (f && f.kind && a.kind !== f.kind) return false;
      if (!q) return true;
      return [a.name, a.owner, a.location, a.runs, a.notes, a.runbook].join(" ").toLowerCase().indexOf(q) !== -1;
    });
  }

  // [{ kind, label, items }] in the order of KINDS, only the kinds that have something.
  function groupByKind(list) {
    var groups = [];
    KINDS.forEach(function (k) {
      var items = (list || []).filter(function (a) { return a.kind === k[0]; });
      if (items.length) groups.push({ kind: k[0], label: k[2], items: items });
    });
    return groups;
  }

  var FIELDS = ["kind", "name", "owner", "location", "runs", "criticality", "expires", "dateState", "cost", "costPeriod", "runbook", "link", "monitorId", "renewalItem", "watch", "notes"];
  var BLANK = { kind: "server", name: "", owner: "", location: "", runs: "", criticality: "", expires: "", dateState: "", cost: "", costPeriod: "month", runbook: "", link: "", monitorId: "", renewalItem: "", watch: "", notes: "" };

  // The form's text values for an asset (or a blank one).
  function formValues(asset) {
    if (!asset) return Object.assign({}, BLANK);
    var v = {};
    FIELDS.forEach(function (f) { v[f] = f === "cost" ? (asset.costCents === null || asset.costCents === undefined ? "" : String(asset.costCents / 100)) : String(asset[f] === undefined || asset[f] === null ? "" : asset[f]); });
    if (!asset.costPeriod) v.costPeriod = "month";
    return v;
  }

  // The request body from the form: only what changed against `current` (or everything for a new one).
  // -> { body } or { error, field }.
  function formToBody(values, current) {
    var body = {};
    var cents = K.parseMoney(values.cost);
    if (cents !== null && isNaN(cents)) return { error: "The cost must be a plain amount such as 12.50.", field: "cost" };
    var before = formValues(current);
    var send = function (key, val) { if (!current || before[key] !== values[key]) body[key] = val; };
    ["kind", "name", "owner", "location", "runs", "criticality", "expires", "dateState", "runbook", "link", "monitorId", "renewalItem", "notes"].forEach(function (k) { send(k, String(values[k]).trim()); });
    var watch = values.kind === "domain" ? String(values.watch).trim() : "";
    if (!current || before.watch !== watch) body.watch = watch;
    if (!current || before.cost !== values.cost) body.costCents = cents;
    if (cents !== null && (!current || before.costPeriod !== values.costPeriod || before.cost !== values.cost)) body.costPeriod = values.costPeriod;
    if (!String(values.name).trim()) return { error: "Give it a name.", field: "name" };
    // the accepted gaps (only when the form carries them): sent when they differ from what is stored, judged against the chosen kind
    if (Array.isArray(values.acceptedGaps)) {
      var acc = checkAccepted(values.acceptedGaps, values.kind);
      if (acc.error) return acc;
      if (!sameAccepted(acc.value, current && current.acceptedGaps)) body.acceptedGaps = acc.value;
    }
    return { body: body };
  }

  var helpers = {
    KINDS: KINDS, KIND_ONE: KIND_ONE, KIND_MANY: KIND_MANY, needText: needText, glance: glance, expiryModel: expiryModel,
    costLine: costLine, filterAssets: filterAssets, groupByKind: groupByKind, formValues: formValues, formToBody: formToBody,
    renewals: renewals, isFreeNoRenewal: isFreeNoRenewal, statusLine: statusLine,
    GAPS: GAPS, gapsFor: gapsFor, checkAccepted: checkAccepted, farthestReview: farthestReview, defaultReview: defaultReview
  };
  var desc = {
    id: "assets", title: "Assets & services", about: "What you run, who looks after it, when it renews and what it costs.",
    w: 6, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.assets"
  };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  // ---- 2. the tile ----------------------------------------------------------------------------------------------

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var state = { summary: null, byId: null, busy: false };
    var wrap = h("div", "tl");
    var head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("button", "btn btn-sm", "Open register");
    open.type = "button";
    open.addEventListener("click", function () { openRegister(draw); });
    var mapLink = h("a", "btn btn-sm btn-quiet", "Dependency map");
    mapLink.href = "map.html";
    head.appendChild(mapLink);
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body);
    clear(container); container.appendChild(wrap);

    function seed() {
      open.disabled = true;
      K.call("POST", "/reg/seed").then(function (r) {
        open.disabled = false;
        if (r.status === 200) return load();
        paint(K.errorText(r.body, r.status), true);
      });
    }

    function paint(message, isError) {
      var s = state.summary;
      clear(body);
      var g = glance(s, state.byId);
      if (message) body.appendChild(h("div", "tk-msg" + (isError ? " alert" : ""), message));
      if (!g.count) {
        var empty = h("div", "tl-notice");
        empty.appendChild(h("p", "dim", "Nothing in the register yet. Start with a list of what the notes and repositories already say you run, then fill in the gaps."));
        var b = h("button", "btn btn-sm btn-primary", "Add the starting list"); b.type = "button"; b.addEventListener("click", seed);
        empty.appendChild(b);
        body.appendChild(empty);
        return;
      }
      var line = statusLine(g);
      body.appendChild(K.summaryRow(line.tone, line.pill, line.text));
      body.appendChild(K.statGrid([
        { value: String(g.count), label: K.plural(g.count, "item").replace(/^\d+ /, "") + " in the register" },
        { value: String(g.needed), label: g.needed === 1 ? "item needs details" : "items need details", tone: K.countTone(g.needed, "attn") },
        { value: String(g.expiring), label: "renewing within 60 days", tone: g.soonestDays !== null && g.soonestDays <= 7 ? "alert" : K.countTone(g.expiring, "attn") },
        g.costMonthly ? { value: g.costMonthly, label: "a month, all costs", text: true } : { value: "None", label: "costs entered yet", text: true, tone: "attn" }
      ]));

      var more = h("div", "tl-more");
      more.appendChild(h("p", "tl-sub", "Renewing soon"));
      var soon = g.renewing.slice(0, 4);
      if (!soon.length) more.appendChild(h("p", "dim", "Nothing renews in the next 60 days."));
      else {
        var ul = h("ul", "tl-list");
        soon.forEach(function (e) {
          var li = h("li", "tl-row");
          li.appendChild(h("span", null, e.name));
          li.appendChild(chip(K.dateText(e.expires) + " · " + K.daysText(e.daysLeft), K.urgency(e.daysLeft)));
          ul.appendChild(li);
        });
        more.appendChild(ul);
        if (g.renewing.length > soon.length) more.appendChild(K.moreButton("Show all " + g.renewing.length + " renewals", function () { openRegister(draw); }));
      }
      if (g.freeCount) more.appendChild(h("p", "dim", K.plural(g.freeCount, "free account") + " left out: nothing to renew."));
      body.appendChild(more);

      var rich = h("div", "tl-rich");
      var need = (s.assets.needed || []).slice(0, 5);
      if (need.length) {
        rich.appendChild(h("p", "tl-sub", "Still needed from you"));
        var nl = h("ul", "tl-list");
        need.forEach(function (n) { var li = h("li", "tl-row"); li.appendChild(h("span", null, n.name)); li.appendChild(h("span", "dim", needText(n.missing))); nl.appendChild(li); });
        rich.appendChild(nl);
        if (g.needed > need.length) rich.appendChild(K.moreButton("Show all " + g.needed + " in the register", function () { openRegister(draw); }));
      }
      body.appendChild(rich);
    }

    function load() {
      return K.summary().then(function (r) {
        if (r.status !== 200) { K.loadFailure(body, r, load); return; }
        state.summary = r.body;
        // Whether a renewal is on a free account is on the register entry, not in the summary: read the register once, but only when
        // the summary lists something that could be free. If that read fails the list is shown whole, never hidden.
        var maybeFree = ((r.body.assets && r.body.assets.expiring) || []).some(function (e) { return FREE_KINDS.indexOf(e.kind) !== -1 && e.free !== true; });
        if (!maybeFree) { state.byId = null; paint(); return; }
        return K.call("GET", "/reg/assets").then(function (ra) {
          state.byId = null;
          if (ra.status === 200 && ra.body && Array.isArray(ra.body.assets)) { state.byId = {}; ra.body.assets.forEach(function (a) { state.byId[a.id] = a; }); }
          paint();
        });
      });
    }
    function draw() { return load(); }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  // ---- 3. the register (the drawer) -----------------------------------------------------------------------------

  function openRegister(onClose) {
    var st = { assets: [], summary: null, kind: "", q: "", msg: null, editing: null };
    var d = K.openDrawer("Assets & services", onClose);
    var foot = d.footer;

    function say(text, tone) { st.msg = text ? { text: text, tone: tone || "" } : null; }
    function fail(r) {
      var text = K.errorText(r.body, r.status);
      say(text, "alert");
      if (K.needsSignIn(r.body, r.status) && K.loginHref()) st.msg.login = K.loginHref();
    }

    function reload() {
      return K.call("GET", "/reg/assets").then(function (r) {
        if (r.status === 200) { st.assets = r.body.assets || []; st.summary = r.body.summary || null; } else fail(r);
        showList();
      });
    }

    function messageBox() {
      if (!st.msg) return null;
      var m = h("div", "tk-msg " + st.msg.tone, st.msg.text + " ");
      if (st.msg.login) { var a = h("a", "btn btn-sm", "Sign in again"); a.href = st.msg.login; m.appendChild(a); }
      return m;
    }

    function totalsBox() {
      var t = st.summary && st.summary.totals ? st.summary.totals : [];
      var box = h("div", "tk-totals");
      if (!t.length) { box.appendChild(h("span", "dim", "No costs entered yet.")); return box; }
      t.forEach(function (x) {
        box.appendChild(h("span", null, K.moneyText(x.monthlyCents, x.currency) + " a month"));
        box.appendChild(h("span", null, K.moneyText(x.annualCents, x.currency) + " a year"));
        box.appendChild(h("span", "dim", K.plural(x.items, "recurring cost")));
      });
      return box;
    }

    function showList() {
      clear(d.body); clear(foot);
      d.setTitle("Assets & services");
      var m = messageBox(); if (m) d.body.appendChild(m);
      if (!st.assets.length) {
        d.body.appendChild(h("p", "dim", "Nothing in the register yet."));
        var sb = h("button", "btn btn-primary", "Add the starting list"); sb.type = "button";
        sb.addEventListener("click", function () { sb.disabled = true; K.call("POST", "/reg/seed").then(function (r) { if (r.status === 200) say("Added " + K.plural(r.body.added, "entry", "entries") + ". Fill in the costs and dates marked as needed.", "ok"); else fail(r); reload(); }); });
        var fb = h("button", "btn", "Add your first asset"); fb.type = "button"; fb.addEventListener("click", function () { showForm(null); });
        var row = h("div", "tk-bar"); row.appendChild(sb); row.appendChild(fb); d.body.appendChild(row);
        return;
      }
      d.body.appendChild(totalsBox());
      var bar = h("div", "tk-bar");
      var search = h("input"); search.type = "search"; search.placeholder = "Search the register"; search.value = st.q; search.setAttribute("aria-label", "Search the register");
      var kind = h("select"); kind.setAttribute("aria-label", "Kind");
      [["", "Every kind"]].concat(KINDS.map(function (k) { return [k[0], k[2]]; })).forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; if (o[0] === st.kind) op.selected = true; kind.appendChild(op); });
      var add = h("button", "btn btn-sm btn-primary", "Add an asset"); add.type = "button"; add.addEventListener("click", function () { showForm(null); });
      bar.appendChild(search); bar.appendChild(kind); bar.appendChild(add);
      if (st.assets.some(function (a) { return a.watch; })) {
        var chk = h("button", "btn btn-sm", "Check domains now"); chk.type = "button";
        chk.addEventListener("click", function () { chk.disabled = true; K.call("POST", "/reg/domains/check").then(function (r) { if (r.status === 200) say("Asked the registrars: " + r.body.found + " of " + r.body.checked + " dates read.", "ok"); else fail(r); reload(); }); });
        bar.appendChild(chk);
      }
      d.body.appendChild(bar);
      var listBox = h("div"); d.body.appendChild(listBox);
      function drawRows() {
        clear(listBox);
        var groups = groupByKind(filterAssets(st.assets, { kind: st.kind, q: st.q }));
        if (!groups.length) { listBox.appendChild(h("p", "dim", "Nothing matches.")); return; }
        var now = Date.now();
        groups.forEach(function (g) {
          var sec = h("section", "tk-group"); sec.appendChild(h("h3", null, g.label));
          var rows = h("div", "tk-rows");
          g.items.forEach(function (a) {
            var item = h("div", "tk-item");
            var main = h("div", "tk-item-main");
            main.appendChild(h("span", "tk-item-name", a.name));
            var meta = h("span", "tk-item-meta");
            [a.owner ? "Owner: " + a.owner : "", a.location, costLine(a)].forEach(function (t) { if (t) meta.appendChild(h("span", null, t)); });
            main.appendChild(meta);
            if (a.runs) main.appendChild(h("span", "tk-item-meta", a.runs));
            if (a.watch && a.rdapNote && !a.rdapExpires) main.appendChild(h("span", "tk-item-meta", a.rdapNote));
            var chips = h("div", "tk-item-chips");
            var ex = expiryModel(a, now);
            if (a.expires || a.rdapExpires || a.dateState === "auto" || ["domain", "certificate", "licence", "subscription"].indexOf(a.kind) !== -1) chips.appendChild(chip(ex.text, ex.tone));
            if (ex.source) chips.appendChild(chip(ex.source === "registrar" ? "From the registrar" : "Estimated", "info"));
            var needed = neededClient(a); if (needed.length) chips.appendChild(chip(needText(needed), "attn"));
            if (a.renewalItem) { var rl = h("a", "chip accent", "On the Calendar"); rl.href = "ops.html#" + a.renewalItem; chips.appendChild(rl); }
            var edit = h("button", "btn btn-sm", "Edit"); edit.type = "button"; edit.addEventListener("click", function () { showForm(a); });
            chips.appendChild(edit);
            item.appendChild(main); item.appendChild(chips);
            rows.appendChild(item);
          });
          sec.appendChild(rows); listBox.appendChild(sec);
        });
      }
      search.addEventListener("input", function () { st.q = search.value; drawRows(); });
      kind.addEventListener("change", function () { st.kind = kind.value; drawRows(); });
      drawRows();
    }

    // What an asset still needs, worked out here too so the list needs no extra call (the Worker's rules, registry-logic.js).
    function neededClient(a) {
      var n = [];
      if (["domain", "certificate", "licence", "subscription", "account"].indexOf(a.kind) !== -1 && !(a.rdapExpires || a.expires) && a.dateState !== "auto") n.push("expires");
      if (["server", "domain", "licence", "subscription"].indexOf(a.kind) !== -1 && (a.costCents === null || a.costCents === undefined)) n.push("cost");
      if (!a.owner) n.push("owner");
      if (["server", "app"].indexOf(a.kind) !== -1 && ["critical", "high"].indexOf(a.criticality) !== -1 && !a.runbook) n.push("runbook");
      return n;
    }

    // The "Accepted gaps" part of the form: one row for each thing this kind of asset is asked for (a monitor, a backup, a runbook, an
    // expiry watch): tick it, say why, pick the day to look at it again. It is added to the form that is being built (`form`, below).
    // -> { el, fields, show(kind), read() }
    function acceptedEditor(asset, form) {
      var have = {};
      ((asset && asset.acceptedGaps) || []).forEach(function (a) { have[a.gap] = a; });
      var now = Date.now();
      var box = h("fieldset", "tk-accept wide");
      box.appendChild(h("legend", null, "Accepted gaps"));
      box.appendChild(h("p", "hint", "A gap you have decided to live with for now. It stays listed on the map and the Weakest links tile with your reason, and counts again after the review day. Never put a password or key in the reason."));
      var rows = {}, fields = {};
      GAPS.forEach(function (g) {
        var a = have[g[0]];
        var row = h("div", "tk-accept-row");
        var on = h("input"); on.type = "checkbox"; on.checked = !!a; on.id = "accept-" + g[0];
        var lab = h("label", "tk-check", "Accept: " + g[1]); lab.setAttribute("for", on.id);
        var reason = h("input"); reason.type = "text"; reason.maxLength = REASON_MAX; reason.value = a ? a.reason : ""; reason.placeholder = "Why (short)"; reason.setAttribute("aria-label", "Why you accept: " + g[1]);
        var review = h("input"); review.type = "date"; review.value = a ? a.review : ""; review.max = farthestReview(now); review.setAttribute("aria-label", "Look at this again on (" + g[1] + ")");
        function paintRow() { reason.disabled = review.disabled = !on.checked; if (on.checked && !review.value) review.value = defaultReview(now); }
        on.addEventListener("change", function () { paintRow(); if (on.checked) reason.focus(); });
        paintRow();
        row.appendChild(on); row.appendChild(lab); row.appendChild(reason); row.appendChild(review);
        box.appendChild(row);
        rows[g[0]] = { row: row, on: on, reason: reason, review: review };
        fields["accept-" + g[0] + "-reason"] = reason; fields["accept-" + g[0] + "-review"] = review;
      });
      var none = h("p", "hint", "Nothing is asked for on this kind of asset, so there is nothing to accept.");
      box.appendChild(none);
      form.appendChild(box);
      return {
        el: box, fields: fields,
        show: function (kind) {
          var ok = gapsFor(kind).map(function (g) { return g[0]; });
          GAPS.forEach(function (g) { rows[g[0]].row.hidden = ok.indexOf(g[0]) === -1; });
          none.hidden = ok.length > 0;
        },
        read: function () {
          var out = [];
          GAPS.forEach(function (g) { var r = rows[g[0]]; if (r.on.checked) out.push({ gap: g[0], reason: r.reason.value, review: r.review.value }); });
          return out;
        }
      };
    }

    function showForm(asset) {
      clear(d.body); clear(foot);
      d.setTitle(asset ? "Edit " + asset.name : "Add an asset");
      var v = formValues(asset);
      var form = h("form", "tk-form"); form.noValidate = true;
      var inputs = {};
      function field(key, label, el, wide, hint) {
        var l = h("label", wide ? "wide" : "", label);
        inputs[key] = el; l.appendChild(el);
        if (hint) l.appendChild(h("span", "hint", hint));
        form.appendChild(l); return el;
      }
      function text(key, label, wide, hint, type) { var i = h("input"); i.type = type || "text"; i.value = v[key]; i.maxLength = 300; return field(key, label, i, wide, hint); }
      function select(key, label, opts, wide) { var s = h("select"); opts.forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; if (o[0] === v[key]) op.selected = true; s.appendChild(op); }); return field(key, label, s, wide); }
      select("kind", "Kind", KINDS.map(function (k) { return [k[0], k[1]]; }));
      text("name", "Name");
      text("owner", "Who looks after it");
      select("criticality", "How important", CRITICALITY);
      text("location", "Where it lives", true);
      text("runs", "What it runs or does", true);
      text("expires", "Expires or renews on", false, "Leave empty if you do not know yet.", "date");
      select("dateState", "How sure is the date", DATE_STATES);
      text("cost", "Cost", false, "A plain amount such as 12.50; 0 means free; empty means not known.");
      select("costPeriod", "Cost is per", PERIODS);
      text("runbook", "Runbook article", true, "The title of the Knowledgebase article that explains how to fix or rebuild it.");
      text("link", "Admin or portal link", true, "Starts with https://", "url");
      select("monitorId", "Watched by the monitor", MONITORS);
      text("renewalItem", "Ops item that holds the renewal date", false, "Looks like it_ followed by 8 letters or numbers. The Calendar reads the date from there.");
      var watch = text("watch", "Domain to check with the registrar", true, "Only for a domain: its expiry is read from the registrar every day.");
      var notes = h("textarea"); notes.value = v.notes; notes.maxLength = 1000; field("notes", "Notes (never a password or key; say where it is kept)", notes, true);
      var acceptBox = acceptedEditor(asset, form);
      var msg = h("div"); d.body.appendChild(msg);
      d.body.appendChild(form);

      var save = h("button", "btn btn-primary", asset ? "Save changes" : "Add it"); save.type = "button";
      var cancel = h("button", "btn", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", function () { say(null); showList(); });
      foot.appendChild(save); foot.appendChild(cancel);
      if (asset) {
        var del = h("button", "btn btn-quiet tk-push", "Remove"); del.type = "button";
        del.addEventListener("click", function () {
          if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Really remove it?"; return; }
          del.disabled = true;
          K.call("DELETE", "/reg/assets/" + asset.id + "?confirm=1").then(function (r) { if (r.status === 200) say("Removed " + asset.name + ".", "ok"); else fail(r); reload(); });
        });
        foot.appendChild(del);
      }
      function sync() { watch.disabled = inputs.kind.value !== "domain"; acceptBox.show(inputs.kind.value); }
      inputs.kind.addEventListener("change", sync); sync();
      save.addEventListener("click", function () {
        var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value; });
        vals.acceptedGaps = acceptBox.read();
        var built = formToBody(vals, asset);
        clear(msg);
        if (built.error) { msg.appendChild(h("div", "tk-msg alert", built.error)); var bad = inputs[built.field] || acceptBox.fields[built.field]; if (bad) bad.focus(); return; }
        if (asset && !Object.keys(built.body).length) { say("Nothing changed.", ""); showList(); return; }
        save.disabled = true;
        var p = asset ? K.call("PATCH", "/reg/assets/" + asset.id, built.body) : K.call("POST", "/reg/assets", built.body);
        p.then(function (r) {
          if (r.status === 200 || r.status === 201) { say((asset ? "Saved " : "Added ") + r.body.asset.name + ".", "ok"); reload(); return; }
          save.disabled = false;
          fail(r);
          clear(msg); var m = messageBox(); if (m) msg.appendChild(m);
        });
      });
      inputs.name.focus();
    }

    d.body.appendChild(h("p", "dim", "Loading the register…"));
    reload();
  }

  K.register({
    id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH,
    ownerOnly: true, permission: desc.permission, render: render, openRegister: openRegister
  });
})(typeof window !== "undefined" ? window : globalThis);
