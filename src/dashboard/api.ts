/**
 * File: src/dashboard/api.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: JSON API consumed by the dashboard page (src/dashboard/page.html).
 *              Session-gated: every route verifies the __Host-DASH_SESSION cookie
 *              AND re-checks ALLOWED_LOGINS. Mutating routes additionally require
 *              a same-origin Origin header (defense-in-depth on top of
 *              SameSite=Lax) and reuse the tools layer (move_card, create_card,
 *              set_due_complete) so the dashboard obeys the exact same guards as
 *              the MCP tools — no policy drift between surfaces.
 *
 *              Kept separate from handler.ts so tests can import these routes in
 *              plain Node without resolving the page.html Text-module import.
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Initial (v1.12.0 dashboard release):
 *                        GET /api/cards, POST /api/move, POST /api/done, POST /api/capture.
 */

import { Hono } from "hono";
import { ALLOWED_LOGINS } from "../allowlist";
import { TrelloClient, TrelloError } from "../trello/client";
import { BOARD_ALIASES, DEFAULT_BOARD, resolveBoard } from "../trello/constants";
import { GuardError } from "../trello/guards";
import { create_card, move_card, set_due_complete } from "../trello/tools";
import { verifySessionCookie } from "./session";

/** The subset of Worker bindings the dashboard needs. Matches names in wrangler secrets. */
export type DashboardEnv = {
	TRELLO_KEY: string;
	TRELLO_TOKEN: string;
	COOKIE_ENCRYPTION_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
};

/** Card capture always lands in the Inbox; the client never chooses the destination. */
const CAPTURE_LIST_ALIAS = "inbox";

const api = new Hono<{ Bindings: DashboardEnv; Variables: { login: string } }>();

/**
 * Session gate for every /api/* route. JSON 401 (not a redirect) — the page's
 * fetch helper reacts to 401 by navigating to /app/login itself.
 */
api.use("/api/*", async (c, next) => {
	const session = await verifySessionCookie(c.req.header("Cookie"), c.env.COOKIE_ENCRYPTION_KEY);
	if (!session) {
		return c.json({ error: "Not signed in." }, 401);
	}
	if (!ALLOWED_LOGINS.has(session.login)) {
		return c.json({ error: `GitHub user "${session.login}" is not on this server's allowlist.` }, 403);
	}
	// Cross-site POSTs are already blocked by SameSite=Lax; the Origin check
	// catches anything that still arrives with a foreign Origin header.
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		const origin = c.req.header("Origin");
		if (origin && origin !== new URL(c.req.url).origin) {
			return c.json({ error: "Cross-origin requests are not allowed." }, 403);
		}
	}
	c.set("login", session.login);
	await next();
});

/**
 * Map thrown errors to the API's JSON error contract. GuardError messages were
 * written for the caller and are surfaced verbatim; Trello upstream failures
 * become an opaque 502 (never the raw upstream body — it may echo the token);
 * anything else is a generic 500.
 */
function errorResponse(c: { json: (o: object, s: 403 | 500 | 502) => Response }, e: unknown): Response {
	if (e instanceof GuardError) {
		return c.json({ error: e.message }, 403);
	}
	if (e instanceof TrelloError) {
		return c.json({ error: `Trello upstream error (HTTP ${e.status}).` }, 502);
	}
	console.error("dashboard api error:", e);
	return c.json({ error: "Internal error." }, 500);
}

/** Parse a JSON request body, tolerating malformed/absent JSON as an empty object. */
async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
	try {
		const body = await c.req.json();
		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	} catch (_e) {
		return {};
	}
}

api.get("/api/cards", async (c) => {
	const boardParam = c.req.query("board");
	if (boardParam !== undefined && boardParam.trim().length === 0) {
		return c.json({ error: "board must be a non-empty string." }, 400);
	}
	const boardId = resolveBoard(boardParam ?? BOARD_ALIASES[DEFAULT_BOARD]);

	try {
		const client = new TrelloClient(c.env.TRELLO_KEY, c.env.TRELLO_TOKEN);
		const cards = await client.listCardsOnBoard(boardId);
		return c.json({ cards });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/move", async (c) => {
	const body = await readJsonBody(c);
	const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
	const list = typeof body.list === "string" ? body.list.trim() : "";
	if (!cardId || !list) {
		return c.json({ error: "cardId and list are required non-empty strings." }, 400);
	}

	try {
		const client = new TrelloClient(c.env.TRELLO_KEY, c.env.TRELLO_TOKEN);
		const { warning } = await move_card(client, { cardId, list });
		return c.json({ ok: true, ...(warning ? { warning } : {}) });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/done", async (c) => {
	const body = await readJsonBody(c);
	const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
	if (!cardId) {
		return c.json({ error: "cardId is a required non-empty string." }, 400);
	}

	try {
		const client = new TrelloClient(c.env.TRELLO_KEY, c.env.TRELLO_TOKEN);
		// Same semantics as the MCP set_due_complete tool: flip dueComplete and
		// let the board's Butler automation move the card to Done-do.
		await set_due_complete(client, { cardId, complete: true });
		return c.json({ ok: true });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/capture", async (c) => {
	const body = await readJsonBody(c);
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) {
		return c.json({ error: "name is a required non-empty string." }, 400);
	}

	try {
		const client = new TrelloClient(c.env.TRELLO_KEY, c.env.TRELLO_TOKEN);
		const { card, warning } = await create_card(client, { list: CAPTURE_LIST_ALIAS, name });
		return c.json({ card, ...(warning ? { warning } : {}) }, 201);
	} catch (e) {
		return errorResponse(c, e);
	}
});

export { api as DashboardApi };
