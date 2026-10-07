# barnyard-hub
Personal hub: widget-grid landing page linking out to other web apps.

## History

- **2026-08-19** — Went live at farmerbarnyard.github.io/barnyard-hub/: widget-grid hub with a Stocks tile (Cloudflare Worker-backed live-price ticker) linking out to market-dashboard, plus placeholder tiles for future projects.
- **2026-08-19** — Claimed `dashboard.barnyard.site` as this repo's GitHub Pages custom domain. That domain previously belonged to market-dashboard, which has moved to `stocks.barnyard.site`; the Stocks tile's link was updated to match.
- **2026-10-07** — Added the **Ops board** (`ops.html`, `ops.js`, `ops.css`): a private, live progress tracker for the projects on this account, replacing the Notion progress pages. Four lanes (In progress, Soaking & monitoring, Waiting on you, Backlog), stat tiles, filters, a "Coming up" list, a Proposals tab, and tiles that open a detail drawer with edit controls and a change log. Every change is pushed over a WebSocket from the Worker's `/ops/*` routes, so tiles move the moment anything changes. Needs a login in the `barnyard-hub-sso` group (see ClaudeRepo's `cloudflare-worker/README.md`, "Ops Board setup"). The placeholder "Coming soon" tile on the landing page is now an **Ops** tile linking to it (with a one-line summary for logged-in viewers, `ops-tile.js`). Helper tests: `node test/ops.test.js`.
