/**
 * File: src/trello/client.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: Thin typed Trello REST client. Handles auth (key+token in query
 *              params), JSON encoding, error mapping, and gentle 429/5xx retry.
 *              Uses the Web Fetch API — works in Cloudflare Workers AND Node 18+,
 *              which lets us unit-test the tools without spinning up a Worker.
 *
 * Change log:
 *   1.19.0 (2026-07-27) — Multi-workspace. New TrelloOrganization type and
 *                         listMyOrganizations / getOrganization /
 *                         listOrganizationBoards. Board fetches request
 *                         idOrganization (BOARD_FIELDS) — the only link from a
 *                         board to its workspace. searchCards / searchCardsAdvanced
 *                         take workspace ids and pass them as idOrganizations,
 *                         which scopes the search server-side.
 *   1.18.0 (2026-07-27) — listCustomFields memoised per board for the client's
 *                         lifetime; all five custom-field mutations invalidate it.
 *                         v1.17.0 made every custom-field write resolve its
 *                         definition first, which turned a bulk update into an
 *                         extra GET per card. listCardsOnBoard / listCardsOnList
 *                         take { customFieldItems } like getCard already did.
 *   1.17.0 (2026-07-27) — updateCustomField now goes through retryableFetch. It
 *                         hand-builds its URL (to keep the literal slash in
 *                         Trello's `display/cardFront` key) and used to
 *                         hand-roll fetch() as well, silently opting out of the
 *                         429/5xx backoff every other call gets. getCard takes
 *                         { customFieldItems } to piggyback a card's
 *                         custom-field values onto the same request; TrelloCard
 *                         models the resulting field.
 *   1.13.0 (2026-07-10) — retryableFetch no longer retries 5xx on non-idempotent
 *                         methods (POST): a gateway 5xx can arrive after Trello
 *                         committed the write, so a retry duplicated the side
 *                         effect. 429 stays retried for every method.
 *   1.10.0 (2026-07-02) — Refactor pass surfaced by the v1.8.0 audit. Extracted
 *                         CARD_FIELDS and MEMBER_FIELDS constants (used to be
 *                         duplicated 7 and 5 times respectively). Refactored
 *                         request() + addFileAttachment to share retry logic
 *                         via new retryableFetch helper (~30 lines removed).
 *                         addComment now returns the created action so callers
 *                         don't need to read_comments to find the ID. Added
 *                         due + idMember to ChecklistItem interface (was cast-
 *                         hacked in tools.ts as ChecklistItemWithExtras).
 *                         clampLimit helper for the 4 duplicated inline clamps.
 *                         No behavior changes.
 *   1.9.0 (2026-07-02) — 5 client-layer fixes surfaced by the v1.8.0 audit:
 *                        Add getList (needed for correct move_all_cards destination
 *                        board resolution). markAllNotificationsRead drops the
 *                        broken filter=ids param (Trello's `ids` param takes
 *                        notification IDs, not type strings). updateCustomField
 *                        stops URL-encoding "display/cardFront" — the `/` in the
 *                        param key must survive verbatim or Trello ignores it.
 *                        request() Retry-After parsing accepts HTTP-date (RFC 7231)
 *                        in addition to integer seconds. batchGet handles Trello's
 *                        error-envelope shape (non-numeric keys) as 502 instead
 *                        of the previous NaN statusCode.
 *   1.8.0 (2026-07-02) — New types: TrelloCustomField, TrelloCustomFieldOption,
 *                        TrelloCustomFieldItem, TrelloReactionSummary, TrelloPlugin,
 *                        TrelloBoardPlugin. request() extended with an optional JSON
 *                        body (required for /cards/{id}/customField/{id}/item). New
 *                        methods: getLabel, getAttachment, listCommentReactionsSummary,
 *                        getAction, getActionDisplay, listCustomFields, createCustomField,
 *                        updateCustomField, deleteCustomField, addCustomFieldOption,
 *                        deleteCustomFieldOption, listCardCustomFieldItems,
 *                        setCardCustomFieldItem, listBoardPlugins, enableBoardPlugin,
 *                        disableBoardPlugin, getPlugin, batchGet, listArchivedCards.
 *   1.7.1 (2026-07-02) — Fix setCardCover: was sending `idAttachment: null` in the
 *                        cover blob whenever the caller only supplied a color, which
 *                        Trello treats as "clear the cover" and wiped the color too.
 *                        Now: only defined, non-null values reach the cover blob.
 *   1.7.0 (2026-06-13) — TrelloReaction + TrelloMembership types. New methods:
 *                        voteCard, unvoteCard, listCardVoters, addCommentReaction,
 *                        removeCommentReaction, listCommentReactions, copyChecklist,
 *                        markCardAssociatedNotificationsRead, listListActions,
 *                        listMyActions, listBoardMemberships, getMember.
 *   1.6.0 (2026-06-13) — TrelloNotification + TrelloCardCover types. TrelloCard gains
 *                        subscribed + cover. TrelloList gains pos + subscribed.
 *                        New methods: createList, updateList, moveAllCardsOnList,
 *                        archiveAllCardsOnList, setCardCover, clearCardCover,
 *                        updateChecklistItem, updateLabel, setCardSubscribed,
 *                        setListSubscribed, listNotifications, markNotificationRead,
 *                        markAllNotificationsRead.
 *   1.5.0 (2026-06-13) — New TrelloMember type. idMembers added to TrelloCard. New methods:
 *                        getMe, listBoardMembers, listCardMembers, addMemberToCard,
 *                        removeMemberFromCard, listMyAssignedCards, createChecklist,
 *                        renameChecklist, deleteChecklist, copyCard, setDueReminder,
 *                        updateComment, deleteComment. updateCard learns dueReminder.
 *   1.4.1 (2026-06-13) — Add deleteLabel (DELETE /labels/{id}) — symmetric with createLabel,
 *                        used by the delete_label tool.
 *   1.4.0 (2026-06-13) — Add start + dueReminder to TrelloCard. New types: TrelloAction,
 *                        TrelloComment. New methods: listActions, listComments, createLabel,
 *                        removeChecklistItem, convertChecklistItemToCard, setCardPosition,
 *                        setStartDate. searchCards extended with multi-board scope.
 *   1.3.0 (2026-06-12) — Add addFileAttachment (real file upload via multipart).
 *   1.0.0 (2026-06-12) — Initial.
 */

import { BOARD_FIELDS, CARD_FIELDS, MEMBER_FIELDS, ORGANIZATION_FIELDS } from "./constants";

const BASE = "https://api.trello.com/1";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/**
 * 5xx retries are limited to idempotent methods. A gateway can return 5xx
 * AFTER Trello committed the write (timeout-after-commit), so re-POSTing
 * would duplicate the side effect (double card, double comment). 429 is
 * always safe to retry — Trello rejected the request before acting on it.
 * v1.13.0 fix.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "PUT", "DELETE", "HEAD"]);
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5000;

/**
 * Clamp a caller-supplied limit into [1, max]. Used by listActions,
 * listNotifications, listListActions, listMyActions — was inlined 4× before
 * v1.10.0. Exported so unit tests can pin the contract without going through
 * a full client method.
 */
export function clampLimit(limit: number, max: number = 1000): number {
	return Math.min(Math.max(limit, 1), max);
}

/**
 * Parse a Retry-After header value into ms. Accepts:
 *   - integer seconds ("120")
 *   - HTTP-date per RFC 7231 ("Wed, 21 Oct 2026 07:28:00 GMT")
 * Falls back to exponential backoff based on `attempt` (1-indexed).
 * Result is clamped to RETRY_MAX_DELAY_MS. Exported for testing.
 */
