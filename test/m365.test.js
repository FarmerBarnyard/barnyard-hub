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

// ---- phase 2: the detail inside the cards ----------------------------------------------------------------------------------------

test("admin people: a missing second step or a disabled account is an alert, any other flag an attention, the rest are plain", function () {
  var s = { people: { count: 3, flagged: 2, rows: [
    { name: "Ollie", upn: "o@x.com", roles: ["Global Administrator", "User Administrator"], flags: ["not signed in for 100 days", "no second sign-in step"] },
    { name: "Sam", upn: "s@x.com", roles: ["Exchange Administrator"], flags: ["holds 3 privileged roles"] },
    { name: "", upn: "a@x.com", roles: ["Global Administrator"], flags: [] }
  ] } };
  var rows = M.adminRows(s);
  assert.deepStrictEqual(rows.map(function (r) { return [r.name, r.roles, r.tone]; }), [["Ollie", "Global Administrator, User Administrator", "alert"], ["Sam", "Exchange Administrator", "attn"], ["a@x.com", "Global Administrator", ""]]);
  assert.strictEqual(M.adminsHead(s).tone, "attn");
  assert.ok(/2 admins worth a look/.test(M.adminsHead(s).head) && /Out of 3/.test(M.adminsHead(s).text));
  assert.strictEqual(M.adminsHead({ people: { count: 2, flagged: 0, rows: [] } }).tone, "ok");
  assert.strictEqual(M.adminsHead({}), null, "an older snapshot has no people list: nothing is drawn");
  assert.deepStrictEqual(M.adminRows({}), []);
});

test("eligible roles: with an end date is fine, without is an attention, and the optional permission is named when it is missing", function () {
  var ok = M.eligibleModel({ eligible: { state: "ok", count: 2, permanent: 1, rows: [{ role: "Global Administrator", name: "Sam", upn: "s@x.com", permanent: true, ends: null }, { role: "Reports Reader", name: "", upn: "a@x.com", permanent: false, ends: NOW + 30 * DAY }] } });
  assert.strictEqual(ok.tone, "attn");
  assert.ok(/2 eligible assignments/.test(ok.head) && /1 has no end date/.test(ok.text));
  assert.deepStrictEqual(ok.rows.map(function (r) { return [r.who, r.ends]; }), [["Sam", "no end date"], ["a@x.com", M.dateText(NOW + 30 * DAY)]]);
  var all = M.eligibleModel({ eligible: { state: "ok", count: 1, permanent: 0, rows: [] } });
  assert.strictEqual(all.tone, "ok");
  assert.ok(/All have an end date/.test(all.text));
  var need = M.eligibleModel({ eligible: { state: "needs_permission", needs: ["RoleEligibilitySchedule.Read.Directory"] } });
  assert.ok(/RoleEligibilitySchedule\.Read\.Directory/.test(need.text) && /optional/.test(need.text) && /P2/.test(need.text));
  assert.ok(/Entra ID P2/.test(M.eligibleModel({ eligible: { state: "needs_premium" } }).head));
  assert.ok(/could not be read/.test(M.eligibleModel({ eligible: { state: "error" } }).head));
  assert.strictEqual(M.eligibleModel({}), null);
});

test("guests: the age bands, the unaccepted invitations, the licensed ones and the companies", function () {
  var s = { guestBands: { d30: 1, d90: 0, d365: 2, older: 3, unknown: 0 }, guestPending: { count: 2, rows: [] }, guestLicensed: 1, guestDomains: [{ domain: "partner.example", count: 4 }, { domain: "other.example", count: 1 }] };
  assert.deepStrictEqual(M.guestBands(s).map(function (b) { return [b.label, b.count, b.tone]; }), [["Under 30 days", 1, ""], ["30 to 90 days", 0, ""], ["90 days to a year", 2, ""], ["Over a year", 3, "attn"]]);
  var notes = M.guestNotes(s).map(function (n) { return n.text; });
  assert.deepStrictEqual(notes, ["2 invitations were never accepted.", "1 guest holds a paid licence.", "Mostly from partner.example (4), other.example (1)."]);
  assert.deepStrictEqual(M.guestBands({}), []);
  assert.deepStrictEqual(M.guestNotes({ guestPending: { count: 1 }, guestDomains: [] }).map(function (n) { return n.text; }), ["1 invitation was never accepted."]);
  assert.strictEqual(M.guestBands({ guestBands: { d30: 0, d90: 0, d365: 0, older: 0, unknown: 2 } }).pop().label, "Age unknown");
});

test("Conditional Access: what each policy covers sits under its name, and the baseline checks read yes, report-only or no", function () {
  var s = { rows: [{ name: "Require MFA", state: "on", summary: "Everyone, all apps: require MFA", modified: NOW }, { name: "Old test", state: "off" }], checks: [
    { id: "mfa-everyone", label: "MFA for everyone, on all apps", state: "yes", policy: "Require MFA" },
    { id: "block-legacy", label: "Old sign-in methods blocked", state: "report-only", policy: "Block legacy" },
    { id: "risk", label: "A policy that reacts to risky sign-ins", state: "no", policy: "" }] };
  var rows = M.policyRows(s);
  assert.deepStrictEqual([rows[0].summary, rows[0].tone, rows[1].summary, rows[1].tone], ["Everyone, all apps: require MFA", "", "", "attn"]);
  assert.deepStrictEqual(M.policyChecks(s).map(function (c) { return [c.state, c.tone, c.text]; }), [["yes", "ok", "In place: Require MFA"], ["report-only", "attn", "Only reporting: Block legacy"], ["no", "alert", "Not found"]]);
  assert.deepStrictEqual(M.policyChecks({ rows: [] }), [], "a plain list has no checks to show");
});

