import { describe, expect, it, vi } from "vitest";
import {
	add_custom_field_option,
	batch_set_card_custom_field,
	create_card,
	delete_custom_field,
	delete_custom_field_option,
	get_card,
	list_card_custom_fields,
	rename_custom_field_option,
	set_card_custom_field,
} from "../src/trello/tools";
import type { TrelloClient, TrelloCustomField } from "../src/trello/client";

// The polymorphic set_card_custom_field is the trickiest tool signature in
// the codebase — a discriminated union that gets translated into different
// Trello payload shapes. Each variant needs its own test.
//
// v1.17.0 widened the surface: every tool resolves fields by name as well as
// by ID, validates the value against the field's declared type, and joins
// read output against the board's definitions. All of that needs the board's
// custom-field definitions, so the fixture client now serves them.

const CHECKBOX: TrelloCustomField = {
	id: "aaaaaaaaaaaaaaaaaaaaaaaa",
	idModel: "boardA",
	modelType: "board",
	name: "Done",
	pos: 1,
	type: "checkbox",
};
const DATE: TrelloCustomField = {
	id: "bbbbbbbbbbbbbbbbbbbbbbbb",
	idModel: "boardA",
	modelType: "board",
	name: "Deadline",
	pos: 2,
	type: "date",
};
const NUMBER: TrelloCustomField = {
	id: "cccccccccccccccccccccccc",
	idModel: "boardA",
	modelType: "board",
	name: "Effort",
	pos: 3,
	type: "number",
};
const TEXT: TrelloCustomField = {
	id: "dddddddddddddddddddddddd",
	idModel: "boardA",
	modelType: "board",
	name: "Owner",
	pos: 4,
	type: "text",
};
const LIST: TrelloCustomField = {
	id: "eeeeeeeeeeeeeeeeeeeeeeee",
	idModel: "boardA",
	modelType: "board",
	name: "Priority",
	pos: 5,
	type: "list",
	options: [
		{ id: "1111aaaa1111aaaa1111aaaa", idCustomField: "eeeeeeeeeeeeeeeeeeeeeeee", value: { text: "High" }, pos: 1 },
		{ id: "2222bbbb2222bbbb2222bbbb", idCustomField: "eeeeeeeeeeeeeeeeeeeeeeee", value: { text: "Low" }, pos: 2 },
	],
};

const ALL_FIELDS = [CHECKBOX, DATE, NUMBER, TEXT, LIST];

function makeClient(
	setCustomFieldSpy: (
		cardId: string,
		customFieldId: string,
		body: Record<string, unknown>,
	) => Promise<null>,
	overrides: Partial<Record<keyof TrelloClient, unknown>> = {},
): TrelloClient {
	return {
		getCard: vi
			.fn()
			.mockResolvedValue({ id: "cardA", idList: "listA", idBoard: "boardA" }),
		listCustomFields: vi.fn().mockResolvedValue(ALL_FIELDS),
		listBoardPlugins: vi.fn().mockResolvedValue([]),
		setCardCustomFieldItem: vi.fn().mockImplementation(setCustomFieldSpy),
		...overrides,
	} as unknown as TrelloClient;
}

