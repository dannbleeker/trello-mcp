// Guard-before-mutate on the irreversible tools (v1.22.0).
//
// Both bugs here had the same shape: a write that cannot be undone happened
// before the check that was supposed to authorise it, and the caller was then
// told the call had failed. A refusal that arrives after the damage is worse
// than no guard at all, because the model reads it as "nothing happened" and
// retries.

import { describe, expect, it, vi } from "vitest";
import {
	add_checklist_item,
	assign_checklist_item_member,
	move_checklist_item,
	move_checklist_items,
	reorder_checklist_item,
	set_checklist_item_due,
	set_checklist_item_state,
	convert_checklist_item_to_card,
	delete_checklist,
	rename_checklist,
	remove_checklist_item,
} from "../src/trello/tools";
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
		addChecklistItem: vi.fn(async () => ({ id: "IT1", name: "x", state: "incomplete" })),
		setChecklistItemState: vi.fn(async () => ({ id: "IT1", name: "x", state: "complete" })),
		updateChecklistItem: vi.fn(async () => ({ id: "IT1", name: "x", state: "incomplete", idChecklist: "CL-OWNED", pos: 1 })),
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

describe("add_checklist_item / move_checklist_item", () => {
	it("add: targets the chosen checklist", async () => {
		const client = stubClient();
		await add_checklist_item(client, { cardId: CARD, text: "x", checklistId: "CL-OWNED" });
		expect(client.addChecklistItem).toHaveBeenCalledWith(CARD, "x", "CL-OWNED");
	});

	it("add: no checklistId keeps the default path", async () => {
		const client = stubClient();
		await add_checklist_item(client, { cardId: CARD, text: "x" });
		expect(client.addChecklistItem).toHaveBeenCalledWith(CARD, "x", undefined);
	});

	it("add: refuses a checklist not on the card WITHOUT writing", async () => {
		const client = stubClient();
		await expect(add_checklist_item(client, { cardId: CARD, text: "x", checklistId: "CL-FOREIGN" })).rejects.toBeInstanceOf(GuardError);
		expect(client.addChecklistItem).not.toHaveBeenCalled();
	});

	it("move: refuses a foreign target checklist WITHOUT moving", async () => {
		const client = stubClient();
		await expect(move_checklist_item(client, { cardId: CARD, itemId: "IT1", toChecklistId: "CL-FOREIGN" })).rejects.toBeInstanceOf(GuardError);
		expect(client.updateChecklistItem).not.toHaveBeenCalled();
	});

	it("move: refuses an item not on the card WITHOUT moving", async () => {
		const client = stubClient();
		await expect(move_checklist_item(client, { cardId: CARD, itemId: "IT-FOREIGN", toChecklistId: "CL-OWNED" })).rejects.toBeInstanceOf(GuardError);
		expect(client.updateChecklistItem).not.toHaveBeenCalled();
	});

	it("move: sends idChecklist, defaulting position to bottom", async () => {
		const client = stubClient({
			listChecklistsOnCard: vi.fn(async () => [{ id: "CL-OWNED", idCard: CARD, name: "Steps", checkItems: [{ id: "IT1" }] }]),
		});
		const r = await move_checklist_item(client, { cardId: CARD, itemId: "IT1", toChecklistId: "CL-OWNED" });
		expect(client.updateChecklistItem).toHaveBeenCalledWith(CARD, "IT1", { idChecklist: "CL-OWNED", pos: "bottom" });
		expect(r.item.checklistId).toBe("CL-OWNED");
	});
});

