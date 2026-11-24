# Look Q: Classic Desktop

A 1990s to 2000s desktop-application look done with restraint: window frames with title bars, bevelled buttons, a menu bar, a toolbar of text buttons, tabs, sunken list views, group boxes and a status bar. The default feel is Windows 2000: a cool grey-slate face with a blue title bar (Cobalt light). Every colour comes from the theme tokens, so other themes recolour it (Stone gives a warm Windows 95 grey, the dark themes a dark classic).

Mockup: `Q-classic-desktop.html` (open it in a browser; no network, no downloads). Screenshots: `shots\Q-default.png`, `Q-dark-plum-scales-ops.png`, `Q-notree-rose-ledger.png`, `Q-narrow.png`.

## Why this look, for this owner

An administrator already works in this idiom all day: Event Viewer, Services, Task Scheduler, MMC consoles. The metaphor tells the eye where things are before reading: left tree is where, tabs are which page, list views are the data, the status bar says how many need me. A selected row is highlighted in the accent colour exactly like every list in an admin tool, and the toolbar acts on the selected row (`Mark done`, `Open`). Dense, crisp, keyboard friendly, and unmistakably not a web-template look. It is also the most familiar for the owner's other tools, which lowers the cost of scanning.

## Layout rules (what replaces rounded cards and accent rails)

- A window: 3 px raised frame, 24 px title bar (the accent colour, accent-ink text, fake minimise/maximise/close drawn as text), menu bar, toolbar, tab strip, body, status bar.
- Body is a tree pane (the sidebar) at the left, 190 px, and a scrolling pane at the right.
- Each section is a group box (a grooved frame with a bold legend). Inside is a list view: a sunken white field, raised column-header buttons, dotted row rules, selected row in the accent colour.
- Settings is a second, inactive-style window named Display Properties, with group boxes (Colour scheme, Desktop pattern, Layout). It can be closed and reopened from the toolbar or the Display menu.
- The page background is the desktop: backgrounds are a wallpaper pattern behind the windows.
- No rounded corners anywhere; bevels are 2 px box-shadows, not images.

## Type

`Tahoma, "Segoe UI", Verdana, Geneva, sans-serif` at 14 px (13 px compact): the classic admin-tool face, already on every Windows PC; fallback is the system sans. `Lucida Console` / `Courier New` for ids and times. No webfonts, no downloads.

## Icons

No pictures. The only symbols are text: `[-]` for tree folders, `[x]` and `( )`/`(o)` for menu check marks, `_`, `[ ]`, `x` on the title-bar buttons, and a small 11 px coloured square beside each state word (down, degraded, up). The state is always the word as well as the square.

## Tone of voice (five rewrites)

| Now | Classic Desktop |
|---|---|
| Waiting on you | Decisions and approvals |
| Settings | Display Properties |
| Log in | Sign in... |
| Couldn't load your events | The calendar could not be read. Choose Refresh to try again. |
| Nothing is waiting | No items need a decision. |

Rules: the voice of a dialog box: short noun titles, buttons that name the action (Refresh, Open, Mark done, Close), three dots for something that opens a dialog, errors say what failed and which command retries it, status bar counts in digits.

## AI clichés it avoids

The identical rounded card with an accent rail and soft shadow, gradient washes, the big number in a tile, the small-caps eyebrow above every heading, near-black with one acid accent, cream and terracotta, Inter and Space Grotesk, emoji and line-icon markers, centred layouts, fade-and-rise motion. The only accent surface is the title bar and the selected row.

## Colour themes and backgrounds

All 18 real themes (light and dark) work. The window face is `--line` mixed 78% with `--panel`; highlights and shadows are derived from that and `--fg-dim`; list views use `--panel`; title bar and selection use `--accent` with `--accent-ink`; the inactive title bar uses `--fg-dim` with `--panel`. The 18 CSS-only backgrounds work as a desktop pattern: Dots, Scales, Lattice, Stripes, Grid and Blueprint are literally the Windows 95 pattern wallpapers; Plain, Glow and Mesh read as a plain or soft wallpaper. Aurora, Spotlight and Horizon feel too modern for the idiom (they work, they just do not fit); Ledger's red margin line runs behind the windows. Windows are opaque, so no background hurts readability.

## What it changes in the shared shell (implement as a `look`)

1. `themes.js`: the new `look` setting (validated list, localStorage, `bh_prefs` cookie code, profile sync) that sets `data-look="classic"` on `<html>`.
2. `look-classic.css` (new, hand-copied, scoped to `html[data-look="classic"]`): the bevel variables, window frame, title bar, menu bar, toolbar, tabs, list views, group boxes, status bar.
3. `shell.js`: a second chrome builder. The current sidebar becomes the tree pane (same links, tree glyphs); the top bar becomes title bar + menu bar + toolbar; the page tabs become the tab strip; the Settings panel becomes the Display Properties window (the same controls); a status bar at the bottom shows the counts. Page scripts keep their DOM; widgets/tiles are restyled as group boxes with list views by CSS where they render rows, and the tile pages (market, weather) need a small row renderer.
4. The copy table per look, as for P.

Sidebar setting: `full` shows the tree pane; `icons` hides the tree pane (the tabs and the menu remain), exactly as the mockup's "Show the tree pane" switch.

## Contrast (4.5:1 in all 36 theme and mode combinations)

Checked by the look's own script over all 18 themes x light and dark: 216 pair-checks, 0 failures. Pairs: `--fg-strong` on the face (worst 12.41, Arctic dark) and `--fg` on the face (worst 9.51), `--fg-strong` on `--panel` (worst 15.71, Steel dark), `--accent-ink` on `--accent` (title bar, menu hover, selected row; worst 4.88, Amber light), `--panel` on `--fg-dim` for the inactive title bar (worst 5.57, Arctic light), and `--fg-dim` on `--panel` for dotted row rules only (3:1 required). No pair fails. Not used as text: `--accent` on the page (Amber light 4.38) and muted text on a selected row (Dusk dark 4.46): selected rows use `--accent-ink` only.

## Effort

About 7 to 10 Engineer days: the chrome builder in `shell.js` and the Settings window (3 to 4 days), the CSS layer for bevels, list views and group boxes (2 to 3 days), keyboard behaviour for menus and rows (1 to 2 days), the tile-to-list conversions (1 to 2 days). It is the most work of the two looks I built, because it changes the shell structure, not only styling.

## What was checked, and doubts

Built from the real `themes.js` token table (all 18) and the real background CSS from `shell.css`. Rendered in headless Edge: Cobalt light with Plain, Plum dark with Scales (Ops board), Rose dark with Ledger and the tree hidden, and Stone light with Dots at 420 px; normal and compact. A scripted interaction test (`tools\smoke-PQ.html`) passes: View menu opens and switches pages, row selection, Mark done toggles, Display menu sets dark and compact, Display Properties closes and reopens, theme and background selects change tokens and class, the tree pane hides, 18 themes and 18 backgrounds selectable. Doubts: not tested in a screen reader (roles are set: menubar, menuitem, tablist, tab, dialog, status), arrow-key menu navigation is basic and untested by hand; the narrow layout stacks the tree above the list but the headless window is wider than 420 px, so true phone width is untested; the bevel colours are derived, so a very light or very dark theme face could look flat (Cobalt, Plum, Rose and Stone were looked at; the other themes are covered by the contrast numbers only); the window title-bar buttons are decorative, not working.
