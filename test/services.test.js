// Coverage for services.js's pure helpers (the page behind /services/*) and the Service levels tile's: uptime wording, the error
// budget, the forecast sentences, the chart's day grouping, the event rows, the Microsoft 365 states, the targets form body and the
// plain-words error text. The DOM and network parts were exercised in a real browser against a stand-in for the Worker.
//
//   node test/services.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Svc = require(path.join(__dirname, "..", "services.js"));
var Tile = require(path.join(__dirname, "..", "tile-services.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
// A file's lines without the comment-only ones, so a comment that names innerHTML does not count as using it.
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var NOW = Date.parse("2026-10-28T06:00:00Z");   // 14:00 in Perth
var DAY = 86400000;

function win(over) { return Object.assign({ checks: 8640, fails: 0, pct: 100, target: 99, allowed: 86.4, usedPct: 0, remainingPct: 100, met: true, burn: 0 }, over || {}); }
function level(over) { return Object.assign({ id: "app02", name: "app02 (maps and AI server)", group: "servers", target: 99, targetSource: "default", w7: win(), w30: win(), w90: win() }, over || {}); }

test("percentages are said to three places and 'No data' is not 100", function () {
  assert.strictEqual(Svc.pctText(99.9501), "99.95%");
  assert.strictEqual(Svc.pctText(100), "100%");
  assert.strictEqual(Svc.pctText(98.562), "98.562%");
  assert.strictEqual(Svc.pctText(null), "No data");
  assert.strictEqual(Svc.pctText(undefined), "No data");
});

test("a window's colour: met is ok, missed is alert, no data is none", function () {
  assert.strictEqual(Svc.windowTone(win()), "ok");
  assert.strictEqual(Svc.windowTone(win({ met: false })), "alert");
  assert.strictEqual(Svc.windowTone(win({ met: null })), "");
  assert.strictEqual(Svc.windowTone(null), "");
});

test("the error budget in words, and the burn rate", function () {
  assert.strictEqual(Svc.budgetText(win({ remainingPct: 62.4 })), "62% of the budget left");
  assert.strictEqual(Svc.budgetText(win({ remainingPct: -43.8 })), "Over budget by 44%");
  assert.strictEqual(Svc.budgetText(win({ remainingPct: null })), "");
  assert.strictEqual(Svc.budgetText(null), "");
  assert.strictEqual(Svc.burnText(win({ burn: 0 })), "No failed checks this week");
  assert.ok(/0\.5x the allowed rate: on track/.test(Svc.burnText(win({ burn: 0.5 }))));
  assert.ok(/1\.44x the allowed rate: faster than the target allows/.test(Svc.burnText(win({ burn: 1.44 }))));
  assert.strictEqual(Svc.burnText(win({ burn: null })), "");
});

test("the table lists the groups first, then each service, with the default marked", function () {
  var rows = Svc.levelRows({ groups: [level({ id: "servers", name: "Servers" })], monitors: [level({ id: "vtt", name: "VTT server", target: 98, targetSource: "own", w30: win({ met: false, remainingPct: -12 }) })] });
  assert.deepStrictEqual(rows.map(function (r) { return r.kind + ":" + r.id; }), ["group:servers", "monitor:vtt"]);
  assert.strictEqual(rows[0].targetText, "99% (default)");
  assert.strictEqual(rows[1].targetText, "98%");
  assert.strictEqual(rows[1].tone, "alert");
  assert.strictEqual(rows[1].budget, "Over budget by 12%");
  assert.deepStrictEqual(Svc.levelRows(null), []);
});

test("the headline: no history, all within target, or which services missed it, with how many days it is based on", function () {
  assert.strictEqual(Svc.headline({ monitors: [level({ w30: win({ met: null, pct: null }) })] }, 0).head, "No uptime history yet");
  assert.strictEqual(Svc.headline(null, 0).head, "No uptime history yet");
  var ok = Svc.headline({ monitors: [level(), level({ id: "vtt" })] }, 90);
  assert.deepStrictEqual([ok.tone, ok.head, ok.text], ["ok", "Every service is within its target", "Over the last 30 days."]);
  var young = Svc.headline({ monitors: [level()] }, 6);
  assert.ok(/Based on 6 days of checks so far/.test(young.text));
  var one = Svc.headline({ monitors: [level({ name: "VTT server", w30: win({ met: false }) }), level()] }, 90);
  assert.strictEqual(one.tone, "alert"); assert.strictEqual(one.head, "1 service is below its target"); assert.ok(/VTT server/.test(one.text));
  assert.strictEqual(Svc.headline({ monitors: [level({ w30: win({ met: false }) }), level({ id: "b", w30: win({ met: false }) })] }, 90).head, "2 services are below their targets");
  assert.ok(/Based on 1 day of checks/.test(Svc.headline({ monitors: [level()] }, 1).text));
});

test("every forecast state has a sentence, and the soonest ones are alerts", function () {
  assert.ok(/3 of 7 days of readings/.test(Svc.forecastText({ state: "not_enough_data", have: 3, need: 7 }).text));
  assert.ok(/reporter has not sent any/.test(Svc.forecastText({ state: "not_enough_data", have: 0, need: 7 }).text));
  assert.deepStrictEqual(Svc.forecastText({ state: "flat", latest: 52.4 }), { tone: "ok", text: "Not growing (52% now)." });
  assert.strictEqual(Svc.forecastText({ state: "far" }).tone, "ok");
  var over = Svc.forecastText({ state: "over", latest: 96.2, threshold: 95 });
  assert.strictEqual(over.tone, "alert"); assert.ok(/Already at 96%, past the 95% line/.test(over.text));
  var soon = Svc.forecastText({ state: "grows", latest: 80, slopePerDay: 1, daysLeft: 15, date: "2026-11-12", confidence: "good" });
  assert.strictEqual(soon.tone, "attn"); assert.ok(/Fills in about 15 days, around 12 Nov 2026\. Now 80%, growing 1 points a day\.$/.test(soon.text));
  assert.strictEqual(Svc.forecastText({ state: "grows", latest: 80, slopePerDay: 1, daysLeft: 10, date: "2026-11-07", confidence: "good" }).tone, "alert");
  assert.strictEqual(Svc.forecastText({ state: "grows", latest: 50, slopePerDay: 0.2, daysLeft: 200, date: "2027-05-16", confidence: "good" }).tone, "ok");
  assert.ok(/a very rough estimate/.test(Svc.forecastText({ state: "grows", latest: 58, slopePerDay: 0.95, daysLeft: 39, date: "2026-12-06", confidence: "low" }).text));
  assert.ok(/a rough estimate\)/.test(Svc.forecastText({ state: "grows", latest: 58, slopePerDay: 0.95, daysLeft: 1, date: "2026-12-06", confidence: "fair" }).text));
  assert.ok(/1 day,/.test(Svc.forecastText({ state: "grows", latest: 94, slopePerDay: 1, daysLeft: 1, date: "2026-10-29", confidence: "good" }).text));
  assert.deepStrictEqual(Svc.forecastText(null), { tone: "", text: "" });
});

test("capacity rows carry the server, reading, current figure and the sentence", function () {
  var rows = Svc.capacityRows([{ server: "cld01", name: "BARNYARDCLD01", label: "Disk /", forecast: { state: "grows", latest: 80.4, slopePerDay: 1, daysLeft: 15, date: "2026-11-12", confidence: "good" } }, { server: "vtt", name: "VTT VPS", label: "No readings yet", forecast: { state: "not_enough_data", have: 0, need: 7, latest: null } }]);
  assert.deepStrictEqual([rows[0].server, rows[0].label, rows[0].now, rows[0].tone], ["BARNYARDCLD01", "Disk /", "80%", "attn"]);
  assert.strictEqual(rows[1].now, "");
  assert.deepStrictEqual(Svc.capacityRows(undefined), []);
});

test("the chart covers 14 days ending today, groups the kinds, and ignores what is out of range", function () {
  var rows = [
    { day: "2026-10-28", type: "auth_fail", n: 5 }, { day: "2026-10-28", type: "not_owner", n: 2 }, { day: "2026-10-28", type: "rate_limited", n: 3 },
    { day: "2026-10-27", type: "secret_blocked", n: 1 }, { day: "2026-10-20", type: "monitor_down", n: 4 }, { day: "2026-10-01", type: "auth_fail", n: 99 }, { day: "2026-10-28", type: "auth_fail", n: 0 }
  ];
  var c = Svc.chartModel(rows, NOW, 14);
  assert.strictEqual(c.days.length, 14);
  assert.strictEqual(c.days[13].day, "2026-10-28"); assert.strictEqual(c.days[0].day, "2026-10-15");
  assert.deepStrictEqual([c.days[13].access, c.days[13].limits, c.days[13].total], [7, 3, 10]);
  assert.strictEqual(c.days[12].secrets, 1);
  assert.strictEqual(c.days[5].system, 4);
  assert.strictEqual(c.max, 10);
  assert.strictEqual(c.days.reduce(function (s, d) { return s + d.total; }, 0), 15, "the 1 October row is outside the window");
  assert.strictEqual(Svc.chartModel(null, NOW).days.length, 14);
  assert.strictEqual(Svc.groupOf("unheard_of"), "system");
});

test("the type chips, the event rows in the owner's time, and the strip over them", function () {
  assert.deepStrictEqual(Svc.typeChips([{ type: "auth_fail", label: "Failed sign-ins", n: 5 }]), [{ type: "auth_fail", label: "Failed sign-ins", n: 5 }]);
  var rows = Svc.eventRows([{ hour: "2026-10-28T01", label: "Failed sign-ins", route: "/auth/callback", reason: "state_mismatch", tag: "203.0.113.0/24", n: 4 }], "Australia/Perth");
  assert.strictEqual(rows[0].when, "Wed 28 Oct 09:00"); assert.strictEqual(rows[0].n, 4); assert.strictEqual(rows[0].route, "/auth/callback");
  assert.deepStrictEqual(Svc.eventRows(null), []);
  assert.strictEqual(Svc.hourText("2026-10-28T16", "Australia/Perth"), "Thu 29 Oct 00:00");
  assert.strictEqual(Svc.hourText("garbage"), "garbage");
  var line = Svc.securityLine({ week: [{ n: 5 }, { n: 1 }], thisHour: 2, droppedToday: 0 });
  assert.strictEqual(line.text, "6 events in the last 7 days. 2 refused in this hour."); assert.strictEqual(line.tone, "");
  var flood = Svc.securityLine({ week: [{ n: 1 }], thisHour: 0, droppedToday: 200 });
  assert.strictEqual(flood.tone, "attn"); assert.ok(/200 not stored today/.test(flood.text));
  assert.strictEqual(Svc.securityLine(null).text, "");
});

test("Microsoft 365: off, not set up, needs permission, error and ok each say what to do", function () {
  var steps = ["one", "two"];
  var off = Svc.m365Model(null, { m365: { on: false, steps: steps } });
  assert.deepStrictEqual([off.state, off.steps], ["off", steps]);
  assert.strictEqual(Svc.m365Model(null, { m365: { on: true } }).state, "loading");
  var missing = Svc.m365Model({ state: "not_set_up", problems: ["GRAPH_READ_CLIENT_SECRET"], steps: steps });
  assert.ok(/GRAPH_READ_CLIENT_SECRET/.test(missing.text)); assert.deepStrictEqual(missing.steps, steps);
  var perm = Svc.m365Model({ state: "needs_permission", detail: "Authorization_RequestDenied", steps: steps });
  assert.strictEqual(perm.head, "Microsoft needs two more permissions on the app"); assert.ok(/Authorization_RequestDenied/.test(perm.text));
  assert.ok(/secret may have expired/.test(Svc.m365Model({ state: "error", reason: "auth", detail: "AADSTS7000215" }).text));
  assert.ok(/did not answer/.test(Svc.m365Model({ state: "error", reason: "unavailable" }).text));
  var ok = Svc.m365Model({ state: "ok", openIssues: 2, actionSoon: 1 });
  assert.deepStrictEqual([ok.head, ok.text], ["2 open Microsoft issues", "1 announced change needs action within 14 days."]);
  assert.strictEqual(Svc.m365Model({ state: "ok", openIssues: 0, actionSoon: 0 }).head, "No open Microsoft issues");
});

test("issue and message rows keep Microsoft's words as text and mark what needs action soon", function () {
  var iss = Svc.issueRows([{ title: "Users cannot send mail", service: "Exchange Online", status: "investigating", classification: "incident", resolved: false, modified: NOW - DAY }, { title: "Old", service: "Teams", status: "serviceRestored", resolved: true, modified: NOW - 2 * DAY }], "Australia/Perth");
  assert.deepStrictEqual([iss[0].tone, iss[0].status], ["alert", "Investigating"]);
  assert.deepStrictEqual([iss[1].tone, iss[1].status], ["ok", "Resolved"]);
  assert.strictEqual(Svc.issueRows([{ title: "x", service: "s", status: "restoringService", classification: "advisory", resolved: false }])[0].tone, "attn");
  var msgs = Svc.messageRows([{ title: "Retirement", services: ["Exchange Online", "Teams"], severity: "high", actionBy: NOW + 8 * DAY, major: true }, { title: "FYI", services: [], severity: "normal", actionBy: null }, { title: "Late", services: [], severity: "normal", actionBy: NOW - 3 * DAY }], NOW, "Australia/Perth");
  assert.deepStrictEqual([msgs[0].action, msgs[0].tone, msgs[0].services, msgs[0].major], ["Action needed in 8 days", "attn", "Exchange Online, Teams", true]);
  assert.strictEqual(msgs[1].action, ""); assert.strictEqual(msgs[2].action, "Action date passed");
});

test("the targets form sends only what changed, blanks go back to the default, and a bad number is refused", function () {
  var cur = { servers: 99.5, vtt: 98 };
  var r = Svc.targetsBody({ servers: "99.5", vtt: "", sites: "99.9", app02: "" }, cur);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.body, { targets: { vtt: null, sites: 99.9 } }, "same value ignored; a cleared one that was set becomes null; a cleared one that was not set is ignored");
  assert.deepStrictEqual(Svc.targetsBody({ servers: "99.5" }, cur), { ok: false, error: "Nothing changed." });
  assert.strictEqual(Svc.targetsBody({ servers: "89" }, cur).ok, false);
  assert.strictEqual(Svc.targetsBody({ servers: "100" }, cur).ok, false);
  assert.strictEqual(Svc.targetsBody({ servers: "abc" }, cur).ok, false);
  assert.strictEqual(Svc.targetsBody({ servers: "99.9%" }, {}).body.targets.servers, 99.9);
  assert.strictEqual(Svc.targetsBody({ servers: "99.12345" }, {}).body.targets.servers, 99.123);
});

