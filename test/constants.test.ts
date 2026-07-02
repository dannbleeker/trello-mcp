import { describe, expect, it } from "vitest";
import {
	BOARD_ALIASES,
	LIST_ALIASES,
	PLUGIN_ALIASES,
	ROLLING_BIG_ROCKS_ID,
	boardAliasFor,
	listAliasFor,
	parseWipLimit,
	resolveBoard,
	resolveList,
	resolvePlugin,
} from "../src/trello/constants";

describe("resolveBoard", () => {
	it("resolves the dann-to-do alias", () => {
		expect(resolveBoard("dann-to-do")).toBe(BOARD_ALIASES["dann-to-do"]);
	});

	it("resolves the zoo alias", () => {
		expect(resolveBoard("zoo")).toBe(BOARD_ALIASES.zoo);
	});

	it("passes an unknown id through unchanged", () => {
		expect(resolveBoard("58cbce31043f1a89cfc6b42c")).toBe("58cbce31043f1a89cfc6b42c");
	});
});

describe("resolveList", () => {
	it("resolves the inbox alias", () => {
		expect(resolveList("inbox")).toBe(LIST_ALIASES.inbox);
	});

	it("resolves an @-prefixed context alias", () => {
		expect(resolveList("@computer")).toBe(LIST_ALIASES["@computer"]);
	});

	it("passes an unknown id through unchanged", () => {
		expect(resolveList("59bd69c743b67aa0d621b3a9")).toBe("59bd69c743b67aa0d621b3a9");
	});
});

describe("resolvePlugin", () => {
	it("resolves the custom-fields alias", () => {
		expect(resolvePlugin("custom-fields")).toBe(PLUGIN_ALIASES["custom-fields"]);
	});

	it("passes a raw plugin id through unchanged", () => {
		const rawId = "56d5e249a98895a9797bebb9";
		expect(resolvePlugin(rawId)).toBe(rawId);
	});
});

describe("boardAliasFor + listAliasFor (reverse lookup)", () => {
	it("returns the alias for a known board id", () => {
		expect(boardAliasFor(BOARD_ALIASES["dann-to-do"])).toBe("dann-to-do");
	});

	it("returns null for an unknown board id", () => {
		expect(boardAliasFor("nonexistent-id")).toBeNull();
	});

	it("returns the alias for a known list id", () => {
		expect(listAliasFor(LIST_ALIASES.inbox)).toBe("inbox");
	});

	it("returns null for the Rolling Big Rocks id (deliberately not aliased)", () => {
		expect(listAliasFor(ROLLING_BIG_ROCKS_ID)).toBeNull();
	});
});

describe("parseWipLimit", () => {
	it("returns null for a list name without a WIP suffix", () => {
		expect(parseWipLimit("@Errands")).toBeNull();
		expect(parseWipLimit("Inbox")).toBeNull();
	});

	it("extracts the limit from a valid suffix", () => {
		expect(parseWipLimit("@Computer (WIP limit 7)")).toBe(7);
		expect(parseWipLimit("@Phone (WIP limit 5)")).toBe(5);
		expect(parseWipLimit("Backlog (WIP limit 50)")).toBe(50);
	});

	it("is case-insensitive on the token", () => {
		expect(parseWipLimit("Foo (wip limit 3)")).toBe(3);
		expect(parseWipLimit("Foo (WIP LIMIT 4)")).toBe(4);
	});

	it("returns null for a malformed suffix", () => {
		expect(parseWipLimit("Foo (WIP limit)")).toBeNull();
		expect(parseWipLimit("Foo (WIP 5)")).toBeNull();
	});
});
