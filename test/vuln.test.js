// Coverage for vuln.js's pure helpers (the Vulnerabilities page behind /vuln/*) and for how the page is wired:
// labels and tones, dates, scores, links, the environment tree, the plan the person edits and what is sent back,
// the messages shown for refusals, and the page's safety rules. The DOM and network parts were exercised in a real
// browser against a stand-in for the Worker.
//
//   node test/vuln.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var V = require(path.join(__dirname, "..", "vuln.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

test("states and priorities have plain labels and a tone", function () {
  assert.strictEqual(V.stateText("not_affected"), "Not affected");
  assert.strictEqual(V.stateText("accepted"), "Accepted risk");
  assert.strictEqual(V.stateText("odd"), "odd");
  assert.strictEqual(V.stateTone("approved"), "ok");
  assert.strictEqual(V.stateTone("nonsense"), "");
  assert.deepStrictEqual(["P1", "P2", "P3", "P4"].map(V.priorityTone), ["alert", "accent", "info", ""]);
  assert.strictEqual(V.priorityHint("P1"), "Fix first");
});

test("dates are written the same everywhere, and a bad date is blank", function () {
  assert.strictEqual(V.fmtDate("2026-10-21T14:17:09.357Z"), "21 Oct 2026");
  assert.strictEqual(V.fmtDate(Date.UTC(2026, 0, 5)), "5 Jan 2026");
  assert.strictEqual(V.fmtDate(""), "");
  assert.strictEqual(V.fmtDate(null), "");
  assert.strictEqual(V.fmtDate("not a date"), "");
  assert.strictEqual(V.monthLabel("2026-03"), "Mar 2026");
  assert.strictEqual(V.monthLabel("junk"), "junk");
});

test("ago reads naturally", function () {
  assert.strictEqual(V.agoText(NOW - 20000, NOW), "just now");
  assert.strictEqual(V.agoText(NOW - 5 * 60000, NOW), "5 min ago");
  assert.strictEqual(V.agoText(NOW - 3 * 3600000, NOW), "3 h ago");
  assert.strictEqual(V.agoText(NOW - 86400000, NOW), "1 day ago");
  assert.strictEqual(V.agoText(NOW - 5 * 86400000, NOW), "5 days ago");
  assert.strictEqual(V.agoText("", NOW), "");
});

test("a score reads with its severity, an unscored CVE says so, and EPSS is a percent", function () {
  assert.strictEqual(V.scoreText({ score: 9.8, severity: "CRITICAL" }), "9.8 Critical");
  assert.strictEqual(V.scoreText({ score: 7, severity: null }), "7.0");
  assert.strictEqual(V.scoreText({ score: null }), "No score yet");
  assert.strictEqual(V.scoreText(null), "No score yet");
  assert.deepStrictEqual([9.8, 7.5, 5, 2, null].map(function (s) { return V.scoreTone({ score: s }); }), ["alert", "accent", "info", "", ""]);
  assert.strictEqual(V.epssText(0.2), "EPSS 20%");
  assert.strictEqual(V.epssText(0.004), "EPSS <1%");
  assert.strictEqual(V.epssText(null), "");
  assert.strictEqual(V.confidenceText("confirmed"), "Your version is affected");
  assert.strictEqual(V.confidenceText("possible"), "Might apply, worth checking");
  assert.strictEqual(V.thousands(413119), "413,119");
});

test("only a plain web address from a CVE record becomes a link", function () {
  assert.strictEqual(V.safeUrl("https://example.com/advisory?id=1"), "https://example.com/advisory?id=1");
  assert.strictEqual(V.safeUrl({ url: "http://example.com/x" }), "http://example.com/x");
  ["javascript:alert(1)", "data:text/html,x", "//evil.example", "https://a b.example", "https://x.example/\"onmouseover=1", "", null, undefined, 5, { href: "https://a.example" }].forEach(function (bad) {
    assert.strictEqual(V.safeUrl(bad), "", String(bad));
  });
  assert.strictEqual(V.safeUrl("https://example.com/" + new Array(400).join("a")), "", "an absurdly long address is dropped");
});

