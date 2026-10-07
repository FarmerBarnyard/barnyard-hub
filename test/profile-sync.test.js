// Coverage for the profile sync in themes.js (BarnyardTheme.sync): the pure
// decision about what to do with the saved profile, and the engine around it
// (upload, adopt, debounce, retry, sign-out, forget) against a fake fetch,
// fake storage and fake timers. Nothing here touches the network.
//
//   node test/profile-sync.test.js

var assert = require("assert");
var path = require("path");
var THEMES_JS = path.join(__dirname, "..", "themes.js");

var queue = [];
function test(name, fn) { queue.push([name, fn]); }

var OWNER_A = "aaaaaaaaaaaa", OWNER_B = "bbbbbbbbbbbb";

// A fresh copy of themes.js running against fake browser globals. The fake
// fetch answers from `opts.respond(method, body, n)` (a {status, json} object,
// or a promise of one); every request is recorded in `calls`.
function fresh(opts) {
  opts = opts || {};
  var store = {}, timers = [], calls = [], g = globalThis, saved = {};
  function def(key, value) {
    if (!(key in saved)) saved[key] = Object.getOwnPropertyDescriptor(g, key);
    Object.defineProperty(g, key, { value: value, configurable: true, writable: true });
  }
  if (opts.state) store["barnyard-sync"] = JSON.stringify(opts.state);
  if (opts.settings) store["barnyard-settings"] = JSON.stringify(opts.settings);
  def("location", { hostname: opts.host || "dashboard.barnyard.site" });
  def("localStorage", {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  });
  def("setTimeout", function (fn, ms) { timers.push({ fn: fn, ms: ms, live: true }); return timers.length; });
  def("clearTimeout", function (id) { if (id && timers[id - 1]) timers[id - 1].live = false; });
  def("fetch", function (url, init) {
    var body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: url, method: init.method, body: body, init: init });
    var r = opts.respond ? opts.respond(init.method, body, calls.length) : { status: 401, json: { authenticated: false } };
    return Promise.resolve(r).then(function (x) { return { status: x.status, json: function () { return Promise.resolve(x.json); } }; });
  });
  delete require.cache[require.resolve(THEMES_JS)];
  var Theme = require(THEMES_JS);
  var statuses = [], adopted = [];
  Theme.sync.onStatus(function (s) { statuses.push(s); });
  Theme.sync.onAdopt(function (i) { adopted.push(i); });
  return {
    Theme: Theme, calls: calls, statuses: statuses, adopted: adopted,
    state: function () { return JSON.parse(store["barnyard-sync"] || "{}"); },
    stored: function () { return JSON.parse(store["barnyard-settings"] || "null"); },
    live: function () { return timers.filter(function (t) { return t.live; }); },
    fire: function () { var t = timers.filter(function (x) { return x.live; }).pop(); t.live = false; return t.fn(); },
    puts: function () { return calls.filter(function (c) { return c.method === "PUT"; }); },
    done: function () {
      Object.keys(saved).forEach(function (k) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; });
      delete require.cache[require.resolve(THEMES_JS)];
    }
  };
}

function profile(over) {
  return Object.assign({ exists: true, rev: 3, updatedAt: 5000, owner: OWNER_A, settings: { theme: "plum", mode: "light", density: "compact" } }, over || {});
}
function ok(json) { return { status: 200, json: json }; }

// ---- the pure decision --------------------------------------------------------

