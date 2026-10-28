// Coverage for the command palette in shell.js (Ctrl+K): the parts that need no page (matching and ranking, the links it
// will follow, what it files, the search cache and limit), and the rules the browser half must keep.
//
//   node test/palette.test.js
//
// Same pattern as the other tests here: plain Node, standard library only. shell.js exports its logic when loaded
// without a document.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var P = require(path.join(root, "shell.js"));
var src = fs.readFileSync(path.join(root, "shell.js"), "utf8");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("score: the same words beat a start, a start beats a later word, a later word beats a middle", function () {
  assert.strictEqual(P.score("ops board", "Ops board"), 100);
  assert.ok(P.score("ops", "Ops board") > P.score("board", "Ops board"));
  assert.ok(P.score("board", "Ops board") > P.score("oar", "Ops board"));
  assert.strictEqual(P.score("zzz", "Ops board"), 0);
  assert.strictEqual(P.score("", "anything"), 1);
});

test("score: every word of the query may start a different word, and short queries may skip letters", function () {
  assert.ok(P.score("add pro", "Add an Ops proposal") > 0);
  assert.ok(P.score("ovw", "Overview") > 0);
  assert.strictEqual(P.score("ovwx", "Overview"), 0);
  assert.strictEqual(P.score("overviewy", "Overview"), 0);
});

test("score ignores case and runs of spaces", function () {
  assert.strictEqual(P.score("  OPS   BOARD ", "ops board"), 100);
});

test("rank: best first, ties keep their order, the limit holds, an empty query keeps everything in order", function () {
  var items = [{ title: "Calendar" }, { title: "Cal tools" }, { title: "Monitoring", keywords: "alerts calendar" }, { title: "Users" }];
  assert.deepStrictEqual(P.rank(items, "cal").map(function (i) { return i.title; }), ["Calendar", "Cal tools", "Monitoring"]);
  assert.deepStrictEqual(P.rank(items, "").map(function (i) { return i.title; }), ["Calendar", "Cal tools", "Monitoring", "Users"]);
  assert.strictEqual(P.rank(items, "", 2).length, 2);
  assert.deepStrictEqual(P.rank(items, "zzz"), []);
  assert.deepStrictEqual(P.rank(null, "x"), []);
});

test("safeHref: a hub page or a study site article, nothing else", function () {
  assert.strictEqual(P.safeHref("ops.html#it_abc123"), "https://dashboard.barnyard.site/ops.html#it_abc123");
  assert.strictEqual(P.safeHref("calendar.html"), "https://dashboard.barnyard.site/calendar.html");
  assert.strictEqual(P.safeHref("https://study.barnyard.site/knowledgebase.html#/a/ka_1"), "https://study.barnyard.site/knowledgebase.html#/a/ka_1");
  assert.strictEqual(P.safeHref("https://study.barnyard.site/notes.html#nt_1"), "https://study.barnyard.site/notes.html#nt_1");
  ["https://evil.example/", "javascript:alert(1)", "//evil.example/x.html", "../ops.html", "ops.html#a b", "ops.html?x=1", "https://study.barnyard.site.evil.example/notes.html#a", "", null, undefined].forEach(function (bad) {
    assert.strictEqual(P.safeHref(bad), "", String(bad));
  });
});

