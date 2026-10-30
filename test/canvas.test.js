// Coverage for the Canvas page's rules (canvas-logic.js: pan and zoom, shapes, arrows that stay attached, undo, live cards, wrapping,
// the SVG export) and for the page and menu entry around them (the page's security rules, the logic file loading first, the
// owner-only menu entry).
//
//   node test/canvas.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var L = require(path.join(root, "canvas-logic.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var seq = 0;
function rnd() { seq = (seq * 9301 + 49297) % 233280; return seq / 233280; }
function note(id, x, y, over) { return Object.assign({ id: id, type: "note", x: x, y: y, w: 100, h: 60, text: "n", color: "amber" }, over || {}); }
function arrow(id, from, to, over) { return Object.assign({ id: id, type: "arrow", from: from, to: to, text: "", style: "solid", head: true, color: "default" }, over || {}); }
function near(a, b, eps) { assert.ok(Math.abs(a - b) <= (eps || 0.001), a + " is not near " + b); }

// ---- the view -----------------------------------------------------------------------------------------------------

test("a point goes to the screen and back, and zooming keeps the point under the pointer where it is", function () {
  var v = { x: 40, y: -20, k: 1.5 };
  var p = { x: 123, y: 456 };
  var back = L.toWorld(v, L.toScreen(v, p));
  near(back.x, p.x); near(back.y, p.y);
  var screen = { x: 300, y: 200 };
  var under = L.toWorld(v, screen);
  var z = L.zoomAt(v, 1.8, screen);
  var after = L.toScreen(z, under);
  near(after.x, screen.x, 1); near(after.y, screen.y, 1);
  assert.ok(z.k > v.k);
});

test("zoom stays between 10% and 300%; panning moves the view and nothing else", function () {
  assert.strictEqual(L.zoomAt({ x: 0, y: 0, k: 1 }, 0.0001, { x: 0, y: 0 }).k, L.MIN_K);
  assert.strictEqual(L.zoomAt({ x: 0, y: 0, k: 1 }, 1000, { x: 0, y: 0 }).k, L.MAX_K);
  assert.deepStrictEqual(L.panBy({ x: 5, y: 6, k: 2 }, 10.4, -3), { x: 15, y: 3, k: 2 });
});

test("fitting a board shows all of it, never zoomed in past 1:1, and an empty board sits in the middle", function () {
  var items = [note("a00001", 0, 0), note("a00002", 2000, 1000)];
  var v = L.fitView(items, 800, 500, 40);
  assert.ok(v.k < 1);
  var tl = L.toScreen(v, { x: 0, y: 0 }), br = L.toScreen(v, { x: 2100, y: 1060 });
  assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= 800 && br.y <= 500, "the whole board is on screen");
  assert.strictEqual(L.fitView([note("a00001", 0, 0)], 2000, 2000, 40).k, 1, "a small board is not blown up");
  assert.deepStrictEqual(L.fitView([], 800, 600), { x: 400, y: 300, k: 1 });
});

test("a saved view that shows nothing of the board (saved on a big screen, opened on a phone) is spotted", function () {
  var items = [note("a00001", 0, 0), note("a00002", 600, 400)];
  assert.strictEqual(L.anyVisible(items, { x: 100, y: 100, k: 1 }, 800, 500), true);
  assert.strictEqual(L.anyVisible(items, { x: 5000, y: 100, k: 1 }, 800, 500), false, "scrolled far away");
  assert.strictEqual(L.anyVisible(items, { x: 790, y: 100, k: 1 }, 800, 500), false, "only a sliver at the edge");
  assert.strictEqual(L.anyVisible([], { x: 9999, y: 9999, k: 1 }, 800, 500), true, "an empty board has nothing to lose");
});

// ---- shapes and arrows ----------------------------------------------------------------------------------------------

