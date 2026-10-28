// The Incidents page (incidents.html): what Monitoring opened, how it went, what changed just before, the guide to follow,
// and the review afterwards. The owner's page, like Monitoring.
//
// Reads and writes /incidents/* on the Worker (ClaudeRepo's cloudflare-worker/src/incident-routes.js, owner only):
//   GET  /incidents/list?status=   /summary   /get?id=   /changes?id=   /checklist?id=
//   POST /incidents/open  /note  /severity  /close  /reopen  /tick  /review  /review/kb
// The page asks for the list and one incident when it opens and once a minute while it is showing (not in a hidden tab);
// "what changed" and the checklist are asked for only when the owner opens that part.
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout of this file: 1. pure helpers (exported for test/incidents.test.js; no DOM, no network)
//                      2. data   3. rendering   4. actions

(function () {
  "use strict";

  var API = "https://api.barnyard.site/incidents";
  var POLL_MS = 60000;
  var TZ = "Australia/Perth";

  // ---- 1. pure helpers ------------------------------------------------------

  var SEVERITIES = ["SEV1", "SEV2", "SEV3", "SEV4"];
  var SEVERITY_ABOUT = {
    SEV1: "Everything is down, or data is at risk.",
    SEV2: "A major service is down or badly degraded.",
    SEV3: "One service is down; a workaround exists or only some use is affected.",
    SEV4: "Cosmetic or low impact."
  };
  var KIND_LABEL = { opened: "Opened", alert: "Alert", reminder: "Reminder", note: "Note", severity: "Severity", recovered: "Recovered", closed: "Closed", reopened: "Reopened", review: "Review" };

  function agoText(ts, now) {
    if (!ts) return "never";
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function durationText(ms) {
    var min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return m ? h + " h " + m + " min" : h + " h";
    var d = Math.floor(h / 24), rest = h % 24;
    return rest ? d + " d " + rest + " h" : d + " d";
  }

  // "Tue 27 Oct 14:42" in the owner's zone.
  function clockText(ms, tz) {
    try {
      var parts = new Intl.DateTimeFormat("en-AU", { timeZone: tz || TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
      return get("weekday") + " " + get("day") + " " + get("month") + " " + get("hour") + ":" + get("minute");
    } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  // The colour word for a severity: SEV1 and SEV2 are alerts, SEV3 needs attention, SEV4 is quiet.
  function severityTone(sev) { return sev === "SEV1" || sev === "SEV2" ? "alert" : sev === "SEV3" ? "attn" : ""; }

  function incidentLine(inc, now) {
    if (inc.status === "resolved") return "Resolved " + agoText(inc.resolvedAt, now) + " after " + durationText(inc.resolvedAt - inc.openedAt) + ".";
    return "Open for " + durationText(now - inc.openedAt) + ", since " + clockText(inc.openedAt) + ".";
  }

  // The list as rows, filtered ("open" | "resolved" | "all"), the open ones first and the most serious first among them.
  function listRows(incidents, filter, now) {
    var list = (Array.isArray(incidents) ? incidents : []).filter(function (i) { return filter === "all" || !filter || i.status === filter; });
    list = list.slice().sort(function (a, b) {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      if (a.status === "open" && a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
      return b.openedAt - a.openedAt;
    });
    return list.map(function (i) {
      return {
        id: i.id, name: i.name, title: i.title, severity: i.severity, status: i.status, tone: i.status === "open" ? severityTone(i.severity) : "ok",
        line: incidentLine(i, now), source: i.source === "auto" ? "Opened by Monitoring" : "Opened by hand", hasReview: !!i.hasReview, kb: i.kbArticle || ""
      };
    });
  }

  // The headline strip.
  function summaryLine(sum) {
    if (!sum || sum.enabled === false) return { tone: "", head: "Incidents are switched off", text: "" };
    var open = sum.open || 0;
    if (!open) return { tone: "ok", head: "No open incidents", text: sum.last30 ? sum.last30 + (sum.last30 === 1 ? " incident" : " incidents") + " in the last 30 days." : "Nothing in the last 30 days." };
    var serious = (sum.bySeverity && (sum.bySeverity.SEV1 || sum.bySeverity.SEV2)) ? true : false;
    return { tone: serious ? "alert" : "attn", head: open + (open === 1 ? " open incident" : " open incidents"), text: SEVERITIES.filter(function (s) { return sum.bySeverity && sum.bySeverity[s]; }).map(function (s) { return sum.bySeverity[s] + " " + s; }).join(", ") + "." };
  }

  // The timeline, oldest first, one row each.
  function timelineRows(timeline, tz) {
    return (Array.isArray(timeline) ? timeline : []).map(function (e) {
      return { when: clockText(e.ts, tz), kind: KIND_LABEL[e.kind] || e.kind, text: e.text, mine: e.actor === "you" };
    });
  }

  function changesRows(changes, tz) {
    var items = (changes && Array.isArray(changes.items) ? changes.items : []).map(function (c) { return { when: clockText(c.ts, tz), area: c.area, text: c.text, href: safeLocalHref(c.href) }; });
    var due = (changes && Array.isArray(changes.renewalsDue) ? changes.renewalsDue : []).map(function (r) {
      return { text: r.label + (r.daysLeft < 0 ? " (overdue)" : r.daysLeft === 0 ? " (due today)" : " (due in " + r.daysLeft + (r.daysLeft === 1 ? " day)" : " days)")), href: safeLocalHref(r.href) };
    });
    return { items: items, renewals: due, partial: !!(changes && changes.partial) };
  }

  // Only a same-site page name is a link; anything else is shown as text.
  function safeLocalHref(href) { return typeof href === "string" && /^[a-z0-9_-]+\.html(#[A-Za-z0-9_-]+)?$/i.test(href) ? href : ""; }
  function safeKbHref(href) { return typeof href === "string" && /^https:\/\/study\.barnyard\.site\/knowledgebase\.html#\/a\/ka_[a-z0-9]{8}$/.test(href) ? href : ""; }

  // The checklist with the owner's ticks applied.
  function checklistModel(list, ticks) {
    var done = Array.isArray(ticks) ? ticks : [];
    var guides = (list && Array.isArray(list.guides) ? list.guides : []).map(function (g) { return { id: g.id, title: g.title, category: g.category, href: safeKbHref(g.href) }; });
    var steps = list && list.steps && Array.isArray(list.steps.items) ? list.steps : null;
    return {
      guides: guides,
      steps: steps ? { title: steps.title, href: safeKbHref(steps.href), items: steps.items.map(function (s) { return { key: s.key, text: s.text, done: done.indexOf(s.key) !== -1 }; }) } : null,
      tickedOf: steps ? steps.items.filter(function (s) { return done.indexOf(s.key) !== -1; }).length : 0
    };
  }

  // What the Worker says, in words.
  var ERRORS = {
    recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then repeat it.",
    unauthenticated: "You are not signed in.",
    forbidden: "This is only for the hub owner.",
    not_found: "That incident is no longer there. Refresh the list.",
    already_open: "Another incident for the same thing is already open. Close that one first.",
    title_required: "Give the incident a title.",
    title_too_long: "The title is too long (100 characters at most).",
    note_too_long: "That note is too long (1,000 characters at most).",
    text_required: "Write something first.",
    review_too_long: "The review is too long (8,000 characters at most).",
    review_not_saved: "Save the review first, then file it in the Knowledgebase.",
    incidents_disabled: "The Incident Room is switched off (the Worker variable INCIDENTS_ENABLED is 0).",
    knowledgebase_unavailable: "The Knowledgebase is not available right now.",
    too_many_ticks: "That is a lot of ticks: untick some first.",
    rate_limited: "Slow down a little: try again in a minute.",
    library_full: "The Knowledgebase is full (1,000 articles).",
    request_failed: "Could not reach the Worker. Check your connection and try again."
  };
  function errorText(body, status) {
    var code = body && typeof body.error === "string" ? body.error : "";
    if (code === "secret_detected") return "That looks like a password or key" + (body.field ? " in the " + body.field + " field" : "") + ". Write where it is kept instead (for example \"in the password manager under X\").";
    if (code === "pii_detected") return "The review has personal details in it (" + (Array.isArray(body.kinds) ? body.kinds.join(", ") : "an address or number") + "). Take them out, save the review, and try again.";
    if (ERRORS[code]) return ERRORS[code];
    if (status === 0) return ERRORS.request_failed;
    if (status === 401) return ERRORS.unauthenticated;
    if (status === 403) return ERRORS.forbidden;
    return "That did not work (" + (code || "error " + status) + ").";
  }

  // What the "open an incident" form sends.
  function openBody(form) {
    var b = { title: String((form && form.title) || "").trim(), severity: SEVERITIES.indexOf(form && form.severity) === -1 ? "SEV3" : form.severity };
    var note = String((form && form.note) || "").trim();
    if (note) b.note = note;
    return b;
  }

  // "#inc_abcd1234" -> "inc_abcd1234"; anything else -> "".
  function idFromHash(hash) {
    var m = /^#(inc_[a-z0-9]{8})$/.exec(String(hash || ""));
    return m ? m[1] : "";
  }

  var helpers = {
    agoText: agoText, durationText: durationText, clockText: clockText, severityTone: severityTone, incidentLine: incidentLine, listRows: listRows,
    summaryLine: summaryLine, timelineRows: timelineRows, changesRows: changesRows, checklistModel: checklistModel, errorText: errorText,
    openBody: openBody, idFromHash: idFromHash, safeLocalHref: safeLocalHref, safeKbHref: safeKbHref, SEVERITIES: SEVERITIES, SEVERITY_ABOUT: SEVERITY_ABOUT, ERRORS: ERRORS
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  // view: "list" or "detail". detail: the opened incident (with timeline) and what has been loaded for it.
  var model = { state: "loading", sum: null, list: [], filter: "open", view: "list", id: "", detail: null, changes: null, check: null, draftText: "", flash: null, busy: false, showForm: false };

  function getJson(url, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
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
    if (r.status === 403) { model.state = "forbidden"; return true; }
    return false;
  }

  function loadList() {
    return Promise.all([getJson(API + "/summary", {}), getJson(API + "/list?status=all", {})]).then(function (res) {
      var s = res[0], l = res[1];
      if (failState(s)) return;
      if (s.status === 0 || s.status >= 500 || !s.body) { model.state = model.sum ? "ok" : "error"; return; }
      model.sum = s.body;
      model.list = l.status === 200 && l.body && Array.isArray(l.body.incidents) ? l.body.incidents : model.list;
      model.state = "ok";
    });
  }

  function loadDetail(id) {
    return getJson(API + "/get?id=" + encodeURIComponent(id), {}).then(function (r) {
      if (failState(r)) return;
      if (r.status === 404) { model.detail = null; model.view = "list"; model.id = ""; return; }
      if (r.status !== 200 || !r.body || !r.body.incident) { if (!model.detail) model.state = "error"; return; }
      model.detail = r.body.incident;
      // the box keeps what the owner is typing until it is saved: a reload only refills it when nothing has been edited
      if (!model.draftDirty || model.draftFor !== id) { model.draftText = model.detail.review || r.body.reviewDraft || ""; model.draftFor = id; model.draftDirty = false; }
      model.tz = r.body.tz || TZ;
      model.state = "ok";
    });
  }

  function loadAll() {
    var p = loadList();
    if (model.view === "detail" && model.id) p = p.then(function () { return loadDetail(model.id); });
    return p.then(render);
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
  function btn(text, cls, fn) { var b = h("button", "btn btn-sm" + (cls ? " " + cls : ""), text); b.type = "button"; b.addEventListener("click", fn); return b; }

  function message(text, linkText, href) {
    var box = $("inc-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var box = $("inc-flash");
    if (!box) return;
    clear(box);
    if (!model.flash) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "inc-flash " + (tone || "");
    box.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") {
      var a = h("a", "btn btn-sm", "Sign in again");
      a.href = window.barnyardLoginUrl();
      box.appendChild(a);
    }
  }

  function field(label, control) {
    var l = h("label");
    l.appendChild(h("span", "dim", label));
    l.appendChild(control);
    return l;
  }

  function severitySelect(current, onChange) {
    var sel = h("select");
    sel.setAttribute("aria-label", "Severity");
    SEVERITIES.forEach(function (s) { var o = h("option", null, s + ": " + SEVERITY_ABOUT[s]); o.value = s; if (s === current) o.selected = true; sel.appendChild(o); });
    if (onChange) sel.addEventListener("change", function () { onChange(sel.value); });
    return sel;
  }

  function renderList(root) {
    var line = summaryLine(model.sum);
    var strip = h("div", "inc-strip " + line.tone);
    strip.appendChild(h("b", null, line.head));
    if (line.text) strip.appendChild(h("span", null, line.text));
    root.appendChild(strip);

    if (model.showForm) root.appendChild(openForm());

    var filter = h("div", "inc-filter");
    [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]].forEach(function (f) {
      var b = btn(f[1], "btn-quiet", function () { model.filter = f[0]; render(); });
      b.setAttribute("aria-pressed", model.filter === f[0] ? "true" : "false");
      filter.appendChild(b);
    });
    root.appendChild(filter);

    var rows = listRows(model.list, model.filter, Date.now());
    if (!rows.length) {
      root.appendChild(h("p", "dim", model.filter === "open" ? "Nothing is open. When Monitoring sees something down for two checks in a row, it opens an incident here by itself." : "Nothing to show here yet."));
      return;
    }
    var ul = h("ul", "inc-list");
    rows.forEach(function (r) {
      var li = h("li", "inc-row " + r.status + " " + r.severity.toLowerCase());
      var top = h("div", "inc-row-top");
      top.appendChild(h("span", "inc-name", r.name));
      var a = h("a", "inc-link", r.title); a.href = "#" + r.id;
      top.appendChild(a);
      top.appendChild(h("span", "chip " + r.tone, r.status === "open" ? r.severity : "Resolved"));
      li.appendChild(top);
      li.appendChild(h("p", "dim", r.line + " " + r.source + "." + (r.hasReview ? " Review saved." : "")));
      ul.appendChild(li);
    });
    root.appendChild(ul);
  }

  function openForm() {
    var form = h("form", "inc-form");
    var title = h("input"); title.type = "text"; title.maxLength = 100; title.required = true; title.placeholder = "What is wrong?";
    var sev = severitySelect("SEV3");
    var note = h("textarea"); note.maxLength = 1000; note.placeholder = "Anything the next person should know (optional)";
    form.appendChild(field("Title", title));
    form.appendChild(field("Severity", sev));
    form.appendChild(field("Note", note));
    var bar = h("div", "inc-row-actions");
    var go = h("button", "btn btn-sm btn-primary", "Open the incident"); go.type = "submit";
    bar.appendChild(go);
    bar.appendChild(btn("Cancel", "btn-quiet", function () { model.showForm = false; render(); }));
    form.appendChild(bar);
    form.addEventListener("submit", function (e) { e.preventDefault(); openIncident(openBody({ title: title.value, severity: sev.value, note: note.value })); });
    return form;
  }

  function section(title) {
    var s = h("section", "inc-section");
    s.appendChild(h("h3", null, title));
    return s;
  }

  function renderDetail(root) {
    var d = model.detail;
    var back = h("a", "inc-back", "All incidents"); back.href = "#";
    root.appendChild(back);
    if (!d) { root.appendChild(h("p", "dim", "Loading the incident…")); return; }
    var now = Date.now();

    var head = h("div", "inc-head");
    head.appendChild(h("span", "inc-name", d.name));
    head.appendChild(h("h2", null, d.title));
    var meta = h("div", "inc-meta");
    meta.appendChild(h("span", "chip " + (d.status === "open" ? severityTone(d.severity) : "ok"), d.status === "open" ? "Open" : "Resolved"));
    var sevBox = h("span", "inc-sev");
    sevBox.appendChild(severitySelect(d.severity, function (v) { changeSeverity(v); }));
    meta.appendChild(sevBox);
    meta.appendChild(h("span", "dim", incidentLine(d, now) + " " + (d.source === "auto" ? "Opened by Monitoring." : "Opened by hand.")));
    head.appendChild(meta);
    var acts = h("div", "inc-row-actions");
    acts.appendChild(d.status === "open" ? btn("Close the incident", "", function () { closeOrReopen("close"); }) : btn("Reopen", "", function () { closeOrReopen("reopen"); }));
    head.appendChild(acts);
    root.appendChild(head);

    // the timeline and a note
    var tl = section("Timeline");
    var ul = h("ul", "inc-time");
    timelineRows(d.timeline, model.tz).forEach(function (r) {
      var li = h("li");
      li.appendChild(h("time", null, r.when));
      var cell = h("span");
      cell.appendChild(h("span", "k", r.kind));
      cell.appendChild(document.createTextNode(r.text));
      li.appendChild(cell);
      ul.appendChild(li);
    });
    tl.appendChild(ul);
    var nf = h("form", "inc-note-form");
    var ni = h("input"); ni.type = "text"; ni.maxLength = 1000; ni.placeholder = "Add a note to the timeline"; ni.setAttribute("aria-label", "Note");
    var nb = h("button", "btn btn-sm", "Add note"); nb.type = "submit";
    nf.appendChild(ni); nf.appendChild(nb);
    nf.addEventListener("submit", function (e) { e.preventDefault(); if (ni.value.trim()) addNote(ni.value.trim()); });
    tl.appendChild(nf);
    root.appendChild(tl);

    // what changed (asked for when opened)
    root.appendChild(lazySection("What changed", "In the 24 hours before it started" + (d.status === "open" ? " and since" : " until it closed") + ": board changes, other monitors, new findings, renewals due.", "changes", renderChanges));
    // the checklist
    root.appendChild(lazySection("Checklist", "The best matching guides in the Knowledgebase, and the first steps of the top one to tick off.", "check", renderChecklist));
    // the review
    root.appendChild(reviewSection(d));
  }

  // A section that asks the Worker only when the owner opens it (and keeps what it got).
  function lazySection(title, about, key, paint) {
    var det = h("details", "inc-section");
    det.appendChild(h("summary", null, title));
    var body = h("div");
    body.appendChild(h("p", "dim", about));
    det.appendChild(body);
    function fill() {
      clear(body);
      body.appendChild(h("p", "dim", about));
      if (model[key] === "error") { body.appendChild(h("p", "dim", "Could not load this just now.")); body.appendChild(btn("Try again", "btn-quiet", function () { model[key] = null; ask(); })); return; }
      if (!model[key]) { body.appendChild(h("p", "dim", "Loading…")); return; }
      paint(body, model[key]);
    }
    function ask() {
      if (model[key] && model[key] !== "error") { fill(); return; }
      model[key] = null; fill();
      var path = (key === "changes" ? "/changes?id=" : "/checklist?id=") + encodeURIComponent(model.id);
      getJson(API + path, {}).then(function (r) { model[key] = r.status === 200 && r.body && r.body.ok ? r.body : "error"; fill(); });
    }
    if (model[key + "Open"]) det.open = true;
    det.addEventListener("toggle", function () { model[key + "Open"] = det.open; if (det.open) ask(); });
    if (det.open) ask(); else if (model[key] && model[key] !== "error") fill();
    return det;
  }

  function renderChanges(body, data) {
    var rows = changesRows(data, model.tz);
    if (rows.partial) body.appendChild(h("p", "dim", "Some sources could not be read, so this may be incomplete."));
    if (!rows.items.length && !rows.renewals.length) { body.appendChild(h("p", null, "Nothing changed that the hub knows about.")); return; }
    var ul = h("ul", "inc-changes");
    rows.items.forEach(function (r) {
      var li = h("li");
      li.appendChild(h("time", null, r.when));
      var cell = h("span");
      if (r.href) { var a = h("a", null, r.text); a.href = r.href; cell.appendChild(a); } else cell.appendChild(document.createTextNode(r.text));
      cell.appendChild(h("span", "dim", "  " + r.area));
      li.appendChild(cell);
      ul.appendChild(li);
    });
    body.appendChild(ul);
    if (rows.renewals.length) {
      body.appendChild(h("p", "dim", "Renewals due within a week:"));
      var rl = h("ul", "inc-changes");
      rows.renewals.forEach(function (r) {
        var li = h("li"); li.appendChild(h("span")); // keeps the two-column alignment
        var cell = h("span");
        if (r.href) { var a = h("a", null, r.text); a.href = r.href; cell.appendChild(a); } else cell.appendChild(document.createTextNode(r.text));
        li.appendChild(cell); rl.appendChild(li);
      });
      body.appendChild(rl);
    }
  }

  function renderChecklist(body, data) {
    var m = checklistModel(data, model.detail && model.detail.ticks);
    if (!m.guides.length) { body.appendChild(h("p", null, "No matching guide in the Knowledgebase yet. Writing one after this incident would help next time.")); return; }
    body.appendChild(h("p", "dim", "Guides"));
    var gl = h("ul", "inc-guides");
    m.guides.forEach(function (g) {
      var li = h("li");
      if (g.href) { var a = h("a", null, g.title); a.href = g.href; a.target = "_blank"; a.rel = "noopener noreferrer"; li.appendChild(a); } else li.appendChild(document.createTextNode(g.title));
      if (g.category) li.appendChild(h("span", "dim", "  " + g.category));
      gl.appendChild(li);
    });
    body.appendChild(gl);
    if (m.steps) {
      body.appendChild(h("p", "dim", "First steps of “" + m.steps.title + "” (" + m.tickedOf + " of " + m.steps.items.length + " done)"));
      var sl = h("ul", "inc-steps");
      m.steps.items.forEach(function (s) {
        var li = h("li"); var lab = h("label");
        var cb = h("input"); cb.type = "checkbox"; cb.checked = s.done;
        cb.addEventListener("change", function () { tick(s.key, cb.checked); });
        lab.appendChild(cb); lab.appendChild(h("span", null, s.text)); li.appendChild(lab); sl.appendChild(li);
      });
      body.appendChild(sl);
    }
  }

  function reviewSection(d) {
    var s = section("Post-incident review");
    s.className += " inc-review";
    s.appendChild(h("p", "dim", d.review
      ? "Your saved review. Edit it, save it here, and file it in the Knowledgebase as a draft when you are happy."
      : "A draft written from the timeline. Fill in the prompts (the underscored lines), save it here, and file it in the Knowledgebase as a draft when you are happy. It is about systems and steps, not people."));
    var ta = h("textarea"); ta.value = model.draftText; ta.setAttribute("aria-label", "Review text"); ta.spellcheck = true;
    ta.addEventListener("input", function () { model.draftText = ta.value; model.draftDirty = true; });
    s.appendChild(ta);
    var bar = h("div", "inc-row-actions");
    bar.appendChild(btn("Save the review", "btn-primary", function () { saveReview(); }));
    var kbb = btn(d.kbArticle ? "Update the Knowledgebase draft" : "Save to the Knowledgebase as a draft", "", function () { saveToKb(); });
    kbb.disabled = !d.hasReview; kbb.title = d.hasReview ? "" : "Save the review first";
    bar.appendChild(kbb);
    if (d.kbArticle) {
      var a = h("a", "btn btn-sm btn-quiet", "Open the draft"); a.href = "https://study.barnyard.site/knowledgebase.html#/a/" + d.kbArticle; a.target = "_blank"; a.rel = "noopener noreferrer";
      bar.appendChild(a);
    }
    s.appendChild(bar);
    s.appendChild(h("p", "dim", "The Knowledgebase copy is hidden: only you can read it until you show it there. Personal details (such as an email address) are not allowed in it."));
    return s;
  }

  function render() {
    var root = $("inc-root");
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see incidents.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error") { message("Couldn’t reach the Worker just now. It will try again shortly."); return; }
    // keep what the owner is typing: the page repaints only on a change, not on a poll that found nothing new
    clear(root);
    var box = h("div", "inc-flash");
    box.id = "inc-flash"; box.hidden = true; box.setAttribute("role", "status");
    root.appendChild(box);
    if (model.sum && model.sum.enabled === false) {
      root.appendChild(h("p", "inc-off", "The Incident Room is switched off. The Worker variable INCIDENTS_ENABLED is 0; remove it (or set it to 1) in Cloudflare to switch it back on."));
      return;
    }
    if (model.view === "detail") renderDetail(root); else renderList(root);
    if (model.flash) flash(model.flash.text, model.flash.tone);
    var st = $("inc-stamp");
    if (st) st.textContent = "Updated " + clockText(Date.now()).slice(-5);
  }

  // ---- 4. actions -----------------------------------------------------------

  function setBusy(on) { model.busy = on; ["inc-new", "inc-refresh"].forEach(function (id) { var b = $(id); if (b) b.disabled = on; }); }

  // Run a write, then reload what is showing. `okText` is the message on success.
  function write(path, body, okText, after) {
    if (model.busy) return;
    setBusy(true);
    send("POST", path, body).then(function (r) {
      setBusy(false);
      if (r.status === 200 || r.status === 201) {
        if (after) after(r.body);
        loadAll().then(function () { if (okText) flash(okText, "ok"); });
      } else flash(errorText(r.body, r.status), "alert");
    });
  }

  function openIncident(body) {
    if (!body.title) { flash(ERRORS.title_required, "alert"); return; }
    write("/open", body, "Incident opened.", function (b) { model.showForm = false; if (b && b.incident) { model.view = "detail"; model.id = b.incident.id; model.detail = null; model.changes = model.check = null; location.hash = b.incident.id; } });
  }
  function addNote(text) { write("/note", { id: model.id, text: text }, "Note added."); }
  function changeSeverity(sev) { write("/severity", { id: model.id, severity: sev }, "Severity is now " + sev + "."); }
  function closeOrReopen(what) { write("/" + what, { id: model.id }, what === "close" ? "Incident closed. A review draft is ready below." : "Incident reopened."); }
  function saveReview() { write("/review", { id: model.id, text: model.draftText }, "Review saved.", function () { model.draftDirty = false; }); }
  function saveToKb() {
    write("/review/kb", { id: model.id }, null, function (b) {
      flash(b && b.updated ? "The Knowledgebase draft was updated." : "Saved to the Knowledgebase as a hidden draft. Show it there when you are ready.", "ok");
    });
  }
  // A tick is quick and quiet: no reload, just keep the local list in step.
  function tick(key, done) {
    send("POST", "/tick", { id: model.id, key: key, done: done }).then(function (r) {
      if (r.status === 200 && r.body && Array.isArray(r.body.ticks) && model.detail) model.detail.ticks = r.body.ticks;
      else flash(errorText(r.body, r.status), "alert");
      render();
    });
  }

  function route() {
    var id = idFromHash(location.hash);
    if (id) { model.view = "detail"; if (model.id !== id) { model.id = id; model.detail = null; model.changes = model.check = null; model.changesOpen = model.checkOpen = false; } }
    else { model.view = "list"; model.id = ""; }
    render();
    if (model.state === "ok" || model.state === "loading") loadAll();
  }

  function boot() {
    var rf = $("inc-refresh"), nw = $("inc-new");
    if (rf) rf.addEventListener("click", function () { loadAll(); });
    if (nw) nw.addEventListener("click", function () { model.view = "list"; model.id = ""; model.showForm = true; if (location.hash) location.hash = ""; render(); });
    window.addEventListener("hashchange", route);
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      route();
      // a hidden tab asks for nothing, and a tab being typed in is not repainted under the owner's hands
      setInterval(function () {
        var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        if (!document.hidden && model.state === "ok" && !model.busy && !typing) loadAll();
      }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardIncidents = helpers;
})();
