import { describe, expect, it } from "vitest";
import {
	batch_get,
	computeWakeUp,
	decodeBase64,
	startOfDayMsInTz,
	summariseCard,
} from "../src/trello/tools";
import type { TrelloCard, TrelloClient } from "../src/trello/client";
import { GuardError } from "../src/trello/guards";

// Reusable card fixture — every test extends it, so we're only testing one
// axis at a time.
function fixture(overrides: Partial<TrelloCard> = {}): TrelloCard {
	return {
		id: "cardId",
		name: "test card",
		desc: "",
		idList: "listId",
		idBoard: "boardId",
		labels: [],
		due: null,
		dueComplete: false,
		start: null,
		dueReminder: null,
		idMembers: [],
		url: "https://trello.com/c/x",
		dateLastActivity: "2026-07-02T00:00:00.000Z",
		closed: false,
		...overrides,
	};
}

describe("computeWakeUp", () => {
	it("returns null when due is null", () => {
		expect(computeWakeUp(null, 60)).toBeNull();
	});

	it("returns null when dueReminder is null", () => {
		expect(computeWakeUp("2026-07-05T17:00:00.000Z", null)).toBeNull();
	});

	it("returns null when dueReminder is -1 (Trello's 'no reminder' sentinel)", () => {
		expect(computeWakeUp("2026-07-05T17:00:00.000Z", -1)).toBeNull();
	});

	it("returns due minus dueReminder minutes for valid input", () => {
		// 60 minutes = 1 hour before due
		expect(computeWakeUp("2026-07-05T17:00:00.000Z", 60)).toBe("2026-07-05T16:00:00.000Z");
		// 1440 minutes = 1 day before
		expect(computeWakeUp("2026-07-05T17:00:00.000Z", 1440)).toBe("2026-07-04T17:00:00.000Z");
		// 0 = at due time
		expect(computeWakeUp("2026-07-05T17:00:00.000Z", 0)).toBe("2026-07-05T17:00:00.000Z");
	});

	it("returns null when due is unparseable", () => {
		expect(computeWakeUp("not-a-date", 60)).toBeNull();
	});
});

describe("decodeBase64", () => {
	it("decodes plain base64", () => {
		const out = decodeBase64("SGVsbG8=");
		expect(new TextDecoder().decode(out)).toBe("Hello");
	});

	it("tolerates a data-URI prefix", () => {
		const out = decodeBase64("data:text/plain;base64,SGVsbG8=");
		expect(new TextDecoder().decode(out)).toBe("Hello");
	});

	it("strips whitespace inside the base64 payload", () => {
		// Line breaks + spaces should all be stripped.
		const out = decodeBase64("SGVs\nbG8\r=");
		expect(new TextDecoder().decode(out)).toBe("Hello");
	});

	it("returns an empty Uint8Array for empty input", () => {
		const out = decodeBase64("");
		expect(out.length).toBe(0);
	});

	it("throws GuardError for invalid base64", () => {
		expect(() => decodeBase64("!!!not-base64!!!")).toThrow();
	});
});

describe("summariseCard", () => {
	it("collapses a full card into the summary shape", () => {
		const s = summariseCard(
			fixture({
				id: "abc",
				name: "hello",
				labels: [
					{ id: "l1", name: "BESTSELLER", color: "black" },
					{ id: "l2", name: "", color: "red" }, // unnamed label → filtered out
				],
				idMembers: ["m1"],
			}),
		);
		expect(s.id).toBe("abc");
		expect(s.name).toBe("hello");
		expect(s.labels).toEqual(["BESTSELLER"]);
		expect(s.memberIds).toEqual(["m1"]);
	});

	it("returns memberIds = [] when card.idMembers is undefined (defensive)", () => {
		// v1.10.0 ChecklistItem interface widening happens here — idMembers should
		// always default to [] to protect downstream consumers.
		const s = summariseCard(fixture({ idMembers: undefined as unknown as string[] }));
		expect(s.memberIds).toEqual([]);
	});

	it("maps listId + resolves listAlias when idList is a known list", () => {
		// The @computer list id — see constants.ts LIST_ALIASES.
		const s = summariseCard(fixture({ idList: "59be51ab95ff1052eac74429" }));
		expect(s.listId).toBe("59be51ab95ff1052eac74429");
		expect(s.listAlias).toBe("@computer");
	});

	it("returns listAlias = null for an unknown list id", () => {
		const s = summariseCard(fixture({ idList: "unknown-list-id" }));
		expect(s.listAlias).toBeNull();
	});
});

