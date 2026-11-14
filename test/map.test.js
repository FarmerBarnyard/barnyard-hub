// Coverage for map-logic.js (the dependency map's rules): blast radius, the plain-words text, live-state wording, filters, the
// diagram's layout, the link choices that cannot make a loop, the starting-links sentence and the Overview tile's rows. The DOM
// and network parts were exercised in a real browser against a stand-in for the Worker.
//
//   node test/map.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var M = require(path.join(__dirname, "..", "map-logic.js"));
var F = require(path.join(__dirname, "map-fixture.js"));
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

// every box inside the drawing and no two boxes touching
function assertSound(L, label) {
  var ids = Object.keys(L.pos);
  ids.forEach(function (a) {
    var A = L.pos[a];
    assert.ok(A.x >= 0 && A.x + A.w <= L.width, label + ": " + a + " inside the width");
    assert.ok(A.y >= 0 && A.y + A.h <= L.height, label + ": " + a + " inside the height");
    ids.forEach(function (b) {
      if (a >= b) return;
      var B = L.pos[b];
      var apart = A.x + A.w <= B.x || B.x + B.w <= A.x || A.y + A.h <= B.y || B.y + B.h <= A.y;
      assert.ok(apart, label + ": " + a + " and " + b + " do not overlap");
    });
  });
}

test("layout: foundations on the bottom row, dependents above, boxes with no link in a tray, no overlap, all inside the drawing", function () {
  var s = sample();
  var L = M.layout(s.nodes, s.edges);
  assert.strictEqual(L.rows, 4, "three layers and the tray");
  var y = function (id) { return L.pos[id].y; };
  assert.ok(y("web") < y("api") && y("api") < y("db"), "needers above what they need");
  assert.ok(Math.abs(y("db") + L.pos.db.h / 2 - (y("cdn") + L.pos.cdn.h / 2)) < 1, "same layer, same row");
  assert.ok(y("lone") > y("db"), "a box with no link sits in the tray under the rest");
  assert.deepStrictEqual(L.lanes.map(function (l) { return l.title; }), ["Level 2", "Level 1", "Foundations", "Not linked to anything"]);
  assert.strictEqual(Object.keys(L.pos).length, 5);
  assertSound(L, "sample");
  assert.deepStrictEqual(M.layout(s.nodes, s.edges), L, "the same input draws the same way");
  assert.deepStrictEqual(L.order.slice().sort(), ["api", "cdn", "db", "lone", "web"], "every box is in the reading order once");
});

test("layout keeps links short: a box sits near what it needs, not across the row", function () {
  var nodes = [node("a", { layer: 0 }), node("b", { layer: 0 }), node("c", { layer: 0 }), node("d", { layer: 0 }),
    node("x", { layer: 1, dependsOn: ["d"] }), node("y", { layer: 1, dependsOn: ["a"] })];
  var edges = [{ from: "x", to: "d" }, { from: "y", to: "a" }];
  var L = M.layout(nodes, edges);
  assert.ok(Math.abs(L.pos.x.x - L.pos.d.x) <= Math.abs(L.pos.x.x - L.pos.a.x), "x sits nearer d than a");
  assert.ok(Math.abs(L.pos.y.x - L.pos.a.x) <= Math.abs(L.pos.y.x - L.pos.d.x), "y sits nearer a than d");
  assert.strictEqual(L.crossings, 0, "two links that need not cross do not");
});

