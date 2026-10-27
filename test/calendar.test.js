// Coverage for calendar-logic.js (the rules behind the Calendar page): dates, repeats, what falls on a day, urgency, the
// agenda and Upcoming groups, the Renewals groups, to-do groups, the month and week, the .ics file and the three forms. The
// DOM and network parts were exercised in a real browser against a stand-in for the Worker.
//
//   node test/calendar.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Cal = require(path.join(__dirname, "..", "calendar-logic.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var TODAY = "2026-10-27";   // a Tuesday
function r(over) { return Object.assign({ id: "it_x", source: "ops", kind: "secret", label: "Renew a thing", due: "2027-01-01", state: "known", where: "", link: "", breaks: "", leadDays: null, lastRenewed: "", note: "", extra: "", href: "ops.html#it_x" }, over); }
function t(over) { return Object.assign({ id: "td_1", title: "A to-do", notes: "", due: "", time: "", priority: "normal", recur: "", status: "open", doneAt: null, doneCount: 0, ref: null, createdAt: 1, updatedAt: 1 }, over); }
function ev(over) {
  var o = Object.assign({ id: "ev_1", title: "An event", notes: "", startDate: "2026-10-27", startTime: "", endDate: "", endTime: "", allDay: true, recur: "" }, over);
  if (!o.endDate) o.endDate = o.startDate;
  return o;
}
function ids(list) { return list.map(function (e) { return e.type + ":" + e.id; }); }

