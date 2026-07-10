// Snooze Power-Up integration tests (v1.15.0): pluginData parsing,
// list_snoozed_cards, wake_card guards + happy path, the dashboard API
// routes, and the digest's "Waking today" section. fetch mocked throughout.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApi } from "../src/dashboard/api";
import { createSessionCookie } from "../src/dashboard/session";
import { renderDigest } from "../src/digest/render";
import { TrelloClient, type TrelloCard } from "../src/trello/client";
import { BOARD_ALIASES, DEFAULT_TIMEZONE, LIST_ALIASES, SNOOZE_PLUGIN_ID } from "../src/trello/constants";
import { GuardError } from "../src/trello/guards";
import { list_snoozed_cards, parseSnoozeWakeMs, wake_card, type SnoozedCard } from "../src/trello/tools";

const BOARD_ID = BOARD_ALIASES["dann-to-do"];
const BUTLER_ID = "59be61509a1e3922fb72ddf7";
const client = new TrelloClient("k", "t");

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

function snoozeData(cardId: string, unixTime: number, idPlugin = SNOOZE_PLUGIN_ID) {
	return {
		access: "shared",
		dateLastUpdated: "2026-07-10T16:00:00.000Z",
		id: "pd1",
		idModel: cardId,
		idPlugin,
		scope: "card",
		value: JSON.stringify({ snooze: { idCard: cardId, unixTime } }),
	};
}

function mockFetch(handler: (url: URL, method: string) => unknown) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(typeof input === "string" ? input : (input as Request).url);
		const method = (init?.method ?? "GET").toUpperCase();
		return new Response(JSON.stringify(handler(url, method)), {
			headers: { "Content-Type": "application/json" },
			status: 200,
		});
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseSnoozeWakeMs", () => {
	const NOW = 1_784_000_000; // epoch seconds

	it("extracts the wake time in ms from valid snooze pluginData", () => {
		const c = card({ closed: true, pluginData: [snoozeData("c1", NOW)] });
		expect(parseSnoozeWakeMs(c)).toBe(NOW * 1000);
	});

	it("returns null for foreign plugins, malformed JSON, bad shapes, and missing pluginData", () => {
		expect(parseSnoozeWakeMs(card())).toBeNull();
		expect(parseSnoozeWakeMs(card({ pluginData: [snoozeData("c1", NOW, "someOtherPluginId00000")] }))).toBeNull();
		expect(
			parseSnoozeWakeMs(card({ pluginData: [{ ...snoozeData("c1", NOW), value: "{not json" }] })),
		).toBeNull();
		expect(
			parseSnoozeWakeMs(
				card({ pluginData: [{ ...snoozeData("c1", NOW), value: '{"snooze":{"unixTime":"soon"}}' }] }),
			),
		).toBeNull();
	});
});

describe("list_snoozed_cards", () => {
	it("fetches closed cards with pluginData, filters to snoozed, sorts by wake, flags overdue wakes", async () => {
		const nowMs = Date.parse("2026-07-10T16:00:00Z");
		const later = Math.floor(nowMs / 1000) + 7 * 86400;
		const sooner = Math.floor(nowMs / 1000) + 3600;
		const past = Math.floor(nowMs / 1000) - 3600;
		const fetchSpy = mockFetch((url) => {
			expect(url.pathname).toBe(`/1/boards/${BOARD_ID}/cards`);
			expect(url.searchParams.get("filter")).toBe("closed");
			expect(url.searchParams.get("pluginData")).toBe("true");
			return [
				card({ closed: true, id: "late", name: "Late", pluginData: [snoozeData("late", later)] }),
				card({ closed: true, id: "soon", name: "Soon", pluginData: [snoozeData("soon", sooner)] }),
				card({ closed: true, id: "past", name: "Past", pluginData: [snoozeData("past", past)] }),
				card({ closed: true, id: "plain", name: "Plain archived, not snoozed" }),
			];
		});
		const { snoozed } = await list_snoozed_cards(client, {}, nowMs);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(snoozed.map((s) => s.id)).toEqual(["past", "soon", "late"]);
		expect(snoozed[0].overdueWake).toBe(true);
		expect(snoozed[1].overdueWake).toBe(false);
		expect(snoozed[1].homeListAlias).toBe("@computer");
	});
});

