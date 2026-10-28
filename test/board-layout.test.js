// Coverage for the Overview board's layout engine (board-layout.js): the rules every layout must keep
// (nothing overlaps, everything is on the grid and inside its size limits), the layout nobody has customised
// (it reproduces the page's arrangement), moving, resizing and hiding, the narrow-screen layouts, and what is
// saved. The random tests run thousands of moves from a fixed seed, so a failure is the same failure every time.
//
//   node test/board-layout.test.js

var assert = require("assert");
var path = require("path");
var B = require(path.join(__dirname, "..", "board-layout.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var DEFAULT_LIST = [
  { id: "need", visible: true, size: 2 }, { id: "feed", visible: true, size: 2 }, { id: "flight", visible: true, size: 1 }, { id: "market", visible: true, size: 1 },
  { id: "weather", visible: true, size: 1 }, { id: "week", visible: true, size: 1 }, { id: "todo", visible: true, size: 1 }, { id: "links", visible: true, size: 4 }
];
function box(t) { return t.id + "@" + t.x + "," + t.y + " " + t.w + "x" + t.h; }
function boxes(tiles) { return tiles.map(box).join(" | "); }
function t(id, x, y, w, h) { return { id: id, x: x, y: y, w: w, h: h }; }

// The rules every layout must keep, with `cols` columns.
function assertValid(tiles, cols, label) {
  var seen = {};
  tiles.forEach(function (a, i) {
    var s = B.spec(a.id);
    var where = (label || "layout") + ": " + box(a);
    assert.ok(Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.w) && Number.isInteger(a.h), "whole numbers: " + where);
    assert.ok(a.x >= 0 && a.y >= 0 && a.w >= 1 && a.h >= 1, "positive: " + where);
    assert.ok(a.x + a.w <= cols, "inside the columns: " + where);
    if (cols === B.COLS) {
      assert.ok(a.w >= s.minW && a.w <= s.maxW && a.h >= s.minH && a.h <= s.maxH, "inside its size limits: " + where);
    }
    assert.ok(!seen[a.id], "each tile once: " + where); seen[a.id] = true;
    for (var j = i + 1; j < tiles.length; j++) assert.ok(!B.overlaps(a, tiles[j]), "no overlap: " + where + " vs " + box(tiles[j]));
  });
}
// Every tile floats as high as it can: moving any one up a row would make it touch another or leave the top.
function isCompact(tiles) {
  return tiles.every(function (a) {
    if (a.y === 0) return true;
    var up = { id: a.id, x: a.x, y: a.y - 1, w: a.w, h: a.h };
    return tiles.some(function (b) { return b !== a && B.overlaps(up, b); });
  });
}
function assertCompact(tiles, cols, label) {
  assert.ok(isCompact(tiles), (label || "layout") + ": a tile could still move up: " + boxes(tiles));
}

// A small seeded random generator (mulberry32), so the random tests repeat.
function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var r = Math.imul(seed ^ seed >>> 15, 1 | seed); r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r; return ((r ^ r >>> 14) >>> 0) / 4294967296; }; }

test("the catalogue lists the eight Overview widgets, each with sensible limits", function () {
  assert.deepStrictEqual(B.CATALOGUE.map(function (s) { return s.id; }), ["need", "feed", "flight", "market", "weather", "week", "todo", "links"]);
  B.CATALOGUE.forEach(function (s) {
    assert.ok(s.title && s.about, s.id + " has a name and a description");
    assert.ok(s.minW <= s.w && s.w <= s.maxW && s.minH <= s.h && s.h <= s.maxH && s.maxW <= B.COLS, s.id + " starts inside its own limits");
  });
  assert.deepStrictEqual(B.CATALOGUE.filter(function (s) { return s.ownerOnly; }).map(function (s) { return s.id; }), ["week", "links"], "the owner-only tiles match the page");
});

test("an uncustomised viewer gets the page's arrangement: tiles in order, wrapping when the next does not fit", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  assertValid(tiles, 12, "default"); assertCompact(tiles, 12, "default");
  assert.strictEqual(boxes(tiles), [
    "need@0,0 6x8", "feed@6,0 6x8",
    "flight@0,8 3x7", "market@3,8 3x4", "weather@6,8 3x5", "week@9,8 3x5",
    "todo@0,15 3x6", "links@0,21 12x3"
  ].join(" | "), "same order, same widths");
  assert.deepStrictEqual(B.readingOrder(tiles), DEFAULT_LIST.map(function (e) { return e.id; }), "reading order is the list's order");
});

