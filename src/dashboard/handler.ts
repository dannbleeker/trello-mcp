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
 *   1.0.0 (2026-07-10) — Initial (v1.12.0 dashboard release).
 */

import { Hono } from "hono";
import { Octokit } from "octokit";
import { ALLOWED_LOGINS } from "../allowlist";
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

const app = new Hono<{ Bindings: DashboardEnv }>();

app.get("/", (c) => c.redirect("/dashboard", 302));

app.get("/dashboard", async (c) => {
	const session = await verifySessionCookie(c.req.header("Cookie"), c.env.COOKIE_ENCRYPTION_KEY);
	if (!session || !ALLOWED_LOGINS.has(session.login)) {
		return c.redirect("/app/login", 302);
	}
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

	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/app/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
	const login = user.data.login;

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
