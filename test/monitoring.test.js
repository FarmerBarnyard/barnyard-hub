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

function rp(over) { return Object.assign({ id: "rp_0123456789ab", server: "app02", label: "", createdAt: Date.parse("2026-10-28T01:00:00Z"), expiresAt: Date.parse("2027-10-28T01:00:00Z"), revoked: false, expired: false, lastSeen: NOW - 2 * MIN, interval: 60, reports: 5, state: "reporting",
  report: { load: { l1: 0.4, cores: 8 }, mem: { usedPct: 41.5 }, disks: [{ mount: "/", usedPct: 52 }, { mount: "/data", usedPct: 88 }], uptime: 100000, services: [{ name: "cloudflared", up: true }, { name: "docker", up: false }], peers: [{ id: "vtt", ok: true, ms: 80 }, { id: "cld01", ok: false, ms: null }, { id: "x", ok: null, ms: null }] } }, over || {}); }

test("uptime and the report lines read like a person would say them", function () {
  assert.strictEqual(Mon.uptimeText(100000), "1 d 3 h");
  assert.strictEqual(Mon.uptimeText(5400), "1 h 30 min");
  assert.strictEqual(Mon.uptimeText(30), "1 min");
  assert.strictEqual(Mon.uptimeText(-1), "");
  var lines = Mon.reportLines(rp().report);
  assert.deepStrictEqual(lines, ["Load 0.4 on 8 cores", "Memory 42% used", "Disk / 52% full", "Disk /data 88% full", "Up 1 d 3 h", "Services: cloudflared running, docker NOT running", "Can reach: vtt yes (80 ms), cld01 NO, x (not tested)"]);
  assert.deepStrictEqual(Mon.reportLines(null), []);
  assert.deepStrictEqual(Mon.reportLines({ load: null, mem: null, disks: [], uptime: null, services: [], peers: [] }), []);
});

test("a card per server: reporting, silent, waiting, expired, or no key, and how many more keys can be made", function () {
  var cards = Mon.reporterCards([rp(), rp({ id: "rp_aaaaaaaaaaaa", server: "cld01", state: "silent", lastSeen: NOW - 10 * MIN }), rp({ id: "rp_bbbbbbbbbbbb", server: "vtt", state: "waiting", lastSeen: null, report: null })], NOW);
  assert.deepStrictEqual(cards.map(function (c) { return c.id; }), ["app02", "cld01", "vtt"]);
  assert.deepStrictEqual([cards[0].tone, cards[0].label], ["ok", "Reporting"]);
  assert.ok(/Last report 2 min ago/.test(cards[0].line)); assert.strictEqual(cards[0].lines.length, 7);
  assert.deepStrictEqual([cards[1].tone, cards[1].label], ["attn", "Silent"]); assert.ok(/may have stopped/.test(cards[1].line));
  assert.strictEqual(cards[2].label, "Waiting for its first report"); assert.deepStrictEqual(cards[2].lines, []);
  assert.deepStrictEqual(cards[0].keys, [{ id: "rp_0123456789ab", tail: "89ab", state: "reporting", text: "made 2026-10-28, expires 2027-10-28", canRevoke: true }]);
  var none = Mon.reporterCards([], NOW);
  assert.ok(none.every(function (c) { return c.label === "No key yet" && c.canMake && c.keys.length === 0; }));
  var expired = Mon.reporterCards([rp({ state: "expired", expired: true })], NOW)[0];
  assert.deepStrictEqual([expired.tone, expired.label, expired.canMake, expired.keys[0].canRevoke], ["alert", "Key expired", true, false]);
  var revoked = Mon.reporterCards([rp({ state: "revoked", revoked: true })], NOW)[0];
  assert.strictEqual(revoked.label, "No key yet"); assert.strictEqual(revoked.keys[0].text, "revoked");
  var three = Mon.reporterCards([rp({ id: "rp_000000000001" }), rp({ id: "rp_000000000002" }), rp({ id: "rp_000000000003" })], NOW)[0];
  assert.strictEqual(three.canMake, false, "three keys is the most");
  var best = Mon.reporterCards([rp({ id: "rp_000000000001", lastSeen: NOW - 50 * MIN, state: "silent" }), rp({ id: "rp_000000000002", lastSeen: NOW - MIN })], NOW)[0];
  assert.strictEqual(best.label, "Reporting", "the key that reported most recently decides");
  assert.strictEqual(Mon.reporterCards(null, NOW).length, 3);
});

test("the key is shown as the two lines for the env file", function () {
  assert.strictEqual(Mon.envLines("app02", "mr_0123456789ab_" + "A".repeat(32)), "BR_SERVER=app02\nBR_KEY=mr_0123456789ab_" + "A".repeat(32) + "\n");
});