test("a line toward a point leaves a box, an ellipse and a diamond at their own edge", function () {
  var rect = { type: "note", x: 0, y: 0, w: 100, h: 60 };
  var r = L.anchor(rect, { x: 500, y: 30 });
  near(r.x, 100); near(r.y, 30);
  var ell = { type: "shape", shape: "ellipse", x: 0, y: 0, w: 100, h: 60 };
  var e = L.anchor(ell, { x: 500, y: 30 });
  near(e.x, 100); near(e.y, 30);
  var diag = L.anchor(ell, { x: 100, y: 60 });
  assert.ok(diag.x < 100 && diag.y < 60, "an ellipse's corner is cut");
  var dia = { type: "shape", shape: "diamond", x: 0, y: 0, w: 100, h: 60 };
  var d = L.anchor(dia, { x: 50, y: 500 });
  near(d.x, 50); near(d.y, 60);
  var dd = L.anchor(dia, { x: 100, y: 60 });
  near(Math.abs(dd.x - 50) / 50 + Math.abs(dd.y - 30) / 30, 1, 0.001);
  assert.deepStrictEqual(L.anchor(rect, { x: 50, y: 30 }), { x: 50, y: 30 }, "from the middle to the middle is the middle");
});

test("an arrow joins the edges of its two items and follows them when they move; a free end stays put", function () {
  var items = [note("a00001", 0, 0), note("a00002", 300, 0), arrow("ar0001", { item: "a00001" }, { item: "a00002" })];
  var p = L.arrowPoints(items[2], L.byId(items));
  near(p.a.x, 100); near(p.b.x, 300);
  var moved = L.moveItem(items, "a00002", 100, 200);
  var q = L.arrowPoints(moved[2], L.byId(moved));
  near(q.b.x, 400); near(q.b.y, 205);   // the left edge of the item, now at (400, 200), on the line to the other one
  var free = arrow("ar0002", { x: 5, y: 6 }, { item: "a00002" });
  assert.deepStrictEqual(L.arrowPoints(free, L.byId(items)).a, { x: 5, y: 6 });
});

test("clicking picks the top-most item; a frame is only picked up by its title strip; a line is picked within a few pixels", function () {
  var items = [
    { id: "fr0001", type: "frame", x: 0, y: 0, w: 400, h: 300, text: "G", color: "default" },
    note("a00001", 50, 80), note("a00002", 70, 100),
    arrow("ar0001", { x: 0, y: 400 }, { x: 400, y: 400 })
  ];
  assert.strictEqual(L.hit(items, { x: 80, y: 110 }).id, "a00002", "later is on top");
  assert.strictEqual(L.hit(items, { x: 10, y: 10 }).id, "fr0001", "the frame's title strip");
  assert.strictEqual(L.hit(items, { x: 300, y: 250 }), null, "inside a frame but on nothing");
  assert.strictEqual(L.hit(items, { x: 200, y: 404 }).id, "ar0001");
  assert.strictEqual(L.hit(items, { x: 200, y: 430 }), null);
  assert.strictEqual(L.itemAt(items, { x: 200, y: 404 }), null, "an arrow end is never dropped on another arrow");
  assert.strictEqual(L.itemAt(items, { x: 60, y: 90 }).id, "a00001");
});

test("the box around a board includes its items and the free ends of its arrows", function () {
  assert.strictEqual(L.bounds([]), null);
  var b = L.bounds([note("a00001", 10, 20), arrow("ar0001", { x: -50, y: 0 }, { item: "a00001" })]);
  assert.strictEqual(b.x, -50);
  assert.strictEqual(b.y, 0);
  assert.ok(b.w >= 160 && b.h >= 80);
});

// ---- changing a board -----------------------------------------------------------------------------------------------

test("a new item is placed with its middle on the point, with its own colour and size, and an id of the Worker's shape", function () {
  var n = L.makeItem("note", { x: 200, y: 100 }, {}, rnd);
  assert.match(n.id, /^[a-z0-9]{8}$/);
  assert.deepStrictEqual([n.x, n.y, n.w, n.h, n.color], [110, 45, 180, 110, "amber"]);
  assert.strictEqual(L.makeItem("shape", { x: 0, y: 0 }, { shape: "diamond" }, rnd).shape, "diamond");
  assert.strictEqual(L.makeItem("text", { x: 0, y: 0 }, {}, rnd).size, "m");
  assert.strictEqual(L.makeItem("frame", { x: 0, y: 0 }, {}, rnd).text, "Group");
  var c = L.makeItem("card", { x: 0, y: 0 }, { ref: { kind: "ops", id: "it_abcd1234" }, label: "x".repeat(300) }, rnd);
  assert.strictEqual(c.label.length, L.LIMITS.label);
  assert.deepStrictEqual(c.ref, { kind: "ops", id: "it_abcd1234" });
  var a = L.makeArrow({ item: "a00001" }, { x: 1, y: 2 }, {}, rnd);
  assert.deepStrictEqual([a.type, a.style, a.head], ["arrow", "solid", true]);
});

