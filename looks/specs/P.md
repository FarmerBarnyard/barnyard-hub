# Look P: Raw

A deliberately plain, brutalist-web look. It is a document, not an app: default-sized serif text, real underlined links, bordered tables and thick ink rules. Nothing is decorated; the only things that change between themes are the colours.

Mockup: `P-raw.html` (open it in a browser; no network, no downloads). Screenshots: `shots\P-default-graphite-light.png`, `P-dark-ember-grid.png`, `P-light-cobalt-contours-ops.png`, `P-narrow.png`.

## Why this look, for this owner

An administrator's daily use is a scan: what needs me, what is down, what changed. Tables are the oldest, fastest format for that, and plain HTML is the format that every browser, screen reader, translation tool and print preview already handles well. Raw gives up all chrome and puts the whole page in the order of the scan: a one-line count first (`4 items need a decision from you. 1 service is down and 1 is degraded.`), then decisions, services, work in progress, changes, the week. State is always a word plus a bracketed symbol (`[x] down`, `[!] degraded`, `[+] up`), never colour alone. It is fast to load, cheap to maintain (it is mostly the browser's own rendering) and it is the opposite of anything that looks generated.

## Layout rules (what replaces rounded cards and accent rails)

- One document column, `62rem` wide, on a solid `--panel` sheet with a 3 px `--fg-strong` outline. The chosen background shows only on the desk around the sheet, so text never sits on a pattern.
- Sections are separated by a 4 px `--fg-strong` rule above each `h2`. No cards, no shadows, no radius anywhere.
- Content is tables (header row, 2 px outer border, 1 px grid), one short list for the change log, and one-line paragraphs. Row headers (`th scope="row"`) name each row.
- Left-aligned everything. No centring, no hero, no tiles.
- The Ops board is the same table with a plain `Mark done` button per row that needs you.

## Type

System serif only (`"Times New Roman", Times, serif`) at the browser default 16 px (15 px compact). Headings are the same face in bold; the type scale is the browser's own (h1 2em, h2 1.35em). `Courier New` for times, ids and state symbols only. No webfonts, so no font download and no licensing; the repo's Plex and Bricolage files are not used.

## Icons

None. No pictograms, no icon font, no SVG. Status uses bracketed ASCII symbols in a monospace face next to the word. The nav is a line of links separated by `|`.

## Tone of voice (five rewrites)

| Now | Raw |
|---|---|
| Waiting on you | Decisions and approvals (4) |
| Since you last looked | Changes today |
| In progress and soaking | In progress |
| Three things need you. (headline) | 4 items need a decision from you. 1 service is down and 1 is degraded. |
| The board is private. Log in | This page needs a sign-in. Sign in. |

Rules: sentence case, plain nouns, numbers as digits, states as words, no exclamation marks, no second-person coaxing, a full stop at the end of every sentence.

## AI clichés it avoids

Cream and terracotta, near-black with one acid accent, gradient washes, the identical rounded card with an accent rail and soft shadow, the big number in a tile, a small-caps label above each heading, middle-dot meta strings (`A . B . C`), emoji or icon markers, centred layouts, fade-in motion, Inter and Space Grotesk. It has no motion at all.

## Colour themes and backgrounds

All 18 real themes (light and dark) work: the CSS reads only the 12 tokens plus the 3 status tokens. Links are `--fg-strong` with an `--accent` underline, so an accent that is weak as text (Amber light, 4.38:1 on the page) is never used as a text colour. The table state cells use a faint tint of `--alert-soft`, `--attn-soft`, `--ok-soft` plus the word and symbol.

Backgrounds (all 18 CSS-only ones, copied unchanged): they show only in the margins beside the sheet, and not at all below 66rem width (the sheet then fills the screen). Suit best: Plain, Dots, Grid, Blueprint, Ledger, Stripes, Lattice, Scales, Contours (quiet, document-on-a-desk). Feel off: Glow, Mesh, Aurora, Spotlight, Horizon (soft modern gradients fight the plain intent) and Ripples, Radar, Rays (loud rings). None breaks readability, because the sheet is opaque.

## What it changes in the shared shell (implement as a `look`)

1. `themes.js`: a new setting `look` (validated against a list, kept in localStorage, the `bh_prefs` cookie as a short code, and the profile sync) that sets `data-look="raw"` on `<html>`. Same hand-copied file in all four repos.
2. `look-raw.css` (new, hand-copied, loaded after `shell.css`), scoped to `html[data-look="raw"]`: hide the sidebar and the top-bar chrome; turn the nav list into the inline `|`-separated line; flatten every `.w` widget and tile to a section with a 4 px top rule (no radius, shadow or background); restyle list rows as tables where the page renders lists of rows (the Ops board list already is rows); replace icons with their text; drop the hero headline for the one-line count; no entrance motion.
3. `shell.js`: small, a different top bar builder (title, signed-in line, nav line) instead of the sidebar builder. Page scripts that render tiles keep their DOM; a few that render pure card grids (Overview tiles, Monitoring) need a table-mode renderer, or CSS only for a first version (cards become ruled sections with a `dl` inside).
4. Copy changes live in one table (`look-raw-copy.js`) mapping widget ids to the headings above; the other looks can do the same, so wording is per look.

Sidebar setting: has no effect in this look (it has no sidebar). The Settings panel shows the setting greyed with "not used by this look".

## Contrast (4.5:1 in all 36 theme and mode combinations)

Checked by the look's own script over all 18 themes x light and dark: 288 pair-checks, 0 failures. Pairs: `--fg` and `--fg-strong` on `--panel` (worst 11.81 and 15.71, both Steel dark), `--fg-strong` on `--panel-2` (table head and buttons; worst 14.44, Arctic dark), `--fg-strong` on the three status tints (worst 12.13 to 13.14, Steel dark), `--accent-ink` on `--accent` (link hover; worst 4.88, Amber light), and `--fg-dim` on `--panel` for the table grid lines only (3:1 required, worst 5.57). No pair fails. Not used as text: `--accent` and `--fg-dim` (Amber light accent is 4.38 on the page, Dusk dark muted on a selected row 4.46, both outside this look).

## Effort

About 4 to 5 Engineer days for a first version that is mostly CSS over the existing DOM (flattened widgets, text nav, no icons), plus 1 day for the copy table and the Settings change, plus 2 days to give the card-grid pages a table-mode renderer if the owner wants real tables everywhere. Total 5 to 8 days.

## What was checked, and doubts

Built from the real `themes.js` token table (all 18) and the real background CSS from `shell.css`. Rendered in headless Edge in light and dark, Graphite, Ember and Cobalt, with Plain, Grid and Contours, normal and compact, Overview and Ops board, and at 420 px width. Interactions pass in a scripted test (`tools\smoke-PQ.html`): navigation, Mark done toggle, stub link note, theme, mode, density, 18 themes and 18 backgrounds selectable. Doubts: not tested in a screen reader; keyboard focus is a 3 px outline (seen in CSS, not photographed); the narrow screenshot is clipped by the headless minimum window width, so the horizontal-scroll wrapper on tables is untested at real phone width; the real Overview tiles (market, weather, to-do) are not shown because the shared example data has none.
