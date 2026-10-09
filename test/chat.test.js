// Coverage for the Claude chat page (chat.js): the pure helpers (folding pushed messages into
// the list, grouping a turn, labels and wording) and the rules the page must keep (CSP, no
// innerHTML, owner-only nav item, script order). The DOM and the network are exercised in a
// real browser against a fake Worker.
//
//   node test/chat.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var chat = require(path.join(root, "chat.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

function msg(seq, role, text, status) { return { seq: seq, conv: "cv_aaaaaaaa", role: role, text: text, status: status || "done", ts: seq }; }
var CONV = { id: "cv_aaaaaaaa", title: "Plan", mode: "read", busy: false, updatedAt: 1 };

test("fold: a message is added in order and replaced by seq", function () {
  var s = { messages: [msg(1, "user", "hi")], conv: CONV };
  s = chat.fold(s, { type: "message", message: msg(3, "assistant", "", "queued") });
  s = chat.fold(s, { type: "message", message: msg(2, "tool", "Read a") });
  assert.deepStrictEqual(s.messages.map(function (m) { return m.seq; }), [1, 2, 3]);
  s = chat.fold(s, { type: "message", message: msg(3, "assistant", "Done.", "done") });
  assert.strictEqual(s.messages.length, 3);
  assert.strictEqual(s.messages[2].text, "Done.");
});

test("fold: text is added to the right message and nothing is changed in place", function () {
  var before = { messages: [msg(1, "user", "hi"), msg(2, "assistant", "He", "streaming")], conv: CONV };
  var copy = JSON.stringify(before);
  var after = chat.fold(before, { type: "delta", seq: 2, text: "llo" });
  assert.strictEqual(after.messages[1].text, "Hello");
  assert.strictEqual(after.messages[0].text, "hi");
  assert.strictEqual(JSON.stringify(before), copy);
  // a delta for a message that is not there changes nothing
  assert.deepStrictEqual(chat.fold(after, { type: "delta", seq: 99, text: "x" }).messages, after.messages);
});

test("fold: status, conversation and stopping", function () {
  var s = { messages: [msg(2, "assistant", "x", "streaming")], conv: CONV };
  s = chat.fold(s, { type: "stopping" });
  assert.strictEqual(s.conv.stopping, true, "stays while a reply is still running");
  s = chat.fold(s, { type: "status", seq: 2, status: "stopped" });
  assert.strictEqual(s.messages[0].status, "stopped");
  assert.strictEqual(s.conv.stopping, false, "cleared once nothing is running");
  s = chat.fold(s, { type: "conversation", conversation: Object.assign({}, CONV, { title: "Renamed" }) });
  assert.strictEqual(s.conv.title, "Renamed");
  // another conversation's update is ignored
  s = chat.fold(s, { type: "conversation", conversation: { id: "cv_bbbbbbbb", title: "Other" } });
  assert.strictEqual(s.conv.title, "Renamed");
});

test("fold: junk is ignored", function () {
  var s = { messages: [msg(1, "user", "hi")], conv: CONV };
  [null, undefined, "x", 5, {}, { type: "nope" }, { type: "message" }, { type: "message", message: { seq: "1" } }, { type: "delta", seq: "1", text: "x" }, { type: "delta", seq: 1 }, { type: "status", seq: 1 }].forEach(function (m) {
    assert.deepStrictEqual(chat.fold(s, m).messages, s.messages);
  });
});

test("groupTurns: tool lines belong to the message before them", function () {
  var turns = chat.groupTurns([
    msg(1, "user", "q1"), msg(2, "assistant", "a1"), msg(3, "tool", "Read a"), msg(4, "tool", "Grep b"),
    msg(5, "user", "q2"), msg(6, "assistant", "", "queued")
  ]);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].user.text, "q1");
  assert.strictEqual(turns[0].assistant.text, "a1");
  assert.deepStrictEqual(turns[0].tools.map(function (t) { return t.text; }), ["Read a", "Grep b"]);
  assert.strictEqual(turns[1].tools.length, 0);
  assert.strictEqual(turns[1].assistant.status, "queued");
  assert.deepStrictEqual(chat.groupTurns([]), []);
  // a reply with no message before it still shows
  assert.strictEqual(chat.groupTurns([msg(2, "assistant", "orphan")])[0].user, null);
});

test("isBusy and the status words", function () {
  assert.strictEqual(chat.isBusy([msg(1, "assistant", "", "queued")]), true);
  assert.strictEqual(chat.isBusy([msg(1, "assistant", "x", "streaming")]), true);
  assert.strictEqual(chat.isBusy([msg(1, "assistant", "x", "done"), msg(2, "assistant", "x", "error"), msg(3, "assistant", "x", "stopped")]), false);
  assert.strictEqual(chat.isBusy([msg(1, "user", "x", "queued")]), false);
  assert.strictEqual(chat.statusLabel("queued"), "Waiting for the runner…");
  assert.strictEqual(chat.statusLabel("stopped"), "Stopped");
  assert.strictEqual(chat.statusLabel("done"), "");
  assert.strictEqual(chat.statusLabel("constructor"), "");
  assert.strictEqual(chat.statusLabel(undefined), "");
});

test("sendBlock explains why Send is off", function () {
  var ok = { conv: CONV, busy: false, me: { runner: { online: true } }, text: "hello" };
  assert.strictEqual(chat.sendBlock(ok), "");
  assert.match(chat.sendBlock(Object.assign({}, ok, { conv: null })), /Start a chat/);
  assert.match(chat.sendBlock(Object.assign({}, ok, { busy: true })), /working/);
  assert.match(chat.sendBlock(Object.assign({}, ok, { me: { runner: { online: false } } })), /offline/);
  assert.match(chat.sendBlock(Object.assign({}, ok, { me: null })), /offline/);
  assert.match(chat.sendBlock(Object.assign({}, ok, { text: "   " })), /Type a message/);
  assert.match(chat.sendBlock(Object.assign({}, ok, { text: "x".repeat(chat.TEXT_MAX + 1) })), /too long/);
  assert.strictEqual(chat.sendBlock(Object.assign({}, ok, { text: "x".repeat(chat.TEXT_MAX) })), "");
});

test("runnerLabel", function () {
  var now = 1000000000000;
  assert.deepStrictEqual(chat.runnerLabel({ runner: { online: true, lastSeen: now } }, now), { tone: "ok", text: "Runner online" });
  assert.deepStrictEqual(chat.runnerLabel({ runner: { online: false, lastSeen: null } }, now), { tone: "off", text: "Runner has not connected yet" });
  assert.deepStrictEqual(chat.runnerLabel({ runner: { online: false, lastSeen: now - 5 * 60000 } }, now), { tone: "off", text: "Runner offline, last seen 5 min ago" });
  assert.strictEqual(chat.runnerLabel(null, now).tone, "none");
});

test("relativeTime", function () {
  var now = 1000000000000;
  assert.strictEqual(chat.relativeTime(now - 5000, now), "just now");
  assert.strictEqual(chat.relativeTime(now - 90 * 1000, now), "2 min ago");
  assert.strictEqual(chat.relativeTime(now - 3 * 3600 * 1000, now), "3 h ago");
  assert.strictEqual(chat.relativeTime(now - 2 * 86400 * 1000, now), "2 d ago");
  assert.strictEqual(chat.relativeTime(0, now), "");
  assert.strictEqual(chat.relativeTime(now + 5000, now), "just now");
});

test("the list is newest first and an unnamed chat has a name", function () {
  var list = [{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 3 }, { id: "c", updatedAt: 2 }];
  assert.deepStrictEqual(chat.newestFirst(list).map(function (c) { return c.id; }), ["b", "c", "a"]);
  assert.strictEqual(list[0].id, "a", "the original is not reordered");
  assert.strictEqual(chat.titleOf({ title: "" }), "New chat");
  assert.strictEqual(chat.titleOf(null), "New chat");
  assert.strictEqual(chat.titleOf({ title: "Plan" }), "Plan");
});

test("toolSummary", function () {
  var tools = [msg(1, "tool", "Read a"), msg(2, "tool", "Grep b")];
  assert.strictEqual(chat.toolSummary(tools, true), "Grep b");
  assert.strictEqual(chat.toolSummary(tools, false), "Used 2 tools");
  assert.strictEqual(chat.toolSummary(tools.slice(0, 1), false), "Used 1 tool");
  assert.strictEqual(chat.toolSummary([], true), "");
});

