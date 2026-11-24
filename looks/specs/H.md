# H. Sheet

**Mockup:** `H-sheet.html`. Screenshots: `shots\h1.png` (Graphite light, Today), `h2.png` (Pine dark, Ledger, Ops board), `h3.png` (Amber light, Dots, Calendar).

## Rationale
An IT administrator lives in grids: asset registers, renewals, backup logs, vulnerability exports. The dashboard's real content is already rows with a state, an age and a date. Sheet stops dressing that up and shows it as a workbook: pages are sheet tabs along the bottom, content is cells in a ruled grid, state is a plain word in a filled cell, the header row stays frozen, and a formula bar above the grid shows the full text of whichever cell you select. You scan one column (State) for the filled cells, click a header to sort, and arrow around. It is the most familiar dense layout there is, and nobody mistakes it for a SaaS template.

## Layout rules
- One window with a 1px frame and a 10 to 12px margin (so backgrounds show around it). No radius anywhere.
- Frozen top: column letters (A, B, C...) and the header row (row 1) in bold with a heavier rule underneath. Frozen left: row numbers.
- Content groups are ranges: a group header row ("Needs you (4)", "Services (6)", "Running (3)", "Tonight (4)", "This week") spans the columns with the panel-2 tint and bold text; the rows follow.
- Columns on Today: State, Item, From, Age, Due, Note. State is a cell fill + a word. Ages and dues are right-aligned monospaced numerals.
- The selected cell has a 2px outline in the accent and a small fill handle in the corner; its row number and column letter are tinted. Selection encodes "you are here", not importance.
- Pages: Today, Ops board (sortable: click a header), Services, Calendar (days as columns, items as rows). Tabs along the bottom; the active tab has a 2px accent underline.
- Alignment: text left, numbers right, headers left. Top of the page is a thin title strip (name and person), then the formula bar (cell address, fx, content).

## Type
`"Aptos", "Segoe UI Variable Text", "Segoe UI", system-ui` 13px (12px compact); numerals and ids in `"Cascadia Mono", Consolas`. IBM Plex Sans / Plex Mono (already self-hosted) can replace both; Plex Mono's tabular figures suit the number cells.

## Icons
None. The only glyphs are the sort arrows and the `fx` label. State is a word plus a tint: Needs you (accent-soft), Overdue and Down (alert-soft), Degraded (attn-soft), Up (ok-soft), Running (info-soft), Done (dim, no fill).

## Tone of voice (five rewrites)
| Now | Sheet |
|---|---|
| Waiting on you | Needs you (4) |
| Since you last looked | Tonight (4) |
| In progress and soaking | Running (3) |
| Three things need you | State: Needs you, in 3 rows |
| The board is private. Log in | Sign in to see this sheet. |
Cells are short nouns and numbers ("Overdue 5 days", "28 Nov", "reads 7 of 9"); no sentences inside the grid.

## AI clichés avoided
Cards, rails, big stat tiles, gradient accents, a caps eyebrow over every heading, icons beside every item, chatty copy, a centred hero. Colour appears only as a cell fill that means a state.

## Backgrounds that suit and clash
The sheet window is opaque; a background shows only in the 10 to 12px margin, so it is a frame, not a canvas. Suits: Plain, Dots, Grid, Ledger, Stripes at any strength. Mostly wasted or distracting at strong: Aurora, Mesh, Glow, Spotlight, Rays, Radar, Ripples. (Grid and Ledger echo the sheet itself.)

## What it changes in the shared shell
- `themes.js`: the `look` setting and `data-look="sheet"` as for G. A `look-sheet.css` loaded on demand.
- The left sidebar goes; page navigation becomes the bottom tab strip (`shell.js` builds tabs from the same menu list). Sidebar setting: RETIRED for this look (`icons` has no meaning; the tab strip is always names; a note in Settings says so when this look is chosen).
- Page content: each page's widgets become one or more ranges in a table. The Overview, Ops board, Services, Calendar and Vulnerabilities map directly (they are tables already). Pages with free text or charts (Monitoring graphs, Study, Campaign notes) need either a "text sheet" (one wide merged cell per paragraph) or a tab that opens the existing page unframed. Charts become a small in-grid sparkline or stay as the page's own canvas below the grid.
- Selection and keyboard: arrows, Enter, Tab, click-to-sort; the formula bar is a read-only mirror (no editing).

## Contrast
Checked over all 36 combinations (`_src\contrast.ps1`). Pairs: fg-strong on each state fill (accent, alert, attn, ok, info soft over panel), fg-dim on panel-2 (row numbers, letters), fg-dim on panel (dim cells), fg-strong on the highlighted header, and the 3:1 selection outline. Result: no failures. Worst cases: fg-strong on a soft fill 7.65 to 13.10, fg-dim on panel-2 5.20 (Arctic light), outline 4.88 (Amber light). State text always uses `--fg-strong`, never the accent colour, so Amber light's 4.38:1 accent-on-page case never arises.

## Effort
6 to 9 Engineer days: 1 for the setting and loader, 2 for the workbook shell (title, formula bar, grid, tabs, sticky headers, selection) as one reusable component, 3 to 5 to move the pages onto it (the table-like pages are quick; Monitoring graphs and free-text pages are the cost), 1 for tests across 36 combinations and keyboard.
