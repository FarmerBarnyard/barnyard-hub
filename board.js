// The Overview board: puts the widgets where the viewer's layout says (board-layout.js does the arithmetic) and
// lets them rearrange it. Outside "Customise" nothing here can be dragged or clicked by accident: it only
// places the tiles. In Customise every tile gets a top bar to drag it by, handles to resize it, and an options
// menu; everything the mouse can do has a keyboard route and a spoken announcement.
//
// How it fits in:
//   overview.js builds the page and calls BarnyardBoardUI.create({box, Theme, titles, restricted, say}) once, then
//   .render() whenever the settings or the signed-in person change. This file owns the grid, the Customise bar,
//   the Tiles panel and the drag/resize/keyboard behaviour; the saved layout lives in the profile settings
//   (Theme "board" and "widgets"; see themes.js and board-layout.js).
//
// Narrow screens: at 960px and wider the 12-column layout is shown; between 560 and 960px the same layout
// halved to 6 columns; below that one column in reading order. Customise on a narrow screen edits a single
// stacked list (Move earlier or later, Taller or Shorter, Hide); the full drag and resize is for wide ones.
//
// Everything is built with DOM calls and CSS classes; placement uses the CSS object model (no inline style
// attributes, no HTML strings), so it fits the site's CSP.
//
// The pure helpers are exported for tests (node test/board.test.js).