test("layout copes with nothing, one box, a filtered map with a gap in its rows, and a stray edge", function () {
  assert.deepStrictEqual(M.layout([], []), { pos: {}, lines: {}, width: 0, height: 0, rows: 0, lanes: [], order: [], edges: [], crossings: 0 });
  var one = M.layout([node("a")], []);
  assert.strictEqual(one.rows, 1);
  var gap = M.layout([node("top", { layer: 5, dependsOn: ["low"] }), node("low", { layer: 0 })], [{ from: "top", to: "low" }]);
  assert.strictEqual(gap.rows, 2, "empty rows between are squeezed out");
  assert.doesNotThrow(function () { M.layout([node("a")], [{ from: "a", to: "ghost" }, { from: "ghost", to: "a" }]); });
  // a loop in the data (a needs b, b needs a, on the same layer) is drawn, not lost
  var loop = M.layout([node("a", { layer: 1 }), node("b", { layer: 1 })], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
  assert.strictEqual(loop.edges.length, 2);
  assert.ok(loop.edges.every(function (e) { return /^M/.test(e.d); }));
  assertSound(loop, "loop");
  // twenty boxes and no links at all wrap into tray rows instead of one endless row
  var wide = [];
  for (var i = 0; i < 20; i++) wide.push(node("n" + i, { name: "Box " + i }));
  var tray = M.layout(wide, []);
  assert.ok(tray.rows >= 3, "wrapped into several tray rows");
  assertSound(tray, "tray");
});

test("edgePath is a curve from the bottom of the needer to the top of what it needs", function () {
  var d = M.edgePath({ x: 0, y: 0 }, { x: 200, y: 200 });
  assert.strictEqual(d.indexOf("M" + (M.NODE_W / 2) + " " + M.NODE_H + " C"), 0);
  assert.ok(/ 200$/.test(d), "ends at the top of the lower box");
});

test("wrapName keeps the whole name: a bracket starts a new line, at most three lines, only a huge name is cut", function () {
  assert.deepStrictEqual(M.wrapName("Short"), ["Short"]);
  assert.deepStrictEqual(M.wrapName("Campaign site (campaign.barnyard.site)"), ["Campaign site", "(campaign.barnyard.site)"]);
  var long = "Barnyard-Graph-Read (Entra app: Users list, M365 Health, Services)";
  var l = M.wrapName(long);
  assert.ok(l.length <= 3 && l[0] === "Barnyard-Graph-Read");
  assert.strictEqual(l.join(" "), long, "nothing lost");
  l.forEach(function (x) { assert.ok(x.length <= 31); });
  assert.deepStrictEqual(M.wrapName(null), [""]);
  var huge = M.wrapName(new Array(40).join("word "));
  assert.strictEqual(huge.length, 3);
  assert.strictEqual(huge[2].slice(-1), "…");
  assert.strictEqual(M.wrapName("x".repeat(80)).length, 3, "an unbroken word is broken into lines too");
  assert.strictEqual(M.boxHeight("Short"), M.wrapName("Short").length * 14 + 36);
});

test("countCrossings counts pairs of links that cross, and not links that meet at a point", function () {
  var X = [[{ x: 0, y: 0 }, { x: 10, y: 10 }], [{ x: 10, y: 0 }, { x: 0, y: 10 }]];
  assert.strictEqual(M.countCrossings(X), 1);
  assert.strictEqual(M.countCrossings([[{ x: 0, y: 0 }, { x: 0, y: 10 }], [{ x: 5, y: 0 }, { x: 5, y: 10 }]]), 0);
  assert.strictEqual(M.countCrossings([[{ x: 0, y: 0 }, { x: 5, y: 10 }], [{ x: 0, y: 0 }, { x: 9, y: 10 }]]), 0, "the same start is not a crossing");
  assert.strictEqual(M.countCrossings([]), 0);
});

test("neighbours and edgeRole: direct links for a hover, the whole blast radius for a pick, colours that never mix", function () {
  var n = sample().nodes;
  var direct = M.neighbours(n, "api", false);
  assert.deepStrictEqual(Object.keys(direct.needs), ["db"]);
  assert.deepStrictEqual(Object.keys(direct.dependents), ["web"]);
  var db = M.neighbours(n, "db", true);
  assert.deepStrictEqual(Object.keys(db.dependents).sort(), ["api", "web"], "web is hit through api");
  assert.deepStrictEqual(Object.keys(M.neighbours(n, "db", false).dependents), ["api"], "a hover stops at the direct link");
  assert.deepStrictEqual(M.neighbours(n, "ghost", true), { needs: {}, dependents: {} });
  assert.strictEqual(M.edgeRole({ from: "web", to: "api" }, "api", direct, false), "dependent");
  assert.strictEqual(M.edgeRole({ from: "api", to: "db" }, "api", direct, false), "need");
  assert.strictEqual(M.edgeRole({ from: "web", to: "cdn" }, "api", direct, false), "", "unrelated links fade");
  assert.strictEqual(M.edgeRole({ from: "web", to: "api" }, "db", db, true), "dependent", "the pick's blast radius reaches web -> api");
  assert.strictEqual(M.edgeRole({ from: "web", to: "api" }, "db", M.neighbours(n, "db", false), false), "", "a hover does not light links that do not touch the box");
  assert.strictEqual(M.edgeRole({ from: "web", to: "cdn" }, "db", db, true), "");
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

// ---- the owner's real graph: 27 boxes, 47 links --------------------------------------------------------------------------

// The layout this page used before (rows by layer, boxes averaged toward their neighbours, a line from box centre to box centre),
// kept only to show that the new one crosses fewer links.
function legacyLinks(nodes, edges) {
  var W = 196, H = 48, GX = 18, GY = 86;
  var layerSet = {};
  nodes.forEach(function (n) { layerSet[n.layer || 0] = true; });
  var layers = Object.keys(layerSet).map(Number).sort(function (a, b) { return b - a; });
  var rowOf = {};
  layers.forEach(function (l, i) { rowOf[l] = i; });
  var KR = { server: 0, network: 1, app: 2, domain: 3, certificate: 4, account: 5, licence: 6, subscription: 7, other: 8 };
  var rows = layers.map(function () { return []; });
  nodes.slice().sort(function (a, b) { return (KR[a.kind] - KR[b.kind]) || a.name.localeCompare(b.name); }).forEach(function (n) { rows[rowOf[n.layer || 0]].push(n.id); });
  var up = {}, down = {};
  nodes.forEach(function (n) { up[n.id] = []; down[n.id] = []; });
  edges.forEach(function (e) { down[e.from].push(e.to); up[e.to].push(e.from); });
  var step = W + GX, widest = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1), xOf = {};
  function place() { rows.forEach(function (r) { var off = (widest - r.length) * step / 2; r.forEach(function (id, i) { xOf[id] = off + i * step; }); }); }
  place();
  function sweep(order, nb) {
    order.forEach(function (ri) {
      var key = {};
      rows[ri].forEach(function (id) { var ns = nb[id]; key[id] = ns.length ? ns.reduce(function (s, n) { return s + xOf[n]; }, 0) / ns.length : xOf[id]; });
      rows[ri].sort(function (a, b) { return key[a] - key[b]; });
    });
    place();
  }
  var td = rows.map(function (_, i) { return i; }), bu = td.slice().reverse();
  for (var pass = 0; pass < 4; pass++) { sweep(td, up); sweep(bu, down); }
  var pos = {};
  rows.forEach(function (r, ri) { r.forEach(function (id) { pos[id] = { x: xOf[id], y: ri * (H + GY) }; }); });
  return edges.map(function (e) {
    return [{ x: pos[e.from].x + W / 2, y: pos[e.from].y + H }, { x: pos[e.to].x + W / 2, y: pos[e.to].y }];
  });
}

test("the owner's real map: fewer crossings than the old ordering, the same drawing every time, nothing overlapping, everything inside", function () {
  var f = F.mapFixture();
  assert.strictEqual(f.nodes.length, 27);
  assert.strictEqual(f.edges.length, 47);
  var L = M.layout(f.nodes, f.edges);
  var before = M.countCrossings(legacyLinks(f.nodes, f.edges));
  assert.ok(L.crossings < before, "crossings fell from " + before + " to " + L.crossings);
  assert.strictEqual(L.crossings, M.countCrossings(L.edges.map(function (e) { return e.points; })), "the count is of the links as drawn");
  assert.deepStrictEqual(M.layout(F.mapFixture().nodes, F.mapFixture().edges), L, "deterministic");
  assertSound(L, "owner map");
  assert.strictEqual(Object.keys(L.pos).length, 27);
  assert.strictEqual(L.edges.length, 47, "every link is drawn");
  L.edges.forEach(function (e) { assert.ok(/^M[-0-9. ]+[LC]/.test(e.d) && e.points.length >= 2, e.from + " to " + e.to + " has a path"); });
  console.log("  crossings: " + before + " before, " + L.crossings + " now; drawing " + Math.round(L.width) + " x " + Math.round(L.height));
});

test("the owner's real map: the whole name is on every box, lanes read top to bottom, the unlinked two sit in the tray", function () {
  var f = F.mapFixture();
  var L = M.layout(f.nodes, f.edges);
  f.nodes.forEach(function (n) {
    assert.ok(L.lines[n.id].length <= 3);
    assert.strictEqual(L.lines[n.id].join(" "), n.name.replace(/\s+/g, " "), n.name + " is shown in full");
  });
  assert.deepStrictEqual(L.lanes.map(function (l) { return l.title; }), ["Level 4", "Level 3", "Level 2", "Level 1", "Foundations", "Not linked to anything"]);
  for (var i = 1; i < L.lanes.length; i++) assert.ok(L.lanes[i].y >= L.lanes[i - 1].y + L.lanes[i - 1].h, "lanes do not overlap");
  var tray = L.lanes[5];
  ["VTT VPS (barnyardvps01)", "Claude subscription"].forEach(function (name) {
    var n = f.nodes.filter(function (x) { return x.name === name; })[0];
    assert.ok(L.pos[n.id].y >= tray.y, name + " is in the tray");
  });
  // a box sits in its layer's lane: everything on layer 4 above everything on layer 3, and so on
  var maxY = function (layer) { return Math.max.apply(null, f.nodes.filter(function (n) { return n.layer === layer; }).map(function (n) { return L.pos[n.id].y + L.pos[n.id].h; })); };
  var minY = function (layer) { return Math.min.apply(null, f.nodes.filter(function (n) { return n.layer === layer; }).map(function (n) { return L.pos[n.id].y; })); };
  for (var l = 4; l > 1; l--) assert.ok(maxY(l) < minY(l - 1), "layer " + l + " above layer " + (l - 1));
  assert.deepStrictEqual(L.order.slice().sort(), f.nodes.map(function (n) { return n.id; }).sort(), "every box in the reading order once");
});

test("the owner's real map: links leave a box from different points, end on the box they need, and never run through a box", function () {
  var f = F.mapFixture();
  var L = M.layout(f.nodes, f.edges);
  var startAt = {}, endAt = {};
  L.edges.forEach(function (e) {
    var a = L.pos[e.from], b = L.pos[e.to], p0 = e.points[0], p1 = e.points[e.points.length - 1];
    assert.ok(Math.abs(p0.y - (a.y + a.h)) < 0.01 && p0.x >= a.x && p0.x <= a.x + a.w, "starts on the bottom of " + e.from);
    assert.ok(Math.abs(p1.y - b.y) < 0.01 && p1.x >= b.x && p1.x <= b.x + b.w, "ends on the top of " + e.to);
    var s = e.from + "@" + Math.round(p0.x), t = e.to + "@" + Math.round(p1.x);
    assert.ok(!startAt[s], "two links start at one point: " + s); startAt[s] = true;
    assert.ok(!endAt[t], "two links end at one point: " + t); endAt[t] = true;
    // no point of the path (the track a skipping link runs along) lies inside any box
    e.points.slice(1, -1).forEach(function (p) {
      Object.keys(L.pos).forEach(function (id) {
        var q = L.pos[id];
        assert.ok(!(p.x > q.x - 1 && p.x < q.x + q.w + 1 && p.y > q.y && p.y < q.y + q.h), e.from + " to " + e.to + " runs through " + id);
      });
    });
  });
});

test("the owner's real map: pointing at the Worker lights its 6 needs and 8 dependents and nothing else", function () {
  var f = F.mapFixture();
  var worker = f.nodes.filter(function (n) { return /Worker/.test(n.name); })[0].id;
  var sets = M.neighbours(f.nodes, worker, false);
  assert.strictEqual(Object.keys(sets.needs).length, 6);
  assert.strictEqual(Object.keys(sets.dependents).length, 8);
  var lit = f.edges.filter(function (e) { return M.edgeRole(e, worker, sets, false); });
  assert.strictEqual(lit.length, 14, "6 + 8 links touch it");
  var all = M.neighbours(f.nodes, worker, true);
  assert.ok(Object.keys(all.needs).length > 6, "a pick follows the needs on down to the foundations");
});

test("map.html loads the rules before the page, and only from this site", function () {
  var html = fs.readFileSync(path.join(root, "map.html"), "utf8");
  assert.ok(html.indexOf("map-logic.js") !== -1 && html.indexOf("map-logic.js") < html.indexOf("map.js"));
  assert.ok(/script-src 'self'/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/ style=/.test(html), "no inline style attribute");
});

test("the page's own files: keyboard, reduced motion, full names, a key for the colours, no markup from the server", function () {
  var js = fs.readFileSync(path.join(root, "map.js"), "utf8"), css = fs.readFileSync(path.join(root, "map.css"), "utf8");
  assert.ok(/ev\.key === "Escape"/.test(js), "Escape clears the pick");
  assert.ok(/ev\.key === "Enter"/.test(js) && /tabindex: "0"/.test(js), "boxes can be reached and picked from the keyboard");
  assert.ok(/addEventListener\("focus"/.test(js) && /addEventListener\("mouseenter"/.test(js), "focus lights the links the way pointing does");
  assert.ok(/aria-label/.test(js) && /s\("title"/.test(js), "boxes have an accessible name and a tooltip");
  assert.ok(/prefers-reduced-motion: reduce/.test(css), "motion is switched off when asked");
  assert.ok(/What the box needs/.test(js) && /What needs the box/.test(js), "a key for the two colours");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js.replace(/^\s*\/\/.*$/gm, "")), "server text reaches the page as text");
  assert.ok(!/fitName/.test(js), "no more cutting names short");
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "colours come from the theme tokens");
});

test("the sidebar has a Blast radius entry: owner only, pointing at map.html, with its own icon and palette words", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var items = shell.match(/\{ id: "[a-z]+", title: "[^"]+", group: "[^"]*", icon: "[a-z]+"[^}]*\}/g) || [];
  var entry = items.filter(function (it) { return /id: "map"/.test(it); });
  assert.strictEqual(entry.length, 1, "exactly one menu entry for the map");
  var e = entry[0];
  assert.ok(/title: "Blast radius"/.test(e) && /group: "Work"/.test(e));
  assert.ok(/path: "map\.html"/.test(e) && /local: "map\.html"/.test(e), "points at the hub's map.html, here and from the other sites");
  assert.ok(/ownerOnly: true/.test(e), "shown to the owner alone, and hidden until that is known");
  assert.ok(!/perm:/.test(e), "no perm: the Worker has no map area and the owner is never capped");
  assert.ok(/keywords: "[^"]*dependencies[^"]*"/.test(e), "the palette finds it by 'dependencies'");
  var icon = /icon: "([a-z]+)"/.exec(e)[1];
  assert.ok(new RegExp("\\n\\s+" + icon + ": '<").test(shell), "the icon " + icon + " is drawn");
  assert.notStrictEqual(icon, "map", "not the Campaign icon");
  // it sits in the Work group, between Services and Users, so the group stays together
  assert.ok(shell.indexOf('id: "services"') < shell.indexOf('id: "map"') && shell.indexOf('id: "map"') < shell.indexOf('id: "users"'));
});

