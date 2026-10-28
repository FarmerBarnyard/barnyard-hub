// Coverage for tile-plan.js (the Overview's "Today's plan" tile): what it says with no plan, a plan with things to do, a finished plan and a
// running timer, and that it reads only GET /planner/all. The drawing was checked in a browser.
//
//   node test/tile-plan.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var T = require(path.join(__dirname, "..", "tile-plan.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var DAY = "2026-10-26";
var A = { id: "td_0000000a", title: "Write the report", status: "open" };
var B = { id: "td_0000000b", title: "Reply to the committee", status: "open" };
var C = { id: "td_0000000c", title: "Ticked off", status: "done" };
function planner(blocks, extra) { return { tasks: [A, B, C], plan: Object.assign({ settings: {}, blocks: blocks, timer: null, ratios: {}, worked: [] }, extra || {}) }; }
function blk(id, task, start, end, state, date) { return { id: id, taskId: task.id, date: date || DAY, start: start, end: end, locked: false, state: state }; }

test("no plan data (an older Worker) says so; nothing accepted says to open the plan", function () {
  assert.strictEqual(T.model(null, DAY, 540).state, "off");
  assert.strictEqual(T.model({ tasks: [] }, DAY, 540).state, "off");
  var m = T.model(planner([]), DAY, 540);
  assert.deepStrictEqual([m.state, m.headline, m.total], ["empty", "No plan for today yet.", 0]);
  assert.strictEqual(T.model(planner([blk("bk_1", A, "09:00", "10:00", "planned", "2026-10-27")]), DAY, 540).state, "empty", "tomorrow's blocks are not today's plan");
});

test("a plan: what is next, how many are done, and time worked", function () {
  var blocks = [
    blk("bk_1", A, "08:00", "08:50", "done"), blk("bk_2", B, "13:00", "13:30", "planned"), blk("bk_3", A, "10:00", "11:00", "planned"),
    blk("bk_4", C, "14:00", "15:00", "planned"), blk("bk_5", B, "15:00", "15:30", "skipped")
  ];
  var m = T.model(planner(blocks, { worked: [{ date: DAY, minutes: 50 }, { date: "2026-10-25", minutes: 300 }] }), DAY, 9 * 60);
  assert.strictEqual(m.state, "ok");
  assert.deepStrictEqual(m.next.map(function (b) { return b.id; }), ["bk_3", "bk_2"], "soonest first; a ticked-off to-do and skipped block are left out");
  assert.strictEqual(m.headline, "Next: 10:00 · Write the report");
  assert.deepStrictEqual([m.done, m.total, m.workedMin], [1, 3, 50]);
  assert.strictEqual(T.nextLine(m.next[0]), "10:00  Write the report · 1 h");
});

test("when everything is done the headline says so", function () {
  var m = T.model(planner([blk("bk_1", A, "08:00", "08:50", "done"), blk("bk_2", B, "09:00", "09:30", "planned")]), DAY, 17 * 60);
  assert.strictEqual(m.headline, "That’s today’s plan done: 1 of 2 blocks.", "a block whose time has passed is no longer next, and it is not counted done unless it was");
});

test("a running timer shows the task and its elapsed time; a paused one says paused", function () {
  var running = T.model(planner([], { timer: { taskId: A.id, blockId: "", startedAt: 1000, accMs: 60000, running: true } }), DAY, 540, 31000);
  assert.deepStrictEqual([running.timer.title, running.timer.running, running.timer.elapsedMs], ["Write the report", true, 90000]);
  var paused = T.model(planner([], { timer: { taskId: B.id, blockId: "", startedAt: 0, accMs: 120000, running: false } }), DAY, 540, 31000);
  assert.deepStrictEqual([paused.timer.running, paused.timer.elapsedMs], [false, 120000]);
  assert.strictEqual(T.model(planner([], { timer: { taskId: "td_gone0000", running: true, startedAt: 0, accMs: 0 } }), DAY, 540).timer, null, "a timer on a deleted to-do is not shown");
});

test("the tile reads only GET /planner/all, is owner-only, and has its own permission", function () {
  var src = fs.readFileSync(path.join(root, "tile-plan.js"), "utf8");
  var calls = src.match(/K\.call\("[A-Z]+", "[^"]+"\)/g) || [];
  assert.deepStrictEqual(calls, ['K.call("GET", "/planner/all")']);
  assert.strictEqual(T.descriptor.id, "plan");
  assert.strictEqual(T.descriptor.ownerOnly, true);
  assert.strictEqual(T.descriptor.permission, "tile.plan");
  assert.ok(/document\.hidden/.test(src), "its refresh pauses in a hidden tab");
  var html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf("planner-engine.js") > 0 && html.indexOf("planner-engine.js") < html.indexOf("tile-plan.js"), "the Overview loads the engine before the tile");
});

test("the Plan view loads nothing of its own: no reads, only writes on Accept, blocks, timer, log and settings", function () {
  var src = fs.readFileSync(path.join(root, "plan-view.js"), "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|ctx\.get\(/.test(src), "all requests go through the page's own writer");
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src), "everything reaches the page through textContent");
  var posts = (src.match(/ctx\.post\("[^"]+"/g) || []).map(function (x) { return x.slice(10, -1); }).sort();
  assert.deepStrictEqual(posts.filter(function (p, i) { return posts.indexOf(p) === i; }), ["/block/delete", "/block/update", "/log", "/plan/accept", "/settings", "/task/snooze-many", "/task/update", "/timer"]);
  assert.ok(/!document\.hidden|document\.hidden/.test(src), "the timer's clock ticks only while the tab is visible");
});

console.log("\n" + passed + " passed");