test("a board holds 400 items and no more", function () {
  var items = [];
  for (var i = 0; i < L.LIMITS.items; i++) items.push(note("n" + String(i).padStart(5, "0"), 0, 0));
  var full = L.addItem(items, note("extra001", 0, 0));
  assert.strictEqual(full.ok, false);
  assert.strictEqual(full.error, "board_full");
  assert.strictEqual(L.duplicateItem(items, "n00000", rnd).error, "board_full");
  assert.strictEqual(L.addItem(items.slice(1), note("extra001", 0, 0)).ok, true);
});

test("changes return new lists and never touch the old one", function () {
  var items = [note("a00001", 0, 0), note("a00002", 200, 0)];
  var snap = JSON.stringify(items);
  L.patchItem(items, "a00001", { text: "changed", color: "red" });
  L.moveItem(items, "a00001", 50, 50);
  L.resizeItem(items, "a00001", 300, 300);
  L.removeItem(items, "a00001");
  L.toFront(items, "a00001"); L.toBack(items, "a00002");
  assert.strictEqual(JSON.stringify(items), snap);
  assert.strictEqual(L.patchItem(items, "a00001", { text: "changed" })[0].text, "changed");
});

test("moving a frame takes what sits inside it; moving an item moves only it; coordinates stay in range", function () {
  var items = [{ id: "fr0001", type: "frame", x: 0, y: 0, w: 300, h: 200, text: "G", color: "default" }, note("a00001", 50, 50), note("a00002", 600, 50)];
  var moved = L.moveItem(items, "fr0001", 10, 20);
  assert.deepStrictEqual([moved[0].x, moved[1].x, moved[1].y, moved[2].x], [10, 60, 70, 600]);
  var one = L.moveItem(items, "a00001", 5, 5);
  assert.deepStrictEqual([one[0].x, one[1].x], [0, 55]);
  assert.strictEqual(L.moveItem(items, "a00001", 1e9, 0)[1].x, L.LIMITS.coord);
  assert.strictEqual(L.moveItem(items, "nope0001", 5, 5), items, "an unknown id changes nothing");
});

test("resizing keeps a thing between 20 and 4000 wide and high", function () {
  var items = [note("a00001", 0, 0)];
  var r = L.resizeItem(items, "a00001", 5, 99999);
  assert.deepStrictEqual([r[0].w, r[0].h], [L.LIMITS.minSize, L.LIMITS.maxSize]);
});

test("deleting an item leaves its arrows behind as free arrows where they last met it", function () {
  var items = [note("a00001", 0, 0), note("a00002", 300, 0), arrow("ar0001", { item: "a00001" }, { item: "a00002" })];
  var after = L.removeItem(items, "a00001");
  assert.strictEqual(after.length, 2);
  var a = after[1];
  assert.deepStrictEqual([a.from.item, a.to.item], [undefined, "a00002"]);
  near(a.from.x, 100); near(a.from.y, 30);
  assert.strictEqual(L.removeItem(after, "ar0001").length, 1, "an arrow itself just goes");
});

test("front, back and duplicate", function () {
  var items = [note("a00001", 0, 0), note("a00002", 0, 0), note("a00003", 0, 0)];
  assert.deepStrictEqual(L.toFront(items, "a00001").map(function (i) { return i.id; }), ["a00002", "a00003", "a00001"]);
  assert.deepStrictEqual(L.toBack(items, "a00003").map(function (i) { return i.id; }), ["a00003", "a00001", "a00002"]);
  var d = L.duplicateItem(items, "a00002", rnd);
  assert.strictEqual(d.items.length, 4);
  var copy = d.items[3];
  assert.deepStrictEqual([copy.x, copy.y], [30, 30]);
  assert.notStrictEqual(copy.id, "a00002");
  var arrows = [note("a00001", 0, 0), note("a00002", 300, 0), arrow("ar0001", { item: "a00001" }, { item: "a00002" })];
  var da = L.duplicateItem(arrows, "ar0001", rnd).items[3];
  assert.ok(da.from.x !== undefined && da.from.item === undefined, "a copied arrow is a free arrow");
  assert.strictEqual(L.duplicateItem(items, "gone0001", rnd).ok, false);
});

