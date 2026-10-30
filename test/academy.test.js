// The Academy page: the words and rules in academy-logic.js, the tile, the page's structure (no inline script or style, no innerHTML,
// the rules and the Markdown renderer loaded before the page) and the sidebar entry.
//
//   node test/academy.test.js
//
// Plain Node, standard library only.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var L = require(path.join(root, "academy-logic.js"));

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }
var read = function (f) { return fs.readFileSync(path.join(root, f), "utf8"); };

var DAY = 86400000;

test("an article id is found in a pasted link or on its own, and nothing else counts", function () {
  assert.strictEqual(L.articleIdFrom("ka_abcd2345"), "ka_abcd2345");
  assert.strictEqual(L.articleIdFrom("https://study.barnyard.site/knowledgebase.html#/a/ka_abcd2345"), "ka_abcd2345");
  assert.strictEqual(L.articleIdFrom("  KA_ABCD2345 "), "ka_abcd2345");
  assert.strictEqual(L.articleIdFrom("see ka_abcd2345, thanks"), "ka_abcd2345");
  assert.strictEqual(L.articleIdFrom("ka_abcd234"), null);
  assert.strictEqual(L.articleIdFrom("ka_abcd23456"), null);
  assert.strictEqual(L.articleIdFrom("xka_abcd2345"), null);
  assert.strictEqual(L.articleIdFrom(""), null);
  assert.strictEqual(L.articleIdFrom(null), null);
});

test("the address bar chooses the screen", function () {
  assert.deepStrictEqual(L.routeFromHash(""), { view: "home", id: "" });
  assert.deepStrictEqual(L.routeFromHash("#/"), { view: "home", id: "" });
  assert.deepStrictEqual(L.routeFromHash("#/c/ac_abcdefghjk"), { view: "course", id: "ac_abcdefghjk" });
  assert.deepStrictEqual(L.routeFromHash("#/l/al_abcdefghjk"), { view: "lesson", id: "al_abcdefghjk" });
  assert.deepStrictEqual(L.routeFromHash("#/review"), { view: "review", id: "" });
  assert.deepStrictEqual(L.routeFromHash("#/records"), { view: "records", id: "" });
  assert.deepStrictEqual(L.routeFromHash("#/c/not-an-id"), { view: "home", id: "" });
  assert.deepStrictEqual(L.routeFromHash("#/l/ac_abcdefghjk"), { view: "home", id: "" });
});

test("a multiple choice question is built from the form, and each mistake is named", function () {
  var ok = L.questionBody({ kind: "choice", prompt: " Which  port is HTTPS? ", optionsText: "80\n443\n\n22\n", answerIndex: 1, explanation: "It is 443." });
  assert.deepStrictEqual(ok.body, { kind: "choice", prompt: "Which port is HTTPS?", explanation: "It is 443.", options: ["80", "443", "22"], answer: 1 });
  assert.strictEqual(L.questionBody({ kind: "choice", prompt: "", optionsText: "a\nb", answerIndex: 0 }).error, "prompt_required");
  assert.strictEqual(L.questionBody({ kind: "choice", prompt: "p", optionsText: "a", answerIndex: 0 }).error, "options_count_invalid");
  assert.strictEqual(L.questionBody({ kind: "choice", prompt: "p", optionsText: "1\n2\n3\n4\n5\n6\n7", answerIndex: 0 }).error, "options_count_invalid");
  assert.strictEqual(L.questionBody({ kind: "choice", prompt: "p", optionsText: "a\nA", answerIndex: 0 }).error, "options_not_distinct");
  assert.strictEqual(L.questionBody({ kind: "choice", prompt: "p", optionsText: "a\nb", answerIndex: 2 }).error, "answer_invalid");
  assert.strictEqual(L.questionBody({ kind: "choice", prompt: "p", optionsText: "a\nb", answerIndex: "x" }).error, "answer_invalid");
});

