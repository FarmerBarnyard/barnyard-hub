// The Monitoring page (monitoring.html): whether the servers and sites are up, who is emailed when one is not, and
// where to look to fix it. The owner's page, like the System health page.
//
// Reads and writes /mon/* on the Worker (ClaudeRepo's cloudflare-worker/src/monitor-routes.js, owner only):
//   GET  /mon/status      every monitor's state, the settings, whether email can go out, the last sends
//   PUT  /mon/settings    recipients (up to 3), business hours, which monitors email (needs a recent sign-in)
//   POST /mon/test-email  a test message to the saved recipients (needs a recent sign-in, once a minute)
//   POST /mon/check       run every check now (once every 30 seconds)
// and, to fill the Security block, GET /hub/status (the daily check, what is about to expire) and GET /vuln/summary
// (open findings by priority). Both are optional: if one fails its block says so and the rest still shows.
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout of this file: 1. pure helpers (exported for test/monitoring.test.js; no DOM, no network)
//                      2. data   3. rendering   4. actions

(function () {
  "use strict";

  var MON = "https://api.barnyard.site/mon";
  var POLL_MS = 60000;

  // ---- 1. pure helpers ------------------------------------------------------

  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  var ZONES = ["Australia/Perth", "Australia/Adelaide", "Australia/Darwin", "Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Australia/Hobart", "Pacific/Auckland", "Europe/London", "UTC"];
  var ADDRESS = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{3,190}$/;
  var MAX_RECIPIENTS = 3;

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

  // "Tue 27 Oct 14:42" in the given time zone (the owner's working-hours zone).
  function clockText(ms, tz) {
    try {
      var parts = new Intl.DateTimeFormat("en-AU", { timeZone: tz || "Australia/Perth", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
      return get("weekday") + " " + get("day") + " " + get("month") + " " + get("hour") + ":" + get("minute");
    } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  // Why a check came back the way it did, in words.
  function detailText(detail) {
    if (!detail) return "";
    if (detail === "not_configured") return "The Worker has no address for it yet.";
    if (detail === "access_denied") return "The Cloudflare gate refused the Worker, so it cannot tell. Check the Access service token.";
    if (detail === "timeout") return "It did not answer within 8 seconds.";
    if (detail === "unreachable") return "The Worker could not connect to it.";
    if (detail === "bad_answer") return "It sent an answer that makes no sense.";
    var http = /^http_(\d{3})$/.exec(detail);
    if (http) {
      var code = Number(http[1]);
      if (code === 530 || code === 502 || (code >= 520 && code <= 526)) return "Cloudflare could not reach it (error " + code + "): the tunnel or the machine behind it is probably down.";
      return "It answered with a server error (" + code + ").";
    }
    var other = /^unexpected_(\d{3})$/.exec(detail);
    if (other) return "It answered " + other[1] + ", which is not what a healthy one says.";
    return "";
  }

  // Where to go to fix each one. Only pages that exist; the rest is plain advice.
  var FIX = {
    app02: { text: "Look at the render service and runners on the System health page", href: "health.html" },
    cld01: { text: "See the CVE catalogue on the Vulnerabilities tab", href: "vulnerabilities.html" },
    vtt: { text: "Check the VTT server and its sign-in key on the Ops board", href: "ops.html" },
    "site-dashboard": { text: "GitHub Pages status", href: "https://www.githubstatus.com/" },
    "site-study": { text: "GitHub Pages status", href: "https://www.githubstatus.com/" },
    "site-campaign": { text: "GitHub Pages status", href: "https://www.githubstatus.com/" },
    "site-stocks": { text: "GitHub Pages status", href: "https://www.githubstatus.com/" }
  };

  // One tile: { id, name, group, tone, label, line, detail, alert, fix }.
  function tileModel(m, now) {
    var tone = "", label = "Not checked yet", line = "The first check runs within 5 minutes.";
    if (m.status === "up") {
      tone = "ok"; label = "Up";
      line = (m.since ? "Up for " + durationText(now - m.since) + ". " : "") + "Checked " + agoText(m.lastCheck, now) + (m.lastMs ? ", answered in " + m.lastMs + " ms" : "") + ".";
    } else if (m.status === "down") {
      tone = "alert"; label = "Down";
      line = (m.downSince ? "Down since " + clockText(m.downSince) + " (" + durationText(now - m.downSince) + "). " : "") + "Checked " + agoText(m.lastCheck, now) + ".";
    } else if (m.lastCheck) {
      tone = "attn"; label = "Can't tell";
      line = "Checked " + agoText(m.lastCheck, now) + ". Nothing is wrong that the Worker can see, but it cannot confirm the state either.";
    }
    return { id: m.id, name: m.name, group: m.group, tone: tone, label: label, line: line, detail: m.status === "up" ? "" : detailText(m.detail), alert: !!m.alert, fix: FIX[m.id] || null };
  }

  // The strip at the top: { tone, headline, detail }.
  function summarise(monitors, now) {
    var list = Array.isArray(monitors) ? monitors : [];
    var down = list.filter(function (m) { return m.status === "down"; });
    var unknown = list.filter(function (m) { return m.status === "unknown" && m.lastCheck; });
    var fresh = list.filter(function (m) { return !m.lastCheck; });
    if (!list.length) return { tone: "", headline: "Nothing is being watched yet", detail: "" };
    if (down.length) {
      var names = down.map(function (m) { return m.name; });
      var oldest = down.reduce(function (a, m) { return m.downSince && (!a || m.downSince < a) ? m.downSince : a; }, 0);
      return { tone: "alert", headline: down.length === 1 ? names[0] + " is down" : down.length + " things are down", detail: (down.length > 1 ? names.join(", ") + ". " : "") + (oldest ? "The longest outage began " + durationText(now - oldest) + " ago." : "") };
    }
    if (fresh.length === list.length) return { tone: "", headline: "Waiting for the first checks", detail: "They run every 5 minutes." };
    if (unknown.length) return { tone: "attn", headline: "Everything that can be checked is up", detail: unknown.length + (unknown.length === 1 ? " thing" : " things") + " could not be confirmed (" + unknown.map(function (m) { return m.name; }).join(", ") + ")." };
    return { tone: "ok", headline: "All good", detail: list.length + " things checked, all up." };
  }

  // What the status says about email: { tone, text, hint }.
  function emailStatus(status) {
    var e = status && status.email;
    var s = status && status.settings;
    var n = s && s.recipients ? s.recipients.length : 0;
    if (e && e.ready) {
      var hours = s.businessHours && s.businessHours.enabled ? "Alerts go out in working hours (" + hoursText(s.businessHours) + "); anything that happens outside them is held and sent in one email at the start of the next working period." : "Alerts go out at any hour.";
      return { tone: "ok", text: "Email is set up and goes to " + n + (n === 1 ? " address." : " addresses."), hint: hours };
    }
    var why = e && e.blocked;
    if (why === "no_sender_address") return { tone: "attn", text: "No email will be sent: there is no sender address.", hint: "Add the Worker secret MON_MAIL_FROM (the monitoring mailbox) in Cloudflare: Workers, barnyard-live-prices, Settings, Variables and Secrets." };
    if (why === "mail_not_configured") return { tone: "attn", text: "No email will be sent: the mail sender is not set up.", hint: "One of the secrets M365_MAIL_TENANT, M365_MAIL_CLIENT_ID or M365_MAIL_CLIENT_SECRET is missing or wrong, or MON_MAIL_FROM is not an email address." };
    if (why === "no_recipients") return { tone: "attn", text: "No email will be sent: nobody is set to receive alerts.", hint: "Add your address under Who is emailed." };
    return { tone: "", text: "Email status is not known.", hint: "" };
  }

  // A failed test email or send, in words. `r` is the Worker's answer { error, detail?, status?, retryMs? }.
  function mailErrorText(r) {
    var err = r && r.error, detail = r && r.detail;
    if (err === "recent_sign_in_required") return "For safety this needs a recent sign-in. Sign in again, then repeat it.";
    if (err === "rate_limited") return "Too soon: wait " + Math.max(1, Math.ceil((r.retryMs || 60000) / 1000)) + " seconds and try again.";
    if (err === "monitor_disabled") return "Monitoring is switched off (the Worker variable MONITOR_ENABLED is 0).";
    if (err === "no_sender_address") return "There is no sender address: add the Worker secret MON_MAIL_FROM.";
    if (err === "mail_not_configured") return "The mail sender is not set up: check the M365_MAIL secrets and MON_MAIL_FROM.";
    if (err === "no_recipients") return "Nobody is set to receive alerts yet. Add your address first.";
    if (err === "forbidden") return "Microsoft refused: the app is not allowed to send as that mailbox. Check the Exchange scope for the monitoring mailbox.";
    if (err === "auth") return "Microsoft refused the app's sign-in. The client secret may have expired or be wrong.";
    if (err === "throttled") return "Microsoft is slowing requests down. Wait a few minutes and try again.";
    if (err === "unavailable") return "Microsoft did not answer. Try again in a few minutes.";
    if (err === "bad_request") {
      if (detail === "ErrorInvalidUser" || detail === "ResourceNotFound" || (r && r.status === 404)) return "The sender mailbox was not found. Check the MON_MAIL_FROM secret is exactly the monitoring mailbox address (and that a new mailbox has had time to appear, up to a couple of hours).";
      if (detail === "MailboxNotEnabledForRESTAPI") return "That mailbox is not ready for sending yet. A new mailbox can take a while; try again later.";
      if (detail === "ErrorInvalidRecipients") return "Microsoft did not accept one of the recipient addresses. Check the addresses below.";
      return "Microsoft refused the message" + (detail ? " (" + detail + ")" : "") + ". Check the sender mailbox and the recipient addresses.";
    }
    if (err === "settings_invalid" || err === "recipient_invalid" || err === "recipients_invalid") return "One of those addresses is not valid.";
    if (err === "too_many_recipients") return "At most " + MAX_RECIPIENTS + " addresses.";
    if (err === "time_invalid") return "The start must be earlier than the end, written like 08:00.";
    if (err === "days_invalid") return "Pick at least one working day.";
    if (err === "timezone_invalid") return "That time zone is not one I know.";
    if (err === "unauthenticated") return "You are signed out. Log in again.";
    return "That did not work" + (err ? " (" + err + ")" : "") + ".";
  }

  // "Mon-Fri 08:00-17:00 Australia/Perth", "Every day ...", "Mon, Wed 09:00-12:00 ...".
  function hoursText(bh) {
    if (!bh || !bh.enabled) return "any time";
    var days = (bh.days || []).slice().sort(function (a, b) { return DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b); });
    var label;
    if (days.length === 7) label = "every day";
    else if (days.join(",") === "1,2,3,4,5") label = "Mon-Fri";
    else label = days.map(function (d) { return DAY_NAMES[d]; }).join(", ");
    return label + " " + bh.start + "-" + bh.end + " " + bh.tz;
  }

  function validateAddress(text) {
    var a = String(text || "").trim().toLowerCase();
    if (!a || a.length > 254 || !ADDRESS.test(a)) return { ok: false, error: "That does not look like an email address." };
    return { ok: true, address: a };
  }

  // Adding or removing one address from the saved list -> { ok, list } | { ok: false, error }.
  function addRecipient(list, text) {
    var v = validateAddress(text);
    if (!v.ok) return v;
    var cur = Array.isArray(list) ? list.slice() : [];
    if (cur.indexOf(v.address) !== -1) return { ok: false, error: "That address is already on the list." };
    if (cur.length >= MAX_RECIPIENTS) return { ok: false, error: "At most " + MAX_RECIPIENTS + " addresses." };
    cur.push(v.address);
    return { ok: true, list: cur };
  }
  function removeRecipient(list, address) { return (Array.isArray(list) ? list : []).filter(function (a) { return a !== address; }); }

  // The hours form -> the body for PUT /mon/settings, or { error }.
  function hoursBody(form) {
    var days = (form.days || []).map(Number).filter(function (d) { return d >= 0 && d <= 6; });
    if (form.enabled && !days.length) return { error: "days_invalid" };
    var time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!time.test(form.start || "") || !time.test(form.end || "") || form.start >= form.end) return { error: "time_invalid" };
    return { businessHours: { enabled: !!form.enabled, tz: form.tz, days: days.length ? days : [1, 2, 3, 4, 5], start: form.start, end: form.end } };
  }

  // The history list: newest first. result "sent" is good; anything else is a failure word.
  function historyRows(history, tz) {
    return (Array.isArray(history) ? history : []).map(function (h) {
      var ok = h.result === "sent";
      return {
        when: clockText(h.ts, tz), kind: h.kind === "test" ? "Test" : "Alert", subject: h.subject || "", ok: ok,
        result: ok ? "Sent to " + h.recipients + (h.recipients === 1 ? " address" : " addresses") : "Failed (" + h.result + ")"
      };
    });
  }

  // The vulnerability block: P1 and P2 counts and whether anything needs a look.
  function securityRows(summary, hub, now) {
    var rows = [];
    if (summary && summary.ok) {
      var bp = summary.byPriority || {};
      rows.push({ title: "Open P1 findings", tone: (bp.P1 || 0) > 0 ? "alert" : "ok", value: String(bp.P1 || 0), note: "Critical or known to be exploited, on software you run." });
      rows.push({ title: "Open P2 findings", tone: (bp.P2 || 0) > 0 ? "attn" : "ok", value: String(bp.P2 || 0), note: summary.needsLook ? summary.needsLook + " still need a look." : "" });
    } else rows.push({ title: "Vulnerabilities", tone: "", value: "?", note: "Could not be read just now." });
    if (hub && hub.ok && hub.check) {
      if (hub.check.known) rows.push({ title: "Daily security check", tone: hub.check.ok ? "ok" : "attn", value: hub.check.ok ? "OK" : "Look", note: (hub.check.said || "") + (hub.check.lastAt ? " (" + agoText(hub.check.lastAt, now) + ")" : "") });
      else rows.push({ title: "Daily security check", tone: "", value: "?", note: "It has not reported yet." });
    }
    return rows;
  }

  function expiryRows(hub) {
    var list = hub && hub.ok && Array.isArray(hub.expiries) ? hub.expiries.slice(0, 3) : [];
    return list.map(function (e) {
      var left = e.daysLeft;
      return { label: e.label, tone: left < 0 ? "alert" : left <= 30 ? "attn" : "", text: left < 0 ? "was due " + (-left) + " days ago" : left === 0 ? "due today" : "in " + left + (left === 1 ? " day" : " days") };
    });
  }

  var helpers = {
    agoText: agoText, durationText: durationText, clockText: clockText, detailText: detailText, tileModel: tileModel, summarise: summarise,
    emailStatus: emailStatus, mailErrorText: mailErrorText, hoursText: hoursText, validateAddress: validateAddress, addRecipient: addRecipient,
    removeRecipient: removeRecipient, hoursBody: hoursBody, historyRows: historyRows, securityRows: securityRows, expiryRows: expiryRows,
    ZONES: ZONES, DAY_NAMES: DAY_NAMES, DAY_ORDER: DAY_ORDER, MAX_RECIPIENTS: MAX_RECIPIENTS
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", mon: null, hub: null, vuln: null, flash: null, busy: false };

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

  function load() {
    return Promise.all([
      getJson(MON + "/status", {}),
      getJson("https://api.barnyard.site/hub/status", {}),
      getJson("https://api.barnyard.site/vuln/summary", {})
    ]).then(function (res) {
      var mon = res[0];
      if (mon.status === 401) { model.state = "guest"; return; }
      if (mon.status === 403) { model.state = "forbidden"; return; }
      if (mon.status === 0 || mon.status >= 500 || !mon.body) { model.state = model.mon ? "ok" : "error"; return; }
      model.mon = mon.body;
      model.hub = res[1].status === 200 ? res[1].body : null;
      model.vuln = res[2].status === 200 ? res[2].body : null;
      model.state = "ok";
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

  function message(text, linkText, href) {
    var box = $("mon-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function section(title, note, id) {
    var s = h("section", "mo-section");
    if (id) s.id = id;
    var head = h("div", "sec-head");
    head.appendChild(h("h2", null, title));
    if (note) head.appendChild(h("span", "sub", note));
    s.appendChild(head);
    return s;
  }

  function tileGrid(tiles) {
    var grid = h("ul", "mo-tiles");
    grid.setAttribute("role", "list");
    tiles.forEach(function (t) {
      var li = h("li", "mo-tile" + (t.tone ? " " + t.tone : ""));
      var top = h("div", "mo-tile-top");
      top.appendChild(h("b", null, t.name));
      top.appendChild(h("span", "chip" + (t.tone ? " " + t.tone : ""), t.label));
      li.appendChild(top);
      li.appendChild(h("p", "dim", t.line));
      if (t.detail) li.appendChild(h("p", "mo-why", t.detail));
      var foot = h("div", "mo-tile-foot");
      if (t.fix) {
        var a = h("a", "sub", t.fix.text);
        a.href = t.fix.href;
        if (/^https?:/.test(t.fix.href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
        foot.appendChild(a);
      }
      li.appendChild(foot);
      grid.appendChild(li);
    });
    return grid;
  }

  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var box = $("mon-flash");
    if (!box) return;
    clear(box);
    if (!model.flash) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "mo-flash " + (tone || "");
    box.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") {
      var a = h("a", "btn btn-sm", "Sign in again");
      a.href = window.barnyardLoginUrl();
      box.appendChild(a);
    }
  }

  function field(label, control) {
    var l = h("label", "mo-field");
    l.appendChild(h("span", "dim", label));
    l.appendChild(control);
    return l;
  }

  function render() {
    var root = $("mon-root");
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see monitoring.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error" || !model.mon) { message("Couldn’t reach the Worker just now. It will try again shortly."); return; }
    var st = model.mon, now = Date.now();
    clear(root);

    var box = h("div", "mo-flash");
    box.id = "mon-flash"; box.hidden = true; box.setAttribute("role", "status");
    root.appendChild(box);

    if (st.enabled === false) {
      root.appendChild(h("p", "mo-off", "Monitoring is switched off. The Worker variable MONITOR_ENABLED is 0; remove it (or set it to 1) in Cloudflare to switch it back on."));
      return;
    }
    var tz = (st.settings && st.settings.businessHours && st.settings.businessHours.tz) || "Australia/Perth";

    // the strip
    var sum = summarise(st.monitors, now);
    var strip = h("div", "mo-strip" + (sum.tone ? " " + sum.tone : ""));
    strip.appendChild(h("b", null, sum.headline));
    if (sum.detail) strip.appendChild(h("span", "dim", sum.detail));
    root.appendChild(strip);

    // servers and sites
    var tiles = (st.monitors || []).map(function (m) { return tileModel(m, now); });
    var sv = section("Servers", "checked every 5 minutes from the Worker");
    sv.appendChild(tileGrid(tiles.filter(function (t) { return t.group === "servers"; })));
    root.appendChild(sv);
    var si = section("Sites", "shown here; no email by default");
    si.appendChild(tileGrid(tiles.filter(function (t) { return t.group === "sites"; })));
    root.appendChild(si);

    // security
    var sec = section("Security", "from the vulnerability register and the daily check");
    var secRows = securityRows(model.vuln, model.hub, now);
    var secList = h("ul", "mo-list");
    secList.setAttribute("role", "list");
    secRows.forEach(function (r) {
      var li = h("li");
      li.appendChild(h("span", "chip" + (r.tone ? " " + r.tone : ""), r.value));
      li.appendChild(h("b", null, r.title));
      if (r.note) li.appendChild(h("span", "dim", r.note));
      secList.appendChild(li);
    });
    sec.appendChild(secList);
    var ex = expiryRows(model.hub);
    if (ex.length) {
      sec.appendChild(h("h3", "mo-sub", "Next to expire"));
      var el = h("ul", "mo-list");
      el.setAttribute("role", "list");
      ex.forEach(function (e) {
        var li = h("li");
        li.appendChild(h("span", "chip" + (e.tone ? " " + e.tone : ""), e.text));
        li.appendChild(h("b", null, e.label));
        el.appendChild(li);
      });
      sec.appendChild(el);
    }
    var links = h("p", "mo-links");
    var a1 = h("a", "sub", "Open the Vulnerabilities tab"); a1.href = "vulnerabilities.html"; links.appendChild(a1);
    sec.appendChild(links);
    root.appendChild(sec);

    // the other monitors
    var other = section("Other places to look", "already built, linked here");
    var ol = h("ul", "mo-list");
    ol.setAttribute("role", "list");
    [["Overview status row", "index.html", "Chat runner, campaign engine, daily check and expiries at a glance."],
     ["System health", "health.html", "The render service, the map cache and the Worker’s request counts."],
     ["Activity feed", "activity.html", "What changed on the Ops board and when."],
     ["The bell", "", "At the top of every page: proposals waiting, expiries within two weeks, failed checks."]].forEach(function (x) {
      var li = h("li");
      if (x[1]) { var a = h("a", null, x[0]); a.href = x[1]; li.appendChild(a); } else li.appendChild(h("b", null, x[0]));
      li.appendChild(h("span", "dim", x[2]));
      ol.appendChild(li);
    });
    other.appendChild(ol);
    root.appendChild(other);

    root.appendChild(alertsPanel(st, tz, now));

    var stamp = $("mon-stamp");
    if (stamp) stamp.textContent = "Updated " + new Date().toLocaleTimeString();
    if (model.flash) flash(model.flash.text, model.flash.tone);
  }

  function alertsPanel(st, tz, now) {
    var s = st.settings;
    var al = section("Alerts", "who is emailed, and when");

    var es = emailStatus(st);
    var line = h("div", "mo-email " + es.tone);
    line.appendChild(h("b", null, es.text));
    if (es.hint) line.appendChild(h("span", "dim", es.hint));
    al.appendChild(line);
    al.appendChild(h("p", "dim", "An email needs the internet and Microsoft 365 to be working. If one of them is what is down, no email can reach you, so look at this page if something feels wrong."));
    if (st.pending) al.appendChild(h("p", "mo-note", st.pending + (st.pending === 1 ? " alert is" : " alerts are") + " waiting to be sent" + (st.inHours ? "." : " until working hours start.")));
    if (st.lastSend && st.lastSend.ok === false) al.appendChild(h("p", "mo-note", "The last send failed (" + st.lastSend.reason + ") " + agoText(st.lastSend.at, now) + "; it is tried again every 5 minutes."));

    // recipients
    al.appendChild(h("h3", "mo-sub", "Who is emailed"));
    var rl = h("ul", "mo-list");
    rl.setAttribute("role", "list");
    if (!s.recipients.length) rl.appendChild(h("li", "dim", "Nobody yet."));
    s.recipients.forEach(function (addr) {
      var li = h("li");
      li.appendChild(h("b", null, addr));
      var rm = h("button", "btn btn-sm btn-quiet", "Remove");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove " + addr);
      rm.addEventListener("click", function () { saveSettings({ recipients: removeRecipient(s.recipients, addr) }, "Removed."); });
      li.appendChild(rm);
      rl.appendChild(li);
    });
    al.appendChild(rl);
    if (s.recipients.length < MAX_RECIPIENTS) {
      var form = h("form", "mo-row");
      form.setAttribute("novalidate", "novalidate");
      var inp = h("input", "mo-input");
      inp.type = "email"; inp.autocomplete = "email"; inp.placeholder = "you@example.com"; inp.maxLength = 254;
      inp.setAttribute("aria-label", "Email address to add");
      var add = h("button", "btn btn-sm", "Add address");
      add.type = "submit";
      form.appendChild(inp); form.appendChild(add);
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var r = addRecipient(s.recipients, inp.value);
        if (!r.ok) { flash(r.error, "alert"); return; }
        saveSettings({ recipients: r.list }, "Added " + r.list[r.list.length - 1] + ".");
      });
      al.appendChild(form);
    }

    // hours
    al.appendChild(h("h3", "mo-sub", "When you are emailed"));
    var bh = s.businessHours;
    var hf = h("form", "mo-hours");
    hf.setAttribute("novalidate", "novalidate");
    var onWrap = h("label", "mo-check");
    var on = h("input"); on.type = "checkbox"; on.checked = !!bh.enabled;
    onWrap.appendChild(on); onWrap.appendChild(h("span", null, "Only in working hours (anything outside them waits for the next morning)"));
    hf.appendChild(onWrap);
    var days = h("div", "mo-days");
    days.setAttribute("role", "group"); days.setAttribute("aria-label", "Working days");
    var dayBoxes = {};
    DAY_ORDER.forEach(function (d) {
      var l = h("label", "mo-check mo-day");
      var c = h("input"); c.type = "checkbox"; c.checked = bh.days.indexOf(d) !== -1; dayBoxes[d] = c;
      l.appendChild(c); l.appendChild(h("span", null, DAY_NAMES[d]));
      days.appendChild(l);
    });
    hf.appendChild(days);
    var times = h("div", "mo-row");
    var from = h("input", "mo-input"); from.type = "time"; from.value = bh.start; from.required = true;
    var to = h("input", "mo-input"); to.type = "time"; to.value = bh.end; to.required = true;
    var zone = h("select", "mo-input");
    var zones = ZONES.indexOf(bh.tz) === -1 ? [bh.tz].concat(ZONES) : ZONES;
    zones.forEach(function (z) { var o = h("option", null, z); o.value = z; if (z === bh.tz) o.selected = true; zone.appendChild(o); });
    times.appendChild(field("From", from)); times.appendChild(field("To", to)); times.appendChild(field("Time zone", zone));
    hf.appendChild(times);
    var save = h("button", "btn btn-sm", "Save hours");
    save.type = "submit";
    hf.appendChild(save);
    hf.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var body = hoursBody({ enabled: on.checked, days: DAY_ORDER.filter(function (d) { return dayBoxes[d].checked; }), start: from.value, end: to.value, tz: zone.value });
      if (body.error) { flash(mailErrorText({ error: body.error }), "alert"); return; }
      saveSettings(body, "Hours saved.");
    });
    al.appendChild(hf);

    // per-monitor switches
    al.appendChild(h("h3", "mo-sub", "Email me when this goes down"));
    var ml = h("ul", "mo-list");
    ml.setAttribute("role", "list");
    st.monitors.forEach(function (m) {
      var li = h("li");
      var l = h("label", "mo-check");
      var c = h("input"); c.type = "checkbox"; c.checked = !!m.alert;
      c.addEventListener("change", function () {
        var body = { monitors: {} }; body.monitors[m.id] = { alert: c.checked };
        saveSettings(body, c.checked ? "You will be emailed if " + m.name + " goes down." : "No email for " + m.name + ".");
      });
      l.appendChild(c); l.appendChild(h("span", null, m.name));
      li.appendChild(l);
      ml.appendChild(li);
    });
    al.appendChild(ml);

    // test and history
    var tools = h("div", "mo-row");
    var test = h("button", "btn btn-sm", "Send test email");
    test.type = "button"; test.id = "mon-test";
    test.addEventListener("click", sendTest);
    tools.appendChild(test);
    al.appendChild(tools);

    al.appendChild(h("h3", "mo-sub", "What was sent"));
    var rows = historyRows(st.history, tz);
    if (!rows.length) al.appendChild(h("p", "dim", "Nothing yet."));
    else {
      var hl = h("ul", "mo-list");
      hl.setAttribute("role", "list");
      rows.forEach(function (r) {
        var li = h("li");
        li.appendChild(h("span", "dim", r.when));
        li.appendChild(h("span", "chip" + (r.ok ? " ok" : " alert"), r.kind));
        li.appendChild(h("b", null, r.subject));
        li.appendChild(h("span", "dim", r.result));
        hl.appendChild(li);
      });
      al.appendChild(hl);
    }
    return al;
  }

  // ---- 4. actions -----------------------------------------------------------

  function setBusy(on) {
    model.busy = on;
    ["mon-check", "mon-test", "mon-refresh"].forEach(function (id) { var b = $(id); if (b) b.disabled = on; });
  }

  function send(method, path, body) {
    var init = { method: method };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return getJson(MON + path, init);
  }

  function saveSettings(body, okText) {
    if (model.busy) return;
    setBusy(true);
    send("PUT", "/settings", body).then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { model.mon = r.body; render(); flash(okText, "ok"); }
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: r.status ? "failed" : "offline" }), "alert");
    });
  }

  function sendTest() {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/test-email").then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { flash("Test email sent to " + r.body.sent + (r.body.sent === 1 ? " address." : " addresses.") + " It should arrive within a minute.", "ok"); load(); return; }
      flash(mailErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
      load();
    });
  }

  function checkNow() {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/check").then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { model.mon = r.body; render(); flash("Checked just now.", "ok"); }
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  function boot() {
    var rf = $("mon-refresh"), ck = $("mon-check");
    if (rf) rf.addEventListener("click", function () { load(); });
    if (ck) ck.addEventListener("click", checkNow);
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load();
      setInterval(function () { if (!document.hidden && model.state === "ok" && !model.busy) load(); }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardMonitoring = helpers;
})();
