// Label rendering on the dashboard page (src/dashboard/page.html).
//
// page.html is shipped as a static text module, so there is nothing to import.
// These tests read the file, evaluate its <script> block in a stub DOM, and
// call the real label functions — so the page's rendering is tested, not a
// re-implementation of it. `fetch` is stubbed to reject, which sends the page's
// init() straight down its error path and keeps evaluation side-effect-free.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

const PAGE = readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8");

type Label = { id: string; name: string; color: string };

type Role = { id: string | null; name: string };
type Ctx = { id: string; name: string; wip: number | null };

type Page = {
	labelBadges: (c: { labels: unknown[] }) => string;
	labelHue: (c: string) => string;
	passesFilter: (c: { labels: unknown[] }) => boolean;
	isPersonal: (c: { labels: unknown[] }) => boolean;
	setFilter: (k: string) => void;
	FILTER_LABELS: { key: string; label: string }[];
	configureFromLists: (lists: unknown[]) => void;
	layout: () => {
		CTX: Ctx[];
		INBOX: Role;
		WAITING: Role;
		DONE: Role;
		BIGROCKS: Role;
		MOVE_TARGETS: Role[];
		OVERVIEW: Role[];
		LIST_NAMES: Record<string, string>;
	};
	ageBadge: (c: { dateLastActivity?: string }, kind: string) => string;
	activityMs: (c: { dateLastActivity?: string }) => number;
	render: () => void;
	contentHtml: () => string;
	queueRead: () => string[];
	queueWrite: (q: string[]) => void;
	flushCaptureQueue: () => Promise<number>;
	onCapture: () => Promise<void>;
	setOnline: (v: boolean) => void;
	setCaptureInput: (v: string) => void;
	captureCalls: () => string[];
	failCaptures: (v: boolean) => void;
};

function loadPageScript(): Page {
	const start = PAGE.indexOf("<script>") + "<script>".length;
	const script = PAGE.slice(start, PAGE.lastIndexOf("</script>"));

	// A stub DOM just rich enough for the page's top-level code to run. The
	// capture input is a single shared node so a test can set its value and
	// call the page's real onCapture().
	const capInput = { innerHTML: "", value: "", disabled: false, onclick: null, classList: { add() {}, remove() {} }, style: {} };
	// #content is shared (not a fresh object per lookup) so a test can call the
	// page's real render() and then read what it actually wrote — which is the
	// only way to assert on escaping in the rendered output rather than on a
	// re-implementation of it.
	const content = { innerHTML: "", value: "", disabled: false, onclick: null, classList: { add() {}, remove() {} }, style: {} };
	const el = (id?: string) =>
		id === "capInput"
			? capInput
			: id === "content"
				? content
				: { innerHTML: "", value: "", disabled: false, onclick: null, classList: { add() {}, remove() {} }, style: {} };
	const document = { addEventListener() {}, getElementById: el, querySelectorAll: () => [], activeElement: null };
	const window = { addEventListener() {} };
	const store = new Map<string, string>();
	const localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k) : null),
		setItem: (k: string, v: string) => void store.set(k, v),
	};
	const navigator = { onLine: true };

	// Records every /api/capture body so a test can assert what actually went
	// out; `fail` simulates the network being down mid-flush.
	const captureCalls: string[] = [];
	let fail = false;
	const fetchStub = (url: string, opts?: { body?: string }) => {
		if (String(url).startsWith("/api/capture")) {
			if (fail) return Promise.reject(new TypeError("offline"));
			captureCalls.push(JSON.parse(opts?.body ?? "{}").name);
			return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ card: {} }) });
		}
		return Promise.reject(new Error("no network in tests"));
	};

	const factory = new Function(
		"document",
		"fetch",
		"location",
		"window",
		"localStorage",
		"navigator",
		`${script}
		return {
			labelBadges: labelBadges, labelHue: labelHue, passesFilter: passesFilter,
			isPersonal: isPersonal, setFilter: setFilter, FILTER_LABELS: FILTER_LABELS,
			configureFromLists: configureFromLists, ageBadge: ageBadge, activityMs: activityMs,
			render: render,
			queueRead: queueRead, queueWrite: queueWrite,
			flushCaptureQueue: flushCaptureQueue, onCapture: onCapture,
			// CTX and friends are reassigned by configureFromLists, so hand back a
			// getter rather than the values captured at load time.
			layout: function(){ return { CTX, INBOX, WAITING, DONE, BIGROCKS, MOVE_TARGETS, OVERVIEW, LIST_NAMES }; },
		};`,
	);
	const page = factory(document, fetchStub, { href: "", search: "" }, window, localStorage, navigator);
	return Object.assign(page, {
		setOnline: (v: boolean) => { navigator.onLine = v; },
		setCaptureInput: (v: string) => { capInput.value = v; },
		captureCalls: () => captureCalls.slice(),
		failCaptures: (v: boolean) => { fail = v; },
		contentHtml: () => content.innerHTML,
	});
}