test("dates are worked in whole days with no time zone drift", function () {
  assert.strictEqual(Cal.daysBetween("2026-10-27", "2026-10-28"), 1);
  assert.strictEqual(Cal.daysBetween("2026-10-27", "2027-10-27"), 365);
  assert.strictEqual(Cal.daysBetween("2026-03-28", "2026-04-05"), 8, "across a daylight saving change");
  assert.strictEqual(Cal.addDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(Cal.addDays("2028-02-28", 1), "2028-02-29");
  assert.strictEqual(Cal.ymd(new Date(2026, 9, 7)), "2026-10-07");
  assert.ok(Cal.isYmd("2026-10-27") && !Cal.isYmd("2026-13-40") && !Cal.isYmd("2027-02-29") && !Cal.isYmd("tomorrow") && !Cal.isYmd(""));
  assert.ok(Cal.isTime("09:30") && !Cal.isTime("9:30") && !Cal.isTime("24:00"));
  assert.strictEqual(Cal.weekday("2026-10-26"), 0, "Monday is the first day");
  assert.strictEqual(Cal.mondayOf("2026-11-01"), "2026-10-26", "a Sunday belongs to the week before");
  assert.strictEqual(Cal.shortDate("2026-10-27"), "Tue 27 Oct");
  assert.strictEqual(Cal.timeText("09:30"), "9:30");
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
  assert.strictEqual(Cal.repeatText("weekdays"), "Repeats on weekdays");
  assert.strictEqual(Cal.repeatText(""), "");
});

test("repeats fall on the right dates, keeping to the day they started on", function () {
  assert.strictEqual(Cal.nextOccurrence("2026-10-23", "weekdays"), "2026-10-26", "Friday to Monday");
  assert.strictEqual(Cal.nextOccurrence("2026-10-27", "weekly"), "2026-11-03");
  assert.strictEqual(Cal.nextOccurrence("2026-01-31", "monthly", "2026-01-31"), "2026-02-28");
  assert.strictEqual(Cal.nextOccurrence("2026-02-28", "monthly", "2026-01-31"), "2026-03-31");
  assert.strictEqual(Cal.nextOccurrence("2028-02-29", "yearly", "2028-02-29"), "2029-02-28");
  assert.strictEqual(Cal.nextOccurrence("2031-02-28", "yearly", "2028-02-29"), "2032-02-29");
  assert.strictEqual(Cal.nextOccurrence("2026-10-27", "never"), null);
});

test("an event covers each day it spans; a repeating one starts again on each of its dates", function () {
  var trip = ev({ startDate: "2026-10-30", endDate: "2026-11-02" });
  assert.deepStrictEqual(Cal.eventDays(trip, "2026-10-27", "2026-11-30").map(function (d) { return d.date; }), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepStrictEqual(Cal.eventDays(trip, "2026-11-01", "2026-11-01").map(function (d) { return [d.date, d.first, d.last]; }), [["2026-11-01", false, false]], "a window inside the span");
  assert.deepStrictEqual(Cal.eventDays(trip, "2026-12-01", "2026-12-31"), []);
  var weekly = ev({ startDate: "2026-10-05", startTime: "09:00", endTime: "09:45", allDay: false, recur: "weekly" });
  assert.deepStrictEqual(Cal.eventDays(weekly, "2026-10-20", "2026-11-05").map(function (d) { return d.date; }), ["2026-10-26", "2026-11-02"]);
  assert.deepStrictEqual(Cal.eventDays(weekly, "2026-09-01", "2026-09-30"), [], "nothing before it starts");
  var weekdays = ev({ startDate: "2026-10-23", recur: "weekdays" });
  assert.deepStrictEqual(Cal.eventDays(weekdays, "2026-10-23", "2026-10-28").map(function (d) { return d.date; }), ["2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"]);
  var monthly = ev({ startDate: "2026-01-31", recur: "monthly" });
  assert.deepStrictEqual(Cal.eventDays(monthly, "2026-02-01", "2026-04-30").map(function (d) { return d.date; }), ["2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("the time of an event on a day reads plainly", function () {
  var allDay = Cal.eventDays(ev(), TODAY, TODAY)[0];
  assert.strictEqual(Cal.eventTimeText(allDay), "All day");
  var timed = Cal.eventDays(ev({ startTime: "09:00", endTime: "09:45", allDay: false }), TODAY, TODAY)[0];
  assert.strictEqual(Cal.eventTimeText(timed), "9:00 to 9:45");
  var openEnded = Cal.eventDays(ev({ startTime: "14:30", allDay: false }), TODAY, TODAY)[0];
  assert.strictEqual(Cal.eventTimeText(openEnded), "14:30");
  var overnight = Cal.eventDays(ev({ startDate: "2026-10-27", endDate: "2026-10-28", startTime: "22:00", endTime: "06:00", allDay: false }), "2026-10-27", "2026-10-28");
  assert.deepStrictEqual(overnight.map(function (d) { return Cal.eventTimeText(d); }), ["from 22:00", "until 6:00"]);
});

test("urgency: red inside a week or overdue, amber inside a month; no date or self-renewing says nothing; to-dos are about being late", function () {
  var u = function (due, state) { return Cal.urgency({ type: "renewal", due: due, state: state || "known" }, TODAY); };
  assert.strictEqual(u("2026-10-20"), "alert");
  assert.strictEqual(u("2026-11-03"), "alert");
  assert.strictEqual(u("2026-11-04"), "attn");
  assert.strictEqual(u("2026-11-26"), "attn");
  assert.strictEqual(u("2026-11-27"), "ok");
  assert.strictEqual(u("", "needed"), "");
  assert.strictEqual(u("2026-10-28", "auto"), "");
  assert.strictEqual(Cal.urgency({ type: "task", due: "2026-10-26" }, TODAY), "alert");
  assert.strictEqual(Cal.urgency({ type: "task", due: TODAY }, TODAY), "attn");
  assert.strictEqual(Cal.urgency({ type: "task", due: "2026-10-30" }, TODAY), "");
  assert.strictEqual(Cal.urgency({ type: "item", due: "2026-10-26" }, TODAY), "alert");
  assert.strictEqual(Cal.urgency({ type: "event", due: "2026-10-20" }, TODAY), "");
});

test("what is on a date: events, to-dos, Ops items and renewals, all-day first and timed ones by time", function () {
  var map = Cal.entriesByDate({
    renewals: [r({ id: "r1", due: "2026-10-28" }), r({ id: "r2", due: "", state: "needed" }), r({ id: "r3", due: "2026-10-28", state: "auto" })],
    dueItems: [{ id: "it_1", title: "Ring the host", due: "2026-10-28", href: "ops.html#it_1" }],
    tasks: [t({ id: "a", title: "Late call", due: "2026-10-28", time: "15:00" }), t({ id: "b", title: "Morning call", due: "2026-10-28", time: "09:00" }), t({ id: "c", title: "Anytime", due: "2026-10-28" }), t({ id: "d", title: "Done one", due: "2026-10-28", status: "done" }), t({ id: "e", title: "Inbox" })],
    events: [ev({ id: "v1", title: "Leave", startDate: "2026-10-27", endDate: "2026-10-28" }), ev({ id: "v2", title: "Call", startDate: "2026-10-28", startTime: "10:00", allDay: false })]
  }, "2026-10-27", "2026-10-31", "all");
  assert.deepStrictEqual(Object.keys(map).sort(), ["2026-10-27", "2026-10-28"]);
  assert.deepStrictEqual(ids(map["2026-10-27"]), ["event:v1"]);
  assert.deepStrictEqual(ids(map["2026-10-28"]), ["event:v1", "task:c", "item:it_1", "renewal:r1", "task:b", "event:v2", "task:a"], "all-day first, then by time; a ticked to-do, an inbox one and a self-renewing renewal are left out");
});

test("the renewal kind filter narrows renewals only", function () {
  var data = { renewals: [r({ id: "s", kind: "secret", due: "2026-10-28" }), r({ id: "d", kind: "domain", due: "2026-10-28" })], tasks: [t({ id: "x", due: "2026-10-28" })], events: [], dueItems: [] };
  assert.deepStrictEqual(ids(Cal.entriesByDate(data, "2026-10-28", "2026-10-28", "domain")["2026-10-28"]), ["task:x", "renewal:d"]);
  assert.strictEqual(Cal.filterKind(data.renewals, "all").length, 2);
});

test("the Today view: overdue (not events), today, and the next seven days", function () {
  var a = Cal.agenda({
    renewals: [r({ id: "old", due: "2026-10-20" }), r({ id: "now", due: TODAY }), r({ id: "soon", due: "2026-11-03" }), r({ id: "later", due: "2026-11-04" })],
    dueItems: [{ id: "it_2", title: "Item today", due: TODAY }],
    tasks: [t({ id: "late", due: "2026-10-25" }), t({ id: "mine", due: TODAY, time: "09:00" })],
    events: [ev({ id: "past", startDate: "2026-10-20", endDate: "2026-10-20" }), ev({ id: "today", startDate: TODAY, endDate: TODAY })]
  }, TODAY, "all");
  assert.deepStrictEqual(ids(a.overdue), ["renewal:old", "task:late"]);
  assert.deepStrictEqual(ids(a.today), ["event:today", "item:it_2", "renewal:now", "task:mine"]);
  assert.deepStrictEqual(ids(a.week), ["renewal:soon"]);
});

test("the count in the page title: overdue and due today, not events or things further out", function () {
  var data = { renewals: [r({ due: "2026-10-20" }), r({ id: "b", due: "2026-12-01" })], dueItems: [], tasks: [t({ due: TODAY }), t({ id: "c", due: "2026-10-22" })], events: [ev({ startDate: TODAY, endDate: TODAY })] };
  assert.strictEqual(Cal.dueCount(data, TODAY), 3);
});

test("Upcoming is everything dated from today, soonest first, under month headings", function () {
  var g = Cal.upcoming({
    renewals: [r({ id: "z", due: "2027-09-23" }), r({ id: "m", due: "2026-11-05" })], dueItems: [],
    tasks: [t({ id: "a", due: "2026-10-28" })], events: [ev({ id: "e", startDate: "2026-11-02", endDate: "2026-11-02" })]
  }, TODAY, 120, "all");
  assert.deepStrictEqual(g.map(function (x) { return x.title; }), ["October 2026", "November 2026"], "a renewal beyond the window is in the Renewals view instead");
  assert.deepStrictEqual(ids(g[1].entries), ["event:e", "renewal:m"]);
});

test("Renewals: dated soonest first (overdue first of all), then the ones that need a date, then the ones that renew themselves", function () {
  var g = Cal.renewalGroups([r({ id: "z", label: "Z", due: "2027-09-23" }), r({ id: "a", label: "A", due: "2026-10-20" }), r({ id: "m", label: "M", due: "2026-11-05" }), r({ id: "n", label: "N", due: "", state: "needed" }), r({ id: "n2", label: "N2", due: "", state: "known" }), r({ id: "s", label: "S", due: "", state: "auto" })], TODAY);
  assert.deepStrictEqual(g.groups.map(function (x) { return x.title; }), ["Overdue", "November 2026", "September 2027"]);
  assert.deepStrictEqual(g.needed.map(function (x) { return x.id; }), ["n", "n2"]);
  assert.deepStrictEqual(g.auto.map(function (x) { return x.id; }), ["s"]);
});

test("To-dos are grouped: overdue, today, later, the inbox, and recently ticked; nothing is moved for you", function () {
  var g = Cal.groupTasks([
    t({ id: "late", due: "2026-10-20" }), t({ id: "now2", due: TODAY, time: "15:00" }), t({ id: "now1", due: TODAY, time: "09:00" }), t({ id: "soon", due: "2026-11-01" }),
    t({ id: "i1", createdAt: 2 }), t({ id: "i0", createdAt: 1 }), t({ id: "d1", status: "done", doneAt: 5 }), t({ id: "d2", status: "done", doneAt: 9 }),
    t({ id: "hi", due: TODAY, time: "09:00", priority: "high" })
  ], TODAY);
  assert.deepStrictEqual(g.overdue.map(function (x) { return x.id; }), ["late"]);
  assert.deepStrictEqual(g.overdue[0].due, "2026-10-20", "still on its own date");
  assert.deepStrictEqual(g.today.map(function (x) { return x.id; }), ["hi", "now1", "now2"], "by time, then high priority first");
  assert.deepStrictEqual(g.later.map(function (x) { return x.id; }), ["soon"]);
  assert.deepStrictEqual(g.inbox.map(function (x) { return x.id; }), ["i0", "i1"]);
  assert.deepStrictEqual(g.done.map(function (x) { return x.id; }), ["d2", "d1"]);
  assert.strictEqual(Cal.taskDueText(t({ due: "2026-10-24", time: "09:00" }), TODAY), "Sat 24 Oct, 9:00 · overdue by 3 days");
  assert.strictEqual(Cal.taskDueText(t(), TODAY), "No date");
});

test("a month is weeks of seven days, Monday first, with the days either side greyed", function () {
  var g = Cal.monthGrid(2026, 9);
  assert.strictEqual(g.label, "October 2026");
  assert.strictEqual(g.weeks.length, 5);
  assert.ok(g.weeks.every(function (w) { return w.length === 7; }));
  assert.strictEqual(g.weeks[0][0].date, "2026-09-28");
  assert.strictEqual(g.weeks[0][0].inMonth, false);
  assert.strictEqual(g.weeks[0][3].date, "2026-10-01");
  assert.strictEqual(g.weeks[4][6].date, "2026-11-01");
  assert.strictEqual(Cal.monthGrid(2027, 1).weeks.length, 4, "a four-week February that starts on a Monday");
  assert.strictEqual(Cal.monthGrid(2026, 7).weeks.length, 6, "a six-week month keeps its last row");
});

test("a week is seven days from Monday, labelled for people", function () {
  var w = Cal.weekDays("2026-10-28");
  assert.deepStrictEqual([w.start, w.days.length, w.days[6]], ["2026-10-26", 7, "2026-11-01"]);
  assert.strictEqual(w.label, "26 Oct to 1 Nov 2026");
  assert.strictEqual(Cal.weekDays("2026-11-04").label, "2 to 8 Nov 2026");
});

test("the .ics file: CRLF lines, renewals as all-day events with two reminders, own events with their repeat, to-dos with a date", function () {
  var NOW = Date.UTC(2026, 9, 27, 3, 4, 5);
  var ics = Cal.buildIcs({
    renewals: [
      r({ id: "it_a", label: "Mail secret, 24 months", due: "2028-10-27", state: "estimated", where: "Entra; Certificates and secrets", breaks: "Alerts stop", link: "https://entra.microsoft.com/" }),
      r({ id: "runner_key:rk 1", label: "Runner key: laptop", due: "2027-01-31", source: "runner_key", kind: "key" }), r({ id: "n", due: "", state: "needed" }), r({ id: "auto", due: "2027-02-02", state: "auto" })
    ],
    events: [ev({ id: "ev_9", title: "Weekly call", startDate: "2026-11-02", startTime: "09:00", endTime: "09:45", allDay: false, recur: "weekly", notes: "Line one\nLine two" }), ev({ id: "ev_8", title: "Leave", startDate: "2026-12-24", endDate: "2026-12-26" })],
    tasks: [t({ id: "td_a", title: "Call the host", due: "2026-11-03", time: "10:30", priority: "high", recur: "weekdays" }), t({ id: "td_b", title: "Pay", due: "2026-11-04" }), t({ id: "td_c", title: "Inbox" }), t({ id: "td_d", title: "Done", due: "2026-11-05", status: "done" })]
  }, NOW, "https://dashboard.barnyard.site/calendar.html");
  assert.ok(ics.indexOf("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") === 0 && /END:VCALENDAR\r\n$/.test(ics));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends in CRLF");
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 6, "2 renewals, 2 events, 2 dated open to-dos");
  assert.ok(ics.indexOf("UID:renewal-it_a@barnyard.site\r\n") > 0 && ics.indexOf("UID:renewal-runner_key-rk-1@barnyard.site\r\n") > 0 && ics.indexOf("UID:event-ev_9@barnyard.site\r\n") > 0 && ics.indexOf("UID:todo-td_a@barnyard.site\r\n") > 0);
  assert.ok(ics.indexOf("DTSTART;VALUE=DATE:20281027\r\nDTEND;VALUE=DATE:20281028\r\n") > 0, "a renewal is all day, the end is the next day");
  assert.ok(ics.indexOf("SUMMARY:Renew: Mail secret\\, 24 months (estimated)\r\n") > 0);
  assert.ok(ics.indexOf("TRIGGER:-P29DT15H\r\n") > 0 && ics.indexOf("TRIGGER:-P6DT15H\r\n") > 0, "renewals: 30 and 7 days ahead, at 9 in the morning");
  assert.ok(ics.indexOf("DTSTART:20261102T090000\r\nDTEND:20261102T094500\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Weekly call\r\n") > 0, "a timed event keeps its repeat");
  assert.ok(ics.indexOf("DESCRIPTION:Line one\\nLine two") > 0, "line breaks escaped");
  assert.ok(ics.indexOf("DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261227\r\n") > 0, "a multi-day all-day event ends the day after its last day");
  assert.ok(ics.indexOf("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") > 0 && ics.indexOf("SUMMARY:To-do: Call the host") > 0 && ics.indexOf("PRIORITY:1") > 0);
  assert.ok(ics.indexOf("To-do: Inbox") < 0 && ics.indexOf("To-do: Done") < 0, "no date or already ticked: not exported");
  assert.ok(ics.indexOf("Entra\\; Certificates and secrets") > 0, "semicolons escaped");
});

test("long lines are folded at 75 bytes without splitting a character", function () {
  var line = "DESCRIPTION:" + new Array(40).join("éé ");
  var folded = Cal.icsFold(line).split("\r\n");
  assert.ok(folded.length > 1);
  folded.forEach(function (l) { assert.ok(Buffer.byteLength(l, "utf8") <= 75, l); });
  folded.slice(1).forEach(function (l) { assert.strictEqual(l[0], " "); });
  assert.strictEqual(folded.map(function (l, i) { return i ? l.slice(1) : l; }).join(""), line, "nothing lost");
  assert.strictEqual(Cal.icsFold("short"), "short");
});

test("the renewal form builds the Ops item body, keeps the free text, and treats a missing date as 'needed'", function () {
  var res = Cal.renewalBody({ title: "Renew the domain", kind: "domain", due: "2027-03-14", state: "known", where: "Registrar, Renew", link: "https://example.com/renew", breaks: "Every site goes dark", leadDays: "30", renewed: "2026-03-14" }, "My own note.", true);
  assert.deepStrictEqual(res.body.targets, ["renewal", "domain"]);
  assert.strictEqual(res.body.details, "My own note.\n\nDate: known\nWhere: Registrar, Renew\nLink: https://example.com/renew\nBreaks: Every site goes dark\nLead: 30\nRenewed: 2026-03-14");
  assert.deepStrictEqual([res.body.category, res.body.lane, res.body.status, res.body.owner], ["security", "backlog", "scheduled", "you"]);
  var base = { title: "X", kind: "key", due: "", state: "known", where: "", link: "", breaks: "", leadDays: "", renewed: "" };
  var b = function (over) { return Cal.renewalBody(Object.assign({}, base, over), "", false); };
  assert.ok(b({}).body.details.indexOf("Date: needed") === 0);
  assert.ok(b({ due: "2027-01-01", state: "needed" }).body.details.indexOf("Date: estimated") === 0);
  assert.ok(b({ state: "auto" }).body.details.indexOf("Date: auto") === 0);
  assert.strictEqual(b({ title: "  " }).field, "title");
  assert.strictEqual(b({ link: "http://insecure.example/" }).field, "link");
  assert.strictEqual(b({ leadDays: "400" }).field, "leadDays");
  assert.strictEqual(b({ due: "27/10/2026" }).field, "due");
});

test("the to-do form checks what the Worker will check, and reads a link to an Ops item or article", function () {
  var ok = Cal.taskBody({ title: "  Call   the host ", due: "2026-10-28", time: "09:00", priority: "high", recur: "weekly", notes: " n ", ref: "https://dashboard.barnyard.site/ops.html#it_ab12cd34" });
  assert.deepStrictEqual(ok.body, { title: "Call the host", notes: "n", due: "2026-10-28", time: "09:00", priority: "high", recur: "weekly", ref: "it_ab12cd34" });
  assert.strictEqual(Cal.taskBody({ title: "x", ref: "https://study.barnyard.site/knowledgebase.html#/a/ka_qcpw87ug" }).body.ref, "ka_qcpw87ug");
  assert.strictEqual(Cal.taskBody({ title: "x" }).body.ref, "");
  var bad = function (o) { return Cal.taskBody(Object.assign({ title: "x" }, o)).field; };
  assert.strictEqual(bad({ title: "" }), "title");
  assert.strictEqual(bad({ due: "2026-02-30" }), "due");
  assert.strictEqual(bad({ time: "9am", due: TODAY }), "time");
  assert.strictEqual(bad({ time: "09:00" }), "time", "a time needs a date");
  assert.strictEqual(bad({ recur: "daily" }), "recur", "a repeat needs a date");
  assert.strictEqual(bad({ ref: "nonsense" }), "ref");
  assert.strictEqual(Cal.parseRef("hello").error, true);
  assert.strictEqual(Cal.parseRef(""), null);
  assert.strictEqual(Cal.refHref({ kind: "ops", id: "it_ab12cd34" }), "ops.html#it_ab12cd34");
  assert.strictEqual(Cal.refHref({ kind: "kb", id: "ka_qcpw87ug" }), "https://study.barnyard.site/knowledgebase.html#/a/ka_qcpw87ug");
});

test("the event form: all-day when ticked, a start time otherwise, and impossible spans are refused", function () {
  var a = Cal.eventBody({ title: "Leave", startDate: "2026-11-02", allDay: true, startTime: "09:00", endTime: "10:00" });
  assert.deepStrictEqual(a.body, { title: "Leave", notes: "", startDate: "2026-11-02", startTime: "", endDate: "2026-11-02", endTime: "", recur: "" }, "ticking all day drops the times");
  var b = Cal.eventBody({ title: "Call", startDate: "2026-11-02", startTime: "09:00", endTime: "09:45", recur: "weekly" });
  assert.deepStrictEqual([b.body.startTime, b.body.endTime, b.body.recur, b.body.endDate], ["09:00", "09:45", "weekly", "2026-11-02"]);
  var bad = function (o) { return Cal.eventBody(Object.assign({ title: "x", startDate: "2026-11-02", startTime: "09:00" }, o)).field; };
  assert.strictEqual(bad({ title: "" }), "title");
  assert.strictEqual(bad({ startDate: "" }), "startDate");
  assert.strictEqual(bad({ startTime: "" }), "startTime");
  assert.strictEqual(bad({ endDate: "2026-11-01" }), "endDate");
  assert.strictEqual(bad({ endTime: "08:00" }), "endTime");
  assert.strictEqual(bad({ endDate: "2028-01-01" }), "endDate");
});

test("quick add understands plain words for the day, the time, a repeat and the priority", function () {
  var q = function (text) { return Cal.parseQuick(text, TODAY); };   // Tuesday 27 Oct 2026
  var a = q("call host tomorrow 9am");
  assert.deepStrictEqual([a.title, a.due, a.time, a.recur, a.priority], ["Call host", "2026-10-28", "09:00", "", "normal"]);
  assert.deepStrictEqual(a.parts, ["Wed 28 Oct", "9:00"]);
  var b = q("renew domain 14 Mar");
  assert.deepStrictEqual([b.title, b.due], ["Renew domain", "2027-03-14"]);
  assert.strictEqual(q("renew domain 14 March 2028").due, "2028-03-14");
  assert.strictEqual(q("dentist on 3rd Nov").due, "2026-11-03");
  assert.strictEqual(q("pay Nov 3").due, "2026-11-03");
  assert.strictEqual(q("lodge BAS 28 Oct").due, "2026-10-28");
  assert.strictEqual(q("lodge BAS 27 Oct").due, "2026-10-27", "today is today, not next year");
  assert.strictEqual(q("file 14/3").due, "2027-03-14", "day then month, and a date already past means next year");
  assert.strictEqual(q("file 2026-11-30").due, "2026-11-30");
  assert.strictEqual(q("send minutes friday").due, "2026-10-30");
  assert.strictEqual(q("send minutes tuesday").due, "2026-11-03", "a weekday is the next one, never today");
  assert.strictEqual(q("send minutes next monday").due, "2026-11-02");
  assert.strictEqual(q("call in 3 days").due, "2026-10-30");
  assert.strictEqual(q("review in 2 weeks").due, "2026-11-10");
  assert.strictEqual(q("review in 2 months").due, "2026-12-27");
  assert.strictEqual(q("plan next week").due, "2026-11-03");
  assert.strictEqual(q("lunch today at noon").time, "12:00");
  var t = q("meeting 2:30pm today");
  assert.deepStrictEqual([t.time, t.due, t.title], ["14:30", "2026-10-27", "Meeting"]);
  assert.strictEqual(q("standup at 14:00 tomorrow").time, "14:00");
  assert.strictEqual(q("late call 12am tomorrow").time, "00:00");
  var r = q("water the plants every week");
  assert.deepStrictEqual([r.title, r.recur, r.due], ["Water the plants", "weekly", "2026-10-27"]);
  var m = q("pay rent every month on the 1st !high");
  assert.deepStrictEqual([m.title, m.recur, m.due, m.priority], ["Pay rent", "monthly", "2026-11-01", "high"]);
  var e = q("team meeting every monday");
  assert.deepStrictEqual([e.title, e.recur, e.due], ["Team meeting", "weekly", "2026-11-02"]);
  assert.strictEqual(q("check backups every weekday 8am").recur, "weekdays");
  assert.strictEqual(q("renew licence yearly").recur, "yearly");
  assert.strictEqual(q("tidy desk !low").priority, "low");
});

test("quick add leaves ordinary words alone and never loses the title", function () {
  var q = function (text) { return Cal.parseQuick(text, TODAY); };
  assert.deepStrictEqual([q("buy milk").title, q("buy milk").due], ["Buy milk", ""]);
  assert.strictEqual(q("Sat nav update").due, "", "a short weekday on its own is probably a word in the title");
  assert.strictEqual(q("pay by sat").due, "2026-10-31", "but with a preposition it is a day");
  assert.strictEqual(q("read about monthly reports").recur, "monthly");
  assert.strictEqual(q("tomorrow").title, "Tomorrow", "if nothing is left, the words you typed are the title");
  assert.strictEqual(q("call 31 Feb").due, "", "not a date");
  assert.strictEqual(q("call 13pm").time, "");
  assert.strictEqual(q("  ").title, "");
});

test("Google Calendar events: all-day and timed, in the owner's own day, read only", function () {
  var local = new Date(2026, 9, 28, 9, 30);   // 9:30 on 28 Oct in whatever zone this runs in
  var g = Cal.googleEntries([
    { title: "Board meeting", allDay: false, date: "x", start: local.toISOString(), end: new Date(2026, 9, 28, 10, 15).toISOString(), recurring: false },
    { title: "Birthday", allDay: true, date: "2026-10-29", start: "2026-10-29", end: "2026-10-30" },
    { title: "Floating", allDay: false, date: "2026-10-30", start: "2026-10-30T16:00:00", end: "2026-10-30T17:00:00" },
    { title: "Too far", allDay: true, date: "2027-01-01", start: "2027-01-01", end: "2027-01-02" },
    { title: 42 }, null, { title: "Broken", allDay: false, start: "nope" }
  ], "2026-10-26", "2026-11-08");
  assert.deepStrictEqual(g.map(function (x) { return [x.type, x.label, x.due, x.time, x.endTime, x.allDay]; }), [
    ["gcal", "Board meeting", "2026-10-28", "09:30", "10:15", false],
    ["gcal", "Birthday", "2026-10-29", "", "", true],
    ["gcal", "Floating", "2026-10-30", "16:00", "17:00", false]
  ]);
  var map = Cal.entriesByDate({ google: [{ title: "Dentist", allDay: true, date: "2026-10-28" }], tasks: [t({ id: "z", due: "2026-10-28" })], events: [], renewals: [], dueItems: [] }, "2026-10-28", "2026-10-28", "all");
  assert.deepStrictEqual(ids(map["2026-10-28"]), ["gcal:g0:2026-10-28", "task:z"], "an all-day Google event sorts with your own events");
  assert.strictEqual(Cal.dueCount({ google: [{ title: "Today thing", allDay: true, date: TODAY }], tasks: [], events: [], renewals: [], dueItems: [] }, TODAY), 0, "an event is not something to do");
  var ag = Cal.agenda({ google: [{ title: "Past", allDay: true, date: "2026-10-20" }], tasks: [], events: [], renewals: [], dueItems: [] }, TODAY, "all");
  assert.strictEqual(ag.overdue.length, 0, "a Google event that has happened is not overdue");
});

test("the Overview's to-do widget shows the same to-dos in a sensible order, with a count of the rest", function () {
  var tasks = [t({ id: "later", due: "2026-11-05" }), t({ id: "inbox", due: "" }), t({ id: "late", due: "2026-10-20" }), t({ id: "now", due: TODAY }), t({ id: "done", status: "done", due: TODAY })];
  var w = Cal.widgetTasks(tasks, TODAY, 3);
  assert.deepStrictEqual(w.rows.map(function (x) { return x.id; }), ["late", "now", "later"]);
  assert.strictEqual(w.more, 1);
  assert.deepStrictEqual(Cal.widgetTasks([], TODAY, 3), { rows: [], more: 0 });
});

test("the widget is owner-only on the server, leaves the browser's own list alone, and never imports without a click", function () {
  var js = fs.readFileSync(path.join(root, "todo-widget.js"), "utf8");
  var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/who\.onChange/.test(js) && /w\.owner === true/.test(js), "only the owner is switched to the server list");
  assert.ok(!/removeItem|localStorage\.clear/.test(js), "nothing is ever removed from the browser");
  assert.ok(/IMPORTED_KEY/.test(js) && /IMPORT_PROGRESS_KEY/.test(js), "a retry after a failure carries on from where it stopped");
  var onImport = js.slice(js.indexOf("function offerImport"), js.indexOf("function runImport"));
  assert.ok(/addEventListener\("click"/.test(onImport) && !/runImport\(local[^)]*\);\s*$/m.test(onImport.replace(/go\.addEventListener[^\n]*\n/, "")), "the import runs from a button, not on load");
  assert.ok(/id="todo-sub"/.test(html) && /id="todo-import"/.test(html));
  assert.ok(html.indexOf("calendar-logic.js") > 0 && html.indexOf("calendar-logic.js") < html.indexOf("todo-widget.js"), "the rules load before the widget");
  assert.ok(!/innerHTML/.test(js.slice(js.indexOf("// ---- the owner's list"), js.indexOf("function initTodo"))), "the server-backed part builds the list the safe way");
});

test("the page: strict CSP, no inline script or style, no innerHTML, scripts in the right order, the menu has the item", function () {
  var html = fs.readFileSync(path.join(root, "calendar.html"), "utf8");
  assert.ok(/Content-Security-Policy[^>]*script-src 'self'/.test(html) && /style-src 'self'/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/<style/i.test(html) && !/ style=/.test(html) && !/ on[a-z]+=/i.test(html));
  assert.ok(/data-shell="calendar"/.test(html));
  ["calendar-logic.js", "calendar.js", "calendar.css", "shell.js", "shell.css"].forEach(function (f) { assert.ok(html.indexOf(f) > 0, f); });
  assert.ok(html.indexOf("calendar-logic.js") < html.indexOf('src="calendar.js'), "the rules load before the page");
  ["cal-quick", "cal-quick-title", "cal-quick-date", "cal-toast", "cal-add-event", "cal-add-renewal", "cal-ics", "cal-tabs", "cal-nav", "cal-prev", "cal-next", "cal-today", "cal-kind", "cal-root", "cal-drawer", "cal-drawer-title", "cal-drawer-body", "cal-drawer-close"].forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') > 0, "calendar.html has #" + id);
  });
  ["calendar.js", "calendar-logic.js"].forEach(function (f) {
    var js = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js.replace(/\/\/.*$/gm, "")), f + " builds the page the safe way");
  });
  var ui = fs.readFileSync(path.join(root, "calendar.js"), "utf8");
  var ids = ui.match(/\$\("([a-z-]+)"\)/g).map(function (m) { return m.slice(3, -2); });
  ids.forEach(function (id) { if (/^cal-/.test(id)) assert.ok(html.indexOf('id="' + id + '"') > 0, "calendar.js asks for #" + id + " and the page has it"); });
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  assert.ok(/id: "calendar", title: "Calendar"[^}]*ownerOnly: true/.test(shell));
  assert.ok(/calendar: '</.test(shell), "it has an icon");
});

test("the page keeps only a speed copy and two preferences in this browser, and says so", function () {
  var js = fs.readFileSync(path.join(root, "calendar.js"), "utf8");
  var keys = (js.match(/localStorage\.(get|set)Item\(([A-Z_]+)/g) || []).map(function (m) { return m.split("(")[1]; });
  assert.deepStrictEqual(Array.from(new Set(keys)).sort(), ["CACHE_KEY", "PREF_KEY"]);
  assert.ok(/barnyard-calendar-prefs/.test(js) && /barnyard-calendar-cache/.test(js));
  var html = fs.readFileSync(path.join(root, "calendar.html"), "utf8");
  assert.ok(/Only in this browser/.test(html) && /backup/.test(html), "the page says what is browser-only and that the rest is in the backup");
  assert.ok(/Showing the copy saved on this device/.test(js), "a cached view is marked as such");
});

console.log(passed + " passed");
