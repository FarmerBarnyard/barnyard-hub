// The sign-in gate (landing.js + landing.css): what a signed-out visitor sees, which pages carry it, and the rules that decide it.
//
//   node test/landing.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var root = path.join(__dirname, "..");
var G = require(path.join(root, "landing.js"));

var passed = 0;
var queue = [];
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function atest(name, fn) { queue.push({ name: name, fn: fn }); }
function read(f) { return fs.readFileSync(path.join(root, f), "utf8").split("\r\n").join("\n"); }

// The pages that stay open on purpose: the public share view, the privacy page, and the four old addresses that only forward
// to a Monitoring tab (which is gated).
var OPEN = ["view.html", "privacy.html", "incidents.html", "release.html", "reports.html", "services.html"];
var pages = fs.readdirSync(root).filter(function (f) { return /\.html$/.test(f); });
var gated = pages.filter(function (f) { return OPEN.indexOf(f) === -1; });

function head(html) { return html.slice(0, html.indexOf("</head>")); }

// ---- which pages carry the gate -------------------------------------------------------------------------------------------------

test("every page carries the gate, except the ones that are public on purpose", function () {
  assert.ok(gated.length >= 15, "found the pages: " + gated.length);
  gated.forEach(function (f) {
    var h = head(read(f));
    assert.ok(/<link rel="stylesheet" href="landing\.css\?v=[0-9a-f]{8}">/.test(h), f + " links landing.css in <head>");
    assert.ok(/<script src="landing\.js\?v=[0-9a-f]{8}"><\/script>/.test(h), f + " loads landing.js in <head>");
  });
});

test("landing.css comes after shell.css, and landing.js after themes.js (so the theme is set before the card is drawn)", function () {
  gated.forEach(function (f) {
    var h = head(read(f));
    assert.ok(h.indexOf('href="shell.css') !== -1 && h.indexOf('href="shell.css') < h.indexOf('href="landing.css'), f + ": shell.css before landing.css");
    assert.ok(h.indexOf('src="themes.js') !== -1 && h.indexOf('src="themes.js') < h.indexOf('src="landing.js'), f + ": themes.js before landing.js");
    assert.ok(h.indexOf('src="landing.js') < h.indexOf("<body") || h.indexOf("<body") === -1, f + ": the script is in the head, before any page content");
  });
});

test("the public pages do not carry it: the share view, the privacy page and the four forwarding pages", function () {
  OPEN.forEach(function (f) {
    assert.ok(pages.indexOf(f) !== -1, f + " exists");
    assert.ok(!/landing\.(js|css)/.test(read(f)), f + " has no gate");
  });
});

