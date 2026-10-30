// The Kitchen page (kitchen.html): recipes you can scale, a weekly meal plan, a shopping list built from the plan, and a pantry.
// The owner's page, like Services and the Release board.
//
// Reads and writes /kitchen/* on the Worker (ClaudeRepo's cloudflare-worker/src/kitchen-routes.js, owner only):
//   GET  /kitchen/recipes   GET /kitchen/recipe?id=   POST /kitchen/recipe   POST /kitchen/recipe/delete
//   GET  /kitchen/week?week=   POST /kitchen/plan   POST /kitchen/plan/copy   POST /kitchen/pantry
//   POST /kitchen/list/tick   POST /kitchen/list/add   POST /kitchen/list/remove   POST /kitchen/list/stock
// The Worker builds the shopping list (it merges the same ingredient, takes the pantry off and groups by aisle); this page shows it. Scaling a
// recipe on the screen and the cooking-mode timers are done here (kitchen-logic.js, covered by test/kitchen.test.js).
//
// Everything from the server reaches the page through textContent, never innerHTML (the CSP has no 'unsafe-inline' for scripts or styles),
// there are no links to anything outside this site, and sizes and colours come from classes. Nothing is kept in this browser.

(function () {
  "use strict";

  var L = window.BarnyardKitchenLogic;
  var API = "https://api.barnyard.site";
  var TABS = [["recipes", "Recipes"], ["plan", "Meal plan"], ["shop", "Shopping list"], ["pantry", "Pantry"]];

  var model = {
    state: "loading", tab: "recipes", recipes: [], limits: null, filter: { q: "", tag: "", sort: "" },
    openId: "", recipe: null, servings: 0, editing: null, confirmDelete: false, planning: null,
    week: "", thisWeek: "", view: null, slotEdit: null, pantryDraft: null, cook: null
  };

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function btn(text, cls, onClick) {
    var b = h("button", "btn " + (cls || ""), text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function option(value, text, selected) {
    var o = h("option", null, text);
    o.value = value;
    if (selected) o.selected = true;
    return o;
  }
  function labelled(text, control) {
    var l = h("label", null, text);
    l.appendChild(control);
    return l;
  }

  // ---- data -----------------------------------------------------------------------------------------------------------

  function call(method, path, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 25000);
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    if (body !== undefined) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    }, function () { clearTimeout(timer); return { status: 0, body: {} }; });
  }

  function flash(text, tone) {
    var box = $("kt-flash");
    if (!box) return;
    clear(box);
    if (!text) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "kt-flash " + (tone || "");
    box.appendChild(h("span", null, text));
    if (/sign in again/i.test(text) && typeof window.barnyardLoginUrl === "function") {
      var a = h("a", "btn btn-sm", "Sign in again");
      a.href = window.barnyardLoginUrl();
      box.appendChild(a);
    }
  }
  function failed(r) { flash(L.errorText(r.body, r.status), "alert"); }

  function stateFor(r) {
    if (r.status === 401) { model.state = "guest"; return true; }
    if (r.status === 403 && r.body && r.body.error === "kitchen_disabled") { model.state = "off"; return true; }
    if (r.status === 403) { model.state = "forbidden"; return true; }
    if (r.status === 0 || r.status >= 500) { model.state = model.view ? "ok" : "error"; return true; }
    return false;
  }

  function loadRecipes() {
    return call("GET", "/kitchen/recipes").then(function (r) {
      if (stateFor(r)) return false;
      model.recipes = r.body.recipes || []; model.limits = r.body.limits || null;
      return true;
    });
  }
  function loadWeek(week) {
    return call("GET", "/kitchen/week" + (week ? "?week=" + encodeURIComponent(week) : "")).then(function (r) {
      if (stateFor(r)) return false;
      applyView(r.body);
      return true;
    });
  }
  function applyView(view) {
    model.view = view; model.week = view.week; model.thisWeek = view.thisWeek;
    model.pantryDraft = null;
    model.state = "ok";
  }
  function openRecipe(id) {
    return call("GET", "/kitchen/recipe?id=" + encodeURIComponent(id)).then(function (r) {
      if (stateFor(r)) return;
      if (r.status === 404) { flash("That recipe is not there any more.", "alert"); model.openId = ""; model.recipe = null; return; }
      model.openId = id; model.recipe = r.body.recipe; model.servings = r.body.recipe.servings; model.editing = null; model.confirmDelete = false; model.planning = null;
    });
  }

  // ---- hash ------------------------------------------------------------------------------------------------------------

  function setHash(tab, id) { var want = "#" + tab + (id ? "/" + id : ""); if (location.hash !== want) location.hash = want; }
  function readHash() {
    var m = /^#(recipes|plan|shop|pantry)(?:\/(rc_[a-z0-9]{8}))?$/.exec(location.hash || "");
    return m ? { tab: m[1], id: m[2] || "" } : { tab: "recipes", id: "" };
  }
  function route() {
    var r = readHash();
    model.tab = r.tab;
    if (r.tab !== "recipes") { model.openId = ""; model.recipe = null; model.editing = null; render(); return; }
    if (r.id && r.id !== model.openId) { openRecipe(r.id).then(render); return; }
    if (!r.id) { model.openId = ""; model.recipe = null; if (model.editing && !model.editing.isNew) model.editing = null; }
    render();
  }

  // ---- shared pieces -------------------------------------------------------------------------------------------------------

  function renderTabs() {
    var box = $("kt-tabs");
    clear(box);
    TABS.forEach(function (t) {
      var b = h("button", "kt-tab", t[1]);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", model.tab === t[0] ? "true" : "false");
      b.addEventListener("click", function () { flash(""); setHash(t[0], ""); });
      box.appendChild(b);
    });
  }

  function weekNav(onChange) {
    var nav = h("div", "kt-weeknav");
    var go = function (week) { loadWeek(week).then(function (ok) { if (ok) { model.slotEdit = null; onChange(); } }); };
    nav.appendChild(btn("‹ Earlier", "btn-sm", function () { go(L.addDays(model.week, -7)); }));
    nav.appendChild(h("b", null, L.weekLabel(model.week, model.thisWeek)));
    nav.appendChild(btn("Later ›", "btn-sm", function () { go(L.addDays(model.week, 7)); }));
    if (model.week !== model.thisWeek) nav.appendChild(btn("This week", "btn-sm btn-quiet", function () { go(model.thisWeek); }));
    return nav;
  }

  function recipeTitle(id) { return (model.view && model.view.titles && model.view.titles[id]) || ""; }

  // ---- recipes ---------------------------------------------------------------------------------------------------------------

  function renderRecipes(root) {
    if (model.editing) { renderEditForm(root); return; }
    if (model.recipe) { renderRecipe(root); return; }
    var bar = h("div", "kt-bar");
    var search = h("input"); search.type = "search"; search.placeholder = "Search recipes or ingredients"; search.value = model.filter.q; search.className = "grow"; search.setAttribute("aria-label", "Search recipes");
    var sort = h("select"); sort.setAttribute("aria-label", "Sort recipes");
    [["", "Newest edit"], ["rating", "Best rated"], ["title", "A to Z"]].forEach(function (o) { sort.appendChild(option(o[0], o[1], model.filter.sort === o[0])); });
    bar.appendChild(search); bar.appendChild(sort);
    bar.appendChild(btn("New recipe", "btn-primary", function () { model.editing = { isNew: true, recipe: null }; render(); }));
    root.appendChild(bar);
    var tagBox = h("div", "kt-tags"); root.appendChild(tagBox);
    var grid = h("div", "kt-grid"); root.appendChild(grid);

    function paint() {
      clear(tagBox); clear(grid);
      L.tagCounts(model.recipes).slice(0, 14).forEach(function (t) {
        var b = h("button", "kt-tagbtn", t.tag + " " + t.n); b.type = "button"; b.setAttribute("aria-pressed", model.filter.tag === t.tag ? "true" : "false");
        b.addEventListener("click", function () { model.filter.tag = model.filter.tag === t.tag ? "" : t.tag; paint(); });
        tagBox.appendChild(b);
      });
      var shown = L.filterRecipes(model.recipes, model.filter.q, model.filter.tag, model.filter.sort);
      if (!shown.length) {
        grid.className = "";
        grid.appendChild(h("div", "kt-empty", model.recipes.length ? "No recipe matches that." : "No recipes yet. Press New recipe to add the first one."));
        return;
      }
      grid.className = "kt-grid";
      shown.forEach(function (r) {
        var card = h("button", "kt-card"); card.type = "button";
        card.appendChild(h("h3", null, r.title));
        var meta = h("div", "kt-meta");
        var st = L.stars(r.rating); if (st) meta.appendChild(h("span", "kt-stars", st));
        meta.appendChild(h("span", null, r.servings + " serves"));
        var t = L.minutesText(r.prepMin, r.cookMin); if (t) meta.appendChild(h("span", null, t));
        meta.appendChild(h("span", null, r.ingredientCount + " ingredients"));
        card.appendChild(meta);
        if ((r.tags || []).length) { var tg = h("div", "kt-tags"); r.tags.forEach(function (x) { tg.appendChild(h("span", "chip", x)); }); card.appendChild(tg); }
        card.addEventListener("click", function () { setHash("recipes", r.id); });
        grid.appendChild(card);
      });
    }
    search.addEventListener("input", function () { model.filter.q = search.value; paint(); });
    sort.addEventListener("change", function () { model.filter.sort = sort.value; paint(); });
    paint();
  }

  function ingredientLine(i) {
    var parts = [];
    if (i.q !== null && i.q !== undefined) parts.push(L.formatQuantity(i.q));
    if (i.unit) parts.push(i.unit);
    parts.push(i.name);
    return parts.join(" ") + (i.note ? ", " + i.note : "");
  }

  function renderRecipe(root) {
    var r = model.recipe;
    var wrap = h("div", "kt-recipe");
    wrap.appendChild(btn("‹ All recipes", "btn-sm btn-quiet", function () { flash(""); setHash("recipes", ""); }));
    wrap.appendChild(h("h2", null, r.title));
    var meta = h("div", "kt-meta");
    var st = L.stars(r.rating); if (st) meta.appendChild(h("span", "kt-stars", st));
    var t = L.minutesText(r.prepMin, r.cookMin); if (t) meta.appendChild(h("span", null, t));
    (r.tags || []).forEach(function (x) { meta.appendChild(h("span", "chip", x)); });
    if (r.source) meta.appendChild(h("span", null, "From " + r.source));
    wrap.appendChild(meta);

    var tools = h("div", "kt-rtools");
    tools.appendChild(btn("Cooking mode", "btn-primary", function () { startCooking(); }));
    tools.appendChild(btn("Add to the plan", "", function () { model.planning = model.planning ? null : { week: model.thisWeek || "", day: L.DAYS[0], slot: "dinner" }; render(); }));
    tools.appendChild(btn("Edit", "", function () { model.editing = { isNew: false, recipe: r }; render(); }));
    var del = btn(model.confirmDelete ? "Press again to delete" : "Delete", model.confirmDelete ? "btn-primary" : "btn-quiet", function () {
      if (!model.confirmDelete) { model.confirmDelete = true; render(); return; }
      call("POST", "/kitchen/recipe/delete", { id: r.id }).then(function (res) {
        if (res.status !== 200) { failed(res); return; }
        flash("Deleted " + r.title + ".", "ok");
        model.recipes = model.recipes.filter(function (x) { return x.id !== r.id; }); model.recipe = null; model.openId = ""; model.confirmDelete = false;
        setHash("recipes", ""); render();
      });
    });
    tools.appendChild(del);
    wrap.appendChild(tools);
    if (model.planning) wrap.appendChild(planningForm(r));

    var cols = h("div", "kt-cols");
    var left = h("div", "kt-panel");
    left.appendChild(h("h3", null, "Ingredients"));
    var step = h("div", "kt-stepper");
    step.appendChild(btn("−", "btn-sm", function () { model.servings = L.stepServings(model.servings, -1); render(); }));
    step.appendChild(h("b", null, String(model.servings)));
    step.appendChild(btn("+", "btn-sm", function () { model.servings = L.stepServings(model.servings, 1); render(); }));
    step.appendChild(h("span", "dim", model.servings === r.servings ? "servings" : "servings (written for " + r.servings + ")"));
    left.appendChild(step);
    var ul = h("ul", "kt-ing");
    L.scaledIngredients(r, model.servings).forEach(function (i) { ul.appendChild(h("li", null, i.text)); });
    left.appendChild(ul);
    cols.appendChild(left);

    var right = h("div", "kt-panel");
    right.appendChild(h("h3", null, "Method"));
    if (r.steps.length) { var ol = h("ol", "kt-steps"); r.steps.forEach(function (s) { ol.appendChild(h("li", null, s)); }); right.appendChild(ol); }
    else right.appendChild(h("p", "dim", "No steps written yet."));
    if (r.notes) { right.appendChild(h("h3", null, "Cook's notes")); right.appendChild(h("p", "kt-notes", r.notes)); }
    cols.appendChild(right);
    wrap.appendChild(cols);
    root.appendChild(wrap);
  }

  function planningForm(r) {
    var box = h("div", "kt-panel");
    box.appendChild(h("h3", null, "Add " + r.title + " to the plan"));
    var row = h("div", "kt-bar");
    var week = h("select");
    var weeks = model.thisWeek ? [model.thisWeek, L.addDays(model.thisWeek, 7), L.addDays(model.thisWeek, 14)] : [];
    weeks.forEach(function (w) { week.appendChild(option(w, L.weekLabel(w, model.thisWeek), model.planning.week === w)); });
    var day = h("select"); L.DAYS.forEach(function (d) { day.appendChild(option(d, L.DAY_NAMES[d], model.planning.day === d)); });
    var slot = h("select"); L.SLOTS.forEach(function (s) { slot.appendChild(option(s, L.SLOT_NAMES[s], model.planning.slot === s)); });
    var serv = h("input"); serv.type = "number"; serv.min = "1"; serv.max = "100"; serv.value = String(model.servings); serv.setAttribute("aria-label", "Servings");
    row.appendChild(labelled("Week", week)); row.appendChild(labelled("Day", day)); row.appendChild(labelled("Meal", slot)); row.appendChild(labelled("Servings", serv));
    box.appendChild(row);
    var actions = h("div", "kt-actions");
    actions.appendChild(btn("Add", "btn-primary", function () {
      var n = parseInt(serv.value, 10);
      saveSlot(week.value, day.value, slot.value, { kind: "recipe", recipeId: r.id, servings: n >= 1 && n <= 100 ? n : r.servings }).then(function (ok) {
        if (ok) { model.planning = null; flash("Added " + r.title + " to " + L.DAY_NAMES[day.value] + " " + L.SLOT_NAMES[slot.value].toLowerCase() + ".", "ok"); render(); }
      });
    }));
    actions.appendChild(btn("Cancel", "btn-quiet", function () { model.planning = null; render(); }));
    box.appendChild(actions);
    return box;
  }

  // Puts one slot into a week's plan (reading the week first so nothing else in it is lost).
  function saveSlot(week, day, slot, value) {
    return call("GET", "/kitchen/week?week=" + encodeURIComponent(week)).then(function (r) {
      if (r.status !== 200) { failed(r); return false; }
      var days = r.body.plan.days;
      days[day][slot] = value;
      return call("POST", "/kitchen/plan", { week: week, days: days }).then(function (p) {
        if (p.status !== 200) { failed(p); return false; }
        if (p.body.week === model.week) applyView(p.body);
        return true;
      });
    });
  }

  function renderEditForm(root) {
    var ed = model.editing, r = ed.recipe;
    var form = h("form", "kt-form");
    form.appendChild(btn("‹ Back", "btn-sm btn-quiet", function () { model.editing = null; render(); }));
    form.appendChild(h("h2", null, ed.isNew ? "New recipe" : "Edit " + r.title));
    var title = h("input"); title.type = "text"; title.maxLength = 120; title.required = true; title.value = r ? r.title : "";
    form.appendChild(labelled("Title", title));
    var row = h("div", "row");
    var servings = h("input"); servings.type = "number"; servings.min = "1"; servings.max = "100"; servings.value = String(r ? r.servings : 4);
    var prep = h("input"); prep.type = "number"; prep.min = "0"; prep.max = "1440"; prep.value = String(r ? r.prepMin : 0);
    var cook = h("input"); cook.type = "number"; cook.min = "0"; cook.max = "1440"; cook.value = String(r ? r.cookMin : 0);
    var rating = h("select"); [0, 1, 2, 3, 4, 5].forEach(function (n) { rating.appendChild(option(String(n), n ? n + " star" + (n > 1 ? "s" : "") : "Not rated", (r ? r.rating : 0) === n)); });
    row.appendChild(labelled("Serves", servings)); row.appendChild(labelled("Prep (min)", prep)); row.appendChild(labelled("Cook (min)", cook)); row.appendChild(labelled("Rating", rating));
    form.appendChild(row);
    var tags = h("input"); tags.type = "text"; tags.placeholder = "quick, dinner, vegetarian"; tags.value = r ? r.tags.join(", ") : "";
    form.appendChild(labelled("Tags (comma separated, up to 8)", tags));
    var ing = h("textarea"); ing.rows = 9; ing.placeholder = "2 tbsp olive oil\n200 g plain flour\n1 onion, finely chopped";
    ing.value = r ? r.ingredients.map(ingredientLine).join("\n") : "";
    form.appendChild(labelled("Ingredients (one per line: amount, unit, then the name)", ing));
    var steps = h("textarea"); steps.rows = 8; steps.value = r ? r.steps.join("\n") : "";
    form.appendChild(labelled("Method (one step per line)", steps));
    var notes = h("textarea"); notes.rows = 3; notes.value = r ? r.notes : "";
    form.appendChild(labelled("Cook's notes", notes));
    var source = h("input"); source.type = "text"; source.maxLength = 200; source.placeholder = "Where it came from (a name, a book, a website)"; source.value = r ? r.source : "";
    form.appendChild(labelled("Source", source));
    var actions = h("div", "kt-actions");
    var save = h("button", "btn btn-primary", ed.isNew ? "Save recipe" : "Save changes"); save.type = "submit";
    actions.appendChild(save);
    actions.appendChild(btn("Cancel", "btn-quiet", function () { model.editing = null; render(); }));
    form.appendChild(actions);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var body = { title: title.value, servings: Number(servings.value) || 0, prepMin: Number(prep.value) || 0, cookMin: Number(cook.value) || 0, rating: Number(rating.value) || 0, tags: tags.value, ingredients: ing.value, steps: steps.value, notes: notes.value, source: source.value };
      if (!ed.isNew) body.id = r.id;
      save.disabled = true;
      call("POST", "/kitchen/recipe", body).then(function (res) {
        save.disabled = false;
        if (res.status !== 200 && res.status !== 201) { failed(res); return; }
        flash("Saved " + res.body.recipe.title + ".", "ok");
        model.editing = null; model.recipe = res.body.recipe; model.openId = res.body.recipe.id; model.servings = res.body.recipe.servings;
        loadRecipes().then(function () { setHash("recipes", res.body.recipe.id); render(); });
      });
    });
    root.appendChild(form);
  }

  // ---- cooking mode ----------------------------------------------------------------------------------------------------------

  function startCooking() {
    var r = model.recipe;
    if (!r) return;
    model.cook = { step: 0, showIngredients: false, timers: [], title: document.title, lock: null };
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request("screen").then(function (l) { if (model.cook) model.cook.lock = l; else l.release(); }, function () { /* not allowed: fine */ });
    model.cook.tick = setInterval(cookTick, 1000);
    renderCook();
  }
  function stopCooking() {
    var c = model.cook;
    if (!c) return;
    clearInterval(c.tick);
    if (c.lock && c.lock.release) c.lock.release();
    document.title = c.title;
    model.cook = null;
    var o = $("kt-cook"); if (o && o.parentNode) o.parentNode.removeChild(o);
  }
  function cookTick() {
    var c = model.cook;
    if (!c) return;
    var now = Date.now(), finished = false;
    c.timers.forEach(function (t) { if (!t.done && now >= t.end) { t.done = true; finished = true; } });
    if (finished) { document.title = "Time's up · " + c.title; if (navigator.vibrate) navigator.vibrate([300, 150, 300]); }
    paintTimers();
  }
  function paintTimers() {
    var c = model.cook, box = $("kt-timers");
    if (!c || !box) return;
    clear(box);
    var now = Date.now();
    c.timers.forEach(function (t, i) {
      var left = Math.max(0, Math.round((t.end - now) / 1000));
      var span = h("span", "kt-timer" + (t.done ? " done" : ""), t.done ? t.label + ": time's up" : t.label + " " + L.clock(left));
      box.appendChild(span);
      box.appendChild(btn(t.done ? "Dismiss" : "Stop", "btn-sm btn-quiet", function () { c.timers.splice(i, 1); if (!c.timers.some(function (x) { return x.done; })) document.title = c.title; paintTimers(); }));
    });
  }
  function renderCook() {
    var c = model.cook, r = model.recipe;
    if (!c || !r) return;
    var old = $("kt-cook"); if (old && old.parentNode) old.parentNode.removeChild(old);
    var o = h("div", "kt-cook"); o.id = "kt-cook"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true"); o.setAttribute("aria-label", "Cooking mode: " + r.title);
    var top = h("div", "kt-cook-top");
    top.appendChild(h("b", null, r.title));
    var topBtns = h("div", "kt-actions");
    topBtns.appendChild(btn(c.showIngredients ? "Show the step" : "Ingredients", "", function () { c.showIngredients = !c.showIngredients; renderCook(); }));
    topBtns.appendChild(btn("Close", "btn-primary", stopCooking));
    top.appendChild(topBtns);
    o.appendChild(top);
    var mid = h("div");
    if (c.showIngredients || !r.steps.length) {
      var ul = h("ul", "kt-cook-ings");
      L.scaledIngredients(r, model.servings).forEach(function (i) { ul.appendChild(h("li", null, i.text)); });
      mid.appendChild(ul);
    } else {
      var text = r.steps[c.step];
      mid.appendChild(h("p", "kt-cook-step" + (text.length > 140 ? " wide" : ""), text));
      var timers = L.parseStepTimers(text);
      if (timers.length) {
        var tb = h("div", "kt-actions");
        timers.forEach(function (t) { tb.appendChild(btn("Start a " + t.label + " timer", "", function () { c.timers.push({ label: t.label, end: Date.now() + t.seconds * 1000, done: false }); paintTimers(); })); });
        mid.appendChild(tb);
      }
    }
    o.appendChild(mid);
    var bottom = h("div", "kt-cook-bottom");
    bottom.appendChild(btn("‹ Back", "", function () { if (c.step > 0) { c.step--; renderCook(); } }));
    bottom.appendChild(h("span", "kt-cook-count", r.steps.length ? "Step " + (c.step + 1) + " of " + r.steps.length : ""));
    var timersBox = h("div", "kt-timers"); timersBox.id = "kt-timers";
    bottom.appendChild(timersBox);
    bottom.appendChild(btn(c.step >= r.steps.length - 1 ? "Done" : "Next ›", "btn-primary", function () { if (c.step >= r.steps.length - 1) stopCooking(); else { c.step++; renderCook(); } }));
    o.appendChild(bottom);
    document.body.appendChild(o);
    paintTimers();
  }

  // ---- the plan --------------------------------------------------------------------------------------------------------------

  function renderPlan(root) {
    var v = model.view;
    var top = h("div", "kt-bar");
    top.appendChild(weekNav(render));
    var counts = L.planCounts(v.plan);
    top.appendChild(h("span", "dim", counts.planned ? counts.planned + " meals planned, " + counts.recipes + " from recipes" : "Nothing planned yet"));
    top.appendChild(btn("Copy the week before", "btn-sm", function () {
      if (counts.planned && !window.confirm("This week already has meals. Replace them with last week's?")) return;
      call("POST", "/kitchen/plan/copy", { from: L.addDays(model.week, -7), to: model.week }).then(function (r) {
        if (r.status !== 200) { failed(r); return; }
        applyView(r.body); flash("Copied last week's plan.", "ok"); render();
      });
    }));
    top.appendChild(btn("Shopping list ›", "btn-sm btn-primary", function () { setHash("shop", ""); }));
    root.appendChild(top);
    var grid = h("div", "kt-week");
    L.DAYS.forEach(function (d) {
      var date = L.dateForDay(model.week, d);
      var card = h("div", "kt-day" + (date === v.today ? " today" : ""));
      var head = h("h3");
      head.appendChild(h("span", null, L.DAY_NAMES[d]));
      head.appendChild(h("span", "dim small", L.dayText(date).replace(/^\w+ /, "")));
      card.appendChild(head);
      L.SLOTS.forEach(function (s) {
        var slot = v.plan.days[d][s];
        var info = L.slotText(slot, v.titles);
        var row = h("div", "kt-slot");
        row.appendChild(h("span", "kt-slot-name", L.SLOT_NAMES[s]));
        var text = h("span", "kt-slot-text " + info.tone, info.text || "–");
        row.appendChild(text);
        row.appendChild(btn(slot ? "Change" : "Set", "btn-sm btn-quiet", function () {
          model.slotEdit = model.slotEdit && model.slotEdit.day === d && model.slotEdit.slot === s ? null : { day: d, slot: s };
          render();
        }));
        if (model.slotEdit && model.slotEdit.day === d && model.slotEdit.slot === s) row.appendChild(slotEditor(d, s, slot));
        card.appendChild(row);
      });
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  function slotEditor(day, slotName, slot) {
    var box = h("div", "kt-slot-edit");
    var kind = h("select"); kind.setAttribute("aria-label", "What is for " + slotName);
    L.KINDS.forEach(function (k) { kind.appendChild(option(k[0], k[1], (slot ? slot.kind : "") === k[0])); });
    var recipe = h("select"); recipe.setAttribute("aria-label", "Recipe");
    model.recipes.slice().sort(function (a, b) { return a.title.localeCompare(b.title); }).forEach(function (r) { recipe.appendChild(option(r.id, r.title, slot && slot.recipeId === r.id)); });
    var serv = h("input"); serv.type = "number"; serv.min = "1"; serv.max = "100"; serv.placeholder = "Servings"; serv.value = slot && slot.servings ? String(slot.servings) : ""; serv.setAttribute("aria-label", "Servings");
    var note = h("input"); note.type = "text"; note.maxLength = 120; note.placeholder = "A note"; note.value = slot && slot.note ? slot.note : ""; note.setAttribute("aria-label", "Note");
    var fields = h("div", "kt-bar");
    function sync() {
      recipe.hidden = kind.value !== "recipe"; serv.hidden = kind.value !== "recipe";
      note.hidden = !(kind.value === "note" || kind.value === "out" || kind.value === "leftovers");
    }
    kind.addEventListener("change", sync);
    fields.appendChild(kind); fields.appendChild(recipe); fields.appendChild(serv); fields.appendChild(note);
    box.appendChild(fields);
    var actions = h("div", "kt-actions");
    actions.appendChild(btn("Save", "btn-sm btn-primary", function () {
      var value = null;
      if (kind.value === "recipe") {
        if (!recipe.value) { flash("Pick a recipe first, or add one on the Recipes tab.", "alert"); return; }
        value = { kind: "recipe", recipeId: recipe.value };
        var n = parseInt(serv.value, 10); if (n >= 1 && n <= 100) value.servings = n;
      } else if (kind.value) {
        value = { kind: kind.value };
        if (note.value.trim()) value.note = note.value.trim();
        else if (kind.value === "note") { flash("Type the note.", "alert"); return; }
      }
      saveSlot(model.week, day, slotName, value).then(function (ok) { if (ok) { model.slotEdit = null; flash(""); render(); } });
    }));
    actions.appendChild(btn("Cancel", "btn-sm btn-quiet", function () { model.slotEdit = null; render(); }));
    box.appendChild(actions);
    sync();
    return box;
  }

  // ---- the shopping list ------------------------------------------------------------------------------------------------------

  function renderShop(root) {
    var v = model.view, sh = v.shopping;
    var top = h("div", "kt-bar");
    top.appendChild(weekNav(render));
    top.appendChild(h("span", "dim", L.toBuyLine(sh.counts.toBuy) + (sh.counts.done ? " " + sh.counts.done + " ticked." : "")));
    var shopped = btn("I have shopped", "btn-sm btn-primary", function () {
      call("POST", "/kitchen/list/stock", { week: model.week }).then(function (r) {
        if (r.status !== 200) { failed(r); return; }
        applyView(r.body); flash("The ticked lines are in the pantry.", "ok"); render();
      });
    });
    shopped.disabled = !sh.groups.some(function (g) { return g.lines.some(function (l) { return l.done; }); });
    top.appendChild(shopped);
    root.appendChild(top);
    if (sh.missing && sh.missing.length) root.appendChild(h("p", "kt-warn", sh.missing.length + " planned recipe" + (sh.missing.length > 1 ? "s were" : " was") + " deleted, so its ingredients are not on the list."));

    var add = h("form", "kt-add");
    var text = h("input"); text.type = "text"; text.maxLength = 80; text.placeholder = "Add something by hand"; text.setAttribute("aria-label", "Add to the list");
    var aisle = h("select"); aisle.setAttribute("aria-label", "Aisle");
    aisle.appendChild(option("", "Aisle: guess"));
    L.AISLES.forEach(function (a) { aisle.appendChild(option(a, a)); });
    add.appendChild(text); add.appendChild(aisle);
    var addBtn = h("button", "btn", "Add"); addBtn.type = "submit"; add.appendChild(addBtn);
    add.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!text.value.trim()) return;
      var body = { week: model.week, text: text.value }; if (aisle.value) body.aisle = aisle.value;
      call("POST", "/kitchen/list/add", body).then(function (r) { if (r.status !== 200) { failed(r); return; } applyView(r.body); flash(""); render(); });
    });
    root.appendChild(add);

    if (!sh.groups.length) { root.appendChild(h("div", "kt-empty", "Nothing to buy. Plan some meals on the Meal plan tab, or add a line by hand above.")); return; }
    var groups = h("div", "kt-groups");
    sh.groups.forEach(function (g) {
      var sec = h("section", "kt-group");
      sec.appendChild(h("h3", null, g.aisle));
      g.lines.forEach(function (l) {
        var row = h("div", "kt-line" + (l.done ? " done" : ""));
        var cb = h("input"); cb.type = "checkbox"; cb.checked = !!l.done; cb.setAttribute("aria-label", l.text);
        cb.addEventListener("change", function () {
          l.done = cb.checked; cb.disabled = true;
          call("POST", "/kitchen/list/tick", { week: model.week, key: l.key, done: cb.checked }).then(function (r) {
            if (r.status !== 200) { failed(r); loadWeek(model.week).then(render); return; }
            applyView(r.body); render();
          });
        });
        row.appendChild(cb);
        var tx = h("span", "kt-line-text", l.text);
        if (l.from && l.from.length) tx.appendChild(h("span", "dim small", "  for " + l.from.join(", ")));
        row.appendChild(tx);
        if (l.manual) row.appendChild(btn("Remove", "btn-sm btn-quiet", function () {
          call("POST", "/kitchen/list/remove", { week: model.week, id: l.id }).then(function (r) { if (r.status !== 200) { failed(r); return; } applyView(r.body); render(); });
        }));
        else row.appendChild(h("span"));
        sec.appendChild(row);
      });
      groups.appendChild(sec);
    });
    root.appendChild(groups);
    root.appendChild(h("p", "dim small", "Aisles are a guess from the name. The pantry has been taken off; out-of-date stock does not count."));
  }

  // ---- the pantry --------------------------------------------------------------------------------------------------------------

  function renderPantry(root) {
    var v = model.view;
    if (!model.pantryDraft) model.pantryDraft = L.sortPantry(v.pantry.items).map(function (i) { return { id: i.id, name: i.name, q: i.q, unit: i.unit, bestBefore: i.bestBefore, note: i.note }; });
    var draft = model.pantryDraft;

    if (v.useSoon.length) {
      var soon = h("div", "kt-panel");
      soon.appendChild(h("h3", null, "Use soon"));
      var ul = h("ul", "kt-soon");
      v.useSoon.forEach(function (s) { ul.appendChild(h("li", L.pantryTone(s.daysLeft), s.name + ": " + L.bestBeforeText(s.daysLeft).toLowerCase())); });
      soon.appendChild(ul);
      if (v.suggestions.length) {
        soon.appendChild(h("h3", null, "Recipes that would use it"));
        var row = h("div", "kt-actions");
        v.suggestions.forEach(function (s) { row.appendChild(btn(s.title + " (" + s.uses.join(", ") + ")", "btn-sm", function () { setHash("recipes", s.id); })); });
        soon.appendChild(row);
      }
      root.appendChild(soon);
    }

    var wrap = h("div", "kt-pantry");
    var rows = h("div"); rows.className = "kt-pantry";
    function paintRows() {
      clear(rows);
      if (!draft.length) rows.appendChild(h("div", "kt-empty", "The pantry is empty. Add what is in the house, or press I have shopped on the Shopping list."));
      draft.forEach(function (it, idx) {
        var r = h("div", "kt-pantry-row");
        var name = h("input"); name.type = "text"; name.maxLength = 80; name.value = it.name; name.placeholder = "Item"; name.setAttribute("aria-label", "Item name");
        name.addEventListener("input", function () { it.name = name.value; });
        var q = h("input"); q.type = "number"; q.min = "0"; q.step = "any"; q.value = it.q === null || it.q === undefined ? "" : String(it.q); q.placeholder = "Plenty"; q.setAttribute("aria-label", "Quantity");
        q.addEventListener("input", function () { it.q = q.value === "" ? null : Number(q.value); });
        var unit = h("select"); unit.setAttribute("aria-label", "Unit");
        L.UNITS.forEach(function (u) { unit.appendChild(option(u, u || "(count)", it.unit === u)); });
        unit.addEventListener("change", function () { it.unit = unit.value; });
        var bb = h("input"); bb.type = "date"; bb.value = it.bestBefore || ""; bb.setAttribute("aria-label", "Best before");
        bb.addEventListener("input", function () { it.bestBefore = bb.value; });
        var note = h("input"); note.type = "text"; note.maxLength = 80; note.value = it.note || ""; note.placeholder = "Note"; note.setAttribute("aria-label", "Note"); note.className = "full";
        note.addEventListener("input", function () { it.note = note.value; });
        var rm = btn("Remove", "btn-sm btn-quiet", function () { draft.splice(idx, 1); paintRows(); });
        r.appendChild(name); r.appendChild(q); r.appendChild(unit); r.appendChild(bb); r.appendChild(note); r.appendChild(rm);
        rows.appendChild(r);
      });
    }
    paintRows();
    wrap.appendChild(rows);
    var actions = h("div", "kt-actions");
    actions.appendChild(btn("Add an item", "", function () { draft.push({ name: "", q: null, unit: "", bestBefore: "", note: "" }); paintRows(); }));
    var save = btn("Save the pantry", "btn-primary", function () {
      save.disabled = true;
      var items = draft.filter(function (i) { return i.name.trim(); }).map(function (i) { var o = { name: i.name.trim(), q: i.q, unit: i.unit, bestBefore: i.bestBefore, note: i.note }; if (i.id) o.id = i.id; return o; });
      call("POST", "/kitchen/pantry", { items: items }).then(function (r) {
        save.disabled = false;
        if (r.status !== 200) { failed(r); return; }
        flash("Saved the pantry.", "ok");
        loadWeek(model.week).then(render);
      });
    });
    actions.appendChild(save);
    wrap.appendChild(actions);
    root.appendChild(wrap);
  }

  // ---- render and boot ---------------------------------------------------------------------------------------------------------

  function message(text) { var box = $("kt-root"); clear(box); box.appendChild(h("p", "kt-off", text)); }

  function render() {
    var root = $("kt-root");
    if (!root) return;
    renderTabs();
    if (model.state === "guest") { message("Sign in to use the Kitchen."); return; }
    if (model.state === "forbidden") { message("The Kitchen is only for the hub owner."); return; }
    if (model.state === "off") { message("The Kitchen is switched off. The Worker variable KITCHEN_ENABLED is 0."); return; }
    if (model.state === "error") { message("Could not reach the Worker. Reload the page to try again."); return; }
    if (model.state === "loading" || !model.view) return;
    clear(root);
    if (model.tab === "recipes") renderRecipes(root);
    else if (model.tab === "plan") renderPlan(root);
    else if (model.tab === "shop") renderShop(root);
    else renderPantry(root);
  }

  function boot() {
    renderTabs();
    window.addEventListener("hashchange", function () { flash(""); route(); });
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) { model.state = "guest"; render(); return; }
      Promise.all([loadRecipes(), loadWeek("")]).then(function () { route(); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
