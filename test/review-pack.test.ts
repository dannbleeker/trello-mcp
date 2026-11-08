// v1.26.0 — weekly_review_pack reads the Snooze Power-Up, forecasts WIP after
// this week's wakes, and remembers the previous review in KV. Plus the pure
// review-history helpers and the per-row custom-field batch.

import { describe, expect, it, vi } from "vitest";
import type { TrelloCard, TrelloClient, TrelloCustomField, TrelloList } from "../src/trello/client";
import { BOARD_ALIASES, LIST_ALIASES, REPEATER_CARDS_LIST_ID, SNOOZE_PLUGIN_ID } from "../src/trello/constants";
import {
	REVIEW_SNAPSHOT_PREFIX,
	daysBetween,
	pickHistoryDates,
	recordAndCompare,
	reviewDelta,
	type ReviewSnapshot,
} from "../src/trello/review-history";
import {
	batch_set_card_custom_fields,
	snoozeSection,
	weekly_review_pack,
	wipStatuses,
	type SnoozedCard,
} from "../src/trello/tools";

const BOARD = BOARD_ALIASES["dann-to-do"];
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;

function card(over: Partial<TrelloCard> = {}): TrelloCard {
	return {
		closed: false,
		dateLastActivity: "2026-11-01T00:00:00.000Z",
		desc: "",
		due: null,
		dueComplete: false,
		dueReminder: null,
		id: "c1",
		idBoard: BOARD,
		idList: LIST_ALIASES["@computer"],
		idMembers: [],
		labels: [],
		name: "Card",
		start: null,
		url: "https://trello.com/c/x",
		...over,
	};
}

function snoozedCard(id: string, idList: string, wakeMs: number): TrelloCard {
	return card({
		closed: true,
		id,
		idList,
		pluginData: [
			{
				access: "shared",
				dateLastUpdated: "2026-11-01T00:00:00.000Z",
				id: `pd-${id}`,
				idModel: id,
				idPlugin: SNOOZE_PLUGIN_ID,
				scope: "card",
				value: JSON.stringify({ snooze: { idCard: id, unixTime: Math.floor(wakeMs / 1000) } }),
			},
		],
	} as Partial<TrelloCard>);
}

const LISTS: TrelloList[] = [
	{ closed: false, id: LIST_ALIASES["@computer"], idBoard: BOARD, name: "@Computer (WIP limit 7)" },
	{ closed: false, id: LIST_ALIASES["@home"], idBoard: BOARD, name: "@Home (WIP limit 5)" },
	{ closed: false, id: LIST_ALIASES.waiting, idBoard: BOARD, name: "Waiting for..." },
	{ closed: false, id: REPEATER_CARDS_LIST_ID, idBoard: BOARD, name: "Repeater Cards" },
];

function fakeKV(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const kv = {
		get: vi.fn(async (k: string) => store.get(k) ?? null),
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
		})),
		put: vi.fn(async (k: string, v: string) => {
			store.set(k, v);
		}),
	};
	return { kv: kv as unknown as KVNamespace, raw: kv, store };
}

function packClient(open: TrelloCard[], archived: TrelloCard[]): TrelloClient {
	return {
		getBoard: vi.fn().mockResolvedValue({ id: BOARD, name: "Dann to-do", url: "https://trello.com/b/x" }),
		listArchivedCardsWithPluginData: vi.fn().mockResolvedValue(archived),
		listCardsOnBoard: vi.fn().mockResolvedValue(open),
		listListsOnBoard: vi.fn().mockResolvedValue(LISTS),
	} as unknown as TrelloClient;
}

