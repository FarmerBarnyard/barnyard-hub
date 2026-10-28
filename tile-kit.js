// The small toolkit the operations tiles share (Assets, Backups, Today, Activity, Usage, Approvals): safe DOM building,
// the Worker call, plain-words error text, money and date wording, and the side drawer a tile opens for anything too
// big to edit in place. Each tile is its own file (tile-assets.js and so on) that registers itself here:
//
//   BarnyardTiles.register({ id, title, about, w, h, minW, minH, maxW, maxH, ownerOnly, render(container, ctx) })
//
// The size fields use the same names as the Overview board's catalogue (board-layout.js), so putting a tile on the board
// is adding that one object to it. render() draws into `container` and may return { refresh(), destroy() }.
//
// Everything from the server reaches the page through textContent, never innerHTML (the CSP has no 'unsafe-inline').
// Pure helpers are exported for test/tile-kit.test.js; the DOM parts only run in a browser.

(function (root) {
  "use strict";

  var API = "https://api.barnyard.site";
  var DAY = 86400000;

  // ---- 1. pure helpers ------------------------------------------------------------------------------------------

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

  // 125000 -> "$1,250.00" (cents in, currency code optional). Whole dollars lose the cents.
  function moneyText(cents, currency) {
    if (typeof cents !== "number" || !isFinite(cents)) return "";
    var dollars = cents / 100;
    var whole = Math.abs(cents) % 100 === 0;
    var s = dollars.toLocaleString("en-AU", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
    var cur = currency && currency !== "AUD" ? " " + currency : "";
    return (dollars < 0 ? "-$" + s.replace("-", "") : "$" + s) + cur;
  }

  // "12.50" or "$1,200" -> 1250 / 120000; "" -> null (no cost known); anything else -> NaN.
  function parseMoney(text) {
    var t = String(text == null ? "" : text).replace(/[\s,$]/g, "");
    if (t === "") return null;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return NaN;
    return Math.round(parseFloat(t) * 100);
  }

  function dayDiff(due, now) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due))) return null;
    var d = new Date(now == null ? Date.now() : now);
    var today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    var t = Date.parse(due + "T00:00:00Z");
    return isFinite(t) ? Math.round((t - today) / DAY) : null;
  }

  // "in 12 days", "today", "3 days ago".
  function daysText(days) {
    if (days === null || days === undefined) return "";
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days === -1) return "yesterday";
    return days > 0 ? "in " + days + " days" : Math.abs(days) + " days ago";
  }

  // How urgent: "alert" overdue or within a week, "attn" within a month, "ok" beyond, "" no date.
  function urgency(days) {
    if (days === null || days === undefined) return "";
    return days <= 7 ? "alert" : days <= 30 ? "attn" : "ok";
  }

  // "2027-05-03" -> "3 May 2027".
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateText(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
    return m ? parseInt(m[3], 10) + " " + MONTHS[parseInt(m[2], 10) - 1] + " " + m[1] : "";
  }

  // "3 min ago", "2 h ago", "5 days ago" from a time in ms.
  function agoText(ts, now) {
    if (!ts) return "never";
    var s = Math.max(0, Math.round(((now == null ? Date.now() : now) - ts) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return plural(Math.round(s / 86400), "day") + " ago";
  }

  // The Worker's error codes in plain words. `body` is the parsed answer (may carry field and kind).
  var ERRORS = {
    recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then repeat it.",
    unauthenticated: "You are not signed in.",
    forbidden: "This is only for the hub owner.",
    registry_unavailable: "The registry is not switched on in the Worker yet.",
    registry_full: "The register is full (500 assets). Remove something first.",
    rate_limited: "Slow down a little: try again in a minute.",
    confirm_required: "Confirm the removal first.",
    not_found: "That is no longer there. Reload and try again.",
    name_required: "Give it a name.",
    kind_required: "Choose what kind of thing it is.",
    undo_required: "Say how to undo it.",
    what_required: "Say what changed.",
    costCents_invalid: "The cost must be a plain amount such as 12.50.",
    expires_invalid: "The date must be a real date.",
    link_invalid: "A link must start with https://",
    watch_invalid: "Only a domain can be watched, and it must be a plain domain name.",
    renewalItem_invalid: "The renewal item id looks like it_ followed by 8 letters or numbers.",
    request_failed: "Could not reach the Worker. Check your connection and try again."
  };
  function errorText(body, status) {
    var code = body && typeof body.error === "string" ? body.error : "";
    if (code === "secret_detected") {
      return "That looks like a password or key" + (body.field ? " in the " + body.field + " field" : "") + ". Write where it is kept (for example \"in the password manager under X\") instead.";
    }
    if (ERRORS[code]) return ERRORS[code];
    if (/_too_long$/.test(code)) return "The " + code.replace(/_too_long$/, "") + " text is too long.";
    if (/_invalid$/.test(code)) return "Check the " + code.replace(/_invalid$/, "") + " field.";
    if (status === 0) return ERRORS.request_failed;
    if (status === 401) return ERRORS.unauthenticated;
    if (status === 403) return ERRORS.forbidden;
    if (status === 503) return ERRORS.registry_unavailable;
    return "That did not work (" + (code || "error " + status) + ").";
  }
  function needsSignIn(body, status) {
    return (body && body.error === "recent_sign_in_required") || status === 401;
  }

  var helpers = {
    plural: plural, moneyText: moneyText, parseMoney: parseMoney, dayDiff: dayDiff, daysText: daysText, urgency: urgency,
    dateText: dateText, agoText: agoText, errorText: errorText, needsSignIn: needsSignIn, ERRORS: ERRORS
  };

  // ---- 2. the registry of tiles ---------------------------------------------------------------------------------

  var tiles = root.BarnyardTiles && root.BarnyardTiles.tiles ? root.BarnyardTiles.tiles : {};
  function register(desc) {
    if (!desc || typeof desc.id !== "string" || typeof desc.render !== "function") throw new Error("a tile needs an id and a render function");
    tiles[desc.id] = desc;
    return desc;
  }
  function list() { return Object.keys(tiles).map(function (k) { return tiles[k]; }); }

  helpers.register = register;
  helpers.list = list;
  helpers.tiles = tiles;

  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") { root.BarnyardTiles = helpers; return; }

  // ---- 3. DOM and network (browser only) ------------------------------------------------------------------------

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }

  // The registry summary (GET /reg/summary) is read by the Assets, Backups and Weakest links tiles; they share one answer for a few
  // seconds so tiles that load together cost one call and one registry read. Any write made through call() forgets it.
  var summaryMemo = { at: 0, p: null };
  var SUMMARY_MS = 8000;

  // One call to the Worker: -> Promise of { status, body }. status 0 means the network failed.
  function call(method, path, body) {
    if (method !== "GET") summaryMemo.p = null;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    var init = { method: method, credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return fetch(API + path, init).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  // GET /reg/summary, shared by the tiles that load together (see summaryMemo above). A failed answer is never kept.
  function summary() {
    var now = Date.now();
    if (summaryMemo.p && now - summaryMemo.at < SUMMARY_MS) return summaryMemo.p;
    summaryMemo.at = now;
    var p = call("GET", "/reg/summary").then(function (r) {
      if (r.status !== 200 && summaryMemo.p === p) summaryMemo.p = null;
      return r;
    });
    summaryMemo.p = p;
    return p;
  }

  // A calm message in a tile: text, and optionally a link or a button.
  function notice(container, text, action) {
    clear(container);
    var box = h("div", "tl-notice");
    box.appendChild(h("p", "dim", text));
    if (action && action.href) { var a = h("a", "btn btn-sm", action.label); a.href = action.href; box.appendChild(a); }
    else if (action && action.onClick) { var b = h("button", "btn btn-sm", action.label); b.type = "button"; b.addEventListener("click", action.onClick); box.appendChild(b); }
    container.appendChild(box);
  }
  function loginHref() { return typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null; }
  // The message for a failed load, with the right action (sign in, retry).
  function loadFailure(container, res, retry) {
    if (res.status === 401) return notice(container, "Log in to see this.", loginHref() ? { label: "Log in", href: loginHref() } : null);
    if (res.status === 403) return notice(container, "This tile is only for the hub owner.");
    notice(container, errorText(res.body, res.status), { label: "Try again", onClick: retry });
  }

  // A side drawer. -> { body, footer, setTitle(t), close() }. Esc, the Close button and a click outside close it; focus
  // goes into it and comes back to the button that opened it.
  function openDrawer(title, onClose) {
    var opener = document.activeElement;
    var overlay = h("div", "tk-overlay");
    var panel = h("section", "tk-drawer");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    var head = h("header", "tk-head");
    var titleEl = h("h2", "tk-title", title);
    titleEl.id = "tk-title-" + Math.random().toString(36).slice(2, 8);
    panel.setAttribute("aria-labelledby", titleEl.id);
    var closeBtn = h("button", "btn btn-sm btn-quiet", "Close");
    closeBtn.type = "button";
    head.appendChild(titleEl); head.appendChild(closeBtn);
    var body = h("div", "tk-body");
    var footer = h("footer", "tk-foot");
    panel.appendChild(head); panel.appendChild(body); panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (opener && opener.focus) opener.focus();
      if (onClose) onClose();
    }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    closeBtn.addEventListener("click", close);
    closeBtn.focus();
    return { body: body, footer: footer, setTitle: function (t) { titleEl.textContent = t; }, close: close };
  }

  helpers.h = h; helpers.clear = clear; helpers.chip = chip; helpers.call = call; helpers.notice = notice;
  helpers.loadFailure = loadFailure; helpers.loginHref = loginHref; helpers.openDrawer = openDrawer; helpers.summary = summary;
  root.BarnyardTiles = helpers;
})(typeof window !== "undefined" ? window : globalThis);
