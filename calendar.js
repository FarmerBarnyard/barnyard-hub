// The Calendar page (calendar.html): everything that runs out or comes due, in one place.
//
// Reads GET /hub/renewals (owner only; see ClaudeRepo's cloudflare-worker/src/hub-routes.js):
//   renewals   every Ops board item with the target "renewal" (secrets, keys, tokens, the domain, licences ...) and the
//              keys that expire, soonest first, then the ones that still need a date
//   dueItems   the other open Ops items that have a Due date
//
// Where the data lives: renewals are Ops board items, kept on the server in the board's Durable Object, so clearing this
// browser loses nothing, and they are part of the hub's backup (GET /hub/export). This page keeps only two small
// preferences in this browser (the last view and the kind filter), and says so at the foot of the page.
// Adding or editing a renewal talks to the Ops board's own API (POST/PATCH /ops/items), the same one the Ops board uses.
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout of this file: 1. pure helpers (exported for test/calendar.test.js; no DOM, no network)
//                      2. data   3. rendering   4. events

(function () {
  "use strict";

  var API = "https://api.barnyard.site/hub";
  var OPS = "https://api.barnyard.site/ops";
  var POLL_MS = 300000;
  var PREF_KEY = "barnyard-calendar-prefs";

  // ---- 1. pure helpers ------------------------------------------------------

  var KINDS = [["secret", "Secret"], ["key", "Key"], ["token", "Token"], ["certificate", "Certificate"], ["domain", "Domain"], ["licence", "Licence"], ["account", "Account"], ["other", "Other"]];
  var STATES = [["known", "Date is known"], ["estimated", "Date is an estimate"], ["planned", "Planned rotation date"], ["needed", "Date still needed"], ["auto", "Renews itself"]];
  var STATE_BADGE = { known: "", estimated: "Estimated", planned: "Planned", needed: "Date needed", auto: "Renews itself" };
  var VIEWS = [["today", "Today"], ["month", "Month"], ["next", "Next up"], ["nodate", "No date yet"]];
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function kindTitle(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return KINDS[i][1]; return "Other"; }

  // Local date parts as YYYY-MM-DD (the person's own day, not UTC).
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  // A real calendar date (2026-02-30 is not one, even though Date.UTC would roll it over).
  function isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(utc(s));
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) === s;
  }
  function utc(s) { var p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function daysBetween(fromYmd, toYmd) { return Math.round((utc(toYmd) - utc(fromYmd)) / 86400000); }
  function addDays(s, n) { var d = new Date(utc(s) + n * 86400000); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }

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

  // How loud a renewal is today: red inside a week or overdue, amber inside a month, otherwise calm. A date still
  // needed, or one that renews itself, has no urgency to show.
  function urgency(entry, today) {
    if (entry.type === "item") {
      var di = daysBetween(today, entry.due);
      return di < 0 ? "alert" : di <= 3 ? "attn" : "";
    }
    if (!entry.due || entry.state === "needed" || entry.state === "auto") return "";
    var d = daysBetween(today, entry.due);
    return d <= 7 ? "alert" : d <= 30 ? "attn" : "ok";
  }

  // Renewals and the other dated Ops items as calendar entries, keyed by date.
  function entriesByDate(renewals, dueItems) {
    var map = {};
    function put(date, e) { (map[date] = map[date] || []).push(e); }
    (renewals || []).forEach(function (r) { if (isYmd(r.due)) put(r.due, { type: "renewal", id: r.id, label: r.label, kind: r.kind, state: r.state, due: r.due, ref: r }); });
    (dueItems || []).forEach(function (d) { if (isYmd(d.due)) put(d.due, { type: "item", id: d.id, label: d.title, kind: "", state: "known", due: d.due, ref: d }); });
    return map;
  }

  function filterKind(renewals, kind) {
    if (!kind || kind === "all") return renewals || [];
    return (renewals || []).filter(function (r) { return r.kind === kind; });
  }

  // The Today view's groups: what is overdue, what is due today, what falls in the next week.
  function agenda(renewals, dueItems, today) {
    var out = { overdue: [], today: [], week: [] };
    var map = entriesByDate(renewals, dueItems);
    Object.keys(map).sort().forEach(function (date) {
      var d = daysBetween(today, date);
      var bucket = d < 0 ? "overdue" : d === 0 ? "today" : d <= 7 ? "week" : null;
      if (!bucket) return;
      map[date].forEach(function (e) {
        if (e.type === "renewal" && (e.state === "auto")) return;
        out[bucket].push(e);
      });
    });
    return out;
  }

  // The "Next up" list: dated renewals soonest first (overdue first of all), grouped under month headings.
  function nextUp(renewals, today) {
    var dated = (renewals || []).filter(function (r) { return isYmd(r.due) && r.state !== "auto"; });
    dated.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.label.localeCompare(b.label); });
    var groups = [], last = null;
    dated.forEach(function (r) {
      var key = daysBetween(today, r.due) < 0 ? "Overdue" : MONTH_NAMES[+r.due.slice(5, 7) - 1] + " " + r.due.slice(0, 4);
      if (!last || last.title !== key) { last = { title: key, items: [] }; groups.push(last); }
      last.items.push(r);
    });
    return groups;
  }

  // Renewals with no date to act on: still needed, and the ones that renew themselves.
  function noDate(renewals) {
    var needed = [], auto = [];
    (renewals || []).forEach(function (r) {
      if (r.state === "auto") auto.push(r);
      else if (!isYmd(r.due) || r.state === "needed") needed.push(r);
    });
    return { needed: needed, auto: auto };
  }

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

  // How many things need looking at now (overdue or due today), for the page title.
  function dueCount(renewals, dueItems, today) {
    var a = agenda(renewals, dueItems, today);
    return a.overdue.length + a.today.length;
  }

  // ---- the .ics file ---------------------------------------------------------------------------

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

  // One all-day event for each dated renewal, each with a reminder 30 days and 7 days ahead (at 9 in the morning).
  function buildIcs(renewals, nowMs, hubUrl) {
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Barnyard//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Barnyard renewals"];
    (renewals || []).forEach(function (r) {
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
      [["P29DT15H", "30 days"], ["P6DT15H", "7 days"]].forEach(function (a) {
        lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(r.label + " runs out in " + a[1]), "TRIGGER:-" + a[0], "END:VALARM");
      });
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }

  // ---- the add / edit form -----------------------------------------------------------------------

  // The Details text for an item: whatever the owner already wrote, then the lines the Calendar reads.
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

  // Checks the form and builds the body for the Ops board. -> { error, field } or { body }
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

  var helpers = {
    KINDS: KINDS, STATES: STATES, VIEWS: VIEWS, pad: pad, ymd: ymd, isYmd: isYmd, daysBetween: daysBetween, addDays: addDays, relativeText: relativeText,
    urgency: urgency, entriesByDate: entriesByDate, filterKind: filterKind, agenda: agenda, nextUp: nextUp, noDate: noDate, monthGrid: monthGrid,
    dueCount: dueCount, icsEscape: icsEscape, icsFold: icsFold, buildIcs: buildIcs, buildDetails: buildDetails, renewalBody: renewalBody, kindTitle: kindTitle
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", renewals: [], dueItems: [], partial: false, view: "today", kind: "all", month: null, open: null };
  var lastFocus = null;

  function readPrefs() {
    try {
      var p = JSON.parse(window.localStorage.getItem(PREF_KEY) || "{}");
      if (VIEWS.some(function (v) { return v[0] === p.view; })) model.view = p.view;
      if (p.kind === "all" || KINDS.some(function (k) { return k[0] === p.kind; })) model.kind = p.kind;
    } catch (e) { /* no stored preference, or storage is off: the defaults are fine */ }
  }
  function savePrefs() {
    try { window.localStorage.setItem(PREF_KEY, JSON.stringify({ view: model.view, kind: model.kind })); } catch (e) { /* fine without it */ }
  }

  function load() {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(API + "/renewals", { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (r.status === 401) { model.state = "guest"; return; }
        if (r.status === 403) { model.state = "forbidden"; return; }
        if (!r.ok) { model.state = model.renewals.length || model.dueItems.length ? "ok" : "error"; return; }
        return r.json().then(function (d) {
          model.renewals = Array.isArray(d.renewals) ? d.renewals : [];
          model.dueItems = Array.isArray(d.dueItems) ? d.dueItems : [];
          model.partial = !!d.partial;
          model.state = "ok";
        });
      }, function () { clearTimeout(timer); model.state = model.renewals.length || model.dueItems.length ? "ok" : "error"; })
      .then(render);
  }

  function opsRequest(method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return fetch(OPS + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) { var err = new Error((data && data.error) || "request_failed"); err.code = (data && data.error) || null; err.field = (data && data.field) || null; throw err; }
        return data;
      });
    });
  }

  function saveMessage(err) {
    if (err.code === "secret_detected") return "That looks like a secret or a key, and the Ops board won’t store it. Describe where it lives instead of pasting it.";
    if (err.code === "recent_sign_in_required") return "Sign in again to save changes, then try once more.";
    if (err.code === "unauthenticated" || err.code === "forbidden") return "You’re not signed in as the owner, so the change wasn’t saved.";
    return "Couldn’t save that just now. Nothing was changed.";
  }

  // ---- 3. rendering ---------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function today() { return ymd(new Date()); }

  function message(text, linkText, href) {
    var box = $("cal-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function longDate(s) {
    var d = new Date(utc(s));
    return DAY_NAMES[(d.getUTCDay() + 6) % 7] + " " + d.getUTCDate() + " " + MONTH_NAMES[d.getUTCMonth()].slice(0, 3) + " " + d.getUTCFullYear();
  }

  function stateChip(state) {
    var t = STATE_BADGE[state];
    return t ? h("span", "chip", t) : null;
  }

  // One clickable row for a renewal or an Ops item.
  function row(e, t) {
    var days = daysBetween(t, e.due);
    var tone = urgency(e, t);
    var el = e.type === "item" ? h("a", "cal-row") : h("button", "cal-row");
    if (e.type === "item") el.href = e.ref.href || "ops.html"; else el.type = "button";
    el.appendChild(h("span", "cal-dot" + (tone ? " " + tone : "")));
    el.appendChild(h("b", null, e.label));
    el.appendChild(h("span", "chip", e.type === "item" ? "Ops item" : kindTitle(e.kind)));
    var sc = e.type === "renewal" ? stateChip(e.state) : null;
    if (sc) el.appendChild(sc);
    el.appendChild(h("span", "dim cal-when", longDate(e.due) + " · " + relativeText(days)));
    if (e.type === "renewal") el.addEventListener("click", function () { openRenewal(e.ref); });
    return el;
  }

  function section(title, note) {
    var s = h("section", "cal-section");
    var head = h("div", "sec-head");
    head.appendChild(h("h2", null, title));
    if (note) head.appendChild(h("span", "sub", note));
    s.appendChild(head);
    return s;
  }

  function list(entries, t) {
    var ul = h("div", "cal-list");
    entries.forEach(function (e) { ul.appendChild(row(e, t)); });
    return ul;
  }

  function renderToday(root, renewals, t) {
    var a = agenda(renewals, model.dueItems, t);
    var nothing = !a.overdue.length && !a.today.length && !a.week.length;
    root.appendChild(h("p", "cal-lead", "Today is " + longDate(t) + "."));
    if (a.overdue.length) { var o = section("Overdue", "these are past their date"); o.appendChild(list(a.overdue, t)); root.appendChild(o); }
    var td = section("Due today");
    if (a.today.length) td.appendChild(list(a.today, t)); else td.appendChild(h("p", "dim", "Nothing is due today."));
    root.appendChild(td);
    var wk = section("The next 7 days");
    if (a.week.length) wk.appendChild(list(a.week, t)); else wk.appendChild(h("p", "dim", "Nothing falls in the next week."));
    root.appendChild(wk);
    var up = nextUp(renewals, t);
    var first = null;
    up.forEach(function (g) { g.items.forEach(function (r) { if (!first && daysBetween(t, r.due) > 7) first = r; }); });
    if (nothing && first) root.appendChild(h("p", "dim", "Next renewal: " + first.label + ", " + relativeText(daysBetween(t, first.due)) + " (" + longDate(first.due) + ")."));
    var nd = noDate(renewals).needed.length;
    if (nd) {
      var p = h("p", "dim", nd + (nd === 1 ? " renewal still needs a date. " : " renewals still need a date. "));
      var b = h("button", "btn btn-sm", "See them");
      b.type = "button";
      b.addEventListener("click", function () { setView("nodate"); });
      p.appendChild(b);
      root.appendChild(p);
    }
  }

  function renderMonth(root, renewals, t) {
    var m = model.month;
    var grid = monthGrid(m.year, m.month);
    var map = entriesByDate(renewals, model.dueItems);
    var title = h("h2", "cal-month-title", grid.label);
    title.id = "cal-month-title";
    root.appendChild(title);
    var scroll = h("div", "cal-scroll");
    var table = h("table", "cal-month");
    table.setAttribute("aria-labelledby", "cal-month-title");
    var thead = h("thead"), hr = h("tr");
    DAY_NAMES.forEach(function (n) { var th = h("th", null, n); th.scope = "col"; hr.appendChild(th); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = h("tbody");
    grid.weeks.forEach(function (week) {
      var tr = h("tr");
      week.forEach(function (c) {
        var td = h("td", "cal-day" + (c.inMonth ? "" : " out") + (c.date === t ? " today" : ""));
        var num = h("span", "cal-num", String(c.day));
        td.appendChild(num);
        var es = map[c.date] || [];
        es.slice(0, 3).forEach(function (e) {
          var tone = urgency(e, t);
          var el = e.type === "item" ? h("a", "cal-ev item") : h("button", "cal-ev" + (tone ? " " + tone : ""));
          if (e.type === "item") el.href = e.ref.href || "ops.html"; else el.type = "button";
          el.textContent = e.label;
          el.setAttribute("aria-label", longDate(c.date) + ": " + e.label + (e.type === "item" ? " (Ops item)" : ", " + kindTitle(e.kind)));
          if (e.type === "renewal") el.addEventListener("click", function () { openRenewal(e.ref); });
          td.appendChild(el);
        });
        if (es.length > 3) {
          var more = h("button", "cal-more", "+" + (es.length - 3) + " more");
          more.type = "button";
          more.addEventListener("click", function () { openDay(c.date, es); });
          td.appendChild(more);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    root.appendChild(scroll);
    root.appendChild(h("p", "dim cal-keys", "Keys: t is today, ← and → change month, n adds a renewal, Esc closes the details."));
  }

  function renderNext(root, renewals, t) {
    var groups = nextUp(renewals, t);
    if (!groups.length) { root.appendChild(h("p", "dim", "No renewals with a date yet.")); return; }
    groups.forEach(function (g) {
      var s = section(g.title);
      s.appendChild(list(g.items.map(function (r) { return { type: "renewal", id: r.id, label: r.label, kind: r.kind, state: r.state, due: r.due, ref: r }; }), t));
      root.appendChild(s);
    });
  }

  function renderNoDate(root, renewals) {
    var nd = noDate(renewals);
    var s = section("Date still needed", "add the date from the portal and it moves onto the calendar");
    if (!nd.needed.length) s.appendChild(h("p", "dim", "Every renewal has a date."));
    nd.needed.forEach(function (r) {
      var el = h("button", "cal-row");
      el.type = "button";
      el.appendChild(h("span", "cal-dot"));
      el.appendChild(h("b", null, r.label));
      el.appendChild(h("span", "chip", kindTitle(r.kind)));
      if (r.where) el.appendChild(h("span", "dim cal-when", r.where));
      el.addEventListener("click", function () { openRenewal(r); });
      s.appendChild(el);
    });
    root.appendChild(s);
    if (nd.auto.length) {
      var a = section("Renews itself", "no action needed, listed so you know");
      nd.auto.forEach(function (r) {
        var el = h("button", "cal-row");
        el.type = "button";
        el.appendChild(h("span", "cal-dot"));
        el.appendChild(h("b", null, r.label));
        el.appendChild(h("span", "chip", kindTitle(r.kind)));
        if (r.where) el.appendChild(h("span", "dim cal-when", r.where));
        el.addEventListener("click", function () { openRenewal(r); });
        a.appendChild(el);
      });
      root.appendChild(a);
    }
  }

  function renderTabs() {
    var box = $("cal-tabs");
    clear(box);
    VIEWS.forEach(function (v) {
      var b = h("button", "cal-tab" + (model.view === v[0] ? " on" : ""), v[1]);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", model.view === v[0] ? "true" : "false");
      b.addEventListener("click", function () { setView(v[0]); });
      box.appendChild(b);
    });
    $("cal-nav").hidden = model.view !== "month";
  }

  function renderFilter() {
    var sel = $("cal-kind");
    if (sel.options.length) { sel.value = model.kind; return; }
    var all = h("option", null, "All kinds"); all.value = "all"; sel.appendChild(all);
    KINDS.forEach(function (k) { var o = h("option", null, k[1]); o.value = k[0]; sel.appendChild(o); });
    sel.value = model.kind;
  }

  function render() {
    renderTabs();
    renderFilter();
    var root = $("cal-root");
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see the calendar.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error") { message("Couldn’t reach the Worker just now. It will try again shortly."); return; }
    clear(root);
    var t = today();
    var renewals = filterKind(model.renewals, model.kind);
    if (model.partial) root.appendChild(h("p", "cal-warn", "Some keys couldn’t be read just now, so the list may be missing a few."));
    if (model.view === "today") renderToday(root, renewals, t);
    else if (model.view === "month") renderMonth(root, renewals, t);
    else if (model.view === "next") renderNext(root, renewals, t);
    else renderNoDate(root, renewals);
    var n = dueCount(model.renewals, model.dueItems, t);
    document.title = (n ? "(" + n + ") " : "") + "Calendar · Barnyard";
    var foot = $("cal-foot");
    foot.textContent = "Renewals are Ops board items with the target “renewal”. They live on the server, so clearing this browser loses nothing, and they are included in the hub’s backup. This page remembers your last view and filter in this browser only.";
  }

  // ---- the drawer ---------------------------------------------------------------------------------

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
    model.open = null;
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

  function openDay(date, entries) {
    var body = openDrawer(longDate(date));
    var t = today();
    body.appendChild(list(entries, t));
  }

  function openRenewal(r) {
    model.open = r.id;
    var body = openDrawer(r.label);
    var t = today();
    var top = h("div", "cal-chips");
    top.appendChild(h("span", "chip", kindTitle(r.kind)));
    var sc = stateChip(r.state);
    if (sc) top.appendChild(sc);
    body.appendChild(top);
    if (isYmd(r.due)) {
      var days = daysBetween(t, r.due);
      var line = h("p", "cal-date " + urgency({ type: "renewal", due: r.due, state: r.state }, t), longDate(r.due) + " · " + relativeText(days));
      body.appendChild(line);
    } else {
      body.appendChild(h("p", "cal-date", r.state === "auto" ? "Renews itself." : "No date yet."));
    }
    if (r.state === "estimated") body.appendChild(h("p", "dim", "This date is an estimate. Confirm the exact one at the source, then edit it here."));
    if (r.state === "planned") body.appendChild(h("p", "dim", "A planned rotation date from the security review calendar, not a hard expiry."));
    fact(body, "How to renew it", r.where);
    fact(body, "Portal", r.link, r.link);
    fact(body, "If it lapses", r.breaks);
    fact(body, "Lead time", r.leadDays !== null && r.leadDays !== undefined ? r.leadDays + (r.leadDays === 1 ? " day" : " days") + " of notice" : "");
    fact(body, "Last renewed", r.lastRenewed ? longDate(r.lastRenewed) : "");
    fact(body, "Note", r.note);
    var actions = h("div", "cal-actions");
    var open = h("a", "btn btn-sm", r.source === "ops" ? "Open the Ops item" : "Open where it’s managed");
    open.href = r.href || "ops.html";
    actions.appendChild(open);
    if (r.source === "ops") {
      var edit = h("button", "btn btn-primary btn-sm", "Edit");
      edit.type = "button";
      edit.addEventListener("click", function () { openForm(r); });
      actions.appendChild(edit);
    } else {
      body.appendChild(h("p", "dim", "This key is made and renewed where it’s managed, so there is nothing to edit here."));
    }
    body.appendChild(actions);
  }

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

  function openForm(r) {
    var isNew = !r;
    var body = openDrawer(isNew ? "Add a renewal" : "Edit " + r.label);
    var form = h("form", "cal-form");
    form.noValidate = true;
    var title = field(form, "f-title", "Name", input("text", isNew ? "" : r.label, 120), "For example “Renew the domain”.");
    var kind = h("select", "cal-input");
    KINDS.forEach(function (k) { var o = h("option", null, k[1]); o.value = k[0]; kind.appendChild(o); });
    kind.value = isNew ? "secret" : r.kind;
    field(form, "f-kind", "Kind", kind);
    var due = field(form, "f-due", "Date to act by", input("date", isNew ? "" : r.due), "Leave empty if you don’t know it yet; it will show under “No date yet”.");
    var state = h("select", "cal-input");
    STATES.forEach(function (s) { var o = h("option", null, s[1]); o.value = s[0]; state.appendChild(o); });
    state.value = isNew ? "known" : r.state;
    field(form, "f-state", "How sure is the date", state);
    var where = h("textarea", "cal-input"); where.rows = 3; where.maxLength = 300; where.value = isNew ? "" : r.where;
    field(form, "f-where", "How to renew it", where, "Where to go and what to click. Never paste the secret itself.");
    var link = field(form, "f-link", "Portal link (https)", input("url", isNew ? "" : r.link, 300));
    var breaks = field(form, "f-breaks", "What stops if it lapses", input("text", isNew ? "" : r.breaks, 300));
    var lead = field(form, "f-lead", "Days of notice it needs", input("number", isNew || r.leadDays === null ? "" : String(r.leadDays)));
    lead.min = "0"; lead.max = "365";
    var renewed = field(form, "f-renewed", "Last renewed", input("date", isNew ? "" : r.lastRenewed));
    var err = h("p", "cal-error"); err.setAttribute("role", "alert");
    form.appendChild(err);
    var actions = h("div", "cal-actions");
    var save = h("button", "btn btn-primary btn-sm", "Save"); save.type = "submit";
    var cancel = h("button", "btn btn-sm btn-quiet", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", function () { if (isNew) closeDrawer(); else openRenewal(r); });
    actions.appendChild(save); actions.appendChild(cancel);
    form.appendChild(actions);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      err.textContent = "";
      var res = renewalBody({ title: title.value, kind: kind.value, due: due.value, state: state.value, where: where.value.trim(), link: link.value.trim(), breaks: breaks.value.trim(), leadDays: lead.value, renewed: renewed.value }, isNew ? "" : r.extra, isNew);
      if (res.error) { err.textContent = res.error; var bad = $("f-" + (res.field === "leadDays" ? "lead" : res.field)); if (bad) bad.focus(); return; }
      save.disabled = true;
      var req = isNew ? opsRequest("POST", "/items", res.body) : opsRequest("PATCH", "/items/" + r.id, res.body);
      req.then(function () { closeDrawer(); return load(); }, function (e) { save.disabled = false; err.textContent = saveMessage(e); });
    });
    body.appendChild(form);
    title.focus();
  }

  // ---- 4. events ------------------------------------------------------------------------------------

  function setView(v) {
    model.view = v;
    savePrefs();
    render();
  }

  function stepMonth(n) {
    var m = model.month;
    var d = new Date(Date.UTC(m.year, m.month + n, 1));
    model.month = { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    render();
  }

  function goToday() {
    var d = new Date();
    model.month = { year: d.getFullYear(), month: d.getMonth() };
    if (model.view === "month") render(); else setView("today");
  }

  function downloadIcs() {
    var text = buildIcs(model.renewals, Date.now(), "https://dashboard.barnyard.site/calendar.html");
    var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "barnyard-renewals.ics";
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
    else if (ev.key === "n") openForm(null);
    else if (ev.key === "ArrowLeft" && model.view === "month") stepMonth(-1);
    else if (ev.key === "ArrowRight" && model.view === "month") stepMonth(1);
  }

  function boot() {
    readPrefs();
    var d = new Date();
    model.month = { year: d.getFullYear(), month: d.getMonth() };
    $("cal-add").addEventListener("click", function () { openForm(null); });
    $("cal-ics").addEventListener("click", downloadIcs);
    $("cal-prev").addEventListener("click", function () { stepMonth(-1); });
    $("cal-next").addEventListener("click", function () { stepMonth(1); });
    $("cal-today").addEventListener("click", goToday);
    $("cal-drawer-close").addEventListener("click", closeDrawer);
    $("cal-kind").addEventListener("change", function () { model.kind = $("cal-kind").value; savePrefs(); render(); });
    document.addEventListener("keydown", onKey);
    renderTabs();
    renderFilter();
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load();
      setInterval(function () { if (!document.hidden && model.state === "ok") load(); }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardCalendar = helpers;
})();
