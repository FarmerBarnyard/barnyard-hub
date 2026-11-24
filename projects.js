// The Projects page (projects.html): project management and timeline review in one place.
//
// The live part reads the Ops board exactly as the Ops page does (GET /ops/board, plus GET /ops/done for finished items, with the
// signed-in session cookie). It never writes: items are edited on the Ops board and this page just reflects them. The plan (timeline,
// sittings, costs) is private data kept in the Worker and read with GET /ops/projects-plan (owner only), never shipped with this page.
// All rules are in projects-logic.js (tested in test/projects.test.js).
//
// When the API cannot be reached, shell.js serves the last board this browser fetched and shows its "old data" banner; nothing
// here needs to know. Everything from the server reaches the page through textContent, never innerHTML, and the page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout: 1. data  2. small DOM helpers  3. sections  4. boot

(function () {
  "use strict";

  var L = window.BarnyardProjectsLogic;
  var DATA = { projects: [] }; // replaced by the plan the Worker sends once the person is signed in as the owner
  var API = "https://api.barnyard.site/ops";
  var POLL_MS = 60000;

  var model = { state: "loading", open: [], done: [], doneOk: true, projectId: "", fetchedAt: 0, signature: "" };
  var toggled = {}; // item id -> true/false once the person opens or closes its steps

  // ---- 1. data --------------------------------------------------------------

  function getJson(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    return fetch(API + path, { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) { var e = new Error("http"); e.status = r.status; throw e; }
        return r.json();
      }, function (err) { clearTimeout(timer); throw err; });
  }

  function load() {
    // The plan is private: it comes from the Worker with the board, so a stranger (or a guest) is never sent it.
    return getJson("/projects-plan").then(function (r) {
      var plan = r && r.plan;
      if (!plan || !Array.isArray(plan.projects) || !plan.projects.length) throw new Error("plan");
      DATA = plan;
      pickFromHash();
    }).then(function () { return getJson("/board"); }).then(function (snap) {
      model.open = Array.isArray(snap.items) ? snap.items : [];
      model.state = "ok";
      model.fetchedAt = Date.now();
      // Finished phases come from a second read; the page still works without it.
      return getJson("/done?limit=100").then(function (d) { model.done = Array.isArray(d.items) ? d.items : []; model.doneOk = true; },
        function () { model.done = []; model.doneOk = false; });
    }).then(function () { refresh(); }, function (err) {
      if (err && err.status === 401) model.state = "guest";
      else if (err && err.status === 404) model.state = "noboard";
      else if (err && err.status === 403) model.state = "forbidden";
      else model.state = model.state === "ok" ? "ok" : "error";
      refresh();
    });
  }

  function currentProject() {
    var list = DATA.projects, i;
    for (i = 0; i < list.length; i++) if (list[i].id === model.projectId) return list[i];
    return list[0] || null;
  }

  // ---- 2. small DOM helpers ---------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function today() { return L.dateString(new Date()); }

  function tile(label, value, note, cls) {
    var t = h("div", "box pj-tile" + (cls ? " " + cls : ""));
    add(t, h("span", "pj-k", label), h("span", "pj-v", value));
    if (note) t.appendChild(h("span", "pj-n", note));
    return t;
  }

  function section(id, title, sub) {
    var s = h("section", "pj-sec");
    s.setAttribute("aria-labelledby", id);
    var head = h("div", "sec-head");
    var h2 = h("h2", null, title);
    h2.id = id;
    head.appendChild(h2);
    if (sub) head.appendChild(h("span", "sub", sub));
    s.appendChild(head);
    return s;
  }

  function scroller(label, child) {
    var w = h("div", "pj-scroll");
    w.tabIndex = 0;
    w.setAttribute("role", "region");
    w.setAttribute("aria-label", label);
    w.appendChild(child);
    return w;
  }

  function tag(t, text) {
    var info = L.confidence(t);
    var c = h("span", "pj-tag " + t, info ? info.word : text);
    if (info) c.title = info.about;
    return c;
  }

  // ---- 3. sections -----------------------------------------------------------

  // The live tiles: next sitting (from the plan), phase counts, next due date and the master item (from the board).
  function liveTiles(p, built, now) {
    var wrap = h("div", "pj-tiles");
    var s = L.nextSitting(p.sittings, now);
    wrap.appendChild(s
      ? tile("Next sitting", s.when, L.clip(s.lead || s.what, 110) + (s.length ? " About " + s.length.replace(/^about /, "") + "." : ""), "")
      : tile("Next sitting", "None dated", "No sitting in the plan has a date on or after today."));

    var c = L.laneCounts(built.phases);
    var counts = h("div", "box pj-tile");
    counts.appendChild(h("span", "pj-k", "Phase items"));
    var row = h("div", "pj-counts");
    [["in_progress", "In progress"], ["waiting", "Waiting"], ["backlog", "Backlog"]].forEach(function (x) {
      var cell = h("span", "pj-count");
      add(cell, h("b", "pj-v", String(c[x[0]])), h("span", null, x[1]));
      row.appendChild(cell);
    });
    counts.appendChild(row);
    var extra = [];
    if (c.soaking) extra.push(c.soaking + " soaking");
    if (c.done) extra.push(c.done + " done");
    counts.appendChild(h("span", "pj-n", built.phases.length ? (c.total + " phase" + (c.total === 1 ? "" : "s") + " on the board" + (extra.length ? ": " + extra.join(", ") : "")) : "No phase items found on the board."));
    wrap.appendChild(counts);

    var nd = L.nextDue(built.phases, now);
    if (nd) {
      wrap.appendChild(tile("Next due", nd.info.date, nd.phase.label + ": " + nd.phase.name + " (" + nd.info.rel + ")" + (nd.overdue > 1 ? ". " + nd.overdue + " are overdue." : ""), "tone-" + nd.info.tone));
    } else wrap.appendChild(tile("Next due", "No date set", "No open phase has a due date."));

    if (built.master) {
      var m = built.master;
      wrap.appendChild(tile("Master roadmap", L.statusTitle(m.status), L.laneTitle(m.lane) + (m.due && L.isDate(m.due) ? ". Due " + L.shortDate(m.due) : "")));
    }
    return wrap;
  }

  function milestonesBlock(p) {
    var b = h("div", "pj-group");
    b.appendChild(h("h3", null, "Where each milestone lands"));
    var w = h("div", "pj-tiles pj-tiles-wide");
    (p.milestones || []).forEach(function (m) { w.appendChild(tile(m.label, m.value, m.note)); });
    b.appendChild(w);
    return b;
  }

  function scenarioSummary(p) {
    var b = h("div", "pj-group");
    b.appendChild(h("h3", null, "Cost scenarios"));
    var box = h("div", "box pj-tile pj-scen-sum");
    var dl = h("dl", "pj-dl");
    (p.scenarios || []).forEach(function (s) { add(dl, h("dt", null, s.label), h("dd", "pj-mono", s.value)); });
    box.appendChild(dl);
    box.appendChild(h("span", "pj-n", "AUD. Each line is added to the one above it, as set out under Costs."));
    b.appendChild(box);
    return b;
  }

  function stepList(title, steps, who) {
    var col = h("div", "pj-steps-col");
    var head = h("h4", null, title);
    head.appendChild(h("span", "pj-steps-n", " " + (steps.length - L.openCount(steps)) + "/" + steps.length));
    col.appendChild(head);
    if (!steps.length) { col.appendChild(h("p", "dim pj-none", "None.")); return col; }
    var ul = h("ul", "pj-steps");
    steps.forEach(function (st) {
      var li = h("li", st.done ? "is-done" : "");
      li.appendChild(h("span", "pj-tick", st.done ? "✓" : ""));
      li.lastChild.setAttribute("aria-hidden", "true");
      add(li, h("span", "sr-only", st.done ? "Done: " : "To do: "), h("span", null, st.text));
      ul.appendChild(li);
    });
    col.appendChild(ul);
    col.setAttribute("data-who", who);
    return col;
  }

  function phaseCard(label, name, item, now, cls) {
    var card = h("article", "box pj-card" + (cls ? " " + cls : ""));
    var titleId = "pj-t-" + item.id;
    card.setAttribute("aria-labelledby", titleId);
    var top = h("div", "pj-card-top");
    top.appendChild(h("span", "chip accent", label));
    var title = h("h3", null, name);
    title.id = titleId;
    top.appendChild(title);
    card.appendChild(top);

    var meta = h("div", "pj-meta");
    var st = h("span", "st " + L.statusTone(item.status));
    add(st, h("i"), document.createTextNode(L.statusTitle(item.status)));
    meta.appendChild(st);
    meta.appendChild(h("span", "chip", L.laneTitle(item.lane)));
    if (item.proposal) meta.appendChild(h("span", "chip attn", "Proposal"));
    // A finished item keeps its date but is never "overdue".
    var due = L.dueInfo(item.due, now);
    if (due && item.lane === "done") meta.appendChild(h("span", "chip", "Was due " + due.date));
    else if (due) meta.appendChild(h("span", "chip pj-due is-" + due.tone, "Due " + due.text));
    var steps = L.splitSteps(item);
    if (steps.total) meta.appendChild(h("span", "chip", steps.done + "/" + steps.total + " steps"));
    card.appendChild(meta);

    var sum = L.summaryOf(item);
    if (sum) card.appendChild(h("p", "pj-summary", sum));
    var dl = h("dl", "pj-facts");
    if (item.progress) add(dl, h("dt", null, "Where it’s at"), h("dd", null, item.progress));
    if (item.next) add(dl, h("dt", null, "Next"), h("dd", null, item.next));
    if (dl.firstChild) card.appendChild(dl);

    if (steps.total) {
      var det = h("details", "pj-stepbox");
      var wanted = toggled[item.id];
      det.open = wanted === undefined ? L.openCount(steps.you) > 0 : wanted;
      var sm = h("summary", null, "Steps");
      var openYou = L.openCount(steps.you), openClaude = L.openCount(steps.claude);
      sm.appendChild(h("span", "pj-sum-n", " · " + openYou + " to do for you, " + openClaude + " for Claude"));
      det.appendChild(sm);
      var cols = h("div", "pj-steps-cols");
      add(cols, stepList("Your acts", steps.you, "you"), stepList("Claude", steps.claude, "claude"));
      det.appendChild(cols);
      det.addEventListener("toggle", function () { toggled[item.id] = det.open; });
      card.appendChild(det);
    }

    var href = L.itemHref(item);
    if (href) {
      var foot = h("div", "pj-card-foot");
      var a = h("a", "btn btn-sm", "Open on the Ops board");
      a.href = href;
      foot.appendChild(a);
      card.appendChild(foot);
    }
    return card;
  }

  function phasesSection(p, built, now) {
    var sec = section("pj-h-phases", "Phases", "Live from the Ops board. Edit them there.");
    var any = false;
    if (built.master) {
      any = true;
      sec.appendChild(phaseCard("Master", L.masterName(built.master.title), built.master, now, "pj-card-master"));
    }
    if (built.phases.length) {
      any = true;
      var grid = h("div", "pj-cards");
      built.phases.forEach(function (ph) { grid.appendChild(phaseCard(ph.label, ph.name, ph.item, now, ph.costs ? "pj-card-costs" : "")); });
      sec.appendChild(grid);
    }
    if (!any) sec.appendChild(h("p", "dim", "No Ops board items start with “" + p.prefix + "” yet. Add items titled “" + p.phasePrefix + "1: …” and so on, and they appear here."));
    else if (!model.doneOk) sec.appendChild(h("p", "dim pj-note", "Finished items could not be read just now, so a completed phase may be missing."));
    return sec;
  }

  function timelineSection(p) {
    var tl = p.timeline;
    var sec = section("pj-h-timeline", "Timeline by track", "Planning estimates");
    sec.appendChild(h("p", "dim pj-note", tl.note || ""));
    var heads = L.monthHeads(tl), nowCol = L.currentColumn(tl, today());

    var legend = h("ul", "pj-legend");
    L.legendKinds(tl).forEach(function (k) {
      var li = h("li");
      li.appendChild(h("i", "pj-sw " + k));
      li.appendChild(document.createTextNode((p.kinds && p.kinds[k]) || k));
      legend.appendChild(li);
    });
    if (nowCol >= 0) { var li = h("li"); li.appendChild(h("i", "pj-sw now")); li.appendChild(document.createTextNode("This month")); legend.appendChild(li); }
    sec.appendChild(legend);

    var table = h("table", "pj-gantt");
    table.appendChild(h("caption", "sr-only", p.name + " roadmap timeline by month"));
    var thead = h("thead"), hr = h("tr");
    var corner = h("th", "pj-lab", "Track and step");
    corner.scope = "col";
    hr.appendChild(corner);
    heads.forEach(function (m) {
      var th = h("th", "pj-month" + (m.yearStart ? " yr" : "") + (m.index === nowCol ? " is-now" : ""), m.label);
      th.scope = "col";
      if (m.index === nowCol) th.setAttribute("aria-current", "date");
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    tl.tracks.forEach(function (t) {
      var body = h("tbody");
      var gr = h("tr", "pj-grp");
      var gh = h("th", null, t.id + ". " + t.title);
      gh.colSpan = heads.length + 1;
      gh.scope = "colgroup";
      gr.appendChild(gh);
      body.appendChild(gr);
      t.rows.forEach(function (r) {
        var tr = h("tr");
        var lab = h("th", "pj-lab");
        lab.scope = "row";
        lab.appendChild(h("span", null, r.label));
        if (r.note) lab.appendChild(h("small", null, r.note));
        tr.appendChild(lab);
        L.rowCells(r, tl).forEach(function (c) {
          var td = h("td");
          if (c.span > 1) td.colSpan = c.span;
          if (c.bar) {
            var bar = h("div", "pj-bar " + c.bar.kind);
            bar.appendChild(h("span", null, c.bar.label));
            bar.appendChild(h("span", "sr-only", " (" + L.barRange(c.bar, heads) + ")"));
            td.appendChild(bar);
          }
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
    });
    sec.appendChild(scroller("Roadmap timeline, scrolls sideways", table));
    return sec;
  }

  function sittingsSection(p) {
    var sec = section("pj-h-sittings", "Every sitting and every act of yours", "Planning estimates");
    if (p.sittingsNote) sec.appendChild(h("p", "dim pj-note", p.sittingsNote));
    var table = h("table", "pj-table pj-sittings");
    table.appendChild(h("caption", "sr-only", "Sittings and acts"));
    var hr = h("tr");
    ["#", "When (target)", "What", "Length", "Depends on"].forEach(function (c) { var th = h("th", null, c); th.scope = "col"; hr.appendChild(th); });
    table.appendChild(add(h("thead"), hr));
    var body = h("tbody");
    p.sittings.forEach(function (s) {
      var tr = h("tr", s.kind === "act" ? "is-act" : "");
      add(tr, h("td", "pj-mono", s.n), h("td", "pj-when", s.when));
      var what = h("td");
      if (s.you) what.appendChild(h("span", "chip accent pj-you", "you"));
      if (s.lead) what.appendChild(h("strong", null, s.lead));
      if (s.what) what.appendChild(document.createTextNode((s.lead ? " " : (s.you ? " " : "")) + s.what));
      tr.appendChild(what);
      add(tr, h("td", "pj-len", s.length), h("td", null, s.depends));
      body.appendChild(tr);
    });
    table.appendChild(body);
    sec.appendChild(scroller("Sittings and acts, scrolls sideways", table));
    return sec;
  }

  function costsSection(p, built) {
    var sec = section("pj-h-costs", "Costs", "Planning estimates");
    var note = h("p", "dim pj-note");
    note.appendChild(document.createTextNode(p.costsNote || ""));
    sec.appendChild(note);
    var legend = h("ul", "pj-legend");
    ["ver", "doc", "est"].forEach(function (k) {
      var li = h("li");
      li.appendChild(tag(k));
      li.appendChild(document.createTextNode(L.confidence(k).about));
      legend.appendChild(li);
    });
    sec.appendChild(legend);

    var reg = built && built.phases.filter(function (x) { return x.costs; })[0];
    if (reg && L.itemHref(reg.item)) {
      var rp = h("p", "pj-note");
      rp.appendChild(document.createTextNode("The costs register on the Ops board: "));
      var a = h("a", null, reg.item.title);
      a.href = L.itemHref(reg.item);
      rp.appendChild(a);
      sec.appendChild(rp);
    }

    var table = h("table", "pj-table pj-costs");
    table.appendChild(h("caption", "sr-only", "Costs in Australian dollars unless stated"));
    var hr = h("tr");
    [["Item", ""], ["When", ""], ["Cost (AUD unless stated)", "r"], ["Basis", ""]].forEach(function (c) { var th = h("th", c[1], c[0]); th.scope = "col"; hr.appendChild(th); });
    table.appendChild(add(h("thead"), hr));
    var body = h("tbody");
    p.costs.forEach(function (c) {
      var tr = h("tr");
      add(tr, h("td", null, c.item), h("td", "pj-when", c.when), h("td", "r", c.cost));
      var basis = h("td", "pj-basis");
      (c.basis || []).forEach(function (b, i) {
        if (i) basis.appendChild(document.createTextNode(" "));
        if (b.tag) basis.appendChild(tag(b.tag));
        if (b.text) basis.appendChild(document.createTextNode((b.tag ? " " : "") + b.text));
      });
      tr.appendChild(basis);
      body.appendChild(tr);
    });
    table.appendChild(body);
    sec.appendChild(scroller("Costs, scrolls sideways", table));

    var sc = h("div", "pj-tiles pj-tiles-wide pj-scenarios");
    p.scenarios.forEach(function (s) { sc.appendChild(tile(s.label, s.value, s.note)); });
    sec.appendChild(sc);

    if (p.assumptions && p.assumptions.length) {
      var as = h("div", "box pj-assume");
      as.appendChild(h("h3", null, "What these numbers rest on"));
      var ul = h("ul");
      p.assumptions.forEach(function (t) { ul.appendChild(h("li", null, t)); });
      as.appendChild(ul);
      sec.appendChild(as);
    }
    return sec;
  }

  // ---- render ----------------------------------------------------------------

  function message(text, linkText, href) {
    var root = $("pj-root");
    clear(root);
    root.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; root.appendChild(a); }
  }

  function renderSwitch() {
    var box = $("pj-switch");
    clear(box);
    DATA.projects.forEach(function (p) {
      var b = h("button", null, p.name);
      b.type = "button";
      b.setAttribute("aria-pressed", String(p.id === currentProject().id));
      b.addEventListener("click", function () {
        model.projectId = p.id;
        try { history.replaceState(null, "", "#" + p.id); } catch (e) { /* the page still switches */ }
        model.signature = "";
        refresh(true);
      });
      box.appendChild(b);
    });
    box.hidden = false;
  }

  var parts = null; // the holders on screen: { tiles, phases, costs }

  // Draws the page. The plan (timeline, sittings) is drawn once per project; the parts that follow the board (tiles, phases, the
  // costs register link) are redrawn only when the board's own data changed, so a poll does not collapse what you opened.
  function refresh(force) {
    var root = $("pj-root"), upd = $("pj-updated");
    if (model.state === "loading") return;
    function stop(text, linkText, href) { $("pj-switch").hidden = true; upd.textContent = ""; message(text, linkText, href); parts = null; }
    if (model.state === "guest") return stop("The projects are private. Log in to see them.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null);
    if (model.state === "noboard") return stop("You don’t have a board yet, so there are no projects.", "Create your board", "ops.html");
    if (model.state === "forbidden") return stop("Your account can’t view the board.");
    if (model.state === "error") return stop("Couldn’t reach the board just now. It will try again shortly.");

    var p = currentProject();
    if (!p) return stop("The plan could not be loaded. It will try again shortly.");
    var problems = L.checkProject(p);
    renderSwitch();
    if (problems.length) return stop("The plan data for " + p.name + " is not valid (" + problems.slice(0, 3).join(", ") + "). Fix projects-plan.js in the Worker.");
    $("pj-switch").hidden = false;

    var d = new Date(model.fetchedAt);
    function two(n) { return (n < 10 ? "0" : "") + n; }
    upd.textContent = "Updated " + two(d.getHours()) + ":" + two(d.getMinutes());

    var built = L.buildModel(L.mergeItems(model.open, model.done), p);
    var now = today();
    var sig = p.id + "|" + now + "|" + model.doneOk + "|" + JSON.stringify([built.master, built.phases.map(function (x) { return x.item; })]);
    var first = !parts || !root.contains(parts.phases) || force === true;
    if (!first && sig === model.signature) return;
    model.signature = sig;

    if (first) {
      clear(root);
      parts = { tiles: h("div"), phases: h("div"), costs: h("div") };
      var summary = section("pj-h-summary", "Summary", p.name);
      summary.appendChild(h("p", "dim pj-note", p.estimateNote || ""));
      add(summary, parts.tiles, milestonesBlock(p), scenarioSummary(p));
      add(root, summary, parts.phases, timelineSection(p), sittingsSection(p), parts.costs);
    }
    clear(parts.tiles); parts.tiles.appendChild(liveTiles(p, built, now));
    clear(parts.phases); parts.phases.appendChild(phasesSection(p, built, now));
    clear(parts.costs); parts.costs.appendChild(costsSection(p, built));
  }

  // ---- 4. boot ---------------------------------------------------------------

  function pickFromHash() {
    var id = String(location.hash || "").replace(/^#/, "");
    for (var i = 0; i < DATA.projects.length; i++) if (DATA.projects[i].id === id) { model.projectId = id; return; }
    if (!model.projectId && DATA.projects.length) model.projectId = DATA.projects[0].id;
  }

  function boot() {
    pickFromHash();
    window.addEventListener("hashchange", function () { var was = model.projectId; pickFromHash(); if (model.projectId !== was) { model.signature = ""; refresh(true); } });
    var refreshBtn = $("pj-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { load(); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; refresh(); return; }
      load();
      setInterval(function () { if (!document.hidden && model.state === "ok") load(); }, POLL_MS);
      document.addEventListener("visibilitychange", function () { if (!document.hidden && model.state === "ok" && Date.now() - model.fetchedAt > 15000) load(); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