test("decide: nothing saved, nothing customised, nothing pending -> do nothing (never upload defaults)", function () {
  var T = fresh().Theme;
  assert.strictEqual(T.sync.decide(T.defaults(), {}, { exists: false }), "none");
});
test("decide: nothing saved but this browser has a look (or unsent changes) -> upload", function () {
  var T = fresh().Theme;
  assert.strictEqual(T.sync.decide(T.normalize({ theme: "rose" }), {}, { exists: false }), "upload");
  assert.strictEqual(T.sync.decide(T.defaults(), { dirty: true }, { exists: false }), "upload");
});
test("decide: a profile that was synced here and is now gone was deleted elsewhere -> forget, do not re-upload", function () {
  var T = fresh().Theme;
  assert.strictEqual(T.sync.decide(T.normalize({ theme: "rose" }), { rev: 4, owner: OWNER_A }, { exists: false }), "forgotten");
  assert.strictEqual(T.sync.decide(T.normalize({ theme: "rose" }), { rev: 4, owner: OWNER_A, dirty: true }, { exists: false }), "upload");
});
test("decide: first time this account is seen here -> the profile wins (or just record it if identical)", function () {
  var T = fresh().Theme, p = profile();
  assert.strictEqual(T.sync.decide(T.defaults(), {}, p), "adopt-first");
  assert.strictEqual(T.sync.decide(T.normalize({ theme: "rose" }), { rev: 3, owner: OWNER_B }, p), "adopt-first", "a different person signed in on this browser");
  assert.strictEqual(T.sync.decide(T.normalize(p.settings), {}, p), "record");
});
test("decide: same account, same revision -> nothing, unless there are unsent changes", function () {
  var T = fresh().Theme, p = profile();
  assert.strictEqual(T.sync.decide(T.defaults(), { rev: 3, owner: OWNER_A }, p), "none");
  assert.strictEqual(T.sync.decide(T.defaults(), { rev: 3, owner: OWNER_A, dirty: true }, p), "upload");
});
test("decide: another browser saved a newer revision -> adopt, unless a later change here is unsent and newer", function () {
  var T = fresh().Theme, p = profile({ rev: 4, updatedAt: 5000 });
  assert.strictEqual(T.sync.decide(T.defaults(), { rev: 3, owner: OWNER_A }, p), "adopt");
  assert.strictEqual(T.sync.decide(T.defaults(), { rev: 3, owner: OWNER_A, dirty: true, changedAt: 4000 }, p), "adopt", "the profile is newer than the unsent change");
  assert.strictEqual(T.sync.decide(T.defaults(), { rev: 3, owner: OWNER_A, dirty: true, changedAt: 6000 }, p), "upload", "the unsent change is newer");
});

// ---- the engine ---------------------------------------------------------------

test("off barnyard.site (localhost, previews) nothing is ever sent", async function () {
  var f = fresh({ host: "localhost" });
  f.Theme.sync.start();
  f.Theme.set({ theme: "rose" });
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(f.live().length, 0, "no push is scheduled");
  assert.strictEqual(f.Theme.sync.status(), "off");
  f.done();
});

test("signed out: one check, a 'signed-out' status, and later changes send nothing", async function () {
  var f = fresh();
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.sync.status(), "signed-out");
  f.Theme.set({ theme: "rose" });
  assert.strictEqual(f.live().length, 0, "no push timer while signed out");
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].method, "GET");
  assert.strictEqual(f.calls[0].url, "https://api.barnyard.site/prefs");
  assert.strictEqual(f.calls[0].init.credentials, "include");
  assert.strictEqual(f.state().dirty, true, "the change is remembered for after sign-in");
  f.done();
});

test("a brand-new browser with nothing saved stays quiet: no upload of defaults", async function () {
  var f = fresh({ respond: function () { return ok({ exists: false }); } });
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.sync.status(), "unsaved");
  assert.strictEqual(f.puts().length, 0);
  f.done();
});

test("a customised browser with nothing saved uploads once, and remembers the revision and account", async function () {
  var f = fresh({ settings: { theme: "rose", mode: "dark" }, respond: function (m) { return m === "GET" ? ok({ exists: false }) : ok({ rev: 1, updatedAt: 9000, owner: OWNER_A }); } });
  f.Theme.load();
  await f.Theme.sync.pull();
  assert.strictEqual(f.puts().length, 1);
  assert.strictEqual(f.puts()[0].body.settings.theme, "rose");
  assert.deepStrictEqual(Object.keys(f.puts()[0].body), ["settings"], "nothing but the settings is sent");
  assert.strictEqual(f.Theme.sync.status(), "saved");
  assert.deepStrictEqual([f.state().rev, f.state().owner, f.state().dirty], [1, OWNER_A, false]);
  f.done();
});

test("first sight of an account with a saved profile: the profile is applied, announced, and not echoed back", async function () {
  var f = fresh({ settings: { theme: "rose" }, respond: function () { return ok(profile()); } });
  f.Theme.load();
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.get().theme, "plum");
  assert.strictEqual(f.Theme.get().mode, "light");
  assert.strictEqual(f.stored().theme, "plum", "also saved in this browser");
  assert.strictEqual(f.adopted.length, 1);
  assert.strictEqual(f.adopted[0].first, true);
  assert.strictEqual(f.adopted[0].previous.theme, "rose", "the earlier look is offered back");
  assert.strictEqual(f.puts().length, 0, "adopting must not upload");
  assert.strictEqual(f.live().length, 0);
  assert.deepStrictEqual([f.state().rev, f.state().owner, !!f.state().dirty], [3, OWNER_A, false]);
  f.done();
});