// ---- undo -----------------------------------------------------------------------------------------------------------

test("undo and redo walk back and forward; a new change drops what was undone; the same state is not a step", function () {
  var h = new L.History();
  h.reset({ items: [] });
  assert.strictEqual(h.canUndo(), false);
  assert.strictEqual(h.push({ items: [1] }), true);
  assert.strictEqual(h.push({ items: [1] }), false, "no change, no step");
  h.push({ items: [1, 2] });
  assert.deepStrictEqual(h.undo(), { items: [1] });
  assert.deepStrictEqual(h.undo(), { items: [] });
  assert.strictEqual(h.undo(), null);
  assert.deepStrictEqual(h.redo(), { items: [1] });
  h.push({ items: [9] });
  assert.strictEqual(h.canRedo(), false);
  assert.strictEqual(h.redo(), null);
});

test("undo keeps the newest hundred steps", function () {
  var h = new L.History(100);
  h.reset({ n: 0 });
  for (var i = 1; i <= 250; i++) h.push({ n: i });
  assert.strictEqual(h.past.length, 100);
  var steps = 0;
  while (h.undo()) steps++;
  assert.strictEqual(steps, 100);
});

// ---- live cards -----------------------------------------------------------------------------------------------------

test("Ops items say where they are in a few words", function () {
  var live = L.opsLive({ items: [
    { id: "it_aaaaaaa1", title: "Renew a cert", lane: "waiting" }, { id: "it_aaaaaaa2", title: "Build it", lane: "in_progress" },
    { id: "it_aaaaaaa3", title: "Watching", lane: "soaking" }, { id: "it_aaaaaaa4", title: "Later", lane: "backlog" },
    { id: "it_aaaaaaa5", title: "Done thing", lane: "done" }, { id: "it_aaaaaaa6", title: "Idea", lane: "backlog", proposal: true }, null, {}
  ] });
  assert.deepStrictEqual(["it_aaaaaaa1", "it_aaaaaaa2", "it_aaaaaaa3", "it_aaaaaaa4", "it_aaaaaaa5", "it_aaaaaaa6"].map(function (id) { return live[id].status; }),
    ["Waiting on you", "In progress", "Soaking", "Backlog", "Done", "Proposal"]);
  assert.strictEqual(live.it_aaaaaaa1.tone, "attn");
  assert.strictEqual(live.it_aaaaaaa5.tone, "ok");
  assert.deepStrictEqual(L.opsLive(null), {});
  assert.deepStrictEqual(L.opsLive({ items: "no" }), {});
});

test("assets show up, down, unknown or no monitor; incidents show open with severity or resolved; to-dos show done, overdue, today or the date", function () {
  var a = L.assetsLive({ nodes: [{ id: "as_abcdefghij", name: "Web", state: "down", kind: "server" }, { id: "as_abcdefghik", name: "DB", state: "up" }, { id: "as_abcdefghil", name: "X", state: "unknown" }, { id: "as_abcdefghim", name: "Y" }] });
  assert.deepStrictEqual([a.as_abcdefghij.status, a.as_abcdefghij.tone, a.as_abcdefghik.status, a.as_abcdefghil.status, a.as_abcdefghim.status], ["Down", "alert", "Up", "Unknown", "No monitor"]);
  var i = L.incidentsLive({ incidents: [{ id: "inc_abcd1234", title: "Disk", severity: "SEV2", status: "open" }, { id: "inc_abcd1235", name: "Mail", severity: "SEV3", status: "open" }, { id: "inc_abcd1236", title: "Old", status: "resolved" }] });
  assert.deepStrictEqual([i.inc_abcd1234.status, i.inc_abcd1234.tone, i.inc_abcd1235.tone, i.inc_abcd1236.status, i.inc_abcd1235.title], ["Open SEV2", "alert", "attn", "Resolved", "Mail"]);
  var t = L.todosLive({ tasks: [
    { id: "td_00000001", title: "Late", due: "2026-10-28", status: "open" }, { id: "td_00000002", title: "Now", due: "2026-10-30", status: "open" },
    { id: "td_00000003", title: "Soon", due: "2026-11-03", status: "open" }, { id: "td_00000004", title: "Whenever", status: "open" }, { id: "td_00000005", title: "Done", due: "2026-10-01", status: "done" }
  ] }, "2026-10-30");
  assert.deepStrictEqual([t.td_00000001.status, t.td_00000002.status, t.td_00000003.status, t.td_00000004.status, t.td_00000005.status], ["Overdue", "Due today", "Due 3 Nov", "Open", "Done"]);
  assert.strictEqual(t.td_00000001.tone, "alert");
});

