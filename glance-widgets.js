// Two self-contained "at a glance" widgets shown between the header and the
// project tiles: current weather (via the browser's Geolocation API plus
// Open-Meteo's free, keyless forecast API) and a pure client-side week-view
// calendar computed from the visitor's local clock.
//
// Neither widget talks to any account or tracking service. The weather
// widget only contacts Open-Meteo (over HTTPS, no API key/config), and only
// once the visitor explicitly asks for it by clicking "Show weather near
// me" -- nothing here calls the Geolocation API on page load. The calendar
// widget doesn't touch a network at all. Keeps the footer's
// "no accounts, no tracking" claim true.
//
// Both are best-effort: any failure (denied permission, network hiccup,
// unexpected response shape) renders an honest status message in the tile
// instead of guessing or leaving it blank. Nothing here can break the rest
// of the page.
(function () {
  "use strict";

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

  function renderWeather(tempC, code, asOfDate) {
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
      "&current=temperature_2m,weather_code&temperature_unit=celsius";
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
        var now = new Date();
        lastWeatherLoadAt = now.getTime();
        renderWeather(current.temperature_2m, current.weather_code, now);
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
  // Purely local: Monday-Sunday for the visitor's current local week, built
  // from new Date() with no network call and no calendar-account connection.

  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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
  // widget, this route is same-account-only and gated by Cloudflare Access
  // (a cookie-based login on the api.barnyard.site hostname) -- an
  // unauthenticated visitor's request gets redirected to an Access login
  // page (or otherwise fails/returns something that isn't our JSON), which
  // is treated below as an honest "couldn't check" state, distinct from a
  // successful-but-empty week. This widget never attempts to drive the
  // visitor into that login flow itself -- see the file/task note, out of
  // scope here -- it just degrades to a plain day grid plus a status line.

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

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Local "YYYY-MM-DD" for a given Date, matched against each event's own
  // `date` field (the Worker's own dateStr for that event's start) to decide
  // which day column it belongs in.
  function localDateStr(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function weekStatusEl() {
    return document.getElementById("week-status");
  }

  function renderCalendarStatus() {
    var el = weekStatusEl();
    if (!el) return;
    // Deliberately worded as "couldn't check" / "sign in", never "no
    // events" -- see the section header comment above.
    el.textContent = calendarEvents === "error" ? "Sign in to see your events" : "";
  }

  function fetchCalendarEvents() {
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
      })
      .catch(function () {
        calendarEvents = "error";
      })
      .finally(function () {
        clearTimeout(timeoutId);
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
        var dayEvents = calendarEvents.filter(function (ev) {
          return ev && ev.date === dateStr;
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
            // readable on hover/focus, without a custom expand control.
            itemEl.title = title;
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
  // Reschedules itself each time so this keeps working indefinitely.
  function scheduleMidnightRefresh() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
    var delay = next.getTime() - now.getTime();
    setTimeout(function () {
      renderWeek();
      scheduleMidnightRefresh();
    }, delay);
  }

  function initWeek() {
    if (!document.getElementById("week-days")) return;
    renderWeek();
    // Belt-and-braces alongside the midnight timer above: a tab that was
    // asleep/throttled in the background (timers can be deferred) still
    // gets corrected the moment it's looked at again. Also re-fetches
    // calendar events on the same trigger -- no polling loop for a calendar
    // (events don't change second-to-second), but a tab left open across
    // days should still pick up the new day's events without a manual
    // reload.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        renderWeek();
        fetchCalendarEvents();
      }
    });
    scheduleMidnightRefresh();
    fetchCalendarEvents();
  }

  initWeather();
  initWeek();
})();
