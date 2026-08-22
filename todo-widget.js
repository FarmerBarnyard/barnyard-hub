// A purely client-side to-do list widget shown in the glance row alongside
// weather/calendar/quick-links (see index.html). This project has no
// backend for user-specific data (see glance-widgets.js/live-prices.js's
// own file headers) -- the full list (text + done state) is persisted to
// the browser's own localStorage under a namespaced key, and never leaves
// the device. No network calls, no accounts.
(function () {
  "use strict";

  var STORAGE_KEY = "barnyard-todos";
  // Matches the <input maxlength> in index.html -- enforced again here so a
  // pasted value (which bypasses maxlength's own truncation-on-type
  // behavior in some browsers) can't sneak a much longer string into
  // localStorage and blow out the list's layout.
  var MAX_TEXT_LENGTH = 200;

  // Monotonic-enough id generator for a single-tab, single-user list: a
  // timestamp plus an incrementing counter, so two items added within the
  // same millisecond (e.g. rapid Enter presses) still get distinct ids.
  var idCounter = 0;
  function makeId() {
    idCounter += 1;
    return Date.now().toString(36) + "-" + idCounter.toString(36);
  }

  // ---- Pure helpers (no DOM, no localStorage) -------------------------------
  //
  // Kept separate from the localStorage-touching read/write functions below
  // so they can be exercised directly by a Node-based test, same pattern as
  // glance-widgets.js/live-prices.js's own module.exports guard.

  // Turns whatever JSON.parse produced (could be anything, including
  // malformed/tampered localStorage content) into a known-good array of
  // { id, text, done } items -- anything that doesn't fit that shape is
  // dropped rather than allowed to crash rendering.
  function sanitizeTodos(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== "object") continue;
      if (typeof item.text !== "string") continue;
      var text = item.text.trim().slice(0, MAX_TEXT_LENGTH);
      if (!text) continue;
      out.push({
        id: typeof item.id === "string" && item.id ? item.id : makeId(),
        text: text,
        done: item.done === true
      });
    }
    return out;
  }

  // Parses a raw localStorage string into a sanitized list. Never throws --
  // missing key, invalid JSON, or a wrong-shaped value all just yield [].
  function parseTodosJson(json) {
    if (typeof json !== "string" || !json) return [];
    var parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return [];
    }
    return sanitizeTodos(parsed);
  }

  function serializeTodos(todos) {
    return JSON.stringify(sanitizeTodos(todos));
  }

  // ---- localStorage read/write ----------------------------------------------

  function loadTodos() {
    try {
      return parseTodosJson(window.localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      // Storage can be unavailable (private browsing in some browsers,
      // disabled storage, etc.) -- fail to an empty list rather than
      // breaking the rest of the page.
      return [];
    }
  }

  function saveTodos(todos) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeTodos(todos));
    } catch (e) {
      // Quota exceeded or storage unavailable -- the in-memory list still
      // renders for this session, it just won't persist across reloads.
    }
  }

  // ---- DOM ------------------------------------------------------------------

  var todos = [];

  function listEl() {
    return document.getElementById("todo-list");
  }
  function emptyEl() {
    return document.getElementById("todo-empty");
  }
  function inputEl() {
    return document.getElementById("todo-input");
  }

  function renderTodos() {
    var list = listEl();
    var empty = emptyEl();
    if (!list) return;

    list.innerHTML = "";
    todos.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "todo-item";

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "todo-checkbox";
      checkbox.checked = item.done;
      checkbox.setAttribute("aria-label", "Mark \"" + item.text + "\" as " + (item.done ? "not done" : "done"));
      checkbox.addEventListener("change", function () {
        toggleDone(item.id);
      });

      var textEl = document.createElement("span");
      textEl.className = "todo-text" + (item.done ? " is-done" : "");
      // User-supplied text rendered via textContent, never innerHTML -- same
      // pattern used throughout glance-widgets.js for any user/external
      // string (calendar event titles, etc.) to avoid XSS.
      textEl.textContent = item.text;

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "todo-remove-btn";
      removeBtn.setAttribute("aria-label", "Remove \"" + item.text + "\"");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function () {
        removeTodo(item.id);
      });

      li.appendChild(checkbox);
      li.appendChild(textEl);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });

    if (empty) empty.textContent = todos.length ? "" : "No tasks yet";
  }

  function addTodo(text) {
    var trimmed = (text || "").trim().slice(0, MAX_TEXT_LENGTH);
    if (!trimmed) return;
    todos.push({ id: makeId(), text: trimmed, done: false });
    saveTodos(todos);
    renderTodos();
  }

  function toggleDone(id) {
    var item = todos.filter(function (t) {
      return t.id === id;
    })[0];
    if (!item) return;
    item.done = !item.done;
    saveTodos(todos);
    renderTodos();
  }

  function removeTodo(id) {
    todos = todos.filter(function (t) {
      return t.id !== id;
    });
    saveTodos(todos);
    renderTodos();
  }

  function initTodo() {
    var form = document.getElementById("todo-form");
    if (!form || !listEl()) return;

    todos = loadTodos();
    renderTodos();

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = inputEl();
      if (!input) return;
      addTodo(input.value);
      input.value = "";
      input.focus();
    });
  }

  // Guarded on `document` existing, same as glance-widgets.js/live-prices.js,
  // so this file can be require()d as-is by a Node-based test.
  if (typeof document !== "undefined") {
    initTodo();
  }

  // Expose pure, DOM-free helpers to a Node-based test file, same
  // module.exports guard pattern as glance-widgets.js/live-prices.js.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      sanitizeTodos: sanitizeTodos,
      parseTodosJson: parseTodosJson,
      serializeTodos: serializeTodos
    };
  }
})();
