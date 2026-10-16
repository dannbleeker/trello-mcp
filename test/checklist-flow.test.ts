// End-to-end checklist flow through the REAL registered handlers, the real
// TrelloClient and real tools.ts, against an in-memory fake of Trello's HTTP
// API. Unit tests with a stubbed client cannot tell whether register-tools
// wiring, tool logic and the URLs/params the client sends agree with each
// other; this can. What it cannot tell is whether real Trello honours those
// params (e.g. idChecklist on a check-item PUT) — that is scripts/smoke.mjs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTrelloTools } from "../src/register-tools";
import { TrelloClient } from "../src/trello/client";
import { LIST_ALIASES } from "../src/trello/constants";
import { UsageRecorder } from "../src/usage";

const CARD = "68f1a2c3d4e5f60718293a4b";
const OTHER_CARD = "58f1a2c3d4e5f60718293a4b";

type Item = { id: string; name: string; state: string; pos: number; idChecklist: string; due: string | null; idMember: string | null };
type List = { id: string; name: string; idCard: string; checkItems: Item[] };

function fakeTrello() {
	const checklists: List[] = [
		{ id: "CL-PROPOSED", name: "Proposed", idCard: CARD, checkItems: [] },
		{ id: "CL-APPROVED", name: "Approved", idCard: CARD, checkItems: [] },
		{ id: "CL-ELSEWHERE", name: "Other card", idCard: OTHER_CARD, checkItems: [] },
	];
	let n = 0;
	const writes: string[] = [];
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
	const handler = async (input: string | URL | Request, init?: RequestInit) => {
		const u = new URL(String(input));
		const method = init?.method ?? "GET";
		const q = u.searchParams;
		let m: RegExpMatchArray | null;
		if (method !== "GET") writes.push(`${method} ${u.pathname}`);
		if ((m = u.pathname.match(/^\/1\/cards\/([^/]+)$/)) && method === "GET")
			return json({ id: m[1], idList: LIST_ALIASES["@computer"], idBoard: "b1", name: "Card", closed: false });
		if ((m = u.pathname.match(/^\/1\/cards\/([^/]+)\/checklists$/)) && method === "GET")
			return json(checklists.filter((c) => c.idCard === m![1]));
		if ((m = u.pathname.match(/^\/1\/checklists\/([^/]+)\/checkItems$/)) && method === "POST") {
			const cl = checklists.find((c) => c.id === m![1])!;
			const it: Item = { id: `IT${++n}`, name: q.get("name")!, state: "incomplete", pos: cl.checkItems.length + 1, idChecklist: cl.id, due: null, idMember: null };
			cl.checkItems.push(it);
			return json(it);
		}
		if ((m = u.pathname.match(/^\/1\/cards\/([^/]+)\/checkItem\/([^/]+)$/)) && method === "PUT") {
			const from = checklists.find((c) => c.checkItems.some((i) => i.id === m![2]))!;
			const it = from.checkItems.find((i) => i.id === m![2])!;
			const to = q.get("idChecklist");
			if (to) {
				from.checkItems = from.checkItems.filter((i) => i !== it);
				const dest = checklists.find((c) => c.id === to)!;
				it.idChecklist = to;
				it.pos = dest.checkItems.length + 1;
				dest.checkItems.push(it);
			}
			if (q.get("state")) it.state = q.get("state")!;
			return json(it);
		}
		throw new Error(`fake Trello: unhandled ${method} ${u.pathname}`);
	};
	return { checklists, writes, handler };
}

describe("checklist flow through registered tools", () => {
	let fake: ReturnType<typeof fakeTrello>;
	let call: (name: string, input: unknown) => Promise<{ isError?: boolean; body: any }>;

	beforeEach(() => {
		fake = fakeTrello();
		vi.spyOn(globalThis, "fetch").mockImplementation(fake.handler as typeof fetch);
		const handlers = new Map<string, (i: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
		const server = { tool: (name: string, _d: string, _s: unknown, fn: never) => void handlers.set(name, fn) };
		const env = {} as unknown as Env;
		const usage = new UsageRecorder(env, "mcp", "dannbleeker");
		const client = new TrelloClient("k", "t", usage);
		registerTrelloTools(server as unknown as Parameters<typeof registerTrelloTools>[0], "dannbleeker", client, env, usage);
		call = async (name, input) => {
			const r = await handlers.get(name)!(input);
			let body: unknown = r.content[0].text;
			try { body = JSON.parse(r.content[0].text); } catch { /* error text */ }
			return { isError: r.isError, body };
		};
	});
	afterEach(() => vi.restoreAllMocks());

	it("the reported scenario: add to the SECOND checklist, then move between them", async () => {
		const added = await call("add_checklist_item", { cardId: CARD, text: "ship it", checklistId: "CL-APPROVED" });
		expect(added.body.item.checklistId).toBe("CL-APPROVED");
		expect(fake.checklists[1].checkItems.map((i) => i.name)).toEqual(["ship it"]);
		expect(fake.checklists[0].checkItems).toHaveLength(0);

		// No checklistId: lands in the first, and the reply says so.
		const dflt = await call("add_checklist_item", { cardId: CARD, text: "default" });
		expect(dflt.body.item.checklistId).toBe("CL-PROPOSED");

		const moved = await call("move_checklist_item", { cardId: CARD, itemId: dflt.body.item.id, toChecklistId: "CL-APPROVED" });
		expect(moved.isError).toBeUndefined();
		expect(moved.body.item.checklistId).toBe("CL-APPROVED");
		expect(moved.body.item.index).toBe(2); // after "ship it"
		expect(moved.body.item.pos).toBeUndefined();

		const listed = await call("list_checklist_items", { cardId: CARD });
		const byId = Object.fromEntries(listed.body.checklists.map((c: any) => [c.id, c.items.map((i: any) => i.name)]));
		expect(byId).toEqual({ "CL-PROPOSED": [], "CL-APPROVED": ["ship it", "default"] });
		expect(listed.body.checklists[1].items[0]).toMatchObject({ due: null, memberId: null });
	});

	it("moves a whole batch in one call and keeps the order", async () => {
		const a = await call("add_checklist_item", { cardId: CARD, text: "one", checklistId: "CL-PROPOSED" });
		const b = await call("add_checklist_item", { cardId: CARD, text: "two", checklistId: "CL-PROPOSED" });
		const r = await call("move_checklist_items", {
			cardId: CARD,
			itemIds: [b.body.item.id, a.body.item.id],
			toChecklistId: "CL-APPROVED",
		});
		expect(r.isError).toBeUndefined();
		expect(r.body.moved.map((m: any) => [m.name, m.index])).toEqual([["two", 1], ["one", 2]]);
		expect(fake.checklists[0].checkItems).toHaveLength(0);
	});

	it("refuses a checklist from another card and writes nothing", async () => {
		const r = await call("add_checklist_item", { cardId: CARD, text: "x", checklistId: "CL-ELSEWHERE" });
		expect(r.isError).toBe(true);
		expect(fake.writes).toEqual([]);
	});

	it("refuses to tick an item that is on another card and writes nothing", async () => {
		fake.checklists[2].checkItems.push({ id: "IT-X", name: "x", state: "incomplete", pos: 1, idChecklist: "CL-ELSEWHERE", due: null, idMember: null });
		const r = await call("set_checklist_item_state", { cardId: CARD, itemId: "IT-X", complete: true });
		expect(r.isError).toBe(true);
		expect(fake.writes).toEqual([]);
	});
});
