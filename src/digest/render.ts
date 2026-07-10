/**
 * File: src/digest/render.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: Renders the daily "Todays Actions" email — a full, email-safe
 *              HTML replica of the web dashboard (src/dashboard/page.html)
 *              plus an "Overdue & due today" section the dashboard doesn't
 *              have. Pure function of (cards, nowMs): no fetching, no I/O —
 *              trivially unit-testable. Email clients run no JavaScript and
 *              ignore <style> blocks unevenly, so everything is inline-styled
 *              tables/divs, no scripts, no external assets.
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Initial (v1.14.0 digest release).
 */

import type { TrelloCard } from "../trello/client";
import { DEFAULT_TIMEZONE, LIST_ALIASES, ROLLING_BIG_ROCKS_ID } from "../trello/constants";
import { startOfDayMsInTz, type SnoozedCard } from "../trello/tools";

/** The dashboard's zone layout, mirrored (ids from constants, WIP from list names). */
const CONTEXTS = [
	{ id: LIST_ALIASES["@computer"], name: "@Computer", wip: 7 as number | null },
	{ id: LIST_ALIASES["@home"], name: "@Home", wip: 5 as number | null },
	{ id: LIST_ALIASES["@phone"], name: "@Phone", wip: 5 as number | null },
	{ id: LIST_ALIASES["@errands"], name: "@Errands", wip: null as number | null },
	{ id: LIST_ALIASES["@lene"], name: "@Lene", wip: null as number | null },
];
const WAITING_ID = LIST_ALIASES.waiting;
const INBOX_ID = LIST_ALIASES.inbox;

/** Lists whose cards count as "actionable" for the due-date section. */
const ACTIONABLE_LIST_IDS = new Set<string>([
	...CONTEXTS.map((c) => c.id),
	WAITING_ID,
	INBOX_ID,
]);

const DASHBOARD_URL = "https://todo.bleeker-pedersen.dk";

// ---- tiny helpers (mirror page.html semantics) ----

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function isDivider(c: TrelloCard): boolean {
	return /^-+$/.test((c.name || "").trim());
}

function hasLabel(c: TrelloCard, name: string): boolean {
	return (c.labels || []).some((l) => l.name === name);
}

/** Markdown-ish desc → one readable line, ≤90 chars (same rules as the dashboard). */
function descSnippet(desc: string): string {
	let d = (desc || "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>~]/g, "")
		.replace(/[​‌‍﻿]/g, "") // zero-width chars (same as the dashboard)
		.replace(/\s+/g, " ")
		.trim();
	if (!d) return "";
	if (d.length > 90) d = `${d.slice(0, 90)}…`;
	return d;
}

/**
 * Format an ISO due date as a short local (Copenhagen) stamp, e.g.
 * "10 Jul 14:00" — with the year appended ("15 Jul 2024 12:00") when it
 * differs from the current local year, so a long-overdue card can't
 * masquerade as this year's (v1.14.1 fix).
 */
function formatDue(iso: string, tz: string, nowMs: number): string {
	const yearIn = (ms: number) =>
		new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric" }).format(new Date(ms));
	const dueMs = Date.parse(iso);
	const sameYear = yearIn(dueMs) === yearIn(nowMs);
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		day: "numeric",
		month: "short",
		...(sameYear ? {} : { year: "numeric" }),
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(dueMs));
}

// ---- inline styles (email-safe: no classes, no <style>) ----

