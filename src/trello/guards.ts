/**
 * File: src/trello/guards.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: Server-side safety guards. Centralised so the same rules apply to
 *              every write tool — no list-by-list policy drift.
 *
 *              Three rules:
 *                1. FORBIDDEN_LISTS: writes refused entirely (Butler, Repeater Cards)
 *                2. READ_ONLY_LISTS: source-or-destination of a move refused (Rolling Big Rocks)
 *                3. WIP limit: warning emitted (not enforced) when a move/create would
 *                   exceed a list's "(WIP limit N)" suffix.
 *
 *              Hard delete is not present anywhere in the codebase — there is no
 *              tool to refuse; the capability simply does not exist.
 *
 * Change log:
 *   1.0.0 (2026-06-12) — Initial.
 */

import { FORBIDDEN_LISTS, READ_ONLY_LISTS, listAliasFor, parseWipLimit } from "./constants";
import type { TrelloClient, TrelloList, TrelloCard } from "./client";

/** Thrown when a guard refuses an operation. Surfaced to the MCP caller verbatim. */
export class GuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GuardError";
	}
}

/**
 * Refuse if the list is in FORBIDDEN_LISTS. Use before any write that targets
 * a specific list (create_card, move_card destination) or any card on that list
 * (archive, update, label, comment, checklist).
 */
export function assertWritable(listId: string): void {
	if (FORBIDDEN_LISTS.has(listId)) {
		const alias = listAliasFor(listId) ?? "(no alias)";
		throw new GuardError(
			`Refused: list ${listId} ${alias} is automation infrastructure (Butler / Repeater Cards). Connector cannot modify cards there.`,
		);
	}
}

/**
 * Refuse if the list is READ_ONLY. Use for move_card source-or-destination,
 * and for create_card destination.
 */
export function assertNotReadOnly(listId: string, role: "source" | "destination"): void {
	if (READ_ONLY_LISTS.has(listId)) {
		const alias = listAliasFor(listId) ?? "(no alias)";
		throw new GuardError(
			`Refused: list ${listId} ${alias} is curated (Rolling Big Rocks). Connector cannot use it as a move ${role}.`,
		);
	}
}

/**
 * Compose-friendly: assert a write into the given list. Refuses if forbidden or read-only.
 * Use this for create_card and as the destination of move_card.
 */
export function assertCanWriteTo(listId: string): void {
	assertWritable(listId);
	assertNotReadOnly(listId, "destination");
}

/**
 * For tools that act on a card (archive, update, label, comment, checklist),
 * fetch the card's idList and refuse if that list is forbidden.
 * Read-only lists are intentionally NOT blocked here — those are fine to comment on,
 * label, etc. — only moves/creates touching Rolling Big Rocks are blocked.
 */
export async function assertCardWritable(client: TrelloClient, cardId: string): Promise<TrelloCard> {
	const card = await client.getCard(cardId);
	assertWritable(card.idList);
	return card;
}

/**
 * Compute a WIP-limit warning string for a destination list. Returns null when
 * the list has no WIP limit declared, or the post-move count would fit.
 *
 *   listId        — the destination list ID
 *   currentCount  — number of cards currently on the destination list
 *   countAfter    — projected count after the move/create (usually currentCount + 1)
 *   lists         — array containing the list (for name lookup)
 */
export function wipWarning(
	listId: string,
	countAfter: number,
	lists: TrelloList[],
): string | null {
	const list = lists.find((l) => l.id === listId);
	if (!list) return null;
	const limit = parseWipLimit(list.name);
	if (limit === null) return null;
	if (countAfter <= limit) return null;
	return `WIP warning: list "${list.name}" now has ${countAfter} cards, exceeds limit of ${limit}.`;
}
