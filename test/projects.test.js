// Coverage for the Projects page: the pure rules (projects-logic.js), the plan data (projects-data.js), and the page and menu entry
// around them (the page only reads, draws with textContent, loads its files in order, and the Projects link is in the menu).
//
//   node test/projects.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var L = require(path.join(root, "projects-logic.js"));
var DATA = require(path.join(root, "projects-data.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(f) { return fs.readFileSync(path.join(root, f), "utf8").split("\r\n").join("\n"); }
function code(src) { return src.split("\n").filter(function (l) { return l.trim().indexOf("//") !== 0; }).join("\n"); }

var RL = DATA.projects[0];
var TODAY = "2026-11-23";

function item(over) {
  return Object.assign({
    id: "it_aaaaaaaa", title: "RL R1: First", lane: "backlog", status: "planned", category: "other", targets: [], priority: "normal",
    owner: "claude", next: "", details: "", due: "", proposal: false, summary: "", progress: "", steps: [], addedAt: 1, updatedAt: 1, doneAt: null
  }, over);
}
var n = 0;
function mk(title, over) { n++; return item(Object.assign({ id: "it_" + ("0000000" + n).slice(-8).replace(/0/g, "a").slice(0, 8), title: title }, over || {})); }

// ---- which items belong to the project --------------------------------------------------------------------------------------------

test("phaseOf reads RL R<number>: Name, and nothing else", function () {
  assert.deepStrictEqual(L.phaseOf("RL R3: Back end", RL), { n: 3, label: "R3", name: "Back end" });
  assert.deepStrictEqual(L.phaseOf("RL R10:Costs register", RL), { n: 10, label: "R10", name: "Costs register" });
  assert.strictEqual(L.phaseOf("RL roadmap: master", RL), null);
  assert.strictEqual(L.phaseOf("RL R: nothing", RL), null);
  assert.strictEqual(L.phaseOf("rl R3: lower case prefix", RL), null);
  assert.strictEqual(L.phaseOf("Other R3: x", RL), null);
});

test("the master is the item whose title starts with the master prefix, in any case", function () {
  assert.ok(L.isMaster("RL roadmap: master plan", RL));
  assert.ok(L.isMaster("RL Roadmap: MASTER", RL));
  assert.ok(!L.isMaster("RL R1: First", RL));
  assert.ok(!L.isMaster("roadmap: master", RL));
  assert.strictEqual(L.masterName("RL roadmap: master plan"), "master plan");
});

test("buildModel keeps only items that start with the prefix, and sorts phases R1..R10 numerically", function () {
  var items = [
    mk("RL R10: Costs"), mk("RL R2: Two"), mk("RL R1: One"), mk("Unrelated item"), mk("RL roadmap: master plan"),
    mk("RL R9: Nine"), mk("RL stray note"), mk("rl R3: wrong case"), mk("RL R3: Three")
  ];
  var m = L.buildModel(items, RL);
  assert.deepStrictEqual(m.phases.map(function (p) { return p.label; }), ["R1", "R2", "R3", "R9", "R10"]);
  assert.strictEqual(m.master.title, "RL roadmap: master plan");
  assert.deepStrictEqual(m.extras.map(function (i) { return i.title; }), ["RL stray note"]);
  assert.ok(m.phases[4].costs && !m.phases[0].costs, "R10 is the costs register");
});

test("buildModel copes with nothing, bad entries and no master", function () {
  assert.deepStrictEqual(L.buildModel([], RL), { master: null, phases: [], extras: [] });
  assert.deepStrictEqual(L.buildModel(null, RL), { master: null, phases: [], extras: [] });
  var m = L.buildModel([null, { title: 5 }, mk("RL R1: x")], RL);
  assert.strictEqual(m.phases.length, 1);
  assert.strictEqual(m.master, null);
});

test("a second project is just another config object", function () {
  var other = { prefix: "WEB ", masterPrefix: "WEB plan:", phasePrefix: "WEB P", costsPhase: 4 };
  var m = L.buildModel([mk("WEB P2: Build"), mk("WEB P1: Design"), mk("WEB plan: master"), mk("RL R1: not mine")], other);
  assert.deepStrictEqual(m.phases.map(function (p) { return p.label; }), ["P1", "P2"]);
  assert.ok(m.master);
});

test("mergeItems joins the open board and the finished items, once each", function () {
  var a = mk("RL R1: a"), b = mk("RL R2: b");
  var done = [Object.assign({}, a, { lane: "done" }), mk("RL R3: c", { lane: "done" })];
  var out = L.mergeItems([a, b], done);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].lane, "backlog", "the open one wins");
  assert.deepStrictEqual(L.mergeItems(null, undefined), []);
});

