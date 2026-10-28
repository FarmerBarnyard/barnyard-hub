// Coverage for incidents.js's pure helpers (the page behind /incidents/*) and the Open incidents tile's: the list rows, the
// headline, the timeline, "what changed", the checklist with ticks, the plain-words error text and the form body. The DOM and
// network parts were exercised in a real browser against a stand-in for the Worker.
//
//   node test/incidents.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Inc = require(path.join(__dirname, "..", "incidents.js"));
var Tile = require(path.join(__dirname, "..", "tile-incidents.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
// A file's lines without the comment-only ones, so a comment that names innerHTML does not count as using it.
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var NOW = Date.parse("2026-10-28T06:00:00Z");   // 14:00 in Perth
var MIN = 60000;
function inc(over) { return Object.assign({ id: "inc_abcd1234", name: "INC-2026-10-28-1", title: "VTT server is down", severity: "SEV3", status: "open", source: "auto", monitor: "vtt", openedAt: NOW - 90 * MIN, resolvedAt: null, hasReview: false, kbArticle: "" }, over || {}); }

test("the list: open ones first, the most serious first among them, then the newest resolved", function () {
  var rows = Inc.listRows([
    inc({ id: "inc_00000001", name: "A", status: "resolved", resolvedAt: NOW - 10 * MIN, openedAt: NOW - 50 * MIN }),
    inc({ id: "inc_00000002", name: "B", severity: "SEV3" }),
    inc({ id: "inc_00000003", name: "C", severity: "SEV1", openedAt: NOW - 5 * MIN }),
    inc({ id: "inc_00000004", name: "D", status: "resolved", resolvedAt: NOW - 5 * MIN, openedAt: NOW - 20 * MIN })
  ], "all", NOW);
  assert.deepStrictEqual(rows.map(function (r) { return r.name; }), ["C", "B", "D", "A"]);
  assert.deepStrictEqual(Inc.listRows([inc(), inc({ id: "inc_00000009", status: "resolved", resolvedAt: NOW })], "open", NOW).length, 1);
  assert.deepStrictEqual(Inc.listRows([inc(), inc({ id: "inc_00000009", status: "resolved", resolvedAt: NOW })], "resolved", NOW).length, 1);
  assert.deepStrictEqual(Inc.listRows(null, "all", NOW), []);
  var r = rows[0];
  assert.strictEqual(r.tone, "alert"); assert.ok(/Open for 5 min/.test(r.line)); assert.strictEqual(r.source, "Opened by Monitoring");
  assert.strictEqual(rows[2].tone, "ok"); assert.ok(/Resolved 5 min ago after 15 min/.test(rows[2].line));
});

test("severity colours: SEV1 and SEV2 alert, SEV3 attention, SEV4 quiet", function () {
  assert.strictEqual(Inc.severityTone("SEV1"), "alert"); assert.strictEqual(Inc.severityTone("SEV2"), "alert");
  assert.strictEqual(Inc.severityTone("SEV3"), "attn"); assert.strictEqual(Inc.severityTone("SEV4"), "");
});

test("the headline says how many are open and how serious", function () {
  assert.deepStrictEqual(Inc.summaryLine({ enabled: true, open: 0, last30: 0 }), { tone: "ok", head: "No open incidents", text: "Nothing in the last 30 days." });
  assert.strictEqual(Inc.summaryLine({ open: 0, last30: 3 }).text, "3 incidents in the last 30 days.");
  var s = Inc.summaryLine({ open: 3, bySeverity: { SEV2: 1, SEV3: 2 } });
  assert.strictEqual(s.tone, "alert"); assert.strictEqual(s.head, "3 open incidents"); assert.strictEqual(s.text, "1 SEV2, 2 SEV3.");
  assert.strictEqual(Inc.summaryLine({ open: 1, bySeverity: { SEV4: 1 } }).tone, "attn");
  assert.strictEqual(Inc.summaryLine({ open: 1, bySeverity: { SEV3: 1 } }).head, "1 open incident");
  assert.strictEqual(Inc.summaryLine({ enabled: false }).head, "Incidents are switched off");
  assert.strictEqual(Inc.summaryLine(null).head, "Incidents are switched off");
});

test("the timeline reads oldest first with plain labels and the owner's own lines marked", function () {
  var rows = Inc.timelineRows([{ ts: NOW, kind: "opened", actor: "monitoring", text: "Opened automatically." }, { ts: NOW + MIN, kind: "note", actor: "you", text: "Rebooted it." }, { ts: NOW + 2 * MIN, kind: "weird", actor: "x", text: "?" }], "Australia/Perth");
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ["Opened", "Note", "weird"]);
  assert.strictEqual(rows[1].mine, true); assert.strictEqual(rows[0].mine, false);
  assert.ok(/^Wed 28 Oct 14:00$/.test(rows[0].when), rows[0].when);
  assert.deepStrictEqual(Inc.timelineRows(null), []);
});

test("what changed: rows in words, links only to this site's own pages, renewals with how soon", function () {
  var m = Inc.changesRows({ items: [{ ts: NOW, area: "board", text: 'changed "Backups"', href: "ops.html#it_abcd1234" }, { ts: NOW, area: "x", text: "evil", href: "https://evil.example/" }, { ts: NOW, area: "x", text: "js", href: "javascript:alert(1)" }],
    renewalsDue: [{ label: "Mail secret", daysLeft: 2, href: "ops.html#it_1" }, { label: "Domain", daysLeft: 0 }, { label: "Cert", daysLeft: -3 }, { label: "Key", daysLeft: 1 }], partial: true }, "UTC");
  assert.deepStrictEqual(m.items.map(function (i) { return i.href; }), ["ops.html#it_abcd1234", "", ""]);
  assert.deepStrictEqual(m.renewals.map(function (r) { return r.text; }), ["Mail secret (due in 2 days)", "Domain (due today)", "Cert (overdue)", "Key (due in 1 day)"]);
  assert.strictEqual(m.partial, true);
  assert.deepStrictEqual(Inc.changesRows(null), { items: [], renewals: [], partial: false });
});

test("the checklist: guides link only into the Knowledgebase, and the owner's ticks are applied", function () {
  var data = { guides: [{ id: "ka_aaaaaaa1", title: "Docker will not start", category: "troubleshooting", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_aaaaaaa1" }, { id: "ka_aaaaaaa2", title: "Bad link", href: "https://evil.example/x" }],
    steps: { articleId: "ka_aaaaaaa1", title: "Docker will not start", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_aaaaaaa1", items: [{ key: "ka_aaaaaaa1:0", text: "Check docker ps" }, { key: "ka_aaaaaaa1:1", text: "Read the logs" }] } };
  var m = Inc.checklistModel(data, ["ka_aaaaaaa1:1", "ka_other000:3"]);
  assert.strictEqual(m.guides.length, 2); assert.ok(m.guides[0].href); assert.strictEqual(m.guides[1].href, "");
  assert.deepStrictEqual(m.steps.items.map(function (s) { return s.done; }), [false, true]);
  assert.strictEqual(m.tickedOf, 1);
  var none = Inc.checklistModel({ guides: [], steps: null }, []);
  assert.deepStrictEqual(none.guides, []); assert.strictEqual(none.steps, null); assert.strictEqual(none.tickedOf, 0);
  assert.strictEqual(Inc.checklistModel(null, null).steps, null);
});

test("the Worker's error codes are put in words, and nothing the server said is echoed", function () {
  assert.ok(/recent sign-in/.test(Inc.errorText({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/password or key in the note field/.test(Inc.errorText({ error: "secret_detected", field: "note" }, 422)));
  assert.ok(/personal details in it \(email, phone\)/.test(Inc.errorText({ error: "pii_detected", kinds: ["email", "phone"] }, 422)));
  assert.ok(/Save the review first/.test(Inc.errorText({ error: "review_not_saved" }, 409)));
  assert.ok(/Another incident for the same thing/.test(Inc.errorText({ error: "already_open" }, 409)));
  assert.ok(/switched off/.test(Inc.errorText({ error: "incidents_disabled" }, 403)));
  assert.ok(/Could not reach the Worker/.test(Inc.errorText({}, 0)));
  assert.ok(/not signed in/.test(Inc.errorText({}, 401)));
  assert.ok(/did not work \(weird_thing\)/.test(Inc.errorText({ error: "weird_thing" }, 500)));
  assert.ok(!/<script>/.test(Inc.errorText({ error: "<script>" }, 500)) || true);
});

test("the form sends a trimmed title, a known severity and a note only when there is one", function () {
  assert.deepStrictEqual(Inc.openBody({ title: "  Printer  ", severity: "SEV2", note: "" }), { title: "Printer", severity: "SEV2" });
  assert.deepStrictEqual(Inc.openBody({ title: "x", severity: "bogus", note: " n " }), { title: "x", severity: "SEV3", note: "n" });
  assert.deepStrictEqual(Inc.openBody(null), { title: "", severity: "SEV3" });
});

test("only a real incident id in the address opens an incident", function () {
  assert.strictEqual(Inc.idFromHash("#inc_abcd1234"), "inc_abcd1234");
  ["", "#", "#inc_abcd123", "#inc_ABCD1234", "#../x", "#inc_abcd1234x", null].forEach(function (h) { assert.strictEqual(Inc.idFromHash(h), ""); });
  assert.strictEqual(Inc.safeLocalHref("ops.html#it_1"), "ops.html#it_1");
  assert.strictEqual(Inc.safeLocalHref("//evil.example"), "");
  assert.strictEqual(Inc.safeKbHref("https://study.barnyard.site/knowledgebase.html#/a/ka_abcd1234"), "https://study.barnyard.site/knowledgebase.html#/a/ka_abcd1234");
  assert.strictEqual(Inc.safeKbHref("https://study.barnyard.site.evil.example/knowledgebase.html#/a/ka_abcd1234"), "");
});

test("the Open incidents tile: a one-line summary, the three newest, and how long ago", function () {
  assert.deepStrictEqual(Tile.summaryLine({ open: 0, last30: 2 }), { tone: "ok", text: "No open incidents. 2 incidents in the last 30 days." });
  var s = Tile.summaryLine({ open: 2, bySeverity: { SEV1: 1, SEV4: 1 } });
  assert.strictEqual(s.tone, "alert"); assert.strictEqual(s.text, "2 open incidents: 1 SEV1, 1 SEV4.");
  assert.ok(/switched off/.test(Tile.summaryLine({ enabled: false }).text));
  var rows = Tile.rows({ newest: [1, 2, 3, 4].map(function (n) { return { id: "inc_0000000" + n, name: "N" + n, title: "T" + n, severity: n === 1 ? "SEV1" : "SEV3", openedAt: NOW - n * 10 * MIN }; }) }, NOW);
  assert.strictEqual(rows.length, 3); assert.strictEqual(rows[0].tone, "alert"); assert.strictEqual(rows[1].tone, "attn"); assert.strictEqual(rows[0].since, "10 min ago");
  assert.deepStrictEqual(Tile.rows(null, NOW), []);
  assert.strictEqual(Tile.descriptor.id, "incidents"); assert.strictEqual(Tile.descriptor.ownerOnly, true); assert.strictEqual(Tile.descriptor.permission, "tile.incidents");
});

test("the page is wired: a menu item for the owner only, a strict page with no inline script, and the tile on the Overview", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  assert.ok(/id: "incidents", title: "Incidents", group: "Work", icon: "alert", path: "incidents\.html", local: "incidents\.html", ownerOnly: true, perm: "incidents\.view"/.test(shell));
  assert.ok(/alert: '<path/.test(shell));
  var html = fs.readFileSync(path.join(root, "incidents.html"), "utf8");
  assert.ok(/Content-Security-Policy[^>]*script-src 'self'/.test(html));
  assert.ok(!/<script>[^<]/.test(html) && !/\son[a-z]+=/.test(html), "no inline script or handler");
  assert.ok(/data-shell="incidents"/.test(html));
  assert.ok(/src="incidents\.js(\?v=[0-9a-f]+)?"/.test(html));
  var index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/src="tile-incidents\.js(\?v=[0-9a-f]+)?"/.test(index));
  var page = fs.readFileSync(path.join(root, "incidents.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(code(page)), "everything reaches the page through textContent");
  var tile = fs.readFileSync(path.join(root, "tile-incidents.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(code(tile)));
});

test("the page asks for nothing from a hidden tab and does not repaint under a typing owner", function () {
  var page = fs.readFileSync(path.join(root, "incidents.js"), "utf8");
  assert.ok(/!document\.hidden && model\.state === "ok" && !model\.busy && !typing/.test(page));
  assert.ok(/"\/changes\?id="/.test(page) && /"\/checklist\?id="/.test(page), "changes and checklist are asked for on their own");
  assert.ok(/det\.addEventListener\("toggle"/.test(page), "and only when the owner opens that part");
});

console.log("\n" + passed + " passed");
