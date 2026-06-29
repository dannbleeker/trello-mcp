/**
 * File: src/trello/tools.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.2.0
 * Description: The 19 Trello MCP tools. Each export is a pure async function
 *              that takes a TrelloClient + typed input and returns a JSON-safe
 *              result. Tools resolve friendly aliases at the boundary, enforce
 *              guards, and emit WIP warnings in their response shape so Claude
 *              can pass them through.
 *
 *              Keeping these as plain functions (not McpServer.tool callbacks)
 *              means they can be unit-tested without a Worker runtime.
 *
 *              Tool surface (77):
 *                Reads (16):  list_boards, list_lists, list_cards,
 *                             list_cards_by_list, list_cards_due,
 *                             list_my_cards_assigned, get_card,
 *                             search_cards, search_cards_advanced,
 *                             list_checklist_items, list_attachments,
 *                             list_labels, list_board_members, list_card_members,
 *                             read_comments, card_activity_log,
 *                             snooze_read, weekly_review_pack
 *                Writes (32): create_card, copy_card, move_card, update_card,
 *                             archive_card, set_due_complete, set_card_position,
 *                             set_start_date, set_due_reminder,
 *                             set_checklist_item_state, add_label, remove_label,
 *                             create_label, delete_label, add_comment,
 *                             update_comment, delete_comment,
 *                             add_checklist_item, remove_checklist_item,
 *                             create_checklist, rename_checklist, delete_checklist,
 *                             convert_checklist_item_to_card,
 *                             add_member_to_card, remove_member_from_card,
 *                             add_attachment, add_file_attachment,
 *                             remove_attachment, batch_add_label,
 *                             batch_move_cards
 *
 * Change log:
 *   1.7.0 (2026-06-13) — +12 tools across 4 themes:
 *                        Voting (3):       vote_card, unvote_card, list_card_voters
 *                        Reactions (3):    add_comment_reaction, remove_comment_reaction,
 *                                          list_comment_reactions
 *                        Bulk hygiene (2): copy_checklist, mark_card_notifications_read
 *                        Inspection (4):   list_list_actions, list_my_actions,
 *                                          list_board_memberships, get_member
 *   1.6.0 (2026-06-13) — +17 tools across 6 themes:
 *                        List mgmt (6):    create_list, rename_list, archive_list,
 *                                          move_list, move_all_cards, archive_all_cards
 *                        Card cover (2):   set_card_cover, clear_card_cover
 *                        Checklist items (3): set_checklist_item_due,
 *                                          assign_checklist_item_member,
 *                                          reorder_checklist_item
 *                        Label edit (1):   update_label
 *                        Subscribe (2):    subscribe_card, subscribe_list
 *                        Notifications (3): list_notifications,
 *                                          mark_notification_read,
 *                                          mark_all_notifications_read
 *   1.5.0 (2026-06-13) — +13 tools across 4 themes:
 *                        Members (4):    list_board_members, list_card_members,
 *                                        add_member_to_card, remove_member_from_card
 *                        Checklists (3): create_checklist (named), rename_checklist,
 *                                        delete_checklist
 *                        Card-ops (2):   copy_card, set_due_reminder
 *                        Comments (2):   update_comment, delete_comment
 *                        Cross-board (1): list_my_cards_assigned
 *                        Composite (1):  weekly_review_pack — single call returning
 *                                        inbox/overdue/today/week/waiting/contexts.
 *                        CardSummary + CardDetail gain idMembers.
 *   1.4.1 (2026-06-13) — Add delete_label (board-wide, destructive) for
 *                        symmetry with create_label. Removes the label from
 *                        every card that carries it.
 *   1.4.0 (2026-06-13) — Add 14 new tools spanning reflect/engage GTD phases:
 *                        list_cards_due, list_cards_by_list, search_cards_advanced,
 *                        read_comments, list_labels, create_label,
 *                        remove_checklist_item, convert_checklist_item_to_card,
 *                        set_card_position, set_start_date, snooze_read,
 *                        batch_add_label, batch_move_cards, card_activity_log.
 *                        CardSummary extended with start + dueReminder.
 *                        Note: dueReminder is the minutes-before-due reminder
 *                        offset, NOT a snooze/hide field — Trello has no native
 *                        snooze in its REST API.
 *   1.3.0 (2026-06-12) — Add add_file_attachment for real file uploads via
 *                        base64 (multipart under the hood). Hard cap at 10 MB
 *                        decoded — past that, host the file and use
 *                        add_attachment with a URL instead.
 *   1.2.0 (2026-06-12) — Add set_checklist_item_state (tick/untick individual
 *                        checklist items) and 3 attachment tools (list/add/remove).
 *                        Attachments are URL-only; file uploads not supported.
 *   1.1.0 (2026-06-12) — Add `desc` to CardSummary so list_cards/search_cards
 *                        return descriptions (regression vs the retired local
 *                        Python MCP). CardDetail no longer duplicates the field.
 *   1.0.0 (2026-06-12) — Initial.
 */

import {
	BOARD_ALIASES,
	DEFAULT_BOARD,
	LIST_ALIASES,
	MAX_RESULTS,
	boardAliasFor,
	listAliasFor,
	resolveBoard,
	resolveList,
} from "./constants";
import type {
	TrelloAction,
	TrelloCard,
	TrelloClient,
	TrelloComment,
	TrelloList,
	TrelloMember,
	TrelloMembership,
	TrelloNotification,
	TrelloReaction,
} from "./client";
import {
	GuardError,
	assertCanWriteTo,
	assertCardWritable,
	assertNotReadOnly,
	assertWritable,
	wipWarning,
} from "./guards";

// ---- Result shapes ----

interface BoardSummary {
	id: string;
	alias: string | null;
	name: string;
	url: string;
}

interface ListSummary {
	id: string;
	alias: string | null;
	name: string;
}

interface CardSummary {
	id: string;
	name: string;
	listId: string;
	listAlias: string | null;
	desc: string;
	labels: string[];
	due: string | null;
	dueComplete: boolean;
	start: string | null;
	/** Minutes-before-due reminder offset; -1 = no reminder, null = unset. NOT a snooze field. */
	dueReminder: number | null;
	memberIds: string[];
	updated: string;
	url: string;
}

interface CardDetail extends CardSummary {
	boardId: string;
}

function summariseCard(card: TrelloCard): CardSummary {
	return {
		id: card.id,
		name: card.name,
		listId: card.idList,
		listAlias: listAliasFor(card.idList),
		desc: card.desc,
		labels: card.labels.map((lb) => lb.name).filter((n) => n.length > 0),
		due: card.due,
		dueComplete: card.dueComplete,
		start: card.start,
		dueReminder: card.dueReminder,
		memberIds: card.idMembers ?? [],
		updated: card.dateLastActivity,
		url: card.url,
	};
}

function summariseBoard(board: { id: string; name: string; url: string }): BoardSummary {
	return {
		id: board.id,
		alias: boardAliasFor(board.id),
		name: board.name,
		url: board.url,
	};
}

function summariseList(list: TrelloList): ListSummary {
	return {
		id: list.id,
		alias: listAliasFor(list.id),
		name: list.name,
	};
}

/** Trim a card list to MAX_RESULTS, optionally filter to staleness. */
function applyCardFilters(cards: TrelloCard[], staleDays?: number, label?: string): TrelloCard[] {
	let out = cards.filter((c) => !c.closed);
	if (staleDays !== undefined && staleDays > 0) {
		const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
		out = out.filter((c) => Date.parse(c.dateLastActivity) <= cutoff);
	}
	if (label) {
		const target = label.toLowerCase();
		out = out.filter((c) => c.labels.some((lb) => lb.name.toLowerCase() === target));
	}
	return out.slice(0, MAX_RESULTS);
}

// ============================================================================
// READS (6)
// ============================================================================

/** list_boards — every open board the authenticated Trello user belongs to. */
export async function list_boards(client: TrelloClient): Promise<{ boards: BoardSummary[] }> {
	const boards = await client.listMyBoards();
	return {
		boards: boards.filter((b) => !b.closed).map(summariseBoard),
	};
}

/** list_lists — lists on a board. */
export async function list_lists(
	client: TrelloClient,
	input: { board?: string },
): Promise<{ board: BoardSummary; lists: ListSummary[] }> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const [board, lists] = await Promise.all([
		client.getBoard(boardId),
		client.listListsOnBoard(boardId),
	]);
	return {
		board: summariseBoard(board),
		lists: lists.filter((l) => !l.closed).map(summariseList),
	};
}

/**
 * list_cards — cards on a list, or on a board if `list` is omitted.
 * Optional filters: `staleDays`, `label`.
 */
