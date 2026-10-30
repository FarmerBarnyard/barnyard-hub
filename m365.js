// The Microsoft 365 page (m365.html): licences, MFA registration, stale and unused accounts, guests, admin roles, Conditional Access
// policies and the secure score, with a record of the quarterly access review. The owner's page, like Services and Incidents.
//
// Reads and writes /m365/* on the Worker (ClaudeRepo's cloudflare-worker/src/m365-routes.js, owner only, read only towards Microsoft):
//   GET  /m365/health    the snapshot, what each card needs, the review history (the Worker reads Microsoft by itself at most once a day)
//   POST /m365/refresh   read Microsoft now, with a new token, once a minute
//   POST /m365/review    { note? } record that the access review was done (needs a recent sign-in)
// The words and rules are in m365-logic.js (tested in test/m365.test.js); this file draws them. The page asks once when it opens and
// again only when Refresh is pressed: the numbers change at most daily, so there is nothing to poll.
//
// Everything from the server reaches the page as plain text through textContent (the CSP has no 'unsafe-inline' for scripts or
// styles, and no markup from the server is ever parsed). People's names and sign-in names are shown because only the owner can
// reach this page.

(function () {
  "use strict";

  var L = window.BarnyardM365Logic;
  var API = "https://api.barnyard.site";
  if (!L) return;

  var model = { state: "loading", data: null, flash: null, busy: false };

  // ---- data -----------------------------------------------------------------------------------------------------------------

  function send(method, path, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 60000);   // a read of Microsoft can take a while
    var init = { method: method, credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    return fetch(API + "/m365" + path, init).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  // Sets the page's state from a refusal; true when it was one.
  function failState(r) {
    if (r.status === 401) { model.state = "guest"; return true; }
    if (r.status === 403 && r.body && r.body.error === "forbidden") { model.state = "forbidden"; return true; }
    if (r.status === 403 && r.body && r.body.error === "m365_disabled") { model.state = "off"; return true; }
    return false;
  }

  function load() {
    return send("GET", "/health").then(function (r) {
      if (failState(r)) return;
      if (r.status !== 200 || !r.body || r.body.ok !== true) { model.state = model.data ? "ok" : "error"; return; }
      model.data = r.body; model.state = "ok";
    });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== null && text !== undefined) e.textContent = text;
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function chip(text, tone) { return h("span", "chip" + (tone ? " " + tone : ""), text); }

  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var f = $("m3-flash");
    if (!f) return;
    f.hidden = !text;
    f.className = "m3-flash" + (tone ? " " + tone : "");
    f.textContent = text || "";
  }

  // A table. cols: [{ h, num }]; rows: arrays of cells, a cell being a string or { text, cls, sub }.
  function table(cols, rows) {
    var wrap = h("div", "m3-scroll"), t = h("table", "m3-table"), head = h("tr");
    cols.forEach(function (c) { head.appendChild(h("th", c.num ? "num" : "", c.h)); });
    var thead = h("thead"); thead.appendChild(head); t.appendChild(thead);
    var body = h("tbody");
    rows.forEach(function (r) {
      var tr = h("tr");
      r.forEach(function (cell, i) {
        var c = typeof cell === "object" && cell !== null ? cell : { text: cell };
        var td = h("td", (cols[i] && cols[i].num ? "num " : "") + (c.cls || ""), c.text);
        if (c.sub) td.appendChild(h("span", "m3-sub", c.sub));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    t.appendChild(body); wrap.appendChild(t);
    return wrap;
  }

  function headLine(m) {
    var d = h("div", "m3-head" + (m.tone ? " " + m.tone : ""));
    if (m.head) d.appendChild(h("b", null, m.head));
    if (m.text) d.appendChild(h("span", null, m.text));
    return d;
  }

  // A card for one section. `fill(card, section)` draws the body when the section is ok.
  function card(id, section, fill) {
    var c = h("section", "m3-card");
    var title = h("h2", null, L.TITLES[id]);
    var sm = L.stateModel(id, section);
    if (sm && sm.head) title.appendChild(chip(sm.head, sm.tone));
    c.appendChild(title);
    if (sm) { c.appendChild(h("p", "dim", sm.text)); return c; }
    var stale = L.staleNote(section);
    if (stale) c.appendChild(h("p", "dim small", stale));
    fill(c, section);
    return c;
  }

  function fillLicences(c, s) {
    c.appendChild(headLine(L.licenceHead(s)));
    var rows = L.licenceRows(s);
    if (!rows.length) return;
    c.appendChild(table([{ h: "Licence" }, { h: "Bought", num: true }, { h: "In use", num: true }, { h: "Unused", num: true }],
      rows.map(function (r) { return [{ text: r.name, sub: r.note }, String(r.bought), String(r.assigned), { text: String(r.unused), cls: r.tone }]; })));
  }

  function fillMfa(c, s) {
    c.appendChild(headLine(L.mfaHead(s)));
    if (s.missing && s.missing.length) {
      c.appendChild(h("h3", null, "Without a second sign-in step"));
      c.appendChild(table([{ h: "Person" }, { h: "" }], s.missing.map(function (p) { return [{ text: p.name || p.upn, sub: p.upn }, p.admin ? { text: "Admin", cls: "alert" } : ""]; })));
    }
    if (s.guests) c.appendChild(h("p", "dim small", s.guestsRegistered + " of " + s.guests + (s.guests === 1 ? " guest has" : " guests have") + " registered. Guests are not counted above."));
    if (s.truncated) c.appendChild(h("p", "dim small", "The list was cut short by Microsoft's paging, so the numbers may be a little low."));
  }

  function fillAccounts(c, s) {
    c.appendChild(headLine(L.accountsHead(s)));
    var note = L.signInNote(s);
    if (note) c.appendChild(h("p", "dim", note));
    if (s.stale && s.stale.rows.length) {
      c.appendChild(h("h3", null, "Not signed in for 60 days or more (" + s.stale.d60 + (s.stale.d90 ? ", " + s.stale.d90 + " for 90" : "") + ")"));
      c.appendChild(table([{ h: "Person" }, { h: "Last sign-in", num: true }, { h: "Licences", num: true }],
        L.peopleRows(s.stale.rows).map(function (p) { return [{ text: p.name, sub: p.upn }, { text: p.since + " ago", cls: p.tone }, String(p.licences)]; })));
    }
    if (s.never && s.never.count) {
      c.appendChild(h("h3", null, "Never signed in (" + s.never.count + ")"));
      c.appendChild(table([{ h: "Person" }, { h: "Account age", num: true }], L.peopleRows(s.never.rows).map(function (p) { return [{ text: p.name, sub: p.upn }, p.age]; })));
    }
    if (s.licensedDisabled && s.licensedDisabled.count) {
      c.appendChild(h("h3", null, "Disabled but still licensed (" + s.licensedDisabled.count + ")"));
      c.appendChild(table([{ h: "Person" }, { h: "Licences", num: true }], L.peopleRows(s.licensedDisabled.rows).map(function (p) { return [{ text: p.name, sub: p.upn }, String(p.licences)]; })));
    }
    if (s.guestRows && s.guestRows.length) {
      c.appendChild(h("h3", null, "Guests, oldest first (" + s.guests + ")"));
      c.appendChild(table([{ h: "Guest" }, { h: "Added", num: true }, { h: "Last sign-in", num: true }],
        L.peopleRows(s.guestRows, "guest").map(function (p) { return [{ text: p.name, sub: p.upn + (p.off ? " (disabled)" : "") }, p.age + " ago", p.since === "never" ? "never" : p.since + " ago"]; })));
    }
  }

  function fillRoles(c, s) {
    c.appendChild(headLine(L.rolesHead(s)));
    (s.roles || []).forEach(function (r) {
      var t = h("h3", null, r.name + " (" + r.count + ")");
      if (r.privileged) t.appendChild(chip("privileged", "attn"));
      c.appendChild(t);
      var ul = h("ul", "m3-list");
      r.members.forEach(function (m) { var li = h("li"); li.appendChild(h("span", null, L.memberText(m))); if (m.upn) li.appendChild(h("span", "dim small", m.upn)); ul.appendChild(li); });
      c.appendChild(ul);
    });
    if (s.note) c.appendChild(h("p", "dim small", s.note));
  }

  function fillPolicies(c, s) {
    c.appendChild(headLine(L.policiesHead(s)));
    if (s.rows && s.rows.length) c.appendChild(table([{ h: "Policy" }, { h: "State" }, { h: "Changed", num: true }],
      s.rows.map(function (p) { return [p.name, { text: p.state, cls: p.state === "off" ? "attn" : "" }, p.modified ? L.dateText(p.modified) : ""]; })));
  }

  function fillScore(c, s) {
    c.appendChild(headLine(L.scoreHead(s)));
    var gaps = L.gapRows(s);
    if (gaps.length) {
      c.appendChild(h("h3", null, "Biggest gaps"));
      c.appendChild(table([{ h: "Action" }, { h: "Points", num: true }], gaps.map(function (g) { return [{ text: g.title, sub: g.meta }, String(g.gap)]; })));
    } else if (s.gapsState && s.gapsState !== "ok") {
      c.appendChild(h("p", "dim small", "The list of actions needs the same permission (SecurityEvents.Read.All) and could not be read."));
    }
  }

  function reviewCard(data) {
    var c = h("section", "m3-card");
    c.appendChild(h("h2", null, "Quarterly access review"));
    var m = L.reviewModel(data.review, Date.now());
    c.appendChild(headLine(m));
    var form = h("div", "m3-form");
    var input = h("input"); input.type = "text"; input.maxLength = 300; input.placeholder = "A note, if you want one (what you changed)"; input.setAttribute("aria-label", "Review note");
    var btn = h("button", "btn btn-sm", "Record this review"); btn.type = "button";
    btn.addEventListener("click", function () {
      if (model.busy) return;
      model.busy = true; btn.disabled = true;
      send("POST", "/review", { note: input.value }).then(function (r) {
        model.busy = false;
        if (r.status === 200 && r.body && r.body.ok) { data.review = r.body.review; data.reviews = r.body.reviews; render(); flash("Review recorded.", "ok"); }
        else { btn.disabled = false; flash(L.errorText(r.body, r.status), "alert"); }
      });
    });
    form.appendChild(input); form.appendChild(btn);
    c.appendChild(form);
    var past = (data.reviews || []).slice(1, 5);
    if (past.length) {
      c.appendChild(h("h3", null, "Earlier reviews"));
      var ul = h("ul", "m3-list");
      past.forEach(function (r) { ul.appendChild(h("li", null, L.dateText(r.at) + (r.note ? ": " + r.note : ""))); });
      c.appendChild(ul);
    }
    return c;
  }

  function setupPanel(data) {
    var box = h("section", "m3-banner attn");
    var missing = L.missingPermissions(data);
    box.appendChild(h("b", null, data.configured === false ? "The read-only Microsoft app is not set up yet" : "Some cards need a permission"));
    if (data.configured === false) box.appendChild(h("p", null, "These Worker settings are missing or wrong: " + ((data.problems || []).join(", ") || "none named") + ". They are the three the Users list uses; once they are there this page works with the same app."));
    var ol = h("ol", "m3-steps");
    (data.steps || []).forEach(function (t) { ol.appendChild(h("li", null, t)); });
    box.appendChild(ol);
    var perms = data.configured === false || !missing.length ? (data.permissions || []).map(function (p) { return p; }) : (data.permissions || []).filter(function (p) { return missing.indexOf(p.name) !== -1; });
    if (perms.length) {
      box.appendChild(h("p", null, data.configured === false || !missing.length ? "Permissions to add (all read only):" : "Permissions still to add (all read only):"));
      var ul = h("ul", "m3-perms");
      perms.forEach(function (p) { var li = h("li"); li.appendChild(h("code", null, p.name)); li.appendChild(h("span", "dim", " " + (p.why || []).join(", "))); ul.appendChild(li); });
      box.appendChild(ul);
    }
    return box;
  }

  function render() {
    var root = $("m3-root");
    if (!root) return;
    function message(t) { clear(root); root.appendChild(h("p", "dim", t)); }
    if (model.state === "guest") return message("Sign in to see the Microsoft 365 page.");
    if (model.state === "forbidden") return message("The Microsoft 365 page is only for the hub owner.");
    if (model.state === "off") return message(L.ERRORS.m365_disabled);
    if (model.state === "error") return message("Could not reach the Worker. Press Refresh to try again.");
    if (model.state === "loading" || !model.data) return;
    var data = model.data, snap = data.snapshot, sections = (snap && snap.sections) || {};
    clear(root);
    if (data.failure) { var b = h("section", "m3-banner alert"); b.appendChild(h("p", null, L.failureText(data.failure))); root.appendChild(b); }
    if (data.configured === false) { root.appendChild(setupPanel(data)); root.appendChild(reviewCard(data)); stamp(); return; }
    if (!snap) { root.appendChild(h("p", "dim", "Nothing has been read from Microsoft yet. Press Refresh.")); stamp(); return; }
    var stats = L.stats(data.headline);
    if (stats.length) {
      var strip = h("div", "m3-stats");
      stats.forEach(function (s) { var d = h("div", "m3-stat" + (s.tone ? " " + s.tone : "")); d.appendChild(h("b", null, s.value)); d.appendChild(h("span", null, s.label)); strip.appendChild(d); });
      root.appendChild(strip);
    }
    if (L.setupNeeded(data)) root.appendChild(setupPanel(data));
    var grid = h("div", "m3-grid");
    grid.appendChild(card("licences", sections.licences, fillLicences));
    grid.appendChild(card("mfa", sections.mfa, fillMfa));
    grid.appendChild(card("accounts", sections.accounts, fillAccounts));
    grid.appendChild(card("roles", sections.roles, fillRoles));
    grid.appendChild(card("policies", sections.policies, fillPolicies));
    grid.appendChild(card("score", sections.score, fillScore));
    grid.appendChild(reviewCard(data));
    root.appendChild(grid);
    stamp();
  }

  function stamp() {
    var st = $("m3-stamp");
    if (st) st.textContent = model.data && model.data.snapshot ? "Read from Microsoft " + L.agoText(model.data.snapshot.at, Date.now()) : "";
  }

  // ---- actions --------------------------------------------------------------------------------------------------------------

  function refresh() {
    if (model.busy) return;
    model.busy = true;
    var b = $("m3-refresh"); if (b) b.disabled = true;
    flash("Reading Microsoft…", "");
    send("POST", "/refresh").then(function (r) {
      model.busy = false;
      if (b) b.disabled = false;
      if (failState(r)) { flash(""); render(); return; }
      if (r.status === 200 && r.body && r.body.ok) { model.data = r.body; model.state = "ok"; flash(r.body.failure ? "" : "Up to date.", r.body.failure ? "" : "ok"); }
      else flash(L.errorText(r.body, r.status), "alert");
      render();
    });
  }

  function boot() {
    var rf = $("m3-refresh");
    if (rf) rf.addEventListener("click", refresh);
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      load().then(render);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
