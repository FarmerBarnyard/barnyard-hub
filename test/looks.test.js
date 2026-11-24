// Coverage for the page looks: the registry in themes.js, the Look setting (validation, cookie, fallback), how a look's layer is
// loaded, the gallery in Settings, and the look layers themselves. Every look in the registry is covered here with NO test edits:
// adding a look (docs/looks.md) adds an entry to the registry and its files to look-layers/, and this file checks them.
//
//   node test/looks.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var Theme = require(path.join(root, "themes.js"));
var Lint = require(path.join(root, "tools", "look-lint.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

var EXPECTED_IDS = ["original", "shift-log", "switchboard", "run-sheet", "plain-window", "poster", "drawing-register", "mailroom", "sheet", "paper-terminal", "day-line", "lines", "grid-9", "lab-book", "prompt", "wiki", "raw", "classic-desktop"];

test("the registry lists all 18 looks: Original first, then the rest in id order, each id unique", function () {
  assert.strictEqual(Theme.LOOKS.length, 18);
  assert.strictEqual(Theme.LOOKS[0].id, "original");
  assert.deepStrictEqual(Theme.LOOKS.slice(1).map(function (l) { return l.id; }), EXPECTED_IDS.slice(1).sort());
  assert.deepStrictEqual(Theme.LOOKS.map(function (l) { return l.id; }).sort(), EXPECTED_IDS.slice().sort());
});

test("every entry is well formed: slug id, name, blurb, group, flags, versions and a sketch", function () {
  Theme.LOOKS.forEach(function (l) {
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(l.id) && l.id.length <= 24, l.id + ": id is a short slug");
    assert.ok(typeof l.name === "string" && l.name.length >= 2 && l.name.length <= 24, l.id + ": name");
    assert.ok(typeof l.blurb === "string" && l.blurb.length >= 10 && l.blurb.length <= 80, l.id + ": a one-line description");
    assert.ok(Theme.LOOK_GROUPS.indexOf(l.group) !== -1, l.id + ": known group " + l.group);
    assert.strictEqual(typeof l.installed, "boolean", l.id + ": installed");
    assert.strictEqual(typeof l.renderer, "boolean", l.id + ": renderer");
    assert.ok(/^[0-9a-f]{8}$/.test(l.v) && /^[0-9a-f]{8}$/.test(l.jv), l.id + ": v and jv are 8 hex digits");
    var sketch = Theme.parseSketch(l.sketch);
    assert.ok(sketch.length >= 3, l.id + ": sketch has rectangles");
    sketch.forEach(function (r) { assert.ok(r.x <= 100 && r.y <= 100 && r.w <= 100 && r.h <= 100 && r.w > 0 && r.h > 0, l.id + ": a rectangle inside 0-100"); assert.ok(/^--/.test(r.colour), l.id + ": a known tone"); });
  });
  assert.strictEqual(Theme.findLook("original").installed, true);
  assert.strictEqual(Theme.findLook("original").renderer, false);
});

test("the registry is merge-friendly: one entry per line, a comment line between entries, entries in id order", function () {
  var lines = read("themes.js").split(/\r?\n/);
  var start = lines.findIndex(function (l) { return /^\s*var LOOKS = \[/.test(l); });
  var end = lines.findIndex(function (l, i) { return i > start && /^\s*\];/.test(l); });
  assert.ok(start > 0 && end > start);
  var body = lines.slice(start + 1, end), ids = [], prevWasEntry = false;
  body.forEach(function (l, i) {
    var entry = /^\s*\{ id: "([a-z0-9-]+)"/.exec(l);
    if (entry) { assert.ok(!prevWasEntry, "two entries on neighbouring lines: " + entry[1]); ids.push(entry[1]); assert.ok(/\},?\s*$/.test(l), entry[1] + " is complete on one line"); prevWasEntry = true; }
    else { assert.ok(/^\s*\/\/ ----\s*$/.test(l), "only separator comments between entries: " + l.trim()); prevWasEntry = false; }
  });
  assert.strictEqual(ids.length, 18);
  assert.deepStrictEqual(ids.slice(1), ids.slice(1).slice().sort(), "ids after Original are in order");
  assert.strictEqual(ids[0], "original");
});

test("the gallery has two sections: installed looks first, then looks that are only designed", function () {
  var sections = Theme.lookSections();
  assert.strictEqual(sections[0].key, "installed");
  assert.strictEqual(sections[0].looks[0].id, "original");
  var total = 0;
  sections.forEach(function (s) { total += s.looks.length; s.looks.forEach(function (l) { assert.strictEqual(l.installed, s.key === "installed"); }); });
  assert.strictEqual(total, Theme.LOOKS.length, "every look is shown exactly once");
});

test("a look setting: default Original; a known installed look is kept; unknown, designed-only and junk fall back to Original", function () {
  assert.strictEqual(Theme.defaults().look, "original");
  assert.strictEqual(Theme.normalize({}).look, "original", "a profile without the key");
  assert.strictEqual(Theme.normalize({ look: "original" }).look, "original");
  [null, undefined, "", 5, [], {}, "nope", "PLAIN-WINDOW", "../x", "plain window", "x".repeat(40)].forEach(function (v) { assert.strictEqual(Theme.normalize({ look: v }).look, "original", JSON.stringify(v)); });
  var installed = Theme.LOOKS.filter(function (l) { return l.installed; }), designed = Theme.LOOKS.filter(function (l) { return !l.installed; });
  installed.forEach(function (l) { assert.strictEqual(Theme.normalize({ look: l.id }).look, l.id, l.id + " is kept"); });
  designed.forEach(function (l) { assert.strictEqual(Theme.normalize({ look: l.id }).look, "original", l.id + " is drawn, not built: reads as Original"); });
});

test("the look travels in the shared cookie, and a bad or unbuilt value in the cookie is ignored", function () {
  var s = Theme.normalize({ theme: "navy", look: "original" });
  assert.ok(/(^|&)l=original(&|$)/.test(Theme.encodePrefs(s)));
  assert.strictEqual(Theme.decodePrefs(Theme.encodePrefs(s)).look, "original");
  assert.strictEqual(Theme.decodePrefs("t=navy&l=nope").look, undefined);
  assert.strictEqual(Theme.decodePrefs("l=" + encodeURIComponent("<script>")).look, undefined);
  Theme.LOOKS.filter(function (l) { return !l.installed; }).forEach(function (l) { assert.strictEqual(Theme.decodePrefs("l=" + l.id).look, undefined, l.id + " unbuilt: ignored"); });
  assert.ok(Theme.encodePrefs(s).length < 120, "the cookie stays small");
});

test("the look is saved with the profile like the theme: it is a settings key, and a profile object without it still normalises", function () {
  var withLook = Theme.normalize({ theme: "plum", look: "original", mode: "light" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Theme.normalize(withLook))), JSON.parse(JSON.stringify(withLook)), "normalising is stable");
  var old = Theme.normalize({ theme: "plum", mode: "light" });
  assert.strictEqual(old.look, "original");
  assert.strictEqual(Theme.sync.decide(withLook, { owner: "a", rev: 1, dirty: false }, { exists: true, owner: "a", rev: 1, updatedAt: 1, settings: withLook }), "none");
});

