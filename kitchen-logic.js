// The Kitchen page's wording and small rules, with no DOM and no network (kitchen.js and tile-kitchen.js use them; test/kitchen.test.js covers them).
//
// The Worker (ClaudeRepo's cloudflare-worker/src/kitchen-logic.js) does the real work: it reads ingredient lines, merges the shopping list and
// takes the pantry off it. This file only turns what it sends into words and handles what the page needs by itself: scaling a recipe on the
// screen, the unit and fraction wording (kept in step with the Worker's: test/kitchen.test.js uses the same cases), the cooking-mode timers,
// the recipe search and the week arithmetic.
//
// Browser: window.BarnyardKitchenLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  var SLOTS = ["breakfast", "lunch", "dinner"];
  var SLOT_NAMES = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
  var KINDS = [["", "Nothing"], ["recipe", "A recipe"], ["leftovers", "Leftovers"], ["out", "Eating out"], ["note", "A note"]];
  var AISLES = ["Fruit and veg", "Meat and fish", "Dairy and eggs", "Bakery", "Dry goods", "Tins and jars", "Sauces and spices", "Frozen", "Drinks", "Other"];
  var UNITS = ["", "g", "kg", "ml", "l", "tsp", "tbsp", "cup", "clove", "can", "tin", "bunch", "pinch", "slice", "packet", "pack", "jar", "stalk", "sprig", "piece", "head"];
  var COUNT_UNITS = ["clove", "can", "tin", "bunch", "pinch", "slice", "packet", "pack", "jar", "stalk", "sprig", "piece", "head"];

  // ---- numbers and words (the same rules as the Worker's) ---------------------------------------------------------------------------

  function niceUnit(q, unit) {
    if (q === null || q === undefined) return { q: null, unit: unit };
    if (unit === "g" && q >= 1000) return { q: q / 1000, unit: "kg" };
    if (unit === "kg" && q < 1) return { q: q * 1000, unit: "g" };
    if (unit === "ml" && q >= 1000) return { q: q / 1000, unit: "l" };
    if (unit === "l" && q < 1) return { q: q * 1000, unit: "ml" };
    if (unit === "tsp" && q >= 4) return { q: q / 4, unit: "tbsp" };
    return { q: q, unit: unit };
  }

  // 1.5 -> "1½", 0.333 -> "⅓", 2 -> "2", 2.2 -> "2.2"
  function formatQuantity(q) {
    if (q === null || q === undefined || !isFinite(q)) return "";
    if (q <= 0) return "0";
    var steps = [[0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"], [1, ""]];
    var whole = Math.floor(q + 1e-9);
    var frac = q - whole;
    for (var i = 0; i < steps.length; i++) {
      if (Math.abs(frac - steps[i][0]) < 0.02) {
        if (steps[i][0] === 1) return String(whole + 1);
        return whole ? whole + steps[i][1] : steps[i][1] || "0";
      }
    }
    return String(Math.round(q * 10) / 10);
  }

  function unitLabel(unit, q) {
    if (!unit) return "";
    var many = q !== null && q !== undefined && q > 1;
    if (COUNT_UNITS.indexOf(unit) !== -1) return many ? (unit === "pinch" ? "pinches" : unit === "bunch" ? "bunches" : unit + "s") : unit;
    if (unit === "cup") return many ? "cups" : "cup";
    return unit === "l" ? "L" : unit;
  }

  // One ingredient { q, unit, name, note }, scaled: "3 tbsp olive oil", "1 clove garlic, crushed".
  function formatIngredient(ing, factor) {
    var f = factor === undefined ? 1 : factor;
    var q = ing.q === null || ing.q === undefined ? null : ing.q * f, unit = ing.unit || "";
    if (q !== null) { var n = niceUnit(q, unit); q = n.q; unit = n.unit; }
    var parts = [];
    if (q !== null) parts.push(formatQuantity(q));
    if (unit) parts.push(unitLabel(unit, q));
    parts.push(ing.name);
    var text = parts.filter(Boolean).join(" ");
    return ing.note ? text + ", " + ing.note : text;
  }

  // A recipe at another number of servings: [{ text, ... }] in the order the recipe lists them.
  function scaledIngredients(recipe, servings) {
    var factor = servings / recipe.servings;
    return recipe.ingredients.map(function (i) { return { text: formatIngredient(i, factor), q: i.q, unit: i.unit, name: i.name, note: i.note }; });
  }

  // The servings stepper: one at a time up to 12, then in twos, never below 1 or above 100.
  function stepServings(current, direction) {
    var step = current >= 12 ? 2 : 1;
    var next = direction > 0 ? current + step : current - (current > 12 ? 2 : 1);
    return Math.max(1, Math.min(100, next));
  }

  // ---- cooking mode -----------------------------------------------------------------------------------------------------------------

  // "Simmer for 10-15 minutes, then rest 2 hours" -> [{ label: "15 min", seconds: 900 }, { label: "2 hours", seconds: 7200 }]. A range uses the longer time.
  function parseStepTimers(text) {
    var out = [];
    var re = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;
    var m;
    while ((m = re.exec(String(text || ""))) !== null) {
      var n = Math.max(Number(m[1]), m[2] ? Number(m[2]) : 0);
      var u = m[3].toLowerCase();
      var seconds = u.charAt(0) === "h" ? n * 3600 : u.charAt(0) === "m" ? n * 60 : n;
      if (seconds > 0 && seconds <= 86400) out.push({ label: timerLabel(n, u.charAt(0)), seconds: Math.round(seconds) });
      if (out.length >= 4) break;
    }
    return out;
  }
  function timerLabel(n, kind) {
    var num = formatQuantity(n);
    if (kind === "h") return num + (n === 1 ? " hour" : " hours");
    if (kind === "m") return num + " min";
    return num + " sec";
  }

  // 754 -> "12:34", 3725 -> "1:02:05", 0 -> "0:00"
  function clock(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var two = function (n) { return (n < 10 ? "0" : "") + n; };
    return h ? h + ":" + two(m) + ":" + two(r) : m + ":" + two(r);
  }

  // ---- recipes ------------------------------------------------------------------------------------------------------------------------

  // The recipe cards for a search and a tag: newest edit first as the Worker sends them, or best rated first.
  function filterRecipes(index, query, tag, sort) {
    var q = String(query || "").trim().toLowerCase();
    var out = (index || []).filter(function (r) {
      if (tag && (r.tags || []).indexOf(tag) === -1) return false;
      if (!q) return true;
      if (String(r.title || "").toLowerCase().indexOf(q) !== -1) return true;
      return (r.keys || []).some(function (k) { return k.indexOf(q) !== -1; }) || (r.tags || []).some(function (t) { return t.indexOf(q) !== -1; });
    });
    if (sort === "rating") out = out.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0) || String(a.title).localeCompare(String(b.title)); });
    else if (sort === "title") out = out.slice().sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    return out;
  }

  // Every tag in use with how many recipes carry it, most used first.
  function tagCounts(index) {
    var counts = {};
    (index || []).forEach(function (r) { (r.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
    return Object.keys(counts).map(function (t) { return { tag: t, n: counts[t] }; }).sort(function (a, b) { return b.n - a.n || a.tag.localeCompare(b.tag); });
  }

  function stars(n) {
    var r = Math.max(0, Math.min(5, Math.round(n || 0)));
    return r ? new Array(r + 1).join("★") + new Array(6 - r).join("☆") : "";
  }

  function minutesText(prep, cook) {
    var total = (prep || 0) + (cook || 0);
    if (!total) return "";
    if (total < 60) return total + " min";
    var h = Math.floor(total / 60), m = total % 60;
    return h + " h" + (m ? " " + m + " min" : "");
  }

  // ---- the week -----------------------------------------------------------------------------------------------------------------------

  function dateOf(text) { return new Date(Date.parse(text + "T00:00:00Z")); }
  function isoOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(text, n) { return isoOf(Date.parse(text + "T00:00:00Z") + n * 86400000); }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // "Mon 26 Oct"
  function dayText(text) { var d = dateOf(text); return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
  // "26 Oct - 1 Nov", and a leading word for this week and the next
  function weekLabel(week, thisWeek) {
    var end = addDays(week, 6), a = dateOf(week), b = dateOf(end);
    var span = a.getUTCDate() + " " + MONTHS[a.getUTCMonth()] + " – " + b.getUTCDate() + " " + MONTHS[b.getUTCMonth()];
    if (week === thisWeek) return "This week, " + span;
    if (week === addDays(thisWeek, 7)) return "Next week, " + span;
    if (week === addDays(thisWeek, -7)) return "Last week, " + span;
    return span;
  }
  function dateForDay(week, dayKey) { return addDays(week, Math.max(0, DAYS.indexOf(dayKey))); }

  // What a plan slot says: { text, tone } for a { kind, recipeId?, note? } or null.
  function slotText(slot, titles) {
    if (!slot) return { text: "", tone: "" };
    if (slot.kind === "recipe") {
      var t = titles && titles[slot.recipeId];
      return { text: t ? t + (slot.servings ? " (" + slot.servings + ")" : "") : "A recipe that was removed", tone: t ? "recipe" : "gone" };
    }
    if (slot.kind === "leftovers") return { text: "Leftovers" + (slot.note ? ": " + slot.note : ""), tone: "left" };
    if (slot.kind === "out") return { text: "Eating out" + (slot.note ? ": " + slot.note : ""), tone: "out" };
    return { text: slot.note || "Note", tone: "note" };
  }

  // How many meals are planned this week: { planned, recipes }.
  function planCounts(plan) {
    var planned = 0, recipes = 0;
    DAYS.forEach(function (d) { SLOTS.forEach(function (s) { var v = plan && plan.days && plan.days[d] && plan.days[d][s]; if (v) { planned++; if (v.kind === "recipe") recipes++; } }); });
    return { planned: planned, recipes: recipes };
  }

  // ---- the pantry ---------------------------------------------------------------------------------------------------------------------

  // "Out of date", "Today", "Tomorrow", "In 3 days", "" for none.
  function bestBeforeText(daysLeft) {
    if (daysLeft === null || daysLeft === undefined) return "";
    if (daysLeft < -1) return Math.abs(daysLeft) + " days out of date";
    if (daysLeft === -1) return "Out of date yesterday";
    if (daysLeft === 0) return "Best before today";
    if (daysLeft === 1) return "Best before tomorrow";
    return "In " + daysLeft + " days";
  }
  function daysUntil(dateText, todayText) {
    if (!dateText) return null;
    return Math.round((Date.parse(dateText + "T00:00:00Z") - Date.parse(todayText + "T00:00:00Z")) / 86400000);
  }
  function pantryTone(daysLeft) { return daysLeft === null ? "" : daysLeft < 0 ? "alert" : daysLeft <= 3 ? "attn" : ""; }

  function sortPantry(items) {
    return (items || []).slice().sort(function (a, b) {
      if (!!a.bestBefore !== !!b.bestBefore) return a.bestBefore ? -1 : 1;
      if (a.bestBefore !== b.bestBefore) return a.bestBefore < b.bestBefore ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  // The Overview tile's words from GET /kitchen/glance.
  function glanceLine(g) {
    if (!g) return "";
    var t = g.tonight;
    if (!t) return "Nothing planned for dinner tonight.";
    if (t.kind === "recipe") return "Tonight: " + t.title;
    if (t.kind === "leftovers") return "Tonight: leftovers";
    if (t.kind === "out") return "Tonight: eating out" + (t.note ? " (" + t.note + ")" : "");
    return "Tonight: " + (t.note || "a note");
  }
  function toBuyLine(n) { return !n ? "Nothing left to buy this week." : n === 1 ? "1 thing left to buy." : n + " things left to buy."; }

  // ---- errors in plain words ------------------------------------------------------------------------------------------------------------

  var ERRORS = {
    title_required: "Give the recipe a title.", ingredients_required: "Add at least one ingredient, one per line.", servings_invalid: "Servings must be a whole number from 1 to 100.",
    minutes_invalid: "Minutes must be a whole number from 0 to 1440.", rating_invalid: "The rating is 0 to 5.", too_many_tags: "A recipe can have up to 8 tags.",
    too_many_ingredients: "A recipe can have up to 60 ingredients.", too_many_steps: "A recipe can have up to 40 steps.", recipe_too_large: "That recipe is too long to keep.",
    unit_invalid: "That unit is not one the Kitchen knows (try g, kg, ml, l, tsp, tbsp or cup).", quantity_invalid: "A quantity must be a number above zero.",
    recipes_full: "The Kitchen holds up to 300 recipes: delete one first.", list_full: "The list holds up to 100 hand-added lines.", too_many_items: "The pantry holds up to 400 items.",
    name_required: "Every pantry item needs a name.", date_invalid: "That date is not a real date.", text_required: "Type what to add.", pantry_too_large: "The pantry is too long to keep.",
    secret_detected: "That looks like a password or key, so it was not saved.", recent_sign_in_required: "Sign in again, then try once more.",
    unauthenticated: "Sign in to use the Kitchen.", forbidden: "The Kitchen is the owner's only.", kitchen_disabled: "The Kitchen is switched off on the Worker.",
    not_found: "That is not there any more.", nothing_to_copy: "There is no plan on that week to copy.", rate_limited: "Too many requests: wait a moment.",
    "request body too large": "That is too long to save.", line_unknown: "That line has changed: reload and try again.", list_too_large: "The list is too long to keep.",
    week_invalid: "That week is not a Monday's date.", recipe_invalid: "Pick a recipe from the list."
  };
  function errorText(body, status) {
    var code = body && body.error;
    if (code && ERRORS[code]) return ERRORS[code];
    if (status === 0) return "Could not reach the Worker: check the connection and try again.";
    if (status === 401) return ERRORS.unauthenticated;
    if (status === 403) return ERRORS.forbidden;
    if (status === 429) return ERRORS.rate_limited;
    return "That did not work (" + (code || status || "no answer") + ").";
  }

  var api = {
    DAYS: DAYS, DAY_NAMES: DAY_NAMES, SLOTS: SLOTS, SLOT_NAMES: SLOT_NAMES, KINDS: KINDS, AISLES: AISLES, UNITS: UNITS,
    niceUnit: niceUnit, formatQuantity: formatQuantity, unitLabel: unitLabel, formatIngredient: formatIngredient, scaledIngredients: scaledIngredients, stepServings: stepServings,
    parseStepTimers: parseStepTimers, clock: clock, filterRecipes: filterRecipes, tagCounts: tagCounts, stars: stars, minutesText: minutesText,
    addDays: addDays, dayText: dayText, weekLabel: weekLabel, dateForDay: dateForDay, slotText: slotText, planCounts: planCounts,
    bestBeforeText: bestBeforeText, daysUntil: daysUntil, pantryTone: pantryTone, sortPantry: sortPantry, glanceLine: glanceLine, toBuyLine: toBuyLine, errorText: errorText
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardKitchenLogic = api;
})(typeof window !== "undefined" ? window : this);
