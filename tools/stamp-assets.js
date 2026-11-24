// Stamps every local script and stylesheet link in the site's pages with ?v=<a short hash of that file>.
//
// Why: Cloudflare keeps static files (scripts, stylesheets) for hours, so after a deploy a visitor
// can keep running yesterday's script until the cache runs out. A page's own address is not cached
// that long, so if the link inside it names the file by its content (chat.js?v=3fa91c07), a changed
// file is a new address and is fetched at once, and an unchanged file stays cached.
//
//   node tools/stamp-assets.js           rewrite the pages so every link carries its file's current hash
//   node tools/stamp-assets.js --check   change nothing; exit 1 listing any link that is missing or stale
//
// Run it after changing any script or stylesheet. test/cache-tags.test.js fails when it was forgotten.
// The hash ignores line endings, so it is the same on Windows (CRLF checkouts) and on GitHub (LF).

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

// A same-folder script or stylesheet: src="x.js" or href="x.css", with or without an old stamp.
var LINK = /\b(src|href)="([A-Za-z0-9_\-.]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g;

function hashOf(file) {
  var text = fs.readFileSync(file, "utf8").split("\r\n").join("\n");
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

// Returns {html, links:[{page, file, stamped, wanted}], missing:[file]} for one page's text.
function stampPage(html, root, pageName) {
  var links = [], missing = [];
  var out = html.replace(LINK, function (whole, attr, name) {
    var full = path.join(root, name);
    if (!fs.existsSync(full)) { missing.push(name); return whole; }
    var wanted = hashOf(full);
    var had = /\?v=([0-9a-f]+)"$/.exec(whole);
    links.push({ page: pageName, file: name, stamped: had ? had[1] : null, wanted: wanted });
    return attr + '="' + name + "?v=" + wanted + '"';
  });
  return { html: out, links: links, missing: missing };
}

// The look layers (look-layers/<id>.css and <id>.js) are fetched on demand by themes.js, so no page links them; the cache
// version of each is a field in that look's own registry line in themes.js (v for the .css, jv for the .js). This keeps those
// fields equal to the files' current hashes, and runs before the pages are stamped, because themes.js changes when they do.
// A line is one registry entry: { id: "x", ... v: "<8 hex>", jv: "<8 hex>", ... }. Entries with no layer file are left alone.
// -> the list of stale fields ({page: "themes.js", file: "look-layers/<id>.css", stamped, wanted}).
var ENTRY = /^(\s*\{ id: ")([a-z0-9-]+)(".*)$/;
function stampLookVersions(root, write) {
  var themes = path.join(root, "themes.js");
  if (!fs.existsSync(themes)) return [];
  var raw = fs.readFileSync(themes, "utf8"), crlf = raw.indexOf("\r\n") >= 0;
  var lines = raw.split("\r\n").join("\n").split("\n"), stale = [], changed = false;
  lines = lines.map(function (line) {
    var m = ENTRY.exec(line);
    if (!m) return line;
    [["v", ".css"], ["jv", ".js"]].forEach(function (f) {
      var rel = "look-layers/" + m[2] + f[1], full = path.join(root, rel);
      if (!fs.existsSync(full)) return;
      var re = new RegExp("(\\b" + f[0] + ": \")([0-9a-f]{8})(\")"), found = re.exec(line);
      if (!found) return;
      var wanted = hashOf(full);
      if (found[2] === wanted) return;
      stale.push({ page: "themes.js", file: rel, stamped: found[2], wanted: wanted });
      line = line.replace(re, function (all, a, b, c) { return a + wanted + c; });
      changed = true;
    });
    return line;
  });
  if (write && changed) fs.writeFileSync(themes, lines.join(crlf ? "\r\n" : "\n"));
  return stale;
}

// Every .html page in the folder. write=false only reports. -> {stale:[...], missing:[...], pages:n}
function run(root, write) {
  var stale = stampLookVersions(root, write), missing = [], pages = 0;
  fs.readdirSync(root).filter(function (f) { return /\.html$/.test(f); }).forEach(function (page) {
    var file = path.join(root, page);
    var original = fs.readFileSync(file, "utf8");
    var crlf = original.indexOf("\r\n") >= 0;
    var r = stampPage(original.split("\r\n").join("\n"), root, page);
    pages++;
    r.links.forEach(function (l) { if (l.stamped !== l.wanted) stale.push(l); });
    r.missing.forEach(function (m) { missing.push({ page: page, file: m }); });
    if (write && r.html !== original.split("\r\n").join("\n")) fs.writeFileSync(file, crlf ? r.html.split("\n").join("\r\n") : r.html);
  });
  return { stale: stale, missing: missing, pages: pages };
}

module.exports = { hashOf: hashOf, stampPage: stampPage, stampLookVersions: stampLookVersions, run: run, LINK: LINK };

if (require.main === module) {
  var check = process.argv.indexOf("--check") !== -1;
  var root = path.join(__dirname, "..");
  var result = run(root, !check);
  result.missing.forEach(function (m) { console.log("missing file for " + m.page + ": " + m.file); });
  if (check) {
    result.stale.forEach(function (l) { console.log(l.page + ": " + l.file + " is " + (l.stamped ? "stamped " + l.stamped : "not stamped") + ", should be " + l.wanted); });
    if (result.stale.length || result.missing.length) { console.log("Run: node tools/stamp-assets.js"); process.exit(1); }
    console.log("All " + result.pages + " pages are stamped.");
  } else {
    console.log("Stamped " + result.pages + " pages (" + result.stale.length + " links updated).");
  }
}
