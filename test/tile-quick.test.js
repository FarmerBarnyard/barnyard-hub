// Coverage for the Quick capture and Running out soon tiles (tile-capture.js, tile-expiry.js) and the tiles' small bus in tile-kit.js.
// These two used to be fixed blocks above the Overview board. The DOM parts were looked at in a browser against a stand-in Worker
// (signed in, signed out, a guest, a person without the permission, narrow and wide, light and dark); here are the rules.
//
//   node test/tile-quick.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var K = require(path.join(root, "tile-kit.js"));
var Cap = require(path.join(root, "tile-capture.js"));
var Exp = require(path.join(root, "tile-expiry.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("both tiles are described for the board: owner only, their own tile.* permission, default-on in the old order, sizes in order", function () {
  var c = Cap.descriptor, e = Exp.descriptor;
  assert.deepStrictEqual([c.id, e.id], ["capture", "expiry"]);
  [c, e].forEach(function (d) {
    assert.ok(d.title && d.about, d.id + " is described");
    assert.strictEqual(d.ownerOnly, true, d.id);
    assert.strictEqual(d.permission, "tile." + d.id, d.id + " permission");
    assert.strictEqual(d.defaultOn, true, d.id + " is part of the default arrangement");
    assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH && d.maxW <= 12, d.id + " sizes");
    assert.strictEqual(d.w, 12, d.id + " starts full width, as the block it replaces was");
  });
  assert.ok(c.order < e.order, "the capture box was above the dated list");
});

test("the filing rules are the ones the Overview always had", function () {
  var note = Cap.buildCapture("note", "  Call the farrier\nabout the mare  ");
  assert.deepStrictEqual(note, { base: "hub", path: "/capture", body: { text: "Call the farrier\nabout the mare" } });
  var item = Cap.buildCapture("item", "Fix the gate");
  assert.deepStrictEqual(item, { base: "ops", path: "/items", body: { title: "Fix the gate", lane: "backlog", category: "other", owner: "you" } });
  var multi = Cap.buildCapture("item", "Fix the gate\nthe hinge is rusted");
  assert.strictEqual(multi.body.title, "Fix the gate");
  assert.strictEqual(multi.body.details, "Fix the gate\nthe hinge is rusted");
  var prop = Cap.buildCapture("proposal", "Add a bell");
  assert.strictEqual(prop.body.proposal, true);
  assert.strictEqual(prop.body.owner, undefined, "a proposal is not owned by you until you approve it");
  assert.strictEqual(Cap.buildCapture("note", "   "), null);
  assert.strictEqual(Cap.buildCapture("weird", "x"), null);
  assert.strictEqual(Cap.buildCapture("note", "x".repeat(8001)), null);
  assert.strictEqual(Cap.buildCapture("item", "x".repeat(6001)), null);
  assert.strictEqual(Cap.buildCapture("item", "w".repeat(300)).body.title.length, 120);
});

test("the Overview re-exports the same helpers, so the tests and other pages keep one address for them", function () {
  var ov = require(path.join(root, "overview.js"));
  assert.deepStrictEqual(ov.buildCapture("item", "Fix the gate"), Cap.buildCapture("item", "Fix the gate"));
  assert.deepStrictEqual(ov.expiryRows([{ label: "x", due: "2027-01-01", daysLeft: 3, kind: "item", id: "it_1" }]), Exp.expiryRows([{ label: "x", due: "2027-01-01", daysLeft: 3, kind: "item", id: "it_1" }]));
});

test("what the capture box says when it cannot file", function () {
  assert.strictEqual(Cap.failText(401), "Your session has expired. Log in again.");
  assert.ok(/password or key/.test(Cap.failText(422)));
  assert.ok(/can.t save that here/.test(Cap.failText(403)));
  assert.ok(/Try again/.test(Cap.failText(500)) && /Try again/.test(Cap.failText(0)));
  assert.strictEqual(Cap.refuseText("   "), "Type something first.");
  assert.ok(/too long/.test(Cap.refuseText("x".repeat(9000))));
});

