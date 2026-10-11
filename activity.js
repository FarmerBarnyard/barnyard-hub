// The Activity page (activity.html): one timeline of what changed on the board and what was done to it.
//
// Merges two feeds the Worker already has, both limited to the signed-in person's own board:
//   GET /ops/recent?limit=N   changes to items (who, what, which item)
//   GET /ops/audit?limit=N    actions on the board itself (exports, keys, approvals, refused writes ...)
// Either may fail on its own (the audit needs a login session); the page shows what it got.
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout: 1. pure helpers (exported for test/activity.test.js; no DOM, no network)  2. data  3. rendering

(function () {
  "use strict";

  var API = "https://api.barnyard.site/ops";
  var POLL_MS = 90000;
  var LANE_TITLE = { in_progress: "In progress", soaking: "Soaking and monitoring", waiting: "Waiting on you", backlog: "Backlog", done: "Completed" };

  // ---- 1. pure helpers ------------------------------------------------------

  // Who did it, as one of five groups the filter and the label both use.
  //   you        a person signed in (who "person:<label>", or a change stamped "you")
  //   claude     the desktop Claude (the approver) or a change stamped "claude"
  //   agent      the owner's agent token, or an agent key
  //   unknown    a failed attempt with no identity
  function actorOf(who) {
    var w = String(who || "");
    if (w === "desktop-approver" || w === "claude") return "claude";
    if (w === "owner-token" || w.indexOf("key:") === 0) return "agent";
    if (w.indexOf("person:") === 0 || w === "you" || w === "session") return "you";
    return "unknown";
  }
  var ACTOR_TITLE = { you: "You", claude: "Claude", agent: "An agent", unknown: "Someone" };

  // Plain English for one audit entry. `tone` is "" for routine, "attn" for something refused, "alert" for a
  // credential being blocked or a key that failed. Unknown actions are shown by name, never hidden.
  var AUDIT = {
    export: ["exported the whole board", ""],
    audit_read: ["read the audit log", ""],
    key_created: ["made an agent key", ""],
    key_revoked: ["revoked an agent key", ""],
    keys_revoked_all: ["revoked every agent key", "attn"],
    signed_out_everywhere: ["signed out every session", "attn"],
    board_created: ["created a board", ""],
    board_restore: ["restored a board to an earlier time", "attn"],
    board_offboard: ["offboarded a board", "attn"],
    board_signout: ["signed a board out everywhere", "attn"],
    item_decide: ["decided on a proposal", ""],
    proposal_change: ["changed a proposal", ""],
    write_attempt: ["tried to write", ""],
    write_blocked: ["had a write blocked", ""],
    key_auth_failed: ["had an agent key refused", ""]
  };
  function describeAudit(e) {
    var denied = e.result === "denied";
    var known = AUDIT[e.action];
    var verb = known ? known[0] : String(e.action || "did something").replace(/_/g, " ");
    var tone = known ? known[1] : "";
    var detail = String(e.detail || "");
    var text;
    if (e.action === "item_decide" && denied) { text = "A decision was refused"; tone = "attn"; }
    else if (e.action === "write_blocked") { text = "A write was blocked: it looked like it held a credential" + (detail ? " (" + detail + ")" : ""); tone = "alert"; }
    else if (e.action === "write_attempt" && denied) { text = "A read-only key tried to write and was refused"; tone = "attn"; }
    else if (e.action === "proposal_change" && denied) { text = "An agent tried to change a proposal and was refused"; tone = "attn"; }
    else if (e.action === "key_auth_failed") { text = "An agent key was refused" + (detail ? " (" + detail + ")" : ""); tone = "alert"; }
    else {
      text = ACTOR_TITLE[actorOf(e.who)] + " " + verb + (denied ? " and was refused" : "") + (detail && !denied ? " (" + detail + ")" : "");
      if (denied) tone = "attn";
    }
    return { text: text, tone: tone, actor: actorOf(e.who) };
  }

  // One item change, in the same words the Overview uses.
  function describeChange(ev) {
    var who = ev.actor === "claude" ? "Claude" : "You";
    var kind = ev.kind, title = ev.title || "an item", verb, tail = "";
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
    return { text: who + " " + verb + " " + title + tail, tone: "", actor: ev.actor === "claude" ? "claude" : "you", note: ev.note || "", href: ev.itemId ? "ops.html#" + ev.itemId : "" };
  }

  // Both feeds as one list, newest first: { ts, type: "change"|"audit", text, tone, actor, note?, href? }.
  function mergeFeeds(changes, audit) {
    var out = [];
    (changes || []).forEach(function (ev) {
      if (!ev || !Number.isFinite(ev.ts)) return;
      var d = describeChange(ev);
      out.push({ ts: ev.ts, type: "change", text: d.text, tone: d.tone, actor: d.actor, note: d.note, href: d.href });
    });
    (audit || []).forEach(function (e) {
      if (!e || !Number.isFinite(e.ts)) return;
      var d = describeAudit(e);
      out.push({ ts: e.ts, type: "audit", text: d.text, tone: d.tone, actor: d.actor, note: "", href: "" });
    });
    out.sort(function (a, b) { return b.ts - a.ts; });
    return out;
  }

  // filter = { type: "all"|"change"|"audit", actor: "any"|"you"|"claude"|"agent" }
  function applyFilter(rows, filter) {
    return rows.filter(function (r) {
      if (filter.type && filter.type !== "all" && r.type !== filter.type) return false;
      if (filter.actor && filter.actor !== "any" && r.actor !== filter.actor) return false;
      return true;
    });
  }

  // Rows grouped by calendar day, newest first: [{ day: "Today"|"Yesterday"|"Mon 5 Oct", rows }].
  function groupByDay(rows, now) {
    var DAY = 86400000;
    function startOf(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
    var today = startOf(now), groups = [], byKey = {};
    var names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    rows.forEach(function (r) {
      var s = startOf(r.ts), label;
      if (s === today) label = "Today";
      else if (s === today - DAY) label = "Yesterday";
      else { var d = new Date(s); label = names[d.getDay()] + " " + d.getDate() + " " + months[d.getMonth()]; }
      if (!byKey[s]) { byKey[s] = { day: label, rows: [] }; groups.push(byKey[s]); }
      byKey[s].rows.push(r);
    });
    return groups;
  }

  function timeText(ts) {
    var d = new Date(ts), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  var helpers = { actorOf: actorOf, describeAudit: describeAudit, describeChange: describeChange, mergeFeeds: mergeFeeds, applyFilter: applyFilter, groupByDay: groupByDay, timeText: timeText, ACTOR_TITLE: ACTOR_TITLE };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", changes: [], audit: [], auditOk: true, filter: { type: "all", actor: "any" } };

  function getJson(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    return fetch(API + path, { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) { var e = new Error("http"); e.status = r.status; throw e; }
        return r.json();
      }, function (err) { clearTimeout(timer); throw err; });
  }

  function load() {
    return getJson("/recent?limit=80").then(function (d) {
      model.changes = Array.isArray(d.events) ? d.events : [];
      model.state = "ok";
      return getJson("/audit?limit=120").then(function (a) { model.audit = Array.isArray(a.entries) ? a.entries : []; model.auditOk = true; },
        function () { model.audit = []; model.auditOk = false; });
    }).then(render, function (err) {
      if (err && err.status === 401) model.state = "guest";
      else if (err && err.status === 404) model.state = "noboard";
      else if (err && err.status === 403) model.state = "forbidden";
      else model.state = model.state === "ok" ? "ok" : "error";
      render();
    });
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
    var root = $("act-root");
    clear(root);
    root.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; root.appendChild(a); }
  }

  function render() {
    var root = $("act-root"), tools = $("act-filters");
    if (model.state === "loading") return;
    if (model.state === "guest") { tools.hidden = true; message("Log in to see the activity.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "noboard") { tools.hidden = true; message("You don’t have a board yet, so there is no activity.", "Create your board", "ops.html"); return; }
    if (model.state === "forbidden") { tools.hidden = true; message("Your account can’t view the board."); return; }
    if (model.state === "error") { tools.hidden = true; message("Couldn’t reach the board just now. It will try again shortly."); return; }
    tools.hidden = false;
    var rows = applyFilter(mergeFeeds(model.changes, model.audit), model.filter);
    clear(root);
    if (!model.auditOk) root.appendChild(h("p", "dim act-note", "The security log could not be read just now, so only board changes are shown."));
    if (!rows.length) { root.appendChild(h("p", "dim", "Nothing matches that filter.")); return; }
    groupByDay(rows, Date.now()).forEach(function (g) {
      var sec = h("section", "act-day");
      sec.appendChild(h("h2", null, g.day));
      var list = h("ul", "act-list");
      list.setAttribute("role", "list");
      g.rows.forEach(function (r) {
        var li = h("li", "act-row" + (r.tone ? " " + r.tone : ""));
        li.appendChild(h("span", "act-time", timeText(r.ts)));
        var body = h("div", "act-body");
        if (r.href) { var a = h("a", null, r.text); a.href = r.href; body.appendChild(a); } else body.appendChild(h("span", null, r.text));
        if (r.note) body.appendChild(h("p", "dim", r.note));
        li.appendChild(body);
        li.appendChild(h("span", "chip" + (r.type === "audit" ? " info" : ""), r.type === "audit" ? "Security" : "Board"));
        list.appendChild(li);
      });
      sec.appendChild(list);
      root.appendChild(sec);
    });
  }

  function wireFilters() {
    function pick(groupId, key) {
      var box = $(groupId);
      Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
        b.addEventListener("click", function () {
          model.filter[key] = b.getAttribute("data-v");
          Array.prototype.forEach.call(box.querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", String(x === b)); });
          render();
        });
      });
    }
    pick("act-type", "type");
    pick("act-actor", "actor");
    var refresh = $("act-refresh");
    if (refresh) refresh.addEventListener("click", function () { load(); });
  }

  function boot() {
    wireFilters();
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load();
      setInterval(function () { if (!document.hidden && model.state === "ok") load(); }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardActivity = helpers;
})();