// ---- applying a look in a page (a small fake document) ----------------------------------------------------------------

function fakePage() {
  var attrs = {}, head = [], timers = [];
  function element(tag) { var listeners = {}; return { tag: tag, rel: "", href: "", src: "", async: false, addEventListener: function (ev, fn) { listeners[ev] = fn; }, fire: function (ev) { if (listeners[ev]) listeners[ev](); } }; }
  var doc = {
    documentElement: { setAttribute: function (k, v) { attrs[k] = String(v); }, getAttribute: function (k) { return attrs[k] === undefined ? null : attrs[k]; }, removeAttribute: function (k) { delete attrs[k]; }, style: { setProperty: function () {}, removeProperty: function () {} } },
    head: { appendChild: function (el) { head.push(el); } },
    createElement: element, cookie: "", addEventListener: function () {}, readyState: "complete"
  };
  var store = {};
  var fake = { document: doc, location: { hostname: "dashboard.barnyard.site" }, localStorage: { getItem: function (k) { return store[k] === undefined ? null : store[k]; }, setItem: function (k, v) { store[k] = String(v); } }, sessionStorage: { getItem: function () { return null; }, setItem: function () {} }, setTimeout: function (fn) { timers.push(fn); return timers.length; }, clearTimeout: function () {}, matchMedia: function () { return { matches: false, addEventListener: function () {} }; } };
  return { root: fake, attrs: attrs, head: head, timers: timers, store: store };
}
function loadThemesIn(page) {
  var code = fs.readFileSync(path.join(root, "themes.js"), "utf8");
  var factory = new Function("window", "globalThis", "module", code + "\nreturn window.BarnyardTheme;");
  var win = page.root;
  return factory(win, win, undefined);
}

