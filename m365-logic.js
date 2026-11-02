// The Microsoft 365 page's words and rules, with no DOM and no network (m365.js uses them; test/m365.test.js covers them).
//
// The Worker's GET /m365/health (ClaudeRepo's cloudflare-worker/src/m365-routes.js, owner only) answers with one snapshot in
// sections ({ licences, mfa, accounts, roles, policies, score }); each section has its own state: ok, needs_permission (names the
// permission to add), needs_premium (the tenant has no Entra ID P1/P2, so no permission would help), not_available, or error.
// Everything here turns that into plain words, a tone (ok / attn / alert / "") and the rows a table shows.
//
// Browser: window.BarnyardM365Logic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var DAY = 86400000;

  var TITLES = { licences: "Licences", mfa: "Multi-factor sign-in", accounts: "Accounts", roles: "Admin roles", policies: "Conditional Access", score: "Secure score" };
  var ORDER = ["licences", "mfa", "accounts", "roles", "policies", "score"];

  var ERRORS = {
    unauthenticated: "Sign in to see this page.",
    forbidden: "This page is only for the hub owner.",
    m365_disabled: "This page is switched off (the Worker variable M365_ENABLED is 0).",
    recent_sign_in_required: "Sign in again, then repeat that. It needs a recent sign-in.",
    rate_limited: "Microsoft was read a moment ago. Try again in a minute.",
    secret_detected: "That note looks like it contains a key or password. Take it out and try again.",
    unknown_field: "That could not be saved.", checked_invalid: "That could not be saved.", note_invalid: "The note has to be plain text.", body_invalid: "That could not be saved."
  };

  function errorText(body, status) {
    var code = body && typeof body.error === "string" ? body.error : "";
    if (ERRORS[code]) return ERRORS[code];
    if (status === 0) return "Could not reach the Worker. Check your connection and try again.";
    return "That did not work (" + (code || "error " + status) + ").";
  }

  // "3 days ago", "just now", "never".
  function agoText(ts, now) {
    if (!ts) return "never";
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.round(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  function dateText(ms) {
    if (!ms) return "";
    return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Perth", day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // Why the whole read failed: a short sentence with Microsoft's own code when there is one.
  function failureText(f) {
    if (!f) return "";
    var code = f.detail ? " (" + f.detail + ")" : "";
    if (f.reason === "auth") return "The read-only app could not sign in" + code + ". Its secret may have expired or been changed. Check it under Calendar renewals, then press Refresh.";
    if (f.reason === "throttled") return "Microsoft asked us to slow down. The numbers below are from the last good read. Try again in a few minutes.";
    if (f.reason === "unavailable") return "Microsoft could not be reached. The numbers below are from the last good read.";
    if (f.reason === "registry_unavailable") return "The Worker's store is not available, so nothing can be kept.";
    return "Microsoft could not be read" + code + ". The numbers below are from the last good read.";
  }

  // ---- the state of a card -------------------------------------------------------------------------------------------------

  // What a card that is not "ok" says. `needs` are the permissions it is missing (names only).
  function stateModel(id, s) {
    if (!s || s.state === "not_run") return { tone: "", head: "Not read yet", text: "Press Refresh to read Microsoft." };
    if (s.state === "needs_permission") return { tone: "attn", head: "Needs " + (s.needs && s.needs.length === 1 ? "a permission" : "permissions"), text: "Add " + (s.needs || []).join(" and ") + " to the read-only app, grant admin consent, then press Refresh.", needs: s.needs || [] };
    if (s.state === "needs_premium") return { tone: "", head: "Needs Entra ID P1 or P2", text: "Microsoft only gives this to tenants with a premium Entra ID licence. Adding permissions will not change that.", needs: [] };
    if (s.state === "not_available") return { tone: "", head: "Not available", text: "Microsoft has nothing to show for this in your tenant." };
    if (s.state === "error") return { tone: "alert", head: "Could not be read", text: failureText({ reason: s.reason, detail: s.detail }).replace(/ The numbers below are from the last good read\./, ""), needs: [] };
    return null;
  }

  // The little line a stale card carries when Microsoft hiccuped and the last good numbers are being shown.
  function staleNote(s) { return s && s.fromEarlier === true ? "Microsoft could not be read this time, so these are from the last good read." : ""; }

  // ---- licences -----------------------------------------------------------------------------------------------------------

  function licenceRows(s) {
    return ((s && s.skus) || []).map(function (k) {
      return { name: k.name, part: k.part, bought: k.bought, assigned: k.assigned, unused: k.unused, free: !!k.free, over: k.over || 0,
        tone: k.over > 0 ? "alert" : (!k.free && k.unused > 0 ? "attn" : ""), note: k.over > 0 ? k.over + " more used than bought" : (k.free ? "free" : "") };
    });
  }
  function licenceHead(s) {
    var n = (s && s.unusedTotal) || 0;
    if (!s || !s.paidSkus) return { tone: "", head: "No paid licences found", text: "" };
    if (n === 0) return { tone: "ok", head: "Every paid licence is in use", text: plural(s.paidSkus, "paid licence type", "paid licence types") + "." };
    return { tone: "attn", head: plural(n, "paid licence is", "paid licences are") + " unused", text: "Take them off people who left, or buy fewer next renewal." };
  }

  // ---- MFA ----------------------------------------------------------------------------------------------------------------

  function mfaHead(s) {
    if (!s || s.pct === null || s.pct === undefined) return { tone: "", head: "No accounts to check", text: "" };
    var tone = s.adminsWithout > 0 ? "alert" : (s.pct >= 100 ? "ok" : "attn");
    var text = s.registered + " of " + s.members + " people have registered a second sign-in step.";
    if (s.adminsWithout > 0) text += " " + plural(s.adminsWithout, "admin has", "admins have") + " not.";
    return { tone: tone, head: s.pct + "% covered", text: text };
  }

  // ---- accounts -----------------------------------------------------------------------------------------------------------

  function accountsHead(s) {
    if (!s) return { tone: "", head: "", text: "" };
    var bits = [plural(s.members, "member", "members"), plural(s.guests, "guest", "guests"), s.disabled + " disabled"];
    var tone = "ok", head = "No stale accounts";
    if (s.stale === null || s.stale === undefined) { tone = ""; head = "Sign-in dates not available"; }
    else if (s.stale.d90 > 0) { tone = "alert"; head = plural(s.stale.d90, "account has", "accounts have") + " not signed in for 90 days"; }
    else if (s.stale.d60 > 0) { tone = "attn"; head = plural(s.stale.d60, "account has", "accounts have") + " not signed in for 60 days"; }
    return { tone: tone, head: head, text: bits.join(", ") + "." + (s.truncated ? " The list was cut short: only the first accounts Microsoft sent are counted." : "") };
  }
  function signInNote(s) {
    if (!s || s.signIn) return "";
    if (s.signInState === "needs_premium") return "Each person's last sign-in needs Entra ID P1 or P2 in your tenant, so stale accounts cannot be shown.";
    if (s.signInState === "needs_permission") return "To see who has not signed in, add " + ((s.signInNeeds || []).join(" and ") || "AuditLog.Read.All") + " to the read-only app, grant admin consent, then press Refresh.";
    return "Sign-in dates could not be read this time.";
  }
  function peopleRows(list, mode) {
    return (list || []).map(function (p) {
      var since = p.daysSince === null || p.daysSince === undefined ? "never" : p.daysSince + (p.daysSince === 1 ? " day" : " days");
      return { name: p.name || p.upn, upn: p.upn, since: since, age: p.age === null || p.age === undefined ? "" : p.age + (p.age === 1 ? " day" : " days"), licences: p.licences || 0, off: mode === "guest" && p.enabled === false, tone: p.daysSince !== null && p.daysSince >= 90 ? "alert" : "" };
    });
  }

  // ---- roles --------------------------------------------------------------------------------------------------------------

  function rolesHead(s) {
    if (!s) return { tone: "", head: "", text: "" };
    var ga = s.globalAdmins || 0;
    var tone = ga > 4 || ga < 2 ? "attn" : "ok";
    var text = plural(s.privilegedPeople, "person holds", "people hold") + " a privileged role. Microsoft suggests between two and four Global Administrators.";
    return { tone: tone, head: plural(ga, "Global Administrator", "Global Administrators"), text: text };
  }
  function memberText(m) {
    var base = m.name || m.upn || "(unnamed)";
    var tag = m.type === "group" ? " (group: its members are not listed)" : m.type === "app" ? " (app)" : "";
    return base + tag + (m.scoped ? " (limited scope)" : "");
  }

  // ---- Conditional Access -------------------------------------------------------------------------------------------------

  function policiesHead(s) {
    if (!s) return { tone: "", head: "", text: "" };
    if (!s.total) return { tone: "attn", head: "No Conditional Access policies", text: "Nothing is requiring MFA or blocking risky sign-ins by policy." };
    var text = plural(s.on, "policy is", "policies are") + " on" + (s.reportOnly ? ", " + s.reportOnly + " report-only" : "") + (s.off ? ", " + s.off + " off" : "") + ".";
    return { tone: s.on > 0 ? "ok" : "attn", head: plural(s.total, "policy", "policies"), text: text };
  }

  // ---- secure score -------------------------------------------------------------------------------------------------------

  function scoreHead(s) {
    if (!s) return { tone: "", head: "", text: "" };
    var tone = s.pct >= 70 ? "ok" : s.pct >= 40 ? "attn" : "alert";
    return { tone: tone, head: s.current + " of " + s.max + " (" + s.pct + "%)", text: "Microsoft's own score for how well the tenant is set up. " + (s.at ? "Measured " + dateText(s.at) + "." : "") };
  }
  function gapRows(s) {
    return ((s && s.gaps) || []).map(function (g) { return { title: g.title, gap: g.gap, meta: [g.service, g.impact ? "user impact: " + g.impact.toLowerCase() : "", g.cost ? "effort: " + g.cost.toLowerCase() : ""].filter(Boolean).join(" · ") }; });
  }

  // ---- the strip across the top -------------------------------------------------------------------------------------------

  // [{ label, value, tone }] from the headline numbers the Worker sends; a number that is null (its card is not ready) is left out.
  function stats(h) {
    var out = [];
    function add(label, value, tone) { if (value !== null && value !== undefined) out.push({ label: label, value: String(value), tone: tone }); }
    h = h || {};
    add("Admins", h.admins, h.globalAdmins !== null && h.globalAdmins !== undefined && (h.globalAdmins > 4 || h.globalAdmins < 2) ? "attn" : "");
    add("People without MFA", h.withoutMfa, h.withoutMfa > 0 ? "attn" : "ok");
    add("Not signed in for 60 days", h.stale60, h.stale60 > 0 ? "attn" : "ok");
    add("Guests", h.guests, "");
    add("Unused paid licences", h.unusedLicences, h.unusedLicences > 0 ? "attn" : "ok");
    add("Admins to look at", h.adminsToCheck, h.adminsToCheck > 0 ? "attn" : "ok");
    add("Secure score", h.scorePct === null || h.scorePct === undefined ? h.scorePct : h.scorePct + "%", h.scorePct >= 70 ? "ok" : h.scorePct >= 40 ? "attn" : "alert");
    return out;
  }

  // ---- phase 2: the detail inside the cards -------------------------------------------------------------------------------------

  // The people who hold a privileged role: [{ name, upn, roles, flags, tone }], flagged ones first (the Worker already sorts them).
  function adminRows(s) {
    var p = s && s.people;
    if (!p || !p.rows) return [];
    return p.rows.map(function (r) {
      var bad = (r.flags || []).some(function (f) { return /no second sign-in step|account disabled|never signed in/.test(f); });
      return { name: r.name || r.upn, upn: r.upn || "", roles: (r.roles || []).join(", "), flags: r.flags || [], tone: bad ? "alert" : ((r.flags || []).length ? "attn" : "") };
    });
  }
  function adminsHead(s) {
    var p = s && s.people;
    if (!p) return null;
    if (!p.count) return { tone: "", head: "No one holds a privileged role directly", text: "" };
    if (!p.flagged) return { tone: "ok", head: plural(p.count, "admin", "admins") + ", nothing to flag", text: "Each one signs in, has a second step, and holds few roles." };
    return { tone: "attn", head: plural(p.flagged, "admin", "admins") + " worth a look", text: "Out of " + p.count + ". The flags say why." };
  }
  // The eligible-assignments part of the admin roles card (its own small state; the card itself stays ok without it).
  function eligibleModel(s) {
    var e = s && s.eligible;
    if (!e) return null;
    if (e.state === "ok") {
      if (!e.count) return { tone: "", head: "No eligible assignments", text: "Nobody can switch a role on when needed.", rows: [] };
      return { tone: e.permanent > 0 ? "attn" : "ok", head: plural(e.count, "eligible assignment", "eligible assignments"), text: (e.permanent ? plural(e.permanent, "has", "have") + " no end date. " : "All have an end date. ") + "These people can switch a role on when needed; they are not permanent admins.",
        rows: (e.rows || []).map(function (r) { return { role: r.role, who: r.name || r.upn || "(unnamed)", upn: r.upn || "", ends: r.permanent ? "no end date" : (r.ends ? dateText(r.ends) : ""), tone: r.permanent ? "attn" : "" }; }) };
    }
    if (e.state === "needs_permission") return { tone: "", head: "Eligible roles not read", text: "To see who can switch an admin role on when needed, add " + ((e.needs || []).join(" and ") || "RoleEligibilitySchedule.Read.Directory") + " (optional) to the read-only app and grant admin consent. It also needs Entra ID P2.", rows: [] };
    if (e.state === "needs_premium") return { tone: "", head: "Eligible roles need Entra ID P2", text: "Microsoft only lists these for tenants with Privileged Identity Management. Adding permissions will not change that.", rows: [] };
    return { tone: "", head: "Eligible roles could not be read", text: "Microsoft could not be asked this time.", rows: [] };
  }

  // Guests: [{ label, count, tone }] for the age bands, in order, then the lines under them.
  function guestBands(s) {
    var b = s && s.guestBands;
    if (!b) return [];
    return [["Under 30 days", b.d30, ""], ["30 to 90 days", b.d90, ""], ["90 days to a year", b.d365, ""], ["Over a year", b.older, b.older > 0 ? "attn" : ""], ["Age unknown", b.unknown, ""]]
      .filter(function (r) { return r[1] > 0 || r[0] !== "Age unknown"; }).map(function (r) { return { label: r[0], count: r[1], tone: r[1] > 0 ? r[2] : "" }; });
  }
  function guestNotes(s) {
    var out = [];
    if (!s) return out;
    if (s.guestPending && s.guestPending.count) out.push({ tone: "attn", text: plural(s.guestPending.count, "invitation was", "invitations were") + " never accepted." });
    if (s.guestLicensed) out.push({ tone: "attn", text: plural(s.guestLicensed, "guest holds", "guests hold") + " a paid licence." });
    if (s.guestDomains && s.guestDomains.length) out.push({ tone: "", text: "Mostly from " + s.guestDomains.slice(0, 5).map(function (d) { return d.domain + " (" + d.count + ")"; }).join(", ") + "." });
    return out;
  }

  // Conditional Access: what each policy covers, and the baseline protections that exist.
  function policyRows(s) {
    return ((s && s.rows) || []).map(function (p) {
      return { name: p.name, state: p.state, tone: p.state === "off" ? "attn" : "", summary: p.summary || "", changed: p.modified ? dateText(p.modified) : "" };
    });
  }
  function policyChecks(s) {
    return ((s && s.checks) || []).map(function (c) {
      var text = c.state === "yes" ? "In place" + (c.policy ? ": " + c.policy : "") : c.state === "report-only" ? "Only reporting" + (c.policy ? ": " + c.policy : "") : "Not found";
      return { label: c.label, state: c.state, text: text, tone: c.state === "yes" ? "ok" : c.state === "report-only" ? "attn" : "alert" };
    });
  }

  // Secure score: the sentence about the trend and the points for a small line (each 0 to 100, oldest first).
  function scoreTrend(s) {
    var t = s && s.trend;
    if (!t || !t.points || t.points.length < 2) return { text: "", points: [], tone: "" };
    var d = t.delta30, label = "month";
    if (d === null || d === undefined) { d = t.delta7; label = "week"; }
    var text = "";
    if (d === null || d === undefined) text = "Not enough history to show a trend yet.";
    else if (d > 0) text = "Up " + d + " points in the last " + label + ".";
    else if (d < 0) text = "Down " + Math.abs(d) + " points in the last " + label + ".";
    else text = "No change in the last " + label + ".";
    return { text: text, points: t.points.map(function (p) { return p.pct; }), tone: d > 0 ? "ok" : d < 0 ? "alert" : "" };
  }

  // ---- phase 3: the quarterly review ---------------------------------------------------------------------------------------

  var TONE_WORDS = { check: "Check", ok: "Fine", unknown: "Not known" };
  // The checklist the Worker built from the snapshot -> [{ id, title, how, detail, tone, word }]. Empty until something has been read.
  function checklistRows(data) {
    return ((data && data.checklist) || []).map(function (i) {
      return { id: i.id, title: i.title, how: i.how, detail: i.detail || "", tone: i.tone === "check" ? "attn" : i.tone === "ok" ? "ok" : "", word: TONE_WORDS[i.tone] || "" };
    });
  }
  // What changed since the last recorded review, as short lines. null from the Worker means there was nothing to compare with.
  function changesModel(c, now) {
    if (!c) return { none: true, lines: [], text: "The next review will say what changed since it. This one has nothing to compare with yet." };
    var lines = [];
    function list(label, items) { if (items && items.length) lines.push(label + ": " + items.slice(0, 8).join(", ") + (items.length > 8 ? " and " + (items.length - 8) + " more" : "")); }
    list("New admins", c.adminsAdded); list("No longer admins", c.adminsRemoved);
    list("New policies", c.policiesAdded); list("Removed policies", c.policiesRemoved);
    (c.policiesChanged || []).forEach(function (p) { lines.push("Policy " + p.name + " went from " + p.from + " to " + p.to + "."); });
    if (c.guests && c.guests.from !== c.guests.to) lines.push("Guests: " + c.guests.from + " to " + c.guests.to + ".");
    if (c.score && c.score.from !== c.score.to) lines.push("Secure score: " + c.score.from + "% to " + c.score.to + "%.");
    var since = dateText(c.since);
    return { none: false, lines: lines, text: lines.length ? "Since the review on " + since + ":" : "Nothing has changed since the review on " + since + "." };
  }
  // Earlier reviews: "12 Oct 2026: 7 of 10 lines ticked. Note".
  function reviewHistory(reviews, total) {
    return (reviews || []).map(function (r) {
      var ticks = r.checked === null || r.checked === undefined ? "" : r.checked.length + " of " + total + " lines ticked";
      return { text: dateText(r.at) + (ticks ? ": " + ticks + "." : "") + (r.note ? " " + r.note : "") };
    });
  }

  // ---- the access review --------------------------------------------------------------------------------------------------

  function reviewModel(review, now) {
    if (!review || !review.last) return { tone: "attn", head: "No review recorded yet", text: "Go through the lines below, tick each one you have done, then record the review. Do it every three months." };
    if (review.due) return { tone: "attn", head: "A review is due", text: "The last one was " + dateText(review.last.at) + " (" + agoText(review.last.at, now) + ")." + (review.last.note ? " Note: " + review.last.note : "") };
    return { tone: "ok", head: "Reviewed " + dateText(review.last.at), text: "The next one is due in " + plural(review.daysLeft, "day", "days") + "." + (review.last.note ? " Note: " + review.last.note : "") };
  }

  // The list of steps and permissions the set-up panel shows, only when something is still missing.
  function setupNeeded(data) {
    if (!data) return false;
    if (data.configured === false) return true;
    var s = (data.snapshot && data.snapshot.sections) || {};
    return ORDER.some(function (id) { return s[id] && (s[id].state === "needs_permission" || (id === "accounts" && s[id].signInState === "needs_permission")); });
  }
  function missingPermissions(data) {
    var seen = {}, out = [];
    var s = (data && data.snapshot && data.snapshot.sections) || {};
    ORDER.forEach(function (id) {
      var list = s[id] && s[id].state === "needs_permission" ? (s[id].needs || []) : (id === "accounts" && s[id] && s[id].signInState === "needs_permission" ? (s[id].signInNeeds || []) : []);
      list.forEach(function (p) { if (!seen[p]) { seen[p] = 1; out.push(p); } });
    });
    return out;
  }

  var api = {
    TITLES: TITLES, ORDER: ORDER, ERRORS: ERRORS, errorText: errorText, agoText: agoText, dateText: dateText, failureText: failureText, stateModel: stateModel,
    staleNote: staleNote, licenceRows: licenceRows, licenceHead: licenceHead, mfaHead: mfaHead, accountsHead: accountsHead, signInNote: signInNote, peopleRows: peopleRows,
    rolesHead: rolesHead, memberText: memberText, policiesHead: policiesHead, scoreHead: scoreHead, gapRows: gapRows, stats: stats, reviewModel: reviewModel,
    setupNeeded: setupNeeded, missingPermissions: missingPermissions,
    adminRows: adminRows, adminsHead: adminsHead, eligibleModel: eligibleModel, guestBands: guestBands, guestNotes: guestNotes, policyRows: policyRows, policyChecks: policyChecks,
    scoreTrend: scoreTrend, checklistRows: checklistRows, changesModel: changesModel, reviewHistory: reviewHistory
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardM365Logic = api;
})(typeof window !== "undefined" ? window : this);
