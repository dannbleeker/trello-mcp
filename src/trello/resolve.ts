/**
 * File: src/trello/resolve.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-27
 * Version: 1.0.0
 * Description: Reference resolution for workspaces, boards and lists — the layer
 *              that makes the connector multi-workspace.
 *
 *              Before this, a board was reachable only by a hard-coded alias in
 *              constants.ts or by pasting its 24-char ID; adding a workspace to
 *              the Trello account meant editing and redeploying the Worker. Here
 *              a `board` argument may be an alias, an ID, a board URL, or the
 *              board's *name* — resolved live against the member's boards, and
 *              optionally narrowed to one workspace. Lists work the same way,
 *              resolved within their board.
 *
 *              Ambiguity is never guessed at: two boards called "Roadmap" in two
 *              workspaces produce a GuardError naming both, with the workspace
 *              each belongs to, so the caller can disambiguate.
 *
 *              Directory reads (boards, workspaces, a board's lists) are cached
 *              per client for DIRECTORY_TTL_MS. A TrelloClient lives as long as
 *              an MCP session, so the cache is deliberately time-bounded rather
 *              than session-lifetime: a workspace or board added mid-session
 *              becomes visible within a minute, without a reconnect.
 *
 * Change log:
 *   1.1.0 (2026-07-28) — Bug-hunt fixes. A board URL now canonicalises to the
 *                        24-char ID instead of resolving to the short link
 *                        (callers COMPARE the result against card.idBoard and
 *                        pass it to /search, where a short link matches nothing
 *                        and 400s). boardLists caches archived lists too, so
 *                        reopening a list by name is possible and no longer
 *                        depends on cache age. New assertListOnBoard: an alias
 *                        or ID given alongside an explicit `board` is checked
 *                        against it rather than silently winning.
 *   1.0.0 (2026-07-27) — Initial (v1.19.0 multi-workspace support).
 */

import type { TrelloBoard, TrelloClient, TrelloList, TrelloOrganization } from "./client";
import {
	BOARD_ALIASES,
	DEFAULT_BOARD,
	LIST_ALIASES,
	boardShortLinkFromUrl,
	isTrelloId,
	resolveBoard,
	resolveList,
} from "./constants";
import { GuardError } from "./guards";

/** How long a cached directory read stays fresh. */
export const DIRECTORY_TTL_MS = 60_000;

/** Most candidates named in an ambiguity / not-found message before eliding. */
const MAX_CANDIDATES_LISTED = 12;

interface Entry<T> {
	at: number;
	value: T;
}

interface DirectoryCache {
	boards?: Entry<TrelloBoard[]>;
	orgs?: Entry<TrelloOrganization[]>;
	lists: Map<string, Entry<TrelloList[]>>;
	/**
	 * Workspaces the member is NOT a member of but can see a board in — Trello
	 * hands those out on a board's idOrganization without listing them under
	 * /members/me/organizations. null caches "couldn't read it", so an
	 * unreadable workspace isn't refetched on every board summary.
	 */
	foreignOrgs: Map<string, Entry<TrelloOrganization | null>>;
}

/**
 * Cache keyed by client instance, so a client that goes away takes its cache
 * with it and tests get a clean slate per client.
 */
const caches = new WeakMap<TrelloClient, DirectoryCache>();

function cacheFor(client: TrelloClient): DirectoryCache {
	let c = caches.get(client);
	if (!c) {
		c = { lists: new Map(), foreignOrgs: new Map() };
		caches.set(client, c);
	}
	return c;
}

function fresh<T>(entry: Entry<T> | undefined, nowMs: number): T | null {
	if (!entry) return null;
	return nowMs - entry.at < DIRECTORY_TTL_MS ? entry.value : null;
}

/** Open boards the member belongs to. Cached; `force` bypasses and refills. */
export async function memberBoards(
	client: TrelloClient,
	opts: { force?: boolean } = {},
): Promise<TrelloBoard[]> {
	const cache = cacheFor(client);
	const now = Date.now();
	if (!opts.force) {
		const hit = fresh(cache.boards, now);
		if (hit) return hit;
	}
	const boards = (await client.listMyBoards()).filter((b) => !b.closed);
	cache.boards = { at: now, value: boards };
	return boards;
}

