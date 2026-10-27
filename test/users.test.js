// Coverage for users.js's pure helpers (the page behind /users/*): what the groups allow, the lowest-wins rule the
// Worker also applies, the preview, the list filters and the plain-words errors. The DOM and network parts were
// exercised in a real browser against a stand-in for the Worker.
//
//   node test/users.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var U = require(path.join(__dirname, "..", "users.js"));
var root = path.join(__dirname, "..");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

var NOW = Date.parse("2026-11-10T06:00:00Z");
var DAY = 86400000;
var GROUP_IDS = { hub: "barnyard-hub-sso", study: "study-hub-sso", campaign: "campaign-hub-sso" };
var CAT = {
  groups: GROUP_IDS,
  areas: [
    { id: "overview", label: "Overview", kind: "tab", needs: "any", levels: ["view"] },
    { id: "ops", label: "Ops board", kind: "tab", needs: "hub", levels: ["view", "edit"] },
    { id: "kb", label: "Knowledgebase (read)", kind: "tab", needs: "study", levels: ["view"] },
    { id: "kb.publish", label: "Knowledgebase (publish and edit)", kind: "capability", needs: "study", levels: ["edit"] },
    { id: "users", label: "Users", kind: "tab", needs: null, levels: ["view", "edit"] },
    { id: "tile.assets", label: "Assets tile", kind: "tile", needs: null, levels: ["view", "edit"] },
    { id: "tile.prices", label: "Prices tile", kind: "tile", needs: "any", levels: ["view"] }
  ],
  presets: []
};
var ALL = ["barnyard-hub-sso", "study-hub-sso"];
var by = {}; CAT.areas.forEach(function (a) { by[a.id] = a; });

test("group labels are plain names and ignore anything else", function () {
  assert.deepStrictEqual(U.groupLabels(["study-hub-sso", "barnyard-hub-sso", "x", "study-hub-sso"]), ["Study", "Hub"]);
  assert.deepStrictEqual(U.groupLabels(null), []);
});

test("how long ago is said in words", function () {
  assert.strictEqual(U.agoText(null, NOW), "never");
  assert.strictEqual(U.agoText(NOW - 20000, NOW), "just now");
  assert.strictEqual(U.agoText(NOW - 5 * 60000, NOW), "5 min ago");
  assert.strictEqual(U.agoText(NOW - 3 * 3600000, NOW), "3 h ago");
  assert.strictEqual(U.agoText(NOW - DAY, NOW), "1 day ago");
  assert.strictEqual(U.agoText(NOW - 90 * DAY, NOW), "3 months ago");
});

test("what the groups allow: owner-only areas never, any-group areas for any group, edit where the area has it", function () {
  assert.strictEqual(U.baseLevel(by.ops, ALL, GROUP_IDS), "edit");
  assert.strictEqual(U.baseLevel(by.ops, ["study-hub-sso"], GROUP_IDS), "none");
  assert.strictEqual(U.baseLevel(by.kb, ["study-hub-sso"], GROUP_IDS), "view");
  assert.strictEqual(U.baseLevel(by["kb.publish"], ["study-hub-sso"], GROUP_IDS), "edit");
  assert.strictEqual(U.baseLevel(by.overview, ["campaign-hub-sso"], GROUP_IDS), "view");
  assert.strictEqual(U.baseLevel(by.overview, [], GROUP_IDS), "none");
  assert.strictEqual(U.baseLevel(by.users, ALL, GROUP_IDS), "none");
  assert.strictEqual(U.baseLevel(by["tile.assets"], ALL, GROUP_IDS), "none");
});

test("a cap only lowers: the lowest wins, and an edit-only capability has no read-only form", function () {
  assert.strictEqual(U.effectiveLevel(by.ops, "edit", "view"), "view");
  assert.strictEqual(U.effectiveLevel(by.ops, "edit", "none"), "none");
  assert.strictEqual(U.effectiveLevel(by.ops, "view", "edit"), "view");
  assert.strictEqual(U.effectiveLevel(by.ops, "edit", undefined), "edit");
  assert.strictEqual(U.effectiveLevel(by.ops, "none", "view"), "none", "a cap never grants");
  assert.strictEqual(U.effectiveLevel(by["kb.publish"], "edit", "view"), "none");
});

test("a person's state: owner, suspended, ended by date, or active", function () {
  assert.strictEqual(U.statusOf({ isOwner: true, status: "suspended" }, NOW), "owner");
  assert.strictEqual(U.statusOf({ status: "suspended" }, NOW), "suspended");
  assert.strictEqual(U.statusOf({ status: "active", until: "2026-11-09" }, NOW), "expired");
  assert.strictEqual(U.statusOf({ status: "active", until: "2026-11-10" }, NOW), "active", "the last day counts");
  assert.strictEqual(U.statusOf({ status: "active", until: "" }, NOW), "active");
});

