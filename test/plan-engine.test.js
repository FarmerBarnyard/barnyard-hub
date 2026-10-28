// Coverage for planner-engine.js (the day planner's scheduler, the evening review and the tile's next-up list): deadlines and priority,
// events and lunch, load caps, what does not fit, accepted and locked blocks under a re-plan, learning, and that nothing depends on a
// time zone. The Plan view's drawing was checked in a browser.
//
//   node test/plan-engine.test.js

var assert = require("assert");
var path = require("path");
var E = require(path.join(__dirname, "..", "planner-engine.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

// 2026-10-26 is a Monday. "now" is 08:00 unless a test says otherwise.
var MON = "2026-10-26", TUE = "2026-10-27", WED = "2026-10-28", THU = "2026-10-29", FRI = "2026-10-30", SAT = "2026-10-31", NEXTMON = "2026-11-02";
var m = E.toMin;
var seq = 0;
function task(over) { seq++; return Object.assign({ id: "td_" + ("0000000" + seq).slice(-8), title: "Task " + seq, status: "open", due: "", time: "", priority: "normal", estimate: 30, tag: "", focus: "", spent: 0 }, over); }
function plan(over) { return E.buildPlan(Object.assign({ today: MON, nowMin: m("08:00"), settings: {}, tasks: [], events: [], google: [], blocks: [], ratios: {}, scope: [MON], reflow: false }, over)); }
function placed(p, id) { return p.suggested.filter(function (b) { return b.taskId === id; }); }
function span(b) { return E.fromMin(b.start) + "-" + E.fromMin(b.end); }
function day(p, date) { return p.days.filter(function (d) { return d.date === date; })[0]; }
function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

test("one to-do is placed at the start of the working day, as one block when it is only a little over a focus block", function () {
  var t = task({ estimate: 60, due: WED });
  var p = plan({ tasks: [t] });
  assert.deepStrictEqual(placed(p, t.id).map(span), ["08:00-09:00"]);
  assert.deepStrictEqual(p.unplaced, []);
  assert.deepStrictEqual(p.warnings, []);
  var long = task({ estimate: 120, due: WED });
  var q = plan({ tasks: [long] });
  assert.deepStrictEqual(placed(q, long.id).map(span), ["08:00-08:50", "09:00-09:50", "10:00-10:20"], "50-minute focus blocks with 10-minute breaks");
});

test("a to-do with no estimate is planned at the default length; time already worked comes off; a to-do worked past its estimate gets a wrap-up", function () {
  var a = task({ estimate: 0 }), b = task({ estimate: 60, spent: 40 }), c = task({ estimate: 30, spent: 45 });
  var p = plan({ tasks: [a, b, c], settings: { defaultMin: 25 } });
  assert.strictEqual(placed(p, a.id)[0].minutes, 25);
  assert.strictEqual(placed(p, b.id)[0].minutes, 20);
  assert.strictEqual(placed(p, c.id)[0].minutes, 15);
});

test("earliest deadline first, and a priority nudge of two days", function () {
  var late = task({ title: "late", estimate: 60, due: FRI }), soon = task({ title: "soon", estimate: 60, due: TUE });
  var p = plan({ tasks: [late, soon] });
  assert.ok(placed(p, soon.id)[0].start < placed(p, late.id)[0].start, "the sooner deadline is first");
  var hi = task({ title: "hi", estimate: 60, due: WED, priority: "high" }), nor = task({ title: "nor", estimate: 60, due: TUE });
  var q = plan({ tasks: [nor, hi] });
  assert.ok(placed(q, hi.id)[0].start < placed(q, nor.id)[0].start, "high priority due Wednesday counts as due Monday, ahead of a normal one due Tuesday");
  var lo = task({ estimate: 60, due: TUE, priority: "low" }), nor2 = task({ estimate: 60, due: WED });
  var r = plan({ tasks: [lo, nor2] });
  assert.ok(placed(r, nor2.id)[0].start < placed(r, lo.id)[0].start, "low priority due Tuesday counts as due Thursday, behind a normal one due Wednesday");
  var inbox = task({ estimate: 60, due: "" }), dated = task({ estimate: 60, due: FRI });
  var s = plan({ tasks: [inbox, dated] });
  assert.ok(placed(s, dated.id)[0].start < placed(s, inbox.id)[0].start, "to-dos with no date go after dated ones");
});

test("an overdue to-do goes in first, today, and is not called late", function () {
  var od = task({ estimate: 30, due: "2026-10-20" }), ok = task({ estimate: 30, due: TUE });
  var p = plan({ tasks: [ok, od] });
  assert.strictEqual(placed(p, od.id)[0].date, MON);
  assert.strictEqual(placed(p, od.id)[0].start, m("08:00"));
  assert.deepStrictEqual(p.late, []);
  var hi = task({ estimate: 30, due: MON, priority: "high" }), older = task({ estimate: 30, due: "2026-10-22" }), od2 = task({ estimate: 30, due: "2026-10-24" });
  var q = plan({ tasks: [hi, od2, older] });
  assert.deepStrictEqual([older, od2, hi].map(function (x) { return placed(q, x.id)[0].start; }).slice().sort(function (a, b) { return a - b; }), [older, od2, hi].map(function (x) { return placed(q, x.id)[0].start; }), "the longest overdue first, then the other overdue one, then the high-priority one due today");
});

test("events and Google Calendar entries are never overlapped, and leave the buffer around them", function () {
  var t = task({ estimate: 120, due: WED });
  var events = [{ id: "ev_1", title: "Stand-up", startDate: MON, startTime: "09:00", endDate: MON, endTime: "09:30", recur: "" }];
  var google = [{ title: "Dentist", allDay: false, start: MON + "T10:30:00", end: MON + "T11:15:00" }];
  var p = plan({ tasks: [t], events: events, google: google });
  var blocks = placed(p, t.id);
  blocks.forEach(function (b) {
    assert.ok(!overlaps(b, { start: m("09:00"), end: m("09:30") }), "not over the stand-up: " + span(b));
    assert.ok(!overlaps(b, { start: m("10:30"), end: m("11:15") }), "not over the dentist: " + span(b));
  });
  assert.ok(blocks[0].end <= m("09:00") - 10, "the buffer before the stand-up: " + span(blocks[0]));
  assert.ok(blocks.every(function (b) { return b.start >= m("08:00"); }));
  var d = day(p, MON).items.map(function (i) { return i.type; });
  assert.ok(d.indexOf("event") >= 0 && d.indexOf("gcal") >= 0, "the day lists them too");
  assert.strictEqual(blocks.reduce(function (n, b) { return n + b.minutes; }, 0), 120, "all of it is placed");
});

test("all-day events do not block time; a multi-day timed event blocks the days in the middle", function () {
  var t = task({ estimate: 60, due: THU });
  var allDay = [{ id: "ev_a", title: "Conference", startDate: MON, startTime: "", endDate: MON, endTime: "", recur: "" }];
  assert.strictEqual(placed(plan({ tasks: [t], events: allDay }), t.id)[0].start, m("08:00"));
  var multi = [{ id: "ev_m", title: "Trip", startDate: MON, startTime: "15:00", endDate: WED, endTime: "10:00", recur: "" }];
  var t2 = task({ estimate: 60, due: THU });
  var p = plan({ tasks: [t2], events: multi });
  var b = placed(p, t2.id)[0];
  assert.ok(b.date === MON && b.end <= m("15:00") - 10 || b.date === WED && b.start >= m("10:10") || b.date === THU, "not on Tuesday, not during the trip: " + b.date + " " + span(b));
  assert.notStrictEqual(b.date, TUE);
});

test("lunch is kept free, and work stays inside working hours", function () {
  var t = task({ estimate: 240, due: WED, focus: "quick" });          // one 4-hour piece cannot fit before lunch
  var p = plan({ tasks: [task({ estimate: 200, due: WED }), t] });
  p.suggested.forEach(function (b) {
    assert.ok(!overlaps(b, { start: m("12:00"), end: m("12:45") }), "lunch is free: " + span(b));
    assert.ok(b.start >= m("08:00") && b.end <= m("17:00"), "inside working hours: " + span(b));
  });
});

test("weekends are skipped, and a Friday to-do that cannot fit goes to Monday and is flagged as after its deadline", function () {
  var t = task({ estimate: 60, due: SAT });                          // due on a Saturday: the room is on Friday or before
  var p = plan({ today: FRI, scope: [FRI], tasks: [t] });
  assert.strictEqual(placed(p, t.id)[0].date, FRI);
  assert.deepStrictEqual(p.late, []);
  var big = task({ title: "Big", estimate: 90, due: FRI });
  var p2 = plan({ today: FRI, scope: [FRI], tasks: [big], settings: { loadMin: 60 } });
  assert.ok(placed(p2, big.id).some(function (b) { return b.date === NEXTMON; }), "the rest rolls to Monday, not Saturday");
  assert.strictEqual(p2.late.length, 1);
  assert.ok(/due Fri 30 Oct but the first room for it is Mon 2 Nov/.test(p2.warnings.filter(function (w) { return w.kind === "late"; })[0].text), p2.warnings.map(function (w) { return w.text; }).join(" | "));
  assert.strictEqual(day(p2, SAT).working, false);
});

test("a day never takes more than the daily load", function () {
  var ts = [1, 2, 3].map(function () { return task({ estimate: 60, due: FRI }); });
  var p = plan({ tasks: ts, settings: { loadMin: 120 } });
  assert.strictEqual(day(p, MON).plannedMin, 120);
  assert.strictEqual(placed(p, ts[2].id)[0].date, TUE, "the third goes to Tuesday");
  assert.strictEqual(day(p, MON).full, true);
});

test("when the days ahead cannot hold what is due, it says so with numbers", function () {
  var ts = [1, 2, 3, 4].map(function (i) { return task({ title: "Job " + i, estimate: 180, due: MON }); });
  var p = plan({ tasks: ts, settings: { loadMin: 360 } });
  var w = p.warnings.filter(function (x) { return x.kind === "overload"; })[0];
  assert.ok(w, "an overload warning");
  assert.strictEqual(w.needMin, 720);
  assert.ok(w.capMin < 720);
  assert.ok(/By Mon 26 Oct you need 12 h but have room for/.test(w.text), w.text);
  assert.strictEqual(p.late.length >= 1, true, "and the extra work is placed after the deadline, flagged");
});

test("no working days at all: nothing fits, and each to-do is listed with why", function () {
  var t = task({ estimate: 60 });
  var p = plan({ tasks: [t], settings: { days: [] } });
  assert.deepStrictEqual(p.suggested, []);
  assert.deepStrictEqual(p.unplaced.map(function (u) { return [u.taskId, u.reason]; }), [[t.id, "no_room"]]);
  assert.ok(/has no room in the next 14 days/.test(p.warnings[0].text));
});

test("a to-do with a time is a fixed commitment: it takes its slot and is not planned again", function () {
  var fixed = task({ title: "Call the bank", due: MON, time: "08:30", estimate: 30 }), other = task({ estimate: 60, due: TUE });
  var p = plan({ tasks: [fixed, other] });
  assert.deepStrictEqual(placed(p, fixed.id), []);
  var items = day(p, MON).items.filter(function (i) { return i.type === "todo"; });
  assert.deepStrictEqual([items.length, items[0].start, items[0].end], [1, m("08:30"), m("09:00")]);
  assert.ok(!overlaps(placed(p, other.id)[0], { start: m("08:30"), end: m("09:00") }));
  assert.strictEqual(day(p, MON).plannedMin >= 30 + 60, true, "its time counts towards the day's load");
});

test("a quick to-do goes in the snuggest gap that holds it; a focus one takes the first gap that holds a whole block", function () {
  var events = [{ id: "ev_1", title: "Meeting", startDate: MON, startTime: "08:45", endDate: MON, endTime: "09:35", recur: "" }];
  var quick = task({ estimate: 30, focus: "quick", due: TUE }), deep = task({ estimate: 50, focus: "focus", due: TUE });
  var p = plan({ tasks: [deep, quick], events: events });
  assert.strictEqual(span(placed(p, quick.id)[0]), "08:00-08:30", "the small gap before the meeting");
  assert.strictEqual(placed(p, deep.id)[0].start >= m("09:45"), true, "the focus block waits for a gap that holds all of it");
});

test("today starts from now, and after working hours the plan starts tomorrow", function () {
  var t = task({ estimate: 60, due: WED });
  assert.strictEqual(placed(plan({ tasks: [t], nowMin: m("10:07") }), t.id)[0].start, m("10:10"), "rounded up to the next 5 minutes");
  var p = plan({ tasks: [t], nowMin: m("17:30") });
  assert.strictEqual(placed(p, t.id)[0].date, TUE);
  assert.strictEqual(day(p, MON).window, null);
  assert.strictEqual(plan({ tasks: [t], nowMin: m("16:50") }).days[0].window, null, "ten minutes left is not a window");
});

test("accepted blocks stay where they are and count: they take the time, the load, and the to-do's need", function () {
  var t = task({ estimate: 90, due: WED }), u = task({ estimate: 30, due: WED });
  var blocks = [{ id: "bk_1", taskId: t.id, date: MON, start: "08:00", end: "09:30", locked: false, state: "planned" }];
  var p = plan({ tasks: [t, u], blocks: blocks });
  assert.deepStrictEqual(placed(p, t.id), [], "already fully planned");
  assert.ok(placed(p, u.id)[0].start >= m("09:40"), "the next to-do goes after it, with the buffer");
  var items = day(p, MON).items.filter(function (i) { return i.type === "block"; });
  assert.strictEqual(items.length, 1);
  var part = [{ id: "bk_2", taskId: t.id, date: MON, start: "08:00", end: "08:30", locked: false, state: "planned" }];
  assert.strictEqual(placed(plan({ tasks: [t], blocks: part }), t.id).reduce(function (n, b) { return n + b.minutes; }, 0), 60, "only the missing 60 minutes are suggested");
});

test("a re-plan lets go of unlocked blocks in scope, keeps locked, started and finished ones, and does not touch days outside scope", function () {
  var a = task({ estimate: 60, due: WED }), b = task({ estimate: 60, due: WED }), c = task({ estimate: 60, due: WED }), d = task({ estimate: 60, due: THU });
  var blocks = [
    { id: "bk_a", taskId: a.id, date: MON, start: "13:00", end: "14:00", locked: false, state: "planned" },    // dropped: unlocked, in scope
    { id: "bk_b", taskId: b.id, date: MON, start: "09:00", end: "10:00", locked: true, state: "planned" },     // kept: pinned
    { id: "bk_c", taskId: c.id, date: MON, start: "10:30", end: "11:30", locked: false, state: "running" },   // kept: started
    { id: "bk_d", taskId: d.id, date: TUE, start: "09:00", end: "10:00", locked: false, state: "planned" }    // kept: outside scope
  ];
  var p = plan({ tasks: [a, b, c, d], blocks: blocks, reflow: true, scope: [MON] });
  assert.deepStrictEqual(p.dropped.map(function (x) { return x.id; }), ["bk_a"]);
  assert.strictEqual(placed(p, a.id).length > 0, true, "its to-do is planned again");
  assert.deepStrictEqual(placed(p, b.id).concat(placed(p, c.id)).concat(placed(p, d.id)), [], "the others are still covered");
  var pay = E.acceptPayload(p);
  assert.deepStrictEqual(pay.replaceDates, [MON]);
  assert.ok(pay.blocks.every(function (x) { return x.date === MON; }));
  assert.ok(pay.blocks.every(function (x) { return /^\d\d:\d\d$/.test(x.start) && /^\d\d:\d\d$/.test(x.end); }));
  var noReflow = plan({ tasks: [a], blocks: blocks, reflow: false, scope: [MON] });
  assert.deepStrictEqual([noReflow.dropped.length, E.acceptPayload(noReflow).replaceDates], [0, []], "a plain suggestion replaces nothing");
});

test("a block the owner skipped is not in the way; a ticked to-do is not planned", function () {
  var t = task({ estimate: 60, due: WED }), done = task({ estimate: 60, status: "done" });
  var blocks = [{ id: "bk_s", taskId: t.id, date: MON, start: "08:00", end: "09:00", locked: false, state: "skipped" }];
  var p = plan({ tasks: [t, done], blocks: blocks });
  assert.strictEqual(placed(p, t.id)[0].start, m("08:00"));
  assert.deepStrictEqual(placed(p, done.id), []);
});

test("learning: off by default; on, a to-do's time is scaled by the median ratio for its tag (else the overall one)", function () {
  var ratios = { admin: { ratio: 1.5, n: 8 }, "": { ratio: 1.2, n: 20 } };
  var t = task({ estimate: 60, tag: "admin" }), u = task({ estimate: 60, tag: "other" });
  assert.strictEqual(E.needMinutes(t, E.settingsOf({}), ratios).minutes, 60, "off");
  var on = E.settingsOf({ learn: true });
  assert.deepStrictEqual([E.needMinutes(t, on, ratios).minutes, E.needMinutes(t, on, ratios).ratio], [90, 1.5]);
  assert.strictEqual(E.needMinutes(u, on, ratios).minutes, 75, "the overall ratio when the tag has none");
  assert.strictEqual(E.needMinutes(u, on, {}).minutes, 60, "nothing learned yet");
  var p = plan({ tasks: [t], ratios: ratios, settings: { learn: true } });
  assert.strictEqual(placed(p, t.id).reduce(function (n, b) { return n + b.minutes; }, 0), 90);
  assert.strictEqual(E.learnedText(ratios, "admin"), "You usually take 1.5× your estimate for admin (8 sessions).");
  assert.strictEqual(E.learnedText(ratios, "other"), "You usually take 1.2× your estimate (20 sessions).");
  assert.strictEqual(E.learnedText({}, "x"), "");
  assert.strictEqual(E.learnedText({ "": { ratio: 1, n: 5 } }, ""), "Your estimates for your to-dos have been about right (5 sessions).");
});

test("it is deterministic and reads no clock: the same input gives the same plan, with Date.now unavailable", function () {
  var ts = [task({ estimate: 120, due: WED }), task({ estimate: 45, due: TUE, priority: "high" })];
  var a = JSON.stringify(plan({ tasks: ts }));
  var real = Date.now;
  Date.now = function () { throw new Error("the scheduler must not read the clock"); };
  try { assert.strictEqual(JSON.stringify(plan({ tasks: ts })), a); } finally { Date.now = real; }
});

test("Perth has no daylight saving, and the planner would not care: a week across another zone's clock change has the same shape", function () {
  var days = ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"];      // Sydney's clocks went forward on the 4th
  var p = plan({ today: "2026-10-02", scope: ["2026-10-02"], nowMin: m("08:00"), tasks: [task({ estimate: 60, due: "2026-10-06" })] });
  var working = p.days.filter(function (d) { return d.working && days.indexOf(d.date) >= 0; });
  assert.deepStrictEqual(working.map(function (d) { return d.window.e - d.window.s; }), [540, 540, 540], "Friday, Monday and Tuesday are all 08:00 to 17:00 (the weekend is not working)");
  assert.strictEqual(placed(p, p.suggested[0].taskId)[0].date, "2026-10-02");
});

test("the timer helpers: elapsed time from the server's copy, and a clock face", function () {
  assert.strictEqual(E.timerElapsed(null, 1000), 0);
  assert.strictEqual(E.timerElapsed({ accMs: 60000, running: false, startedAt: 0 }, 99999), 60000);
  assert.strictEqual(E.timerElapsed({ accMs: 60000, running: true, startedAt: 5000 }, 35000), 90000);
  assert.strictEqual(E.timerElapsed({ accMs: 0, running: true, startedAt: 5000 }, 1000), 0, "a clock that is a little behind never goes negative");
  assert.strictEqual(E.clockText(0), "0:00");
  assert.strictEqual(E.clockText(65000), "1:05");
  assert.strictEqual(E.clockText(3725000), "1:02:05");
});

test("the evening review: what got done, what slipped, and what could roll over", function () {
  var noon = new Date(2026, 9, 26, 12, 0, 0).getTime();          // local noon on the 26th, whatever this machine's zone
  var yesterday = new Date(2026, 9, 25, 12, 0, 0).getTime();
  var doneToday = task({ status: "done", doneAt: noon }), doneBefore = task({ status: "done", doneAt: yesterday });
  var slipped = task({ due: MON }), planned = task({ due: WED }), later = task({ due: FRI }), inbox = task({ due: "" });
  var repeating = task({ due: TUE, lastDoneAt: noon });
  var blocks = [
    { id: "bk_1", taskId: slipped.id, date: MON, start: "09:00", end: "10:00", state: "planned" },
    { id: "bk_2", taskId: planned.id, date: MON, start: "10:00", end: "11:00", state: "done" },
    { id: "bk_3", taskId: later.id, date: MON, start: "13:00", end: "13:30", state: "skipped" },
    { id: "bk_4", taskId: inbox.id, date: MON, start: "14:00", end: "14:30", state: "planned" },
    { id: "bk_5", taskId: later.id, date: TUE, start: "09:00", end: "10:00", state: "planned" }
  ];
  var r = E.review({ today: MON, tasks: [doneToday, doneBefore, slipped, planned, later, inbox, repeating], blocks: blocks, worked: [{ date: MON, minutes: 95 }, { date: SUN() , minutes: 400 }] });
  assert.deepStrictEqual(r.done.map(function (t) { return t.id; }).sort(), [doneToday.id, repeating.id].sort());
  assert.deepStrictEqual(r.missed.map(function (t) { return t.id; }).sort(), [inbox.id, slipped.id].sort());
  assert.deepStrictEqual(r.carry.map(function (t) { return t.id; }), [slipped.id], "only to-dos with a date can be moved; an inbox to-do just gets planned again");
  assert.deepStrictEqual([r.plannedMin, r.workedMin], [60 + 60 + 30, 95], "planned: the ones not skipped; worked: today's only");
});
function SUN() { return "2026-10-25"; }

test("the tile's next-up list: today's accepted blocks from now on, soonest first, for open to-dos only", function () {
  var a = task({ title: "A" }), b = task({ title: "B" }), done = task({ title: "C", status: "done" });
  var plan1 = { blocks: [
    { id: "bk_1", taskId: b.id, date: MON, start: "13:00", end: "14:00", state: "planned" },
    { id: "bk_2", taskId: a.id, date: MON, start: "09:00", end: "09:25", state: "planned" },
    { id: "bk_3", taskId: a.id, date: MON, start: "08:00", end: "08:30", state: "done" },
    { id: "bk_4", taskId: done.id, date: MON, start: "15:00", end: "16:00", state: "planned" },
    { id: "bk_5", taskId: a.id, date: TUE, start: "09:00", end: "10:00", state: "planned" },
    { id: "bk_6", taskId: b.id, date: MON, start: "07:00", end: "07:30", state: "planned" }
  ] };
  var n = E.nextBlocks(plan1, [a, b, done], MON, m("08:45"));
  assert.deepStrictEqual(n.map(function (x) { return x.id; }), ["bk_2", "bk_1"]);
  assert.deepStrictEqual([n[0].title, n[0].minutes], ["A", 25]);
  assert.deepStrictEqual(E.nextBlocks(null, [], MON, 0), []);
});

test("formatting helpers", function () {
  assert.strictEqual(E.hoursText(45), "45 min");
  assert.strictEqual(E.hoursText(60), "1 h");
  assert.strictEqual(E.hoursText(135), "2 h 15 min");
  assert.strictEqual(E.fromMin(9 * 60 + 5), "09:05");
  assert.strictEqual(E.toMin("25:00"), null);
  assert.strictEqual(E.toMin("bad"), null);
});

console.log("\n" + passed + " passed");
