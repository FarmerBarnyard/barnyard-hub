// Unit coverage for ops.js's pure helpers (dates, stats, sorting, filtering,
// the push-message reducer, the edit-form diff) -- same rationale and pattern
// as test/todo-widget.test.js: no build step, no package.json, plain Node with
// the standard library only, run with:
//
//   node test/ops.test.js
//
// ops.js exports its DOM-free helpers via a `module.exports` guard (a no-op in
// the browser). The DOM-building UI and the network transport are out of scope
// here; they were exercised in a real browser against an in-memory fake server.

var assert = require("assert");
var path = require("path");
var ops = require(path.join(__dirname, "..", "ops.js"));

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

var DAY = 86400000;
var TODAY = "2026-10-07";
var NOW = new Date(2026, 9, 7, 12, 0, 0).getTime(); // local noon, 7 Oct 2026

function item(over) {
  return Object.assign({
    id: "it_aaaaaaaa", title: "T", lane: "backlog", status: "planned", category: "other", targets: [],
    priority: "normal", owner: "claude", next: "", details: "", due: "", proposal: false,
    addedAt: NOW - 2 * DAY, updatedAt: NOW - DAY, doneAt: null
  }, over);
}

test("dateString uses the local calendar date", function () {
  assert.strictEqual(ops.dateString(new Date(2026, 9, 7, 23, 59)), "2026-10-07");
  assert.strictEqual(ops.dateString(new Date(2026, 0, 1, 0, 1)), "2026-01-01");
});

test("daysUntil counts whole days, signed, across month and year ends", function () {
  assert.strictEqual(ops.daysUntil("2026-10-07", TODAY), 0);
  assert.strictEqual(ops.daysUntil("2026-10-08", TODAY), 1);
  assert.strictEqual(ops.daysUntil("2026-10-05", TODAY), -2);
  assert.strictEqual(ops.daysUntil("2026-11-01", TODAY), 25);
  assert.strictEqual(ops.daysUntil("2027-01-01", "2026-12-31"), 1);
  assert.strictEqual(ops.daysUntil("", TODAY), null);
});

test("dueInfo words and tones", function () {
  assert.deepStrictEqual(ops.dueInfo("2026-10-08", TODAY), { text: "Oct 8 · tomorrow", tone: "soon", days: 1 });
  assert.strictEqual(ops.dueInfo("2026-10-07", TODAY).text, "Oct 7 · today");
  assert.strictEqual(ops.dueInfo("2026-10-06", TODAY).text, "Oct 6 · yesterday");
  assert.strictEqual(ops.dueInfo("2026-10-05", TODAY).text, "Oct 5 · 2 days overdue");
  assert.strictEqual(ops.dueInfo("2026-10-05", TODAY).tone, "overdue");
  assert.strictEqual(ops.dueInfo("2026-10-12", TODAY).text, "Oct 12 · in 5 days");
  assert.strictEqual(ops.dueInfo("2026-10-12", TODAY).tone, "later");
  assert.strictEqual(ops.dueInfo("", TODAY), null);
});

test("age and relative time wording", function () {
  assert.strictEqual(ops.ageText(NOW - 1000, NOW), "new today");
  assert.strictEqual(ops.ageText(NOW - DAY, NOW), "1 day old");
  assert.strictEqual(ops.ageText(NOW - 12 * DAY, NOW), "12 days old");
  assert.strictEqual(ops.ageDays(NOW + 5000, NOW), 0, "a clock-skewed future timestamp is not negative");
  assert.strictEqual(ops.relativeTime(NOW - 10000, NOW), "just now");
  assert.strictEqual(ops.relativeTime(NOW - 5 * 60000, NOW), "5 min ago");
  assert.strictEqual(ops.relativeTime(NOW - 3 * 3600000, NOW), "3 h ago");
  assert.strictEqual(ops.relativeTime(NOW - DAY, NOW), "yesterday");
  assert.strictEqual(ops.relativeTime(NOW - 6 * DAY, NOW), "6 days ago");
});