test("the Worker's refusals are said in plain words", function () {
  assert.ok(/recent sign-in/.test(Svc.errorText({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/SERVICES_ENABLED/.test(Svc.errorText({ error: "services_disabled" }, 403)));
  assert.ok(/half a minute/.test(Svc.errorText({ error: "rate_limited" }, 429)));
  assert.ok(/Could not reach/.test(Svc.errorText({}, 0)));
  assert.ok(/not signed in/.test(Svc.errorText({}, 401)));
  assert.ok(/only for the hub owner/.test(Svc.errorText({}, 403)));
  assert.strictEqual(Svc.errorText({ error: "weird" }, 500), "That did not work (weird).");
});

test("the search becomes a query string with only the parts that are set", function () {
  assert.strictEqual(Svc.eventsQuery({ type: "", q: "", days: 7, page: 1 }), "?days=7&page=1");
  assert.strictEqual(Svc.eventsQuery({ type: "auth_fail", q: "/auth", days: 30, page: 2 }), "?type=auth_fail&q=%2Fauth&days=30&page=2");
  assert.strictEqual(Svc.eventsQuery({}), "?days=7&page=1");
});

// ---- the tile --------------------------------------------------------------------------------------------------------

test("the tile: one line, the groups' 30-day figures and the soonest forecast", function () {
  assert.strictEqual(Tile.summaryLine(null).text, "The Services tab is switched off.");
  assert.strictEqual(Tile.summaryLine({ enabled: false }).text, "The Services tab is switched off.");
  assert.strictEqual(Tile.summaryLine({ levels: { monitors: [level({ w30: win({ met: null }) })] } }).text, "No uptime history yet.");
  assert.deepStrictEqual(Tile.summaryLine({ levels: { monitors: [level()] } }), { tone: "ok", text: "Every service is within its 30-day target." });
  assert.deepStrictEqual(Tile.summaryLine({ levels: { monitors: [level({ w30: win({ met: false }) }), level()] } }), { tone: "alert", text: "1 service below the 30-day target." });
  var sum = { levels: { groups: [level({ id: "servers", name: "Servers", w30: win({ pct: 99.62, remainingPct: 61.2 }) }), level({ id: "sites", name: "Sites", target: 99.5, w30: win({ pct: 99.1, met: false, remainingPct: -80 }) }), level({ id: "x", name: "None", w30: win({ pct: null }) })] }, capacity: [] };
  var r = Tile.rows(sum);
  assert.strictEqual(r.length, 2, "a group with no data is left out");
  assert.deepStrictEqual([r[0].name, r[0].pct, r[0].target, r[0].tone, r[0].budget], ["Servers", "99.62%", "99%", "ok", "61% budget left"]);
  assert.deepStrictEqual([r[1].tone, r[1].budget], ["alert", "over budget"]);
  assert.deepStrictEqual(Tile.rows(null), []);
  var cap = { capacity: [
    { name: "CLD01", label: "Disk /", forecast: { state: "grows", daysLeft: 41 } },
    { name: "app02", label: "Memory", forecast: { state: "grows", daysLeft: 9 } },
    { name: "VTT", label: "Disk /", forecast: { state: "flat" } }
  ] };
  var s = Tile.soonest(cap);
  assert.deepStrictEqual([s.name, s.text, s.tone], ["app02 memory", "fills in about 9 days", "alert"]);
  assert.strictEqual(Tile.soonest({ capacity: [{ name: "a", label: "Disk /", forecast: { state: "over" } }, { name: "b", label: "Disk /", forecast: { state: "grows", daysLeft: 3 } }] }).text, "is already past the line");
  assert.strictEqual(Tile.soonest({ capacity: [{ name: "a", label: "x", forecast: { state: "flat" } }] }), null);
  assert.strictEqual(Tile.soonest(null), null);
  assert.deepStrictEqual([Tile.descriptor.id, Tile.descriptor.permission, Tile.descriptor.ownerOnly], ["services", "tile.services", true]);
});

// ---- the page's rules ---------------------------------------------------------------------------------------------------

test("what the server sends only ever reaches the page as text, and the page has no inline script or style", function () {
  ["services.js", "tile-services.js"].forEach(function (f) {
    var src = code(fs.readFileSync(path.join(root, f), "utf8"));
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), f + " builds markup from strings");
    assert.ok(!/setAttribute\(\s*["']style["']/.test(src), f + " sets a style attribute");
  });
  var page = fs.readFileSync(path.join(root, "services.html"), "utf8");
  assert.ok(/Content-Security-Policy/.test(page) && /style-src 'self'/.test(page) && /script-src 'self'/.test(page));
  assert.ok(!/\sstyle=|\sonclick=|<script>[^<]/.test(page), "services.html has an inline script or style");
  assert.ok(/connect-src 'self' https:\/\/api\.barnyard\.site/.test(page));
});

test("the menu has the Services item for the owner, with a permission the Worker can take away, and a page name the shell recognises", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var it = (shell.match(/\{ id: "services"[^}]*\}/) || [""])[0];
  assert.ok(/ownerOnly: true/.test(it) && /perm: "services\.view"/.test(it) && /path: "services\.html"/.test(it), it);
  assert.ok(/services\\\.html\$\/\.test\(location\.pathname\)\) return "services"/.test(shell));
  assert.ok(/gauge: '/.test(shell));
  var index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/<script src="tile-services\.js/.test(index));
});

test("the page asks for nothing from a hidden tab or while something is being typed", function () {
  var src = fs.readFileSync(path.join(root, "services.js"), "utf8");
  assert.ok(/!document\.hidden/.test(src) && /typing/.test(src));
  assert.ok(/POLL_MS = 60000/.test(src));
});

console.log("\n" + passed + " passed");