describe("item-level tools refuse an item that is not on the card", () => {
	// The card is writable and real; only the itemId is foreign. Without the
	// guard each of these would PUT /cards/{card}/checkItem/{foreign item}.
	const cases: [string, (c: ReturnType<typeof stubClient>) => Promise<unknown>][] = [
		["set_checklist_item_state", (c) => set_checklist_item_state(c, { cardId: CARD, itemId: "IT-FOREIGN", complete: true })],
		["set_checklist_item_due", (c) => set_checklist_item_due(c, { cardId: CARD, itemId: "IT-FOREIGN", due: null })],
		["assign_checklist_item_member", (c) => assign_checklist_item_member(c, { cardId: CARD, itemId: "IT-FOREIGN", member: null })],
		["reorder_checklist_item", (c) => reorder_checklist_item(c, { cardId: CARD, itemId: "IT-FOREIGN", position: "top" })],
	];
	for (const [name, call] of cases) {
		it(`${name}: GuardError, nothing written`, async () => {
			const client = stubClient();
			await expect(call(client)).rejects.toBeInstanceOf(GuardError);
			expect(client.updateChecklistItem).not.toHaveBeenCalled();
			expect(client.setChecklistItemState).not.toHaveBeenCalled();
		});
	}

	it("an owned item still passes", async () => {
		const client = stubClient({
			listChecklistsOnCard: vi.fn(async () => [{ id: "CL-OWNED", idCard: CARD, name: "Steps", checkItems: [{ id: "IT1" }] }]),
		});
		await set_checklist_item_state(client, { cardId: CARD, itemId: "IT1", complete: true });
		expect(client.setChecklistItemState).toHaveBeenCalledWith(CARD, "IT1", true);
	});
});

describe("move_checklist_items", () => {
	const two = () =>
		stubClient({
			listChecklistsOnCard: vi.fn(async () => [
				{ id: "CL-A", idCard: CARD, name: "A", checkItems: [{ id: "IT1", pos: 1 }, { id: "IT2", pos: 2 }] },
				{ id: "CL-B", idCard: CARD, name: "B", checkItems: [] },
			]),
		});

	it("moves each item to the target, in order, at the bottom", async () => {
		const client = two();
		await move_checklist_items(client, { cardId: CARD, itemIds: ["IT2", "IT1"], toChecklistId: "CL-B" });
		expect(client.updateChecklistItem).toHaveBeenNthCalledWith(1, CARD, "IT2", { idChecklist: "CL-B", pos: "bottom" });
		expect(client.updateChecklistItem).toHaveBeenNthCalledWith(2, CARD, "IT1", { idChecklist: "CL-B", pos: "bottom" });
	});

	it("one foreign item refuses the WHOLE batch, nothing moved", async () => {
		const client = two();
		await expect(
			move_checklist_items(client, { cardId: CARD, itemIds: ["IT1", "IT-FOREIGN"], toChecklistId: "CL-B" }),
		).rejects.toBeInstanceOf(GuardError);
		expect(client.updateChecklistItem).not.toHaveBeenCalled();
	});

	it("refuses a foreign target, duplicates, empty and oversize input without writing", async () => {
		const client = two();
		const bad = [
			{ itemIds: ["IT1"], toChecklistId: "CL-FOREIGN" },
			{ itemIds: ["IT1", "IT1"], toChecklistId: "CL-B" },
			{ itemIds: [], toChecklistId: "CL-B" },
			{ itemIds: Array.from({ length: 51 }, (_, i) => `IT${i}`), toChecklistId: "CL-B" },
		];
		for (const b of bad) await expect(move_checklist_items(client, { cardId: CARD, ...b })).rejects.toBeInstanceOf(GuardError);
		expect(client.updateChecklistItem).not.toHaveBeenCalled();
	});

	it("a mid-batch Trello failure reports what already moved", async () => {
		const client = two();
		client.updateChecklistItem.mockResolvedValueOnce({ id: "IT1" } as never).mockRejectedValueOnce(new Error("boom"));
		await expect(
			move_checklist_items(client, { cardId: CARD, itemIds: ["IT1", "IT2"], toChecklistId: "CL-B" }),
		).rejects.toThrow(/Moved 1 of 2.*IT2 failed: boom.*Already moved: IT1/);
	});
});