test("a narrow tile uses the short kind names and keeps their meaning", function () {
  assert.strictEqual(Cap.isCompact(343), true);
  assert.strictEqual(Cap.isCompact(Cap.COMPACT_BELOW), false);
  assert.strictEqual(Cap.isCompact(900), false);
  assert.strictEqual(Cap.isCompact(0), false, "an unmeasured tile keeps the full names");
  assert.strictEqual(Cap.isCompact(undefined), false);
  assert.deepStrictEqual(Cap.KINDS.map(function (k) { return k.value; }), ["note", "item", "proposal"]);
  Cap.KINDS.forEach(function (k) { assert.ok(k.short.length <= 4 && k.label.length >= k.short.length && k.done, k.value); });
  assert.strictEqual(Cap.kindFor("proposal").done, "Proposal added");
  assert.strictEqual(Cap.kindFor("nonsense").value, "note", "an unknown kind falls back to a note");
});

test("the dated list is coloured and worded as it always was", function () {
  var rows = Exp.expiryRows([
    { label: "Old", due: "2026-10-01", daysLeft: -1, kind: "item", id: "it_aaaaaaaa" },
    { label: "Now", due: "2026-10-03", daysLeft: 0, kind: "item", id: "it_bbbbbbbb" },
    { label: "Soon", due: "2026-10-10", daysLeft: 7, kind: "item", id: "it_cccccccc" },
    { label: "Later", due: "2026-11-20", daysLeft: 40, kind: "item", id: "it_dddddddd" },
    { label: "Far", due: "2027-03-01", daysLeft: 150, kind: "item", id: "it_eeeeeeee" },
    { label: "Key", due: "2027-03-01", daysLeft: 31, kind: "chat" }
  ]);
  assert.deepStrictEqual(rows.map(function (r) { return r.chip.text; }), ["Expired 1 day ago", "Today", "In 7 days", "In 40 days", "In 5 months", "In 31 days"]);
  assert.deepStrictEqual(rows.map(function (r) { return r.chip.tone; }), ["alert", "alert", "attn", "accent", "", "accent"]);
  assert.strictEqual(rows[0].href, "ops.html#it_aaaaaaaa");
  assert.strictEqual(rows[5].href, "chat.html", "a thing that is not an Ops item goes where it always did");
  assert.deepStrictEqual(Exp.expiryRows(null), []);
});

test("a short tile shows as many rows as fit and keeps one line for View all; a tall one shows every row", function () {
  var H = Exp.HEAD_PX, R = Exp.ROW_PX;
  assert.strictEqual(Exp.rowsThatFit(0, H, R, 8), 8, "height unknown (the plain page layout): all of them");
  assert.strictEqual(Exp.rowsThatFit(undefined, H, R, 8), 8);
  assert.strictEqual(Exp.rowsThatFit(276, H, R, 8), 6, "the starting height (6 rows) fits six lines");
  assert.strictEqual(Exp.rowsThatFit(132, H, R, 8), 2, "a 3-row tile fits two");
  assert.strictEqual(Exp.rowsThatFit(40, H, R, 8), 1, "never fewer than one");
  assert.strictEqual(Exp.rowsThatFit(900, H, R, 3), 3, "never more than there are");
  var rows = [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return { label: "r" + n }; });
  var v = Exp.visibleRows(rows, 6);
  assert.deepStrictEqual([v.shown.length, v.hidden], [5, 3], "five rows and a View all line, which says how many there are in all");
  assert.deepStrictEqual(Exp.visibleRows(rows, 8), { shown: rows, hidden: 0 }, "everything fits: no link");
  assert.deepStrictEqual(Exp.visibleRows(rows, 20).hidden, 0);
  var one = Exp.visibleRows(rows, 1);
  assert.deepStrictEqual([one.shown.length, one.hidden], [1, 7], "at least one row is always shown");
  assert.deepStrictEqual(Exp.visibleRows([], 3), { shown: [], hidden: 0 });
});

