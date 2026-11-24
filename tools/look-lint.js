// Lints the look layers (look-layers/<id>.css and <id>.js) against the rules in docs/looks.md, so a person adding a look
// finds out here, not in review, and test/looks.test.js covers every look in the registry with no test edits.
//
//   node tools/look-lint.js            lint every installed look in themes.js's registry
//   node tools/look-lint.js grid-9     lint one look
//
// What it checks, for look <id>:
//   - every rule is scoped: each selector starts with html[data-look="<id>"] (or :root[data-look="<id>"]), so no look can
//     change Original or another look; @media and @supports blocks are checked inside; @import, @font-face and @charset are refused;
//   - nothing the Content-Security-Policy would block or that the shell does not allow: no url(), no expression(), no behavior;
//   - colours come from the theme: no #hex, rgb(), hsl() or named colours in colour properties (shadows excepted), so every one of
//     the 18 themes in light and dark recolours the look; transparent, currentColor, inherit and none are fine;
//   - contrast: wherever one rule sets both a text colour and a background from theme tokens (color: var(--fg); background:
//     var(--panel)), that pair must reach 4.5:1 in all 36 theme and mode combinations. A rule that sets only a text colour is
//     checked against the page and panel surfaces. A pair the CSS cannot show (text on something a parent paints) is declared in
//     a comment anywhere in the file:   /* contrast: --fg-dim on --panel-2; --accent-ink on --accent */
//     (the colour variables that are translucent, --accent-soft and --attn-soft, are not checked).
// A look whose registry entry says renderer: true must also have look-layers/<id>.js; a look that is not installed must have neither.

var fs = require("fs");
var path = require("path");
var Theme = require(path.join(__dirname, "..", "themes.js"));

var VARS = Theme.COLOUR_VARS;                      // --bg --panel --panel-2 --line --fg --fg-strong --fg-dim --accent --accent-ink --accent-soft --attn --attn-soft
var TRANSLUCENT = ["--accent-soft", "--attn-soft"];
var COLOUR_PROPS = /^(color|background|background-color|border(-[a-z]+)*(-color)?|outline(-color)?|fill|stroke|caret-color|text-decoration-color|column-rule(-color)?)$/;
var NAMED = /\b(black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, " "); }

// The `/* contrast: --a on --b; ... */` declarations anywhere in the file.
function declaredPairs(css) {
  var out = [], re = /\/\*\s*contrast:([\s\S]*?)\*\//g, m;
  while ((m = re.exec(css))) {
    m[1].split(";").forEach(function (p) {
      var pair = /(--[a-z0-9-]+)\s+on\s+(--[a-z0-9-]+)/.exec(p);
      if (pair) out.push({ fg: pair[1], bg: pair[2], where: "declared" });
    });
  }
  return out;
}

// -> [{selectors: [..], body: "decls", at: "@media ..."|null}] for every style rule, descending into @media and @supports.
function rules(css, errors) {
  var text = stripComments(css), out = [], i = 0;
  function block(from, to, at) {
    var pos = from;
    while (pos < to) {
      var open = text.indexOf("{", pos);
      var semi = text.indexOf(";", pos);
      if (open === -1 || open >= to) {
        if (text.slice(pos, to).trim()) { var stray = text.slice(pos, to).trim(); if (/^@/.test(stray)) errors.push("at-rule not allowed: " + stray.slice(0, 40)); }
        return;
      }
      if (semi !== -1 && semi < open && /^\s*@/.test(text.slice(pos, semi))) { errors.push("at-rule not allowed: " + text.slice(pos, semi).trim().slice(0, 40)); pos = semi + 1; continue; }
      var depth = 1, end = open + 1;
      while (end < to && depth > 0) { var c = text[end]; if (c === "{") depth++; else if (c === "}") depth--; end++; }
      var head = text.slice(pos, open).trim(), inner = text.slice(open + 1, end - 1);
      if (/^@(media|supports)\b/.test(head)) block(open + 1, end - 1, head);
      else if (/^@keyframes\b/.test(head)) { /* animation steps carry no selectors; their names are checked below */ out.push({ keyframes: head, selectors: [], body: "", at: at }); }
      else if (/^@/.test(head)) errors.push("at-rule not allowed: " + head.slice(0, 40));
      else out.push({ selectors: splitSelectors(head), body: inner, at: at });
      pos = end;
    }
  }
  block(0, text.length, null);
  return out;
}

