/**
 * File: src/register-tools.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: All MCP tool registrations, extracted verbatim from src/index.ts
 *              (which had grown to ~1,400 lines). registerTrelloTools() is called
 *              once from TrelloMCP.init(); the allowlist guard, result/error
 *              formatting, and every tool registration live here. Behavior is
 *              byte-identical to the pre-split code — only the file moved.
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Extracted from src/index.ts (v1.16.0 housekeeping).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ALLOWED_LOGINS } from "./allowlist";
import { noteManualSend, sendDigestEmail } from "./digest/scheduler";
import { TrelloClient, TrelloError } from "./trello/client";
import { GuardError } from "./trello/guards";
import {
	add_attachment,
	add_checklist_item,
	add_comment,
	add_comment_reaction,
	add_custom_field_option,
	add_file_attachment,
	add_label,
	add_member_to_card,
	archive_all_cards,
	archive_card,
	archive_list,
	assign_checklist_item_member,
	batch_add_label,
	batch_get,
	batch_move_cards,
	batch_set_card_custom_field,
	card_activity_log,
	clear_card_cover,
	convert_checklist_item_to_card,
	copy_card,
	copy_checklist,
	create_card,
	create_checklist,
	create_custom_field,
	create_label,
	create_list,
	delete_checklist,
	delete_comment,
	delete_custom_field,
	delete_custom_field_option,
	delete_label,
	disable_board_plugin,
	enable_board_plugin,
	get_action,
	get_action_display,
	get_attachment,
	get_card,
	get_label,
	get_member,
	get_plugin,
	list_archived_cards,
	list_attachments,
	list_board_members,
	list_board_memberships,
	list_board_plugins,
	list_boards,
	list_card_custom_fields,
	list_card_members,
	list_card_voters,
	list_cards,
	list_cards_by_list,
	list_cards_due,
	list_checklist_items,
	list_comment_reactions,
	list_comment_reactions_summary,
	list_custom_fields,
	list_labels,
	list_list_actions,
	list_lists,
	list_my_actions,
	list_my_cards_assigned,
	list_notifications,
	list_snoozed_cards,
	mark_all_notifications_read,
	mark_card_notifications_read,
	mark_notification_read,
	move_all_cards,
	move_card,
	move_list,
	read_comments,
	remove_attachment,
	remove_checklist_item,
	remove_comment_reaction,
	remove_label,
	remove_member_from_card,
	rename_checklist,
	rename_custom_field_option,
	rename_list,
	reorder_checklist_item,
	search_cards,
	search_cards_advanced,
	set_card_cover,
	set_card_custom_field,
	set_card_position,
	set_checklist_item_due,
	set_checklist_item_state,
	set_due_complete,
	set_due_reminder,
	set_start_date,
	snooze_read,
	subscribe_card,
	subscribe_list,
	unvote_card,
	update_card,
	wake_card,
	update_comment,
	update_custom_field,
	update_label,
	vote_card,
	weekly_review_pack,
} from "./trello/tools";
import type { CustomFieldValue } from "./trello/tools";

/**
 * Format a tool's result for an MCP response. Tools return JSON-safe objects;
 * MCP wants them as text content (JSON-stringified).
 */
function ok(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Turn an internal error into an MCP error response. GuardError messages are
 * surfaced verbatim (they were written for the caller). TrelloError gets a
 * cleaner shape. Anything else is a generic 500.
 */
function err(e: unknown) {
	if (e instanceof GuardError) {
		return { content: [{ type: "text" as const, text: `Guard refused: ${e.message}` }], isError: true };
	}
	if (e instanceof TrelloError) {
		return { content: [{ type: "text" as const, text: `Trello ${e.status}: ${e.body.slice(0, 300)}` }], isError: true };
	}
	const msg = e instanceof Error ? e.message : String(e);
	return { content: [{ type: "text" as const, text: `Internal error: ${msg}` }], isError: true };
}

/**
 * Every custom-field tool takes a field by ID *or* by name, matching how
 * boards / lists / plugins already resolve. Names are looked up on the `board`
 * param (default board when omitted); set_card_custom_field infers the board
 * from the card instead. v1.17.0.
 */
const CUSTOM_FIELD_REF = z
	.string()
	.min(1)
	.describe("Custom-field ID, or its name (case-insensitive) — see list_custom_fields.");

/**
 * A typed custom-field value. `.strict()` so a two-key value ({ text, number })
 * is rejected outright — non-strict objects silently drop the extra key and
 * write the wrong one. Shared by set_card_custom_field,
 * batch_set_card_custom_field and create_card's `customFields`.
 */
const CUSTOM_FIELD_VALUE = z
	.union([
		z.object({ checked: z.boolean() }).strict(),
		z.object({ date: z.string() }).strict(),
		z.object({ number: z.number() }).strict(),
		z.object({ text: z.string() }).strict(),
		z.object({ listOptionId: z.string() }).strict(),
		z.null(),
	])
	.describe("Typed value; null clears the field.");

/** Trello's fixed option palette. An enum fails here instead of at Trello. */
const CUSTOM_FIELD_COLORS = z.enum([
	"green",
	"yellow",
	"orange",
	"red",
	"purple",
	"blue",
	"sky",
	"lime",
	"pink",
	"black",
]);

/** Wrap a tool handler with auth check + uniform error mapping. */
function guarded<TIn>(
	login: string,
	fn: (input: TIn) => Promise<unknown>,
) {
	return async (input: TIn) => {
		if (!ALLOWED_LOGINS.has(login)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Access denied. GitHub user "${login}" is not on this connector's allowlist.`,
					},
				],
				isError: true,
			};
		}
		try {
			return ok(await fn(input));
		} catch (e) {
			return err(e);
		}
	};
}