test("'Keep this browser's' is an ordinary change: it goes up and replaces the profile", async function () {
  var seen = [];
  var f = fresh({ settings: { theme: "rose" }, respond: function (m, b) { if (m === "PUT") { seen.push(b); return ok({ rev: 4, updatedAt: 9100, owner: OWNER_A }); } return ok(profile()); } });
  f.Theme.load();
  await f.Theme.sync.pull();
  f.Theme.set(f.adopted[0].previous);
  assert.strictEqual(f.live().length, 1, "a save is scheduled");
  await f.Theme.sync.flush();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].settings.theme, "rose");
  assert.strictEqual(f.state().rev, 4);
  f.done();
});

test("changes are saved together after a pause, not one request each", async function () {
  var f = fresh({ state: { rev: 1, owner: OWNER_A }, respond: function (m) { return m === "PUT" ? ok({ rev: 2, updatedAt: 9000, owner: OWNER_A }) : ok(profile({ rev: 1, settings: {} })); } });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  f.Theme.set({ density: "compact" });
  f.Theme.set({ bg: "grid" });
  assert.strictEqual(f.live().length, 1, "each change replaces the pending save");
  assert.strictEqual(f.live()[0].ms, 1500);
  await f.fire();
  assert.strictEqual(f.puts().length, 1);
  var sent = f.puts()[0].body.settings;
  assert.deepStrictEqual([sent.theme, sent.density, sent.bg], ["navy", "compact", "grid"]);
  assert.strictEqual(f.state().dirty, false);
  assert.strictEqual(f.state().rev, 2);
  f.done();
});

test("a change made while a save is in flight is saved next, and is not lost", async function () {
  var release, first = true;
  var f = fresh({
    state: { rev: 1, owner: OWNER_A },
    respond: function (m, b) {
      if (m === "GET") return ok(profile({ rev: 1, settings: {} }));
      if (first) { first = false; return new Promise(function (res) { release = function () { res(ok({ rev: 2, updatedAt: 9000, owner: OWNER_A })); }; }); }
      return ok({ rev: 3, updatedAt: 9500, owner: OWNER_A });
    }
  });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  var inflight = f.Theme.sync.flush();
  await Promise.resolve();
  f.Theme.set({ theme: "pine" });
  release();
  await inflight;
  assert.strictEqual(f.state().dirty, true, "the later change is still unsent");
  await f.fire();
  assert.strictEqual(f.puts().length, 2);
  assert.strictEqual(f.puts()[1].body.settings.theme, "pine");
  assert.strictEqual(f.state().dirty, false);
  f.done();
});

test("another browser saved a newer copy: it is applied quietly-announced, not echoed", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function () { return ok(profile({ rev: 4, settings: { theme: "olive" } })); } });
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.get().theme, "olive");
  assert.strictEqual(f.adopted[0].first, false);
  assert.strictEqual(f.puts().length, 0);
  assert.strictEqual(f.state().rev, 4);
  f.done();
});

test("a newer unsent change here beats an older saved copy and goes up", async function () {
  var f = fresh({
    state: { rev: 3, owner: OWNER_A, dirty: true, changedAt: 99999 }, settings: { theme: "rose" },
    respond: function (m) { return m === "PUT" ? ok({ rev: 5, updatedAt: 100000, owner: OWNER_A }) : ok(profile({ rev: 4, updatedAt: 5000, settings: { theme: "olive" } })); }
  });
  f.Theme.load();
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.get().theme, "rose");
  assert.strictEqual(f.puts().length, 1);
  assert.strictEqual(f.state().rev, 5);
  f.done();
});

test("a profile deleted on another browser is forgotten here, and this browser keeps its look", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, settings: { theme: "rose" }, respond: function () { return ok({ exists: false }); } });
  f.Theme.load();
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.get().theme, "rose");
  assert.strictEqual(f.puts().length, 0);
  assert.deepStrictEqual(f.state(), {});
  assert.strictEqual(f.Theme.sync.status(), "unsaved");
  f.done();
});

test("forget removes the saved profile and clears the sync state", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function (m) { return m === "DELETE" ? ok({ deleted: true }) : ok(profile({ settings: {} })); } });
  await f.Theme.sync.pull();
  assert.strictEqual(await f.Theme.sync.forget(), true);
  assert.strictEqual(f.calls[f.calls.length - 1].method, "DELETE");
  assert.deepStrictEqual(f.state(), {});
  assert.strictEqual(f.Theme.sync.status(), "unsaved");
  f.done();
});

