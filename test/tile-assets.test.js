// Coverage for tile-assets.js's pure helpers (the Assets & services tile behind /reg/*): the numbers on the tile, the
// expiry wording, filtering and grouping the register, and the form's translation into a request.
//
//   node test/tile-assets.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var A = require(path.join(__dirname, "..", "tile-assets.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.parse("2026-10-27T10:00:00Z");
function asset(over) { return Object.assign({ id: "as_aaaaaaaaaa", kind: "server", name: "app02", owner: "Nathan", location: "Home lab", runs: "Ollama", criticality: "high", expires: "", dateState: "", costCents: null, costPeriod: "", currency: "AUD", runbook: "", link: "", monitorId: "", renewalItem: "", watch: "", notes: "", rdapExpires: "", rdapNote: "" }, over || {}); }

test("the tile's numbers come from the summary, and an empty register reads as zero, not an error", function () {
  var g = A.glance({ assets: { count: 20, neededCount: 7, expiring: [{ name: "x", daysLeft: 5 }, { name: "y", daysLeft: 40 }], totals: [{ currency: "AUD", monthlyCents: 4200, annualCents: 50400 }] } });
  assert.deepStrictEqual([g.count, g.needed, g.expiring, g.soonestDays, g.costMonthly, g.annual], [20, 7, 2, 5, "$42", "$504"]);
  var none = A.glance(null);
  assert.deepStrictEqual([none.count, none.needed, none.expiring, none.soonestDays, none.costMonthly], [0, 0, 0, null, ""]);
  var two = A.glance({ assets: { count: 2, neededCount: 0, expiring: [], totals: [{ currency: "AUD", monthlyCents: 1000, annualCents: 12000 }, { currency: "USD", monthlyCents: 500, annualCents: 6000 }] } });
  assert.strictEqual(two.costMonthly, "$10 + $5 USD");
});

test("what is still needed is said in a sentence", function () {
  assert.strictEqual(A.needText([]), "");
  assert.strictEqual(A.needText(["cost"]), "needs a cost");
  assert.strictEqual(A.needText(["expires", "cost"]), "needs a date and a cost");
  assert.strictEqual(A.needText(["expires", "cost", "owner"]), "needs a date, a cost and an owner");
});

test("an expiry says when, how soon, and where the date came from", function () {
  var reg = A.expiryModel(asset({ kind: "domain", rdapExpires: "2026-11-05", expires: "2026-12-01" }), NOW);
  assert.strictEqual(reg.source, "registrar");
  assert.ok(/^5 Nov 2026 \(in 9 days\)$/.test(reg.text), reg.text);
  assert.strictEqual(reg.tone, "attn");
  var typed = A.expiryModel(asset({ expires: "2027-12-01", dateState: "known" }), NOW);
  assert.strictEqual(typed.source, ""); assert.strictEqual(typed.tone, "ok");
  assert.strictEqual(A.expiryModel(asset({ expires: "2027-12-01", dateState: "estimated" }), NOW).source, "estimated");
  var late = A.expiryModel(asset({ expires: "2026-10-20" }), NOW);
  assert.strictEqual(late.tone, "alert"); assert.ok(/7 days ago/.test(late.text));
  assert.deepStrictEqual(A.expiryModel(asset({ dateState: "auto" }), NOW), { text: "Renews itself", tone: "", source: "" });
  assert.deepStrictEqual(A.expiryModel(asset(), NOW), { text: "No date", tone: "attn", source: "" });
});

test("a cost reads as free, a price with its period, or nothing", function () {
  assert.strictEqual(A.costLine(asset({ costCents: 0 })), "Free");
  assert.strictEqual(A.costLine(asset({ costCents: 2500, costPeriod: "year" })), "$25 a year");
  assert.strictEqual(A.costLine(asset({ costCents: 1250, costPeriod: "month" })), "$12.50 a month");
  assert.strictEqual(A.costLine(asset({ costCents: 9900, costPeriod: "once" })), "$99 once");
  assert.strictEqual(A.costLine(asset({ costCents: 100, currency: "USD", costPeriod: "month" })), "$1 USD a month");
  assert.strictEqual(A.costLine(asset()), "");
});

test("the register can be searched and filtered, and is grouped by kind in a fixed order", function () {
  var list = [asset({ name: "Zed", kind: "app" }), asset({ name: "app02" }), asset({ name: "barnyard.site", kind: "domain", runs: "Every site" }), asset({ name: "Cloudflare", kind: "account", owner: "Sam" })];
  assert.deepStrictEqual(A.filterAssets(list, { q: "every" }).map(function (a) { return a.name; }), ["barnyard.site"]);
  assert.deepStrictEqual(A.filterAssets(list, { q: "SAM" }).map(function (a) { return a.name; }), ["Cloudflare"]);
  assert.deepStrictEqual(A.filterAssets(list, { kind: "app" }).map(function (a) { return a.name; }), ["Zed"]);
  assert.strictEqual(A.filterAssets(list, { q: "nothing like this" }).length, 0);
  assert.strictEqual(A.filterAssets(list, {}).length, 4);
  assert.deepStrictEqual(A.groupByKind(list).map(function (g) { return g.kind; }), ["server", "domain", "account", "app"]);
  assert.strictEqual(A.groupByKind(list)[2].label, "Accounts and tenants");
  assert.deepStrictEqual(A.groupByKind([]), []);
});

