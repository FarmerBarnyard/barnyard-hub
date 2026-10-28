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

  var KINDS = [["server", "Servers"], ["network", "Network"], ["app", "Apps and sites"], ["domain", "Domains"], ["certificate", "Certificates"], ["account", "Accounts and tenants"], ["licence", "Licences"], ["subscription", "Subscriptions"], ["other", "Other"]];
  var KIND_LABEL = {};
  KINDS.forEach(function (k) { KIND_LABEL[k[0]] = k[1]; });
  var KIND_ONE = { server: "Server", network: "Network", app: "App or site", domain: "Domain", certificate: "Certificate", account: "Account", licence: "Licence", subscription: "Subscription", other: "Other" };
  var KIND_RANK = {};
  KINDS.forEach(function (k, i) { KIND_RANK[k[0]] = i; });
  var CRIT_RANK = { critical: 0, high: 1, normal: 2, low: 3, "": 4 };
  var GAP_WORDS = { monitor: "no monitor", backup: "no backup job names it", runbook: "no runbook" };

  // Box size and spacing of the diagram, in drawing units.
  var NODE_W = 196, NODE_H = 48, GAP_X = 18, GAP_Y = 86, PAD = 28;

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

  // Where each box goes. Things nothing is underneath (foundations) are the bottom row, and each thing sits above the deepest
  // thing it needs. Boxes in a row are ordered to keep the links short (a few passes of averaging the neighbours' places).
  // -> { pos: { id: { x, y } }, width, height, rows: n }
  function layout(nodes, edges) {
    var list = nodes || [];
    if (!list.length) return { pos: {}, width: 0, height: 0, rows: 0 };
    var layerSet = {};
    list.forEach(function (n) { layerSet[n.layer || 0] = true; });
    var layers = Object.keys(layerSet).map(Number).sort(function (a, b) { return b - a; });   // top row = highest layer
    var rowOf = {};
    layers.forEach(function (l, i) { rowOf[l] = i; });
    var rows = layers.map(function () { return []; });
    list.slice().sort(function (a, b) { return (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || a.name.localeCompare(b.name); })
      .forEach(function (n) { rows[rowOf[n.layer || 0]].push(n.id); });
    var up = {}, down = {};                                   // neighbours: up = needs this one (row above), down = this needs it
    list.forEach(function (n) { up[n.id] = []; down[n.id] = []; });
    (edges || []).forEach(function (e) {
      if (!up[e.to] || !down[e.from]) return;
      down[e.from].push(e.to);
      up[e.to].push(e.from);
    });
    var step = NODE_W + GAP_X;
    var widest = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
    var xOf = {};
    function place() {
      rows.forEach(function (r) {
        var offset = (widest - r.length) * step / 2;
        r.forEach(function (id, i) { xOf[id] = offset + i * step; });
      });
    }
    place();
    function sweep(order, neighbours) {
      order.forEach(function (ri) {
        var r = rows[ri];
        var key = {};
        r.forEach(function (id, i) {
          var ns = neighbours[id].filter(function (n) { return xOf[n] !== undefined; });
          key[id] = ns.length ? ns.reduce(function (s, n) { return s + xOf[n]; }, 0) / ns.length : xOf[id];
        });
        r.sort(function (a, b) { return key[a] - key[b]; });
      });
      place();
    }
    var topDown = rows.map(function (_, i) { return i; });
    var bottomUp = topDown.slice().reverse();
    for (var pass = 0; pass < 4; pass++) { sweep(topDown, up); sweep(bottomUp, down); }
    var pos = {};
    rows.forEach(function (r, ri) { r.forEach(function (id) { pos[id] = { x: PAD + xOf[id], y: PAD + ri * (NODE_H + GAP_Y) }; }); });
    return { pos: pos, width: PAD * 2 + (widest - 1) * step + NODE_W, height: PAD * 2 + (rows.length - 1) * (NODE_H + GAP_Y) + NODE_H, rows: rows.length };
  }

  // The curve from the bottom of `from` (the thing that needs) to the top of `to` (what it needs), as an SVG path.
  function edgePath(pa, pb) {
    var x1 = pa.x + NODE_W / 2, y1 = pa.y + NODE_H, x2 = pb.x + NODE_W / 2, y2 = pb.y;
    var dy = Math.max(30, Math.abs(y2 - y1) / 2);
    var sign = y2 >= y1 ? 1 : -1;
    return "M" + x1 + " " + y1 + " C" + x1 + " " + (y1 + sign * dy) + " " + x2 + " " + (y2 - sign * dy) + " " + x2 + " " + y2;
  }

  // A name that fits a box: cut at 22 characters with an ellipsis.
  function fitName(name) {
    var s = String(name || "");
    return s.length > 22 ? s.slice(0, 21) + "…" : s;
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

  // "no monitor, no runbook"
  function gapsText(gaps) {
    var w = (gaps || []).map(function (g) { return GAP_WORDS[g] || g; });
    return w.join(", ");
  }

  // The tile's numbers and rows from GET /reg/summary's `links`: { linked, links, weakest: [{ id, name, line, tone }] }
  function weakestModel(links) {
    var l = links || { assets: 0, links: 0, linked: 0, unlinked: 0, cycles: 0, weakest: [] };
    return {
      assets: l.assets || 0, links: l.links || 0, linked: l.linked || 0, unlinked: l.unlinked || 0, cycles: l.cycles || 0,
      weakest: (l.weakest || []).map(function (w) {
        return {
          id: w.id, name: w.name, kind: w.kind,
          line: w.dependents + (w.dependents === 1 ? " thing depends on it" : " things depend on it") + "; " + gapsText(w.gaps),
          tone: w.criticality === "critical" || w.criticality === "high" || w.dependents >= 5 ? "alert" : "attn"
        };
      })
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

  function errorText(body, status) {
    var code = body && body.error;
    if (code && ERRORS[code]) return ERRORS[code];
    if (!status) return "Could not reach the Worker. Try again in a moment.";
    return "That did not work (" + (code || "error " + status) + ").";
  }

  var api = {
    KINDS: KINDS, NODE_W: NODE_W, NODE_H: NODE_H, kindLabel: kindLabel, kindOne: kindOne, index: index, adjacency: adjacency, reach: reach,
    radius: radius, whatBreaksText: whatBreaksText, incidentText: incidentText, stateModel: stateModel, banner: banner, downReport: downReport,
    biggestRadius: biggestRadius, visible: visible, matches: matches, kindCounts: kindCounts, layout: layout, edgePath: edgePath, fitName: fitName,
    linkChoices: linkChoices, setLink: setLink, sameList: sameList, planText: planText, stateWord: stateWord, gapsText: gapsText,
    weakestModel: weakestModel, errorText: errorText
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardMapLogic = api;
})(typeof window !== "undefined" ? window : this);
