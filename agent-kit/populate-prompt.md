Please fill my Ops board from the projects I'm working on. The board is at https://dashboard.barnyard.site/ops.html and you update it with the helper described in the Ops board brief (`~/.claude/ops-board.ps1` or `~/.claude/ops-board.sh`).

Do it in this order, and don't skip the check in step 3:

1. **Find my projects.** Ask me which folders or repositories to look through if you aren't sure; don't wander through the whole disk. For each one, read what is already there that says what's going on: the README, any TODO or notes files, open branches, and recent commits (`git log`, last few weeks).
2. **Work out the real state of each.** What is in progress right now, what is finished and just being watched, what is blocked or waiting on me, and what is only an idea. Be conservative: if you can't tell, ask me or file it as a proposal rather than guessing.
3. **Show me the plan before you touch the board.** List the items you intend to add in chat, with lane, category and a one-line Next for each. Wait for me to say yes or change things. Do not add anything until I have confirmed.
4. **Add them.** One item per real piece of work, not one per file or commit. Titles short and plain. Put items that are currently being worked on in `in_progress`, planned work in `backlog`, ideas as proposals (`-Proposal`), and anything that needs my decision in `waiting` with owner `you`. Use targets to name the project or area.
5. **Close the loop.** When you're done, run the list command so we can both see the result, then find the item called "Connect your Claude agent" and finish it with a note that you're connected and the board is filled in.

From now on, keep the board up to date as you work, following the brief. If my projects change a lot, tell me and offer to tidy the board.
