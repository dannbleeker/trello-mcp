/**
 * File: src/digest/scheduler.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: The daily digest send path. Cloudflare cron runs in UTC only,
 *              so wrangler.jsonc fires this at 02:00, 03:00 and 04:00 UTC and
 *              the guard here turns that into "send once, at or after 04:00
 *              Europe/Copenhagen, DST-proof":
 *
 *                summer (CEST, UTC+2): 04:00 / 05:00 / 06:00 local
 *                winter (CET,  UTC+1): 03:00 / 04:00 / 05:00 local
 *
 *              Rule: send if the local hour is within [4, 6] AND today's
 *              KV sent-flag is absent. The first eligible firing sends and
 *              sets the flag; the later firings are free retry slots when the
 *              first attempt failed (Trello or Resend down). The flag is only
 *              written on SUCCESS, keyed by local date, TTL 2 days. EU DST
 *              transitions happen at 01:00 UTC — before the first firing —
 *              so transition days behave like any other day.
 *
 * Change log:
 *   1.1.0 (2026-08-04) — Usage tracking. sendDigestEmail takes an optional
 *                        recorder rather than creating one — it has three
 *                        callers on three surfaces (this cron, the send_digest
 *                        MCP tool, the dashboard button), so the digest's
 *                        Trello calls are attributed to whichever actually
 *                        triggered the send. runScheduledDigest owns the `cron`
 *                        recorder and flushes in a finally: a digest that died
 *                        mid-run is exactly when you want to see which Trello
 *                        call it died on.
 *   1.0.0 (2026-07-10) — Initial (v1.14.0 digest release).
 */

import { TrelloClient } from "../trello/client";
import type { TrelloCustomField } from "../trello/client";
import { type HttpUsageSink, UsageRecorder } from "../usage";
import { BOARD_ALIASES, DEFAULT_BOARD, DEFAULT_TIMEZONE } from "../trello/constants";
import { list_snoozed_cards } from "../trello/tools";
import { renderDigest } from "./render";

/** Bindings needed to render + send one digest. RESEND_API_KEY may be unset until Dann creates it. */
export interface DigestSendEnv {
	TRELLO_KEY: string;
	TRELLO_TOKEN: string;
	RESEND_API_KEY?: string;
	DIGEST_FROM?: string;
	DIGEST_TO?: string;
	// Usage tracking (v1.21.0). Optional — absent in unit tests and before the
	// bindings are deployed; the recorder no-ops in both cases.
	USAGE?: AnalyticsEngineDataset;
	USAGE_DB?: D1Database;
}

/** The cron path additionally needs KV for the once-per-day sent flag. */
export interface DigestEnv extends DigestSendEnv {
	OAUTH_KV: KVNamespace;
	/**
	 * Optional healthchecks.io-style ping URL, hit after every successful cron
	 * send. The monitoring service alerts when the daily ping goes missing —
	 * turning a silent digest failure into a notification. v1.16.0.
	 */
	HEARTBEAT_URL?: string;
}

const DEFAULT_FROM = "Todays Actions <todo@bleeker-pedersen.dk>";
const DEFAULT_TO = "dann@bleeker-pedersen.dk";

/** Local send window: first eligible hour sends, later hours only retry. */
const WINDOW_START_HOUR = 4;
const WINDOW_END_HOUR = 6;

/** KV flag TTL — long enough to cover the whole window, short enough to self-clean. */
const SENT_FLAG_TTL_SECONDS = 2 * 24 * 3600;

export type DigestRunResult =
	| "sent"
	| "skipped-already-sent"
	| "skipped-outside-window"
	| "failed";

/** Hour-of-day (0-23) in the given IANA timezone. */
export function hourInTz(nowMs: number, tz: string = DEFAULT_TIMEZONE): number {
	const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
		new Date(nowMs),
	);
	return Number(h) % 24; // Intl "24" ↔ "00" quirk
}

/** Local calendar date as YYYY-MM-DD in the given IANA timezone. */
export function localDateInTz(nowMs: number, tz: string = DEFAULT_TIMEZONE): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(nowMs));
}

/**
 * Fetch the board and render the digest. The ONE place the email is built, so
 * the 04:00 send and the /digest/preview route cannot diverge — the preview
 * used to do its own fetch without customFieldItems and without the field
 * definitions, so it rendered every card with no custom-field badge and showed
 * a layout the real email never had. A preview whose whole job is "check the
 * email before it goes out" has to build the same email. v1.22.0.
 *
 * Both extra reads stay best-effort for the reason they always were: the
 * morning email must never die because a Power-Up read failed.
 */