export async function list_cards(
	client: TrelloClient,
	input: { list?: string; board?: string; label?: string; staleDays?: number },
): Promise<{ scope: { listId?: string; boardId?: string }; cards: CardSummary[]; truncated: boolean }> {
	let raw: TrelloCard[];
	const scope: { listId?: string; boardId?: string } = {};
	if (input.list) {
		const listId = resolveList(input.list);
		scope.listId = listId;
		raw = await client.listCardsOnList(listId);
	} else {
		const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
		scope.boardId = boardId;
		raw = await client.listCardsOnBoard(boardId);
	}
	const filtered = applyCardFilters(raw, input.staleDays, input.label);
	return {
		scope,
		cards: filtered.map(summariseCard),
		truncated: filtered.length === MAX_RESULTS,
	};
}

/** get_card — full details for one card. */
export async function get_card(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ card: CardDetail }> {
	const card = await client.getCard(input.cardId);
	return {
		card: {
			...summariseCard(card),
			boardId: card.idBoard,
		},
	};
}

/** search_cards — fuzzy name match across a board (or all boards if board omitted). */
export async function search_cards(
	client: TrelloClient,
	input: { query: string; board?: string },
): Promise<{ query: string; cards: CardSummary[] }> {
	const boardId = input.board ? resolveBoard(input.board) : undefined;
	const results = await client.searchCards(input.query, boardId);
	return {
		query: input.query,
		cards: results.filter((c) => !c.closed).slice(0, MAX_RESULTS).map(summariseCard),
	};
}

/** list_checklist_items — read the checklist items on a card. */
export async function list_checklist_items(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ checklists: { id: string; name: string; items: { id: string; name: string; state: "complete" | "incomplete" }[] }[] }> {
	const checklists = await client.listChecklistsOnCard(input.cardId);
	return {
		checklists: checklists.map((cl) => ({
			id: cl.id,
			name: cl.name,
			items: cl.checkItems
				.sort((a, b) => a.pos - b.pos)
				.map((it) => ({ id: it.id, name: it.name, state: it.state })),
		})),
	};
}

// ============================================================================
// WRITES (9)
// ============================================================================

/** create_card — create a new card on the given list. Guards + WIP warning. */
export async function create_card(
	client: TrelloClient,
	input: { list: string; name: string; desc?: string; due?: string; labels?: string[] },
): Promise<{ card: CardSummary; warning?: string }> {
	const listId = resolveList(input.list);
	assertCanWriteTo(listId);

	const card = await client.createCard({
		idList: listId,
		name: input.name,
		desc: input.desc,
		due: input.due,
		idLabels: input.labels,
	});

	// WIP warning: count cards on dest AFTER create (so the count already includes this card).
	const [destCards, allLists] = await Promise.all([
		client.listCardsOnList(listId),
		client.listListsOnBoard(card.idBoard),
	]);
	const warning = wipWarning(listId, destCards.length, allLists) ?? undefined;

	return { card: summariseCard(card), warning };
}

/** move_card — move a card to a different list. Guards source AND destination + WIP warning. */
export async function move_card(
	client: TrelloClient,
	input: { cardId: string; list: string },
): Promise<{ card: CardSummary; warning?: string }> {
	const destListId = resolveList(input.list);
	assertCanWriteTo(destListId);

	const sourceCard = await client.getCard(input.cardId);
	assertWritable(sourceCard.idList); // refuse moves FROM Butler / Repeater Cards
	assertNotReadOnly(sourceCard.idList, "source"); // refuse moves FROM Rolling Big Rocks

	const moved = await client.moveCard(input.cardId, destListId);

	// WIP warning: count AFTER move (count includes the newly arrived card).
	const [destCards, allLists] = await Promise.all([
		client.listCardsOnList(destListId),
		client.listListsOnBoard(moved.idBoard),
	]);
	const warning = wipWarning(destListId, destCards.length, allLists) ?? undefined;

	return { card: summariseCard(moved), warning };
}

/** update_card — edit name/desc/due on a card. */
export async function update_card(
	client: TrelloClient,
	input: { cardId: string; name?: string; desc?: string; due?: string | null },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	const updated = await client.updateCard(input.cardId, {
		name: input.name,
		desc: input.desc,
		due: input.due === null ? null : input.due,
	});
	return { card: summariseCard(updated) };
}

/** archive_card — soft archive (closed=true). Never hard-deletes. */
export async function archive_card(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	const archived = await client.archiveCard(input.cardId);
	return { card: summariseCard(archived) };
}

/** set_due_complete — mark/unmark the due date as complete (Butler watches this). */
export async function set_due_complete(
	client: TrelloClient,
	input: { cardId: string; complete: boolean },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	const updated = await client.setDueComplete(input.cardId, input.complete);
	return { card: summariseCard(updated) };
}

/** add_label — apply a label by ID or name (within the card's board). */
export async function add_label(
	client: TrelloClient,
	input: { cardId: string; label: string },
): Promise<{ added: { id: string; name: string; color: string } }> {
	const card = await assertCardWritable(client, input.cardId);
	const labelId = await resolveLabel(client, card.idBoard, input.label);
	await client.addLabelToCard(input.cardId, labelId.id);
	return { added: labelId };
}

/** remove_label — remove a label by ID or name. */
export async function remove_label(
	client: TrelloClient,
	input: { cardId: string; label: string },
): Promise<{ removed: { id: string; name: string; color: string } }> {
	const card = await assertCardWritable(client, input.cardId);
	const labelId = await resolveLabel(client, card.idBoard, input.label);
	await client.removeLabelFromCard(input.cardId, labelId.id);
	return { removed: labelId };
}

