// Coverage for reports.js's pure helpers (the page behind /reports/*): plain-words errors, which sentences to save, which
// table cells may become links, the month picker and the line above the report. The DOM and network parts were exercised in a
// real browser against a stand-in for the Worker. Also static checks on the page: no innerHTML, nothing inline, the nav item.
//
//   node test/reports.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Rp = require(path.join(__dirname, "..", "reports.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("errors come back in plain words, and an unknown one never shows the server's raw text", function () {
  assert.ok(/not started yet/.test(Rp.errorText({ error: "month_future" }, 400)));
  assert.ok(/password or a key/.test(Rp.errorText({ error: "secret_refused" }, 400)));
  assert.ok(/email address/.test(Rp.errorText({ error: "pii_refused" }, 400)));
  assert.ok(/sign in again/.test(Rp.errorText({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/Monitoring page/.test(Rp.errorText({ error: "no_recipients" }, 409)));
  assert.ok(/could not be reached/.test(Rp.errorText({}, 0)));
  assert.ok(/problem \(502\)/.test(Rp.errorText({}, 502)));
  assert.strictEqual(Rp.errorText({ error: "weird_code" }, 400), "Something went wrong (weird_code).");
  assert.strictEqual(Rp.errorText(null, 400), "Something went wrong.");
});

test("only changed sentences are saved; putting the made one back clears the saved one", function () {
  var sections = [
    { id: "availability", status: "ok", sentence: "Made one.", auto: "Made one.", edited: false },
    { id: "security", status: "ok", sentence: "My own words.", auto: "Made security.", edited: true },
    { id: "backups", status: "unavailable", sentence: "This section could not be read this time.", auto: "" },
    { id: "m365", status: "later", later: "arrives later" },
    { id: "incidents", status: "ok", sentence: "Made incidents.", auto: "Made incidents.", edited: false }
  ];
  assert.deepStrictEqual(Rp.notesToSave(sections, {}), {}, "nothing touched");
  assert.deepStrictEqual(Rp.notesToSave(sections, { availability: "Made one." }), {}, "typed back the same");
  assert.deepStrictEqual(Rp.notesToSave(sections, { availability: "  Two short outages.  " }), { availability: "Two short outages." });
  assert.deepStrictEqual(Rp.notesToSave(sections, { security: "Made security." }), { security: "" }, "back to the made one");
  assert.deepStrictEqual(Rp.notesToSave(sections, { security: "   " }), { security: "" }, "emptied means the made one returns");
  assert.deepStrictEqual(Rp.notesToSave(sections, { backups: "x", m365: "y", ghost: "z" }), {}, "unreadable sections, slots and unknown ids are never saved");
  assert.deepStrictEqual(Rp.notesToSave(sections, { incidents: "Line one\r\nline two" }), { incidents: "Line one\nline two" });
});

test("only a link into the Knowledgebase becomes clickable", function () {
  var ok = Rp.KB_PREFIX + "ka_abc12345";
  assert.strictEqual(Rp.safeReviewHref(ok), ok);
  assert.strictEqual(Rp.safeReviewHref("none yet"), "");
  assert.strictEqual(Rp.safeReviewHref("javascript:alert(1)"), "");
  assert.strictEqual(Rp.safeReviewHref(Rp.KB_PREFIX + "ka_x\"onmouseover=\"1"), "");
  assert.strictEqual(Rp.safeReviewHref("https://evil.example/knowledgebase.html#/a/ka_abc12345"), "");
  assert.strictEqual(Rp.safeReviewHref(Rp.KB_PREFIX), "");
  assert.deepStrictEqual(Rp.tableCells(["INC-1: Down", ok, "none yet"]), [{ text: "INC-1: Down" }, { text: "Open the review", href: ok }, { text: "none yet" }]);
});

test("the month picker lists the months and marks the one in progress; the line above says when the email goes", function () {
  var status = { months: [{ month: "2026-11", label: "November 2026" }, { month: "2026-10", label: "October 2026" }], dueMonth: "2026-10", monthlyEmail: true, email: { ready: true, blocked: null } };
  assert.deepStrictEqual(Rp.monthOptions(status), [{ value: "2026-11", label: "November 2026 (so far)" }, { value: "2026-10", label: "October 2026" }]);
  var ok = Rp.emailLine(status);
  assert.strictEqual(ok.tone, "ok");
  assert.ok(/October 2026 report is emailed to you on the first working day/.test(ok.text));
  var blocked = Rp.emailLine(Object.assign({}, status, { email: { ready: false, blocked: "no_recipients" } }));
  assert.strictEqual(blocked.tone, "warn");
  assert.ok(/Email is not ready yet: No address is saved/.test(blocked.text));
  var off = Rp.emailLine(Object.assign({}, status, { monthlyEmail: false }));
  assert.strictEqual(off.tone, "warn");
  assert.ok(/switched off/.test(off.text));
  assert.deepStrictEqual(Rp.emailLine(null), { tone: "", text: "" });
  assert.deepStrictEqual(Rp.monthOptions(null), []);
});

test("downloads are named for the month", function () {
  assert.strictEqual(Rp.fileNameFor("2026-10", "html"), "barnyard-it-report-2026-10.html");
  assert.strictEqual(Rp.fileNameFor("2026-10", "md"), "barnyard-it-report-2026-10.md");
});

test("the page is built without innerHTML, inline script or inline style, and has a strict CSP", function () {
  var js = fs.readFileSync(path.join(root, "reports.js"), "utf8");
  var html = fs.readFileSync(path.join(root, "monitoring.html"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "no HTML injection");
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script");
  assert.ok(!/ style=|<style/.test(html), "no inline style");
  assert.ok(/default-src 'self'; connect-src 'self' https:\/\/api\.barnyard\.site; style-src 'self'; script-src 'self'/.test(html));
  assert.ok(/id="pane-reports"[^>]*role="tabpanel"/.test(html));
  ["rp-month", "rp-refresh", "rp-root", "rp-stamp"].forEach(function (id) { assert.ok(html.indexOf('id="' + id + '"') > -1, id); });
});

test("every Worker route the page uses exists, and the page never polls", function () {
  var js = fs.readFileSync(path.join(root, "reports.js"), "utf8");
  ["/status", "/preview?month=", "/download?month=", "/notes", "/send"].forEach(function (p) { assert.ok(js.indexOf('"' + p) > -1, p); });
  assert.ok(!/setInterval/.test(js), "no polling");
  assert.ok(/credentials: "include"/.test(js) && /referrerPolicy: "no-referrer"/.test(js));
});

test("Reports is a Monitoring tab found by the search (owner only, behind the Users permission) and the Monitoring page has its switch", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var it = (shell.match(/\{ id: "reports"[^}]*\}/) || [""])[0];
  assert.ok(/ownerOnly: true/.test(it) && /perm: "reports\.view"/.test(it) && /path: "monitoring\.html#reports"/.test(it) && /nav: false/.test(it), it);
  assert.ok(/report: '<path/.test(shell), "the icon exists");
  var mon = fs.readFileSync(path.join(root, "monitoring.js"), "utf8");
  assert.ok(/\["report", "A monthly IT report/.test(mon));
});

test("the print stylesheet hides the shell and the editing boxes and prints the sentences", function () {
  var css = fs.readFileSync(path.join(root, "reports.css"), "utf8");
  var print = css.slice(css.indexOf("@media print"));
  assert.ok(/\.side/.test(print) && /\.rp-edit/.test(print) && /\.rp-actions/.test(print));
  assert.ok(/\.rp-sentence \{ display: block; \}/.test(print));
  assert.ok(/\.rp-sentence \{ display: none;/.test(css.slice(0, css.indexOf("@media print"))), "on screen the editing box is shown instead");
});

console.log("\n" + passed + " passed");
