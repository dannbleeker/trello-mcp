// Daily digest tests: renderer zones/bucketing/escaping, the DST-proof
// send-window guard, KV dedupe + retry semantics, and the Resend call.
// globalThis.fetch is mocked — no real Trello or Resend calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDigest } from "../src/digest/render";
import {
	hourInTz,
	localDateInTz,
	runScheduledDigest,
	sendDigestEmail,
	type DigestEnv,
} from "../src/digest/scheduler";
import type { TrelloCard } from "../src/trello/client";
import { BOARD_ALIASES, LIST_ALIASES } from "../src/trello/constants";

const BOARD_ID = BOARD_ALIASES["dann-to-do"];

function card(overrides: Partial<TrelloCard> = {}): TrelloCard {
	return {
		closed: false,
		dateLastActivity: "2026-07-01T00:00:00.000Z",
		desc: "",
		due: null,
		dueComplete: false,
		dueReminder: null,
		id: "c1",
		idBoard: BOARD_ID,
		idList: LIST_ALIASES["@computer"],
		idMembers: [],
		labels: [],
		name: "Test card",
		start: null,
		url: "https://trello.com/c/x",
		...overrides,
	};
}

// Mid-day CEST: local day is 2026-07-10, whose start is 2026-07-09T22:00Z.
const NOW_SUMMER = Date.parse("2026-07-10T10:00:00Z");

describe("renderDigest", () => {
	it("subject is the fixed 'Todays Actions'", () => {
		expect(renderDigest([], NOW_SUMMER).subject).toBe("Todays Actions");
	});

	it("renders every zone and the dashboard link", () => {
		const { html } = renderDigest([card({ name: "Fix the boiler", idList: LIST_ALIASES["@home"] })], NOW_SUMMER);
		for (const expected of ["@Computer", "@Home", "@Phone", "@Errands", "@Lene", "Waiting for…", "Inbox — clarify", "Rolling big rocks", "todo.bleeker-pedersen.dk", "Fix the boiler"]) {
			expect(html).toContain(expected);
		}
	});

	it("escapes card names and drops non-http(s) links", () => {
		const { html } = renderDigest(
			[card({ name: '<script>alert("x")</script>', url: "javascript:alert(1)" })],
			NOW_SUMMER,
		);
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("javascript:");
	});

	it("buckets overdue vs due-today around the LOCAL (Copenhagen) midnight, not UTC", () => {
		const { html } = renderDigest(
			[
				card({ id: "o1", name: "OverdueCard", due: "2026-07-09T21:59:00.000Z" }), // 23:59 local July 9
				card({ id: "t1", name: "EarlyTodayCard", due: "2026-07-09T22:30:00.000Z" }), // 00:30 local July 10
				card({ id: "t2", name: "LateTodayCard", due: "2026-07-10T21:00:00.000Z" }), // 23:00 local July 10
				card({ id: "f1", name: "TomorrowCard", due: "2026-07-10T22:00:00.000Z" }), // 00:00 local July 11
			],
			NOW_SUMMER,
		);
		expect(html).toContain("Overdue (1)");
		expect(html).toContain("Due today (2)");
		// "Next actions" also appears in the health bar; anchor on the due
		// section's own heading and the context-zone subtitle instead.
		const dueSection = html.slice(html.indexOf("Overdue ("), html.indexOf("by context"));
		expect(dueSection).toContain("OverdueCard");
		expect(dueSection).toContain("EarlyTodayCard");
		expect(dueSection).toContain("LateTodayCard");
		expect(dueSection).not.toContain("TomorrowCard");
	});

	it("excludes dueComplete, closed, divider, and non-actionable-list cards from the due section", () => {
		const { html } = renderDigest(
			[
				card({ name: "DoneAlready", due: "2026-07-01T10:00:00.000Z", dueComplete: true }),
				card({ name: "ClosedCard", due: "2026-07-01T10:00:00.000Z", closed: true }),
				card({ name: "----", due: "2026-07-01T10:00:00.000Z" }),
				card({ name: "InDoneList", due: "2026-07-01T10:00:00.000Z", idList: LIST_ALIASES.done }),
			],
			NOW_SUMMER,
		);
		expect(html).not.toContain("Overdue (");
		expect(html).not.toContain("Due today (");
	});

	it("marks a context over its WIP limit", () => {
		const cards = Array.from({ length: 8 }, (_, i) => card({ id: `c${i}`, name: `Card ${i}` }));
		const { html } = renderDigest(cards, NOW_SUMMER);
		expect(html).toContain("8/7");
		expect(html).toContain("⚠");
	});
});

