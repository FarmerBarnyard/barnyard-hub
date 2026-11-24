# Look K: Lines

**One line:** every system or project is a line on a transit map; its stops are stations; state is drawn on the station.

## Rationale
An operations dashboard is a network: servers, projects, housekeeping, with dependencies between them. A list hides that, tiles scatter it. A line diagram shows what a person scans for: where on this line is the problem, what comes next, and where two things meet (an interchange). Here the Backups service on the Servers line and the Backup restore test on the Housekeeping line are one interchange, so the connection is visible instead of two unrelated tiles. Solid line means done or running; dashed means planned, so progress reads as how far along the line you are. A status board above the map gives each line a one-sentence status for the quick glance, as a metro operator's page does.

## Layout rules (what replaces rounded cards and accent rails)
- No cards. A status board of three ruled rows (bullet, line name, one sentence), then the schematic map, then two plain ruled lists ("Changes today", "Coming up").
- The map is flat, schematic and drawn at thick stroke: horizontal runs with 45-degree bends only, station labels alternate above and below, a branch for work that splits off (build step 1).
- State encoded in the station shape and in words: filled dot = done, ring with a centre = needs you (the ringed stop is the next action), half-filled = in progress, cross in a ring = down, diamond = degraded, dashed ring = overdue. Every state also has words in the label.
- The line colours are the theme's own: accent, info and attn. Line letters (R, S, H) sit in a bullet so lines stay distinguishable without colour.
- Left aligned text; the map is the only graphic.

## Type
IBM Plex Sans throughout; Plex Mono for times in the lists only. 14 px body, 13 px map labels, 22 px page sentence, bold for station names. No all-caps.

## Icons
None beyond the station shapes (the key explains each). The brand mark is a plain roundel (ring with a bar) that exists only to echo the map.

## Tone of voice
- "Waiting on you" -> "3 stops need you." / "APP-02 is down. 4 stops need you."
- "Since you last looked" -> "Changes today"
- "In progress and soaking" -> "in progress" on the station, "waiting to see if they hold" on the Ops board lane.
- "Open the board" -> "Ops board" (a tab).
- "The board is private. Log in" -> "Sign in to see the network."

## AI clichés avoided
Rounded cards and accent rails; the gradient number tile; eyebrow labels; numbered 01/02/03 (the only sequence here is the order of stops on a line, where order is real); neon on near-black (the dark themes are the site's own); chatty microcopy.

## Backgrounds and themes
All 18 themes work: lines use `--accent`, `--info`, `--attn`; text uses the fg tokens; station fills use `--bg`; down/degraded use the fixed `--alert`. The map sits on a 92 % sheet.
- **Suit:** Plain, Dots, Grid, Blueprint, Ledger, Contours (they read as map paper).
- **Clash:** Aurora, Mesh, Glow, Spotlight, Horizon, Rays at strong strength (colour washes behind thin line work). Medium and subtle are acceptable because of the sheet.

## Shell changes to implement it as a look
- `data-look="lines"` on `<html>`; `look-lines.css` and `look-lines.js`. The Overview markup is replaced (SVG map plus lists), so a CSS layer alone is not enough.
- **A new piece of data is needed:** which Ops board items and services belong to which line, and where on the line they sit. Today items have a prefix (`RL `) but no line structure. Proposal: a small config (`lines.json`: line id, name, ordered station list with a source: service id, Ops item id or calendar item) edited by the owner, plus an automatic layout for stations (even spacing, alternating labels). Hand-placed positions as in the mockup do not scale.
- Navigation: one-line top bar. The **sidebar setting does not apply** and is hidden while the look is on.
- Density maps to the stroke and the map font size. Other pages: generic ruled lists with the same station dots in a vertical line (the Ops board page in the mockup shows this).

## Contrast
Checked by script, 18 themes x 2 modes (504 pair checks): text pairs >= 4.5:1; line strokes and markers against the page >= 3:1. ONE failure found and fixed: the page background as the letter on an accent bullet is 4.38:1 in Amber light, so the Project Atlas bullet uses the theme's own `--accent-ink` (designed for accent fills); the other bullets use the page background and pass. The look never sets the accent as text on the page, and it has no selected rows. Not measured: text over strong background patterns.

## Effort
About 10 to 14 Engineer days: map renderer with automatic layout 4 to 5, line configuration and data mapping 2 to 3, status board 1, vertical station lists for the other pages 2 to 3, accessibility (a text alternative for the map: the status board and lists carry the same facts) and tests 1 to 2. This is the most expensive of the three because it needs the line data model.

## Mockup
`K-lines.html` (Network and Ops board). Deep link: `#theme=ember&mode=dark&bg=grid&view=ops&panel=0`.
