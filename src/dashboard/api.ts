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
 *   1.20.0 (2026-07-30) — GET /api/cards also returns the board's `lists`. The page
 *                         used to hardcode the board ID, the five context list IDs
 *                         and their WIP limits, so a list added or a limit changed
 *                         in Trello never reached the dashboard. Fetched alongside
 *                         the cards, not after them.
 *   1.1.0 (2026-07-10) — /api/done now also moves the card to Done-do (deterministic
 *                        for no-due-date cards where Butler's trigger never fires);
 *                        Trello 4xx keep their status class (404/422) instead of
 *                        masquerading as 502; extracted trello() client helper.
 *   1.19.0 (2026-07-27) — ?board= goes through resolveBoardRef, so the board
 *                         view can be pointed at a board in any workspace by
 *                         name, ID or URL — same reference syntax as the tools.
 *   1.0.0 (2026-07-10) — Initial (v1.12.0 dashboard release):
 *                        GET /api/cards, POST /api/move, POST /api/done, POST /api/capture.
 */

import { Hono } from "hono";
import { ALLOWED_LOGINS } from "../allowlist";
import { noteManualSend, sendDigestEmail } from "../digest/scheduler";
import { TrelloClient, TrelloError } from "../trello/client";
import { BOARD_ALIASES, DEFAULT_BOARD } from "../trello/constants";
import { resolveBoardRef } from "../trello/resolve";
import { GuardError } from "../trello/guards";
import { create_card, list_snoozed_cards, move_card, set_due_complete, wake_card, weekly_review_pack } from "../trello/tools";
import { verifySessionCookie } from "./session";

/** The subset of Worker bindings the dashboard needs. Matches names in wrangler secrets/vars. */
export type DashboardEnv = {
	TRELLO_KEY: string;
	TRELLO_TOKEN: string;
	COOKIE_ENCRYPTION_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	// Digest test-send (optional until the Resend account exists).
	RESEND_API_KEY?: string;
	DIGEST_FROM?: string;
	DIGEST_TO?: string;
	// Present in the real Worker; optional here so unit tests can omit it.
	OAUTH_KV?: KVNamespace;
};

/** Card capture always lands in the Inbox; the client never chooses the destination. */
const CAPTURE_LIST_ALIAS = "inbox";

/** Where ✓ Done sends cards (see /api/done). */
const DONE_LIST_ALIAS = "done";

/** One place to construct the Trello client from bindings. */
function trello(env: DashboardEnv): TrelloClient {
	return new TrelloClient(env.TRELLO_KEY, env.TRELLO_TOKEN);
}

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
 * written for the caller and are surfaced verbatim. Trello failures stay
 * opaque (never the raw upstream body — it may echo the token), but keep
 * their status class: a Trello 4xx is the caller's problem (stale cardId →
 * 404), not a gateway failure, so only genuine Trello 5xx become 502.
 * Anything else is a generic 500.
 */
function errorResponse(
	c: { json: (o: object, s: 403 | 404 | 422 | 500 | 502) => Response },
	e: unknown,
): Response {
	if (e instanceof GuardError) {
		return c.json({ error: e.message }, 403);
	}
	if (e instanceof TrelloError) {
		if (e.status >= 400 && e.status < 500) {
			const status = e.status === 404 ? 404 : 422;
			return c.json({ error: `Trello rejected the request (HTTP ${e.status}).` }, status);
		}
		return c.json({ error: `Trello upstream error (HTTP ${e.status}).` }, 502);
	}
	console.error("dashboard api error:", e);
	return c.json({ error: "Internal error." }, 500);
}

