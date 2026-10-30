// The Academy tile: how many questions are due for review, how many drafted questions wait for a check, and how far through the courses you
// are, with a button to the Academy. It reads GET /academy/summary (owner only, a few counts) and creates no new authority.
// Needs tile-kit.js and academy-logic.js first. Pure helpers are exported for test/academy.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;
  var L = typeof module !== "undefined" && module.exports ? require("./academy-logic.js") : root.BarnyardAcademyLogic;

  var helpers = { summaryLine: L.tileSummary };
  var desc = { id: "academy", title: "Academy", about: "Questions due for review, drafted questions to check and how far through your courses you are.", w: 4, h: 5, minW: 3, minH: 3, maxW: 12, maxH: 14, ownerOnly: true, permission: "tile.academy" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the Academy"); open.href = "academy.html";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint(sum) {
      clear(body);
      var line = L.tileSummary(sum);
      body.appendChild(h("p", "tl-sub", line.text));
      if (sum.due) {
        var review = h("a", "btn btn-sm btn-primary", "Start the review"); review.href = "academy.html#/review";
        body.appendChild(review);
      }
    }
    function load() {
      return K.call("GET", "/academy/summary").then(function (r) {
        if (r.status === 200 && r.body) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
