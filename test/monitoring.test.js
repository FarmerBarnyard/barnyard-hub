// Coverage for monitoring.js's pure helpers (the page behind /mon/*): the tiles, the summary strip, the email status
// line, the plain-words error text, recipients, the hours form and the history rows. The DOM and network parts were
// exercised in a real browser against a stand-in for the Worker.
//
//   node test/monitoring.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Mon = require(path.join(__dirname, "..", "monitoring.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.parse("2026-10-27T06:00:00Z");   // 14:00 in Perth
var MIN = 60000;
function mon(over) { return Object.assign({ id: "app02", name: "app02 (maps and AI server)", group: "servers", alert: true, status: "up", since: NOW - 90 * MIN, lastCheck: NOW - 2 * MIN, lastOk: NOW - 2 * MIN, lastMs: 180, detail: "", downSince: null }, over || {}); }

test("a tile says what state it is in, for how long, and where to go", function () {
  var up = Mon.tileModel(mon(), NOW);
  assert.strictEqual(up.tone, "ok"); assert.strictEqual(up.label, "Up");
  assert.ok(/Up for 1 h 30 min\./.test(up.line) && /Checked 2 min ago, answered in 180 ms/.test(up.line));
  assert.strictEqual(up.fix.href, "health.html");
  var down = Mon.tileModel(mon({ status: "down", downSince: NOW - 25 * MIN, detail: "http_530" }), NOW);
  assert.strictEqual(down.tone, "alert"); assert.strictEqual(down.label, "Down");
  assert.ok(/\(25 min\)/.test(down.line));
  assert.ok(/tunnel or the machine behind it is probably down/.test(down.detail));
  var unknown = Mon.tileModel(mon({ status: "unknown", detail: "access_denied" }), NOW);
  assert.strictEqual(unknown.label, "Can't tell"); assert.ok(/Access service token/.test(unknown.detail));
  var fresh = Mon.tileModel(mon({ status: "unknown", lastCheck: null, since: null }), NOW);
  assert.strictEqual(fresh.label, "Not checked yet"); assert.strictEqual(fresh.tone, "");
});

test("the check codes are put in words", function () {
  assert.ok(/did not answer within 8 seconds/.test(Mon.detailText("timeout")));
  assert.ok(/could not connect/.test(Mon.detailText("unreachable")));
  assert.ok(/server error \(503\)/.test(Mon.detailText("http_503")));
  assert.ok(/Cloudflare could not reach it \(error 523\)/.test(Mon.detailText("http_523")));
  assert.ok(/no address/.test(Mon.detailText("not_configured")));
  assert.strictEqual(Mon.detailText(""), "");
});

test("the strip names what is down and stays calm otherwise", function () {
  assert.strictEqual(Mon.summarise([], NOW).tone, "");
  assert.strictEqual(Mon.summarise([mon(), mon({ id: "cld01", name: "BARNYARDCLD01" })], NOW).headline, "All good");
  var one = Mon.summarise([mon({ status: "down", downSince: NOW - 40 * MIN }), mon({ id: "vtt", name: "VTT server" })], NOW);
  assert.strictEqual(one.tone, "alert"); assert.strictEqual(one.headline, "app02 (maps and AI server) is down");
  assert.ok(/40 min ago/.test(one.detail));
  var two = Mon.summarise([mon({ status: "down", downSince: NOW - 10 * MIN }), mon({ id: "vtt", name: "VTT server", status: "down", downSince: NOW - 30 * MIN })], NOW);
  assert.strictEqual(two.headline, "2 things are down"); assert.ok(/30 min ago/.test(two.detail));
  var cant = Mon.summarise([mon(), mon({ id: "cld01", name: "BARNYARDCLD01", status: "unknown", detail: "access_denied" })], NOW);
  assert.strictEqual(cant.tone, "attn"); assert.ok(/could not be confirmed/.test(cant.detail));
  assert.strictEqual(Mon.summarise([mon({ status: "unknown", lastCheck: null })], NOW).headline, "Waiting for the first checks");
});

