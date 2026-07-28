import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrelloClient } from "../src/trello/client";
import { GuardError } from "../src/trello/guards";
import {
	DIRECTORY_TTL_MS,
	boardLists,
	invalidateDirectory,
	invalidateLists,
	matchByName,
	memberBoards,
	memberWorkspaces,
	resolveBoardRef,
	resolveListRef,
	resolveWorkspaceRef,
} from "../src/trello/resolve";
import {
	archive_list,
	create_card,
	list_boards,
	list_cards,
	list_my_cards_assigned,
	list_workspaces,
	move_list,
	search_cards,
	search_cards_advanced,
} from "../src/trello/tools";
import { BOARD_ALIASES, LIST_ALIASES } from "../src/trello/constants";

// The multi-workspace contract (v1.19.0). These tests fake Trello at the
// fetch layer so a board's workspace, a board name collision across two
// workspaces, and a list name that exists on three boards are all exercised
// exactly as the Worker would see them.

const DANN_TODO = BOARD_ALIASES["dann-to-do"];
const ZOO = BOARD_ALIASES.zoo;
const NEW_BOARD = "6a6711c43b20b9486ab1c9f6"; // board added with the new workspace

const ORG_PERSONAL = "5000000000000000000000a1";
const ORG_NEW = "5000000000000000000000b2";

const WORKSPACES = [
	{
		id: ORG_PERSONAL,
		name: "dannbleekerpedersen",
		displayName: "Dann's Workspace",
		url: "https://trello.com/w/dannbleekerpedersen",
	},
	{
		id: ORG_NEW,
		name: "frontlinetech",
		displayName: "Frontline Tech",
		url: "https://trello.com/w/frontlinetech",
	},
];

const BOARDS = [
	{
		id: DANN_TODO,
		name: "Dann to-do",
		url: "https://trello.com/b/a7xOpx6t/dann-to-do",
		closed: false,
		idOrganization: ORG_PERSONAL,
	},
	{
		id: ZOO,
		name: "Zoo Leadership Meeting",
		url: "https://trello.com/b/B6lsCCZu/zoo-leadership-meeting",
		closed: false,
		idOrganization: ORG_PERSONAL,
	},
	{
		id: NEW_BOARD,
		name: "TECH Retail Decision Board",
		url: "https://trello.com/b/xKeUkW8V/tech-retail-decision-board",
		closed: false,
		idOrganization: ORG_NEW,
	},
	{
		// A board in no workspace at all — the case list_workspaces must not drop.
		id: "6a0000000000000000000099",
		name: "Scratch",
		url: "https://trello.com/b/zzzzzzzz/scratch",
		closed: false,
		idOrganization: null,
	},
	{
		id: "6a00000000000000000000cc",
		name: "Closed Board",
		url: "https://trello.com/b/cccccccc/closed-board",
		closed: true,
		idOrganization: ORG_NEW,
	},
];

