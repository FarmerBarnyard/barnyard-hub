// Once landing.js has decided the visitor is signed in it shows the page (data-landing="ok"). The example pages were built to measure
// themselves at load, and the gate keeps them hidden until then, so tell them to measure again the moment they are shown.
(function () {
  "use strict";
  var de = document.documentElement;
  function fire() { try { window.dispatchEvent(new Event("resize")); } catch (e) { /* old browser: nothing to do */ } }
  if (de.getAttribute("data-landing") === "ok") { fire(); return; }
  if (typeof MutationObserver !== "function") return;
  var mo = new MutationObserver(function () { if (de.getAttribute("data-landing") === "ok") { mo.disconnect(); fire(); } });
  mo.observe(de, { attributes: true, attributeFilter: ["data-landing"] });
})();
