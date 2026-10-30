// The Release board tab of the Monitoring page (monitoring.html#release): for each repository, is main red, what is live, the open pull requests and a rollback note.
// The owner's page, like Services and Incidents.
//
// Reads and writes /release/* on the Worker (ClaudeRepo's cloudflare-worker/src/release-routes.js, owner only):
//   GET  /release/summary[?refresh=1]     POST /release/notes {repo, text}
// The page asks for the summary when it opens and every three minutes while it is showing (never from a hidden tab, and not while a
// note is being typed). Refresh asks the Worker to read GitHub again (it allows that once every 30 seconds).
//
// Everything from the server reaches the page through textContent, never innerHTML (the CSP has no 'unsafe-inline' for scripts or
// styles), and a link is only ever set to an https://github.com/ address. Sizes and colours come from classes, not style strings.

(function () {
  "use strict";

  var L = window.BarnyardReleaseLogic;
  var API = "https://api.barnyard.site";
  var POLL_MS = 180000;

  var model = { state: "loading", sum: null, flash: null, busy: false, saving: "" };

  // ---- data -----------------------------------------------------------------

  function getJson(url, init) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 25000);
    var opts = { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    for (var k in init) opts[k] = init[k];
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  function load(refresh) {
    return getJson(API + "/release/summary" + (refresh ? "?refresh=1" : ""), { method: "GET" }).then(function (r) {
      if (r.status === 401) { model.state = "guest"; return; }
      if (r.status === 403) { model.state = "forbidden"; return; }
      if (r.status === 429) { flash(L.errorText(r.body, 429), "alert"); return; }
      if (r.status === 0 || r.status >= 500 || !r.body) { model.state = model.sum ? "ok" : "error"; return; }
      if (r.body.enabled === false) { model.state = "off"; return; }
      model.sum = r.body; model.state = "ok";
    });
  }

  function saveNote(repo, text) {
    if (model.saving) return;
    model.saving = repo;
    render();
    getJson(API + "/release/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repo, text: text }) }).then(function (r) {
      model.saving = "";
      if (r.status === 200 && r.body && r.body.notes) {
        model.sum.notes = r.body.notes;
        render();
        flash(text ? "Saved the note for " + repo + "." : "Cleared the note for " + repo + ".", "ok");
      } else { render(); flash(L.errorText(r.body, r.status), "alert"); }
    });
  }

  // ---- small DOM helpers ----------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function chip(label, word, tone) {
    var c = h("span", "chip" + (tone ? " " + tone : ""));
    c.appendChild(h("span", "rel-chip-label", label));
    c.appendChild(document.createTextNode(" " + word));
    return c;
  }
  // A link that only ever points at github.com.
  function ghLink(text, href, cls) {
    if (typeof href !== "string" || href.indexOf("https://github.com/") !== 0) return h("span", cls, text);
    var a = h("a", cls, text);
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }
  function message(text) { var box = $("rel-root"); clear(box); box.appendChild(h("p", "rel-off", text)); }
  function flash(text, tone) {
    model.flash = text ? { text: text, tone: tone || "" } : null;
    var box = $("rel-flash");
    if (!box) return;
    clear(box);
    if (!model.flash) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "rel-flash " + (tone || "");
    box.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") {
      var a = h("a", "btn btn-sm", "Sign in again");
      a.href = window.barnyardLoginUrl();
      box.appendChild(a);
    }
  }

  // ---- rendering ------------------------------------------------------------

  function renderSetup(root, sum) {
    var sec = h("section", "rel-setup");
    sec.appendChild(h("h2", null, "Add " + (sum.secret || "GITHUB_READ_TOKEN") + " to switch this on"));
    sec.appendChild(h("p", "rel-lead", "The board reads GitHub with one read-only token. Until it is added nothing is fetched."));
    var ol = h("ol", "rel-steps");
    (sum.steps || []).forEach(function (t) { ol.appendChild(h("li", null, t)); });
    sec.appendChild(ol);
    sec.appendChild(h("h3", null, "The token's permissions"));
    var ul = h("ul", "rel-perms");
    (sum.permissions || []).forEach(function (p) {
      var li = h("li");
      li.appendChild(h("b", null, p.name));
      li.appendChild(h("span", "chip ok", p.level));
      li.appendChild(h("span", "dim", " " + p.why));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    sec.appendChild(h("h3", null, "Repositories"));
    var repos = h("ul", "rel-repolist");
    (sum.repos || []).forEach(function (r) { repos.appendChild(h("li", null, r.name + (r.label ? " (" + r.label + ")" : ""))); });
    sec.appendChild(repos);
    root.appendChild(sec);
  }

  function renderHeadline(root, sum, now) {
    var m = L.headlineModel(sum, now);
    var box = h("div", "rel-headline " + m.tone);
    box.setAttribute("role", m.tone === "alert" ? "alert" : "status");
    box.appendChild(h("b", null, m.title));
    m.lines.forEach(function (t) { box.appendChild(h("span", null, t)); });
    root.appendChild(box);
  }

  function renderPulls(card, m) {
    if (!m.pulls.length) { card.appendChild(h("p", "dim rel-none", "No open pull requests.")); return; }
    card.appendChild(h("h3", null, "Open pull requests"));
    var wrap = h("div", "rel-scroll");
    var t = h("table", "rel-table");
    var head = h("tr");
    ["Pull request", "Checks", "Open for"].forEach(function (c) { head.appendChild(h("th", null, c)); });
    var thead = h("thead"); thead.appendChild(head); t.appendChild(thead);
    var tb = h("tbody");
    m.pulls.forEach(function (p) {
      var tr = h("tr");
      var a = h("td");
      a.appendChild(ghLink("#" + p.number + " " + p.title, p.url, "rel-link"));
      if (p.draft) a.appendChild(h("span", "chip", "Draft"));
      if (p.author) a.appendChild(h("span", "dim rel-by", " by " + p.author));
      tr.appendChild(a);
      var c = h("td"); c.appendChild(h("span", "chip" + (p.tone ? " " + p.tone : ""), p.checks)); tr.appendChild(c);
      var age = h("td", p.stale ? "rel-stale" : "", p.age);
      tr.appendChild(age);
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); card.appendChild(wrap);
  }

  function renderNote(card, m, now) {
    var box = h("div", "rel-note");
    box.appendChild(h("h3", null, "If you need to roll back"));
    var ta = h("textarea", "rel-note-text");
    ta.rows = 4; ta.maxLength = L.NOTE_MAX; ta.value = m.note.text; ta.setAttribute("aria-label", "Rollback note for " + m.name);
    ta.id = "rel-note-" + m.name;
    box.appendChild(ta);
    var row = h("div", "rel-actions");
    var save = h("button", "btn btn-sm", model.saving === m.name ? "Saving…" : "Save note");
    save.type = "button"; save.disabled = !!model.saving;
    save.addEventListener("click", function () { saveNote(m.name, ta.value); });
    row.appendChild(save);
    if (m.note.custom) {
      var reset = h("button", "btn btn-sm btn-quiet", "Use the starting text");
      reset.type = "button"; reset.disabled = !!model.saving;
      reset.addEventListener("click", function () { saveNote(m.name, ""); });
      row.appendChild(reset);
    }
    row.appendChild(h("span", "dim small", m.note.custom ? "Your note, saved " + L.agoText(m.note.at, now) + "." : "Starting text: write your own to replace it."));
    box.appendChild(row);
    card.appendChild(box);
  }

  function renderRepo(root, row, notes, now) {
    var m = L.repoModel(row, notes && notes[row.name], now);
    var card = h("section", "rel-card " + m.tone);
    var head = h("div", "rel-card-head");
    var title = h("div", "rel-title");
    title.appendChild(ghLink(m.name, m.url, "rel-name"));
    if (m.label) title.appendChild(h("span", "dim", " " + m.label));
    head.appendChild(title);
    if (m.site) head.appendChild(h("span", "dim small mono", m.site));
    card.appendChild(head);

    if (m.error) { card.appendChild(h("p", "rel-error", m.error)); renderNote(card, m, now); root.appendChild(card); return; }

    var chips = h("div", "rel-chips");
    m.chips.forEach(function (c) { chips.appendChild(chip(c.label, c.word, c.tone)); });
    card.appendChild(chips);
    if (m.main) card.appendChild(h("p", "rel-main", "Latest on main: " + m.main));
    if (m.redLine) {
      var red = h("div", "rel-red");
      red.appendChild(h("b", null, m.redLine));
      if (m.failing.length) {
        var ul = h("ul", "rel-failing");
        m.failing.forEach(function (f) { var li = h("li"); li.appendChild(ghLink(f.text, f.url, "rel-link")); ul.appendChild(li); });
        red.appendChild(ul);
      }
      card.appendChild(red);
    }
    var dep = h("p", "rel-deploy");
    dep.appendChild(document.createTextNode(m.deploy + " "));
    if (m.deployUrl) dep.appendChild(ghLink("Open the log", m.deployUrl, "rel-link"));
    card.appendChild(dep);
    if (m.attention.length) card.appendChild(h("p", "rel-attn", "Needs attention: " + m.attention.join("; ") + "."));
    renderPulls(card, m);
    renderNote(card, m, now);
    root.appendChild(card);
  }

  function render() {
    var root = $("rel-root");
    if (!root) return;
    if (model.state === "guest") { message("Sign in to see the Release board."); return; }
    if (model.state === "forbidden") { message("The Release board is only for the hub owner."); return; }
    if (model.state === "off") { message("The Release board is switched off. The Worker variable RELEASE_ENABLED is 0."); return; }
    if (model.state === "error") { message("Could not reach the Worker. Press Refresh to try again."); return; }
    if (model.state === "loading" || !model.sum) return;
    var now = Date.now();
    clear(root);
    var sum = model.sum;
    if (!sum.configured) { renderSetup(root, sum); }
    else {
      renderHeadline(root, sum, now);
      var grid = h("div", "rel-grid");
      L.orderRows(sum.rows).forEach(function (row) { renderRepo(grid, row, sum.notes, now); });
      root.appendChild(grid);
      if (sum.rate && sum.rate.remaining !== null && sum.rate.remaining < 500) {
        root.appendChild(h("p", "dim small", "GitHub allowance left this hour: " + sum.rate.remaining + "."));
      }
    }
    var st = $("rel-stamp");
    if (st) st.textContent = "Updated " + L.clockText(Date.now()).slice(-5);
  }

  // ---- boot -----------------------------------------------------------------

  function refreshNow() {
    if (model.busy) return;
    model.busy = true;
    var b = $("rel-refresh"); if (b) b.disabled = true;
    flash("");
    load(true).then(function () { model.busy = false; if (b) b.disabled = false; render(); });
  }

  // ---- the Monitoring page's Release board tab ---------------------------------------------------------------
  // monitoring.js loads this file the first time the tab is opened and calls start() each time it is shown and stop() each
  // time another tab is chosen, so nothing is read or polled while the tab is closed. The Refresh button is in
  // monitoring.html; it is wired once.

  var wired = false, active = false, ready = false, pending = false, timer = null;

  function wire() {
    if (wired) return;
    wired = true;
    var rf = $("rel-refresh");
    if (rf) rf.addEventListener("click", refreshNow);
  }

  function poll() {
    if (timer) return;
    timer = setInterval(function () {
      var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (!document.hidden && model.state === "ok" && !model.busy && !model.saving && !typing) load(false).then(render);
    }, POLL_MS);
  }

  function start() {
    wire();
    active = true;
    if (ready) { load(false).then(render); poll(); return; }
    if (pending) return;
    pending = true;
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      pending = false;
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      ready = true;
      if (active) { load(false).then(render); poll(); }
    });
  }

  function stop() {
    active = false;
    clearInterval(timer);
    timer = null;
  }

  window.BarnyardTabs = window.BarnyardTabs || {};
  window.BarnyardTabs.release = { start: start, stop: stop };
})();
