// The Overview page (index.html): the headline sentence, the "Waiting on you"
// list, the "Since you last looked" feed, the in-flight list, and the widget
// layout the viewer chose in Settings.
//
// What it needs from the Worker (see ClaudeRepo's cloudflare-worker README):
//   GET  /ops/board            the open items (needs a login in barnyard-hub-sso)
//   GET  /ops/recent?limit=N   the latest change-log entries across all items
//   POST /ops/items/:id/finish, /reopen   Mark done, and its Undo
// A visitor who is not logged in, or not in the group, sees a plain prompt in
// those widgets instead; the weather, week, to-do and prices widgets are
// independent scripts and work either way. If /ops/recent is not deployed yet
// the feed falls back to the items' own last-changed times.
//
// Everything from the server reaches the page through textContent, never
// innerHTML. The page's CSP has no 'unsafe-inline' for scripts or styles.
//
// Layout of this file:
//   1. pure helpers   -- wording, counting, the layout presets (exported for
//                        test/overview.test.js; no DOM, no network)
//   2. data           -- fetching the board and the recent changes
//   3. rendering      -- the Overview widgets
//   4. layout         -- applying and editing the saved widget layout

(function () {
  "use strict";

  var API = "https://api.barnyard.site/ops";
  var SEEN_KEY = "barnyard-overview-seen";
  var POLL_MS = 90000;
  var DAY_MS = 86400000;

  // ---- 1. pure helpers ------------------------------------------------------

  var NUMBER_WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things", "Seven things", "Eight things", "Nine things"];
  var LANE_TITLE = { in_progress: "In progress", soaking: "Soaking and monitoring", waiting: "Waiting on you", backlog: "Backlog", done: "Completed" };
  var STATUS_TITLE = {
    investigating: "Investigating", building: "Building", reviewing: "Reviewing", soaking: "Soaking", monitoring: "Monitoring", watching: "Watching",
    decision_needed: "Decision needed", scheduled: "Scheduled", planned: "Planned", idea: "Idea", deferred: "Deferred", blocked: "Blocked", done: "Done", rejected: "Rejected"
  };
  var STATUS_TONE = { investigating: "info", building: "info", reviewing: "info", soaking: "ok", monitoring: "ok", watching: "ok", decision_needed: "attn", scheduled: "attn", planned: "hollow", idea: "hollow", deferred: "hollow", blocked: "alert" };
  var WIDGET_TITLE = { need: "Waiting on you", feed: "Since you last looked", flight: "In progress and soaking", market: "Nasdaq-100", weather: "Weather", week: "This week", todo: "To-do", links: "Shortcuts" };

  function wl(rows) { return rows.map(function (r) { return { id: r[0], visible: r[1] !== 0, size: r[2] }; }); }
  var PRESETS = [
    { id: "balanced", title: "Balanced", widgets: wl([["need", 1, 2], ["feed", 1, 2], ["flight", 1, 1], ["market", 1, 1], ["weather", 1, 1], ["week", 1, 1], ["todo", 1, 1], ["links", 1, 4]]) },
    { id: "focus", title: "Focus", widgets: wl([["need", 1, 2], ["feed", 1, 2], ["flight", 1, 4], ["market", 0, 1], ["weather", 0, 1], ["week", 0, 1], ["todo", 0, 1], ["links", 0, 4]]) },
    { id: "planner", title: "Planner", widgets: wl([["need", 1, 2], ["week", 1, 2], ["todo", 1, 2], ["feed", 1, 2], ["flight", 1, 2], ["weather", 1, 2], ["market", 0, 1], ["links", 1, 4]]) }
  ];

  // "Three things need you." / "One thing needs you." / "Nothing needs you."
  function heroHeadline(waiting) {
    var n = Math.max(0, waiting | 0);
    var words = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : n + " things";
    return words + (n <= 1 ? " needs you." : " need you.");
  }

  function heroSubline(changedItems) {
    var n = Math.max(0, changedItems | 0);
    if (!n) return "Nothing has changed since you were last here. Everything else is running.";
    return "Claude changed " + n + (n === 1 ? " item" : " items") + " since you were last here. Everything else is running.";
  }

  function openItems(items) {
    return (items || []).filter(function (i) { return i && i.lane !== "done" && !i.proposal; });
  }
  function waitingItems(items) {
    return openItems(items).filter(function (i) { return i.lane === "waiting"; }).sort(function (a, b) { return (a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : a.addedAt - b.addedAt; });
  }
  function flightItems(items) {
    return openItems(items).filter(function (i) { return i.lane === "in_progress" || i.lane === "soaking"; });
  }

  // How many different items Claude changed since `since` (ms).
  function changedItemCount(events, since) {
    var seen = {}, n = 0;
    (events || []).forEach(function (e) {
      if (e && e.actor === "claude" && e.ts > since && !seen[e.itemId]) { seen[e.itemId] = true; n++; }
    });
    return n;
  }

  // One change-log entry as parts the page can lay out: who, what they did to
  // which item, and where it went. Unknown kinds fall back to "updated".
  function describeFeed(ev) {
    var who = ev.actor === "claude" ? "Claude" : "You";
    var kind = ev.kind, title = ev.title || "an item", tail = "", verb;
    if (kind === "created") verb = "added";
    else if (kind === "proposed") verb = "proposed";
    else if (kind === "moved") {
      verb = "moved";
      var lane = ev.changes && ev.changes.lane && ev.changes.lane[1];
      if (lane && LANE_TITLE[lane]) tail = " to " + LANE_TITLE[lane];
    } else if (kind === "note") verb = "added a note to";
    else if (kind === "done") verb = "finished";
    else if (kind === "reopened") verb = "reopened";
    else if (kind === "approved") verb = "approved";
    else if (kind === "rejected") verb = "rejected";
    else verb = "updated";
    return { who: who, verb: verb, title: title, tail: tail, note: ev.note || "", actor: ev.actor === "claude" ? "claude" : "you", ts: ev.ts };
  }

  // When /ops/recent is not available: the newest changes, taken from the
  // items themselves. There is no actor or note to show, so none is invented.
  function feedFromItems(items, limit) {
    return openItems(items).filter(function (i) { return i.lastEventAt || i.updatedAt; })
      .sort(function (a, b) { return (b.lastEventAt || b.updatedAt) - (a.lastEventAt || a.updatedAt); })
      .slice(0, limit)
      .map(function (i) { return { itemId: i.id, title: i.title, ts: i.lastEventAt || i.updatedAt, actor: "", kind: "updated", changes: {}, note: "" }; });
  }

  function agoText(ts, now) {
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function dueChip(due, today) {
    if (!due) return null;
    var a = new Date(due + "T00:00:00").getTime(), b = new Date(today + "T00:00:00").getTime();
    var days = Math.round((a - b) / DAY_MS);
    if (days < 0) return { text: "Overdue " + (-days) + (days === -1 ? " day" : " days"), tone: "alert" };
    if (days === 0) return { text: "Due today", tone: "accent" };
    if (days <= 7) return { text: "Due in " + days + (days === 1 ? " day" : " days"), tone: "accent" };
    return { text: "Due " + due, tone: "" };
  }

  var helpers = {
    heroHeadline: heroHeadline, heroSubline: heroSubline, openItems: openItems, waitingItems: waitingItems, flightItems: flightItems,
    changedItemCount: changedItemCount, describeFeed: describeFeed, feedFromItems: feedFromItems, agoText: agoText, dueChip: dueChip,
    PRESETS: PRESETS, WIDGET_TITLE: WIDGET_TITLE
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  function getJson(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    return fetch(API + path, { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          // The Worker says why in { error: "no_board" | "board_disabled" | ... }.
          return r.json().catch(function () { return null; }).then(function (d) {
            var e = new Error("http"); e.status = r.status; e.code = d && d.error ? d.error : null; throw e;
          });
        }
        return r.json();
      }, function (err) { clearTimeout(timer); throw err; });
  }
  function postJson(path, body) {
    return fetch(API + path, { method: "POST", credentials: "include", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { if (!r.ok) { var e = new Error("http"); e.status = r.status; throw e; } return r.json(); });
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
  function hrefFor(id) { return "ops.html#" + id; }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }
  function statusDot(status) {
    var s = h("span", "st " + (STATUS_TONE[status] || ""));
    s.appendChild(h("i"));
    s.appendChild(document.createTextNode(STATUS_TITLE[status] || status));
    return s;
  }
  function todayString() {
    var d = new Date(), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  var model = { state: "loading", items: [], events: [], since: 0, firstFeed: true };

  function loginHref() { return typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null; }

  function placeholder(list, text, linkText, href) {
    clear(list);
    var li = h("li");
    var box = h("div", "empty", null);
    box.appendChild(document.createTextNode(text));
    if (href) {
      box.appendChild(document.createElement("br"));
      var a = h("a", "btn btn-sm", linkText);
      a.href = href;
      box.appendChild(a);
    }
    li.appendChild(box);
    list.appendChild(li);
  }

  function gateMessage() {
    if (model.state === "guest") return ["The board is private.", "Log in", loginHref()];
    if (model.state === "noboard") return ["You don’t have a board yet. It takes one click to make your own.", "Create your board", "ops.html"];
    if (model.state === "disabled") return ["Your board has been switched off. Ask the person who runs this hub.", null, null];
    if (model.state === "forbidden") return ["You’re logged in, but your account isn’t allowed to view the board.", null, null];
    if (model.state === "error") return ["Couldn’t reach the board. It will try again shortly.", null, null];
    return ["Loading…", null, null];
  }

  function renderNeed() {
    var list = $("need-list");
    if (model.state !== "ok") { var g = gateMessage(); placeholder(list, g[0], g[1], g[2]); return; }
    clear(list);
    var waiting = waitingItems(model.items), today = todayString();
    if (!waiting.length) {
      var li = h("li"), box = h("div", "empty");
      box.appendChild(h("b", null, "You’re clear"));
      box.appendChild(document.createTextNode("New items that need you will show up here."));
      li.appendChild(box);
      list.appendChild(li);
      return;
    }
    waiting.forEach(function (item) {
      var li = h("li");
      var top = h("div");
      top.appendChild(h("b", null, item.title));
      var due = dueChip(item.due, today);
      if (due) { top.appendChild(document.createTextNode(" ")); top.appendChild(chip(due.text, due.tone)); }
      li.appendChild(top);
      if (item.next) li.appendChild(h("p", null, item.next));
      var acts = h("div", "acts");
      var done = h("button", "btn btn-sm", "Mark done");
      done.type = "button";
      done.addEventListener("click", function () { markDone(item, done); });
      var open = h("a", "btn btn-sm", "Open");
      open.href = hrefFor(item.id);
      acts.appendChild(done);
      acts.appendChild(open);
      li.appendChild(acts);
      list.appendChild(li);
    });
  }

  function renderFeed() {
    var list = $("feed-list");
    if (model.state !== "ok") { var g = gateMessage(); placeholder(list, g[0], g[1], g[2]); return; }
    clear(list);
    list.className = "spine" + (model.firstFeed ? " enter" : "");
    var entries = model.events.length ? model.events : feedFromItems(model.items, 6);
    var now = Date.now();
    if (!entries.length) {
      var li0 = h("li"), box = h("div", "empty");
      box.appendChild(h("b", null, "Nothing yet"));
      box.appendChild(document.createTextNode("Changes to the board show up here as they happen."));
      li0.appendChild(box);
      list.appendChild(li0);
      return;
    }
    entries.slice(0, 6).forEach(function (ev, n) {
      var d = describeFeed(ev);
      var li = h("li", d.actor ? "by-" + d.actor : "");
      li.tabIndex = 0;
      li.style.setProperty("--i", String(n));
      var line = h("div", "t");
      if (d.actor) { line.appendChild(h("b", null, d.who)); line.appendChild(document.createTextNode(" " + d.verb + " ")); }
      line.appendChild(h("b", null, d.title));
      if (d.tail) line.appendChild(document.createTextNode(d.tail));
      if (!d.actor) line.appendChild(document.createTextNode(" changed"));
      li.appendChild(line);
      if (d.note) li.appendChild(h("div", "n", d.note));
      li.appendChild(h("div", "when", agoText(d.ts, now)));
      var go = function () { location.href = hrefFor(ev.itemId); };
      li.addEventListener("click", go);
      li.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      list.appendChild(li);
    });
    model.firstFeed = false;
  }

  function renderFlight() {
    var box = $("flight-list"), count = $("flight-n");
    clear(box);
    if (model.state !== "ok") { count.textContent = ""; var g = gateMessage(); box.appendChild(h("p", "dim", g[0])); return; }
    var items = flightItems(model.items);
    count.textContent = items.length + " active";
    if (!items.length) { box.appendChild(h("p", "dim", "Nothing is in progress right now.")); return; }
    items.forEach(function (item) {
      var a = h("a", "row-item");
      a.href = hrefFor(item.id);
      a.appendChild(h("b", null, item.title));
      a.appendChild(statusDot(item.status));
      box.appendChild(a);
    });
  }

  function renderHero() {
    var h1 = $("ov-h1"), sub = $("ov-sub");
    if (model.state === "ok") {
      h1.textContent = heroHeadline(waitingItems(model.items).length);
      sub.textContent = heroSubline(changedItemCount(model.events, model.since));
    } else if (model.state === "guest") {
      h1.textContent = "Barnyard.";
      sub.textContent = "Log in to see what needs you and what has changed.";
    } else if (model.state === "noboard") {
      h1.textContent = "Welcome.";
      sub.textContent = "Create your own board to see what needs you, and connect your Claude to keep it up to date.";
    } else if (model.state === "disabled") {
      h1.textContent = "Barnyard.";
      sub.textContent = "Your board has been switched off. The widgets below still work.";
    } else if (model.state === "forbidden") {
      h1.textContent = "Barnyard.";
      sub.textContent = "Your account can’t view the board, but the widgets below still work.";
    } else if (model.state === "error") {
      h1.textContent = "Barnyard.";
      sub.textContent = "Couldn’t reach the board just now. The widgets below still work.";
    } else {
      h1.textContent = "Barnyard.";
      sub.textContent = "Checking what needs you…";
    }
  }

  function renderAll() {
    renderHero();
    renderNeed();
    renderFeed();
    renderFlight();
    if (window.BarnyardShell) {
      window.BarnyardShell.setBadge(model.state === "ok" ? waitingItems(model.items).length : 0);
      window.BarnyardShell.setSearchSource(function () {
        return model.state !== "ok" ? [] : openItems(model.items).map(function (i) {
          return { title: i.title, hint: LANE_TITLE[i.lane] || "", go: function () { location.href = hrefFor(i.id); } };
        });
      });
    }
  }

  function markDone(item, button) {
    button.disabled = true;
    postJson("/items/" + encodeURIComponent(item.id) + "/finish", {}).then(function () {
      refresh().then(function () {
        if (window.BarnyardShell) window.BarnyardShell.toast("Marked done: " + item.title, {
          label: "Undo", ms: 10000,
          run: function () { postJson("/items/" + encodeURIComponent(item.id) + "/reopen", { lane: item.lane }).then(refresh).catch(function () { window.BarnyardShell.toast("Couldn’t undo. Reopen it from the board."); }); }
        });
      });
    }).catch(function (err) {
      button.disabled = false;
      var msg = err && err.status === 401 ? "Your session has expired. Log in again." : err && err.status === 403 ? "Your account can’t change the board." : "Couldn’t save that. Try again.";
      if (window.BarnyardShell) window.BarnyardShell.toast(msg);
    });
  }

  function refresh() {
    return getJson("/board").then(function (board) {
      model.items = Array.isArray(board.items) ? board.items : [];
      model.state = "ok";
      return getJson("/recent?limit=30").then(function (res) { model.events = Array.isArray(res.events) ? res.events : []; }, function () { model.events = []; });
    }).then(function () {
      renderAll();
    }, function (err) {
      if (err && err.status === 401) model.state = "guest";
      else if (err && err.status === 404 && err.code === "no_board") model.state = "noboard";
      else if (err && err.status === 403 && err.code === "board_disabled") model.state = "disabled";
      else if (err && err.status === 403) model.state = "forbidden";
      else model.state = model.state === "ok" ? "ok" : "error";
      renderAll();
    });
  }

  // ---- 4. layout ------------------------------------------------------------

  function applyLayout() {
    var settings = window.BarnyardTheme.get(), box = $("widgets");
    if (!box) return;
    var shown = 0;
    settings.widgets.forEach(function (w, order) {
      var el = box.querySelector('[data-w="' + w.id + '"]');
      if (!el) return;
      el.hidden = !w.visible;
      el.setAttribute("data-size", String(w.size));
      el.style.order = String(order);
      if (w.visible) shown++;
    });
    var none = $("all-hidden");
    if (!shown) {
      if (!none) { none = h("p", "all-hidden", "Every widget is hidden. Turn some back on in Settings, under Home layout."); none.id = "all-hidden"; box.appendChild(none); }
    } else if (none) none.parentNode.removeChild(none);
  }

  function registerLayoutTab() {
    if (!window.BarnyardShell) return;
    var Theme = window.BarnyardTheme, controls = window.BarnyardShell.controls;
    window.BarnyardShell.registerTab({
      id: "layout", title: "Home layout",
      render: function (body) {
        var fs = h("fieldset");
        fs.appendChild(h("legend", null, "Overview widgets"));
        fs.appendChild(h("p", "hint", "Choose what shows on the Overview, how wide each piece is, and the order. Start from a preset, then adjust."));
        var presets = h("div", "preset-row");
        PRESETS.forEach(function (p) {
          var b = h("button", "btn btn-sm", p.title);
          b.type = "button";
          b.addEventListener("click", function () { Theme.set({ widgets: p.widgets.map(function (w) { return { id: w.id, visible: w.visible, size: w.size }; }) }); window.BarnyardShell.toast("Layout: " + p.title); });
          presets.appendChild(b);
        });
        fs.appendChild(presets);
        var ul = h("ul", "wlist");
        var widgets = Theme.get().widgets;
        function commit(next, focusIndex, focusDir) {
          Theme.set({ widgets: next });
          if (focusIndex != null) {
            var rows = document.querySelectorAll(".wrow"), row = rows[focusIndex];
            if (row) {
              var btns = row.querySelectorAll(".mv button"), want = btns[focusDir > 0 ? 1 : 0];
              (want && !want.disabled ? want : row.querySelector(".mv button:not(:disabled)")).focus();
            }
          }
        }
        widgets.forEach(function (w, idx) {
          var name = WIDGET_TITLE[w.id] || w.id;
          var li = h("li", "wrow" + (w.visible ? "" : " off"));
          li.appendChild(controls.toggle("Show " + name, w.visible, function (on) {
            var next = widgets.map(function (x) { return { id: x.id, visible: x.id === w.id ? on : x.visible, size: x.size }; });
            commit(next);
          }));
          li.appendChild(h("span", "nm", name));
          var size = h("select");
          size.setAttribute("aria-label", name + " width");
          [["1", "Small"], ["2", "Medium"], ["4", "Full width"]].forEach(function (o) {
            var opt = h("option", null, o[1]);
            opt.value = o[0];
            if (String(w.size) === o[0]) opt.selected = true;
            size.appendChild(opt);
          });
          size.addEventListener("change", function () {
            commit(widgets.map(function (x) { return { id: x.id, visible: x.visible, size: x.id === w.id ? parseInt(size.value, 10) : x.size }; }));
          });
          li.appendChild(size);
          var mv = h("span", "mv");
          [["up", -1], ["down", 1]].forEach(function (d) {
            var b = h("button");
            b.type = "button";
            b.setAttribute("aria-label", "Move " + name + " " + d[0]);
            b.appendChild(controls.svg(d[0]));
            var to = idx + d[1];
            if (to < 0 || to >= widgets.length) b.disabled = true;
            b.addEventListener("click", function () {
              var next = widgets.map(function (x) { return { id: x.id, visible: x.visible, size: x.size }; });
              var t = next[idx]; next[idx] = next[to]; next[to] = t;
              commit(next, to, d[1]);
            });
            mv.appendChild(b);
          });
          li.appendChild(mv);
          ul.appendChild(li);
        });
        fs.appendChild(ul);
        body.appendChild(fs);
      }
    });
  }

  // ---- boot -----------------------------------------------------------------

  function boot() {
    registerLayoutTab();
    applyLayout();
    window.BarnyardTheme.onChange(applyLayout);

    var stored = 0;
    try { stored = parseInt(window.localStorage.getItem(SEEN_KEY), 10) || 0; } catch (e) { stored = 0; }
    model.since = stored || (Date.now() - DAY_MS);

    renderAll();
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; renderAll(); return; }
      refresh().then(function () {
        try { window.localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) { /* storage blocked: the count restarts each visit */ }
      });
      setInterval(function () { if (!document.hidden && model.state === "ok") refresh(); }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardOverview = helpers;
})();
