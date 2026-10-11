// Coverage for activity.js's pure helpers (the page that merges /ops/recent and /ops/audit): who did it, plain
// English for each kind of entry, the merge, the filters and the day groups.
//
//   node test/activity.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Activity = require(path.join(__dirname, "..", "activity.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = new Date(2026, 9, 11, 15, 0, 0).getTime();
var HOUR = 3600000, DAY = 86400000;

test("who did it: people, the desktop Claude, agents and keys, and the unknown", function () {
  assert.strictEqual(Activity.actorOf("person:abc123"), "you");
  assert.strictEqual(Activity.actorOf("you"), "you");
  assert.strictEqual(Activity.actorOf("desktop-approver"), "claude");
  assert.strictEqual(Activity.actorOf("claude"), "claude");
  assert.strictEqual(Activity.actorOf("owner-token"), "agent");
  assert.strictEqual(Activity.actorOf("key:ok_12345678"), "agent");
  assert.strictEqual(Activity.actorOf("unknown"), "unknown");
  assert.strictEqual(Activity.actorOf(undefined), "unknown");
});

test("audit entries read as sentences, with the detail in brackets, and unknown actions are shown, not hidden", function () {
  var d = Activity.describeAudit({ who: "person:abc", action: "export", result: "ok", detail: "" });
  assert.deepStrictEqual([d.text, d.tone, d.actor], ["You exported the whole board", "", "you"]);
  var k = Activity.describeAudit({ who: "person:abc", action: "key_created", result: "ok", detail: "key ok_1, rw, 30 days" });
  assert.strictEqual(k.text, "You made an agent key (key ok_1, rw, 30 days)");
  var u = Activity.describeAudit({ who: "owner-token", action: "some_new_action", result: "ok", detail: "" });
  assert.strictEqual(u.text, "An agent some new action");
  assert.strictEqual(Activity.describeAudit({ who: "x", action: "keys_revoked_all", result: "ok", detail: "" }).tone, "attn", "a drastic action is flagged");
});

test("refusals are flagged, and a blocked credential is an alert that never repeats the text", function () {
  var deny = Activity.describeAudit({ who: "desktop-approver", action: "item_decide", result: "denied", detail: "session_required" });
  assert.deepStrictEqual([deny.text, deny.tone], ["A decision was refused", "attn"]);
  var ro = Activity.describeAudit({ who: "key:ok_1", action: "write_attempt", result: "denied", detail: "read_only_key" });
  assert.strictEqual(ro.text, "A read-only key tried to write and was refused");
  var prop = Activity.describeAudit({ who: "key:ok_1", action: "proposal_change", result: "denied", detail: "proposal by agent" });
  assert.strictEqual(prop.tone, "attn");
  var blocked = Activity.describeAudit({ who: "owner-token", action: "write_blocked", result: "denied", detail: "anthropic key in next" });
  assert.strictEqual(blocked.tone, "alert");
  assert.ok(blocked.text.indexOf("credential") !== -1 && blocked.text.indexOf("(anthropic key in next)") !== -1);
  var bad = Activity.describeAudit({ who: "unknown", action: "key_auth_failed", result: "denied", detail: "3 attempt(s)" });
  assert.deepStrictEqual([bad.tone, bad.text], ["alert", "An agent key was refused (3 attempt(s))"]);
  var generic = Activity.describeAudit({ who: "person:a", action: "export", result: "denied", detail: "recent_sign_in_required" });
  assert.strictEqual(generic.text, "You exported the whole board and was refused");
  assert.strictEqual(generic.tone, "attn");
});

test("item changes read the way the Overview words them, with a link to the item", function () {
  var m = Activity.describeChange({ actor: "claude", kind: "moved", title: "Maps", itemId: "it_abc12345", changes: { lane: ["backlog", "waiting"] } });
  assert.deepStrictEqual([m.text, m.href, m.actor], ["Claude moved Maps to Waiting on you", "ops.html#it_abc12345", "claude"]);
  assert.strictEqual(Activity.describeChange({ actor: "you", kind: "done", title: "T", itemId: "it_a" }).text, "You finished T");
  assert.strictEqual(Activity.describeChange({ actor: "you", kind: "weird", itemId: "it_a" }).text, "You updated an item");
  assert.strictEqual(Activity.describeChange({ actor: "claude", kind: "note", title: "T", note: "why", itemId: "" }).href, "");
});

test("merging puts both feeds in one newest-first list and skips rows with no time", function () {
  var rows = Activity.mergeFeeds(
    [{ actor: "claude", kind: "created", title: "A", itemId: "it_1", ts: NOW - 2 * HOUR }, { actor: "you", kind: "done", title: "B", itemId: "it_2", ts: NOW - 30 * HOUR }, { kind: "created", title: "No time" }],
    [{ who: "person:x", action: "export", result: "ok", detail: "", ts: NOW - HOUR }, { who: "x", action: "export", ts: "bad" }]
  );
  assert.deepStrictEqual(rows.map(function (r) { return [r.type, r.text]; }), [["audit", "You exported the whole board"], ["change", "Claude added A"], ["change", "You finished B"]]);
  assert.deepStrictEqual(Activity.mergeFeeds(null, null), []);
});

test("filters: by kind and by who, both together", function () {
  var rows = Activity.mergeFeeds(
    [{ actor: "claude", kind: "created", title: "A", itemId: "it_1", ts: 3 }, { actor: "you", kind: "done", title: "B", itemId: "it_2", ts: 2 }],
    [{ who: "owner-token", action: "export", result: "ok", ts: 1 }]
  );
  assert.strictEqual(Activity.applyFilter(rows, { type: "all", actor: "any" }).length, 3);
  assert.strictEqual(Activity.applyFilter(rows, { type: "audit", actor: "any" }).length, 1);
  assert.strictEqual(Activity.applyFilter(rows, { type: "change", actor: "claude" }).length, 1);
  assert.strictEqual(Activity.applyFilter(rows, { type: "all", actor: "agent" }).length, 1);
  assert.strictEqual(Activity.applyFilter(rows, { type: "audit", actor: "you" }).length, 0);
});

test("days: Today, Yesterday, then a date; rows keep their order within a day", function () {
  var rows = [
    { ts: NOW - HOUR, text: "a" }, { ts: NOW - 2 * HOUR, text: "b" },
    { ts: NOW - DAY, text: "c" }, { ts: NOW - 4 * DAY, text: "d" }
  ];
  var g = Activity.groupByDay(rows, NOW);
  assert.deepStrictEqual(g.map(function (x) { return x.day; }), ["Today", "Yesterday", "Wed 7 Oct"]);
  assert.deepStrictEqual(g[0].rows.map(function (r) { return r.text; }), ["a", "b"]);
  assert.strictEqual(Activity.timeText(new Date(2026, 9, 11, 9, 5).getTime()), "09:05");
  assert.deepStrictEqual(Activity.groupByDay([], NOW), []);
});

test("the page is wired: strict CSP, no inline script or style, and server text only by textContent", function () {
  var html = fs.readFileSync(path.join(root, "activity.html"), "utf8");
  assert.ok(html.indexOf("script-src 'self'") !== -1 && html.indexOf("style-src 'self'") !== -1);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/\sstyle=/.test(html), "no inline style attribute");
  var js = fs.readFileSync(path.join(root, "activity.js"), "utf8");
  assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write/.test(js));
});

console.log("\n" + passed + " tests passed");
