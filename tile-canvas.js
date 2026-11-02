// The Canvas tile: your most recently changed whiteboards, each a link that opens that board, and a button to the Canvas page.
//
// It reads GET /canvas/boards (owner only; names, item counts and times, never a board's contents) and creates no new authority.
// Needs tile-kit.js first. Pure helpers are exported for test/canvas-tile.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;
  var BOARD_ID = /^cb_[a-z0-9]{8}$/;
  var SHOWN = 5;

  // What the tile says, from the Worker's boards answer: { state, text, rows }. state: off | empty | ok.
  // A row is { id, title, line, href }, most recently changed first, at most five.
  function model(body, now) {
    if (!body || body.enabled === false) return { state: "off", text: "The Canvas is switched off.", rows: [] };
    var boards = (body.boards || []).filter(function (b) { return b && BOARD_ID.test(String(b.id)) && b.title; });
    if (!boards.length) return { state: "empty", text: "No boards yet. Make one on the Canvas page.", rows: [] };
    boards = boards.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var items = 0;
    boards.forEach(function (b) { items += Number(b.items) || 0; });
    var rows = boards.slice(0, SHOWN).map(function (b) {
      var n = Number(b.items) || 0;
      return { id: b.id, title: String(b.title).slice(0, 80), line: K.plural(n, "item") + " · changed " + K.agoText(b.updatedAt, now), href: "canvas.html#" + b.id };
    });
    return { state: "ok", text: K.plural(boards.length, "board") + ", " + K.plural(items, "item") + " in all.", rows: rows };
  }

  var helpers = { model: model };
  var desc = { id: "canvas", title: "Canvas", about: "Your most recently changed whiteboards, one click from opening.", w: 4, h: 5, minW: 3, minH: 3, maxW: 12, maxH: 14, ownerOnly: true, permission: "tile.canvas" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the Canvas"); open.href = "canvas.html";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint(data) {
      clear(body);
      var m = model(data, Date.now());
      body.appendChild(h("p", "tl-sub", m.text));
      if (m.rows.length) {
        var ul = h("ul", "tl-list");
        m.rows.forEach(function (r) {
          var li = h("li"), name = h("b"), a = h("a", null, r.title);
          a.href = r.href;
          name.appendChild(a);
          li.appendChild(name);
          li.appendChild(h("span", "dim", " " + r.line));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
    }
    function load() {
      return K.call("GET", "/canvas/boards").then(function (r) {
        if (r.status === 200 && r.body) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
