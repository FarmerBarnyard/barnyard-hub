// The Calendar page's rules, with no DOM and no network (calendar.js uses them; test/calendar.test.js covers them).
//
// What the page shows is built from four kinds of thing, all with plain calendar dates ("2026-10-27") and plain times
// ("09:30") that mean the owner's own day and clock, so nothing here converts a time zone:
//   renewal  an Ops board item with the target "renewal" (GET /hub/renewals)
//   item     any other open Ops item with a Due date (GET /hub/renewals, dueItems)
//   task     a to-do (GET /planner/all)
//   event    the owner's own calendar event (GET /planner/all), which may repeat
// Browser: window.BarnyardCalendarLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var KINDS = [["secret", "Secret"], ["key", "Key"], ["token", "Token"], ["certificate", "Certificate"], ["domain", "Domain"], ["licence", "Licence"], ["account", "Account"], ["other", "Other"]];
  var STATES = [["known", "Date is known"], ["estimated", "Date is an estimate"], ["planned", "Planned rotation date"], ["needed", "Date still needed"], ["auto", "Renews itself"]];
  var STATE_BADGE = { known: "", estimated: "Estimated", planned: "Planned", needed: "Date needed", auto: "Renews itself" };
  var VIEWS = [["today", "Today"], ["week", "Week"], ["month", "Month"], ["upcoming", "Upcoming"], ["todos", "To-dos"], ["renewals", "Renewals"]];
  var RECURRENCES = [["", "Doesn’t repeat"], ["daily", "Every day"], ["weekdays", "Every weekday"], ["weekly", "Every week"], ["monthly", "Every month"], ["yearly", "Every year"]];
  var PRIORITIES = [["low", "Low"], ["normal", "Normal"], ["high", "High"]];
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function kindTitle(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return KINDS[i][1]; return "Other"; }
  var REPEAT_WORDS = { daily: "daily", weekdays: "on weekdays", weekly: "weekly", monthly: "monthly", yearly: "yearly" };
  function repeatText(r) { return REPEAT_WORDS[r] ? "Repeats " + REPEAT_WORDS[r] : ""; }
  function recurTitle(r) { for (var i = 0; i < RECURRENCES.length; i++) if (RECURRENCES[i][0] === r) return RECURRENCES[i][1]; return ""; }

  // ---- dates ----------------------------------------------------------------

  // Local date parts as YYYY-MM-DD (the person's own day, not UTC).
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function utc(s) { var p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function fromUtc(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  // A real calendar date (2026-02-30 is not one, even though Date.UTC would roll it over).
  function isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return fromUtc(utc(s)) === s;
  }
  function isTime(s) { return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function daysBetween(fromYmd, toYmd) { return Math.round((utc(toYmd) - utc(fromYmd)) / 86400000); }
  function addDays(s, n) { return fromUtc(utc(s) + n * 86400000); }
  function weekday(s) { return (new Date(utc(s)).getUTCDay() + 6) % 7; }   // Monday is 0
  function mondayOf(s) { return addDays(s, -weekday(s)); }
  function addMonths(s, n) {
    var p = s.split("-").map(Number);
    var total = p[0] * 12 + (p[1] - 1) + n, y = Math.floor(total / 12), m = total % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return y + "-" + pad(m + 1) + "-" + pad(Math.min(p[2], last));
  }

  function longDate(s) {
    var d = new Date(utc(s));
    return DAY_NAMES[(d.getUTCDay() + 6) % 7] + " " + d.getUTCDate() + " " + MONTH_NAMES[d.getUTCMonth()].slice(0, 3) + " " + d.getUTCFullYear();
  }
  function shortDate(s) {
    var d = new Date(utc(s));
    return DAY_NAMES[(d.getUTCDay() + 6) % 7] + " " + d.getUTCDate() + " " + MONTH_NAMES[d.getUTCMonth()].slice(0, 3);
  }
  // "9:30" is shown as typed on a 24-hour clock; the page does not guess a 12-hour habit.
  function timeText(t) { return t ? t.replace(/^0/, "") : ""; }

  // "overdue by 3 days", "today", "tomorrow", "in 12 days", "in about 11 months".
  function relativeText(days) {
    if (days === null || days === undefined || isNaN(days)) return "";
    if (days < -1) return "overdue by " + (-days) + " days";
    if (days === -1) return "overdue by 1 day";
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days <= 60) return "in " + days + " days";
    if (days < 700) return "in about " + Math.round(days / 30.4) + " months";
    return "in about " + (Math.round(days / 36.5) / 10) + " years";
  }

  // ---- repeats --------------------------------------------------------------

  // The next date after `date` that a repeat falls on; `anchor` is the day it started on (so 31 Jan, 28 Feb, 31 Mar).
  function nextOccurrence(date, rule, anchor) {
    if (!isYmd(date)) return null;
    if (rule === "daily") return addDays(date, 1);
    if (rule === "weekly") return addDays(date, 7);
    if (rule === "weekdays") { var n = addDays(date, 1); while (weekday(n) > 4) n = addDays(n, 1); return n; }
    var a = isYmd(anchor) ? anchor : date;
    var ap = a.split("-").map(Number), dp = date.split("-").map(Number);
    if (rule === "monthly") return addMonths(a, (dp[0] * 12 + dp[1] - 1) - (ap[0] * 12 + ap[1] - 1) + 1);
    if (rule === "yearly") return addMonths(a, (dp[0] - ap[0] + 1) * 12);
    return null;
  }

  // Every date an event starts on between two dates (inclusive). A repeating event starts again on each of its dates.
  function startDates(ev, from, to) {
    var out = [];
    if (!ev.recur) { if (ev.startDate <= to && ev.startDate >= addDays(from, -daysBetween(ev.startDate, ev.endDate || ev.startDate))) out.push(ev.startDate); return out; }
    var d = ev.startDate, guard = 0;
    var span = daysBetween(ev.startDate, ev.endDate || ev.startDate);
    while (d && d <= to && guard++ < 1500) {
      if (addDays(d, span) >= from) out.push(d);
      d = nextOccurrence(d, ev.recur, ev.startDate);
    }
    return out;
  }

  // The days an event covers within [from, to], one entry per day: { date, startDate, first, last, startTime, endTime, allDay }.
  function eventDays(ev, from, to) {
    var out = [];
    var span = daysBetween(ev.startDate, ev.endDate || ev.startDate);
    startDates(ev, from, to).forEach(function (s) {
      for (var i = 0; i <= span; i++) {
        var d = addDays(s, i);
        if (d < from || d > to) continue;
        out.push({ date: d, startDate: s, first: i === 0, last: i === span, startTime: ev.startTime || "", endTime: ev.endTime || "", allDay: !ev.startTime });
      }
    });
    return out;
  }

  // "All day", "9:30", "9:30 to 10:15", or for a multi-day timed event the part that falls on this day.
  function eventTimeText(day, ev) {
    if (day.allDay) return "All day";
    if (day.first && day.last) return timeText(day.startTime) + (day.endTime ? " to " + timeText(day.endTime) : "");
    if (day.first) return "from " + timeText(day.startTime);
    if (day.last) return day.endTime ? "until " + timeText(day.endTime) : "all day";
    return "all day";
  }

  // ---- what is on a date ------------------------------------------------------

  // Urgency: red inside a week or overdue, amber inside a month, otherwise calm. A date still needed, or one that renews
  // itself, has no urgency to show. To-dos and Ops items are about "is it late".
  function urgency(entry, today) {
    if (entry.type === "item" || entry.type === "task") {
      var di = daysBetween(today, entry.due);
      return di < 0 ? "alert" : di === 0 ? "attn" : "";
    }
    if (entry.type === "event" || entry.type === "gcal") return "";
    if (!entry.due || entry.state === "needed" || entry.state === "auto") return "";
    var d = daysBetween(today, entry.due);
    return d <= 7 ? "alert" : d <= 30 ? "attn" : "ok";
  }

  function entryOf(type, o) {
    return { type: type, id: o.id, label: o.label, kind: o.kind || "", state: o.state || "known", due: o.due, time: o.time || "", endTime: o.endTime || "", allDay: !!o.allDay, ref: o.ref };
  }

  // Everything that falls on a date between `from` and `to`, as { "2026-10-27": [entry, ...] }. `data` is
  // { renewals, dueItems, tasks, events }; `kind` filters renewals only. Open to-dos are placed on their date;
  // ticked ones are left out (the To-dos view lists them).
  function entriesByDate(data, from, to, kind) {
    var map = {};
    function put(date, e) { if (date >= from && date <= to) (map[date] = map[date] || []).push(e); }
    filterKind(data.renewals, kind).forEach(function (r) { if (isYmd(r.due) && r.state !== "auto") put(r.due, entryOf("renewal", { id: r.id, label: r.label, kind: r.kind, state: r.state, due: r.due, ref: r })); });
    (data.dueItems || []).forEach(function (d) { if (isYmd(d.due)) put(d.due, entryOf("item", { id: d.id, label: d.title, due: d.due, ref: d })); });
    (data.tasks || []).forEach(function (t) {
      if (t.status !== "open" || !isYmd(t.due)) return;
      put(t.due, entryOf("task", { id: t.id, label: t.title, due: t.due, time: t.time, ref: t }));
    });
    (data.events || []).forEach(function (ev) {
      eventDays(ev, from, to).forEach(function (day) {
        put(day.date, entryOf("event", { id: ev.id, label: ev.title, due: day.date, time: day.startTime, endTime: day.endTime, allDay: day.allDay, ref: { event: ev, day: day } }));
      });
    });
    googleEntries(data.google, from, to).forEach(function (g) { put(g.due, g); });
    Object.keys(map).forEach(function (k) { map[k].sort(sortInDay); });
    return map;
  }

  // The owner's Google Calendar events (read only, from GET /calendar: { title, allDay, date, start, end }) as entries.
  // The Worker gives a timed event's start as an instant ("...Z") or as the owner's own wall clock (no "Z"); either way the day
  // and time shown are the owner's local ones. The Worker sends about 8 days back and 10 days ahead.
  function localParts(iso) {
    if (typeof iso !== "string") return null;
    if (iso.slice(-1) === "Z") {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return null;
      return { date: ymd(d), time: pad(d.getHours()) + ":" + pad(d.getMinutes()) };
    }
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
    return m ? { date: m[1], time: m[2] } : null;
  }
  function googleEntries(events, from, to) {
    var out = [];
    (events || []).forEach(function (g, i) {
      if (!g || typeof g.title !== "string") return;
      var s, e;
      if (g.allDay) { if (!isYmd(g.date)) return; s = { date: g.date, time: "" }; e = null; }
      else { s = localParts(g.start); if (!s) return; e = localParts(g.end); }
      if (s.date < from || s.date > to) return;
      out.push({ type: "gcal", id: "g" + i + ":" + s.date, label: g.title, kind: "", state: "known", due: s.date, time: g.allDay ? "" : s.time, endTime: !g.allDay && e && e.date === s.date ? e.time : "", allDay: !!g.allDay, ref: g });
    });
    return out;
  }

  var TYPE_ORDER = { event: 0, gcal: 0, task: 1, item: 2, renewal: 3 };
  // Within a day: all-day things first (events, then to-dos, Ops items, renewals), then timed ones by time.
  function sortInDay(a, b) {
    var at = !!a.time && !a.allDay, bt = !!b.time && !b.allDay;
    if (at !== bt) return at ? 1 : -1;
    if (at && bt && a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (TYPE_ORDER[a.type] !== TYPE_ORDER[b.type]) return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return (a.label || "").localeCompare(b.label || "");
  }

  function filterKind(renewals, kind) {
    if (!kind || kind === "all") return renewals || [];
    return (renewals || []).filter(function (r) { return r.kind === kind; });
  }

  // The Today view's groups: overdue (to-dos, Ops items and renewals past their date), today, and the next 7 days.
  function agenda(data, today, kind) {
    var out = { overdue: [], today: [], week: [] };
    var past = entriesByDate(data, addDays(today, -400), addDays(today, -1), kind);
    Object.keys(past).sort().forEach(function (date) {
      past[date].forEach(function (e) { if (e.type !== "event" && e.type !== "gcal") out.overdue.push(e); });   // an event that has happened is not overdue
    });
    var now = entriesByDate(data, today, addDays(today, 7), kind);
    Object.keys(now).sort().forEach(function (date) {
      now[date].forEach(function (e) { out[date === today ? "today" : "week"].push(e); });
    });
    return out;
  }

  // Everything dated from today forward, soonest first, grouped under month headings (Upcoming). The renewals list further
  // out is the Renewals view; here things run for `days` days.
  function upcoming(data, today, days, kind) {
    var map = entriesByDate(data, today, addDays(today, days), kind);
    var groups = [], last = null;
    Object.keys(map).sort().forEach(function (date) {
      var key = MONTH_NAMES[+date.slice(5, 7) - 1] + " " + date.slice(0, 4);
      if (!last || last.title !== key) { last = { title: key, entries: [] }; groups.push(last); }
      map[date].forEach(function (e) { last.entries.push(e); });
    });
    return groups;
  }

  // The Renewals view: dated renewals soonest first (overdue first of all) under month headings, then the ones that still
  // need a date, then the ones that renew themselves.
  function renewalGroups(renewals, today) {
    var dated = (renewals || []).filter(function (r) { return isYmd(r.due) && r.state !== "auto"; });
    dated.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.label.localeCompare(b.label); });
    var groups = [], last = null;
    dated.forEach(function (r) {
      var key = daysBetween(today, r.due) < 0 ? "Overdue" : MONTH_NAMES[+r.due.slice(5, 7) - 1] + " " + r.due.slice(0, 4);
      if (!last || last.title !== key) { last = { title: key, items: [] }; groups.push(last); }
      last.items.push(r);
    });
    var needed = [], auto = [];
    (renewals || []).forEach(function (r) {
      if (r.state === "auto") auto.push(r);
      else if (!isYmd(r.due) || r.state === "needed") needed.push(r);
    });
    return { groups: groups, needed: needed, auto: auto };
  }

  // ---- to-dos ----------------------------------------------------------------

  function taskCompare(a, b) {
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    var at = a.time || "99:99", bt = b.time || "99:99";
    if (at !== bt) return at < bt ? -1 : 1;
    var pr = { high: 0, normal: 1, low: 2 };
    if (pr[a.priority] !== pr[b.priority]) return pr[a.priority] - pr[b.priority];
    return a.title.localeCompare(b.title);
  }

  // The To-dos view's groups. Overdue are never moved by the page, only shown as overdue.
  function groupTasks(tasks, today) {
    var out = { overdue: [], today: [], later: [], inbox: [], done: [] };
    (tasks || []).forEach(function (t) {
      if (t.status === "done") { out.done.push(t); return; }
      if (!isYmd(t.due)) out.inbox.push(t);
      else if (t.due < today) out.overdue.push(t);
      else if (t.due === today) out.today.push(t);
      else out.later.push(t);
    });
    ["overdue", "today", "later"].forEach(function (k) { out[k].sort(taskCompare); });
    out.inbox.sort(function (a, b) { return a.createdAt - b.createdAt; });
    out.done.sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
    return out;
  }

  // The Overview's small to-do list: open to-dos in the order overdue, today, later, then the undated Inbox; at most `max`, and how many more there are.
  function widgetTasks(tasks, today, max) {
    var g = groupTasks(tasks, today);
    var open = g.overdue.concat(g.today, g.later, g.inbox);
    return { rows: open.slice(0, max), more: Math.max(0, open.length - max) };
  }

  // "Tue 27 Oct, 9:30 · overdue by 3 days" or "Inbox (no date)".
  function taskDueText(t, today) {
    if (!isYmd(t.due)) return "No date";
    var days = daysBetween(today, t.due);
    return shortDate(t.due) + (t.time ? ", " + timeText(t.time) : "") + " · " + relativeText(days);
  }

  // How many things need looking at now: overdue or due today (events do not count).
  function dueCount(data, today) {
    var a = agenda(data, today, "all");
    var n = a.overdue.length;
    a.today.forEach(function (e) { if (e.type !== "event" && e.type !== "gcal") n++; });
    return n;
  }

  // ---- a month and a week ------------------------------------------------------

  // A month as weeks of seven days, Monday first. month is 0-11.
  function monthGrid(year, month) {
    var first = new Date(Date.UTC(year, month, 1));
    var lead = (first.getUTCDay() + 6) % 7;
    var start = Date.UTC(year, month, 1 - lead);
    var weeks = [];
    for (var w = 0; w < 6; w++) {
      var row = [];
      for (var i = 0; i < 7; i++) {
        var d = new Date(start + (w * 7 + i) * 86400000);
        row.push({ date: d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month });
      }
      if (w >= 4 && !row.some(function (c) { return c.inMonth; })) break;
      weeks.push(row);
    }
    return { label: MONTH_NAMES[month] + " " + year, year: year, month: month, weeks: weeks };
  }

  // The seven days of the week containing `date`, Monday first, with a label such as "27 Oct to 2 Nov 2026".
  function weekDays(date) {
    var start = mondayOf(date), days = [];
    for (var i = 0; i < 7; i++) days.push(addDays(start, i));
    var a = new Date(utc(days[0])), b = new Date(utc(days[6]));
    var label = a.getUTCDate() + (a.getUTCMonth() === b.getUTCMonth() ? "" : " " + MONTH_NAMES[a.getUTCMonth()].slice(0, 3)) + " to " + b.getUTCDate() + " " + MONTH_NAMES[b.getUTCMonth()].slice(0, 3) + " " + b.getUTCFullYear();
    return { start: start, days: days, label: label };
  }

  // ---- the .ics file -----------------------------------------------------------

  function icsEscape(t) { return String(t === undefined || t === null ? "" : t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function utf8Len(ch) { var c = ch.charCodeAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : 3; }

  // Lines over 75 bytes are folded onto a continuation line that starts with one space.
  function icsFold(line) {
    var out = [], cur = "", bytes = 0, limit = 75;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff) { ch += line[++i] || ""; }
      var n = utf8Len(ch);
      if (bytes + n > limit) { out.push(cur); cur = " "; bytes = 1; limit = 75; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join("\r\n");
  }

  function icsStamp(nowMs) { var d = new Date(nowMs); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z"; }
  function icsDate(s) { return s.replace(/-/g, ""); }
  function icsDateTime(s, t) { return icsDate(s) + "T" + t.replace(":", "") + "00"; }   // a floating time: the owner's own clock
  var RRULE = { daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" };

  // One calendar for the owner to import or subscribe to: an all-day event for each dated renewal (reminders 30 and 7 days
  // ahead at 9 in the morning), the owner's own events (with their repeats), and to-dos with a date (an all-day or timed
  // item with a reminder the day before and at the time; a repeat is kept as a repeat). `data` is
  // { renewals, tasks, events } (Ops items due are left out: they belong to the board).
  function buildIcs(data, nowMs, hubUrl) {
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Barnyard//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Barnyard calendar"];
    function alarm(trigger, text) { lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(text), "TRIGGER:" + trigger, "END:VALARM"); }
    (data.renewals || []).forEach(function (r) {
      if (!isYmd(r.due) || r.state === "auto") return;
      var desc = [kindTitle(r.kind)];
      if (r.state === "estimated") desc.push("The date is an estimate: confirm it at the source.");
      if (r.state === "planned") desc.push("A planned rotation date, not a hard expiry.");
      if (r.where) desc.push("How to renew: " + r.where);
      if (r.breaks) desc.push("If it lapses: " + r.breaks);
      if (r.link) desc.push("Portal: " + r.link);
      if (hubUrl) desc.push("Details: " + hubUrl);
      lines.push("BEGIN:VEVENT");
      lines.push("UID:renewal-" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "-") + "@barnyard.site");
      lines.push("DTSTAMP:" + icsStamp(nowMs));
      lines.push("DTSTART;VALUE=DATE:" + icsDate(r.due));
      lines.push("DTEND;VALUE=DATE:" + icsDate(addDays(r.due, 1)));
      lines.push("SUMMARY:" + icsEscape("Renew: " + r.label + (r.state === "estimated" ? " (estimated)" : "")));
      lines.push("DESCRIPTION:" + icsEscape(desc.join("\n")));
      lines.push("CATEGORIES:Renewal");
      lines.push("TRANSP:TRANSPARENT");
      alarm("-P29DT15H", r.label + " runs out in 30 days");
      alarm("-P6DT15H", r.label + " runs out in 7 days");
      lines.push("END:VEVENT");
    });
    (data.events || []).forEach(function (ev) {
      lines.push("BEGIN:VEVENT");
      lines.push("UID:event-" + String(ev.id).replace(/[^A-Za-z0-9_-]/g, "-") + "@barnyard.site");
      lines.push("DTSTAMP:" + icsStamp(nowMs));
      if (ev.startTime) {
        lines.push("DTSTART:" + icsDateTime(ev.startDate, ev.startTime));
        lines.push("DTEND:" + icsDateTime(ev.endDate || ev.startDate, ev.endTime || ev.startTime));
      } else {
        lines.push("DTSTART;VALUE=DATE:" + icsDate(ev.startDate));
        lines.push("DTEND;VALUE=DATE:" + icsDate(addDays(ev.endDate || ev.startDate, 1)));
      }
      if (RRULE[ev.recur]) lines.push("RRULE:" + RRULE[ev.recur]);
      lines.push("SUMMARY:" + icsEscape(ev.title));
      if (ev.notes) lines.push("DESCRIPTION:" + icsEscape(ev.notes));
      lines.push("CATEGORIES:Event");
      if (ev.startTime) alarm("-PT15M", ev.title + " starts in 15 minutes");
      lines.push("END:VEVENT");
    });
    (data.tasks || []).forEach(function (t) {
      if (t.status !== "open" || !isYmd(t.due)) return;
      lines.push("BEGIN:VEVENT");
      lines.push("UID:todo-" + String(t.id).replace(/[^A-Za-z0-9_-]/g, "-") + "@barnyard.site");
      lines.push("DTSTAMP:" + icsStamp(nowMs));
      if (t.time) {
        lines.push("DTSTART:" + icsDateTime(t.due, t.time));
        lines.push("DTEND:" + icsDateTime(t.due, t.time));
      } else {
        lines.push("DTSTART;VALUE=DATE:" + icsDate(t.due));
        lines.push("DTEND;VALUE=DATE:" + icsDate(addDays(t.due, 1)));
      }
      if (RRULE[t.recur]) lines.push("RRULE:" + RRULE[t.recur]);
      lines.push("SUMMARY:" + icsEscape("To-do: " + t.title));
      if (t.notes) lines.push("DESCRIPTION:" + icsEscape(t.notes));
      lines.push("CATEGORIES:To-do");
      lines.push("TRANSP:TRANSPARENT");
      if (t.priority === "high") lines.push("PRIORITY:1"); else if (t.priority === "low") lines.push("PRIORITY:9");
      alarm(t.time ? "-PT0M" : "-PT0S", "To-do: " + t.title);
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }

  // ---- quick add ----------------------------------------------------------------

  var MONTH_WORDS = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
  var DAY_WORDS = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6, mon: 0, tue: 1, tues: 1, wed: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6 };
  var DAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)";
  var MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";

  // "call the host tomorrow 9am", "renew domain 14 Mar", "pay rent every month on the 1st !high" -> what the to-do form would be.
  // Understands: today, tomorrow, next week, in N days/weeks/months, a weekday (the next one), 14 Mar / March 14 / 14th March
  // (with an optional year; a date already past this year means next year), 14/3, 2026-11-03; a time (9am, 9:30pm, 14:00,
  // noon); "every day/weekday/week/month/year", daily, weekly, monthly, yearly, "every monday"; and !high or !low. What is left
  // is the title. Dates are the owner's own day. -> { title, due, time, recur, priority, parts: [words about what was understood] }
  function parseQuick(text, today) {
    var original = String(text || "").replace(/\s+/g, " ").trim();
    var s = " " + original + " ";
    var out = { title: "", due: "", time: "", recur: "", priority: "normal", parts: [] };
    function cut(re, fn) {
      var m = re.exec(s);
      if (!m) return false;
      if (fn(m) === false) return false;
      s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
      return true;
    }
    // priority
    cut(/\s!(high|low)\b/i, function (m) { out.priority = m[1].toLowerCase(); out.parts.push(out.priority + " priority"); });
    cut(/\s!!+\s/, function () { out.priority = "high"; out.parts.push("high priority"); });
    // repeats
    var weekdayRepeat = null;
    if (!cut(/\bevery\s+(day|weekday|weekdays|week|month|year)\b/i, function (m) {
      var w = m[1].toLowerCase();
      out.recur = w === "day" ? "daily" : w === "week" ? "weekly" : w === "month" ? "monthly" : w === "year" ? "yearly" : "weekdays";
    })) {
      if (!cut(/\bevery\s+(?:other\s+)?(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i, function (m) { out.recur = "weekly"; weekdayRepeat = DAY_WORDS[m[1].toLowerCase()]; })) {
        cut(/\b(daily|weekdays|weekly|monthly|yearly|annually)\b/i, function (m) {
          var w = m[1].toLowerCase();
          out.recur = w === "daily" ? "daily" : w === "weekdays" ? "weekdays" : w === "weekly" ? "weekly" : w === "monthly" ? "monthly" : "yearly";
        });
      }
    }
    if (out.recur) out.parts.push(repeatText(out.recur).toLowerCase());
    // time
    if (!cut(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, function (m) {
      var h = +m[1], mi = m[2] ? +m[2] : 0;
      if (h < 1 || h > 12 || mi > 59) return false;
      if (m[3].toLowerCase() === "pm" && h < 12) h += 12;
      if (m[3].toLowerCase() === "am" && h === 12) h = 0;
      out.time = pad(h) + ":" + pad(mi);
    })) {
      if (!cut(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/, function (m) { out.time = pad(+m[1]) + ":" + m[2]; })) {
        cut(/\b(?:at\s+)?noon\b/i, function () { out.time = "12:00"; });
      }
    }
    // date
    var base = isYmd(today) ? today : ymd(new Date());
    var lead = "(?:\\b(?:on|by|due|before|until)\\s+)?";
    var dated = false;
    function setDate(d) { if (isYmd(d)) { out.due = d; dated = true; } else return false; }
    cut(new RegExp(lead + "\\b(\\d{4})-(\\d{2})-(\\d{2})\\b"), function (m) { return setDate(m[1] + "-" + m[2] + "-" + m[3]); });
    if (!dated) cut(new RegExp(lead + "\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+" + MONTH_RE + "(?:\\s+(\\d{4}))?\\b", "i"), function (m) { return setByMonth(+m[1], MONTH_WORDS[m[2].toLowerCase()], m[3]); });
    if (!dated) cut(new RegExp(lead + "\\b" + MONTH_RE + "\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b", "i"), function (m) { return setByMonth(+m[2], MONTH_WORDS[m[1].toLowerCase()], m[3]); });
    if (!dated) cut(new RegExp(lead + "\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b"), function (m) { return setByMonth(+m[1], +m[2] - 1, m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : ""); });
    function setByMonth(day, month, year) {
      if (month === undefined || month < 0 || month > 11 || day < 1 || day > 31) return false;
      var y = year ? +year : +base.slice(0, 4);
      var d = y + "-" + pad(month + 1) + "-" + pad(day);
      if (!isYmd(d)) return false;
      if (!year && d < base) d = (y + 1) + "-" + pad(month + 1) + "-" + pad(day);
      return setDate(d);
    }
    // "every month on the 1st": the next such day
    if (!dated && out.recur === "monthly") cut(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i, function (m) {
      var dom = +m[1];
      if (dom < 1 || dom > 31) return false;
      var y = +base.slice(0, 4), mo = +base.slice(5, 7) - 1;
      for (var k = 0; k < 2; k++) {
        var last = new Date(Date.UTC(y, mo + k + 1, 0)).getUTCDate();
        var c = addMonths(y + "-" + pad(mo + 1) + "-01", k).slice(0, 8) + pad(Math.min(dom, last));
        if (c >= base) return setDate(c);
      }
      return false;
    });
    if (!dated) cut(/\b(?:on\s+|by\s+)?(?:today|tonight)\b/i, function () { return setDate(base); });
    if (!dated) cut(/\b(?:on\s+|by\s+)?(?:tomorrow|tmrw|tmr)\b/i, function () { return setDate(addDays(base, 1)); });
    if (!dated) cut(/\b(?:in\s+(\d{1,3})\s+(day|days|week|weeks|month|months))\b/i, function (m) {
      var n = +m[1], u = m[2].toLowerCase();
      return setDate(u.charAt(0) === "d" ? addDays(base, n) : u.charAt(0) === "w" ? addDays(base, 7 * n) : addMonths(base, n));
    });
    if (!dated) cut(/\bnext\s+week\b/i, function () { return setDate(addDays(base, 7)); });
    if (!dated) cut(/\bnext\s+month\b/i, function () { return setDate(addMonths(base, 1)); });
    if (!dated) cut(new RegExp("\\b(?:(on|next|this|by)\\s+)?" + DAY_RE + "\\b", "i"), function (m) {
      var w = DAY_WORDS[m[2].toLowerCase()], full = m[2].length > 3 && !/^(tues|thurs|thur)$/i.test(m[2]);
      if (!full && !m[1]) return false;   // "sat", "sun", "mon" on their own are more likely words in the title
      var diff = (w - weekday(base) + 7) % 7;
      if (diff === 0) diff = 7;
      return setDate(addDays(base, diff));
    });
    if (!dated && weekdayRepeat !== null) { var df = (weekdayRepeat - weekday(base) + 7) % 7; setDate(addDays(base, df)); }
    if (!dated && (out.recur || out.time)) setDate(base);   // a repeat or a time with no day starts today
    if (out.due) out.parts.unshift(shortDate(out.due));
    if (out.time) out.parts.push(timeText(out.time));
    var title = s.replace(/\s+/g, " ").replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "").replace(/^(?:to|and|then)\s+/i, "").replace(/\s+(?:at|on|by|due|for|in|every)$/i, "").trim();
    if (!title) title = original;
    out.title = title.charAt(0).toUpperCase() + title.slice(1);
    return out;
  }

  // ---- the forms---------------------------------------------------------------

  // The Details text for a renewal: whatever the owner already wrote, then the lines the Calendar reads.
  function buildDetails(extra, f) {
    var lines = [];
    if (extra && String(extra).trim()) lines.push(String(extra).trim(), "");
    lines.push("Date: " + f.state);
    if (f.where) lines.push("Where: " + f.where);
    if (f.link) lines.push("Link: " + f.link);
    if (f.breaks) lines.push("Breaks: " + f.breaks);
    if (f.leadDays !== "" && f.leadDays !== null && f.leadDays !== undefined) lines.push("Lead: " + f.leadDays);
    if (f.renewed) lines.push("Renewed: " + f.renewed);
    return lines.join("\n");
  }

  // Checks the renewal form and builds the body for the Ops board. -> { error, field } or { body }
  function renewalBody(f, extra, isNew) {
    var title = String(f.title || "").trim();
    if (!title) return { error: "Give the renewal a name.", field: "title" };
    if (title.length > 120) return { error: "Keep the name under 120 characters.", field: "title" };
    if (f.due && !isYmd(f.due)) return { error: "That date doesn’t look right.", field: "due" };
    if (f.state === "needed" && f.due) f = Object.assign({}, f, { state: "estimated" });
    if (!f.due && f.state !== "auto") f = Object.assign({}, f, { state: "needed" });
    if (f.link && !/^https:\/\/[^\s"'<>]{4,300}$/.test(f.link)) return { error: "The link needs to start with https://", field: "link" };
    if (f.renewed && !isYmd(f.renewed)) return { error: "The “last renewed” date doesn’t look right.", field: "renewed" };
    if (f.leadDays !== "" && f.leadDays !== null && f.leadDays !== undefined && !(+f.leadDays >= 0 && +f.leadDays <= 365 && Math.floor(+f.leadDays) === +f.leadDays)) return { error: "Lead time is a whole number of days, 0 to 365.", field: "leadDays" };
    var kind = KINDS.some(function (k) { return k[0] === f.kind; }) ? f.kind : "other";
    var details = buildDetails(extra, f);
    if (details.length > 6000) return { error: "That is too much text for one renewal.", field: "where" };
    var body = { title: title, targets: ["renewal", kind], due: f.due || "", details: details };
    if (isNew) { body.category = "security"; body.lane = "backlog"; body.status = "scheduled"; body.owner = "you"; body.next = f.where ? "Renew: " + f.where : "Renew before it runs out."; }
    return { body: body };
  }

  // "it_ab12cd34" or "ka_qcpw87ug", on its own or inside a hub or Knowledgebase address -> { kind, id } | null | { error }
  function parseRef(text) {
    var t = String(text || "").trim();
    if (!t) return null;
    var m = /(?:^|[#/])(it|ka)_([a-z0-9]{6,12})(?:$|[?&#/])/i.exec(t);
    if (!m) return { error: true };
    return { kind: m[1].toLowerCase() === "it" ? "ops" : "kb", id: m[1].toLowerCase() + "_" + m[2].toLowerCase() };
  }
  function refHref(ref) {
    if (!ref) return "";
    return ref.kind === "ops" ? "ops.html#" + ref.id : "https://study.barnyard.site/knowledgebase.html#/a/" + ref.id;
  }

  // Checks the to-do form (the same rules as the Worker, so a mistake is caught before it is sent). -> { error, field } | { body }
  function taskBody(f) {
    var title = String(f.title || "").replace(/\s+/g, " ").trim();
    if (!title) return { error: "Give the to-do a name.", field: "title" };
    if (title.length > 200) return { error: "Keep the name under 200 characters.", field: "title" };
    if (f.due && !isYmd(f.due)) return { error: "That date doesn’t look right.", field: "due" };
    if (f.time && !isTime(f.time)) return { error: "That time doesn’t look right.", field: "time" };
    if (f.time && !f.due) return { error: "A time needs a date.", field: "time" };
    if (f.recur && !f.due) return { error: "A repeat needs a date to start from.", field: "recur" };
    var body = { title: title, notes: String(f.notes || "").trim(), due: f.due || "", time: f.time || "", priority: f.priority || "normal", recur: f.recur || "" };
    if (String(f.ref || "").trim()) {
      var r = parseRef(f.ref);
      if (!r || r.error) return { error: "That isn’t an Ops item or Knowledgebase article. Paste its id (it_… or ka_…) or its address.", field: "ref" };
      body.ref = r.id;
    } else body.ref = "";
    if (body.notes.length > 4000) return { error: "Keep the notes under 4,000 characters.", field: "notes" };
    return { body: body };
  }

  // Checks the event form. -> { error, field } | { body }
  function eventBody(f) {
    var title = String(f.title || "").replace(/\s+/g, " ").trim();
    if (!title) return { error: "Give the event a name.", field: "title" };
    if (title.length > 200) return { error: "Keep the name under 200 characters.", field: "title" };
    if (!isYmd(f.startDate)) return { error: "Pick the day it starts.", field: "startDate" };
    var allDay = !!f.allDay;
    var endDate = f.endDate || f.startDate;
    if (!isYmd(endDate)) return { error: "That end date doesn’t look right.", field: "endDate" };
    if (endDate < f.startDate) return { error: "It can’t end before it starts.", field: "endDate" };
    if (daysBetween(f.startDate, endDate) >= 366) return { error: "Keep an event under a year long.", field: "endDate" };
    var startTime = allDay ? "" : (f.startTime || "");
    var endTime = allDay ? "" : (f.endTime || "");
    if (!allDay && !isTime(startTime)) return { error: "Pick a start time, or tick “All day”.", field: "startTime" };
    if (endTime && !isTime(endTime)) return { error: "That end time doesn’t look right.", field: "endTime" };
    if (endTime && endDate === f.startDate && endTime < startTime) return { error: "It can’t end before it starts.", field: "endTime" };
    return { body: { title: title, notes: String(f.notes || "").trim(), startDate: f.startDate, startTime: startTime, endDate: endDate, endTime: endTime, recur: f.recur || "" } };
  }

  var api = {
    KINDS: KINDS, STATES: STATES, VIEWS: VIEWS, RECURRENCES: RECURRENCES, PRIORITIES: PRIORITIES, DAY_NAMES: DAY_NAMES, MONTH_NAMES: MONTH_NAMES, STATE_BADGE: STATE_BADGE,
    pad: pad, ymd: ymd, isYmd: isYmd, isTime: isTime, daysBetween: daysBetween, addDays: addDays, addMonths: addMonths, weekday: weekday, mondayOf: mondayOf,
    longDate: longDate, shortDate: shortDate, timeText: timeText, relativeText: relativeText, kindTitle: kindTitle, recurTitle: recurTitle, repeatText: repeatText,
    nextOccurrence: nextOccurrence, startDates: startDates, eventDays: eventDays, eventTimeText: eventTimeText,
    urgency: urgency, entriesByDate: entriesByDate, sortInDay: sortInDay, filterKind: filterKind, agenda: agenda, upcoming: upcoming, renewalGroups: renewalGroups,
    groupTasks: groupTasks, widgetTasks: widgetTasks, taskDueText: taskDueText, dueCount: dueCount, monthGrid: monthGrid, weekDays: weekDays,
    icsEscape: icsEscape, icsFold: icsFold, buildIcs: buildIcs, buildDetails: buildDetails, renewalBody: renewalBody, parseRef: parseRef, refHref: refHref,
    taskBody: taskBody, eventBody: eventBody, parseQuick: parseQuick, googleEntries: googleEntries
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardCalendarLogic = api;
})(typeof window !== "undefined" ? window : this);
