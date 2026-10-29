// The Release board's wording and rules, with no DOM and no network (release.js uses them; test/release.test.js covers them).
//
// The Worker's GET /release/summary (ClaudeRepo's cloudflare-worker/src/release-routes.js) hands over, per repository, whether main is
// red and since when, the latest deploy and whether it is the commit on main, the open pull requests with their checks, the failing
// jobs and the owner's rollback note. Everything here turns that into the words, tones and order the page shows.
//
// Browser: window.BarnyardReleaseLogic. Node (tests): module.exports.

(function (root) {
  "use strict";

  var TZ = "Australia/Perth";
  var NOTE_MAX = 1200;

  // "3 min ago", "2 h ago", "4 days ago"; "never" for a missing time.
  function agoText(ts, now) {
    if (!ts) return "never";
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    var d = Math.round(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  // "Thu 30 Oct 14:42" in the owner's zone.
  function clockText(ms, tz) {
    try {
      var parts = new Intl.DateTimeFormat("en-AU", { timeZone: tz || TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
      return get("weekday") + " " + get("day") + " " + get("month") + " " + get("hour") + ":" + get("minute");
    } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  // The word and tone for a check or deploy state: pass, fail, running, queued, attention, neutral, none.
  var STATE = {
    pass: { word: "Passing", tone: "ok" }, fail: { word: "Failing", tone: "alert" }, running: { word: "Running", tone: "attn" },
    queued: { word: "Queued", tone: "attn" }, attention: { word: "Needs approval", tone: "attn" }, neutral: { word: "Skipped", tone: "" }, none: { word: "No checks", tone: "" }
  };
  function stateOf(state) { return STATE[state] || STATE.none; }
  function deployWord(state) { return state === "pass" ? "Deployed" : state === "fail" ? "Deploy failed" : state === "running" ? "Deploying" : "No deploy found"; }

  // The loud line at the top. tone "alert" when any main is red or a deploy failed, "attn" for ahead-of-live or a repository that could
  // not be read, "ok" when everything is green.
  function headlineModel(sum, now) {
    var h = sum && sum.headline;
    if (!h) return { tone: "", title: "", lines: [] };
    var lines = [];
    if (h.redRepos && h.redRepos.length) lines.push("Main is red in " + h.redRepos.join(", ") + ".");
    if (h.failedDeploys && h.failedDeploys.length) lines.push("The last deploy failed in " + h.failedDeploys.join(", ") + ".");
    if (h.aheadRepos && h.aheadRepos.length) lines.push("Main is ahead of what is live in " + h.aheadRepos.join(", ") + ".");
    if (h.errors && h.errors.length) lines.push("Could not read " + h.errors.join(", ") + ".");
    var tone = (h.redRepos && h.redRepos.length) || (h.failedDeploys && h.failedDeploys.length) ? "alert" : lines.length ? "attn" : "ok";
    var title = tone === "alert" ? (h.redRepos && h.redRepos.length ? "Main is red" : "A deploy failed")
      : tone === "attn" ? "Needs a look" : "Everything is green";
    if (tone === "ok") lines.push(h.openPulls ? h.openPulls + (h.openPulls === 1 ? " pull request is open." : " pull requests are open.") : "No pull requests are open.");
    return { tone: tone, title: title, lines: lines };
  }

  // One repository's card, as text. `row` is one item of the summary's rows (or one with .error).
  function repoModel(row, note, now) {
    var out = { name: row.name, label: row.label || "", url: row.url || "", site: row.site || "", error: null, tone: "", chips: [], main: "", redLine: "", failing: [], deploy: "", deployUrl: "", pulls: [], attention: [], note: note || { text: "", custom: false, at: null } };
    if (row.error) { out.error = row.error.message || "GitHub could not be read for this repository."; out.tone = "attn"; return out; }
    var ci = stateOf(row.ci && row.ci.state);
    out.chips.push({ label: "Main", word: ci.word, tone: ci.tone });
    var d = row.deploy || {};
    var dw = deployWord(d.state);
    out.chips.push({ label: "Live", word: dw, tone: d.state === "pass" ? (d.ahead ? "attn" : "ok") : d.state === "fail" ? "alert" : d.state === "running" ? "attn" : "" });
    if (d.ahead) out.chips.push({ label: "Live", word: "Behind main", tone: "attn" });
    var m = row.main;
    out.main = m ? (m.message || "(no message)") + (m.short ? " (" + m.short + ", " + agoText(m.at, now) + ")" : "") : "";
    if (row.ci && row.ci.red) {
      out.redLine = "Red" + (row.ci.since ? " since " + clockText(row.ci.since) + " (" + agoText(row.ci.since, now) + ")" : "");
      out.tone = "alert";
    }
    out.failing = (row.failingJobs || []).map(function (j) {
      return { text: (j.workflow ? j.workflow + ": " : "") + (j.job || "a job") + (j.step ? ", step " + j.step : ""), url: j.url || "" };
    });
    if (d.state && d.state !== "none") {
      out.deploy = (d.name || "Deploy") + ": " + dw.toLowerCase() + " " + agoText(d.at, now) + (d.short ? ", commit " + d.short : "") +
        (d.matchesMain === true ? ", the same as main" : d.matchesMain === false ? (d.ahead ? ", but main is ahead" : ", main has a newer commit") : "");
      out.deployUrl = d.url || "";
    } else out.deploy = "No deploy found yet.";
    out.pulls = (row.pulls || []).map(function (p) { return pullModel(p, now); });
    out.attention = row.attention || [];
    if (!out.tone && (d.state === "fail")) out.tone = "alert";
    if (!out.tone && (d.ahead || out.pulls.some(function (p) { return p.tone === "alert"; }))) out.tone = "attn";
    if (!out.tone) out.tone = "ok";
    return out;
  }

  function pullModel(p, now) {
    var st = stateOf(p.ci);
    return {
      number: p.number, title: p.title, author: p.author, draft: !!p.draft, url: p.url || "", branch: p.branch || "",
      age: p.ageDays === null || p.ageDays === undefined ? "" : p.ageDays === 0 ? "today" : p.ageDays + (p.ageDays === 1 ? " day" : " days"),
      checks: st.word, tone: p.draft ? "" : st.tone, stale: (p.ageDays || 0) >= 7
    };
  }

  // Red repositories first, then the rest by the order the Worker listed them.
  function orderRows(rows) {
    var rank = function (r) { return r.error ? 1 : (r.ci && r.ci.red) || (r.deploy && r.deploy.state === "fail") ? 0 : 2; };
    return (rows || []).map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) { return rank(a.r) - rank(b.r) || a.i - b.i; }).map(function (x) { return x.r; });
  }

  // The plain-words text for a failed request.
  function errorText(body, status) {
    var e = body && body.error;
    if (status === 401 || e === "unauthenticated") return "Sign in to see the Release board.";
    if (status === 403 && e === "recent_sign_in_required") return "Sign in again to save a note (a recent sign-in is needed), then save it again.";
    if (status === 403 && e === "release_disabled") return "The Release board is switched off.";
    if (status === 403) return "The Release board is only for the hub owner.";
    if (status === 429) return "GitHub was read a moment ago. Try again in " + Math.max(1, Math.ceil(((body && body.retryMs) || 30000) / 1000)) + " seconds.";
    if (e === "secret_detected") return "That note looks like it holds a password or key. Take it out and save again.";
    if (e === "text_too_long") return "That note is too long (" + NOTE_MAX + " characters at most).";
    if (status === 0) return "Could not reach the Worker. Try again.";
    return "Something went wrong (" + (e || status) + ").";
  }

  var api = {
    NOTE_MAX: NOTE_MAX, agoText: agoText, clockText: clockText, stateOf: stateOf, deployWord: deployWord, headlineModel: headlineModel,
    repoModel: repoModel, pullModel: pullModel, orderRows: orderRows, errorText: errorText
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarnyardReleaseLogic = api;
})(typeof window !== "undefined" ? window : this);