const {
	labelBadges, labelHue, passesFilter, isPersonal, setFilter, FILTER_LABELS,
	configureFromLists, layout, ageBadge, activityMs, render, contentHtml,
	queueRead, queueWrite, flushCaptureQueue, onCapture,
	setOnline, setCaptureInput, captureCalls, failCaptures,
} = loadPageScript();

/** Badge text between the pill's own tags, in render order. */
function badgeTexts(html: string): string[] {
	return [...html.matchAll(/<span class="badge [^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
}

function label(name: string, color: string, id = "l"): Label {
	return { color, id, name };
}

describe("dashboard label badges", () => {
	it("renders ALL of a card's labels, not just the three hardcoded names", () => {
		// The bug: badgesHtml() tested for exactly BESTSELLER / DBP Invest /
		// Please Clarify and Organize, so a card carrying anything else showed
		// one badge (or none) while Trello showed several.
		const html = labelBadges({
			labels: [label("BESTSELLER", "black", "l1"), label("SSF", "green", "l2"), label("Frontline Tech", "purple", "l3")],
		});
		expect(badgeTexts(html)).toEqual(["BESTSELLER", "SSF", "Frontline Tech"]);
	});

	it("colours an unknown label from its Trello hue", () => {
		expect(labelBadges({ labels: [label("SSF", "green")] })).toContain('class="badge lbl-green"');
	});

	it("collapses the _light / _dark palette variants onto their base hue", () => {
		expect(labelHue("green_dark")).toBe("green");
		expect(labelHue("green_light")).toBe("green");
		expect(labelHue("green")).toBe("green");
	});

	it("falls back to a neutral pill for a colourless or unrecognised label", () => {
		expect(labelHue("")).toBe("none");
		expect(labelHue(undefined as unknown as string)).toBe("none");
		expect(labelHue("chartreuse")).toBe("none");
		expect(labelBadges({ labels: [label("NoColour", "")] })).toContain('class="badge lbl-none"');
	});

	it("keeps the hand-tuned look and short name for the three original labels", () => {
		const html = labelBadges({
			labels: [
				label("BESTSELLER", "black", "l1"),
				label("DBP Invest", "blue", "l2"),
				label("Please Clarify and Organize", "red", "l3"),
			],
		});
		expect(badgeTexts(html)).toEqual(["BESTSELLER", "DBP Invest", "clarify"]);
		expect(html).toContain('class="badge bestseller"');
		expect(html).toContain('class="badge invest"');
		expect(html).toContain('class="badge clarify"');
	});

	it("renders a colour-only label rather than dropping it", () => {
		const html = labelBadges({ labels: [label("", "sky")] });
		expect(html).toContain('class="badge lbl-sky"');
		expect(html).toContain('title="sky"');
		expect(badgeTexts(html)).toEqual(["·"]);
	});

	it("escapes a label name in both the badge text and its title", () => {
		const html = labelBadges({ labels: [label('<img src=x onerror="alert(1)">', "red")] });
		expect(html).not.toContain("<img src=x");
		expect(html.match(/&lt;img src=x/g)).toHaveLength(2); // badge text + title
	});

	it("tolerates a missing labels array and plain-string labels", () => {
		expect(labelBadges({} as { labels: unknown[] })).toBe("");
		expect(badgeTexts(labelBadges({ labels: ["SSF"] }))).toEqual(["SSF"]);
	});

	it("has a CSS class for every Trello palette hue it can emit", () => {
		// Drift guard: labelHue() may only return hues the stylesheet can paint,
		// otherwise the badge renders as an unstyled pill.
		for (const hue of ["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black", "none"]) {
			expect(PAGE).toContain(`.badge.lbl-${hue}`);
			if (hue !== "none") expect(labelHue(hue)).toBe(hue);
		}
	});
});

describe("dashboard filter chips", () => {
	const bestseller = { labels: [label("BESTSELLER", "black")] };
	const invest = { labels: [label("DBP Invest", "blue")] };
	const ssf = { labels: [label("SSF", "green")] };
	const both = { labels: [label("BESTSELLER", "black", "l1"), label("SSF", "green", "l2")] };
	const plain = { labels: [] };

	it("offers an SSF chip alongside BESTSELLER and DBP Invest", () => {
		expect(FILTER_LABELS.map((f) => f.key)).toEqual(["bestseller", "invest", "ssf"]);
		expect(FILTER_LABELS.map((f) => f.label)).toEqual(["BESTSELLER", "DBP Invest", "SSF"]);
	});

	it("SSF selects exactly the cards carrying the SSF label", () => {
		setFilter("ssf");
		expect([bestseller, invest, ssf, both, plain].map(passesFilter)).toEqual([false, false, true, true, false]);
	});

	it("SSF cards no longer fall under Personal", () => {
		// Before the chip existed, Personal meant "not BESTSELLER and not DBP
		// Invest", which swept every SSF card into it.
		expect(isPersonal(ssf)).toBe(false);
		expect(isPersonal(plain)).toBe(true);
		setFilter("personal");
		expect([bestseller, invest, ssf, both, plain].map(passesFilter)).toEqual([false, false, false, false, true]);
	});

	it("a card in two spheres counts under both chips", () => {
		setFilter("bestseller");
		expect(passesFilter(both)).toBe(true);
		setFilter("ssf");
		expect(passesFilter(both)).toBe(true);
	});

	it("All shows everything, and an unknown persisted filter falls back to it", () => {
		setFilter("all");
		expect([bestseller, invest, ssf, both, plain].every(passesFilter)).toBe(true);
		setFilter("a-chip-from-an-older-build");
		expect([bestseller, invest, ssf, both, plain].every(passesFilter)).toBe(true);
		setFilter("all");
	});

	it("every chip is reachable — each has a filter branch that selects something", () => {
		// Drift guard: a chip whose key has no branch in passesFilter() renders
		// as a dead control that silently shows the whole board.
		const cards = [bestseller, invest, ssf, plain];
		for (const key of ["bestseller", "invest", "ssf", "personal"]) {
			setFilter(key);
			const shown = cards.filter(passesFilter);
			expect(shown).toHaveLength(1); // selective, not a pass-through
		}
		setFilter("all");
	});
});

describe("dashboard layout derived from the board's lists", () => {
	// The real board, as /api/cards returns it — including every list the
	// dashboard must keep NOT showing.
	const BOARD = [
		{ id: "l-computer", name: "@Computer (WIP limit 7)", closed: false },
		{ id: "l-home", name: "@Home (WIP limit 5)", closed: false },
		{ id: "l-phone", name: "@Phone (WIP limit 5)", closed: false },
		{ id: "l-errands", name: "@Errands", closed: false },
		{ id: "l-lene", name: "@Lene", closed: false },
		{ id: "l-waiting", name: "Waiting for...", closed: false },
		{ id: "l-done", name: "Done-do", closed: false },
		{ id: "l-inbox", name: "Inbox", closed: false },
		{ id: "l-could-personal", name: "Could-do (Personal)", closed: false },
		{ id: "l-could-invest", name: "Could-do (DBP Invest)", closed: false },
		{ id: "l-could-ssf", name: "Could-do (SSF)", closed: false },
		{ id: "l-could-bs", name: "Could-do (BESTSELLER)", closed: false },
		{ id: "l-rocks", name: "Rolling Big Rocks", closed: false },
		{ id: "l-someday", name: "Someday maybe", closed: false },
		{ id: "l-repeater", name: "Repeater Cards", closed: false },
		{ id: "l-butler", name: "Butler", closed: false },
		{ id: "l-behind", name: "Behind the scenes", closed: false },
	];

	it("derives the same five contexts the page used to hardcode, in board order", () => {
		configureFromLists(BOARD);
		expect(layout().CTX.map((l) => l.name)).toEqual(["@Computer", "@Home", "@Phone", "@Errands", "@Lene"]);
	});

	it("reads WIP limits off the list name instead of a hardcoded number", () => {
		configureFromLists(BOARD);
		expect(layout().CTX.map((l) => l.wip)).toEqual([7, 5, 5, null, null]);
	});

	it("a WIP limit changed in Trello reaches the dashboard with no redeploy", () => {
		configureFromLists([{ id: "l-computer", name: "@Computer (WIP limit 12)", closed: false }]);
		expect(layout().CTX[0]).toMatchObject({ name: "@Computer", wip: 12 });
	});

	it("keeps every currently-excluded list excluded", () => {
		// The whole risk of deriving the layout is that it turns into "show
		// everything". These lists must stay off the dashboard.
		configureFromLists(BOARD);
		const { CTX, OVERVIEW, MOVE_TARGETS, LIST_NAMES } = layout();
		const shown = new Set([
			...CTX.map((l) => l.id),
			...OVERVIEW.map((l) => l.id),
			...MOVE_TARGETS.map((l) => l.id),
			...Object.keys(LIST_NAMES),
		]);
		for (const id of [
			"l-could-personal", "l-could-invest", "l-could-ssf", "l-could-bs",
			"l-someday", "l-repeater", "l-butler", "l-behind",
		]) {
			expect(shown.has(id)).toBe(false);
		}
	});

	it("resolves the four named roles, tolerating the board's '...' spelling", () => {
		configureFromLists(BOARD);
		const { INBOX, WAITING, DONE, BIGROCKS } = layout();
		expect(INBOX.id).toBe("l-inbox");
		expect(WAITING.id).toBe("l-waiting"); // board says "Waiting for...", page shows "Waiting for…"
		expect(DONE.id).toBe("l-done");
		expect(BIGROCKS.id).toBe("l-rocks");
	});

	it("Done and Rolling Big Rocks are not move targets", () => {
		// ✓ Done owns the Done move; big rocks are read-only server-side.
		configureFromLists(BOARD);
		const ids = layout().MOVE_TARGETS.map((l) => l.id);
		expect(ids).toEqual(["l-computer", "l-home", "l-phone", "l-errands", "l-lene", "l-waiting"]);
	});

	it("skips archived lists", () => {
		configureFromLists([...BOARD, { id: "l-office", name: "@Office (WIP limit 5)", closed: true }]);
		expect(layout().CTX.map((l) => l.id)).not.toContain("l-office");
	});

	it("a retired role list resolves to a null id rather than throwing", () => {
		// cardsIn(null) is empty, so the zone renders as clear.
		configureFromLists([{ id: "l-computer", name: "@Computer", closed: false }]);
		const { INBOX, WAITING, OVERVIEW } = layout();
		expect(INBOX.id).toBeNull();
		expect(WAITING.id).toBeNull();
		expect(OVERVIEW.map((l) => l.id)).toEqual(["l-computer"]); // no phantom columns
	});

	it("a board with no @contexts yields none rather than inventing them", () => {
		configureFromLists([{ id: "z1", name: "Backlog", closed: false }, { id: "z2", name: "Discussion", closed: false }]);
		expect(layout().CTX).toEqual([]);
	});

	it("tolerates a missing or malformed lists payload", () => {
		expect(() => configureFromLists([])).not.toThrow();
		expect(() => configureFromLists(undefined as unknown as unknown[])).not.toThrow();
		expect(() => configureFromLists([null, { name: null }] as unknown[])).not.toThrow();
		configureFromLists(BOARD); // restore for any later test
	});
});

describe("card age badge", () => {
	const daysAgo = (n: number) => ({ dateLastActivity: new Date(Date.now() - n * 86400000).toISOString() });

	it("names the rot: months untouched, in red", () => {
		// The live board has rocks last touched 5, 7 and 13 months ago.
		const h = ageBadge(daysAgo(400), "rock");
		expect(h).toContain("untouched 13 months");
		expect(h).toContain("age buried");
	});

	it("grades big rocks by the quarter — they are quarterly goals", () => {
		// Rolling a rock over is fine; not looking at it for a whole quarter is
		// the amber, and a month past that is the alarm.
		expect(ageBadge(daysAgo(60), "rock")).not.toMatch(/drifting|buried/);
		expect(ageBadge(daysAgo(89), "rock")).not.toMatch(/drifting|buried/);
		expect(ageBadge(daysAgo(90), "rock")).toContain("age drifting");
		expect(ageBadge(daysAgo(119), "rock")).toContain("age drifting");
		expect(ageBadge(daysAgo(120), "rock")).toContain("age buried");
	});

	it("big rocks always show their age — it is the zone's only signal", () => {
		expect(ageBadge(daysAgo(3), "rock")).toContain("untouched 3 days");
		expect(ageBadge(daysAgo(3), "rock")).not.toMatch(/drifting|buried/);
		expect(ageBadge(daysAgo(0), "rock")).toContain("touched today");
	});

	it("every other zone stays silent until it has something to say", () => {
		// A healthy board shows no age badges at all outside big rocks.
		for (const kind of ["next", "waiting", "inbox"]) {
			expect(ageBadge(daysAgo(0), kind)).toBe("");
			expect(ageBadge(daysAgo(6), kind)).toBe("");
		}
	});

	it("next actions tolerate one weekly review, not four", () => {
		expect(ageBadge(daysAgo(13), "next")).toBe(""); // still within a review cycle
		expect(ageBadge(daysAgo(14), "next")).toContain("age drifting");
		expect(ageBadge(daysAgo(30), "next")).toContain("age buried");
	});

	it("waiting-for wants a chase after ten days", () => {
		expect(ageBadge(daysAgo(9), "waiting")).toBe("");
		expect(ageBadge(daysAgo(10), "waiting")).toContain("age drifting");
		expect(ageBadge(daysAgo(21), "waiting")).toContain("age buried");
	});

	it("an inbox item uncaptured for a week means Get Clear isn't happening", () => {
		expect(ageBadge(daysAgo(6), "inbox")).toBe("");
		expect(ageBadge(daysAgo(7), "inbox")).toContain("age drifting");
		expect(ageBadge(daysAgo(21), "inbox")).toContain("age buried");
	});

	it("the same age is graded very differently by zone", () => {
		// 30 days: rot for a next action, a chase long overdue for a waiting-for
		// item, and unremarkable for a quarterly goal.
		expect(ageBadge(daysAgo(30), "next")).toContain("buried");
		expect(ageBadge(daysAgo(30), "waiting")).toContain("buried");
		expect(ageBadge(daysAgo(30), "rock")).not.toMatch(/drifting|buried/);
	});

	it("scales the unit: days, then weeks, then months", () => {
		expect(ageBadge(daysAgo(1), "rock")).toContain("1 day");
		expect(ageBadge(daysAgo(20), "rock")).toContain("2 weeks");
		expect(ageBadge(daysAgo(90), "rock")).toContain("3 months");
	});

	it("renders nothing for an unknown zone, or a card with no activity date", () => {
		expect(ageBadge(daysAgo(400), "not-a-zone")).toBe("");
		expect(ageBadge({}, "rock")).toBe("");
		expect(activityMs({})).toBe(Infinity);
		expect(activityMs({ dateLastActivity: "not-a-date" })).toBe(Infinity);
	});
});

describe("offline capture queue", () => {
	beforeEach(() => {
		queueWrite([]);
		setOnline(true);
		failCaptures(false);
		setCaptureInput("");
	});

	it("queues a capture made while offline instead of losing the thought", async () => {
		setOnline(false);
		failCaptures(true);
		setCaptureInput("idea from the plane");
		await onCapture();
		expect(queueRead()).toEqual(["idea from the plane"]);
	});

	it("does NOT queue a failure that happened while online", async () => {
		// The request may have reached Trello; re-sending would create a silent
		// duplicate, and /api/capture has no idempotency key to prevent it.
		setOnline(true);
		failCaptures(true);
		setCaptureInput("might have landed");
		await onCapture();
		expect(queueRead()).toEqual([]);
	});

	it("flushes oldest-first when the network returns", async () => {
		queueWrite(["first", "second", "third"]);
		const before = captureCalls().length;
		expect(await flushCaptureQueue()).toBe(3);
		expect(captureCalls().slice(before)).toEqual(["first", "second", "third"]);
		expect(queueRead()).toEqual([]);
	});

	it("stops at the first failure and keeps the rest of the queue intact", async () => {
		queueWrite(["kept-a", "kept-b"]);
		failCaptures(true);
		expect(await flushCaptureQueue()).toBe(0);
		expect(queueRead()).toEqual(["kept-a", "kept-b"]);
	});

	it("is a no-op on an empty queue", async () => {
		expect(await flushCaptureQueue()).toBe(0);
	});

	it("survives unreadable queue storage", () => {
		queueWrite("not json" as unknown as string[]);
		expect(() => queueRead()).not.toThrow();
	});
});

describe("filter chip drift guard", () => {
	const bestseller = { labels: [label("BESTSELLER", "black")] };
	const invest = { labels: [label("DBP Invest", "blue")] };
	const ssf = { labels: [label("SSF", "green")] };
	const plain = { labels: [] };

	it("every chip is reachable — each has a filter branch that selects something", () => {
		// Drift guard: a chip whose key has no branch in passesFilter() renders
		// as a dead control that silently shows the whole board.
		const cards = [bestseller, invest, ssf, plain];
		for (const key of ["bestseller", "invest", "ssf", "personal"]) {
			setFilter(key);
			const shown = cards.filter(passesFilter);
			expect(shown).toHaveLength(1); // selective, not a pass-through
		}
		setFilter("all");
	});
});

describe("escaping of server-derived strings in the rendered page", () => {
	// The health-bar WIP row interpolated Trello list names into innerHTML raw
	// (v1.21.0 and earlier) — the only unescaped server string on the page. A
	// board member renaming a list to an <img onerror=...> payload got script
	// execution in Dann's authenticated session, with access to /api/*.
	//
	// These drive the page's real render() and read the real #content, so they
	// pin the rendered bytes rather than a re-implementation of the escaping.
	const HOSTILE = '@Ops<img src=x onerror=alert(1)> (WIP limit 3)';

	function renderWithHostileList(): string {
		configureFromLists([
			{ closed: false, id: "l-hostile", name: HOSTILE },
			{ closed: false, id: "l-inbox", name: "Inbox" },
			{ closed: false, id: "l-waiting", name: "Waiting for..." },
		]);
		render();
		return contentHtml();
	}

	it("never emits a raw tag from a list name", () => {
		const html = renderWithHostileList();
		// Fails on pre-v1.21.3 code: the WIP row emitted this verbatim.
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("onerror=alert(1)>");
	});

	it("escapes the list name in every place it is rendered", () => {
		const html = renderWithHostileList();
		// WIP row, cards-per-list overview pill, and the column head all render
		// the same name — each must be escaped, not just the one that was fixed.
		const escaped = html.match(/&lt;img src=x/g) ?? [];
		expect(escaped.length).toBeGreaterThanOrEqual(2);
	});

	it("leaves the numeric WIP count unescaped", () => {
		// esc() is string-only — esc(0) returns "" — so the counts must stay raw.
		// This is what stops an over-eager "escape everything" fix.
		const html = renderWithHostileList();
		expect(html).toMatch(/<\/b> \d+\/3/);
	});
});
