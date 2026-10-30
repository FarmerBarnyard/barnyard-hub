// The old addresses of four pages (services.html, incidents.html, reports.html, release.html) now lead to their tabs on the
// Monitoring page. Each of those files is a few lines of HTML that names its tab in data-to and loads this script, which sends
// the visitor on at once: an old bookmark, an email link or an Overview tile still works. An incident's own address keeps its id
// (incidents.html#inc_abcd1234 -> monitoring.html#incidents/inc_abcd1234) and a query string is carried across.

(function () {
  "use strict";

  var TABS = ["services", "incidents", "reports", "release"];

  // -> "monitoring.html?a=1#incidents/inc_abcd1234". An unknown tab goes to the Dashboard; a query or hash with anything unusual
  // in it is dropped rather than passed on.
  function target(tab, search, hash) {
    var t = TABS.indexOf(tab) === -1 ? "dashboard" : tab;
    var out = "#" + t;
    var id = String(hash || "").replace(/^#/, "");
    if (t === "incidents" && /^(?:incidents\/)?inc_[a-z0-9]{8}$/.test(id)) out = "#incidents/" + id.replace(/^incidents\//, "");
    var q = /^\?[A-Za-z0-9_=&.%-]{1,200}$/.test(String(search || "")) ? search : "";
    return "monitoring.html" + q + out;
  }

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = { target: target, TABS: TABS };
    return;
  }

  location.replace(target(document.body.getAttribute("data-to"), location.search, location.hash));
})();
