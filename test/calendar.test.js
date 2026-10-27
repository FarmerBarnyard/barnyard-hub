// Coverage for calendar.js's pure helpers (the page behind GET /hub/renewals): dates, urgency, the month grid, the
// agenda and "next up" groups, the .ics file and the add/edit form's body. The DOM and network parts were exercised
// in a real browser against a stand-in for the Worker.
//
//   node test/calendar.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Cal = require(path.join(__dirname, "..", "calendar.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var TODAY = "2026-10-27";
function r(over) { return Object.assign({ id: "it_x", source: "ops", kind: "secret", label: "Renew a thing", due: "2027-01-01", state: "known", where: "", link: "", breaks: "", leadDays: null, lastRenewed: "", note: "", extra: "", href: "ops.html#it_x" }, over); }

test("dates are worked in whole days with no time zone drift", function () {
  assert.strictEqual(Cal.daysBetween("2026-10-27", "2026-10-28"), 1);
  assert.strictEqual(Cal.daysBetween("2026-10-27", "2027-10-27"), 365);
  assert.strictEqual(Cal.daysBetween("2026-03-28", "2026-04-05"), 8, "across a daylight saving change");
  assert.strictEqual(Cal.addDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(Cal.addDays("2028-02-28", 1), "2028-02-29");
  assert.strictEqual(Cal.ymd(new Date(2026, 9, 7)), "2026-10-07");
  assert.ok(Cal.isYmd("2026-10-27") && !Cal.isYmd("2026-13-40") && !Cal.isYmd("tomorrow") && !Cal.isYmd(""));
});

test("how far away something is reads like a person would say it", function () {
  assert.strictEqual(Cal.relativeText(-5), "overdue by 5 days");
  assert.strictEqual(Cal.relativeText(-1), "overdue by 1 day");
  assert.strictEqual(Cal.relativeText(0), "today");
  assert.strictEqual(Cal.relativeText(1), "tomorrow");
  assert.strictEqual(Cal.relativeText(12), "in 12 days");
  assert.strictEqual(Cal.relativeText(331), "in about 11 months");
  assert.strictEqual(Cal.relativeText(730), "in about 2 years");
  assert.strictEqual(Cal.relativeText(null), "");
});

test("urgency: red inside a week or overdue, amber inside a month, calm after; no date or self-renewing says nothing", function () {
  var u = function (due, state) { return Cal.urgency({ type: "renewal", due: due, state: state || "known" }, TODAY); };
  assert.strictEqual(u("2026-10-20"), "alert");
  assert.strictEqual(u("2026-11-03"), "alert");
  assert.strictEqual(u("2026-11-04"), "attn");
  assert.strictEqual(u("2026-11-26"), "attn");
  assert.strictEqual(u("2026-11-27"), "ok");
  assert.strictEqual(u("", "needed"), "");
  assert.strictEqual(u("2026-10-28", "auto"), "");
  assert.strictEqual(Cal.urgency({ type: "item", due: "2026-10-26" }, TODAY), "alert");
  assert.strictEqual(Cal.urgency({ type: "item", due: "2026-10-30" }, TODAY), "attn");
  assert.strictEqual(Cal.urgency({ type: "item", due: "2026-12-30" }, TODAY), "");
});

test("a month is weeks of seven days, Monday first, with the days either side greyed", function () {
  var g = Cal.monthGrid(2026, 9);
  assert.strictEqual(g.label, "October 2026");
  assert.strictEqual(g.weeks.length, 5);
  assert.ok(g.weeks.every(function (w) { return w.length === 7; }));
  assert.strictEqual(g.weeks[0][0].date, "2026-09-28");
  assert.strictEqual(g.weeks[0][0].inMonth, false);
  assert.strictEqual(g.weeks[0][3].date, "2026-10-01");
  assert.strictEqual(g.weeks[0][3].inMonth, true);
  assert.strictEqual(g.weeks[4][6].date, "2026-11-01");
  var feb = Cal.monthGrid(2027, 1);
  assert.strictEqual(feb.weeks.length, 4, "a four-week February that starts on a Monday");
  assert.strictEqual(feb.weeks[0][0].date, "2027-02-01");
  assert.strictEqual(Cal.monthGrid(2026, 7).weeks.length, 6, "a six-week month keeps its last row");
});

test("renewals and dated Ops items are placed on their dates; a bad date is left out", function () {
  var map = Cal.entriesByDate([r({ id: "a", due: "2026-11-01" }), r({ id: "b", due: "" }), r({ id: "c", due: "nope" }), r({ id: "d", due: "2026-11-01" })], [{ id: "it_1", title: "Ring the host", due: "2026-11-01", href: "ops.html#it_1" }]);
  assert.deepStrictEqual(Object.keys(map), ["2026-11-01"]);
  assert.deepStrictEqual(map["2026-11-01"].map(function (e) { return e.type + ":" + e.id; }), ["renewal:a", "renewal:d", "item:it_1"]);
});

test("the Today view: overdue, due today, and the next week; self-renewing ones are not asked about", function () {
  var a = Cal.agenda([
    r({ id: "old", due: "2026-10-20" }), r({ id: "now", due: "2026-10-27" }), r({ id: "soon", due: "2026-11-03" }),
    r({ id: "later", due: "2026-11-04" }), r({ id: "auto", due: "2026-10-28", state: "auto" })
  ], [{ id: "it_2", title: "Item today", due: "2026-10-27" }], TODAY);
  assert.deepStrictEqual(a.overdue.map(function (e) { return e.id; }), ["old"]);
  assert.deepStrictEqual(a.today.map(function (e) { return e.id; }), ["now", "it_2"]);
  assert.deepStrictEqual(a.week.map(function (e) { return e.id; }), ["soon"]);
  assert.strictEqual(Cal.dueCount([r({ due: "2026-10-20" }), r({ due: "2026-10-27" }), r({ due: "2026-12-01" })], [], TODAY), 2);
});

test("Next up is soonest first under month headings, overdue first of all", function () {
  var g = Cal.nextUp([r({ id: "z", label: "Z", due: "2027-09-23" }), r({ id: "a", label: "A", due: "2026-10-20" }), r({ id: "m", label: "M", due: "2026-11-05" }), r({ id: "n", label: "N", due: "", state: "needed" }), r({ id: "s", label: "S", due: "2026-11-30", state: "auto" })], TODAY);
  assert.deepStrictEqual(g.map(function (x) { return x.title; }), ["Overdue", "November 2026", "September 2027"]);
  assert.deepStrictEqual(g[1].items.map(function (x) { return x.id; }), ["m"]);
});

test("No date yet: the ones that still need a date, and the ones that renew themselves", function () {
  var nd = Cal.noDate([r({ id: "n1", due: "", state: "needed" }), r({ id: "n2", due: "", state: "known" }), r({ id: "a", due: "", state: "auto" }), r({ id: "ok", due: "2027-01-01" })]);
  assert.deepStrictEqual(nd.needed.map(function (x) { return x.id; }), ["n1", "n2"]);
  assert.deepStrictEqual(nd.auto.map(function (x) { return x.id; }), ["a"]);
});

test("the kind filter keeps one kind, or everything", function () {
  var list = [r({ id: "s", kind: "secret" }), r({ id: "d", kind: "domain" })];
  assert.strictEqual(Cal.filterKind(list, "domain").length, 1);
  assert.strictEqual(Cal.filterKind(list, "all").length, 2);
  assert.strictEqual(Cal.filterKind(list, "").length, 2);
});

test("the .ics file: CRLF lines, an all-day event per dated renewal, two reminders, and text escaped", function () {
  var NOW = Date.UTC(2026, 9, 27, 3, 4, 5);
  var ics = Cal.buildIcs([
    r({ id: "it_a", label: "Mail secret, 24 months", due: "2028-10-27", state: "estimated", where: "Entra; Certificates and secrets", breaks: "Alerts stop", link: "https://entra.microsoft.com/" }),
    r({ id: "runner_key:rk 1", label: "Runner key: laptop", due: "2027-01-31", source: "runner_key", kind: "key" }),
    r({ id: "n", due: "", state: "needed" }), r({ id: "auto", due: "2027-02-02", state: "auto" })
  ], NOW, "https://dashboard.barnyard.site/calendar.html");
  assert.ok(ics.indexOf("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") === 0);
  assert.ok(/END:VCALENDAR\r\n$/.test(ics));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends in CRLF");
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 2, "no event for a missing date or a self-renewing one");
  assert.ok(ics.indexOf("UID:renewal-it_a@barnyard.site\r\n") > 0);
  assert.ok(ics.indexOf("UID:renewal-runner_key-rk-1@barnyard.site\r\n") > 0, "a UID with only safe characters");
  assert.ok(ics.indexOf("DTSTAMP:20260927T030405Z") < 0 && ics.indexOf("DTSTAMP:20261027T030405Z\r\n") > 0);
  assert.ok(ics.indexOf("DTSTART;VALUE=DATE:20281027\r\nDTEND;VALUE=DATE:20281028\r\n") > 0, "all day, the end is the next day");
  assert.ok(ics.indexOf("SUMMARY:Renew: Mail secret\\, 24 months (estimated)\r\n") > 0, "commas escaped, estimate marked");
  assert.strictEqual((ics.match(/BEGIN:VALARM/g) || []).length, 4);
  assert.ok(ics.indexOf("TRIGGER:-P29DT15H\r\n") > 0 && ics.indexOf("TRIGGER:-P6DT15H\r\n") > 0, "30 and 7 days ahead, at 9 in the morning");
  assert.ok(ics.indexOf("Entra\\; Certificates and secrets") > 0, "semicolons escaped");
});

