/**
 * File: src/usage.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-08-04
 * Last Updated: 2026-08-04
 * Version: 1.0.0
 * Description: Per-tool and per-endpoint usage tracking. Two questions this
 *              answers that the Cloudflare request count cannot: which of the
 *              102 MCP tools Claude actually reaches for, and where the Trello
 *              API budget goes. They are not 1:1 — weekly_review_pack is one
 *              tool call and a dozen Trello requests.
 *
 *              Three sinks, all optional, all fail-soft:
 *                • Analytics Engine (env.USAGE)     — 3-month retention, the
 *                  real instrument. Non-blocking: writeDataPoint() returns
 *                  void and the runtime writes in the background.
 *                • D1 (env.USAGE_DB)                — unlimited retention, and
 *                  what the dashboard panel reads. Buffered and flushed once
 *                  per unit of work, so a 12-request tool costs one INSERT.
 *                • console.log                      — structured JSON, picked
 *                  up by Workers Logs (observability is already on). Free,
 *                  3-day retention on the Free plan.
 *
 *              Nothing here records ARGUMENT VALUES. Card titles, comment
 *              bodies and search queries are personal data and must never
 *              reach a log store. Only names, outcomes and timings.
 *
 * Change log:
 *   1.0.0 (2026-08-04) — Initial.
 */

/** Which surface produced the event. The Trello client is shared by all three. */
export type UsageSurface = "mcp" | "dashboard" | "cron";

/** `tool` = one MCP tool call. `http` = one request to the Trello REST API. */
export type UsageKind = "tool" | "http";

/**
 * How the unit of work ended. The four failure modes are kept apart on purpose:
 * a tool that routinely returns `guard` is usually a description problem (Claude
 * calling it wrongly), which is far cheaper to fix than anything else.
 */
export type UsageOutcome = "ok" | "guard" | "trello" | "internal" | "denied";

export interface UsageEvent {
	kind: UsageKind;
	name: string;
	outcome: UsageOutcome;
	durationMs: number;
	/** HTTP status — `http` events only. */
	status?: number;
	/** Attempts including the first — `http` events only. >1 means a retry happened. */
	attempts?: number;
}

/**
 * The bindings the recorder writes to. Both optional so the Worker deploys and
 * runs unchanged before either exists — same pattern as RESEND_API_KEY.
 */
export interface UsageEnv {
	USAGE?: AnalyticsEngineDataset;
	USAGE_DB?: D1Database;
}

/** A 24-char hex Trello object ID — cards, boards, lists, actions, everything. */
const TRELLO_ID = /^[0-9a-f]{24}$/i;

/**
 * Path segments whose FOLLOWING segment is an identifier. This is what collapses
 * the values a bare ID regex misses: board short-links (`/boards/xKeUkW8V`) and
 * workspace short-names (`/organizations/dannbleeker`). Without it those leak
 * into the endpoint name and the cardinality of `name` is unbounded.
 */
const COLLECTIONS = new Set([
	"actions",
	"attachments",
	"boards",
	"cards",
	"checkItems",
	"checklists",
	"customFields",
	"emoji",
	"labels",
	"lists",
	"members",
	"memberships",
	"notifications",
	"organizations",
	"plugins",
	"reactions",
]);

/**
 * Segments that sit in an identifier position but are literals in Trello's API,
 * so collapsing them would merge genuinely different endpoints. Derived from the
 * paths this client actually builds:
 *   /boards/{id}/cards/closed      — the archived-cards read, NOT a card ID
 *   /cards/{id}/actions/comments   — the comment thread, NOT an action ID
 *   /members/me/...                — the authenticated user
 * open / all / visible are Trello's other card filters, included as insurance
 * against the next endpoint that uses one.
 */
const KEYWORDS = new Set(["all", "closed", "comments", "me", "open", "visible"]);

/**
 * Collapse a concrete Trello path into a low-cardinality template:
 *   /cards/68f1a2c3d4e5f60718293a4b/actions → /cards/{id}/actions
 *   /organizations/dannbleeker/boards       → /organizations/{id}/boards
 *   /members/me/cards                       → /members/me/cards
 *
 * Exported for tests — getting this wrong is how an analytics table turns into
 * a list of one-row groups.
 */
export function normalizeTrelloPath(path: string): string {
	const [bare] = path.split("?");
	return bare
		.split("/")
		.map((seg, i, all) => {
			if (!seg) return seg;
			if (TRELLO_ID.test(seg)) return "{id}";
			const prev = i > 0 ? all[i - 1] : "";
			if (COLLECTIONS.has(prev) && !KEYWORDS.has(seg)) return "{id}";
			return seg;
		})
		.join("/");
}

/** The `name` of an `http` event: method + templated path, e.g. `GET /cards/{id}`. */
export function endpointName(method: string, path: string): string {
	return `${method.toUpperCase()} ${normalizeTrelloPath(path)}`;
}

