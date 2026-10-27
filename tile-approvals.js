// The Approvals tile: everything waiting for your decision in one place: proposals on the Ops board and items with a question for you,
// with Approve and Reject on each, and a count of changes proposed in chat that need reviewing. It uses the board's own routes
// (GET /ops/board, POST /ops/items/<id>/decide) and so the board's own rules: only you can decide, and it needs a recent sign-in.
// It creates no new authority. The code changes proposed in chat (the diff, its hash) are reviewed on the Ops page, which the tile links to.
// Needs tile-kit.js first. Pure helpers are exported for test/tile-ops.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // The items that need a decision, oldest first: proposals, then items that ask you something.
  function waiting(items) {
    var open = (items || []).filter(function (i) { return i && i.lane !== "done"; });
    var rows = open.filter(function (i) { return i.proposal; }).map(function (i) { return { id: i.id, title: i.title, kind: "proposal", ask: i.ask || i.next || "", addedAt: i.addedAt || 0 }; });
    open.filter(function (i) { return !i.proposal && i.ask && i.lane === "waiting"; }).forEach(function (i) { rows.push({ id: i.id, title: i.title, kind: "question", ask: i.ask, addedAt: i.addedAt || 0 }); });
    rows.sort(function (a, b) { return a.addedAt - b.addedAt; });
    return rows;
  }
  function decideBody(approve, note) {
    var b = { approve: !!approve };
    if (note && String(note).trim()) b.note = String(note).trim().slice(0, 2000);
    return b;
  }
  var ERRORS = { recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then repeat it.", not_found: "That item has changed or is gone: refresh.", session_required: "Only you, signed in, can decide this.", already_decided: "That was already decided." };
  function decideError(body, status) { return (body && ERRORS[body.error]) || K.errorText(body, status); }
  function pendingCount(res) { return res && Array.isArray(res.changes) ? res.changes.length : null; }
  function summaryLine(rows, pending) {
    var parts = [];
    parts.push(rows.length ? K.plural(rows.length, "decision") + " waiting" : "No decisions waiting");
    if (pending) parts.push(K.plural(pending, "code change") + " to review");
    return parts.join(" · ") + ".";
  }

  var helpers = { waiting: waiting, decideBody: decideBody, decideError: decideError, pendingCount: pendingCount, summaryLine: summaryLine };
  var desc = { id: "approvals", title: "Approvals", about: "Proposals and questions waiting for your decision, with Approve and Reject.", w: 4, h: 8, minW: 3, minH: 3, maxW: 12, maxH: 30, ownerOnly: true, permission: "tile.approvals" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var st = { rows: [], pending: null, msg: null };
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var openOps = h("a", "btn btn-sm", "Open the board"); openOps.href = "ops.html";
    head.appendChild(openOps);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function decide(row, approve, buttons, note) {
      buttons.forEach(function (b) { b.disabled = true; });
      K.call("POST", "/ops/items/" + row.id + "/decide", decideBody(approve, note)).then(function (r) {
        if (r.status === 200) { st.msg = { text: (approve ? "Approved: " : "Rejected: ") + row.title, tone: "ok" }; load(); return; }
        st.msg = { text: decideError(r.body, r.status), tone: "alert", login: K.needsSignIn(r.body, r.status) ? K.loginHref() : null }; paint();
      });
    }
    function paint() {
      clear(body);
      if (st.msg) { var m = h("div", "tk-msg " + st.msg.tone, st.msg.text + " "); if (st.msg.login) { var a = h("a", "btn btn-sm", "Sign in again"); a.href = st.msg.login; m.appendChild(a); } body.appendChild(m); }
      body.appendChild(h("p", "tl-sub", summaryLine(st.rows, st.pending)));
      if (!st.rows.length) return;
      var ul = h("ul", "tl-list tl-approvals");
      st.rows.slice(0, 12).forEach(function (row, n) {
        var li = h("li", "tl-approval" + (n >= 3 ? " tl-rich-row" : ""));
        var t = h("a", null, row.title); t.href = "ops.html#" + row.id;
        li.appendChild(t);
        li.appendChild(chip(row.kind === "proposal" ? "Proposal" : "Question", "attn"));
        if (row.ask) li.appendChild(h("p", "dim tl-more", row.ask.slice(0, 160)));
        var note = h("input"); note.type = "text"; note.placeholder = "Note (optional)"; note.maxLength = 300; note.className = "tl-rich-row"; note.setAttribute("aria-label", "Note for " + row.title);
        var yes = h("button", "btn btn-sm btn-primary", "Approve"), no = h("button", "btn btn-sm", "Reject");
        yes.type = no.type = "button";
        var btns = [yes, no];
        yes.addEventListener("click", function () { decide(row, true, btns, note.value); });
        no.addEventListener("click", function () { decide(row, false, btns, note.value); });
        var bar = h("div", "tk-bar"); bar.appendChild(yes); bar.appendChild(no);
        li.appendChild(note); li.appendChild(bar);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    function load() {
      return Promise.all([K.call("GET", "/ops/board"), K.call("GET", "/chat/pending")]).then(function (res) {
        var b = res[0];
        if (b.status === 200 && b.body && Array.isArray(b.body.items)) { st.rows = waiting(b.body.items); st.pending = pendingCount(res[1].status === 200 ? res[1].body : null); paint(); return; }
        K.loadFailure(body, b, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
