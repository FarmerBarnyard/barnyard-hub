// How a shared view's frozen picture is drawn (share.js previews it before a link is made; view.js shows it to whoever
// holds the link). The picture is plain data from the Worker (cloudflare-worker/src/share-logic.js): an Overview summary,
// the renewals list, or a few Knowledgebase articles. Everything is built with createElement / textContent, never HTML strings,
// and Knowledgebase text goes through markdown.js (DOM nodes only), so nothing in a picture can inject script or style.
//
// Layout: 1. pure helpers (exported for test/share.test.js)  2. drawing

(function (root) {
  "use strict";

  var KIND_TITLE = { overview: "Overview summary", renewals: "Renewals", kb: "Knowledgebase articles" };
  var STATE_TEXT = { known: "date confirmed", estimated: "date estimated", planned: "planned", needed: "date needed", auto: "renews itself" };
  var TONES = ["", "attn", "alert"];

  // ---- 1. pure helpers -----------------------------------------------------

  function kindTitle(kind) { return KIND_TITLE[kind] || "Shared view"; }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  // 1793149691769 -> "28 Oct 2026" (the viewer's own time zone)
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateText(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    var d = new Date(ms);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }
  // "2027-01-02" -> "2 Jan 2027"
  function isoText(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    return m ? Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1] : "";
  }

  // How far a renewal was from due when the picture was taken: { text, tone }.
  function dueChip(daysLeft) {
    if (typeof daysLeft !== "number" || !isFinite(daysLeft)) return { text: "no date", tone: "attn" };
    if (daysLeft < 0) return { text: "overdue by " + -daysLeft + (daysLeft === -1 ? " day" : " days"), tone: "alert" };
    if (daysLeft === 0) return { text: "due today", tone: "alert" };
    if (daysLeft <= 14) return { text: "in " + daysLeft + (daysLeft === 1 ? " day" : " days"), tone: "attn" };
    if (daysLeft < 90) return { text: "in " + daysLeft + " days", tone: "" };
    return { text: "in " + Math.round(daysLeft / 30) + " months", tone: "" };
  }

  function stateText(state) { return STATE_TEXT[state] || ""; }
  function tone(t) { return TONES.indexOf(t) !== -1 ? t : ""; }

  // The paragraphs of a plain-text body (used when markdown.js is not on the page).
  function paragraphs(text) {
    return String(text == null ? "" : text).replace(/\r\n/g, "\n").split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  }

  // One line saying how big a picture is, for the preview.
  function describe(snapshot) {
    if (!snapshot) return "";
    if (snapshot.kind === "overview") {
      var lines = 0;
      (snapshot.sections || []).forEach(function (s) { lines += (s.items || []).length; });
      return (snapshot.sections || []).length + " section" + ((snapshot.sections || []).length === 1 ? "" : "s") + ", " + lines + " line" + (lines === 1 ? "" : "s");
    }
    if (snapshot.kind === "renewals") return (snapshot.rows || []).length + " renewal" + ((snapshot.rows || []).length === 1 ? "" : "s");
    if (snapshot.kind === "kb") return (snapshot.articles || []).length + " article" + ((snapshot.articles || []).length === 1 ? "" : "s");
    return "";
  }

  var helpers = { kindTitle: kindTitle, dateText: dateText, isoText: isoText, dueChip: dueChip, stateText: stateText, tone: tone, paragraphs: paragraphs, describe: describe, KIND_TITLE: KIND_TITLE };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. drawing ----------------------------------------------------------

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function drawOverview(snap) {
    var wrap = h("div", "sv-body");
    var sections = snap.sections || [];
    if (!sections.length) {
      wrap.appendChild(h("p", "sv-clear", "Nothing needed attention when this was taken."));
      return wrap;
    }
    sections.forEach(function (s) {
      var sec = h("section", "sv-sec sv-tone-" + (tone(s.tone) || "none"));
      var head = h("h3", "sv-sec-h", s.title);
      head.appendChild(h("span", "sv-count", String(s.count)));
      sec.appendChild(head);
      var ul = h("ul", "sv-list");
      (s.items || []).forEach(function (i) {
        var li = h("li", "sv-line sv-tone-" + (tone(i.tone) || "none"));
        li.appendChild(h("span", "sv-text", i.text));
        if (i.note) li.appendChild(h("span", "sv-note", i.note));
        ul.appendChild(li);
      });
      if (s.more > 0) ul.appendChild(h("li", "sv-more", "and " + s.more + " more"));
      sec.appendChild(ul);
      wrap.appendChild(sec);
    });
    if (snap.partial) wrap.appendChild(h("p", "sv-dim", "Some parts could not be read when this was taken, so it may be missing items."));
    return wrap;
  }

  function drawRenewals(snap) {
    var wrap = h("div", "sv-body");
    var rows = snap.rows || [];
    if (!rows.length) { wrap.appendChild(h("p", "sv-clear", "No renewals were recorded when this was taken.")); return wrap; }
    var scroll = h("div", "sv-scroll");
    var table = h("table", "sv-table");
    var thead = h("thead"), hr = h("tr");
    ["What", "Kind", "Due", "How soon", "Date"].forEach(function (t) { var th = h("th", null, t); th.scope = "col"; hr.appendChild(th); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = h("tbody");
    rows.forEach(function (r) {
      var tr = h("tr");
      var th = h("th", "sv-what", r.label);
      th.scope = "row";
      tr.appendChild(th);
      tr.appendChild(h("td", "sv-dim", r.kind || ""));
      tr.appendChild(h("td", "sv-mono", r.due ? isoText(r.due) : "not set"));
      var chip = dueChip(r.daysLeft), td = h("td");
      td.appendChild(h("span", "sv-chip sv-tone-" + (chip.tone || "none"), r.due ? chip.text : "no date"));
      tr.appendChild(td);
      tr.appendChild(h("td", "sv-dim", stateText(r.state)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    wrap.appendChild(h("p", "sv-dim", "“How soon” is counted from " + (dateText(snap.takenAt) || "the day this was taken") + ", not from today."));
    return wrap;
  }

  function drawKb(snap, opts) {
    var wrap = h("div", "sv-body");
    var md = root.BarnyardMarkdown;
    (snap.articles || []).forEach(function (a) {
      var art = h("article", "sv-article");
      art.appendChild(h("h2", "sv-article-h", a.title));
      if (a.updatedAt) art.appendChild(h("p", "sv-dim", "Last changed " + dateText(a.updatedAt)));
      var body = h("div", "sv-md");
      if (md && md.parse && md.toDom && !(opts && opts.plain)) {
        try { body.appendChild(md.toDom(md.parse(a.body), document, {})); }
        catch (e) { paragraphs(a.body).forEach(function (p) { body.appendChild(h("p", null, p)); }); }
      } else {
        paragraphs(a.body).slice(0, opts && opts.plain ? 3 : 400).forEach(function (p) { body.appendChild(h("p", null, opts && opts.plain && p.length > 220 ? p.slice(0, 220) + "…" : p)); });
      }
      art.appendChild(body);
      wrap.appendChild(art);
    });
    return wrap;
  }

  // -> an element holding the picture. opts.plain draws Knowledgebase text as short plain paragraphs (for the preview).
  function render(snapshot, opts) {
    if (!snapshot || typeof snapshot !== "object") return h("p", "sv-dim", "Nothing to show.");
    if (snapshot.kind === "overview") return drawOverview(snapshot);
    if (snapshot.kind === "renewals") return drawRenewals(snapshot);
    if (snapshot.kind === "kb") return drawKb(snapshot, opts);
    return h("p", "sv-dim", "This kind of view is not known to this page.");
  }

  var api = { render: render };
  for (var k in helpers) api[k] = helpers[k];
  root.BarnyardShareRender = api;
})(typeof window !== "undefined" ? window : this);