/** Register every Trello tool on the server. Called once per DO init. */
export function registerTrelloTools(server: McpServer, login: string, client: TrelloClient, env: Env): void {

	// ---- READS ----

	server.tool(
		"list_boards",
		"List all open Trello boards the authenticated user belongs to. Returns id, alias (if known), name, url.",
		{},
		guarded(login, async () => list_boards(client)),
	);

	server.tool(
		"list_lists",
		"List the lists on a board. `board` accepts an alias (e.g. \"dann-to-do\", \"zoo\") or a raw board ID. Defaults to dann-to-do.",
		{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_lists(client, i)),
	);

	server.tool(
		"list_cards",
		"List cards on a list (if `list` is given) or on a board. Optional filters: `label` (by name), `staleDays` (only cards untouched for N+ days). `list`/`board` accept aliases or raw IDs.",
		{
			list: z.string().optional().describe("List alias (e.g. \"inbox\", \"@computer\") or ID."),
			board: z.string().optional().describe("Board alias or ID. Used only if `list` is omitted. Default: dann-to-do."),
			label: z.string().optional().describe("Filter to cards carrying this label name."),
			staleDays: z.number().int().positive().optional().describe("Filter to cards untouched for at least this many days."),
			customFields: z
				.boolean()
				.optional()
				.describe("Attach each card's custom-field values, named and typed. Default false."),
		},
		guarded(login, async (i: { list?: string; board?: string; label?: string; staleDays?: number; customFields?: boolean }) =>
			list_cards(client, i),
		),
	);

	server.tool(
		"get_card",
		"Get full details (including description) for one card by its 24-char Trello ID. Pass customFields: true to include the card's custom-field values, named and typed.",
		{
			cardId: z.string().describe("Trello card ID."),
			customFields: z
				.boolean()
				.optional()
				.describe("Include custom-field values (one extra API call). Default false."),
		},
		guarded(login, async (i: { cardId: string; customFields?: boolean }) => get_card(client, i)),
	);

	server.tool(
		"search_cards",
		"Fuzzy search cards by name. Scoped to one board if `board` is given, otherwise searches all boards the user belongs to.",
		{
			query: z.string().min(1).describe("Search text. Trello matches loosely on card name."),
			board: z.string().optional().describe("Board alias or ID to scope the search."),
			customFields: z
				.boolean()
				.optional()
				.describe("Attach each card's custom-field values, named and typed. Default false."),
		},
		guarded(login, async (i: { query: string; board?: string; customFields?: boolean }) => search_cards(client, i)),
	);

	server.tool(
		"list_checklist_items",
		"List the checklists and their items on a card.",
		{ cardId: z.string().describe("Trello card ID.") },
		guarded(login, async (i: { cardId: string }) => list_checklist_items(client, i)),
	);

	// ---- WRITES ----

	server.tool(
		"create_card",
		"Create a new card on a list. Refused if the list is Butler / Repeater Cards / Rolling Big Rocks. Emits a WIP-limit warning if the list name contains \"(WIP limit N)\" and the post-create count exceeds N.",
		{
			list: z.string().describe("Destination list alias or ID."),
			name: z.string().min(1).describe("Card title."),
			desc: z.string().optional().describe("Card description (Markdown supported by Trello)."),
			due: z.string().optional().describe("Due date in ISO 8601 (e.g. 2026-06-30T15:00:00Z)."),
			labels: z.array(z.string()).optional().describe("Label IDs to attach at creation."),
			customFields: z
				.array(
					z.object({
						field: CUSTOM_FIELD_REF,
						value: CUSTOM_FIELD_VALUE,
					}),
				)
				.optional()
				.describe(
					"Custom-field values to set after creation. Trello cannot set these on the create call itself, so they are applied as follow-ups and reported per field — the card is still created if one fails.",
				),
		},
		guarded(
			login,
			async (i: {
				list: string;
				name: string;
				desc?: string;
				due?: string;
				labels?: string[];
				customFields?: { field: string; value: CustomFieldValue }[];
			}) => create_card(client, i),
		),
	);

	server.tool(
		"move_card",
		"Move a card to a different list. Refused if source OR destination is Butler / Repeater Cards / Rolling Big Rocks. WIP warning emitted but not blocking.",
		{
			cardId: z.string().describe("Card to move."),
			list: z.string().describe("Destination list alias or ID."),
		},
		guarded(login, async (i: { cardId: string; list: string }) => move_card(client, i)),
	);

	server.tool(
		"update_card",
		"Edit a card's name, description, or due date. Pass `null` for `due` to clear the due date. Refused on Butler / Repeater Cards.",
		{
			cardId: z.string().describe("Card to update."),
			name: z.string().optional(),
			desc: z.string().optional(),
			due: z.union([z.string(), z.null()]).optional().describe("ISO 8601 due date, or null to clear."),
		},
		guarded(login, async (i: { cardId: string; name?: string; desc?: string; due?: string | null }) =>
			update_card(client, i),
		),
	);

	server.tool(
		"archive_card",
		"Archive a card (Trello's `closed=true`). Soft delete only — cards can be restored via the Trello UI. There is no hard-delete tool.",
		{ cardId: z.string().describe("Card to archive.") },
		guarded(login, async (i: { cardId: string }) => archive_card(client, i)),
	);

	server.tool(
		"set_due_complete",
		"Mark a card's due date as complete (or incomplete). Triggers Butler automations that move done cards to the Done-do list.",
		{
			cardId: z.string(),
			complete: z.boolean().describe("true = mark done, false = unmark."),
		},
		guarded(login, async (i: { cardId: string; complete: boolean }) => set_due_complete(client, i)),
	);

	server.tool(
		"add_label",
		"Add a label to a card. `label` accepts either the Trello label ID or the label name (case-insensitive, scoped to the card's board).",
		{
			cardId: z.string(),
			label: z.string().describe("Label ID or name."),
		},
		guarded(login, async (i: { cardId: string; label: string }) => add_label(client, i)),
	);

	server.tool(
		"remove_label",
		"Remove a label from a card. `label` accepts ID or name.",
		{
			cardId: z.string(),
			label: z.string().describe("Label ID or name."),
		},
		guarded(login, async (i: { cardId: string; label: string }) => remove_label(client, i)),
	);

	server.tool(
		"add_comment",
		"Append a comment to a card. Comments are useful for triage notes and decision logs during weekly review.",
		{
			cardId: z.string(),
			text: z.string().min(1).describe("Comment body (Markdown supported by Trello)."),
		},
		guarded(login, async (i: { cardId: string; text: string }) => add_comment(client, i)),
	);

	server.tool(
		"add_checklist_item",
		"Append an item to the card's checklist. Creates a checklist named \"Checklist\" if the card doesn't have one yet.",
		{
			cardId: z.string(),
			text: z.string().min(1).describe("Item text."),
		},
		guarded(login, async (i: { cardId: string; text: string }) => add_checklist_item(client, i)),
	);

	server.tool(
		"set_checklist_item_state",
		"Tick or untick a single checklist item. Use list_checklist_items first to find the itemId.",
		{
			cardId: z.string(),
			itemId: z.string().describe("Checklist item ID from list_checklist_items."),
			complete: z.boolean().describe("true = tick, false = untick."),
		},
		guarded(login, async (i: { cardId: string; itemId: string; complete: boolean }) =>
			set_checklist_item_state(client, i),
		),
	);

	server.tool(
		"list_attachments",
		"List attachments on a card. Returns id, name, url, date, mimeType.",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => list_attachments(client, i)),
	);

	server.tool(
		"add_attachment",
		"Attach a URL to a card. For real file uploads, use add_file_attachment instead.",
		{
			cardId: z.string(),
			url: z.string().url().describe("URL to attach."),
			name: z.string().optional().describe("Friendly name for the attachment (defaults to the URL)."),
		},
		guarded(login, async (i: { cardId: string; url: string; name?: string }) =>
			add_attachment(client, i),
		),
	);

	server.tool(
		"add_file_attachment",
		"Upload an actual file (not a URL) as a card attachment. Pass the file as base64 in `contentBase64`; the server decodes it and posts multipart to Trello. Hard cap 10 MB after decoding. For larger files, host them somewhere and use add_attachment with the URL.",
		{
			cardId: z.string(),
			filename: z.string().min(1).describe("File name as it should appear on the card, including extension (e.g. \"weekly-review.md\")."),
			mimeType: z.string().optional().describe("MIME type (e.g. \"text/markdown\", \"application/pdf\"). Defaults to application/octet-stream."),
			contentBase64: z.string().min(1).describe("File contents, base64-encoded. `data:...;base64,` prefix is tolerated."),
		},
		guarded(login, async (i: { cardId: string; filename: string; mimeType?: string; contentBase64: string }) =>
			add_file_attachment(client, i),
		),
	);

	server.tool(
		"remove_attachment",
		"Remove an attachment from a card. Use list_attachments first to find the attachmentId.",
		{
			cardId: z.string(),
			attachmentId: z.string().describe("Attachment ID from list_attachments."),
		},
		guarded(login, async (i: { cardId: string; attachmentId: string }) =>
			remove_attachment(client, i),
		),
	);

	// ============================================================
	// v1.4.0 — reflect / engage tools
	// ============================================================

	server.tool(
		"list_cards_due",
		"List cards filtered by a due-date scope. `scope` is one of \"today\", \"overdue\", \"next_seven_days\". Optionally narrow to one list and/or label. Each card includes `snoozed` and `wakeUp` (computed from due - dueReminder).",
		{
			scope: z.enum(["today", "overdue", "next_seven_days"]).describe("Due-date filter."),
			list: z.string().optional().describe("List alias or ID. Narrows scope to one list."),
			label: z.string().optional().describe("Filter to this label name (case-insensitive)."),
			board: z.string().optional().describe("Board alias or ID. Defaults to dann-to-do."),
		},
		guarded(login, async (i: { scope: "today" | "overdue" | "next_seven_days"; list?: string; label?: string; board?: string }) =>
			list_cards_due(client, i),
		),
	);

	server.tool(
		"list_cards_by_list",
		"Read every card on one list with extra filters not exposed by list_cards: `excludeDueDates` keeps only cards without a due, `includeSnoozedOnly` keeps only cards whose dueReminder is set, `label` filters by label name, `staleDays` keeps cards untouched for N+ days.",
		{
			list: z.string().describe("List alias or ID."),
			excludeDueDates: z.boolean().optional(),
			includeSnoozedOnly: z.boolean().optional(),
			label: z.string().optional(),
			staleDays: z.number().int().positive().optional(),
			customFields: z
				.boolean()
				.optional()
				.describe("Attach each card's custom-field values, named and typed. Default false."),
		},
		guarded(login, async (i: { list: string; excludeDueDates?: boolean; includeSnoozedOnly?: boolean; label?: string; staleDays?: number; customFields?: boolean }) =>
			list_cards_by_list(client, i),
		),
	);

	server.tool(
		"search_cards_advanced",
		"Trello /search with operator support inside the query string: `due:day`, `due:overdue`, `due:week`, `label:red`, `list:\"Inbox\"`, `has:attachments`, `description:\"foo\"`, `is:archived`. Multi-board scope via `boards`; tunable `limit` up to 1000.",
		{
			query: z.string().min(1).describe("Search expression. Trello operators supported."),
			boards: z.array(z.string()).optional().describe("Board aliases or IDs to scope the search."),
			limit: z.number().int().min(1).max(1000).optional().describe("Max cards to return (default 50, hard cap 1000)."),
			customFields: z
				.boolean()
				.optional()
				.describe("Attach each result's custom-field values. NOTE: this annotates results — Trello's search syntax has no operator for custom fields, so you cannot FILTER on them here."),
		},
		guarded(login, async (i: { query: string; boards?: string[]; limit?: number; customFields?: boolean }) =>
			search_cards_advanced(client, i),
		),
	);

	server.tool(
		"read_comments",
		"Chronological comment thread on a card. Each comment has text, author, timestamp.",
		{
			cardId: z.string(),
			limit: z.number().int().min(1).max(1000).optional().describe("Max comments to return (default 50)."),
		},
		guarded(login, async (i: { cardId: string; limit?: number }) => read_comments(client, i)),
	);

	server.tool(
		"list_labels",
		"All labels defined on a board (id, name, color).",
		{ board: z.string().optional().describe("Board alias or ID. Defaults to dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_labels(client, i)),
	);

	server.tool(
		"create_label",
		"Create a new label on a board. Color must be one of yellow/purple/blue/red/green/orange/black/sky/pink/lime, or null for no color.",
		{
			board: z.string().optional().describe("Board alias or ID. Defaults to dann-to-do."),
			name: z.string().min(1).describe("Label name."),
			color: z.union([z.string(), z.null()]).optional().describe("Trello palette token, or null for none."),
		},
		guarded(login, async (i: { board?: string; name: string; color?: string | null }) =>
			create_label(client, i),
		),
	);

	server.tool(
		"delete_label",
		"Delete a label board-wide. Destructive: every card that carries this label loses it. `label` accepts the label ID or name; `board` defaults to dann-to-do.",
		{
			board: z.string().optional().describe("Board alias or ID. Defaults to dann-to-do."),
			label: z.string().describe("Label ID or name."),
		},
		guarded(login, async (i: { board?: string; label: string }) =>
			delete_label(client, i),
		),
	);

	server.tool(
		"remove_checklist_item",
		"Delete a single item from a checklist. Use list_checklist_items to find the checklistId + itemId.",
		{
			cardId: z.string(),
			checklistId: z.string(),
			itemId: z.string(),
		},
		guarded(login, async (i: { cardId: string; checklistId: string; itemId: string }) =>
			remove_checklist_item(client, i),
		),
	);

	server.tool(
		"convert_checklist_item_to_card",
		"Promote a checklist item into its own card. Trello creates the new card on the SAME list as the source; pass `targetList` to move it afterwards. The item is auto-removed from the source checklist.",
		{
			cardId: z.string(),
			checklistId: z.string(),
			itemId: z.string(),
			targetList: z.string().optional().describe("List alias or ID to move the new card to. Optional."),
		},
		guarded(login, async (i: { cardId: string; checklistId: string; itemId: string; targetList?: string }) =>
			convert_checklist_item_to_card(client, i),
		),
	);

	server.tool(
		"set_card_position",
		"Set a card's position within its list. `position` is \"top\", \"bottom\", or a non-negative numeric position.",
		{
			cardId: z.string(),
			position: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]),
		},
		guarded(login, async (i: { cardId: string; position: "top" | "bottom" | number }) =>
			set_card_position(client, i),
		),
	);

	server.tool(
		"set_start_date",
		"Set or clear a card's start date. Pass an ISO 8601 string to set; pass null to clear.",
		{
			cardId: z.string(),
			start: z.union([z.string(), z.null()]).describe("ISO 8601 string or null to clear."),
		},
		guarded(login, async (i: { cardId: string; start: string | null }) =>
			set_start_date(client, i),
		),
	);

	server.tool(
		"snooze_read",
		"Cards whose `dueReminder` is set (non-null and not -1), sorted by computed wake-up time. NOTE: `dueReminder` is the minutes-before-due reminder offset, not a hide field — for actual Snooze Power-Up state (hidden cards with wake times) use list_snoozed_cards instead. Scope to one list or one board.",
		{
			list: z.string().optional().describe("List alias or ID. If given, board is ignored."),
			board: z.string().optional().describe("Board alias or ID. Defaults to dann-to-do."),
			label: z.string().optional().describe("Filter to this label name."),
		},
		guarded(login, async (i: { list?: string; board?: string; label?: string }) =>
			snooze_read(client, i),
		),
	);

	server.tool(
		"batch_add_label",
		"Add the same label to up to 50 cards in one call. Skipped cards are reported with a reason (label not on board, forbidden list, etc.) but the call still completes.",
		{
			cardIds: z.array(z.string()).min(1).max(50),
			label: z.string().describe("Label name or ID."),
		},
		guarded(login, async (i: { cardIds: string[]; label: string }) =>
			batch_add_label(client, i),
		),
	);

	server.tool(
		"batch_move_cards",
		"Move up to 50 cards to the same destination list. Guards both source (per card) and destination. Skipped cards are reported but the call still completes. WIP warning included if applicable.",
		{
			cardIds: z.array(z.string()).min(1).max(50),
			targetList: z.string().describe("Destination list alias or ID."),
		},
		guarded(login, async (i: { cardIds: string[]; targetList: string }) =>
			batch_move_cards(client, i),
		),
	);

	server.tool(
		"card_activity_log",
		"Recent actions on a card (moves, due-date changes, label/attachment/comment activity, checklist edits). Defaults to a useful filter set; pass `filter=\"all\"` to widen it. Sorted newest-first.",
		{
			cardId: z.string(),
			filter: z.string().optional().describe("Trello action-type filter (comma-separated). Default: a curated activity set."),
			limit: z.number().int().min(1).max(1000).optional().describe("Max actions to return (default 50, hard cap 1000)."),
		},
		guarded(login, async (i: { cardId: string; filter?: string; limit?: number }) =>
			card_activity_log(client, i),
		),
	);

	// ============================================================
	// v1.5.0 — members, named checklists, copy/reminder, comment edits,
	// cross-board assignments, weekly review composite
	// ============================================================

	server.tool(
		"list_board_members",
		"All members with access to a board (id, fullName, username, initials).",
		{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_board_members(client, i)),
	);

	server.tool(
		"list_card_members",
		"Members assigned to a single card.",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => list_card_members(client, i)),
	);

	server.tool(
		"add_member_to_card",
		"Assign a member to a card. `member` accepts the Trello member ID, username, or full name (resolved against the card's board).",
		{
			cardId: z.string(),
			member: z.string().describe("Member ID, username, or full name."),
		},
		guarded(login, async (i: { cardId: string; member: string }) => add_member_to_card(client, i)),
	);

	server.tool(
		"remove_member_from_card",
		"Unassign a member from a card. `member` accepts ID, username, or full name.",
		{
			cardId: z.string(),
			member: z.string().describe("Member ID, username, or full name."),
		},
		guarded(login, async (i: { cardId: string; member: string }) => remove_member_from_card(client, i)),
	);

	server.tool(
		"list_my_cards_assigned",
		"All open cards assigned to the authenticated user across every accessible board. Optional `board` filter narrows to a single board.",
		{ board: z.string().optional().describe("Optional board alias or ID to narrow scope.") },
		guarded(login, async (i: { board?: string }) => list_my_cards_assigned(client, i)),
	);

	server.tool(
		"create_checklist",
		"Create a new checklist on a card with an explicit name (e.g. \"Agenda\", \"Decisions\"). Use add_checklist_item to populate it.",
		{
			cardId: z.string(),
			name: z.string().min(1).describe("Checklist name."),
		},
		guarded(login, async (i: { cardId: string; name: string }) => create_checklist(client, i)),
	);

	server.tool(
		"rename_checklist",
		"Change a checklist's name.",
		{
			cardId: z.string(),
			checklistId: z.string(),
			name: z.string().min(1).describe("New checklist name."),
		},
		guarded(login, async (i: { cardId: string; checklistId: string; name: string }) =>
			rename_checklist(client, i),
		),
	);

	server.tool(
		"delete_checklist",
		"Delete a checklist outright (removes all its items). Use list_checklist_items to find the checklistId.",
		{
			cardId: z.string(),
			checklistId: z.string(),
		},
		guarded(login, async (i: { cardId: string; checklistId: string }) =>
			delete_checklist(client, i),
		),
	);

	server.tool(
		"copy_card",
		"Duplicate a card to a target list. `keepFromSource` controls what to copy: comma-separated subset of attachments,checklists,comments,customFields,due,start,labels,members,stickers, or \"all\" (default). Name `customFields` EXPLICITLY if you want custom-field values carried over — Trello does not reliably include them under \"all\". Optional `newName` overrides the source name; `position` is top/bottom/numeric.",
		{
			cardId: z.string().describe("Source card to copy."),
			targetList: z.string().describe("Destination list alias or ID."),
			newName: z.string().min(1).optional(),
			keepFromSource: z.string().optional().describe("e.g. \"all\", \"all,customFields\", or \"checklists,labels,customFields\"."),
			position: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
		},
		guarded(login, async (i: { cardId: string; targetList: string; newName?: string; keepFromSource?: string; position?: "top" | "bottom" | number }) =>
			copy_card(client, i),
		),
	);

	server.tool(
		"set_due_reminder",
		"Set the minutes-before-due reminder offset on a card. 0 = at due time, 60 = 1h before, 1440 = 1d before. Pass null to clear (becomes -1 / no reminder). This writes Trello's reminder offset field, not a snooze/hide field.",
		{
			cardId: z.string(),
			minutesBeforeDue: z.union([z.number().int().nonnegative(), z.null()])
				.describe("Non-negative integer minutes, or null to clear."),
		},
		guarded(login, async (i: { cardId: string; minutesBeforeDue: number | null }) =>
			set_due_reminder(client, i),
		),
	);

	server.tool(
		"update_comment",
		"Edit an existing comment. `commentId` is the action ID returned by read_comments.",
		{
			cardId: z.string(),
			commentId: z.string().describe("Action ID from read_comments."),
			text: z.string().min(1).describe("New comment body (Markdown supported)."),
		},
		guarded(login, async (i: { cardId: string; commentId: string; text: string }) =>
			update_comment(client, i),
		),
	);

	server.tool(
		"delete_comment",
		"Delete an existing comment by its action ID (from read_comments).",
		{
			cardId: z.string(),
			commentId: z.string().describe("Action ID from read_comments."),
		},
		guarded(login, async (i: { cardId: string; commentId: string }) =>
			delete_comment(client, i),
		),
	);

	server.tool(
		"weekly_review_pack",
		"One-call GTD weekly-review snapshot: inbox sample, overdue, due-today, due-this-week, context-list counts (@computer/@home/@phone/@errands/@lene), waiting-list stale items, could-do horizon counts, snoozed count, big-rocks count. Defaults to dann-to-do.",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			staleDays: z.number().int().positive().optional().describe("Waiting-list stale threshold. Default 7."),
			maxPerBucket: z.number().int().positive().max(200).optional().describe("Max cards returned per bucket. Default 25."),
			customFields: z
				.boolean()
				.optional()
				.describe("Attach each card's custom-field values, named and typed. Default false."),
		},
		guarded(login, async (i: { board?: string; staleDays?: number; maxPerBucket?: number; customFields?: boolean }) =>
			weekly_review_pack(client, i),
		),
	);

	// ============================================================
	// v1.6.0 — list mgmt, cover, checklist-item updates, label edit,
	// subscribe, notifications
	// ============================================================

	server.tool(
		"create_list",
		"Create a new list on a board. Position is \"top\", \"bottom\", or a non-negative number.",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			name: z.string().min(1),
			position: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
		},
		guarded(login, async (i: { board?: string; name: string; position?: "top" | "bottom" | number }) =>
			create_list(client, i),
		),
	);

	server.tool(
		"rename_list",
		"Change a list's name.",
		{
			list: z.string().describe("List alias or ID."),
			name: z.string().min(1),
		},
		guarded(login, async (i: { list: string; name: string }) => rename_list(client, i)),
	);

	server.tool(
		"archive_list",
		"Archive (default) or reopen a list. Pass `closed=false` to unarchive.",
		{
			list: z.string().describe("List alias or ID."),
			closed: z.boolean().optional().describe("true (default) = archive, false = reopen."),
		},
		guarded(login, async (i: { list: string; closed?: boolean }) => archive_list(client, i)),
	);

	server.tool(
		"move_list",
		"Reposition a list (`position`) and/or move it to another board (`targetBoard`). At least one is required.",
		{
			list: z.string().describe("List alias or ID."),
			position: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
			targetBoard: z.string().optional().describe("Board alias or ID to move the list (and its cards) to."),
		},
		guarded(login, async (i: { list: string; position?: "top" | "bottom" | number; targetBoard?: string }) =>
			move_list(client, i),
		),
	);

	server.tool(
		"move_all_cards",
		"Bulk-move every card from one list to another. Guards source AND destination.",
		{
			sourceList: z.string().describe("List alias or ID to drain."),
			targetList: z.string().describe("List alias or ID to receive."),
		},
		guarded(login, async (i: { sourceList: string; targetList: string }) =>
			move_all_cards(client, i),
		),
	);

	server.tool(
		"archive_all_cards",
		"Bulk-archive every open card on a list.",
		{ list: z.string().describe("List alias or ID.") },
		guarded(login, async (i: { list: string }) => archive_all_cards(client, i)),
	);

	server.tool(
		"set_card_cover",
		"Set a card cover by palette color OR an attachment already on the card. Colors: pink/yellow/lime/blue/black/orange/red/purple/sky/green. Size: normal/full. Brightness: light/dark (color covers only). To remove, use clear_card_cover.",
		{
			cardId: z.string(),
			color: z.string().optional().describe("Trello cover palette color."),
			attachmentId: z.string().optional().describe("Attachment id (from list_attachments) to use as cover."),
			size: z.enum(["normal", "full"]).optional(),
			brightness: z.enum(["light", "dark"]).optional(),
		},
		guarded(login, async (i: { cardId: string; color?: string; attachmentId?: string; size?: "normal" | "full"; brightness?: "light" | "dark" }) =>
			set_card_cover(client, i),
		),
	);

	server.tool(
		"clear_card_cover",
		"Remove the cover from a card.",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => clear_card_cover(client, i)),
	);

	server.tool(
		"set_checklist_item_due",
		"Set or clear a due date on a single checklist item. Pass an ISO 8601 string to set, or null to clear.",
		{
			cardId: z.string(),
			itemId: z.string().describe("Checklist item ID from list_checklist_items."),
			due: z.union([z.string(), z.null()]),
		},
		guarded(login, async (i: { cardId: string; itemId: string; due: string | null }) =>
			set_checklist_item_due(client, i),
		),
	);

	server.tool(
		"assign_checklist_item_member",
		"Assign or unassign a member on a single checklist item. `member` accepts ID, username, or full name; pass null to clear.",
		{
			cardId: z.string(),
			itemId: z.string().describe("Checklist item ID from list_checklist_items."),
			member: z.union([z.string(), z.null()]).describe("Member ID/username/full name, or null."),
		},
		guarded(login, async (i: { cardId: string; itemId: string; member: string | null }) =>
			assign_checklist_item_member(client, i),
		),
	);

	server.tool(
		"reorder_checklist_item",
		"Move a checklist item within its checklist. Position is \"top\", \"bottom\", or a non-negative number.",
		{
			cardId: z.string(),
			itemId: z.string().describe("Checklist item ID from list_checklist_items."),
			position: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]),
		},
		guarded(login, async (i: { cardId: string; itemId: string; position: "top" | "bottom" | number }) =>
			reorder_checklist_item(client, i),
		),
	);

	server.tool(
		"update_label",
		"Rename and/or recolor a label. `label` accepts ID or name (resolved on the board); at least one of name/color must be passed. Color: palette token or null to clear.",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			label: z.string().describe("Label ID or name."),
			name: z.string().min(1).optional(),
			color: z.union([z.string(), z.null()]).optional(),
		},
		guarded(login, async (i: { board?: string; label: string; name?: string; color?: string | null }) =>
			update_label(client, i),
		),
	);

	server.tool(
		"subscribe_card",
		"Watch (subscribe=true) or unwatch (false) a card. Controls whether activity on the card produces notifications for you.",
		{
			cardId: z.string(),
			subscribed: z.boolean(),
		},
		guarded(login, async (i: { cardId: string; subscribed: boolean }) =>
			subscribe_card(client, i),
		),
	);

	server.tool(
		"subscribe_list",
		"Watch (subscribe=true) or unwatch (false) a list. Activity on any card in the list will produce notifications for you.",
		{
			list: z.string().describe("List alias or ID."),
			subscribed: z.boolean(),
		},
		guarded(login, async (i: { list: string; subscribed: boolean }) =>
			subscribe_list(client, i),
		),
	);

	server.tool(
		"list_notifications",
		"The authenticated user's notification feed (the bell icon). Optional comma-separated `filter` of types (e.g. \"mentionedOnCard,cardDueSoon,addedToCard\", default \"all\"). `readFilter`: all/read/unread. `since`/`before` are notification IDs (cursor pagination), not dates.",
		{
			filter: z.string().optional(),
			readFilter: z.enum(["all", "read", "unread"]).optional(),
			limit: z.number().int().min(1).max(1000).optional(),
			since: z.string().optional(),
			before: z.string().optional(),
		},
		guarded(login, async (i: { filter?: string; readFilter?: "all" | "read" | "unread"; limit?: number; since?: string; before?: string }) =>
			list_notifications(client, i),
		),
	);

	server.tool(
		"mark_notification_read",
		"Flip a single notification's read flag. Default: marks it READ (unread=false).",
		{
			notificationId: z.string(),
			unread: z.boolean().optional().describe("true = mark unread, false (default) = mark read."),
		},
		guarded(login, async (i: { notificationId: string; unread?: boolean }) =>
			mark_notification_read(client, i),
		),
	);

	server.tool(
		"mark_all_notifications_read",
		"Bulk mark every unread notification as read. No per-type filter here — Trello's endpoint doesn't accept one. For type-filtered clearing, compose list_notifications({filter, readFilter:\"unread\"}) with per-item mark_notification_read.",
		{
			read: z.boolean().optional().describe("Default true (mark read). Pass false to bulk-unread, rarely useful."),
		},
		guarded(login, async (i: { read?: boolean }) =>
			mark_all_notifications_read(client, i),
		),
	);

	// ============================================================
	// v1.7.0 — votes, comment reactions, copy_checklist, bulk-clear
	// card notifications, broader activity reads, memberships, member lookup
	// ============================================================

	server.tool(
		"vote_card",
		"Cast a vote on a card as the authenticated user (the connector's GitHub-allowlisted identity).",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => vote_card(client, i)),
	);

	server.tool(
		"unvote_card",
		"Withdraw your vote from a card.",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => unvote_card(client, i)),
	);

	server.tool(
		"list_card_voters",
		"Members who have voted on a card (id, fullName, username, initials).",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => list_card_voters(client, i)),
	);

	server.tool(
		"add_comment_reaction",
		"Attach an emoji reaction to a comment. `commentId` is the action ID (from read_comments). `emoji` is a Trello shortName: \"thumbsup\", \"white_check_mark\", \"heart\", \"eyes\", \"raised_hands\", etc. Optional `cardId` verifies the comment belongs to that card; omitted, the tool derives it from the action.",
		{
			commentId: z.string().describe("Action ID from read_comments."),
			emoji: z.string().min(1).describe("Emoji shortName, e.g. \"thumbsup\"."),
			cardId: z.string().optional().describe("Card ID for a verification check; auto-derived from action if omitted."),
		},
		guarded(login, async (i: { commentId: string; emoji: string; cardId?: string }) =>
			add_comment_reaction(client, i),
		),
	);

	server.tool(
		"remove_comment_reaction",
		"Remove a reaction from a comment by its reaction ID (from list_comment_reactions). Optional `cardId` verifies the comment belongs to that card.",
		{
			commentId: z.string().describe("Action ID."),
			reactionId: z.string().describe("Reaction ID from list_comment_reactions."),
			cardId: z.string().optional().describe("Card ID for a verification check; auto-derived from action if omitted."),
		},
		guarded(login, async (i: { commentId: string; reactionId: string; cardId?: string }) =>
			remove_comment_reaction(client, i),
		),
	);

	server.tool(
		"list_comment_reactions",
		"All emoji reactions on a comment.",
		{ commentId: z.string().describe("Action ID from read_comments.") },
		guarded(login, async (i: { commentId: string }) => list_comment_reactions(client, i)),
	);

	server.tool(
		"copy_checklist",
		"Duplicate an entire checklist (with items) onto another card. Use for meeting-prep templates etc. `newName` overrides the source name; `position` is top/bottom/numeric.",
		{
			sourceChecklistId: z.string().describe("Checklist to copy FROM (from list_checklist_items)."),
			targetCardId: z.string().describe("Card to copy the checklist TO."),
			newName: z.string().min(1).optional(),
			position: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
		},
		guarded(login, async (i: { sourceChecklistId: string; targetCardId: string; newName?: string; position?: "top" | "bottom" | number }) =>
			copy_checklist(client, i),
		),
	);

	server.tool(
		"mark_card_notifications_read",
		"Clear every notification associated with one card in a single call. Faster than iterating mark_notification_read after processing a card.",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => mark_card_notifications_read(client, i)),
	);

	server.tool(
		"list_list_actions",
		"Actions on a single list (e.g. \"what happened on @waiting this week\"). `filter` is a comma-separated Trello action-type filter; default \"all\". Newest-first.",
		{
			list: z.string().describe("List alias or ID."),
			filter: z.string().optional(),
			limit: z.number().int().min(1).max(1000).optional(),
		},
		guarded(login, async (i: { list: string; filter?: string; limit?: number }) =>
			list_list_actions(client, i),
		),
	);

	server.tool(
		"list_my_actions",
		"The authenticated user's cross-board recent activity. Useful for reflection (\"what did I do this week?\"). `filter` is a comma-separated action-type filter; default \"all\". Newest-first.",
		{
			filter: z.string().optional(),
			limit: z.number().int().min(1).max(1000).optional(),
		},
		guarded(login, async (i: { filter?: string; limit?: number }) =>
			list_my_actions(client, i),
		),
	);

	server.tool(
		"list_board_memberships",
		"Board memberships with role data (admin / normal / observer / virtual) plus confirmation + deactivation state. Richer than list_board_members.",
		{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_board_memberships(client, i)),
	);

	server.tool(
		"get_member",
		"Look up any Trello member's profile by ID or username (e.g. resolving a member id seen in raw data).",
		{ idOrUsername: z.string() },
		guarded(login, async (i: { idOrUsername: string }) => get_member(client, i)),
	);

	// ============================================================
	// v1.8.0 — single-entity fetches, action details, custom fields,
	// plugins/power-ups, batch GET, archived-card reads
	// ============================================================

	server.tool(
		"get_label",
		"Fetch one label directly. `label` accepts a raw label ID or a name (resolved on `board`, default dann-to-do).",
		{
			label: z.string().describe("Label ID or name."),
			board: z.string().optional().describe("Board alias or ID. Used only when `label` is a name. Default: dann-to-do."),
		},
		guarded(login, async (i: { label: string; board?: string }) => get_label(client, i)),
	);

	server.tool(
		"get_attachment",
		"Fetch a single attachment with richer fields than list_attachments returns (previews[], edgeColor, pos).",
		{
			cardId: z.string(),
			attachmentId: z.string(),
		},
		guarded(login, async (i: { cardId: string; attachmentId: string }) =>
			get_attachment(client, i),
		),
	);

	server.tool(
		"list_comment_reactions_summary",
		"Grouped emoji-reaction counts on a comment. Lighter than list_comment_reactions when you just need per-emoji totals.",
		{ commentId: z.string().describe("Action ID from read_comments.") },
		guarded(login, async (i: { commentId: string }) =>
			list_comment_reactions_summary(client, i),
		),
	);

	server.tool(
		"get_action",
		"Full detail for a single action (move, comment, update, etc.). Complements card_activity_log / list_list_actions / list_my_actions for drilling into one event.",
		{ actionId: z.string() },
		guarded(login, async (i: { actionId: string }) => get_action(client, i)),
	);

	server.tool(
		"get_action_display",
		"Trello's pre-rendered human-readable version of an action (e.g. \"Dann moved X from @computer to @home\"). Useful for building activity feeds without reimplementing the rendering.",
		{ actionId: z.string() },
		guarded(login, async (i: { actionId: string }) => get_action_display(client, i)),
	);

	server.tool(
		"list_custom_fields",
		"Custom-field DEFINITIONS on a board (Power-Up). Errors with an actionable message if the Custom Fields Power-Up is not enabled on the board.",
		{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_custom_fields(client, i)),
	);

	server.tool(
		"create_custom_field",
		"Create a new custom-field definition on a board. `type` is one of checkbox / date / list / number / text. `pos` accepts \"top\" / \"bottom\" / a number.",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			name: z.string().min(1),
			type: z.enum(["checkbox", "date", "list", "number", "text"]),
			pos: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
			displayCardFront: z.boolean().optional().describe("Show this field on the card front? Default false."),
		},
		guarded(
			login,
			async (i: { board?: string; name: string; type: string; pos?: "top" | "bottom" | number; displayCardFront?: boolean }) =>
				create_custom_field(client, i),
		),
	);

	server.tool(
		"update_custom_field",
		"Rename / reposition / toggle display-on-card-front for a custom-field definition.",
		{
			customFieldId: CUSTOM_FIELD_REF,
			board: z.string().optional().describe("Board alias or ID for the name lookup. Default: dann-to-do."),
			name: z.string().min(1).optional(),
			pos: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
			displayCardFront: z.boolean().optional(),
		},
		guarded(
			login,
			async (i: { customFieldId: string; board?: string; name?: string; pos?: "top" | "bottom" | number; displayCardFront?: boolean }) =>
				update_custom_field(client, i),
		),
	);

	server.tool(
		"delete_custom_field",
		"Delete a custom-field definition. DESTRUCTIVE and irreversible: it also erases that field's value on every card on the board. Requires confirm: true.",
		{
			customFieldId: CUSTOM_FIELD_REF,
			board: z.string().optional().describe("Board alias or ID for the name lookup. Default: dann-to-do."),
			confirm: z
				.boolean()
				.optional()
				.describe("Must be true. Without it the call is refused with a description of what would be lost."),
		},
		guarded(login, async (i: { customFieldId: string; board?: string; confirm?: boolean }) =>
			delete_custom_field(client, i),
		),
	);

	server.tool(
		"add_custom_field_option",
		"Add an option to a LIST-type custom field. Refused if the field is not list-type.",
		{
			customFieldId: CUSTOM_FIELD_REF,
			board: z.string().optional().describe("Board alias or ID for the name lookup. Default: dann-to-do."),
			value: z.string().min(1).describe("Option label text."),
			color: CUSTOM_FIELD_COLORS.optional().describe("Trello palette token."),
			pos: z.union([z.enum(["top", "bottom"]), z.number().nonnegative()]).optional(),
		},
		guarded(
			login,
			async (i: { customFieldId: string; board?: string; value: string; color?: string; pos?: "top" | "bottom" | number }) =>
				add_custom_field_option(client, i),
		),
	);

	server.tool(
		"delete_custom_field_option",
		"Remove an option from a LIST-type custom field. `optionId` accepts the option's ID or its label text.",
		{
			customFieldId: CUSTOM_FIELD_REF,
			board: z.string().optional().describe("Board alias or ID for the name lookup. Default: dann-to-do."),
			optionId: z.string().describe("Option ID, or the option's label text."),
		},
		guarded(login, async (i: { customFieldId: string; optionId: string; board?: string }) =>
			delete_custom_field_option(client, i),
		),
	);

	server.tool(
		"list_card_custom_fields",
		"A card's custom-field values, joined against the board's definitions: each row carries `name` and `type`, list-type rows resolve to the option's label, and fields that have never been set are returned with value: null.",
		{ cardId: z.string() },
		guarded(login, async (i: { cardId: string }) => list_card_custom_fields(client, i)),
	);

	server.tool(
		"set_card_custom_field",
		"Set a custom-field value on a card. `value` is one of: { checked: bool } | { date: ISO } | { number } | { text } | { listOptionId } | null (to clear). Only one key may be present, and it must match the field's declared type — a mismatch is refused with the correct key named. `listOptionId` accepts an option label as well as an ID.",
		{
			cardId: z.string(),
			customFieldId: CUSTOM_FIELD_REF,
			value: CUSTOM_FIELD_VALUE,
		},
		guarded(
			login,
			async (i: { cardId: string; customFieldId: string; value: CustomFieldValue }) =>
				set_card_custom_field(client, i),
		),
	);

	server.tool(
		"batch_set_card_custom_field",
		"Set the SAME custom field to the SAME value across many cards. The field is resolved and type-checked once per board rather than once per card. Continues past per-card failures and reports them in `skipped`.",
		{
			cardIds: z.array(z.string()).min(1).describe("Card IDs. Capped at 50."),
			customFieldId: CUSTOM_FIELD_REF,
			value: CUSTOM_FIELD_VALUE,
		},
		guarded(
			login,
			async (i: { cardIds: string[]; customFieldId: string; value: CustomFieldValue }) =>
				batch_set_card_custom_field(client, i),
		),
	);

	server.tool(
		"rename_custom_field_option",
		"Rename a LIST-type option WITHOUT losing the cards using it. Trello's API has no update-option endpoint, so a naive delete+re-add clears the field on every card that pointed at the old option. This adds the new option, re-points affected cards, then deletes the old one — and if any card fails to move it stops and leaves BOTH options in place rather than destroying values.",
		{
			customFieldId: CUSTOM_FIELD_REF,
			optionId: z.string().describe("Option ID, or its current label text."),
			newValue: z.string().min(1).describe("The new label."),
			board: z.string().optional().describe("Board alias or ID for the name lookup. Default: dann-to-do."),
			color: CUSTOM_FIELD_COLORS.optional().describe("Override the colour; defaults to the old option's."),
		},
		guarded(
			login,
			async (i: { customFieldId: string; optionId: string; newValue: string; board?: string; color?: string }) =>
				rename_custom_field_option(client, i),
		),
	);

	server.tool(
		"list_board_plugins",
		"Power-Ups currently enabled on a board. Each row includes `id` (needed for disable) and `idPlugin`, plus an `alias` when known.",
		{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_board_plugins(client, i)),
	);

	server.tool(
		"enable_board_plugin",
		"Enable a Power-Up on a board. `plugin` accepts an alias (custom-fields / card-aging / voting / calendar) or a raw plugin ID.",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			plugin: z.string().describe("Plugin alias (custom-fields, card-aging, voting, calendar) or ID."),
		},
		guarded(login, async (i: { board?: string; plugin: string }) =>
			enable_board_plugin(client, i),
		),
	);

	server.tool(
		"disable_board_plugin",
		"Disable a Power-Up on a board. `boardPluginId` is the `id` from list_board_plugins — NOT the plugin ID (Trello REST quirk).",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			boardPluginId: z.string().describe("The `id` from list_board_plugins (not the idPlugin)."),
		},
		guarded(login, async (i: { board?: string; boardPluginId: string }) =>
			disable_board_plugin(client, i),
		),
	);

	server.tool(
		"get_plugin",
		"Plugin metadata (name, description, url) by alias or plugin ID.",
		{ plugin: z.string().describe("Plugin alias or ID.") },
		guarded(login, async (i: { plugin: string }) => get_plugin(client, i)),
	);

	// ============================================================
	// v1.15.0 — Snooze Power-Up integration
	// ============================================================

	server.tool(
		"list_snoozed_cards",
		"Cards the Snooze Power-Up has hidden (archived) with a scheduled wake time. Returns name, home list, wakeUp (ISO), and overdueWake (wake time passed but Power-Up hasn't fired). Sorted soonest-first. Note: snooze_read is a different mechanism (dueReminder offsets) — this reads the actual Power-Up state.",
		{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
		guarded(login, async (i: { board?: string }) => list_snoozed_cards(client, i)),
	);

	server.tool(
		"wake_card",
		"Unarchive a Power-Up-snoozed card NOW — it returns to its home list. Refuses cards that aren't snoozed by the Snooze Power-Up (this is not a blind unarchiver). Creating snoozes via the API is impossible (Power-Up-private data); snoozing stays a Trello-UI action.",
		{ cardId: z.string().describe("Snoozed card to wake.") },
		guarded(login, async (i: { cardId: string }) => wake_card(client, i)),
	);

	server.tool(
		"batch_get",
		"Trello /batch endpoint. Bundle up to 10 relative Trello paths (each starting with `/`, e.g. `/boards/58cbce31043f1a89cfc6b42c`) into one request. Returns per-URL `{statusCode, body}` in input order. Individual URL errors don't fail the batch.",
		{
			paths: z.array(z.string()).min(1).max(10).describe("Relative Trello paths, e.g. [\"/boards/xxx\", \"/cards/yyy\"]."),
		},
		guarded(login, async (i: { paths: string[] }) => batch_get(client, i)),
	);

	server.tool(
		"list_archived_cards",
		"Closed (archived) cards on a board. Same CardSummary shape as list_cards, with optional label + staleDays filters.",
		{
			board: z.string().optional().describe("Board alias or ID. Default: dann-to-do."),
			label: z.string().optional(),
			staleDays: z.number().int().positive().optional(),
		},
		guarded(login, async (i: { board?: string; label?: string; staleDays?: number }) =>
			list_archived_cards(client, i),
		),
	);

	// ============================================================
	// v1.16.0 — digest on demand
	// ============================================================

	server.tool(
		"send_digest",
		"Send the 'Todays Actions' digest email NOW with live board data (same email as the daily 04:00 send). If sent inside the morning cron window, the day's cron send is marked done so it won't duplicate.",
		{},
		guarded(login, async () => {
			const nowMs = Date.now();
			await sendDigestEmail(env, nowMs);
			await noteManualSend(env, nowMs);
			return { sent: true, to: env.DIGEST_TO ?? "(default recipient)" };
		}),
	);
}