test("a card shows the live words, or the words it was placed with, and says plainly when the thing has gone", function () {
  var item = { id: "cd0001", type: "card", ref: { kind: "ops", id: "it_aaaaaaa1" }, label: "Placed as this" };
  var live = { ops: { it_aaaaaaa1: { title: "Live title", status: "Done", tone: "ok" } } };
  var m = L.cardModel(item, live);
  assert.deepStrictEqual([m.kind, m.title, m.status, m.tone, m.missing, m.page], ["Ops item", "Live title", "Done", "ok", false, "ops.html"]);
  var gone = L.cardModel(item, { ops: {} });
  assert.deepStrictEqual([gone.title, gone.status, gone.missing], ["Placed as this", "Not found", true]);
  var waiting = L.cardModel(item, {});
  assert.deepStrictEqual([waiting.status, waiting.missing], ["Checking…", false], "before the first answer it is not called missing");
  assert.strictEqual(L.cardModel(item).status, "", "an export has no live answer");
  assert.strictEqual(L.cardModel({ ref: { kind: "asset", id: "as_abcdefghij" }, label: "" }, {}).page, "map.html");
});

test("the picker lists what matches, the loudest first, a few at a time", function () {
  var rows = { a: { title: "Zeta", status: "Done", tone: "ok", hint: "" }, b: { title: "Alpha", status: "Down", tone: "alert", hint: "server" }, c: { title: "Beta", status: "Waiting on you", tone: "attn", hint: "" } };
  assert.deepStrictEqual(L.pickerRows("ops", rows, "").map(function (r) { return r.id; }), ["b", "c", "a"]);
  assert.deepStrictEqual(L.pickerRows("ops", rows, "alp").map(function (r) { return r.id; }), ["b"]);
  assert.deepStrictEqual(L.pickerRows("ops", rows, "SERVER").map(function (r) { return r.id; }), ["b"], "the hint is searched too");
  assert.strictEqual(L.pickerRows("ops", rows, "", 2).length, 2);
  assert.deepStrictEqual(L.pickerRows("nope", rows, ""), []);
  assert.deepStrictEqual(L.pickerRows("ops", undefined, ""), []);
});

test("only the kinds of live data a board uses are asked for", function () {
  var items = [note("a00001", 0, 0), { id: "cd0001", type: "card", ref: { kind: "ops", id: "it_aaaaaaa1" } }, { id: "cd0002", type: "card", ref: { kind: "ops", id: "it_aaaaaaa2" } }, { id: "cd0003", type: "card", ref: { kind: "todo", id: "td_00000001" } }];
  assert.deepStrictEqual(L.kindsUsed(items).sort(), ["ops", "todo"]);
  assert.deepStrictEqual(L.kindsUsed([note("a00001", 0, 0)]), []);
});

test("a card's id must have the shape of the kind it names", function () {
  assert.strictEqual(L.validRef({ kind: "ops", id: "it_abcd1234" }), true);
  assert.strictEqual(L.validRef({ kind: "ops", id: "as_abcdefghij" }), false);
  assert.strictEqual(L.validRef({ kind: "todo", id: "td_zzzzzzzz" }), false);
  assert.strictEqual(L.validRef(null), false);
  assert.strictEqual(L.cardKind("incident").page, "monitoring.html#incidents");
  assert.strictEqual(L.cardKind("server"), null);
});

// ---- words on shapes ------------------------------------------------------------------------------------------------

