// The Monitoring page (monitoring.html): whether the servers and sites are up, who is emailed when one is not, and
// where to look to fix it. The owner's page, like the System health page.
//
// Reads and writes /mon/* on the Worker (ClaudeRepo's cloudflare-worker/src/monitor-routes.js, owner only):
//   GET  /mon/status      every monitor's state, the settings, whether email can go out, the last sends
//   PUT  /mon/settings    recipients (up to 3), business hours, which monitors email (needs a recent sign-in)
//   POST /mon/test-email  a test message to the saved recipients (needs a recent sign-in, once a minute)
//   POST /mon/check       run every check now (once every 30 seconds)
//   POST /mon/test-push   a test push to the phone (ntfy; needs a recent sign-in, once a minute)
//   POST /mon/test-digest the weekly digest email to the saved recipients now (needs a recent sign-in, once a minute)
//   POST /mon/acknowledge { monitor } stops an outage's reminders until it recovers ({ monitor, undo: true } takes it back)
// and, to fill the Security block, GET /hub/status (the daily check, what is about to expire), GET /vuln/summary
// (open findings by priority) and GET /incidents/summary (the open-incident count). All three are optional: if one
// fails its block says so and the rest still shows.
//
// Tabs, chosen by the URL hash (#dashboard, #services, #incidents, #reports, #release, #settings): the Dashboard (a status
// strip, a card per monitor with its 7-day uptime and a 14-day sparkline, recent alerts, the servers' reporters, security and
// renewals), Settings (every control: recipients, working hours, switches, phone alerts, reporter keys, the test buttons), and,
// for the hub owner only, the Services, Incidents, Reports and Release board pages that used to be separate. Each of those four
// is its own script (services.js, incidents.js, reports.js, release.js + release-logic.js), loaded the first time its tab is
// opened: it draws into its own panel in monitoring.html, is started when the tab is shown and stopped when another is chosen,
// so a closed tab reads and polls nothing. An open incident is #incidents/<id>.
//
// Request budget (the owner hit Cloudflare's rate limit on /mon/ with the old page, which asked for three things every
// minute and again after every button): the Dashboard reads /mon/status once when it opens and then once a minute, only
// while the page is visible and the Dashboard tab is open (it reads again at once when the tab becomes visible if the last
// answer is over a minute old); Settings does not poll and reads only if the last answer is over 30 seconds old; the
// security block is read at most every 10 minutes and the incident count every 5; the three test buttons do not read the
// status again; Check now counts down the Worker's 30-second limit; a busy answer (429, or the network failure a Cloudflare
// rate limit looks like to a page) keeps the last answer on screen and waits, doubling up to 5 minutes or obeying Retry-After.
//
// Everything from the server reaches the page through textContent, never innerHTML. The page's CSP has no
// 'unsafe-inline' for scripts or styles.
//
// Layout of this file: 1. pure helpers (exported for test/monitoring.test.js; no DOM, no network)
//                      2. data   3. rendering   4. actions

