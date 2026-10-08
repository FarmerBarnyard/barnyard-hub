// Ops board: "Approve and run". The pieces that show and control an approved item's agent
// run, loaded by ops.html before ops.js.
//
// When a person approves a proposal they can ask their own Claude to do the work (see the
// Worker README, "Approve -> run an agent"). This file holds:
//   - pure helpers (chip wording, the message after an approval, which buttons apply)
//   - runBox(): the "Agent run" panel inside an item's drawer
//   - registerSettingsTab(): Settings, Agent runs (switch it on, paste your own routine's
//     address and token, forget it)
//   - loadConfig(): this board's masked settings, so the board knows whether to offer
//     "Approve and run"
//
// ctx = { request(method, path, body), toast(text), Shell } supplied by ops.js. Everything is
// built with textContent / createElement, never innerHTML (the page's CSP allows no inline
// script or style). The routine token is typed into a password field, sent once and never
// shown again; the Worker never returns it.

(function () {
  "use strict";

  var ACTIVE = { queued: true, fired: true, running: true };
  var MAX_ATTEMPTS = 3;

  // ---- 1. pure helpers (no DOM; tested in test/agent-runs.test.js) --------------------

  // The small label on a tile or in the drawer: { text, tone } where tone is "ok" | "warn" | "bad".
  function runChip(run) {
    if (!run) return null;
    if (run.status === "queued") {
      if (run.attempts > 0) return { text: "Couldn’t start", tone: "bad" };
      return { text: run.mode === "push" ? "Run queued" : "Waiting for your agent", tone: "warn" };
    }
    if (run.status === "fired") return { text: "Agent starting", tone: "warn" };
    if (run.status === "running") return { text: "Agent working", tone: "warn" };
    if (run.status === "done") return { text: "Agent finished", tone: "ok" };
    if (run.status === "failed") return { text: "Agent failed", tone: "bad" };
    if (run.status === "stale") return { text: "Changed since approved", tone: "bad" };
    return null;
  }

  // What to say after the approve / reject request came back.
  function approveMessage(approved, res) {
    if (!approved) return "Rejected. Nothing will run.";
    var run = res && res.run;
    if (run) {
      if (run.status === "fired") return "Approved. Your agent is starting.";
      if (run.status === "queued" && run.attempts > 0) return "Approved, but your agent couldn’t be started. Open the item to try again.";
      if (run.status === "queued") return "Approved. Waiting for your agent to pick it up.";
    }
    var why = res && res.runError;
    if (why === "dispatch_off") return "Approved. Agent runs aren’t switched on for this site.";
    if (why === "daily_cap") return "Approved. No agent run started: today’s limit is used up.";
    return "Approved.";
  }

  // Does this board offer to run an approved item right now?
  function canRun(item, cfg) {
    if (!cfg || !cfg.available || !cfg.enabled || !item || item.proposal || item.lane === "done") return false;
    return !(item.run && ACTIVE[item.run.status]);
  }

  // The buttons the drawer shows for an item: [{ id: "fire" | "run", label }].
  function runActions(item, cfg) {
    var out = [];
    var run = item && item.run;
    if (!cfg || !cfg.available || !cfg.enabled || !item || item.proposal) return out;
    if (run && run.status === "queued" && run.mode === "push" && run.attempts > 0 && run.attempts < MAX_ATTEMPTS) out.push({ id: "fire", label: "Try starting it again" });
    if (canRun(item, cfg)) {
      out.push({ id: "run", label: !run ? "Start an agent run" : run.status === "stale" ? "Run again with the current text" : "Run again" });
    }
    return out;
  }

  function ago(ts, now) {
    var s = Math.max(0, Math.round(((now || Date.now()) - ts) / 1000));
    if (s < 60) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  }

  // One plain sentence about a run, for the drawer.
  function runLine(run, now) {
    if (!run) return "";
    var when = ago(run.updatedAt, now);
    if (run.status === "queued") return run.mode === "push" ? "Approved " + ago(run.approvedAt, now) + ". Not started yet." : "Approved " + ago(run.approvedAt, now) + ". Your own Claude can pick it up from the approved list.";
    if (run.status === "fired") return "Your routine was started " + when + ".";
    if (run.status === "running") return "Your agent reported it is working (" + when + ").";
    if (run.status === "done") return "Your agent finished " + when + ". Its note is in the log below.";
    if (run.status === "failed") return "Your agent reported a failure " + when + ". Its note is in the log below.";
    if (run.status === "stale") return "The text changed after you approved it, so this run was withdrawn. Read the item, then run it again.";
    return "";
  }

  var DISPATCH_ERRORS = {
    url_invalid: "That isn’t a routine address. It should look like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire.",
    token_invalid: "That doesn’t look like a routine token. Paste the whole token.",
    recent_sign_in_required: "For safety this needs a recent sign-in. Sign in again, then try again.",
    session_required: "This can only be done by you, signed in.",
    nothing_to_change: "Nothing to save."
  };
  function dispatchError(err, fallback) {
    var code = err && err.code;
    if (code && DISPATCH_ERRORS[code]) return DISPATCH_ERRORS[code];
    if (err && err.status === 0) return "Couldn’t reach the server. Try again.";
    return fallback || "That didn’t work. Try again.";
  }

  var helpers = { runChip: runChip, approveMessage: approveMessage, canRun: canRun, runActions: runActions, runLine: runLine, ago: ago, dispatchError: dispatchError };
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. DOM -------------------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function signInAgain() {
    var a = document.createElement("a");
    a.href = "https://api.barnyard.site/auth/login?return_to=" + encodeURIComponent(location.href);
    a.textContent = "Sign in again";
    return a;
  }

  // The board's masked settings, or null if they can't be read (the board then just doesn't
  // offer "Approve and run").
  function loadConfig(ctx) {
    return ctx.request("GET", "/dispatch").then(function (res) { return res && res.ok ? res : null; }, function () { return null; });
  }

  // "Agent run" panel for an item's drawer. `act(kind)` does the request and refreshes the item.
  function runBox(item, cfg, act) {
    var run = item.run;
    var actions = runActions(item, cfg);
    if (!run && !actions.length) return null;
    var box = el("div", "ops-run-box");
    var top = el("div", "ops-run-top");
    top.appendChild(el("b", null, "Agent run"));
    var c = runChip(run);
    if (c) top.appendChild(el("span", "ops-chip ops-chip-run-" + c.tone, c.text));
    box.appendChild(top);
    if (run) box.appendChild(el("p", "ops-dim", runLine(run, Date.now())));
    if (run && run.url && /^https:\/\/claude\.ai\/code\//.test(run.url)) {
      var a = el("a", null, "Open the session");
      a.href = run.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.appendChild(a);
    }
    if (actions.length) {
      var row = el("div", "ops-form-actions");
      actions.forEach(function (x) {
        var b = el("button", "ops-btn", x.label);
        b.type = "button";
        b.addEventListener("click", function () { b.disabled = true; act(x.id, b); });
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    return box;
  }

  // ---- 3. Settings, Agent runs -----------------------------------------------------------

  function registerSettingsTab(ctx, onChange) {
    if (!ctx.Shell || typeof ctx.Shell.registerTab !== "function") return;
    ctx.Shell.registerTab({
      id: "agentruns", title: "Agent runs",
      render: function (body) {
        var fs = el("fieldset");
        fs.appendChild(el("legend", null, "Run my agent when I approve"));
        fs.appendChild(el("p", "hint", "When you approve a proposal, your own Claude can do the work and open a pull request for you to review. It runs on your own Claude account. Nothing runs unless you press Approve and run."));
        var msg = el("p", "ops-form-msg");
        msg.setAttribute("role", "status");
        var area = el("div");
        fs.appendChild(area);
        fs.appendChild(msg);
        body.appendChild(fs);

        function say(text, withSignIn) {
          msg.textContent = text;
          if (withSignIn) { msg.appendChild(document.createTextNode(" ")); msg.appendChild(signInAgain()); }
        }
        function failed(err, fallback) { say(dispatchError(err, fallback), err && err.code === "recent_sign_in_required"); }
        function save(change, ok) {
          return ctx.request("PUT", "/dispatch", change).then(function (cfg) {
            if (ok) say(ok);
            if (onChange) onChange(cfg);
            draw(cfg);
          }, function (err) { failed(err); draw(null); });
        }

        function draw(cfg) {
          clear(area);
          if (!cfg) { loadConfig(ctx).then(function (c) { if (c) draw(c); else area.appendChild(el("p", "ops-empty", "Couldn’t load these settings.")); }); return; }
          if (!cfg.available) {
            area.appendChild(el("p", "hint", "Agent runs aren’t switched on for this site yet. The person who runs the hub turns them on."));
            return;
          }
          var row = el("div", "opt-row");
          var left = el("div");
          left.appendChild(el("b", null, "Offer “Approve and run”"));
          left.appendChild(el("span", "d", "Approving then also asks your agent to start. “Approve only” is always there."));
          row.appendChild(left);
          row.appendChild(ctx.Shell.controls.toggle("Offer Approve and run", cfg.enabled, function (on) { save({ enabled: on }, on ? "Switched on." : "Switched off."); }));
          area.appendChild(row);

          var how = el("div", "ops-run-how");
          how.appendChild(el("b", null, "How your agent starts"));
          how.appendChild(el("p", "ops-dim", cfg.tokenSet
            ? "Started straight away: your routine (ending " + cfg.routineTail + ") is called when you approve. If it can’t be reached, the run waits, and your own Claude can still pick it up."
            : "Picked up by your own Claude: it asks the board for approved items with its agent key. To start it the moment you approve, connect a routine below."));
          area.appendChild(how);

          var conn = el("div", "ops-run-conn");
          if (cfg.tokenSet) {
            conn.appendChild(el("p", "ops-dim", "A routine is connected. Its token is stored encrypted and can’t be shown again."));
            var rev = el("button", "ops-btn ops-btn-sm", "Disconnect");
            rev.type = "button";
            var armed = false;
            rev.addEventListener("click", function () {
              if (!armed) { armed = true; rev.textContent = "Click again to disconnect"; setTimeout(function () { armed = false; rev.textContent = "Disconnect"; }, 4000); return; }
              rev.disabled = true;
              ctx.request("DELETE", "/dispatch").then(function (c) { say("Disconnected. Approvals no longer start anything by themselves."); if (onChange) onChange(c); draw(c); }, function (err) { rev.disabled = false; failed(err); });
            });
            conn.appendChild(rev);
          } else {
            var url = el("input", "ops-input");
            url.type = "text"; url.autocomplete = "off"; url.spellcheck = false; url.placeholder = "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire";
            url.setAttribute("aria-label", "Routine address");
            var tok = el("input", "ops-input");
            tok.type = "password"; tok.autocomplete = "off"; tok.placeholder = "Routine token"; tok.setAttribute("aria-label", "Routine token");
            var go = el("button", "ops-btn ops-btn-primary", "Connect");
            go.type = "button";
            go.addEventListener("click", function () {
              if (!url.value.trim() || !tok.value.trim()) { say("Paste both the address and the token."); return; }
              go.disabled = true;
              var body = { url: url.value.trim(), token: tok.value.trim() };
              tok.value = "";
              save(body, "Connected. Approve and run now starts your routine.").then(function () { go.disabled = false; });
            });
            conn.appendChild(url);
            conn.appendChild(tok);
            conn.appendChild(go);
            conn.appendChild(el("p", "hint", "On claude.ai, open your routine, add an API trigger, and copy its address and token. What is sent when you approve is only the item’s id and a fingerprint of the text you approved, never the text itself."));
          }
          area.appendChild(conn);
          area.appendChild(el("p", "ops-dim", "Runs today: " + cfg.runsToday + " of " + cfg.cap + "."));
        }
        draw(null);
      }
    });
  }

  window.OpsAgentRuns = { loadConfig: loadConfig, runBox: runBox, registerSettingsTab: registerSettingsTab, helpers: helpers };
})();
