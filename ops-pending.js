// Ops board: "Pending commits". Changes the owner's Claude chat (edit mode) proposed, waiting for
// a decision. Loaded by ops.html before ops.js.
//
// The chat never pushes anything. When an edit-mode turn ends, the runner posts what changed as a
// plain diff (see the Worker README, "Pending commits"). Here the owner reads it and presses
// Approve and commit or Reject; the desktop Claude then applies an approved change on the PC, runs
// the tests, commits and opens the pull request, and reports the link back, which shows here.
//
// This file holds:
//   - pure helpers (state wording, the diff parser, error wording)   -- tested in test/ops-pending.test.js
//   - render(): the tab's content (list, diff viewer, Approve / Reject)
//   - load(): the list, or null when the chat is off or this isn't the owner (the tab then stays hidden)
//
// Talks to the Worker's /chat/pending routes with the login cookie. Everything is built with
// textContent / createElement, never innerHTML (the page's CSP allows no inline script or style):
// a diff is somebody's code, shown as text.

(function () {
  "use strict";

  var API = "https://api.barnyard.site/chat";
  var MAX_DIFF_LINES = 1500;      // a longer diff is shown cut, with the count of what is hidden

  // ---- 1. pure helpers (no DOM) --------------------------------------------------------

  var STATE_TEXT = {
    pending: "Waiting for you", approved: "Approved: waiting for your desktop Claude", rejected: "Rejected",
    applied: "Applied: pull request opened", failed: "Couldn’t be applied", superseded: "Replaced by a newer change"
  };
  var STATE_TONE = { pending: "warn", approved: "warn", rejected: "", applied: "ok", failed: "bad", superseded: "" };

  function stateChip(change) {
    return { text: STATE_TEXT[change.state] || change.state, tone: STATE_TONE[change.state] || "" };
  }

  // The three groups the tab shows, in order. "waiting" are the ones that need a decision.
  function groupChanges(changes) {
    var out = { waiting: [], approved: [], done: [] };
    (changes || []).forEach(function (c) {
      if (c.state === "pending") out.waiting.push(c);
      else if (c.state === "approved") out.approved.push(c);
      else out.done.push(c);
    });
    return out;
  }

  function waitingCount(changes) {
    return groupChanges(changes).waiting.length;
  }

  // "3 files in study-hub" / "1 file in ClaudeRepo"
  function fileLine(change) {
    var n = (change.files || []).length;
    return n + (n === 1 ? " file" : " files") + " in " + change.repo;
  }

  // Files a person should look at twice (the Worker lists them as `risky`).
  function riskyLine(change) {
    var r = change.risky || [];
    if (!r.length) return "";
    return "This change touches " + r.slice(0, 3).join(", ") + (r.length > 3 ? " and " + (r.length - 3) + " more" : "") + ", which can make code run later. Read it closely.";
  }

  // Turn `git diff` text into files, each with lines tagged add / del / ctx / hunk / meta.
  // Only the first MAX_DIFF_LINES lines are kept; `hidden` says how many were left out.
  function parseDiff(text) {
    var files = [], cur = null, shown = 0, hidden = 0;
    String(text || "").split("\n").forEach(function (line, i, all) {
      if (i === all.length - 1 && line === "") return;
      if (line.indexOf("diff --git ") === 0) {
        var m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
        cur = { file: m ? m[2] : line.slice(11), lines: [], adds: 0, dels: 0 };
        files.push(cur);
        return;
      }
      if (!cur) return;
      if (shown >= MAX_DIFF_LINES) { hidden++; return; }
      var kind = "ctx";
      if (line.indexOf("@@") === 0) kind = "hunk";
      else if (line.indexOf("+++ ") === 0 || line.indexOf("--- ") === 0 || line.indexOf("index ") === 0 || line.indexOf("new file mode") === 0 || line.indexOf("deleted file mode") === 0) kind = "meta";
      else if (line.charAt(0) === "+") { kind = "add"; cur.adds++; }
      else if (line.charAt(0) === "-") { kind = "del"; cur.dels++; }
      cur.lines.push({ kind: kind, text: line });
      shown++;
    });
    return { files: files, hidden: hidden };
  }

  function ago(ts, now) {
    var s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    var d = Math.round(h / 24);
    return d === 1 ? "yesterday" : d + " days ago";
  }

  var ERRORS = {
    recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then try again.",
    changed: "This change was replaced while you were looking at it. The list has been reloaded: read the new one.",
    not_pending: "That change has already been decided.",
    not_found: "That change is gone.",
    chat_disabled: "The chat isn’t switched on for this site.",
    not_for_guest: "Only the owner can decide on pending changes.",
    forbidden: "Only the owner can decide on pending changes.",
    unauthenticated: "Your session has expired. Log in again."
  };
  function pendingError(err) {
    var code = err && err.code;
    if (code && ERRORS[code]) return ERRORS[code];
    if (err && err.status === 401) return ERRORS.unauthenticated;
    if (err && err.status === 403) return ERRORS.forbidden;
    return "That didn’t work. Try again.";
  }

  // What to tell the person after they decide.
  function decidedMessage(decision) {
    return decision === "approve"
      ? "Approved. Your desktop Claude will apply it, run the tests and open a pull request."
      : "Rejected. Nothing will be applied.";
  }

  var helpers = {
    stateChip: stateChip, groupChanges: groupChanges, waitingCount: waitingCount, fileLine: fileLine, riskyLine: riskyLine,
    parseDiff: parseDiff, ago: ago, pendingError: pendingError, decidedMessage: decidedMessage, MAX_DIFF_LINES: MAX_DIFF_LINES
  };
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. DOM --------------------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function signInAgain() {
    var a = document.createElement("a");
    a.href = "https://api.barnyard.site/auth/login?return_to=" + encodeURIComponent(location.href);
    a.textContent = "Sign in again";
    return a;
  }

  function call(method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) { var e = new Error((data && data.error) || "request_failed"); e.status = res.status; e.code = (data && data.error) || null; throw e; }
        return data;
      });
    });
  }

  // The list, or null when it can't be read (chat off, not the owner, offline): the tab stays hidden.
  function load() {
    return call("GET", "/pending").then(function (res) { return res && res.changes ? res.changes : null; }, function () { return null; });
  }

  function diffView(diffText) {
    var parsed = parseDiff(diffText);
    var wrap = el("div", "ops-pc-diff");
    parsed.files.forEach(function (f) {
      var box = el("div", "ops-pc-file");
      var head = el("div", "ops-pc-filehead");
      head.appendChild(el("b", null, f.file));
      head.appendChild(el("span", "ops-dim", "+" + f.adds + " −" + f.dels));
      box.appendChild(head);
      var pre = el("pre", "ops-pc-lines");
      f.lines.forEach(function (l) {
        var row = el("span", "ops-pc-line ops-pc-" + l.kind, l.text === "" ? " " : l.text);
        pre.appendChild(row);
        pre.appendChild(document.createTextNode("\n"));
      });
      box.appendChild(pre);
      wrap.appendChild(box);
    });
    if (parsed.hidden) wrap.appendChild(el("p", "ops-dim", parsed.hidden + " more lines are not shown here. Open the pull request to read them all."));
    return wrap;
  }

  // One change as a card. ctx = { toast(text), reload() }.
  function card(change, ctx) {
    var box = el("div", "ops-pc-card");
    box.setAttribute("data-id", change.id);
    var top = el("div", "ops-run-top");
    top.appendChild(el("b", null, change.title));
    var c = stateChip(change);
    top.appendChild(el("span", "ops-chip" + (c.tone ? " ops-chip-run-" + c.tone : ""), c.text));
    box.appendChild(top);
    box.appendChild(el("p", "ops-dim", fileLine(change) + (change.summary ? " · " + change.summary : "") + " · " + ago(change.createdAt, Date.now())));
    var risky = riskyLine(change);
    if (risky) box.appendChild(el("p", "ops-pc-risky", risky));
    if (change.state === "applied" && change.pr && /^https:\/\/github\.com\//.test(change.pr)) {
      var a = el("a", null, "Open the pull request");
      a.href = change.pr; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.appendChild(a);
    }
    if (change.note) box.appendChild(el("p", "ops-dim", change.note));

    var msg = el("p", "ops-form-msg");
    msg.setAttribute("role", "status");
    var diffArea = el("div");
    var row = el("div", "ops-form-actions");
    var show = el("button", "ops-btn ops-btn-sm", "Show the changes");
    show.type = "button";
    var shown = false;
    show.addEventListener("click", function () {
      if (shown) { clear(diffArea); shown = false; show.textContent = "Show the changes"; return; }
      show.disabled = true;
      call("GET", "/pending/one?id=" + encodeURIComponent(change.id)).then(function (res) {
        clear(diffArea); diffArea.appendChild(diffView(res.change.diff));
        shown = true; show.textContent = "Hide the changes"; show.disabled = false;
      }, function (err) { show.disabled = false; msg.textContent = pendingError(err); });
    });
    row.appendChild(show);

    if (change.state === "pending") {
      var approve = el("button", "ops-btn ops-btn-sm ops-btn-primary", "Approve and commit");
      var reject = el("button", "ops-btn ops-btn-sm", "Reject");
      approve.type = reject.type = "button";
      function decide(decision) {
        approve.disabled = reject.disabled = true;
        call("POST", "/pending/decide", { id: change.id, decision: decision, hash: change.hash }).then(function () {
          ctx.toast(decidedMessage(decision));
          ctx.reload();
        }, function (err) {
          approve.disabled = reject.disabled = false;
          msg.textContent = pendingError(err);
          if (err && err.code === "recent_sign_in_required") { msg.appendChild(document.createTextNode(" ")); msg.appendChild(signInAgain()); }
          if (err && err.code === "changed") ctx.reload();
        });
      }
      approve.addEventListener("click", function () { decide("approve"); });
      reject.addEventListener("click", function () { decide("reject"); });
      row.appendChild(approve);
      row.appendChild(reject);
    }
    box.appendChild(row);
    box.appendChild(msg);
    box.appendChild(diffArea);
    return box;
  }

  function section(title, blurb, changes, ctx) {
    var s = el("section", "ops-pc-section");
    s.appendChild(el("h2", "ops-pc-h", title));
    if (blurb) s.appendChild(el("p", "ops-dim", blurb));
    changes.forEach(function (c) { s.appendChild(card(c, ctx)); });
    return s;
  }

  // The tab's content. changes: the list from load(). ctx = { toast(text), reload() }.
  function render(container, changes, ctx) {
    clear(container);
    var g = groupChanges(changes);
    var wrap = el("div", "ops-pc");
    wrap.appendChild(el("p", "ops-dim", "Changes your Claude chat made in edit mode. Nothing is pushed: you read each change here, and approving it asks your desktop Claude to apply it, run the tests and open a pull request for you to merge."));
    if (!changes.length) wrap.appendChild(el("p", "ops-empty", "No pending changes. They appear here when an edit-mode chat finishes a turn that changed files."));
    if (g.waiting.length) wrap.appendChild(section("Waiting for you", "", g.waiting, ctx));
    if (g.approved.length) wrap.appendChild(section("Approved", "Your desktop Claude picks these up while a session is open.", g.approved, ctx));
    if (g.done.length) wrap.appendChild(section("Earlier", "", g.done.slice(0, 15), ctx));
    container.appendChild(wrap);
  }

  window.OpsPending = { load: load, render: render, helpers: helpers };
})();
