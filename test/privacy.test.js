// The public privacy page: it exists, stays inside the site's CSP, and says the
// things the hub's behaviour requires it to say (so the page cannot quietly drift
// from what the Worker does).
//
//   node test/privacy.test.js

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var html = fs.readFileSync(path.join(root, "privacy.html"), "utf8");
var text = html.replace(/<[^>]+>/g, " ").replace(/&rsquo;|&ldquo;|&rdquo;/g, "'").replace(/\s+/g, " ");

var passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok - " + name); }

test("no inline script or style, no remote resources", function () {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline script");
  assert.ok(!/\sstyle=/i.test(html), "no inline style attributes");
  assert.ok(!/(src|href)="https?:\/\//i.test(html), "nothing loaded from another site");
  assert.ok(/default-src 'self'/.test(html));
  assert.ok(fs.existsSync(path.join(root, "privacy.css")));
});

test("it states the things the hub's behaviour makes true", function () {
  [
    /12 hours/,                                   // session length
    /outside Australia/,                          // residency disclosure
    /Oceania/,                                    // location hint
    /30 days/,                                    // Cloudflare recovery history
    /Nothing is deleted on a timer/,              // retention stance
    /Export/, /Redact/, /Delete my board/, /Sign out everywhere/, /revoke/i,
    /Notifiable Data Breaches/,
    /Only a fingerprint of each key is kept/,
    /does not send your board to any AI service/,
    /password, key or token/
  ].forEach(function (re) { assert.ok(re.test(text), String(re)); });
});

test("it is linked from the board's first screen and from Settings, Your data", function () {
  var agent = fs.readFileSync(path.join(root, "agent-setup.js"), "utf8");
  assert.strictEqual((agent.match(/privacy\.html/g) || []).length, 2);
});

test("it does not publish a contact address or any personal detail", function () {
  assert.ok(!/@/.test(text));
});

console.log("\n" + passed + " tests passed");