test("long lines are folded at 75 bytes without splitting a character", function () {
  var line = "DESCRIPTION:" + new Array(40).join("éé ") ;
  var folded = Cal.icsFold(line).split("\r\n");
  assert.ok(folded.length > 1);
  folded.forEach(function (l) { assert.ok(Buffer.byteLength(l, "utf8") <= 75, l); });
  folded.slice(1).forEach(function (l) { assert.strictEqual(l[0], " "); });
  assert.strictEqual(folded.map(function (l, i) { return i ? l.slice(1) : l; }).join(""), line, "nothing lost");
  assert.strictEqual(Cal.icsFold("short"), "short");
});

test("the form builds the Ops item body: targets, the date, Details lines, and the free text kept", function () {
  var res = Cal.renewalBody({ title: "Renew the domain", kind: "domain", due: "2027-03-14", state: "known", where: "Registrar, Renew", link: "https://example.com/renew", breaks: "Every site goes dark", leadDays: "30", renewed: "2026-03-14" }, "My own note.", true);
  assert.deepStrictEqual(res.body.targets, ["renewal", "domain"]);
  assert.strictEqual(res.body.due, "2027-03-14");
  assert.strictEqual(res.body.details, "My own note.\n\nDate: known\nWhere: Registrar, Renew\nLink: https://example.com/renew\nBreaks: Every site goes dark\nLead: 30\nRenewed: 2026-03-14");
  assert.deepStrictEqual([res.body.category, res.body.lane, res.body.status, res.body.owner], ["security", "backlog", "scheduled", "you"]);
  var edit = Cal.renewalBody({ title: "Renew the domain", kind: "domain", due: "2027-03-14", state: "known", where: "", link: "", breaks: "", leadDays: "", renewed: "" }, "", false);
  assert.strictEqual(edit.body.category, undefined, "an edit changes only what the form shows");
  assert.strictEqual(edit.body.details, "Date: known");
});

