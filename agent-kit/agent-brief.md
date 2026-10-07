# My Ops board: keep it up to date as you work

I keep a live progress board at https://dashboard.barnyard.site/ops.html. You are my Claude, and you post to it as you work, so I can see what is in flight without having to ask. Treat it as part of doing the job, not an extra.

## Setup (already done on this computer)

- The helper is `~/.claude/ops-board.ps1` (Windows PowerShell) or `~/.claude/ops-board.sh` (macOS or Linux). My key is in `~/.claude/ops-board-token`.
- **Never print, log, paste, commit or send the key anywhere.** If a command's output could contain it, don't run that command.
- Load the helper in each shell session before using it:
  - PowerShell: `. ~/.claude/ops-board.ps1`
  - bash/zsh: `source ~/.claude/ops-board.sh`
- Check it works: `Ops-Test` (PowerShell) or `ops_test` (bash).

## Commands

| What | PowerShell | bash |
|---|---|---|
| list open items (with ids) | `Ops-List` | `ops_list` |
| add an item | `Ops-Add -Title "..." -Lane in_progress -Category backend -Targets "api","docs" -Next "..."` | `ops_add --title "..." --lane in_progress --category backend --targets "api,docs" --next "..."` |
| change an item | `Ops-Update -Id it_xxxxxxxx -Lane waiting -Next "..." -Note "why"` | `ops_update it_xxxxxxxx --lane waiting --next "..." --note "why"` |
| add a note to the log | `Ops-Note -Id it_xxxxxxxx -Text "what just happened"` | `ops_note it_xxxxxxxx "what just happened"` |
| finish an item | `Ops-Done -Id it_xxxxxxxx -Note "..."` | `ops_done it_xxxxxxxx "..."` |
| bring a finished item back | `Ops-Reopen -Id it_xxxxxxxx -Lane backlog` | `ops_reopen it_xxxxxxxx backlog` |
| everything, for backup | `Ops-Export` | `ops_export` |

Other useful options on add and update: due date (`-Due 2026-10-09` / `--due 2026-10-09`), `-Owner you`, `-Priority high`, `-Details "..."`, and `-Proposal` / `--proposal`.

## The words the board understands

- **Lane:** `in_progress` (being worked on now), `soaking` (done, being watched), `waiting` (needs my decision or input), `backlog` (planned or an idea). Finished work leaves the board via `Ops-Done`.
- **Category:** `backend`, `frontend`, `agent`, `security`, `infrastructure`, `maintenance`, `docs`, `data`, `other`.
- **Status** (optional; a lane gives a sensible default): `investigating`, `building`, `reviewing`, `soaking`, `monitoring`, `watching`, `decision_needed`, `scheduled`, `planned`, `idea`, `deferred`, `blocked`.
- **Owner:** `claude` (you) or `you` (me). Use `you` when something is waiting on me.
- Anything outside these words is rejected with an error, not guessed at. Fix the value and try again.

## How to use it

1. **Update as you go, not at the end.** Starting something: add it (or move it) to `in_progress`. Finishing: `Ops-Done` with a one-line note of what shipped.
2. **When you need me, say so on the board.** Move the item to `waiting`, owner `you`, status `decision_needed`, and make **Next** say exactly what you need from me and by when.
3. **Keep Next accurate.** It is one short line: what happens next. Update it whenever it stops being true.
4. **Use notes for what changed and why.** The notes are the change log I read when I come back. Say what happened, not just that something did.
5. **Ideas I should approve go in as proposals** (`-Proposal`), not straight into the backlog. They appear on a Proposals tab where I accept or reject them.
6. **Keep it small and honest.** Aim for no more than three items `in_progress` at once. Titles are short and plain: what the work is, not how you felt about it.
7. **Nothing is ever deleted.** Finished and rejected items stay, with their log. Don't try to remove items.
8. **No secrets on the board.** No keys, passwords, tokens or private data in titles, notes or details.
9. **If a call fails,** read the error. A `429` means slow down for a minute; a `401` means my key was revoked or is wrong, so stop and tell me rather than retrying.
