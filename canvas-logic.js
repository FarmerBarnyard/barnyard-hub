// The Canvas page's rules, with no DOM and no network (canvas.js uses them; test/canvas.test.js covers them).
//
// A board is { items: [...], view: { x, y, k } } exactly as the Worker keeps it (ClaudeRepo's cloudflare-worker/src/canvas-logic.js
// holds the same shape and the limits). Items: note, text, shape, frame, card (a live card for one hub item) and arrow (a line
// between two items, or two free points). Items are drawn in list order, so later is on top. Every function here that changes a
// board returns a NEW list and leaves its input alone, which is what makes undo a matter of keeping the old lists.
//
// Browser: window.BarnyardCanvasLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var COLORS = ["default", "red", "amber", "green", "blue", "violet", "grey"];
  var COLOR_LABEL = { "default": "Plain", red: "Red", amber: "Amber", green: "Green", blue: "Blue", violet: "Violet", grey: "Grey" };
  var SHAPES = ["rect", "round", "ellipse", "diamond"];
  var SHAPE_LABEL = { rect: "Box", round: "Rounded box", ellipse: "Ellipse", diamond: "Diamond" };
  var SIZES = ["s", "m", "l"];
  var FONT = { s: 14, m: 20, l: 30 };
  var DEFAULTS = { note: { w: 180, h: 110 }, text: { w: 260, h: 40 }, shape: { w: 160, h: 80 }, frame: { w: 360, h: 240 }, card: { w: 240, h: 84 } };
  var LIMITS = { items: 400, text: 600, label: 120, minSize: 20, maxSize: 4000, coord: 100000, undo: 100, lines: 12, title: 80 };
  var GRID = 10;
  var MIN_K = 0.1, MAX_K = 3;
  var FRAME_BAR = 30;      // the title strip of a frame, the part of it that picks it up

  // The kinds of hub item a card can point at, with the page that shows each.
  var CARD_KINDS = [
    { kind: "ops", label: "Ops item", plural: "Ops items", page: "ops.html", prefix: "it_" },
    { kind: "asset", label: "Asset", plural: "Assets", page: "map.html", prefix: "as_" },
    { kind: "incident", label: "Incident", plural: "Incidents", page: "incidents.html", prefix: "inc_" },
    { kind: "todo", label: "To-do", plural: "To-dos", page: "calendar.html", prefix: "td_" }
  ];
  var ID_RE = { ops: /^it_[a-z0-9]{8}$/, asset: /^as_[a-z0-9]{10}$/, incident: /^inc_[a-z0-9]{8}$/, todo: /^td_[0-9a-f]{8}$/ };

  function cardKind(kind) { for (var i = 0; i < CARD_KINDS.length; i++) if (CARD_KINDS[i].kind === kind) return CARD_KINDS[i]; return null; }
  function validRef(ref) { return !!(ref && ID_RE[ref.kind] && typeof ref.id === "string" && ID_RE[ref.kind].test(ref.id)); }

  // ---- small numbers -----------------------------------------------------------------------------------------------

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
  function snap(n, on) { return on ? Math.round(n / GRID) * GRID : Math.round(n); }
  function newId(rand) {
    var abc = "abcdefghijklmnopqrstuvwxyz0123456789", out = "";
    var r = typeof rand === "function" ? rand : Math.random;
    for (var i = 0; i < 8; i++) out += abc.charAt(Math.floor(r() * abc.length) % abc.length);
    return out;
  }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }

  // ---- the view (pan and zoom) -------------------------------------------------------------------------------------

  function toScreen(view, p) { return { x: p.x * view.k + view.x, y: p.y * view.k + view.y }; }
  function toWorld(view, p) { return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k }; }
  // Zoom by `factor` keeping the world point under `screen` where it is.
  function zoomAt(view, factor, screen) {
    var k = clamp(view.k * factor, MIN_K, MAX_K);
    var w = toWorld(view, screen);
    return { x: Math.round(screen.x - w.x * k), y: Math.round(screen.y - w.y * k), k: Math.round(k * 1000) / 1000 };
  }
  function panBy(view, dx, dy) { return { x: Math.round(view.x + dx), y: Math.round(view.y + dy), k: view.k }; }

  // ---- the shape of things -----------------------------------------------------------------------------------------

  function byId(items) { var m = {}; for (var i = 0; i < items.length; i++) m[items[i].id] = items[i]; return m; }
  function centre(it) { return { x: it.x + it.w / 2, y: it.y + it.h / 2 }; }

  // Where a line from the middle of `it` toward `toward` leaves it, for the shape it is.
  function anchor(it, toward) {
    var c = centre(it), a = it.w / 2, b = it.h / 2;
    var dx = toward.x - c.x, dy = toward.y - c.y;
    if (!dx && !dy) return { x: c.x, y: c.y };
    var t;
    var kind = it.type === "shape" ? it.shape : "rect";
    if (kind === "ellipse") t = 1 / Math.sqrt((dx / a) * (dx / a) + (dy / b) * (dy / b));
    else if (kind === "diamond") t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
    else t = 1 / Math.max(Math.abs(dx) / a, Math.abs(dy) / b);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  // The two end points of an arrow: where it meets the items at its ends, or its free points. `map` is byId(items).
  function arrowPoints(arrow, map) {
    var fi = arrow.from.item ? map[arrow.from.item] : null, ti = arrow.to.item ? map[arrow.to.item] : null;
    var fc = fi ? centre(fi) : { x: arrow.from.x || 0, y: arrow.from.y || 0 };
    var tc = ti ? centre(ti) : { x: arrow.to.x || 0, y: arrow.to.y || 0 };
    return { a: fi ? anchor(fi, tc) : fc, b: ti ? anchor(ti, fc) : tc };
  }

  function distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    var t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
    var x = a.x + t * dx, y = a.y + t * dy;
    return Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
  }

  function inside(it, p) { return p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h; }

  // The top-most thing at a world point: an item, else an arrow within `tol`, else null. A frame is only picked up by its title
  // strip, so the things drawn inside it stay reachable. -> the item, or null.
  function hit(items, p, tol) {
    var map = byId(items), i, it;
    for (i = items.length - 1; i >= 0; i--) {
      it = items[i];
      if (it.type === "arrow") continue;
      if (it.type === "frame") { if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + FRAME_BAR) return it; continue; }
      if (inside(it, p)) return it;
    }
    var best = null, bestD = tol === undefined ? 8 : tol;
    for (i = items.length - 1; i >= 0; i--) {
      it = items[i];
      if (it.type !== "arrow") continue;
      var pts = arrowPoints(it, map), d = distToSegment(p, pts.a, pts.b);
      if (d <= bestD) { best = it; bestD = d; }
    }
    return best;
  }

  // The top-most non-arrow item under a point, frames included wherever they are (for dropping an arrow's end on something).
  function itemAt(items, p) {
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (it.type === "arrow") continue;
      if (it.type === "frame") { if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + FRAME_BAR) return it; continue; }
      if (inside(it, p)) return it;
    }
    return null;
  }

  // The box that holds everything on the board (the arrows' free ends too), or null when the board is empty.
  function bounds(items) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, map = byId(items);
    function add(x, y) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    items.forEach(function (it) {
      if (it.type === "arrow") { var p = arrowPoints(it, map); add(p.a.x, p.a.y); add(p.b.x, p.b.y); return; }
      add(it.x, it.y); add(it.x + it.w, it.y + it.h);
    });
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Does `view` show at least part of the board inside a w x h window? (A view saved on a big screen can show nothing on a phone.)
  function anyVisible(items, view, w, h) {
    var b = bounds(items);
    if (!b) return true;
    var tl = toScreen(view, { x: b.x, y: b.y }), br = toScreen(view, { x: b.x + b.w, y: b.y + b.h });
    var overlapX = Math.min(br.x, w) - Math.max(tl.x, 0), overlapY = Math.min(br.y, h) - Math.max(tl.y, 0);
    return overlapX > 40 && overlapY > 40;
  }

  // A view that shows the whole board inside w x h with `pad` around it (never zoomed in past 1:1).
  function fitView(items, w, h, pad) {
    var b = bounds(items);
    pad = pad === undefined ? 48 : pad;
    if (!b) return { x: Math.round(w / 2), y: Math.round(h / 2), k: 1 };
    var k = clamp(Math.min((w - pad * 2) / Math.max(b.w, 1), (h - pad * 2) / Math.max(b.h, 1)), MIN_K, 1);
    return { x: Math.round((w - b.w * k) / 2 - b.x * k), y: Math.round((h - b.h * k) / 2 - b.y * k), k: Math.round(k * 1000) / 1000 };
  }

  // ---- changing a board (each returns a new list) ------------------------------------------------------------------

  function makeItem(type, p, opts, rand) {
    opts = opts || {};
    var d = DEFAULTS[type];
    var w = opts.w || d.w, h = opts.h || d.h;
    var it = { id: newId(rand), type: type, x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w: w, h: h };
    if (type === "note") { it.text = opts.text || ""; it.color = opts.color || "amber"; }
    else if (type === "text") { it.text = opts.text || "Text"; it.size = opts.size || "m"; it.color = opts.color || "default"; }
    else if (type === "shape") { it.shape = opts.shape || "rect"; it.text = opts.text || ""; it.color = opts.color || "default"; }
    else if (type === "frame") { it.text = opts.text || "Group"; it.color = opts.color || "default"; }
    else if (type === "card") { it.ref = { kind: opts.ref.kind, id: opts.ref.id }; it.label = String(opts.label || "").slice(0, LIMITS.label); it.color = opts.color || "default"; }
    return it;
  }

  function makeArrow(from, to, opts, rand) {
    opts = opts || {};
    return { id: newId(rand), type: "arrow", from: from, to: to, text: opts.text || "", style: opts.style || "solid", head: opts.head === undefined ? true : !!opts.head, color: opts.color || "default" };
  }

  function addItem(items, it) {
    if (items.length >= LIMITS.items) return { ok: false, error: "board_full", items: items };
    return { ok: true, items: items.concat([it]) };
  }

  function mapItems(items, id, fn) { return items.map(function (it) { return it.id === id ? fn(copyItem(it)) : it; }); }
  function copyItem(it) { return copy(it); }

  function patchItem(items, id, patch) {
    return mapItems(items, id, function (it) { for (var k in patch) it[k] = patch[k]; return it; });
  }

  // Move an item by (dx, dy). A frame takes the items that sit inside it with it. Arrows attached to an item follow on their own.
  function moveItem(items, id, dx, dy) {
    var target = null, i;
    for (i = 0; i < items.length; i++) if (items[i].id === id) target = items[i];
    if (!target || target.type === "arrow") return items;
    var carried = {};
    carried[id] = true;
    if (target.type === "frame") {
      items.forEach(function (it) {
        if (it.id === id || it.type === "arrow") return;
        var c = centre(it);
        if (c.x >= target.x && c.x <= target.x + target.w && c.y >= target.y && c.y <= target.y + target.h) carried[it.id] = true;
      });
    }
    return items.map(function (it) {
      if (!carried[it.id]) return it;
      var n = copyItem(it);
      n.x = clamp(Math.round(n.x + dx), -LIMITS.coord, LIMITS.coord);
      n.y = clamp(Math.round(n.y + dy), -LIMITS.coord, LIMITS.coord);
      return n;
    });
  }

  function resizeItem(items, id, w, h) {
    return mapItems(items, id, function (it) {
      if (it.type === "arrow") return it;
      it.w = clamp(Math.round(w), LIMITS.minSize, LIMITS.maxSize);
      it.h = clamp(Math.round(h), LIMITS.minSize, LIMITS.maxSize);
      return it;
    });
  }

  // Move a free end of an arrow (side is "from" or "to") to a point, or attach it to an item.
  function setArrowEnd(items, id, side, end) {
    return mapItems(items, id, function (it) { if (it.type === "arrow") it[side] = end; return it; });
  }

  // Remove an item. Arrows that were attached to it stay, as free ends where they last met it, so a diagram does not fall apart.
  function removeItem(items, id) {
    var map = byId(items);
    var out = [];
    items.forEach(function (it) {
      if (it.id === id) return;
      if (it.type === "arrow" && (it.from.item === id || it.to.item === id)) {
        var pts = arrowPoints(it, map), n = copyItem(it);
        if (n.from.item === id) n.from = { x: Math.round(pts.a.x), y: Math.round(pts.a.y) };
        if (n.to.item === id) n.to = { x: Math.round(pts.b.x), y: Math.round(pts.b.y) };
        out.push(n);
        return;
      }
      out.push(it);
    });
    return out;
  }

  function toFront(items, id) {
    var it = null, rest = [];
    items.forEach(function (x) { if (x.id === id) it = x; else rest.push(x); });
    return it ? rest.concat([it]) : items;
  }
  function toBack(items, id) {
    var it = null, rest = [];
    items.forEach(function (x) { if (x.id === id) it = x; else rest.push(x); });
    return it ? [it].concat(rest) : items;
  }

  // A copy of an item, a little down and to the right, on top. Arrows are copied as free arrows.
  function duplicateItem(items, id, rand) {
    if (items.length >= LIMITS.items) return { ok: false, error: "board_full", items: items };
    var map = byId(items), src = map[id];
    if (!src) return { ok: false, error: "not_found", items: items };
    var n = copyItem(src);
    n.id = newId(rand);
    if (src.type === "arrow") {
      var p = arrowPoints(src, map);
      n.from = { x: Math.round(p.a.x) + 30, y: Math.round(p.a.y) + 30 };
      n.to = { x: Math.round(p.b.x) + 30, y: Math.round(p.b.y) + 30 };
    } else { n.x += 30; n.y += 30; }
    return { ok: true, items: items.concat([n]), id: n.id };
  }

  // ---- undo and redo -----------------------------------------------------------------------------------------------

  // Keeps earlier states of the items list. push(state) after each change; undo() and redo() return the state to show, or null.
  function History(limit) {
    this.limit = limit || LIMITS.undo;
    this.past = [];
    this.future = [];
    this.now = null;
  }
  History.prototype.reset = function (state) { this.past = []; this.future = []; this.now = JSON.stringify(state); };
  History.prototype.push = function (state) {
    var s = JSON.stringify(state);
    if (s === this.now) return false;
    if (this.now !== null) { this.past.push(this.now); if (this.past.length > this.limit) this.past.shift(); }
    this.now = s;
    this.future = [];
    return true;
  };
  History.prototype.canUndo = function () { return this.past.length > 0; };
  History.prototype.canRedo = function () { return this.future.length > 0; };
  History.prototype.undo = function () {
    if (!this.past.length) return null;
    this.future.push(this.now);
    this.now = this.past.pop();
    return JSON.parse(this.now);
  };
  History.prototype.redo = function () {
    if (!this.future.length) return null;
    this.past.push(this.now);
    this.now = this.future.pop();
    return JSON.parse(this.now);
  };

  // ---- live cards --------------------------------------------------------------------------------------------------

  function clip(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function monthDay(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
    if (!m) return "";
    return parseInt(m[3], 10) + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parseInt(m[2], 10) - 1];
  }

  // Each normaliser turns an existing route's answer into { id: { title, status, tone, hint } }. tone is ok | attn | alert | info | dim.
  function opsLive(body) {
    var out = {}, list = body && Array.isArray(body.items) ? body.items : [];
    list.forEach(function (i) {
      if (!i || !i.id) return;
      var lane = i.lane, status = "Backlog", tone = "dim";
      if (i.proposal) { status = "Proposal"; tone = "attn"; }
      else if (lane === "done") { status = "Done"; tone = "ok"; }
      else if (lane === "waiting") { status = "Waiting on you"; tone = "attn"; }
      else if (lane === "in_progress") { status = "In progress"; tone = "info"; }
      else if (lane === "soaking") { status = "Soaking"; tone = "ok"; }
      out[i.id] = { title: clip(i.title, 120), status: status, tone: tone, hint: i.category || "" };
    });
    return out;
  }
  function assetsLive(body) {
    var out = {}, list = body && Array.isArray(body.nodes) ? body.nodes : [];
    list.forEach(function (n) {
      if (!n || !n.id) return;
      var s = n.state, status = "No monitor", tone = "dim";
      if (s === "up") { status = "Up"; tone = "ok"; } else if (s === "down") { status = "Down"; tone = "alert"; } else if (s === "unknown") { status = "Unknown"; tone = "dim"; }
      out[n.id] = { title: clip(n.name, 120), status: status, tone: tone, hint: n.kind || "" };
    });
    return out;
  }
  function incidentsLive(body) {
    var out = {}, list = body && Array.isArray(body.incidents) ? body.incidents : [];
    list.forEach(function (i) {
      if (!i || !i.id) return;
      var open = i.status === "open";
      var serious = i.severity === "SEV1" || i.severity === "SEV2";
      out[i.id] = { title: clip(i.title || i.name, 120), status: open ? "Open" + (i.severity ? " " + i.severity : "") : "Resolved", tone: open ? (serious ? "alert" : "attn") : "ok", hint: i.severity || "" };
    });
    return out;
  }
  function todosLive(body, today) {
    var out = {}, list = body && Array.isArray(body.tasks) ? body.tasks : [];
    list.forEach(function (t) {
      if (!t || !t.id) return;
      var status = "Open", tone = "dim";
      if (t.status === "done") { status = "Done"; tone = "ok"; }
      else if (t.due && today && t.due < today) { status = "Overdue"; tone = "alert"; }
      else if (t.due && today && t.due === today) { status = "Due today"; tone = "attn"; }
      else if (t.due) { status = "Due " + monthDay(t.due); tone = "info"; }
      out[t.id] = { title: clip(t.title, 120), status: status, tone: tone, hint: t.due || "" };
    });
    return out;
  }

  // What a card shows: the live title and state when the page has them, else the words kept when it was placed.
  function cardModel(item, live) {
    var k = cardKind(item.ref && item.ref.kind) || { label: "Item", page: "" };
    if (!live) return { kind: k.label, title: item.label || item.ref.id, status: "", tone: "dim", missing: false, page: k.page };
    var row = live[item.ref.kind] ? live[item.ref.kind][item.ref.id] : null;
    if (row) return { kind: k.label, title: row.title || item.label || item.ref.id, status: row.status, tone: row.tone, missing: false, page: k.page };
    if (live && live[item.ref.kind] === undefined) return { kind: k.label, title: item.label || item.ref.id, status: "Checking…", tone: "dim", missing: false, page: k.page };
    return { kind: k.label, title: item.label || item.ref.id, status: "Not found", tone: "dim", missing: true, page: k.page };
  }

  // The rows the "add a live card" picker shows for one kind, filtered by `q`, best-looking first, at most `max`.
  function pickerRows(kind, rows, q, max) {
    var needle = String(q || "").toLowerCase().trim(), out = [];
    var k = cardKind(kind);
    if (!k || !rows) return out;
    Object.keys(rows).forEach(function (id) {
      var r = rows[id];
      if (needle && (r.title + " " + r.status + " " + r.hint).toLowerCase().indexOf(needle) === -1) return;
      out.push({ kind: kind, id: id, title: r.title, status: r.status, tone: r.tone, hint: r.hint });
    });
    var rank = { alert: 0, attn: 1, info: 2, ok: 3, dim: 4 };
    out.sort(function (a, b) { return (rank[a.tone] - rank[b.tone]) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0); });
    return out.slice(0, max || 30);
  }

  // Which kinds of live data the board needs now (so the page asks only for those).
  function kindsUsed(items) {
    var seen = {};
    items.forEach(function (it) { if (it.type === "card" && it.ref) seen[it.ref.kind] = true; });
    return Object.keys(seen);
  }

  // ---- words on shapes ---------------------------------------------------------------------------------------------

  // Break text into lines of at most `maxChars` characters (words kept whole when they fit), at most `maxLines`, ending in "…" if cut.
  function wrapText(text, maxChars, maxLines) {
    maxChars = Math.max(4, maxChars | 0); maxLines = Math.max(1, maxLines | 0);
    var lines = [];
    String(text || "").split("\n").forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean), line = "";
      if (!words.length) { lines.push(""); return; }
      words.forEach(function (w) {
        while (w.length > maxChars) {
          if (line) { lines.push(line); line = ""; }
          lines.push(w.slice(0, maxChars));
          w = w.slice(maxChars);
        }
        if (!line) line = w;
        else if ((line + " " + w).length <= maxChars) line += " " + w;
        else { lines.push(line); line = w; }
      });
      if (line) lines.push(line);
    });
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var last = lines[maxLines - 1];
      lines[maxLines - 1] = (last.length >= maxChars ? last.slice(0, maxChars - 1) : last) + "…";
    }
    return lines;
  }

  function charsFor(width, fontSize) { return Math.max(4, Math.floor((width - 16) / (fontSize * 0.56))); }

  // ---- export ------------------------------------------------------------------------------------------------------

  // A plain light palette for a file that is opened outside the hub (so no theme variables): fill, stroke, ink.
  var EXPORT = {
    "default": ["#ffffff", "#8a97a5", "#0e1720"], red: ["#fde4e1", "#bd3326", "#0e1720"], amber: ["#fff0cc", "#a85f00", "#0e1720"],
    green: ["#dcf3e6", "#17794d", "#0e1720"], blue: ["#dcebfb", "#1d63b8", "#0e1720"], violet: ["#e8e2fa", "#6446d6", "#0e1720"], grey: ["#e8ecf0", "#586674", "#0e1720"]
  };
  var TONE = { ok: "#17794d", attn: "#6446d6", alert: "#bd3326", info: "#1d63b8", dim: "#586674" };

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function svgText(lines, x, y, size, anchorName, fill, weight) {
    var out = '<text x="' + x + '" y="' + y + '" font-size="' + size + '" text-anchor="' + anchorName + '" fill="' + fill + '"' + (weight ? ' font-weight="' + weight + '"' : "") + ">";
    lines.forEach(function (l, i) { out += '<tspan x="' + x + '" dy="' + (i ? Math.round(size * 1.25) : 0) + '">' + esc(l) + "</tspan>"; });
    return out + "</text>";
  }

  // A standalone SVG of the board. `live` (optional) is { kind: { id: row } } to print each card's current state.
  function toSvg(data, live) {
    var items = (data && data.items) || [], map = byId(items), b = bounds(items) || { x: 0, y: 0, w: 400, h: 300 };
    var pad = 40, W = Math.round(b.w + pad * 2), H = Math.round(b.h + pad * 2);
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + Math.round(b.x - pad) + " " + Math.round(b.y - pad) + " " + W + " " + H + '" width="' + W + '" height="' + H + '" font-family="Segoe UI, system-ui, sans-serif">'];
    out.push('<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#586674"/></marker></defs>');
    out.push('<rect x="' + Math.round(b.x - pad) + '" y="' + Math.round(b.y - pad) + '" width="' + W + '" height="' + H + '" fill="#ffffff"/>');
    items.forEach(function (it) {
      var c = EXPORT[it.color] || EXPORT["default"];
      if (it.type === "arrow") {
        var p = arrowPoints(it, map);
        out.push('<line x1="' + Math.round(p.a.x) + '" y1="' + Math.round(p.a.y) + '" x2="' + Math.round(p.b.x) + '" y2="' + Math.round(p.b.y) + '" stroke="' + (it.color === "default" ? "#586674" : c[1]) + '" stroke-width="2"' + (it.style === "dashed" ? ' stroke-dasharray="8 6"' : "") + (it.head ? ' marker-end="url(#ah)"' : "") + "/>");
        if (it.text) out.push(svgText([it.text], Math.round((p.a.x + p.b.x) / 2), Math.round((p.a.y + p.b.y) / 2) - 6, 13, "middle", "#0e1720"));
        return;
      }
      if (it.type === "frame") {
        out.push('<rect x="' + it.x + '" y="' + it.y + '" width="' + it.w + '" height="' + it.h + '" rx="10" fill="none" stroke="' + c[1] + '" stroke-width="2" stroke-dasharray="10 6"/>');
        out.push(svgText([it.text || ""], it.x + 12, it.y + 21, 15, "start", c[1], "600"));
        return;
      }
      if (it.type === "text") {
        var fs = FONT[it.size] || FONT.m;
        out.push(svgText(wrapText(it.text, charsFor(it.w, fs), LIMITS.lines), it.x, it.y + fs, fs, "start", "#0e1720"));
        return;
      }
      if (it.type === "card") {
        var m = cardModel(it, live || undefined);
        out.push('<rect x="' + it.x + '" y="' + it.y + '" width="' + it.w + '" height="' + it.h + '" rx="10" fill="#ffffff" stroke="' + c[1] + '" stroke-width="2"/>');
        out.push('<circle cx="' + (it.x + 16) + '" cy="' + (it.y + 20) + '" r="5" fill="' + (TONE[m.tone] || TONE.dim) + '"/>');
        out.push(svgText([m.kind.toUpperCase() + (m.status ? " · " + m.status : "")], it.x + 28, it.y + 24, 11, "start", "#586674"));
        out.push(svgText(wrapText(m.title, charsFor(it.w, 14), 2), it.x + 12, it.y + 46, 14, "start", "#0e1720", "600"));
        return;
      }
      if (it.type === "shape" && it.shape === "ellipse") out.push('<ellipse cx="' + (it.x + it.w / 2) + '" cy="' + (it.y + it.h / 2) + '" rx="' + it.w / 2 + '" ry="' + it.h / 2 + '" fill="' + c[0] + '" stroke="' + c[1] + '" stroke-width="2"/>');
      else if (it.type === "shape" && it.shape === "diamond") out.push('<polygon points="' + (it.x + it.w / 2) + "," + it.y + " " + (it.x + it.w) + "," + (it.y + it.h / 2) + " " + (it.x + it.w / 2) + "," + (it.y + it.h) + " " + it.x + "," + (it.y + it.h / 2) + '" fill="' + c[0] + '" stroke="' + c[1] + '" stroke-width="2"/>');
      else out.push('<rect x="' + it.x + '" y="' + it.y + '" width="' + it.w + '" height="' + it.h + '" rx="' + (it.type === "note" ? 4 : it.shape === "round" ? 18 : 6) + '" fill="' + c[0] + '" stroke="' + c[1] + '" stroke-width="2"/>');
      var lines = wrapText(it.text, charsFor(it.w, 14), Math.max(1, Math.floor((it.h - 12) / 18)));
      if (lines.length && (lines.length > 1 || lines[0])) {
        if (it.type === "note") out.push(svgText(lines, it.x + 10, it.y + 24, 14, "start", "#0e1720"));
        else out.push(svgText(lines, it.x + it.w / 2, it.y + it.h / 2 - ((lines.length - 1) * 9) + 5, 14, "middle", "#0e1720"));
      }
    });
    out.push("</svg>");
    return out.join("\n");
  }

  function fileName(title, ext) {
    var base = String(title || "canvas").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "canvas";
    return base + "." + ext;
  }

  // ---- words for the page ------------------------------------------------------------------------------------------

  var ERRORS = {
    unauthenticated: "Log in to use the Canvas.", forbidden: "The Canvas is for the hub owner.", canvas_disabled: "The Canvas is switched off on the Worker.",
    board_full: "This board is full (400 items). Delete something first.", boards_full: "There are already 20 boards. Delete one first.",
    board_too_big: "This board is too big to save. Remove some text or items.", too_many_items: "This board has too many items (400 at most).",
    secret_detected: "Something here looks like a password or a key. Take it out: the Canvas never keeps credentials.",
    conflict: "This board was changed somewhere else.", not_found: "That board is gone.", rate_limited: "Too many changes at once. Wait a moment.",
    recent_sign_in_required: "Please sign in again, then repeat this.", text_too_long: "That text is too long.", too_many_lines: "Too many lines (12 at most).",
    title_required: "Give the board a name.", title_too_long: "That name is too long (80 characters).", version_not_found: "That saved copy is gone."
  };
  function errorText(code, status) {
    if (ERRORS[code]) return ERRORS[code];
    if (status === 0) return "Could not reach the Worker. Your changes are kept here and saved when it is back.";
    if (status === 401) return ERRORS.unauthenticated;
    if (status === 403) return ERRORS.forbidden;
    if (status === 429) return ERRORS.rate_limited;
    return "That did not work (" + (code || status || "error") + ").";
  }

  function agoText(t, now) {
    if (!t) return "never";
    var s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + " s ago";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  function saveStatus(state, at, now) {
    if (state === "dirty") return "Unsaved changes";
    if (state === "saving") return "Saving…";
    if (state === "error") return "Not saved";
    if (state === "conflict") return "Changed elsewhere";
    return at ? "Saved " + agoText(at, now) : "Saved";
  }

  function boardSummary(b) { return b.title + " · " + b.items + (b.items === 1 ? " item" : " items"); }

  var api = {
    COLORS: COLORS, COLOR_LABEL: COLOR_LABEL, SHAPES: SHAPES, SHAPE_LABEL: SHAPE_LABEL, SIZES: SIZES, FONT: FONT, DEFAULTS: DEFAULTS, LIMITS: LIMITS, GRID: GRID,
    MIN_K: MIN_K, MAX_K: MAX_K, FRAME_BAR: FRAME_BAR, CARD_KINDS: CARD_KINDS, cardKind: cardKind, validRef: validRef,
    clamp: clamp, snap: snap, newId: newId, toScreen: toScreen, toWorld: toWorld, zoomAt: zoomAt, panBy: panBy,
    byId: byId, centre: centre, anchor: anchor, arrowPoints: arrowPoints, distToSegment: distToSegment, hit: hit, itemAt: itemAt, bounds: bounds, anyVisible: anyVisible, fitView: fitView,
    makeItem: makeItem, makeArrow: makeArrow, addItem: addItem, patchItem: patchItem, moveItem: moveItem, resizeItem: resizeItem, setArrowEnd: setArrowEnd,
    removeItem: removeItem, toFront: toFront, toBack: toBack, duplicateItem: duplicateItem, History: History,
    opsLive: opsLive, assetsLive: assetsLive, incidentsLive: incidentsLive, todosLive: todosLive, cardModel: cardModel, pickerRows: pickerRows, kindsUsed: kindsUsed,
    wrapText: wrapText, charsFor: charsFor, toSvg: toSvg, esc: esc, fileName: fileName, errorText: errorText, agoText: agoText, saveStatus: saveStatus, boardSummary: boardSummary
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardCanvasLogic = api;
})(typeof window !== "undefined" ? window : this);
