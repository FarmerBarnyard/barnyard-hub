// Basic unit coverage for live-prices.js's pure staleness/validation
// logic -- added 2026-08-19 to close a gap flagged in review: the
// quote-validation and staleness-threshold decision logic had zero test
// coverage. This repo has no build step and no package.json, so this is a
// plain Node script using only the standard library (`assert`) -- run with:
//
//   node test/live-prices.test.js
//
// Deliberately does NOT spin up a DOM/jsdom -- live-prices.js exports its
// pure, DOM-free helpers via a `module.exports` guard (a no-op in the
// browser) specifically so this file can require() it directly. DOM-facing
// functions (applyQuote, applyStaleVisuals, pollAll, markStaleIfDue) are
// out of scope here; they were exercised live in the browser instead (see
// the branch's PR/review notes).

var assert = require("assert");
var path = require("path");
var lp = require(path.join(__dirname, "..", "live-prices.js"));

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// ---- Invariant: FETCH_TIMEOUT_MS must stay below POLL_INTERVAL_MS -------
// See the comment in live-prices.js next to both constants for why: a
// timeout that can't fire before the next poll tick breaks the assumption
// that markStaleIfDue's clock-driven check is racing a fetch that's had a
// real chance to time out.

test("FETCH_TIMEOUT_MS stays below POLL_INTERVAL_MS", function () {
  assert.ok(
    lp.FETCH_TIMEOUT_MS < lp.POLL_INTERVAL_MS,
    "FETCH_TIMEOUT_MS (" + lp.FETCH_TIMEOUT_MS + ") must be less than POLL_INTERVAL_MS (" + lp.POLL_INTERVAL_MS + ")"
  );
});

// ---- isCompleteQuote ------------------------------------------------------

test("isCompleteQuote accepts a fully-populated quote", function () {
  assert.strictEqual(
    lp.isCompleteQuote({ price: 123.45, change: 1.23, changePercent: 0.5 }),
    true
  );
});

test("isCompleteQuote rejects null/undefined", function () {
  assert.strictEqual(lp.isCompleteQuote(null), false);
  assert.strictEqual(lp.isCompleteQuote(undefined), false);
});

test("isCompleteQuote rejects a quote missing a field", function () {
  assert.strictEqual(lp.isCompleteQuote({ price: 1, change: 1 }), false);
});

test("isCompleteQuote rejects NaN/Infinity fields (typeof \"number\" but not finite)", function () {
  assert.strictEqual(
    lp.isCompleteQuote({ price: NaN, change: 1, changePercent: 1 }),
    false
  );
  assert.strictEqual(
    lp.isCompleteQuote({ price: 1, change: Infinity, changePercent: 1 }),
    false
  );
  assert.strictEqual(
    lp.isCompleteQuote({ price: 1, change: 1, changePercent: -Infinity }),
    false
  );
});

test("isCompleteQuote rejects a string masquerading as a numeric field", function () {
  assert.strictEqual(
    lp.isCompleteQuote({ price: "123.45", change: 1, changePercent: 1 }),
    false
  );
});

// ---- parseAsOf --------------------------------------------------------

test("parseAsOf parses a valid ISO timestamp", function () {
  var t = lp.parseAsOf({ asOf: "2026-08-19T12:00:00.000Z" });
  assert.strictEqual(t, Date.parse("2026-08-19T12:00:00.000Z"));
});

test("parseAsOf returns null when asOf is missing", function () {
  assert.strictEqual(lp.parseAsOf({}), null);
  assert.strictEqual(lp.parseAsOf(null), null);
});

test("parseAsOf returns null when asOf is not a string", function () {
  assert.strictEqual(lp.parseAsOf({ asOf: 1755604800000 }), null);
});

test("parseAsOf returns null for an unparseable date string", function () {
  assert.strictEqual(lp.parseAsOf({ asOf: "not a date" }), null);
});

// ---- isStaleSince -------------------------------------------------------

test("isStaleSince: never-loaded (null/undefined) is immediately stale", function () {
  assert.strictEqual(lp.isStaleSince(null, Date.now()), true);
  assert.strictEqual(lp.isStaleSince(undefined, Date.now()), true);
});

test("isStaleSince: well within the threshold is not stale", function () {
  var now = Date.now();
  assert.strictEqual(lp.isStaleSince(now - 1000, now), false);
});