describe("wake_card", () => {
	const NOW_S = Math.floor(Date.parse("2026-07-10T16:00:00Z") / 1000);

	it("refuses a card that isn't archived", async () => {
		mockFetch(() => card({ closed: false }));
		await expect(wake_card(client, { cardId: "c1" })).rejects.toBeInstanceOf(GuardError);
	});

	it("refuses an archived card without Snooze pluginData (not a blind unarchiver)", async () => {
		mockFetch(() => card({ closed: true }));
		await expect(wake_card(client, { cardId: "c1" })).rejects.toBeInstanceOf(GuardError);
	});

	it("refuses when the home list is forbidden (Butler)", async () => {
		mockFetch(() => card({ closed: true, idList: BUTLER_ID, pluginData: [snoozeData("c1", NOW_S)] }));
		await expect(wake_card(client, { cardId: "c1" })).rejects.toBeInstanceOf(GuardError);
	});

	it("unarchives a snoozed card (PUT closed=false) and returns its summary", async () => {
		const fetchSpy = mockFetch((_url, method) =>
			method === "PUT"
				? card({ closed: false })
				: card({ closed: true, pluginData: [snoozeData("c1", NOW_S)] }),
		);
		const { card: woken } = await wake_card(client, { cardId: "c1" });
		expect(woken.id).toBe("c1");
		const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT");
		expect(new URL(putCall![0] as string).searchParams.get("closed")).toBe("false");
	});
});

describe("dashboard snooze API", () => {
	const ENV = {
		COOKIE_ENCRYPTION_KEY: "test-cookie-encryption-key-0123456789abcdef",
		GITHUB_CLIENT_ID: "x",
		GITHUB_CLIENT_SECRET: "y",
		TRELLO_KEY: "k",
		TRELLO_TOKEN: "t",
	};

	async function cookie() {
		return (await createSessionCookie("dannbleeker", ENV.COOKIE_ENCRYPTION_KEY)).split(";")[0];
	}

	it("GET /api/snoozed requires a session", async () => {
		const res = await DashboardApi.request("/api/snoozed", {}, ENV);
		expect(res.status).toBe(401);
	});

	it("GET /api/snoozed returns the snoozed list", async () => {
		const nowS = Math.floor(Date.now() / 1000) + 3600;
		mockFetch(() => [card({ closed: true, id: "s1", pluginData: [snoozeData("s1", nowS)] })]);
		const res = await DashboardApi.request("/api/snoozed", { headers: { Cookie: await cookie() } }, ENV);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.snoozed).toHaveLength(1);
		expect(body.snoozed[0].id).toBe("s1");
	});

	it("POST /api/wake validates cardId and surfaces guard refusals as 403", async () => {
		const c = await cookie();
		const bad = await DashboardApi.request(
			"/api/wake",
			{ body: JSON.stringify({}), headers: { "Content-Type": "application/json", Cookie: c }, method: "POST" },
			ENV,
		);
		expect(bad.status).toBe(400);

		mockFetch(() => card({ closed: false })); // not archived → GuardError → 403
		const refused = await DashboardApi.request(
			"/api/wake",
			{ body: JSON.stringify({ cardId: "c1" }), headers: { "Content-Type": "application/json", Cookie: c }, method: "POST" },
			ENV,
		);
		expect(refused.status).toBe(403);
	});
});

describe("digest 'Waking today' section", () => {
	// Mid-day CEST: local day = [2026-07-09T22:00Z, 2026-07-10T22:00Z).
	const NOW = Date.parse("2026-07-10T10:00:00Z");

	function snoozedCard(overrides: Partial<SnoozedCard>): SnoozedCard {
		return {
			homeListAlias: "@computer",
			homeListId: LIST_ALIASES["@computer"],
			id: "s1",
			name: "Snoozed thing",
			overdueWake: false,
			url: "https://trello.com/c/s",
			wakeUp: "2026-07-10T16:00:00.000Z",
			...overrides,
		};
	}

	it("shows wakes inside the local day and overdue wakes; hides tomorrow's; counts in the health bar", () => {
		const { html } = renderDigest([], NOW, DEFAULT_TIMEZONE, [
			snoozedCard({ id: "today", name: "WakesToday" }),
			snoozedCard({ id: "tmrw", name: "WakesTomorrow", wakeUp: "2026-07-11T08:00:00.000Z" }),
			snoozedCard({ id: "over", name: "OverdueWake", overdueWake: true, wakeUp: "2026-07-09T08:00:00.000Z" }),
		]);
		expect(html).toContain("Waking today");
		const section = html.slice(html.indexOf("Waking today"), html.indexOf("Cards per list"));
		expect(section).toContain("WakesToday");
		expect(section).toContain("OverdueWake");
		expect(section).toContain("any moment");
		expect(section).not.toContain("WakesTomorrow");
		expect(html).toContain("Snoozed"); // health-bar stat
	});

	it("omits the section entirely when nothing wakes today", () => {
		const { html } = renderDigest([], NOW, DEFAULT_TIMEZONE, [
			snoozedCard({ wakeUp: "2026-07-20T08:00:00.000Z" }),
		]);
		expect(html).not.toContain("Waking today");
	});
});
