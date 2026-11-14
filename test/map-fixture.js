// The owner's real dependency graph (27 boxes, 47 links) as GET /reg/map hands it over, for test/map.test.js and for trying the
// map page against a stand-in for the Worker. 'X needs Y' is { from: X, to: Y }; layer is the Worker's (0 = nothing under it).
//
//   mapFixture()  ->  { ok, monitoring, nodes, edges, layerCount, stats, weakest, cycles }

(function (root) {
  "use strict";

  // key, kind, name, layer, criticality, state, what it needs
  var ROWS = [
    ["CF", "account", "Cloudflare account", 0, "critical", "none", []],
    ["GH", "account", "GitHub account (FarmerBarnyard)", 0, "critical", "none", []],
    ["OR", "account", "Oracle Cloud account", 0, "normal", "none", []],
    ["TLS", "certificate", "TLS certificates (Cloudflare and GitHub Pages)", 0, "high", "none", []],
    ["M365S", "licence", "Microsoft 365 subscription and licences", 0, "high", "none", []],
    ["VMH", "server", "BARNYARDVMH01", 0, "normal", "none", []],
    ["VPS", "server", "VTT VPS (barnyardvps01)", 0, "normal", "up", []],
    ["CLAUDE", "subscription", "Claude subscription", 0, "normal", "none", []],
    ["M365T", "account", "Microsoft 365 tenant (Entra, Exchange, SharePoint)", 1, "critical", "none", ["M365S"]],
    ["DOM", "domain", "barnyard.site", 1, "critical", "none", ["CF"]],
    ["APP02", "server", "app02", 1, "high", "up", ["VMH"]],
    ["CLD01", "server", "BARNYARDCLD01", 1, "high", "up", ["OR"]],
    ["KBAPP", "app", "Barnyard KB mirror (Entra app)", 2, "normal", "none", ["M365T"]],
    ["GRAPH", "app", "Barnyard-Graph-Read (Entra app: Users list, M365 Health, Services)", 2, "normal", "none", ["M365T"]],
    ["HUBAUTH", "app", "Hub sign-in app (Entra app registration)", 2, "critical", "none", ["M365T"]],
    ["MAILAPP", "app", "Mail sender app (Entra app registration)", 2, "high", "none", ["M365T"]],
    ["TUN2", "network", "Cloudflare tunnel to app02", 2, "high", "none", ["APP02", "CF"]],
    ["TUNC", "network", "Cloudflare tunnel to BARNYARDCLD01", 2, "high", "none", ["CLD01", "CF"]],
    ["WORKER", "app", "Barnyard Worker (api.barnyard.site)", 3, "critical", "none", ["CF", "DOM", "TLS", "TUN2", "TUNC", "MAILAPP"]],
    ["CAMP", "app", "Campaign site (campaign.barnyard.site)", 4, "high", "up", ["GH", "WORKER", "DOM", "TLS", "HUBAUTH"]],
    ["DASH", "app", "Dashboard site (dashboard.barnyard.site)", 4, "high", "up", ["GH", "WORKER", "DOM", "TLS", "HUBAUTH"]],
    ["STOCK", "app", "Stocks site (stocks.barnyard.site)", 4, "normal", "up", ["GH", "WORKER", "DOM", "TLS", "HUBAUTH"]],
    ["STUDY", "app", "Study site (study.barnyard.site)", 4, "normal", "up", ["GH", "WORKER", "DOM", "TLS", "HUBAUTH"]],
    ["KBMIR", "app", "Knowledgebase mirror (SharePoint site KnowledgebaseMirror)", 4, "normal", "none", ["M365T", "KBAPP", "WORKER"]],
    ["BACKUP", "app", "Nightly encrypted data copy (to BARNYARDCLD01)", 4, "high", "none", ["WORKER", "CLD01"]],
    ["OUTLOOK", "app", "Outlook calendar and Calendar auto-sync", 4, "normal", "none", ["M365T", "WORKER"]],
    ["RELEASE", "app", "Release board and code health (GitHub read token)", 4, "normal", "none", ["GH", "WORKER"]]
  ];

  function mapFixture() {
    var id = function (key) { return "as_" + (key.toLowerCase() + "0000000000").slice(0, 10); };
    var needed = {};
    ROWS.forEach(function (r) { r[6].forEach(function (k) { needed[k] = (needed[k] || 0) + 1; }); });
    var nodes = ROWS.map(function (r) {
      return {
        id: id(r[0]), kind: r[1], name: r[2], criticality: r[4], dependsOn: r[6].map(id), layer: r[3], dependentsCount: needed[r[0]] || 0, needsCount: r[6].length,
        state: r[5], affectedBy: [], gaps: r[4] === "critical" && r[5] === "none" ? ["monitor"] : [], runs: "", owner: "", location: ""
      };
    });
    var edges = [];
    ROWS.forEach(function (r) { r[6].forEach(function (k) { edges.push({ from: id(r[0]), to: id(k) }); }); });
    return { ok: true, monitoring: true, nodes: nodes, edges: edges, layerCount: 5, stats: { assets: nodes.length, links: edges.length, unlinked: 2, down: 0, affected: 0 }, weakest: [], cycles: [] };
  }

  var api = { mapFixture: mapFixture };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.mapFixture = mapFixture;
})(typeof window !== "undefined" ? window : this);
