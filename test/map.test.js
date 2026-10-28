// Coverage for map-logic.js (the dependency map's rules): blast radius, the plain-words text, live-state wording, filters, the
// diagram's layout, the link choices that cannot make a loop, the starting-links sentence and the Overview tile's rows. The DOM
// and network parts were exercised in a real browser against a stand-in for the Worker.
//
//   node test/map.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var M = require(path.join(__dirname, "..", "map-logic.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function node(id, over) {
  return Object.assign({ id: id, kind: "app", name: id, criticality: "", dependsOn: [], layer: 0, state: "none", affectedBy: [], runs: "", owner: "", location: "" }, over);
}
// web -> api -> db, web -> cdn; lone
function sample() {
  var nodes = [
    node("web", { dependsOn: ["api", "cdn"], layer: 2, criticality: "normal" }),
    node("api", { dependsOn: ["db"], layer: 1, criticality: "high" }),
    node("db", { kind: "server", layer: 0, criticality: "critical" }),
    node("cdn", { kind: "network", layer: 0 }),
    node("lone", { kind: "domain", layer: 0 })
  ];
  var edges = [{ from: "web", to: "api" }, { from: "web", to: "cdn" }, { from: "api", to: "db" }];
  return { nodes: nodes, edges: edges, monitoring: true, stats: { down: 0, affected: 0 } };
}

test("adjacency and reach: nearest first, each once, strangers and self-links ignored", function () {
  var s = sample();
  s.nodes[0].dependsOn.push("web", "ghost", "api");
  var adj = M.adjacency(s.nodes);
  assert.deepStrictEqual(adj.deps.web, ["api", "cdn"]);
  assert.deepStrictEqual(adj.dependents.db, ["api"]);
  assert.deepStrictEqual(M.reach(adj.dependents, "db"), [{ id: "api", depth: 1 }, { id: "web", depth: 2 }]);
  assert.deepStrictEqual(M.reach(adj.deps, "db"), []);
});

test("radius: what breaks, what it needs, counts, in order of distance then importance", function () {
  var r = M.radius(sample().nodes, "db");
  assert.deepStrictEqual(r.affected.map(function (x) { return x.name + ":" + x.depth; }), ["api:1", "web:2"]);
  assert.deepStrictEqual(r.counts, { direct: 1, total: 2, needs: 0, important: 1 });
  var w = M.radius(sample().nodes, "web");
  assert.deepStrictEqual(w.needs.map(function (x) { return x.name + ":" + x.depth; }), ["api:1", "cdn:1", "db:2"]);
  assert.strictEqual(M.radius(sample().nodes, "ghost"), null);
});

test("whatBreaksText says none, one and several in plain words", function () {
  var n = sample().nodes;
  assert.strictEqual(M.whatBreaksText("lone", M.radius(n, "lone").affected), "If lone is down, nothing else on the map depends on it.");
  assert.strictEqual(M.whatBreaksText("cdn", M.radius(n, "cdn").affected), "If cdn is down: web stops working straight away.");
  assert.strictEqual(M.whatBreaksText("db", M.radius(n, "db").affected), "If db is down: api stops working straight away; web is hit through them.");
  var many = [{ name: "a", depth: 1 }, { name: "b", depth: 1 }, { name: "c", depth: 2 }, { name: "d", depth: 3 }];
  assert.strictEqual(M.whatBreaksText("x", many), "If x is down: a, b stop working straight away; c, d are hit through them.");
});

test("incidentText is the sentence and one line per affected thing, ready to paste", function () {
  var t = M.incidentText(M.radius(sample().nodes, "db"));
  var lines = t.split("\n");
  assert.strictEqual(lines[0], "If db is down: api stops working straight away; web is hit through them.");
  assert.strictEqual(lines[1], "");
  assert.strictEqual(lines[2], "- api (app or site, high, directly)");
  assert.strictEqual(lines[3], "- web (app or site, normal, through 1 other)");
  assert.strictEqual(M.incidentText(null), "");
  assert.strictEqual(M.incidentText(M.radius(sample().nodes, "lone")), "If lone is down, nothing else on the map depends on it.");
});

