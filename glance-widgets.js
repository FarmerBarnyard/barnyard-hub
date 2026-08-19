// Two self-contained "at a glance" widgets shown between the header and the
// project tiles: current weather (via the browser's Geolocation API plus
// Open-Meteo's free, keyless forecast + geocoding APIs) and a pure
// client-side week-view calendar computed from the visitor's local clock.
//
// Neither widget talks to any account or tracking service -- the weather
// widget only ever sends the coordinates the browser itself already
// disclosed (to Open-Meteo, over HTTPS, no API key/config), and the
// calendar widget doesn't touch a network at all. Keeps the footer's
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
  var GEOCODE_API = "https://geocoding-api.open-meteo.com/v1/reverse";
  var FETCH_TIMEOUT_MS = 10000;

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

  function fetchWithTimeout(url) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timeoutId);
    });
  }

  function weatherBody() {
    return document.getElementById("weather-body");
  }

  function renderWeatherStatus(message) {
    var body = weatherBody();
    if (!body) return;
    body.setAttribute("data-weather-state", "message");
    body.innerHTML = "";
    var p = document.createElement("p");
    p.className = "weather-status";
    p.textContent = message;
    body.appendChild(p);
  }

  function renderWeather(tempC, code, placeLabel) {
    var body = weatherBody();
    if (!body) return;
    var info = describeWeatherCode(code);
    var label = info[0];
    var icon = info[1];
    body.setAttribute("data-weather-state", "loaded");
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

    if (placeLabel) {
      var placeEl = document.createElement("p");
      placeEl.className = "weather-place";
      placeEl.textContent = placeLabel;
      body.appendChild(placeEl);
    }
  }

  function reverseGeocode(lat, lon) {
    var url =
      GEOCODE_API +
      "?latitude=" + encodeURIComponent(lat) +
      "&longitude=" + encodeURIComponent(lon) +
      "&language=en&format=json&count=1";
    return fetchWithTimeout(url)
      .then(function (r) {
        if (!r.ok) throw new Error("bad response");
        return r.json();
      })
      .then(function (data) {
        var result = data && data.results && data.results[0];
        if (!result || !result.name) return null;
        return result.admin1 ? result.name + ", " + result.admin1 : result.name;
      })
      .catch(function () {
        // A place name is a nice-to-have -- never block the
        // temperature/condition display on it.
        return null;
      });
  }

  function loadWeather(lat, lon) {
    var url =
      WEATHER_API +
      "?latitude=" + encodeURIComponent(lat) +
      "&longitude=" + encodeURIComponent(lon) +
      "&current=temperature_2m,weather_code&temperature_unit=celsius";
    fetchWithTimeout(url)
      .then(function (r) {
        if (!r.ok) throw new Error("bad response");
        return r.json();
      })
      .then(function (data) {
        var current = data && data.current;
        if (
          !current ||
          !Number.isFinite(current.temperature_2m) ||
          !Number.isFinite(current.weather_code)
        ) {
          throw new Error("incomplete weather data");
        }
        reverseGeocode(lat, lon).then(function (place) {
          renderWeather(current.temperature_2m, current.weather_code, place);
        });
      })
      .catch(function () {
        renderWeatherStatus("Weather unavailable right now");
      });
  }

  function initWeather() {
    if (!weatherBody()) return;
    if (!("geolocation" in navigator)) {
      renderWeatherStatus("Enable location for weather");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (position) {
        loadWeather(position.coords.latitude, position.coords.longitude);
      },
      function () {
        // Covers permission denied as well as any other geolocation failure
        // (timeout, position unavailable) -- an honest fallback message
        // rather than guessing at or hardcoding a location.
        renderWeatherStatus("Enable location for weather");
      },
      { timeout: FETCH_TIMEOUT_MS }
    );
  }

  // ---- Week calendar --------------------------------------------------------
  //
  // Purely local: Monday-Sunday for the visitor's current local week, built
  // from new Date() with no network call and no calendar-account connection.

  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function renderWeek() {
    var list = document.getElementById("week-days");
    if (!list) return;

    var today = new Date();
    // Date#getDay(): 0=Sun..6=Sat. Shift to a Monday-first index (0=Mon..6=Sun).
    var todayIndex = (today.getDay() + 6) % 7;
    var monday = new Date(today);
    monday.setDate(today.getDate() - todayIndex);
    monday.setHours(0, 0, 0, 0);

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

      if (isToday) {
        var srEl = document.createElement("span");
        srEl.className = "sr-only";
        srEl.textContent = " (today)";
        li.appendChild(srEl);
      }

      list.appendChild(li);
    }
  }

  initWeather();
  renderWeek();
})();