const LISTS: Record<string, { id: string; name: string; idBoard: string; closed: boolean }[]> = {
	[DANN_TODO]: [
		{ id: LIST_ALIASES.inbox, name: "Inbox", idBoard: DANN_TODO, closed: false },
		{ id: LIST_ALIASES["@computer"], name: "@Computer (WIP limit 7)", idBoard: DANN_TODO, closed: false },
		{ id: "5900000000000000000000d1", name: "Done", idBoard: DANN_TODO, closed: false },
	],
	[ZOO]: [
		{ id: "6400000000000000000000e1", name: "Backlog", idBoard: ZOO, closed: false },
		{ id: "6400000000000000000000e2", name: "Done", idBoard: ZOO, closed: false },
	],
	[NEW_BOARD]: [
		{ id: "6a6711dece01a8a02643448c", name: "Backlog", idBoard: NEW_BOARD, closed: false },
		{ id: "6a6711f3cce0b71b2a5b427a", name: "Doing", idBoard: NEW_BOARD, closed: false },
		{ id: "6a6711ec7a817f9958a6ea16", name: "Done (since last)", idBoard: NEW_BOARD, closed: false },
		{ id: "6a6711ec7a817f9958a6ea17", name: "Archived list", idBoard: NEW_BOARD, closed: true },
	],
	"6a0000000000000000000099": [
		{ id: "6a0000000000000000000098", name: "Notes", idBoard: "6a0000000000000000000099", closed: false },
	],
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("workspace / board / list resolution", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let client: TrelloClient;
	/** Every path fetched during a test, for call-count assertions. */
	let paths: string[];

	beforeEach(() => {
		client = new TrelloClient("KEY", "TOKEN");
		paths = [];
		fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			paths.push(url.pathname);
			const p = url.pathname;
			if (p === "/1/members/me/boards") return json(BOARDS);
			if (p === "/1/members/me/organizations") return json(WORKSPACES);
			const listMatch = p.match(/^\/1\/boards\/([^/]+)\/lists$/);
			if (listMatch) return json(LISTS[listMatch[1]] ?? []);
			const orgMatch = p.match(/^\/1\/organizations\/([^/]+)$/);
			if (orgMatch) {
				const found = WORKSPACES.find((w) => w.id === orgMatch[1] || w.name === orgMatch[1]);
				return found
					? json(found)
					: new Response("model not found", { status: 404, headers: { "Content-Type": "text/plain" } });
			}
			return json({});
		});
	});

	afterEach(() => {
		invalidateDirectory(client);
		fetchSpy.mockRestore();
	});

	// ---- matchByName tiers ----

	describe("matchByName", () => {
		const items = [{ n: "Done" }, { n: "Done (since last)" }, { n: "Doing" }];
		const nameOf = (i: { n: string }) => i.n;

		it("prefers an exact match over prefix/substring ones", () => {
			expect(matchByName(items, nameOf, "done")).toEqual([{ n: "Done" }]);
		});

		it("falls back to prefix matches, returning all of them", () => {
			expect(matchByName(items, nameOf, "do")).toHaveLength(3);
		});

		it("falls back to substring matches last", () => {
			expect(matchByName(items, nameOf, "since")).toEqual([{ n: "Done (since last)" }]);
		});

		it("is whitespace- and case-insensitive", () => {
			expect(matchByName(items, nameOf, "  DOING ")).toEqual([{ n: "Doing" }]);
		});

		it("returns nothing for an empty query rather than everything", () => {
			expect(matchByName(items, nameOf, "   ")).toEqual([]);
		});
	});

	// ---- boards ----

	describe("resolveBoardRef", () => {
		it("defaults to dann-to-do and makes no API call", async () => {
			expect(await resolveBoardRef(client)).toBe(DANN_TODO);
			expect(paths).toEqual([]);
		});

		it("resolves a known alias without an API call", async () => {
			expect(await resolveBoardRef(client, "zoo")).toBe(ZOO);
			expect(paths).toEqual([]);
		});

		it("passes a raw 24-char ID straight through", async () => {
			expect(await resolveBoardRef(client, NEW_BOARD)).toBe(NEW_BOARD);
			expect(paths).toEqual([]);
		});

		it("resolves a board in a newly added workspace by name", async () => {
			expect(await resolveBoardRef(client, "TECH Retail Decision Board")).toBe(NEW_BOARD);
		});

		it("resolves by case-insensitive partial name", async () => {
			expect(await resolveBoardRef(client, "tech retail")).toBe(NEW_BOARD);
		});

		// v1.19.2 REGRESSION: this used to return the short link itself. Trello
		// accepts one wherever an ID goes, but resolveBoardRef's result is also
		// COMPARED against card.idBoard and passed to /search's idBoards, where a
		// short link matches nothing and 400s respectively.
		it("canonicalises a pasted trello.com/b/… URL to the 24-char board ID", async () => {
			expect(await resolveBoardRef(client, "https://trello.com/b/xKeUkW8V/tech-retail-decision-board")).toBe(
				NEW_BOARD,
			);
		});

		it("canonicalises from the cached board list, with no extra API call", async () => {
			await memberBoards(client); // warm
			const before = paths.length;
			await resolveBoardRef(client, "https://trello.com/b/xKeUkW8V/x");
			expect(paths.length).toBe(before);
		});

		it("falls back to fetching a board the member isn't on", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/boards") return json(BOARDS);
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				if (p === "/1/boards/pUb1icBd")
					return json({ id: "6c00000000000000000000ff", name: "Public", url: "u", closed: false });
				return json({});
			});
			expect(await resolveBoardRef(client, "https://trello.com/b/pUb1icBd/public")).toBe(
				"6c00000000000000000000ff",
			);
		});

		it("narrows a name lookup to one workspace", async () => {
			expect(await resolveBoardRef(client, "Board", { workspace: "frontlinetech" })).toBe(NEW_BOARD);
		});

		it("refuses a name that matches boards in two workspaces, naming both", async () => {
			const collide = [
				{ id: "6b00000000000000000000a1", name: "Roadmap", url: "u1", closed: false, idOrganization: ORG_PERSONAL },
				{ id: "6b00000000000000000000a2", name: "Roadmap", url: "u2", closed: false, idOrganization: ORG_NEW },
			];
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/boards") return json(collide);
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				return json({});
			});
			await expect(resolveBoardRef(client, "Roadmap")).rejects.toThrow(GuardError);
			await expect(resolveBoardRef(client, "Roadmap")).rejects.toThrow(/Dann's Workspace/);
			await expect(resolveBoardRef(client, "Roadmap")).rejects.toThrow(/Frontline Tech/);
		});

		it("disambiguates that collision with `workspace`", async () => {
			const collide = [
				{ id: "6b00000000000000000000a1", name: "Roadmap", url: "u1", closed: false, idOrganization: ORG_PERSONAL },
				{ id: "6b00000000000000000000a2", name: "Roadmap", url: "u2", closed: false, idOrganization: ORG_NEW },
			];
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/boards") return json(collide);
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				return json({});
			});
			expect(await resolveBoardRef(client, "Roadmap", { workspace: "Frontline Tech" })).toBe(
				"6b00000000000000000000a2",
			);
		});

		it("lists the known boards when nothing matches", async () => {
			await expect(resolveBoardRef(client, "Nope")).rejects.toThrow(/No board matching "Nope"/);
			await expect(resolveBoardRef(client, "Nope")).rejects.toThrow(/TECH Retail Decision Board/);
		});

		it("never resolves to a closed board", async () => {
			await expect(resolveBoardRef(client, "Closed Board")).rejects.toThrow(GuardError);
		});

		it("resolves a workspace with exactly one board from `workspace` alone", async () => {
			expect(await resolveBoardRef(client, undefined, { workspace: "frontlinetech" })).toBe(NEW_BOARD);
		});

		it("asks for a board when the workspace holds several", async () => {
			await expect(
				resolveBoardRef(client, undefined, { workspace: "Dann's Workspace" }),
			).rejects.toThrow(/has 2 boards/);
		});
	});

	// ---- workspaces ----

	describe("resolveWorkspaceRef", () => {
		it("resolves by short name", async () => {
			expect((await resolveWorkspaceRef(client, "frontlinetech")).id).toBe(ORG_NEW);
		});

		it("resolves by display name, case-insensitively", async () => {
			expect((await resolveWorkspaceRef(client, "frontline tech")).id).toBe(ORG_NEW);
		});

		it("resolves by ID", async () => {
			expect((await resolveWorkspaceRef(client, ORG_NEW)).name).toBe("frontlinetech");
		});

		it("falls back to a direct fetch for an ID outside the member's workspaces", async () => {
			const foreign = "5000000000000000000000ff";
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				if (p === `/1/organizations/${foreign}`)
					return json({ id: foreign, name: "guest", displayName: "Guest Space", url: "u" });
				return json({});
			});
			expect((await resolveWorkspaceRef(client, foreign)).displayName).toBe("Guest Space");
		});

		it("lists the member's workspaces when nothing matches", async () => {
			await expect(resolveWorkspaceRef(client, "nope")).rejects.toThrow(/No workspace matching "nope"/);
			await expect(resolveWorkspaceRef(client, "nope")).rejects.toThrow(/frontlinetech/);
		});
	});

	// ---- lists ----

	describe("resolveListRef", () => {
		it("resolves a known list alias without an API call", async () => {
			expect(await resolveListRef(client, "inbox")).toBe(LIST_ALIASES.inbox);
			expect(paths).toEqual([]);
		});

		it("passes a raw list ID straight through", async () => {
			expect(await resolveListRef(client, "6a6711f3cce0b71b2a5b427a")).toBe("6a6711f3cce0b71b2a5b427a");
			expect(paths).toEqual([]);
		});

		it("resolves a list name within an explicitly named board", async () => {
			expect(await resolveListRef(client, "Doing", { board: "TECH Retail Decision Board" })).toBe(
				"6a6711f3cce0b71b2a5b427a",
			);
		});

		it("resolves a list name that is unique across all boards, with no board hint", async () => {
			expect(await resolveListRef(client, "Doing")).toBe("6a6711f3cce0b71b2a5b427a");
		});

		it("refuses a list name that exists on several boards, naming each board", async () => {
			await expect(resolveListRef(client, "Done")).rejects.toThrow(/ambiguous across boards/);
			await expect(resolveListRef(client, "Done")).rejects.toThrow(/Dann to-do/);
			await expect(resolveListRef(client, "Done")).rejects.toThrow(/TECH Retail Decision Board/);
		});

		it("disambiguates that collision with a board hint", async () => {
			expect(await resolveListRef(client, "Done", { board: "zoo" })).toBe("6400000000000000000000e2");
		});

		it("disambiguates with a workspace instead of a board", async () => {
			expect(await resolveListRef(client, "Backlog", { workspace: "frontlinetech" })).toBe(
				"6a6711dece01a8a02643448c",
			);
		});

		it("never resolves to an archived list", async () => {
			await expect(resolveListRef(client, "Archived list", { board: NEW_BOARD })).rejects.toThrow(
				/No list matching/,
			);
		});

		// v1.19.2 REGRESSION: archived lists were filtered out before caching, so
		// archive_list({closed: false}) could not find one by name at all — and
		// appeared to work only while a pre-archive cache entry was still warm.
		it("finds an archived list when the caller is reopening one", async () => {
			expect(
				await resolveListRef(client, "Archived list", { board: NEW_BOARD, includeArchived: true }),
			).toBe("6a6711ec7a817f9958a6ea17");
		});

		it("finds an archived list by name with no board hint too", async () => {
			expect(await resolveListRef(client, "Archived list", { includeArchived: true })).toBe(
				"6a6711ec7a817f9958a6ea17",
			);
		});

		// v1.19.2 REGRESSION: an alias short-circuited resolution, so an explicit
		// `board` naming a DIFFERENT board was ignored and the write silently
		// landed on the alias's board.
		it("refuses an alias that lives on a board other than the one named", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/boards") return json(BOARDS);
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				if (p === `/1/lists/${LIST_ALIASES.inbox}`)
					return json({ id: LIST_ALIASES.inbox, name: "Inbox", idBoard: DANN_TODO, closed: false });
				return json({});
			});
			await expect(
				resolveListRef(client, "inbox", { board: "TECH Retail Decision Board" }),
			).rejects.toThrow(/is on "Dann to-do"/);
		});

		it("allows an alias when the named board is the one it is on", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/boards") return json(BOARDS);
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				if (p === `/1/lists/${LIST_ALIASES.inbox}`)
					return json({ id: LIST_ALIASES.inbox, name: "Inbox", idBoard: DANN_TODO, closed: false });
				return json({});
			});
			expect(await resolveListRef(client, "inbox", { board: "dann-to-do" })).toBe(LIST_ALIASES.inbox);
		});

		it("applies the same check to a raw list ID", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/boards") return json(BOARDS);
				if (p === "/1/members/me/organizations") return json(WORKSPACES);
				if (p === "/1/lists/6a6711f3cce0b71b2a5b427a")
					return json({ id: "6a6711f3cce0b71b2a5b427a", name: "Doing", idBoard: NEW_BOARD, closed: false });
				return json({});
			});
			await expect(
				resolveListRef(client, "6a6711f3cce0b71b2a5b427a", { board: "zoo" }),
			).rejects.toThrow(/not on the board you named/);
		});

		it("costs nothing extra when no board is named", async () => {
			await resolveListRef(client, "inbox");
			expect(paths).toEqual([]);
		});

		it("names the board's lists when the name is wrong", async () => {
			await expect(resolveListRef(client, "Nope", { board: NEW_BOARD })).rejects.toThrow(/"Doing"/);
		});

		it("rejects an empty reference", async () => {
			await expect(resolveListRef(client, "   ")).rejects.toThrow(GuardError);
		});
	});

	// ---- caching ----

	describe("directory cache", () => {
		it("fetches the board list once inside the TTL", async () => {
			await memberBoards(client);
			await memberBoards(client);
			expect(paths.filter((p) => p === "/1/members/me/boards")).toHaveLength(1);
		});

		it("refetches after the TTL expires", async () => {
			vi.useFakeTimers();
			try {
				await memberBoards(client);
				vi.advanceTimersByTime(DIRECTORY_TTL_MS + 1);
				await memberBoards(client);
				expect(paths.filter((p) => p === "/1/members/me/boards")).toHaveLength(2);
			} finally {
				vi.useRealTimers();
			}
		});

		it("force bypasses the cache — a board added seconds ago is visible", async () => {
			await memberBoards(client);
			await memberBoards(client, { force: true });
			expect(paths.filter((p) => p === "/1/members/me/boards")).toHaveLength(2);
		});

		it("invalidateLists drops one board's lists only", async () => {
			await boardLists(client, NEW_BOARD);
			await boardLists(client, ZOO);
			invalidateLists(client, NEW_BOARD);
			await boardLists(client, NEW_BOARD);
			await boardLists(client, ZOO);
			expect(paths.filter((p) => p === `/1/boards/${NEW_BOARD}/lists`)).toHaveLength(2);
			expect(paths.filter((p) => p === `/1/boards/${ZOO}/lists`)).toHaveLength(1);
		});

		// v1.19.2 REGRESSION: archive_list never invalidated, so a just-archived
		// list stayed a resolution candidate for up to a minute — meaning the
		// SAME call succeeded or failed depending on cache age.
		it("archive_list drops the board's cached lists", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				paths.push(url.pathname);
				if (url.pathname === "/1/members/me/boards") return json(BOARDS);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				const lm = url.pathname.match(/^\/1\/boards\/([^/]+)\/lists$/);
				if (lm) return json(LISTS[lm[1]] ?? []);
				if (url.pathname === "/1/lists/6a6711dece01a8a02643448c" && init?.method === "PUT")
					return json({ id: "6a6711dece01a8a02643448c", name: "Backlog", idBoard: NEW_BOARD, closed: true });
				return json({});
			});
			await boardLists(client, NEW_BOARD); // warm
			await archive_list(client, { list: "Backlog", board: NEW_BOARD });
			await boardLists(client, NEW_BOARD);
			expect(paths.filter((p) => p === `/1/boards/${NEW_BOARD}/lists`).length).toBeGreaterThanOrEqual(2);
		});

		// v1.19.2 REGRESSION: only the DESTINATION board was invalidated, leaving
		// the list resolvable by name on the board it had just left.
		it("a cross-board move_list drops every board's cached lists", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				paths.push(url.pathname);
				if (url.pathname === "/1/members/me/boards") return json(BOARDS);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				const lm = url.pathname.match(/^\/1\/boards\/([^/]+)\/lists$/);
				if (lm) return json(LISTS[lm[1]] ?? []);
				if (url.pathname === "/1/lists/6400000000000000000000e1" && init?.method === "PUT")
					return json({ id: "6400000000000000000000e1", name: "Backlog", idBoard: NEW_BOARD, closed: false });
				if (url.pathname === "/1/lists/6400000000000000000000e1")
					return json({ id: "6400000000000000000000e1", name: "Backlog", idBoard: ZOO, closed: false });
				return json({});
			});
			await boardLists(client, ZOO); // warm the SOURCE board
			await move_list(client, {
				list: "6400000000000000000000e1",
				targetBoard: "TECH Retail Decision Board",
			});
			await boardLists(client, ZOO);
			expect(paths.filter((p) => p === `/1/boards/${ZOO}/lists`).length).toBeGreaterThanOrEqual(2);
		});

		it("caches are per client, so one session can't serve another stale data", async () => {
			const other = new TrelloClient("KEY", "TOKEN");
			await memberWorkspaces(client);
			await memberWorkspaces(other);
			expect(paths.filter((p) => p === "/1/members/me/organizations")).toHaveLength(2);
			invalidateDirectory(other);
		});
	});

	// ---- tools ----

	describe("list_boards / list_workspaces", () => {
		it("list_boards tags each board with its workspace", async () => {
			const { boards } = await list_boards(client);
			const newBoard = boards.find((b) => b.id === NEW_BOARD);
			expect(newBoard?.workspace).toEqual({
				id: ORG_NEW,
				name: "frontlinetech",
				displayName: "Frontline Tech",
			});
			expect(boards.find((b) => b.name === "Scratch")?.workspace).toBeNull();
		});

		it("list_boards omits closed boards", async () => {
			const { boards } = await list_boards(client);
			expect(boards.some((b) => b.name === "Closed Board")).toBe(false);
		});

		it("list_boards filters to one workspace", async () => {
			const { boards } = await list_boards(client, { workspace: "Frontline Tech" });
			expect(boards.map((b) => b.id)).toEqual([NEW_BOARD]);
		});

		it("list_boards always refetches, so a board added mid-session shows up", async () => {
			await memberBoards(client); // warm the cache
			await list_boards(client);
			expect(paths.filter((p) => p === "/1/members/me/boards")).toHaveLength(2);
		});

		it("list_workspaces groups boards under their workspace", async () => {
			const { workspaces } = await list_workspaces(client);
			const ft = workspaces.find((w) => w.id === ORG_NEW);
			expect(ft?.displayName).toBe("Frontline Tech");
			expect(ft?.boards.map((b) => b.name)).toEqual(["TECH Retail Decision Board"]);
		});

		it("list_workspaces keeps boards that belong to no workspace", async () => {
			const { workspaces } = await list_workspaces(client);
			const none = workspaces.find((w) => w.id === null);
			expect(none?.displayName).toBe("(no workspace)");
			expect(none?.boards.map((b) => b.name)).toEqual(["Scratch"]);
		});

		it("list_workspaces surfaces a workspace seen only via a board", async () => {
			const orphanOrg = "5000000000000000000000c3";
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const p = new URL(String(input)).pathname;
				if (p === "/1/members/me/organizations") return json([WORKSPACES[0]]);
				if (p === "/1/members/me/boards")
					return json([
						{ id: "6c00000000000000000000a1", name: "Guest Board", url: "u", closed: false, idOrganization: orphanOrg },
					]);
				return json({});
			});
			const { workspaces } = await list_workspaces(client);
			expect(workspaces.find((w) => w.id === orphanOrg)?.boards).toHaveLength(1);
		});
	});

	// ---- shared boards from workspaces the member isn't in ----

	describe("foreign workspaces", () => {
		const FOREIGN = "60c1d1485d7c40520d758651";
		const shared = {
			id: "628b4417c25db4859585ab0f",
			name: "IT CONFERENCE 2022",
			url: "u",
			closed: false,
			idOrganization: FOREIGN,
		};

		function mockWithForeign(orgReadable: boolean) {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				paths.push(url.pathname);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				if (url.pathname === "/1/members/me/boards") return json([...BOARDS, shared]);
				if (url.pathname === `/1/organizations/${FOREIGN}`) {
					return orgReadable
						? json({ id: FOREIGN, name: "linemolgaard1", displayName: "linemolgaard1's workspace", url: "u" })
						: new Response("unauthorized", { status: 401 });
				}
				return json({});
			});
		}

		it("names a workspace the member isn't a member of", async () => {
			mockWithForeign(true);
			const { boards } = await list_boards(client);
			expect(boards.find((b) => b.id === shared.id)?.workspace?.displayName).toBe(
				"linemolgaard1's workspace",
			);
		});

		it("falls back to the raw ID when that workspace can't be read", async () => {
			mockWithForeign(false);
			const { boards } = await list_boards(client);
			expect(boards.find((b) => b.id === shared.id)?.workspace).toEqual({
				id: FOREIGN,
				name: FOREIGN,
				displayName: FOREIGN,
			});
		});

		it("caches the unreadable result so it isn't refetched per board", async () => {
			mockWithForeign(false);
			await list_boards(client);
			await list_boards(client);
			expect(paths.filter((p) => p === `/1/organizations/${FOREIGN}`)).toHaveLength(1);
		});

		it("a board in a foreign workspace still resolves by name", async () => {
			mockWithForeign(true);
			expect(await resolveBoardRef(client, "IT CONFERENCE 2022")).toBe(shared.id);
		});
	});

	// ---- tool wiring: the paths a caller actually exercises ----

	describe("tools accept workspace / board / list references", () => {
		/** Query string of the last non-directory call. */
		function lastQuery(): URLSearchParams {
			const call = fetchSpy.mock.calls.at(-1);
			if (!call) throw new Error("no fetch calls recorded");
			return new URL(String(call[0])).searchParams;
		}

		it("search_cards passes the resolved workspace to Trello as idOrganizations", async () => {
			await search_cards(client, { query: "retail", workspace: "frontlinetech" });
			expect(lastQuery().get("idOrganizations")).toBe(ORG_NEW);
		});

		it("search_cards prefers an explicit board over the workspace scope", async () => {
			await search_cards(client, { query: "x", board: "TECH Retail Decision Board", workspace: "frontlinetech" });
			expect(lastQuery().get("idBoards")).toBe(NEW_BOARD);
			expect(lastQuery().get("idOrganizations")).toBeNull();
		});

		it("search_cards_advanced maps workspace names to ids", async () => {
			await search_cards_advanced(client, { query: "x", workspaces: ["frontlinetech", "Dann's Workspace"] });
			expect(lastQuery().get("idOrganizations")).toBe(`${ORG_NEW},${ORG_PERSONAL}`);
		});

		it("list_cards resolves a board name in the new workspace", async () => {
			const captured: string[] = [];
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				captured.push(url.pathname);
				if (url.pathname === "/1/members/me/boards") return json(BOARDS);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				return json([]);
			});
			await list_cards(client, { board: "TECH Retail Decision Board" });
			expect(captured).toContain(`/1/boards/${NEW_BOARD}/cards`);
		});

		it("create_card resolves a list name scoped to a board", async () => {
			const posted: URL[] = [];
			fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/1/members/me/boards") return json(BOARDS);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				const lm = url.pathname.match(/^\/1\/boards\/([^/]+)\/lists$/);
				if (lm) return json(LISTS[lm[1]] ?? []);
				if (url.pathname === "/1/cards" && init?.method === "POST") {
					posted.push(url);
					return json({ id: "new", idList: "6a6711dece01a8a02643448c", idBoard: NEW_BOARD, labels: [] });
				}
				return json([]);
			});
			await create_card(client, {
				list: "Backlog",
				board: "TECH Retail Decision Board",
				name: "From the connector",
			});
			expect(posted.at(0)?.searchParams.get("idList")).toBe("6a6711dece01a8a02643448c");
		});

		it("create_card refuses an ambiguous list name instead of guessing a board", async () => {
			await expect(create_card(client, { list: "Done", name: "x" })).rejects.toThrow(
				/ambiguous across boards/,
			);
		});

		// v1.19.2 REGRESSION: board-as-URL resolved to a short link, which never
		// equals a card's idBoard — so this filter silently returned NOTHING.
		// Silent, not an error: the worst shape the bug had.
		it("list_my_cards_assigned filters correctly when the board is given as a URL", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/1/members/me/boards") return json(BOARDS);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				if (url.pathname === "/1/members/me") return json({ id: "m1", username: "dann" });
				if (url.pathname === "/1/members/me/cards")
					return json([
						{ id: "c1", name: "on the new board", idBoard: NEW_BOARD, idList: "l1", labels: [], closed: false, dateLastActivity: "2026-07-01T00:00:00Z" },
						{ id: "c2", name: "elsewhere", idBoard: DANN_TODO, idList: "l2", labels: [], closed: false, dateLastActivity: "2026-07-01T00:00:00Z" },
					]);
				return json([]);
			});
			const { cards } = await list_my_cards_assigned(client, {
				board: "https://trello.com/b/xKeUkW8V/tech-retail-decision-board",
			});
			expect(cards.map((c) => c.id)).toEqual(["c1"]);
		});

		// v1.19.2 REGRESSION: Trello rejects a short link in idBoards with
		// 400 "Invalid objectId".
		it("search_cards sends a 24-char id to idBoards when given a board URL", async () => {
			await search_cards(client, {
				query: "x",
				board: "https://trello.com/b/xKeUkW8V/tech-retail-decision-board",
			});
			expect(lastQuery().get("idBoards")).toBe(NEW_BOARD);
		});

		it("list_my_cards_assigned filters to the boards of one workspace", async () => {
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/1/members/me/boards") return json(BOARDS);
				if (url.pathname === "/1/members/me/organizations") return json(WORKSPACES);
				if (url.pathname === "/1/members/me") return json({ id: "m1", username: "dann" });
				if (url.pathname === "/1/members/me/cards")
					return json([
						{ id: "c1", name: "in new ws", idBoard: NEW_BOARD, idList: "l1", labels: [], closed: false, dateLastActivity: "2026-07-01T00:00:00Z" },
						{ id: "c2", name: "in personal ws", idBoard: DANN_TODO, idList: "l2", labels: [], closed: false, dateLastActivity: "2026-07-01T00:00:00Z" },
					]);
				return json([]);
			});
			const { cards } = await list_my_cards_assigned(client, { workspace: "frontlinetech" });
			expect(cards.map((c) => c.id)).toEqual(["c1"]);
		});
	});
});