export function parseRetryAfterMs(header: string | null, attempt: number): number {
	const fallback = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
	if (!header) return fallback;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) {
		return Math.min(Number(trimmed) * 1000, RETRY_MAX_DELAY_MS);
	}
	const t = Date.parse(trimmed);
	if (!Number.isNaN(t)) {
		return Math.max(0, Math.min(t - Date.now(), RETRY_MAX_DELAY_MS));
	}
	return fallback;
}

/** Thrown when Trello returns a non-2xx response after retries. */
export class TrelloError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(status: number, body: string, message?: string) {
		super(message ?? `Trello API error ${status}: ${body.slice(0, 200)}`);
		this.name = "TrelloError";
		this.status = status;
		this.body = body;
	}
}

/** Card cover shape — sparse object Trello exposes when a cover is set. */
export interface TrelloCardCover {
	color: string | null;
	idAttachment: string | null;
	size: "normal" | "full" | null;
	brightness: "light" | "dark" | null;
}

/** Minimal Trello card shape used across tools. */
export interface TrelloCard {
	id: string;
	name: string;
	desc: string;
	idList: string;
	idBoard: string;
	labels: { id: string; name: string; color: string }[];
	due: string | null;
	dueComplete: boolean;
	start: string | null;
	/**
	 * Minutes-before-due to fire a reminder. -1 = no reminder, 0 = at due time,
	 * 60 = 1h before, 1440 = 1d before. NOT a snooze/hide field — Trello has
	 * no native snooze in its REST API; that's a Power-Up concern.
	 */
	dueReminder: number | null;
	idMembers: string[];
	url: string;
	dateLastActivity: string;
	closed: boolean;
	pos?: number;
	subscribed?: boolean;
	cover?: Partial<TrelloCardCover>;
	/** Present only on fetches that pass pluginData=true (see listArchivedCardsWithPluginData). */
	pluginData?: TrelloPluginData[];
	/** Present only on fetches that pass customFieldItems=true (see getCard). */
	customFieldItems?: TrelloCustomFieldItem[];
	/** Present on archived-card fetches. */
	dateClosed?: string | null;
}

/** A Power-Up's per-model data blob. `value` is a JSON string in a plugin-defined shape. */
export interface TrelloPluginData {
	id: string;
	idPlugin: string;
	scope: string;
	idModel: string;
	value: string;
	access: string;
	dateLastUpdated: string;
}

/** Minimal Trello member shape. */
export interface TrelloMember {
	id: string;
	fullName: string;
	username: string;
	initials: string;
}

/**
 * Custom Fields — Power-Up primitive. Types: "checkbox", "date", "list",
 * "number", "text". `options` is present only for "list" type. `modelType`
 * is always "board" in practice (that's where custom-field defs live).
 */
export interface TrelloCustomField {
	id: string;
	idModel: string;
	modelType: string;
	fieldGroup?: string;
	name: string;
	pos: number;
	type: "checkbox" | "date" | "list" | "number" | "text";
	options?: TrelloCustomFieldOption[];
	display?: { cardFront?: boolean };
}

export interface TrelloCustomFieldOption {
	id: string;
	idCustomField: string;
	value: { text?: string };
	color?: string;
	pos: number;
}

/**
 * Per-card custom-field value. Exactly one of `idValue` (list-type field
 * references its selected option) or `value` (all other types carry their
 * data inside `value`) will be populated.
 */
export interface TrelloCustomFieldItem {
	id: string;
	idCustomField: string;
	idModel: string;
	modelType: string;
	idValue?: string;
	value?: {
		checked?: string; // Trello returns "true" / "false" as strings
		date?: string;
		number?: string;
		text?: string;
	};
}

/** Reactions-summary row (grouped by emoji, with member reactions). */
export interface TrelloReactionSummary {
	count: number;
	firstReacted: string;
	id: string;
	idEmoji: string;
	idModel: string;
	idReaction: string;
	emoji: {
		shortName: string;
		native?: string;
		name?: string;
		unified?: string;
	};
}

/** Metadata about a Power-Up. */
export interface TrelloPlugin {
	id: string;
	name: string;
	url?: string;
	iconUrl?: string;
	author?: string;
	tags?: string[];
	claimedDomains?: string[];
	public?: boolean;
	listing?: { name?: string; description?: string; overview?: string; locale?: string };
	privacyUrl?: string;
	supportEmail?: string;
}

/** A Power-Up enabled on a particular board. `id` is what disable takes. */
export interface TrelloBoardPlugin {
	id: string;
	idBoard: string;
	idPlugin: string;
}

/**
 * Reaction shape from /actions/{id}/reactions. `emoji.shortName` is the
 * portable identifier (e.g. "thumbsup", "white_check_mark", "heart").
 */
export interface TrelloReaction {
	id: string;
	idMember: string;
	idModel: string;
	idEmoji: string;
	member: { id: string; fullName: string; username: string } | null;
	emoji: {
		shortName: string;
		native?: string;
		name?: string;
		unified?: string;
		skinVariation?: string;
	};
}

/**
 * Board membership shape — richer than the flat `TrelloMember` list. Each row
 * carries a memberType (admin / normal / observer / virtual) and confirmation
 * state. Use this when you need to distinguish board roles.
 */
export interface TrelloMembership {
	id: string;
	idMember: string;
	memberType: "admin" | "normal" | "observer" | "virtual" | string;
	unconfirmed: boolean;
	deactivated: boolean;
	member?: { id: string; fullName: string; username: string };
}

/**
 * Notification shape from /members/me/notifications. The `data` blob varies by
 * type — keep it untyped so callers can drill in. Common types include
 * "mentionedOnCard", "cardDueSoon", "addedToCard", "addAttachmentToCard",
 * "commentCard", "changeCard" (move/due), "removedFromCard".
 */
export interface TrelloNotification {
	id: string;
	type: string;
	date: string;
	unread: boolean;
	idMemberCreator: string | null;
	data: {
		text?: string;
		card?: { id: string; name: string; idShort?: number; shortLink?: string };
		board?: { id: string; name: string; shortLink?: string };
		list?: { id: string; name: string };
		listAfter?: { id: string; name: string };
		listBefore?: { id: string; name: string };
		[k: string]: unknown;
	};
}

/** Minimal list shape. */
export interface TrelloList {
	id: string;
	name: string;
	idBoard: string;
	closed: boolean;
	pos?: number;
	subscribed?: boolean;
}

/**
 * Minimal board shape. `idOrganization` is the workspace the board lives in —
 * null/absent for a board that sits directly under the member's personal
 * space. Every board fetch requests it (v1.19.0) so multi-workspace callers
 * can group and scope without a second round trip.
 */
export interface TrelloBoard {
	id: string;
	name: string;
	url: string;
	closed: boolean;
	idOrganization?: string | null;
}

/**
 * A Trello workspace (the API still calls it an "organization"). `name` is the
 * URL-safe short name (e.g. "frontlinetech"), `displayName` the human one
 * (e.g. "Frontline Tech"). Both are accepted wherever a tool takes a
 * `workspace` argument. v1.19.0.
 */
export interface TrelloOrganization {
	id: string;
	name: string;
	displayName: string;
	url: string;
}

/** Minimal label shape. */
export interface TrelloLabel {
	id: string;
	name: string;
	color: string;
	idBoard: string;
}

/**
 * Minimal checklist item shape. `due` and `idMember` are populated only when
 * the item has them set (v1.6.0 checklist-item due dates + member assignment).
 * Before v1.10.0 these were shoehorned via a private ChecklistItemWithExtras
 * cast in tools.ts.
 */