test("true or false and short answer questions", function () {
  assert.deepStrictEqual(L.questionBody({ kind: "truefalse", prompt: "p", truth: false }).body, { kind: "truefalse", prompt: "p", answer: false });
  assert.strictEqual(L.questionBody({ kind: "truefalse", prompt: "p", truth: "maybe" }).error, "answer_invalid");
  assert.deepStrictEqual(L.questionBody({ kind: "short", prompt: "p", answersText: "MFA\nmulti-factor authentication\n" }).body.answers, ["MFA", "multi-factor authentication"]);
  assert.strictEqual(L.questionBody({ kind: "short", prompt: "p", answersText: "  \n" }).error, "answers_invalid");
  assert.strictEqual(L.questionBody({ kind: "short", prompt: "p", answersText: "1\n2\n3\n4\n5\n6" }).error, "answers_invalid");
  assert.strictEqual(L.questionBody({ kind: "essay", prompt: "p" }).error, "answer_invalid");
});

test("editing a question starts from what it already says", function () {
  var f = L.formFromQuestion({ kind: "choice", prompt: "p", explanation: "e", options: ["a", "b"], answer: 1, answers: [] });
  assert.deepStrictEqual([f.kind, f.optionsText, f.answerIndex, f.explanation], ["choice", "a\nb", 1, "e"]);
  var back = L.questionBody(f).body;
  assert.deepStrictEqual([back.options, back.answer], [["a", "b"], 1]);
  var tf = L.formFromQuestion({ kind: "truefalse", prompt: "p", answer: false, options: [], answers: [] });
  assert.strictEqual(tf.truth, false);
  var sh = L.formFromQuestion({ kind: "short", prompt: "p", answer: null, options: [], answers: ["x", "y"] });
  assert.strictEqual(sh.answersText, "x\ny");
});

test("a graded answer says what was right in words", function () {
  var choice = { kind: "choice", options: ["80", "443", "22"] };
  assert.strictEqual(L.resultText(choice, { right: true }), "Correct");
  assert.strictEqual(L.resultText(choice, { right: false, correct: 1 }), "Not quite. The answer is 443.");
  assert.strictEqual(L.resultText({ kind: "truefalse" }, { right: false, correct: true }), "Not quite. The answer is True.");
  assert.strictEqual(L.resultText({ kind: "truefalse" }, { right: false, correct: false }), "Not quite. The answer is False.");
  assert.strictEqual(L.resultText({ kind: "short" }, { right: false, correct: ["MFA", "multi-factor"] }), "Not quite. The answer is MFA or multi-factor.");
});

test("scores, progress and quiz lines read plainly", function () {
  assert.strictEqual(L.scoreText(7, 10), "7 of 10 (70%)");
  assert.strictEqual(L.scoreText(0, 0), "0 of 0");
  assert.strictEqual(L.courseLine({ progress: { total: 0, done: 0 } }), "No lessons yet");
  assert.strictEqual(L.courseLine({ progress: { total: 1, done: 0 } }), "0 of 1 lesson done");
  assert.strictEqual(L.courseLine({ progress: { total: 5, done: 3 } }), "3 of 5 lessons done");
  assert.strictEqual(L.quizLine({ approved: 0, attempts: 0, drafts: 0 }), "No quiz yet");
  assert.strictEqual(L.quizLine({ approved: 5, attempts: 2, bestPercent: 80, drafts: 1 }), "5 questions · 1 draft to check");   // the best score is its own chip beside it
  assert.strictEqual(L.quizLine({ approved: 1, attempts: 0, drafts: 0 }), "1 question");
  var now = Date.UTC(2026, 9, 30);
  assert.strictEqual(L.agoText(now - 2 * 3600000, now), "today");
  assert.strictEqual(L.agoText(now - DAY - 1, now), "yesterday");
  assert.strictEqual(L.agoText(now - 5 * DAY, now), "5 days ago");
  assert.strictEqual(L.agoText(0, now), "");
});

test("errors from the Worker are put in plain words, and an unknown one still says something", function () {
  assert.ok(/most courses/.test(L.errorText("courses_full")));
  assert.ok(/recent sign-in/.test(L.errorText("recent_sign_in_required")));
  assert.ok(/published Knowledgebase articles/.test(L.errorText("article_not_found")));
  assert.ok(/key or password/.test(L.errorText("secret_detected")));
  assert.strictEqual(L.errorText("something_new"), "That did not work. Try again.");
  assert.strictEqual(L.errorText(undefined), "That did not work. Try again.");
});

