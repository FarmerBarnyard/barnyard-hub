// Coverage for sharing a Canvas board as a read-only link and for the Overview's Canvas tile: what the owner's Share tab sends, how a
// shared board is drawn (the picture the public page builds is rebuilt from an allow-list, so it can only hold shapes and words),
// what the Canvas page adds (a Share button that saves first, and a count of live links), and the tile (names and times only).
// The drawing itself was checked in a browser.
//
//   node test/canvas-share.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var S = require(path.join(root, "share.js"));
var R = require(path.join(root, "share-render.js"));
var CL = require(path.join(root, "canvas-logic.js"));
var T = require(path.join(root, "tile-canvas.js"));
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function form(over) {
  var f = { kind: "canvas", days: 14, label: "", sections: {}, articles: [], board: "cb_aaaa1111", cardLabels: false, confirmPii: false };
  for (var k in over) f[k] = over[k];
  return f;
}

// ---- the owner's Share tab ---------------------------------------------------------------------------------------------------

test("the Canvas board is the fourth thing that can be shared", function () {
  assert.deepStrictEqual(S.KINDS.map(function (k) { return k.id; }), ["overview", "renewals", "kb", "canvas"]);
  assert.strictEqual(R.kindTitle("canvas"), "Canvas board");
});

test("buildBody for a board sends its id, and the card-names choice only when it was ticked", function () {
  assert.deepStrictEqual(S.buildBody(form(), ""), { kind: "canvas", days: 14, id: "cb_aaaa1111" });
  assert.deepStrictEqual(S.buildBody(form({ cardLabels: true, label: " Plan ", days: 7 }), "2026-11-02"), { kind: "canvas", days: 7, label: "Plan", id: "cb_aaaa1111", cardLabels: true, today: "2026-11-02" });
  assert.strictEqual(S.buildBody(form(), "").cardLabels, undefined, "names stay out unless the owner chose to show them");
  assert.strictEqual(S.buildBody(form({ kind: "renewals" }), "").id, undefined, "other kinds send no board");
});

test("formProblem: a board has to be chosen, and only a real board id counts", function () {
  assert.strictEqual(S.formProblem(form()), "");
  assert.match(S.formProblem(form({ board: "" })), /Choose a board/);
  assert.match(S.formProblem(form({ board: "../etc" })), /Choose a board/);
  assert.match(S.formProblem(form({ board: "it_abcd1234" })), /Choose a board/);
});

test("boardChoices keeps well-formed boards with a name, and liveFor counts only this board's live canvas links", function () {
  var boards = S.boardChoices({ boards: [{ id: "cb_aaaa1111", title: "Network", items: 4 }, { id: "bad", title: "X" }, { id: "cb_bbbb2222", title: "" }, null, { id: "cb_cccc3333", title: "x".repeat(200), items: "n" }] });
  assert.deepStrictEqual(boards.map(function (b) { return [b.id, b.items]; }), [["cb_aaaa1111", 4], ["cb_cccc3333", 0]]);
  assert.strictEqual(boards[1].title.length, 80);
  assert.deepStrictEqual(S.boardChoices(null), []);
  var links = [
    { kind: "canvas", ref: "cb_aaaa1111", status: "live" }, { kind: "canvas", ref: "cb_aaaa1111", status: "revoked" }, { kind: "canvas", ref: "cb_aaaa1111", status: "expired" },
    { kind: "canvas", ref: "cb_bbbb2222", status: "live" }, { kind: "renewals", ref: "cb_aaaa1111", status: "live" }, null
  ];
  assert.strictEqual(S.liveFor(links, "cb_aaaa1111"), 1);
  assert.strictEqual(S.liveFor(links, "cb_zzzz9999"), 0);
  assert.strictEqual(S.liveFor(null, "cb_aaaa1111"), 0);
});

test("the new Worker answers are in plain words", function () {
  ["canvas_share_off", "board_not_found", "board_empty"].forEach(function (c) {
    var t = S.errorText(c, 403);
    assert.ok(t.length > 20 && t.indexOf(c) === -1, c);
  });
  assert.match(S.errorText("canvas_share_off"), /CANVAS_SHARE_ENABLED/);
});