test("software is named from its product and version, and a name nobody typed is recognised", function () {
  assert.strictEqual(V.softwareLabel({ product: "PHP", version: "8.3.30" }), "PHP 8.3.30");
  assert.strictEqual(V.softwareLabel({ name: "Caddy", product: "", version: "" }), "Caddy");
  assert.strictEqual(V.softwareLabel(null), "");
  assert.strictEqual(V.autoName("PHP", "8.3.30"), "PHP 8.3.30");
  assert.strictEqual(V.autoName("php", ""), "php");
  assert.strictEqual(V.autoName(new Array(120).join("x"), "1").length, 80);
});

test("a finding's item is named once, whether or not the name already holds the version", function () {
  assert.strictEqual(V.itemLabel("PHP 8.3.30", "8.3.30"), "PHP 8.3.30");
  assert.strictEqual(V.itemLabel("Public PHP", "8.3.30"), "Public PHP 8.3.30");
  assert.strictEqual(V.itemLabel("Windows Server 2025", ""), "Windows Server 2025");
  assert.strictEqual(V.itemLabel("", "1.2"), "1.2");
  assert.strictEqual(V.itemLabel(null, null), "");
});

test("a name that ends with the version is recognised, so changing the version can rename it", function () {
  assert.strictEqual(V.nameBase("PHP 8.3.30", "8.3.30"), "PHP");
  assert.strictEqual(V.nameBase("Public PHP 8.3.30", "8.3.30"), "Public PHP");
  assert.strictEqual(V.nameBase("Public PHP", "8.3.30"), null);
  assert.strictEqual(V.nameBase("8.3.30", "8.3.30"), null, "a name that is only the version has no base");
  assert.strictEqual(V.nameBase("PHP", ""), null);
});

test("how recently an item was checked is stated honestly", function () {
  var sw = function (s, at) { return { kind: "software", matchState: s, matchedAt: at }; };
  assert.strictEqual(V.matchText(sw("ok", NOW - 5 * 60000), NOW), "Checked 5 min ago");
  assert.strictEqual(V.matchText(sw("partial", NOW - 3600000), NOW), "Partly checked 1 h ago");
  assert.strictEqual(V.matchText(sw("error: down", NOW), NOW), "Could not check just now");
  assert.strictEqual(V.matchText(sw("pending", null), NOW), "Waiting to be checked");
  assert.strictEqual(V.matchText({ kind: "infra" }, NOW), "");
});

test("the environment is grouped by server, with loose software kept apart", function () {
  var items = [
    { id: "vi_host0001", kind: "infra", name: "vps" },
    { id: "vi_host0002", kind: "infra", name: "dc01" },
    { id: "vi_soft0001", kind: "software", name: "PHP", parentId: "vi_host0001" },
    { id: "vi_soft0002", kind: "software", name: "Caddy", parentId: "vi_host0001" },
    { id: "vi_soft0003", kind: "software", name: "Loose", parentId: null },
    { id: "vi_soft0004", kind: "software", name: "Orphan", parentId: "vi_gone0000" }
  ];
  var t = V.itemTree(items);
  assert.deepStrictEqual(t.hosts.map(function (h) { return h.host.name + ":" + h.software.map(function (s) { return s.name; }).join(","); }), ["vps:PHP,Caddy", "dc01:"]);
  assert.deepStrictEqual(t.loose.map(function (s) { return s.name; }), ["Loose", "Orphan"]);
  assert.deepStrictEqual(V.itemTree(null), { hosts: [], loose: [] });
});

test("a query string leaves out what is empty and escapes what is not", function () {
  assert.strictEqual(V.queryString({ view: "current", q: "", priority: "P1", all: true, page: 2, none: null, no: false }), "?view=current&priority=P1&all=1&page=2");
  assert.strictEqual(V.queryString({ q: "a b&c" }), "?q=a%20b%26c");
  assert.strictEqual(V.queryString({}), "");
});

test("pages and bars", function () {
  assert.strictEqual(V.pageCount(0, 25), 1);
  assert.strictEqual(V.pageCount(26, 25), 2);
  assert.strictEqual(V.pageCount(100, 25), 4);
  assert.strictEqual(V.barPercent(0, 10), 0);
  assert.strictEqual(V.barPercent(1, 1000), 2, "a small value is still visible");
  assert.strictEqual(V.barPercent(10, 10), 100);
  assert.strictEqual(V.barPercent(5, 0), 0);
});

