// Coverage for the pure helpers in ops-pending.js: the wording of a change's state, the groups the
// tab shows, the diff parser (a diff is somebody's code: it is parsed into tagged lines, never
// markup), and the plain-language errors.
//
//   node test/ops-pending.test.js

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var P = require(path.join(__dirname, "..", "ops-pending.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function change(over) { return Object.assign({ id: "pc_aaaaaaaa", repo: "study-hub", title: "Make a two", state: "pending", files: ["a.js"], risky: [], hash: "a".repeat(64), createdAt: 0 }, over); }

test("each state has plain words and a tone", function () {
  assert.deepStrictEqual(P.stateChip(change({ state: "pending" })), { text: "Waiting for you", tone: "warn" });
  assert.deepStrictEqual(P.stateChip(change({ state: "approved" })), { text: "Approved: waiting for your desktop Claude", tone: "warn" });
  assert.deepStrictEqual(P.stateChip(change({ state: "applied" })), { text: "Applied: pull request opened", tone: "ok" });
  assert.deepStrictEqual(P.stateChip(change({ state: "failed" })), { text: "Couldn’t be applied", tone: "bad" });
  assert.deepStrictEqual(P.stateChip(change({ state: "rejected" })), { text: "Rejected", tone: "" });
  assert.deepStrictEqual(P.stateChip(change({ state: "superseded" })), { text: "Replaced by a newer change", tone: "" });
  assert.strictEqual(P.stateChip(change({ state: "odd" })).text, "odd");
});

test("changes are grouped as waiting, approved and earlier, and only the waiting ones are counted", function () {
  var list = [change({ id: "pc_1" }), change({ id: "pc_2", state: "approved" }), change({ id: "pc_3", state: "applied" }), change({ id: "pc_4", state: "rejected" }), change({ id: "pc_5" })];
  var g = P.groupChanges(list);
  assert.deepStrictEqual(g.waiting.map(function (c) { return c.id; }), ["pc_1", "pc_5"]);
  assert.deepStrictEqual(g.approved.map(function (c) { return c.id; }), ["pc_2"]);
  assert.deepStrictEqual(g.done.map(function (c) { return c.id; }), ["pc_3", "pc_4"]);
  assert.strictEqual(P.waitingCount(list), 2);
  assert.strictEqual(P.waitingCount(null), 0);
});

test("the file line and the risky warning read naturally", function () {
  assert.strictEqual(P.fileLine(change({ files: ["a.js"] })), "1 file in study-hub");
  assert.strictEqual(P.fileLine(change({ files: ["a.js", "b.js"], repo: "ClaudeRepo" })), "2 files in ClaudeRepo");
  assert.strictEqual(P.riskyLine(change()), "");
  assert.match(P.riskyLine(change({ risky: [".github/workflows/ci.yml"] })), /touches \.github\/workflows\/ci\.yml, which can make code run later/);
  assert.match(P.riskyLine(change({ risky: ["a", "b", "c", "d", "e"] })), /a, b, c and 2 more/);
});

var DIFF = [
  "diff --git a/src/a.js b/src/a.js",
  "index 1111111..2222222 100644",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-const a = 1;",
  "+const a = \"<img src=x onerror=alert(1)>\";",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  ""
].join("\n");

test("a diff becomes files with tagged lines and counts", function () {
  var d = P.parseDiff(DIFF);
  assert.strictEqual(d.hidden, 0);
  assert.deepStrictEqual(d.files.map(function (f) { return [f.file, f.adds, f.dels]; }), [["src/a.js", 1, 1], ["new.txt", 1, 0]]);
  assert.deepStrictEqual(d.files[0].lines.map(function (l) { return l.kind; }), ["meta", "meta", "meta", "hunk", "ctx", "del", "add"]);
  assert.strictEqual(d.files[0].lines[6].text, "+const a = \"<img src=x onerror=alert(1)>\";", "the text is kept as it is, to be shown as text");
  assert.strictEqual(d.files[1].lines[0].kind, "meta");
  assert.deepStrictEqual(P.parseDiff("").files, []);
  assert.deepStrictEqual(P.parseDiff(null).files, []);
});

test("a very long diff is cut and says how much was left out", function () {
  var lines = ["diff --git a/big.txt b/big.txt", "@@ -0,0 +1 @@"];
  for (var i = 0; i < P.MAX_DIFF_LINES + 40; i++) lines.push("+line " + i);
  var d = P.parseDiff(lines.join("\n") + "\n");
  assert.strictEqual(d.files[0].lines.length, P.MAX_DIFF_LINES);
  assert.strictEqual(d.hidden, 41, "the hunk line and 1,540 added lines, less the 1,500 kept");
});

test("errors are plain and never echo server text", function () {
  assert.match(P.pendingError({ code: "recent_sign_in_required" }), /recent sign-in/);
  assert.match(P.pendingError({ code: "changed" }), /replaced/);
  assert.match(P.pendingError({ code: "not_pending" }), /already been decided/);
  assert.match(P.pendingError({ status: 401 }), /expired/);
  assert.match(P.pendingError({ status: 403 }), /Only the owner/);
  assert.strictEqual(P.pendingError({ code: "<script>" }), "That didn’t work. Try again.");
  assert.match(P.decidedMessage("approve"), /desktop Claude will apply it/);
  assert.match(P.decidedMessage("reject"), /Nothing will be applied/);
});

test("times read naturally", function () {
  var now = Date.UTC(2026, 9, 24, 12, 0, 0);
  assert.strictEqual(P.ago(now - 5000, now), "just now");
  assert.strictEqual(P.ago(now - 10 * 60000, now), "10 min ago");
  assert.strictEqual(P.ago(now - 3 * 3600000, now), "3 h ago");
  assert.strictEqual(P.ago(now - 30 * 3600000, now), "yesterday");
  assert.strictEqual(P.ago(now - 5 * 86400000, now), "5 days ago");
});

test("the page loads the script before ops.js, and ops.js stays free of innerHTML", function () {
  var html = fs.readFileSync(path.join(__dirname, "..", "ops.html"), "utf8");
  assert.ok(html.indexOf("ops-pending.js") > -1 && html.indexOf("ops-pending.js") < html.indexOf("ops.js?"));
  assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(__dirname, "..", "ops-pending.js"), "utf8").replace(/\/\/.*$/gm, "")), "a diff is somebody's code: only textContent");
});

console.log("\n" + passed + " passed");
