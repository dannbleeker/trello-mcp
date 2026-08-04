// Archived objects that code must see but didn't (v1.22.0).
//
// Trello defaults to open-only on several endpoints. Where a tool's CORRECTNESS
// depends on seeing everything, that default silently truncates the input and
// the tool reports success on a partial job.

import { describe, expect, it, vi } from "vitest";
import { rename_custom_field_option } from "../src/trello/tools";
import type { TrelloClient } from "../src/trello/client";

const BOARD = "58cbce31043f1a89cfc6b42c";
const FIELD = "6a1111111111111111111111";
const OLD_OPT = "6a2222222222222222222222";

function card(id: string, closed: boolean, idValue: string) {
	return {
		id,
		closed,
		idList: "l1",
		idBoard: BOARD,
		name: id,
		desc: "",
		labels: [],
		due: null,
		dueComplete: false,
		start: null,
		dueReminder: null,
		idMembers: [],
		dateLastActivity: "2026-08-04T00:00:00.000Z",
		url: `https://trello.com/c/${id}`,
		customFieldItems: [{ idCustomField: FIELD, idValue }],
	};
}

function stub() {
	const listCardsOnBoard = vi.fn(async () => [
		card("open-1", false, OLD_OPT),
		card("archived-1", true, OLD_OPT),
		card("archived-2", true, OLD_OPT),
		card("unrelated", false, "some-other-option"),
	]);
	const base = {
		listCustomFields: vi.fn(async () => [
			{ id: FIELD, name: "Sphere", type: "list", options: [{ id: OLD_OPT, value: { text: "SSF" }, color: "green", pos: 1 }] },
		]),
		addCustomFieldOption: vi.fn(async () => ({ id: "NEW-OPT", value: { text: "SSF (personal)" } })),
		setCardCustomFieldItem: vi.fn(async () => undefined),
		deleteCustomFieldOption: vi.fn(async () => undefined),
		listCardsOnBoard,
		listMyBoards: vi.fn(async () => [{ id: BOARD, name: "Dann to-do", closed: false, url: "" }]),
	};
	return base as unknown as TrelloClient & typeof base;
}

describe("rename_custom_field_option sees archived cards", () => {
	it("scans with filter 'all', not Trello's open-only default", async () => {
		const client = stub();
		await rename_custom_field_option(client, { board: BOARD, customFieldId: FIELD, optionId: OLD_OPT, newValue: "SSF (personal)" });
		// The bug: without filter "all" the scan returned open cards only, then
		// step 3 deleted the option and Trello dropped the archived cards' values.
		expect(client.listCardsOnBoard).toHaveBeenCalledWith(BOARD, expect.objectContaining({ filter: "all" }));
	});

	it("re-points archived cards before the old option is deleted", async () => {
		const client = stub();
		const res = await rename_custom_field_option(client, {
			board: BOARD,
			customFieldId: FIELD,
			optionId: OLD_OPT,
			newValue: "SSF (personal)",
		});
		const repointed = client.setCardCustomFieldItem.mock.calls.map((c) => c[0]);
		expect(repointed).toContain("archived-1");
		expect(repointed).toContain("archived-2");
		expect(repointed).toContain("open-1");
		// A card on a different option must not be touched.
		expect(repointed).not.toContain("unrelated");
		expect(res.cardsRepointed).toBe(3);
		expect(res.archivedRepointed).toBe(2);
		expect(client.deleteCustomFieldOption).toHaveBeenCalled();
	});

	it("counts archivedRepointed from successes, not from the affected set", async () => {
		// Parallel naming with cardsRepointed matters: an archived card that
		// FAILED belongs in `failures`, never in this total.
		const client = stub();
		client.setCardCustomFieldItem.mockImplementation(async (cardId: string) => {
			if (cardId === "archived-2") throw new Error("Trello 429");
		});
		await expect(
			rename_custom_field_option(client, { board: BOARD, customFieldId: FIELD, optionId: OLD_OPT, newValue: "x" }),
		).rejects.toThrow(/NOT deleted/);
		// And critically: the option survives, so nothing was erased.
		expect(client.deleteCustomFieldOption).not.toHaveBeenCalled();
	});
});

describe("archived lists are resolvable by name", () => {
	it("caches every list, so listCandidates can widen to archived ones", async () => {
		// Trello returns open lists only by default, so an archived list could
		// never be matched by NAME — which made archive_list({closed:false})
		// impossible for the one input a human actually has, and list_lists
		// could not show it either.
		const { boardLists } = await import("../src/trello/resolve");
		const listListsOnBoard = vi.fn(async () => [
			{ id: "l1", name: "Backlog", closed: false, idBoard: BOARD, pos: 1 },
			{ id: "l2", name: "Old Sprint", closed: true, idBoard: BOARD, pos: 2 },
		]);
		const client = { listListsOnBoard } as unknown as TrelloClient;
		const lists = await boardLists(client, BOARD);
		expect(listListsOnBoard).toHaveBeenCalledWith(BOARD, { filter: "all" });
		expect(lists.map((l) => l.name)).toContain("Old Sprint");
	});
});

describe("search does not throw away its own quota", () => {
	it("search_cards scopes to open cards so archived hits do not eat cards_limit", async () => {
		// Trello applies cards_limit BEFORE we filter, and archived cards
		// dominate the ranking on a long-lived board — a bare query with
		// cards_limit 20 came back 19 archived and 1 open on this account.
		const { TrelloClient: RealClient } = await import("../src/trello/client");
		const client = new RealClient("k", "t");
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ cards: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await client.searchCards("design review");
		const url = new URL(spy.mock.calls[0][0] as string);
		spy.mockRestore();
		expect(url.searchParams.get("query")).toBe("design review is:open");
	});

	it("leaves an explicit is:archived query alone", async () => {
		const { TrelloClient: RealClient } = await import("../src/trello/client");
		const client = new RealClient("k", "t");
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ cards: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await client.searchCards("design review is:archived");
		const url = new URL(spy.mock.calls[0][0] as string);
		spy.mockRestore();
		expect(url.searchParams.get("query")).toBe("design review is:archived");
	});
});
