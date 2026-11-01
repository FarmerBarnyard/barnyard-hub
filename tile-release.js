// The Release board tile: whether main is red anywhere, whether a deploy failed or main is ahead of what is live, and how many pull
// requests have failing checks, with a line for each repository that needs a look and a link to the Release board tab.
//
// It reads GET /release/status (owner only), which answers from the Worker's last stored snapshot and never calls GitHub, so the tile
// costs GitHub nothing however often the Overview is opened. The snapshot is refreshed by the Release board page and by a
// fifteen-minute tick on the Worker. With no GitHub token the tile says so; before the first read it says it is waiting.
// Needs tile-kit.js first. Pure helpers are exported for test/tile-release.test.js.

(function (root) {
  "use strict";

  var K = typeof module !== "undefined" && module.exports ? require("./tile-kit.js") : root.BarnyardTiles;

  // What the tile says, from the Worker's status answer: { state, tone, text, checked, rows }.
  // state: off | unset | waiting | alert | attn | ok. rows are the repositories that need a look, worst first, at most five.
  function model(st, now) {
    if (!st || st.enabled === false) return { state: "off", tone: "", text: "The Release board is switched off.", checked: "", rows: [] };
    if (st.configured === false) return { state: "unset", tone: "", text: "Not set up yet: add the GITHUB_READ_TOKEN secret to switch this on.", checked: "", rows: [] };
    if (!st.checkedAt) return { state: "waiting", tone: "", text: "Waiting for the first check. Open the Release board to read GitHub now.", checked: "", rows: [] };
    var rows = [];
    (st.repos || []).forEach(function (r) {
      var parts = [], rank = 3, tone = "attn";
      if (r.red) { parts.push("main is red" + (r.failing && r.failing.length ? " (" + r.failing.join(", ") + ")" : "")); rank = 0; tone = "alert"; }
      if (r.deploy && r.deploy.state === "fail") { parts.push("the last deploy failed"); rank = Math.min(rank, 1); tone = "alert"; }
      else if (r.deploy && r.deploy.ahead) { parts.push("main is ahead of what is live"); rank = Math.min(rank, 2); }
      if (r.pullsFailing) { parts.push(K.plural(r.pullsFailing, "pull request") + " with failing checks"); }
      if (parts.length) rows.push({ name: r.name, label: r.label || r.name, line: parts.join("; "), tone: tone, rank: rank });
    });
    rows.sort(function (a, b) { return a.rank - b.rank; });
    var errors = st.errors || [];
    var bad = rows.filter(function (r) { return r.tone === "alert"; }).length;
    var tone = bad ? "alert" : rows.length || errors.length ? "attn" : "ok";
    var text = bad ? K.plural(bad, "repository", "repositories") + " red or failing a deploy."
      : rows.length ? K.plural(rows.length, "repository", "repositories") + " to look at."
      : errors.length ? "Could not read " + errors.join(", ") + "."
      : "Everything is green." + (st.openPulls ? " " + K.plural(st.openPulls, "pull request") + " open." : "");
    var checked = "Checked " + K.agoText(st.checkedAt, now) + (st.stale ? " (the Worker has not read GitHub since; open the Release board)" : "");
    return { state: tone, tone: tone, text: text, checked: checked, rows: rows.slice(0, 5) };
  }

  var helpers = { model: model };
  var desc = { id: "release", title: "Release board", about: "Whether main is red, a deploy failed or main is ahead of what is live, in any of the five repositories.", w: 4, h: 6, minW: 3, minH: 3, maxW: 12, maxH: 20, ownerOnly: true, permission: "tile.release" };
  helpers.descriptor = desc;
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;

  var h = K.h, clear = K.clear, chip = K.chip;

  function render(container) {
    var wrap = h("div", "tl"), head = h("div", "tl-head");
    head.appendChild(h("h3", "tl-title", desc.title));
    var open = h("a", "btn btn-sm", "Open the Release board"); open.href = "monitoring.html#release";
    head.appendChild(open);
    var body = h("div", "tl-body");
    wrap.appendChild(head); wrap.appendChild(body); clear(container); container.appendChild(wrap);

    function paint(st) {
      clear(body);
      var m = model(st, Date.now());
      body.appendChild(h("p", "tl-sub", m.text));
      if (m.rows.length) {
        var ul = h("ul", "tl-list");
        m.rows.forEach(function (r) {
          var li = h("li");
          li.appendChild(h("b", null, r.label));
          li.appendChild(h("span", "dim", " " + r.line + " "));
          li.appendChild(chip(r.tone === "alert" ? "Fix first" : "Look", r.tone));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      if (m.checked) body.appendChild(h("p", "dim small", m.checked));
    }
    function load() {
      return K.call("GET", "/release/status").then(function (r) {
        if (r.status === 200 && r.body) { paint(r.body); return; }
        K.loadFailure(body, r, load);
      });
    }
    load();
    return { refresh: load, destroy: function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } };
  }

  K.register({ id: desc.id, title: desc.title, about: desc.about, w: desc.w, h: desc.h, minW: desc.minW, minH: desc.minH, maxW: desc.maxW, maxH: desc.maxH, ownerOnly: true, permission: desc.permission, render: render });
})(typeof window !== "undefined" ? window : globalThis);