// ---- how a shared board is drawn --------------------------------------------------------------------------------------------

var SNAP = {
  kind: "canvas", takenAt: 1000, title: "Home network", cardLabels: false,
  items: [
    { id: "n1", type: "note", x: 10, y: 20, w: 180, h: 110, color: "amber", text: "Front <door> & \"gate\"" },
    { id: "n2", type: "card", x: 300, y: 20, w: 240, h: 84, color: "default", ref: { kind: "ops" }, label: "Linked item" },
    { id: "n3", type: "arrow", from: { item: "n1" }, to: { item: "n2" }, text: "depends on", style: "dashed", head: true, color: "default" },
    { id: "n4", type: "shape", x: 0, y: 200, w: 120, h: 60, shape: "ellipse", text: "Web", color: "blue" },
    { id: "n5", type: "shape", x: 150, y: 200, w: 120, h: 60, shape: "diamond", text: "?", color: "red" },
    { id: "n6", type: "frame", x: -20, y: 180, w: 400, h: 120, text: "Servers", color: "green" },
    { id: "n7", type: "text", x: 0, y: -60, w: 260, h: 40, text: "Title", size: "l", color: "default" }
  ]
};

test("a card is drawn from its kind and plain label with a placeholder id, and nothing else is changed", function () {
  var data = R.canvasData(SNAP);
  var card = data.items[1];
  assert.deepStrictEqual([card.type, card.ref, card.label], ["card", { kind: "ops", id: "shared" }, "Linked item"]);
  assert.deepStrictEqual(data.items[0], SNAP.items[0]);
  assert.strictEqual(SNAP.items[1].ref.id, undefined, "the picture itself is not changed");
  assert.deepStrictEqual(R.canvasData(null), { items: [] });
  assert.deepStrictEqual(R.canvasData({ items: [null, "x", 7] }), { items: [] });
});