test("stateModel: down, affected, up, unknown and not monitored", function () {
  assert.deepStrictEqual(M.stateModel(node("a", { state: "down" })), { tone: "alert", label: "Down" });
  assert.deepStrictEqual(M.stateModel(node("a", { state: "up", affectedBy: ["x"] })), { tone: "attn", label: "Affected" });
  assert.deepStrictEqual(M.stateModel(node("a", { state: "none", affectedBy: ["x"] })), { tone: "attn", label: "Affected" });
  assert.deepStrictEqual(M.stateModel(node("a", { state: "up" })), { tone: "ok", label: "Up" });
  assert.deepStrictEqual(M.stateModel(node("a", { state: "unknown" })), { tone: "dim", label: "Unknown" });
  assert.deepStrictEqual(M.stateModel(node("a")), { tone: "dim", label: "Not monitored" });
});

test("banner: says what is down and what that takes with it, or that all is well, or that live state is missing", function () {
  var s = sample();
  assert.deepStrictEqual(M.banner(s), { tone: "", text: "No asset is tied to a monitor yet, so the map shows the links only." });
  s.nodes[2].state = "up"; s.nodes[1].state = "unknown";
  assert.deepStrictEqual(M.banner(s), { tone: "ok", text: "Everything that is monitored is up." });
  s.nodes[1].state = "none";
  s.nodes[2].state = "down"; s.stats = { down: 1, affected: 2 };
  assert.deepStrictEqual(M.banner(s), { tone: "alert", text: "db is down. 2 other things are affected through it." });
  s.nodes[3].state = "down"; s.stats = { down: 2, affected: 1 };
  assert.strictEqual(M.banner(s).text, "2 things are down (db, cdn). 1 other thing is affected through it.");
  s.monitoring = false;
  assert.strictEqual(M.banner(s).tone, "attn");
  assert.deepStrictEqual(M.banner(null), { tone: "", text: "" });
});

test("downReport lists what is down with how much it takes along, most first", function () {
  var s = sample();
  s.nodes[2].state = "down"; s.nodes[3].state = "down";
  var d = M.downReport(s.nodes);
  assert.deepStrictEqual(d.map(function (x) { return x.name + ":" + x.affected; }), ["db:2", "cdn:1"]);
  assert.strictEqual(d[0].text, "If db is down: api stops working straight away; web is hit through them.");
  assert.deepStrictEqual(M.downReport(sample().nodes), []);
});

test("biggestRadius ranks by how many things break, skips those nothing depends on, and honours the limit", function () {
  var rows = M.biggestRadius(sample().nodes, 10);
  assert.deepStrictEqual(rows.map(function (r) { return r.name + ":" + r.total + "/" + r.direct; }), ["db:2/1", "api:1/1", "cdn:1/1"]);
  assert.strictEqual(M.biggestRadius(sample().nodes, 1).length, 1);
});

test("visible drops hidden kinds and the links that touch them; matches only marks, never hides", function () {
  var s = sample();
  var v = M.visible(s, { hidden: { network: true } });
  assert.deepStrictEqual(v.nodes.map(function (n) { return n.id; }), ["web", "api", "db", "lone"]);
  assert.deepStrictEqual(v.edges, [{ from: "web", to: "api" }, { from: "api", to: "db" }]);
  assert.strictEqual(M.visible(s, {}).nodes.length, 5);
  assert.strictEqual(M.matches(node("a", { name: "Barnyard Worker", runs: "the API" }), "worker"), true);
  assert.strictEqual(M.matches(node("a", { owner: "Nathan" }), "NATHAN"), true);
  assert.strictEqual(M.matches(node("a"), ""), false);
  assert.strictEqual(M.matches(node("a", { name: "x" }), "zzz"), false);
});

test("kindCounts lists the kinds that are on the map, in display order", function () {
  assert.deepStrictEqual(M.kindCounts(sample().nodes), [
    { kind: "server", label: "Servers", count: 1 }, { kind: "network", label: "Network", count: 1 },
    { kind: "app", label: "Apps and sites", count: 2 }, { kind: "domain", label: "Domains", count: 1 }
  ]);
  assert.deepStrictEqual(M.kindCounts([]), []);
});

