// Shared read-only views: the owner's side. A Settings tab ("Shared views") on the Overview where the owner makes a link to a
// FROZEN copy of the Overview summary, the renewals list or a few Knowledgebase articles, previews exactly what it holds,
// sets how long it lasts (14 days unless changed), and switches links off.
//
// Anyone with a link sees a snapshot (view.html) with no login. The link is shown once, when it is made: the Worker keeps only
// its hash. See ClaudeRepo's cloudflare-worker/src/share-routes.js. Owner only, on the hub's own origin.
//
// Everything from the server reaches the page through textContent, never HTML strings.
//
// Layout: 1. pure helpers (exported for test/share.test.js)  2. data  3. rendering

(function (root) {
  "use strict";

  var API = "https://api.barnyard.site/share";
  var HUB_API = "https://api.barnyard.site/hub";
  var VIEW_URL = "https://dashboard.barnyard.site/view.html#";
  var DAYS = [{ v: 1, t: "1 day" }, { v: 7, t: "7 days" }, { v: 14, t: "14 days" }, { v: 30, t: "30 days" }, { v: 90, t: "90 days" }];
  var DEFAULT_DAYS = 14;
  var KINDS = [
    { id: "overview", title: "Overview summary", about: "What needs attention: what is down, backups, renewals, domains, security." },
    { id: "renewals", title: "Renewals", about: "The list of things that run out, with their dates." },
    { id: "kb", title: "Knowledgebase articles", about: "Up to ten articles, copied as they read now." }
  ];
  var SECTIONS = [
    { id: "down", title: "What is down", on: true }, { id: "backups", title: "Backups", on: true }, { id: "renewals", title: "Renewals soon", on: true },
    { id: "domains", title: "Domains", on: true }, { id: "vulns", title: "Security", on: true },
    { id: "todos", title: "To-dos due", on: false }, { id: "decisions", title: "Waiting on you", on: false }
  ];
  var MAX_ARTICLES = 10, SEARCH_MIN = 2, SEARCH_DEBOUNCE_MS = 450;
  var ARTICLE_HREF = /^https:\/\/study\.barnyard\.site\/knowledgebase\.html#\/a\/(ka_[a-z0-9]{8})$/;
  var TOKEN = /^sv_[A-Za-z0-9_-]{32}$/;

  // ---- 1. pure helpers -----------------------------------------------------

  function viewUrl(token) { return TOKEN.test(String(token)) ? VIEW_URL + token : ""; }

  // The body to send for a preview or a create, from what the owner has chosen.
  function buildBody(form, today) {
    var body = { kind: form.kind, days: form.days };
    if (form.label && form.label.trim()) body.label = form.label.trim().slice(0, 60);
    if (form.kind === "overview") body.sections = SECTIONS.filter(function (s) { return form.sections[s.id]; }).map(function (s) { return s.id; });
    if (form.kind === "kb") body.ids = form.articles.map(function (a) { return a.id; });
    if (today) body.today = today;
    if (form.confirmPii) body.confirmPii = true;
    return body;
  }

  // Why the form cannot be previewed yet, or "" when it can.
  function formProblem(form) {
    if (form.kind === "overview" && !SECTIONS.some(function (s) { return form.sections[s.id]; })) return "Tick at least one section.";
    if (form.kind === "kb" && !form.articles.length) return "Choose at least one article.";
    return "";
  }

  // The Knowledgebase articles in a /hub/search answer -> [{ id, title }].
  function articleHits(data) {
    var out = [];
    ((data && data.groups) || []).forEach(function (g) {
      if (!g || g.id !== "kb" || g.skipped || g.error) return;
      (g.items || []).forEach(function (x) {
        var m = x && ARTICLE_HREF.exec(String(x.href || ""));
        if (m && x.title) out.push({ id: m[1], title: String(x.title).slice(0, 120) });
      });
    });
    return out;
  }

  var PII_WORDS = { email: "email addresses", phone: "phone numbers", card: "card numbers", tfn: "tax file numbers", medicare: "Medicare numbers", ssn: "social security numbers" };
  function piiText(kinds) {
    var words = (kinds || []).map(function (k) { return PII_WORDS[k] || k; });
    return words.length ? "This contains " + words.join(", ") + "." : "";
  }

  var DAY = 86400000;
  // "in 12 days" / "today" / "expired 3 days ago" / "revoked".
  function expiryText(link, now) {
    if (link.status === "revoked") return "Switched off";
    var d = Math.ceil((link.expiresAt - now) / DAY);
    if (link.status === "expired" || link.expiresAt <= now) {
      var ago = Math.floor((now - link.expiresAt) / DAY);
      return ago < 1 ? "Expired today" : "Expired " + ago + (ago === 1 ? " day ago" : " days ago");
    }
    return d <= 0 ? "Expires today" : d === 1 ? "Expires tomorrow" : "Expires in " + d + " days";
  }

  function viewsText(n) { return n === 0 ? "Not opened yet" : n === 1 ? "Opened once" : "Opened " + n + " times"; }

  var ERRORS = {
    recent_sign_in_required: "Sign in again, then try once more. Making and switching off links needs a recent sign-in.",
    too_many_links: "You have the most links allowed (20 at once). Switch one off first.",
    secret_detected: "This contains something that looks like a password or key, so it can't be shared.",
    pii_confirmation_needed: "This contains personal details. Tick the box to confirm it is fine to share.",
    article_not_found: "One of those articles no longer exists. Remove it and try again.",
    article_hidden: "One of those articles is hidden, so it can't be shared.",
    too_large: "That is too big to share. Choose fewer articles.",
    unauthenticated: "Sign in to the hub, then try again.",
    forbidden: "Only the hub owner can share views.",
    unavailable: "The server could not read that just now. Try again in a moment.",
    not_configured: "Sharing is not switched on yet."
  };
  function errorText(code, status) {
    if (ERRORS[code]) return ERRORS[code];
    if (status === 429) return "That was too fast. Wait a moment and try again.";
    return "That didn't work. Try again.";
  }

  var helpers = {
    viewUrl: viewUrl, buildBody: buildBody, formProblem: formProblem, articleHits: articleHits, piiText: piiText, expiryText: expiryText,
    viewsText: viewsText, errorText: errorText, KINDS: KINDS, SECTIONS: SECTIONS, DAYS: DAYS, DEFAULT_DAYS: DEFAULT_DAYS, MAX_ARTICLES: MAX_ARTICLES, SEARCH_MIN: SEARCH_MIN
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. data -------------------------------------------------------------

  function call(method, path, body, base) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer" };
    if (body !== undefined) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
    return fetch((base || API) + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!r.ok) { var e = new Error("http"); e.status = r.status; e.code = d && d.error; e.data = d; throw e; }
        return d;
      });
    });
  }

  function todayText() {
    var d = new Date(), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // ---- 3. rendering --------------------------------------------------------

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var S = {
    form: { kind: "renewals", days: DEFAULT_DAYS, label: "", sections: {}, articles: [], confirmPii: false },
    preview: null, previewKey: "", links: null, listState: "idle", message: "", created: null, busy: false,
    search: { q: "", hits: [], state: "idle" }, confirmRevoke: null, host: null, searchTimer: null
  };
  SECTIONS.forEach(function (s) { S.form.sections[s.id] = s.on; });

  function again() { if (S.host && S.host.isConnected) draw(S.host); }
  function say(text, tone) { S.message = text; S.messageTone = tone || ""; again(); }

  function loadList() {
    S.listState = "loading";
    call("GET", "/list").then(function (d) { S.links = d.links || []; S.listState = "ready"; again(); },
      function (e) { S.listState = "error"; S.listError = errorText(e.code, e.status); again(); });
  }

  function keyOfForm() { return JSON.stringify(buildBody(S.form, "")); }

  function doPreview() {
    var problem = formProblem(S.form);
    if (problem) { say(problem, "bad"); return; }
    S.busy = true; S.message = ""; again();
    call("POST", "/preview", buildBody(S.form, todayText())).then(function (d) {
      S.busy = false; S.preview = d; S.previewKey = keyOfForm(); S.form.confirmPii = false; S.created = null; again();
    }, function (e) { S.busy = false; S.preview = null; say(errorText(e.code, e.status), "bad"); });
  }

  function doCreate() {
    if (!S.preview || S.previewKey !== keyOfForm()) { say("Preview it again first, so you can see what you are sharing.", "bad"); return; }
    if (S.preview.pii && S.preview.pii.length && !S.form.confirmPii) { say(errorText("pii_confirmation_needed"), "bad"); return; }
    S.busy = true; S.message = ""; again();
    call("POST", "/create", buildBody(S.form, todayText())).then(function (d) {
      S.busy = false; S.created = { url: viewUrl(d.token), id: d.id, expiresAt: d.expiresAt }; S.links = d.links || S.links; S.preview = null;
      again();
      if (window.BarnyardShell && window.BarnyardShell.toast) window.BarnyardShell.toast("Link made");
    }, function (e) {
      S.busy = false;
      if (e.code === "pii_confirmation_needed" && e.data && e.data.pii && S.preview) S.preview.pii = e.data.pii;
      say(errorText(e.code, e.status), "bad");
    });
  }

  function doRevoke(link) {
    if (S.confirmRevoke !== link.id) { S.confirmRevoke = link.id; again(); return; }
    S.confirmRevoke = null;
    call("POST", "/revoke", { id: link.id }).then(function (d) { S.links = d.links || S.links; say("Switched off.", "ok"); },
      function (e) { say(errorText(e.code, e.status), "bad"); });
  }

  function searchSoon(q) {
    clearTimeout(S.searchTimer);
    S.search.q = q;
    var trimmed = q.trim();
    if (trimmed.length < SEARCH_MIN) { S.search.hits = []; S.search.state = "idle"; again(); return; }
    S.searchTimer = setTimeout(function () {
      S.search.state = "loading"; again();
      call("GET", "/search?q=" + encodeURIComponent(trimmed), undefined, HUB_API).then(function (d) {
        if (S.search.q.trim() !== trimmed) return;
        S.search.hits = articleHits(d); S.search.state = "done"; again();
      }, function () { S.search.hits = []; S.search.state = "error"; again(); });
    }, SEARCH_DEBOUNCE_MS);
  }

  function field(label, control, hint) {
    var wrap = h("div", "sh-field");
    var l = h("label", "sh-label", label);
    wrap.appendChild(l);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(h("p", "hint", hint));
    return wrap;
  }

  function chooser() {
    var fs = h("fieldset");
    fs.appendChild(h("legend", null, "What to share"));
    var seg = h("div", "sh-kinds");
    KINDS.forEach(function (k) {
      var label = h("label", "sh-kind"), input = h("input");
      input.type = "radio"; input.name = "sh-kind"; input.value = k.id; input.checked = S.form.kind === k.id;
      input.addEventListener("change", function () { S.form.kind = k.id; S.preview = null; S.created = null; S.message = ""; again(); });
      label.appendChild(input);
      var text = h("span", "sh-kind-text");
      text.appendChild(h("b", null, k.title));
      text.appendChild(h("span", "dim", k.about));
      label.appendChild(text);
      seg.appendChild(label);
    });
    fs.appendChild(seg);
    return fs;
  }

  function options() {
    var box = h("div", "sh-options");
    if (S.form.kind === "overview") {
      var fs = h("fieldset");
      fs.appendChild(h("legend", null, "Sections to include"));
      fs.appendChild(h("p", "hint", "To-dos and “Waiting on you” are off unless you tick them."));
      SECTIONS.forEach(function (s) {
        var label = h("label", "sh-check"), input = h("input");
        input.type = "checkbox"; input.checked = !!S.form.sections[s.id];
        input.addEventListener("change", function () { S.form.sections[s.id] = input.checked; S.preview = null; again(); });
        label.appendChild(input); label.appendChild(h("span", null, s.title));
        fs.appendChild(label);
      });
      box.appendChild(fs);
    }
    if (S.form.kind === "kb") {
      var fk = h("fieldset");
      fk.appendChild(h("legend", null, "Articles (up to " + MAX_ARTICLES + ")"));
      var q = h("input", "sh-input");
      q.type = "search"; q.placeholder = "Search the Knowledgebase by title or words"; q.value = S.search.q; q.setAttribute("aria-label", "Search the Knowledgebase");
      q.addEventListener("input", function () { searchSoon(q.value); });
      fk.appendChild(q);
      if (S.search.state === "loading") fk.appendChild(h("p", "hint", "Searching…"));
      else if (S.search.state === "error") fk.appendChild(h("p", "hint", "Couldn't search just now."));
      else if (S.search.state === "done" && !S.search.hits.length) fk.appendChild(h("p", "hint", "No articles match."));
      if (S.search.hits.length) {
        var ul = h("ul", "sh-hits");
        S.search.hits.forEach(function (a) {
          var li = h("li"), have = S.form.articles.some(function (x) { return x.id === a.id; });
          li.appendChild(h("span", null, a.title));
          var add = h("button", "btn btn-sm", have ? "Added" : "Add");
          add.type = "button"; add.disabled = have || S.form.articles.length >= MAX_ARTICLES;
          add.addEventListener("click", function () { S.form.articles.push(a); S.preview = null; again(); });
          li.appendChild(add);
          ul.appendChild(li);
        });
        fk.appendChild(ul);
      }
      if (S.form.articles.length) {
        fk.appendChild(h("p", "sh-sub", "Chosen"));
        var chosen = h("ul", "sh-hits");
        S.form.articles.forEach(function (a) {
          var li = h("li");
          li.appendChild(h("span", null, a.title));
          var rm = h("button", "btn btn-sm", "Remove");
          rm.type = "button";
          rm.addEventListener("click", function () { S.form.articles = S.form.articles.filter(function (x) { return x.id !== a.id; }); S.preview = null; again(); });
          li.appendChild(rm);
          chosen.appendChild(li);
        });
        fk.appendChild(chosen);
      }
      box.appendChild(fk);
    }
    return box;
  }

  function previewBlock() {
    var p = S.preview;
    var box = h("div", "sh-preview");
    box.appendChild(h("p", "sh-sub", "Preview: exactly what the link will show"));
    var frame = h("div", "sh-frame");
    frame.appendChild(window.BarnyardShareRender.render(p.snapshot, { plain: true }));
    box.appendChild(frame);
    var warn = piiText(p.pii);
    if (warn) {
      var w = h("div", "sh-warn");
      w.setAttribute("role", "alert");
      w.appendChild(h("p", null, warn + " Anyone with the link would see it."));
      var label = h("label", "sh-check"), input = h("input");
      input.type = "checkbox"; input.checked = !!S.form.confirmPii;
      input.addEventListener("change", function () { S.form.confirmPii = input.checked; again(); });
      label.appendChild(input); label.appendChild(h("span", null, "I have checked it, and it is fine to share"));
      w.appendChild(label);
      box.appendChild(w);
    }
    return box;
  }

  function createdBlock() {
    var c = S.created;
    var box = h("div", "sh-created");
    box.setAttribute("role", "status");
    box.appendChild(h("p", "sh-sub", "Your link"));
    var input = h("input", "sh-input sh-url");
    input.type = "text"; input.readOnly = true; input.value = c.url; input.setAttribute("aria-label", "The shared link");
    input.addEventListener("focus", function () { input.select(); });
    box.appendChild(input);
    var row = h("div", "sh-row");
    var copy = h("button", "btn btn-sm btn-primary", "Copy link");
    copy.type = "button";
    copy.addEventListener("click", function () {
      var done = function () { if (window.BarnyardShell) window.BarnyardShell.toast("Link copied"); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c.url).then(done, function () { input.select(); });
      else { input.select(); }
    });
    row.appendChild(copy);
    var done = h("button", "btn btn-sm", "Done");
    done.type = "button";
    done.addEventListener("click", function () { S.created = null; again(); });
    row.appendChild(done);
    box.appendChild(row);
    box.appendChild(h("p", "hint", "This is the only time the whole link is shown: it is not kept anywhere. Anyone who has it can open the frozen copy until it expires or you switch it off."));
    return box;
  }

  function linksBlock() {
    var fs = h("fieldset");
    fs.appendChild(h("legend", null, "Your links"));
    if (S.listState === "loading" || S.listState === "idle") { fs.appendChild(h("p", "hint", "Loading…")); return fs; }
    if (S.listState === "error") {
      fs.appendChild(h("p", "hint", S.listError || "Couldn't load your links."));
      var retry = h("button", "btn btn-sm", "Try again");
      retry.type = "button";
      retry.addEventListener("click", loadList);
      fs.appendChild(retry);
      return fs;
    }
    if (!S.links.length) { fs.appendChild(h("p", "hint", "You haven't shared anything yet.")); return fs; }
    var ul = h("ul", "sh-links");
    var now = Date.now();
    S.links.forEach(function (l) {
      var li = h("li", "sh-link sh-" + l.status);
      var main = h("div", "sh-link-main");
      main.appendChild(h("b", null, l.label || (window.BarnyardShareRender.kindTitle(l.kind))));
      main.appendChild(h("span", "dim", l.summary));
      main.appendChild(h("span", "dim", expiryText(l, now) + " · " + viewsText(l.views)));
      li.appendChild(main);
      if (l.status === "live") {
        var b = h("button", "btn btn-sm", S.confirmRevoke === l.id ? "Yes, switch off" : "Switch off");
        b.type = "button";
        b.addEventListener("click", function () { doRevoke(l); });
        li.appendChild(b);
        if (S.confirmRevoke === l.id) {
          var no = h("button", "btn btn-sm", "No");
          no.type = "button";
          no.addEventListener("click", function () { S.confirmRevoke = null; again(); });
          li.appendChild(no);
        }
      }
      ul.appendChild(li);
    });
    fs.appendChild(ul);
    return fs;
  }

  function draw(body) {
    S.host = body;
    while (body.firstChild) body.removeChild(body.firstChild);
    var intro = h("fieldset");
    intro.appendChild(h("legend", null, "Share a read-only view"));
    intro.appendChild(h("p", "hint", "Make a link to a frozen copy of something on the hub. Anyone with the link can read it without signing in. It never updates, it expires, and you can switch it off at any time."));
    body.appendChild(intro);
    if (S.created) body.appendChild(createdBlock());
    body.appendChild(chooser());
    body.appendChild(options());

    var days = h("select", "sh-input");
    days.setAttribute("aria-label", "Expires after");
    DAYS.forEach(function (d) { var o = h("option", null, d.t); o.value = String(d.v); if (d.v === S.form.days) o.selected = true; days.appendChild(o); });
    days.addEventListener("change", function () { S.form.days = Number(days.value); S.preview = null; again(); });
    body.appendChild(field("Expires after", days));
    var label = h("input", "sh-input");
    label.type = "text"; label.maxLength = 60; label.value = S.form.label; label.placeholder = "For example, For the committee";
    label.addEventListener("input", function () { S.form.label = label.value; });
    body.appendChild(field("Name for your own list (optional)", label, "Only you see this; it is not on the shared page."));

    var row = h("div", "sh-row");
    var pv = h("button", "btn btn-sm", S.preview ? "Preview again" : "Preview");
    pv.type = "button"; pv.disabled = S.busy;
    pv.addEventListener("click", doPreview);
    row.appendChild(pv);
    var stale = S.preview && S.previewKey !== keyOfForm();
    var mk = h("button", "btn btn-sm btn-primary", "Make the link");
    mk.type = "button";
    mk.disabled = S.busy || !S.preview || stale || (S.preview.pii && S.preview.pii.length && !S.form.confirmPii);
    mk.addEventListener("click", doCreate);
    row.appendChild(mk);
    body.appendChild(row);
    if (S.message) { var m = h("p", "sh-msg " + (S.messageTone === "bad" ? "is-bad" : ""), S.message); m.setAttribute("role", S.messageTone === "bad" ? "alert" : "status"); body.appendChild(m); }
    if (S.preview && !stale) body.appendChild(previewBlock());
    else if (stale) body.appendChild(h("p", "hint", "You changed something. Preview it again to see what the link would show."));
    body.appendChild(linksBlock());
    if (S.listState === "idle") loadList();
  }

  function isOwner() {
    var who = window.BarnyardTheme && window.BarnyardTheme.who && window.BarnyardTheme.who.get();
    return !!who && who.owner === true;
  }

  // The tab and the palette command exist only for the hub owner, and appear once the page knows that.
  function boot() {
    if (!window.BarnyardShell || !window.BarnyardShareRender || !window.BarnyardTheme || !window.BarnyardTheme.who) return;
    var registered = false;
    function register() {
      if (registered || !isOwner()) return;
      registered = true;
      window.BarnyardShell.registerTab({
        id: "share", title: "Shared views",
        render: function (body) {
          S.listState = S.listState === "ready" ? "ready" : "idle";
          draw(body);
        }
      });
      if (window.BarnyardShell.palette) {
        window.BarnyardShell.palette.registerCommands(function () {
          return isOwner() ? [{ title: "Share a read-only view", hint: "Settings", keywords: "link snapshot send", run: function () { window.BarnyardShell.openSettings("share"); } }] : [];
        });
      }
    }
    window.BarnyardTheme.who.onChange(register);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : this);