export interface ChecklistItem {
	id: string;
	name: string;
	state: "complete" | "incomplete";
	pos: number;
	idChecklist: string;
	due?: string | null;
	idMember?: string | null;
}

/** Minimal checklist shape. */
export interface Checklist {
	id: string;
	name: string;
	idCard: string;
	checkItems: ChecklistItem[];
}

/** Minimal attachment shape. */
export interface TrelloAttachment {
	id: string;
	name: string;
	url: string;
	date: string;
	bytes: number | null;
	mimeType: string | null;
}

/**
 * A single action entry from /cards/{id}/actions. Trello's action shapes vary
 * by `type` — we keep `data` as untyped JSON and let callers cherry-pick.
 */
export interface TrelloAction {
	id: string;
	type: string;
	date: string;
	memberCreator: { id: string; fullName: string; username: string } | null;
	data: Record<string, unknown>;
}

/** Convenience shape for comment actions (filter=commentCard). */
export interface TrelloComment {
	id: string;
	text: string;
	date: string;
	author: { id: string; fullName: string; username: string } | null;
}

/**
 * Trello client. Construct once per request/session with the user's key+token.
 * Do not log the instance — `key` and `token` would leak.
 */
export class TrelloClient {
	private readonly key: string;
	private readonly token: string;

	constructor(key: string, token: string) {
		this.key = key;
		this.token = token;
	}

