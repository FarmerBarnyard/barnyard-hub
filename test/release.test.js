// Coverage for the Release board's pure wording (release-logic.js) and for the page and menu entry around it: the headline and the
// repository card text, red repositories first, the plain-words errors, the page's security rules (no innerHTML, only github.com links,
// the logic file loads first) and the owner-only menu entry.
//
//   node test/release.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var R = require(path.join(root, "release-logic.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var NOW = Date.parse("2026-10-30T06:00:00Z");
var MIN = 60000, HOUR = 3600000, DAY = 86400000;

function row(over) {
  return Object.assign({
    name: "study-hub", label: "Study and Knowledgebase", kind: "pages", site: "study.barnyard.site", url: "https://github.com/FarmerBarnyard/study-hub",
    main: { sha: "b".repeat(40), short: "bbbbbbb", message: "Merge pull request #43", at: NOW - 2 * HOUR },
    ci: { state: "pass", red: false, since: null, failing: [], workflows: [] },
    deploy: { name: "GitHub Pages", state: "pass", at: NOW - 100 * MIN, short: "bbbbbbb", matchesMain: true, ahead: false, url: "https://github.com/FarmerBarnyard/study-hub/deployments" },
    pulls: [], failingJobs: [], attention: [], red: false
  }, over || {});
}

test("times are said in words: just now, minutes, hours, days, never", function () {
  assert.strictEqual(R.agoText(NOW - 20000, NOW), "just now");
  assert.strictEqual(R.agoText(NOW - 5 * MIN, NOW), "5 min ago");
  assert.strictEqual(R.agoText(NOW - 3 * HOUR, NOW), "3 h ago");
  assert.strictEqual(R.agoText(NOW - DAY, NOW), "1 day ago");
  assert.strictEqual(R.agoText(NOW - 4 * DAY, NOW), "4 days ago");
  assert.strictEqual(R.agoText(null, NOW), "never");
});

test("the clock text is in Perth time", function () {
  assert.strictEqual(R.clockText(Date.parse("2026-10-30T06:00:00Z")), "Fri 30 Oct 14:00");
});

test("check states have a word and a tone, and an unknown state reads as 'No checks'", function () {
  assert.deepStrictEqual([R.stateOf("pass").word, R.stateOf("pass").tone], ["Passing", "ok"]);
  assert.deepStrictEqual([R.stateOf("fail").word, R.stateOf("fail").tone], ["Failing", "alert"]);
  assert.strictEqual(R.stateOf("running").tone, "attn");
  assert.strictEqual(R.stateOf("whatever").word, "No checks");
  assert.strictEqual(R.deployWord("fail"), "Deploy failed");
  assert.strictEqual(R.deployWord("none"), "No deploy found");
});

test("the headline is loud and red when main is red, names the repositories, and says all green only when it is", function () {
  var red = R.headlineModel({ headline: { anyRed: true, redRepos: ["ClaudeRepo"], failedDeploys: [], aheadRepos: [], errors: [], openPulls: 2, ok: false } }, NOW);
  assert.deepStrictEqual([red.tone, red.title], ["alert", "Main is red"]);
  assert.deepStrictEqual(red.lines, ["Main is red in ClaudeRepo."]);
  var deploy = R.headlineModel({ headline: { redRepos: [], failedDeploys: ["study-hub"], aheadRepos: [], errors: [], openPulls: 0 } }, NOW);
  assert.deepStrictEqual([deploy.tone, deploy.title], ["alert", "A deploy failed"]);
  var ahead = R.headlineModel({ headline: { redRepos: [], failedDeploys: [], aheadRepos: ["barnyard-hub"], errors: ["campaign-hub"], openPulls: 0 } }, NOW);
  assert.strictEqual(ahead.tone, "attn");
  assert.deepStrictEqual(ahead.lines, ["Main is ahead of what is live in barnyard-hub.", "Could not read campaign-hub."]);
  var ok = R.headlineModel({ headline: { redRepos: [], failedDeploys: [], aheadRepos: [], errors: [], openPulls: 1 } }, NOW);
  assert.deepStrictEqual([ok.tone, ok.title, ok.lines], ["ok", "Everything is green", ["1 pull request is open."]]);
  assert.deepStrictEqual(R.headlineModel({}, NOW).lines, []);
});

