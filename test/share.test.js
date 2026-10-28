// Coverage for the owner's side of shared views (share.js), how a picture is drawn (share-render.js) and the public page's
// own rules (view.js, view.html): what is sent, what is shown, and what the page is not allowed to do.
//
//   node test/share.test.js
//
// Same pattern as the other tests here: plain Node, standard library only.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var S = require(path.join(root, "share.js"));
var R = require(path.join(root, "share-render.js"));
var V = require(path.join(root, "view.js"));
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

function form(over) {
  var f = { kind: "renewals", days: 14, label: "", sections: {}, articles: [], confirmPii: false };
  S.SECTIONS.forEach(function (s) { f.sections[s.id] = s.on; });
  for (var k in over) f[k] = over[k];
  return f;
}

test("viewUrl only builds an address for a well-formed token", function () {
  var t = "sv_" + "a".repeat(32);
  assert.strictEqual(S.viewUrl(t), "https://dashboard.barnyard.site/view.html#" + t);
  ["", "sv_short", "rl_" + "a".repeat(32), null, undefined, "sv_" + "!".repeat(32)].forEach(function (bad) { assert.strictEqual(S.viewUrl(bad), "", String(bad)); });
});

test("buildBody: each kind sends only the fields it uses, 14 days by default", function () {
  assert.deepStrictEqual(S.buildBody(form(), ""), { kind: "renewals", days: 14 });
  assert.deepStrictEqual(S.buildBody(form({ label: "  For the committee  ", days: 7 }), "2026-10-28"), { kind: "renewals", days: 7, label: "For the committee", today: "2026-10-28" });
  var o = S.buildBody(form({ kind: "overview" }), "");
  assert.deepStrictEqual(o.sections, ["down", "backups", "renewals", "domains", "vulns"], "to-dos and decisions are off by default");
  var f = form({ kind: "overview" });
  f.sections.todos = true; f.sections.down = false;
  assert.deepStrictEqual(S.buildBody(f, "").sections, ["backups", "renewals", "domains", "vulns", "todos"]);
  var k = S.buildBody(form({ kind: "kb", articles: [{ id: "ka_abcd1234", title: "A" }, { id: "ka_zzzz9999", title: "B" }] }), "");
  assert.deepStrictEqual(k.ids, ["ka_abcd1234", "ka_zzzz9999"]);
  assert.strictEqual(k.sections, undefined);
  assert.strictEqual(S.buildBody(form({ confirmPii: true }), "").confirmPii, true);
  assert.strictEqual(S.buildBody(form(), "").confirmPii, undefined, "never confirmed unless the owner ticked the box");
  assert.strictEqual(S.buildBody(form({ label: "x".repeat(200) }), "").label.length, 60);
});

test("formProblem: nothing ticked or no article chosen cannot be previewed", function () {
  assert.strictEqual(S.formProblem(form()), "");
  var none = form({ kind: "overview" });
  S.SECTIONS.forEach(function (s) { none.sections[s.id] = false; });
  assert.match(S.formProblem(none), /at least one section/);
  assert.match(S.formProblem(form({ kind: "kb" })), /at least one article/);
  assert.strictEqual(S.formProblem(form({ kind: "kb", articles: [{ id: "ka_abcd1234", title: "A" }] })), "");
});

