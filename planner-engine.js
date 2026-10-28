// The day planner's scheduler (the Calendar page's Plan view and the Overview's "Today's plan" tile): the rules, with no DOM and no network.
// test/plan-engine.test.js covers it.
//
// It is plain and explainable, not a black box. Given the open to-dos (with estimates, deadlines and priorities), the owner's events and
// Google Calendar, the blocks already accepted, and the owner's working hours, it proposes where each to-do's time goes:
//   * earliest deadline first, with a priority nudge (a high-priority to-do counts as due 3 days sooner, a low one 3 days later);
//     a to-do with no date goes after the dated ones;
//   * only inside working hours and outside lunch, never over an event or Google Calendar entry, never moving anything;
//   * a focus block is at most `focusMin` long, then a break; every block leaves `bufferMin` of space; a day never takes more than `loadMin`;
//   * a to-do with a time is a fixed commitment (it takes up its slot and is not moved);
//   * it says plainly what does not fit, what lands after its deadline, and when the days ahead are over-full.
// Times are plain minutes since midnight on the owner's own clock and dates plain "YYYY-MM-DD", so nothing here depends on a time zone
// (Perth has no daylight saving, and the engine would not care if it did). The suggestion is only a suggestion: nothing is stored until the
// owner presses Accept, and a block they moved or pinned by hand (`locked`) is never moved by a re-plan.
// Browser: window.BarnyardPlanEngine. Node (tests): module.exports.

