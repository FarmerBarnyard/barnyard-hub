// Coverage for the API fallback in shell.js: when the API cannot be reached, a page shows the last data this browser
// fetched, with a banner, instead of an empty error. Reads only; nothing is replayed.
//
//   node test/api-fallback.test.js
//
// Plain Node, standard library only. shell.js exports its logic when loaded without a document.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var FB = require(path.join(root, "shell.js")).fallback;
var src = fs.readFileSync(path.join(root, "shell.js"), "utf8");
var css = fs.readFileSync(path.join(root, "shell.css"), "utf8");

var passed = 0, queue = Promise.resolve();
function test(name, fn) {
  queue = queue.then(function () { return fn(); }).then(function () { passed++; console.log("ok - " + name); });
}

var API = "https://api.barnyard.site";

function fakeStorage(limit) {
  var m = {}, size = 0;
  return {
    get length() { return Object.keys(m).length; },
    key: function (i) { return Object.keys(m)[i] || null; },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) {
      var next = size - (m[k] ? m[k].length : 0) + String(v).length;
      if (limit && next > limit) throw new Error("QuotaExceededError");
      m[k] = String(v); size = next;
    },
    removeItem: function (k) { if (m[k] != null) { size -= m[k].length; delete m[k]; } },
    raw: m
  };
}
function clockAt(t) { var c = function () { return c.t; }; c.t = t; return c; }

// ---- which calls are kept -----------------------------------------------------------------

test("only addresses on the API are touched, and the query string stays", function () {
  assert.strictEqual(FB.apiPath(API + "/ops/board?lane=all"), "/ops/board?lane=all");
  assert.strictEqual(FB.apiPath(API + "/ops/board#x"), "/ops/board");
  assert.strictEqual(FB.apiPath("https://example.com/ops/board"), null);
  assert.strictEqual(FB.apiPath("https://api.barnyard.site.evil.test/ops/board"), null);
  assert.strictEqual(FB.apiPath("https://api.barnyard.site"), null);
  assert.strictEqual(FB.apiPath({ url: API + "/x" }), null);
});

test("reads on the list are kept; writes, notes, chat, photos, keys, invites, shares and search never are", function () {
  ["/ops/board", "/planner/todos", "/reg/assets", "/mon/status", "/release/status", "/services/levels", "/kitchen/recipes", "/auth/session", "/hub/renewals", "/calendar/outlook?from=1"]
    .forEach(function (p) { assert.strictEqual(FB.isCacheable("GET", p), true, p); });
  assert.strictEqual(FB.isCacheable("POST", "/ops/board"), false);
  assert.strictEqual(FB.isCacheable("PATCH", "/planner/todos"), false);
  ["/notebook/notes", "/kb/articles", "/chat/conversations", "/kitchen/photo", "/hub/search?q=abc", "/mon/server-key", "/academy/invite", "/canvas/share",
    "/ops/pending-changes", "/auth/logout", "/users", "/vuln/list", "/m365/snapshot", "/reg/export", "/mon/reporter-token"]
    .forEach(function (p) { assert.strictEqual(FB.isCacheable("GET", p), false, p); });
  assert.strictEqual(FB.isCacheable("GET", undefined), false);
});

test("a Cloudflare 5xx is an outage; the app's own 500, 4xx and 2xx are not", function () {
  [502, 503, 504, 520, 522, 524, 530].forEach(function (s) { assert.strictEqual(FB.isDownStatus(s), true, String(s)); });
  [200, 204, 301, 401, 403, 404, 429, 500, 501].forEach(function (s) { assert.strictEqual(FB.isDownStatus(s), false, String(s)); });
});