test("a failed forget is reported and changes nothing", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function (m) { return m === "DELETE" ? { status: 503, json: {} } : ok(profile({ settings: {} })); } });
  await f.Theme.sync.pull();
  assert.strictEqual(await f.Theme.sync.forget(), false);
  assert.strictEqual(f.state().rev, 3);
  f.done();
});

test("server trouble is retried a few times, then the status says so; the browser keeps its changes", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function () { return { status: 503, json: {} }; } });
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.sync.status(), "retrying");
  for (var i = 0; i < 6; i++) { if (f.live().length) await f.fire(); }
  assert.strictEqual(f.Theme.sync.status(), "error");
  assert.strictEqual(f.live().length, 0, "it gives up rather than retrying forever");
  f.Theme.set({ theme: "navy" });
  assert.strictEqual(f.Theme.get().theme, "navy");
  f.done();
});

test("a network failure is treated like server trouble, not a crash", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A } });
  globalThis.fetch = function () { return Promise.reject(new Error("offline")); };
  await f.Theme.sync.pull();
  assert.strictEqual(f.Theme.sync.status(), "retrying");
  f.done();
});

test("a rejected save (400/413) is not retried", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function (m) { return m === "PUT" ? { status: 413, json: {} } : ok(profile({ settings: {} })); } });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  await f.Theme.sync.flush();
  assert.strictEqual(f.Theme.sync.status(), "error");
  assert.strictEqual(f.live().length, 0);
  f.done();
});

test("a used-up daily quota (429 daily_limit) is an error, not something to retry", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function (m) { return m === "PUT" ? { status: 429, json: { error: "daily_limit" } } : ok(profile({ settings: {} })); } });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  await f.Theme.sync.flush();
  assert.strictEqual(f.Theme.sync.status(), "error");
  assert.strictEqual(f.live().length, 0, "no retry timer");
  assert.strictEqual(f.puts().length, 1);
  assert.strictEqual(f.state().dirty, true, "the change is kept for tomorrow");
  f.done();
});

test("any other 429 is still retried", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function (m) { return m === "PUT" ? { status: 429, json: {} } : ok(profile({ settings: {} })); } });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  await f.Theme.sync.flush();
  assert.strictEqual(f.Theme.sync.status(), "retrying");
  assert.strictEqual(f.live().length, 1);
  f.done();
});

test("the Stocks site never calls the profile service (it is not a login origin)", async function () {
  var f = fresh({ host: "stocks.barnyard.site", respond: function () { return ok(profile()); } });
  f.Theme.sync.start();
  await f.Theme.sync.pull();
  await f.Theme.sync.flush();
  f.Theme.set({ theme: "navy" });
  await f.Theme.sync.flush();
  assert.strictEqual(f.calls.length, 0, "no request to api.barnyard.site at all");
  assert.strictEqual(f.Theme.sync.status(), "off");
  f.done();
});

test("if the session ends mid-save the status becomes signed-out and the change stays unsent", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function (m) { return m === "PUT" ? { status: 401, json: {} } : ok(profile({ settings: {} })); } });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  await f.Theme.sync.flush();
  assert.strictEqual(f.Theme.sync.status(), "signed-out");
  assert.strictEqual(f.state().dirty, true);
  f.done();
});

test("signing in after changes made while signed out uploads them (no profile yet)", async function () {
  var signedIn = false;
  var f = fresh({ respond: function (m) { return !signedIn ? { status: 401, json: {} } : m === "GET" ? ok({ exists: false }) : ok({ rev: 1, updatedAt: 9000, owner: OWNER_A }); } });
  await f.Theme.sync.pull();
  f.Theme.set({ theme: "navy" });
  signedIn = true;
  await f.Theme.sync.pull();
  assert.strictEqual(f.puts().length, 1);
  assert.strictEqual(f.puts()[0].body.settings.theme, "navy");
  assert.strictEqual(f.Theme.sync.status(), "saved");
  f.done();
});

test("the system dark-mode switching never counts as a change to save", async function () {
  var f = fresh({ state: { rev: 3, owner: OWNER_A }, respond: function () { return ok(profile({ rev: 3, settings: {} })); } });
  await f.Theme.sync.pull();
  assert.strictEqual(!!f.state().dirty, false);
  f.done();
});

// ---- run ----------------------------------------------------------------------

(async function () {
  var passed = 0;
  for (var i = 0; i < queue.length; i++) {
    await queue[i][1]();
    passed++;
    console.log("ok - " + queue[i][0]);
  }
  console.log("\n" + passed + " tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });
