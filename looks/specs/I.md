# I. Paper Terminal

**Mockup:** `I-paper-terminal.html`. Screenshots: `shots\i1.png` (Stone light, Today), `i2.png` (Copper dark, Dots, Ops board), `i3.png` (Olive light, Ledger, Calendar), `i4.png` (Stone dark, Grid, compact, Calendar).

## Rationale
Administrators trust text screens: they are fast, nothing moves, every line has the same weight, and you know exactly where to look. Paper Terminal is a text-mode screen on a fixed grid of characters (132 columns by 33 rows): a double-line outer frame, single-line panels with their titles set into the border, a selection bar in inverse video like a file manager, and a bar of numbered keys along the bottom. It is NOT neon on black: the screen is the theme's paper colour with the theme's ink, so on Stone or Copper light it reads like a printed listing, and on Stone dark like soft charcoal. You scan down one column for the red line, press the arrow keys, press `e` to mark done, press a number to change page.

## Layout rules (replacing rounded cards and accent rails)
- One fixed character grid, centred in the window and scaled by whole-page font size so all 132 columns always fit (never a horizontal scrollbar). Every element sits on the grid.
- Outer frame in double lines; panels in single lines with the title set into the top edge ("Needs you (4)"). Table headers sit above a full-width rule drawn with `├───┤`.
- The selected line is inverse video across the whole row (ink as background, paper as text). No colour bar on the side; no tint.
- Status is a bracketed word in the status colour: `[ DOWN ]`, `[ SLOW ]`, `[  ok  ]`; overdue lines are drawn in the alert colour; done lines carry `[x]` and dim.
- The bottom row is the function-key bar: a coloured number then its label (`1 Today`, `2 Ops board`, `3 Services`, `4 Calendar`, `9 Theme`, `0 Light/Dark`). Clicking a label does the same as pressing the key.
- A Detail panel under the lists shows the selected line in full (title, facts, a wrapped paragraph, and the keys for it).
- Alignment: everything left-aligned on the grid; ages and dues right-aligned; one blank column inside each frame.

## Type
Monospace only: `"IBM Plex Mono"` (already self-hosted by the site; weights 400 and 500), then `"Cascadia Mono"`, `Consolas`, `"Liberation Mono"`, `"Courier New"`. The face must have the box-drawing block (Plex Mono, Cascadia and Consolas do). A `font-variant-ligatures: none` rule keeps the grid honest. Size is computed so 132 columns fit the window width.

## Icons
None. Frame characters and brackets are the whole vocabulary. Keys are shown as inverse numbers.

## Tone of voice (five rewrites)
| Now | Paper Terminal |
|---|---|
| Waiting on you | Needs you (4) |
| Since you last looked | Tonight (4) |
| In progress and soaking | Running (3) |
| Backup restore test is overdue | Backup restore test is overdue   5 days   19 Nov (alert colour, no extra words) |
| The board is private. Log in | Sign in to continue. (press Enter) |
Status line at the bottom: `4 need you  1 down  synced 22:51`. Messages are short, lower-case verbs on the key bar, no sentences of encouragement.

## AI clichés avoided
No cards, accent rails, gradient tiles, caps eyebrow labels, rounded anything, emoji or icons, big hero number, chatty copy, or neon-on-black. The monospace choice is the entire point of the look, so it is a decision here, not a default.

## Backgrounds that suit and clash
The terminal window is centred with a margin above and below, so a background shows as the "desk" around it. Suits: Plain, Dots, Grid, Ledger, Contours at subtle or medium (the paper look). Clashes: Glow, Mesh, Aurora, Spotlight, Beams, Rays at strong (a text screen on a coloured wash loses the printed-listing feel).

## What it changes in the shared shell
- `themes.js`: the `look` setting and `data-look="terminal"`, as for G and H. A `look-terminal.css` and a small `look-terminal.js` (the character-grid renderer) loaded on demand.
- This is the heaviest change: each page needs a "text layout" function that composes panels into the grid (the mockup's `layout()` shows the pattern: `box`, `put`, `pad`, `right`, `wrap`). Pages with charts, calendars or long free text need a text rendering of their own (sparkline characters, a day-grid), or fall back to a plain pre-formatted listing.
- The real DOM keeps one `<pre>` per page so screen readers get a text alternative; an `aria-live` line announces the selected row. Keyboard: arrows, Enter, `e`, number keys; the browser's own find still works because the text is real text.
- Sidebar setting: RETIRED for this look (the function-key bar replaces the sidebar; `icons` would shorten the key labels to one word, which could be offered instead).
- Responsive: a fixed 132-column grid shrinks the font on narrow windows until it is unreadable (below about 900px wide); below that the look falls back to a 72-column single-panel layout (specified, not built in the mockup).

## Contrast
Checked over all 36 combinations (`_src\contrast.ps1`). Pairs: fg on panel, fg-dim on panel, the four status colours (alert, ok, attn, info) as text on panel, the inverse selection bar, the function-key label (accent-ink on accent) and fg-strong on panel-2. Result: no failures. Worst cases: fg-dim on panel 5.57 (Arctic light), alert on panel 5.58 (Stone light), accent-ink on accent 4.88 (Amber light, 4.5 needed), selection bar 11.81 minimum.

## Effort
8 to 12 Engineer days: 1 for the setting and loader, 2 to 3 for the grid renderer, selection, hit-testing and font fitting as a reusable module, 4 to 6 to write a text layout for each page type (the Overview and tables are quick; Monitoring graphs, Projects timeline and the Study/Campaign pages are slow), 1 to 2 for accessibility (the pre alternative, live region), narrow-window fallback and tests.
