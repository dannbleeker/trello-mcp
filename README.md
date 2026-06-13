# Trello MCP — Personal remote connector for Claude

A small, opinionated [MCP](https://modelcontextprotocol.io/introduction) server that lets [Claude](https://claude.ai) read and update Trello boards. Runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/), gated behind GitHub OAuth, allowlisted to a single GitHub user.

Designed primarily around Dann Bleeker Pedersen's GTD workflow, but the underlying tools are generic — friendly aliases for boards / lists / labels live in [`src/trello/constants.ts`](src/trello/constants.ts) and are easy to extend for other workflows.

## Tools (48)

**Reads**

| Tool | Purpose |
|---|---|
| `list_boards` | All open boards the authenticated Trello user belongs to |
| `list_lists` | Lists on a board (alias or ID) |
| `list_cards` | Cards on a list or board; includes `desc`; optional `label` / `staleDays` filters |
| `list_cards_by_list` | Read one list with `excludeDueDates` / `includeSnoozedOnly` / `staleDays` filters |
| `list_cards_due` | Filter by scope: `today` / `overdue` / `next_seven_days`; emits `snoozed` + `wakeUp` |
| `get_card` | Full details for one card |
| `search_cards` | Fuzzy name search, scoped or unscoped; includes `desc` |
| `search_cards_advanced` | `/search` with operator support: `due:overdue`, `label:red`, `has:attachments`, multi-board scope |
| `list_checklist_items` | Checklists + items on a card |
| `list_attachments` | Attachments on a card (id, name, url, date, mimeType) |
| `list_labels` | All labels on a board (id, name, color) |
| `list_board_members` | Everyone with access to a board (id, fullName, username, initials) |
| `list_card_members` | Members assigned to one card |
| `list_my_cards_assigned` | Cross-board "everything assigned to me"; optional board filter |
| `read_comments` | Chronological comment thread on a card |
| `card_activity_log` | Recent actions on a card — moves, due-date edits, label/comment/attachment events |
| `snooze_read` | Cards whose `dueReminder` is set, sorted by computed wake-up time. Note: `dueReminder` is the reminder-offset field, not a true snooze — Trello has no native snooze in its REST API |
| `weekly_review_pack` | One-call GTD snapshot: inbox, overdue, due-today, due-this-week, context-list counts, waiting stale, could-do horizons, snoozed, big-rocks |

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

## Safety guards

Enforced server-side before any Trello call — same rules for every tool, no per-tool drift:

- **Forbidden lists** (Butler, Repeater Cards) — all writes refused. These lists hold automation rules and recurring templates; the connector observes but never modifies them.
- **Read-only lists** (Rolling Big Rocks) — `move_card` source OR destination refused. `create_card` to this list refused.
- **WIP-limit warnings** — when a `move_card` or `create_card` puts a list with a `(WIP limit N)` suffix over its limit, the response includes a warning, but the call still succeeds (treats WIP as guidance, not enforcement).
- **No hard delete** — the capability is not in the code. `archive_card` is the only destructive-feeling operation, and it's reversible from the Trello UI.

## Access control

Only one GitHub login (`dannbleeker`) can call any tool — hard-coded in `src/index.ts`. Any other authenticated GitHub user reaches the OAuth flow but every tool call returns a refusal message.

## Setup

### 1. GitHub OAuth app

Create an OAuth app at <https://github.com/settings/developers>:

- **Homepage URL:** `https://trello-mcp.<your-subdomain>.workers.dev`
- **Authorization callback URL:** `https://trello-mcp.<your-subdomain>.workers.dev/callback`
- Note the **Client ID** and generate a **Client secret**.

For local development, register a second OAuth app with:

- **Homepage URL:** `http://localhost:8788`
- **Authorization callback URL:** `http://localhost:8788/callback`

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
  github-handler.ts         — OAuth consent screen + GitHub callback
  utils.ts                  — auth helpers (unchanged from template)
  workers-oauth-utils.ts    — cookie/state utilities (unchanged from template)
  trello/
    client.ts               — typed Trello REST client (retry on 429 + 5xx)
    constants.ts            — aliases, forbidden + read-only lists, WIP parser
    guards.ts               — server-side safety guards
    tools.ts                — 48 tool implementations (testable in plain Node)
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