test("the Planner preset keeps its list order too, even where compacting would reorder it", function () {
  var planner = [["need", 2], ["week", 2], ["todo", 2], ["feed", 2], ["flight", 2], ["weather", 2], ["links", 4]].map(function (r) { return { id: r[0], visible: true, size: r[1] }; });
  var tiles = B.fromWidgets(planner);
  assertValid(tiles, 12, "planner");
  assert.deepStrictEqual(B.readingOrder(tiles), planner.map(function (e) { return e.id; }));
  var tidy = B.compact(tiles);
  assertValid(tidy, 12, "planner tidied"); assertCompact(tidy, 12, "planner tidied");
});

test("a size 4 widget takes the whole row and the next one starts below the tallest in the row above", function () {
  var tiles = B.fromWidgets([{ id: "links", visible: true, size: 4 }, { id: "need", visible: true, size: 2 }, { id: "feed", visible: true, size: 2 }]);
  assert.strictEqual(boxes(tiles), "links@0,0 12x3 | need@0,3 6x8 | feed@6,3 6x8");
});

test("hidden or not-allowed widgets are left out of the default layout", function () {
  var list = DEFAULT_LIST.map(function (e) { return e.id === "market" ? { id: e.id, visible: false, size: e.size } : e; });
  var tiles = B.fromWidgets(list, function (e) { return e.visible && e.id !== "week"; });
  assert.deepStrictEqual(B.readingOrder(tiles).sort(), ["feed", "flight", "links", "need", "todo", "weather"]);
  assertValid(tiles, 12);
});

test("moving a tile puts it where it was dropped and the others flow around it", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var moved = B.move(tiles, "todo", 0, 0);
  assertValid(moved, 12, "after move");
  var todo = B.find(moved, "todo");
  assert.strictEqual(todo.x + "," + todo.y, "0,0", "it is exactly where it was dropped");
  moved.forEach(function (o) { if (o.id !== "todo") assert.ok(!B.overlaps(todo, o), o.id + " flowed out of its way"); });
  assert.strictEqual(B.find(moved, "need").y >= 6, true, "what was in the way was pushed down, not over it");
});

test("a tile dragged off the grid is brought back onto it", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var m = B.move(tiles, "need", 99, -5);
  assertValid(m, 12, "off the grid");
  var n = B.find(m, "need");
  assert.ok(n.x + n.w <= 12 && n.y >= 0);
});

test("resizing keeps the tile's corner, snaps to its limits and moves the others out of the way", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var wide = B.resize(tiles, "flight", 9, 7);
  assertValid(wide, 12, "wide");
  assert.strictEqual(B.find(wide, "flight").w, 9);
  var tiny = B.resize(tiles, "market", 1, 1);
  assert.strictEqual(B.find(tiny, "market").w, B.spec("market").minW, "no narrower than its minimum");
  assert.strictEqual(B.find(tiny, "market").h, B.spec("market").minH, "no shorter than its minimum");
  var huge = B.resize(tiles, "market", 12, 40);
  assert.strictEqual(B.find(huge, "market").w, B.spec("market").maxW, "no wider than its maximum");
  assert.strictEqual(B.find(huge, "market").h, B.spec("market").maxH, "no taller than its maximum");
  assertValid(huge, 12, "huge");
});

test("keyboard steps move by one column or row and grow by one", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var a = B.find(tiles, "feed");
  var right = B.nudge(tiles, "feed", 1, 0);
  assert.strictEqual(B.find(right, "feed").x, Math.min(a.x + 1, 12 - a.w), "one column right, stopped by the edge");
  var left = B.nudge(tiles, "feed", -1, 0);
  assert.strictEqual(B.find(left, "feed").x, a.x - 1);
  var taller = B.grow(tiles, "todo", 0, 1);
  assert.strictEqual(B.find(taller, "todo").h, B.find(tiles, "todo").h + 1);
  assertValid(right, 12); assertValid(left, 12); assertValid(taller, 12);
});

test("a hidden tile leaves a gap that closes; a shown one goes in the first free space", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var without = B.remove(tiles, "need");
  assertValid(without, 12, "removed"); assertCompact(without, 12, "removed");
  assert.strictEqual(B.find(without, "need"), null);
  var back = B.add(without, "need");
  assertValid(back, 12, "added"); assertCompact(back, 12, "added");
  assert.ok(B.find(back, "need"), "it is back");
  assert.strictEqual(B.add(back, "need").length, back.length, "adding what is there changes nothing");
  assert.strictEqual(B.add(back, "Not A Tile!").length, back.length, "an unknown tile is ignored");
});