test("only JSON objects and arrays are stored, and the sign-in answer only while it says signed in", function () {
  assert.strictEqual(FB.shouldStore("/ops/board", '{"items":[]}'), true);
  assert.strictEqual(FB.shouldStore("/ops/board", "[1]"), true);
  assert.strictEqual(FB.shouldStore("/ops/board", "<html>"), false);
  assert.strictEqual(FB.shouldStore("/ops/board", ""), false);
  assert.strictEqual(FB.shouldStore("/ops/board", "x".repeat(FB.MAX_ENTRY_CHARS + 1)), false);
  assert.strictEqual(FB.shouldStore("/auth/session", '{"authenticated":true,"name":"N"}'), true);
  assert.strictEqual(FB.shouldStore("/auth/session", '{"authenticated":false}'), false);
  assert.strictEqual(FB.sessionEnded("/auth/session", '{"authenticated":false}'), true);
  assert.strictEqual(FB.sessionEnded("/auth/session", '{"authenticated":true}'), false);
  assert.strictEqual(FB.sessionEnded("/ops/board", '{"authenticated":false}'), false);
});

// ---- the saved copy -------------------------------------------------------------------------

test("store: put, get, expire after 14 days, clear", function () {
  var st = fakeStorage(), c = clockAt(1000), s = FB.makeStore(st, c);
  assert.strictEqual(s.put("/ops/board", '{"a":1}'), true);
  assert.deepStrictEqual(s.get("/ops/board"), { t: 1000, body: '{"a":1}' });
  assert.strictEqual(s.get("/other"), null);
  c.t = 1000 + FB.MAX_AGE_MS - 1; assert.ok(s.get("/ops/board"));
  c.t = 1000 + FB.MAX_AGE_MS + 1; assert.strictEqual(s.get("/ops/board"), null);
  assert.strictEqual(s.count(), 0, "an expired entry is removed when it is read");
  s.put("/a", "{}"); s.put("/b", "{}"); st.setItem("unrelated", "keep");
  s.clear();
  assert.strictEqual(s.count(), 0);
  assert.strictEqual(st.getItem("unrelated"), "keep", "only its own keys are cleared");
});

test("store: never keeps more than the entry cap, oldest go first", function () {
  var st = fakeStorage(), c = clockAt(0), s = FB.makeStore(st, c);
  for (var i = 0; i < FB.MAX_ENTRIES + 10; i++) { c.t = i + 1; s.put("/ops/board?p=" + i, '{"i":' + i + "}"); }
  assert.strictEqual(s.count(), FB.MAX_ENTRIES);
  assert.strictEqual(s.get("/ops/board?p=0"), null);
  assert.ok(s.get("/ops/board?p=" + (FB.MAX_ENTRIES + 9)));
});

test("store: a full disk drops old entries and a still-failing write gives up quietly", function () {
  var st = fakeStorage(900), c = clockAt(0), s = FB.makeStore(st, c);
  for (var i = 0; i < 8; i++) { c.t = i + 1; s.put("/a/" + i, '{"v":"' + "x".repeat(40) + '"}'); }
  c.t = 100;
  assert.strictEqual(s.put("/new", '{"v":"y"}'), true, "made room by dropping the oldest");
  assert.ok(s.get("/new"));
  var tiny = FB.makeStore(fakeStorage(5), c);
  assert.strictEqual(tiny.put("/x", '{"a":1}'), false);
  var broken = FB.makeStore({ length: 0, key: function () { throw new Error("no"); }, getItem: function () { throw new Error("no"); }, setItem: function () { throw new Error("no"); }, removeItem: function () { throw new Error("no"); } }, c);
  assert.strictEqual(broken.put("/x", '{"a":1}'), false);
  assert.strictEqual(broken.get("/x"), null);
  broken.clear();
});

test("store: junk under its own prefix is ignored, not thrown on", function () {
  var st = fakeStorage(), s = FB.makeStore(st, clockAt(5));
  st.setItem(FB.PREFIX + "/bad", "not json");
  st.setItem(FB.PREFIX + "/bad2", '{"t":"x","b":1}');
  assert.strictEqual(s.get("/bad"), null);
  assert.strictEqual(s.get("/bad2"), null);
  assert.strictEqual(s.put("/ok", "{}"), true);
});

// ---- when the API counts as down --------------------------------------------------------------

