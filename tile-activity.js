// The Activity & changes tile: one timeline of what changed (Ops board changes, the board's audit trail, monitoring emails sent and the
// change log) from the Worker's /hub/activity, filterable by who did it; and the change log itself: an entry says what changed, where,
// why and, always, how to undo it. "Add a change" opens a drawer with the log and the form (POST /reg/changes).
// The timeline reads other stores' own records; only the change log is written here, and it is append only.
// Needs tile-kit.js first. Pure helpers are exported for test/tile-ops.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  var ACTORS = [["", "Everyone"], ["you", "You"], ["claude", "Claude"], ["agent", "Agents"], ["system", "System"]];
  var AREAS = { board: "Ops board", audit: "Audit", monitoring: "Monitoring", changes: "Change log" };
  var WHO = { you: "You", claude: "Claude", agent: "An agent", system: "System", unknown: "Someone" };

  function filterByActor(items, actor) { return (items || []).filter(function (i) { return !actor || i.actor === actor; }); }
  function counts(items) {
    var c = { "": (items || []).length };
    (items || []).forEach(function (i) { c[i.actor] = (c[i.actor] || 0) + 1; });
    return c;
  }
  function whoLabel(actor) { return WHO[actor] || WHO.unknown; }
  function areaLabel(area) { return AREAS[area] || area; }
  function safeHref(h) { return /^[a-z0-9-]+\.html(#[A-Za-z0-9_-]+)?$/.test(String(h || "")) ? h : ""; }

  // The change-log form: what changed and how to undo it are required; the rest is optional.
  var BLANK = { what: "", where: "", why: "", undo: "", link: "" };
  function changeToBody(v) {
    if (!String(v.what).trim()) return { error: "Say what changed.", field: "what" };
    if (!String(v.undo).trim()) return { error: "Say how to undo it: one line is enough.", field: "undo" };
    var body = { what: String(v.what).trim(), undo: String(v.undo).trim() };
    ["where", "why", "link"].forEach(function (k) { if (String(v[k]).trim()) body[k] = String(v[k]).trim(); });
    if (body.link && !/^https:\/\/[^\s"'<>]{4,300}$/.test(body.link) && !/^[A-Za-z0-9 #._\/:()-]{1,60}$/.test(body.link)) return { error: "A link starts with https:// (or is a short reference such as PR 444).", field: "link" };
    return { body: body };
  }

  var helpers = { ACTORS: ACTORS, filterByActor: filterByActor, counts: counts, whoLabel: whoLabel, areaLabel: areaLabel, safeHref: safeHref, changeToBody: changeToBody, BLANK: BLANK };
  var desc = { id: "activity", title: "Activity & changes", about: "What changed lately, who did it, and the change log with how to undo each change.", w: 4, h: 8, minW: 3, minH: 3, maxW: 12, maxH: 30, ownerOnly: true, permission: "tile.activity" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var st = { items: [], actor: "" };
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var add = h("button", "btn btn-sm", "Change log"); add.type = "button"; add.addEventListener("click", function () { openLog(load); });
    head.appendChild(add);
    var filters = h("div", "tk-bar tl-more");
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(filters); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint() {
      clear(filters); clear(body);
      var c = counts(st.items);
      ACTORS.forEach(function (a) {
        var b = h("button", "btn btn-sm" + (st.actor === a[0] ? " btn-primary" : ""), a[1] + (c[a[0]] ? " " + c[a[0]] : ""));
        b.type = "button"; b.setAttribute("aria-pressed", String(st.actor === a[0]));
        b.addEventListener("click", function () { st.actor = a[0]; paint(); });
        filters.appendChild(b);
      });
      var list = filterByActor(st.items, st.actor);
      if (!list.length) { body.appendChild(h("p", "dim", st.items.length ? "Nothing from that source in the latest entries." : "Nothing has happened yet.")); return; }
      var now = Date.now(), ul = h("ul", "tl-list");
      list.slice(0, 40).forEach(function (i, n) {
        var li = h("li", "tl-row" + (n >= 4 ? " tl-rich-row" : ""));
        var href = safeHref(i.href);
        var text = href ? h("a", null, i.text) : h("span", null, i.text);
        if (href) text.href = href;
        li.appendChild(text);
        li.appendChild(h("span", "dim", whoLabel(i.actor) + " · " + K.agoText(i.ts, now)));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    function load() {
      return K.call("GET", "/hub/activity?limit=40").then(function (r) {
        if (r.status === 200 && r.body && Array.isArray(r.body.items)) { st.items = r.body.items; paint(); return; }
        clear(filters); K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  function openLog(onClose) {
    var d = K.openDrawer("Change log", onClose);
    var msg = null;
    function show() {
      clear(d.body); clear(d.footer);
      if (msg) { var m = h("div", "tk-msg " + msg.tone, msg.text + " "); if (msg.login) { var a = h("a", "btn btn-sm", "Sign in again"); a.href = msg.login; m.appendChild(a); } d.body.appendChild(m); }
      d.body.appendChild(h("p", "dim", "Write down every change you make to the setup: what, where, why and how to undo it. Entries cannot be edited or removed, so the log can be trusted."));
      var form = h("form", "tk-form"); form.noValidate = true; var inputs = {};
      [["what", "What changed", true], ["where", "Where", false], ["why", "Why", false], ["undo", "How to undo it", true], ["link", "Link or reference (a PR, an Ops item)", true]].forEach(function (f) {
        var l = h("label", f[2] ? "wide" : "", f[1]); var i = h("input"); i.type = "text"; i.maxLength = 400; inputs[f[0]] = i; l.appendChild(i); form.appendChild(l);
      });
      d.body.appendChild(form);
      var save = h("button", "btn btn-primary", "Add to the log"); save.type = "button";
      d.footer.appendChild(save);
      save.addEventListener("click", function () {
        var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value; });
        var built = changeToBody(vals);
        if (built.error) { msg = { text: built.error, tone: "alert" }; show(); if (inputs[built.field]) inputs[built.field].focus(); return; }
        save.disabled = true;
        K.call("POST", "/reg/changes", built.body).then(function (r) {
          if (r.status === 201) { msg = { text: "Added to the log.", tone: "ok" }; list(); return; }
          msg = { text: K.errorText(r.body, r.status), tone: "alert", login: K.needsSignIn(r.body, r.status) ? K.loginHref() : null }; show();
        });
      });
      var past = h("div"); d.body.appendChild(past);
      d.body.appendChild(h("p", "tl-sub", "Latest entries"));
      K.call("GET", "/reg/changes?limit=50").then(function (r) {
        if (r.status !== 200) { d.body.appendChild(h("p", "dim", K.errorText(r.body, r.status))); return; }
        if (!r.body.changes.length) { d.body.appendChild(h("p", "dim", "No entries yet.")); return; }
        var rows = h("div", "tk-rows");
        r.body.changes.forEach(function (c) {
          var item = h("div", "tk-item"), main = h("div", "tk-item-main");
          main.appendChild(h("span", "tk-item-name", c.what));
          main.appendChild(h("span", "tk-item-meta", [c.where, c.why].filter(Boolean).join(" · ")));
          main.appendChild(h("span", "tk-item-meta", "To undo: " + c.undo));
          var chips = h("div", "tk-item-chips"); chips.appendChild(chip(whoLabel(c.by === "owner" ? "you" : c.by) + " · " + K.agoText(c.at, Date.now()), ""));
          item.appendChild(main); item.appendChild(chips); rows.appendChild(item);
        });
        d.body.appendChild(rows);
      });
    }
    function list() { show(); }
    show();
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render, openLog: openLog });
})(typeof window !== "undefined" ? window : globalThis);
