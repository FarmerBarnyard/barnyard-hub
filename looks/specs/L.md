# Look L: Grid 9

**One line:** a strict nine-column modular grid. One typeface, four sizes, flush left, hairline rules, no boxes.

## Rationale
The dashboard is read many times a day and the content is mostly short rows: item, age, due, state. The International Typographic style was built for exactly that: a visible grid so everything aligns, a strict hierarchy of size and weight so you scan by eye position, and rules instead of boxes. The opening is typographic: three short lines at display size ("4 need you. 1 server down. 3 in progress.") set in the same face and weight as everything else, so the numbers are part of the sentence, not tiles. Below it each section is a ruled band with its heading in columns 1 and 2 and its rows in columns 3 to 9. The grid can be shown on request (a toggle in the mockup, a Settings option in the real site), which doubles as proof that every element sits on it.

## Layout rules (what replaces rounded cards and accent rails)
- Nine columns, 20 px gutter, 1200 px maximum. Headings sit in columns 1 to 2, content in 3 to 9; rows use seven columns: age (1), title (2 to 5), note (6 to 7).
- A 6 px rule at the top, 1 px full-strength rule above each section, 1 px low-contrast rule between rows. No boxes, no background fills, no radius, no shadow.
- Flush left, ragged right. Numbers use tabular figures. Only the date at the top right of the bar is placed away from the left edge, because it is a column position, not alignment.
- Weight carries state: bold = needs attention. Words carry state ("Down", "Degraded", "Up"); colour is secondary and only on those two words.
- The sheet behind the content is 92 % of the page colour, so a background shows in the margins.

## Type
One typeface: IBM Plex Sans (already self-hosted); fallbacks Helvetica Neue / Arial. Four sizes only: 15 px (body and headings, bold for headings; 14 px in compact), 38 px (counts and lane numbers), about 53 px (the Ops board page title) and up to 68 px (the Overview opening); the three larger sizes scale down in compact. Two weights: 400 and 700. No mono face, no italics, no all-caps.

## Icons
None. The look has no icons and no decoration.

## Tone of voice
- "Waiting on you" -> "Needs you" (heading) and "4 need you." (opening).
- "Since you last looked" -> "Today" (rows with clock times).
- "In progress and soaking" -> "In progress" and a count row ("4 Needs you, 3 In progress, 6 Soaking, 27 Backlog").
- "Open the board" -> "Ops board".
- "The board is private. Log in" -> "Sign in to see this."

## AI clichés avoided
Rounded cards with accent rails; the big number in a tile with a gradient (here counts are bare numerals in a ruled row, same face and weight); small-caps eyebrow labels; accenting one word of a headline; cream-and-serif; near-black plus one acid colour; centred layouts; emoji.

## Backgrounds and themes
All 18 themes work from the 12 tokens (the look uses almost no colour: fg, fg-strong, fg-dim, line, plus alert and attn on two words).
- **Suit:** Plain, Dots, Grid, Ledger, Stripes, Lattice, Blueprint (patterns echo the grid idea).
- **Clash:** Glow, Mesh, Aurora, Spotlight, Horizon (soft colour washes contradict a strict grid); Rays and Ripples at strong strength.
- With the 92 % sheet most backgrounds show only in the margins, which suits the look.

## Shell changes to implement it as a look
- `data-look="grid9"` on `<html>`; `look-grid9.css` and `look-grid9.js`. Overview markup changes (rows instead of tiles), so a CSS layer alone is not enough; the Overview needs a second render function over the same data.
- Navigation becomes the one-line top bar; the **sidebar setting does not apply** and is hidden while the look is on. A new optional Setting "Show the grid" (off by default).
- Density maps to row padding and the display size. This is the cheapest look to extend to other pages: every page is a heading column plus ruled rows.

## Contrast
Checked by script, 18 themes x 2 modes (504 pair checks): fg, fg-strong and fg-dim on the page all >= 4.5:1; alert and attn text on the page >= 4.5:1 for the two status words; no failures for this look. No selected rows, so the Dusk dark muted-on-selected edge (4.46:1) does not arise; the accent is never used as text (Amber light 4.38:1 is not hit). Not measured: text over strong background patterns.

## Effort
About 5 to 7 Engineer days: Overview renderer 1.5, Ops board table 1, the grid layer and responsive collapse 1.5, the other eight pages as heading plus ruled rows 1 to 2, tests and copy 1.

## Mockup
`L-grid-9.html` (Overview and Ops board). Deep link: `#theme=graphite&mode=light&grid=1&panel=0`.
