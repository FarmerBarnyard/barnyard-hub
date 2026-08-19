// Polls the free Cloudflare Worker proxy (barnyard-live-prices, shared with
// the market-dashboard project) for live prices and patches any
// [data-live-symbol][data-live-market] element in the page in place.
//
// Entirely best-effort: if the Worker below isn't reachable (network hiccup,
// transient upstream failure) this just no-ops and the page keeps showing
// whatever static fallback text was already there. Nothing here can break
// the page. Same pattern as market-dashboard's live-prices.js.
//
(function () {
  var LIVE_PRICE_API = "https://barnyard-live-prices.nathanbarnard29.workers.dev";
  var POLL_INTERVAL_MS = 15000;
  // A few consecutive failed/incomplete polls shouldn't immediately flip a
  // tile to "stale" (could just be one blip) -- only do so once this much
  // time has passed since the last successful update.
  var STALE_THRESHOLD_MS = POLL_INTERVAL_MS * 2.5;
  // A hung/blackholed request never resolves or rejects on its own -- cap
  // how long we'll wait before aborting it so it eventually lands in the
  // .catch below instead of accumulating forever.
  var FETCH_TIMEOUT_MS = 10000;
  // key ("MARKET:SYMBOL") -> timestamp (ms) of last successful, fully-valid update.
  var lastSuccessAt = {};

  function fmtIndexLevel(n) {
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtIndexChange(pct) {
    var arrow = pct >= 0 ? "\u25B2" : "\u25BC";
    return arrow + " " + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  }
  function fmtTickerPrice(n) {
    return "$" + n.toFixed(2);
  }
  function fmtPctSigned(pct) {
    return (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  }
  function fmtDollarSigned(change) {
    return "$" + (change >= 0 ? "+" : "") + change.toFixed(2);
  }
  function fmtTickerChange(pct, change) {
    return fmtPctSigned(pct) + " (" + fmtDollarSigned(change) + ")";
  }

  function cssAttrEscape(value) {
    return value.replace(/["\\]/g, "\\$&");
  }

  function applyQuote(symbol, market, quote) {
    var selector =
      '[data-live-symbol="' + cssAttrEscape(symbol) + '"][data-live-market="' + cssAttrEscape(market) + '"]';
    document.querySelectorAll(selector).forEach(function (el) {
      var field = el.getAttribute("data-live-field");
      var isIndex = el.hasAttribute("data-live-index");
      if (field === "price") {
        el.textContent = isIndex ? fmtIndexLevel(quote.price) : fmtTickerPrice(quote.price);
      } else if (field === "change") {
        el.textContent = isIndex
          ? fmtIndexChange(quote.changePercent)
          : fmtTickerChange(quote.changePercent, quote.change);
        el.classList.remove("up", "down");
        el.classList.add(quote.changePercent >= 0 ? "up" : "down");
      } else if (field === "change_pct") {
        el.textContent = fmtPctSigned(quote.changePercent);
      } else if (field === "change_abs") {
        el.textContent = "(" + fmtDollarSigned(quote.change) + ")";
      } else if (field === "dot") {
        el.classList.remove("live-stale");
        el.classList.add("live-ok");
        el.title = "Live \u2014 updated " + new Date().toLocaleTimeString();
      }
      // A successful, complete update always clears any stale marker left
      // on this element by markStaleIfDue, regardless of field type.
      if (field !== "dot") {
        el.classList.remove("stale");
        el.removeAttribute("aria-label");
      }
    });
  }

  // A "complete" quote has finite numbers (not just typeof "number" --
  // NaN/Infinity are typeof "number" too, and would otherwise render as
  // literal "NaN"/"Infinity") for every field the UI applies.
  function isCompleteQuote(data) {
    return (
      !!data &&
      Number.isFinite(data.price) &&
      Number.isFinite(data.change) &&
      Number.isFinite(data.changePercent)
    );
  }

  function markStaleIfDue(symbol, market) {
    var key = market + ":" + symbol;
    var last = lastSuccessAt[key];
    var elapsed = last ? Date.now() - last : Infinity;
    if (elapsed <= STALE_THRESHOLD_MS) return; // recent-enough success, or just one blip -- leave as-is

    var lastLabel = last ? new Date(last).toLocaleTimeString() : "never";
    var selector =
      '[data-live-symbol="' + cssAttrEscape(symbol) + '"][data-live-market="' + cssAttrEscape(market) + '"]';
    document.querySelectorAll(selector).forEach(function (el) {
      var field = el.getAttribute("data-live-field");
      if (field === "dot") {
        el.classList.remove("live-ok");
        el.classList.add("live-stale");
        el.title = "Stale \u2014 last updated " + lastLabel;
      } else {
        // Price/change text keeps its confident live styling otherwise --
        // mark it too, not just the tiny dot, so staleness is actually
        // noticeable and isn't communicated by color/a 6px target alone.
        el.classList.add("stale");
        el.setAttribute("aria-label", "Stale price \u2014 last updated " + lastLabel);
      }
    });
  }

  function pollAll() {
    var seen = {};
    document.querySelectorAll("[data-live-symbol][data-live-market]").forEach(function (el) {
      var symbol = el.getAttribute("data-live-symbol");
      var market = el.getAttribute("data-live-market");
      var key = market + ":" + symbol;
      if (seen[key]) return;
      seen[key] = true;

      // Clock-driven staleness check: evaluate this on every poll tick,
      // before the fetch below is even issued, rather than only from
      // inside .then/.catch. A hung request (dead/blackholed connection,
      // not a clean rejection) never resolves or rejects, so relying
      // solely on fetch settling would let a stale tile sit showing "live"
      // indefinitely. Safe for a healthy tile -- the threshold only trips
      // after no success for 2.5x the poll interval -- and honest on first
      // load, where it briefly shows the "never loaded" state.
      markStaleIfDue(symbol, market);

      var url = LIVE_PRICE_API + "/price?symbol=" + encodeURIComponent(symbol) + "&market=" + encodeURIComponent(market);
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
      fetch(url, { signal: controller.signal })
        .then(function (r) {
          if (!r.ok) throw new Error("bad response");
          return r.json();
        })
        .then(function (data) {
          if (isCompleteQuote(data)) {
            lastSuccessAt[key] = Date.now();
            applyQuote(symbol, market, data);
          } else {
            // Incomplete quote -- don't partially apply it. Treated the same
            // as a fetch failure below.
            markStaleIfDue(symbol, market);
          }
        })
        .catch(function () {
          // Best-effort by design -- see file header. A single failure just
          // leaves the last good value on screen; markStaleIfDue only flips
          // the dot once we've gone long enough without a successful update.
          // Covers both a clean rejection and (via the abort above) a
          // request that would otherwise have hung forever.
          markStaleIfDue(symbol, market);
        })
        .finally(function () {
          clearTimeout(timeoutId);
        });
    });
  }

  if (document.querySelector("[data-live-symbol]")) {
    pollAll();
    setInterval(pollAll, POLL_INTERVAL_MS);
  }
})();
