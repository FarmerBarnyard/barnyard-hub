// Two self-contained "at a glance" widgets shown between the header and the
// project tiles: current weather (via the browser's Geolocation API plus
// Open-Meteo's free, keyless forecast API) and a week-view calendar built
// from the visitor's local clock and enhanced with real events fetched from
// api.barnyard.site/calendar (a same-account Cloudflare Worker gated by
// Cloudflare Access -- see the "Calendar events" section below).
//
// Neither widget talks to any third-party tracking service, but the
// calendar widget IS a network call, gated by a same-account Cloudflare
// Access login (see the "Calendar events" section below) -- and, unlike
// weather, which only fires once the visitor explicitly clicks "Show
// weather near me", it fires unconditionally on every page load and again
// on every tab focus. That means a flat "no accounts" claim in the footer
// would no longer be literally true; index.html's footer text now reads
// "no account needed to browse" instead, which stays accurate: browsing
// the page itself needs no account, even though the calendar widget's data
// is gated behind the account owner's own Cloudflare Access login.
// (Whether this fetch should instead be gated behind an explicit user
// action, like weather's click-to-share-location gate, is an open decision
// -- see this branch's review notes -- not settled by this comment.)
//
// Both are best-effort: any failure (denied permission, network hiccup,
// unexpected response shape) renders an honest status message in the tile
// instead of guessing or leaving it blank. Nothing here can break the rest
// of the page.
(function () {
  "use strict";

  // Mon-first day abbreviations. Originally only used by the week calendar
  // widget below (built from the visitor's own Mon-Sun grid), but the
  // weather widget's forecast strip now reuses the exact same array and the
  // exact same Date#getDay() -> Mon-first index conversion (see
  // parseDailyForecast) for consistency between the two widgets rather than
  // reinventing a slightly different day-name lookup.
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // ---- Weather ------------------------------------------------------------

  var WEATHER_API = "https://api.open-meteo.com/v1/forecast";
  var FETCH_TIMEOUT_MS = 10000;
  // How long a loaded reading is trusted before a returning visit (tab
  // becoming visible again) triggers a quiet background refresh.
  var WEATHER_REFRESH_MS = 15 * 60 * 1000;

  // WMO weather codes -> [label, emoji]. Covers the common buckets rather
  // than every documented code; anything unmapped falls back to a generic
  // label so the widget never renders blank for an odd code.
  var WEATHER_CODES = {
    0: ["Clear", "☀️"],
    1: ["Mostly clear", "🌤️"],
    2: ["Partly cloudy", "⛅"],
    3: ["Overcast", "☁️"],
    45: ["Fog", "🌫️"],
    48: ["Fog", "🌫️"],
    51: ["Light drizzle", "🌦️"],
    53: ["Drizzle", "🌦️"],
    55: ["Heavy drizzle", "🌦️"],
    56: ["Freezing drizzle", "🌨️"],
    57: ["Freezing drizzle", "🌨️"],
    61: ["Light rain", "🌧️"],
    63: ["Rain", "🌧️"],
    65: ["Heavy rain", "🌧️"],
    66: ["Freezing rain", "🌨️"],
    67: ["Freezing rain", "🌨️"],
    71: ["Light snow", "🌨️"],
    73: ["Snow", "❄️"],
    75: ["Heavy snow", "❄️"],
    77: ["Snow grains", "❄️"],
    80: ["Light showers", "🌦️"],
    81: ["Showers", "🌦️"],
    82: ["Heavy showers", "⛈️"],
    85: ["Snow showers", "🌨️"],
    86: ["Snow showers", "🌨️"],
    95: ["Thunderstorm", "⛈️"],
    96: ["Thunderstorm, hail", "⛈️"],
    99: ["Thunderstorm, hail", "⛈️"]
  };

  function describeWeatherCode(code) {
    return WEATHER_CODES[code] || ["Unknown conditions", "🌡️"];
  }

  // Turns Open-Meteo's `daily` block (four parallel arrays: time,
  // weather_code, temperature_2m_max, temperature_2m_min -- index 0 =
  // today, per timezone=auto in the request URL) into a clean array of
  // { date, dayLabel, tempMax, tempMin, code } objects, or null if the
  // block is missing or malformed in any way.
  //
  // Deliberately paranoid, mirroring loadWeather's own validation of
  // `current`: a forecast response is never trusted blindly. Any single
  // problem -- the block missing entirely, the four arrays not all being
  // arrays, a length mismatch between them, an empty array, an unparseable
  // date string, or a non-finite temperature/code anywhere in any of them
  // -- fails the whole parse (returns null) rather than rendering a
  // partial/corrupt strip. The caller (loadWeather) treats null as "no
  // forecast" and still renders the current-conditions block on its own --
  // a malformed daily block must never take down an otherwise-good current
  // reading.
  //
  // Each date string ("YYYY-MM-DD") is parsed into its year/month/day parts
  // and fed to `new Date(y, m - 1, d)` -- a LOCAL-components constructor --
  // rather than `new Date("YYYY-MM-DD")`, which JS parses as UTC midnight
  // and can land on the wrong weekday once converted to a negative-UTC-
  // offset visitor's local getDay(). Since timezone=auto already makes
  // Open-Meteo bucket these dates by the requested lat/lon's own local
  // timezone, treating the string's y/m/d as local wall-clock components
  // (rather than round-tripping through UTC) is what keeps the weekday
  // label correct.
  function parseDailyForecast(daily) {
    if (!daily) return null;
    var time = daily.time;
    var code = daily.weather_code;
    var max = daily.temperature_2m_max;
    var min = daily.temperature_2m_min;
    if (!Array.isArray(time) || !Array.isArray(code) || !Array.isArray(max) || !Array.isArray(min)) {
      return null;
    }
    var len = time.length;
    if (len === 0 || code.length !== len || max.length !== len || min.length !== len) {
      return null;
    }

    var days = [];
    for (var i = 0; i < len; i++) {
      var dateStr = time[i];
      if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
      var parts = dateStr.split("-");
      var y = Number(parts[0]);
      var m = Number(parts[1]);
      var d = Number(parts[2]);
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
      if (!Number.isFinite(code[i]) || !Number.isFinite(max[i]) || !Number.isFinite(min[i])) return null;

      // Date#getDay(): 0=Sun..6=Sat -- same Mon-first shift renderWeek uses
      // to index into DAY_NAMES, reused as-is for consistency.
      var dateObj = new Date(y, m - 1, d);
      var dayIndex = (dateObj.getDay() + 6) % 7;
      // "Today" for the first entry rather than its weekday abbreviation --
      // matches how a visitor actually reads a forecast strip (the calendar
      // widget's own "This week" grid keeps the plain weekday abbreviation
      // for today, picking it out with color/a sr-only suffix instead; the
      // forecast strip's very first cell is unambiguous enough that a literal
      // "Today" label reads better here).
      var dayLabel = i === 0 ? "Today" : DAY_NAMES[dayIndex];

      days.push({
        date: dateStr,
        dayLabel: dayLabel,
        tempMax: max[i],
        tempMin: min[i],
        code: code[i]
      });
    }
    return days;
  }

  // Resolves with the already-parsed JSON body. The timeout is only cleared
  // once the body has actually finished parsing (not as soon as fetch()
  // resolves, which just means headers arrived) -- otherwise a stalled body
  // read is left with no timeout protection at all.
  function fetchJsonWithTimeout(url) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal, referrerPolicy: "no-referrer" })
      .then(function (r) {
        if (!r.ok) throw new Error("bad response");
        return r.json();
      })
      .finally(function () {
        clearTimeout(timeoutId);
      });
  }

  function weatherBody() {
    return document.getElementById("weather-body");
  }

  function formatAsOf(date) {
    var h = String(date.getHours());
    var m = String(date.getMinutes());
    if (h.length < 2) h = "0" + h;
    if (m.length < 2) m = "0" + m;
    return h + ":" + m;
  }

  function makeLocateButton(label, handler) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "weather-locate-btn";
    btn.textContent = label;
    btn.addEventListener("click", function () {
      handler();
    });
    return btn;
  }

  function renderLocatePrompt() {
    var body = weatherBody();
    if (!body) return;
    body.innerHTML = "";
    body.appendChild(
      makeLocateButton("Show weather near me", function () {
        requestWeather({ silent: false });
      })
    );
  }

  // `retry` adds a button so a failure state is never a dead end -- without
  // it the only way to try again after an error would be reloading the page.
  function renderWeatherStatus(message, retry) {
    var body = weatherBody();
    if (!body) return;
    body.innerHTML = "";
    var p = document.createElement("p");
    p.className = "weather-status";
    p.textContent = message;
    body.appendChild(p);
    if (retry) {
      body.appendChild(
        makeLocateButton("Try again", function () {
          requestWeather({ silent: false });
        })
      );
    }
  }

  // `days` is either the array parseDailyForecast returned, or null/
  // undefined -- rendered only when it's a real, non-empty array (see
  // renderWeather), so a malformed/missing daily block just leaves the
  // widget at the current-conditions block alone, no empty strip below it.
  function renderForecast(days) {
    var body = weatherBody();
    if (!body || !Array.isArray(days) || !days.length) return;

    var strip = document.createElement("ul");
    strip.className = "weather-forecast";
    strip.setAttribute("role", "list");

    days.forEach(function (day) {
      var info = describeWeatherCode(day.code);
      var condLabel = info[0];
      var icon = info[1];
      var tempMaxR = Math.round(day.tempMax);
      var tempMinR = Math.round(day.tempMin);

      var li = document.createElement("li");
      li.className = "weather-forecast-day";
      // The visible cell is three separate aria-hidden fragments (day
      // label, icon, high/low) -- on their own, the two temperature figures
      // don't say which is the high and which is the low (that's only
      // conveyed visually, by order/position), so a single well-formed
      // aria-label on the cell itself carries the full, unambiguous summary
      // to assistive tech instead of three fragments read out of context.
      li.setAttribute(
        "aria-label",
        day.dayLabel + ", " + condLabel + ", high " + tempMaxR + "°, low " + tempMinR + "°"
      );

      var nameEl = document.createElement("span");
      nameEl.className = "weather-forecast-day-name";
      nameEl.setAttribute("aria-hidden", "true");
      nameEl.textContent = day.dayLabel;

      var iconEl = document.createElement("span");
      iconEl.className = "weather-forecast-icon";
      iconEl.setAttribute("aria-hidden", "true");
      iconEl.textContent = icon;

      // High/low stacked as two short lines ("18°" over "9°") rather than
      // one "18° / 9°" line -- a single-line pair doesn't actually fit the
      // ~38px cell width the strip is left with at narrow mobile viewports
      // (7 cells in a widget that's no longer 616px wide there), where
      // nowrap would just overflow the cell instead of wrapping cleanly.
      // Stacking also gives high/low a distinct color/weight treatment
      // (bright+bold vs dim), reinforcing which figure is which beyond
      // position alone -- the same ambiguity the cell's aria-label exists
      // to resolve for assistive tech.
      var tempsEl = document.createElement("span");
      tempsEl.className = "weather-forecast-temps";
      tempsEl.setAttribute("aria-hidden", "true");

      var highEl = document.createElement("span");
      highEl.className = "weather-forecast-high";
      highEl.textContent = tempMaxR + "°";

      var lowEl = document.createElement("span");
      lowEl.className = "weather-forecast-low";
      lowEl.textContent = tempMinR + "°";

      tempsEl.appendChild(highEl);
      tempsEl.appendChild(lowEl);

      li.appendChild(nameEl);
      li.appendChild(iconEl);
      li.appendChild(tempsEl);
      strip.appendChild(li);
    });

    body.appendChild(strip);
  }

  function renderWeather(tempC, code, asOfDate, forecastDays) {
    var body = weatherBody();
    if (!body) return;
    var info = describeWeatherCode(code);
    var label = info[0];
    var icon = info[1];
    body.innerHTML = "";

    var main = document.createElement("div");
    main.className = "weather-main";

    var iconEl = document.createElement("span");
    iconEl.className = "weather-icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.textContent = icon;

    var tempEl = document.createElement("span");
    tempEl.className = "weather-temp";
    tempEl.textContent = Math.round(tempC) + "°C";

    var condEl = document.createElement("span");
    condEl.className = "weather-cond";
    // Text label pairs with the icon so the condition is conveyed to screen
    // readers too, not just via the (aria-hidden) emoji.
    condEl.textContent = label;

    main.appendChild(iconEl);
    main.appendChild(tempEl);
    main.appendChild(condEl);
    body.appendChild(main);

    var asOfEl = document.createElement("p");
    asOfEl.className = "weather-asof";
    asOfEl.textContent = "as of " + formatAsOf(asOfDate);
    body.appendChild(asOfEl);

    // Best-effort: a missing/malformed daily block (see parseDailyForecast)
    // just means no forecast strip renders -- the current-conditions block
    // above is still good and stands on its own.
    renderForecast(forecastDays);
  }

  // Timestamp (ms) of the last successful load, so a returning visit
  // (visibilitychange) knows whether the reading on screen is stale enough
  // to be worth quietly refreshing. Also null until the visitor has
  // actually opted in once -- a background refresh should never be the
  // first thing that prompts for permission.
  var lastWeatherLoadAt = null;

  function loadWeather(lat, lon, silent) {
    // Round to ~2 decimal places (~1.1km grid) before it ever leaves the
    // browser -- same forecast accuracy Open-Meteo can use, less precise
    // disclosure of exactly where the visitor is.
    var roundedLat = Math.round(lat * 100) / 100;
    var roundedLon = Math.round(lon * 100) / 100;
    var url =
      WEATHER_API +
      "?latitude=" + encodeURIComponent(roundedLat) +
      "&longitude=" + encodeURIComponent(roundedLon) +
      "&current=temperature_2m,weather_code&temperature_unit=celsius" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7";
    fetchJsonWithTimeout(url)
      .then(function (data) {
        var current = data && data.current;
        if (
          !current ||
          !Number.isFinite(current.temperature_2m) ||
          !Number.isFinite(current.weather_code)
        ) {
          throw new Error("incomplete weather data");
        }
        // A malformed/missing daily block degrades gracefully -- parsed to
        // null, which renderWeather/renderForecast treat as "no forecast
        // strip", NOT as a reason to fail the whole current-conditions
        // render (see parseDailyForecast's own comment).
        var forecastDays = parseDailyForecast(data && data.daily);
        var now = new Date();
        lastWeatherLoadAt = now.getTime();
        renderWeather(current.temperature_2m, current.weather_code, now, forecastDays);
      })
      .catch(function () {
        // A silent background refresh failing shouldn't blow away an
        // already-good reading still on screen -- only show the error
        // state for an explicit, foreground request.
        if (!silent) renderWeatherStatus("Weather unavailable right now", true);
      });
  }

  // GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 =
  // POSITION_UNAVAILABLE, 3 = TIMEOUT. Only code 1 means location access is
  // actually disabled -- 2 and 3 can both happen with location enabled, so
  // showing "enable location" for those would be actively misleading.
  function geoErrorMessage(err) {
    if (err && err.code === 1) return "Enable location for weather";
    return "Couldn't get your location";
  }

  function requestWeather(opts) {
    var silent = !!(opts && opts.silent);
    if (!("geolocation" in navigator)) {
      if (!silent) renderWeatherStatus("Location isn't available in this browser", false);
      return;
    }
    if (!silent) renderWeatherStatus("Checking location…", false);
    navigator.geolocation.getCurrentPosition(
      function (position) {
        loadWeather(position.coords.latitude, position.coords.longitude, silent);
      },
      function (err) {
        // A failed silent background refresh just leaves the last good
        // reading in place rather than replacing it with an error.
        if (!silent) renderWeatherStatus(geoErrorMessage(err), true);
      },
      {
        timeout: FETCH_TIMEOUT_MS,
        // Silent (background) refreshes are allowed to reuse a recent
        // on-device fix instead of forcing a fresh GPS read -- cheaper, and
        // avoids anything that could look like a re-prompt.
        maximumAge: silent ? WEATHER_REFRESH_MS : 0
      }
    );
  }

  function initWeather() {
    if (!weatherBody()) return;
    renderLocatePrompt();

    document.addEventListener("visibilitychange", function () {
      if (
        document.visibilityState === "visible" &&
        lastWeatherLoadAt !== null &&
        Date.now() - lastWeatherLoadAt > WEATHER_REFRESH_MS
      ) {
        requestWeather({ silent: true });
      }
    });
  }

  // ---- Week calendar --------------------------------------------------------
  //
  // The Mon-Sun day grid itself is purely local (built from new Date(), no
  // network call, no calendar-account connection). The per-day event data
  // layered on top of that grid is NOT local -- see the "Calendar events"
  // section immediately below, which fetches from api.barnyard.site.
  //
  // (DAY_NAMES itself is declared up in the Weather section above -- it's
  // shared between both widgets now that the weather forecast strip uses it
  // too.)

  var MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  // ---- Calendar events (Worker-backed, Access-gated) -----------------------
  //
  // Enhances the local day grid above with real events fetched from
  // api.barnyard.site/calendar (see cloudflare-worker/src/index.js in the
  // ClaudeRepo checkout for the exact response shape -- roughly
  // { title, allDay, date, start, end, recurring }[]). Unlike the weather
  // widget's click-to-share-location gate, this fetch fires unconditionally
  // on page load and on every tab focus -- see the file header comment.
  // This route is same-account-only and gated by Cloudflare Access (a
  // cookie-based login on the api.barnyard.site hostname) -- an
  // unauthenticated visitor's request gets redirected to an Access login
  // page (or otherwise fails/returns something that isn't our JSON).
  //
  // Many different failure modes (offline, DNS, a timeout, a CORS
  // rejection, a 5xx, an unauthenticated redirect, an unexpected body
  // shape) all collapse to the same "couldn't check" state below --
  // deliberately worded cause-neutral ("Couldn't load your events") rather
  // than asserting any one specific cause, with a "Try again" retry button
  // (mirroring the weather widget's own retry pattern -- see
  // makeLocateButton/renderWeatherStatus above) so it's never a dead end.
  // A foreground fetch (initial load or a "Try again" click) also renders
  // an immediate "Checking…" status before the fetch itself starts, same
  // as requestWeather's synchronous "Checking location…" -- otherwise a
  // click gives no feedback until the fetch resolves (up to
  // CALENDAR_FETCH_TIMEOUT_MS later), and a retry that fails again would
  // render byte-identical output to before the click.
  //
  // A *silent* background refresh that fails after a good array is already
  // on screen does NOT downgrade to "error" (that would blow away good
  // data over a blip) -- but it does set calendarRefreshFailed, so the
  // events on screen are flagged as possibly stale rather than presented
  // as a freshly-confirmed week. Without this, a session that quietly
  // expires (e.g. the Cloudflare Access cookie lapsing overnight) would
  // leave every later refresh failing forever with no visible sign of it,
  // eventually rendering what looks like a genuinely empty, successfully-
  // checked week once the retained events age out of the displayed range.
  //
  // The Worker deliberately does NOT expand recurring events (RRULE) into
  // their individual occurrences -- a recurring event only ever appears on
  // its literal original creation date, which is almost always outside the
  // displayed week (see buildCalendarEvents' own comment in the Worker).
  // renderCalendarStatus below always renders a "repeating events only
  // show on their first date" caveat on a successful fetch so a week
  // that's actually full of (unshown-here) recurring events doesn't read
  // as a false "nothing's scheduled" -- and any individual event the
  // Worker flags `recurring: true` gets that noted in its tooltip text
  // too.

  var CALENDAR_API = "https://api.barnyard.site/calendar";
  var CALENDAR_FETCH_TIMEOUT_MS = 10000;

  // null = not yet resolved (first fetch still in flight, or not attempted
  // yet -- renders as a plain grid with no status line, same as before this
  // feature existed). Array = successful, authenticated fetch; this week's
  // events (an empty array is a normal, valid state -- "no events", not an
  // error). "error" = the fetch failed, was redirected, or didn't return
  // parseable JSON -- kept distinct from an empty array specifically so the
  // grid never claims "no events" when the real state is "couldn't check".
  var calendarEvents = null;

  // True when calendarEvents holds a good array, but the most recent fetch
  // attempt against it actually failed (a silent background refresh that
  // preserved the existing data rather than clobbering it -- see the
  // fetch's own catch handler below). Cleared back to false on any
  // successful load. Lets renderCalendarStatus tell "confirmed fresh as of
  // this fetch" apart from "possibly stale, last confirmed earlier" --
  // without this flag the two are indistinguishable once the failing
  // refreshes start (see F1 review note / the section header comment
  // above).
  var calendarRefreshFailed = false;

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Local "YYYY-MM-DD" for a given Date -- used both to build the day grid
  // itself and, via eventLocalDate below, to place each event in the
  // correct local day column.
  function localDateStr(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  // Derives an event's LOCAL calendar date -- the date it should appear
  // under in the visitor's own day grid -- from the event's own `start`
  // field, NOT the Worker's `date` field. `date` is the UTC date of a timed
  // event's absolute instant, which only matches the visitor's local date
  // for visitors in/near UTC -- for anyone else, matching against it
  // silently shifts every timed event onto the wrong day (a morning meeting
  // one day early for a positive-UTC-offset visitor, an evening one one day
  // late for a negative-UTC-offset visitor). See this branch's review notes
  // (finding 1) and test/glance-widgets.test.js for the exact scenarios.
  //
  //   - allDay events: `date` is a literal calendar date with no time
  //     component to convert -- already correct as-is.
  //   - timed events with a "Z"-suffixed `start` (an absolute instant --
  //     either an originally-UTC DTSTART, or a TZID-qualified one the
  //     Worker has already resolved to UTC): convert to the visitor's own
  //     local date via `new Date(...)` + localDateStr, i.e. the browser's
  //     own local-timezone getters.
  //   - timed events with a floating (no "Z") `start` (an unrecognized
  //     TZID the Worker couldn't resolve, per its own comment): the
  //     wall-clock digits it emits are already local by construction --
  //     take the date portion as-is.
  function eventLocalDate(ev) {
    if (!ev) return null;
    if (ev.allDay) return ev.date;
    if (typeof ev.start !== "string") return null;
    if (ev.start.slice(-1) === "Z") {
      var t = new Date(ev.start);
      return isNaN(t.getTime()) ? null : localDateStr(t);
    }
    return ev.start.slice(0, 10);
  }

  function weekStatusEl() {
    return document.getElementById("week-status");
  }

  // Same "never a dead end" pattern as the weather widget's
  // makeLocateButton/renderWeatherStatus above -- a status message alone,
  // with nothing to click, leaves a failed fetch with no way forward short
  // of reloading the whole page.
  function makeCalendarRetryButton(label, handler) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "week-retry-btn";
    btn.textContent = label;
    btn.addEventListener("click", function () {
      handler();
    });
    return btn;
  }

  // Rendered synchronously the moment a foreground fetch (initial load or
  // a "Try again" click) actually starts, before the fetch call itself --
  // see fetchCalendarEvents. Deliberately renders no button: while this is
  // on screen a fetch is genuinely in flight, so there's nothing useful a
  // second click could do, and the absence of a button is itself the
  // "your click registered, please wait" signal (see F2 review note).
  function renderCalendarPending() {
    var el = weekStatusEl();
    if (!el) return;
    el.innerHTML = "";
    el.textContent = "Checking…";
  }

  function renderCalendarStatus() {
    var el = weekStatusEl();
    if (!el) return;
    el.innerHTML = "";
    if (calendarEvents === "error") {
      // Cause-neutral wording -- this single state covers offline, DNS
      // failure, a timeout, a CORS rejection, a 5xx, an unauthenticated
      // Access redirect, and an unexpected response shape, so it must not
      // assert any one of those specific causes. See the section header
      // comment above.
      var msg = document.createElement("span");
      msg.className = "week-status-text";
      msg.textContent = "Couldn't load your events. ";
      el.appendChild(msg);
      el.appendChild(
        makeCalendarRetryButton("Try again", function () {
          fetchCalendarEvents();
        })
      );
    } else if (Array.isArray(calendarEvents)) {
      if (calendarRefreshFailed) {
        // A background refresh against this already-loaded array has since
        // failed (e.g. an expired Cloudflare Access session) -- say so
        // explicitly, with the time of the last successful load, rather
        // than silently presenting a possibly-stale week as freshly
        // confirmed. Offers the same retry affordance as the pure-error
        // state above (see F1 review note / the section header comment).
        var staleMsg = document.createElement("span");
        staleMsg.className = "week-status-text";
        var asOf = lastCalendarLoadAt !== null ? formatAsOf(new Date(lastCalendarLoadAt)) : null;
        staleMsg.textContent =
          "Repeating events only show on their first date · couldn't refresh" +
          (asOf ? " (as of " + asOf + ")" : "") + ". ";
        el.appendChild(staleMsg);
        el.appendChild(
          makeCalendarRetryButton("Try again", function () {
            fetchCalendarEvents();
          })
        );
      } else {
        // Persistent caveat on every successful fetch, not just an empty
        // week -- the Worker never expands recurring events (see the
        // section header comment), so without this, a week that's
        // actually full of unshown-here recurring events is
        // indistinguishable from a genuinely empty one.
        el.textContent = "Repeating events only show on their first date";
      }
    } else {
      el.textContent = "";
    }
  }

  // How long a successful fetch is trusted before a background refresh
  // (tab focus, midnight rollover) bothers refetching -- matches the
  // Worker's own CALENDAR_CACHE_TTL_SECONDS (5 minutes): a refresh sooner
  // than that can't possibly see anything new.
  var CALENDAR_REFRESH_MS = 5 * 60 * 1000;
  // In-flight guard: without this, rapid tab-switching (each
  // visibilitychange fires a fetch) could start overlapping requests where
  // a slow earlier one resolves after a faster later one and clobbers good
  // data with a stale/error result.
  var calendarFetchInFlight = false;
  // Timestamp (ms) of the last successful array load -- null until the
  // first one, so the staleness check below never blocks the initial
  // fetch on page load.
  var lastCalendarLoadAt = null;

  // opts.silent: a background refresh (tab focus, midnight rollover) rather
  // than a user-initiated one (initial page load, "Try again" click) --
  // subject to the staleness threshold above; an explicit/foreground fetch
  // always goes through.
  function fetchCalendarEvents(opts) {
    var silent = !!(opts && opts.silent);
    if (calendarFetchInFlight) return;
    if (
      silent &&
      lastCalendarLoadAt !== null &&
      Date.now() - lastCalendarLoadAt < CALENDAR_REFRESH_MS
    ) {
      return;
    }

    // Foreground fetches (initial load, or a user-initiated "Try again"
    // click) get an immediate synchronous acknowledgment before the fetch
    // itself has even started -- mirrors requestWeather's "Checking
    // location…" pattern. Without this, a click produces no visible change
    // until .finally fires (up to CALENDAR_FETCH_TIMEOUT_MS later), and a
    // retry that fails again would render byte-identical output to before
    // the click (see F2 review note). Silent background refreshes skip
    // this -- they should stay invisible unless/until they actually change
    // something.
    if (!silent) renderCalendarPending();

    calendarFetchInFlight = true;
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, CALENDAR_FETCH_TIMEOUT_MS);
    fetch(CALENDAR_API, {
      credentials: "include",
      signal: controller.signal,
      referrerPolicy: "no-referrer"
    })
      .then(function (r) {
        // An unauthenticated request to an Access-gated route typically
        // lands here as a non-ok response (redirected to, or answered by,
        // an Access login page) -- checked before ever trying to parse the
        // body as JSON.
        if (!r.ok) throw new Error("bad response");
        var contentType = r.headers.get("content-type") || "";
        if (contentType.indexOf("application/json") === -1) {
          // Covers the case of a 200 response whose body is actually an
          // Access login page (HTML), not our JSON -- content-type alone,
          // checked before r.json() is ever called.
          throw new Error("unexpected content-type");
        }
        return r.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) throw new Error("unexpected response shape");
        calendarEvents = data;
        lastCalendarLoadAt = Date.now();
        calendarRefreshFailed = false;
      })
      .catch(function () {
        // Never let a failed refresh wipe already-successfully-loaded
        // events still on screen -- only downgrade to the honest "error"
        // state when there's no good array already held (first load, or a
        // previous failure). A background refresh that fails after a good
        // load just quietly leaves the existing events in place -- but
        // flags calendarRefreshFailed so renderCalendarStatus can say so,
        // rather than letting a session that's silently stopped refreshing
        // (e.g. an expired Cloudflare Access cookie) eventually render a
        // fully-stale week as if it were a freshly-confirmed empty one
        // (see F1 review note / the section header comment above).
        if (Array.isArray(calendarEvents)) {
          calendarRefreshFailed = true;
        } else {
          calendarEvents = "error";
        }
      })
      .finally(function () {
        clearTimeout(timeoutId);
        calendarFetchInFlight = false;
        // Re-render so the already-visible grid picks up whatever this
        // fetch resolved to, whether that's events or the honest failure
        // status -- both renderWeek (per-day event lists) and
        // renderCalendarStatus (the status line) key off calendarEvents.
        renderWeek();
      });
  }

  // Day-of-month numbers alone are ambiguous across a month boundary (e.g.
  // "29 30 31 1 2 3 4") -- this gives the widget head a "Month Year" (or
  // "Month–Month Year" / "Month Year–Month Year") label to disambiguate.
  function formatMonthLabel(monday, sunday) {
    if (monday.getFullYear() !== sunday.getFullYear()) {
      return (
        MONTH_NAMES[monday.getMonth()] + " " + monday.getFullYear() +
        "–" + MONTH_NAMES[sunday.getMonth()] + " " + sunday.getFullYear()
      );
    }
    if (monday.getMonth() !== sunday.getMonth()) {
      return (
        MONTH_NAMES[monday.getMonth()] + "–" + MONTH_NAMES[sunday.getMonth()] +
        " " + monday.getFullYear()
      );
    }
    return MONTH_NAMES[monday.getMonth()] + " " + monday.getFullYear();
  }

  function renderWeek(now) {
    var list = document.getElementById("week-days");
    var rangeEl = document.getElementById("week-range");
    if (!list) return;

    now = now || new Date();
    // Date#getDay(): 0=Sun..6=Sat. Shift to a Monday-first index (0=Mon..6=Sun).
    var todayIndex = (now.getDay() + 6) % 7;
    var monday = new Date(now);
    monday.setDate(now.getDate() - todayIndex);
    monday.setHours(0, 0, 0, 0);
    var sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    if (rangeEl) rangeEl.textContent = "· " + formatMonthLabel(monday, sunday);

    list.innerHTML = "";
    for (var i = 0; i < 7; i++) {
      var d = new Date(monday);
      d.setDate(monday.getDate() + i);

      var li = document.createElement("li");
      li.className = "week-day";
      var isToday = i === todayIndex;
      if (isToday) li.classList.add("is-today");

      var nameEl = document.createElement("span");
      nameEl.className = "week-day-name";
      nameEl.textContent = DAY_NAMES[i];

      var numEl = document.createElement("span");
      numEl.className = "week-day-num";
      numEl.textContent = String(d.getDate());

      li.appendChild(nameEl);
      li.appendChild(numEl);

      // Only rendered once calendarEvents has actually resolved to a real
      // array -- while it's still null (not yet fetched) or "error" (fetch
      // failed/unauthenticated), the grid stays exactly the plain day list
      // it always was; see renderCalendarStatus for the separate honest
      // status line covering the "error" case.
      if (Array.isArray(calendarEvents)) {
        var dateStr = localDateStr(d);
        // Matched against each event's own LOCAL date (derived from its
        // `start` field), not the Worker's UTC-dated `date` field -- see
        // eventLocalDate's own comment (finding 1).
        var dayEvents = calendarEvents.filter(function (ev) {
          return ev && eventLocalDate(ev) === dateStr;
        });
        if (dayEvents.length) {
          var eventsList = document.createElement("ul");
          eventsList.className = "week-day-events";
          dayEvents.forEach(function (ev) {
            var itemEl = document.createElement("li");
            itemEl.className = "week-day-event";
            // Real external calendar data, rendered as-is via textContent --
            // never innerHTML -- consistent with the rest of this file.
            var title = ev && typeof ev.title === "string" && ev.title ? ev.title : "(untitled event)";
            itemEl.textContent = title;
            // Native tooltip so a title truncated by the narrow column's
            // ellipsis (see .week-day-event in style.css) is still fully
            // readable on hover/focus, without a custom expand control. Also
            // where a recurring event (per the Worker's own `recurring`
            // flag) gets flagged -- see the section header comment above:
            // the Worker only ever shows a recurring event's literal
            // original occurrence, never its later ones, so this note keeps
            // that limitation visible right on the event itself.
            var tooltip = title;
            if (ev && ev.recurring) tooltip += " (repeats)";
            itemEl.title = tooltip;
            eventsList.appendChild(itemEl);
          });
          li.appendChild(eventsList);
        }
      }

      if (isToday) {
        var srEl = document.createElement("span");
        srEl.className = "sr-only";
        srEl.textContent = " (today)";
        li.appendChild(srEl);
      }

      list.appendChild(li);
    }

    renderCalendarStatus();
  }

  // Re-render on next local midnight so a long-open tab doesn't silently
  // keep highlighting yesterday as "today" (or show last week's dates).
  // Reschedules itself each time so this keeps working indefinitely. Also
  // re-fetches calendar events (foreground/non-silent, so it isn't skipped
  // by the staleness threshold) -- without this, the freshly-rendered
  // Mon-Sun grid would still be matched against the OLD week's cached
  // calendarEvents, silently showing every day empty even though the fetch
  // itself never failed.
  function scheduleMidnightRefresh() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
    var delay = next.getTime() - now.getTime();
    setTimeout(function () {
      renderWeek();
      fetchCalendarEvents();
      scheduleMidnightRefresh();
    }, delay);
  }

  function initWeek() {
    if (!document.getElementById("week-days")) return;
    renderWeek();
    // Belt-and-braces alongside the midnight timer above: a tab that was
    // asleep/throttled in the background (timers can be deferred) still
    // gets corrected the moment it's looked at again. Also re-fetches
    // calendar events on the same trigger (silent -- see fetchCalendarEvents
    // -- a background refresh that's already recent enough is skipped, and
    // a background failure never overwrites already-good events on screen).
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        renderWeek();
        fetchCalendarEvents({ silent: true });
      }
    });
    scheduleMidnightRefresh();
    fetchCalendarEvents();
  }

  // Guarded on `document` existing (rather than assuming a browser) so this
  // file can be `require()`d as-is by the Node-based test file below
  // without needing a DOM/jsdom stand-in -- always true in the browser,
  // never true under plain Node. Mirrors live-prices.js's own guard.
  if (typeof document !== "undefined") {
    initWeather();
    initWeek();
  }

  // Expose pure, DOM-free helpers to the Node-based test file at
  // test/glance-widgets.test.js -- this repo has no build step, so the test
  // just requires this file directly rather than importing from a compiled
  // module. Same pattern as live-prices.js's own module.exports guard (see
  // test/live-prices.test.js): a no-op in the browser, since `module` is
  // undefined there.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      pad2: pad2,
      localDateStr: localDateStr,
      eventLocalDate: eventLocalDate,
      parseDailyForecast: parseDailyForecast
    };
  }
})();
