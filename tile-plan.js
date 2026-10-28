// The Overview tile "Today's plan": what is next on today's accepted plan, how the day is going, and the focus timer if one is running.
// It reads only GET /planner/all (the same single answer the Calendar page uses) and only the blocks the owner has already accepted;
// suggestions live on the Calendar's Plan view. Each line opens that page. Needs tile-kit.js and planner-engine.js first.
// Pure helpers are exported for test/tile-plan.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;
  var E = typeof module !== "undefined" && module.exports ? require("./planner-engine.js") : root.BarnyardPlanEngine;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayParam(now) { var d = new Date(now == null ? Date.now() : now); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function minutesNow(now) { var d = new Date(now == null ? Date.now() : now); return d.getHours() * 60 + d.getMinutes(); }

  // What the tile says, from GET /planner/all's answer ({ tasks, plan: { blocks, timer, worked } }).
  //   state: "off" (no plan data), "empty" (nothing accepted for today), "ok"
  function model(planner, today, nowMin, nowMs) {
    var P = planner && planner.plan;
    if (!P || !Array.isArray(P.blocks)) return { state: "off", next: [], done: 0, total: 0, workedMin: 0, timer: null, headline: "The planner isn’t available yet." };
    var tasks = Array.isArray(planner.tasks) ? planner.tasks : [];
    var byId = {}; tasks.forEach(function (t) { byId[t.id] = t; });
    // today's blocks that still mean something: a finished block counts, and so does a planned one for a to-do that is still open
    var todays = P.blocks.filter(function (b) { return b.date === today && b.state !== "skipped" && byId[b.taskId] && (b.state === "done" || byId[b.taskId].status === "open"); });
    var done = todays.filter(function (b) { return b.state === "done"; }).length;
    var next = E.nextBlocks(P, tasks, today, nowMin);
    var worked = 0;
    (P.worked || []).forEach(function (w) { if (w.date === today) worked += w.minutes; });
    var timer = null;
    if (P.timer && byId[P.timer.taskId]) timer = { title: byId[P.timer.taskId].title, running: !!P.timer.running, elapsedMs: E.timerElapsed(P.timer, nowMs == null ? Date.now() : nowMs) };
    var state = todays.length ? "ok" : "empty";
    var headline = !todays.length ? "No plan for today yet."
      : !next.length ? "That’s today’s plan done: " + done + " of " + todays.length + " blocks."
      : "Next: " + E.clock(E.toMin(next[0].start)) + " · " + next[0].title;
    return { state: state, next: next, done: done, total: todays.length, workedMin: worked, timer: timer, headline: headline };
  }

  function nextLine(b) { return E.clock(E.toMin(b.start)) + "  " + b.title + " · " + E.hoursText(b.minutes); }

  var helpers = { todayParam: todayParam, minutesNow: minutesNow, model: model, nextLine: nextLine };
  var desc = { id: "plan", title: "Today’s plan", about: "What is next on today’s plan, how the day is going, and your focus timer.", w: 4, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.plan" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the plan"); open.href = "calendar.html#plan";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);
    var timer = setInterval(function () { if (!document.hidden) load(); }, 300000);

    function paint(planner) {
      clear(body);
      var m = model(planner, todayParam(), minutesNow());
      body.appendChild(h("p", "tl-sub", m.headline));
      if (m.timer) {
        var row = h("p", "tl-row");
        row.appendChild(h("span", null, (m.timer.running ? "Focusing: " : "Paused: ") + m.timer.title));
        row.appendChild(chip(E.clockText(m.timer.elapsedMs), m.timer.running ? "ok" : ""));
        body.appendChild(row);
      }
      if (m.state === "ok") {
        var ul = h("ul", "tl-list");
        m.next.slice(0, 3).forEach(function (b, n) {
          var li = h("li", "tl-row" + (n >= 2 ? " tl-rich-row" : ""));
          li.appendChild(h("span", null, nextLine(b)));
          if (b.state === "running") li.appendChild(chip("Running", "ok"));
          ul.appendChild(li);
        });
        body.appendChild(ul);
        body.appendChild(h("p", "tl-sub", m.done + " of " + m.total + " blocks done" + (m.workedMin ? " · " + E.hoursText(m.workedMin) + " worked" : "")));
      } else if (m.state === "empty") {
        body.appendChild(h("p", "dim", "Open the plan, look over the suggestion and press Accept."));
      }
    }
    function load() {
      return K.call("GET", "/planner/all").then(function (res) {
        if (res.status === 200) { paint(res.body); return; }
        K.loadFailure(body, res, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { clearInterval(timer); if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
