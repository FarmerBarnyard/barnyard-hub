// The Academy page (academy.html): courses made from Knowledgebase articles and your own notes, a short quiz per lesson, a final check
// per course, and a review that brings back what you missed. The owner's page, like Reports and Services.
//
// Reads and writes /academy/* on the Worker (ClaudeRepo's cloudflare-worker/src/academy-routes.js, owner only):
//   GET  /academy/courses  /summary  /records  /review  /quiz?lesson=|course=      POST /academy/quiz/grade  /review/grade
//   POST /academy/courses  PATCH|DELETE /academy/courses/<id>   POST .../<id>/lessons  .../<id>/order
//   GET|PATCH|DELETE /academy/lessons/<id>   POST .../<id>/done   GET|POST .../<id>/questions   PATCH|DELETE /academy/questions/<id>
//   GET /academy/drafts/status  /drafts/list?lesson=  /drafts/job?id=   POST /academy/lessons/<id>/draft  /academy/drafts/cancel  /drafts/delete  /drafts/save
//     (question drafting with the local model: a panel above a lesson's questions; nothing is saved until you keep a candidate, always as a draft)
//   GET|POST /academy/invites  POST /academy/invites/<id>/revoke  GET /academy/learners[?course=]  GET|DELETE /academy/learners/<id>
//     (invite links for other learners, on a course's page; the learners' own page is learn.html with no login, see learn.js)
// The words and rules are in academy-logic.js (tested in test/academy.test.js); this file draws them. A quiz never has its answers until it
// is graded: the Worker grades and sends back what was right. Questions Claude drafted are marked as drafts and only count once approved.
//
// Everything from the server reaches the page through textContent or the safe Markdown renderer (markdown.js builds DOM nodes only); the
// page's CSP has no 'unsafe-inline' for scripts or styles. Nothing is kept in this browser.

