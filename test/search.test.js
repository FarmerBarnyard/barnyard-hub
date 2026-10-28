// Coverage for search.js's pure helpers (the page behind GET /hub/search) and the capture box's request builder
// in overview.js.
//
//   node test/search.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var Search = require(path.join(__dirname, "..", "search.js"));
var Overview = require(path.join(__dirname, "..", "overview.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("a query is 2 to 100 characters after tidying, otherwise it is not sent", function () {
  assert.strictEqual(Search.normalizeQuery("  dragon   map "), "dragon map");
  assert.strictEqual(Search.normalizeQuery("a"), null);
  assert.strictEqual(Search.normalizeQuery("  a  "), null);
  assert.strictEqual(Search.normalizeQuery(""), null);
  assert.strictEqual(Search.normalizeQuery(null), null);
  assert.strictEqual(Search.normalizeQuery("x".repeat(100)).length, 100);
  assert.strictEqual(Search.normalizeQuery("x".repeat(101)), null);
});

test("links are only ones the Worker could have made: an Ops item, or a study-site note or article", function () {
  assert.strictEqual(Search.safeHref("ops.html#it_abc12345"), "ops.html#it_abc12345");
  assert.strictEqual(Search.safeHref("https://study.barnyard.site/notes.html#n_abcdef12"), "https://study.barnyard.site/notes.html#n_abcdef12");
  assert.strictEqual(Search.safeHref("https://study.barnyard.site/knowledgebase.html#/a/ka_aaaaaaaa"), "https://study.barnyard.site/knowledgebase.html#/a/ka_aaaaaaaa");
  ["javascript:alert(1)", "https://evil.example/notes.html#x", "https://study.barnyard.site.evil.example/notes.html#x", "//evil.example", "ops.html#<script>", "", undefined, "https://study.barnyard.site/other.html#x"].forEach(function (bad) {
    assert.strictEqual(Search.safeHref(bad), "", String(bad));
  });
});

test("counts and one-line group statuses", function () {
  var data = { groups: [{ id: "ops", items: [1, 2] }, { id: "notebook", items: [] }, { id: "kb", items: [1] }] };
  assert.strictEqual(Search.totalCount(data), 3);
  assert.strictEqual(Search.totalCount(null), 0);
  assert.strictEqual(Search.groupStatus({ items: [1, 2] }), "2 results");
  assert.strictEqual(Search.groupStatus({ items: [1] }), "1 result");
  assert.strictEqual(Search.groupStatus({ items: [] }), "No results");
  assert.strictEqual(Search.groupStatus({ items: [], error: true }), "Couldn’t be searched just now");
  assert.strictEqual(Search.groupStatus({ items: [], skipped: true }), "Not available to this account");
  assert.strictEqual(Search.pageUrl("dragon map"), "search.html?q=dragon%20map");
  assert.strictEqual(Search.pageUrl(""), "search.html");
});

test("capture: a note goes to the hub route whole; an item or proposal goes to the board with the first line as its title", function () {
  var note = Overview.buildCapture("note", "  Call the farrier\nabout the mare  ");
  assert.deepStrictEqual(note, { base: "hub", path: "/capture", body: { text: "Call the farrier\nabout the mare" } });

  var item = Overview.buildCapture("item", "Fix the gate");
  assert.deepStrictEqual(item, { base: "ops", path: "/items", body: { title: "Fix the gate", lane: "backlog", category: "other", owner: "you" } });

  var multi = Overview.buildCapture("item", "Fix the gate\nthe hinge is rusted");
  assert.strictEqual(multi.body.title, "Fix the gate");
  assert.strictEqual(multi.body.details, "Fix the gate\nthe hinge is rusted", "the rest is kept");

  var prop = Overview.buildCapture("proposal", "Add a bell");
  assert.strictEqual(prop.body.proposal, true);
  assert.strictEqual(prop.body.owner, undefined, "a proposal is for Claude to pick up, not yours");
  assert.strictEqual(prop.body.lane, "backlog");
});

test("capture: nothing to file, a title that is too long, or text too long for its kind", function () {
  assert.strictEqual(Overview.buildCapture("note", "   "), null);
  assert.strictEqual(Overview.buildCapture("item", ""), null);
  assert.strictEqual(Overview.buildCapture("weird", "x"), null);
  assert.strictEqual(Overview.buildCapture("note", "x".repeat(8001)), null);
  assert.ok(Overview.buildCapture("note", "x".repeat(8000)));
  assert.strictEqual(Overview.buildCapture("item", "x".repeat(6001)), null);
  var long = Overview.buildCapture("item", "w".repeat(300));
  assert.strictEqual(long.body.title.length, 120, "the title is cut to the board's limit");
  assert.strictEqual(long.body.details.length, 300, "and nothing is lost");
});

test("the search page is wired: strict CSP, no inline script or style, text only by textContent", function () {
  var html = fs.readFileSync(path.join(root, "search.html"), "utf8");
  assert.ok(html.indexOf("script-src 'self'") !== -1 && html.indexOf("style-src 'self'") !== -1);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
  assert.ok(!/\sstyle=/.test(html));
  var js = fs.readFileSync(path.join(root, "search.js"), "utf8");
  assert.ok(!/\.innerHTML\s*\+?=|insertAdjacentHTML|document\.write/.test(js));
  var idx = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/src="tile-capture\.js/.test(idx) && idx.indexOf("script-src 'self'") !== -1, "the capture tile is loaded by the page, with no inline script");
  var ov = fs.readFileSync(path.join(root, "overview.js"), "utf8");
  assert.ok(ov.indexOf('["Search everything", "search.html"]') !== -1 && ov.indexOf('["Activity", "activity.html"]') !== -1);
});

console.log("\n" + passed + " tests passed");