// ---- counts, dates ----------------------------------------------------------------------------------------------------------------

test("laneCounts counts open phases per lane and leaves proposals out", function () {
  var m = L.buildModel([
    mk("RL R1: a", { lane: "in_progress" }), mk("RL R2: b", { lane: "in_progress" }), mk("RL R3: c", { lane: "waiting" }),
    mk("RL R4: d", { lane: "backlog" }), mk("RL R5: e", { lane: "soaking" }), mk("RL R6: f", { lane: "done" }),
    mk("RL R7: g", { lane: "backlog", proposal: true })
  ], RL);
  assert.deepStrictEqual(L.laneCounts(m.phases), { in_progress: 2, soaking: 1, waiting: 1, backlog: 1, done: 1, total: 6 });
});

test("dueInfo says how far off a date is and colours it", function () {
  assert.deepStrictEqual(L.dueInfo("2026-11-23", TODAY), { date: "23 Nov 2026", rel: "today", text: "23 Nov 2026 · today", tone: "soon", days: 0 });
  assert.strictEqual(L.dueInfo("2026-11-24", TODAY).rel, "tomorrow");
  assert.strictEqual(L.dueInfo("2026-12-03", TODAY).rel, "in 10 days");
  assert.strictEqual(L.dueInfo("2026-12-03", TODAY).tone, "later");
  assert.strictEqual(L.dueInfo("2026-11-20", TODAY).rel, "3 days overdue");
  assert.strictEqual(L.dueInfo("2026-11-20", TODAY).tone, "overdue");
  assert.strictEqual(L.dueInfo("", TODAY), null);
  assert.strictEqual(L.dueInfo("2026-13-40", TODAY), null);
  assert.strictEqual(L.daysUntil("2027-01-01", "2026-12-31"), 1);
});

test("nextDue is the earliest open phase date, overdue included; done and undated are skipped", function () {
  var m = L.buildModel([
    mk("RL R1: a", { lane: "done", due: "2026-11-01" }), mk("RL R2: b", { lane: "in_progress", due: "2026-12-10" }),
    mk("RL R3: c", { lane: "waiting", due: "2026-11-30" }), mk("RL R4: d", { lane: "backlog" }), mk("RL R5: e", { lane: "backlog", due: "2026-11-30" })
  ], RL);
  var nd = L.nextDue(m.phases, TODAY);
  assert.strictEqual(nd.phase.label, "R3", "ties go to the lower phase number");
  assert.strictEqual(nd.info.rel, "in 7 days");
  assert.strictEqual(nd.overdue, 0);
  var late = L.buildModel([mk("RL R1: a", { lane: "waiting", due: "2026-11-10" }), mk("RL R2: b", { lane: "waiting", due: "2026-11-12" }), mk("RL R3: c", { lane: "waiting", due: "2026-12-01" })], RL);
  var nl = L.nextDue(late.phases, TODAY);
  assert.strictEqual(nl.phase.label, "R1");
  assert.strictEqual(nl.overdue, 2);
  assert.strictEqual(nl.info.tone, "overdue");
  assert.strictEqual(L.nextDue(L.buildModel([mk("RL R1: a")], RL).phases, TODAY), null);
});

// ---- steps and words --------------------------------------------------------------------------------------------------------------

test("splitSteps separates your acts from Claude's, with done counts", function () {
  var s = L.splitSteps({ steps: [{ text: "Approve", who: "you", done: true }, { text: "Build", who: "claude", done: false }, { text: "Copy", who: "you" }, { text: "x", who: "claude", done: true }, null, { who: "you" }] });
  assert.deepStrictEqual(s.you.map(function (x) { return x.text + ":" + x.done; }), ["Approve:true", "Copy:false"]);
  assert.deepStrictEqual(s.claude.map(function (x) { return x.text; }), ["Build", "x"]);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.done, 2);
  assert.strictEqual(L.openCount(s.you), 1);
  assert.deepStrictEqual(L.splitSteps({}), { you: [], claude: [], total: 0, done: 0 });
});

