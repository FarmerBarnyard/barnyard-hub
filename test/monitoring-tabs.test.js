// Services, Incidents, Reports and the Release board are tabs of the Monitoring page (monitoring.html). This checks the pieces
// around that move: the old addresses redirect, the menu no longer lists the four but the search still finds them, no link in the
// site still points at an old address, the CSS cannot leak between tabs, and each tab's script starts and stops cleanly (a closed
// tab reads and polls nothing). The tab logic itself (who sees which tab, hash routing, keys) is in test/monitoring.test.js.
//
//   node test/monitoring-tabs.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var root = path.join(__dirname, "..");

var queue = [];
var passed = 0;
function test(name, fn) { queue.push({ name: name, fn: fn }); }
function read(f) { return fs.readFileSync(path.join(root, f), "utf8"); }
function code(s) { return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); }

var TABS = ["services", "incidents", "reports", "release"];

// ---- the old addresses -----------------------------------------------------------------------------------------------

var Redirect = require("../legacy-redirect.js");

test("each old page is a redirect: no shell, strict CSP, names its tab, and has a no-script fallback and a plain link", function () {
  TABS.forEach(function (t) {
    var html = read(t + ".html");
    assert.ok(new RegExp('<body[^>]*data-shell="monitor"[^>]*data-to="' + t + '"').test(html), t + ": data-shell monitor, data-to " + t);
    assert.ok(/script-src 'self'/.test(html) && !/unsafe-inline/.test(html) && !/<script>[^<]/.test(html) && !/\son[a-z]+=/.test(html), t + ": strict page");
    assert.ok(html.indexOf("legacy-redirect.js") > -1, t + ": loads the redirect script");
    assert.ok(!/shell\.js|shell\.css|auth-gate/.test(html), t + ": no shell, nothing to flash before the redirect");
    assert.ok(new RegExp('<noscript><meta http-equiv="refresh" content="0; url=monitoring\\.html#' + t + '"></noscript>').test(html), t + ": no-script fallback");
    assert.ok(new RegExp('<a href="monitoring\\.html#' + t + '">').test(html), t + ": a plain link");
  });
});