/** add_comment — append a comment to a card. */
export async function add_comment(
	client: TrelloClient,
	input: { cardId: string; text: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	await client.addComment(input.cardId, input.text);
	return { ok: true };
}

/** add_checklist_item — append an item to the card's checklist (creates one if absent). */
export async function add_checklist_item(
	client: TrelloClient,
	input: { cardId: string; text: string },
): Promise<{ item: { id: string; name: string; state: "complete" | "incomplete" } }> {
	await assertCardWritable(client, input.cardId);
	const item = await client.addChecklistItem(input.cardId, input.text);
	return { item: { id: item.id, name: item.name, state: item.state } };
}

/** set_checklist_item_state — tick/untick a single checklist item. */
export async function set_checklist_item_state(
	client: TrelloClient,
	input: { cardId: string; itemId: string; complete: boolean },
): Promise<{ item: { id: string; name: string; state: "complete" | "incomplete" } }> {
	await assertCardWritable(client, input.cardId);
	const item = await client.setChecklistItemState(input.cardId, input.itemId, input.complete);
	return { item: { id: item.id, name: item.name, state: item.state } };
}

/** list_attachments — attachments on a card (id, name, url, date, mimeType). */
export async function list_attachments(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ attachments: { id: string; name: string; url: string; date: string; mimeType: string | null }[] }> {
	const attachments = await client.listAttachments(input.cardId);
	return {
		attachments: attachments.map((a) => ({
			id: a.id,
			name: a.name,
			url: a.url,
			date: a.date,
			mimeType: a.mimeType,
		})),
	};
}

/** add_attachment — attach a URL to a card. */
export async function add_attachment(
	client: TrelloClient,
	input: { cardId: string; url: string; name?: string },
): Promise<{ attachment: { id: string; name: string; url: string } }> {
	await assertCardWritable(client, input.cardId);
	const a = await client.addAttachment(input.cardId, { url: input.url, name: input.name });
	return { attachment: { id: a.id, name: a.name, url: a.url } };
}

const FILE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * add_file_attachment — upload an actual file (not a URL). The caller passes
 * the file as base64 in `contentBase64`; we decode it server-side and post
 * multipart to Trello.
 *
 * Hard cap at 10 MB decoded. The cap exists because anything larger is
 * (a) over Trello's free-tier limit and (b) impractical to round-trip through
 * an MCP tool argument anyway — host the file and use add_attachment with a
 * URL instead.
 */
export async function add_file_attachment(
	client: TrelloClient,
	input: { cardId: string; filename: string; mimeType?: string; contentBase64: string },
): Promise<{ attachment: { id: string; name: string; url: string; bytes: number | null; mimeType: string | null } }> {
	await assertCardWritable(client, input.cardId);

	const bytes = decodeBase64(input.contentBase64);
	if (bytes.length === 0) {
		throw new GuardError("contentBase64 decoded to 0 bytes — nothing to upload.");
	}
	if (bytes.length > FILE_ATTACHMENT_MAX_BYTES) {
		throw new GuardError(
			`File is ${bytes.length} bytes; this tool caps uploads at ${FILE_ATTACHMENT_MAX_BYTES} bytes (10 MB). Host the file and use add_attachment with a URL instead.`,
		);
	}

	const a = await client.addFileAttachment(input.cardId, {
		bytes,
		filename: input.filename,
		mimeType: input.mimeType,
	});
	return {
		attachment: {
			id: a.id,
			name: a.name,
			url: a.url,
			bytes: a.bytes,
			mimeType: a.mimeType,
		},
	};
}

/** remove_attachment — remove an attachment from a card by attachment ID. */
export async function remove_attachment(
	client: TrelloClient,
	input: { cardId: string; attachmentId: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	await client.removeAttachment(input.cardId, input.attachmentId);
	return { ok: true };
}

// ============================================================================
// v1.4.0 — READS: due, advanced search, labels, comments, activity, snooze
// ============================================================================

type DueScope = "today" | "overdue" | "next_seven_days";

/**
 * list_cards_due — cards filtered by a GTD-relevant due-date scope, optionally
 * narrowed to a list and/or a label. Reads from a single board (defaults to
 * dann-to-do); board API is cheaper than /search for date-window queries.
 */
export async function list_cards_due(
	client: TrelloClient,
	input: { scope: DueScope; list?: string; label?: string; board?: string },
): Promise<{
	scope: DueScope;
	cards: (CardSummary & {
		snoozed: boolean;
		wakeUp: string | null;
	})[];
	truncated: boolean;
}> {
	if (input.scope !== "today" && input.scope !== "overdue" && input.scope !== "next_seven_days") {
		throw new GuardError(
			`Unknown scope "${input.scope}". Use one of: today, overdue, next_seven_days.`,
		);
	}
	let raw: TrelloCard[];
	if (input.list) {
		raw = await client.listCardsOnList(resolveList(input.list));
	} else {
		const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
		raw = await client.listCardsOnBoard(boardId);
	}

	const now = Date.now();
	const startOfToday = new Date(now);
	startOfToday.setUTCHours(0, 0, 0, 0);
	const endOfToday = startOfToday.getTime() + 24 * 60 * 60 * 1000;
	const endOfWeek = now + 7 * 24 * 60 * 60 * 1000;

	const passesScope = (c: TrelloCard): boolean => {
		if (!c.due) return false;
		const t = Date.parse(c.due);
		if (Number.isNaN(t)) return false;
		switch (input.scope) {
			case "overdue":
				return t < now && !c.dueComplete;
			case "today":
				return t >= startOfToday.getTime() && t < endOfToday;
			case "next_seven_days":
				return t >= now && t <= endOfWeek;
		}
	};

	const filtered = applyCardFilters(raw.filter(passesScope), undefined, input.label);
	return {
		scope: input.scope,
		cards: filtered.map((c) => ({
			...summariseCard(c),
			snoozed: c.dueReminder !== null && c.dueReminder !== -1,
			wakeUp: computeWakeUp(c.due, c.dueReminder),
		})),
		truncated: filtered.length === MAX_RESULTS,
	};
}

/**
 * list_cards_by_list — focused read for a single list with snooze/no-due
 * filters that list_cards doesn't expose. Use this for inbox triage and
 * weekly-review sweeps.
 */
export async function list_cards_by_list(
	client: TrelloClient,
	input: { list: string; excludeDueDates?: boolean; includeSnoozedOnly?: boolean; label?: string; staleDays?: number },
): Promise<{ listId: string; cards: (CardSummary & { snoozed: boolean; wakeUp: string | null })[]; truncated: boolean }> {
	const listId = resolveList(input.list);
	const raw = await client.listCardsOnList(listId);
	let filtered = raw.filter((c) => !c.closed);

	if (input.excludeDueDates) filtered = filtered.filter((c) => c.due === null);
	if (input.includeSnoozedOnly) {
		filtered = filtered.filter((c) => c.dueReminder !== null && c.dueReminder !== -1);
	}
	if (input.label) {
		const target = input.label.toLowerCase();
		filtered = filtered.filter((c) => c.labels.some((lb) => lb.name.toLowerCase() === target));
	}
	if (input.staleDays && input.staleDays > 0) {
		const cutoff = Date.now() - input.staleDays * 24 * 60 * 60 * 1000;
		filtered = filtered.filter((c) => Date.parse(c.dateLastActivity) <= cutoff);
	}

	filtered = filtered.slice(0, MAX_RESULTS);
	return {
		listId,
		cards: filtered.map((c) => ({
			...summariseCard(c),
			snoozed: c.dueReminder !== null && c.dueReminder !== -1,
			wakeUp: computeWakeUp(c.due, c.dueReminder),
		})),
		truncated: filtered.length === MAX_RESULTS,
	};
}

/**
 * search_cards_advanced — Trello /search with operators in the query string.
 * Supports operators like `due:day`, `due:overdue`, `due:week`, `label:red`,
 * `list:"Inbox"`, `has:attachments`, `description:"foo"`, `is:archived`.
 * Multi-board scope and a tunable card limit (up to 1000).
 */
export async function search_cards_advanced(
	client: TrelloClient,
	input: { query: string; boards?: string[]; limit?: number },
): Promise<{ query: string; cards: CardSummary[] }> {
	const boardIds = input.boards?.map((b) => resolveBoard(b));
	const results = await client.searchCardsAdvanced({
		query: input.query,
		boardIds,
		cardsLimit: input.limit,
	});
	return {
		query: input.query,
		cards: results.filter((c) => !c.closed).slice(0, MAX_RESULTS).map(summariseCard),
	};
}

/** read_comments — chronological comment thread on a card. */
export async function read_comments(
	client: TrelloClient,
	input: { cardId: string; limit?: number },
): Promise<{ cardId: string; comments: TrelloComment[] }> {
	const comments = await client.listComments(input.cardId, input.limit ?? 50);
	return { cardId: input.cardId, comments };
}

/** list_labels — all labels on a board. */
export async function list_labels(
	client: TrelloClient,
	input: { board?: string },
): Promise<{ board: BoardSummary; labels: { id: string; name: string; color: string }[] }> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const [board, labels] = await Promise.all([
		client.getBoard(boardId),
		client.listLabelsOnBoard(boardId),
	]);
	return {
		board: summariseBoard(board),
		labels: labels.map((lb) => ({ id: lb.id, name: lb.name, color: lb.color })),
	};
}

/**
 * card_activity_log — recent actions on a card (moves, due-date changes,
 * label/attachment/comment activity). Defaults to a useful filter set; pass
 * `filter="all"` to widen it.
 */
const ACTIVITY_DEFAULT_FILTER = [
	"createCard",
	"updateCard:idList",
	"updateCard:closed",
	"updateCard:due",
	"updateCard:dueComplete",
	"addLabelToCard",
	"removeLabelFromCard",
	"addAttachmentToCard",
	"deleteAttachmentFromCard",
	"commentCard",
	"addChecklistToCard",
	"removeChecklistFromCard",
	"updateCheckItemStateOnCard",
	"convertToCardFromCheckItem",
].join(",");

export async function card_activity_log(
	client: TrelloClient,
	input: { cardId: string; filter?: string; limit?: number },
): Promise<{
	cardId: string;
	actions: {
		id: string;
		type: string;
		date: string;
		author: string | null;
		data: Record<string, unknown>;
	}[];
}> {
	const actions = await client.listActions(
		input.cardId,
		input.filter && input.filter.length > 0 ? input.filter : ACTIVITY_DEFAULT_FILTER,
		input.limit ?? 50,
	);
	return {
		cardId: input.cardId,
		actions: actions
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
			.map((a) => ({
				id: a.id,
				type: a.type,
				date: a.date,
				author: a.memberCreator?.fullName ?? null,
				data: a.data,
			})),
	};
}

/**
 * snooze_read — cards whose `dueReminder` is set (non-null and not -1),
 * sorted by computed wake-up time. Note: Trello does not expose a true
 * snooze/hide field in its REST API; `dueReminder` is a reminder offset
 * (minutes before due). The "wakeUp" timestamp is `due - dueReminder min`.
 *
 * Scope: a list (via `list`) or a board (via `board`, default dann-to-do).
 * Optional `label` filter.
 */
export async function snooze_read(
	client: TrelloClient,
	input: { list?: string; board?: string; label?: string },
): Promise<{
	scope: { listId?: string; boardId?: string };
	cards: (CardSummary & { wakeUp: string | null; reminderMinutes: number })[];
}> {
	let raw: TrelloCard[];
	const scope: { listId?: string; boardId?: string } = {};
	if (input.list) {
		const listId = resolveList(input.list);
		scope.listId = listId;
		raw = await client.listCardsOnList(listId);
	} else {
		const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
		scope.boardId = boardId;
		raw = await client.listCardsOnBoard(boardId);
	}

	let cards = raw.filter(
		(c) => !c.closed && c.dueReminder !== null && c.dueReminder !== -1,
	);
	if (input.label) {
		const target = input.label.toLowerCase();
		cards = cards.filter((c) => c.labels.some((lb) => lb.name.toLowerCase() === target));
	}
	const decorated = cards
		.map((c) => ({
			card: c,
			wakeUp: computeWakeUp(c.due, c.dueReminder),
		}))
		.sort((a, b) => {
			const ax = a.wakeUp ? Date.parse(a.wakeUp) : Number.POSITIVE_INFINITY;
			const bx = b.wakeUp ? Date.parse(b.wakeUp) : Number.POSITIVE_INFINITY;
			return ax - bx;
		})
		.slice(0, MAX_RESULTS);

	return {
		scope,
		cards: decorated.map(({ card, wakeUp }) => ({
			...summariseCard(card),
			wakeUp,
			reminderMinutes: card.dueReminder ?? -1,
		})),
	};
}

// ============================================================================
// v1.4.0 — WRITES: position, start date, label create, checklist mgmt, batch ops
// ============================================================================

/** set_card_position — top, bottom, or numeric position within the card's list. */
export async function set_card_position(
	client: TrelloClient,
	input: { cardId: string; position: "top" | "bottom" | number },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	if (
		input.position !== "top" &&
		input.position !== "bottom" &&
		(typeof input.position !== "number" || !Number.isFinite(input.position) || input.position < 0)
	) {
		throw new GuardError(
			`position must be "top", "bottom", or a non-negative number; got ${JSON.stringify(input.position)}.`,
		);
	}
	const updated = await client.setCardPosition(input.cardId, input.position);
	return { card: summariseCard(updated) };
}

/** set_start_date — set the card's start date (ISO 8601), or null to clear it. */
export async function set_start_date(
	client: TrelloClient,
	input: { cardId: string; start: string | null },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	if (input.start !== null) {
		const t = Date.parse(input.start);
		if (Number.isNaN(t)) {
			throw new GuardError(`start must be a valid ISO 8601 date string or null; got "${input.start}".`);
		}
	}
	const updated = await client.setStartDate(input.cardId, input.start);
	return { card: summariseCard(updated) };
}

/** create_label — new label on a board. Color must be a Trello palette token. */
const TRELLO_LABEL_COLORS = new Set([
	"yellow",
	"purple",
	"blue",
	"red",
	"green",
	"orange",
	"black",
	"sky",
	"pink",
	"lime",
]);

export async function create_label(
	client: TrelloClient,
	input: { board?: string; name: string; color?: string | null },
): Promise<{ label: { id: string; name: string; color: string } }> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const color = input.color ?? null;
	if (color !== null && color !== "" && !TRELLO_LABEL_COLORS.has(color)) {
		throw new GuardError(
			`Unknown color "${color}". Use one of: ${[...TRELLO_LABEL_COLORS].join(", ")}, or null for no color.`,
		);
	}
	const created = await client.createLabel(boardId, input.name, color);
	return { label: { id: created.id, name: created.name, color: created.color } };
}