describe("set_card_custom_field polymorphic dispatch", () => {
	it("checkbox: value={checked:true} → body={value:{checked:'true'}}", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: CHECKBOX.id,
			value: { checked: true },
		});
		expect(spy).toHaveBeenCalledWith("cardA", CHECKBOX.id, { value: { checked: "true" } });
	});

	it("checkbox: value={checked:false} → body={value:{checked:'false'}}", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: CHECKBOX.id,
			value: { checked: false },
		});
		expect(spy).toHaveBeenCalledWith("cardA", CHECKBOX.id, { value: { checked: "false" } });
	});

	it("date: passes the ISO string verbatim", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: DATE.id,
			value: { date: "2026-07-05T17:00:00.000Z" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", DATE.id, {
			value: { date: "2026-07-05T17:00:00.000Z" },
		});
	});

	it("date: throws GuardError on invalid ISO string", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: DATE.id,
				value: { date: "not-a-date" },
			}),
		).rejects.toThrow(/Invalid ISO 8601/);
	});

	it("number: JS number becomes a string in the payload (Trello quirk)", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: NUMBER.id,
			value: { number: 42 },
		});
		expect(spy).toHaveBeenCalledWith("cardA", NUMBER.id, { value: { number: "42" } });
	});

	it("number: rejects NaN / Infinity via GuardError", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: NUMBER.id,
				value: { number: Number.NaN },
			}),
		).rejects.toThrow();
	});

	it("text: wrapped in the value envelope", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: TEXT.id,
			value: { text: "hello" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", TEXT.id, { value: { text: "hello" } });
	});

	it("list: uses idValue (not value.text)", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: LIST.id,
			value: { listOptionId: "1111aaaa1111aaaa1111aaaa" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", LIST.id, { idValue: "1111aaaa1111aaaa1111aaaa" });
	});

	it("null: clears the field with an empty body", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: TEXT.id,
			value: null,
		});
		expect(spy).toHaveBeenCalledWith("cardA", TEXT.id, {});
	});
});

describe("set_card_custom_field type validation (v1.17.0)", () => {
	it("refuses text written to a number field, naming the correct key", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: NUMBER.id,
				value: { text: "not a number" },
			}),
		).rejects.toThrow(/is type "number", not "text".*\{ number: \.\.\. \}/s);
		expect(spy).not.toHaveBeenCalled();
	});

	it("refuses checked written to a date field", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: DATE.id,
				value: { checked: true },
			}),
		).rejects.toThrow(/is type "date", not "checkbox"/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("refuses listOptionId written to a text field", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: TEXT.id,
				value: { listOptionId: "1111aaaa1111aaaa1111aaaa" },
			}),
		).rejects.toThrow(/is type "text", not "list"/);
	});

	it("null clears any field type without a type check", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: LIST.id,
			value: null,
		});
		expect(spy).toHaveBeenCalledWith("cardA", LIST.id, {});
	});

	it("refuses an option belonging to a different field", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: LIST.id,
				value: { listOptionId: "9999ffff9999ffff9999ffff" },
			}),
		).rejects.toThrow(/does not belong to custom field "Priority"/);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("custom-field name resolution (v1.17.0)", () => {
	it("resolves a field by name, case-insensitively", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "effort",
			value: { number: 3 },
		});
		expect(spy).toHaveBeenCalledWith("cardA", NUMBER.id, { value: { number: "3" } });
	});

	it("resolves a list option by its label", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await set_card_custom_field(client, {
			cardId: "cardA",
			customFieldId: "Priority",
			value: { listOptionId: "High" },
		});
		expect(spy).toHaveBeenCalledWith("cardA", LIST.id, { idValue: "1111aaaa1111aaaa1111aaaa" });
	});

	it("lists the available names when a name doesn't match", async () => {
		const spy = vi.fn().mockResolvedValue(null);
		const client = makeClient(spy);
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: "Nonexistent",
				value: { text: "x" },
			}),
		).rejects.toThrow(/No custom field named "Nonexistent".*Available: Done, Deadline/s);
	});

	it("refuses an ambiguous name rather than guessing", async () => {
		const dupe = { ...TEXT, id: "ffffffffffffffffffffffff" };
		const client = makeClient(vi.fn().mockResolvedValue(null), {
			listCustomFields: vi.fn().mockResolvedValue([TEXT, dupe]),
		});
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: "Owner",
				value: { text: "x" },
			}),
		).rejects.toThrow(/ambiguous/);
	});
});

