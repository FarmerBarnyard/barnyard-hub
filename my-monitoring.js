// "My infrastructure": the Monitoring page for everyone who is not the hub owner (monitoring.html loads this beside monitoring.js,
// which hands over when the signed-in person is not the owner). Each person watches their OWN things: addresses and host:port
// checks the Worker makes every five minutes, and servers that report on themselves with their own keys. Nothing of the owner's
// is read or shown here.
//
// Reads and writes /mon/me/* on the Worker (ClaudeRepo's cloudflare-worker/src/personal-monitor-routes.js):
//   GET  /mon/me/status          probes, servers, recent events, limits, whether email can be sent
//   POST /mon/me/probes          { name, kind: "https" | "tcp", target }   (needs a recent sign-in)
//   POST /mon/me/probes/delete   { id }
//   POST /mon/me/reporters       { label }   a key for one server, in the answer ONCE (needs a recent sign-in)
//   POST /mon/me/reporters/revoke { id }
//   POST /mon/me/settings        { email: true | false }
//   POST /mon/me/check           check my things now (once every 30 seconds)
//   POST /mon/me/erase           remove everything I have here (needs a recent sign-in)
// The owner's page also uses peopleBox() to show who has a space (names and counts only).
//
// Request budget: one read when the page opens, then one a minute only while the page is visible; a busy answer (429, or the
// network failure a Cloudflare rate limit looks like) keeps what is on screen and waits, doubling up to 5 minutes. Everything
// from the server reaches the page through textContent, never innerHTML. The page's CSP has no 'unsafe-inline'.
//
// Layout: 1. pure helpers (exported for test/my-monitoring.test.js)   2. data   3. rendering   4. actions

