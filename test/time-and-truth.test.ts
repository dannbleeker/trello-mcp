// Date maths and "the tool told you something confidently wrong" (v1.22.0).

import { afterEach, describe, expect, it, vi } from "vitest";
import { dayWindowMsInTz, isDueReportable, read_comments, startOfDayMsInTz } from "../src/trello/tools";
import { ACTIONABLE_LIST_IDS, CONTEXT_LIST_ALIASES, LIST_ALIASES } from "../src/trello/constants";
import { TrelloClient as RealClient } from "../src/trello/client";

const TZ = "Europe/Copenhagen";
const hoursIn = (w: { start: number; end: number }) => (w.end - w.start) / 3_600_000;

/** Local wall-clock reading, for asserting a boundary really is local midnight. */
function wall(ms: number, tz = TZ) {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(ms));
}

describe("dayWindowMsInTz survives DST", () => {
	it("is 23 hours long on the spring-forward day", () => {
		// 2026-03-29, EU spring forward.
		expect(hoursIn(dayWindowMsInTz(Date.parse("2026-03-29T12:00:00Z"), TZ))).toBe(23);
	});

	it("is 25 hours long on the fall-back day", () => {
		// 2026-10-25, EU fall back. The old startOfDay + 24h ended an hour early.
		expect(hoursIn(dayWindowMsInTz(Date.parse("2026-10-25T12:00:00Z"), TZ))).toBe(25);
	});

	it("is 24 hours on ordinary days in both halves of the year", () => {
		expect(hoursIn(dayWindowMsInTz(Date.parse("2026-07-15T12:00:00Z"), TZ))).toBe(24);
		expect(hoursIn(dayWindowMsInTz(Date.parse("2026-01-15T12:00:00Z"), TZ))).toBe(24);
	});

	it("puts both boundaries on local midnight, every time", () => {
		for (const day of ["2026-03-29", "2026-10-25", "2026-07-15", "2026-01-15"]) {
			const w = dayWindowMsInTz(Date.parse(`${day}T12:00:00Z`), TZ);
			expect(wall(w.start)).toBe("00:00");
			expect(wall(w.end)).toBe("00:00");
		}
	});

	it("keeps a late-evening card inside today on the fall-back day", () => {
		// THE bug: a card due 23:30 local on 2026-10-25 was >= the computed end
		// so it failed "today", and > now so it failed "overdue" — it vanished
		// from both scopes and from the digest.
		const w = dayWindowMsInTz(Date.parse("2026-10-25T10:00:00Z"), TZ);
		const due = Date.parse("2026-10-25T22:30:00Z"); // 23:30 local
		expect(due >= w.start && due < w.end).toBe(true);
		// And the old arithmetic would have excluded it.
		expect(due < startOfDayMsInTz(Date.parse("2026-10-25T10:00:00Z"), TZ) + 24 * 3_600_000).toBe(false);
	});
});

describe("isDueReportable — one rule, shared by the review and the digest", () => {
	const inbox = LIST_ALIASES.inbox;
	const done = LIST_ALIASES.done;
	const due = "2026-08-04T09:00:00.000Z";

	it("reports an open due card on an actionable list", () => {
		expect(isDueReportable({ due, dueComplete: false, idList: inbox })).toBe(true);
	});

	it("excludes a card already ticked off", () => {
		// Butler moves a ticked card to Done, but dueComplete is the signal —
		// the review used to count these as still due.
		expect(isDueReportable({ due, dueComplete: true, idList: inbox })).toBe(false);
	});

	it("excludes non-actionable lists: Done, Butler, Repeater, Big Rocks", () => {
		for (const list of [done, "59be61509a1e3922fb72ddf7", "59be5c3ee86b5cde2f6a5c92", "5b6189409662065780670709"]) {
			expect(isDueReportable({ due, dueComplete: false, idList: list })).toBe(false);
		}
	});

	it("excludes a card with no due date at all", () => {
		expect(isDueReportable({ due: null, dueComplete: false, idList: inbox })).toBe(false);
	});

	it("treats every context list as actionable", () => {
		for (const alias of CONTEXT_LIST_ALIASES) {
			expect(ACTIONABLE_LIST_IDS.has(LIST_ALIASES[alias])).toBe(true);
		}
		// Waiting-for and Inbox too — they carry real commitments.
		expect(ACTIONABLE_LIST_IDS.has(LIST_ALIASES.waiting)).toBe(true);
		expect(ACTIONABLE_LIST_IDS.has(LIST_ALIASES.inbox)).toBe(true);
	});
});

describe("read_comments admits when the thread is cut", () => {
	// A REAL client with fetch mocked, so the truncation logic under test is the
	// client's own (actions.length >= clampLimit(limit)) rather than a stub of it.
	function clientWith(n: number) {
		const actions = Array.from({ length: n }, (_, i) => ({
			id: `a${i}`,
			date: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString(),
			data: { text: `comment ${i}` },
			memberCreator: { id: "m1", fullName: "Dann", username: "dann" },
		}));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(actions), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		return new RealClient("k", "t");
	}

	afterEach(() => vi.restoreAllMocks());

	it("flags truncation when the page comes back full", async () => {
		// Trello returns the NEWEST `limit`; sorting oldest-first then makes a cut
		// thread look like a complete short one. "What did we originally decide?"
		// would be answered from comment #31 of 80.
		const res = await read_comments(clientWith(50), { cardId: "c1", limit: 50 });
		expect(res.truncated).toBe(true);
		expect(res.note).toContain("older ones exist");
		expect(res.note).toContain("limit");
	});

	it("says nothing when the whole thread fits", async () => {
		const res = await read_comments(clientWith(12), { cardId: "c1", limit: 50 });
		expect(res.truncated).toBe(false);
		expect(res.note).toBeUndefined();
	});

	it("does not tell the caller to raise a limit that is already at the ceiling", async () => {
		// The zod schema caps limit at 1000, so "re-run with a higher limit"
		// would be impossible advice from a tool whose whole point is to stop
		// saying confidently wrong things.
		const res = await read_comments(clientWith(1000), { cardId: "c1", limit: 1000 });
		expect(res.truncated).toBe(true);
		expect(res.note).not.toContain("Re-run with a higher");
		expect(res.note).toContain("Trello");
	});

	it("still returns comments oldest-first", async () => {
		const res = await read_comments(clientWith(5), { cardId: "c1" });
		expect(res.comments.map((c) => c.text)).toEqual(["comment 0", "comment 1", "comment 2", "comment 3", "comment 4"]);
	});
});
