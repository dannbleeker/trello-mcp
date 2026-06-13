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

const BASE = "https://api.trello.com/1";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5000;

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
}

/** Minimal Trello member shape. */
export interface TrelloMember {
	id: string;
	fullName: string;
	username: string;
	initials: string;
}

/** Minimal list shape. */
export interface TrelloList {
	id: string;
	name: string;
	idBoard: string;
	closed: boolean;
}

/** Minimal board shape. */
export interface TrelloBoard {
	id: string;
	name: string;
	url: string;
	closed: boolean;
}

/** Minimal label shape. */
export interface TrelloLabel {
	id: string;
	name: string;
	color: string;
	idBoard: string;
}

/** Minimal checklist item shape. */
export interface ChecklistItem {
	id: string;
	name: string;
	state: "complete" | "incomplete";
	pos: number;
	idChecklist: string;
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

	/** Internal: execute with retry on 429 + transient 5xx. */
	private async request(method: string, path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<unknown> {
		let attempt = 0;
		while (true) {
			attempt += 1;
			const resp = await fetch(this.url(path, params), {
				method,
				headers: { Accept: "application/json" },
			});

			if (resp.ok) {
				// 204 No Content (rare for Trello) → return null
				const ct = resp.headers.get("content-type") ?? "";
				return ct.includes("application/json") ? await resp.json() : null;
			}

			if (RETRY_STATUSES.has(resp.status) && attempt < RETRY_MAX_ATTEMPTS) {
				const retryAfter = resp.headers.get("Retry-After");
				const delayMs = retryAfter && /^\d+$/.test(retryAfter)
					? Math.min(Number(retryAfter) * 1000, RETRY_MAX_DELAY_MS)
					: Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}

			const body = await resp.text();
			throw new TrelloError(resp.status, body);
		}
	}

	// ---- Members ----

	/** The authenticated user. Useful for resolving "me" in list_my_cards_assigned. */
	async getMe(): Promise<TrelloMember> {
		const data = await this.request("GET", "/members/me", {
			fields: "fullName,username,initials",
		});
		return data as TrelloMember;
	}

	async listBoardMembers(boardId: string): Promise<TrelloMember[]> {
		const data = await this.request("GET", `/boards/${boardId}/members`, {
			fields: "fullName,username,initials",
		});
		return data as TrelloMember[];
	}

	async listCardMembers(cardId: string): Promise<TrelloMember[]> {
		const data = await this.request("GET", `/cards/${cardId}/members`, {
			fields: "fullName,username,initials",
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
			fields: "name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos",
		});
		return data as TrelloCard[];
	}

	// ---- Boards ----

	async listMyBoards(): Promise<TrelloBoard[]> {
		const data = await this.request("GET", "/members/me/boards", {
			fields: "name,url,closed",
			filter: "open",
		});
		return data as TrelloBoard[];
	}

	async getBoard(boardId: string): Promise<TrelloBoard> {
		const data = await this.request("GET", `/boards/${boardId}`, {
			fields: "name,url,closed",
		});
		return data as TrelloBoard;
	}

	// ---- Lists ----

	async listListsOnBoard(boardId: string): Promise<TrelloList[]> {
		const data = await this.request("GET", `/boards/${boardId}/lists`, {
			fields: "name,idBoard,closed",
		});
		return data as TrelloList[];
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

	async listCardsOnList(listId: string): Promise<TrelloCard[]> {
		const data = await this.request("GET", `/lists/${listId}/cards`, {
			fields: "name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos",
		});
		return data as TrelloCard[];
	}

	async listCardsOnBoard(boardId: string): Promise<TrelloCard[]> {
		const data = await this.request("GET", `/boards/${boardId}/cards`, {
			fields: "name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos",
		});
		return data as TrelloCard[];
	}

	async searchCards(query: string, boardId?: string): Promise<TrelloCard[]> {
		const params: Record<string, string | number | boolean | undefined> = {
			query,
			modelTypes: "cards",
			card_fields: "name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos",
			cards_limit: 50,
			partial: true,
		};
		if (boardId) params.idBoards = boardId;
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
		cardsLimit?: number;
	}): Promise<TrelloCard[]> {
		const params: Record<string, string | number | boolean | undefined> = {
			query: input.query,
			modelTypes: "cards",
			card_fields: "name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos",
			cards_limit: Math.min(input.cardsLimit ?? 50, 1000),
			partial: true,
		};
		if (input.boardIds && input.boardIds.length) params.idBoards = input.boardIds.join(",");
		const data = await this.request("GET", "/search", params);
		const { cards = [] } = data as { cards?: TrelloCard[] };
		return cards;
	}

	async getCard(cardId: string): Promise<TrelloCard> {
		const data = await this.request("GET", `/cards/${cardId}`, {
			fields: "name,desc,idList,idBoard,labels,due,dueComplete,start,dueReminder,idMembers,url,dateLastActivity,closed,pos",
		});
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

	// ---- Comments ----

	async addComment(cardId: string, text: string): Promise<void> {
		await this.request("POST", `/cards/${cardId}/actions/comments`, { text });
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

		let attempt = 0;
		while (true) {
			attempt += 1;
			const form = new FormData();
			form.append("name", input.filename);
			form.append(
				"file",
				new Blob([input.bytes], { type: input.mimeType ?? "application/octet-stream" }),
				input.filename,
			);

			const resp = await fetch(u.toString(), { method: "POST", body: form });
			if (resp.ok) {
				const ct = resp.headers.get("content-type") ?? "";
				return (ct.includes("application/json") ? await resp.json() : null) as TrelloAttachment;
			}

			if (RETRY_STATUSES.has(resp.status) && attempt < RETRY_MAX_ATTEMPTS) {
				const retryAfter = resp.headers.get("Retry-After");
				const delayMs = retryAfter && /^\d+$/.test(retryAfter)
					? Math.min(Number(retryAfter) * 1000, RETRY_MAX_DELAY_MS)
					: Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}

			const body = await resp.text();
			throw new TrelloError(resp.status, body);
		}
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
			limit: Math.min(Math.max(limit, 1), 1000),
		});
		return data as TrelloAction[];
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
}