const S = {
	badge: "display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;font-weight:600;margin-right:4px;",
	body: "margin:0;padding:16px;background:#f6f7f9;color:#1c2024;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;",
	card: "border:1px solid #eceef1;border-radius:9px;padding:9px 10px;margin-bottom:8px;background:#fcfcfd;",
	col: "background:#ffffff;border:1px solid #e4e7eb;border-radius:12px;padding:12px;margin-bottom:14px;",
	count: "font-size:11px;color:#6b7280;background:#eef1f4;border-radius:999px;padding:2px 8px;",
	countOver: "font-size:11px;color:#a5281c;background:#fdecea;border-radius:999px;padding:2px 8px;",
	desc: "font-size:11.5px;color:#6b7280;margin-top:3px;",
	due: "font-size:11px;color:#a5281c;font-weight:600;margin-top:3px;",
	empty: "font-size:12px;color:#9aa3ad;font-style:italic;padding:4px 2px;",
	link: "color:#1c2024;text-decoration:none;",
	stat: "display:inline-block;margin-right:22px;vertical-align:top;",
	statLbl: "font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;",
	statNum: "font-size:26px;font-weight:700;line-height:1;",
	title: "font-size:13px;font-weight:500;",
	wip: "display:inline-block;font-size:12px;padding:5px 10px;border-radius:999px;background:#eef1f4;border:1px solid #e0e4e8;margin:0 6px 6px 0;",
	wipOver: "display:inline-block;font-size:12px;padding:5px 10px;border-radius:999px;background:#fdecea;border:1px solid #f5c6c0;color:#a5281c;margin:0 6px 6px 0;",
	zone: "font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#4b5563;margin:22px 0 10px;",
} as const;

function badgesHtml(c: TrelloCard): string {
	let h = "";
	if (hasLabel(c, "BESTSELLER")) h += `<span style="${S.badge}background:#1c2024;color:#ffffff;">BESTSELLER</span>`;
	if (hasLabel(c, "DBP Invest")) h += `<span style="${S.badge}background:#2563eb;color:#ffffff;">DBP Invest</span>`;
	if (hasLabel(c, "Please Clarify and Organize")) h += `<span style="${S.badge}background:#fdecea;color:#c0392b;border:1px solid #f5c6c0;">clarify</span>`;
	return h ? `<div style="margin-top:6px;">${h}</div>` : "";
}

function cardHtml(c: TrelloCard, tz: string, opts: { showDue?: boolean; nowMs?: number } = {}): string {
	const title =
		c.url && /^https?:\/\//i.test(c.url)
			? `<a href="${esc(c.url)}" style="${S.link}">${esc(c.name)}</a>`
			: esc(c.name);
	const snippet = descSnippet(c.desc);
	const due =
		opts.showDue && c.due && opts.nowMs !== undefined
			? `<div style="${S.due}">Due: ${esc(formatDue(c.due, tz, opts.nowMs))}</div>`
			: "";
	return `<div style="${S.card}"><div style="${S.title}">${title}</div>${due}${
		snippet ? `<div style="${S.desc}">${esc(snippet)}</div>` : ""
	}${badgesHtml(c)}</div>`;
}

function columnHtml(
	name: string,
	cards: TrelloCard[],
	tz: string,
	wip: number | null,
	emptyText: string,
	forceOver = false,
): string {
	// forceOver mirrors the dashboard's inbox rule: any card in the inbox is
	// "over" (red badge), WIP limit or not (v1.14.1 fix).
	const over = forceOver || (wip !== null && cards.length > wip);
	const count = `<span style="${over ? S.countOver : S.count}">${cards.length}${wip !== null ? `/${wip}` : ""}</span>`;
	const body = cards.length ? cards.map((c) => cardHtml(c, tz)).join("") : `<div style="${S.empty}">${esc(emptyText)}</div>`;
	return `<div style="${S.col}"><div style="margin-bottom:8px;"><span style="font-weight:600;font-size:13px;">${esc(name)}</span> ${count}</div>${body}</div>`;
}

export interface Digest {
	subject: string;
	html: string;
}

/**
 * Render the full digest from a board snapshot. `nowMs` fixes the clock so
 * overdue/due-today bucketing (and tests) are deterministic; buckets use the
 * same DST-correct local-day boundary as list_cards_due.
 */