/**
 * delete_label — board-wide delete. `label` accepts an ID or a name (resolved
 * against the named board). Destructive: every card that carried this label
 * loses it. Recovery is recreate + reapply.
 */
export async function delete_label(
	client: TrelloClient,
	input: { board?: string; label: string },
): Promise<{ deleted: { id: string; name: string; color: string } }> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const resolved = await resolveLabel(client, boardId, input.label);
	await client.deleteLabel(resolved.id);
	return { deleted: resolved };
}

/** remove_checklist_item — remove one item from a checklist. */
export async function remove_checklist_item(
	client: TrelloClient,
	input: { cardId: string; checklistId: string; itemId: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	await client.removeChecklistItem(input.checklistId, input.itemId);
	return { ok: true };
}

/**
 * convert_checklist_item_to_card — promote a checklist item to a standalone
 * card. Trello creates the new card on the SAME list as the source card; if
 * `targetList` is provided, we move it afterwards. The item is auto-removed
 * by the convert.
 */
export async function convert_checklist_item_to_card(
	client: TrelloClient,
	input: { cardId: string; checklistId: string; itemId: string; targetList?: string },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);

	let newCard = await client.convertChecklistItemToCard(
		input.cardId,
		input.checklistId,
		input.itemId,
	);

	if (input.targetList) {
		const targetId = resolveList(input.targetList);
		assertCanWriteTo(targetId);
		if (targetId !== newCard.idList) {
			newCard = await client.moveCard(newCard.id, targetId);
		}
	}

	return { card: summariseCard(newCard) };
}

const BATCH_MAX = 50;

/**
 * batch_add_label — add the same label to many cards. Resolves the label
 * once per board to avoid N lookups. Skips cards whose board doesn't have
 * the named label and reports them separately. Stops early at BATCH_MAX.
 */
export async function batch_add_label(
	client: TrelloClient,
	input: { cardIds: string[]; label: string },
): Promise<{
	updated: number;
	skipped: { cardId: string; reason: string }[];
}> {
	if (!Array.isArray(input.cardIds) || input.cardIds.length === 0) {
		throw new GuardError("cardIds must be a non-empty array.");
	}
	if (input.cardIds.length > BATCH_MAX) {
		throw new GuardError(`Batch size capped at ${BATCH_MAX}; got ${input.cardIds.length}.`);
	}

	const labelByBoard = new Map<string, { id: string; name: string; color: string } | null>();
	const skipped: { cardId: string; reason: string }[] = [];
	let updated = 0;

	for (const cardId of input.cardIds) {
		try {
			const card = await assertCardWritable(client, cardId);
			if (!labelByBoard.has(card.idBoard)) {
				try {
					const resolved = await resolveLabel(client, card.idBoard, input.label);
					labelByBoard.set(card.idBoard, resolved);
				} catch {
					labelByBoard.set(card.idBoard, null);
				}
			}
			const lb = labelByBoard.get(card.idBoard);
			if (!lb) {
				skipped.push({ cardId, reason: `label "${input.label}" not found on board ${card.idBoard}` });
				continue;
			}
			await client.addLabelToCard(cardId, lb.id);
			updated += 1;
		} catch (e) {
			skipped.push({ cardId, reason: e instanceof Error ? e.message : String(e) });
		}
	}

	return { updated, skipped };
}

/**
 * batch_move_cards — move many cards to the same destination list. Guards
 * source (assertCardWritable) and destination (assertCanWriteTo). Continues
 * on per-card failure and reports skipped ones.
 */
export async function batch_move_cards(
	client: TrelloClient,
	input: { cardIds: string[]; targetList: string },
): Promise<{
	moved: number;
	skipped: { cardId: string; reason: string }[];
	warning?: string;
}> {
	if (!Array.isArray(input.cardIds) || input.cardIds.length === 0) {
		throw new GuardError("cardIds must be a non-empty array.");
	}
	if (input.cardIds.length > BATCH_MAX) {
		throw new GuardError(`Batch size capped at ${BATCH_MAX}; got ${input.cardIds.length}.`);
	}

	const destListId = resolveList(input.targetList);
	assertCanWriteTo(destListId);

	const skipped: { cardId: string; reason: string }[] = [];
	let moved = 0;
	let destBoardId: string | null = null;

	for (const cardId of input.cardIds) {
		try {
			const card = await client.getCard(cardId);
			assertWritable(card.idList);
			assertNotReadOnly(card.idList, "source");
			const result = await client.moveCard(cardId, destListId);
			destBoardId = result.idBoard;
			moved += 1;
		} catch (e) {
			skipped.push({ cardId, reason: e instanceof Error ? e.message : String(e) });
		}
	}

	let warning: string | undefined;
	if (destBoardId) {
		const [destCards, allLists] = await Promise.all([
			client.listCardsOnList(destListId),
			client.listListsOnBoard(destBoardId),
		]);
		warning = wipWarning(destListId, destCards.length, allLists) ?? undefined;
	}

	return { moved, skipped, warning };
}

// ============================================================================
// v1.5.0 — members, named checklists, copy_card, due-reminder, comment edits,
// cross-board "my cards", weekly_review_pack composite
// ============================================================================

// ---- Members ----

/** list_board_members — everyone with access to a board. */
export async function list_board_members(
	client: TrelloClient,
	input: { board?: string },
): Promise<{ board: BoardSummary; members: TrelloMember[] }> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const [board, members] = await Promise.all([
		client.getBoard(boardId),
		client.listBoardMembers(boardId),
	]);
	return { board: summariseBoard(board), members };
}

