// The to-do list widget shown in the glance row alongside weather/calendar/quick-links (see index.html).
//
// Two modes:
//   - For anyone but the hub owner (and for the owner until the page knows they are the owner) it is purely client-side:
//     the full list (text + done state) is persisted to the browser's own localStorage under a namespaced key, and never
//     leaves the device. No network calls, no accounts.
//   - For the hub owner it shows the SAME to-dos as the Calendar page (the Planner on the server, GET /planner/all), so
//     they follow the owner across devices and are part of the hub backup. The first time, if the browser still holds
//     to-dos of its own, the widget offers a clearly labelled one-time import; the browser copy is left exactly as it was,
//     nothing is deleted, and nothing is imported without a click.
// Dates are the owner's own day. The widget text is rendered with textContent, never innerHTML.
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

  // ---- DOM/localStorage-free helpers -----------------------------------------
  //
  // Kept separate from the localStorage-touching read/write functions below
  // so they can be exercised directly by a Node-based test, same pattern as
  // glance-widgets.js/live-prices.js's own module.exports guard. Not
  // strictly *pure* -- sanitizeTodos calls makeId() below for any item
  // missing a usable id, which reads Date.now() and mutates the
  // module-level idCounter -- but they touch no DOM and no localStorage,
  // which is what makes them test-friendly without a jsdom/localStorage
  // stand-in.

  // Turns whatever JSON.parse produced (could be anything, including
  // malformed/tampered localStorage content) into a known-good array of
  // { id, text, done } items -- anything that doesn't fit that shape is
  // dropped rather than allowed to crash rendering. Also guards against
  // duplicate ids across the array (e.g. hand-edited storage) -- without
  // this, removeTodo's filter-by-id would remove every item sharing an id
  // and toggleDone's find-first would only ever affect one of them, so any
  // item whose id is missing, non-string, or already used earlier in the
  // array gets a freshly generated one instead.
  function sanitizeTodos(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seenIds = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== "object") continue;
      if (typeof item.text !== "string") continue;
      var text = item.text.trim().slice(0, MAX_TEXT_LENGTH);
      if (!text) continue;
      var id = typeof item.id === "string" && item.id && !seenIds[item.id] ? item.id : makeId();
      seenIds[id] = true;
      out.push({ id: id, text: text, done: item.done === true });
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

  // Returns true on a successful write, false on failure (quota exceeded,
  // storage disabled, private-browsing restrictions, etc.) so callers can
  // tell the user their change won't survive a reload rather than failing
  // silently -- see showSaveStatus below.
  function saveTodos(todos) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeTodos(todos));
      return true;
    } catch (e) {
      // The in-memory list still renders for this session, it just won't
      // persist across reloads.
      return false;
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
  function statusEl() {
    return document.getElementById("todo-status");
  }

  // Shown when saveTodos reports a write failure (quota exceeded, storage
  // disabled, private browsing, etc.) -- persistent (not auto-dismissed)
  // since the underlying condition doesn't resolve on its own. Cause-neutral
  // tone matches glance-widgets.js's renderCalendarStatus error copy (see
  // its "Couldn't load your events" state) -- this doesn't try to guess
  // which specific storage restriction applies.
  function showSaveStatus() {
    var status = statusEl();
    if (!status) return;
    status.textContent = "Not saved — this browser wouldn't store your tasks, so they'll disappear on reload.";
  }

  // Clears the message above once a save actually succeeds again, so it
  // doesn't linger claiming a problem that's no longer happening.
  function clearSaveStatus() {
    var status = statusEl();
    if (status) status.textContent = "";
  }

  function findTodoLi(id) {
    var list = listEl();
    if (!list) return null;
    for (var i = 0; i < list.children.length; i++) {
      if (list.children[i].dataset.todoId === id) return list.children[i];
    }
    return null;
  }

  function buildTodoItemEl(item) {
    var li = document.createElement("li");
    li.className = "todo-item";
    li.dataset.todoId = item.id;

    var checkboxId = "todo-cb-" + item.id;

    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-checkbox";
    checkbox.id = checkboxId;
    checkbox.checked = item.done;
    checkbox.addEventListener("change", function () {
      toggleDone(item.id);
    });

    // A <label for="..."> rather than a plain <span> gives the checkbox its
    // accessible name via native semantics (no aria-label needed, and no
    // risk of it drifting out of sync with the visible text), and makes the
    // task text itself clickable to toggle as a side effect.
    var textEl = document.createElement("label");
    textEl.setAttribute("for", checkboxId);
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
    return li;
  }

  // Full rebuild -- only for cases that aren't focus-sensitive: initial page
  // load, and resyncing after another tab changed storage (see the
  // `storage` listener in initTodo). toggleDone/removeTodo below mutate the
  // DOM in place instead, since a full list.innerHTML="" rebuild on every
  // checkbox tick or remove-click would throw a keyboard user's focus back
  // to <body>.
  function renderTodos() {
    var list = listEl();
    var empty = emptyEl();
    if (!list) return;

    list.innerHTML = "";
    todos.forEach(function (item) {
      list.appendChild(buildTodoItemEl(item));
    });

    if (empty) empty.textContent = todos.length ? "" : "No tasks yet";
  }

  function addTodo(text) {
    var trimmed = (text || "").trim().slice(0, MAX_TEXT_LENGTH);
    if (!trimmed) return;
    todos.push({ id: makeId(), text: trimmed, done: false });
    var ok = saveTodos(todos);
    renderTodos();
    if (ok) {
      clearSaveStatus();
    } else {
      showSaveStatus();
    }
  }

  function toggleDone(id) {
    var item = todos.filter(function (t) {
      return t.id === id;
    })[0];
    if (!item) return;
    item.done = !item.done;

    // Mutate the existing <li> in place rather than calling renderTodos --
    // see the comment on renderTodos above.
    var li = findTodoLi(id);
    if (li) {
      var checkbox = li.querySelector(".todo-checkbox");
      if (checkbox) checkbox.checked = item.done;
      var textEl = li.querySelector(".todo-text");
      if (textEl) textEl.classList.toggle("is-done", item.done);
    }

    var ok = saveTodos(todos);
    if (ok) {
      clearSaveStatus();
    } else {
      showSaveStatus();
    }
  }

  function removeTodo(id) {
    // Figure out where focus should land *before* removing anything: the
    // next item's remove button if one exists, otherwise the to-do input --
    // removing the focused element first would drop focus back to <body>.
    var li = findTodoLi(id);
    var nextLi = li ? li.nextElementSibling : null;
    var focusTarget = null;
    if (nextLi) {
      focusTarget = nextLi.querySelector(".todo-remove-btn");
    }
    if (!focusTarget) {
      focusTarget = inputEl();
    }

    todos = todos.filter(function (t) {
      return t.id !== id;
    });
    if (li) li.remove();

    var empty = emptyEl();
    if (empty) empty.textContent = todos.length ? "" : "No tasks yet";

    if (focusTarget) focusTarget.focus();

    var ok = saveTodos(todos);
    if (ok) {
      clearSaveStatus();
    } else {
      showSaveStatus();
    }
  }

  // ---- the owner's list: the Planner on the server ------------------------------------------

  var PLAN_API = "https://api.barnyard.site/planner";
  var IMPORTED_KEY = "barnyard-todos-imported";            // "1" once the browser's own list has been brought in
  var IMPORT_PROGRESS_KEY = "barnyard-todos-import-count";  // how many were brought in so far (so a retry never duplicates)
  var WIDGET_MAX = 12;
  var serverMode = false;
  var serverTasks = [];

  function logic() { return typeof window !== "undefined" ? window.BarnyardCalendarLogic : null; }
  function localToday() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function subEl() { return document.getElementById("todo-sub"); }
  function importEl() { return document.getElementById("todo-import"); }
  function readKey(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function writeKey(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* the import just asks again */ } }

  function plannerCall(path, body) {
    var opts = { method: body === undefined ? "GET" : "POST", credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(Object.assign({ today: localToday() }, body));
    }
    return fetch(PLAN_API + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || "request_failed");
          err.code = data && data.error;
          throw err;
        }
        return data;
      });
    });
  }

  function srvMessage(text) {
    var status = statusEl();
    if (status) status.textContent = text || "";
  }

  function buildServerItemEl(task) {
    var L = logic();
    var li = document.createElement("li");
    li.className = "todo-item";
    li.dataset.todoId = task.id;
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-checkbox";
    checkbox.id = "todo-cb-" + task.id;
    checkbox.addEventListener("change", function () { srvTick(task); });
    var label = document.createElement("label");
    label.setAttribute("for", checkbox.id);
    label.className = "todo-text";
    label.textContent = task.title;
    li.appendChild(checkbox);
    li.appendChild(label);
    if (task.due && L) {
      var late = task.due < localToday();
      var due = document.createElement("span");
      due.className = "todo-due" + (late ? " is-late" : "");
      due.textContent = L.shortDate(task.due) + (task.time ? ", " + L.timeText(task.time) : "") + (late ? " (overdue)" : "");
      li.appendChild(due);
    }
    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "todo-remove-btn";
    removeBtn.setAttribute("aria-label", "Remove \"" + task.title + "\"");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", function () { srvRemove(task); });
    li.appendChild(removeBtn);
    return li;
  }

  function srvRender() {
    var list = listEl(), empty = emptyEl(), L = logic();
    if (!list || !L) return;
    var shown = L.widgetTasks(serverTasks, localToday(), WIDGET_MAX);
    while (list.firstChild) list.removeChild(list.firstChild);
    shown.rows.forEach(function (t) { list.appendChild(buildServerItemEl(t)); });
    if (empty) {
      empty.textContent = shown.rows.length ? "" : "No tasks yet";
      if (shown.more) {
        empty.textContent = shown.more + " more on the Calendar. ";
        var a = document.createElement("a");
        a.href = "calendar.html#todos";
        a.textContent = "Open the Calendar";
        empty.appendChild(a);
      }
    }
  }

  function srvLoad() {
    return plannerCall("/all").then(function (r) {
      serverTasks = Array.isArray(r.tasks) ? r.tasks : [];
      srvMessage("");
      srvRender();
    }, function () { srvMessage("Couldn’t load your to-dos just now."); });
  }

  function srvPut(task) {
    var i = serverTasks.findIndex(function (x) { return x.id === task.id; });
    if (i >= 0) serverTasks[i] = task; else serverTasks.push(task);
  }

  function srvAdd(text) {
    var L = logic();
    var q = L ? L.parseQuick(text, localToday()) : { title: String(text || "").trim(), due: "", time: "", recur: "", priority: "normal" };
    if (!q.title) return;
    plannerCall("/task", { title: q.title.slice(0, MAX_TEXT_LENGTH), due: q.due, time: q.time, recur: q.recur, priority: q.priority }).then(function (r) {
      srvPut(r.task);
      srvMessage("");
      srvRender();
    }, function (e) { srvMessage(e.code === "secret_detected" ? "That looks like a secret, so it wasn’t saved." : "Couldn’t save that just now."); });
  }

  function srvTick(task) {
    plannerCall("/task/done", { id: task.id, done: true }).then(function (r) {
      srvPut(r.task);
      srvMessage(r.advanced ? "Done. It comes back on its next date." : "");
      srvRender();
    }, function () { srvMessage("Couldn’t tick that just now."); srvRender(); });
  }

  function srvRemove(task) {
    plannerCall("/task/delete", { id: task.id }).then(function () {
      serverTasks = serverTasks.filter(function (x) { return x.id !== task.id; });
      srvRender();
      var input = inputEl();
      if (input) input.focus();
    }, function () { srvMessage("Couldn’t remove that just now."); });
  }

  // The one-time, clearly labelled import of this browser's own list. Nothing is deleted from the browser, and it is only
  // done when asked. The count of those already brought in is kept, so a retry after a failure never duplicates.
  function offerImport() {
    var box = importEl();
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var local = loadTodos();
    if (!local.length || readKey(IMPORTED_KEY) === "1") { box.hidden = true; return; }
    box.hidden = false;
    var p = document.createElement("p");
    p.textContent = "You have " + local.length + (local.length === 1 ? " to-do" : " to-dos") + " saved only in this browser. Bring " + (local.length === 1 ? "it" : "them") + " into your calendar to-dos so they follow you to other devices. Your browser copy is left as it is.";
    var go = document.createElement("button");
    go.type = "button";
    go.className = "todo-add-btn";
    go.textContent = "Import them";
    var later = document.createElement("button");
    later.type = "button";
    later.className = "todo-remove-btn";
    later.textContent = "Not now";
    later.addEventListener("click", function () { box.hidden = true; });
    go.addEventListener("click", function () { runImport(local, go, later); });
    box.appendChild(p);
    box.appendChild(go);
    box.appendChild(later);
  }

  function runImport(local, goBtn, laterBtn) {
    goBtn.disabled = laterBtn.disabled = true;
    var start = Math.min(local.length, Math.max(0, parseInt(readKey(IMPORT_PROGRESS_KEY) || "0", 10) || 0));
    var i = start;
    function next() {
      if (i >= local.length) {
        writeKey(IMPORTED_KEY, "1");
        srvMessage("Imported " + local.length + (local.length === 1 ? " to-do" : " to-dos") + ". Your browser copy is unchanged.");
        importEl().hidden = true;
        return srvLoad();
      }
      var item = local[i];
      return plannerCall("/task", { title: item.text }).then(function (r) {
        return item.done ? plannerCall("/task/done", { id: r.task.id, done: true }) : null;
      }).then(function () { i++; writeKey(IMPORT_PROGRESS_KEY, String(i)); return next(); });
    }
    next().catch(function () {
      srvMessage("Imported " + i + " of " + local.length + " before something went wrong. Press Import again to carry on from there.");
      goBtn.disabled = laterBtn.disabled = false;
      srvLoad();
    });
  }

  function enterServerMode() {
    if (serverMode || !logic()) return;
    serverMode = true;
    var sub = subEl();
    if (sub) sub.textContent = "Saved on your account, same as the Calendar";
    var list = listEl();
    if (list) while (list.firstChild) list.removeChild(list.firstChild);
    srvLoad().then(offerImport);
    setInterval(function () { if (serverMode && !document.hidden) srvLoad(); }, 120000);
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
      if (serverMode) srvAdd(input.value); else addTodo(input.value);
      input.value = "";
      input.focus();
    });

    // The owner sees the Calendar's to-dos instead (and is offered the one-time import). Anyone else, and the owner until the
    // page knows who they are, keeps the browser-only list above.
    var T = window.BarnyardTheme;
    if (T && T.who && typeof T.who.onChange === "function") {
      T.who.onChange(function (w) { if (w && w.owner === true) enterServerMode(); });
    }

    // Without this, two open tabs silently clobber each other: Tab A holds
    // a stale in-memory `todos` array, and if Tab B adds/changes a task,
    // Tab A's next save (e.g. ticking an unrelated checkbox) overwrites Tab
    // B's change with no error or indication. Reloading from storage and
    // re-rendering on any external change to our key keeps both tabs
    // consistent. `storage` only fires in *other* tabs/windows, never the
    // one that made the change, so this can't loop back on itself.
    window.addEventListener("storage", function (e) {
      // e.key is null when storage was cleared entirely (e.g. devtools
      // "Clear site data"), which should also resync us to an empty list.
      if (e.key !== STORAGE_KEY && e.key !== null) return;
      if (serverMode) return;   // the owner's list is on the server, not in storage
      todos = loadTodos();
      renderTodos();
    });
  }

  // Guarded on `document` existing, same as glance-widgets.js/live-prices.js,
  // so this file can be require()d as-is by a Node-based test.
  if (typeof document !== "undefined") {
    initTodo();
  }

  // Expose the DOM/localStorage-free helpers above (see that section's
  // header comment re: not being strictly pure) to a Node-based test file,
  // same module.exports guard pattern as glance-widgets.js/live-prices.js.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      sanitizeTodos: sanitizeTodos,
      parseTodosJson: parseTodosJson,
      serializeTodos: serializeTodos
    };
  }
})();
