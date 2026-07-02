import { describe, expect, it } from "vitest";
import { clampLimit, parseRetryAfterMs } from "../src/trello/client";

describe("clampLimit", () => {
	it("returns the value unchanged when in range", () => {
		expect(clampLimit(50)).toBe(50);
		expect(clampLimit(1000)).toBe(1000);
		expect(clampLimit(1)).toBe(1);
	});

	it("clamps to the max ceiling (default 1000)", () => {
		expect(clampLimit(9999)).toBe(1000);
	});

	it("clamps to a custom max", () => {
		expect(clampLimit(500, 100)).toBe(100);
		expect(clampLimit(50, 100)).toBe(50);
	});

	it("clamps below-1 values up to 1", () => {
		expect(clampLimit(0)).toBe(1);
		expect(clampLimit(-5)).toBe(1);
	});
});

describe("parseRetryAfterMs", () => {
	const RETRY_MAX_DELAY_MS = 5000;

	it("returns exponential-backoff fallback when header is null", () => {
		// attempt=1 → 500ms base
		expect(parseRetryAfterMs(null, 1)).toBe(500);
		// attempt=2 → 500 * 2 = 1000
		expect(parseRetryAfterMs(null, 2)).toBe(1000);
		// attempt=3 → 500 * 4 = 2000
		expect(parseRetryAfterMs(null, 3)).toBe(2000);
	});

	it("parses integer seconds", () => {
		expect(parseRetryAfterMs("3", 1)).toBe(3000);
		expect(parseRetryAfterMs("  4  ", 1)).toBe(4000); // trim
	});

	it("caps integer seconds at RETRY_MAX_DELAY_MS", () => {
		expect(parseRetryAfterMs("999", 1)).toBe(RETRY_MAX_DELAY_MS);
	});

	it("parses HTTP-date format and returns ms-until-that-date", () => {
		const future = new Date(Date.now() + 3000).toUTCString();
		const ms = parseRetryAfterMs(future, 1);
		// Should be roughly 3000ms, within a generous ±1000ms window.
		expect(ms).toBeGreaterThan(1000);
		expect(ms).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
	});

	it("clamps HTTP-date results to a floor of 0 (past dates)", () => {
		const past = new Date(Date.now() - 60_000).toUTCString();
		expect(parseRetryAfterMs(past, 1)).toBe(0);
	});

	it("falls back to exponential backoff on unparseable input", () => {
		expect(parseRetryAfterMs("blorp", 1)).toBe(500);
		expect(parseRetryAfterMs("blorp", 2)).toBe(1000);
	});
});