test("Original sets data-look and loads nothing: no stylesheet, no script, nothing hidden", function () {
  var page = fakePage(), T = loadThemesIn(page);
  T.set({ look: "original" });
  assert.strictEqual(page.attrs["data-look"], "original");
  assert.strictEqual(page.head.length, 0, "no layer fetched");
  assert.strictEqual(page.attrs["data-look-pending"], undefined);
});

test("another installed look is fetched once, hides the body until it has loaded, and falls back after 3 seconds", function () {
  var page = fakePage(), T = loadThemesIn(page);
  var entry = T.findLook("classic-desktop");
  entry.installed = true; entry.v = "0123abcd"; entry.renderer = false;     // a stand-in for a look that is built (the real flag flips in its own PR)
  T.set({ look: "classic-desktop" });
  assert.strictEqual(page.attrs["data-look"], "classic-desktop");
  assert.strictEqual(page.head.length, 1);
  assert.strictEqual(page.head[0].href, "/look-layers/classic-desktop.css?v=0123abcd");
  assert.strictEqual(page.head[0].rel, "stylesheet");
  assert.strictEqual(page.attrs["data-look-pending"], "1");
  T.set({ density: "compact" }); T.set({ look: "classic-desktop" });
  assert.strictEqual(page.head.length, 1, "the layer is fetched once");
  page.head[0].fire("load");
  assert.strictEqual(page.attrs["data-look-pending"], undefined, "shown once loaded");
  // a failed fetch also shows the page (as Original: every rule of the layer is scoped to the look)
  var page2 = fakePage(), T2 = loadThemesIn(page2), e2 = T2.findLook("classic-desktop");
  e2.installed = true; e2.v = "0123abcd";
  T2.set({ look: "classic-desktop" });
  page2.head[0].fire("error");
  assert.strictEqual(page2.attrs["data-look-pending"], undefined);
  var page3 = fakePage(), T3 = loadThemesIn(page3), e3 = T3.findLook("classic-desktop");
  e3.installed = true;
  T3.set({ look: "classic-desktop" });
  assert.strictEqual(page3.attrs["data-look-pending"], "1");
  page3.timers.forEach(function (fn) { fn(); });
  assert.strictEqual(page3.attrs["data-look-pending"], undefined, "gives up after the timeout");
});

test("a look with a renderer also fetches its script, and renderers are found by page for the current look only", function () {
  var page = fakePage(), T = loadThemesIn(page), e = T.findLook("grid-9");
  e.installed = true; e.renderer = true; e.v = "11111111"; e.jv = "22222222";
  var calls = [];
  T.look.whenReady(function () { calls.push("early"); });
  assert.deepStrictEqual(calls, ["early"], "Original: ready at once");
  T.set({ look: "grid-9" });
  assert.deepStrictEqual(page.head.map(function (x) { return x.tag; }).sort(), ["link", "script"]);
  assert.ok(page.head.some(function (x) { return x.src === "/look-layers/grid-9.js?v=22222222"; }));
  T.look.whenReady(function () { calls.push("late"); });
  assert.deepStrictEqual(calls, ["early"], "not ready until both have loaded");
  T.look.register("grid-9", "overview", function () { return "drawn"; });
  assert.strictEqual(T.look.renderer("overview")(), "drawn");
  assert.strictEqual(T.look.renderer("ops"), null, "a page the look does not draw: null (the page draws as usual)");
  page.head.forEach(function (x) { x.fire("load"); });
  assert.deepStrictEqual(calls, ["early", "late"]);
  T.set({ look: "original" });
  assert.strictEqual(T.look.renderer("overview"), null, "another look: no renderer");
});

test("a saved look that is not built yet reads as Original in a page and loads nothing", function () {
  var page = fakePage();
  var unbuilt = Theme.LOOKS.filter(function (l) { return !l.installed; })[0] || { id: "no-such-look" };   // any look not built yet (the set shrinks as looks are built)
  page.store["barnyard-settings"] = JSON.stringify({ theme: "navy", look: unbuilt.id });
  var T = loadThemesIn(page);
  assert.strictEqual(T.get().look, "original");
  assert.strictEqual(page.attrs["data-look"], "original");
  assert.strictEqual(page.head.length, 0);
});

// ---- the gallery in Settings ---------------------------------------------------------------------------------------------