test("the link to an item is its Ops board deep link, and only for a real board id", function () {
  assert.strictEqual(L.itemHref({ id: "it_ab12cd34" }), "ops.html#it_ab12cd34");
  assert.strictEqual(L.itemHref({ id: "it_AB" }), "");
  assert.strictEqual(L.itemHref({ id: "javascript:alert(1)" }), "");
  assert.strictEqual(L.itemHref(null), "");
});

test("summaryOf uses the item's summary, else the first paragraph of its details", function () {
  assert.strictEqual(L.summaryOf({ summary: "S", details: "D" }), "S");
  assert.strictEqual(L.summaryOf({ details: "First para.\n\nSecond." }), "First para.");
  assert.strictEqual(L.summaryOf({ details: "x".repeat(400) }).length, 320);
  assert.strictEqual(L.summaryOf({}), "");
});

test("clip cuts long text at a word", function () {
  assert.strictEqual(L.clip("short", 20), "short");
  assert.strictEqual(L.clip("one two three four five six", 15), "one two three…");
  assert.strictEqual(L.clip("", 5), "");
  assert.ok(L.clip("x".repeat(50), 10).length <= 10);
});

test("lane and status words match the Ops board's", function () {
  assert.strictEqual(L.laneTitle("in_progress"), "In progress");
  assert.strictEqual(L.laneTitle("waiting"), "Waiting on you");
  assert.strictEqual(L.statusTitle("decision_needed"), "Decision needed");
  assert.strictEqual(L.statusTitle("odd_new_status"), "odd new status");
  assert.strictEqual(L.statusTone("blocked"), "alert");
  assert.strictEqual(L.statusTone("whatever"), "hollow");
});

// ---- the timeline -----------------------------------------------------------------------------------------------------------------

var TL = { start: "2026-11", months: 12 };