/**
 * Classify a thrown value into a UsageOutcome without importing the error
 * classes (src/trello/client.ts already imports this module's siblings; keeping
 * usage.ts dependency-free avoids a cycle). Matches on constructor name, which
 * is stable for both GuardError and TrelloError.
 */
export function classifyError(e: unknown): UsageOutcome {
	const name = e instanceof Error ? e.constructor.name : "";
	if (name === "GuardError") return "guard";
	if (name === "TrelloError") return "trello";
	return "internal";
}

/**
 * Analytics Engine hard limits, enforced here rather than discovered in
 * production. Local dev cannot catch a violation: miniflare's writeDataPoint is
 * an empty function, and the real runtime silently DROPS a malformed data point
 * ("If you attempt to provide multiple indexes, your data point will not be
 * recorded"). So a schema mistake is invisible on both sides unless we clamp.
 */
const AE_MAX_BLOBS = 20;
const AE_MAX_DOUBLES = 20;
const AE_MAX_INDEX_BYTES = 96;

/** Truncate a string to at most `bytes` UTF-8 bytes. */
export function clampIndex(value: string, bytes: number = AE_MAX_INDEX_BYTES): string {
	const encoder = new TextEncoder();
	if (encoder.encode(value).length <= bytes) return value;
	let out = value;
	while (out.length > 0 && encoder.encode(out).length > bytes) {
		out = out.slice(0, -1);
	}
	return out;
}

/**
 * Records usage events. One per unit of work (an MCP tool call, a dashboard
 * request, a cron run) so that D1 writes batch into a single statement.
 *
 * Every method is fail-soft by construction: a broken recorder must never turn
 * a working tool call into an error. Analytics is not worth an outage.
 */
export class UsageRecorder {
	private readonly env: UsageEnv;
	private readonly surface: UsageSurface;
	private readonly login: string;
	private readonly buffer: (UsageEvent & { ts: number })[] = [];

	constructor(env: UsageEnv, surface: UsageSurface, login: string = "") {
		this.env = env;
		this.surface = surface;
		this.login = login;
	}

	/**
	 * Record one event. Writes to Analytics Engine immediately (non-blocking,
	 * no await) and buffers the D1 row for flush().
	 */
	record(event: UsageEvent): void {
		try {
			const ts = Date.now();
			this.buffer.push({ ...event, ts });

			// One index only — the runtime drops the whole data point if given
			// more. Indexing by `name` keeps per-tool counts exact under
			// sampling, which is the entire point of this table.
			this.env.USAGE?.writeDataPoint({
				indexes: [clampIndex(event.name)],
				blobs: [event.kind, this.surface, event.name, event.outcome, this.login].slice(0, AE_MAX_BLOBS),
				doubles: [event.durationMs, event.status ?? 0, event.attempts ?? 0].slice(0, AE_MAX_DOUBLES),
			});

			// Structured, not interpolated: Workers Logs indexes JSON fields, so
			// `evt=usage AND kind=tool` is a query rather than a text match.
			console.log(
				JSON.stringify({
					evt: "usage",
					kind: event.kind,
					surface: this.surface,
					name: event.name,
					outcome: event.outcome,
					ms: event.durationMs,
					...(event.status !== undefined ? { status: event.status } : {}),
					...(event.attempts !== undefined && event.attempts > 1 ? { attempts: event.attempts } : {}),
				}),
			);
		} catch {
			// Never let instrumentation break the request it is instrumenting.
		}
	}

	/** Buffered rows not yet written to D1. Exported behaviour for tests. */
	get pending(): number {
		return this.buffer.length;
	}

	/**
	 * Write the buffered rows to D1 as one batched statement and clear the
	 * buffer. Safe to call with nothing buffered, and safe to call when the
	 * binding is absent. Never rejects.
	 */
	async flush(): Promise<void> {
		const rows = this.buffer.splice(0, this.buffer.length);
		const db = this.env.USAGE_DB;
		if (!db || rows.length === 0) return;
		try {
			const stmt = db.prepare(
				"INSERT INTO usage_events (ts, kind, surface, name, outcome, status, attempts, duration_ms, login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			await db.batch(
				rows.map((r) =>
					stmt.bind(
						r.ts,
						r.kind,
						this.surface,
						r.name,
						r.outcome,
						r.status ?? null,
						r.attempts ?? null,
						r.durationMs,
						this.login || null,
					),
				),
			);
		} catch {
			// A failed analytics write is not a failed request. Rows are already
			// spliced out, so a persistent D1 problem cannot grow the buffer.
		}
	}
}

/**
 * The recorder seen by TrelloClient. Narrower than UsageRecorder on purpose:
 * the client records HTTP calls and nothing else, and should not be able to
 * flush (its owner decides when the unit of work ends).
 */
export interface HttpUsageSink {
	record(event: UsageEvent): void;
}