test("fitting a tile to its content sets its height inside its limits", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  assert.strictEqual(B.find(B.fit(tiles, "todo", 12), "todo").h, 12);
  assert.strictEqual(B.find(B.fit(tiles, "todo", 1), "todo").h, B.spec("todo").minH);
});

test("reordering repacks the layout from the new reading order", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var down = B.reorder(tiles, "need", 1);
  assertValid(down, 12, "reordered");
  assert.deepStrictEqual(B.readingOrder(down).slice(0, 2), ["feed", "need"]);
  assert.strictEqual(B.readingOrder(B.reorder(tiles, "need", -1))[0], "need", "the first cannot go earlier");
  assert.strictEqual(B.readingOrder(B.reorder(tiles, "links", 1)).pop(), "links", "the last cannot go later");
});

test("smaller screens: 6 columns halves the layout, 1 column stacks it in reading order", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST);
  var six = B.toColumns(tiles, 6);
  assertValid(six, 6, "six columns");
  assert.strictEqual(six.length, tiles.length);
  var one = B.toColumns(tiles, 1);
  assertValid(one, 1, "one column");
  assert.deepStrictEqual(B.readingOrder(one), B.readingOrder(tiles), "the same order, stacked");
  assert.deepStrictEqual(one.map(function (x) { return x.x; }), one.map(function () { return 0; }));
  assert.strictEqual(one[1].y, one[0].h, "each starts where the one above ends");
  assert.strictEqual(boxes(B.toColumns(tiles, 12)), boxes(tiles), "12 columns is the layout itself");
});

test("a saved board is checked: unknown tiles, repeats, bad numbers and bad shapes are dropped, sizes are forced inside the limits", function () {
  assert.strictEqual(B.normalizeBoard(null), null);
  assert.strictEqual(B.normalizeBoard({ v: 2, tiles: [] }), null);
  assert.strictEqual(B.normalizeBoard({ v: 1, tiles: "no" }), null);
  assert.strictEqual(B.normalizeBoard({ v: 1, tiles: [] }), null, "nothing usable");
  var n = B.normalizeBoard({ v: 1, tiles: [
    { id: "need", x: 0, y: 0, w: 99, h: 99 }, { id: "need", x: 1, y: 1, w: 3, h: 3 }, { id: "Not A Tile!", x: 0, y: 0, w: 1, h: 1 },
    { id: "feed", x: "a", y: 0, w: 6, h: 6 }, null, { id: "todo", x: 11, y: 0, w: 3, h: 6 }
  ] });
  assertValid(n, 12, "normalised");
  assert.deepStrictEqual(B.readingOrder(n).sort(), ["need", "todo"], "only the usable ones, each once");
  assert.strictEqual(B.find(n, "need").w, B.spec("need").maxW, "forced inside the limits");
});

test("a board round-trips through what is saved", function () {
  var tiles = B.move(B.fromWidgets(DEFAULT_LIST), "todo", 3, 0);
  var saved = JSON.parse(JSON.stringify(B.toBoard(tiles)));
  assert.strictEqual(saved.v, 1);
  assert.strictEqual(boxes(B.normalizeBoard(saved)), boxes(tiles));
  assert.ok(JSON.stringify(saved).length < 1200, "a full board is far below the profile's size cap");
});

test("the layout to show: saved places for shown tiles, new tiles in free space, hidden tiles gone", function () {
  var base = B.fromWidgets(DEFAULT_LIST);
  var board = B.toBoard(B.remove(base, "weather"));            // saved before "weather" existed
  var eff = B.effective(board, DEFAULT_LIST);
  assertValid(eff, 12, "effective"); assertCompact(eff, 12, "effective");
  assert.ok(B.find(eff, "weather"), "the tile the saved board did not know is placed");
  var hiddenList = DEFAULT_LIST.map(function (e) { return e.id === "todo" ? { id: e.id, visible: false, size: e.size } : e; });
  var eff2 = B.effective(B.toBoard(base), hiddenList, function (e) { return e.visible; });
  assert.strictEqual(B.find(eff2, "todo"), null, "a hidden tile is not shown");
  assertValid(eff2, 12);
  assert.strictEqual(boxes(B.effective(null, DEFAULT_LIST)), boxes(B.fromWidgets(DEFAULT_LIST)), "no saved board: the default");
  assert.strictEqual(boxes(B.effective({ junk: 1 }, DEFAULT_LIST)), boxes(B.fromWidgets(DEFAULT_LIST)), "a bad saved board: the default");
});

