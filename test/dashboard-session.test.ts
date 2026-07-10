// Dashboard session-cookie tests: sign → verify round-trip, tamper rejection,
// expiry, and cookie-attribute pins (__Host- prefix requirements).

import { describe, expect, it } from "vitest";
import {
	clearSessionCookie,
	clearStateCookie,
	createSessionCookie,
	createStateCookie,
	getCookieValue,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	STATE_COOKIE,
	verifySessionCookie,
} from "../src/dashboard/session";

const SECRET = "test-cookie-encryption-key-0123456789abcdef";
const NOW = 1_800_000_000_000; // fixed clock so expiry math is deterministic

/** Turn a Set-Cookie header into the Cookie request-header a browser would send back. */
function asCookieHeader(setCookie: string): string {
	return setCookie.split(";")[0];
}

describe("dashboard session cookie", () => {
	it("round-trips: a freshly signed cookie verifies to { login, exp }", async () => {
		const setCookie = await createSessionCookie("dannbleeker", SECRET, NOW);
		const session = await verifySessionCookie(asCookieHeader(setCookie), SECRET, NOW);
		expect(session).not.toBeNull();
		expect(session!.login).toBe("dannbleeker");
		expect(session!.exp).toBe(Math.floor(NOW / 1000) + SESSION_TTL_SECONDS);
	});

	it("sets the attributes the __Host- prefix requires (Secure, Path=/, no Domain) + HttpOnly, SameSite=Lax", async () => {
		const setCookie = await createSessionCookie("dannbleeker", SECRET, NOW);
		expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
		expect(setCookie).not.toContain("Domain=");
	});

	it("rejects a tampered payload (login swapped, signature kept)", async () => {
		const setCookie = await createSessionCookie("dannbleeker", SECRET, NOW);
		const value = asCookieHeader(setCookie).substring(SESSION_COOKIE.length + 1);
		const [signature, payload] = value.split(".");
		const forgedPayload = btoa(atob(payload).replace("dannbleeker", "mallory-user"));
		const forged = `${SESSION_COOKIE}=${signature}.${forgedPayload}`;
		expect(await verifySessionCookie(forged, SECRET, NOW)).toBeNull();
	});

	it("rejects a tampered signature", async () => {
		const setCookie = await createSessionCookie("dannbleeker", SECRET, NOW);
		const value = asCookieHeader(setCookie).substring(SESSION_COOKIE.length + 1);
		const [signature, payload] = value.split(".");
		const flipped = (signature[0] === "a" ? "b" : "a") + signature.slice(1);
		const forged = `${SESSION_COOKIE}=${flipped}.${payload}`;
		expect(await verifySessionCookie(forged, SECRET, NOW)).toBeNull();
	});

	it("rejects a cookie signed with a different secret", async () => {
		const setCookie = await createSessionCookie("dannbleeker", "some-other-secret", NOW);
		expect(await verifySessionCookie(asCookieHeader(setCookie), SECRET, NOW)).toBeNull();
	});

	it("rejects an expired session", async () => {
		const setCookie = await createSessionCookie("dannbleeker", SECRET, NOW);
		const afterExpiry = NOW + (SESSION_TTL_SECONDS + 1) * 1000;
		expect(await verifySessionCookie(asCookieHeader(setCookie), SECRET, afterExpiry)).toBeNull();
	});

	it("returns null for absent, malformed, or non-base64 cookies", async () => {
		expect(await verifySessionCookie(undefined, SECRET, NOW)).toBeNull();
		expect(await verifySessionCookie("", SECRET, NOW)).toBeNull();
		expect(await verifySessionCookie(`${SESSION_COOKIE}=not-a-signed-value`, SECRET, NOW)).toBeNull();
		expect(await verifySessionCookie(`${SESSION_COOKIE}=abc.%%%not-base64%%%`, SECRET, NOW)).toBeNull();
	});

	it("finds its cookie among several in the header", async () => {
		const setCookie = await createSessionCookie("dannbleeker", SECRET, NOW);
		const header = `other=1; ${asCookieHeader(setCookie)}; another=2`;
		const session = await verifySessionCookie(header, SECRET, NOW);
		expect(session?.login).toBe("dannbleeker");
	});

	it("clearSessionCookie / clearStateCookie expire immediately", () => {
		expect(clearSessionCookie()).toContain("Max-Age=0");
		expect(clearSessionCookie().startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
		expect(clearStateCookie()).toContain("Max-Age=0");
	});

	it("state cookie carries the state value and is short-lived", () => {
		const setCookie = createStateCookie("some-uuid-state");
		expect(setCookie.startsWith(`${STATE_COOKIE}=some-uuid-state;`)).toBe(true);
		expect(setCookie).toContain("Max-Age=600");
		expect(getCookieValue(setCookie.split(";")[0], STATE_COOKIE)).toBe("some-uuid-state");
	});
});
