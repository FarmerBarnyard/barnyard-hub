// Basic unit coverage for glance-widgets.js's pure calendar day-matching
// logic -- added following a review round that found (1) timed events were
// being matched to day columns using the Worker's UTC-dated `date` field
// instead of the visitor's own local date (landing every timed event on the
// wrong day for any visitor not in/near UTC), and (2) this file had zero
// test coverage despite adding pure logic comparable to live-prices.js's,
// which got the module.exports-guard treatment one review round earlier
// (see test/live-prices.test.js). This repo has no build step and no
// package.json, so this is a plain Node script using only the standard
// library (`assert`), run with:
//
//   node test/glance-widgets.test.js
//
// Deliberately does NOT spin up a DOM/jsdom -- glance-widgets.js exports its
// pure, DOM-free helpers via a `module.exports` guard (a no-op in the
// browser) specifically so this file can require() it directly. DOM-facing
// functions (renderWeek, fetchCalendarEvents, renderCalendarStatus, etc.)
// are out of scope here.
//
// Several tests below set `process.env.TZ` before calling into the module
// under test, to pin the process's own local timezone -- exactly what
// localDateStr/eventLocalDate key off via Date's local getters -- to a known
// value rather than whatever the test runner's host happens to default to.
// This is the standard technique for exercising local-timezone-dependent
// logic under plain Node without a heavier timezone-mocking dependency; it
// works because each `new Date()`/local getter call re-reads the current
// zone rather than caching it at process start.

var assert = require("assert");
var path = require("path");

var originalTZ = process.env.TZ;
var gw = require(path.join(__dirname, "..", "glance-widgets.js"));

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// ---- pad2 -------------------------------------------------------------

test("pad2: single-digit numbers get a leading zero", function () {
  assert.strictEqual(gw.pad2(5), "05");
  assert.strictEqual(gw.pad2(0), "00");
});

test("pad2: two-digit numbers pass through unchanged", function () {
  assert.strictEqual(gw.pad2(23), "23");
});

// ---- localDateStr -------------------------------------------------------

test("localDateStr: formats as zero-padded YYYY-MM-DD", function () {
  var d = new Date(2026, 0, 5, 13, 0, 0); // local Jan 5 2026 (month is 0-indexed)
  assert.strictEqual(gw.localDateStr(d), "2026-01-05");
});

// ---- eventLocalDate -------------------------------------------------------
// The core regression case from review finding 1: a Google Calendar
// TZID-qualified DTSTART, already resolved by the Worker to a UTC instant
// (trailing "Z" on `start`), must be matched to the visitor's LOCAL date --
// not the UTC date the Worker's own `date` field carries. Hand-traced in the
// review report against exactly these two scenarios (a positive-offset
// morning event, a negative-offset evening event) before this test existed
// to check it automatically.

test("eventLocalDate: a UTC+10 visitor's 9am local meeting lands on the correct (later) local day, not the earlier UTC day", function () {
  process.env.TZ = "Australia/Sydney"; // UTC+10 (AEST -- winter/southern in August, still standard time)
  // 2026-08-19T23:00:00Z is 2026-08-20T09:00:00+10:00 in Sydney -- a 9am
  // local meeting. The Worker's own `date` field for this event reads
  // "2026-08-19" (the UTC date) -- exactly the wrong value finding 1
  // flagged (one day early). eventLocalDate must resolve to "2026-08-20".
  var ev = {
    allDay: false,
    date: "2026-08-19",
    start: "2026-08-19T23:00:00.000Z",
    end: "2026-08-20T00:00:00.000Z"
  };
  assert.strictEqual(gw.eventLocalDate(ev), "2026-08-20");
});

test("eventLocalDate: a UTC-4 visitor's 8pm local meeting lands on the correct (earlier) local day, not the later UTC day", function () {
  process.env.TZ = "America/New_York"; // UTC-4 (EDT -- daylight saving, in effect in August)
  // 2026-08-21T00:00:00Z is 2026-08-20T20:00:00-04:00 in New York -- an 8pm
  // local meeting. The Worker's own `date` field for this event reads
  // "2026-08-21" (the UTC date) -- one day late, the mirror case from
  // finding 1. eventLocalDate must resolve to "2026-08-20".
  var ev = {
    allDay: false,
    date: "2026-08-21",
    start: "2026-08-21T00:00:00.000Z",
    end: "2026-08-21T01:00:00.000Z"
  };
  assert.strictEqual(gw.eventLocalDate(ev), "2026-08-20");
});

test("eventLocalDate: an all-day event uses `date` as-is (no time component to convert)", function () {
  process.env.TZ = "Australia/Sydney";
  var ev = { allDay: true, date: "2026-08-20", start: "2026-08-20", end: "2026-08-21" };
  assert.strictEqual(gw.eventLocalDate(ev), "2026-08-20");
});

test("eventLocalDate: a floating (no trailing Z) start's wall-clock date is taken as-is", function () {
  process.env.TZ = "Australia/Sydney";
  var ev = { allDay: false, date: "2026-08-20", start: "2026-08-20T09:00:00" };
  assert.strictEqual(gw.eventLocalDate(ev), "2026-08-20");
});

test("eventLocalDate: null/missing event or start returns null rather than throwing", function () {
  assert.strictEqual(gw.eventLocalDate(null), null);
  assert.strictEqual(gw.eventLocalDate({ allDay: false }), null);
  assert.strictEqual(gw.eventLocalDate({ allDay: false, start: 12345 }), null);
});

test("eventLocalDate: an unparseable Z-suffixed start returns null rather than throwing/NaN-ing", function () {
  var ev = { allDay: false, start: "not-a-dateZ" };
  assert.strictEqual(gw.eventLocalDate(ev), null);
});

// Restore whatever TZ the process actually started with, so this file
// doesn't leak a changed timezone into any test run after it.
process.env.TZ = originalTZ;

console.log(passed + " passed");
