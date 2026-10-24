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

test("the catalogue's headline numbers read in order, with thousands separators", function () {
  var t = V.catalogTiles({ total: 413119, counts: { recent: 17172, archive: 395947 }, kev: 1754, enriched: 20000, withEpss: 300000 });
  assert.deepStrictEqual(t.map(function (x) { return x.label + "=" + x.value; }), [
    "CVEs in all=413,119", "Published in the last 30 days=17,172", "Older, in the archive=395,947", "Exploited in the wild=1,754",
    "With a score=20,000", "With an exploit likelihood=300,000"]);
  assert.strictEqual(V.catalogTiles(null)[0].value, "0", "an unreadable status shows zeros, not a crash");
});

test("each feed the catalogue is built from says when it last worked, or what went wrong", function () {
  var now = Date.UTC(2026, 9, 23, 12, 0, 0);
  var rows = V.sourceRows({
    cve_list: { ok: true, lastRun: "x", lastOk: new Date(now - 30 * 60000).toISOString() },
    kev: { ok: false, error: "HTTPError 503", lastOk: new Date(now - 3 * 86400000).toISOString() },
    epss: { ok: false }
  }, now);
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(rows[0], { title: "CVE.org list of every CVE", tone: "ok", text: "Updated 30 min ago" });
  assert.strictEqual(rows[1].tone, "alert");
  assert.strictEqual(rows[1].text, "Failed: HTTPError 503. Last worked 3 days ago.");
  assert.strictEqual(rows[2].text, "Failed.", "no reason and no earlier success");
  assert.deepStrictEqual([rows[3].tone, rows[3].text], ["", "Not run yet"]);
  assert.strictEqual(V.sourceRows(null, now).every(function (r) { return r.text === "Not run yet"; }), true);
  assert.ok(V.sourceRows({ kev: { ok: false, error: new Array(400).join("x") } }, now)[1].text.length < 200, "a long error is cut");
});

test("while the first full load is running the catalogue says it is incomplete", function () {
  assert.match(V.loadBanner({ loaded: null, total: 112000 }), /still running \(112,000 CVEs so far\).*not complete/);
  assert.strictEqual(V.loadBanner({ loaded: { tag: "x" }, total: 413119 }), null);
  assert.strictEqual(V.loadBanner(null), null);
});

