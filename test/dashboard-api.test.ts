// Dashboard API tests: session gate (401/403), Origin check, input validation
// (400), guard reuse (403 with no upstream call), happy paths with a mocked
// Trello upstream, and upstream-error mapping (502). No real Trello calls —
// globalThis.fetch is mocked, matching the client-request test convention.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApi, type DashboardEnv } from "../src/dashboard/api";
import { createSessionCookie } from "../src/dashboard/session";
import { BOARD_ALIASES, LIST_ALIASES } from "../src/trello/constants";

const ENV: DashboardEnv = {
	COOKIE_ENCRYPTION_KEY: "test-cookie-encryption-key-0123456789abcdef",
	GITHUB_CLIENT_ID: "test-client-id",
	GITHUB_CLIENT_SECRET: "test-client-secret",
	TRELLO_KEY: "test-key",
	TRELLO_TOKEN: "test-token",
};

const BOARD_ID = BOARD_ALIASES["dann-to-do"];
const INBOX_ID = LIST_ALIASES.inbox;
const COMPUTER_ID = LIST_ALIASES["@computer"];
const HOME_ID = LIST_ALIASES["@home"];
const BUTLER_ID = "59be61509a1e3922fb72ddf7"; // FORBIDDEN_LISTS entry

/** Cookie request-header for a signed session as `login`. */
async function sessionFor(login: string): Promise<string> {
	const setCookie = await createSessionCookie(login, ENV.COOKIE_ENCRYPTION_KEY);
	return setCookie.split(";")[0];
}

/** A full TrelloCard as the API's `fields` selection returns it. */
function trelloCard(overrides: Record<string, unknown> = {}) {
	return {
		closed: false,
		dateLastActivity: "2026-07-01T00:00:00.000Z",
		desc: "",
		due: null,
		dueComplete: false,
		dueReminder: null,
		id: "cccccccccccccccccccccccc",
		idBoard: BOARD_ID,
		idList: COMPUTER_ID,
		idMembers: [],
		labels: [],
		name: "Test card",
		start: null,
		url: "https://trello.com/c/abc123",
		...overrides,
	};
}

/**
 * Mock the Trello upstream by URL: each entry answers `method pathname` with a
 * JSON body. Any unrouted call fails the test loudly.
 */
function mockTrello(routes: Array<{ method: string; path: string; body: unknown; status?: number }>) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(typeof input === "string" ? input : (input as Request).url);
		const method = (init?.method ?? "GET").toUpperCase();
		const match = routes.find((r) => r.method === method && url.pathname === r.path);
		if (!match) throw new Error(`Unexpected Trello call in test: ${method} ${url.pathname}`);
		return new Response(JSON.stringify(match.body), {
			headers: { "Content-Type": "application/json" },
			status: match.status ?? 200,
		});
	});
}

function postInit(body: unknown, cookie: string, extraHeaders: Record<string, string> = {}) {
	return {
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json", Cookie: cookie, ...extraHeaders },
		method: "POST",
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session gate", () => {
	it("401 JSON (not a redirect) without a session cookie", async () => {
		const res = await DashboardApi.request("/api/cards", {}, ENV);
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBeTruthy();
	});

	it("401 for a tampered session cookie", async () => {
		const cookie = await sessionFor("dannbleeker");
		const res = await DashboardApi.request(
			"/api/cards",
			{ headers: { Cookie: `${cookie}tampered` } },
			ENV,
		);
		expect(res.status).toBe(401);
	});

	it("403 for an authenticated but non-allowlisted login — on reads AND writes", async () => {
		const cookie = await sessionFor("mallory");
		const read = await DashboardApi.request("/api/cards", { headers: { Cookie: cookie } }, ENV);
		expect(read.status).toBe(403);
		const write = await DashboardApi.request(
			"/api/move",
			postInit({ cardId: "c1", list: HOME_ID }, cookie),
			ENV,
		);
		expect(write.status).toBe(403);
	});

	it("403 for a mutating request with a foreign Origin header", async () => {
		const cookie = await sessionFor("dannbleeker");
		const res = await DashboardApi.request(
			"/api/capture",
			postInit({ name: "x" }, cookie, { Origin: "https://evil.example" }),
			ENV,
		);
		expect(res.status).toBe(403);
	});
});

