// The Microsoft 365 page: the words and rules in m365-logic.js, the page's structure (no inline script or style, no innerHTML, the
// rules loaded before the page) and the sidebar entry.
//
//   node test/m365.test.js
//
// Plain Node, standard library only.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var M = require(path.join(root, "m365-logic.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.UTC(2026, 9, 30, 2, 0, 0);
var DAY = 86400000;

// ---- states ---------------------------------------------------------------------------------------------------------------

test("a card that needs a permission names it, a premium-only one says no permission will help, an error says what happened", function () {
  var p = M.stateModel("policies", { state: "needs_permission", needs: ["Policy.Read.All"] });
  assert.strictEqual(p.tone, "attn");
  assert.ok(/Policy\.Read\.All/.test(p.text) && /admin consent/.test(p.text) && /Refresh/.test(p.text));
  assert.deepStrictEqual(p.needs, ["Policy.Read.All"]);
  var two = M.stateModel("accounts", { state: "needs_permission", needs: ["A.Read.All", "B.Read.All"] });
  assert.ok(/A\.Read\.All and B\.Read\.All/.test(two.text) && /permissions/.test(two.head));
  var prem = M.stateModel("mfa", { state: "needs_premium" });
  assert.ok(/P1 or P2/.test(prem.head) && /will not change that/.test(prem.text));
  assert.strictEqual(M.stateModel("score", { state: "not_available" }).head, "Not available");
  var err = M.stateModel("roles", { state: "error", reason: "auth", detail: "AADSTS7000215" });
  assert.strictEqual(err.tone, "alert");
  assert.ok(/AADSTS7000215/.test(err.text) && !/numbers below/.test(err.text));
  assert.strictEqual(M.stateModel("roles", { state: "ok" }), null, "an ok card has no state to explain");
  assert.strictEqual(M.stateModel("roles", undefined).head, "Not read yet");
});

test("a stale card says Microsoft could not be read and the old numbers are shown", function () {
  assert.ok(/last good read/.test(M.staleNote({ fromEarlier: true })));
  assert.strictEqual(M.staleNote({ state: "ok", stale: { d60: 2, d90: 1, rows: [] } }), "", "the accounts card has its own list called stale: that is not the flag");
  assert.strictEqual(M.staleNote({ state: "ok" }), "");
});

test("why a whole read failed, in words, with Microsoft's own code when there is one", function () {
  assert.ok(/could not sign in \(AADSTS7000215\)/.test(M.failureText({ reason: "auth", detail: "AADSTS7000215" })));
  assert.ok(/slow down/.test(M.failureText({ reason: "throttled" })));
  assert.ok(/could not be reached/.test(M.failureText({ reason: "unavailable" })));
  assert.strictEqual(M.failureText(null), "");
});