test("articleHits: only Knowledgebase articles with a well-formed address", function () {
  var hits = S.articleHits({ groups: [
    { id: "ops", items: [{ title: "An item", href: "ops.html#it_abc12345" }] },
    { id: "notebook", items: [{ title: "A note", href: "https://study.barnyard.site/notes.html#nt_abcd1234" }] },
    { id: "kb", title: "Knowledgebase", items: [
      { title: "Restore a mailbox", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_abcd1234" },
      { title: "Odd", href: "https://evil.example/knowledgebase.html#/a/ka_abcd1234" },
      { title: "", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_zzzz9999" },
      { title: "Bad id", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_../x" }] },
    { id: "kb", skipped: true, items: [{ title: "Skipped", href: "https://study.barnyard.site/knowledgebase.html#/a/ka_qqqq1111" }] }] });
  assert.deepStrictEqual(hits, [{ id: "ka_abcd1234", title: "Restore a mailbox" }]);
  assert.deepStrictEqual(S.articleHits(null), []);
});

test("piiText names what was found in plain words", function () {
  assert.strictEqual(S.piiText([]), "");
  assert.strictEqual(S.piiText(["email"]), "This contains email addresses.");
  assert.strictEqual(S.piiText(["email", "phone"]), "This contains email addresses, phone numbers.");
});

test("expiryText and viewsText say it plainly", function () {
  var now = 10 * 86400000;
  assert.strictEqual(S.expiryText({ status: "live", expiresAt: now + 5 * 86400000 - 1000 }, now), "Expires in 5 days");
  assert.strictEqual(S.expiryText({ status: "live", expiresAt: now + 3600000 }, now), "Expires tomorrow");
  assert.strictEqual(S.expiryText({ status: "expired", expiresAt: now - 3 * 86400000 }, now), "Expired 3 days ago");
  assert.strictEqual(S.expiryText({ status: "expired", expiresAt: now - 3600000 }, now), "Expired today");
  assert.strictEqual(S.expiryText({ status: "revoked", expiresAt: now + 86400000 }, now), "Switched off");
  assert.strictEqual(S.viewsText(0), "Not opened yet");
  assert.strictEqual(S.viewsText(1), "Opened once");
  assert.strictEqual(S.viewsText(7), "Opened 7 times");
});

test("errorText gives a sentence for every refusal the Worker can send, and never the raw code", function () {
  ["recent_sign_in_required", "too_many_links", "secret_detected", "pii_confirmation_needed", "article_not_found", "article_hidden", "too_large", "unauthenticated", "forbidden", "unavailable", "not_configured"].forEach(function (c) {
    assert.ok(S.errorText(c).length > 20 && S.errorText(c).indexOf("_") === -1, c);
  });
  assert.match(S.errorText("weird", 429), /too fast/);
  assert.match(S.errorText("weird", 500), /didn't work/);
});

test("the expiry choices match the Worker's: 1, 7, 14, 30 and 90 days, 14 by default", function () {
  assert.deepStrictEqual(S.DAYS.map(function (d) { return d.v; }), [1, 7, 14, 30, 90]);
  assert.strictEqual(S.DEFAULT_DAYS, 14);
  assert.strictEqual(S.MAX_ARTICLES, 10);
});

test("render helpers: dates, how soon, and sizes", function () {
  assert.strictEqual(R.isoText("2027-01-02"), "2 Jan 2027");
  assert.strictEqual(R.isoText("nope"), "");
  assert.deepStrictEqual(R.dueChip(-3), { text: "overdue by 3 days", tone: "alert" });
  assert.deepStrictEqual(R.dueChip(0), { text: "due today", tone: "alert" });
  assert.deepStrictEqual(R.dueChip(1), { text: "in 1 day", tone: "attn" });
  assert.deepStrictEqual(R.dueChip(30), { text: "in 30 days", tone: "" });
  assert.deepStrictEqual(R.dueChip(400), { text: "in 13 months", tone: "" });
  assert.deepStrictEqual(R.dueChip(null), { text: "no date", tone: "attn" });
  assert.strictEqual(R.tone("alert"), "alert");
  assert.strictEqual(R.tone("javascript:x"), "");
  assert.strictEqual(R.describe({ kind: "renewals", rows: [1, 2] }), "2 renewals");
  assert.strictEqual(R.describe({ kind: "kb", articles: [1] }), "1 article");
  assert.strictEqual(R.describe({ kind: "overview", sections: [{ items: [1, 2] }, { items: [1] }] }), "2 sections, 3 lines");
  assert.deepStrictEqual(R.paragraphs("a\n\nb\r\n\r\n  \n\nc"), ["a", "b", "c"]);
  assert.strictEqual(R.kindTitle("nope"), "Shared view");
});

test("view.js: the token comes from the address fragment only, and each failure has its own plain message", function () {
  var t = "sv_" + "A1_-".repeat(8);
  assert.strictEqual(V.tokenFromHash("#" + t), t);
  assert.strictEqual(V.tokenFromHash(t), t);
  ["", "#", "#sv_short", "#rl_" + "a".repeat(32), "#" + t + "x", null].forEach(function (bad) { assert.strictEqual(V.tokenFromHash(bad), null, String(bad)); });
  assert.match(V.gateMessage("share_expired", 410).title, /expired/);
  assert.match(V.gateMessage("share_revoked", 410).title, /switched off/);
  assert.match(V.gateMessage("not_found", 404).text, /whole address/);
  assert.match(V.gateMessage("rate_limited", 429).title, /Too many/);
  assert.match(V.gateMessage(null, 0).title, /Couldn't open/);
});

test("the public page keeps to its CSP and to its rules: no inline script or style, no cookie, no storage, no innerHTML", function () {
  var html = read("view.html");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline script");
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<meta[^>]*>/gi, "")), "no inline handler");
  assert.ok(!/\sstyle\s*=/i.test(html) && !/<style[\s>]/i.test(html), "no inline style");
  assert.ok(/connect-src https:\/\/api\.barnyard\.site;/.test(html) && /default-src 'self'/.test(html));
  assert.ok(/<meta name="referrer" content="no-referrer">/.test(html) && /noindex/.test(html));
  assert.ok(!/shell\.js|auth-gate\.js/.test(html), "none of the signed-in pages' chrome or sign-in code is on the public page");
  ["view.js", "share-render.js"].forEach(function (f) {
    var js = read(f);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), f + " builds nodes only");
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(js), f + " stores nothing in the browser");
  });
  var view = read("view.js");
  assert.ok(/credentials: "omit"/.test(view) && /referrerPolicy: "no-referrer"/.test(view), "no cookie goes with the request");
  assert.ok(/method: "POST"/.test(view) && !/\?token=|\+ token/.test(view), "the token goes in the body, never the URL");
  assert.ok(/tokenFromHash\(root\.location\.hash\)/.test(view));
});

test("the owner's tab: reaches only the share and search routes, builds nodes only, and exists only for the owner", function () {
  var js = read("share.js");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js));
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(js), "the link is never kept in the browser");
  assert.ok(/who\.owner === true/.test(js) && /who\.onChange\(register\)/.test(js), "registered only once the page knows it is the owner");
  assert.ok(/API = "https:\/\/api\.barnyard\.site\/share"/.test(js) && /HUB_API = "https:\/\/api\.barnyard\.site\/hub"/.test(js));
  assert.ok(/SEARCH_DEBOUNCE_MS = 450/.test(js), "typing in the article search waits for a pause");
  var html = read("index.html");
  assert.ok(html.indexOf("share.js") !== -1 && html.indexOf("share-render.js") !== -1 && html.indexOf("share.css") !== -1);
});

console.log("\n" + passed + " passed");
