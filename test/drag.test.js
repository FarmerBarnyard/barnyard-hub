// Coverage for drag and drop (drag.js): the pure helpers the pages share, the Ops board's rule
// for which tile may go in which lane, and the rules the files must keep (no innerHTML, scripts
// in the right order, CSP). The pointer behaviour itself was exercised in a real browser against
// a fake Worker (drag a tile to a lane, Alt+arrow, a refused move, Escape, drag a widget, arrow
// keys on a widget's grip).
//
//   node test/drag.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var drag = require(path.join(root, "drag.js"));
var ops = require(path.join(root, "ops.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function ids(list) { return list.map(function (x) { return x.id; }).join(","); }
function list() { return ["a", "b", "c", "d"].map(function (id) { return { id: id, visible: true, size: 1 }; }); }

test("reorder: the dragged entry takes the place of the one it lands on", function () {
  assert.strictEqual(ids(drag.reorder(list(), "a", "c")), "b,c,a,d", "moving down lands after it");
  assert.strictEqual(ids(drag.reorder(list(), "d", "b")), "a,d,b,c", "moving up lands before it");
  assert.strictEqual(ids(drag.reorder(list(), "b", "c")), "a,c,b,d", "a neighbour swaps");
  assert.strictEqual(ids(drag.reorder(list(), "a", "d")), "b,c,d,a");
});

test("reorder: nothing to do (same entry, unknown ids) returns the same order, as a copy", function () {
  var l = list();
  assert.strictEqual(ids(drag.reorder(l, "b", "b")), "a,b,c,d");
  assert.strictEqual(ids(drag.reorder(l, "x", "b")), "a,b,c,d");
  assert.strictEqual(ids(drag.reorder(l, "a", "x")), "a,b,c,d");
  assert.notStrictEqual(drag.reorder(l, "b", "b"), l);
  assert.deepStrictEqual(drag.reorder([], "a", "b"), []);
});

test("reorder: does not change what it was given, and keeps each entry's other fields", function () {
  var l = list(); l[0].size = 4;
  var copy = JSON.stringify(l);
  var out = drag.reorder(l, "a", "c");
  assert.strictEqual(JSON.stringify(l), copy);
  assert.strictEqual(out[2].size, 4);
});

test("neighbour: the next entry that is shown, skipping hidden ones", function () {
  var l = list();
  var shown = function (x) { return x.id !== "b" && x.id !== "c"; };
  assert.strictEqual(drag.neighbour(l, "a", 1, shown).id, "d");
  assert.strictEqual(drag.neighbour(l, "d", -1, shown).id, "a");
  assert.strictEqual(drag.neighbour(l, "a", -1, shown), null, "nothing before the first");
  assert.strictEqual(drag.neighbour(l, "d", 1, shown), null, "nothing after the last");
  assert.strictEqual(drag.neighbour(l, "b", 1).id, "c", "without a filter every entry counts");
  assert.strictEqual(drag.neighbour(l, "zzz", 1), null);
});

test("moving a widget past a hidden one lands it beside the next visible one", function () {
  var l = list();
  l[1].visible = false;                                   // b is hidden
  var other = drag.neighbour(l, "c", -1, function (w) { return w.visible; });
  assert.strictEqual(other.id, "a");
  assert.strictEqual(ids(drag.reorder(l, "c", other.id)), "c,a,b,d");
});

test("adjacentLane: one step left or right, null at the ends or for an unknown lane", function () {
  var keys = ["in_progress", "soaking", "waiting", "backlog"];
  assert.strictEqual(drag.adjacentLane(keys, "soaking", 1), "waiting");
  assert.strictEqual(drag.adjacentLane(keys, "soaking", -1), "in_progress");
  assert.strictEqual(drag.adjacentLane(keys, "in_progress", -1), null);
  assert.strictEqual(drag.adjacentLane(keys, "backlog", 1), null);
  assert.strictEqual(drag.adjacentLane(keys, "done", 1), null);
});

test("exceeds: a small wobble is a click, a real movement is a drag", function () {
  assert.strictEqual(drag.exceeds(2, 1, drag.helpers.MOVE_THRESHOLD), false);
  assert.strictEqual(drag.exceeds(0, 6, 6), true);
  assert.strictEqual(drag.exceeds(4, 4, 6), false);
  assert.strictEqual(drag.exceeds(5, 4, 6), true);
  assert.strictEqual(drag.exceeds(-7, 0, 6), true);
});

test("ops: which tiles may go in which lane", function () {
  var live = { id: "it_aaaaaaaa", lane: "waiting", proposal: false };
  assert.strictEqual(ops.canMoveToLane(live, "in_progress"), true);
  assert.strictEqual(ops.canMoveToLane(live, "backlog"), true);
  assert.strictEqual(ops.canMoveToLane(live, "waiting"), false, "not onto its own lane");
  assert.strictEqual(ops.canMoveToLane(live, "done"), false, "done is Mark done, not a lane");
  assert.strictEqual(ops.canMoveToLane(live, "nowhere"), false);
  assert.strictEqual(ops.canMoveToLane({ lane: "backlog", proposal: true }, "waiting"), false, "a proposal is decided in its own tab");
  assert.strictEqual(ops.canMoveToLane({ lane: "done", proposal: false }, "backlog"), false, "finished items come back with Reopen");
  assert.strictEqual(ops.canMoveToLane(undefined, "waiting"), false);
  assert.strictEqual(ops.canMoveToLane(null, "waiting"), false);
});

test("ops: the keyboard move goes one lane left or right and stops at the ends", function () {
  assert.strictEqual(ops.neighbourLane("soaking", 1), "waiting");
  assert.strictEqual(ops.neighbourLane("soaking", -1), "in_progress");
  assert.strictEqual(ops.neighbourLane("in_progress", -1), null);
  assert.strictEqual(ops.neighbourLane("backlog", 1), null);
  assert.strictEqual(ops.neighbourLane("done", 1), null);
});

test("every lane the tiles can be dropped on is one the Worker accepts", function () {
  assert.deepStrictEqual(ops.LANES.map(function (l) { return l.key; }), ["in_progress", "soaking", "waiting", "backlog"]);
});

test("the pages load drag.js before the scripts that use it, and its stylesheet", function () {
  var idx = read("index.html"), opsHtml = read("ops.html");
  assert.ok(idx.indexOf('src="drag.js"') > 0 && idx.indexOf('src="drag.js"') < idx.indexOf('src="overview.js"'));
  assert.ok(opsHtml.indexOf('src="drag.js"') > 0 && opsHtml.indexOf('src="drag.js"') < opsHtml.indexOf('src="ops.js"'));
  assert.ok(/href="drag\.css"/.test(idx) && /href="drag\.css"/.test(opsHtml));
});

test("drag.js and drag.css keep to the CSP: no innerHTML, no style attributes, no fixed colours, nothing remote", function () {
  var js = read("drag.js"), css = read("drag.css");
  assert.strictEqual((js.match(/\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\(|new Function/g) || []).length, 0);
  assert.ok(!/setAttribute\(\s*["']style["']/.test(js), "styles are set through the CSSOM, never as an attribute");
  assert.ok(!/https?:\/\//.test(js.replace(/\/\/.*$/gm, "")), "no addresses");
  assert.ok(!/@import|url\(/.test(css));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "theme tokens only");
});

test("the Overview adds its grips without innerHTML and keeps arrow-key moves for the keyboard", function () {
  var ov = read("overview.js");
  assert.strictEqual((ov.match(/\.innerHTML\s*=/g) || []).length, 0);
  assert.ok(/function setupDrag/.test(ov) && /ArrowLeft/.test(ov) && /ArrowRight/.test(ov));
  assert.ok(/aria-label", "Move " \+ name/.test(ov), "the grip is labelled for screen readers");
  assert.ok(/\.w-grip/.test(read("drag.css")));
});

test("the Ops tiles can be moved from the keyboard and say so", function () {
  var src = read("ops.js");
  assert.ok(/aria-keyshortcuts", "Alt\+ArrowLeft Alt\+ArrowRight"/.test(src));
  assert.ok(/ev\.altKey/.test(src));
});

console.log("\n" + passed + " tests passed");
