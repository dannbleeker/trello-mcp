/**
 * File: src/trello/insights.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-11-08
 * Version: 1.0.0
 * Description: Read-only review tools built from a look at how the board is
 *              actually used (v1.26.0):
 *
 *                week_recap      — the week's activity, aggregated server-side
 *                                  and split into human work vs Repeater /
 *                                  Butler automation. Replaces paging raw
 *                                  list_my_actions (300 actions ≈ 280k chars).
 *                repeater_report — per Repeater template: spawns, completions,
 *                                  copies stacking up open, chores never done.
 *                wip_triage      — over-limit context lists (counting the
 *                                  snoozes about to wake), ranked by idleness,
 *                                  with a suggested destination per card.
 *                horizons_pack   — Big Rocks, Could-do horizons, area balance
 *                                  and the long tickler tail, for a Higher
 *                                  Horizons review.
 *                clarify_inbox   — per inbox card: likely context, possible
 *                                  duplicates, garbled-dictation flag.
 *
 *              None of these write. They suggest; the caller moves cards with
 *              batch_move_cards (or, for snoozes, the Trello UI: creating a
 *              snooze is impossible over REST, see SNOOZE_PLUGIN_ID).
 *
 *              Automation lives in Dann's name. Repeater and Butler act AS the
 *              token's member, so every action they take is authored by Dann
 *              Bleeker Pedersen. The only way to tell them apart is shape:
 *                - Repeater: a copyCard whose cardSource is a template on the
 *                  Repeater Cards list.
 *                - Butler: a move into a Done-like list within a few seconds of
 *                  the same card's due date being marked complete. The
 *                  dashboard's Done button produces the same pair, so the
 *                  bucket is named for the shape, not the robot.
 *              Butler's rules themselves are not readable over REST.
 *
 * Change log:
 *   1.0.0 (2026-11-08) — Initial.
 */

import type { TrelloAction, TrelloCard, TrelloClient, TrelloList } from "./client";
import {
	CONTEXT_LIST_ALIASES,
	DEFAULT_BOARD,
	LIST_ALIASES,
	REPEATER_CARDS_LIST_ID,
	ROLLING_BIG_ROCKS_ID,
	listAliasFor,
	resolveBoard,
	resolveList,
} from "./constants";
import { GuardError } from "./guards";
import { resolveBoardRef, resolveListRef } from "./resolve";
import { localDate } from "./review-history";
import {
	WEEKLY_REVIEW_COULD_LISTS,
	parseSnoozeWakeMs,
	snoozedFromArchived,
	wipStatuses,
	type WipStatus,
} from "./tools";

const DAY_MS = 24 * 3600 * 1000;
/**
 * Case-insensitive whole-word match for any of `words` (phrases allowed).
 * JavaScript's `\b` is ASCII-only: it sees no boundary after "på" or "år", so
 * /\bventer på\b/ never matches "Venter på svar". Unicode lookarounds instead.
 */
function wordsRe(words: string[]): RegExp {
	const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "iu");
}

/** A completion and a Done move this close together are one automated pair. */
const AUTO_DONE_WINDOW_MS = 5_000;
/** Lists whose name says "finished". Used where no alias is known (zoo, TECH Retail). */
const DONE_LIST_RE = wordsRe(["done", "completed", "færdig", "afsluttet"]);

// ---- small helpers ----------------------------------------------------------

/** Typed reads into an action's loosely-typed `data`. */
interface Named {
	id?: string;
	name?: string;
}
function dataOf(a: TrelloAction) {
	const d = a.data as Record<string, unknown>;
	return {
		board: d.board as Named | undefined,
		card: d.card as (Named & { dueComplete?: boolean; closed?: boolean }) | undefined,
		cardSource: d.cardSource as Named | undefined,
		checkItem: d.checkItem as (Named & { state?: string }) | undefined,
		list: d.list as Named | undefined,
		listAfter: d.listAfter as Named | undefined,
		listBefore: d.listBefore as Named | undefined,
		old: (d.old as Record<string, unknown> | undefined) ?? {},
	};
}

function idleDays(card: { dateLastActivity: string }, nowMs: number): number {
	const t = Date.parse(card.dateLastActivity);
	return Number.isNaN(t) ? 0 : Math.floor((nowMs - t) / DAY_MS);
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Days since a card was created. A Trello ID's first 8 hex digits are its
 * creation time in epoch seconds; dateLastActivity moves on every touch.
 * Clamped at 0 (clock skew, or a non-Trello test ID).
 */
export function ageDaysFromId(id: string, nowMs: number): number {
	const created = Number.parseInt(id.slice(0, 8), 16) * 1000;
	if (!Number.isFinite(created)) return 0;
	return Math.max(0, Math.floor((nowMs - created) / DAY_MS));
}

/** Lowercased word tokens, Unicode-aware (æ, ø, å are letters). */
export function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);
}

/**
 * Page backwards through an action feed until the window is covered or the
 * page budget runs out. Trello returns newest-first, max 1000 per page; the
 * oldest action's ID is the cursor for the next page.
 */
