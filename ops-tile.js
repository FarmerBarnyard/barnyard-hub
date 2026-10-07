// The Ops tile on the hub's landing page: fills in a one-line summary of the
// board ("1 in progress · 2 waiting on you") for someone who is logged in and
// allowed to see it. For everyone else it quietly leaves the tile's default
// text alone -- the tile is just a link, and ops.html does its own login /
// access check -- so a guest or a not-yet-authorised account sees no error and
// learns nothing about the board's contents.
//
// Same credentialed-fetch pattern as watchlist-widget.js. Runs after
// auth-gate.js, whose barnyardAuthState() it reuses to avoid a pointless
// request (and a 401 in the console) for logged-out visitors.

(function () {
  "use strict";

  var BOARD_URL = "https://api.barnyard.site/ops/board";
  var TIMEOUT_MS = 8000;

  // Pure: the summary line for a list of items, or "" if there is nothing to
  // say. Counts only open work (not done, not an unapproved proposal).
  function summarize(items) {
    var inProgress = 0;
    var waiting = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.lane === "done" || it.proposal) continue;
      if (it.lane === "in_progress") inProgress++;
      else if (it.lane === "waiting") waiting++;
    }
    var parts = [];
    if (inProgress) parts.push(inProgress + " in progress");
    if (waiting) parts.push(waiting + " waiting on you");
    return parts.join(" · ");
  }

  function init() {
    var el = document.getElementById("ops-tile-stat");
    if (!el || typeof window.barnyardAuthState !== "function") return;
    window.barnyardAuthState().then(function (auth) {
      if (!auth.authenticated) return null;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      return fetch(BOARD_URL, { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
        .finally(function () { clearTimeout(timer); });
    }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.items)) return;
      var text = summarize(data.items);
      el.textContent = text || "All clear";
    }).catch(function () { /* keep the default text */ });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { summarize: summarize };
  }
})();