describe("weekly_review_pack — Snooze Power-Up", () => {
	it("counts Power-Up snoozes, not dueReminder, and keeps the old count as `reminders`", async () => {
		const open = [card({ dueReminder: 1440, id: "r1" }), card({ id: "r2" })];
		const archived = [
			snoozedCard("s1", LIST_ALIASES["@computer"], NOW + 1 * DAY),
			snoozedCard("s2", LIST_ALIASES.waiting, NOW + 20 * DAY),
			snoozedCard("s3", LIST_ALIASES.done, NOW - 10 * DAY), // wake did not fire
			card({ closed: true, id: "plain-archived" }), // archived, not snoozed
		];
		const pack = await weekly_review_pack(packClient(open, archived), {}, { nowMs: NOW });
		expect(pack.snoozed.count).toBe(3);
		expect(pack.reminders.count).toBe(1);
		expect(pack.snoozed.overdueWake.map((s) => s.id)).toEqual(["s3"]);
		expect(pack.snoozed.waking_7d.map((s) => s.id)).toEqual(["s1"]);
		expect(pack.snoozed.waking_14d_count).toBe(1);
		expect(pack.snoozed.byHomeList).toEqual({ "@computer": 1, done: 1, waiting: 1 });
		expect(pack.waiting.snoozed).toBe(1);
	});

	it("forecasts WIP with this week's wakes added", async () => {
		const open = Array.from({ length: 8 }, (_, i) => card({ id: `c${i}` }));
		const archived = [
			snoozedCard("s1", LIST_ALIASES["@computer"], NOW + 2 * DAY),
			snoozedCard("s2", LIST_ALIASES["@computer"], NOW + 30 * DAY), // outside the week
		];
		const pack = await weekly_review_pack(packClient(open, archived), {}, { nowMs: NOW });
		const computer = pack.wip.find((w) => w.alias === "@computer");
		expect(computer).toMatchObject({ forecast7d: 9, limit: 7, open: 8, over: 1, overAfterWakes: 2, wakingNext7d: 1 });
		// Only lists with a WIP suffix are reported.
		expect(pack.wip.map((w) => w.alias)).toEqual(["@computer", "@home"]);
	});

	it("returns trend: null without KV and does not touch storage", async () => {
		const pack = await weekly_review_pack(packClient([card()], []), {}, { nowMs: NOW });
		expect(pack.trend).toBeNull();
	});

	it("with KV: compares against last week's snapshot and stores today's", async () => {
		const prev: ReviewSnapshot = {
			big_rocks: 6,
			contexts: { "@computer": 5, "@errands": 0, "@home": 4, "@lene": 4, "@phone": 1 },
			could_do: {},
			date: "2026-11-01",
			inbox: 10,
			snoozed: 0,
			waiting: 1,
		};
		const { kv, store } = fakeKV({
			[`${REVIEW_SNAPSHOT_PREFIX}2026-11-01`]: JSON.stringify(prev),
			[`${REVIEW_SNAPSHOT_PREFIX}2026-11-07`]: JSON.stringify({ ...prev, date: "2026-11-07" }), // too recent
		});
		const open = Array.from({ length: 8 }, (_, i) => card({ id: `c${i}` }));
		const pack = await weekly_review_pack(packClient(open, []), {}, { kv, nowMs: NOW });
		expect(pack.trend?.previous?.date).toBe("2026-11-01");
		expect(pack.trend?.delta?.contexts["@computer"]).toBe(3);
		expect(pack.trend?.delta?.inbox).toBe(-10);
		expect(pack.trend?.delta?.daysAgo).toBe(7);
		expect(store.has(`${REVIEW_SNAPSHOT_PREFIX}2026-11-08`)).toBe(true);
	});

	it("a KV failure degrades to an empty trend, never a failed review", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const kv = {
			get: vi.fn(),
			list: vi.fn().mockRejectedValue(new Error("kv down")),
			put: vi.fn().mockRejectedValue(new Error("kv down")),
		} as unknown as KVNamespace;
		const pack = await weekly_review_pack(packClient([card()], []), {}, { kv, nowMs: NOW });
		spy.mockRestore();
		expect(pack.trend?.previous).toBeNull();
		expect(pack.trend?.history).toHaveLength(1);
	});
});

describe("snoozeSection / wipStatuses (pure)", () => {
	const s = (id: string, wake: number, home = LIST_ALIASES["@computer"], overdue = false): SnoozedCard => ({
		homeListAlias: null,
		homeListId: home,
		id,
		name: id,
		overdueWake: overdue,
		url: "",
		wakeUp: new Date(wake).toISOString(),
	});

	it("counts the tickler tail beyond 90 days", () => {
		const out = snoozeSection([s("a", NOW + 100 * DAY), s("b", NOW + 3 * DAY)], NOW, 25);
		expect(out.beyond_90d_count).toBe(1);
		expect(out.waking_7d).toHaveLength(1);
	});

	it("an overdue wake counts as waking for the WIP forecast", () => {
		const [w] = wipStatuses([LISTS[0]], [], [s("x", NOW - DAY, LIST_ALIASES["@computer"], true)], NOW);
		expect(w.wakingNext7d).toBe(1);
	});

	it("skips closed lists", () => {
		expect(wipStatuses([{ ...LISTS[0], closed: true }], [], [], NOW)).toEqual([]);
	});
});

