/**
 * File: src/trello/constants.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: Static configuration for the Trello MCP — friendly aliases for
 *              boards/lists/labels, plus the guard rules (forbidden lists,
 *              read-only lists). Edit this file to add a new board or rename
 *              an alias; tools resolve aliases at call time.
 *
 * Change log:
 *   1.0.0 (2026-06-12) — Initial. Captures Dann to-do (GTD) and Zoo Leadership Meeting layouts.
 */

/**
 * Friendly board aliases. Tools that take a `board` parameter accept either a
 * raw 24-char Trello board ID or one of these keys.
 */
export const BOARD_ALIASES = {
	"dann-to-do": "58cbce31043f1a89cfc6b42c",
	zoo: "64ff6c30bf9776f75b04e3fa",
} as const;

export type BoardAlias = keyof typeof BOARD_ALIASES;

/** The default board used when a tool's `board` argument is omitted. */
export const DEFAULT_BOARD: BoardAlias = "dann-to-do";

/**
 * Friendly list aliases. Tools that take a `list` parameter accept either a
 * raw 24-char Trello list ID or one of these keys. Aliases are flat across
 * boards because Trello list IDs are globally unique.
 *
 * Lists deliberately omitted from this map:
 *   - "Butler"           (FORBIDDEN_LISTS)
 *   - "Repeater Cards"   (FORBIDDEN_LISTS)
 *   - "Rolling Big Rocks" (READ_ONLY_LISTS — read tools see it via board snapshot,
 *                          but `move_card` cannot target it as source or destination)
 */
export const LIST_ALIASES = {
	// Dann to-do — GTD process lists
	inbox: "59bd69c743b67aa0d621b3a9",
	waiting: "59b4453266a62986fd16872e",
	done: "63d7fdc0b310c11585d34c3e",

	// Dann to-do — action contexts (with WIP limits parsed from list name)
	"@computer": "59be51ab95ff1052eac74429",
	"@home": "59be516a18d71ddd80868e9d",
	"@phone": "5ab55bba5941a0a65bbd2256",
	"@errands": "59be519ca665c8b77ff07ffb",
	"@lene": "5db58e03ec3c6561ad9b2875",

	// Dann to-do — Could-do horizons
	"could-personal": "58cbce46897a91f2c0886b8f",
	"could-bestseller": "59b8ca79df1c9569a358625e",
	"could-dbp-invest": "5f969fac1ed84324457951f9",
	someday: "5b615cbea2df595751abefd7",

	// Zoo Leadership Meeting — meeting-flow lists
	"meeting-saved": "660e3a256ddaa349ca6979d2",
	"meeting-backlog": "64ff6c42e3007b77b033504c",
	"meeting-discussion": "64ff6c910bfb805bf39847a8",
	"meeting-completed": "64ff6ca9223c5031bd86badf",
	"meeting-communicate": "660ff7901f70b380298b1970",
	"meeting-actions": "68427e948a34e68a8ec183aa",
} as const;

export type ListAlias = keyof typeof LIST_ALIASES;

/**
 * Lists where ALL writes are refused: create_card, move_card to/from, archive,
 * update, label changes, comments, checklist edits.
 *
 *   - Butler         (automation rules; modifying these breaks Trello workflows)
 *   - Repeater Cards (templates that spawn recurring instances elsewhere)
 */
export const FORBIDDEN_LISTS = new Set<string>([
	"59be61509a1e3922fb72ddf7", // Butler
	"59be5c3ee86b5cde2f6a5c92", // Repeater Cards
]);

/**
 * Lists that are read-only — list_cards / get_card / search work; any tool
 * that would change list membership (move_card source or destination, create_card)
 * is refused.
 *
 *   - Rolling Big Rocks (curated by Dann; the connector observes but does not touch)
 */
export const READ_ONLY_LISTS = new Set<string>([
	"5b6189409662065780670709", // Rolling Big Rocks
]);

/** Maximum number of result rows any single tool returns. Prevents runaway responses. */
export const MAX_RESULTS = 200;

/**
 * Parse a "(WIP limit N)" suffix from a list name. Returns N or null.
 * Used by guards to emit a warning when move/create would push the list over its limit.
 */
export function parseWipLimit(listName: string): number | null {
	const match = listName.match(/\(WIP limit (\d+)\)/i);
	return match ? Number(match[1]) : null;
}

/** Resolve a board key/ID to the canonical 24-char ID. */
export function resolveBoard(key: string): string {
	if (key in BOARD_ALIASES) return BOARD_ALIASES[key as BoardAlias];
	return key;
}

/** Resolve a list key/ID to the canonical 24-char ID. */
export function resolveList(key: string): string {
	if (key in LIST_ALIASES) return LIST_ALIASES[key as ListAlias];
	return key;
}

/** Reverse-lookup: given a list ID, return its alias if any. */
export function listAliasFor(id: string): ListAlias | null {
	for (const [alias, listId] of Object.entries(LIST_ALIASES)) {
		if (listId === id) return alias as ListAlias;
	}
	return null;
}

/** Reverse-lookup: given a board ID, return its alias if any. */
export function boardAliasFor(id: string): BoardAlias | null {
	for (const [alias, boardId] of Object.entries(BOARD_ALIASES)) {
		if (boardId === id) return alias as BoardAlias;
	}
	return null;
}

/**
 * Well-known Trello Power-Up (plugin) IDs. Useful for `enable_board_plugin`
 * so callers can say "custom-fields" instead of pasting a raw ID. Extend as
 * needed — every Power-Up has a stable Trello-side ID.
 */
export const PLUGIN_ALIASES = {
	"custom-fields": "56d5e249a98895a9797bebb9",
	"card-aging": "55a5d917446f517774210007",
	"voting": "55a5d914446f517774210001",
	"calendar": "55a5d915446f517774210004",
} as const;

export type PluginAlias = keyof typeof PLUGIN_ALIASES;

/** Resolve a plugin key/ID to the canonical 24-char plugin ID. */
export function resolvePlugin(key: string): string {
	if (key in PLUGIN_ALIASES) return PLUGIN_ALIASES[key as PluginAlias];
	return key;
}