test("the redirect keeps an incident's id and a plain query string, and drops anything odd", function () {
  assert.strictEqual(Redirect.target("services", "", ""), "monitoring.html#services");
  assert.strictEqual(Redirect.target("reports", "", "#whatever"), "monitoring.html#reports");
  assert.strictEqual(Redirect.target("release", "?x=1", ""), "monitoring.html?x=1#release");
  assert.strictEqual(Redirect.target("incidents", "", ""), "monitoring.html#incidents");
  assert.strictEqual(Redirect.target("incidents", "", "#inc_abcd1234"), "monitoring.html#incidents/inc_abcd1234", "the old incident address");
  assert.strictEqual(Redirect.target("incidents", "", "#incidents/inc_abcd1234"), "monitoring.html#incidents/inc_abcd1234");
  assert.strictEqual(Redirect.target("incidents", "?id=1", "#inc_abcd1234"), "monitoring.html?id=1#incidents/inc_abcd1234");
  assert.strictEqual(Redirect.target("services", "", "#inc_abcd1234"), "monitoring.html#services", "an id only means something on Incidents");
  ["#inc_ABCD1234", "#inc_abcd123", "#inc_abcd1234/../x", "#javascript:alert(1)", "#//evil.example"].forEach(function (h) {
    assert.strictEqual(Redirect.target("incidents", "", h), "monitoring.html#incidents", h);
  });
  ["?a=<b>", "?//evil.example/", "?a=b c", "?"].forEach(function (q) { assert.strictEqual(Redirect.target("services", q, ""), "monitoring.html#services", q); });
  assert.strictEqual(Redirect.target("nonsense", "", ""), "monitoring.html#dashboard");
  assert.strictEqual(Redirect.target(null, "", ""), "monitoring.html#dashboard");
  assert.ok(!/innerHTML|document\.write|eval\(/.test(code(read("legacy-redirect.js"))));
});

// ---- the menu and the search -------------------------------------------------------------------------------------------

test("the menu no longer lists the four, but each is still a page entry the search and Ctrl+K find, owner only with its permission", function () {
  var shell = read("shell.js");
  TABS.forEach(function (t) {
    var it = (shell.match(new RegExp('\\{ id: "' + t + '"[^}]*\\}')) || [""])[0];
    assert.ok(it, t + ": still in PAGES");
    assert.ok(/nav: false/.test(it), t + ": not in the menu");
    assert.ok(/ownerOnly: true/.test(it) && new RegExp('perm: "' + t + '\\.view"').test(it), t + ": owner only, own permission");
    assert.ok(new RegExp('path: "monitoring\\.html#' + t + '", local: "monitoring\\.html#' + t + '"').test(it), t + ": points at its tab");
    assert.ok(/hint: "Monitoring"/.test(it) && /keywords: "[^"]+"/.test(it), t + ": says where it lives and keeps keywords");
    assert.ok(new RegExp(t + "\\\\.html\\$").test(shell) === false, t + ": the shell no longer guesses a page name from the old address");
  });
  assert.ok(/release[^"]*"[^}]*keywords: "releases deploys deployments ci tests pull requests rollback main red github"/.test(shell.match(/\{ id: "release"[^}]*\}/)[0]) || /keywords: "releases deploys deployments ci tests pull requests rollback main red github"/.test(shell), "the Release board keeps the words it had");
  var build = shell.slice(shell.indexOf("PAGES.forEach(function (p) {\n      if (p.nav === false) return;"));
  assert.ok(build.length > 0, "the menu builder skips an entry marked nav: false");
  assert.ok(/p\.hint \|\| p\.group \|\| "Page"/.test(shell) && /p\.hint \|\| "Page"/.test(shell), "the search rows show the hint");
  // the menu entries that remain are the same ones, in the same order, as before
  var ids = (shell.match(/^    \{ id: "([a-z0-9]+)"/gm) || []).map(function (l) { return /"([a-z0-9]+)"/.exec(l)[1]; });
  var menu = ids.filter(function (id) { return TABS.indexOf(id) === -1; });
  assert.deepStrictEqual(menu.slice(0, 5), ["overview", "ops", "vuln", "calendar", "monitor"]);
  assert.ok(menu.indexOf("m365") > menu.indexOf("monitor") && menu.indexOf("map") > menu.indexOf("m365"));
});

test("no page, script or tile in the site still links to an old address", function () {
  var skip = TABS.map(function (t) { return t + ".html"; }).concat(["README.md", "legacy-redirect.js"]);
  var offenders = [];
  fs.readdirSync(root).filter(function (f) { return /\.(html|js|css)$/.test(f) && skip.indexOf(f) === -1; }).forEach(function (f) {
    code(read(f)).split("\n").forEach(function (line, n) {
      if (/\b(services|incidents|reports|release)\.html\b/.test(line)) offenders.push(f + ":" + (n + 1) + " " + line.trim().slice(0, 100));
    });
  });
  assert.deepStrictEqual(offenders, []);
  assert.ok(/openRoom\.href = "monitoring\.html#incidents"/.test(read("tile-incidents.js")) && /"monitoring\.html#incidents\/" \+ r\.id/.test(read("tile-incidents.js")));
  assert.ok(/open\.href = "monitoring\.html#services"/.test(read("tile-services.js")));
  assert.ok(/page: "monitoring\.html#incidents"/.test(read("canvas-logic.js")));
  var mon = code(read("monitoring.js"));
  assert.ok(!/incidents\.html/.test(mon) && /hashForTab\("incidents"\)/.test(mon), "the Dashboard links to the tab, not the old page");
});

// ---- the page and its CSS ----------------------------------------------------------------------------------------------

test("monitoring.html loads the four stylesheets up front (no flash) and the four scripts only from the inert template", function () {
  var html = read("monitoring.html");
  var head = html.slice(0, html.indexOf("</head>"));
  ["monitoring", "services", "incidents", "reports", "release"].forEach(function (n) { assert.ok(new RegExp('href="' + n + '\\.css(\\?v=[0-9a-f]+)?"').test(head), n + ".css"); });
  var tpl = html.slice(html.indexOf('<template id="mon-lazy">'), html.indexOf("</template>"));
  ["services.js", "incidents.js", "reports.js", "release-logic.js", "release.js"].forEach(function (f) {
    assert.ok(tpl.indexOf('src="' + f) > -1, f + " is in the template");
    assert.ok(html.slice(html.indexOf("</template>")).indexOf('src="' + f) === -1, f + " is not loaded by the page itself");
  });
  assert.ok(html.indexOf('src="monitoring.js') > html.indexOf("</template>"));
  assert.ok(html.indexOf('id="mon-main"') > -1 && html.indexOf('id="mon-tools"') > -1, "the Dashboard/Settings area and its tools can be hidden as one");
  // every id a tab's script draws into exists exactly once, so two pages can never fight over one element
  var ids = (html.match(/\sid="([^"]+)"/g) || []).map(function (s) { return /"(.+)"/.exec(s)[1]; });
  var seen = {};
  ids.forEach(function (id) { assert.ok(!seen[id], "duplicate id " + id); seen[id] = true; });
});

test("the tabs' stylesheets cannot restyle the other tabs: no bare .small, .mono or button rules, everything under its own prefix or panel", function () {
  var prefix = { "services.css": "svc", "incidents.css": "inc", "reports.css": "rp", "release.css": "rel" };
  Object.keys(prefix).forEach(function (f) {
    var css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    var main = css.indexOf("@media print") === -1 ? css : css.slice(0, css.indexOf("@media print"));
    main.split("}").forEach(function (rule) {
      var sel = rule.split("{")[0].replace(/@media[^{]*$/, "").trim();
      if (!sel || sel.charAt(0) === "@") return;
      sel.split(",").forEach(function (s) {
        s = s.trim();
        if (!s || /^(from|to|\d+%)$/.test(s)) return;
        var ok = new RegExp("^(#?\\.?" + prefix[f] + "-|#pane-|\\.dim$|\\.dim\\b)").test(s) || /^\.?mo-/.test(s) || /^#(svc|inc|rp|rel)-/.test(s);
        assert.ok(ok, f + ": selector \"" + s + "\" is not under the page's own prefix or panel");
      });
    });
  });
});

// ---- starting and stopping a tab ---------------------------------------------------------------------------------------

// A bare-bones page: just enough DOM for a tab's script to load, ask a Worker that never answers.
function makeEl(id) {
  var e = {
    id: id, children: [], firstChild: null, hidden: false, className: "", textContent: "", disabled: false, value: "", listeners: {},
    style: {}, tagName: "DIV", options: [],
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function (t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
    removeEventListener: function () {},
    appendChild: function (c) { e.children.push(c); e.firstChild = e.children[0]; return c; },
    removeChild: function () { e.children.shift(); e.firstChild = e.children[0] || null; },
    setAttribute: function () {}, getAttribute: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    focus: function () {}, contains: function () { return false; }
  };
  return e;
}

function loadTab(file) {
  var els = {}, intervals = {}, nextId = 1, calls = { auth: 0, fetch: 0 }, hashHandlers = [];
  var document = {
    hidden: false, activeElement: null, readyState: "complete", body: makeEl("body"), head: makeEl("head"),
    getElementById: function (id) { return els[id] || (els[id] = makeEl(id)); },
    createElement: function (tag) { var e = makeEl(""); e.tagName = String(tag).toUpperCase(); return e; },
    createElementNS: function () { return makeEl(""); },
    createTextNode: function (t) { return { nodeType: 3, textContent: String(t) }; },
    addEventListener: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; }
  };
  var sandbox = {
    document: document, console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp,
    Intl: Intl, URL: URL, Error: Error, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat, encodeURIComponent: encodeURIComponent,
    AbortController: AbortController, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function (fn) { var id = nextId++; intervals[id] = fn; return id; },
    clearInterval: function (id) { delete intervals[id]; },
    location: { hash: "", search: "", href: "" },
    fetch: function () { calls.fetch++; return new Promise(function () {}); }   // the Worker never answers: the tab stays on "Loading"
  };
  sandbox.window = sandbox;
  sandbox.barnyardAuthState = function () { calls.auth++; return Promise.resolve({ authenticated: true }); };
  sandbox.addEventListener = function (t, f) { if (t === "hashchange") hashHandlers.push(f); };
  sandbox.removeEventListener = function (t, f) { if (t === "hashchange") { var i = hashHandlers.indexOf(f); if (i > -1) hashHandlers.splice(i, 1); } };
  sandbox.confirm = function () { return false; };
  sandbox.window.BarnyardTheme = undefined;
  vm.createContext(sandbox);
  (Array.isArray(file) ? file : [file]).forEach(function (f) { vm.runInContext(read(f), sandbox, { filename: f }); });
  return { w: sandbox, intervals: intervals, calls: calls, hashHandlers: hashHandlers, count: function () { return Object.keys(intervals).length; } };
}
function settle() { return new Promise(function (r) { setTimeout(r, 20); }); }

test("each tab's script adds nothing to the page until it is started, and registers itself for monitoring.js", function () {
  [["services.js", "services"], ["incidents.js", "incidents"], ["reports.js", "reports"], [["release-logic.js", "release.js"], "release"]].forEach(function (c) {
    var t = loadTab(c[0]);
    var tab = t.w.BarnyardTabs && t.w.BarnyardTabs[c[1]];
    assert.ok(tab && typeof tab.start === "function" && typeof tab.stop === "function", c[1] + ": BarnyardTabs." + c[1] + ".start/stop");
    assert.strictEqual(t.count(), 0, c[1] + ": no timer yet");
    assert.strictEqual(t.calls.auth + t.calls.fetch, 0, c[1] + ": nothing asked for until the tab is opened");
  });
});

[["services.js", "services"], ["incidents.js", "incidents"], [["release-logic.js", "release.js"], "release"]].forEach(function (c) {
  test(c[1] + ": polls only while its tab is open — one timer however often it is shown, none after it is closed, one again when reopened", function () {
    var t = loadTab(c[0]), tab = t.w.BarnyardTabs[c[1]];
    return Promise.resolve().then(function () {
      tab.start();
      tab.start();   // shown twice before the sign-in answer: still one check
      return settle();
    }).then(function () {
      assert.strictEqual(t.calls.auth, 1, "signed-in check once");
      assert.strictEqual(t.count(), 1, "one timer while open");
      tab.start();
      assert.strictEqual(t.count(), 1, "showing it again does not add a second timer");
      tab.stop();
      assert.strictEqual(t.count(), 0, "closing the tab clears the timer");
      tab.stop();
      assert.strictEqual(t.count(), 0);
      tab.start();
      return settle();
    }).then(function () {
      assert.strictEqual(t.count(), 1, "reopening starts one again");
      assert.strictEqual(t.calls.auth, 1, "without asking who is signed in a second time");
      tab.stop();
      assert.strictEqual(t.count(), 0);
    });
  });
});

test("incidents: listens for hash changes only while its tab is open, never twice", function () {
  var t = loadTab("incidents.js"), tab = t.w.BarnyardTabs.incidents;
  return Promise.resolve().then(function () {
    tab.start(); tab.start();
    return settle();
  }).then(function () {
    assert.strictEqual(t.hashHandlers.length, 1, "one listener while open");
    tab.stop();
    assert.strictEqual(t.hashHandlers.length, 0, "none once closed");
  });
});

test("reports: never polls, asks who is signed in once, and keeps the report on screen when the tab is closed and reopened", function () {
  var t = loadTab("reports.js"), tab = t.w.BarnyardTabs.reports;
  return Promise.resolve().then(function () {
    tab.start(); tab.stop(); tab.start();
    return settle();
  }).then(function () {
    assert.strictEqual(t.count(), 0, "no timer, ever");
    assert.strictEqual(t.calls.auth, 1);
    var fetched = t.calls.fetch;
    tab.stop(); tab.start();
    return settle().then(function () { assert.strictEqual(t.calls.fetch, fetched, "reopening reads nothing and cannot lose sentences that are not saved"); });
  });
});

test("a signed-out visitor gets the message and no timer; the tab asks again the next time it is opened", function () {
  var t = loadTab("services.js"), tab = t.w.BarnyardTabs.services;
  t.w.barnyardAuthState = function () { t.calls.auth++; return Promise.resolve({ authenticated: false }); };
  return Promise.resolve().then(function () {
    tab.start();
    return settle();
  }).then(function () {
    assert.strictEqual(t.count(), 0);
    tab.stop(); tab.start();
    return settle();
  }).then(function () {
    assert.strictEqual(t.calls.auth, 2, "a sign-in made in another window is noticed");
    assert.strictEqual(t.count(), 0);
  });
});


// ---- monitoring.js: who sees which tab, and what starts and stops when the tab changes -------------------------------------

// Runs the real monitoring.js against a stub page built from the real monitoring.html's ids, with a stub Worker that never
// answers (so the Dashboard stays on "Loading") and stub tab scripts that record start() and stop().
function bootMonitoring(who, hash) {
  var html = read("monitoring.html");
  var els = {}, handlers = [], loaded = [], events = [];
  (html.match(/\sid="([^"]+)"/g) || []).forEach(function (s) { var id = /"(.+)"/.exec(s)[1]; els[id] = makeEl(id); els[id].scrollWidth = 0; els[id].clientWidth = 0; });
  ["pane-services", "pane-incidents", "pane-reports", "pane-release"].forEach(function (id) { els[id].hidden = true; });
  els["mon-tabs"].hidden = true;
  ["tab-services", "tab-incidents", "tab-reports", "tab-release"].forEach(function (id) { els[id].hidden = true; });
  var lazy = (html.slice(html.indexOf('<template id="mon-lazy">'), html.indexOf("</template>")).match(/src="([^"]+)"/g) || []).map(function (s) { var src = /"(.+)"/.exec(s)[1]; return { getAttribute: function () { return src; } }; });
  els["mon-lazy"].content = { querySelectorAll: function () { return lazy; } };
  var sandbox = {};
  var document = {
    hidden: false, activeElement: null, readyState: "complete", body: makeEl("body"),
    head: { appendChild: function (s) {
      loaded.push(s.src);
      var file = s.src.split("?")[0];
      var tab = { "services.js": "services", "incidents.js": "incidents", "reports.js": "reports", "release.js": "release" }[file];
      Promise.resolve().then(function () {
        if (tab) { sandbox.BarnyardTabs = sandbox.BarnyardTabs || {}; sandbox.BarnyardTabs[tab] = { start: function () { events.push("start " + tab); }, stop: function () { events.push("stop " + tab); } }; }
        s.onload();
      });
    } },
    getElementById: function (id) { return els[id] || null; },
    createElement: function (tag) { var e = makeEl(""); e.tagName = String(tag).toUpperCase(); return e; },
    createElementNS: function () { return makeEl(""); }, createTextNode: function (t) { return { nodeType: 3, textContent: String(t) }; },
    addEventListener: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; }
  };
  Object.assign(sandbox, {
    document: document, console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp, Intl: Intl, URL: URL, Error: Error,
    isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat, encodeURIComponent: encodeURIComponent, AbortController: AbortController,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 1; }, clearInterval: function () {},
    location: { hash: hash || "", search: "", href: "" },
    fetch: function () { return new Promise(function () {}); },
    addEventListener: function (t, f) { if (t === "hashchange") handlers.push(f); }, removeEventListener: function () {}
  });
  sandbox.window = sandbox;
  sandbox.barnyardAuthState = function () { return Promise.resolve({ authenticated: true }); };
  sandbox.BarnyardTheme = { who: {
    get: function () { return who; }, onChange: function (fn) { fn(who); }, load: function () {},
    permits: function (s, perm) { return !(s && s.owner !== true && Array.isArray(s.permissions) && s.permissions.indexOf(perm) === -1); }
  } };
  sandbox.BarnyardMyMonitoring = { start: function () { events.push("my space"); } };
  vm.createContext(sandbox);
  vm.runInContext(read("monitoring.js"), sandbox, { filename: "monitoring.js" });
  function go(h) { sandbox.location.hash = h; handlers.forEach(function (f) { f(); }); return settle(); }
  function view() {
    return {
      bar: !els["mon-tabs"].hidden, main: !els["mon-main"].hidden,
      tabs: ["dashboard", "services", "incidents", "reports", "release", "settings"].filter(function (t) { return !els["tab-" + t].hidden; }),
      panes: ["services", "incidents", "reports", "release"].filter(function (t) { return !els["pane-" + t].hidden; })
    };
  }
  return settle().then(function () { return { go: go, view: view, loaded: loaded, events: events, els: els }; });
}

