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
 *   1.20.0 (2026-07-30) — could-ssf alias. The list has existed on the board since
 *                         SSF became its own sphere; without an alias it was
 *                         unreachable by name from the tools and invisible to the
 *                         digest's Friday horizons.
 *   1.19.0 (2026-07-27) — BOARD_FIELDS / ORGANIZATION_FIELDS for workspace-aware
 *                         fetches; isTrelloId + boardShortLinkFromUrl, used by
 *                         resolve.ts to tell an ID or a pasted board URL from a
 *                         name that needs looking up. Aliases are now an
 *                         optimisation, not the only way to reach a board.
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
	"could-ssf": "6a5c9936448028b176d35b1e",
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
 * The five GTD context lists, in board order. ONE source of truth: the weekly
 * review (src/trello/tools.ts) and the daily digest (src/digest/render.ts) both
 * derive from this. Each carried its own copy until v1.22.0 — exactly how the
 * two surfaces drifted apart on what counts as actionable.
 */
export const CONTEXT_LIST_ALIASES = ["@computer", "@home", "@phone", "@errands", "@lene"] as const;

/**
 * Lists whose cards can legitimately be reported as due or overdue: the context
 * lists plus Waiting-for and Inbox. Everything else — Done-do, Butler, Repeater
 * Cards, Rolling Big Rocks, the Could-do horizons — either holds finished work
 * or is automation infrastructure, and a due date sitting on one of those is
 * noise, not a commitment.
 */
export const ACTIONABLE_LIST_IDS: ReadonlySet<string> = new Set<string>([
	...CONTEXT_LIST_ALIASES.map((a) => LIST_ALIASES[a]),
	LIST_ALIASES.waiting,
	LIST_ALIASES.inbox,
]);

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
/** Trello's Rolling Big Rocks list ID — the sole entry in READ_ONLY_LISTS. */
export const ROLLING_BIG_ROCKS_ID = "5b6189409662065780670709";

export const READ_ONLY_LISTS = new Set<string>([
	ROLLING_BIG_ROCKS_ID, // Rolling Big Rocks
]);

/** Maximum number of result rows any single tool returns. Prevents runaway responses. */
export const MAX_RESULTS = 200;

/**
 * Card `fields` query-string used by every Trello card fetch. Extracted so
 * adding/removing a field doesn't require touching 7 client methods. Order
 * doesn't matter to Trello; kept alphabetical-ish by feature clusters for
 * readability. If you add one, remember to widen the TrelloCard interface too.
 */
export const CARD_FIELDS =
	"name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos,subscribed,cover";

/**
 * Member `fields` query-string used by every Trello member fetch. Same
 * rationale as CARD_FIELDS.
 */
export const MEMBER_FIELDS = "fullName,username,initials";

/**
 * Board `fields` query-string. `idOrganization` is what makes the connector
 * workspace-aware: it is the only link from a board back to the workspace it
 * lives in, and Trello omits it unless asked. v1.19.0.
 */
export const BOARD_FIELDS = "name,url,closed,idOrganization";

/** Workspace (organization) `fields` query-string. v1.19.0. */
export const ORGANIZATION_FIELDS = "name,displayName,url";

/**
 * IANA timezone used for day-boundary math (list_cards_due today scope,
 * weekly_review_pack due_today bucket, etc.). Cloudflare Workers run in UTC,
 * so without this the day-buckets misclassify Dann's cards by up to two hours.
 */
export const DEFAULT_TIMEZONE = "Europe/Copenhagen";

/**
 * Parse a "(WIP limit N)" suffix from a list name. Returns N or null.
 * Used by guards to emit a warning when move/create would push the list over its limit.
 */
export function parseWipLimit(listName: string): number | null {
	const match = listName.match(/\(WIP limit (\d+)\)/i);
	return match ? Number(match[1]) : null;
}

/**
 * True for a raw 24-char hex Trello object ID. Used by the reference resolvers
 * to tell "this is already an ID" from "this is a name to look up". v1.19.0.
 */
export function isTrelloId(value: string): boolean {
	return /^[0-9a-f]{24}$/i.test(value.trim());
}

/**
 * Pull the short link out of a Trello board URL
 * (https://trello.com/b/xKeUkW8V/tech-retail-decision-board → xKeUkW8V).
 * Trello's REST API accepts a short link anywhere a board ID is accepted, so
 * pasting a URL from any workspace just works. Returns null for non-URLs.
 * v1.19.0.
 */
export function boardShortLinkFromUrl(value: string): string | null {
	const m = value.trim().match(/^https?:\/\/(?:www\.)?trello\.com\/b\/([A-Za-z0-9]+)/);
	return m ? m[1] : null;
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
 * The Snooze Power-Up's plugin ID (verified live against dann-to-do,
 * 2026-07-10). When a card is snoozed, the Power-Up ARCHIVES it and writes a
 * card-scoped pluginData entry with access "shared" (so our REST token can
 * read it):
 *
 *   { "snooze": { "idCard": "<cardId>", "unixTime": <wake epoch seconds> } }
 *
 * The Power-Up's own backend unarchives the card at unixTime. The shape is
 * undocumented and could change — every consumer parses it fail-soft.
 * Writing another plugin's pluginData is not possible via REST, so we can
 * read snoozes and wake cards (unarchive), but never create snoozes.
 */
export const SNOOZE_PLUGIN_ID = "58dd18bdccfca7af8311792e";

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