test("layout: foundations on the bottom row, dependents above, no two boxes overlap, every box inside the drawing", function () {
  var s = sample();
  var L = M.layout(s.nodes, s.edges);
  assert.strictEqual(L.rows, 3);
  var y = function (id) { return L.pos[id].y; };
  assert.ok(y("web") < y("api") && y("api") < y("db"), "needers above what they need");
  assert.strictEqual(y("db"), y("cdn"));
  assert.strictEqual(y("db"), y("lone"));
  var ids = Object.keys(L.pos);
  assert.strictEqual(ids.length, 5);
  ids.forEach(function (a) {
    assert.ok(L.pos[a].x >= 0 && L.pos[a].x + M.NODE_W <= L.width, a + " inside the width");
    assert.ok(L.pos[a].y >= 0 && L.pos[a].y + M.NODE_H <= L.height, a + " inside the height");
    ids.forEach(function (b) {
      if (a >= b) return;
      var overlap = Math.abs(L.pos[a].x - L.pos[b].x) < M.NODE_W && Math.abs(L.pos[a].y - L.pos[b].y) < M.NODE_H;
      assert.ok(!overlap, a + " and " + b + " do not overlap");
    });
  });
  assert.deepStrictEqual(M.layout(s.nodes, s.edges), L, "the same input draws the same way");
});

test("layout keeps links short: a box sits near what it needs, not across the row", function () {
  var nodes = [node("a", { layer: 0 }), node("b", { layer: 0 }), node("c", { layer: 0 }), node("d", { layer: 0 }),
    node("x", { layer: 1, dependsOn: ["d"] }), node("y", { layer: 1, dependsOn: ["a"] })];
  var edges = [{ from: "x", to: "d" }, { from: "y", to: "a" }];
  var L = M.layout(nodes, edges);
  assert.ok(Math.abs(L.pos.x.x - L.pos.d.x) <= Math.abs(L.pos.x.x - L.pos.a.x), "x sits nearer d than a");
  assert.ok(Math.abs(L.pos.y.x - L.pos.a.x) <= Math.abs(L.pos.y.x - L.pos.d.x), "y sits nearer a than d");
});

test("layout copes with nothing, one box, a filtered map with a gap in its rows, and a stray edge", function () {
  assert.deepStrictEqual(M.layout([], []), { pos: {}, width: 0, height: 0, rows: 0 });
  var one = M.layout([node("a")], []);
  assert.strictEqual(one.rows, 1);
  var gap = M.layout([node("top", { layer: 5, dependsOn: ["low"] }), node("low", { layer: 0 })], [{ from: "top", to: "low" }]);
  assert.strictEqual(gap.rows, 2, "empty rows between are squeezed out");
  assert.doesNotThrow(function () { M.layout([node("a")], [{ from: "a", to: "ghost" }, { from: "ghost", to: "a" }]); });
});

test("edgePath is a curve from the bottom of the needer to the top of what it needs", function () {
  var d = M.edgePath({ x: 0, y: 0 }, { x: 200, y: 200 });
  assert.strictEqual(d.indexOf("M" + (M.NODE_W / 2) + " " + M.NODE_H + " C"), 0);
  assert.ok(/ 200$/.test(d), "ends at the top of the lower box");
});

test("fitName cuts a long name to fit a box", function () {
  assert.strictEqual(M.fitName("Short"), "Short");
  assert.strictEqual(M.fitName("Microsoft 365 tenant (Entra, Exchange, SharePoint)").length, 22);
  assert.strictEqual(M.fitName(null), "");
});