export async function buildDigest(
	client: TrelloClient,
	nowMs: number,
): Promise<{ html: string; subject: string }> {
	const boardId = BOARD_ALIASES[DEFAULT_BOARD];
	const cards = await client.listCardsOnBoard(boardId, { customFieldItems: true });
	let customFields: TrelloCustomField[] = [];
	try {
		customFields = await client.listCustomFields(boardId);
	} catch (e) {
		console.error("digest custom-fields fetch failed (badges omitted):", e instanceof Error ? e.message : e);
	}
	let snoozed: Awaited<ReturnType<typeof list_snoozed_cards>>["snoozed"] = [];
	try {
		snoozed = (await list_snoozed_cards(client, {}, nowMs)).snoozed;
	} catch (e) {
		console.error("digest snoozed-cards fetch failed (section omitted):", e instanceof Error ? e.message : e);
	}
	return renderDigest(cards, nowMs, DEFAULT_TIMEZONE, snoozed, customFields);
}

/**
 * Fetch the board, render, and send via Resend. Throws on any failure so the
 * caller can leave the sent-flag unset and let the next cron slot retry.
 */
export async function sendDigestEmail(
	env: DigestSendEnv,
	nowMs: number,
	usage?: HttpUsageSink,
): Promise<void> {
	if (!env.RESEND_API_KEY) {
		throw new Error("RESEND_API_KEY is not configured — set it with `wrangler secret put RESEND_API_KEY`.");
	}

	// `usage` is passed in rather than created here because this function has
	// three callers on three surfaces — the cron, the send_digest MCP tool and
	// the dashboard button. Each owns its own recorder, so the digest's Trello
	// calls are attributed to whichever surface actually triggered the send.
	const client = new TrelloClient(env.TRELLO_KEY, env.TRELLO_TOKEN, usage);
	const { html, subject } = await buildDigest(client, nowMs);

	const resp = await fetch("https://api.resend.com/emails", {
		body: JSON.stringify({
			from: env.DIGEST_FROM || DEFAULT_FROM,
			html,
			subject,
			to: [env.DIGEST_TO || DEFAULT_TO],
		}),
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	});
	if (!resp.ok) {
		// Never log the response body wholesale — keep failures opaque like the
		// dashboard API does with Trello. Status is enough to diagnose.
		throw new Error(`Resend rejected the send (HTTP ${resp.status}).`);
	}
}

/**
 * Cron entry point. Idempotent per local day; safe to call from any of the
 * three UTC firings (and from a manual test route).
 */
export async function runScheduledDigest(env: DigestEnv, nowMs: number): Promise<DigestRunResult> {
	const hour = hourInTz(nowMs);
	if (hour < WINDOW_START_HOUR || hour > WINDOW_END_HOUR) {
		return "skipped-outside-window";
	}

	const flagKey = sentFlagKey(nowMs);
	if (await env.OAUTH_KV.get(flagKey)) {
		return "skipped-already-sent";
	}

	const usage = new UsageRecorder(env, "cron");
	try {
		await sendDigestEmail(env, nowMs, usage);
	} catch (e) {
		// Leave the flag unset — the next cron slot in the window retries.
		console.error("digest send failed:", e instanceof Error ? e.message : e);
		return "failed";
	} finally {
		// Flushed on the failure path too: a digest that died mid-run is exactly
		// when you want to see which Trello call it died on.
		await usage.flush();
	}

	await markSent(env, nowMs);

	// Success heartbeat — fail-soft: monitoring must never fail the send.
	if (env.HEARTBEAT_URL) {
		try {
			await fetch(env.HEARTBEAT_URL);
		} catch (e) {
			console.error("digest heartbeat ping failed:", e instanceof Error ? e.message : e);
		}
	}
	return "sent";
}

/** KV key for the once-per-local-day sent flag. */
function sentFlagKey(nowMs: number): string {
	return `digest:sent:${localDateInTz(nowMs)}`;
}

/**
 * Record a successful send. A KV write failure must NOT fail the run — the
 * email already went out, and throwing here would surface the cron invocation
 * as an error while ALSO leaving the flag unset (guaranteeing a duplicate
 * from the next slot). Worst case after swallowing: the flag is missing and
 * the next slot may duplicate once — strictly better than always duplicating.
 * v1.14.1 fix.
 */
async function markSent(env: DigestEnv, nowMs: number): Promise<void> {
	try {
		await env.OAUTH_KV.put(sentFlagKey(nowMs), new Date(nowMs).toISOString(), {
			expirationTtl: SENT_FLAG_TTL_SECONDS,
		});
	} catch (e) {
		console.error("digest sent-flag write failed:", e instanceof Error ? e.message : e);
	}
}

/**
 * After a MANUAL test send (POST /api/digest/send): if we're inside the cron
 * window, set the sent flag so a remaining cron slot doesn't email a
 * near-identical digest minutes later. Outside the window this is a no-op —
 * a daytime test send must never suppress tomorrow's 04:00 digest.
 * v1.14.1 fix.
 */
export async function noteManualSend(env: DigestEnv, nowMs: number): Promise<void> {
	const hour = hourInTz(nowMs);
	if (hour < WINDOW_START_HOUR || hour > WINDOW_END_HOUR) return;
	await markSent(env, nowMs);
}
