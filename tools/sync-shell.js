// Keeps the shared shell files identical across the four Barnyard sites (hub, Study, Campaign, Stocks).
//
// shell.js, themes.js and shell.css are written once, here, and hand-copied unchanged into the other three
// repos (none of them has a build step). Copies drift when a change reaches one repo and not the others, and
// the drift shows up as a nav item or a setting that works on one site and not on another. This makes the
// copy a command and the check a test.
//
//   node tools/sync-shell.js [dir...]           copy any file that differs into each sibling checkout
//   node tools/sync-shell.js --check [dir...]   change nothing; exit 1 listing every file that differs or is missing
//   node tools/sync-shell.js --live             compare this repo's files with what the four sites serve right now
//
// With no dir the siblings are ../study-hub ../campaign-hub ../market-dashboard (next to this checkout). A folder
// that is not there is skipped, so the check runs anywhere. Line endings are ignored when comparing, so a Windows
// (CRLF) checkout and GitHub's (LF) copy count as the same file.
//
// After copying, commit and open a pull request in each repo, and bump that site's cache tag for the changed
// file (the pages name it as shell.js?v=NN) so visitors fetch the new one at once.

var fs = require("fs");
var path = require("path");

var FILES = ["shell.js", "themes.js", "shell.css"];
var SIBLINGS = ["../study-hub", "../campaign-hub", "../market-dashboard"];
var SITES = {
  hub: "https://dashboard.barnyard.site",
  study: "https://study.barnyard.site",
  campaign: "https://campaign.barnyard.site",
  stocks: "https://stocks.barnyard.site"
};

function lf(text) { return text.split("\r\n").join("\n"); }

function read(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; }
}

// One entry per shared file: {file, state: "same" | "differs" | "missing"}.
function compare(srcDir, targetDir) {
  return FILES.map(function (file) {
    var want = read(path.join(srcDir, file));
    if (want === null) throw new Error(file + " is not in " + srcDir);
    var have = read(path.join(targetDir, file));
    var state = have === null ? "missing" : lf(have) === lf(want) ? "same" : "differs";
    return { file: file, state: state };
  });
}

// Copies each file that is not the same; returns the names it wrote.
function copy(srcDir, targetDir) {
  var wrote = [];
  compare(srcDir, targetDir).forEach(function (c) {
    if (c.state === "same") return;
    fs.writeFileSync(path.join(targetDir, c.file), fs.readFileSync(path.join(srcDir, c.file)));
    wrote.push(c.file);
  });
  return wrote;
}

function parseArgs(argv) {
  var out = { mode: "copy", dirs: [] };
  argv.forEach(function (a) {
    if (a === "--check") out.mode = "check";
    else if (a === "--live") out.mode = "live";
    else if (a.slice(0, 2) === "--") throw new Error("unknown option " + a);
    else out.dirs.push(a);
  });
  return out;
}

async function liveReport(srcDir, fetchFn) {
  var rows = [];
  for (var name in SITES) {
    for (var i = 0; i < FILES.length; i++) {
      var file = FILES[i], state;
      try {
        var res = await fetchFn(SITES[name] + "/" + file + "?sync=" + Date.now(), { cache: "no-store" });
        state = !res.ok ? "http " + res.status : lf(await res.text()) === lf(read(path.join(srcDir, file))) ? "same" : "differs";
      } catch (e) { state = "unreachable"; }
      rows.push({ site: name, file: file, state: state });
    }
  }
  return rows;
}

async function main(argv) {
  var opts = parseArgs(argv);
  var root = path.join(__dirname, "..");
  if (opts.mode === "live") {
    var rows = await liveReport(root, fetch);
    rows.forEach(function (r) { console.log((r.state === "same" ? "ok       " : "DIFFERENT ") + r.site + "/" + r.file + (r.state === "same" ? "" : "  (" + r.state + ")")); });
    var bad = rows.filter(function (r) { return r.state !== "same"; });
    console.log(bad.length ? bad.length + " of " + rows.length + " live files are not the same as this repo's" : "all " + rows.length + " live files match this repo");
    return bad.some(function (r) { return r.state !== "differs"; }) ? 2 : bad.length ? 1 : 0;
  }
  var dirs = (opts.dirs.length ? opts.dirs : SIBLINGS).map(function (d) { return path.resolve(root, d); });
  var problems = 0, seen = 0;
  dirs.forEach(function (dir) {
    if (!fs.existsSync(dir)) { console.log("skipped   " + dir + " (not here)"); return; }
    seen++;
    if (opts.mode === "check") {
      compare(root, dir).forEach(function (c) {
        if (c.state !== "same") { problems++; console.log("DIFFERENT " + dir + path.sep + c.file + "  (" + c.state + ")"); }
      });
    } else {
      var wrote = copy(root, dir);
      console.log((wrote.length ? "copied    " + wrote.join(", ") + " into " : "unchanged ") + dir);
    }
  });
  if (opts.mode === "check") console.log(problems ? problems + " file(s) differ from this repo's" : "checked " + seen + " folder(s): every shared file matches");
  return problems ? 1 : 0;
}

module.exports = { FILES: FILES, SIBLINGS: SIBLINGS, SITES: SITES, compare: compare, copy: copy, parseArgs: parseArgs, liveReport: liveReport };

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) { console.error(e.message); process.exitCode = 2; });
}
