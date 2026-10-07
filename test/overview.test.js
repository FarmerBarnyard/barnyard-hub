// Coverage for overview.js's pure helpers: the headline sentence, which items
// count as "waiting" and "in flight", how a change-log entry is worded, and
// the layout presets. The DOM and network parts were exercised in a real
// browser against a stand-in for the Worker.
//
//   node test/overview.test.js

var assert = require("assert");
var path = require("path");
var Overview = require(path.join(__dirname, "..", "overview.js"));
var Theme = require(path.join(__dirname, "..", "themes.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
function item(over) {
  return Object.assign({ id: "it_aaaaaaaa", title: "T", lane: "backlog", status: "planned", owner: "claude", next: "", due: "", proposal: false, addedAt: NOW - 1000, updatedAt: NOW - 500, lastEventAt: 0 }, over);
}

test("headline: a number in words, singular and plural, and the empty case", function () {
  assert.strictEqual(Overview.heroHeadline(0), "Nothing needs you.");
  assert.strictEqual(Overview.heroHeadline(1), "One thing needs you.");
  assert.strictEqual(Overview.heroHeadline(2), "Two things need you.");
  assert.strictEqual(Overview.heroHeadline(3), "Three things need you.");
  assert.strictEqual(Overview.heroHeadline(12), "12 things need you.");
  assert.strictEqual(Overview.heroHeadline(-4), "Nothing needs you.");
});

test("sub-line: says how many items Claude changed, and says so plainly when none", function () {
  assert.strictEqual(Overview.heroSubline(0), "Nothing has changed since you were last here. Everything else is running.");
  assert.strictEqual(Overview.heroSubline(1), "Claude changed 1 item since you were last here. Everything else is running.");
  assert.strictEqual(Overview.heroSubline(6), "Claude changed 6 items since you were last here. Everything else is running.");
});

test("waiting items: only open, non-proposal items in the Waiting lane, dated first", function () {
  var list = [
    item({ id: "a", lane: "waiting", due: "", addedAt: 5 }),
    item({ id: "b", lane: "waiting", due: "2026-10-09", addedAt: 9 }),
    item({ id: "c", lane: "waiting", proposal: true }),
    item({ id: "d", lane: "done" }),
    item({ id: "e", lane: "backlog" }),
    item({ id: "f", lane: "waiting", due: "2026-10-08", addedAt: 7 })
  ];
  assert.deepStrictEqual(Overview.waitingItems(list).map(function (i) { return i.id; }), ["f", "b", "a"]);
  assert.deepStrictEqual(Overview.waitingItems(null), []);
});

test("in-flight items: In progress and Soaking only", function () {
  var list = [item({ id: "a", lane: "in_progress" }), item({ id: "b", lane: "soaking" }), item({ id: "c", lane: "waiting" }), item({ id: "d", lane: "in_progress", proposal: true })];
  assert.deepStrictEqual(Overview.flightItems(list).map(function (i) { return i.id; }), ["a", "b"]);
});

test("changedItemCount counts different items Claude changed after the cut-off", function () {
  var events = [
    { itemId: "a", actor: "claude", ts: 100 }, { itemId: "a", actor: "claude", ts: 120 }, { itemId: "b", actor: "claude", ts: 130 },
    { itemId: "c", actor: "you", ts: 140 }, { itemId: "d", actor: "claude", ts: 50 }
  ];
  assert.strictEqual(Overview.changedItemCount(events, 90), 2);
  assert.strictEqual(Overview.changedItemCount(events, 500), 0);
  assert.strictEqual(Overview.changedItemCount(null, 0), 0);
});

test("describeFeed words each kind of change", function () {
  var base = { title: "Fix login", actor: "claude", ts: 1, note: "" };
  function d(kind, extra) { return Overview.describeFeed(Object.assign({}, base, { kind: kind }, extra || {})); }
  assert.strictEqual(d("created").verb, "added");
  assert.strictEqual(d("proposed").verb, "proposed");
  assert.strictEqual(d("note").verb, "added a note to");
  assert.strictEqual(d("done").verb, "finished");
  assert.strictEqual(d("reopened").verb, "reopened");
  assert.strictEqual(d("approved").verb, "approved");
  assert.strictEqual(d("rejected").verb, "rejected");
  assert.strictEqual(d("something-new").verb, "updated");
  var moved = d("moved", { changes: { lane: ["backlog", "waiting"] } });
  assert.strictEqual(moved.verb, "moved");
  assert.strictEqual(moved.tail, " to Waiting on you");
  assert.strictEqual(d("moved", { changes: { lane: ["backlog", "<script>"] } }).tail, "", "an unknown lane adds nothing to the sentence");
  assert.strictEqual(d("moved", {}).tail, "");
  assert.strictEqual(d("created", { actor: "you" }).who, "You");
  assert.strictEqual(d("created", { actor: "claude" }).who, "Claude");
  assert.strictEqual(d("note", { note: "Done it" }).note, "Done it");
  assert.strictEqual(Overview.describeFeed({ kind: "created", actor: "claude", ts: 1 }).title, "an item");
});

test("feedFromItems: newest first, capped, and never invents an actor or a note", function () {
  var list = [item({ id: "a", lastEventAt: 10 }), item({ id: "b", lastEventAt: 30 }), item({ id: "c", lastEventAt: 0, updatedAt: 20 }), item({ id: "d", lane: "done", lastEventAt: 99 })];
  var feed = Overview.feedFromItems(list, 2);
  assert.deepStrictEqual(feed.map(function (e) { return e.itemId; }), ["b", "c"]);
  feed.forEach(function (e) { assert.strictEqual(e.actor, ""); assert.strictEqual(e.note, ""); });
});

test("agoText", function () {
  var now = 10 * 86400000;
  assert.strictEqual(Overview.agoText(now - 20000, now), "just now");
  assert.strictEqual(Overview.agoText(now - 5 * 60000, now), "5 min ago");
  assert.strictEqual(Overview.agoText(now - 3 * 3600000, now), "3 h ago");
  assert.strictEqual(Overview.agoText(now - 86400000, now), "1 day ago");
  assert.strictEqual(Overview.agoText(now - 3 * 86400000, now), "3 days ago");
});

test("dueChip: overdue, today, soon and later", function () {
  assert.strictEqual(Overview.dueChip("", "2026-10-07"), null);
  assert.deepStrictEqual(Overview.dueChip("2026-10-05", "2026-10-07"), { text: "Overdue 2 days", tone: "alert" });
  assert.deepStrictEqual(Overview.dueChip("2026-10-06", "2026-10-07"), { text: "Overdue 1 day", tone: "alert" });
  assert.deepStrictEqual(Overview.dueChip("2026-10-07", "2026-10-07"), { text: "Due today", tone: "accent" });
  assert.deepStrictEqual(Overview.dueChip("2026-10-08", "2026-10-07"), { text: "Due in 1 day", tone: "accent" });
  assert.deepStrictEqual(Overview.dueChip("2026-10-14", "2026-10-07"), { text: "Due in 7 days", tone: "accent" });
  assert.deepStrictEqual(Overview.dueChip("2026-12-01", "2026-10-07"), { text: "Due 2026-12-01", tone: "" });
});

test("layout presets: every preset lists each widget once and survives normalize unchanged", function () {
  assert.ok(Overview.PRESETS.length >= 3);
  Overview.PRESETS.forEach(function (p) {
    assert.deepStrictEqual(p.widgets.map(function (w) { return w.id; }).sort(), Theme.WIDGET_IDS.slice().sort(), p.id + " lists every widget once");
    assert.deepStrictEqual(Theme.normalize({ widgets: p.widgets }).widgets, p.widgets, p.id + " is already valid");
    assert.ok(p.widgets[0].visible, p.id + " keeps the waiting list visible");
  });
  Theme.WIDGET_IDS.forEach(function (id) { assert.ok(Overview.WIDGET_TITLE[id], id + " has a title"); });
});

console.log("\n" + passed + " tests passed");
