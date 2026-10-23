// The Vulnerabilities page (vulnerabilities.html): a record of the known security holes (CVEs) that apply to what a
// person runs, a remediation plan on each, and an Approve button that puts the plan on their Ops board for Claude.
//
// Talks to /vuln/* on the Worker (ClaudeRepo's cloudflare-worker/src/vuln-routes.js). Everyone signed in to the hub has
// their own register; nobody sees anyone else's. Nothing from the server reaches the page except through textContent
// (as text, never as markup), and a link from a CVE record is only drawn when it is a plain http(s) address. The page's CSP
// has no 'unsafe-inline' for scripts or styles.
//
// Layout of this file: 1. pure helpers (exported for test/vuln.test.js; no DOM, no network)
//                      2. transport   3. UI

(function () {
  "use strict";

  var API = "https://api.barnyard.site/vuln";

  // ---- 1. pure helpers ------------------------------------------------------

  var STATE_TEXT = { "new": "New", affects: "Affects me", not_affected: "Not affected", accepted: "Accepted risk", approved: "Approved", fixed: "Fixed" };
  var STATE_TONE = { "new": "info", affects: "accent", not_affected: "", accepted: "", approved: "ok", fixed: "ok" };
  var PRIORITY_HINT = { P1: "Fix first", P2: "Fix soon", P3: "Plan it", P4: "Low" };
  var PERSON_STATES = ["new", "affects", "not_affected", "accepted", "fixed"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function stateText(s) { return STATE_TEXT[s] || String(s || ""); }
  function stateTone(s) { return STATE_TONE[s] || ""; }
  function priorityTone(p) { return p === "P1" ? "alert" : p === "P2" ? "accent" : p === "P3" ? "info" : ""; }
  function priorityHint(p) { return PRIORITY_HINT[p] || ""; }

  function toDate(v) {
    if (v === null || v === undefined || v === "") return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  // "22 Oct 2026" (UTC, so the same everywhere), or "" when there is no usable date.
  function fmtDate(v) {
    var d = toDate(v);
    return d ? d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() : "";
  }
  function monthLabel(key) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(key || ""));
    return m ? MONTHS[Number(m[2]) - 1] + " " + m[1] : String(key || "");
  }
  function agoText(ts, now) {
    var d = toDate(ts);
    if (!d) return "";
    var m = Math.round((now - d.getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }
  function thousands(n) { return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // "9.8 Critical", or a plain note while the score has not been published yet.
  function scoreText(cve) {
    if (!cve || cve.score === null || cve.score === undefined) return "No score yet";
    var sev = cve.severity ? " " + String(cve.severity).charAt(0).toUpperCase() + String(cve.severity).slice(1).toLowerCase() : "";
    return Number(cve.score).toFixed(1) + sev;
  }
  function scoreTone(cve) {
    var s = cve && cve.score;
    if (s === null || s === undefined) return "";
    return s >= 9 ? "alert" : s >= 7 ? "accent" : s >= 4 ? "info" : "";
  }
  function epssText(e) {
    if (e === null || e === undefined) return "";
    var pct = Number(e) * 100;
    return "EPSS " + (pct > 0 && pct < 1 ? "<1" : String(Math.round(pct))) + "%";
  }
  function confidenceText(c) { return c === "confirmed" ? "Your version is affected" : "Might apply, worth checking"; }

  // Only a plain http(s) address is ever turned into a link.
  function safeUrl(u) {
    u = typeof u === "string" ? u : u && typeof u.url === "string" ? u.url : "";
    return /^https?:\/\/[^\s<>"']{1,300}$/i.test(u) ? u : "";
  }

  // A finding keeps the item's name and version as they were when it was found; the name usually holds the version already.
  function itemLabel(name, version) {
    name = String(name || "");
    return version && name.indexOf(version) === -1 ? (name ? name + " " : "") + version : name;
  }
  function softwareLabel(item) {
    if (!item) return "";
    var p = item.product || item.name || "";
    return item.version ? p + " " + item.version : p;
  }
  // The name the Worker gives a software item when none is typed; used to tell whether a name was ever edited by hand.
  function autoName(product, version) { return (String(product || "") + (version ? " " + version : "")).slice(0, 80); }

  // The words in front of the version in a name like "PHP 8.3.30" ("PHP"), or null when the name does not end with it.
  function nameBase(name, version) {
    name = String(name || ""); version = String(version || "");
    if (!version || name.length <= version.length + 1) return null;
    return name.slice(-(version.length + 1)) === " " + version ? name.slice(0, -(version.length + 1)) : null;
  }

  function matchText(item, now) {
    if (!item || item.kind !== "software") return "";
    var s = item.matchState || "";
    if (s === "ok") return "Checked " + (agoText(item.matchedAt, now) || "recently");
    if (s === "partial") return "Partly checked " + (agoText(item.matchedAt, now) || "recently");
    if (/^error/.test(s)) return "Could not check just now";
    return "Waiting to be checked";
  }

  // Hosts with the software that sits on them, and software that is not tied to a host.
  function itemTree(items) {
    var hosts = [], byId = {}, loose = [];
    (items || []).forEach(function (i) { if (i.kind === "infra") { var h = { host: i, software: [] }; hosts.push(h); byId[i.id] = h; } });
    (items || []).forEach(function (i) {
      if (i.kind !== "software") return;
      if (i.parentId && byId[i.parentId]) byId[i.parentId].software.push(i); else loose.push(i);
    });
    return { hosts: hosts, loose: loose };
  }

  function queryString(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === "" || v === null || v === undefined || v === false) return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v === true ? "1" : v));
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  function pageCount(total, per) { return Math.max(1, Math.ceil((Number(total) || 0) / (Number(per) || 25))); }
  function barPercent(n, max) { return n > 0 && max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0; }

  function planBadge(f) {
    var p = (f && f.plan) || {};
    if (f && (f.planStatus === "approved" || p.status === "approved")) return { text: "Approved and locked", tone: "ok" };
    if (p.by === "claude") return { text: "Refined by Claude", tone: "info" };
    if (p.by === "you") return { text: "Edited by you", tone: "" };
    return { text: "Draft, written from a template", tone: "" };
  }
  function canEditPlan(f) { return !!f && f.planStatus !== "approved" && f.state !== "approved"; }
  function canApprove(f) {
    return !!f && !f.opsItem && f.state !== "approved" && f.state !== "fixed" && !!(f.plan && f.plan.steps && f.plan.steps.length);
  }

  // A copy of a plan the person can edit, and the body to send back (empty steps dropped, everything trimmed).
  function planDraft(plan) {
    plan = plan || {};
    return {
      summary: plan.summary || "", downtime: plan.downtime || "", effort: plan.effort || "", verify: plan.verify || "", rollback: plan.rollback || "",
      steps: (plan.steps || []).map(function (s) { return { text: s.text || "", who: s.who === "claude" ? "claude" : "you", done: !!s.done }; })
    };
  }
  function planPayload(d) {
    var steps = (d.steps || []).map(function (s) { return { text: String(s.text || "").trim(), who: s.who === "claude" ? "claude" : "you", done: !!s.done }; })
      .filter(function (s) { return s.text; });
    return {
      summary: String(d.summary || "").trim(), steps: steps, downtime: String(d.downtime || "").trim(), effort: String(d.effort || "").trim(),
      verify: String(d.verify || "").trim(), rollback: String(d.rollback || "").trim()
    };
  }

  var EVENT_TEXT = { matched: "Found", reopened: "Came back", fixed: "Fixed", state: "Status changed", plan: "Plan changed", approved: "Approved", priority: "Priority changed", confidence: "Match changed" };
  function eventTitle(e) { return EVENT_TEXT[e && e.kind] || String((e && e.kind) || "").replace(/_/g, " "); }
  var ACTOR_TEXT = { you: "You", claude: "Claude", system: "Automatic check" };
  function actorText(a) { return ACTOR_TEXT[a] || ""; }

  var SECRET_KIND = {
    private_key: "a private key", agent_key: "an agent key", bearer_token: "an access token", aws_key: "a cloud key",
    github_token: "a GitHub token", slack_token: "a Slack token", google_key: "a Google key", stripe_key: "a payment key",
    api_key: "an API key", jwt: "a login token", url_password: "a password in a web address", credential: "a password or key"
  };
  var CODE_TEXT = {
    recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then try again.",
    rate_limited: "That is too many changes too quickly. Wait a minute and try again.",
    catalog_unreachable: "The CVE catalog can't be reached right now. Everything you have is safe; try again later.",
    catalog_not_configured: "The CVE catalog isn't set up yet, so nothing can be checked.",
    catalog_error: "The CVE catalog gave an answer that couldn't be used. Try again later.",
    plan_locked: "This plan is approved and locked. Changes now go through the Ops board item.",
    approved_use_item: "This was approved, so its progress is tracked on the Ops board item.",
    finding_fixed: "This is already fixed, so there is nothing to approve.",
    approval_in_progress: "An approval is already being made for this. Give it a moment.",
    plan_empty: "Add at least one step to the plan before approving it.",
    environment_full: "Your register is full. Remove something you no longer run first.",
    infra_full: "You have reached the limit of servers. Remove one you no longer run first.",
    software_full: "You have reached the limit of software items. Remove one you no longer run first.",
    reason_required: "Say why, so the record makes sense later.",
    reviewDate_required: "Pick a date to look at this risk again.",
    reviewDate_invalid: "That review date isn't a valid date.",
    product_required: "Say which product this is.",
    name_required: "Give it a name.",
    not_found: "That no longer exists. Reload the page.",
    session_revoked: "You were signed out. Log in again."
  };
  function errorMessage(err) {
    var code = err && err.code;
    if (code === "secret_detected") return "Not saved: the " + (err.field || "text") + " looks like it contains " + (SECRET_KIND[err.kind] || "a password or key") + ". Take it out and keep it in a password manager, then save again.";
    if (code && CODE_TEXT[code]) return CODE_TEXT[code];
    if (err && err.status === 401) return "Your session has expired. Log in again.";
    if (err && err.status === 403) return "Your account can't change this.";
    if (code) return "Not saved (" + String(code).replace(/_/g, " ") + ").";
    return "Couldn't reach the server. Try again.";
  }
  function needsSignIn(err) { return !!err && (err.code === "recent_sign_in_required" || err.status === 401 || err.code === "session_revoked"); }

  // ---- the catalogue's own status (what the catalogue service reports about itself)

  var SOURCE_NAMES = [
    ["cve_list", "CVE.org list of every CVE"], ["kev", "CISA exploited list"], ["epss", "Exploit-likelihood scores (EPSS)"],
    ["nvd", "NVD scores and affected versions"], ["archive", "Move of older CVEs to the archive"]
  ];

  // The headline numbers, as { label, value } in reading order.
  function catalogTiles(s) {
    s = s || {};
    var c = s.counts || {};
    return [
      { label: "CVEs in all", value: thousands(s.total) },
      { label: "Published in the last 30 days", value: thousands(c.recent) },
      { label: "Older, in the archive", value: thousands(c.archive) },
      { label: "Exploited in the wild", value: thousands(s.kev) },
      { label: "With a score", value: thousands(s.enriched) },
      { label: "With an exploit likelihood", value: thousands(s.withEpss) }
    ];
  }

  // One row per feed the catalogue is built from: { title, tone, text }. A feed that has never run says so; one that
  // failed says what went wrong and when it last worked.
  function sourceRows(sources, now) {
    sources = sources || {};
    return SOURCE_NAMES.map(function (n) {
      var s = sources[n[0]];
      if (!s) return { title: n[1], tone: "", text: "Not run yet" };
      var when = agoText(s.lastOk, now);
      if (s.ok === false) return { title: n[1], tone: "alert", text: "Failed" + (s.error ? ": " + String(s.error).slice(0, 160) : "") + (when ? ". Last worked " + when + "." : ".") };
      return { title: n[1], tone: "ok", text: when ? "Updated " + when : "Updated" };
    });
  }

  // A notice while the first full load of the list is still running (the catalogue is then incomplete), else null.
  function loadBanner(s) {
    if (!s || s.loaded) return null;
    return "The first full load of the CVE list is still running (" + thousands(s.total) + " CVEs so far), so the catalogue is not complete yet. It fills in by itself.";
  }

  // ---- what a CVE record says about how it is attacked and which versions it affects

  var VECTOR_ATTACK = { N: "over the network", A: "from an adjacent network", L: "locally on the machine", P: "with physical access" };
  var VECTOR_COMPLEXITY = { L: "low complexity", H: "high complexity" };
  var VECTOR_PRIVS = { N: "no privileges needed", L: "low privileges needed", H: "high privileges needed" };
  var VECTOR_USER = { N: "no user interaction", R: "user interaction needed", P: "a little user interaction", A: "user interaction needed" };

  // A CVSS vector string ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/...") in plain words: how, how hard, what the attacker needs. "" when
  // it cannot be read.
  function vectorText(vector) {
    if (typeof vector !== "string" || !/^CVSS:\d\.\d\//.test(vector)) return "";
    var m = {};
    vector.split("/").slice(1).forEach(function (p) { var kv = p.split(":"); if (kv.length === 2) m[kv[0]] = kv[1]; });
    var parts = [];
    if (VECTOR_ATTACK[m.AV]) parts.push("Attacked " + VECTOR_ATTACK[m.AV]);
    if (VECTOR_COMPLEXITY[m.AC]) parts.push(VECTOR_COMPLEXITY[m.AC]);
    if (VECTOR_PRIVS[m.PR]) parts.push(VECTOR_PRIVS[m.PR]);
    if (VECTOR_USER[m.UI]) parts.push(VECTOR_USER[m.UI]);
    return parts.join("; ");
  }

  // The CVSS scores a record carries, newest standard first: [{ label: "CVSS 4.0", text: "9.3 Critical", how: "...", vector }].
  function cvssRows(cvss) {
    cvss = cvss || {};
    var out = [];
    [["v40", "CVSS 4.0"], ["v31", "CVSS 3.1"]].forEach(function (k) {
      var c = cvss[k[0]];
      if (!c || c.score === null || c.score === undefined) return;
      out.push({ label: k[1], text: scoreText({ score: c.score, severity: c.severity }), how: vectorText(c.vector), vector: typeof c.vector === "string" ? c.vector.slice(0, 120) : "" });
    });
    return out;
  }

  // One affected-version line from the catalogue ({ product, from, fromIncl, to, toIncl, exact }).
  function rangeText(a) {
    var name = (a && (a.product || a.vendor)) || "";
    if (!a) return "";
    if (a.exact) return name + " " + a.exact;
    var from = a.from && a.from !== "0" ? a.from : "";
    var start = (a.fromIncl === false ? "after " : "from ") + from;
    if (from && a.to) return name + " " + start + " up to " + (a.toIncl ? "and including " : "but not including ") + a.to;
    if (a.to) return name + " " + (a.toIncl ? "up to and including " : "before ") + a.to;
    if (from) return name + " " + (a.fromIncl === false ? "after " : "") + from + (a.fromIncl === false ? "" : " and later");
    return name + " (all versions)";
  }

  // ---- importing a list of servers and software in one go

  var IMPORT_LIMITS = { servers: 50, software: 200, name: 80, vendor: 80, product: 80, version: 60, notes: 600 };
  var IMPORTANCE = ["low", "normal", "high"];

  // Checks one server or software entry; returns the payload for the Worker, or pushes what is wrong onto `problems`.
  function importEntry(raw, where, kind, problems) {
    var allowed = kind === "infra" ? ["name", "internet", "importance", "notes", "software"] : ["product", "vendor", "version", "name", "importance", "notes"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { problems.push(where + ": should be an object"); return null; }
    var bad = Object.keys(raw).filter(function (k) { return allowed.indexOf(k) === -1; });
    if (bad.length) problems.push(where + ": unknown field " + bad[0]);
    var out = { kind: kind };
    function str(field, max, required) {
      var v = raw[field];
      if (v === undefined || v === null || v === "") { if (required) problems.push(where + ": " + field + " is missing"); return; }
      if (typeof v !== "string") { problems.push(where + ": " + field + " should be text (put it in quotes)"); return; }
      v = v.trim();
      if (v.length > max) { problems.push(where + ": " + field + " is longer than " + max + " characters"); return; }
      if (v) out[field] = v;
    }
    if (kind === "infra") {
      str("name", IMPORT_LIMITS.name, true);
      if (raw.internet !== undefined) { if (typeof raw.internet !== "boolean") problems.push(where + ": internet should be true or false"); else out.internet = raw.internet; }
    } else {
      str("product", IMPORT_LIMITS.product, true);
      str("vendor", IMPORT_LIMITS.vendor, false);
      str("version", IMPORT_LIMITS.version, false);
      str("name", IMPORT_LIMITS.name, false);
    }
    if (raw.importance !== undefined) { if (IMPORTANCE.indexOf(raw.importance) === -1) problems.push(where + ": importance should be low, normal or high"); else out.importance = raw.importance; }
    str("notes", IMPORT_LIMITS.notes, false);
    return out;
  }

  // Pasted JSON -> { problems: [], servers: [{ payload, software: [payload] }], loose: [payload] }. Nothing is sent from here.
  function parseImport(text) {
    var problems = [], servers = [], loose = [], root;
    try { root = JSON.parse(String(text || "")); } catch (e) { return { problems: ["That isn't valid JSON. Check the brackets, commas and quotes."], servers: [], loose: [] }; }
    if (!root || typeof root !== "object" || Array.isArray(root)) return { problems: ["The list should be an object with \"servers\" and/or \"software\"."], servers: [], loose: [] };
    Object.keys(root).forEach(function (k) { if (k !== "servers" && k !== "software") problems.push("Unknown top-level field " + k); });
    if (root.servers !== undefined && !Array.isArray(root.servers)) problems.push("servers should be a list");
    if (root.software !== undefined && !Array.isArray(root.software)) problems.push("software should be a list");
    var total = 0;
    (Array.isArray(root.servers) ? root.servers : []).forEach(function (s, i) {
      var where = "servers[" + i + "]";
      var p = importEntry(s, where, "infra", problems);
      if (!p) return;
      var sw = [];
      if (s.software !== undefined && !Array.isArray(s.software)) problems.push(where + ": software should be a list");
      (Array.isArray(s.software) ? s.software : []).forEach(function (x, j) { var q = importEntry(x, where + ".software[" + j + "]", "software", problems); if (q) sw.push(q); });
      total += sw.length;
      servers.push({ payload: p, software: sw });
    });
    (Array.isArray(root.software) ? root.software : []).forEach(function (x, j) { var q = importEntry(x, "software[" + j + "]", "software", problems); if (q) { loose.push(q); total++; } });
    if (servers.length > IMPORT_LIMITS.servers) problems.push("At most " + IMPORT_LIMITS.servers + " servers can be added.");
    if (total > IMPORT_LIMITS.software) problems.push("At most " + IMPORT_LIMITS.software + " software items can be added.");
    if (!servers.length && !loose.length && !problems.length) problems.push("The list is empty.");
    return { problems: problems, servers: servers, loose: loose };
  }

  // What importing would do given what is already listed: servers with the same name are reused, software already under
  // that server (same product and version) is skipped, so running the same import twice adds nothing the second time.
  // -> { steps: [{ type: "server"|"software", payload, hostKey?, existingId? }], add: n, skip: n }
  function planImport(parsed, items) {
    items = items || [];
    var steps = [], add = 0, skip = 0;
    var lower = function (s) { return String(s || "").toLowerCase(); };
    var swKey = function (p, v) { return lower(p) + "|" + lower(v); };
    function have(parentId, payload) {
      return items.some(function (i) { return i.kind === "software" && (i.parentId || null) === parentId && swKey(i.product, i.version) === swKey(payload.product, payload.version); });
    }
    parsed.servers.forEach(function (s, idx) {
      var existing = items.filter(function (i) { return i.kind === "infra" && lower(i.name) === lower(s.payload.name); })[0];
      var key = "h" + idx;
      steps.push({ type: "server", payload: s.payload, hostKey: key, existingId: existing ? existing.id : null });
      if (existing) skip++; else add++;
      s.software.forEach(function (x) {
        if (existing && have(existing.id, x)) { skip++; return; }
        steps.push({ type: "software", payload: x, hostKey: key });
        add++;
      });
    });
    parsed.loose.forEach(function (x) {
      if (have(null, x)) { skip++; return; }
      steps.push({ type: "software", payload: x, hostKey: null });
      add++;
    });
    return { steps: steps, add: add, skip: skip };
  }

  var helpers = {
    parseImport: parseImport, planImport: planImport, IMPORT_LIMITS: IMPORT_LIMITS,
    vectorText: vectorText, cvssRows: cvssRows, rangeText: rangeText,
    catalogTiles: catalogTiles, sourceRows: sourceRows, loadBanner: loadBanner,
    stateText: stateText, stateTone: stateTone, priorityTone: priorityTone, priorityHint: priorityHint, fmtDate: fmtDate, monthLabel: monthLabel,
    agoText: agoText, thousands: thousands, scoreText: scoreText, scoreTone: scoreTone, epssText: epssText, confidenceText: confidenceText,
    safeUrl: safeUrl, itemLabel: itemLabel, softwareLabel: softwareLabel, autoName: autoName, nameBase: nameBase, matchText: matchText, itemTree: itemTree, queryString: queryString,
    pageCount: pageCount, barPercent: barPercent, planBadge: planBadge, canEditPlan: canEditPlan, canApprove: canApprove, planDraft: planDraft,
    planPayload: planPayload, eventTitle: eventTitle, actorText: actorText, errorMessage: errorMessage, needsSignIn: needsSignIn, PERSON_STATES: PERSON_STATES
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. transport ---------------------------------------------------------

  function apiError(res, data) {
    var err = new Error((data && data.error) || "request_failed");
    err.status = res.status;
    err.code = (data && data.error) || null;
    err.field = (data && data.field) || null;
    err.kind = (data && data.kind) || null;
    return err;
  }
  function request(method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw apiError(res, data);
        return data;
      });
    });
  }
  var api = {
    me: function () { return request("GET", "/me"); },
    environment: function () { return request("GET", "/environment"); },
    addItem: function (b) { return request("POST", "/environment", b); },
    updateItem: function (id, b) { return request("PATCH", "/environment/" + id, b); },
    removeItem: function (id) { return request("DELETE", "/environment/" + id); },
    refresh: function () { return request("POST", "/refresh", {}); },
    findings: function (q) { return request("GET", "/findings" + queryString(q)); },
    finding: function (id) { return request("GET", "/findings/" + id); },
    setState: function (id, b) { return request("POST", "/findings/" + id + "/state", b); },
    setPlan: function (id, b) { return request("POST", "/findings/" + id + "/plan", b); },
    approve: function (id, note) { return request("POST", "/findings/" + id + "/approve", note ? { note: note } : {}); },
    history: function () { return request("GET", "/history/summary"); },
    catalogStatus: function () { return request("GET", "/catalog/status"); },
    archiveMonths: function () { return request("GET", "/catalog/archive/months"); },
    products: function (q) { return request("GET", "/catalog/products" + queryString({ q: q })); },
    search: function (q) { return request("GET", "/catalog/search" + queryString(q)); },
    cve: function (id) { return request("GET", "/catalog/cve/" + encodeURIComponent(id)); }
  };

  // ---- 3. UI ----------------------------------------------------------------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function chip(text, tone) { return el("span", "chip" + (tone ? " " + tone : ""), text); }
  function button(label, cls, onClick) {
    var b = el("button", cls || "btn", label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function field(label, input, cls) {
    var l = el("label", "vn-field" + (cls ? " " + cls : ""));
    l.appendChild(el("span", null, label));
    l.appendChild(input);
    return l;
  }
  function input(type, value, max) {
    var i = el("input");
    i.type = type;
    if (value !== undefined && value !== null) i.value = value;
    if (max) i.maxLength = max;
    return i;
  }
  function select(options, value) {
    var s = el("select");
    options.forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; s.appendChild(op); });
    s.value = value;
    return s;
  }
  function toast(text) { if (window.BarnyardShell && window.BarnyardShell.toast) window.BarnyardShell.toast(text); }
  function signInAgainLink() {
    var a = el("a", null, " Sign in again");
    a.href = "https://api.barnyard.site/auth/login?return_to=" + encodeURIComponent(location.href);
    return a;
  }
  function message(text, tone, err) {
    var m = el("div", "vn-msg" + (tone ? " " + tone : ""), text);
    m.setAttribute("role", tone === "alert" ? "alert" : "status");
    if (err && needsSignIn(err)) m.appendChild(signInAgainLink());
    return m;
  }

  function mount(root) {
    var S = {
      view: "current", summary: null, env: null, catalog: null, detail: null, envForm: null, importOpen: false, busy: false, banner: null,
      current: { q: "", priority: "", state: "", all: false, item: "", page: 1 },
      history: { q: "", priority: "", state: "", item: "", page: 1 },
      catalogue: { q: "", zone: "", month: "", kev: false, page: 1, months: null, open: "" },
      historySummary: null
    };
    var body = null;

    // ---- shared pieces

    function pager(res, filter, redraw) {
      var pages = pageCount(res.total, res.perPage);
      var box = el("div", "vn-more");
      if (pages <= 1) { box.appendChild(el("span", null, res.total + (res.total === 1 ? " result" : " results"))); return box; }
      var prev = button("Previous", "btn btn-sm", function () { filter.page = Math.max(1, filter.page - 1); redraw(); });
      prev.disabled = filter.page <= 1;
      var next = button("Next", "btn btn-sm", function () { filter.page = Math.min(pages, filter.page + 1); redraw(); });
      next.disabled = filter.page >= pages;
      box.appendChild(prev);
      box.appendChild(el("span", null, "Page " + filter.page + " of " + pages + " (" + thousands(res.total) + ")"));
      box.appendChild(next);
      return box;
    }

    function findingRow(f) {
      var row = el("button", "vn-row");
      row.type = "button";
      var snap = f.snapshot || {};
      var top = el("div", "vn-row-top");
      top.appendChild(chip(f.priority, priorityTone(f.priority)));
      top.appendChild(el("span", "vn-id", f.cveId));
      top.appendChild(el("span", "vn-title", snap.title || "No title published"));
      top.appendChild(chip(stateText(f.state), stateTone(f.state)));
      row.appendChild(top);
      var meta = el("div", "vn-row-meta");
      meta.appendChild(el("span", null, itemLabel(f.itemName, f.itemVersion)));
      meta.appendChild(chip(scoreText(snap), scoreTone(snap)));
      if (snap.kev) meta.appendChild(chip("Exploited in the wild", "alert"));
      var ep = epssText(snap.epss);
      if (ep) meta.appendChild(el("span", null, ep));
      meta.appendChild(el("span", null, f.confidence === "confirmed" ? "Confirmed" : "Might apply"));
      if (snap.fixedIn && f.state !== "fixed") meta.appendChild(el("span", null, "Fixed in " + snap.fixedIn));
      if (f.state === "fixed" && f.fixedAt) meta.appendChild(el("span", null, "Fixed " + fmtDate(f.fixedAt)));
      else meta.appendChild(el("span", null, "Found " + fmtDate(f.firstSeen)));
      row.appendChild(meta);
      row.addEventListener("click", function () { openFinding(f.id); });
      return row;
    }

    function emptyBox(title, text, actionLabel, onAction) {
      var b = el("div", "vn-empty");
      b.appendChild(el("b", null, title));
      b.appendChild(el("p", null, text));
      if (actionLabel) b.appendChild(button(actionLabel, "btn btn-primary", onAction));
      return b;
    }

    // ---- top: summary strip and tabs

    function reloadSummary() {
      return api.me().then(function (me) { S.summary = me.summary; }).catch(function () { /* the strip keeps what it had */ });
    }

    function drawStrip(host) {
      var s = S.summary || { byPriority: {}, openTotal: 0, needsLook: 0 };
      var strip = el("div", "vn-strip");
      ["P1", "P2", "P3", "P4"].forEach(function (p) {
        var n = (s.byPriority && s.byPriority[p]) || 0;
        var b = el("button", "vn-stat " + p.toLowerCase());
        b.type = "button";
        b.appendChild(el("b", null, String(n)));
        b.appendChild(el("span", null, p + " " + priorityHint(p)));
        b.addEventListener("click", function () { S.detail = null; S.view = "current"; S.current.priority = S.current.priority === p ? "" : p; S.current.page = 1; render(); });
        strip.appendChild(b);
      });
      host.appendChild(strip);
      host.appendChild(el("div", "vn-catalog", catalogLine()));
    }

    // "4 open. Checked against 394,770 known CVEs, updated 3 min ago." The catalogue part is added when its status arrives, so
    // the page never waits for it.
    function catalogLine() {
      var s = S.summary || { openTotal: 0 };
      var line = (s.openTotal || 0) + " open";
      if (S.catalog && S.catalog.total) {
        var when = S.catalog.sources && S.catalog.sources.cve_list && S.catalog.sources.cve_list.lastOk;
        line += ". Checked against " + thousands(S.catalog.total) + " known CVEs" + (when ? ", updated " + agoText(when, Date.now()) : "");
      }
      return line + ".";
    }

    function drawTabs(host) {
      var tabs = el("div", "vn-tabs");
      tabs.setAttribute("role", "tablist");
      [["current", "Current"], ["history", "History"], ["catalogue", "Catalogue"], ["env", "My environment"]].forEach(function (t) {
        var b = el("button", null, t[1]);
        b.type = "button";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(S.view === t[0] && !S.detail));
        b.addEventListener("click", function () { S.detail = null; S.view = t[0]; S.banner = null; render(); });
        tabs.appendChild(b);
      });
      host.appendChild(tabs);
    }

    function checkNow(btn) {
      btn.disabled = true;
      btn.textContent = "Checking…";
      api.refresh().then(function (r) {
        toast("Checked " + (r.matched || 0) + " item" + ((r.matched || 0) === 1 ? "" : "s") + " against the catalog.");
      }, function (err) {
        S.banner = { text: errorMessage(err), tone: "alert", err: err };
      }).then(function () { return Promise.all([reloadSummary(), api.environment().then(function (e) { S.env = e; }, function () {})]); }).then(render);
    }

    // ---- Current and History

    function drawFindings(view, host) {
      var F = S[view];
      var bar = el("div", "vn-bar");
      var q = input("search", F.q, 60);
      q.placeholder = "Search CVE, product or text";
      q.setAttribute("aria-label", "Search findings");
      var timer = null;
      q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { F.q = q.value.trim(); F.page = 1; load(); }, 300); });
      var pri = select([["", "Any priority"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"], ["P4", "P4"]], F.priority);
      pri.setAttribute("aria-label", "Priority");
      pri.addEventListener("change", function () { F.priority = pri.value; F.page = 1; load(); });
      var st = select([["", "Any status"]].concat(["new", "affects", "not_affected", "accepted", "approved", "fixed"].map(function (s) { return [s, stateText(s)]; })), F.state);
      st.setAttribute("aria-label", "Status");
      st.addEventListener("change", function () { F.state = st.value; F.page = 1; load(); });
      bar.appendChild(q); bar.appendChild(pri); bar.appendChild(st);
      var itemLabel = null;
      if (F.item && S.env) {
        var it = S.env.items.filter(function (i) { return i.id === F.item; })[0];
        itemLabel = button("Only " + (it ? it.name : "one item") + " ✕", "btn btn-sm", function () { F.item = ""; F.page = 1; load(); });
        bar.appendChild(itemLabel);
      }
      var hiddenBox = el("label", "vn-check");
      var all = input("checkbox");
      all.checked = !!F.all;
      all.addEventListener("change", function () { F.all = all.checked; F.page = 1; load(); });
      var hiddenText = el("span", null, "Show everything");
      if (view === "current") { hiddenBox.appendChild(all); hiddenBox.appendChild(hiddenText); bar.appendChild(hiddenBox); }
      bar.appendChild(el("span", "grow"));
      var chk = button("Check now", "btn btn-sm", function () { checkNow(chk); });
      bar.appendChild(chk);
      host.appendChild(bar);
      var listHost = el("div");
      host.appendChild(listHost);

      function load() {
        var query = { view: view, q: F.q, priority: F.priority, state: F.state, item: F.item, page: F.page, per: 25 };
        if (view === "current" && F.all) query.all = true;
        api.findings(query).then(function (res) {
          clear(listHost);
          if (view === "current") hiddenText.textContent = res.hidden && !F.all ? "Show everything (" + res.hidden + " lower-risk hidden)" : "Show everything";
          if (!res.items.length) {
            var none = S.env && !S.env.items.length;
            if (none) listHost.appendChild(emptyBox("Add your first item", "Tell this what you run, such as a server or a piece of software with its version, and it will keep a record of the known vulnerabilities that apply.", "Add what I run", function () { S.view = "env"; S.envForm = { kind: "infra" }; render(); }));
            else if (F.q || F.priority || F.state || F.item) listHost.appendChild(emptyBox("Nothing matches", "No findings match those filters.", "Clear filters", function () { F.q = ""; F.priority = ""; F.state = ""; F.item = ""; F.page = 1; render(); }));
            else listHost.appendChild(emptyBox(view === "current" ? "Nothing needs attention" : "No findings yet", view === "current" ? "No known vulnerability that is worth acting on applies to what you run right now. Lower-risk ones are under “Show everything”." : "Once something you run matches a known CVE it is kept here for good.", null));
            return;
          }
          var list = el("div", "vn-list");
          res.items.forEach(function (f) { list.appendChild(findingRow(f)); });
          listHost.appendChild(list);
          listHost.appendChild(pager(res, F, load));
        }, function (err) {
          clear(listHost);
          listHost.appendChild(message(errorMessage(err), "alert", err));
        });
      }
      load();
    }

    function drawHistory(host) {
      var card = el("div", "vn-card");
      card.appendChild(el("h3", null, "The last 12 months"));
      var chartHost = el("div", "vn-months");
      chartHost.appendChild(el("p", "dim", "Loading…"));
      card.appendChild(chartHost);
      host.appendChild(card);
      api.history().then(function (h) {
        clear(chartHost);
        var max = 0;
        h.months.forEach(function (m) { max = Math.max(max, m.found, m.approved, m.fixed); });
        if (h.averageDaysToFix !== null && h.averageDaysToFix !== undefined) {
          var legend = el("div", "vn-legend");
          legend.appendChild(el("span", null, "Average time to fix: " + h.averageDaysToFix + (h.averageDaysToFix === 1 ? " day" : " days") + " (" + h.fixedTotal + " fixed)"));
          chartHost.appendChild(legend);
        }
        var cols = el("div", "vn-month vn-legend");
        ["", "Found", "Approved", "Fixed"].forEach(function (t, i) { var s = el("span", null, t); if (i) { var d = el("i", i === 2 ? "approved" : i === 3 ? "fixed" : ""); s.insertBefore(d, s.firstChild); } cols.appendChild(s); });
        chartHost.appendChild(cols);
        h.months.forEach(function (m) {
          var row = el("div", "vn-month");
          row.appendChild(el("span", "label", monthLabel(m.month)));
          [["", m.found], ["approved", m.approved], ["fixed", m.fixed]].forEach(function (b) {
            var line = el("div", "vn-bar-line");
            var fill = el("span", "vn-bar-fill" + (b[0] ? " " + b[0] : ""));
            fill.style.width = barPercent(b[1], max) * 0.8 + "%";
            line.appendChild(fill);
            line.appendChild(el("span", "vn-bar-num", String(b[1])));
            row.appendChild(line);
          });
          chartHost.appendChild(row);
        });
      }, function (err) { clear(chartHost); chartHost.appendChild(message(errorMessage(err), "alert", err)); });
      var listCard = el("div");
      host.appendChild(listCard);
      drawFindings("history", listCard);
    }

    // ---- Catalogue (every CVE the catalogue holds, and how it is kept up to date)

    // The catalogue's own numbers and the state of each feed it is built from, read fresh each time the tab opens.
    function drawCatalogueStatus(host) {
      var card = el("div", "vn-card");
      card.appendChild(el("h3", null, "The catalogue"));
      var body = el("div", "vn-cat-body");
      body.appendChild(el("p", "dim", "Loading…"));
      card.appendChild(body);
      host.appendChild(card);
      api.catalogStatus().then(function (s) {
        S.catalog = s;
        clear(body);
        var tiles = el("div", "vn-tiles");
        catalogTiles(s).forEach(function (t) {
          var tile = el("div", "vn-tile");
          tile.appendChild(el("b", null, t.value));
          tile.appendChild(el("span", null, t.label));
          tiles.appendChild(tile);
        });
        body.appendChild(tiles);
        var banner = loadBanner(s);
        if (banner) body.appendChild(message(banner, "", null));
        var list = el("ul", "vn-sources");
        sourceRows(s.sources, Date.now()).forEach(function (r) {
          var li = el("li");
          li.appendChild(el("span", "vn-source-name", r.title));
          li.appendChild(chip(r.text, r.tone));
          list.appendChild(li);
        });
        body.appendChild(list);
        if (s.newestPublished) body.appendChild(el("p", "vn-note", "Newest CVE published " + fmtDate(s.newestPublished) + ". The list is checked for new and changed CVEs every hour; scores and exploited flags are refreshed daily."));
      }, function (err) {
        clear(body);
        body.appendChild(message(errorMessage(err), "alert", err));
      });
    }

    function drawCatalogue(host) {
      var A = S.catalogue;
      drawCatalogueStatus(host);
      var bar = el("div", "vn-bar");
      var q = input("search", A.q, 100);
      q.placeholder = "Search any CVE, product or text";
      q.setAttribute("aria-label", "Search the catalog");
      var timer = null;
      q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { A.q = q.value.trim(); A.page = 1; load(); }, 350); });
      var zone = select([["", "All CVEs"], ["recent", "Last 30 days"], ["archive", "Older than a month"]], A.zone);
      zone.setAttribute("aria-label", "Which CVEs");
      zone.addEventListener("change", function () { A.zone = zone.value; A.page = 1; load(); });
      var monthSel = select([["", "Any month (older ones listed)"]], A.month);
      monthSel.setAttribute("aria-label", "Month published");
      monthSel.addEventListener("change", function () { A.month = monthSel.value; A.page = 1; load(); });
      var kevBox = el("label", "vn-check");
      var kev = input("checkbox");
      kev.checked = A.kev;
      kev.addEventListener("change", function () { A.kev = kev.checked; A.page = 1; load(); });
      kevBox.appendChild(kev);
      kevBox.appendChild(el("span", null, "Exploited only"));
      bar.appendChild(q); bar.appendChild(zone); bar.appendChild(monthSel); bar.appendChild(kevBox);
      host.appendChild(bar);
      host.appendChild(el("p", "vn-note", "Every public CVE, not only the ones that apply to you, newest first. Open one to read its record."));
      var listHost = el("div");
      host.appendChild(listHost);

      function fillMonths(items) {
        (items || []).forEach(function (m) { var o = el("option", null, monthLabel(m.month) + " (" + thousands(m.count) + ")"); o.value = m.month; monthSel.appendChild(o); });
        monthSel.value = A.month;
      }
      if (A.months) fillMonths(A.months);
      else api.archiveMonths().then(function (r) { A.months = r.months || r.items || []; fillMonths(A.months); }, function () { A.months = []; });

      function row(c) {
        var wrap = el("div");
        var r = el("button", "vn-row");
        r.type = "button";
        var top = el("div", "vn-row-top");
        top.appendChild(el("span", "vn-id", c.id));
        top.appendChild(el("span", "vn-title", c.title || "No title published"));
        r.appendChild(top);
        var meta = el("div", "vn-row-meta");
        meta.appendChild(chip(scoreText(c), scoreTone(c)));
        if (c.kev) meta.appendChild(chip("Exploited in the wild", "alert"));
        var ep = epssText(c.epss);
        if (ep) meta.appendChild(el("span", null, ep));
        meta.appendChild(el("span", null, "Published " + fmtDate(c.published)));
        r.appendChild(meta);
        wrap.appendChild(r);
        var detail = el("div");
        wrap.appendChild(detail);
        r.addEventListener("click", function () {
          if (A.open === c.id) { A.open = ""; clear(detail); return; }
          A.open = c.id;
          clear(detail);
          detail.appendChild(el("p", "dim vn-card", "Loading…"));
          api.cve(c.id).then(function (full) { clear(detail); detail.appendChild(cveCard(full)); }, function (err) { clear(detail); detail.appendChild(message(errorMessage(err), "alert", err)); });
        });
        return wrap;
      }

      function load() {
        api.search({ q: A.q, zone: A.zone, month: A.month, kev: A.kev, page: A.page, per: 25 }).then(function (res) {
          clear(listHost);
          if (!res.items.length) { listHost.appendChild(emptyBox("Nothing found", "No CVE matches that search.", null)); return; }
          var list = el("div", "vn-list");
          res.items.forEach(function (c) { list.appendChild(row(c)); });
          listHost.appendChild(list);
          listHost.appendChild(pager({ total: res.total, perPage: res.perPage || 25 }, A, load));
        }, function (err) { clear(listHost); listHost.appendChild(message(errorMessage(err), "alert", err)); });
      }
      load();
    }

    // A catalog CVE record: description, score, weakness types, products and references.
    function cveCard(full) {
      var rec = full.record || {};
      var card = el("div", "vn-card");
      var facts = el("dl", "vn-facts");
      function fact(k, v) { if (!v) return; facts.appendChild(el("dt", null, k)); facts.appendChild(el("dd", null, v)); }
      fact("Score", scoreText(full));
      cvssRows(rec.cvss).forEach(function (c) { fact(c.label, c.text + (c.how ? ". " + c.how + "." : "")); });
      if (full.kev) fact("Exploited", "Yes" + (full.kevAdded ? ", added " + fmtDate(full.kevAdded) : "") + (full.kevInfo && full.kevInfo.due ? ", fix due " + fmtDate(full.kevInfo.due) : "") + (full.kevInfo && full.kevInfo.ransomware ? ", used in ransomware: " + full.kevInfo.ransomware : ""));
      fact("Exploit chance", epssText(full.epss) ? epssText(full.epss).replace("EPSS ", "") + " in the next 30 days" : "");
      fact("Published", fmtDate(full.published));
      fact("Changed", fmtDate(full.modified));
      if (rec.cwes && rec.cwes.length) fact("Weakness", rec.cwes.join(", "));
      if (rec.products && rec.products.length) fact("Products", rec.products.map(function (p) { return (p.vendor ? p.vendor + " " : "") + p.product; }).join(", "));
      card.appendChild(facts);
      if (rec.description) card.appendChild(el("p", "vn-desc", rec.description));
      var affected = (full.affected || []).map(rangeText).filter(Boolean);
      if (affected.length) {
        card.appendChild(el("h3", null, "Affected versions"));
        var al = el("ul", "vn-refs");
        affected.slice(0, 40).forEach(function (t) { al.appendChild(el("li", null, t)); });
        card.appendChild(al);
      }
      var refs = (rec.refs || []).map(safeUrl).filter(Boolean).slice(0, 8);
      if (refs.length) {
        var ul = el("ul", "vn-refs");
        refs.forEach(function (u) { var li = el("li"); var a = el("a", null, u); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; li.appendChild(a); ul.appendChild(li); });
        card.appendChild(ul);
      }
      return card;
    }

    // ---- My environment

    // Adds a checked import plan one item at a time (servers first, then the software on them), gently, because the Worker
    // allows 60 writes a minute. Resolves to how many were added; rejects with what was done so far on the first refusal.
    function runImport(plan, onProgress) {
      var ids = {}, added = 0;
      function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      function next(i) {
        if (i >= plan.steps.length) return Promise.resolve(added);
        var st = plan.steps[i], p;
        onProgress(i, plan.steps.length);
        if (st.type === "server") {
          if (st.existingId) { ids[st.hostKey] = st.existingId; p = Promise.resolve(false); }
          else p = api.addItem(st.payload).then(function (r) { ids[st.hostKey] = r.item.id; added++; return true; });
        } else {
          var body = {};
          Object.keys(st.payload).forEach(function (k) { body[k] = st.payload[k]; });
          if (st.hostKey && ids[st.hostKey]) body.parentId = ids[st.hostKey];
          p = api.addItem(body).then(function () { added++; return true; });
        }
        return p.then(function (wrote) { return wrote ? pause(1100) : null; }).then(function () { return next(i + 1); });
      }
      return next(0).catch(function (err) { err.added = added; throw err; });
    }

    function drawImport(host) {
      var card = el("div", "vn-card");
      card.appendChild(el("h3", null, "Import a list"));
      card.appendChild(el("p", "vn-note", "Paste servers and the software on each as JSON, for example {\"servers\":[{\"name\":\"web01\",\"internet\":true,\"software\":[{\"product\":\"caddy\",\"vendor\":\"caddyserver\",\"version\":\"2.11.7\"}]}]}. Use the catalogue's own product names (the suggestions when you add software show them). A server already listed is reused and software already on it is skipped, so the same list can be pasted twice safely."));
      var ta = el("textarea", "vn-import-text");
      ta.rows = 12;
      ta.spellcheck = false;
      ta.setAttribute("aria-label", "The list to import");
      card.appendChild(ta);
      var out = el("div");
      var plan = null;
      var go = button("Add them", "btn btn-primary");
      go.disabled = true;
      var check = button("Check the list", "btn", function () {
        clear(out);
        plan = null;
        go.disabled = true;
        var parsed = parseImport(ta.value);
        if (parsed.problems.length) {
          var box = message("Fix these first:", "alert", null);
          var ul = el("ul", "vn-refs");
          parsed.problems.slice(0, 12).forEach(function (t) { ul.appendChild(el("li", null, t)); });
          box.appendChild(ul);
          out.appendChild(box);
          return;
        }
        plan = planImport(parsed, (S.env && S.env.items) || []);
        out.appendChild(message("Ready: " + plan.add + " to add" + (plan.skip ? ", " + plan.skip + " already listed and skipped" : "") + "." + (plan.add ? " Adding takes about a second each." : " Nothing new to add."), "ok", null));
        go.disabled = !plan.add;
      });
      go.addEventListener("click", function () {
        if (!plan || !plan.add) return;
        go.disabled = true; check.disabled = true; ta.disabled = true;
        clear(out);
        var prog = el("div", "vn-msg", "Adding…");
        prog.setAttribute("role", "status");
        out.appendChild(prog);
        runImport(plan, function (i, n) { prog.textContent = "Adding " + (i + 1) + " of " + n + "…"; }).then(function (added) {
          S.importOpen = false;
          toast("Added " + added + ". Looking for known vulnerabilities…");
          return Promise.all([api.environment().then(function (e) { S.env = e; }), reloadSummary()]);
        }, function (err) {
          clear(out);
          out.appendChild(message("Stopped after adding " + (err.added || 0) + ". " + errorMessage(err) + " Paste the same list again to carry on; what is already added is skipped.", "alert", err));
          go.disabled = false; check.disabled = false; ta.disabled = false;
          return Promise.all([api.environment().then(function (e) { S.env = e; }, function () {}), reloadSummary()]).then(function () { throw err; });
        }).then(render, function () { /* the message above stays */ });
      });
      var row = el("div", "vn-bar");
      row.appendChild(check);
      row.appendChild(go);
      row.appendChild(button("Close", "btn", function () { S.importOpen = false; render(); }));
      card.appendChild(row);
      card.appendChild(out);
      host.appendChild(card);
    }

    function drawEnv(host) {
      var bar = el("div", "vn-bar");
      bar.appendChild(button("Add a server or device", "btn", function () { S.envForm = { kind: "infra" }; render(); }));
      bar.appendChild(button("Add software", "btn btn-primary", function () { S.envForm = { kind: "software" }; render(); }));
      bar.appendChild(button("Import a list", "btn", function () { S.importOpen = !S.importOpen; render(); }));
      bar.appendChild(el("span", "grow"));
      var chk = button("Check now", "btn btn-sm", function () { checkNow(chk); });
      bar.appendChild(chk);
      host.appendChild(bar);
      host.appendChild(el("p", "vn-note", "Only product names and versions are used to look things up. Your server names and notes stay in your own record."));
      if (S.importOpen) drawImport(host);
      if (S.envForm) host.appendChild(itemForm(S.envForm));
      var items = (S.env && S.env.items) || [];
      if (!items.length && !S.envForm) {
        host.appendChild(emptyBox("Add your first item", "Add a server or device you run, then the software on it with its version. Pick the product from the suggestions so it matches the catalog.", "Add a server or device", function () { S.envForm = { kind: "infra" }; render(); }));
        return;
      }
      var tree = itemTree(items);
      tree.hosts.forEach(function (h) {
        var box = el("div", "vn-host");
        var head = el("div", "vn-host-head");
        head.appendChild(el("b", null, h.host.name));
        if (h.host.internet) head.appendChild(chip("Faces the internet", "accent"));
        if (h.host.importance !== "normal") head.appendChild(chip(h.host.importance === "high" ? "Important" : "Low importance", ""));
        if (h.host.notes) head.appendChild(el("span", "vn-item-meta", h.host.notes));
        head.appendChild(itemActions(h.host));
        box.appendChild(head);
        h.software.forEach(function (s) { box.appendChild(softwareRow(s)); });
        if (!h.software.length) box.appendChild(el("div", "vn-sw vn-item-meta", "No software added on this yet."));
        host.appendChild(box);
      });
      if (tree.loose.length) {
        var lbox = el("div", "vn-host");
        var lhead = el("div", "vn-host-head");
        lhead.appendChild(el("b", null, "Software not tied to a server"));
        lbox.appendChild(lhead);
        tree.loose.forEach(function (s) { lbox.appendChild(softwareRow(s)); });
        host.appendChild(lbox);
      }
    }

    function softwareRow(s) {
      var r = el("div", "vn-sw");
      r.appendChild(el("b", null, itemLabel(s.name || s.product, s.version)));
      if (s.vendor) r.appendChild(el("span", "vn-item-meta", s.vendor));
      if (s.open) {
        var c = el("button", "chip alert", s.open + " open");
        c.type = "button";
        c.addEventListener("click", function () { S.view = "current"; S.current.item = s.id; S.current.all = true; S.current.page = 1; render(); });
        r.appendChild(c);
      } else if (s.matchState === "ok") r.appendChild(chip("No known issues", "ok"));
      r.appendChild(el("span", "vn-item-meta", matchText(s, Date.now())));
      r.appendChild(itemActions(s));
      return r;
    }

    function itemActions(item) {
      var box = el("span", "vn-item-actions");
      box.appendChild(button("Edit", "btn btn-sm", function () { S.envForm = { kind: item.kind, item: item }; render(); }));
      var rm = button("Remove", "btn btn-sm", function () {
        if (rm.dataset.sure !== "1") { rm.dataset.sure = "1"; rm.textContent = "Sure? Remove"; setTimeout(function () { rm.dataset.sure = ""; rm.textContent = "Remove"; }, 4000); return; }
        rm.disabled = true;
        api.removeItem(item.id).then(function () { toast("Removed. Its findings stay in History."); return Promise.all([api.environment().then(function (e) { S.env = e; }), reloadSummary()]); })
          .then(render, function (err) { S.banner = { text: errorMessage(err), tone: "alert", err: err }; render(); });
      });
      box.appendChild(rm);
      return box;
    }

    function itemForm(spec) {
      var editing = spec.item || null, kind = spec.kind;
      var f = el("form", "vn-form");
      f.setAttribute("aria-label", editing ? "Edit" : kind === "infra" ? "Add a server or device" : "Add software");
      var err = el("div", "wide");
      var name = input("text", editing ? editing.name : "", 80);
      var product = input("text", editing ? editing.product : "", 80);
      var vendor = input("text", editing ? editing.vendor : "", 80);
      var version = input("text", editing ? editing.version : "", 60);
      var notes = input("text", editing ? editing.notes : "", 600);
      var imp = select([["low", "Low"], ["normal", "Normal"], ["high", "High"]], editing ? editing.importance : "normal");
      var net = input("checkbox");
      net.checked = !!(editing && editing.internet);
      var hosts = ((S.env && S.env.items) || []).filter(function (i) { return i.kind === "infra"; });
      var parent = select([["", "Not on a particular server"]].concat(hosts.map(function (h) { return [h.id, h.name]; })), editing && editing.parentId ? editing.parentId : "");
      if (kind === "infra") {
        name.required = true;
        f.appendChild(field("Name", name));
        var nl = el("label", "vn-check");
        nl.appendChild(net);
        nl.appendChild(el("span", null, "Reachable from the internet"));
        f.appendChild(nl);
        f.appendChild(field("How important is it?", imp));
        f.appendChild(field("Notes (optional)", notes, "wide"));
      } else {
        product.required = true;
        product.setAttribute("list", "vn-products");
        var dl = el("datalist");
        dl.id = "vn-products";
        var found = {};
        var shown = "";   // the catalog's display name for a product picked from the suggestions ("PHP" for php)
        var ptimer = null;
        product.addEventListener("input", function () {
          clearTimeout(ptimer);
          var hit = found[product.value];
          if (hit && !vendor.value) vendor.value = hit.vendor || "";
          if (hit) shown = hit.productName || "";
          ptimer = setTimeout(function () {
            if (product.value.trim().length < 2) return;
            api.products(product.value.trim()).then(function (r) {
              clear(dl);
              (r.items || []).forEach(function (p) { found[p.product] = p; var o = el("option"); o.value = p.product; o.label = (p.vendorName || p.vendor || "") + " " + (p.productName || p.product); dl.appendChild(o); });
            }, function () { /* suggestions are a convenience only */ });
          }, 250);
        });
        f.appendChild(field("Product (pick from the suggestions)", product));
        f.appendChild(dl);
        f.appendChild(field("Version", version));
        f.appendChild(field("Vendor (filled in for you)", vendor));
        f.appendChild(field("Runs on", parent));
        f.appendChild(field("Name to show (optional)", name));
        f.appendChild(field("How important is it?", imp));
        f.appendChild(field("Notes (optional)", notes, "wide"));
      }
      var actions = el("div", "vn-form-actions");
      var save = el("button", "btn btn-primary", editing ? "Save" : "Add");
      save.type = "submit";
      actions.appendChild(save);
      actions.appendChild(button("Cancel", "btn", function () { S.envForm = null; render(); }));
      f.appendChild(err);
      f.appendChild(actions);
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var payload;
        if (kind === "infra") payload = { kind: "infra", name: name.value.trim(), internet: net.checked, importance: imp.value, notes: notes.value.trim() };
        else {
          payload = { kind: "software", product: product.value.trim(), vendor: vendor.value.trim(), version: version.value.trim(), importance: imp.value, notes: notes.value.trim() };
          if (parent.value) payload.parentId = parent.value;
          if (name.value.trim()) payload.name = name.value.trim();
          else if (!editing && shown && found[product.value.trim()]) payload.name = autoName(shown, payload.version);
        }
        if (editing) {
          delete payload.kind;
          if (kind === "software") {
            payload.parentId = parent.value || null;
            // a name nobody typed follows the product and version
            var typed = name.value.trim();
            // (a name that is some words followed by the old version follows the new version too)
            var base = nameBase(editing.name, editing.version);
            var wasAuto = base !== null || editing.name === autoName(editing.product, editing.version);
            payload.name = typed && typed !== editing.name ? typed : wasAuto ? autoName(base !== null ? base : payload.product, payload.version) : editing.name;
          }
        }
        save.disabled = true;
        (editing ? api.updateItem(editing.id, payload) : api.addItem(payload)).then(function () {
          S.envForm = null;
          toast(editing ? "Saved." : "Added. Looking for known vulnerabilities…");
          return Promise.all([api.environment().then(function (e) { S.env = e; }), reloadSummary()]);
        }).then(function () {
          render();
          if (kind === "software") setTimeout(function () { Promise.all([api.environment().then(function (e) { S.env = e; }), reloadSummary()]).then(function () { if (S.view === "env" && !S.detail) render(); }); }, 4000);
        }, function (e) {
          save.disabled = false;
          clear(err);
          err.appendChild(message(errorMessage(e), "alert", e));
        });
      });
      return f;
    }

    // ---- one finding

    function openFinding(id) {
      S.detail = { id: id, finding: null, draft: null, msg: null, approving: false, loading: true };
      render();
      loadFinding();
    }
    function loadFinding() {
      var d = S.detail;
      return api.finding(d.id).then(function (r) {
        if (S.detail !== d) return;
        d.finding = r.finding;
        d.draft = planDraft(r.finding.plan);
        d.loading = false;
        render();
      }, function (err) {
        if (S.detail !== d) return;
        d.loading = false;
        d.msg = { text: errorMessage(err), tone: "alert", err: err };
        render();
      });
    }
    function applyFinding(f, text) {
      var d = S.detail;
      d.finding = Object.assign({}, d.finding, f);
      d.draft = planDraft(d.finding.plan);
      d.msg = text ? { text: text, tone: "ok" } : null;
      return Promise.all([api.finding(d.id).then(function (r) { if (S.detail === d) { d.finding = r.finding; d.draft = planDraft(r.finding.plan); } }, function () {}), reloadSummary()]).then(render);
    }

    function drawDetail(host) {
      var d = S.detail;
      host.appendChild(button("← Back to the list", "btn btn-sm vn-back", function () { S.detail = null; render(); }));
      if (d.loading) { host.appendChild(el("p", "dim", "Loading…")); return; }
      if (!d.finding) { if (d.msg) host.appendChild(message(d.msg.text, d.msg.tone, d.msg.err)); return; }
      var f = d.finding, snap = f.snapshot || {};
      var head = el("div", "vn-head");
      head.appendChild(el("h2", null, f.cveId + (snap.title ? ": " + snap.title : "")));
      var chips = el("div", "vn-chips");
      chips.appendChild(chip(f.priority + " " + priorityHint(f.priority), priorityTone(f.priority)));
      chips.appendChild(chip(stateText(f.state), stateTone(f.state)));
      chips.appendChild(chip(scoreText(snap), scoreTone(snap)));
      if (snap.kev) chips.appendChild(chip("Exploited in the wild", "alert"));
      chips.appendChild(chip(confidenceText(f.confidence), f.confidence === "confirmed" ? "accent" : ""));
      head.appendChild(chips);
      host.appendChild(head);
      if (d.msg) host.appendChild(message(d.msg.text, d.msg.tone, d.msg.err));

      var cols = el("div", "vn-cols");
      var left = el("div"), right = el("div");
      left.style.display = "grid"; left.style.gap = "18px";
      right.style.display = "grid"; right.style.gap = "18px";
      cols.appendChild(left); cols.appendChild(right);
      host.appendChild(cols);

      // what and where
      var about = el("div", "vn-card");
      about.appendChild(el("h3", null, "What and where"));
      var facts = el("dl", "vn-facts");
      function fact(k, v) { if (!v) return; facts.appendChild(el("dt", null, k)); facts.appendChild(el("dd", null, v)); }
      fact("Affects", itemLabel(f.itemName, f.itemVersion) + (f.item ? "" : " (no longer in your list)"));
      fact("Found", fmtDate(f.firstSeen));
      if (f.fixedAt) fact("Fixed", fmtDate(f.fixedAt) + (f.fixedBy === "version" ? " (your version is no longer affected)" : f.fixedBy === "removed" ? " (removed from your list)" : ""));
      if (snap.fixedIn && f.state !== "fixed") fact("Fixed in", snap.fixedIn);
      fact("Published", fmtDate(snap.published));
      if (snap.kev && snap.kevAdded) fact("Added to the exploited list", fmtDate(snap.kevAdded));
      fact("Exploit chance", epssText(snap.epss) ? epssText(snap.epss).replace("EPSS ", "") + " in the next 30 days" : "");
      fact("Status note", f.reason);
      if (f.state === "accepted" && f.reviewDate) fact("Look at again", f.reviewDate);
      about.appendChild(facts);
      var more = button("Read the full CVE record", "btn btn-sm", function () {
        more.disabled = true;
        api.cve(f.cveId).then(function (full) { more.replaceWith(cveCard(full)); }, function (err) { more.disabled = false; about.appendChild(message(errorMessage(err), "alert", err)); });
      });
      about.appendChild(more);
      left.appendChild(about);

      left.appendChild(planCard(f));
      right.appendChild(statusCard(f));
      right.appendChild(approveCard(f));
      right.appendChild(timelineCard(f));
    }

    function statusCard(f) {
      var d = S.detail;
      var card = el("div", "vn-card");
      card.appendChild(el("h3", null, "Where this stands"));
      if (f.state === "approved") {
        card.appendChild(el("p", "vn-note", "Approved. Progress from here is tracked on the Ops board item."));
        return card;
      }
      var st = select(PERSON_STATES.map(function (s) { return [s, stateText(s)]; }), f.state === "approved" ? "new" : f.state);
      var reason = input("text", f.reason || "", 400);
      var date = input("date", f.reviewDate || "");
      var reasonField = field("Why (needed for Not affected and Accepted risk)", reason);
      var dateField = field("Look at this risk again on", date);
      function sync() { dateField.hidden = st.value !== "accepted"; reasonField.hidden = st.value === "new" || st.value === "affects"; }
      st.addEventListener("change", sync);
      var form = el("div", "vn-form");
      form.style.gridTemplateColumns = "1fr";
      form.appendChild(field("Status", st));
      form.appendChild(reasonField);
      form.appendChild(dateField);
      var save = button("Save status", "btn", function () {
        save.disabled = true;
        api.setState(f.id, { state: st.value, reason: reason.value.trim(), reviewDate: st.value === "accepted" ? date.value : "" }).then(function (r) {
          return applyFinding(r.finding, "Status saved.");
        }, function (err) { save.disabled = false; d.msg = { text: errorMessage(err), tone: "alert", err: err }; render(); });
      });
      form.appendChild(save);
      sync();
      card.appendChild(form);
      return card;
    }

    function planCard(f) {
      var d = S.detail;
      var editable = canEditPlan(f);
      var card = el("div", "vn-card");
      var badge = planBadge(f);
      var head = el("div", "vn-bar");
      head.appendChild(el("h3", null, "Remediation plan"));
      head.appendChild(el("span", "grow"));
      head.appendChild(chip(badge.text, badge.tone));
      card.appendChild(head);
      var dr = d.draft;
      if (!editable) {
        card.appendChild(el("p", null, dr.summary));
        var ol = el("ol", "vn-steps");
        dr.steps.forEach(function (s) { var li = el("li", "vn-step-ro"); li.appendChild(chip(s.who === "claude" ? "Claude" : "You", s.who === "claude" ? "info" : "accent")); li.appendChild(el("span", null, s.text)); ol.appendChild(li); });
        card.appendChild(ol);
        [["Downtime", dr.downtime], ["Effort", dr.effort], ["How to check it worked", dr.verify], ["If it goes wrong", dr.rollback]].forEach(function (x) { if (x[1]) { var p = el("p", "vn-note"); p.appendChild(el("b", null, x[0] + ": ")); p.appendChild(document.createTextNode(x[1])); card.appendChild(p); } });
        return card;
      }
      var summary = input("text", dr.summary, 300);
      summary.addEventListener("input", function () { dr.summary = summary.value; });
      card.appendChild(field("Summary", summary));
      var ol2 = el("ol", "vn-steps");
      function drawSteps() {
        clear(ol2);
        dr.steps.forEach(function (s, i) {
          var li = el("li", "vn-step");
          li.appendChild(el("span", "vn-note", String(i + 1)));
          var t = el("textarea");
          t.rows = 2;
          t.maxLength = 300;
          t.value = s.text;
          t.setAttribute("aria-label", "Step " + (i + 1));
          t.addEventListener("input", function () { s.text = t.value; });
          var who = select([["you", "You"], ["claude", "Claude"]], s.who);
          who.setAttribute("aria-label", "Who does step " + (i + 1));
          who.addEventListener("change", function () { s.who = who.value; });
          var rm = button("✕", "btn btn-sm", function () { dr.steps.splice(i, 1); drawSteps(); });
          rm.setAttribute("aria-label", "Remove step " + (i + 1));
          li.appendChild(t); li.appendChild(who); li.appendChild(rm);
          ol2.appendChild(li);
        });
      }
      drawSteps();
      card.appendChild(ol2);
      card.appendChild(button("Add a step", "btn btn-sm", function () { if (dr.steps.length < 15) { dr.steps.push({ text: "", who: "you", done: false }); drawSteps(); } }));
      [["downtime", "Downtime"], ["effort", "Effort"], ["verify", "How to check it worked"], ["rollback", "If it goes wrong"]].forEach(function (x) {
        var i = input("text", dr[x[0]], 300);
        i.addEventListener("input", function () { dr[x[0]] = i.value; });
        card.appendChild(field(x[1], i));
      });
      var save = button("Save plan", "btn", function () {
        save.disabled = true;
        api.setPlan(f.id, planPayload(dr)).then(function (r) { return applyFinding(r.finding, "Plan saved."); },
          function (err) { save.disabled = false; d.msg = { text: errorMessage(err), tone: "alert", err: err }; render(); });
      });
      card.appendChild(save);
      card.appendChild(el("p", "vn-note", "The first draft is written from a template and the fix version in the catalog. Edit it however you like before approving."));
      return card;
    }

    function approveCard(f) {
      var d = S.detail;
      var card = el("div", "vn-card vn-approve");
      card.appendChild(el("h3", null, "Approve"));
      if (f.opsItem) {
        card.appendChild(message("Approved. This is on your Ops board for Claude to carry out.", "ok"));
        var a = el("a", "btn btn-sm", "Open the Ops board");
        a.href = "ops.html";
        card.appendChild(a);
        return card;
      }
      if (f.state === "fixed") { card.appendChild(el("p", "vn-note", "This is already fixed, so there is nothing to approve.")); return card; }
      if (!canApprove(f)) { card.appendChild(el("p", "vn-note", "Add at least one step to the plan to approve it.")); return card; }
      card.appendChild(el("p", "vn-note", "Approving puts this plan on your Ops board as an item that is already approved. Claude will pick it up and carry it out, and you will see each step there."));
      if (!d.approving) {
        card.appendChild(button("Approve this plan…", "btn btn-primary", function () { d.approving = true; render(); }));
        return card;
      }
      var note = el("textarea");
      note.maxLength = 600;
      note.rows = 3;
      note.placeholder = "Anything Claude should know, such as the time that suits you";
      card.appendChild(field("Note for Claude (optional)", note));
      var row = el("div", "vn-bar");
      var go = button("Approve and create the Ops item", "btn btn-primary", function () {
        go.disabled = true;
        api.approve(f.id, note.value.trim()).then(function (r) {
          d.approving = false;
          toast(r.approvedOnBoard === false ? "Item created. Approve it on the Ops board." : "Approved. It is on your Ops board.");
          return applyFinding(r.finding, r.approvedOnBoard === false ? "The Ops item was created but could not be approved automatically. Open it on the Ops board and approve it there." : "Approved and on your Ops board.");
        }, function (err) { go.disabled = false; d.msg = { text: errorMessage(err), tone: "alert", err: err }; render(); });
      });
      row.appendChild(go);
      row.appendChild(button("Cancel", "btn", function () { d.approving = false; render(); }));
      card.appendChild(row);
      return card;
    }

    function timelineCard(f) {
      var card = el("div", "vn-card");
      card.appendChild(el("h3", null, "History"));
      var ul = el("ul", "vn-time");
      (f.events || []).forEach(function (e) {
        var li = el("li");
        li.appendChild(el("span", "when", fmtDate(e.ts) + (actorText(e.actor) ? " · " + actorText(e.actor) : "")));
        li.appendChild(el("span", null, eventTitle(e) + (e.detail ? ": " + e.detail : "")));
        ul.appendChild(li);
      });
      if (!(f.events || []).length) ul.appendChild(el("li", "vn-note", "Nothing yet."));
      card.appendChild(ul);
      return card;
    }

    // ---- render

    function render() {
      clear(root);
      if (S.detail) {
        body = el("div");
        body.style.display = "grid"; body.style.gap = "16px";
        root.appendChild(body);
        drawDetail(body);
        return;
      }
      drawStrip(root);
      drawTabs(root);
      if (S.banner) root.appendChild(message(S.banner.text, S.banner.tone, S.banner.err));
      body = el("div");
      body.style.display = "grid"; body.style.gap = "14px";
      root.appendChild(body);
      if (S.view === "current") drawFindings("current", body);
      else if (S.view === "history") drawHistory(body);
      else if (S.view === "catalogue") drawCatalogue(body);
      else drawEnv(body);
    }

    // ---- start

    function gate(text, linkText, href) {
      clear(root);
      var box = el("div", "vn-empty");
      box.appendChild(el("b", null, text));
      if (linkText) { var a = el("a", "btn btn-primary", linkText); a.href = href; box.appendChild(a); }
      root.appendChild(box);
    }
    // Your summary and your list are fetched together and the page is drawn as soon as they are in. The catalogue's own
    // status comes after and only fills in one line (it used to hold the whole page back).
    Promise.all([
      api.me().then(function (me) { S.summary = me.summary; }),
      api.environment().then(function (e) { S.env = e; })
    ]).then(function () {
      if (S.env && !S.env.items.length) S.view = "env";
      render();
      api.catalogStatus().then(function (c) {
        S.catalog = c;
        var line = root.querySelector(".vn-catalog");
        if (line) line.textContent = catalogLine();
      }, function () { S.catalog = null; });
    }, function (err) {
      if (err && err.status === 401) gate("Sign in to keep a record of the vulnerabilities that apply to what you run.", "Sign in", "https://api.barnyard.site/auth/login?return_to=" + encodeURIComponent(location.href));
      else if (err && err.status === 403) gate("Your account can't use this page.", null);
      else gate("Couldn't reach the server. Try again in a moment.", null);
    });
  }

  var root = document.getElementById("vn-root");
  if (root) { clear(root); mount(root); }
})();
