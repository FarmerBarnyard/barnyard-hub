// The Weakest links tile: the assets that other things depend on and that are missing a monitor, a backup job that names them, or a
// runbook, worst first, with a button to the dependency map (map.html). The tile shows the top five; the map shows eight and
// the whole picture.
//
// Talks to GET /reg/summary on the Worker (owner only), through the shared K.summary() so it costs no extra call when the Assets and
// Backups tiles load beside it. The answer's `links` block is worked out by the Worker (cloudflare-worker/src/dependency-logic.js);
// the wording is in map-logic.js. The browser keeps nothing.
//
// Needs tile-kit.js and map-logic.js first. Pure helpers are exported for test/tile-weakest.test.js.

(function (root) {
  "use strict";

  var isNode = typeof module !== "undefined" && module.exports;
  var K = isNode ? require("./tile-kit.js") : root.BarnyardTiles;
  var ML = isNode ? require("./map-logic.js") : root.BarnyardMapLogic;

  var desc = {
    id: "weakest", title: "Weakest links", about: "The things others depend on that have no monitor, backup or runbook.",
    w: 5, h: 6, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.weakest"
  };

  // What the tile draws from GET /reg/summary: { state: "empty" | "unlinked" | "clean" | "weak", ... the rows }.
  function model(summary) {
    var m = ML.weakestModel(summary && summary.links);
    var state = !m.assets ? "empty" : !m.links ? "unlinked" : m.weakest.length ? "weak" : "clean";
    return { state: state, assets: m.assets, links: m.links, linked: m.linked, unlinked: m.unlinked, cycles: m.cycles, weakest: m.weakest };
  }

  var helpers = { model: model, descriptor: desc };
  if (isNode) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl");
    var head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the map");
    open.href = "map.html";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body);
    clear(container); container.appendChild(wrap);

    function paint(s) {
      var m = model(s);
      clear(body);
      if (m.state === "empty") { body.appendChild(h("p", "dim", "Nothing in the Assets register yet, so there is nothing to link.")); return; }
      if (m.state === "unlinked") {
        var n = h("div", "tl-notice");
        n.appendChild(h("p", "dim", "Nothing is linked yet. Open the map to add the starting links: it shows you what it would add first."));
        body.appendChild(n);
        return;
      }
      var stats = h("ul", "tl-stats");
      function stat(v, label, tone) { var li = h("li", "tl-stat" + (tone ? " " + tone : "")); li.appendChild(h("b", null, v)); li.appendChild(h("span", null, label)); stats.appendChild(li); }
      stat(String(m.linked), "linked of " + m.assets);
      stat(String(m.links), m.links === 1 ? "link" : "links");
      stat(String(m.weakest.length), m.weakest.length === 1 ? "weak spot" : "weak spots", m.weakest.length ? "attn" : "");
      if (m.cycles) stat(String(m.cycles), "in a loop", "alert");
      body.appendChild(stats);
      if (m.state === "clean") { body.appendChild(h("p", "dim", "Everything that others depend on has a monitor, a backup that names it and a runbook.")); return; }
      var ul = h("ul", "tl-list");
      m.weakest.forEach(function (w) {
        var li = h("li", "tl-row");
        var a = h("a", null, w.name);
        a.href = "map.html#" + w.id;
        li.appendChild(a);
        li.appendChild(h("span", "dim", w.line));
        li.appendChild(chip(w.tone === "alert" ? "Fix first" : "Gap", w.tone));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    function load() {
      return K.summary().then(function (r) {
        if (r.status === 200) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({
    id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH,
    ownerOnly: true, permission: desc.permission, render: render
  });
})(typeof window !== "undefined" ? window : globalThis);
