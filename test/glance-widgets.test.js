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
// zone rather than caching it at process start -- on platforms where V8
// actually honors `process.env.TZ` for IANA zone names. It does NOT
// reliably work on Windows (this repo's own dev platform): V8 on Windows
// reads the OS's configured timezone rather than honoring arbitrary IANA
// `TZ` values the way POSIX libc-backed builds do, so setting
// `process.env.TZ = "Australia/Sydney"` on a Windows box whose OS timezone
// is something else quietly has no effect at all. The probe right below
// this comment block detects that at runtime and skips just the
// TZ-dependent assertions (via `zoneTest`) rather than letting them fail
// with a confusing off-by-some-hours mismatch that has nothing to do with
// the actual eventLocalDate logic under test.

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

// First `process.env.TZ` assignment in the file -- immediately followed by
// a runtime check of whether it actually took effect (see the comment block
// above). 2026-08-20T00:00:00.000Z is 2026-08-20T10:00:00+10:00 in Sydney
// (AEST, UTC+10, no daylight saving in the southern winter) -- if the pin
// took effect, a plain `Date`'s local `getHours()` for that instant must
// read 10. If it doesn't (the Windows case described above, or any other
// platform/config that doesn't honor IANA TZ names), `tzPinningWorks` below
// is false and the TZ-dependent tests are skipped instead of run.
process.env.TZ = "Australia/Sydney";
var tzPinningWorks = new Date("2026-08-20T00:00:00.000Z").getHours() === 10;
if (!tzPinningWorks) {
  console.log(
    "SKIP: process.env.TZ pinning unsupported on this platform -- " +
    "skipping timezone-dependent eventLocalDate assertions"
  );
}

