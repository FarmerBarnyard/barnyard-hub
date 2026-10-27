// Coverage for tile-kit.js's pure helpers (shared by the operations tiles): money, dates, plain-words error text, the tile
// registry, and the rules every tile file must follow (no innerHTML, no inline styles, no remote resources).
//
//   node test/tile-kit.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var K = require(path.join(__dirname, "..", "tile-kit.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("money reads as dollars, drops empty cents, and names a foreign currency", function () {
  assert.strictEqual(K.moneyText(125000), "$1,250");
  assert.strictEqual(K.moneyText(1250), "$12.50");
  assert.strictEqual(K.moneyText(0), "$0");
  assert.strictEqual(K.moneyText(500, "USD"), "$5 USD");
  assert.strictEqual(K.moneyText(null), "");
  assert.strictEqual(K.moneyText(NaN), "");
});

test("a typed amount becomes cents, empty means unknown, anything odd is refused", function () {
  assert.strictEqual(K.parseMoney("12.50"), 1250);
  assert.strictEqual(K.parseMoney(" $1,200 "), 120000);
  assert.strictEqual(K.parseMoney("0"), 0);
  assert.strictEqual(K.parseMoney("19.9"), 1990);
  assert.strictEqual(K.parseMoney(""), null);
  assert.strictEqual(K.parseMoney(null), null);
  ["abc", "1.234", "-5", "1e3", "12.5.0"].forEach(function (bad) { assert.ok(isNaN(K.parseMoney(bad)), bad); });
});

test("days to a date, said in words, and how urgent that is", function () {
  var now = Date.parse("2026-10-27T15:00:00Z");
  assert.strictEqual(K.dayDiff("2026-10-27", now), 0);
  assert.strictEqual(K.dayDiff("2026-11-26", now), 30);
  assert.strictEqual(K.dayDiff("2026-10-20", now), -7);
  assert.strictEqual(K.dayDiff("soon", now), null);
  assert.strictEqual(K.daysText(0), "today");
  assert.strictEqual(K.daysText(1), "tomorrow");
  assert.strictEqual(K.daysText(-1), "yesterday");
  assert.strictEqual(K.daysText(12), "in 12 days");
  assert.strictEqual(K.daysText(-3), "3 days ago");
  assert.strictEqual(K.daysText(null), "");
  assert.strictEqual(K.urgency(-2), "alert");
  assert.strictEqual(K.urgency(7), "alert");
  assert.strictEqual(K.urgency(8), "attn");
  assert.strictEqual(K.urgency(30), "attn");
  assert.strictEqual(K.urgency(31), "ok");
  assert.strictEqual(K.urgency(null), "");
  assert.strictEqual(K.dateText("2027-05-03"), "3 May 2027");
  assert.strictEqual(K.dateText("nope"), "");
});

test("ago says how long, never a date", function () {
  var now = 1000000000000;
  assert.strictEqual(K.agoText(0, now), "never");
  assert.strictEqual(K.agoText(now - 5000, now), "just now");
  assert.strictEqual(K.agoText(now - 5 * 60000, now), "5 min ago");
  assert.strictEqual(K.agoText(now - 3 * 3600000, now), "3 h ago");
  assert.strictEqual(K.agoText(now - 86400000, now), "1 day ago");
  assert.strictEqual(K.agoText(now - 5 * 86400000, now), "5 days ago");
});

test("the Worker's error codes become plain words, and a refused secret never repeats the text", function () {
  assert.ok(/recent sign-in/.test(K.errorText({ error: "recent_sign_in_required" }, 403)));
  var secret = K.errorText({ error: "secret_detected", field: "notes", kind: "aws_key" }, 422);
  assert.ok(/password or key in the notes field/.test(secret));
  assert.ok(!/aws_key/.test(secret));
  assert.ok(/Check the name field/.test(K.errorText({ error: "name_invalid" }, 400)));
  assert.ok(/notes text is too long/.test(K.errorText({ error: "notes_too_long" }, 400)));
  assert.ok(/Could not reach the Worker/.test(K.errorText({}, 0)));
  assert.ok(/not switched on/.test(K.errorText({ error: "registry_unavailable" }, 503)));
  assert.ok(/only for the hub owner/.test(K.errorText(null, 403)));
  assert.ok(/did not work/.test(K.errorText({ error: "weird" }, 500)));
  assert.strictEqual(K.needsSignIn({ error: "recent_sign_in_required" }, 403), true);
  assert.strictEqual(K.needsSignIn({}, 401), true);
  assert.strictEqual(K.needsSignIn({ error: "name_required" }, 400), false);
});

test("plural keeps one as it is", function () {
  assert.strictEqual(K.plural(1, "entry", "entries"), "1 entry");
  assert.strictEqual(K.plural(3, "entry", "entries"), "3 entries");
  assert.strictEqual(K.plural(2, "item"), "2 items");
});

test("a tile registers with an id and a render function, and is found again", function () {
  assert.throws(function () { K.register({ id: "x" }); });
  assert.throws(function () { K.register(null); });
  var t = K.register({ id: "probe", title: "Probe", render: function () {} });
  assert.strictEqual(K.tiles.probe, t);
  assert.ok(K.list().some(function (x) { return x.id === "probe"; }));
  delete K.tiles.probe;
});

test("every tile file follows the page rules: no innerHTML, no inline style, no outside address, owner-only registration", function () {
  var files = fs.readdirSync(root).filter(function (f) { return /^tile-.*\.js$/.test(f); });
  assert.ok(files.length >= 2, "tile-kit.js and at least one tile");
  files.forEach(function (f) {
    var src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|outerHTML\s*=/.test(src), f + " builds markup from strings");
    assert.ok(!/\.style\.|setAttribute\(["']style/.test(src), f + " sets an inline style");
    assert.ok(!/https?:\/\/(?!api\.barnyard\.site)/.test(src.replace(/\/\/[^\n]*/g, "")), f + " names another address");
    assert.ok(!/eval\(|new Function\(/.test(src), f + " runs a string as code");
  });
  var css = fs.readFileSync(path.join(root, "tiles.css"), "utf8");
  assert.ok(!/url\(\s*["']?https?:/.test(css), "tiles.css loads nothing remote");
  assert.ok(!/@import/.test(css), "tiles.css imports nothing");
});

test("the Overview loads the toolkit and every tile file before the board adopts them, and the stylesheet", function () {
  var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  var pos = function (re) { var m = re.exec(html); return m ? m.index : -1; };
  var kit = pos(/src="tile-kit\.js/), board = pos(/src="board\.js/), overview = pos(/src="overview\.js/);
  assert.ok(kit > -1 && kit < board && board < overview, "tile-kit.js comes first");
  fs.readdirSync(root).filter(function (f) { return /^tile-.*\.js$/.test(f) && f !== "tile-kit.js"; }).forEach(function (f) {
    var at = pos(new RegExp('src="' + f.replace(".", "\\.") + "[?\"]"));
    assert.ok(at > kit && at < board, f + " is loaded on the Overview before the board");
  });
  assert.ok(/href="tiles\.css/.test(html), "the tiles' stylesheet is linked");
});

console.log("\n" + passed + " passed");
