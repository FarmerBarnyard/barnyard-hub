// The Services page (services.html): uptime against the targets the owner sets, the capacity forecast, the Worker's security
// event history, and what Microsoft says about the tenant. The owner's page, like Monitoring and Incidents.
//
// Reads and writes /services/* on the Worker (ClaudeRepo's cloudflare-worker/src/services-routes.js, owner only):
//   GET  /services/summary   /events?type=&q=&days=&page=   /m365[?refresh=1]
//   POST /services/settings  {targets?, m365?}
// and flips Monitoring's own alert switch (PUT /mon/settings {alerts:{security}}) for the "burst of refused requests" email.
// The page asks for the summary when it opens and once a minute while it is showing (never from a hidden tab, and not while
// something is being typed); the event list and Microsoft 365 are asked for only when opened or searched.
//
// Everything from the server reaches the page through textContent, never innerHTML (the CSP has no 'unsafe-inline' for scripts
// or styles). The chart is SVG built with setAttribute; sizes and colours come from classes and attributes, not style strings.
//
// Layout of this file: 1. pure helpers (exported for test/services.test.js; no DOM, no network)
//                      2. data   3. rendering   4. actions

(function () {
  "use strict";

  var API = "https://api.barnyard.site";
  var POLL_MS = 60000;
  var TZ = "Australia/Perth";

  // ---- 1. pure helpers ------------------------------------------------------

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

  // "Tue 27 Oct 14:42" in the owner's zone.
  function clockText(ms, tz) {
    try {
      var parts = new Intl.DateTimeFormat("en-AU", { timeZone: tz || TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
      return get("weekday") + " " + get("day") + " " + get("month") + " " + get("hour") + ":" + get("minute");
    } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  // "2026-10-28T09" (a UTC hour) -> "Wed 28 Oct 17:00" in the owner's zone.
  function hourText(hour, tz) {
    var t = Date.parse(String(hour) + ":00:00Z");
    return isFinite(t) ? clockText(t, tz) : String(hour);
  }

  function dateText(iso) {
    var t = Date.parse(String(iso) + "T00:00:00Z");
    if (!isFinite(t)) return String(iso);
    return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(t));
  }

  // 99.9500 -> "99.95%"; null -> "No data".
  function pctText(p) { return typeof p === "number" && isFinite(p) ? (Math.round(p * 1000) / 1000) + "%" : "No data"; }

  // The colour word for a window: met the target -> ok, missed -> alert, nothing yet -> "".
  function windowTone(w) { return !w || w.met === null || w.met === undefined ? "" : w.met ? "ok" : "alert"; }

  // "62% of the budget left", "Over budget by 44%", "" with no data.
  function budgetText(w) {
    if (!w || w.remainingPct === null || w.remainingPct === undefined) return "";
    if (w.remainingPct < 0) return "Over budget by " + Math.round(Math.abs(w.remainingPct)) + "%";
    return Math.round(w.remainingPct) + "% of the budget left";
  }

  // How fast the last week is using the budget: 1 is exactly the rate the target allows.
  function burnText(w) {
    if (!w || w.burn === null || w.burn === undefined) return "";
    if (w.burn === 0) return "No failed checks this week";
    if (w.burn <= 1) return "Using the budget at " + w.burn + "x the allowed rate: on track";
    return "Using the budget at " + w.burn + "x the allowed rate: faster than the target allows";
  }

  // The service levels as table rows: the groups first, then each monitor.
  function levelRows(levels) {
    var out = [];
    function add(l, kind) {
      out.push({ id: l.id, name: l.name, kind: kind, group: l.group, target: l.target, targetText: pctText(l.target) + (l.targetSource === "default" ? " (default)" : ""), w7: l.w7, w30: l.w30, w90: l.w90, tone: windowTone(l.w30), budget: budgetText(l.w30), burn: burnText(l.w7) });
    }
    ((levels && levels.groups) || []).forEach(function (l) { add(l, "group"); });
    ((levels && levels.monitors) || []).forEach(function (l) { add(l, "monitor"); });
    return out;
  }

  // The headline strip over the table: how many of the groups and services met their 30-day target.
  function headline(levels, coverageDays) {
    var mons = ((levels && levels.monitors) || []).filter(function (l) { return l.w30 && l.w30.met !== null && l.w30.met !== undefined; });
    if (!mons.length) return { tone: "", head: "No uptime history yet", text: "Monitoring has not made enough checks to say. Check back after a day or two." };
    var missed = mons.filter(function (l) { return l.w30.met === false; });
    var cover = coverageDays >= 90 ? "" : " Based on " + coverageDays + (coverageDays === 1 ? " day" : " days") + " of checks so far.";
    if (!missed.length) return { tone: "ok", head: "Every service is within its target", text: "Over the last 30 days." + cover };
    return { tone: "alert", head: (missed.length === 1 ? "1 service is below its target" : missed.length + " services are below their targets"), text: missed.map(function (l) { return l.name; }).join(", ") + ". Over the last 30 days." + cover };
  }

  // The capacity forecast in words, with a tone.
  function forecastText(f) {
    if (!f) return { tone: "", text: "" };
    switch (f.state) {
      case "not_enough_data": return { tone: "", text: f.have ? "Not enough data yet: " + f.have + " of " + f.need + " days of readings." : "No readings yet. The server's reporter has not sent any (Monitoring > Server reporters)." };
      case "flat": return { tone: "ok", text: "Not growing (" + (f.latest !== null && f.latest !== undefined ? Math.round(f.latest) + "% now" : "steady") + ")." };
      case "far": return { tone: "ok", text: "Growing slowly: more than two years from full." };
      case "over": return { tone: "alert", text: "Already at " + Math.round(f.latest) + "%, past the " + f.threshold + "% line." };
      case "grows": {
        var tone = f.daysLeft <= 14 ? "alert" : f.daysLeft <= 60 ? "attn" : "ok";
        var conf = f.confidence === "good" ? "" : f.confidence === "fair" ? " (a rough estimate)" : " (a very rough estimate: the readings are uneven)";
        return { tone: tone, text: "Fills in about " + f.daysLeft + (f.daysLeft === 1 ? " day" : " days") + ", around " + dateText(f.date) + conf + ". Now " + Math.round(f.latest) + "%, growing " + f.slopePerDay + " points a day." };
      }
      default: return { tone: "", text: "" };
    }
  }

  function capacityRows(cap) {
    return (Array.isArray(cap) ? cap : []).map(function (c) {
      var t = forecastText(c.forecast);
      return { server: c.name, label: c.label, now: c.forecast && c.forecast.latest !== null && c.forecast.latest !== undefined ? Math.round(c.forecast.latest) + "%" : "", tone: t.tone, text: t.text };
    });
  }

  // Which headline group a security event type belongs to in the chart.
  var CHART_GROUPS = [
    { id: "access", label: "Sign-ins and access", types: ["auth_fail", "not_owner", "token_denied", "access_refused", "strong_required", "session_revoked"] },
    { id: "limits", label: "Rate limits and plain HTTP", types: ["rate_limited", "http_rejected"] },
    { id: "secrets", label: "Blocked secrets", types: ["secret_blocked"] },
    { id: "system", label: "System and admin", types: ["admin", "integrity", "store_unreadable", "daily_limit", "monitor_down", "monitor_recovered", "vuln_p1"] }
  ];
  function groupOf(type) {
    for (var i = 0; i < CHART_GROUPS.length; i++) if (CHART_GROUPS[i].types.indexOf(type) !== -1) return CHART_GROUPS[i].id;
    return "system";
  }

  // The last `days` UTC days ending today, each with a count per group. rows: [{ day, type, n }].
  function chartModel(rows, now, days) {
    var n = days || 14, out = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(now - i * 86400000).toISOString().slice(0, 10);
      var o = { day: d, total: 0, access: 0, limits: 0, secrets: 0, system: 0 };
      out.push(o);
    }
    var byDay = {};
    out.forEach(function (o) { byDay[o.day] = o; });
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var o = byDay[r.day];
      if (!o || !(r.n > 0)) return;
      o[groupOf(r.type)] += r.n; o.total += r.n;
    });
    var max = out.reduce(function (m, o) { return Math.max(m, o.total); }, 0);
    return { days: out, max: max, groups: CHART_GROUPS };
  }

  // The week's counts per type, biggest first, as filter chips.
  function typeChips(week) { return (Array.isArray(week) ? week : []).map(function (w) { return { type: w.type, label: w.label, n: w.n }; }); }

  function eventRows(items, tz) {
    return (Array.isArray(items) ? items : []).map(function (e) {
      return { when: hourText(e.hour, tz), label: e.label, route: e.route, reason: e.reason, tag: e.tag, n: e.n };
    });
  }

  // The strip over the security events: this hour, the week, what was not stored.
  function securityLine(sec) {
    if (!sec) return { tone: "", text: "" };
    var week = (sec.week || []).reduce(function (s, w) { return s + w.n; }, 0);
    var bits = [week + (week === 1 ? " event" : " events") + " in the last 7 days", sec.thisHour + " refused in this hour"];
    if (sec.droppedToday > 0) bits.push(sec.droppedToday + " not stored today (a flood: the daily limit on stored rows was reached)");
    return { tone: sec.droppedToday > 0 ? "attn" : "", text: bits.join(". ") + "." };
  }

  // Microsoft 365: what to show for each state the Worker can answer with.
  function m365Model(r, sumSources) {
    var st = r && r.state ? r.state : (sumSources && sumSources.m365 && !sumSources.m365.on ? "off" : "loading");
    if (st === "off") return { state: "off", head: "Microsoft 365 service health is off", text: "Switch it on to see current Microsoft incidents and announced changes for your tenant. It only reads, and needs two read-only permissions (the steps come next).", steps: (sumSources && sumSources.m365 && sumSources.m365.steps) || [] };
    if (st === "not_set_up") return { state: st, head: "Not set up yet", text: (r.problems && r.problems.length ? "These Worker settings are missing or wrong: " + r.problems.join(", ") + ". They are the three the Users list uses." : "The read-only Graph app is not set up."), steps: r.steps || [] };
    if (st === "needs_permission") return { state: st, head: "Microsoft needs two more permissions on the app", text: "The app can read your Users list but not the service health yet" + (r.detail ? " (Microsoft says " + r.detail + ")" : "") + ".", steps: r.steps || [] };
    if (st === "error") return { state: st, head: "Could not read Microsoft 365", text: errorReason(r.reason, r.detail), steps: [] };
    if (st === "ok") return { state: st, head: r.openIssues ? r.openIssues + (r.openIssues === 1 ? " open Microsoft issue" : " open Microsoft issues") : "No open Microsoft issues", text: r.actionSoon ? r.actionSoon + (r.actionSoon === 1 ? " announced change needs action within 14 days." : " announced changes need action within 14 days.") : "Nothing announced needs action in the next 14 days.", steps: [] };
    return { state: "loading", head: "Loading", text: "", steps: [] };
  }
  function errorReason(reason, detail) {
    var words = { auth: "Microsoft refused the app's sign-in. The Graph secret may have expired or be wrong", throttled: "Microsoft asked us to slow down. Try again in a minute", unavailable: "Microsoft did not answer", bad_request: "Microsoft did not accept the request", not_found: "Microsoft did not find it" };
    return (words[reason] || "Something went wrong") + (detail ? " (" + detail + ")." : ".");
  }

  function issueRows(issues, tz) {
    return (Array.isArray(issues) ? issues : []).map(function (i) {
      return { title: i.title, service: i.service, status: i.resolved ? "Resolved" : (i.status || "Open").replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }), tone: i.resolved ? "ok" : i.classification === "advisory" ? "attn" : "alert", when: i.modified ? clockText(i.modified, tz) : "" };
    });
  }
  function messageRows(messages, now, tz) {
    return (Array.isArray(messages) ? messages : []).map(function (m) {
      var due = m.actionBy ? Math.ceil((m.actionBy - now) / 86400000) : null;
      var action = due === null ? "" : due < 0 ? "Action date passed" : due === 0 ? "Action needed today" : "Action needed in " + due + (due === 1 ? " day" : " days");
      return { title: m.title, services: (m.services || []).join(", "), tone: due !== null && due >= 0 && due <= 14 ? "attn" : m.severity === "critical" || m.severity === "high" ? "attn" : "", action: action, major: !!m.major };
    });
  }

  // The targets form: one percent per group or service; a blank means "use the default". Only what changed is sent.
  // fields: { id: "99.9" | "" }; current: the Worker's targets object. -> { ok, body } | { ok: false, error }
  function targetsBody(fields, current) {
    var cur = current || {}, out = {}, changed = 0;
    for (var id in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, id)) continue;
      var raw = String(fields[id] == null ? "" : fields[id]).trim().replace(/%$/, "");
      if (raw === "") { if (cur[id] !== undefined) { out[id] = null; changed++; } continue; }
      var v = Number(raw);
      if (!isFinite(v) || v < 90 || v > 99.999) return { ok: false, error: "Targets are between 90 and 99.999 percent (" + id + ")." };
      v = Math.round(v * 1000) / 1000;
      if (cur[id] !== v) { out[id] = v; changed++; }
    }
    return changed ? { ok: true, body: { targets: out } } : { ok: false, error: "Nothing changed." };
  }

  var ERRORS = {
    recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then repeat it.",
    unauthenticated: "You are not signed in.",
    forbidden: "This is only for the hub owner.",
    services_disabled: "The Services tab is switched off (the Worker variable SERVICES_ENABLED is 0, or Monitoring is off).",
    target_invalid: "Targets are between 90 and 99.999 percent.",
    target_unknown: "That service is not one Monitoring checks.",
    rate_limited: "Slow down a little: try again in half a minute.",
    type_invalid: "That is not a kind of event.",
    query_invalid: "Search for a word in a path or a reason: letters, numbers and / _ . : - only, 40 characters at most.",
    days_invalid: "Choose between 1 and 30 days.",
    request_failed: "Could not reach the Worker. Check your connection and try again."
  };
  function errorText(body, status) {
    var code = body && typeof body.error === "string" ? body.error : "";
    if (ERRORS[code]) return ERRORS[code];
    if (status === 0) return ERRORS.request_failed;
    if (status === 401) return ERRORS.unauthenticated;
    if (status === 403) return ERRORS.forbidden;
    return "That did not work (" + (code || "error " + status) + ").";
  }

  // The search box -> the query string the Worker takes (empty parts left out).
  function eventsQuery(ev) {
    var q = [];
    if (ev.type) q.push("type=" + encodeURIComponent(ev.type));
    if (ev.q) q.push("q=" + encodeURIComponent(ev.q));
    q.push("days=" + (ev.days || 7));
    q.push("page=" + (ev.page || 1));
    return "?" + q.join("&");
  }

  var helpers = {
    agoText: agoText, clockText: clockText, hourText: hourText, dateText: dateText, pctText: pctText, windowTone: windowTone, budgetText: budgetText,
    burnText: burnText, levelRows: levelRows, headline: headline, forecastText: forecastText, capacityRows: capacityRows, chartModel: chartModel, groupOf: groupOf,
    typeChips: typeChips, eventRows: eventRows, securityLine: securityLine, m365Model: m365Model, issueRows: issueRows, messageRows: messageRows,
    targetsBody: targetsBody, errorText: errorText, eventsQuery: eventsQuery, CHART_GROUPS: CHART_GROUPS, ERRORS: ERRORS
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", sum: null, ev: { type: "", q: "", days: 7, page: 1, data: null, busy: false, open: false }, m365: null, flash: null, busy: false, editTargets: false };

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

  function send(method, base, path, body) {
    var init = { method: method };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return getJson(API + base + path, init);
  }

  function failState(r) {
    if (r.status === 401) { model.state = "guest"; return true; }
    if (r.status === 403 && r.body && r.body.error === "forbidden") { model.state = "forbidden"; return true; }
    return false;
  }

  function loadSummary() {
    return send("GET", "/services", "/summary").then(function (r) {
      if (failState(r)) return;
      if (r.status === 0 || r.status >= 500 || !r.body) { model.state = model.sum ? "ok" : "error"; return; }
      if (r.body.enabled === false || (r.status === 403 && r.body.error === "services_disabled")) { model.state = "off"; return; }
      model.sum = r.body; model.state = "ok";
    });
  }

  function loadEvents() {
    model.ev.busy = true;
    return send("GET", "/services", "/events" + eventsQuery(model.ev)).then(function (r) {
      model.ev.busy = false;
      if (r.status === 200 && r.body) model.ev.data = r.body; else flash(errorText(r.body, r.status), "alert");
    });
  }

  function loadM365(refresh) {
    return send("GET", "/services", "/m365" + (refresh ? "?refresh=1" : "")).then(function (r) {
      if (r.status === 200 && r.body) model.m365 = r.body;
      else if (r.status === 429) flash(ERRORS.rate_limited, "alert");
      else if (r.status !== 403 || !r.body || r.body.error !== "services_disabled") flash(errorText(r.body, r.status), "alert");
    });
  }

  function loadAll() {
    return loadSummary().then(function () {
      var more = [];
      if (model.state === "ok" && model.sum && model.sum.m365 && !model.m365) more.push(loadM365(false));
      if (model.state === "ok" && model.ev.open) more.push(loadEvents());
      return Promise.all(more);
    }).then(render);
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
  function svg(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }

  function message(text) {
    var box = $("svc-root");
    clear(box);
    box.appendChild(h("p", "svc-off", text));
  }

  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var box = $("svc-flash");
    if (!box) return;
    clear(box);
    if (!model.flash) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "svc-flash " + (tone || "");
    box.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") {
      var a = h("a", "btn btn-sm", "Sign in again");
      a.href = window.barnyardLoginUrl();
      box.appendChild(a);
    }
  }

  function section(title, lead) {
    var s = h("section", "svc-section");
    s.appendChild(h("h2", null, title));
    if (lead) s.appendChild(h("p", "dim", lead));
    return s;
  }

  function strip(tone, head, text) {
    var s = h("div", "svc-strip " + (tone || ""));
    s.appendChild(h("b", null, head));
    if (text) s.appendChild(h("span", null, text));
    return s;
  }

  function winCell(w) {
    var td = h("td", "num");
    if (!w || w.pct === null || w.pct === undefined) { td.appendChild(h("span", "dim", "No data")); return td; }
    td.appendChild(h("span", "svc-pct " + windowTone(w), pctText(w.pct)));
    return td;
  }

  function renderLevels(root) {
    var s = model.sum;
    var sec = section("Service levels", "The share of Monitoring's outside checks that did not fail, against the target you set. The error budget is how many failed checks the target allows.");
    var line = headline(s.levels, s.coverageDays);
    sec.appendChild(strip(line.tone, line.head, line.text));
    var wrap = h("div", "svc-scroll");
    var tbl = h("table", "svc-table");
    var thead = h("thead"), hr = h("tr");
    ["Service", "Target", "7 days", "30 days", "90 days", "Budget (30 days)"].forEach(function (t, i) { hr.appendChild(h("th", i > 0 && i < 5 ? "num" : null, t)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = h("tbody");
    levelRows(s.levels).forEach(function (r) {
      var tr = h("tr", r.kind === "group" ? "group" : "");
      var name = h("th", null, r.name); name.scope = "row"; tr.appendChild(name);
      tr.appendChild(h("td", "num dim", r.targetText));
      tr.appendChild(winCell(r.w7)); tr.appendChild(winCell(r.w30)); tr.appendChild(winCell(r.w90));
      var b = h("td");
      if (r.budget) { b.appendChild(chip(r.budget, r.tone)); if (r.burn) b.appendChild(h("div", "dim small", r.burn)); } else b.appendChild(h("span", "dim", "No data"));
      tr.appendChild(b);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); sec.appendChild(wrap);
    var row = h("div", "svc-actions");
    row.appendChild(btn(model.editTargets ? "Close targets" : "Set targets", "btn-quiet", function () { model.editTargets = !model.editTargets; render(); }));
    sec.appendChild(row);
    if (model.editTargets) sec.appendChild(targetsForm());
    root.appendChild(sec);
  }

  function targetsForm() {
    var s = model.sum;
    var form = h("form", "svc-form");
    form.appendChild(h("p", "dim", "A percent between 90 and 99.999 for each group or service. Leave a box empty to use the default (sites 99.5, servers 99). A service's own target beats its group's."));
    var inputs = {};
    var ids = [];
    s.levels.groups.forEach(function (l) { ids.push([l.id, l.name + " (all)"]); });
    s.levels.monitors.forEach(function (l) { ids.push([l.id, l.name]); });
    ids.forEach(function (p) {
      var label = h("label"); label.appendChild(h("span", "dim", p[1]));
      var inp = h("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.maxLength = 8; inp.placeholder = "default"; inp.setAttribute("aria-label", "Target for " + p[1]);
      if (s.targets && s.targets[p[0]] !== undefined) inp.value = String(s.targets[p[0]]);
      inputs[p[0]] = inp; label.appendChild(inp); form.appendChild(label);
    });
    var save = h("button", "btn btn-sm", "Save targets"); save.type = "submit";
    form.appendChild(save);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fields = {};
      for (var id in inputs) fields[id] = inputs[id].value;
      var b = targetsBody(fields, s.targets);
      if (!b.ok) { flash(b.error, b.error === "Nothing changed." ? "" : "alert"); return; }
      write("/services", "/settings", b.body, "Targets saved.", function () { model.editTargets = false; });
    });
    return form;
  }

  function renderCapacity(root) {
    var sec = section("Capacity", "When each server's disks and memory will reach 95%, from the readings its reporter sends. A straight line through the last 30 days, so it needs at least 7.");
    var rows = capacityRows(model.sum.capacity);
    var wrap = h("div", "svc-scroll");
    var tbl = h("table", "svc-table");
    var hr = h("tr");
    ["Server", "Reading", "Now", "Forecast"].forEach(function (t, i) { hr.appendChild(h("th", i === 2 ? "num" : null, t)); });
    var thead = h("thead"); thead.appendChild(hr); tbl.appendChild(thead);
    var tb = h("tbody");
    rows.forEach(function (r) {
      var tr = h("tr");
      var n = h("th", null, r.server); n.scope = "row"; tr.appendChild(n);
      tr.appendChild(h("td", null, r.label));
      tr.appendChild(h("td", "num", r.now));
      var f = h("td"); f.appendChild(h("span", "svc-fc " + r.tone, r.text)); tr.appendChild(f);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); sec.appendChild(wrap);
    root.appendChild(sec);
  }

  function renderChart(sec) {
    var c = chartModel(model.sum.security.chart, model.sum.now || Date.now(), 14);
    var W = 560, H = 120, pad = 22, bw = (W - pad) / c.days.length;
    var box = svg("svg", { viewBox: "0 0 " + W + " " + (H + 24), role: "img", "aria-label": "Security events per day, last 14 days", class: "svc-chart" });
    var max = Math.max(c.max, 1);
    for (var g = 0; g <= 2; g++) {
      var y = H - (H * g / 2);
      box.appendChild(svg("line", { x1: pad, x2: W, y1: y, y2: y, class: "grid" }));
      var lab = svg("text", { x: 0, y: y + 4, class: "axis" }); lab.textContent = String(Math.round(max * g / 2)); box.appendChild(lab);
    }
    c.days.forEach(function (d, i) {
      var x = pad + i * bw + 3, w = Math.max(4, bw - 6), top = H;
      c.groups.forEach(function (gr) {
        var v = d[gr.id]; if (!v) return;
        var ht = H * v / max; top -= ht;
        var r = svg("rect", { x: x, y: top, width: w, height: ht, class: "bar " + gr.id });
        var t = svg("title", {}); t.textContent = d.day + ": " + v + " " + gr.label.toLowerCase(); r.appendChild(t);
        box.appendChild(r);
      });
      if (i % 2 === 1 || c.days.length < 8) { var tx = svg("text", { x: x + w / 2, y: H + 16, class: "axis mid" }); tx.textContent = d.day.slice(8); box.appendChild(tx); }
    });
    sec.appendChild(box);
    var key = h("ul", "svc-key");
    c.groups.forEach(function (gr) { var li = h("li"); li.appendChild(h("span", "swatch " + gr.id)); li.appendChild(h("span", null, gr.label)); key.appendChild(li); });
    sec.appendChild(key);
  }

  function renderSecurity(root) {
    var s = model.sum.security;
    var sec = section("Security events", "What the Worker refused or failed, kept 30 days (Workers Logs keeps three). Only the kind, the path, a reason and a network tag: never an address, a person or what was sent.");
    var line = securityLine(s);
    sec.appendChild(strip(line.tone, line.text || "No events yet", ""));
    renderChart(sec);
    var chips = h("div", "svc-chips");
    typeChips(s.week).forEach(function (c) {
      var b = btn(c.label + " " + c.n, "btn-quiet", function () { model.ev.type = model.ev.type === c.type ? "" : c.type; model.ev.page = 1; model.ev.open = true; loadEvents().then(render); });
      b.setAttribute("aria-pressed", model.ev.type === c.type ? "true" : "false");
      chips.appendChild(b);
    });
    if (!s.week.length) chips.appendChild(h("span", "dim", "Nothing in the last 7 days."));
    sec.appendChild(chips);

    var alertRow = h("label", "svc-check");
    var cb = h("input"); cb.type = "checkbox"; cb.checked = !!s.alertOn;
    cb.addEventListener("change", function () { setSpikeSwitch(cb.checked); });
    alertRow.appendChild(cb);
    alertRow.appendChild(h("span", null, "Email me when requests are being refused in a burst (20 or more in an hour and five times the usual)."));
    sec.appendChild(alertRow);

    var form = h("form", "svc-search");
    var q = h("input"); q.type = "text"; q.maxLength = 40; q.placeholder = "Search a path or reason, for example /auth"; q.value = model.ev.q; q.setAttribute("aria-label", "Search events");
    var days = h("select"); days.setAttribute("aria-label", "How far back");
    [[1, "Last day"], [7, "Last 7 days"], [30, "Last 30 days"]].forEach(function (d) { var o = h("option", null, d[1]); o.value = String(d[0]); if (d[0] === model.ev.days) o.selected = true; days.appendChild(o); });
    var go = h("button", "btn btn-sm", "Search"); go.type = "submit";
    form.appendChild(q); form.appendChild(days); form.appendChild(go);
    form.addEventListener("submit", function (e) { e.preventDefault(); model.ev.q = q.value.trim(); model.ev.days = Number(days.value); model.ev.page = 1; model.ev.open = true; loadEvents().then(render); });
    sec.appendChild(form);

    if (!model.ev.open) {
      sec.appendChild(btn("Show the events", "btn-quiet", function () { model.ev.open = true; loadEvents().then(render); }));
    } else if (model.ev.data) {
      var d = model.ev.data;
      var rows = eventRows(d.items);
      sec.appendChild(h("p", "dim", d.total + (d.total === 1 ? " event" : " events") + (model.ev.type ? " of one kind" : "") + (model.ev.q ? " matching " + model.ev.q : "") + ", " + d.rows + (d.rows === 1 ? " line" : " lines") + "."));
      if (rows.length) {
        var wrap = h("div", "svc-scroll"), tbl = h("table", "svc-table");
        var hr = h("tr");
        ["Hour", "Kind", "Path", "Reason", "Network", "Count"].forEach(function (t, i) { hr.appendChild(h("th", i === 5 ? "num" : null, t)); });
        var thead = h("thead"); thead.appendChild(hr); tbl.appendChild(thead);
        var tb = h("tbody");
        rows.forEach(function (r) {
          var tr = h("tr");
          [r.when, r.label, r.route, r.reason, r.tag].forEach(function (v, i) { tr.appendChild(h("td", i === 2 ? "mono" : null, v || "")); });
          tr.appendChild(h("td", "num", String(r.n)));
          tb.appendChild(tr);
        });
        tbl.appendChild(tb); wrap.appendChild(tbl); sec.appendChild(wrap);
        var pager = h("div", "svc-actions");
        if (d.page > 1) pager.appendChild(btn("Newer", "btn-quiet", function () { model.ev.page--; loadEvents().then(render); }));
        if (d.page * d.per < d.rows) pager.appendChild(btn("Older", "btn-quiet", function () { model.ev.page++; loadEvents().then(render); }));
        if (pager.childNodes.length) sec.appendChild(pager);
      }
    } else sec.appendChild(h("p", "dim", "Loading the events…"));
    root.appendChild(sec);
  }

  function renderM365(root) {
    var sec = section("Microsoft 365", "Current Microsoft incidents and announced changes for your tenant. Read only.");
    var m = m365Model(model.m365, model.sum.sources);
    var tone = m.state === "ok" ? (model.m365.openIssues ? "alert" : "ok") : m.state === "error" ? "alert" : "";
    sec.appendChild(strip(tone, m.head, m.text));
    if (m.steps && m.steps.length) {
      var ol = h("ol", "svc-steps");
      m.steps.forEach(function (t) { ol.appendChild(h("li", null, t)); });
      sec.appendChild(ol);
    }
    var row = h("div", "svc-actions");
    if (m.state === "off") row.appendChild(btn("Switch it on", null, function () { write("/services", "/settings", { m365: true }, "Microsoft 365 service health is on.", function () { model.m365 = null; }); }));
    else {
      row.appendChild(btn("Check again", "btn-quiet", function () { loadM365(true).then(render); }));
      row.appendChild(btn("Switch it off", "btn-quiet", function () { write("/services", "/settings", { m365: false }, "Microsoft 365 service health is off.", function () { model.m365 = null; }); }));
    }
    sec.appendChild(row);
    if (m.state === "ok") {
      var iss = issueRows(model.m365.issues, TZ);
      if (iss.length) {
        sec.appendChild(h("h3", null, "Service issues"));
        var ul = h("ul", "svc-list");
        iss.forEach(function (i) { var li = h("li"); li.appendChild(chip(i.status, i.tone)); li.appendChild(h("b", null, " " + i.service)); li.appendChild(h("span", null, ": " + i.title)); if (i.when) li.appendChild(h("span", "dim", " (" + i.when + ")")); ul.appendChild(li); });
        sec.appendChild(ul);
      }
      var msgs = messageRows(model.m365.messages, Date.now(), TZ);
      if (msgs.length) {
        sec.appendChild(h("h3", null, "Announced changes"));
        var ul2 = h("ul", "svc-list");
        msgs.forEach(function (i) { var li = h("li"); if (i.action) li.appendChild(chip(i.action, i.tone)); li.appendChild(h("span", null, (i.action ? " " : "") + i.title)); if (i.services) li.appendChild(h("span", "dim", " (" + i.services + ")")); ul2.appendChild(li); });
        sec.appendChild(ul2);
      }
    }
    root.appendChild(sec);
  }

  function renderCode(root) {
    var c = model.sum.sources && model.sum.sources.code;
    var sec = section("Code and dependency health", "Test results, open pull requests, Dependabot alerts and outdated packages per repository.");
    sec.appendChild(strip("", "Not set up yet", "This needs a read-only GitHub token, which is not built yet."));
    if (c && c.steps && c.steps.length) { var ul = h("ul", "svc-list"); c.steps.forEach(function (t) { ul.appendChild(h("li", null, t)); }); sec.appendChild(ul); }
    root.appendChild(sec);
  }

  function render() {
    var root = $("svc-root");
    if (!root) return;
    if (model.state === "guest") { message("Sign in to see the Services page."); return; }
    if (model.state === "forbidden") { message("The Services page is only for the hub owner."); return; }
    if (model.state === "off") { message("The Services tab is switched off. The Worker variable SERVICES_ENABLED is 0, or Monitoring is switched off."); return; }
    if (model.state === "error") { message("Could not reach the Worker. Press Refresh to try again."); return; }
    if (model.state === "loading" || !model.sum) return;
    clear(root);
    renderLevels(root); renderCapacity(root); renderSecurity(root); renderM365(root); renderCode(root);
    if (model.flash) flash(model.flash.text, model.flash.tone);
    var st = $("svc-stamp");
    if (st) st.textContent = "Updated " + clockText(Date.now()).slice(-5);
  }

  // ---- 4. actions -----------------------------------------------------------

  function setBusy(on) { model.busy = on; var b = $("svc-refresh"); if (b) b.disabled = on; }

  function write(base, path, body, okText, after) {
    if (model.busy) return;
    setBusy(true);
    send("POST", base, path, body).then(function (r) {
      setBusy(false);
      if (r.status === 200) {
        if (after) after(r.body);
        loadAll().then(function () { if (okText) flash(okText, "ok"); });
      } else flash(errorText(r.body, r.status), "alert");
    });
  }

  function setSpikeSwitch(on) {
    if (model.busy) return;
    setBusy(true);
    send("PUT", "/mon", "/settings", { alerts: { security: !!on } }).then(function (r) {
      setBusy(false);
      if (r.status === 200) loadAll().then(function () { flash(on ? "You will be emailed about bursts of refused requests." : "That email is off.", "ok"); });
      else { flash(errorText(r.body, r.status), "alert"); render(); }
    });
  }

  function boot() {
    var rf = $("svc-refresh");
    if (rf) rf.addEventListener("click", function () { loadAll(); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      loadAll();
      // a hidden tab asks for nothing, and a tab being typed in is not repainted under the owner's hands
      setInterval(function () {
        var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        if (!document.hidden && model.state === "ok" && !model.busy && !typing && !model.editTargets) loadAll();
      }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardServices = helpers;
})();
