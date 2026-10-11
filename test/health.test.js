// Coverage for health.js's pure helpers (the page behind GET /hub/health): sizes, percentages, the service rows,
// the map cache sentence, the per-day request rows. The DOM and network parts were exercised in a real browser
// against a stand-in for the Worker.
//
//   node test/health.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Health = require(path.join(__dirname, "..", "health.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();

test("sizes read like a person would say them", function () {
  assert.strictEqual(Health.formatBytes(0), "0 B");
  assert.strictEqual(Health.formatBytes(900), "900 B");
  assert.strictEqual(Health.formatBytes(1536), "1.5 KB");
  assert.strictEqual(Health.formatBytes(20480), "20 KB");
  assert.strictEqual(Health.formatBytes(5 * 1048576), "5.0 MB");
  assert.strictEqual(Health.formatBytes(250 * 1048576), "250 MB");
  assert.strictEqual(Health.formatBytes(3 * 1073741824), "3.00 GB");
  assert.strictEqual(Health.formatBytes(-4), "0 B");
  assert.strictEqual(Health.thousands(1234567), "1,234,567");
  assert.strictEqual(Health.thousands(12), "12");
});

test("how full a limit is: whole percent, amber from 70, red from 90, and a missing limit is 0", function () {
  assert.strictEqual(Health.percentOf(25000, 100000), 25);
  assert.strictEqual(Health.percentOf(150000, 100000), 150);
  assert.strictEqual(Health.percentOf(5, 0), 0);
  assert.strictEqual(Health.limitTone(10), "ok");
  assert.strictEqual(Health.limitTone(70), "attn");
  assert.strictEqual(Health.limitTone(89), "attn");
  assert.strictEqual(Health.limitTone(90), "alert");
});

test("service rows: online is green, offline is amber with when it was last seen, switched off is calm, unreadable is unknown", function () {
  var rows = Health.serviceRows({
    runner: { enabled: true, online: true, queued: 2, running: 1 },
    engine: { enabled: true, online: false, lastSeen: NOW - 25 * 60000, queued: 3 },
    mapgen: { configured: true, ok: true, generatorVersion: "4", active: 1, queued: 0, ms: 38 }
  }, NOW);
  assert.deepStrictEqual(rows.map(function (r) { return [r.id, r.state, r.tone]; }), [["runner", "Online", "ok"], ["engine", "Offline", "attn"], ["mapgen", "Up", "ok"]]);
  assert.strictEqual(rows[0].detail, "2 messages waiting, 1 running");
  assert.strictEqual(rows[1].detail, "Last seen 25 min ago. 3 jobs waiting.");
  assert.strictEqual(rows[2].detail, "Version 4, 1 rendering, answered in 38 ms.");

  var calm = Health.serviceRows({ runner: { enabled: false }, engine: { enabled: true, error: true }, mapgen: { configured: false } }, NOW);
  assert.deepStrictEqual(calm.map(function (r) { return [r.state, r.tone]; }), [["Switched off", ""], ["Unknown", ""], ["Not set up", ""]]);
  var down = Health.serviceRows({ runner: { enabled: true, online: false }, engine: { enabled: false }, mapgen: { configured: true, ok: false } }, NOW);
  assert.strictEqual(down[0].detail, "Never seen.");
  assert.deepStrictEqual([down[2].state, down[2].tone], ["Not answering", "alert"]);
});

test("the map cache sentence: counts, plural, the + when it stopped counting, and nothing when it is not available", function () {
  assert.strictEqual(Health.cacheText({ configured: true, maps: 12, objects: 30, bytes: 5 * 1048576, truncated: false }), "12 maps, 30 files, 5.0 MB.");
  assert.strictEqual(Health.cacheText({ configured: true, maps: 1, objects: 3, bytes: 2048, truncated: false }), "1 map, 3 files, 2.0 KB.");
  assert.strictEqual(Health.cacheText({ configured: true, maps: 1700, objects: 5000, bytes: 1073741824, truncated: true }), "1700+ maps, 5,000 files, 1.00 GB (counted up to the first 5,000 files).");
  assert.strictEqual(Health.cacheText({ configured: false }), null);
  assert.strictEqual(Health.cacheText(null), null);
  assert.strictEqual(Health.cacheText({ configured: true, error: true }), "Could not be read just now.");
});

test("day rows: newest first as sent, with the share of the limit, its colour and the busiest area first", function () {
  var counters = {
    enabled: true, limit: 100000,
    days: [
      { day: "2026-10-11", total: { requests: 75000, e4: 40, e5: 2 }, areas: { ops: { requests: 20000 }, hub: { requests: 55000 } } },
      { day: "2026-10-10", total: { requests: 1200, e4: 0, e5: 0 }, areas: { kb: { requests: 1200 } } }
    ]
  };
  var rows = Health.dayRows(counters);
  assert.deepStrictEqual(rows.map(function (r) { return [r.day, r.pct, r.tone]; }), [["2026-10-11", 75, "attn"], ["2026-10-10", 1, "ok"]]);
  assert.deepStrictEqual(rows[0].areas.map(function (a) { return a.title; }), ["Hub", "Ops board"]);
  assert.deepStrictEqual(Health.dayRows({ enabled: false }), []);
  assert.deepStrictEqual(Health.dayRows(null), []);
});

test("event rows: when, name and route; nothing while the counters are off", function () {
  var rows = Health.eventRows({ enabled: true, events: [{ ts: NOW - 2 * 3600000, evt: "auth_fail", route: "/ops/board" }, { ts: NOW - 10000, evt: "strong_required" }] }, NOW);
  assert.deepStrictEqual(rows, [{ when: "2 h ago", evt: "auth_fail", route: "/ops/board" }, { when: "just now", evt: "strong_required", route: "" }]);
  assert.deepStrictEqual(Health.eventRows({ enabled: false }, NOW), []);
});

test("the page is wired: strict CSP, no inline script or style, and the Overview links to it", function () {
  var html = fs.readFileSync(path.join(root, "health.html"), "utf8");
  assert.ok(html.indexOf("script-src 'self'") !== -1 && html.indexOf("style-src 'self'") !== -1);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/\sstyle=/.test(html), "no inline style attribute");
  assert.ok(html.indexOf("connect-src 'self' https://api.barnyard.site") !== -1);
  var js = fs.readFileSync(path.join(root, "health.js"), "utf8");
  assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write/.test(js), "server text never reaches innerHTML");
  var ov = fs.readFileSync(path.join(root, "overview.js"), "utf8");
  assert.ok(ov.indexOf('["System health", "health.html"]') !== -1);
});

console.log("\n" + passed + " tests passed");
