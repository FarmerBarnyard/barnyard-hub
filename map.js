// The Dependency map page (map.html): what depends on what, what breaks if one thing goes down, and which links are weakest.
// The owner's page, opened from the Assets tile or the Overview's Weakest links tile.
//
// Reads and writes the registry on the Worker (ClaudeRepo's cloudflare-worker/src/registry-routes.js, owner only):
//   GET   /reg/map              every asset as a box (its row, what it needs, live up/down) and the links between them
//   GET   /reg/links/starting   what "Starting links" would add (changes nothing)
//   POST  /reg/links/seed       add them (needs a recent sign-in)
//   PATCH /reg/assets/<id>      { dependsOn: [ids] } to change what one asset needs (needs a recent sign-in)
// The rules (blast radius, layout, which links would make a loop) are in map-logic.js, which test/map.test.js covers.
//
// Everything from the server reaches the page through textContent or SVG attributes, never innerHTML; the page's CSP has no
// 'unsafe-inline' for scripts or styles, so all styling is in map.css. Nothing is kept in this browser.

(function () {
  "use strict";

  var M = window.BarnyardMapLogic;
  var API = "https://api.barnyard.site";
  var POLL_MS = 60000;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MIN_K = 0.2, MAX_K = 2.5;

  // ---- data -----------------------------------------------------------------------------------------------------

  var model = {
    state: "loading", map: null, selected: null, sim: false, hidden: {}, q: "", flash: null, busy: false,
    view: { x: 0, y: 0, k: 1 }, fit: true, mode: "detail", draft: null, linkQ: "", plan: null, stamp: 0
  };

  function getJson(url, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    var opts = { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    for (var k in init) opts[k] = init[k];
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }
  function send(method, path, body) {
    var init = { method: method };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return getJson(API + path, init);
  }

  function load() {
    return send("GET", "/reg/map").then(function (r) {
      if (r.status === 401) { model.state = "guest"; return; }
      if (r.status === 403) { model.state = "forbidden"; return; }
      if (r.status !== 200 || !r.body || !r.body.ok) { model.state = model.map ? "ok" : "error"; return; }
      model.map = r.body;
      model.stamp = Date.now();
      if (model.selected && !nodeById(model.selected)) { model.selected = null; model.sim = false; model.mode = "detail"; }
      model.state = "ok";
    }).then(render);
  }

  function nodeById(id) {
    var nodes = model.map ? model.map.nodes : [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
    return null;
  }

  // ---- small DOM helpers ----------------------------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function s(tag, attrs, cls) {
    var e = document.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute("class", cls);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }
  function loginHref() { return typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null; }

  function message(text, linkText, href) {
    var box = $("mp-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function flash(text, tone, signIn) {
    model.flash = text ? { text: text, tone: tone || "", signIn: !!signIn } : null;
    drawFlash();
  }
  function drawFlash() {
    var box = $("mp-flash");
    if (!box) return;
    clear(box);
    if (!model.flash) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "mp-flash " + model.flash.tone;
    box.appendChild(h("span", null, model.flash.text));
    if (model.flash.signIn && loginHref()) { var a = h("a", "btn btn-sm", "Sign in again"); a.href = loginHref(); box.appendChild(a); }
  }
  function failed(r) { flash(M.errorText(r.body, r.status), "alert", r.body && r.body.error === "recent_sign_in_required"); }

  // ---- the page -------------------------------------------------------------------------------------------------

  function render() {
    var root = $("mp-root");
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see the dependency map.", "Log in", loginHref()); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error" || !model.map) { message("Couldn’t reach the Worker just now. It will try again shortly."); return; }
    var map = model.map;
    clear(root);
    $("mp-stamp").textContent = "Updated " + new Date(model.stamp).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });

    var b = M.banner(map);
    var strip = h("div", "mp-strip " + b.tone);
    var st = map.stats || {};
    strip.appendChild(h("b", null, b.text));
    strip.appendChild(h("span", "dim", st.assets + " on the map, " + st.links + (st.links === 1 ? " link" : " links") + (st.unlinked ? ", " + st.unlinked + " with no links yet" : "")));
    root.appendChild(strip);
    var fl = h("div", "mp-flash"); fl.id = "mp-flash"; fl.hidden = true; root.appendChild(fl);
    drawFlash();

    if (!map.nodes.length) {
      var empty = h("div", "mp-empty");
      empty.appendChild(h("p", null, "The register is empty, so there is nothing to map yet."));
      empty.appendChild(h("p", "dim", "Add your servers, accounts and sites in the Assets tile on the Overview, then come back to link them."));
      root.appendChild(empty);
      return;
    }
    if (!st.links) {
      var tip = h("div", "mp-empty");
      tip.appendChild(h("p", null, "Nothing is linked yet."));
      tip.appendChild(h("p", "dim", "Press “Starting links…” to see the links the register, the monitor list and the infrastructure notes already imply. You read them first and correct any that are wrong."));
      root.appendChild(tip);
    }
    if (map.cycles && map.cycles.length) {
      root.appendChild(h("div", "mp-flash alert", "Some links form a loop (" + map.cycles.length + " assets). Open one and change what it needs to break the loop."));
    }

    root.appendChild(filterBar());
    var grid = h("div", "mp-grid");
    grid.appendChild(stage());
    grid.appendChild(panel());
    root.appendChild(grid);
    root.appendChild(listsSection());
    if (model.fit) { fitView(); model.fit = false; }
    applyView();
    // A link from the Overview tile (map.html#as_...) opens with that box selected, once.
    if (!model.hashDone) {
      model.hashDone = true;
      var m = /^#(as_[a-z0-9]{10})$/.exec(location.hash || "");
      if (m && nodeById(m[1])) select(m[1]);
    }
  }

  function filterBar() {
    var bar = h("div", "mp-filters");
    M.kindCounts(model.map.nodes).forEach(function (k) {
      var on = !model.hidden[k.kind];
      var btn = h("button", "mp-kind" + (on ? " on" : ""), k.label + " " + k.count);
      btn.type = "button";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.addEventListener("click", function () {
        model.hidden[k.kind] = on;
        if (model.selected && model.hidden[(nodeById(model.selected) || {}).kind]) model.selected = null;
        model.fit = true; render();
      });
      bar.appendChild(btn);
    });
    var q = h("input"); q.type = "search"; q.placeholder = "Find a box"; q.value = model.q; q.maxLength = 60; q.setAttribute("aria-label", "Find a box on the map");
    q.addEventListener("input", function () { model.q = q.value; drawNodes(); });
    bar.appendChild(q);
    var zoom = h("div", "mp-zoom");
    [["−", "Zoom out", function () { zoomBy(1 / 1.25); }], ["+", "Zoom in", function () { zoomBy(1.25); }], ["Fit", "Fit the whole map", function () { fitView(); applyView(); }]].forEach(function (z) {
      var bt = h("button", "btn btn-sm btn-quiet", z[0]); bt.type = "button"; bt.title = z[1]; bt.setAttribute("aria-label", z[1]); bt.addEventListener("click", z[2]); zoom.appendChild(bt);
    });
    bar.appendChild(zoom);
    return bar;
  }

  // ---- the diagram ----------------------------------------------------------------------------------------------

  var ui = { svg: null, world: null, nodes: {}, edges: [], layout: null, drag: null };

  function stage() {
    var vis = M.visible(model.map, { hidden: model.hidden });
    var L = M.layout(vis.nodes, vis.edges);
    ui.layout = L;
    var box = h("div", "mp-stage");
    box.tabIndex = 0;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Dependency diagram. Arrow of each line points at what the box above needs. Press plus or minus to zoom, zero to fit.");
    var svg = s("svg", { "class": "mp-svg", width: "100%", height: "100%" });
    var defs = s("defs", {});
    var marker = s("marker", { id: "mp-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.appendChild(s("path", { d: "M0 0 L10 5 L0 10 z" }, "mp-arrowhead"));
    defs.appendChild(marker);
    svg.appendChild(defs);
    svg.appendChild(s("rect", { x: "-100000", y: "-100000", width: "200000", height: "200000" }, "mp-bg"));
    var world = s("g", {});
    svg.appendChild(world);
    ui.svg = svg; ui.world = world; ui.nodes = {}; ui.edges = [];

    vis.edges.forEach(function (e) {
      var p = s("path", { d: M.edgePath(L.pos[e.from], L.pos[e.to]), "marker-end": "url(#mp-arrow)" }, "mp-edge");
      world.appendChild(p);
      ui.edges.push({ el: p, from: e.from, to: e.to });
    });
    vis.nodes.forEach(function (n) {
      var pos = L.pos[n.id];
      var g = s("g", { transform: "translate(" + pos.x + " " + pos.y + ")", tabindex: "0", role: "button" }, "mp-node");
      g.appendChild(s("rect", { width: M.NODE_W, height: M.NODE_H, rx: "9" }, "mp-box"));
      var t1 = s("text", { x: "28", y: "21" }, "mp-name"); t1.textContent = M.fitName(n.name); g.appendChild(t1);
      var t2 = s("text", { x: "28", y: "38" }, "mp-kindline");
      t2.textContent = M.kindOne(n.kind) + (n.dependentsCount ? " · " + n.dependentsCount + " depend on it" : "");
      g.appendChild(t2);
      g.appendChild(s("circle", { cx: "14", cy: "18", r: "5" }, "mp-dot"));
      var title = s("title", {}); title.textContent = n.name; g.appendChild(title);
      g.addEventListener("click", function (ev) { ev.stopPropagation(); select(n.id); });
      g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(n.id); } });
      world.appendChild(g);
      ui.nodes[n.id] = g;
    });
    box.appendChild(svg);
    wirePanZoom(box, svg);
    drawNodes();
    return box;
  }

  // Classes on the boxes and links: the selection, what it needs, what breaks with it, a search match, the live state.
  function drawNodes() {
    if (!ui.svg) return;
    var map = model.map;
    var rad = model.selected ? M.radius(map.nodes, model.selected) : null;
    var aff = {}, need = {};
    if (rad) { rad.affected.forEach(function (x) { aff[x.id] = true; }); rad.needs.forEach(function (x) { need[x.id] = true; }); }
    map.nodes.forEach(function (n) {
      var g = ui.nodes[n.id];
      if (!g) return;
      var tone = M.stateModel(n).tone;
      var cls = "mp-node tone-" + tone;
      if (rad) {
        if (n.id === model.selected) cls += model.sim ? " sel simdown" : " sel";
        else if (aff[n.id]) cls += model.sim ? " hit" : " aff";
        else if (need[n.id]) cls += " need";
        else cls += " faded";
      }
      if (M.matches(n, model.q)) cls += " match";
      g.setAttribute("class", cls);
      var sm = M.stateModel(n);
      g.setAttribute("aria-label", n.name + ", " + M.kindOne(n.kind) + ", " + sm.label + (n.dependentsCount ? ", " + n.dependentsCount + " depend on it" : ""));
      g.setAttribute("aria-pressed", n.id === model.selected ? "true" : "false");
    });
    ui.edges.forEach(function (e) {
      var cls = "mp-edge";
      if (rad) {
        var s0 = model.selected;
        var inHit = function (id) { return id === s0 || aff[id]; }, inNeed = function (id) { return id === s0 || need[id]; };
        if (inHit(e.from) && inHit(e.to)) cls += model.sim ? " hit" : " aff";
        else if (inNeed(e.from) && inNeed(e.to)) cls += " need";
        else cls += " faded";
      }
      e.el.setAttribute("class", cls);
    });
  }

  function wirePanZoom(box, svg) {
    svg.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX, ev.clientY);
    }, { passive: false });
    svg.addEventListener("pointerdown", function (ev) {
      if (ev.target.closest && ev.target.closest(".mp-node")) return;
      ui.drag = { x: ev.clientX, y: ev.clientY, vx: model.view.x, vy: model.view.y, moved: false };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* not every browser lets us */ }
    });
    svg.addEventListener("pointermove", function (ev) {
      var d = ui.drag;
      if (!d) return;
      var dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      model.view.x = d.vx + dx; model.view.y = d.vy + dy;
      applyView();
    });
    function end() {
      var d = ui.drag;
      ui.drag = null;
      if (d && !d.moved && model.selected) select(null);
    }
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", function () { ui.drag = null; });
    box.addEventListener("keydown", function (ev) {
      if (ev.target !== box) return;
      if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomBy(1.25); }
      else if (ev.key === "-") { ev.preventDefault(); zoomBy(1 / 1.25); }
      else if (ev.key === "0") { ev.preventDefault(); fitView(); applyView(); }
    });
  }

  function applyView() {
    if (ui.world) ui.world.setAttribute("transform", "translate(" + model.view.x + " " + model.view.y + ") scale(" + model.view.k + ")");
  }
  function stageSize() {
    var r = ui.svg ? ui.svg.getBoundingClientRect() : { width: 800, height: 520 };
    return { w: r.width || 800, h: r.height || 520 };
  }
  function fitView() {
    var L = ui.layout, sz = stageSize();
    if (!L || !L.width) { model.view = { x: 0, y: 0, k: 1 }; return; }
    var k = Math.max(MIN_K, Math.min(1.2, sz.w / L.width, sz.h / L.height));
    model.view = { k: k, x: (sz.w - L.width * k) / 2, y: (sz.h - L.height * k) / 2 };
  }
  function zoomAt(factor, clientX, clientY) {
    var r = ui.svg.getBoundingClientRect();
    var px = clientX - r.left, py = clientY - r.top, v = model.view;
    var nk = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
    model.view = { k: nk, x: px - (px - v.x) * (nk / v.k), y: py - (py - v.y) * (nk / v.k) };
    applyView();
  }
  function zoomBy(factor) {
    var r = ui.svg.getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  function select(id) {
    model.selected = id;
    model.sim = false;
    model.mode = "detail";
    model.draft = null;
    drawNodes();
    var p = $("mp-panel");
    if (p) fillPanel(p);
  }

  // ---- the side panel -------------------------------------------------------------------------------------------

  function panel() {
    var p = h("aside", "mp-panel");
    p.id = "mp-panel";
    p.setAttribute("aria-label", "Details of the selected box");
    fillPanel(p);
    return p;
  }

  function fillPanel(p) {
    clear(p);
    if (model.mode === "starting") { startingPanel(p); return; }
    var n = model.selected ? nodeById(model.selected) : null;
    if (!n) { overviewPanel(p); return; }
    if (model.mode === "edit") { editPanel(p, n); return; }
    detailPanel(p, n);
  }

  function overviewPanel(p) {
    p.appendChild(h("h2", null, "Pick a box"));
    p.appendChild(h("p", "dim", "Click any box to see everything that breaks if it goes down and everything it needs. Drag the background to move around, scroll to zoom."));
    var down = M.downReport(model.map.nodes);
    if (down.length) {
      p.appendChild(h("h3", "mp-sub", "Down right now"));
      var ul = h("ul", "mp-list");
      down.forEach(function (d) {
        var li = h("li");
        var b = h("button", "mp-link", d.name); b.type = "button"; b.addEventListener("click", function () { select(d.id); });
        li.appendChild(b);
        li.appendChild(h("span", "dim", d.text));
        ul.appendChild(li);
      });
      p.appendChild(ul);
    }
    p.appendChild(h("h3", "mp-sub", "Reading the map"));
    var key = h("ul", "mp-key");
    [["ok", "Up"], ["alert", "Down"], ["attn", "Affected: needs something that is down"], ["dim", "Not monitored or unknown"]].forEach(function (k) {
      var li = h("li"); li.appendChild(h("span", "mp-swatch " + k[0])); li.appendChild(h("span", null, k[1])); key.appendChild(li);
    });
    p.appendChild(key);
    p.appendChild(h("p", "dim", "A line runs from a box to what it needs; the arrow points at the thing it needs."));
  }

  function row(label, value) {
    var r = h("div", "mp-row");
    r.appendChild(h("span", "dim", label));
    r.appendChild(h("span", null, value));
    return r;
  }

  function nameList(list, simmed) {
    var ul = h("ul", "mp-list");
    list.forEach(function (x) {
      var li = h("li");
      var b = h("button", "mp-link", x.name); b.type = "button"; b.addEventListener("click", function () { select(x.id); });
      li.appendChild(b);
      li.appendChild(h("span", "dim", M.kindOne(x.kind) + (x.criticality ? ", " + x.criticality : "") + (x.depth > 1 ? ", " + (x.depth - 1) + " step" + (x.depth - 1 === 1 ? "" : "s") + " away" : "")));
      if (x.state === "down") li.appendChild(chip("Down", "alert"));
      ul.appendChild(li);
    });
    return ul;
  }

  function detailPanel(p, n) {
    var rad = M.radius(model.map.nodes, n.id);
    var sm = M.stateModel(n);
    var head = h("div", "mp-phead");
    head.appendChild(h("h2", null, n.name));
    head.appendChild(chip(sm.label, sm.tone === "dim" ? "" : sm.tone));
    p.appendChild(head);
    var meta = h("div", "mp-chips");
    meta.appendChild(chip(M.kindOne(n.kind), "info"));
    if (n.criticality) meta.appendChild(chip(n.criticality, n.criticality === "critical" ? "alert" : ""));
    (n.gaps || []).forEach(function (g) { meta.appendChild(chip(M.gapsText([g]), "attn")); });
    p.appendChild(meta);
    if (n.affectedBy && n.affectedBy.length) {
      var names = n.affectedBy.map(function (id) { var x = nodeById(id); return x ? x.name : "something"; });
      p.appendChild(h("div", "mp-flash attn", "Affected: it needs " + names.join(", ") + ", which " + (names.length === 1 ? "is" : "are") + " down."));
    }
    if (n.runs) p.appendChild(h("p", "mp-runs", n.runs));
    if (n.owner) p.appendChild(row("Looked after by", n.owner));
    if (n.location) p.appendChild(row("Where", n.location));
    if (n.runbook) p.appendChild(row("Runbook", n.runbook));
    if (n.link && /^https:\/\//.test(n.link)) {
      var a = h("a", "btn btn-sm", "Open its admin page"); a.href = n.link; a.target = "_blank"; a.rel = "noopener noreferrer"; p.appendChild(a);
    }

    p.appendChild(h("h3", "mp-sub", "If it goes down"));
    p.appendChild(h("p", "mp-says", M.whatBreaksText(n.name, rad.affected)));
    var tools = h("div", "mp-tools-row");
    var sim = h("button", "btn btn-sm" + (model.sim ? " btn-primary" : ""), model.sim ? "Stop pretending" : "Show it on the map");
    sim.type = "button";
    sim.addEventListener("click", function () { model.sim = !model.sim; drawNodes(); fillPanel(p); });
    tools.appendChild(sim);
    var copy = h("button", "btn btn-sm btn-quiet", "Copy as text"); copy.type = "button";
    copy.addEventListener("click", function () {
      var text = M.incidentText(rad);
      var done = function () { flash("Copied. Paste it into an incident note.", "ok"); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { flash("Could not copy from here. Select the list and copy it.", "attn"); });
      else flash("Could not copy from here. Select the list and copy it.", "attn");
    });
    tools.appendChild(copy);
    p.appendChild(tools);
    if (rad.affected.length) {
      p.appendChild(h("p", "dim", rad.counts.total + (rad.counts.total === 1 ? " thing" : " things") + " affected, " + rad.counts.direct + " directly" + (rad.counts.important ? ", " + rad.counts.important + " critical or high" : "") + "."));
      p.appendChild(nameList(rad.affected));
    }

    p.appendChild(h("h3", "mp-sub", "What it needs"));
    if (!rad.needs.length) p.appendChild(h("p", "dim", "No links yet. If it relies on something, add that below."));
    else p.appendChild(nameList(rad.needs));
    var edit = h("button", "btn btn-sm", "Change what it needs"); edit.type = "button";
    edit.addEventListener("click", function () { model.mode = "edit"; model.draft = (n.dependsOn || []).slice(); model.linkQ = ""; fillPanel(p); });
    p.appendChild(edit);
  }

  function editPanel(p, n) {
    p.appendChild(h("h2", null, "What does " + n.name + " need?"));
    p.appendChild(h("p", "dim", "Tick the things it relies on. Anything that already needs it is greyed out, because the two would wait on each other."));
    var q = h("input"); q.type = "search"; q.placeholder = "Find something"; q.value = model.linkQ; q.maxLength = 60; q.setAttribute("aria-label", "Find something to link");
    p.appendChild(q);
    var box = h("div", "mp-choices");
    p.appendChild(box);
    var choices = M.linkChoices(model.map.nodes, n.id);
    function draw() {
      clear(box);
      var term = model.linkQ.trim().toLowerCase();
      var lastKind = "";
      choices.forEach(function (c) {
        if (term && c.name.toLowerCase().indexOf(term) === -1) return;
        if (c.kind !== lastKind) { box.appendChild(h("h3", "mp-sub", M.kindLabel(c.kind))); lastKind = c.kind; }
        var label = h("label", "mp-choice" + (c.blocked ? " blocked" : ""));
        var cb = h("input"); cb.type = "checkbox"; cb.checked = model.draft.indexOf(c.id) !== -1; cb.disabled = c.blocked && !cb.checked;
        cb.addEventListener("change", function () { model.draft = M.setLink(model.draft, c.id, cb.checked); saveBtn.disabled = M.sameList(model.draft, n.dependsOn || []); });
        label.appendChild(cb);
        label.appendChild(h("span", null, c.name));
        if (c.blocked) label.appendChild(h("span", "dim", c.reason));
        box.appendChild(label);
      });
      if (!box.firstChild) box.appendChild(h("p", "dim", "Nothing matches."));
    }
    q.addEventListener("input", function () { model.linkQ = q.value; draw(); });
    var foot = h("div", "mp-tools-row");
    var saveBtn = h("button", "btn btn-sm btn-primary", "Save"); saveBtn.type = "button"; saveBtn.disabled = true;
    var cancel = h("button", "btn btn-sm", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", function () { model.mode = "detail"; model.draft = null; fillPanel(p); });
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      send("PATCH", "/reg/assets/" + n.id, { dependsOn: model.draft }).then(function (r) {
        if (r.status === 200) { model.mode = "detail"; model.draft = null; flash("Saved the links for " + n.name + ".", "ok"); model.fit = false; return load(); }
        saveBtn.disabled = false;
        failed(r);
      });
    });
    foot.appendChild(saveBtn); foot.appendChild(cancel);
    p.appendChild(foot);
    draw();
    saveBtn.disabled = M.sameList(model.draft, n.dependsOn || []);
  }

  // ---- the starting links ---------------------------------------------------------------------------------------

  function openStarting() {
    model.mode = "starting"; model.plan = null; model.selected = null; model.sim = false;
    drawNodes();
    var p = $("mp-panel");
    if (p) { fillPanel(p); p.scrollIntoView && p.scrollIntoView({ block: "nearest" }); }
    send("GET", "/reg/links/starting").then(function (r) {
      if (r.status !== 200) { failed(r); model.mode = "detail"; if (p) fillPanel(p); return; }
      model.plan = r.body;
      if (model.mode === "starting" && p) fillPanel(p);
    });
  }

  function startingPanel(p) {
    p.appendChild(h("h2", null, "Starting links"));
    p.appendChild(h("p", "dim", "These come from what the register's own entries, the monitor list and the infrastructure notes already say. Read them, then add them; you can correct any link afterwards."));
    var plan = model.plan;
    if (!plan) { p.appendChild(h("p", "dim", "Working out what it would add…")); return; }
    p.appendChild(h("p", "mp-says", M.planText(plan)));
    var act = h("div", "mp-tools-row");
    var add = h("button", "btn btn-sm btn-primary", "Add them"); add.type = "button";
    add.disabled = !plan.counts["new"] && !(plan.ensure || []).length;
    var close = h("button", "btn btn-sm", "Close"); close.type = "button";
    close.addEventListener("click", function () { model.mode = "detail"; model.plan = null; fillPanel(p); });
    add.addEventListener("click", function () {
      add.disabled = true;
      send("POST", "/reg/links/seed").then(function (r) {
        if (r.status === 200 && r.body.ok) {
          model.mode = "detail"; model.plan = null; model.fit = true;
          flash("Added " + r.body.added + (r.body.added === 1 ? " link" : " links") + (r.body.assetsAdded ? " and " + r.body.assetsAdded + (r.body.assetsAdded === 1 ? " entry" : " entries") : "") + ". Check them against how things really connect.", "ok");
          return load();
        }
        add.disabled = false;
        failed(r);
      });
    });
    act.appendChild(add); act.appendChild(close);
    p.appendChild(act);
    ["new", "there", "missing", "cycle"].forEach(function (state) {
      var rows = plan.links.filter(function (l) { return l.state === state; });
      if (!rows.length) return;
      p.appendChild(h("h3", "mp-sub", M.stateWord(state) + " (" + rows.length + ")"));
      var ul = h("ul", "mp-plan");
      rows.forEach(function (l) {
        var li = h("li");
        li.appendChild(h("b", null, l.from));
        li.appendChild(h("span", "dim", " needs "));
        li.appendChild(h("b", null, l.to));
        li.appendChild(h("span", "dim mp-why", l.why));
        ul.appendChild(li);
      });
      p.appendChild(ul);
    });
    if (plan.ensure && plan.ensure.length) {
      p.appendChild(h("h3", "mp-sub", "Entries it would add"));
      var el = h("ul", "mp-plan");
      plan.ensure.forEach(function (e) { var li = h("li"); li.appendChild(h("b", null, e.name)); li.appendChild(h("span", "dim mp-why", e.runs)); el.appendChild(li); });
      p.appendChild(el);
    }
  }

  // ---- lists under the map --------------------------------------------------------------------------------------

  function listsSection() {
    var wrap = h("div", "mp-lists");
    var a = h("section", "mp-card");
    a.appendChild(h("h2", null, "If one of these goes down"));
    a.appendChild(h("p", "dim", "The things most others lean on. Pick one to see exactly what breaks."));
    var big = M.biggestRadius(model.map.nodes, 10);
    if (!big.length) a.appendChild(h("p", "dim", "Nothing depends on anything yet."));
    else {
      var ul = h("ul", "mp-list");
      big.forEach(function (r) {
        var li = h("li");
        var b = h("button", "mp-link", r.name); b.type = "button"; b.addEventListener("click", function () { select(r.id); var p = $("mp-panel"); if (p && p.scrollIntoView) p.scrollIntoView({ block: "nearest" }); });
        li.appendChild(b);
        li.appendChild(h("span", "dim", r.total + (r.total === 1 ? " thing breaks" : " things break") + " (" + r.direct + " directly)"));
        if (r.state === "down") li.appendChild(chip("Down", "alert"));
        ul.appendChild(li);
      });
      a.appendChild(ul);
    }
    wrap.appendChild(a);
    var b2 = h("section", "mp-card");
    b2.appendChild(h("h2", null, "Weakest links"));
    b2.appendChild(h("p", "dim", "Things others depend on that have no monitor, no backup job that names them, or no runbook."));
    var weak = M.weakestModel({ weakest: model.map.weakest }).weakest;
    if (!weak.length) b2.appendChild(h("p", "dim", model.map.stats.links ? "No gaps found." : "Link some things first."));
    else {
      var wl = h("ul", "mp-list");
      weak.forEach(function (w) {
        var li = h("li");
        var bt = h("button", "mp-link", w.name); bt.type = "button"; bt.addEventListener("click", function () { select(w.id); var p = $("mp-panel"); if (p && p.scrollIntoView) p.scrollIntoView({ block: "nearest" }); });
        li.appendChild(bt);
        li.appendChild(h("span", "dim", w.line));
        wl.appendChild(li);
      });
      b2.appendChild(wl);
    }
    wrap.appendChild(b2);
    return wrap;
  }

  // ---- start ----------------------------------------------------------------------------------------------------

  function boot() {
    var rf = $("mp-refresh"), st = $("mp-starting");
    if (rf) rf.addEventListener("click", function () { model.fit = false; load(); });
    if (st) st.addEventListener("click", function () { if (model.state === "ok") openStarting(); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load();
      // The live state is the only thing that changes by itself, so a visible tab asks once a minute; a hidden one does not.
      setInterval(function () { if (!document.hidden && model.state === "ok" && model.mode !== "edit") load(); }, POLL_MS);
      document.addEventListener("visibilitychange", function () { if (!document.hidden && model.state === "ok" && Date.now() - model.stamp > POLL_MS) load(); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
