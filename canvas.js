// The Canvas page (canvas.html): whiteboards you pan and zoom, with notes, text, shapes, frames, arrows that stay attached, and live
// cards for Ops items, assets, incidents and to-dos. Owner only.
//
// Talks to the Worker (ClaudeRepo's cloudflare-worker/src/canvas-routes.js, owner only, the hub's origin):
//   GET  /canvas/boards  /canvas/templates  /canvas/board?id=  /canvas/versions?id=
//   POST /canvas/boards  /canvas/save  /canvas/restore  /canvas/delete
// and reads, for live cards only, routes the hub already uses: /ops/board, /reg/map, /incidents/list, /planner/all.
//
// Everything drawn is built with createElementNS and textContent (never innerHTML); the page's CSP has no 'unsafe-inline', so all
// styling is in canvas.css and positions are set through the style object. Nothing is kept in this browser except the id of the
// board last opened. The rules (geometry, undo, wording, export) are in canvas-logic.js, which test/canvas.test.js covers.
//
// Layout of this file: 1. state and Worker calls  2. drawing  3. the pointer  4. the keyboard  5. inspector and dialogs
// 6. saving  7. live cards  8. export  9. start.

(function () {
  "use strict";

  var L = window.BarnyardCanvasLogic;
  var API = "https://api.barnyard.site";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var SAVE_MS = 1500, RETRY_MS = 10000, LIVE_MS = 60000;
  var LAST_KEY = "barnyard.canvas.last";

  var S = {
    state: "loading", boards: [], limits: null, templates: [], board: null, items: [], view: { x: 0, y: 0, k: 1 },
    selected: null, tool: "select", shapeKind: "rect", snap: true, history: new L.History(), dirty: false, saving: false, refocusing: false,
    saveState: "saved", savedAt: 0, conflict: null, live: {}, drag: null, pointers: {}, pinch: null, editing: null,
    pickerKind: "ops", pickerQ: "", pickerAt: null, saveTimer: 0, rafPending: false, versions: null
  };

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function sv(tag, attrs, cls) {
    var e = document.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute("class", cls);
    for (var k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- 1. state and Worker calls --------------------------------------------------------------------------------

  function call(method, path, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    var init = { method: method, credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return fetch(API + path, init).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  function flash(text, tone) {
    var f = $("cv-flash");
    f.textContent = text || "";
    f.className = "cv-flash" + (tone ? " " + tone : "");
    f.hidden = !text;
  }

  function remember(id) { try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* storage may be off */ } }
  function recall() { try { return localStorage.getItem(LAST_KEY) || ""; } catch (e) { return ""; } }

  function boardById(id) { for (var i = 0; i < S.boards.length; i++) if (S.boards[i].id === id) return S.boards[i]; return null; }

  function loadBoards(openId) {
    return call("GET", "/canvas/boards").then(function (r) {
      if (r.status === 401) { S.state = "guest"; return render(); }
      if (r.status === 403) { S.state = "forbidden"; return render(); }
      if (r.status !== 200) { S.state = "error"; return render(); }
      if (r.body.enabled === false) { S.state = "off"; return render(); }
      S.boards = r.body.boards || [];
      S.limits = r.body.limits || null;
      S.state = "ok";
      var want = openId || recall();
      var pick = boardById(want) ? want : (S.boards[0] && S.boards[0].id);
      return call("GET", "/canvas/templates").then(function (t) {
        S.templates = (t.body && t.body.templates) || [];
        if (pick) return openBoard(pick);
        S.board = null; S.items = [];
        render();
      });
    });
  }

  function openBoard(id) {
    return call("GET", "/canvas/board?id=" + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200 || !r.body.board) { flash(L.errorText(r.body.error, r.status), "alert"); S.state = S.state === "loading" ? "error" : S.state; return render(); }
      var b = r.body.board;
      S.board = { id: b.id, title: b.title, rev: b.rev };
      S.items = (b.data && b.data.items) || [];
      S.view = (b.data && b.data.view) || { x: 0, y: 0, k: 1 };
      S.selected = null; S.dirty = false; S.conflict = null; S.saveState = "saved"; S.savedAt = b.updatedAt || 0;
      S.history.reset({ items: S.items });
      remember(b.id);
      flash("");
      render();
      var box = $("cv-svg").getBoundingClientRect();
      // a board opens fitted when it has never been moved, when the saved view shows none of it, and on a narrow screen (a phone)
      if ((S.view.x === 0 && S.view.y === 0 && S.view.k === 1) || !L.anyVisible(S.items, S.view, box.width, box.height) || box.width < 600) fit();
      loadLive();
    });
  }

  // ---- 2. drawing -------------------------------------------------------------------------------------------------

  function schedule() {
    if (S.rafPending) return;
    S.rafPending = true;
    window.requestAnimationFrame(function () { S.rafPending = false; draw(); });
  }

  function render() {
    var root = $("cv-root");
    var gate = $("cv-gate");
    var msg = null;
    if (S.state === "loading") msg = "Loading…";
    else if (S.state === "guest") msg = "Log in to use the Canvas.";
    else if (S.state === "forbidden") msg = "The Canvas is for the hub owner.";
    else if (S.state === "off") msg = "The Canvas is switched off on the Worker (CANVAS_ENABLED is 0).";
    else if (S.state === "error") msg = "Could not load the Canvas. Check your connection and try Refresh.";
    gate.textContent = msg || "";
    gate.hidden = !msg;
    root.hidden = !!msg;
    $("cv-empty").hidden = !(S.state === "ok" && !S.board);
    $("cv-work").hidden = !(S.state === "ok" && S.board);
    renderBar();
    if (S.state === "ok" && S.board) { draw(); renderInspector(); renderTools(); }
  }

  function renderBar() {
    var sel = $("cv-board");
    clear(sel);
    S.boards.forEach(function (b) {
      var o = h("option", "", L.boardSummary(b));
      o.value = b.id;
      sel.appendChild(o);
    });
    if (S.board) sel.value = S.board.id;
    var has = !!S.board;
    ["cv-rename", "cv-history", "cv-export", "cv-delete"].forEach(function (id) { $(id).disabled = !has; });
    sel.disabled = !S.boards.length;
    renderStatus();
  }

  function renderStatus() {
    var st = $("cv-status");
    st.textContent = S.board ? L.saveStatus(S.saveState, S.savedAt, Date.now()) : "";
    st.className = "cv-status " + (S.saveState === "error" || S.saveState === "conflict" ? "alert" : S.saveState === "saved" ? "ok" : "");
    var c = $("cv-conflict");
    c.hidden = !S.conflict;
  }

  function colorClass(it) { return "cv-c-" + (it.color || "default"); }

  function textLines(g, lines, x, y, size, anchor, cls) {
    var t = sv("text", { x: x, y: y, "font-size": size, "text-anchor": anchor }, cls || "cv-txt");
    lines.forEach(function (line, i) {
      var ts = sv("tspan", { x: x, dy: i ? Math.round(size * 1.25) : 0 });
      ts.textContent = line;
      t.appendChild(ts);
    });
    g.appendChild(t);
    return t;
  }

  function itemLabel(it) {
    if (it.type === "card") { var m = L.cardModel(it, S.live); return m.kind + ": " + m.title + ", " + m.status; }
    if (it.type === "arrow") return "Arrow" + (it.text ? ": " + it.text : "");
    var name = { note: "Note", text: "Text", shape: "Shape", frame: "Frame" }[it.type];
    return name + (it.text ? ": " + it.text.split("\n")[0] : "");
  }

  function drawItem(it, map) {
    var g = sv("g", { "data-id": it.id, tabindex: 0, role: "button", "aria-label": itemLabel(it) }, "cv-item cv-" + it.type + " " + colorClass(it) + (S.selected === it.id ? " sel" : ""));
    var lines, size;
    if (it.type === "arrow") {
      var p = L.arrowPoints(it, map);
      g.appendChild(sv("line", { x1: p.a.x, y1: p.a.y, x2: p.b.x, y2: p.b.y, "stroke-width": 14 }, "cv-hitline"));
      var line = sv("line", { x1: p.a.x, y1: p.a.y, x2: p.b.x, y2: p.b.y }, "cv-line" + (it.style === "dashed" ? " dashed" : ""));
      if (it.head) line.setAttribute("marker-end", "url(#cv-head)");
      g.appendChild(line);
      if (it.text) {
        var mx = (p.a.x + p.b.x) / 2, my = (p.a.y + p.b.y) / 2;
        var w = Math.max(24, it.text.length * 7 + 12);
        g.appendChild(sv("rect", { x: mx - w / 2, y: my - 17, width: w, height: 18, rx: 4 }, "cv-label-bg"));
        textLines(g, [it.text], mx, my - 4, 12, "middle", "cv-txt");
      }
      return g;
    }
    var box;
    if (it.type === "frame") {
      g.appendChild(sv("rect", { x: it.x, y: it.y, width: it.w, height: it.h, rx: 10 }, "cv-box cv-frame-box"));
      g.appendChild(sv("rect", { x: it.x, y: it.y, width: it.w, height: L.FRAME_BAR, rx: 10 }, "cv-frame-bar"));
      textLines(g, [it.text || ""], it.x + 12, it.y + 20, 14, "start", "cv-txt cv-frame-title");
      return g;
    }
    if (it.type === "text") {
      size = L.FONT[it.size] || L.FONT.m;
      g.appendChild(sv("rect", { x: it.x, y: it.y, width: it.w, height: it.h, rx: 4 }, "cv-hit"));
      lines = L.wrapText(it.text, L.charsFor(it.w, size), L.LIMITS.lines);
      textLines(g, lines, it.x + 2, it.y + size, size, "start", "cv-txt");
      return g;
    }
    if (it.type === "card") {
      var m = L.cardModel(it, S.live);
      g.setAttribute("class", g.getAttribute("class") + " tone-" + m.tone + (m.missing ? " missing" : ""));
      g.appendChild(sv("rect", { x: it.x, y: it.y, width: it.w, height: it.h, rx: 10 }, "cv-box"));
      g.appendChild(sv("circle", { cx: it.x + 16, cy: it.y + 20, r: 5 }, "cv-dot"));
      textLines(g, [m.kind.toUpperCase() + (m.status ? " · " + m.status : "")], it.x + 28, it.y + 24, 11, "start", "cv-kindline");
      textLines(g, L.wrapText(m.title, L.charsFor(it.w, 14), Math.max(1, Math.floor((it.h - 38) / 18))), it.x + 12, it.y + 46, 14, "start", "cv-txt cv-card-title");
      return g;
    }
    if (it.type === "shape" && it.shape === "ellipse") box = sv("ellipse", { cx: it.x + it.w / 2, cy: it.y + it.h / 2, rx: it.w / 2, ry: it.h / 2 }, "cv-box");
    else if (it.type === "shape" && it.shape === "diamond") box = sv("polygon", { points: (it.x + it.w / 2) + "," + it.y + " " + (it.x + it.w) + "," + (it.y + it.h / 2) + " " + (it.x + it.w / 2) + "," + (it.y + it.h) + " " + it.x + "," + (it.y + it.h / 2) }, "cv-box");
    else box = sv("rect", { x: it.x, y: it.y, width: it.w, height: it.h, rx: it.type === "note" ? 4 : it.shape === "round" ? 18 : 6 }, "cv-box");
    g.appendChild(box);
    lines = L.wrapText(it.text, L.charsFor(it.w, 14), Math.max(1, Math.floor((it.h - 12) / 18)));
    if (lines.length && (lines.length > 1 || lines[0])) {
      if (it.type === "note") textLines(g, lines, it.x + 10, it.y + 24, 14, "start", "cv-txt");
      else textLines(g, lines, it.x + it.w / 2, it.y + it.h / 2 - (lines.length - 1) * 9 + 5, 14, "middle", "cv-txt");
    }
    return g;
  }

  function drawSelection(layer, map) {
    clear(layer);
    var it = S.selected ? map[S.selected] : null;
    if (!it) return;
    if (it.type === "arrow") {
      var p = L.arrowPoints(it, map);
      [["from", p.a], ["to", p.b]].forEach(function (e) {
        layer.appendChild(sv("circle", { cx: e[1].x, cy: e[1].y, r: 7 / S.view.k, "data-end": e[0] }, "cv-handle cv-end"));
      });
      return;
    }
    layer.appendChild(sv("rect", { x: it.x - 3, y: it.y - 3, width: it.w + 6, height: it.h + 6, rx: 6 }, "cv-selbox"));
    var hs = 9 / S.view.k;
    layer.appendChild(sv("rect", { x: it.x + it.w - hs / 2, y: it.y + it.h - hs / 2, width: hs, height: hs, rx: 2, "data-handle": "se" }, "cv-handle cv-resize"));
  }

  function draw() {
    var world = $("cv-world"), sel = $("cv-sel");
    var map = L.byId(S.items);
    // the things are redrawn from scratch, so a keyboard user's focus is put back on the same thing
    var active = document.activeElement, focusId = active && active.getAttribute && world.contains(active) ? active.getAttribute("data-id") : null;
    clear(world);
    S.items.forEach(function (it) { world.appendChild(drawItem(it, map)); });
    if (focusId) {
      var again = world.querySelector('[data-id="' + focusId + '"]');
      // putting focus back must not count as picking the thing: a drag that ended on another thing has already chosen
      if (again) { S.refocusing = true; again.focus({ preventScroll: true }); S.refocusing = false; }
    }
    world.setAttribute("transform", "translate(" + S.view.x + " " + S.view.y + ") scale(" + S.view.k + ")");
    sel.setAttribute("transform", "translate(" + S.view.x + " " + S.view.y + ") scale(" + S.view.k + ")");
    drawSelection(sel, map);
    // the dotted background follows the view
    var grid = $("cv-grid");
    var step = 20 * S.view.k;
    grid.setAttribute("width", step); grid.setAttribute("height", step);
    grid.setAttribute("x", S.view.x % step); grid.setAttribute("y", S.view.y % step);
    $("cv-zoom-label").textContent = Math.round(S.view.k * 100) + "%";
    $("cv-empty-hint").hidden = S.items.length > 0;
    renderStatus();
    var u = $("cv-undo"), r = $("cv-redo");
    u.disabled = !S.history.canUndo(); r.disabled = !S.history.canRedo();
  }

  // ---- 3. the pointer ---------------------------------------------------------------------------------------------

  function stagePoint(ev) {
    var rect = $("cv-svg").getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  function worldPoint(ev) { return L.toWorld(S.view, stagePoint(ev)); }

  // Change the items. `keep` = true while a drag is still going (no undo step yet).
  function change(items, keep) {
    S.items = items;
    if (!keep) { S.history.push({ items: S.items }); markDirty(); }
    schedule();
  }

  function setView(v) { S.view = v; schedule(); }

  function fit() {
    var rect = $("cv-svg").getBoundingClientRect();
    setView(L.fitView(S.items, rect.width || 800, rect.height || 500, 56));
  }

  function select(id) {
    S.selected = id || null;
    renderInspector();
    schedule();
  }

  function onDown(ev) {
    if (S.editing) commitEdit();
    var stage = $("cv-stage");
    stage.focus({ preventScroll: true });
    S.pointers[ev.pointerId] = stagePoint(ev);
    try { $("cv-svg").setPointerCapture(ev.pointerId); } catch (e) { /* not all pointers can be captured */ }
    var ids = Object.keys(S.pointers);
    if (ids.length === 2) { S.drag = null; startPinch(); return; }
    if (ids.length > 2) return;
    if (ev.button !== undefined && ev.button > 1) return;
    var p = worldPoint(ev), sp = stagePoint(ev);
    var tol = 8 / S.view.k;
    var t = ev.target && ev.target.getAttribute ? ev.target : null;
    if (S.tool === "select" || ev.button === 1) {
      if (t && t.getAttribute("data-handle") === "se" && S.selected) {
        var it = L.byId(S.items)[S.selected];
        S.drag = { kind: "resize", id: S.selected, p0: p, w0: it.w, h0: it.h, before: S.items };
        return;
      }
      if (t && t.getAttribute("data-end") && S.selected) {
        S.drag = { kind: "end", id: S.selected, side: t.getAttribute("data-end"), before: S.items };
        return;
      }
      var hitItem = ev.button === 1 ? null : L.hit(S.items, p, tol);
      if (hitItem) {
        select(hitItem.id);
        if (hitItem.type !== "arrow") S.drag = { kind: "move", id: hitItem.id, p0: p, moved: false, before: S.items };
        else S.drag = { kind: "tap", id: hitItem.id };
        return;
      }
      select(null);
      S.drag = { kind: "pan", s0: sp, v0: S.view };
      return;
    }
    if (S.tool === "arrow") {
      var from = L.itemAt(S.items, p);
      S.drag = { kind: "arrow", from: from ? { item: from.id } : { x: Math.round(p.x), y: Math.round(p.y) }, p0: p, to: p };
      return;
    }
    S.drag = { kind: "create", tool: S.tool, p0: p, p1: p, s0: sp };
  }

  function onMove(ev) {
    if (S.pointers[ev.pointerId]) S.pointers[ev.pointerId] = stagePoint(ev);
    if (S.pinch) { doPinch(); return; }
    var d = S.drag;
    if (!d) return;
    var p = worldPoint(ev), sp = stagePoint(ev);
    if (d.kind === "pan") { setView({ x: Math.round(d.v0.x + sp.x - d.s0.x), y: Math.round(d.v0.y + sp.y - d.s0.y), k: d.v0.k }); return; }
    if (d.kind === "move") {
      var dx = L.snap(p.x - d.p0.x, S.snap), dy = L.snap(p.y - d.p0.y, S.snap);
      if (!d.moved && Math.abs(p.x - d.p0.x) < 3 && Math.abs(p.y - d.p0.y) < 3) return;
      d.moved = true;
      change(L.moveItem(d.before, d.id, dx, dy), true);
      return;
    }
    if (d.kind === "resize") {
      change(L.resizeItem(d.before, d.id, L.snap(d.w0 + p.x - d.p0.x, S.snap), L.snap(d.h0 + p.y - d.p0.y, S.snap)), true);
      return;
    }
    if (d.kind === "end") {
      var tgt = L.itemAt(d.before, p);
      var arrow = L.byId(d.before)[d.id];
      var other = d.side === "from" ? "to" : "from";
      var end = tgt && !(arrow[other] && arrow[other].item === tgt.id) ? { item: tgt.id } : { x: Math.round(p.x), y: Math.round(p.y) };
      change(L.setArrowEnd(d.before, d.id, d.side, end), true);
      return;
    }
    if (d.kind === "arrow") { d.to = p; drawPreview(d); return; }
    if (d.kind === "create") { d.p1 = p; drawPreview(d); }
  }

  function drawPreview(d) {
    var layer = $("cv-sel");
    var old = layer.querySelector(".cv-preview");
    if (old) layer.removeChild(old);
    var e;
    if (d.kind === "arrow") {
      var a = d.from.item ? L.centre(L.byId(S.items)[d.from.item]) : d.from;
      e = sv("line", { x1: a.x, y1: a.y, x2: d.to.x, y2: d.to.y }, "cv-preview cv-line");
    } else {
      var x = Math.min(d.p0.x, d.p1.x), y = Math.min(d.p0.y, d.p1.y), w = Math.abs(d.p1.x - d.p0.x), hh = Math.abs(d.p1.y - d.p0.y);
      e = sv("rect", { x: x, y: y, width: w, height: hh, rx: 6 }, "cv-preview cv-selbox");
    }
    layer.appendChild(e);
  }

  function onUp(ev) {
    var d = S.drag;
    delete S.pointers[ev.pointerId];
    if (S.pinch && Object.keys(S.pointers).length < 2) { S.pinch = null; S.drag = null; return; }
    S.drag = null;
    var layer = $("cv-sel");
    var old = layer.querySelector(".cv-preview");
    if (old) layer.removeChild(old);
    if (!d) return;
    if (d.kind === "move" || d.kind === "resize" || d.kind === "end") {
      if (d.kind === "move" && !d.moved) return;
      S.history.push({ items: S.items }); markDirty(); renderInspector();
      return;
    }
    if (d.kind === "arrow") {
      var p = worldPoint(ev);
      var to = L.itemAt(S.items, p);
      var end = to ? { item: to.id } : { x: Math.round(p.x), y: Math.round(p.y) };
      if (d.from.item && end.item === d.from.item) return;
      if (!d.from.item && !end.item && Math.abs(p.x - d.p0.x) < 8 && Math.abs(p.y - d.p0.y) < 8) return;
      var made = L.addItem(S.items, L.makeArrow(d.from, end));
      if (!made.ok) { flash(L.errorText(made.error), "alert"); return; }
      change(made.items);
      select(made.items[made.items.length - 1].id);
      setTool("select");
      return;
    }
    if (d.kind === "create") {
      var drag = Math.abs(d.p1.x - d.p0.x) > 8 && Math.abs(d.p1.y - d.p0.y) > 8;
      if (d.tool === "card") { openPicker({ x: L.snap(d.p0.x, S.snap), y: L.snap(d.p0.y, S.snap) }); return; }
      var opts = { shape: S.shapeKind };
      var centreP = { x: d.p0.x, y: d.p0.y };
      if (drag) {
        opts.w = Math.max(L.LIMITS.minSize, L.snap(Math.abs(d.p1.x - d.p0.x), S.snap));
        opts.h = Math.max(L.LIMITS.minSize, L.snap(Math.abs(d.p1.y - d.p0.y), S.snap));
        centreP = { x: Math.min(d.p0.x, d.p1.x) + opts.w / 2, y: Math.min(d.p0.y, d.p1.y) + opts.h / 2 };
      }
      centreP = { x: L.snap(centreP.x, S.snap), y: L.snap(centreP.y, S.snap) };
      addAt(d.tool, centreP, opts);
    }
  }

  function addAt(type, p, opts) {
    var it = L.makeItem(type, p, opts || {});
    var made = L.addItem(S.items, it);
    if (!made.ok) { flash(L.errorText(made.error), "alert"); return; }
    change(made.items);
    select(it.id);
    setTool("select");
    if (type === "note" || type === "text" || type === "shape" || type === "frame") startEdit(it.id);
  }

  function onDouble(ev) {
    var p = worldPoint(ev);
    var it = L.hit(S.items, p, 8 / S.view.k);
    if (it) { select(it.id); if (it.type === "card") openCardPage(it); else startEdit(it.id); return; }
    if (S.tool === "select") addAt("note", { x: L.snap(p.x, S.snap), y: L.snap(p.y, S.snap) });
  }

  function onWheel(ev) {
    ev.preventDefault();
    var sp = stagePoint(ev);
    if (ev.ctrlKey || ev.metaKey) setView(L.zoomAt(S.view, Math.exp(-ev.deltaY * 0.0025), sp));
    else setView(L.panBy(S.view, -ev.deltaX, -ev.deltaY));
  }

  function startPinch() {
    var ids = Object.keys(S.pointers);
    var a = S.pointers[ids[0]], b = S.pointers[ids[1]];
    S.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), v0: S.view, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function doPinch() {
    var ids = Object.keys(S.pointers);
    if (ids.length < 2) return;
    var a = S.pointers[ids[0]], b = S.pointers[ids[1]];
    var d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    var zoomed = L.zoomAt(S.pinch.v0, d / S.pinch.d0, S.pinch.m0);
    setView(L.panBy(zoomed, m.x - S.pinch.m0.x, m.y - S.pinch.m0.y));
  }

  // ---- 4. the keyboard --------------------------------------------------------------------------------------------

  function isTyping(el) { return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable); }

  function onKey(ev) {
    if (isTyping(ev.target)) return;
    var mod = ev.ctrlKey || ev.metaKey, key = ev.key || "";
    if (mod && (key === "z" || key === "Z")) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
    if (mod && (key === "y" || key === "Y")) { ev.preventDefault(); redo(); return; }
    if (mod && (key === "d" || key === "D")) { ev.preventDefault(); duplicate(); return; }
    if (mod) return;
    var step = ev.shiftKey ? 50 : S.snap ? L.GRID : 1;
    if (key === "Escape") { if (S.tool !== "select") setTool("select"); else select(null); return; }
    if (key === "Delete" || key === "Backspace") { if (S.selected) { ev.preventDefault(); remove(); } return; }
    if (key === "Enter") { if (S.selected) { ev.preventDefault(); var it = L.byId(S.items)[S.selected]; if (it && it.type === "card") openCardPage(it); else startEdit(S.selected); } return; }
    if (key.indexOf("Arrow") === 0) {
      ev.preventDefault();
      var dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0, dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      var cur = S.selected ? L.byId(S.items)[S.selected] : null;
      if (cur && cur.type !== "arrow") change(L.moveItem(S.items, S.selected, dx, dy));
      else if (!cur) setView(L.panBy(S.view, -dx * 5, -dy * 5));
      return;
    }
    if (key === "+" || key === "=") { zoomStep(1.25); return; }
    if (key === "-" || key === "_") { zoomStep(0.8); return; }
    if (key === "0") { fit(); return; }
    var tools = { v: "select", n: "note", t: "text", s: "shape", f: "frame", a: "arrow", c: "card" };
    if (tools[key.toLowerCase()]) setTool(tools[key.toLowerCase()]);
  }

  function zoomStep(f) {
    var rect = $("cv-svg").getBoundingClientRect();
    setView(L.zoomAt(S.view, f, { x: rect.width / 2, y: rect.height / 2 }));
  }

  function undo() { var s = S.history.undo(); if (s) { S.items = s.items; if (S.selected && !L.byId(S.items)[S.selected]) S.selected = null; markDirty(); renderInspector(); schedule(); } }
  function redo() { var s = S.history.redo(); if (s) { S.items = s.items; if (S.selected && !L.byId(S.items)[S.selected]) S.selected = null; markDirty(); renderInspector(); schedule(); } }

  function remove() {
    if (!S.selected) return;
    var items = L.removeItem(S.items, S.selected);
    S.selected = null;
    change(items);
    renderInspector();
  }
  function duplicate() {
    if (!S.selected) return;
    var r = L.duplicateItem(S.items, S.selected);
    if (!r.ok) { flash(L.errorText(r.error), "alert"); return; }
    change(r.items);
    select(r.id);
  }

  // ---- 5. inspector and dialogs -----------------------------------------------------------------------------------

  function setTool(t) {
    S.tool = t;
    renderTools();
    $("cv-stage").classList.toggle("placing", t !== "select");
  }

  function renderTools() {
    var btns = $("cv-tools").querySelectorAll("[data-tool]");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-tool") === S.tool;
      btns[i].classList.toggle("on", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    $("cv-shape-kind").hidden = S.tool !== "shape";
    $("cv-shape-kind").value = S.shapeKind;
    $("cv-snap").setAttribute("aria-pressed", S.snap ? "true" : "false");
    $("cv-snap").classList.toggle("on", S.snap);
  }

  function field(label, node) {
    var wrap = h("label", "cv-field");
    wrap.appendChild(h("span", "cv-field-label", label));
    wrap.appendChild(node);
    return wrap;
  }
  function button(text, cls, fn) {
    var b = h("button", "btn btn-sm " + (cls || ""), text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  function swatches(it) {
    var row = h("div", "cv-swatches");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Colour");
    L.COLORS.forEach(function (c) {
      var b = h("button", "cv-swatch cv-c-" + c);
      b.type = "button";
      b.setAttribute("aria-label", L.COLOR_LABEL[c]);
      b.setAttribute("aria-pressed", (it.color || "default") === c ? "true" : "false");
      b.title = L.COLOR_LABEL[c];
      b.addEventListener("click", function () { change(L.patchItem(S.items, it.id, { color: c })); renderInspector(); });
      row.appendChild(b);
    });
    return row;
  }

  function renderInspector() {
    var box = $("cv-insp");
    clear(box);
    var it = S.selected ? L.byId(S.items)[S.selected] : null;
    if (!it) {
      box.appendChild(h("h2", "cv-insp-title", S.board ? S.board.title : "Canvas"));
      box.appendChild(h("p", "dim", S.items.length + (S.items.length === 1 ? " item" : " items") + " on this board."));
      var help = h("ul", "cv-help");
      ["Pick a tool on the left, then click the board to place it. Drag to size a note, shape or frame.",
        "Drag empty space to pan. Scroll to pan, Ctrl and scroll (or pinch) to zoom.",
        "Double-click a thing to edit its words. Enter edits the selected thing.",
        "Arrow keys move the selected thing (Shift for bigger steps), or pan when nothing is selected.",
        "Ctrl+Z undoes, Ctrl+Y redoes, Ctrl+D duplicates, Delete removes. 0 fits the whole board."].forEach(function (t) { help.appendChild(h("li", "", t)); });
      box.appendChild(help);
      return;
    }
    var nameOf = { note: "Note", text: "Text", shape: "Shape", frame: "Frame", card: "Live card", arrow: "Arrow" };
    box.appendChild(h("h2", "cv-insp-title", nameOf[it.type]));

    if (it.type === "card") {
      var m = L.cardModel(it, S.live);
      var info = h("div", "cv-cardinfo tone-" + m.tone);
      info.appendChild(h("div", "cv-cardinfo-kind", m.kind));
      info.appendChild(h("div", "cv-cardinfo-title", m.title));
      info.appendChild(h("div", "cv-cardinfo-status", m.status));
      box.appendChild(info);
      if (m.page) {
        var a = h("a", "btn btn-sm", "Open " + m.kind.toLowerCase());
        a.href = m.page + (it.ref.kind === "asset" ? "#" + it.ref.id : "");
        a.target = "_blank"; a.rel = "noopener";
        box.appendChild(a);
      }
    } else {
      var ta;
      if (it.type === "frame" || it.type === "arrow") { ta = h("input"); ta.type = "text"; ta.maxLength = L.LIMITS.label; }
      else { ta = h("textarea"); ta.rows = 4; ta.maxLength = L.LIMITS.text; }
      ta.value = it.text || "";
      ta.id = "cv-insp-text";
      ta.addEventListener("input", function () { S.items = L.patchItem(S.items, it.id, { text: ta.value }); markDirty(); schedule(); });
      ta.addEventListener("change", function () { S.history.push({ items: S.items }); renderStatus(); });
      box.appendChild(field(it.type === "frame" ? "Title" : it.type === "arrow" ? "Label" : "Words", ta));
    }

    if (it.type === "shape") {
      var sh = h("select");
      L.SHAPES.forEach(function (k) { var o = h("option", "", L.SHAPE_LABEL[k]); o.value = k; sh.appendChild(o); });
      sh.value = it.shape || "rect";
      sh.addEventListener("change", function () { change(L.patchItem(S.items, it.id, { shape: sh.value })); });
      box.appendChild(field("Shape", sh));
    }
    if (it.type === "text") {
      var sz = h("select");
      [["s", "Small"], ["m", "Medium"], ["l", "Large"]].forEach(function (k) { var o = h("option", "", k[1]); o.value = k[0]; sz.appendChild(o); });
      sz.value = it.size || "m";
      sz.addEventListener("change", function () { change(L.patchItem(S.items, it.id, { size: sz.value })); });
      box.appendChild(field("Size", sz));
    }
    if (it.type === "arrow") {
      var st = h("select");
      [["solid", "Solid"], ["dashed", "Dashed"]].forEach(function (k) { var o = h("option", "", k[1]); o.value = k[0]; st.appendChild(o); });
      st.value = it.style || "solid";
      st.addEventListener("change", function () { change(L.patchItem(S.items, it.id, { style: st.value })); });
      box.appendChild(field("Line", st));
      var hd = h("input"); hd.type = "checkbox"; hd.checked = !!it.head;
      hd.addEventListener("change", function () { change(L.patchItem(S.items, it.id, { head: hd.checked })); });
      var hl = h("label", "cv-check"); hl.appendChild(hd); hl.appendChild(h("span", "", "Arrowhead"));
      box.appendChild(hl);
      box.appendChild(h("p", "dim cv-tip", "Drag an end to move it onto something, or off it."));
    }
    box.appendChild(field("Colour", swatches(it)));

    if (it.type !== "arrow") {
      var dims = h("div", "cv-dims");
      [["w", "Width"], ["h", "Height"]].forEach(function (k) {
        var n = h("input"); n.type = "number"; n.min = L.LIMITS.minSize; n.max = L.LIMITS.maxSize; n.step = 10; n.value = it[k[0]];
        n.addEventListener("change", function () {
          var cur = L.byId(S.items)[it.id];
          var w = k[0] === "w" ? Number(n.value) : cur.w, hh = k[0] === "h" ? Number(n.value) : cur.h;
          if (isFinite(w) && isFinite(hh)) change(L.resizeItem(S.items, it.id, w, hh));
        });
        dims.appendChild(field(k[1], n));
      });
      box.appendChild(dims);
    }

    var row = h("div", "cv-actions");
    row.appendChild(button("Duplicate", "", duplicate));
    row.appendChild(button("Bring to front", "", function () { change(L.toFront(S.items, it.id)); }));
    row.appendChild(button("Send to back", "", function () { change(L.toBack(S.items, it.id)); }));
    row.appendChild(button("Delete", "btn-danger", remove));
    box.appendChild(row);
  }

  // Edit an item's words in place.
  function startEdit(id) {
    var it = L.byId(S.items)[id];
    if (!it || it.type === "card") return;
    var ta = $("cv-edit");
    var r, size;
    if (it.type === "arrow") {
      var p = L.arrowPoints(it, L.byId(S.items));
      r = { x: (p.a.x + p.b.x) / 2 - 80, y: (p.a.y + p.b.y) / 2 - 14, w: 160, h: 28 };
    } else r = { x: it.x, y: it.y + (it.type === "frame" ? 0 : 0), w: it.w, h: it.type === "frame" ? L.FRAME_BAR : it.h };
    size = it.type === "text" ? (L.FONT[it.size] || 20) : it.type === "frame" ? 14 : 14;
    var s = L.toScreen(S.view, { x: r.x, y: r.y });
    ta.style.setProperty("left", s.x + "px"); ta.style.setProperty("top", s.y + "px");
    ta.style.setProperty("width", Math.max(80, r.w * S.view.k) + "px"); ta.style.setProperty("height", Math.max(28, r.h * S.view.k) + "px");
    ta.style.setProperty("font-size", Math.max(11, size * S.view.k) + "px");
    ta.maxLength = it.type === "frame" || it.type === "arrow" ? L.LIMITS.label : L.LIMITS.text;
    ta.value = it.text || "";
    ta.hidden = false;
    S.editing = { id: id, was: it.text || "" };
    ta.focus();
    ta.select();
  }
  function commitEdit() {
    if (!S.editing) return;
    var ta = $("cv-edit"), e = S.editing;
    S.editing = null;
    ta.hidden = true;
    var it = L.byId(S.items)[e.id];
    if (it && ta.value !== e.was) { change(L.patchItem(S.items, e.id, { text: ta.value })); renderInspector(); }
    $("cv-stage").focus({ preventScroll: true });
  }
  function cancelEdit() {
    if (!S.editing) return;
    S.editing = null;
    $("cv-edit").hidden = true;
    $("cv-stage").focus({ preventScroll: true });
  }

  function openCardPage(it) {
    var m = L.cardModel(it, S.live);
    if (m.page) window.open(m.page + (it.ref.kind === "asset" ? "#" + it.ref.id : ""), "_blank", "noopener");
  }

  function dialog(id, title, build) {
    var d = $(id);
    clear(d);
    var head = h("div", "cv-dlg-head");
    head.appendChild(h("h2", "", title));
    var x = button("Close", "btn-quiet", function () { d.close(); });
    head.appendChild(x);
    d.appendChild(head);
    var body = h("div", "cv-dlg-body");
    d.appendChild(body);
    build(body, d);
    if (!d.open) d.showModal();
    return d;
  }

  function newBoardDialog() {
    dialog("cv-dlg", "New board", function (body, d) {
      var name = h("input"); name.type = "text"; name.maxLength = L.LIMITS.title; name.placeholder = "Name (optional)";
      body.appendChild(field("Name", name));
      var list = h("div", "cv-templates");
      (S.templates.length ? S.templates : [{ name: "blank", label: "Blank", about: "An empty board." }]).forEach(function (t) {
        var b = h("button", "cv-template");
        b.type = "button";
        b.appendChild(h("b", "", t.label));
        b.appendChild(h("span", "dim", t.about));
        b.addEventListener("click", function () {
          b.disabled = true;
          call("POST", "/canvas/boards", { template: t.name, title: name.value.trim() || undefined }).then(function (r) {
            if (r.status !== 201) { b.disabled = false; flash(L.errorText(r.body.error, r.status), "alert"); d.close(); return; }
            d.close();
            flushSave().then(function () { return loadBoards(r.body.board.id); });
          });
        });
        list.appendChild(b);
      });
      body.appendChild(list);
    });
  }

  function renameDialog() {
    dialog("cv-dlg", "Rename board", function (body, d) {
      var name = h("input"); name.type = "text"; name.maxLength = L.LIMITS.title; name.value = S.board.title;
      body.appendChild(field("Name", name));
      body.appendChild(button("Save name", "btn-primary", function () {
        var v = name.value.trim();
        if (!v) { flash(L.errorText("title_required"), "alert"); return; }
        S.board.title = v; markDirty(); d.close(); flushSave().then(function () { return loadBoardsKeep(); });
      }));
    });
  }

  function loadBoardsKeep() {
    return call("GET", "/canvas/boards").then(function (r) { if (r.status === 200) { S.boards = r.body.boards || []; renderBar(); } });
  }

  function deleteDialog() {
    dialog("cv-dlg", "Delete this board?", function (body, d) {
      body.appendChild(h("p", "", "“" + S.board.title + "” and its saved copies will be deleted for good."));
      body.appendChild(button("Delete the board", "btn-danger", function () {
        var id = S.board.id;
        call("POST", "/canvas/delete", { id: id }).then(function (r) {
          d.close();
          if (r.status !== 200) { flash(L.errorText(r.body.error, r.status), "alert"); return; }
          S.dirty = false; S.board = null; S.items = [];
          loadBoards();
        });
      }));
    });
  }

  function historyDialog() {
    dialog("cv-dlg", "Saved copies", function (body, d) {
      body.appendChild(h("p", "dim", "A copy is kept when a board is made, about every ten minutes while you work, and before a restore. The newest twelve stay."));
      var list = h("div", "cv-versions");
      body.appendChild(list);
      list.appendChild(h("p", "dim", "Loading…"));
      flushSave().then(function () { return call("GET", "/canvas/versions?id=" + encodeURIComponent(S.board.id)); }).then(function (r) {
        clear(list);
        if (r.status !== 200) { list.appendChild(h("p", "alert", L.errorText(r.body.error, r.status))); return; }
        (r.body.versions || []).forEach(function (v) {
          var row = h("div", "cv-version");
          row.appendChild(h("span", "", new Date(v.at).toLocaleString("en-AU", { timeZone: "Australia/Perth", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " · " + v.items + (v.items === 1 ? " item" : " items") + " · " + (v.why || "saved")));
          row.appendChild(button("Restore", "", function () {
            call("POST", "/canvas/restore", { id: S.board.id, rev: v.rev }).then(function (rr) {
              if (rr.status !== 200) { flash(L.errorText(rr.body.error, rr.status), "alert"); return; }
              d.close();
              flash("Restored. What it replaced is kept in the saved copies.", "ok");
              S.dirty = false;
              loadBoards(S.board.id);
            });
          }));
          list.appendChild(row);
        });
      });
    });
  }

  function exportDialog() {
    dialog("cv-dlg", "Export", function (body, d) {
      body.appendChild(h("p", "dim", "A picture of the whole board, or all of it as data. Live cards print the state they have now."));
      [["SVG picture", "svg"], ["PNG picture", "png"], ["JSON (every item)", "json"]].forEach(function (k) {
        body.appendChild(button(k[0], "", function () { d.close(); doExport(k[1]); }));
      });
    });
  }

  function pickerRowsFor(kind) { return L.pickerRows(kind, S.live[kind], S.pickerQ, 30); }

  function openPicker(at) {
    S.pickerAt = at || null;
    S.pickerQ = "";
    dialog("cv-dlg-picker", "Add a live card", function (body, d) {
      var tabs = h("div", "cv-tabs");
      var q = h("input"); q.type = "search"; q.placeholder = "Search"; q.setAttribute("aria-label", "Search");
      var list = h("div", "cv-picklist");
      function paint() {
        clear(tabs);
        L.CARD_KINDS.forEach(function (k) {
          var b = h("button", "cv-tab" + (S.pickerKind === k.kind ? " on" : ""), k.plural);
          b.type = "button";
          b.addEventListener("click", function () { S.pickerKind = k.kind; S.pickerQ = ""; q.value = ""; loadLive(true, [k.kind]).then(paint); paint(); });
          tabs.appendChild(b);
        });
        clear(list);
        if (S.live[S.pickerKind] === undefined) { list.appendChild(h("p", "dim", "Loading…")); return; }
        var rows = pickerRowsFor(S.pickerKind);
        if (!rows.length) list.appendChild(h("p", "dim", "Nothing found."));
        rows.forEach(function (r) {
          var b = h("button", "cv-pick tone-" + r.tone);
          b.type = "button";
          b.appendChild(h("span", "cv-pick-title", r.title));
          b.appendChild(h("span", "cv-pick-status", r.status));
          b.addEventListener("click", function () {
            d.close();
            var p = S.pickerAt || L.toWorld(S.view, { x: $("cv-svg").clientWidth / 2, y: $("cv-svg").clientHeight / 2 });
            addAt("card", { x: L.snap(p.x, S.snap), y: L.snap(p.y, S.snap) }, { ref: { kind: r.kind, id: r.id }, label: r.title });
          });
          list.appendChild(b);
        });
      }
      q.addEventListener("input", function () { S.pickerQ = q.value; paint(); });
      body.appendChild(tabs); body.appendChild(q); body.appendChild(list);
      paint();
      loadLive(true, [S.pickerKind]).then(paint);
      setTimeout(function () { q.focus(); }, 0);
    });
  }

  // ---- 6. saving --------------------------------------------------------------------------------------------------

  function markDirty() {
    if (!S.board) return;
    S.dirty = true;
    if (S.saveState !== "conflict") S.saveState = "dirty";
    renderStatus();
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, SAVE_MS);
    schedule();   // the undo and redo buttons follow the history
  }

  function save() {
    clearTimeout(S.saveTimer);
    if (!S.board || !S.dirty || S.saving || S.conflict) return Promise.resolve();
    S.saving = true;
    S.saveState = "saving";
    renderStatus();
    var sent = S.items, board = S.board;
    return call("POST", "/canvas/save", { id: board.id, baseRev: board.rev, title: board.title, data: { items: sent, view: S.view } }).then(function (r) {
      S.saving = false;
      if (r.status === 200) {
        board.rev = r.body.rev;
        S.savedAt = r.body.updatedAt || Date.now();
        if (S.items === sent) { S.dirty = false; S.saveState = "saved"; flash(""); } else { S.saveState = "dirty"; S.saveTimer = setTimeout(save, 400); }
        var meta = boardById(board.id);
        if (meta) { meta.rev = board.rev; meta.title = board.title; meta.items = sent.length; }
        renderStatus();
        return;
      }
      if (r.status === 409 && r.body.error === "conflict") { S.conflict = { rev: r.body.rev }; S.saveState = "conflict"; renderStatus(); return; }
      S.saveState = "error";
      flash(L.errorText(r.body.error, r.status), "alert");
      renderStatus();
      if (r.status === 0 || r.status >= 500) S.saveTimer = setTimeout(save, RETRY_MS);
    });
  }
  function flushSave() { clearTimeout(S.saveTimer); return S.dirty ? save() : Promise.resolve(); }

  function resolveConflict(keepMine) {
    if (!S.conflict) return;
    if (!keepMine) { var id = S.board.id; S.dirty = false; S.conflict = null; openBoard(id); return; }
    var mine = { items: S.items, view: S.view }, title = S.board.title;
    S.conflict = null; S.dirty = false;
    call("POST", "/canvas/boards", { title: (title + " (my copy)").slice(0, L.LIMITS.title) }).then(function (r) {
      if (r.status !== 201) { flash(L.errorText(r.body.error, r.status), "alert"); S.conflict = { rev: 0 }; S.dirty = true; renderStatus(); return; }
      return call("POST", "/canvas/save", { id: r.body.board.id, baseRev: 1, title: r.body.board.title, data: mine }).then(function () {
        flash("Your changes were saved as a new board.", "ok");
        loadBoards(r.body.board.id);
      });
    });
  }

  // ---- 7. live cards ----------------------------------------------------------------------------------------------

  function todayPerth() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  var LIVE = {
    ops: { path: "/ops/board", read: function (b) { return L.opsLive(b); } },
    asset: { path: "/reg/map", read: function (b) { return L.assetsLive(b); } },
    incident: { path: "/incidents/list?status=all", read: function (b) { return L.incidentsLive(b); } },
    todo: { path: "/planner/all", read: function (b) { return L.todosLive(b, todayPerth()); } }
  };

  function loadLive(force, extra) {
    var kinds = L.kindsUsed(S.items);
    (extra || []).forEach(function (k) { if (kinds.indexOf(k) === -1) kinds.push(k); });
    return Promise.all(kinds.map(function (k) {
      if (!LIVE[k]) return null;
      if (!force && S.live[k] !== undefined && Date.now() - (S.liveAt || 0) < LIVE_MS / 2) return null;
      return call("GET", LIVE[k].path).then(function (r) {
        if (r.status === 200) S.live[k] = LIVE[k].read(r.body);
        else if (r.status === 401 || r.status === 403) S.live[k] = {};
      });
    })).then(function () { S.liveAt = Date.now(); schedule(); if (S.selected) renderInspector(); });
  }

  // ---- 8. export --------------------------------------------------------------------------------------------------

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function doExport(kind) {
    if (!S.board) return;
    var data = { items: S.items, view: S.view }, title = S.board.title;
    if (kind === "json") { download(new Blob([JSON.stringify({ title: title, exportedAt: new Date().toISOString(), data: data }, null, 2)], { type: "application/json" }), L.fileName(title, "json")); return; }
    var svg = L.toSvg(data, S.live);
    if (kind === "svg") { download(new Blob([svg], { type: "image/svg+xml" }), L.fileName(title, "svg")); return; }
    var m = /width="(\d+)" height="(\d+)"/.exec(svg);
    var w = m ? parseInt(m[1], 10) : 800, hh = m ? parseInt(m[2], 10) : 600;
    var scale = Math.min(2, 8000 / Math.max(w, hh));
    var img = new Image();
    var url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = Math.round(w * scale); c.height = Math.round(hh * scale);
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function (b) { if (b) download(b, L.fileName(title, "png")); else flash("The picture could not be made. Try SVG instead.", "alert"); }, "image/png");
    };
    img.onerror = function () { URL.revokeObjectURL(url); flash("The picture could not be made. Try SVG instead.", "alert"); };
    img.src = url;
  }

  // ---- 9. start ---------------------------------------------------------------------------------------------------

  function wire() {
    var svg = $("cv-svg");
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("dblclick", onDouble);
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("focusin", function (ev) {
      var g = ev.target && ev.target.closest ? ev.target.closest("[data-id]") : null;
      if (g && !S.refocusing && g.getAttribute("data-id") !== S.selected && !S.drag) select(g.getAttribute("data-id"));
    });
    document.addEventListener("keydown", function (ev) {
      var edit = $("cv-edit");
      if (S.editing && ev.target === edit) {
        if (ev.key === "Escape") { ev.preventDefault(); cancelEdit(); }
        else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey || edit.maxLength <= L.LIMITS.label)) { ev.preventDefault(); commitEdit(); }
        return;
      }
      if (ev.target && ev.target.closest && ev.target.closest("dialog")) return;
      if (!S.board || $("cv-work").hidden) return;
      onKey(ev);
    });
    $("cv-edit").addEventListener("blur", commitEdit);
    $("cv-tools").addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-tool]") : null;
      if (!b) return;
      var t = b.getAttribute("data-tool");
      if (t === "card") { setTool("select"); openPicker(null); return; }
      setTool(t);
    });
    $("cv-shape-kind").addEventListener("change", function () { S.shapeKind = $("cv-shape-kind").value; });
    $("cv-snap").addEventListener("click", function () { S.snap = !S.snap; renderTools(); });
    $("cv-undo").addEventListener("click", undo);
    $("cv-redo").addEventListener("click", redo);
    $("cv-zoom-in").addEventListener("click", function () { zoomStep(1.25); });
    $("cv-zoom-out").addEventListener("click", function () { zoomStep(0.8); });
    $("cv-zoom-fit").addEventListener("click", fit);
    $("cv-board").addEventListener("change", function () { var id = $("cv-board").value; flushSave().then(function () { return openBoard(id); }); });
    $("cv-new").addEventListener("click", newBoardDialog);
    $("cv-empty-new").addEventListener("click", newBoardDialog);
    $("cv-rename").addEventListener("click", renameDialog);
    $("cv-history").addEventListener("click", historyDialog);
    $("cv-export").addEventListener("click", exportDialog);
    $("cv-delete").addEventListener("click", deleteDialog);
    $("cv-refresh").addEventListener("click", function () { flushSave().then(function () { return loadBoards(S.board && S.board.id); }); });
    $("cv-conflict-load").addEventListener("click", function () { resolveConflict(false); });
    $("cv-conflict-keep").addEventListener("click", function () { resolveConflict(true); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) flushSave(); else loadLive(); });
    window.addEventListener("pagehide", function () { flushSave(); });
    setInterval(function () { if (!document.hidden && S.board) loadLive(); }, LIVE_MS);
    setInterval(function () { if (S.board) renderStatus(); }, 30000);
    window.addEventListener("resize", schedule);
  }

  wire();
  renderTools();
  loadBoards();
})();