test("secure score trend: up, down, flat and not enough history; the line is the percentages in order", function () {
  var up = M.scoreTrend({ trend: { points: [{ pct: 30 }, { pct: 40 }, { pct: 42 }], delta30: 12, delta7: 2 } });
  assert.deepStrictEqual([up.text, up.points, up.tone], ["Up 12 points in the last month.", [30, 40, 42], "ok"]);
  var down = M.scoreTrend({ trend: { points: [{ pct: 50 }, { pct: 45 }], delta30: null, delta7: -5 } });
  assert.deepStrictEqual([down.text, down.tone], ["Down 5 points in the last week.", "alert"]);
  assert.strictEqual(M.scoreTrend({ trend: { points: [{ pct: 50 }, { pct: 50 }], delta30: 0 } }).text, "No change in the last month.");
  assert.strictEqual(M.scoreTrend({ trend: { points: [{ pct: 50 }, { pct: 50 }], delta30: null, delta7: null } }).text, "Not enough history to show a trend yet.");
  assert.deepStrictEqual(M.scoreTrend({ trend: { points: [{ pct: 50 }] } }).points, [], "one reading is not a line");
  assert.deepStrictEqual(M.scoreTrend({}).points, []);
});

test("the strip gains the admins to look at and the secure score", function () {
  var s = M.stats({ adminsToCheck: 2, scorePct: 42 });
  assert.deepStrictEqual(s.map(function (x) { return [x.label, x.value, x.tone]; }), [["Admins to look at", "2", "attn"], ["Secure score", "42%", "attn"]]);
  assert.strictEqual(M.stats({ adminsToCheck: 0, scorePct: 85 })[1].tone, "ok");
  assert.strictEqual(M.stats({ scorePct: 10 })[0].tone, "alert");
});

// ---- phase 3: the review -----------------------------------------------------------------------------------------------------------

test("the review checklist: a line each, the Worker's tone in plain words, empty until something has been read", function () {
  var rows = M.checklistRows({ checklist: [
    { id: "admins", title: "Everyone who holds an admin role still needs it", how: "Remove roles from anyone who left.", tone: "check", detail: "2 people hold a privileged role." },
    { id: "global-admins", title: "Two to four Global Administrators", how: "x", tone: "ok", detail: "2 Global Administrators." },
    { id: "score", title: "The biggest secure score gaps", how: "y", tone: "unknown", detail: "needs SecurityEvents.Read.All" }] });
  assert.deepStrictEqual(rows.map(function (r) { return [r.id, r.tone, r.word]; }), [["admins", "attn", "Check"], ["global-admins", "ok", "Fine"], ["score", "", "Not known"]]);
  assert.deepStrictEqual(M.checklistRows({}), []);
  assert.deepStrictEqual(M.checklistRows({ checklist: [] }), []);
});

test("what changed since the last review: the lines, nothing changed, and nothing to compare with", function () {
  assert.strictEqual(M.changesModel(null, NOW).none, true);
  assert.ok(/nothing to compare with/.test(M.changesModel(null, NOW).text));
  var same = M.changesModel({ since: NOW - 10 * DAY, changed: false }, NOW);
  assert.ok(/Nothing has changed since the review on/.test(same.text) && same.lines.length === 0);
  var c = M.changesModel({ since: NOW - 10 * DAY, changed: true, adminsAdded: ["new@x.com"], adminsRemoved: ["old@x.com"], policiesAdded: ["P new"], policiesRemoved: [], policiesChanged: [{ name: "MFA", from: "on", to: "off" }], guests: { from: 1, to: 4 }, score: { from: 42, to: 39 } }, NOW);
  assert.deepStrictEqual(c.lines, ["New admins: new@x.com", "No longer admins: old@x.com", "New policies: P new", "Policy MFA went from on to off.", "Guests: 1 to 4.", "Secure score: 42% to 39%."]);
  assert.ok(/^Since the review on/.test(c.text));
  var many = M.changesModel({ since: NOW, adminsAdded: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }, NOW);
  assert.ok(/and 2 more/.test(many.lines[0]));
  assert.strictEqual(M.changesModel({ since: NOW, guests: { from: 2, to: 2 } }, NOW).lines.length, 0);
});

test("earlier reviews say how many lines were ticked; an old record without ticks says only the date and note", function () {
  var h = M.reviewHistory([{ at: NOW - DAY, note: "removed 2 guests", checked: ["admins", "stale"] }, { at: NOW - 100 * DAY, note: "", checked: null }], 10);
  assert.ok(/2 of 10 lines ticked\. removed 2 guests$/.test(h[0].text));
  assert.strictEqual(h[1].text, M.dateText(NOW - 100 * DAY));
  assert.deepStrictEqual(M.reviewHistory(null, 10), []);
});

test("the review words: no review yet points at the checklist below, and checked_invalid is worded", function () {
  assert.ok(/tick each one/.test(M.reviewModel(null, NOW).text));
  assert.ok(/could not be saved/.test(M.errorText({ error: "checked_invalid" }, 400)));
});

// ---- the page --------------------------------------------------------------------------------------------------------------

test("m365.js draws the new parts from numbers and text only: the sparkline sets presentation attributes, no style attribute, one fetch", function () {
  var js = fs.readFileSync(path.join(root, "m365.js"), "utf8");
  assert.ok(/createElementNS\(ns, "path"\)/.test(js) && /setAttribute\("stroke-width", "2"\)/.test(js));
  assert.ok(!/setAttribute\("style"|\.style\./.test(js), "the page's CSP has no inline style");
  assert.ok(/body\.checked = boxes\.filter/.test(js), "the ticked lines are sent with the record");
});

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
