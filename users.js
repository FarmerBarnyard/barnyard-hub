// The Users page (users.html): everyone with access to the site (people who have signed in, and people Entra lists in
// the access groups who have not yet), what each of them can see, and the owner's controls to hide or limit areas, set an
// access-until date, suspend or remove them. The owner's page.
//
// Reads and writes /users/* on the Worker (ClaudeRepo's cloudflare-worker/src/access-routes.js, owner only):
//   GET  /users/catalogue   the areas, the presets and what each preset means
//   GET  /users/list        the people, their status and what each can see, plus `directory`: whether the Entra read is set up and what it last did
//   POST /users/refresh     read the Entra groups' members now (needs a recent sign-in; once a minute)
//   GET  /users/user?key=   one person, with the latest changes made to them
//   PUT  /users/user        { key, preset, caps, until, note }  (needs a recent sign-in)
//   POST /users/suspend | /users/restore | /users/remove   { key }  (need a recent sign-in)
//
// The Worker is what refuses a restricted person; this page only edits the rules and previews them. The preview uses
// the same arithmetic as the Worker (the lowest of what the Entra groups allow and the owner's cap), kept in step by
// test/users.test.js. Everything from the server reaches the page through textContent, never as markup.
//
// Layout of this file: 1. pure helpers (exported for test; no DOM, no network)  2. data  3. rendering  4. actions