test("the form shows an asset's values as text, cost in dollars, and a blank form starts as a monthly server", function () {
  var v = A.formValues(asset({ costCents: 1250, costPeriod: "year", expires: "2027-01-01" }));
  assert.strictEqual(v.cost, "12.5"); assert.strictEqual(v.costPeriod, "year"); assert.strictEqual(v.expires, "2027-01-01");
  var blank = A.formValues(null);
  assert.deepStrictEqual([blank.kind, blank.name, blank.cost, blank.costPeriod], ["server", "", "", "month"]);
  assert.strictEqual(A.formValues(asset()).costPeriod, "month", "no cost: a monthly period is offered");
  assert.strictEqual(A.formValues(asset({ costCents: 0 })).cost, "0", "free is shown as 0, not empty");
});

test("saving a new asset sends everything, with the cost in cents and a domain's watch name", function () {
  var vals = A.formValues(null);
  vals.name = "  barnyard.site "; vals.kind = "domain"; vals.cost = "25"; vals.costPeriod = "year"; vals.watch = " barnyard.site "; vals.owner = "Nathan";
  var r = A.formToBody(vals, null);
  assert.strictEqual(r.body.name, "barnyard.site");
  assert.strictEqual(r.body.kind, "domain");
  assert.strictEqual(r.body.costCents, 2500);
  assert.strictEqual(r.body.costPeriod, "year");
  assert.strictEqual(r.body.watch, "barnyard.site");
  vals.kind = "server";
  assert.strictEqual(A.formToBody(vals, null).body.watch, "", "only a domain is watched");
});

test("saving a change sends only what changed", function () {
  var cur = asset({ costCents: 1000, costPeriod: "month", owner: "Nathan" });
  var vals = A.formValues(cur);
  assert.deepStrictEqual(A.formToBody(vals, cur).body, {});
  vals.owner = "Sam";
  assert.deepStrictEqual(A.formToBody(vals, cur).body, { owner: "Sam" });
  vals.cost = "";
  var cleared = A.formToBody(vals, cur).body;
  assert.strictEqual(cleared.costCents, null);
  assert.ok(!("costPeriod" in cleared), "no period without a cost");
  vals = A.formValues(cur); vals.costPeriod = "year";
  assert.deepStrictEqual(A.formToBody(vals, cur).body, { costPeriod: "year" });
});

test("a bad cost or an empty name is caught before anything is sent, naming the field", function () {
  var vals = A.formValues(null);
  vals.name = "x"; vals.cost = "twelve";
  var r = A.formToBody(vals, null);
  assert.strictEqual(r.field, "cost"); assert.ok(/plain amount/.test(r.error));
  vals.cost = ""; vals.name = "   ";
  var n = A.formToBody(vals, null);
  assert.strictEqual(n.field, "name");
});

test("the tile is described for the Overview board with the same field names as its catalogue", function () {
  var d = A.descriptor;
  assert.strictEqual(d.id, "assets"); assert.strictEqual(d.ownerOnly, true); assert.strictEqual(d.permission, "tile.assets");
  ["title", "about", "w", "h", "minW", "minH", "maxW", "maxH"].forEach(function (k) { assert.ok(d[k] !== undefined, k); });
  assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH);
});

test("the tile only reads and writes the registry's own routes", function () {
  var src = fs.readFileSync(path.join(root, "tile-assets.js"), "utf8");
  var paths = (src.match(/"\/reg\/[^"]*"/g) || []).map(function (p) { return p.replace(/"/g, "").replace(/\/as_.*$/, ""); });
  assert.ok(paths.length >= 5);
  paths.forEach(function (p) { assert.ok(/^\/reg\/(summary|assets|seed|domains\/check)/.test(p), p); });
  assert.ok(!/\/ops\/|\/mon\//.test(src.replace(/\/\/[^\n]*/g, "")), "no other API");
});

test("free accounts, subscriptions and licences are left out of the renewing list; free certificates and domains are not", function () {
  var exp = [
    { id: "a1", name: "GitHub", kind: "account", daysLeft: 17 }, { id: "a2", name: "Cloudflare", kind: "account", daysLeft: 34 },
    { id: "a3", name: "Free cert", kind: "certificate", daysLeft: 20 }, { id: "a4", name: "Flagged", kind: "subscription", daysLeft: 9, free: true }
  ];
  var byId = { a1: { costCents: 0 }, a2: { costCents: 500 }, a3: { costCents: 0 } };
  var r = A.renewals(exp, byId);
  assert.deepStrictEqual(r.list.map(function (e) { return e.name; }), ["Cloudflare", "Free cert"]);
  assert.strictEqual(r.freeCount, 2);
  assert.strictEqual(A.renewals(exp, null).freeCount, 1, "without the register only an explicit free flag counts: nothing is hidden by guesswork");
  var g = A.glance({ assets: { count: 4, neededCount: 0, expiring: exp, totals: [] } }, byId);
  assert.deepStrictEqual([g.expiring, g.freeCount, g.soonestDays], [2, 2, 34]);
  var m = A.expiryModel({ kind: "account", costCents: 0, expires: "2026-11-13", dateState: "estimated" }, NOW);
  assert.deepStrictEqual([m.tone, /in \d+ days/.test(m.text), /^Free, no renewal/.test(m.text)], ["", false, true], "no countdown and no warning colour on a free account");
});

test("the status line is red inside a week, amber while there is anything to do, green when there is nothing", function () {
  assert.strictEqual(A.statusLine({ renewing: [{ daysLeft: 2 }], expiring: 1, needed: 0 }).tone, "alert");
  assert.strictEqual(A.statusLine({ renewing: [{ daysLeft: 20 }], expiring: 1, needed: 0 }).tone, "attn");
  assert.strictEqual(A.statusLine({ renewing: [], expiring: 0, needed: 3 }).tone, "attn");
  assert.deepStrictEqual([A.statusLine({ renewing: [], expiring: 0, needed: 0 }).tone, A.statusLine({ renewing: [], expiring: 0, needed: 0 }).pill], ["ok", "All good"]);
});

console.log("\n" + passed + " passed");
