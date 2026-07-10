# Trello MCP — Personal remote connector for Claude

A small, opinionated [MCP](https://modelcontextprotocol.io/introduction) server that lets [Claude](https://claude.ai) read and update Trello boards. Runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/), gated behind GitHub OAuth, allowlisted to a single GitHub user.

Designed primarily around Dann Bleeker Pedersen's GTD workflow, but the underlying tools are generic — friendly aliases for boards / lists / labels live in [`src/trello/constants.ts`](src/trello/constants.ts) and are easy to extend for other workflows.

Since v1.12.0 the same Worker also serves a private **web To-Do dashboard** at `/dashboard` — see [Web dashboard](#web-dashboard).

## Tools (99)

**Reads**

| Tool | Purpose |
|---|---|
| `list_boards` | All open boards the authenticated Trello user belongs to |
| `list_lists` | Lists on a board (alias or ID) |
| `list_cards` | Cards on a list or board; includes `desc`; optional `label` / `staleDays` filters |
| `list_cards_by_list` | Read one list with `excludeDueDates` / `includeSnoozedOnly` / `staleDays` filters |
| `list_cards_due` | Filter by scope: `today` / `overdue` / `next_seven_days`; emits `snoozed` + `wakeUp` |
| `list_archived_cards` | Closed (archived) cards on a board — same CardSummary shape as list_cards |
| `get_card` | Full details for one card |
| `search_cards` | Fuzzy name search, scoped or unscoped; includes `desc` |
| `search_cards_advanced` | `/search` with operator support: `due:overdue`, `label:red`, `has:attachments`, multi-board scope |
| `list_checklist_items` | Checklists + items on a card |
| `list_attachments` | Attachments on a card (id, name, url, date, mimeType) |
| `get_attachment` | Fetch a single attachment with richer fields (previews[], edgeColor, pos) than list_attachments returns |
| `list_labels` | All labels on a board (id, name, color) |
| `get_label` | Fetch one label directly by ID or by name (with board scope) |
| `list_board_members` | Everyone with access to a board (id, fullName, username, initials) |
| `list_card_members` | Members assigned to one card |
| `list_my_cards_assigned` | Cross-board "everything assigned to me"; optional board filter |
| `read_comments` | Chronological comment thread on a card |
| `card_activity_log` | Recent actions on a card — moves, due-date edits, label/comment/attachment events |
| `list_snoozed_cards` | Cards hidden by the Snooze Power-Up, with wake times (`overdueWake` flags a missed wake). Read via card pluginData |
| `snooze_read` | Cards whose `dueReminder` is set, sorted by computed wake-up time. Note: `dueReminder` is the reminder-offset field, not a true snooze — Trello has no native snooze in its REST API |
| `weekly_review_pack` | One-call GTD snapshot: inbox, overdue, due-today, due-this-week, context-list counts, waiting stale, could-do horizons, snoozed, big-rocks |
| `list_notifications` | Authenticated user's bell-icon feed; filter by type + read state |
| `list_card_voters` | Members who have voted on a card |
| `list_comment_reactions` | All emoji reactions on a comment |
| `list_comment_reactions_summary` | Grouped emoji-reaction counts on a comment (lighter than list_comment_reactions) |
| `list_list_actions` | Recent actions on a single list |
| `list_my_actions` | The authenticated user's cross-board recent activity |
| `get_action` | Full detail for a single action (move, comment, update, etc.) |
| `get_action_display` | Trello's pre-rendered human-readable version of an action |
| `list_board_memberships` | Richer than `list_board_members` — adds memberType (admin/normal/observer/virtual) and state |
| `get_member` | Look up any Trello member by ID or username |
| `list_custom_fields` | Custom-field DEFINITIONS on a board (Power-Up-dependent) |
| `list_card_custom_fields` | A card's current custom-field values |
| `list_board_plugins` | Power-Ups currently enabled on a board (id + idPlugin + alias) |
| `get_plugin` | Plugin metadata (name, description, url) by alias or ID |
| `batch_get` | Bundle up to 10 relative Trello paths into one request via `/batch` |

**Writes**

| Tool | Purpose |
|---|---|
| `create_card` | New card on a list (with guards + WIP warning) |
| `copy_card` | Duplicate a card to a target list; `keepFromSource` picks what carries over |
| `move_card` | Move card between lists (guards source AND destination) |
| `update_card` | Edit name / description / due date |
| `archive_card` | Soft archive (`closed=true`). Hard delete is not implemented. |
| `set_due_complete` | Mark due date as done (triggers Butler automations) |
| `set_due_reminder` | Set minutes-before-due reminder offset; null clears |
| `set_card_position` | Move a card to top / bottom / numeric position within its list |
| `set_start_date` | Set or clear a card's start date (ISO 8601 or null) |
| `set_checklist_item_state` | Tick / untick a single checklist item |
| `add_label` | Apply a label by ID or name |
| `remove_label` | Remove a label by ID or name |
| `create_label` | Create a new label on a board (palette token or null for no color) |
| `delete_label` | Delete a label board-wide (destructive — strips it from every card carrying it) |
| `add_member_to_card` | Assign a member (ID, username, or full name resolved on the card's board) |
| `remove_member_from_card` | Unassign a member |
| `add_comment` | Append a comment to a card |
| `update_comment` | Edit an existing comment (by action ID from `read_comments`) |
| `delete_comment` | Delete an existing comment |
| `add_checklist_item` | Append an item to the card's checklist |
| `remove_checklist_item` | Remove an item from a checklist |
| `create_checklist` | Create a new named checklist (e.g. "Agenda", "Decisions") |
| `rename_checklist` | Change a checklist's name |
| `delete_checklist` | Delete a checklist and all its items |
| `convert_checklist_item_to_card` | Promote a checklist item to a standalone card; optional `targetList` |
| `add_attachment` | Attach a URL to a card |
| `add_file_attachment` | Upload a real file (base64 → multipart). 10 MB hard cap — for larger files, host the file and use `add_attachment` with a URL. |
| `remove_attachment` | Remove an attachment from a card |
| `batch_add_label` | Apply the same label to up to 50 cards (per-card skip reasons reported) |
| `batch_move_cards` | Move up to 50 cards to the same destination list (guards + WIP warning) |
| `wake_card` | Unarchive a Power-Up-snoozed card NOW (refuses non-snoozed cards; creating snoozes via API is impossible) |
| `send_digest` | Send the "Todays Actions" digest email immediately with live board data |
| `create_list` | Create a new list on a board (with position) |
| `rename_list` | Rename a list |
| `archive_list` | Archive (default) or reopen a list |
| `move_list` | Reposition a list and/or move it to another board |
| `move_all_cards` | Bulk-move every card on a list to another list |
| `archive_all_cards` | Bulk-archive every open card on a list |
| `set_card_cover` | Set cover (palette color or attachment); size + brightness optional |
| `clear_card_cover` | Strip the card's cover |
| `set_checklist_item_due` | Set or clear a due date on a checklist item |
| `assign_checklist_item_member` | Assign or unassign a member on a checklist item |
| `reorder_checklist_item` | Move a checklist item within its checklist (top/bottom/number) |
| `update_label` | Rename and/or recolor an existing label |
| `subscribe_card` | Watch / unwatch a card |
| `subscribe_list` | Watch / unwatch a list |
| `mark_notification_read` | Flip one notification's read flag |
| `mark_all_notifications_read` | Bulk mark every (optionally filtered) notification read |
| `vote_card` | Vote on a card as the authenticated user |
| `unvote_card` | Withdraw your vote from a card |
| `add_comment_reaction` | Add an emoji reaction to a comment |
| `remove_comment_reaction` | Remove a reaction by its ID |
| `copy_checklist` | Duplicate an entire checklist (with items) onto another card |
| `mark_card_notifications_read` | Bulk-clear every notification associated with one card |
| `create_custom_field` | Create a new custom-field definition on a board (Power-Up-dependent) |
| `update_custom_field` | Rename / reposition / toggle display-on-card-front for a custom field |
| `delete_custom_field` | Delete a custom-field definition (removes every card's value for it) |
| `add_custom_field_option` | Add an option to a list-type custom field |
| `delete_custom_field_option` | Remove an option from a list-type custom field |
| `set_card_custom_field` | Set a custom-field value on a card (polymorphic: checkbox / date / number / text / list, or null to clear) |
| `enable_board_plugin` | Enable a Power-Up on a board by alias (custom-fields, card-aging, voting, calendar) or ID |
| `disable_board_plugin` | Disable a Power-Up (takes the boardPlugin id from list_board_plugins, NOT the idPlugin — Trello REST quirk) |

## Safety guards

Enforced server-side before any Trello call — same rules for every tool, no per-tool drift:

- **Forbidden lists** (Butler, Repeater Cards) — all writes refused. These lists hold automation rules and recurring templates; the connector observes but never modifies them.
- **Read-only lists** (Rolling Big Rocks) — `move_card` source OR destination refused. `create_card` to this list refused.
- **WIP-limit warnings** — when a `move_card` or `create_card` puts a list with a `(WIP limit N)` suffix over its limit, the response includes a warning, but the call still succeeds (treats WIP as guidance, not enforcement).
- **No hard delete** — the capability is not in the code. `archive_card` is the only destructive-feeling operation, and it's reversible from the Trello UI.

## Access control

Only one GitHub login (`dannbleeker`) can call any tool or open the dashboard — hard-coded in `src/allowlist.ts` (single source of truth for both surfaces). Any other authenticated GitHub user reaches the OAuth flow but every tool call returns a refusal message, and the dashboard answers 403.

**Session kill switch**: dashboard sessions live ~30 days in a signed cookie with no server-side session store. If a device is lost, rotate the signing key — `wrangler secret put COOKIE_ENCRYPTION_KEY` (new `openssl rand -hex 32`) — which instantly invalidates every session everywhere. The MCP connector re-authenticates via GitHub on its own.

## Web dashboard

A private, browser-accessible To-Do dashboard served by this same Worker — a hosted, always-on version of the desktop artifact. Open `https://trello-mcp.<your-subdomain>.workers.dev/dashboard` (or just `/`, which redirects) in any browser; you'll be sent through GitHub login the first time and get a ~30-day session cookie.

- **Zones**: health bar (inbox / next actions / waiting / big rocks + WIP status), quick capture → Inbox, cards-per-list overview, next actions by context with label filters, needs-attention (Waiting / Inbox), and Rolling Big Rocks (read-only).
- **Actions**: **✓ Done** sets `dueComplete=true` (the board's Butler automation moves the card to Done-do — same semantics as the `set_due_complete` tool); **Move** and **Quick capture** reuse the tools layer, so the [safety guards](#safety-guards) above apply identically.
- **Auth**: GitHub OAuth (same OAuth app as the MCP flow) + the `ALLOWED_LOGINS` allowlist, re-checked on every request. The JSON API under `/api/*` answers `401`/`403` and the page redirects itself to `/app/login`.
- **Routes**: `/dashboard`, `/app/login`, `/app/callback`, `/app/logout`, `/api/*` (cards, move, done, undo-done, capture, snoozed, wake, digest/send), plus public PWA assets (`/manifest.webmanifest`, `/icon.svg`). The MCP surface (`/mcp`) and the reserved OAuth endpoints (`/authorize`, `/callback`, `/token`, `/register`) are untouched.
- **Installable**: the dashboard ships a web-app manifest — "Add to Home Screen" installs it as a standalone app. Dark mode follows the device preference.
- **Digest monitoring (optional)**: set a [healthchecks.io](https://healthchecks.io) ping URL as the `HEARTBEAT_URL` secret; the Worker pings it after every successful daily send, so a silent digest failure becomes an email alert.

## Daily email digest

Since v1.14.0 the Worker also emails **"Todays Actions"** — a full HTML replica of the dashboard plus an *Overdue & due today* section — every day at **04:00 Europe/Copenhagen**, DST-proof, with board data fetched at send time.

- **Scheduling**: Cloudflare cron is UTC-only, so three triggers fire at 02:00/03:00/04:00 UTC and `src/digest/scheduler.ts` sends exactly once, at the first firing whose local hour is ≥ 4; the later firings retry automatically if the first attempt failed. A KV flag (written only on success) guarantees once per local day.
- **Delivery**: [Resend](https://resend.com), from `todo@bleeker-pedersen.dk` to `dann@bleeker-pedersen.dk` (both configurable via `DIGEST_FROM`/`DIGEST_TO` vars in `wrangler.jsonc`).
- **Testing it**: `GET /digest/preview` (session-gated) shows the exact email HTML in the browser; `POST /api/digest/send` sends one immediately.
- **Setup**: verify the sending domain in Resend (three DNS records on their own subdomains — root SPF/mail is untouched) and `wrangler secret put RESEND_API_KEY`. Until the key exists the scheduler logs and skips (fail-soft).

## Setup

### 1. GitHub OAuth app

Create an OAuth app at <https://github.com/settings/developers>:

- **Homepage URL:** `https://trello-mcp.<your-subdomain>.workers.dev`
- **Authorization callback URL:** `https://trello-mcp.<your-subdomain>.workers.dev/` (the origin root, **with** the trailing slash)
- Note the **Client ID** and generate a **Client secret**.

> **Why the origin root?** The MCP flow redirects to `/callback` and the web dashboard to `/app/callback`. A GitHub OAuth app has a single callback URL, but GitHub accepts any `redirect_uri` at or below the registered path — registering the root validates both. If you registered `/callback` before v1.12.0, broaden it to the root or the dashboard login will fail with `redirect_uri` mismatch (the MCP flow is unaffected either way).

For local development, register a second OAuth app with:

- **Homepage URL:** `http://localhost:8788`
- **Authorization callback URL:** `http://localhost:8788/`

### 2. Trello credentials

You need an API key and a user token:

| Value | Where |
|---|---|
| **API key** | <https://trello.com/power-ups/admin> → create an app → API key |
| **Token** | `https://trello.com/1/authorize?key=YOUR_KEY&name=Claude&expiration=never&response_type=token&scope=read,write` |

### 3. KV namespace + secrets

```sh
# install deps
pnpm install

# create the KV namespace, then paste the returned id into wrangler.jsonc
pnpm exec wrangler kv namespace create OAUTH_KV

# production secrets
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
pnpm exec wrangler secret put TRELLO_KEY
pnpm exec wrangler secret put TRELLO_TOKEN

# deploy
pnpm exec wrangler deploy
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in the values; then `pnpm dev`.

### 4. Add to claude.ai

Settings → Connectors → Add custom connector. URL: `https://trello-mcp.<your-subdomain>.workers.dev/mcp`. Sign in with GitHub when prompted.

## Adding a new board

1. In Trello: copy the board's 24-char ID from the URL or from a `list_boards` call.
2. In `src/trello/constants.ts`: add an entry to `BOARD_ALIASES`.
3. Optionally add list aliases under `LIST_ALIASES`.
4. Optionally mark any list as forbidden or read-only.
5. `pnpm exec wrangler deploy`.

No tool code changes are needed — the existing tools resolve aliases at call time.

## Project layout

```
src/
  index.ts                  — Worker entry, OAuth wiring, tool registrations
  allowlist.ts              — GitHub-login allowlist (shared: MCP + dashboard)
  github-handler.ts         — OAuth consent screen + GitHub callback; mounts the dashboard
  utils.ts                  — auth helpers (unchanged from template)
  workers-oauth-utils.ts    — cookie/state utilities (HMAC helpers exported for the dashboard)
  dashboard/
    handler.ts              — browser routes: /, /dashboard, /app/login|callback|logout, /digest/preview
    api.ts                  — session-gated JSON API: /api/cards|move|done|capture|digest/send
    session.ts              — signed __Host-DASH_SESSION cookie (sign/verify/expiry)
    page.html               — the dashboard page (imported as a wrangler Text module)
  digest/
    render.ts               — "Todays Actions" email HTML (pure function; full dashboard replica)
    scheduler.ts            — DST-proof 04:00-Copenhagen send window + KV dedupe + Resend call
  trello/
    client.ts               — typed Trello REST client (retry on 429 + 5xx)
    constants.ts            — aliases, forbidden + read-only lists, WIP parser
    guards.ts               — server-side safety guards
    tools.ts                — 96 tool implementations (testable in plain Node)
test/                       — vitest unit tests (107; no real Trello calls)
wrangler.jsonc              — Cloudflare Workers config
package.json
tsconfig.json
.dev.vars.example
```

## Development

```sh
pnpm install
pnpm type-check         # tsc --noEmit
pnpm dev                # wrangler dev → http://localhost:8788
```

## Related

- [`dannbleeker/trello-plugin`](https://github.com/dannbleeker/trello-plugin) — the local Python MCP for Claude Code on the same Trello account. The two coexist; this one is the remote connector for claude.ai.

## License

MIT.
