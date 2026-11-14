// Links and references that come from the Worker (an asset's admin page, a change-log reference, a renewal's portal address) may only
// ever become a link on a page if they are https or an in-hub path, and a reference is text. This covers the checks that guard every
// place those values turn into an href (map panel, Calendar renewal drawer, the change-log form) and that no page builds one with innerHTML.
//
//   node test/link-safety.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var K = require(path.join(root, "tile-kit.js"));
var M = require(path.join(root, "map-logic.js"));
var Cal = require(path.join(root, "calendar-logic.js"));
var Activity = require(path.join(root, "tile-activity.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
function read(f) { return fs.readFileSync(path.join(root, f), "utf8"); }

// The exploit from Security Review 103 N4 and the variants a caller might try.
var HOSTILE = [
  "javascript:alert(document.cookie)", "JavaScript:alert(1)", "  javascript:alert(1)", "\tjavascript:alert(1)", "java\tscript:alert(1)",
  "java\nscript:alert(1)", "java\u0000script:alert(1)", "\u0001javascript:alert(1)", "javascript&colon;alert(1)", "javascript&#58;alert(1)",
  "&#106;avascript:alert(1)", "javascript%3Aalert(1)", "javascript\uFF1Aalert(1)", "javascript :alert(1)",
  "data:text/html,<script>alert(1)</script>", "DATA:text/html,x", "vbscript:msgbox(1)", "file:///C:/Windows/win.ini", "blob:https://example.com/a",
  "about:blank", "http://example.com/a", "HTTPS://example.com/a", "//evil.example.com/x", "/\\evil.example.com", "\\\\evil.example.com\\share",
  "https://", "https://a b.example.com", "https://example.com/\u0000", "https://example.com/a\nb", "https://example.com/a\u007fb",
  "https://example.com/a\u0085b", "https://example.com/\"onmouseover=alert(1)", "https://example.com/<script>", "https://example.com/a\\b",
  "<script>alert(1)</script>", "PR: 444", "mailto:a@example.com"
];

test("linkKind: https is web, a slash path is hub, a short plain label is a reference, everything else is nothing", function () {
  assert.strictEqual(K.linkKind("https://github.com/FarmerBarnyard/ClaudeRepo/pull/444"), "web");
  assert.strictEqual(K.linkKind("  https://example.com/a  "), "web");
  assert.strictEqual(K.linkKind("/ops.html#it_abc12345"), "hub");
  assert.strictEqual(K.linkKind("PR 444"), "ref");
  assert.strictEqual(K.linkKind("it_abc12345"), "ref");
  assert.strictEqual(K.linkKind("ops.html#it_abc12345"), "ref");
  assert.strictEqual(K.linkKind(""), "");
  assert.strictEqual(K.linkKind(null), "");
  assert.strictEqual(K.linkKind(7), "");
  assert.strictEqual(K.linkKind(new Array(62).join("a")), "", "a reference is short");
  HOSTILE.forEach(function (v) { assert.strictEqual(K.linkKind(v), "", JSON.stringify(v)); });
});

test("linkHref: only a web link or a hub path may go into an href; a reference is text", function () {
  assert.strictEqual(K.linkHref("https://example.com/a"), "https://example.com/a");
  assert.strictEqual(K.linkHref("/calendar.html"), "/calendar.html");
  assert.strictEqual(K.linkHref("PR 444"), "");
  assert.strictEqual(K.linkHref("it_abc12345"), "");
  HOSTILE.forEach(function (v) { assert.strictEqual(K.linkHref(v), "", JSON.stringify(v)); });
});

test("safeWebLink (map panel and Calendar drawer): https only, trimmed, nothing that could be a script", function () {
  [M, Cal].forEach(function (X) {
    assert.strictEqual(X.safeWebLink("https://admin.example.com/login"), "https://admin.example.com/login");
    assert.strictEqual(X.safeWebLink(" https://admin.example.com/login "), "https://admin.example.com/login");
    assert.strictEqual(X.safeWebLink("PR 444"), "");
    assert.strictEqual(X.safeWebLink("/ops.html"), "");
    assert.strictEqual(X.safeWebLink(undefined), "");
    assert.strictEqual(X.safeWebLink({}), "");
    HOSTILE.forEach(function (v) { assert.strictEqual(X.safeWebLink(v), "", JSON.stringify(v)); });
  });
});

test("the change-log form refuses a script address before it is sent, and still takes a reference or an https link", function () {
  var f = function (link) { return Activity.changeToBody({ what: "x", where: "", why: "", undo: "y", link: link }); };
  HOSTILE.forEach(function (v) { if (v.trim()) assert.strictEqual(f(v).field, "link", JSON.stringify(v)); });
  assert.strictEqual(f("javascript:alert(document.cookie)").field, "link");
  assert.ok(f("PR 444").body);
  assert.ok(f("it_abc12345").body);
  assert.ok(f("https://github.com/FarmerBarnyard/ClaudeRepo/pull/444").body);
  assert.ok(f("/ops.html#it_abc12345").body);
  assert.ok(f("").body, "the link is optional");
});

test("the Calendar renewal form takes only a plain https portal link", function () {
  var form = function (link) { return { title: "Domain", due: "2027-01-01", state: "known", kind: "domain", link: link, where: "", breaks: "", renewed: "", leadDays: "" }; };
  var body = function (link) { return Cal.renewalBody(form(link), "", true); };
  assert.ok(!body("https://registrar.example.com/login").error);
  HOSTILE.forEach(function (v) { if (v.trim()) assert.strictEqual(body(v).field, "link", JSON.stringify(v)); });
});

test("the places a Worker link becomes a link go through the check, with noopener noreferrer, and nothing uses innerHTML", function () {
  var map = read("map.js");
  assert.ok(/if \(M\.safeWebLink\(n\.link\)\)/.test(map), "map panel checks the admin link");
  assert.ok(/a\.href = M\.safeWebLink\(n\.link\); a\.target = "_blank"; a\.rel = "noopener noreferrer"/.test(map), "and links the checked value");
  assert.ok(!/a\.href = n\.link/.test(map));
  var cal = read("calendar.js");
  assert.ok(/fact\(body, "Portal", L\.safeWebLink\(r\.link\), L\.safeWebLink\(r\.link\)\)/.test(cal), "Calendar portal address is checked");
  assert.ok(!/fact\(body, "Portal", r\.link/.test(cal));
  assert.ok(/a\.target = "_blank"; a\.rel = "noopener noreferrer"; d\.appendChild\(a\)/.test(cal), "the Calendar's outside link has rel noopener noreferrer");
  // every window opened in a new tab by these files carries rel noopener noreferrer
  ["map.js", "calendar.js", "tile-activity.js", "tile-assets.js", "tile-backups.js"].forEach(function (f) {
    var src = read(f);
    (src.match(/\.target = "_blank"/g) || []).forEach(function () { /* counted below */ });
    assert.strictEqual((src.match(/\.target = "_blank"/g) || []).length, (src.match(/\.rel = "noopener noreferrer"/g) || []).length, f + ": each _blank link has rel noopener noreferrer");
    assert.ok(!/\.(innerHTML|outerHTML)\s*=\s*[^"'\s]/.test(src) && !/insertAdjacentHTML|document\.write/.test(src), f + ": no HTML built from data");
  });
  // the change log never puts an entry's link in an href
  assert.ok(!/c\.link/.test(read("tile-activity.js")), "the change-log list does not render a link at all");
});

console.log(passed + " passed");