test("errorText words each refusal, and an unknown code still says something", function () {
  assert.ok(/Sign in again/.test(M.errorText({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/only for the hub owner/.test(M.errorText({ error: "forbidden" }, 403)));
  assert.ok(/Could not reach/.test(M.errorText({}, 0)));
  assert.strictEqual(M.errorText({ error: "weird" }, 500), "That did not work (weird).");
  assert.strictEqual(M.errorText(null, 500), "That did not work (error 500).");
});

// ---- the cards ------------------------------------------------------------------------------------------------------------

test("licences: unused paid licences are flagged, free ones are not, over-use is an alert", function () {
  var s = { unusedTotal: 2, paidSkus: 2, skus: [
    { name: "Business Standard", part: "O365_BUSINESS_PREMIUM", bought: 5, assigned: 3, unused: 2, over: 0, free: false },
    { name: "Power Automate Free", part: "FLOW_FREE", bought: 10000, assigned: 2, unused: 9998, over: 0, free: true },
    { name: "Exchange", part: "EXCHANGEENTERPRISE", bought: 1, assigned: 3, unused: 0, over: 2, free: false }
  ] };
  var rows = M.licenceRows(s);
  assert.deepStrictEqual(rows.map(function (r) { return r.tone; }), ["attn", "", "alert"]);
  assert.strictEqual(rows[1].note, "free");
  assert.strictEqual(rows[2].note, "2 more used than bought");
  assert.ok(/2 paid licences are unused/.test(M.licenceHead(s).head));
  assert.strictEqual(M.licenceHead({ unusedTotal: 0, paidSkus: 3 }).tone, "ok");
  assert.strictEqual(M.licenceHead({ unusedTotal: 0, paidSkus: 0 }).head, "No paid licences found");
});

test("MFA: an admin without it is an alert, full cover is ok, nothing to check is said so", function () {
  assert.strictEqual(M.mfaHead({ pct: 33, members: 3, registered: 1, adminsWithout: 1 }).tone, "alert");
  assert.ok(/1 admin has not/.test(M.mfaHead({ pct: 33, members: 3, registered: 1, adminsWithout: 1 }).text));
  assert.strictEqual(M.mfaHead({ pct: 100, members: 3, registered: 3, adminsWithout: 0 }).tone, "ok");
  assert.strictEqual(M.mfaHead({ pct: 80, members: 5, registered: 4, adminsWithout: 0 }).tone, "attn");
  assert.strictEqual(M.mfaHead({ pct: null }).head, "No accounts to check");
});

test("accounts: 90 days is an alert, 60 an attention, no sign-in dates is said rather than shown as none stale", function () {
  var base = { members: 6, guests: 1, disabled: 1, truncated: false };
  assert.strictEqual(M.accountsHead(Object.assign({ stale: { d60: 2, d90: 1 } }, base)).tone, "alert");
  assert.strictEqual(M.accountsHead(Object.assign({ stale: { d60: 2, d90: 0 } }, base)).tone, "attn");
  assert.strictEqual(M.accountsHead(Object.assign({ stale: { d60: 0, d90: 0 } }, base)).head, "No stale accounts");
  assert.strictEqual(M.accountsHead(Object.assign({ stale: null }, base)).head, "Sign-in dates not available");
  assert.ok(/cut short/.test(M.accountsHead(Object.assign({}, base, { stale: { d60: 0, d90: 0 }, truncated: true })).text));
  assert.ok(/Entra ID P1 or P2/.test(M.signInNote({ signIn: false, signInState: "needs_premium" })));
  assert.ok(/AuditLog\.Read\.All/.test(M.signInNote({ signIn: false, signInState: "needs_permission", signInNeeds: ["AuditLog.Read.All"] })));
  assert.strictEqual(M.signInNote({ signIn: true }), "");
  var rows = M.peopleRows([{ name: "Sam", upn: "sam@x.com", daysSince: 100, age: 500, licences: 1 }, { name: "", upn: "nina@x.com", daysSince: null, age: 1 }]);
  assert.deepStrictEqual([rows[0].since, rows[0].tone, rows[1].name, rows[1].since, rows[1].age], ["100 days", "alert", "nina@x.com", "never", "1 day"]);
});

test("roles: two to four Global Administrators is fine, groups and scoped roles are labelled", function () {
  assert.strictEqual(M.rolesHead({ globalAdmins: 2, privilegedPeople: 3 }).tone, "ok");
  assert.strictEqual(M.rolesHead({ globalAdmins: 7, privilegedPeople: 7 }).tone, "attn");
  assert.strictEqual(M.rolesHead({ globalAdmins: 1, privilegedPeople: 1 }).tone, "attn");
  assert.ok(/group: its members are not listed/.test(M.memberText({ type: "group", name: "Break glass" })));
  assert.ok(/limited scope/.test(M.memberText({ type: "user", name: "A", scoped: true })));
  assert.strictEqual(M.memberText({ type: "user", name: "", upn: "a@x.com" }), "a@x.com");
});

test("Conditional Access and the secure score", function () {
  assert.strictEqual(M.policiesHead({ total: 0 }).tone, "attn");
  assert.ok(/1 policy is on, 1 report-only, 1 off/.test(M.policiesHead({ total: 3, on: 1, reportOnly: 1, off: 1 }).text));
  assert.strictEqual(M.scoreHead({ current: 41.5, max: 100, pct: 42, at: NOW }).tone, "attn");
  assert.strictEqual(M.scoreHead({ current: 80, max: 100, pct: 80 }).tone, "ok");
  assert.strictEqual(M.scoreHead({ current: 10, max: 100, pct: 10 }).tone, "alert");
  var g = M.gapRows({ gaps: [{ title: "Require MFA", gap: 6, service: "AzureAD", impact: "Moderate", cost: "Low" }] });
  assert.deepStrictEqual([g[0].title, g[0].gap, g[0].meta], ["Require MFA", 6, "AzureAD · user impact: moderate · effort: low"]);
});

test("the strip leaves out a number whose card is not ready, and marks the ones that need a look", function () {
  var s = M.stats({ admins: 3, globalAdmins: 6, withoutMfa: 2, stale60: 0, guests: 4, unusedLicences: null });
  assert.deepStrictEqual(s.map(function (x) { return [x.label, x.value, x.tone]; }), [["Admins", "3", "attn"], ["People without MFA", "2", "attn"], ["Not signed in for 60 days", "0", "ok"], ["Guests", "4", ""]]);
  assert.deepStrictEqual(M.stats(null), []);
});

test("the access review: none yet, due, and done with the days left", function () {
  assert.strictEqual(M.reviewModel(null, NOW).tone, "attn");
  assert.ok(/No review recorded/.test(M.reviewModel({ last: null, due: true }, NOW).head));
  var due = M.reviewModel({ last: { at: NOW - 100 * DAY, note: "ok" }, due: true, daysLeft: -10 }, NOW);
  assert.ok(/due/.test(due.head) && /Note: ok/.test(due.text));
  var done = M.reviewModel({ last: { at: NOW - 10 * DAY }, due: false, daysLeft: 80 }, NOW);
  assert.strictEqual(done.tone, "ok");
  assert.ok(/80 days/.test(done.text));
});

test("the set-up panel shows only when something is missing, and lists each permission once", function () {
  assert.strictEqual(M.setupNeeded({ configured: false }), true);
  assert.strictEqual(M.setupNeeded({ configured: true, snapshot: { sections: { licences: { state: "ok" } } } }), false);
  var data = { configured: true, snapshot: { sections: {
    policies: { state: "needs_permission", needs: ["Policy.Read.All"] },
    roles: { state: "needs_permission", needs: ["Policy.Read.All", "RoleManagement.Read.Directory"] },
    accounts: { state: "ok", signIn: false, signInState: "needs_permission", signInNeeds: ["AuditLog.Read.All"] }
  } } };
  assert.strictEqual(M.setupNeeded(data), true);
  // in the order the cards are drawn (accounts, roles, policies), each name once
  assert.deepStrictEqual(M.missingPermissions(data), ["AuditLog.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory"]);
});

test("the page names six cards in the order they are drawn", function () {
  assert.deepStrictEqual(M.ORDER, ["licences", "mfa", "accounts", "roles", "policies", "score"]);
  M.ORDER.forEach(function (id) { assert.ok(M.TITLES[id], id + " has a title"); });
});

// ---- the page --------------------------------------------------------------------------------------------------------------

test("m365.html: the shell's container and title row with nothing under the title, no inline script or style, the rules before the page", function () {
  var html = fs.readFileSync(path.join(root, "m365.html"), "utf8");
  assert.ok(/<main id="page" class="content"/.test(html) && /<body[^>]*\bdata-wide\b/.test(html) && /<body[^>]*data-shell="m365"/.test(html));
  assert.ok(/<div class="page-head">\s*<div>\s*<h1>Microsoft 365<\/h1>\s*<\/div>/.test(html), "the title is followed by nothing but the tools");
  assert.ok(/script-src 'self'/.test(html) && /connect-src 'self' https:\/\/api\.barnyard\.site/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/ style=/.test(html), "no inline style attribute");
  assert.ok(html.indexOf("m365-logic.js") !== -1 && html.indexOf("m365-logic.js") < html.indexOf("m365.js"), "the rules load first");
  assert.ok(html.indexOf("shell.js") < html.indexOf("m365-logic.js"));
});

test("m365.js puts nothing from the server in through innerHTML, and talks only to the Worker's /m365 routes", function () {
  var js = fs.readFileSync(path.join(root, "m365.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js));
  assert.ok(!/localStorage|sessionStorage/.test(js), "nothing kept in the browser");
  var urls = js.match(/fetch\([^)]*\)/g) || [];
  assert.strictEqual(urls.length, 1);
  assert.ok(/API \+ "\/m365" \+ path/.test(js));
  var paths = (js.match(/send\("(GET|POST)", "[^"]+"/g) || []).map(function (s) { return s.replace(/send\(/, ""); }).sort();
  assert.deepStrictEqual(paths, ['"GET", "/health"', '"POST", "/refresh"', '"POST", "/review"']);
});

test("m365.css does not cap the page root or redefine the title row", function () {
  var css = fs.readFileSync(path.join(root, "m365.css"), "utf8");
  assert.ok(!/^#m3-root\s*\{[^}]*max-width/m.test(css));
  assert.ok(!/^\.page-head\s*\{/m.test(css));
});

// ---- the sidebar ----------------------------------------------------------------------------------------------------------

test("the sidebar has a Microsoft 365 entry: owner only, pointing at m365.html, with its own icon and palette words", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var items = shell.match(/\{ id: "[a-z0-9]+", title: "[^"]+", group: "[^"]*", icon: "[a-z]+"[^}]*\}/g) || [];
  var entry = items.filter(function (it) { return /id: "m365"/.test(it); });
  assert.strictEqual(entry.length, 1, "exactly one menu entry");
  var e = entry[0];
  assert.ok(/title: "Microsoft 365"/.test(e) && /group: "Work"/.test(e));
  assert.ok(/path: "m365\.html"/.test(e) && /local: "m365\.html"/.test(e), "points at the hub's page, here and from the other sites");
  assert.ok(/ownerOnly: true/.test(e));
  assert.ok(/perm: "m365\.view"/.test(e), "the Users page lists the area, so it can take it away");
  assert.ok(/keywords: "[^"]*licen[^"]*mfa[^"]*"/.test(e), "found by licences and MFA");
  var icon = /icon: "([a-z]+)"/.exec(e)[1];
  assert.ok(new RegExp("\\n\\s+" + icon + ": '<").test(shell), "the icon " + icon + " is drawn");
  assert.ok(shell.indexOf('id: "services"') < shell.indexOf('id: "m365"') && shell.indexOf('id: "m365"') < shell.indexOf('id: "users"'), "in the Work group, between Services and Users");
  assert.ok(/m365\\\.html\$\/\.test\(location\.pathname\)\) return "m365"/.test(shell), "the menu lights it on its own page");
});

console.log("\n" + passed + " passed");
