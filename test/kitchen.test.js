// Coverage for the Kitchen page's pure wording and rules (kitchen-logic.js), the Kitchen tile, and the page and menu entry around them: quantities and
// scaling (the same cases the Worker's tests use, so the two stay in step), cooking-mode timers, recipe search, the week's words, the pantry's words,
// plain-words errors, the page's security rules (no innerHTML, no inline styles, the logic loads first) and the owner-only menu entry.
//
//   node test/kitchen.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var L = require(path.join(root, "kitchen-logic.js"));
var Tile = require(path.join(root, "tile-kitchen.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

test("quantities are written as friendly fractions (the Worker's cases)", function () {
  assert.strictEqual(L.formatQuantity(1.5), "1½");
  assert.strictEqual(L.formatQuantity(0.3333), "⅓");
  assert.strictEqual(L.formatQuantity(0.75), "¾");
  assert.strictEqual(L.formatQuantity(2), "2");
  assert.strictEqual(L.formatQuantity(1.999), "2");
  assert.strictEqual(L.formatQuantity(2.37), "2⅜");
  assert.strictEqual(L.formatQuantity(2.2), "2.2");
  assert.strictEqual(L.formatQuantity(null), "");
});

test("ingredients scale and move up a unit (the Worker's cases)", function () {
  assert.strictEqual(L.formatIngredient({ q: 2, unit: "tbsp", name: "olive oil", note: "" }, 1.5), "3 tbsp olive oil");
  assert.strictEqual(L.formatIngredient({ q: 4, unit: "tsp", name: "sugar", note: "" }), "1 tbsp sugar");
  assert.strictEqual(L.formatIngredient({ q: 600, unit: "g", name: "flour", note: "" }, 2), "1.2 kg flour");
  assert.strictEqual(L.formatIngredient({ q: 2, unit: "clove", name: "garlic", note: "" }), "2 cloves garlic");
  assert.strictEqual(L.formatIngredient({ q: 1, unit: "clove", name: "garlic", note: "crushed" }), "1 clove garlic, crushed");
  assert.strictEqual(L.formatIngredient({ q: null, unit: "", name: "salt", note: "" }, 3), "salt");
  assert.strictEqual(L.formatIngredient({ q: 500, unit: "ml", name: "milk", note: "" }, 2), "1 L milk");
});

test("a recipe is scaled to other servings", function () {
  var r = { servings: 4, ingredients: [{ q: 2, unit: "", name: "onions", note: "" }, { q: 400, unit: "g", name: "lentils", note: "" }, { q: 1, unit: "tbsp", name: "oil", note: "" }] };
  assert.deepStrictEqual(L.scaledIngredients(r, 6).map(function (i) { return i.text; }), ["3 onions", "600 g lentils", "1½ tbsp oil"]);
  assert.deepStrictEqual(L.scaledIngredients(r, 2).map(function (i) { return i.text; }), ["1 onions", "200 g lentils", "½ tbsp oil"]);
});

test("the servings stepper goes one at a time, then in twos, and stays between 1 and 100", function () {
  assert.strictEqual(L.stepServings(4, 1), 5);
  assert.strictEqual(L.stepServings(4, -1), 3);
  assert.strictEqual(L.stepServings(1, -1), 1);
  assert.strictEqual(L.stepServings(12, 1), 14);
  assert.strictEqual(L.stepServings(14, -1), 12);
  assert.strictEqual(L.stepServings(100, 1), 100);
});

test("cooking mode finds the timers in a step, the longer end of a range", function () {
  assert.deepStrictEqual(L.parseStepTimers("Simmer for 10-15 minutes, then rest 2 hours."), [{ label: "15 min", seconds: 900 }, { label: "2 hours", seconds: 7200 }]);
  assert.deepStrictEqual(L.parseStepTimers("Bake 25 mins."), [{ label: "25 min", seconds: 1500 }]);
  assert.deepStrictEqual(L.parseStepTimers("Stir for 30 seconds"), [{ label: "30 sec", seconds: 30 }]);
  assert.deepStrictEqual(L.parseStepTimers("Chop the onion."), []);
  assert.deepStrictEqual(L.parseStepTimers("Add 2 cups of water"), []);
  assert.strictEqual(L.parseStepTimers("1 min 2 min 3 min 4 min 5 min").length, 4, "at most four buttons");
  assert.strictEqual(L.clock(754), "12:34");
  assert.strictEqual(L.clock(3725), "1:02:05");
  assert.strictEqual(L.clock(0), "0:00");
  assert.strictEqual(L.clock(-5), "0:00");
});

var INDEX = [
  { id: "rc_00000001", title: "Stir fry", tags: ["quick", "dinner"], rating: 3, keys: ["onion", "soy sauce"] },
  { id: "rc_00000002", title: "Apple pie", tags: ["dessert"], rating: 5, keys: ["apple", "flour"] },
  { id: "rc_00000003", title: "Bean soup", tags: ["dinner", "vegetarian"], rating: 4, keys: ["bean", "onion"] }
];

test("recipes are searched by title, ingredient and tag, filtered by tag and sorted", function () {
  var titles = function (a) { return a.map(function (r) { return r.title; }); };
  assert.deepStrictEqual(titles(L.filterRecipes(INDEX, "", "", "")), ["Stir fry", "Apple pie", "Bean soup"]);
  assert.deepStrictEqual(titles(L.filterRecipes(INDEX, "onion", "", "")), ["Stir fry", "Bean soup"]);
  assert.deepStrictEqual(titles(L.filterRecipes(INDEX, "PIE", "", "")), ["Apple pie"]);
  assert.deepStrictEqual(titles(L.filterRecipes(INDEX, "veg", "", "")), ["Bean soup"]);
  assert.deepStrictEqual(titles(L.filterRecipes(INDEX, "", "dinner", "rating")), ["Bean soup", "Stir fry"]);
  assert.deepStrictEqual(titles(L.filterRecipes(INDEX, "", "", "title")), ["Apple pie", "Bean soup", "Stir fry"]);
  assert.deepStrictEqual(L.filterRecipes(null, "x", "", ""), []);
  assert.deepStrictEqual(L.tagCounts(INDEX).slice(0, 1), [{ tag: "dinner", n: 2 }]);
});

test("stars, times and the week are in words", function () {
  assert.strictEqual(L.stars(3), "★★★☆☆");
  assert.strictEqual(L.stars(0), "");
  assert.strictEqual(L.minutesText(10, 20), "30 min");
  assert.strictEqual(L.minutesText(30, 45), "1 h 15 min");
  assert.strictEqual(L.minutesText(0, 60), "1 h");
  assert.strictEqual(L.minutesText(0, 0), "");
  assert.strictEqual(L.addDays("2026-10-26", 7), "2026-11-02");
  assert.strictEqual(L.dayText("2026-10-30"), "Fri 30 Oct");
  assert.strictEqual(L.weekLabel("2026-10-26", "2026-10-26"), "This week, 26 Oct – 1 Nov");
  assert.strictEqual(L.weekLabel("2026-11-02", "2026-10-26"), "Next week, 2 Nov – 8 Nov");
  assert.strictEqual(L.weekLabel("2026-10-19", "2026-10-26"), "Last week, 19 Oct – 25 Oct");
  assert.strictEqual(L.weekLabel("2026-12-07", "2026-10-26"), "7 Dec – 13 Dec");
  assert.strictEqual(L.dateForDay("2026-10-26", "fri"), "2026-10-30");
});

test("a plan slot says what it is in words", function () {
  var titles = { rc_00000001: "Stir fry" };
  assert.deepStrictEqual(L.slotText({ kind: "recipe", recipeId: "rc_00000001", servings: 6 }, titles), { text: "Stir fry (6)", tone: "recipe" });
  assert.deepStrictEqual(L.slotText({ kind: "recipe", recipeId: "rc_00000009" }, titles), { text: "A recipe that was removed", tone: "gone" });
  assert.deepStrictEqual(L.slotText({ kind: "leftovers" }, titles), { text: "Leftovers", tone: "left" });
  assert.deepStrictEqual(L.slotText({ kind: "out", note: "Pub" }, titles), { text: "Eating out: Pub", tone: "out" });
  assert.deepStrictEqual(L.slotText({ kind: "note", note: "Takeaway" }, titles), { text: "Takeaway", tone: "note" });
  assert.deepStrictEqual(L.slotText(null, titles), { text: "", tone: "" });
  var plan = { days: { mon: { dinner: { kind: "recipe", recipeId: "rc_00000001" }, lunch: { kind: "out" }, breakfast: null } } };
  assert.deepStrictEqual(L.planCounts(plan), { planned: 2, recipes: 1 });
});

test("the pantry's dates are in words and sorted soonest first", function () {
  assert.strictEqual(L.daysUntil("2026-11-01", "2026-10-30"), 2);
  assert.strictEqual(L.daysUntil("", "2026-10-30"), null);
  assert.strictEqual(L.bestBeforeText(3), "In 3 days");
  assert.strictEqual(L.bestBeforeText(1), "Best before tomorrow");
  assert.strictEqual(L.bestBeforeText(0), "Best before today");
  assert.strictEqual(L.bestBeforeText(-1), "Out of date yesterday");
  assert.strictEqual(L.bestBeforeText(-4), "4 days out of date");
  assert.strictEqual(L.bestBeforeText(null), "");
  assert.strictEqual(L.pantryTone(-1), "alert");
  assert.strictEqual(L.pantryTone(2), "attn");
  assert.strictEqual(L.pantryTone(20), "");
  assert.strictEqual(L.pantryTone(null), "");
  var sorted = L.sortPantry([{ name: "Rice", bestBefore: "" }, { name: "Milk", bestBefore: "2026-11-03" }, { name: "Bread", bestBefore: "2026-11-01" }, { name: "Beans", bestBefore: "" }]);
  assert.deepStrictEqual(sorted.map(function (i) { return i.name; }), ["Bread", "Milk", "Beans", "Rice"]);
});

test("errors are in plain words and never repeat what was typed", function () {
  assert.strictEqual(L.errorText({ error: "title_required" }, 400), "Give the recipe a title.");
  assert.ok(/password or key/.test(L.errorText({ error: "secret_detected", field: "notes", kind: "aws_key" }, 422)));
  assert.ok(!/aws_key|notes/.test(L.errorText({ error: "secret_detected", field: "notes", kind: "aws_key" }, 422)));
  assert.ok(/Sign in/.test(L.errorText({}, 401)));
  assert.ok(/owner/.test(L.errorText({}, 403)));
  assert.ok(/Could not reach/.test(L.errorText({}, 0)));
  assert.ok(/Too many/.test(L.errorText({}, 429)));
  assert.ok(/did not work \(weird_thing\)/.test(L.errorText({ error: "weird_thing" }, 500)));
});

test("the tile describes itself for the Overview board and words tonight and the list", function () {
  assert.strictEqual(Tile.descriptor.id, "kitchen");
  assert.strictEqual(Tile.descriptor.ownerOnly, true);
  assert.strictEqual(Tile.descriptor.permission, "tile.kitchen");
  assert.deepStrictEqual(Tile.lines({ tonight: { kind: "recipe", title: "Stir fry" }, toBuy: 3 }), { dinner: "Tonight: Stir fry", toBuy: "3 things left to buy." });
  assert.deepStrictEqual(Tile.lines({ tonight: null, toBuy: 0 }), { dinner: "Nothing planned for dinner tonight.", toBuy: "Nothing left to buy this week." });
  assert.strictEqual(L.glanceLine({ tonight: { kind: "out", note: "Pub" } }), "Tonight: eating out (Pub)");
  assert.strictEqual(L.glanceLine({ tonight: { kind: "leftovers" } }), "Tonight: leftovers");
  assert.strictEqual(L.toBuyLine(1), "1 thing left to buy.");
  var index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/src="tile-kitchen\.js(\?v=[0-9a-f]+)?"/.test(index));
  assert.ok(index.indexOf("kitchen-logic.js") !== -1 && index.indexOf("kitchen-logic.js") < index.indexOf("tile-kitchen.js"), "the wording loads before the tile");
  var tile = code(fs.readFileSync(path.join(root, "tile-kitchen.js"), "utf8"));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(tile));
  assert.ok(/\/kitchen\/glance/.test(tile));
});