test("the owner who follows an incident's address lands on the Incidents tab, which loads once and starts", function () {
  return bootMonitoring({ authenticated: true, owner: true }, "#incidents/inc_abcd1234").then(function (p) {
    var v = p.view();
    assert.deepStrictEqual(v.tabs, ["dashboard", "services", "incidents", "reports", "release", "settings"], "all six tabs");
    assert.ok(v.bar && !v.main && v.panes.length === 1 && v.panes[0] === "incidents", JSON.stringify(v));
    assert.deepStrictEqual(p.loaded.map(function (s) { return s.split("?")[0]; }), ["incidents.js"], "only that tab's script");
    assert.deepStrictEqual(p.events, ["start incidents"]);
  });
});

test("moving between tabs stops the one left and starts the one entered; scripts are fetched once; Dashboard and Settings stop everything", function () {
  return bootMonitoring({ authenticated: true, owner: true }, "").then(function (p) {
    assert.deepStrictEqual(p.loaded, [], "nothing is fetched while the Dashboard is open");
    return p.go("#services").then(function () {
      assert.deepStrictEqual(p.view().panes, ["services"]);
      return p.go("#release");
    }).then(function () {
      assert.deepStrictEqual(p.view().panes, ["release"]);
      assert.deepStrictEqual(p.loaded.map(function (s) { return s.split("?")[0]; }), ["services.js", "release-logic.js", "release.js"], "the logic is loaded before the page");
      return p.go("#settings");
    }).then(function () {
      var v = p.view();
      assert.ok(v.main && v.panes.length === 0, JSON.stringify(v));
      return p.go("#services");
    }).then(function () {
      assert.deepStrictEqual(p.loaded.length, 3, "no second fetch for a tab already loaded");
      return p.go("#incidents/inc_abcd1234");
    }).then(function () {
      return p.go("#incidents/inc_wxyz5678");   // another incident, same tab: the tab's own listener follows it, monitoring.js does not restart it
    }).then(function () {
      assert.deepStrictEqual(p.events, ["start services", "stop services", "start release", "stop release", "start services", "stop services", "start incidents"]);
      return p.go("#dashboard");
    }).then(function () {
      assert.strictEqual(p.events[p.events.length - 1], "stop incidents");
      assert.ok(p.view().main && p.view().panes.length === 0);
    });
  });
});

