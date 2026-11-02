// Coverage for the Services tab's phases 3 and 4 on the page side: the Calendar showing Microsoft 365 action-by dates (calendar-logic.js),
// the code and dependency health card's wording and states (services.js), and the Service levels tile's code line (tile-services.js).
// The Worker side is ClaudeRepo's cloudflare-worker/test/code-health.test.mjs.
//
//   node test/services-code.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Cal = require(path.join(__dirname, "..", "calendar-logic.js"));
var Svc = require(path.join(__dirname, "..", "services.js"));
var Tile = require(path.join(__dirname, "..", "tile-services.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var NOW = Date.parse("2026-11-02T06:00:00Z");
var DAY = 86400000;

// ---- the Calendar: Microsoft 365 action-by dates --------------------------------------------------------------------------------

function m(id, y, mo, d, over) { return Object.assign({ id: id, title: "Change " + id, services: ["Exchange Online"], severity: "high", major: true, actionBy: new Date(y, mo - 1, d, 12, 0, 0).getTime() }, over || {}); }

test("an action-by date lands on its day in the owner's own time, all day, as a Microsoft 365 entry", function () {
  var es = Cal.m365Entries([m("MC1", 2026, 11, 5), m("MC2", 2026, 11, 20)], "2026-11-01", "2026-11-30");
  assert.deepStrictEqual(es.map(function (e) { return [e.type, e.id, e.due, e.allDay, e.label]; }), [
    ["m365", "m365:MC1", "2026-11-05", true, "Change MC1"], ["m365", "m365:MC2", "2026-11-20", true, "Change MC2"]]);
  assert.strictEqual(es[0].ref.services[0], "Exchange Online");
  assert.deepStrictEqual(Cal.m365Entries([m("MC1", 2026, 11, 5)], "2026-11-06", "2026-11-30"), [], "outside the range is left out");
});

test("bad or missing items are skipped, and nothing is entered when there are none", function () {
  var junk = [null, "x", {}, { id: "a", title: "No date" }, { id: "b", title: "Bad", actionBy: "soon" }, { id: "c", actionBy: 1e12 }, { title: "No id", actionBy: 1e12 }, { id: "d", title: "Nan", actionBy: NaN }];
  assert.deepStrictEqual(Cal.m365Entries(junk, "2000-01-01", "2100-01-01"), []);
  assert.deepStrictEqual(Cal.m365Entries(undefined, "2000-01-01", "2100-01-01"), []);
  assert.deepStrictEqual(Cal.entriesByDate({ renewals: [], dueItems: [], tasks: [], events: [] }, "2026-11-01", "2026-11-30", "all"), {}, "an older data object without m365 still works");
});

test("on the calendar the entry sorts with the Ops items, shows in Upcoming and in Today when due, and counts as something to do", function () {
  var data = { renewals: [], dueItems: [{ id: "it_1", title: "An Ops item", due: "2026-11-05" }], tasks: [], events: [], google: [{ title: "Dentist", allDay: true, date: "2026-11-05" }], m365: [m("MC1", 2026, 11, 5)] };
  var map = Cal.entriesByDate(data, "2026-11-05", "2026-11-05", "all");
  assert.deepStrictEqual(map["2026-11-05"].map(function (e) { return e.type; }), ["gcal", "item", "m365"], "events first, then Ops items and Microsoft 365 changes by name");
  var up = Cal.upcoming(data, "2026-11-02", 30, "all");
  assert.strictEqual(up.length, 1);
  assert.ok(up[0].entries.some(function (e) { return e.type === "m365"; }));
  assert.strictEqual(Cal.dueCount({ m365: [m("MC1", 2026, 11, 2)], tasks: [], events: [], renewals: [], dueItems: [] }, "2026-11-02"), 1, "an action due today is something to do");
  var ag = Cal.agenda({ m365: [m("MC1", 2026, 11, 1)], tasks: [], events: [], renewals: [], dueItems: [] }, "2026-11-02", "all");
  assert.strictEqual(ag.overdue.length, 1, "an action-by date that has passed is overdue, like a renewal");
});

test("the colour of an entry follows how near its date is", function () {
  var today = "2026-11-02";
  var soon = Cal.m365Entries([m("A", 2026, 11, 5)], "2026-11-01", "2026-12-31")[0];
  var later = Cal.m365Entries([m("B", 2026, 11, 20)], "2026-11-01", "2026-12-31")[0];
  var far = Cal.m365Entries([m("C", 2027, 1, 20)], "2026-11-01", "2027-12-31")[0];
  assert.deepStrictEqual([Cal.urgency(soon, today), Cal.urgency(later, today), Cal.urgency(far, today)], ["alert", "attn", "ok"]);
});

test("the Calendar page states: dates when Microsoft answers, silence when it is not set up, a warning only when something failed", function () {
  assert.deepStrictEqual(Cal.m365State({ status: 200, data: { state: "ok", actionDates: [{ id: "x" }] } }), { state: "ok", items: [{ id: "x" }] });
  ["off", "not_set_up", "needs_permission"].forEach(function (s) {
    assert.deepStrictEqual(Cal.m365State({ status: 200, data: { state: s } }), { state: "off", items: [] }, s);
  });
  assert.strictEqual(Cal.m365State({ status: 200, data: { state: "error", reason: "unavailable" } }).state, "error");
  assert.strictEqual(Cal.m365State({ status: 502 }).state, "error");
  assert.strictEqual(Cal.m365State({ status: 0 }).state, "error", "the network failing is a failure");
  assert.strictEqual(Cal.m365State({ status: 401 }).state, "off");
  assert.strictEqual(Cal.m365State({ status: 403 }).state, "off", "services switched off is not an error on the Calendar");
  assert.strictEqual(Cal.m365State({ status: 200, data: { state: "ok" } }).state, "off", "an answer without the list shows nothing");
  assert.strictEqual(Cal.m365State(null).state, "error");
});

test("the Calendar page asks for the dates read only, keeps none of them in this browser, and shows text only", function () {
  var src = fs.readFileSync(path.join(root, "calendar.js"), "utf8");
  assert.ok(/getJson\(SERVICES_API \+ "\/m365"\)/.test(src), "a GET, through the same helper as the other reads");
  assert.ok(!/m365/.test((src.match(/function writeCache\(\)[\s\S]*?\n  }/) || [""])[0]), "the speed copy in this browser does not hold them");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(code(src)));
  var html = fs.readFileSync(path.join(root, "calendar.html"), "utf8");
  assert.ok(/connect-src 'self' https:\/\/api\.barnyard\.site/.test(html));
});

