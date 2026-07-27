import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrelloClient, TrelloError } from "../src/trello/client";

// Small helper to build a Response the client's request() expects. The client
// only reads status, ok, headers["content-type"], and json()/text() — so we
// stub those.
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function textResponse(body: string, status: number, extraHeaders: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/plain", ...extraHeaders },
	});
}

describe("TrelloClient.request (via a public method that exercises the code path)", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	const client = new TrelloClient("test-key", "test-token");

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		vi.useRealTimers();
	});

	it("returns parsed JSON on 200 first try", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse([{ id: "b1", name: "Board" }]));
		const boards = await client.listMyBoards();
		expect(boards).toEqual([{ id: "b1", name: "Board" }]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("retries once on 429 then returns success", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("rate limited", 429, { "Retry-After": "1" }))
			.mockResolvedValueOnce(jsonResponse([]));

		const promise = client.listMyBoards();
		// Advance past the 1-second Retry-After
		await vi.advanceTimersByTimeAsync(1500);
		const result = await promise;

		expect(result).toEqual([]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("throws TrelloError after 3 total attempts on persistent 500s", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("boom", 500))
			.mockResolvedValueOnce(textResponse("boom", 500))
			.mockResolvedValueOnce(textResponse("boom", 500));

		const promise = client.listMyBoards();
		const settle = promise.catch((e) => e);
		// Advance well past both backoffs (500ms then 1000ms).
		await vi.advanceTimersByTimeAsync(10_000);
		const err = await settle;

		expect(err).toBeInstanceOf(TrelloError);
		expect((err as TrelloError).status).toBe(500);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("does NOT retry a 4xx that isn't 429 (e.g. 404)", async () => {
		fetchSpy.mockResolvedValueOnce(textResponse("not found", 404));
		await expect(client.listMyBoards()).rejects.toBeInstanceOf(TrelloError);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry a 5xx on POST — a gateway 5xx can arrive after the write committed (v1.13.0)", async () => {
		fetchSpy.mockResolvedValueOnce(textResponse("bad gateway", 502));
		await expect(client.createCard({ idList: "l1", name: "x" })).rejects.toBeInstanceOf(TrelloError);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("still retries a 5xx on idempotent PUT", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("boom", 500))
			.mockResolvedValueOnce(jsonResponse({ id: "c1", idList: "l2" }));

		const promise = client.moveCard("c1", "l2");
		await vi.advanceTimersByTimeAsync(5_000);
		const moved = await promise;

		expect(moved).toMatchObject({ id: "c1", idList: "l2" });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("still retries a 429 on POST — Trello rejected it before acting, so a retry can't duplicate", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("rate limited", 429, { "Retry-After": "1" }))
			.mockResolvedValueOnce(jsonResponse({ id: "c9", name: "x" }));

		const promise = client.createCard({ idList: "l1", name: "x" });
		await vi.advanceTimersByTimeAsync(1_500);
		const created = await promise;

		expect(created).toMatchObject({ id: "c9" });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("puts key + token on the query string of every request", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse([]));
		await client.listMyBoards();
		const [url] = fetchSpy.mock.calls[0];
		const urlObj = new URL(url as string);
		expect(urlObj.searchParams.get("key")).toBe("test-key");
		expect(urlObj.searchParams.get("token")).toBe("test-token");
	});
});

// updateCustomField is the one method that can't route through request() — it
// hand-builds the URL so Trello's `display/cardFront` key keeps its literal
// slash (URLSearchParams would emit %2F and Trello would drop the key). Until
// v1.17.0 it hand-rolled fetch() too, and silently lost the retry loop that
// every other call gets. These pin both halves: the slash survives, AND the
// call still backs off on 429 / transient 5xx.
describe("TrelloClient.updateCustomField", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	const client = new TrelloClient("test-key", "test-token");

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		vi.useRealTimers();
	});

	it("sends display/cardFront with a literal slash, not %2F", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse({ id: "cf1", name: "Effort" }));
		await client.updateCustomField("cf1", { displayCardFront: true });
		const [url] = fetchSpy.mock.calls[0];
		expect(url as string).toContain("display/cardFront=true");
		expect(url as string).not.toContain("display%2FcardFront");
	});

	it("retries on 429 instead of throwing (v1.17.0 fix)", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("rate limited", 429, { "Retry-After": "1" }))
			.mockResolvedValueOnce(jsonResponse({ id: "cf1", name: "Effort" }));

		const promise = client.updateCustomField("cf1", { name: "Effort" });
		await vi.advanceTimersByTimeAsync(1_500);
		const updated = await promise;

		expect(updated).toMatchObject({ id: "cf1" });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("retries a transient 500 — PUT is idempotent", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("boom", 500))
			.mockResolvedValueOnce(jsonResponse({ id: "cf1", name: "Effort" }));

		const promise = client.updateCustomField("cf1", { name: "Effort" });
		await vi.advanceTimersByTimeAsync(5_000);
		await promise;

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("still throws TrelloError once retries are exhausted", async () => {
		vi.useFakeTimers();
		fetchSpy
			.mockResolvedValueOnce(textResponse("boom", 503))
			.mockResolvedValueOnce(textResponse("boom", 503))
			.mockResolvedValueOnce(textResponse("boom", 503));

		const promise = client.updateCustomField("cf1", { name: "Effort" });
		const settle = promise.catch((e) => e);
		await vi.advanceTimersByTimeAsync(10_000);
		const err = await settle;

		expect(err).toBeInstanceOf(TrelloError);
		expect((err as TrelloError).status).toBe(503);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});
});