/** Workspaces the member belongs to. Cached; `force` bypasses and refills. */
export async function memberWorkspaces(
	client: TrelloClient,
	opts: { force?: boolean } = {},
): Promise<TrelloOrganization[]> {
	const cache = cacheFor(client);
	const now = Date.now();
	if (!opts.force) {
		const hit = fresh(cache.orgs, now);
		if (hit) return hit;
	}
	const orgs = await client.listMyOrganizations();
	cache.orgs = { at: now, value: orgs };
	return orgs;
}

/**
 * Every list on a board, archived ones included. Cached per board.
 *
 * The cache deliberately holds the unfiltered set: resolution drops archived
 * lists, but `archive_list({ closed: false })` has to find one *because* it is
 * archived. Caching the filtered set made reopening a list by name impossible
 * — and, worse, made it work or not depending on how warm the cache was.
 * v1.19.2.
 */
export async function boardLists(
	client: TrelloClient,
	boardId: string,
	opts: { force?: boolean } = {},
): Promise<TrelloList[]> {
	const cache = cacheFor(client);
	const now = Date.now();
	if (!opts.force) {
		const hit = fresh(cache.lists.get(boardId), now);
		if (hit) return hit;
	}
	const lists = await client.listListsOnBoard(boardId);
	cache.lists.set(boardId, { at: now, value: lists });
	return lists;
}

/** Resolution candidates on a board: open lists, or every list when the caller
 * is specifically after an archived one (reopening). */
async function listCandidates(
	client: TrelloClient,
	boardId: string,
	includeArchived: boolean,
): Promise<TrelloList[]> {
	const lists = await boardLists(client, boardId);
	return includeArchived ? lists : lists.filter((l) => !l.closed);
}

/**
 * Drop cached lists for one board (or all boards). Called by the tools that
 * create, rename, archive or move lists, so a name resolved right after a
 * rename doesn't hit a stale entry inside the TTL window.
 */
export function invalidateLists(client: TrelloClient, boardId?: string): void {
	const cache = caches.get(client);
	if (!cache) return;
	if (boardId) cache.lists.delete(boardId);
	else cache.lists.clear();
}

/** Drop every cached directory read for a client. Used by tests and create_board-ish flows. */
export function invalidateDirectory(client: TrelloClient): void {
	caches.delete(client);
}

/**
 * Three-tier case-insensitive name match: exact, then prefix, then substring.
 * The first tier with any hit decides — so an exact "Doing" wins over a board
 * that merely contains "Doing" in its name. Returns all hits from that tier so
 * the caller can raise a precise ambiguity error.
 */
export function matchByName<T>(items: T[], nameOf: (item: T) => string, query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const norm = items.map((item) => ({ item, name: nameOf(item).trim().toLowerCase() }));
	const exact = norm.filter((n) => n.name === q);
	if (exact.length) return exact.map((n) => n.item);
	const prefix = norm.filter((n) => n.name.startsWith(q));
	if (prefix.length) return prefix.map((n) => n.item);
	const substring = norm.filter((n) => n.name.includes(q));
	return substring.map((n) => n.item);
}

function elide(names: string[]): string {
	if (names.length <= MAX_CANDIDATES_LISTED) return names.join(", ");
	return `${names.slice(0, MAX_CANDIDATES_LISTED).join(", ")}, … (${names.length - MAX_CANDIDATES_LISTED} more)`;
}

/** "Board Name" (Workspace Name) — the label used in every resolver message. */
function boardLabel(board: TrelloBoard, orgs: Map<string, TrelloOrganization>): string {
	const org = board.idOrganization ? orgs.get(board.idOrganization) : undefined;
	return `"${board.name}" (${org ? org.displayName : "no workspace"}, ${board.id})`;
}

async function orgsById(client: TrelloClient): Promise<Map<string, TrelloOrganization>> {
	const orgs = await memberWorkspaces(client).catch(() => [] as TrelloOrganization[]);
	return new Map(orgs.map((o) => [o.id, o]));
}

/** Most one-off workspace lookups a single call will make. Bounds the fan-out
 * when an account can see boards in many foreign workspaces. */
const MAX_FOREIGN_ORG_LOOKUPS = 10;