test("the email line says whether alerts can go out and what to do if not", function () {
  var s = { recipients: ["a@example.com"], businessHours: { enabled: true, tz: "Australia/Perth", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" } };
  var ok = Mon.emailStatus({ email: { ready: true, blocked: null }, settings: s });
  assert.strictEqual(ok.tone, "ok"); assert.ok(/goes to 1 address/.test(ok.text)); assert.ok(/Mon-Fri 08:00-17:00 Australia\/Perth/.test(ok.hint));
  assert.ok(/MON_MAIL_FROM/.test(Mon.emailStatus({ email: { ready: false, blocked: "no_sender_address" }, settings: s }).hint));
  assert.ok(/M365_MAIL_CLIENT_SECRET/.test(Mon.emailStatus({ email: { ready: false, blocked: "mail_not_configured" }, settings: s }).hint));
  assert.ok(/Add your address/.test(Mon.emailStatus({ email: { ready: false, blocked: "no_recipients" }, settings: s }).hint));
  assert.strictEqual(Mon.emailStatus(null).tone, "");
});

test("a failed test email says what to check, in words", function () {
  var t = Mon.mailErrorText;
  assert.ok(/sender mailbox was not found.*MON_MAIL_FROM/.test(t({ error: "bad_request", detail: "ErrorInvalidUser", status: 404 })));
  assert.ok(/sender mailbox was not found/.test(t({ error: "bad_request", status: 404 })));
  assert.ok(/not ready for sending/.test(t({ error: "bad_request", detail: "MailboxNotEnabledForRESTAPI" })));
  assert.ok(/(SomethingElse)/.test(t({ error: "bad_request", detail: "SomethingElse" })));
  assert.ok(/Exchange scope/.test(t({ error: "forbidden" })));
  assert.ok(/client secret may have expired/.test(t({ error: "auth" })));
  assert.ok(/Sign in again/i.test(t({ error: "recent_sign_in_required" })));
  assert.ok(/wait 12 seconds/.test(t({ error: "rate_limited", retryMs: 11200 })));
  assert.ok(/switched off/.test(t({ error: "monitor_disabled" })));
  assert.ok(/That did not work \(odd\)/.test(t({ error: "odd" })));
  assert.ok(/That did not work\./.test(t(null)));
});

test("working hours read like a person would say them", function () {
  var bh = { enabled: true, tz: "Australia/Perth", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" };
  assert.strictEqual(Mon.hoursText(bh), "Mon-Fri 08:00-17:00 Australia/Perth");
  assert.strictEqual(Mon.hoursText(Object.assign({}, bh, { days: [0, 1, 2, 3, 4, 5, 6] })), "every day 08:00-17:00 Australia/Perth");
  assert.strictEqual(Mon.hoursText(Object.assign({}, bh, { days: [3, 1] })), "Mon, Wed 08:00-17:00 Australia/Perth");
  assert.strictEqual(Mon.hoursText(Object.assign({}, bh, { days: [6, 0] })), "Sat, Sun 08:00-17:00 Australia/Perth");
  assert.strictEqual(Mon.hoursText(Object.assign({}, bh, { enabled: false })), "any time");
});

test("recipients are checked before they are sent, and the list stays at three", function () {
  assert.strictEqual(Mon.validateAddress(" Me@Example.COM ").address, "me@example.com");
  ["", "nope", "a@b", "a b@example.com", "x".repeat(300) + "@example.com"].forEach(function (bad) { assert.strictEqual(Mon.validateAddress(bad).ok, false, bad); });
  var r = Mon.addRecipient([], "a@example.com");
  assert.deepStrictEqual(r.list, ["a@example.com"]);
  assert.strictEqual(Mon.addRecipient(["a@example.com"], "A@example.com").ok, false, "no duplicates");
  assert.ok(/At most 3/.test(Mon.addRecipient(["a@example.com", "b@example.com", "c@example.com"], "d@example.com").error));
  assert.deepStrictEqual(Mon.removeRecipient(["a@example.com", "b@example.com"], "a@example.com"), ["b@example.com"]);
  assert.deepStrictEqual(Mon.removeRecipient(null, "x"), []);
});

test("the hours form becomes the body the Worker expects, or a reason it cannot", function () {
  var ok = Mon.hoursBody({ enabled: true, days: ["1", 2, 3], start: "08:00", end: "17:00", tz: "Australia/Perth" });
  assert.deepStrictEqual(ok, { businessHours: { enabled: true, tz: "Australia/Perth", days: [1, 2, 3], start: "08:00", end: "17:00" } });
  assert.strictEqual(Mon.hoursBody({ enabled: true, days: [], start: "08:00", end: "17:00", tz: "UTC" }).error, "days_invalid");
  assert.strictEqual(Mon.hoursBody({ enabled: true, days: [1], start: "17:00", end: "08:00", tz: "UTC" }).error, "time_invalid");
  assert.strictEqual(Mon.hoursBody({ enabled: true, days: [1], start: "", end: "08:00", tz: "UTC" }).error, "time_invalid");
  var off = Mon.hoursBody({ enabled: false, days: [], start: "08:00", end: "17:00", tz: "UTC" });
  assert.strictEqual(off.businessHours.enabled, false); assert.deepStrictEqual(off.businessHours.days, [1, 2, 3, 4, 5]);
});

test("the history shows sends and failures with the time in the owner's zone", function () {
  var rows = Mon.historyRows([
    { ts: Date.parse("2026-10-27T06:00:00Z"), kind: "alert", subject: "Barnyard monitor: app02 is down", recipients: 1, result: "sent", monitors: ["app02"] },
    { ts: Date.parse("2026-10-27T05:00:00Z"), kind: "test", subject: "Barnyard monitor: test email", recipients: 2, result: "bad_request", monitors: [] }
  ], "Australia/Perth");
  assert.strictEqual(rows[0].ok, true); assert.strictEqual(rows[0].result, "Sent to 1 address"); assert.ok(/14:00/.test(rows[0].when));
  assert.strictEqual(rows[1].kind, "Test"); assert.strictEqual(rows[1].ok, false); assert.strictEqual(rows[1].result, "Failed (bad_request)");
  assert.deepStrictEqual(Mon.historyRows(null, "UTC"), []);
});

test("the security block reads the register and the daily check, and copes with either being missing", function () {
  var rows = Mon.securityRows({ ok: true, byPriority: { P1: 2, P2: 5 }, needsLook: 3 }, { ok: true, check: { known: true, ok: true, said: "All clear", lastAt: NOW - 3 * 3600000 } }, NOW);
  assert.strictEqual(rows[0].tone, "alert"); assert.strictEqual(rows[0].value, "2");
  assert.strictEqual(rows[1].tone, "attn"); assert.ok(/3 still need a look/.test(rows[1].note));
  assert.strictEqual(rows[2].value, "OK"); assert.ok(/3 h ago/.test(rows[2].note));
  var none = Mon.securityRows(null, null, NOW);
  assert.strictEqual(none.length, 1); assert.strictEqual(none[0].value, "?");
  assert.strictEqual(Mon.securityRows({ ok: true, byPriority: {} }, null, NOW)[0].tone, "ok");
  var ex = Mon.expiryRows({ ok: true, expiries: [{ label: "Entra secret", daysLeft: 20 }, { label: "Old", daysLeft: -2 }, { label: "Far", daysLeft: 300 }, { label: "Extra", daysLeft: 400 }] });
  assert.strictEqual(ex.length, 3); assert.strictEqual(ex[0].tone, "attn"); assert.strictEqual(ex[1].tone, "alert"); assert.ok(/was due 2 days ago/.test(ex[1].text));
  assert.deepStrictEqual(Mon.expiryRows(null), []);
});

test("the page keeps the hub's rules: strict CSP, no inline code, no innerHTML, and it is in the menu", function () {
  var html = fs.readFileSync(path.join(root, "monitoring.html"), "utf8");
  assert.ok(html.indexOf("script-src 'self'") !== -1 && html.indexOf("style-src 'self'") !== -1);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/\sstyle=/.test(html), "no inline style attribute");
  assert.ok(html.indexOf("connect-src 'self' https://api.barnyard.site") !== -1);
  var js = fs.readFileSync(path.join(root, "monitoring.js"), "utf8");
  assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write/.test(js), "server text never reaches innerHTML");
  assert.ok(!/\.style\.cssText|setAttribute\("style"/.test(js));
});

console.log("\n" + passed + " tests passed");
