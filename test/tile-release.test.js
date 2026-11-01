// Coverage for tile-release.js (the Overview's Release board tile): what it says with the board off, without a token, before the first
// read, when everything is green and when something is red, failing a deploy or behind; and that it reads only GET /release/status
// (the Worker's stored snapshot, never GitHub) and builds its text with textContent. The drawing was checked in a browser.
//
//   node test/tile-release.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var T = require(path.join(root, "tile-release.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.parse("2026-11-01T06:00:00Z"), MIN = 60000, HOUR = 3600000;
function repo(name, over) {
  return Object.assign({ name: name, label: name + " label", kind: "pages", red: false, redSince: null, failing: [], deploy: { state: "pass", short: "aaaaaaa", at: NOW - HOUR, ahead: false }, pullsFailing: 0, openPulls: 0 }, over || {});
}
function status(repos, over) {
  return Object.assign({ ok: true, enabled: true, configured: true, checkedAt: NOW - 5 * MIN, stale: false, repos: repos, redRepos: [], failedDeploys: [], aheadRepos: [], pullsFailing: 0, openPulls: 0, errors: [] }, over || {});
}

test("off, not set up and waiting are said plainly and show no rows", function () {
  assert.deepStrictEqual([T.model(null, NOW).state, T.model({ enabled: false }, NOW).state], ["off", "off"]);
  var unset = T.model({ enabled: true, configured: false }, NOW);
  assert.strictEqual(unset.state, "unset");
  assert.ok(/GITHUB_READ_TOKEN/.test(unset.text));
  var waiting = T.model(status([], { checkedAt: null }), NOW);
  assert.strictEqual(waiting.state, "waiting");
  assert.deepStrictEqual([unset.rows.length, waiting.rows.length], [0, 0]);
});

test("everything green says so, counts open pull requests and says when it was checked", function () {
  var m = T.model(status([repo("a"), repo("b")], { openPulls: 3 }), NOW);
  assert.deepStrictEqual([m.state, m.tone, m.rows.length], ["ok", "ok", 0]);
  assert.strictEqual(m.text, "Everything is green. 3 pull requests open.");
  assert.strictEqual(m.checked, "Checked 5 min ago");
  assert.strictEqual(T.model(status([repo("a")], { openPulls: 1 }), NOW).text, "Everything is green. 1 pull request open.");
});

test("a red main or a failed deploy is an alert, worst first, with the failing workflows named", function () {
  var m = T.model(status([
    repo("amber", { deploy: { state: "pass", short: "bbbbbbb", at: NOW, ahead: true } }),
    repo("deploy", { deploy: { state: "fail", short: "ccccccc", at: NOW } }),
    repo("red", { red: true, failing: ["Tests", "Lint"] }),
  ]), NOW);
  assert.deepStrictEqual([m.state, m.tone], ["alert", "alert"]);
  assert.deepStrictEqual(m.rows.map(function (r) { return r.name; }), ["red", "deploy", "amber"]);
  assert.strictEqual(m.rows[0].line, "main is red (Tests, Lint)");
  assert.strictEqual(m.rows[1].line, "the last deploy failed");
  assert.deepStrictEqual(m.rows.map(function (r) { return r.tone; }), ["alert", "alert", "attn"]);
  assert.strictEqual(m.text, "2 repositories red or failing a deploy.");
});

test("behind main, failing pull requests and unreadable repositories are amber, not red", function () {
  var m = T.model(status([repo("a", { pullsFailing: 2 }), repo("b", { deploy: { state: "pass", short: "x", at: NOW, ahead: true } })]), NOW);
  assert.deepStrictEqual([m.state, m.rows.length], ["attn", 2]);
  assert.strictEqual(m.rows.find(function (r) { return r.name === "a"; }).line, "2 pull requests with failing checks");
  assert.strictEqual(m.text, "2 repositories to look at.");
  var e = T.model(status([repo("a")], { errors: ["study-hub"] }), NOW);
  assert.deepStrictEqual([e.state, e.text], ["attn", "Could not read study-hub."]);
});

test("a stale snapshot says the Worker has not read GitHub since, and at most five rows are shown", function () {
  var many = []; for (var i = 0; i < 8; i++) many.push(repo("r" + i, { red: true }));
  var m = T.model(status(many, { stale: true, checkedAt: NOW - 5 * HOUR }), NOW);
  assert.strictEqual(m.rows.length, 5);
  assert.ok(/Checked 5 h ago \(the Worker has not read GitHub since/.test(m.checked));
});

test("the tile is described for the Overview board: owner only, tile.release, sizes in order", function () {
  var d = T.descriptor;
  assert.strictEqual(d.id, "release");
  assert.strictEqual(d.permission, "tile.release");
  assert.strictEqual(d.ownerOnly, true);
  assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH && d.maxW <= 12);
});

test("the tile reads only GET /release/status, links to the Release board tab and builds text only", function () {
  var src = fs.readFileSync(path.join(root, "tile-release.js"), "utf8");
  var code = src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n");
  var paths = (code.match(/"\/[a-z][^"]*"/g) || []).map(function (p) { return p.replace(/"/g, ""); }).filter(function (p) { return /^\/(release|hub|reg)/.test(p); });
  assert.deepStrictEqual(paths, ["/release/status"]);
  assert.ok(/K\.call\("GET", "\/release\/status"\)/.test(code));
  assert.ok(code.indexOf('"monitoring.html#release"') !== -1);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(code), "text only");
});

test("the Overview page loads the tile script after the shared tile kit", function () {
  var index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/src="tile-release\.js(\?v=[0-9a-f]+)?"/.test(index));
  assert.ok(index.indexOf("tile-kit.js") < index.indexOf("tile-release.js"));
});

console.log("\n" + passed + " passed");
