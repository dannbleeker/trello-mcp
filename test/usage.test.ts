// Usage-tracking tests (src/usage.ts). Runs in plain Node like the rest of the
// suite — no Workers runtime — because the recorder's contract is deliberately
// just "call these two optional bindings correctly, and never throw".
//
// The Analytics Engine shape assertions matter more than they look. Miniflare's
// local writeDataPoint is an empty function and the real runtime SILENTLY DROPS
// a malformed data point ("If you attempt to provide multiple indexes, your
// data point will not be recorded") — so a schema mistake is invisible in local
// dev AND in production. These tests are the only place it can surface.

import { describe, expect, it, vi } from "vitest";
import {
	classifyError,
	clampIndex,
	endpointName,
	normalizeTrelloPath,
	UsageRecorder,
	type UsageEnv,
} from "../src/usage";
import { TrelloClient, TrelloError } from "../src/trello/client";
import { GuardError } from "../src/trello/guards";

/** A stub Analytics Engine binding that records what it was handed. */
function fakeAE() {
	const points: AnalyticsEngineDataPoint[] = [];
	return {
		points,
		binding: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => { if (p) points.push(p); } } as AnalyticsEngineDataset,
	};
}

/** A stub D1 binding capturing the bound rows of a batch(). */
function fakeD1() {
	const bound: unknown[][] = [];
	const stmt = {
		bind: (...args: unknown[]) => {
			bound.push(args);
			return stmt;
		},
	};
	return {
		bound,
		binding: {
			prepare: () => stmt,
			batch: async () => [],
		} as unknown as D1Database,
	};
}

describe("normalizeTrelloPath", () => {
	it("collapses 24-char hex object IDs", () => {
		expect(normalizeTrelloPath("/cards/68f1a2c3d4e5f60718293a4b")).toBe("/cards/{id}");
		expect(normalizeTrelloPath("/cards/68f1a2c3d4e5f60718293a4b/actions")).toBe("/cards/{id}/actions");
	});

	it("collapses non-hex identifiers that follow a collection segment", () => {
		// Board short-links and workspace short-names are the cardinality leak a
		// bare ID regex misses — they are not hex and not fixed-length.
		expect(normalizeTrelloPath("/boards/xKeUkW8V/lists")).toBe("/boards/{id}/lists");
		expect(normalizeTrelloPath("/organizations/dannbleeker/boards")).toBe("/organizations/{id}/boards");
	});

	it("keeps `me` — it is a literal, not an identifier", () => {
		expect(normalizeTrelloPath("/members/me/cards")).toBe("/members/me/cards");
		expect(normalizeTrelloPath("/members/me")).toBe("/members/me");
	});

	it("keeps filter literals that sit in an identifier position", () => {
		// Regression: `closed` and `comments` follow a collection segment, so a
		// naive "segment after a collection is an ID" rule collapses them and
		// merges list_archived_cards into get_card.
		expect(normalizeTrelloPath("/boards/68f1a2c3d4e5f60718293a4b/cards/closed")).toBe("/boards/{id}/cards/closed");
		expect(normalizeTrelloPath("/cards/68f1a2c3d4e5f60718293a4b/actions/comments")).toBe(
			"/cards/{id}/actions/comments",
		);
	});

	it("drops the query string", () => {
		expect(normalizeTrelloPath("/batch?urls=/cards/1,/cards/2")).toBe("/batch");
	});

	it("collapses trailing IDs after non-collection segments via the hex rule", () => {
		expect(normalizeTrelloPath("/cards/68f1a2c3d4e5f60718293a4b/idMembers/58f1a2c3d4e5f60718293a4b")).toBe(
			"/cards/{id}/idMembers/{id}",
		);
	});

	it("builds an endpoint name with the method", () => {
		expect(endpointName("get", "/cards/68f1a2c3d4e5f60718293a4b")).toBe("GET /cards/{id}");
	});
});

describe("classifyError", () => {
	it("separates guard refusals from Trello failures from internal errors", () => {
		expect(classifyError(new GuardError("nope"))).toBe("guard");
		expect(classifyError(new TrelloError(404, "not found"))).toBe("trello");
		expect(classifyError(new Error("boom"))).toBe("internal");
		expect(classifyError("a string")).toBe("internal");
	});
});

describe("clampIndex", () => {
	it("leaves short values untouched", () => {
		expect(clampIndex("list_cards")).toBe("list_cards");
	});

	it("truncates to the 96-byte Analytics Engine index limit", () => {
		const clamped = clampIndex("x".repeat(200));
		expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(96);
	});

	it("never emits a partial multi-byte character", () => {
		const clamped = clampIndex("é".repeat(100));
		// Round-tripping through encode/decode must be lossless — a split
		// code unit would surface as U+FFFD here.
		expect(clamped).not.toContain("�");
		expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(96);
	});
});