/**
 * id → workspace for every workspace referenced by `boards`, including ones the
 * member isn't a member of (fetched individually, fail-soft and cached). Use
 * this wherever a board is being *shown*: an account collects boards shared
 * from other people's workspaces, and rendering those as a bare 24-char ID is
 * exactly the kind of thing that makes a multi-workspace listing unreadable.
 */
export async function workspacesForBoards(
	client: TrelloClient,
	boards: { idOrganization?: string | null }[],
): Promise<Map<string, TrelloOrganization>> {
	const known = await orgsById(client);
	const missing = [
		...new Set(
			boards
				.map((b) => b.idOrganization)
				.filter((id): id is string => Boolean(id) && !known.has(id as string)),
		),
	].slice(0, MAX_FOREIGN_ORG_LOOKUPS);
	if (!missing.length) return known;

	const cache = cacheFor(client);
	const now = Date.now();
	const fetched = await Promise.all(
		missing.map(async (id) => {
			const entry = cache.foreignOrgs.get(id);
			if (entry && now - entry.at < DIRECTORY_TTL_MS) return entry.value;
			try {
				const org = await client.getOrganization(id);
				cache.foreignOrgs.set(id, { at: now, value: org });
				return org;
			} catch {
				cache.foreignOrgs.set(id, { at: now, value: null });
				return null;
			}
		}),
	);
	for (const org of fetched) if (org) known.set(org.id, org);
	return known;
}

/**
 * Resolve a workspace reference — ID, short name ("frontlinetech"), or display
 * name ("Frontline Tech") — to the workspace itself. Throws a GuardError that
 * lists the member's workspaces when nothing matches.
 */
export async function resolveWorkspaceRef(
	client: TrelloClient,
	ref: string,
): Promise<TrelloOrganization> {
	const trimmed = ref.trim();
	if (!trimmed) throw new GuardError("workspace must be a non-empty string.");
	const workspaces = await memberWorkspaces(client);

	if (isTrelloId(trimmed)) {
		const byId = workspaces.find((w) => w.id === trimmed);
		if (byId) return byId;
		// Not one of the member's workspaces — ask Trello directly, so an ID
		// pasted from elsewhere still resolves (and 404s cleanly if bogus).
		return client.getOrganization(trimmed);
	}

	const byShortName = workspaces.find((w) => w.name.toLowerCase() === trimmed.toLowerCase());
	if (byShortName) return byShortName;

	const hits = matchByName(workspaces, (w) => w.displayName, trimmed);
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) {
		throw new GuardError(
			`Workspace "${ref}" is ambiguous — matches ${elide(hits.map((w) => `"${w.displayName}" (${w.name})`))}. Use the short name or the workspace ID.`,
		);
	}
	throw new GuardError(
		`No workspace matching "${ref}". Your workspaces: ${elide(workspaces.map((w) => `"${w.displayName}" (${w.name})`)) || "(none)"}. See list_workspaces.`,
	);
}

/**
 * Turn a board short link (from a pasted URL) into the canonical 24-char ID.
 *
 * Returning the short link itself is *almost* right — Trello accepts one
 * wherever a board ID goes — but resolveBoardRef's result is not always handed
 * straight back to Trello. `list_my_cards_assigned` compares it to a card's
 * `idBoard` (a short link matches nothing, so the filter silently returned zero
 * cards), `weekly_review_pack` compares it to the default board's ID (so the
 * dann-to-do URL was refused as "not dann-to-do"), and Trello's own /search
 * rejects a short link in `idBoards` with 400 Invalid objectId. So it is
 * canonicalised once, here.
 *
 * Costs nothing for a board the member belongs to: their board list is already
 * cached and carries the short link inside each `url`. v1.19.2.
 */
async function canonicaliseShortLink(client: TrelloClient, shortLink: string): Promise<string> {
	const boards = await memberBoards(client);
	const hit = boards.find((b) => boardShortLinkFromUrl(b.url) === shortLink);
	if (hit) return hit.id;
	// A board the member isn't on (public, or shared by link). Trello resolves
	// the short link for us; a bad one 404s here rather than silently going on
	// to produce an empty result set downstream.
	const board = await client.getBoard(shortLink);
	return board.id;
}