(function (root) {
  "use strict";

  var L = typeof module !== "undefined" && module.exports ? require("./calendar-logic.js") : root.BarnyardCalendarLogic;

  var DEFAULTS = {
    days: [0, 1, 2, 3, 4], workStart: "08:00", workEnd: "17:00", lunchStart: "12:00", lunchEnd: "12:45",
    bufferMin: 10, focusMin: 50, breakMin: 10, loadMin: 360, defaultMin: 30, learn: false, horizonDays: 14
  };
  var STEP = 5;          // minutes: blocks start and end on multiples of this
  var MIN_BLOCK = 15;    // the shortest slice of a to-do worth scheduling on its own
  var PRIORITY_DAYS = { high: -3, normal: 0, low: 3 };

  // ---- small helpers -----------------------------------------------------------------------------------------------

  function toMin(t) { return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null; }
  function fromMin(m) { m = Math.max(0, Math.min(1439, Math.round(m))); return L.pad(Math.floor(m / 60)) + ":" + L.pad(m % 60); }
  function ceilStep(m) { return Math.ceil(m / STEP) * STEP; }
  function floorStep(m) { return Math.floor(m / STEP) * STEP; }
  function settingsOf(s) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = s && s[k] !== undefined ? s[k] : DEFAULTS[k]; });
    return out;
  }
  function clock(m) { return L.timeText(fromMin(m)); }
  function hoursText(min) {
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60), m = min % 60;
    return h + " h" + (m ? " " + m + " min" : "");
  }

  // ---- what a to-do needs -----------------------------------------------------------------------------------------

  // The ratio the owner's real times say applies to a to-do of this tag (the tag's own, else the overall one), or null.
  function ratioFor(ratios, tag) {
    if (!ratios) return null;
    if (tag && ratios[tag]) return ratios[tag];
    return ratios[""] || null;
  }

  // Minutes of work a to-do still needs: its estimate (or the default), scaled by what the owner usually takes when they have switched
  // learning on, less time already worked. A to-do worked past its estimate and still open gets a 15-minute wrap-up.
  function needMinutes(task, settings, ratios) {
    var est = task.estimate > 0 ? task.estimate : settings.defaultMin;
    var r = settings.learn ? ratioFor(ratios, task.tag) : null;
    if (r) est = Math.min(480, Math.max(STEP, ceilStep(est * r.ratio)));
    var spent = task.spent > 0 ? task.spent : 0;
    var left = est - spent;
    return { estimate: est, ratio: r ? r.ratio : null, minutes: left > 0 ? ceilStep(left) : 15 };
  }

  // "You usually take 1.4× your estimate for admin (12 sessions)" -- or "" when there is nothing to say.
  function learnedText(ratios, tag) {
    var r = ratioFor(ratios, tag);
    if (!r) return "";
    var own = tag && ratios[tag];
    var x = Math.round(r.ratio * 10) / 10;
    if (x === 1) return "Your estimates for " + (own ? tag : "your to-dos") + " have been about right (" + r.n + " sessions).";
    return "You usually take " + x + "× your estimate" + (own ? " for " + tag : "") + " (" + r.n + " sessions).";
  }

  // ---- busy time ---------------------------------------------------------------------------------------------------

  // The span of the day an entry from calendar-logic's entriesByDate takes, or null for all-day things (they do not block time).
  function busySpan(e) {
    if (!e || e.allDay) return null;
    var s, en;
    if (e.type === "event") {
      var day = e.ref && e.ref.day;
      s = day && !day.first ? 0 : toMin(e.time);
      if (s === null) return null;
      en = day && !day.last ? 1440 : (toMin(e.endTime) !== null ? toMin(e.endTime) : s + 60);
    } else if (e.type === "gcal") {
      s = toMin(e.time);
      if (s === null) return null;
      en = toMin(e.endTime) !== null ? toMin(e.endTime) : s + 60;
    } else return null;
    if (en <= s) en = Math.min(1440, s + 60);
    return { s: s, e: Math.min(1440, en) };
  }

  function mergeSpans(spans) {
    var a = spans.slice().sort(function (x, y) { return x.s - y.s; }), out = [];
    a.forEach(function (x) {
      var last = out[out.length - 1];
      if (last && x.s <= last.e) last.e = Math.max(last.e, x.e); else out.push({ s: x.s, e: x.e });
    });
    return out;
  }

  // The free spans of a window once the busy spans are taken out; anything shorter than MIN_BLOCK is not worth keeping.
  function subtract(win, busy) {
    var gaps = [], at = win.s;
    mergeSpans(busy).forEach(function (b) {
      if (b.e <= at) return;
      if (b.s > at) gaps.push({ s: at, e: Math.min(b.s, win.e) });
      at = Math.max(at, b.e);
    });
    if (at < win.e) gaps.push({ s: at, e: win.e });
    return gaps.filter(function (g) { return g.e - g.s >= MIN_BLOCK; }).map(function (g) { return { s: ceilStep(g.s), e: floorStep(g.e) }; }).filter(function (g) { return g.e - g.s >= MIN_BLOCK; });
  }

  // ---- the plan ----------------------------------------------------------------------------------------------------

  // input: {
  //   today "YYYY-MM-DD", nowMin (minutes since midnight now, for today),
  //   settings, ratios,
  //   tasks (open and ticked; only open ones are planned), events (the owner's own), google (the Worker's /calendar answer),
  //   blocks (accepted blocks from /planner/all),
  //   scope [dates] -- the days being planned and, when `reflow`, replaced; reflow (bool) -- unlocked, unstarted blocks in scope are
  //   dropped and their to-dos planned again
  // }
  function buildPlan(input) {
    var S = settingsOf(input.settings);
    var today = input.today;
    var nowMin = typeof input.nowMin === "number" ? input.nowMin : 0;
    var scope = input.scope || [];
    var horizon = Math.max(1, Math.min(28, S.horizonDays));
    var from = today, to = L.addDays(today, horizon - 1);
    var ws = toMin(S.workStart), we = toMin(S.workEnd), ls = toMin(S.lunchStart), le = toMin(S.lunchEnd);
    var dates = [], d;
    for (var i = 0; i < horizon; i++) { d = L.addDays(today, i); dates.push(d); }

    // what is on the calendar
    var entries = L.entriesByDate({ renewals: [], dueItems: [], tasks: [], events: input.events || [], google: input.google || [] }, from, to);
    var tasks = (input.tasks || []).filter(function (t) { return t && t.status === "open"; });
    var taskById = {};
    (input.tasks || []).forEach(function (t) { taskById[t.id] = t; });

    // blocks: which stay put (fixed) and which a re-plan lets go
    var inScope = {}; scope.forEach(function (x) { inScope[x] = true; });
    var fixedBlocks = [], dropped = [];
    (input.blocks || []).forEach(function (b) {
      if (b.date < from || b.date > to) return;
      if (input.reflow && inScope[b.date] && b.state === "planned" && !b.locked) { dropped.push(b); return; }
      if (b.state === "skipped") return;
      fixedBlocks.push(b);
    });

    // per day: window, busy spans, load
    var days = dates.map(function (date) {
      var working = S.days.indexOf(L.weekday(date)) >= 0;
      var win = null;
      if (working) {
        win = { s: ws, e: we };
        if (date === today) win.s = Math.max(ws, ceilStep(nowMin));
        if (win.e - win.s < MIN_BLOCK) win = null;
      }
      var items = [], busy = [], load = 0;
      (entries[date] || []).forEach(function (e) {
        var sp = busySpan(e);
        if (!sp) return;
        items.push({ type: e.type, label: e.label, start: sp.s, end: sp.e, id: e.id });
        busy.push({ s: sp.s - S.bufferMin, e: sp.e + S.bufferMin });
      });
      tasks.forEach(function (t) {
        if (t.due !== date || !t.time) return;
        var s = toMin(t.time); if (s === null) return;
        var len = t.estimate > 0 ? t.estimate : S.defaultMin;
        items.push({ type: "todo", label: t.title, start: s, end: Math.min(1440, s + len), taskId: t.id });
        busy.push({ s: s - S.bufferMin, e: s + len + S.bufferMin });
        load += len;
      });
      fixedBlocks.forEach(function (b) {
        if (b.date !== date) return;
        var s = toMin(b.start), e = toMin(b.end);
        if (s === null || e === null) return;
        var t = taskById[b.taskId];
        items.push({ type: "block", label: t ? t.title : "(deleted to-do)", start: s, end: e, id: b.id, taskId: b.taskId, locked: !!b.locked, state: b.state });
        if (b.state === "planned" || b.state === "running") busy.push({ s: s - S.bufferMin, e: e + S.bufferMin });
        else busy.push({ s: s, e: e });       // finished: the time was used, nothing more to leave around it
        load += e - s;
      });
      if (win && ls !== null && le !== null) busy.push({ s: ls, e: le });
      return { date: date, working: working, window: win, items: items, busy: busy, load: load, gaps: win ? subtract(win, busy) : [], suggested: [] };
    });
    var dayOf = {}; days.forEach(function (x) { dayOf[x.date] = x; });

    // what each to-do still needs, after what is already booked for it
    var covered = {};
    fixedBlocks.forEach(function (b) {
      if (b.state !== "planned" && b.state !== "running") return;
      if (b.date < today) return;
      var s = toMin(b.start), e = toMin(b.end);
      if (s !== null && e !== null) covered[b.taskId] = (covered[b.taskId] || 0) + (e - s);
    });
    var work = [];
    tasks.forEach(function (t) {
      if (t.due && t.time) return;                                  // fixed commitments are already in the day
      var n = needMinutes(t, S, input.ratios);
      var left = n.minutes - (covered[t.id] || 0);
      if (left < MIN_BLOCK && (covered[t.id] || 0) > 0) return;     // already planned
      if (left <= 0) return;
      var dueDays = t.due ? L.daysBetween(today, t.due) : null;
      work.push({ task: t, left: ceilStep(Math.max(left, STEP)), need: n, key: (dueDays === null ? 60 : dueDays) + (PRIORITY_DAYS[t.priority] || 0), dueDays: dueDays });
    });
    work.sort(function (a, b) {
      if (a.key !== b.key) return a.key - b.key;
      var fa = a.task.focus === "focus" ? 0 : a.task.focus === "quick" ? 2 : 1, fb = b.task.focus === "focus" ? 0 : b.task.focus === "quick" ? 2 : 1;
      if (fa !== fb) return fa - fb;
      if (a.left !== b.left) return b.left - a.left;
      return a.task.title.localeCompare(b.task.title);
    });

    // overload: by each deadline, is there room for everything due by then?
    var warnings = [];
    var capacity = function (day) {
      var free = day.gaps.reduce(function (n, g) { return n + (g.e - g.s); }, 0);
      return Math.max(0, Math.min(free, S.loadMin - day.load));
    };
    var dueDates = {};
    work.forEach(function (w) { if (w.task.due) dueDates[w.task.due < today ? today : w.task.due] = true; });
    Object.keys(dueDates).sort().slice(0, 12).forEach(function (D) {
      if (D > to) return;
      var need = 0, cap = 0;
      work.forEach(function (w) { if (w.task.due && (w.task.due < today ? today : w.task.due) <= D) need += w.left; });
      days.forEach(function (x) { if (x.date <= D) cap += capacity(x); });
      if (need > cap) warnings.push({ kind: "overload", date: D, needMin: need, capMin: cap, text: "By " + L.shortDate(D) + " you need " + hoursText(need) + " but have room for " + hoursText(cap) + ". Something has to move." });
    });
    warnings = warnings.slice(0, 3);

    // place each to-do, most urgent first
    var unplaced = [], late = [];
    var placedLate = {};
    work.forEach(function (w) {
      var t = w.task, left = w.left, lastDay = null;
      // a slice is at most a focus block; if what is left is only a little more than one, it goes in as one block rather than leaving a stub
      var chunk = t.focus === "quick" || left <= S.focusMin + MIN_BLOCK ? left : Math.min(left, S.focusMin);
      var deadline = t.due && t.due >= today ? t.due : null;           // an overdue to-do just goes in as soon as there is room
      [true, false].forEach(function (beforeDeadline) {
        if (left <= 0) return;
        if (!beforeDeadline && !deadline) return;                      // no deadline: the first pass already looked everywhere
        for (var di = 0; di < days.length && left > 0; di++) {
          var day = days[di];
          if (!day.window) continue;
          if (beforeDeadline && deadline && day.date > deadline) break;
          if (!beforeDeadline && deadline && day.date <= deadline) continue;
          while (left > 0) {
            var room = S.loadMin - day.load;
            if (room < MIN_BLOCK && !(room > 0 && left <= room)) break;
            var take = Math.min(chunk, left, room);
            take = floorStep(take);
            if (take < STEP) break;
            var gi = -1, g;
            if (t.focus === "quick") {                                  // a quick one slots into the snuggest gap that holds it
              for (g = 0; g < day.gaps.length; g++) if (day.gaps[g].e - day.gaps[g].s >= take && (gi < 0 || day.gaps[g].e - day.gaps[g].s < day.gaps[gi].e - day.gaps[gi].s)) gi = g;
            } else {
              for (g = 0; g < day.gaps.length; g++) if (day.gaps[g].e - day.gaps[g].s >= take) { gi = g; break; }
            }
            if (gi < 0 && t.focus !== "quick") {                        // no gap holds a whole slice: use the biggest one that is worth it
              for (g = 0; g < day.gaps.length; g++) if (day.gaps[g].e - day.gaps[g].s >= 20 && (gi < 0 || day.gaps[g].e - day.gaps[g].s > day.gaps[gi].e - day.gaps[gi].s)) gi = g;
              if (gi >= 0) take = Math.min(take, floorStep(day.gaps[gi].e - day.gaps[gi].s));
            }
            if (gi < 0 || take < STEP) break;
            var gap = day.gaps[gi];
            var s = gap.s, e = s + take;
            var reserve = Math.max(S.bufferMin, take >= S.focusMin ? S.breakMin : 0);
            gap.s = ceilStep(e + reserve);
            if (gap.e - gap.s < MIN_BLOCK) day.gaps.splice(gi, 1);
            day.load += take;
            left -= take;
            var isLate = !!(deadline && day.date > deadline);
            day.suggested.push({ type: "suggest", taskId: t.id, label: t.title, date: day.date, start: s, end: e, minutes: take, late: isLate, learned: w.need.ratio });
            lastDay = day.date;
            if (isLate && !placedLate[t.id]) placedLate[t.id] = day.date;
          }
        }
      });
      if (left > 0) unplaced.push({ taskId: t.id, title: t.title, minutes: left, reason: "no_room" });
      if (placedLate[t.id]) late.push({ taskId: t.id, title: t.title, due: t.due, date: placedLate[t.id] });
    });

    unplaced.forEach(function (u) { warnings.push({ kind: "unplaced", taskId: u.taskId, text: "“" + u.title + "” (" + hoursText(u.minutes) + ") has no room in the next " + horizon + " days." }); });
    late.forEach(function (x) { warnings.push({ kind: "late", taskId: x.taskId, text: "“" + x.title + "” is due " + L.shortDate(x.due) + " but the first room for it is " + L.shortDate(x.date) + "." }); });

    // what the page shows
    var suggested = [];
    var out = days.map(function (day) {
      var items = day.items.concat(day.suggested.map(function (b) { suggested.push(b); return b; }));
      items.sort(function (a, b) { return a.start - b.start || (a.end - b.end); });
      var planned = day.load;
      var free = day.gaps.reduce(function (n, g) { return n + (g.e - g.s); }, 0);
      return { date: day.date, working: day.working, window: day.window, items: items, plannedMin: planned, loadMin: S.loadMin, freeMin: free, full: planned >= S.loadMin - MIN_BLOCK };
    });

    // today's top three: the first three different to-dos in today's order
    var topIds = [], seen = {};
    (out[0] ? out[0].items : []).forEach(function (it) {
      if ((it.type === "block" && (it.state === "planned" || it.state === "running")) || it.type === "suggest" || it.type === "todo") {
        if (it.taskId && !seen[it.taskId] && topIds.length < 3) { seen[it.taskId] = true; topIds.push(it.taskId); }
      }
    });

    return { today: today, settings: S, days: out, suggested: suggested, dropped: dropped, unplaced: unplaced, late: late, warnings: warnings, top: topIds, scope: scope, reflow: !!input.reflow };
  }

  // The body for POST /planner/plan/accept: the suggested blocks that fall in scope (a re-plan also names the days whose unlocked blocks it replaces).
  function acceptPayload(plan) {
    var inScope = {}; plan.scope.forEach(function (d) { inScope[d] = true; });
    var blocks = plan.suggested.filter(function (b) { return inScope[b.date]; }).map(function (b) { return { taskId: b.taskId, date: b.date, start: fromMin(b.start), end: fromMin(b.end) }; });
    return { blocks: blocks, replaceDates: plan.reflow ? plan.scope.slice() : [] };
  }

  // ---- the focus timer and the evening review -----------------------------------------------------------------------

  // Milliseconds on the timer now, from the server's copy ({ taskId, blockId, startedAt, accMs, running }).
  function timerElapsed(timer, nowMs) {
    if (!timer) return 0;
    return (timer.accMs || 0) + (timer.running ? Math.max(0, nowMs - timer.startedAt) : 0);
  }
  function clockText(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ":" + L.pad(m) : m) + ":" + L.pad(x);
  }

  // The evening review: what got done, what was planned today and did not happen, and what could roll over to tomorrow.
  //   input: { today, tasks, blocks, worked [{date, minutes}] }
  function review(input) {
    var today = input.today;
    var byId = {}; (input.tasks || []).forEach(function (t) { byId[t.id] = t; });
    function dayOfMs(ms) { var d = new Date(ms); return L.ymd(d); }
    var done = (input.tasks || []).filter(function (t) { return (t.status === "done" && t.doneAt && dayOfMs(t.doneAt) === today) || (t.lastDoneAt && dayOfMs(t.lastDoneAt) === today); });
    var plannedMin = 0, missed = [], seen = {};
    (input.blocks || []).forEach(function (b) {
      if (b.date !== today || b.state === "skipped") return;
      var s = toMin(b.start), e = toMin(b.end);
      if (s === null || e === null) return;
      plannedMin += e - s;
      var t = byId[b.taskId];
      if ((b.state === "planned" || b.state === "running") && t && t.status === "open" && !seen[t.id]) { seen[t.id] = true; missed.push(t); }
    });
    var overdue = (input.tasks || []).filter(function (t) { return t.status === "open" && t.due && t.due <= today && !seen[t.id]; });
    var carry = missed.concat(overdue).filter(function (t) { return t.due; });
    var worked = 0;
    (input.worked || []).forEach(function (w) { if (w.date === today) worked += w.minutes; });
    return { done: done, missed: missed, overdue: overdue, carry: carry, plannedMin: plannedMin, workedMin: worked };
  }

  // The next accepted blocks for the Overview tile: today's, from now on, soonest first.
  function nextBlocks(plan, tasks, today, nowMin) {
    var byId = {}; (tasks || []).forEach(function (t) { byId[t.id] = t; });
    return ((plan && plan.blocks) || []).filter(function (b) {
      var e = toMin(b.end);
      return b.date === today && (b.state === "running" || (b.state === "planned" && e !== null && e > nowMin)) && byId[b.taskId] && byId[b.taskId].status === "open";
    }).map(function (b) { return { id: b.id, taskId: b.taskId, title: byId[b.taskId].title, start: b.start, end: b.end, minutes: toMin(b.end) - toMin(b.start), state: b.state }; })
      .sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  }

  var api = {
    DEFAULTS: DEFAULTS, STEP: STEP, MIN_BLOCK: MIN_BLOCK, toMin: toMin, fromMin: fromMin, clock: clock, hoursText: hoursText, settingsOf: settingsOf,
    needMinutes: needMinutes, ratioFor: ratioFor, learnedText: learnedText, busySpan: busySpan, subtract: subtract, buildPlan: buildPlan,
    acceptPayload: acceptPayload, timerElapsed: timerElapsed, clockText: clockText, review: review, nextBlocks: nextBlocks
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardPlanEngine = api;
})(typeof window !== "undefined" ? window : this);