test("monitor: two failures inside a minute mean down; one alone, or two far apart, do not; a good answer clears it", function () {
  var c = clockAt(0), m = FB.makeMonitor(c);
  assert.deepStrictEqual(m.fail(), { down: false, changed: false });
  c.t = FB.DOWN_WINDOW_MS + 1;
  assert.deepStrictEqual(m.fail(), { down: false, changed: false }, "the first one aged out");
  c.t += 1000;
  assert.deepStrictEqual(m.fail(), { down: true, changed: true });
  assert.deepStrictEqual(m.fail(), { down: true, changed: false });
  assert.strictEqual(m.isDown(), true);
  assert.deepStrictEqual(m.ok(), { down: false, changed: true });
  assert.deepStrictEqual(m.ok(), { down: false, changed: false });
  assert.deepStrictEqual(m.fail(), { down: false, changed: false }, "counting starts again after a good answer");
});

test("banner and age wording", function () {
  assert.strictEqual(FB.ageText(10 * 1000), "just now");
  assert.strictEqual(FB.ageText(5 * 60000), "5 min ago");
  assert.strictEqual(FB.ageText(3600000), "1 hour ago");
  assert.strictEqual(FB.ageText(3 * 3600000), "3 hours ago");
  assert.strictEqual(FB.ageText(86400000), "1 day ago");
  assert.strictEqual(FB.ageText(2 * 86400000), "2 days ago");
  assert.strictEqual(FB.ageText(-5), "just now");
  assert.strictEqual(FB.bannerText("down", 0, 1000), "Can't reach the Barnyard API right now. Changes are paused until it is back.");
  assert.strictEqual(FB.bannerText("down", 1000, 1000 + 7 * 60000), "Can't reach the Barnyard API right now. Showing the last data this browser saw (7 min ago). Changes are paused until it is back.");
  assert.strictEqual(FB.bannerText("back", 1000, 5000), "The API is back. Reload to see the current data.");
  assert.strictEqual(FB.bannerText("up", 0, 1), "");
});

// ---- the wrapped fetch, against a fake network --------------------------------------------------

function res(status, body, type) {
  return new Response(body, { status: status, headers: { "Content-Type": type || "application/json" } });
}
function rig(net) {
  var calls = [], events = { down: [], up: [], stale: [] };
  var c = clockAt(1000);
  var store = FB.makeStore(fakeStorage(), c), monitor = FB.makeMonitor(c);
  var real = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    calls.push({ url: url, method: (init && init.method) || "GET" });
    return net(url, init);
  };
  var f = FB.wrapFetch(real, store, monitor, {
    retryMs: 0,
    onDown: function (r) { events.down.push(r); }, onUp: function (r) { events.up.push(r); }, onStale: function (t) { events.stale.push(t); }
  });
  return { f: f, calls: calls, events: events, store: store, monitor: monitor, clock: c };
}
function settle() { return new Promise(function (r) { setTimeout(r, 5); }); }

test("fetch: a good read passes through unchanged and is saved for later", async function () {
  var r = rig(function () { return Promise.resolve(res(200, '{"items":[1]}')); });
  var out = await r.f(API + "/ops/board");
  assert.strictEqual(await out.text(), '{"items":[1]}', "the page still gets a readable body");
  await settle();
  assert.strictEqual(r.store.get("/ops/board").body, '{"items":[1]}');
});

test("fetch: other sites, writes and non-JSON are not saved, and writes are passed on untouched", async function () {
  var r = rig(function (url) { return Promise.resolve(url.indexOf("example.com") > -1 ? res(200, '{"x":1}') : res(200, "<p>hi</p>", "text/html")); });
  await r.f("https://example.com/ops/board");
  await r.f(API + "/ops/board", { method: "POST", body: "{}" });
  await r.f(API + "/planner/todos");
  await settle();
  assert.strictEqual(r.store.count(), 0);
  assert.strictEqual(r.calls.length, 3);
  assert.strictEqual(r.calls[1].method, "POST");
});