test("a plan says who wrote it, and an approved plan is locked", function () {
  assert.deepStrictEqual(V.planBadge({ planStatus: "draft", plan: { by: "template" } }), { text: "Draft, written from a template", tone: "" });
  assert.strictEqual(V.planBadge({ planStatus: "draft", plan: { by: "you" } }).text, "Edited by you");
  assert.strictEqual(V.planBadge({ planStatus: "draft", plan: { by: "claude" } }).text, "Refined by Claude");
  assert.deepStrictEqual(V.planBadge({ planStatus: "approved", plan: {} }), { text: "Approved and locked", tone: "ok" });
  assert.strictEqual(V.canEditPlan({ planStatus: "draft", state: "affects" }), true);
  assert.strictEqual(V.canEditPlan({ planStatus: "approved", state: "approved" }), false);
  assert.strictEqual(V.canEditPlan({ planStatus: "draft", state: "approved" }), false);
});

test("Approve is offered only where it makes sense", function () {
  var plan = { steps: [{ text: "Update", who: "you", done: false }] };
  assert.strictEqual(V.canApprove({ state: "affects", plan: plan, opsItem: null }), true);
  assert.strictEqual(V.canApprove({ state: "new", plan: plan, opsItem: null }), true);
  assert.strictEqual(V.canApprove({ state: "affects", plan: plan, opsItem: "it_abcdefgh" }), false, "already on the board");
  assert.strictEqual(V.canApprove({ state: "approved", plan: plan, opsItem: null }), false);
  assert.strictEqual(V.canApprove({ state: "fixed", plan: plan, opsItem: null }), false);
  assert.strictEqual(V.canApprove({ state: "affects", plan: { steps: [] }, opsItem: null }), false, "a plan with no steps");
  assert.strictEqual(V.canApprove(null), false);
});

test("the plan the person edits is a copy, and what is sent back is trimmed with empty steps dropped", function () {
  var plan = { summary: "Update PHP", downtime: "A restart", steps: [{ text: "Back up", who: "you", done: true }, { text: "Check", who: "claude", done: false }] };
  var d = V.planDraft(plan);
  d.steps[0].text = "changed";
  assert.strictEqual(plan.steps[0].text, "Back up", "editing the draft leaves the original alone");
  d.steps.push({ text: "   ", who: "you", done: false });
  d.steps.push({ text: "  Verify  ", who: "weird", done: false });
  d.summary = "  Update PHP  ";
  var p = V.planPayload(d);
  assert.deepStrictEqual(p.steps.map(function (s) { return s.text + "|" + s.who + "|" + s.done; }), ["changed|you|true", "Check|claude|false", "Verify|you|false"]);
  assert.strictEqual(p.summary, "Update PHP");
  assert.deepStrictEqual(Object.keys(p).sort(), ["downtime", "effort", "rollback", "steps", "summary", "verify"], "only the fields the Worker accepts");
  assert.deepStrictEqual(V.planDraft(null).steps, []);
});

test("history events have readable titles and authors", function () {
  assert.strictEqual(V.eventTitle({ kind: "matched" }), "Found");
  assert.strictEqual(V.eventTitle({ kind: "approved" }), "Approved");
  assert.strictEqual(V.eventTitle({ kind: "some_new_kind" }), "some new kind");
  assert.strictEqual(V.actorText("claude"), "Claude");
  assert.strictEqual(V.actorText("system"), "Automatic check");
  assert.strictEqual(V.actorText("other"), "");
});

