// Coverage for the pure helpers of the Today, Activity, Usage, Approvals and Calendar tiles (behind /hub/briefing, /hub/activity,
// /hub/usage, the Ops board's own routes and the Calendar's data), and for how all of them are described for the Overview board.
//
//   node test/tile-ops.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Today = require(path.join(__dirname, "..", "tile-today.js"));
var Activity = require(path.join(__dirname, "..", "tile-activity.js"));
var Usage = require(path.join(__dirname, "..", "tile-usage.js"));
var Approvals = require(path.join(__dirname, "..", "tile-approvals.js"));
var Calendar = require(path.join(__dirname, "..", "tile-calendar.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("Today: the owner's own date, the headline, and rows split between 'always' and 'when there is room'", function () {
  assert.strictEqual(Today.todayParam(new Date(2026, 9, 28, 23, 30).getTime()), "2026-10-28");
  assert.strictEqual(Today.todayParam(new Date(2026, 0, 5, 0, 5).getTime()), "2026-01-05");
  assert.strictEqual(Today.headline({ count: 0 }), "Nothing needs you today.");
  assert.strictEqual(Today.headline(null), "Nothing needs you today.");
  assert.strictEqual(Today.headline({ count: 1 }), "1 thing needs you today.");
  assert.strictEqual(Today.headline({ count: 7 }), "7 things need you today.");
  var v = Today.sectionView({ id: "todos", title: "To-dos", tone: "alert", count: 9, items: [1, 2, 3, 4, 5, 6].map(function (n) { return { text: "t" + n }; }), more: 3 });
  assert.deepStrictEqual([v.first.length, v.rest.length, v.more, v.count, v.tone], [2, 4, 3, 9, "alert"]);
  assert.strictEqual(Today.safeHref("calendar.html"), "calendar.html");
  assert.strictEqual(Today.safeHref("ops.html#it_abcd1234"), "ops.html#it_abcd1234");
  ["https://evil.example/", "javascript:alert(1)", "//evil", "../x.html", "ops.html#<x>", ""].forEach(function (bad) { assert.strictEqual(Today.safeHref(bad), "", bad); });
});

test("Activity: filter by who did it, count each group, and word the actor and area", function () {
  var items = [{ actor: "you", text: "a" }, { actor: "claude", text: "b" }, { actor: "agent", text: "c" }, { actor: "you", text: "d" }, { actor: "system", text: "e" }];
  assert.strictEqual(Activity.filterByActor(items, "").length, 5);
  assert.deepStrictEqual(Activity.filterByActor(items, "you").map(function (i) { return i.text; }), ["a", "d"]);
  assert.strictEqual(Activity.filterByActor(null, "you").length, 0);
  assert.deepStrictEqual(Activity.counts(items), { "": 5, you: 2, claude: 1, agent: 1, system: 1 });
  assert.strictEqual(Activity.whoLabel("claude"), "Claude");
  assert.strictEqual(Activity.whoLabel("zzz"), "Someone");
  assert.strictEqual(Activity.areaLabel("changes"), "Change log");
  assert.strictEqual(Activity.safeHref("ops.html#it_aaaaaaaa"), "ops.html#it_aaaaaaaa");
  assert.strictEqual(Activity.safeHref("https://x.example"), "");
});

test("Activity: a change-log entry needs what changed and how to undo it, and a sensible link", function () {
  assert.strictEqual(Activity.changeToBody({ what: "", where: "", why: "", undo: "x", link: "" }).field, "what");
  assert.strictEqual(Activity.changeToBody({ what: "x", where: "", why: "", undo: "  ", link: "" }).field, "undo");
  var ok = Activity.changeToBody({ what: " Raised the caps ", where: "Worker", why: "", undo: "Put them back", link: "PR 444" });
  assert.deepStrictEqual(ok.body, { what: "Raised the caps", undo: "Put them back", where: "Worker", link: "PR 444" });
  assert.ok(Activity.changeToBody({ what: "x", where: "", why: "", undo: "y", link: "https://github.com/FarmerBarnyard/ClaudeRepo/pull/444" }).body);
  assert.strictEqual(Activity.changeToBody({ what: "x", where: "", why: "", undo: "y", link: "<script>" }).field, "link");
});