test("kitchen.html is in the shell: container, wide, a title row without a blurb, strict CSP, the logic loaded before the page", function () {
  var html = fs.readFileSync(path.join(root, "kitchen.html"), "utf8");
  assert.ok(/<main id="page" class="content"/.test(html));
  assert.ok(/<body[^>]*data-shell="kitchen"[^>]*\bdata-wide\b/.test(html));
  assert.ok(/<div class="page-head">\s*<div>\s*<h1>Kitchen<\/h1>\s*<\/div>/.test(html), "the title is followed by the tabs, not a paragraph");
  assert.ok(/Content-Security-Policy" content="default-src 'self'; connect-src 'self' https:\/\/api\.barnyard\.site;/.test(html));
  assert.ok(!/unsafe-inline/.test(html));
  assert.ok(html.indexOf("kitchen-logic.js") !== -1 && html.indexOf("kitchen-logic.js") < html.indexOf("kitchen.js"));
  assert.ok(html.indexOf("shell.js") < html.indexOf("kitchen-logic.js"));
});

test("kitchen.js builds the page with textContent only, has no inline styles, and talks only to the Kitchen routes", function () {
  var src = fs.readFileSync(path.join(root, "kitchen.js"), "utf8");
  var c = code(src);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(c), "no HTML is built from text");
  assert.ok(!/\.style\b|setAttribute\("style"/.test(c), "no inline styles (the CSP forbids them)");
  assert.ok(!/\.href\s*=\s*(?!window\.barnyardLoginUrl)/.test(c.replace(/a\.href = window\.barnyardLoginUrl\(\)/, "")), "no link is built from server text");
  var paths = (c.match(/"\/kitchen\/[^"]*"/g) || []).map(function (s) { return s.replace(/"/g, "").replace(/\?.*$/, ""); });
  assert.ok(paths.length >= 10, "it talks to the kitchen routes");
  paths.forEach(function (p) { assert.ok(/^\/kitchen\/(recipes|recipe|recipe\/delete|week|plan|plan\/copy|pantry|list\/(tick|add|remove|stock))$/.test(p), "unexpected path " + p); });
  assert.ok(/credentials: "include"/.test(c));
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(c), "nothing is kept in the browser");
});