(function () {
  "use strict";

  var MON = "https://api.barnyard.site/mon";

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
    return { id: m.id, name: m.name, group: m.group, tone: tone, label: label, line: line, detail: m.status === "up" ? "" : detailText(m.detail), alert: !!m.alert, fix: FIX[m.id] || null, ack: ackModel(m, now) };
  }

  // What the Acknowledge control says for a monitor (or a report alert) that is down: null when it is not down or not one that
  // emails (there are no reminders to stop). { acked, text } where acked is true once acknowledged.
  function ackModel(m, now) {
    if (!m || m.status !== "down" || m.alert === false) return null;
    if (m.ack && m.ack.at) return { acked: true, text: "Acknowledged " + agoText(m.ack.at, now) + (m.ack.via === "push" ? " from the phone" : "") + ": no reminders until it is back up." };
    return { acked: false, text: "" };
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

  // The phone push line: { tone, text, hint }. `status.push` is { ready, blocked } and the settings hold push.{enabled, when, types}.
  function pushStatus(status) {
    var p = status && status.push, s = status && status.settings && status.settings.push;
    if (!p || p.ready === false) {
      var why = p && p.blocked;
      var set = "Install the ntfy app on your phone, subscribe to a long random topic, then add the Worker secret NTFY_TOPIC with exactly that topic in Cloudflare (Workers, barnyard-live-prices, Settings, Variables and Secrets). Then press Send test push.";
      if (why === "topic_invalid") return { tone: "attn", text: "Phone alerts are not working: the topic is not valid.", hint: "NTFY_TOPIC must be 16 to 64 letters, digits, dashes or underscores, with no spaces. Make a longer random one, subscribe to it in the app, and update the secret." };
      if (why === "bad_ntfy_url") return { tone: "attn", text: "Phone alerts are not working: NTFY_URL is not valid.", hint: "It must be an https:// address with nothing after the host name, for example https://ntfy.sh. Remove the secret to use ntfy.sh." };
      if (why === "token_invalid") return { tone: "attn", text: "Phone alerts are not working: NTFY_TOKEN does not look like a token.", hint: "Paste the access token exactly as ntfy shows it, or remove the secret if the topic is not protected." };
      return { tone: "", text: "Phone alerts are not set up yet.", hint: set };
    }
    if (s && s.enabled === false) return { tone: "", text: "Phone alerts are set up but switched off.", hint: "Tick the box below to use them." };
    var when = s && s.when === "always"
      ? "Every alert of the kinds ticked below is pushed as it happens, whatever the hour."
      : "A push goes only when email cannot carry an outage: outside working hours, or when email is not working.";
    return { tone: "ok", text: "Phone alerts are set up.", hint: when };
  }

  // A failed test push or digest, in words.
  function pushErrorText(r) {
    var err = r && r.error;
    if (err === "no_topic") return "The Worker secret NTFY_TOPIC is not set.";
    if (err === "topic_invalid") return "NTFY_TOPIC is not a valid topic (16 to 64 letters, digits, dashes or underscores).";
    if (err === "bad_ntfy_url") return "NTFY_URL is not valid: it must be an https:// address with no path.";
    if (err === "token_invalid") return "NTFY_TOKEN does not look like a token.";
    if (err === "refused") return "ntfy refused the push. If the topic is protected, check NTFY_TOKEN allows it.";
    if (err === "rate_limited" && r && Number.isFinite(r.retryAfter) && r.retryAfter >= 0) {
      // ntfy's own limit: the Worker says how long and gives a plain sentence; use its sentence when it is a short one
      return typeof r.message === "string" && r.message.length > 0 && r.message.length <= 200 ? r.message : "ntfy is slowing requests down. Try again in " + Math.max(1, Math.round(r.retryAfter)) + (Math.max(1, Math.round(r.retryAfter)) === 1 ? " second." : " seconds.");
    }
    if (err === "rate_limited" && !(r && r.retryMs)) return "ntfy is slowing requests down. Try again in a minute.";
    if (err === "timeout") return "ntfy did not answer in time. Try again in a minute.";
    if (err === "unreachable") return "The Worker could not reach ntfy. Check NTFY_URL if you set one.";
    if (err === "redirected") return "ntfy sent the Worker somewhere else, which it will not follow. Check NTFY_URL.";
    if (/^http_\d+$/.test(String(err))) return "ntfy answered with an error (" + String(err).slice(5) + ").";
    return mailErrorText(r);
  }

  // How ntfy has been doing, from the status's pushHealth { lastOkAt, lastFailAt, lastFailReason, failures, failing } (null until
  // the first push, and absent while the Worker is older than this page): { tone, text, hint, failing } or null.
  function pushHealthLine(ph, tz, now) {
    if (!ph || typeof ph !== "object") return null;
    var ok = ph.lastOkAt ? "last OK " + clockText(ph.lastOkAt, tz) + " (" + agoText(ph.lastOkAt, now) + ")" : "no push has gone through yet";
    if (ph.failing) {
      var reason = typeof ph.lastFailReason === "string" && /^[A-Za-z0-9_]{1,40}$/.test(ph.lastFailReason) ? ph.lastFailReason : "";
      var why = reason ? pushErrorText({ error: reason }) : "";
      if (/^That did not work/.test(why)) why = "The reason the Worker recorded: " + reason + ".";
      var n = Number(ph.failures) || 0;
      return { tone: "attn", failing: true, text: "ntfy is failing: " + ok + (n ? "; " + n + (n === 1 ? " push" : " pushes") + " in a row did not go through" : "") + ".", hint: why };
    }
    if (!ph.lastOkAt && !ph.lastFailAt) return null;
    return { tone: ph.lastOkAt ? "ok" : "", failing: false, text: "ntfy: " + ok + ".", hint: "" };
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
      var kinds = { test: "Test", "test-push": "Test push", push: "Push", ack: "Acknowledged", digest: "Digest", report: "IT report" };
      var ok = h.result === "sent" || h.kind === "ack";
      var result = ok ? "Sent to " + h.recipients + (h.recipients === 1 ? " address" : " addresses") : "Failed (" + h.result + ")";
      if (h.kind === "push" || h.kind === "test-push") result = ok ? "Sent to the phone" : "Failed (" + h.result + ")";
      if (h.kind === "ack") result = h.result === "push" ? "From the phone" : "From this page";
      return { when: clockText(h.ts, tz), kind: kinds[h.kind] || "Alert", subject: h.subject || "", ok: ok, result: result };
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

  // ---- the server reporters (a small script on each server; see ClaudeRepo's reporter/) ----------

  var SERVERS = [{ id: "app02", name: "app02" }, { id: "cld01", name: "BARNYARDCLD01" }, { id: "vtt", name: "VTT server" }];

  // The switches under settings.alerts in the Worker (monitor-logic.js): every one is on until the owner turns it off.
  var ALERT_SWITCHES = [
    ["reporters", "A reporter goes quiet, or the site may have lost power or internet"],
    ["resources", "A disk is nearly full, memory or load is high, or a service stops"],
    ["vulns", "A new critical vulnerability affects something you run, with a monthly reminder while any are still open"],
    ["calendar", "A daily Calendar reminder: to-dos due or overdue, and renewals 30 days, 7 days and on the day away"],
    ["digest", "A weekly summary on Monday morning: uptime, incidents, vulnerabilities, renewals, backups and what is waiting on you"],
    ["report", "A monthly IT report for the committee on the first working day of the month, emailed to you to forward (see Reports)"],
    ["inventory", "A server has not sent its daily software list for 36 hours (the list the Vulnerabilities page checks)"]
  ];
  // What may be pushed to the phone (settings.push.types in the Worker).
  var PUSH_TYPES = [
    ["down", "Something goes down"],
    ["recovered", "Something comes back up"],
    ["vulns", "A new critical vulnerability"],
    ["reminder", "The reminder every 4 hours while something is still down"]
  ];
  var REPORTER_DOCS = "https://github.com/FarmerBarnyard/ClaudeRepo/tree/main/reporter";

  function uptimeText(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "";
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + " d " + h + " h";
    if (h) return h + " h " + m + " min";
    return Math.max(1, m) + " min";
  }

  // The last report as short lines a person can read: load, memory, disks, uptime, services, who it can reach.
  function reportLines(report) {
    var out = [];
    if (!report) return out;
    if (report.load) out.push("Load " + report.load.l1 + " on " + report.load.cores + (report.load.cores === 1 ? " core" : " cores"));
    if (report.mem) out.push("Memory " + Math.round(report.mem.usedPct) + "% used");
    (report.disks || []).forEach(function (d) { out.push("Disk " + d.mount + " " + Math.round(d.usedPct) + "% full"); });
    if (report.uptime !== null && report.uptime !== undefined) out.push("Up " + uptimeText(report.uptime));
    var sv = report.services || [];
    if (sv.length) out.push("Services: " + sv.map(function (s) { return s.name + (s.up ? " running" : " NOT running"); }).join(", "));
    var pe = report.peers || [];
    if (pe.length) out.push("Can reach: " + pe.map(function (p) { return p.id + (p.ok === null ? " (not tested)" : p.ok ? " yes" + (p.ms ? " (" + p.ms + " ms)" : "") : " NO"); }).join(", "));
    return out;
  }

  // One card per server: { id, name, tone, label, line, lines, keys: [{ id, tail, state, text, canRevoke }], canMake }.
  // The best key is the active one that reported most recently.
  function reporterCards(reporters, now) {
    var list = Array.isArray(reporters) ? reporters : [];
    return SERVERS.map(function (s) {
      var mine = list.filter(function (r) { return r.server === s.id; });
      var active = mine.filter(function (r) { return r.state === "reporting" || r.state === "silent" || r.state === "waiting"; });
      var best = active.slice().sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); })[0];
      var tone = "", label = "No key yet", line = "Make a key, then install the reporter on this server.", lines = [];
      if (best) {
        if (best.state === "reporting") { tone = "ok"; label = "Reporting"; line = "Last report " + agoText(best.lastSeen, now) + "."; lines = reportLines(best.report); }
        else if (best.state === "silent") { tone = "attn"; label = "Silent"; line = "Last report " + agoText(best.lastSeen, now) + ". The reporter may have stopped, or the server cannot reach the Worker."; lines = reportLines(best.report); }
        else { tone = "attn"; label = "Waiting for its first report"; line = "The key is made but nothing has reported with it yet. Install the reporter on the server."; }
      } else if (mine.some(function (r) { return r.state === "expired"; })) { tone = "alert"; label = "Key expired"; line = "Make a new key and put it in the server's env file."; }
      var keys = mine.map(function (r) {
        var tail = r.id.slice(-4);
        var day = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
        var text = r.state === "revoked" ? "revoked" : r.state === "expired" ? "expired " + day(r.expiresAt) : "made " + day(r.createdAt) + ", expires " + day(r.expiresAt);
        return { id: r.id, tail: tail, state: r.state, text: text, canRevoke: r.state !== "revoked" && r.state !== "expired" };
      });
      var activeCount = active.length;
      return { id: s.id, name: s.name, tone: tone, label: label, line: line, lines: lines, keys: keys, canMake: activeCount < 3 };
    });
  }

  // What the page tells the owner to paste into /etc/barnyard-reporter/env.
  function envLines(server, key) { return "BR_SERVER=" + server + "\nBR_KEY=" + key + "\n"; }

  // The words for the reason codes the Worker keeps with an alert from a report (monitor-reporters.js reasonText).
  function reasonText(detail) {
    if (!detail) return "";
    if (detail === "server_up") return "The server is running and checking in, but Cloudflare cannot reach it (check the tunnel).";
    if (detail === "reporter_silent") return "Its reporter has gone quiet too.";
    if (detail === "peer_reports") return "Its reporter is silent and another server cannot reach it either.";
    if (detail === "silent") return "It has not checked in, although the server is answering from outside (the reporter service may have stopped).";
    if (detail === "waiting") return "It has not reported yet.";
    if (detail === "power") return "Everything that reports from the site went quiet at once and the outside checks fail too: the site may have lost power or internet.";
    var p = detail.split("|");
    if (p[0] === "disk95" || p[0] === "disk85") return "The disk " + p[1] + " is " + p[2] + "% full.";
    if (p[0] === "svc") return "The service " + p[1] + " is not running.";
    if (p[0] === "mem") return "Memory is " + p[2] + "% used.";
    if (p[0] === "load") return "The load is " + p[2] + " per core.";
    return "";
  }

  // The alerts that come from reports (reporter silent, getting full, disk or service, power or internet) that are not fine.
  function derivedRows(derived, now) {
    return (Array.isArray(derived) ? derived : []).filter(function (d) { return d.status === "down"; }).map(function (d) {
      return {
        id: d.id, name: d.name, tone: d.grade === "notice" ? "attn" : "alert", label: d.grade === "notice" ? "Notice" : "Alert",
        text: reasonText(d.detail) + (d.downSince ? " Since " + clockText(d.downSince) + " (" + durationText(now - d.downSince) + ")." : ""),
        ack: ackModel(d, now)
      };
    });
  }

  // Plain words for what the Worker says when a key cannot be made or revoked.
  function keyErrorText(r) {
    var err = r && r.error;
    if (err === "too_many_keys") return "That server already has three keys. Revoke one first.";
    if (err === "server_unknown") return "That is not one of the servers.";
    if (err === "label_invalid") return "That label has characters I cannot use.";
    if (err === "reporter_unknown") return "That key no longer exists.";
    return mailErrorText(r);
  }


  // ---- the dashboard's own helpers (tabs, counts, uptime, sparklines, groups, backoff) ------------------------

  // The tabs in the order they show. Dashboard and Settings are Monitoring's own; the other four are pages that used to have their
  // own link in the menu. Each needs the permission its page always needed and is for the hub owner only (the Worker refuses anyone
  // else), so a person who may only see Monitoring sees Dashboard and Settings and nothing more.
  var TABS = ["dashboard", "services", "incidents", "reports", "release", "settings"];
  var BASE_TABS = ["dashboard", "settings"];
  // perm: the permission the Users page can take away. pane: its panel in monitoring.html. files: the scripts it loads, in order.
  var EXT_TABS = {
    services: { perm: "services.view", title: "Services", pane: "pane-services", files: ["services.js"] },
    incidents: { perm: "incidents.view", title: "Incidents", pane: "pane-incidents", files: ["incidents.js"] },
    reports: { perm: "reports.view", title: "Reports", pane: "pane-reports", files: ["reports.js"] },
    release: { perm: "release.view", title: "Release board", pane: "pane-release", files: ["release-logic.js", "release.js"] }
  };
  var TREND_DAYS = 14;
  var STATUS_MS = 60000;            // how often the Dashboard asks for the status while it is open and visible
  var EXTRAS_MS = 10 * 60000;       // the security block (vulnerabilities, expiries) is read this often at most
  var INCIDENTS_MS = 5 * 60000;     // and the open-incident count this often at most
  var CHECK_GAP_MS = 30000;         // the Worker lets "Check now" run once every 30 seconds
  var MIN_REFRESH_MS = 5000;        // the Refresh button will not ask again within this
  var SETTINGS_STALE_MS = 30000;    // opening Settings reads the status again only if the last read is older than this

  // The tabs this person has, in order: Dashboard and Settings always, and an extra one only for the owner who has its permission.
  // who: the shell's session (owner true/false); permits(who, perm): its permission check. Fails closed when who is not known.
  function extTabsFor(who, permits) {
    if (!who || who.owner !== true) return [];
    return Object.keys(EXT_TABS).filter(function (t) {
      try { return typeof permits !== "function" || permits(who, EXT_TABS[t].perm) !== false; } catch (e) { return false; }
    });
  }
  function allowedTabs(ext) {
    var more = Array.isArray(ext) ? ext : [];
    return TABS.filter(function (t) { return BASE_TABS.indexOf(t) !== -1 || more.indexOf(t) !== -1; });
  }

  // "#settings" -> "settings"; "#incidents/inc_abcd1234" -> "incidents"; a tab this person does not have, no hash, "#dashboard" or
  // rubbish -> "dashboard". `allowed` is the person's tabs (allowedTabs); without it only Dashboard and Settings count.
  function tabFromHash(hash, allowed) {
    var h = String(hash || "").replace(/^#/, "").toLowerCase().split("/")[0];
    return (Array.isArray(allowed) ? allowed : BASE_TABS).indexOf(h) !== -1 ? h : "dashboard";
  }
  function hashForTab(tab) { return "#" + (TABS.indexOf(tab) !== -1 ? tab : "dashboard"); }

  // The tab a key moves to: arrows wrap, Home and End jump. null for any other key.
  function nextTab(current, key, allowed) {
    var list = Array.isArray(allowed) ? allowed : BASE_TABS;
    var i = list.indexOf(current);
    if (i === -1) i = 0;
    if (key === "ArrowRight" || key === "ArrowDown") return list[(i + 1) % list.length];
    if (key === "ArrowLeft" || key === "ArrowUp") return list[(i + list.length - 1) % list.length];
    if (key === "Home") return list[0];
    if (key === "End") return list[list.length - 1];
    return null;
  }

  // up / down / unknown (checked but cannot tell) / waiting (never checked) for the outside monitors.
  function counts(monitors) {
    var c = { up: 0, down: 0, unknown: 0, waiting: 0, total: 0 };
    (Array.isArray(monitors) ? monitors : []).forEach(function (m) {
      c.total++;
      if (m.status === "up") c.up++;
      else if (m.status === "down") c.down++;
      else if (m.lastCheck) c.unknown++;
      else c.waiting++;
    });
    return c;
  }

  // The big pill: { key, tone, label }. An outage anywhere is Down; a server's own report raising an alert, or a monitor that
  // cannot be confirmed, is Degraded; nothing checked yet is Waiting.
  function overallState(monitors, derived) {
    var c = counts(monitors);
    var reportAlerts = (Array.isArray(derived) ? derived : []).filter(function (d) { return d.status === "down" && d.grade !== "notice"; }).length;
    if (!c.total) return { key: "empty", tone: "", label: "Nothing watched" };
    if (c.down) return { key: "down", tone: "alert", label: "Down" };
    if (c.waiting === c.total) return { key: "waiting", tone: "", label: "Waiting for checks" };
    if (c.unknown || reportAlerts) return { key: "degraded", tone: "attn", label: "Degraded" };
    return { key: "up", tone: "ok", label: "All up" };
  }

  // Uptime over the last `days` entries of one monitor's daily [checks, fails] list (today included): { pct, checks } or null.
  function uptimePct(daily, days) {
    var list = Array.isArray(daily) ? daily.slice(-Math.max(1, days)) : [];
    var checks = 0, fails = 0;
    list.forEach(function (d) { checks += Number(d && d[0]) || 0; fails += Number(d && d[1]) || 0; });
    if (!checks) return null;
    return { pct: Math.round((1 - fails / checks) * 1000) / 10, checks: checks };
  }

  // "99.8%" or an en dash when there is nothing to say yet.
  function pctText(u) { return u && Number.isFinite(u.pct) ? (u.pct === 100 ? "100%" : u.pct.toFixed(1) + "%") : "–"; }

  // A sparkline of daily uptime in a w x h box: { line, area, last: { x, y, pct }, days: [{ x, y, pct } | null], hasData }.
  // The scale runs from 90% (bottom) to 100% (top) because an uptime of 99.5% and one of 60% should not look alike; anything
  // under 90% sits on the floor. A day with no checks breaks the line instead of drawing as zero.
  function sparkModel(daily, w, h) {
    var list = Array.isArray(daily) ? daily : [];
    var n = list.length, pad = 3;
    var pts = list.map(function (d, i) {
      var c = Number(d && d[0]) || 0, f = Number(d && d[1]) || 0;
      if (!c) return null;
      var pct = (1 - f / c) * 100;
      var t = Math.max(0, Math.min(1, (pct - 90) / 10));
      return { x: n > 1 ? pad + i * (w - 2 * pad) / (n - 1) : w / 2, y: pad + (1 - t) * (h - 2 * pad), pct: Math.round(pct * 10) / 10 };
    });
    var line = "", area = "", run = [];
    function flush() {
      if (!run.length) return;
      line += (line ? " " : "") + "M" + run.map(function (p) { return round1(p.x) + " " + round1(p.y); }).join(" L");
      if (run.length > 1) area += (area ? " " : "") + "M" + round1(run[0].x) + " " + (h - 1) + " L" + run.map(function (p) { return round1(p.x) + " " + round1(p.y); }).join(" L") + " L" + round1(run[run.length - 1].x) + " " + (h - 1) + " Z";
      run = [];
    }
    pts.forEach(function (p) { if (p) run.push(p); else flush(); });
    flush();
    var lastPt = null;
    for (var i = pts.length - 1; i >= 0; i--) if (pts[i]) { lastPt = pts[i]; break; }
    return { line: line, area: area, last: lastPt, days: pts, hasData: !!lastPt };
  }
  function round1(v) { return Math.round(v * 10) / 10; }

  // The words for a sparkline's tooltip and screen-reader label: "Daily uptime for the last 14 days, oldest first: 100%, 99.7%, no checks ..."
  function sparkLabel(daily) {
    var list = Array.isArray(daily) ? daily : [];
    return "Daily uptime for the last " + list.length + " days, oldest first: " + list.map(function (d) {
      var c = Number(d && d[0]) || 0, f = Number(d && d[1]) || 0;
      return c ? pctText({ pct: Math.round((1 - f / c) * 1000) / 10 }) : "no checks";
    }).join(", ") + ".";
  }

  var GROUPS = [
    ["servers", "Servers", "checked every 5 minutes from the Worker"],
    ["sites", "Sites", "shown here; no email by default"],
    ["services", "Services", ""]
  ];

  // One card: the state words from tileModel plus the facts the dashboard shows. `trend` is the status's trend block.
  function cardModel(m, now, trend) {
    var t = tileModel(m, now);
    var daily = trend && trend.series && Array.isArray(trend.series[m.id]) ? trend.series[m.id] : [];
    var facts = [];
    if (m.status === "up" && m.since) facts.push("Up for " + durationText(now - m.since));
    if (m.status === "down" && m.downSince) facts.push("Down for " + durationText(now - m.downSince));
    facts.push(m.lastCheck ? "Checked " + agoText(m.lastCheck, now) : "Not checked yet");
    if (m.lastMs) facts.push(m.lastMs + " ms");
    var d7 = uptimePct(daily, 7);
    return {
      id: m.id, name: m.name, group: m.group, tone: t.tone, label: t.label, facts: facts, detail: t.detail, ack: t.ack, fix: t.fix,
      uptime7: d7, uptimeText: pctText(d7), spark: sparkModel(daily, 120, 34), sparkLabel: sparkLabel(daily), hasHistory: !!d7
    };
  }

  // The monitors in their groups, empty groups left out; a group the page does not know goes last as "Other".
  function groupCards(monitors, now, trend) {
    var cards = (Array.isArray(monitors) ? monitors : []).map(function (m) { return cardModel(m, now, trend); });
    var out = [];
    GROUPS.forEach(function (g) {
      var items = cards.filter(function (c) { return c.group === g[0]; });
      if (items.length) out.push({ id: g[0], title: g[1], note: g[2], items: items });
    });
    var known = GROUPS.map(function (g) { return g[0]; });
    var rest = cards.filter(function (c) { return known.indexOf(c.group) === -1; });
    if (rest.length) out.push({ id: "other", title: "Other", note: "", items: rest });
    return out;
  }

  // The Incident Room's count for the strip: { text, tone, open } or null when the owner has no access or it failed.
  function incidentsChip(summary) {
    if (!summary || summary.ok !== true || !Number.isFinite(summary.open)) return null;
    if (!summary.open) return { text: "No open incidents", tone: "ok", open: 0 };
    return { text: summary.open + (summary.open === 1 ? " open incident" : " open incidents"), tone: "alert", open: summary.open };
  }

  // The recent-alerts panel: what is raising an alert right now (from the servers' reports), then what was sent, held, pushed or acknowledged.
  function timelineRows(history, derived, tz, now) {
    var rows = [];
    derivedRows(derived, now).forEach(function (r) { rows.push({ when: "now", kind: r.label, tone: r.tone, subject: r.name, result: r.text, ok: false, live: true }); });
    historyRows(history, tz).forEach(function (r) { rows.push({ when: r.when, kind: r.kind, tone: r.ok ? "ok" : "alert", subject: r.subject, result: r.result, ok: r.ok, live: false }); });
    return rows;
  }

  // A server's reporter as a compact row for the dashboard: { name, tone, label, line, bars: [{ label, pct, tone }], stale }.
  function reporterBrief(card, report, known) {
    var bars = [];
    if (report && report.mem && Number.isFinite(report.mem.usedPct)) bars.push({ label: "Memory", pct: Math.round(report.mem.usedPct), tone: barTone(report.mem.usedPct) });
    (report && report.disks || []).slice(0, 2).forEach(function (d) { if (Number.isFinite(d.usedPct)) bars.push({ label: "Disk " + d.mount, pct: Math.round(d.usedPct), tone: barTone(d.usedPct) }); });
    return { id: card.id, name: card.name, tone: card.tone, label: card.label, line: card.line, bars: bars, services: serviceStates(report, known), stale: card.label === "Silent" || card.label === "Key expired" };
  }

  // A server's services as { name, state: "up" | "down" | "unknown" }. A service the report names is up or down. One the page has
  // seen in an earlier report from this server but that this one leaves out is "unknown": a reporter leaves out a service whose
  // check itself failed, which is not the same as the service being down.
  function serviceStates(report, known) {
    var out = [], seen = {};
    ((report && report.services) || []).forEach(function (s) {
      if (!s || typeof s.name !== "string") return;
      seen[s.name] = true;
      out.push({ name: s.name, state: s.up === true ? "up" : s.up === false ? "down" : "unknown" });
    });
    (Array.isArray(known) ? known : []).forEach(function (name) { if (!seen[name]) out.push({ name: name, state: "unknown" }); });
    return out;
  }
  function barTone(p) { return p >= 95 ? "alert" : p >= 85 ? "attn" : "ok"; }

  // The best report of each server (the active key that reported most recently), for reporterBrief.
  function bestReports(reporters) {
    var out = {};
    (Array.isArray(reporters) ? reporters : []).forEach(function (r) {
      if (r.state !== "reporting" && r.state !== "silent") return;
      if (!out[r.server] || (r.lastSeen || 0) > (out[r.server].lastSeen || 0)) out[r.server] = r;
    });
    var map = {};
    Object.keys(out).forEach(function (k) { map[k] = out[k].report || null; });
    return map;
  }

  // ---- request budget: when to ask again, and how to back off ------------------------------------------------

  // Retry-After as seconds (a number, or an HTTP date), or null.
  function parseRetryAfter(value, now) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
    var t = Date.parse(value);
    if (Number.isFinite(t)) return Math.max(0, Math.round((t - (now || Date.now())) / 1000));
    return null;
  }

  // How long to wait after a 429 (or a failed poll): the server's Retry-After when it gave one (5 s to 5 min), else 60 s doubling to 5 min.
  function backoffMs(attempt, retryAfterSec) {
    if (Number.isFinite(retryAfterSec)) return Math.max(5, Math.min(300, retryAfterSec)) * 1000;
    return Math.min(300000, 60000 * Math.pow(2, Math.max(0, (attempt || 1) - 1)));
  }

  // The calm line shown while waiting.
  function busyText(ms) {
    var s = Math.max(1, Math.ceil(ms / 1000));
    return "The Worker is busy. Showing the last answer; trying again in " + (s >= 90 ? Math.round(s / 60) + " min" : s + " s") + ".";
  }

  // Whether the Dashboard should ask for the status now: only while the page is visible, on the Dashboard tab, signed in, idle and not backing off.
  function pollDue(s) {
    if (!s || s.hidden || s.tab !== "dashboard" || s.state !== "ok" || s.busy || s.inflight) return false;
    if (s.backoffUntil && s.now < s.backoffUntil) return false;
    return !s.fetchedAt || s.now - s.fetchedAt >= (s.every || STATUS_MS);
  }

  // Milliseconds until the next poll is due (never negative), for the timer.
  function nextPollIn(s) {
    var wait = (s.every || STATUS_MS) - (s.now - (s.fetchedAt || 0));
    if (s.backoffUntil && s.backoffUntil > s.now) wait = Math.max(wait, s.backoffUntil - s.now);
    return Math.max(1000, wait);
  }

  // Whether an optional read (security block, incidents) is due: never read, or older than its limit.
  function extraDue(at, now, limit) { return !at || now - at >= limit; }

  // Seconds left before "Check now" may run again (0 when it may).
  function checkWait(until, now) { return Math.max(0, Math.ceil((until - now) / 1000)); }
  function checkLabel(sec) { return sec > 0 ? "Check now (" + sec + " s)" : "Check now"; }

  // Whether the Settings tab should read the status as it opens.
  function settingsNeedsRead(fetchedAt, now) { return !fetchedAt || now - fetchedAt >= SETTINGS_STALE_MS; }

  var helpers = {
    agoText: agoText, durationText: durationText, clockText: clockText, detailText: detailText, tileModel: tileModel, summarise: summarise,
    emailStatus: emailStatus, mailErrorText: mailErrorText, hoursText: hoursText, validateAddress: validateAddress, addRecipient: addRecipient,
    removeRecipient: removeRecipient, hoursBody: hoursBody, historyRows: historyRows, securityRows: securityRows, expiryRows: expiryRows,
    uptimeText: uptimeText, reportLines: reportLines, reporterCards: reporterCards, envLines: envLines, reasonText: reasonText,
    derivedRows: derivedRows, keyErrorText: keyErrorText, SERVERS: SERVERS, ALERT_SWITCHES: ALERT_SWITCHES,
    ackModel: ackModel, pushStatus: pushStatus, pushErrorText: pushErrorText, PUSH_TYPES: PUSH_TYPES,
    ZONES: ZONES, DAY_NAMES: DAY_NAMES, DAY_ORDER: DAY_ORDER, MAX_RECIPIENTS: MAX_RECIPIENTS,
    // the dashboard
    TABS: TABS, BASE_TABS: BASE_TABS, EXT_TABS: EXT_TABS, extTabsFor: extTabsFor, allowedTabs: allowedTabs, TREND_DAYS: TREND_DAYS, STATUS_MS: STATUS_MS, EXTRAS_MS: EXTRAS_MS, INCIDENTS_MS: INCIDENTS_MS, CHECK_GAP_MS: CHECK_GAP_MS, MIN_REFRESH_MS: MIN_REFRESH_MS,
    tabFromHash: tabFromHash, hashForTab: hashForTab, nextTab: nextTab, counts: counts, overallState: overallState, uptimePct: uptimePct, pctText: pctText,
    sparkModel: sparkModel, sparkLabel: sparkLabel, cardModel: cardModel, groupCards: groupCards, incidentsChip: incidentsChip, timelineRows: timelineRows,
    reporterBrief: reporterBrief, bestReports: bestReports, serviceStates: serviceStates, pushHealthLine: pushHealthLine, parseRetryAfter: parseRetryAfter, backoffMs: backoffMs, busyText: busyText, pollDue: pollDue,
    nextPollIn: nextPollIn, extraDue: extraDue, checkWait: checkWait, checkLabel: checkLabel, settingsNeedsRead: settingsNeedsRead
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var HUB = "https://api.barnyard.site/hub/status", VULN = "https://api.barnyard.site/vuln/summary", INC = "https://api.barnyard.site/incidents/summary";

  // newKey: the key just made, held here only until the owner is done with it (it is never stored anywhere).
  // fetchedAt / hubAt / incAt: when each read last finished. attempt / backoffUntil: the backing-off after a busy answer.
  var model = {
    state: "loading", mon: null, hub: null, vuln: null, inc: null, people: null, mine: false, tab: "dashboard", ext: [], flash: null, busy: false, newKey: null,
    fetchedAt: 0, hubAt: 0, incAt: 0, inflight: false, attempt: 0, backoffUntil: 0, note: "", checkUntil: 0, lastRefreshAt: 0, stale: false,
    known: {}          // server id -> { service name: true } for every service a report from it has named, so one that goes missing reads as unknown
  };
  var pollTimer = null, checkTimer = null;

  // -> { status, body, retryAfter }. Status 0 is a network failure, which is also how the browser reports Cloudflare's own
  // rate-limit answer (it carries no CORS headers), so 0 and 429 are both treated as "busy".
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
        var sec = parseRetryAfter(header);
        if (sec === null && body && Number.isFinite(body.retryMs)) sec = Math.ceil(body.retryMs / 1000);
        if (sec === null && body && Number.isFinite(body.resetsInSeconds)) sec = Math.min(300, body.resetsInSeconds);
        return { status: r.status, body: body, retryAfter: sec };
      });
    }, function () { clearTimeout(timer); return { status: 0, body: {}, retryAfter: null }; });
  }

  function snapshot() {
    return { hidden: document.hidden, tab: model.tab, state: model.state, busy: model.busy, inflight: model.inflight, backoffUntil: model.backoffUntil, fetchedAt: model.fetchedAt, now: Date.now() };
  }

  // Reads the status. Only one read at a time; a read that finds the Worker busy keeps the last answer on screen and waits.
  function fetchStatus(opts) {
    opts = opts || {};
    if (model.inflight) return Promise.resolve(false);
    if (!opts.force && model.backoffUntil > Date.now()) return Promise.resolve(false);
    model.inflight = true;
    return getJson(MON + "/status", {}).then(function (r) {
      model.inflight = false;
      // The Worker keeps this page's data for the hub owner: for anyone else it answers 403, and the person's own space is the page.
      if (r.status === 403 && !model.mine && window.BarnyardMyMonitoring) { model.mine = true; window.BarnyardMyMonitoring.start(); return false; }
      var ok = applyStatus(r);
      render();
      schedule();
      if (ok && model.tab === "dashboard") fetchExtras(!!opts.force);
      return ok;
    });
  }

  function applyStatus(r) {
    var now = Date.now();
    if (r.status === 401) { model.state = "guest"; return false; }
    if (r.status === 403) { model.state = "forbidden"; return false; }
    if (r.status === 200 && r.body && typeof r.body === "object") {
      model.mon = r.body; model.fetchedAt = now; model.attempt = 0; model.backoffUntil = 0; model.note = ""; model.stale = false; model.state = "ok";
      rememberServices(r.body.reporters);
      return true;
    }
    // busy (429), unreachable (0, which is also what a Cloudflare rate-limit answer looks like) or a server error
    model.attempt++;
    var wait = backoffMs(model.attempt, r.retryAfter);
    model.backoffUntil = now + wait;
    model.note = busyText(wait);
    if (!model.mon) model.state = "error";
    else model.state = "ok";
    return false;
  }

  function rememberServices(reporters) {
    (Array.isArray(reporters) ? reporters : []).forEach(function (r) {
      var list = r && r.report && Array.isArray(r.report.services) ? r.report.services : [];
      list.forEach(function (s) {
        if (!s || typeof s.name !== "string" || !/^[A-Za-z0-9_.@:-]{1,60}$/.test(s.name)) return;
        (model.known[r.server] = model.known[r.server] || {})[s.name] = true;
      });
    });
  }

  // The security block (vulnerabilities, what is about to expire) and the open-incident count: decoration, so each is read
  // when first needed and then at most every few minutes, never on every status poll.
  function fetchExtras(force) {
    var now = Date.now(), jobs = [];
    if (force || extraDue(model.hubAt, now, EXTRAS_MS)) {
      model.hubAt = now;
      jobs.push(getJson(HUB, {}).then(function (r) { model.hub = r.status === 200 ? r.body : null; }));
      jobs.push(getJson(VULN, {}).then(function (r) { model.vuln = r.status === 200 ? r.body : null; }));
    }
    if (force || extraDue(model.incAt, now, INCIDENTS_MS)) {
      model.incAt = now;
      jobs.push(getJson(INC, {}).then(function (r) { model.inc = r.status === 200 ? r.body : null; }));
      // who has their own Monitoring space (names and counts); read as often as the incident count
      jobs.push(getJson(MON + "/people", {}).then(function (r) { model.people = r.status === 200 && r.body && r.body.enabled ? r.body : null; }));
    }
    if (!jobs.length) return Promise.resolve();
    return Promise.all(jobs).then(function () { if (model.tab === "dashboard" && model.state === "ok") render(); });
  }

  // The next poll: only while the page is visible, on the Dashboard tab and idle.
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (document.hidden) return;
    // the very first read was refused or busy: try again when the back-off ends (a signed-out or forbidden page does not retry)
    if (model.state === "error") {
      pollTimer = setTimeout(function () { fetchStatus({ force: true }); }, Math.max(1000, model.backoffUntil - Date.now()));
      return;
    }
    if (model.tab !== "dashboard" || model.state !== "ok") return;
    pollTimer = setTimeout(function () {
      if (pollDue(snapshot())) fetchStatus(); else schedule();
    }, nextPollIn(snapshot()));
  }

  // ---- 3. rendering ---------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var SVGNS = "http://www.w3.org/2000/svg";
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  // data-fk names a control so it can be given focus back after the panel is rebuilt.
  function fk(el, key) { el.setAttribute("data-fk", key); return el; }
  function button(text, cls, key) { var b = h("button", cls, text); b.type = "button"; if (key) fk(b, key); return b; }

  function message(text, linkText, href) {
    var box = $("mon-root");
    clear(box);
    box.appendChild(h("p", "dim", text));
    if (href) { var a = h("a", "btn btn-sm", linkText); a.href = href; box.appendChild(a); }
  }

  function box(title, note, cls) {
    var s = h("section", "mo-box" + (cls ? " " + cls : ""));
    var head = h("div", "sec-head");
    head.appendChild(h("h2", null, title));
    if (note) head.appendChild(h("span", "sub", note));
    s.appendChild(head);
    return s;
  }

  function list(cls) { var ul = h("ul", cls || "mo-list"); ul.setAttribute("role", "list"); return ul; }

  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var el = $("mon-flash");
    if (!el) return;
    clear(el);
    if (!model.flash) { el.hidden = true; return; }
    el.hidden = false;
    el.className = "mo-flash " + (tone || "");
    el.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") {
      var a = h("a", "btn btn-sm", "Sign in again");
      a.href = window.barnyardLoginUrl();
      el.appendChild(a);
    }
  }

  function field(label, control) {
    var l = h("label", "mo-field");
    l.appendChild(h("span", "dim", label));
    l.appendChild(control);
    return l;
  }

  // "Acknowledge" (stop this outage's reminders) or, once acknowledged, "Undo".
  function ackButton(id, name, acked) {
    var b = button(acked ? "Undo acknowledge" : "Acknowledge", "btn btn-sm", "ack:" + id);
    b.setAttribute("aria-label", (acked ? "Undo the acknowledgement of " : "Acknowledge the outage of ") + name);
    b.addEventListener("click", function () { acknowledge(id, name, !acked); });
    return b;
  }

  function focusKey() {
    var a = document.activeElement;
    return a && a.getAttribute ? a.getAttribute("data-fk") : null;
  }
  function restoreFocus(key) {
    if (!key) return;
    var nodes = document.querySelectorAll("[data-fk]");
    for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute("data-fk") === key) { try { nodes[i].focus({ preventScroll: true }); } catch (e) { nodes[i].focus(); } return; }
  }

  function isExt(tab) { return !!EXT_TABS[tab]; }

  function updateTabs() {
    var allowed = allowedTabs(model.ext);
    TABS.forEach(function (t) {
      var b = $("tab-" + t);
      if (!b) return;
      if (isExt(t)) b.hidden = allowed.indexOf(t) === -1;
      var on = model.tab === t;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("on", on);
    });
  }

  // On a phone the six tabs scroll sideways inside their bar: bring the open one into view (only the bar moves, never the page).
  function revealTab() {
    var list = $("mon-tabs"), b = $("tab-" + model.tab);
    if (!list || !b || list.hidden || list.scrollWidth <= list.clientWidth) return;
    var lr = list.getBoundingClientRect(), br = b.getBoundingClientRect();
    if (br.left < lr.left) list.scrollLeft -= lr.left - br.left + 8;
    else if (br.right > lr.right) list.scrollLeft += br.right - lr.right + 8;
  }

  // Shows the panel of the open tab and hides the others: Dashboard and Settings share #mon-main (what monitoring.js draws),
  // each of the other four has a panel of its own (drawn by its own script).
  function showPanes() {
    var ext = isExt(model.tab);
    var main = $("mon-main"), tools = $("mon-tools");
    if (main) main.hidden = ext;
    if (tools) tools.hidden = ext;
    Object.keys(EXT_TABS).forEach(function (t) {
      var p = $(EXT_TABS[t].pane);
      if (p) p.hidden = model.tab !== t;
    });
  }

  // ---- the four pages that live in tabs (services.js, incidents.js, reports.js, release.js) -------------------------

  var loaded = {};   // tab -> the promise of its scripts, so they are fetched once

  // The address of a script as monitoring.html names it (with its cache stamp), held inert in a <template> so nothing is
  // fetched until a tab is opened.
  function scriptUrl(file) {
    var tpl = $("mon-lazy"), found = file;
    if (tpl && tpl.content) {
      Array.prototype.forEach.call(tpl.content.querySelectorAll("script"), function (s) {
        var src = s.getAttribute("src") || "";
        if (src.split("?")[0] === file) found = src;
      });
    }
    return found;
  }

  function loadScript(file) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = scriptUrl(file);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("load")); };
      document.head.appendChild(s);
    });
  }

  // The tab's scripts, in order, once. A failed load can be tried again by opening the tab again.
  function loadExt(tab) {
    if (loaded[tab]) return loaded[tab];
    var p = EXT_TABS[tab].files.reduce(function (chain, file) { return chain.then(function () { return loadScript(file); }); }, Promise.resolve());
    loaded[tab] = p;
    p.catch(function () { delete loaded[tab]; });
    return p;
  }

  function startExt(tab) {
    loadExt(tab).then(function () {
      if (model.tab !== tab) return;   // another tab was chosen while the script was coming
      var m = window.BarnyardTabs && window.BarnyardTabs[tab];
      if (m && typeof m.start === "function") m.start();
    }, function () {
      var pane = $(EXT_TABS[tab].pane), box = pane && pane.querySelector("[aria-live]");
      if (!box) return;
      clear(box);
      box.appendChild(h("p", "dim", "Couldn’t load this tab. Check your connection, then open it again."));
    });
  }

  function stopExt(tab) {
    var m = window.BarnyardTabs && window.BarnyardTabs[tab];
    if (m && typeof m.stop === "function") m.stop();
  }

  function render() {
    var root = $("mon-root"), tabs = $("mon-tabs");
    // The owner's extra tabs stay reachable whatever the monitoring answer was (switched off, busy, unreachable); only a
    // signed-out page, or someone with their own space, has no tab bar for them.
    var bar = model.ext.length > 0 && !model.mine && model.state !== "guest" && model.state !== "forbidden";
    if (tabs) tabs.hidden = !bar;
    if (bar) updateTabs();
    showPanes();
    if (isExt(model.tab)) return;   // that tab draws itself; nothing here is on screen
    if (model.state === "loading") return;
    if (model.state === "guest") { message("Log in to see monitoring.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is for the person who runs the hub."); return; }
    if (model.state === "error" || !model.mon) { message(model.note || "Couldn’t reach the Worker just now. It will try again shortly."); return; }
    var st = model.mon, now = Date.now();
    if (st.enabled === false) {
      clear(root);
      root.appendChild(h("p", "mo-off", "Monitoring is switched off. The Worker variable MONITOR_ENABLED is 0; remove it (or set it to 1) in Cloudflare to switch it back on."));
      return;
    }
    if (tabs) tabs.hidden = false;
    updateTabs();
    var key = focusKey();
    clear(root);
    var panel = h("div", "mo-pane");
    panel.id = "mon-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "tab-" + model.tab);
    if (model.tab === "settings") renderSettings(panel, st, now); else renderDashboard(panel, st, now);
    root.appendChild(panel);
    restoreFocus(key);
    var stamp = $("mon-stamp");
    if (stamp) stamp.textContent = model.fetchedAt ? "Updated " + new Date(model.fetchedAt).toLocaleTimeString() : "";
    tickCheck();
  }

  // ---- the Dashboard tab ----------------------------------------------------

  function sparkSvg(c) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 120 34");
    svg.setAttribute("width", "120"); svg.setAttribute("height", "34");
    svg.setAttribute("class", "mo-spark" + (c.tone ? " " + c.tone : ""));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", c.sparkLabel);
    var title = document.createElementNS(SVGNS, "title");
    title.textContent = c.sparkLabel;
    svg.appendChild(title);
    function path(cls, d) { var p = document.createElementNS(SVGNS, "path"); p.setAttribute("class", cls); p.setAttribute("d", d); svg.appendChild(p); }
    if (!c.spark.hasData) { path("mo-spark-empty", "M3 17 L117 17"); return svg; }
    if (c.spark.area) path("mo-spark-area", c.spark.area);
    path("mo-spark-line", c.spark.line);
    var dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("class", "mo-spark-dot");
    dot.setAttribute("cx", String(c.spark.last.x)); dot.setAttribute("cy", String(c.spark.last.y)); dot.setAttribute("r", "3");
    svg.appendChild(dot);
    return svg;
  }

  function monitorCard(c, incidentsOpen) {
    var li = h("li", "mo-card" + (c.tone ? " " + c.tone : ""));
    var top = h("div", "mo-card-top");
    top.appendChild(h("b", null, c.name));
    top.appendChild(h("span", "chip" + (c.tone ? " " + c.tone : ""), c.label));
    li.appendChild(top);
    var mid = h("div", "mo-card-mid");
    var up = h("div", "mo-uptime");
    up.appendChild(h("span", "mo-pct", c.uptimeText));
    up.appendChild(h("span", "mo-cap", c.hasHistory ? "7-day uptime" : "no history yet"));
    mid.appendChild(up);
    mid.appendChild(sparkSvg(c));
    li.appendChild(mid);
    li.appendChild(h("p", "mo-facts-line", c.facts.join(" · ")));
    if (c.detail) li.appendChild(h("p", "mo-why", c.detail));
    if (c.ack && c.ack.acked) li.appendChild(h("p", "mo-note", c.ack.text));
    var foot = h("div", "mo-card-foot");
    if (c.ack) foot.appendChild(ackButton(c.id, c.name, c.ack.acked));
    if (c.label === "Down" && incidentsOpen) {
      var inc = h("a", "sub", "View the incident");
      inc.href = hashForTab("incidents");
      foot.appendChild(inc);
    }
    if (c.fix) {
      var a = h("a", "sub", c.fix.text);
      a.href = c.fix.href;
      if (/^https?:/.test(c.fix.href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      foot.appendChild(a);
    }
    if (foot.childNodes.length) li.appendChild(foot);
    return li;
  }

  function stat(label, value, tone, href) {
    var s = h(href ? "a" : "div", "mo-stat" + (tone ? " " + tone : ""));
    if (href) { s.href = href; s.classList.add("link"); }
    s.appendChild(h("b", null, String(value)));
    s.appendChild(h("span", null, label));
    return s;
  }

  function renderDashboard(root, st, now) {
    var tz = (st.settings && st.settings.businessHours && st.settings.businessHours.tz) || "Australia/Perth";
    var ov = overallState(st.monitors, st.derived), c = counts(st.monitors), sum = summarise(st.monitors, now);
    var chip = incidentsChip(model.inc);

    // the summary strip
    var hero = h("section", "mo-hero" + (ov.tone ? " " + ov.tone : ""));
    hero.setAttribute("aria-label", "Status summary");
    var lead = h("div", "mo-hero-lead");
    var state = h("div", "mo-hero-state");
    state.appendChild(h("span", "mo-dot" + (ov.tone ? " " + ov.tone : "")));
    state.appendChild(h("b", null, ov.label));
    lead.appendChild(state);
    lead.appendChild(h("p", "mo-hero-line", sum.headline + (sum.detail ? ". " + sum.detail : "")));
    hero.appendChild(lead);
    var stats = h("div", "mo-stats");
    stats.appendChild(stat("up", c.up, c.up ? "ok" : ""));
    stats.appendChild(stat("down", c.down, c.down ? "alert" : ""));
    stats.appendChild(stat("can’t tell", c.unknown + c.waiting, c.unknown ? "attn" : ""));
    if (chip) stats.appendChild(stat(chip.open === 1 ? "open incident" : "open incidents", chip.open, chip.open ? "alert" : "", hashForTab("incidents")));
    hero.appendChild(stats);
    var last = (st.monitors || []).reduce(function (a, m) { return Math.max(a, m.lastCheck || 0); }, 0);
    var act = h("div", "mo-hero-act");
    act.appendChild(h("span", "dim", last ? "Last check " + agoText(last, now) : "No check has run yet"));
    var ck = button("Check now", "btn btn-sm", "check");
    ck.id = "mon-check";
    ck.addEventListener("click", checkNow);
    act.appendChild(ck);
    hero.appendChild(act);
    root.appendChild(hero);

    if (model.note) root.appendChild(h("p", "mo-busy", model.note));
    var es = emailStatus(st);
    var ps = pushStatus(st);
    if (es.tone !== "ok") {
      var warn = h("p", "mo-setup");
      warn.appendChild(h("b", null, es.text + " "));
      var go = h("a", null, "Open Settings");
      go.href = "#settings";
      warn.appendChild(go);
      root.appendChild(warn);
    }
    if (st.pending) root.appendChild(h("p", "mo-note", st.pending + (st.pending === 1 ? " alert is" : " alerts are") + " waiting to be sent" + (st.inHours ? "." : " until working hours start.")));
    if (st.lastSend && st.lastSend.ok === false) root.appendChild(h("p", "mo-note", "The last send failed (" + st.lastSend.reason + ") " + agoText(st.lastSend.at, now) + "; it is tried again every 5 minutes."));
    if (ps.tone === "attn") root.appendChild(h("p", "mo-note", ps.text));
    var phl = pushHealthLine(st.pushHealth, tz, now);
    if (phl && phl.failing) {
      var pw = h("p", "mo-setup");
      pw.appendChild(h("b", null, phl.text + " "));
      var pg = h("a", null, "Open Settings");
      pg.href = "#settings";
      pw.appendChild(pg);
      root.appendChild(pw);
    }

    // the monitors, grouped
    groupCards(st.monitors, now, st.trend).forEach(function (g) {
      var sec = box(g.title, g.note, "mo-group");
      var grid = list("mo-grid");
      g.items.forEach(function (card) { var li = monitorCard(card, !!(chip && chip.open)); grid.appendChild(li); });
      sec.appendChild(grid);
      root.appendChild(sec);
    });

    // alerts and reporters side by side
    var cols = h("div", "mo-cols");
    cols.appendChild(alertsTimeline(st, tz, now));
    cols.appendChild(reportersBrief(st, now));
    root.appendChild(cols);

    root.appendChild(securityBox(now));
    // other people's own Monitoring spaces (my-monitoring.js): only when someone has one
    if (model.people && Array.isArray(model.people.people) && model.people.people.length && window.BarnyardMyMonitoring) {
      root.appendChild(window.BarnyardMyMonitoring.peopleBox(model.people, { onRemove: removeSpace }));
    }
  }

  function alertsTimeline(st, tz, now) {
    var sec = box("Recent alerts", "what was sent, held, pushed or acknowledged");
    var rows = timelineRows(st.history, [], tz, now).slice(0, 10);
    if (!rows.length) { sec.appendChild(h("p", "dim", "Nothing yet. Alerts appear here as they are sent.")); return sec; }
    var ul = list("mo-feed");
    rows.forEach(function (r) {
      var li = h("li");
      li.appendChild(h("span", "mo-when", r.when));
      li.appendChild(h("span", "chip" + (r.tone ? " " + r.tone : ""), r.kind));
      var body = h("span", "mo-feed-body");
      body.appendChild(h("b", null, r.subject));
      body.appendChild(h("span", "dim", r.result));
      li.appendChild(body);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return sec;
  }

  function reportersBrief(st, now) {
    var sec = box("Server reporters", "each server reporting on itself");
    var reports = bestReports(st.reporters);
    var ul = list("mo-rep");
    reporterCards(st.reporters, now).forEach(function (card) {
      var b = reporterBrief(card, reports[card.id] || null, Object.keys(model.known[card.id] || {}));
      var li = h("li", "mo-rep-row" + (b.tone ? " " + b.tone : ""));
      var top = h("div", "mo-rep-top");
      top.appendChild(h("b", null, b.name));
      top.appendChild(h("span", "chip" + (b.tone ? " " + b.tone : ""), b.label));
      li.appendChild(top);
      li.appendChild(h("p", "dim", b.line));
      if (b.bars.length) {
        var bars = h("div", "mo-bars");
        b.bars.forEach(function (x) {
          var row = h("div", "mo-bar-row");
          row.appendChild(h("span", "dim", x.label));
          var track = h("span", "mo-bar " + x.tone);
          var fill = h("span", "mo-bar-fill");
          fill.style.width = Math.max(2, Math.min(100, x.pct)) + "%";
          track.appendChild(fill);
          row.appendChild(track);
          row.appendChild(h("span", "mo-bar-n", x.pct + "%"));
          bars.appendChild(row);
        });
        li.appendChild(bars);
      }
      if (b.services.length) {
        var svc = h("div", "mo-svcs");
        b.services.forEach(function (x) {
          var tone = x.state === "up" ? "ok" : x.state === "down" ? "alert" : "";
          var word = x.state === "up" ? "running" : x.state === "down" ? "NOT running" : "can’t tell";
          var c = h("span", "chip" + (tone ? " " + tone : ""), x.name + ": " + word);
          if (x.state === "unknown") c.title = "The report did not say. The check on the server may itself have failed, which is not the same as the service being down.";
          svc.appendChild(c);
        });
        li.appendChild(svc);
      }
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    var rows = derivedRows(st.derived, now);
    if (rows.length) {
      sec.appendChild(h("h3", "mo-sub", "What the reports are saying"));
      var dl = list();
      rows.forEach(function (r) {
        var li = h("li");
        li.appendChild(h("span", "chip " + r.tone, r.label));
        li.appendChild(h("b", null, r.name));
        li.appendChild(h("span", "dim", r.text));
        if (r.ack) li.appendChild(ackButton(r.id, r.name, r.ack.acked));
        dl.appendChild(li);
      });
      sec.appendChild(dl);
    }
    var set = h("p", "mo-links");
    var a = h("a", "sub", "Make or revoke a key in Settings");
    a.href = "#settings";
    set.appendChild(a);
    sec.appendChild(set);
    return sec;
  }

  // Vulnerabilities and what is about to expire: already-built reads, taken once when the page opens and then every ten minutes at most.
  function securityBox(now) {
    var sec = box("Security and renewals", "read when the page opens, then every ten minutes");
    var rows = securityRows(model.vuln, model.hub, now);
    var ul = list();
    rows.forEach(function (r) {
      var li = h("li");
      li.appendChild(h("span", "chip" + (r.tone ? " " + r.tone : ""), r.value));
      li.appendChild(h("b", null, r.title));
      if (r.note) li.appendChild(h("span", "dim", r.note));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    var ex = expiryRows(model.hub);
    if (ex.length) {
      sec.appendChild(h("h3", "mo-sub", "Next to expire"));
      var el = list();
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
    var a2 = h("a", "sub", "System health"); a2.href = "health.html"; links.appendChild(a2);
    var a3 = h("a", "sub", "Activity feed"); a3.href = "activity.html"; links.appendChild(a3);
    sec.appendChild(links);
    return sec;
  }

  // ---- the Settings tab -----------------------------------------------------

  // Copies text with the clipboard API, or by selecting an input when that is not allowed.
  function copyText(text, input, done) {
    function fallback() {
      try { input.focus(); input.select(); document.execCommand("copy"); done(true); } catch (e) { done(false); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }

  function check(label, checked, key, onChange) {
    var l = h("label", "mo-check");
    var c = h("input"); c.type = "checkbox"; c.checked = !!checked; fk(c, key);
    c.addEventListener("change", function () { onChange(c); });
    l.appendChild(c); l.appendChild(h("span", null, label));
    return l;
  }

  function renderSettings(root, st, now) {
    var s = st.settings;
    var tz = (s.businessHours && s.businessHours.tz) || "Australia/Perth";
    var grid = h("div", "mo-settings");
    grid.appendChild(emailBox(st, s, now));
    grid.appendChild(hoursBox(s));
    grid.appendChild(switchesBox(st, s));
    grid.appendChild(phoneBox(st, s, now));
    grid.appendChild(keysBox(st, now));
    grid.appendChild(systemBox(st, tz, now));
    root.appendChild(grid);
  }

  function emailBox(st, s, now) {
    var al = box("Email", "who is told, and the test buttons");
    var es = emailStatus(st);
    var line = h("div", "mo-email " + es.tone);
    line.appendChild(h("b", null, es.text));
    if (es.hint) line.appendChild(h("span", "dim", es.hint));
    al.appendChild(line);
    al.appendChild(h("p", "dim", "An email needs the internet and Microsoft 365 to be working. If one of them is what is down, no email can reach you, so look at the Dashboard if something feels wrong."));

    al.appendChild(h("h3", "mo-sub", "Who is emailed"));
    var rl = list();
    if (!s.recipients.length) rl.appendChild(h("li", "dim", "Nobody yet."));
    s.recipients.forEach(function (addr) {
      var li = h("li");
      li.appendChild(h("b", null, addr));
      var rm = button("Remove", "btn btn-sm btn-quiet", "rm:" + addr);
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

    var tools = h("div", "mo-row");
    var test = button("Send test email", "btn btn-sm", "test-email");
    test.id = "mon-test";
    test.addEventListener("click", sendTest);
    tools.appendChild(test);
    var td = button("Send this week’s digest now", "btn btn-sm", "test-digest");
    td.id = "mon-test-digest";
    td.addEventListener("click", sendTestDigest);
    tools.appendChild(td);
    al.appendChild(tools);
    if (st.lastSend && st.lastSend.ok === false) al.appendChild(h("p", "mo-note", "The last send failed (" + st.lastSend.reason + ") " + agoText(st.lastSend.at, now) + "; it is tried again every 5 minutes."));
    return al;
  }

  function hoursBox(s) {
    var al = box("Working hours", "when you are emailed");
    var bh = s.businessHours;
    var hf = h("form", "mo-hours");
    hf.setAttribute("novalidate", "novalidate");
    var onWrap = h("label", "mo-check");
    var on = h("input"); on.type = "checkbox"; on.checked = !!bh.enabled; fk(on, "hours-on");
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
    return al;
  }

  function switchesBox(st, s) {
    var al = box("What emails you", "each one can be switched off");
    al.appendChild(h("h3", "mo-sub", "Email me when this goes down"));
    var ml = list();
    st.monitors.forEach(function (m) {
      var li = h("li");
      li.appendChild(check(m.name, m.alert, "mon:" + m.id, function (c) {
        var body = { monitors: {} }; body.monitors[m.id] = { alert: c.checked };
        saveSettings(body, c.checked ? "You will be emailed if " + m.name + " goes down." : "No email for " + m.name + ".");
      }));
      ml.appendChild(li);
    });
    al.appendChild(ml);
    al.appendChild(h("h3", "mo-sub", "Other alerts"));
    var gl = list();
    ALERT_SWITCHES.forEach(function (g) {
      var li = h("li");
      li.appendChild(check(g[1], !(s.alerts && s.alerts[g[0]] === false), "alert:" + g[0], function (c) {
        var body = { alerts: {} }; body.alerts[g[0]] = c.checked;
        saveSettings(body, c.checked ? "You will be emailed about that." : "No email about that.");
      }));
      gl.appendChild(li);
    });
    al.appendChild(gl);
    return al;
  }

  function phoneBox(st, s, now) {
    var al = box("Phone alerts", "ntfy");
    var ps = pushStatus(st);
    var pline = h("div", "mo-email " + ps.tone);
    pline.appendChild(h("b", null, ps.text));
    if (ps.hint) pline.appendChild(h("span", "dim", ps.hint));
    al.appendChild(pline);
    // how ntfy has actually been doing (the Worker's pushHealth; absent from an older Worker, null before the first push)
    var phl = pushHealthLine(st.pushHealth, (s.businessHours && s.businessHours.tz) || "Australia/Perth", now);
    if (phl) {
      var hl = h("div", "mo-email " + phl.tone);
      hl.setAttribute("role", phl.failing ? "alert" : "status");
      hl.appendChild(h("b", null, phl.text));
      if (phl.hint) hl.appendChild(h("span", "dim", phl.hint));
      al.appendChild(hl);
    }
    if (st.lastPush && st.lastPush.ok === false && !(phl && phl.failing)) al.appendChild(h("p", "mo-note", "The last push failed (" + st.lastPush.reason + ") " + agoText(st.lastPush.at, now) + "; it is tried again every 5 minutes."));
    var pset = (s && s.push) || { enabled: true, when: "fallback", types: {} };
    var pl = list();
    var onLi = h("li");
    onLi.appendChild(check("Send alerts to my phone", pset.enabled !== false, "push-on", function (c) { saveSettings({ push: { enabled: c.checked } }, c.checked ? "Phone alerts are on." : "Phone alerts are off."); }));
    pl.appendChild(onLi);
    var whenLi = h("li");
    whenLi.appendChild(check("Also push alerts that email carries (otherwise only outages email cannot carry, such as at night)", pset.when === "always", "push-always", function (c) {
      saveSettings({ push: { when: c.checked ? "always" : "fallback" } }, c.checked ? "Every alert will also go to your phone." : "Your phone is used only when email cannot carry an outage.");
    }));
    pl.appendChild(whenLi);
    PUSH_TYPES.forEach(function (g) {
      var li = h("li");
      li.appendChild(check(g[1], !!(pset.types && pset.types[g[0]]), "push:" + g[0], function (c) {
        var body = { push: { types: {} } }; body.push.types[g[0]] = c.checked;
        saveSettings(body, c.checked ? "That will be pushed." : "That will not be pushed.");
      }));
      pl.appendChild(li);
    });
    al.appendChild(pl);
    var prow = h("div", "mo-row");
    var tp = button("Send test push", "btn btn-sm", "test-push");
    tp.id = "mon-test-push";
    tp.addEventListener("click", sendTestPush);
    prow.appendChild(tp);
    al.appendChild(prow);
    return al;
  }

  // The keys for each server's reporter, and the box that shows a new key once.
  function keysBox(st, now) {
    var sec = box("Server reporters", "keys, once a minute");
    sec.appendChild(h("p", "dim", "Each server can report on itself and on the others. That tells a tunnel problem from a server that is down, notices a full disk or a stopped service, and spots the whole site losing power or internet. A key is shown once, only a fingerprint is kept, and you can revoke it any time."));
    var docs = h("a", "sub", "How to install the reporter on a server");
    docs.href = REPORTER_DOCS; docs.target = "_blank"; docs.rel = "noopener noreferrer";
    sec.appendChild(docs);

    if (model.newKey) {
      var nk = h("div", "mo-newkey");
      nk.appendChild(h("b", null, "Copy this key now. It will not be shown again."));
      nk.appendChild(h("span", "dim", "Paste both lines into /etc/barnyard-reporter/env on " + model.newKey.name + ", then run the installer (the install steps are linked above)."));
      var kb = h("textarea", "mo-input mo-keybox");
      kb.readOnly = true; kb.rows = 2; kb.value = envLines(model.newKey.server, model.newKey.key);
      kb.setAttribute("aria-label", "The new key, as two lines for the env file");
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

    var ul = list("mo-keycards");
    reporterCards(st.reporters, now).forEach(function (c) {
      var li = h("li", "mo-keycard" + (c.tone ? " " + c.tone : ""));
      var top = h("div", "mo-rep-top");
      top.appendChild(h("b", null, c.name));
      top.appendChild(h("span", "chip" + (c.tone ? " " + c.tone : ""), c.label));
      li.appendChild(top);
      li.appendChild(h("p", "dim", c.line));
      if (c.keys.length) {
        var kl = h("ul", "mo-keys");
        c.keys.forEach(function (k) {
          var kli = h("li");
          kli.appendChild(h("span", "dim", "Key …" + k.tail + " " + k.text));
          if (k.canRevoke) {
            var rv = button("Revoke", "btn btn-sm btn-quiet", "revoke:" + k.id);
            rv.setAttribute("aria-label", "Revoke key ending " + k.tail + " for " + c.name);
            rv.addEventListener("click", function () { revokeKey(k.id, c.name); });
            kli.appendChild(rv);
          }
          kl.appendChild(kli);
        });
        li.appendChild(kl);
      }
      var mk = button("Make a key", "btn btn-sm", "mk:" + c.id);
      mk.disabled = !c.canMake || model.busy;
      mk.setAttribute("aria-label", "Make a key for " + c.name);
      mk.addEventListener("click", function () { makeKey(c.id, c.name); });
      li.appendChild(mk);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return sec;
  }

  function systemBox(st, tz, now) {
    var sec = box("About monitoring", "status of the system itself");
    var ul = list();
    var tick = st.lastTick && st.lastTick.at ? st.lastTick.at : 0;
    [
      ["Checks run", "every 5 minutes from the Worker" + (tick ? "; the last one finished " + agoText(tick, now) : "")],
      ["Email waiting", String(st.pending || 0) + (st.pending ? (st.inHours ? " (sent on the next check)" : " (held until working hours start)") : "")],
      ["Working hours now", st.inHours ? "inside " + hoursText(st.settings.businessHours) : "outside " + hoursText(st.settings.businessHours)],
      ["Kill switch", "set the Worker variable MONITOR_ENABLED to 0 in Cloudflare to switch monitoring off; remove it to switch it back on"],
      ["Page reads", "the Dashboard asks for the status once a minute while it is open and visible; Settings does not poll"]
    ].forEach(function (r) {
      var li = h("li");
      li.appendChild(h("b", null, r[0]));
      li.appendChild(h("span", "dim", r[1]));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return sec;
  }

  // ---- 4. actions -----------------------------------------------------------

  var BUSY_IDS = ["mon-check", "mon-test", "mon-test-push", "mon-test-digest", "mon-refresh"];

  function setBusy(on) {
    model.busy = on;
    BUSY_IDS.forEach(function (id) { var b = $(id); if (b) b.disabled = on; });
    if (!on) tickCheck();
  }

  function send(method, path, body) {
    var init = { method: method };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return getJson(MON + path, init);
  }

  // Used by every action that answers with a fresh status: keeps the page's copy and its clock in step.
  function adopt(body) { model.mon = body; model.fetchedAt = Date.now(); model.stale = false; rememberServices(body && body.reporters); }

  function busyAnswer(r) { return r.status === 429 || r.status === 0; }

  function saveSettings(body, okText) {
    if (model.busy) return;
    setBusy(true);
    send("PUT", "/settings", body).then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { adopt(r.body); render(); flash(okText, "ok"); }
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: busyAnswer(r) ? "rate_limited" : r.status ? "failed" : "offline" }), "alert");
    });
  }

  function makeKey(server, name) {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/reporters", { server: server }).then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok && r.body.key) {
        var key = r.body.key;
        delete r.body.key;                       // the status copy kept in the page never holds the key
        adopt(r.body);
        model.newKey = { server: server, name: name, key: key };
        render();
        flash("Key made for " + name + ". Copy it now: it is not shown again.", "ok");
      } else flash(keyErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  function revokeKey(id, name) {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/reporters/revoke", { id: id }).then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { adopt(r.body); render(); flash("Key revoked for " + name + ". A reporter using it stops being accepted at once.", "ok"); }
      else flash(keyErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  // The three test buttons do not re-read the status: the answer to them is only "sent", and the history on the Dashboard is
  // read the next time that tab opens (model.stale), which saves a request.
  function sendTest() {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/test-email").then(function (r) {
      setBusy(false);
      model.stale = true;
      if (r.status === 200 && r.body && r.body.ok) flash("Test email sent to " + r.body.sent + (r.body.sent === 1 ? " address." : " addresses.") + " It should arrive within a minute.", "ok");
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  function sendTestPush() {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/test-push").then(function (r) {
      setBusy(false);
      model.stale = true;
      if (r.status === 200 && r.body && r.body.ok) flash("Test push sent. It should reach your phone within a few seconds.", "ok");
      else flash(pushErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  function sendTestDigest() {
    if (model.busy) return;
    setBusy(true);
    send("POST", "/test-digest").then(function (r) {
      setBusy(false);
      model.stale = true;
      if (r.status === 200 && r.body && r.body.ok) flash("This week’s digest was sent to " + r.body.sent + (r.body.sent === 1 ? " address." : " addresses.") + " It should arrive within a minute.", "ok");
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  // Acknowledge an outage (stop its reminders until it is back up), or take that back.
  function acknowledge(id, name, on) {
    if (model.busy) return;
    setBusy(true);
    var body = { monitor: id };
    if (!on) body.undo = true;
    send("POST", "/acknowledge", body).then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { adopt(r.body); render(); flash(on ? "Acknowledged. No more reminders about " + name + " until it is back up." : "Reminders about " + name + " are back on.", "ok"); }
      else if (r.body && (r.body.error === "not_down")) { flash(name + " is not down any more.", ""); fetchStatus({ force: true }); }
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: busyAnswer(r) ? "rate_limited" : r.status ? "failed" : "offline" }), "alert");
    });
  }

  // "Check now": the Worker allows one every 30 seconds, so the button counts that down instead of failing when pressed early.
  function tickCheck() {
    clearTimeout(checkTimer);
    var b = $("mon-check");
    if (!b) return;
    var sec = checkWait(model.checkUntil, Date.now());
    b.textContent = checkLabel(sec);
    b.disabled = sec > 0 || model.busy;
    if (sec > 0) checkTimer = setTimeout(tickCheck, 1000);
  }

  function checkNow() {
    if (model.busy || checkWait(model.checkUntil, Date.now()) > 0) return;
    model.checkUntil = Date.now() + CHECK_GAP_MS;
    setBusy(true);
    tickCheck();
    send("POST", "/check").then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { adopt(r.body); render(); flash("Checked just now.", "ok"); }
      else if (r.body && r.body.error === "rate_limited") { model.checkUntil = Date.now() + (r.body.retryMs || CHECK_GAP_MS); tickCheck(); flash("Too soon: it can run again in " + checkWait(model.checkUntil, Date.now()) + " seconds.", ""); }
      else if (busyAnswer(r)) { flash("The Worker is busy. Try again in a minute.", ""); }
      else flash(mailErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  // The Refresh button: one read, no more than once every few seconds, and the optional reads too.
  // Takes one person's own space away (the owner's People list). Needs a recent sign-in; asks first.
  function removeSpace(space, name) {
    if (model.busy) return;
    if (typeof window.confirm === "function" && !window.confirm("Remove " + name + "'s Monitoring? Everything they watch and every key they made is deleted.")) return;
    setBusy(true);
    send("POST", "/people/remove", { space: space }).then(function (r) {
      setBusy(false);
      if (r.status === 200 && r.body && r.body.ok) { model.people = r.body.enabled ? r.body : null; render(); flash(name + "’s Monitoring was removed.", "ok"); }
      else flash(keyErrorText(r.body && r.body.error ? r.body : { error: "failed" }), "alert");
    });
  }

  function refresh() {
    if (model.mine && window.BarnyardMyMonitoring) { window.BarnyardMyMonitoring.refresh(); return; }
    var now = Date.now();
    if (model.inflight || now - model.lastRefreshAt < MIN_REFRESH_MS) return;
    model.lastRefreshAt = now;
    model.backoffUntil = 0;
    fetchStatus({ force: true });
  }

  // ---- tabs -----------------------------------------------------------------

  function setTab(tab) {
    if (allowedTabs(model.ext).indexOf(tab) === -1) tab = "dashboard";
    var changed = model.tab !== tab;
    var was = model.tab;
    model.tab = tab;
    if (changed && isExt(was)) stopExt(was);
    render();
    if (changed) revealTab();
    if (isExt(tab)) {
      // the Dashboard's poll waits while another tab is open; the tab's own script starts (and polls) from here
      clearTimeout(pollTimer);
      if (changed) startExt(tab);
      return;
    }
    if (!changed && model.state !== "ok") return;
    clearTimeout(pollTimer);
    if (model.state !== "ok") return;
    var now = Date.now();
    if (tab === "settings") { if (settingsNeedsRead(model.fetchedAt, now)) fetchStatus({ force: true }); return; }
    if (model.stale || pollDue({ hidden: document.hidden, tab: tab, state: model.state, busy: model.busy, inflight: model.inflight, backoffUntil: model.backoffUntil, fetchedAt: model.fetchedAt, now: now })) fetchStatus({ force: model.stale });
    else { fetchExtras(false); schedule(); }
  }

  function bindTabs() {
    var list = $("mon-tabs");
    if (!list) return;
    TABS.forEach(function (t) {
      var b = $("tab-" + t);
      if (!b) return;
      b.addEventListener("click", function () { if (location.hash !== hashForTab(t)) location.hash = hashForTab(t); else setTab(t); });
    });
    list.addEventListener("keydown", function (ev) {
      var to = nextTab(model.tab, ev.key, allowedTabs(model.ext));
      if (!to) return;
      ev.preventDefault();
      var b = $("tab-" + to);
      if (b) b.focus();
      location.hash = hashForTab(to);
    });
    window.addEventListener("hashchange", function () { setTab(tabFromHash(location.hash, allowedTabs(model.ext))); });
  }

  function boot() {
    var rf = $("mon-refresh");
    if (rf) rf.addEventListener("click", refresh);
    model.tab = tabFromHash(location.hash);
    bindTabs();
    updateTabs();
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { clearTimeout(pollTimer); return; }
      if (pollDue(snapshot())) fetchStatus(); else schedule();
    });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      // The hub owner gets the page below; everyone else gets their own separate space (my-monitoring.js). An unknown answer
      // (an older Worker, no session yet) keeps the owner's page, which the Worker refuses to anyone who is not the owner.
      whoIsKnown().then(function (who) {
        if (who && who.owner === false && window.BarnyardMyMonitoring) { model.mine = true; window.BarnyardMyMonitoring.start(); return; }
        // The owner's extra tabs, now that who they are is known; a link straight to one (#incidents/inc_abcd1234) opens it.
        var T = window.BarnyardTheme;
        model.ext = extTabsFor(who, T && T.who ? T.who.permits : null);
        var want = tabFromHash(location.hash, allowedTabs(model.ext));
        if (want !== model.tab) { model.tab = want; render(); revealTab(); if (isExt(want)) startExt(want); }
        fetchStatus({ force: true });
      });
    });
  }

  // The signed-in person, once the shell has asked who they are (a few seconds at most).
  function whoIsKnown() {
    return new Promise(function (resolve) {
      var T = window.BarnyardTheme;   // themes.js names it BarnyardTheme (this used to ask for window.Theme, which nothing defines, so the person was never known)
      if (!T || !T.who) { resolve(null); return; }
      var done = false;
      function finish(s) { if (!done) { done = true; resolve(s || null); } }
      T.who.onChange(finish);
      T.who.load();
      setTimeout(function () { finish(T.who.get()); }, 4000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardMonitoring = helpers;
})();