test("the board's own SVG export survives the allow-list whole: every element and attribute it uses is one the page keeps", function () {
  var svg = CL.toSvg(R.canvasData(SNAP));
  var tags = svg.match(/<([a-zA-Z]+)/g).map(function (t) { return t.slice(1); });
  tags.forEach(function (t) { assert.ok(R.SVG_TAGS[t], "an element the page would drop: " + t); });
  var dropped = [];
  (svg.match(/ ([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g) || []).forEach(function (a) {
    var m = / ([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/.exec(a);
    if (["xmlns", "width", "height"].indexOf(m[1]) !== -1) return;    // the page makes its own namespace and sizes the drawing itself
    if (!R.safeSvgAttr(m[1], m[2].replace(/&quot;|&amp;|&lt;|&gt;/g, "?"))) dropped.push(m[1] + "=" + m[2]);
  });
  assert.deepStrictEqual(dropped, [], "attributes the page would drop");
});

test("words on the board are escaped by the export, so markup in a note can only ever be text", function () {
  var svg = CL.toSvg(R.canvasData(SNAP));
  assert.ok(svg.indexOf("<door>") === -1 && svg.indexOf("&lt;door&gt;") !== -1);
  assert.ok(svg.indexOf("&amp;") !== -1 && svg.indexOf("&quot;gate&quot;") !== -1);
});

test("the allow-list copies no script, style, link, picture address, event handler or outside address", function () {
  ["script", "style", "a", "image", "foreignObject", "use", "iframe", "animate", "set", "svg:script"].forEach(function (t) { assert.ok(!R.SVG_TAGS[t], t); });
  var bad = [
    ["onload", "alert(1)"], ["onclick", "x"], ["href", "https://evil.example/"], ["xlink:href", "#a"], ["style", "fill:red"], ["fill", "url(https://evil.example/x.svg#a)"],
    ["fill", "javascript:alert(1)"], ["marker-end", "url(https://evil.example/#ah)"], ["marker-end", "url(#ah)\" onload=\"x"], ["stroke", "red;background:url(x)"],
    ["d", "M0 0 \"><script>"], ["font-family", "Segoe UI; x"], ["width", "100"], ["height", "100"], ["class", "x"], ["data-x", "1"], ["src", "x.png"]
  ];
  bad.forEach(function (p) { assert.strictEqual(R.safeSvgAttr(p[0], p[1]), false, p.join("=")); });
  var good = [["fill", "#fff0cc"], ["stroke-width", "2"], ["stroke-dasharray", "8 6"], ["marker-end", "url(#ah)"], ["points", "10,0 20,10 10,20 0,10"], ["font-family", "Segoe UI, system-ui, sans-serif"], ["viewBox", "-40 -100 700 400"], ["text-anchor", "middle"], ["orient", "auto-start-reverse"]];
  good.forEach(function (p) { assert.strictEqual(R.safeSvgAttr(p[0], p[1]), true, p.join("=")); });
});

test("describe and the drawing code keep to the DOM: no markup strings, no outside address", function () {
  assert.strictEqual(R.describe(SNAP), "7 items");
  assert.strictEqual(R.describe({ kind: "canvas", items: [{}] }), "1 item");
  var src = code(read("share-render.js"));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src));
  assert.ok(/createElementNS\(SVG_NS, node\.localName\)/.test(src) && /new DOMParser\(\)\.parseFromString/.test(src));
  assert.ok(/SVG_VALUE = \/\^\[-A-Za-z0-9 #\.,\(\)_%\]\*\$\//.test(src), "values cannot hold a colon, slash, semicolon, quote or angle bracket");
});

// ---- the public page ------------------------------------------------------------------------------------------------------------

test("view.html loads the board's drawing code before the renderer, with the same strict page rules as before", function () {
  var html = read("view.html");
  var order = ["markdown.js", "canvas-logic.js", "share-render.js", "view.js"].map(function (n) { return html.indexOf('<script src="' + n); });
  assert.ok(order.every(function (i, n) { return i !== -1 && (n === 0 || i > order[n - 1]); }), order.join(","));
  var csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.ok(/default-src 'self'/.test(csp) && /connect-src https:\/\/api\.barnyard\.site;/.test(csp) && /script-src 'self'/.test(csp) && /style-src 'self'/.test(csp));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(!/\sstyle="|\son[a-z]+="/.test(html));
});

test("the page's styles hold no inline style and size the drawing to the screen and to paper", function () {
  var css = read("share.css");
  assert.ok(/\.sv-canvas-svg \{[^}]*width: 100%[^}]*height: auto/.test(css));
  assert.ok(/@media print[\s\S]*\.sv-canvas-svg \{ min-width: 0; \}/.test(css));
});

// ---- the Canvas page ------------------------------------------------------------------------------------------------------------

test("the Canvas page has a Share button, loads the sharing scripts before itself, and saves before it opens the tab", function () {
  var html = read("canvas.html"), js = read("canvas.js");
  assert.ok(/<button type="button" class="btn btn-sm btn-quiet" id="cv-share"/.test(html));
  var order = ["shell.js", "auth-gate.js", "canvas-logic.js", "share-render.js", "share.js", "canvas.js"].map(function (n) { return html.indexOf('<script src="' + n); });
  assert.ok(order.every(function (i, n) { return i !== -1 && (n === 0 || i > order[n - 1]); }), order.join(","));
  assert.ok(html.indexOf('href="share.css') !== -1);
  var src = code(js);
  assert.ok(/\$\("cv-share"\)\.addEventListener\("click", shareDialog\)/.test(src));
  assert.ok(/flushSave\(\)\.then\(function \(\) \{ S\.shareFor = ""; ui\.openFor\("canvas", id\); \}\)/.test(src), "the link shows the saved board, so save first");
  assert.ok(/ui\.countLive\(id\)/.test(src) && /"Share \(" \+ n \+ " live\)"/.test(src), "the button says how many links are live");
  assert.ok(/\["cv-rename", "cv-history", "cv-export", "cv-share", "cv-delete"\]/.test(src), "disabled with no board");
  assert.ok(/switched off\."\)\)/.test(src) || /any shared links to it are switched off/.test(src), "the delete dialog says its links go too");
  assert.ok(/#\(cb_\[a-z0-9\]\{8\}\)\$/.test(src), "canvas.html#cb_... opens that board");
  var paths = (src.match(/"\/[a-z]+\/[^"?]*/g) || []).map(function (s) { return s.slice(1); });
  assert.ok(paths.every(function (p) { return ["/canvas/boards", "/canvas/templates", "/canvas/board", "/canvas/versions", "/canvas/save", "/canvas/restore", "/canvas/delete", "/ops/board", "/reg/map", "/incidents/list", "/planner/all"].indexOf(p) !== -1; }), "the page itself still talks to no new address");
});

test("share.js only talks to the share, hub search and canvas boards routes, and builds text only", function () {
  var src = code(read("share.js"));
  assert.ok(/var CANVAS_API = "https:\/\/api\.barnyard\.site\/canvas";/.test(src));
  assert.ok(/call\("GET", "\/boards", undefined, CANVAS_API\)/.test(src));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src));
  assert.ok(/window\.BarnyardShareUI = \{/.test(src) && /openFor: function \(kind, id\)/.test(src) && /countLive: function \(id\)/.test(src));
});

// ---- the Overview tile --------------------------------------------------------------------------------------------------------------

var NOW = Date.parse("2026-11-02T06:00:00Z"), MIN = 60000, HOUR = 3600000;
function board(id, title, items, ago) { return { id: id, title: title, rev: 3, items: items, bytes: 10, createdAt: NOW - 9 * HOUR, updatedAt: NOW - ago }; }

test("the tile says when the Canvas is off or has no boards, and otherwise lists the newest five with a link that opens each", function () {
  assert.deepStrictEqual([T.model(null, NOW).state, T.model({ enabled: false }, NOW).state, T.model({ boards: [] }, NOW).state], ["off", "off", "empty"]);
  var m = T.model({ boards: [
    board("cb_aaaa1111", "Old", 1, 5 * HOUR), board("cb_bbbb2222", "Network", 12, 10 * MIN), board("cb_cccc3333", "Plan", 1, 2 * HOUR),
    board("cb_dddd4444", "D", 0, 3 * HOUR), board("cb_eeee5555", "E", 2, 4 * HOUR), board("cb_ffff6666", "F", 2, 6 * HOUR), { id: "bad", title: "x" }
  ] }, NOW);
  assert.strictEqual(m.state, "ok");
  assert.strictEqual(m.text, "6 boards, 18 items in all.");
  assert.deepStrictEqual(m.rows.map(function (r) { return r.title; }), ["Network", "Plan", "D", "E", "Old"], "newest change first, five at most");
  assert.deepStrictEqual([m.rows[0].line, m.rows[0].href], ["12 items · changed 10 min ago", "canvas.html#cb_bbbb2222"]);
  assert.strictEqual(m.rows[1].line, "1 item · changed 2 h ago");
  assert.strictEqual(T.model({ boards: [board("cb_aaaa1111", "x".repeat(200), 1, MIN)] }, NOW).rows[0].title.length, 80);
});

test("the tile is described for the Overview board: owner only, tile.canvas, sizes in order", function () {
  var d = T.descriptor;
  assert.deepStrictEqual([d.id, d.permission, d.ownerOnly], ["canvas", "tile.canvas", true]);
  assert.ok(d.minW <= d.w && d.w <= d.maxW && d.minH <= d.h && d.h <= d.maxH && d.maxW <= 12);
});

test("the tile reads only GET /canvas/boards, links only to canvas.html, and builds text only", function () {
  var src = code(read("tile-canvas.js"));
  var paths = (src.match(/"\/[a-z][^"]*"/g) || []).map(function (p) { return p.replace(/"/g, ""); }).filter(function (p) { return /^\/(canvas|hub|reg|share)/.test(p); });
  assert.deepStrictEqual(paths, ["/canvas/boards"]);
  assert.ok(/K\.call\("GET", "\/canvas\/boards"\)/.test(src));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src), "text only");
  assert.ok(/open\.href = "canvas\.html"/.test(src));
  assert.ok(/BOARD_ID = \/\^cb_\[a-z0-9\]\{8\}\$\//.test(src), "a link is only made from a well-formed board id");
});

test("the Overview page loads the tile script after the shared tile kit", function () {
  var index = read("index.html");
  assert.ok(/src="tile-canvas\.js(\?v=[0-9a-f]+)?"/.test(index));
  assert.ok(index.indexOf("tile-kit.js") < index.indexOf("tile-canvas.js"));
});

console.log("\n" + passed + " passed");