(function () {
  "use strict";

  var L = window.BarnyardAcademyLogic;
  var MD = window.BarnyardMarkdown;
  var API = "https://api.barnyard.site";
  if (!L) return;

  var model = { state: "loading", courses: [], sum: null, route: { view: "home", id: "" }, flash: null };

  // ---- data -----------------------------------------------------------------------------------------------------------------

  function send(method, path, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    var init = { method: method, credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return fetch(API + "/academy" + path, init).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  function failState(r) {
    if (r.status === 401) { model.state = "guest"; return true; }
    if (r.status === 403 && r.body && r.body.error === "forbidden") { model.state = "forbidden"; return true; }
    if (r.status === 403 && r.body && r.body.error === "academy_disabled") { model.state = "off"; return true; }
    return false;
  }

  function loadAll() {
    return Promise.all([send("GET", "/courses"), send("GET", "/summary")]).then(function (rs) {
      if (failState(rs[0])) return;
      if (rs[0].status !== 200 || !rs[0].body || rs[0].body.ok !== true) { model.state = model.state === "ok" ? "ok" : "error"; return; }
      model.courses = rs[0].body.courses || [];
      model.sum = rs[1].status === 200 ? rs[1].body : model.sum;
      model.state = "ok";
    });
  }

  // ---- small drawing helpers ------------------------------------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== null && text !== undefined) e.textContent = text;
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }
  function btn(text, cls, onClick) {
    var b = h("button", "btn " + (cls || ""), text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function link(text, href, cls) { var a = h("a", cls || "", text); a.href = href; return a; }
  function field(label, control, hint) {
    var w = h("label", "ac-field");
    w.appendChild(h("span", "ac-label", label));
    w.appendChild(control);
    if (hint) w.appendChild(h("span", "dim small", hint));
    return w;
  }
  function input(value, max) { var i = h("input"); i.type = "text"; i.value = value || ""; if (max) i.maxLength = max; return i; }
  function area(value, rows, max) { var t = h("textarea"); t.rows = rows || 4; t.value = value || ""; if (max) t.maxLength = max; return t; }

  // The message line under the title. It is kept in the model so a re-draw (or one page change) shows it again.
  function paintFlash() {
    var f = $("ac-flash"), m = model.flash;
    if (!f) return;
    f.hidden = !m;
    f.className = "ac-flash" + (m && m.tone ? " " + m.tone : "");
    f.textContent = m ? m.text : "";
  }
  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    paintFlash();
  }

  // A button that asks again before it does something that cannot be undone.
  function confirmButton(label, ask, onYes, yesLabel) {
    var wrap = h("span", "ac-confirm");
    function idle() {
      clear(wrap);
      wrap.appendChild(btn(label, "btn-sm btn-quiet", function () {
        clear(wrap);
        wrap.appendChild(h("span", "small", ask + " "));
        wrap.appendChild(btn(yesLabel || "Yes, delete", "btn-sm", onYes));
        wrap.appendChild(btn("Cancel", "btn-sm btn-quiet", idle));
      }));
    }
    idle();
    return wrap;
  }

  // Runs a request, shows the Worker's refusal in plain words, and calls `then` with the body on success.
  function act(promise, then) {
    return promise.then(function (r) {
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok !== false) return then(r.body);
      flash(r.status === 0 ? "The Worker could not be reached. Try again." : L.errorText(r.body && r.body.error), "alert");
    });
  }

  // ---- navigation -----------------------------------------------------------------------------------------------------------

  // A message set just before moving to another screen is shown on that screen (and cleared by the next move).
  function go(hash) {
    if (location.hash === hash) { render(); return; }
    model.keepFlash = true;
    location.hash = hash;
  }

  function renderTools(tools) {
    clear(tools);
    var due = model.sum && model.sum.due ? model.sum.due : 0;
    tools.appendChild(link("Review" + (due ? " (" + due + " due)" : ""), "#/review", "btn btn-sm" + (due ? " btn-primary" : "")));
    tools.appendChild(link("Records", "#/records", "btn btn-sm btn-quiet"));
    var learners = model.sum && model.sum.learners ? model.sum.learners : 0;
    tools.appendChild(link("Learners" + (learners ? " (" + learners + ")" : ""), "#/learners", "btn btn-sm btn-quiet"));
  }

  function render() {
    stopDraftPolling();
    model.route = L.routeFromHash(location.hash);
    var root = $("ac-root");
    renderTools($("ac-tools"));
    paintFlash();
    clear(root);
    if (model.state === "loading") { root.appendChild(h("p", "dim", "Loading…")); return; }
    if (model.state === "guest") { root.appendChild(h("p", null, "Sign in to see the Academy.")); return; }
    if (model.state === "forbidden") { root.appendChild(h("p", null, L.errorText("forbidden"))); return; }
    if (model.state === "off") { root.appendChild(h("p", null, L.errorText("academy_disabled"))); return; }
    if (model.state === "error") {
      root.appendChild(h("p", null, "The Academy could not be read."));
      root.appendChild(btn("Try again", "btn-sm", function () { loadAll().then(render); }));
      return;
    }
    var r = model.route;
    if (r.view === "course") return drawCourse(root, r.id);
    if (r.view === "lesson") return drawLesson(root, r.id);
    if (r.view === "review") return drawReview(root);
    if (r.view === "records") return drawRecords(root);
    if (r.view === "learners") return drawLearners(root);
    drawHome(root);
  }

  var courseById = function (id) { return model.courses.filter(function (c) { return c.id === id; })[0] || null; };

  // ---- home -----------------------------------------------------------------------------------------------------------------

  function newCourseForm() {
    var form = h("form", "ac-card ac-form");
    form.appendChild(h("h2", null, "New course"));
    var t = input("", 80), s = input("", 300);
    form.appendChild(field("Title", t));
    form.appendChild(field("What it is for", s, "Optional. One line."));
    var go1 = btn("Create course", "btn-primary", null); go1.type = "submit";
    form.appendChild(go1);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!t.value.trim()) { flash(L.errorText("title_required"), "alert"); return; }
      go1.disabled = true;
      act(send("POST", "/courses", { title: t.value.trim(), summary: s.value.trim() }), function (b) {
        return loadAll().then(function () { flash("Course made. Add its first lesson.", "ok"); go("#/c/" + b.course.id); });
      }).then(function () { go1.disabled = false; });
    });
    return form;
  }

  function drawHome(root) {
    var sum = model.sum || {};
    if (sum.due || sum.drafts) {
      var ban = h("div", "ac-banner attn");
      if (sum.due) ban.appendChild(h("b", null, L.plural(sum.due, "question") + " due for review"));
      if (sum.drafts) ban.appendChild(h("span", null, L.plural(sum.drafts, "drafted question") + " waiting for you to check them against the lesson."));
      if (sum.due) ban.appendChild(link("Start the review", "#/review", "btn btn-sm btn-primary"));
      root.appendChild(ban);
    }
    var grid = h("div", "ac-grid");
    model.courses.forEach(function (c) {
      var card = h("a", "ac-card ac-course");
      card.href = "#/c/" + c.id;
      card.appendChild(h("h2", null, c.title));
      if (c.summary) card.appendChild(h("p", "dim", c.summary));
      var bar = h("progress"); bar.max = 100; bar.value = c.progress.percent; bar.setAttribute("aria-label", "Progress");
      card.appendChild(bar);
      card.appendChild(h("span", "small dim", L.courseLine(c)));
      grid.appendChild(card);
    });
    if (!model.courses.length) {
      var empty = h("div", "ac-card");
      empty.appendChild(h("h2", null, "No courses yet"));
      empty.appendChild(h("p", "dim", "A course is a list of Knowledgebase articles (and short notes of your own) with a quiz on each. Make one, then paste an article link into it."));
      grid.appendChild(empty);
    }
    root.appendChild(grid);
    root.appendChild(newCourseForm());
  }

  // ---- a course -------------------------------------------------------------------------------------------------------------

  function drawCourse(root, id) {
    var c = courseById(id);
    if (!c) { root.appendChild(h("p", null, L.errorText("not_found"))); root.appendChild(link("All courses", "#/", "btn btn-sm")); return; }
    root.appendChild(link("← All courses", "#/", "ac-back"));
    var head = h("div", "ac-card");
    var title = h("h2", null, c.title);
    head.appendChild(title);
    if (c.summary) head.appendChild(h("p", "dim", c.summary));
    var bar = h("progress"); bar.max = 100; bar.value = c.progress.percent; bar.setAttribute("aria-label", "Progress");
    head.appendChild(bar);
    head.appendChild(h("span", "small dim", L.courseLine(c)));
    var actions = h("div", "ac-actions");
    var approved = c.lessons.reduce(function (n, l) { return n + l.approved; }, 0);
    var finalBtn = btn("Final check" + (approved ? " (" + Math.min(10, approved) + " questions)" : ""), "btn-sm btn-primary", function () { startQuiz({ course: c.id }, c.title); });
    finalBtn.disabled = !approved;
    actions.appendChild(finalBtn);
    actions.appendChild(btn("Rename", "btn-sm", function () { renameCourse(head, c); }));
    actions.appendChild(confirmButton("Delete course", "Delete it, its lessons, questions and records?", function () {
      act(send("DELETE", "/courses/" + c.id + "?confirm=1"), function () { return loadAll().then(function () { flash("Course deleted.", "ok"); go("#/"); }); });
    }));
    head.appendChild(actions);
    root.appendChild(head);

    var quizBox = h("div", "ac-quizbox"); quizBox.id = "ac-quizbox";
    root.appendChild(quizBox);

    var list = h("ol", "ac-lessons");
    c.lessons.forEach(function (l, i) {
      var li = h("li", "ac-lesson" + (l.doneAt ? " done" : ""));
      var main = h("div", "ac-lesson-main");
      var a = link(l.title, "#/l/" + l.id, "ac-lesson-title");
      main.appendChild(a);
      var meta = h("div", "small dim");
      meta.appendChild(chip(l.kind === "article" ? "Article" : "Note", ""));
      if (l.doneAt) meta.appendChild(chip("Read", "ok"));
      if (l.attempts) meta.appendChild(chip("Best " + l.bestPercent + "%", l.bestPercent >= 70 ? "ok" : "attn"));
      meta.appendChild(h("span", null, " " + L.quizLine(l)));
      main.appendChild(meta);
      li.appendChild(main);
      var side = h("div", "ac-lesson-side");
      var up = btn("↑", "btn-sm btn-quiet", function () { move(c, i, -1); }); up.setAttribute("aria-label", "Move up"); up.disabled = i === 0;
      var dn = btn("↓", "btn-sm btn-quiet", function () { move(c, i, 1); }); dn.setAttribute("aria-label", "Move down"); dn.disabled = i === c.lessons.length - 1;
      side.appendChild(up); side.appendChild(dn);
      side.appendChild(confirmButton("Remove", "Remove this lesson and its questions?", function () {
        act(send("DELETE", "/lessons/" + l.id + "?confirm=1"), function () { return loadAll().then(function () { flash("Lesson removed.", "ok"); render(); }); });
      }));
      li.appendChild(side);
      list.appendChild(li);
    });
    if (!c.lessons.length) list.appendChild(h("li", "dim", "No lessons yet. Add one below."));
    root.appendChild(list);
    root.appendChild(addLessonForms(c));
    root.appendChild(inviteCard(c));
  }

  function renameCourse(head, c) {
    var form = h("form", "ac-form");
    var t = input(c.title, 80), s = input(c.summary, 300);
    form.appendChild(field("Title", t)); form.appendChild(field("What it is for", s));
    var save = btn("Save", "btn-sm btn-primary", null); save.type = "submit";
    form.appendChild(save);
    form.appendChild(btn("Cancel", "btn-sm btn-quiet", render));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      act(send("PATCH", "/courses/" + c.id, { title: t.value.trim(), summary: s.value.trim() }), function () { return loadAll().then(function () { flash("Saved.", "ok"); render(); }); });
    });
    head.appendChild(form);
  }

  function move(c, i, delta) {
    var ids = c.lessons.map(function (l) { return l.id; });
    var j = i + delta;
    if (j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    act(send("POST", "/courses/" + c.id + "/order", { lessonIds: ids }), function () { return loadAll().then(render); });
  }

  function addLessonForms(c) {
    var wrap = h("div", "ac-grid");
    // from an article
    var f1 = h("form", "ac-card ac-form");
    f1.appendChild(h("h3", null, "Add a Knowledgebase article"));
    var where = input("", 300);
    var title = input("", 120);
    f1.appendChild(field("Article link or id", where, "Open the article in the Knowledgebase and paste its address here."));
    f1.appendChild(field("Lesson title", title, "Optional. The article's own title is used if you leave this empty."));
    var add1 = btn("Add lesson", "btn-primary", null); add1.type = "submit";
    f1.appendChild(add1);
    f1.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var aid = L.articleIdFrom(where.value);
      if (!aid) { flash(L.errorText("articleId_invalid"), "alert"); return; }
      var body = { kind: "article", articleId: aid };
      if (title.value.trim()) body.title = title.value.trim();
      add1.disabled = true;
      act(send("POST", "/courses/" + c.id + "/lessons", body), function () { return loadAll().then(function () { flash("Lesson added.", "ok"); render(); }); }).then(function () { add1.disabled = false; });
    });
    wrap.appendChild(f1);
    // a note
    var f2 = h("form", "ac-card ac-form");
    f2.appendChild(h("h3", null, "Write a note lesson"));
    var nt = input("", 120), nb = area("", 5, 4000);
    f2.appendChild(field("Title", nt));
    f2.appendChild(field("Text", nb, "Plain text, up to 4,000 characters."));
    var add2 = btn("Add lesson", "btn-primary", null); add2.type = "submit";
    f2.appendChild(add2);
    f2.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!nt.value.trim()) { flash(L.errorText("title_required"), "alert"); return; }
      if (!nb.value.trim()) { flash(L.errorText("note_required"), "alert"); return; }
      add2.disabled = true;
      act(send("POST", "/courses/" + c.id + "/lessons", { kind: "note", title: nt.value.trim(), note: nb.value }), function () { return loadAll().then(function () { flash("Lesson added.", "ok"); render(); }); }).then(function () { add2.disabled = false; });
    });
    wrap.appendChild(f2);
    return wrap;
  }

  // ---- a lesson -------------------------------------------------------------------------------------------------------------

  function findLesson(id) {
    for (var i = 0; i < model.courses.length; i++) {
      var ls = model.courses[i].lessons;
      for (var j = 0; j < ls.length; j++) if (ls[j].id === id) return { course: model.courses[i], lesson: ls[j] };
    }
    return null;
  }

  function drawLesson(root, id) {
    var found = findLesson(id);
    if (!found) { root.appendChild(h("p", null, L.errorText("not_found"))); root.appendChild(link("All courses", "#/", "btn btn-sm")); return; }
    var lesson = found.lesson, course = found.course;
    root.appendChild(link("← " + course.title, "#/c/" + course.id, "ac-back"));
    var head = h("div", "ac-card");
    head.appendChild(h("h2", null, lesson.title));
    var meta = h("div", "small dim");
    meta.appendChild(chip(lesson.kind === "article" ? "Knowledgebase article" : "Note", ""));
    if (lesson.doneAt) meta.appendChild(chip("Read " + L.agoText(lesson.doneAt), "ok"));
    head.appendChild(meta);
    var actions = h("div", "ac-actions");
    actions.appendChild(btn(lesson.doneAt ? "Mark as not read" : "Mark as read", "btn-sm", function () {
      act(send("POST", "/lessons/" + lesson.id + "/done", { done: !lesson.doneAt }), function () { return loadAll().then(render); });
    }));
    var quiz = btn("Take the quiz" + (lesson.approved ? " (" + Math.min(10, lesson.approved) + ")" : ""), "btn-sm btn-primary", function () { startQuiz({ lesson: lesson.id }, lesson.title); });
    quiz.disabled = !lesson.approved;
    actions.appendChild(quiz);
    head.appendChild(actions);
    root.appendChild(head);

    var quizBox = h("div", "ac-quizbox"); quizBox.id = "ac-quizbox";
    root.appendChild(quizBox);

    var body = h("div", "ac-card ac-body");
    body.appendChild(h("p", "dim", "Loading the lesson…"));
    root.appendChild(body);
    send("GET", "/lessons/" + lesson.id).then(function (r) {
      clear(body);
      if (r.status !== 200 || !r.body || !r.body.content) { body.appendChild(h("p", null, L.errorText(r.body && r.body.error))); return; }
      var c = r.body.content;
      if (c.kind === "article" && c.missing) { body.appendChild(h("p", null, "This article is not shared in the Knowledgebase any more (it was hidden or deleted). The lesson and its questions are kept.")); return; }
      if (c.kind === "article" && c.unavailable) { body.appendChild(h("p", null, L.errorText("kb_unavailable"))); return; }
      var md = h("div", "ac-md");
      try { md.appendChild(MD.toDom(MD.parse(c.body || ""), document, {})); } catch (e) { md.textContent = c.body || ""; }
      body.appendChild(md);
      if (c.truncated) body.appendChild(h("p", "dim small", "The article is long; the first part is shown here."));
      if (c.link) body.appendChild(link("Open it in the Knowledgebase", c.link, "btn btn-sm btn-quiet"));
      if (lesson.kind === "note") body.appendChild(btn("Edit this note", "btn-sm", function () { editNote(body, lesson, c.body); }));
    });

    var qBox = h("div", "ac-card");
    qBox.appendChild(h("h3", null, "Questions"));
    root.appendChild(qBox);
    drawQuestions(qBox, lesson);
  }

  function editNote(body, lesson, text) {
    clear(body);
    var form = h("form", "ac-form");
    var t = input(lesson.title, 120), n = area(text, 8, 4000);
    form.appendChild(field("Title", t)); form.appendChild(field("Text", n));
    var save = btn("Save", "btn-sm btn-primary", null); save.type = "submit";
    form.appendChild(save); form.appendChild(btn("Cancel", "btn-sm btn-quiet", render));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      act(send("PATCH", "/lessons/" + lesson.id, { title: t.value.trim(), note: n.value }), function () { return loadAll().then(function () { flash("Saved.", "ok"); render(); }); });
    });
    body.appendChild(form);
  }

  // ---- questions (the owner's view, with answers) ----------------------------------------------------------------------------

  function drawQuestions(box, lesson) {
    var drafting = drawDrafter(box, lesson, function () { reload(); });
    var list = h("div", "ac-qlist");
    box.appendChild(list);
    function reload() {
      send("GET", "/lessons/" + lesson.id + "/questions").then(function (r) {
        clear(list);
        if (r.status !== 200 || !r.body || !r.body.questions) { list.appendChild(h("p", null, L.errorText(r.body && r.body.error))); return; }
        var qs = r.body.questions;
        if (!qs.length) list.appendChild(h("p", "dim", "No questions yet. Write some below, or use the drafting panel above: drafts wait here for you to approve."));
        qs.forEach(function (q) { list.appendChild(questionRow(q, lesson, reload)); });
        list.appendChild(questionForm(null, lesson, reload));
        drafting.setQuestions(qs);
      });
    }
    reload();
  }

  // ---- drafting questions with the local model ----------------------------------------------------------------------------------
  //
  // The panel above a lesson's questions. "Draft questions" queues a job for the engine on app02 (the Worker refuses it up front when the
  // engine is off or not running). What comes back is shown as candidates: keep one as a draft, approve it, edit it first, or discard it.
  // Nothing is saved until you keep one, and a kept one is always a draft until you approve it. The job lives on the Worker, so leaving this
  // page does not lose it: the panel picks the newest job up again when the lesson is opened. Nothing is kept in this browser.

  var drafter = { token: 0, timer: null, handled: {} };

  function stopDraftPolling() {
    drafter.token++;   // any answer still on its way belongs to a panel that is gone
    if (drafter.timer) { clearTimeout(drafter.timer); drafter.timer = null; }
  }

  function candidateDetail(q) {
    var detail = h("div", "small");
    if (q.kind === "choice") q.options.forEach(function (o, i) { detail.appendChild(h("div", i === q.answer ? "ac-right" : "", (i === q.answer ? "✔ " : "• ") + o)); });
    else detail.appendChild(h("div", "ac-right", "✔ " + (q.answer ? "True" : "False")));
    if (q.explanation) detail.appendChild(h("div", "dim", "Why: " + q.explanation));
    return detail;
  }

  function drawDrafter(box, lesson, reloadList) {
    var mine = ++drafter.token;
    var panel = h("div", "ac-drafter");
    box.appendChild(panel);
    var view = { status: null, job: null, candidates: [], rejected: [], pending: 0, questions: [], busy: false, editing: null, note: "" };
    var alive = function () { return mine === drafter.token && document.body.contains(panel); };

    function loadStatus() {
      return send("GET", "/drafts/status").then(function (r) { if (alive()) view.status = r.status === 200 ? r.body : null; });
    }

    // Asks about the job (with the revision we hold, so an unchanged job comes back tiny) and schedules the next look.
    function track(id) {
      if (!alive()) return;
      if (drafter.timer) { clearTimeout(drafter.timer); drafter.timer = null; }
      send("GET", "/drafts/job?id=" + id + (view.job && view.job.id === id ? "&since=" + view.job.rev : "")).then(function (r) {
        if (!alive()) return;
        if (r.status === 404) { view.job = null; view.candidates = []; view.rejected = []; paint(); return; }
        if (r.status === 200 && r.body && r.body.ok && !r.body.unchanged) {
          view.job = r.body.job; view.candidates = r.body.candidates || []; view.rejected = r.body.rejected || []; view.pending = r.body.pending || 0;
          paint();
        }
        var wait = L.draftPollMs(view.job);
        if (wait && (r.status === 200 || r.status === 0)) drafter.timer = setTimeout(function () { drafter.timer = null; track(id); }, wait);
      });
    }

    // Picks up the lesson's newest job after a reload: a running one, or one with questions still to decide.
    function resume() {
      return Promise.all([loadStatus(), send("GET", "/drafts/list?lesson=" + lesson.id)]).then(function (rs) {
        if (!alive()) return;
        var jobs = rs[1].status === 200 && rs[1].body && rs[1].body.jobs ? rs[1].body.jobs : [];
        var pick = jobs.filter(function (j) { return j.state !== "cancelled" || j.done > 0; })[0];
        paint();
        if (pick) track(pick.id);
      });
    }

    function start(count) {
      view.busy = true; paint();
      send("POST", "/lessons/" + lesson.id + "/draft", { count: count }).then(function (r) {
        view.busy = false;
        if (!alive()) return;
        if (r.status !== 202 || !r.body || !r.body.ok) {
          flash(L.errorText(r.body && r.body.error), "alert");
          loadStatus().then(paint);
          return;
        }
        // show the job at once; the first look at it follows
        view.job = { id: r.body.job.id, state: "queued", total: r.body.job.total, done: 0, failed: 0, rev: 0, label: "" };
        view.candidates = []; view.rejected = []; view.pending = 0;
        paint();
        track(r.body.job.id);
        loadStatus().then(paint);
      });
    }

    function forget() {
      var id = view.job && view.job.id;
      if (!id) return;
      send("POST", "/drafts/delete", { id: id }).then(function (r) {
        if (!alive()) return;
        if (r.status === 200 || r.status === 404) { delete drafter.handled[id]; view.job = null; view.candidates = []; view.rejected = []; loadStatus().then(paint); }
        else flash(L.errorText(r.body && r.body.error), "alert");
      });
    }

    function decided(idx) {
      var id = view.job.id;
      (drafter.handled[id] = drafter.handled[id] || {})[idx] = true;
    }

    // Keep one candidate on the lesson as a draft (the Worker saves its own reading of the reply, not anything the page holds).
    function keep(c, approve) {
      view.busy = true; paint();
      return send("POST", "/drafts/save", { id: view.job.id, idx: c.idx }).then(function (r) {
        if (!alive()) return;
        view.busy = false;
        if (r.status === 409 && r.body && r.body.error === "already_saved") { decided(c.idx); flash(L.errorText("already_saved"), "alert"); paint(); return; }
        if (r.status !== 201 || !r.body || !r.body.question) { flash(L.errorText(r.body && r.body.error), "alert"); paint(); return; }
        decided(c.idx);
        if (!approve) { flash("Kept as a draft. Check it against the lesson, then approve it.", "ok"); reloadList(); paint(); return; }
        return send("PATCH", "/questions/" + r.body.question.id, { status: "approved" }).then(function (p) {
          if (p.status !== 200) { flash("Kept as a draft, but it could not be approved: " + L.errorText(p.body && p.body.error), "alert"); reloadList(); paint(); return; }
          return loadAll().then(function () { flash("Approved. It will be asked in the quiz.", "ok"); render(); });
        });
      });
    }

    function keepAll(open) {
      view.busy = true; paint();
      var chain = Promise.resolve(), kept = 0, problem = "";
      open.forEach(function (c) {
        chain = chain.then(function () {
          if (!alive() || problem) return;
          return send("POST", "/drafts/save", { id: view.job.id, idx: c.idx }).then(function (r) {
            if (r.status === 201) { kept++; decided(c.idx); }
            else if (r.body && r.body.error === "already_saved") decided(c.idx);
            else problem = (r.body && r.body.error) || "failed";
          });
        });
      });
      chain.then(function () {
        if (!alive()) return;
        view.busy = false;
        if (problem) flash((kept ? L.plural(kept, "question") + " kept as drafts, then it stopped: " : "") + L.errorText(problem === "failed" ? "" : problem), "alert");
        else flash("Kept as drafts. Check each against the lesson, then approve.", "ok");
        reloadList(); paint();
      });
    }

    function paint() {
      if (!alive()) return;
      clear(panel);
      panel.appendChild(h("h3", null, "Draft questions with the local model"));
      var job = view.job;
      var handled = (job && drafter.handled[job.id]) || {};
      var open = job ? L.openCandidates(view.candidates, view.questions, handled) : [];
      var finished = job && L.jobFinished(job);

      if (!job) {
        panel.appendChild(h("p", "dim small", "The model on app02 reads this lesson and suggests questions. You decide which to keep, and a kept question is a draft until you approve it. It is slow, about two to three minutes a question."));
        var st = L.draftStatusLine(view.status);
        panel.appendChild(h("p", "small ac-draftstatus " + st.tone, st.text));
        var row = h("div", "ac-drafter-row");
        var count = h("select"); count.setAttribute("aria-label", "How many questions");
        L.draftCounts(view.status && view.status.maxCount).forEach(function (n) { var o = h("option", null, n + (n === 1 ? " question" : " questions")); o.value = String(n); count.appendChild(o); });
        count.value = String(L.DRAFT_DEFAULT);
        row.appendChild(count);
        var go1 = btn("Draft questions", "btn-sm btn-primary", function () { start(parseInt(count.value, 10) || L.DRAFT_DEFAULT); });
        go1.disabled = !st.canStart || view.busy;
        row.appendChild(go1);
        row.appendChild(btn("Check again", "btn-sm btn-quiet", function () { loadStatus().then(paint); }));
        panel.appendChild(row);
        return;
      }

      // a job: its progress, then what has come back
      var top = h("div", "ac-drafter-row");
      top.appendChild(chip(finished ? (job.state === "error" ? "Stopped early" : "Finished") : "Working", finished ? (job.state === "error" ? "attn" : "ok") : "info"));
      top.appendChild(h("span", "small", L.draftProgress(job)));
      if (!finished) top.appendChild(btn(job.cancelling ? "Stopping…" : "Stop", "btn-sm btn-quiet", function () {
        send("POST", "/drafts/cancel", { id: job.id }).then(function (r) { if (!alive()) return; if (r.status !== 200) flash(L.errorText(r.body && r.body.error), "alert"); track(job.id); });
      }));
      panel.appendChild(top);
      if (!finished && job.total) { var bar = h("progress"); bar.max = job.total; bar.value = (job.done || 0) + (job.failed || 0); panel.appendChild(bar); }
      if (!finished) panel.appendChild(h("p", "dim small", "You can leave this page; the questions will be here when you come back."));

      var why = L.rejectedLine(view.rejected);
      if (why) panel.appendChild(h("p", "dim small", why));

      if (open.length) {
        var all = h("div", "ac-actions");
        all.appendChild(h("span", "small", L.plural(open.length, "question") + " to check"));
        var keepBtn = btn("Keep all as drafts", "btn-sm", function () { keepAll(open); }); keepBtn.disabled = view.busy; all.appendChild(keepBtn);
        panel.appendChild(all);
      }
      open.forEach(function (c) { panel.appendChild(candidateCard(c)); });
      if (finished && !open.length) panel.appendChild(h("p", "small", view.candidates.length ? "That is all of them. Kept questions are in the list below, waiting for your approval." : "No usable questions came back this time."));
      if (finished) {
        var end = h("div", "ac-actions");
        end.appendChild(btn(open.length ? "Discard the rest and close" : "Close", "btn-sm btn-quiet", forget));
        panel.appendChild(end);
      }
    }

    function candidateCard(c) {
      var q = c.question;
      if (view.editing === c.idx) {
        var f = questionForm(q, lesson, reloadList, {
          candidate: true,
          onKept: function () { decided(c.idx); view.editing = null; reloadList(); paint(); },
          onCancel: function () { view.editing = null; paint(); }
        });
        return f;
      }
      var card = h("div", "ac-q draft");
      var top = h("div", "ac-q-top");
      top.appendChild(h("b", null, q.prompt));
      var tags = h("span", "ac-q-tags");
      tags.appendChild(chip(L.KIND_LABELS[q.kind] || q.kind, ""));
      tags.appendChild(chip("Not saved yet", "attn"));
      top.appendChild(tags);
      card.appendChild(top);
      card.appendChild(candidateDetail(q));
      var actions = h("div", "ac-actions");
      var a1 = btn("Keep as draft", "btn-sm", function () { keep(c, false); });
      var a2 = btn("Approve", "btn-sm btn-primary", function () { keep(c, true); });
      a1.disabled = a2.disabled = view.busy;
      actions.appendChild(a2); actions.appendChild(a1);
      actions.appendChild(btn("Edit", "btn-sm", function () { view.editing = c.idx; paint(); }));
      actions.appendChild(btn("Discard", "btn-sm btn-quiet", function () {
        decided(c.idx); paint();
        if (!L.openCandidates(view.candidates, view.questions, drafter.handled[view.job.id]).length && L.jobFinished(view.job)) forget();
      }));
      card.appendChild(actions);
      return card;
    }

    resume();
    return { setQuestions: function (qs) { view.questions = qs; if (alive()) paint(); } };
  }

  function questionRow(q, lesson, reload) {
    var row = h("div", "ac-q" + (q.status === "draft" ? " draft" : ""));
    var top = h("div", "ac-q-top");
    top.appendChild(h("b", null, q.prompt));
    var tags = h("span", "ac-q-tags");
    tags.appendChild(chip(L.KIND_LABELS[q.kind] || q.kind, ""));
    tags.appendChild(chip(q.status === "draft" ? "Draft" : "Approved", q.status === "draft" ? "attn" : "ok"));
    if (q.by === "claude") tags.appendChild(chip("Drafted by Claude", "info"));
    top.appendChild(tags);
    row.appendChild(top);
    var detail = h("div", "small");
    if (q.kind === "choice") q.options.forEach(function (o, i) { detail.appendChild(h("div", i === q.answer ? "ac-right" : "", (i === q.answer ? "✔ " : "• ") + o)); });
    else if (q.kind === "truefalse") detail.appendChild(h("div", "ac-right", "✔ " + (q.answer ? "True" : "False")));
    else detail.appendChild(h("div", "ac-right", "✔ " + q.answers.join(" · ")));
    if (q.explanation) detail.appendChild(h("div", "dim", "Why: " + q.explanation));
    row.appendChild(detail);
    var actions = h("div", "ac-actions");
    if (q.status === "draft") {
      actions.appendChild(btn("Approve", "btn-sm btn-primary", function () { act(send("PATCH", "/questions/" + q.id, { status: "approved" }), function () { return loadAll().then(function () { flash("Approved. It will be asked in the quiz.", "ok"); render(); }); }); }));
    } else {
      actions.appendChild(btn("Take back to draft", "btn-sm btn-quiet", function () { act(send("PATCH", "/questions/" + q.id, { status: "draft" }), function () { return loadAll().then(render); }); }));
    }
    actions.appendChild(btn("Edit", "btn-sm", function () { var f = questionForm(q, lesson, reload); row.parentNode.replaceChild(f, row); }));
    actions.appendChild(confirmButton("Delete", "Delete this question?", function () { act(send("DELETE", "/questions/" + q.id), function () { return loadAll().then(function () { flash("Question deleted.", "ok"); render(); }); }); }));
    row.appendChild(actions);
    return row;
  }

  // One form for a new question or an edit (q given). The fields shown follow the kind.
  // `q` is a saved question to edit, or (with opts.candidate) a drafted one not saved yet: keeping it saves it as a DRAFT, and opts.onKept /
  // opts.onCancel say what the drafting panel does next.
  function questionForm(q, lesson, reload, opts) {
    var candidate = !!(opts && opts.candidate);
    var saved = !!(q && q.id);
    var form = h("form", "ac-qform");
    form.appendChild(h("h4", null, candidate ? "Edit before keeping" : q ? "Edit the question" : "Add a question"));
    var start = q ? L.formFromQuestion(q) : { kind: "choice", prompt: "", explanation: "", optionsText: "", answerIndex: 0, truth: true, answersText: "" };
    var kind = h("select");
    ["choice", "truefalse", "short"].forEach(function (k) { var o = h("option", null, L.KIND_LABELS[k]); o.value = k; kind.appendChild(o); });
    kind.value = start.kind; kind.disabled = !!q;
    var prompt = area(start.prompt, 2, 300);
    var optionsText = area(start.optionsText, 4, 800), answerIndex = input(String(start.answerIndex + 1), 2);
    var truth = h("select");
    [["true", "True"], ["false", "False"]].forEach(function (p) { var o = h("option", null, p[1]); o.value = p[0]; truth.appendChild(o); });
    truth.value = start.truth ? "true" : "false";
    var answersText = area(start.answersText, 3, 500);
    var explanation = input(start.explanation, 300);
    var kindWrap = h("div"), choiceWrap = h("div"), tfWrap = h("div"), shortWrap = h("div");
    form.appendChild(field("Kind", kind));
    form.appendChild(field("Question", prompt));
    choiceWrap.appendChild(field("Options", optionsText, "One per line, 2 to 6."));
    choiceWrap.appendChild(field("Which one is right? (its number)", answerIndex));
    tfWrap.appendChild(field("The answer is", truth));
    shortWrap.appendChild(field("Accepted answers", answersText, "One per line. Capitals, accents and punctuation are ignored."));
    form.appendChild(choiceWrap); form.appendChild(tfWrap); form.appendChild(shortWrap); form.appendChild(kindWrap);
    form.appendChild(field("Why (shown after answering)", explanation, "Optional."));
    function show() { choiceWrap.hidden = kind.value !== "choice"; tfWrap.hidden = kind.value !== "truefalse"; shortWrap.hidden = kind.value !== "short"; }
    kind.addEventListener("change", show); show();
    var save = btn(candidate ? "Keep as draft" : q ? "Save question" : "Add question", "btn-sm btn-primary", null); save.type = "submit";
    form.appendChild(save);
    if (q) form.appendChild(btn("Cancel", "btn-sm btn-quiet", candidate && opts.onCancel ? opts.onCancel : reload));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var made = L.questionBody({
        kind: kind.value, prompt: prompt.value, explanation: explanation.value, optionsText: optionsText.value,
        answerIndex: (parseInt(answerIndex.value, 10) || 0) - 1, truth: truth.value === "true", answersText: answersText.value
      });
      if (made.error) { flash(L.errorText(made.error), "alert"); return; }
      var body = made.body;
      if (saved) delete body.kind;
      if (candidate) body.status = "draft";   // you edited it, but you have not approved it yet
      save.disabled = true;
      act(saved ? send("PATCH", "/questions/" + q.id, body) : send("POST", "/lessons/" + lesson.id + "/questions", body), function () {
        if (candidate) { flash("Kept as a draft. Check it against the lesson, then approve it.", "ok"); return opts.onKept(); }
        return loadAll().then(function () { flash(q ? "Saved." : "Question added.", "ok"); render(); });
      }).then(function () { save.disabled = false; });
    });
    return form;
  }

  // ---- quizzes and review -----------------------------------------------------------------------------------------------------

  function startQuiz(scope, name) {
    var qs = scope.lesson ? "lesson=" + scope.lesson : "course=" + scope.course;
    send("GET", "/quiz?" + qs).then(function (r) {
      var box = $("ac-quizbox");
      if (!box) return;
      if (r.status !== 200 || !r.body || !r.body.questions) { flash(L.errorText(r.body && r.body.error), "alert"); return; }
      runQuiz(box, {
        title: (scope.lesson ? "Quiz: " : "Final check: ") + name, questions: r.body.questions,
        grade: function (answers) { return send("POST", "/quiz/grade", scope.lesson ? { lessonId: scope.lesson, answers: answers } : { courseId: scope.course, answers: answers }); },
        again: function () { startQuiz(scope, name); }
      });
    });
  }

  // Draws the questions with an answer control each; on submit asks the Worker to grade and shows what was right.
  function runQuiz(box, opts) {
    clear(box);
    var card = h("form", "ac-card ac-quiz");
    card.appendChild(h("h2", null, opts.title));
    var controls = {};
    opts.questions.forEach(function (q, n) {
      var item = h("fieldset", "ac-qitem");
      item.appendChild(h("legend", null, (n + 1) + ". " + q.prompt));
      if (q.kind === "short") {
        var t = input("", 160); t.setAttribute("aria-label", "Your answer");
        controls[q.id] = function () { return t.value; };
        item.appendChild(t);
      } else {
        var options = q.kind === "truefalse" ? ["True", "False"] : q.options;
        options.forEach(function (label, i) {
          var l = h("label", "ac-opt");
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
      item.appendChild(h("div", "ac-feedback small")).setAttribute("data-for", q.id);
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
      opts.grade(answers).then(function (r) {
        if (r.status !== 200 || !r.body || r.body.ok !== true) { submit.disabled = false; flash(L.errorText(r.body && r.body.error), "alert"); return; }
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
      fb.className = "ac-feedback small " + (r.right ? "ok" : "alert");
      fb.appendChild(h("b", null, L.resultText(byId[r.id], r)));
      if (r.explanation) fb.appendChild(h("div", "dim", r.explanation));
    });
    Array.prototype.forEach.call(card.querySelectorAll("input"), function (i) { i.disabled = true; });
    var old = card.querySelector('button[type="submit"]'); if (old) old.remove();
    var sum = h("div", "ac-banner " + (res.passed ? "ok" : "attn"));
    sum.appendChild(h("b", null, L.scoreText(res.right, res.total) + (res.passed ? ": passed" : ": keep going")));
    sum.appendChild(h("span", null, res.passed ? "Missed questions come back in the review tomorrow." : "Read the lesson again, then try again. Missed questions come back in the review tomorrow."));
    card.appendChild(sum);
    var actions = h("div", "ac-actions");
    if (opts.again) actions.appendChild(btn("Try again", "btn-sm btn-primary", opts.again));
    actions.appendChild(btn("Done", "btn-sm", function () { loadAll().then(render); }));
    card.appendChild(actions);
    card.scrollIntoView({ block: "start" });
  }

  function drawReview(root) {
    root.appendChild(link("← All courses", "#/", "ac-back"));
    var box = h("div", "ac-quizbox");
    root.appendChild(box);
    box.appendChild(h("p", "dim", "Loading the review…"));
    send("GET", "/review").then(function (r) {
      clear(box);
      if (r.status !== 200 || !r.body || !r.body.questions) { box.appendChild(h("p", null, L.errorText(r.body && r.body.error))); return; }
      if (!r.body.questions.length) {
        var none = h("div", "ac-card");
        none.appendChild(h("h2", null, "Nothing is due"));
        none.appendChild(h("p", "dim", "Questions join the review the first time you answer them in a quiz. A miss comes back tomorrow; a right answer comes back after a longer wait each time."));
        box.appendChild(none);
        return;
      }
      runQuiz(box, {
        title: "Review", questions: r.body.questions,
        grade: function (answers) { return send("POST", "/review/grade", { answers: answers }); },
        again: function () { loadAll().then(function () { render(); }); }
      });
    });
  }

  function drawRecords(root) {
    root.appendChild(link("← All courses", "#/", "ac-back"));
    var card = h("div", "ac-card");
    card.appendChild(h("h2", null, "Completion records"));
    root.appendChild(card);
    send("GET", "/records").then(function (r) {
      if (r.status !== 200 || !r.body || !r.body.records) { card.appendChild(h("p", null, L.errorText(r.body && r.body.error))); return; }
      if (!r.body.records.length) { card.appendChild(h("p", "dim", "Every quiz and review you finish is recorded here, with its date and score.")); return; }
      var wrap = h("div", "ac-table-wrap"), table = h("table", "ac-table");
      var thead = h("thead"), hr = h("tr");
      ["Date", "What", "Score"].forEach(function (c) { hr.appendChild(h("th", null, c)); });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = h("tbody");
      r.body.records.forEach(function (x) {
        var tr = h("tr");
        tr.appendChild(h("td", "mono", L.dateText(x.at)));
        var what = x.mode === "review" ? "Review" : x.mode === "course" ? "Final check: " + (x.courseTitle || "a deleted course") : "Quiz: " + (x.lessonTitle || "a deleted lesson");
        tr.appendChild(h("td", null, what));
        var sc = h("td"); sc.appendChild(chip(L.scoreText(x.right, x.total), x.passed ? "ok" : "attn"));
        tr.appendChild(sc);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody); wrap.appendChild(table); card.appendChild(wrap);
    });
  }

  // ---- invite links and learners -----------------------------------------------------------------------------------------------
  //
  // GET|POST /academy/invites, POST /academy/invites/<id>/revoke, GET /academy/learners[?course=], GET|DELETE /academy/learners/<id>.
  // A learner opens the link on learn.html with no login; they give a name and the Worker keeps what they read and score.

  function copyText(text, done) {
    var ok = function () { done(true); }, no = function () { done(false); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, no); else no();
  }

  // One learner's row for the owner: name, how far, last seen, and the buttons. `after` redraws the surrounding list.
  function learnerRow(l, after, showCourse) {
    var tr = h("tr");
    tr.appendChild(h("td", null, l.name));
    if (showCourse) {
      var cell = h("td");
      cell.appendChild(link(l.courseTitle || "a deleted course", "#/c/" + l.courseId, ""));
      tr.appendChild(cell);
    }
    var st = L.learnerStatus(l), sc = h("td");
    sc.appendChild(chip(st.text, st.tone));
    tr.appendChild(sc);
    tr.appendChild(h("td", "dim small", l.lastAt ? L.agoText(l.lastAt) : ""));
    var act1 = h("td");
    var detail = btn("Details", "btn-sm btn-quiet", function () { toggleDetail(tr, l, showCourse ? 5 : 4); });
    act1.appendChild(detail);
    act1.appendChild(confirmButton("Forget", "Forget " + l.name + " and their records?", function () {
      act(send("DELETE", "/learners/" + l.id + "?confirm=1"), function () { return loadAll().then(function () { flash("Forgotten.", "ok"); after(); }); });
    }, "Yes, forget"));
    tr.appendChild(act1);
    return tr;
  }

  // A learner's own lines (per lesson, then every quiz they took) under their row.
  function toggleDetail(tr, l, span) {
    var next = tr.nextSibling;
    if (next && next.getAttribute && next.getAttribute("data-detail") === l.id) { next.remove(); return; }
    var row = h("tr"); row.setAttribute("data-detail", l.id);
    var cell = h("td"); cell.colSpan = span;
    cell.appendChild(h("p", "dim small", "Loading…"));
    row.appendChild(cell);
    tr.parentNode.insertBefore(row, tr.nextSibling);
    send("GET", "/learners/" + l.id).then(function (r) {
      clear(cell);
      if (r.status !== 200 || !r.body || !r.body.lessons) { cell.appendChild(h("p", null, L.errorText(r.body && r.body.error))); return; }
      var ul = h("ul", "ac-detail");
      r.body.lessons.forEach(function (x) {
        var li = h("li");
        li.appendChild(h("b", null, x.title + " "));
        li.appendChild(chip(x.doneAt ? "Read " + L.dateText(x.doneAt) : "Not read", x.doneAt ? "ok" : ""));
        if (x.quiz) li.appendChild(chip(x.attempts ? "Best " + x.bestPercent + "% in " + L.plural(x.attempts, "try", "tries") : "Quiz not taken", x.attempts && x.bestPercent >= 70 ? "ok" : "attn"));
        ul.appendChild(li);
      });
      cell.appendChild(ul);
      if (r.body.attempts.length) {
        cell.appendChild(h("p", "dim small", "Quizzes taken: " + r.body.attempts.slice(0, 8).map(function (a) {
          return (a.mode === "course" ? "final check" : a.lessonTitle || "a lesson") + " " + a.percent + "% (" + L.dateText(a.at) + ")";
        }).join(", ") + (r.body.attempts.length > 8 ? ", and " + (r.body.attempts.length - 8) + " more" : "")));
      }
    });
  }

  function learnersTable(learners, after, showCourse) {
    var wrap = h("div", "ac-table-wrap"), table = h("table", "ac-table");
    var thead = h("thead"), hr = h("tr");
    (showCourse ? ["Name", "Course", "Progress", "Last seen", ""] : ["Name", "Progress", "Last seen", ""]).forEach(function (c) { hr.appendChild(h("th", null, c)); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = h("tbody");
    learners.forEach(function (l) { tbody.appendChild(learnerRow(l, after, showCourse)); });
    table.appendChild(tbody); wrap.appendChild(table);
    return wrap;
  }

  // On a course's page: make and revoke invite links, and see who joined.
  function inviteCard(c) {
    var card = h("div", "ac-card");
    card.appendChild(h("h2", null, "Invite learners"));
    card.appendChild(h("p", "dim", "Send a link and anyone holding it can take this course without signing in. They give a name, read the lessons and take the quizzes; you see who finished. A link always expires, and you can switch it off at any time."));
    var body = h("div", "ac-invites");
    card.appendChild(body);

    function load() {
      clear(body);
      body.appendChild(h("p", "dim", "Loading…"));
      Promise.all([send("GET", "/invites?course=" + c.id), send("GET", "/learners?course=" + c.id)]).then(function (rs) {
        clear(body);
        if (rs[0].status !== 200 || !rs[0].body || !rs[0].body.invites) { body.appendChild(h("p", null, L.errorText(rs[0].body && rs[0].body.error))); return; }
        var enabled = rs[0].body.enabled;
        if (!enabled) body.appendChild(h("p", "ac-banner attn", L.errorText("invites_disabled")));
        else body.appendChild(inviteForm());
        var invites = rs[0].body.invites;
        if (invites.length) {
          var list = h("ul", "ac-invite-list");
          invites.forEach(function (inv) { list.appendChild(inviteRow(inv)); });
          body.appendChild(list);
        }
        var learners = rs[1].status === 200 && rs[1].body && rs[1].body.learners ? rs[1].body.learners : [];
        if (learners.length) {
          body.appendChild(h("h3", null, "Who has done what"));
          body.appendChild(learnersTable(learners, load, false));
        } else if (invites.length) {
          body.appendChild(h("p", "dim small", "Nobody has joined yet."));
        }
      });
    }

    function inviteForm() {
      var form = h("form", "ac-form");
      var label = input("", 60); label.placeholder = "For example: Committee 2026";
      form.appendChild(field("Who is it for?", label, "Optional. Shown to learners and to you."));
      var days = h("select");
      L.INVITE_DAYS.forEach(function (d) { var o = h("option", null, d.text); o.value = String(d.days); if (d.days === L.INVITE_DEFAULT_DAYS) o.selected = true; days.appendChild(o); });
      form.appendChild(field("The link works for", days));
      var go1 = btn("Make a link", "btn-primary", null); go1.type = "submit";
      form.appendChild(go1);
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        go1.disabled = true;
        act(send("POST", "/invites", { courseId: c.id, label: label.value.trim(), days: parseInt(days.value, 10) }), function () {
          return loadAll().then(function () { flash("Link made. Copy it and send it.", "ok"); load(); });
        }).then(function () { go1.disabled = false; });
      });
      return form;
    }

    function inviteRow(inv) {
      var li = h("li", "ac-invite " + inv.status);
      var top = h("div", "ac-invite-top");
      top.appendChild(h("b", null, inv.label || "Invite link"));
      top.appendChild(chip(inv.status === "live" ? "Works" : inv.status === "expired" ? "Expired" : "Switched off", L.inviteTone(inv)));
      li.appendChild(top);
      li.appendChild(h("div", "dim small", L.inviteLine(inv, Date.now())));
      if (inv.status === "live") {
        var url = L.learnUrl(inv.token);
        var shown = h("input"); shown.type = "text"; shown.readOnly = true; shown.value = url; shown.className = "ac-url"; shown.setAttribute("aria-label", "The link to send");
        shown.addEventListener("focus", function () { shown.select(); });
        li.appendChild(shown);
        var acts = h("div", "ac-actions");
        var copy = btn("Copy link", "btn-sm btn-primary", function () {
          copyText(url, function (ok) { copy.textContent = ok ? "Copied" : "Press Ctrl+C"; if (!ok) shown.select(); setTimeout(function () { copy.textContent = "Copy link"; }, 2500); });
        });
        acts.appendChild(copy);
        acts.appendChild(confirmButton("Switch off", "Stop this link working now? People who joined keep their records.", function () {
          act(send("POST", "/invites/" + inv.id + "/revoke", {}), function () { return loadAll().then(function () { flash("Link switched off.", "ok"); load(); }); });
        }, "Yes, switch off"));
        li.appendChild(acts);
      }
      return li;
    }

    load();
    return card;
  }

  // All learners across every course.
  function drawLearners(root) {
    root.appendChild(link("← All courses", "#/", "ac-back"));
    var card = h("div", "ac-card");
    card.appendChild(h("h2", null, "Learners"));
    card.appendChild(h("p", "dim", "Everyone who joined a course through an invite link, and how far they have got. Make links on a course's own page."));
    root.appendChild(card);
    var box = h("div"); card.appendChild(box);
    function load() {
      clear(box);
      box.appendChild(h("p", "dim", "Loading…"));
      send("GET", "/learners").then(function (r) {
        clear(box);
        if (r.status !== 200 || !r.body || !r.body.learners) { box.appendChild(h("p", null, L.errorText(r.body && r.body.error))); return; }
        if (!r.body.learners.length) { box.appendChild(h("p", "dim", "Nobody has joined yet.")); return; }
        box.appendChild(learnersTable(r.body.learners, function () { load(); }, true));
      });
    }
    load();
  }

  // ---- start ----------------------------------------------------------------------------------------------------------------

  window.addEventListener("hashchange", function () {
    if (model.keepFlash) model.keepFlash = false; else model.flash = null;
    render();
  });
  render();
  loadAll().then(render);
})();