test("the Appearance tab shows the Look gallery before the themes, built from the registry, with unbuilt looks disabled", function () {
  var js = read("shell.js");
  assert.ok(/body\.appendChild\(lookTiles\(s\)\);\s*body\.appendChild\(themeTiles\(s\)\)/.test(js.replace(/\r/g, "")), "Look comes right before Theme");
  var fn = js.slice(js.indexOf("function lookTiles(s)"), js.indexOf("function themeTiles(s)"));
  assert.ok(/Theme\.lookSections\(\)/.test(fn), "built from the registry");
  assert.ok(/input\.disabled = !l\.installed/.test(fn), "only installed looks can be chosen");
  assert.ok(/input\.name = "look"/.test(fn) && /Theme\.set\(\{ look: l\.id \}\)/.test(fn));
  assert.ok(/Designed, not built yet|designed, not built yet/.test(fn + read("themes.js")), "unbuilt looks are labelled");
  assert.ok(!/innerHTML/.test(fn), "no innerHTML");
  assert.ok(/https:\/\/dashboard\.barnyard\.site\/looks\//.test(fn.replace(/\r/g, "") + js), "a link to the published gallery");
  assert.ok(/Theme\.LOOKS\.forEach\(function \(l\) \{ if \(l\.installed\)/.test(js), "the command palette lists installed looks");
});

test("the gallery styles exist: disabled tiles, the sketch preview, and the body is hidden only while a look's layer is pending", function () {
  var css = read("shell.css");
  [".tile-off .tile-card", ".look-thumb", ".look-thumb i", ".tiles-looks", ":root[data-look-pending] body"].forEach(function (sel) { assert.ok(css.indexOf(sel) !== -1, "shell.css has " + sel); });
});

// ---- the look layers: every installed look, from the registry ---------------------------------------------------------------

test("the linter itself catches what it must: unscoped selectors, literal colours, url(), @import, low contrast", function () {
  var ok = Lint.lintCss("demo", "html[data-look=\"demo\"] .card { color: var(--fg); background: var(--panel); }\n@media (max-width: 600px) { html[data-look=\"demo\"] .card { color: var(--fg-strong); background: var(--panel-2); } }\n");
  assert.deepStrictEqual(ok.errors, []);
  assert.ok(ok.pairs.length >= 2);
  var bad = function (css, needle) { var r = Lint.lintCss("demo", css); assert.ok(r.errors.some(function (e) { return e.indexOf(needle) !== -1; }), needle + " in " + JSON.stringify(r.errors)); };
  bad(".card { color: var(--fg); }", "unscoped");
  bad("html[data-look=\"other\"] .x { color: var(--fg); }", "unscoped");
  bad("html[data-look=\"demo\"] .x, body { margin: 0; }", "unscoped");
  bad("html[data-look=\"demo\"] .x { color: #123456; }", "literal colour");
  bad("html[data-look=\"demo\"] .x { background: rgb(1,2,3); }", "literal colour");
  bad("html[data-look=\"demo\"] .x { border-color: red; }", "literal colour");
  bad("html[data-look=\"demo\"] .x { background: url(a.png); }", "url()");
  bad("@import 'x.css'; html[data-look=\"demo\"] .x { margin: 0; }", "@import");
  bad("@font-face { font-family: x; }", "at-rule");
  bad("html[data-look=\"demo\"] .x { color: var(--fg-dim); background: var(--panel-2); }\n/* contrast: --accent on --bg */", "contrast below");
  assert.deepStrictEqual(Lint.lintCss("demo", "html[data-look=\"demo\"] .x { box-shadow: 0 1px 2px rgba(0,0,0,.3); margin: 0; }").errors, [], "shadows may use rgba");
  assert.deepStrictEqual(Lint.lintCss("demo", "@keyframes demo-fade { from { opacity: 0 } to { opacity: 1 } }\nhtml[data-look=\"demo\"] .x { animation: demo-fade .2s; }").errors, []);
  bad("@keyframes fade { from { opacity: 0 } to { opacity: 1 } }", "keyframes name");
  assert.ok(Lint.declaredPairs("/* contrast: --fg on --panel; --accent-ink on --accent */").length === 2);
});

Theme.LOOKS.forEach(function (l) {
  test("look " + l.id + ": its files match the registry, it is scoped to itself, uses only theme colours, and reads in all 36 theme and mode combinations", function () {
    var r = Lint.lintLook(root, l.id);
    assert.deepStrictEqual(r.errors, []);
    if (l.installed && l.id !== "original") {
      var css = read("look-layers/" + l.id + ".css");
      assert.ok(r.pairs.length >= 1, l.id + " draws at least one checked colour pair (or declares them in a contrast comment)");
      assert.ok(Lint.rules(css, []).length >= 5, l.id + " has real rules");
    }
  });
});

console.log("\n" + passed + " tests passed");