test("computeStats ignores done items and proposals; classifies due dates", function () {
  var items = [
    item({ id: "it_00000001", lane: "in_progress" }),
    item({ id: "it_00000002", lane: "soaking", due: "2026-10-08" }),
    item({ id: "it_00000003", lane: "waiting", due: "2026-10-05" }),
    item({ id: "it_00000004", lane: "waiting", due: "2026-10-14" }),
    item({ id: "it_00000005", lane: "backlog", due: "2026-10-15", addedAt: NOW - 40 * DAY }),
    item({ id: "it_00000006", lane: "done", due: "2026-10-01" }),
    item({ id: "it_00000007", lane: "backlog", proposal: true, due: "2026-10-01", addedAt: NOW - 90 * DAY })
  ];
  assert.deepStrictEqual(ops.computeStats(items, NOW, TODAY), { in_progress: 1, soaking: 1, waiting: 2, backlog: 1, dueSoon: 2, overdue: 1, aged: 1 });
});

test("sortForLane: high priority first, then oldest, stable by id", function () {
  var sorted = ops.sortForLane([
    item({ id: "it_00000003", addedAt: NOW - DAY }),
    item({ id: "it_00000002", addedAt: NOW - 5 * DAY }),
    item({ id: "it_00000001", addedAt: NOW - DAY, priority: "high" }),
    item({ id: "it_00000004", addedAt: NOW - 5 * DAY })
  ]);
  assert.deepStrictEqual(sorted.map(function (i) { return i.id; }), ["it_00000001", "it_00000002", "it_00000004", "it_00000003"]);
});

test("filters: OR within a group, AND across groups, empty matches all", function () {
  var a = item({ id: "it_00000001", category: "backend", targets: ["app02"], status: "soaking" });
  var b = item({ id: "it_00000002", category: "backend", targets: ["worker"], status: "planned" });
  var c = item({ id: "it_00000003", category: "docs", targets: ["app02", "worker"], status: "soaking" });
  var all = [a, b, c];
  var none = { category: [], target: [], status: [] };
  assert.strictEqual(ops.filterItems(all, none).length, 3);
  assert.deepStrictEqual(ops.filterItems(all, { category: ["backend"], target: [], status: [] }).map(function (i) { return i.id; }), ["it_00000001", "it_00000002"]);
  assert.deepStrictEqual(ops.filterItems(all, { category: ["backend", "docs"], target: ["worker"], status: [] }).map(function (i) { return i.id; }), ["it_00000002", "it_00000003"]);
  assert.deepStrictEqual(ops.filterItems(all, { category: ["backend"], target: ["app02"], status: ["soaking"] }).map(function (i) { return i.id; }), ["it_00000001"]);
  assert.strictEqual(ops.filterItems(all, { category: ["security"], target: [], status: [] }).length, 0);
});

test("facet counts: most common first; status in lifecycle order", function () {
  var items = [
    item({ category: "backend", targets: ["a", "b"], status: "planned" }),
    item({ category: "backend", targets: ["a"], status: "soaking" }),
    item({ category: "docs", targets: [], status: "soaking" })
  ];
  assert.deepStrictEqual(ops.facet(items, "category"), [{ value: "backend", count: 2 }, { value: "docs", count: 1 }]);
  assert.deepStrictEqual(ops.facet(items, "target"), [{ value: "a", count: 2 }, { value: "b", count: 1 }]);
  assert.deepStrictEqual(ops.facet(items, "status").map(function (f) { return f.value; }), ["soaking", "planned"]);
});

test("upcoming: dated open items only, soonest first", function () {
  var items = [
    item({ id: "it_00000001", due: "2026-10-09" }),
    item({ id: "it_00000002", due: "2026-10-05" }),
    item({ id: "it_00000003" }),
    item({ id: "it_00000004", due: "2026-10-06", lane: "done" }),
    item({ id: "it_00000005", due: "2026-10-07", proposal: true }),
    item({ id: "it_00000006", due: "2026-10-08" })
  ];
  assert.deepStrictEqual(ops.upcoming(items, TODAY).map(function (i) { return i.id; }), ["it_00000002", "it_00000006", "it_00000001"]);
});