test("text is wrapped to the width, long words are broken, blank lines are kept and too many lines end in an ellipsis", function () {
  assert.deepStrictEqual(L.wrapText("one two three four", 9, 5), ["one two", "three", "four"]);
  assert.deepStrictEqual(L.wrapText("abcdefghijkl", 5, 5), ["abcde", "fghij", "kl"]);
  assert.deepStrictEqual(L.wrapText("a\n\nb", 20, 5), ["a", "", "b"]);
  var cut = L.wrapText("aaa bbb ccc ddd eee fff", 4, 2);
  assert.strictEqual(cut.length, 2);
  assert.ok(cut[1].slice(-1) === "…");
  assert.deepStrictEqual(L.wrapText("", 10, 3), [""]);
  assert.ok(L.charsFor(200, 14) > L.charsFor(100, 14));
});

// ---- export ---------------------------------------------------------------------------------------------------------

test("an SVG export is a whole picture of the board with every kind of thing drawn", function () {
  var items = [
    { id: "fr0001", type: "frame", x: -50, y: -50, w: 500, h: 300, text: "Group", color: "blue" },
    note("a00001", 0, 0, { text: "Hello there" }),
    { id: "sh0001", type: "shape", x: 200, y: 0, w: 120, h: 80, shape: "ellipse", text: "Round", color: "green" },
    { id: "sh0002", type: "shape", x: 200, y: 120, w: 120, h: 80, shape: "diamond", text: "Choice", color: "red" },
    { id: "tx0001", type: "text", x: 0, y: 100, w: 260, h: 40, text: "Big words", size: "l", color: "default" },
    { id: "cd0001", type: "card", x: 0, y: 160, w: 240, h: 84, ref: { kind: "ops", id: "it_aaaaaaa1" }, label: "Renew it", color: "default" },
    arrow("ar0001", { item: "a00001" }, { item: "sh0001" }, { text: "uses", style: "dashed" })
  ];
  var svg = L.toSvg({ items: items }, { ops: { it_aaaaaaa1: { title: "Renew the certificate", status: "Waiting on you", tone: "attn" } } });
  assert.ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="/.test(svg));
  assert.ok(/<\/svg>$/.test(svg));
  ["<ellipse", "<polygon", "<rect", "Hello", "there", "Big words", "Renew the certificate", "Waiting on you", "stroke-dasharray=\"8 6\"", "marker-end=\"url(#ah)\"", "uses", "Group"].forEach(function (s) {
    assert.ok(svg.indexOf(s) !== -1, "the picture has " + s);
  });
  assert.ok(!/undefined|NaN|Infinity/.test(svg));
});

test("an SVG export of an empty board is still a valid picture, and nothing typed on a board can break out of it", function () {
  var empty = L.toSvg({ items: [] });
  assert.ok(/<svg [^>]*width="\d+" height="\d+"/.test(empty));
  var evil = L.toSvg({ items: [note("a00001", 0, 0, { text: "</text><script>alert(1)</script>\"><img src=x onerror=alert(2)>" }), { id: "cd0001", type: "card", x: 0, y: 200, w: 240, h: 84, ref: { kind: "ops", id: "it_aaaaaaa1" }, label: "<b>&\"" }] });
  assert.ok(evil.indexOf("<script") === -1 && evil.indexOf("<img") === -1 && evil.indexOf("<b>") === -1, "markup in text is escaped");
  assert.ok(evil.indexOf("&lt;") !== -1 && evil.indexOf("&gt;") !== -1, "the angle brackets came out as text");
  assert.strictEqual(L.esc("<&>\""), "&lt;&amp;&gt;&quot;");
});

test("a file name is made from the board's name", function () {
  assert.strictEqual(L.fileName("Office network (v2)!", "svg"), "office-network-v2.svg");
  assert.strictEqual(L.fileName("", "json"), "canvas.json");
  assert.strictEqual(L.fileName("☃☃", "png"), "canvas.png");
  assert.ok(L.fileName("x".repeat(200), "png").length <= 54);
});

// ---- words for the page ---------------------------------------------------------------------------------------------

