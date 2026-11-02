// How a shared view's frozen picture is drawn (share.js previews it before a link is made; view.js shows it to whoever
// holds the link). The picture is plain data from the Worker (cloudflare-worker/src/share-logic.js): an Overview summary,
// the renewals list, or a few Knowledgebase articles. Everything is built with createElement / textContent, never HTML strings,
// and Knowledgebase text goes through markdown.js (DOM nodes only), so nothing in a picture can inject script or style.
//
// Layout: 1. pure helpers (exported for test/share.test.js)  2. drawing

(function (root) {
  "use strict";

  var KIND_TITLE = { overview: "Overview summary", renewals: "Renewals", kb: "Knowledgebase articles", canvas: "Canvas board" };
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
    if (snapshot.kind === "canvas") {
      var n = (snapshot.items || []).length;
      return n + " item" + (n === 1 ? "" : "s");
    }
    return "";
  }

  // ---- a shared Canvas board ----
  // The Worker's picture of a board holds the drawing only (items renumbered n1, n2 ..., a card has just its kind and a plain label).
  // It is drawn with canvas-logic.js's own SVG export, then rebuilt node by node from an allow-list of drawing elements and attributes,
  // so even a changed or hostile picture can only ever produce lines, shapes and text: no script, style, link or picture address.
  var SVG_TAGS = { svg: 1, defs: 1, marker: 1, path: 1, rect: 1, line: 1, text: 1, tspan: 1, ellipse: 1, polygon: 1, circle: 1 };
  var SVG_ATTRS = {
    viewBox: 1, "font-family": 1, id: 1, refX: 1, refY: 1, markerWidth: 1, markerHeight: 1, orient: 1, d: 1, fill: 1, x: 1, y: 1, rx: 1, ry: 1, cx: 1, cy: 1, r: 1,
    x1: 1, y1: 1, x2: 1, y2: 1, stroke: 1, "stroke-width": 1, "stroke-dasharray": 1, "marker-end": 1, points: 1, "font-size": 1, "text-anchor": 1, "font-weight": 1, dy: 1
  };
  // Letters, digits, spaces and the punctuation a drawing needs; no ":" "/" ";" quotes or angle brackets, so no address and no markup.
  var SVG_VALUE = /^[-A-Za-z0-9 #.,()_%]*$/;

  // May this attribute (on any allowed element) be copied? width and height are left out on purpose: the page sizes the drawing.
  function safeSvgAttr(name, value) {
    return !!SVG_ATTRS[name] && SVG_VALUE.test(String(value)) && (name !== "marker-end" || /^url\(#[A-Za-z0-9_-]+\)$/.test(String(value)));
  }

  // The shared picture as the plain data canvas-logic.js draws. A card needs a reference to be drawn; it gets a placeholder id.
  function canvasData(snapshot) {
    var items = [];
    ((snapshot && snapshot.items) || []).forEach(function (it) {
      if (!it || typeof it !== "object") return;
      var c = {};
      Object.keys(it).forEach(function (k) { c[k] = it[k]; });
      if (c.type === "card") c.ref = { kind: c.ref && c.ref.kind, id: "shared" };
      items.push(c);
    });
    return { items: items };
  }

  var helpers = { kindTitle: kindTitle, dateText: dateText, isoText: isoText, dueChip: dueChip, stateText: stateText, tone: tone, paragraphs: paragraphs, describe: describe, KIND_TITLE: KIND_TITLE, safeSvgAttr: safeSvgAttr, canvasData: canvasData, SVG_TAGS: SVG_TAGS };

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

  var SVG_NS = "http://www.w3.org/2000/svg";

  // Copy one parsed drawing node into a fresh SVG element, keeping only what the allow-list names.
  function rebuild(node) {
    if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
    if (node.nodeType !== 1 || !SVG_TAGS[node.localName]) return null;
    var el = document.createElementNS(SVG_NS, node.localName);
    for (var i = 0; i < node.attributes.length; i++) {
      var a = node.attributes[i];
      if (safeSvgAttr(a.name, a.value)) el.setAttribute(a.name, a.value);
    }
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && node.localName !== "text" && node.localName !== "tspan") continue;   // words only inside text
      var kid = rebuild(c);
      if (kid) el.appendChild(kid);
    }
    return el;
  }

  function drawCanvas(snap) {
    var wrap = h("div", "sv-body sv-canvas");
    var L = root.BarnyardCanvasLogic;
    if (!(snap.items || []).length) { wrap.appendChild(h("p", "sv-clear", "This board was empty when it was shared.")); return wrap; }
    if (!L || !L.toSvg || typeof DOMParser === "undefined") { wrap.appendChild(h("p", "sv-dim", "This page could not draw the board.")); return wrap; }
    var parsed;
    try { parsed = new DOMParser().parseFromString(L.toSvg(canvasData(snap)), "image/svg+xml"); } catch (e) { parsed = null; }
    var svg = parsed && parsed.documentElement && parsed.documentElement.localName === "svg" ? rebuild(parsed.documentElement) : null;
    if (!svg) { wrap.appendChild(h("p", "sv-dim", "This board could not be drawn.")); return wrap; }
    svg.setAttribute("class", "sv-canvas-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", (snap.title || "Canvas board") + ", a drawing with " + describe(snap));
    var frame = h("div", "sv-canvas-frame");
    frame.appendChild(svg);
    wrap.appendChild(frame);
    var cards = (snap.items || []).filter(function (i) { return i.type === "card"; }).length;
    if (cards) wrap.appendChild(h("p", "sv-dim", "Boxes marked as linked items were live cards on the board. Here they are only pictures: they show nothing that is live."));
    return wrap;
  }

  // -> an element holding the picture. opts.plain draws Knowledgebase text as short plain paragraphs (for the preview).
  function render(snapshot, opts) {
    if (!snapshot || typeof snapshot !== "object") return h("p", "sv-dim", "Nothing to show.");
    if (snapshot.kind === "overview") return drawOverview(snapshot);
    if (snapshot.kind === "renewals") return drawRenewals(snapshot);
    if (snapshot.kind === "kb") return drawKb(snapshot, opts);
    if (snapshot.kind === "canvas") return drawCanvas(snapshot);
    return h("p", "sv-dim", "This kind of view is not known to this page.");
  }

  var api = { render: render };
  for (var k in helpers) api[k] = helpers[k];
  root.BarnyardShareRender = api;
})(typeof window !== "undefined" ? window : this);
