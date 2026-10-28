// The Running out soon tile: the dated things (secrets, tokens, renewals, anything with a due date) in the order they run out, each
// with how close it is. It used to be a fixed list under the Overview's status row; as a tile it can be moved, resized and hidden in
// Customise, and is shown or hidden for a person by the user manager (permission tile.expiry).
//
// It makes no request of its own: the Overview already reads the owner's status answer (GET /hub/status, kept 12 seconds by the
// Worker) and publishes it on tile-kit.js's bus (topic "status"); the dated list is that answer's `expiries`. A short tile shows as
// many rows as fit and a "View all" link to the Calendar; a tall one shows them all.
//
// Needs tile-kit.js first. Pure helpers are exported for test/tile-expiry.test.js and for overview.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // ---- pure helpers ---------------------------------------------------------------------------------------------------

  // The dated things, each with how close it is: expired and today are red, two weeks is amber, two months is the accent colour,
  // further off is plain.
  function expiryRows(list) {
    return (list || []).map(function (e) {
      var d = e.daysLeft, text, tone;
      if (d < 0) { text = "Expired " + (-d) + (d === -1 ? " day ago" : " days ago"); tone = "alert"; }
      else if (d === 0) { text = "Today"; tone = "alert"; }
      else if (d <= 14) { text = "In " + d + (d === 1 ? " day" : " days"); tone = "attn"; }
      else if (d <= 60) { text = "In " + d + " days"; tone = "accent"; }
      else { var months = Math.round(d / 30); text = "In " + months + (months === 1 ? " month" : " months"); tone = ""; }
      return { label: e.label, due: e.due, chip: { text: text, tone: tone }, href: e.kind === "item" ? "ops.html#" + e.id : "chat.html" };
    });
  }

  // How many rows fit in a tile `heightPx` tall when the heading takes `headPx` and a row `rowPx` (at least one; all of them when the
  // height is not known, as in the plain page layout). -> a whole number.
  function rowsThatFit(heightPx, headPx, rowPx, total) {
    if (typeof heightPx !== "number" || !(heightPx > 0)) return total;
    var room = Math.floor((heightPx - headPx) / rowPx);
    return Math.max(1, Math.min(total, room));
  }

  // The rows to draw and what is left over: { shown, hidden }. When some are left over one row of room goes to the "View all" link.
  function visibleRows(rows, capacity) {
    var total = rows.length;
    if (capacity >= total) return { shown: rows.slice(), hidden: 0 };
    var keep = Math.max(1, capacity - 1);
    return { shown: rows.slice(0, keep), hidden: total - keep };
  }

  var desc = {
    id: "expiry", title: "Running out soon",
    about: "Secrets, tokens, renewals and anything else with a date, in the order they run out.",
    w: 12, h: 6, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.expiry", defaultOn: true, order: 1
  };

  var HEAD_PX = 44, ROW_PX = 38;
  var helpers = { expiryRows: expiryRows, rowsThatFit: rowsThatFit, visibleRows: visibleRows, descriptor: desc, HEAD_PX: HEAD_PX, ROW_PX: ROW_PX };
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;
  root.BarnyardExpiry = helpers;

  // ---- the tile (browser only) --------------------------------------------------------------------------------------------

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container, ctx) {
    // On the board the tile (.w) is a fixed number of rows tall, so its height says how many rows fit; in the plain page layout
    // it grows with its content and every row is shown.
    var tile = ctx && ctx.board && container.closest ? container.closest(".w") : null;
    var wrap = h("div", "tl tl-expiry");
    var head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var addDate = h("a", "tl-exp-add", "Add a date");
    addDate.href = "ops.html";
    head.appendChild(addDate);
    var body = h("div", "tl-body tl-exp-body");
    wrap.appendChild(head); wrap.appendChild(body);
    clear(container); container.appendChild(wrap);

    var rows = [], known = false, signedOut = false, observer = null;

    function paint() {
      clear(body);
      if (signedOut) {
        body.appendChild(h("p", "dim", "Running out soon is for the hub owner. Log in to see it."));
        var href = K.loginHref();
        if (href) { var a = h("a", "btn btn-sm", "Log in"); a.href = href; body.appendChild(a); }
        return;
      }
      if (!known) { body.appendChild(h("p", "dim", "Checking…")); return; }
      if (!rows.length) { body.appendChild(h("p", "dim", "Nothing with a date in the next year. Give an Ops item a Due date and it shows here.")); return; }
      var fit = rowsThatFit(tile ? tile.clientHeight : 0, HEAD_PX, ROW_PX, rows.length), v = visibleRows(rows, fit);
      var ul = h("ul", "tl-exp-list");
      ul.setAttribute("role", "list");
      v.shown.forEach(function (r) {
        var li = h("li", "tl-exp-row");
        var a = h("a", null, r.label);
        a.href = r.href;
        li.appendChild(a);
        li.appendChild(h("span", "tl-exp-when", r.due));
        li.appendChild(chip(r.chip.text, r.chip.tone));
        ul.appendChild(li);
      });
      body.appendChild(ul);
      if (v.hidden) {
        var more = h("a", "tl-exp-more", "View all " + rows.length + " in the Calendar");
        more.href = "calendar.html";
        body.appendChild(more);
      }
    }

    var unsub = K.subscribe("status", function (s) {
      if (s === null) { signedOut = true; known = true; rows = []; }
      else if (s && typeof s === "object") { signedOut = false; known = true; rows = expiryRows(s.expiries); }
      else { signedOut = false; known = false; rows = []; }
      paint();
    });
    if (tile && typeof ResizeObserver === "function") { observer = new ResizeObserver(function () { if (known && !signedOut) paint(); }); observer.observe(tile); }
    paint();

    return {
      refresh: paint,
      destroy: function () {
        if (unsub) unsub();
        if (observer) observer.disconnect();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };
  }

  K.register({
    id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH,
    ownerOnly: true, permission: desc.permission, defaultOn: true, order: desc.order, render: render
  });
})(typeof window !== "undefined" ? window : globalThis);