// ---- the Services card: wording -------------------------------------------------------------------------------------------------

var OK = { checkedAt: NOW - 3600000, defaultBranch: "main", lastPushDays: 1,
  alerts: { state: "ok", total: 3, bySeverity: { critical: 0, high: 1, medium: 1, low: 1 }, top: [
    { number: 1, severity: "high", package: "undici", ecosystem: "npm", summary: "Request smuggling", fixedIn: "6.1.0", url: "https://github.com/FarmerBarnyard/x/security/dependabot/1" },
    { number: 2, severity: "low", package: "yaml", ecosystem: "npm", summary: "", fixedIn: "", url: "" }] },
  workflows: { state: "ok", files: ["tests.yml", "deploy.yml"], actions: 4, tests: { state: "present", workflow: "tests.yml" },
    outdated: [{ action: "actions/setup-node", used: "v4", usedMajor: 4, latestMajor: 6, behind: 2, basis: "latest", files: ["tests.yml"] }, { action: "actions/cache", used: "v2", usedMajor: 2, latestMajor: null, behind: 2, basis: "floor", files: ["old.yml"] }],
    unpinned: [{ action: "cloudflare/wrangler-action", ref: "main", files: ["deploy.yml"] }] },
  branches: { state: "ok", total: 12, checked: 8, staleCount: 2, stale: [{ name: "claude/old", at: 1, ageDays: 45 }, { name: "claude/older", at: 1, ageDays: 90 }] },
  release: { state: "none" } };

test("each part of a repository says what it found, in words, with a colour", function () {
  var lines = Svc.codeLines(OK, NOW);
  var by = {}; lines.forEach(function (l) { by[l.key] = l; });
  assert.deepStrictEqual([by.alerts.tone, by.alerts.text], ["alert", "3 open: 1 high, 1 medium, 1 low"]);
  assert.deepStrictEqual([by.actions.tone, by.actions.text], ["attn", "2 actions are out of date; 1 follows a branch instead of a version"]);
  assert.deepStrictEqual([by.tests.tone, by.tests.text], ["ok", "Run by tests.yml"]);
  assert.deepStrictEqual([by.branches.tone, by.branches.text], ["attn", "2 not touched for over 30 days, out of 12 (dates read for 8 of 12; Check again for the rest)"]);
  assert.deepStrictEqual([by.release.tone, by.release.text], ["", "None: it ships by deploy; last push 1 day ago"]);
});