test("a tile a page registers itself (not in the widgets list) shows only when the saved board has it, and never goes into the list", function () {
  var base = B.fromWidgets(DEFAULT_LIST);
  var withExtra = B.add(base, "side-tile");
  var board = B.toBoard(withExtra);
  assert.strictEqual(B.find(B.effective(board, DEFAULT_LIST), "side-tile"), null, "not shown unless the page allows it");
  var eff = B.effective(board, DEFAULT_LIST, null, ["side-tile"]);
  assert.ok(B.find(eff, "side-tile"), "shown when allowed and saved");
  assertValid(eff, 12, "with the extra tile");
  assert.strictEqual(B.find(B.effective(B.toBoard(base), DEFAULT_LIST, null, ["side-tile"]), "side-tile"), null, "and it is never added by itself");
  assert.ok(!B.toWidgets(withExtra, DEFAULT_LIST).some(function (e) { return e.id === "side-tile"; }), "it is saved in the board only");
});

test("the widgets list that matches a layout: shown tiles in reading order, hidden ones after, widths mapped to 1, 2 or 4", function () {
  var tiles = B.move(B.fromWidgets(DEFAULT_LIST), "todo", 0, 0);
  var without = B.remove(tiles, "market");
  var list = B.toWidgets(without, DEFAULT_LIST);
  assert.strictEqual(list.length, DEFAULT_LIST.length, "every widget is still listed once");
  assert.strictEqual(list.filter(function (e) { return e.visible; }).length, without.length);
  assert.strictEqual(list[list.length - 1].id, "market", "the hidden one is last");
  assert.strictEqual(list[list.length - 1].visible, false);
  list.forEach(function (e) { assert.ok([1, 2, 4].indexOf(e.size) !== -1, "a width the Home layout tab knows"); });
  assert.deepStrictEqual(B.toWidgets([t("need", 0, 0, 6, 8), t("links", 0, 8, 12, 3), t("todo", 0, 11, 3, 6)], DEFAULT_LIST).slice(0, 3).map(function (e) { return e.id + ":" + e.size; }), ["need:2", "links:4", "todo:1"]);
});

test("the announcement text names the column, row and size, counting from one", function () {
  assert.strictEqual(B.describe(t("need", 0, 0, 6, 8)), "column 1, row 1, 6 wide, 8 tall");
  assert.strictEqual(B.describe(t("todo", 3, 4, 3, 6)), "column 4, row 5, 3 wide, 6 tall");
});

test("nothing is changed in place: every function returns new arrays and objects", function () {
  var tiles = B.fromWidgets(DEFAULT_LIST), before = JSON.stringify(tiles);
  B.move(tiles, "todo", 0, 0); B.resize(tiles, "todo", 6, 6); B.remove(tiles, "todo"); B.add(tiles, "todo"); B.reorder(tiles, "need", 1);
  B.toColumns(tiles, 6); B.toColumns(tiles, 1); B.compact(tiles); B.fit(tiles, "todo", 9); B.nudge(tiles, "todo", 1, 1); B.grow(tiles, "todo", 1, 1);
  assert.strictEqual(JSON.stringify(tiles), before);
});

// ---- random tests: thousands of operations, the rules checked after each --------------------------------

test("random moves, resizes, hides and shows never overlap, leave the grid, break a size limit or float", function () {
  var rand = rng(20261027), ids = B.CATALOGUE.map(function (s) { return s.id; });
  for (var run = 0; run < 60; run++) {
    var tiles = B.fromWidgets(DEFAULT_LIST);
    for (var step = 0; step < 120; step++) {
      var id = ids[Math.floor(rand() * ids.length)], op = Math.floor(rand() * 7), wasCompact = isCompact(tiles);
      if (op === 0) tiles = B.move(tiles, id, Math.floor(rand() * 16) - 2, Math.floor(rand() * 40) - 4);
      else if (op === 1) tiles = B.resize(tiles, id, Math.floor(rand() * 16) - 2, Math.floor(rand() * 40) - 4);
      else if (op === 2) tiles = B.nudge(tiles, id, Math.floor(rand() * 5) - 2, Math.floor(rand() * 5) - 2);
      else if (op === 3) tiles = B.grow(tiles, id, Math.floor(rand() * 5) - 2, Math.floor(rand() * 5) - 2);
      else if (op === 4) tiles = B.remove(tiles, id);
      else if (op === 5) tiles = B.add(tiles, id);
      else tiles = B.reorder(tiles, id, rand() < 0.5 ? -1 : 1);
      assertValid(tiles, 12, "run " + run + " step " + step);
      // removing always tidies; adding or reordering tidies whenever it changes anything (a no-op leaves a layout as it was)
      if (op === 4 || ((op === 5 || op === 6) && wasCompact)) assertCompact(tiles, 12, "run " + run + " step " + step);
    }
    assertValid(B.toColumns(tiles, 6), 6, "run " + run + " six columns");
    assertValid(B.toColumns(tiles, 1), 1, "run " + run + " one column");
    assert.strictEqual(boxes(B.compact(B.compact(tiles))), boxes(B.compact(tiles)), "compacting twice changes nothing");
  }
});

