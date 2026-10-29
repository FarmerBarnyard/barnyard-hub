// Coverage for my-monitoring.js: the Monitoring page for everyone who is not the hub owner ("My infrastructure"), and the small
// People list the owner sees. The pure helpers (error words, rows, the install steps, backing off), the rules the page's source must
// keep (no innerHTML, no inline code, loaded before the owner's script), the reporter kit the install steps download, and the shell's
// menu entry. The DOM and network parts were exercised in a real browser against a stand-in for the Worker.
//
//   node test/my-monitoring.test.js

var assert = require("assert");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var My = require(path.join(__dirname, "..", "my-monitoring.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.parse("2026-10-30T06:00:00Z");
var MIN = 60000;
var KEY = "mr_0123456789ab_" + "A".repeat(32);

test("the Worker's error codes read as plain sentences, and an unknown one falls back to something safe", function () {
  assert.ok(/Sign in again/.test(My.errorText("recent_sign_in_required")));
  assert.ok(/private or reserved/.test(My.errorText("host_not_allowed")));
  assert.ok(/host, a colon and the port/.test(My.errorText("tcp_needs_port")));
  assert.ok(/most you can|already watch 10/.test(My.errorText("too_many_probes")));
  assert.strictEqual(My.errorText("something_new"), My.ERRORS.failed);
  assert.strictEqual(My.errorText(undefined), My.ERRORS.failed);
  // every code the Worker's personal routes and probe guard can answer with has words
  ["recent_sign_in_required", "host_not_allowed", "host_invalid", "https_only", "port_not_allowed", "credentials_not_allowed", "address_invalid", "address_too_long", "tcp_needs_port",
    "name_invalid", "label_invalid", "kind_invalid", "too_many_probes", "too_many_keys", "duplicate", "server_exists", "rate_limited", "spaces_full", "access_restricted", "access_suspended",
    "monitor_disabled", "probe_unknown", "reporter_unknown"].forEach(function (c) { assert.ok(My.ERRORS[c] && My.ERRORS[c].length > 10, c); });
  Object.keys(My.ERRORS).forEach(function (c) { assert.ok(!/L[123]\b/.test(My.ERRORS[c]), "no support-level wording"); });
});

test("a probe row says what it is, how it is doing and why when it is down", function () {
  var up = My.probeRow({ id: "pb_1", kind: "https", name: "Shop", label: "shop.example.org/health", status: "up", lastCheck: NOW - 2 * MIN, lastMs: 183.4, uptime7: 99.9, detail: "", detailText: "" }, NOW);
  assert.strictEqual(up.tone, "ok"); assert.strictEqual(up.word, "Up");
  assert.strictEqual(up.line, "checked 2 min ago · 183 ms · 99.9% up over 7 days");
  assert.strictEqual(up.kind, "Website");
  var down = My.probeRow({ id: "pb_2", kind: "tcp", name: "Database", label: "db.example.com:5432", status: "down", lastCheck: NOW - 5 * MIN, lastMs: 8000, uptime7: 80, detail: "timeout", detailText: "it did not answer in time" }, NOW);
  assert.strictEqual(down.tone, "alert"); assert.strictEqual(down.kind, "Host and port");
  assert.strictEqual(down.why, "It did not answer in time.");
  assert.ok(down.line.indexOf("ms") === -1, "a down check has no response time");
  var wait = My.probeRow({ id: "pb_3", kind: "https", name: "New", label: "x.example.org", status: "unknown", lastCheck: null, lastMs: null, uptime7: null, detail: "", detailText: "" }, NOW);
  assert.strictEqual(wait.tone, ""); assert.strictEqual(wait.word, "Waiting for the first check"); assert.strictEqual(wait.line, "the first check runs within five minutes");
  var blocked = My.probeRow({ id: "pb_4", kind: "https", name: "Old", label: "x", status: "unknown", lastCheck: NOW, lastMs: 0, uptime7: null, detail: "blocked", detailText: "the Worker was not allowed to reach it" }, NOW);
  assert.ok(/no longer allowed/.test(blocked.why));
});

test("a server row shows its last report, the numbers it sent and what needs attention", function () {
  var s = My.serverRow({ id: "rp_0123456789ab", server: "web-server", label: "Web server", status: "problem", lastSeen: NOW - MIN, expiresAt: Date.parse("2027-10-30T00:00:00Z"), load: { l1: 1.2, cores: 4 }, mem: { usedPct: 61.4 },
    disks: [{ mount: "/", usedPct: 96.2 }], services: [{ name: "nginx", up: true }, { name: "cron", up: false }], problems: ["the disk / is 96% full"], warnings: [], inventoryAt: NOW - 3 * 3600e3 }, NOW);
  assert.strictEqual(s.tone, "alert"); assert.strictEqual(s.word, "Needs attention");
  assert.strictEqual(s.line, "last report 1 min ago · load 0.3 per core · memory 61%");
  assert.deepStrictEqual(s.disks, [{ mount: "/", pct: 96 }]);
  assert.deepStrictEqual(s.downServices, ["cron"]);
  assert.deepStrictEqual(s.problems, ["the disk / is 96% full"]);
  assert.ok(/software list 3 h ago/.test(s.inventory) && /Key expires/.test(s.expires));
  var waiting = My.serverRow({ id: "rp_x", server: "db", label: "Db", status: "waiting", lastSeen: null, expiresAt: 0, disks: [], services: [], problems: [], warnings: [] }, NOW);
  assert.strictEqual(waiting.line, "no report yet"); assert.strictEqual(waiting.tone, ""); assert.strictEqual(waiting.word, "Waiting for the first report");
  assert.strictEqual(My.serverRow({ id: "rp_y", server: "x", label: "X", status: "silent", lastSeen: NOW - 30 * MIN, expiresAt: 0 }, NOW).tone, "alert");
  assert.strictEqual(My.serverRow({ id: "rp_z", server: "x", label: "X", status: "busy", lastSeen: NOW, expiresAt: 0 }, NOW).tone, "attn");
});

test("the summary strip is one word for the whole space", function () {
  assert.strictEqual(My.overall({ summary: { up: 0, down: 0, unknown: 0 } }).label, "Nothing watched yet");
  assert.strictEqual(My.overall({ summary: { up: 3, down: 0, unknown: 0 } }).tone, "ok");
  assert.strictEqual(My.overall({ summary: { up: 3, down: 0, unknown: 0 } }).label, "Everything is up");
  assert.strictEqual(My.overall({ summary: { up: 1, down: 0, unknown: 0 } }).line, "1 thing watched.");
  var down = My.overall({ summary: { up: 2, down: 1, unknown: 1 } });
  assert.strictEqual(down.tone, "alert"); assert.strictEqual(down.label, "1 thing is down");
  assert.strictEqual(My.overall({ summary: { up: 0, down: 2, unknown: 0 } }).label, "2 things are down");
  assert.strictEqual(My.overall({ summary: { up: 1, down: 0, unknown: 2 } }).tone, "attn");
  assert.strictEqual(My.overall(null).label, "Nothing watched yet");
});

test("the install steps carry the key and server name safely, fetch from this site, and check the files first", function () {
  var cmd = My.installCommand("web-server", KEY);
  assert.ok(cmd.indexOf("curl -fsSO https://dashboard.barnyard.site/reporter-kit/$f") !== -1);
  assert.ok(cmd.indexOf("sha256sum -c SHA256SUMS") !== -1 && cmd.indexOf("sha256sum -c SHA256SUMS") < cmd.indexOf("sudo sh install.sh"), "the check comes before anything is installed");
  assert.ok(cmd.indexOf("'web-server'") !== -1 && cmd.indexOf("'" + KEY + "'") !== -1);
  assert.ok(cmd.indexOf("sudo chmod 600 /etc/barnyard-reporter/env") !== -1);
  assert.strictEqual((cmd.match(/sudo sh install\.sh/g) || []).length, 2, "installed, then started once the settings are in");
  assert.ok(cmd.indexOf("BR_URL=https://api.barnyard.site/mon/report") !== -1 && cmd.indexOf("BR_INVENTORY_URL=https://api.barnyard.site/mon/inventory") !== -1);
  assert.ok(!/BR_PEERS="[^"]+"/.test(cmd), "no peers: those are the owner's servers");
  My.KIT_FILES.forEach(function (f) { assert.ok(cmd.indexOf(f) !== -1, f); });
  // nothing that could end a quote or start a command gets in
  ["web server", "web;ls", "web'x", "WEB", "-web", "web\nx", "a".repeat(25), "", "$(id)"].forEach(function (bad) { assert.strictEqual(My.installCommand(bad, KEY), "", JSON.stringify(bad)); });
  ["mr_0123456789ab_" + "A".repeat(31), "mr_0123456789ab_" + "A".repeat(32) + "'; ls #", "mr_0123456789ab_" + "A".repeat(31) + "$", "nope", "", "mr_0123456789AB_" + "A".repeat(32)].forEach(function (bad) { assert.strictEqual(My.installCommand("web", bad), "", JSON.stringify(bad)); });
});

test("the owner's People list shows names and counts, never an address or a target", function () {
  var rows = My.peopleRows({ ok: true, enabled: true, max: 25, people: [
    { space: "aaaaaaaaaaaa", name: "Alice", probes: 3, reporters: 1, up: 3, down: 0, unknown: 1, paused: false, lastTick: NOW - 2 * MIN },
    { space: "bbbbbbbbbbbb", name: "Bob", probes: 1, reporters: 0, up: 0, down: 1, unknown: 0, paused: false, lastTick: NOW - 5 * MIN },
    { space: "cccccccccccc", name: "", probes: 0, reporters: 0, up: 0, down: 0, unknown: 0, paused: true, lastTick: null }] }, NOW);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].line, "3 checks · 1 server · all up · checked 2 min ago"); assert.strictEqual(rows[0].tone, "ok");
  assert.strictEqual(rows[1].tone, "alert"); assert.ok(/1 down/.test(rows[1].line));
  assert.strictEqual(rows[2].word, "Paused"); assert.strictEqual(rows[2].name, "Unnamed");
  assert.deepStrictEqual(My.peopleRows(null, NOW), []);
});

test("busy answers back off the way the owner's page does, and the poll waits for a quiet, visible page", function () {
  assert.strictEqual(My.backoffMs(1, null), 15000); assert.strictEqual(My.backoffMs(2, null), 30000); assert.strictEqual(My.backoffMs(9, null), 300000);
  assert.strictEqual(My.backoffMs(1, 40), 40000);
  assert.strictEqual(My.parseRetryAfter("90", NOW), 90); assert.strictEqual(My.parseRetryAfter("9999", NOW), 300); assert.strictEqual(My.parseRetryAfter(null, NOW), null);
  var s = { hidden: false, state: "ok", busy: false, inflight: false, backoffUntil: 0, fetchedAt: NOW - 61000, now: NOW };
  assert.strictEqual(My.pollDue(s), true);
  assert.strictEqual(My.pollDue(Object.assign({}, s, { hidden: true })), false);
  assert.strictEqual(My.pollDue(Object.assign({}, s, { fetchedAt: NOW - 30000 })), false);
  assert.strictEqual(My.pollDue(Object.assign({}, s, { backoffUntil: NOW + 1000 })), false);
  assert.strictEqual(My.pollDue(Object.assign({}, s, { busy: true })), false);
  assert.strictEqual(My.pollDue(Object.assign({}, s, { state: "error" })), false);
  assert.strictEqual(My.STATUS_MS, 60000);
});