test("a clean repository is green, and an empty one says so plainly", function () {
  var clean = { checkedAt: NOW, alerts: { state: "ok", total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, top: [] },
    workflows: { state: "ok", files: ["tests.yml"], actions: 1, tests: { state: "present", workflow: "tests.yml" }, outdated: [], unpinned: [] },
    branches: { state: "ok", total: 0, checked: 0, staleCount: 0, stale: [] }, release: { state: "ok", tag: "v1.4.0", ageDays: 100 } };
  var lines = Svc.codeLines(clean, NOW);
  assert.deepStrictEqual(lines.map(function (l) { return [l.key, l.tone, l.text]; }), [
    ["alerts", "ok", "None open"], ["actions", "ok", "All 1 action is current"], ["tests", "ok", "Run by tests.yml"], ["branches", "ok", "Only the main branch"], ["release", "", "v1.4.0, 3 months ago"]]);
  var none = Svc.codeLines({ checkedAt: NOW, workflows: { state: "ok", files: [], actions: 0, tests: { state: "missing", workflow: "" }, outdated: [], unpinned: [] } }, NOW);
  assert.strictEqual(none[0].text, "No workflow files");
  assert.strictEqual(none[1].tone, "attn");
  assert.ok(/No workflow runs the tests/.test(none[1].text));
});

test("a part the token cannot read is said once, with what to do, and does not hide the rest", function () {
  var r = Object.assign({}, OK, { alerts: { state: "unavailable", code: "permission_missing" }, branches: { state: "unavailable", code: "rate_limited" }, release: { state: "unavailable", code: "github_error" } });
  var by = {}; Svc.codeLines(r, NOW).forEach(function (l) { by[l.key] = l; });
  assert.ok(/Dependabot alerts: Read-only/.test(by.alerts.text) && /switched on/.test(by.alerts.text));
  assert.strictEqual(by.alerts.tone, "", "not being allowed to look is not a finding");
  assert.strictEqual(by.branches.text, "Not read: GitHub's hourly allowance for the token is used up");
  assert.strictEqual(by.release.text, "Not read: GitHub answered with an error");
  assert.ok(by.actions && by.tests, "the readable parts are still there");
  var err = Svc.codeLines({ error: { code: "repo_not_visible" } }, NOW);
  assert.deepStrictEqual([err.length, err[0].tone, err[0].text], [1, "alert", "The token cannot see this repository."]);
  assert.deepStrictEqual(Svc.codeLines(null, NOW), []);
});

test("the things to look at: worst alerts first with their fix, actions to update, branches to tidy; links only to github.com", function () {
  var d = Svc.codeDetails(OK);
  assert.deepStrictEqual(d.map(function (x) { return x.chip; }), ["high", "low", "Update", "Update", "Pin", "Branch", "Branch"]);
  assert.strictEqual(d[0].text, "undici (npm): Request smuggling. Fixed in 6.1.0");
  assert.strictEqual(d[0].url, "https://github.com/FarmerBarnyard/x/security/dependabot/1");
  assert.strictEqual(d[0].tone, "alert");
  assert.strictEqual(d[2].text, "actions/setup-node is on v4, the latest is v6 (tests.yml)");
  assert.strictEqual(d[3].text, "actions/cache is on v2, older than v4 (a known floor) (old.yml)");
  assert.strictEqual(d[4].text, "cloudflare/wrangler-action follows @main (deploy.yml)");
  assert.strictEqual(d[5].text, "claude/old, last commit 45 days ago");
  assert.deepStrictEqual(Svc.codeDetails({ error: {} }), []);
  assert.deepStrictEqual(Svc.codeDetails(null), []);
});

test("the strip over the card: red for critical or high, amber for anything to update, green when clean, and honest before the first check", function () {
  var base = { repos: 5, critical: 0, high: 0, alerts: 0, alertsUnavailable: 0, outdated: 0, unpinned: 0, noTests: 0, stale: 0, checkedAt: NOW - 2 * DAY };
  assert.deepStrictEqual([Svc.codeHeadline(null, NOW).head, Svc.codeHeadline({ repos: 0 }, NOW).tone], ["Not checked yet", ""]);
  var red = Svc.codeHeadline(Object.assign({}, base, { high: 1, critical: 1, alerts: 4, outdated: 2 }), NOW);
  assert.deepStrictEqual([red.tone, red.head], ["alert", "2 critical or high alerts"]);
  assert.ok(/4 open alerts, 2 outdated actions\./.test(red.text) && /oldest check was 2 days ago/.test(red.text));
  var amber = Svc.codeHeadline(Object.assign({}, base, { outdated: 1, noTests: 1, alertsUnavailable: 2 }), NOW);
  assert.deepStrictEqual([amber.tone, amber.head], ["attn", "Some things to update"]);
  assert.ok(/1 outdated action, 1 repository without a tests workflow\./.test(amber.text) && /Alerts could not be read for 2 repositories/.test(amber.text));
  var green = Svc.codeHeadline(Object.assign({}, base, { stale: 3 }), NOW);
  assert.strictEqual(green.tone, "ok", "stale branches alone are not a problem");
  assert.ok(/3 stale branches\. Across 5 repositories\./.test(green.text));
});

