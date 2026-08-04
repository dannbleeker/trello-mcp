/**
 * File: src/dashboard/handler.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: Browser-facing routes for the private To-Do dashboard, mounted on
 *              the OAuthProvider's defaultHandler (src/github-handler.ts) so they
 *              share the Worker with the MCP surface without touching it.
 *
 *              Routes:
 *                GET /              → 302 /dashboard
 *                GET /dashboard     → the dashboard page (or 302 /app/login)
 *                GET /app/login     → start a browser GitHub OAuth login
 *                GET /app/callback  → finish it; allowlist-gate; set session cookie
 *                GET /app/logout    → clear session, back to /app/login
 *                /api/*             → JSON API (src/dashboard/api.ts)
 *
 *              Reuses the existing GitHub OAuth app. Its "Authorization callback
 *              URL" must be broadened to the Worker origin root so both /callback
 *              (MCP flow) and /app/callback (this flow) validate — a one-time
 *              manual step documented in the README.
 *
 * Change log:
 *   1.2.0 (2026-08-04) — /digest/preview owns a `dashboard` UsageRecorder and
 *                        flushes it in a finally. This route sits outside the
 *                        /api/* middleware, so it cannot inherit the
 *                        request-scoped recorder that api.ts installs.
 *   1.1.0 (2026-07-10) — /app/callback: token-exchange/GitHub failures now return a
 *                        friendly 502 and every exit path clears the one-time state
 *                        cookie (previously an unhandled throw → bare 500 with the
 *                        cookie left set).
 *   1.0.0 (2026-07-10) — Initial (v1.12.0 dashboard release).
 */

import { Hono } from "hono";
import { Octokit } from "octokit";
import { ALLOWED_LOGINS } from "../allowlist";
import { renderDigest } from "../digest/render";
import { TrelloClient } from "../trello/client";
import { BOARD_ALIASES, DEFAULT_BOARD, DEFAULT_TIMEZONE } from "../trello/constants";
import { list_snoozed_cards } from "../trello/tools";
import { UsageRecorder } from "../usage";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "../utils";
import { type DashboardEnv, DashboardApi } from "./api";
import DASHBOARD_HTML from "./page.html";
import {
	clearSessionCookie,
	clearStateCookie,
	createSessionCookie,
	createStateCookie,
	getCookieValue,
	STATE_COOKIE,
	verifySessionCookie,
} from "./session";

/**
 * Session gate for browser pages: null when a valid allowlisted session exists,
 * otherwise the redirect-to-login response to return.
 */
async function requireSession(c: { env: DashboardEnv; req: { header: (n: string) => string | undefined } }): Promise<Response | null> {
	const session = await verifySessionCookie(c.req.header("Cookie"), c.env.COOKIE_ENCRYPTION_KEY);
	if (!session || !ALLOWED_LOGINS.has(session.login)) {
		return new Response(null, { headers: { Location: "/app/login" }, status: 302 });
	}
	return null;
}

const app = new Hono<{ Bindings: DashboardEnv }>();

app.get("/", (c) => c.redirect("/dashboard", 302));

// PWA support (v1.16.0): manifest + icon are public — they contain nothing
// sensitive and install-time fetches don't reliably carry cookies.
app.get("/manifest.webmanifest", (c) =>
	c.json(
		{
			background_color: "#f6f7f9",
			display: "standalone",
			icons: [{ purpose: "any", sizes: "any", src: "/icon.svg", type: "image/svg+xml" }],
			name: "Dann — To-Do Dashboard",
			short_name: "To-Do",
			start_url: "/dashboard",
			theme_color: "#1c2024",
		},
		200,
		{ "Cache-Control": "public, max-age=86400", "Content-Type": "application/manifest+json" },
	),
);

app.get("/icon.svg", (c) =>
	c.body(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#1c2024"/><path d="M28 52 l16 16 l30 -34" fill="none" stroke="#4ade80" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
		200,
		{ "Cache-Control": "public, max-age=86400", "Content-Type": "image/svg+xml" },
	),
);

