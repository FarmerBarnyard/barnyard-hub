// The Usage & limits tile: how close each limit the Worker knows about is (a bar each, amber from 70% and red from 90%), the three
// tightest at a glance, a checklist you tick for the Cloudflare rate-limit rule's coverage, and a plain list of what cannot be seen
// from here with where to look. Reads /hub/usage (ClaudeRepo, owner only); ticks go to PUT /reg/ticks/<key>.
// Needs tile-kit.js first. Pure helpers are exported for test/tile-ops.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  function bytesText(n) {
    if (!isFinite(n)) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
  }
  function num(n) { return Number(n).toLocaleString("en-AU"); }
  // One meter as words and a bar: { label, text, pct (0 to 100 or null), tone, note }.
  function barModel(m) {
    if (!m || m.pct === null || m.pct === undefined || m.used === null || m.used === undefined) return { label: m ? m.label : "", text: m && m.note ? m.note : "Not known from here.", pct: null, tone: "", note: "" };
    var bytes = m.unit === "bytes";
    var used = bytes ? bytesText(m.used) : num(m.used), limit = bytes ? bytesText(m.limit) : num(m.limit);
    return { label: m.label, text: used + " of " + limit + " (" + m.pct + "%)", pct: Math.min(100, m.pct), tone: m.tone, note: m.note || "" };
  }
  function tightest(u, n) {
    var by = {}; (u && u.meters || []).forEach(function (m) { by[m.id] = m; });
    return ((u && u.tightest) || []).slice(0, n || 3).map(function (id) { return by[id]; }).filter(Boolean);
  }
  // The rate-limit checklist is a manual one: the Worker cannot see Cloudflare's rule, so these are ticks the owner makes by hand after
  // reading the rule in Cloudflare. "0 of 17" is therefore "nothing confirmed yet", not a failure.
  function checklistText(u) { return u ? u.checklistDone + " of " + (u.checklist || []).length + " paths confirmed" : ""; }
  // The checklist's status for the tile: { tone, pill, text }. Never red: it is a to-do the owner ticks off, not something that broke.
  function checklistLine(u) {
    var total = u && Array.isArray(u.checklist) ? u.checklist.length : 0, done = u && u.checklistDone || 0;
    if (!total) return null;
    if (done >= total) return { tone: "ok", pill: "All confirmed", text: "All " + total + " paths are confirmed as covered by the Cloudflare rate-limit rule." };
    return { tone: done ? "attn" : "info", pill: done ? "Part confirmed" : "Not started", text: done + " of " + total + " paths confirmed. A checklist you tick by hand in All limits, after reading the rate-limit rule in Cloudflare." };
  }
  // The tightest bar among those shown, as the tile's status: { tone, pill, text }.
  function limitsLine(list) {
    var worst = null;
    (list || []).forEach(function (m) { if (m && typeof m.pct === "number" && (!worst || m.pct > worst.pct)) worst = m; });
    if (!worst) return { tone: "", pill: "Not known", text: "The Worker cannot see these limits from here." };
    var s = K.limitState(worst.pct), tone = worst.tone === "alert" || worst.tone === "attn" ? worst.tone : s.tone;
    if (tone === "alert") return { tone: tone, pill: "Near a limit", text: worst.label + " is at " + worst.pct + "%." };
    if (tone === "attn") return { tone: tone, pill: "Getting close", text: worst.label + " is at " + worst.pct + "%." };
    return { tone: "ok", pill: "Within limits", text: "The tightest limit is at " + worst.pct + "%." };
  }

  var helpers = { bytesText: bytesText, barModel: barModel, tightest: tightest, checklistText: checklistText, checklistLine: checklistLine, limitsLine: limitsLine };
  var desc = { id: "usage", title: "Usage & limits", about: "How close you are to each limit the Worker can see, and what it cannot.", w: 4, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.usage" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear;

  function bar(m) {
    var v = barModel(m), box = h("div", "tl-meter");
    box.appendChild(h("span", "tl-meter-label", v.label));
    if (v.pct !== null) { var p = h("progress", "tl-bar " + (v.tone || "")); p.max = 100; p.value = v.pct; p.setAttribute("aria-label", v.label + " " + v.text); box.appendChild(p); }
    var words = v.tone === "alert" ? " · near the limit" : v.tone === "attn" ? " · getting close" : "";
    box.appendChild(h("span", "dim tl-meter-text" + (v.tone ? " " + v.tone : ""), v.text + words));
    return box;
  }

  function render(container) {
    var st = { usage: null };
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("button", "btn btn-sm", "All limits"); open.type = "button"; open.addEventListener("click", function () { openAll(load); });
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint() {
      clear(body);
      var t = tightest(st.usage, 3);
      if (!t.length && st.usage.meters[0]) t = [st.usage.meters[0]];
      var ln = limitsLine(t);
      body.appendChild(K.summaryRow(ln.tone, ln.pill, ln.text));
      var meters = h("div", "tl-meters");
      meters.appendChild(h("p", "tl-sub", "Tightest limits"));
      t.forEach(function (m) { meters.appendChild(bar(m)); });
      body.appendChild(meters);
      // The rate-limit rule checklist is ticked by hand, so it is labelled as that: a to-do, never a failure.
      var cl = checklistLine(st.usage);
      if (cl) {
        var more = h("div", "tl-more");
        more.appendChild(h("p", "tl-sub", "Rate-limit rule checklist"));
        more.appendChild(K.summaryRow(cl.tone, cl.pill, cl.text));
        more.appendChild(K.moreButton("Open the checklist", function () { openAll(load); }));
        body.appendChild(more);
      }
    }
    function load() {
      return K.call("GET", "/hub/usage").then(function (r) {
        if (r.status === 200 && r.body && Array.isArray(r.body.meters)) { st.usage = r.body; paint(); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  function openAll(onClose) {
    var d = K.openDrawer("Usage & limits", onClose);
    var msg = h("div"); d.body.appendChild(msg);
    function say(text, tone) { clear(msg); if (text) msg.appendChild(h("div", "tk-msg " + (tone || ""), text)); }
    K.call("GET", "/hub/usage").then(function (r) {
      if (r.status !== 200) { say(K.errorText(r.body, r.status), "alert"); return; }
      var u = r.body;
      d.body.appendChild(h("p", "tl-sub", "What the Worker can see"));
      u.meters.forEach(function (m) { d.body.appendChild(bar(m)); var n = barModel(m).note; if (n && m.pct !== null) d.body.appendChild(h("p", "dim", n)); });
      (u.estimates || []).forEach(function (e) { d.body.appendChild(h("p", "dim", e.label + ": " + e.text)); });
      d.body.appendChild(h("p", "tl-sub", "Rate-limit rule checklist: " + checklistText(u)));
      d.body.appendChild(h("p", "dim", "A manual checklist. The Worker cannot read Cloudflare, so nothing here is checked for you: look at the single rate-limit rule's expression in Cloudflare and tick each path once you have seen it there. Unticked means not confirmed yet, not broken."));
      var form = h("div", "tk-form");
      u.checklist.forEach(function (c) {
        var l = h("label"); var box = h("input"); box.type = "checkbox"; box.checked = c.on;
        box.addEventListener("change", function () { box.disabled = true; K.call("PUT", "/reg/ticks/" + c.key, { on: box.checked }).then(function (rr) { box.disabled = false; if (rr.status !== 200) { box.checked = !box.checked; say(K.errorText(rr.body, rr.status), "alert"); } else say(""); }); });
        l.appendChild(box); l.appendChild(document.createTextNode(" " + c.label)); form.appendChild(l);
      });
      d.body.appendChild(form);
      d.body.appendChild(h("p", "tl-sub", "Not visible from here"));
      var ul = h("ul", "tl-list");
      u.notVisible.forEach(function (n) { var li = h("li", "tl-row"); li.appendChild(h("span", null, n.label)); li.appendChild(h("span", "dim", n.where)); ul.appendChild(li); });
      d.body.appendChild(ul);
    });
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render, openAll: openAll });
})(typeof window !== "undefined" ? window : globalThis);
