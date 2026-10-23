// Coverage for tools/sync-shell.js (the copy of shell.js, themes.js and shell.css into the other sites), and a
// check that the copies sitting next to this checkout really are identical.
//
//   node test/shell-sync.test.js

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var S = require(path.join(__dirname, "..", "tools", "sync-shell.js"));
var root = path.join(__dirname, "..");

var passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok - " + name); }

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "shell-sync-")); }
function fill(dir, text) { S.FILES.forEach(function (f) { fs.writeFileSync(path.join(dir, f), text + f); }); }
function states(src, dst) { return S.compare(src, dst).map(function (c) { return c.state; }); }

(async function () {
  await test("the shared files are all in this repo", function () {
    S.FILES.forEach(function (f) { assert.ok(fs.existsSync(path.join(root, f)), f); });
    assert.deepStrictEqual(S.FILES, ["shell.js", "themes.js", "shell.css"]);
  });

  await test("identical, changed and missing files are told apart", function () {
    var a = tmp(), b = tmp();
    fill(a, "v1 ");
    assert.deepStrictEqual(states(a, b), ["missing", "missing", "missing"]);
    fill(b, "v1 ");
    assert.deepStrictEqual(states(a, b), ["same", "same", "same"]);
    fs.writeFileSync(path.join(b, "themes.js"), "old themes.js");
    assert.deepStrictEqual(states(a, b), ["same", "differs", "same"]);
  });

  await test("line endings do not count as a difference", function () {
    var a = tmp(), b = tmp();
    fs.writeFileSync(path.join(a, "shell.js"), "one\ntwo\n");
    fs.writeFileSync(path.join(b, "shell.js"), "one\r\ntwo\r\n");
    ["themes.js", "shell.css"].forEach(function (f) { fs.writeFileSync(path.join(a, f), "x"); fs.writeFileSync(path.join(b, f), "x"); });
    assert.deepStrictEqual(states(a, b), ["same", "same", "same"]);
  });

  await test("copy writes only what differs, and leaves the target matching", function () {
    var a = tmp(), b = tmp();
    fill(a, "new ");
    fill(b, "new ");
    fs.writeFileSync(path.join(b, "shell.css"), "stale");
    assert.deepStrictEqual(S.copy(a, b), ["shell.css"]);
    assert.strictEqual(fs.readFileSync(path.join(b, "shell.css"), "utf8"), "new shell.css");
    assert.deepStrictEqual(S.copy(a, b), []);
    assert.deepStrictEqual(states(a, b), ["same", "same", "same"]);
  });

  await test("a source file that is missing is an error, not a silent skip", function () {
    var a = tmp(), b = tmp();
    assert.throws(function () { S.compare(a, b); }, /shell\.js is not in/);
  });

  await test("options", function () {
    assert.deepStrictEqual(S.parseArgs([]), { mode: "copy", dirs: [] });
    assert.deepStrictEqual(S.parseArgs(["--check", "../x"]), { mode: "check", dirs: ["../x"] });
    assert.strictEqual(S.parseArgs(["--live"]).mode, "live");
    assert.throws(function () { S.parseArgs(["--nope"]); }, /unknown option/);
  });

  await test("live comparison reports same, differs and unreachable", async function () {
    var a = tmp();
    fill(a, "mine ");
    var fake = async function (url) {
      if (url.indexOf("study.") >= 0) throw new Error("offline");
      if (url.indexOf("campaign.") >= 0 && url.indexOf("/themes.js") >= 0) return { ok: true, text: async function () { return "older"; } };
      if (url.indexOf("stocks.") >= 0 && url.indexOf("/shell.css") >= 0) return { ok: false, status: 404 };
      var name = url.split("?")[0].split("/").pop();
      return { ok: true, text: async function () { return "mine " + name; } };
    };
    var rows = await S.liveReport(a, fake);
    var got = {};
    rows.forEach(function (r) { got[r.site + "/" + r.file] = r.state; });
    assert.strictEqual(rows.length, Object.keys(S.SITES).length * S.FILES.length);
    assert.strictEqual(got["hub/shell.js"], "same");
    assert.strictEqual(got["study/shell.js"], "unreachable");
    assert.strictEqual(got["campaign/themes.js"], "differs");
    assert.strictEqual(got["stocks/shell.css"], "http 404");
  });

  // The real thing: the checkouts next to this one. Skipped for any that are not there (CI, a fresh clone).
  for (var i = 0; i < S.SIBLINGS.length; i++) {
    var rel = S.SIBLINGS[i], dir = path.resolve(root, rel);
    if (!fs.existsSync(dir)) { console.log("skip - " + rel + " is not next to this checkout"); continue; }
    // A checkout parked on an old branch has none of the shell files at all; that is not drift, so leave it.
    if (S.compare(root, dir).every(function (c) { return c.state === "missing"; })) { console.log("skip - " + rel + " has no shell files (old branch?)"); continue; }
    await test(rel + " has the same shell files as this repo (fix: node tools/sync-shell.js)", function () {
      S.compare(root, dir).forEach(function (c) { assert.strictEqual(c.state, "same", c.file + " " + c.state + " in " + rel); });
    });
  }

  console.log(passed + " passed");
})().catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
