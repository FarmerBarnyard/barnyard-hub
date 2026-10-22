// Coverage for md-pdf.js's pure helpers and the page's safety rules (Markdown to PDF, md-pdf.html).
//
//   node test/md-pdf.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Pdf = require(path.join(__dirname, "..", "md-pdf.js"));
var Markdown = require(path.join(__dirname, "..", "markdown.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("the @page rule names the paper, the orientation and the margin", function () {
  assert.strictEqual(Pdf.pageRule("A4", "portrait", 20), "@page { size: A4 portrait; margin: 20mm; }");
  assert.strictEqual(Pdf.pageRule("Letter", "landscape", "12"), "@page { size: Letter landscape; margin: 12mm; }");
});

test("unknown paper, orientation or margin fall back to A4 portrait 20mm, and nothing else can reach the rule", function () {
  assert.strictEqual(Pdf.pageRule("A3; } body { display:none", "sideways", "abc"), "@page { size: A4 portrait; margin: 20mm; }");
  assert.strictEqual(Pdf.pageRule("toString", "portrait", 20), "@page { size: A4 portrait; margin: 20mm; }");
  assert.strictEqual(Pdf.pageRule("A5", "portrait", -5), "@page { size: A5 portrait; margin: 20mm; }");
  assert.strictEqual(Pdf.pageRule("A5", "portrait", 999), "@page { size: A5 portrait; margin: 20mm; }");
});

test("the PDF's name comes from the first heading, else the first line, with the marks stripped", function () {
  assert.strictEqual(Pdf.titleOf("intro text\n\n# The *Big* Plan\n\nmore"), "The Big Plan");
  assert.strictEqual(Pdf.titleOf("## [Docs](https://x.example) ##"), "Docs");
  assert.strictEqual(Pdf.titleOf("\n\nJust a line of text"), "Just a line of text");
  assert.strictEqual(Pdf.titleOf("   \n\n"), "Document");
  assert.strictEqual(Pdf.titleOf(null), "Document");
  assert.strictEqual(Pdf.titleOf("# " + "x".repeat(200)).length, 80);
});

test("counting words and cleaning a Windows file", function () {
  assert.deepStrictEqual(Pdf.stats("one two\nthree"), { words: 3, chars: 13 });
  assert.deepStrictEqual(Pdf.stats(""), { words: 0, chars: 0 });
  assert.strictEqual(Pdf.clean("﻿a\r\nb\rc"), "a\nb\nc");
});

test("the renderer the tool relies on keeps tables and headings, and refuses script links", function () {
  var tree = Markdown.parse("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  var kinds = tree.map(function (n) { return n.t || n.type; });
  assert.ok(kinds.length >= 2 && JSON.stringify(tree).indexOf("Title") !== -1 && JSON.stringify(tree).indexOf('"rows"') !== -1, JSON.stringify(kinds));
  assert.strictEqual(Markdown.safeUrl("javascript:alert(1)"), null);
  assert.strictEqual(Markdown.safeUrl("https://example.com/a"), "https://example.com/a");
});

test("the page has no inline script or style, no network, and the script never writes markup", function () {
  var html = fs.readFileSync(path.join(root, "md-pdf.html"), "utf8");
  assert.ok(html.indexOf("connect-src 'none'") !== -1 && html.indexOf("script-src 'self'") !== -1 && html.indexOf("style-src 'self'") !== -1);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/\sstyle=/.test(html) && !/<style/.test(html), "no inline style");
  assert.ok(!/\son[a-z]+=/.test(html), "no inline handlers");
  var js = fs.readFileSync(path.join(root, "md-pdf.js"), "utf8");
  assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write|\bfetch\(|XMLHttpRequest|sendBeacon/.test(js));
  ["mp-file", "mp-size", "mp-orient", "mp-margin", "mp-font", "mp-face", "mp-clear", "mp-print", "mp-src", "mp-doc", "mp-sheet", "mp-count"].forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, id + " is in the page");
  });
});

test("the print styles hide everything but the preview", function () {
  var css = fs.readFileSync(path.join(root, "md-pdf.css"), "utf8");
  var print = css.slice(css.indexOf("@media print"));
  assert.ok(/\.mp-bar/.test(print) && /\.mp-pane:first-child/.test(print) && /\.side\b/.test(print) && /\.top\b/.test(print) && /\.app, \.main/.test(print));
});

test("the overview links to the tool", function () {
  var ov = fs.readFileSync(path.join(root, "overview.js"), "utf8");
  assert.ok(ov.indexOf('["Markdown to PDF", "md-pdf.html"]') !== -1);
});

console.log("\n" + passed + " tests passed");
