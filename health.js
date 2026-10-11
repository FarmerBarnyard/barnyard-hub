// The System health page (health.html): the owner's one place to see whether the pieces behind the hub
// are up and how close the Worker is to its free limits.
//
// Reads GET /hub/health (owner only; see ClaudeRepo's cloudflare-worker/src/hub-routes.js):
//   runner, engine   the chat runner and the campaign engine on app02
//   mapgen           the render service, asked through the tunnel's /health
//   cache            how many maps the R2 map cache holds and how big it is
//   counters         the Worker's request counts per day and area, only while the Worker variable
//                    HUB_HEALTH_COUNTERS is "1" (off by default), and its latest events
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout of this file: 1. pure helpers (exported for test/health.test.js; no DOM, no network)
//                      2. data   3. rendering

(function () {
  "use strict";

  var API = "https://api.barnyard.site/hub";
  var POLL_MS = 60000;

  // ---- 1. pure helpers ------------------------------------------------------

  var AREA_TITLE = { ops: "Ops board", chat: "Chat", maps: "Maps", campaign: "Campaign", kb: "Knowledgebase", notebook: "Notebook", auth: "Sign-in", hub: "Hub", other: "Other" };

  function formatBytes(n) {
    n = Math.max(0, Number(n) || 0);
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  function thousands(n) { return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // How full a limit is, as a whole percent (never above 100 for the bar; the number itself can be higher).
  function percentOf(used, limit) {
    if (!limit) return 0;
    return Math.round((Math.max(0, used) / limit) * 100);
  }
  function limitTone(pct) { return pct >= 90 ? "alert" : pct >= 70 ? "attn" : "ok"; }

  function agoText(ts, now) {
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  // One row per service: { id, title, tone, state, detail }. A part that is switched off says so plainly and is
  // not an alarm; a part the Worker could not read is unknown, never up.
  function serviceRows(h, now) {
    var rows = [];
    function worker(id, title, x, queueWord) {
      if (!x || !x.enabled) return rows.push({ id: id, title: title, tone: "", state: "Switched off", detail: "Nothing is expected from it." });
      if (x.error) return rows.push({ id: id, title: title, tone: "", state: "Unknown", detail: "The Worker could not read it just now." });
      var bits = [];
      if (x.queued) bits.push(x.queued + " " + queueWord + (x.queued === 1 ? "" : "s") + " waiting");
      if (x.running) bits.push(x.running + " running");
      if (x.online) return rows.push({ id: id, title: title, tone: "ok", state: "Online", detail: bits.join(", ") || "Idle." });
      return rows.push({ id: id, title: title, tone: "attn", state: "Offline", detail: (x.lastSeen ? "Last seen " + agoText(x.lastSeen, now) + "." : "Never seen.") + (bits.length ? " " + bits.join(", ") + "." : "") });
    }
    worker("runner", "Chat runner", h.runner, "message");
    worker("engine", "Campaign engine", h.engine, "job");
    var m = h.mapgen;
    if (!m || !m.configured) rows.push({ id: "mapgen", title: "Render service", tone: "", state: "Not set up", detail: "The Worker has no address for it, so maps are drawn in the browser." });
    else if (m.error || !m.ok) rows.push({ id: "mapgen", title: "Render service", tone: "alert", state: "Not answering", detail: "Server-rendered maps will fail and fall back to the browser until it is back." });
    else rows.push({
      id: "mapgen", title: "Render service", tone: "ok", state: "Up",
      detail: "Version " + (m.generatorVersion || "?") + (m.active ? ", " + m.active + " rendering" : "") + (m.queued ? ", " + m.queued + " queued" : "") + (m.ms ? ", answered in " + m.ms + " ms" : "") + "."
    });
    return rows;
  }

  // The map cache as one sentence, or null when it is not available.
  function cacheText(c) {
    if (!c || !c.configured) return null;
    if (c.error) return "Could not be read just now.";
    var count = c.maps + (c.truncated ? "+" : "") + (c.maps === 1 ? " map" : " maps");
    return count + ", " + thousands(c.objects) + " files, " + formatBytes(c.bytes) + (c.truncated ? " (counted up to the first 5,000 files)" : "") + ".";
  }

  // Days newest first: { day, requests, pct, tone, e4, e5, areas: [{ title, requests }] } with the busiest area first.
  function dayRows(counters) {
    if (!counters || !counters.enabled || !Array.isArray(counters.days)) return [];
    return counters.days.map(function (d) {
      var pct = percentOf(d.total.requests, counters.limit);
      var areas = Object.keys(d.areas || {}).map(function (a) { return { title: AREA_TITLE[a] || a, requests: d.areas[a].requests }; })
        .sort(function (a, b) { return b.requests - a.requests; });
      return { day: d.day, requests: d.total.requests, pct: pct, tone: limitTone(pct), e4: d.total.e4, e5: d.total.e5, areas: areas };
    });
  }

  function eventRows(counters, now) {
    if (!counters || !counters.enabled || !Array.isArray(counters.events)) return [];
    return counters.events.map(function (e) { return { when: agoText(e.ts, now), evt: e.evt, route: e.route || "" }; });
  }

  var helpers = { formatBytes: formatBytes, thousands: thousands, percentOf: percentOf, limitTone: limitTone, agoText: agoText, serviceRows: serviceRows, cacheText: cacheText, dayRows: dayRows, eventRows: eventRows, AREA_TITLE: AREA_TITLE };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", health: null };

  function load() {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch(API + "/health", { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (r.status === 401) { model.state = "guest"; return; }
        if (r.status === 403) { model.state = "forbidden"; return; }
        if (!r.ok) { model.state = model.health ? "ok" : "error"; return; }
        return r.json().then(function (d) { model.health = d; model.state = "ok"; });
      }, function () { clearTimeout(timer); model.state = model.health ? "ok" : "error"; })
      .then(render);
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

  function message(text, linkText, href) {
    var box = $("health-root");
    clear(box);
    var p = h("p", "dim", text);
    box.appendChild(p);
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function section(title, note) {
    var s = h("section", "hl-section");
    var head = h("div", "sec-head");
    head.appendChild(h("h2", null, title));
    if (note) head.appendChild(h("span", "sub", note));
    s.appendChild(head);
    return s;
  }

  function render() {
    var root = $("health-root");
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see the system health.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error" || !model.health) { message("Couldn’t reach the Worker just now. It will try again shortly."); return; }
    var hl = model.health, now = Date.now();
    clear(root);

    // services
    var sv = section("Services");
    var list = h("ul", "hl-list");
    list.setAttribute("role", "list");
    serviceRows(hl, now).forEach(function (r) {
      var li = h("li");
      li.appendChild(h("span", "chip" + (r.tone ? " " + r.tone : ""), r.state));
      li.appendChild(h("b", null, r.title));
      li.appendChild(h("span", "dim", r.detail));
      list.appendChild(li);
    });
    sv.appendChild(list);
    root.appendChild(sv);

    // map cache
    var ct = cacheText(hl.cache);
    if (ct) {
      var cs = section("Map cache", "R2");
      cs.appendChild(h("p", null, ct));
      root.appendChild(cs);
    }

    // requests
    var rs = section("Worker requests", "free plan: " + thousands(hl.counters && hl.counters.limit || 100000) + " a day");
    if (!hl.counters || !hl.counters.enabled) {
      rs.appendChild(h("p", "dim", "The counters are switched off, so nothing is being counted or stored."));
      rs.appendChild(h("p", "dim", "To turn them on, add the Worker variable HUB_HEALTH_COUNTERS = 1 in Cloudflare (Workers, barnyard-live-prices, Settings, Variables). It costs about one Durable Object call a minute. Remove it to switch them off again. Counts are close, not exact: Cloudflare’s own analytics are the exact figure."));
    } else if (hl.counters.error) {
      rs.appendChild(h("p", "dim", "The counters are on but could not be read just now."));
    } else {
      var days = dayRows(hl.counters);
      if (!days.length) rs.appendChild(h("p", "dim", "Nothing counted yet. The first counts arrive within a minute of the next request."));
      days.forEach(function (d, i) {
        var row = h("div", "hl-day");
        var top = h("div", "hl-day-top");
        top.appendChild(h("b", null, i === 0 ? "Today (" + d.day + ")" : d.day));
        top.appendChild(h("span", "chip " + d.tone, thousands(d.requests) + " requests, " + d.pct + "%"));
        if (d.e4 || d.e5) top.appendChild(h("span", "dim", thousands(d.e4) + " client errors, " + thousands(d.e5) + " server errors"));
        row.appendChild(top);
        var bar = h("div", "hl-bar");
        var fill = h("i", d.tone);
        fill.style.width = Math.min(100, d.pct) + "%";
        bar.appendChild(fill);
        row.appendChild(bar);
        if (i === 0 && d.areas.length) {
          var areas = h("p", "dim hl-areas", d.areas.map(function (a) { return a.title + " " + thousands(a.requests); }).join(" · "));
          row.appendChild(areas);
        }
        rs.appendChild(row);
      });
      var ev = eventRows(hl.counters, now);
      if (ev.length) {
        var es = h("div", "hl-events");
        es.appendChild(h("h3", null, "Latest events"));
        var el = h("ul", "hl-list");
        el.setAttribute("role", "list");
        ev.forEach(function (e) {
          var li = h("li");
          li.appendChild(h("span", "dim", e.when));
          li.appendChild(h("b", null, e.evt));
          li.appendChild(h("span", "dim", e.route));
          el.appendChild(li);
        });
        es.appendChild(el);
        rs.appendChild(es);
      }
    }
    root.appendChild(rs);
    var stamp = $("health-stamp");
    if (stamp) stamp.textContent = "Updated " + new Date().toLocaleTimeString();
  }

  function boot() {
    var btn = $("health-refresh");
    if (btn) btn.addEventListener("click", function () { load(); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load();
      setInterval(function () { if (!document.hidden && model.state === "ok") load(); }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardHealth = helpers;
})();