test("what the reports are saying: only what is not fine, notices apart from alerts, in words", function () {
  var rows = Mon.derivedRows([
    { id: "rep-app02", name: "app02 reporter", grade: "notice", status: "down", detail: "silent", downSince: NOW - 20 * MIN },
    { id: "res-cld01", name: "BARNYARDCLD01 disk or service", grade: "outage", status: "down", detail: "disk95|/|97", downSince: NOW - 5 * MIN },
    { id: "power", name: "power", grade: "outage", status: "up", detail: "" },
    { id: "warn-vtt", name: "vtt busy", grade: "notice", status: "unknown", detail: "" }
  ], NOW);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual([rows[0].label, rows[0].tone], ["Notice", "attn"]);
  assert.ok(/reporter service may have stopped/.test(rows[0].text) && /20 min/.test(rows[0].text));
  assert.deepStrictEqual([rows[1].label, rows[1].tone], ["Alert", "alert"]);
  assert.ok(/The disk \/ is 97% full\./.test(rows[1].text));
  assert.deepStrictEqual(Mon.derivedRows(null, NOW), []);
  assert.ok(/lost power or internet/.test(Mon.reasonText("power")));
  assert.strictEqual(Mon.reasonText("svc|nginx|"), "The service nginx is not running.");
  assert.strictEqual(Mon.reasonText("mem|-|97"), "Memory is 97% used.");
  assert.strictEqual(Mon.reasonText("load|-|2.1"), "The load is 2.1 per core.");
  assert.ok(/Cloudflare cannot reach it/.test(Mon.reasonText("server_up")));
  assert.strictEqual(Mon.reasonText("nonsense"), "");
});

test("making or revoking a key fails in words", function () {
  assert.ok(/already has three keys/.test(Mon.keyErrorText({ error: "too_many_keys" })));
  assert.ok(/no longer exists/.test(Mon.keyErrorText({ error: "reporter_unknown" })));
  assert.ok(/Sign in again/i.test(Mon.keyErrorText({ error: "recent_sign_in_required" })));
  assert.ok(/not one of the servers/.test(Mon.keyErrorText({ error: "server_unknown" })));
});

test("the page never keeps the key: it is built into a read-only box, not stored", function () {
  var js = fs.readFileSync(path.join(root, "monitoring.js"), "utf8");
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js), "nothing is written to browser storage");
  assert.ok(/delete r\.body\.key/.test(js), "the status copy kept in the page drops the key");
});

test("the alert switches are the five the Worker knows, each with words, in the order shown", function () {
  assert.deepStrictEqual(Mon.ALERT_SWITCHES.map(function (a) { return a[0]; }), ["reporters", "resources", "vulns", "calendar", "digest", "report"]);
  Mon.ALERT_SWITCHES.forEach(function (a) { assert.ok(a[1].length > 20, a[0]); });
  assert.ok(/critical vulnerability/.test(Mon.ALERT_SWITCHES[2][1]));
  assert.ok(/Calendar reminder/.test(Mon.ALERT_SWITCHES[3][1]));
  assert.ok(/weekly summary/.test(Mon.ALERT_SWITCHES[4][1]));
});

test("the phone line says whether pushes can go, and what is missing, in words", function () {
  var on = { push: { ready: true, blocked: null }, settings: { push: { enabled: true, when: "fallback", types: {} } } };
  var ok = Mon.pushStatus(on);
  assert.strictEqual(ok.tone, "ok"); assert.ok(/set up/.test(ok.text)); assert.ok(/only when email cannot carry an outage/.test(ok.hint));
  assert.ok(/whatever the hour/.test(Mon.pushStatus({ push: { ready: true }, settings: { push: { enabled: true, when: "always" } } }).hint));
  assert.ok(/switched off/.test(Mon.pushStatus({ push: { ready: true }, settings: { push: { enabled: false, when: "fallback" } } }).text));
  var none = Mon.pushStatus({ push: { ready: false, blocked: "no_topic" }, settings: { push: {} } });
  assert.strictEqual(none.tone, ""); assert.ok(/NTFY_TOPIC/.test(none.hint)); assert.ok(/ntfy app/.test(none.hint));
  assert.ok(/not valid/.test(Mon.pushStatus({ push: { ready: false, blocked: "topic_invalid" } }).text));
  assert.ok(/NTFY_URL/.test(Mon.pushStatus({ push: { ready: false, blocked: "bad_ntfy_url" } }).text));
  assert.ok(/NTFY_TOKEN/.test(Mon.pushStatus({ push: { ready: false, blocked: "token_invalid" } }).text));
  assert.strictEqual(Mon.pushStatus(null).tone, "", "an older Worker that says nothing about push reads as not set up");
});