test("a red repository's card says since when, shows the failing job and step, and is tinted as an alert", function () {
  var m = R.repoModel(row({
    name: "ClaudeRepo", kind: "worker",
    ci: { state: "fail", red: true, since: NOW - 20 * MIN, failing: [{ workflow: "Tests" }], workflows: [] },
    failingJobs: [{ workflow: "Tests", job: "worker", step: "Run worker tests", url: "https://github.com/FarmerBarnyard/ClaudeRepo/actions/runs/1/job/2" }],
    attention: ["main is red"],
  }), null, NOW);
  assert.strictEqual(m.tone, "alert");
  assert.ok(/^Red since .* \(20 min ago\)$/.test(m.redLine), m.redLine);
  assert.deepStrictEqual(m.failing, [{ text: "Tests: worker, step Run worker tests", url: "https://github.com/FarmerBarnyard/ClaudeRepo/actions/runs/1/job/2" }]);
  assert.deepStrictEqual(m.chips[0], { label: "Main", word: "Failing", tone: "alert" });
  assert.strictEqual(m.main, "Merge pull request #43 (bbbbbbb, 2 h ago)");
});

test("a healthy repository is green, says what is live and that it is the same as main", function () {
  var m = R.repoModel(row(), null, NOW);
  assert.strictEqual(m.tone, "ok");
  assert.deepStrictEqual(m.chips.map(function (c) { return [c.label, c.word, c.tone]; }), [["Main", "Passing", "ok"], ["Live", "Deployed", "ok"]]);
  assert.strictEqual(m.deploy, "GitHub Pages: deployed 2 h ago, commit bbbbbbb, the same as main");
});

test("a deploy behind main is called out, and a failed deploy is an alert", function () {
  var behind = R.repoModel(row({ deploy: { name: "GitHub Pages", state: "pass", at: NOW - 3 * HOUR, short: "aaaaaaa", matchesMain: false, ahead: true } }), null, NOW);
  assert.strictEqual(behind.tone, "attn");
  assert.ok(behind.chips.some(function (c) { return c.word === "Behind main"; }));
  assert.ok(/but main is ahead$/.test(behind.deploy));
  var pending = R.repoModel(row({ deploy: { name: "GitHub Pages", state: "pass", at: NOW - 3 * MIN, short: "aaaaaaa", matchesMain: false, ahead: false } }), null, NOW);
  assert.ok(/main has a newer commit$/.test(pending.deploy));
  assert.strictEqual(pending.tone, "ok", "inside the grace period it is not a worry");
  var failed = R.repoModel(row({ deploy: { name: "GitHub Pages", state: "fail", at: NOW - 3 * MIN, short: "bbbbbbb", matchesMain: true, ahead: false } }), null, NOW);
  assert.strictEqual(failed.tone, "alert");
  assert.strictEqual(R.repoModel(row({ deploy: { state: "none" } }), null, NOW).deploy, "No deploy found yet.");
});

test("pull requests: age in days, a stale one is marked, drafts carry no tone, failing checks are an alert", function () {
  var m = R.repoModel(row({ pulls: [
    { number: 1, title: "A", author: "FarmerBarnyard", draft: false, url: "https://github.com/FarmerBarnyard/study-hub/pull/1", branch: "a", ageDays: 0, ci: "pass", checks: [] },
    { number: 2, title: "B", author: "FarmerBarnyard", draft: true, url: "", branch: "b", ageDays: 9, ci: "fail", checks: [] },
    { number: 3, title: "C", author: "x", draft: false, url: "", branch: "c", ageDays: 1, ci: "fail", checks: [] },
  ] }), null, NOW);
  assert.deepStrictEqual(m.pulls.map(function (p) { return [p.number, p.age, p.checks, p.tone, p.stale]; }), [[1, "today", "Passing", "ok", false], [2, "9 days", "Failing", "", true], [3, "1 day", "Failing", "alert", false]]);
  assert.strictEqual(m.tone, "attn", "a pull request stuck on failing checks makes the card amber");
});

test("a repository GitHub could not read shows the reason and no other detail", function () {
  var m = R.repoModel({ name: "study-hub", label: "Study", error: { code: "repo_not_visible", message: "The token cannot see this repository." } }, null, NOW);
  assert.strictEqual(m.error, "The token cannot see this repository.");
  assert.strictEqual(m.tone, "attn");
  assert.deepStrictEqual(m.pulls, []);
});

test("red repositories and failed deploys sort first, unreadable ones next, then the Worker's order", function () {
  var rows = [row({ name: "a" }), row({ name: "b", ci: { state: "fail", red: true } }), { name: "c", error: { message: "x" } }, row({ name: "d", deploy: { state: "fail" } }), row({ name: "e" })];
  assert.deepStrictEqual(R.orderRows(rows).map(function (r) { return r.name; }), ["b", "d", "c", "a", "e"]);
});