test("change descriptions are readable and never show markup as anything but text", function () {
  assert.deepStrictEqual(ops.describeChanges({ lane: ["backlog", "waiting"], status: ["planned", "decision_needed"], due: ["", "2026-10-09"], next: ["a", "b"] }), [
    "Lane: Backlog → Waiting on you", "Status: Planned → Decision needed", "Due: (none) → 2026-10-09", "Next step updated"
  ]);
  assert.deepStrictEqual(ops.describeChanges({}), []);
  var ev = { kind: "moved", actor: "claude", changes: { lane: ["backlog", "waiting"] } };
  assert.strictEqual(ops.describeEvent(ev, { title: "Backup" }), "Claude moved “Backup” to Waiting on you");
  assert.strictEqual(ops.describeEvent({ kind: "note", actor: "you", changes: {} }, { title: "X" }), "You added a note to “X”");
  assert.strictEqual(ops.describeEvent({ kind: "weird", actor: "claude", changes: {} }, { title: "X" }), "Claude changed “X”");
});

test("reduceMessage: snapshot replaces, in-order change upserts, a version gap resyncs, junk is ignored", function () {
  var state = { version: 10 };
  var snap = ops.reduceMessage(state, { type: "snapshot", version: 12, doneCount: 3, items: [{ id: "x" }] });
  assert.strictEqual(snap.kind, "snapshot");
  assert.strictEqual(snap.version, 12);
  assert.strictEqual(snap.doneCount, 3);
  var next = ops.reduceMessage(state, { type: "change", version: 11, item: { id: "x", updatedAt: 1 }, event: { seq: 5 } });
  assert.strictEqual(next.kind, "upsert");
  assert.strictEqual(next.version, 11);
  var dup = ops.reduceMessage({ version: 11 }, { type: "change", version: 11, item: { id: "x" } });
  assert.strictEqual(dup.kind, "upsert", "a duplicate of something already folded in is harmless");
  assert.strictEqual(dup.version, 11, "and never moves the version backwards");
  assert.strictEqual(ops.reduceMessage(state, { type: "change", version: 13, item: { id: "x" } }).kind, "resync");
  [null, undefined, "x", 5, {}, { type: "change" }, { type: "change", version: "9", item: {} }, { type: "snapshot" }, { type: "other" }].forEach(function (junk) {
    assert.strictEqual(ops.reduceMessage(state, junk).kind, "ignore", JSON.stringify(junk));
  });
});

test("newer keeps the more recently updated copy, either way round", function () {
  var old = { id: "a", updatedAt: 5, title: "old" };
  var fresh = { id: "a", updatedAt: 9, title: "fresh" };
  assert.strictEqual(ops.newer(old, fresh), fresh);
  assert.strictEqual(ops.newer(fresh, old), fresh);
  assert.strictEqual(ops.newer(undefined, old), old);
  assert.strictEqual(ops.newer(old, { id: "a", updatedAt: 5, title: "same" }).title, "same");
});

test("changedFields sends only what differs; targets compare by value", function () {
  var it = item({ title: "T", lane: "backlog", targets: ["a", "b"], next: "n" });
  assert.deepStrictEqual(ops.changedFields(it, { title: "T", lane: "backlog", targets: ["a", "b"], next: "n", due: "" }), {});
  assert.deepStrictEqual(ops.changedFields(it, { title: "T2", lane: "waiting", targets: ["a"], next: "n" }), { title: "T2", lane: "waiting", targets: ["a"] });
});

test("parseTargets trims, drops blanks and duplicates", function () {
  assert.deepStrictEqual(ops.parseTargets(" app02 , worker,, app02 ,  "), ["app02", "worker"]);
  assert.deepStrictEqual(ops.parseTargets(""), []);
  assert.deepStrictEqual(ops.parseTargets(undefined), []);
});

console.log("\n" + passed + " tests passed");