test("a refusal is explained in plain words, and a sign-in problem offers a way back in", function () {
  assert.match(V.errorMessage({ code: "recent_sign_in_required", status: 403 }), /recent sign-in/);
  assert.match(V.errorMessage({ code: "plan_locked", status: 409 }), /locked/);
  assert.match(V.errorMessage({ code: "catalog_unreachable", status: 503 }), /safe/);
  assert.match(V.errorMessage({ code: "secret_detected", field: "note", kind: "aws_key", status: 422 }), /note.*a cloud key/);
  assert.match(V.errorMessage({ code: "secret_detected", field: "reason", kind: "weird", status: 422 }), /a password or key/);
  assert.match(V.errorMessage({ status: 401 }), /Log in again/);
  assert.match(V.errorMessage({ status: 403 }), /can't change/);
  assert.match(V.errorMessage({ code: "something_else", status: 400 }), /something else/);
  assert.match(V.errorMessage(new Error("network")), /Couldn't reach/);
  assert.strictEqual(V.needsSignIn({ code: "recent_sign_in_required" }), true);
  assert.strictEqual(V.needsSignIn({ status: 401 }), true);
  assert.strictEqual(V.needsSignIn({ code: "plan_locked", status: 409 }), false);
  assert.strictEqual(V.needsSignIn(null), false);
});

test("a person can only choose the states the Worker lets a person set", function () {
  assert.deepStrictEqual(V.PERSON_STATES, ["new", "affects", "not_affected", "accepted", "fixed"]);
});

// ---- how the page is wired ----

var html = fs.readFileSync(path.join(root, "vulnerabilities.html"), "utf8");
var js = fs.readFileSync(path.join(root, "vuln.js"), "utf8");
var css = fs.readFileSync(path.join(root, "vuln.css"), "utf8");
var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");

test("the page loads only its own files, with no inline script or style, and may talk only to the Worker", function () {
  assert.ok(/default-src 'self'/.test(html));
  assert.ok(/connect-src 'self' https:\/\/api\.barnyard\.site;/.test(html));
  assert.ok(!/wss:/.test(html), "no live stream is used");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline script");
  assert.ok(!/\sstyle=/i.test(html), "no inline style attributes");
  assert.ok(!/(src|href)="https?:\/\//i.test(html), "nothing loaded from another site");
  assert.ok(/<title>Vulnerabilities/.test(html));
  assert.ok(/data-shell="vuln"/.test(html));
  ["shell.js", "auth-gate.js", "vuln.js"].forEach(function (f) { assert.ok(html.indexOf(f) !== -1, f); });
});

test("server text only ever reaches the page as text", function () {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "no HTML injection or eval");
  assert.ok(!/localStorage|sessionStorage/.test(js), "nothing is kept in the browser");
  assert.ok(/credentials: "include"/.test(js) && /referrerPolicy: "no-referrer"/.test(js));
  assert.ok(/rel = "noopener noreferrer"/.test(js), "outside links do not get the opener");
});

test("every route the page calls exists on the Worker", function () {
  var worker = path.join(root, "..", "ClaudeRepo-vulnstore", "cloudflare-worker", "src", "vuln-routes.js");
  var calls = (js.match(/request\("(GET|POST|PATCH|DELETE)", "([^"]*)"/g) || []).map(function (c) { return /request\("(\w+)", "([^"]*)"/.exec(c).slice(1); });
  assert.ok(calls.length >= 15, "found the calls");
  var known = { "/me": 1, "/environment": 1, "/refresh": 1, "/findings": 1, "/history/summary": 1, "/catalog/status": 1, "/catalog/archive/months": 1, "/catalog/products": 1, "/catalog/search": 1, "/catalog/cve/": 1 };
  calls.forEach(function (c) {
    var p = c[1].replace(/\?.*/, "");
    var ok = known[p] || /^\/environment\/$/.test(p) || /^\/findings\/$/.test(p) || /^\/findings\/$/.test(p);
    assert.ok(ok, "unknown route " + c[0] + " " + c[1]);
  });
  if (fs.existsSync(worker)) {
    var src = fs.readFileSync(worker, "utf8");
    ["/vuln/me", "/vuln/environment", "/vuln/refresh", "/vuln/findings", "/vuln/history/summary", "/vuln/catalog/"].forEach(function (r) { assert.ok(src.indexOf(r) !== -1, r + " is served"); });
    ["state", "plan", "approve"].forEach(function (a) { assert.ok(src.indexOf(a) !== -1); assert.ok(js.indexOf("/findings/\" + id + \"/" + a) !== -1, a + " is called"); });
  }
});

test("the shell lists the page under Work, with its icon, and knows which page it is", function () {
  assert.ok(/\{ id: "vuln", title: "Vulnerabilities", group: "Work", icon: "shield", path: "vulnerabilities\.html", local: "vulnerabilities\.html" \}/.test(shell));
  assert.ok(/shield: '<path/.test(shell), "the icon exists");
  assert.ok(/vulnerabilities\\\.html\$\/\.test\(location\.pathname\)\) return "vuln"/.test(shell));
});

test("the stylesheet is built on the shell's tokens, with a focus state and no hard-coded page colours", function () {
  assert.ok(/focus-visible/.test(css));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "colours come from the shell's tokens");
  assert.ok(/var\(--alert\)/.test(css) && /var\(--ok\)/.test(css));
});

console.log("\n" + passed + " passed");
