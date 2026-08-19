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
  // Invariant: FETCH_TIMEOUT_MS must stay below POLL_INTERVAL_MS. Otherwise
  // a slow-but-alive request could still be in flight when the next poll
  // tick fires, and (worse) markStaleIfDue's clock-driven check -- which
  // runs every tick regardless of any in-flight fetch -- would be racing
  // against a timeout that hasn't even had a chance to fire yet.
  var POLL_INTERVAL_MS = 15000;
  // A few consecutive failed/incomplete polls shouldn't immediately flip a
  // tile to "stale" (could just be one blip) -- only do so once this much
  // time has passed since the last successful update.
  var STALE_THRESHOLD_MS = POLL_INTERVAL_MS * 2.5;
  // A hung/blackholed request never resolves or rejects on its own -- cap
  // how long we'll wait before aborting it so it eventually lands in the
  // .catch below instead of accumulating forever. See the POLL_INTERVAL_MS
  // comment above for the invariant this must respect.
  var FETCH_TIMEOUT_MS = 10000;
  // key ("MARKET:SYMBOL") -> timestamp (ms) of last successful, fully-valid update.
  var lastSuccessAt = {};
  // key ("MARKET:SYMBOL") -> true once applyQuote has ever actually painted
  // a quote for this key. Lets applyStaleVisuals tell "never loaded" apart
  // from "loaded once, now stale" without needing a timestamp write of its
  // own -- see the comment on the asof branch in applyStaleVisuals below.
  var hasAppliedQuote = {};

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
  // Short "as of HH:MM" freshness label for the tile's asof field -- no
  // seconds, unlike the dot's title/lastLabel strings below, since this one
  // is always-visible tile copy rather than a one-off tooltip/announcement.
  // Locale is pinned to "en-US" (rather than the runner's default) so this
  // format is deterministic both for users and for
  // test/live-prices.test.js, which pins an exact expected string against
  // it.
  function fmtAsOfLabel(ms) {
    return "as of " + new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  function cssAttrEscape(value) {
    return value.replace(/["\\]/g, "\\$&");
  }

  function applyQuote(symbol, market, quote) {
    // applyQuote is the only function that ever writes the asof label's
    // text (see the field === "asof" branch below) -- it's the only place
    // that knows which quote is actually on screen. Recording that here
    // lets applyStaleVisuals distinguish "never loaded" from "loaded once,
    // now stale" without duplicating that knowledge via its own timestamp.
    hasAppliedQuote[market + ":" + symbol] = true;
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
      } else if (field === "asof") {
        // Prefer the Worker's own asOf timestamp (when it actually queried
        // the upstream data source) over "now" (when we happened to receive
        // the response) -- same reasoning as the data-level staleness check
        // in pollAll below. Falls back to "now" only if asOf is missing or
        // unparseable, so the label is never left blank on a good quote.
        var asOfTime = parseAsOf(quote);
        el.textContent = fmtAsOfLabel(asOfTime !== null ? asOfTime : Date.now());
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

  // Pure decision function shared by both staleness checks below (the
  // network-clock-driven markStaleIfDue, and the asOf-driven check in
  // pollAll's .then) -- given how long it's been since some reference
  // timestamp, decide whether that counts as stale. `last` may be
  // null/undefined ("nothing has ever succeeded yet"), which correctly
  // reads as infinitely stale rather than as "just happened". Kept free of
  // any DOM access so it's directly unit-testable -- see
  // test/live-prices.test.js.
  function isStaleSince(last, now) {
    var elapsed = last != null ? now - last : Infinity;
    return elapsed > STALE_THRESHOLD_MS;
  }

  // Shared by both staleness checks below -- applies the actual stale
  // visuals/DOM changes to every element for this symbol+market once
  // staleness has already been decided by the caller. `lastTimestamp` is
  // the ms epoch time of the last known-good data point (last successful
  // fetch for the network-level check, or the Worker's own asOf for the
  // data-level check below) -- null/undefined means nothing has ever
  // loaded successfully.
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
  function applyStaleVisuals(symbol, market, lastTimestamp) {
    var key = market + ":" + symbol;
    var everLoaded = !!hasAppliedQuote[key];
    var lastLabel = lastTimestamp != null ? new Date(lastTimestamp).toLocaleTimeString() : "never";
    var selector =
      '[data-live-symbol="' + cssAttrEscape(symbol) + '"][data-live-market="' + cssAttrEscape(market) + '"]';
    document.querySelectorAll(selector).forEach(function (el) {
      var field = el.getAttribute("data-live-field");
      if (field === "dot") {
        el.classList.remove("live-ok");
        el.classList.add("live-stale");
        el.title = "Stale \u2014 last updated " + lastLabel;
      } else if (field === "status") {
        // Doesn't just restate the visible "as of HH:MM" label's own
        // moment in a second, differently-formatted way -- lastTimestamp
        // here is whichever clock this particular staleness check is
        // driven by (last successful response for the network-level check,
        // or the response's own asOf for the data-level check), which is
        // often genuinely different from whatever quote is still frozen on
        // screen. See the asof branch below for why the visible label
        // itself is never rewritten here.
        el.textContent = "stale \u2014 no update since " + lastLabel;
      } else if (field === "asof") {
        // Deliberately does NOT rewrite this label's text on the common
        // path. applyQuote is the only function that knows which quote is
        // actually on screen (see its own comment), so it's the only
        // function allowed to write this text -- if we wrote lastTimestamp
        // here instead, a stale-but-parsed poll followed by a fully dead
        // connection could advance this label to a timestamp newer than
        // the price/change actually displayed, claiming freshness the
        // frozen data doesn't have. Leaving it untouched means it keeps
        // describing whatever quote applyQuote last actually painted,
        // which is exactly correct. The one exception: a tile that has
        // never once received a real quote has no prior text for us to
        // leave alone, so it still needs an explicit placeholder.
        if (!everLoaded) {
          el.textContent = "as of \u2014";
        }
        el.classList.add("stale");
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
    if (!isStaleSince(last, Date.now())) return; // recent-enough success, or just one blip -- leave as-is

    applyStaleVisuals(symbol, market, last);
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

  // Pure routing decision for a raw response body pollAll's fetch .then
  // receives, given the current time -- decides whether the poll cycle
  // should paint the quote (action: "apply"), treat it as data-level stale
  // (action: "stale", with the timestamp that made it so), or treat it as
  // incomplete/unusable (action: "incomplete", handled the same as a
  // network failure by the caller). Extracted out of pollAll so the actual
  // routing logic is itself directly testable rather than only reachable
  // by exercising isCompleteQuote/parseAsOf/isStaleSince in isolation and
  // hoping pollAll wires them together the same way -- see
  // test/live-prices.test.js.
  function decideQuoteAction(data, now) {
    if (!isCompleteQuote(data)) return { action: "incomplete" };
    var asOfTime = parseAsOf(data);
    if (asOfTime !== null && isStaleSince(asOfTime, now)) {
      return { action: "stale", timestamp: asOfTime };
    }
    return { action: "apply" };
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
          var decision = decideQuoteAction(data, Date.now());
          if (decision.action === "incomplete") {
            // Incomplete quote -- don't partially apply it. Treated the same
            // as a fetch failure below.
            markStaleIfDue(symbol, market);
            return;
          }
          // A response arrived and parsed cleanly -- that satisfies the
          // network-level ("got a response at all") check regardless of
          // how old the data inside it turns out to be, so both remaining
          // branches record it.
          lastSuccessAt[key] = Date.now();
          if (decision.action === "stale") {
            // Response succeeded, but the Worker's own timestamp says the
            // quote it served is already old (e.g. a cached/stale
            // response) -- don't apply it as if it were live.
            applyStaleVisuals(symbol, market, decision.timestamp);
          } else {
            applyQuote(symbol, market, data);
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

  // Guarded on `document` existing (rather than assuming a browser) so this
  // file can be `require()`d as-is by the Node-based test file below
  // without needing a DOM/jsdom stand-in -- always true in the browser,
  // never true under plain Node.
  if (typeof document !== "undefined" && document.querySelector("[data-live-symbol]")) {
    pollAll();
    setInterval(pollAll, POLL_INTERVAL_MS);
  }

  // Expose pure, DOM-free helpers to the Node-based test file at
  // test/live-prices.test.js -- this repo has no build step, so the test
  // just requires this file directly rather than importing from a compiled
  // module. A no-op in the browser: `module` is undefined there, so this
  // branch never runs outside Node.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      isCompleteQuote: isCompleteQuote,
      parseAsOf: parseAsOf,
      isStaleSince: isStaleSince,
      decideQuoteAction: decideQuoteAction,
      fmtAsOfLabel: fmtAsOfLabel,
      POLL_INTERVAL_MS: POLL_INTERVAL_MS,
      STALE_THRESHOLD_MS: STALE_THRESHOLD_MS,
      FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS
    };
  }
})();