test("monthHeads runs Nov 26 to Oct, then Later, with the year on the first month and each January", function () {
  var h = L.monthHeads(TL);
  assert.deepStrictEqual(h.map(function (m) { return m.label; }), ["Nov 26", "Dec", "Jan 27", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Later"]);
  assert.ok(h[2].yearStart && !h[1].yearStart);
  assert.ok(h[12].later);
  assert.strictEqual(h[11].name, "Oct 2027");
});

test("currentColumn finds this month, before the start, and after the end (Later)", function () {
  assert.strictEqual(L.currentColumn(TL, "2026-11-23"), 0);
  assert.strictEqual(L.currentColumn(TL, "2027-01-02"), 2);
  assert.strictEqual(L.currentColumn(TL, "2027-10-31"), 11);
  assert.strictEqual(L.currentColumn(TL, "2027-11-01"), 12);
  assert.strictEqual(L.currentColumn(TL, "2026-10-31"), -1);
  assert.strictEqual(L.currentColumn(TL, "nonsense"), -1);
});

test("rowCells covers every column exactly once, with the bar's span", function () {
  var cells = L.rowCells({ bars: [{ from: 1, to: 2, label: "B", kind: "owner" }] }, TL);
  assert.deepStrictEqual(cells.map(function (c) { return c.span; }), [1, 2, 10]);
  assert.deepStrictEqual(cells.map(function (c) { return !!c.bar; }), [false, true, false]);
  assert.strictEqual(cells[1].bar.kind, "owner");
  assert.deepStrictEqual(L.rowCells({ bars: [] }, TL).map(function (c) { return c.span; }), [13]);
  assert.deepStrictEqual(L.rowCells({ bars: [{ from: 0, to: 12, label: "all", kind: "build" }] }, TL).map(function (c) { return c.span; }), [13]);
});

test("rowCells cuts overlaps and anything past the last column, and fixes an unknown kind", function () {
  var cells = L.rowCells({ bars: [{ from: 3, to: 20, label: "late", kind: "nope" }, { from: 0, to: 4, label: "early", kind: "build" }] }, TL);
  var total = cells.reduce(function (a, c) { return a + c.span; }, 0);
  assert.strictEqual(total, 13);
  assert.deepStrictEqual(cells.map(function (c) { return c.bar ? c.bar.label : null; }), ["early", "late"]);
  assert.strictEqual(cells[1].bar.from, 5);
  assert.strictEqual(cells[1].bar.to, 12);
  assert.strictEqual(cells[1].bar.kind, "build");
});

test("legendKinds lists only the kinds the data uses, and barRange reads out a bar's months", function () {
  assert.deepStrictEqual(L.legendKinds(RL.timeline), ["build", "owner", "dash"]);
  var heads = L.monthHeads(TL);
  assert.strictEqual(L.barRange({ from: 2, to: 3 }, heads), "Jan 2027 to Feb 2027");
  assert.strictEqual(L.barRange({ from: 0, to: 0 }, heads), "Nov 2026");
  assert.strictEqual(L.barRange({ from: 11, to: 12 }, heads), "Oct 2027 to Later");
});

// ---- sittings and costs ------------------------------------------------------------------------------------------------------------

test("nextSitting is the first dated sitting from today on, never an act or an undated row", function () {
  var s = [
    { n: "0", kind: "sitting", date: "2026-11-01" }, { n: "1a", kind: "act", date: "2026-11-23" },
    { n: "2", kind: "sitting", when: "Dec" }, { n: "1b", kind: "sitting", date: "2026-11-30" }, { n: "1", kind: "sitting", date: "2026-11-23" }
  ];
  assert.strictEqual(L.nextSitting(s, TODAY).n, "1");
  assert.strictEqual(L.nextSitting(s, "2026-11-24").n, "1b");
  assert.strictEqual(L.nextSitting(s, "2026-12-01"), null);
  assert.strictEqual(L.nextSitting(null, TODAY), null);
});

test("the three confidence tags are verified, doc and estimate", function () {
  assert.deepStrictEqual(["ver", "doc", "est"].map(function (t) { return L.confidence(t).word; }), ["verified", "doc", "estimate"]);
  assert.strictEqual(L.confidence("other"), null);
});

// ---- the plan data -----------------------------------------------------------------------------------------------------------------

test("every project's data passes the checks the page makes before drawing it", function () {
  assert.ok(DATA.projects.length >= 1);
  var ids = {};
  DATA.projects.forEach(function (p) {
    assert.deepStrictEqual(L.checkProject(p), [], p.id);
    assert.ok(!ids[p.id], "ids are unique");
    ids[p.id] = true;
  });
});

test("checkProject catches a broken bar, kind, tag and date", function () {
  function copy() { return JSON.parse(JSON.stringify(RL)); }
  var a = copy(); a.timeline.tracks[0].rows[0].bars[0].to = 99;
  assert.ok(L.checkProject(a).some(function (m) { return /range/.test(m); }));
  var b = copy(); b.timeline.tracks[0].rows[0].bars[0].kind = "pink";
  assert.ok(L.checkProject(b).some(function (m) { return /kind/.test(m); }));
  var c = copy(); c.costs[0].basis[0].tag = "guess";
  assert.ok(L.checkProject(c).some(function (m) { return /tag/.test(m); }));
  var d = copy(); d.sittings[0].date = "23/11/2026";
  assert.ok(L.checkProject(d).some(function (m) { return /date/.test(m); }));
  var e = copy(); e.phasePrefix = "XX R";
  assert.ok(L.checkProject(e).some(function (m) { return /phasePrefix/.test(m); }));
});

test("Remote Layout carries the reference plan: tracks A to G, the sittings, the costs and the scenario totals", function () {
  assert.strictEqual(RL.name, "Remote Layout");
  assert.strictEqual(RL.prefix, "RL ");
  assert.deepStrictEqual(RL.timeline.tracks.map(function (t) { return t.id; }), ["A", "B", "C", "D", "E", "F", "G"]);
  assert.deepStrictEqual(RL.timeline.tracks.map(function (t) { return t.rows.length; }), [6, 3, 3, 2, 2, 3, 1]);
  assert.strictEqual(RL.timeline.months, 12);
  assert.strictEqual(RL.milestones.length, 6);
  assert.strictEqual(RL.sittings.length, 17);
  assert.strictEqual(RL.costs.length, 17);
  assert.deepStrictEqual(RL.scenarios.map(function (s) { return s.value; }), ["about 350 to 800", "+ 1,200 to 3,500", "+ 13,500 to 41,000", "+ 1,200 to 2,700"]);
  // Spot-check bars against the reference's grid columns (column 2 is November): Sitting 1 is Nov, the penetration test runs Jun to Later.
  var a = RL.timeline.tracks[0].rows[0].bars[0], g = RL.timeline.tracks[6].rows[0].bars[0];
  assert.deepStrictEqual([a.from, a.to, a.kind], [0, 0, "owner"]);
  assert.deepStrictEqual([g.from, g.to, g.kind], [7, 12, "owner"]);
  assert.strictEqual(RL.timeline.tracks[5].rows[0].bars[0].kind, "dash");
  assert.deepStrictEqual(RL.sittings.filter(function (s) { return s.kind === "act"; }).map(function (s) { return s.n; }), ["1a", "3", "4", "5", "15"]);
  assert.strictEqual(L.nextSitting(RL.sittings, TODAY).n, "1");
  assert.ok(/planning estimates/.test(RL.estimateNote));
});

// ---- the page, and its menu entry ----------------------------------------------------------------------------------------------------

test("the page loads its data and logic before its own script, and sits in the shared shell", function () {
  var html = read("projects.html");
  assert.ok(/<body data-shell="projects" data-wide>/.test(html));
  assert.ok(/<main id="page" class="content">/.test(html) && /<div class="page-head">/.test(html));
  var order = ["shell.js", "auth-gate.js", "projects-data.js", "projects-logic.js", "projects.js"].map(function (f) { return html.indexOf('src="' + f); });
  assert.ok(order.every(function (i) { return i > 0; }) && order.slice().sort(function (a, b) { return a - b; }).join() === order.join(), "order: " + order);
  assert.ok(/<title>Projects &middot; Barnyard<\/title>/.test(html));
});

test("the page's policy allows only this site and the API, and the page has no inline script or style", function () {
  var html = read("projects.html");
  var csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.ok(/connect-src 'self' https:\/\/api\.barnyard\.site;/.test(csp));
  assert.ok(!/unsafe-inline|unsafe-eval|wss:|\*/.test(csp));
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script");
  assert.ok(!/\sstyle="/.test(html) && !/<style/.test(html), "no inline style");
  assert.ok(!/https?:\/\/(?!api\.barnyard\.site)/.test(html.replace(/<meta http-equiv[^>]+>/, "")), "no other web address");
});

test("the page only reads: GET to /ops/board and /ops/done, text set with textContent, nothing written", function () {
  var js = code(read("projects.js"));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "no way to turn text into markup");
  assert.ok(!/method\s*:\s*["'](POST|PUT|PATCH|DELETE)/i.test(js), "no write call");
  assert.ok(!/WebSocket|localStorage|sessionStorage|document\.cookie|\.setAttribute\(["']style/.test(js));
  assert.ok(/getJson\("\/board"\)/.test(js) && /getJson\("\/done\?limit=100"\)/.test(js));
  assert.ok(/API = "https:\/\/api\.barnyard\.site\/ops"/.test(js));
  assert.ok(/credentials: "include"/.test(js) && /referrerPolicy: "no-referrer"/.test(js));
  var logic = code(read("projects-logic.js")) + code(read("projects-data.js"));
  assert.ok(!/fetch\(|XMLHttpRequest|innerHTML|\bdocument\.(get|create|query|body|write)/.test(logic), "logic and data touch neither the network nor the page");
});

test("each project's phase items link to the Ops board's own deep link", function () {
  assert.ok(/L\.itemHref\(item\)/.test(read("projects.js")));
  assert.ok(/ops\.html#/.test(read("projects-logic.js")));
});

test("the Projects link is in the menu, owner only, in Work, between the Ops board and Vulnerabilities", function () {
  var shell = read("shell.js");
  var m = /\{ id: "projects", title: "Projects"[^\n]*\},?\n/.exec(shell);
  assert.ok(m, "entry exists");
  assert.ok(/group: "Work"/.test(m[0]) && /path: "projects\.html"/.test(m[0]) && /local: "projects\.html"/.test(m[0]) && /ownerOnly: true/.test(m[0]));
  assert.ok(/icon: "timeline"/.test(m[0]) && /timeline: '<path/.test(shell), "its icon is drawn");
  var ops = shell.indexOf('{ id: "ops", title: "Ops board"'), vuln = shell.indexOf('{ id: "vuln", title: "Vulnerabilities"');
  assert.ok(ops < shell.indexOf('{ id: "projects"') && shell.indexOf('{ id: "projects"') < vuln);
  assert.ok(/perm: "ops.view"/.test(m[0]), "it takes the Ops board's permission, an id the Worker knows");
});

test("the page stylesheet keeps to the shell's tokens and never fixes the page root's width", function () {
  var css = read("projects.css");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "no hard-coded colour");
  assert.ok(!/^#pj-root\s*\{[^}]*max-width/m.test(css));
  assert.ok(!/^\.page-head\s*\{/m.test(css));
  assert.ok(!/^\.tiles\s*\{/m.test(css), "does not touch the Settings panel's .tiles");
});

console.log(passed + " passed");