test("cleanGroups: keeps titles and checked links, drops skipped, failed and unsafe rows", function () {
  var out = P.cleanGroups({ groups: [
    { id: "ops", title: "Ops board", items: [{ title: "Renew the domain", hint: "Proposal", href: "ops.html#it_1" }, { title: "Bad link", hint: "x", href: "https://evil.example/" }, { title: "", href: "ops.html#it_2" }] },
    { id: "notebook", title: "Notebook", skipped: true, items: [] },
    { id: "kb", title: "Knowledgebase", error: true, items: [] },
    { id: "kb2", title: "Knowledgebase", items: [{ title: "Backups", hint: "Article", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_9" }] }
  ] });
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { title: "Ops board", items: [{ title: "Renew the domain", hint: "Proposal", href: "https://dashboard.barnyard.site/ops.html#it_1" }] });
  assert.strictEqual(out[1].items[0].href, "https://study.barnyard.site/knowledgebase.html#/a/ka_9");
  assert.deepStrictEqual(P.cleanGroups(null), []);
  assert.deepStrictEqual(P.cleanGroups({ groups: "no" }), []);
});

test("capture: a to-do takes the first line as the title and the rest as notes", function () {
  var r = P.capture("todo", "Renew the domain\nCheck the registrar first");
  assert.strictEqual(r.path, "/planner/task");
  assert.strictEqual(r.body.title, "Renew the domain");
  assert.strictEqual(r.body.notes, "Renew the domain\nCheck the registrar first");
  assert.strictEqual(P.capture("todo", "  Buy milk  ").body.notes, undefined);
  assert.strictEqual(P.capture("todo", "x".repeat(300)).body.title.length, 200);
});

test("capture: a proposal is filed in the backlog, as a proposal, with the whole text as details when it is longer than the title", function () {
  var r = P.capture("proposal", "Add a thing\nbecause reasons");
  assert.strictEqual(r.path, "/ops/items");
  assert.deepStrictEqual(r.body, { title: "Add a thing", lane: "backlog", category: "other", proposal: true, details: "Add a thing\nbecause reasons" });
  assert.strictEqual(P.capture("proposal", "Short").body.details, undefined);
  assert.strictEqual(P.capture("proposal", "x".repeat(150)).body.title.length, 120);
});

test("capture: nothing, or far too much, or an unknown kind, files nothing", function () {
  assert.strictEqual(P.capture("todo", "   "), null);
  assert.strictEqual(P.capture("todo", ""), null);
  assert.strictEqual(P.capture("todo", null), null);
  assert.strictEqual(P.capture("todo", "a\n" + "x".repeat(5000)), null);
  assert.strictEqual(P.capture("proposal", "a\n" + "x".repeat(7000)), null);
  assert.strictEqual(P.capture("delete-everything", "hello"), null);
});

test("cache: an answer is remembered for 60 seconds, then asked again; the cache never holds more than its limit", function () {
  var now = 1000, c = P.makeCache(function () { return now; });
  c.set("backup", [1]);
  assert.deepStrictEqual(c.get("backup"), [1]);
  now += 59000;
  assert.deepStrictEqual(c.get("backup"), [1]);
  now += 2000;
  assert.strictEqual(c.get("backup"), null);
  for (var i = 0; i < P.CACHE_MAX + 5; i++) c.set("q" + i, [i]);
  assert.strictEqual(c.get("q0"), null, "the oldest were dropped");
  assert.deepStrictEqual(c.get("q" + (P.CACHE_MAX + 4)), [P.CACHE_MAX + 4]);
});

test("limiter: ten searches a minute, then none until the minute has passed", function () {
  var now = 0, l = P.makeLimiter(P.PER_MINUTE, 60000, function () { return now; }), took = 0;
  for (var i = 0; i < 15; i++) { if (l.take()) took++; now += 1000; }
  assert.strictEqual(took, 10);
  now = 70000;
  assert.strictEqual(l.take(), true);
});

test("the search waits for a settled query: three letters, 450 ms, ten a minute, 60 s cache", function () {
  assert.strictEqual(P.SERVER_MIN, 3);
  assert.strictEqual(P.DEBOUNCE_MS, 450);
  assert.strictEqual(P.PER_MINUTE, 10);
  assert.strictEqual(P.CACHE_MS, 60000);
});

test("shell.js: Ctrl/Cmd+K opens the palette unless the page already used the key", function () {
  assert.ok(/window\.addEventListener\("keydown"[\s\S]{0,400}e\.defaultPrevented/.test(src), "the shortcut listener checks defaultPrevented");
  assert.ok(/String\(e\.key\)\.toLowerCase\(\) !== "k"/.test(src));
});

test("shell.js: the palette only asks the server from the hub's own origin, for its signed-in owner, and never builds HTML from text", function () {
  assert.ok(/function onHubOrigin\(\) \{ return location\.origin === Logic\.HUB_ORIGIN; \}/.test(src));
  assert.ok(/function paletteServerOk\(\) \{ return onHubOrigin\(\) && signedInOwner\(\); \}/.test(src));
  assert.ok(/palette\.mode \|\| !paletteServerOk\(\)/.test(src), "no request while in a typing mode or for anyone else");
  var assigns = src.match(/\.innerHTML\s*=/g) || [];
  assert.strictEqual(assigns.length, 1, "the one innerHTML assignment is still the icon table");
});

test("shell.js: a page the owner hid from someone is not offered to them", function () {
  assert.ok(/PAGES\.filter\(pageAllowed\)\.forEach\(function \(p\) \{\s*list\.push\(\{ group: "Go to"/.test(src));
  assert.ok(/mayUse\("calendar\.view"\)/.test(src) && /mayUse\("ops\.view"\)/.test(src));
});

console.log("\n" + passed + " passed");
