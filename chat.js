// The Claude chat page (chat.html): a person's own Claude, like the desktop app.
//
// The page only talks to the Worker (api.barnyard.site/chat/*). The Worker stores the
// conversation and queues each message; a runner runs Claude Code for it and posts the reply
// back, which reaches this page over a WebSocket as it is written. For the owner the runner is on
// the owner's server. For a guest (when the owner has switched guest chats on) it is a program on
// the guest's OWN computer, signed in with the guest's own Claude account, read-only; the page
// then also shows "Connect your Claude" (download, make a key, status). The Worker decides which
// room a person gets from their login alone. Sending, stopping, deleting, turning on edit mode
// and making or revoking a key need a recent sign-in.
//
// Three parts, like ops.js:
//   1. pure helpers   -- folding pushed messages into the list, grouping a turn, labels and
//                        wording (no DOM; tested in test/chat.test.js)
//   2. transport      -- REST + a WebSocket per conversation, with reconnect
//   3. UI             -- built with createElement / textContent only. Claude's replies are
//                        shown through markdown.js (DOM-only, no innerHTML, https/mailto links
//                        only, no images), so a reply can never inject markup.

(function () {
  "use strict";

  var API_BASE = "https://api.barnyard.site/chat";
  var WS_BASE = "wss://api.barnyard.site/chat/ws";
  var TEXT_MAX = 20000;
  var STATUS_POLL_MS = 30000;
  var KEY_CURRENT = "barnyard-chat-current";

  // ---- 1. pure helpers ------------------------------------------------------

  var STATUS_LABEL = {
    queued: "Waiting for the runner…",
    streaming: "Working…",
    error: "Something went wrong",
    stopped: "Stopped",
    done: ""
  };
  function statusLabel(status) { return Object.prototype.hasOwnProperty.call(STATUS_LABEL, status) ? STATUS_LABEL[status] : ""; }

  function isActiveStatus(status) { return status === "queued" || status === "streaming"; }

  function newestFirst(list) {
    return list.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function titleOf(conv) { return conv && conv.title ? conv.title : "New chat"; }

  // "just now", "5 min ago", "3 h ago", "2 d ago", else a date.
  function relativeTime(ts, now) {
    if (!ts) return "";
    var s = Math.max(0, Math.round(((now || Date.now()) - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.round(s / 86400) + " d ago";
    return new Date(ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  }

  // The time a message was sent, for the small label beside it: "3:42 pm" today, "9 Oct, 3:42 pm"
  // otherwise. Built by hand (not toLocaleTimeString) so it reads the same in every browser.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function clockTime(ts, now) {
    if (!ts || !Number.isFinite(ts)) return "";
    var d = new Date(ts), n = new Date(now || Date.now());
    var h = d.getHours(), m = d.getMinutes();
    var clock = (h % 12 === 0 ? 12 : h % 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "am" : "pm");
    var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? clock : d.getDate() + " " + MONTHS[d.getMonth()] + ", " + clock;
  }

  // Things to try, shown on an empty chat. Clicking one fills the box; nothing is sent until Send.
  var STARTERS = [
    "What is on my Ops board right now?",
    "What changed in the projects this week?",
    "Explain how the campaign engine and the Knowledgebase AI fit together.",
    "Help me plan the next piece of work."
  ];

  // ---- guests: their own Claude, on their own computer ----------------------------
  function isGuest(me) { return !!me && me.kind === "guest"; }

  var STARTERS_GUEST = [
    "What is in the folder I shared with you?",
    "Summarise the main files in my shared folder.",
    "Help me plan my week.",
    "Explain what this project does, in plain words."
  ];

  // Where a guest's connection stands: no key yet, a key but their computer has not been seen, or connected.
  function connectState(me) {
    if (!isGuest(me)) return "owner";
    if (me.runner && me.runner.online) return "connected";
    if (me.keys && me.keys.active > 0) return "waiting";
    return "need_key";
  }

  var KEY_LIFETIMES = [[30, "30 days"], [90, "90 days"], [365, "1 year"]];

  function keyState(k, now) {
    if (!k) return "";
    if (k.revoked) return "Revoked";
    if (k.expired || (k.expiresAt && k.expiresAt <= (now || Date.now()))) return "Expired";
    return "Active";
  }
  function dayText(ts) { var d = new Date(ts); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
  // One line about a key: never the key itself (it is shown once, when it is made).
  function keyLine(k, now) {
    var parts = ["Made " + relativeTime(k.createdAt, now)];
    if (keyState(k, now) === "Active") parts.push("expires " + dayText(k.expiresAt));
    parts.push(k.lastUsed ? "last used " + relativeTime(k.lastUsed, now) : "not used yet");
    return parts.join(" · ");
  }

  // The download the hub offers (guest-runner/guest-runner.json). Accepted only in exactly this shape:
  // a file name that carries the first 8 digits of its own checksum, so a mix-up is caught.
  function parseKit(j) {
    if (!j || typeof j !== "object") return null;
    if (typeof j.file !== "string" || !/^guest-runner-[0-9a-f]{8}\.zip$/.test(j.file)) return null;
    if (typeof j.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(j.sha256) || j.sha256.slice(0, 8) !== j.file.slice(13, 21)) return null;
    return { file: j.file, sha256: j.sha256, bytes: Number.isFinite(j.bytes) && j.bytes > 0 ? j.bytes : 0 };
  }
  function sizeText(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB"; }

  // The runner pill: {tone: "ok"|"off"|"none", text}.
  function runnerLabel(me, now) {
    var r = me && me.runner, g = isGuest(me);
    if (!r) return { tone: "none", text: g ? "Checking your Claude…" : "Checking the runner…" };
    if (r.online) return { tone: "ok", text: g ? "Your Claude is connected" : "Runner online" };
    if (!r.lastSeen) return { tone: "off", text: g ? "Your Claude is not connected yet" : "Runner has not connected yet" };
    return { tone: "off", text: (g ? "Your Claude is offline, last seen " : "Runner offline, last seen ") + relativeTime(r.lastSeen, now) };
  }

  // Fold one message from the WebSocket (or a REST reply) into the state. Pure: returns a new
  // list of messages and a new conversation; never changes what it was given.
  //   {type:"message", message}   add or replace by seq
  //   {type:"delta", seq, text}   add text to a message
  //   {type:"status", seq, status}
  //   {type:"conversation", conversation}
  //   {type:"stopping"}
  function fold(state, msg) {
    var messages = state.messages, conv = state.conv;
    if (!msg || typeof msg !== "object") return state;
    if (msg.type === "message" && msg.message && Number.isInteger(msg.message.seq)) {
      var m = msg.message, found = false;
      messages = messages.map(function (x) { if (x.seq === m.seq) { found = true; return m; } return x; });
      if (!found) messages = messages.concat([m]).sort(function (a, b) { return a.seq - b.seq; });
    } else if (msg.type === "delta" && Number.isInteger(msg.seq) && typeof msg.text === "string") {
      messages = messages.map(function (x) { return x.seq === msg.seq ? Object.assign({}, x, { text: x.text + msg.text }) : x; });
    } else if (msg.type === "status" && Number.isInteger(msg.seq) && typeof msg.status === "string") {
      messages = messages.map(function (x) { return x.seq === msg.seq ? Object.assign({}, x, { status: msg.status }) : x; });
    } else if (msg.type === "conversation" && msg.conversation && conv && msg.conversation.id === conv.id) {
      conv = Object.assign({}, msg.conversation);
    } else if (msg.type === "stopping" && conv) {
      conv = Object.assign({}, conv, { stopping: true });
    }
    // Once nothing is running, "stopping" no longer applies.
    if (conv && conv.stopping && !messages.some(function (x) { return x.role === "assistant" && isActiveStatus(x.status); })) {
      conv = Object.assign({}, conv, { stopping: false });
    }
    return { messages: messages, conv: conv };
  }

  // Group the flat list into turns: a person's message, the tool lines Claude used, and its reply.
  // Tool rows are stored after the reply's placeholder, so they are matched by position: every
  // tool row after a user message belongs to that message's turn.
  function groupTurns(messages) {
    var turns = [], cur = null;
    messages.forEach(function (m) {
      if (m.role === "user") { cur = { user: m, tools: [], assistant: null }; turns.push(cur); return; }
      if (!cur) { cur = { user: null, tools: [], assistant: null }; turns.push(cur); }
      if (m.role === "tool") cur.tools.push(m);
      else if (m.role === "assistant" && !cur.assistant) cur.assistant = m;
    });
    return turns;
  }

  // Is a message running in this conversation?
  function isBusy(messages) {
    return messages.some(function (m) { return m.role === "assistant" && isActiveStatus(m.status); });
  }

  // Why the Send button is off ("" when it is on).
  function sendBlock(state) {
    if (!state.conv) return "Start a chat first.";
    if (state.busy) return "Claude is working on your last message.";
    if (!state.me || !state.me.runner || !state.me.runner.online) return isGuest(state.me) ? "Your Claude is not connected, so nothing can answer yet." : "The runner is offline, so nothing can answer yet.";
    var t = state.text || "";
    if (!t.trim()) return "Type a message.";
    if (t.length > TEXT_MAX) return "That is too long (" + TEXT_MAX.toLocaleString("en-AU") + " characters at most).";
    return "";
  }

  var SECRET_KIND = {
    private_key: "a private key", agent_key: "an agent key", bearer_token: "an access token", aws_key: "a cloud key",
    github_token: "a GitHub token", slack_token: "a Slack token", google_key: "a Google key", stripe_key: "a payment key",
    api_key: "an API key", jwt: "a login token", url_password: "a password in a web address", credential: "a password or key"
  };

  // What to tell the person when the Worker refuses something. (me: so a guest hears about their own computer.)
  function errorMessage(err, me) {
    var code = err && err.code;
    var guest = isGuest(me);
    if (code === "secret_detected") return "Not sent: your message looks like it contains " + (SECRET_KIND[err.kind] || "a password or key") + ". Take it out and send it again.";
    if (code === "recent_sign_in_required") return "For safety this needs a recent sign-in. Sign in again, then try again.";
    if (code === "runner_offline") return guest ? "Your Claude is not connected, so nothing can answer yet. Use “Connect your Claude”, or start the runner on your computer." : "The runner is offline, so nothing can answer yet. Start it on the server.";
    if (code === "board_required") return "Open the Ops board once first: it sets up your own space. Then come back here.";
    if (code === "board_disabled") return "Your space on the hub has been switched off by the owner.";
    if (code === "edit_not_available") return "Guest chats are read-only: your Claude can look but not change anything.";
    if (code === "keys_full") return "You already have two active keys. Revoke one first.";
    if (code === "guests_full") return "Guest chats are full right now. Ask the hub owner to make room.";
    if (code === "label_invalid") return "Give the key a short name (letters, numbers and spaces).";
    if (code === "days_invalid") return "Pick how long the key should last.";
    if (code === "key_expired") return "That key has expired. Make a new one.";
    if (code === "busy") return "Claude is still working on your last message in this chat.";
    if (code === "queue_full") return "Several messages are already waiting. Try again in a minute.";
    if (code === "rate_limited") return "That is a lot of messages in a minute. Wait a moment.";
    if (code === "rate_limited_today") return "You have reached today’s message limit.";
    if (code === "conversation_full") return "This chat is full. Start a new one.";
    if (code === "library_full") return "There are too many chats. Delete some you no longer need.";
    if (code === "chat_disabled") return "The chat is switched off.";
    if (code === "text_too_long") return "That message is too long.";
    if (code === "not_found") return "That chat no longer exists.";
    if (err && err.status === 401) return "Your session has expired. Log in again.";
    if (err && err.status === 403) return "This chat is not open to you yet. The hub owner switches guest chats on.";
    if (err && err.code) return "That did not work (" + String(err.code).replace(/_/g, " ") + ").";
    return "Couldn’t reach the server. Try again.";
  }

  // The summary line for a turn's tool lines.
  function toolSummary(tools, active) {
    if (!tools.length) return "";
    if (active) return tools[tools.length - 1].text;
    return tools.length === 1 ? "Used 1 tool" : "Used " + tools.length + " tools";
  }

  var helpers = {
    statusLabel: statusLabel, isActiveStatus: isActiveStatus, newestFirst: newestFirst, titleOf: titleOf,
    relativeTime: relativeTime, runnerLabel: runnerLabel, fold: fold, groupTurns: groupTurns, isBusy: isBusy,
    sendBlock: sendBlock, errorMessage: errorMessage, toolSummary: toolSummary, clockTime: clockTime, STARTERS: STARTERS, TEXT_MAX: TEXT_MAX,
    isGuest: isGuest, STARTERS_GUEST: STARTERS_GUEST, connectState: connectState, keyState: keyState, keyLine: keyLine,
    parseKit: parseKit, sizeText: sizeText, KEY_LIFETIMES: KEY_LIFETIMES
  };

  // ---- 2. transport ---------------------------------------------------------

  function apiError(res, data) {
    var err = new Error((data && data.error) || "request_failed");
    err.status = res.status;
    err.code = (data && data.error) || null;
    err.kind = (data && data.kind) || null;
    return err;
  }

  function request(method, path, body) {
    var opts = { method: method, credentials: "include", referrerPolicy: "no-referrer", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw apiError(res, data);
        return data;
      });
    });
  }

  // One conversation's stream. Reconnects with a growing delay; onOpen fires after every
  // (re)connect so the page can fetch what it missed. handlers: onMessage, onStatus, onOpen.
  function openStream(conv, handlers) {
    var ws = null, closed = false, attempt = 0, pingTimer = null, retryTimer = null;

    function schedule() {
      if (closed) return;
      handlers.onStatus("reconnecting");
      var delay = Math.min(30000, 1000 * Math.pow(2, attempt)) * (0.75 + Math.random() * 0.5);
      attempt++;
      retryTimer = setTimeout(connect, delay);
    }
    function connect() {
      if (closed) return;
      handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
      try { ws = new WebSocket(WS_BASE + "?conv=" + encodeURIComponent(conv)); } catch (e) { schedule(); return; }
      ws.onopen = function () {
        attempt = 0;
        handlers.onStatus("live");
        handlers.onOpen();
        clearInterval(pingTimer);
        pingTimer = setInterval(function () { try { if (ws.readyState === 1) ws.send("ping"); } catch (e) { /* the close handler reconnects */ } }, 25000);
      };
      ws.onmessage = function (ev) {
        if (ev.data === "pong") return;
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        handlers.onMessage(msg);
      };
      ws.onclose = function (ev) {
        clearInterval(pingTimer);
        if (ev && (ev.code === 1000 || ev.code === 1008) && ev.reason === "deleted") { closed = true; handlers.onMessage({ type: "deleted" }); return; }
        schedule();
      };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* already closing */ } };
    }
    connect();
    return {
      close: function () {
        closed = true;
        clearTimeout(retryTimer);
        clearInterval(pingTimer);
        try { if (ws) ws.close(); } catch (e) { /* already closed */ }
      }
    };
  }

  var transport = {
    me: function () { return request("GET", "/me"); },
    list: function () { return request("GET", "/conversations"); },
    open: function (id) { return request("GET", "/conversation?id=" + encodeURIComponent(id)); },
    create: function (body) { return request("POST", "/conversations", body || {}); },
    patch: function (id, body) { return request("PATCH", "/conversation?id=" + encodeURIComponent(id), body); },
    remove: function (id) { return request("DELETE", "/conversation?id=" + encodeURIComponent(id)); },
    send: function (conv, text) { return request("POST", "/message", { conv: conv, text: text }); },
    stop: function (conv) { return request("POST", "/stop", { conv: conv }); },
    keys: function () { return request("GET", "/runner-keys"); },
    makeKey: function (label, days) { return request("POST", "/runner-keys", { label: label, days: days }); },
    revokeKey: function (id) { return request("DELETE", "/runner-key?id=" + encodeURIComponent(id)); },
    // The download on offer, or null. Fetched from this site (not the Worker), and checked by parseKit.
    kit: function () {
      return fetch("guest-runner/guest-runner.json", { referrerPolicy: "no-referrer", cache: "no-cache" })
        .then(function (res) { return res.ok ? res.json() : null; }).then(parseKit).catch(function () { return null; });
    },
    connect: openStream
  };

  // ---- 3. UI ----------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function store(key, value) {
    try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch (e) { /* private window: the page works without it */ }
  }
  function recall(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }

  function mount(root, me) {
    var Shell = window.BarnyardShell;
    var MD = window.BarnyardMarkdown;
    var isG = helpers.isGuest(me);
    var state = { me: me, convs: [], conv: null, messages: [], busy: false, text: "", stream: null, streamStatus: "connecting", notice: "", confirm: null, setup: false, keys: [], kit: null, kitLoaded: false, newToken: "", makingKey: false };
    var intro = document.getElementById("chat-intro");
    if (intro && isG) intro.textContent = "Your own Claude, running on your own computer with your own Claude account. It can read one folder you choose and cannot change anything. Nothing about your Claude account is sent to Barnyard.";
    var cache = {};              // seq -> {sig, node}: a reply is rendered again only when it changed
    var renderQueued = false;
    var stick = true;            // keep the newest text in view unless the person scrolled up

    clear(root);
    var shell = el("div", "chat-shell");
    var side = el("aside", "chat-side");
    var main = el("section", "chat-main");
    shell.appendChild(side);
    shell.appendChild(main);
    root.appendChild(shell);

    // side: new chat + list
    var newBtn = el("button", "chat-btn chat-btn-primary", "New chat");
    newBtn.type = "button";
    var listWrap = el("nav", "chat-list");
    listWrap.setAttribute("aria-label", "Chats");
    side.appendChild(newBtn);
    var connectBtn = null;
    if (isG) {
      connectBtn = el("button", "chat-btn", "Connect your Claude");
      connectBtn.type = "button";
      side.appendChild(connectBtn);
    }
    side.appendChild(listWrap);

    // main: bar, banner, thread, composer
    var bar = el("header", "chat-bar");
    var titleBtn = el("button", "chat-title");
    titleBtn.type = "button";
    titleBtn.title = "Rename this chat";
    var modes = el("div", "chat-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "What Claude may do in this chat");
    var readBtn = el("button", null, "Read");
    var editBtn = el("button", null, "Edit");
    readBtn.type = editBtn.type = "button";
    readBtn.title = "Claude can read the projects and use your Ops board, and cannot change files.";
    editBtn.title = "Claude can also change files in its own copy and push branches named claude/…";
    modes.appendChild(readBtn);
    modes.appendChild(editBtn);
    modes.hidden = isG;                      // a guest's chat is always read-only: nothing to switch
    var pill = el("span", "chat-pill");
    var delBtn = el("button", "chat-btn chat-btn-quiet chat-btn-sm", "Delete");
    delBtn.type = "button";
    bar.appendChild(titleBtn);
    bar.appendChild(el("span", "chat-spacer"));
    bar.appendChild(modes);
    bar.appendChild(pill);
    bar.appendChild(delBtn);

    var banner = el("div", "chat-banner");
    banner.setAttribute("role", "status");
    banner.hidden = true;
    var thread = el("div", "chat-thread");
    thread.setAttribute("role", "log");
    thread.setAttribute("aria-live", "polite");
    thread.tabIndex = 0;

    var form = el("form", "chat-composer");
    var box = el("textarea", "chat-input");
    box.rows = 1;
    box.setAttribute("aria-label", "Message to Claude");
    box.placeholder = "Message Claude (Enter to send, Shift+Enter for a new line)";
    box.maxLength = TEXT_MAX + 5000;
    var count = el("span", "chat-count");
    var sendBtn = el("button", "chat-btn chat-btn-primary", "Send");
    sendBtn.type = "submit";
    var stopBtn = el("button", "chat-btn", "Stop");
    stopBtn.type = "button";
    stopBtn.hidden = true;
    var composerRow = el("div", "chat-composer-row");
    composerRow.appendChild(count);
    composerRow.appendChild(el("span", "chat-spacer"));
    composerRow.appendChild(stopBtn);
    composerRow.appendChild(sendBtn);
    form.appendChild(box);
    form.appendChild(composerRow);

    var setupPanel = el("div", "chat-setup");
    setupPanel.hidden = true;

    main.appendChild(bar);
    main.appendChild(banner);
    main.appendChild(setupPanel);
    main.appendChild(thread);
    main.appendChild(form);

    function toast(text) { if (Shell && Shell.toast) Shell.toast(text); }
    function say(text) { state.notice = text; renderBanner(); }
    function fail(err) { say(helpers.errorMessage(err, state.me)); }

    // -- list ------------------------------------------------------------------
    function renderList() {
      clear(listWrap);
      if (!state.convs.length) { listWrap.appendChild(el("p", "chat-dim chat-pad", "No chats yet.")); return; }
      helpers.newestFirst(state.convs).forEach(function (c) {
        var b = el("button", "chat-row");
        b.type = "button";
        if (state.conv && c.id === state.conv.id) b.setAttribute("aria-current", "true");
        b.appendChild(el("span", "chat-row-title", helpers.titleOf(c)));
        var meta = el("span", "chat-row-meta");
        if (c.mode === "edit") meta.appendChild(el("span", "chat-tag chat-tag-edit", "Edit"));
        if (c.busy) meta.appendChild(el("span", "chat-tag", "Working"));
        meta.appendChild(el("span", null, helpers.relativeTime(c.updatedAt)));
        b.appendChild(meta);
        b.addEventListener("click", function () { openConversation(c.id); });
        listWrap.appendChild(b);
      });
    }

    // -- header, banner, composer state ----------------------------------------
    function renderBar() {
      var c = state.conv;
      titleBtn.textContent = helpers.titleOf(c);
      titleBtn.disabled = !c;
      readBtn.setAttribute("aria-pressed", String(!!c && c.mode !== "edit"));
      editBtn.setAttribute("aria-pressed", String(!!c && c.mode === "edit"));
      readBtn.disabled = editBtn.disabled = !c;
      delBtn.disabled = !c;
      var r = helpers.runnerLabel(state.me);
      pill.textContent = r.text;
      pill.className = "chat-pill chat-pill-" + r.tone;
    }

    function renderBanner() {
      clear(banner);
      var c = state.conv;
      var text = "", actions = null, tone = "info";
      if (state.confirm === "edit") {
        text = "Edit mode lets Claude change files in its own copy of the projects and push branches named claude/…. It cannot touch main or merge anything; you open and merge the pull request yourself. Switch this chat to Edit?";
        actions = [["Switch to Edit", "primary", function () { state.confirm = null; setMode("edit"); }], ["Cancel", "", function () { state.confirm = null; renderBanner(); }]];
        tone = "warn";
      } else if (state.confirm === "delete") {
        text = "Delete this chat for good? Its messages cannot be brought back.";
        actions = [["Delete", "primary", function () { state.confirm = null; deleteConversation(); }], ["Cancel", "", function () { state.confirm = null; renderBanner(); }]];
        tone = "warn";
      } else if (state.notice) {
        text = state.notice; tone = "warn";
        actions = [["Dismiss", "", function () { state.notice = ""; renderBanner(); }]];
      } else if (isG && state.me && state.me.runner && !state.me.runner.online && !state.setup) {
        text = "Your Claude is not connected, so messages cannot be answered yet.";
        actions = [["Connect your Claude", "primary", function () { showSetup(true); }]];
        tone = "warn";
      } else if (!isG && state.me && state.me.runner && !state.me.runner.online) {
        text = "The runner is offline, so messages cannot be answered. It starts on the server (see runner/README.md in the ClaudeRepo project).";
        tone = "warn";
      } else if (c && c.mode === "edit") {
        text = "Edit mode: Claude can change files and push claude/ branches in this chat.";
        tone = "edit";
      } else if (state.streamStatus === "reconnecting") {
        text = "Connection lost. Reconnecting…";
      }
      banner.hidden = !text;
      banner.className = "chat-banner chat-banner-" + tone;
      if (!text) return;
      banner.appendChild(el("span", null, text));
      if (actions) {
        var row = el("span", "chat-banner-actions");
        actions.forEach(function (a) {
          var b = el("button", "chat-btn chat-btn-sm" + (a[1] ? " chat-btn-primary" : ""), a[0]);
          b.type = "button";
          b.addEventListener("click", a[2]);
          row.appendChild(b);
        });
        banner.appendChild(row);
      }
    }

    function renderComposer() {
      state.busy = helpers.isBusy(state.messages);
      var why = helpers.sendBlock({ conv: state.conv, busy: state.busy, me: state.me, text: box.value });
      sendBtn.disabled = !!why;
      sendBtn.title = why;
      sendBtn.hidden = state.busy;
      stopBtn.hidden = !state.busy;
      stopBtn.disabled = !!(state.conv && state.conv.stopping);
      stopBtn.textContent = state.conv && state.conv.stopping ? "Stopping…" : "Stop";
      box.disabled = !state.conv;
      var n = box.value.length;
      count.textContent = n > TEXT_MAX * 0.8 ? n.toLocaleString("en-AU") + " / " + TEXT_MAX.toLocaleString("en-AU") : "";
      count.className = "chat-count" + (n > TEXT_MAX ? " is-over" : "");
    }

    // -- thread ----------------------------------------------------------------
    function replyNode(m) {
      var body = el("div", "chat-md");
      if (m.text) {
        try { body.appendChild(MD.toDom(MD.parse(m.text), document, {})); } catch (e) { body.textContent = m.text; }
        // a copy button on each code block
        Array.prototype.forEach.call(body.querySelectorAll("pre"), function (pre) {
          var b = el("button", "chat-copy chat-copy-code", "Copy");
          b.type = "button";
          b.addEventListener("click", function () { copy(pre.textContent, b); });
          pre.appendChild(b);
        });
      }
      return body;
    }

    function copy(text, button) {
      var done = function () { if (button) { var old = button.textContent; button.textContent = "Copied"; setTimeout(function () { button.textContent = old; }, 1500); } };
      try { navigator.clipboard.writeText(text).then(done, function () { toast("Couldn’t copy."); }); } catch (e) { toast("Couldn’t copy."); }
    }

    function turnNode(t) {
      var wrap = el("article", "chat-turn");
      if (t.user) {
        var mine = el("div", "chat-msg chat-msg-user");
        var u = el("div", "chat-user");
        u.textContent = t.user.text;                 // plain text, line breaks kept by CSS
        mine.appendChild(u);
        var when = helpers.clockTime(t.user.ts);
        if (when) mine.appendChild(el("span", "chat-time", when));
        wrap.appendChild(mine);
      }
      var a = t.assistant;
      var active = !!a && helpers.isActiveStatus(a.status);
      if (t.tools.length) {
        var d = el("details", "chat-tools");
        d.appendChild(el("summary", null, helpers.toolSummary(t.tools, active)));
        var ul = el("ul");
        t.tools.forEach(function (x) { ul.appendChild(el("li", null, x.text)); });
        d.appendChild(ul);
        wrap.appendChild(d);
      }
      if (a) {
        var sig = a.status + "|" + a.text.length;
        var hit = cache[a.seq];
        var bodyNode;
        if (hit && hit.sig === sig) bodyNode = hit.node;
        else { bodyNode = replyNode(a); cache[a.seq] = { sig: sig, node: bodyNode }; }
        // Claude's side: a small avatar and a card with "Claude" and the time above the reply.
        var msgRow = el("div", "chat-msg chat-msg-claude");
        var avatar = el("span", "chat-avatar", "C");
        avatar.setAttribute("aria-hidden", "true");
        msgRow.appendChild(avatar);
        var card = el("div", "chat-card");
        var head = el("div", "chat-card-head");
        head.appendChild(el("span", "chat-who", "Claude"));
        var replied = helpers.clockTime(a.ts);
        if (replied) head.appendChild(el("span", "chat-time", replied));
        card.appendChild(head);
        var reply = el("div", "chat-reply chat-reply-" + a.status);
        if (a.text || !active) reply.appendChild(bodyNode);
        var label = helpers.statusLabel(a.status);
        if (label && !(a.status === "error" && a.text)) {
          var st = el("p", "chat-status" + (a.status === "error" ? " is-error" : ""));
          if (active) {
            var dots = el("span", "chat-dots");
            dots.setAttribute("aria-hidden", "true");
            for (var k = 0; k < 3; k++) dots.appendChild(el("i"));
            st.appendChild(dots);
          }
          st.appendChild(document.createTextNode(label));
          reply.appendChild(st);
        }
        card.appendChild(reply);
        if (a.status === "done" && a.text) {
          var actions = el("div", "chat-actions");
          var cb = el("button", "chat-copy", "Copy reply");
          cb.type = "button";
          cb.addEventListener("click", function () { copy(a.text, cb); });
          actions.appendChild(cb);
          card.appendChild(actions);
        }
        msgRow.appendChild(card);
        wrap.appendChild(msgRow);
      }
      return wrap;
    }

    function renderThread() {
      renderQueued = false;
      var turns = helpers.groupTurns(state.messages);
      clear(thread);
      if (!state.conv) {
        thread.appendChild(el("p", "chat-empty", "Start a chat to begin."));
      } else if (!turns.length) {
        var e = el("div", "chat-empty");
        e.appendChild(el("h2", "chat-empty-title", "How can I help?"));
        e.appendChild(el("p", "chat-dim", state.conv.mode === "edit"
          ? "This chat is in Edit mode: Claude can change files and push claude/ branches."
          : isG ? "Your Claude can read the folder you shared and answer questions. It cannot change anything."
          : "This chat is in Read mode: Claude can look at the projects and your Ops board but cannot change files."));
        var starters = el("div", "chat-starters");
        (isG ? helpers.STARTERS_GUEST : helpers.STARTERS).forEach(function (text) {
          var s = el("button", "chat-starter", text);
          s.type = "button";
          // Fills the box so it can be changed first; nothing is sent until Send.
          s.addEventListener("click", function () { box.value = text; renderComposer(); box.focus(); });
          starters.appendChild(s);
        });
        e.appendChild(starters);
        thread.appendChild(e);
      } else {
        turns.forEach(function (t) { thread.appendChild(turnNode(t)); });
      }
      var live = {};
      state.messages.forEach(function (m) { live[m.seq] = true; });
      Object.keys(cache).forEach(function (k) { if (!live[k]) delete cache[k]; });
      if (stick) thread.scrollTop = thread.scrollHeight;
      renderComposer();
    }
    function scheduleThread() {
      if (renderQueued) return;
      renderQueued = true;
      (window.requestAnimationFrame || setTimeout)(renderThread);
    }
    thread.addEventListener("scroll", function () { stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; });

    function renderAll() { renderList(); renderBar(); renderBanner(); renderThread(); }

    // -- connect your Claude (guests) ---------------------------------------------
    function code(text) { return el("code", null, text); }

    function showSetup(on) {
      state.setup = !!on;
      setupPanel.hidden = !state.setup;
      thread.hidden = state.setup;
      form.hidden = state.setup;
      if (connectBtn) connectBtn.setAttribute("aria-pressed", String(state.setup));
      if (state.setup) loadSetup(); else state.newToken = "";
      renderBanner();
    }

    function loadSetup() {
      renderSetup();
      transport.keys().then(function (r) { state.keys = r.keys || []; renderSetup(); }).catch(fail);
      if (!state.kitLoaded) transport.kit().then(function (k) { state.kit = k; state.kitLoaded = true; renderSetup(); });
    }

    function makeKey(label, days) {
      state.makingKey = true;
      renderSetup();
      transport.makeKey(label, days).then(function (r) {
        state.makingKey = false;
        state.newToken = r.token;
        state.keys = [r.key].concat(state.keys);
        var active = (state.me && state.me.keys ? state.me.keys.active : 0) + 1;
        state.me = Object.assign({}, state.me, { keys: { active: active } });
        renderSetup(); renderBar();
      }).catch(function (err) { state.makingKey = false; fail(err); renderSetup(); });
    }

    function revokeKey(id) {
      transport.revokeKey(id).then(function () {
        state.keys = state.keys.map(function (k) { return k.id === id ? Object.assign({}, k, { revoked: true }) : k; });
        state.newToken = "";
        renderSetup();
        pollStatus();
      }).catch(fail);
    }

    function renderSetup() {
      clear(setupPanel);
      var st = helpers.connectState(state.me);
      setupPanel.appendChild(el("h2", "chat-setup-title", "Connect your Claude"));
      setupPanel.appendChild(el("p", "chat-dim", "This chat can use your own Claude, running on your own computer with your own Claude subscription. Nothing about your Claude account is sent to Barnyard, it can only read one folder you choose, and it cannot change anything."));
      setupPanel.appendChild(el("p", "chat-setup-status chat-setup-" + (st === "connected" ? "ok" : "off"),
        st === "connected" ? "Connected: your Claude is online." : st === "waiting" ? "Waiting for your computer to connect…" : "Not connected yet."));

      var steps = el("ol", "chat-steps");

      // 1. the download
      var s1 = el("li");
      s1.appendChild(el("strong", null, "Download the runner. "));
      if (state.kit) {
        var dl = el("a", "chat-btn chat-btn-sm", "Download (" + helpers.sizeText(state.kit.bytes) + ")");
        dl.href = "guest-runner/" + state.kit.file;
        dl.setAttribute("download", state.kit.file);
        s1.appendChild(dl);
        var sum = el("p", "chat-hash");
        sum.appendChild(document.createTextNode("SHA-256: "));
        sum.appendChild(code(state.kit.sha256));
        s1.appendChild(sum);
      } else {
        s1.appendChild(el("span", "chat-dim", state.kitLoaded ? "The download is not available yet. Ask the hub owner." : "Looking for the download…"));
      }
      s1.appendChild(el("p", "chat-dim", "It needs Docker (Docker Desktop on Windows or Mac). Unzip it somewhere you will keep it."));
      steps.appendChild(s1);

      // 2. the key
      var s2 = el("li");
      s2.appendChild(el("strong", null, "Make a key "));
      s2.appendChild(document.createTextNode("for this computer. It is shown once."));
      if (state.newToken) {
        var box2 = el("div", "chat-newkey");
        var field = el("input", "chat-key-field");
        field.type = "text"; field.readOnly = true; field.value = state.newToken;
        field.setAttribute("aria-label", "Your new key");
        field.addEventListener("focus", function () { field.select(); });
        var cp = el("button", "chat-btn chat-btn-sm chat-btn-primary", "Copy");
        cp.type = "button";
        cp.addEventListener("click", function () { copy(state.newToken, cp); });
        box2.appendChild(field);
        box2.appendChild(cp);
        s2.appendChild(box2);
        var save = el("p", "chat-dim");
        save.appendChild(document.createTextNode("Save it as "));
        save.appendChild(code("secrets/chat_runner_key.txt"));
        save.appendChild(document.createTextNode(" (only the key, nothing else). Treat it like a password: you will not see it again."));
        s2.appendChild(save);
      } else {
        var f = el("form", "chat-keyform");
        var label = el("input", "chat-key-label");
        label.type = "text"; label.value = "My computer"; label.maxLength = 40; label.required = true;
        label.setAttribute("aria-label", "A name for this key");
        var life = el("select", "chat-key-life");
        life.setAttribute("aria-label", "How long the key lasts");
        helpers.KEY_LIFETIMES.forEach(function (o) { var opt = el("option", null, o[1]); opt.value = String(o[0]); if (o[0] === 90) opt.selected = true; life.appendChild(opt); });
        var go = el("button", "chat-btn chat-btn-sm chat-btn-primary", state.makingKey ? "Making…" : "Make key");
        go.type = "submit"; go.disabled = state.makingKey;
        f.appendChild(label); f.appendChild(life); f.appendChild(go);
        f.addEventListener("submit", function (e) { e.preventDefault(); makeKey(label.value.trim(), Number(life.value)); });
        s2.appendChild(f);
      }
      steps.appendChild(s2);

      // 3-5. the rest
      var s3 = el("li");
      s3.appendChild(document.createTextNode("Run "));
      s3.appendChild(code("claude setup-token"));
      s3.appendChild(document.createTextNode(" on your computer (it signs you in to your Claude), and save what it prints as "));
      s3.appendChild(code("secrets/claude_oauth_token.txt"));
      s3.appendChild(document.createTextNode("."));
      steps.appendChild(s3);
      var s4 = el("li");
      s4.appendChild(document.createTextNode("Put the folder Claude may read in a folder called "));
      s4.appendChild(code("shared"));
      s4.appendChild(document.createTextNode(". It is mounted read-only."));
      steps.appendChild(s4);
      var s5 = el("li");
      s5.appendChild(document.createTextNode("Run "));
      s5.appendChild(code("docker compose up -d --build"));
      s5.appendChild(document.createTextNode(". This page says Connected within a minute."));
      steps.appendChild(s5);
      setupPanel.appendChild(steps);
      setupPanel.appendChild(el("p", "chat-dim", "The README inside the download has the details, how to stop it, and what is and is not covered."));

      // your keys
      setupPanel.appendChild(el("h3", "chat-setup-sub", "Your keys"));
      var list = el("ul", "chat-keys");
      if (!state.keys.length) list.appendChild(el("li", "chat-dim", "No keys yet."));
      state.keys.forEach(function (k) {
        var li = el("li", "chat-key");
        var info = el("div", "chat-key-info");
        var head = el("div", "chat-key-head");
        head.appendChild(el("span", "chat-key-name", k.label));
        var s = helpers.keyState(k);
        head.appendChild(el("span", "chat-tag" + (s === "Active" ? "" : " chat-tag-off"), s));
        info.appendChild(head);
        info.appendChild(el("div", "chat-dim chat-key-meta", helpers.keyLine(k)));
        li.appendChild(info);
        if (s === "Active") {
          var rv = el("button", "chat-btn chat-btn-sm chat-btn-quiet", "Revoke");
          rv.type = "button";
          rv.addEventListener("click", function () { revokeKey(k.id); });
          li.appendChild(rv);
        }
        list.appendChild(li);
      });
      setupPanel.appendChild(list);
      var done = el("button", "chat-btn chat-btn-sm", "Back to the chat");
      done.type = "button";
      done.addEventListener("click", function () { showSetup(false); });
      setupPanel.appendChild(done);
    }

    // -- actions -----------------------------------------------------------------
    function apply(msg) {
      if (msg && msg.type === "deleted") { state.conv = null; state.messages = []; closeStream(); store(KEY_CURRENT, null); refreshList(); renderAll(); return; }
      var next = helpers.fold({ messages: state.messages, conv: state.conv }, msg);
      state.messages = next.messages;
      state.conv = next.conv;
      if (msg && (msg.type === "conversation" || msg.type === "message")) {
        if (msg.type === "conversation" && msg.conversation) {
          state.convs = state.convs.map(function (c) { return c.id === msg.conversation.id ? msg.conversation : c; });
          renderList(); renderBar();
        }
        renderBanner();
      }
      scheduleThread();
    }

    function closeStream() { if (state.stream) { state.stream.close(); state.stream = null; } }

    function refreshList() {
      return transport.list().then(function (r) { state.convs = r.conversations; renderList(); }).catch(function () { /* the next refresh retries */ });
    }

    function loadConversation(id) {
      return transport.open(id).then(function (r) {
        if (!state.conv || state.conv.id !== id) return;
        state.messages = r.messages;
        state.conv = r.conversation;
        stick = true;
        renderAll();
      });
    }

    function openConversation(id) {
      if (state.setup) showSetup(false);
      if (state.conv && state.conv.id === id) return;
      closeStream();
      state.conv = { id: id, title: "", mode: "read" };
      state.messages = [];
      state.confirm = null;
      state.notice = "";
      cache = {};
      store(KEY_CURRENT, id);
      renderAll();
      loadConversation(id).then(function () {
        state.stream = transport.connect(id, {
          onMessage: apply,
          onStatus: function (s) { state.streamStatus = s; renderBanner(); },
          // After every (re)connect fetch the whole chat again, so nothing said while away is missed.
          onOpen: function () { loadConversation(id).catch(function () { /* the next reconnect retries */ }); }
        });
      }).catch(function (err) {
        state.conv = null;
        store(KEY_CURRENT, null);
        fail(err);
        renderAll();
      });
    }

    function createConversation() {
      newBtn.disabled = true;
      transport.create({ mode: "read" }).then(function (r) {
        state.convs = [r.conversation].concat(state.convs);
        newBtn.disabled = false;
        openConversation(r.conversation.id);
        box.focus();
      }).catch(function (err) { newBtn.disabled = false; fail(err); });
    }

    function setMode(mode) {
      if (!state.conv) return;
      transport.patch(state.conv.id, { mode: mode }).then(function (r) {
        state.conv = r.conversation;
        state.convs = state.convs.map(function (c) { return c.id === r.conversation.id ? r.conversation : c; });
        renderAll();
      }).catch(fail);
    }

    function deleteConversation() {
      if (!state.conv) return;
      var id = state.conv.id;
      transport.remove(id).then(function () {
        closeStream();
        state.convs = state.convs.filter(function (c) { return c.id !== id; });
        state.conv = null; state.messages = [];
        store(KEY_CURRENT, null);
        renderAll();
        toast("Chat deleted.");
      }).catch(fail);
    }

    function rename() {
      if (!state.conv) return;
      var input = el("input", "chat-title-input");
      input.type = "text";
      input.value = state.conv.title || "";
      input.maxLength = 120;
      input.setAttribute("aria-label", "Chat name");
      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        var v = input.value.trim();
        if (input.parentNode) input.parentNode.replaceChild(titleBtn, input);
        if (save && v && v !== state.conv.title) {
          transport.patch(state.conv.id, { title: v }).then(function (r) {
            state.conv = r.conversation;
            state.convs = state.convs.map(function (c) { return c.id === r.conversation.id ? r.conversation : c; });
            renderList(); renderBar();
          }).catch(fail);
        }
      }
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", function () { finish(true); });
      bar.replaceChild(input, titleBtn);
      input.focus();
      input.select();
    }

    function send() {
      var why = helpers.sendBlock({ conv: state.conv, busy: state.busy, me: state.me, text: box.value });
      if (why) { if (box.value.trim()) say(why); return; }
      var text = box.value;
      sendBtn.disabled = true;
      transport.send(state.conv.id, text).then(function (r) {
        box.value = "";
        autosize();
        stick = true;
        [{ type: "message", message: r.message }, { type: "message", message: r.assistant }, { type: "conversation", conversation: r.conversation }].forEach(apply);
        state.notice = "";
        renderBanner();
        refreshList();
      }).catch(function (err) { fail(err); renderComposer(); });
    }

    function autosize() {
      box.style.height = "auto";
      box.style.height = Math.min(box.scrollHeight, 220) + "px";
    }

    // -- wiring ------------------------------------------------------------------
    newBtn.addEventListener("click", createConversation);
    if (connectBtn) connectBtn.addEventListener("click", function () { showSetup(!state.setup); });
    titleBtn.addEventListener("click", rename);
    readBtn.addEventListener("click", function () { if (state.conv && state.conv.mode !== "read") setMode("read"); });
    editBtn.addEventListener("click", function () { if (state.conv && state.conv.mode !== "edit") { state.confirm = "edit"; renderBanner(); } });
    delBtn.addEventListener("click", function () { if (state.conv) { state.confirm = "delete"; renderBanner(); } });
    stopBtn.addEventListener("click", function () {
      if (!state.conv) return;
      stopBtn.disabled = true;
      transport.stop(state.conv.id).catch(fail);
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
    box.addEventListener("input", function () { autosize(); renderComposer(); });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });

    // The runner pill and the queue are re-read now and then while the page is open (this also
    // tells the Worker the page is in use, so the runner polls quickly).
    function pollStatus() {
      if (document.hidden) return;
      transport.me().then(function (m) { state.me = m; renderBar(); renderBanner(); renderComposer(); if (state.setup) renderSetup(); }).catch(function () { /* keep the last answer */ });
    }
    setInterval(pollStatus, STATUS_POLL_MS);
    // While a guest is waiting for their computer to connect, look a little more often.
    setInterval(function () { if (isG && state.setup && helpers.connectState(state.me) === "waiting") pollStatus(); }, 5000);
    document.addEventListener("visibilitychange", pollStatus);

    // First view: the list, then the chat that was open (or the newest).
    refreshList().then(function () {
      var wanted = (location.hash || "").replace(/^#/, "") || recall(KEY_CURRENT);
      var pick = state.convs.filter(function (c) { return c.id === wanted; })[0] || helpers.newestFirst(state.convs)[0];
      renderAll();
      if (pick) openConversation(pick.id);
      else if (isG && helpers.connectState(state.me) === "need_key") showSetup(true);
    });
    renderAll();
  }

  function boot() {
    var root = document.getElementById("chat-root");
    if (!root) return;
    var gate = function (message, linkText, href) {
      clear(root);
      var card = el("div", "chat-gate");
      card.appendChild(el("p", null, message));
      if (href) {
        var a = el("a", "chat-btn chat-btn-primary", linkText);
        a.href = href;
        card.appendChild(a);
      }
      root.appendChild(card);
    };
    var authCheck = typeof window.barnyardAuthState === "function" ? window.barnyardAuthState() : Promise.resolve({ authenticated: false });
    authCheck.then(function (auth) {
      if (!auth.authenticated) {
        gate("The chat is private. Log in to use it.", "Log in", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null);
        return;
      }
      transport.me().then(function (me) { mount(root, me); }).catch(function (err) {
        if (err && err.code === "chat_disabled") gate("The chat is switched off. It is turned on in the Worker settings (CHAT_ENABLED).");
        else if (err && err.code === "board_required") gate("Open the Ops board once first: it sets up your own space. Then come back to this page.", "Open the Ops board", "ops.html");
        else if (err && err.code === "board_disabled") gate("Your space on the hub has been switched off by the owner.");
        else if (err && err.status === 403) gate("This chat is not open to you yet. The hub owner switches guest chats on.");
        else if (err && err.status === 401) gate("Your session has expired.", "Log in again", typeof window.barnyardLoginUrl === "function" ? window.barnyardLoginUrl() : null);
        else gate("Couldn’t reach the chat. Try again in a moment.");
      });
    });
  }

  if (typeof document !== "undefined" && document.getElementById && !window.__CHAT_NO_BOOT) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
})();