test("Usage: a bar says used of limit and its percentage, bytes read as MB, and an unknown meter says why", function () {
  assert.strictEqual(Usage.bytesText(500), "500 B");
  assert.strictEqual(Usage.bytesText(2048), "2 KB");
  assert.strictEqual(Usage.bytesText(5 * 1048576), "5.0 MB");
  assert.strictEqual(Usage.bytesText(400 * 1048576), "400 MB");
  var m = Usage.barModel({ label: "Articles", used: 705, limit: 1000, unit: "articles", pct: 71, tone: "attn", note: "n" });
  assert.deepStrictEqual([m.text, m.pct, m.tone, m.note], ["705 of 1,000 (71%)", 71, "attn", "n"]);
  assert.strictEqual(Usage.barModel({ label: "Images", used: 10485760, limit: 419430400, unit: "bytes", pct: 2, tone: "ok" }).text, "10 MB of 400 MB (2%)");
  assert.strictEqual(Usage.barModel({ label: "Requests", used: 150000, limit: 100000, unit: "requests", pct: 150, tone: "alert" }).pct, 100, "the bar stops at full");
  var none = Usage.barModel({ label: "Requests", used: null, pct: null, note: "Not counted." });
  assert.deepStrictEqual([none.pct, none.text], [null, "Not counted."]);
});

test("Usage: the tightest meters in order, and the checklist sentence", function () {
  var u = { meters: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], tightest: ["c", "a", "x"], checklist: [{}, {}, {}, {}], checklistDone: 1 };
  assert.deepStrictEqual(Usage.tightest(u, 3).map(function (m) { return m.id; }), ["c", "a"]);
  assert.strictEqual(Usage.tightest(null).length, 0);
  assert.strictEqual(Usage.checklistText(u), "1 of 4 paths ticked in the rate-limit rule");
  assert.strictEqual(Usage.checklistText(null), "");
});

test("Approvals: proposals then questions, oldest first, nothing finished; decisions carry an optional trimmed note", function () {
  var items = [
    { id: "it_a", title: "Q2", lane: "waiting", ask: "Which one?", addedAt: 30 }, { id: "it_b", title: "P2", proposal: true, lane: "backlog", addedAt: 20 },
    { id: "it_c", title: "P1", proposal: true, lane: "backlog", addedAt: 10, ask: "Go ahead?" }, { id: "it_d", title: "Done", proposal: true, lane: "done" },
    { id: "it_e", title: "Plain", lane: "backlog" }, { id: "it_f", title: "Q1", lane: "waiting", ask: "Yes?", addedAt: 5 }, { id: "it_g", title: "Waiting but no question", lane: "waiting" }
  ];
  var w = Approvals.waiting(items);
  assert.deepStrictEqual(w.map(function (r) { return r.id + ":" + r.kind; }), ["it_f:question", "it_c:proposal", "it_b:proposal", "it_a:question"]);
  assert.strictEqual(w[1].ask, "Go ahead?");
  assert.deepStrictEqual(Approvals.decideBody(true, ""), { approve: true });
  assert.deepStrictEqual(Approvals.decideBody(false, "  not now  "), { approve: false, note: "not now" });
  assert.strictEqual(Approvals.decideBody(true, "x".repeat(3000)).note.length, 2000);
  assert.strictEqual(Approvals.waiting(null).length, 0);
});