test("the sidebar highlights Blast radius on map.html, and the palette matches a page's own words", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  assert.ok(/map\\\.html\$\/\.test\(location\.pathname\)\) return "map"/.test(shell), "inferCurrent knows map.html");
  var html = fs.readFileSync(path.join(root, "map.html"), "utf8");
  assert.ok(/<body data-shell="map"/.test(html), "map.html says which menu item it is, so Overview is not lit instead");
  assert.ok(/keywords: "open " \+ p\.id \+ \(p\.keywords \? " " \+ p\.keywords : ""\)/.test(shell), "palette keywords include the entry's own");
});


// ---- weak links: the identity kind and accepted gaps -------------------------------------------------------------------

test("the identity kind is in the kind list, its labels and its place in the order (after accounts)", function () {
  var kinds = M.KINDS.map(function (k) { return k[0]; });
  assert.ok(kinds.indexOf("identity") !== -1);
  assert.ok(kinds.indexOf("identity") > kinds.indexOf("account") && kinds.indexOf("identity") < kinds.indexOf("licence"));
  assert.strictEqual(M.kindLabel("identity"), "Identity apps and settings");
  assert.strictEqual(M.kindOne("identity"), "Identity app or setting");
  assert.strictEqual(M.kindCounts([{ kind: "identity" }, { kind: "identity" }, { kind: "server" }]).filter(function (k) { return k.kind === "identity"; })[0].count, 2);
  var sorted = M.linkChoices([{ id: "a", kind: "identity", name: "Mail app", dependsOn: [] }, { id: "b", kind: "account", name: "Tenant", dependsOn: [] }, { id: "c", kind: "licence", name: "Lic", dependsOn: [] }, { id: "d", kind: "server", name: "S", dependsOn: [] }], "d").map(function (c) { return c.kind; });
  assert.deepStrictEqual(sorted, ["account", "identity", "licence"]);
});