(function () {
  "use strict";

  var API = "https://api.barnyard.site/users";

  // ---- 1. pure helpers ------------------------------------------------------

  var RANK = { none: 0, view: 1, edit: 2 };
  var GROUP_NAME = { "barnyard-hub-sso": "Hub", "study-hub-sso": "Study", "campaign-hub-sso": "Campaign" };
  var STATUS_TEXT = { owner: "Owner", active: "Active", suspended: "Suspended", expired: "Access ended", left: "Left the Entra groups" };

  function groupLabels(groups) {
    var out = [];
    (Array.isArray(groups) ? groups : []).forEach(function (g) { if (GROUP_NAME[g] && out.indexOf(GROUP_NAME[g]) === -1) out.push(GROUP_NAME[g]); });
    return out;
  }

  function agoText(ts, now) {
    if (!ts) return "never";
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days < 60 ? days + (days === 1 ? " day ago" : " days ago") : Math.round(days / 30) + " months ago";
  }

  // What the Entra groups alone allow for one area: "none", "view" or "edit". `groupIds` is the catalogue's { hub, study, campaign }.
  function baseLevel(area, groups, groupIds) {
    if (area.needs === null) return "none";
    var g = Array.isArray(groups) ? groups : [];
    var ok;
    if (area.needs === "any") ok = Object.keys(groupIds).some(function (k) { return g.indexOf(groupIds[k]) !== -1; });
    else ok = g.indexOf(groupIds[area.needs]) !== -1;
    if (!ok) return "none";
    return area.levels.indexOf("edit") !== -1 ? "edit" : "view";
  }

  // The lowest of the groups' level and the owner's cap (an edit-only capability has no read-only form).
  function effectiveLevel(area, base, cap) {
    if (!cap) return base;
    if (cap === "view" && area.levels.indexOf("view") === -1) cap = "none";
    return RANK[cap] < RANK[base] ? cap : base;
  }

  function isEnded(until, now) {
    return typeof until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(until) && now > Date.parse(until + "T23:59:59.999Z");
  }

  // Whether the Entra read lists this person, and whether they have yet to sign in / have left every access group.
  function neverSignedIn(u) { return !!(u && u.directory && (u.neverSignedIn === true || !u.signIns)); }
  function leftGroups(u) { return !!(u && u.directory && u.directory.state === "removed"); }

  // The state a person is in right now: owner | suspended | expired | left | active.
  function statusOf(user, now) {
    if (user.isOwner) return "owner";
    if (user.status === "suspended") return "suspended";
    if (isEnded(user.until, now)) return "expired";
    if (leftGroups(user)) return "left";
    return "active";
  }

  // Small facts beside the status: [{ text, tone }] for never signed in, guest, disabled account.
  function rowBadges(u) {
    var out = [];
    if (neverSignedIn(u)) out.push({ text: "Not signed in yet", tone: "plain" });
    if (u && u.directory && u.directory.guest) out.push({ text: "Guest", tone: "plain" });
    if (u && u.directory && u.directory.enabled === false) out.push({ text: "Account disabled", tone: "alert" });
    return out;
  }

  function lastSignInText(u, now) {
    if (neverSignedIn(u)) return "Has not signed in yet";
    return "Last sign-in " + agoText(u.lastSeen, now);
  }

  // "Left every Entra group 3 days ago; comes off this list on 12 Dec 2026."
  function leftText(u, now) {
    var d = u && u.directory;
    if (!d || d.state !== "removed") return "";
    var drops = d.dropsAt ? new Date(d.dropsAt).toISOString().slice(0, 10) : "";
    return "No longer in any Entra access group (" + agoText(d.removedAt, now) + ")" + (drops ? "; comes off this list on " + drops + ", and what you changed for them stays in the change log" : "") + ".";
  }

  var REASON_TEXT = {
    not_configured: "the Worker does not have the three GRAPH_READ settings yet",
    no_groups: "the Worker's group list (ENTRA_GROUP_MAP) is missing or unreadable",
    auth: "Microsoft refused the read-only app's sign-in. Check that GRAPH_READ_CLIENT_SECRET has not expired or been mistyped, and that the tenant and client ids are right",
    forbidden: "the app is not allowed to read group members. In Entra, open the app's API permissions and check GroupMember.Read.All is an Application permission with admin consent granted",
    not_found: "a group in the Worker's group list was not found in Entra",
    bad_request: "Microsoft rejected the request",
    throttled: "Microsoft asked us to slow down; it will work on the next try",
    unavailable: "Microsoft could not be reached; it will work on the next try",
    too_large: "a group is larger than the list this page reads in one go",
    empty: "Microsoft returned nobody at all, which usually means the app lost its permission",
    ids_only: "Microsoft returned ids but no names: the Graph app needs the User.ReadBasic.All permission (application) with admin consent, then press Read again"
  };
  function reasonText(reason, detail) {
    var t = REASON_TEXT[reason] || "an unexpected problem";
    return t + (detail ? " (Microsoft's code: " + detail + ")" : "") + ".";
  }
  var LIMIT_WORDS = { accountEnabled: "whether accounts are enabled", userType: "which accounts are guests", address: "email addresses", name: "names" };

  // What the page says about the Entra read, from /users/list's `directory`: { tone: "" | "warn", lines: [], canRefresh }.
  function directoryNote(dir, now) {
    var out = { tone: "", lines: [], canRefresh: false };
    if (!dir) return out;
    if (!dir.configured) {
      out.tone = "warn";
      out.lines.push("Only people who have signed in are listed. To list everyone in the Entra groups, the Worker needs the read-only Entra app's settings." + (dir.missing && dir.missing.length ? " Missing: " + dir.missing.join(", ") + "." : ""));
      return out;
    }
    out.canRefresh = true;
    var st = dir.status || {}, last = st.last;
    if (!last) { out.lines.push("The Entra groups have not been read yet. Use the button to read them now; it also runs by itself each day."); return out; }
    if (!last.ok) {
      out.tone = "warn";
      out.lines.push("The last read of the Entra groups (" + agoText(last.at, now) + ") failed: " + reasonText(last.reason, last.detail));
      if (st.goodAt) out.lines.push("The list below is from the last good read, " + agoText(st.goodAt, now) + ".");
      return out;
    }
    out.lines.push("Entra groups read " + agoText(last.at, now) + ": " + (st.members || 0) + (st.members === 1 ? " person" : " people") + " in them" + (st.removed ? ", " + st.removed + " recently left" : "") + ".");
    var bad = (last.groups || []).filter(function (g) { return !g.ok; });
    if (last.partial && bad.length) {
      out.tone = "warn";
      out.lines.push("Some groups could not be read (" + bad.map(function (g) { return g.name + (g.detail ? ": " + g.detail : g.reason ? ": " + g.reason : ""); }).join("; ") + "), so nobody is marked as having left until every group reads.");
    }
    if (last.held) {
      out.tone = "warn";
      out.lines.push(last.held + " people dropped out of the Entra list at once, so none were marked as having left. If that is wrong, check the read-only app's permission, then read again.");
    }
    var lim = (last.limits || []).map(function (l) { return LIMIT_WORDS[l]; }).filter(Boolean);
    if (lim.length) out.lines.push("Microsoft did not return " + lim.join(", ") + " for this app, so those read as unknown. People who sign in are matched to the list by their directory id.");
    return out;
  }

  // What they would see with these caps: { status, tabs: [{id,label,level}], capabilities: [...], tiles: [...], hidden: n }.
  // `caps` is the draft: { areaId: "none" | "view" }.
  function previewModel(catalogue, groups, caps, status) {
    var out = { status: status, tabs: [], capabilities: [], tiles: [], hidden: 0 };
    var ended = status === "suspended" || status === "expired";
    catalogue.areas.forEach(function (a) {
      var base = baseLevel(a, groups, catalogue.groups);
      var level = ended ? "none" : effectiveLevel(a, base, caps && caps[a.id]);
      if (level === "none") { if (base !== "none") out.hidden++; return; }
      var row = { id: a.id, label: a.label, level: level, readOnly: level === "view" && a.levels.indexOf("edit") !== -1 };
      (a.kind === "tab" ? out.tabs : a.kind === "tile" ? out.tiles : out.capabilities).push(row);
    });
    return out;
  }

  // Search by name or email, and a status filter: all | active | restricted | suspended | ended.
  function filterUsers(users, query, status, now) {
    var q = String(query || "").trim().toLowerCase();
    return (users || []).filter(function (u) {
      if (q && (u.name || "").toLowerCase().indexOf(q) === -1 && (u.email || "").toLowerCase().indexOf(q) === -1) return false;
      var s = statusOf(u, now);
      if (status === "suspended") return s === "suspended";
      if (status === "ended") return s === "expired";
      if (status === "never") return neverSignedIn(u);
      if (status === "left") return s === "left";
      if (status === "restricted") return s === "active" && Object.keys(u.caps || {}).length > 0;
      if (status === "active") return s === "active" || s === "owner";
      return true;
    });
  }

  // The Worker's error word, in plain language.
  function errorText(r) {
    var err = r && r.error;
    if (err === "recent_sign_in_required") return "For safety this needs a recent sign-in. Sign in again, then repeat it.";
    if (err === "owner_protected") return "The owner cannot be restricted, suspended or removed from here.";
    if (err === "unauthenticated") return "You are signed out. Sign in again.";
    if (err === "forbidden") return "Only the site owner can use this page.";
    if (err === "not_found") return "That person is no longer in the list. Refresh the page.";
    if (err === "secret_detected") return "The note looks like it holds a password or key. Remove it and try again.";
    if (err === "until_invalid") return "That date is not valid.";
    if (err === "area_owner_only") return "That area is always owner only.";
    if (err === "access_not_configured") return "The access store is not set up on the Worker yet.";
    if (err === "rate_limited") return r && r.retryMs > 0 ? "Entra was read a moment ago. Wait about " + Math.max(1, Math.ceil(r.retryMs / 1000)) + " seconds, then try again." : "That was too many requests at once. Wait a moment.";
    return "That did not work. Try again in a moment.";
  }

  function auditText(entry) {
    var a = entry && entry.action;
    if (a === "listed") return "Found in the Entra groups; has not signed in yet";
    if (a === "directory_linked") return "Matched to the Entra list" + (entry.detail ? " (" + entry.detail + ")" : "");
    if (a === "left_groups") return "No longer in any Entra access group";
    if (a === "rejoined") return "Back in the Entra groups";
    if (a === "dropped_off") return "Taken off the list after 30 days out of the Entra groups";
    if (a === "first_seen") return "First seen" + (entry.detail ? " (" + entry.detail + ")" : "");
    if (a === "permissions") return "Permissions changed: " + (entry.detail || "");
    if (a === "suspend") return "Suspended";
    if (a === "restore") return "Restored";
    return String(a || "") + (entry && entry.detail ? ": " + entry.detail : "");
  }

  var helpers = { groupLabels: groupLabels, agoText: agoText, baseLevel: baseLevel, effectiveLevel: effectiveLevel, isEnded: isEnded, statusOf: statusOf, previewModel: previewModel, filterUsers: filterUsers, errorText: errorText, auditText: auditText, STATUS_TEXT: STATUS_TEXT,
    neverSignedIn: neverSignedIn, leftGroups: leftGroups, rowBadges: rowBadges, lastSignInText: lastSignInText, leftText: leftText, reasonText: reasonText, directoryNote: directoryNote };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data --------------------------------------------------------------

  var model = { state: "loading", cat: null, list: null, selected: null, detail: null, draft: null, flash: null, busy: false, query: "", status: "all", confirm: null };

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
    return getJson(API + path, { method: method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  function load() {
    var needCat = model.cat ? Promise.resolve(null) : getJson(API + "/catalogue", {});
    return Promise.all([needCat, getJson(API + "/list", {})]).then(function (res) {
      var list = res[1];
      if (list.status === 401) { model.state = "guest"; return; }
      if (list.status === 403) { model.state = "forbidden"; return; }
      if (list.status === 0 || list.status >= 500 || !list.body || !list.body.ok) { model.state = model.list ? "ok" : "error"; return; }
      if (res[0] && res[0].status === 200 && res[0].body.ok) model.cat = res[0].body;
      if (!model.cat) { model.state = "error"; return; }
      model.list = list.body;
      model.state = "ok";
    }).then(render);
  }

  function openUser(key) {
    model.selected = key; model.detail = null; model.draft = null; model.confirm = null;
    render();
    return getJson(API + "/user?key=" + encodeURIComponent(key), {}).then(function (r) {
      if (r.status !== 200 || !r.body.ok) { flash(errorText(r.body), "alert"); closeDrawer(); return; }
      model.detail = r.body;
      model.draft = { preset: r.body.user.preset || "", caps: JSON.parse(JSON.stringify(r.body.user.caps || {})), until: r.body.user.until || "", note: r.body.user.note || "" };
      render();
      var d = $("us-drawer"); if (d) { var t = d.querySelector("h2"); if (t) t.focus(); }
    });
  }
  function closeDrawer() { model.selected = null; model.detail = null; model.draft = null; model.confirm = null; render(); }

  // ---- 3. rendering ---------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function flash(text, tone) { model.flash = text ? { text: text, tone: tone || "" } : null; var f = $("us-flash"); if (f) paintFlash(f); }
  function paintFlash(f) {
    f.hidden = !model.flash;
    f.className = "mo-flash" + (model.flash && model.flash.tone ? " " + model.flash.tone : "");
    f.textContent = model.flash ? model.flash.text : "";
  }

  function message(text, linkText, href) {
    var box = $("us-root"); clear(box);
    var p = h("p", "mo-off", text + " ");
    if (linkText && href) { var a = h("a", null, linkText); a.href = href; p.appendChild(a); }
    box.appendChild(p);
  }

  function pill(text, tone) { return h("span", "us-pill" + (tone ? " " + tone : ""), text); }

  function render() {
    var root = $("us-root"); if (!root) return;
    if (model.state === "loading") { message("Loading…"); return; }
    if (model.state === "guest") { message("Log in to manage users.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null); return; }
    if (model.state === "forbidden") { message("This page is only for the site owner."); return; }
    if (model.state === "error") { message("The user list could not be loaded. Check your connection and refresh."); return; }
    clear(root);
    var now = model.list.now || Date.now();

    var f = h("p", null); f.id = "us-flash"; f.setAttribute("role", "status"); paintFlash(f); root.appendChild(f);

    if (model.list.enforcement === false) {
      root.appendChild(h("p", "us-warn", "Restrictions are switched off on the Worker (ACCESS_ENFORCEMENT is 0), so nothing set here is being applied right now."));
    }
    var note = h("div", "us-note");
    note.appendChild(h("p", null, "Entra's groups are the real way in and out. Suspending someone here stops the site working for them at once, but they should also be removed from the Entra group. Restrictions can only lower what their groups already allow."));
    note.appendChild(h("p", "dim", "Each person's name, email, groups and sign-in times are stored here (never a password, token, IP address or browser details), and Remove forgets them."));
    root.appendChild(note);

    // what the Entra read has done, why not, and the button to run it now
    var dn = directoryNote(model.list.directory, now);
    if (dn.lines.length) {
      var box = h("div", "us-entra" + (dn.tone === "warn" ? " warn" : "")); box.id = "us-entra-note";
      dn.lines.forEach(function (line) { box.appendChild(h("p", null, line)); });
      if (dn.canRefresh) {
        var eb = h("button", "btn btn-sm", model.reading ? "Reading Entra…" : "Read the Entra groups now"); eb.type = "button"; eb.id = "us-entra"; eb.disabled = !!model.reading;
        eb.addEventListener("click", readEntra);
        box.appendChild(eb);
      }
      root.appendChild(box);
    }

    // filters
    var bar = h("div", "us-bar");
    var q = h("input", "mo-input"); q.type = "search"; q.id = "us-q"; q.placeholder = "Search name or email"; q.value = model.query; q.setAttribute("aria-label", "Search people");
    q.addEventListener("input", function () { model.query = q.value; renderList(); });
    var sel = h("select", "mo-input"); sel.id = "us-status"; sel.setAttribute("aria-label", "Filter by status");
    [["all", "Everyone"], ["active", "Active"], ["never", "Not signed in yet"], ["restricted", "Restricted"], ["suspended", "Suspended"], ["ended", "Access ended"], ["left", "Left the Entra groups"]].forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; if (o[0] === model.status) op.selected = true; sel.appendChild(op); });
    sel.addEventListener("change", function () { model.status = sel.value; renderList(); });
    bar.appendChild(q); bar.appendChild(sel);
    root.appendChild(bar);

    var list = h("ul", "us-list"); list.id = "us-list"; root.appendChild(list);
    renderList();

    if (model.selected) renderDrawer(root);
  }

  function renderList() {
    var ul = $("us-list"); if (!ul) return; clear(ul);
    var now = model.list.now || Date.now();
    var rows = filterUsers(model.list.users, model.query, model.status, now);
    if (!rows.length) { ul.appendChild(h("li", "dim", model.list.users.length ? "Nobody matches." : model.list.directory && model.list.directory.configured ? "Nobody is listed yet. Read the Entra groups above." : "Nobody has signed in yet.")); return; }
    rows.forEach(function (u) {
      var st = statusOf(u, now);
      var li = h("li", "us-row" + (st === "suspended" || st === "expired" || st === "left" ? " off" : ""));
      var who = h("div", "us-who");
      who.appendChild(h("b", null, u.name || "(no name)"));
      who.appendChild(h("span", "dim", u.email || ""));
      li.appendChild(who);
      var meta = h("div", "us-meta");
      meta.appendChild(pill(STATUS_TEXT[st], st === "active" ? "ok" : st === "owner" ? "" : "alert"));
      rowBadges(u).forEach(function (b) { meta.appendChild(pill(b.text, b.tone)); });
      groupLabels(u.groups).forEach(function (g) { meta.appendChild(pill(g, "plain")); });
      meta.appendChild(h("span", "dim", lastSignInText(u, now)));
      li.appendChild(meta);
      li.appendChild(h("p", "us-sum", st === "left" ? leftText(u, now) : st === "active" ? "Can see: " + u.summary : u.summary));
      var open = h("button", "btn btn-sm", u.isOwner ? "View" : "Open"); open.type = "button";
      open.setAttribute("aria-label", "Open " + (u.name || u.email));
      open.addEventListener("click", function () { openUser(u.key); });
      li.appendChild(open);
      ul.appendChild(li);
    });
  }

  function areaGroups() {
    var groups = [["tab", "Tabs"], ["capability", "Capabilities"], ["tile", "Overview tiles"]];
    return groups.map(function (g) { return { title: g[1], areas: model.cat.areas.filter(function (a) { return a.kind === g[0]; }) }; });
  }

  function renderDrawer(root) {
    var back = h("div", "us-back"); back.addEventListener("click", closeDrawer); root.appendChild(back);
    var d = h("aside", "us-drawer"); d.id = "us-drawer"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-labelledby", "us-dtitle");
    d.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
    root.appendChild(d);
    if (!model.detail || !model.draft) { d.appendChild(h("p", "dim", "Loading…")); return; }
    var u = model.detail.user, now = model.detail.now || Date.now(), draft = model.draft;
    var st = statusOf(u, now);

    var head = h("div", "us-dhead");
    var t = h("h2", null, u.name || "(no name)"); t.id = "us-dtitle"; t.tabIndex = -1;
    head.appendChild(t);
    var x = h("button", "btn btn-sm btn-quiet", "Close"); x.type = "button"; x.addEventListener("click", closeDrawer); head.appendChild(x);
    d.appendChild(head);
    d.appendChild(h("p", "dim", (u.email || "") + " · " + (groupLabels(u.groups).join(", ") || "no site groups") + " · " + (neverSignedIn(u) ? "has not signed in yet" : "first seen " + agoText(u.firstSeen, now) + " · " + u.signIns + (u.signIns === 1 ? " sign-in" : " sign-ins"))));
    var pr = h("p", null); pr.appendChild(pill(STATUS_TEXT[st], st === "active" ? "ok" : st === "owner" ? "" : "alert"));
    rowBadges(u).forEach(function (b) { pr.appendChild(document.createTextNode(" ")); pr.appendChild(pill(b.text, b.tone)); });
    d.appendChild(pr);
    if (u.directory && u.directory.state === "member") {
      var inEntra = groupLabels(u.directory.groups).join(", ") || "no site groups";
      d.appendChild(h("p", "dim", "In Entra now: " + inEntra + (u.directory.enabled === null ? "" : u.directory.enabled ? " · account enabled" : " · account disabled") + " · read " + agoText(u.directory.listedAt, now)));
      if (neverSignedIn(u)) d.appendChild(h("p", "dim", "What you set here applies from their first sign-in."));
    }
    if (leftGroups(u)) d.appendChild(h("p", "us-warn", leftText(u, now)));

    if (u.isOwner) {
      d.appendChild(h("p", "us-note", "This is you. The owner can always see and do everything, and cannot be restricted, suspended or removed from here."));
      return;
    }

    // preset
    var pf = h("label", "mo-field", "Role preset"); pf.setAttribute("for", "us-preset");
    var ps = h("select", "mo-input"); ps.id = "us-preset";
    var none = h("option", null, "(none chosen)"); none.value = ""; ps.appendChild(none);
    model.cat.presets.forEach(function (p) { var o = h("option", null, p.label); o.value = p.name; if (p.name === draft.preset) o.selected = true; ps.appendChild(o); });
    ps.addEventListener("change", function () {
      draft.preset = ps.value;
      var p = model.cat.presets.filter(function (x) { return x.name === ps.value; })[0];
      if (p && p.caps) draft.caps = JSON.parse(JSON.stringify(p.caps));
      renderDrawerBody();
    });
    pf.appendChild(ps); d.appendChild(pf);
    var about = h("p", "dim"); about.id = "us-about"; d.appendChild(about);

    var body = h("div"); body.id = "us-dbody"; d.appendChild(body);
    renderDrawerBody();
  }

  function renderDrawerBody() {
    var body = $("us-dbody"); if (!body) return; clear(body);
    var u = model.detail.user, now = model.detail.now || Date.now(), draft = model.draft;
    var preset = model.cat.presets.filter(function (p) { return p.name === draft.preset; })[0];
    var about = $("us-about"); if (about) about.textContent = preset ? preset.about : "Pick a preset to fill in the table, or set each area by hand.";

    // matrix
    body.appendChild(h("h3", "mo-sub", "What they can use"));
    areaGroups().forEach(function (g) {
      if (!g.areas.length) return;
      body.appendChild(h("p", "us-gtitle", g.title));
      var ul = h("ul", "us-matrix");
      g.areas.forEach(function (a) {
        var base = baseLevel(a, u.groups, model.cat.groups);
        var li = h("li", "us-mrow");
        var lab = h("label", null, a.label); lab.setAttribute("for", "us-m-" + a.id);
        li.appendChild(lab);
        var s = h("select", "mo-input"); s.id = "us-m-" + a.id;
        if (a.needs === null) { li.appendChild(h("span", "dim", "Owner only")); ul.appendChild(li); return; }
        if (base === "none") { li.appendChild(h("span", "dim", "Not in their Entra groups")); ul.appendChild(li); return; }
        var opts = [["edit", a.levels.indexOf("edit") !== -1 ? "Full access" : "Allowed"]];
        if (a.levels.indexOf("edit") !== -1 && a.levels.indexOf("view") !== -1) opts.push(["view", "Read only"]);
        opts.push(["none", "Hidden"]);
        var cur = draft.caps[a.id] || "edit";
        opts.forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; if (o[0] === cur) op.selected = true; s.appendChild(op); });
        s.addEventListener("change", function () { if (s.value === "edit") delete draft.caps[a.id]; else draft.caps[a.id] = s.value; draft.preset = draft.preset && model.cat.presets.filter(function (p) { return p.name === draft.preset && p.caps; }).length ? "Custom" : draft.preset; var ps = $("us-preset"); if (ps) ps.value = draft.preset || ""; renderPreview(); });
        li.appendChild(s);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    });

    // until and note
    var row = h("div", "mo-row");
    var uf = h("label", "mo-field", "Access until (optional)"); uf.setAttribute("for", "us-until");
    var ui = h("input", "mo-input"); ui.type = "date"; ui.id = "us-until"; ui.value = draft.until || "";
    ui.addEventListener("change", function () { draft.until = ui.value; renderPreview(); });
    uf.appendChild(ui); row.appendChild(uf);
    var nf = h("label", "mo-field", "Note (only you see it)"); nf.setAttribute("for", "us-note");
    var ni = h("input", "mo-input"); ni.type = "text"; ni.id = "us-note"; ni.maxLength = 200; ni.value = draft.note || "";
    ni.addEventListener("input", function () { draft.note = ni.value; });
    nf.appendChild(ni); row.appendChild(nf);
    body.appendChild(row);
    body.appendChild(h("p", "dim", "Access ends at the end of that day (UTC). Leave it empty for no end date."));

    // preview
    body.appendChild(h("h3", "mo-sub", "Preview as this person"));
    var pv = h("div", "us-preview"); pv.id = "us-preview"; body.appendChild(pv);
    renderPreview();

    // actions
    var acts = h("div", "mo-row");
    var save = h("button", "btn", "Save changes"); save.type = "button"; save.id = "us-save"; save.disabled = model.busy; save.addEventListener("click", saveUser); acts.appendChild(save);
    var susp = u.status === "suspended";
    var sb = h("button", "btn btn-quiet", susp ? "Restore access" : "Suspend"); sb.type = "button"; sb.addEventListener("click", function () { if (susp) setStatus("restore"); else { model.confirm = "suspend"; renderConfirm(); } });
    acts.appendChild(sb);
    var rb = h("button", "btn btn-quiet", "Remove from list"); rb.type = "button"; rb.addEventListener("click", function () { model.confirm = "remove"; renderConfirm(); });
    acts.appendChild(rb);
    body.appendChild(acts);
    var cf = h("div"); cf.id = "us-confirm"; body.appendChild(cf);
    renderConfirm();

    // audit
    body.appendChild(h("h3", "mo-sub", "Recent changes"));
    var au = h("ul", "us-audit");
    var audit = model.detail.audit || [];
    if (!audit.length) au.appendChild(h("li", "dim", "Nothing yet."));
    audit.slice(0, 12).forEach(function (a) { au.appendChild(h("li", null, agoText(a.ts, now) + ": " + auditText(a))); });
    body.appendChild(au);
  }

  function renderPreview() {
    var pv = $("us-preview"); if (!pv) return; clear(pv);
    var u = model.detail.user, now = model.detail.now || Date.now(), draft = model.draft;
    var st = u.status === "suspended" ? "suspended" : isEnded(draft.until, now) ? "expired" : "active";
    var m = previewModel(model.cat, u.groups, draft.caps, st);
    if (st !== "active") { pv.appendChild(h("p", "us-warn", st === "suspended" ? "Suspended: they would see nothing and every request is refused." : "That date has passed: their access has ended and they would see nothing.")); return; }
    var line = function (title, rows) {
      var p = h("p", null); p.appendChild(h("b", null, title + ": "));
      p.appendChild(document.createTextNode(rows.length ? rows.map(function (r) { return r.label + (r.readOnly ? " (read only)" : ""); }).join(", ") : "none"));
      pv.appendChild(p);
    };
    line("Menu", m.tabs); line("Capabilities", m.capabilities); line("Overview tiles", m.tiles);
    if (m.hidden) pv.appendChild(h("p", "dim", m.hidden + (m.hidden === 1 ? " area is" : " areas are") + " hidden by your settings. Unsaved changes show here before they apply."));
  }

  function renderConfirm() {
    var cf = $("us-confirm"); if (!cf) return; clear(cf);
    if (!model.confirm) return;
    var u = model.detail.user;
    var box = h("div", "us-confirm");
    box.appendChild(h("p", null, model.confirm === "suspend"
      ? "Suspend " + (u.name || u.email) + "? Every page and request stops working for them straight away. You can restore them any time."
      : "Remove " + (u.name || u.email) + " from the list? Their record and the changes logged for them are deleted. They come back if they sign in again" + (u.directory && u.directory.state === "member" ? ", or the next time the Entra groups are read while they are still in one," : "") + " with no restrictions."));
    var yes = h("button", "btn", model.confirm === "suspend" ? "Suspend" : "Remove"); yes.type = "button";
    yes.addEventListener("click", function () { var what = model.confirm; model.confirm = null; if (what === "suspend") setStatus("suspend"); else removeUser(); });
    var no = h("button", "btn btn-quiet", "Cancel"); no.type = "button"; no.addEventListener("click", function () { model.confirm = null; renderConfirm(); });
    box.appendChild(yes); box.appendChild(no);
    cf.appendChild(box);
  }

  // ---- 4. actions -----------------------------------------------------------

  function afterChange(r, okText) {
    model.busy = false;
    if (r.status === 200 && r.body && r.body.ok) { flash(okText, "ok"); return load().then(function () { return model.selected ? openUser(model.selected) : null; }); }
    flash(errorText(r.body), "alert"); render();
    return null;
  }
  function saveUser() {
    if (model.busy || !model.draft) return;
    model.busy = true;
    var d = model.draft;
    send("PUT", "/user", { key: model.selected, preset: d.preset || "", caps: d.caps, until: d.until || null, note: d.note || "" }).then(function (r) { afterChange(r, "Saved. It applies within a minute."); });
  }
  // Reads the Entra groups' members now (the Worker allows it once a minute and needs a recent sign-in).
  function readEntra() {
    if (model.reading) return;
    model.reading = true; render();
    send("POST", "/refresh").then(function (r) {
      model.reading = false;
      var b = r.body || {};
      if (r.status !== 200) { flash(errorText(b), "alert"); render(); return; }
      var res = b.result || {};
      if (!b.ok) flash("The Entra groups could not be read: " + reasonText(res.reason, res.detail), "alert");
      else if (res.partial) flash("Read part of the Entra groups. See the note below for what could not be read.", "alert");
      else flash("Entra read: " + res.counts.members + (res.counts.members === 1 ? " person" : " people") + ", " + res.counts.added + " new, " + res.counts.removed + " marked as left.", "ok");
      load();
    });
  }
  function setStatus(what) {
    if (model.busy) return;
    model.busy = true;
    send("POST", "/" + what, { key: model.selected }).then(function (r) { afterChange(r, what === "suspend" ? "Suspended. They are refused everywhere within a minute." : "Restored."); });
  }
  function removeUser() {
    if (model.busy) return;
    model.busy = true;
    send("POST", "/remove", { key: model.selected }).then(function (r) {
      model.busy = false;
      if (r.status === 200 && r.body && r.body.ok) { model.selected = null; model.detail = null; model.draft = null; flash("Removed from the list.", "ok"); load(); }
      else { flash(errorText(r.body), "alert"); render(); }
    });
  }

  function boot() {
    var rf = $("us-refresh");
    if (rf) rf.addEventListener("click", function () { load(); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.BarnyardUsers = helpers;
})();
