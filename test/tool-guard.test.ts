// Allowlist enforcement on the MCP surface (v1.21.2 security fix).
//
// Two things are pinned here, and the first one is a regression guard:
//
// 1. A refused tool call must have NO persistent side effects. v1.21.0 recorded
//    the denial before rejecting, so any GitHub login holding a session could
//    turn requests into permanent D1 rows and Analytics Engine points. Because
//    the streamable-HTTP transport dispatches a JSON-RPC array, one POST could
//    carry N calls and write N rows — the amplification is per-message, not
//    per-request. These tests drive the REAL registerTrelloTools through a stub
//    McpServer, so they fail if the ordering in makeGuarded is ever reversed.
//
// 2. The OAuth callback refuses a non-allowlisted login before minting a token.
//    That one is asserted structurally rather than behaviourally — see the note
//    on the test itself.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { registerTrelloTools } from "../src/register-tools";
import { TrelloClient } from "../src/trello/client";
import { UsageRecorder } from "../src/usage";

/** Records every bound row so a test can assert that NOTHING was written. */
function fakeD1() {
	const bound: unknown[][] = [];
	const stmt = {
		bind: (...args: unknown[]) => {
			bound.push(args);
			return stmt;
		},
	};
	return { bound, binding: { prepare: () => stmt, batch: async () => [] } as unknown as D1Database };
}

function fakeAE() {
	const points: AnalyticsEngineDataPoint[] = [];
	return {
		points,
		binding: {
			writeDataPoint: (p?: AnalyticsEngineDataPoint) => {
				if (p) points.push(p);
			},
		} as AnalyticsEngineDataset,
	};
}

type Handler = (input: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/**
 * Register all 102 tools against a stub server and hand back the handlers.
 * Runs in plain Node: McpServer is a type-only import in register-tools.ts, so
 * nothing in that module graph reaches for a Workers global.
 */
function registerAs(login: string) {
	const handlers = new Map<string, Handler>();
	const server = {
		tool: (name: string, _desc: string, _schema: unknown, fn: Handler) => {
			handlers.set(name, fn);
		},
	};
	const d1 = fakeD1();
	const ae = fakeAE();
	const env = { USAGE: ae.binding, USAGE_DB: d1.binding } as unknown as Env;
	const usage = new UsageRecorder(env, "mcp", login);
	// A client whose fetch would throw if anything actually called Trello — a
	// denied call must never get that far.
	const client = new TrelloClient("test-key", "test-token", usage);
	registerTrelloTools(server as unknown as Parameters<typeof registerTrelloTools>[0], login, client, env, usage);
	return { handlers, d1, ae, usage };
}

describe("allowlist enforcement on tool calls", () => {
	it("refuses a non-allowlisted login with the documented message", async () => {
		const { handlers } = registerAs("mallory-attacker");
		const res = await handlers.get("list_cards")!({});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("mallory-attacker");
		expect(res.content[0].text).toContain("not on this connector's allowlist");
	});

	it("writes NOTHING persistent for a refused call", async () => {
		const { handlers, d1, ae, usage } = registerAs("mallory-attacker");
		await handlers.get("list_cards")!({});
		// The regression that matters: no D1 row, no Analytics Engine point, and
		// nothing left buffered for a later flush to pick up.
		expect(d1.bound).toHaveLength(0);
		expect(ae.points).toHaveLength(0);
		expect(usage.pending).toBe(0);
	});

	it("stays silent under a batch of refused calls, logging the denial once per session", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { handlers, d1, ae } = registerAs("mallory-attacker");
		// Stands in for a single POST carrying a JSON-RPC array of five calls,
		// which is the shape that made this amplifying rather than 1:1.
		for (const tool of ["list_cards", "get_card", "create_card", "move_card", "search_cards"]) {
			await handlers.get(tool)!({});
		}
		const denials = spy.mock.calls.filter((c) => String(c[0]).includes('"outcome":"denied"'));
		spy.mockRestore();

		expect(d1.bound).toHaveLength(0);
		expect(ae.points).toHaveLength(0);
		expect(denials).toHaveLength(1);
	});

	it("refuses every one of the 102 tools, not just the read ones", async () => {
		const { handlers, d1 } = registerAs("mallory-attacker");
		expect(handlers.size).toBe(102);
		for (const [, fn] of handlers) {
			const res = await fn({});
			expect(res.isError).toBe(true);
		}
		expect(d1.bound).toHaveLength(0);
	});

	it("still records normally for the allowlisted owner", async () => {
		// Guards against "fixed" by disabling recording altogether. The call fails
		// (no network in tests), but it must fail as a recorded Trello/internal
		// error rather than a silent denial.
		const { handlers, d1 } = registerAs("dannbleeker");
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("no network"));
		await handlers.get("list_boards")!({});
		spy.mockRestore();
		expect(d1.bound.length).toBeGreaterThan(0);
		expect(d1.bound.some((row) => row.includes("denied"))).toBe(false);
	});
});

describe("allowlist enforcement in the OAuth callback", () => {
	// Structural, not behavioural, and deliberately so: src/github-handler.ts
	// imports "cloudflare:workers" on line 1, so importing it under vitest fails
	// outright. Making it importable would mean aliasing that module in
	// vitest.config.ts — editing a CI gate inside a security patch — and pulling
	// octokit, hono and the OAuth provider into the test module graph. The bug
	// being guarded is an ORDERING bug, which a text assertion can pin honestly.
	// Same precedent as test/dashboard-usage.test.ts, which reads api.ts as text.
	const SRC = readFileSync(new URL("../src/github-handler.ts", import.meta.url), "utf8");

	it("checks the allowlist before minting a token", () => {
		const check = SRC.indexOf("ALLOWED_LOGINS.has(login)");
		const mint = SRC.indexOf("completeAuthorization");
		expect(check).toBeGreaterThan(-1);
		expect(mint).toBeGreaterThan(-1);
		expect(check).toBeLessThan(mint);
	});

	it("imports the same allowlist the tool guard uses", () => {
		expect(SRC).toMatch(/import \{ ALLOWED_LOGINS \} from "\.\/allowlist"/);
	});
});
