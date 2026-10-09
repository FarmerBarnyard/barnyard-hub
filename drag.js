// Drag and drop for the hub: moving an Ops board tile to another lane, and rearranging the
// Overview's widgets. One small, dependency-free module built on pointer events, so the same
// code handles a mouse, a pen and a finger (a touch needs a short press-and-hold, so a swipe
// still scrolls the page).
//
//   BarnyardDrag.attach({
//     root,            the stable element that contains everything (events are delegated)
//     item,            selector for what can be picked up
//     handle,          optional selector inside an item: when given, only the handle starts a drag
//     zone,            selector for what can be dropped on
//     canDrag(el),     optional: may this item be picked up now?
//     canDrop(el, z),  optional: may this item go on this zone?
//     onDrop(el, z),   called once, on release over an allowed zone
//   }) -> { destroy() }
//
// It never moves the page's own elements: it shows a floating copy and marks the zone under it
// (.drop-ok / .drop-no); the page decides what a drop means and redraws. Escape cancels. The click
// that follows a drag is swallowed so a drop never also opens the item. Everything is built with
// DOM calls and CSS classes (no innerHTML, no style attributes), so it fits the site's CSP.
//
// The pure helpers are exported for tests and shared by the pages: reorder (a new list order
// after dropping one entry on another), neighbour (the next visible entry in a direction) and
// adjacentLane (the lane left or right of this one).
//
// A mouse or pen drag starts after a few pixels of movement; a touch starts after a short hold.
// Keyboard users are not left out: the pages offer arrow-key moves on the same items.

