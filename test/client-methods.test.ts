import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrelloClient } from "../src/trello/client";

// URL/param construction assertions across a representative sample of
// TrelloClient methods. The goal isn't to test every method — it's to catch
// the class of bug where a wrong path, wrong verb, or wrong param name gets
// deployed (like the v1.7.0 set_card_cover / v1.9.0 update_custom_field bugs).

function ok(body: unknown = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("TrelloClient URL + param construction", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	const client = new TrelloClient("KEY", "TOKEN");

	function lastCall(): [string, RequestInit | undefined] {
		const call = fetchSpy.mock.calls.at(-1);
		if (!call) throw new Error("no fetch calls recorded");
		return [call[0] as string, call[1] as RequestInit | undefined];
	}

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValue(ok());
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("getCard → GET /cards/{id}", async () => {
		fetchSpy.mockResolvedValueOnce(ok({ id: "c1" }));
		await client.getCard("c1");
		const [url, init] = lastCall();
		expect(new URL(url).pathname).toBe("/1/cards/c1");
		expect(init?.method ?? "GET").toBe("GET");
	});

	it("moveCard → PUT /cards/{id}?idList=...", async () => {
		await client.moveCard("c1", "listX");
		const [url, init] = lastCall();
		const u = new URL(url);
		expect(u.pathname).toBe("/1/cards/c1");
		expect(u.searchParams.get("idList")).toBe("listX");
		expect(init?.method).toBe("PUT");
	});

	it("voteCard defaults to 'me' as the member value", async () => {
		await client.voteCard("c1");
		const [url, init] = lastCall();
		const u = new URL(url);
		expect(u.pathname).toBe("/1/cards/c1/membersVoted");
		expect(u.searchParams.get("value")).toBe("me");
		expect(init?.method).toBe("POST");
	});

	it("unvoteCard → DELETE /cards/{id}/membersVoted/{memberId}", async () => {
		await client.unvoteCard("c1", "memberA");
		const [url, init] = lastCall();
		expect(new URL(url).pathname).toBe("/1/cards/c1/membersVoted/memberA");
		expect(init?.method).toBe("DELETE");
	});

	it("addCommentReaction → POST /actions/{id}/reactions with shortName", async () => {
		await client.addCommentReaction("actionA", "thumbsup");
		const [url, init] = lastCall();
		const u = new URL(url);
		expect(u.pathname).toBe("/1/actions/actionA/reactions");
		expect(u.searchParams.get("shortName")).toBe("thumbsup");
		expect(init?.method).toBe("POST");
	});

	// v1.7.1 REGRESSION: setCardCover with only a color must NOT send
	// idAttachment:null — Trello would treat the null as "clear the cover" and
	// wipe the color too.
	it("setCardCover(color=purple) does not put idAttachment:null in the cover blob", async () => {
		await client.setCardCover("c1", { color: "purple", size: "normal", brightness: "dark" });
		const [url] = lastCall();
		const cover = new URL(url).searchParams.get("cover");
		expect(cover).toBeTruthy();
		const parsed = JSON.parse(cover as string);
		expect(parsed.color).toBe("purple");
		expect(parsed.size).toBe("normal");
		expect(parsed.brightness).toBe("dark");
		expect("idAttachment" in parsed).toBe(false);
	});

	// v1.7.1 REGRESSION extension: clearCardCover sends an empty object.
	it("clearCardCover sends {} as the cover blob", async () => {
		await client.clearCardCover("c1");
		const [url] = lastCall();
		expect(new URL(url).searchParams.get("cover")).toBe("{}");
	});

	// v1.9.0 REGRESSION: updateCustomField must send display/cardFront with a
	// literal slash — URLSearchParams would encode it to %2F and Trello would
	// ignore the unknown key.
	it("updateCustomField(displayCardFront=true) preserves the literal slash", async () => {
		await client.updateCustomField("cfA", { displayCardFront: true });
		const [url, init] = lastCall();
		expect(init?.method).toBe("PUT");
		// The url string itself should contain literal "display/cardFront=true"
		// with an unencoded slash. If URLSearchParams was used, we'd see %2F.
		expect(url).toContain("display/cardFront=true");
		expect(url).not.toContain("display%2FcardFront");
	});

	it("batchGet → GET /batch?urls=comma,separated,paths", async () => {
		fetchSpy.mockResolvedValueOnce(
			ok([{ "200": { id: "b1" } }, { "200": { id: "b2" } }]),
		);
		const results = await client.batchGet(["/boards/b1", "/boards/b2"]);
		const [url] = lastCall();
		expect(new URL(url).pathname).toBe("/1/batch");
		expect(new URL(url).searchParams.get("urls")).toBe("/boards/b1,/boards/b2");
		expect(results).toEqual([
			{ statusCode: 200, body: { id: "b1" } },
			{ statusCode: 200, body: { id: "b2" } },
		]);
	});

	// v1.9.0 REGRESSION: non-numeric key envelopes surface as 502, not NaN.
	it("batchGet normalises a non-numeric key entry to statusCode: 502", async () => {
		fetchSpy.mockResolvedValueOnce(ok([{ error: "invalid path" }, { "200": { ok: true } }]));
		const results = await client.batchGet(["/foo", "/boards/b2"]);
		expect(results[0].statusCode).toBe(502);
		expect(results[1].statusCode).toBe(200);
	});

	// v1.9.0: markAllNotificationsRead no longer accepts filter (the ids-as-filter
	// misuse is fixed at the client layer).
	it("markAllNotificationsRead does not send an `ids` param", async () => {
		await client.markAllNotificationsRead({ read: true });
		const [url] = lastCall();
		expect(new URL(url).pathname).toBe("/1/notifications/all/read");
		expect(new URL(url).searchParams.get("ids")).toBeNull();
		expect(new URL(url).searchParams.get("read")).toBe("true");
	});
	// ---- v1.19.0: workspaces (Trello "organizations") ----

	it("listMyOrganizations → GET /members/me/organizations with trimmed fields", async () => {
		fetchSpy.mockResolvedValueOnce(ok([]));
		await client.listMyOrganizations();
		const [url] = lastCall();
		const u = new URL(url);
		expect(u.pathname).toBe("/1/members/me/organizations");
		expect(u.searchParams.get("fields")).toBe("name,displayName,url");
	});

	it("getOrganization → GET /organizations/{idOrName}", async () => {
		fetchSpy.mockResolvedValueOnce(ok({ id: "o1" }));
		await client.getOrganization("techretail1");
		expect(new URL(lastCall()[0]).pathname).toBe("/1/organizations/techretail1");
	});

	it("listOrganizationBoards → GET /organizations/{id}/boards, open only", async () => {
		fetchSpy.mockResolvedValueOnce(ok([]));
		await client.listOrganizationBoards("o1");
		const u = new URL(lastCall()[0]);
		expect(u.pathname).toBe("/1/organizations/o1/boards");
		expect(u.searchParams.get("filter")).toBe("open");
	});

	// Board reads must request idOrganization — it's the only link from a board
	// back to its workspace, and Trello omits it unless asked.
	it("listMyBoards asks for idOrganization", async () => {
		fetchSpy.mockResolvedValueOnce(ok([]));
		await client.listMyBoards();
		expect(new URL(lastCall()[0]).searchParams.get("fields")).toContain("idOrganization");
	});

	it("getBoard asks for idOrganization", async () => {
		fetchSpy.mockResolvedValueOnce(ok({ id: "b1" }));
		await client.getBoard("b1");
		expect(new URL(lastCall()[0]).searchParams.get("fields")).toContain("idOrganization");
	});

	it("searchCards scopes by workspace via idOrganizations", async () => {
		fetchSpy.mockResolvedValueOnce(ok({ cards: [] }));
		await client.searchCards("retail", undefined, "org1");
		const u = new URL(lastCall()[0]);
		expect(u.searchParams.get("idOrganizations")).toBe("org1");
		expect(u.searchParams.get("idBoards")).toBeNull();
	});

	it("searchCardsAdvanced joins multiple workspace ids", async () => {
		fetchSpy.mockResolvedValueOnce(ok({ cards: [] }));
		await client.searchCardsAdvanced({ query: "x", orgIds: ["o1", "o2"] });
		expect(new URL(lastCall()[0]).searchParams.get("idOrganizations")).toBe("o1,o2");
	});

	it("searchCardsAdvanced omits both scope params when neither is given", async () => {
		fetchSpy.mockResolvedValueOnce(ok({ cards: [] }));
		await client.searchCardsAdvanced({ query: "x", boardIds: [], orgIds: [] });
		const u = new URL(lastCall()[0]);
		expect(u.searchParams.get("idOrganizations")).toBeNull();
		expect(u.searchParams.get("idBoards")).toBeNull();
	});
});