function splitSelectors(text) {
  var parts = [], depth = 0, cur = "";
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function decls(body) {
  return body.split(";").map(function (d) { var k = d.indexOf(":"); return k < 1 ? null : { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() }; }).filter(Boolean);
}

function tokenOf(value) { var m = /^var\(\s*(--[a-z0-9-]+)\s*\)(?:\s*!important)?$/.exec(value.trim()); return m ? m[1] : null; }
function bgToken(value) {
  var m = /var\(\s*(--[a-z0-9-]+)\s*\)/.exec(value);
  return m && /^(\s*var\(\s*--[a-z0-9-]+\s*\)\s*(!important)?\s*)$/.test(value) ? m[1] : null;
}

function lintCss(id, css) {
  var errors = [], pairs = declaredPairs(css), scope = new RegExp("^(html|:root)\\[data-look=\"" + id + "\"\\]([\\s>+~.:#\\[ ]|$)");
  if (/@import/i.test(stripComments(css))) errors.push("@import is not allowed");
  rules(css, errors).forEach(function (r) {
    if (r.keyframes) { if (!new RegExp("^@keyframes\\s+" + id + "-").test(r.keyframes)) errors.push("keyframes name must start with " + id + "-: " + r.keyframes.slice(0, 40)); return; }
    r.selectors.forEach(function (s) { if (!scope.test(s)) errors.push("unscoped selector (must start with html[data-look=\"" + id + "\"]): " + s.slice(0, 70)); });
    var fg = null, bg = null;
    decls(r.body).forEach(function (d) {
      if (/url\(/i.test(d.value)) errors.push("url() is not allowed (the page's policy allows no images or fonts from a layer): " + d.prop);
      if (/expression\(|behavior\s*:|-moz-binding/i.test(d.prop + ":" + d.value)) errors.push("not allowed: " + d.prop);
      if (COLOUR_PROPS.test(d.prop) && !/^(box-shadow|text-shadow)$/.test(d.prop)) {
        var v = d.value.replace(/var\([^)]*\)/g, "").replace(/color-mix\([^)]*\)/g, "");
        if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(v) || NAMED.test(v)) errors.push("use the theme's colour variables, not a literal colour: " + d.prop + ": " + d.value.slice(0, 40));
      }
      if (d.prop === "color") fg = tokenOf(d.value);
      if (d.prop === "background" || d.prop === "background-color") bg = bgToken(d.value) || bg;
    });
    if (fg && VARS.indexOf(fg) !== -1) {
      if (bg && VARS.indexOf(bg) !== -1) pairs.push({ fg: fg, bg: bg, where: r.selectors[0] });
      else if (!bg) { pairs.push({ fg: fg, bg: "--panel", where: r.selectors[0] }); if (fg !== "--fg-dim") pairs.push({ fg: fg, bg: "--bg", where: r.selectors[0] }); }
    }
  });
  var seen = {};
  pairs = pairs.filter(function (p) { var k = p.fg + ">" + p.bg; if (seen[k]) return false; seen[k] = true; return TRANSLUCENT.indexOf(p.fg) === -1 && TRANSLUCENT.indexOf(p.bg) === -1 && VARS.indexOf(p.fg) !== -1 && VARS.indexOf(p.bg) !== -1; });
  var low = [];
  Theme.THEMES.forEach(function (t) {
    ["light", "dark"].forEach(function (mode) {
      pairs.forEach(function (p) {
        var ratio = Theme.contrastRatio(t[mode][VARS.indexOf(p.fg)], t[mode][VARS.indexOf(p.bg)]);
        if (ratio < 4.5) low.push(t.id + " " + mode + ": " + p.fg + " on " + p.bg + " is " + ratio.toFixed(2) + ":1 (" + p.where + ")");
      });
    });
  });
  low.forEach(function (l) { errors.push("contrast below 4.5:1 - " + l); });
  return { errors: errors, pairs: pairs };
}

function lintLook(root, id) {
  var entry = Theme.findLook(id), errors = [];
  if (!entry) return { errors: ["not in the registry in themes.js: " + id], pairs: [] };
  var cssFile = path.join(root, "look-layers", id + ".css"), jsFile = path.join(root, "look-layers", id + ".js");
  var hasCss = fs.existsSync(cssFile), hasJs = fs.existsSync(jsFile);
  if (id === "original") {
    if (hasCss || hasJs) errors.push("Original has no layer: it must load nothing");
    return { errors: errors, pairs: [] };
  }
  if (!entry.installed) { if (hasCss || hasJs) errors.push("a layer file exists but the registry says installed: false"); return { errors: errors, pairs: [] }; }
  if (!hasCss) { errors.push("installed: true but look-layers/" + id + ".css is missing"); return { errors: errors, pairs: [] }; }
  if (entry.renderer && !hasJs) errors.push("renderer: true but look-layers/" + id + ".js is missing");
  if (!entry.renderer && hasJs) errors.push("look-layers/" + id + ".js exists but the registry says renderer: false");
  var r = lintCss(id, fs.readFileSync(cssFile, "utf8"));
  return { errors: errors.concat(r.errors), pairs: r.pairs };
}

module.exports = { lintCss: lintCss, lintLook: lintLook, rules: rules, declaredPairs: declaredPairs };

if (require.main === module) {
  var root = path.join(__dirname, "..");
  var ids = process.argv[2] ? [process.argv[2]] : Theme.LOOKS.filter(function (l) { return l.installed; }).map(function (l) { return l.id; });
  var bad = 0;
  ids.forEach(function (id) {
    var r = lintLook(root, id);
    console.log((r.errors.length ? "FAIL " : "ok   ") + id + (r.errors.length ? "" : "  (" + r.pairs.length + " colour pairs checked in 36 theme and mode combinations)"));
    r.errors.forEach(function (e) { console.log("       " + e); });
    bad += r.errors.length;
  });
  process.exit(bad ? 1 : 0);
}