test("the same operations on the same layout always give the same result", function () {
  function play(seed) {
    var rand = rng(seed), tiles = B.fromWidgets(DEFAULT_LIST), ids = B.CATALOGUE.map(function (s) { return s.id; });
    for (var i = 0; i < 200; i++) {
      var id = ids[Math.floor(rand() * ids.length)];
      tiles = rand() < 0.5 ? B.move(tiles, id, Math.floor(rand() * 12), Math.floor(rand() * 30)) : B.resize(tiles, id, Math.floor(rand() * 12) + 1, Math.floor(rand() * 20) + 1);
      tiles = B.compact(tiles);
    }
    return boxes(tiles);
  }
  assert.strictEqual(play(7), play(7));
  assert.strictEqual(play(8), play(8));
  assert.notStrictEqual(play(7), play(8), "and different moves give different layouts");
});

test("a move to a place and then back is stable: dropping a tile where it already is changes nothing", function () {
  var tiles = B.compact(B.fromWidgets(DEFAULT_LIST));
  B.CATALOGUE.forEach(function (s) {
    var a = B.find(tiles, s.id);
    assert.strictEqual(boxes(B.compact(B.move(tiles, s.id, a.x, a.y))), boxes(tiles), "dropping " + s.id + " in place");
  });
});

// These two add to the catalogue, so they run last.
test("a tile the catalogue does not list still gets a middling size, so it never vanishes from the page", function () {
  var list = DEFAULT_LIST.concat([{ id: "brand-new", visible: true, size: 1 }]);
  var tiles = B.fromWidgets(list);
  var added = B.find(tiles, "brand-new");
  assert.ok(added, "it is on the board");
  assert.ok(added.w >= 2 && added.h >= 3);
  assertValid(B.compact(tiles), 12, "with a tile the catalogue has not heard of");
  assert.strictEqual(B.spec("Not A Tile!"), null, "but something that is not a tile id is still refused");
  assert.strictEqual(B.spec("brand-new").generic, true);
});

test("a page can register its own tile, with its limits checked and forced inside the grid", function () {
  assert.strictEqual(B.register(null), null);
  assert.strictEqual(B.register({ id: "Bad Id" }), null);
  var r = B.register({ id: "backups", title: "Backups", about: "How the last backups went.", w: 99, h: 0, minW: 4, minH: 3, maxW: 99, maxH: 99, ownerOnly: true });
  assert.deepStrictEqual([r.w, r.h, r.minW, r.maxW, r.minH, r.maxH, r.ownerOnly], [12, 3, 4, 12, 3, 40, true]);
  assert.strictEqual(B.spec("backups").title, "Backups");
  assert.ok(B.CATALOGUE.some(function (c) { return c.id === "backups"; }), "it is in the catalogue");
  var again = B.register({ id: "backups", title: "Backups (new)", w: 4, h: 4 });
  assert.strictEqual(B.CATALOGUE.filter(function (c) { return c.id === "backups"; }).length, 1, "registering again replaces it");
  assert.strictEqual(B.spec("backups").title, "Backups (new)");
  assert.ok(again.minW >= 1 && again.w >= again.minW);
  var tiles = B.add(B.fromWidgets(DEFAULT_LIST), "backups");
  assertValid(tiles, 12, "with the registered tile");
});

test("a registered tile may carry a permission id, kept only when it is a plain id", function () {
  assert.strictEqual(B.register({ id: "backups", permission: "backups.view" }).permission, "backups.view");
  assert.strictEqual(B.spec("backups").permission, "backups.view");
  assert.strictEqual(B.register({ id: "backups", permission: "Not Valid!" }).permission, undefined, "an odd value is dropped");
  assert.strictEqual(B.register({ id: "backups" }).permission, undefined, "and so is a missing one");
});


// ---- named layouts, one per kind of screen -----------------------------------------------------------------

