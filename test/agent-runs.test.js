// Coverage for the pure helpers in agent-runs.js: the chip wording, the message after an
// approval, which buttons the drawer offers, and the plain-language lines.
//
//   node test/agent-runs.test.js

var assert = require("assert");
var path = require("path");
var R = require(path.join(__dirname, "..", "agent-runs.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
function run(over) { return Object.assign({ id: "rn_aaaaaaaa", itemId: "it_aaaaaaaa", status: "queued", mode: "pull", url: "", attempts: 0, approvedAt: NOW - 120000, updatedAt: NOW - 60000 }, over); }
function item(over) { return Object.assign({ id: "it_aaaaaaaa", title: "T", lane: "backlog", proposal: false, run: null }, over); }
var ON = { available: true, enabled: true, mode: "pull", tokenSet: false, runsToday: 0, cap: 10 };

test("the chip says what state the run is in, and nothing when there is no run", function () {
  assert.strictEqual(R.runChip(null), null);
  assert.deepStrictEqual(R.runChip(run({ mode: "pull" })), { text: "Waiting for your agent", tone: "warn" });
  assert.deepStrictEqual(R.runChip(run({ mode: "push" })), { text: "Run queued", tone: "warn" });
  assert.deepStrictEqual(R.runChip(run({ mode: "push", attempts: 1 })), { text: "Couldn’t start", tone: "bad" });
  assert.deepStrictEqual(R.runChip(run({ status: "fired" })), { text: "Agent starting", tone: "warn" });
  assert.deepStrictEqual(R.runChip(run({ status: "running" })), { text: "Agent working", tone: "warn" });
  assert.deepStrictEqual(R.runChip(run({ status: "done" })), { text: "Agent finished", tone: "ok" });
  assert.deepStrictEqual(R.runChip(run({ status: "failed" })), { text: "Agent failed", tone: "bad" });
  assert.deepStrictEqual(R.runChip(run({ status: "stale" })), { text: "Changed since approved", tone: "bad" });
  assert.strictEqual(R.runChip(run({ status: "weird" })), null);
});

test("after an approval the message says whether an agent started and, if not, why", function () {
  assert.strictEqual(R.approveMessage(false, {}), "Rejected. Nothing will run.");
  assert.strictEqual(R.approveMessage(true, { run: run({ status: "fired" }) }), "Approved. Your agent is starting.");
  assert.strictEqual(R.approveMessage(true, { run: run({ status: "queued" }) }), "Approved. Waiting for your agent to pick it up.");
  assert.match(R.approveMessage(true, { run: run({ status: "queued", mode: "push", attempts: 1 }) }), /couldn’t be started/);
  assert.match(R.approveMessage(true, { run: null, runError: "dispatch_off" }), /aren’t switched on/);
  assert.match(R.approveMessage(true, { run: null, runError: "daily_cap" }), /limit is used up/);
  assert.strictEqual(R.approveMessage(true, { run: null, runError: null }), "Approved.");
  assert.strictEqual(R.approveMessage(true, null), "Approved.");
});

test("a run can be started for an approved, unfinished item with nothing already running, when runs are on", function () {
  assert.strictEqual(R.canRun(item(), ON), true);
  assert.strictEqual(R.canRun(item({ proposal: true }), ON), false, "a proposal is approved first");
  assert.strictEqual(R.canRun(item({ lane: "done" }), ON), false);
  assert.strictEqual(R.canRun(item({ run: run({ status: "running" }) }), ON), false);
  assert.strictEqual(R.canRun(item({ run: run({ status: "done" }) }), ON), true);
  assert.strictEqual(R.canRun(item(), Object.assign({}, ON, { enabled: false })), false);
  assert.strictEqual(R.canRun(item(), Object.assign({}, ON, { available: false })), false);
  assert.strictEqual(R.canRun(item(), null), false);
});

test("the drawer offers the right buttons for each state", function () {
  var labels = function (it, cfg) { return R.runActions(it, cfg === undefined ? ON : cfg).map(function (a) { return a.id + ":" + a.label; }); };
  assert.deepStrictEqual(labels(item()), ["run:Start an agent run"]);
  assert.deepStrictEqual(labels(item({ run: run({ status: "done" }) })), ["run:Run again"]);
  assert.deepStrictEqual(labels(item({ run: run({ status: "stale" }) })), ["run:Run again with the current text"]);
  assert.deepStrictEqual(labels(item({ run: run({ status: "running" }) })), []);
  assert.deepStrictEqual(labels(item({ run: run({ status: "queued", mode: "push", attempts: 1 }) })), ["fire:Try starting it again"]);
  assert.deepStrictEqual(labels(item({ run: run({ status: "queued", mode: "push", attempts: 3 }) })), [], "no more tries after three");
  assert.deepStrictEqual(labels(item({ run: run({ status: "queued", mode: "pull" }) })), []);
  assert.deepStrictEqual(labels(item({ proposal: true })), []);
  assert.deepStrictEqual(labels(item(), null), []);
});

test("the plain lines say what happened and when", function () {
  assert.strictEqual(R.ago(NOW - 10000, NOW), "just now");
  assert.strictEqual(R.ago(NOW - 5 * 60000, NOW), "5 minutes ago");
  assert.strictEqual(R.ago(NOW - 60 * 60000, NOW), "1 hour ago");
  assert.strictEqual(R.ago(NOW - 3 * 86400000, NOW), "3 days ago");
  assert.match(R.runLine(run({ status: "fired" }), NOW), /routine was started 1 minute ago/);
  assert.match(R.runLine(run({ status: "done" }), NOW), /finished/);
  assert.match(R.runLine(run({ status: "stale" }), NOW), /text changed after you approved/);
  assert.match(R.runLine(run({ mode: "pull" }), NOW), /pick it up from the approved list/);
  assert.strictEqual(R.runLine(null, NOW), "");
});

test("settings errors are plain and never echo server text", function () {
  assert.match(R.dispatchError({ code: "url_invalid" }), /isn’t a routine address/);
  assert.match(R.dispatchError({ code: "token_invalid" }), /routine token/);
  assert.match(R.dispatchError({ code: "recent_sign_in_required" }), /recent sign-in/);
  assert.match(R.dispatchError({ status: 0 }), /reach the server/);
  assert.strictEqual(R.dispatchError({ code: "<script>" }, "Fallback."), "Fallback.");
});

console.log("\n" + passed + " passed");
