/**
 * File: src/digest/render.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-11-06
 * Version: 1.1.0
 * Description: Renders the daily "Todays Actions" email — a full, email-safe
 *              HTML replica of the web dashboard (src/dashboard/page.html)
 *              plus an "Overdue & due today" section the dashboard doesn't
 *              have. Pure function of (cards, nowMs): no fetching, no I/O —
 *              trivially unit-testable. Email clients run no JavaScript and
 *              ignore <style> blocks unevenly, so everything is inline-styled
 *              tables/divs, no scripts, no external assets.
 *
 * Change log:
 *   1.1.0 (2026-11-06) — SSF (StruktureretSundFornuft) restyle: blue header and
 *                         footer, navy figures, square cards, pill chips, orange
 *                         only for alerts. New: how far a context is over its WIP
 *                         limit, snoozed Waiting-for items, a "Waking this week"
 *                         strip, a "wake did not fire" warning, change-since-
 *                         yesterday under each figure, no empty lists, and list
 *                         tiles that link to the list on the dashboard.
 *   1.19.3 (2026-07-30) — Every label on a card renders, coloured from Trello's
 *                         palette. badgesHtml() used to test for three label
 *                         names and drop the rest.
 *   1.0.0 (2026-07-10) — Initial (v1.14.0 digest release).
 */

import type { TrelloCard, TrelloCustomField } from "../trello/client";
import { CONTEXT_LIST_ALIASES, DEFAULT_TIMEZONE, LIST_ALIASES, ROLLING_BIG_ROCKS_ID } from "../trello/constants";
import { dayWindowMsInTz, isDueReportable, type SnoozedCard } from "../trello/tools";

/** The dashboard's zone layout, mirrored (ids from constants, WIP from list names). */
// Order and ids come from CONTEXT_LIST_ALIASES (constants.ts) so adding a
// context list cannot render a zone here whose cards silently stop counting as
// due-reportable. Only the display name and WIP limit are local. v1.22.0.
const CONTEXT_WIP: Record<string, number | null> = {
	"@computer": 7,
	"@errands": null,
	"@home": 5,
	"@lene": null,
	"@phone": 5,
};
type ContextZone = { id: string; name: string; wip: number | null };
const CONTEXTS: ContextZone[] = CONTEXT_LIST_ALIASES.map((alias) => ({
	id: LIST_ALIASES[alias],
	name: alias.replace(/^@(.)/, (_m, c: string) => `@${c.toUpperCase()}`),
	wip: CONTEXT_WIP[alias] ?? null,
}));
const WAITING_ID = LIST_ALIASES.waiting;
const INBOX_ID = LIST_ALIASES.inbox;



const DASHBOARD_URL = "https://todo.bleeker-pedersen.dk";