test("the card's state: set up or not, nothing checked yet, or results", function () {
  var steps = ["one", "two"];
  assert.strictEqual(Svc.codeModel({ state: "not_set_up", steps: steps }, null).state, "not_set_up");
  assert.deepStrictEqual(Svc.codeModel({ state: "not_set_up", steps: steps }, null).steps, steps);
  assert.strictEqual(Svc.codeModel({ state: "never", steps: steps }, null).state, "loading", "the stored answers have not arrived yet");
  assert.strictEqual(Svc.codeModel({ state: "never", steps: steps }, { configured: false, steps: steps, repos: [] }).state, "not_set_up");
  var never = Svc.codeModel({ state: "never", steps: steps }, { configured: true, steps: steps, repos: [{ name: "a", result: null }], permissions: [{ name: "Metadata" }] });
  assert.deepStrictEqual([never.state, never.steps], ["never", steps]);
  var ok = Svc.codeModel({ state: "ok" }, { configured: true, steps: steps, repos: [{ name: "a", result: { checkedAt: 1 } }], permissions: [] });
  assert.deepStrictEqual([ok.state, ok.steps], ["ok", []]);
});

test("a check that is too soon, or for an unknown repository, is said in words; reasons and days read naturally", function () {
  assert.strictEqual(Svc.codeCheckError({ error: "rate_limited", retryMs: 12000 }, 429), "That repository was checked a moment ago. Try again in 12 seconds.");
  assert.strictEqual(Svc.codeCheckError({ error: "rate_limited" }, 429), "That repository was checked a moment ago. Try again in 30 seconds.");
  assert.ok(/not one of the repositories/.test(Svc.codeCheckError({ error: "repo_unknown" }, 400)));
  assert.strictEqual(Svc.codeCheckError({ error: "recent_sign_in_required" }, 403), null);
  assert.deepStrictEqual([0, 1, 9, 59, 60, 400].map(Svc.daysAgoText), ["today", "1 day ago", "9 days ago", "59 days ago", "2 months ago", "13 months ago"]);
  assert.strictEqual(Svc.daysAgoText(null), "");
  assert.strictEqual(Svc.codeReason("anything_else"), "it could not be read");
  assert.strictEqual(Svc.severityText({ critical: 2, high: 0, medium: 1, low: 0 }), "2 critical, 1 medium");
});

test("the card never builds markup from what the Worker sends, never calls GitHub itself, and checks one repository per request", function () {
  var src = fs.readFileSync(path.join(root, "services.js"), "utf8");
  var c = code(src);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(c));
  assert.ok(!/api\.github\.com/.test(c), "the page talks to the Worker only");
  assert.ok(/send\("GET", "\/services", "\/code"\)/.test(c), "the stored read");
  assert.strictEqual((c.match(/"\/code\?repo=" \+ encodeURIComponent\(name\) \+ "&refresh=1"/g) || []).length, 1, "one place starts a check, one repository at a time");
  assert.ok(/renderCode\(root\)/.test(c));
  assert.ok(!/setInterval\([^)]*checkCode/.test(c), "no timer starts a check");
});

// ---- the Service levels tile ---------------------------------------------------------------------------------------------------------

test("the tile's code line is only there once something has been checked, and says the worst thing", function () {
  var T = { repos: 5, critical: 0, high: 0, alerts: 0, outdated: 0, unpinned: 0, noTests: 0, stale: 0, checkedAt: NOW - DAY };
  assert.strictEqual(Tile.codeLine(null, NOW), null);
  assert.strictEqual(Tile.codeLine({ sources: { code: { state: "not_set_up" } } }, NOW), null);
  assert.strictEqual(Tile.codeLine({ sources: { code: { state: "never", totals: Object.assign({}, T, { repos: 0 }) } } }, NOW), null);
  assert.deepStrictEqual(Tile.codeLine({ sources: { code: { state: "ok", totals: T } } }, NOW), { tone: "ok", text: "Code: nothing to fix" });
  assert.deepStrictEqual(Tile.codeLine({ sources: { code: { state: "ok", totals: Object.assign({}, T, { outdated: 2, unpinned: 1 }) } } }, NOW), { tone: "attn", text: "Code: 3 things to update" });
  assert.deepStrictEqual(Tile.codeLine({ sources: { code: { state: "ok", totals: Object.assign({}, T, { critical: 1, high: 2 }) } } }, NOW), { tone: "alert", text: "Code: 3 critical or high alerts" });
  assert.strictEqual(Tile.codeLine({ sources: { code: { state: "ok", totals: Object.assign({}, T, { checkedAt: NOW - 20 * DAY }) } } }, NOW).text, "Code: nothing to fix (last checked 20 days ago)");
  var tile = fs.readFileSync(path.join(root, "tile-services.js"), "utf8");
  assert.ok(!/\/services\/code/.test(code(tile)), "the tile reads the summary only, so it never starts a check");
});

console.log("\n" + passed + " passed");
