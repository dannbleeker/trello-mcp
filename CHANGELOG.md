# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.0] — 2026-07-10

### Added
- **Daily email digest (Phase 2)** — "Todays Actions": a full, email-safe HTML
  replica of the dashboard, sent every day at 04:00 Europe/Copenhagen to
  `dann@bleeker-pedersen.dk` via [Resend](https://resend.com), with board data
  fetched at send time.
  - **DST-proof scheduling**: Cloudflare cron is UTC-only, so `wrangler.jsonc`
    fires at 02:00/03:00/04:00 UTC and `src/digest/scheduler.ts` sends exactly
    once, at the first firing whose Copenhagen hour is in [4, 6]. Later firings
    are free retry slots if the first attempt failed (Trello/Resend down).
    A KV sent-flag (keyed by local date, TTL 2 days, written only on success)
    guarantees once-per-day. EU DST switches at 01:00 UTC — before the first
    firing — so transition days need no special-casing.
  - **Email content** (`src/digest/render.ts`, pure function, no I/O): health
    bar with WIP status, an email-only **"Overdue & due today"** section
    (bucketed with the DST-correct local-day boundary from v1.13.0, actionable
    lists only), all five context columns, Waiting, Inbox, and Rolling Big
    Rocks — every card linking to Trello, plus a link to the live dashboard.
    Inline styles only; no JS, no external assets.
  - **Owner test routes** (session-gated like the rest of the dashboard):
    `GET /digest/preview` renders the exact email HTML in the browser;
    `POST /api/digest/send` sends one immediately.
  - **Fail-soft**: the Worker deploys and runs before the Resend account
    exists — a missing `RESEND_API_KEY` logs and skips instead of throwing.
    Resend failures are reported by status only (no upstream body leakage).
- **Tests** (+14, total 130): renderer zones/escaping/scheme-check, local-day
  due bucketing across the Copenhagen midnight, exclusion rules (dueComplete,
  closed, dividers, non-actionable lists), WIP-over marker, `hourInTz` on both
  2026 DST transition days, KV dedupe, retry-after-failure, fail-soft missing
  key, opaque Resend errors.

### Changed
- `src/index.ts` default export widened from the bare `OAuthProvider` to
  `{ fetch, scheduled }` — `fetch` delegates to the unchanged provider (HTTP
  behavior identical, verified against `wrangler dev`), `scheduled` runs the
  digest. New `triggers.crons` + `vars` (`DIGEST_FROM`/`DIGEST_TO`) in
  `wrangler.jsonc`; `RESEND_API_KEY` secret documented in README.

### Setup (manual, one-time)
- Resend account + verified sending domain (`bleeker-pedersen.dk`): three DNS
  records (DKIM TXT `resend._domainkey`, MX + SPF TXT on `send`) — they live on
  their own subdomains, so the root SPF/Simply mail setup is untouched.
- `wrangler secret put RESEND_API_KEY`.

## [1.13.0] — 2026-07-10

Audit release: full-codebase security review + bug hunt + maintainability pass.
The security review found **no exploitable vulnerabilities** (both OAuth flows,
cookie/HMAC primitives, dashboard API, page rendering, client, and guards were
examined); the low-confidence hardening notes it produced are fixed below.

### Fixed
- **`startOfDayMsInTz` DST day-boundary error** (`src/trello/tools.ts`) — the
  local-midnight computation assumed the UTC offset at midnight equals the
  offset now, so on the two Europe/Copenhagen DST transition days
  `list_cards_due scope:"today"` and `weekly_review_pack.due_today`
  mis-bucketed cards by one hour (and the returned midnight kept sub-second
  residue). Now derives the actual UTC instant of local 00:00:00 via a
  convergent two-pass offset correction. New regression tests pin the
  2026-03-29 spring-forward and 2026-10-25 fall-back days.
- **Non-idempotent POSTs are no longer retried on 5xx**
  (`src/trello/client.ts`) — a gateway 5xx can arrive after Trello committed
  the write (timeout-after-commit), so the automatic retry could duplicate
  cards/comments/attachments. 5xx retry is now limited to GET/PUT/DELETE;
  429 stays retried for every method (Trello rejected those before acting).
- **`/api/done` is now deterministic for cards without a due date**
  (`src/dashboard/api.ts`) — it still sets `dueComplete=true` (Butler triggers
  keep firing) but then moves the card to Done-do itself. Previously a
  no-due-date card silently stayed in its column forever (Butler's
  due-complete trigger never fires without a due date), and a page reload
  racing Butler "resurrected" done cards.
- **Trello 4xx no longer masquerade as 502** (`src/dashboard/api.ts`) — a
  stale/deleted cardId now returns 404 (422 for other Trello 4xx) with an
  opaque message; 502 is reserved for genuine Trello 5xx.
- **`batch_get` rejects paths containing commas** (`src/trello/tools.ts`) —
  Trello's `/batch` splits the joined parameter on commas with no escaping,
  so `?fields=name,desc` silently shattered into bogus extra requests and
  misaligned results. Now refused with a clear GuardError.
- **`/app/callback` failure handling** (`src/dashboard/handler.ts`) — a
  GitHub/token-exchange failure now returns a friendly 502 instead of an
  unhandled bare 500, and every exit path clears the one-time
  `__Host-DASH_STATE` cookie.
- **Dashboard page fixes** (`src/dashboard/page.html`):
  - `render()` no longer wipes half-typed quick-capture text (value, focus,
    and caret survive filter clicks and card actions).
  - After a failed Move, the dropdown resets to the placeholder so retrying
    the same destination re-fires (previously a silent no-op).
  - A successful capture followed by a failed board refresh no longer reports
    "Couldn't add" (which invited duplicate re-submits) — the created card is
    appended locally instead.
  - WIP-limit warnings returned by the API are now shown in the toast
    (previously dropped — the MCP surface warned, the dashboard didn't).

### Security hardening (no exploitable issue; defense-in-depth from the review)
- `esc()` in `page.html` now escapes single quotes; card links only render as
  anchors for `http(s)` URLs, mirroring the server's `sanitizeUrl` whitelist.

### Changed
- Small maintainability refactor in `src/dashboard/api.ts`: shared `trello()`
  client-construction helper.

## [1.12.0] — 2026-07-10

### Added
- **Web To-Do dashboard (Phase 1)** — a private, browser-accessible dashboard
  served by this same Worker, alongside (and without touching) the `/mcp`
  MCP surface. A later phase will add a daily email digest; this release is
  the interactive dashboard only.
  - **Routes** (all served by the OAuthProvider `defaultHandler`; the reserved
    `/authorize`, `/callback`, `/token`, `/register`, `/mcp` endpoints are
    untouched):
    - `GET /` → 302 to `/dashboard`.
    - `GET /dashboard` — the dashboard page (`src/dashboard/page.html`,
      imported as a wrangler Text module) for a valid allowlisted session;
      302 to `/app/login` otherwise.
    - `GET /app/login` / `GET /app/callback` / `GET /app/logout` — browser
      GitHub OAuth flow reusing the existing GitHub OAuth app
      (`scope read:user`), with a one-time `__Host-DASH_STATE` CSRF cookie
      (distinct from the MCP flow's `__Host-CONSENTED_STATE`).
    - `GET /api/cards?board=<id>` → `{ cards }`;
      `POST /api/move { cardId, list }` → `{ ok }`;
      `POST /api/done { cardId }` → `{ ok }` (sets `dueComplete=true`; the
      board's Butler automation moves the card to Done-do — same semantics
      as the `set_due_complete` tool);
      `POST /api/capture { name }` → 201 `{ card }` (destination is always
      the Inbox, chosen server-side).
  - **Auth**: `__Host-DASH_SESSION` cookie (`HttpOnly; Secure; SameSite=Lax;
    Path=/`, ~30-day expiry), payload `{ login, exp }` HMAC-SHA256-signed
    with the existing `COOKIE_ENCRYPTION_KEY`. Every gated request re-checks
    `ALLOWED_LOGINS`, so removing a login revokes dashboard access on the
    next request. `/api/*` returns JSON `401`/`403` (never a redirect);
    mutating routes also reject foreign `Origin` headers.
  - **Guard parity**: `/api/move` and `/api/capture` reuse the tools layer
    (`move_card`, `create_card`), so the dashboard obeys the exact same
    forbidden-list / read-only / WIP-warning guards as the MCP tools.
    Guard refusals surface as `403 { error }`; Trello upstream failures as
    an opaque `502` (no upstream body leakage); invalid input as `400`.
- **Tests** (+25, total 107): session cookie sign→verify round-trip, tamper /
  wrong-secret / expiry rejection, cookie-attribute pins (`dashboard-session.test.ts`);
  API session gate (401 no session, 401 tampered, 403 non-allowlisted,
  403 foreign Origin), `/api/cards` happy path + 400 + opaque 502,
  `/api/move` validation + happy path + guard refusal before any upstream
  call, `/api/done` semantics (`dueComplete=true` on the PUT), `/api/capture`
  validation + server-chosen Inbox destination (`dashboard-api.test.ts`).
  All with `globalThis.fetch` mocked — no real Trello calls.

### Changed
- `ALLOWED_LOGINS` moved from `src/index.ts` to `src/allowlist.ts` so the MCP
  guard and the dashboard share one allowlist. Import-only change; the MCP
  surface, tool registrations, and tool behavior are byte-for-byte unchanged.
- `signData` / `verifySignature` in `src/workers-oauth-utils.ts` are now
  exported (previously module-private) so the dashboard session cookie uses
  the exact same HMAC primitive as `__Host-APPROVED_CLIENTS`. No behavior
  change.
- `wrangler.jsonc`: added a Text module rule (`**/*.html`) so the dashboard
  page imports as a string. Additive; no effect on `/mcp`.

### Setup (manual, one-time)
- The GitHub OAuth app's **Authorization callback URL** must be broadened to
  the Worker origin root (e.g. `https://trello-mcp.<subdomain>.workers.dev/`)
  so both `/callback` (MCP flow) and `/app/callback` (dashboard flow)
  validate. GitHub accepts any `redirect_uri` at or below the registered
  path, so the existing MCP flow keeps working. See README → Setup.

## [1.11.0] — 2026-07-02

### Added
- **vitest test suite** — 82 unit tests across 7 files under `test/`:
  - `guards.test.ts` (14 tests) — every safety guard: FORBIDDEN refusal
    (Butler, Repeater Cards), READ_ONLY refusal (Rolling Big Rocks),
    composition via `assertCanWriteTo`, WIP-warning threshold logic.
  - `constants.test.ts` (16 tests) — `resolveBoard` / `resolveList` /
    `resolvePlugin` alias & raw-ID handling; reverse lookups; WIP-limit
    suffix parser.
  - `tools-helpers.test.ts` (17 tests) — `computeWakeUp` (null due,
    null reminder, `-1` reminder, valid case), `decodeBase64` (plain,
    data-URI prefix, whitespace, invalid, empty), `summariseCard` (missing
    `idMembers`, list alias resolution), `startOfDayMsInTz` (UTC baseline,
    CEST summer, CET winter).
  - `client-helpers.test.ts` (10 tests) — `clampLimit` (in-range,
    max ceiling, custom max, below-1 floor), `parseRetryAfterMs` (null,
    integer seconds, HTTP-date, past-date floor, unparseable fallback).
  - `client-request.test.ts` (5 tests) — mocks `globalThis.fetch` and
    verifies: 200 first try, 429→200 retry with `Retry-After` timing,
    persistent 5xx throws `TrelloError` after 3 attempts, non-retriable
    4xx does not retry, `key` + `token` land on the query string.
  - `client-methods.test.ts` (11 tests) — URL + param assertions for a
    representative sample of client methods. Includes explicit regression
    pins for:
    - v1.7.1: `setCardCover(color=purple)` does NOT put
      `idAttachment:null` in the cover blob.
    - v1.9.0: `updateCustomField(displayCardFront=true)` preserves the
      literal `/` in the URL (not `%2F`).
    - v1.9.0: `batchGet` normalises non-numeric response keys to
      `statusCode: 502` (not NaN).
    - v1.9.0: `markAllNotificationsRead` does not send the broken
      `ids=` param.
  - `set_card_custom_field.test.ts` (9 tests) — the polymorphic
    discriminated-union tool: `checkbox` / `date` / `number` / `text` /
    `listOptionId` / `null` payload dispatch, plus GuardError on invalid
    ISO date and non-finite number.
- **`test` job in CI** — `pnpm test` runs alongside `pnpm type-check` in
  `.github/workflows/ci.yml`.
- **Exports**: `computeWakeUp`, `decodeBase64`, `summariseCard`,
  `startOfDayMsInTz`, `clampLimit`, `parseRetryAfterMs` are now exported
  from their respective modules so tests can pin them directly. Also
  exported the `CardSummary` interface for test consumption.

### Fixed
- No runtime fixes in this release. The test suite validates existing
  behavior; if any assertion had failed, the corresponding fix would
  ship in v1.11.x.

## [1.10.0] — 2026-07-02

### Changed
Refactor pass surfaced by the v1.8.0 audit. No behavior changes except
`add_comment` now returns the created action ID (additive, not breaking).
Tool surface still 96.

**Extractions:**
- `CARD_FIELDS` + `MEMBER_FIELDS` constants in `constants.ts` — replaces
  12 duplicated field-selector strings across `client.ts`.
- `ROLLING_BIG_ROCKS_ID` constant now imported from `constants.ts` — was
  hardcoded in `tools.ts` with a misleading "pulled from constants.ts"
  comment.
- `warnIfWipExceeded(client, listId, boardId)` helper — replaces the 5-line
  post-write `[destCards, allLists] = Promise.all([...]); wipWarning(...)`
  pattern that appeared 4× (`create_card`, `move_card`, `copy_card`,
  `batch_move_cards`).
- `clampLimit(limit, max=1000)` helper — replaces 4 inline
  `Math.min(Math.max(limit, 1), 1000)` clamps.
- `retryableFetch(url, initFactory)` internal method on the client — the
  retry loop from `request()` and the entire duplicated retry loop from
  `addFileAttachment` now share one implementation. `addFileAttachment`
  shrunk from ~30 lines to ~15 while keeping FormData single-shot semantics
  (initFactory rebuilds the form per attempt).

**Type hygiene:**
- `ChecklistItem` interface now models `due?: string | null` and
  `idMember?: string | null` directly. The `ChecklistItemWithExtras`
  cast that shoehorned these in `tools.ts` is gone.
- `add_comment` returns `{ ok: true, commentId }`. Callers can immediately
  update / delete / react to the comment without a follow-up
  `read_comments` call. Previously the created action ID was thrown away.
- `list_my_actions` now returns `author` in each action, matching the
  siblings `card_activity_log` and `list_list_actions`. Was silently
  dropped before.

**Cosmetic:**
- Section comments in `tools.ts` — the stale `// READS (6)` /
  `// WRITES (9)` labels reflected v1.0.0 counts. Now explicitly labelled
  as v1.0.0-originals so future additions don't rewrite the boundaries.
- Trivial `aliasToId = alias => resolveList(alias)` local in
  `weekly_review_pack` removed; `resolveList` is called directly.

## [1.9.0] — 2026-07-02

### Fixed
All 18 bugs surfaced by the v1.8.0 audit workflow. No new tools; tool surface
still 96.

**READ_ONLY guard bypasses (4 tools):**
- `move_list`, `archive_list`, `archive_all_cards` — now refuse Rolling Big
  Rocks via `assertNotReadOnly` alongside the existing `assertWritable`.
- `convert_checklist_item_to_card` — refuses when the source card is on a
  READ_ONLY list and no `targetList` is provided (Trello births the new card
  on the source list otherwise).

**Silent-wrong-behavior:**
- `list_card_custom_fields` — parses Trello's `"true"`/`"false"` strings to
  booleans and stringified numbers to Numbers. Previously `"false"` was
  truthy and `"10"` sorted before `"9"`.
- `move_all_cards` — fetches the destination list directly via new
  `getList` client method instead of probing cards. Cross-board moves now
  work when the destination is empty.
- `batch_add_label` — real `TrelloError`s during label resolution are
  reported as "label lookup failed: {message}" instead of being collapsed
  to a spurious "label not found on board".
- `update_custom_field({displayCardFront})` — the `display/cardFront`
  param key is now sent with its literal slash instead of being
  `%2F`-encoded, which Trello was silently ignoring.

**Timezone (Cloudflare Workers run in UTC):**
- `list_cards_due({scope:"today"})` and `weekly_review_pack.due_today`
  now compute day boundaries in `Europe/Copenhagen` (new
  `DEFAULT_TIMEZONE` constant + `startOfDayMsInTz` helper).

**Response semantics:**
- `weekly_review_pack({board})` — throws `GuardError` for boards other
  than `dann-to-do`. The composite's list aliases resolve to that board
  only; calling it against `zoo` used to return all-zero buckets silently.
- `truncated` — false positive at exactly `MAX_RESULTS==200` items fixed
  in `list_cards`, `list_cards_by_list`, `list_archived_cards`,
  `list_my_cards_assigned`. Now compares pre-slice length.
- `list_notifications` — dropped the `.slice(0, MAX_RESULTS)` cap; the
  client already clamps to Trello's max of 1000, and the extra slice
  silently truncated `limit>200` requests.

**Comment / reaction guards:**
- `update_comment` / `delete_comment` — verify the `commentId`'s action
  belongs to the passed `cardId`. Previously a caller lying about
  `cardId` could touch a comment on a card whose list is FORBIDDEN.
- `add_comment_reaction` / `remove_comment_reaction` — gained optional
  `cardId`; either uses it as the verify check or derives the card from
  the action. Both now run `assertCardWritable`.
- `mark_all_notifications_read` — dropped the `filter` param. Trello's
  endpoint doesn't accept per-type filtering; the old code passed the
  type string as `ids=` (a Trello notification-ID list) and silently
  marked nothing. Type-filtered clearing must now be composed at the
  caller side via `list_notifications` + `mark_notification_read`.

**Client-layer HTTP:**
- `request()` retry — `Retry-After` header parsing now accepts RFC 7231
  HTTP-date format in addition to integer seconds. Previously HTTP-date
  values fell through to the 500 ms base delay.
- `batchGet` — non-numeric keys in Trello's response envelope (e.g.
  `{"error": "..."}`) now surface as `statusCode: 502` with the entry
  preserved, instead of `statusCode: NaN` that silently broke `>= 400`
  comparisons.

### Added
- `getList(listId)` client method — needed by `move_all_cards` fix; also
  exported for use by any future single-list read.
- `DEFAULT_TIMEZONE = "Europe/Copenhagen"` in `constants.ts`.

### Changed
- Tool signatures (breaking for anything hard-coding them):
  - `add_comment_reaction` and `remove_comment_reaction` now accept an
    optional `cardId` for verification.
  - `mark_all_notifications_read` no longer accepts `filter`.

## [1.8.0] — 2026-07-02

### Added
- **Custom Fields Power-Up (8 tools):** `list_custom_fields`, `create_custom_field`
  (checkbox / date / list / number / text), `update_custom_field`,
  `delete_custom_field`, `add_custom_field_option`, `delete_custom_field_option`,
  `list_card_custom_fields`, polymorphic `set_card_custom_field` accepting
  `{checked}` / `{date}` / `{number}` / `{text}` / `{listOptionId}` or `null`.
  Reverses the earlier "no Custom Fields" call.
- **Plugin / Power-Up management (4 tools):** `list_board_plugins`,
  `enable_board_plugin` (alias-aware: `custom-fields` / `card-aging` /
  `voting` / `calendar`), `disable_board_plugin` (takes the boardPlugin `id`
  from `list_board_plugins`, **not** the raw plugin id — Trello REST quirk),
  `get_plugin`.
- **Single-entity fetches (2 tools):** `get_label` (accepts ID or name +
  board), `get_attachment` (richer than `list_attachments` — `previews[]`,
  `edgeColor`, `pos`).
- **Actions & reactions (3 tools):** `list_comment_reactions_summary`
  (grouped counts), `get_action`, `get_action_display` (Trello's
  pre-rendered activity string).
- **Batch (1 tool):** `batch_get` — Trello `/batch`; up to 10 relative
  paths in one request; per-URL `{statusCode, body}`.
- **Archived reads (1 tool):** `list_archived_cards` — `/boards/{id}/cards/closed`
  with optional label + `staleDays` filters.
- New client types: `TrelloCustomField`, `TrelloCustomFieldOption`,
  `TrelloCustomFieldItem`, `TrelloReactionSummary`, `TrelloPlugin`,
  `TrelloBoardPlugin`.
- Client `request()` now supports JSON request bodies (required for the
  custom-field value setter).
- `PLUGIN_ALIASES` + `resolvePlugin` helper in `constants.ts`.

### Changed
- Tool surface: **77 → 96**.

## [1.7.1] — 2026-07-02

### Fixed
- `set_card_cover` no longer wipes the requested color. When only a color
  was supplied, the tool was coercing missing `attachmentId` to `null` and
  the client was writing `idAttachment: null` into the cover blob, which
  Trello treats as "clear the cover" and dropped the color too. Both the
  tool and client now strip `null` from the cover payload; only defined,
  non-null facets reach Trello.

## [1.7.0] — 2026-06-13

### Added
- **Voting (3 tools):** `vote_card`, `unvote_card`, `list_card_voters`.
- **Comment reactions (3 tools):** `add_comment_reaction` (Trello shortName
  like `"thumbsup"` / `"white_check_mark"`), `remove_comment_reaction`,
  `list_comment_reactions`.
- **Bulk hygiene (2 tools):** `copy_checklist` (via `idChecklistSource`),
  `mark_card_notifications_read` (`POST /cards/{id}/markAssociatedNotificationsRead`).
- **Inspection reads (4 tools):** `list_list_actions` (`/lists/{id}/actions`),
  `list_my_actions` (`/members/me/actions` cross-board),
  `list_board_memberships` (richer than `list_board_members` — adds
  `memberType` admin/normal/observer/virtual + confirmation state),
  `get_member` (any-member profile lookup).
- New client types: `TrelloReaction`, `TrelloMembership`.

### Changed
- Tool surface: **65 → 77**.

## [1.6.0] — 2026-06-13

### Added
- **List management (6 tools):** `create_list`, `rename_list`,
  `archive_list`, `move_list` (reposition + cross-board), `move_all_cards`
  (bulk; destination board derived from a probe), `archive_all_cards`.
- **Card cover (2 tools):** `set_card_cover` (palette color OR existing
  attachment; optional `size` + `brightness`), `clear_card_cover`.
- **Checklist item updates (3 tools):** `set_checklist_item_due`,
  `assign_checklist_item_member`, `reorder_checklist_item` — all via one
  new `updateChecklistItem` client method.
- **Label edit (1 tool):** `update_label` (rename + recolor).
- **Subscribe (2 tools):** `subscribe_card`, `subscribe_list`.
- **Notifications (3 tools):** `list_notifications` (filter + read-state +
  cursor pagination via `since`/`before`), `mark_notification_read`,
  `mark_all_notifications_read` (optional type filter).
- New client types: `TrelloNotification`, `TrelloCardCover`.
- `TrelloCard` gains `subscribed` + `cover`; `TrelloList` gains `pos` +
  `subscribed`.

### Changed
- Tool surface: **48 → 65**.

## [1.5.0] — 2026-06-13

### Added
- **Members (4 tools):** `list_board_members`, `list_card_members`,
  `add_member_to_card`, `remove_member_from_card` — `member` accepts ID /
  username / full name resolved on the card's board.
- **Named checklists (3 tools):** `create_checklist(name)`,
  `rename_checklist`, `delete_checklist`.
- **Card ops (2 tools):** `copy_card` (`idCardSource` + `keepFromSource`,
  with token validation), `set_due_reminder` (minutes-before-due, `null`
  clears).
- **Comment edits (2 tools):** `update_comment`, `delete_comment` via
  `PUT/DELETE /actions/{id}`.
- **Cross-board (1 tool):** `list_my_cards_assigned` via
  `/members/me/cards`.
- **Composite (1 tool):** `weekly_review_pack` — single call returning
  inbox sample + overdue + due-today + due-this-week + context-list counts
  + waiting-stale + could-do horizon counts + snoozed + big-rocks.
- New client type: `TrelloMember`. `TrelloCard` gains `idMembers`.
- `CardSummary` + `CardDetail` gain `memberIds`.

### Changed
- Tool surface: **35 → 48**.
- `updateCard` learns `dueReminder`.

## [1.4.1] — 2026-06-13

### Added
- `delete_label` — board-wide destructive delete via `DELETE /labels/{id}`.
  Accepts label ID or name (resolved against the named board).

### Changed
- Tool surface: **34 → 35**.

## [1.4.0] — 2026-06-13

### Added
- **Reads (7 tools):** `list_cards_due` (`today` / `overdue` /
  `next_seven_days`; decorated with `snoozed` + `wakeUp`),
  `list_cards_by_list` (per-list with `excludeDueDates` /
  `includeSnoozedOnly` / `staleDays`), `search_cards_advanced` (Trello
  operators + multi-board), `read_comments` (chronological),
  `list_labels`, `card_activity_log` (curated filter set), `snooze_read`
  (cards with `dueReminder`, sorted by computed wake-up).
- **Writes (7 tools):** `set_card_position` (top / bottom / numeric),
  `set_start_date`, `create_label` (palette-validated),
  `remove_checklist_item`, `convert_checklist_item_to_card` (native Trello
  endpoint; optional `targetList`), `batch_add_label` (≤50 cards,
  per-card skip reasons), `batch_move_cards` (≤50 cards, guards + WIP).
- `TrelloCard` gains `start` + `dueReminder`. New types: `TrelloAction`,
  `TrelloComment`.

### Notes
- **Snooze semantics.** Trello has no native snooze in its REST API. The
  `snooze_read` tool surfaces `dueReminder` (a reminder OFFSET, minutes
  before due) under the GTD vocabulary. `wakeUp = due - dueReminder min`.

### Changed
- Tool surface: **20 → 34**.

## [1.3.0] — 2026-06-12

### Added
- `add_file_attachment` — real file uploads via base64 → multipart. Hard
  cap 10 MB decoded. Client `addFileAttachment` builds `FormData` with a
  `Blob` and posts to `/cards/{id}/attachments` with the standard `file`
  field. Auth stays on the query string. `data:...;base64,` prefix is
  tolerated.

### Changed
- Tool surface: **19 → 20**.

## [1.2.0] — 2026-06-12

### Added
- **Checklist state (1 tool):** `set_checklist_item_state` — tick / untick
  a single checklist item.
- **URL attachments (3 tools):** `list_attachments`, `add_attachment`
  (URL-only), `remove_attachment`.

### Changed
- Tool surface: **15 → 19**.

## [1.1.0] — 2026-06-12

### Fixed
- `list_cards` and `search_cards` responses now include `desc` (regression
  vs the retired local Python MCP). `CardDetail` no longer duplicates the
  field.

## [1.0.0] — 2026-06-12

### Added
- Initial Cloudflare Workers MCP server with GitHub OAuth (allowlist:
  `dannbleeker`).
- 15 generic Trello tools covering board / list / card reads and card
  writes (create, move, update, archive, label add/remove, comment,
  checklist add, due-complete, checklist item listing).
- Friendly aliases for boards (`dann-to-do`, `zoo`) and 18 lists.
- Server-side guards: FORBIDDEN_LISTS (Butler, Repeater Cards),
  READ_ONLY_LISTS (Rolling Big Rocks), WIP-limit warnings.

[1.11.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/dannbleeker/trello-mcp/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/dannbleeker/trello-mcp/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dannbleeker/trello-mcp/releases/tag/v1.0.0