test("the stylesheet fits the shared container: no fixed-width page root, and it works on a phone", function () {
  var css = fs.readFileSync(path.join(root, "kitchen.css"), "utf8");
  assert.ok(!/#kt-root\s*\{[^}]*\bwidth\s*:\s*\d/.test(css));
  assert.ok(!/\bmain\s*\{[^}]*max-width/.test(css));
  assert.ok(/@media \(max-width: 720px\)/.test(css));
  assert.ok(/prefers-reduced-motion/.test(css));
});

test("the menu has a Kitchen entry in the Work group: owner only, its own permission, icon and palette words", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var line = shell.split("\n").filter(function (l) { return /id: "kitchen"/.test(l); })[0] || "";
  assert.ok(/title: "Kitchen"/.test(line));
  assert.ok(/group: "Work"/.test(line));
  assert.ok(/path: "kitchen\.html"/.test(line) && /local: "kitchen\.html"/.test(line));
  assert.ok(/ownerOnly: true/.test(line), "owner only");
  assert.ok(/perm: "kitchen\.view"/.test(line));
  assert.ok(/icon: "kitchen"/.test(line) && /kitchen: '<path/.test(shell), "its own icon is defined");
  assert.ok(/keywords: "[^"]*recipes[^"]*pantry[^"]*"/.test(line));
  assert.ok(/kitchen\\\.html\$\/\.test\(location\.pathname\)\) return "kitchen"/.test(shell), "the page lights its own menu entry");
});

console.log("\n" + passed + " passed");
