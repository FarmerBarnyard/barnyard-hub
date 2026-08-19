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
      } else if (field === "status") {
        // Clear the sr-only staleness announcement -- see applyStaleVisuals.
        el.textContent = "";
      }
      // A successful, complete update always clears any stale marker left
      // on this element by markStaleIfDue/applyStaleVisuals, regardless of
      // field type.
      if (field !== "dot") {
        el.classList.remove("stale");
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

  // Shared by both staleness checks below -- applies the actual stale
  // visuals/DOM changes to every element for this symbol+market once
  // staleness has already been decided by the caller.
  //
  // Exactly one accessible announcement of staleness: the dot's title
  // (not part of the tile's accessible name -- title isn't included in
  // name computation the way aria-label is) plus a single sr-only
  // ".tile-status" text node inside .tile-stat. Deliberately NOT an
  // aria-label on the price/change spans -- an aria-label on a descendant
  // of the tile <a> replaces that descendant's own text in the tile's
  // computed accessible name, which silently deleted the actual price and
  // change numbers from what a screen reader announces (regression fixed
  // in this round). Visual "stale" styling on price/change stays.
  function applyStaleVisuals(symbol, market, lastLabel) {
    var selector =
      '[data-live-symbol="' + cssAttrEscape(symbol) + '"][data-live-market="' + cssAttrEscape(market) + '"]';
    document.querySelectorAll(selector).forEach(function (el) {
      var field = el.getAttribute("data-live-field");
      if (field === "dot") {
        el.classList.remove("live-ok");
        el.classList.add("live-stale");
        el.title = "Stale \u2014 last updated " + lastLabel;
      } else if (field === "status") {
        el.textContent = "stale, last updated " + lastLabel;
      } else {
        // Price/change text keeps its confident live styling otherwise --
        // mark it too, not just the tiny dot, so staleness is actually
        // noticeable and isn't communicated by color/a 6px target alone.
        // No aria-label here -- see comment above.
        el.classList.add("stale");
      }
    });
  }

  // Network-level ("we haven't gotten ANY response in a while") check --
  // clock-driven, evaluated from lastSuccessAt regardless of what any
  // individual response contained. Catches hung/blackholed requests, which
  // never resolve or reject and so have no response for the asOf-based
  // check below to look at.
  function markStaleIfDue(symbol, market) {
    var key = market + ":" + symbol;
    var last = lastSuccessAt[key];
    var elapsed = last ? Date.now() - last : Infinity;
    if (elapsed <= STALE_THRESHOLD_MS) return; // recent-enough success, or just one blip -- leave as-is

    var lastLabel = last ? new Date(last).toLocaleTimeString() : "never";
    applyStaleVisuals(symbol, market, lastLabel);
  }

  // Data-level ("the response arrived, but the price inside it is old")
  // check -- reads the Worker's own asOf timestamp (when it actually
  // queried Finnhub/Yahoo) instead of inferring freshness from our fetch
  // succeeding. A successful HTTP round-trip only proves the Worker
  // responded, not that what it served is current -- today the Worker
  // fails closed (502) under rate limiting rather than ever serving stale
  // data on a 200, but nothing here should depend on that staying true.
  // Falls back to leaving the fetch-clock result (from markStaleIfDue) in
  // place when asOf is missing or unparseable.
  function parseAsOf(data) {
    if (!data || typeof data.asOf !== "string") return null;
    var t = Date.parse(data.asOf);
    return Number.isFinite(t) ? t : null;
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
            // A response arrived and parsed cleanly -- that satisfies the
            // network-level ("got a response at all") check regardless of
            // how old the data inside it turns out to be.
            lastSuccessAt[key] = Date.now();
            var asOfTime = parseAsOf(data);
            if (asOfTime !== null && Date.now() - asOfTime > STALE_THRESHOLD_MS) {
              // Response succeeded, but the Worker's own timestamp says the
              // quote it served is already old (e.g. a cached/stale
              // response) -- don't apply it as if it were live.
              applyStaleVisuals(symbol, market, new Date(asOfTime).toLocaleTimeString());
            } else {
              applyQuote(symbol, market, data);
            }
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
