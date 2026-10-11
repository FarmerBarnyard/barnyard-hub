// The Search page (search.html): one box that searches the Ops board, the Notebook and the Knowledgebase.
//
// Reads GET /hub/search?q= (owner only; ClaudeRepo's cloudflare-worker/src/hub-routes.js). The Notebook and
// the library only answer the study site's origin, so the Worker does the asking and the hub just shows
// the answer. A group that could not be searched says so; the others still show.
//
// Everything from the server reaches the page through textContent, never innerHTML. The links are the
// Worker's own (ops.html#id, or https://study.barnyard.site/...), checked before use.
//
// Layout: 1. pure helpers (exported for test/search.test.js)  2. data  3. rendering

(function () {
  "use strict";

  var API = "https://api.barnyard.site/hub";
  var MIN = 2, MAX = 100, DEBOUNCE_MS = 300;

  // ---- 1. pure helpers ------------------------------------------------------

  // The query to send, or null when it is too short or too long to search.
  function normalizeQuery(raw) {
    var q = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    return q.length >= MIN && q.length <= MAX ? q : null;
  }

  // Only links the Worker could have made: a page of this hub, or the study site.
  function safeHref(href) {
    var h = String(href || "");
    if (/^ops\.html#[A-Za-z0-9_-]{1,40}$/.test(h)) return h;
    if (/^https:\/\/study\.barnyard\.site\/(notes|knowledgebase)\.html#[A-Za-z0-9_\/-]{1,60}$/.test(h)) return h;
    return "";
  }

  function totalCount(data) {
    var n = 0;
    ((data && data.groups) || []).forEach(function (g) { n += (g.items || []).length; });
    return n;
  }

  // One line saying how a group went: "3 results", "No results", "Couldn't be searched", "Not available to you".
  function groupStatus(g) {
    if (g.skipped) return "Not available to this account";
    if (g.error) return "Couldn’t be searched just now";
    var n = (g.items || []).length;
    return n === 0 ? "No results" : n + (n === 1 ? " result" : " results");
  }

  function pageUrl(q) { return q ? "search.html?q=" + encodeURIComponent(q) : "search.html"; }

  var helpers = { normalizeQuery: normalizeQuery, safeHref: safeHref, totalCount: totalCount, groupStatus: groupStatus, pageUrl: pageUrl, MIN: MIN, MAX: MAX };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "idle", q: "", data: null };
  var seq = 0;

  function search(q) {
    var mine = ++seq;
    model.q = q;
    model.state = "loading";
    render();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(API + "/search?q=" + encodeURIComponent(q), { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (mine !== seq) return;
        if (r.status === 401) { model.state = "guest"; return; }
        if (r.status === 403) { model.state = "forbidden"; return; }
        if (!r.ok) { model.state = "error"; return; }
        return r.json().then(function (d) { if (mine === seq) { model.data = d; model.state = "ok"; } });
      }, function () { clearTimeout(timer); if (mine === seq) model.state = "error"; })
      .then(function () { if (mine === seq) render(); });
  }

  // ---- 3. rendering ---------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function render() {
    var root = $("search-root");
    clear(root);
    if (model.state === "idle") { root.appendChild(h("p", "dim", "Type at least " + MIN + " letters. This searches your Ops board, your Notebook and the Knowledgebase.")); return; }
    if (model.state === "loading") { root.appendChild(h("p", "dim", "Searching…")); return; }
    if (model.state === "guest") {
      root.appendChild(h("p", "dim", "Log in to search."));
      if (typeof window.barnyardLoginUrl === "function") { var a = h("a", "btn btn-sm", "Log in"); a.href = window.barnyardLoginUrl(); root.appendChild(a); }
      return;
    }
    if (model.state === "forbidden") { root.appendChild(h("p", "dim", "Search is for the person who runs the hub.")); return; }
    if (model.state === "error" || !model.data) { root.appendChild(h("p", "dim", "Couldn’t reach the Worker just now. Try again in a moment.")); return; }
    var total = totalCount(model.data);
    root.appendChild(h("p", "dim search-total", total === 0 ? "Nothing found for “" + model.q + "”." : total + (total === 1 ? " result" : " results") + " for “" + model.q + "”."));
    model.data.groups.forEach(function (g) {
      var sec = h("section", "search-group");
      var head = h("div", "sec-head");
      head.appendChild(h("h2", null, g.title));
      head.appendChild(h("span", "sub", groupStatus(g)));
      sec.appendChild(head);
      if ((g.items || []).length) {
        var list = h("ul", "search-list");
        list.setAttribute("role", "list");
        g.items.forEach(function (it) {
          var li = h("li");
          var href = safeHref(it.href);
          var title = href ? h("a", null, it.title) : h("span", null, it.title);
          if (href) title.href = href;
          var top = h("div", "search-top");
          top.appendChild(title);
          if (it.hint) top.appendChild(h("span", "chip", it.hint));
          li.appendChild(top);
          if (it.snippet) li.appendChild(h("p", "dim", it.snippet));
          list.appendChild(li);
        });
        sec.appendChild(list);
      }
      root.appendChild(sec);
    });
  }

  function boot() {
    var input = $("search-input"), form = $("search-form");
    var timer = null;
    function go(push) {
      var q = normalizeQuery(input.value);
      if (!q) { seq++; model.state = "idle"; render(); return; }
      if (push) { try { history.replaceState(null, "", pageUrl(q)); } catch (e) { /* ignore */ } }
      search(q);
    }
    form.addEventListener("submit", function (e) { e.preventDefault(); clearTimeout(timer); go(true); });
    input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { go(true); }, DEBOUNCE_MS); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      var start = new URLSearchParams(location.search).get("q");
      if (start) input.value = start;
      input.focus();
      go(false);
    });
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardSearch = helpers;
})();