test("the forwarding pages still lead to a gated page", function () {
  ["incidents.html", "release.html", "reports.html", "services.html"].forEach(function (f) {
    assert.ok(/data-to="/.test(read(f)) && /legacy-redirect\.js/.test(read(f)), f);
  });
  assert.ok(gated.indexOf("monitoring.html") !== -1);
});

test("each gated page's policy lets the gate ask the API and nothing more: scripts and styles from this site only", function () {
  gated.forEach(function (f) {
    var csp = /Content-Security-Policy" content="([^"]+)"/.exec(read(f))[1];
    assert.ok(/connect-src[^;]*https:\/\/api\.barnyard\.site/.test(csp), f + " may reach the API");
    assert.ok(/script-src 'self'/.test(csp) && /style-src 'self'/.test(csp), f);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), f + " has no unsafe-inline or unsafe-eval");
  });
});

test("the gate files use no inline script or style and no way to turn text into markup", function () {
  var js = read("landing.js").split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.style\b|setAttribute\(["']style/.test(js));
  var addresses = js.match(/https?:\/\/[^"' )]+/g) || [];
  assert.deepStrictEqual(addresses.sort(), ["https://api.barnyard.site/auth/login", "https://api.barnyard.site/auth/session"], "the only addresses it names are the sign-in check and the sign-in page");
  var css = read("landing.css");
  assert.ok(!/@import|url\(/.test(css), "the stylesheet loads nothing else");
});

test("until the answer is in, the page body is hidden, and with no script nothing shows but one line", function () {
  var css = read("landing.css");
  assert.ok(/html:not\(\[data-landing="ok"\]\) body \{ display: none !important; \}/.test(css));
  assert.ok(/html:not\(\[data-landing\]\)::before/.test(css));
  assert.ok(/#bh-landing/.test(css));
});

// ---- the rules ----------------------------------------------------------------------------------------------------------------------

var NOW = 1800000000000, DAY = 86400000;

test("interpret: the session answer means in, out or unreachable", function () {
  assert.strictEqual(G.interpret(200, "application/json; charset=utf-8", { authenticated: true }), "in");
  assert.strictEqual(G.interpret(200, "application/json", { authenticated: false }), "out");
  assert.strictEqual(G.interpret(401, "", undefined), "out");
  assert.strictEqual(G.interpret(200, "text/html", { authenticated: true }), "unreachable", "not JSON");
  assert.strictEqual(G.interpret(200, "application/json", {}), "unreachable");
  assert.strictEqual(G.interpret(200, "application/json", { authenticated: "true" }), "unreachable", "only a real true counts");
  assert.strictEqual(G.interpret(200, "application/json", null), "unreachable");
  [500, 502, 503, 404, 0].forEach(function (s) { assert.strictEqual(G.interpret(s, "application/json", { authenticated: true }), "unreachable", String(s)); });
});

test("decide: signed in shows the page, signed out shows the card", function () {
  assert.strictEqual(G.decide("in", null, NOW), "show");
  assert.strictEqual(G.decide("out", NOW - 1000, NOW), "landing", "a remembered sign-in does not outvote a signed-out answer");
  assert.strictEqual(G.decide("out", null, NOW), "landing");
});

test("decide: when the answer cannot be read, only a browser signed in within 7 days gets the page", function () {
  assert.strictEqual(G.decide("unreachable", null, NOW), "landing", "a stranger is never let in by a failure");
  assert.strictEqual(G.decide("unreachable", NOW - 6 * DAY, NOW), "show");
  assert.strictEqual(G.decide("unreachable", NOW - 7 * DAY, NOW), "landing", "7 days is the end");
  assert.strictEqual(G.decide("unreachable", NOW - 30 * DAY, NOW), "landing");
  assert.strictEqual(G.decide("unreachable", NOW + DAY, NOW), "landing", "a time in the future counts for nothing");
  [NaN, Infinity, "5", undefined, {}].forEach(function (bad) { assert.strictEqual(G.decide("unreachable", bad, NOW), "landing", String(bad)); });
});

// ---- the script itself, run against a small fake page ------------------------------------------------------------------------------

function fakeEl(tag) {
  return {
    tag: tag, children: [], attrs: {}, className: "", id: "", href: "", textContent: "",
    setAttribute: function (k, v) { this.attrs[k] = String(v); }, getAttribute: function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    appendChild: function (c) { this.children.push(c); return c; },
    removeChild: function (c) { this.children.splice(this.children.indexOf(c), 1); return c; },
    get firstChild() { return this.children[0] || null; }
  };
}

// Runs landing.js in a fresh fake window. `answer` is what the session request does; `store` the localStorage contents.
function runGate(answer, store, href) {
  var storage = Object.assign({}, store || {});
  var html = fakeEl("html"), body = fakeEl("body");
  body.children.push(fakeEl("nav"), fakeEl("main"));
  var stops = 0, listeners = [];
  var sandbox = {
    document: {
      documentElement: html, body: body, readyState: "complete", title: "Ops board \u00b7 Barnyard",
      createElement: fakeEl, createTextNode: function (t) { var n = fakeEl("#text"); n.textContent = t; return n; },
      addEventListener: function (n, f) { listeners.push(n); }
    },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem: function (k, v) { storage[k] = String(v); }, removeItem: function (k) { delete storage[k]; }
    },
    location: { href: href || "https://dashboard.barnyard.site/ops.html#abc" },
    AbortController: function () { this.signal = {}; this.abort = function () {}; },
    stop: function () { stops++; },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    fetch: function (url, opts) { sandbox.calls.push({ url: url, opts: opts }); return answer(); },
    calls: []
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "landing.js"), "utf8"), sandbox);
  return { html: html, body: body, doc: sandbox.document, storage: storage, sandbox: sandbox, stops: function () { return stops; } };
}
function json(status, data, type) {
  return function () { return Promise.resolve({ status: status, ok: status >= 200 && status < 300, headers: { get: function () { return type === undefined ? "application/json" : type; } }, json: function () { return Promise.resolve(data); } }); };
}
function settle() { return new Promise(function (r) { setTimeout(r, 15); }); }

atest("signed in: the page is shown, the sign-in is remembered, and the question is the session check with the cookie", async function () {
  var g = runGate(json(200, { authenticated: true }));
  assert.strictEqual(g.html.attrs["data-landing"], "check", "hidden at once, before any answer");
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "ok");
  assert.ok(g.storage.bh_seen_auth && Math.abs(Number(g.storage.bh_seen_auth) - Date.now()) < 5000);
  assert.strictEqual(g.body.children.length, 2, "the page was not touched");
  var c = g.sandbox.calls[0];
  assert.strictEqual(c.url, "https://api.barnyard.site/auth/session");
  assert.strictEqual(c.opts.credentials, "include");
  assert.strictEqual(g.stops(), 0);
});

atest("signed out: only the card shows; the page's body is emptied, the title is plain, the flag is forgotten", async function () {
  var g = runGate(json(200, { authenticated: false }), { bh_seen_auth: String(Date.now() - 1000) });
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "out");
  assert.strictEqual(g.body.children.length, 0, "no menu, no widgets, nothing");
  assert.strictEqual(g.doc.title, "Barnyard");
  assert.strictEqual(g.storage.bh_seen_auth, undefined);
  assert.strictEqual(g.stops(), 1, "the rest of the page stops loading");
  var card = g.html.children[g.html.children.length - 1];
  assert.strictEqual(card.id, "bh-landing");
  var texts = card.children.map(function (c) { return c.children.length ? c.children.map(function (x) { return x.textContent; }).join("") : c.textContent; });
  assert.deepStrictEqual(texts, ["Barnyard.", "Sign in to continue.", "Sign in"]);
  var link = card.children[2];
  assert.strictEqual(link.href, "https://api.barnyard.site/auth/login?return_to=" + encodeURIComponent("https://dashboard.barnyard.site/ops.html#abc"));
  assert.ok(/\bbtn\b/.test(link.className));
});

atest("API down and no recent sign-in: the card (a failure never opens the page)", async function () {
  var g = runGate(function () { return Promise.reject(new Error("offline")); });
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "out");
  assert.strictEqual(g.body.children.length, 0);
});

atest("API down but signed in within 7 days: the page is shown, so the saved-data fallback still works", async function () {
  var flag = String(Date.now() - 2 * DAY);
  var g = runGate(function () { return Promise.reject(new Error("offline")); }, { bh_seen_auth: flag });
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "ok");
  assert.strictEqual(g.body.children.length, 2);
  assert.strictEqual(g.storage.bh_seen_auth, flag, "a failure does not refresh the flag, so it still runs out after 7 days");
});

atest("API down and a flag older than 7 days: the card", async function () {
  var g = runGate(json(503, { authenticated: true }), { bh_seen_auth: String(Date.now() - 9 * DAY) });
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "out");
});

atest("an answer that is not the session JSON (an error page) counts as unreachable, not as signed in", async function () {
  var g = runGate(json(200, { authenticated: true }, "text/html"));
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "out");
});

atest("a 401 means signed out", async function () {
  var g = runGate(json(401, null), { bh_seen_auth: String(Date.now() - 1000) });
  await settle();
  assert.strictEqual(g.html.attrs["data-landing"], "out");
  assert.strictEqual(g.storage.bh_seen_auth, undefined);
});

(async function () {
  for (var i = 0; i < queue.length; i++) {
    await queue[i].fn();
    passed++;
    console.log("ok - " + queue[i].name);
  }
  console.log(passed + " passed");
})().catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