test("errorMessage: plain words, never the raw code or a secret", function () {
  var e = function (code, status, kind) { return chat.errorMessage({ code: code, status: status, kind: kind }); };
  assert.match(e("secret_detected", 422, "aws_key"), /a cloud key/);
  assert.match(e("secret_detected", 422, "weird"), /a password or key/);
  assert.match(e("recent_sign_in_required", 403), /recent sign-in/);
  assert.match(e("runner_offline", 503), /runner is offline/);
  assert.match(e("busy", 409), /still working/);
  assert.match(e("rate_limited", 429), /minute/);
  assert.match(e("rate_limited_today", 429), /today/);
  assert.match(e("chat_disabled", 503), /switched off/);
  assert.match(e(null, 401), /expired/);
  assert.match(e(null, 403), /owner/);
  assert.match(e("something_new", 500), /something new/);
  assert.match(chat.errorMessage(new Error("x")), /Couldn’t reach/);
  assert.match(chat.errorMessage(null), /Couldn’t reach/);
});

// ---- rules the page must keep ---------------------------------------------------------

test("chat.html stays inside the CSP and loads its scripts in order", function () {
  var html = read("chat.html");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "inline script");
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<meta[^>]*>/gi, "")), "inline event handler");
  assert.ok(!/\sstyle\s*=/i.test(html), "style attribute");
  assert.ok(!/<style[\s>]/i.test(html), "style element");
  assert.ok(/wss:\/\/api\.barnyard\.site/.test(html) && /connect-src 'self' https:\/\/api\.barnyard\.site/.test(html));
  assert.ok(/default-src 'self'/.test(html) && /script-src 'self'/.test(html) && /style-src 'self'/.test(html));
  var order = ["shell.js", "auth-gate.js", "markdown.js", "chat.js"].map(function (f) { return html.indexOf('src="' + f); });
  assert.ok(order.every(function (i) { return i > 0; }), "a script is missing");
  assert.deepStrictEqual(order.slice().sort(function (a, b) { return a - b; }), order, "scripts out of order");
  assert.ok(/data-shell="chat"/.test(html));
});