test("the tiles' bus hands a late tile the latest value, tells every listener, and lets one go", function () {
  var seen = [];
  assert.strictEqual(K.latest("probe-topic"), undefined, "nothing yet");
  var off = K.subscribe("probe-topic", function (v) { seen.push("a:" + v); });
  assert.deepStrictEqual(seen, [], "nothing to replay before the first value");
  K.publish("probe-topic", 1);
  var late = [];
  K.subscribe("probe-topic", function (v) { late.push(v); });
  assert.deepStrictEqual(late, [1], "a tile drawn late still gets the latest value");
  K.publish("probe-topic", null);
  assert.deepStrictEqual(seen, ["a:1", "a:null"], "null is a value too: it means signed out");
  assert.strictEqual(K.latest("probe-topic"), null);
  off();
  K.publish("probe-topic", 2);
  assert.deepStrictEqual(seen, ["a:1", "a:null"], "a listener that went does not hear it");
  assert.deepStrictEqual(late, [1, null, 2]);
  K.subscribe("probe-topic", function () { throw new Error("one bad listener"); });
  var after = [];
  K.subscribe("probe-topic", function (v) { after.push(v); });
  K.publish("probe-topic", 3);
  assert.deepStrictEqual(after.slice(-1), [3], "one failing listener does not stop the rest");
});

test("the tiles reach only the Worker routes they should, and read the dated list from the Overview's status answer", function () {
  var cap = fs.readFileSync(path.join(root, "tile-capture.js"), "utf8");
  var paths = (cap.match(/"\/[a-z][^"]*"/g) || []).map(function (p) { return p.replace(/"/g, ""); });
  paths.forEach(function (p) { assert.ok(/^\/(hub|ops|capture|items)/.test(p), "capture calls " + p); });
  assert.ok(/K\.call\("POST", \(plan\.base === "hub" \? "\/hub" : "\/ops"\) \+ plan\.path/.test(cap), "the only request is the filing POST");
  var exp = fs.readFileSync(path.join(root, "tile-expiry.js"), "utf8");
  assert.ok(!/K\.call\(|fetch\(/.test(exp), "the dated tile makes no request of its own");
  assert.ok(/K\.subscribe\("status"/.test(exp) && /K\.subscribe\("status"/.test(cap), "both listen for the status answer");
});

test("the Overview loads both tile files after the toolkit and before the board, and the old fixed blocks are gone", function () {
  var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  var pos = function (re) { var m = re.exec(html); return m ? m.index : -1; };
  var kit = pos(/src="tile-kit\.js/), cap = pos(/src="tile-capture\.js/), exp = pos(/src="tile-expiry\.js/), board = pos(/src="board\.js/), ov = pos(/src="overview\.js/);
  assert.ok(kit > -1 && cap > kit && exp > kit && cap < board && exp < board && board < ov, "order of the scripts");
  assert.ok(!/id="ov-capture"|id="ov-expiry-box"/.test(html), "no fixed blocks");
});

test("the tile files follow the page rules: strict CSP friendly (no innerHTML or inline style) and the select keeps its accessible labels", function () {
  ["tile-capture.js", "tile-expiry.js"].forEach(function (f) {
    var src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(src), f);
    assert.ok(!/\.style\.|setAttribute\(["']style/.test(src), f);
  });
  var cap = fs.readFileSync(path.join(root, "tile-capture.js"), "utf8");
  assert.ok(/Capture a thought, task or idea"\)/.test(cap) && /"File it as"/.test(cap), "both fields have labels for a screen reader");
  assert.ok(/role", "status"/.test(cap), "the result is announced");
  var css = fs.readFileSync(path.join(root, "tiles.css"), "utf8");
  assert.ok(/\.tl-capture/.test(css) && /\.tl-exp-row/.test(css), "styled in tiles.css");
});

console.log("\n" + passed + " passed");