test("the page keeps the hub's rules: no innerHTML, no inline code or style, the status is read once a minute and never on a timer", function () {
  var js = fs.readFileSync(path.join(root, "my-monitoring.js"), "utf8");
  var code = js.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");
  assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write|outerHTML/.test(code), "server text never reaches innerHTML");
  assert.ok(!/\.style\.cssText|setAttribute\("style"/.test(code));
  assert.ok(!/setInterval/.test(code), "no fixed timer");
  assert.ok(!/localStorage|sessionStorage/.test(code), "the key and the status live in memory only");
  assert.ok(/delete r\.body\.key/.test(code), "the key is dropped from the copy of the status the page keeps");
  assert.ok(/visibilitychange/.test(code));
  var html = fs.readFileSync(path.join(root, "monitoring.html"), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  var mine = html.indexOf("my-monitoring.js"), owner = html.indexOf("monitoring.js?");
  assert.ok(mine !== -1 && owner !== -1 && mine < owner, "loaded before the owner's script, which hands over to it");
  assert.ok(/my-monitoring\.js\?v=[0-9a-f]{8}/.test(html), "stamped with its content hash");
  var own = fs.readFileSync(path.join(root, "monitoring.js"), "utf8");
  assert.ok(/who\.owner === false && window\.BarnyardMyMonitoring/.test(own), "the owner's page hands over for everyone else");
  assert.ok(/fetchStatus\(\{ force: true \}\)/.test(own), "and keeps reading the owner's status for the owner");
  assert.ok(/MON \+ "\/people"/.test(own) && /peopleBox\(model\.people/.test(own), "the owner's page lists the people");
  assert.ok(/r\.status === 403 && !model\.mine && window\.BarnyardMyMonitoring/.test(own), "a 403 from the owner's status hands over too, so a person whose session is not known yet still gets their own page");
});

test("every address the page talks to is the Worker's /mon/me/, and nothing of the owner's is read from it", function () {
  var code = fs.readFileSync(path.join(root, "my-monitoring.js"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");   // comments only: "https://" is not one
  var urls = code.match(/https:\/\/[A-Za-z0-9./-]+/g) || [];
  urls.forEach(function (u) { assert.ok(/^https:\/\/(api|dashboard)\.barnyard\.site\/|^https:\/\/www\.example\.com\//.test(u), u + " (the only other address is the example in the input's placeholder)"); });
  assert.ok(/ME = "https:\/\/api\.barnyard\.site\/mon\/me"/.test(code));
  assert.ok(!/\/mon\/status|\/mon\/settings|\/mon\/reporters"|hub\/status|vuln\/summary|incidents\/summary/.test(code), "none of the owner's routes");
});

test("the shell shows Monitoring in the menu to everyone it is allowed for, like the Ops board's link", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var line = shell.split("\n").filter(function (l) { return /id: "monitor"/.test(l); })[0];
  assert.ok(line, "the menu entry is there");
  assert.ok(!/ownerOnly/.test(line), "not owner only any more");
  assert.ok(/perm: "monitoring\.view"/.test(line), "the Users tab can still take it away per person");
  ["calendar", "incidents", "reports", "services", "users"].forEach(function (id) {
    var l = shell.split("\n").filter(function (x) { return x.indexOf('id: "' + id + '"') !== -1 && /title:/.test(x); })[0];
    assert.ok(/ownerOnly: true/.test(l), id + " stays owner only");
  });
});

// ---- the reporter kit the install steps download ------------------------------------------------------------------

var KIT = path.join(root, "reporter-kit");

test("the kit's checksum file lists exactly the kit's files with their real hashes, and the page downloads exactly those", function () {
  var listed = fs.readFileSync(path.join(KIT, "SHA256SUMS"), "utf8").split(/\r?\n/).filter(Boolean).map(function (l) { var m = /^([0-9a-f]{64})  (\S+)$/.exec(l); assert.ok(m, l); return { hash: m[1], file: m[2] }; });
  var files = fs.readdirSync(KIT).filter(function (f) { return f !== "SHA256SUMS"; }).sort();
  assert.deepStrictEqual(listed.map(function (x) { return x.file; }).sort(), files);
  listed.forEach(function (x) { assert.strictEqual(crypto.createHash("sha256").update(fs.readFileSync(path.join(KIT, x.file))).digest("hex"), x.hash, x.file + " changed: regenerate SHA256SUMS"); });
  assert.deepStrictEqual(My.KIT_FILES.slice().sort(), files.concat(["SHA256SUMS"]).sort(), "the page's download list is the kit");
});

test("the kit is plain Linux text (no carriage returns) and its scripts accept a person's own server name", function () {
  fs.readdirSync(KIT).forEach(function (f) { assert.ok(fs.readFileSync(path.join(KIT, f), "utf8").indexOf("\r") === -1, f + " has a carriage return"); });
  ["barnyard-reporter.sh", "barnyard-inventory.sh"].forEach(function (f) {
    var t = fs.readFileSync(path.join(KIT, f), "utf8");
    assert.ok(/\*\[!a-z0-9-\]\*\) fail "BR_SERVER must be/.test(t), f + " checks the name with a case pattern");
    assert.ok(!/grep -Eq '\^\[a-z0-9\]\[a-z0-9-\]/.test(t), f + " does not use grep for the name (a newline would slip past it)");
  });
  assert.ok(/\.\/\.\/|reporter-kit/.test("reporter-kit") && fs.readFileSync(path.join(root, ".gitattributes"), "utf8").indexOf("reporter-kit/** text eol=lf") !== -1, "kept on LF checkouts");
});

test("the kit is the same as ClaudeRepo's reporter folder when that checkout is next to this one", function () {
  var found = ["ClaudeRepo-permon", "ClaudeRepo"].map(function (d) { return path.join(root, "..", d, "reporter"); }).filter(function (d) { return fs.existsSync(path.join(d, "install.sh")); })[0];
  if (!found) { console.log("  (no ClaudeRepo checkout next to this one: skipped)"); return; }
  fs.readdirSync(KIT).filter(function (f) { return f !== "SHA256SUMS"; }).forEach(function (f) {
    var a = fs.readFileSync(path.join(KIT, f), "utf8").replace(/\r\n/g, "\n"), b = fs.readFileSync(path.join(found, f), "utf8").replace(/\r\n/g, "\n");
    assert.strictEqual(a, b, f + " differs from ClaudeRepo/reporter: copy it across and regenerate SHA256SUMS");
  });
});

console.log("\n" + passed + " tests passed");