/** The board's lists as /api/cards now returns them (v1.20.0). */
const BOARD_LISTS = [
	{ closed: false, id: COMPUTER_ID, idBoard: BOARD_ID, name: "@Computer (WIP limit 7)" },
	{ closed: false, id: HOME_ID, idBoard: BOARD_ID, name: "@Home (WIP limit 5)" },
	{ closed: false, id: INBOX_ID, idBoard: BOARD_ID, name: "Inbox" },
];

describe("GET /api/cards", () => {
	it("returns { cards } from the default board when ?board is omitted", async () => {
		const cookie = await sessionFor("dannbleeker");
		const fetchSpy = mockTrello([
			{ body: [trelloCard()], method: "GET", path: `/1/boards/${BOARD_ID}/cards` },
			{ body: BOARD_LISTS, method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request("/api/cards", { headers: { Cookie: cookie } }, ENV);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.cards).toHaveLength(1);
		expect(body.cards[0]).toMatchObject({ id: "cccccccccccccccccccccccc", idList: COMPUTER_ID, url: "https://trello.com/c/abc123" });
		expect(fetchSpy).toHaveBeenCalledTimes(2); // cards + lists
	});

	it("returns the board's lists so the page can derive its layout", async () => {
		// The page reads contexts, their WIP limits and the Inbox off this —
		// it used to hardcode all of it, so a board change never reached it.
		const cookie = await sessionFor("dannbleeker");
		mockTrello([
			{ body: [], method: "GET", path: `/1/boards/${BOARD_ID}/cards` },
			{ body: BOARD_LISTS, method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request("/api/cards", { headers: { Cookie: cookie } }, ENV);
		const body = await res.json();
		expect(body.lists).toHaveLength(3);
		expect(body.lists[0]).toMatchObject({ id: COMPUTER_ID, name: "@Computer (WIP limit 7)" });
	});

	it("still returns lists alongside customFields when ?customFields=1", async () => {
		const cookie = await sessionFor("dannbleeker");
		mockTrello([
			{ body: [], method: "GET", path: `/1/boards/${BOARD_ID}/cards` },
			{ body: BOARD_LISTS, method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
			{ body: [{ id: "f1", name: "Priority", type: "list" }], method: "GET", path: `/1/boards/${BOARD_ID}/customFields` },
		]);
		const res = await DashboardApi.request("/api/cards?customFields=1", { headers: { Cookie: cookie } }, ENV);
		const body = await res.json();
		expect(body.lists).toHaveLength(3);
		expect(body.customFields).toHaveLength(1);
	});

	it("accepts an explicit board id (the page passes ?board= straight through)", async () => {
		const cookie = await sessionFor("dannbleeker");
		mockTrello([
			{ body: [], method: "GET", path: `/1/boards/${BOARD_ID}/cards` },
			{ body: BOARD_LISTS, method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request(
			`/api/cards?board=${BOARD_ID}`,
			{ headers: { Cookie: cookie } },
			ENV,
		);
		expect(res.status).toBe(200);
		expect((await res.json()).cards).toEqual([]);
	});

	it("400 for an empty board param", async () => {
		const cookie = await sessionFor("dannbleeker");
		const res = await DashboardApi.request("/api/cards?board=", { headers: { Cookie: cookie } }, ENV);
		expect(res.status).toBe(400);
	});

	it("Trello 4xx keeps its status class (404, opaque, no upstream body) instead of masquerading as 502", async () => {
		const cookie = await sessionFor("dannbleeker");
		mockTrello([
			{ body: "secret upstream detail", method: "GET", path: `/1/boards/${BOARD_ID}/cards`, status: 404 },
			{ body: BOARD_LISTS, method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request("/api/cards", { headers: { Cookie: cookie } }, ENV);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).not.toContain("secret upstream detail");
	});

	it("a failed lists fetch fails the request — the page has no columns without it", async () => {
		const cookie = await sessionFor("dannbleeker");
		mockTrello([
			{ body: [trelloCard()], method: "GET", path: `/1/boards/${BOARD_ID}/cards` },
			{ body: "nope", method: "GET", path: `/1/boards/${BOARD_ID}/lists`, status: 404 },
		]);
		const res = await DashboardApi.request("/api/cards", { headers: { Cookie: cookie } }, ENV);
		expect(res.status).toBe(404);
	});
});

describe("GET /api/review", () => {
	it("returns the weekly-review pack, with Could-do (SSF) among the horizons", async () => {
		// The horizon bucket used to list Personal / BESTSELLER / DBP Invest /
		// Someday only, so an entire sphere was missing from the one view built
		// to show horizons.
		const cookie = await sessionFor("dannbleeker");
		mockTrello([
			{ body: { id: BOARD_ID, name: "Dann to-do", url: "https://trello.com/b/x" }, method: "GET", path: `/1/boards/${BOARD_ID}` },
			{
				body: [
					trelloCard({ id: "s1", idList: LIST_ALIASES["could-ssf"], name: "Rekruttering" }),
					trelloCard({ id: "p1", idList: LIST_ALIASES["could-personal"], name: "Butterfly" }),
				],
				method: "GET",
				path: `/1/boards/${BOARD_ID}/cards`,
			},
		]);
		const res = await DashboardApi.request("/api/review", { headers: { Cookie: cookie } }, ENV);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Object.keys(body.could_do)).toEqual([
			"could-personal", "could-bestseller", "could-dbp-invest", "could-ssf", "someday",
		]);
		expect(body.could_do["could-ssf"]).toBe(1);
		expect(body.could_do["could-personal"]).toBe(1);
	});
});

describe("POST /api/move", () => {
	it("400 when cardId or list is missing/empty", async () => {
		const cookie = await sessionFor("dannbleeker");
		for (const body of [{}, { cardId: "c1" }, { list: HOME_ID }, { cardId: "  ", list: HOME_ID }]) {
			const res = await DashboardApi.request("/api/move", postInit(body, cookie), ENV);
			expect(res.status).toBe(400);
		}
	});

	it("moves via the tools layer and returns { ok: true }", async () => {
		const cookie = await sessionFor("dannbleeker");
		const fetchSpy = mockTrello([
			{ body: trelloCard(), method: "GET", path: "/1/cards/cccccccccccccccccccccccc" },
			{ body: trelloCard({ idList: HOME_ID }), method: "PUT", path: "/1/cards/cccccccccccccccccccccccc" },
			{ body: [trelloCard({ idList: HOME_ID })], method: "GET", path: `/1/lists/${HOME_ID}/cards` },
			{ body: [{ id: HOME_ID, name: "@Home" }], method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request(
			"/api/move",
			postInit({ cardId: "cccccccccccccccccccccccc", list: HOME_ID }, cookie),
			ENV,
		);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
		const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT");
		expect(putCall).toBeTruthy();
		expect(new URL(putCall![0] as string).searchParams.get("idList")).toBe(HOME_ID);
	});

	it("403 with the guard message when the destination is forbidden — before any Trello call", async () => {
		const cookie = await sessionFor("dannbleeker");
		const fetchSpy = mockTrello([]);
		const res = await DashboardApi.request(
			"/api/move",
			postInit({ cardId: "cccccccccccccccccccccccc", list: BUTLER_ID }, cookie),
			ENV,
		);
		expect(res.status).toBe(403);
		expect((await res.json()).error).toContain("Refused");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("POST /api/done", () => {
	it("400 when cardId is missing", async () => {
		const cookie = await sessionFor("dannbleeker");
		const res = await DashboardApi.request("/api/done", postInit({}, cookie), ENV);
		expect(res.status).toBe(400);
	});

	it("sets dueComplete=true AND moves the card to Done-do (deterministic even without a due date)", async () => {
		const cookie = await sessionFor("dannbleeker");
		const DONE_ID = LIST_ALIASES.done;
		const fetchSpy = mockTrello([
			{ body: trelloCard(), method: "GET", path: "/1/cards/cccccccccccccccccccccccc" },
			{ body: trelloCard({ dueComplete: true }), method: "PUT", path: "/1/cards/cccccccccccccccccccccccc" },
			{ body: [trelloCard({ idList: DONE_ID })], method: "GET", path: `/1/lists/${DONE_ID}/cards` },
			{ body: [{ id: DONE_ID, name: "Done-do" }], method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request(
			"/api/done",
			postInit({ cardId: "cccccccccccccccccccccccc" }, cookie),
			ENV,
		);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
		const putParams = fetchSpy.mock.calls
			.filter(([, init]) => init?.method === "PUT")
			.map(([url]) => new URL(url as string).searchParams);
		expect(putParams.some((p) => p.get("dueComplete") === "true")).toBe(true);
		expect(putParams.some((p) => p.get("idList") === DONE_ID)).toBe(true);
	});
});

describe("POST /api/capture", () => {
	it("400 when name is missing or whitespace-only", async () => {
		const cookie = await sessionFor("dannbleeker");
		for (const body of [{}, { name: "" }, { name: "   " }]) {
			const res = await DashboardApi.request("/api/capture", postInit(body, cookie), ENV);
			expect(res.status).toBe(400);
		}
	});

	it("creates the card on the Inbox (server-chosen destination) and returns 201 { card }", async () => {
		const cookie = await sessionFor("dannbleeker");
		const fetchSpy = mockTrello([
			{ body: trelloCard({ idList: INBOX_ID, name: "Buy milk" }), method: "POST", path: "/1/cards" },
			{ body: [trelloCard({ idList: INBOX_ID })], method: "GET", path: `/1/lists/${INBOX_ID}/cards` },
			{ body: [{ id: INBOX_ID, name: "Inbox" }], method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request(
			"/api/capture",
			postInit({ name: "Buy milk" }, cookie),
			ENV,
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.card.name).toBe("Buy milk");
		const postCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST");
		expect(new URL(postCall![0] as string).searchParams.get("idList")).toBe(INBOX_ID);
	});

	it("Trello 5xx on the (non-retried) POST maps to 502 without duplicating the write", async () => {
		const cookie = await sessionFor("dannbleeker");
		const fetchSpy = mockTrello([
			{ body: "gateway timeout after commit", method: "POST", path: "/1/cards", status: 502 },
		]);
		const res = await DashboardApi.request(
			"/api/capture",
			postInit({ name: "Buy milk" }, cookie),
			ENV,
		);
		expect(res.status).toBe(502);
		// The write must NOT have been re-attempted — a 5xx can arrive after
		// Trello committed the card, and a retry would duplicate it.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe("POST /api/undo-done (v1.16.0)", () => {
	it("400 when cardId or list is missing", async () => {
		const cookie = await sessionFor("dannbleeker");
		for (const body of [{}, { cardId: "c1" }, { list: HOME_ID }]) {
			const res = await DashboardApi.request("/api/undo-done", postInit(body, cookie), ENV);
			expect(res.status).toBe(400);
		}
	});

	it("clears dueComplete and moves the card back to its previous list", async () => {
		const cookie = await sessionFor("dannbleeker");
		const fetchSpy = mockTrello([
			{ body: trelloCard({ idList: LIST_ALIASES.done }), method: "GET", path: "/1/cards/cccccccccccccccccccccccc" },
			{ body: trelloCard({ idList: HOME_ID }), method: "PUT", path: "/1/cards/cccccccccccccccccccccccc" },
			{ body: [trelloCard({ idList: HOME_ID })], method: "GET", path: `/1/lists/${HOME_ID}/cards` },
			{ body: [{ id: HOME_ID, name: "@Home" }], method: "GET", path: `/1/boards/${BOARD_ID}/lists` },
		]);
		const res = await DashboardApi.request(
			"/api/undo-done",
			postInit({ cardId: "cccccccccccccccccccccccc", list: HOME_ID }, cookie),
			ENV,
		);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
		const putParams = fetchSpy.mock.calls
			.filter(([, init]) => init?.method === "PUT")
			.map(([url]) => new URL(url as string).searchParams);
		// Order matters (v1.16.1): move back FIRST, then clear the flag — a
		// failed clear must leave the card visible, not stranded in Done-do.
		expect(putParams[0].get("idList")).toBe(HOME_ID);
		expect(putParams[1].get("dueComplete")).toBe("false");
	});
});

describe("dashboard security headers", () => {
	// A string assertion about headers, not proof the page renders under them —
	// that was verified by loading the real page in Chromium with this exact
	// policy and observing zero violations. This test exists so the header
	// cannot be silently dropped later.
	it("serves the dashboard with a CSP that blocks exfiltration", async () => {
		const { DashboardHandler } = await import("../src/dashboard/handler");
		const res = await DashboardHandler.fetch(
			new Request("https://example.com/dashboard", { headers: { Cookie: await sessionFor("dannbleeker") } }),
			ENV as unknown as Parameters<typeof DashboardHandler.fetch>[1],
		);
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(res.status).toBe(200);
		// The two directives that do the work: no outbound fetch/XHR to another
		// origin, and no remote image beacon.
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("img-src 'self' data:");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		// X-Frame-Options stays: old Safari honours only that.
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});
});
