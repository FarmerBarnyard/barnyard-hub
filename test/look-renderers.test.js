// The renderer looks (grid-9, day-line, lines): each registers an "overview" renderer from look-layers/<id>.js. overview.js calls it
// through drawLook() with the page's own model and helpers. These tests run each renderer against a tiny fake DOM and a model with real
// shapes (items, events, a status), and check what it draws, that it never uses innerHTML, and that Original is untouched by the hook.
"use strict";
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
function read(f) { return fs.readFileSync(path.join(root, f), "utf8"); }

var helpers = require("../overview.js");

function El(tag) {
  this.tagName = tag; this.children = []; this.className = ""; this._text = ""; this.attrs = {}; this.handlers = {}; this.style = {};
}
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.addEventListener = function (t, fn) { this.handlers[t] = fn; };
Object.defineProperty(El.prototype, "textContent", {
  get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(""); },
  set: function (v) { this._text = String(v); this.children = []; }
});
function all(el, out) { out = out || []; out.push(el); (el.children || []).forEach(function (c) { if (c && c.children) all(c, out); }); return out; }

function kit(done) {
  return {
    helpers: helpers,
    h: function (tag, cls, text) { var e = new El(tag); if (cls) e.className = cls; if (text != null) e._text = String(text); return e; },
    clear: function (n) { n.children = []; },
    hrefFor: function (id) { return "ops.html#" + id; },
    markDone: function (item) { done.push(item.id); },
    todayString: function () { return "2026-11-24"; }
  };
}

var DAY = 86400000;
var MODEL = {
  state: "ok", since: Date.now() - DAY, firstFeed: false, bell: [], bellOpen: false,
  items: [
    { id: "it_a1", title: "Approve renewal", lane: "waiting", status: "decision_needed", next: "Pay by Friday", due: "2026-11-28" },
    { id: "it_a2", title: "Sign off the first run", lane: "waiting", status: "decision_needed", next: "", due: "2026-11-20" },
    { id: "it_b1", title: "Hosted plane slice 1", lane: "in_progress", status: "building", next: "Reads 7 of 9" },
    { id: "it_c1", title: "Backups job", lane: "soaking", status: "soaking", next: "" }
  ],
  events: [{ itemId: "it_a1", kind: "moved", title: "Approve renewal", actor: "claude", ts: Date.now() - 3600000, changes: { lane: ["backlog", "waiting"] } }],
  status: { runner: { enabled: true, online: true }, engine: { enabled: true, online: false, lastSeen: Date.now() - 600000 }, check: { known: true, ok: true }, expiries: [] }
};

function load(id) {
  var table = {};
  global.window = { BarnyardTheme: { look: { register: function (lookId, pageId, fn) { table[lookId + ":" + pageId] = fn; } } } };
  global.document = { createTextNode: function (t) { var e = new El("#text"); e._text = t; return e; } };
  delete require.cache[require.resolve("../look-layers/" + id + ".js")];
  require("../look-layers/" + id + ".js");
  return table[id + ":overview"];
}

["grid-9"].forEach(function (id) {
  test(id + ": registers an overview renderer, draws from the page's own model, never uses innerHTML", function () {
    var src = read("look-layers/" + id + ".js").split(/\r?\n/).filter(function (l) { return !/^\s*\/\//.test(l); }).join("\n");   // code only, not the comments
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), "DOM calls and textContent only");
    var render = load(id);
    assert.strictEqual(typeof render, "function");
    var done = [], mount = new El("section");
    assert.notStrictEqual(render(MODEL, mount, kit(done)), false);
    var els = all(mount), text = mount.textContent;
    assert.ok(/Approve renewal/.test(text) && /Sign off the first run/.test(text), "the waiting items are drawn");
    assert.ok(/Hosted plane slice 1/.test(text), "the in-progress item is drawn");
    var links = els.filter(function (e) { return e.tagName === "a" && e.href; }).map(function (e) { return e.href; });
    assert.ok(links.indexOf("ops.html#it_a1") >= 0, "an item links to the board");
    var buttons = els.filter(function (e) { return e.tagName === "button"; });
    if (buttons.length) { buttons[0].handlers.click(); assert.strictEqual(done.length, 1, "Mark done calls the page's own action"); }
    // not ok, or no kit: the renderer declines (so the page's own markup stays)
    assert.strictEqual(render({ state: "guest", items: [] }, new El("section"), kit([])), false);
    assert.strictEqual(render(MODEL, new El("section"), null), false);
    // an empty board still draws something sensible
    var empty = new El("section");
    assert.notStrictEqual(render({ state: "ok", items: [], events: [], status: null }, empty, kit([])), false);
    assert.ok(empty.textContent.length > 0);
  });
});

test("overview.js hooks the renderer once, only draws through it when a look registered one, and leaves Original alone", function () {
  var src = read("overview.js");
  assert.ok(/Theme\.look\.renderer\("overview"\)/.test(src), "asks the current look for an overview renderer");
  assert.ok(/function drawLook\(\)/.test(src) && /drawLook\(\);\r?\n/.test(src), "drawn from renderAll");
  assert.ok(/data-look-drawn/.test(src), "marks the page while a renderer has drawn, so the look's CSS can hide the defaults");
  assert.ok(/lookId !== "original"/.test(src), "waits for the layer only when a look other than Original is chosen");
});
