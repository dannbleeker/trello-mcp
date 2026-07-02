import { describe, expect, it } from "vitest";
import {
	GuardError,
	assertCanWriteTo,
	assertNotReadOnly,
	assertWritable,
	wipWarning,
} from "../src/trello/guards";
import type { TrelloList } from "../src/trello/client";

// Trello IDs used by the guards. These are fixtures — they mirror what's in
// constants.ts. If we ever moved the FORBIDDEN / READ_ONLY entries, these
// literals would need updating too.
const BUTLER = "59be61509a1e3922fb72ddf7";
const REPEATER = "59be5c3ee86b5cde2f6a5c92";
const BIG_ROCKS = "5b6189409662065780670709";
const WRITABLE = "59be51ab95ff1052eac74429"; // @computer

describe("assertWritable", () => {
	it("passes silently for a writable list", () => {
		expect(() => assertWritable(WRITABLE)).not.toThrow();
	});

	it("throws GuardError for the Butler list", () => {
		expect(() => assertWritable(BUTLER)).toThrow(GuardError);
	});

	it("throws GuardError for the Repeater Cards list", () => {
		expect(() => assertWritable(REPEATER)).toThrow(GuardError);
	});

	it("does NOT throw for Rolling Big Rocks (READ_ONLY, not FORBIDDEN)", () => {
		// Big Rocks is READ_ONLY not FORBIDDEN — assertWritable ignores it by design.
		// The paired assertNotReadOnly is the guard that catches it.
		expect(() => assertWritable(BIG_ROCKS)).not.toThrow();
	});
});

describe("assertNotReadOnly", () => {
	it("passes for a writable list", () => {
		expect(() => assertNotReadOnly(WRITABLE, "source")).not.toThrow();
	});

	it("throws for Rolling Big Rocks as source", () => {
		expect(() => assertNotReadOnly(BIG_ROCKS, "source")).toThrow(GuardError);
	});

	it("throws for Rolling Big Rocks as destination with the role in message", () => {
		try {
			assertNotReadOnly(BIG_ROCKS, "destination");
			throw new Error("expected GuardError to be thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(GuardError);
			expect((e as Error).message).toContain("destination");
		}
	});
});

describe("assertCanWriteTo (composes both)", () => {
	it("passes for a writable non-READ_ONLY list", () => {
		expect(() => assertCanWriteTo(WRITABLE)).not.toThrow();
	});

	it("throws for Butler", () => {
		expect(() => assertCanWriteTo(BUTLER)).toThrow(GuardError);
	});

	it("throws for Rolling Big Rocks", () => {
		expect(() => assertCanWriteTo(BIG_ROCKS)).toThrow(GuardError);
	});
});

describe("wipWarning", () => {
	const lists: TrelloList[] = [
		{ id: WRITABLE, name: "@Computer (WIP limit 7)", idBoard: "board1", closed: false },
		{ id: "listB", name: "@Home", idBoard: "board1", closed: false },
	];

	it("returns null when list has no WIP-limit suffix", () => {
		expect(wipWarning("listB", 100, lists)).toBeNull();
	});

	it("returns null when count is at or below the limit", () => {
		expect(wipWarning(WRITABLE, 7, lists)).toBeNull();
		expect(wipWarning(WRITABLE, 3, lists)).toBeNull();
	});

	it("returns a warning string when count exceeds the limit", () => {
		const w = wipWarning(WRITABLE, 8, lists);
		expect(w).toContain("WIP warning");
		expect(w).toContain("@Computer");
		expect(w).toContain("8");
		expect(w).toContain("7");
	});

	it("returns null when list id is not in the array", () => {
		expect(wipWarning("unknown-id", 100, lists)).toBeNull();
	});
});
