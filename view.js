// A shared view's page (view.html): a frozen, read-only copy that the hub owner chose to share. There is NO login here on
// purpose -- the link (view.html#sv_...) is the credential, so the token lives in the address fragment (never sent to a
// server by the browser, never in a referrer) and is posted in the body to api.barnyard.site/share/open. The page asks
// for one thing: that picture. Nothing is sent but the token, no cookie goes with it, and nothing is stored in the browser.
//
// What is shown comes from the snapshot taken when the link was made and is drawn by share-render.js (DOM nodes only, no
// HTML strings), so nothing in a picture can inject script or style.
//
// Plain script, no build step. Under Node only the pure helpers are exported (for test/share.test.js).
(function (root) {
  "use strict";

  var API = "https://api.barnyard.site/share/open";
  var TOKEN = /^sv_[A-Za-z0-9_-]{32}$/;

  // ---- 1. pure helpers -----------------------------------------------------

  // "#sv_xxxxx" -> the token, or null.
  function tokenFromHash(hash) {
    var s = String(hash || "").replace(/^#/, "");
    return TOKEN.test(s) ? s : null;
  }

  // What to tell someone whose link does not open: { title, text }.
  function gateMessage(code, status) {
    if (code === "share_expired") return { title: "This link has expired", text: "The person who shared it can make a new one." };
    if (code === "share_revoked") return { title: "This link has been switched off", text: "The person who shared it turned it off. Ask them for a new one if you still need it." };
    if (status === 429 || code === "rate_limited") return { title: "Too many tries", text: "Wait a minute, then reload this page." };
    if (code === "not_found" || status === 404) return { title: "This link doesn't work", text: "It may be incomplete: check that the whole address was copied, including the part after the #." };
    if (code === "not_configured" || status === 500 || status === 503) return { title: "Not available right now", text: "Try again in a few minutes." };
    return { title: "Couldn't open this link", text: "Check your connection and reload the page." };
  }

  var helpers = { tokenFromHash: tokenFromHash, gateMessage: gateMessage };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. the page ---------------------------------------------------------

  var R = root.BarnyardShareRender;
  var $ = function (id) { return document.getElementById(id); };

  function gate(msg) {
    $("sv").hidden = true;
    $("sv-gate").hidden = false;
    $("sv-gate-title").textContent = msg.title;
    $("sv-gate-msg").textContent = msg.text;
    document.title = msg.title + " · Barnyard";
  }

  function show(view) {
    var title = view.label || R.kindTitle(view.kind);
    $("sv-kind").textContent = R.kindTitle(view.kind);
    $("sv-title").textContent = title;
    $("sv-when").textContent = "Copied " + R.dateText(view.takenAt) + " · available until " + R.dateText(view.expiresAt);
    var box = $("sv-content");
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(R.render(view.snapshot, {}));
    $("sv-gate").hidden = true;
    $("sv").hidden = false;
    document.title = title + " · Barnyard";
  }

  function open() {
    var token = tokenFromHash(root.location.hash);
    if (!token) { gate(gateMessage("not_found", 404)); return; }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 15000);
    fetch(API, {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token }), signal: controller ? controller.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return null; }).then(function (d) {
        if (r.ok && d && d.ok && d.view) show(d.view);
        else gate(gateMessage(d && d.error, r.status));
      });
    }, function () { clearTimeout(timer); gate(gateMessage("network", 0)); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var print = $("sv-print");
    if (print) print.addEventListener("click", function () { root.print(); });
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", open); else open();
})(typeof window !== "undefined" ? window : this);