test("a failed test push says what to check, never repeating a secret", function () {
  var t = Mon.pushErrorText;
  assert.ok(/NTFY_TOPIC is not set/.test(t({ error: "no_topic" })));
  assert.ok(/NTFY_TOKEN allows it/.test(t({ error: "refused" })));
  assert.ok(/did not answer in time/.test(t({ error: "timeout" })));
  assert.ok(/could not reach ntfy/.test(t({ error: "unreachable" })));
  assert.ok(/will not follow/.test(t({ error: "redirected" })));
  assert.ok(/error \(500\)/.test(t({ error: "http_500" })));
  assert.ok(/slowing requests down/.test(t({ error: "rate_limited" })));
  assert.ok(/wait 30 seconds/.test(t({ error: "rate_limited", retryMs: 29100 })), "the page's own once-a-minute limit reads as before");
  assert.ok(/Sign in again/i.test(t({ error: "recent_sign_in_required" })));
  assert.ok(Mon.PUSH_TYPES.map(function (p) { return p[0]; }).join() === "down,recovered,vulns,reminder");
});

test("an outage can be acknowledged only while it is down and emails; an acknowledged one says so and can be undone", function () {
  assert.strictEqual(Mon.ackModel({ status: "up", alert: true }, NOW), null);
  assert.strictEqual(Mon.ackModel({ status: "unknown", alert: true }, NOW), null);
  assert.strictEqual(Mon.ackModel({ status: "down", alert: false }, NOW), null, "a quiet site has no reminders to stop");
  assert.deepStrictEqual(Mon.ackModel({ status: "down", alert: true, ack: null }, NOW), { acked: false, text: "" });
  var a = Mon.ackModel({ status: "down", alert: true, ack: { at: NOW - 5 * MIN, via: "push" } }, NOW);
  assert.strictEqual(a.acked, true); assert.ok(/Acknowledged 5 min ago from the phone: no reminders until it is back up/.test(a.text));
  assert.ok(/Acknowledged 5 min ago:/.test(Mon.ackModel({ status: "down", alert: true, ack: { at: NOW - 5 * MIN, via: "hub" } }, NOW).text));
  var tile = Mon.tileModel(mon({ status: "down", downSince: NOW - 25 * MIN, ack: { at: NOW - MIN, via: "hub" } }), NOW);
  assert.strictEqual(tile.ack.acked, true);
  assert.strictEqual(Mon.tileModel(mon(), NOW).ack, null);
  var rows = Mon.derivedRows([{ id: "res-app02", name: "app02 disk or service", status: "down", grade: "outage", alert: true, detail: "", downSince: NOW - 10 * MIN, ack: null }, { id: "warn-app02", name: "app02 getting full", status: "down", grade: "notice", alert: true, detail: "", downSince: NOW - 10 * MIN }], NOW);
  assert.deepStrictEqual(rows.map(function (r) { return r.ack && r.ack.acked; }), [false, false]);
});

test("the history names pushes, acknowledgements and digests, and an acknowledgement is not a failure", function () {
  var rows = Mon.historyRows([
    { ts: NOW, kind: "push", subject: "app02 is down", recipients: 0, result: "sent" },
    { ts: NOW, kind: "test-push", subject: "Barnyard monitor: test push", recipients: 0, result: "refused" },
    { ts: NOW, kind: "ack", subject: "Acknowledged: app02", recipients: 0, result: "push" },
    { ts: NOW, kind: "ack", subject: "Acknowledged: vtt", recipients: 0, result: "hub" },
    { ts: NOW, kind: "digest", subject: "Barnyard weekly digest: no incidents", recipients: 1, result: "sent" }
  ], "Australia/Perth");
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ["Push", "Test push", "Acknowledged", "Acknowledged", "Digest"]);
  assert.deepStrictEqual(rows.map(function (r) { return r.ok; }), [true, false, true, true, true]);
  assert.strictEqual(rows[0].result, "Sent to the phone"); assert.strictEqual(rows[1].result, "Failed (refused)");
  assert.strictEqual(rows[2].result, "From the phone"); assert.strictEqual(rows[3].result, "From this page");
  assert.strictEqual(rows[4].result, "Sent to 1 address");
});

test("the page posts the new routes and never keeps a topic", function () {
  var js = fs.readFileSync(path.join(root, "monitoring.js"), "utf8");
  ["/test-push", "/test-digest", "/acknowledge"].forEach(function (p) { assert.ok(js.indexOf('"' + p + '"') > -1, p); });
  assert.ok(!/NTFY_TOPIC\s*=/.test(js) && !/topic\s*:/.test(js), "the page never asks for or stores the topic");
  assert.ok(!/innerHTML/.test(js.replace(/\/\/.*$/gm, "")), "server text still reaches the page only through textContent");
});

console.log("\n" + passed + " tests passed");