describe("digest scheduler time helpers", () => {
	it("hourInTz handles CEST, CET, and both DST transition days", () => {
		expect(hourInTz(Date.parse("2026-07-10T02:00:00Z"))).toBe(4); // summer UTC+2
		expect(hourInTz(Date.parse("2026-01-15T02:00:00Z"))).toBe(3); // winter UTC+1
		expect(hourInTz(Date.parse("2026-03-29T02:30:00Z"))).toBe(4); // spring-forward day, post-01:00Z switch
		expect(hourInTz(Date.parse("2026-10-25T02:30:00Z"))).toBe(3); // fall-back day, post-01:00Z switch
	});

	it("localDateInTz uses the Copenhagen calendar day", () => {
		// 23:30Z on July 9 is already July 10 in Copenhagen.
		expect(localDateInTz(Date.parse("2026-07-09T23:30:00Z"))).toBe("2026-07-10");
	});
});

describe("runScheduledDigest", () => {
	function makeEnv(overrides: Partial<DigestEnv> = {}): DigestEnv & { kvStore: Map<string, string> } {
		const kvStore = new Map<string, string>();
		return {
			DIGEST_FROM: "Todays Actions <todo@bleeker-pedersen.dk>",
			DIGEST_TO: "dann@bleeker-pedersen.dk",
			kvStore,
			OAUTH_KV: {
				get: async (k: string) => kvStore.get(k) ?? null,
				put: async (k: string, v: string) => {
					kvStore.set(k, v);
				},
			} as unknown as KVNamespace,
			RESEND_API_KEY: "re_test_key",
			TRELLO_KEY: "k",
			TRELLO_TOKEN: "t",
			...overrides,
		};
	}

	function mockUpstreams(resendStatus = 200) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(typeof input === "string" ? input : (input as Request).url);
			if (url.hostname === "api.trello.com") {
				return new Response(JSON.stringify([card()]), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				});
			}
			if (url.hostname === "api.resend.com") {
				return new Response(JSON.stringify({ id: "email_1" }), {
					headers: { "Content-Type": "application/json" },
					status: resendStatus,
				});
			}
			throw new Error(`Unexpected fetch in test: ${url.href}`);
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("summer: the 02:00 UTC firing (04:00 local) sends and sets the per-day flag", async () => {
		const env = makeEnv();
		const fetchSpy = mockUpstreams();
		const result = await runScheduledDigest(env, Date.parse("2026-07-10T02:00:00Z"));
		expect(result).toBe("sent");
		expect(env.kvStore.has("digest:sent:2026-07-10")).toBe(true);
		const resendCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("resend"));
		const body = JSON.parse((resendCall![1] as RequestInit).body as string);
		expect(body.subject).toBe("Todays Actions");
		expect(body.to).toEqual(["dann@bleeker-pedersen.dk"]);
	});

	it("winter: the 02:00 UTC firing (03:00 local) is outside the window; 03:00 UTC (04:00 local) sends", async () => {
		const env = makeEnv();
		mockUpstreams();
		expect(await runScheduledDigest(env, Date.parse("2026-01-15T02:00:00Z"))).toBe("skipped-outside-window");
		expect(await runScheduledDigest(env, Date.parse("2026-01-15T03:00:00Z"))).toBe("sent");
	});

	it("a later firing on the same local day is deduped by the KV flag", async () => {
		const env = makeEnv();
		mockUpstreams();
		expect(await runScheduledDigest(env, Date.parse("2026-07-10T02:00:00Z"))).toBe("sent");
		expect(await runScheduledDigest(env, Date.parse("2026-07-10T03:00:00Z"))).toBe("skipped-already-sent");
	});

	it("a failed send leaves the flag unset so the next slot retries — and the retry succeeds", async () => {
		const env = makeEnv();
		const spy = mockUpstreams(500); // Resend down at 04:00 local
		expect(await runScheduledDigest(env, Date.parse("2026-07-10T02:00:00Z"))).toBe("failed");
		expect(env.kvStore.size).toBe(0);
		spy.mockRestore();
		mockUpstreams(200); // recovered by the 05:00-local slot
		expect(await runScheduledDigest(env, Date.parse("2026-07-10T03:00:00Z"))).toBe("sent");
	});

	it("missing RESEND_API_KEY fails soft (no throw, no flag)", async () => {
		const env = makeEnv({ RESEND_API_KEY: undefined });
		mockUpstreams();
		expect(await runScheduledDigest(env, Date.parse("2026-07-10T02:00:00Z"))).toBe("failed");
		expect(env.kvStore.size).toBe(0);
	});
});

describe("sendDigestEmail", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("throws with a status-only (opaque) message on Resend failure", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(typeof input === "string" ? input : (input as Request).url);
			if (url.hostname === "api.trello.com") {
				return new Response("[]", { headers: { "Content-Type": "application/json" }, status: 200 });
			}
			return new Response("secret resend internals", { status: 422 });
		});
		await expect(
			sendDigestEmail({ RESEND_API_KEY: "re_x", TRELLO_KEY: "k", TRELLO_TOKEN: "t" }, NOW_SUMMER),
		).rejects.toThrow(/HTTP 422/);
	});
});
