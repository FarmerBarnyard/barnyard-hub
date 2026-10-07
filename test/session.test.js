// Coverage for "who is signed in" in themes.js (BarnyardTheme.who): reading
// /auth/session, what a page may hide because of it, and that it fails open.
//
//   node test/session.test.js
//
// Runs themes.js against a fake fetch and fake storage; nothing touches the network.

var assert = require("assert");
var path = require("path");
var THEMES_JS = path.join(__dirname, "..", "themes.js");
var Overview = require(path.join(__dirname, "..", "overview.js"));

var queue = [];
function test(name, fn) { queue.push([name, fn]); }

// A fresh themes.js running against fake browser globals. `respond(n)` answers the
// n-th request to /auth/session with { status, json }, or a promise of one, or throws.
function fresh(opts) {
  opts = opts || {};
  var session = {}, calls = [], g = globalThis, saved = {};
  function def(key, value) {
    if (!(key in saved)) saved[key] = Object.getOwnPropertyDescriptor(g, key);
    Object.defineProperty(g, key, { value: value, configurable: true, writable: true });
  }
  if (opts.cache) session["barnyard-session"] = JSON.stringify(opts.cache);
  def("location", { hostname: opts.host || "dashboard.barnyard.site" });
  def("localStorage", { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
  def("sessionStorage", {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(session, k) ? session[k] : null; },
    setItem: function (k, v) { session[k] = String(v); },
    removeItem: function (k) { delete session[k]; }
  });
  def("fetch", function (url, init) {
    calls.push({ url: url, init: init });
    var r = opts.respond ? opts.respond(calls.length) : { status: 401, json: { authenticated: false } };
    return Promise.resolve(r).then(function (x) {
      return { status: x.status, ok: x.status >= 200 && x.status < 300, json: function () { return x.badJson ? Promise.reject(new Error("bad json")) : Promise.resolve(x.json); } };
    });
  });
  delete require.cache[require.resolve(THEMES_JS)];
  var Theme = require(THEMES_JS);
  var seen = [];
  Theme.who.onChange(function (s) { seen.push(s); });
  return {
    Theme: Theme, calls: calls, seen: seen, stored: function () { return session["barnyard-session"] ? JSON.parse(session["barnyard-session"]) : null; },
    flush: function () { return new Promise(function (r) { setImmediate(function () { setImmediate(r); }); }); },
    done: function () {
      Object.keys(saved).forEach(function (k) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; });
      delete require.cache[require.resolve(THEMES_JS)];
    }
  };
}

var ok = function (json) { return { status: 200, json: json }; };
var GUEST = { authenticated: true, email: "g@example.com", name: "G", owner: false, apps: ["hub"] };
var OWNER = { authenticated: true, email: "o@example.com", name: "O", owner: true, apps: ["hub", "study", "campaign"] };

// ---- the pure rules -------------------------------------------------------------

test("allows: unknown or signed-out sessions see everything; the owner sees everything", function () {
  var T = fresh().Theme;
  assert.strictEqual(T.who.allows(null, "study"), true);
  assert.strictEqual(T.who.allows({ authenticated: false }, "study"), true);
  assert.strictEqual(T.who.allows({ authenticated: true, owner: true, apps: [] }, "study"), true);
  assert.strictEqual(T.who.allows({ authenticated: true, owner: null, apps: null }, "study"), true, "apps unknown: fail open");
  assert.strictEqual(T.who.allows(GUEST, undefined), true, "a page with no app requirement is always allowed");
});

test("allows: a signed-in person sees only the apps their groups allow", function () {
  var T = fresh().Theme;
  assert.strictEqual(T.who.allows(GUEST, "study"), false);
  assert.strictEqual(T.who.allows(GUEST, "campaign"), false);
  assert.strictEqual(T.who.allows({ authenticated: true, owner: false, apps: ["hub", "campaign"] }, "campaign"), true);
  assert.strictEqual(T.who.allows({ authenticated: true, owner: false, apps: ["hub", "campaign"] }, "study"), false);
  assert.strictEqual(T.who.allows({ authenticated: true, owner: null, apps: ["hub"] }, "study"), false, "also while the owner is not yet configured");
});

test("isGuest: only a signed-in person who is definitely not the owner", function () {
  var T = fresh().Theme;
  assert.strictEqual(T.who.isGuest(GUEST), true);
  assert.strictEqual(T.who.isGuest(OWNER), false);
  assert.strictEqual(T.who.isGuest({ authenticated: true, owner: null }), false, "unknown is not a guest");
  assert.strictEqual(T.who.isGuest({ authenticated: false }), false);
  assert.strictEqual(T.who.isGuest(null), false);
});

test("clean: keeps only the three fields, tidies apps, never trusts odd shapes", function () {
  var T = fresh().Theme;
  assert.deepStrictEqual(T.who.clean({ authenticated: true, owner: false, apps: ["hub", 5, "x".repeat(50), null, "study"], email: "x", sub: "secret" }), { authenticated: true, owner: false, apps: ["hub", "study"] });
  assert.deepStrictEqual(T.who.clean({ authenticated: true, owner: "yes", apps: "hub" }), { authenticated: true, owner: null, apps: null });
  assert.deepStrictEqual(T.who.clean({ authenticated: "true" }), { authenticated: false });
  assert.deepStrictEqual(T.who.clean(null), { authenticated: false });
  assert.strictEqual(T.who.clean({ authenticated: true, apps: new Array(40).fill("a") }).apps.length, 10);
});