/**
 * Resolve a board reference to a 24-char board ID.
 *
 *   undefined / ""     → DEFAULT_BOARD (unchanged behavior)
 *   alias              → BOARD_ALIASES lookup
 *   24-char hex        → passed through untouched
 *   trello.com/b/… URL → short link, canonicalised to the 24-char ID
 *   anything else      → matched against board names the member can see,
 *                        optionally narrowed by `workspace`
 */
export async function resolveBoardRef(
	client: TrelloClient,
	ref?: string,
	opts: { workspace?: string } = {},
): Promise<string> {
	const trimmed = (ref ?? "").trim();

	// A workspace filter with no board ref can still be meaningful (one board in
	// the workspace), so resolve the workspace first when one was given.
	const workspace = opts.workspace ? await resolveWorkspaceRef(client, opts.workspace) : null;

	if (!trimmed) {
		if (!workspace) return resolveBoard(DEFAULT_BOARD);
		const inWorkspace = (await memberBoards(client)).filter(
			(b) => b.idOrganization === workspace.id,
		);
		if (inWorkspace.length === 1) return inWorkspace[0].id;
		throw new GuardError(
			inWorkspace.length === 0
				? `Workspace "${workspace.displayName}" has no boards you belong to.`
				: `Workspace "${workspace.displayName}" has ${inWorkspace.length} boards — name one with \`board\`: ${elide(inWorkspace.map((b) => `"${b.name}"`))}.`,
		);
	}

	if (trimmed in BOARD_ALIASES) return resolveBoard(trimmed);
	if (isTrelloId(trimmed)) return trimmed;

	const shortLink = boardShortLinkFromUrl(trimmed);
	if (shortLink) return canonicaliseShortLink(client, shortLink);

	const all = await memberBoards(client);
	const scoped = workspace ? all.filter((b) => b.idOrganization === workspace.id) : all;
	const orgs = await orgsById(client);
	const hits = matchByName(scoped, (b) => b.name, trimmed);

	if (hits.length === 1) return hits[0].id;
	if (hits.length > 1) {
		throw new GuardError(
			`Board "${ref}" is ambiguous — matches ${elide(hits.map((b) => boardLabel(b, orgs)))}. Pass the board ID, or narrow with \`workspace\`.`,
		);
	}

	const where = workspace ? ` in workspace "${workspace.displayName}"` : "";
	throw new GuardError(
		`No board matching "${ref}"${where}. Boards you belong to: ${elide(scoped.map((b) => boardLabel(b, orgs))) || "(none)"}. See list_boards.`,
	);
}

/**
 * Refuse when an explicit `board` and a list given by alias or ID disagree.
 *
 * An alias short-circuits name matching, so `create_card({ board: "TECH Retail
 * Decision Board", list: "inbox" })` used to put the card on dann-to-do —
 * silently, because "inbox" is an alias and the board argument was never
 * consulted. Passing a board is the caller asserting where the list lives, and
 * an assertion that can be wrong should be checked: one getList, and only when
 * both arguments were supplied. v1.19.2.
 */
async function assertListOnBoard(
	client: TrelloClient,
	listId: string,
	opts: { board?: string; workspace?: string },
	ref: string,
): Promise<void> {
	const boardId = await resolveBoardRef(client, opts.board, { workspace: opts.workspace });
	let list: TrelloList;
	try {
		list = await client.getList(listId);
	} catch {
		// Can't read the list — let the tool's own call produce the real error
		// rather than inventing one here.
		return;
	}
	if (list.idBoard === boardId) return;
	const orgs = await orgsById(client);
	const actual = (await memberBoards(client)).find((b) => b.id === list.idBoard);
	throw new GuardError(
		`List "${ref}" is on ${actual ? boardLabel(actual, orgs) : `board ${list.idBoard}`}, not on the board you named. Drop \`board\`, or pass a list that is on it.`,
	);
}