describe("review-history (pure)", () => {
	it("daysBetween", () => {
		expect(daysBetween("2026-11-01", "2026-11-08")).toBe(7);
	});

	it("pickHistoryDates walks back in ≥5-day steps, newest first, max 4", () => {
		const dates = ["2026-11-07", "2026-11-03", "2026-11-01", "2026-10-30", "2026-10-25", "2026-10-18", "2026-10-11", "2026-10-04", "2026-11-08"];
		expect(pickHistoryDates(dates, "2026-11-08")).toEqual(["2026-11-03", "2026-10-25", "2026-10-18", "2026-10-11"]);
	});

	it("reviewDelta covers keys present on only one side", () => {
		const a: ReviewSnapshot = { big_rocks: 1, contexts: { x: 1 }, could_do: {}, date: "2026-11-01", inbox: 0, snoozed: 0, waiting: 0 };
		const b: ReviewSnapshot = { ...a, contexts: { y: 2 }, date: "2026-11-08" };
		expect(reviewDelta(b, a).contexts).toEqual({ x: -1, y: 2 });
	});

	it("recordAndCompare ignores malformed stored values", async () => {
		const { kv } = fakeKV({ [`${REVIEW_SNAPSHOT_PREFIX}2026-11-01`]: "{not json" });
		const t = await recordAndCompare(kv, { big_rocks: 0, contexts: {}, could_do: {}, date: "2026-11-08", inbox: 0, snoozed: 0, waiting: 0 });
		expect(t.previous).toBeNull();
	});
});

describe("batch_set_card_custom_fields", () => {
	const START: TrelloCustomField = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", idModel: "b1", modelType: "board", name: "Start month", pos: 1, type: "date" };
	const END: TrelloCustomField = { id: "bbbbbbbbbbbbbbbbbbbbbbbb", idModel: "b1", modelType: "board", name: "End month", pos: 2, type: "date" };
	const PRIO: TrelloCustomField = { id: "cccccccccccccccccccccccc", idModel: "b1", modelType: "board", name: "Priority", pos: 3, type: "number" };

	function client() {
		const set = vi.fn().mockResolvedValue(null);
		const c = {
			getCard: vi.fn(async (id: string) => ({ id, idBoard: "b1", idList: "list1" })),
			listBoardPlugins: vi.fn().mockResolvedValue([]),
			listCustomFields: vi.fn().mockResolvedValue([START, END, PRIO]),
			setCardCustomFieldItem: set,
		};
		return { c: c as unknown as TrelloClient, raw: c, set };
	}

	const rows = [
		{ cardId: "card1", customFieldId: "Start month", value: { date: "2026-12-01T00:00:00.000Z" } },
		{ cardId: "card1", customFieldId: "End month", value: { date: "2027-03-01T00:00:00.000Z" } },
		{ cardId: "card2", customFieldId: "Start month", value: { date: "2027-01-01T00:00:00.000Z" } },
	];

	it("writes different fields/values per row, fetching each card and the definitions once", async () => {
		const { c, raw, set } = client();
		const out = await batch_set_card_custom_fields(c, { rows });
		expect(out).toMatchObject({ dryRun: false, failed: 0, updated: 3 });
		expect(set).toHaveBeenCalledWith("card1", START.id, { value: { date: "2026-12-01T00:00:00.000Z" } });
		expect(set).toHaveBeenCalledWith("card1", END.id, { value: { date: "2027-03-01T00:00:00.000Z" } });
		expect(raw.getCard).toHaveBeenCalledTimes(2);
		expect(raw.listCustomFields).toHaveBeenCalledTimes(1);
	});

	it("dryRun validates every row and writes nothing", async () => {
		const { c, set } = client();
		const out = await batch_set_card_custom_fields(c, {
			dryRun: true,
			rows: [...rows, { cardId: "card3", customFieldId: "Priority", value: { text: "high" } }],
		});
		expect(set).not.toHaveBeenCalled();
		expect(out.updated).toBe(0);
		expect(out.failed).toBe(1);
		expect(out.results[3].reason).toContain('is type "number"');
		expect(out.results.slice(0, 3).every((r) => r.ok)).toBe(true);
	});

	it("refuses a second row for the same card + field, keeps the rest", async () => {
		const { c, set } = client();
		const out = await batch_set_card_custom_fields(c, {
			rows: [rows[0], { ...rows[0], value: { date: "2027-06-01T00:00:00.000Z" } }],
		});
		expect(out.updated).toBe(1);
		expect(out.results[1].ok).toBe(false);
		expect(out.results[1].reason).toContain("earlier row");
		expect(set).toHaveBeenCalledTimes(1);
	});

	it("an unknown field fails that row only", async () => {
		const { c } = client();
		const out = await batch_set_card_custom_fields(c, {
			rows: [rows[0], { cardId: "card2", customFieldId: "Nope", value: null }],
		});
		expect(out.updated).toBe(1);
		expect(out.results[1]).toMatchObject({ field: null, ok: false });
	});

	it("refuses an empty or oversized batch", async () => {
		const { c } = client();
		await expect(batch_set_card_custom_fields(c, { rows: [] })).rejects.toThrow("non-empty");
		await expect(batch_set_card_custom_fields(c, { rows: Array(51).fill(rows[0]) })).rejects.toThrow("capped at 50");
	});
});
