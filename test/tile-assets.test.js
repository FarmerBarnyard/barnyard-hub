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


// ---- weak links: identity kind, monitors and accepted gaps in the asset form ---------------------------------------------

test("the form offers the identity kind and the two new monitors", function () {
  assert.ok(A.KINDS.some(function (k) { return k[0] === "identity" && k[1] === "Identity app or setting" && k[2] === "Identity apps and settings"; }));
  var order = A.KINDS.map(function (k) { return k[0]; });
  assert.ok(order.indexOf("identity") === order.indexOf("account") + 1);
  assert.strictEqual(A.groupByKind([{ kind: "identity", name: "x" }])[0].label, "Identity apps and settings");
  var src = fs.readFileSync(path.join(__dirname, "..", "tile-assets.js"), "utf8");
  assert.ok(/\["vmh01", "BARNYARDVMH01 \(VMware host\)"\]/.test(src) && /\["worker-api", "Barnyard API \(the Worker\)"\]/.test(src));
});

test("which gaps a kind of asset can accept mirrors the Worker's rules", function () {
  var words = function (kind) { return A.gapsFor(kind).map(function (g) { return g[0]; }); };
  assert.deepStrictEqual(words("server"), ["monitor", "backup", "runbook"]);
  assert.deepStrictEqual(words("app"), ["monitor", "backup", "runbook"]);
  assert.deepStrictEqual(words("network"), ["monitor", "runbook"]);
  assert.deepStrictEqual(words("identity"), ["runbook", "watch"]);
  assert.deepStrictEqual(words("domain"), []);
});

test("accepted gaps: a reason and a review day are required, the day is within 12 months, and what the kind is not asked for is dropped", function () {
  var NOW = Date.parse("2026-11-14T10:00:00Z");
  var ok = A.checkAccepted([{ gap: "watch", reason: "  On   the Calendar ", review: "2027-02-14" }], "identity", NOW);
  assert.deepStrictEqual(ok.value, [{ gap: "watch", reason: "On the Calendar", review: "2027-02-14" }]);
  assert.strictEqual(A.checkAccepted([{ gap: "watch", reason: "", review: "2027-02-14" }], "identity", NOW).field, "accept-watch-reason");
  assert.strictEqual(A.checkAccepted([{ gap: "watch", reason: "x".repeat(141), review: "2027-02-14" }], "identity", NOW).field, "accept-watch-reason");
  assert.strictEqual(A.checkAccepted([{ gap: "watch", reason: "ok", review: "" }], "identity", NOW).field, "accept-watch-review");
  assert.strictEqual(A.checkAccepted([{ gap: "watch", reason: "ok", review: "2027-13-40" }], "identity", NOW).field, "accept-watch-review");
  assert.strictEqual(A.checkAccepted([{ gap: "watch", reason: "ok", review: "2027-11-14" }], "identity", NOW).error, undefined, "exactly 12 months is fine");
  assert.ok(/12 months/.test(A.checkAccepted([{ gap: "watch", reason: "ok", review: "2027-11-15" }], "identity", NOW).error));
  assert.deepStrictEqual(A.checkAccepted([{ gap: "watch", reason: "ok", review: "2027-01-01" }], "server", NOW).value, [], "a server is never asked for a watch");
  assert.strictEqual(A.farthestReview(NOW), "2027-11-14");
  assert.strictEqual(A.defaultReview(NOW), "2027-02-12");
});

test("saving sends acceptedGaps only when they changed, and clearing sends an empty list", function () {
  var cur = asset({ kind: "identity", acceptedGaps: [{ gap: "watch", reason: "On the Calendar", review: "2027-02-14" }] });
  var vals = A.formValues(cur);
  vals.acceptedGaps = [{ gap: "watch", reason: "On the Calendar", review: "2027-02-14" }];
  assert.deepStrictEqual(A.formToBody(vals, cur).body, {}, "unchanged: nothing sent");
  vals.acceptedGaps = [{ gap: "watch", reason: "Calendar renewal", review: "2027-02-14" }];
  assert.deepStrictEqual(A.formToBody(vals, cur).body, { acceptedGaps: [{ gap: "watch", reason: "Calendar renewal", review: "2027-02-14" }] });
  vals.acceptedGaps = [];
  assert.deepStrictEqual(A.formToBody(vals, cur).body, { acceptedGaps: [] });
  var fresh = A.formValues(null);
  fresh.name = "Entra app"; fresh.kind = "identity"; fresh.acceptedGaps = [];
  assert.strictEqual("acceptedGaps" in A.formToBody(fresh, null).body, false, "a new asset with nothing accepted sends nothing");
  fresh.acceptedGaps = [{ gap: "runbook", reason: "Written next month", review: "2027-01-01" }];
  assert.deepStrictEqual(A.formToBody(fresh, null).body.acceptedGaps, [{ gap: "runbook", reason: "Written next month", review: "2027-01-01" }]);
  fresh.acceptedGaps = [{ gap: "runbook", reason: "", review: "2027-01-01" }];
  assert.strictEqual(A.formToBody(fresh, null).field, "accept-runbook-reason", "an empty reason stops the save with its field");
  // a form that does not carry the list (the older callers) is unchanged
  var plain = A.formValues(cur);
  assert.deepStrictEqual(A.formToBody(plain, cur).body, {});
});

test("the accepted-gaps editor is part of the register form, which already needs a recent sign-in to save", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "tile-assets.js"), "utf8");
  assert.ok(/function acceptedEditor\(asset, form\)/.test(src) && /acceptedEditor\(asset, form\)/.test(src));
  assert.ok(/vals\.acceptedGaps = acceptBox\.read\(\)/.test(src), "the form sends the list through formToBody and the same PATCH");
  assert.ok(/K\.call\("PATCH", "\/reg\/assets\/" \+ asset\.id, built\.body\)/.test(src));
  assert.ok(/review\.type = "date"/.test(src) && /review\.max = farthestReview/.test(src), "the day picker stops at 12 months");
  assert.ok(/aria-label/.test(src.slice(src.indexOf("function acceptedEditor"))), "each control is labelled");
  assert.ok(!/innerHTML/.test(src));
  var kit = require(path.join(__dirname, "..", "tile-kit.js"));
  assert.ok(/review day/.test(kit.errorText({ error: "acceptedGaps_review_too_far" }, 400)));
  assert.ok(/accepted-gap reason/.test(kit.errorText({ error: "secret_detected", field: "acceptedGaps.0.reason" }, 422)));
});


console.log("\n" + passed + " passed");