var STD = [t("need", 0, 0, 6, 8), t("feed", 6, 0, 6, 8), t("todo", 0, 8, 3, 6)];
var ALT = [t("todo", 0, 0, 4, 6), t("need", 4, 0, 8, 8)];

test("deviceClass: wide from 1500, standard from 1000, small below; nonsense counts as standard", function () {
  assert.strictEqual(B.deviceClass(1920), "wide");
  assert.strictEqual(B.deviceClass(1500), "wide");
  assert.strictEqual(B.deviceClass(1499), "standard");
  assert.strictEqual(B.deviceClass(1000), "standard");
  assert.strictEqual(B.deviceClass(999), "compact");
  assert.strictEqual(B.deviceClass(0), "compact");
  assert.strictEqual(B.deviceClass(undefined), "standard");
  assert.strictEqual(B.deviceClass(NaN), "standard");
  assert.strictEqual(B.deviceTitle("wide"), "Wide screens");
});

test("a person with no saved layouts sees the standard arrangement on every screen", function () {
  var s = { board: { v: 1, tiles: STD }, widgets: DEFAULT_LIST, boardSets: null };
  ["wide", "standard", "compact"].forEach(function (c) {
    var r = B.settingsFor(s, c);
    assert.strictEqual(r.layout, null);
    assert.deepStrictEqual(r.board, s.board);
    assert.strictEqual(r.widgets, s.widgets);
  });
  assert.deepStrictEqual(B.settingsFor(null, "wide").widgets, []);
});

test("addLayout: a new layout is kept, named, picked for the screen it was saved on, and the input is not changed", function () {
  var r = B.addLayout(null, "  Big   monitor ", STD, "wide");
  assert.ok(!r.error);
  assert.strictEqual(r.id, "l1");
  assert.strictEqual(r.sets.layouts[0].name, "Big monitor");
  assert.deepStrictEqual(r.sets.pick, { wide: "l1", standard: null, compact: null });
  var again = B.addLayout(r.sets, "Phone", ALT, "compact");
  assert.strictEqual(again.id, "l2");
  assert.deepStrictEqual(again.sets.pick, { wide: "l1", standard: null, compact: "l2" });
  assert.strictEqual(r.sets.layouts.length, 1, "the earlier sets object was not changed");
});

test("addLayout: a blank or repeated name, a fifth layout, or an empty board is refused and nothing changes", function () {
  var sets = null;
  ["a", "b", "c", "d"].forEach(function (n) { sets = B.addLayout(sets, n, STD, null).sets; });
  assert.strictEqual(sets.layouts.length, 4);
  assert.strictEqual(B.addLayout(sets, "e", STD, null).error, "too_many");
  var one = B.addLayout(null, "One", STD, "wide").sets;
  assert.strictEqual(B.addLayout(one, "   ", STD, "wide").error, "name_required");
  assert.strictEqual(B.addLayout(one, "one", STD, "wide").error, "name_taken", "names are compared without regard to case");
  assert.strictEqual(B.addLayout(one, "Two", [], "wide").error, "no_tiles");
  assert.deepStrictEqual(B.addLayout(one, "one", STD, "wide").sets, one);
});

test("a screen that picked a layout draws it, with exactly its tiles shown; others keep the standard one", function () {
  var sets = B.addLayout(null, "Alt", ALT, "compact").sets;
  var s = { board: { v: 1, tiles: STD }, widgets: DEFAULT_LIST, boardSets: sets };
  var small = B.settingsFor(s, "compact");
  assert.strictEqual(small.layout.name, "Alt");
  assert.deepStrictEqual(small.board.tiles.map(function (x) { return x.id; }).sort(), ["need", "todo"]);
  var shownIds = small.widgets.filter(function (w) { return w.visible; }).map(function (w) { return w.id; }).sort();
  assert.deepStrictEqual(shownIds, ["need", "todo"], "a core tile the layout does not hold is hidden on that screen");
  assert.strictEqual(B.settingsFor(s, "wide").layout, null);
  assert.deepStrictEqual(B.settingsFor(s, "wide").board, s.board);
  var drawn = B.effective(small.board, small.widgets, function (e) { return e.visible; }, []);
  assert.deepStrictEqual(drawn.map(function (x) { return x.id; }).sort(), ["need", "todo"]);
  assertValid(drawn, 12, "named layout");
});