test("a CVSS vector is put in plain words, and one that cannot be read is left out", function () {
  assert.strictEqual(V.vectorText("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), "Attacked over the network; low complexity; no privileges needed; no user interaction");
  assert.strictEqual(V.vectorText("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:C/C:L/I:L/A:L"), "Attacked locally on the machine; high complexity; high privileges needed; user interaction needed");
  assert.strictEqual(V.vectorText("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), "Attacked over the network; low complexity; no privileges needed; a little user interaction");
  ["", "AV:N/AC:L", "not a vector", null, undefined, 5].forEach(function (bad) { assert.strictEqual(V.vectorText(bad), "", String(bad)); });
  assert.strictEqual(V.vectorText("CVSS:3.1/AV:X"), "", "unknown letters say nothing rather than guess");
});

test("the CVSS scores on a record read newest standard first", function () {
  var rows = V.cvssRows({ v31: { score: 9.8, severity: "CRITICAL", vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }, v40: { score: 9.3, severity: "CRITICAL", vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" } });
  assert.deepStrictEqual(rows.map(function (r) { return r.label + " " + r.text; }), ["CVSS 4.0 9.3 Critical", "CVSS 3.1 9.8 Critical"]);
  assert.ok(rows[0].how.indexOf("over the network") !== -1);
  assert.deepStrictEqual(V.cvssRows(null), []);
  assert.deepStrictEqual(V.cvssRows({ v31: { score: null } }), []);
  assert.ok(V.cvssRows({ v31: { score: 5, vector: new Array(300).join("x") } })[0].vector.length <= 120);
});

test("an affected-version line reads the way a person would say it", function () {
  assert.strictEqual(V.rangeText({ product: "PHP", exact: "8.3.30" }), "PHP 8.3.30");
  assert.strictEqual(V.rangeText({ product: "PHP", from: "8.3.0", fromIncl: true, to: "8.3.36", toIncl: false }), "PHP from 8.3.0 up to but not including 8.3.36");
  assert.strictEqual(V.rangeText({ product: "PHP", from: "8.3.0", fromIncl: false, to: "8.3.36", toIncl: true }), "PHP after 8.3.0 up to and including 8.3.36");
  assert.strictEqual(V.rangeText({ product: "PHP", from: "0", to: "8.2.35", toIncl: false }), "PHP before 8.2.35", "a range from version 0 is just 'before'");
  assert.strictEqual(V.rangeText({ product: "PHP", to: "8.2.35", toIncl: true }), "PHP up to and including 8.2.35");
  assert.strictEqual(V.rangeText({ product: "PHP", from: "8.4.0", fromIncl: true }), "PHP 8.4.0 and later");
  assert.strictEqual(V.rangeText({ product: "Caddy" }), "Caddy (all versions)");
  assert.strictEqual(V.rangeText({ vendor: "Acme" }), "Acme (all versions)");
  assert.strictEqual(V.rangeText(null), "");
});

test("a pasted list is checked field by field, and nothing is sent when anything is wrong", function () {
  var good = JSON.stringify({ servers: [{ name: "vps", internet: true, importance: "high", notes: "public", software: [{ product: "caddy", vendor: "caddyserver", version: "2.11.7", name: "Caddy 2.11.7" }, { product: "openssh" }] }], software: [{ product: "ollama", version: "0.5.0" }] });
  var p = V.parseImport(good);
  assert.deepStrictEqual(p.problems, []);
  assert.strictEqual(p.servers.length, 1);
  assert.deepStrictEqual(p.servers[0].payload, { kind: "infra", name: "vps", internet: true, importance: "high", notes: "public" });
  assert.deepStrictEqual(p.servers[0].software[0], { kind: "software", product: "caddy", vendor: "caddyserver", version: "2.11.7", name: "Caddy 2.11.7" });
  assert.deepStrictEqual(p.loose, [{ kind: "software", product: "ollama", version: "0.5.0" }]);

  function problems(obj) { return V.parseImport(typeof obj === "string" ? obj : JSON.stringify(obj)).problems; }
  assert.match(problems("{not json")[0], /isn't valid JSON/);
  assert.match(problems("[]")[0], /should be an object/);
  assert.match(problems({})[0], /empty/);
  assert.match(problems({ servers: [{ name: "a" }], extra: 1 }).join("|"), /Unknown top-level field extra/);
  assert.match(problems({ servers: [{ internet: true }] }).join("|"), /servers\[0\]: name is missing/);
  assert.match(problems({ servers: [{ name: "a", internet: "yes" }] }).join("|"), /internet should be true or false/);
  assert.match(problems({ servers: [{ name: "a", importance: "huge" }] }).join("|"), /importance should be low, normal or high/);
  assert.match(problems({ servers: [{ name: "a", colour: "red" }] }).join("|"), /unknown field colour/);
  assert.match(problems({ servers: [{ name: "a", software: [{ version: "1" }] }] }).join("|"), /servers\[0\]\.software\[0\]: product is missing/);
  assert.match(problems({ software: [{ product: "x", version: 8 }] }).join("|"), /version should be text/);
  assert.match(problems({ servers: [{ name: new Array(90).join("x") }] }).join("|"), /name is longer than 80/);
  assert.match(problems({ servers: ["web01"] }).join("|"), /should be an object/);
  assert.match(problems({ servers: "web01" }).join("|"), /servers should be a list/);
});

test("an import has the same limits as the Worker, so a list that would be refused part way is refused up front", function () {
  var many = []; for (var i = 0; i < 51; i++) many.push({ name: "h" + i });
  assert.match(V.parseImport(JSON.stringify({ servers: many })).problems.join("|"), /At most 50 servers/);
  var sw = []; for (var j = 0; j < 201; j++) sw.push({ product: "p" + j });
  assert.match(V.parseImport(JSON.stringify({ software: sw })).problems.join("|"), /At most 200 software/);
  assert.strictEqual(V.IMPORT_LIMITS.software, 200);
});

test("importing the same list twice adds nothing the second time", function () {
  var parsed = V.parseImport(JSON.stringify({ servers: [{ name: "vps", software: [{ product: "caddy", version: "2.11.7" }, { product: "node", version: "24.22.1" }] }, { name: "cld01" }], software: [{ product: "ollama" }] }));
  var first = V.planImport(parsed, []);
  assert.deepStrictEqual([first.add, first.skip], [5, 0]);
  assert.deepStrictEqual(first.steps.map(function (s) { return s.type + ":" + (s.payload.name || s.payload.product); }), ["server:vps", "software:caddy", "software:node", "server:cld01", "software:ollama"]);
  // what the Worker would now hold
  var held = [
    { id: "vi_host0001", kind: "infra", name: "VPS" }, { id: "vi_host0002", kind: "infra", name: "cld01" },
    { id: "vi_soft0001", kind: "software", product: "caddy", version: "2.11.7", parentId: "vi_host0001" },
    { id: "vi_soft0002", kind: "software", product: "NODE", version: "24.22.1", parentId: "vi_host0001" },
    { id: "vi_soft0003", kind: "software", product: "ollama", version: "", parentId: null }
  ];
  var second = V.planImport(parsed, held);
  assert.strictEqual(second.add, 0);
  assert.strictEqual(second.skip, 5);
  assert.ok(second.steps.every(function (s) { return s.type === "server" && s.existingId; }), "only the existing servers are carried through, to hang anything new on");
});

test("new software is added to an existing server, and the same product on another server is not a duplicate", function () {
  var parsed = V.parseImport(JSON.stringify({ servers: [{ name: "vps", software: [{ product: "caddy", version: "2.12.0" }] }, { name: "app02", software: [{ product: "caddy", version: "2.11.7" }] }] }));
  var held = [
    { id: "vi_host0001", kind: "infra", name: "vps" },
    { id: "vi_soft0001", kind: "software", product: "caddy", version: "2.11.7", parentId: "vi_host0001" }
  ];
  var plan = V.planImport(parsed, held);
  assert.strictEqual(plan.add, 3, "a new version on vps, plus the app02 server and its caddy");
  assert.strictEqual(plan.skip, 1, "vps already exists");
  var vps = plan.steps.filter(function (s) { return s.type === "server" && s.payload.name === "vps"; })[0];
  assert.strictEqual(vps.existingId, "vi_host0001");
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
// The start-up test below searches across lines, so a CRLF (Windows) checkout must read as LF.
var js = fs.readFileSync(path.join(root, "vuln.js"), "utf8").replace(/\r\n/g, "\n");
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
  var known = { "/me": 1, "/environment": 1, "/refresh": 1, "/findings": 1, "/findings/approve": 1, "/history/summary": 1, "/catalog/status": 1, "/catalog/archive/months": 1, "/catalog/products": 1, "/catalog/search": 1, "/catalog/cve/": 1 };
  calls.forEach(function (c) {
    var p = c[1].replace(/\?.*/, "");
    var ok = known[p] || /^\/environment\/$/.test(p) || /^\/findings\/$/.test(p) || /^\/findings\/$/.test(p);
    assert.ok(ok, "unknown route " + c[0] + " " + c[1]);
  });
  if (fs.existsSync(worker)) {
    var src = fs.readFileSync(worker, "utf8");
    ["/vuln/me", "/vuln/environment", "/vuln/refresh", "/vuln/findings", "/vuln/findings/approve", "/vuln/history/summary", "/vuln/catalog/"].forEach(function (r) { assert.ok(src.indexOf(r) !== -1, r + " is served"); });
    ["state", "plan", "approve"].forEach(function (a) { assert.ok(src.indexOf(a) !== -1); assert.ok(js.indexOf("/findings/\" + id + \"/" + a) !== -1, a + " is called"); });
  }
});

test("the page is drawn as soon as the person's own data is in, without waiting for the catalogue's status", function () {
  var start = js.indexOf("Promise.all([\n      api.me()");
  assert.ok(start !== -1, "the start-up block is there");
  var block = js.slice(start, js.indexOf("function (err) {", start));
  var firstFetch = block.slice(0, block.indexOf("]).then("));
  assert.ok(/api\.me\(\)/.test(firstFetch) && /api\.environment\(\)/.test(firstFetch), "the summary and the list are fetched together");
  assert.ok(!/catalogStatus/.test(firstFetch), "the catalogue status is not part of what the first draw waits for");
  assert.ok(block.indexOf("render();") < block.indexOf("api.catalogStatus()"), "it is asked for after the page is drawn");
  assert.ok(/querySelector\("\.vn-catalog"\)/.test(block), "and it only fills in the one line when it arrives");
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

test("approving many: the request names the findings by id or by the list's own filters", function () {
  assert.deepStrictEqual(V.bulkBody({ ids: { vf_aaaaaaaa: true, vf_bbbbbbbb: true } }, {}, "", false), { ids: ["vf_aaaaaaaa", "vf_bbbbbbbb"] });
  assert.deepStrictEqual(V.bulkIds({ ids: { vf_aaaaaaaa: true } }), ["vf_aaaaaaaa"]);
  assert.deepStrictEqual(V.bulkIds({}), []);
  var F = { q: " ", priority: "P1", state: "", item: "vi_abcdefgh", all: true, page: 4 };
  assert.deepStrictEqual(V.bulkFilter(F), { view: "current", priority: "P1", item: "vi_abcdefgh", all: true }, "empty filters and the page number are left out");
  assert.deepStrictEqual(V.bulkBody({ all: true, ids: { vf_aaaaaaaa: true } }, { priority: "P2" }, "Tonight", true), { filter: { view: "current", priority: "P2" }, note: "Tonight", dryRun: true }, "all matching wins over ticked ids");
  assert.ok(!("note" in V.bulkBody({ all: true }, {}, "", false)) && !("dryRun" in V.bulkBody({ all: true }, {}, "", false)));
  assert.strictEqual(V.BULK_MAX_IDS, 1000);
});

test("approving many: the preview says what will be created, in plain words", function () {
  assert.match(V.bulkSummaryText({ findings: 0, groups: [], skipped: {} }), /Nothing here can be approved/);
  assert.strictEqual(V.bulkSummaryText({ findings: 1, groups: [{}], skipped: {} }), "1 finding in 1 software item. This creates 1 Ops item, already approved, for Claude to carry out.");
  var s = V.bulkSummaryText({ findings: 14, groups: [{}, {}, {}], skipped: { approved: 2, fixed: 1, inProgress: 0, noPlan: 0 } });
  assert.match(s, /^14 findings in 3 software items\. This creates 3 Ops items/);
  assert.match(s, /3 other findings picked can't be approved .* and are left alone\./);
  assert.match(V.bulkSummaryText({ findings: 2, groups: [{}], skipped: { approved: 1 } }), /1 other finding picked can't be approved .* and is left alone\./);
  assert.strictEqual(V.bulkGroupLine({ name: "Google Chrome 155.0.8059.85", host: "barnyardpc01", count: 500, kev: 10, possible: 179, fixedIn: "156.0.8087.47" }),
    "Google Chrome 155.0.8059.85 on barnyardpc01: 500 findings, 10 exploited, 179 might apply, update to 156.0.8087.47");
  assert.strictEqual(V.bulkGroupLine({ name: "Caddy", host: null, count: 1 }), "Caddy: 1 finding");
});

test("approving many: totals, failures and when to ask again", function () {
  var t = V.bulkTotals();
  V.bulkAdd(t, { approved: 40, items: [{}, {}], failed: [] });
  V.bulkAdd(t, { approved: 5, items: [{}], failed: [{ item: "Chrome", count: 4, error: "board_full" }] });
  V.bulkAdd(t, null);
  assert.deepStrictEqual([t.approved, t.items, t.failed.length], [45, 3, 1]);
  assert.strictEqual(V.bulkResultText(t), "Approved 45 findings in 3 Ops items. Claude will pick them up from your Ops board.");
  assert.strictEqual(V.bulkResultText(V.bulkTotals()), "Nothing was approved.");
  assert.strictEqual(V.bulkResultText({ approved: 1, items: 1, failed: [] }), "Approved 1 finding in 1 Ops item. Claude will pick them up from your Ops board.");
  assert.strictEqual(V.bulkFailText({ item: "Chrome", count: 4, error: "board_full" }), "Chrome (4 findings): your Ops board is full");
  assert.strictEqual(V.bulkFailText({ item: "Caddy", count: 1, error: "weird" }), "Caddy (1 finding): not approved");
  assert.strictEqual(V.bulkShouldContinue({ remaining: 5, approved: 40, failed: [] }), true);
  assert.strictEqual(V.bulkShouldContinue({ remaining: 0, approved: 40, failed: [] }), false, "nothing left");
  assert.strictEqual(V.bulkShouldContinue({ remaining: 5, approved: 0, failed: [] }), false, "no progress stops it");
  assert.strictEqual(V.bulkShouldContinue({ remaining: 5, approved: 10, failed: [{ item: "x", count: 1, error: "board_full" }] }), false, "a failure stops it instead of retrying forever");
  assert.strictEqual(V.bulkShouldContinue(null), false);
});

test("approving many: the new refusals have plain messages", function () {
  assert.match(V.errorMessage({ code: "ids_invalid" }), /1,000/);
  assert.match(V.errorMessage({ code: "filter_invalid" }), /Clear them/);
  assert.match(V.errorMessage({ code: "selection_required" }), /Pick some findings/);
  assert.ok(V.needsSignIn({ code: "recent_sign_in_required" }), "a stale sign-in offers the sign-in link, as for a single Approve");
});

test("approving many: the page asks the Worker for it, checks the plan first, and builds everything from text", function () {
  assert.ok(/approveBulk: function \(body\) \{ return request\("POST", "\/findings\/approve", body\); \}/.test(js));
  assert.ok(/api\.approveBulk\(bulkBody\(sel, F, "", true\)\)/.test(js), "the preview is a dry run");
  assert.ok(/api\.approveBulk\(bulkBody\(P\.sel, P\.filter, \(P\.note \|\| ""\)\.trim\(\), false\)\)/.test(js), "the real run uses what was previewed, not what the list shows now");
  assert.ok(/Approve and create " \+ plural\(p\.groups\.length, "Ops item"\)/.test(js), "the button says how many items it will create");
  assert.ok(/Keep this page open/.test(js));
  assert.ok(/box\.setAttribute\("aria-label", "Select "/.test(js), "each tick box is labelled for a screen reader");
  assert.ok(/S\.bulk\.all = false; load\(\)/.test(js), "changing a filter drops an all-matching selection");
  assert.ok(!/innerHTML/.test(js));
  assert.ok(/\.vn-pickrow/.test(css) && /\.vn-bulk-groups/.test(css));
});

console.log("\n" + passed + " passed");