describe("Power-Up guard (v1.17.0)", () => {
	it("tells the caller to enable the Power-Up when no fields and plugin is off", async () => {
		const client = makeClient(vi.fn().mockResolvedValue(null), {
			listCustomFields: vi.fn().mockResolvedValue([]),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
		});
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: "Effort",
				value: { number: 1 },
			}),
		).rejects.toThrow(/Custom Fields Power-Up is not enabled.*enable_board_plugin/s);
	});

	it("does not claim the Power-Up is off when it is on but has no fields", async () => {
		const client = makeClient(vi.fn().mockResolvedValue(null), {
			listCustomFields: vi.fn().mockResolvedValue([]),
			listBoardPlugins: vi
				.fn()
				.mockResolvedValue([{ id: "bp1", idPlugin: "56d5e249a98895a9797bebb9" }]),
		});
		await expect(
			set_card_custom_field(client, {
				cardId: "cardA",
				customFieldId: "Effort",
				value: { number: 1 },
			}),
		).rejects.toThrow(/No custom field named "Effort"/);
	});
});

describe("list_card_custom_fields join (v1.17.0)", () => {
	function readClient(items: unknown[], fields = ALL_FIELDS): TrelloClient {
		return {
			getCard: vi.fn().mockResolvedValue({
				id: "cardA",
				idList: "listA",
				idBoard: "boardA",
				name: "Card A",
				desc: "",
				labels: [],
				due: null,
				dueComplete: false,
				start: null,
				dueReminder: null,
				idMembers: [],
				url: "https://trello.com/c/cardA",
				dateLastActivity: "2026-07-01T00:00:00.000Z",
				closed: false,
				customFieldItems: items,
			}),
			listCustomFields: vi.fn().mockResolvedValue(fields),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
		} as unknown as TrelloClient;
	}

	it("attaches name and type to each value", async () => {
		const client = readClient([
			{
				id: "item1",
				idCustomField: NUMBER.id,
				idModel: "cardA",
				modelType: "card",
				value: { number: "7" },
			},
		]);
		const { items } = await list_card_custom_fields(client, { cardId: "cardA" });
		const effort = items.find((i) => i.idCustomField === NUMBER.id);
		expect(effort).toMatchObject({ name: "Effort", type: "number", value: { number: 7 } });
	});

	it("parses 'false' as boolean false, not a truthy string", async () => {
		const client = readClient([
			{
				id: "item1",
				idCustomField: CHECKBOX.id,
				idModel: "cardA",
				modelType: "card",
				value: { checked: "false" },
			},
		]);
		const { items } = await list_card_custom_fields(client, { cardId: "cardA" });
		const done = items.find((i) => i.idCustomField === CHECKBOX.id);
		expect(done?.value?.checked).toBe(false);
	});

	it("resolves a list-type value to its option label", async () => {
		const client = readClient([
			{
				id: "item1",
				idCustomField: LIST.id,
				idModel: "cardA",
				modelType: "card",
				idValue: "2222bbbb2222bbbb2222bbbb",
			},
		]);
		const { items } = await list_card_custom_fields(client, { cardId: "cardA" });
		const priority = items.find((i) => i.idCustomField === LIST.id);
		expect(priority).toMatchObject({
			name: "Priority",
			type: "list",
			idValue: "2222bbbb2222bbbb2222bbbb",
			value: { text: "Low" },
		});
	});

	it("emits unset fields with value: null instead of omitting them", async () => {
		const client = readClient([]);
		const { items } = await list_card_custom_fields(client, { cardId: "cardA" });
		expect(items).toHaveLength(ALL_FIELDS.length);
		expect(items.every((i) => i.value === null && i.id === null)).toBe(true);
		expect(items.map((i) => i.name)).toEqual([
			"Done",
			"Deadline",
			"Effort",
			"Owner",
			"Priority",
		]);
	});

	it("drops items whose definition no longer exists", async () => {
		const client = readClient(
			[
				{
					id: "item1",
					idCustomField: "999999999999999999999999",
					idModel: "cardA",
					modelType: "card",
					value: { text: "orphan" },
				},
			],
			[TEXT],
		);
		const { items } = await list_card_custom_fields(client, { cardId: "cardA" });
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ name: "Owner", value: null });
	});

	it("get_card includes them only when customFields: true", async () => {
		const client = readClient([]);
		const without = await get_card(client, { cardId: "cardA" });
		expect(without.card.customFields).toBeUndefined();
		const withFields = await get_card(client, { cardId: "cardA", customFields: true });
		expect(withFields.card.customFields).toHaveLength(ALL_FIELDS.length);
	});
});