export function renderDigest(
	cards: TrelloCard[],
	nowMs: number,
	tz: string = DEFAULT_TIMEZONE,
	snoozed: SnoozedCard[] = [],
): Digest {
	const open = cards.filter((c) => !c.closed && !isDivider(c));
	const inList = (id: string) => open.filter((c) => c.idList === id);

	const inbox = inList(INBOX_ID);
	const waiting = inList(WAITING_ID);
	const rocks = inList(ROLLING_BIG_ROCKS_ID);
	const ctxCols = CONTEXTS.map((l) => ({ ...l, cards: inList(l.id) }));
	const totalNext = ctxCols.reduce((s, l) => s + l.cards.length, 0);

	// Due buckets: actionable lists only (Done/Butler/etc. never nag).
	const dayStart = startOfDayMsInTz(nowMs, tz);
	const dayEnd = dayStart + 24 * 3600 * 1000;
	const dueCards = open.filter(
		(c) => c.due !== null && !c.dueComplete && ACTIONABLE_LIST_IDS.has(c.idList),
	);
	const overdue = dueCards
		.filter((c) => Date.parse(c.due as string) < dayStart)
		.sort((a, b) => Date.parse(a.due as string) - Date.parse(b.due as string));
	const dueToday = dueCards
		.filter((c) => {
			const t = Date.parse(c.due as string);
			return t >= dayStart && t < dayEnd;
		})
		.sort((a, b) => Date.parse(a.due as string) - Date.parse(b.due as string));

	// ---- Health bar ----
	const wipHtml = ctxCols
		.map((l) => {
			if (l.wip === null) return `<span style="${S.wip}"><b>${esc(l.name)}</b> ${l.cards.length}</span>`;
			const over = l.cards.length > l.wip;
			return `<span style="${over ? S.wipOver : S.wip}"><b>${esc(l.name)}</b> ${l.cards.length}/${l.wip}${over ? " ⚠" : ""}</span>`;
		})
		.join("");
	const stat = (num: number, label: string, alert = false) =>
		`<span style="${S.stat}"><span style="${S.statNum}${alert ? "color:#c0392b;" : ""}">${num}</span><br><span style="${S.statLbl}">${esc(label)}</span></span>`;
	const health = `<div style="${S.col}">${stat(inbox.length, "Inbox to clarify", inbox.length > 0)}${stat(totalNext, "Next actions")}${stat(waiting.length, "Waiting for")}${stat(rocks.length, "Big rocks")}${stat(snoozed.length, "Snoozed")}<div style="margin-top:12px;">${wipHtml}</div></div>`;

	// ---- Waking today (Snooze Power-Up; email-only section, v1.15.0) ----
	// Cards whose wake time falls inside the local day, plus overdue wakes
	// (wake time passed but the Power-Up hasn't fired) — both reappear today.
	const wakingToday = snoozed
		.filter((s) => {
			const t = Date.parse(s.wakeUp);
			return s.overdueWake || (t >= dayStart && t < dayEnd);
		})
		.sort((a, b) => a.wakeUp.localeCompare(b.wakeUp));
	let wakeSection = "";
	if (wakingToday.length) {
		const rows = wakingToday
			.map((s) => {
				const title =
					s.url && /^https?:\/\//i.test(s.url)
						? `<a href="${esc(s.url)}" style="${S.link}">${esc(s.name)}</a>`
						: esc(s.name);
				const home = s.homeListAlias ?? s.homeListId;
				const when = s.overdueWake ? "any moment (overdue wake)" : formatDue(s.wakeUp, tz, nowMs);
				return `<div style="${S.card}"><div style="${S.title}">${title}</div><div style="${S.desc}">wakes ${esc(when)} · → ${esc(home)}</div></div>`;
			})
			.join("");
		wakeSection = `<div style="${S.zone}">Waking today <span style="font-weight:500;text-transform:none;letter-spacing:0;color:#9aa3ad;">snoozed cards returning to the board</span></div><div style="${S.col}">${rows}</div>`;
	}

	// ---- Overdue & due today (email-only section) ----
	let dueSection = "";
	if (overdue.length || dueToday.length) {
		const overdueHtml = overdue.length
			? `<div style="font-weight:600;font-size:13px;color:#a5281c;margin-bottom:8px;">Overdue (${overdue.length})</div>${overdue.map((c) => cardHtml(c, tz, { nowMs, showDue: true })).join("")}`
			: "";
		const todayHtml = dueToday.length
			? `<div style="font-weight:600;font-size:13px;margin:${overdue.length ? "12px" : "0"} 0 8px;">Due today (${dueToday.length})</div>${dueToday.map((c) => cardHtml(c, tz, { nowMs, showDue: true })).join("")}`
			: "";
		dueSection = `<div style="${S.zone}">Overdue &amp; due today</div><div style="${S.col}border:1px solid #f5c6c0;">${overdueHtml}${todayHtml}</div>`;
	}

	// ---- Cards per list overview (matches the dashboard's .ov-panel; v1.14.1) ----
	const overviewEntries = [
		...ctxCols.map((l) => ({ alert: l.wip !== null && l.cards.length > l.wip, count: l.cards.length, name: l.name })),
		{ alert: false, count: waiting.length, name: "Waiting for…" },
		{ alert: inbox.length > 0, count: inbox.length, name: "Inbox" },
	];
	const overviewHtml = `<div style="${S.col}"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:10px;">Cards per list</div>${overviewEntries
		.map(
			(e) =>
				`<span style="display:inline-block;text-align:center;border-radius:10px;padding:10px 14px;margin:0 8px 8px 0;${
					e.alert ? "background:#fdecea;border:1px solid #f5c6c0;" : "background:#f6f7f9;border:1px solid #eceef1;"
				}${e.count === 0 ? "opacity:.5;" : ""}"><span style="font-size:22px;font-weight:700;line-height:1;${e.alert ? "color:#c0392b;" : "color:#1c2024;"}">${e.count}</span><br><span style="font-size:10.5px;color:#6b7280;">${esc(e.name)}</span></span>`,
		)
		.join("")}</div>`;

	// ---- Zones (full replica) ----
	const ctxHtml = ctxCols
		.map((l) => columnHtml(l.name, l.cards, tz, l.wip, "clear"))
		.join("");
	const waitingHtml = columnHtml("Waiting for…", waiting, tz, null, "nothing pending on others");
	const inboxHtml = columnHtml("Inbox — clarify", inbox, tz, null, "inbox zero 🎉", inbox.length > 0);
	const rocksHtml = rocks.length
		? rocks.map((c) => cardHtml(c, tz)).join("")
		: `<div style="${S.empty}">no big rocks listed</div>`;

	const dateLine = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(new Date(nowMs));

	const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Todays Actions</title></head>
<body style="${S.body}">
<div style="max-width:680px;margin:0 auto;">
<div style="margin-bottom:12px;"><span style="font-size:18px;font-weight:700;">Todays Actions</span>
<span style="font-size:12px;color:#6b7280;"> — ${esc(dateLine)}</span><br>
<a href="${DASHBOARD_URL}" style="font-size:12px;color:#2563eb;">Open the live dashboard →</a></div>
${health}
${dueSection}
${wakeSection}
${overviewHtml}
<div style="${S.zone}">Next actions <span style="font-weight:500;text-transform:none;letter-spacing:0;color:#9aa3ad;">by context</span></div>
${ctxHtml}
<div style="${S.zone}">Needs attention</div>
${waitingHtml}
${inboxHtml}
<div style="${S.zone}">Rolling big rocks <span style="font-weight:500;text-transform:none;letter-spacing:0;color:#9aa3ad;">your active projects</span></div>
${rocksHtml}
<div style="margin-top:18px;font-size:11px;color:#9aa3ad;">Sent daily at 04:00 Copenhagen time by trello-mcp · <a href="${DASHBOARD_URL}" style="color:#9aa3ad;">${DASHBOARD_URL.replace("https://", "")}</a></div>
</div>
</body>
</html>`;

	return { html, subject: "Todays Actions" };
}
