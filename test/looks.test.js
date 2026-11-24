// The look gallery (looks/): example pages for choosing a new look. Nothing in them may be real, and a signed-out visitor must see
// only the sign-in card on every one of them.
//
//   node test/looks.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var looksDir = path.join(root, "looks");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function walk(dir) {
  var out = [];
  fs.readdirSync(dir).forEach(function (n) {
    var p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) out = out.concat(walk(p)); else out.push(p);
  });
  return out;
}
var files = walk(looksDir);
var pages = files.filter(function (f) { return /\.html$/.test(f); });
var text = files.filter(function (f) { return /\.(html|md|css|js)$/.test(f); });
function rel(f) { return path.relative(looksDir, f).split(path.sep).join("/"); }
function readRaw(f) { return fs.readFileSync(f, "utf8"); }
function head(html) { return html.slice(0, html.indexOf("</head>")); }

test("the gallery has the page, 18 look pages, 18 specs and 18 thumbnails", function () {
  assert.ok(fs.existsSync(path.join(looksDir, "index.html")));
  assert.strictEqual(pages.length, 19, "pages: " + pages.length);
  assert.strictEqual(files.filter(function (f) { return /[\\/]specs[\\/].+\.md$/.test(f); }).length, 18);
  assert.strictEqual(files.filter(function (f) { return /[\\/]thumbs[\\/].+\.png$/.test(f); }).length, 18);
});

test("every page loads the sign-in gate first, at the right depth, so a signed-out visitor sees only the card", function () {
  pages.forEach(function (f) {
    var up = path.dirname(f) === looksDir ? "../" : "../../";
    var gv = path.dirname(f) === looksDir ? "gate-vars.css" : "../gate-vars.css";
    var gr = path.dirname(f) === looksDir ? "gate-ready.js" : "../gate-ready.js";
    var h = head(readRaw(f));
    assert.ok(h.indexOf('<link rel="stylesheet" href="' + up + 'landing.css?v=') !== -1, rel(f) + " links landing.css");
    assert.ok(h.indexOf('<script src="' + up + 'landing.js?v=') !== -1, rel(f) + " loads landing.js");
    assert.ok(h.indexOf('href="' + gv + '"') !== -1 && h.indexOf('<script src="' + gr + '">') !== -1, rel(f) + " loads the card colours and the re-measure helper");
    var firstOwn = Math.min.apply(null, ["<style", "<script>"].map(function (s) { var i = h.indexOf(s); return i === -1 ? Infinity : i; }));
    assert.ok(h.indexOf("landing.js") < firstOwn, rel(f) + ": landing.js comes before the page's own style and script");
  });
});

test("the gate files it points at exist, with the stamps the real pages use", function () {
  ["landing.css", "landing.js"].forEach(function (n) { assert.ok(fs.existsSync(path.join(root, n)), n); });
  var ops = readRaw(path.join(root, "ops.html"));
  var cssStamp = /landing\.css\?v=([0-9a-f]{8})/.exec(ops)[1];
  var jsStamp = /landing\.js\?v=([0-9a-f]{8})/.exec(ops)[1];
  pages.forEach(function (f) {
    var t = readRaw(f);
    assert.ok(t.indexOf("landing.css?v=" + cssStamp) !== -1, rel(f) + ": landing.css stamp equals ops.html's");
    assert.ok(t.indexOf("landing.js?v=" + jsStamp) !== -1, rel(f) + ": landing.js stamp equals ops.html's");
  });
  assert.ok(fs.existsSync(path.join(looksDir, "gate-vars.css")) && fs.existsSync(path.join(looksDir, "gate-ready.js")));
});

test("the example data is made up: no real name, project, host or hash is in any file of the gallery", function () {
  var banned = [/Nathan/i, /Rackmill/i, /Remote Layout/i, /hosted plane/i, /BARNYARD(APP|LT|CLD)\d/, /flickerpane/i, /6ec9878b/i,
    /@[A-Za-z0-9-]+\.(com|net|org|site)\b/, /C:\\Users/i, /\b(sheet-0043|looks18)\b/, /\bReview \d{3,4}\b/, /pilot/i];
  text.forEach(function (f) {
    var t = readRaw(f);
    banned.forEach(function (re) { assert.ok(!re.test(t), rel(f) + " must not match " + re); });
  });
});

test("nothing is loaded from the network: no remote script, stylesheet, font or image", function () {
  pages.forEach(function (f) {
    var t = readRaw(f);
    assert.ok(!/<script\b[^>]*\bsrc="https?:/i.test(t), rel(f) + ": remote script");
    assert.ok(!/<link\b[^>]*\bhref="https?:/i.test(t), rel(f) + ": remote stylesheet or link");
    assert.ok(!/<(img|iframe)\b[^>]*\bsrc="https?:/i.test(t), rel(f) + ": remote image or frame");
    assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(t), rel(f) + ": remote @import");
  });
});

test("the gallery's own references exist: every look page, spec and thumbnail it lists", function () {
  var idx = readRaw(path.join(looksDir, "index.html"));
  var refs = idx.match(/(looks|specs|thumbs)\/[A-Za-z0-9._-]+\.(html|md|png)/g) || [];
  assert.ok(refs.length >= 54, "references found: " + refs.length);
  refs.forEach(function (r) { assert.ok(fs.existsSync(path.join(looksDir, r)), r + " exists"); });
});

console.log(passed + " passed");