test("gap words: the expiry watch, and an overdue accepted gap says so", function () {
  assert.strictEqual(M.gapsText(["runbook", "watch"]), "no runbook, no expiry watch");
  assert.strictEqual(M.gapsText(["monitor", "watch"], ["watch"]), "no monitor, no expiry watch (review overdue)");
  assert.strictEqual(M.gapsText(["monitor"], []), "no monitor");
  assert.strictEqual(M.gapsText(["monitor"], null), "no monitor");
});

test("an accepted gap is always worded the same way: Accepted until a date, then the reason; overdue says so", function () {
  assert.strictEqual(M.dayWords("2027-02-14"), "14 Feb 2027");
  assert.strictEqual(M.dayWords("2026-12-01"), "1 Dec 2026");
  assert.strictEqual(M.dayWords("nonsense"), "nonsense");
  assert.strictEqual(M.acceptedLine({ gap: "watch", reason: "Renewal is on the Calendar", review: "2027-02-14", overdue: false }).text, "Accepted until 14 Feb 2027: Renewal is on the Calendar");
  var late = M.acceptedLine({ gap: "monitor", reason: "Cannot be probed from outside", review: "2026-11-01", overdue: true });
  assert.strictEqual(late.text, "Review overdue (was accepted until 1 Nov 2026): Cannot be probed from outside");
  assert.strictEqual(late.overdue, true);
  assert.strictEqual(late.label, "no monitor");
  assert.strictEqual(M.acceptedLine({ gap: "backup", review: "2027-01-01" }).text, "Accepted until 1 Jan 2027", "no reason, no colon");
});