async function fetchActionWindow(
	fetchPage: (q: { since: string; before?: string; limit: number }) => Promise<TrelloAction[]>,
	since: string,
	until: string | undefined,
	maxPages: number,
): Promise<{ actions: TrelloAction[]; truncated: boolean }> {
	const actions: TrelloAction[] = [];
	let before = until;
	for (let page = 0; page < maxPages; page++) {
		const batch = await fetchPage({ before, limit: 1000, since });
		actions.push(...batch);
		if (batch.length < 1000) return { actions, truncated: false };
		const oldest = batch.reduce((a, b) => (Date.parse(a.date) <= Date.parse(b.date) ? a : b));
		before = oldest.id;
	}
	return { actions, truncated: true };
}

function parseWindowStart(since: string | undefined, days: number | undefined, nowMs: number): string {
	if (since !== undefined) {
		const t = Date.parse(since);
		if (Number.isNaN(t)) throw new GuardError(`since must be an ISO 8601 date; got "${since}".`);
		return new Date(t).toISOString();
	}
	const d = days ?? 7;
	if (!Number.isFinite(d) || d <= 0 || d > 90) throw new GuardError("days must be between 1 and 90.");
	return new Date(nowMs - d * DAY_MS).toISOString();
}

/** Card IDs of the Repeater templates. Fail-soft: no list access → no templates known. */
async function repeaterTemplates(client: TrelloClient): Promise<TrelloCard[]> {
	try {
		return (await client.listCardsOnList(REPEATER_CARDS_LIST_ID)).filter((t) => !isDivider(t.name));
	} catch {
		return [];
	}
}

// ---- week_recap -------------------------------------------------------------

export interface RecapCard {
	name: string;
	board: string | null;
	list: string | null;
	date: string;
	/** Spawned by Repeater, or named like a Repeater template: a chore, not a project step. */
	recurring?: boolean;
}

/** What the week's actions add up to. Exported for tests; the tool wraps it. */
export interface WeekRecap {
	window: { since: string; until: string };
	actionsScanned: number;
	/** true when the page budget ran out before the window start was reached. */
	truncated: boolean;
	human: {
		completed: { count: number; recurring: number; cards: RecapCard[] };
		created: { count: number; cards: RecapCard[] };
		moved: { count: number; top: { from: string; to: string; count: number }[] };
		archived: number;
		deleted: number;
		comments: number;
		checklistTicks: { count: number; byCard: { name: string; count: number }[] };
		customFieldEdits: number;
		other: number;
	};
	automation: {
		repeaterSpawned: { count: number; cards: RecapCard[] };
		/** Done moves within a few seconds of the completion: Butler, or the dashboard's Done button. */
		autoMovedToDone: number;
	};
	byBoard: { board: string; actions: number; completed: number; created: number }[];
	/** Human actions per local day. */
	byDay: Record<string, number>;
	templatesKnown: number;
}

/**
 * Pure: classify a window of actions. Exported so the automation heuristics
 * can be tested on fixed action lists.
 */
