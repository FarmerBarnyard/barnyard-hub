// CSS contract for the Ops board layout. A browser is not available to the test run, so this reads the stylesheets and
// pins the rules that keep the board from squeezing, overlapping or spilling:
//
//   node test/ops-layout.test.js
//
// The bug this guards against: the side rail used to switch on at a window width (1900px) and size itself from
// 100vw, while a look may cap the page far narrower than the window. The board then got ~120px lanes, chips ran over
// card edges and neighbouring lanes overlapped. The layout must follow the room the board really has (container
// queries), never the window.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
function read(f) { return fs.readFileSync(path.join(root, f), "utf8").split("\r\n").join("\n"); }
var ops = read("ops.css");
var shell = read("shell.css");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

// The text of the rule block that starts with `selector {` (first match), or "".
function block(css, selector) {
  var i = css.indexOf(selector + " {");
  if (i < 0) return "";
  return css.slice(i, css.indexOf("}", i) + 1);
}
// Everything inside an at-rule that starts with `head` (balanced braces).
function atRule(css, head) {
  var i = css.indexOf(head);
  if (i < 0) return "";
  var depth = 0, j = css.indexOf("{", i);
  for (var k = j; k < css.length; k++) {
    if (css[k] === "{") depth++;
    else if (css[k] === "}") { depth--; if (depth === 0) return css.slice(j + 1, k); }
  }
  return "";
}

test("the board area and the board are size containers", function () {
  assert.ok(/\.ops-content \{[^}]*container: ops-content \/ inline-size/.test(ops));
  assert.ok(/\.ops-main \{[^}]*min-width: 0[^}]*container: ops-main \/ inline-size/.test(ops));
});

test("lanes are 4 / 2 / 1 columns by the board's own width, every track minmax(0, 1fr)", function () {
  assert.ok(/\.ops-lanes \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/.test(ops));
  var two = /@container ops-main \(max-width: (\d+)px\) \{ \.ops-lanes \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.exec(ops);
  var one = /@container ops-main \(max-width: (\d+)px\) \{ \.ops-lanes \{ grid-template-columns: minmax\(0, 1fr\)/.exec(ops);
  assert.ok(two && one, "both container rules exist");
  // a lane never narrower than 230px: 4 lanes + 3 gaps of 22px = 986, 2 lanes + 1 gap = 482
  assert.ok(+two[1] + 1 >= 4 * 230 + 3 * 22 - 2, "4 across needs about 986px");
  assert.ok(+one[1] + 1 >= 2 * 230 + 22 - 2, "2 across needs about 482px");
  assert.ok(/\.ops-lane \{ min-width: 0; \}/.test(ops));
  assert.ok(!/@media[^{]*\{\s*\.ops-lanes/.test(ops), "no window-width rule for the lane columns");
});

test("the rail goes beside the board by container width, and is never sized from the window", function () {
  assert.ok(!/@media \(min-width: 1900px\) \{[^@]*\.ops-workspace\.has-rail/.test(ops), "no window-width rail rule");
  var q = atRule(ops, "@container ops-content (min-width:");
  assert.ok(q.indexOf(".ops-workspace.has-rail { display: grid") >= 0, "rail grid is inside the container query");
  var min = /@container ops-content \(min-width: (\d+)px\)/.exec(ops);
  assert.ok(min && +min[1] >= 1400, "rail only when the area can hold 4 lanes plus a 320px rail");
  assert.ok(!/100vw/.test(q), "the rail width does not use 100vw");
  assert.ok(/minmax\(0, 1fr\) clamp\(320px, calc\(100cqw/.test(q), "main column is minmax(0, 1fr)");
  assert.ok(/\.ops-rail \{[^}]*min-width: 0/.test(q) || /\.ops-workspace\.has-rail \.ops-rail \{[^}]*min-width: 0/.test(q));
});

test("cards, chips and long words wrap instead of spilling over the card edge", function () {
  var tile = block(ops, ".ops-tile");
  assert.ok(/min-width: 0/.test(tile) && /overflow-wrap: anywhere/.test(tile) && /box-sizing: border-box/.test(tile));
  assert.ok(/\.ops-tile-meta \{[^}]*flex-wrap: wrap/.test(ops));
  assert.ok(/\.ops-tile-meta > \* \{[^}]*max-width: 100%/.test(ops));
  assert.ok(/\.ops-tile-meta \.ops-chip \{[^}]*white-space: normal[^}]*overflow-wrap: anywhere/.test(ops));
  assert.ok(/\.ops-tile-foot \{[^}]*flex-wrap: wrap/.test(ops));
  assert.ok(/\.ops-lane-title \{[^}]*overflow-wrap: anywhere/.test(ops));
  assert.ok(/\.ops-rail-title \{[^}]*overflow-wrap: anywhere/.test(ops));
});

test("no look layer re-sizes the board's columns", function () {
  fs.readdirSync(path.join(root, "look-layers")).filter(function (f) { return /\.css$/.test(f); }).forEach(function (f) {
    var css = read("look-layers/" + f);
    assert.ok(!/\.ops-(lanes|workspace|main|rail)\b[^{]*\{[^}]*(grid-template-columns|width)\s*:/.test(css), f + " sets the board's columns");
  });
});

test("the passing note (toast) sits bottom-left, small, and lets clicks through", function () {
  var t = block(shell, ".toast");
  assert.ok(/position: fixed/.test(t) && /left: 16px/.test(t) && /bottom: 16px/.test(t));
  assert.ok(!/left: 50%/.test(t) && !/translateX/.test(t), "no longer centred over the page");
  assert.ok(/pointer-events: none/.test(t));
  assert.ok(/max-width: min\(360px/.test(t));
  assert.ok(/@media \(max-width: 860px\) \{[\s\S]*?\.toast \{ bottom: calc\(76px/.test(shell), "above the phone navigation bar");
});

console.log("\n" + passed + " passed");