test("the preview lists what they would see and counts what is hidden by the owner settings", function () {
  var p = U.previewModel(CAT, ALL, { ops: "view", "kb.publish": "none" }, "active");
  assert.deepStrictEqual(p.tabs.map(function (t) { return t.label + (t.readOnly ? "*" : ""); }), ["Overview", "Ops board*", "Knowledgebase (read)"]);
  assert.deepStrictEqual(p.capabilities, []);
  assert.deepStrictEqual(p.tiles.map(function (t) { return t.id; }), ["tile.prices"]);
  assert.strictEqual(p.hidden, 1, "one area the groups allow is hidden by the cap (the owner-only ones do not count)");
  var s = U.previewModel(CAT, ALL, {}, "suspended");
  assert.strictEqual(s.tabs.length + s.tiles.length + s.capabilities.length, 0);
  var none = U.previewModel(CAT, [], {}, "active");
  assert.strictEqual(none.tabs.length, 0);
});

test("the list filters by name or email and by status", function () {
  var users = [
    { key: "a", name: "Ada Example", email: "ada@example.org", status: "active", until: "", caps: {} },
    { key: "b", name: "Bo Example", email: "bo@example.org", status: "active", until: "", caps: { ops: "none" } },
    { key: "c", name: "Cy Example", email: "cy@example.org", status: "suspended", until: "", caps: {} },
    { key: "d", name: "Di Example", email: "di@example.org", status: "active", until: "2026-01-01", caps: {} }
  ];
  var keys = function (r) { return r.map(function (u) { return u.key; }).join(""); };
  assert.strictEqual(keys(U.filterUsers(users, "", "all", NOW)), "abcd");
  assert.strictEqual(keys(U.filterUsers(users, "BO@", "all", NOW)), "b");
  assert.strictEqual(keys(U.filterUsers(users, "", "restricted", NOW)), "b");
  assert.strictEqual(keys(U.filterUsers(users, "", "suspended", NOW)), "c");
  assert.strictEqual(keys(U.filterUsers(users, "", "ended", NOW)), "d");
  assert.strictEqual(keys(U.filterUsers(users, "", "active", NOW)), "ab");
});

test("errors from the Worker are said in plain words", function () {
  assert.ok(/recent sign-in/.test(U.errorText({ error: "recent_sign_in_required" })));
  assert.ok(/owner cannot be/.test(U.errorText({ error: "owner_protected" })));
  assert.ok(/password or key/.test(U.errorText({ error: "secret_detected" })));
  assert.ok(/not valid/.test(U.errorText({ error: "until_invalid" })));
  assert.ok(/Try again/.test(U.errorText({ error: "weird" })));
  assert.ok(/Try again/.test(U.errorText(null)));
});

test("an audit line reads as a sentence", function () {
  assert.strictEqual(U.auditText({ action: "suspend" }), "Suspended");
  assert.strictEqual(U.auditText({ action: "restore" }), "Restored");
  assert.strictEqual(U.auditText({ action: "permissions", detail: "Viewer; ops=none" }), "Permissions changed: Viewer; ops=none");
  assert.strictEqual(U.auditText({ action: "first_seen", detail: "first sign-in" }), "First seen (first sign-in)");
});

test("the page is wired up: the same CSP as the other pages, scripts from this site only, server text through textContent", function () {
  var html = fs.readFileSync(path.join(root, "users.html"), "utf8");
  assert.ok(/script-src 'self'/.test(html) && /connect-src 'self' https:\/\/api\.barnyard\.site/.test(html));
  assert.ok(!/<script>[^<]/.test(html), "no inline script");
  assert.ok(/users\.js/.test(html) && /users\.css/.test(html) && /shell\.js/.test(html));
  var js = fs.readFileSync(path.join(root, "users.js"), "utf8");
  assert.ok(!/innerHTML/.test(js));
});

test("every menu item names a permission the Worker can take away, and the Users item is the owner's alone", function () {
  var shell = fs.readFileSync(path.join(root, "shell.js"), "utf8");
  var items = shell.match(/\{ id: "[a-z]+", title: "[^"]+", group: "[^"]*", icon: "[a-z]+"[^}]*\}/g) || [];
  assert.ok(items.length >= 11, "the nav table was found");
  items.forEach(function (it) { assert.ok(/perm: "[a-z]+\.view"/.test(it), "no permission on: " + it); });
  var users = items.filter(function (it) { return /id: "users"/.test(it); })[0];
  assert.ok(users && /ownerOnly: true/.test(users) && /perm: "users\.view"/.test(users));
  // the same ids the Worker's catalogue uses (access-catalogue.js): overview, ops, vuln, calendar, monitoring, users, chat, study, notebook, kb, campaign, stocks
  var known = ["overview", "ops", "vuln", "calendar", "monitoring", "users", "chat", "study", "notebook", "kb", "campaign", "stocks"];
  items.forEach(function (it) { var m = /perm: "([a-z]+)\.view"/.exec(it); assert.ok(known.indexOf(m[1]) !== -1, "unknown area " + m[1]); });
});

console.log("\n" + passed + " passed");