export function summariseActions(
	actions: TrelloAction[],
	templates: { id: string; name: string }[],
	opts: { since: string; until: string; truncated: boolean; maxNames: number },
): WeekRecap {
	const templateIds = new Set(templates.map((t) => t.id));
	const templateNames = new Set(templates.map((t) => t.name.trim().toLowerCase()));
	const sorted = [...actions].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

	const spawnedIds = new Set<string>();
	const completedAt = new Map<string, number>();
	const completedIds = new Set<string>();
	const completed: RecapCard[] = [];
	const created: RecapCard[] = [];
	const spawned: RecapCard[] = [];
	const transitions = new Map<string, { from: string; to: string; count: number }>();
	const ticks = new Map<string, number>();
	const byBoard = new Map<string, { board: string; actions: number; completed: number; created: number }>();
	const byDay: Record<string, number> = {};
	let moved = 0;
	let archived = 0;
	let deleted = 0;
	let comments = 0;
	let tickCount = 0;
	let fieldEdits = 0;
	let other = 0;
	let autoDone = 0;

	const boardRow = (name: string) => {
		if (!byBoard.has(name)) byBoard.set(name, { actions: 0, board: name, completed: 0, created: 0 });
		return byBoard.get(name) as { board: string; actions: number; completed: number; created: number };
	};
	const isRecurring = (cardId: string | undefined, name: string | undefined) =>
		(cardId !== undefined && spawnedIds.has(cardId)) ||
		(name !== undefined && templateNames.has(name.trim().toLowerCase()));

	for (const a of sorted) {
		const d = dataOf(a);
		const boardName = d.board?.name ?? "(unknown board)";
		const cardName = d.card?.name ?? "(unnamed card)";
		const cardId = d.card?.id;
		const t = Date.parse(a.date);
		const entry = (list?: Named): RecapCard => ({
			board: d.board?.name ?? null,
			date: a.date,
			list: list?.name ?? d.list?.name ?? null,
			name: cardName,
		});
		let human = true;

		const markCompleted = (list?: Named) => {
			if (cardId && completedIds.has(cardId)) return;
			if (cardId) completedIds.add(cardId);
			const row = entry(list);
			if (isRecurring(cardId, cardName)) row.recurring = true;
			completed.push(row);
			boardRow(boardName).completed += 1;
		};

		if (a.type === "copyCard" && d.cardSource?.id && templateIds.has(d.cardSource.id)) {
			human = false;
			if (cardId) spawnedIds.add(cardId);
			spawned.push(entry());
		} else if (a.type === "createCard" || a.type === "copyCard" || a.type === "convertToCardFromCheckItem") {
			created.push(entry());
			boardRow(boardName).created += 1;
		} else if (a.type === "updateCard") {
			if ("dueComplete" in d.old && d.card?.dueComplete === true) {
				if (cardId) completedAt.set(cardId, t);
				markCompleted();
			} else if (d.listAfter && d.listBefore) {
				const doneMove = DONE_LIST_RE.test(d.listAfter.name ?? "");
				const ticked = cardId ? completedAt.get(cardId) : undefined;
				if (doneMove && ticked !== undefined && t - ticked <= AUTO_DONE_WINDOW_MS) {
					human = false;
					autoDone += 1;
				} else {
					moved += 1;
					const from = d.listBefore.name ?? "?";
					const to = d.listAfter.name ?? "?";
					const key = `${from}\u0000${to}`;
					const row = transitions.get(key) ?? { count: 0, from, to };
					row.count += 1;
					transitions.set(key, row);
					if (doneMove) markCompleted(d.listAfter);
				}
			} else if ("closed" in d.old && d.card?.closed === true) {
				archived += 1;
			} else {
				other += 1;
			}
		} else if (a.type === "deleteCard") {
			deleted += 1;
		} else if (a.type === "commentCard") {
			comments += 1;
		} else if (a.type === "updateCheckItemStateOnCard") {
			if (d.checkItem?.state === "complete") {
				tickCount += 1;
				ticks.set(cardName, (ticks.get(cardName) ?? 0) + 1);
			} else {
				other += 1;
			}
		} else if (a.type === "updateCustomFieldItem") {
			fieldEdits += 1;
		} else {
			other += 1;
		}

		if (human) {
			boardRow(boardName).actions += 1;
			const day = localDate(t);
			byDay[day] = (byDay[day] ?? 0) + 1;
		}
	}

	const cap = <T>(xs: T[]) => xs.slice(-opts.maxNames).reverse(); // newest first
	return {
		actionsScanned: actions.length,
		automation: {
			autoMovedToDone: autoDone,
			repeaterSpawned: { cards: cap(spawned), count: spawned.length },
		},
		byBoard: [...byBoard.values()].sort((a, b) => b.actions - a.actions),
		byDay,
		human: {
			archived,
			checklistTicks: {
				byCard: [...ticks.entries()]
					.map(([name, count]) => ({ count, name }))
					.sort((a, b) => b.count - a.count)
					.slice(0, opts.maxNames),
				count: tickCount,
			},
			comments,
			completed: {
				cards: cap(completed),
				count: completed.length,
				recurring: completed.filter((c) => c.recurring).length,
			},
			created: { cards: cap(created), count: created.length },
			customFieldEdits: fieldEdits,
			deleted,
			moved: {
				count: moved,
				top: [...transitions.values()].sort((a, b) => b.count - a.count).slice(0, 15),
			},
			other,
		},
		templatesKnown: templates.length,
		truncated: opts.truncated,
		window: { since: opts.since, until: opts.until },
	};
}

/**
 * week_recap — "what got done" for a window (default the last 7 days), across
 * every board or one. One tool call, a few kilobytes back.
 */
export async function week_recap(
	client: TrelloClient,
	input: { since?: string; until?: string; days?: number; board?: string; maxNames?: number },
	nowMs = Date.now(),
): Promise<WeekRecap> {
	const since = parseWindowStart(input.since, input.days, nowMs);
	let until: string | undefined;
	if (input.until !== undefined) {
		const t = Date.parse(input.until);
		if (Number.isNaN(t)) throw new GuardError(`until must be an ISO 8601 date; got "${input.until}".`);
		until = new Date(t).toISOString();
	}
	const boardId = input.board ? await resolveBoardRef(client, input.board) : null;
	const [{ actions, truncated }, templates] = await Promise.all([
		fetchActionWindow((q) => client.listMyActionsPage(q), since, until, 5),
		repeaterTemplates(client),
	]);
	const scoped = boardId ? actions.filter((a) => dataOf(a).board?.id === boardId) : actions;
	return summariseActions(scoped, templates, {
		maxNames: Math.min(Math.max(input.maxNames ?? 30, 1), 200),
		since,
		truncated,
		until: until ?? new Date(nowMs).toISOString(),
	});
}

// ---- repeater_report ----------------------------------------------------------

export type SpawnStatus = "open" | "completed" | "archived" | "snoozed" | "deleted";

export interface TemplateHealth {
	templateId: string;
	name: string;
	/** Where the spawns land (the copyCard destination), most recent first. */
	lists: string[];
	spawns: number;
	completed: number;
	archived: number;
	snoozed: number;
	open: number;
	deleted: number;
	/** (completed + archived) / spawns, or null with no spawns in the window. */
	doneRate: number | null;
	lastSpawn: string | null;
	openNow: { id: string; list: string | null; spawnedAt: string; ageDays: number }[];
	flags: string[];
}

