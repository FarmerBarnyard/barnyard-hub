# Looks: the author guide

A **look** is how every page is laid out and worded: structure, type, icons, wording. It is the third choice in Settings, Appearance, beside the colour **theme** and the **background**, and it saves the same way (this browser, the shared `bh_prefs` cookie, and the signed-in profile, so it follows the person to any browser).

* There are 18 looks. **Original** is today's look and is never changed. The other 17 are drawn (mock-ups published in the gallery at `/looks/`) and are built one at a time. A look that is drawn but not built is **shown** in the gallery (disabled, "Designed, not built yet") so the whole set can be seen.
* Every look sits **under** the theme, background, density and sidebar settings, which apply on top of it. Every one of the 18 themes, light and dark, and every background must still work with your look.

## Adding a look: the whole checklist

You change **only your own files and your own registry line**, so many people can add looks in parallel without conflicts.

1. **Registry line** in `themes.js` (the `LOOKS` list; one entry per line, a `// ----` comment line between entries). The entries for all 17 looks already exist with `installed: false`. Edit only your line:

   | field | meaning |
   |---|---|
   | `id` | the slug, never changed. It is the saved value and the file name |
   | `name`, `blurb` | what the gallery shows; the blurb is one line, 10 to 80 characters |
   | `group` | `original`, `documents`, `apps`, `maps` or `text` (a family, for sorting the guide) |
   | `installed` | change `false` to `true` **in the same PR that adds the layer**, never earlier |
   | `renderer` | `true` only if the look draws its own markup for some pages (see "A look that draws its own markup") |
   | `v`, `jv` | cache versions of your `.css` and `.js`; **never edit by hand**: `node tools/stamp-assets.js` rewrites them |
   | `sketch` | the gallery thumbnail, see below |

2. **The layer**: `look-layers/<id>.css` (and `look-layers/<id>.js` only if `renderer: true`). Nothing else in the repo changes for a pure CSS look.
3. **Run the checks** (below). `node tools/stamp-assets.js` after any change to the layer.
4. **Do not touch** `shell.js`, `shell.css`, `looks.md`, other looks' files, or other registry lines. If the look cannot be done without a shell change, say so in the PR: shell changes go through the shared-shell route (copied to Study, Campaign and Stocks).
5. After merge the coordinator runs `node tools/sync-shell.js` to copy `themes.js` and your `look-layers/` files to the other three sites.

## What a layer may do

* **Every rule is scoped**: each selector starts with `html[data-look="<id>"]`. That is how a look can never change Original or another look. `@media` and `@supports` blocks are fine (the selectors inside are checked). `@keyframes` is allowed if the name starts with `<id>-`. `@import`, `@font-face` and `@charset` are not.
* **Colours come only from the theme's variables**, never a literal: `--bg --panel --panel-2 --line --fg --fg-strong --fg-dim --accent --accent-ink --accent-soft --attn --attn-soft`. (`--attn` is the "needs you" colour, `--accent-ink` is the text colour for text on `--accent`.) This is what makes all 18 themes, light and dark, recolour your look. `transparent`, `currentColor`, `inherit` and `none` are fine; shadows may use `rgba()`.
* **No `url()`** at all (the page's policy allows no images from a layer; draw with CSS), no `expression()`, no `behavior`.
* **Type**: use `var(--font-display)`, `var(--font-body)` and `var(--font-mono)` (the shell's bundled IBM Plex and Bricolage Grotesque) or system font stacks. No font download, no `@font-face`.
* **The markup is the page's own**: the shell is `.app` > `.side` (sidebar: `.brand`, `.nav`, `.nav-group`, `.side-foot`) + `.main` > `.content`; pages have `.page-head`, `.hero` (Overview), `.widgets` > `.w`, `.need`, `.btn`. Read `shell.css` and the page's own `.css` for the classes. Prefer restyling over markup changes. Page-specific classes belong to the page; if a look needs a different structure for a page, use a renderer.
* **Settings that must keep working in every look**: `html[data-sidebar="icons"]` (icons-only sidebar; a look that has no sidebar must say in its PR how the setting is retired: the Sidebar control stays visible and harmless), `html[data-density="compact"]`, `html[data-bg]` / `.bgx-<id>` backgrounds (they paint on `.bg`; a look may dim or hide the background layer for legibility but must not break it), `html[data-theme]` light and dark, reduced motion, keyboard focus (a visible `:focus-visible`), 4.5:1 text contrast.
* **Original must be byte for byte untouched.** If your layer works, Original loads no extra file at all.

## A look that draws its own markup (`renderer: true`)

Day Line, Lines and Grid 9 need their own markup for some pages. Convention: **one renderer function per page, registered from `look-layers/<id>.js`**, chosen by the page's own script:

```js
// look-layers/grid-9.js  (plain script, no modules, no inline code in pages)
BarnyardTheme.look.register("grid-9", "overview", function (model, mount) {
  // draw into `mount` from the page's data model with DOM calls (createElement / textContent: never innerHTML)
});
```

```js
// in the page's script (overview.js, ops.js ...), where it draws:
var render = window.BarnyardTheme && BarnyardTheme.look.renderer("overview");   // null unless the current look draws this page
if (render) render(model, mount); else drawDefault(model, mount);
```

* The page names its own `pageId` (`"overview"`, `"ops"`, ...) and passes the **same data model** it would draw itself, so a renderer never fetches anything.
* A page a look does not register draws as usual (so a look can start with the Overview and Ops board and add pages later).
* `BarnyardTheme.look.whenReady(fn)` runs `fn` once the look's layer (css and js) has loaded; the page should start drawing from it, so it never draws twice.
* Changing to or from a renderer look reloads the page (the gallery does this for you).
* The hook calls in the page scripts are a small hub-only change in the PR that adds the look; the guard above keeps every other look and Original unchanged.

## The thumbnail (`sketch`)

No image files. The gallery draws each look's preview from rectangles in **percent**, in the theme's own colours, so it also shows how the look wears each theme:
`"x,y,w,h,tone;x,y,w,h,tone;..."` (up to 20 rectangles), tones `p` panel, `q` panel-2, `l` line, `a` accent, `d` fg-dim, `s` fg-strong, `n` needs-you. Keep it a rough wireframe of your Overview. Every look has a first draft; improve your own.

## The checks (run these before the PR; CI runs them too)

```
node tools/look-lint.js <id>        # scoping, theme colours, no url(), contrast in all 36 theme and mode combinations
node tools/stamp-assets.js          # sets v / jv in your registry line from your files
node test/looks.test.js             # every look in the registry, no test edits needed
node test/themes.test.js && node test/cache-tags.test.js && node test/page-shell.test.js
```

`test/looks.test.js` walks the registry, so **adding a look needs no test edits**: it checks your registry line (slug id, blurb, group, flags, 8-hex versions, a valid sketch), that `installed: true` has `look-layers/<id>.css` (and `.js` iff `renderer: true`), that every selector is scoped, that nothing uses a literal colour or `url()`, and **contrast in all 36 theme and mode combinations** (18 themes, light and dark). Contrast is read from your CSS: where one rule sets both `color: var(--x)` and a `background: var(--y)`, that pair is checked; a rule with only a text colour is checked on `--panel` and `--bg`. For a pair the CSS cannot show (text on something a parent paints) declare it anywhere in the file:

```css
/* contrast: --fg-dim on --panel-2; --accent-ink on --accent */
```

Known weak combinations the designers found: **Amber light, `--accent` as text on the page (4.38:1)** and **Dusk dark, `--fg-dim` on a selected row (4.46:1)**: do not use accent as text on `--bg`, and use `--fg` on selected rows. The linter will tell you if you do.

## Review checklist for the PR

* Only your registry line, your `look-layers/<id>.*`, and (for a renderer look) the small hook calls in the page scripts changed.
* `installed: true` set, `v`/`jv` stamped, the sketch looks like your look.
* Original is unchanged: open the page with Original selected and with your look; Original must not request `look-layers/`.
* Light and dark, two or three themes, two or three backgrounds, compact density, icons-only sidebar, narrow window, keyboard focus.
* Screenshots in the PR.