// ---- loading it -------------------------------------------------------------------

test("load: a guest session is read, cleaned, remembered for a minute and announced", async function () {
  var f = fresh({ respond: function () { return ok(GUEST); } });
  f.Theme.who.load();
  await f.flush();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].url, "https://api.barnyard.site/auth/session");
  assert.strictEqual(f.calls[0].init.credentials, "include");
  assert.deepStrictEqual(f.Theme.who.get(), { authenticated: true, owner: false, apps: ["hub"] });
  assert.ok(!("email" in f.Theme.who.get()), "no email is kept");
  assert.strictEqual(f.seen.length, 1);
  assert.ok(f.stored() && f.stored().t > 0);
  f.done();
});

test("load: a second page within the minute uses the remembered answer, with no request", async function () {
  var f = fresh({ cache: { t: Date.now() - 5000, data: { authenticated: true, owner: false, apps: ["hub"] } }, respond: function () { return ok(OWNER); } });
  f.Theme.who.load();
  await f.flush();
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(f.Theme.who.isGuest(f.Theme.who.get()), true);
  f.done();
});

test("load: an answer older than a minute is ignored and asked again", async function () {
  var f = fresh({ cache: { t: Date.now() - 120000, data: { authenticated: true, owner: false, apps: ["hub"] } }, respond: function () { return ok(OWNER); } });
  f.Theme.who.load();
  await f.flush();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.Theme.who.get().owner, true);
  f.done();
});

test("load: signed out is announced but not remembered (so signing in is noticed at once)", async function () {
  var f = fresh({ respond: function () { return { status: 401, json: { authenticated: false } }; } });
  f.Theme.who.load();
  await f.flush();
  assert.deepStrictEqual(f.Theme.who.get(), { authenticated: false });
  assert.strictEqual(f.stored(), null);
  f.done();
});

test("load: it fails open: a server error, bad JSON or a network failure leaves the session unknown", async function () {
  var cases = [
    function () { return { status: 500, json: {} }; },
    function () { return { status: 200, badJson: true }; },
    function () { throw new Error("offline"); }
  ];
  for (var i = 0; i < cases.length; i++) {
    var f = fresh({ respond: cases[i] });
    // a throwing fetch is a rejected promise from the page's point of view
    if (i === 2) globalThis.fetch = function () { return Promise.reject(new Error("offline")); };
    f.Theme.who.load();
    await f.flush();
    assert.strictEqual(f.Theme.who.get(), null, "case " + i);
    assert.strictEqual(f.seen.length, 0);
    assert.strictEqual(f.Theme.who.allows(f.Theme.who.get(), "study"), true, "and nothing is hidden");
    f.done();
  }
});

test("load: off barnyard.site (localhost, previews) nothing is requested", async function () {
  var f = fresh({ host: "localhost" });
  f.Theme.who.load();
  await f.flush();
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(f.Theme.who.get(), null);
  f.done();
});

test("load: two calls at once make one request", async function () {
  var f = fresh({ respond: function () { return ok(GUEST); } });
  f.Theme.who.load();
  f.Theme.who.load();
  await f.flush();
  assert.strictEqual(f.calls.length, 1);
  f.done();
});

test("onChange: called straight away when the session is already known, and survives a throwing listener", async function () {
  var f = fresh({ respond: function () { return ok(OWNER); } });
  f.Theme.who.load();
  await f.flush();
  var late = [];
  f.Theme.who.onChange(function (s) { late.push(s); });
  assert.strictEqual(late.length, 1);
  f.Theme.who.onChange(function () { throw new Error("listener bug"); });
  assert.strictEqual(late.length, 1);
  f.done();
});

// ---- what the Overview hides --------------------------------------------------------

test("widgetRestricted: the owner's calendar and shortcuts are hidden from a guest only", function () {
  assert.deepStrictEqual(Overview.OWNER_ONLY.slice().sort(), ["links", "week"]);
  assert.strictEqual(Overview.widgetRestricted("week", GUEST), true);
  assert.strictEqual(Overview.widgetRestricted("links", GUEST), true);
  ["need", "feed", "flight", "market", "weather", "todo"].forEach(function (id) {
    assert.strictEqual(Overview.widgetRestricted(id, GUEST), false, id + " stays for a guest");
  });
  assert.strictEqual(Overview.widgetRestricted("week", OWNER), false);
  assert.strictEqual(Overview.widgetRestricted("week", { authenticated: true, owner: null }), false, "owner not known: nothing hidden");
  assert.strictEqual(Overview.widgetRestricted("week", { authenticated: false }), false);
  assert.strictEqual(Overview.widgetRestricted("week", null), false);
});

// ---- run ---------------------------------------------------------------------------------

(async function () {
  var passed = 0;
  for (var i = 0; i < queue.length; i++) {
    await queue[i][1]();
    passed++;
    console.log("ok - " + queue[i][0]);
  }
  console.log("\n" + passed + " tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });
