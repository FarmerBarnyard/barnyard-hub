// An Academy invite page (learn.html): one course, opened from a link the hub owner sent. There is NO login here on purpose --
// the link (learn.html#lk_...) is the credential, so the token lives in the address fragment (never sent to a server by the
// browser, never in a referrer) and is posted in the body to api.barnyard.site/academy/learn/*. No cookie goes with any request.
//
// A learner gives a display name and is handed a private key, which this browser keeps (localStorage, under the invite) so the
// progress is still there tomorrow. Only a hash of the key is stored on the server. The page asks for one course and nothing else.
//
// Everything from the server reaches the page through textContent or markdown.js (DOM nodes only); the page's CSP has no
// 'unsafe-inline'. A quiz never has its answers until it is graded: the Worker grades and sends back what was right.
//
// Plain script, no build step. Under Node only the pure helpers are exported (for test/academy-learn.test.js).
(function (root) {
  "use strict";

  var API = "https://api.barnyard.site/academy/learn/";
  var TOKEN = /^lk_[A-Za-z0-9_-]{32}$/;
  var KEY = /^lr_[A-Za-z0-9_-]{32}$/;
  var DAY = 86400000;

  // ---- 1. pure helpers -----------------------------------------------------

  // "#lk_xxxxx" -> the token, or null.
  function tokenFromHash(hash) {
    var s = String(hash || "").replace(/^#/, "");
    return TOKEN.test(s) ? s : null;
  }

  // What to tell someone whose link does not open: { title, text }.
  function gateMessage(code, status) {
    if (code === "invite_expired") return { title: "This invitation has expired", text: "Ask the person who sent it for a new one. Your progress is kept." };
    if (code === "invite_revoked") return { title: "This invitation has been switched off", text: "The person who sent it turned it off. Ask them for a new one if you still need it." };
    if (status === 429 || code === "rate_limited") return { title: "Too many tries", text: "Wait a minute, then reload this page." };
    if (code === "not_found" || status === 404) return { title: "This link doesn't work", text: "It may be incomplete: check that the whole address was copied, including the part after the #. It may also not be switched on yet." };
    if (status === 503 || status === 500) return { title: "Not available right now", text: "Try again in a few minutes." };
    return { title: "Couldn't open this link", text: "Check your connection and reload the page." };
  }

  var ERRORS = {
    name_required: "Type your name first.", name_too_long: "That name is too long (40 characters).",
    name_invalid: "Use just your name: no email address, link or symbols.",
    secret_detected: "That looks like a password or key. Type only your name.",
    invite_full: "This invitation already has all the people it can hold. Ask the person who sent it.",
    learners_full: "The Academy cannot take more people right now. Ask the person who sent the link.",
    rate_limited: "That was too quick. Try again in a moment.",
    daily_limit: "That is today's limit of quizzes. Come back tomorrow.",
    nothing_to_ask: "There are no questions here yet.",
    key_invalid: "This browser is not signed up to this course any more. Enter your name to join again.",
    answers_invalid: "Those answers could not be checked. Reload the page and try again.",
    kb_unavailable: "The lesson could not be read just now. Try again in a minute."
  };
  function errorText(code) { return ERRORS[code] || "That did not work. Try again."; }

  var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); };
  function dateText(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : ""; }
  function daysLeft(expiresAt, now) { return Math.max(0, Math.ceil((expiresAt - (now || Date.now())) / DAY)); }

  // One line about how far along a learner is: "1 of 3 lessons read". `progress` is the Worker's.
  function progressLine(progress) {
    var c = progress && progress.completion ? progress.completion : { read: 0, total: 0 };
    if (!c.total) return "No lessons yet";
    return c.read + " of " + plural(c.total, "lesson") + " read";
  }

  // The banner that says whether the course is finished: { tone, text }.
  function completionBanner(progress) {
    var c = progress && progress.completion;
    if (!c) return { tone: "", text: "" };
    if (c.complete) return { tone: "ok", text: "You finished this course on " + dateText(c.completedAt) + (c.score !== null && c.score !== undefined ? " with a score of " + c.score + "%" : "") + "." };
    var left = [];
    if (c.total - c.read > 0) left.push(plural(c.total - c.read, "lesson") + " still to read");
    if (c.quizzes - c.passed > 0) left.push(plural(c.quizzes - c.passed, "quiz", "quizzes") + " still to pass");
    return { tone: "", text: left.length ? "To finish: " + left.join(" and ") + "." : "" };
  }

  // The marks beside a lesson: [{ text, tone }].
  function lessonMarks(lesson, mine) {
    var marks = [{ text: lesson.kind === "article" ? "Article" : "Note", tone: "" }];
    if (mine && mine.doneAt) marks.push({ text: "Read", tone: "ok" });
    if (lesson.quiz) {
      if (mine && mine.attempts) marks.push({ text: "Best " + mine.bestPercent + "%", tone: mine.bestPercent >= 70 ? "ok" : "attn" });
      else marks.push({ text: plural(lesson.quiz, "question"), tone: "" });
    }
    return marks;
  }

  // How a graded answer is shown: "Correct", or "Not quite. The answer is 443."
  function resultText(q, result) {
    if (result.right) return "Correct";
    var c = result.correct;
    var answer = Array.isArray(c) ? c.join(" or ") : q.kind === "choice" ? (q.options || [])[c] : c ? "True" : "False";
    return "Not quite. The answer is " + answer + ".";
  }
  function scoreText(res) { return res.right + " of " + res.total + " (" + res.percent + "%)" + (res.passed ? ": passed" : ": keep going"); }

  var helpers = { tokenFromHash: tokenFromHash, gateMessage: gateMessage, errorText: errorText, progressLine: progressLine, completionBanner: completionBanner, lessonMarks: lessonMarks, resultText: resultText, scoreText: scoreText, daysLeft: daysLeft, dateText: dateText };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. the page ---------------------------------------------------------

  var MD = root.BarnyardMarkdown;
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== null && text !== undefined) e.textContent = text;
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function btn(text, cls, onClick) {
    var b = h("button", "btn " + (cls || ""), text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  var token = tokenFromHash(root.location.hash);
  var model = { course: null, progress: null, key: "" };

  // The key lives only in this browser, under the invite it belongs to.
  var storeName = function () { return "barnyard-learn:" + token; };
  function loadKey() { try { var k = root.localStorage.getItem(storeName()); return KEY.test(k || "") ? k : ""; } catch (e) { return ""; } }
  function saveKey(k) { try { if (k) root.localStorage.setItem(storeName(), k); else root.localStorage.removeItem(storeName()); } catch (e) { /* the page works without it, you just join again next time */ } }

  function call(route, body) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 20000);
    var payload = { token: token };
    for (var k in body) payload[k] = body[k];
    if (model.key && route !== "join" && payload.key === undefined) payload.key = model.key;
    return fetch(API + route, {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller ? controller.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b || {} }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  function gate(msg) {
    $("ln-app").hidden = true;
    $("ln-gate").hidden = false;
    $("ln-gate-title").textContent = msg.title;
    $("ln-gate-msg").textContent = msg.text;
    document.title = msg.title + " · Barnyard";
  }

  function flash(text, tone) {
    var f = $("ln-flash");
    f.hidden = !text;
    f.className = "ln-flash" + (tone ? " " + tone : "");
    f.textContent = text || "";
  }

  // Shows the answer to a call that failed: a dead link replaces the page, anything else is one line.
  function failed(r) {
    var code = r.body && r.body.error;
    if (code === "invite_expired" || code === "invite_revoked" || (r.status === 404 && code === "not_found")) { gate(gateMessage(code, r.status)); return; }
    if (code === "key_invalid") { model.key = ""; saveKey(""); model.progress = null; drawHome(); flash(errorText("key_invalid"), "alert"); return; }
    flash(r.status === 0 ? "The page could not be reached. Check your connection and try again." : errorText(code), "alert");
  }

  function adopt(body) {
    if (body.course) model.course = body.course;
    if (body.progress) model.progress = body.progress;
  }

  function lessonProgress(id) {
    var rows = model.progress ? model.progress.lessons : [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  function headCard() {
    var c = model.course;
    var card = h("div", "ln-card");
    card.appendChild(h("h1", null, c.title));
    if (c.summary) card.appendChild(h("p", "ln-dim", c.summary));
    var meta = [];
    if (c.label) meta.push(c.label);
    if (c.expiresAt) meta.push("This invitation works for " + plural(daysLeft(c.expiresAt), "more day"));
    if (meta.length) card.appendChild(h("p", "ln-small ln-dim", meta.join(" · ")));
    return card;
  }

  // ---- the name form, then the course --------------------------------------------------------------------------------------

  function drawHome() {
    var root1 = $("ln-root");
    clear(root1);
    root1.appendChild(headCard());
    if (!model.progress) { root1.appendChild(joinForm()); return; }
    var p = model.progress;
    var top = h("div", "ln-card");
    top.appendChild(h("p", null, "Hello, " + p.learner.name + "."));
    var done = p.completion.total ? Math.round((p.completion.read / p.completion.total) * 100) : 0;
    var bar = h("progress"); bar.max = 100; bar.value = done; bar.setAttribute("aria-label", "Lessons read");
    top.appendChild(bar);
    top.appendChild(h("p", "ln-small ln-dim", progressLine(p)));
    var banner = completionBanner(p);
    if (banner.text) top.appendChild(h("p", "ln-banner " + banner.tone, banner.text));
    root1.appendChild(top);

    var list = h("ol", "ln-lessons");
    model.course.lessons.forEach(function (l) {
      var mine = lessonProgress(l.id);
      var li = h("li", "ln-lesson" + (mine && mine.doneAt ? " done" : ""));
      var open = h("button", "ln-lesson-open", l.title); open.type = "button";
      open.addEventListener("click", function () { drawLesson(l); });
      li.appendChild(open);
      var marks = h("span", "ln-marks");
      lessonMarks(l, mine).forEach(function (m) { marks.appendChild(h("span", "ln-chip" + (m.tone ? " " + m.tone : ""), m.text)); });
      li.appendChild(marks);
      list.appendChild(li);
    });
    if (!model.course.lessons.length) list.appendChild(h("li", "ln-dim", "No lessons yet."));
    root1.appendChild(list);

    var total = model.course.lessons.reduce(function (n, l) { return n + l.quiz; }, 0);
    var actions = h("div", "ln-actions");
    var finalBtn = btn("Final check (" + Math.min(10, total) + " questions)", "btn-primary", function () { startQuiz({ all: true }, "Final check"); });
    finalBtn.disabled = !total;
    actions.appendChild(finalBtn);
    actions.appendChild(btn("This is not me", "btn-quiet", function () { model.key = ""; saveKey(""); model.progress = null; flash(null); drawHome(); }));
    root1.appendChild(actions);
    var quizBox = h("div"); quizBox.id = "ln-quizbox";
    root1.appendChild(quizBox);
    root1.appendChild(h("p", "ln-small ln-dim", "Your progress is kept in this browser and on the Academy under the name you gave. Anyone with the link can join, but only this browser has your key."));
  }

  function joinForm() {
    var form = h("form", "ln-card ln-form");
    form.appendChild(h("h2", null, "Join this course"));
    form.appendChild(h("p", "ln-dim", "Type your name so the person who sent this can see who has finished. Nothing else is asked or kept."));
    var label = h("label", "ln-field");
    label.appendChild(h("span", "ln-label", "Your name"));
    var input = h("input"); input.type = "text"; input.maxLength = 40; input.autocomplete = "name"; input.required = true;
    label.appendChild(input);
    form.appendChild(label);
    var go = btn("Start", "btn-primary", null); go.type = "submit";
    form.appendChild(go);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      flash(null);
      go.disabled = true;
      call("join", { name: input.value }).then(function (r) {
        go.disabled = false;
        if (r.status !== 201 || !r.body.key) { failed(r); return; }
        model.key = r.body.key; saveKey(model.key);
        adopt(r.body);
        drawHome();
      });
    });
    return form;
  }

  // ---- a lesson and its quiz -----------------------------------------------------------------------------------------------

  function drawLesson(l) {
    var root1 = $("ln-root");
    flash(null);
    clear(root1);
    var back = btn("← " + model.course.title, "btn-quiet btn-sm", function () { drawHome(); });
    root1.appendChild(back);
    var card = h("div", "ln-card");
    card.appendChild(h("h2", null, l.title));
    var mine = lessonProgress(l.id);
    var actions = h("div", "ln-actions");
    var doneBtn = btn(mine && mine.doneAt ? "Mark as not read" : "Mark as read", "btn-sm", function () {
      doneBtn.disabled = true;
      call("done", { lessonId: l.id, done: !(mine && mine.doneAt) }).then(function (r) {
        if (r.status !== 200 || !r.body.ok) { doneBtn.disabled = false; failed(r); return; }
        model.progress = r.body.progress;
        if (r.body.finished) flash("That is the whole course finished. Well done.", "ok");
        drawLesson(l);
      });
    });
    actions.appendChild(doneBtn);
    var quizBtn = btn("Take the quiz" + (l.quiz ? " (" + Math.min(10, l.quiz) + ")" : ""), "btn-sm btn-primary", function () { startQuiz({ lessonId: l.id }, l.title, l); });
    quizBtn.disabled = !l.quiz;
    actions.appendChild(quizBtn);
    card.appendChild(actions);
    root1.appendChild(card);

    var quizBox = h("div"); quizBox.id = "ln-quizbox";
    root1.appendChild(quizBox);
    var body = h("div", "ln-card ln-body");
    body.appendChild(h("p", "ln-dim", "Loading the lesson…"));
    root1.appendChild(body);
    call("lesson", { lessonId: l.id }).then(function (r) {
      clear(body);
      if (r.status !== 200 || !r.body.lesson) { failed(r); return; }
      var c = r.body.lesson;
      if (c.missing) { body.appendChild(h("p", null, "This article is not available any more. Ask the person who sent the link.")); return; }
      if (c.unavailable) { body.appendChild(h("p", null, errorText("kb_unavailable"))); return; }
      var md = h("div", "ln-md");
      try { md.appendChild(MD.toDom(MD.parse(c.body || ""), document, {})); } catch (e) { md.textContent = c.body || ""; }
      body.appendChild(md);
      if (c.truncated) body.appendChild(h("p", "ln-small ln-dim", "The article is long; the first part is shown here."));
    });
  }

  function startQuiz(scope, name, lesson) {
    var box = $("ln-quizbox");
    if (!box) return;
    flash(null);
    call("quiz", scope).then(function (r) {
      if (r.status !== 200 || !r.body.questions) { failed(r); return; }
      runQuiz(box, { title: (scope.all ? "" : "Quiz: ") + name, questions: r.body.questions, scope: scope, lesson: lesson });
    });
  }

  // The questions, one control each; on submit the Worker grades and the page shows what was right and why.
  function runQuiz(box, opts) {
    clear(box);
    var card = h("form", "ln-card ln-quiz");
    card.appendChild(h("h2", null, opts.title));
    var controls = {};
    opts.questions.forEach(function (q, n) {
      var item = h("fieldset", "ln-qitem");
      item.appendChild(h("legend", null, (n + 1) + ". " + q.prompt));
      if (q.kind === "short") {
        var t = h("input"); t.type = "text"; t.maxLength = 160; t.setAttribute("aria-label", "Your answer");
        controls[q.id] = function () { return t.value; };
        item.appendChild(t);
      } else {
        var options = q.kind === "truefalse" ? ["True", "False"] : q.options;
        options.forEach(function (label, i) {
          var l = h("label", "ln-opt");
          var radio = h("input"); radio.type = "radio"; radio.name = q.id; radio.value = String(i);
          l.appendChild(radio); l.appendChild(h("span", null, label));
          item.appendChild(l);
        });
        controls[q.id] = function () {
          var picked = card.querySelector('input[name="' + q.id + '"]:checked');
          if (!picked) return undefined;
          var i = parseInt(picked.value, 10);
          return q.kind === "truefalse" ? i === 0 : i;
        };
      }
      var fb = h("div", "ln-feedback ln-small"); fb.setAttribute("data-for", q.id);
      item.appendChild(fb);
      card.appendChild(item);
    });
    var submit = btn("Check my answers", "btn-primary", null); submit.type = "submit";
    card.appendChild(submit);
    card.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var answers = {}, missing = false;
      opts.questions.forEach(function (q) { var v = controls[q.id](); if (v === undefined) missing = true; else answers[q.id] = v; });
      if (missing) { flash("Answer every question first.", "alert"); return; }
      flash(null);
      submit.disabled = true;
      var body = { answers: answers };
      if (opts.scope.all) body.all = true; else body.lessonId = opts.scope.lessonId;
      call("grade", body).then(function (r) {
        if (r.status !== 200 || r.body.ok !== true) { submit.disabled = false; failed(r); return; }
        model.progress = r.body.progress;
        showResults(card, opts, r.body);
      });
    });
    box.appendChild(card);
    card.scrollIntoView({ block: "start" });
  }

  function showResults(card, opts, res) {
    var byId = {};
    opts.questions.forEach(function (q) { byId[q.id] = q; });
    res.results.forEach(function (r) {
      var fb = card.querySelector('[data-for="' + r.id + '"]');
      if (!fb) return;
      clear(fb);
      fb.className = "ln-feedback ln-small " + (r.right ? "ok" : "alert");
      fb.appendChild(h("b", null, resultText(byId[r.id], r)));
      if (r.explanation) fb.appendChild(h("div", "ln-dim", r.explanation));
    });
    Array.prototype.forEach.call(card.querySelectorAll("input"), function (i) { i.disabled = true; });
    var old = card.querySelector('button[type="submit"]'); if (old) old.remove();
    card.appendChild(h("p", "ln-banner " + (res.passed ? "ok" : "attn"), scoreText(res) + (res.finished ? ". That finishes the course. Well done." : "")));
    var actions = h("div", "ln-actions");
    actions.appendChild(btn("Try again", "btn-sm btn-primary", function () { startQuiz(opts.scope, opts.title.replace(/^Quiz: /, ""), opts.lesson); }));
    actions.appendChild(btn("Back to the course", "btn-sm", function () { drawHome(); }));
    card.appendChild(actions);
    card.scrollIntoView({ block: "start" });
  }

  // ---- start ---------------------------------------------------------------------------------------------------------------

  function open() {
    if (!token) { gate(gateMessage("not_found", 404)); return; }
    model.key = loadKey();
    call("open", {}).then(function (r) {
      if (r.status !== 200 || !r.body.course) { gate(gateMessage(r.body && r.body.error, r.status)); return; }
      if (r.body.keyInvalid) { model.key = ""; saveKey(""); }
      adopt(r.body);
      $("ln-gate").hidden = true;
      $("ln-app").hidden = false;
      document.title = model.course.title + " · Barnyard";
      drawHome();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", open); else open();
})(typeof window !== "undefined" ? window : this);