(function () {
  "use strict";

  var ME = "https://api.barnyard.site/mon/me";
  var KIT = "https://dashboard.barnyard.site/reporter-kit/";
  // What the install steps download, in the order they are fetched. SHA256SUMS lists every other file and is checked first.
  var KIT_FILES = ["install.sh", "barnyard-reporter.sh", "barnyard-reporter.service", "barnyard-reporter.timer", "barnyard-inventory.sh", "barnyard-inventory.service", "barnyard-inventory.timer", "env.example", "SHA256SUMS"];
  var STATUS_MS = 60000, MIN_REFRESH_MS = 10000, CHECK_GAP_MS = 30000;

  // ---- 1. pure helpers ------------------------------------------------------

  function agoText(ts, now) {
    if (!ts) return "not yet";
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function clockText(ms) {
    try { return new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  function dateText(ms) {
    try { return new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }

  // The Worker's short error code in a sentence a person can act on.
  var ERRORS = {
    recent_sign_in_required: "Sign in again to do that: adding and removing things needs a recent sign-in.",
    host_not_allowed: "That address is private or reserved, or it belongs to this site, so it cannot be checked from outside. Use a public address.",
    host_invalid: "That does not look like a public address. Use a name such as www.example.com, or a public IP address.",
    https_only: "Use an https address.",
    port_not_allowed: "That port is not one that can be checked. Websites: 443, 8443, 4443, 9443 or 10443. Other services: the usual ports, such as 22, 3389 or 5432.",
    credentials_not_allowed: "Leave the user name and password out of the address.",
    address_invalid: "That address is not valid. Check it for spaces or odd characters.",
    address_too_long: "That address is too long (150 characters after the site name at most).",
    tcp_needs_port: "Write it as the host, a colon and the port, for example db.example.com:5432.",
    name_invalid: "Give it a short name: letters, numbers, spaces and . _ - ( ) & / +, up to 40 characters.",
    label_invalid: "Give the server a short name: letters, numbers, spaces and . _ - ( ) & / +, up to 40 characters.",
    kind_invalid: "Choose what kind of check it is.",
    too_many_probes: "You already watch 10 things. Remove one first.",
    too_many_keys: "You already have 3 servers. Remove one first.",
    duplicate: "You are already watching that.",
    server_exists: "A server with that name already has a key.",
    rate_limited: "Slow down a little and try again in a moment.",
    spaces_full: "No more people can start their own monitoring right now. Ask the owner.",
    access_restricted: "The owner has switched Monitoring off for you.",
    access_suspended: "Your access has been suspended.",
    access_expired: "Your access has ended.",
    monitor_disabled: "Monitoring for other people is switched off.",
    owner_uses_main_page: "The owner's own monitoring is the main page.",
    unauthenticated: "You are signed out. Log in again.",
    probe_unknown: "That is no longer there.",
    reporter_unknown: "That is no longer there.",
    failed: "That did not work. Try again in a moment."
  };
  function errorText(code) { return ERRORS[code] || ERRORS.failed; }

  var STATUS_WORD = { up: "Up", down: "Down", unknown: "Waiting for the first check" };
  function probeTone(s) { return s === "up" ? "ok" : s === "down" ? "alert" : ""; }
  function serverTone(s) { return s === "ok" ? "ok" : s === "busy" ? "attn" : s === "problem" || s === "silent" || s === "expired" ? "alert" : ""; }
  var SERVER_WORD = { ok: "Reporting", busy: "Busy", problem: "Needs attention", silent: "Gone quiet", waiting: "Waiting for the first report", expired: "Key expired" };

  function probeRow(p, now) {
    // the chip already says up, down or waiting; this line is what it adds
    var bits = [];
    if (p.status !== "unknown" && p.lastCheck) bits.push("checked " + agoText(p.lastCheck, now));
    if (p.status === "up" && p.lastMs !== null && p.lastMs !== undefined) bits.push(Math.round(p.lastMs) + " ms");
    if (p.uptime7 !== null && p.uptime7 !== undefined) bits.push(p.uptime7 + "% up over 7 days");
    if (!bits.length) bits.push("the first check runs within five minutes");
    var why = p.status === "down" && p.detailText ? p.detailText.charAt(0).toUpperCase() + p.detailText.slice(1) + "." : p.detail === "blocked" ? "This address is no longer allowed, so it is not being checked." : "";
    return { name: p.name, label: p.label, kind: p.kind === "tcp" ? "Host and port" : "Website", tone: probeTone(p.status), word: STATUS_WORD[p.status] || "", line: bits.join(" · "), why: why };
  }

  function serverRow(s, now) {
    var bits = [];
    bits.push(s.lastSeen ? "last report " + agoText(s.lastSeen, now) : "no report yet");
    if (s.load && s.load.cores) bits.push("load " + (Math.round((s.load.l1 / s.load.cores) * 10) / 10).toFixed(1) + " per core");
    if (s.mem) bits.push("memory " + Math.round(s.mem.usedPct) + "%");
    var disks = (s.disks || []).map(function (d) { return { mount: d.mount, pct: Math.round(d.usedPct) }; });
    var down = (s.services || []).filter(function (v) { return !v.up; }).map(function (v) { return v.name; });
    return {
      name: s.label, server: s.server, tone: serverTone(s.status), word: SERVER_WORD[s.status] || "", line: bits.join(" · "), disks: disks,
      problems: (s.problems || []).concat((s.warnings || [])), downServices: down, expires: s.expiresAt ? "Key expires " + dateText(s.expiresAt) : "",
      inventory: s.inventoryAt ? "software list " + agoText(s.inventoryAt, now) : "", id: s.id
    };
  }

  // The summary strip: one word for the whole space.
  function overall(st) {
    var sum = st && st.summary ? st.summary : { up: 0, down: 0, unknown: 0 };
    var total = sum.up + sum.down + sum.unknown;
    if (!total) return { tone: "", label: "Nothing watched yet", line: "Add a website or a server below and it is checked from outside every five minutes." };
    if (sum.down) return { tone: "alert", label: sum.down + (sum.down === 1 ? " thing is down" : " things are down"), line: "You are emailed when something has been down for about ten minutes, and when it is back." };
    if (sum.unknown) return { tone: "attn", label: "Waiting for the first checks", line: sum.up + " up so far. The rest have not been checked yet (checks run every five minutes)." };
    return { tone: "ok", label: "Everything is up", line: sum.up + (sum.up === 1 ? " thing" : " things") + " watched." };
  }

  // The same environment file the reporter reads. Only characters a key and a server name can hold are accepted, so nothing in
  // the text can end a quote or start a command.
  var SAFE_SERVER = /^[a-z0-9][a-z0-9-]{0,23}$/, SAFE_KEY = /^mr_[a-f0-9]{12}_[A-Za-z0-9_-]{32}$/;
  function installCommand(server, key) {
    if (!SAFE_SERVER.test(String(server)) || !SAFE_KEY.test(String(key))) return "";
    return [
      "# 1. fetch the reporter and check it is the one this site publishes",
      "mkdir -p ~/barnyard-reporter && cd ~/barnyard-reporter",
      "for f in " + KIT_FILES.join(" ") + "; do curl -fsSO " + KIT + "$f; done",
      "sha256sum -c SHA256SUMS",
      "# 2. install it, give it its settings, and start it",
      "sudo sh install.sh",
      "printf 'BR_SERVER=%s\\nBR_KEY=%s\\nBR_URL=https://api.barnyard.site/mon/report\\nBR_DISKS=\"/\"\\nBR_SERVICES=\"\"\\nBR_PEERS=\"\"\\nBR_INVENTORY_URL=https://api.barnyard.site/mon/inventory\\nBR_INVENTORY=1\\nBR_INVENTORY_DOCKER=0\\n' '" + server + "' '" + key + "' | sudo tee /etc/barnyard-reporter/env >/dev/null",
      "sudo chmod 600 /etc/barnyard-reporter/env",
      "sudo sh install.sh",
      "# 3. check it: the first report arrives within two minutes",
      "systemctl status barnyard-reporter.timer --no-pager | head -5"
    ].join("\n");
  }

  // What the owner sees: the people with a space, never an address.
  function peopleRows(data, now) {
    var list = data && Array.isArray(data.people) ? data.people : [];
    return list.map(function (p) {
      var bits = [p.probes + (p.probes === 1 ? " check" : " checks"), p.reporters + (p.reporters === 1 ? " server" : " servers")];
      if (p.down) bits.push(p.down + " down");
      else if (p.up) bits.push("all up");
      if (p.lastTick) bits.push("checked " + agoText(p.lastTick, now));
      return { space: p.space, name: p.name || "Unnamed", line: bits.join(" · "), tone: p.paused ? "attn" : p.down ? "alert" : p.up ? "ok" : "", word: p.paused ? "Paused" : p.down ? "Down" : p.up ? "Up" : "New" };
    });
  }

  function parseRetryAfter(value, now) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.min(300, n);
    var t = Date.parse(value);
    return Number.isFinite(t) ? Math.min(300, Math.max(0, Math.ceil((t - now) / 1000))) : null;
  }
  function backoffMs(attempt, retryAfterSec) {
    if (retryAfterSec !== null && retryAfterSec !== undefined) return Math.max(1000, retryAfterSec * 1000);
    return Math.min(300000, 15000 * Math.pow(2, Math.max(0, attempt - 1)));
  }
  function pollDue(s) { return !s.hidden && s.state === "ok" && !s.busy && !s.inflight && s.backoffUntil <= s.now && s.now - s.fetchedAt >= STATUS_MS; }

  var helpers = {
    agoText: agoText, errorText: errorText, probeRow: probeRow, serverRow: serverRow, overall: overall, installCommand: installCommand, peopleRows: peopleRows,
    parseRetryAfter: parseRetryAfter, backoffMs: backoffMs, pollDue: pollDue, KIT_FILES: KIT_FILES, KIT: KIT, STATUS_MS: STATUS_MS, CHECK_GAP_MS: CHECK_GAP_MS, MIN_REFRESH_MS: MIN_REFRESH_MS,
    ERRORS: ERRORS, SAFE_SERVER: SAFE_SERVER, SAFE_KEY: SAFE_KEY
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = {
    state: "loading", st: null, flash: null, busy: false, newKey: null, confirmErase: false,
    inflight: false, fetchedAt: 0, attempt: 0, backoffUntil: 0, note: "", lastRefreshAt: 0, checkUntil: 0,
    form: { name: "", kind: "https", target: "", label: "" }
  };
  var pollTimer = null, started = false;

  function getJson(url, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    var opts = { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    for (var k in init) opts[k] = init[k];
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      var header = null;
      try { header = r.headers.get("Retry-After"); } catch (e) { header = null; }
      return r.json().catch(function () { return {}; }).then(function (body) {
        var sec = parseRetryAfter(header, Date.now());
        if (sec === null && body && Number.isFinite(body.retryMs)) sec = Math.ceil(body.retryMs / 1000);
        return { status: r.status, body: body, retryAfter: sec };
      });
    }, function () { clearTimeout(timer); return { status: 0, body: {}, retryAfter: null }; });
  }
  function send(path, body) {
    return getJson(ME + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body === undefined ? {} : body) });
  }

  function snapshot() { return { hidden: document.hidden, state: model.state, busy: model.busy, inflight: model.inflight, backoffUntil: model.backoffUntil, fetchedAt: model.fetchedAt, now: Date.now() }; }

  function fetchStatus(force) {
    if (model.inflight) return Promise.resolve(false);
    if (!force && model.backoffUntil > Date.now()) return Promise.resolve(false);
    model.inflight = true;
    return getJson(ME + "/status", {}).then(function (r) {
      model.inflight = false;
      var ok = applyStatus(r);
      render();
      schedule();
      return ok;
    });
  }

  function applyStatus(r) {
    var now = Date.now();
    if (r.status === 401) { model.state = "guest"; return false; }
    if (r.status === 403) { model.state = r.body && r.body.error === "access_restricted" ? "restricted" : "forbidden"; model.reason = r.body && r.body.error; return false; }
    if (r.status === 200 && r.body && typeof r.body === "object") {
      if (r.body.owner === true) { model.state = "owner"; return false; }
      if (r.body.enabled === false) { model.state = "off"; return false; }
      adopt(r.body);
      return true;
    }
    model.attempt++;
    var wait = backoffMs(model.attempt, r.retryAfter);
    model.backoffUntil = now + wait;
    model.note = "The Worker is busy. It will try again in " + Math.ceil(wait / 1000) + " seconds.";
    model.state = model.st ? "ok" : "error";
    return false;
  }

  function adopt(body) { model.st = body; model.fetchedAt = Date.now(); model.attempt = 0; model.backoffUntil = 0; model.note = ""; model.state = "ok"; }

  function schedule() {
    clearTimeout(pollTimer);
    if (document.hidden || model.state !== "ok") return;
    var wait = Math.max(5000, Math.max(model.fetchedAt + STATUS_MS, model.backoffUntil) - Date.now());
    pollTimer = setTimeout(function () { if (pollDue(snapshot())) fetchStatus(false); else schedule(); }, wait);
  }

  // ---- 3. rendering ---------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function button(text, cls, key) { var b = h("button", cls, text); b.type = "button"; if (key) b.setAttribute("data-fk", key); return b; }
  function box(title, note, cls) {
    var s = h("section", "mo-box" + (cls ? " " + cls : ""));
    var head = h("div", "sec-head");
    head.appendChild(h("h2", null, title));
    if (note) head.appendChild(h("span", "sub", note));
    s.appendChild(head);
    return s;
  }
  function list(cls) { var ul = h("ul", cls || "mo-list"); ul.setAttribute("role", "list"); return ul; }
  function field(label, control) { var l = h("label", "mo-field"); l.appendChild(h("span", "dim", label)); l.appendChild(control); return l; }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }

  function message(text, linkText, href) {
    var root = $("mon-root");
    clear(root);
    root.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; root.appendChild(a); }
  }

  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var el = $("mon-flash");
    if (!el) return;
    clear(el);
    if (!model.flash) { el.hidden = true; return; }
    el.hidden = false;
    el.className = "mo-flash " + (tone || "");
    el.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") { var a = h("a", "btn btn-sm", "Sign in again"); a.href = window.barnyardLoginUrl(); el.appendChild(a); }
  }

  function render() {
    var root = $("mon-root"), tabs = $("mon-tabs");
    if (tabs) tabs.hidden = true;
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see monitoring.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "restricted") { message("The owner has switched Monitoring off for you."); return; }
    if (model.state === "forbidden") { message(errorText(model.reason) === ERRORS.failed ? "You do not have access to Monitoring." : errorText(model.reason)); return; }
    if (model.state === "off") { message("Monitoring for other people is not switched on yet."); return; }
    if (model.state === "owner") { message("This is the owner's account: the main Monitoring page is its own."); return; }
    if (model.state === "error" || !model.st) { message(model.note || "Couldn’t reach the Worker just now. It will try again shortly."); return; }
    var st = model.st, now = Date.now();
    var key = focusKey();
    clear(root);
    var pane = h("div", "mo-pane");
    root.appendChild(pane);
    pane.appendChild(hero(st, now));
    if (model.note) pane.appendChild(h("p", "mo-busy", model.note));
    pane.appendChild(probesBox(st, now));
    pane.appendChild(serversBox(st, now));
    var cols = h("div", "mo-cols");
    cols.appendChild(eventsBox(st, now));
    cols.appendChild(emailBox(st));
    pane.appendChild(cols);
    pane.appendChild(eraseBox());
    restoreFocus(key);
  }

  function focusKey() { var a = document.activeElement; return a && a.getAttribute ? a.getAttribute("data-fk") : null; }
  function restoreFocus(key) {
    if (!key) return;
    var el = document.querySelector('[data-fk="' + key.replace(/"/g, "") + '"]');
    if (el && !el.disabled) el.focus();
  }

  function stat(label, value, tone) { var s = h("div", "mo-stat" + (tone ? " " + tone : "")); s.appendChild(h("b", null, String(value))); s.appendChild(h("span", null, label)); return s; }

  function hero(st, now) {
    var ov = overall(st), sum = st.summary || { up: 0, down: 0, unknown: 0 };
    var sec = h("section", "mo-hero" + (ov.tone ? " " + ov.tone : ""));
    sec.setAttribute("aria-label", "Status summary");
    var lead = h("div", "mo-hero-lead");
    var state = h("div", "mo-hero-state");
    state.appendChild(h("span", "mo-dot" + (ov.tone ? " " + ov.tone : "")));
    state.appendChild(h("b", null, ov.label));
    lead.appendChild(state);
    lead.appendChild(h("p", "mo-hero-line", ov.line));
    sec.appendChild(lead);
    var stats = h("div", "mo-stats");
    stats.appendChild(stat("up", sum.up, sum.up ? "ok" : ""));
    stats.appendChild(stat("down", sum.down, sum.down ? "alert" : ""));
    stats.appendChild(stat("waiting", sum.unknown, sum.unknown ? "attn" : ""));
    sec.appendChild(stats);
    var last = (st.probes || []).reduce(function (a, p) { return Math.max(a, p.lastCheck || 0); }, 0);
    var act = h("div", "mo-hero-act");
    act.appendChild(h("span", "dim", last ? "Last check " + agoText(last, now) : "No check has run yet"));
    var wait = Math.max(0, Math.ceil((model.checkUntil - now) / 1000));
    var ck = button(wait > 0 ? "Check now (" + wait + " s)" : "Check now", "btn btn-sm", "check");
    ck.disabled = model.busy || wait > 0 || !(st.probes || []).length;
    ck.addEventListener("click", checkNow);
    act.appendChild(ck);
    sec.appendChild(act);
    return sec;
  }

  function probesBox(st, now) {
    var sec = box("Websites and services I watch", (st.probes || []).length + " of " + st.limits.probes);
    sec.appendChild(h("p", "dim", "The Worker asks each one from outside every five minutes. It never reads or keeps what a site answers, only whether it answered and how fast."));
    var rows = (st.probes || []).map(function (p) { return { raw: p, row: probeRow(p, now) }; });
    if (!rows.length) sec.appendChild(h("p", "mo-note", "Nothing yet. Add a website address (https only) or a host and port, such as a database or a remote desktop."));
    else {
      var ul = list("mo-rep");
      rows.forEach(function (r) {
        var li = h("li", "mo-rep-row" + (r.row.tone ? " " + r.row.tone : ""));
        var top = h("div", "mo-rep-top");
        top.appendChild(h("b", null, r.row.name));
        top.appendChild(chip(r.row.word, r.row.tone));
        li.appendChild(top);
        li.appendChild(h("p", "dim", r.row.kind + ": " + r.row.label));
        li.appendChild(h("p", null, r.row.line));
        if (r.row.why) li.appendChild(h("p", "mo-why", r.row.why));
        var rm = button("Remove", "btn btn-sm btn-quiet", "rm:" + r.raw.id);
        rm.setAttribute("aria-label", "Remove " + r.row.name);
        rm.disabled = model.busy;
        rm.addEventListener("click", function () { removeProbe(r.raw.id, r.row.name); });
        li.appendChild(rm);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
    }
    var full = (st.probes || []).length >= st.limits.probes;
    var row = h("div", "mo-row");
    var name = h("input", "mo-input"); name.type = "text"; name.maxLength = 40; name.value = model.form.name; name.placeholder = "Shop website"; name.setAttribute("data-fk", "probe-name");
    name.addEventListener("input", function () { model.form.name = name.value; });
    var kind = h("select", "mo-input"); kind.setAttribute("data-fk", "probe-kind");
    [["https", "Website (https)"], ["tcp", "Host and port"]].forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; if (model.form.kind === o[0]) op.selected = true; kind.appendChild(op); });
    kind.addEventListener("change", function () { model.form.kind = kind.value; render(); });
    var target = h("input", "mo-input"); target.type = "text"; target.maxLength = 260; target.value = model.form.target; target.setAttribute("data-fk", "probe-target");
    target.placeholder = model.form.kind === "tcp" ? "db.example.com:5432" : "https://www.example.com/health";
    target.addEventListener("input", function () { model.form.target = target.value; });
    var add = button("Add", "btn btn-sm", "probe-add");
    add.disabled = model.busy || full;
    add.addEventListener("click", addProbe);
    target.addEventListener("keydown", function (e) { if (e.key === "Enter" && !add.disabled) { e.preventDefault(); addProbe(); } });
    row.appendChild(field("Name", name)); row.appendChild(field("Kind", kind)); row.appendChild(field("Address", target)); row.appendChild(add);
    sec.appendChild(row);
    if (full) sec.appendChild(h("p", "mo-note", "That is the most you can watch (" + st.limits.probes + "). Remove one to add another."));
    return sec;
  }

  function copyText(text, input, done) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); return; } } catch (e) { /* fall through */ }
    try { input.select(); done(document.execCommand("copy")); } catch (e2) { done(false); }
  }

  function serversBox(st, now) {
    var sec = box("My servers", (st.servers || []).length + " of " + st.limits.reporters);
    sec.appendChild(h("p", "dim", "A small script on each server reports its disk, memory, load and the services you name, once a minute. It sends nothing else: no file names, no process list."));
    if (model.newKey) {
      var nk = h("div", "mo-newkey");
      nk.appendChild(h("b", null, "Copy these steps now. The key in them is not shown again."));
      nk.appendChild(h("span", "dim", "Run them on " + model.newKey.name + " (a Linux server with systemd and curl), as a user who can use sudo. The first report arrives within two minutes."));
      var kb = h("textarea", "mo-input mo-keybox");
      kb.readOnly = true; kb.rows = 11; kb.value = installCommand(model.newKey.server, model.newKey.key);
      kb.setAttribute("aria-label", "Install steps for " + model.newKey.name + ", with its key");
      kb.addEventListener("focus", function () { kb.select(); });
      nk.appendChild(kb);
      var row = h("div", "mo-row");
      var cp = button("Copy", "btn btn-sm", "key-copy");
      cp.addEventListener("click", function () { copyText(kb.value, kb, function (ok) { flash(ok ? "Copied." : "Could not copy: select the text and copy it yourself.", ok ? "ok" : "alert"); }); });
      var done = button("I have saved it", "btn btn-sm btn-quiet", "key-done");
      done.addEventListener("click", function () { model.newKey = null; render(); });
      row.appendChild(cp); row.appendChild(done);
      nk.appendChild(row);
      sec.appendChild(nk);
    }
    var rows = (st.servers || []).map(function (s) { return serverRow(s, now); });
    if (rows.length) {
      var ul = list("mo-keycards");
      rows.forEach(function (r) {
        var li = h("li", "mo-keycard" + (r.tone ? " " + r.tone : ""));
        var top = h("div", "mo-rep-top");
        top.appendChild(h("b", null, r.name));
        top.appendChild(chip(r.word, r.tone));
        li.appendChild(top);
        li.appendChild(h("p", "dim", "Reports as " + r.server + " · " + r.line));
        if (r.disks.length) {
          var bars = h("div", "mo-bars");
          r.disks.forEach(function (d) {
            var br = h("div", "mo-bar-row");
            br.appendChild(h("span", "dim", "Disk " + d.mount));
            var bar = h("span", "mo-bar" + (d.pct >= 95 ? " alert" : d.pct >= 85 ? " attn" : ""));
            var fill = h("span", "mo-bar-fill"); fill.setAttribute("data-pct", String(d.pct)); fill.style.width = Math.max(0, Math.min(100, d.pct)) + "%";
            bar.appendChild(fill); br.appendChild(bar); br.appendChild(h("span", "mo-bar-n", d.pct + "%"));
            bars.appendChild(br);
          });
          li.appendChild(bars);
        }
        r.problems.forEach(function (t) { li.appendChild(h("p", "mo-why", t.charAt(0).toUpperCase() + t.slice(1) + ".")); });
        var facts = [r.expires, r.inventory].filter(Boolean).join(" · ");
        if (facts) li.appendChild(h("p", "dim", facts));
        var rv = button("Remove", "btn btn-sm btn-quiet", "rv:" + r.id);
        rv.setAttribute("aria-label", "Remove " + r.name + " and its key");
        rv.disabled = model.busy;
        rv.addEventListener("click", function () { revokeKey(r.id, r.name); });
        li.appendChild(rv);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
    } else sec.appendChild(h("p", "mo-note", "No servers yet. Give one a name and make its key; the install steps appear here once."));
    var full = (st.servers || []).length >= st.limits.reporters;
    var frow = h("div", "mo-row");
    var label = h("input", "mo-input"); label.type = "text"; label.maxLength = 40; label.value = model.form.label; label.placeholder = "Web server"; label.setAttribute("data-fk", "key-label");
    label.addEventListener("input", function () { model.form.label = label.value; });
    var mk = button("Make a key", "btn btn-sm", "key-make");
    mk.disabled = model.busy || full;
    mk.addEventListener("click", makeKey);
    label.addEventListener("keydown", function (e) { if (e.key === "Enter" && !mk.disabled) { e.preventDefault(); makeKey(); } });
    frow.appendChild(field("Server name", label)); frow.appendChild(mk);
    sec.appendChild(frow);
    if (full) sec.appendChild(h("p", "mo-note", "That is the most you can have (" + st.limits.reporters + "). Remove one to add another."));
    return sec;
  }

  function eventsBox(st, now) {
    var sec = box("Recent changes", "the last 20");
    var ev = st.events || [];
    if (!ev.length) { sec.appendChild(h("p", "mo-note", "Nothing has gone down yet.")); return sec; }
    var ul = h("ul", "mo-feed");
    ev.forEach(function (e) {
      var li = h("li");
      li.appendChild(h("span", "mo-when", clockText(e.ts)));
      li.appendChild(chip(e.kind === "down" ? "Down" : "Back up", e.kind === "down" ? "alert" : "ok"));
      var body = h("div", "mo-feed-body");
      body.appendChild(h("b", null, e.name));
      if (e.kind === "down" && e.detailText) body.appendChild(h("span", "dim", e.detailText.charAt(0).toUpperCase() + e.detailText.slice(1) + "."));
      li.appendChild(body);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return sec;
  }

  function emailBox(st) {
    var sec = box("Email", "only to the address you signed in with");
    var em = st.space && st.space.email ? st.space.email : { on: true, address: "", ready: false };
    var tone = em.ready && em.on ? "ok" : "attn";
    var line = h("div", "mo-email " + tone);
    if (!em.address) line.appendChild(h("b", null, "No address is known yet."));
    else if (!em.ready) line.appendChild(h("b", null, "Email is not set up on the server yet, so alerts only show on this page."));
    else line.appendChild(h("b", null, em.on ? "Alerts go to " + em.address + "." : "Email is off."));
    line.appendChild(h("span", "dim", "You get one message when something has been down for about ten minutes and one when it is back, at most 20 a day."));
    sec.appendChild(line);
    var lab = h("label", "mo-check");
    var cb = h("input"); cb.type = "checkbox"; cb.checked = em.on; cb.setAttribute("data-fk", "email-on");
    cb.addEventListener("change", function () { setEmail(cb.checked); });
    lab.appendChild(cb); lab.appendChild(h("span", null, "Email me about my things"));
    sec.appendChild(lab);
    return sec;
  }

  function eraseBox() {
    var sec = box("Remove everything", "if you no longer want this");
    if (!model.confirmErase) {
      sec.appendChild(h("p", "dim", "Deletes everything you have here: what you watch, your server keys and your history."));
      var b = button("Remove everything…", "btn btn-sm btn-quiet", "erase");
      b.addEventListener("click", function () { model.confirmErase = true; render(); });
      sec.appendChild(b);
      return sec;
    }
    sec.appendChild(h("p", "mo-why", "This cannot be undone. Servers still using their keys stop being accepted."));
    var row = h("div", "mo-row");
    var yes = button("Yes, remove everything", "btn btn-sm", "erase-yes"); yes.disabled = model.busy; yes.addEventListener("click", erase);
    var no = button("Keep it", "btn btn-sm btn-quiet", "erase-no"); no.addEventListener("click", function () { model.confirmErase = false; render(); });
    row.appendChild(yes); row.appendChild(no);
    sec.appendChild(row);
    return sec;
  }

  // The owner's page: who has a space. Names and counts only. opts.onRemove(space, name) is the owner page's own confirmed action.
  function peopleBox(data, opts) {
    var sec = box("People", (data && data.people ? data.people.length : 0) + " of " + (data && data.max ? data.max : 25) + " with their own Monitoring");
    var rows = peopleRows(data, Date.now());
    var ul = list("mo-list");
    rows.forEach(function (r) {
      var li = h("li");
      li.appendChild(h("b", null, r.name));
      li.appendChild(chip(r.word, r.tone));
      li.appendChild(h("span", "dim", r.line));
      if (opts && typeof opts.onRemove === "function") {
        var rm = button("Remove", "btn btn-sm btn-quiet", "person:" + r.space);
        rm.setAttribute("aria-label", "Remove " + r.name + "'s monitoring");
        rm.addEventListener("click", function () { opts.onRemove(r.space, r.name); });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return sec;
  }

  // ---- 4. actions -----------------------------------------------------------

  function setBusy(on) { model.busy = on; render(); }

  // The answers that carry a fresh status adopt it; the key (only in the answer to "make a key") is never kept in the copy.
  function afterAction(r, okText) {
    setBusy(false);
    if (r.status === 200 && r.body && r.body.ok !== false && !r.body.error) {
      var key = r.body.key, reporter = r.body.reporter;
      delete r.body.key; delete r.body.reporter;
      if (r.body.probes) adopt(r.body);
      render();
      if (okText) flash(okText, "ok");
      return { ok: true, key: key, reporter: reporter };
    }
    if (r.status === 429 || r.status === 0) { flash(r.status === 0 ? "Couldn’t reach the Worker just now. Try again in a moment." : errorText("rate_limited"), "alert"); return { ok: false }; }
    flash(errorText(r.body && r.body.error ? r.body.error : "failed"), "alert");
    return { ok: false };
  }

  function addProbe() {
    if (model.busy) return;
    var f = model.form;
    if (!f.name.trim() || !f.target.trim()) { flash(!f.name.trim() ? errorText("name_invalid") : errorText("address_invalid"), "alert"); return; }
    setBusy(true);
    send("/probes", { name: f.name, kind: f.kind, target: f.target }).then(function (r) {
      var a = afterAction(r, "Added. The first check runs within five minutes.");
      if (a.ok) { model.form.name = ""; model.form.target = ""; render(); }
    });
  }

  function removeProbe(id, name) {
    if (model.busy) return;
    setBusy(true);
    send("/probes/delete", { id: id }).then(function (r) { afterAction(r, name + " removed."); });
  }

  function makeKey() {
    if (model.busy) return;
    var label = model.form.label.trim();
    if (!label) { flash(errorText("label_invalid"), "alert"); return; }
    setBusy(true);
    send("/reporters", { label: label }).then(function (r) {
      var a = afterAction(r, null);
      if (a.ok && a.key && a.reporter) {
        model.newKey = { server: a.reporter.server, name: a.reporter.label, key: a.key };
        model.form.label = "";
        render();
        flash("Key made for " + a.reporter.label + ". Copy the steps now: the key is not shown again.", "ok");
      }
    });
  }

  function revokeKey(id, name) {
    if (model.busy) return;
    setBusy(true);
    send("/reporters/revoke", { id: id }).then(function (r) { afterAction(r, name + " removed. A script still using its key stops being accepted at once."); });
  }

  function setEmail(on) {
    if (model.busy) return;
    setBusy(true);
    send("/settings", { email: !!on }).then(function (r) { afterAction(r, on ? "Email is on." : "Email is off."); });
  }

  function checkNow() {
    if (model.busy) return;
    setBusy(true);
    send("/check", {}).then(function (r) {
      var a = afterAction(r, "Checked.");
      model.checkUntil = Date.now() + CHECK_GAP_MS;
      if (!a.ok) model.checkUntil = Date.now() + (r.retryAfter ? r.retryAfter * 1000 : CHECK_GAP_MS);
      render();
      setTimeout(function () { if (model.state === "ok") render(); }, CHECK_GAP_MS + 200);
    });
  }

  function erase() {
    if (model.busy) return;
    setBusy(true);
    send("/erase", {}).then(function (r) {
      model.confirmErase = false;
      if (r.status === 200 && r.body && r.body.erased) { model.newKey = null; setBusy(false); fetchStatus(true).then(function () { flash("Everything you had here is gone.", "ok"); }); }
      else afterAction(r, null);
    });
  }

  function refresh() {
    var now = Date.now();
    if (model.inflight || now - model.lastRefreshAt < MIN_REFRESH_MS) return;
    model.lastRefreshAt = now;
    model.backoffUntil = 0;
    fetchStatus(true);
  }

  function start() {
    if (started) return;
    started = true;
    var stamp = $("mon-stamp");
    if (stamp) stamp.textContent = "";
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { clearTimeout(pollTimer); return; }
      if (pollDue(snapshot())) fetchStatus(false); else schedule();
    });
    fetchStatus(true);
  }

  window.BarnyardMyMonitoring = { start: start, refresh: refresh, peopleBox: peopleBox, helpers: helpers };
})();