app.get("/dashboard", async (c) => {
	const denied = await requireSession(c);
	if (denied) return denied;
	return c.html(DASHBOARD_HTML, 200, {
		"Cache-Control": "no-store",
		"X-Frame-Options": "DENY",
	});
});

app.get("/app/login", (c) => {
	const state = crypto.randomUUID();
	return new Response(null, {
		headers: {
			Location: getUpstreamAuthorizeUrl({
				client_id: c.env.GITHUB_CLIENT_ID,
				redirect_uri: new URL("/app/callback", c.req.url).href,
				scope: "read:user",
				state,
				upstream_url: "https://github.com/login/oauth/authorize",
			}),
			"Set-Cookie": createStateCookie(state),
		},
		status: 302,
	});
});

app.get("/app/callback", async (c) => {
	// CSRF check: the state GitHub echoes back must match the one this browser
	// was handed at /app/login. The cookie is cleared either way (one-time use).
	const stateFromQuery = c.req.query("state");
	const stateFromCookie = getCookieValue(c.req.header("Cookie"), STATE_COOKIE);
	if (!stateFromQuery || !stateFromCookie || stateFromQuery !== stateFromCookie) {
		return c.text("Invalid or expired login state — restart at /app/login.", 400, {
			"Set-Cookie": clearStateCookie(),
		});
	}

	// Every path out of here clears the one-time state cookie — including the
	// failure paths, so a stuck cookie can't wedge the next login attempt.
	let login: string;
	try {
		const [accessToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code: c.req.query("code"),
			redirect_uri: new URL("/app/callback", c.req.url).href,
			upstream_url: "https://github.com/login/oauth/access_token",
		});
		if (errResponse) {
			const headers = new Headers(errResponse.headers);
			headers.append("Set-Cookie", clearStateCookie());
			return new Response(errResponse.body, { headers, status: errResponse.status });
		}

		const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
		login = user.data.login;
	} catch (e) {
		console.error("dashboard /app/callback error:", e);
		return c.text("GitHub sign-in failed — restart at /app/login.", 502, {
			"Set-Cookie": clearStateCookie(),
		});
	}

	if (!ALLOWED_LOGINS.has(login)) {
		return c.text(`Access denied. GitHub user "${login}" is not on this server's allowlist.`, 403, {
			"Set-Cookie": clearStateCookie(),
		});
	}

	const headers = new Headers({ Location: "/dashboard" });
	headers.append("Set-Cookie", clearStateCookie());
	headers.append("Set-Cookie", await createSessionCookie(login, c.env.COOKIE_ENCRYPTION_KEY));
	return new Response(null, { headers, status: 302 });
});

app.get("/digest/preview", async (c) => {
	// Renders the exact email HTML in the browser (session-gated) so the
	// digest can be eyeballed without sending anything.
	const denied = await requireSession(c);
	if (denied) return denied;
	// This route sits outside the /api/* middleware, so it owns its recorder.
	const usage = new UsageRecorder(c.env, "dashboard");
	try {
		const client = new TrelloClient(c.env.TRELLO_KEY, c.env.TRELLO_TOKEN, usage);
		const nowMs = Date.now();
		const cards = await client.listCardsOnBoard(BOARD_ALIASES[DEFAULT_BOARD]);
		let snoozed: Awaited<ReturnType<typeof list_snoozed_cards>>["snoozed"] = [];
		try {
			snoozed = (await list_snoozed_cards(client, {}, nowMs)).snoozed;
		} catch (_e) {
			// best-effort, same as the real send
		}
		const { html } = renderDigest(cards, nowMs, DEFAULT_TIMEZONE, snoozed);
		return c.html(html, 200, { "Cache-Control": "no-store" });
	} catch (_e) {
		return c.text("Couldn't render the digest preview (Trello unreachable?).", 502);
	} finally {
		await usage.flush();
	}
});

app.get("/app/logout", (c) => {
	return new Response(null, {
		headers: {
			Location: "/app/login",
			"Set-Cookie": clearSessionCookie(),
		},
		status: 302,
	});
});

app.route("/", DashboardApi);

export { app as DashboardHandler };
