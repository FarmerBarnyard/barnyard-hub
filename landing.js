// The sign-in gate for the dashboard (landing.js + landing.css). Every page except the public ones loads this in <head>, so a
// visitor who is not signed in sees one card (the word Barnyard, a line and a Sign in button) and nothing else: no menu, no page
// titles, no tool names, no widgets.
//
// How: the page is hidden by landing.css until this script has asked the Worker whether there is a session
// (GET https://api.barnyard.site/auth/session, the same question auth-gate.js asks, read here first because auth-gate.js loads
// later). Signed in -> the page is shown as before. Signed out -> the page's body is thrown away and the card is shown. If the
// answer cannot be read (offline, the API down, a timeout) the page is shown only to a browser that was signed in within the
// last 7 days (that is what keeps the "saved data" fallback working through an outage); anyone else gets the card, so a
// failure never opens the page. With scripts off or this file missing, landing.css keeps the page hidden.
//
// What this is NOT: this site's files are served from a public GitHub repository, so the page code itself cannot be hidden by
// a script. The gate hides what a visitor sees; the DATA is protected by the Worker, which answers only a signed-in person
// (the Projects plan moved there for that reason). The remembered flag below only lets a page open while the API is down;
// it never lets anything in that the Worker would refuse, and a pasted flag shows a stranger the same empty page shells.
//
// Pure rules (interpret, decide) are exported for tests/landing.test.js.

(function (root) {
  "use strict";

  var SESSION_API = "https://api.barnyard.site/auth/session";
  var LOGIN_API = "https://api.barnyard.site/auth/login";
  var SEEN_KEY = "bh_seen_auth";
  var SEEN_MS = 7 * 86400000; // the session cookie lasts 7 days
  var TIMEOUT_MS = 10000;

  // What the session answer means: "in", "out" or "unreachable". status is the HTTP status, type the content-type header,
  // data the parsed body (undefined when it was not JSON).
  function interpret(status, type, data) {
    if (status === 401) return "out";
    if (typeof status !== "number" || status < 200 || status > 299) return "unreachable";
    if (String(type || "").indexOf("application/json") === -1) return "unreachable";
    if (data && data.authenticated === true) return "in";
    if (data && data.authenticated === false) return "out";
    return "unreachable";
  }

  // "show" the page or show the "landing" card. seenAt is the remembered time of the last signed-in answer (ms) or null.
  function decide(outcome, seenAt, now) {
    if (outcome === "in") return "show";
    if (outcome === "out") return "landing";
    // Unreachable: only a browser that was signed in lately gets through, and a time in the future counts for nothing.
    if (typeof seenAt === "number" && isFinite(seenAt) && seenAt <= now && now - seenAt < SEEN_MS) return "show";
    return "landing";
  }

  var api = { interpret: interpret, decide: decide, SEEN_KEY: SEEN_KEY, SEEN_MS: SEEN_MS, TIMEOUT_MS: TIMEOUT_MS, SESSION_API: SESSION_API, LOGIN_API: LOGIN_API };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  var de = document.documentElement;
  de.setAttribute("data-landing", "check");

  function readSeen() {
    try { var v = parseInt(root.localStorage.getItem(SEEN_KEY), 10); return isFinite(v) ? v : null; } catch (e) { return null; }
  }
  function writeSeen() { try { root.localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) { /* private window: no flag */ } }
  function clearSeen() { try { root.localStorage.removeItem(SEEN_KEY); } catch (e) { /* nothing to clear */ } }

  function loginUrl() { return LOGIN_API + "?return_to=" + encodeURIComponent(root.location.href); }

  function showLanding() {
    de.setAttribute("data-landing", "out");
    try { root.stop(); } catch (e) { /* the rest of the page may keep loading; it stays hidden and is emptied below */ }
    document.title = "Barnyard";
    function empty() { var b = document.body; if (b) while (b.firstChild) b.removeChild(b.firstChild); }
    empty();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", empty);
    var card = document.createElement("main");
    card.id = "bh-landing";
    var h = document.createElement("h1");
    h.appendChild(document.createTextNode("Barnyard"));
    var dot = document.createElement("span");
    dot.className = "bh-dot";
    dot.textContent = ".";
    h.appendChild(dot);
    var p = document.createElement("p");
    p.textContent = "Sign in to continue.";
    var a = document.createElement("a");
    a.className = "btn btn-primary";
    a.href = loginUrl();
    a.textContent = "Sign in";
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(a);
    de.appendChild(card);
  }

  var settled = false;
  function finish(outcome) {
    if (settled) return;
    settled = true;
    var choice = decide(outcome, readSeen(), Date.now());
    if (outcome === "in") writeSeen();
    if (outcome === "out") clearSeen();
    if (choice === "show") de.setAttribute("data-landing", "ok"); else showLanding();
  }

  var controller = typeof root.AbortController === "function" ? new root.AbortController() : null;
  var timer = root.setTimeout(function () { if (controller) controller.abort(); finish("unreachable"); }, TIMEOUT_MS);
  try {
    root.fetch(SESSION_API, { method: "GET", credentials: "include", referrerPolicy: "no-referrer", cache: "no-store", signal: controller ? controller.signal : undefined })
      .then(function (r) {
        var type = r.headers.get("content-type") || "";
        if (r.status === 401 || !r.ok || type.indexOf("application/json") === -1) { finish(interpret(r.status, type, undefined)); return; }
        return r.json().then(function (j) { finish(interpret(r.status, type, j)); });
      })
      .catch(function () { finish("unreachable"); })
      .then(function () { root.clearTimeout(timer); });
  } catch (e) { root.clearTimeout(timer); finish("unreachable"); }
})(typeof window !== "undefined" ? window : this);