(function (root) {
  "use strict";

  var Layout = typeof module !== "undefined" && module.exports ? require("./board-layout.js") : root.BarnyardBoard;

  var WIDE_MIN = 960;       // container width at which the full 12-column board is shown
  var MID_MIN = 560;        // and the 6-column one
  var ROW_FALLBACK = 36;    // px, the row height in board.css (--board-row)
  var SEEN_KEY = "barnyard-board-defaults";   // which saved layouts already know about the default-on tiles (this browser only)

  // ---- pure helpers -------------------------------------------------------------------------------

  function columnsFor(width) { return width >= WIDE_MIN ? 12 : width >= MID_MIN ? 6 : 1; }

  // How far one column and one row are, in pixels, from a grid `width` px wide with `cols` columns.
  function stepsFor(width, cols, colGap, rowPx, rowGap) {
    return { stepX: (width + colGap) / cols, stepY: rowPx + rowGap };
  }

  // The cell a tile's top-left corner is nearest to when it sits `left`, `top` px from the grid's corner.
  function cellAt(left, top, steps, cols, w) {
    var x = Math.round(left / steps.stepX), y = Math.round(top / steps.stepY);
    return { x: Math.max(0, Math.min(cols - w, x)), y: Math.max(0, y) };
  }

  // The size a tile gets when its corner is dragged `dx`, `dy` px from where it started.
  function sizeFrom(startW, startH, dx, dy, steps) {
    return { w: startW + Math.round(dx / steps.stepX), h: startH + Math.round(dy / steps.stepY) };
  }

  // How many rows tall a tile must be to hold `contentPx` px of content.
  function rowsFor(contentPx, rowPx, rowGap) { return Math.max(1, Math.ceil((contentPx + rowGap) / (rowPx + rowGap))); }

  // What a key means on a tile's grip. picked = the tile has been picked up with Space or Enter.
  //   {type: "pick"|"drop"|"cancel"}, {type: "move", dx, dy}, {type: "resize", dw, dh}, {type: "focus", dir: -1|1}, or null.
  function keyIntent(key, shift, picked) {
    if (key === " " || key === "Enter") return { type: picked ? "drop" : "pick" };
    if (key === "Escape") return picked ? { type: "cancel" } : null;
    var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    if (!d) return null;
    if (!picked) return { type: "focus", dir: d[0] + d[1] < 0 ? -1 : 1 };
    return shift ? { type: "resize", dw: d[0], dh: d[1] } : { type: "move", dx: d[0], dy: d[1] };
  }

  // The widgets list with the entries this person may not have put back as they were (the owner's own tiles stay
  // as saved when a guest saves a layout).
  function mergeList(next, original, restricted) {
    var byId = {};
    (original || []).forEach(function (e) { byId[e.id] = e; });
    return next.map(function (e) { return restricted(e.id) && byId[e.id] ? { id: e.id, visible: byId[e.id].visible, size: byId[e.id].size } : e; });
  }

  function sameTiles(a, b) { return JSON.stringify(Layout.toBoard(a)) === JSON.stringify(Layout.toBoard(b)); }

  // The tiles to draw for a layout: `tiles` as the layout holds them, plus the default-on tiles (`ids`, in order) put at the top
  // unless `seen` says this layout (`key`) was saved from Customise since they existed, in which case a missing one is hidden on purpose.
  function withDefaultTiles(tiles, seen, key, ids) {
    if (seen && seen[key]) return tiles;
    return ids && ids.length ? Layout.addAtTop(tiles, ids) : tiles;
  }

  var helpers = { columnsFor: columnsFor, stepsFor: stepsFor, cellAt: cellAt, sizeFrom: sizeFrom, rowsFor: rowsFor, keyIntent: keyIntent, mergeList: mergeList, sameTiles: sameTiles, withDefaultTiles: withDefaultTiles, WIDE_MIN: WIDE_MIN, MID_MIN: MID_MIN };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- the board (browser only) ------------------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function svgIcon(kind) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
    s.setAttribute("class", "i"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    if (kind === "grip") {
      [8, 16].forEach(function (cx) { [6, 12, 18].forEach(function (cy) { var c = document.createElementNS(ns, "circle"); c.setAttribute("cx", String(cx)); c.setAttribute("cy", String(cy)); c.setAttribute("r", "1.6"); s.appendChild(c); }); });
    } else {
      [6, 12, 18].forEach(function (cx) { var c = document.createElementNS(ns, "circle"); c.setAttribute("cx", String(cx)); c.setAttribute("cy", "12"); c.setAttribute("r", "1.7"); s.appendChild(c); });
    }
    return s;
  }

  function create(opts) {
    var box = opts.box, Theme = opts.Theme;
    var titles = opts.titles || {};
    var S = {
      editing: false, cols: 12, working: null, start: null, picked: null, preview: null, drag: null,
      panel: false, confirmReset: false, menu: null, focusId: null, barFocus: null,
      cls: Layout.deviceClass(root.innerWidth), layoutId: null, layouts: false, renaming: null, confirmDelete: null, layoutMsg: ""
    };
    var bar = null, live = null, panelEl = null, ghost = null, resizeTimer = null;

    function say(text) { if (opts.say) opts.say(text); }
    function title(id) { return titles[id] || (Layout.spec(id) && Layout.spec(id).title) || id; }
    function restricted(id) { return !!opts.restricted && opts.restricted(id); }
    function shown(e) { return e.visible && !restricted(e.id); }
    function allowedIds() { return Layout.CATALOGUE.filter(function (c) { return !restricted(c.id); }).map(function (c) { return c.id; }); }
    function tileEls() { return Array.prototype.slice.call(box.querySelectorAll(".w[data-w]")); }
    function tileEl(id) { return box.querySelector('.w[data-w="' + id + '"]'); }

    // ---- tiles a page registers for itself (BarnyardTiles.register, see tile-kit.js) ----
    //
    // They join the catalogue and get a tile on the board; each is drawn the first time it is shown. They are not in
    // the widgets list, so they start hidden: they appear in the Tiles panel and show once ticked and saved (the saved
    // board holds them; the list does not).

    var ext = {};

    function adoptTiles() {
      var kit = root.BarnyardTiles;
      if (!kit || typeof kit.list !== "function") return;
      kit.list().forEach(function (desc) {
        var reg = Layout.register(desc);
        if (!reg || ext[desc.id] || tileEl(desc.id)) return;
        var node = el("section", "w lift b-ext");
        node.setAttribute("data-w", desc.id);
        node.setAttribute("aria-label", reg.title);
        node.hidden = true;
        var body = el("div", "b-ext-body");
        node.appendChild(body);
        box.appendChild(node);
        ext[desc.id] = { desc: desc, node: node, body: body, inst: null, mounted: false };
      });
    }

    function mountExt(id) {
      var e = ext[id];
      if (!e || e.mounted) return;
      e.mounted = true;
      try { e.inst = e.desc.render(e.body, { board: true }) || null; }
      catch (err) { e.body.appendChild(el("p", "dim", "This tile could not be drawn.")); }
    }

    function extraIds() {
      var core = {};
      Theme.get().widgets.forEach(function (w) { core[w.id] = true; });
      return Object.keys(ext).filter(function (id) { return !core[id] && !restricted(id); });
    }

    function announce(text) {
      if (!live) return;
      live.textContent = "";
      root.setTimeout(function () { live.textContent = text; }, 30);
    }

    // ---- what to show ----

    // This kind of screen uses the standard arrangement, or a named layout the person saved for it (board-layout.js).
    function current() { return Layout.settingsFor(Theme.get(), S.cls); }
    function saved() { var r = current(); return withDefaults(Layout.effective(r.board, r.widgets, shown, extraIds()), seenKey(r.layout)); }

    // ---- tiles that used to be fixed blocks on the page (Quick capture, Running out soon) ----
    //
    // They are registered "defaultOn": part of the default arrangement, and put at the top, in their old places, for a layout that
    // was saved before they were tiles. Which saved layouts already know about them is kept in this browser (key
    // SEEN_KEY: "std" for the standard arrangement, "l:<id>" for a named layout), set when a layout is saved from Customise.
    // Until then a layout that does not hold them is shown with them at the top, and nothing else moves (the saved layout
    // itself is untouched). Once saved, a tile that is not in the layout is hidden on purpose and stays hidden. The rule for a
    // second browser is the same: it shows them once at the top until its own first save.

    function seenKey(layout) { return layout ? "l:" + layout.id : "std"; }
    function seenMap() {
      try { var v = JSON.parse(root.localStorage.getItem(SEEN_KEY) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
    }
    function markSeen(key) { try { var m = seenMap(); m[key] = 1; root.localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) { /* storage blocked: they show at the top again next time */ } }
    function clearSeen(key) { try { var m = seenMap(); delete m[key]; root.localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) { /* as above */ } }
    function defaultOnIds() { return Layout.defaultIds().filter(function (id) { return ext[id] && !restricted(id); }); }
    function withDefaults(tiles, key) { return withDefaultTiles(tiles, seenMap(), key, defaultOnIds()); }
    function listMode() { return S.cols < 12; }
    function editCols() { return S.cols >= 12 ? 12 : 1; }

    function place(node, t) {
      node.style.setProperty("grid-column", (t.x + 1) + " / span " + t.w);
      node.style.setProperty("grid-row", (t.y + 1) + " / span " + t.h);
    }

    function render(keepBar) {
      if (S.drag) return;
      adoptTiles();
      var base = S.editing ? (S.preview || S.working) : saved();
      var cols = S.editing ? editCols() : S.cols;
      var tiles = cols === 12 ? base : Layout.toColumns(base, cols);
      var byId = {};
      tiles.forEach(function (t) { byId[t.id] = t; });
      box.classList.add("is-board");
      box.classList.toggle("is-editing", S.editing);
      box.classList.toggle("is-list", S.editing && listMode());
      box.setAttribute("data-cols", String(cols));
      box.style.setProperty("--board-cols", String(cols));
      var any = false;
      tileEls().forEach(function (node) {
        var id = node.getAttribute("data-w"), t = byId[id];
        if (!t) { node.hidden = true; node.style.removeProperty("grid-column"); node.style.removeProperty("grid-row"); return; }
        any = true;
        node.hidden = false;
        place(node, t);
        if (ext[id]) mountExt(id);
        refreshControls(node, id, t);
      });
      var none = document.getElementById("all-hidden");
      if (!any) {
        if (!none) { none = el("p", "all-hidden", "Every tile is hidden. Press Customise, then Tiles, to put some back."); none.id = "all-hidden"; box.appendChild(none); }
      } else if (none) none.parentNode.removeChild(none);
      if (!keepBar) renderBar();
      if (S.barFocus) { var bf = bar.querySelector(S.barFocus); S.barFocus = null; if (bf) bf.focus(); }
      if (S.focusId) { var g = box.querySelector('.w[data-w="' + S.focusId + '"] .b-grip'); S.focusId = null; if (g) g.focus(); }
    }

    // ---- tile controls (built once, shown only in Customise) ----

    function describeTile(t) { return t ? Layout.describe(t) : ""; }

    function ensureControls(node, id) {
      if (node.querySelector(".b-bar")) return;
      var name = title(id);
      var b = el("div", "b-bar");
      var grip = el("button", "b-grip");
      grip.type = "button";
      grip.appendChild(svgIcon("grip"));
      grip.appendChild(el("span", "b-name", name));
      var more = el("button", "b-more");
      more.type = "button";
      more.setAttribute("aria-haspopup", "true");
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-label", "Options for " + name);
      more.appendChild(svgIcon("more"));
      b.appendChild(grip); b.appendChild(more);
      node.appendChild(b);
      ["e", "s", "se"].forEach(function (edge) {
        var h = el("span", "b-rs b-rs-" + edge);
        h.setAttribute("data-edge", edge);
        h.setAttribute("aria-hidden", "true");
        node.appendChild(h);
      });
      var menu = el("div", "b-menu");
      menu.setAttribute("role", "group");
      menu.setAttribute("aria-label", "Options for " + name);
      menu.hidden = true;
      node.appendChild(menu);

      grip.addEventListener("keydown", function (ev) { onGripKey(ev, id); });
      grip.addEventListener("pointerdown", function (ev) { startDrag(ev, id, "move", ""); });
      Array.prototype.forEach.call(node.querySelectorAll(".b-rs"), function (h) {
        h.addEventListener("pointerdown", function (ev) { startDrag(ev, id, "resize", h.getAttribute("data-edge")); });
      });
      more.addEventListener("click", function () { toggleMenu(id); });
    }

    function refreshControls(node, id, t) {
      ensureControls(node, id);
      var grip = node.querySelector(".b-grip");
      var picked = S.picked && S.picked.id === id;
      grip.setAttribute("aria-label", title(id) + ", " + describeTile(Layout.find(S.working || [], id) || t) + ". " +
        (listMode() ? "Use the options button to move it." : picked ? "Picked up. Arrow keys move, Shift and arrow keys resize, Enter drops, Escape cancels." : "Press Space to pick it up, then use the arrow keys."));
      grip.setAttribute("aria-pressed", picked ? "true" : "false");
      node.classList.toggle("is-picked", !!picked);
      var menu = node.querySelector(".b-menu");
      var open = S.menu === id;
      menu.hidden = !open;
      node.querySelector(".b-more").setAttribute("aria-expanded", open ? "true" : "false");
      if (open && !menu.firstChild) buildMenu(menu, id);
      if (!open) while (menu.firstChild) menu.removeChild(menu.firstChild);
    }

    // ---- the options menu: the non-drag route to everything ----

    function actions(id) {
      var list = [];
      function add(label, fn) { list.push([label, fn]); }
      if (listMode()) {
        add("Move earlier", function () { apply(Layout.reorder(S.working, id, -1), id, "Moved earlier"); });
        add("Move later", function () { apply(Layout.reorder(S.working, id, 1), id, "Moved later"); });
      } else {
        add("Move left", function () { apply(Layout.nudge(S.working, id, -1, 0), id, "Moved"); });
        add("Move right", function () { apply(Layout.nudge(S.working, id, 1, 0), id, "Moved"); });
        add("Move up", function () { apply(Layout.nudge(S.working, id, 0, -1), id, "Moved"); });
        add("Move down", function () { apply(Layout.nudge(S.working, id, 0, 1), id, "Moved"); });
        add("Make wider", function () { apply(Layout.grow(S.working, id, 1, 0), id, "Resized"); });
        add("Make narrower", function () { apply(Layout.grow(S.working, id, -1, 0), id, "Resized"); });
      }
      add("Make taller", function () { apply(Layout.grow(S.working, id, 0, 1), id, "Resized"); });
      add("Make shorter", function () { apply(Layout.grow(S.working, id, 0, -1), id, "Resized"); });
      add("Fit to its content", function () { fitTile(id); });
      add("Hide", function () { hideTile(id); });
      return list;
    }

    function buildMenu(menu, id) {
      actions(id).forEach(function (a) {
        var b = el("button", "b-act", a[0]);
        b.type = "button";
        b.addEventListener("click", function () { a[1](); });
        menu.appendChild(b);
      });
    }

    function toggleMenu(id) {
      S.menu = S.menu === id ? null : id;
      render();
      if (S.menu) { var first = box.querySelector('.w[data-w="' + id + '"] .b-act'); if (first) first.focus(); }
    }

    function closeMenu(refocus) {
      var id = S.menu;
      if (!id) return;
      S.menu = null;
      if (refocus) S.focusId = id;
      render();
    }

    // ---- changing the draft ----

    function apply(next, id, verb) {
      S.working = Layout.compact(next);
      S.preview = null;
      var t = Layout.find(S.working, id);
      S.focusId = S.menu ? null : id;
      render();
      if (S.menu === id) { var m = box.querySelector('.w[data-w="' + id + '"] .b-more'); if (m) m.focus(); }
      announce(title(id) + " " + (verb || "moved").toLowerCase() + ": " + describeTile(t));
    }

    function hideTile(id) {
      S.working = Layout.remove(S.working, id);
      S.menu = null;
      render();
      announce(title(id) + " hidden. Use Tiles to put it back.");
      var any = box.querySelector(".w:not([hidden]) .b-grip");
      if (any) any.focus();
    }

    function showTile(id) {
      S.working = Layout.add(S.working, id);
      render(true);
      announce(title(id) + " is back on the board: " + describeTile(Layout.find(S.working, id)));
    }

    // How tall the tile's own content is, without the open options menu (it hangs off the tile and would inflate the
    // measurement) and without the extra room Customise leaves for the top bar.
    function contentHeight(node) {
      var menu = node.querySelector(".b-menu"), wasHidden = menu ? menu.hidden : true;
      if (menu) menu.hidden = true;
      var editPad = parseFloat(root.getComputedStyle(node).paddingTop) || 0;
      var viewPad = node.classList.contains("lift") ? 0 : 18;
      var px = node.scrollHeight - editPad + viewPad;
      if (menu) menu.hidden = wasHidden;
      return px;
    }

    function fitTile(id) {
      var node = tileEl(id), cs = root.getComputedStyle(box);
      var rows = rowsFor(contentHeight(node), rowPx(), parseFloat(cs.rowGap) || 0);
      S.menu = null;
      apply(Layout.fit(S.working, id, rows), id, "fitted to its content");
    }

    function rowPx() {
      var v = parseFloat(root.getComputedStyle(box).getPropertyValue("--board-row"));
      return v > 0 ? v : ROW_FALLBACK;
    }

    // ---- keyboard on a tile's grip ----

    function onGripKey(ev, id) {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      var picked = !!(S.picked && S.picked.id === id);
      var intent = keyIntent(ev.key, ev.shiftKey, picked);
      if (!intent) return;
      if (listMode() && intent.type !== "focus") { if (intent.type === "pick" || intent.type === "drop") { ev.preventDefault(); toggleMenu(id); } return; }
      ev.preventDefault();
      if (intent.type === "pick") {
        S.picked = { id: id, snapshot: Layout.compact(S.working) };
        refreshAll();
        announce("Picked up " + title(id) + ", " + describeTile(Layout.find(S.working, id)) + ". Arrow keys move it, Shift and arrow keys resize it, Enter drops it, Escape cancels.");
      } else if (intent.type === "drop") {
        S.working = Layout.compact(S.working);
        S.picked = null;
        S.focusId = id;
        render();
        announce("Dropped " + title(id) + ": " + describeTile(Layout.find(S.working, id)));
      } else if (intent.type === "cancel") {
        S.working = S.picked.snapshot;
        S.picked = null;
        S.focusId = id;
        render();
        announce("Cancelled. " + title(id) + " is back where it was: " + describeTile(Layout.find(S.working, id)));
      } else if (intent.type === "move") {
        S.working = Layout.nudge(S.working, id, intent.dx, intent.dy);
        S.focusId = id; render();
        announce(title(id) + " moved to " + describeTile(Layout.find(S.working, id)));
      } else if (intent.type === "resize") {
        S.working = Layout.grow(S.working, id, intent.dw, intent.dh);
        S.focusId = id; render();
        announce(title(id) + " resized: " + describeTile(Layout.find(S.working, id)));
      } else if (intent.type === "focus") {
        var order = Layout.readingOrder(S.working), at = order.indexOf(id), to = order[at + intent.dir];
        if (to) { var g = box.querySelector('.w[data-w="' + to + '"] .b-grip'); if (g) g.focus(); }
      }
    }

    function refreshAll() { render(); var g = S.picked && box.querySelector('.w[data-w="' + S.picked.id + '"] .b-grip'); if (g) g.focus(); }

    // ---- dragging and resizing with a pointer ----

    function startDrag(ev, id, kind, edge) {
      if (!S.editing || listMode() || (ev.button !== undefined && ev.button !== 0) || !ev.isPrimary) return;
      var node = tileEl(id), start = Layout.find(S.working, id);
      if (!node || !start) return;
      var rect = box.getBoundingClientRect(), cs = root.getComputedStyle(box), tr = node.getBoundingClientRect();
      var colGap = parseFloat(cs.columnGap) || 0, rowGap = parseFloat(cs.rowGap) || 0;
      S.menu = null;
      S.drag = {
        id: id, kind: kind, edge: edge, start: start, base: Layout.compact(S.working), startX: ev.clientX, startY: ev.clientY,
        offX: ev.clientX - tr.left, offY: ev.clientY - tr.top, steps: stepsFor(rect.width, 12, colGap, rowPx(), rowGap),
        pointerId: ev.pointerId, target: ev.currentTarget, lastX: ev.clientX, lastY: ev.clientY, key: "", scroller: null, node: node
      };
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) { /* the page still gets the events */ }
      node.classList.add("is-lifting");
      box.classList.add("is-dragging");
      if (kind === "move") { ghost = el("div", "b-ghost"); ghost.setAttribute("aria-hidden", "true"); box.appendChild(ghost); }
      ev.currentTarget.addEventListener("pointermove", onDragMove);
      ev.currentTarget.addEventListener("pointerup", onDragEnd);
      ev.currentTarget.addEventListener("pointercancel", onDragCancel);
      S.drag.scroller = root.setInterval(autoScroll, 40);
      root.addEventListener("keydown", onDragKey, true);
    }

    function dragUpdate() {
      var d = S.drag;
      if (!d) return;
      var rect = box.getBoundingClientRect(), preview, slot;
      if (d.kind === "move") {
        var left = d.lastX - d.offX - rect.left, top = d.lastY - d.offY - rect.top;
        var cell = cellAt(left, top, d.steps, 12, d.start.w);
        preview = Layout.move(d.base, d.id, cell.x, cell.y);
        slot = Layout.find(preview, d.id);
        var key = boxKey(preview);
        if (key !== d.key) { d.key = key; paint(preview); }
        place(ghost, slot);
        d.node.style.setProperty("transform", "translate(" + Math.round(left - slot.x * d.steps.stepX) + "px, " + Math.round(top - slot.y * d.steps.stepY) + "px)");
      } else {
        var size = sizeFrom(d.start.w, d.start.h, d.edge.indexOf("e") >= 0 ? d.lastX - d.startX : 0, d.edge.indexOf("s") >= 0 ? d.lastY - d.startY : 0, d.steps);
        preview = Layout.resize(d.base, d.id, size.w, size.h);
        var k2 = boxKey(preview);
        if (k2 !== d.key) { d.key = k2; paint(preview); }
      }
      d.preview = preview;
    }

    function boxKey(tiles) { return tiles.map(function (t) { return t.id + t.x + "," + t.y + "," + t.w + "," + t.h; }).join("|"); }

    // Places every tile as the preview says, without touching the controls.
    function paint(tiles) {
      var byId = {};
      tiles.forEach(function (t) { byId[t.id] = t; });
      tileEls().forEach(function (node) { var t = byId[node.getAttribute("data-w")]; if (t) place(node, t); });
    }

    function autoScroll() {
      var d = S.drag;
      if (!d) return;
      var edge = 56, dy = d.lastY < edge ? -16 : d.lastY > root.innerHeight - edge ? 16 : 0;
      if (dy) { root.scrollBy(0, dy); dragUpdate(); }
    }

    function onDragMove(ev) { var d = S.drag; if (!d || ev.pointerId !== d.pointerId) return; d.lastX = ev.clientX; d.lastY = ev.clientY; dragUpdate(); }
    function onDragEnd(ev) { var d = S.drag; if (!d || ev.pointerId !== d.pointerId) return; endDrag(true); }
    function onDragCancel() { endDrag(false); }
    function onDragKey(ev) { if (S.drag && ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); endDrag(false); } }

    function endDrag(commit) {
      var d = S.drag;
      if (!d) return;
      S.drag = null;
      root.clearInterval(d.scroller);
      root.removeEventListener("keydown", onDragKey, true);
      d.target.removeEventListener("pointermove", onDragMove);
      d.target.removeEventListener("pointerup", onDragEnd);
      d.target.removeEventListener("pointercancel", onDragCancel);
      try { d.target.releasePointerCapture(d.pointerId); } catch (e) { /* already released */ }
      d.node.style.removeProperty("transform");
      d.node.classList.remove("is-lifting");
      box.classList.remove("is-dragging");
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      if (commit && d.preview) {
        S.working = Layout.compact(d.preview);
        S.focusId = d.id;
        announce(title(d.id) + (d.kind === "move" ? " moved to " : " resized: ") + describeTile(Layout.find(S.working, d.id)));
      } else if (!commit) announce("Cancelled.");
      S.preview = null;
      render();
    }

    // ---- the bar above the board: Customise / Done / Cancel / Tiles / Reset ----

    function button(label, cls, fn) {
      var b = el("button", cls || "btn btn-sm", label);
      b.type = "button";
      b.addEventListener("click", fn);
      return b;
    }

    function renderBar() {
      if (!bar) return;
      while (bar.firstChild) bar.removeChild(bar.firstChild);
      if (!S.editing) {
        var row = el("div", "board-row");
        var using = current().layout;
        if (using) row.appendChild(el("span", "board-using dim", "Layout for this screen: " + using.name));
        var lb = button("Layouts", "btn btn-sm board-layouts-btn", function () { S.layouts = !S.layouts; S.renaming = null; S.confirmDelete = null; S.layoutMsg = ""; renderBar(); if (S.layouts) { var f = bar.querySelector(".board-layouts input"); if (f) f.focus(); } else lb.focus(); });
        lb.setAttribute("aria-expanded", S.layouts ? "true" : "false");
        row.appendChild(lb);
        row.appendChild(button("Customise", "btn btn-sm board-customise", enter));
        bar.appendChild(row);
        if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
        if (S.layouts) bar.appendChild(layoutsPanel()); else if (lpanelEl && lpanelEl.parentNode) lpanelEl.parentNode.removeChild(lpanelEl);
        bar.appendChild(live);
        return;
      }
      if (lpanelEl && lpanelEl.parentNode) lpanelEl.parentNode.removeChild(lpanelEl);
      var editing = S.layoutId && Layout.findLayout(Theme.get().boardSets, S.layoutId);
      var head = el("div", "board-row board-editing");
      var heading = el("strong", "board-title", (listMode() ? "Customising: a single column" : "Customising the board") + (editing ? " (layout: " + editing.name + ")" : ""));
      head.appendChild(heading);
      var acts = el("div", "board-acts");
      acts.appendChild(button("Done", "btn btn-sm btn-primary", done));
      acts.appendChild(button("Cancel", "btn btn-sm", cancel));
      var tiles = button("Tiles", "btn btn-sm board-tiles-btn", function () { S.panel = !S.panel; S.barFocus = ".board-tiles-btn"; render(); });
      tiles.setAttribute("aria-expanded", S.panel ? "true" : "false");
      acts.appendChild(tiles);
      if (!S.confirmReset) acts.appendChild(button("Reset layout", "btn btn-sm board-reset-btn", function () { S.confirmReset = true; S.barFocus = ".board-yes"; render(); }));
      else {
        acts.appendChild(el("span", "board-ask", "Put every tile back to the standard arrangement?"));
        var yes = button("Yes, reset", "btn btn-sm board-yes", reset);
        acts.appendChild(yes);
        acts.appendChild(button("No", "btn btn-sm", function () { S.confirmReset = false; S.barFocus = ".board-reset-btn"; render(); }));
      }
      head.appendChild(acts);
      bar.appendChild(head);
      var hint = el("p", "board-hint dim", listMode()
        ? "Each tile has an options button: move it earlier or later, make it taller or shorter, or hide it. Done saves, Cancel puts everything back."
        : "Drag a tile by its top bar and pull its edges to resize it. With the keyboard, Tab to a tile's bar, press Space to pick it up, move it with the arrow keys, resize with Shift and the arrow keys, and press Enter to drop it. Done saves, Cancel puts everything back.");
      bar.appendChild(hint);
      if (S.panel) { renderPanel(); bar.appendChild(panelEl); } else if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      bar.appendChild(live);
    }

    function renderPanel() {
      if (!S.panel) return;
      if (!panelEl) { panelEl = el("section", "board-panel"); panelEl.setAttribute("aria-label", "Tiles"); }
      while (panelEl.firstChild) panelEl.removeChild(panelEl.firstChild);
      panelEl.appendChild(el("h2", "board-panel-h", "Tiles"));
      panelEl.appendChild(el("p", "dim", "Tick a tile to show it on the board; untick to hide it. Hidden tiles keep their settings."));
      var ul = el("ul", "board-tiles");
      ul.setAttribute("role", "list");
      allowedIds().forEach(function (id) {
        var s = Layout.spec(id), on = !!Layout.find(S.working, id);
        var li = el("li", "board-tile-row");
        var label = el("label", "board-tile-label");
        var cb = el("input");
        cb.type = "checkbox"; cb.checked = on;
        cb.addEventListener("change", function () { if (cb.checked) showTile(id); else { S.working = Layout.remove(S.working, id); render(true); announce(title(id) + " hidden."); } });
        label.appendChild(cb);
        var text = el("span", "board-tile-text");
        text.appendChild(el("b", null, title(id)));
        if (s && s.about) text.appendChild(el("span", "dim", s.about));
        label.appendChild(text);
        li.appendChild(label);
        ul.appendChild(li);
      });
      panelEl.appendChild(ul);
    }

    // ---- Layouts: which arrangement each kind of screen uses ----
    //
    // The standard arrangement plus up to four named ones; every kind of screen (wide, standard, small) picks one. A
    // change here is saved at once. Customise afterwards edits the one this screen uses.

    var lpanelEl = null;

    function setSets(next, message, focus) {
      S.barFocus = focus || S.barFocus;
      Theme.set({ boardSets: next });
      S.layoutMsg = message || "";
      render();
      if (message) { say(message); announce(message); }
    }
    var LAYOUT_ERRORS = { name_required: "Give the layout a name.", name_taken: "A layout with that name already exists.", too_many: "You can keep four layouts. Delete one first.", no_tiles: "There is nothing on the board to save.", not_found: "That layout is gone." };

    function layoutsPanel() {
      if (!lpanelEl) { lpanelEl = el("section", "board-panel board-layouts"); lpanelEl.setAttribute("aria-label", "Layouts"); }
      var panel = lpanelEl;
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      var sets = Layout.normalizeSets(Theme.get().boardSets), layouts = sets ? sets.layouts : [];
      var here = Layout.DEVICES.filter(function (d) { return d.id === S.cls; })[0];
      panel.appendChild(el("h2", "board-panel-h", "Layouts"));
      panel.appendChild(el("p", "dim", "This screen counts as " + here.title.toLowerCase() + " (" + here.about + "). Choose the arrangement each kind of screen uses; Customise then changes the one this screen uses. Changes here save at once."));

      var table = el("table", "lay-table");
      var cap = el("caption", "sr-only", "Which layout each kind of screen uses");
      table.appendChild(cap);
      var thead = el("thead"), hr = el("tr");
      hr.appendChild(el("th", null, "Layout"));
      Layout.DEVICES.forEach(function (d) { var th = el("th", d.id === S.cls ? "is-here" : "", d.title); th.scope = "col"; th.title = d.about; hr.appendChild(th); });
      hr.appendChild(el("th", "sr-only", "Actions"));
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el("tbody");
      var rows = [{ id: null, name: "Standard", about: "Your usual arrangement" }].concat(layouts.map(function (l) { return { id: l.id, name: l.name, named: true }; }));
      rows.forEach(function (r) {
        var tr = el("tr");
        var th = el("th", "lay-name");
        th.scope = "row";
        if (S.renaming && S.renaming === r.id) {
          var nameIn = el("input", "lay-input");
          nameIn.type = "text"; nameIn.maxLength = Layout.NAME_MAX; nameIn.value = r.name; nameIn.setAttribute("aria-label", "New name for " + r.name);
          var save = function () {
            var res = Layout.renameLayout(Theme.get().boardSets, r.id, nameIn.value);
            if (res.error) { S.layoutMsg = LAYOUT_ERRORS[res.error] || "That didn't work."; render(); announce(S.layoutMsg); return; }
            S.renaming = null; setSets(res.sets, "Renamed to " + Layout.cleanName(nameIn.value) + ".");
          };
          nameIn.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); save(); } else if (ev.key === "Escape") { ev.preventDefault(); S.renaming = null; render(); } });
          th.appendChild(nameIn);
          var ok = button("Save", "btn btn-sm", save);
          th.appendChild(ok);
          th.appendChild(button("Cancel", "btn btn-sm", function () { S.renaming = null; render(); }));
          root.setTimeout(function () { nameIn.focus(); nameIn.select(); }, 0);
        } else {
          th.appendChild(el("span", "lay-title", r.name));
          if (r.about) th.appendChild(el("span", "dim lay-about", r.about));
        }
        tr.appendChild(th);
        Layout.DEVICES.forEach(function (d) {
          var td = el("td", d.id === S.cls ? "is-here" : "");
          var rb = el("input");
          rb.type = "radio"; rb.name = "lay-" + d.id; rb.value = r.id || "";
          rb.checked = (sets ? sets.pick[d.id] : null) === r.id;
          rb.setAttribute("aria-label", r.name + " on " + d.title.toLowerCase());
          rb.addEventListener("change", function () {
            var res = Layout.assignLayout(Theme.get().boardSets, d.id, r.id);
            if (res.error) { S.layoutMsg = LAYOUT_ERRORS[res.error] || "That didn't work."; render(); return; }
            setSets(res.sets, d.title + " now use " + r.name + ".", '.board-layouts input[name="lay-' + d.id + '"][value="' + (r.id || "") + '"]');
          });
          td.appendChild(rb);
          tr.appendChild(td);
        });
        var act = el("td", "lay-acts");
        if (r.named && !(S.renaming === r.id)) {
          act.appendChild(button("Rename", "btn btn-sm", function () { S.renaming = r.id; S.confirmDelete = null; render(); }));
          if (S.confirmDelete === r.id) {
            act.appendChild(button("Yes, delete", "btn btn-sm", function () {
              var res = Layout.deleteLayout(Theme.get().boardSets, r.id);
              S.confirmDelete = null;
              if (res.error) { S.layoutMsg = LAYOUT_ERRORS[res.error]; render(); return; }
              setSets(res.sets, "Deleted " + r.name + ". Screens that used it go back to Standard.");
            }));
            act.appendChild(button("No", "btn btn-sm", function () { S.confirmDelete = null; render(); }));
          } else {
            act.appendChild(button("Delete", "btn btn-sm", function () { S.confirmDelete = r.id; S.renaming = null; render(); }));
          }
        }
        tr.appendChild(act);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      var wrap = el("div", "lay-scroll");
      wrap.appendChild(table);
      panel.appendChild(wrap);

      var form = el("div", "lay-new");
      var label = el("label", "lay-new-label", "Save this screen's arrangement as a new layout");
      var input = el("input", "lay-input");
      input.type = "text"; input.maxLength = Layout.NAME_MAX; input.placeholder = "Name, for example Big monitor";
      input.id = "lay-new-name";
      label.setAttribute("for", "lay-new-name");
      var create = function () {
        var res = Layout.addLayout(Theme.get().boardSets, input.value, saved(), S.cls);
        if (res.error) { S.layoutMsg = LAYOUT_ERRORS[res.error] || "That didn't work."; render(); announce(S.layoutMsg); return; }
        if (res.id) markSeen("l:" + res.id);   // saved from what is on screen, which already shows the default-on tiles
        setSets(res.sets, "Saved " + Layout.cleanName(input.value) + ". " + here.title + " now use it.", ".board-layouts .lay-new .lay-input");
      };
      input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); create(); } });
      var add = button("Save as new layout", "btn btn-sm", create);
      if (layouts.length >= Layout.MAX_LAYOUTS) { add.disabled = true; input.disabled = true; }
      form.appendChild(label); form.appendChild(input); form.appendChild(add);
      form.appendChild(el("span", "dim", layouts.length + " of " + Layout.MAX_LAYOUTS + " layouts kept"));
      panel.appendChild(form);
      var msg = el("p", "lay-msg", S.layoutMsg);
      msg.setAttribute("role", "status");
      panel.appendChild(msg);
      return panel;
    }

    // ---- Customise: start, finish, give up, reset ----

    function enter() {
      S.editing = true;
      S.layouts = false; S.renaming = null; S.confirmDelete = null;
      S.layoutId = current().layout ? current().layout.id : null;
      S.start = Layout.compact(saved());
      S.working = Layout.compact(saved());
      S.picked = null; S.menu = null; S.panel = false; S.confirmReset = false;
      S.focusId = Layout.readingOrder(S.working)[0] || null;
      render();
      announce("Customising the board. " + (listMode() ? "Use each tile's options button." : "Tab to a tile's top bar and press Space to pick it up."));
    }

    function leave() {
      S.editing = false; S.picked = null; S.menu = null; S.panel = false; S.confirmReset = false; S.preview = null; S.working = null; S.start = null;
      S.layoutId = null;
      S.cls = Layout.deviceClass(root.innerWidth);   // the window may have been resized while editing
    }

    function done() {
      var changed = !sameTiles(S.working, S.start), s = Theme.get(), working = S.working, layoutId = S.layoutId;
      leave();
      if (changed) {
        var named = layoutId && Layout.findLayout(s.boardSets, layoutId);
        if (named) {
          // A named layout keeps its own arrangement and what it shows; the standard one and the widgets list are left alone.
          var res = Layout.writeLayout(s.boardSets, layoutId, working);
          if (!res.error) { Theme.set({ boardSets: res.sets }); markSeen(seenKey(named)); }
        } else {
          var list = mergeList(Layout.toWidgets(working, s.widgets), s.widgets, restricted);
          Theme.set({ widgets: list, board: Layout.toBoard(working) });
          markSeen(seenKey(null));   // what is saved now says which tiles are shown: one that is missing is hidden on purpose
        }
      }
      render();
      var c = box.parentNode.querySelector(".board-customise"); if (c) c.focus();
      say(changed ? "Layout saved." : "No changes.");
      announce(changed ? "Layout saved." : "No changes made.");
    }

    function cancel() {
      leave(); render();
      var c = box.parentNode.querySelector(".board-customise"); if (c) c.focus();
      announce("Cancelled. The board is as it was.");
    }

    function reset() {
      var layoutId = S.layoutId, s = Theme.get();
      leave();
      var named = layoutId && Layout.findLayout(s.boardSets, layoutId);
      if (named) {
        // Only this named layout goes back to the standard arrangement; the standard one itself is not touched.
        var res = Layout.writeLayout(s.boardSets, layoutId, Layout.addAtTop(Layout.effective(null, Theme.defaults().widgets, shown, extraIds()), defaultOnIds()));
        if (!res.error) { Theme.set({ boardSets: res.sets }); markSeen(seenKey(named)); }
      } else {
        Theme.set({ widgets: Theme.defaults().widgets, board: null });
        clearSeen(seenKey(null));   // the standard arrangement is back, and it includes the default-on tiles at the top
      }
      render();
      say("Layout reset to the standard arrangement.");
      announce("Layout reset to the standard arrangement.");
      var c = box.parentNode.querySelector(".board-customise"); if (c) c.focus();
    }

    // ---- start-up ----

    function measure() {
      var next = columnsFor(box.clientWidth || box.getBoundingClientRect().width || 1200);
      var cls = Layout.deviceClass(root.innerWidth), classChanged = !S.editing && cls !== S.cls;
      if (next === S.cols && !classChanged) return;
      if (classChanged) S.cls = cls;   // a window that crosses 1000 or 1500 px picks up that kind of screen's layout
      S.cols = next;
      S.picked = null; S.menu = null;
      if (S.drag) endDrag(false);
      render();
    }

    function init() {
      bar = el("div", "board-bar");
      bar.id = "board-bar";
      live = el("div", "sr-only");
      live.setAttribute("aria-live", "polite");
      live.id = "board-live";
      box.parentNode.insertBefore(bar, box);
      S.cols = columnsFor(box.clientWidth || 1200);
      box.addEventListener("focusout", function (ev) {
        if (S.menu && !box.contains(ev.relatedTarget)) { S.menu = null; render(); }
      });
      root.document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && S.menu && !S.drag) { ev.preventDefault(); closeMenu(true); } });
      if (typeof root.ResizeObserver === "function") new root.ResizeObserver(function () { root.clearTimeout(resizeTimer); resizeTimer = root.setTimeout(measure, 60); }).observe(box);
      else root.addEventListener("resize", function () { root.clearTimeout(resizeTimer); resizeTimer = root.setTimeout(measure, 100); });
      render();
    }

    init();
    return {
      render: function () { if (!S.editing) render(); else if (!S.drag) render(); },
      editing: function () { return S.editing; },
      enter: enter, cancel: cancel,
      state: function () { return S; }
    };
  }

  var api = { create: create, helpers: helpers };
  for (var k in helpers) api[k] = helpers[k];
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardBoardUI = api;
})(typeof window !== "undefined" ? window : this);