/**
 * Resolve a list reference to a 24-char list ID.
 *
 *   alias        → LIST_ALIASES lookup
 *   24-char hex  → passed through untouched
 *   name         → matched against the lists of `board` when one is given;
 *                  otherwise against every board the member belongs to, which
 *                  is what makes "Backlog" work on a brand-new workspace board
 *                  without first looking up its ID.
 *
 * A name that matches lists on two boards is an error naming both — the
 * connector never picks a board for you.
 *
 * `includeArchived` widens name matching to archived lists. Only reopening
 * wants that; every other caller would be able to write to a list that isn't
 * on the board any more.
 *
 * When `board` is given AND the ref was an alias or a raw ID, the two are
 * checked against each other rather than letting the alias win silently — see
 * assertListOnBoard.
 */
export async function resolveListRef(
	client: TrelloClient,
	ref: string,
	opts: { board?: string; workspace?: string; includeArchived?: boolean } = {},
): Promise<string> {
	const trimmed = (ref ?? "").trim();
	if (!trimmed) throw new GuardError("list must be a non-empty string.");
	const hasBoard = opts.board !== undefined && opts.board.trim() !== "";

	if (trimmed in LIST_ALIASES) {
		const id = resolveList(trimmed);
		if (hasBoard) await assertListOnBoard(client, id, opts, trimmed);
		return id;
	}
	if (isTrelloId(trimmed)) {
		if (hasBoard) await assertListOnBoard(client, trimmed, opts, trimmed);
		return trimmed;
	}

	// Board context given: resolve within that board only.
	if (hasBoard) {
		const boardId = await resolveBoardRef(client, opts.board, { workspace: opts.workspace });
		const lists = await listCandidates(client, boardId, opts.includeArchived ?? false);
		const hits = matchByName(lists, (l) => l.name, trimmed);
		if (hits.length === 1) return hits[0].id;
		if (hits.length > 1) {
			throw new GuardError(
				`List "${ref}" is ambiguous on that board — matches ${elide(hits.map((l) => `"${l.name}" (${l.id})`))}.`,
			);
		}
		throw new GuardError(
			`No list matching "${ref}" on that board. Lists: ${elide(lists.map((l) => `"${l.name}"`)) || "(none)"}. See list_lists.`,
		);
	}

	// No board context: scan every board the member belongs to (optionally
	// narrowed to a workspace). Cached, and a personal account has a handful of
	// boards — the cost is one round trip per board, once a minute at most.
	const workspace = opts.workspace ? await resolveWorkspaceRef(client, opts.workspace) : null;
	const boards = (await memberBoards(client)).filter(
		(b) => !workspace || b.idOrganization === workspace.id,
	);
	const perBoard = await Promise.all(
		boards.map(async (board) => {
			try {
				return {
					board,
					lists: await listCandidates(client, board.id, opts.includeArchived ?? false),
				};
			} catch {
				// A board we can see but can't read lists on must not fail the
				// whole resolution — it just contributes no candidates.
				return { board, lists: [] as TrelloList[] };
			}
		}),
	);

	const orgs = await orgsById(client);
	const hits: { board: TrelloBoard; list: TrelloList }[] = [];
	for (const { board, lists } of perBoard) {
		for (const list of matchByName(lists, (l) => l.name, trimmed)) {
			hits.push({ board, list });
		}
	}

	if (hits.length === 1) return hits[0].list.id;
	if (hits.length > 1) {
		throw new GuardError(
			`List "${ref}" is ambiguous across boards — matches ${elide(
				hits.map((h) => `"${h.list.name}" on ${boardLabel(h.board, orgs)}`),
			)}. Pass \`board\` (or \`workspace\`) to disambiguate, or use the list ID.`,
		);
	}
	throw new GuardError(
		`No list matching "${ref}" on any board you belong to${workspace ? ` in workspace "${workspace.displayName}"` : ""}. See list_lists.`,
	);
}

/**
 * The workspace a board belongs to, as a display-ready summary. Null for a
 * personal board (no workspace) and for a workspace the member can't read.
 */
export async function workspaceOfBoard(
	client: TrelloClient,
	board: TrelloBoard,
): Promise<{ id: string; name: string; displayName: string } | null> {
	if (!board.idOrganization) return null;
	const orgs = await orgsById(client);
	const org = orgs.get(board.idOrganization);
	return org
		? { id: org.id, name: org.name, displayName: org.displayName }
		: { id: board.idOrganization, name: board.idOrganization, displayName: board.idOrganization };
}