test("the tile's line says the next useful thing", function () {
  assert.strictEqual(L.tileSummary(null).tone, "");
  assert.ok(/No courses yet/.test(L.tileSummary({ ok: true, courses: 0 }).text));
  assert.deepStrictEqual(L.tileSummary({ courses: 2, due: 3 }), { tone: "attn", text: "3 questions due for review." });
  assert.deepStrictEqual(L.tileSummary({ courses: 2, due: 1 }), { tone: "attn", text: "1 question due for review." });
  assert.deepStrictEqual(L.tileSummary({ courses: 2, due: 0, drafts: 2 }), { tone: "attn", text: "2 drafted questions to check." });
  assert.deepStrictEqual(L.tileSummary({ courses: 1, due: 0, drafts: 0, lessons: 4, lessonsDone: 4 }), { tone: "ok", text: "Every lesson is done." });
  assert.deepStrictEqual(L.tileSummary({ courses: 1, due: 0, drafts: 0, lessons: 4, lessonsDone: 1 }), { tone: "", text: "3 lessons to go." });
});

test("the tile is owner only, has its own permission and is on the Overview", function () {
  var Tile = require(path.join(root, "tile-academy.js"));
  assert.deepStrictEqual([Tile.descriptor.id, Tile.descriptor.permission, Tile.descriptor.ownerOnly], ["academy", "tile.academy", true]);
  assert.strictEqual(Tile.summaryLine, L.tileSummary);
  var index = read("index.html");
  assert.ok(/src="academy-logic\.js(\?v=[0-9a-f]+)?"/.test(index) && /src="tile-academy\.js(\?v=[0-9a-f]+)?"/.test(index));
  assert.ok(index.indexOf("academy-logic.js") < index.indexOf("tile-academy.js"), "the rules load before the tile");
});

test("the page has no inline script or style, no innerHTML, and loads the rules and the renderer first", function () {
  var html = read("academy.html");
  assert.ok(/data-shell="academy"/.test(html));
  assert.ok(/<main id="page" class="content">/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline script");
  assert.ok(!/\sstyle=/.test(html) && !/<style/.test(html), "no inline style");
  assert.ok(!/\son[a-z]+=/.test(html), "no inline handlers");
  assert.ok(/Content-Security-Policy" content="default-src 'self'; connect-src 'self' https:\/\/api\.barnyard\.site;/.test(html));
  var at = function (n) { return html.search(new RegExp('src="' + n + '(\\?v=[0-9a-f]+)?"')); };
  assert.ok(at("markdown.js") > 0 && at("markdown.js") < at("academy-logic.js") && at("academy-logic.js") < at("academy.js"), "renderer, rules, then the page");
  var js = read("academy.js");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), "nothing from the server becomes markup");
  assert.ok(!/localStorage|sessionStorage/.test(js), "nothing is kept in this browser");
  assert.ok(/credentials: "include"/.test(js));
});

test("a quiz is graded by the Worker and the page never holds the answers before then", function () {
  var js = read("academy.js");
  assert.ok(/\/quiz\/grade/.test(js) && /\/review\/grade/.test(js));
  // the questions the page draws come from /quiz and /review, which carry no answers; the grade call is the only source of what was right
  assert.ok(/res\.results\.forEach/.test(js));
});

test("the sidebar has an Academy entry that is owner only, with its own permission and icon", function () {
  var shell = read("shell.js");
  var m = /\{ id: "academy"[^}]*\}/.exec(shell);
  assert.ok(m, "the entry exists");
  assert.ok(/ownerOnly: true/.test(m[0]) && /perm: "academy\.view"/.test(m[0]) && /path: "academy\.html"/.test(m[0]) && /group: "Work"/.test(m[0]));
  assert.ok(/icon: "academy"/.test(m[0]) && /\n\s+academy: '<path/.test(shell), "its icon is defined");
  assert.ok(/academy\\\.html\$\/\.test\(location\.pathname\)\) return "academy"/.test(shell), "the page lights its own entry");
  assert.ok(shell.indexOf('id: "release"') < shell.indexOf('id: "academy"') && shell.indexOf('id: "academy"') < shell.indexOf('id: "users"'), "between Release board and Users");
});

console.log("\n" + passed + " passed");
