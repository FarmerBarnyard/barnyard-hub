// The Kitchen tile: what is for dinner tonight and how many things are left to buy this week, with a link to the Kitchen. It reads GET /kitchen/glance
// (owner only, one small answer) and creates no new authority. Needs tile-kit.js and kitchen-logic.js first.
// The wording is in kitchen-logic.js; test/kitchen.test.js covers it and the tile's descriptor.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;
  var L = typeof module !== "undefined" && module.exports ? require("./kitchen-logic.js") : root.BarnyardKitchenLogic;

  var desc = { id: "kitchen", title: "Kitchen", about: "What is for dinner tonight and how much is left to buy this week.", w: 4, h: 5, minW: 3, minH: 3, maxW: 12, maxH: 14, ownerOnly: true, permission: "tile.kitchen" };
  var helpers = { descriptor: desc, lines: function (g) { return { dinner: L.glanceLine(g), toBuy: L.toBuyLine(g ? g.toBuy : 0) }; } };
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the Kitchen"); open.href = "kitchen.html";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint(g) {
      clear(body);
      var t = helpers.lines(g);
      body.appendChild(h("p", "tl-sub", t.dinner));
      var shop = h("a", null, t.toBuy); shop.href = "kitchen.html#shop";
      var p = h("p", "tl-sub"); p.appendChild(shop);
      body.appendChild(p);
    }
    function load() {
      return K.call("GET", "/kitchen/glance").then(function (r) {
        if (r.status === 200 && r.body) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
