// The Overview board's layout engine: where each tile sits and how big it is. Pure functions, no DOM, so
// the rules (nothing overlaps, everything stays on the grid, other tiles flow around the one you move)
// are tested in node and the page (board.js) only draws what this says.
//
// The grid. 12 columns of equal width and rows of one fixed height. A tile is {id, x, y, w, h}: x and w
// count columns, y and h count rows, all whole numbers, x + w <= 12. Tiles never overlap and always float
// up as far as they can ("vertical compaction"), so there are no accidental gaps; where tiles end up in a
// row is the viewer's choice, how high they sit follows from what is above them.
//
// What is saved. Only the geometry: {v: 1, tiles: [{id, x, y, w, h}]}. Whether a tile is shown stays in the
// existing "widgets" list of the profile settings (themes.js), so the Home layout tab and its presets keep
// working. A viewer who has never customised has no saved geometry; one is worked out from the widgets
// list (fromWidgets), which gives the same arrangement the page has always had: each tile in order, one
// after another, wrapping to a new row when it does not fit.
//
// Narrow screens. The saved layout is the 12-column one. Below about 960px the page shows it halved to 6
// columns, and below about 560px as one column in reading order (toColumns); neither is saved.
//
// Adding a tile: add it to CATALOGUE (and to WIDGET_IDS / DEFAULT_WIDGETS in themes.js, which every site
// shares). Saved layouts that do not know the new tile get it placed in the first free space.
//
//   var B = BarnyardBoard;  B.move(tiles, "need", 6, 0)  -> the new tiles, nothing overlapping
//
// Everything here returns new arrays; nothing mutates its input.

