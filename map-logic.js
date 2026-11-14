// The dependency map's rules, with no DOM and no network (map.js and tile-weakest.js use them; test/map.test.js covers them).
//
// The Worker's GET /reg/map hands over every asset as a node ({ id, kind, name, criticality, dependsOn, layer, state, affectedBy,
// gaps ... }) and the links as edges ({ from, to }, meaning "from needs to"). Everything here works from that one answer:
// who is hit if something goes down, where each box sits on the diagram, which links a person may add without making a loop,
// and the plain-words text the page and the Overview tile show.
//
// Browser: window.BarnyardMapLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var KINDS = [["server", "Servers"], ["network", "Network"], ["app", "Apps and sites"], ["domain", "Domains"], ["certificate", "Certificates"], ["account", "Accounts and tenants"], ["identity", "Identity apps and settings"], ["licence", "Licences"], ["subscription", "Subscriptions"], ["other", "Other"]];
  var KIND_LABEL = {};
  KINDS.forEach(function (k) { KIND_LABEL[k[0]] = k[1]; });
  var KIND_ONE = { server: "Server", network: "Network", app: "App or site", domain: "Domain", certificate: "Certificate", account: "Account", identity: "Identity app or setting", licence: "Licence", subscription: "Subscription", other: "Other" };
  var KIND_RANK = {};
  KINDS.forEach(function (k, i) { KIND_RANK[k[0]] = i; });
  var CRIT_RANK = { critical: 0, high: 1, normal: 2, low: 3, "": 4 };
  var GAP_WORDS = { monitor: "no monitor", backup: "no backup job names it", runbook: "no runbook", watch: "no expiry watch" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Box size and spacing of the diagram, in drawing units.
  var NODE_W = 224, NODE_H = 50, GAP_X = 14, GAP_Y = 64, PAD = 28, LANE_HEAD = 24, LANE_FOOT = 8, TRACK = 8, START_SHUFFLES = 10;

  function kindLabel(kind) { return KIND_LABEL[kind] || "Other"; }
  function kindOne(kind) { return KIND_ONE[kind] || "Other"; }

  // ---- the graph, from the nodes' own lists ----------------------------------------------------------------------

  function index(nodes) {
    var by = {};
    (nodes || []).forEach(function (n) { by[n.id] = n; });
    return by;
  }

  // { deps: id -> [ids it needs], dependents: id -> [ids that need it] }, ignoring links to anything not in the list.
  function adjacency(nodes) {
    var by = index(nodes);
    var deps = {}, dependents = {};
    (nodes || []).forEach(function (n) { deps[n.id] = []; dependents[n.id] = []; });
    (nodes || []).forEach(function (n) {
      (n.dependsOn || []).forEach(function (d) {
        if (!by[d] || d === n.id || deps[n.id].indexOf(d) !== -1) return;
        deps[n.id].push(d);
        dependents[d].push(n.id);
      });
    });
    return { deps: deps, dependents: dependents };
  }

  // Everything beyond `start` along `adj`, nearest first: [{ id, depth }].
  function reach(adj, start) {
    var seen = {};
    seen[start] = true;
    var out = [], frontier = [start], depth = 0;
    while (frontier.length) {
      depth++;
      var next = [];
      frontier.forEach(function (id) {
        (adj[id] || []).forEach(function (n) {
          if (seen[n]) return;
          seen[n] = true;
          out.push({ id: n, depth: depth });
          next.push(n);
        });
      });
      frontier = next;
    }
    return out;
  }

  function shape(by, list) {
    return list.map(function (r) {
      var n = by[r.id];
      return { id: n.id, name: n.name, kind: n.kind, criticality: n.criticality || "", state: n.state || "none", depth: r.depth };
    }).sort(function (a, b) {
      return a.depth - b.depth || (CRIT_RANK[a.criticality] - CRIT_RANK[b.criticality]) || a.name.localeCompare(b.name);
    });
  }

  // What goes wrong if `id` is down and what it needs: { node, affected, needs, counts } (null for an unknown id).
  function radius(nodes, id) {
    var by = index(nodes);
    if (!by[id]) return null;
    var adj = adjacency(nodes);
    var affected = shape(by, reach(adj.dependents, id));
    var needs = shape(by, reach(adj.deps, id));
    var important = affected.filter(function (x) { return x.criticality === "critical" || x.criticality === "high"; });
    return {
      node: by[id], affected: affected, needs: needs,
      counts: { direct: affected.filter(function (x) { return x.depth === 1; }).length, total: affected.length, needs: needs.length, important: important.length }
    };
  }

  // "If db is down: api stops working straight away; web is hit through them."
  function whatBreaksText(name, affected) {
    if (!affected || !affected.length) return "If " + name + " is down, nothing else on the map depends on it.";
    var names = function (l) { return l.map(function (x) { return x.name; }).join(", "); };
    var direct = affected.filter(function (x) { return x.depth === 1; });
    var indirect = affected.filter(function (x) { return x.depth > 1; });
    var t = "If " + name + " is down: " + names(direct) + (direct.length === 1 ? " stops" : " stop") + " working straight away";
    if (indirect.length) t += "; " + names(indirect) + (indirect.length === 1 ? " is" : " are") + " hit through them";
    return t + ".";
  }

  // The text a person pastes into an incident note: the sentence, then each affected thing with how far away it is.
  function incidentText(rad) {
    if (!rad) return "";
    var lines = [whatBreaksText(rad.node.name, rad.affected)];
    if (rad.affected.length) {
      lines.push("");
      rad.affected.forEach(function (x) {
        lines.push("- " + x.name + " (" + kindOne(x.kind).toLowerCase() + (x.criticality ? ", " + x.criticality : "") + (x.depth === 1 ? ", directly" : ", through " + (x.depth - 1) + " other" + (x.depth - 1 === 1 ? "" : "s")) + ")");
      });
    }
    return lines.join("\n");
  }

  // ---- states and the banner -------------------------------------------------------------------------------------

  // How a box looks and what it says for its live state: { tone, label }.
  function stateModel(node) {
    if (node.state === "down") return { tone: "alert", label: "Down" };
    if (node.affectedBy && node.affectedBy.length) return { tone: "attn", label: "Affected" };
    if (node.state === "up") return { tone: "ok", label: "Up" };
    if (node.state === "unknown") return { tone: "dim", label: "Unknown" };
    return { tone: "dim", label: "Not monitored" };
  }

  // The strip above the map: { tone, text }.
  function banner(map) {
    if (!map) return { tone: "", text: "" };
    var st = map.stats || {};
    if (!map.monitoring) return { tone: "attn", text: "Live up/down is not available right now, so the map shows the links only." };
    var watched = (map.nodes || []).some(function (n) { return n.state && n.state !== "none"; });
    if (!watched) return { tone: "", text: "No asset is tied to a monitor yet, so the map shows the links only." };
    if (st.down) {
      var names = (map.nodes || []).filter(function (n) { return n.state === "down"; }).map(function (n) { return n.name; });
      var hit = st.affected ? " " + st.affected + (st.affected === 1 ? " other thing is" : " other things are") + " affected through it." : "";
      return { tone: "alert", text: (st.down === 1 ? names[0] + " is down." : st.down + " things are down (" + names.join(", ") + ").") + hit };
    }
    return { tone: "ok", text: "Everything that is monitored is up." };
  }

  // Each asset that is down now, with how many things it takes with it: [{ id, name, affected, text }], most hit first.
  function downReport(nodes) {
    var out = [];
    (nodes || []).forEach(function (n) {
      if (n.state !== "down") return;
      var r = radius(nodes, n.id);
      out.push({ id: n.id, name: n.name, affected: r.counts.total, text: whatBreaksText(n.name, r.affected) });
    });
    return out.sort(function (a, b) { return b.affected - a.affected || a.name.localeCompare(b.name); });
  }

  // The assets that most things lean on, for the "if this goes down" list: [{ id, name, kind, total, direct, state }].
  function biggestRadius(nodes, limit) {
    var adj = adjacency(nodes);
    var rows = (nodes || []).map(function (n) {
      return { id: n.id, name: n.name, kind: n.kind, criticality: n.criticality || "", state: n.state || "none", total: reach(adj.dependents, n.id).length, direct: adj.dependents[n.id].length };
    }).filter(function (r) { return r.total > 0; });
    rows.sort(function (a, b) { return b.total - a.total || b.direct - a.direct || a.name.localeCompare(b.name); });
    return rows.slice(0, limit || 10);
  }

  // ---- filtering -------------------------------------------------------------------------------------------------

  // `f` = { hidden: { kind: true }, q: "text" }. Boxes of a hidden kind drop off the map (their links with them). A search does
  // not hide anything; it only marks what matches (see matches()).
  function visible(map, f) {
    var hidden = (f && f.hidden) || {};
    var nodes = (map.nodes || []).filter(function (n) { return !hidden[n.kind]; });
    var ids = index(nodes);
    var edges = (map.edges || []).filter(function (e) { return ids[e.from] && ids[e.to]; });
    return { nodes: nodes, edges: edges };
  }

  function matches(node, q) {
    var t = String(q || "").trim().toLowerCase();
    if (!t) return false;
    return [node.name, node.runs, node.owner, node.location].join(" ").toLowerCase().indexOf(t) !== -1;
  }

  // Kinds that are on the map, in display order, with how many of each: [{ kind, label, count }].
  function kindCounts(nodes) {
    var c = {};
    (nodes || []).forEach(function (n) { c[n.kind] = (c[n.kind] || 0) + 1; });
    return KINDS.filter(function (k) { return c[k[0]]; }).map(function (k) { return { kind: k[0], label: k[1], count: c[k[0]] }; });
  }

  // ---- the diagram -----------------------------------------------------------------------------------------------

  // Reading it: each box sits in a lane (its layer: foundations at the bottom, the things built on them above). A link runs from a
  // box down to what it needs. Boxes in a lane are ordered to cross as few links as possible; a link that skips lanes is drawn
  // through a private track between the boxes of the lanes it passes, so it never runs behind a box; each box hands its links
  // out of separate points on its edge. Boxes with no link at all sit in a tray at the bottom.

  var NAME_CHARS = 31, NAME_LINES = 3, LINE_H = 14, TRAY_GAP = 30;

  // A name cut into at most three lines of 31 characters, so the whole name can be read on the box. A bracketed part
  // ("(campaign.barnyard.site)") starts a new line. Only a name longer than all three lines is cut, with an ellipsis.
  function wrapName(name, chars, maxLines) {
    var width = chars || NAME_CHARS, limit = maxLines || NAME_LINES;
    var text = String(name || "").replace(/\s+/g, " ").trim();
    if (!text) return [""];
    var at = text.indexOf(" (");
    var parts = at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text];
    var lines = [];
    parts.forEach(function (part) {
      var cur = "";
      part.split(" ").forEach(function (word) {
        while (word.length > width) {                      // a word longer than a line is broken
          if (cur) { lines.push(cur); cur = ""; }
          lines.push(word.slice(0, width)); word = word.slice(width);
        }
        if (!cur) cur = word;
        else if (cur.length + 1 + word.length <= width) cur += " " + word;
        else { lines.push(cur); cur = word; }
      });
      if (cur) lines.push(cur);
    });
    if (lines.length > limit) {
      lines = lines.slice(0, limit);
      var last = lines[limit - 1];
      lines[limit - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + "…";
    }
    return lines;
  }

  function boxHeight(name) { return wrapName(name).length * LINE_H + 36; }

  // How many pairs of links cross. `lines` is one list of points per link ([{ x, y }, ...]); two links that meet at the very same
  // point (the same box) do not count.
  function countCrossings(lines) {
    function orient(a, b, c) { var v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0; }
    function same(a, b) { return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6; }
    function cross(a, b, c, d) {
      if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
      var o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
      return o1 * o2 < 0 && o3 * o4 < 0;
    }
    var n = 0;
    for (var i = 0; i < lines.length; i++) {
      for (var j = i + 1; j < lines.length; j++) {
        var hit = false;
        for (var a = 0; a + 1 < lines[i].length && !hit; a++) {
          for (var b = 0; b + 1 < lines[j].length && !hit; b++) hit = cross(lines[i][a], lines[i][a + 1], lines[j][b], lines[j][b + 1]);
        }
        if (hit) n++;
      }
    }
    return n;
  }

  function laneHint(list) {
    var c = {};
    list.forEach(function (n) { c[n.kind] = (c[n.kind] || 0) + 1; });
    return Object.keys(c).sort(function (a, b) { return c[b] - c[a] || (KIND_RANK[a] || 99) - (KIND_RANK[b] || 99); }).slice(0, 3).map(kindLabel).join(", ");
  }

  // Least-squares x for items kept in order with a minimum gap between neighbours (pool adjacent violators).
  function settle(want, gaps) {
    var off = [0];
    for (var i = 1; i < want.length; i++) off.push(off[i - 1] + gaps[i - 1]);
    var blocks = [];
    want.forEach(function (t, i) {
      blocks.push({ sum: t - off[i], n: 1, from: i });
      while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
        var b = blocks.pop(), a = blocks[blocks.length - 1];
        a.sum += b.sum; a.n += b.n;
      }
    });
    var out = new Array(want.length);
    blocks.forEach(function (b) { for (var k = 0; k < b.n; k++) out[b.from + k] = b.sum / b.n + off[b.from + k]; });
    return out;
  }

  // Where each box goes, and how every link runs. -> { pos: { id: { x, y, w, h } }, lines: { id: [text lines] }, width, height,
  // rows, lanes: [{ title, hint, y, h }], order: [ids in reading order], edges: [{ from, to, d, points }], crossings }
  function layout(nodes, edges) {
    var list = nodes || [];
    var empty = { pos: {}, lines: {}, width: 0, height: 0, rows: 0, lanes: [], order: [], edges: [], crossings: 0 };
    if (!list.length) return empty;
    var by = index(list);
    var good = [], seenEdge = {};
    (edges || []).forEach(function (e) {
      var k = e.from + ">" + e.to;
      if (!by[e.from] || !by[e.to] || e.from === e.to || seenEdge[k]) return;
      seenEdge[k] = true;
      good.push({ from: e.from, to: e.to });
    });
    var linked = {};
    good.forEach(function (e) { linked[e.from] = true; linked[e.to] = true; });
    var byName = function (a, b) { return (KIND_RANK[by[a].kind] - KIND_RANK[by[b].kind]) || by[a].name.localeCompare(by[b].name) || (a < b ? -1 : a > b ? 1 : 0); };

    // ranks: one per layer that holds a linked box, the top row being the highest layer
    var layerSet = {};
    list.forEach(function (n) { if (linked[n.id]) layerSet[n.layer || 0] = true; });
    var layers = Object.keys(layerSet).map(Number).sort(function (a, b) { return b - a; });
    var rankOf = {};
    layers.forEach(function (l, i) { rankOf[l] = i; });
    var R = layers.length;
    var rank = {};
    list.forEach(function (n) { if (linked[n.id]) rank[n.id] = rankOf[n.layer || 0]; });

    // each link that runs down through the ranks becomes a chain of items; a link that skips ranks gets a track item in each
    // rank it passes. A link that does not run downward (a loop in the data) is drawn straight and takes no part in the ordering.
    var items = {};                                      // id -> { rank, real }
    var ranks = [];
    for (var r = 0; r < R; r++) ranks.push([]);
    var ids = Object.keys(linked).sort(byName);
    ids.forEach(function (id) { items[id] = { rank: rank[id], real: true }; ranks[rank[id]].push(id); });
    var chains = [], loose = [], segs = [];
    good.forEach(function (e, i) {
      var ra = rank[e.from], rb = rank[e.to];
      if (rb <= ra) { loose.push(e); return; }
      var chain = [e.from];
      for (var k = ra + 1; k < rb; k++) { var d = "~" + i + ":" + k; items[d] = { rank: k, real: false }; ranks[k].push(d); chain.push(d); }
      chain.push(e.to);
      chains.push({ e: e, chain: chain });
      for (var m = 0; m + 1 < chain.length; m++) segs.push([chain[m], chain[m + 1]]);
    });
    var up = {}, down = {};
    Object.keys(items).forEach(function (id) { up[id] = []; down[id] = []; });
    segs.forEach(function (sg) { down[sg[0]].push(sg[1]); up[sg[1]].push(sg[0]); });

    // order of the boxes inside each rank: a few sweeps of averaging the neighbours' places, then swapping neighbours while that
    // removes a crossing; the least crossed of a few fixed starting orders wins
    function placeOf(order) {
      var p = {};
      order.forEach(function (row) { row.forEach(function (id, i) { p[id] = i; }); });
      return p;
    }
    function crossBetween(order, p, r0) {                // crossings between rank r0 and r0 + 1
      var s = [];
      order[r0].forEach(function (u) { down[u].forEach(function (v) { s.push([p[u], p[v]]); }); });
      var n = 0;
      for (var i = 0; i < s.length; i++) for (var j = i + 1; j < s.length; j++) if ((s[i][0] - s[j][0]) * (s[i][1] - s[j][1]) < 0) n++;
      return n;
    }
    function total(order) {
      var p = placeOf(order), n = 0;
      for (var r0 = 0; r0 + 1 < R; r0++) n += crossBetween(order, p, r0);
      return n;
    }
    function sweep(order, ri, neighbours) {
      var p = placeOf(order), row = order[ri], key = {};
      row.forEach(function (id, i) {
        var ns = neighbours[id];
        var own = (i + 0.5) / row.length;
        key[id] = ns.length ? ns.reduce(function (sum, n) { return sum + (p[n] + 0.5) / order[items[n].rank].length; }, 0) / ns.length : own;
      });
      var at = {};
      row.forEach(function (id, i) { at[id] = i; });
      order[ri] = row.slice().sort(function (a, b) { return key[a] - key[b] || at[a] - at[b]; });
    }
    function transpose(order) {
      for (var pass = 0; pass < 8; pass++) {
        var moved = false;
        for (var ri = 0; ri < R; ri++) {
          for (var i = 0; i + 1 < order[ri].length; i++) {
            var p = placeOf(order);
            var before = (ri > 0 ? crossBetween(order, p, ri - 1) : 0) + (ri + 1 < R ? crossBetween(order, p, ri) : 0);
            var row = order[ri];
            var a = row[i]; row[i] = row[i + 1]; row[i + 1] = a;
            var q = placeOf(order);
            var after = (ri > 0 ? crossBetween(order, q, ri - 1) : 0) + (ri + 1 < R ? crossBetween(order, q, ri) : 0);
            if (after < before) moved = true;
            else { a = row[i]; row[i] = row[i + 1]; row[i + 1] = a; }
          }
        }
        if (!moved) break;
      }
    }
    function scramble(seed, id) {                        // a fixed shuffle: the same seed always orders the same way
      var v = seed * 2654435761;
      for (var i = 0; i < id.length; i++) v = (Math.imul(v ^ id.charCodeAt(i), 16777619) + seed) >>> 0;
      return v;
    }
    var starts = [
      function (a, b) { return byName(a, b); },
      function (a, b) { return -byName(a, b); }
    ];
    for (var seed = 1; seed <= START_SHUFFLES; seed++) starts.push((function (sd) { return function (a, b) { return scramble(sd, a) - scramble(sd, b) || (a < b ? -1 : 1); }; })(seed));
    var best = null, bestN = Infinity;
    starts.forEach(function (cmp) {
      var order = ranks.map(function (row) {
        var reals = row.filter(function (id) { return items[id].real; }).sort(cmp);
        return reals.concat(row.filter(function (id) { return !items[id].real; }).sort());
      });
      var n = total(order);
      if (n < bestN) { bestN = n; best = order.map(function (row) { return row.slice(); }); }
      for (var it = 0; it < 16 && bestN > 0; it++) {
        if (it % 2 === 0) for (var ri = 1; ri < R; ri++) sweep(order, ri, up);
        else for (var rj = R - 2; rj >= 0; rj--) sweep(order, rj, down);
        transpose(order);
        n = total(order);
        if (n < bestN) { bestN = n; best = order.map(function (row) { return row.slice(); }); }
      }
    });
    var order = best || ranks;

    // sideways places: start packed and centred, then pull each item toward its neighbours, row by row, up and down
    function widthOf(id) { return items[id].real ? NODE_W : 0; }
    function gapBetween(a, b) { return items[a].real && items[b].real ? GAP_X : items[a].real || items[b].real ? TRACK + 2 : TRACK; }
    function gapsOf(row) { var g = []; for (var i = 0; i + 1 < row.length; i++) g.push((widthOf(row[i]) + widthOf(row[i + 1])) / 2 + gapBetween(row[i], row[i + 1])); return g; }
    var cx = {};
    var spans = order.map(function (row) { var g = gapsOf(row); return g.reduce(function (s, v) { return s + v; }, 0); });
    var widest = spans.reduce(function (m, v) { return Math.max(m, v); }, 0);
    order.forEach(function (row, ri) {
      var x = (widest - spans[ri]) / 2, g = gapsOf(row);
      row.forEach(function (id, i) { cx[id] = x; if (i < g.length) x += g[i]; });
    });
    function pull(ri, neighbours) {
      var row = order[ri];
      if (!row.length) return;
      var want = row.map(function (id) {
        var ns = neighbours[id];
        return ns.length ? ns.reduce(function (sum, n) { return sum + cx[n]; }, 0) / ns.length : cx[id];
      });
      var xs = settle(want, gapsOf(row));
      row.forEach(function (id, i) { cx[id] = xs[i]; });
    }
    var both = {};
    Object.keys(items).forEach(function (id) { both[id] = up[id].concat(down[id]); });
    for (var pass = 0; pass < 6; pass++) {
      for (var ri = 1; ri < R; ri++) pull(ri, up);
      for (var rj = R - 2; rj >= 0; rj--) pull(rj, down);
    }
    for (var pass2 = 0; pass2 < 3; pass2++) { for (var rk = 0; rk < R; rk++) pull(rk, both); }
    var minX = Infinity, maxX = -Infinity;
    Object.keys(items).forEach(function (id) { var w = widthOf(id) / 2; minX = Math.min(minX, cx[id] - w); maxX = Math.max(maxX, cx[id] + w); });
    var shift = PAD - (isFinite(minX) ? minX : 0);
    Object.keys(cx).forEach(function (id) { cx[id] += shift; });
    var drawW = isFinite(maxX) ? maxX - minX + PAD * 2 : PAD * 2;

    // rows and lanes, top to bottom
    var pos = {}, lines = {}, lanes = [], rows = [], cursor = PAD;
    function rowOf(ids2, title, hint, head, gap) {
      var top = cursor, boxTop = top + head, h = 0;
      ids2.forEach(function (id) { lines[id] = wrapName(by[id].name); h = Math.max(h, lines[id].length * LINE_H + 36); });
      lanes.push({ title: title, hint: hint, y: top, h: head + h + LANE_FOOT });
      cursor = top + head + h + LANE_FOOT + gap;
      return { boxTop: boxTop, h: h };
    }
    order.forEach(function (row, ri) {
      var reals = row.filter(function (id) { return items[id].real; }).map(function (id) { return by[id]; });
      var layer = layers[ri];
      rows.push(rowOf(row.filter(function (id) { return items[id].real; }), layer === 0 ? "Foundations" : "Level " + layer, laneHint(reals), LANE_HEAD, GAP_Y));
      var info = rows[ri];
      row.forEach(function (id) {
        if (!items[id].real) return;
        var h = lines[id].length * LINE_H + 36;
        pos[id] = { x: cx[id] - NODE_W / 2, y: info.boxTop + Math.round((info.h - h) / 2), w: NODE_W, h: h };
      });
    });
    var tray = list.filter(function (n) { return !linked[n.id]; }).map(function (n) { return n.id; }).sort(byName);
    var perRow = Math.max(4, Math.min(8, Math.floor((Math.max(drawW, 5 * (NODE_W + GAP_X)) - PAD * 2 + GAP_X) / (NODE_W + GAP_X))));
    var trayRows = [];
    for (var t = 0; t < tray.length; t += perRow) trayRows.push(tray.slice(t, t + perRow));
    var trayW = 0;
    if (R && trayRows.length) cursor -= GAP_Y - TRAY_GAP;
    trayRows.forEach(function (row, ti) {
      var info = rowOf(row, ti === 0 ? "Not linked to anything" : "", ti === 0 ? laneHint(row.map(function (id) { return by[id]; })) : "", ti === 0 ? LANE_HEAD : 6, ti === trayRows.length - 1 ? 0 : 12);
      row.forEach(function (id, i) {
        var h = lines[id].length * LINE_H + 36;
        pos[id] = { x: PAD + i * (NODE_W + GAP_X), y: info.boxTop + Math.round((info.h - h) / 2), w: NODE_W, h: h };
      });
      trayW = Math.max(trayW, PAD * 2 + row.length * NODE_W + (row.length - 1) * GAP_X);
      rows.push(info);
    });
    var width = Math.max(drawW, trayW);
    var height = lanes[lanes.length - 1].y + lanes[lanes.length - 1].h + PAD;

    // links: separate points along the bottom of the box that needs and the top of the box that is needed, nearest neighbour first
    var outs = {}, ins = {};
    chains.forEach(function (c, i) {
      (outs[c.e.from] = outs[c.e.from] || []).push({ at: i, next: c.chain[1] });
      (ins[c.e.to] = ins[c.e.to] || []).push({ at: i, prev: c.chain[c.chain.length - 2] });
    });
    var portOut = {}, portIn = {};
    function spread(group, key, into) {
      Object.keys(group).forEach(function (id) {
        var g = group[id].slice().sort(function (a, b) { return cx[a[key]] - cx[b[key]] || a.at - b.at; });
        var n = g.length, span = n > 1 ? Math.min(NODE_W - 28, (n - 1) * 28) : 0, mid = pos[id].x + NODE_W / 2;
        g.forEach(function (x, i) { into[x.at] = n > 1 ? mid - span / 2 + i * span / (n - 1) : mid; });
      });
    }
    spread(outs, "next", portOut);
    spread(ins, "prev", portIn);
    function f(v) { return Math.round(v * 10) / 10; }
    function curve(x0, y0, x1, y1) {
      if (Math.abs(x0 - x1) < 0.5) return "L" + f(x1) + " " + f(y1);
      var dy = (y1 - y0) / 2;
      return "C" + f(x0) + " " + f(y0 + dy) + " " + f(x1) + " " + f(y1 - dy) + " " + f(x1) + " " + f(y1);
    }
    var outEdges = [], byKey = {};
    chains.forEach(function (c, i) {
      var from = pos[c.e.from], to = pos[c.e.to];
      var x = portOut[i], y = from.y + from.h;
      var d = "M" + f(x) + " " + f(y), pts = [{ x: x, y: y }];
      for (var m = 1; m + 1 < c.chain.length; m++) {
        var info = rows[items[c.chain[m]].rank], tx = cx[c.chain[m]];
        d += curve(x, y, tx, info.boxTop) + "L" + f(tx) + " " + f(info.boxTop + info.h);
        pts.push({ x: tx, y: info.boxTop }, { x: tx, y: info.boxTop + info.h });
        x = tx; y = info.boxTop + info.h;
      }
      d += curve(x, y, portIn[i], to.y);
      pts.push({ x: portIn[i], y: to.y });
      byKey[c.e.from + ">" + c.e.to] = { from: c.e.from, to: c.e.to, d: d, points: pts };
    });
    loose.forEach(function (e) {
      var pa = pos[e.from], pb = pos[e.to];
      byKey[e.from + ">" + e.to] = { from: e.from, to: e.to, d: edgePath(pa, pb), points: [{ x: pa.x + pa.w / 2, y: pa.y + pa.h }, { x: pb.x + pb.w / 2, y: pb.y }] };
    });
    good.forEach(function (e) { if (byKey[e.from + ">" + e.to]) outEdges.push(byKey[e.from + ">" + e.to]); });
    var reading = [];
    order.forEach(function (row) { row.forEach(function (id) { if (items[id].real) reading.push(id); }); });
    tray.forEach(function (id) { reading.push(id); });
    return {
      pos: pos, lines: lines, width: width, height: height, rows: lanes.length, lanes: lanes, order: reading, edges: outEdges,
      crossings: countCrossings(outEdges.map(function (e) { return e.points; }))
    };
  }

  // A straight-down curve from the bottom of `from` (the thing that needs) to the top of `to` (what it needs), as an SVG path.
  // Used for a link the ordering could not place (one that runs upward, which only a loop in the data makes).
  function edgePath(pa, pb) {
    var x1 = pa.x + (pa.w || NODE_W) / 2, y1 = pa.y + (pa.h || NODE_H), x2 = pb.x + (pb.w || NODE_W) / 2, y2 = pb.y;
    var dy = Math.max(30, Math.abs(y2 - y1) / 2);
    var sign = y2 >= y1 ? 1 : -1;
    return "M" + x1 + " " + y1 + " C" + x1 + " " + (y1 + sign * dy) + " " + x2 + " " + (y2 - sign * dy) + " " + x2 + " " + y2;
  }

  // ---- what to light up -----------------------------------------------------------------------------------------

  // The boxes to light for `id`: what it needs and what needs it. `through` follows the links all the way (the blast radius);
  // without it only the boxes it is directly linked to. -> { needs: { id: true }, dependents: { id: true } }
  function neighbours(nodes, id, through) {
    var adj = adjacency(nodes), needs = {}, dependents = {};
    if (!adj.deps[id]) return { needs: needs, dependents: dependents };
    if (through) {
      reach(adj.deps, id).forEach(function (x) { needs[x.id] = true; });
      reach(adj.dependents, id).forEach(function (x) { dependents[x.id] = true; });
    } else {
      adj.deps[id].forEach(function (x) { needs[x] = true; });
      adj.dependents[id].forEach(function (x) { dependents[x] = true; });
    }
    return { needs: needs, dependents: dependents };
  }

  // Which colour a link takes while `id` is picked: "need" (on a path to something it needs), "dependent" (on a path from
  // something that needs it) or "" (not part of it, so it fades). Without `through`, only links that touch `id` count.
  function edgeRole(e, id, sets, through) {
    if (!through && e.from !== id && e.to !== id) return "";
    var inDep = function (x) { return x === id || sets.dependents[x]; }, inNeed = function (x) { return x === id || sets.needs[x]; };
    if (inDep(e.from) && inDep(e.to)) return "dependent";
    if (inNeed(e.from) && inNeed(e.to)) return "need";
    return "";
  }

  // ---- editing the links -----------------------------------------------------------------------------------------

  // What a person may pick as something `id` needs: everything except itself, and except anything that already needs `id` (that
  // would make the two wait on each other, which the Worker refuses). -> [{ id, name, kind, blocked, reason }]
  function linkChoices(nodes, id) {
    var adj = adjacency(nodes);
    var below = {};                                   // the things that need `id`, directly or not
    reach(adj.dependents, id).forEach(function (r) { below[r.id] = true; });
    return (nodes || []).filter(function (n) { return n.id !== id; }).map(function (n) {
      var blocked = !!below[n.id];
      return { id: n.id, name: n.name, kind: n.kind, blocked: blocked, reason: blocked ? "It needs this one already (a loop)" : "" };
    }).sort(function (a, b) { return (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || a.name.localeCompare(b.name); });
  }

  // The list after ticking or unticking one thing (order kept, no repeats).
  function setLink(current, targetId, on) {
    var list = (current || []).slice();
    var at = list.indexOf(targetId);
    if (on) { if (at === -1) list.push(targetId); }
    else if (at !== -1) list.splice(at, 1);
    return list;
  }

  function sameList(a, b) {
    var x = (a || []).slice().sort(), y = (b || []).slice().sort();
    return x.length === y.length && x.every(function (v, i) { return v === y[i]; });
  }

  // ---- the starting links ----------------------------------------------------------------------------------------

  var STATE_WORDS = { "new": "Will be added", there: "Already there", missing: "Skipped: one end is not in the register", cycle: "Skipped: it would make a loop" };

  // The sentence over the preview: "Adds 36 links and 2 entries (the Cloudflare tunnels). 0 already there, 0 skipped."
  function planText(plan) {
    if (!plan || !plan.counts) return "";
    var c = plan.counts, e = (plan.ensure || []).length;
    var skipped = (c.missing || 0) + (c.cycle || 0);
    if (!c["new"] && !e) return c.there ? "All " + c.there + " starting links are already on the map." : "There is nothing to add: the register has none of the things the starting links join.";
    return "Adds " + c["new"] + (c["new"] === 1 ? " link" : " links") + (e ? " and " + e + (e === 1 ? " entry" : " entries") + " (" + plan.ensure.map(function (x) { return x.name; }).join(", ") + ")" : "") +
      ". " + (c.there || 0) + " already there, " + skipped + " skipped.";
  }

  function stateWord(state) { return STATE_WORDS[state] || state; }

  // ---- the Overview tile -----------------------------------------------------------------------------------------

  // "no monitor, no runbook"; a gap in `overdue` (an accepted gap whose review day has passed, so it counts again) says so.
  function gapsText(gaps, overdue) {
    var late = overdue || [];
    var w = (gaps || []).map(function (g) { return (GAP_WORDS[g] || g) + (late.indexOf(g) !== -1 ? " (review overdue)" : ""); });
    return w.join(", ");
  }

  // "2027-02-14" -> "14 Feb 2027" (read as written: no time zone can move it).
  function dayWords(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    if (!m || +m[2] < 1 || +m[2] > 12) return String(ymd || "");
    return +m[3] + " " + MONTHS[+m[2] - 1] + " " + m[1];
  }

  // One accepted gap as it is always shown, never hidden: { gap, label, overdue, text }.
  //   "Accepted until 14 Feb 2027: Renewal is on the Calendar"
  //   "Review overdue (was accepted until 14 Feb 2027): Renewal is on the Calendar"
  function acceptedLine(a) {
    var reason = a.reason ? ": " + a.reason : "";
    return {
      gap: a.gap, label: GAP_WORDS[a.gap] || a.gap, overdue: !!a.overdue, review: a.review,
      text: a.overdue ? "Review overdue (was accepted until " + dayWords(a.review) + ")" + reason : "Accepted until " + dayWords(a.review) + reason
    };
  }

  // The accepted gaps of a summary or a map answer ({ list, total } or a bare list) as rows: { id, name, kind, gap, label, overdue, text }.
  function acceptedRows(list) {
    return (Array.isArray(list) ? list : []).map(function (a) {
      var l = acceptedLine(a);
      return { id: a.id, name: a.name, kind: a.kind, gap: l.gap, label: l.label, overdue: l.overdue, review: l.review, text: l.text };
    });
  }

  // The tile's numbers and rows from GET /reg/summary's `links`: { linked, links, weakest: [{ id, name, line, tone }], accepted }.
  // `accepted` is the Worker's first few accepted gaps and `acceptedCount` how many there are in all.
  function weakestModel(links) {
    var l = links || { assets: 0, links: 0, linked: 0, unlinked: 0, cycles: 0, weakest: [] };
    var accepted = acceptedRows(l.accepted);
    return {
      assets: l.assets || 0, links: l.links || 0, linked: l.linked || 0, unlinked: l.unlinked || 0, cycles: l.cycles || 0,
      weakest: (l.weakest || []).map(function (w) {
        return {
          id: w.id, name: w.name, kind: w.kind,
          line: w.dependents + (w.dependents === 1 ? " thing depends on it" : " things depend on it") + "; " + gapsText(w.gaps, w.overdue),
          tone: w.criticality === "critical" || w.criticality === "high" || w.dependents >= 5 ? "alert" : "attn"
        };
      }),
      accepted: accepted, acceptedCount: Math.max(accepted.length, l.acceptedCount || 0)
    };
  }

  // ---- words for what went wrong ---------------------------------------------------------------------------------

  var ERRORS = {
    dependency_cycle: "That would make two things wait on each other. Pick something that does not already depend on this.",
    dependency_self: "Something cannot depend on itself.",
    dependency_unknown: "One of those is no longer in the register. Refresh the map and try again.",
    dependsOn_invalid: "That list of links is not valid.",
    dependsOn_too_many: "An asset can list at most 20 things it needs.",
    recent_sign_in_required: "Sign in again to make this change (it needs a recent sign-in).",
    rate_limited: "That is too many changes in a minute. Wait a moment and try again.",
    not_found: "That asset is no longer in the register.",
    unauthenticated: "Sign in to use the map.",
    forbidden: "This page is for the person who runs the hub."
  };

  // An address from the server that may become a link on this page: https only, with no space, quote, angle bracket, backslash or control
  // character. Anything else (javascript:, data:, a reference such as "PR 444") gives "" and is never made into a link.
  function safeWebLink(v) {
    var s = typeof v === "string" ? v.trim() : "";
    return /^https:\/\/[^\s"'<>\\\u0000-\u001f\u007f-\u009f]{4,300}$/.test(s) ? s : "";
  }

  function errorText(body, status) {
    var code = body && body.error;
    if (code && ERRORS[code]) return ERRORS[code];
    if (!status) return "Could not reach the Worker. Try again in a moment.";
    return "That did not work (" + (code || "error " + status) + ").";
  }

  var api = {
    KINDS: KINDS, NODE_W: NODE_W, NODE_H: NODE_H, kindLabel: kindLabel, kindOne: kindOne, index: index, adjacency: adjacency, reach: reach,
    radius: radius, whatBreaksText: whatBreaksText, incidentText: incidentText, stateModel: stateModel, banner: banner, downReport: downReport,
    biggestRadius: biggestRadius, visible: visible, matches: matches, kindCounts: kindCounts, layout: layout, edgePath: edgePath, wrapName: wrapName, boxHeight: boxHeight, countCrossings: countCrossings, neighbours: neighbours, edgeRole: edgeRole,
    linkChoices: linkChoices, setLink: setLink, sameList: sameList, planText: planText, stateWord: stateWord, gapsText: gapsText,
    dayWords: dayWords, acceptedLine: acceptedLine, acceptedRows: acceptedRows, weakestModel: weakestModel, errorText: errorText, safeWebLink: safeWebLink
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardMapLogic = api;
})(typeof window !== "undefined" ? window : this);