test("linkChoices: not itself, and not anything that already needs it; setLink ticks and unticks without repeats", function () {
  var c = M.linkChoices(sample().nodes, "api");
  var by = {};
  c.forEach(function (x) { by[x.id] = x; });
  assert.ok(!by.api, "never itself");
  assert.strictEqual(by.web.blocked, true, "web needs api already");
  assert.ok(/loop/.test(by.web.reason));
  assert.strictEqual(by.db.blocked, false);
  assert.strictEqual(by.cdn.blocked, false);
  assert.deepStrictEqual(c.map(function (x) { return x.id; }), ["db", "cdn", "web", "lone"], "servers first, then network, apps and domains");
  assert.deepStrictEqual(M.setLink(["a"], "b", true), ["a", "b"]);
  assert.deepStrictEqual(M.setLink(["a", "b"], "b", true), ["a", "b"]);
  assert.deepStrictEqual(M.setLink(["a", "b"], "a", false), ["b"]);
  assert.deepStrictEqual(M.setLink(["a"], "z", false), ["a"]);
  assert.deepStrictEqual(M.setLink(undefined, "z", true), ["z"]);
  assert.strictEqual(M.sameList(["a", "b"], ["b", "a"]), true);
  assert.strictEqual(M.sameList(["a"], ["a", "b"]), false);
});

test("planText says what the starting links would do before anything is added", function () {
  var plan = { counts: { "new": 36, there: 0, missing: 0, cycle: 0 }, ensure: [{ name: "Cloudflare tunnel to app02" }, { name: "Cloudflare tunnel to BARNYARDCLD01" }] };
  assert.strictEqual(M.planText(plan), "Adds 36 links and 2 entries (Cloudflare tunnel to app02, Cloudflare tunnel to BARNYARDCLD01). 0 already there, 0 skipped.");
  assert.strictEqual(M.planText({ counts: { "new": 1, there: 2, missing: 3, cycle: 1 }, ensure: [] }), "Adds 1 link. 2 already there, 4 skipped.");
  assert.strictEqual(M.planText({ counts: { "new": 0, there: 36, missing: 0, cycle: 0 }, ensure: [] }), "All 36 starting links are already on the map.");
  assert.ok(/nothing to add/.test(M.planText({ counts: { "new": 0, there: 0, missing: 36, cycle: 0 }, ensure: [] })));
  assert.strictEqual(M.planText(null), "");
  assert.strictEqual(M.stateWord("cycle"), "Skipped: it would make a loop");
});

test("weakestModel turns the Worker's summary into tile rows and a tone", function () {
  var m = M.weakestModel({ assets: 24, links: 36, linked: 20, unlinked: 4, cycles: 0, weakest: [
    { id: "a", name: "app02", kind: "server", criticality: "high", dependents: 7, gaps: ["backup", "runbook"] },
    { id: "b", name: "Tunnel", kind: "network", criticality: "", dependents: 1, gaps: ["monitor"] }
  ] });
  assert.strictEqual(m.links, 36);
  assert.strictEqual(m.weakest[0].line, "7 things depend on it; no backup job names it, no runbook");
  assert.strictEqual(m.weakest[0].tone, "alert");
  assert.strictEqual(m.weakest[1].line, "1 thing depends on it; no monitor");
  assert.strictEqual(m.weakest[1].tone, "attn");
  assert.deepStrictEqual(M.weakestModel(null).weakest, []);
  assert.strictEqual(M.gapsText([]), "");
});

test("errorText words each refusal; an unknown code still says something", function () {
  assert.ok(/wait on each other/.test(M.errorText({ error: "dependency_cycle" }, 409)));
  assert.ok(/Sign in again/.test(M.errorText({ error: "recent_sign_in_required" }, 403)));
  assert.ok(/Could not reach/.test(M.errorText({}, 0)));
  assert.strictEqual(M.errorText({ error: "weird" }, 500), "That did not work (weird).");
  assert.strictEqual(M.errorText(null, 500), "That did not work (error 500).");
});

test("map.html loads the rules before the page, and only from this site", function () {
  var html = fs.readFileSync(path.join(root, "map.html"), "utf8");
  assert.ok(html.indexOf("map-logic.js") !== -1 && html.indexOf("map-logic.js") < html.indexOf("map.js"));
  assert.ok(/script-src 'self'/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/ style=/.test(html), "no inline style attribute");
});

console.log("\n" + passed + " passed");