test("the chat builds its page without innerHTML, and talks only to the Worker's /chat routes", function () {
  ["chat.js", "markdown.js"].forEach(function (f) { assert.strictEqual((read(f).match(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/g) || []).length, 0, f); });
  var js = read("chat.js");
  var urls = js.match(/["']((?:https?|wss?):\/\/[^"']+)["']/g) || [];
  urls.forEach(function (u) { assert.ok(/^["'](https:\/\/api\.barnyard\.site\/chat|wss:\/\/api\.barnyard\.site\/chat\/ws)["']$/.test(u), "unexpected address " + u); });
  assert.ok(!/localStorage/.test(js), "a conversation id is the only thing kept, and only for the session");
  var css = read("chat.css");
  assert.ok(!/@import/.test(css) && !/url\(/.test(css), "chat.css loads nothing");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "chat.css uses theme tokens only, no fixed colours");
});

test("a reply is rendered by the safe renderer, which allows no images and no raw markup", function () {
  var md = require(path.join(root, "markdown.js"));
  var tree = md.parse("![x](https://evil.example/p.png)\n\n<script>alert(1)</script> [a](javascript:alert(1)) [b](https://ok.example/)");
  var seen = [];
  var doc = {
    createElement: function (n) { var e = { tag: n, children: [], attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; }, appendChild: function (c) { this.children.push(c); return c; } }; seen.push(e); return e; },
    createTextNode: function (t) { return { text: t }; },
    createDocumentFragment: function () { return { children: [], appendChild: function (c) { this.children.push(c); return c; } }; }
  };
  md.toDom(tree, doc, {});
  assert.ok(!seen.some(function (e) { return e.tag === "img" || e.tag === "script"; }), "no img or script element");
  var hrefs = seen.filter(function (e) { return e.tag === "a"; }).map(function (e) { return e.attrs.href; });
  // A foreign image is shown as a plain link the person may click, never fetched by the page;
  // the javascript: link is not a link at all.
  assert.deepStrictEqual(hrefs, ["https://evil.example/p.png", "https://ok.example/"]);
});

test("the shell shows the Claude page only to the owner or someone the Worker says may use it, and fails closed", function () {
  var shell = read("shell.js");
  assert.ok(/id: "chat", title: "Claude", group: "Work", icon: "chat", path: "chat\.html", local: "chat\.html", chatOnly: true/.test(shell));
  assert.ok(/if \(p\.chatOnly\) \{ var c = Theme\.who && Theme\.who\.get\(\); return !!c && \(c\.owner === true \|\| c\.chat === true\); \}/.test(shell), "owner or chat hint");
  assert.ok(/if \(p\.ownerOnly \|\| p\.chatOnly\) a\.hidden = !pageAllowed\(p\);/.test(shell), "hidden until known");
  assert.ok(/chat: '<path/.test(shell), "icon");
});


test("clockTime: today shows just the time, an earlier day adds the date, and nonsense shows nothing", function () {
  var now = new Date(2026, 9, 9, 20, 30).getTime();
  assert.strictEqual(chat.clockTime(new Date(2026, 9, 9, 15, 42).getTime(), now), "3:42 pm");
  assert.strictEqual(chat.clockTime(new Date(2026, 9, 9, 0, 5).getTime(), now), "12:05 am");
  assert.strictEqual(chat.clockTime(new Date(2026, 9, 9, 12, 0).getTime(), now), "12:00 pm");
  assert.strictEqual(chat.clockTime(new Date(2026, 9, 9, 9, 7).getTime(), now), "9:07 am");
  assert.strictEqual(chat.clockTime(new Date(2026, 9, 8, 23, 59).getTime(), now), "8 Oct, 11:59 pm");
  assert.strictEqual(chat.clockTime(new Date(2025, 11, 31, 8, 0).getTime(), now), "31 Dec, 8:00 am");
  assert.strictEqual(chat.clockTime(0, now), "");
  assert.strictEqual(chat.clockTime(undefined, now), "");
  assert.strictEqual(chat.clockTime(NaN, now), "");
});

test("starter prompts are short plain questions the owner could send as they are", function () {
  assert.ok(chat.STARTERS.length >= 3 && chat.STARTERS.length <= 6);
  chat.STARTERS.forEach(function (s) {
    assert.ok(typeof s === "string" && s.length > 10 && s.length < 120, s);
    assert.ok(!/[<>]/.test(s));
  });
  assert.strictEqual(new Set(chat.STARTERS).size, chat.STARTERS.length, "no repeats");
});

test("the page shows who said what: a Claude avatar and card, a time label, a typing indicator, and starters; no inner HTML", function () {
  var js = read("chat.js");
  assert.ok(js.indexOf("chat-avatar") >= 0 && js.indexOf("chat-card") >= 0 && js.indexOf("chat-dots") >= 0 && js.indexOf("chat-starter") >= 0);
  assert.ok(!/innerHTML\s*=/.test(js), "model text never goes in as markup");
  var css = read("chat.css");
  assert.ok(css.indexOf("prefers-reduced-motion") >= 0 && css.indexOf(".chat-dots i { animation: none; }") >= 0, "the dots stop moving for people who ask for less motion");
  assert.ok(css.indexOf("@media (hover: none)") >= 0, "Copy is always visible on touch screens");
});

// ---- guests: their own Claude on their own computer ----------------------------------------------

var GUEST = { kind: "guest", runner: { online: false, lastSeen: null }, keys: { active: 0 } };

test("a guest is told apart from the owner by the Worker's own answer, and the owner's wording is unchanged", function () {
  assert.strictEqual(chat.isGuest(GUEST), true);
  assert.strictEqual(chat.isGuest({ kind: "owner" }), false);
  assert.strictEqual(chat.isGuest({}), false);
  assert.strictEqual(chat.isGuest(null), false);
  assert.deepStrictEqual(chat.runnerLabel({ kind: "owner", runner: { online: true } }, 1), { tone: "ok", text: "Runner online" });
});

test("connectState: no key, a key but nothing connected, connected", function () {
  assert.strictEqual(chat.connectState(GUEST), "need_key");
  assert.strictEqual(chat.connectState({ kind: "guest", runner: { online: false }, keys: { active: 1 } }), "waiting");
  assert.strictEqual(chat.connectState({ kind: "guest", runner: { online: true }, keys: { active: 1 } }), "connected");
  assert.strictEqual(chat.connectState({ kind: "guest" }), "need_key", "a half-formed answer is treated as not connected");
  assert.strictEqual(chat.connectState({ kind: "owner", runner: { online: false } }), "owner");
});

test("a guest's labels and messages talk about their own Claude, not a runner on a server", function () {
  var now = 10 * 60000;
  assert.deepStrictEqual(chat.runnerLabel({ kind: "guest", runner: { online: true } }, now), { tone: "ok", text: "Your Claude is connected" });
  assert.deepStrictEqual(chat.runnerLabel(GUEST, now), { tone: "off", text: "Your Claude is not connected yet" });
  assert.deepStrictEqual(chat.runnerLabel({ kind: "guest", runner: { online: false, lastSeen: now - 5 * 60000 } }, now), { tone: "off", text: "Your Claude is offline, last seen 5 min ago" });
  assert.match(chat.sendBlock({ conv: CONV, busy: false, me: GUEST, text: "hi" }), /Your Claude is not connected/);
  assert.match(chat.errorMessage({ code: "runner_offline", status: 503 }, GUEST), /Connect your Claude/);
  assert.match(chat.errorMessage({ code: "runner_offline", status: 503 }, { kind: "owner" }), /Start it on the server/);
});

test("the new refusals are said in plain words", function () {
  var e = function (code, status) { return chat.errorMessage({ code: code, status: status }, GUEST); };
  assert.match(e("board_required", 403), /Ops board once/);
  assert.match(e("board_disabled", 403), /switched off by the owner/);
  assert.match(e("edit_not_available", 400), /read-only/);
  assert.match(e("keys_full", 409), /two active keys/);
  assert.match(e("guests_full", 409), /full right now/);
  assert.match(e("label_invalid", 400), /short name/);
  assert.match(e("key_expired", 401), /expired/);
  assert.match(e(null, 403), /not open to you yet/);
  ["board_required", "keys_full", "guests_full"].forEach(function (c) { assert.ok(!/_/.test(e(c, 400)), "never the raw code: " + c); });
});

test("keys are described without ever showing the key", function () {
  var now = 100 * 86400000;
  var active = { id: "rk_aaaaaaaa", label: "Laptop", createdAt: now - 3 * 86400000, expiresAt: now + 87 * 86400000, lastUsed: now - 5 * 60000, revoked: false, expired: false };
  assert.strictEqual(chat.keyState(active, now), "Active");
  assert.strictEqual(chat.keyState(Object.assign({}, active, { revoked: true }), now), "Revoked");
  assert.strictEqual(chat.keyState(Object.assign({}, active, { expired: true }), now), "Expired");
  assert.strictEqual(chat.keyState(Object.assign({}, active, { expiresAt: now - 1 }), now), "Expired");
  assert.match(chat.keyLine(active, now), /^Made 3 d ago · expires \d+ \w{3} \d{4} · last used 5 min ago$/);
  assert.match(chat.keyLine(Object.assign({}, active, { lastUsed: null }), now), /not used yet/);
  assert.ok(chat.keyLine(Object.assign({}, active, { revoked: true }), now).indexOf("expires") < 0, "a revoked key has no expiry to show");
  assert.deepStrictEqual(chat.KEY_LIFETIMES.map(function (o) { return o[0]; }), [30, 90, 365]);
});

test("parseKit accepts only the exact shape, with the name carrying the checksum", function () {
  var sha = "602a242d" + "9".repeat(56);
  var good = { file: "guest-runner-602a242d.zip", sha256: sha, bytes: 61749 };
  assert.deepStrictEqual(chat.parseKit(good), { file: "guest-runner-602a242d.zip", sha256: sha, bytes: 61749 });
  assert.strictEqual(chat.parseKit(Object.assign({}, good, { bytes: "x" })).bytes, 0);
  [null, "x", {}, Object.assign({}, good, { file: "../evil.zip" }), Object.assign({}, good, { file: "guest-runner-602a242d.exe" }),
    Object.assign({}, good, { file: "https://evil.example/guest-runner-602a242d.zip" }), Object.assign({}, good, { sha256: "abc" }),
    Object.assign({}, good, { sha256: "deadbeef" + "9".repeat(56) }), Object.assign({}, good, { sha256: sha.toUpperCase() })
  ].forEach(function (bad) { assert.strictEqual(chat.parseKit(bad), null, JSON.stringify(bad)); });
  assert.strictEqual(chat.sizeText(61749), "60 KB");
  assert.strictEqual(chat.sizeText(3 * 1048576), "3.0 MB");
});

test("guest starters are plain questions that fit a read-only chat on their own folder", function () {
  assert.ok(chat.STARTERS_GUEST.length >= 3 && chat.STARTERS_GUEST.length <= 6);
  chat.STARTERS_GUEST.forEach(function (s) {
    assert.ok(s.length > 10 && s.length < 120 && !/[<>]/.test(s), s);
    assert.ok(!/Ops board|campaign|Knowledgebase/i.test(s), "no mention of the owner's things: " + s);
  });
});

test("the connect panel is built from DOM calls only, downloads only from this site, and shows the key in a field", function () {
  var js = read("chat.js");
  assert.ok(!/innerHTML\s*=/.test(js));
  assert.ok(js.indexOf('dl.href = "guest-runner/"') >= 0, "the download link is a relative path on this site");
  assert.ok(js.indexOf("chat-key-field") >= 0 && js.indexOf("readOnly = true") >= 0);
  var html = read("chat.html");
  assert.ok(/<p id="chat-intro">/.test(html), "the intro can be reworded for a guest");
  assert.ok(/connect-src 'self' https:\/\/api\.barnyard\.site wss:\/\/api\.barnyard\.site;/.test(html), "the page still talks only to this site and the Worker");
});

function readZipEntries(buf) {
  var end = buf.length - 22;
  assert.strictEqual(buf.readUInt32LE(end), 0x06054b50, "a zip");
  var count = buf.readUInt16LE(end + 10), p = buf.readUInt32LE(end + 16), out = [];
  for (var i = 0; i < count; i++) {
    var nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    var local = buf.readUInt32LE(p + 42), size = buf.readUInt32LE(p + 24);
    var dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nameLen), data: buf.slice(dataStart, dataStart + size) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test("the published runner download is the one the manifest names, its checksum is right, and it holds no secret", function () {
  var crypto = require("crypto");
  var m = JSON.parse(read("guest-runner/guest-runner.json"));
  var kit = chat.parseKit(m);
  assert.ok(kit, "the manifest has the shape the page accepts");
  var zipBuf = fs.readFileSync(path.join(root, "guest-runner", kit.file));
  assert.strictEqual(crypto.createHash("sha256").update(zipBuf).digest("hex"), kit.sha256);
  assert.strictEqual(zipBuf.length, m.bytes);
  var files = readZipEntries(zipBuf);
  var names = files.map(function (f) { return f.name; });
  ["Dockerfile", "docker-compose.yml", "README.md", "bin/runner.js", "src/config.js", "image/chat-system-guest.md"].forEach(function (n) { assert.ok(names.indexOf(n) >= 0, n); });
  files.forEach(function (f) {
    var text = f.data.toString("utf8");
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|cr_[0-9a-f]{32}_[A-Za-z0-9_-]{43}|ob_[0-9a-f]{32}_[A-Za-z0-9_-]{43}/.test(text), f.name);
  });
  var compose = files.filter(function (f) { return f.name === "docker-compose.yml"; })[0].data.toString("utf8");
  assert.ok(/RUNNER_PROFILE: guest/.test(compose) && /:\/workspace\/shared:ro/.test(compose));
  var zips = fs.readdirSync(path.join(root, "guest-runner")).filter(function (n) { return /\.zip$/.test(n); });
  assert.deepStrictEqual(zips, [kit.file], "only the current download is kept");
});

console.log("\n" + passed + " tests passed");
