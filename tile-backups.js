// The Backups tile: whether each backup actually ran, and when a restore was last proved to work. The tile shows the numbers and
// what needs a look; "Open backups" opens the jobs in a drawer, where a job is added or changed, its check-in link is made (shown
// once, with the line to add to the job's script) and a restore test is logged.
//
// Talks to /reg/backups/* on the Worker (ClaudeRepo's cloudflare-worker/src/registry-backups.js, owner only):
//   GET /reg/summary (the tile), GET|POST /reg/backups, PATCH|DELETE /reg/backups/<id>, POST|DELETE /reg/backups/<id>/token,
//   GET|POST /reg/backups/<id>/tests, DELETE /reg/tests/<id>.
// A job tells the Worker it finished by calling its check-in link; if no good check-in arrives inside the job's window it is
// overdue and an email goes out (in business hours) from the monitoring mailbox. The next restore test also becomes an Ops item
// with a Due date, so it shows on the Calendar. The data lives on the server and in the hub backup; the browser keeps nothing.
// The check-in link is never kept anywhere: it is on the screen once, and that is the only time.
//
// Needs tile-kit.js first. Pure helpers are exported for test/tile-backups.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // ---- 1. pure helpers ------------------------------------------------------------------------------------------

  var STATE = {
    ok: { label: "On time", tone: "ok" }, waiting: { label: "Waiting for the first check-in", tone: "info" }, overdue: { label: "Overdue", tone: "alert" },
    failing: { label: "Failing", tone: "alert" }, unmonitored: { label: "No check-in link", tone: "attn" }, paused: { label: "Paused", tone: "" }
  };
  var RESTORE = {
    never: { label: "Restore never tested", tone: "attn" }, ok: { label: "Restore proven", tone: "ok" }, soon: { label: "Restore test due soon", tone: "attn" },
    overdue: { label: "Restore test overdue", tone: "alert" }, failed: { label: "Last restore test did not fully work", tone: "alert" }
  };
  var RESULTS = [["ok", "It worked"], ["partial", "Partly worked"], ["failed", "It did not work"]];

  function stateInfo(state) { return STATE[state] || { label: state, tone: "" }; }
  function restoreInfo(status) { return RESTORE[status] || { label: status, tone: "" }; }

  // The numbers on the tile, from GET /reg/summary (its `backups` block).
  function glance(summary) {
    var b = summary && summary.backups ? summary.backups : null;
    if (!b) return { count: 0, ok: 0, needLook: 0, unproven: 0, next: null, threeTwoOne: 0 };
    var by = b.by || {};
    var unproven = (b.attention || []).filter(function (a) { return /^restore_/.test(a.why); }).length;
    return {
      count: b.count || 0, ok: by.ok || 0, needLook: (by.overdue || 0) + (by.failing || 0), unproven: unproven,
      next: b.nextRestore || null, threeTwoOne: b.threeTwoOne || 0, unmonitored: by.unmonitored || 0
    };
  }

  // One line per thing that needs a look: { name, text, tone }.
  function attentionRows(summary, now) {
    var b = summary && summary.backups ? summary.backups : null;
    if (!b) return [];
    return (b.attention || []).map(function (a) {
      var since = a.since ? " since " + K.dateText(new Date(a.since).toISOString().slice(0, 10)) : "";
      var text = a.why === "overdue" ? "Overdue" + since : a.why === "failing" ? "Failing" + since
        : a.why === "restore_never" ? "Restore never tested" : a.why === "restore_overdue" ? "Restore test overdue" : a.why === "restore_failed" ? "Last restore test did not fully work" : a.why;
      return { name: a.name, text: text, tone: /overdue|failing|failed/.test(a.why) ? "alert" : "attn" };
    });
  }

  // The words under a job's name: when it last ran and when it is next due to.
  function runLine(job, now) {
    if (!job.hasToken) return "Not watched: make a check-in link and add it to the job's script.";
    if (!job.lastOkAt) return "Link made " + K.agoText(job.tokenCreatedAt, now) + "; no check-in yet.";
    var s = "Last good run " + K.agoText(job.lastOkAt, now);
    if (job.lastStatus === "fail" && job.lastFailAt >= job.lastOkAt) s = "Reported a failure " + K.agoText(job.lastFailAt, now) + "; last good run " + K.agoText(job.lastOkAt, now);
    else if (job.lastStatus === "warn") s += " (with a warning)";
    return s + ".";
  }

  var BLANK = { name: "", what: "", dest: "", schedule: "", retention: "", owner: "", runbook: "", expectedHours: "26", enabled: true, copy3: false, media2: false, offsite1: false, notes: "" };
  function formValues(job) {
    if (!job) return Object.assign({}, BLANK);
    return {
      name: job.name, what: job.what, dest: job.dest, schedule: job.schedule, retention: job.retention, owner: job.owner, runbook: job.runbook,
      expectedHours: String(job.expectedHours), enabled: !!job.enabled, copy3: !!job.copy3, media2: !!job.media2, offsite1: !!job.offsite1, notes: job.notes
    };
  }
  // The request body from the form: only what changed against `current`. -> { body } or { error, field }.
  function formToBody(values, current) {
    var name = String(values.name).trim();
    if (!name) return { error: "Give the backup a name.", field: "name" };
    var hours = String(values.expectedHours).trim();
    if (!/^\d{1,3}$/.test(hours) || +hours < 1 || +hours > 744) return { error: "Hours between runs must be a whole number from 1 to 744 (26 suits a nightly job).", field: "expectedHours" };
    var next = Object.assign({}, values, { name: name, expectedHours: +hours });
    var before = formValues(current);
    before.expectedHours = current ? current.expectedHours : 26;
    var body = {};
    ["name", "what", "dest", "schedule", "retention", "owner", "runbook", "notes"].forEach(function (k) { var v = String(next[k]).trim(); if (!current || before[k] !== v) body[k] = v; });
    if (!current || before.expectedHours !== next.expectedHours) body.expectedHours = next.expectedHours;
    ["enabled", "copy3", "media2", "offsite1"].forEach(function (k) { if (!current || before[k] !== !!next[k]) body[k] = !!next[k]; });
    return { body: body };
  }

  // The restore-test form: a real date, what was restored and how it went; the next test date is optional.
  function testToBody(values) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.testedOn))) return { error: "Choose the date of the test.", field: "testedOn" };
    if (!String(values.what).trim()) return { error: "Say what you restored.", field: "what" };
    var body = { testedOn: values.testedOn, what: String(values.what).trim(), result: values.result };
    if (String(values.by).trim()) body.by = String(values.by).trim();
    if (String(values.notes).trim()) body.notes = String(values.notes).trim();
    if (String(values.nextDue).trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.nextDue)) || values.nextDue < values.testedOn) return { error: "The next test date must be on or after this one.", field: "nextDue" };
      body.nextDue = values.nextDue;
    }
    return { body: body };
  }

  // The line to put at the end of the job's script, for each place it may run.
  function linkSnippets(url) {
    return [
      { label: "Linux or macOS script", text: "curl -fsS -m 20 " + url },
      { label: "Windows PowerShell (for example a Veeam post-job script)", text: "Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 " + url + " | Out-Null" },
      { label: "If the job failed", text: "curl -fsS -m 20 " + url + "/fail" }
    ];
  }

  var helpers = {
    STATE: STATE, RESTORE: RESTORE, RESULTS: RESULTS, stateInfo: stateInfo, restoreInfo: restoreInfo, glance: glance, attentionRows: attentionRows,
    runLine: runLine, formValues: formValues, formToBody: formToBody, testToBody: testToBody, linkSnippets: linkSnippets
  };
  var desc = { id: "backups", title: "Backups", about: "Whether each backup ran, and when you last proved a restore works.", w: 6, h: 7, minW: 3, minH: 3, maxW: 12, maxH: 24, ownerOnly: true, permission: "tile.backups" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  // ---- 2. the tile ----------------------------------------------------------------------------------------------

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var state = { summary: null };
    var wrap = h("div", "tl");
    var head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("button", "btn btn-sm", "Open backups"); open.type = "button";
    open.addEventListener("click", function () { openBackups(load); });
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body);
    clear(container); container.appendChild(wrap);

    function paint() {
      clear(body);
      var g = glance(state.summary);
      if (!g.count) {
        var empty = h("div", "tl-notice");
        empty.appendChild(h("p", "dim", "No backups recorded yet. Add each backup you rely on, give it a check-in link, and this tile will tell you when one stops running."));
        var b = h("button", "btn btn-sm btn-primary", "Add your first backup"); b.type = "button"; b.addEventListener("click", function () { openBackups(load, true); });
        empty.appendChild(b); body.appendChild(empty);
        return;
      }
      var stats = h("ul", "tl-stats");
      function stat(n, label, tone) { var li = h("li", "tl-stat" + (tone ? " " + tone : "")); li.appendChild(h("b", null, n)); li.appendChild(h("span", null, label)); stats.appendChild(li); }
      stat(String(g.count), g.count === 1 ? "backup job" : "backup jobs");
      stat(String(g.needLook), "overdue or failing", g.needLook ? "alert" : "");
      stat(String(g.unproven), "restore not proven", g.unproven ? "attn" : "");
      stat(g.next ? K.dateText(g.next.nextDue) : "None", g.next ? "next restore test" : "restore tests set");
      body.appendChild(stats);

      var rows = attentionRows(state.summary, Date.now());
      var more = h("div", "tl-more");
      more.appendChild(h("p", "tl-sub", rows.length ? "Needs a look" : "All on time"));
      if (!rows.length) more.appendChild(h("p", "dim", g.unmonitored ? K.plural(g.unmonitored, "job has", "jobs have") + " no check-in link yet, so nothing is watching " + (g.unmonitored === 1 ? "it." : "them.") : "Every watched backup has checked in on time."));
      else {
        var ul = h("ul", "tl-list");
        rows.slice(0, 4).forEach(function (r) { var li = h("li", "tl-row"); li.appendChild(h("span", null, r.name)); li.appendChild(chip(r.text, r.tone)); ul.appendChild(li); });
        more.appendChild(ul);
      }
      body.appendChild(more);
      var rich = h("div", "tl-rich");
      rich.appendChild(h("p", "dim", g.threeTwoOne + " of " + g.count + " " + (g.count === 1 ? "job meets" : "jobs meet") + " the 3-2-1 rule (three copies, two kinds of storage, one offsite)."));
      body.appendChild(rich);
    }

    function load() {
      return K.call("GET", "/reg/summary").then(function (r) {
        if (r.status === 200) { state.summary = r.body; paint(); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  // ---- 3. the jobs (the drawer) ---------------------------------------------------------------------------------

  function openBackups(onClose, startWithForm) {
    var st = { jobs: [], summary: null, msg: null };
    var d = K.openDrawer("Backups", onClose);
    var foot = d.footer;
    function say(text, tone) { st.msg = text ? { text: text, tone: tone || "" } : null; }
    function fail(r) { say(K.errorText(r.body, r.status), "alert"); if (K.needsSignIn(r.body, r.status) && K.loginHref()) st.msg.login = K.loginHref(); }
    function messageBox() {
      if (!st.msg) return null;
      var m = h("div", "tk-msg " + st.msg.tone, st.msg.text + " ");
      if (st.msg.login) { var a = h("a", "btn btn-sm", "Sign in again"); a.href = st.msg.login; m.appendChild(a); }
      return m;
    }
    function reload() {
      return K.call("GET", "/reg/backups").then(function (r) {
        if (r.status === 200) { st.jobs = r.body.jobs || []; st.summary = r.body.summary || null; } else fail(r);
        showList();
      });
    }
    function field(form, inputs, key, label, el, wide, hint) {
      var l = h("label", wide ? "wide" : "", label); inputs[key] = el; l.appendChild(el);
      if (hint) l.appendChild(h("span", "hint", hint));
      form.appendChild(l); return el;
    }

    function showList() {
      clear(d.body); clear(foot);
      d.setTitle("Backups");
      var m = messageBox(); if (m) d.body.appendChild(m);
      var bar = h("div", "tk-bar");
      var add = h("button", "btn btn-sm btn-primary", "Add a backup"); add.type = "button"; add.addEventListener("click", function () { showJobForm(null); });
      bar.appendChild(add); d.body.appendChild(bar);
      if (!st.jobs.length) { d.body.appendChild(h("p", "dim", "No backups recorded yet.")); return; }
      var now = Date.now();
      var rows = h("div", "tk-rows");
      st.jobs.forEach(function (j) {
        var item = h("div", "tk-item");
        var main = h("div", "tk-item-main");
        main.appendChild(h("span", "tk-item-name", j.name));
        var meta = h("span", "tk-item-meta");
        [j.what, j.dest ? "To " + j.dest : "", j.schedule, j.retention ? "Kept " + j.retention : "", j.owner ? "Owner: " + j.owner : ""].forEach(function (t) { if (t) meta.appendChild(h("span", null, t)); });
        main.appendChild(meta);
        main.appendChild(h("span", "tk-item-meta", runLine(j, now)));
        var rs = restoreInfo(j.restore.status);
        main.appendChild(h("span", "tk-item-meta", rs.label + (j.restore.lastTestedOn ? " (last " + K.dateText(j.restore.lastTestedOn) + ", next " + K.dateText(j.restore.nextDue) + ")" : "") + (j.copy3 && j.media2 && j.offsite1 ? " · 3-2-1" : "")));
        var chips = h("div", "tk-item-chips");
        var si = stateInfo(j.state); chips.appendChild(chip(si.label, si.tone));
        if (j.restore.status !== "ok") chips.appendChild(chip(rs.label, rs.tone));
        var edit = h("button", "btn btn-sm", "Edit"); edit.type = "button"; edit.addEventListener("click", function () { showJobForm(j); });
        var link = h("button", "btn btn-sm", j.hasToken ? "New link" : "Check-in link"); link.type = "button"; link.addEventListener("click", function () { makeLink(j); });
        var test = h("button", "btn btn-sm", "Log a restore test"); test.type = "button"; test.addEventListener("click", function () { showTestForm(j); });
        chips.appendChild(edit); chips.appendChild(link); chips.appendChild(test);
        item.appendChild(main); item.appendChild(chips);
        rows.appendChild(item);
      });
      d.body.appendChild(rows);
    }

    function showJobForm(job) {
      clear(d.body); clear(foot);
      d.setTitle(job ? "Edit " + job.name : "Add a backup");
      var v = formValues(job);
      var form = h("form", "tk-form"); form.noValidate = true;
      var inputs = {};
      function text(key, label, wide, hint) { var i = h("input"); i.type = "text"; i.value = v[key]; i.maxLength = 200; return field(form, inputs, key, label, i, wide, hint); }
      function check(key, label, wide) {
        var l = h("label", wide ? "wide" : "");
        var c = h("input"); c.type = "checkbox"; c.checked = v[key]; inputs[key] = c;
        l.appendChild(c); l.appendChild(document.createTextNode(" " + label)); form.appendChild(l);
      }
      text("name", "Name", true, "For example: Nightly VM backup");
      text("what", "What is backed up", true);
      text("dest", "Where it goes");
      text("schedule", "When it runs");
      text("retention", "How long it is kept");
      text("owner", "Who looks after it");
      text("expectedHours", "Hours allowed between runs", false, "26 suits a nightly job; 170 a weekly one. Past this with no check-in, it is overdue.");
      text("runbook", "Restore runbook (a Knowledgebase article title)");
      check("copy3", "There are three copies of the data");
      check("media2", "On two kinds of storage");
      check("offsite1", "One copy is offsite");
      check("enabled", "Watch this backup (untick to pause it while you change something)", true);
      var notes = h("textarea"); notes.value = v.notes; notes.maxLength = 500; field(form, inputs, "notes", "Notes (never a password or key; say where it is kept)", notes, true);
      var msg = h("div"); d.body.appendChild(msg); d.body.appendChild(form);
      var save = h("button", "btn btn-primary", job ? "Save changes" : "Add it"); save.type = "button";
      var cancel = h("button", "btn", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", function () { say(null); showList(); });
      foot.appendChild(save); foot.appendChild(cancel);
      if (job) {
        var del = h("button", "btn btn-quiet tk-push", "Remove"); del.type = "button";
        del.addEventListener("click", function () {
          if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Really remove it and its restore tests?"; return; }
          del.disabled = true;
          K.call("DELETE", "/reg/backups/" + job.id + "?confirm=1").then(function (r) { if (r.status === 200) say("Removed " + job.name + ".", "ok"); else fail(r); reload(); });
        });
        foot.appendChild(del);
      }
      save.addEventListener("click", function () {
        var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].type === "checkbox" ? inputs[k].checked : inputs[k].value; });
        var built = formToBody(vals, job);
        clear(msg);
        if (built.error) { msg.appendChild(h("div", "tk-msg alert", built.error)); if (inputs[built.field]) inputs[built.field].focus(); return; }
        if (job && !Object.keys(built.body).length) { say("Nothing changed.", ""); showList(); return; }
        save.disabled = true;
        (job ? K.call("PATCH", "/reg/backups/" + job.id, built.body) : K.call("POST", "/reg/backups", built.body)).then(function (r) {
          if (r.status === 200 || r.status === 201) { say((job ? "Saved " : "Added ") + r.body.job.name + (job ? "." : ". Next, make its check-in link."), "ok"); reload(); return; }
          save.disabled = false; fail(r); clear(msg); var m = messageBox(); if (m) msg.appendChild(m);
        });
      });
      inputs.name.focus();
    }

    function makeLink(job) {
      clear(d.body); clear(foot);
      d.setTitle("Check-in link for " + job.name);
      d.body.appendChild(h("p", null, job.hasToken ? "Making a new link switches the old one off at once. The new one is shown once, here, and is not kept anywhere: copy it now." : "This link is shown once, here, and is not kept anywhere: copy it now. Anyone with it can only say that this one backup finished."));
      var go = h("button", "btn btn-primary", job.hasToken ? "Make a new link" : "Make the link"); go.type = "button";
      var cancel = h("button", "btn", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", function () { showList(); });
      foot.appendChild(go); foot.appendChild(cancel);
      if (job.hasToken) {
        var off = h("button", "btn btn-quiet tk-push", "Switch the link off"); off.type = "button";
        off.addEventListener("click", function () { off.disabled = true; K.call("DELETE", "/reg/backups/" + job.id + "/token").then(function (r) { if (r.status === 200) say("The check-in link for " + job.name + " is switched off.", "ok"); else fail(r); reload(); }); });
        foot.appendChild(off);
      }
      var out = h("div"); d.body.appendChild(out);
      go.addEventListener("click", function () {
        go.disabled = true;
        K.call("POST", "/reg/backups/" + job.id + "/token").then(function (r) {
          clear(out);
          if (r.status !== 200) { fail(r); var m = messageBox(); if (m) out.appendChild(m); go.disabled = false; return; }
          clear(foot);
          var done = h("button", "btn btn-primary", "I have copied it"); done.type = "button"; done.addEventListener("click", function () { say("Check-in link made for " + job.name + ". Add the line to the job's script and it will show as on time after its first run.", "ok"); reload(); });
          foot.appendChild(done);
          out.appendChild(h("div", "tk-msg ok", "Link made. Copy a line below into the end of the job's script, then press the button. You will not be shown it again."));
          linkSnippets(r.body.url).forEach(function (s) {
            out.appendChild(h("p", "tl-sub", s.label));
            var pre = h("input"); pre.type = "text"; pre.readOnly = true; pre.value = s.text; pre.setAttribute("aria-label", s.label); pre.className = "tk-copy";
            pre.addEventListener("focus", function () { pre.select(); });
            out.appendChild(pre);
          });
          var cp = h("button", "btn btn-sm", "Copy the link"); cp.type = "button";
          cp.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(r.body.url).then(function () { cp.textContent = "Copied"; }, function () { cp.textContent = "Select and copy it above"; }); });
          out.appendChild(cp);
        });
      });
    }

    function showTestForm(job) {
      clear(d.body); clear(foot);
      d.setTitle("Restore tests for " + job.name);
      var inputs = {};
      var past = h("div"); d.body.appendChild(past);
      K.call("GET", "/reg/backups/" + job.id + "/tests").then(function (r) {
        clear(past);
        if (r.status !== 200 || !r.body.tests || !r.body.tests.length) { past.appendChild(h("p", "dim", "No restore test logged yet.")); return; }
        past.appendChild(h("p", "tl-sub", "Earlier tests"));
        var rows = h("div", "tk-rows");
        r.body.tests.forEach(function (t) {
          var item = h("div", "tk-item"); var main = h("div", "tk-item-main");
          main.appendChild(h("span", "tk-item-name", K.dateText(t.testedOn) + ": " + t.what));
          main.appendChild(h("span", "tk-item-meta", [t.by, t.notes, "Next test " + K.dateText(t.nextDue)].filter(Boolean).join(" · ")));
          var chips = h("div", "tk-item-chips");
          chips.appendChild(chip(t.result === "ok" ? "It worked" : t.result === "partial" ? "Partly worked" : "It did not work", t.result === "ok" ? "ok" : "alert"));
          var rm = h("button", "btn btn-sm btn-quiet", "Remove"); rm.type = "button";
          rm.addEventListener("click", function () { if (rm.dataset.sure !== "1") { rm.dataset.sure = "1"; rm.textContent = "Really?"; return; } rm.disabled = true; K.call("DELETE", "/reg/tests/" + t.id + "?confirm=1").then(function () { showTestForm(job); }); });
          chips.appendChild(rm);
          item.appendChild(main); item.appendChild(chips); rows.appendChild(item);
        });
        past.appendChild(rows);
      });
      d.body.appendChild(h("p", "tl-sub", "Log a new test"));
      var form = h("form", "tk-form"); form.noValidate = true;
      var today = new Date().toISOString().slice(0, 10);
      var date = h("input"); date.type = "date"; date.value = today; field(form, inputs, "testedOn", "Date of the test", date);
      var res = h("select"); RESULTS.forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; res.appendChild(op); }); field(form, inputs, "result", "How did it go", res);
      var what = h("input"); what.type = "text"; what.maxLength = 200; field(form, inputs, "what", "What did you restore", what, true, "For example: one VM to a spare host, or a mailbox.");
      var by = h("input"); by.type = "text"; by.maxLength = 60; field(form, inputs, "by", "Who did it", by);
      var nd = h("input"); nd.type = "date"; field(form, inputs, "nextDue", "Next test due", nd, false, "Leave empty: a year after a good test, a month after any other.");
      var notes = h("textarea"); notes.maxLength = 400; field(form, inputs, "notes", "Notes", notes, true);
      var msg = h("div"); d.body.appendChild(msg); d.body.appendChild(form);
      var save = h("button", "btn btn-primary", "Log the test"); save.type = "button";
      var back = h("button", "btn", "Back"); back.type = "button"; back.addEventListener("click", function () { reload(); });
      foot.appendChild(save); foot.appendChild(back);
      save.addEventListener("click", function () {
        var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value; });
        var built = testToBody(vals); clear(msg);
        if (built.error) { msg.appendChild(h("div", "tk-msg alert", built.error)); if (inputs[built.field]) inputs[built.field].focus(); return; }
        save.disabled = true;
        K.call("POST", "/reg/backups/" + job.id + "/tests", built.body).then(function (r) {
          if (r.status === 201) { say("Logged. The next restore test of " + job.name + " is on the Calendar for " + K.dateText(r.body.test.nextDue) + ".", "ok"); reload(); return; }
          save.disabled = false; fail(r); clear(msg); var m = messageBox(); if (m) msg.appendChild(m);
        });
      });
      what.focus();
    }

    d.body.appendChild(h("p", "dim", "Loading the backups…"));
    reload().then(function () { if (startWithForm) showJobForm(null); });
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render, openBackups: openBackups });
})(typeof window !== "undefined" ? window : globalThis);
