// v1.26.0 — the read-only review tools in src/trello/insights.ts and
// usage_report. Stub clients throughout; no network.

import { describe, expect, it, vi } from "vitest";
import type { TrelloAction, TrelloCard, TrelloClient, TrelloList } from "../src/trello/client";
import {
	BOARD_ALIASES,
	LIST_ALIASES,
	REPEATER_CARDS_LIST_ID,
	ROLLING_BIG_ROCKS_ID,
	SNOOZE_PLUGIN_ID,
} from "../src/trello/constants";
import {
	clarify_inbox,
	garbledReason,
	horizonFor,
	horizons_pack,
	isDivider,
	repeater_report,
	similarity,
	spawnStatus,
	suggestContext,
	summariseActions,
	templateFlags,
	triageCard,
	week_recap,
	wip_triage,
} from "../src/trello/insights";
import { foldToolRows, usage_report } from "../src/usage-report";

const BOARD = BOARD_ALIASES["dann-to-do"];
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function card(over: Partial<TrelloCard> = {}): TrelloCard {
	return {
		closed: false,
		dateLastActivity: iso(NOW - DAY),
		desc: "",
		due: null,
		dueComplete: false,
		dueReminder: null,
		id: "6af0a00b76e1e9420ff7745e",
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

let seq = 0;
function action(type: string, date: number, data: Record<string, unknown>): TrelloAction {
	seq += 1;
	return { data: { board: { id: BOARD, name: "Dann to-do" }, ...data }, date: iso(date), id: `a${seq}`, memberCreator: null, type };
}

const TEMPLATES = [
	{ id: "tpl-shop", name: "Foretag ugentligt indkøb" },
	{ id: "tpl-review", name: "Gennemfør Weekly Review" },
];

// ---- week_recap ---------------------------------------------------------------

describe("summariseActions", () => {
	const t0 = NOW - 3 * DAY;
	const actions = [
		// Repeater spawn: copy from a template.
		action("copyCard", t0, { card: { id: "spawn1", name: "Foretag ugentligt indkøb" }, cardSource: { id: "tpl-shop" }, list: { name: "@Errands" } }),
		// A human copy of a non-template card.
		action("copyCard", t0 + 1000, { card: { id: "copy1", name: "Copy of thing" }, cardSource: { id: "other" }, list: { name: "Inbox" } }),
		action("createCard", t0 + 2000, { card: { id: "new1", name: "New idea" }, list: { name: "Inbox" } }),
		// Completion followed 1s later by a Done move: the Butler shape.
		action("updateCard", t0 + 10_000, { card: { dueComplete: true, id: "spawn1", name: "Foretag ugentligt indkøb" }, list: { name: "@Errands" }, old: { dueComplete: false } }),
		action("updateCard", t0 + 11_000, { card: { id: "spawn1", name: "Foretag ugentligt indkøb" }, listAfter: { name: "Done-do" }, listBefore: { name: "@Errands" }, old: { idList: "x" } }),
		// A human drag into a Done-like list with no completion first: counts as completed AND a move.
		action("updateCard", t0 + 60_000, { card: { id: "z1", name: "Agenda item" }, listAfter: { name: "Completed" }, listBefore: { name: "Under Discussion" }, old: { idList: "y" } }),
		action("updateCard", t0 + 61_000, { card: { id: "z2", name: "Other item" }, listAfter: { name: "Under Discussion" }, listBefore: { name: "Meeting Backlog" }, old: { idList: "y" } }),
		action("updateCheckItemStateOnCard", t0 + 70_000, { card: { id: "rev", name: "Gennemfør Weekly Review" }, checkItem: { state: "complete" } }),
		action("updateCheckItemStateOnCard", t0 + 71_000, { card: { id: "rev", name: "Gennemfør Weekly Review" }, checkItem: { state: "complete" } }),
		action("updateCustomFieldItem", t0 + 80_000, { card: { id: "r1", name: "Roadmap" } }),
		action("updateCard", t0 + 90_000, { card: { closed: true, id: "old", name: "Old" }, old: { closed: false } }),
		action("commentCard", t0 + 95_000, { card: { id: "c", name: "C" } }),
		action("deleteCard", t0 + 96_000, {}),
	];
	const recap = summariseActions(actions, TEMPLATES, { maxNames: 30, since: iso(NOW - 7 * DAY), truncated: false, until: iso(NOW) });

	it("splits Repeater spawns out of created", () => {
		expect(recap.automation.repeaterSpawned.count).toBe(1);
		expect(recap.human.created.count).toBe(2);
		expect(recap.human.created.cards.map((c) => c.name)).toEqual(["New idea", "Copy of thing"]);
	});

	it("treats a Done move seconds after completion as automation, not a second completion", () => {
		expect(recap.automation.autoMovedToDone).toBe(1);
		expect(recap.human.completed.count).toBe(2);
		expect(recap.human.moved.count).toBe(2);
	});

	it("marks completed Repeater chores as recurring", () => {
		const chore = recap.human.completed.cards.find((c) => c.name === "Foretag ugentligt indkøb");
		expect(chore?.recurring).toBe(true);
		expect(recap.human.completed.recurring).toBe(1);
	});

	it("counts ticks, field edits, archive, comments, deletes", () => {
		expect(recap.human.checklistTicks).toEqual({ byCard: [{ count: 2, name: "Gennemfør Weekly Review" }], count: 2 });
		expect(recap.human.customFieldEdits).toBe(1);
		expect(recap.human.archived).toBe(1);
		expect(recap.human.comments).toBe(1);
		expect(recap.human.deleted).toBe(1);
	});

	it("leaves automation out of byDay and byBoard", () => {
		const human = Object.values(recap.byDay).reduce((a, b) => a + b, 0);
		expect(human).toBe(actions.length - 2);
		expect(recap.byBoard[0]).toMatchObject({ actions: actions.length - 2, board: "Dann to-do", completed: 2, created: 2 });
	});

	it("a Done move long after completion is a human move", () => {
		const r = summariseActions(
			[
				action("updateCard", t0, { card: { dueComplete: true, id: "k", name: "K" }, old: { dueComplete: false } }),
				action("updateCard", t0 + 60_000, { card: { id: "k", name: "K" }, listAfter: { name: "Done-do" }, listBefore: { name: "@Home" }, old: {} }),
			],
			[],
			{ maxNames: 5, since: "", truncated: false, until: "" },
		);
		expect(r.automation.autoMovedToDone).toBe(0);
		expect(r.human.moved.count).toBe(1);
		expect(r.human.completed.count).toBe(1);
	});
});

describe("week_recap", () => {
	it("pages backwards with the oldest action ID as cursor, scopes to a board", async () => {
		const page1 = Array.from({ length: 1000 }, (_, i) => action("commentCard", NOW - i * 1000, { card: { id: "c", name: "c" } }));
		const page2 = [action("commentCard", NOW - 2 * DAY, { board: { id: "other", name: "Zoo" }, card: { id: "z", name: "z" } })];
		const listMyActionsPage = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
		const client = { listCardsOnList: vi.fn().mockResolvedValue([]), listMyActionsPage } as unknown as TrelloClient;
		const out = await week_recap(client, { board: BOARD }, NOW);
		expect(listMyActionsPage).toHaveBeenCalledTimes(2);
		expect(listMyActionsPage.mock.calls[1][0].before).toBe(page1[999].id);
		expect(out.actionsScanned).toBe(1000); // the Zoo action is filtered out
		expect(out.truncated).toBe(false);
	});

	it("rejects a bad since", async () => {
		await expect(week_recap({} as TrelloClient, { since: "last tuesday" }, NOW)).rejects.toThrow("ISO 8601");
	});
});

// ---- repeater_report ----------------------------------------------------------

describe("repeater_report", () => {
	it("spawnStatus", () => {
		const done = new Set(["done"]);
		expect(spawnStatus(null, done)).toBe("deleted");
		expect(spawnStatus({ closed: false, dueComplete: true, idList: "x" }, done)).toBe("completed");
		expect(spawnStatus({ closed: false, dueComplete: false, idList: "done" }, done)).toBe("completed");
		expect(spawnStatus({ closed: false, dueComplete: false, idList: "x" }, done)).toBe("open");
		expect(spawnStatus({ closed: true, dueComplete: false, idList: "x" }, done)).toBe("archived");
		expect(
			spawnStatus(
				{
					closed: true,
					dueComplete: false,
					idList: "x",
					pluginData: [{ access: "shared", dateLastUpdated: "", id: "p", idModel: "c", idPlugin: SNOOZE_PLUGIN_ID, scope: "card", value: JSON.stringify({ snooze: { unixTime: 1 } }) }],
				},
				done,
			),
		).toBe("snoozed");
	});

	it("isDivider", () => {
		expect(["---", "— — —", "", "  "].every(isDivider)).toBe(true);
		expect(isDivider("Vask vasketøj")).toBe(false);
	});

	it("templateFlags", () => {
		expect(templateFlags({ archived: 0, completed: 0, open: 0, spawns: 0 })).toEqual([]);
		expect(templateFlags({ archived: 0, completed: 0, open: 3, spawns: 3 })).toEqual(["stacking: 3 copies open at once", "never completed in window"]);
		expect(templateFlags({ archived: 0, completed: 1, open: 1, spawns: 4 })).toEqual(["completed less than half the time"]);
		expect(templateFlags({ archived: 1, completed: 3, open: 0, spawns: 4 })).toEqual([]);
	});

	it("joins templates, copyCard actions and current card state", async () => {
		const lists: TrelloList[] = [
			{ closed: false, id: REPEATER_CARDS_LIST_ID, idBoard: BOARD, name: "Repeater Cards" },
			{ closed: false, id: LIST_ALIASES.done, idBoard: BOARD, name: "Done-do" },
		];
		const copies = [
			action("copyCard", NOW - 1 * DAY, { card: { id: "s1" }, cardSource: { id: "tpl-shop" }, list: { name: "@Errands" } }),
			action("copyCard", NOW - 8 * DAY, { card: { id: "s2" }, cardSource: { id: "tpl-shop" }, list: { name: "@Errands" } }),
			action("copyCard", NOW - 2 * DAY, { card: { id: "h1" }, cardSource: { id: "not-a-template" }, list: { name: "Inbox" } }),
		];
		const batchGet = vi.fn().mockResolvedValue([
			{ body: { closed: false, dueComplete: false, id: "s1", idList: LIST_ALIASES["@errands"] }, statusCode: 200 },
			{ body: { closed: false, dueComplete: true, id: "s2", idList: LIST_ALIASES.done }, statusCode: 200 },
		]);
		const client = {
			batchGet,
			listBoardActionsPage: vi.fn().mockResolvedValue(copies),
			listCardsOnList: vi
				.fn()
				.mockResolvedValue([...TEMPLATES, { id: "div", name: "---" }].map((t) => card({ id: t.id, idList: REPEATER_CARDS_LIST_ID, name: t.name }))),
			listListsOnBoard: vi.fn().mockResolvedValue(lists),
		} as unknown as TrelloClient;
		const out = await repeater_report(client, {}, NOW);
		expect(batchGet).toHaveBeenCalledWith(["/cards/s1?pluginData=true", "/cards/s2?pluginData=true"]);
		const shop = [...out.flagged, ...out.healthy].find((h) => h.templateId === "tpl-shop");
		expect(shop).toMatchObject({ completed: 1, doneRate: 0.5, open: 1, spawns: 2 });
		expect(shop?.openNow[0]).toMatchObject({ ageDays: 1, id: "s1", list: "@Errands" });
		// The Weekly Review template did not fire in the window: quiet, not flagged.
		expect(out.quiet).toEqual([{ name: "Gennemfør Weekly Review", templateId: "tpl-review" }]);
		expect(out.templates).toBe(2); // the "---" divider is not a template
		expect(out.totals.spawns).toBe(2);
	});

	it("refuses a board without a Repeater list", async () => {
		const client = { listListsOnBoard: vi.fn().mockResolvedValue([]) } as unknown as TrelloClient;
		await expect(repeater_report(client, {}, NOW)).rejects.toThrow("no Repeater Cards list");
	});
});

// ---- wip_triage ---------------------------------------------------------------

describe("triageCard", () => {
	const base = { desc: "", due: null, id: "c", labels: [] as { name: string }[], name: "Thing", url: "" };
	const at = (idleDaysAgo: number) => iso(NOW - idleDaysAgo * DAY);

	it("rules, first match wins", () => {
		expect(triageCard({ ...base, dateLastActivity: at(1), labels: [{ name: "Please Clarify and Organize" }] }, NOW, 21, true)).toMatchObject({ action: "clarify", target: "inbox" });
		expect(triageCard({ ...base, dateLastActivity: at(1), name: "Venter på svar fra Kim" }, NOW, 21, true)).toMatchObject({ action: "waiting", target: "waiting" });
		expect(triageCard({ ...base, dateLastActivity: at(1), due: iso(NOW + 30 * DAY) }, NOW, 21, true)).toMatchObject({ action: "snooze", target: null });
		expect(triageCard({ ...base, dateLastActivity: at(1), name: "Flyt domæner til simply.com primo 2028" }, NOW, 21, true)).toMatchObject({ action: "snooze" });
		expect(triageCard({ ...base, dateLastActivity: at(70) }, NOW, 21, true)).toMatchObject({ action: "someday", target: "someday" });
		expect(triageCard({ ...base, dateLastActivity: at(30), labels: [{ name: "BESTSELLER" }] }, NOW, 21, true)).toMatchObject({ action: "could-do", target: "could-bestseller" });
		expect(triageCard({ ...base, dateLastActivity: at(2) }, NOW, 21, true)).toMatchObject({ action: "keep" });
	});

	it("no list targets off dann-to-do", () => {
		expect(triageCard({ ...base, dateLastActivity: at(70) }, NOW, 21, false).target).toBeNull();
	});

	it("horizonFor maps labels to Could-do lists", () => {
		expect(horizonFor(["SSF"])).toBe("could-ssf");
		expect(horizonFor(["DBP Invest"])).toBe("could-dbp-invest");
		expect(horizonFor([])).toBe("could-personal");
	});
});

describe("wip_triage", () => {
	const lists: TrelloList[] = [
		{ closed: false, id: LIST_ALIASES["@computer"], idBoard: BOARD, name: "@Computer (WIP limit 2)" },
		{ closed: false, id: LIST_ALIASES["@home"], idBoard: BOARD, name: "@Home (WIP limit 5)" },
	];
	const cards = [
		card({ dateLastActivity: iso(NOW - 80 * DAY), id: "old", name: "Se farve kurset færdigt" }),
		card({ dateLastActivity: iso(NOW - 25 * DAY), id: "mid", labels: [{ color: "blue", id: "l", name: "BESTSELLER" }], name: "Historien om retail" }),
		card({ dateLastActivity: iso(NOW - 1 * DAY), id: "fresh", name: "Fresh" }),
		card({ id: "h1", idList: LIST_ALIASES["@home"] }),
	];
	const client = {
		listArchivedCardsWithPluginData: vi.fn().mockResolvedValue([]),
		listCardsOnBoard: vi.fn().mockResolvedValue(cards),
		listListsOnBoard: vi.fn().mockResolvedValue(lists),
	} as unknown as TrelloClient;

	it("right after a review (nothing idle) fills up to the overflow with the oldest cards by creation", async () => {
		const fresh = (id: string, name: string) => card({ dateLastActivity: iso(NOW - DAY), id, name });
		const c2 = {
			listArchivedCardsWithPluginData: vi.fn().mockResolvedValue([]),
			// IDs carry creation time: 0x5f… is 2020, 0x6a… is 2026.
			listCardsOnBoard: vi.fn().mockResolvedValue([
				fresh("6af0a00b76e1e9420ff77401", "new"),
				fresh("5f0000000000000000000002", "ancient"),
				fresh("690000000000000000000003", "older"),
				fresh("6af0a00b76e1e9420ff77404", "newer"),
			]),
			listListsOnBoard: vi.fn().mockResolvedValue(lists),
		} as unknown as TrelloClient;
		const out = await wip_triage(c2, {}, NOW);
		expect(out.lists[0].needToMove).toBe(2);
		expect(out.lists[0].suggestions.map((s) => [s.name, s.basis])).toEqual([["ancient", "age"], ["older", "age"]]);
		expect(out.moves).toEqual([{ cardIds: ["5f0000000000000000000002", "690000000000000000000003"], target: "could-personal" }]);
	});

	it("triages only over-limit lists, most idle first, recent cards left out", async () => {
		const out = await wip_triage(client, {}, NOW);
		expect(out.lists).toHaveLength(1);
		expect(out.lists[0]).toMatchObject({ needToMove: 1, open: 3 });
		expect(out.lists[0].suggestions.map((s) => s.id)).toEqual(["old", "mid"]);
		expect(out.moves).toEqual([
			{ cardIds: ["old"], target: "someday" },
			{ cardIds: ["mid"], target: "could-bestseller" },
		]);
	});
});

// ---- horizons_pack ------------------------------------------------------------

describe("horizons_pack", () => {
	it("rocks by idleness, horizons, areas, ticklers", async () => {
		const snoozed = card({
			closed: true,
			id: "t1",
			name: "Forlæng domæne\nmore",
			pluginData: [{ access: "shared", dateLastUpdated: "", id: "p", idModel: "t1", idPlugin: SNOOZE_PLUGIN_ID, scope: "card", value: JSON.stringify({ snooze: { unixTime: Math.floor((NOW + 60 * DAY) / 1000) } }) }],
		} as Partial<TrelloCard>);
		const client = {
			listArchivedCardsWithPluginData: vi.fn().mockResolvedValue([snoozed]),
			listCardsOnBoard: vi.fn().mockResolvedValue([
				card({ dateLastActivity: iso(NOW - 40 * DAY), id: "r1", idList: ROLLING_BIG_ROCKS_ID, name: "Region East" }),
				card({ dateLastActivity: iso(NOW - 2 * DAY), id: "r2", idList: ROLLING_BIG_ROCKS_ID, name: "Black Friday" }),
				card({ dateLastActivity: iso(NOW - 10 * DAY), id: "p1", idList: LIST_ALIASES["could-personal"] }),
				card({ id: "a1", labels: [{ color: "x", id: "l", name: "BESTSELLER" }] }),
				card({ id: "a2" }),
			]),
		} as unknown as TrelloClient;
		const out = await horizons_pack(client, {}, NOW);
		expect(out.big_rocks).toMatchObject({ count: 2, stale: 1 });
		expect(out.big_rocks.rocks[0].name).toBe("Region East");
		expect(out.horizons["could-personal"]).toMatchObject({ count: 1, medianIdleDays: 10 });
		expect(out.areas).toEqual([{ label: "BESTSELLER", open: 1 }, { label: "(no label)", open: 1 }]);
		expect(out.ticklers).toEqual([{ cards: ["Forlæng domæne"], count: 1, month: "2027-01" }]);
		expect(out.questions.length).toBeGreaterThan(3);
	});

	it("refuses other boards", async () => {
		await expect(horizons_pack({} as TrelloClient, { board: "64ff6c30bf9776f75b04e3fa" }, NOW)).rejects.toThrow("dann-to-do-shaped");
	});
});

// ---- clarify_inbox -------------------------------------------------------------

describe("clarify_inbox helpers", () => {
	it("garbledReason flags the dictation slip, passes real one-word titles", () => {
		expect(garbledReason("Lllmnstufio")).toContain("three times");
		expect(garbledReason("Xkcdprst")).toContain("consonants");
		expect(garbledReason("ab")).toContain("under three");
		for (const ok of ["Heartwood", "Måske", "Google contacts to Heartwood", "Strømpebukser", "PowerBi"]) {
			expect(garbledReason(ok)).toBeNull();
		}
	});

	it("suggestContext", () => {
		expect(suggestContext("Ring til mor og far").list).toBe("@phone");
		expect(suggestContext("Køb gaveæske").list).toBe("@errands");
		expect(suggestContext("Rengør isterningmaskine").list).toBe("@home");
		expect(suggestContext("Snak med Lene om ferie").list).toBe("@lene");
		expect(suggestContext("Hvorfor er der altid koldt på et fly?").list).toBe("someday");
		expect(suggestContext("Hvorfor er der altid koldt på et fly").list).toBe("someday");
		expect(suggestContext("Hvordan").list).toBe("someday");
		expect(suggestContext("Hvorup Kirke").list).toBe("@computer"); // starts with "Hvor…" but is not the word
		expect(suggestContext("Google contacts to Heartwood").list).toBe("@computer");
	});

	it("similarity ignores stopwords and needs shared content words", () => {
		expect(similarity("Google contacts to Heartwood", "Heartwood for multiple users").shared).toBe(1);
		expect(similarity("Plan trip to India", "Plan trip to India for AC").score).toBeGreaterThanOrEqual(0.5);
	});
});

describe("clarify_inbox", () => {
	it("one row per inbox card with flags, suggestion and duplicates", async () => {
		const lists: TrelloList[] = [
			{ closed: false, id: LIST_ALIASES.inbox, idBoard: BOARD, name: "Inbox" },
			{ closed: false, id: LIST_ALIASES["@computer"], idBoard: BOARD, name: "@Computer (WIP limit 7)" },
		];
		const client = {
			listCardsOnBoard: vi.fn().mockResolvedValue([
				card({ id: "6af0a00b76e1e9420ff7745e", idList: LIST_ALIASES.inbox, name: "Lllmnstufio" }),
				card({ desc: "From: Kim\nSent: today", id: "6af0a00b76e1e9420ff7745f", idList: LIST_ALIASES.inbox, name: "Plan trip to India" }),
				card({ id: "6a0ed3b63cfae9d4af267b32", name: "Plan trip to India for AC" }),
			]),
			listListsOnBoard: vi.fn().mockResolvedValue(lists),
		} as unknown as TrelloClient;
		const out = await clarify_inbox(client, {}, NOW);
		expect(out.inbox).toBe(2);
		expect(out.cards[0].suggestion.list).toBe("(delete or re-capture)");
		expect(out.cards[0].flags[0]).toContain("garbled");
		expect(out.cards[1].flags).toEqual(["description is a pasted email: pull the action out of it", "possible duplicate"]);
		expect(out.cards[1].possibleDuplicates[0]).toMatchObject({ list: "@computer", name: "Plan trip to India for AC" });
		// Age comes from the card ID's timestamp (2026-11-08 16:15 UTC is after NOW → clamped to 0).
		expect(out.cards[0].ageDays).toBe(0);
	});
});

// ---- usage_report ---------------------------------------------------------------

describe("usage_report", () => {
	it("folds per-outcome rows into per-tool rows", () => {
		const rows = foldToolRows([
			{ avgMs: 100, lastTs: 1000, n: 8, name: "list_cards", outcome: "ok" },
			{ avgMs: 50, lastTs: 2000, n: 2, name: "list_cards", outcome: "guard" },
			{ avgMs: null, lastTs: null, n: 1, name: "get_card", outcome: "ok" },
		]);
		expect(rows[0]).toMatchObject({ avgMs: 90, calls: 10, errorRate: 0.2, guard: 2, lastUsed: iso(2000), name: "list_cards", ok: 8 });
		expect(rows[1]).toMatchObject({ avgMs: null, calls: 1, name: "get_card" });
	});

	it("without USAGE_DB: disabled with a note, registered count kept", async () => {
		const out = await usage_report(undefined, ["a", "b"], {}, NOW);
		expect(out.enabled).toBe(false);
		expect(out.totals.registered).toBe(2);
		expect(out.note).toContain("USAGE_DB");
	});

	it("lists never-called tools against the registered set and flags failing ones", async () => {
		const prepared: { sql: string; binds: unknown[] }[] = [];
		const db = {
			prepare: (sql: string) => ({
				bind: (...binds: unknown[]) => {
					prepared.push({ binds, sql });
					return {
						all: async () =>
							sql.includes("kind = 'tool'")
								? { results: [{ avgMs: 10, lastTs: NOW, n: 2, name: "list_cards", outcome: "ok" }, { avgMs: 10, lastTs: NOW, n: 3, name: "move_card", outcome: "guard" }] }
								: { results: [{ calls: 9, name: "GET /boards/{id}/cards", retried: 1 }] },
					};
				},
			}),
		} as unknown as D1Database;
		const out = await usage_report(db, ["list_cards", "move_card", "vote_card"], { days: 7 }, NOW);
		expect(out.neverCalled).toEqual(["vote_card"]);
		expect(out.failing.map((t) => t.name)).toEqual(["move_card"]);
		expect(out.endpoints[0]).toEqual({ calls: 9, name: "GET /boards/{id}/cards", retried: 1 });
		expect(prepared[0].binds).toEqual([NOW - 7 * 86_400_000, "mcp"]);
	});

	it("surface 'all' drops the surface filter", async () => {
		const sqls: string[] = [];
		const db = {
			prepare: (sql: string) => {
				sqls.push(sql);
				return { bind: () => ({ all: async () => ({ results: [] }) }) };
			},
		} as unknown as D1Database;
		await usage_report(db, [], { surface: "all" }, NOW);
		expect(sqls.every((s) => !s.includes("surface ="))).toBe(true);
	});
});
