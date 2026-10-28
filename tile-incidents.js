// The Open incidents tile: how many incidents are open, how serious, and the newest few, with a link to each and to the
// Incident Room. It reads GET /incidents/summary (owner only, a cheap count, no timelines) and creates no new authority.
// Needs tile-kit.js first. Pure helpers are exported for test/tile-ops.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // The tile's one-line summary and tone from the Worker's summary answer.
  function summaryLine(sum) {
    if (!sum || sum.enabled === false) return { tone: "", text: "The Incident Room is switched off." };
    var open = sum.open || 0;
    if (!open) return { tone: "ok", text: "No open incidents." + (sum.last30 ? " " + K.plural(sum.last30, "incident") + " in the last 30 days." : "") };
    var by = sum.bySeverity || {};
    var parts = ["SEV1", "SEV2", "SEV3", "SEV4"].filter(function (s) { return by[s]; }).map(function (s) { return by[s] + " " + s; });
    return { tone: by.SEV1 || by.SEV2 ? "alert" : "attn", text: K.plural(open, "open incident") + ": " + parts.join(", ") + "." };
  }

  // The newest open ones as rows { id, title, severity, tone, since }.
  function rows(sum, now) {
    return (sum && Array.isArray(sum.newest) ? sum.newest : []).slice(0, 3).map(function (i) {
      return { id: i.id, name: i.name, title: i.title, severity: i.severity, tone: i.severity === "SEV1" || i.severity === "SEV2" ? "alert" : i.severity === "SEV3" ? "attn" : "", since: K.agoText(i.openedAt, now) };
    });
  }

  var helpers = { summaryLine: summaryLine, rows: rows };
  var desc = { id: "incidents", title: "Open incidents", about: "Incidents Monitoring has opened, by severity, with the newest few.", w: 4, h: 6, minW: 3, minH: 3, maxW: 12, maxH: 20, ownerOnly: true, permission: "tile.incidents" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var openRoom = h("a", "btn btn-sm", "Open the Incident Room"); openRoom.href = "incidents.html";
    head.appendChild(openRoom);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint(sum) {
      clear(body);
      var line = summaryLine(sum);
      body.appendChild(h("p", "tl-sub", line.text));
      var list = rows(sum, Date.now());
      if (!list.length) return;
      var ul = h("ul", "tl-list");
      list.forEach(function (r) {
        var li = h("li");
        var a = h("a", null, r.title); a.href = "incidents.html#" + r.id;
        li.appendChild(a);
        li.appendChild(chip(r.severity, r.tone));
        li.appendChild(h("span", "dim", " " + r.since));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    function load() {
      return K.call("GET", "/incidents/summary").then(function (r) {
        if (r.status === 200 && r.body) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