/** list_card_members — assignees on a single card. */
export async function list_card_members(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ cardId: string; members: TrelloMember[] }> {
	const members = await client.listCardMembers(input.cardId);
	return { cardId: input.cardId, members };
}

/**
 * add_member_to_card — assign by member ID or username (resolved against the
 * card's board). Idempotent: re-assigning an existing member is a no-op on
 * Trello's side.
 */
export async function add_member_to_card(
	client: TrelloClient,
	input: { cardId: string; member: string },
): Promise<{ added: TrelloMember }> {
	const card = await assertCardWritable(client, input.cardId);
	const member = await resolveMember(client, card.idBoard, input.member);
	await client.addMemberToCard(input.cardId, member.id);
	return { added: member };
}

/** remove_member_from_card — unassign by ID or username. */
export async function remove_member_from_card(
	client: TrelloClient,
	input: { cardId: string; member: string },
): Promise<{ removed: TrelloMember }> {
	const card = await assertCardWritable(client, input.cardId);
	const member = await resolveMember(client, card.idBoard, input.member);
	await client.removeMemberFromCard(input.cardId, member.id);
	return { removed: member };
}

/**
 * list_my_cards_assigned — cross-board "all cards assigned to me", optionally
 * filtered by board. Useful for daily kickoff across Dann to-do + Zoo.
 */
export async function list_my_cards_assigned(
	client: TrelloClient,
	input: { board?: string },
): Promise<{ me: { id: string; username: string }; cards: CardSummary[]; truncated: boolean }> {
	const [me, raw] = await Promise.all([client.getMe(), client.listMyAssignedCards()]);
	let cards = raw.filter((c) => !c.closed);
	if (input.board) {
		const boardId = resolveBoard(input.board);
		cards = cards.filter((c) => c.idBoard === boardId);
	}
	const slice = cards.slice(0, MAX_RESULTS);
	return {
		me: { id: me.id, username: me.username },
		cards: slice.map(summariseCard),
		truncated: slice.length === MAX_RESULTS,
	};
}

// ---- Checklists (named) ----

/** create_checklist — create a new checklist on a card with an explicit name. */
export async function create_checklist(
	client: TrelloClient,
	input: { cardId: string; name: string },
): Promise<{ checklist: { id: string; name: string } }> {
	await assertCardWritable(client, input.cardId);
	const cl = await client.createChecklist(input.cardId, input.name);
	return { checklist: { id: cl.id, name: cl.name } };
}

/** rename_checklist — change a checklist's name. */
export async function rename_checklist(
	client: TrelloClient,
	input: { cardId: string; checklistId: string; name: string },
): Promise<{ checklist: { id: string; name: string } }> {
	await assertCardWritable(client, input.cardId);
	const cl = await client.renameChecklist(input.checklistId, input.name);
	return { checklist: { id: cl.id, name: cl.name } };
}

