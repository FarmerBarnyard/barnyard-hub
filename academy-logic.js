// The Academy page's words and rules, with no DOM and no network (academy.js and tile-academy.js use them; test/academy.test.js covers them).
//
// The Worker (ClaudeRepo's cloudflare-worker/src/academy-routes.js, owner only) holds courses, lessons, questions and the review ladder.
// This file turns its answers into plain words and checks what a person typed before it is sent.
//
// Browser: window.BarnyardAcademyLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var DAY = 86400000;
  var KIND_LABELS = { choice: "Multiple choice", truefalse: "True or false", short: "Short answer" };
  var ERRORS = {
    unauthenticated: "Sign in to see this page.",
    forbidden: "This page is only for the hub owner.",
    academy_disabled: "The Academy is switched off (the Worker variable ACADEMY_ENABLED is 0).",
    recent_sign_in_required: "Sign in again, then repeat that. Deleting needs a recent sign-in.",
    rate_limited: "That was too quick. Try again in a moment.",
    secret_detected: "That looks like it contains a key or password. Take it out and try again.",
    courses_full: "That is the most courses there can be (20). Delete one first.",
    lessons_full: "That course is full (30 lessons).",
    questions_full: "That lesson has the most questions it can hold (20).",
    questions_total_full: "There are too many questions in all (400). Delete some first.",
    already_in_course: "That article is already a lesson in this course.",
    article_not_found: "That article could not be found, or it is hidden. Only published Knowledgebase articles can be lessons.",
    kb_unavailable: "The Knowledgebase could not be reached. Try again in a minute.",
    nothing_to_ask: "There are no approved questions here yet.",
    title_required: "Give it a title.", title_too_long: "That title is too long.", note_required: "Write the lesson text.", note_too_long: "That note is too long (4,000 characters).",
    prompt_required: "Write the question.", prompt_too_long: "The question is too long (300 characters).",
    options_count_invalid: "A multiple choice question needs 2 to 6 options.", options_not_distinct: "Each option has to be different.", options_invalid: "Fill in every option.",
    options_too_long: "An option is too long (120 characters).", answer_invalid: "Choose the right answer.", answers_invalid: "Give at least one accepted answer (up to 5).",
    answers_too_long: "An accepted answer is too long (80 characters).", explanation_too_long: "The explanation is too long (300 characters).",
    summary_too_long: "The summary is too long (300 characters).", articleId_invalid: "That does not look like a Knowledgebase link or article id.",
    order_invalid: "The order could not be saved. Reload and try again.", not_found: "That is not there any more. Reload the page."
  };
  var errorText = function (code) { return ERRORS[code] || "That did not work. Try again."; };

  // A Knowledgebase article id from what was pasted: the id itself, or a link ending #/a/ka_xxxxxxxx. null when there is none.
  function articleIdFrom(text) {
    var m = /(?:^|[^a-z0-9_])(ka_[a-z0-9]{8})(?![a-z0-9_])/.exec(String(text || "").toLowerCase());
    return m ? m[1] : null;
  }

  // Which screen a location hash means: #/c/<course>, #/l/<lesson>, #/review, #/records, else home.
  function routeFromHash(hash) {
    var h = String(hash || "").replace(/^#\/?/, "");
    var m = /^c\/(ac_[a-z0-9]{10})$/.exec(h);
    if (m) return { view: "course", id: m[1] };
    m = /^l\/(al_[a-z0-9]{10})$/.exec(h);
    if (m) return { view: "lesson", id: m[1] };
    if (h === "review") return { view: "review", id: "" };
    if (h === "records") return { view: "records", id: "" };
    return { view: "home", id: "" };
  }

  var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); };

  function agoText(ts, now) {
    if (!ts) return "";
    var d = Math.floor(((now || Date.now()) - ts) / DAY);
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    if (d < 30) return d + " days ago";
    return new Date(ts).toISOString().slice(0, 10);
  }
  function dateText(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : ""; }

  // The score as the page shows it: "7 of 10 (70%)".
  function scoreText(right, total) { return right + " of " + total + (total ? " (" + Math.round((right / total) * 100) + "%)" : ""); }

  // One line under a course's name: "3 of 5 lessons done".
  function courseLine(course) {
    var p = course && course.progress ? course.progress : { total: 0, done: 0 };
    if (!p.total) return "No lessons yet";
    return p.done + " of " + plural(p.total, "lesson") + " done";
  }

  // What a lesson row says about its quiz.
  function quizLine(lesson) {
    var parts = [];
    if (lesson.approved) parts.push(plural(lesson.approved, "question"));
    else parts.push("No quiz yet");
    if (lesson.drafts) parts.push(plural(lesson.drafts, "draft") + " to check");
    return parts.join(" · ");
  }

  // The tile's line and tone from GET /academy/summary.
  function tileSummary(sum) {
    if (!sum || sum.ok === false) return { tone: "", text: "The Academy could not be read." };
    if (!sum.courses) return { tone: "", text: "No courses yet. Make one from a Knowledgebase article." };
    if (sum.due) return { tone: "attn", text: plural(sum.due, "question") + " due for review." };
    if (sum.drafts) return { tone: "attn", text: plural(sum.drafts, "drafted question") + " to check." };
    var left = Math.max(0, (sum.lessons || 0) - (sum.lessonsDone || 0));
    if (!left) return { tone: "ok", text: "Every lesson is done." };
    return { tone: "", text: plural(left, "lesson") + " to go." };
  }

  // ---- questions typed into the form ---------------------------------------------------------------------------------------------

  var lines = function (text) { return String(text || "").split(/\r?\n/).map(function (s) { return s.replace(/\s+/g, " ").trim(); }).filter(Boolean); };

  // form: { kind, prompt, explanation, optionsText, answerIndex, truth, answersText } -> { body } | { error: "<code>" }. The Worker checks all
  // of it again; this only spares a round trip and says what is wrong in plain words.
  function questionBody(form) {
    var prompt = String(form.prompt || "").replace(/\s+/g, " ").trim();
    if (!prompt) return { error: "prompt_required" };
    var body = { kind: form.kind, prompt: prompt };
    var expl = String(form.explanation || "").replace(/\s+/g, " ").trim();
    if (expl) body.explanation = expl;
    if (form.kind === "choice") {
      var opts = lines(form.optionsText);
      if (opts.length < 2 || opts.length > 6) return { error: "options_count_invalid" };
      var folded = opts.map(function (o) { return o.toLowerCase(); });
      if (folded.some(function (o, i) { return folded.indexOf(o) !== i; })) return { error: "options_not_distinct" };
      var idx = parseInt(form.answerIndex, 10);
      if (!(idx >= 0 && idx < opts.length)) return { error: "answer_invalid" };
      body.options = opts; body.answer = idx;
    } else if (form.kind === "truefalse") {
      if (form.truth !== true && form.truth !== false) return { error: "answer_invalid" };
      body.answer = form.truth;
    } else if (form.kind === "short") {
      var answers = lines(form.answersText);
      if (!answers.length || answers.length > 5) return { error: "answers_invalid" };
      body.answers = answers;
    } else {
      return { error: "answer_invalid" };
    }
    return { body: body };
  }

  // The values a question's edit form starts with.
  function formFromQuestion(q) {
    return {
      kind: q.kind, prompt: q.prompt, explanation: q.explanation || "", optionsText: (q.options || []).join("\n"),
      answerIndex: q.kind === "choice" ? q.answer : 0, truth: q.kind === "truefalse" ? q.answer : true, answersText: (q.answers || []).join("\n")
    };
  }

  // How a graded answer is shown: "Correct", or "Not quite: the answer is 443".
  function resultText(q, result) {
    if (result.right) return "Correct";
    var c = result.correct;
    var answer = Array.isArray(c) ? c.join(" or ") : q.kind === "choice" ? (q.options || [])[c] : c ? "True" : "False";
    return "Not quite. The answer is " + answer + ".";
  }

  var api = {
    KIND_LABELS: KIND_LABELS, ERRORS: ERRORS, errorText: errorText, articleIdFrom: articleIdFrom, routeFromHash: routeFromHash, plural: plural, agoText: agoText,
    dateText: dateText, scoreText: scoreText, courseLine: courseLine, quizLine: quizLine, tileSummary: tileSummary, questionBody: questionBody,
    formFromQuestion: formFromQuestion, resultText: resultText
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardAcademyLogic = api;
})(typeof window !== "undefined" ? window : this);
