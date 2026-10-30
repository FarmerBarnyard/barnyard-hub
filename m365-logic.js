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
    unknown_field: "That could not be saved.", note_invalid: "The note has to be plain text.", body_invalid: "That could not be saved."
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
    return out;
  }

  // ---- the access review --------------------------------------------------------------------------------------------------

  function reviewModel(review, now) {
    if (!review || !review.last) return { tone: "attn", head: "No review recorded yet", text: "Go through the admins, guests and stale accounts above, then record the date here. Do it every three months." };
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
    setupNeeded: setupNeeded, missingPermissions: missingPermissions
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardM365Logic = api;
})(typeof window !== "undefined" ? window : this);
