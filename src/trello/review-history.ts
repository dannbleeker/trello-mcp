/**
 * File: src/trello/review-history.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-11-08
 * Version: 1.0.0
 * Description: Week-over-week memory for weekly_review_pack. Each MCP call of
 *              the pack stores its headline figures in KV under
 *              `review:snapshot:<local date>`; the next review reads the most
 *              recent snapshot at least five days old and reports the change,
 *              plus up to four weekly points for a trend.
 *
 *              The pack itself is a point-in-time read. Without this, a list
 *              creeping from 18 to 23 over three reviews only shows up if
 *              someone remembers last week's number and writes it in a note,
 *              which is exactly how "@computer creep" was found.
 *
 *              Fail-soft throughout, like the digest snapshot: a KV fault must
 *              never fail the review. Every function returns null / [] or does
 *              nothing on error.
 *
 * Change log:
 *   1.0.0 (2026-11-08) — Initial (v1.26.0).
 */

import { DEFAULT_TIMEZONE } from "./constants";

/** The figures a review is compared on. Counts only; no card names leave the board read. */
export interface ReviewSnapshot {
	/** Local date (YYYY-MM-DD, Europe/Copenhagen) the snapshot was taken. */
	date: string;
	inbox: number;
	contexts: Record<string, number>;
	waiting: number;
	could_do: Record<string, number>;
	big_rocks: number;
	/** Power-Up snoozed cards (not dueReminder). */
	snoozed: number;
}

/** Change since the previous snapshot. Positive = grew. */
export interface ReviewDelta {
	since: string;
	daysAgo: number;
	inbox: number;
	contexts: Record<string, number>;
	waiting: number;
	could_do: Record<string, number>;
	big_rocks: number;
	snoozed: number;
}

export interface ReviewTrend {
	/** The snapshot the delta is measured against, or null on a first review. */
	previous: ReviewSnapshot | null;
	delta: ReviewDelta | null;
	/** Up to four weekly points before today, oldest first, plus today last. */
	history: ReviewSnapshot[];
}

export const REVIEW_SNAPSHOT_PREFIX = "review:snapshot:";
/** 20 weeks: long enough for a quarter's trend, short enough to self-clean. */
const REVIEW_SNAPSHOT_TTL_SECONDS = 140 * 24 * 3600;
/** The previous REVIEW, not yesterday's peek: at least this many days back. */
const MIN_GAP_DAYS = 5;
const MAX_HISTORY_POINTS = 4;

/** YYYY-MM-DD for `nowMs` in `tz`. en-CA formats dates ISO-style. */
export function localDate(nowMs: number, tz: string = DEFAULT_TIMEZONE): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(nowMs),
	);
}

/** Whole days from date a to date b (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function diffRecord(now: Record<string, number>, prev: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of new Set([...Object.keys(now), ...Object.keys(prev)])) {
		out[key] = (now[key] ?? 0) - (prev[key] ?? 0);
	}
	return out;
}

/** Pure: the change from `prev` to `now`. */
export function reviewDelta(now: ReviewSnapshot, prev: ReviewSnapshot): ReviewDelta {
	return {
		since: prev.date,
		daysAgo: daysBetween(prev.date, now.date),
		inbox: now.inbox - prev.inbox,
		contexts: diffRecord(now.contexts, prev.contexts),
		waiting: now.waiting - prev.waiting,
		could_do: diffRecord(now.could_do, prev.could_do),
		big_rocks: now.big_rocks - prev.big_rocks,
		snoozed: now.snoozed - prev.snoozed,
	};
}

/**
 * Pure: from the stored snapshot dates (any order), pick the weekly points to
 * read — newest first, the first at least MIN_GAP_DAYS before `today`, each
 * next one at least MIN_GAP_DAYS before the last picked. Returns at most
 * MAX_HISTORY_POINTS dates.
 */
export function pickHistoryDates(dates: string[], today: string): string[] {
	const sorted = [...new Set(dates)].filter((d) => d < today).sort().reverse();
	const picked: string[] = [];
	let anchor = today;
	for (const d of sorted) {
		if (daysBetween(d, anchor) < MIN_GAP_DAYS) continue;
		picked.push(d);
		anchor = d;
		if (picked.length >= MAX_HISTORY_POINTS) break;
	}
	return picked;
}

function isSnapshot(v: unknown): v is ReviewSnapshot {
	if (!v || typeof v !== "object") return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.date === "string" &&
		typeof s.inbox === "number" &&
		typeof s.waiting === "number" &&
		typeof s.contexts === "object" &&
		s.contexts !== null
	);
}

/**
 * Read the trend for `current`, then store `current` as today's snapshot. The
 * read happens first so today's own snapshot (from an earlier call the same
 * day) can never be "previous". Returns an empty trend on any KV fault.
 */
export async function recordAndCompare(kv: KVNamespace, current: ReviewSnapshot): Promise<ReviewTrend> {
	let history: ReviewSnapshot[] = [];
	try {
		const listed = await kv.list({ prefix: REVIEW_SNAPSHOT_PREFIX });
		const dates = listed.keys.map((k) => k.name.slice(REVIEW_SNAPSHOT_PREFIX.length));
		const wanted = pickHistoryDates(dates, current.date);
		const raws = await Promise.all(wanted.map((d) => kv.get(`${REVIEW_SNAPSHOT_PREFIX}${d}`)));
		history = raws
			.map((raw) => {
				try {
					const parsed: unknown = raw ? JSON.parse(raw) : null;
					return isSnapshot(parsed) ? parsed : null;
				} catch {
					return null;
				}
			})
			.filter((s): s is ReviewSnapshot => s !== null)
			.sort((a, b) => a.date.localeCompare(b.date));
	} catch (e) {
		console.error("review snapshot read failed (no trend shown):", e instanceof Error ? e.message : e);
		history = [];
	}
	try {
		await kv.put(`${REVIEW_SNAPSHOT_PREFIX}${current.date}`, JSON.stringify(current), {
			expirationTtl: REVIEW_SNAPSHOT_TTL_SECONDS,
		});
	} catch (e) {
		console.error("review snapshot write failed:", e instanceof Error ? e.message : e);
	}
	const previous = history.length ? history[history.length - 1] : null;
	return {
		previous,
		delta: previous ? reviewDelta(current, previous) : null,
		history: [...history, current],
	};
}