// ---- tiny helpers (mirror page.html semantics) ----

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function isDivider(c: TrelloCard): boolean {
	return /^-+$/.test((c.name || "").trim());
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

/** SSF palette. Blue chrome, navy data, orange only where something needs attention. */
const C = {
	navy: "#00254C",
	blue: "#2B6CB0",
	orange: "#ED8936",
	orangeText: "#C05621", // orange dark enough to read as text on white / soft grey
	ink: "#1A202C",
	grey: "#6B7280",
	line: "#CBD5E0",
	soft: "#EDF2F7",
	kort: "#DDEBF7",
	fersken: "#FDEBDC",
	sky: "#DCE9F7",
} as const;

const S = {
	badge: "display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;font-weight:600;margin-right:4px;",
	body: `margin:0;padding:0;background:#ffffff;color:${C.ink};font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;`,
	card: `border:1px solid ${C.line};padding:9px 10px;margin-bottom:8px;background:#ffffff;`,
	cardSnz: `border:1px dashed ${C.line};padding:9px 10px;margin-bottom:8px;background:#ffffff;`,
	col: `background:${C.soft};padding:12px;margin-bottom:14px;`,
	count: `font-size:11px;font-weight:600;color:${C.navy};background:#ffffff;border-radius:999px;padding:2px 9px;`,
	countOver: `font-size:11px;font-weight:600;color:#ffffff;background:${C.orange};border-radius:999px;padding:2px 9px;`,
	delta: `display:block;font-size:11px;color:${C.grey};margin-top:4px;`,
	deltaAlert: "display:block;font-size:11px;color:#FFF0E2;margin-top:4px;",
	desc: `font-size:11.5px;color:${C.grey};margin-top:3px;`,
	due: `font-size:11px;color:${C.orangeText};font-weight:600;margin-top:3px;`,
	empty: `font-size:12px;color:${C.grey};font-style:italic;padding:4px 2px;`,
	link: `color:${C.navy};text-decoration:none;`,
	note: `background:${C.fersken};border-left:4px solid ${C.orange};padding:12px 14px;margin-bottom:12px;font-size:13.5px;`,
	ovTile: `display:inline-block;text-align:center;padding:10px 14px;margin:0 8px 8px 0;text-decoration:none;`,
	stat: `display:inline-block;margin:0 10px 10px 0;padding:10px 14px 8px;min-width:92px;vertical-align:top;background:#ffffff;border:1px solid ${C.line};`,
	statAlert: `display:inline-block;margin:0 10px 10px 0;padding:10px 14px 8px;min-width:92px;vertical-align:top;background:${C.orange};border:1px solid ${C.orange};`,
	statLbl: `font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${C.grey};`,
	statLblAlert: "font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#FFF0E2;",
	statNum: `font-size:26px;font-weight:700;line-height:1;color:${C.navy};`,
	statNumAlert: "font-size:26px;font-weight:700;line-height:1;color:#ffffff;",
	subh: `font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:${C.grey};margin:14px 0 8px;`,
	title: "font-size:13.5px;font-weight:500;",
	wip: `display:inline-block;font-size:12px;padding:4px 11px;border-radius:999px;background:#ffffff;color:${C.navy};margin:0 6px 6px 0;`,
	wipOver: `display:inline-block;font-size:12px;padding:4px 11px;border-radius:999px;background:${C.orange};color:#ffffff;margin:0 6px 6px 0;`,
	zone: `font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.navy};margin:26px 0 10px;`,
	zoneSub: `font-weight:400;text-transform:none;letter-spacing:0;color:${C.grey};font-size:12.5px;`,
} as const;

/** Section heading: a short navy bar, the title, an optional grey sub-line. */
function zoneTitle(title: string, sub = ""): string {
	return `<div style="${S.zone}"><span style="width:14px;height:3px;background:${C.navy};display:inline-block;vertical-align:middle;margin-right:8px;"></span>${title}${
		sub ? ` <span style="${S.zoneSub}">${esc(sub)}</span>` : ""
	}</div>`;
}

/** Escaped card title, linked only when the URL passes the http(s) whitelist. */
function titleLink(name: string, url: string | undefined): string {
	return url && /^https?:\/\//i.test(url)
		? `<a href="${esc(url)}" style="${S.link}">${esc(name)}</a>`
		: esc(name);
}

/**
 * Custom-field values as badges. Definitions are passed in because the email is
 * rendered from a board snapshot with no client to look them up with; when the
 * caller has none (Power-Up off, fetch failed), every card silently renders
 * without them. Only fields with a value on this card appear. v1.18.0.
 */
function customFieldBadges(c: TrelloCard, defs: TrelloCustomField[]): string {
	const items = c.customFieldItems ?? [];
	if (!defs.length || !items.length) return "";
	let h = "";
	for (const it of items) {
		const f = defs.find((d) => d.id === it.idCustomField);
		if (!f) continue;
		let v: string | null = null;
		if (it.idValue) {
			v = f.options?.find((o) => o.id === it.idValue)?.value?.text ?? null;
		} else if (it.value) {
			if (typeof it.value.checked === "string") v = it.value.checked === "true" ? "yes" : "no";
			else if (it.value.text) v = it.value.text;
			else if (it.value.number) v = it.value.number;
			else if (it.value.date) v = it.value.date.slice(0, 10);
		}
		if (!v) continue;
		h += `<span style="${S.badge}background:${C.soft};color:${C.grey};border:1px solid ${C.line};">${esc(f.name)} &middot; ${esc(v)}</span>`;
	}
	return h;
}

/**
 * Trello's label palette → inline badge colours. The `_light` / `_dark`
 * variants of each hue collapse onto the base hue: a 10px pill can't carry
 * three shades of green and stay legible. Mirrors .badge.lbl-* in page.html.
 */
const LABEL_HUES: Record<string, string> = {
	black: "background:#8590a2;color:#091e42;",
	blue: "background:#579dff;color:#09326c;",
	green: "background:#4bce97;color:#164b35;",
	lime: "background:#94c748;color:#37471f;",
	orange: "background:#fea362;color:#702e00;",
	pink: "background:#e774bb;color:#50253f;",
	purple: "background:#9f8fef;color:#352c63;",
	red: "background:#f87168;color:#5d1f1a;",
	sky: "background:#6cc3e0;color:#164555;",
	yellow: "background:#f5cd47;color:#533f04;",
};
/** A label can carry a name with no colour at all. */
const LABEL_NO_HUE = "background:#dcdfe4;color:#44546f;";

/**
 * Labels with a hand-tuned badge; `text` shortens a name that would otherwise
 * dominate the row. Everything NOT listed here still renders, from its Trello
 * colour — the digest used to hardcode these three and silently drop every
 * other label a card carried.
 */
const LABEL_OVERRIDES: Record<string, { style: string; text?: string }> = {
	BESTSELLER: { style: `background:${C.navy};color:#ffffff;` },
	"DBP Invest": { style: `background:${C.blue};color:#ffffff;` },
	"Please Clarify and Organize": {
		style: `background:${C.fersken};color:${C.navy};`,
		text: "clarify",
	},
};

/** Every label on the card, in the order Trello returns them (board order). */
function labelBadges(c: TrelloCard): string {
	let h = "";
	for (const l of c.labels || []) {
		const name = l.name || "";
		const hand = LABEL_OVERRIDES[name];
		if (hand) {
			h += `<span style="${S.badge}${hand.style}">${esc(hand.text ?? name)}</span>`;
			continue;
		}
		// Trello allows a colour with no name — render the pill anyway rather
		// than dropping the label off the card entirely.
		const hue = LABEL_HUES[String(l.color || "").split("_")[0]] ?? LABEL_NO_HUE;
		h += `<span style="${S.badge}${hue}">${name ? esc(name) : "&middot;"}</span>`;
	}
	return h;
}

function badgesHtml(c: TrelloCard, customFields: TrelloCustomField[] = []): string {
	const h = labelBadges(c) + customFieldBadges(c, customFields);
	return h ? `<div style="margin-top:6px;">${h}</div>` : "";
}

function cardHtml(
	c: TrelloCard,
	tz: string,
	opts: { showDue?: boolean; nowMs?: number; customFields?: TrelloCustomField[] } = {},
): string {
	const title = titleLink(c.name, c.url);
	const snippet = descSnippet(c.desc);
	const due =
		opts.showDue && c.due && opts.nowMs !== undefined
			? `<div style="${S.due}">Due: ${esc(formatDue(c.due, tz, opts.nowMs))}</div>`
			: "";
	return `<div style="${S.card}"><div style="${S.title}">${title}</div>${due}${
		snippet ? `<div style="${S.desc}">${esc(snippet)}</div>` : ""
	}${badgesHtml(c, opts.customFields)}</div>`;
}

function columnHtml(
	name: string,
	cards: TrelloCard[],
	tz: string,
	wip: number | null,
	emptyText: string,
	forceOver = false,
	customFields: TrelloCustomField[] = [],
	extra = "",
): string {
	// forceOver mirrors the dashboard's inbox rule: any card in the inbox is
	// "over" (orange badge), WIP limit or not (v1.14.1 fix).
	const over = forceOver || (wip !== null && cards.length > wip);
	// How far over, not just that it is over: 22/7 and 8/7 are different problems.
	const overBy = wip !== null && cards.length > wip ? ` · +${cards.length - wip}` : "";
	const count = `<span style="${over ? S.countOver : S.count}">${cards.length}${wip !== null ? `/${wip}` : ""}${overBy}</span>`;
	const body = cards.length
		? cards.map((c) => cardHtml(c, tz, { customFields })).join("")
		: `<div style="${S.empty}">${esc(emptyText)}</div>`;
	return `<div style="${S.col}"><div style="margin-bottom:10px;"><span style="font-weight:600;font-size:13.5px;color:${C.navy};">${esc(name)}</span> ${count}</div>${body}${extra}</div>`;
}

/** What the five health figures were; stored once a day so the next digest can show the change. */
export interface DigestSnapshot {
	inbox: number;
	next: number;
	waiting: number;
	rocks: number;
	snoozed: number;
}

export interface Digest {
	subject: string;
	html: string;
	snapshot: DigestSnapshot;
}

/** "Mon 9 Nov" / "11 Nov" in the local timezone. */
function fmtWeekDay(iso: string, tz: string): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" })
		.format(new Date(Date.parse(iso)))
		.replace(",", "");
}
function fmtDay(iso: string, tz: string): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(Date.parse(iso)));
}