test("anyone who is not the owner never gets an extra tab, its script or its panel, whatever the address says", function () {
  var cases = [
    ["a person with their own space", { authenticated: true, owner: false, permissions: ["monitoring.view"] }],
    ["someone whose owner flag is unknown", { authenticated: true, owner: null }],
    ["nobody known yet", null]
  ];
  return cases.reduce(function (chain, c) {
    return chain.then(function () {
      return bootMonitoring(c[1], "#services").then(function (p) {
        return p.go("#incidents/inc_abcd1234").then(function () { return p.go("#release"); }).then(function () {
          assert.deepStrictEqual(p.loaded, [], c[0] + ": no script");
          assert.deepStrictEqual(p.view().panes, [], c[0] + ": no panel");
          assert.ok(p.view().tabs.indexOf("services") === -1 && p.view().tabs.indexOf("release") === -1, c[0] + ": no tab");
          if (c[1] && c[1].owner === false) assert.deepStrictEqual(p.events, ["my space"], "they get their own space, as before");
        });
      });
    });
  }, Promise.resolve());
});

// ---- run ----------------------------------------------------------------------------------------------------------------

(function next(i) {
  if (i >= queue.length) { console.log("\n" + passed + " passed"); return; }
  var t = queue[i];
  Promise.resolve().then(t.fn).then(function () { passed++; console.log("ok - " + t.name); next(i + 1); }, function (e) {
    console.error("not ok - " + t.name);
    console.error(e && e.stack || e);
    process.exit(1);
  });
})(0);
