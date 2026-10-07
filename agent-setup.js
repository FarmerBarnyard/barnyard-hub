// Ops board: getting a person's own Claude connected to their own board.
//
// Three pieces, all loaded by ops.html before ops.js:
//   mountOnboarding(root, ctx)   shown instead of the board until the person
//                                creates one ("Create your board")
//   mountSetup(host, ctx, me)    the "Connect your Claude" panel above the board:
//                                make a key, put it and the helper on the
//                                computer, give Claude the brief, fill the board
//   registerSettingsTab(ctx)     Settings, Agent access: the person's keys, add,
//                                revoke
//
// ctx = { request(method, path, body), toast(text), Shell, reload() }, supplied
// by ops.js (request talks to the Worker's /ops/* routes with the login cookie).
//
// Only a person who owns a guest board sees any of this; the hub owner uses a
// separate token and never does. A key is shown once, when it is made, and is
// never kept: leaving the page loses it, and a lost key is replaced, not
// recovered. Everything is built with textContent / createElement, never
// innerHTML (the page's CSP allows no inline script or style).
//
// The text the person's Claude reads (the brief, the "fill my board" prompt) and
// the helper scripts live as static files in agent-kit/ and are fetched from
// there, so they can be read and edited as plain files.

(function () {
  "use strict";

  var KIT_URL = "https://dashboard.barnyard.site/agent-kit/";
  // The exact shape of a key. Checked before a key is ever put into a command
  // the person is asked to paste into a terminal.
  var TOKEN_SHAPE = /^ob_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;
  var POLL_MS = 10000;
  var MAX_KEYS = 3;

  // ---- 1. pure helpers (no DOM; tested in test/agent-setup.test.js) ------------

  // "no-board" | "disabled" | "no-key" | "waiting" | "connected", from GET /ops/me.
  function agentState(me) {
    if (!me || !me.hasBoard) return "no-board";
    if (me.disabled) return "disabled";
    var a = me.agent || {};
    if (!a.keys) return "no-key";
    return a.lastAgentEventAt || a.lastUsedAt ? "connected" : "waiting";
  }

  function lastSeenMs(me) {
    var a = (me && me.agent) || {};
    return Math.max(a.lastAgentEventAt || 0, a.lastUsedAt || 0) || null;
  }

  function agoText(ms, now) {
    if (!ms) return "";
    var min = Math.max(0, Math.round((now - ms) / 60000));
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
    var d = Math.round(hr / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  function statusLine(me, now) {
    switch (agentState(me)) {
      case "connected": return "Your Claude is connected. Last update " + agoText(lastSeenMs(me), now) + ".";
      case "waiting": return "Key created. Waiting for your Claude’s first update…";
      case "no-key": return "No agent connected yet.";
      case "disabled": return "This board has been switched off.";
      default: return "";
    }
  }

  function defaultOs(platform) {
    return /win/i.test(String(platform || "")) ? "windows" : "mac";
  }

  // The commands that put a key and the helper on the person's computer.
  // -> [{ label, text }], or null when `token` is not exactly a key.
  function installCommands(os, token) {
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
    if (os === "windows") {
      return [
        { label: "Save your key (a private file on your computer)", text: "New-Item -ItemType Directory -Force \"$HOME\\.claude\" | Out-Null\nSet-Content -Path \"$HOME\\.claude\\ops-board-token\" -Value '" + token + "' -NoNewline" },
        { label: "Install the helper", text: "Invoke-WebRequest " + KIT_URL + "ops-board.ps1 -OutFile \"$HOME\\.claude\\ops-board.ps1\"" }
      ];
    }
    return [
      { label: "Save your key (a private file on your computer)", text: "mkdir -p ~/.claude\nprintf '%s' '" + token + "' > ~/.claude/ops-board-token\nchmod 600 ~/.claude/ops-board-token" },
      { label: "Install the helper", text: "curl -fsSL " + KIT_URL + "ops-board.sh -o ~/.claude/ops-board.sh && chmod +x ~/.claude/ops-board.sh" }
    ];
  }

  function keyLine(tok, now) {
    var made = "made " + agoText(tok.createdAt, now);
    return tok.lastUsedAt ? made + " · last used " + agoText(tok.lastUsedAt, now) : made + " · not used yet";
  }

  function createError(err) {
    var code = err && err.code;
    if (code === "keys_full") return "You already have " + MAX_KEYS + " keys. Revoke one in Settings, Agent access, then try again.";
    if (code === "label_invalid") return "Use 1 to 40 letters, numbers, spaces or . _ ( ) ' - for the name.";
    if (code === "rate_limited") return "Too many changes just now. Wait a minute and try again.";
    if (err && err.status === 401) return "Your session has expired. Log in again.";
    if (err && err.status === 403) return "This board can’t make keys right now.";
    return "Couldn’t make the key. Try again.";
  }

  function onboardError(err) {
    var code = err && err.code;
    if (code === "boards_full") return "This hub has no room for more boards right now. Ask the person who runs it.";
    if (code === "board_disabled") return "Your board has been switched off. Ask the person who runs this hub.";
    if (err && err.status === 401) return "Your session has expired. Log in again.";
    return "Couldn’t create your board. Try again.";
  }

  var helpers = {
    agentState: agentState, lastSeenMs: lastSeenMs, agoText: agoText, statusLine: statusLine, defaultOs: defaultOs,
    installCommands: installCommands, keyLine: keyLine, createError: createError, onboardError: onboardError,
    TOKEN_SHAPE: TOKEN_SHAPE, MAX_KEYS: MAX_KEYS, KIT_URL: KIT_URL
  };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = helpers;
    return;
  }

  // ---- 2. small DOM pieces -------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // The old select-and-copy route, for when the clipboard API is missing or refuses
  // (an insecure page, a browser that wants a fresh click, a locked-down embed).
  function copyViaSelection(text) {
    var ta = el("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "ops-offscreen";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return copyViaSelection(text); });
    }
    return Promise.resolve(copyViaSelection(text));
  }

  function copyButton(getText, label) {
    var b = el("button", "ops-btn ops-btn-sm", label || "Copy");
    b.type = "button";
    b.addEventListener("click", function () {
      var text = getText();
      if (!text) return;
      copyText(text).then(function (ok) {
        b.textContent = ok ? "Copied" : "Select and copy";
        setTimeout(function () { b.textContent = label || "Copy"; }, 2000);
      });
    });
    return b;
  }

  // A labelled block of text with a Copy button. `text` may arrive later (setText).
  function codeBlock(label, text) {
    var wrap = el("div", "ops-code");
    var head = el("div", "ops-code-head");
    head.appendChild(el("span", "ops-code-label", label));
    var current = text || "";
    var pre = el("pre", "ops-code-body", current || "Loading…");
    head.appendChild(copyButton(function () { return current; }));
    wrap.appendChild(head);
    wrap.appendChild(pre);
    return {
      node: wrap,
      setText: function (t) { current = t; pre.textContent = t; },
      fail: function (href) {
        current = "";
        clear(pre);
        pre.appendChild(document.createTextNode("Couldn’t load this here. "));
        var a = el("a", null, "Open the file");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        pre.appendChild(a);
      }
    };
  }

  function loadKit(name, block) {
    fetch("agent-kit/" + name, { referrerPolicy: "no-referrer" }).then(function (res) {
      if (!res.ok) throw new Error("status " + res.status);
      return res.text();
    }).then(function (t) { block.setText(t.trim()); }, function () { block.fail("agent-kit/" + name); });
  }

  function segmented(options, value, onPick) {
    var seg = el("div", "ops-tabs");
    seg.setAttribute("role", "group");
    options.forEach(function (o) {
      var b = el("button", "ops-tab", o.title);
      b.type = "button";
      b.setAttribute("aria-pressed", String(o.value === value));
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute("aria-pressed", "false"); });
        b.setAttribute("aria-pressed", "true");
        onPick(o.value);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  // The one-time reveal of a new key, with the commands that put it on a computer.
  function keyReveal(token, onDone) {
    var box = el("div", "ops-reveal");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Your new agent key");
    box.appendChild(el("p", "ops-reveal-warn", "This is the only time the key is shown. Copy it now; if you lose it, revoke it and make another."));
    var keyBlock = codeBlock("Your key", token);
    box.appendChild(keyBlock.node);
    var os = defaultOs(typeof navigator !== "undefined" ? navigator.platform : "");
    var cmds = el("div", "ops-reveal-cmds");
    function drawCommands() {
      clear(cmds);
      var list = installCommands(os, token);
      if (!list) { cmds.appendChild(el("p", "ops-empty", "This key looks unusual, so no commands were made. Copy the key above and save it to ~/.claude/ops-board-token.")); return; }
      list.forEach(function (c) { cmds.appendChild(codeBlock(c.label, c.text).node); });
    }
    box.appendChild(el("p", "ops-reveal-lead", "Then run these in a terminal on the computer where you use Claude Code:"));
    box.appendChild(segmented([{ value: "windows", title: "Windows (PowerShell)" }, { value: "mac", title: "macOS or Linux" }], os, function (v) { os = v; drawCommands(); }));
    box.appendChild(cmds);
    drawCommands();
    if (onDone) {
      var done = el("button", "ops-btn ops-btn-sm", "I’ve saved it");
      done.type = "button";
      done.addEventListener("click", onDone);
      box.appendChild(done);
    }
    return box;
  }

  // A name field and a "Make key" button; calls back with the new key's response.
  function keyForm(ctx, onMade, onError) {
    var form = el("form", "ops-keyform");
    var field = el("label", "ops-field");
    field.appendChild(el("span", "ops-field-label", "Name this key (the computer it is for)"));
    var input = el("input", "ops-input");
    input.type = "text";
    input.maxLength = 40;
    input.value = "My computer";
    input.autocomplete = "off";
    field.appendChild(input);
    var go = el("button", "ops-btn ops-btn-primary", "Create agent key");
    go.type = "submit";
    form.appendChild(field);
    form.appendChild(go);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      go.disabled = true;
      ctx.request("POST", "/tokens", { label: input.value.trim() }).then(function (res) {
        go.disabled = false;
        onMade(res);
      }, function (err) {
        go.disabled = false;
        onError(createError(err));
      });
    });
    return form;
  }

  // ---- 3. create your board --------------------------------------------------------

  function mountOnboarding(root, ctx) {
    clear(root);
    var card = el("div", "ops-onboard");
    card.appendChild(el("h2", null, "Create your board"));
    card.appendChild(el("p", null, "This is your own progress board: lanes for what is in progress, soaking, waiting on you and planned. Other people on this hub can’t see it."));
    card.appendChild(el("p", null, "Once it exists you can connect your own Claude, which then keeps the board up to date as it works on your projects."));
    var go = el("button", "ops-btn ops-btn-primary", "Create my board");
    go.type = "button";
    var status = el("p", "ops-onboard-status");
    status.setAttribute("role", "status");
    go.addEventListener("click", function () {
      go.disabled = true;
      status.textContent = "Creating your board…";
      ctx.request("POST", "/boards/me").then(function () {
        ctx.reload();
      }, function (err) {
        go.disabled = false;
        status.textContent = onboardError(err);
      });
    });
    card.appendChild(go);
    card.appendChild(status);
    root.appendChild(card);
  }

  // ---- 4. the "Connect your Claude" panel ------------------------------------------

  function mountSetup(host, ctx, me0) {
    var state = { me: me0, token: null };
    var panel = el("details", "ops-setup");
    var summary = el("summary", "ops-setup-summary");
    var title = el("span", "ops-setup-title", "Connect your Claude");
    var line = el("span", "ops-setup-line");
    line.setAttribute("role", "status");
    summary.appendChild(title);
    summary.appendChild(line);
    panel.appendChild(summary);
    if (agentState(me0) !== "connected") panel.open = true;

    var steps = el("ol", "ops-steps");
    function step(heading, body) {
      var li = el("li", "ops-step");
      li.appendChild(el("h3", null, heading));
      li.appendChild(body);
      steps.appendChild(li);
      return li;
    }

    var s1 = el("div");
    var s1body = el("div");
    s1.appendChild(el("p", "ops-step-text", "A key lets your Claude post to this board, and only this board. Make one for each computer you use (up to " + MAX_KEYS + "). You can revoke it any time in Settings, Agent access."));
    s1.appendChild(s1body);
    var li1 = step("Create an agent key", s1);

    var s2 = el("div");
    var s2body = el("div");
    s2.appendChild(s2body);
    var li2 = step("Put the key and helper on your computer", s2);

    var s3 = el("div");
    s3.appendChild(el("p", "ops-step-text", "Paste this into your Claude Code’s CLAUDE.md (or start a session with it). It tells your Claude how to keep the board up to date."));
    var brief = codeBlock("The brief for your Claude", "");
    s3.appendChild(brief.node);
    step("Give your Claude the brief", s3);

    var s4 = el("div");
    s4.appendChild(el("p", "ops-step-text", "Paste this into a session once. Your Claude shows you what it plans to add and waits for your yes before touching the board."));
    var populate = codeBlock("Fill the board from your projects", "");
    s4.appendChild(populate.node);
    step("Fill the board from your projects", s4);

    panel.appendChild(steps);
    host.appendChild(panel);
    loadKit("agent-brief.md", brief);
    loadKit("populate-prompt.md", populate);

    var formError = el("p", "ops-form-error");
    formError.setAttribute("role", "alert");

    function drawStep1() {
      clear(s1body);
      if (state.token) return;
      var have = (state.me && state.me.agent && state.me.agent.keys) || 0;
      if (have >= MAX_KEYS) {
        s1body.appendChild(el("p", "ops-empty", "You have " + MAX_KEYS + " keys already. Revoke one in Settings, Agent access, to make another."));
        return;
      }
      s1body.appendChild(keyForm(ctx, function (res) {
        formError.textContent = "";
        state.token = res.token;
        drawStep1();
        drawStep2();
        refreshMe();
      }, function (message) { formError.textContent = message; }));
      s1body.appendChild(formError);
    }

    function drawStep2() {
      clear(s2body);
      if (state.token) {
        s2body.appendChild(keyReveal(state.token, function () { state.token = null; drawStep1(); drawStep2(); }));
      } else {
        s2body.appendChild(el("p", "ops-step-text ops-dim", "Create a key above and the exact commands for your computer appear here, with the key already filled in."));
      }
    }

    function paint() {
      var st = agentState(state.me);
      line.textContent = statusLine(state.me, Date.now());
      panel.classList.toggle("is-connected", st === "connected");
      li1.classList.toggle("is-done", st !== "no-key" && st !== "no-board");
      li2.classList.toggle("is-done", st === "connected");
    }

    var wasConnected = agentState(me0) === "connected";
    function refreshMe() {
      return ctx.request("GET", "/me").then(function (me) {
        if (!me) return;
        state.me = me;
        var now = agentState(me) === "connected";
        if (now && !wasConnected) ctx.toast("Your Claude is connected.");
        wasConnected = now;
        paint();
        if (!state.token) drawStep1();
      }, function () { /* keep the last known state; the next poll tries again */ });
    }

    drawStep1();
    drawStep2();
    paint();
    // Poll while the page is in view, and catch up the moment it comes back into view.
    var timer = setInterval(function () {
      if (!host.isConnected) { clearInterval(timer); return; }
      if (document.hidden) return;
      refreshMe();
    }, POLL_MS);
    function onVisible() {
      if (!host.isConnected) { document.removeEventListener("visibilitychange", onVisible); return; }
      if (!document.hidden) refreshMe();
    }
    document.addEventListener("visibilitychange", onVisible);
    return { refresh: refreshMe };
  }

  // ---- 5. Settings, Agent access ----------------------------------------------------

  function registerSettingsTab(ctx) {
    if (!ctx.Shell || typeof ctx.Shell.registerTab !== "function") return;
    var reveal = null; // { token } kept until the person says they have saved it
    var armed = null;  // id of a key whose Revoke button has been clicked once

    ctx.Shell.registerTab({
      id: "agent", title: "Agent access",
      render: function (body) {
        var intro = el("fieldset");
        intro.appendChild(el("legend", null, "Your Claude’s keys"));
        intro.appendChild(el("p", "hint", "A key lets your own Claude read and update this board, and nothing else. Keys don’t expire; revoke one the moment you lose track of it. Make one per computer, up to " + MAX_KEYS + "."));
        var list = el("div", "ops-keys");
        list.appendChild(el("p", "ops-empty", "Loading…"));
        intro.appendChild(list);
        body.appendChild(intro);

        var addArea = el("div", "ops-keys-add");
        var addError = el("p", "ops-form-error");
        addError.setAttribute("role", "alert");
        body.appendChild(addArea);
        var revealArea = el("div");
        body.appendChild(revealArea);

        function drawReveal() {
          clear(revealArea);
          if (reveal) revealArea.appendChild(keyReveal(reveal.token, function () { reveal = null; drawReveal(); }));
        }

        function drawKeys(tokens) {
          clear(list);
          if (!tokens.length) list.appendChild(el("p", "ops-empty", "No keys yet."));
          var now = Date.now();
          tokens.forEach(function (t) {
            var row = el("div", "ops-key-row");
            var text = el("div");
            text.appendChild(el("b", null, t.label));
            text.appendChild(el("span", "ops-dim", keyLine(t, now)));
            var revoke = el("button", "ops-btn ops-btn-sm", armed === t.id ? "Click again to revoke" : "Revoke");
            revoke.type = "button";
            revoke.addEventListener("click", function () {
              if (armed !== t.id) {
                armed = t.id;
                revoke.textContent = "Click again to revoke";
                setTimeout(function () { if (armed === t.id) { armed = null; revoke.textContent = "Revoke"; } }, 4000);
                return;
              }
              armed = null;
              revoke.disabled = true;
              ctx.request("DELETE", "/tokens/" + t.id).then(function () {
                ctx.toast("Key revoked.");
                load();
              }, function () { revoke.disabled = false; ctx.toast("Couldn’t revoke it. Try again."); });
            });
            row.appendChild(text);
            row.appendChild(revoke);
            list.appendChild(row);
          });
          clear(addArea);
          if (tokens.length >= MAX_KEYS) {
            addArea.appendChild(el("p", "ops-empty", "You have " + MAX_KEYS + " keys. Revoke one to make another."));
          } else {
            addArea.appendChild(keyForm(ctx, function (res) {
              reveal = { token: res.token };
              ctx.toast("Key made. Copy it now.");
              load();
              drawReveal();
            }, function (message) { addError.textContent = message; }));
            addArea.appendChild(addError);
          }
        }

        function load() {
          ctx.request("GET", "/tokens").then(function (res) { drawKeys((res && res.tokens) || []); }, function () {
            clear(list);
            list.appendChild(el("p", "ops-empty", "Couldn’t load your keys. Close Settings and open it again."));
          });
        }
        load();
        drawReveal();
      }
    });
  }

  // ---- 6. wiring ---------------------------------------------------------------------

  // Called by ops.js once the board is on screen. Only a person with a board of
  // their own (not the hub owner) gets the panel and the settings tab.
  function afterMount(root, ctx) {
    ctx.request("GET", "/me").then(function (me) {
      if (!me || me.isOwner !== false || !me.hasBoard || me.disabled) return;
      var host = el("div", "ops-setup-host");
      root.insertBefore(host, root.firstChild);
      mountSetup(host, ctx, me);
      registerSettingsTab(ctx);
    }, function () { /* no panel is better than a broken one */ });
  }

  window.OpsAgentSetup = { mountOnboarding: mountOnboarding, afterMount: afterMount, helpers: helpers };
})();
