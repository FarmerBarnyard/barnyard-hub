// The Calendar tile, "Today and next up": what is due or on today and in the next seven days, from the same three sources the Calendar page
// uses (the Planner's to-dos and own events, renewals and other dated Ops items, and the Google calendar feed), worked out by the
// Calendar page's own rules (calendar-logic.js). It only reads; each row opens the Calendar page. Needs tile-kit.js and calendar-logic.js first.
// Pure helpers are exported for test/tile-ops.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;
  var L = typeof module !== "undefined" && module.exports ? require("./calendar-logic.js") : root.BarnyardCalendarLogic;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayParam(now) { var d = new Date(now == null ? Date.now() : now); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  // The data the page's agenda wants, from the three answers (any may be missing).
  function dataFrom(renewals, planner, google) {
    return {
      renewals: renewals && Array.isArray(renewals.renewals) ? renewals.renewals : [], dueItems: renewals && Array.isArray(renewals.dueItems) ? renewals.dueItems : [],
      tasks: planner && Array.isArray(planner.tasks) ? planner.tasks : [], events: planner && Array.isArray(planner.events) ? planner.events : [],
      google: Array.isArray(google) ? google : []
    };
  }
  function agendaFor(data, today) {
    var a = L.agenda(data, today, "");
    return { overdue: a.overdue, today: a.today, week: a.week };
  }
  function entryLine(e) { return (e.time ? L.timeText ? L.timeText(e.time) + "  " : e.time + "  " : "") + e.label; }
  function headline(a) {
    var n = a.overdue.length + a.today.length;
    if (!n && !a.week.length) return "Nothing on today or this week.";
    if (!n) return "Nothing due today. " + a.week.length + (a.week.length === 1 ? " thing" : " things") + " this week.";
    return (a.overdue.length ? a.overdue.length + " overdue, " : "") + a.today.length + " today.";
  }

  var helpers = { todayParam: todayParam, dataFrom: dataFrom, agendaFor: agendaFor, entryLine: entryLine, headline: headline };
  var desc = { id: "calendar", title: "Today and next up", about: "What is due or on today and over the next week, from your to-dos, events and renewals.", w: 4, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.calendar" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the calendar"); open.href = "calendar.html";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);
    var timer = setInterval(function () { if (!document.hidden) load(); }, 300000);

    function section(title, entries, tone, limit) {
      if (!entries.length) return;
      body.appendChild(h("p", "tl-sub", title + " · " + entries.length));
      var ul = h("ul", "tl-list");
      entries.slice(0, limit).forEach(function (e, n) {
        var li = h("li", "tl-row" + (n >= 2 ? " tl-rich-row" : ""));
        li.appendChild(h("span", null, entryLine(e)));
        li.appendChild(chip(e.type === "task" ? "To-do" : e.type === "event" || e.type === "gcal" ? "Event" : "Renewal", tone));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    function paint(data) {
      clear(body);
      var a = agendaFor(data, todayParam());
      body.appendChild(h("p", "tl-sub", headline(a)));
      section("Overdue", a.overdue, "alert", 5);
      section("Today", a.today, "attn", 6);
      section("Next 7 days", a.week, "", 6);
    }
    function load() {
      return Promise.all([K.call("GET", "/hub/renewals"), K.call("GET", "/planner/all"), K.call("GET", "/calendar")]).then(function (res) {
        if (res[0].status === 200 || res[1].status === 200) { paint(dataFrom(res[0].status === 200 ? res[0].body : null, res[1].status === 200 ? res[1].body : null, res[2].status === 200 ? res[2].body : null)); return; }
        K.loadFailure(body, res[0].status === 200 ? res[1] : res[0], load);
      });
    }
    load();
    return { refresh: load, destroy: function () { clearInterval(timer); if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
