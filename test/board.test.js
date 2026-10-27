// Coverage for the Overview board's page code (board.js): the pure helpers (how wide the screen is, which grid
// cell a pointer is over, what a key means), the rules the files must keep (no innerHTML, no inline style
// attributes, scripts in the right order, the CSP), and the wiring in overview.js and index.html. The pointer,
// keyboard and layout behaviour itself was exercised in a real browser against the page: drag a tile, pull its
// corner, Space and the arrow keys, the options menu, the Tiles panel, Done / Cancel / Reset, and the 6-column
// and single-column layouts.
//
//   node test/board.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var board = require(path.join(root, "board.js"));
var L = require(path.join(root, "board-layout.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

test("the board is 12 columns wide from 960px, 6 from 560px, and one column below that", function () {
  assert.strictEqual(board.columnsFor(1400), 12);
  assert.strictEqual(board.columnsFor(960), 12);
  assert.strictEqual(board.columnsFor(959), 6);
  assert.strictEqual(board.columnsFor(560), 6);
  assert.strictEqual(board.columnsFor(559), 1);
  assert.strictEqual(board.columnsFor(320), 1);
});

test("a pointer is turned into the grid cell the tile's corner is nearest to, kept on the grid", function () {
  var steps = board.stepsFor(1200, 12, 36, 36, 12);      // a column and its gap = 103px, a row and its gap = 48px
  assert.strictEqual(Math.round(steps.stepX), 103);
  assert.strictEqual(steps.stepY, 48);
  assert.deepStrictEqual(board.cellAt(0, 0, steps, 12, 3), { x: 0, y: 0 });
  assert.deepStrictEqual(board.cellAt(160, 70, steps, 12, 3), { x: 2, y: 1 }, "nearest, not floor");
  assert.deepStrictEqual(board.cellAt(5000, 20, steps, 12, 3), { x: 9, y: 0 }, "a wide tile stops at the right edge");
  assert.deepStrictEqual(board.cellAt(-80, -80, steps, 12, 3), { x: 0, y: 0 }, "never off the top left");
  assert.strictEqual(board.cellAt(0, 5000, steps, 12, 3).y, Math.round(5000 / 48), "down is as far as the page goes");
});

test("dragging a corner changes the size by whole columns and rows", function () {
  var steps = board.stepsFor(1200, 12, 36, 36, 12);
  assert.deepStrictEqual(board.sizeFrom(6, 8, 0, 0, steps), { w: 6, h: 8 });
  assert.deepStrictEqual(board.sizeFrom(6, 8, 210, 100, steps), { w: 8, h: 10 });
  assert.deepStrictEqual(board.sizeFrom(6, 8, -210, -100, steps), { w: 4, h: 6 });
  assert.deepStrictEqual(board.sizeFrom(6, 8, 30, 20, steps), { w: 6, h: 8 }, "less than half a step does nothing");
});

test("a tile's content height becomes a whole number of rows", function () {
  assert.strictEqual(board.rowsFor(1, 36, 12), 1);
  assert.strictEqual(board.rowsFor(36, 36, 12), 1);
  assert.strictEqual(board.rowsFor(37, 36, 12), 2);
  assert.strictEqual(board.rowsFor(84, 36, 12), 2, "two rows are 84px tall");
  assert.strictEqual(board.rowsFor(85, 36, 12), 3);
  assert.strictEqual(board.rowsFor(372, 36, 12), 8);
});

test("keys on a tile's grip: Space or Enter picks up and drops, arrows move, Shift and arrows resize, Escape cancels", function () {
  assert.deepStrictEqual(board.keyIntent(" ", false, false), { type: "pick" });
  assert.deepStrictEqual(board.keyIntent("Enter", false, false), { type: "pick" });
  assert.deepStrictEqual(board.keyIntent(" ", false, true), { type: "drop" });
  assert.deepStrictEqual(board.keyIntent("Enter", false, true), { type: "drop" });
  assert.deepStrictEqual(board.keyIntent("Escape", false, true), { type: "cancel" });
  assert.strictEqual(board.keyIntent("Escape", false, false), null, "nothing to cancel");
  assert.deepStrictEqual(board.keyIntent("ArrowLeft", false, true), { type: "move", dx: -1, dy: 0 });
  assert.deepStrictEqual(board.keyIntent("ArrowDown", false, true), { type: "move", dx: 0, dy: 1 });
  assert.deepStrictEqual(board.keyIntent("ArrowRight", true, true), { type: "resize", dw: 1, dh: 0 });
  assert.deepStrictEqual(board.keyIntent("ArrowUp", true, true), { type: "resize", dw: 0, dh: -1 });
  assert.deepStrictEqual(board.keyIntent("ArrowRight", false, false), { type: "focus", dir: 1 }, "not picked up: arrows walk between tiles");
  assert.deepStrictEqual(board.keyIntent("ArrowUp", false, false), { type: "focus", dir: -1 });
  assert.strictEqual(board.keyIntent("a", false, true), null);
  assert.strictEqual(board.keyIntent("Tab", false, false), null, "Tab is left to the browser");
});

test("saving keeps the entries a guest cannot use exactly as they were", function () {
  var original = [{ id: "need", visible: true, size: 2 }, { id: "week", visible: false, size: 4 }, { id: "links", visible: true, size: 4 }];
  var next = [{ id: "need", visible: true, size: 1 }, { id: "week", visible: true, size: 1 }, { id: "links", visible: false, size: 1 }];
  var merged = board.mergeList(next, original, function (id) { return id === "week" || id === "links"; });
  assert.deepStrictEqual(merged, [{ id: "need", visible: true, size: 1 }, { id: "week", visible: false, size: 4 }, { id: "links", visible: true, size: 4 }]);
  assert.deepStrictEqual(board.mergeList(next, original, function () { return false; }), next, "nothing restricted: as given");
});

test("two layouts are the same when every tile has the same place and size, whatever order they come in", function () {
  var a = L.fromWidgets([{ id: "need", visible: true, size: 2 }, { id: "feed", visible: true, size: 2 }]);
  assert.strictEqual(board.sameTiles(a, a.slice().reverse()), true);
  assert.strictEqual(board.sameTiles(a, L.move(a, "feed", 0, 20)), false);
});

test("board.js builds everything with DOM calls: no innerHTML, no inline style attributes, no eval", function () {
  var js = read("board.js"), css = read("board.css");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "no HTML strings");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(js), "no style attribute");
  assert.ok(!/@import|url\(\s*["']?https?:/.test(css), "no remote CSS");
  assert.ok(!/<script|javascript:/i.test(js + css));
});

test("the page loads the layout engine before the board and the board before overview.js, and keeps its CSP", function () {
  var html = read("index.html");
  var order = ["board-layout.js", "board.js", "overview.js"].map(function (f) { return html.indexOf('src="' + f); });
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "scripts in order: " + order.join(","));
  assert.ok(/href="board\.css\?v=[0-9a-f]{8}"/.test(html), "the stylesheet is stamped");
  assert.ok(/Content-Security-Policy" content="default-src 'self'; connect-src[^"]*; style-src 'self'; script-src 'self'/.test(html), "CSP unchanged: no inline style or script");
  assert.ok(!/ style="/.test(html) && !/<style/.test(html), "no inline styles");
});

test("overview.js hands the layout to the board, and the Home layout tab starts the board over from its list", function () {
  var js = read("overview.js");
  assert.ok(/BarnyardBoardUI\.create\(/.test(js), "the board is created");
  assert.ok(/if \(board\) \{ board\.render\(\); return; \}/.test(js), "applyLayout defers to it");
  assert.ok(/if \(!board\) setupDrag\(\)/.test(js), "the old grips only when the board did not load");
  assert.ok((js.match(/board: null/g) || []).length >= 2, "the presets and the list edits both clear the saved geometry");
  assert.ok(!/Theme\.set\(\{ widgets: next \}\)/.test(js), "no list edit leaves a stale board behind");
});

test("every tile on the page is in the board's catalogue, and the owner-only ones match overview.js", function () {
  var html = read("index.html"), overview = require(path.join(root, "overview.js"));
  var onPage = (html.match(/data-w="([a-z0-9-]+)"/g) || []).map(function (m) { return m.slice(8, -1); });
  var known = L.CATALOGUE.map(function (c) { return c.id; });
  onPage.forEach(function (id) { assert.ok(known.indexOf(id) !== -1, id + " is in the catalogue"); });
  assert.deepStrictEqual(L.CATALOGUE.filter(function (c) { return c.ownerOnly; }).map(function (c) { return c.id; }).sort(), overview.OWNER_ONLY.slice().sort());
  L.CATALOGUE.forEach(function (c) { assert.strictEqual(overview.WIDGET_TITLE[c.id], c.title, c.id + " has the same name on the page and in the catalogue"); });
});

console.log("\n" + passed + " tests passed");
