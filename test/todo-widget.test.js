// Basic unit coverage for todo-widget.js's pure localStorage
// serialize/parse/sanitize logic -- same rationale and pattern as
// test/live-prices.test.js and test/glance-widgets.test.js: this repo has
// no build step and no package.json, so this is a plain Node script using
// only the standard library (`assert`), run with:
//
//   node test/todo-widget.test.js
//
// Deliberately does NOT spin up a DOM/jsdom or a localStorage stand-in --
// todo-widget.js exports its pure, storage-free helpers via a
// `module.exports` guard (a no-op in the browser) specifically so this file
// can require() it directly. DOM/localStorage-facing functions (loadTodos,
// saveTodos, renderTodos, addTodo, etc.) are out of scope here.

var assert = require("assert");
var path = require("path");
var todo = require(path.join(__dirname, "..", "todo-widget.js"));

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// ---- sanitizeTodos ---------------------------------------------------------

test("sanitizeTodos keeps well-formed items as-is", function () {
  var input = [{ id: "a", text: "Buy milk", done: false }, { id: "b", text: "Walk dog", done: true }];
  assert.deepStrictEqual(todo.sanitizeTodos(input), input);
});

test("sanitizeTodos returns [] for non-array input", function () {
  assert.deepStrictEqual(todo.sanitizeTodos(null), []);
  assert.deepStrictEqual(todo.sanitizeTodos(undefined), []);
  assert.deepStrictEqual(todo.sanitizeTodos("not an array"), []);
  assert.deepStrictEqual(todo.sanitizeTodos({ 0: { text: "x" } }), []);
});

test("sanitizeTodos drops entries with a missing/non-string text", function () {
  var input = [{ id: "a", text: 42, done: false }, { id: "b", done: false }, null, "oops"];
  assert.deepStrictEqual(todo.sanitizeTodos(input), []);
});

test("sanitizeTodos drops entries whose text is empty/whitespace-only after trimming", function () {
  var input = [{ id: "a", text: "   ", done: false }, { id: "b", text: "", done: false }];
  assert.deepStrictEqual(todo.sanitizeTodos(input), []);
});

test("sanitizeTodos trims text and truncates to 200 characters", function () {
  var longText = new Array(250).join("x"); // 249 chars
  var input = [{ id: "a", text: "  hello  ", done: false }, { id: "b", text: longText, done: false }];
  var out = todo.sanitizeTodos(input);
  assert.strictEqual(out[0].text, "hello");
  assert.strictEqual(out[1].text.length, 200);
});

test("sanitizeTodos coerces done to a strict boolean", function () {
  var input = [{ id: "a", text: "x", done: "true" }, { id: "b", text: "y", done: 1 }, { id: "c", text: "z", done: true }];
  var out = todo.sanitizeTodos(input);
  assert.strictEqual(out[0].done, false);
  assert.strictEqual(out[1].done, false);
  assert.strictEqual(out[2].done, true);
});

test("sanitizeTodos generates an id when one is missing or not a string", function () {
  var out = todo.sanitizeTodos([{ text: "no id here", done: false }, { id: 123, text: "numeric id", done: false }]);
  assert.strictEqual(typeof out[0].id, "string");
  assert.ok(out[0].id.length > 0);
  assert.strictEqual(typeof out[1].id, "string");
  assert.ok(out[1].id.length > 0);
});

// ---- parseTodosJson ---------------------------------------------------------

test("parseTodosJson returns [] for null/empty/non-string input", function () {
  assert.deepStrictEqual(todo.parseTodosJson(null), []);
  assert.deepStrictEqual(todo.parseTodosJson(undefined), []);
  assert.deepStrictEqual(todo.parseTodosJson(""), []);
});

test("parseTodosJson returns [] for malformed JSON rather than throwing", function () {
  assert.deepStrictEqual(todo.parseTodosJson("{not valid json"), []);
});

test("parseTodosJson round-trips a valid serialized list", function () {
  var list = [{ id: "a", text: "Buy milk", done: false }];
  var json = JSON.stringify(list);
  assert.deepStrictEqual(todo.parseTodosJson(json), list);
});

// ---- serializeTodos ---------------------------------------------------------

test("serializeTodos produces JSON that parseTodosJson reads back identically", function () {
  var list = [{ id: "a", text: "Buy milk", done: false }, { id: "b", text: "Walk dog", done: true }];
  var json = todo.serializeTodos(list);
  assert.deepStrictEqual(todo.parseTodosJson(json), list);
});

test("serializeTodos sanitizes before serializing (drops invalid entries)", function () {
  var json = todo.serializeTodos([{ id: "a", text: "keep me", done: false }, { text: "   " }, "garbage"]);
  assert.deepStrictEqual(JSON.parse(json), [{ id: "a", text: "keep me", done: false }]);
});

console.log(passed + " passed");