test("assignLayout: pick a layout or go back to the standard; an unknown layout or screen is refused", function () {
  var sets = B.addLayout(null, "Alt", ALT, "wide").sets;
  assert.strictEqual(B.assignLayout(sets, "standard", "l1").sets.pick.standard, "l1");
  assert.strictEqual(B.assignLayout(sets, "wide", null).sets.pick.wide, null);
  assert.strictEqual(B.assignLayout(sets, "wide", "l9").error, "not_found");
  assert.strictEqual(B.assignLayout(sets, "tv", "l1").error, "no_such_screen");
  assert.strictEqual(sets.pick.wide, "l1", "unchanged");
});

test("writeLayout and renameLayout change one layout; deleteLayout frees the screens that used it", function () {
  var a = B.addLayout(null, "Alt", ALT, "wide"), b = B.addLayout(a.sets, "Other", STD, "compact");
  var w = B.writeLayout(b.sets, "l1", STD);
  assert.deepStrictEqual(w.sets.layouts[0].tiles.map(function (x) { return x.id; }).sort(), ["feed", "need", "todo"]);
  assert.deepStrictEqual(w.sets.layouts[1].tiles, b.sets.layouts[1].tiles, "the other layout is untouched");
  assert.strictEqual(B.writeLayout(b.sets, "zz", STD).error, "not_found");
  var rn = B.renameLayout(b.sets, "l1", "Renamed");
  assert.strictEqual(rn.sets.layouts[0].name, "Renamed");
  assert.strictEqual(B.renameLayout(b.sets, "l1", "other").error, "name_taken");
  assert.strictEqual(B.renameLayout(b.sets, "l1", " ").error, "name_required");
  var del = B.deleteLayout(b.sets, "l1");
  assert.deepStrictEqual(del.sets.layouts.map(function (l) { return l.id; }), ["l2"]);
  assert.deepStrictEqual(del.sets.pick, { wide: null, standard: null, compact: "l2" });
  assert.strictEqual(B.deleteLayout(del.sets, "l2").sets, null, "no layouts left means no sets at all");
  assert.strictEqual(B.deleteLayout(b.sets, "nope").error, "not_found");
});

test("a freed id is reused, so the ids never run out", function () {
  var sets = B.addLayout(null, "a", STD, null).sets;
  sets = B.addLayout(sets, "b", STD, null).sets;
  sets = B.deleteLayout(sets, "l1").sets;
  var r = B.addLayout(sets, "c", STD, null);
  assert.strictEqual(r.id, "l1");
});

test("normalizeSets: junk becomes null, bad layouts and picks are dropped, names are cleaned, there are at most four", function () {
  [null, undefined, "x", 5, [], {}, { v: 2, layouts: [], pick: {} }, { v: 1, layouts: [], pick: {} }, { v: 1, layouts: "no" }].forEach(function (bad) {
    assert.strictEqual(B.normalizeSets(bad), null, JSON.stringify(bad));
  });
  var r = B.normalizeSets({ v: 1, layouts: [
    { id: "l1", name: "  <b>Desk</b>  ", tiles: STD }, { id: "l1", name: "Dup", tiles: STD }, { id: "L2", name: "Bad id", tiles: STD },
    { id: "l3", name: "", tiles: STD }, { id: "l4", name: "No tiles", tiles: [] }, { id: "l5", name: "x".repeat(60), tiles: ALT },
    { id: "l6", name: "Six", tiles: STD }, { id: "l7", name: "Seven", tiles: STD }, { id: "l8", name: "Eight", tiles: STD }
  ], pick: { wide: "l1", standard: "l9", compact: "l5", tv: "l1" } });
  assert.deepStrictEqual(r.layouts.map(function (l) { return l.id; }), ["l1", "l5", "l6", "l7"]);
  assert.strictEqual(r.layouts[0].name.indexOf("<"), -1);
  assert.strictEqual(r.layouts[1].name.length, B.NAME_MAX);
  assert.deepStrictEqual(r.pick, { wide: "l1", standard: null, compact: "l5" });
  r.layouts.forEach(function (l) { assertValid(l.tiles, 12, l.name); });
});


// ---- tiles that used to be fixed blocks (Quick capture, Running out soon): default-on tiles ---------------------------