test("fetch: a read that fails twice in a row is an outage: the banner comes on and the saved copy is served at once", async function () {
  var up = true;
  var r = rig(function () { return up ? Promise.resolve(res(200, '{"items":["old"]}')) : Promise.reject(new TypeError("Failed to fetch")); });
  await r.f(API + "/ops/board"); await settle();
  up = false; r.clock.t = 2000;
  var before = r.calls.length;
  var old = await r.f(API + "/ops/board");
  assert.strictEqual(r.calls.length - before, 2, "tried once, then once more");
  assert.strictEqual(old.status, 200);
  assert.strictEqual(old.headers.get("X-Barnyard-Stale"), "1000", "marked with when it was fetched");
  assert.strictEqual(await old.text(), '{"items":["old"]}');
  assert.deepStrictEqual(r.events.stale, [1000]);
  assert.ok(r.events.down.some(function (e) { return e.changed && e.down; }));
  var again = await r.f(API + "/ops/board");
  assert.strictEqual(again.status, 200, "while down, later reads go straight to the copy");
});

test("fetch: a blip is absorbed: the retry works, so there is no banner and the page gets live data", async function () {
  var n = 0;
  var r = rig(function () { n++; return n === 1 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(res(200, '{"v":"live"}')); });
  r.store.put("/ops/board", '{"v":"old"}');
  var out = await r.f(API + "/ops/board");
  assert.strictEqual(await out.text(), '{"v":"live"}');
  assert.strictEqual(r.monitor.isDown(), false);
  assert.strictEqual(r.events.stale.length, 0);
});

test("fetch: a write that fails once is the page's own error: not retried, not an outage", async function () {
  var r = rig(function () { return Promise.reject(new TypeError("Failed to fetch")); });
  r.store.put("/planner/todos", '{"v":1}');
  await assert.rejects(function () { return r.f(API + "/planner/todos", { method: "PATCH", body: "{}" }); }, TypeError);
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.monitor.isDown(), false);
});

test("fetch: an outage with no saved copy still fails the way the page expects", async function () {
  var r = rig(function () { return Promise.reject(new TypeError("Failed to fetch")); });
  await assert.rejects(function () { return r.f(API + "/ops/board"); }, TypeError);
  await assert.rejects(function () { return r.f(API + "/ops/board"); }, TypeError);
  assert.strictEqual(r.monitor.isDown(), true);
  var st = await Promise.resolve(rig(function () { return Promise.resolve(res(522, "error")); }).f(API + "/ops/board"));
  assert.strictEqual(st.status, 522, "a 5xx with nothing saved is returned as it came");
});

test("fetch: a Cloudflare 522 counts as down and the saved copy is served", async function () {
  var mode = "ok";
  var r = rig(function () { return Promise.resolve(mode === "ok" ? res(200, '{"v":1}') : res(522, "Connection timed out", "text/html")); });
  await r.f(API + "/planner/todos"); await settle();
  mode = "down";
  var out = await r.f(API + "/planner/todos");
  assert.strictEqual(out.status, 200);
  assert.strictEqual(await out.text(), '{"v":1}');
  assert.strictEqual(out.headers.get("X-Barnyard-Stale"), "1000");
});

test("fetch: a write while down is never answered from the copy and never retried", async function () {
  var r = rig(function () { return Promise.reject(new TypeError("Failed to fetch")); });
  r.store.put("/planner/todos", '{"v":1}');
  await assert.rejects(function () { return r.f(API + "/planner/todos", { method: "POST", body: "{}" }); }, TypeError);
  await assert.rejects(function () { return r.f(API + "/planner/todos", { method: "POST", body: "{}" }); }, TypeError);
  assert.strictEqual(r.calls.length, 2, "each write was sent once");
  assert.strictEqual(r.events.stale.length, 0);
});

test("fetch: a request the page cancelled is not an outage", async function () {
  var r = rig(function () { var e = new Error("aborted"); e.name = "AbortError"; return Promise.reject(e); });
  for (var i = 0; i < 3; i++) await assert.rejects(function () { return r.f(API + "/ops/board"); }, { name: "AbortError" });
  assert.strictEqual(r.monitor.isDown(), false);
});

