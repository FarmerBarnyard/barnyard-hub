// Markdown to PDF (md-pdf.html): paste or open a .md file, see it laid out, then Save as PDF.
//
// Nothing is uploaded: the text is rendered in the page by markdown.js (DOM nodes only, never innerHTML)
// and the PDF comes from the browser's own print dialog ("Save as PDF"), so it works offline and the
// text never reaches a server. The page's CSP forbids inline styles, so the paper size is set by adding
// an @page rule to md-pdf.css through the stylesheet object, not through a <style> tag.
//
// Layout: 1. pure helpers (exported for test/md-pdf.test.js)  2. page

(function (root) {
  "use strict";

  var SIZES = { A4: "A4", Letter: "Letter", Legal: "Legal", A5: "A5" };
  var MAX_CHARS = 400000;
  var DRAFT_KEY = "barnyard.mdpdf.draft";

  // ---- 1. pure helpers ------------------------------------------------------

  // The @page rule for a paper size, orientation and margin in millimetres. Unknown input falls back to A4 portrait, 20mm.
  function pageRule(size, orient, marginMm) {
    var s = Object.prototype.hasOwnProperty.call(SIZES, size) ? SIZES[size] : "A4";
    var o = orient === "landscape" ? "landscape" : "portrait";
    var m = Number(marginMm);
    if (!isFinite(m) || m < 0 || m > 60) m = 20;
    return "@page { size: " + s + " " + o + "; margin: " + Math.round(m) + "mm; }";
  }

  // The first heading, else the first non-empty line, with Markdown marks stripped; "Document" if there is nothing.
  // Used as the document title while printing, because browsers suggest the title as the PDF's file name.
  function titleOf(md) {
    var lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    var pick = "";
    for (var i = 0; i < lines.length && !pick; i++) {
      var h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (h) pick = h[1];
    }
    for (var j = 0; j < lines.length && !pick; j++) if (lines[j].trim()) pick = lines[j].trim();
    pick = pick.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~>\[\]]/g, "").replace(/\s+/g, " ").trim();
    return pick ? pick.slice(0, 80) : "Document";
  }

  // Word and character counts for the little counter above the text box.
  function stats(md) {
    var text = String(md == null ? "" : md);
    return { words: (text.match(/\S+/g) || []).length, chars: text.length };
  }

  // Drops a UTF-8 byte-order mark and normalises line endings, so a file saved by Windows tools renders the same.
  function clean(text) {
    return String(text == null ? "" : text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  }

  var api = { pageRule: pageRule, titleOf: titleOf, stats: stats, clean: clean, MAX_CHARS: MAX_CHARS };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.BarnyardMdPdf = api;
  if (typeof document === "undefined" || !root.BarnyardMarkdown) return;

  // ---- 2. page --------------------------------------------------------------

  var MD = root.BarnyardMarkdown;
  function $(id) { return document.getElementById(id); }
  var src = $("mp-src"), doc = $("mp-doc"), printBtn = $("mp-print"), count = $("mp-count");
  var pageRuleIndex = -1;

  function sheet() {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var s = document.styleSheets[i];
      if (s.href && /md-pdf\.css(\?|$)/.test(s.href)) return s;
    }
    return null;
  }

  // Replaces the one @page rule this page owns.
  function applyPage() {
    var s = sheet();
    if (s) {
      try {
        if (pageRuleIndex >= 0) s.deleteRule(pageRuleIndex);
        pageRuleIndex = s.insertRule(pageRule($("mp-size").value, $("mp-orient").value, $("mp-margin").value), s.cssRules.length);
      } catch (e) { pageRuleIndex = -1; }
    }
    $("mp-sheet").classList.toggle("landscape", $("mp-orient").value === "landscape");
  }

  function applyLook() {
    doc.className = "md " + $("mp-font").value + " " + $("mp-face").value;
  }

  function render() {
    var text = clean(src.value);
    while (doc.firstChild) doc.removeChild(doc.firstChild);
    if (text.trim()) {
      try { doc.appendChild(MD.toDom(MD.parse(text), document, {})); }
      catch (e) { var pre = document.createElement("pre"); pre.textContent = text; doc.appendChild(pre); }
    } else {
      var p = document.createElement("p");
      p.className = "mp-empty";
      p.textContent = "The preview appears here.";
      doc.appendChild(p);
    }
    var st = stats(text);
    count.textContent = st.chars ? "· " + st.words.toLocaleString() + " words" : "";
    printBtn.disabled = !text.trim();
    try { localStorage.setItem(DRAFT_KEY, src.value.slice(0, MAX_CHARS)); } catch (e) { /* storage may be blocked */ }
  }

  function load(file) {
    if (file.size > MAX_CHARS * 4) { src.value = ""; render(); count.textContent = "· that file is too big (limit about 400,000 characters)"; return; }
    var r = new FileReader();
    r.onload = function () { src.value = clean(r.result).slice(0, MAX_CHARS); render(); };
    r.readAsText(file);
  }

  var timer = null;
  src.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(render, 150); });
  ["mp-size", "mp-orient", "mp-margin"].forEach(function (id) { $(id).addEventListener("change", applyPage); });
  ["mp-font", "mp-face"].forEach(function (id) { $(id).addEventListener("change", applyLook); });

  $("mp-file").addEventListener("change", function (ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (f) load(f);
  });

  // Dropping a file on the text box opens it, like the button.
  src.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  src.addEventListener("drop", function (ev) {
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    ev.preventDefault();
    load(f);
  });

  $("mp-clear").addEventListener("click", function () {
    if (src.value && !root.confirm("Clear the text?")) return;
    src.value = "";
    render();
    src.focus();
  });

  var savedTitle = null;
  printBtn.addEventListener("click", function () {
    render();
    savedTitle = document.title;
    document.title = titleOf(src.value);
    root.print();
  });
  root.addEventListener("afterprint", function () { if (savedTitle !== null) { document.title = savedTitle; savedTitle = null; } });

  try { src.value = (localStorage.getItem(DRAFT_KEY) || "").slice(0, MAX_CHARS); } catch (e) { /* ignore */ }
  applyPage();
  applyLook();
  render();
})(typeof window !== "undefined" ? window : this);