(function (root) {
  "use strict";

  var MOVE_THRESHOLD = 6;     // pixels before a mouse or pen press becomes a drag
  var HOLD_MS = 350;          // how long a finger rests before it picks something up
  var HOLD_SLOP = 10;         // how far a finger may wander during the hold before it is a scroll
  var EDGE = 56;              // distance from the top/bottom of the window that scrolls it
  var SCROLL_STEP = 16;

  // ---- pure helpers ---------------------------------------------------------

  // Distance test used to tell a click from a drag.
  function exceeds(dx, dy, limit) { return dx * dx + dy * dy >= limit * limit; }

  // The entries after picking up `fromId` and dropping it on `toId`: it takes the place of the
  // one it was dropped on (so moving down lands after it, moving up lands before it). Entries are
  // objects with an `id`. Returns the same array contents when nothing would change.
  function reorder(list, fromId, toId) {
    var from = -1, to = -1, i;
    for (i = 0; i < list.length; i++) { if (list[i].id === fromId) from = i; if (list[i].id === toId) to = i; }
    if (from < 0 || to < 0 || from === to) return list.slice();
    var out = list.slice();
    var moved = out.splice(from, 1)[0];
    out.splice(to, 0, moved);
    return out;
  }

  // The entry next to `id` in direction dir (-1 or 1) that is shown, or null at the end.
  function neighbour(list, id, dir, isShown) {
    var at = -1, i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) at = i;
    if (at < 0) return null;
    for (i = at + dir; i >= 0 && i < list.length; i += dir) if (!isShown || isShown(list[i])) return list[i];
    return null;
  }

  // The lane key one step left or right of `current` in the ordered `keys`, or null at the ends.
  function adjacentLane(keys, current, dir) {
    var i = keys.indexOf(current);
    if (i < 0) return null;
    var j = i + dir;
    return j >= 0 && j < keys.length ? keys[j] : null;
  }

  var helpers = { exceeds: exceeds, reorder: reorder, neighbour: neighbour, adjacentLane: adjacentLane, MOVE_THRESHOLD: MOVE_THRESHOLD, HOLD_MS: HOLD_MS };

  // ---- the behaviour (browser only) -------------------------------------------

  function attach(opts) {
    var doc = opts.root.ownerDocument, win = doc.defaultView;
    var press = null;      // a button is down: {id, el, x, y, type, timer}
    var drag = null;       // a drag is under way: {el, ghost, grabX, grabY, zone, ok, scrollTimer, lastX, lastY}

    function itemFrom(target) {
      if (!target || !target.closest) return null;
      var handle = opts.handle ? target.closest(opts.handle) : null;
      if (opts.handle && !handle) return null;
      var el = target.closest(opts.item);
      return el && opts.root.contains(el) ? el : null;
    }

    function clearZone() {
      if (drag && drag.zone) drag.zone.classList.remove("drop-ok", "drop-no");
      if (drag) drag.zone = null;
    }

    function zoneAt(x, y) {
      var hit = doc.elementFromPoint(x, y);
      var z = hit && hit.closest ? hit.closest(opts.zone) : null;
      return z && opts.root.contains(z) ? z : null;
    }

    function paint() {
      if (!drag) return;
      drag.ghost.style.setProperty("transform", "translate(" + (drag.lastX - drag.grabX) + "px, " + (drag.lastY - drag.grabY) + "px)");
      var z = zoneAt(drag.lastX, drag.lastY);
      if (z !== drag.zone) {
        clearZone();
        drag.zone = z;
        if (z) {
          drag.ok = z !== drag.el && (!opts.canDrop || !!opts.canDrop(drag.el, z));
          z.classList.add(drag.ok ? "drop-ok" : "drop-no");
        } else drag.ok = false;
      }
    }

    // Near the top or bottom edge the window scrolls so a far lane or widget can be reached.
    function autoScroll() {
      if (!drag) return;
      var dy = 0;
      if (drag.lastY < EDGE) dy = -SCROLL_STEP; else if (drag.lastY > win.innerHeight - EDGE) dy = SCROLL_STEP;
      if (dy) { win.scrollBy(0, dy); paint(); }
    }

    function begin(x, y) {
      var el = press.el, rect = el.getBoundingClientRect();
      var ghost = el.cloneNode(true);
      ghost.removeAttribute("id");
      ghost.setAttribute("aria-hidden", "true");
      ghost.setAttribute("tabindex", "-1");
      ghost.classList.add("drag-ghost");
      ghost.style.setProperty("width", rect.width + "px");
      ghost.style.setProperty("height", rect.height + "px");
      ghost.style.setProperty("left", rect.left + "px");
      ghost.style.setProperty("top", rect.top + "px");
      doc.body.appendChild(ghost);
      el.classList.add("is-dragging");
      doc.body.classList.add("drag-active");
      // The ghost starts exactly over the item and then moves by how far the pointer has moved
      // since the press, so grabX/grabY are the press position.
      drag = { el: el, ghost: ghost, grabX: press.x, grabY: press.y, zone: null, ok: false, lastX: x, lastY: y, scrollTimer: win.setInterval(autoScroll, 40) };
      paint();
    }

    function finish(drop) {
      var d = drag;
      if (press && press.timer) win.clearTimeout(press.timer);
      press = null;
      if (!d) return;
      drag = null;
      win.clearInterval(d.scrollTimer);
      if (d.zone) d.zone.classList.remove("drop-ok", "drop-no");
      d.el.classList.remove("is-dragging");
      doc.body.classList.remove("drag-active");
      if (d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
      // The click that follows a release over the item is swallowed, once.
      var swallow = function (e) { e.stopPropagation(); e.preventDefault(); };
      opts.root.addEventListener("click", swallow, true);
      win.setTimeout(function () { opts.root.removeEventListener("click", swallow, true); }, 0);
      if (drop && d.zone && d.ok && opts.onDrop) opts.onDrop(d.el, d.zone);
    }

    function onDown(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (!e.isPrimary) return;
      var el = itemFrom(e.target);
      if (!el || (opts.canDrag && !opts.canDrag(el))) return;
      press = { el: el, x: e.clientX, y: e.clientY, type: e.pointerType || "mouse", timer: null };
      if (press.type === "touch") {
        // A finger must rest for a moment first, so a swipe over a list still scrolls it.
        press.timer = win.setTimeout(function () { press.timer = null; begin(press.x, press.y); if (drag) { drag.lastX = press.x; drag.lastY = press.y; paint(); } }, HOLD_MS);
      }
    }

    function onMove(e) {
      if (!press && !drag) return;
      if (drag) {
        drag.lastX = e.clientX; drag.lastY = e.clientY;
        paint();
        if (e.cancelable) e.preventDefault();
        return;
      }
      var dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (press.type === "touch") {
        if (exceeds(dx, dy, HOLD_SLOP)) { win.clearTimeout(press.timer); press = null; }   // it is a scroll
        return;
      }
      if (exceeds(dx, dy, MOVE_THRESHOLD)) { begin(press.x, press.y); drag.lastX = e.clientX; drag.lastY = e.clientY; paint(); }
    }

    function onUp() { if (drag) finish(true); else if (press) { if (press.timer) win.clearTimeout(press.timer); press = null; } }
    function onCancel() { finish(false); }
    function onKey(e) { if (drag && e.key === "Escape") { e.preventDefault(); finish(false); } }
    // While a finger drags, the page must not scroll under it.
    function onTouchMove(e) { if (drag && e.cancelable) e.preventDefault(); }
    function onContext(e) { if (drag || (press && press.type === "touch")) e.preventDefault(); }
    function onDragStart(e) { if (itemFrom(e.target)) e.preventDefault(); }   // the browser's own image/link dragging stays out of the way

    opts.root.addEventListener("pointerdown", onDown);
    opts.root.addEventListener("dragstart", onDragStart);
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
    doc.addEventListener("pointercancel", onCancel);
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("touchmove", onTouchMove, { passive: false });
    doc.addEventListener("contextmenu", onContext);

    return {
      destroy: function () {
        finish(false);
        opts.root.removeEventListener("pointerdown", onDown);
        opts.root.removeEventListener("dragstart", onDragStart);
        doc.removeEventListener("pointermove", onMove);
        doc.removeEventListener("pointerup", onUp);
        doc.removeEventListener("pointercancel", onCancel);
        doc.removeEventListener("keydown", onKey, true);
        doc.removeEventListener("touchmove", onTouchMove);
        doc.removeEventListener("contextmenu", onContext);
      }
    };
  }

  var api = { attach: attach, helpers: helpers, reorder: reorder, neighbour: neighbour, adjacentLane: adjacentLane, exceeds: exceeds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardDrag = api;
})(typeof window !== "undefined" ? window : this);