test("the notes keep the starting text until the owner writes one, and say when theirs was saved", function () {
  var m = R.repoModel(row(), { text: "Revert it.", custom: true, at: NOW - 2 * HOUR }, NOW);
  assert.deepStrictEqual([m.note.text, m.note.custom], ["Revert it.", true]);
  assert.strictEqual(R.repoModel(row(), undefined, NOW).note.text, "");
});

test("errors are in plain words and never repeat a secret", function () {
  assert.strictEqual(R.errorText({}, 401), "Sign in to see the Release board.");
  assert.ok(/recent sign-in/.test(R.errorText({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/only for the hub owner/.test(R.errorText({ error: "forbidden" }, 403)));
  assert.ok(/30 seconds/.test(R.errorText({ error: "rate_limited", retryMs: 30000 }, 429)));
  assert.ok(/29 seconds/.test(R.errorText({ error: "rate_limited", retryMs: 28500 }, 429)), "the wait is rounded up");
  assert.ok(/password or key/.test(R.errorText({ error: "secret_detected" }, 422)));
  assert.ok(/1200/.test(R.errorText({ error: "text_too_long" }, 400)));
  assert.ok(/Could not reach/.test(R.errorText({}, 0)));
});

test("release.html is in the shell: container, wide, a title row without a blurb, strict CSP, the logic loaded before the page", function () {
  var html = fs.readFileSync(path.join(root, "release.html"), "utf8");
  assert.ok(/<main id="page" class="content"/.test(html));
  assert.ok(/<body[^>]*data-shell="release"[^>]*\bdata-wide\b/.test(html));
  assert.ok(/<div class="page-head">\s*<div>\s*<h1>Release board<\/h1>\s*<\/div>/.test(html), "the title is followed by the tools, not a paragraph");
  assert.ok(/Content-Security-Policy" content="default-src 'self'; connect-src 'self' https:\/\/api\.barnyard\.site;/.test(html));
  assert.ok(!/unsafe-inline/.test(html));
  assert.ok(html.indexOf("release-logic.js") !== -1 && html.indexOf("release-logic.js") < html.indexOf("release.js"));
  assert.ok(html.indexOf("shell.js") < html.indexOf("release-logic.js"));
});

test("release.js builds the page with textContent only, links only to github.com, and talks only to the Release routes", function () {
  var src = fs.readFileSync(path.join(root, "release.js"), "utf8");
  var c = code(src);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(c), "no HTML is built from text");
  assert.ok(/indexOf\("https:\/\/github\.com\/"\) !== 0/.test(c), "a link is only set to a github.com address");
  assert.ok(!/\.style\b|setAttribute\("style"/.test(c), "no inline styles (the CSP forbids them)");
  var paths = (c.match(/API \+ "[^"]+"/g) || []).map(function (s) { return s.replace(/^API \+ "/, "").replace(/"$/, ""); });
  paths.forEach(function (p) { assert.ok(/^\/release\/(summary|notes)/.test(p), "unexpected path " + p); });
  assert.ok(/credentials: "include"/.test(c));
});

test("the stylesheet fits the shared container: no fixed-width page root", function () {
  var css = fs.readFileSync(path.join(root, "release.css"), "utf8");
  assert.ok(!/#rel-root\s*\{[^}]*\bwidth\s*:\s*\d/.test(css));
  assert.ok(!/\bmain\s*\{[^}]*max-width/.test(css));
});

test("the menu has a Release board entry in the Work group: owner only, its own permission, icon and palette words", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var line = shell.split("\n").filter(function (l) { return /id: "release"/.test(l); })[0] || "";
  assert.ok(/title: "Release board"/.test(line));
  assert.ok(/group: "Work"/.test(line));
  assert.ok(/path: "release\.html"/.test(line) && /local: "release\.html"/.test(line));
  assert.ok(/ownerOnly: true/.test(line), "owner only");
  assert.ok(/perm: "release\.view"/.test(line));
  assert.ok(/icon: "branch"/.test(line) && /branch: '<circle/.test(shell), "its own icon is defined");
  assert.ok(/keywords: "[^"]*rollback[^"]*"/.test(line));
  assert.ok(/release\\\.html\$\/\.test\(location\.pathname\)\) return "release"/.test(shell), "the page lights its own menu entry");
});

console.log("\n" + passed + " passed");
