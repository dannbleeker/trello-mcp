// Guard-before-mutate on the irreversible tools (v1.22.0).
//
// Both bugs here had the same shape: a write that cannot be undone happened
// before the check that was supposed to authorise it, and the caller was then
// told the call had failed. A refusal that arrives after the damage is worse
// than no guard at all, because the model reads it as "nothing happened" and
// retries.

import { describe, expect, it, vi } from "vitest";
import { convert_checklist_item_to_card, delete_checklist, rename_checklist, remove_checklist_item } from "../src/trello/tools";
import type { TrelloClient } from "../src/trello/client";
import { GuardError } from "../src/trello/guards";
import { LIST_ALIASES } from "../src/trello/constants";

const BUTLER = "59be61509a1e3922fb72ddf7"; // FORBIDDEN_LISTS
const BIG_ROCKS = "5b6189409662065780670709"; // READ_ONLY_LISTS
const COMPUTER = LIST_ALIASES["@computer"];
const CARD = "68f1a2c3d4e5f60718293a4b";
const OTHER_CARD = "58f1a2c3d4e5f60718293a4b";

/** A card shaped enough for summariseCard() to render it. */
function newCard(idList: string) {
	return {
		id: "NEW",
		idList,
		idBoard: "b1",
		name: "Promoted",
		desc: "",
		labels: [],
		due: null,
		dueComplete: false,
		start: null,
		dueReminder: null,
		idMembers: [],
		dateLastActivity: "2026-08-04T00:00:00.000Z",
		url: "https://trello.com/c/NEW",
		closed: false,
	};
}

/** A client stub whose every mutating method is a spy, so a test can assert NOT-called. */
function stubClient(over: Record<string, unknown> = {}) {
	const base = {
		getCard: vi.fn(async (id: string) => ({ id, idList: COMPUTER, idBoard: "b1", name: "Card", closed: false })),
		listChecklistsOnCard: vi.fn(async () => [{ id: "CL-OWNED", idCard: CARD, name: "Steps", checkItems: [] }]),
		convertChecklistItemToCard: vi.fn(async () => newCard(COMPUTER)),
		moveCard: vi.fn(async (id: string, idList: string) => ({ ...newCard(idList), id })),
		deleteChecklist: vi.fn(async () => undefined),
		renameChecklist: vi.fn(async (id: string, name: string) => ({ id, name })),
		removeChecklistItem: vi.fn(async () => undefined),
		listListsOnBoard: vi.fn(async () => [{ id: COMPUTER, name: "@Computer", closed: false }]),
		...over,
	};
	return base as unknown as TrelloClient & typeof base;
}

describe("convert_checklist_item_to_card guards before it destroys", () => {
	it("refuses a forbidden targetList WITHOUT converting", async () => {
		const client = stubClient();
		await expect(
			convert_checklist_item_to_card(client, { cardId: CARD, checklistId: "CL-OWNED", itemId: "IT1", targetList: BUTLER }),
		).rejects.toBeInstanceOf(GuardError);
		// The whole point: the item still exists.
		expect(client.convertChecklistItemToCard).not.toHaveBeenCalled();
	});

	it("refuses a read-only targetList WITHOUT converting", async () => {
		const client = stubClient();
		await expect(
			convert_checklist_item_to_card(client, { cardId: CARD, checklistId: "CL-OWNED", itemId: "IT1", targetList: BIG_ROCKS }),
		).rejects.toBeInstanceOf(GuardError);
		expect(client.convertChecklistItemToCard).not.toHaveBeenCalled();
	});

	it("still converts and moves on the happy path", async () => {
		const client = stubClient({
			convertChecklistItemToCard: vi.fn(async () => newCard(BIG_ROCKS)),
		});
		const res = await convert_checklist_item_to_card(client, {
			cardId: CARD,
			checklistId: "CL-OWNED",
			itemId: "IT1",
			targetList: COMPUTER,
		});
		expect(client.convertChecklistItemToCard).toHaveBeenCalledTimes(1);
		expect(client.moveCard).toHaveBeenCalledWith("NEW", COMPUTER);
		expect(res.warning).toBeUndefined();
	});

	it("reports a failed move as a warning, not a failed call", async () => {
		// Past the convert the item is gone — throwing here would repeat the lie
		// the reorder fixes. The card id must reach the caller so they can finish.
		const client = stubClient({
			convertChecklistItemToCard: vi.fn(async () => newCard(BIG_ROCKS)),
			moveCard: vi.fn(async () => {
				throw new Error("Trello 400: cannot move across boards");
			}),
		});
		const res = await convert_checklist_item_to_card(client, {
			cardId: CARD,
			checklistId: "CL-OWNED",
			itemId: "IT1",
			targetList: COMPUTER,
		});
		expect(res.card.id).toBe("NEW");
		expect(res.warning).toContain("NEW");
		expect(res.warning).toContain("move_card");
	});
});

describe("checklist tools verify the checklist belongs to the card", () => {
	// Trello's /checklists/{id} endpoints never mention the card, so guarding
	// only the caller-supplied cardId let a caller name a harmless card and
	// mutate a checklist on any other — including a Butler/Repeater template.
	const foreign = { checklistId: "CL-ON-ANOTHER-CARD", cardId: CARD };

	it("delete_checklist refuses a checklist that is not on the card", async () => {
		const client = stubClient();
		await expect(delete_checklist(client, foreign)).rejects.toBeInstanceOf(GuardError);
		expect(client.deleteChecklist).not.toHaveBeenCalled();
	});

	it("rename_checklist refuses a checklist that is not on the card", async () => {
		const client = stubClient();
		await expect(rename_checklist(client, { ...foreign, name: "Renamed" })).rejects.toBeInstanceOf(GuardError);
		expect(client.renameChecklist).not.toHaveBeenCalled();
	});

	it("remove_checklist_item refuses a checklist that is not on the card", async () => {
		const client = stubClient();
		await expect(remove_checklist_item(client, { ...foreign, itemId: "IT1" })).rejects.toBeInstanceOf(GuardError);
		expect(client.removeChecklistItem).not.toHaveBeenCalled();
	});

	it("still allows a checklist that IS on the card", async () => {
		const client = stubClient();
		await expect(delete_checklist(client, { cardId: CARD, checklistId: "CL-OWNED" })).resolves.toEqual({ ok: true });
		expect(client.deleteChecklist).toHaveBeenCalledWith("CL-OWNED");
	});

	it("names the mismatch in the refusal so the caller can fix it", async () => {
		const client = stubClient();
		await expect(delete_checklist(client, foreign)).rejects.toThrow(/not on card/i);
	});

	it("checks the named card is writable before revealing anything about the checklist", async () => {
		// A Butler card must refuse on the card, not leak whether the checklist
		// exists on it.
		const client = stubClient({
			getCard: vi.fn(async (id: string) => ({ id, idList: BUTLER, idBoard: "b1", name: "Butler", closed: false })),
		});
		await expect(delete_checklist(client, { cardId: OTHER_CARD, checklistId: "CL-OWNED" })).rejects.toBeInstanceOf(
			GuardError,
		);
		expect(client.listChecklistsOnCard).not.toHaveBeenCalled();
	});
});