describe("option + delete guards (v1.17.0)", () => {
	function optClient(overrides: Record<string, unknown> = {}): TrelloClient {
		return {
			getCard: vi.fn().mockResolvedValue({ id: "cardA", idList: "listA", idBoard: "boardA" }),
			listCustomFields: vi.fn().mockResolvedValue(ALL_FIELDS),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
			addCustomFieldOption: vi
				.fn()
				.mockResolvedValue({ id: "opt9", value: { text: "Mid" }, pos: 3 }),
			deleteCustomFieldOption: vi.fn().mockResolvedValue(undefined),
			deleteCustomField: vi.fn().mockResolvedValue(undefined),
			...overrides,
		} as unknown as TrelloClient;
	}

	it("add_custom_field_option refuses a non-list field", async () => {
		const client = optClient();
		await expect(
			add_custom_field_option(client, { customFieldId: "Effort", value: "Mid" }),
		).rejects.toThrow(/is type "number" — only LIST-type fields have options/);
	});

	it("add_custom_field_option resolves the field by name", async () => {
		const client = optClient();
		const res = await add_custom_field_option(client, { customFieldId: "Priority", value: "Mid" });
		expect(client.addCustomFieldOption).toHaveBeenCalledWith(LIST.id, {
			value: "Mid",
			color: undefined,
			pos: undefined,
		});
		expect(res.option.value).toBe("Mid");
	});

	it("delete_custom_field_option accepts an option label", async () => {
		const client = optClient();
		await delete_custom_field_option(client, { customFieldId: "Priority", optionId: "Low" });
		expect(client.deleteCustomFieldOption).toHaveBeenCalledWith(
			LIST.id,
			"2222bbbb2222bbbb2222bbbb",
		);
	});

	it("delete_custom_field refuses without confirm: true", async () => {
		const client = optClient();
		await expect(delete_custom_field(client, { customFieldId: "Owner" })).rejects.toThrow(
			/Re-run with confirm: true/,
		);
		expect(client.deleteCustomField).not.toHaveBeenCalled();
	});

	it("delete_custom_field proceeds with confirm: true and reports what went", async () => {
		const client = optClient();
		const res = await delete_custom_field(client, { customFieldId: "Owner", confirm: true });
		expect(client.deleteCustomField).toHaveBeenCalledWith(TEXT.id);
		expect(res.deleted).toEqual({ id: TEXT.id, name: "Owner", type: "text" });
	});
});

