# Look J: Day Line

**One line:** the page is a time axis. Everything sits where it happens, and a line marks now.

## Rationale
An administrator opens the dashboard to answer one question: what happened, what is happening, what is coming. Today's Overview answers it with eight separate tiles, so time is something you have to reassemble in your head. Day Line puts the whole answer on one vertical axis. Earlier events sit above the "now" line, items that need you sit on it, and the calendar week and due dates sit below it in order. Anything that has been going on for a while (a server down, a degraded service, an overdue test) is a bar in the left gutter that runs from when it started until now, so how long something has been wrong is visible without reading. The Ops board becomes the same idea as a table against a 12-day strip.

## Layout rules (what replaces rounded cards and accent rails)
- No cards, no boxes, no shadows. One translucent "sheet" column (90 % of the page colour) so a background shows at the edges; no radius, no border.
- A five-column row grid: gutter bars | clock time (mono) | axis marker | text | side note. Rows are ordered by time, not by type.
- Structure is information: the vertical axis line, day headings, the gutter duration bars and the horizontal "now" line all encode time. Nothing else is decorative.
- Shape plus text encodes state, never colour alone: circle = event, filled square = needs you, diamond = down, green filled circle = done, dashed circle = planned. Bars: solid = down, dashed = degraded, dotted = overdue.
- Left aligned, ragged right. The side note is the only right-aligned element.

## Type
IBM Plex Sans (already self-hosted) for text, IBM Plex Mono for clock times only. Sizes: 14 px body, 12.5 px times, 26 px for the opening sentence. No all-caps, no tracked labels.

## Icons
None. Markers are drawn shapes on the axis. No icon set to maintain.

## Tone of voice
- "Waiting on you" -> "4 items need you." (the opening sentence is built from the data: "22:51 Tuesday. APP-02 has not replied for 14 minutes. 4 items need you.")
- "Since you last looked" -> no heading; the earlier events carry their clock times.
- "In progress and soaking" -> rows under the line with the word "now" in the time column.
- "The board is private. Log in" -> "Sign in to read the line."
- "Checking what needs you..." (loading) -> "Reading the line..."

## AI clichés avoided
Rounded cards with accent rails; big number in a gradient tile; small-caps eyebrow above every heading; numbered 01/02/03 markers (the only sequence here is time); chatty headings; centred layout; emoji.

## Backgrounds and themes
All 18 themes work unchanged: every colour comes from the 12 tokens (`--bg --panel --panel-2 --line --fg --fg-strong --fg-dim --accent --accent-ink --accent-soft --attn --attn-soft`) plus the fixed status colours. Backgrounds draw behind a 90 % sheet, so at medium strength they show mostly in the margins.
- **Suit:** Plain, Dots, Grid, Ledger (the red margin rule lands just left of the text: it looks designed), Stripes, Lattice.
- **Clash or lose their point:** Glow, Aurora, Mesh, Spotlight, Horizon, Rays at strong strength (colour wash fights the thin axis line and the bars). The sheet hides most of the harm at medium or subtle.

## Shell changes to implement it as a look
- `data-look="day-line"` on `<html>` from a new Settings choice; a `look-day-line.css` layer and a `look-day-line.js` renderer. This look changes the Overview's markup (rows instead of tiles), so a CSS layer alone is not enough: the Overview needs a second render function over the same data (`overview.js` already builds the data model; only the markup builder differs).
- Navigation moves from the sidebar to a one-line top bar. The **sidebar setting (full / icons) does not apply** to this look and is hidden in Settings while it is on.
- Density maps to row padding and font size (as in the mockup). Backgrounds and themes: no change.
- The Ops board page gets the table with the due-date strip; other pages (Monitoring, Calendar, Vulnerabilities) fall back to a generic list-with-time-column treatment: that is the largest unknown (see effort).

## Contrast
Checked by script across all 18 themes x light/dark (36 combinations, 504 pair checks, tokens only): text on page (fg, fg-strong, fg-dim) all >= 4.5:1; "now" tag (accent-ink on accent) >= 4.5:1; non-text markers (accent, attn, alert, ok against the page) all >= 3:1. No failures for this look. The look never uses the accent as text on the page (Amber light accent text is 4.38:1) and has no selected rows (Dusk dark muted-on-selected 4.46:1 does not arise). Not measured: text over the stronger background patterns; the 90 % sheet is the mitigation.

## Effort
About 6 to 8 Engineer days: Overview renderer 2, Ops board table and strip 1, the generic time-column treatment for the other eight pages 2 to 3, tests (tokens, CSP, contrast, both densities) 1, copy pass 0.5.

## Mockup
`J-day-line.html` (Overview and Ops board, controls for theme, light/dark, background, strength, density). Deep link: `#theme=cobalt&mode=light&bg=ledger&view=ops&panel=0`.
