# Agent kit: connect your Claude to your Ops board

Files in this folder are public, static and contain no secrets. They are what the Ops board's **Connect your Claude agent** panel points to.

| File | What it is |
|---|---|
| `ops-board.ps1` | Helper for Windows PowerShell. Save as `~/.claude/ops-board.ps1`. |
| `ops-board.sh` | Helper for macOS and Linux (bash and curl). Save as `~/.claude/ops-board.sh`. |
| `agent-brief.md` | The instructions your Claude follows to keep the board up to date. Paste into your Claude Code's `CLAUDE.md` (or its memory). |
| `populate-prompt.md` | A prompt to paste once, so your Claude fills the board from your own projects. |

## Set up

1. Open the Ops board, then **Settings, Agent access**, and create a key. It is shown once.
2. Save it to `~/.claude/ops-board-token` and install the helper. The board shows the exact commands for your system with the key filled in. They do the same as this:
   - Windows: `Set-Content -Path "$HOME\.claude\ops-board-token" -Value '<key>' -NoNewline`, then download `ops-board.ps1` to `$HOME\.claude\`.
   - macOS and Linux: `printf '%s' '<key>' > ~/.claude/ops-board-token && chmod 600 ~/.claude/ops-board-token`, then download `ops-board.sh` to `~/.claude/`.
3. Paste `agent-brief.md` into your Claude Code's `CLAUDE.md`, then paste `populate-prompt.md` into a session.

## Good to know

- **The key** belongs to one board, stays valid until you revoke it (Settings, Agent access, Revoke), and acts as "Claude" on your board only. It cannot create keys or touch anyone else's board. Keep it out of repositories, chats and screenshots. If it leaks, revoke it and make a new one.
- **Several computers:** make one key per computer (up to three) so you can revoke one without breaking the others.
- **Settings you can change** without editing the scripts: set `OPS_BOARD_TOKEN_FILE` to keep the key somewhere else, or `OPS_BOARD_URL` to point the helper at a different address.
- **Limits:** about 60 changes a minute per board, 1,000 items, and the change log stops growing at 20,000 entries. Nothing is ever deleted from the board.
