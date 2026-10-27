// The Today tile: what needs you today in one list, from the Worker's /hub/briefing (ClaudeRepo, owner only): to-dos due or overdue,
// renewals soon, what is down, backups that are overdue or never restored, register entries running out, open P1 findings, and
// proposals and questions waiting on you. It only reads; each row links to where the thing is dealt with.
// Needs tile-kit.js first. Pure helpers are exported for test/tile-ops.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // The owner's own date (this computer's), sent so "today" means where you are.
  function todayParam(now) { var d = new Date(now == null ? Date.now() : now); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function headline(b) {
    if (!b || !b.count) return "Nothing needs you today.";
    return b.count + (b.count === 1 ? " thing needs" : " things need") + " you today.";
  }
  // Rows of one section as the tile shows them: the first two always, the rest when there is room.
  function sectionView(s) {
    return { id: s.id, title: s.title, tone: s.tone || "", count: s.count, first: (s.items || []).slice(0, 2), rest: (s.items || []).slice(2), more: s.more || 0 };
  }
  function safeHref(h) { return /^[a-z0-9-]+\.html(#[A-Za-z0-9_-]+)?$/.test(String(h || "")) ? h : ""; }

  var helpers = { todayParam: todayParam, headline: headline, sectionView: sectionView, safeHref: safeHref };
  var desc = { id: "today", title: "Today", about: "What needs you today, in one list: to-dos, renewals, anything down, backups, security, and what is waiting on you.", w: 4, h: 8, minW: 3, minH: 3, maxW: 12, maxH: 30, ownerOnly: true, permission: "tile.today" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var refresh = h("button", "btn btn-sm btn-quiet", "Refresh"); refresh.type = "button"; refresh.addEventListener("click", load);
    head.appendChild(refresh);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);
    var timer = setInterval(function () { if (!document.hidden) load(); }, 300000);

    function row(it, cls) {
      var li = h("li", "tl-row" + (cls ? " " + cls : ""));
      var href = safeHref(it.href);
      var label = href ? h("a", null, it.text) : h("span", null, it.text);
      if (href) label.href = href;
      li.appendChild(label);
      li.appendChild(chip(it.note || "", it.tone));
      return li;
    }
    function paint(b) {
      clear(body);
      body.appendChild(h("p", "tl-sub", headline(b) + (b.partial ? " (some sources did not answer)" : "")));
      b.sections.forEach(function (s) {
        var v = sectionView(s);
        var sec = h("section");
        var title = h("p", "tl-sub", v.title + " · " + v.count);
        sec.appendChild(title);
        var ul = h("ul", "tl-list");
        v.first.forEach(function (it) { ul.appendChild(row(it)); });
        v.rest.forEach(function (it) { ul.appendChild(row(it, "tl-rich-row")); });
        sec.appendChild(ul);
        if (v.more) sec.appendChild(h("p", "dim tl-rich-row", "and " + v.more + " more"));
        body.appendChild(sec);
      });
    }
    function load() {
      return K.call("GET", "/hub/briefing?today=" + todayParam()).then(function (r) {
        if (r.status === 200 && r.body && Array.isArray(r.body.sections)) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { clearInterval(timer); if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