test("fetch: the app's own 500 and a 403 are not outages and are returned as they came", async function () {
  var r = rig(function () { return Promise.resolve(res(500, '{"error":"x"}')); });
  r.store.put("/ops/board", '{"v":1}');
  for (var i = 0; i < 3; i++) assert.strictEqual((await r.f(API + "/ops/board")).status, 500);
  assert.strictEqual(r.monitor.isDown(), false);
  assert.strictEqual(r.events.stale.length, 0);
});

test("fetch: recovery is reported on the first good answer", async function () {
  var mode = "down";
  var r = rig(function () { return mode === "down" ? Promise.reject(new TypeError("x")) : Promise.resolve(res(200, '{"v":2}')); });
  r.store.put("/ops/board", '{"v":1}');
  await r.f(API + "/ops/board").catch(function () {});
  await r.f(API + "/ops/board");
  mode = "up";
  await r.f(API + "/ops/board");
  assert.deepStrictEqual(r.events.up.filter(function (e) { return e.changed; }).length, 1);
  assert.strictEqual(r.monitor.isDown(), false);
});

test("fetch: signing out, a 401, or a signed-out answer wipes every saved copy", async function () {
  var next = res(200, '{"v":1}');
  var r = rig(function () { return Promise.resolve(next); });
  r.store.put("/ops/board", '{"v":1}'); r.store.put("/planner/todos", '{"v":1}');
  next = res(200, '{"ok":true}'); await r.f(API + "/auth/logout", { method: "POST" });
  assert.strictEqual(r.store.count(), 0, "logout");
  r.store.put("/ops/board", '{"v":1}');
  next = res(401, '{"error":"no"}'); await r.f(API + "/ops/board");
  assert.strictEqual(r.store.count(), 0, "401");
  r.store.put("/ops/board", '{"v":1}');
  next = res(200, '{"authenticated":false}'); await r.f(API + "/auth/session"); await settle();
  assert.strictEqual(r.store.count(), 0, "signed-out answer");
  next = res(200, '{"authenticated":true,"name":"N"}'); await r.f(API + "/auth/session"); await settle();
  assert.strictEqual(r.store.count(), 1, "a signed-in answer is kept so the page keeps its signed-in look");
});

test("fetch: a Request object is accepted as well as a string", async function () {
  var r = rig(function () { return Promise.resolve(res(200, '{"v":1}')); });
  await r.f(new Request(API + "/ops/board")); await settle();
  assert.ok(r.store.get("/ops/board"));
});

// ---- the page half: what the source must keep doing --------------------------------------------

test("shell.js: the banner is built with textContent, never innerHTML, and is announced politely", function () {
  var part = src.slice(src.indexOf("function installApiFallback"), src.indexOf("// ---- public API"));
  assert.ok(part.length > 400, "found the browser half");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(part), "no HTML strings");
  assert.ok(/textContent/.test(part));
  assert.ok(/aria-live", "polite"/.test(part));
  assert.ok(/role", "status"/.test(part));
});

test("shell.js: the wrapper is installed once, before the page's own scripts, and exposes apiStatus", function () {
  assert.ok(/window\.__barnyardFallback/.test(src));
  var call = src.indexOf("  installApiFallback();"), built = src.lastIndexOf("  build();");
  assert.ok(call > 0 && built > call, "installed before the shell is built");
  assert.ok(/apiStatus: function/.test(src));
});

test("shell.css: the banner is styled from the theme tokens and respects [hidden]", function () {
  assert.ok(/\.api-banner \{[^}]*var\(--alert\)/.test(css));
  assert.ok(/\.api-banner\[hidden\] \{ display: none; \}/.test(css));
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css.match(/\.api-banner \{[^}]*\}/)[0]), "no hard-coded colours on the banner");
});

queue.then(function () { console.log("\n" + passed + " passed"); }, function (e) { console.error(e); process.exit(1); });
