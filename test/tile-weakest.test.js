// Coverage for tile-weakest.js (the Overview's Weakest links tile): what it says for an empty register, an unlinked one, a clean
// one and one with gaps, and that it reads only GET /reg/summary through the shared helper. The drawing was checked in a browser.
//
//   node test/tile-weakest.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var T = require(path.join(__dirname, "..", "tile-weakest.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function links(over) { return { links: Object.assign({ assets: 24, links: 36, linked: 20, unlinked: 4, cycles: 0, weakest: [] }, over) }; }

test("model: empty, unlinked, clean and weak", function () {
  assert.strictEqual(T.model(null).state, "empty");
  assert.strictEqual(T.model({}).state, "empty");
  assert.strictEqual(T.model(links({ assets: 5, links: 0, linked: 0, unlinked: 5 })).state, "unlinked");
  assert.strictEqual(T.model(links()).state, "clean");
  var weak = T.model(links({ weakest: [{ id: "as_aaaaaaaaaa", name: "app02", kind: "server", criticality: "high", dependents: 7, gaps: ["backup", "runbook"] }] }));
  assert.strictEqual(weak.state, "weak");
  assert.strictEqual(weak.weakest[0].line, "7 things depend on it; no backup job names it, no runbook");
  assert.strictEqual(weak.weakest[0].tone, "alert");
  assert.strictEqual(weak.linked, 20);
});

test("the tile is described for the Overview board: owner only, tile.weakest, sizes in order", function () {
  var d = T.descriptor;
  assert.strictEqual(d.id, "weakest");
  assert.strictEqual(d.permission, "tile.weakest");
  assert.strictEqual(d.ownerOnly, true);
  assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH && d.maxW <= 12);
});

test("the tile reads only the shared registry summary and links to the map", function () {
  var src = fs.readFileSync(path.join(root, "tile-weakest.js"), "utf8");
  assert.ok(src.indexOf("K.summary()") !== -1);
  assert.ok(!/K\.call\(/.test(src), "no call of its own");
  assert.ok(src.indexOf('"map.html"') !== -1);
  assert.ok(!/innerHTML/.test(src), "text only");
});

test("the shared summary: one call for tiles that load together, forgotten after a write or a failure", function () {
  var src = fs.readFileSync(path.join(root, "tile-kit.js"), "utf8");
  assert.ok(/function summary\(\)/.test(src) && /summaryMemo\.p = null/.test(src));
  assert.ok(/if \(method !== "GET"\) summaryMemo\.p = null;/.test(src), "any write forgets it");
  ["tile-assets.js", "tile-backups.js", "tile-weakest.js"].forEach(function (f) {
    assert.ok(fs.readFileSync(path.join(root, f), "utf8").indexOf("K.summary()") !== -1, f + " uses it");
    assert.ok(!/K\.call\("GET", "\/reg\/summary"\)/.test(fs.readFileSync(path.join(root, f), "utf8")), f + " makes no summary call of its own");
  });
});

console.log("\n" + passed + " passed");
