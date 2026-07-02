# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