describe("startOfDayMsInTz", () => {
	// Fixed epoch: 2026-07-02T18:30:00Z (mid-day summer). Copenhagen is CEST
	// (UTC+2) in summer, so local wall-clock is 2026-07-02 20:30. Start-of-day
	// in Copenhagen is 2026-07-02T00:00 CEST = 2026-07-01T22:00Z.
	const nowMs = Date.parse("2026-07-02T18:30:00Z");

	it("returns UTC midnight when tz is UTC", () => {
		const s = startOfDayMsInTz(nowMs, "UTC");
		expect(new Date(s).toISOString()).toBe("2026-07-02T00:00:00.000Z");
	});

	it("returns Copenhagen-local midnight (CEST offset applied)", () => {
		const s = startOfDayMsInTz(nowMs, "Europe/Copenhagen");
		// 2026-07-02 00:00 CEST = 2026-07-01 22:00 UTC
		expect(new Date(s).toISOString()).toBe("2026-07-01T22:00:00.000Z");
	});

	it("handles winter (CET, UTC+1) correctly — Copenhagen mid-January", () => {
		const winterNow = Date.parse("2026-01-15T14:30:00Z");
		const s = startOfDayMsInTz(winterNow, "Europe/Copenhagen");
		// 2026-01-15 00:00 CET = 2026-01-14 23:00 UTC
		expect(new Date(s).toISOString()).toBe("2026-01-14T23:00:00.000Z");
	});

	// v1.13.0 regression pins: the pre-fix implementation subtracted now's
	// wall-clock time-of-day, implicitly assuming the UTC offset at midnight
	// equals the offset now — off by one hour on the two DST transition days.

	it("spring-forward day (2026-03-29, 23h day): midnight uses the PRE-transition offset", () => {
		// 10:00 CEST on transition day = 08:00Z. Local midnight was still CET
		// (UTC+1): 2026-03-29 00:00 CET = 2026-03-28 23:00 UTC.
		const s = startOfDayMsInTz(Date.parse("2026-03-29T08:00:00Z"), "Europe/Copenhagen");
		expect(new Date(s).toISOString()).toBe("2026-03-28T23:00:00.000Z");
	});

	it("fall-back day (2026-10-25, 25h day): midnight uses the PRE-transition offset", () => {
		// 12:00 CET on transition day = 11:00Z. Local midnight was still CEST
		// (UTC+2): 2026-10-25 00:00 CEST = 2026-10-24 22:00 UTC.
		const s = startOfDayMsInTz(Date.parse("2026-10-25T11:00:00Z"), "Europe/Copenhagen");
		expect(new Date(s).toISOString()).toBe("2026-10-24T22:00:00.000Z");
	});

	it("strips sub-second residue from the returned midnight", () => {
		const s = startOfDayMsInTz(Date.parse("2026-07-02T18:30:00.500Z"), "UTC");
		expect(new Date(s).toISOString()).toBe("2026-07-02T00:00:00.000Z");
	});
});

describe("batch_get path validation", () => {
	// Validation runs before any client call, so a bare stub suffices.
	const neverClient = {} as unknown as TrelloClient;

	it("rejects a path containing a comma (Trello /batch splits on commas, no escaping)", async () => {
		await expect(
			batch_get(neverClient, { paths: ["/cards/abc?fields=name,desc"] }),
		).rejects.toBeInstanceOf(GuardError);
	});

	it("rejects an empty paths array and >10 paths", async () => {
		await expect(batch_get(neverClient, { paths: [] })).rejects.toBeInstanceOf(GuardError);
		await expect(
			batch_get(neverClient, { paths: Array.from({ length: 11 }, (_, i) => `/boards/${i}`) }),
		).rejects.toBeInstanceOf(GuardError);
	});
});
