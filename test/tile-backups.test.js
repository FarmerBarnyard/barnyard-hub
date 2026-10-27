// Coverage for tile-backups.js's pure helpers (the Backups tile behind /reg/backups): the numbers on the tile, what needs a look, the
// words under a job, the job form and the restore-test form, and the lines offered for the job's script.
//
//   node test/tile-backups.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var T = require(path.join(__dirname, "..", "tile-backups.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.parse("2026-10-27T10:00:00Z");
var HOUR = 3600000;
function job(over) { return Object.assign({ id: "bj_aaaaaaaaaa", name: "Nightly VM backup", what: "All VMs", dest: "NAS", schedule: "Daily 01:00", retention: "30 days", owner: "Nathan", runbook: "", expectedHours: 26, enabled: true, copy3: false, media2: false, offsite1: false, notes: "", hasToken: true, tokenCreatedAt: NOW - 50 * HOUR, lastOkAt: NOW - 3 * HOUR, lastFailAt: null, lastStatus: "ok" }, over || {}); }

test("a job's state and restore state have words and a tone", function () {
  assert.deepStrictEqual(T.stateInfo("ok"), { label: "On time", tone: "ok" });
  assert.strictEqual(T.stateInfo("overdue").tone, "alert");
  assert.strictEqual(T.stateInfo("unmonitored").label, "No check-in link");
  assert.strictEqual(T.stateInfo("odd").label, "odd");
  assert.strictEqual(T.restoreInfo("never").tone, "attn");
  assert.strictEqual(T.restoreInfo("ok").label, "Restore proven");
  assert.strictEqual(T.restoreInfo("failed").tone, "alert");
});

test("the tile's numbers come from the summary, and no summary reads as no backups", function () {
  var g = T.glance({ backups: { count: 5, by: { ok: 2, overdue: 1, failing: 1, unmonitored: 1, paused: 0, waiting: 0 }, attention: [{ name: "B", why: "overdue" }, { name: "C", why: "restore_never" }, { name: "D", why: "failing" }, { name: "E", why: "restore_overdue" }], nextRestore: { name: "B", nextDue: "2026-10-01", daysLeft: -26 }, threeTwoOne: 1 } });
  assert.deepStrictEqual([g.count, g.ok, g.needLook, g.unproven, g.threeTwoOne, g.unmonitored], [5, 2, 2, 2, 1, 1]);
  assert.strictEqual(g.next.name, "B");
  var none = T.glance(null);
  assert.deepStrictEqual([none.count, none.ok, none.needLook, none.unproven, none.next], [0, 0, 0, 0, null]);
  assert.strictEqual(T.glance({}).count, 0);
});

test("what needs a look reads in a short phrase, with the date it began where known", function () {
  var rows = T.attentionRows({ backups: { attention: [{ name: "B", why: "overdue", since: Date.parse("2026-10-26T04:00:00Z") }, { name: "C", why: "restore_never", since: null }, { name: "D", why: "failing", since: Date.parse("2026-10-27T01:00:00Z") }, { name: "E", why: "restore_failed" }, { name: "F", why: "restore_overdue" }] } }, NOW);
  assert.deepStrictEqual(rows.map(function (r) { return [r.name, r.text, r.tone]; }), [
    ["B", "Overdue since 26 Oct 2026", "alert"], ["C", "Restore never tested", "attn"], ["D", "Failing since 27 Oct 2026", "alert"],
    ["E", "Last restore test did not fully work", "alert"], ["F", "Restore test overdue", "alert"]]);
  assert.deepStrictEqual(T.attentionRows(null, NOW), []);
});

test("the words under a job say when it last ran, or what to do if it is not watched", function () {
  assert.ok(/Not watched: make a check-in link/.test(T.runLine(job({ hasToken: false }), NOW)));
  assert.strictEqual(T.runLine(job({ lastOkAt: null, tokenCreatedAt: NOW - 2 * HOUR }), NOW), "Link made 2 h ago; no check-in yet.");
  assert.strictEqual(T.runLine(job(), NOW), "Last good run 3 h ago.");
  assert.strictEqual(T.runLine(job({ lastStatus: "warn" }), NOW), "Last good run 3 h ago (with a warning).");
  assert.strictEqual(T.runLine(job({ lastStatus: "fail", lastFailAt: NOW - HOUR }), NOW), "Reported a failure 1 h ago; last good run 3 h ago.");
  assert.strictEqual(T.runLine(job({ lastStatus: "fail", lastFailAt: NOW - 5 * HOUR }), NOW), "Last good run 3 h ago.", "a later good run clears the failure");
});