describe("batch_set_card_custom_field (v1.18.0)", () => {
	function batchClient(overrides: Record<string, unknown> = {}): TrelloClient {
		return {
			getCard: vi
				.fn()
				.mockImplementation(async (id: string) => ({ id, idList: "listA", idBoard: "boardA" })),
			listCustomFields: vi.fn().mockResolvedValue(ALL_FIELDS),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
			setCardCustomFieldItem: vi.fn().mockResolvedValue(null),
			...overrides,
		} as unknown as TrelloClient;
	}

	it("resolves the field ONCE per board, not once per card", async () => {
		const client = batchClient();
		const res = await batch_set_card_custom_field(client, {
			cardIds: ["c1", "c2", "c3"],
			customFieldId: "Effort",
			value: { number: 5 },
		});
		expect(res).toEqual({ updated: 3, skipped: [] });
		// The whole point of the batch: one definition lookup for three cards.
		expect(client.listCustomFields).toHaveBeenCalledTimes(1);
		expect(client.setCardCustomFieldItem).toHaveBeenCalledTimes(3);
		expect(client.setCardCustomFieldItem).toHaveBeenCalledWith("c2", NUMBER.id, {
			value: { number: "5" },
		});
	});

	it("type-checks once and skips every card rather than writing junk", async () => {
		const client = batchClient();
		const res = await batch_set_card_custom_field(client, {
			cardIds: ["c1", "c2"],
			customFieldId: "Effort",
			value: { text: "nope" },
		});
		expect(res.updated).toBe(0);
		expect(res.skipped).toHaveLength(2);
		expect(res.skipped[0].reason).toMatch(/is type "number", not "text"/);
		expect(client.setCardCustomFieldItem).not.toHaveBeenCalled();
	});

	it("continues past a single failing card", async () => {
		const client = batchClient({
			setCardCustomFieldItem: vi
				.fn()
				.mockResolvedValueOnce(null)
				.mockRejectedValueOnce(new Error("Trello 500"))
				.mockResolvedValueOnce(null),
		});
		const res = await batch_set_card_custom_field(client, {
			cardIds: ["c1", "c2", "c3"],
			customFieldId: "Effort",
			value: { number: 1 },
		});
		expect(res.updated).toBe(2);
		expect(res.skipped).toEqual([{ cardId: "c2", reason: "Trello 500" }]);
	});

	it("rejects an empty list and an oversized batch", async () => {
		const client = batchClient();
		await expect(
			batch_set_card_custom_field(client, { cardIds: [], customFieldId: "Effort", value: null }),
		).rejects.toThrow(/non-empty/);
		await expect(
			batch_set_card_custom_field(client, {
				cardIds: Array.from({ length: 51 }, (_, i) => `c${i}`),
				customFieldId: "Effort",
				value: null,
			}),
		).rejects.toThrow(/capped at 50/);
	});
});

describe("rename_custom_field_option (v1.18.0)", () => {
	const CARD_ON_HIGH = {
		id: "card1",
		idBoard: "boardA",
		customFieldItems: [
			{ id: "i1", idCustomField: LIST.id, idModel: "card1", modelType: "card", idValue: "1111aaaa1111aaaa1111aaaa" },
		],
	};
	const CARD_ON_LOW = {
		id: "card2",
		idBoard: "boardA",
		customFieldItems: [
			{ id: "i2", idCustomField: LIST.id, idModel: "card2", modelType: "card", idValue: "2222bbbb2222bbbb2222bbbb" },
		],
	};

	function renameClient(overrides: Record<string, unknown> = {}): TrelloClient {
		return {
			listCustomFields: vi.fn().mockResolvedValue(ALL_FIELDS),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
			addCustomFieldOption: vi
				.fn()
				.mockResolvedValue({ id: "3333cccc3333cccc3333cccc", value: { text: "Urgent" }, pos: 1 }),
			listCardsOnBoard: vi.fn().mockResolvedValue([CARD_ON_HIGH, CARD_ON_LOW]),
			setCardCustomFieldItem: vi.fn().mockResolvedValue(null),
			deleteCustomFieldOption: vi.fn().mockResolvedValue(undefined),
			...overrides,
		} as unknown as TrelloClient;
	}

	it("adds, re-points only affected cards, then deletes the old option — in that order", async () => {
		const client = renameClient();
		const res = await rename_custom_field_option(client, {
			customFieldId: "Priority",
			optionId: "High",
			newValue: "Urgent",
		});
		expect(res.cardsRepointed).toBe(1);
		expect(res.newOptionId).toBe("3333cccc3333cccc3333cccc");
		// Only the card on "High" moves; the one on "Low" is untouched.
		expect(client.setCardCustomFieldItem).toHaveBeenCalledTimes(1);
		expect(client.setCardCustomFieldItem).toHaveBeenCalledWith("card1", LIST.id, {
			idValue: "3333cccc3333cccc3333cccc",
		});
		expect(client.deleteCustomFieldOption).toHaveBeenCalledWith(
			LIST.id,
			"1111aaaa1111aaaa1111aaaa",
		);
	});

	it("inherits the old option's colour and position", async () => {
		const coloured = {
			...LIST,
			options: [{ ...LIST.options![0], color: "red", pos: 7 }, LIST.options![1]],
		};
		const client = renameClient({ listCustomFields: vi.fn().mockResolvedValue([coloured]) });
		await rename_custom_field_option(client, {
			customFieldId: "Priority",
			optionId: "High",
			newValue: "Urgent",
		});
		expect(client.addCustomFieldOption).toHaveBeenCalledWith(LIST.id, {
			value: "Urgent",
			color: "red",
			pos: 7,
		});
	});

	it("does NOT delete the old option when a card fails to move", async () => {
		const client = renameClient({
			setCardCustomFieldItem: vi.fn().mockRejectedValue(new Error("Trello 500")),
		});
		await expect(
			rename_custom_field_option(client, {
				customFieldId: "Priority",
				optionId: "High",
				newValue: "Urgent",
			}),
		).rejects.toThrow(/was NOT deleted — both options exist, no values were lost/);
		// The destructive step must not run — that's the whole safety property.
		expect(client.deleteCustomFieldOption).not.toHaveBeenCalled();
	});

	it("refuses a non-list field and an empty label", async () => {
		const client = renameClient();
		await expect(
			rename_custom_field_option(client, {
				customFieldId: "Effort",
				optionId: "x",
				newValue: "y",
			}),
		).rejects.toThrow(/only LIST-type fields have options/);
		await expect(
			rename_custom_field_option(client, {
				customFieldId: "Priority",
				optionId: "High",
				newValue: "   ",
			}),
		).rejects.toThrow(/non-empty label/);
	});
});