describe("UsageRecorder", () => {
	it("no-ops when neither binding is present", async () => {
		const rec = new UsageRecorder({} as UsageEnv, "mcp", "dannbleeker");
		expect(() => rec.record({ kind: "tool", name: "list_cards", outcome: "ok", durationMs: 5 })).not.toThrow();
		await expect(rec.flush()).resolves.toBeUndefined();
	});

	it("writes an Analytics Engine point within the documented limits", () => {
		const ae = fakeAE();
		const rec = new UsageRecorder({ USAGE: ae.binding }, "mcp", "dannbleeker");
		rec.record({ kind: "tool", name: "weekly_review_pack", outcome: "ok", durationMs: 120 });

		expect(ae.points).toHaveLength(1);
		const p = ae.points[0];
		// Exactly one index, or the runtime discards the whole point.
		expect(p.indexes).toHaveLength(1);
		expect(p.blobs!.length).toBeLessThanOrEqual(20);
		expect(p.doubles!.length).toBeLessThanOrEqual(20);
		expect(new TextEncoder().encode(String(p.indexes![0])).length).toBeLessThanOrEqual(96);
	});

	it("indexes by name so per-tool counts survive sampling", () => {
		const ae = fakeAE();
		const rec = new UsageRecorder({ USAGE: ae.binding }, "mcp");
		rec.record({ kind: "tool", name: "list_cards", outcome: "ok", durationMs: 1 });
		expect(ae.points[0].indexes![0]).toBe("list_cards");
	});

	it("batches buffered rows into one D1 write and clears the buffer", async () => {
		const d1 = fakeD1();
		const rec = new UsageRecorder({ USAGE_DB: d1.binding }, "mcp", "dannbleeker");
		rec.record({ kind: "tool", name: "list_cards", outcome: "ok", durationMs: 5 });
		rec.record({ kind: "http", name: "GET /cards/{id}", outcome: "ok", durationMs: 3, status: 200, attempts: 1 });
		expect(rec.pending).toBe(2);

		await rec.flush();
		expect(d1.bound).toHaveLength(2);
		expect(rec.pending).toBe(0);

		// A second flush with nothing buffered must be a no-op, not a stray write.
		await rec.flush();
		expect(d1.bound).toHaveLength(2);
	});

	it("swallows a D1 failure and still drains the buffer", async () => {
		const rec = new UsageRecorder(
			{ USAGE_DB: { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database },
			"cron",
		);
		rec.record({ kind: "tool", name: "send_digest", outcome: "ok", durationMs: 9 });
		await expect(rec.flush()).resolves.toBeUndefined();
		// Drained despite the failure — a persistent D1 outage must not grow
		// the buffer unboundedly across a long-lived session.
		expect(rec.pending).toBe(0);
	});

	it("records the surface it was constructed with, not the caller's", async () => {
		const d1 = fakeD1();
		const rec = new UsageRecorder({ USAGE_DB: d1.binding }, "dashboard", "dannbleeker");
		rec.record({ kind: "tool", name: "move_card", outcome: "ok", durationMs: 4 });
		await rec.flush();
		expect(d1.bound[0]).toContain("dashboard");
	});

	it("never records argument values — only names, outcomes and timings", async () => {
		const ae = fakeAE();
		const d1 = fakeD1();
		const rec = new UsageRecorder({ USAGE: ae.binding, USAGE_DB: d1.binding }, "mcp", "dannbleeker");
		// A tool name and an endpoint are the only free-text fields the recorder
		// accepts; there is no argument channel at all. This test pins that.
		rec.record({ kind: "tool", name: "search_cards", outcome: "ok", durationMs: 7 });
		await rec.flush();
		const serialised = JSON.stringify(ae.points) + JSON.stringify(d1.bound);
		expect(serialised).not.toMatch(/secret|password|query=|desc/i);
		expect(serialised).toContain("search_cards");
	});
});

describe("TrelloClient usage instrumentation", () => {
	it("records the templated endpoint, not the URL carrying key and token", async () => {
		const events: { name: string; status?: number; outcome: string }[] = [];
		const client = new TrelloClient("test-key", "test-token", {
			record: (e) => events.push({ name: e.name, status: e.status, outcome: e.outcome }),
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "68f1a2c3d4e5f60718293a4b" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await client.getCard("68f1a2c3d4e5f60718293a4b");
		fetchSpy.mockRestore();

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ name: "GET /cards/{id}", status: 200, outcome: "ok" });
		// The built URL has `key=` and `token=` in its query string. If the raw
		// URL ever reaches the recorder, credentials reach the analytics store.
		expect(events[0].name).not.toContain("key=");
		expect(events[0].name).not.toContain("token=");
	});

	it("records a failed call with its status and attempt count", async () => {
		const events: { name: string; status?: number; outcome: string; attempts?: number }[] = [];
		const client = new TrelloClient("k", "t", { record: (e) => events.push(e) });
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("nope", { status: 404, headers: { "Content-Type": "text/plain" } }));

		await expect(client.getCard("68f1a2c3d4e5f60718293a4b")).rejects.toBeInstanceOf(TrelloError);
		fetchSpy.mockRestore();

		expect(events).toHaveLength(1);
		expect(events[0].outcome).toBe("trello");
		expect(events[0].status).toBe(404);
		expect(events[0].attempts).toBe(1); // 404 is not retriable
	});

	it("stays silent when no sink is supplied", async () => {
		const client = new TrelloClient("k", "t");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await expect(client.getCard("68f1a2c3d4e5f60718293a4b")).resolves.toBeTruthy();
		fetchSpy.mockRestore();
	});
});