test("errors are said in plain words, by code first and by status when there is no code", function () {
  assert.ok(/credentials/.test(L.errorText("secret_detected")));
  assert.ok(/20 boards/.test(L.errorText("boards_full")));
  assert.ok(/changed somewhere else/.test(L.errorText("conflict")));
  assert.ok(/sign in again/i.test(L.errorText("recent_sign_in_required")));
  assert.ok(/Could not reach/.test(L.errorText(undefined, 0)));
  assert.ok(/Log in/.test(L.errorText(undefined, 401)));
  assert.ok(/owner/.test(L.errorText(undefined, 403)));
  assert.ok(/Too many/.test(L.errorText(undefined, 429)));
  assert.ok(/did not work \(weird\)/.test(L.errorText("weird", 500)));
});

test("the save status and times read in words", function () {
  var now = Date.parse("2026-10-30T06:00:00Z");
  assert.strictEqual(L.saveStatus("dirty", 0, now), "Unsaved changes");
  assert.strictEqual(L.saveStatus("saving", 0, now), "Saving…");
  assert.strictEqual(L.saveStatus("error", 0, now), "Not saved");
  assert.strictEqual(L.saveStatus("conflict", 0, now), "Changed elsewhere");
  assert.strictEqual(L.saveStatus("saved", now - 5 * 60000, now), "Saved 5 min ago");
  assert.strictEqual(L.saveStatus("saved", 0, now), "Saved");
  assert.strictEqual(L.agoText(now - 3 * 3600000, now), "3 h ago");
  assert.strictEqual(L.boardSummary({ title: "Net", items: 1 }), "Net · 1 item");
  assert.strictEqual(L.boardSummary({ title: "Net", items: 3 }), "Net · 3 items");
});

// ---- the page --------------------------------------------------------------------------------------------------------

var html = fs.readFileSync(path.join(root, "canvas.html"), "utf8");
var js = fs.readFileSync(path.join(root, "canvas.js"), "utf8");
var css = fs.readFileSync(path.join(root, "canvas.css"), "utf8");

test("the page's own rules: a strict CSP with no inline script or style, pictures only from itself and blob: (for the PNG export), the Worker the only outside address", function () {
  var csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.ok(/script-src 'self';/.test(csp) && /style-src 'self';/.test(csp));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(/img-src 'self' blob:;/.test(csp));
  assert.ok(/connect-src 'self' https:\/\/api\.barnyard\.site;/.test(csp));
  assert.ok(/form-action 'none'/.test(csp) && /base-uri 'self'/.test(csp));
  assert.ok(!/\sstyle="|\son[a-z]+="/.test(html), "no inline style or event handler");
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script");
  assert.ok(!/https?:\/\/(?!api\.barnyard\.site)/.test(html.replace(/xmlns="[^"]+"/g, "")), "no outside address");
});

test("the page sits in the shared container like the rest and loads the rules before itself", function () {
  assert.ok(/<main id="page" class="content"/.test(html));
  assert.ok(/<body[^>]*\bdata-shell="canvas"[^>]*\bdata-wide\b/.test(html));
  assert.ok(/<div class="page-head">\s*<div>\s*<h1>Canvas<\/h1>\s*<\/div>/.test(html), "the title is followed by tools, not a description");
  var order = ["shell.js", "auth-gate.js", "canvas-logic.js", "canvas.js"].map(function (n) { return html.indexOf('<script src="' + n); });
  assert.ok(order.every(function (i, n) { return i !== -1 && (n === 0 || i > order[n - 1]); }), "scripts load in order: " + order.join(","));
  ["cv-board", "cv-new", "cv-rename", "cv-history", "cv-export", "cv-delete", "cv-svg", "cv-world", "cv-sel", "cv-edit", "cv-tools", "cv-insp", "cv-undo", "cv-redo", "cv-zoom-fit", "cv-conflict", "cv-dlg", "cv-dlg-picker", "cv-gate", "cv-flash"].forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, "the page has #" + id);
    assert.ok(js.indexOf('"' + id + '"') !== -1, "the script uses #" + id);
  });
});

test("every tool button has a name for people who cannot see it, and the board can be reached by keyboard", function () {
  var tools = html.match(/data-tool="[a-z]+"/g) || [];
  assert.strictEqual(tools.length, 7);
  assert.ok(/<div id="cv-stage" class="cv-stage" tabindex="0" aria-label="[^"]+"/.test(html));
  assert.ok(/role="toolbar"/.test(html));
  assert.ok(/tabindex: 0, role: "button", "aria-label"/.test(js), "each thing on the board can be focused and is announced");
  assert.ok(/ev\.key === "Escape"|key === "Escape"/.test(js) && /"Delete"/.test(js) && /key\.indexOf\("Arrow"\)/.test(js));
});