/** Pure: classify one spawned card's current state. `card` is null for a 404. */
export function spawnStatus(
	card: { closed: boolean; dueComplete: boolean; idList: string; pluginData?: TrelloCard["pluginData"] } | null,
	doneListIds: ReadonlySet<string>,
): SpawnStatus {
	if (!card) return "deleted";
	if (card.closed) return parseSnoozeWakeMs(card as TrelloCard) !== null ? "snoozed" : "archived";
	if (card.dueComplete || doneListIds.has(card.idList)) return "completed";
	return "open";
}

/** A divider card on the Repeater list ("---", "———", blank): not a template. */
export function isDivider(name: string): boolean {
	return /^[\s\-–—_=*.]*$/.test(name);
}

/** Pure: the flags a template earns. No spawns is not a flag: yearly chores are quiet most months. */
export function templateFlags(h: Pick<TemplateHealth, "spawns" | "open" | "completed" | "archived">): string[] {
	const flags: string[] = [];
	const closedOut = h.completed + h.archived;
	if (h.open >= 2) flags.push(`stacking: ${h.open} copies open at once`);
	if (h.spawns >= 2 && closedOut === 0) flags.push("never completed in window");
	else if (h.spawns >= 3 && closedOut / h.spawns < 0.5) flags.push("completed less than half the time");
	return flags;
}

/**
 * repeater_report — health of every Repeater template over the last `days`
 * (default 28). Reads the Repeater Cards list (read-only — writes there stay
 * forbidden), the board's copyCard actions, and the current state of every
 * spawned copy via /batch (10 cards per request).
 *
 * The template's cadence is the Power-Up's private data and is not reported;
 * the spawn dates show it in practice.
 */
