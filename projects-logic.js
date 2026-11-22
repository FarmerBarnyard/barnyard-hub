// The Projects page's rules, with no DOM and no network (projects.js uses them; test/projects.test.js covers them).
//
// The page shows one project at a time. A project is a small config object in projects-data.js (its name, the prefix its Ops board items
// start with, and its planning data). Everything here turns the Ops board's items plus that config into the model the page draws:
// which items belong to the project, the phases in order, counts per lane, the next due date, each phase's steps split into "yours" and
// "Claude's", the timeline's grid placement, and the next dated sitting.
//
// Nothing here writes to the board. Item text is data: the page puts it on screen with textContent only.
//
// Browser: window.BarnyardProjectsLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var DAY_MS = 86400000;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var ITEM_ID = /^it_[a-z0-9]{8}$/;

  var LANE_TITLE = { in_progress: "In progress", soaking: "Soaking and monitoring", waiting: "Waiting on you", backlog: "Backlog", done: "Done" };
  var STATUS_TITLE = {
    investigating: "Investigating", building: "Building", reviewing: "Reviewing", soaking: "Soaking", monitoring: "Monitoring",
    watching: "Watching", decision_needed: "Decision needed", scheduled: "Scheduled", planned: "Planned", idea: "Idea",
    deferred: "Deferred", blocked: "Blocked", done: "Done", rejected: "Rejected"
  };
  var STATUS_TONE = {
    investigating: "info", building: "info", reviewing: "info", soaking: "ok", monitoring: "ok", watching: "ok",
    decision_needed: "attn", scheduled: "attn", planned: "hollow", idea: "hollow", deferred: "hollow", blocked: "alert", done: "ok"
  };
  var CONFIDENCE = {
    ver: { word: "verified", about: "Checked against the provider's own page." },
    doc: { word: "doc", about: "Taken from a Back End or Security design document." },
    est: { word: "estimate", about: "A rough planning estimate. Check a quote or the price page before spending." }
  };
  var KINDS = ["build", "owner", "dash", "soft"];

  // ---- dates (plain YYYY-MM-DD strings, in the viewer's own calendar) -----------------------------------------------------------

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function dateString(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  // A real calendar date: 2026-13-40 and 2026-02-30 are not (the day must survive a round trip through Date).
  function isDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    return d.getUTCFullYear() === +s.slice(0, 4) && d.getUTCMonth() === +s.slice(5, 7) - 1 && d.getUTCDate() === +s.slice(8, 10);
  }
  function dayNumber(s) { return Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS); }
  // Whole days from `today` to `date` (negative is past); null when either is not a date.
  function daysUntil(date, today) { return isDate(date) && isDate(today) ? dayNumber(date) - dayNumber(today) : null; }
  function shortDate(s) { return isDate(s) ? (+s.slice(8, 10)) + " " + MONTHS[+s.slice(5, 7) - 1] + " " + s.slice(0, 4) : ""; }

  // "23 Nov 2026" plus how far away it is, and a tone the page colours: overdue | soon (two days or fewer) | later.
  function dueInfo(due, today) {
    var n = daysUntil(due, today);
    if (n === null) return null;
    var rel = n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 1 ? "in " + n + " days" : Math.abs(n) + " days overdue";
    return { date: shortDate(due), rel: rel, text: shortDate(due) + " · " + rel, tone: n < 0 ? "overdue" : n <= 2 ? "soon" : "later", days: n };
  }

  // ---- which items belong to a project -------------------------------------------------------------------------------------------

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // project = { prefix: "RL ", masterPrefix: "RL roadmap: master", phasePrefix: "RL R", costsPhase: 10 }
  function ownsTitle(title, project) { return String(title || "").indexOf(project.prefix) === 0; }

  // "RL R3: Name" -> { n: 3, label: "R3", name: "Name" }; null for anything else.
  function phaseOf(title, project) {
    var m = new RegExp("^" + escapeRe(project.phasePrefix) + "(\\d{1,3})\\s*:\\s*(.*)$").exec(String(title || ""));
    if (!m) return null;
    var short = project.phasePrefix.slice(project.prefix.length) || "";
    return { n: +m[1], label: short + m[1], name: m[2] };
  }
  function isMaster(title, project) {
    return String(title || "").toLowerCase().indexOf(String(project.masterPrefix || "\u0000").toLowerCase()) === 0;
  }

  // The master item's title without its prefix: "RL roadmap: master plan" -> "master plan".
  function masterName(title) { var i = String(title || "").indexOf(":"); return i < 0 ? String(title || "") : String(title).slice(i + 1).trim(); }

  function isOpen(item) { return !!item && item.lane !== "done" && !item.proposal; }

  // Merge the open board and the finished items, dropping repeats by id (the open one wins).
  function mergeItems(open, done) {
    var seen = {}, out = [];
    [open, done].forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (it) {
        if (!it || typeof it.id !== "string" || seen[it.id]) return;
        seen[it.id] = true;
        out.push(it);
      });
    });
    return out;
  }

  // -> { master: item|null, phases: [{ n, label, name, item, open, costs }] sorted R1..R10, extras: [items with the prefix but no phase number] }
  function buildModel(items, project) {
    var master = null, phases = [], extras = [];
    (items || []).forEach(function (it) {
      if (!it || !ownsTitle(it.title, project)) return;
      if (isMaster(it.title, project)) { if (!master || (it.updatedAt || 0) > (master.updatedAt || 0)) master = it; return; }
      var p = phaseOf(it.title, project);
      if (p) phases.push({ n: p.n, label: p.label, name: p.name, item: it, open: isOpen(it), costs: p.n === project.costsPhase });
      else extras.push(it);
    });
    phases.sort(function (a, b) { return a.n - b.n || String(a.item.id).localeCompare(String(b.item.id)); });
    return { master: master, phases: phases, extras: extras };
  }

  // Open phases per lane, and finished ones. Proposals are not work yet, so they are not counted.
  function laneCounts(phases) {
    var c = { in_progress: 0, soaking: 0, waiting: 0, backlog: 0, done: 0, total: 0 };
    phases.forEach(function (p) {
      var it = p.item;
      if (it.proposal) return;
      if (it.lane === "done") c.done++;
      else if (c[it.lane] !== undefined) c[it.lane]++;
      else return;
      c.total++;
    });
    return c;
  }

  // The earliest due date among open phases (overdue ones included, they are the most pressing).
  // -> { phase, due, info, overdue } or null when no open phase has a date. `overdue` counts how many are late.
  function nextDue(phases, today) {
    var best = null, overdue = 0;
    phases.forEach(function (p) {
      if (!isOpen(p.item) || !isDate(p.item.due)) return;
      var n = daysUntil(p.item.due, today);
      if (n < 0) overdue++;
      if (!best || p.item.due < best.due || (p.item.due === best.due && p.n < best.phase.n)) best = { phase: p, due: p.item.due };
    });
    if (!best) return null;
    best.info = dueInfo(best.due, today);
    best.overdue = overdue;
    return best;
  }

  // ---- steps ---------------------------------------------------------------------------------------------------------------------

  // The item's steps split by who does them: { you: [{text, done}], claude: [...], total, done }.
  function splitSteps(item) {
    var out = { you: [], claude: [], total: 0, done: 0 };
    ((item && Array.isArray(item.steps)) ? item.steps : []).forEach(function (st) {
      if (!st || typeof st.text !== "string") return;
      var row = { text: st.text, done: !!st.done };
      (st.who === "you" ? out.you : out.claude).push(row);
      out.total++;
      if (row.done) out.done++;
    });
    return out;
  }
  function openCount(list) { return list.filter(function (s) { return !s.done; }).length; }

  // ---- words ---------------------------------------------------------------------------------------------------------------------

  function laneTitle(lane) { return LANE_TITLE[lane] || String(lane || ""); }
  function statusTitle(status) { return STATUS_TITLE[status] || String(status || "").replace(/_/g, " "); }
  function statusTone(status) { return STATUS_TONE[status] || "hollow"; }

  // The link to the item on the Ops board, or "" when the id is not a board id.
  function itemHref(item) { return item && ITEM_ID.test(String(item.id || "")) ? "ops.html#" + item.id : ""; }

  // The summary shown on a card: the item's own, else the first paragraph of its details, cut at 320 characters.
  function summaryOf(item) {
    if (item.summary) return String(item.summary);
    var first = String(item.details || "").split(/\n\s*\n/)[0].trim();
    return first.length > 320 ? first.slice(0, 319) + "…" : first;
  }

  // Text cut to n characters at a word, with an ellipsis.
  function clip(text, n) {
    var s = String(text || "").trim();
    if (s.length <= n) return s;
    var cut = s.slice(0, n - 1), sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[s.,;:]+$/, "") + "…";
  }

  // ---- the timeline --------------------------------------------------------------------------------------------------------------

  // The month heads: [{ label, index, later }]. `start` is "2026-11"; `months` how many; one more column called "Later" follows.
  // The first month and every January carry their year.
  function monthHeads(timeline) {
    var y = +String(timeline.start).slice(0, 4), m = +String(timeline.start).slice(5, 7) - 1, out = [];
    for (var i = 0; i < timeline.months; i++) {
      var mm = (m + i) % 12, yy = y + Math.floor((m + i) / 12);
      out.push({ label: MONTHS[mm] + (i === 0 || mm === 0 ? " " + String(yy).slice(2) : ""), index: i, later: false, yearStart: mm === 0, name: MONTHS[mm] + " " + yy });
    }
    out.push({ label: "Later", index: timeline.months, later: true, yearStart: false, name: "Later" });
    return out;
  }

  // Which column holds today: the month's index, or -1 when today is before the first month; after the last month it is "Later".
  function currentColumn(timeline, today) {
    if (!isDate(today)) return -1;
    var i = (+today.slice(0, 4) - +String(timeline.start).slice(0, 4)) * 12 + (+today.slice(5, 7) - +String(timeline.start).slice(5, 7));
    if (i < 0) return -1;
    return i >= timeline.months ? timeline.months : i;
  }

  // One row of the timeline as table cells: [{ span, bar|null }] covering all columns (months + Later) exactly once, left to right.
  // A bar is { from, to, label, kind } with from and to the first and last column it covers (0 is the first month). Overlaps are cut so
  // a later bar never sits on an earlier one, and a bar past the last column is cut to it.
  function rowCells(row, timeline) {
    var cols = timeline.months + 1, cells = [], at = 0;
    var bars = (row.bars || []).filter(function (b) { return b && isFinite(b.from) && isFinite(b.to); })
      .map(function (b) { return { from: Math.max(0, b.from | 0), to: Math.min(cols - 1, b.to | 0), label: b.label, kind: KINDS.indexOf(b.kind) < 0 ? "build" : b.kind }; })
      .sort(function (a, b) { return a.from - b.from; });
    bars.forEach(function (b) {
      var from = Math.max(b.from, at);
      if (b.to < from) return;
      if (from > at) cells.push({ span: from - at, bar: null });
      cells.push({ span: b.to - from + 1, bar: { label: b.label, kind: b.kind, from: from, to: b.to } });
      at = b.to + 1;
    });
    if (at < cols) cells.push({ span: cols - at, bar: null });
    return cells;
  }

  // The kinds the legend should list: the ones the data uses, in a fixed order, plus whether any marker (diamond) is used.
  function legendKinds(timeline) {
    var used = {};
    (timeline.tracks || []).forEach(function (t) { (t.rows || []).forEach(function (r) { (r.bars || []).forEach(function (b) { used[KINDS.indexOf(b.kind) < 0 ? "build" : b.kind] = true; }); }); });
    return KINDS.filter(function (k) { return used[k]; });
  }

  // "Jan to Feb 2027" for a bar, read out to screen readers (the bar's own text is its label).
  function barRange(bar, heads) {
    var a = heads[bar.from], b = heads[bar.to];
    if (!a || !b) return "";
    return a.index === b.index ? a.name : a.name + " to " + b.name;
  }

  // ---- sittings and costs --------------------------------------------------------------------------------------------------------

  // The first sitting (not an act of yours) with a date on or after `today`. Rows with no date are skipped; `date` may be approximate
  // (`approx: true`), the row's own `when` text says so.
  function nextSitting(sittings, today) {
    var best = null;
    (sittings || []).forEach(function (s) {
      if (!s || s.kind !== "sitting" || !isDate(s.date)) return;
      if (s.date < today) return;
      if (!best || s.date < best.date) best = s;
    });
    return best;
  }

  function confidence(tag) { return CONFIDENCE[tag] || null; }

  // Checks a project's data file entry; returns a list of problems (empty when it is fine). Used by the tests and by the page, which
  // refuses to draw a project whose data is broken instead of drawing it wrong.
  function checkProject(p) {
    var bad = [];
    function need(ok, msg) { if (!ok) bad.push(msg); }
    need(p && typeof p.id === "string" && /^[a-z0-9-]{1,24}$/.test(p.id), "id");
    need(p && typeof p.name === "string" && p.name, "name");
    need(p && typeof p.prefix === "string" && p.prefix, "prefix");
    need(p && typeof p.phasePrefix === "string" && p.phasePrefix.indexOf(p.prefix) === 0, "phasePrefix starts with prefix");
    if (!p) return bad;
    var tl = p.timeline;
    need(tl && /^\d{4}-\d{2}$/.test(String(tl.start)) && tl.months >= 1 && tl.months <= 36, "timeline.start and months");
    if (tl && Array.isArray(tl.tracks)) {
      var cols = tl.months + 1;
      tl.tracks.forEach(function (t, ti) {
        need(t.id && t.title && Array.isArray(t.rows), "track " + ti);
        (t.rows || []).forEach(function (r, ri) {
          need(r.label, "track " + t.id + " row " + ri + " label");
          (r.bars || []).forEach(function (b, bi) {
            var w = "track " + t.id + " row " + ri + " bar " + bi;
            need(Number.isInteger(b.from) && Number.isInteger(b.to) && b.from >= 0 && b.to >= b.from && b.to < cols, w + " range");
            need(KINDS.indexOf(b.kind) >= 0, w + " kind");
            need(b.label, w + " label");
          });
        });
      });
    } else bad.push("timeline.tracks");
    (p.sittings || []).forEach(function (s, i) {
      need(s.n && s.when && (s.what || s.lead) && (s.kind === "sitting" || s.kind === "act"), "sitting " + i);
      need(s.date === null || s.date === undefined || isDate(s.date), "sitting " + i + " date");
    });
    (p.costs || []).forEach(function (c, i) {
      need(c.item && c.when && c.cost, "cost " + i);
      (c.basis || []).forEach(function (b) { need(!b.tag || CONFIDENCE[b.tag], "cost " + i + " tag"); });
    });
    return bad;
  }

  var api = {
    DAY_MS: DAY_MS, KINDS: KINDS, CONFIDENCE: CONFIDENCE, LANE_TITLE: LANE_TITLE, STATUS_TITLE: STATUS_TITLE,
    dateString: dateString, isDate: isDate, daysUntil: daysUntil, shortDate: shortDate, dueInfo: dueInfo,
    ownsTitle: ownsTitle, phaseOf: phaseOf, isMaster: isMaster, masterName: masterName, isOpen: isOpen, mergeItems: mergeItems,
    buildModel: buildModel, laneCounts: laneCounts, nextDue: nextDue, splitSteps: splitSteps, openCount: openCount,
    clip: clip, laneTitle: laneTitle, statusTitle: statusTitle, statusTone: statusTone, itemHref: itemHref, summaryOf: summaryOf,
    monthHeads: monthHeads, currentColumn: currentColumn, rowCells: rowCells, legendKinds: legendKinds, barRange: barRange,
    nextSitting: nextSitting, confidence: confidence, checkProject: checkProject
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardProjectsLogic = api;
})(typeof window !== "undefined" ? window : this);
