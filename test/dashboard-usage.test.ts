// Usage panel on the dashboard page (src/dashboard/page.html), v1.21.0.
//
// Same approach as dashboard-labels.test.ts: read page.html, evaluate its
// <script> block in a stub DOM, and drive the REAL panel functions rather than
// a re-implementation. This exists because page.html has no other execution
// coverage — the panel was written, shipped and reviewed without anything ever
// running it, and a ReferenceError in the render path would have surfaced only
// as a silently missing section on the live dashboard.
//
// The load-bearing test here is the contract one: the field names the page
// reads (`toolCalls`, `distinctTools`, `avgMs`, …) are SQL column aliases in
// src/dashboard/api.ts. Renaming an alias there breaks the panel with no type
// error anywhere, because the boundary is JSON.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8");
const API = readFileSync(new URL("../src/dashboard/api.ts", import.meta.url), "utf8");

/** The exact shape GET /api/usage returns — mirrored from the verified SQL. */
const USAGE_PAYLOAD = {
	enabled: true,
	days: 30,
	totals: { toolCalls: 412, httpCalls: 1187, distinctTools: 14, rateLimited: 3, errors: 17, firstTs: 1 },
	tools: [
		{ name: "list_cards", calls: 142, errors: 0, avgMs: 118, lastTs: 2 },
		{ name: "move_card", calls: 31, errors: 9, avgMs: 187, lastTs: 3 },
		{ name: "delete_label", calls: 1, errors: 1, avgMs: 90, lastTs: 4 },
	],
	endpoints: [{ name: "GET /boards/{id}/cards/closed", calls: 12, errors: 0, avgMs: 140, lastTs: 5 }],
	surfaces: [{ surface: "mcp", kind: "tool", calls: 380 }],
};

const LISTS = [
	{ id: "l-inbox", name: "Inbox", closed: false },
	{ id: "l-computer", name: "@Computer (WIP limit 7)", closed: false },
	{ id: "l-waiting", name: "Waiting for…", closed: false },
	{ id: "l-done", name: "Done-do", closed: false },
	{ id: "l-rocks", name: "Rolling Big Rocks", closed: false },
];

function loadPage(payload: unknown = USAGE_PAYLOAD, opts: { usageOpen?: boolean } = {}) {
	const start = PAGE.indexOf("<script>") + "<script>".length;
	const script = PAGE.slice(start, PAGE.lastIndexOf("</script>"));

	// A single shared #content node so render()'s output can be inspected.
	const content = { innerHTML: "", value: "", disabled: false, classList: { add() {}, remove() {} }, style: {} };
	const stub = () => ({ innerHTML: "", value: "", disabled: false, onclick: null, classList: { add() {}, remove() {} }, style: {} });
	const el = (id?: string) => (id === "content" ? content : stub());
	const document = { addEventListener() {}, getElementById: el, querySelectorAll: () => [], activeElement: null };
	const window = { addEventListener() {} };

	const store = new Map<string, string>();
	if (opts.usageOpen) store.set("dann_dash_usage_open", "1");
	const localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k) : null),
		setItem: (k: string, v: string) => void store.set(k, v),
	};

	const requested: string[] = [];
	const fetchStub = (url: string) => {
		requested.push(String(url));
		if (String(url).startsWith("/api/usage")) {
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
		}
		return Promise.reject(new Error("no network in tests"));
	};

	const factory = new Function(
		"document",
		"fetch",
		"location",
		"window",
		"localStorage",
		"navigator",
		`${script}
		return {
			configureFromLists: configureFromLists,
			render: render,
			loadUsage: loadUsage,
			toggleUsage: toggleUsage,
			setUsageView: setUsageView,
			setUsageDays: setUsageDays,
			usageOpen: function(){ return USAGE_OPEN; },
			usageDays: function(){ return USAGE_DAYS; },
		};`,
	);
	const page = factory(document, fetchStub, { href: "", search: "" }, window, localStorage, { onLine: true });
	page.configureFromLists(LISTS);
	return { ...page, html: () => content.innerHTML, requested: () => requested.slice(), store };
}

