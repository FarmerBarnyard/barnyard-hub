// The Reports tab of the Monitoring page (monitoring.html#reports): the monthly IT report for the committee. The owner's page, like Monitoring.
//
// Reads and writes /reports/* on the Worker (ClaudeRepo's cloudflare-worker/src/reports-routes.js, owner only):
//   GET  /reports/status    the months to pick, the month the next email is for, whether email can go out
//   GET  /reports/preview   ?month=YYYY-MM  the report: sections with a sentence each, facts, a table or a list
//   GET  /reports/download  ?month=&format=html|md  the same report as a file
//   PUT  /reports/notes     { month, notes }  the owner's own sentences (needs a recent sign-in)
//   POST /reports/send      { month }  email it to the saved recipients now (needs a recent sign-in, once a minute)
// The page asks once when it opens and again when the month changes or "Refresh" is pressed; it never polls.
//
// Everything from the server reaches the page through textContent, never as HTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles. Printing uses the page itself (print stylesheet in reports.css), so "Save as PDF"
// is the browser's own.
//
// Layout of this file: 1. pure helpers (exported for test/reports.test.js; no DOM, no network)
//                      2. data   3. rendering   4. actions

(function () {
  "use strict";

  var API = "https://api.barnyard.site/reports";
  var KB_PREFIX = "https://study.barnyard.site/knowledgebase.html#/a/";

  // ---- 1. pure helpers ------------------------------------------------------

  var ERRORS = {
    month_invalid: "That is not a month the report can be made for.",
    month_future: "That month has not started yet.",
    month_too_old: "That month is more than three years back.",
    format_invalid: "Pick HTML or Markdown.",
    section_unknown: "That section cannot have its own sentence.",
    note_invalid: "A sentence can only hold ordinary text.",
    note_too_long: "A sentence can be at most 600 characters.",
    notes_invalid: "The sentences were not understood. Reload the page and try again.",
    secret_refused: "A sentence looks like it holds a password or a key. Take it out: the report is something you forward.",
    pii_refused: "A sentence holds an email address, phone number or similar personal detail. Take it out: the report is something you forward.",
    recent_sign_in_required: "For this, sign in again first (it needs a sign-in from the last couple of hours), then try once more.",
    rate_limited: "That was done a moment ago. Wait a minute and try again.",
    no_recipients: "No address is saved to email it to. Add yours on the Monitoring page first.",
    no_sender_address: "Email is not set up yet (the monitoring mailbox is missing). See the Monitoring page.",
    mail_not_configured: "Email is not set up yet. See the Monitoring page.",
    bad_request: "Microsoft refused the message. Check the monitoring mailbox on the Monitoring page.",
    monitor_disabled: "Monitoring is switched off on the Worker, and the report needs it.",
    forbidden: "Only the owner can use this page.",
    unauthenticated: "Sign in to use this page."
  };

  function errorText(body, status) {
    var code = body && body.error;
    if (code && ERRORS[code]) return ERRORS[code];
    if (status === 0) return "The Worker could not be reached. Check the connection and try again.";
    if (status === 429) return ERRORS.rate_limited;
    if (status >= 500) return "The Worker had a problem (" + status + "). Try again in a moment.";
    return code ? "Something went wrong (" + String(code).slice(0, 40) + ")." : "Something went wrong.";
  }

  // Which sentences changed and what to save: a sentence typed over the made one is saved; one put back to the made one is
  // cleared ("" on the Worker). `drafts` is { sectionId: text } for the boxes on screen; sections that were not touched are left out.
  function notesToSave(sections, drafts) {
    var out = {};
    (sections || []).forEach(function (s) {
      if (s.status !== "ok" || !Object.prototype.hasOwnProperty.call(drafts || {}, s.id)) return;
      var text = String(drafts[s.id]).replace(/\r\n?/g, "\n").trim();
      if (text === String(s.sentence).trim()) return;                 // nothing changed
      out[s.id] = (text === String(s.auto).trim() || text === "") ? "" : text;
    });
    return out;
  }

  // Only a link into the Knowledgebase is ever made clickable from a table cell.
  function safeReviewHref(text) {
    var t = String(text || "");
    return t.indexOf(KB_PREFIX) === 0 && /^[A-Za-z0-9_-]{4,40}$/.test(t.slice(KB_PREFIX.length)) ? t : "";
  }

  function monthOptions(status) {
    return ((status && status.months) || []).map(function (m) { return { value: m.month, label: m.label + (m.month === status.months[0].month ? " (so far)" : "") }; });
  }

  // The line above the report: when the next email goes and what stands in its way.
  function emailLine(status) {
    if (!status) return { tone: "", text: "" };
    var due = null;
    (status.months || []).forEach(function (m) { if (m.month === status.dueMonth) due = m; });
    var label = due ? due.label : status.dueMonth;
    if (status.monthlyEmail === false) return { tone: "warn", text: "The monthly email is switched off (Monitoring, Other alerts). You can still download the report or email it to yourself." };
    var when = "The " + label + " report is emailed to you on the first working day of the next month, inside business hours.";
    if (status.email && !status.email.ready) return { tone: "warn", text: when + " Email is not ready yet: " + errorText({ error: status.email.blocked }, 409) };
    return { tone: "ok", text: when };
  }

  function fileNameFor(month, ext) { return "barnyard-it-report-" + month + "." + ext; }

  function tableCells(row) {
    return (row || []).map(function (c) { var href = safeReviewHref(c); return href ? { text: "Open the review", href: href } : { text: String(c) }; });
  }

  function clockText(ms, tz) {
    try { return new Intl.DateTimeFormat("en-AU", { timeZone: tz || "Australia/Perth", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  var helpers = { errorText: errorText, notesToSave: notesToSave, safeReviewHref: safeReviewHref, monthOptions: monthOptions, emailLine: emailLine, fileNameFor: fileNameFor, tableCells: tableCells, clockText: clockText, ERRORS: ERRORS, KB_PREFIX: KB_PREFIX };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", status: null, month: "", report: null, drafts: {}, flash: null, busy: false, loadedAt: 0 };

  function getJson(url, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 25000);
    var opts = { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    for (var k in init) opts[k] = init[k];
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  function send(method, path, body) {
    var init = { method: method };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return getJson(API + path, init);
  }

  function failState(r) {
    if (r.status === 401) { model.state = "guest"; return true; }
    if (r.status === 403 && r.body && (r.body.error === "forbidden")) { model.state = "forbidden"; return true; }
    return false;
  }

  function loadStatus() {
    return getJson(API + "/status", {}).then(function (r) {
      if (failState(r)) return false;
      if (r.status === 403 && r.body && r.body.error === "monitor_disabled") { model.state = "off"; return false; }
      if (r.status !== 200 || !r.body || !r.body.ok) { model.state = model.status ? "ok" : "error"; return false; }
      model.status = r.body;
      if (!model.month) model.month = r.body.dueMonth;
      return true;
    });
  }

  function loadReport() {
    model.state = model.report ? "ok" : "loading";
    return getJson(API + "/preview?month=" + encodeURIComponent(model.month), {}).then(function (r) {
      if (failState(r)) return;
      if (r.status !== 200 || !r.body || !r.body.report) { model.state = model.report ? "ok" : "error"; if (model.report) model.flash = { text: errorText(r.body, r.status), tone: "alert" }; return; }
      model.report = r.body.report;
      model.drafts = {};
      model.loadedAt = Date.now();
      model.state = "ok";
    });
  }

  function loadAll() {
    return loadStatus().then(function (ok) { return ok ? loadReport() : null; }).then(render);
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
  function btn(text, cls, fn) { var b = h("button", "btn btn-sm" + (cls ? " " + cls : ""), text); b.type = "button"; b.addEventListener("click", fn); if (model.busy) b.disabled = true; return b; }

  function message(text, linkText, href) {
    var box = $("rp-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function flash(text, tone) { model.flash = { text: text, tone: tone || "" }; render(); }

  function renderMonthPicker() {
    var sel = $("rp-month");
    if (!sel || !model.status) return;
    var opts = monthOptions(model.status);
    clear(sel);
    opts.forEach(function (o) { var op = h("option", "", o.label); op.value = o.value; if (o.value === model.month) op.selected = true; sel.appendChild(op); });
    sel.disabled = model.busy;
  }

  function sectionNode(s) {
    var card = h("section", "rp-section " + s.status);
    card.appendChild(h("h2", "", s.title));
    if (s.status === "later") { card.appendChild(h("p", "dim rp-later", "Not in the report yet: " + s.later + ".")); return card; }
    var edit = h("textarea", "rp-edit");
    edit.value = Object.prototype.hasOwnProperty.call(model.drafts, s.id) ? model.drafts[s.id] : s.sentence;
    edit.rows = 2;
    edit.maxLength = (model.status && model.status.noteMax) || 600;
    edit.setAttribute("aria-label", s.title + " sentence");
    if (s.status !== "ok") edit.disabled = true;
    edit.addEventListener("input", function () { model.drafts[s.id] = edit.value; var b = $("rp-save"); if (b) b.disabled = model.busy || !Object.keys(notesToSave(model.report.sections, model.drafts)).length; });
    card.appendChild(edit);
    card.appendChild(h("p", "rp-sentence", s.sentence));
    if (s.status === "ok") {
      var meta = h("p", "rp-meta dim");
      if (s.edited) {
        meta.appendChild(document.createTextNode("Your own sentence. "));
        var reset = h("button", "linklike", "Use the made one");
        reset.type = "button";
        reset.addEventListener("click", function () { model.drafts[s.id] = s.auto; render(); });
        meta.appendChild(reset);
      } else meta.textContent = "Made from the numbers; type over it to use your own words.";
      card.appendChild(meta);
      if (s.facts && s.facts.length) {
        var dl = h("dl", "rp-facts");
        s.facts.forEach(function (f) { dl.appendChild(h("dt", "", f[0])); dl.appendChild(h("dd", "", f[1])); });
        card.appendChild(dl);
      }
      if (s.table && s.table.rows && s.table.rows.length) {
        var wrap = h("div", "rp-tablewrap"), t = h("table", "rp-table"), thead = h("thead"), hr = h("tr");
        s.table.head.forEach(function (c) { hr.appendChild(h("th", "", c)); });
        thead.appendChild(hr); t.appendChild(thead);
        var tb = h("tbody");
        s.table.rows.forEach(function (row) {
          var tr = h("tr");
          tableCells(row).forEach(function (c) {
            var td = h("td");
            if (c.href) { var a = h("a", "", c.text); a.href = c.href; a.rel = "noopener noreferrer"; a.target = "_blank"; td.appendChild(a); } else td.textContent = c.text;
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        t.appendChild(tb); wrap.appendChild(t); card.appendChild(wrap);
        if (s.more) card.appendChild(h("p", "dim", "...and " + s.more + " more."));
      }
      if (s.list && s.list.length) {
        if (s.listTitle) card.appendChild(h("p", "rp-listtitle", s.listTitle));
        var ul = h("ul", "rp-list");
        s.list.forEach(function (l) { ul.appendChild(h("li", "", l)); });
        card.appendChild(ul);
        if (s.more) card.appendChild(h("p", "dim", "...and " + s.more + " more."));
      }
    }
    return card;
  }

  function render() {
    renderMonthPicker();
    var stamp = $("rp-stamp");
    if (stamp) stamp.textContent = model.loadedAt ? "Read " + clockText(model.loadedAt) : "";
    if (model.state === "loading") { message("Loading…"); return; }
    if (model.state === "guest") { message("Sign in to see the reports.", "Sign in", "https://dashboard.barnyard.site/"); return; }
    if (model.state === "forbidden") { message("Reports are the owner's page."); return; }
    if (model.state === "off") { message("Monitoring is switched off on the Worker, and the report is built from it."); return; }
    if (model.state === "error" || !model.report) { message("The report could not be read. Try Refresh in a moment."); return; }

    var box = $("rp-root");
    clear(box);
    var line = emailLine(model.status);
    var strip = h("div", "rp-strip " + line.tone);
    strip.appendChild(h("span", "", line.text));
    var mon = h("a", "rp-link", "Monitoring settings"); mon.href = "monitoring.html";
    strip.appendChild(mon);
    box.appendChild(strip);

    if (model.flash) { var f = h("div", "rp-flash " + (model.flash.tone || ""), model.flash.text); f.setAttribute("role", "status"); box.appendChild(f); }

    var actions = h("div", "rp-actions");
    var pending = Object.keys(notesToSave(model.report.sections, model.drafts)).length;
    var save = btn("Save my sentences", "", saveNotes); save.id = "rp-save"; save.disabled = model.busy || !pending;
    actions.appendChild(save);
    actions.appendChild(btn("Email it to me", "", emailIt));
    actions.appendChild(btn("Download HTML", "btn-quiet", function () { download("html"); }));
    actions.appendChild(btn("Download Markdown", "btn-quiet", function () { download("md"); }));
    actions.appendChild(btn("Print or save as PDF", "btn-quiet", function () { window.print(); }));
    box.appendChild(actions);
    if (pending) box.appendChild(h("p", "dim", "You have changed " + pending + (pending === 1 ? " sentence" : " sentences") + " that " + (pending === 1 ? "is" : "are") + " not saved yet. Downloads and the email use the saved ones."));

    var paper = h("article", "rp-paper");
    var r = model.report;
    paper.appendChild(h("h1", "rp-title", "Barnyard IT report: " + r.label + (r.current ? " (so far)" : "")));
    paper.appendChild(h("p", "rp-sub dim", "Prepared " + clockText(r.generatedAt, r.tz) + ". Monitoring and vulnerability counts use UTC days."));
    r.sections.forEach(function (s) { paper.appendChild(sectionNode(s)); });
    if (r.partial && r.partial.length) paper.appendChild(h("p", "dim", "Could not be read this time: " + r.partial.join(", ") + "."));
    box.appendChild(paper);
  }

  // ---- 4. actions -----------------------------------------------------------

  function setBusy(on) { model.busy = on; render(); }

  function saveNotes() {
    var notes = notesToSave(model.report.sections, model.drafts);
    if (!Object.keys(notes).length) return Promise.resolve();
    setBusy(true);
    return send("PUT", "/notes", { month: model.month, notes: notes }).then(function (r) {
      if (r.status === 200 && r.body && r.body.ok) {
        model.busy = false; model.flash = { text: "Saved. Downloads and the email now use your sentences.", tone: "ok" };
        return loadReport().then(render);
      }
      model.busy = false; flash(errorText(r.body, r.status), "alert");
    });
  }

  // Saving first, so the email and the files say what is on screen.
  function emailIt() {
    var pending = Object.keys(notesToSave(model.report.sections, model.drafts)).length;
    var before = pending ? saveNotes() : Promise.resolve();
    return before.then(function () {
      if (model.flash && model.flash.tone === "alert") return;
      setBusy(true);
      return send("POST", "/send", { month: model.month }).then(function (r) {
        model.busy = false;
        if (r.status === 200 && r.body && r.body.ok) flash("Sent to " + r.body.sent + (r.body.sent === 1 ? " address" : " addresses") + ". It should arrive within a minute.", "ok");
        else flash(errorText(r.body, r.status), "alert");
      });
    });
  }

  function download(format) {
    var pending = Object.keys(notesToSave(model.report.sections, model.drafts)).length;
    var before = pending ? saveNotes() : Promise.resolve();
    return before.then(function () {
      if (model.flash && model.flash.tone === "alert") return;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 25000);
      return fetch(API + "/download?month=" + encodeURIComponent(model.month) + "&format=" + format, { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal }).then(function (res) {
        clearTimeout(timer);
        if (!res.ok) return res.json().catch(function () { return {}; }).then(function (b) { flash(errorText(b, res.status), "alert"); });
        return res.blob().then(function (blob) {
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url; a.download = fileNameFor(model.month, format);
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        });
      }, function () { clearTimeout(timer); flash(errorText({}, 0), "alert"); });
    });
  }

  // ---- the Monitoring page's Reports tab -----------------------------------------------------------------------
  // monitoring.js loads this file the first time the tab is opened and calls start() each time it is shown. The page does not
  // poll, so there is nothing to stop; the report on screen (and any sentences not saved yet) stays as it was when the tab is
  // closed and opened again. The Refresh button and the month picker are in monitoring.html; they are wired once.

  var wired = false, ready = false, pending = false;

  function wire() {
    if (wired) return;
    wired = true;
    var rf = $("rp-refresh"), sel = $("rp-month");
    if (rf) rf.addEventListener("click", function () { model.flash = null; loadAll(); });
    if (sel) sel.addEventListener("change", function () {
      if (Object.keys(notesToSave(model.report ? model.report.sections : [], model.drafts)).length && !window.confirm("You have sentences that are not saved. Leave them behind?")) { renderMonthPicker(); return; }
      model.month = sel.value; model.flash = null; model.report = null; model.drafts = {};
      render(); loadReport().then(render);
    });
  }

  function start() {
    wire();
    if (ready || pending) return;
    pending = true;
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      pending = false;
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      ready = true;
      render(); loadAll();
    });
  }

  function stop() {}

  window.BarnyardTabs = window.BarnyardTabs || {};
  window.BarnyardTabs.reports = { start: start, stop: stop };
  window.BarnyardReports = helpers;
})();
