// Page shell: every hub page sits in the shared container (<main id="page" class="content">) and fills it like the rest.
// A page's own stylesheet must not narrow its root to a fixed width (that is what made the newer pages look short of the
// screen) and must not redefine the shell's title row.
//
//   node test/page-shell.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

// Pages that are deliberately not in the shared shell: the public shared view (its own narrow reading layout),
// and the privacy page (static legal text).
var OUTSIDE_SHELL = ["view.html", "privacy.html"];
// Stylesheets that may still carry a fixed-width page root or the title row until their page is reworked.
var CSS_EXCEPTIONS = [];

var pages = fs.readdirSync(root).filter(function (f) { return /\.html$/.test(f) && OUTSIDE_SHELL.indexOf(f) === -1; });

test("there are pages to check", function () {
  assert.ok(pages.length >= 10, "found " + pages.length + " pages");
});

test("every page uses the shared container and the shell's wide-screen opt-in", function () {
  pages.forEach(function (p) {
    var html = fs.readFileSync(path.join(root, p), "utf8");
    assert.ok(/<main id="page" class="content"/.test(html), p + ": <main id=\"page\" class=\"content\">");
    assert.ok(/<body[^>]*\bdata-wide\b/.test(html), p + ": <body data-wide>");
    // The landing page opens with its own hero (greeting, weather) instead of a title row.
    if (p !== "index.html") assert.ok(/<div class="page-head"/.test(html), p + ": the shell's title row (.page-head)");
    assert.ok(/href="shell\.css/.test(html), p + ": loads shell.css");
  });
});

test("no page stylesheet narrows its page root to a fixed width", function () {
  fs.readdirSync(root).filter(function (f) { return /\.css$/.test(f) && CSS_EXCEPTIONS.indexOf(f) === -1; }).forEach(function (f) {
    var css = fs.readFileSync(path.join(root, f), "utf8");
    var bad = css.match(/^#[a-z0-9]+-root\s*\{[^}]*max-width\s*:\s*\d+px/m);
    assert.ok(!bad, f + " caps its page root: " + (bad && bad[0].slice(0, 80)));
  });
});

test("no page stylesheet redefines the shell's title row", function () {
  fs.readdirSync(root).filter(function (f) { return /\.css$/.test(f) && f !== "shell.css" && CSS_EXCEPTIONS.indexOf(f) === -1; }).forEach(function (f) {
    var css = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/^\.page-head\s*\{/m.test(css), f + " redefines .page-head (it is in shell.css)");
  });
});

test("the Calendar's sections and Plan view fill the container", function () {
  var css = fs.readFileSync(path.join(root, "calendar.css"), "utf8");
  ["\\.cal-quick", "\\.cal-section", "\\.plan"].forEach(function (sel) {
    var m = css.match(new RegExp("^" + sel + "\\s*\\{[^}]*\\}", "m"));
    assert.ok(m && !/max-width/.test(m[0]), sel + " has no max-width");
  });
});

test("the Dependency map stage grows with the window", function () {
  var css = fs.readFileSync(path.join(root, "map.css"), "utf8");
  var m = css.match(/^\.mp-stage\s*\{[^}]*\}/m);
  assert.ok(m && /height:\s*clamp\(/.test(m[0]), "the map stage height is a clamp() of the viewport, not a fixed 580px");
});

console.log("\n" + passed + " passed");