test("a missing date is always 'needed', and a date on a 'needed' renewal is an estimate", function () {
  var b = function (due, state) { return Cal.renewalBody({ title: "X", kind: "key", due: due, state: state, where: "", link: "", breaks: "", leadDays: "", renewed: "" }, "", false).body; };
  assert.ok(b("", "known").details.indexOf("Date: needed") === 0);
  assert.strictEqual(b("", "known").due, "");
  assert.ok(b("2027-01-01", "needed").details.indexOf("Date: estimated") === 0);
  assert.ok(b("", "auto").details.indexOf("Date: auto") === 0, "a self-renewing one needs no date");
});

test("the form says what is wrong in plain words", function () {
  var base = { title: "X", kind: "key", due: "", state: "known", where: "", link: "", breaks: "", leadDays: "", renewed: "" };
  function bad(over) { return Cal.renewalBody(Object.assign({}, base, over), "", true); }
  assert.strictEqual(bad({ title: "  " }).field, "title");
  assert.strictEqual(bad({ title: new Array(122).join("x") }).field, "title");
  assert.strictEqual(bad({ due: "27/10/2026" }).field, "due");
  assert.strictEqual(bad({ link: "http://insecure.example/" }).field, "link");
  assert.strictEqual(bad({ link: "javascript:alert(1)" }).field, "link");
  assert.strictEqual(bad({ leadDays: "400" }).field, "leadDays");
  assert.strictEqual(bad({ leadDays: "1.5" }).field, "leadDays");
  assert.strictEqual(bad({ renewed: "soon" }).field, "renewed");
  assert.ok(!bad({}).error, "the base case is fine");
  assert.strictEqual(Cal.renewalBody(Object.assign({}, base, { kind: "gadget" }), "", true).body.targets[1], "other");
});

test("the page: strict CSP, no inline script or style, no innerHTML, scripts stamped, and the menu has the item", function () {
  var html = fs.readFileSync(path.join(root, "calendar.html"), "utf8");
  assert.ok(/Content-Security-Policy[^>]*script-src 'self'/.test(html) && /style-src 'self'/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/<style/i.test(html) && !/ style=/.test(html) && !/ on[a-z]+=/i.test(html));
  assert.ok(/data-shell="calendar"/.test(html));
  ["calendar.js", "calendar.css", "shell.js", "shell.css"].forEach(function (f) { assert.ok(html.indexOf(f) > 0, f); });
  var js = fs.readFileSync(path.join(root, "calendar.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js.replace(/\/\/.*$/gm, "")), "safe DOM building only");
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  assert.ok(/id: "calendar", title: "Calendar"[^}]*ownerOnly: true/.test(shell));
  assert.ok(/calendar: '</.test(shell), "it has an icon");
});

console.log(passed + " passed");