test("a registered tile can be default-on, with an order, and defaultIds lists them in that order", function () {
  var a = B.register({ id: "qa-late", title: "Late", w: 12, h: 3, minH: 2, defaultOn: true, order: 7 });
  var b = B.register({ id: "qa-early", title: "Early", w: 12, h: 2, minH: 2, defaultOn: true, order: 2 });
  var plain = B.register({ id: "qa-plain", title: "Plain", w: 4, h: 4 });
  assert.strictEqual(a.defaultOn, true); assert.strictEqual(a.order, 7);
  assert.strictEqual(plain.defaultOn, undefined, "a tile that is not default-on carries no flag");
  var ids = B.defaultIds().filter(function (id) { return /^qa-/.test(id); });
  assert.deepStrictEqual(ids, ["qa-early", "qa-late"]);
  assert.strictEqual(B.register({ id: "qa-odd", defaultOn: true, order: 500 }).order, 99, "an order is kept inside 0 to 99");
  assert.strictEqual(B.register({ id: "qa-odd2", defaultOn: true }).order, 50, "and defaults to the middle");
  ["qa-late", "qa-early", "qa-plain", "qa-odd", "qa-odd2"].forEach(function (id) { B.CATALOGUE.splice(B.CATALOGUE.findIndex(function (c) { return c.id === id; }), 1); });
  assert.ok(b);
});

test("addAtTop puts the missing tiles at the top one under the other and moves nothing else relative to its neighbours", function () {
  B.register({ id: "qt-cap", title: "Capture", w: 12, h: 2, minH: 2, defaultOn: true, order: 0 });
  B.register({ id: "qt-exp", title: "Expiry", w: 12, h: 6, minH: 3, defaultOn: true, order: 1 });
  var saved = [t("need", 0, 0, 6, 8), t("feed", 6, 0, 6, 8), t("todo", 0, 8, 3, 6), t("flight", 3, 8, 3, 7)];
  var out = B.addAtTop(saved, ["qt-cap", "qt-exp"]);
  assertValid(out, 12, "with the two on top");
  assert.deepStrictEqual(out.slice(0, 2).map(box), ["qt-cap@0,0 12x2", "qt-exp@0,2 12x6"]);
  var before = B.compact(saved);
  before.forEach(function (o) {
    var n = B.find(out, o.id);
    assert.strictEqual(n.x, o.x, o.id + " keeps its column");
    assert.strictEqual(n.y, o.y + 8, o.id + " moves down by exactly the room the two take");
    assert.strictEqual(n.w + "x" + n.h, o.w + "x" + o.h, o.id + " keeps its size");
  });
  assert.deepStrictEqual(B.addAtTop(out, ["qt-cap", "qt-exp"]), out, "tiles already there stay exactly where they are");
  var one = B.addAtTop([t("qt-exp", 0, 0, 12, 6), t("need", 0, 6, 6, 8)], ["qt-cap", "qt-exp"]);
  assert.strictEqual(B.find(one, "qt-cap").y, 0, "only the missing one is added, at the top");
  assert.strictEqual(B.find(one, "qt-exp").y, 2, "and the one already there flows down under it");
  assertValid(one, 12, "one present");
  assert.deepStrictEqual(B.addAtTop(saved, ["not-a-tile!"]).map(box), B.compact(saved).map(box), "an unknown id adds nothing");
  assert.deepStrictEqual(B.addAtTop([], ["qt-cap"]).map(box), ["qt-cap@0,0 12x2"], "an empty board");
  B.CATALOGUE.splice(B.CATALOGUE.findIndex(function (c) { return c.id === "qt-cap"; }), 1);
  B.CATALOGUE.splice(B.CATALOGUE.findIndex(function (c) { return c.id === "qt-exp"; }), 1);
});

test("the default arrangement of a person who never customised, with the default-on tiles on top, is valid and keeps the page's order below", function () {
  B.register({ id: "qd-cap", title: "Capture", w: 12, h: 2, minH: 2, defaultOn: true, order: 0 });
  B.register({ id: "qd-exp", title: "Expiry", w: 12, h: 6, minH: 3, defaultOn: true, order: 1 });
  var base = B.effective(null, DEFAULT_LIST, function () { return true; }, ["qd-cap", "qd-exp"]);
  var withTop = B.addAtTop(base, B.defaultIds().filter(function (id) { return /^qd-/.test(id); }));
  assertValid(withTop, 12, "default plus the two");
  assert.deepStrictEqual(B.readingOrder(withTop).slice(0, 3), ["qd-cap", "qd-exp", "need"]);
  assert.deepStrictEqual(B.readingOrder(withTop).slice(2), B.readingOrder(base), "everything below is in the order it always had");
  B.CATALOGUE.splice(B.CATALOGUE.findIndex(function (c) { return c.id === "qd-cap"; }), 1);
  B.CATALOGUE.splice(B.CATALOGUE.findIndex(function (c) { return c.id === "qd-exp"; }), 1);
});

console.log("\n" + passed + " passed");
