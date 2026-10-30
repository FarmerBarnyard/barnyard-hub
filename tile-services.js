// The Service levels tile: how the servers and sites are doing against their targets over 30 days, and the soonest disk or
// memory forecast to fill. It reads GET /services/summary (owner only; the Worker keeps the answer 20 seconds) and creates no new
// authority. Needs tile-kit.js first. Pure helpers are exported for test/services.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // The one-line summary and its tone: how many services missed their 30-day target.
  function summaryLine(sum) {
    if (!sum || sum.enabled === false) return { tone: "", text: "The Services tab is switched off." };
    var mons = ((sum.levels && sum.levels.monitors) || []).filter(function (l) { return l.w30 && l.w30.met !== null && l.w30.met !== undefined; });
    if (!mons.length) return { tone: "", text: "No uptime history yet." };
    var missed = mons.filter(function (l) { return l.w30.met === false; });
    if (!missed.length) return { tone: "ok", text: "Every service is within its 30-day target." };
    return { tone: "alert", text: K.plural(missed.length, "service") + " below the 30-day target." };
  }

  // The group rows: name, the 30-day figure, the target and a tone.
  function rows(sum) {
    return ((sum && sum.levels && sum.levels.groups) || []).filter(function (g) { return g.w30 && g.w30.pct !== null && g.w30.pct !== undefined; }).map(function (g) {
      return { name: g.name, pct: (Math.round(g.w30.pct * 1000) / 1000) + "%", target: g.target + "%", tone: g.w30.met === false ? "alert" : "ok", budget: g.w30.remainingPct === null || g.w30.remainingPct === undefined ? "" : (g.w30.remainingPct < 0 ? "over budget" : Math.round(g.w30.remainingPct) + "% budget left") };
    });
  }

  // The soonest forecast that says "grows" (or "over"), as { name, text, tone } or null.
  function soonest(sum) {
    var best = null;
    ((sum && sum.capacity) || []).forEach(function (c) {
      var f = c.forecast;
      if (!f) return;
      if (f.state === "over") { if (!best || best.days > 0) best = { days: 0, name: c.name + " " + c.label.toLowerCase(), text: "is already past the line", tone: "alert" }; return; }
      if (f.state === "grows" && (!best || f.daysLeft < best.days)) best = { days: f.daysLeft, name: c.name + " " + c.label.toLowerCase(), text: "fills in about " + K.plural(f.daysLeft, "day"), tone: f.daysLeft <= 14 ? "alert" : f.daysLeft <= 60 ? "attn" : "ok" };
    });
    return best;
  }

  var helpers = { summaryLine: summaryLine, rows: rows, soonest: soonest };
  var desc = { id: "services", title: "Service levels", about: "Uptime against your targets over 30 days, and the soonest disk forecast to fill.", w: 4, h: 6, minW: 3, minH: 3, maxW: 12, maxH: 20, ownerOnly: true, permission: "tile.services" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open Services"); open.href = "monitoring.html#services";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint(sum) {
      clear(body);
      var line = summaryLine(sum);
      body.appendChild(h("p", "tl-sub", line.text));
      var list = rows(sum);
      if (list.length) {
        var ul = h("ul", "tl-list");
        list.forEach(function (r) {
          var li = h("li");
          li.appendChild(h("b", null, r.name + " "));
          li.appendChild(chip(r.pct, r.tone));
          li.appendChild(h("span", "dim", " target " + r.target + (r.budget ? ", " + r.budget : "")));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      var s = soonest(sum);
      if (s) { var p = h("p", "tl-sub"); p.appendChild(chip(s.name + " " + s.text, s.tone)); body.appendChild(p); }
    }
    function load() {
      return K.call("GET", "/services/summary").then(function (r) {
        if (r.status === 200 && r.body) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
