# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