/** A snoozed card's home list, as the board names it ("waiting" → "Waiting for…"). */
function homeName(s: SnoozedCard): string {
	const a = s.homeListAlias;
	if (!a) return s.homeListId;
	if (a === "waiting") return "Waiting for…";
	if (a === "done") return "Done-do";
	return a.replace(/^@(.)/, (_m, c: string) => `@${c.toUpperCase()}`);
}

/** Dashboard URL for one list — the "Cards per list" tiles link here. */
function listLink(key: string): string {
	return `${DASHBOARD_URL}/dashboard#list-${key}`;
}

/**
 * Render the full digest from a board snapshot. `nowMs` fixes the clock so
 * overdue/due-today bucketing (and tests) are deterministic; buckets use the
 * same DST-correct local-day boundary as list_cards_due. `prev` is yesterday's
 * snapshot when there is one; without it the figures simply show no change.
 */
export function renderDigest(
	cards: TrelloCard[],
	nowMs: number,
	tz: string = DEFAULT_TIMEZONE,
	snoozed: SnoozedCard[] = [],
	customFields: TrelloCustomField[] = [],
	prev: DigestSnapshot | null = null,
): Digest {
	const open = cards.filter((c) => !c.closed && !isDivider(c));
	const inList = (id: string) => open.filter((c) => c.idList === id);

	const inbox = inList(INBOX_ID);
	const waiting = inList(WAITING_ID);
	const rocks = inList(ROLLING_BIG_ROCKS_ID);
	const ctxCols = CONTEXTS.map((l) => ({ ...l, cards: inList(l.id) }));
	const totalNext = ctxCols.reduce((s, l) => s + l.cards.length, 0);
	const snapshot: DigestSnapshot = {
		inbox: inbox.length,
		next: totalNext,
		waiting: waiting.length,
		rocks: rocks.length,
		snoozed: snoozed.length,
	};

	// Due buckets: actionable lists only (Done/Butler/etc. never nag).
	const { start: dayStart, end: dayEnd } = dayWindowMsInTz(nowMs, tz);
	// Shared with weekly_review_pack since v1.22.0 — the two surfaces read the
	// same board and used to disagree about what counts as due.
	const dueCards = open.filter(isDueReportable);
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
			return `<span style="${over ? S.wipOver : S.wip}"><b>${esc(l.name)}</b> ${l.cards.length}/${l.wip}${over ? ` · +${l.cards.length - l.wip} over` : ""}</span>`;
		})
		.join("");
	const deltaText = (key: keyof DigestSnapshot): string => {
		if (!prev) return "";
		const d = snapshot[key] - prev[key];
		return d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "±0";
	};
	const stat = (num: number, label: string, key: keyof DigestSnapshot, alert = false) => {
		const d = deltaText(key);
		return `<span style="${alert ? S.statAlert : S.stat}"><span style="${alert ? S.statNumAlert : S.statNum}">${num}</span>${
			d ? `<span style="${alert ? S.deltaAlert : S.delta}">${d}</span>` : ""
		}<span style="${alert ? S.statLblAlert : S.statLbl}">${esc(label)}</span></span>`;
	};
	const health = `<div style="${S.col}">${stat(inbox.length, "Inbox to clarify", "inbox", inbox.length > 0)}${stat(totalNext, "Next actions", "next")}${stat(waiting.length, "Waiting for", "waiting")}${stat(rocks.length, "Big rocks", "rocks")}${stat(snoozed.length, "Snoozed", "snoozed")}<div style="margin-top:6px;">${wipHtml}</div>${
		prev ? `<div style="font-size:11px;color:${C.grey};">Small figures: change since the last digest</div>` : ""
	}</div>`;

	// ---- Waking today (Snooze Power-Up; email-only section, v1.15.0) ----
	// Cards whose wake time falls inside the local day, plus overdue wakes
	// (wake time passed but the Power-Up hasn't fired) — both reappear today.
	// An overdue wake is a fault, not a normal wake, so it gets a warning box
	// of its own instead of a card that reads like routine.
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
				if (s.overdueWake) {
					const days = Math.floor((nowMs - Date.parse(s.wakeUp)) / (24 * 3600 * 1000));
					return `<div style="${S.note}"><b style="color:${C.navy};">Wake did not fire:</b> ${titleLink(s.name, s.url)} was due ${esc(fmtDay(s.wakeUp, tz))} (${days} day${days === 1 ? "" : "s"} ago) and has not returned to ${esc(homeName(s))}. Wake it from the dashboard or archive it.</div>`;
				}
				return `<div style="${S.card}"><div style="${S.title}">${titleLink(s.name, s.url)}</div><div style="${S.desc}">wakes ${esc(formatDue(s.wakeUp, tz, nowMs))} · → ${esc(homeName(s))}</div></div>`;
			})
			.join("");
		wakeSection = `${zoneTitle("Waking today", "snoozed cards returning to the board")}${rows}`;
	}

	// ---- Waking this week: the next 7 local days, after today ----
	const weekEnd = dayEnd + 6 * 24 * 3600 * 1000;
	const wakingWeek = snoozed
		.filter((s) => {
			const t = Date.parse(s.wakeUp);
			return !s.overdueWake && t >= dayEnd && t < weekEnd;
		})
		.sort((a, b) => a.wakeUp.localeCompare(b.wakeUp));
	const weekSection = wakingWeek.length
		? `${zoneTitle("Waking this week", "next 7 days")}${wakingWeek
				.map(
					(s) =>
						`<div style="${S.card}"><span style="${S.title}">${titleLink(s.name, s.url)}</span> <span style="${S.desc}">&nbsp;${esc(fmtWeekDay(s.wakeUp, tz))} · → ${esc(homeName(s))}</span></div>`,
				)
				.join("")}`
		: "";

	// ---- Overdue & due today (email-only section) ----
	let dueSection = "";
	if (overdue.length || dueToday.length) {
		const overdueHtml = overdue.length
			? `<div style="font-weight:600;font-size:13px;color:${C.orangeText};margin-bottom:8px;">Overdue (${overdue.length})</div>${overdue.map((c) => cardHtml(c, tz, { nowMs, showDue: true, customFields })).join("")}`
			: "";
		const todayHtml = dueToday.length
			? `<div style="font-weight:600;font-size:13px;color:${C.navy};margin:${overdue.length ? "12px" : "0"} 0 8px;">Due today (${dueToday.length})</div>${dueToday.map((c) => cardHtml(c, tz, { nowMs, showDue: true, customFields })).join("")}`
			: "";
		dueSection = `${zoneTitle("Overdue &amp; due today")}<div style="${S.col}border-left:4px solid ${C.orange};">${overdueHtml}${todayHtml}</div>`;
	}

	// ---- Friday: weekly-review extras (v1.16.0) ----
	// On Fridays the digest doubles as the GTD weekly-review nudge: stale
	// Waiting-for items (untouched 7+ days) and the could-do horizon counts.
	// All data is already in the board snapshot — no extra fetches.
	let reviewSection = "";
	const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(nowMs));
	if (weekday === "Fri") {
		const staleCutoff = nowMs - 7 * 24 * 3600 * 1000;
		const staleWaiting = waiting
			.filter((c) => Date.parse(c.dateLastActivity) < staleCutoff)
			.sort((a, b) => Date.parse(a.dateLastActivity) - Date.parse(b.dateLastActivity));
		const horizons = [
			{ id: LIST_ALIASES["could-personal"], name: "Could-do (Personal)" },
			{ id: LIST_ALIASES["could-bestseller"], name: "Could-do (BESTSELLER)" },
			{ id: LIST_ALIASES["could-dbp-invest"], name: "Could-do (DBP Invest)" },
			{ id: LIST_ALIASES["could-ssf"], name: "Could-do (SSF)" },
			{ id: LIST_ALIASES.someday, name: "Someday maybe" },
		].map((h) => ({ ...h, count: inList(h.id).length }));

		const staleHtml = staleWaiting.length
			? `<div style="font-weight:600;font-size:13.5px;color:${C.navy};margin-bottom:8px;">Waiting-for items untouched 7+ days (${staleWaiting.length})</div>${staleWaiting
					.map((c) => {
						const days = Math.floor((nowMs - Date.parse(c.dateLastActivity)) / (24 * 3600 * 1000));
						return `<div style="${S.card}"><div style="${S.title}">${titleLink(c.name, c.url)}</div><div style="${S.desc}">stale for ${days} days — chase or drop?</div></div>`;
					})
					.join("")}`
			: `<div style="font-weight:600;font-size:13.5px;color:${C.navy};">no stale waiting-for items — clean week</div>`;
		const horizonHtml = `<div style="margin-top:10px;">${horizons
			.map(
				(h) =>
					`<span style="display:inline-block;font-size:12px;padding:4px 11px;border-radius:999px;background:#ffffff;color:${C.navy};margin:0 6px 6px 0;"><b>${esc(h.name)}</b> ${h.count}</span>`,
			)
			.join("")}</div>`;
		reviewSection = `${zoneTitle("Weekly review", "it's Friday — worth a look")}<div style="background:${C.kort};border-left:4px solid ${C.blue};padding:14px 16px;">${staleHtml}${horizonHtml}</div>`;
	}

	// ---- Cards per list overview (matches the dashboard's .ov-panel; v1.14.1) ----
	// Each tile links to that list on the dashboard (an in-email anchor would be
	// stripped by most mail clients).
	const overviewEntries = [
		...ctxCols.map((l) => ({
			alert: l.wip !== null && l.cards.length > l.wip,
			count: l.cards.length,
			key: l.name.replace(/^@/, "").toLowerCase(),
			name: l.wip !== null && l.cards.length > l.wip ? `${l.name} · +${l.cards.length - l.wip} over` : l.name,
		})),
		{ alert: false, count: waiting.length, key: "waiting", name: "Waiting for…" },
		{ alert: inbox.length > 0, count: inbox.length, key: "inbox", name: "Inbox" },
	];
	const overviewHtml = `<div style="${S.col}">${overviewEntries
		.map(
			(e) =>
				`<a href="${listLink(e.key)}" style="${S.ovTile}background:${e.alert ? C.orange : "#ffffff"};${
					e.count === 0 ? "opacity:.55;" : ""
				}"><span style="display:block;font-size:22px;font-weight:700;line-height:1;color:${e.alert ? "#ffffff" : C.navy};">${e.count}</span><span style="display:block;font-size:10.5px;margin-top:5px;color:${e.alert ? "#FFF0E2" : C.grey};">${esc(e.name)}</span></a>`,
		)
		.join("")}</div>`;

	// ---- Zones (full replica) ----
	// Empty context lists are named in one line instead of getting a column each.
	const filledCtx = ctxCols.filter((l) => l.cards.length > 0);
	const emptyCtx = ctxCols.filter((l) => l.cards.length === 0);
	const ctxHtml =
		filledCtx.map((l) => columnHtml(l.name, l.cards, tz, l.wip, "clear", false, customFields)).join("") +
		(emptyCtx.length
			? `<div style="${S.empty}">Empty lists: ${emptyCtx.map((l) => esc(l.name)).join(", ")}</div>`
			: "");

	// Snoozed Waiting-for items are still waiting; show them under the list so a
	// short Waiting-for does not look like nothing is pending on others.
	const waitingSnoozed = snoozed
		.filter((s) => s.homeListId === WAITING_ID)
		.sort((a, b) => a.wakeUp.localeCompare(b.wakeUp));
	const waitingExtra = waitingSnoozed.length
		? `<div style="${S.subh}">Snoozed · ${waitingSnoozed.length}</div>${waitingSnoozed
				.map(
					(s) =>
						`<div style="${S.cardSnz}"><div style="${S.title}">${titleLink(s.name, s.url)}</div><div style="${S.desc}">waiting, ${s.overdueWake ? "wake overdue" : `wakes ${esc(fmtDay(s.wakeUp, tz))}`}</div></div>`,
				)
				.join("")}`
		: "";
	const waitingHtml = columnHtml("Waiting for…", waiting, tz, null, "nothing pending on others", false, customFields, waitingExtra);
	const inboxHtml = columnHtml("Inbox — clarify", inbox, tz, null, "inbox zero 🎉", inbox.length > 0, customFields);
	const rocksHtml = rocks.length
		? rocks.map((c) => cardHtml(c, tz, { customFields })).join("")
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
<div style="background:${C.blue};padding:18px 24px;color:#ffffff;"><div style="font-weight:700;font-size:17px;">StruktureretSundFornuft.dk</div><div style="font-size:11.5px;color:${C.sky};margin-top:2px;">Fordi sund fornuft ikke er så udbredt i praksis</div></div>
<div style="padding:24px;">
<div style="width:36px;height:4px;background:${C.orange};margin-bottom:12px;"></div>
<div style="margin-bottom:18px;"><span style="font-size:26px;line-height:1.2;font-weight:700;color:${C.navy};">Todays Actions</span>
<span style="font-size:13px;color:${C.grey};"> — ${esc(dateLine)}</span><br>
<a href="${DASHBOARD_URL}" style="font-size:13px;color:${C.blue};">Open the live dashboard →</a></div>
${health}
${dueSection}
${wakeSection}
${weekSection}
${reviewSection}
${zoneTitle("Cards per list")}
${overviewHtml}
${zoneTitle("Next actions", "by context")}
${ctxHtml}
${zoneTitle("Needs attention")}
${waitingHtml}
${inboxHtml}
${zoneTitle("Rolling big rocks", "your active projects")}
${rocksHtml}
</div>
<div style="background:${C.blue};color:${C.sky};padding:16px 24px;font-size:12px;">Sent daily at 04:00 Copenhagen time by trello-mcp · <a href="${DASHBOARD_URL}" style="color:${C.sky};">${DASHBOARD_URL.replace("https://", "")}</a></div>
</div>
</body>
</html>`;

	return { html, subject: "Todays Actions", snapshot };
}