	/** Internal: build the URL with auth params merged in. */
	private url(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
		const u = new URL(`${BASE}${path}`);
		u.searchParams.set("key", this.key);
		u.searchParams.set("token", this.token);
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
		}
		return u.toString();
	}

	/**
	 * Shared retry loop for every Trello HTTP call. `initFactory` is called
	 * fresh on each attempt so single-shot bodies (multipart FormData with
	 * Blobs) can be rebuilt without duplicating this whole loop. Throws
	 * TrelloError on the last failure. v1.10.0 refactor.
	 */
	private async retryableFetch(
		url: string,
		initFactory: () => RequestInit | Promise<RequestInit>,
	): Promise<Response> {
		let attempt = 0;
		while (true) {
			attempt += 1;
			const init = await initFactory();
			const resp = await fetch(url, init);
			if (resp.ok) return resp;
			const method = (init.method ?? "GET").toUpperCase();
			const retriable =
				resp.status === 429 || (RETRY_STATUSES.has(resp.status) && IDEMPOTENT_METHODS.has(method));
			if (retriable && attempt < RETRY_MAX_ATTEMPTS) {
				const delayMs = parseRetryAfterMs(resp.headers.get("Retry-After"), attempt);
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}
			const respBody = await resp.text();
			throw new TrelloError(resp.status, respBody);
		}
	}

	/**
	 * Internal: JSON-flavoured request with retry on 429 + transient 5xx.
	 * `body` is optional — when supplied, it's JSON-encoded and sent as the
	 * request body (with Content-Type: application/json). Auth still travels
	 * on the query string. For multipart, use retryableFetch directly (see
	 * addFileAttachment).
	 */
	private async request(
		method: string,
		path: string,
		params: Record<string, string | number | boolean | undefined> = {},
		body?: unknown,
	): Promise<unknown> {
		const resp = await this.retryableFetch(this.url(path, params), () => {
			const init: RequestInit = {
				method,
				headers: { Accept: "application/json" },
			};
			if (body !== undefined) {
				(init.headers as Record<string, string>)["Content-Type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			return init;
		});
		// 204 No Content (rare for Trello) → return null
		const ct = resp.headers.get("content-type") ?? "";
		return ct.includes("application/json") ? await resp.json() : null;
	}

	// ---- Members ----

	/** The authenticated user. Useful for resolving "me" in list_my_cards_assigned. */
	async getMe(): Promise<TrelloMember> {
		const data = await this.request("GET", "/members/me", {
			fields: MEMBER_FIELDS,
		});
		return data as TrelloMember;
	}

	async listBoardMembers(boardId: string): Promise<TrelloMember[]> {
		const data = await this.request("GET", `/boards/${boardId}/members`, {
			fields: MEMBER_FIELDS,
		});
		return data as TrelloMember[];
	}

	async listCardMembers(cardId: string): Promise<TrelloMember[]> {
		const data = await this.request("GET", `/cards/${cardId}/members`, {
			fields: MEMBER_FIELDS,
		});
		return data as TrelloMember[];
	}

	async addMemberToCard(cardId: string, memberId: string): Promise<void> {
		await this.request("POST", `/cards/${cardId}/idMembers`, { value: memberId });
	}

	async removeMemberFromCard(cardId: string, memberId: string): Promise<void> {
		await this.request("DELETE", `/cards/${cardId}/idMembers/${memberId}`);
	}

	/**
	 * Cards where the authenticated user is a member. Trello's /members/me/cards
	 * is cross-board and respects board membership — perfect for "my dashboard".
	 */
	async listMyAssignedCards(): Promise<TrelloCard[]> {
		const data = await this.request("GET", "/members/me/cards", {
			filter: "open",
			fields: CARD_FIELDS,
		});
		return data as TrelloCard[];
	}

	// ---- Boards ----

	async listMyBoards(): Promise<TrelloBoard[]> {
		const data = await this.request("GET", "/members/me/boards", {
			fields: BOARD_FIELDS,
			filter: "open",
		});
		return data as TrelloBoard[];
	}

	async getBoard(boardId: string): Promise<TrelloBoard> {
		const data = await this.request("GET", `/boards/${boardId}`, {
			fields: BOARD_FIELDS,
		});
		return data as TrelloBoard;
	}

	// ---- Workspaces (Trello calls them organizations) ----

	/**
	 * Every workspace the authenticated member belongs to. Boards that sit
	 * outside any workspace (personal boards) have idOrganization null and are
	 * therefore not represented here — group by board, not by this list, when
	 * you need full coverage. v1.19.0.
	 */
	async listMyOrganizations(): Promise<TrelloOrganization[]> {
		const data = await this.request("GET", "/members/me/organizations", {
			fields: ORGANIZATION_FIELDS,
		});
		return data as TrelloOrganization[];
	}

	/** One workspace by ID or short name. */
	async getOrganization(idOrName: string): Promise<TrelloOrganization> {
		const data = await this.request("GET", `/organizations/${idOrName}`, {
			fields: ORGANIZATION_FIELDS,
		});
		return data as TrelloOrganization;
	}

	/**
	 * Open boards in one workspace. Note this returns boards the member can see
	 * in that workspace, which for an admin can exceed their own board
	 * membership — resolution paths intersect it with listMyBoards.
	 */
	async listOrganizationBoards(orgId: string): Promise<TrelloBoard[]> {
		const data = await this.request("GET", `/organizations/${orgId}/boards`, {
			fields: BOARD_FIELDS,
			filter: "open",
		});
		return data as TrelloBoard[];
	}

	// ---- Lists ----

	async listListsOnBoard(boardId: string): Promise<TrelloList[]> {
		const data = await this.request("GET", `/boards/${boardId}/lists`, {
			fields: "name,idBoard,closed,pos,subscribed",
		});
		return data as TrelloList[];
	}

	/**
	 * Fetch a single list directly by ID. Used by move_all_cards to derive the
	 * destination list's board without probing cards (which is wrong when the
	 * destination is empty or on a different board).
	 */
	async getList(listId: string): Promise<TrelloList> {
		const data = await this.request("GET", `/lists/${listId}`, {
			fields: "name,idBoard,closed,pos,subscribed",
		});
		return data as TrelloList;
	}

	/** Create a new list on a board. `pos` is "top", "bottom", or numeric. */
	async createList(input: {
		boardId: string;
		name: string;
		pos?: string | number;
	}): Promise<TrelloList> {
		const params: Record<string, string | number> = {
			idBoard: input.boardId,
			name: input.name,
		};
		if (input.pos !== undefined) params.pos = input.pos;
		const data = await this.request("POST", "/lists", params);
		return data as TrelloList;
	}

	/**
	 * Update a list. Each field is optional.
	 *   name        — rename
	 *   closed      — archive (true) / unarchive (false)
	 *   pos         — reorder ("top" / "bottom" / number)
	 *   idBoard     — move the list (with its cards) to another board
	 *   subscribed  — watch / unwatch
	 */
	async updateList(listId: string, input: {
		name?: string;
		closed?: boolean;
		pos?: string | number;
		idBoard?: string;
		subscribed?: boolean;
	}): Promise<TrelloList> {
		const params: Record<string, string | number | boolean | undefined> = {};
		if (input.name !== undefined) params.name = input.name;
		if (input.closed !== undefined) params.closed = input.closed;
		if (input.pos !== undefined) params.pos = input.pos;
		if (input.idBoard !== undefined) params.idBoard = input.idBoard;
		if (input.subscribed !== undefined) params.subscribed = input.subscribed;
		const data = await this.request("PUT", `/lists/${listId}`, params);
		return data as TrelloList;
	}

	/** Move every card on one list to another list. */
	async moveAllCardsOnList(sourceListId: string, targetListId: string, targetBoardId: string): Promise<void> {
		await this.request("POST", `/lists/${sourceListId}/moveAllCards`, {
			idBoard: targetBoardId,
			idList: targetListId,
		});
	}

	/** Archive every card on a list (closed=true on each). */
	async archiveAllCardsOnList(listId: string): Promise<void> {
		await this.request("POST", `/lists/${listId}/archiveAllCards`);
	}

	/** Set / unset the watch flag on a list. */
	async setListSubscribed(listId: string, subscribed: boolean): Promise<TrelloList> {
		return this.updateList(listId, { subscribed });
	}

	// ---- Labels ----

	async listLabelsOnBoard(boardId: string): Promise<TrelloLabel[]> {
		const data = await this.request("GET", `/boards/${boardId}/labels`, {
			fields: "name,color,idBoard",
			limit: 1000,
		});
		return data as TrelloLabel[];
	}

	// ---- Cards ----

	async listCardsOnList(
		listId: string,
		opts: { customFieldItems?: boolean } = {},
	): Promise<TrelloCard[]> {
		const params: Record<string, string | number | boolean | undefined> = {
			fields: CARD_FIELDS,
		};
		if (opts.customFieldItems) params.customFieldItems = true;
		const data = await this.request("GET", `/lists/${listId}/cards`, params);
		return data as TrelloCard[];
	}

	async listCardsOnBoard(
		boardId: string,
		opts: { customFieldItems?: boolean } = {},
	): Promise<TrelloCard[]> {
		const params: Record<string, string | number | boolean | undefined> = {
			fields: CARD_FIELDS,
		};
		if (opts.customFieldItems) params.customFieldItems = true;
		const data = await this.request("GET", `/boards/${boardId}/cards`, params);
		return data as TrelloCard[];
	}

	/**
	 * Archived (closed) cards WITH their Power-Up pluginData inline — one call.
	 * Used by the snooze reads: the Snooze Power-Up archives snoozed cards and
	 * stores the wake time in card-scoped pluginData. v1.15.0.
	 */
	async listArchivedCardsWithPluginData(boardId: string): Promise<TrelloCard[]> {
		const data = await this.request("GET", `/boards/${boardId}/cards`, {
			fields: CARD_FIELDS,
			filter: "closed",
			pluginData: true,
		});
		return data as TrelloCard[];
	}

	/** Unarchive a card (closed=false) — it returns to its original list. The wake primitive. */
	async unarchiveCard(cardId: string): Promise<TrelloCard> {
		return this.updateCard(cardId, { closed: false });
	}

	/** One card WITH its pluginData — used by wake_card to verify a card is Power-Up-snoozed. */
	async getCardWithPluginData(cardId: string): Promise<TrelloCard> {
		const data = await this.request("GET", `/cards/${cardId}`, {
			fields: CARD_FIELDS,
			pluginData: true,
		});
		return data as TrelloCard;
	}

	async searchCards(query: string, boardId?: string, orgId?: string): Promise<TrelloCard[]> {
		const params: Record<string, string | number | boolean | undefined> = {
			query,
			modelTypes: "cards",
			card_fields: CARD_FIELDS,
			cards_limit: 50,
			partial: true,
		};
		if (boardId) params.idBoards = boardId;
		// Trello scopes /search by workspace natively — cheaper and more complete
		// than fetching the workspace's boards and passing idBoards. v1.19.0.
		if (orgId) params.idOrganizations = orgId;
		const data = await this.request("GET", "/search", params);
		const { cards = [] } = data as { cards?: TrelloCard[] };
		return cards;
	}

	/**
	 * Advanced search. Trello's /search endpoint understands operators inside the
	 * query string: `due:day`, `due:overdue`, `label:red`, `list:"Inbox"`,
	 * `has:attachments`, `description:"foo"`, `is:archived`, etc.
	 * This wrapper just exposes the multi-board scope + tunable limit.
	 */
	async searchCardsAdvanced(input: {
		query: string;
		boardIds?: string[];
		orgIds?: string[];
		cardsLimit?: number;
	}): Promise<TrelloCard[]> {
		const params: Record<string, string | number | boolean | undefined> = {
			query: input.query,
			modelTypes: "cards",
			card_fields: CARD_FIELDS,
			cards_limit: Math.min(input.cardsLimit ?? 50, 1000),
			partial: true,
		};
		if (input.boardIds && input.boardIds.length) params.idBoards = input.boardIds.join(",");
		if (input.orgIds && input.orgIds.length) params.idOrganizations = input.orgIds.join(",");
		const data = await this.request("GET", "/search", params);
		const { cards = [] } = data as { cards?: TrelloCard[] };
		return cards;
	}

	/**
	 * `customFieldItems` piggybacks the card's custom-field values onto the same
	 * request — no extra round trip. Trello omits items for fields that have
	 * never been set, so an absent field means "unset", not "undefined field".
	 */
	async getCard(cardId: string, opts: { customFieldItems?: boolean } = {}): Promise<TrelloCard> {
		const params: Record<string, string | number | boolean | undefined> = {
			fields: CARD_FIELDS,
		};
		if (opts.customFieldItems) params.customFieldItems = true;
		const data = await this.request("GET", `/cards/${cardId}`, params);
		return data as TrelloCard;
	}

	async createCard(input: {
		idList: string;
		name: string;
		desc?: string;
		due?: string;
		idLabels?: string[];
	}): Promise<TrelloCard> {
		const params: Record<string, string | number | boolean | undefined> = {
			idList: input.idList,
			name: input.name,
		};
		if (input.desc) params.desc = input.desc;
		if (input.due) params.due = input.due;
		if (input.idLabels && input.idLabels.length) params.idLabels = input.idLabels.join(",");
		const data = await this.request("POST", "/cards", params);
		return data as TrelloCard;
	}

	async updateCard(cardId: string, input: {
		name?: string;
		desc?: string;
		due?: string | null;
		start?: string | null;
		idList?: string;
		closed?: boolean;
		dueComplete?: boolean;
		pos?: string | number;
		dueReminder?: number | null;
		subscribed?: boolean;
		/** JSON-stringified cover object (or "" to clear). */
		cover?: string;
	}): Promise<TrelloCard> {
		const params: Record<string, string | number | boolean | undefined> = {};
		if (input.name !== undefined) params.name = input.name;
		if (input.desc !== undefined) params.desc = input.desc;
		if (input.due !== undefined) params.due = input.due ?? "";
		if (input.start !== undefined) params.start = input.start ?? "";
		if (input.idList !== undefined) params.idList = input.idList;
		if (input.closed !== undefined) params.closed = input.closed;
		if (input.dueComplete !== undefined) params.dueComplete = input.dueComplete;
		if (input.pos !== undefined) params.pos = input.pos;
		// dueReminder: -1 = no reminder. We forward exactly what the caller asks.
		if (input.dueReminder !== undefined) params.dueReminder = input.dueReminder ?? -1;
		if (input.subscribed !== undefined) params.subscribed = input.subscribed;
		if (input.cover !== undefined) params.cover = input.cover;
		const data = await this.request("PUT", `/cards/${cardId}`, params);
		return data as TrelloCard;
	}

	async archiveCard(cardId: string): Promise<TrelloCard> {
		return this.updateCard(cardId, { closed: true });
	}

	async setDueComplete(cardId: string, complete: boolean): Promise<TrelloCard> {
		return this.updateCard(cardId, { dueComplete: complete });
	}

	async moveCard(cardId: string, listId: string): Promise<TrelloCard> {
		return this.updateCard(cardId, { idList: listId });
	}

	/** Set card position. Accepts "top", "bottom", or a numeric position. */
	async setCardPosition(cardId: string, pos: string | number): Promise<TrelloCard> {
		return this.updateCard(cardId, { pos });
	}

	/** Set the start date (or pass null to clear it). */
	async setStartDate(cardId: string, start: string | null): Promise<TrelloCard> {
		return this.updateCard(cardId, { start });
	}

	/**
	 * Set the reminder offset. `minutes` is "fire this many minutes before due".
	 * 0 = at due time. Pass null to clear (sent as -1 to Trello).
	 */
	async setDueReminder(cardId: string, minutes: number | null): Promise<TrelloCard> {
		return this.updateCard(cardId, { dueReminder: minutes });
	}

	/** Set or unset the watch/subscribe flag on a card. */
	async setCardSubscribed(cardId: string, subscribed: boolean): Promise<TrelloCard> {
		return this.updateCard(cardId, { subscribed });
	}

	/**
	 * Set a cover. Either a palette color or an attachment id (or both — Trello
	 * uses the attachment if present). `size` ∈ "normal" | "full"; `brightness`
	 * ∈ "light" | "dark" (only meaningful for color covers).
	 *
	 * IMPORTANT: fields that are undefined OR null are omitted from the cover
	 * blob entirely. Trello treats an explicit `null` in the blob as "clear
	 * this facet", and if you send `{"color":"purple","idAttachment":null}`
	 * the null wins and the color never sticks. Only real values reach Trello.
	 * Use clearCardCover() to strip an existing cover.
	 */
	async setCardCover(
		cardId: string,
		input: {
			color?: string | null;
			idAttachment?: string | null;
			size?: "normal" | "full";
			brightness?: "light" | "dark";
		},
	): Promise<TrelloCard> {
		const cover: Record<string, unknown> = {};
		if (input.color !== undefined && input.color !== null) cover.color = input.color;
		if (input.idAttachment !== undefined && input.idAttachment !== null) {
			cover.idAttachment = input.idAttachment;
		}
		if (input.size !== undefined) cover.size = input.size;
		if (input.brightness !== undefined) cover.brightness = input.brightness;
		return this.updateCard(cardId, { cover: JSON.stringify(cover) });
	}

	/**
	 * Clear the cover entirely (color + attachment + size + brightness).
	 * Trello accepts an empty object or explicit nulls; the empty object is
	 * the least surprising.
	 */
	async clearCardCover(cardId: string): Promise<TrelloCard> {
		return this.updateCard(cardId, { cover: JSON.stringify({}) });
	}

	/**
	 * Copy a card to a target list. `keepFromSource` is comma-separated of:
	 * attachments,checklists,comments,due,start,labels,members,stickers — or "all".
	 * Defaults to "all" so the duplicate mirrors the source.
	 */
	async copyCard(input: {
		sourceCardId: string;
		idList: string;
		name?: string;
		keepFromSource?: string;
		pos?: string | number;
	}): Promise<TrelloCard> {
		const params: Record<string, string | number | undefined> = {
			idCardSource: input.sourceCardId,
			idList: input.idList,
			keepFromSource: input.keepFromSource ?? "all",
		};
		if (input.name !== undefined) params.name = input.name;
		if (input.pos !== undefined) params.pos = input.pos;
		const data = await this.request("POST", "/cards", params);
		return data as TrelloCard;
	}

	// ---- Labels on cards ----

	async addLabelToCard(cardId: string, labelId: string): Promise<void> {
		await this.request("POST", `/cards/${cardId}/idLabels`, { value: labelId });
	}

	async removeLabelFromCard(cardId: string, labelId: string): Promise<void> {
		await this.request("DELETE", `/cards/${cardId}/idLabels/${labelId}`);
	}

	/**
	 * Create a new label on a board. Color must be one of Trello's known
	 * palette tokens (yellow, purple, blue, red, green, orange, black, sky,
	 * pink, lime) or null/empty for "no color".
	 */
	async createLabel(boardId: string, name: string, color?: string | null): Promise<TrelloLabel> {
		const params: Record<string, string> = { name, idBoard: boardId };
		params.color = color === null || color === undefined ? "" : color;
		const data = await this.request("POST", "/labels", params);
		return data as TrelloLabel;
	}

	/**
	 * Delete a label outright. Board-wide, destructive — removes the label
	 * from every card that carries it. Recovery requires recreating the label
	 * and re-applying it everywhere.
	 */
	async deleteLabel(labelId: string): Promise<void> {
		await this.request("DELETE", `/labels/${labelId}`);
	}

	/**
	 * Rename or recolor a label. Empty-string color clears the color (Trello's
	 * "no color" state). Either field is optional.
	 */
	async updateLabel(labelId: string, input: { name?: string; color?: string | null }): Promise<TrelloLabel> {
		const params: Record<string, string> = {};
		if (input.name !== undefined) params.name = input.name;
		if (input.color !== undefined) params.color = input.color === null ? "" : input.color;
		const data = await this.request("PUT", `/labels/${labelId}`, params);
		return data as TrelloLabel;
	}

	// ---- Voting ----

	/** Cast a vote on a card as the given member (or "me" for self). */
	async voteCard(cardId: string, memberId: string = "me"): Promise<void> {
		await this.request("POST", `/cards/${cardId}/membersVoted`, { value: memberId });
	}

	/** Remove a member's vote from a card. */
	async unvoteCard(cardId: string, memberId: string): Promise<void> {
		await this.request("DELETE", `/cards/${cardId}/membersVoted/${memberId}`);
	}

	/** Members who have voted on a card. */
	async listCardVoters(cardId: string): Promise<TrelloMember[]> {
		const data = await this.request("GET", `/cards/${cardId}/membersVoted`, {
			fields: MEMBER_FIELDS,
		});
		return data as TrelloMember[];
	}

	// ---- Reactions on comments (actions) ----

	/**
	 * Add an emoji reaction to a comment (Trello stores comments as actions, so
	 * reactions live on the action id). `shortName` is the portable identifier:
	 * "thumbsup", "white_check_mark", "heart", "eyes", "raised_hands", etc.
	 */
	async addCommentReaction(actionId: string, shortName: string): Promise<TrelloReaction> {
		const data = await this.request("POST", `/actions/${actionId}/reactions`, {
			shortName,
		});
		return data as TrelloReaction;
	}

	async removeCommentReaction(actionId: string, reactionId: string): Promise<void> {
		await this.request("DELETE", `/actions/${actionId}/reactions/${reactionId}`);
	}

	async listCommentReactions(actionId: string): Promise<TrelloReaction[]> {
		const data = await this.request("GET", `/actions/${actionId}/reactions`);
		return data as TrelloReaction[];
	}

	// ---- Comments ----

	/**
	 * Post a comment on a card. v1.10.0 change: returns the created action so
	 * downstream tools (update_comment / delete_comment / add_comment_reaction)
	 * can act on it without re-fetching via read_comments.
	 */
	async addComment(cardId: string, text: string): Promise<TrelloAction> {
		const data = await this.request("POST", `/cards/${cardId}/actions/comments`, { text });
		return data as TrelloAction;
	}

	/** Edit an existing comment (Trello stores comments as actions). */
	async updateComment(actionId: string, text: string): Promise<TrelloAction> {
		const data = await this.request("PUT", `/actions/${actionId}`, { text });
		return data as TrelloAction;
	}

	/** Delete an existing comment by its action id. */
	async deleteComment(actionId: string): Promise<void> {
		await this.request("DELETE", `/actions/${actionId}`);
	}

	// ---- Checklists ----

	async listChecklistsOnCard(cardId: string): Promise<Checklist[]> {
		const data = await this.request("GET", `/cards/${cardId}/checklists`, {
			fields: "name,idCard",
			checkItem_fields: "name,state,pos,idChecklist",
		});
		return data as Checklist[];
	}

	/** Create a new checklist on a card with an explicit name. */
	async createChecklist(cardId: string, name: string): Promise<Checklist> {
		const data = await this.request("POST", `/cards/${cardId}/checklists`, { name });
		return data as Checklist;
	}

	/**
	 * Copy an existing checklist (with all its items) onto a target card.
	 * Trello supports `idChecklistSource` on the create endpoint. Optional
	 * `name` overrides the copy's title; `pos` sets initial position.
	 */
	async copyChecklist(input: {
		targetCardId: string;
		sourceChecklistId: string;
		name?: string;
		pos?: string | number;
	}): Promise<Checklist> {
		const params: Record<string, string | number | undefined> = {
			idChecklistSource: input.sourceChecklistId,
		};
		if (input.name !== undefined) params.name = input.name;
		if (input.pos !== undefined) params.pos = input.pos;
		const data = await this.request("POST", `/cards/${input.targetCardId}/checklists`, params);
		return data as Checklist;
	}

	/** Rename a checklist (the PUT response includes the updated shape). */
	async renameChecklist(checklistId: string, name: string): Promise<Checklist> {
		const data = await this.request("PUT", `/checklists/${checklistId}`, { name });
		return data as Checklist;
	}

	/** Delete a checklist outright (removes all its items). */
	async deleteChecklist(checklistId: string): Promise<void> {
		await this.request("DELETE", `/checklists/${checklistId}`);
	}

	/**
	 * Add a checklist item. If the card has no checklist yet, this creates one
	 * named "Checklist" and adds the item to it.
	 */
	async addChecklistItem(cardId: string, text: string): Promise<ChecklistItem> {
		const existing = await this.listChecklistsOnCard(cardId);
		let checklistId: string;
		if (existing.length === 0) {
			const created = await this.request("POST", `/cards/${cardId}/checklists`, {
				name: "Checklist",
			});
			checklistId = (created as { id: string }).id;
		} else {
			checklistId = existing[0].id;
		}
		const item = await this.request("POST", `/checklists/${checklistId}/checkItems`, {
			name: text,
		});
		return item as ChecklistItem;
	}

	/** Tick / untick a single checklist item. */
	async setChecklistItemState(
		cardId: string,
		itemId: string,
		complete: boolean,
	): Promise<ChecklistItem> {
		const data = await this.request("PUT", `/cards/${cardId}/checkItem/${itemId}`, {
			state: complete ? "complete" : "incomplete",
		});
		return data as ChecklistItem;
	}

	/**
	 * Update any subset of fields on a checklist item: name, state, due
	 * (ISO 8601 string or null), idMember (assignee, or null to clear), pos
	 * ("top" / "bottom" / number). Trello's single endpoint handles all of
	 * these via PUT /cards/{idCard}/checkItem/{idCheckItem}.
	 */
	async updateChecklistItem(
		cardId: string,
		itemId: string,
		input: {
			name?: string;
			state?: "complete" | "incomplete";
			due?: string | null;
			idMember?: string | null;
			pos?: string | number;
		},
	): Promise<ChecklistItem> {
		const params: Record<string, string | number | undefined> = {};
		if (input.name !== undefined) params.name = input.name;
		if (input.state !== undefined) params.state = input.state;
		if (input.due !== undefined) params.due = input.due ?? "";
		if (input.idMember !== undefined) params.idMember = input.idMember ?? "";
		if (input.pos !== undefined) params.pos = input.pos;
		const data = await this.request("PUT", `/cards/${cardId}/checkItem/${itemId}`, params);
		return data as ChecklistItem;
	}

	/** Remove a single checklist item from a checklist. */
	async removeChecklistItem(checklistId: string, itemId: string): Promise<void> {
		await this.request("DELETE", `/checklists/${checklistId}/checkItems/${itemId}`);
	}

	/**
	 * Convert a checklist item to a standalone card. Trello creates the new
	 * card on the SAME list as the source card. The item is automatically
	 * removed from the checklist. Returns the new card.
	 */
	async convertChecklistItemToCard(
		cardId: string,
		checklistId: string,
		itemId: string,
	): Promise<TrelloCard> {
		const data = await this.request(
			"POST",
			`/cards/${cardId}/checklist/${checklistId}/checkItem/${itemId}/convertToCard`,
		);
		return data as TrelloCard;
	}

	// ---- Attachments (URL-based) ----

	async listAttachments(cardId: string): Promise<TrelloAttachment[]> {
		const data = await this.request("GET", `/cards/${cardId}/attachments`, {
			fields: "id,name,url,date,bytes,mimeType",
		});
		return data as TrelloAttachment[];
	}

	async addAttachment(
		cardId: string,
		input: { url: string; name?: string },
	): Promise<TrelloAttachment> {
		const params: Record<string, string> = { url: input.url };
		if (input.name) params.name = input.name;
		const data = await this.request("POST", `/cards/${cardId}/attachments`, params);
		return data as TrelloAttachment;
	}

	/**
	 * Upload a real file as a card attachment. `bytes` is the raw file payload
	 * (the tool layer decodes base64 from the caller's input). Posts
	 * multipart/form-data with the standard `file` field name. Auth stays on
	 * the query string so we don't have to mix it into the form body.
	 *
	 * Retries 429/5xx the same way request() does, but with the form rebuilt
	 * each attempt (Blobs are single-shot).
	 */
	async addFileAttachment(
		cardId: string,
		input: { bytes: Uint8Array; filename: string; mimeType?: string },
	): Promise<TrelloAttachment> {
		const u = new URL(`${BASE}/cards/${cardId}/attachments`);
		u.searchParams.set("key", this.key);
		u.searchParams.set("token", this.token);

		// v1.10.0: shares the retry loop with request() via retryableFetch.
		// The FormData is rebuilt on each attempt because Blobs can't be
		// re-read after a network-consumed body.
		const resp = await this.retryableFetch(u.toString(), () => {
			const form = new FormData();
			form.append("name", input.filename);
			form.append(
				"file",
				new Blob([input.bytes], { type: input.mimeType ?? "application/octet-stream" }),
				input.filename,
			);
			return { method: "POST", body: form };
		});
		const ct = resp.headers.get("content-type") ?? "";
		return (ct.includes("application/json") ? await resp.json() : null) as TrelloAttachment;
	}

	async removeAttachment(cardId: string, attachmentId: string): Promise<void> {
		await this.request("DELETE", `/cards/${cardId}/attachments/${attachmentId}`);
	}

	// ---- Actions / activity log / comments ----

	/**
	 * Read actions on a card. `filter` is a Trello action-type filter string;
	 * common values: "all", "commentCard",
	 * "moveCardFromBoard,moveCardToBoard,updateCard:idList,updateCard:due,addLabelToCard,
	 *  removeLabelFromCard,commentCard,addAttachmentToCard,deleteAttachmentFromCard,
	 *  convertToCardFromCheckItem,addChecklistToCard,updateCheckItemStateOnCard".
	 * Trello caps `limit` at 1000.
	 */
	async listActions(cardId: string, filter = "all", limit = 50): Promise<TrelloAction[]> {
		const data = await this.request("GET", `/cards/${cardId}/actions`, {
			filter,
			limit: clampLimit(limit),
		});
		return data as TrelloAction[];
	}

	// ---- Notifications ----

	/**
	 * Read the authenticated user's notification feed. `filter` is a comma-
	 * separated Trello notification-type filter — common values: "all",
	 * "mentionedOnCard", "cardDueSoon", "addedToCard", "commentCard",
	 * "changeCard", "addAttachmentToCard". `read` controls read/unread filter:
	 * "all" | "read" | "unread".
	 *
	 * NOTE: `since` / `before` are notification IDs, NOT dates — Trello uses
	 * cursor pagination here, not time-window queries.
	 */
	async listNotifications(input: {
		filter?: string;
		readFilter?: "all" | "read" | "unread";
		limit?: number;
		since?: string;
		before?: string;
	} = {}): Promise<TrelloNotification[]> {
		const params: Record<string, string | number> = {
			filter: input.filter ?? "all",
			read_filter: input.readFilter ?? "all",
			limit: clampLimit(input.limit ?? 50),
		};
		if (input.since) params.since = input.since;
		if (input.before) params.before = input.before;
		const data = await this.request("GET", "/members/me/notifications", params);
		return data as TrelloNotification[];
	}

	/** Mark a single notification read or unread. */
	async markNotificationRead(notificationId: string, unread: boolean): Promise<TrelloNotification> {
		const data = await this.request("PUT", `/notifications/${notificationId}/unread`, {
			value: unread,
		});
		return data as TrelloNotification;
	}

	/**
	 * Mark all unread notifications read (or unread, if read=false). Trello's
	 * /notifications/all/read endpoint has no server-side type filter — the
	 * `ids` param it takes is a comma-separated list of notification IDs, NOT
	 * a type name. Type-filtered clearing must be composed at the caller side:
	 * list_notifications({filter, readFilter:"unread"}) → mark_notification_read
	 * for each returned id. (v1.9.0 fix: earlier releases pretended `filter`
	 * worked here and silently marked nothing.)
	 */
	async markAllNotificationsRead(input: { read?: boolean } = {}): Promise<void> {
		const params: Record<string, string | boolean> = {};
		if (input.read !== undefined) params.read = input.read;
		await this.request("POST", "/notifications/all/read", params);
	}

	/** Mark every notification associated with this card as read in one call. */
	async markCardAssociatedNotificationsRead(cardId: string): Promise<void> {
		await this.request("POST", `/cards/${cardId}/markAssociatedNotificationsRead`);
	}

	// ---- Activity (broader) ----

	/** Actions on a single list. Filter is comma-separated action types. */
	async listListActions(listId: string, filter = "all", limit = 50): Promise<TrelloAction[]> {
		const data = await this.request("GET", `/lists/${listId}/actions`, {
			filter,
			limit: clampLimit(limit),
		});
		return data as TrelloAction[];
	}

	/** The authenticated user's recent activity across every board they touch. */
	async listMyActions(filter = "all", limit = 50): Promise<TrelloAction[]> {
		const data = await this.request("GET", "/members/me/actions", {
			filter,
			limit: clampLimit(limit),
		});
		return data as TrelloAction[];
	}

	// ---- Memberships + member lookup ----

	/** Board memberships with role data (admin / normal / observer / virtual). */
	async listBoardMemberships(boardId: string): Promise<TrelloMembership[]> {
		const data = await this.request("GET", `/boards/${boardId}/memberships`, {
			member: true,
			member_fields: MEMBER_FIELDS,
		});
		return data as TrelloMembership[];
	}

	/** Look up any member by ID or username. */
	async getMember(idOrUsername: string): Promise<TrelloMember> {
		const data = await this.request("GET", `/members/${idOrUsername}`, {
			fields: MEMBER_FIELDS,
		});
		return data as TrelloMember;
	}

	/** Convenience: comments only, chronological. */
	async listComments(cardId: string, limit = 50): Promise<TrelloComment[]> {
		const actions = await this.listActions(cardId, "commentCard", limit);
		const comments = actions
			.map((a) => ({
				id: a.id,
				text: ((a.data as { text?: string }).text ?? "").toString(),
				date: a.date,
				author: a.memberCreator
					? { id: a.memberCreator.id, fullName: a.memberCreator.fullName, username: a.memberCreator.username }
					: null,
			}))
			.sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
		return comments;
	}

	// ============================================================
	// v1.8.0 — single-entity fetches, action details, custom fields,
	// plugins/power-ups, batch GET, archived cards
	// ============================================================

	// ---- Single-entity fetches ----

	async getLabel(labelId: string): Promise<TrelloLabel> {
		const data = await this.request("GET", `/labels/${labelId}`, {
			fields: "name,color,idBoard,uses",
		});
		return data as TrelloLabel;
	}

	async getAttachment(cardId: string, attachmentId: string): Promise<TrelloAttachment> {
		const data = await this.request("GET", `/cards/${cardId}/attachments/${attachmentId}`, {
			fields: "id,name,url,date,bytes,mimeType,edgeColor,previews,pos",
		});
		return data as TrelloAttachment;
	}

	// ---- Actions (deep) ----

	async getAction(actionId: string): Promise<TrelloAction> {
		const data = await this.request("GET", `/actions/${actionId}`);
		return data as TrelloAction;
	}

	async getActionDisplay(actionId: string): Promise<unknown> {
		return this.request("GET", `/actions/${actionId}/display`);
	}

	async listCommentReactionsSummary(actionId: string): Promise<TrelloReactionSummary[]> {
		const data = await this.request("GET", `/actions/${actionId}/reactionsSummary`);
		return data as TrelloReactionSummary[];
	}

	// ---- Custom Fields (Power-Up) ----

	/**
	 * Board custom-field definitions, memoised per board for this client's
	 * lifetime. A TrelloClient is constructed per MCP session / per dashboard
	 * request (see src/index.ts, dashboard/api.ts, digest/scheduler.ts), so the
	 * cache is naturally short-lived and bounded by the number of boards touched.
	 *
	 * Why it matters: since v1.17.0 every custom-field write resolves the field
	 * definition first (to check the value against its type), which turned a
	 * bulk update into an extra GET per card. Every mutation below invalidates
	 * the affected board, so a stale definition can't outlive its own change.
	 * v1.18.0.
	 */
	private customFieldCache = new Map<string, TrelloCustomField[]>();

	/** Drop a board's cached definitions. Called by every custom-field mutation. */
	private invalidateCustomFields(boardId?: string): void {
		if (boardId) this.customFieldCache.delete(boardId);
		else this.customFieldCache.clear();
	}

	async listCustomFields(boardId: string): Promise<TrelloCustomField[]> {
		const cached = this.customFieldCache.get(boardId);
		if (cached) return cached;
		const data = await this.request("GET", `/boards/${boardId}/customFields`);
		const fields = data as TrelloCustomField[];
		this.customFieldCache.set(boardId, fields);
		return fields;
	}

	async createCustomField(input: {
		boardId: string;
		name: string;
		type: "checkbox" | "date" | "list" | "number" | "text";
		pos?: string | number;
		displayCardFront?: boolean;
	}): Promise<TrelloCustomField> {
		const params: Record<string, string | number | boolean | undefined> = {
			idModel: input.boardId,
			modelType: "board",
			name: input.name,
			type: input.type,
		};
		if (input.pos !== undefined) params.pos = input.pos;
		if (input.displayCardFront !== undefined) {
			params["display_cardFront"] = input.displayCardFront;
		}
		const data = await this.request("POST", "/customFields", params);
		this.invalidateCustomFields(input.boardId);
		return data as TrelloCustomField;
	}

	async updateCustomField(
		customFieldId: string,
		input: { name?: string; pos?: string | number; displayCardFront?: boolean },
	): Promise<TrelloCustomField> {
		const params: Record<string, string | number | boolean | undefined> = {};
		if (input.name !== undefined) params.name = input.name;
		if (input.pos !== undefined) params.pos = input.pos;
		// display/cardFront is Trello's actual param key — literal slash in the
		// URL query string, NOT %2F. URLSearchParams would percent-encode it and
		// Trello would silently ignore the unknown key. Send the base request
		// without this param, then append the slash-key manually.
		const displaySuffix =
			input.displayCardFront !== undefined
				? `&display/cardFront=${input.displayCardFront ? "true" : "false"}`
				: "";
		const url = this.url(`/customFields/${customFieldId}`, params) + displaySuffix;
		// Can't go through request() (it rebuilds the URL and would re-encode the
		// slash), but retryableFetch takes a pre-built URL — so 429 / transient-5xx
		// backoff still applies here, same as every other call. v1.17.0 fix.
		const resp = await this.retryableFetch(url, () => ({
			method: "PUT",
			headers: { Accept: "application/json" },
		}));
		const ct = resp.headers.get("content-type") ?? "";
		const data = ct.includes("application/json") ? await resp.json() : null;
		// These endpoints are keyed by field ID, not board ID, so there's no
		// board to target — clear everything. Mutations are rare next to reads.
		this.invalidateCustomFields();
		return data as TrelloCustomField;
	}

	async deleteCustomField(customFieldId: string): Promise<void> {
		await this.request("DELETE", `/customFields/${customFieldId}`);
		this.invalidateCustomFields();
	}

	async addCustomFieldOption(
		customFieldId: string,
		input: { value: string; color?: string; pos?: string | number },
	): Promise<TrelloCustomFieldOption> {
		// Trello expects the option value as { text: "..." } wrapped in a `value` object.
		const body: Record<string, unknown> = { value: { text: input.value } };
		if (input.color !== undefined) body.color = input.color;
		if (input.pos !== undefined) body.pos = input.pos;
		const data = await this.request(
			"POST",
			`/customFields/${customFieldId}/options`,
			{},
			body,
		);
		this.invalidateCustomFields();
		return data as TrelloCustomFieldOption;
	}

	async deleteCustomFieldOption(customFieldId: string, optionId: string): Promise<void> {
		await this.request("DELETE", `/customFields/${customFieldId}/options/${optionId}`);
		this.invalidateCustomFields();
	}

	async listCardCustomFieldItems(cardId: string): Promise<TrelloCustomFieldItem[]> {
		const data = await this.request("GET", `/cards/${cardId}/customFieldItems`);
		return data as TrelloCustomFieldItem[];
	}

	/**
	 * Set a custom-field value on a card. Uses JSON body — Trello prefers this
	 * for the /cards/{id}/customField/{id}/item endpoint. `body` shape depends
	 * on the field type:
	 *   checkbox: { value: { checked: "true" | "false" } }
	 *   date:     { value: { date: "ISO 8601" } }
	 *   number:   { value: { number: "42" } }   (Trello wants a string here)
	 *   text:     { value: { text: "..." } }
	 *   list:     { idValue: "optionId" }
	 * Pass {} (empty body) to clear.
	 */
	async setCardCustomFieldItem(
		cardId: string,
		customFieldId: string,
		body: Record<string, unknown>,
	): Promise<TrelloCustomFieldItem | null> {
		const data = await this.request(
			"PUT",
			`/cards/${cardId}/customField/${customFieldId}/item`,
			{},
			body,
		);
		return data as TrelloCustomFieldItem | null;
	}

	// ---- Plugins / Power-Ups ----

	async listBoardPlugins(boardId: string): Promise<TrelloBoardPlugin[]> {
		const data = await this.request("GET", `/boards/${boardId}/boardPlugins`);
		return data as TrelloBoardPlugin[];
	}

	async enableBoardPlugin(boardId: string, idPlugin: string): Promise<TrelloBoardPlugin> {
		const data = await this.request("POST", `/boards/${boardId}/boardPlugins`, {
			idPlugin,
		});
		return data as TrelloBoardPlugin;
	}

	async disableBoardPlugin(boardId: string, boardPluginId: string): Promise<void> {
		await this.request("DELETE", `/boards/${boardId}/boardPlugins/${boardPluginId}`);
	}

	async getPlugin(pluginId: string): Promise<TrelloPlugin> {
		const data = await this.request("GET", `/plugins/${pluginId}`);
		return data as TrelloPlugin;
	}

	// ---- Batch GET ----

	/**
	 * Bundle up to 10 relative Trello URLs (each a full path starting with `/`)
	 * into one request. Returns an array of `{ statusCode, body }` in the same
	 * order as the input. A single URL's error doesn't fail the whole batch.
	 */
	async batchGet(paths: string[]): Promise<{ statusCode: number; body: unknown }[]> {
		const data = await this.request("GET", "/batch", { urls: paths.join(",") });
		// Trello returns array of single-key objects: [{ "200": {...body...} }, ...]
		// Normalise to { statusCode, body }. Non-numeric keys ({ "error": ... },
		// {} etc.) become 502 with the full entry preserved as body, so callers
		// aren't handed a NaN statusCode they'll silently mishandle.
		const raw = (data as unknown[]) ?? [];
		return raw.map((entry) => {
			if (entry && typeof entry === "object") {
				const entries = Object.entries(entry as Record<string, unknown>);
				if (entries.length === 0) {
					return { statusCode: 502, body: entry };
				}
				const [k, v] = entries[0];
				if (/^\d{3}$/.test(k)) {
					return { statusCode: Number(k), body: v };
				}
				return { statusCode: 502, body: entry };
			}
			return { statusCode: 502, body: entry };
		});
	}

	// ---- Archived-cards reads ----

	async listArchivedCards(boardId: string): Promise<TrelloCard[]> {
		const data = await this.request("GET", `/boards/${boardId}/cards/closed`, {
			fields: CARD_FIELDS,
		});
		return data as TrelloCard[];
	}
}
