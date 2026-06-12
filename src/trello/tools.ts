/**
 * File: src/trello/tools.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: The 15 Trello MCP tools. Each export is a pure async function
 *              that takes a TrelloClient + typed input and returns a JSON-safe
 *              result. Tools resolve friendly aliases at the boundary, enforce
 *              guards, and emit WIP warnings in their response shape so Claude
 *              can pass them through.
 *
 *              Keeping these as plain functions (not McpServer.tool callbacks)
 *              means they can be unit-tested without a Worker runtime.
 *
 *              Tool surface (15):
 *                Reads (6):  list_boards, list_lists, list_cards, get_card,
 *                            search_cards, list_checklist_items
 *                Writes (9): create_card, move_card, update_card, archive_card,
 *                            set_due_complete, add_label, remove_label,
 *                            add_comment, add_checklist_item
 *
 * Change log:
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
import type { TrelloClient, TrelloCard, TrelloList } from "./client";
import {
	GuardError,
	assertCanWriteTo,
	assertCardWritable,
	assertNotReadOnly,
	assertWritable,
	wipWarning,
} from "./guards";

// ---- Result shapes (deliberately compact so Claude's context isn't flooded) ----

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
	labels: string[];
	due: string | null;
	dueComplete: boolean;
	updated: string;
	url: string;
}

interface CardDetail extends CardSummary {
	desc: string;
	boardId: string;
}

function summariseCard(card: TrelloCard): CardSummary {
	return {
		id: card.id,
		name: card.name,
		listId: card.idList,
		listAlias: listAliasFor(card.idList),
		labels: card.labels.map((lb) => lb.name).filter((n) => n.length > 0),
		due: card.due,
		dueComplete: card.dueComplete,
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
			desc: card.desc,
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

// ---- Helpers ----

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