test("Approvals: refusals read in words, pending changes are counted, and the summary line is plain", function () {
  assert.ok(/recent sign-in/.test(Approvals.decideError({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/Only you/.test(Approvals.decideError({ error: "session_required" }, 403)));
  assert.ok(/did not work|only for the hub owner/.test(Approvals.decideError({}, 403)));
  assert.strictEqual(Approvals.pendingCount({ changes: [1, 2] }), 2);
  assert.strictEqual(Approvals.pendingCount(null), null);
  assert.strictEqual(Approvals.summaryLine([], 0), "No decisions waiting.");
  assert.strictEqual(Approvals.summaryLine([{}], 0), "1 decision waiting.");
  assert.strictEqual(Approvals.summaryLine([{}, {}], 3), "2 decisions waiting · 3 code changes to review.");
  assert.strictEqual(Approvals.summaryLine([], 1), "No decisions waiting · 1 code change to review.");
});

test("Calendar tile: the three answers become the page's data, and the agenda is the page's own", function () {
  assert.deepStrictEqual(Calendar.dataFrom(null, null, null), { renewals: [], dueItems: [], tasks: [], events: [], google: [] });
  var d = Calendar.dataFrom({ renewals: [{ id: "r" }], dueItems: [{ id: "d" }] }, { tasks: [{ id: "t" }], events: [{ id: "e" }] }, [{ id: "g" }]);
  assert.deepStrictEqual([d.renewals.length, d.dueItems.length, d.tasks.length, d.events.length, d.google.length], [1, 1, 1, 1, 1]);
  var data = Calendar.dataFrom({ renewals: [{ id: "r1", label: "Domain", due: "2026-10-30", state: "known", kind: "domain" }], dueItems: [] }, { tasks: [{ id: "t1", title: "Pay the host", due: "2026-10-27", time: "", priority: "normal", status: "open", recur: "" }, { id: "t2", title: "Call", due: "2026-10-28", time: "09:30", priority: "normal", status: "open", recur: "" }], events: [] }, []);
  var a = Calendar.agendaFor(data, "2026-10-28");
  assert.deepStrictEqual([a.overdue.length, a.today.length, a.week.length], [1, 1, 1]);
  assert.strictEqual(Calendar.headline(a), "1 overdue, 1 today.");
  assert.strictEqual(Calendar.headline({ overdue: [], today: [], week: [] }), "Nothing on today or this week.");
  assert.strictEqual(Calendar.headline({ overdue: [], today: [], week: [1, 2] }), "Nothing due today. 2 things this week.");
  assert.ok(/Call/.test(Calendar.entryLine(a.today[0])));
  assert.strictEqual(Calendar.todayParam(new Date(2026, 9, 28, 1, 0).getTime()), "2026-10-28");
});

test("every operations tile is described for the Overview board: owner only, a tile.* permission, sizes in order, a unique id", function () {
  var all = [require(path.join(root, "tile-assets.js")), require(path.join(root, "tile-backups.js")), Today, Activity, Usage, Approvals, Calendar];
  var ids = {};
  all.forEach(function (t) {
    var d = t.descriptor;
    assert.ok(d && d.id && d.title && d.about, "described");
    assert.ok(!ids[d.id], "unique id " + d.id); ids[d.id] = 1;
    assert.strictEqual(d.ownerOnly, true, d.id);
    assert.strictEqual(d.permission, "tile." + d.id, d.id + " permission");
    assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH && d.maxW <= 12, d.id + " sizes");
  });
  assert.deepStrictEqual(Object.keys(ids).sort(), ["activity", "approvals", "assets", "backups", "calendar", "today", "usage"]);
  ["need", "feed", "flight", "market", "weather", "week", "todo", "links"].forEach(function (core) { assert.ok(!ids[core], core + " is the Overview's own"); });
});

test("the tiles reach only the Worker routes they should", function () {
  var allowed = { "tile-today.js": /^\/hub\/briefing/, "tile-activity.js": /^\/(hub\/activity|reg\/changes)/, "tile-usage.js": /^\/(hub\/usage|reg\/ticks)/, "tile-approvals.js": /^\/(ops\/(board|items)|chat\/pending)/, "tile-calendar.js": /^\/(hub\/renewals|planner\/all|calendar)/ };
  Object.keys(allowed).forEach(function (f) {
    var src = fs.readFileSync(path.join(root, f), "utf8");
    var paths = (src.match(/"\/[a-z][^"]*"/g) || []).map(function (p) { return p.replace(/"/g, ""); }).filter(function (p) { return /^\/(hub|reg|ops|chat|planner|calendar)/.test(p); });
    assert.ok(paths.length >= 1, f + " calls the Worker");
    paths.forEach(function (p) { assert.ok(allowed[f].test(p), f + " " + p); });
  });
});

test("the Overview loads every tile file before the board adopts them", function () {
  var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  var board = html.search(/src="board\.js/), logic = html.search(/src="calendar-logic\.js/);
  ["tile-today.js", "tile-activity.js", "tile-usage.js", "tile-approvals.js", "tile-calendar.js"].forEach(function (f) {
    var at = html.search(new RegExp('src="' + f.replace(".", "\\.") + "[?\"]"));
    assert.ok(at > logic && at < board, f + " is after calendar-logic.js and before the board");
  });
});

console.log("\n" + passed + " passed");