(function (root) {
  "use strict";

  var COLS = 12;
  var MAX_ROWS = 400;     // far more than a page needs; a bound so a bad value cannot make the grid huge
  var MAX_TILES = 16;     // the profile accepts no more (cloudflare-worker/src/prefs.js)

  // The tiles the Overview can host. w and h are the starting size (h in rows); min/max keep a tile big
  // enough to be useful and small enough to leave room for the rest. ownerOnly tiles show the owner's own data.
  var CATALOGUE = [
    { id: "need",    title: "Waiting on you",          about: "What on the Ops board needs a decision or a step from you.",  w: 6,  h: 8, minW: 4, minH: 4, maxW: 12, maxH: 30 },
    { id: "feed",    title: "Since you last looked",   about: "The latest changes on the Ops board.",                        w: 6,  h: 8, minW: 4, minH: 4, maxW: 12, maxH: 30 },
    { id: "flight",  title: "In progress and soaking", about: "Work under way and work being watched.",                     w: 3,  h: 7, minW: 3, minH: 4, maxW: 12, maxH: 30 },
    { id: "market",  title: "Nasdaq-100",              about: "The live Nasdaq-100 price.",                                  w: 3,  h: 3, minW: 2, minH: 2, maxW: 6,  maxH: 8 },
    { id: "weather", title: "Weather",                 about: "Today and the week ahead, near you (only asks when you do).", w: 3,  h: 5, minW: 3, minH: 4, maxW: 12, maxH: 14 },
    { id: "week",    title: "This week",               about: "Your calendar for the week.",                                 w: 3,  h: 5, minW: 3, minH: 4, maxW: 12, maxH: 14, ownerOnly: true },
    { id: "todo",    title: "To-do",                   about: "Your to-do list.",                                            w: 3,  h: 6, minW: 3, minH: 4, maxW: 12, maxH: 30 },
    { id: "links",   title: "Shortcuts",               about: "Your quick links.",                                           w: 12, h: 3, minW: 4, minH: 2, maxW: 12, maxH: 8,  ownerOnly: true }
  ];

  function spec(id) {
    for (var i = 0; i < CATALOGUE.length; i++) if (CATALOGUE[i].id === id) return CATALOGUE[i];
    return null;
  }

  function isInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }
  function between(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
  function copy(t) { return { id: t.id, x: t.x, y: t.y, w: t.w, h: t.h }; }
  function copyAll(tiles) { return tiles.map(copy); }

  // The tile with its size and place forced inside what its spec and the grid allow (cols = the grid's width).
  function clampTile(t, cols) {
    var s = spec(t.id) || { minW: 1, minH: 1, maxW: cols, maxH: 40 };
    var limit = cols || COLS;
    var w = between(isInt(t.w) ? t.w : s.minW, Math.min(s.minW, limit), Math.min(s.maxW, limit));
    var h = between(isInt(t.h) ? t.h : s.minH, s.minH, s.maxH);
    var x = between(isInt(t.x) ? t.x : 0, 0, limit - w);
    var y = between(isInt(t.y) ? t.y : 0, 0, MAX_ROWS - h);
    return { id: t.id, x: x, y: y, w: w, h: h };
  }

  function overlaps(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

  // The lowest row at which a w-by-h tile at column x fits among `placed` without touching any of them.
  function lowestFree(placed, x, w, h) {
    var y = 0;
    for (;;) {
      var next = -1;
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i];
        if (x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h) {
          var bottom = p.y + p.h;
          if (next < 0 || bottom < next) next = bottom;
        }
      }
      if (next < 0) return y;
      y = next;
    }
  }

  function byPlace(a, b) { return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  // Settles the layout: the anchor (if any) keeps exactly the place it was given, every other tile, taken in
  // reading order, goes to the highest row where it fits among the tiles already settled. With no anchor this
  // is plain compaction. Deterministic: ties are broken by column, then by id.
  function settle(tiles, anchorId, cols) {
    var limit = cols || COLS;
    var clamped = tiles.map(function (t) { return clampTile(t, limit); });
    var placed = [];
    var anchor = null;
    if (anchorId) {
      for (var i = 0; i < clamped.length; i++) if (clamped[i].id === anchorId) anchor = clamped[i];
      if (anchor) placed.push(anchor);
    }
    clamped.filter(function (t) { return t !== anchor; }).sort(byPlace).forEach(function (t) {
      var y = lowestFree(placed, t.x, t.w, t.h);
      placed.push({ id: t.id, x: t.x, y: y, w: t.w, h: t.h });
    });
    return placed.sort(byPlace);
  }

  function compact(tiles, cols) { return settle(tiles, null, cols); }

  // ---- reading the saved geometry ---------------------------------------------------------------

  // A saved board ({v:1, tiles:[...]}) -> the tiles it describes, checked and settled; null when it is not a
  // usable board. Unknown ids, repeats and malformed entries are dropped; sizes are forced inside the spec.
  function normalizeBoard(raw) {
    if (!raw || typeof raw !== "object" || raw.v !== 1 || !Array.isArray(raw.tiles)) return null;
    var seen = {}, out = [];
    for (var i = 0; i < raw.tiles.length && out.length < MAX_TILES; i++) {
      var t = raw.tiles[i];
      if (!t || typeof t !== "object" || typeof t.id !== "string" || !spec(t.id) || seen[t.id]) continue;
      if (!isInt(t.x) || !isInt(t.y) || !isInt(t.w) || !isInt(t.h)) continue;
      seen[t.id] = true;
      out.push(clampTile(t, COLS));
    }
    return out.length ? compact(out) : null;
  }

  // The tiles as they are saved.
  function toBoard(tiles) {
    return { v: 1, tiles: tiles.slice().sort(byPlace).map(copy) };
  }

  // ---- the layout nobody has customised ---------------------------------------------------------------

  var SIZE_COLS = { 1: 3, 2: 6, 4: 12 };

  // The arrangement the page always had: the shown widgets in their list order, each as wide as its size
  // says (1 = a quarter, 2 = a half, 4 = the whole row), one after another, wrapping when the next does not fit.
  // `shown(entry)` says whether a list entry is on the page (visible and allowed for this viewer).
  // The rows are kept aligned, as the page's grid always did, so this is not compacted: a shorter tile can leave
  // a gap under it, and reading order is exactly the list's order. The first change in Customise tidies it.
  function fromWidgets(list, shown) {
    var tiles = [], cx = 0, y = 0, rowH = 0;
    (list || []).forEach(function (e) {
      if (!e || !spec(e.id) || (shown && !shown(e))) return;
      var s = spec(e.id), w = between(SIZE_COLS[e.size] || SIZE_COLS[1], Math.min(s.minW, COLS), Math.min(s.maxW, COLS)), h = s.h;
      if (cx + w > COLS) { cx = 0; y += rowH; rowH = 0; }
      tiles.push({ id: e.id, x: cx, y: y, w: w, h: h });
      cx += w; if (h > rowH) rowH = h;
    });
    return tiles.sort(byPlace);
  }

  // The layout to show: the saved geometry for the tiles that are shown, any shown tile it does not know
  // placed in the first free space, anything hidden or unknown left out.
  function effective(board, list, shown) {
    var saved = normalizeBoard(board);
    var visible = (list || []).filter(function (e) { return e && spec(e.id) && (!shown || shown(e)); });
    if (!saved) return fromWidgets(list, shown);
    var want = {};
    visible.forEach(function (e) { want[e.id] = true; });
    var tiles = saved.filter(function (t) { return want[t.id]; });
    var have = {};
    tiles.forEach(function (t) { have[t.id] = true; });
    visible.forEach(function (e) { if (!have[e.id]) { tiles = add(tiles, e.id); have[e.id] = true; } });
    return compact(tiles);
  }

  // The widgets list that matches a layout, so the Home layout tab and the presets agree with the board:
  // shown tiles first in reading order with the width nearest their size, then the hidden ones in the order
  // they already had.
  function toWidgets(tiles, list) {
    var byId = {};
    (list || []).forEach(function (e) { byId[e.id] = e; });
    var out = [], used = {};
    tiles.slice().sort(byPlace).forEach(function (t) {
      used[t.id] = true;
      out.push({ id: t.id, visible: true, size: t.w <= 4 ? 1 : t.w <= 8 ? 2 : 4 });
    });
    (list || []).forEach(function (e) { if (e && !used[e.id]) out.push({ id: e.id, visible: false, size: e.size }); });
    return out;
  }

  // ---- changing a layout --------------------------------------------------------------------------

  function find(tiles, id) {
    for (var i = 0; i < tiles.length; i++) if (tiles[i].id === id) return tiles[i];
    return null;
  }

  // Puts the tile at column x, row y (forced onto the grid); the others flow around it.
  function move(tiles, id, x, y) {
    if (!find(tiles, id)) return copyAll(tiles);
    return settle(tiles.map(function (t) { return t.id === id ? { id: t.id, x: x, y: y, w: t.w, h: t.h } : t; }), id);
  }

  // Gives the tile a new size (forced inside its limits and the grid); it keeps its corner and the others flow around it.
  function resize(tiles, id, w, h) {
    if (!find(tiles, id)) return copyAll(tiles);
    return settle(tiles.map(function (t) { return t.id === id ? { id: t.id, x: t.x, y: t.y, w: w, h: h } : t; }), id);
  }

  // Moves by whole steps (the arrow keys): dx columns, dy rows.
  function nudge(tiles, id, dx, dy) {
    var t = find(tiles, id);
    return t ? move(tiles, id, t.x + dx, t.y + dy) : copyAll(tiles);
  }

  // Resizes by whole steps (Shift + arrow): dw columns, dh rows.
  function grow(tiles, id, dw, dh) {
    var t = find(tiles, id);
    return t ? resize(tiles, id, t.w + dw, t.h + dh) : copyAll(tiles);
  }

  function remove(tiles, id) {
    return compact(tiles.filter(function (t) { return t.id !== id; }));
  }

  // Adds a tile at its starting size in the first free space (reading order). A tile already there is left alone.
  function add(tiles, id) {
    var s = spec(id);
    if (!s || find(tiles, id)) return copyAll(tiles);
    var placed = compact(tiles), w = Math.min(s.w, COLS), h = s.h;
    for (var y = 0; y < MAX_ROWS - h; y++) {
      for (var x = 0; x + w <= COLS; x++) {
        var probe = { id: id, x: x, y: y, w: w, h: h }, clash = false;
        for (var i = 0; i < placed.length; i++) if (overlaps(probe, placed[i])) { clash = true; break; }
        if (!clash) return compact(placed.concat([probe]));
      }
    }
    return placed;
  }

  // Sets the tile's height to fit `rows` rows of content (forced inside its limits).
  function fit(tiles, id, rows) {
    var t = find(tiles, id);
    return t ? resize(tiles, id, t.w, rows) : copyAll(tiles);
  }

  // Moves the tile one place earlier (dir -1) or later (dir 1) in reading order by repacking the layout row by
  // row from that order (the single-column list on a phone edits the layout this way).
  function reorder(tiles, id, dir) {
    var order = tiles.slice().sort(byPlace), at = -1, i;
    for (i = 0; i < order.length; i++) if (order[i].id === id) at = i;
    var to = at + dir;
    if (at < 0 || to < 0 || to >= order.length) return copyAll(tiles);
    var moved = order.splice(at, 1)[0];
    order.splice(to, 0, moved);
    var cx = 0, y = 0, rowH = 0, out = [];
    order.forEach(function (t) {
      if (cx + t.w > COLS) { cx = 0; y += rowH; rowH = 0; }
      out.push({ id: t.id, x: cx, y: y, w: t.w, h: t.h });
      cx += t.w; if (t.h > rowH) rowH = t.h;
    });
    return compact(out);
  }

  // ---- smaller screens ----------------------------------------------------------------------------

  // The same layout on a grid of `cols` columns (12, 6 or 1): the 12-column layout halved for 6, stacked in
  // reading order for 1. Not saved; worked out again whenever the width changes.
  function toColumns(tiles, cols) {
    if (cols >= COLS) return compact(tiles);
    var ordered = tiles.slice().sort(byPlace);
    if (cols <= 1) {
      var y = 0;
      return ordered.map(function (t) { var out = { id: t.id, x: 0, y: y, w: 1, h: t.h }; y += t.h; return out; });
    }
    var f = COLS / cols;
    return settle(ordered.map(function (t) {
      var w = between(Math.ceil(t.w / f), 1, cols);
      return { id: t.id, x: between(Math.floor(t.x / f), 0, cols - w), y: t.y, w: w, h: t.h };
    }), null, cols);
  }

  // The tile ids in reading order (top to bottom, left to right).
  function readingOrder(tiles) { return tiles.slice().sort(byPlace).map(function (t) { return t.id; }); }

  // For announcements and labels: "column 2, row 1, 3 wide, 5 tall".
  function describe(tile) {
    return "column " + (tile.x + 1) + ", row " + (tile.y + 1) + ", " + tile.w + " wide, " + tile.h + " tall";
  }

  var api = {
    COLS: COLS, MAX_ROWS: MAX_ROWS, MAX_TILES: MAX_TILES, CATALOGUE: CATALOGUE, spec: spec,
    clampTile: clampTile, overlaps: overlaps, lowestFree: lowestFree, settle: settle, compact: compact,
    normalizeBoard: normalizeBoard, toBoard: toBoard, fromWidgets: fromWidgets, effective: effective, toWidgets: toWidgets,
    move: move, resize: resize, nudge: nudge, grow: grow, remove: remove, add: add, fit: fit, reorder: reorder,
    toColumns: toColumns, readingOrder: readingOrder, describe: describe, find: find
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardBoard = api;
})(typeof window !== "undefined" ? window : this);