describe("usage panel rendering", () => {
	it("renders every tool row with its count once loaded", async () => {
		const p = loadPage(USAGE_PAYLOAD, { usageOpen: true });
		await p.loadUsage();
		const html = p.html();
		expect(html).toContain("list_cards");
		expect(html).toContain("move_card");
		expect(html).toContain("delete_label");
		// The count column, not just the label.
		expect(html).toContain(">142<");
	});

	it("surfaces the totals strip", async () => {
		const p = loadPage(USAGE_PAYLOAD, { usageOpen: true });
		await p.loadUsage();
		const html = p.html();
		expect(html).toContain("Tool calls");
		expect(html).toContain("412");
		expect(html).toContain("Trello requests");
		expect(html).toContain("1187");
		expect(html).toContain("Distinct tools");
	});

	it("flags a mostly-failing tool but not a mostly-succeeding one", async () => {
		const p = loadPage(USAGE_PAYLOAD, { usageOpen: true });
		await p.loadUsage();
		const rows = p.html().split('<div class="usg-row"');
		const deleteLabel = rows.find((r) => r.includes("delete_label")) ?? "";
		const moveCard = rows.find((r) => r.includes("move_card")) ?? "";
		// 1 error of 1 call → error styling; 9 of 31 → not.
		expect(deleteLabel).toContain("usg-bar err");
		expect(moveCard).not.toContain("usg-bar err");
		expect(moveCard).toContain("9 err");
	});

	it("switches to the endpoint view without refetching", async () => {
		const p = loadPage(USAGE_PAYLOAD, { usageOpen: true });
		await p.loadUsage();
		const before = p.requested().length;
		p.setUsageView("endpoints");
		expect(p.html()).toContain("GET /boards/{id}/cards/closed");
		expect(p.html()).not.toContain("list_cards");
		// The payload already holds both views — switching tabs must not cost a
		// D1 read, since D1 bills rows scanned.
		expect(p.requested()).toHaveLength(before);
	});

	it("refetches with the new window when the range changes", async () => {
		const p = loadPage(USAGE_PAYLOAD, { usageOpen: true });
		await p.loadUsage();
		p.setUsageDays(7);
		expect(p.usageDays()).toBe(7);
		expect(p.requested().some((u) => u.includes("days=7"))).toBe(true);
	});

	it("stays collapsed and costs no D1 read until opened", () => {
		const p = loadPage(USAGE_PAYLOAD);
		expect(p.usageOpen()).toBe(false);
		p.render();
		expect(p.html()).toContain("which tools actually get used");
		// The page's own init() fetches /api/cards; what must not happen is a
		// usage query, which is the one that scans the events table.
		expect(p.requested().filter((u) => u.includes("/api/usage"))).toHaveLength(0);
	});

	it("persists the open state across visits", () => {
		const p = loadPage(USAGE_PAYLOAD);
		p.toggleUsage();
		expect(p.store.get("dann_dash_usage_open")).toBe("1");
	});

	it("explains an unbound recorder instead of rendering zeros", async () => {
		const p = loadPage({ enabled: false, days: 0, totals: null, tools: [], endpoints: [], surfaces: [] }, { usageOpen: true });
		await p.loadUsage();
		expect(p.html()).toContain("isn’t bound yet");
	});

	it("shows an empty window as empty, not as an error", async () => {
		const p = loadPage({ enabled: true, days: 30, totals: {}, tools: [], endpoints: [], surfaces: [] }, { usageOpen: true });
		await p.loadUsage();
		expect(p.html()).toContain("nothing recorded in this window yet");
	});
});

describe("usage panel ↔ /api/usage contract", () => {
	// These names cross a JSON boundary, so nothing type-checks them. A renamed
	// SQL alias in api.ts would break the panel silently.
	it("every field the page reads is produced as a SQL alias by /api/usage", () => {
		for (const field of ["toolCalls", "httpCalls", "distinctTools", "rateLimited", "avgMs", "calls", "errors"]) {
			expect(API, `${field} is read by page.html but not aliased in api.ts`).toContain(field);
		}
	});

	it("the page requests the route the API actually serves", () => {
		expect(PAGE).toContain('"/api/usage?days="');
		expect(API).toContain('api.get("/api/usage"');
	});
});
