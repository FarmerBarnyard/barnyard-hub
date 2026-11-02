// Academy invite links: the learner's page (learn.html, learn.js) and the owner's invite and learner views (academy-logic.js helpers).
// What is sent, what is shown, and what the public page is not allowed to do.
//
//   node test/academy-learn.test.js
//
// Same pattern as the other tests here: plain Node, standard library only.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var P = require(path.join(root, "learn.js"));
var L = require(path.join(root, "academy-logic.js"));
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var TOKEN = "lk_" + "a".repeat(32);

test("tokenFromHash only accepts a well-formed invite token", function () {
  assert.strictEqual(P.tokenFromHash("#" + TOKEN), TOKEN);
  assert.strictEqual(P.tokenFromHash(TOKEN), TOKEN);
  ["", "#", "#lk_short", "#sv_" + "a".repeat(32), "#rl_" + "a".repeat(32), "#" + TOKEN + "x", "#lk_" + "!".repeat(32), null, undefined].forEach(function (bad) { assert.strictEqual(P.tokenFromHash(bad), null, String(bad)); });
});

test("a dead link says why, in plain words", function () {
  assert.ok(/expired/.test(P.gateMessage("invite_expired", 410).title));
  assert.ok(/switched off/.test(P.gateMessage("invite_revoked", 410).title));
  assert.ok(/Too many/.test(P.gateMessage("rate_limited", 429).title));
  assert.ok(/doesn't work/.test(P.gateMessage("not_found", 404).title));
  assert.ok(/Not available/.test(P.gateMessage("x", 503).title));
  assert.ok(/Couldn't open/.test(P.gateMessage("network", 0).title));
});

test("every error code the Worker's public door can send has words", function () {
  ["name_required", "name_too_long", "name_invalid", "secret_detected", "invite_full", "rate_limited", "daily_limit", "nothing_to_ask", "key_invalid", "answers_invalid"].forEach(function (c) {
    assert.ok(P.errorText(c).length > 10 && !/^That did not work/.test(P.errorText(c)), c);
  });
  assert.ok(/did not work/.test(P.errorText("something_new")));
});

test("progress and completion are said plainly", function () {
  var none = { completion: { read: 0, total: 3, quizzes: 2, passed: 0, complete: false } };
  assert.strictEqual(P.progressLine(none), "0 of 3 lessons read");
  assert.strictEqual(P.progressLine({ completion: { read: 1, total: 1 } }), "1 of 1 lesson read");
  assert.strictEqual(P.progressLine({ completion: { read: 0, total: 0 } }), "No lessons yet");
  assert.strictEqual(P.completionBanner(none).text, "To finish: 3 lessons still to read and 2 quizzes still to pass.");
  var some = { completion: { read: 3, total: 3, quizzes: 2, passed: 1, complete: false } };
  assert.strictEqual(P.completionBanner(some).text, "To finish: 1 quiz still to pass.");
  var done = P.completionBanner({ completion: { read: 3, total: 3, quizzes: 2, passed: 2, complete: true, completedAt: Date.UTC(2026, 10, 2), score: 85 } });
  assert.strictEqual(done.tone, "ok");
  assert.strictEqual(done.text, "You finished this course on 2026-11-02 with a score of 85%.");
  assert.strictEqual(P.completionBanner({ completion: { read: 1, total: 1, quizzes: 0, passed: 0, complete: true, completedAt: Date.UTC(2026, 10, 2), score: null } }).text, "You finished this course on 2026-11-02.");
});

test("the marks beside a lesson show read, best score and the number of questions", function () {
  var art = { id: "al_aaaaaaaaaa", kind: "article", quiz: 3 };
  assert.deepStrictEqual(P.lessonMarks(art, null).map(function (m) { return m.text; }), ["Article", "3 questions"]);
  assert.deepStrictEqual(P.lessonMarks(art, { doneAt: 1, attempts: 2, bestPercent: 100 }).map(function (m) { return m.text + ":" + m.tone; }), ["Article:", "Read:ok", "Best 100%:ok"]);
  assert.strictEqual(P.lessonMarks(art, { attempts: 1, bestPercent: 40 })[1].tone, "attn");
  assert.deepStrictEqual(P.lessonMarks({ kind: "note", quiz: 0 }, { doneAt: 1 }).map(function (m) { return m.text; }), ["Note", "Read"]);
});

test("a graded answer says what was right, and a score says if it passed", function () {
  var q = { kind: "choice", options: ["80", "443", "22"] };
  assert.strictEqual(P.resultText(q, { right: true, correct: 1 }), "Correct");
  assert.strictEqual(P.resultText(q, { right: false, correct: 1 }), "Not quite. The answer is 443.");
  assert.strictEqual(P.resultText({ kind: "truefalse" }, { right: false, correct: false }), "Not quite. The answer is False.");
  assert.strictEqual(P.resultText({ kind: "short" }, { right: false, correct: ["mfa", "multi factor"] }), "Not quite. The answer is mfa or multi factor.");
  assert.strictEqual(P.scoreText({ right: 7, total: 10, percent: 70, passed: true }), "7 of 10 (70%): passed");
  assert.strictEqual(P.scoreText({ right: 2, total: 10, percent: 20, passed: false }), "2 of 10 (20%): keep going");
});

test("days left counts up to the day, never below zero", function () {
  var now = Date.UTC(2026, 10, 2);
  assert.strictEqual(P.daysLeft(now + 3 * 86400000, now), 3);
  assert.strictEqual(P.daysLeft(now + 3 * 86400000 - 1000, now), 3);
  assert.strictEqual(P.daysLeft(now - 1000, now), 0);
});

// ---- the owner's side -----------------------------------------------------------------------------------------------

test("learnUrl only builds an address for a well-formed token", function () {
  assert.strictEqual(L.learnUrl(TOKEN), "https://dashboard.barnyard.site/learn.html#" + TOKEN);
  ["", "lk_short", "sv_" + "a".repeat(32), null, undefined, "lk_" + "!".repeat(32)].forEach(function (bad) { assert.strictEqual(L.learnUrl(bad), "", String(bad)); });
});

test("invite lines say who joined and when the link stops", function () {
  var now = Date.UTC(2026, 10, 2);
  var live = { status: "live", learners: 3, expiresAt: now + 5 * 86400000 };
  assert.strictEqual(L.inviteLine(live, now), "3 people joined · works until 2026-11-07 (5 days left)");
  assert.strictEqual(L.inviteLine({ status: "live", learners: 1, expiresAt: now + 86400000 }, now), "1 person joined · works until 2026-11-03 (1 day left)");
  assert.strictEqual(L.inviteLine({ status: "live", learners: 0, expiresAt: now + 86400000 }, now), "nobody has joined yet · works until 2026-11-03 (1 day left)");
  assert.strictEqual(L.inviteLine({ status: "expired", learners: 2, expiresAt: now - 86400000 }, now), "2 people joined · expired 2026-11-01");
  assert.strictEqual(L.inviteLine({ status: "revoked", learners: 0, revokedAt: now }, now), "nobody has joined yet · switched off 2026-11-02");
  assert.strictEqual(L.inviteTone(live), "ok");
  assert.strictEqual(L.inviteTone({ status: "revoked" }), "attn");
  assert.deepStrictEqual(L.INVITE_DAYS.map(function (d) { return d.days; }), [7, 30, 90, 180]);
  assert.strictEqual(L.INVITE_DEFAULT_DAYS, 30);
});

test("a learner's row says how far they are", function () {
  var done = L.learnerStatus({ complete: true, completedAt: Date.UTC(2026, 10, 2), score: 90, read: 2, total: 2, quizzes: 1, passed: 1 });
  assert.deepStrictEqual(done, { tone: "ok", text: "Finished 2026-11-02 · 90%" });
  assert.strictEqual(L.learnerStatus({ complete: true, completedAt: Date.UTC(2026, 10, 2), score: null, read: 1, total: 1, quizzes: 0, passed: 0 }).text, "Finished 2026-11-02");
  assert.deepStrictEqual(L.learnerStatus({ complete: false, read: 1, total: 3, quizzes: 2, passed: 0 }), { tone: "attn", text: "1 of 3 lessons read · 0 of 2 quizzes passed" });
  assert.deepStrictEqual(L.learnerStatus({ complete: false, read: 0, total: 3, quizzes: 0, passed: 0 }), { tone: "", text: "0 of 3 lessons read" });
});

test("the tile adds a line about learners only when there are some", function () {
  assert.strictEqual(L.learnersLine({ learners: 0 }), "");
  assert.strictEqual(L.learnersLine({}), "");
  assert.strictEqual(L.learnersLine(null), "");
  assert.strictEqual(L.learnersLine({ learners: 3, completions: 1 }), "3 learners, 1 finished");
  assert.strictEqual(L.learnersLine({ learners: 1 }), "1 learner, 0 finished");
  // the existing lines are unchanged
  assert.strictEqual(L.tileSummary({ ok: true, courses: 1, lessons: 2, lessonsDone: 2, learners: 5 }).text, "Every lesson is done.");
});

test("the learners screen has its own address, and every new error has words", function () {
  assert.deepStrictEqual(L.routeFromHash("#/learners"), { view: "learners", id: "" });
  assert.deepStrictEqual(L.routeFromHash("#/records"), { view: "records", id: "" });
  ["invites_disabled", "invites_full", "course_invites_full", "days_invalid", "label_too_long", "recent_sign_in_required"].forEach(function (c) {
    assert.ok(!/^That did not work/.test(L.errorText(c)), c);
  });
});

// ---- the public page's own rules ------------------------------------------------------------------------------------

test("the invite page stays inside its Content-Security-Policy and asks for no login", function () {
  var html = read("learn.html");
  var csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.ok(/default-src 'self'/.test(csp) && /connect-src https:\/\/api\.barnyard\.site/.test(csp) && /script-src 'self'/.test(csp) && /style-src 'self'/.test(csp));
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), csp);
  assert.ok(/<meta name="referrer" content="no-referrer">/.test(html));
  assert.ok(/noindex/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script");
  assert.ok(!/\sstyle=/.test(html) && !/\son[a-z]+=/i.test(html), "no inline style or handler");
  assert.ok(!/auth-gate|shell\.js/.test(html), "no sign-in gate and no shell: the page is for people with no account");
  assert.ok(fs.existsSync(path.join(root, "learn.css")));
});

test("the page posts the token in the body with no cookie, and never puts it in a URL", function () {
  var js = read("learn.js");
  assert.ok(/credentials:\s*"omit"/.test(js));
  assert.ok(/referrerPolicy:\s*"no-referrer"/.test(js));
  assert.ok(/method:\s*"POST"/.test(js));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), "server text only reaches the page as text or DOM nodes");
  assert.ok(!/location\.(search|href)\s*=/.test(js) && !/\?token=|&token=/.test(js));
  assert.ok(/https:\/\/api\.barnyard\.site\/academy\/learn\//.test(js));
  assert.ok(!/withCredentials|credentials:\s*"include"/.test(js));
});

test("the learner key is kept only in this browser, and the page works without storage", function () {
  var js = read("learn.js");
  assert.ok(/localStorage/.test(js) && !/sessionStorage|document\.cookie|indexedDB/.test(js));
  assert.ok(/try\s*\{[^}]*localStorage\.getItem/.test(js) && /try\s*\{[^}]*localStorage\.setItem/.test(js), "every storage call is guarded");
});

test("the owner's page offers the link, copy and switch-off, and the new files are linked and stamped", function () {
  var js = read("academy.js");
  assert.ok(/"\/invites"/.test(js) && /\/revoke/.test(js) && /"\/learners/.test(js));
  assert.ok(/learnUrl/.test(js) && /Copy link/.test(js));
  assert.ok(!/innerHTML/.test(js));
  var html = read("learn.html");
  assert.ok(/src="learn\.js\?v=[0-9a-f]{8}"/.test(html) && /href="learn\.css\?v=[0-9a-f]{8}"/.test(html), "run tools/stamp-assets.js after changing learn.js or learn.css");
});

console.log("\n" + passed + " passed");