/** A trimmed string field from a parsed body, or "" when absent/not a string. */
function readString(body: Record<string, unknown>, key: string): string {
	const v = body[key];
	return typeof v === "string" ? v.trim() : "";
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
	// resolveBoardRef (v1.19.0) accepts a board name / URL as well as an alias
	// or ID, so the dashboard can be pointed at a board in any workspace with
	// ?board=… — the same reference syntax the MCP tools take. One client for
	// the whole request: the resolver's directory cache is per client, so
	// building a second one below would throw the lookup away.
	const client = trello(c.env);
	let boardId: string;
	try {
		boardId = await resolveBoardRef(client, boardParam ?? BOARD_ALIASES[DEFAULT_BOARD]);
	} catch (e) {
		return errorResponse(c, e);
	}

	// ?customFields=1 adds each card's custom-field values inline (same request)
	// plus the board's field definitions, so the page can render a value with
	// its name without a second round trip. Off by default: the board may have
	// no fields at all, and the extra payload is pure weight when it doesn't.
	// v1.18.0.
	const wantFields = ["1", "true", "yes"].includes(
		(c.req.query("customFields") ?? "").toLowerCase(),
	);

	try {
		// `lists` ships with every response (v1.20.0): the page derives its whole
		// layout from it — which lists are contexts, their WIP limits, which one
		// is the Inbox — instead of hardcoding IDs and limits that go stale the
		// moment the board changes. Not optional, because without it the page has
		// no columns to render; a failure here is as fatal as the card fetch.
		const [cards, lists] = await Promise.all([
			client.listCardsOnBoard(boardId, { customFieldItems: wantFields }),
			client.listListsOnBoard(boardId),
		]);
		if (!wantFields) return c.json({ cards, lists });
		// A board without the Power-Up must not break the board view — fall back
		// to no definitions and the page simply renders nothing.
		let customFields: unknown[] = [];
		try {
			customFields = await client.listCustomFields(boardId);
		} catch {
			customFields = [];
		}
		return c.json({ cards, customFields, lists });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/move", async (c) => {
	const body = await readJsonBody(c);
	const cardId = readString(body, "cardId");
	const list = readString(body, "list");
	if (!cardId || !list) {
		return c.json({ error: "cardId and list are required non-empty strings." }, 400);
	}

	try {
		const client = trello(c.env);
		const { warning } = await move_card(client, { cardId, list });
		return c.json({ ok: true, ...(warning ? { warning } : {}) });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/done", async (c) => {
	const body = await readJsonBody(c);
	const cardId = readString(body, "cardId");
	if (!cardId) {
		return c.json({ error: "cardId is a required non-empty string." }, 400);
	}

	try {
		const client = trello(c.env);
		// Flip dueComplete first (same semantics as the MCP set_due_complete
		// tool — Butler triggers watching it still fire), then move the card
		// to Done-do ourselves. Butler's own move becomes a no-op, but cards
		// WITHOUT a due date — where Butler's due-complete trigger never
		// fires — land in Done deterministically instead of silently staying
		// put (v1.13.0 fix). The move also makes the page's optimistic update
		// survive a reload that races Butler.
		await set_due_complete(client, { cardId, complete: true });
		const { warning } = await move_card(client, { cardId, list: DONE_LIST_ALIAS });
		return c.json({ ok: true, ...(warning ? { warning } : {}) });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.get("/api/review", async (c) => {
	// Backs the dashboard's weekly-review panel. Reuses the MCP tool rather than
	// re-deriving the buckets, so the panel, the digest's Friday block and a
	// review run through Claude all read the same numbers. Fetched lazily by the
	// page (only when the panel is open) — it is a second full board read.
	try {
		return c.json(await weekly_review_pack(trello(c.env), {}));
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.get("/api/snoozed", async (c) => {
	try {
		const { snoozed } = await list_snoozed_cards(trello(c.env), {});
		return c.json({ snoozed });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/wake", async (c) => {
	const body = await readJsonBody(c);
	const cardId = readString(body, "cardId");
	if (!cardId) {
		return c.json({ error: "cardId is a required non-empty string." }, 400);
	}

	try {
		// wake_card refuses non-snoozed cards and guards the home list.
		const { card } = await wake_card(trello(c.env), { cardId });
		return c.json({ card, ok: true });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/digest/send", async (c) => {
	// Owner-facing test send of the daily digest ("does the email look right,
	// right now?"). Session + Origin gates apply via the /api/* middleware.
	try {
		const nowMs = Date.now();
		await sendDigestEmail(c.env, nowMs);
		// If this test send happens inside the 04-06 cron window, flag the day
		// as sent so a remaining cron slot doesn't duplicate it minutes later.
		if (c.env.OAUTH_KV) {
			await noteManualSend(c.env as Parameters<typeof noteManualSend>[0], nowMs);
		}
		return c.json({ ok: true, to: c.env.DIGEST_TO ?? "(default recipient)" });
	} catch (e) {
		if (e instanceof GuardError || e instanceof TrelloError) {
			return errorResponse(c, e);
		}
		// Config/Resend errors carry no secrets and ARE the diagnosis — surface them.
		return c.json({ error: e instanceof Error ? e.message : "Digest send failed." }, 502);
	}
});

api.post("/api/undo-done", async (c) => {
	// Undo for ✓ Done: clear dueComplete (so Butler doesn't re-move it) and
	// move the card back to the list it came from. v1.16.0.
	const body = await readJsonBody(c);
	const cardId = readString(body, "cardId");
	const list = readString(body, "list");
	if (!cardId || !list) {
		return c.json({ error: "cardId and list are required non-empty strings." }, 400);
	}

	try {
		const client = trello(c.env);
		// Move back FIRST: if the flag-clear then fails, the card is at least
		// visible in its column (still done-flagged) instead of stranded
		// invisible in Done-do with the flag cleared. Butler's done-automation
		// fires on the marking ACTION, not on state, so moving a still-flagged
		// card does not bounce it back. v1.16.1 fix.
		const { warning } = await move_card(client, { cardId, list });
		await set_due_complete(client, { cardId, complete: false });
		return c.json({ ok: true, ...(warning ? { warning } : {}) });
	} catch (e) {
		return errorResponse(c, e);
	}
});

api.post("/api/capture", async (c) => {
	const body = await readJsonBody(c);
	const name = readString(body, "name");
	if (!name) {
		return c.json({ error: "name is a required non-empty string." }, 400);
	}

	try {
		const client = trello(c.env);
		const { card, warning } = await create_card(client, { list: CAPTURE_LIST_ALIAS, name });
		return c.json({ card, ...(warning ? { warning } : {}) }, 201);
	} catch (e) {
		return errorResponse(c, e);
	}
});

export { api as DashboardApi };
