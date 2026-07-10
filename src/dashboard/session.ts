/**
 * File: src/dashboard/session.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: Browser session cookie for the web dashboard. Payload is
 *              { login, exp } signed with COOKIE_ENCRYPTION_KEY using the same
 *              HMAC-SHA256 primitive as the MCP flow's __Host-APPROVED_CLIENTS
 *              cookie (hex signature + "." + base64 JSON payload). The cookie
 *              only proves "this browser completed GitHub login as <login>";
 *              every gated request re-checks ALLOWED_LOGINS so removing a login
 *              revokes access on the next request, not at cookie expiry.
 *
 *              Also holds the short-lived __Host-DASH_STATE cookie used as the
 *              CSRF state for the dashboard's own GitHub login. Deliberately a
 *              different name than the MCP flow's __Host-CONSENTED_STATE so a
 *              dashboard login can't clobber an in-flight MCP authorization.
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Initial (v1.12.0 dashboard release).
 */

import { signData, verifySignature } from "../workers-oauth-utils";

/** __Host- prefix requires: Secure, Path=/, no Domain — enforced in the attribute strings below. */
export const SESSION_COOKIE = "__Host-DASH_SESSION";
export const STATE_COOKIE = "__Host-DASH_STATE";

/** Session lifetime: 30 days, matching the MCP approved-clients cookie. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** GitHub-login OAuth state lifetime: 10 minutes, matching the MCP flow's state TTL. */
export const STATE_TTL_SECONDS = 600;

export interface DashSession {
	login: string;
	/** Unix epoch seconds after which the session is invalid. */
	exp: number;
}

const COOKIE_ATTRS = "HttpOnly; Secure; Path=/; SameSite=Lax";

/** Read one cookie's value from a Cookie request header. Returns null if absent. */
export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
	if (!cookieHeader) return null;
	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const target = cookies.find((c) => c.startsWith(`${name}=`));
	return target ? target.substring(name.length + 1) : null;
}

/** Build the Set-Cookie header establishing a signed session for `login`. */
export async function createSessionCookie(
	login: string,
	cookieSecret: string,
	nowMs = Date.now(),
): Promise<string> {
	const session: DashSession = {
		exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
		login,
	};
	const payload = JSON.stringify(session);
	const signature = await signData(payload, cookieSecret);
	return `${SESSION_COOKIE}=${signature}.${btoa(payload)}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_SECONDS}`;
}

/**
 * Verify the session cookie on a request. Returns the session when the
 * signature checks out and it hasn't expired; null on any defect (absent,
 * malformed, tampered, expired). Callers still must check ALLOWED_LOGINS.
 */
export async function verifySessionCookie(
	cookieHeader: string | undefined,
	cookieSecret: string,
	nowMs = Date.now(),
): Promise<DashSession | null> {
	const value = getCookieValue(cookieHeader, SESSION_COOKIE);
	if (!value) return null;

	const parts = value.split(".");
	if (parts.length !== 2) return null;
	const [signatureHex, base64Payload] = parts;

	let payload: string;
	try {
		payload = atob(base64Payload);
	} catch (_e) {
		return null;
	}

	if (!(await verifySignature(signatureHex, payload, cookieSecret))) return null;

	let session: DashSession;
	try {
		session = JSON.parse(payload);
	} catch (_e) {
		return null;
	}
	if (typeof session.login !== "string" || session.login.length === 0) return null;
	if (typeof session.exp !== "number" || session.exp * 1000 <= nowMs) return null;

	return session;
}

/** Set-Cookie header that deletes the session cookie (logout / revocation). */
export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}

/** Set-Cookie header carrying the one-time GitHub-login CSRF state. */
export function createStateCookie(state: string): string {
	return `${STATE_COOKIE}=${state}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_SECONDS}`;
}

/** Set-Cookie header that deletes the state cookie (one-time use). */
export function clearStateCookie(): string {
	return `${STATE_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}
