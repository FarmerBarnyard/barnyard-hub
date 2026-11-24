# G. Mailroom

**Mockup:** `G-mailroom.html` (open it from the gallery). Screenshots: `shots\g1.png` (Steel light), `g2.png` (Cobalt dark, Grid, Ops board), `g3.png` (Ember dark, Glow, compact), `g4.png` / `g5.png` (Dusk dark, Aurora).

## Rationale
An administrator's day is a stream of things that arrive, get read, get dealt with and get filed. An e-mail client is the screen shape people already use for exactly that, all day, without thinking. So Mailroom is a three-pane client: lanes and pages on the left like folders, the day's items in the middle as messages, the selected item on the right as a reading pane with its actions. Unread means "needs you" and is bold; a small flag means overdue or down. You scan one column for bold lines, press `j` or `k` to move, `e` to mark done. Nothing on screen is decoration: no cards, no tiles, no big numbers, one reading pane instead of a wall of widgets. It is calm and dense, which is what a person scanning for the one failing thing wants.

## Layout rules (what replaces rounded cards and accent rails)
- Three flat panes divided by 1px lines (`--line`). Radius is 2px at most, on buttons and the search field only.
- Folders (left, 208px): Today, then lanes (Needs you, Running, Soaking, Backlog), then watchers (Services, Activity, Calendar), then pages (Ops board). Counts right-aligned; bold only when something needs you.
- List (middle, 320 to 400px): two-line rows, sender line plus subject line, group headers that stick while you scroll (sentence case, dim, with a count). Selected row = a full-row tint (`--accent-soft`). There is no coloured bar on the side of anything.
- Reading pane (right): subject, a four-line fact list (From, Raised, Due, Lane), a short paragraph (62 characters wide at most), then plain buttons. One primary button, inverse ink.
- The Ops board becomes the same list as a table (the middle pane widens, columns Item, Title, Lane, Due; the reading pane narrows to 360px).
- Alignment: everything left-aligned; times and dues right-aligned in tabular numerals.

## Type
System UI only: `"Segoe UI Variable Text", "Segoe UI", system-ui`, 13px (12px compact). Titles in the reading pane 20px, weight 600. Item ids in `"Cascadia Mono", Consolas` at 0.92em. IBM Plex Sans (already self-hosted) is an acceptable substitute if the owner prefers the site's own face; nothing here depends on a display face.

## Icons
None. Status is carried by (1) bold weight for unread, (2) a CSS flag shape in the status colour (alert for overdue or down, theme "attn" for needs-you or degraded, drawn with `clip-path`, no image), (3) a tick for done, (4) the words themselves ("down", "degraded"). Keyboard hints are `kbd` boxes.

## Tone of voice (five rewrites of the current wording)
| Now | Mailroom |
|---|---|
| Waiting on you | Needs you |
| Since you last looked | Tonight (or Activity as a folder) |
| In progress and soaking | Running |
| The board is private. Log in | Sign in to open the board. |
| Checking what needs you... | Loading. |
Also: rows read like messages ("Security: Sign off the Setup first run"), actions are verbs ("Mark done", "Snooze to Mon") and keep the same name in the toast ("Marked done").

## AI clichés avoided
Rounded identical cards; accent rail on a card; big number in a gradient tile; an all-caps label above every heading; emoji or icon beside every item; chatty microcopy; a centred hero; numbered 01/02/03 markers. The accent is used for two things only: the unread dot and the selected-row tint.

## Backgrounds that suit and clash
The folder strip and top bar are slightly translucent so a background shows there and around the edges; the list and reading pane stay opaque for reading. Suits: Plain, Dots, Grid, Ledger, Blueprint at subtle or medium. Clashes (they sit behind the strips only and read as noise next to the dense list): Mesh, Aurora, Glow, Spotlight, Rays, Radar, Ripples at strong.

## What it changes in the shared shell (implementation)
- `themes.js`: a new `look` setting (default `original`, validated against the list of looks; one more short code in the `bh_prefs` cookie; included in the profile sync). Sets `data-look="mailroom"` on `<html>` with the other attributes.
- `shell.css` stays; a new `look-mailroom.css` loads only when the look is chosen (`[data-look="mailroom"] ...`), overriding `.shell`, `.side`, `.content`. `shell.js`: the sidebar builder takes a second layout (folder list with counts instead of icon + label) when `data-look="mailroom"`.
- Pages: Overview (list plus reading pane, widgets become lists in groups), Ops board (table plus reading pane; its existing list layout is close), Monitoring/Services (list of services as rows), Calendar (agenda list), Vulnerabilities (table), Projects (list). The reading pane needs a per-page "detail" renderer: this is the real work.
- Sidebar setting: `full` = the 208px folder pane; `icons` = collapses to 56px showing the first letter and the count of each folder.
- Keyboard: `j`/`k`/arrows, `e`, `s`, `/`, `1`/`2`; the existing palette (`/` search) keeps working. Below 980px wide the reading pane hides and Enter opens the item full width.

## Contrast
Checked by script (`_src\contrast.ps1`) over all 18 themes x light and dark = 36 combinations, using the pairs this look actually draws: fg-dim on panel and panel-2, fg on panel, fg-strong on the selected row, the alert count on the folder pane, the primary button, and the 3:1 flag and dot marks. Result: ONE failure, fg-dim on the selected row in Dusk dark at 4.46:1 (needs 4.5). The look avoids it: on the selected row the muted text uses `--fg` instead (fixed in the mockup; in the implementation it is one rule). Everything else passes; worst cases: fg-dim on panel 5.57 (Arctic light), alert flag 5.58 (Stone light), accent dot 4.88 (Amber light, 3:1 needed).

## Effort
7 to 10 Engineer days: 1 day for the `look` setting and the loader, 1 to 2 for the shell/sidebar layout, 4 to 6 for the list-plus-detail version of the Overview, Ops board and the four or five other pages (the detail renderer per page type is the cost), 1 for keyboard and tests (themes test across 36 combinations, a look test per page).