test("isStaleSince: exactly at the threshold is not stale (strict >, not >=)", function () {
  var now = Date.now();
  assert.strictEqual(lp.isStaleSince(now - lp.STALE_THRESHOLD_MS, now), false);
});

test("isStaleSince: just past the threshold is stale", function () {
  var now = Date.now();
  assert.strictEqual(lp.isStaleSince(now - lp.STALE_THRESHOLD_MS - 1, now), true);
});

// ---- decideQuoteAction --------------------------------------------------
// This is pollAll's actual apply-vs-stale-vs-incomplete routing decision,
// extracted so it's directly testable rather than reachable only by
// exercising isCompleteQuote/parseAsOf/isStaleSince in isolation and
// *assuming* pollAll wires them together correctly. A swapped-argument bug
// or backwards routing inside pollAll would previously have passed this
// suite green; these tests exercise the exact function pollAll now calls,
// so they'd fail if that wiring broke.

test("decideQuoteAction: a complete quote with a too-old asOf routes to \"stale\" with that asOf as the timestamp", function () {
  var now = Date.now();
  var staleAsOf = new Date(now - lp.STALE_THRESHOLD_MS - 60000).toISOString();
  var quote = { price: 100, change: -1, changePercent: -0.5, asOf: staleAsOf };

  var decision = lp.decideQuoteAction(quote, now);
  assert.strictEqual(decision.action, "stale", "an asOf this old must route to stale even though the HTTP round-trip succeeded");
  assert.strictEqual(
    decision.timestamp,
    Date.parse(staleAsOf),
    "the stale decision must carry the quote's own asOf, not \"now\" or some other timestamp"
  );
});

test("decideQuoteAction: a complete quote with a fresh asOf routes to \"apply\"", function () {
  var now = Date.now();
  var freshAsOf = new Date(now - 2000).toISOString();
  var quote = { price: 100, change: 1, changePercent: 0.5, asOf: freshAsOf };

  assert.deepStrictEqual(lp.decideQuoteAction(quote, now), { action: "apply" });
});

test("decideQuoteAction: a complete quote with no asOf at all routes to \"apply\" (nothing to judge staleness against)", function () {
  var now = Date.now();
  var quote = { price: 100, change: 1, changePercent: 0.5 };

  assert.deepStrictEqual(lp.decideQuoteAction(quote, now), { action: "apply" });
});

test("decideQuoteAction: an incomplete quote routes to \"incomplete\" regardless of asOf", function () {
  var now = Date.now();
  var freshAsOf = new Date(now - 2000).toISOString();

  assert.deepStrictEqual(
    lp.decideQuoteAction({ price: NaN, change: 1, changePercent: 1, asOf: freshAsOf }, now),
    { action: "incomplete" }
  );
  assert.deepStrictEqual(lp.decideQuoteAction(null, now), { action: "incomplete" });
});

test("decideQuoteAction: exactly at the stale threshold still routes to \"apply\" (matches isStaleSince's strict >)", function () {
  var now = Date.now();
  var boundaryAsOf = new Date(now - lp.STALE_THRESHOLD_MS).toISOString();
  var quote = { price: 100, change: 1, changePercent: 0.5, asOf: boundaryAsOf };

  assert.deepStrictEqual(lp.decideQuoteAction(quote, now), { action: "apply" });
});

// ---- fmtAsOfLabel ---------------------------------------------------------
// Pins the exact "as of HH:MM" string against a fixed timestamp and an
// explicit "en-US" locale (matching the locale fmtAsOfLabel itself now
// pins internally) so this test's expectation can't drift with whatever
// locale happens to be the test runner's OS/Node default.

test("fmtAsOfLabel: formats a fixed timestamp as \"as of HH:MM\" in en-US", function () {
  var ms = Date.parse("2026-08-19T13:05:00.000Z");
  var expected = "as of " + new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  assert.strictEqual(lp.fmtAsOfLabel(ms), expected);
  // Also assert the literal shape (leading "as of ", no seconds) rather
  // than only comparing against a re-derivation of the same call, so a
  // regression to a different format (e.g. one that includes seconds,
  // or drops the "as of " prefix) would still be caught even if it
  // happened to equal itself.
  assert.ok(/^as of \d{1,2}:\d{2}\s?(AM|PM)$/.test(lp.fmtAsOfLabel(ms)), "expected \"as of H:MM AM/PM\" shape, got: " + lp.fmtAsOfLabel(ms));
});

console.log(passed + " passed");
