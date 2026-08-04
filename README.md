# Trello MCP — Personal remote connector for Claude

A small, opinionated [MCP](https://modelcontextprotocol.io/introduction) server that lets [Claude](https://claude.ai) read and update Trello boards. Runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/), gated behind GitHub OAuth, allowlisted to a single GitHub user.

Designed primarily around Dann Bleeker Pedersen's GTD workflow, but the underlying tools are generic — friendly aliases for boards / lists / labels live in [`src/trello/constants.ts`](src/trello/constants.ts) and are easy to extend for other workflows.

Since v1.19.0 the connector is **multi-workspace**: every board in every workspace on the account is reachable by name, with no configuration — see [Workspaces](#workspaces).

Since v1.12.0 the same Worker also serves a private **web To-Do dashboard** at `/dashboard` — see [Web dashboard](#web-dashboard).

## Tools (102)

**Reads**

| Tool | Purpose |
|---|---|
| `list_boards` | All open boards the user belongs to, in every workspace, each tagged with its workspace; optional `workspace` filter |
| `list_workspaces` | Every workspace on the account with the boards it holds — the entry point on a multi-workspace account |
| `list_lists` | Lists on a board (alias, name, ID, or board URL) |
| `list_cards` | Cards on a list or board; includes `desc`; optional `label` / `staleDays` filters |
| `list_cards_by_list` | Read one list with `excludeDueDates` / `includeSnoozedOnly` / `staleDays` filters |
| `list_cards_due` | Filter by scope: `today` / `overdue` / `next_seven_days`; emits `snoozed` + `wakeUp` |
| `list_archived_cards` | Closed (archived) cards on a board — same CardSummary shape as list_cards |
| `get_card` | Full details for one card |
| `search_cards` | Fuzzy name search, scoped by `board` or `workspace` (or unscoped); includes `desc` |
| `search_cards_advanced` | `/search` with operator support: `due:overdue`, `label:red`, `has:attachments`, multi-board **and multi-workspace** scope |
| `list_checklist_items` | Checklists + items on a card |
| `list_attachments` | Attachments on a card (id, name, url, date, mimeType) |
| `get_attachment` | Fetch a single attachment with richer fields (previews[], edgeColor, pos) than list_attachments returns |
| `list_labels` | All labels on a board (id, name, color) |
| `get_label` | Fetch one label directly by ID or by name (with board scope) |
| `list_board_members` | Everyone with access to a board (id, fullName, username, initials) |
| `list_card_members` | Members assigned to one card |
| `list_my_cards_assigned` | Cross-board, cross-workspace "everything assigned to me"; optional `board` / `workspace` filter |
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
| `list_custom_fields` | Custom-field DEFINITIONS on a board (errors actionably if the Power-Up is off) |
| `list_card_custom_fields` | A card's custom-field values, joined to their definitions (name + type, option labels resolved, unset fields as `null`) |
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
| `delete_custom_field` | Delete a custom-field definition — destructive, requires `confirm: true` (removes every card's value for it) |
| `add_custom_field_option` | Add an option to a list-type custom field |
| `delete_custom_field_option` | Remove an option from a list-type custom field |
| `set_card_custom_field` | Set a custom-field value on a card (polymorphic: checkbox / date / number / text / list, or null to clear) — value is checked against the field's declared type |
| `batch_set_card_custom_field` | Set the same custom field to the same value across many cards (resolves + type-checks once per board) |
| `rename_custom_field_option` | Rename a list-type option without losing the cards using it (Trello has no update-option endpoint) |
| `enable_board_plugin` | Enable a Power-Up on a board by alias (custom-fields, card-aging, voting, calendar) or ID |
| `disable_board_plugin` | Disable a Power-Up (takes the boardPlugin id from list_board_plugins, NOT the idPlugin — Trello REST quirk) |

## Workspaces

The connector is workspace-agnostic. Trello scopes everything to the member behind the API token, so a workspace added to the account after the Worker was deployed is visible immediately — no redeploy, no code change.

**Start with `list_workspaces`.** It returns every workspace on the account with the boards it holds, plus a `(no workspace)` bucket for personal boards and any workspace a board was merely *shared* from:

```jsonc
{
  "workspaces": [
    { "id": "…", "name": "techretail1", "displayName": "TECH Retail",
      "boards": [ { "id": "…", "alias": null, "name": "TECH Retail Decision Board", "workspace": {…} } ] },
    …
  ]
}
```

### Referring to a board

Anywhere a tool takes `board`, it accepts — in this order:

| Form | Example | Notes |
|---|---|---|
| Alias | `zoo` | From `BOARD_ALIASES` in `constants.ts`. No API call. |
| 24-char ID | `6a6711c43b20b9486ab1c9f6` | Passed straight through. No API call. |
| Board URL | `https://trello.com/b/xKeUkW8V/…` | Paste from the browser; the short link is used as the ID. |
| **Board name** | `TECH Retail Decision Board` | Matched live against every board the account can see, in any workspace. |

Name matching is case-insensitive and tiered: an exact match wins, then unique prefix, then unique substring — so `tech retail` finds the board above, while `Done` matching lists on three boards is **refused, not guessed**, with an error naming each candidate and its workspace. That refusal is the design: two workspaces will eventually both have a "Roadmap", and silently picking one is worse than asking.

### Referring to a list

`list` accepts an alias, a 24-char ID, or a **list name**. A name is resolved on `board` when you pass one, otherwise across every board the account can see. Since generic list names (`Backlog`, `Doing`, `Done`) collide across boards by nature, pass `board` alongside `list` on any multi-workspace board:

```jsonc
create_card({ board: "TECH Retail Decision Board", list: "Backlog", name: "Ship it" })
```

### Narrowing by workspace

`workspace` takes a short name (`techretail1`), a display name (`TECH Retail`), or an ID. It appears on:

- `list_boards` / `list_my_cards_assigned` — filters the result set
- `search_cards` (`workspace`) and `search_cards_advanced` (`workspaces[]`) — passed to Trello as `idOrganizations`, so the search runs workspace-scoped server-side
- any board lookup — disambiguates a board name that exists in two workspaces

### What stays single-board

Two surfaces are deliberately tied to the GTD board and are *not* workspace-generic: the **daily digest** and the **`weekly_review_pack`** tool. Both are shaped around `dann-to-do`'s specific lists (Inbox, @Contexts, Could-do horizons), and `weekly_review_pack` refuses another board outright rather than returning all-zero buckets. The **dashboard** defaults to the same board but accepts `?board=` with any of the reference forms above.

### Caching

Board / workspace / list directory reads are cached per client for 60 seconds, so name resolution costs at most one round trip per minute rather than one per call. `list_boards` and `list_workspaces` always bypass the cache — a board created seconds ago must show up in the tool you'd use to look for it.

## Safety guards

Enforced server-side before any Trello call — same rules for every tool, no per-tool drift:

- **Forbidden lists** (Butler, Repeater Cards) — all writes refused. These lists hold automation rules and recurring templates; the connector observes but never modifies them.
- **Read-only lists** (Rolling Big Rocks) — `move_card` source OR destination refused. `create_card` to this list refused.
- **WIP-limit warnings** — when a `move_card` or `create_card` puts a list with a `(WIP limit N)` suffix over its limit, the response includes a warning, but the call still succeeds (treats WIP as guidance, not enforcement).
- **No hard delete** — the capability is not in the code. `archive_card` is the only destructive-feeling operation, and it's reversible from the Trello UI.
- **`delete_custom_field` requires `confirm: true`** — deleting a field definition also erases its value on every card on the board, which is the one operation here that destroys data across many cards at once. Without the flag the call is refused, and the refusal names the field it would have deleted.
- **Custom-field values are type-checked** — `set_card_custom_field` reads the field's declared type before writing and refuses a mismatched value (naming the key you should have used) rather than letting Trello 400 or silently no-op.

## Custom fields

Custom fields are a Power-Up, so a board needs it enabled first — `enable_board_plugin("custom-fields")`. If it isn't on, the read tools say so and tell you which call fixes it, rather than returning an empty list you'd have to interpret.

Every custom-field tool takes a field by **name or ID**, the same way boards and lists already resolve, and list-type options resolve by their **label** as well as their ID:

```jsonc
// Both of these do the same thing.
set_card_custom_field({ cardId, customFieldId: "Priority",                  value: { listOptionId: "High" } })
set_card_custom_field({ cardId, customFieldId: "eeeeeeee…", value: { listOptionId: "1111aaaa…" } })
```

Names are looked up on the `board` param (default board when omitted); `set_card_custom_field` infers the board from the card. An ambiguous name is refused with the candidate IDs rather than guessed.

Reads come back joined to their definitions — `name`, `type`, list values resolved to the option's label, and fields that have never been set included as `value: null` (Trello omits those entirely, which makes "unset" and "no such field" indistinguishable):

```jsonc
{ "id": "…", "idCustomField": "…", "name": "Priority", "type": "list",
  "idValue": "2222bbbb…", "value": { "text": "Low" } }
```

`get_card`, `list_cards`, `list_cards_by_list`, `search_cards`, `search_cards_advanced` and `weekly_review_pack` all take `customFields: true` to include the same block. It's opt-in everywhere: values ride along on the card fetch, but joining them to their names costs a definition lookup, and these are hot paths. Definitions are memoised per board for the life of a request, so a batch operation pays for that lookup once, not once per card.

The dashboard and the morning digest render custom-field values as badges automatically when the board has any — deliberately quieter than the label badges, since a custom field is data *about* a card rather than a flag *on* it.

Two operations exist because Trello's API can't do them directly:

- **`batch_set_card_custom_field`** — same field, same value, many cards. Resolves and type-checks once per board instead of once per card.
- **`rename_custom_field_option`** — Trello has GET/POST/DELETE on options but no PUT, so an option's label is immutable and the obvious workaround (delete + re-add) silently clears the field on every card pointing at it. This adds the new option, re-points affected cards, then deletes the old one. If any card fails to move it stops and leaves *both* options in place rather than destroying values.

`create_card` accepts a `customFields` array. Trello can't set them on the create call, so they're applied as follow-ups and reported per field — the card is still returned if one fails, because reporting a hard failure would invite a retry that creates a duplicate.

Copying a card: name `customFields` explicitly in `keepFromSource`. Atlassian changed the semantics so that `all` is not a safe assumption for custom fields.

One real limitation: **`search_cards_advanced` can't filter on custom-field values.** Trello's search syntax doesn't support them. `customFields: true` annotates the results so you can filter the returned rows, but it can't narrow the search itself.

## Access control

Only one GitHub login (`dannbleeker`) can call any tool or open the dashboard — hard-coded in `src/allowlist.ts` (single source of truth for both surfaces). Any other authenticated GitHub user reaches the OAuth flow but every tool call returns a refusal message, and the dashboard answers 403.

**Session kill switch**: dashboard sessions live ~30 days in a signed cookie with no server-side session store. If a device is lost, rotate the signing key — `wrangler secret put COOKIE_ENCRYPTION_KEY` (new `openssl rand -hex 32`) — which instantly invalidates every session everywhere. The MCP connector re-authenticates via GitHub on its own.

## Web dashboard

A private, browser-accessible To-Do dashboard served by this same Worker — a hosted, always-on version of the desktop artifact. Open `https://trello-mcp.<your-subdomain>.workers.dev/dashboard` (or just `/`, which redirects) in any browser; you'll be sent through GitHub login the first time and get a ~30-day session cookie.

- **Zones**: health bar (inbox / next actions / waiting / big rocks + WIP status), quick capture → Inbox, cards-per-list overview, next actions by context with label filters, needs-attention (Waiting / Inbox), and Rolling Big Rocks (read-only, each showing how long it has gone untouched, stalest first — a big rock has no due date and no actions, so age is the only signal that one is being buried).
- **Staleness, per zone**: no card on the board carries a due date, so age is the live signal. A card shows `untouched N` once it passes its zone's threshold — Inbox at 7 days, Waiting-for at 10, next actions at 14, big rocks always. Red at 21 / 21 / 30, and for big rocks amber at a full quarter (90 days) with the alarm a month past it, since they're quarterly goals that may legitimately roll over. Outside big rocks a healthy board shows none of them.
- **Weekly review panel**: the Could-do horizon counts and the stale waiting-for items — the two things the daily board deliberately hides. Backed by the same `weekly_review_pack` tool the digest and an MCP-driven review use, so all three read identical numbers. Opens itself on Fridays, a one-line strip otherwise, fetched only when open.
- **Phone-ready**: ~44px touch targets under `pointer: coarse` (not a width breakpoint, so a narrow desktop window keeps the compact layout), and a 16px capture input so iOS doesn't auto-zoom. Captures made **offline** are queued in `localStorage` and flushed oldest-first when the connection returns; a capture that fails while *online* is not queued, since it may already have reached Trello and `/api/capture` has no idempotency key.
- **Layout comes from the board**, not from constants: `/api/cards` returns the board's lists, and the page treats any list named `@…` as a context (WIP parsed from the `(WIP limit N)` suffix) plus four roles matched by name — Inbox, Waiting for…, Done-do, Rolling Big Rocks. Everything else — Could-do (\*), Someday maybe, Repeater Cards, Butler — stays off the dashboard. Add a context list or change a WIP limit in Trello and it lands here on the next refresh; `/dashboard?board=<alias|name|id|url>` points the whole view at another board.
- **Labels**: every label a card carries renders as a badge, coloured from its Trello palette colour — a label added on the board shows up here (and in the digest) without a code change. `BESTSELLER`, `DBP Invest` and `Please Clarify and Organize` keep a hand-tuned look, the last one shortened to `clarify`.
- **Filter chips** above Next actions: `All` / `BESTSELLER` / `DBP Invest` / `SSF` / `Personal`, each with a live count, persisted per browser. `Personal` is the residual — a card in none of the labelled spheres. The chips are defined in one `FILTER_LABELS` list in `page.html` that the counts, the chip row and the filter predicate all derive from, so adding a sphere is a one-line change that narrows `Personal` by the same stroke.
- **Actions**: **✓ Done** sets `dueComplete=true` (the board's Butler automation moves the card to Done-do — same semantics as the `set_due_complete` tool); **Move** and **Quick capture** reuse the tools layer, so the [safety guards](#safety-guards) above apply identically.
- **Auth**: GitHub OAuth (same OAuth app as the MCP flow) + the `ALLOWED_LOGINS` allowlist, re-checked on every request. The JSON API under `/api/*` answers `401`/`403` and the page redirects itself to `/app/login`.
- **Routes**: `/dashboard`, `/app/login`, `/app/callback`, `/app/logout`, `/api/*` (cards, move, done, undo-done, capture, snoozed, wake, digest/send), plus public PWA assets (`/manifest.webmanifest`, `/icon.svg`). The MCP surface (`/mcp`) and the reserved OAuth endpoints (`/authorize`, `/callback`, `/token`, `/register`) are untouched.
- **Installable**: the dashboard ships a web-app manifest — "Add to Home Screen" installs it as a standalone app. Dark mode follows the device preference.
- **Digest monitoring (optional)**: set a [healthchecks.io](https://healthchecks.io) ping URL as the `HEARTBEAT_URL` secret; the Worker pings it after every successful daily send, so a silent digest failure becomes an email alert.

## Usage tracking

Since v1.21.0 the Worker records **which tools actually get used** — per tool and per Trello endpoint, not just an overall request count. Full detail in [`docs/usage-tracking.md`](docs/usage-tracking.md).

- **Two event kinds**: one row per MCP tool call (`list_cards`) and one per Trello REST call (`GET /cards/{id}`, path-templated so IDs don't explode the cardinality). They're not 1:1 — `weekly_review_pack` is one tool call and about a dozen Trello requests, which is exactly the fan-out worth seeing.
- **Tagged by surface** — `mcp` / `dashboard` / `cron` — because all three share the Trello client, and by outcome: `ok` / `guard` / `trello` / `internal`. That last split is the useful one: a tool that routinely refuses at the guard is usually a tool-*description* problem, and cheaper to fix than anything else.
- **Three sinks, all optional and fail-soft.** Analytics Engine (`USAGE`, 3-month retention, non-blocking writes, dataset auto-created); D1 (`USAGE_DB`, unlimited retention, buffered so a 12-request tool costs one `INSERT`); and structured `console.log` picked up by Workers Logs. With no bindings present the recorder no-ops and the Worker is unchanged.
- **Never records argument values.** Card titles, comment bodies and search queries stay in the Worker — the recorder takes a name, an outcome and timings, and has no argument channel at all. The request URL never reaches a sink either, since it carries `key` and `token`.
- **Dashboard panel**: `/dashboard` → **Usage**, collapsed by default and lazy-loaded. Bars per tool or per endpoint over 7 / 30 / 90 days. It reads the D1 mirror rather than Analytics Engine, which is what keeps a Cloudflare API token out of the Worker entirely.

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

## Adding a new board or workspace

**Nothing is required.** Since v1.19.0 a new board — in an existing workspace or a brand-new one — is reachable by name the moment Trello knows about it: `list_workspaces` shows it, and every `board` argument accepts its name, ID or URL. See [Workspaces](#workspaces).

Adding an **alias** is still worth it for a board you touch constantly (it saves a name lookup and reads better in a prompt):

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
  usage.ts                  — per-tool / per-endpoint usage recorder (AE + D1 + logs)
  github-handler.ts         — OAuth consent screen + GitHub callback; mounts the dashboard
  utils.ts                  — auth helpers (unchanged from template)
  workers-oauth-utils.ts    — cookie/state utilities (HMAC helpers exported for the dashboard)
  dashboard/
    handler.ts              — browser routes: /, /dashboard, /app/login|callback|logout, /digest/preview
    api.ts                  — session-gated JSON API: /api/cards|move|done|capture|digest/send|usage
    session.ts              — signed __Host-DASH_SESSION cookie (sign/verify/expiry)
    page.html               — the dashboard page (imported as a wrangler Text module)
  digest/
    render.ts               — "Todays Actions" email HTML (pure function; full dashboard replica)
    scheduler.ts            — DST-proof 04:00-Copenhagen send window + KV dedupe + Resend call
  trello/
    client.ts               — typed Trello REST client (retry on 429 + 5xx)
    constants.ts            — aliases, forbidden + read-only lists, WIP parser
    resolve.ts              — workspace / board / list reference resolution + directory cache
    guards.ts               — server-side safety guards
    tools.ts                — 102 tool implementations (testable in plain Node)
test/                       — vitest unit tests (352; no real Trello calls)
migrations/                 — D1 schema for the usage_events table
docs/                       — usage-tracking.md, snooze-v2.md
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
