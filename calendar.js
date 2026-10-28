// The Calendar page (calendar.html): the owner's daily planner. To-dos, their own events, renewals (secrets, keys, tokens,
// the domain ...) and the Ops items with a Due date, on one calendar.
//
// Reads (all owner only; see ClaudeRepo's cloudflare-worker README):
//   GET /hub/renewals   renewals (Ops board items with the target "renewal", and keys that expire) and dueItems (other dated Ops items)
//   GET /planner/all    the owner's to-dos and own events
// Writes: /planner/* for to-dos and events; a renewal is an Ops board item, written through the Ops board's own API (/ops/items).
//
// Where the data lives: to-dos and events in the Planner Durable Object on Cloudflare, renewals in the Ops board's Durable
// Object; both are server-side, so clearing this browser loses nothing, and both are in the hub's backup (GET /hub/export).
// Browser-only, and said so on the page: the last view and renewal filter (barnyard-calendar-prefs) and a copy of the lists
// (barnyard-calendar-cache) that lets the page open at once while the server answers.
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles. The rules (dates, repeats, grouping, the .ics file, form checks) are in
// calendar-logic.js, which test/calendar.test.js covers.

(function () {
  "use strict";
  if (typeof document === "undefined" || !window.BarnyardCalendarLogic) return;
  var L = window.BarnyardCalendarLogic;

  var HUB_API = "https://api.barnyard.site/hub";
  var PLAN_API = "https://api.barnyard.site/planner";
  var OPS_API = "https://api.barnyard.site/ops";
  var POLL_MS = 120000;
  var PREF_KEY = "barnyard-calendar-prefs";
  var CACHE_KEY = "barnyard-calendar-cache";
  var GOOGLE_API = "https://api.barnyard.site/calendar";
  var ACTIVE_VIEWS = L.VIEWS;

  // `google` is the owner's Google Calendar (read only, from the Worker's /calendar; it sends about 8 days back and 90 ahead).
  // It is never kept in this browser: it is fetched fresh each time.
  var model = {
    state: "loading", planner: "loading", renewals: [], dueItems: [], tasks: [], events: [], google: [], googleState: "loading", partial: false, fromCache: false,
    view: "today", kind: "all", month: null, weekOf: null,
    plan: null            // the day planner's settings, accepted blocks, timer and learned ratios (from GET /planner/all); see plan-view.js
  };
  var lastFocus = null;
  var toastTimer = null;

  // ---- storage in this browser (only a speed copy and two preferences) -------------------

  function readPrefs() {
    try {
      var p = JSON.parse(window.localStorage.getItem(PREF_KEY) || "{}");
      var map = { next: "upcoming", nodate: "renewals" };
      var v = map[p.view] || p.view;
      if (ACTIVE_VIEWS.some(function (x) { return x[0] === v; })) model.view = v;
      if (p.kind === "all" || L.KINDS.some(function (k) { return k[0] === p.kind; })) model.kind = p.kind;
    } catch (e) { /* no stored preference, or storage is off: the defaults are fine */ }
  }
  function savePrefs() {
    try { window.localStorage.setItem(PREF_KEY, JSON.stringify({ view: model.view, kind: model.kind })); } catch (e) { /* fine without it */ }
  }
  function readCache() {
    try {
      var c = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "null");
      if (!c || !Array.isArray(c.renewals) || !Array.isArray(c.tasks)) return false;
      model.renewals = c.renewals; model.dueItems = c.dueItems || []; model.tasks = c.tasks; model.events = c.events || [];
      model.fromCache = true;
      return true;
    } catch (e) { return false; }
  }
  function writeCache() {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({ renewals: model.renewals, dueItems: model.dueItems, tasks: model.tasks, events: model.events, at: Date.now() }));
    } catch (e) { /* too big or storage off: the server copy is the real one */ }
  }

  // ---- data from the server ---------------------------------------------------------------

  function getJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(url, { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) return { status: r.status };
      return r.json().then(function (d) { return { status: 200, data: d }; });
    }, function () { clearTimeout(timer); return { status: 0 }; });
  }

  function load() {
    return Promise.all([getJson(HUB_API + "/renewals"), getJson(PLAN_API + "/all"), getJson(GOOGLE_API)]).then(function (res) {
      var a = res[0], b = res[1], g = res[2];
      if (g.status === 200 && Array.isArray(g.data)) { model.google = g.data; model.googleState = "ok"; }
      else model.googleState = g.status === 500 ? "off" : "error";   // 500 is the Worker saying no calendar feed is set up
      if (a.status === 401 || b.status === 401) { model.state = "guest"; return; }
      if (a.status === 403 || b.status === 403) { model.state = "forbidden"; return; }
      var haveData = model.renewals.length || model.tasks.length || model.events.length;
      if (a.status === 200) {
        model.renewals = Array.isArray(a.data.renewals) ? a.data.renewals : [];
        model.dueItems = Array.isArray(a.data.dueItems) ? a.data.dueItems : [];
        model.partial = !!a.data.partial;
      }
      if (b.status === 200) {
        model.tasks = Array.isArray(b.data.tasks) ? b.data.tasks : [];
        model.events = Array.isArray(b.data.events) ? b.data.events : [];
        if (b.data.plan && typeof b.data.plan === "object") model.plan = b.data.plan;
        model.planner = "ok";
      } else model.planner = b.status === 503 || b.status === 404 ? "unavailable" : "error";
      if (a.status !== 200 && b.status !== 200) { model.state = haveData ? "ok" : "error"; return; }
      model.state = "ok";
      model.fromCache = false;
      writeCache();
    }).then(render);
  }

  function request(base, method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) };
    return fetch(base + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) { var err = new Error((data && data.error) || "request_failed"); err.code = (data && data.error) || null; err.field = (data && data.field) || null; err.kind = (data && data.kind) || null; throw err; }
        return data;
      });
    });
  }
  function plan(path, body) { return request(PLAN_API, "POST", path, Object.assign({ today: today() }, body)); }

  var MESSAGES = {
    secret_detected: "That looks like a secret or a key, and it won’t be stored. Describe where it lives instead of pasting it.",
    recent_sign_in_required: "Sign in again to do that, then try once more.",
    unauthenticated: "You’re not signed in, so nothing was changed.", forbidden: "You’re not signed in as the owner, so nothing was changed.",
    tasks_full: "The to-do list is full (3,000). Clear the ticked ones first.", events_full: "There are too many events stored (1,500).",
    not_found: "That has already gone. Refresh the page.", today_invalid: "This computer’s date is far from the server’s, so the change wasn’t made.",
    timer_busy: "Another focus timer is running. Finish or cancel it first.", no_timer: "There is no timer running.",
    block_started: "That block has already started or finished, so it can’t be changed.", blocks_full: "There are too many planned blocks stored. Delete some old ones.",
    task_not_open: "One of those to-dos was ticked off or deleted. Plan again.", estimate_invalid: "Give the estimate in minutes, from 0 to 720.",
    minutes_invalid: "Give the time in whole minutes, from 1 to 720.", blocks_invalid: "That plan is too big to accept at once. Plan a shorter period."
  };
  function say(err) { return MESSAGES[err.code] || "Couldn’t save that just now. Nothing was changed."; }

  // ---- little DOM helpers -----------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function today() { return L.ymd(new Date()); }
  function data() { return { renewals: model.renewals, dueItems: model.dueItems, tasks: model.tasks, events: model.events, google: model.google }; }

  function toast(text, undoLabel, onUndo) {
    var box = $("cal-toast");
    clear(box);
    box.hidden = false;
    box.appendChild(h("span", null, text));
    if (onUndo) {
      var b = h("button", "btn btn-sm", undoLabel || "Undo");
      b.type = "button";
      b.addEventListener("click", function () { box.hidden = true; onUndo(); });
      box.appendChild(b);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 9000);
  }

  function message(text, linkText, href) {
    var box = $("cal-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function chip(text, cls) { return h("span", "chip" + (cls ? " " + cls : ""), text); }

  // ---- rows -------------------------------------------------------------------------------

  function refChip(ref) {
    if (!ref) return null;
    var a = h("a", "chip cal-ref", ref.kind === "ops" ? "Ops item" : "Article");
    a.href = L.refHref(ref);
    if (ref.kind === "kb") { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }

  // One row for an entry of any kind. A to-do has its tick box, an event its time, a renewal its kind and how sure the date is.
  function row(e, t) {
    var tone = L.urgency(e, t);
    var el = h("div", "cal-row t-" + e.type + (e.type === "task" && e.ref.status === "done" ? " is-done" : ""));
    if (e.type === "task") {
      var cb = h("input", "cal-check");
      cb.type = "checkbox";
      cb.checked = e.ref.status === "done";
      cb.setAttribute("aria-label", (cb.checked ? "Mark not done: " : "Mark done: ") + e.label);
      cb.addEventListener("change", function () { tick(e.ref, cb.checked); });
      el.appendChild(cb);
    } else el.appendChild(h("span", "cal-dot" + (tone ? " " + tone : "")));
    var main = h(e.type === "item" ? "a" : "button", "cal-main");
    if (e.type === "item") main.href = e.ref.href || "ops.html"; else main.type = "button";
    main.appendChild(h("b", null, e.label));
    el.appendChild(main);
    if (e.type === "event") el.appendChild(chip("Event"));
    if (e.type === "gcal") el.appendChild(chip("Google Calendar"));
    if (e.type === "item") el.appendChild(chip("Ops item"));
    if (e.type === "renewal") { el.appendChild(chip(L.kindTitle(e.kind))); var bd = L.STATE_BADGE[e.state]; if (bd) el.appendChild(chip(bd)); }
    if (e.type === "task") {
      if (e.ref.priority === "high") el.appendChild(chip("High", "alert"));
      if (e.ref.estimate) el.appendChild(chip(e.ref.estimate + " min"));
      if (e.ref.recur) el.appendChild(chip(L.repeatText(e.ref.recur)));
      var rc = refChip(e.ref.ref);
      if (rc) el.appendChild(rc);
    }
    var when;
    if (e.type === "event") when = L.shortDate(e.due) + ", " + L.eventTimeText(e.ref.day, e.ref.event);
    else if (e.type === "gcal") when = L.shortDate(e.due) + ", " + (e.allDay ? "All day" : L.timeText(e.time) + (e.endTime ? " to " + L.timeText(e.endTime) : ""));
    else if (e.type === "task") when = L.taskDueText(e.ref, t);
    else when = L.longDate(e.due) + " · " + L.relativeText(L.daysBetween(t, e.due));
    el.appendChild(h("span", "dim cal-when" + (tone === "alert" && e.type !== "renewal" ? " late" : ""), when));
    if (e.type === "task" && e.ref.status === "open" && isYmd(e.ref.due) && e.ref.due <= t) {
      var sn = h("button", "btn btn-sm btn-quiet", e.ref.due < t ? "To today" : "Tomorrow");
      sn.type = "button";
      sn.addEventListener("click", function () { snooze(e.ref, e.ref.due < t ? "today" : "tomorrow"); });
      el.appendChild(sn);
    }
    if (e.type !== "item") main.addEventListener("click", function () { openEntry(e); });
    return el;
  }
  function isYmd(s) { return L.isYmd(s); }

  function taskEntry(t) { return { type: "task", id: t.id, label: t.title, due: t.due, time: t.time, ref: t, kind: "", state: "known" }; }

  function section(title, note) {
    var s = h("section", "cal-section");
    var head = h("div", "sec-head");
    head.appendChild(h("h2", null, title));
    if (note) head.appendChild(h("span", "sub", note));
    s.appendChild(head);
    return s;
  }
  function list(entries, t) {
    var box = h("div", "cal-list");
    entries.forEach(function (e) { box.appendChild(row(e, t)); });
    return box;
  }

  // ---- views ------------------------------------------------------------------------------

  function renderToday(root, t) {
    var a = L.agenda(data(), t, model.kind);
    var inbox = model.tasks.filter(function (x) { return x.status === "open" && !x.due; });
    root.appendChild(h("p", "cal-lead", "Today is " + L.longDate(t) + "."));
    if (a.overdue.length) { var o = section("Overdue", "past their date; nothing moves unless you move it"); o.appendChild(list(a.overdue, t)); root.appendChild(o); }
    var td = section("Today");
    if (a.today.length) td.appendChild(list(a.today, t)); else td.appendChild(h("p", "dim", "Nothing is on for today."));
    root.appendChild(td);
    var wk = section("The next 7 days");
    if (a.week.length) wk.appendChild(list(a.week, t)); else wk.appendChild(h("p", "dim", "Nothing falls in the next week."));
    root.appendChild(wk);
    if (inbox.length && model.planner === "ok") {
      var ib = section("Inbox", inbox.length + (inbox.length === 1 ? " to-do with no date" : " to-dos with no date"));
      ib.appendChild(list(inbox.slice(0, 5).map(taskEntry), t));
      if (inbox.length > 5) { var all = h("button", "btn btn-sm", "See all " + inbox.length); all.type = "button"; all.addEventListener("click", function () { setView("todos"); }); ib.appendChild(all); }
      root.appendChild(ib);
    }
    var nd = model.renewals.filter(function (r) { return r.state === "needed"; }).length;
    if (nd) {
      var p = h("p", "dim", nd + (nd === 1 ? " renewal still needs a date. " : " renewals still need a date. "));
      var b = h("button", "btn btn-sm", "See them");
      b.type = "button";
      b.addEventListener("click", function () { setView("renewals"); });
      p.appendChild(b);
      root.appendChild(p);
    }
  }

  // The week (Monday to Sunday) as seven days, each with everything on it. On a phone the days stack.
  function renderWeek(root, t) {
    var w = L.weekDays(model.weekOf || t);
    var map = L.entriesByDate(data(), w.days[0], w.days[6], model.kind);
    var title = h("h2", "cal-month-title", w.label);
    title.id = "cal-week-title";
    root.appendChild(title);
    var grid = h("div", "cal-week");
    grid.setAttribute("aria-labelledby", "cal-week-title");
    w.days.forEach(function (date) {
      var col = h("section", "cal-wday" + (date === t ? " today" : "") + (date < t ? " past" : ""));
      var head = h("button", "cal-wday-head");
      head.type = "button";
      head.appendChild(h("b", null, L.DAY_NAMES[L.weekday(date)]));
      head.appendChild(h("span", "dim", " " + date.slice(8).replace(/^0/, "") + " " + L.MONTH_NAMES[+date.slice(5, 7) - 1].slice(0, 3)));
      head.setAttribute("aria-label", "Open " + L.longDate(date));
      head.addEventListener("click", function () { openDay(date); });
      col.appendChild(head);
      var es = map[date] || [];
      if (!es.length) col.appendChild(h("p", "dim cal-wday-empty", "Nothing on."));
      es.forEach(function (e) { col.appendChild(weekItem(e, t)); });
      grid.appendChild(col);
    });
    root.appendChild(grid);
  }

  // One compact line in the week: the time, the title and (for to-dos) a tick box.
  function weekItem(e, t) {
    var tone = L.urgency(e, t);
    var el = h("div", "cal-witem t-" + e.type + (tone ? " " + tone : "") + (e.type === "task" && e.ref.status === "done" ? " is-done" : ""));
    if (e.type === "task") {
      var cb = h("input", "cal-check");
      cb.type = "checkbox";
      cb.checked = e.ref.status === "done";
      cb.setAttribute("aria-label", "Mark done: " + e.label);
      cb.addEventListener("change", function () { tick(e.ref, cb.checked); });
      el.appendChild(cb);
    }
    var main = h(e.type === "item" ? "a" : "button", "cal-main");
    if (e.type === "item") main.href = e.ref.href || "ops.html"; else { main.type = "button"; main.addEventListener("click", function () { openEntry(e); }); }
    if (e.time && !e.allDay) main.appendChild(h("span", "cal-wtime", L.timeText(e.time)));
    main.appendChild(h("span", null, e.label));
    main.setAttribute("title", typeName(e));
    el.appendChild(main);
    return el;
  }

  function renderMonth(root, t) {
    var m = model.month;
    var grid = L.monthGrid(m.year, m.month);
    var first = grid.weeks[0][0].date, last = grid.weeks[grid.weeks.length - 1][6].date;
    var map = L.entriesByDate(data(), first, last, model.kind);
    var title = h("h2", "cal-month-title", grid.label);
    title.id = "cal-month-title";
    root.appendChild(title);
    var scroll = h("div", "cal-scroll");
    var table = h("table", "cal-month");
    table.setAttribute("aria-labelledby", "cal-month-title");
    var thead = h("thead"), hr = h("tr");
    L.DAY_NAMES.forEach(function (n) { var th = h("th", null, n); th.scope = "col"; hr.appendChild(th); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = h("tbody");
    grid.weeks.forEach(function (week) {
      var tr = h("tr");
      week.forEach(function (c) {
        var td = h("td", "cal-day" + (c.inMonth ? "" : " out") + (c.date === t ? " today" : ""));
        var num = h("button", "cal-num", String(c.day));
        num.type = "button";
        num.setAttribute("aria-label", "Open " + L.longDate(c.date));
        num.addEventListener("click", function () { openDay(c.date); });
        td.appendChild(num);
        var es = map[c.date] || [];
        es.slice(0, 3).forEach(function (e) {
          var tone = L.urgency(e, t);
          var el = e.type === "item" ? h("a", "cal-ev t-item") : h("button", "cal-ev t-" + e.type + (tone ? " " + tone : "") + (e.type === "task" && e.ref.status === "done" ? " is-done" : ""));
          if (e.type === "item") el.href = e.ref.href || "ops.html"; else el.type = "button";
          el.textContent = (e.time && !e.allDay ? L.timeText(e.time) + " " : "") + e.label;
          el.setAttribute("aria-label", L.longDate(c.date) + ": " + e.label + " (" + typeName(e) + ")");
          if (e.type !== "item") el.addEventListener("click", function () { openEntry(e); });
          td.appendChild(el);
        });
        if (es.length > 3) {
          var more = h("button", "cal-more", "+" + (es.length - 3) + " more");
          more.type = "button";
          more.addEventListener("click", function () { openDay(c.date); });
          td.appendChild(more);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    root.appendChild(scroll);
  }
  function typeName(e) { return e.type === "task" ? "to-do" : e.type === "item" ? "Ops item" : e.type === "event" ? "event" : e.type === "gcal" ? "Google Calendar event" : L.kindTitle(e.kind).toLowerCase() + " renewal"; }

  function renderUpcoming(root, t) {
    var groups = L.upcoming(data(), t, 120, model.kind);
    var over = L.agenda(data(), t, model.kind).overdue;
    if (over.length) { var o = section("Overdue"); o.appendChild(list(over, t)); root.appendChild(o); }
    if (!groups.length && !over.length) { root.appendChild(h("p", "dim", "Nothing is coming up in the next four months.")); return; }
    groups.forEach(function (g) {
      var s = section(g.title);
      s.appendChild(list(g.entries, t));
      root.appendChild(s);
    });
    root.appendChild(h("p", "dim", "This shows the next four months. The Renewals view shows every renewal, however far off."));
  }

  function renderTodos(root, t) {
    if (model.planner === "unavailable") { root.appendChild(h("p", "dim", "To-dos aren’t switched on yet on the server.")); return; }
    var g = L.groupTasks(model.tasks, t);
    var any = false;
    [["Overdue", g.overdue, "past their date; nothing moves unless you move it"], ["Today", g.today], ["Later", g.later], ["Inbox", g.inbox, "no date yet"]].forEach(function (x) {
      if (!x[1].length) return;
      any = true;
      var s = section(x[0], x[2]);
      s.appendChild(list(x[1].map(taskEntry), t));
      root.appendChild(s);
    });
    if (!any) root.appendChild(h("p", "dim", "No open to-dos. Add one above."));
    if (g.done.length) {
      var d = section("Ticked in the last two weeks");
      d.appendChild(list(g.done.map(taskEntry), t));
      var clearBtn = h("button", "btn btn-sm", "Clear ticked to-dos");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", clearDone);
      d.appendChild(clearBtn);
      root.appendChild(d);
    }
  }

  function renderRenewals(root, t) {
    var r = L.renewalGroups(L.filterKind(model.renewals, model.kind), t);
    r.groups.forEach(function (g) {
      var s = section(g.title);
      s.appendChild(list(g.items.map(function (x) { return { type: "renewal", id: x.id, label: x.label, kind: x.kind, state: x.state, due: x.due, ref: x }; }), t));
      root.appendChild(s);
    });
    var nd = section("Date still needed", "add the date from the portal and it moves onto the calendar");
    if (!r.needed.length) nd.appendChild(h("p", "dim", "Every renewal has a date."));
    r.needed.forEach(function (x) {
      var el = h("div", "cal-row t-renewal");
      el.appendChild(h("span", "cal-dot"));
      var main = h("button", "cal-main"); main.type = "button"; main.appendChild(h("b", null, x.label));
      main.addEventListener("click", function () { openRenewal(x); });
      el.appendChild(main);
      el.appendChild(chip(L.kindTitle(x.kind)));
      if (x.where) el.appendChild(h("span", "dim cal-when", x.where));
      nd.appendChild(el);
    });
    root.appendChild(nd);
    if (r.auto.length) {
      var a = section("Renews itself", "no action needed, listed so you know");
      r.auto.forEach(function (x) {
        var el = h("div", "cal-row t-renewal");
        el.appendChild(h("span", "cal-dot"));
        var main = h("button", "cal-main"); main.type = "button"; main.appendChild(h("b", null, x.label));
        main.addEventListener("click", function () { openRenewal(x); });
        el.appendChild(main);
        el.appendChild(chip(L.kindTitle(x.kind)));
        if (x.where) el.appendChild(h("span", "dim cal-when", x.where));
        a.appendChild(el);
      });
      root.appendChild(a);
    }
  }

  // ---- the Plan view (plan-view.js draws it; this hands it what it may use) ------------------------------------------

  function planContext() {
    return {
      model: model, L: L, today: today, h: h, clear: clear, chip: chip, toast: toast, say: say, render: render,
      post: plan, openDrawer: openDrawer, closeDrawer: closeDrawer, field: field, input: input, select: select, formShell: formShell, fact: fact,
      openTask: openTask, openTaskForm: openTaskForm, applyTask: applyTask, snooze: snooze, tick: tick
    };
  }
  function renderPlan(root, t) {
    var PV = window.BarnyardPlanView;
    if (!PV) { root.appendChild(h("p", "cal-warn", "The planner didn’t load. Reload the page.")); return; }
    PV.render(root, planContext());
  }

  function renderTabs() {
    var box = $("cal-tabs");
    clear(box);
    ACTIVE_VIEWS.forEach(function (v) {
      var b = h("button", "cal-tab" + (model.view === v[0] ? " on" : ""), v[1]);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", model.view === v[0] ? "true" : "false");
      b.addEventListener("click", function () { setView(v[0]); });
      box.appendChild(b);
    });
    var nav = model.view === "month" || model.view === "week";
    $("cal-nav").hidden = !nav;
    $("cal-prev").setAttribute("aria-label", model.view === "week" ? "Previous week" : "Previous month");
    $("cal-next").setAttribute("aria-label", model.view === "week" ? "Next week" : "Next month");
  }

  function renderFilter() {
    var sel = $("cal-kind");
    if (sel.options.length) { sel.value = model.kind; return; }
    var all = h("option", null, "All kinds"); all.value = "all"; sel.appendChild(all);
    L.KINDS.forEach(function (k) { var o = h("option", null, k[1]); o.value = k[0]; sel.appendChild(o); });
    sel.value = model.kind;
  }

  function render() {
    renderTabs();
    renderFilter();
    if (model.view !== "plan" && window.BarnyardPlanView) window.BarnyardPlanView.stop();     // the focus timer's clock only ticks on the Plan view
    var root = $("cal-root");
    $("cal-quick").hidden = !(model.state === "ok" && model.planner === "ok");
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see the calendar.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error") { message("Couldn’t reach the Worker just now. It will try again shortly."); return; }
    clear(root);
    var t = today();
    if (model.fromCache) root.appendChild(h("p", "cal-note", "Showing the copy saved on this device while the latest loads."));
    if (model.partial) root.appendChild(h("p", "cal-warn", "Some keys couldn’t be read just now, so the renewals list may be missing a few."));
    if (model.planner === "error") root.appendChild(h("p", "cal-warn", "Your to-dos and events couldn’t be loaded just now."));
    if (model.googleState === "error") root.appendChild(h("p", "cal-warn", "Your Google Calendar couldn’t be loaded just now, so its events are missing."));
    if (model.view === "today") renderToday(root, t);
    else if (model.view === "week") renderWeek(root, t);
    else if (model.view === "month") renderMonth(root, t);
    else if (model.view === "upcoming") renderUpcoming(root, t);
    else if (model.view === "plan") renderPlan(root, t);
    else if (model.view === "todos") renderTodos(root, t);
    else renderRenewals(root, t);
    var n = L.dueCount(data(), t);
    document.title = (n ? "(" + n + ") " : "") + "Calendar · Barnyard";
  }

  // ---- the drawer -------------------------------------------------------------------------

  function openDrawer(title) {
    var d = $("cal-drawer");
    lastFocus = document.activeElement;
    $("cal-drawer-title").textContent = title;
    clear($("cal-drawer-body"));
    d.hidden = false;
    $("cal-drawer-close").focus();
    return $("cal-drawer-body");
  }

  function closeDrawer() {
    var d = $("cal-drawer");
    if (d.hidden) return;
    d.hidden = true;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function fact(body, label, value, href) {
    if (!value) return;
    var d = h("div", "cal-fact");
    d.appendChild(h("span", "cal-fact-l", label));
    if (href) { var a = h("a", null, value); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; d.appendChild(a); }
    else d.appendChild(h("span", null, value));
    body.appendChild(d);
  }

  function openDay(date) {
    var body = openDrawer(L.longDate(date));
    var map = L.entriesByDate(data(), date, date, model.kind);
    var es = map[date] || [];
    if (es.length) body.appendChild(list(es, today())); else body.appendChild(h("p", "dim", "Nothing on this day."));
    var actions = h("div", "cal-actions");
    if (model.planner === "ok") {
      var a = h("button", "btn btn-sm", "Add a to-do here"); a.type = "button"; a.addEventListener("click", function () { openTaskForm(null, date); });
      var b = h("button", "btn btn-sm", "Add an event here"); b.type = "button"; b.addEventListener("click", function () { openEventForm(null, date); });
      actions.appendChild(a); actions.appendChild(b);
    }
    body.appendChild(actions);
  }

  function openEntry(e) {
    if (e.type === "renewal") openRenewal(e.ref);
    else if (e.type === "task") openTask(e.ref);
    else if (e.type === "event") openEvent(e.ref.event, e.ref.day);
    else if (e.type === "gcal") openGoogle(e);
  }

  // A Google Calendar event: read only. It is changed in Google Calendar, not here.
  function openGoogle(e) {
    var body = openDrawer(e.label);
    var top = h("div", "cal-chips");
    top.appendChild(chip("Google Calendar"));
    if (e.ref.recurring) top.appendChild(chip("Repeats"));
    body.appendChild(top);
    body.appendChild(h("p", "cal-date", L.longDate(e.due) + ", " + (e.allDay ? "all day" : L.timeText(e.time) + (e.endTime ? " to " + L.timeText(e.endTime) : ""))));
    body.appendChild(h("p", "dim", "This comes from your Google Calendar and can’t be changed here."));
  }

  function openRenewal(r) {
    var body = openDrawer(r.label);
    var t = today();
    var top = h("div", "cal-chips");
    top.appendChild(chip(L.kindTitle(r.kind)));
    if (L.STATE_BADGE[r.state]) top.appendChild(chip(L.STATE_BADGE[r.state]));
    body.appendChild(top);
    if (isYmd(r.due)) body.appendChild(h("p", "cal-date " + L.urgency({ type: "renewal", due: r.due, state: r.state }, t), L.longDate(r.due) + " · " + L.relativeText(L.daysBetween(t, r.due))));
    else body.appendChild(h("p", "cal-date", r.state === "auto" ? "Renews itself." : "No date yet."));
    if (r.state === "estimated") body.appendChild(h("p", "dim", "This date is an estimate. Confirm the exact one at the source, then edit it here."));
    if (r.state === "planned") body.appendChild(h("p", "dim", "A planned rotation date from the security review calendar, not a hard expiry."));
    fact(body, "How to renew it", r.where);
    fact(body, "Portal", r.link, r.link);
    fact(body, "If it lapses", r.breaks);
    fact(body, "Lead time", r.leadDays !== null && r.leadDays !== undefined ? r.leadDays + (r.leadDays === 1 ? " day" : " days") + " of notice" : "");
    fact(body, "Last renewed", r.lastRenewed ? L.longDate(r.lastRenewed) : "");
    fact(body, "Note", r.note);
    var actions = h("div", "cal-actions");
    var open = h("a", "btn btn-sm", r.source === "ops" ? "Open the Ops item" : "Open where it’s managed");
    open.href = r.href || "ops.html";
    actions.appendChild(open);
    if (r.source === "ops") {
      var edit = h("button", "btn btn-primary btn-sm", "Edit");
      edit.type = "button";
      edit.addEventListener("click", function () { openRenewalForm(r); });
      actions.appendChild(edit);
    } else body.appendChild(h("p", "dim", "This key is made and renewed where it’s managed, so there is nothing to edit here."));
    body.appendChild(actions);
  }

  function openTask(task) {
    var body = openDrawer(task.title);
    var t = today();
    var top = h("div", "cal-chips");
    top.appendChild(chip("To-do"));
    if (task.status === "done") top.appendChild(chip("Ticked", "ok"));
    if (task.priority !== "normal") top.appendChild(chip(task.priority === "high" ? "High priority" : "Low priority"));
    if (task.recur) top.appendChild(chip(L.recurTitle(task.recur)));
    body.appendChild(top);
    body.appendChild(h("p", "cal-date " + (isYmd(task.due) && task.due < t && task.status === "open" ? "alert" : ""), L.taskDueText(task, t)));
    fact(body, "Notes", task.notes);
    if (task.ref) fact(body, task.ref.kind === "ops" ? "Ops item" : "Knowledgebase article", task.ref.id, L.refHref(task.ref));
    if (task.recur && task.doneCount) fact(body, "Done so far", task.doneCount + (task.doneCount === 1 ? " time" : " times"));
    if (task.estimate) fact(body, "Estimate", task.estimate + " min" + (task.spent ? " · worked " + task.spent + " min so far" : ""));
    else if (task.spent) fact(body, "Worked so far", task.spent + " min");
    if (task.tag) fact(body, "Kind of work", task.tag);
    if (task.focus) fact(body, "Planned as", task.focus === "focus" ? "Needs focus (a long block)" : "Quick (fits in a gap)");
    var actions = h("div", "cal-actions");
    var tickBtn = h("button", "btn btn-primary btn-sm", task.status === "done" ? "Mark not done" : "Done");
    tickBtn.type = "button";
    tickBtn.addEventListener("click", function () { tick(task, task.status !== "done"); closeDrawer(); });
    actions.appendChild(tickBtn);
    if (task.status === "open" && window.BarnyardPlanView) {
      var startBtn = h("button", "btn btn-sm", "Start timer"); startBtn.type = "button";
      startBtn.addEventListener("click", function () { closeDrawer(); window.BarnyardPlanView.startTimer(planContext(), task); });
      var logBtn = h("button", "btn btn-sm", "Log time"); logBtn.type = "button";
      logBtn.addEventListener("click", function () { window.BarnyardPlanView.openLog(planContext(), task); });
      actions.appendChild(startBtn); actions.appendChild(logBtn);
    }
    if (task.status === "open") {
      [["today", "Today"], ["tomorrow", "Tomorrow"], ["nextweek", "Next week"]].forEach(function (s) {
        if (s[0] === "today" && task.due === t) return;
        var b = h("button", "btn btn-sm", "Snooze: " + s[1]);
        b.type = "button";
        b.addEventListener("click", function () { snooze(task, s[0]); closeDrawer(); });
        actions.appendChild(b);
      });
    }
    var edit = h("button", "btn btn-sm", "Edit"); edit.type = "button"; edit.addEventListener("click", function () { openTaskForm(task); });
    var del = h("button", "btn btn-sm btn-quiet", "Delete"); del.type = "button"; del.addEventListener("click", function () { removeTask(task); closeDrawer(); });
    actions.appendChild(edit); actions.appendChild(del);
    body.appendChild(actions);
  }

  function openEvent(ev, day) {
    var body = openDrawer(ev.title);
    var top = h("div", "cal-chips");
    top.appendChild(chip("Event"));
    if (ev.recur) top.appendChild(chip(L.recurTitle(ev.recur)));
    body.appendChild(top);
    var when = ev.endDate && ev.endDate !== ev.startDate ? L.shortDate(ev.startDate) + (ev.startTime ? ", " + L.timeText(ev.startTime) : "") + " to " + L.shortDate(ev.endDate) + (ev.endTime ? ", " + L.timeText(ev.endTime) : "")
      : L.shortDate(ev.startDate) + ", " + (ev.startTime ? L.timeText(ev.startTime) + (ev.endTime ? " to " + L.timeText(ev.endTime) : "") : "all day");
    body.appendChild(h("p", "cal-date", when));
    if (ev.recur && day && day.startDate !== ev.startDate) body.appendChild(h("p", "dim", "This is the repeat on " + L.longDate(day.startDate) + ". Editing changes every repeat."));
    fact(body, "Notes", ev.notes);
    var actions = h("div", "cal-actions");
    var edit = h("button", "btn btn-primary btn-sm", "Edit"); edit.type = "button"; edit.addEventListener("click", function () { openEventForm(ev); });
    var del = h("button", "btn btn-sm btn-quiet", ev.recur ? "Delete every repeat" : "Delete"); del.type = "button"; del.addEventListener("click", function () { removeEvent(ev); closeDrawer(); });
    actions.appendChild(edit); actions.appendChild(del);
    body.appendChild(actions);
  }

  // ---- forms ------------------------------------------------------------------------------

  function field(form, id, label, control, hint) {
    var wrap = h("div", "cal-field");
    var l = h("label", null, label);
    l.setAttribute("for", id);
    control.id = id;
    wrap.appendChild(l);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(h("span", "dim cal-hint", hint));
    form.appendChild(wrap);
    return control;
  }
  function input(type, value, max) {
    var i = h("input", "cal-input");
    i.type = type; i.value = value || "";
    if (max) i.maxLength = max;
    i.autocomplete = "off";
    return i;
  }
  function select(options, value) {
    var s = h("select", "cal-input");
    options.forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; s.appendChild(op); });
    s.value = value;
    return s;
  }
  function textarea(value, rows, max) { var t = h("textarea", "cal-input"); t.rows = rows; t.maxLength = max; t.value = value || ""; return t; }
  function formShell(onSubmit, idPrefix) {
    var form = h("form", "cal-form");
    form.noValidate = true;
    var err = h("p", "cal-error"); err.setAttribute("role", "alert");
    var actions = h("div", "cal-actions");
    var save = h("button", "btn btn-primary btn-sm", "Save"); save.type = "submit";
    var cancel = h("button", "btn btn-sm btn-quiet", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", closeDrawer);
    actions.appendChild(save); actions.appendChild(cancel);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      err.textContent = "";
      onSubmit(err, save);
    });
    return { form: form, err: err, actions: actions, save: save, cancel: cancel, fail: function (res) { err.textContent = res.error; var bad = $(idPrefix + res.field); if (bad) bad.focus(); } };
  }

  function openTaskForm(task, presetDate) {
    var isNew = !task;
    var body = openDrawer(isNew ? "Add a to-do" : "Edit to-do");
    var f;
    var title, due, time, prio, recur, notes, ref, est, tag, focus;
    f = formShell(function (err, save) {
      var res = L.taskBody({ title: title.value, due: due.value, time: time.value, priority: prio.value, recur: recur.value, notes: notes.value, ref: ref.value, estimate: est.value, tag: tag.value, focus: focus.value });
      if (res.error) { f.fail(res); return; }
      save.disabled = true;
      var req = isNew ? plan("/task", res.body) : plan("/task/update", Object.assign({ id: task.id }, res.body));
      req.then(function (r) { applyTask(r.task); closeDrawer(); render(); }, function (e) { save.disabled = false; err.textContent = say(e); });
    }, "f-");
    title = field(f.form, "f-title", "What needs doing", input("text", isNew ? "" : task.title, 200));
    due = field(f.form, "f-due", "Date", input("date", isNew ? presetDate || "" : task.due), "Leave empty to keep it in the Inbox.");
    time = field(f.form, "f-time", "Time (optional)", input("time", isNew ? "" : task.time));
    prio = field(f.form, "f-priority", "Priority", select(L.PRIORITIES, isNew ? "normal" : task.priority));
    est = field(f.form, "f-estimate", "How long will it take? (minutes)", input("text", isNew || !task.estimate ? "" : String(task.estimate), 3), "The planner uses this to fit it into your day. Leave empty to use your default.");
    est.inputMode = "numeric";
    tag = field(f.form, "f-tag", "Kind of work (optional)", input("text", isNew ? "" : task.tag, 24), "One or two words, like admin or writing. The planner learns how long each kind really takes you.");
    var learnHint = h("span", "dim cal-hint");
    tag.parentNode.appendChild(learnHint);
    function showLearned() {
      var E = window.BarnyardPlanEngine, r = model.plan && model.plan.ratios;
      learnHint.textContent = E && r ? E.learnedText(r, tag.value.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim()) : "";
    }
    tag.addEventListener("input", showLearned); showLearned();
    focus = field(f.form, "f-focus", "Plan it as", select([["", "Normal"], ["focus", "Needs focus: a long block, earliest gaps first"], ["quick", "Quick: fits in a small gap"]], isNew ? "" : task.focus));
    recur = field(f.form, "f-recur", "Repeat", select(L.RECURRENCES, isNew ? "" : task.recur), "A repeating to-do moves to its next date when you tick it.");
    notes = field(f.form, "f-notes", "Notes", textarea(isNew ? "" : task.notes, 3, 4000));
    ref = field(f.form, "f-ref", "Link to an Ops item or article (optional)", input("text", isNew || !task.ref ? "" : task.ref.id, 300), "Paste an id (it_… or ka_…) or its address.");
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    title.focus();
  }

  function openEventForm(ev, presetDate) {
    var isNew = !ev;
    var body = openDrawer(isNew ? "Add an event" : "Edit event");
    var title, start, allDay, st, et, end, recur, notes;
    var f = formShell(function (err, save) {
      var res = L.eventBody({ title: title.value, startDate: start.value, allDay: allDay.checked, startTime: st.value, endTime: et.value, endDate: end.value, recur: recur.value, notes: notes.value });
      if (res.error) { f.fail(res); return; }
      save.disabled = true;
      var req = isNew ? plan("/event", res.body) : plan("/event/update", Object.assign({ id: ev.id }, res.body));
      req.then(function (r) { applyEvent(r.event); closeDrawer(); render(); }, function (e) { save.disabled = false; err.textContent = say(e); });
    }, "f-");
    title = field(f.form, "f-title", "Name", input("text", isNew ? "" : ev.title, 200));
    start = field(f.form, "f-startDate", "Starts on", input("date", isNew ? presetDate || today() : ev.startDate));
    var adWrap = h("div", "cal-field cal-inline");
    allDay = h("input"); allDay.type = "checkbox"; allDay.id = "f-allDay"; allDay.checked = isNew ? false : ev.allDay;
    var adl = h("label", null, "All day"); adl.setAttribute("for", "f-allDay");
    adWrap.appendChild(allDay); adWrap.appendChild(adl);
    f.form.appendChild(adWrap);
    st = field(f.form, "f-startTime", "Starts at", input("time", isNew ? "09:00" : ev.startTime));
    et = field(f.form, "f-endTime", "Ends at (optional)", input("time", isNew ? "" : ev.endTime));
    end = field(f.form, "f-endDate", "Ends on (optional)", input("date", isNew || ev.endDate === ev.startDate ? "" : ev.endDate), "Only for something that runs past midnight or over several days.");
    recur = field(f.form, "f-recur", "Repeat", select(L.RECURRENCES, isNew ? "" : ev.recur));
    notes = field(f.form, "f-notes", "Notes", textarea(isNew ? "" : ev.notes, 3, 4000));
    function syncAllDay() { st.disabled = et.disabled = allDay.checked; }
    allDay.addEventListener("change", syncAllDay); syncAllDay();
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    title.focus();
  }

  function openRenewalForm(r) {
    var isNew = !r;
    var body = openDrawer(isNew ? "Add a renewal" : "Edit " + r.label);
    var title, kind, due, state, where, link, breaks, lead, renewed;
    var f = formShell(function (err, save) {
      var res = L.renewalBody({ title: title.value, kind: kind.value, due: due.value, state: state.value, where: where.value.trim(), link: link.value.trim(), breaks: breaks.value.trim(), leadDays: lead.value, renewed: renewed.value }, isNew ? "" : r.extra, isNew);
      if (res.error) { f.fail({ error: res.error, field: res.field === "leadDays" ? "lead" : res.field }); return; }
      save.disabled = true;
      var req = isNew ? request(OPS_API, "POST", "/items", res.body) : request(OPS_API, "PATCH", "/items/" + r.id, res.body);
      req.then(function () { closeDrawer(); return load(); }, function (e) { save.disabled = false; err.textContent = say(e); });
    }, "f-");
    title = field(f.form, "f-title", "Name", input("text", isNew ? "" : r.label, 120), "For example “Renew the domain”.");
    kind = field(f.form, "f-kind", "Kind", select(L.KINDS, isNew ? "secret" : r.kind));
    due = field(f.form, "f-due", "Date to act by", input("date", isNew ? "" : r.due), "Leave empty if you don’t know it yet; it will show under “Date still needed”.");
    state = field(f.form, "f-state", "How sure is the date", select(L.STATES, isNew ? "known" : r.state));
    where = field(f.form, "f-where", "How to renew it", textarea(isNew ? "" : r.where, 3, 300), "Where to go and what to click. Never paste the secret itself.");
    link = field(f.form, "f-link", "Portal link (https)", input("url", isNew ? "" : r.link, 300));
    breaks = field(f.form, "f-breaks", "What stops if it lapses", input("text", isNew ? "" : r.breaks, 300));
    lead = field(f.form, "f-lead", "Days of notice it needs", input("number", isNew || r.leadDays === null ? "" : String(r.leadDays)));
    lead.min = "0"; lead.max = "365";
    renewed = field(f.form, "f-renewed", "Last renewed", input("date", isNew ? "" : r.lastRenewed));
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    title.focus();
  }

  // ---- changing things ----------------------------------------------------------------------

  function applyTask(task) {
    var i = model.tasks.findIndex(function (x) { return x.id === task.id; });
    if (i >= 0) model.tasks[i] = task; else model.tasks.push(task);
    writeCache();
  }
  function dropTask(id) { model.tasks = model.tasks.filter(function (x) { return x.id !== id; }); writeCache(); }
  function applyEvent(ev) {
    var i = model.events.findIndex(function (x) { return x.id === ev.id; });
    if (i >= 0) model.events[i] = ev; else model.events.push(ev);
    writeCache();
  }
  function dropEvent(id) { model.events = model.events.filter(function (x) { return x.id !== id; }); writeCache(); }

  function tick(task, done) {
    plan("/task/done", { id: task.id, done: done }).then(function (r) {
      applyTask(r.task);
      render();
      if (r.advanced) toast("Done. “" + task.title + "” moves to " + L.shortDate(r.task.due) + ".", "Undo", function () {
        plan("/task/update", { id: task.id, due: r.previousDue }).then(function (u) { applyTask(u.task); render(); }, function (e) { toast(say(e)); });
      });
      else if (done) toast("Ticked: “" + task.title + "”.", "Undo", function () { tick(r.task, false); });
    }, function (e) { toast(say(e)); render(); });
  }

  function snooze(task, to) {
    plan("/task/snooze", { id: task.id, to: to }).then(function (r) {
      applyTask(r.task);
      render();
      toast("“" + task.title + "” moved to " + L.shortDate(r.task.due) + ".", "Undo", function () {
        plan("/task/update", { id: task.id, due: r.previousDue || "" }).then(function (u) { applyTask(u.task); render(); }, function (e) { toast(say(e)); });
      });
    }, function (e) { toast(say(e)); });
  }

  function removeTask(task) {
    plan("/task/delete", { id: task.id }).then(function () {
      dropTask(task.id);
      render();
      toast("Deleted “" + task.title + "”.", "Undo", function () {
        plan("/task", { title: task.title, notes: task.notes, due: task.due, time: task.time, priority: task.priority, recur: task.recur, ref: task.ref ? task.ref.id : "", estimate: task.estimate || 0, tag: task.tag || "", focus: task.focus || "" })
          .then(function (r) { applyTask(r.task); render(); }, function (e) { toast(say(e)); });
      });
    }, function (e) { toast(say(e)); });
  }

  function removeEvent(ev) {
    plan("/event/delete", { id: ev.id }).then(function () {
      dropEvent(ev.id);
      render();
      toast("Deleted “" + ev.title + "”.", "Undo", function () {
        plan("/event", { title: ev.title, notes: ev.notes, startDate: ev.startDate, startTime: ev.startTime, endDate: ev.endDate, endTime: ev.endTime, recur: ev.recur })
          .then(function (r) { applyEvent(r.event); render(); }, function (e) { toast(say(e)); });
      });
    }, function (e) { toast(say(e)); });
  }

  function clearDone() {
    plan("/clear-done", {}).then(function (r) {
      model.tasks = model.tasks.filter(function (x) { return x.status !== "done"; });
      writeCache();
      render();
      toast("Cleared " + r.removed + (r.removed === 1 ? " ticked to-do." : " ticked to-dos."));
    }, function (e) { toast(say(e)); });
  }

  // The quick-add box at the top: a title and an optional date.
  function quickAdd(ev) {
    ev.preventDefault();
    var title = $("cal-quick-title"), date = $("cal-quick-date");
    var q = L.parseQuick(title.value, today());   // "call host tomorrow 9am" -> the title, the day, the time ...
    var res = L.taskBody({ title: q.title, due: date.value || q.due, time: q.time, recur: q.recur, priority: q.priority });
    if (res.error) { toast(res.error); title.focus(); return; }
    plan("/task", res.body).then(function (r) {
      applyTask(r.task);
      title.value = ""; date.value = "";
      showHint();
      render();
      toast(r.task.due ? "Added for " + L.shortDate(r.task.due) + "." : "Added to your Inbox.");
      title.focus();
    }, function (e) { toast(say(e)); });
  }

  // What the quick-add box understood, shown as you type so there are no surprises.
  function showHint() {
    var hint = $("cal-quick-hint"), text = $("cal-quick-title").value, date = $("cal-quick-date").value;
    if (!text.trim()) { hint.textContent = ""; return; }
    var q = L.parseQuick(text, today());
    var bits = [], d = date || q.due;
    if (d) bits.push(L.shortDate(d));
    if (q.time) bits.push(L.timeText(q.time));
    if (q.recur) bits.push(L.repeatText(q.recur).toLowerCase());
    if (q.priority !== "normal") bits.push(q.priority + " priority");
    hint.textContent = "Will add “" + q.title + "”" + (bits.length ? " · " + bits.join(" · ") : " to your Inbox");
  }

  // ---- events ------------------------------------------------------------------------------

  function setView(v) {
    model.view = v;
    savePrefs();
    render();
  }

  // The arrows step a month in the Month view and a week in the Week view.
  function stepPeriod(n) {
    if (model.view === "week") {
      model.weekOf = L.addDays(L.mondayOf(model.weekOf || today()), 7 * n);
      render();
      return;
    }
    var m = model.month;
    var d = new Date(Date.UTC(m.year, m.month + n, 1));
    model.month = { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    render();
  }

  function goToday() {
    var d = new Date();
    model.month = { year: d.getFullYear(), month: d.getMonth() };
    model.weekOf = null;
    if (model.view === "month" || model.view === "week") render(); else setView("today");
  }

  function downloadIcs() {
    var text = L.buildIcs({ renewals: model.renewals, tasks: model.tasks, events: model.events }, Date.now(), "https://dashboard.barnyard.site/calendar.html");
    var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "barnyard-calendar.ics";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function typing(el) { return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName); }

  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "Escape") { closeDrawer(); return; }
    if (typing(ev.target)) return;
    if (ev.key === "t") goToday();
    else if (ev.key === "n" && model.planner === "ok") { ev.preventDefault(); $("cal-quick-title").focus(); }
    else if (ev.key === "e" && model.planner === "ok") openEventForm(null);
    else if (ev.key === "r") openRenewalForm(null);
    else if (ev.key === "ArrowLeft" && (model.view === "month" || model.view === "week")) stepPeriod(-1);
    else if (ev.key === "ArrowRight" && (model.view === "month" || model.view === "week")) stepPeriod(1);
    else if (ev.key === "w") setView("week");
    else if (ev.key === "p") setView("plan");
  }

  function boot() {
    readPrefs();
    if (/^#plan\b/.test(window.location.hash)) model.view = "plan";        // the Overview tile links to calendar.html#plan
    var d = new Date();
    model.month = { year: d.getFullYear(), month: d.getMonth() };
    $("cal-add-event").addEventListener("click", function () { openEventForm(null); });
    $("cal-add-renewal").addEventListener("click", function () { openRenewalForm(null); });
    $("cal-ics").addEventListener("click", downloadIcs);
    $("cal-prev").addEventListener("click", function () { stepPeriod(-1); });
    $("cal-next").addEventListener("click", function () { stepPeriod(1); });
    $("cal-quick-title").addEventListener("input", showHint);
    $("cal-quick-date").addEventListener("input", showHint);
    $("cal-today").addEventListener("click", goToday);
    $("cal-drawer-close").addEventListener("click", closeDrawer);
    $("cal-quick").addEventListener("submit", quickAdd);
    $("cal-kind").addEventListener("change", function () { model.kind = $("cal-kind").value; savePrefs(); render(); });
    document.addEventListener("keydown", onKey);
    renderTabs();
    renderFilter();
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      if (readCache()) { model.state = "ok"; model.planner = "ok"; render(); }
      load();
      setInterval(function () { if (!document.hidden && model.state === "ok") load(); }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
