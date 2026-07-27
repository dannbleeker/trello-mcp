import { describe, expect, it, vi } from "vitest";
import {
	add_custom_field_option,
	delete_custom_field,
	delete_custom_field_option,
	get_card,
	list_card_custom_fields,
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
