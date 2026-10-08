# Agent kit: connect your Claude to your Ops board

Files in this folder are public, static and contain no secrets. They are what the Ops board's **Connect your Claude agent** panel points to.

| File | What it is |
|---|---|
| `ops-board.ps1` | Helper for Windows PowerShell. Save as `~/.claude/ops-board.ps1`. |
| `ops-board.sh` | Helper for macOS and Linux (bash and curl). Save as `~/.claude/ops-board.sh`. |
| `agent-brief.md` | The instructions your Claude follows to keep the board up to date. Paste into your Claude Code's `CLAUDE.md` (or its memory). |
| `populate-prompt.md` | A prompt to paste once, so your Claude fills the board from your own projects. |
| `routine-prompt.md` | Optional. A prompt for a Claude Code routine that runs an item you approved (Settings, Agent runs). |
| `SHA256SUMS` | The SHA-256 of each file above. The board's setup panel gives a one-line check that your downloaded helper matches the copy published in the repository on GitHub. |

## Set up

1. Open the Ops board, then **Settings, Agent access**, and create a key. It is shown once.
2. Save it to `~/.claude/ops-board-token` and install the helper. The board shows the exact commands for your system with the key filled in. They do the same as this:
   - Windows: `Set-Content -Path "$HOME\.claude\ops-board-token" -Value '<key>' -NoNewline`, then download `ops-board.ps1` to `$HOME\.claude\`.
   - macOS and Linux: `printf '%s' '<key>' > ~/.claude/ops-board-token && chmod 600 ~/.claude/ops-board-token`, then download `ops-board.sh` to `~/.claude/`.
3. Paste `agent-brief.md` into your Claude Code's `CLAUDE.md`, then paste `populate-prompt.md` into a session.

## Letting your Claude do approved work

Your Claude can only propose; **you** approve, at the board. If you switch on **Settings, Agent runs**, approving a proposal can also ask your own Claude to do the work and open a pull request. Two ways it starts: your Claude asks `ops_approved` / `Ops-Approved` for approved items (the helpers do this), or you connect your own Claude Code routine (`routine-prompt.md`) and approving starts it straight away. Either way only ids and a fingerprint of the approved text are sent, the work must go on a `claude/` branch as a pull request, nothing is merged for you, and if the text changes after you approved it the run is withdrawn until you approve again.

## Good to know

- **The key** belongs to one board, works for the time you chose (30 days, 90 days or a year; make a new one when it runs out) or until you revoke it (Settings, Agent access, Revoke), and acts as "Claude" on your board only. A read-only key can look but not change anything. It cannot create keys or touch anyone else's board. Keep it out of repositories, chats and screenshots. If it leaks, revoke it and make a new one.
- **Several computers:** make one key per computer (up to three) so you can revoke one without breaking the others.
- **Settings you can change** without editing the scripts: set `OPS_BOARD_TOKEN_FILE` to keep the key somewhere else, or `OPS_BOARD_URL` to point the helper at a different address.
- **Limits:** about 60 changes a minute per board, 1,000 items, and the change log stops growing at 20,000 entries. Your Claude cannot delete anything; you can redact or delete an item, or your whole board, yourself (Settings, Your data).
- **What the board accepts:** text that looks like a password or key is refused, and personal details (emails, phone numbers, card and ID numbers) are accepted but flagged for you to clean up. The helper only talks to `https://` addresses.
