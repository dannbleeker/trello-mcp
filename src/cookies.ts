/**
 * File: src/cookies.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: The one cookie-header parser. Previously hand-rolled in four
 *              places (three in workers-oauth-utils.ts, one in
 *              dashboard/session.ts) with identical semantics; extracted to a
 *              leaf module so both the OAuth flow and the dashboard import it
 *              without creating a cycle.
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Extracted (v1.16.1 refactor). Behavior identical.
 */

/** Read one cookie's value from a Cookie request header. Returns null if absent. */
export function getCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
	if (!cookieHeader) return null;
	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const target = cookies.find((c) => c.startsWith(`${name}=`));
	return target ? target.substring(name.length + 1) : null;
}
