// The Quick capture tile: one box that files a thought where it belongs. It used to be a fixed form at the top of the Overview;
// as a tile it can be moved, resized and hidden in Customise like the rest, and it is shown or hidden for a person by the
// user manager (permission tile.capture).
//
//   Note      a note in the Notebook's inbox (POST /hub/capture)
//   Ops item  an Ops item in the backlog, yours (POST /ops/items)
//   Proposal  an idea for you to approve (POST /ops/items with proposal:true)
//
// The first line is the title; the rest goes in the details. The tile asks nothing of the Worker until you press Add. It
// learns who is signed in from the Overview's own status answer (tile-kit.js's bus, topic "status"): no answer means a visitor
// or a guest, and it says so instead of offering a form that cannot work. After an Ops item is filed it asks the Overview to
// read the board again (topic "refresh").
//
// Needs tile-kit.js first. Pure helpers are exported for test/tile-capture.test.js and for overview.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // ---- pure helpers ---------------------------------------------------------------------------------------------------

  // kind + the text typed -> { base: "hub"|"ops", path, body } or null when there is nothing to file or it is too long for
  // that kind. path is relative to its base (the hub routes are /hub/..., the Ops routes /ops/...).
  function buildCapture(kind, text) {
    var t = String(text == null ? "" : text).replace(/\r\n/g, "\n").trim();
    if (!t) return null;
    if (kind === "note") return t.length > 8000 ? null : { base: "hub", path: "/capture", body: { text: t } };
    if (kind !== "item" && kind !== "proposal") return null;
    var first = t.split("\n")[0].replace(/\s+/g, " ").trim();
    var title = first.slice(0, 120).trim();
    if (!title) return null;
    var body = { title: title, lane: "backlog", category: "other" };
    if (t.length > title.length) {
      if (t.length > 6000) return null;
      body.details = t;
    }
    if (kind === "proposal") body.proposal = true; else body.owner = "you";
    return { base: "ops", path: "/items", body: body };
  }

  var KINDS = [
    { value: "note", label: "Note", short: "Note", done: "Saved to your Notebook inbox" },
    { value: "item", label: "Ops item", short: "Item", done: "Added to the backlog" },
    { value: "proposal", label: "Proposal", short: "Idea", done: "Proposal added" }
  ];
  function kindFor(value) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i].value === value) return KINDS[i]; return KINDS[0]; }

  // The words for a refused or failed save (status 0 = the network failed).
  function failText(status) {
    return status === 401 ? "Your session has expired. Log in again."
      : status === 422 ? "That looks like it holds a password or key, so it was not saved."
      : status === 403 ? "Your account can’t save that here."
      : "Couldn’t save it just now. Try again.";
  }
  // Why nothing was filed when buildCapture said no.
  function refuseText(text) { return String(text || "").trim() ? "That is too long for this kind. Shorten it, or use a note." : "Type something first."; }

  // Narrow tiles use the short names for the kinds so the select stays small (under this many px of tile width).
  var COMPACT_BELOW = 360;
  function isCompact(widthPx) { return typeof widthPx === "number" && widthPx > 0 && widthPx < COMPACT_BELOW; }

  var desc = {
    id: "capture", title: "Quick capture",
    about: "One box to file a note, an Ops item or a proposal without leaving the Overview.",
    w: 12, h: 2, minW: 3, minH: 2, maxW: 12, maxH: 6, ownerOnly: true, permission: "tile.capture", defaultOn: true, order: 0
  };

  var helpers = { buildCapture: buildCapture, KINDS: KINDS, kindFor: kindFor, failText: failText, refuseText: refuseText, isCompact: isCompact, COMPACT_BELOW: COMPACT_BELOW, descriptor: desc };
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;
  root.BarnyardCapture = helpers;

  // ---- the tile (browser only) --------------------------------------------------------------------------------------------

  var h = K.h, clear = K.clear;
  var seq = 0;

  function render(container) {
    var uid = ++seq;
    var wrap = h("div", "tl tl-capture");
    var form = h("form", "tl-cap-form");
    form.setAttribute("autocomplete", "off");
    var label = h("label", "sr-only", "Capture a thought, task or idea");
    label.setAttribute("for", "tl-cap-input-" + uid);
    var input = h("input", "tl-cap-input");
    input.type = "text"; input.id = "tl-cap-input-" + uid; input.maxLength = 500;
    input.placeholder = "Capture a thought, task or idea…";
    var kindLabel = h("label", "sr-only", "File it as");
    kindLabel.setAttribute("for", "tl-cap-kind-" + uid);
    var select = h("select", "tl-cap-kind");
    select.id = "tl-cap-kind-" + uid;
    KINDS.forEach(function (k) { var o = h("option", null, k.label); o.value = k.value; select.appendChild(o); });
    var add = h("button", "btn btn-sm", "Add");
    add.type = "submit";
    var status = h("span", "dim tl-cap-status");
    status.setAttribute("role", "status");
    form.appendChild(label); form.appendChild(input); form.appendChild(kindLabel); form.appendChild(select); form.appendChild(add); form.appendChild(status);
    var notice = h("div", "tl-cap-notice");
    notice.hidden = true;
    wrap.appendChild(form); wrap.appendChild(notice);
    clear(container); container.appendChild(wrap);

    // Short kind names in a narrow tile; the full names (and the accessible label) otherwise.
    function setCompact(on) {
      wrap.classList.toggle("is-compact", on);
      Array.prototype.forEach.call(select.options, function (o) { var k = kindFor(o.value); o.textContent = on ? k.short : k.label; });
    }
    var observer = null;
    function measure() { setCompact(isCompact(wrap.clientWidth)); }
    if (typeof ResizeObserver === "function") { observer = new ResizeObserver(measure); observer.observe(wrap); }
    measure();

    // Who is signed in comes from the Overview's status answer: undefined = not known yet (offer the form), null = nobody who may use it.
    function show(statusAnswer) {
      var blocked = statusAnswer === null;
      form.hidden = blocked;
      notice.hidden = !blocked;
      if (blocked) {
        clear(notice);
        var p = h("p", "dim", "Quick capture is for the hub owner. Log in to use it.");
        notice.appendChild(p);
        var href = K.loginHref();
        if (href) { var a = h("a", "btn btn-sm", "Log in"); a.href = href; notice.appendChild(a); }
      }
    }
    var unsub = K.subscribe("status", show);
    if (K.latest("status") === undefined) show(undefined);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var kind = select.value, plan = buildCapture(kind, input.value);
      if (!plan) { status.textContent = refuseText(input.value); return; }
      add.disabled = true;
      status.textContent = "Saving…";
      K.call("POST", (plan.base === "hub" ? "/hub" : "/ops") + plan.path, plan.body).then(function (r) {
        add.disabled = false;
        if (r.status >= 200 && r.status < 300) {
          input.value = ""; status.textContent = "";
          if (root.BarnyardShell && root.BarnyardShell.toast) root.BarnyardShell.toast(kindFor(kind).done);
          if (plan.base === "ops") K.publish("refresh", Date.now());
        } else status.textContent = failText(r.status);
      });
    });

    return {
      refresh: function () {},
      destroy: function () {
        if (unsub) unsub();
        if (observer) observer.disconnect();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };
  }

  K.register({
    id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH,
    ownerOnly: true, permission: desc.permission, defaultOn: true, order: desc.order, render: render
  });
})(typeof window !== "undefined" ? window : globalThis);