describe("create_card customFields (v1.18.0)", () => {
	function createClient(overrides: Record<string, unknown> = {}): TrelloClient {
		return {
			createCard: vi.fn().mockResolvedValue({
				id: "newcard", name: "N", desc: "", idList: "listA", idBoard: "boardA",
				labels: [], due: null, dueComplete: false, start: null, dueReminder: null,
				idMembers: [], url: "u", dateLastActivity: "2026-07-01T00:00:00.000Z", closed: false,
			}),
			getCard: vi.fn().mockResolvedValue({ id: "newcard", idList: "listA", idBoard: "boardA" }),
			listCustomFields: vi.fn().mockResolvedValue(ALL_FIELDS),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
			setCardCustomFieldItem: vi.fn().mockResolvedValue(null),
			// create_card runs a WIP check after creating; both of these feed it.
			listCardsOnList: vi.fn().mockResolvedValue([]),
			listListsOnBoard: vi.fn().mockResolvedValue([]),
			...overrides,
		} as unknown as TrelloClient;
	}

	it("applies values after creation and reports each one", async () => {
		const client = createClient();
		const res = await create_card(client, {
			list: "inbox",
			name: "N",
			customFields: [
				{ field: "Effort", value: { number: 3 } },
				{ field: "Owner", value: { text: "Dann" } },
			],
		});
		expect(res.card.id).toBe("newcard");
		expect(res.customFields).toEqual([
			{ field: "Effort", ok: true },
			{ field: "Owner", ok: true },
		]);
	});

	it("still returns the created card when a field fails", async () => {
		const client = createClient();
		const res = await create_card(client, {
			list: "inbox",
			name: "N",
			customFields: [{ field: "Effort", value: { text: "wrong type" } }],
		});
		// The card exists — reporting a hard failure would invite a retry that
		// creates a duplicate.
		expect(res.card.id).toBe("newcard");
		expect(res.customFields?.[0].ok).toBe(false);
		expect(res.customFields?.[0].error).toMatch(/is type "number", not "text"/);
	});

	it("omits the customFields key entirely when none were requested", async () => {
		const client = createClient();
		const res = await create_card(client, { list: "inbox", name: "N" });
		expect(res.customFields).toBeUndefined();
		expect(client.setCardCustomFieldItem).not.toHaveBeenCalled();
	});
});