// Like `test`, but for assertions that depend on process.env.TZ pinning
// actually working (see `tzPinningWorks` above) -- silently skipped (with a
// per-test SKIP line, not a failure) rather than run and produce a
// confusing platform-specific mismatch unrelated to the logic under test.
function zoneTest(name, fn) {
  if (!tzPinningWorks) {
    console.log("skip - " + name + " (TZ pinning unsupported on this platform)");
    return;
  }
  test(name, fn);
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

zoneTest("eventLocalDate: a UTC+10 visitor's 9am local meeting lands on the correct (later) local day, not the earlier UTC day", function () {
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

zoneTest("eventLocalDate: a UTC-4 visitor's 8pm local meeting lands on the correct (earlier) local day, not the later UTC day", function () {
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

// These next two don't actually depend on TZ conversion working (allDay
// returns `date` as-is; a floating start returns its wall-clock date
// as-is -- neither goes through a `new Date(...)` + local-getter round
// trip), so they run as plain `test`s regardless of `tzPinningWorks`. The
// TZ is still set for realism/documentation of the scenario being covered.

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

// ---- parseDailyForecast -------------------------------------------------
// Covers the weather widget's forecast-strip parsing/validation logic: a
// well-formed 7-day response, "Today" being date-based rather than
// positional (a review-round fix -- a tab left open past midnight must never
// keep calling a now-stale first entry "Today"), truncating at the first bad
// day rather than discarding the whole response, and the structural
// malformed-input cases (mismatched array lengths, a missing/non-object
// `daily`, an empty `time` array).
//
// `parseDailyForecast` compares its first entry's date against the actual
// current date (`new Date()` inside the function), so these fixtures are
// built from today's REAL date rather than a hardcoded string -- a
// hardcoded date would make "Today" only assert correctly on the one day it
// was written on. `dayAbbrevFor` is a small independent reimplementation of
// the same Mon-first Date#getDay() conversion the module uses, so it's
// cross-checking the production logic rather than just mirroring it.

var DAY_NAMES_MON_FIRST = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayAbbrevFor(date) {
  return DAY_NAMES_MON_FIRST[(date.getDay() + 6) % 7];
}

function addDays(date, n) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function makeWellFormedDaily(startDate) {
  var dates = [];
  for (var i = 0; i < 7; i++) dates.push(gw.localDateStr(addDays(startDate, i)));
  return {
    time: dates,
    weather_code: [0, 1, 2, 3, 61, 71, 95],
    temperature_2m_max: [18, 19, 17, 16, 15, 5, 20],
    temperature_2m_min: [9, 10, 8, 7, 6, -2, 12]
  };
}

test("parseDailyForecast: a well-formed 7-day response starting today parses to 7 day objects, today first", function () {
  var today = new Date();
  var days = gw.parseDailyForecast(makeWellFormedDaily(today));
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[0].date, gw.localDateStr(today));
  assert.strictEqual(days[0].dayLabel, "Today");
  assert.strictEqual(days[0].tempMax, 18);
  assert.strictEqual(days[0].tempMin, 9);
  assert.strictEqual(days[0].code, 0);
  // Later days fall back to their weekday abbreviation -- checked against
  // dayAbbrevFor's independent reimplementation, not a hardcoded literal,
  // since which weekday "tomorrow" is depends on when this test runs.
  assert.strictEqual(days[1].dayLabel, dayAbbrevFor(addDays(today, 1)));
  assert.strictEqual(days[6].dayLabel, dayAbbrevFor(addDays(today, 6)));
  assert.strictEqual(days[6].date, gw.localDateStr(addDays(today, 6)));
});

test("parseDailyForecast: \"Today\" is based on the entry's own date, not array position", function () {
  // Day 0 is YESTERDAY here (as if the tab fetched this a day ago and never
  // refreshed) -- this is exactly the bug the date-comparison fix targets:
  // without it, index 0 would always be labelled "Today" regardless of
  // whether it actually still is.
  var yesterday = addDays(new Date(), -1);
  var days = gw.parseDailyForecast(makeWellFormedDaily(yesterday));
  assert.strictEqual(days[0].dayLabel, dayAbbrevFor(yesterday));
  assert.notStrictEqual(days[0].dayLabel, "Today");
  // None of the other six entries should claim to be "Today" either.
  for (var i = 1; i < days.length; i++) {
    assert.notStrictEqual(days[i].dayLabel, "Today");
  }
});

test("parseDailyForecast: mismatched array lengths return null rather than a partial/corrupt result", function () {
  var daily = makeWellFormedDaily(new Date());
  daily.temperature_2m_min = [9, 10, 8]; // shorter than the other three arrays
  assert.strictEqual(gw.parseDailyForecast(daily), null);
});

test("parseDailyForecast: a missing or non-object `daily` returns null rather than throwing", function () {
  assert.strictEqual(gw.parseDailyForecast(undefined), null);
  assert.strictEqual(gw.parseDailyForecast(null), null);
  assert.strictEqual(gw.parseDailyForecast("nope"), null);
  assert.strictEqual(gw.parseDailyForecast(42), null);
  assert.strictEqual(gw.parseDailyForecast([1, 2, 3]), null);
});

test("parseDailyForecast: a non-finite value buried mid-array truncates the strip there rather than discarding every day", function () {
  var daily = makeWellFormedDaily(new Date());
  daily.temperature_2m_max[3] = NaN; // index 3 is bad -- days 0,1,2 are still good
  var days = gw.parseDailyForecast(daily);
  assert.strictEqual(days.length, 3);
  assert.strictEqual(days[0].dayLabel, "Today");

  var daily2 = makeWellFormedDaily(new Date());
  daily2.weather_code[5] = null;
  assert.strictEqual(gw.parseDailyForecast(daily2).length, 5);
});

test("parseDailyForecast: a bad value at index 0 leaves nothing to salvage, so the whole result is null", function () {
  var daily = makeWellFormedDaily(new Date());
  daily.temperature_2m_max[0] = NaN;
  assert.strictEqual(gw.parseDailyForecast(daily), null);
});

test("parseDailyForecast: an out-of-range date (e.g. Feb 30) truncates rather than silently rolling into the next month", function () {
  var daily = makeWellFormedDaily(new Date());
  daily.time[2] = "2026-02-30"; // JS `Date` would otherwise roll this into March 2
  var days = gw.parseDailyForecast(daily);
  assert.strictEqual(days.length, 2);
});

test("parseDailyForecast: an empty `time` array returns null rather than an empty (falsy-looking but valid) result", function () {
  var daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] };
  assert.strictEqual(gw.parseDailyForecast(daily), null);
});

test("parseDailyForecast: more than 7 days in the response is capped at 7, matching the CSS's fixed cell-count layout", function () {
  var today = new Date();
  var daily = makeWellFormedDaily(today);
  var extraDate = gw.localDateStr(addDays(today, 7));
  daily.time.push(extraDate);
  daily.weather_code.push(0);
  daily.temperature_2m_max.push(20);
  daily.temperature_2m_min.push(10);
  var days = gw.parseDailyForecast(daily);
  assert.strictEqual(days.length, 7);
});

// Restore whatever TZ the process actually started with, so this file
// doesn't leak a changed timezone into any test run after it.
process.env.TZ = originalTZ;

console.log(passed + " passed");