test("a new job sends everything, with the hours as a number", function () {
  var v = T.formValues(null);
  assert.deepStrictEqual([v.name, v.expectedHours, v.enabled, v.copy3], ["", "26", true, false]);
  v.name = "  Veeam nightly "; v.dest = "NAS"; v.expectedHours = "48"; v.offsite1 = true;
  var r = T.formToBody(v, null);
  assert.strictEqual(r.body.name, "Veeam nightly");
  assert.strictEqual(r.body.expectedHours, 48);
  assert.strictEqual(r.body.offsite1, true);
  assert.strictEqual(r.body.copy3, false);
  assert.strictEqual(r.body.dest, "NAS");
});

test("a change sends only what changed", function () {
  var cur = job({ copy3: true });
  var v = T.formValues(cur);
  assert.deepStrictEqual(T.formToBody(v, cur).body, {});
  v.retention = "90 days"; v.media2 = true; v.expectedHours = "30";
  assert.deepStrictEqual(T.formToBody(v, cur).body, { retention: "90 days", expectedHours: 30, media2: true });
  v = T.formValues(cur); v.enabled = false;
  assert.deepStrictEqual(T.formToBody(v, cur).body, { enabled: false });
});

test("a missing name or a silly number of hours is caught before anything is sent", function () {
  var v = T.formValues(null);
  assert.strictEqual(T.formToBody(v, null).field, "name");
  v.name = "x"; v.expectedHours = "0";
  assert.strictEqual(T.formToBody(v, null).field, "expectedHours");
  v.expectedHours = "745"; assert.strictEqual(T.formToBody(v, null).field, "expectedHours");
  v.expectedHours = "1.5"; assert.strictEqual(T.formToBody(v, null).field, "expectedHours");
  v.expectedHours = "abc"; assert.strictEqual(T.formToBody(v, null).field, "expectedHours");
  v.expectedHours = "744"; assert.ok(T.formToBody(v, null).body);
});

test("a restore test needs a date, what was restored and a result; the next date is optional but cannot be earlier", function () {
  var good = T.testToBody({ testedOn: "2026-10-01", what: " One VM ", result: "ok", by: "", notes: "", nextDue: "" });
  assert.deepStrictEqual(good.body, { testedOn: "2026-10-01", what: "One VM", result: "ok" });
  var full = T.testToBody({ testedOn: "2026-10-01", what: "A mailbox", result: "partial", by: "Nathan", notes: "Two files missing", nextDue: "2026-12-01" });
  assert.deepStrictEqual(full.body, { testedOn: "2026-10-01", what: "A mailbox", result: "partial", by: "Nathan", notes: "Two files missing", nextDue: "2026-12-01" });
  assert.strictEqual(T.testToBody({ testedOn: "", what: "x", result: "ok", by: "", notes: "", nextDue: "" }).field, "testedOn");
  assert.strictEqual(T.testToBody({ testedOn: "2026-10-01", what: "  ", result: "ok", by: "", notes: "", nextDue: "" }).field, "what");
  assert.strictEqual(T.testToBody({ testedOn: "2026-10-01", what: "x", result: "ok", by: "", notes: "", nextDue: "2026-09-01" }).field, "nextDue");
});

test("the lines for the job's script carry the link and the failure variant", function () {
  var s = T.linkSnippets("https://api.barnyard.site/checkin/bk_abc");
  assert.strictEqual(s.length, 3);
  assert.ok(/^curl -fsS -m 20 https:\/\/api\.barnyard\.site\/checkin\/bk_abc$/.test(s[0].text));
  assert.ok(/^Invoke-WebRequest .* https:\/\/api\.barnyard\.site\/checkin\/bk_abc \| Out-Null$/.test(s[1].text));
  assert.ok(/\/bk_abc\/fail$/.test(s[2].text));
});

test("the tile is described for the Overview board and only uses the registry's backup routes", function () {
  var d = T.descriptor;
  assert.strictEqual(d.id, "backups"); assert.strictEqual(d.ownerOnly, true); assert.strictEqual(d.permission, "tile.backups");
  assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH);
  var src = fs.readFileSync(path.join(root, "tile-backups.js"), "utf8");
  var paths = (src.match(/"\/reg\/[^"]*"/g) || []).map(function (p) { return p.replace(/"/g, ""); });
  assert.ok(paths.length >= 6);
  paths.forEach(function (p) { assert.ok(/^\/reg\/(summary|backups|tests)/.test(p), p); });
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(src), "the link is never kept in the browser");
});

console.log("\n" + passed + " passed");