export async function repeater_report(
	client: TrelloClient,
	input: { board?: string; days?: number },
	nowMs = Date.now(),
): Promise<{
	window: { since: string; days: number };
	templates: number;
	totals: { spawns: number; completed: number; archived: number; snoozed: number; open: number; deleted: number };
	flagged: TemplateHealth[];
	healthy: TemplateHealth[];
	/** Templates that did not fire in the window: a monthly or yearly cadence, or paused. Names only. */
	quiet: { templateId: string; name: string }[];
	truncated: boolean;
}> {
	const days = input.days ?? 28;
	if (!Number.isInteger(days) || days < 1 || days > 90) throw new GuardError("days must be an integer from 1 to 90.");
	const boardId = await resolveBoardRef(client, input.board);
	const lists = await client.listListsOnBoard(boardId);
	const repeaterList =
		lists.find((l) => l.id === REPEATER_CARDS_LIST_ID) ?? lists.find((l) => /repeater/i.test(l.name));
	if (!repeaterList) {
		throw new GuardError(`Board ${boardId} has no Repeater Cards list, so it has no Repeater templates to report on.`);
	}
	const doneListIds = new Set(lists.filter((l) => DONE_LIST_RE.test(l.name)).map((l) => l.id));
	if (boardId === resolveBoard(DEFAULT_BOARD)) doneListIds.add(LIST_ALIASES.done);

	const since = new Date(nowMs - days * DAY_MS).toISOString();
	const [listed, { actions, truncated }] = await Promise.all([
		client.listCardsOnList(repeaterList.id),
		fetchActionWindow((q) => client.listBoardActionsPage(boardId, { ...q, filter: "copyCard" }), since, undefined, 3),
	]);
	// "---" cards are dividers Dann uses to group the templates, not templates.
	const templates = listed.filter((t) => !isDivider(t.name));
	const templateIds = new Set(templates.map((t) => t.id));

	const spawnsBy = new Map<string, { cardId: string; list: string | null; date: string }[]>();
	for (const a of actions) {
		const d = dataOf(a);
		if (a.type !== "copyCard" || !d.cardSource?.id || !templateIds.has(d.cardSource.id) || !d.card?.id) continue;
		const rows = spawnsBy.get(d.cardSource.id) ?? [];
		rows.push({ cardId: d.card.id, date: a.date, list: d.list?.name ?? null });
		spawnsBy.set(d.cardSource.id, rows);
	}

	// Current state of every spawned copy. pluginData tells a snoozed copy from
	// an archived one. No `fields=` — /batch splits its urls on commas.
	const spawnedIds = [...spawnsBy.values()].flat().map((s) => s.cardId);
	const state = new Map<string, TrelloCard | null>();
	for (let i = 0; i < spawnedIds.length; i += 10) {
		const chunk = spawnedIds.slice(i, i + 10);
		const res = await client.batchGet(chunk.map((id) => `/cards/${id}?pluginData=true`));
		chunk.forEach((id, j) => {
			const r = res[j];
			state.set(id, r && r.statusCode === 200 ? (r.body as TrelloCard) : null);
		});
	}

	const all: TemplateHealth[] = templates.map((tpl) => {
		const rows = (spawnsBy.get(tpl.id) ?? []).sort((a, b) => b.date.localeCompare(a.date));
		const counts = { archived: 0, completed: 0, deleted: 0, open: 0, snoozed: 0 };
		const openNow: TemplateHealth["openNow"] = [];
		for (const r of rows) {
			const card = state.get(r.cardId) ?? null;
			const status = spawnStatus(card, doneListIds);
			counts[status] += 1;
			if (status === "open") {
				openNow.push({
					ageDays: Math.floor((nowMs - Date.parse(r.date)) / DAY_MS),
					id: r.cardId,
					list: r.list,
					spawnedAt: r.date,
				});
			}
		}
		const h = { ...counts, spawns: rows.length };
		return {
			...counts,
			doneRate: rows.length ? Math.round(((counts.completed + counts.archived) / rows.length) * 100) / 100 : null,
			flags: templateFlags(h),
			lastSpawn: rows[0]?.date ?? null,
			lists: [...new Set(rows.map((r) => r.list).filter((l): l is string => l !== null))],
			name: tpl.name,
			openNow,
			spawns: rows.length,
			templateId: tpl.id,
		};
	});

	const totals = { archived: 0, completed: 0, deleted: 0, open: 0, snoozed: 0, spawns: 0 };
	for (const h of all) {
		totals.spawns += h.spawns;
		totals.completed += h.completed;
		totals.archived += h.archived;
		totals.snoozed += h.snoozed;
		totals.open += h.open;
		totals.deleted += h.deleted;
	}
	const byConcern = (a: TemplateHealth, b: TemplateHealth) => b.flags.length - a.flags.length || b.open - a.open;
	return {
		flagged: all.filter((h) => h.flags.length > 0).sort(byConcern),
		healthy: all.filter((h) => h.spawns > 0 && h.flags.length === 0).sort((a, b) => a.name.localeCompare(b.name)),
		quiet: all
			.filter((h) => h.spawns === 0)
			.map((h) => ({ name: h.name, templateId: h.templateId }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		templates: templates.length,
		totals,
		truncated,
		window: { days, since },
	};
}

// ---- wip_triage ---------------------------------------------------------------

export type TriageAction = "clarify" | "snooze" | "waiting" | "someday" | "could-do" | "keep";

export interface TriageSuggestion {
	id: string;
	name: string;
	url: string;
	idleDays: number;
	/** Days since the card was created (from its ID). A review touches every card, so idleDays alone undercounts. */
	ageDays: number;
	/** What ranked it: idleness (the rules), or age (filling up to the overflow when too few cards are idle). */
	basis: "idle" | "age";
	labels: string[];
	action: TriageAction;
	/** List alias to move it to (batch_move_cards), or null when the step is done elsewhere. */
	target: string | null;
	reason: string;
	how: string;
}

const SNOOZE_HOW = "Trello UI → Snooze Power-Up (the API cannot create snoozes)";
const MOVE_HOW = "batch_move_cards";

/** Words that say "this belongs to a later date". Danish + English. */
const LATER_HINT = new RegExp(
	`${wordsRe([
		"primo", "ultimo", "januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober",
		"november", "december", "january", "february", "march", "june", "july", "october", "next year", "næste år",
		"efter", "after",
	]).source}|(?<!\\d)20\\d\\d(?!\\d)`,
	"iu",
);
const WAITING_HINT = wordsRe(["venter på", "afventer", "waiting for", "waiting on"]);

/** Could-do horizon for a card, from its labels. Only meaningful on dann-to-do. */
export function horizonFor(labels: string[]): string {
	const l = labels.map((x) => x.toLowerCase());
	if (l.some((x) => x.includes("bestseller"))) return "could-bestseller";
	if (l.some((x) => x === "ssf" || x.includes("struktureret"))) return "could-ssf";
	if (l.some((x) => x.includes("invest") || x.includes("dbp"))) return "could-dbp-invest";
	return "could-personal";
}

/**
 * Pure: what to do with one card on an over-limit list. Rules, first match
 * wins: labelled for clarification → back to clarify; reads as waiting →
 * Waiting for; dated later (future due, or a date word) → snooze in the UI;
 * idle 3× the threshold → Someday; idle past the threshold → its Could-do
 * horizon; otherwise keep.
 */
export function triageCard(
	card: { id: string; name: string; desc: string; url: string; due: string | null; labels: { name: string }[]; dateLastActivity: string },
	nowMs: number,
	staleDays: number,
	knownBoard: boolean,
): TriageSuggestion {
	const labels = card.labels.map((l) => l.name).filter((n) => n.length > 0);
	const idle = idleDays(card, nowMs);
	const base = { ageDays: ageDaysFromId(card.id, nowMs), basis: "idle" as const, id: card.id, idleDays: idle, labels, name: card.name, url: card.url };
	const to = (alias: string) => (knownBoard ? alias : null);
	if (labels.some((l) => /clarify/i.test(l))) {
		return { ...base, action: "clarify", how: MOVE_HOW, reason: `labelled "${labels.find((l) => /clarify/i.test(l))}": not a next action yet`, target: to("inbox") };
	}
	if (WAITING_HINT.test(card.name)) {
		return { ...base, action: "waiting", how: MOVE_HOW, reason: "reads as waiting on someone", target: to("waiting") };
	}
	const due = card.due ? Date.parse(card.due) : Number.NaN;
	if (!Number.isNaN(due) && due > nowMs + 14 * DAY_MS) {
		return { ...base, action: "snooze", how: SNOOZE_HOW, reason: `due ${card.due?.slice(0, 10)}: snooze it until the week before`, target: null };
	}
	if (LATER_HINT.test(card.name)) {
		return { ...base, action: "snooze", how: SNOOZE_HOW, reason: "the title names a later date", target: null };
	}
	if (idle >= staleDays * 3) {
		return { ...base, action: "someday", how: MOVE_HOW, reason: `untouched for ${idle} days`, target: to("someday") };
	}
	if (idle >= staleDays) {
		const h = horizonFor(labels);
		return { ...base, action: "could-do", how: MOVE_HOW, reason: `untouched for ${idle} days`, target: to(h) };
	}
	return { ...base, action: "keep", how: "-", reason: `touched ${idle} day(s) ago`, target: null };
}

/**
 * wip_triage — for every WIP-limited list that is over its limit (counting
 * the snoozes waking in the next 7 days), the cards to thin, most idle first,
 * each with a suggested destination. `moves` groups the movable ones by
 * target so they can go straight into batch_move_cards.
 */
export async function wip_triage(
	client: TrelloClient,
	input: { board?: string; list?: string; staleDays?: number; maxPerList?: number },
	nowMs = Date.now(),
): Promise<{
	asOf: string;
	staleDays: number;
	lists: (WipStatus & { needToMove: number; suggestions: TriageSuggestion[] })[];
	moves: { target: string; cardIds: string[] }[];
	note: string;
}> {
	const boardId = await resolveBoardRef(client, input.board);
	const staleDays = input.staleDays ?? 21;
	const maxPerList = Math.min(Math.max(input.maxPerList ?? 10, 1), 50);
	const [lists, cards, archived] = await Promise.all([
		client.listListsOnBoard(boardId),
		client.listCardsOnBoard(boardId),
		client.listArchivedCardsWithPluginData(boardId),
	]);
	const open = cards.filter((c) => !c.closed);
	const statuses = wipStatuses(lists, open, snoozedFromArchived(archived, nowMs), nowMs);

	let targets: WipStatus[];
	if (input.list) {
		const listId = await resolveListRef(client, input.list, { board: boardId });
		const s = statuses.find((x) => x.listId === listId);
		if (!s) throw new GuardError(`List ${input.list} has no "(WIP limit N)" in its name, so there is no limit to triage against.`);
		targets = [s];
	} else {
		targets = statuses.filter((s) => s.overAfterWakes > 0);
	}

	const knownBoard = boardId === resolveBoard(DEFAULT_BOARD);
	const movesBy = new Map<string, string[]>();
	const out = targets.map((s) => {
		const all = open
			.filter((c) => c.idList === s.listId)
			.sort((a, b) => Date.parse(a.dateLastActivity) - Date.parse(b.dateLastActivity))
			.map((c) => triageCard(c, nowMs, staleDays, knownBoard));
		const ranked = all.filter((t) => t.action !== "keep");
		// A weekly review touches every card it walks past, so right after one
		// almost nothing looks idle. When the rules find fewer cards than the
		// list is over by, fill up with the OLDEST remaining cards by creation:
		// a card sitting on a context list for months is the likeliest
		// not-really-this-week action, whatever its last-touched date says.
		const shortfall = s.overAfterWakes - ranked.length;
		if (shortfall > 0) {
			const fill = all
				.filter((t) => t.action === "keep")
				.sort((a, b) => b.ageDays - a.ageDays)
				.slice(0, shortfall)
				.map((t): TriageSuggestion => ({
					...t,
					action: "could-do",
					basis: "age",
					how: MOVE_HOW,
					reason: `list is ${s.overAfterWakes} over; created ${t.ageDays} days ago — still a next action this week?`,
					target: knownBoard ? horizonFor(t.labels) : null,
				}));
			ranked.push(...fill);
		}
		ranked.splice(maxPerList);
		for (const t of ranked) {
			if (!t.target) continue;
			const ids = movesBy.get(t.target) ?? [];
			ids.push(t.id);
			movesBy.set(t.target, ids);
		}
		return { ...s, needToMove: s.overAfterWakes, suggestions: ranked };
	});

	return {
		asOf: new Date(nowMs).toISOString(),
		lists: out,
		moves: [...movesBy.entries()].map(([target, cardIds]) => ({ cardIds, target })),
		note: "Suggestions only; nothing was moved. Cards touched recently are left out. Snoozes must be set in the Trello UI.",
		staleDays,
	};
}

// ---- horizons_pack --------------------------------------------------------------

const HORIZON_QUESTIONS = [
	"Areas of focus (20,000 ft): which areas of responsibility have no active project or next action?",
	"Goals (30,000 ft, 1–2 years): what has to be true by this time next year? Which Big Rock serves it?",
	"Vision (40,000 ft, 3–5 years): what does success look like, and is anything on the board working against it?",
	"Purpose (50,000 ft): what is all of this for?",
	"Big Rocks: which stale rock should be re-committed, re-scoped, or let go?",
	"Someday/Maybe: what in the long tail should be promoted, or deleted?",
];

/**
 * horizons_pack — the material for a Higher Horizons review: every Rolling
 * Big Rock with how long it has sat untouched, each Could-do horizon's size
 * and its oldest cards, how open actions spread across label areas, the
 * snoozed long tail by month, and the standard GTD horizon questions.
 * dann-to-do-shaped (its aliases), like weekly_review_pack.
 */
export async function horizons_pack(
	client: TrelloClient,
	input: { board?: string; staleDays?: number; sample?: number },
	nowMs = Date.now(),
): Promise<{
	asOf: string;
	staleDays: number;
	big_rocks: { count: number; stale: number; rocks: { id: string; name: string; url: string; labels: string[]; idleDays: number; stale: boolean; due: string | null; desc: string }[] };
	horizons: Record<string, { count: number; medianIdleDays: number | null; oldest: { id: string; name: string; url: string; idleDays: number }[] }>;
	areas: { label: string; open: number }[];
	ticklers: { month: string; count: number; cards: string[] }[];
	questions: string[];
}> {
	const boardId = await resolveBoardRef(client, input.board);
	if (boardId !== resolveBoard(DEFAULT_BOARD)) {
		throw new GuardError(`horizons_pack is dann-to-do-shaped (its list aliases resolve to that board only). Refusing board=${input.board}.`);
	}
	const staleDays = input.staleDays ?? 30;
	const sample = Math.min(Math.max(input.sample ?? 3, 1), 25);
	const [cards, archived] = await Promise.all([
		client.listCardsOnBoard(boardId),
		client.listArchivedCardsWithPluginData(boardId),
	]);
	const open = cards.filter((c) => !c.closed);

	const rocks = open
		.filter((c) => c.idList === ROLLING_BIG_ROCKS_ID)
		.map((c) => {
			const idle = idleDays(c, nowMs);
			return {
				desc: c.desc.length > 200 ? `${c.desc.slice(0, 200)}…` : c.desc,
				due: c.due,
				id: c.id,
				idleDays: idle,
				labels: c.labels.map((l) => l.name).filter((n) => n.length > 0),
				name: c.name,
				stale: idle >= staleDays,
				url: c.url,
			};
		})
		.sort((a, b) => b.idleDays - a.idleDays);

	const horizons: Record<string, { count: number; medianIdleDays: number | null; oldest: { id: string; name: string; url: string; idleDays: number }[] }> = {};
	for (const alias of WEEKLY_REVIEW_COULD_LISTS) {
		const id = resolveList(alias);
		const onList = open.filter((c) => c.idList === id);
		const withIdle = onList.map((c) => ({ id: c.id, idleDays: idleDays(c, nowMs), name: c.name, url: c.url }));
		horizons[alias] = {
			count: onList.length,
			medianIdleDays: median(withIdle.map((c) => c.idleDays)),
			oldest: withIdle.sort((a, b) => b.idleDays - a.idleDays).slice(0, sample),
		};
	}

	const actionable = new Set<string>([...CONTEXT_LIST_ALIASES.map((a) => LIST_ALIASES[a]), LIST_ALIASES.waiting]);
	const areaCounts = new Map<string, number>();
	for (const c of open.filter((x) => actionable.has(x.idList))) {
		const names = c.labels.map((l) => l.name).filter((n) => n.length > 0 && !/clarify/i.test(n));
		if (!names.length) areaCounts.set("(no label)", (areaCounts.get("(no label)") ?? 0) + 1);
		for (const n of names) areaCounts.set(n, (areaCounts.get(n) ?? 0) + 1);
	}

	const tickMap = new Map<string, string[]>();
	for (const s of snoozedFromArchived(archived, nowMs)) {
		if (Date.parse(s.wakeUp) < nowMs + 30 * DAY_MS) continue;
		const month = s.wakeUp.slice(0, 7);
		const names = tickMap.get(month) ?? [];
		names.push(s.name.split("\n")[0]);
		tickMap.set(month, names);
	}

	return {
		areas: [...areaCounts.entries()].map(([label, n]) => ({ label, open: n })).sort((a, b) => b.open - a.open),
		asOf: new Date(nowMs).toISOString(),
		big_rocks: { count: rocks.length, rocks, stale: rocks.filter((r) => r.stale).length },
		horizons,
		questions: HORIZON_QUESTIONS,
		staleDays,
		ticklers: [...tickMap.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([month, names]) => ({ cards: names.slice(0, 10), count: names.length, month })),
	};
}

// ---- clarify_inbox -------------------------------------------------------------

/**
 * Pure: why a card title looks like a dictation or typing slip, or null.
 * Deliberately narrow — single-token titles only — so real one-word cards
 * ("Heartwood", "Måske") pass. Catches the "Lllmnstufio" shape.
 */
export function garbledReason(name: string): string | null {
	const t = name.trim();
	if (t.length < 3) return "title is under three characters";
	if (/\s/.test(t) || t.length < 6) return null;
	if (/(\p{L})\1\1/iu.test(t)) return "same letter three times in a row";
	const runs = t.toLowerCase().match(/[^aeiouyæøå\P{L}]+/gu) ?? [];
	if (runs.some((r) => r.length >= 5)) return "five or more consonants in a row";
	return null;
}

const STOPWORDS = new Set([
	"the", "and", "for", "with", "til", "med", "og", "at", "en", "et", "den", "det", "om", "på", "af", "fra", "der", "som", "about", "into", "from",
]);

function contentTokens(text: string): Set<string> {
	return new Set(tokens(text).filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

/** Pure: token overlap between two titles (Jaccard on content words). */
export function similarity(a: string, b: string): { score: number; shared: number } {
	const ta = contentTokens(a);
	const tb = contentTokens(b);
	if (!ta.size || !tb.size) return { score: 0, shared: 0 };
	let shared = 0;
	for (const t of ta) if (tb.has(t)) shared += 1;
	return { score: shared / (ta.size + tb.size - shared), shared };
}

const CONTEXT_RULES: { alias: string; words: string[]; phrases?: string[]; reason: string }[] = [
	{ alias: "@lene", reason: "mentions Lene", words: ["lene"] },
	{ alias: "@phone", reason: "a call", words: ["ring", "ringe", "call", "opkald", "telefon", "phone"] },
	{ alias: "waiting", phrases: ["venter på", "waiting for", "waiting on"], reason: "waiting on someone", words: ["afventer"] },
	{ alias: "@errands", phrases: ["pick up"], reason: "an errand", words: ["køb", "købe", "buy", "hent", "hente", "afhent", "apotek", "indkøb", "butik", "shop"] },
	{ alias: "@home", reason: "a home task", words: ["hjem", "hjemme", "home", "rengør", "vask", "clean", "garage", "haven"] },
];

/** A title that opens with a question word reads as a question even without "?". */
const QUESTION_START = new RegExp(`^${wordsRe(["hvorfor", "hvordan", "hvad", "hvem", "hvornår", "hvor", "why", "how", "what", "who", "when", "where"]).source}`, "iu");

/** Pure: the context a title most likely belongs in, with the reason. */
export function suggestContext(name: string): { list: string; reason: string } {
	const toks = new Set(tokens(name));
	const lower = name.toLowerCase();
	for (const rule of CONTEXT_RULES) {
		if (rule.words.some((w) => toks.has(w)) || rule.phrases?.some((p) => lower.includes(p))) {
			return { list: rule.alias, reason: rule.reason };
		}
	}
	if (/\?\s*$/.test(name) || QUESTION_START.test(name.trim())) {
		return { list: "someday", reason: "a question, not an action: answer it now (two-minute rule) or park it" };
	}
	return { list: "@computer", reason: "no call, errand or home cue: default context" };
}

/**
 * clarify_inbox — one row per inbox card: how old it is, a suggested context,
 * possible duplicates already elsewhere on the board, and flags (garbled
 * title, pasted email, question). Never writes and never touches labels — the
 * "Please Clarify and Organize" label is Dann's (or Butler's) to manage.
 */
export async function clarify_inbox(
	client: TrelloClient,
	input: { board?: string; limit?: number },
	nowMs = Date.now(),
): Promise<{
	inbox: number;
	cards: {
		id: string;
		name: string;
		url: string;
		ageDays: number;
		labels: string[];
		flags: string[];
		suggestion: { list: string; reason: string };
		possibleDuplicates: { id: string; name: string; list: string | null; url: string }[];
	}[];
}> {
	const boardId = await resolveBoardRef(client, input.board);
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
	const [lists, cards] = await Promise.all([client.listListsOnBoard(boardId), client.listCardsOnBoard(boardId)]);
	const inbox: TrelloList | undefined =
		lists.find((l) => l.id === LIST_ALIASES.inbox) ?? lists.find((l) => /^inbox\b/i.test(l.name.trim()));
	if (!inbox) throw new GuardError(`Board ${boardId} has no Inbox list.`);
	const listName = new Map(lists.map((l) => [l.id, l.name]));
	const open = cards.filter((c) => !c.closed);
	const inboxCards = open.filter((c) => c.idList === inbox.id);
	const others = open.filter((c) => c.idList !== inbox.id);

	return {
		cards: inboxCards.slice(0, limit).map((c) => {
			const flags: string[] = [];
			const garbled = garbledReason(c.name);
			if (garbled) flags.push(`garbled title? ${garbled}`);
			if (/^(from|fra|sent|sendt):/im.test(c.desc)) flags.push("description is a pasted email: pull the action out of it");
			const dupes = others
				.map((o) => ({ o, s: similarity(c.name, o.name) }))
				.filter(({ s }) => s.shared >= 2 && s.score >= 0.5)
				.sort((a, b) => b.s.score - a.s.score)
				.slice(0, 3)
				.map(({ o }) => ({ id: o.id, list: listAliasFor(o.idList) ?? listName.get(o.idList) ?? null, name: o.name, url: o.url }));
			if (dupes.length) flags.push("possible duplicate");
			return {
				ageDays: ageDaysFromId(c.id, nowMs),
				flags,
				id: c.id,
				labels: c.labels.map((l) => l.name).filter((n) => n.length > 0),
				name: c.name,
				possibleDuplicates: dupes,
				suggestion: garbled ? { list: "(delete or re-capture)", reason: "the title is not readable" } : suggestContext(c.name),
				url: c.url,
			};
		}),
		inbox: inboxCards.length,
	};
}