test("the script builds everything with the DOM, never as markup, and runs nothing from text", function () {
  var src = code(js);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\("style"|setAttribute\('style'/.test(src));
  assert.ok(!/sessionStorage|document\.cookie|window\.name|postMessage/.test(src));
  var storage = src.match(/localStorage\.[a-zA-Z]+\(([^)]*)\)/g) || [];
  assert.ok(storage.length === 2 && storage.every(function (s) { return /LAST_KEY/.test(s); }), "only the last board's id is kept in this browser");
  assert.ok(/referrerPolicy: "no-referrer"/.test(src) && /credentials: "include"/.test(src));
});

test("the script talks only to the canvas routes and to the four existing routes live cards read", function () {
  var src = code(js);
  var paths = (src.match(/"\/[a-z]+\/[^"?]*/g) || []).map(function (s) { return s.slice(1); });
  var allowed = ["/canvas/boards", "/canvas/templates", "/canvas/board", "/canvas/versions", "/canvas/save", "/canvas/restore", "/canvas/delete", "/ops/board", "/reg/map", "/incidents/list", "/planner/all"];
  assert.ok(paths.length >= 10);
  paths.forEach(function (p) { assert.ok(allowed.indexOf(p) !== -1, "an unexpected address: " + p); });
  assert.ok(!/method: "(PUT|DELETE|PATCH)"/.test(src) && !/call\("(PUT|DELETE|PATCH)"/.test(src), "only GET and POST, like the Worker's CORS allows");
  assert.ok(/var API = "https:\/\/api\.barnyard\.site";/.test(src));
});

test("saving is autosave with the revision the page last saw, a conflict stops it, and unsaved work is flushed when the tab is hidden", function () {
  var src = code(js);
  assert.ok(/baseRev: board\.rev/.test(src));
  assert.ok(/r\.status === 409 && r\.body\.error === "conflict"/.test(src));
  assert.ok(/!S\.board \|\| !S\.dirty \|\| S\.saving \|\| S\.conflict/.test(src), "nothing is sent while a conflict is open");
  assert.ok(/visibilitychange/.test(src) && /pagehide/.test(src));
  assert.ok(/Keep mine as a new board/.test(html) && /Load the latest/.test(html));
});

test("the stylesheet uses the shell's tokens, works on a phone, and does not narrow the page root or redefine the title row", function () {
  assert.ok(!/^#[a-z0-9]+-root\s*\{[^}]*max-width\s*:\s*\d+px/m.test(css));
  assert.ok(!/^\.page-head\s*\{/m.test(css));
  assert.ok(/var\(--panel\)/.test(css) && /var\(--accent\)/.test(css) && /var\(--alert\)/.test(css));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/rgba?\([^)]*\)/g, "")), "no fixed colours: every colour is a token");
  assert.ok(/@media \(max-width: 860px\)/.test(css));
  assert.ok(/touch-action: none/.test(css), "pinch and drag are the page's, not the browser's");
  L.COLORS.forEach(function (c) { assert.ok(css.indexOf(".cv-c-" + c) !== -1, "a style for " + c); });
});

test("the menu has a Canvas entry for the owner, between Release board and Users, with its icon", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var line = shell.split("\n").filter(function (l) { return l.indexOf('id: "canvas"') !== -1; })[0];
  assert.ok(line, "an entry");
  assert.ok(/group: "Work"/.test(line) && /path: "canvas\.html"/.test(line) && /ownerOnly: true/.test(line) && /perm: "canvas\.view"/.test(line));
  assert.ok(/icon: "canvas"/.test(line) && /^\s*canvas: '<(rect|path|circle)/m.test(shell), "its icon is drawn");
  var ids = (shell.match(/^\s*\{ id: "[a-z0-9]+", title/gm) || []).map(function (l) { return /id: "([a-z0-9]+)"/.exec(l)[1]; });
  assert.ok(ids.indexOf("release") < ids.indexOf("canvas") && ids.indexOf("canvas") < ids.indexOf("users"), ids.join(","));
});

console.log(passed + " passed");
