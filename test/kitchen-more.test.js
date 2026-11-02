// Coverage for the Kitchen's extras on the page: photos, reading a recipe from a web address, nutrition, sharing the week with invited people, and the cooking
// screen's keys. The wording and the small rules are in kitchen-logic.js (tested here); the page itself (kitchen.js) is checked for the same security rules as
// the rest of the Kitchen: textContent only, no inline styles, no links built from server text, only the Kitchen's own routes, and nothing kept in the browser.
//
//   node test/kitchen-more.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var L = require(path.join(root, "kitchen-logic.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

test("nutrition shows only the figures a recipe has, one decimal at most, and the form sends only the boxes with a number", function () {
  assert.deepStrictEqual(L.nutritionRows(null), []);
  assert.deepStrictEqual(L.nutritionRows({}), []);
  assert.deepStrictEqual(L.nutritionRows({ kcal: 450, proteinG: 30.04, sodiumMg: 800, junk: 1 }).map(function (r) { return r.label + ": " + r.text; }), ["Energy: 450 kcal", "Protein: 30 g", "Sodium: 800 mg"]);
  assert.deepStrictEqual(L.nutritionRows({ kcal: "450" }), [], "only real numbers");
  assert.deepStrictEqual(L.nutritionFromForm({ kcal: "450", proteinG: "", fatG: " 12,5 ", carbsG: "abc", sugarG: "0" }), { kcal: 450, fatG: 12.5, sugarG: 0 });
  assert.deepStrictEqual(L.nutritionFromForm({}), {});
  assert.deepStrictEqual(L.nutritionFromForm(null), {});
  assert.deepStrictEqual(L.NUTRIENTS.map(function (d) { return d[0]; }), ["kcal", "proteinG", "fatG", "carbsG", "sugarG", "fibreG", "sodiumMg"], "the same names the Worker takes");
});

test("a photo is shrunk to a long side of at most the limit, never enlarged", function () {
  assert.deepStrictEqual(L.fitSize(4000, 3000, 1280), { w: 1280, h: 960 });
  assert.deepStrictEqual(L.fitSize(3000, 4000, 1280), { w: 960, h: 1280 });
  assert.deepStrictEqual(L.fitSize(800, 600, 1280), { w: 800, h: 600 });
  assert.deepStrictEqual(L.fitSize(10000, 1, 100), { w: 100, h: 1 });
  assert.deepStrictEqual(L.fitSize(0, 5, 100), { w: 0, h: 0 });
  assert.deepStrictEqual(L.fitSize(NaN, 5, 100), { w: 0, h: 0 });
});

test("sharing says what each level allows, and every new Worker code has plain words", function () {
  assert.strictEqual(L.levelText("view"), "Can look");
  assert.strictEqual(L.levelText("edit"), "Can tick and add");
  assert.strictEqual(L.levelText("root"), "");
  ["photos_disabled", "image_type_invalid", "image_invalid", "image_too_large", "image_store_failed", "import_disabled", "url_invalid", "url_must_be_https", "host_not_allowed", "redirect_refused",
    "too_many_redirects", "page_unavailable", "page_unreachable", "page_timeout", "page_too_large", "not_html", "no_recipe", "recipe_unreadable", "import_limit", "nutrition_invalid",
    "share_disabled", "share_full", "person_unknown", "level_invalid", "not_shared", "read_only"].forEach(function (code) {
    var text = L.errorText({ error: code }, 400);
    assert.ok(text && text.indexOf("That did not work") !== 0, code + " has its own words");
    assert.ok(!/_/.test(text.replace(/KITCHEN_[A-Z]+_ENABLED/, "")), code + " does not show the code");
  });
  assert.ok(/KITCHEN_PHOTOS_ENABLED/.test(L.errorText({ error: "photos_disabled" }, 403)), "a switched-off extra names the variable to set");
  assert.ok(/KITCHEN_IMPORT_ENABLED/.test(L.errorText({ error: "import_disabled" }, 403)));
  assert.ok(/KITCHEN_SHARE_ENABLED/.test(L.errorText({ error: "share_disabled" }, 403)));
});

