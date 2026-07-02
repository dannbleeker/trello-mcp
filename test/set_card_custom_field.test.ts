import { describe, expect, it, vi } from "vitest";
import { set_card_custom_field } from "../src/trello/tools";
import type { TrelloClient } from "../src/trello/client";

// The polymorphic set_card_custom_field is the trickiest tool signature in
// the codebase — a discriminated union that gets translated into different
// Trello payload shapes. Each variant needs its own test.

function makeClient(
	setCustomFieldSpy: (
		cardId: string,
		customFieldId: string,
		body: Record<string, unknown>,
	) => Promise<null>,
): TrelloClient {
	return {
		getCard: vi
			.fn()
			.mockResolvedValue({ id: "cardA", idList: "listA", idBoard: "boardA" }),
		setCardCustomFieldItem: vi.fn().mockImplementation(setCustomFieldSpy),
	} as unknown as TrelloClient;
}

describe("set_card_custom_field polymorphic dispatch", () => {
	it("checkbox: value={checked:true} → body={value:{checked:'true'}}", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: { checked: true },
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", { value: { checked: "true" } });
	});

	it("checkbox: value={checked:false} → body={value:{checked:'false'}}", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: { checked: false },
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", { value: { checked: "false" } });
	});

	it("date: passes the ISO string verbatim", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: { date: "2026-07-05T17:00:00.000Z" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", {
			value: { date: "2026-07-05T17:00:00.000Z" },
		});
	});

	it("date: throws GuardError on invalid ISO string", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: "fieldA",
				value: { date: "not-a-date" },
			}),
		).rejects.toThrow(/Invalid ISO 8601/);
	});

	it("number: JS number becomes a string in the payload (Trello quirk)", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: { number: 42 },
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", { value: { number: "42" } });
	});

	it("number: rejects NaN / Infinity via GuardError", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: "fieldA",
				value: { number: Number.NaN },
			}),
		).rejects.toThrow();
	});

	it("text: wrapped in the value envelope", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: { text: "hello" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", { value: { text: "hello" } });
	});

	it("list: uses idValue (not value.text)", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: { listOptionId: "opt42" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", { idValue: "opt42" });
	});

	it("null: clears the field with an empty body", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "fieldA",
			value: null,
		});
		expect(spy).toHaveBeenCalledWith("cardA", "fieldA", {});
	});
});
