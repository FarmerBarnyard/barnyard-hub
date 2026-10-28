// The Calendar page's Plan view: the day planner's Today and Week plans, the focus timer, plan settings, and the evening review.
// calendar.js hands it what it may use (calendar.js: planContext) and calls render(root, ctx); the scheduling rules are in planner-engine.js
// (test/plan-engine.test.js covers them). Needs planner-engine.js and calendar-logic.js first.
//
// What is stored where: to-dos with their estimate, tag and focus/quick kind, the accepted plan blocks, the time log, the one running timer and
// the planner's settings are all on the server (the Planner Durable Object); a suggestion exists only in this page until Accept. The plan is worked
// out here from the one answer GET /planner/all already gave, so looking at the plan costs no extra request; only Accept, a block change, the timer,
// logged time and settings write. The timer's clock is drawn from the server's start time by a one-second tick that runs only while the
// tab is visible. Everything from the server reaches the page through textContent, never as markup.

(function () {
  "use strict";
  if (typeof document === "undefined" || !window.BarnyardPlanEngine) return;
  var E = window.BarnyardPlanEngine;
  var MODE_KEY = "barnyard-plan-mode";
  var state = { mode: "today", reflow: false, review: false, tick: null, modeRead: false };

  var MESSAGES = {
    work_hours_invalid: "Work has to end after it starts.", lunch_invalid: "Lunch needs both a start and an end, inside working hours (or leave both empty).",
    days_invalid: "Pick at least one working day.", workStart_invalid: "That start time doesn’t look right.", workEnd_invalid: "That end time doesn’t look right.",
    focusMin_invalid: "A focus block is 15 to 180 minutes.", loadMin_invalid: "The daily load is 30 to 720 minutes.", bufferMin_invalid: "The gap between blocks is 0 to 60 minutes.",
    breakMin_invalid: "A break is 0 to 60 minutes.", defaultMin_invalid: "The default estimate is 5 to 240 minutes.", horizonDays_invalid: "Plan ahead 7 to 28 days.",
    date_invalid: "That date doesn’t look right.", start_invalid: "That start time doesn’t look right.", end_invalid: "That end time doesn’t look right.",
    block_times_invalid: "A block has to end after it starts.", block_too_long: "A block can be at most 8 hours."
  };
  function why(ctx, e) { return MESSAGES[e.code] || ctx.say(e); }

  function readMode() {
    if (state.modeRead) return;
    state.modeRead = true;
    try { var m = window.localStorage.getItem(MODE_KEY); if (m === "today" || m === "week") state.mode = m; } catch (e) { /* the default is fine */ }
  }
  function setMode(ctx, m) {
    state.mode = m; state.reflow = false;
    try { window.localStorage.setItem(MODE_KEY, m); } catch (e) { /* fine without it */ }
    ctx.render();
  }
  function stop() { if (state.tick) { clearInterval(state.tick); state.tick = null; } }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function taskOf(ctx, id) { for (var i = 0; i < ctx.model.tasks.length; i++) if (ctx.model.tasks[i].id === id) return ctx.model.tasks[i]; return null; }
  function button(ctx, text, cls, fn) {
    var b = ctx.h("button", "btn btn-sm" + (cls ? " " + cls : ""), text);
    b.type = "button"; b.addEventListener("click", fn);
    return b;
  }

  // ---- which days are being planned -------------------------------------------------------------------------------

  function planFor(ctx, extra) {
    var m = ctx.model, P = m.plan, t = ctx.today();
    var base = { today: t, nowMin: nowMin(), settings: P.settings, ratios: P.ratios, tasks: m.tasks, events: m.events, google: m.google, blocks: P.blocks, reflow: state.reflow };
    var probe = E.buildPlan(Object.assign({}, base, { scope: [t], reflow: false }));
    var open = probe.days.filter(function (d) { return d.window; });
    var scope;
    if (!open.length) scope = [t];
    else if (state.mode === "week") scope = open.slice(0, 5).map(function (d) { return d.date; });
    else scope = [open[0].date];
    var result = E.buildPlan(Object.assign({}, base, { scope: scope }, extra || {}));
    result.focusDate = scope[0];
    return result;
  }

  // ---- the focus timer ----------------------------------------------------------------------------------------------

  function setPlan(ctx, plan) { if (plan && typeof plan === "object") ctx.model.plan = plan; }

  function startTimer(ctx, task, blockId) {
    ctx.post("/timer", { action: "start", taskId: task.id, blockId: blockId || undefined }).then(function (r) {
      ctx.model.plan.timer = r.timer;
      if (blockId) ctx.model.plan.blocks.forEach(function (b) { if (b.id === blockId && b.state === "planned") b.state = "running"; });
      ctx.toast("Timer started on “" + task.title + "”.");
      if (ctx.model.view !== "plan") ctx.model.view = "plan";
      ctx.render();
    }, function (e) { ctx.toast(why(ctx, e)); });
  }
  function pauseTimer(ctx) {
    ctx.post("/timer", { action: "pause" }).then(function (r) { ctx.model.plan.timer = r.timer; ctx.render(); }, function (e) { ctx.toast(why(ctx, e)); });
  }
  function resumeTimer(ctx) {
    var tm = ctx.model.plan.timer, task = tm && taskOf(ctx, tm.taskId);
    if (!task) return;
    ctx.post("/timer", { action: "start", taskId: task.id }).then(function (r) { ctx.model.plan.timer = r.timer; ctx.render(); }, function (e) { ctx.toast(why(ctx, e)); });
  }
  function cancelTimer(ctx) {
    ctx.post("/timer", { action: "cancel" }).then(function () {
      var tm = ctx.model.plan.timer;
      if (tm && tm.blockId) ctx.model.plan.blocks.forEach(function (b) { if (b.id === tm.blockId && b.state === "running") b.state = "planned"; });
      ctx.model.plan.timer = null;
      ctx.toast("Timer cancelled. Nothing was logged.");
      ctx.render();
    }, function (e) { ctx.toast(why(ctx, e)); });
  }
  function finishTimer(ctx) {
    var tm = ctx.model.plan.timer, task = tm && taskOf(ctx, tm.taskId);
    if (!tm) return;
    var body = ctx.openDrawer("Finish the timer");
    var minutes, done;
    var f = ctx.formShell(function (err, save) {
      var n = String(minutes.value).trim();
      if (!/^\d{1,3}$/.test(n) || Number(n) < 1 || Number(n) > 720) { f.fail({ error: "Give the time in whole minutes, from 1 to 720.", field: "minutes" }); return; }
      save.disabled = true;
      ctx.post("/timer", { action: "finish", minutes: Number(n), done: !!done.checked }).then(function (r) {
        if (r.task) ctx.applyTask(r.task);
        setPlan(ctx, r.plan);
        ctx.closeDrawer();
        ctx.toast("Logged " + r.minutes + " min on “" + (r.task ? r.task.title : "the to-do") + "”" + (r.task && r.task.status === "done" ? " and ticked it off." : "."));
        ctx.render();
      }, function (e) { save.disabled = false; err.textContent = why(ctx, e); });
    }, "pf-");
    if (task) body.appendChild(ctx.h("p", "dim", "“" + task.title + "”" + (task.estimate ? " · you estimated " + task.estimate + " min" : "")));
    var shown = Math.max(1, Math.round(E.timerElapsed(tm, Date.now()) / 60000));
    minutes = ctx.field(f.form, "pf-minutes", "Time worked (minutes)", ctx.input("text", String(shown), 3), "From the timer. Change it if you forgot to pause.");
    minutes.inputMode = "numeric";
    var wrap = ctx.h("div", "cal-field cal-inline");
    done = ctx.h("input", "cal-check"); done.type = "checkbox"; done.id = "pf-done";
    var lab = ctx.h("label", null, "Tick this to-do off"); lab.setAttribute("for", "pf-done");
    wrap.appendChild(done); wrap.appendChild(lab); f.form.appendChild(wrap);
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    minutes.focus(); minutes.select();
  }

  function openLog(ctx, task) {
    var body = ctx.openDrawer("Log time");
    var minutes, date;
    var f = ctx.formShell(function (err, save) {
      var n = String(minutes.value).trim();
      if (!/^\d{1,3}$/.test(n) || Number(n) < 1 || Number(n) > 720) { f.fail({ error: "Give the time in whole minutes, from 1 to 720.", field: "minutes" }); return; }
      save.disabled = true;
      ctx.post("/log", { taskId: task.id, minutes: Number(n), date: date.value || ctx.today() }).then(function (r) {
        ctx.applyTask(r.task); setPlan(ctx, r.plan);
        ctx.closeDrawer();
        ctx.toast("Logged " + n + " min on “" + task.title + "”.");
        ctx.render();
      }, function (e) { save.disabled = false; err.textContent = why(ctx, e); });
    }, "pl-");
    body.appendChild(ctx.h("p", "dim", "“" + task.title + "”" + (task.estimate ? " · estimated " + task.estimate + " min" : "") + (task.spent ? " · " + task.spent + " min so far" : "")));
    minutes = ctx.field(f.form, "pl-minutes", "Time worked (minutes)", ctx.input("text", "", 3), "For work you did without the timer. It also teaches the planner how long things take you.");
    minutes.inputMode = "numeric";
    date = ctx.field(f.form, "pl-date", "Day", ctx.input("date", ctx.today()));
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    minutes.focus();
  }

  // ---- blocks -----------------------------------------------------------------------------------------------------

  function updateBlockLocal(ctx, block) {
    var bs = ctx.model.plan.blocks;
    for (var i = 0; i < bs.length; i++) if (bs[i].id === block.id) { bs[i] = block; return; }
    bs.push(block);
  }
  function togglePin(ctx, b) {
    ctx.post("/block/update", { id: b.id, locked: !b.locked }).then(function (r) { updateBlockLocal(ctx, r.block); ctx.render(); }, function (e) { ctx.toast(why(ctx, e)); });
  }
  function removeBlock(ctx, b) {
    ctx.post("/block/delete", { id: b.id }).then(function () {
      ctx.model.plan.blocks = ctx.model.plan.blocks.filter(function (x) { return x.id !== b.id; });
      ctx.render();
      ctx.toast("Removed that block.", "Undo", function () {
        ctx.post("/plan/accept", { blocks: [{ taskId: b.taskId, date: b.date, start: b.start, end: b.end, locked: b.locked }] }).then(function (r) {
          r.blocks.forEach(function (x) { updateBlockLocal(ctx, x); }); ctx.render();
        }, function (e) { ctx.toast(why(ctx, e)); });
      });
    }, function (e) { ctx.toast(why(ctx, e)); });
  }
  function moveBlock(ctx, b) {
    var task = taskOf(ctx, b.taskId);
    var body = ctx.openDrawer("Move this block");
    var date, start, end;
    var f = ctx.formShell(function (err, save) {
      if (!ctx.L.isYmd(date.value)) { f.fail({ error: "Pick a day.", field: "date" }); return; }
      if (!ctx.L.isTime(start.value) || !ctx.L.isTime(end.value)) { f.fail({ error: "Give a start and an end time.", field: "start" }); return; }
      if (end.value <= start.value) { f.fail({ error: "A block has to end after it starts.", field: "end" }); return; }
      save.disabled = true;
      ctx.post("/block/update", { id: b.id, date: date.value, start: start.value, end: end.value }).then(function (r) {
        updateBlockLocal(ctx, r.block); ctx.closeDrawer(); ctx.render();
        ctx.toast("Moved. It is pinned there, so a re-plan won’t change it.");
      }, function (e) { save.disabled = false; err.textContent = why(ctx, e); });
    }, "pm-");
    if (task) body.appendChild(ctx.h("p", "dim", "“" + task.title + "”"));
    date = ctx.field(f.form, "pm-date", "Day", ctx.input("date", b.date));
    start = ctx.field(f.form, "pm-start", "From", ctx.input("time", b.start));
    end = ctx.field(f.form, "pm-end", "To", ctx.input("time", b.end));
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    start.focus();
  }

  function accept(ctx, result) {
    var body = E.acceptPayload(result);
    if (!body.blocks.length && !body.replaceDates.length) return;
    ctx.post("/plan/accept", body).then(function (r) {
      var P = ctx.model.plan;
      P.blocks = P.blocks.filter(function (b) { return !(body.replaceDates.indexOf(b.date) >= 0 && !b.locked && b.state === "planned"); }).concat(r.blocks);
      state.reflow = false;
      ctx.toast("Planned " + r.blocks.length + (r.blocks.length === 1 ? " block." : " blocks."));
      ctx.render();
    }, function (e) { ctx.toast(why(ctx, e)); });
  }

  // ---- settings -----------------------------------------------------------------------------------------------------

  function openSettings(ctx) {
    var S = E.settingsOf(ctx.model.plan.settings);
    var body = ctx.openDrawer("Plan settings");
    var f, fields = {}, dayBoxes = [], learn;
    f = ctx.formShell(function (err, save) {
      var out = { days: [], workStart: fields.workStart.value, workEnd: fields.workEnd.value, lunchStart: fields.lunchStart.value, lunchEnd: fields.lunchEnd.value, learn: !!learn.checked };
      dayBoxes.forEach(function (cb, i) { if (cb.checked) out.days.push(i); });
      var nums = ["bufferMin", "focusMin", "breakMin", "defaultMin", "horizonDays"];
      for (var i = 0; i < nums.length; i++) {
        var v = String(fields[nums[i]].value).trim();
        if (!/^\d{1,3}$/.test(v)) { f.fail({ error: MESSAGES[nums[i] + "_invalid"], field: nums[i] }); return; }
        out[nums[i]] = Number(v);
      }
      var hrs = Number(String(fields.loadHours.value).replace(",", "."));
      if (!isFinite(hrs) || hrs <= 0) { f.fail({ error: MESSAGES.loadMin_invalid, field: "loadHours" }); return; }
      out.loadMin = Math.round(hrs * 60);
      if (!out.days.length) { f.fail({ error: MESSAGES.days_invalid, field: "workStart" }); return; }
      save.disabled = true;
      ctx.post("/settings", out).then(function (r) {
        ctx.model.plan.settings = r.settings; ctx.closeDrawer(); ctx.render(); ctx.toast("Plan settings saved.");
      }, function (e) { save.disabled = false; err.textContent = why(ctx, e); });
    }, "ps-");
    body.appendChild(ctx.h("p", "dim", "These are your working hours and habits. The planner only ever suggests; you decide what is accepted."));
    var daysWrap = ctx.h("div", "cal-field");
    daysWrap.appendChild(ctx.h("label", null, "Working days"));
    var row = ctx.h("div", "plan-days");
    ctx.L.DAY_NAMES.forEach(function (name, i) {
      var lab = ctx.h("label", "plan-day-pick");
      var cb = ctx.h("input", "cal-check"); cb.type = "checkbox"; cb.checked = S.days.indexOf(i) >= 0;
      lab.appendChild(cb); lab.appendChild(ctx.h("span", null, name));
      dayBoxes.push(cb); row.appendChild(lab);
    });
    daysWrap.appendChild(row); f.form.appendChild(daysWrap);
    fields.workStart = ctx.field(f.form, "ps-workStart", "Start of the working day", ctx.input("time", S.workStart));
    fields.workEnd = ctx.field(f.form, "ps-workEnd", "End of the working day", ctx.input("time", S.workEnd));
    fields.lunchStart = ctx.field(f.form, "ps-lunchStart", "Lunch from (optional)", ctx.input("time", S.lunchStart));
    fields.lunchEnd = ctx.field(f.form, "ps-lunchEnd", "Lunch until", ctx.input("time", S.lunchEnd), "Leave both empty for no lunch break.");
    fields.focusMin = ctx.field(f.form, "ps-focusMin", "Longest focus block (minutes)", ctx.input("text", String(S.focusMin), 3));
    fields.breakMin = ctx.field(f.form, "ps-breakMin", "Break after a focus block (minutes)", ctx.input("text", String(S.breakMin), 3));
    fields.bufferMin = ctx.field(f.form, "ps-bufferMin", "Space between blocks and events (minutes)", ctx.input("text", String(S.bufferMin), 3));
    fields.loadHours = ctx.field(f.form, "ps-loadHours", "Most work to plan in a day (hours)", ctx.input("text", String(Math.round(S.loadMin / 6) / 10), 4), "Meetings and fixed-time to-dos count towards it.");
    fields.defaultMin = ctx.field(f.form, "ps-defaultMin", "Time for a to-do with no estimate (minutes)", ctx.input("text", String(S.defaultMin), 3));
    fields.horizonDays = ctx.field(f.form, "ps-horizonDays", "Look ahead (days)", ctx.input("text", String(S.horizonDays), 2), "How far the planner looks for room (7 to 28).");
    var lw = ctx.h("div", "cal-field cal-inline");
    learn = ctx.h("input", "cal-check"); learn.type = "checkbox"; learn.id = "ps-learn"; learn.checked = !!S.learn;
    var ll = ctx.h("label", null, "Plan with how long I usually take"); ll.setAttribute("for", "ps-learn");
    lw.appendChild(learn); lw.appendChild(ll); f.form.appendChild(lw);
    var learned = E.learnedText(ctx.model.plan.ratios, "");
    f.form.appendChild(ctx.h("p", "dim cal-hint", learned ? learned + " When this is on, each estimate is scaled by that (by kind of work where there is enough history)." : "Once you have logged time on a few to-dos with estimates, this scales your estimates by what you really take."));
    f.form.appendChild(f.err); f.form.appendChild(f.actions);
    body.appendChild(f.form);
    fields.workStart.focus();
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------

  function summaryLine(ctx, result, scopeDays) {
    var planned = 0, free = 0, blocks = 0;
    scopeDays.forEach(function (d) { planned += d.plannedMin; free += d.freeMin; });
    result.suggested.forEach(function (b) { if (result.scope.indexOf(b.date) >= 0) blocks++; });
    var S = result.settings;
    var bits = [];
    bits.push(E.hoursText(planned) + " planned of " + E.hoursText(S.loadMin * scopeDays.length) + (scopeDays.length > 1 ? " over " + scopeDays.length + " days" : ""));
    if (blocks) bits.push(blocks + (blocks === 1 ? " new block suggested" : " new blocks suggested"));
    return bits.join(" · ");
  }

  function chipFor(ctx, item) {
    var c = ctx.chip;
    if (item.type === "event") return c("Event");
    if (item.type === "gcal") return c("Google Calendar");
    if (item.type === "todo") return c("Fixed time");
    if (item.type === "suggest") return c("Suggested", "plan-suggest-chip");
    if (item.state === "running") return c("Running", "ok");
    if (item.state === "done") return c("Done", "ok");
    return c(item.locked ? "Pinned" : "Planned");
  }

  function itemRow(ctx, item, running) {
    var el = ctx.h("div", "plan-row plan-" + item.type + (item.type === "block" ? " st-" + item.state : "") + (item.late ? " is-late" : ""));
    el.appendChild(ctx.h("span", "plan-time", E.clock(item.start) + "–" + E.clock(item.end)));
    var task = item.taskId ? taskOf(ctx, item.taskId) : null;
    var main;
    if (task) {
      main = ctx.h("button", "cal-main"); main.type = "button";
      main.addEventListener("click", function () { ctx.openTask(task); });
    } else main = ctx.h("span", "cal-main");
    main.appendChild(ctx.h("b", null, item.label));
    el.appendChild(main);
    el.appendChild(chipFor(ctx, item));
    if (item.late) el.appendChild(ctx.chip("After its deadline", "alert"));
    if (item.type === "suggest" && item.learned && item.learned !== 1) el.appendChild(ctx.chip("×" + (Math.round(item.learned * 10) / 10), ""));
    if (item.type === "suggest" || item.type === "block") el.appendChild(ctx.h("span", "dim cal-when", E.hoursText(item.end - item.start)));
    var actions = ctx.h("span", "plan-actions");
    if (task && item.type === "suggest" && !running) actions.appendChild(button(ctx, "Start now", "btn-quiet", function () { startTimer(ctx, task); }));
    if (item.type === "block" && item.state === "planned") {
      var b = null, bs = ctx.model.plan.blocks;
      for (var i = 0; i < bs.length; i++) if (bs[i].id === item.id) b = bs[i];
      if (b && task) {
        if (!running) actions.appendChild(button(ctx, "Start", "", function () { startTimer(ctx, task, b.id); }));
        actions.appendChild(button(ctx, b.locked ? "Unpin" : "Pin", "btn-quiet", function () { togglePin(ctx, b); }));
        actions.appendChild(button(ctx, "Move", "btn-quiet", function () { moveBlock(ctx, b); }));
        actions.appendChild(button(ctx, "Remove", "btn-quiet", function () { removeBlock(ctx, b); }));
      }
    }
    if (actions.childNodes.length) el.appendChild(actions);
    return el;
  }

  function dayCard(ctx, day, result, isFocus) {
    var t = ctx.today();
    var card = ctx.h("section", "plan-day");
    var head = ctx.h("div", "plan-day-head");
    var label = day.date === t ? "Today" : day.date === ctx.L.addDays(t, 1) ? "Tomorrow" : ctx.L.longDate(day.date).split(" ")[0];
    head.appendChild(ctx.h("h3", null, label + " · " + ctx.L.shortDate(day.date)));
    if (day.working) {
      var meter = ctx.h("span", "plan-meter" + (day.full ? " full" : ""));
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", E.hoursText(day.plannedMin) + " planned of " + E.hoursText(day.loadMin));
      var fill = ctx.h("span", "plan-meter-fill");
      fill.style.width = Math.min(100, Math.round(100 * day.plannedMin / Math.max(1, day.loadMin))) + "%";
      meter.appendChild(fill);
      head.appendChild(meter);
      head.appendChild(ctx.h("span", "dim", E.hoursText(day.plannedMin) + " of " + E.hoursText(day.loadMin)));
    }
    card.appendChild(head);
    var running = !!ctx.model.plan.timer;
    var rows = day.items;
    if (!day.working) card.appendChild(ctx.h("p", "dim", "Not a working day, so nothing is planned. Change your working days in Plan settings."));
    else if (!day.window && day.date === t) card.appendChild(ctx.h("p", "dim", "The working day is over. Planning starts on the next working day."));
    if (!rows.length && day.working && day.window) card.appendChild(ctx.h("p", "dim", "Nothing to plan here. Add a to-do with an estimate and it will fit in."));
    var box = ctx.h("div", "cal-list");
    rows.forEach(function (it) { box.appendChild(itemRow(ctx, it, running)); });
    if (rows.length) card.appendChild(box);
    return card;
  }

  function timerBar(ctx, P) {
    var tm = P.timer;
    if (!tm) return null;
    var task = taskOf(ctx, tm.taskId);
    var bar = ctx.h("div", "plan-timer" + (tm.running ? " on" : ""));
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Focus timer");
    var who = ctx.h("div", "plan-timer-who");
    who.appendChild(ctx.h("span", "dim", tm.running ? "Focusing on" : "Paused on"));
    who.appendChild(ctx.h("b", null, task ? task.title : "a to-do"));
    bar.appendChild(who);
    var clock = ctx.h("span", "plan-clock", E.clockText(E.timerElapsed(tm, Date.now())));
    clock.setAttribute("aria-live", "off");
    bar.appendChild(clock);
    var acts = ctx.h("span", "plan-actions");
    acts.appendChild(button(ctx, tm.running ? "Pause" : "Resume", "", function () { if (tm.running) pauseTimer(ctx); else resumeTimer(ctx); }));
    acts.appendChild(button(ctx, "Finish", "btn-primary", function () { finishTimer(ctx); }));
    acts.appendChild(button(ctx, "Cancel", "btn-quiet", function () { cancelTimer(ctx); }));
    bar.appendChild(acts);
    if (tm.running) {
      stop();
      state.tick = setInterval(function () { if (!document.hidden) clock.textContent = E.clockText(E.timerElapsed(tm, Date.now())); }, 1000);
    }
    return bar;
  }

  function warningsBox(ctx, result) {
    if (!result.warnings.length) return null;
    var box = ctx.h("div", "plan-warns");
    box.setAttribute("role", "status");
    result.warnings.forEach(function (w) {
      var el = ctx.h("div", "plan-warn " + w.kind);
      el.appendChild(ctx.h("span", null, w.text));
      var task = w.taskId ? taskOf(ctx, w.taskId) : null;
      if (task) {
        el.appendChild(button(ctx, "Open", "btn-quiet", function () { ctx.openTask(task); }));
        if (w.kind === "unplaced" || w.kind === "late") el.appendChild(button(ctx, "Snooze to next week", "btn-quiet", function () { ctx.snooze(task, "nextweek"); }));
      }
      box.appendChild(el);
    });
    return box;
  }

  function topThree(ctx, day) {
    if (!day || !day.window) return null;
    var ids = [], seen = {};
    day.items.forEach(function (it) {
      var live = it.type === "suggest" || it.type === "todo" || (it.type === "block" && (it.state === "planned" || it.state === "running"));
      if (live && it.taskId && !seen[it.taskId] && ids.length < 3) { seen[it.taskId] = true; ids.push(it); }
    });
    if (!ids.length) return null;
    var box = ctx.h("section", "plan-top");
    box.appendChild(ctx.h("h3", null, day.date === ctx.today() ? "Your top three today" : "Your top three"));
    var ol = ctx.h("ol", "plan-top-list");
    ids.forEach(function (it) {
      var li = ctx.h("li");
      var task = taskOf(ctx, it.taskId);
      var b = ctx.h("button", "cal-main", it.label); b.type = "button";
      if (task) b.addEventListener("click", function () { ctx.openTask(task); });
      li.appendChild(b);
      li.appendChild(ctx.h("span", "dim", " · " + E.clock(it.start) + ", " + E.hoursText(it.end - it.start)));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    return box;
  }

  // The evening review: shown after working hours, or when asked for.
  function reviewBox(ctx, t) {
    var P = ctx.model.plan;
    var r = E.review({ today: t, tasks: ctx.model.tasks, blocks: P.blocks, worked: P.worked });
    var box = ctx.h("section", "plan-review");
    box.appendChild(ctx.h("h3", null, "Review of today"));
    box.appendChild(ctx.h("p", null, "Done: " + r.done.length + (r.done.length === 1 ? " to-do" : " to-dos") + ". Planned " + E.hoursText(r.plannedMin) + ", worked " + E.hoursText(r.workedMin) + " with the timer or log."));
    if (r.done.length) {
      var ul = ctx.h("ul", "plan-review-list");
      r.done.slice(0, 8).forEach(function (x) { ul.appendChild(ctx.h("li", null, x.title)); });
      if (r.done.length > 8) ul.appendChild(ctx.h("li", "dim", "and " + (r.done.length - 8) + " more"));
      box.appendChild(ul);
    }
    var slipped = r.missed.concat(r.overdue);
    if (!slipped.length) { box.appendChild(ctx.h("p", "dim", "Nothing slipped. Good day.")); return box; }
    box.appendChild(ctx.h("p", null, "Didn’t happen:"));
    var list = ctx.h("div", "plan-slip-list"), checks = [];
    slipped.forEach(function (x) {
      var lab = ctx.h("label", "plan-slip");
      var cb = ctx.h("input", "cal-check"); cb.type = "checkbox"; cb.checked = !!x.due; cb.disabled = !x.due;
      checks.push([cb, x]);
      lab.appendChild(cb);
      lab.appendChild(ctx.h("span", null, x.title + (x.due ? "" : " (no date, so it just gets planned again)")));
      list.appendChild(lab);
    });
    box.appendChild(list);
    box.appendChild(button(ctx, "Move the ticked ones to tomorrow", "btn-primary", function () {
      var ids = checks.filter(function (c) { return c[0].checked; }).map(function (c) { return c[1].id; });
      if (!ids.length) return;
      ctx.post("/task/snooze-many", { ids: ids, to: "tomorrow" }).then(function (res) {
        res.moved.forEach(function (mv) {
          var tk = taskOf(ctx, mv.id);
          if (tk) { tk.due = res.to; ctx.applyTask(tk); }
          ctx.model.plan.blocks = ctx.model.plan.blocks.filter(function (b) { return !(b.taskId === mv.id && b.state === "planned" && !b.locked && b.date < res.to); });
        });
        ctx.render();
        ctx.toast("Moved " + res.moved.length + (res.moved.length === 1 ? " to-do" : " to-dos") + " to " + ctx.L.shortDate(res.to) + ".", "Undo", function () {
          Promise.all(res.moved.map(function (mv) { return ctx.post("/task/update", { id: mv.id, due: mv.previousDue || "" }).then(function (u) { ctx.applyTask(u.task); }); })).then(function () { ctx.render(); }, function (e) { ctx.toast(why(ctx, e)); });
        });
      }, function (e) { ctx.toast(why(ctx, e)); });
    }));
    return box;
  }

  function render(root, ctx) {
    stop();
    readMode();
    var P = ctx.model.plan;
    if (!P) { root.appendChild(ctx.h("p", "dim", "The planner isn’t available yet. Reload the page in a moment.")); return; }
    var t = ctx.today(), S = E.settingsOf(P.settings);
    var result = planFor(ctx);
    var scopeDays = result.days.filter(function (d) { return result.scope.indexOf(d.date) >= 0; });
    var wrap = ctx.h("div", "plan");

    // the controls
    var head = ctx.h("div", "plan-head");
    var seg = ctx.h("div", "plan-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Plan for");
    [["today", "Today"], ["week", "Week"]].forEach(function (m) {
      var b = ctx.h("button", "btn btn-sm" + (state.mode === m[0] ? " btn-primary" : ""), m[1]);
      b.type = "button"; b.setAttribute("aria-pressed", state.mode === m[0] ? "true" : "false");
      b.addEventListener("click", function () { setMode(ctx, m[0]); });
      seg.appendChild(b);
    });
    head.appendChild(seg);
    var acts = ctx.h("span", "plan-actions");
    var inScope = result.suggested.filter(function (b) { return result.scope.indexOf(b.date) >= 0; }).length;
    var unlocked = P.blocks.filter(function (b) { return b.state === "planned" && !b.locked && result.scope.indexOf(b.date) >= 0; }).length;
    if (inScope || (state.reflow && result.dropped.length)) {
      acts.appendChild(button(ctx, state.reflow ? "Accept the new plan (" + inScope + ")" : "Accept " + inScope + (inScope === 1 ? " block" : " blocks"), "btn-primary", function () { accept(ctx, result); }));
    }
    if (state.reflow) acts.appendChild(button(ctx, "Cancel re-plan", "btn-quiet", function () { state.reflow = false; ctx.render(); }));
    else if (unlocked) acts.appendChild(button(ctx, "Re-plan", "", function () { state.reflow = true; ctx.render(); }));
    if (state.mode === "today") acts.appendChild(button(ctx, "Review the day", "btn-quiet", function () { state.review = !state.review; ctx.render(); }));
    acts.appendChild(button(ctx, "Plan settings", "btn-quiet", function () { openSettings(ctx); }));
    head.appendChild(acts);
    wrap.appendChild(head);

    var bar = timerBar(ctx, P);
    if (bar) wrap.appendChild(bar);

    wrap.appendChild(ctx.h("p", "plan-sum dim", summaryLine(ctx, result, scopeDays) + (state.reflow ? " · re-planning: pinned, started and finished blocks stay" : "")));
    var openCount = ctx.model.tasks.filter(function (x) { return x.status === "open"; }).length;
    if (!openCount) wrap.appendChild(ctx.h("p", "dim", "You have no open to-dos. Add one with an estimate (and a date if it has a deadline) and the planner will fit it in."));
    if (P.ratios && P.ratios[""] && !S.learn) wrap.appendChild(ctx.h("p", "plan-learn dim", E.learnedText(P.ratios, "") + " Switch on “Plan with how long I usually take” in Plan settings to use that."));
    else if (S.learn && P.ratios && P.ratios[""]) wrap.appendChild(ctx.h("p", "plan-learn dim", "Planning with how long you usually take. " + E.learnedText(P.ratios, "")));

    var warns = warningsBox(ctx, result);
    if (warns) wrap.appendChild(warns);

    if (state.mode === "today") {
      var focus = scopeDays[0];
      var top = topThree(ctx, focus);
      if (top) wrap.appendChild(top);
    }
    scopeDays.forEach(function (d, i) { wrap.appendChild(dayCard(ctx, d, result, i === 0)); });

    var showReview = state.mode === "today" && (state.review || (scopeDays[0] && scopeDays[0].date === t && E.toMin(S.workEnd) !== null && nowMin() >= E.toMin(S.workEnd) - 30));
    if (showReview) wrap.appendChild(reviewBox(ctx, t));

    var foot = ctx.h("p", "plan-foot dim");
    foot.textContent = "The plan is a suggestion until you accept it, and it never moves your events or Google Calendar. Working days " + S.days.map(function (i) { return ctx.L.DAY_NAMES[i]; }).join(", ") + ", " + E.clock(E.toMin(S.workStart)) + " to " + E.clock(E.toMin(S.workEnd)) + (S.lunchStart ? ", lunch " + E.clock(E.toMin(S.lunchStart)) + " to " + E.clock(E.toMin(S.lunchEnd)) : "") + ", up to " + E.hoursText(S.loadMin) + " of work a day.";
    wrap.appendChild(foot);
    root.appendChild(wrap);
  }

  window.BarnyardPlanView = { render: render, stop: stop, startTimer: startTimer, openLog: openLog };
})();