test("weakestModel carries the accepted gaps and how many there are, and marks overdue ones in a weak row", function () {
  var m = M.weakestModel({ assets: 5, links: 3, linked: 3, unlinked: 0, cycles: 0,
    weakest: [{ id: "a", name: "Tunnel", kind: "network", criticality: "", dependents: 2, gaps: ["monitor", "runbook"], overdue: ["monitor"] }],
    accepted: [{ id: "b", name: "Mail sender app", kind: "identity", gap: "watch", reason: "On the Calendar", review: "2027-02-14", overdue: false }], acceptedCount: 3 });
  assert.strictEqual(m.weakest[0].line, "2 things depend on it; no monitor (review overdue), no runbook");
  assert.strictEqual(m.accepted.length, 1);
  assert.strictEqual(m.accepted[0].text, "Accepted until 14 Feb 2027: On the Calendar");
  assert.strictEqual(m.accepted[0].name, "Mail sender app");
  assert.strictEqual(m.acceptedCount, 3, "the Worker's own total wins when there are more than it sent");
  var none = M.weakestModel({ assets: 1, weakest: [] });
  assert.deepStrictEqual([none.accepted, none.acceptedCount], [[], 0]);
  assert.deepStrictEqual(M.acceptedRows(null), []);
});

test("the map page and its panel always show accepted gaps, apart from the open ones, through textContent only", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "map.js"), "utf8");
  assert.ok(/M\.acceptedRows\(model\.map\.accepted && model\.map\.accepted\.list\)/.test(src), "the lists under the map read the Worker's accepted list");
  assert.ok(/"Accepted gaps"/.test(src));
  assert.ok(/n\.overdueGaps/.test(src), "overdue gaps are marked in the panel");
  assert.ok(!/[.]innerHTML/.test(src), "text only");
});


console.log("\n" + passed + " passed");
