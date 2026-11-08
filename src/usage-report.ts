/**
 * File: src/usage-report.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-11-08
 * Version: 1.0.0
 * Description: usage_report — the D1 usage mirror (src/usage.ts) as an MCP
 *              tool, so a review in Claude can read which tools are used,
 *              which fail, and which have never been called, without opening
 *              the dashboard or holding a Cloudflare token.
 *
 *              "Never called" is computed against the tools actually
 *              registered on this connector (collected by makeGuarded at
 *              registration), not a hand-kept list — so it cannot drift.
 *
 *              Same cost rules as /api/usage: every query is bounded by `ts`
 *              (the index covers it), because D1 bills rows scanned and its
 *              daily read cap halts writes too.
 *
 * Change log:
 *   1.0.0 (2026-11-08) — Initial (v1.26.0).
 */

export interface ToolUsageRow {
	name: string;
	calls: number;
	ok: number;
	guard: number;
	trello: number;
	internal: number;
	/** Non-ok share, 0–1, two decimals. */
	errorRate: number;
	avgMs: number | null;
	lastUsed: string | null;
}

export interface UsageReport {
	enabled: boolean;
	days: number;
	surface: string;
	totals: { toolCalls: number; distinctTools: number; registered: number; neverCalled: number };
	tools: ToolUsageRow[];
	/** Registered tools with no call in the window. The pruning candidates. */
	neverCalled: string[];
	/** ≥3 calls and ≥20% non-ok: usually a tool-description problem. */
	failing: ToolUsageRow[];
	/** Busiest Trello endpoints and how often they needed a retry. */
	endpoints: { name: string; calls: number; retried: number }[];
	note?: string;
}

interface RawToolRow {
	name: string;
	outcome: string;
	n: number;
	avgMs: number | null;
	lastTs: number | null;
}

/** Pure: fold per-(name, outcome) rows into per-tool rows. Exported for tests. */
export function foldToolRows(rows: RawToolRow[]): ToolUsageRow[] {
	const by = new Map<string, ToolUsageRow & { msSum: number; msN: number; last: number }>();
	for (const r of rows) {
		const row =
			by.get(r.name) ??
			{ avgMs: null, calls: 0, errorRate: 0, guard: 0, internal: 0, last: 0, lastUsed: null, msN: 0, msSum: 0, name: r.name, ok: 0, trello: 0 };
		row.calls += r.n;
		if (r.outcome === "ok" || r.outcome === "guard" || r.outcome === "trello" || r.outcome === "internal") {
			row[r.outcome] += r.n;
		}
		if (r.avgMs !== null) {
			row.msSum += r.avgMs * r.n;
			row.msN += r.n;
		}
		if (r.lastTs !== null && r.lastTs > row.last) row.last = r.lastTs;
		by.set(r.name, row);
	}
	return [...by.values()]
		.map(({ msSum, msN, last, ...row }) => ({
			...row,
			avgMs: msN ? Math.round(msSum / msN) : null,
			errorRate: row.calls ? Math.round(((row.calls - row.ok) / row.calls) * 100) / 100 : 0,
			lastUsed: last ? new Date(last).toISOString() : null,
		}))
		.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export async function usage_report(
	db: D1Database | undefined,
	registered: readonly string[],
	input: { days?: number; surface?: "mcp" | "dashboard" | "cron" | "all" },
	nowMs = Date.now(),
): Promise<UsageReport> {
	const days = Math.min(Math.max(Math.trunc(input.days ?? 30), 1), 365);
	const surface = input.surface ?? "mcp";
	const names = [...new Set(registered)].sort();
	const empty: UsageReport = {
		days,
		enabled: false,
		endpoints: [],
		failing: [],
		neverCalled: [],
		surface,
		tools: [],
		totals: { distinctTools: 0, neverCalled: 0, registered: names.length, toolCalls: 0 },
	};
	if (!db) return { ...empty, note: "USAGE_DB is not bound on this deployment, so there is no usage data to read." };

	const since = nowMs - days * 86_400_000;
	const surfaceClause = surface === "all" ? "" : " AND surface = ?2";
	const bindTool = surface === "all" ? [since] : [since, surface];

	try {
		const [toolRes, httpRes] = await Promise.all([
			db
				.prepare(
					`SELECT name, outcome, COUNT(*) AS n, CAST(AVG(duration_ms) AS INTEGER) AS avgMs, MAX(ts) AS lastTs
					 FROM usage_events
					 WHERE kind = 'tool' AND ts >= ?1${surfaceClause}
					 GROUP BY name, outcome`,
				)
				.bind(...bindTool)
				.all<RawToolRow>(),
			db
				.prepare(
					`SELECT name, COUNT(*) AS calls, SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried
					 FROM usage_events
					 WHERE kind = 'http' AND ts >= ?1${surfaceClause}
					 GROUP BY name ORDER BY calls DESC LIMIT 15`,
				)
				.bind(...bindTool)
				.all<{ name: string; calls: number; retried: number }>(),
		]);
		const tools = foldToolRows(toolRes.results ?? []);
		const called = new Set(tools.map((t) => t.name));
		const neverCalled = names.filter((n) => !called.has(n));
		return {
			days,
			enabled: true,
			endpoints: (httpRes.results ?? []).map((r) => ({ calls: r.calls, name: r.name, retried: r.retried ?? 0 })),
			failing: tools.filter((t) => t.calls >= 3 && t.errorRate >= 0.2).sort((a, b) => b.errorRate - a.errorRate),
			neverCalled,
			surface,
			tools,
			totals: {
				distinctTools: tools.length,
				neverCalled: neverCalled.length,
				registered: names.length,
				toolCalls: tools.reduce((s, t) => s + t.calls, 0),
			},
		};
	} catch (e) {
		console.error("usage_report failed:", e);
		return { ...empty, note: "Usage data is unavailable (is the usage_events table created?)." };
	}
}