test("the cooking screen moves with the arrow keys and shows how far through you are", function () {
  assert.strictEqual(L.cookKey("ArrowRight"), 1);
  assert.strictEqual(L.cookKey("PageDown"), 1);
  assert.strictEqual(L.cookKey("ArrowLeft"), -1);
  assert.strictEqual(L.cookKey("PageUp"), -1);
  assert.strictEqual(L.cookKey("a"), 0);
  assert.strictEqual(L.cookPercent(0, 4), 25);
  assert.strictEqual(L.cookPercent(3, 4), 100);
  assert.strictEqual(L.cookPercent(9, 4), 100);
  assert.strictEqual(L.cookPercent(0, 0), 0);
});

test("kitchen.js keeps the Kitchen's security rules with the extras: textContent only, no inline styles, only Kitchen routes, nothing stored in the browser", function () {
  var src = fs.readFileSync(path.join(root, "kitchen.js"), "utf8");
  var c = code(src);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(c));
  assert.ok(!/\.style\b|setAttribute\("style"/.test(c));
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(c));
  assert.ok(!/\.href\s*=\s*(?!window\.barnyardLoginUrl)/.test(c.replace(/a\.href = window\.barnyardLoginUrl\(\)/, "")), "no link is built from server text");
  assert.ok(!/window\.open|location\s*=|location\.assign|location\.replace/.test(c), "the page never sends the browser anywhere");
  var apiStrings = (c.match(/"\/kitchen\/[^"]*"/g) || []).map(function (s) { return s.replace(/"/g, "").replace(/\?.*$/, ""); });
  ["/kitchen/photo", "/kitchen/photo/remove", "/kitchen/import", "/kitchen/share", "/kitchen/share/remove", "/kitchen/shared/me", "/kitchen/shared/week", "/kitchen/shared/tick", "/kitchen/shared/add"].forEach(function (p) {
    assert.ok(apiStrings.indexOf(p) !== -1, "talks to " + p);
  });
  apiStrings.forEach(function (p) { assert.ok(/^\/kitchen\/[a-z/]+$/.test(p), "unexpected path " + p); });
  // the only places an image address is set are the blob: address of the fetched photo
  var srcs = c.match(/\.src\s*=\s*[^;]+;/g) || [];
  srcs.forEach(function (s) { assert.ok(/model\.photoUrl|url;/.test(s), "image source set from: " + s); });
  assert.ok(/URL\.createObjectURL/.test(c) && /URL\.revokeObjectURL/.test(c), "the photo address is freed when it is not needed");
  assert.ok(/credentials: "include"/.test(c));
});

test("kitchen.html allows blob: images (the fetched photo) and still nothing else loose", function () {
  var html = fs.readFileSync(path.join(root, "kitchen.html"), "utf8");
  assert.ok(/img-src 'self' blob:;/.test(html));
  assert.ok(/default-src 'self'; connect-src 'self' https:\/\/api\.barnyard\.site; style-src 'self'; script-src 'self';/.test(html));
  assert.ok(!/unsafe-inline|unsafe-eval|data:/.test(html));
  var other = fs.readdirSync(root).filter(function (f) { return /\.html$/.test(f) && f !== "kitchen.html" && f !== "canvas.html"; });
  other.forEach(function (f) { assert.ok(!/img-src[^;]*blob:/.test(fs.readFileSync(path.join(root, f), "utf8")), f + " is unchanged"); });
});

test("the page offers the extras and says plainly what they do", function () {
  var c = code(fs.readFileSync(path.join(root, "kitchen.js"), "utf8"));
  ["Import from a web address", "Read the recipe", "Add a photo", "Remove photo", "Nutrition per serving", "Share the week with people you trust", "Invite to look", "Invite to tick and add", "Shared with you", "Bigger text"].forEach(function (s) {
    assert.ok(c.indexOf(s) !== -1, "mentions " + s);
  });
  assert.ok(/The Kitchen is the owner's\. Nothing has been shared with you\./.test(c), "someone who is not invited is told, not shown an error code");
  var css = fs.readFileSync(path.join(root, "kitchen.css"), "utf8");
  ["kt-photo", "kt-nutri", "kt-share-row", "kt-cook-progress"].forEach(function (cls) { assert.ok(css.indexOf("." + cls) !== -1, cls + " is styled"); });
});

console.log("\n" + passed + " passed");
