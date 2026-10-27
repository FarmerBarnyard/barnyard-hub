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
  function checklistText(u) { return u ? u.checklistDone + " of " + (u.checklist || []).length + " paths ticked in the rate-limit rule" : ""; }

  var helpers = { bytesText: bytesText, barModel: barModel, tightest: tightest, checklistText: checklistText };
  var desc = { id: "usage", title: "Usage & limits", about: "How close you are to each limit the Worker can see, and what it cannot.", w: 4, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.usage" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear;

  function bar(m) {
    var v = barModel(m), box = h("div", "tl-meter");
    box.appendChild(h("span", "tl-meter-label", v.label));
    if (v.pct !== null) { var p = h("progress", "tl-bar " + (v.tone || "")); p.max = 100; p.value = v.pct; p.setAttribute("aria-label", v.label + " " + v.text); box.appendChild(p); }
    box.appendChild(h("span", "dim", v.text));
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
      body.appendChild(h("p", "tl-sub", "Tightest limits"));
      t.forEach(function (m) { body.appendChild(bar(m)); });
      if (!t.length) body.appendChild(bar(st.usage.meters[0]));
      var more = h("div", "tl-more"); more.appendChild(h("p", "dim", checklistText(st.usage))); body.appendChild(more);
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
      d.body.appendChild(h("p", "tl-sub", "Rate-limit rule coverage (" + checklistText(u) + ")"));
      d.body.appendChild(h("p", "dim", "Tick each path once it is in the single Cloudflare rate-limit rule's expression. Cloudflare is the only place that can confirm it."));
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