/** delete_checklist — remove a checklist and all its items. */
export async function delete_checklist(
	client: TrelloClient,
	input: { cardId: string; checklistId: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	await client.deleteChecklist(input.checklistId);
	return { ok: true };
}

// ---- Card ops: copy + due-reminder ----

const COPY_KEEP_TOKENS = new Set([
	"all",
	"attachments",
	"checklists",
	"comments",
	"due",
	"start",
	"labels",
	"members",
	"stickers",
]);

/**
 * copy_card — duplicate a card to a target list. `keepFromSource` defaults to
 * "all"; pass a comma-separated subset to copy only some facets. Optional
 * `newName` overrides the source name.
 */
export async function copy_card(
	client: TrelloClient,
	input: {
		cardId: string;
		targetList: string;
		newName?: string;
		keepFromSource?: string;
		position?: "top" | "bottom" | number;
	},
): Promise<{ card: CardSummary; warning?: string }> {
	// Validate keepFromSource tokens early — Trello silently ignores bad ones.
	if (input.keepFromSource) {
		const tokens = input.keepFromSource.split(",").map((t) => t.trim()).filter(Boolean);
		for (const t of tokens) {
			if (!COPY_KEEP_TOKENS.has(t)) {
				throw new GuardError(
					`keepFromSource token "${t}" is not recognised. Use any of: ${[...COPY_KEEP_TOKENS].join(", ")}, comma-separated.`,
				);
			}
		}
	}

	const destListId = resolveList(input.targetList);
	assertCanWriteTo(destListId);
	// Guard the SOURCE too — copying out of Butler/Repeater Cards would replicate automation rows.
	await assertCardWritable(client, input.cardId);

	const copied = await client.copyCard({
		sourceCardId: input.cardId,
		idList: destListId,
		name: input.newName,
		keepFromSource: input.keepFromSource,
		pos: input.position,
	});

	const [destCards, allLists] = await Promise.all([
		client.listCardsOnList(destListId),
		client.listListsOnBoard(copied.idBoard),
	]);
	const warning = wipWarning(destListId, destCards.length, allLists) ?? undefined;

	return { card: summariseCard(copied), warning };
}

/**
 * set_due_reminder — set the minutes-before-due reminder offset.
 *   0   = at due time
 *   60  = 1 hour before
 *   1440 = 1 day before
 * Pass null to clear the reminder.
 *
 * NOTE: this writes Trello's `dueReminder` field, which is the reminder
 * offset — not a hide/snooze field. There is no native snooze in Trello.
 */
export async function set_due_reminder(
	client: TrelloClient,
	input: { cardId: string; minutesBeforeDue: number | null },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	if (input.minutesBeforeDue !== null) {
		if (!Number.isFinite(input.minutesBeforeDue) || input.minutesBeforeDue < 0) {
			throw new GuardError(
				`minutesBeforeDue must be null or a non-negative number; got ${input.minutesBeforeDue}.`,
			);
		}
	}
	const updated = await client.setDueReminder(input.cardId, input.minutesBeforeDue);
	return { card: summariseCard(updated) };
}

// ---- Comment edits ----

/** update_comment — edit the text of an existing comment by its action ID. */
export async function update_comment(
	client: TrelloClient,
	input: { cardId: string; commentId: string; text: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	await client.updateComment(input.commentId, input.text);
	return { ok: true };
}

/** delete_comment — remove a comment by its action ID. */
export async function delete_comment(
	client: TrelloClient,
	input: { cardId: string; commentId: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	await client.deleteComment(input.commentId);
	return { ok: true };
}

// ---- Composite: weekly_review_pack ----

/**
 * weekly_review_pack — one call returning the buckets Dann walks through every
 * Friday: inbox count + sample, overdue, due today, due this week, context-list
 * counts, waiting list (stale), could-do horizon counts, snoozed (reminder set),
 * and the Rolling Big Rocks count.
 *
 * Defaults to dann-to-do. The context/horizon buckets are populated only when
 * the board's lists match LIST_ALIASES — for other boards (e.g. zoo) you still
 * get the date-based buckets but the GTD-section breakdown is empty.
 */
const WEEKLY_REVIEW_CONTEXT_LISTS = ["@computer", "@home", "@phone", "@errands", "@lene"] as const;
const WEEKLY_REVIEW_COULD_LISTS = ["could-personal", "could-bestseller", "could-dbp-invest", "someday"] as const;
const WAITING_LIST_ALIAS = "waiting";
const INBOX_LIST_ALIAS = "inbox";
// Rolling Big Rocks list id (READ_ONLY). Pulled from constants.ts.
const ROLLING_BIG_ROCKS_ID = "5b6189409662065780670709";

export async function weekly_review_pack(
	client: TrelloClient,
	input: { board?: string; staleDays?: number; maxPerBucket?: number },
): Promise<{
	asOf: string;
	board: BoardSummary;
	inbox: { count: number; sample: CardSummary[] };
	overdue: { count: number; cards: CardSummary[] };
	due_today: { count: number; cards: CardSummary[] };
	due_this_week: { count: number; cards: CardSummary[] };
	contexts: Record<string, number>;
	waiting: { count: number; stale: CardSummary[]; staleDays: number };
	could_do: Record<string, number>;
	big_rocks: { count: number };
	snoozed: { count: number };
}> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const staleDays = input.staleDays ?? 7;
	const cap = Math.min(input.maxPerBucket ?? 25, MAX_RESULTS);

	const [board, allCards] = await Promise.all([
		client.getBoard(boardId),
		client.listCardsOnBoard(boardId),
	]);
	const open = allCards.filter((c) => !c.closed);

	const now = Date.now();
	const todayStart = new Date(now);
	todayStart.setUTCHours(0, 0, 0, 0);
	const todayEnd = todayStart.getTime() + 24 * 60 * 60 * 1000;
	const weekEnd = now + 7 * 24 * 60 * 60 * 1000;
	const staleCutoff = now - staleDays * 24 * 60 * 60 * 1000;

	// Resolve known list aliases ONCE.
	const aliasToId = (alias: string): string => resolveList(alias);
	const inboxId = aliasToId(INBOX_LIST_ALIAS);
	const waitingId = aliasToId(WAITING_LIST_ALIAS);

	const inboxCards = open.filter((c) => c.idList === inboxId);
	const waitingCards = open.filter((c) => c.idList === waitingId);
	const overdueCards = open.filter(
		(c) => c.due && !c.dueComplete && Date.parse(c.due) < now,
	);
	const dueTodayCards = open.filter((c) => {
		if (!c.due) return false;
		const t = Date.parse(c.due);
		return t >= todayStart.getTime() && t < todayEnd;
	});
	const dueThisWeekCards = open.filter((c) => {
		if (!c.due) return false;
		const t = Date.parse(c.due);
		return t >= now && t <= weekEnd;
	});

	const contexts: Record<string, number> = {};
	for (const alias of WEEKLY_REVIEW_CONTEXT_LISTS) {
		const id = aliasToId(alias);
		contexts[alias] = open.filter((c) => c.idList === id).length;
	}

	const couldDo: Record<string, number> = {};
	for (const alias of WEEKLY_REVIEW_COULD_LISTS) {
		const id = aliasToId(alias);
		couldDo[alias] = open.filter((c) => c.idList === id).length;
	}

	const bigRocksCount = open.filter((c) => c.idList === ROLLING_BIG_ROCKS_ID).length;

	const snoozedCount = open.filter(
		(c) => c.dueReminder !== null && c.dueReminder !== -1,
	).length;

	const waitingStale = waitingCards
		.filter((c) => Date.parse(c.dateLastActivity) <= staleCutoff)
		.slice(0, cap)
		.map(summariseCard);

	return {
		asOf: new Date(now).toISOString(),
		board: summariseBoard(board),
		inbox: { count: inboxCards.length, sample: inboxCards.slice(0, cap).map(summariseCard) },
		overdue: { count: overdueCards.length, cards: overdueCards.slice(0, cap).map(summariseCard) },
		due_today: { count: dueTodayCards.length, cards: dueTodayCards.slice(0, cap).map(summariseCard) },
		due_this_week: { count: dueThisWeekCards.length, cards: dueThisWeekCards.slice(0, cap).map(summariseCard) },
		contexts,
		waiting: { count: waitingCards.length, stale: waitingStale, staleDays },
		could_do: couldDo,
		big_rocks: { count: bigRocksCount },
		snoozed: { count: snoozedCount },
	};
}

// ============================================================================
// v1.6.0 — list mgmt, card cover, checklist-item updates, label edit,
// subscribe, notifications
// ============================================================================

// ---- List management ----

/** create_list — new list on a board. */
export async function create_list(
	client: TrelloClient,
	input: { board?: string; name: string; position?: "top" | "bottom" | number },
): Promise<{ list: ListSummary; boardId: string }> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const list = await client.createList({
		boardId,
		name: input.name,
		pos: input.position,
	});
	return { list: summariseList(list), boardId };
}

/** rename_list — change a list's name. */
export async function rename_list(
	client: TrelloClient,
	input: { list: string; name: string },
): Promise<{ list: ListSummary }> {
	const listId = resolveList(input.list);
	assertWritable(listId);
	const updated = await client.updateList(listId, { name: input.name });
	return { list: summariseList(updated) };
}

/**
 * archive_list — close (default) or reopen a list. Guards refuse it on Butler
 * / Repeater Cards so automation infrastructure can't be hidden.
 */
export async function archive_list(
	client: TrelloClient,
	input: { list: string; closed?: boolean },
): Promise<{ list: ListSummary }> {
	const listId = resolveList(input.list);
	assertWritable(listId);
	const updated = await client.updateList(listId, { closed: input.closed ?? true });
	return { list: summariseList(updated) };
}

/**
 * move_list — reposition (`position` = "top" / "bottom" / number) and/or move
 * the list (with its cards) to another board (`targetBoard` = alias or ID).
 * At least one must be provided.
 */
export async function move_list(
	client: TrelloClient,
	input: { list: string; position?: "top" | "bottom" | number; targetBoard?: string },
): Promise<{ list: ListSummary }> {
	if (input.position === undefined && input.targetBoard === undefined) {
		throw new GuardError("Pass at least one of `position` or `targetBoard`.");
	}
	const listId = resolveList(input.list);
	assertWritable(listId);
	const updated = await client.updateList(listId, {
		pos: input.position,
		idBoard: input.targetBoard ? resolveBoard(input.targetBoard) : undefined,
	});
	return { list: summariseList(updated) };
}

/**
 * move_all_cards — bulk-move every card from one list to another. Guards both
 * source and destination. The destination's board is derived from the list
 * itself (so the caller doesn't have to pass it).
 */
export async function move_all_cards(
	client: TrelloClient,
	input: { sourceList: string; targetList: string },
): Promise<{ ok: true; sourceListId: string; targetListId: string }> {
	const sourceListId = resolveList(input.sourceList);
	const targetListId = resolveList(input.targetList);
	assertWritable(sourceListId);
	assertNotReadOnly(sourceListId, "source");
	assertCanWriteTo(targetListId);

	// Trello needs the destination board id explicitly (cards can cross boards
	// during the bulk move). Derive it by probing one card on the destination
	// or, failing that, on the source.
	let targetBoardId = "";
	const destProbe = await client.listCardsOnList(targetListId);
	if (destProbe.length > 0) {
		targetBoardId = destProbe[0].idBoard;
	} else {
		const srcProbe = await client.listCardsOnList(sourceListId);
		targetBoardId = srcProbe[0]?.idBoard ?? "";
	}
	if (!targetBoardId) {
		throw new GuardError(
			"Could not derive the destination board id for move_all_cards (both lists are empty — nothing to move anyway).",
		);
	}

	await client.moveAllCardsOnList(sourceListId, targetListId, targetBoardId);
	return { ok: true, sourceListId, targetListId };
}

/** archive_all_cards — bulk-archive every open card on a list. */
export async function archive_all_cards(
	client: TrelloClient,
	input: { list: string },
): Promise<{ ok: true; listId: string }> {
	const listId = resolveList(input.list);
	assertWritable(listId);
	await client.archiveAllCardsOnList(listId);
	return { ok: true, listId };
}

// ---- Card cover ----

const COVER_COLORS = new Set([
	"pink",
	"yellow",
	"lime",
	"blue",
	"black",
	"orange",
	"red",
	"purple",
	"sky",
	"green",
]);

/**
 * set_card_cover — set the cover via a palette color OR an attachment already
 * on the card. At least one of `color` / `attachmentId` must be provided.
 * `size` ∈ "normal" | "full"; `brightness` ∈ "light" | "dark" (color only).
 */
export async function set_card_cover(
	client: TrelloClient,
	input: {
		cardId: string;
		color?: string;
		attachmentId?: string;
		size?: "normal" | "full";
		brightness?: "light" | "dark";
	},
): Promise<{ card: CardSummary; cover: { color: string | null; idAttachment: string | null; size: string | null; brightness: string | null } }> {
	await assertCardWritable(client, input.cardId);
	if (!input.color && !input.attachmentId) {
		throw new GuardError("Pass at least one of `color` or `attachmentId`. To remove, use clear_card_cover.");
	}
	if (input.color && !COVER_COLORS.has(input.color)) {
		throw new GuardError(
			`Unknown cover color "${input.color}". Use one of: ${[...COVER_COLORS].join(", ")}.`,
		);
	}
	const updated = await client.setCardCover(input.cardId, {
		color: input.color ?? null,
		idAttachment: input.attachmentId ?? null,
		size: input.size,
		brightness: input.brightness,
	});
	const cover = updated.cover ?? {};
	return {
		card: summariseCard(updated),
		cover: {
			color: cover.color ?? null,
			idAttachment: cover.idAttachment ?? null,
			size: cover.size ?? null,
			brightness: cover.brightness ?? null,
		},
	};
}

/** clear_card_cover — strip the card's cover entirely. */
export async function clear_card_cover(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ card: CardSummary }> {
	await assertCardWritable(client, input.cardId);
	const updated = await client.clearCardCover(input.cardId);
	return { card: summariseCard(updated) };
}

// ---- Checklist item: due, member, position ----

/** set_checklist_item_due — set or clear an item's due date (ISO 8601 or null). */
export async function set_checklist_item_due(
	client: TrelloClient,
	input: { cardId: string; itemId: string; due: string | null },
): Promise<{ item: { id: string; name: string; state: "complete" | "incomplete"; due: string | null } }> {
	await assertCardWritable(client, input.cardId);
	if (input.due !== null && Number.isNaN(Date.parse(input.due))) {
		throw new GuardError(`due must be a valid ISO 8601 date or null; got "${input.due}".`);
	}
	const item = await client.updateChecklistItem(input.cardId, input.itemId, { due: input.due });
	return {
		item: {
			id: item.id,
			name: item.name,
			state: item.state,
			due: (item as ChecklistItemWithExtras).due ?? null,
		},
	};
}

/** assign_checklist_item_member — assign by ID/username/full name, or null to clear. */
export async function assign_checklist_item_member(
	client: TrelloClient,
	input: { cardId: string; itemId: string; member: string | null },
): Promise<{ item: { id: string; name: string; state: "complete" | "incomplete"; memberId: string | null } }> {
	const card = await assertCardWritable(client, input.cardId);
	let memberId: string | null = null;
	if (input.member !== null) {
		const resolved = await resolveMember(client, card.idBoard, input.member);
		memberId = resolved.id;
	}
	const item = await client.updateChecklistItem(input.cardId, input.itemId, {
		idMember: memberId,
	});
	return {
		item: {
			id: item.id,
			name: item.name,
			state: item.state,
			memberId: (item as ChecklistItemWithExtras).idMember ?? null,
		},
	};
}

/** reorder_checklist_item — move an item within its checklist. */
export async function reorder_checklist_item(
	client: TrelloClient,
	input: { cardId: string; itemId: string; position: "top" | "bottom" | number },
): Promise<{ item: { id: string; name: string; state: "complete" | "incomplete"; pos: number } }> {
	await assertCardWritable(client, input.cardId);
	if (
		input.position !== "top" &&
		input.position !== "bottom" &&
		(typeof input.position !== "number" || !Number.isFinite(input.position) || input.position < 0)
	) {
		throw new GuardError(
			`position must be "top", "bottom", or a non-negative number; got ${JSON.stringify(input.position)}.`,
		);
	}
	const item = await client.updateChecklistItem(input.cardId, input.itemId, { pos: input.position });
	return { item: { id: item.id, name: item.name, state: item.state, pos: item.pos } };
}

// ---- Label edit ----

/**
 * update_label — rename and/or recolor a label. At least one of `name` /
 * `color` must be provided. `color` accepts a Trello palette token or null
 * to clear the color.
 */
export async function update_label(
	client: TrelloClient,
	input: { board?: string; label: string; name?: string; color?: string | null },
): Promise<{ label: { id: string; name: string; color: string } }> {
	if (input.name === undefined && input.color === undefined) {
		throw new GuardError("Pass at least one of `name` or `color`.");
	}
	if (
		input.color !== undefined &&
		input.color !== null &&
		input.color !== "" &&
		!TRELLO_LABEL_COLORS.has(input.color)
	) {
		throw new GuardError(
			`Unknown color "${input.color}". Use one of: ${[...TRELLO_LABEL_COLORS].join(", ")}, or null for no color.`,
		);
	}
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const resolved = await resolveLabel(client, boardId, input.label);
	const updated = await client.updateLabel(resolved.id, {
		name: input.name,
		color: input.color,
	});
	return { label: { id: updated.id, name: updated.name, color: updated.color } };
}

// ---- Subscribe ----

/** subscribe_card — watch / unwatch a single card. */
export async function subscribe_card(
	client: TrelloClient,
	input: { cardId: string; subscribed: boolean },
): Promise<{ card: CardSummary; subscribed: boolean }> {
	await assertCardWritable(client, input.cardId);
	const updated = await client.setCardSubscribed(input.cardId, input.subscribed);
	return { card: summariseCard(updated), subscribed: updated.subscribed ?? input.subscribed };
}

/** subscribe_list — watch / unwatch every card on a list (via the list's own watch flag). */
export async function subscribe_list(
	client: TrelloClient,
	input: { list: string; subscribed: boolean },
): Promise<{ list: ListSummary; subscribed: boolean }> {
	const listId = resolveList(input.list);
	assertWritable(listId);
	const updated = await client.setListSubscribed(listId, input.subscribed);
	return { list: summariseList(updated), subscribed: updated.subscribed ?? input.subscribed };
}

// ---- Notifications ----

/**
 * list_notifications — the authenticated user's notification feed (the bell
 * icon). `filter` is a comma-separated Trello notification-type filter (default
 * "all"). `readFilter` ∈ "all" | "read" | "unread". `since` / `before` are
 * notification IDs (cursor pagination), not dates.
 */
export async function list_notifications(
	client: TrelloClient,
	input: {
		filter?: string;
		readFilter?: "all" | "read" | "unread";
		limit?: number;
		since?: string;
		before?: string;
	},
): Promise<{ notifications: SummarisedNotification[] }> {
	const raw = await client.listNotifications({
		filter: input.filter,
		readFilter: input.readFilter,
		limit: input.limit,
		since: input.since,
		before: input.before,
	});
	return {
		notifications: raw
			.slice(0, MAX_RESULTS)
			.map(summariseNotification),
	};
}

/** mark_notification_read — flip one notification's read/unread flag. */
export async function mark_notification_read(
	client: TrelloClient,
	input: { notificationId: string; unread?: boolean },
): Promise<{ notification: SummarisedNotification }> {
	const n = await client.markNotificationRead(input.notificationId, input.unread ?? false);
	return { notification: summariseNotification(n) };
}

/**
 * mark_all_notifications_read — bulk mark every unread notification as read.
 * Optional `filter` narrows scope (e.g. "cardDueSoon" to clear due-soon pings
 * only). NOTE: read=false is also supported by Trello to bulk-unread but is
 * rarely useful — default is read=true.
 */
export async function mark_all_notifications_read(
	client: TrelloClient,
	input: { filter?: string; read?: boolean },
): Promise<{ ok: true }> {
	await client.markAllNotificationsRead({
		read: input.read ?? true,
		filter: input.filter,
	});
	return { ok: true };
}

// ============================================================================
// v1.7.0 — votes, comment reactions, copy_checklist, bulk-clear card
// notifications, broader activity reads, memberships, member lookup
// ============================================================================

// ---- Voting ----

/** vote_card — cast a vote on a card as the authenticated user. */
export async function vote_card(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ ok: true; voterId: string }> {
	await assertCardWritable(client, input.cardId);
	const me = await client.getMe();
	await client.voteCard(input.cardId, me.id);
	return { ok: true, voterId: me.id };
}

/** unvote_card — withdraw your vote. */
export async function unvote_card(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ ok: true }> {
	await assertCardWritable(client, input.cardId);
	const me = await client.getMe();
	await client.unvoteCard(input.cardId, me.id);
	return { ok: true };
}

/** list_card_voters — members who have voted on a card. */
export async function list_card_voters(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ cardId: string; voters: TrelloMember[] }> {
	const voters = await client.listCardVoters(input.cardId);
	return { cardId: input.cardId, voters };
}

// ---- Reactions on comments ----

/**
 * add_comment_reaction — attach an emoji reaction to a comment. `emoji` is
 * the Trello shortName (e.g. "thumbsup", "white_check_mark", "heart", "eyes",
 * "raised_hands"). Use `list_comment_reactions` to see what's been used.
 *
 * NOTE: `commentId` is the action ID (from `read_comments`); reactions live on
 * actions, not on the comment text directly.
 */
export async function add_comment_reaction(
	client: TrelloClient,
	input: { commentId: string; emoji: string },
): Promise<{ reaction: { id: string; emoji: string; memberId: string } }> {
	if (!input.emoji || input.emoji.trim().length === 0) {
		throw new GuardError("emoji must be a non-empty shortName, e.g. \"thumbsup\".");
	}
	const r = await client.addCommentReaction(input.commentId, input.emoji);
	return {
		reaction: {
			id: r.id,
			emoji: r.emoji?.shortName ?? input.emoji,
			memberId: r.idMember,
		},
	};
}

/** remove_comment_reaction — remove a reaction by its ID (from list_comment_reactions). */
export async function remove_comment_reaction(
	client: TrelloClient,
	input: { commentId: string; reactionId: string },
): Promise<{ ok: true }> {
	await client.removeCommentReaction(input.commentId, input.reactionId);
	return { ok: true };
}

/** list_comment_reactions — all reactions on a comment. */
export async function list_comment_reactions(
	client: TrelloClient,
	input: { commentId: string },
): Promise<{
	commentId: string;
	reactions: { id: string; emoji: string; memberId: string; memberUsername: string | null }[];
}> {
	const raw = await client.listCommentReactions(input.commentId);
	return {
		commentId: input.commentId,
		reactions: raw.map((r) => ({
			id: r.id,
			emoji: r.emoji?.shortName ?? "",
			memberId: r.idMember,
			memberUsername: r.member?.username ?? null,
		})),
	};
}

// ---- Bulk / hygiene ----

/**
 * copy_checklist — duplicate an entire checklist (with its items) onto a
 * target card. Use case: meeting-prep templates. Optional `newName` overrides
 * the source checklist's name; `position` sets the new checklist's order.
 */
export async function copy_checklist(
	client: TrelloClient,
	input: {
		sourceChecklistId: string;
		targetCardId: string;
		newName?: string;
		position?: "top" | "bottom" | number;
	},
): Promise<{ checklist: { id: string; name: string } }> {
	await assertCardWritable(client, input.targetCardId);
	const cl = await client.copyChecklist({
		targetCardId: input.targetCardId,
		sourceChecklistId: input.sourceChecklistId,
		name: input.newName,
		pos: input.position,
	});
	return { checklist: { id: cl.id, name: cl.name } };
}

/**
 * mark_card_notifications_read — clear every notification associated with one
 * card in a single call. Faster than iterating mark_notification_read when
 * you've already processed a card's events.
 */
export async function mark_card_notifications_read(
	client: TrelloClient,
	input: { cardId: string },
): Promise<{ ok: true }> {
	await client.markCardAssociatedNotificationsRead(input.cardId);
	return { ok: true };
}

// ---- Inspection reads ----

/** list_list_actions — actions on a single list. Useful for "what happened on @waiting". */
export async function list_list_actions(
	client: TrelloClient,
	input: { list: string; filter?: string; limit?: number },
): Promise<{
	listId: string;
	actions: { id: string; type: string; date: string; author: string | null; data: Record<string, unknown> }[];
}> {
	const listId = resolveList(input.list);
	const actions = await client.listListActions(
		listId,
		input.filter && input.filter.length > 0 ? input.filter : "all",
		input.limit ?? 50,
	);
	return {
		listId,
		actions: actions
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
			.map((a) => ({
				id: a.id,
				type: a.type,
				date: a.date,
				author: a.memberCreator?.fullName ?? null,
				data: a.data,
			})),
	};
}

/**
 * list_my_actions — the authenticated user's cross-board recent activity.
 * Reflection use case: "what did I do across every board this week?"
 */
export async function list_my_actions(
	client: TrelloClient,
	input: { filter?: string; limit?: number },
): Promise<{
	actions: { id: string; type: string; date: string; data: Record<string, unknown> }[];
}> {
	const actions = await client.listMyActions(
		input.filter && input.filter.length > 0 ? input.filter : "all",
		input.limit ?? 50,
	);
	return {
		actions: actions
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
			.map((a) => ({
				id: a.id,
				type: a.type,
				date: a.date,
				data: a.data,
			})),
	};
}

/**
 * list_board_memberships — richer than list_board_members: per-member role
 * (admin / normal / observer / virtual) plus confirmation/deactivation state.
 */
export async function list_board_memberships(
	client: TrelloClient,
	input: { board?: string },
): Promise<{
	board: BoardSummary;
	memberships: {
		id: string;
		memberId: string;
		memberType: TrelloMembership["memberType"];
		unconfirmed: boolean;
		deactivated: boolean;
		member: { id: string; fullName: string; username: string } | null;
	}[];
}> {
	const boardId = resolveBoard(input.board ?? DEFAULT_BOARD);
	const [board, memberships] = await Promise.all([
		client.getBoard(boardId),
		client.listBoardMemberships(boardId),
	]);
	return {
		board: summariseBoard(board),
		memberships: memberships.map((m) => ({
			id: m.id,
			memberId: m.idMember,
			memberType: m.memberType,
			unconfirmed: m.unconfirmed,
			deactivated: m.deactivated,
			member: m.member
				? { id: m.member.id, fullName: m.member.fullName, username: m.member.username }
				: null,
		})),
	};
}

/** get_member — look up any Trello member by ID or username. */
export async function get_member(
	client: TrelloClient,
	input: { idOrUsername: string },
): Promise<{ member: TrelloMember }> {
	const member = await client.getMember(input.idOrUsername);
	return { member };
}

// ---- Helpers ----

/**
 * Trello returns due/idMember on checkItems when set, but our ChecklistItem
 * interface doesn't model them yet. Cast to this to read them safely without
 * widening the public interface in the client.
 */
type ChecklistItemWithExtras = {
	id: string;
	name: string;
	state: "complete" | "incomplete";
	pos: number;
	idChecklist: string;
	due?: string | null;
	idMember?: string | null;
};

/** Notification shape returned to the caller (terser than the raw Trello object). */
interface SummarisedNotification {
	id: string;
	type: string;
	date: string;
	unread: boolean;
	text: string | null;
	card: { id: string; name: string } | null;
	board: { id: string; name: string } | null;
	list: { id: string; name: string } | null;
}

function summariseNotification(n: TrelloNotification): SummarisedNotification {
	const data = n.data ?? {};
	return {
		id: n.id,
		type: n.type,
		date: n.date,
		unread: n.unread,
		text: typeof data.text === "string" ? data.text : null,
		card: data.card ? { id: data.card.id, name: data.card.name } : null,
		board: data.board ? { id: data.board.id, name: data.board.name } : null,
		list: data.list ? { id: data.list.id, name: data.list.name } : null,
	};
}

/**
 * Compute the wake-up time for a card with a `dueReminder` set.
 * Returns null if either input is null. Trello's `dueReminder` is the number
 * of minutes BEFORE the due date when the reminder should fire (so
 * `wakeUp = due - dueReminder min`). -1 means no reminder; we treat it as null.
 */
function computeWakeUp(due: string | null, dueReminder: number | null): string | null {
	if (!due || dueReminder === null || dueReminder === -1) return null;
	const t = Date.parse(due);
	if (Number.isNaN(t)) return null;
	return new Date(t - dueReminder * 60 * 1000).toISOString();
}

/**
 * Decode a base64 string to a Uint8Array. Works in Workers (atob is global)
 * and Node 18+ (atob is also global). Tolerates whitespace/newlines and the
 * `data:...;base64,` URL prefix so callers can paste either form.
 */
function decodeBase64(input: string): Uint8Array {
	let s = input.trim();
	const commaIdx = s.indexOf(",");
	if (s.startsWith("data:") && commaIdx > 0) s = s.slice(commaIdx + 1);
	s = s.replace(/\s+/g, "");
	try {
		const bin = atob(s);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		throw new GuardError("contentBase64 is not valid base64.");
	}
}

/**
 * Resolve a member by ID, username, or full name, scoped to the card's board.
 * Throws GuardError if not found. Used by add_member_to_card / remove_member_from_card.
 */
async function resolveMember(
	client: TrelloClient,
	boardId: string,
	keyOrName: string,
): Promise<TrelloMember> {
	const members = await client.listBoardMembers(boardId);
	const lower = keyOrName.toLowerCase();
	const byId = members.find((m) => m.id === keyOrName);
	if (byId) return byId;
	const byUsername = members.find((m) => m.username.toLowerCase() === lower);
	if (byUsername) return byUsername;
	const byFullName = members.find((m) => m.fullName.toLowerCase() === lower);
	if (byFullName) return byFullName;
	throw new GuardError(
		`Member not found on board ${boardId}: "${keyOrName}". Available members: ${members
			.map((m) => `${m.fullName} (${m.username})`)
			.join(", ")}`,
	);
}

/** Resolve a label by ID-or-name, scoped to the card's board. Throws GuardError if not found. */
async function resolveLabel(
	client: TrelloClient,
	boardId: string,
	keyOrName: string,
): Promise<{ id: string; name: string; color: string }> {
	const labels = await client.listLabelsOnBoard(boardId);
	const direct = labels.find((lb) => lb.id === keyOrName);
	if (direct) return { id: direct.id, name: direct.name, color: direct.color };
	const byName = labels.find((lb) => lb.name.toLowerCase() === keyOrName.toLowerCase());
	if (byName) return { id: byName.id, name: byName.name, color: byName.color };
	throw new GuardError(
		`Label not found on board ${boardId}: "${keyOrName}". Available labels: ${labels.map((lb) => lb.name || `(unnamed-${lb.color})`).join(", ")}`,
	);
}
