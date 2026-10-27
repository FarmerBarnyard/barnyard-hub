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
    ["account", "Account", "Accounts and tenants"], ["app", "App or site", "Apps and sites"], ["licence", "Licence", "Licences"],
    ["subscription", "Subscription", "Subscriptions"], ["network", "Network", "Network"], ["other", "Other", "Other"]
  ];
  var KIND_ONE = {}, KIND_MANY = {};
  KINDS.forEach(function (k) { KIND_ONE[k[0]] = k[1]; KIND_MANY[k[0]] = k[2]; });
  var CRITICALITY = [["", "Not set"], ["critical", "Critical"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]];
  var DATE_STATES = [["", "Known"], ["estimated", "Estimated"], ["needed", "Needed"], ["auto", "Renews itself"]];
  var PERIODS = [["month", "a month"], ["year", "a year"], ["once", "once"]];
  var MONITORS = [["", "None"], ["app02", "app02"], ["cld01", "BARNYARDCLD01"], ["vtt", "VTT server"], ["site-dashboard", "Dashboard site"], ["site-study", "Study site"], ["site-campaign", "Campaign site"], ["site-stocks", "Stocks site"]];
  var NEED_WORDS = { expires: "a date", cost: "a cost", owner: "an owner", runbook: "a runbook" };

  // "needs a date and a cost"
  function needText(missing) {
    var w = (missing || []).map(function (m) { return NEED_WORDS[m] || m; });
    if (!w.length) return "";
    return "needs " + (w.length === 1 ? w[0] : w.slice(0, -1).join(", ") + " and " + w[w.length - 1]);
  }

  // The numbers on the tile, from GET /reg/summary.
  function glance(summary) {
    var a = summary && summary.assets ? summary.assets : { count: 0, neededCount: 0, expiring: [], totals: [] };
    var soon = a.expiring && a.expiring.length ? a.expiring[0] : null;
    var cost = a.totals && a.totals.length ? a.totals.map(function (t) { return K.moneyText(t.monthlyCents, t.currency); }).join(" + ") : "";
    return {
      count: a.count || 0, needed: a.neededCount || 0, expiring: (a.expiring || []).length,
      soonestDays: soon ? soon.daysLeft : null, costMonthly: cost,
      annual: a.totals && a.totals.length ? a.totals.map(function (t) { return K.moneyText(t.annualCents, t.currency); }).join(" + ") : ""
    };
  }

  // One expiry as the tile and the list say it: { text, tone, source }.
  function expiryModel(asset, now) {
    var date = asset.rdapExpires || asset.expires || "";
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
    return { body: body };
  }

  var helpers = {
    KINDS: KINDS, KIND_ONE: KIND_ONE, KIND_MANY: KIND_MANY, needText: needText, glance: glance, expiryModel: expiryModel,
    costLine: costLine, filterAssets: filterAssets, groupByKind: groupByKind, formValues: formValues, formToBody: formToBody
  };
  var desc = {
    id: "assets", title: "Assets & services", about: "What you run, who looks after it, when it renews and what it costs.",
    w: 6, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true
  };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  // ---- 2. the tile ----------------------------------------------------------------------------------------------

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var state = { summary: null, busy: false };
    var wrap = h("div", "tl");
    var head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("button", "btn btn-sm", "Open register");
    open.type = "button";
    open.addEventListener("click", function () { openRegister(draw); });
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
      var g = glance(s);
      if (message) body.appendChild(h("div", "tk-msg" + (isError ? " alert" : ""), message));
      if (!g.count) {
        var empty = h("div", "tl-notice");
        empty.appendChild(h("p", "dim", "Nothing in the register yet. Start with a list of what the notes and repositories already say you run, then fill in the gaps."));
        var b = h("button", "btn btn-sm btn-primary", "Add the starting list"); b.type = "button"; b.addEventListener("click", seed);
        empty.appendChild(b);
        body.appendChild(empty);
        return;
      }
      var stats = h("ul", "tl-stats");
      function stat(n, label, tone) { var li = h("li", "tl-stat" + (tone ? " " + tone : "")); li.appendChild(h("b", null, n)); li.appendChild(h("span", null, label)); stats.appendChild(li); }
      stat(String(g.count), K.plural(g.count, "item").replace(/^\d+ /, ""));
      stat(String(g.needed), "need details", g.needed ? "attn" : "");
      stat(String(g.expiring), "renewing within 60 days", g.soonestDays !== null && g.soonestDays <= 7 ? "alert" : g.expiring ? "attn" : "");
      stat(g.costMonthly || "None", g.costMonthly ? "a month" : "costs entered");
      body.appendChild(stats);

      var more = h("div", "tl-more");
      more.appendChild(h("p", "tl-sub", "Renewing soon"));
      var soon = (s.assets.expiring || []).slice(0, 4);
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
      }
      body.appendChild(more);

      var rich = h("div", "tl-rich");
      var need = (s.assets.needed || []).slice(0, 5);
      if (need.length) {
        rich.appendChild(h("p", "tl-sub", "Still needed from you"));
        var nl = h("ul", "tl-list");
        need.forEach(function (n) { var li = h("li", "tl-row"); li.appendChild(h("span", null, n.name)); li.appendChild(h("span", "dim", needText(n.missing))); nl.appendChild(li); });
        rich.appendChild(nl);
      }
      body.appendChild(rich);
    }

    function load() {
      return K.call("GET", "/reg/summary").then(function (r) {
        if (r.status === 200) { state.summary = r.body; paint(); return; }
        K.loadFailure(body, r, load);
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
      function sync() { watch.disabled = inputs.kind.value !== "domain"; }
      inputs.kind.addEventListener("change", sync); sync();
      save.addEventListener("click", function () {
        var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value; });
        var built = formToBody(vals, asset);
        clear(msg);
        if (built.error) { msg.appendChild(h("div", "tk-msg alert", built.error)); var bad = inputs[built.field]; if (bad) bad.focus(); return; }
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
    ownerOnly: true, render: render, openRegister: openRegister
  });
})(typeof window !== "undefined" ? window : globalThis);
