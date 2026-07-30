// Label rendering on the dashboard page (src/dashboard/page.html).
//
// page.html is shipped as a static text module, so there is nothing to import.
// These tests read the file, evaluate its <script> block in a stub DOM, and
// call the real label functions — so the page's rendering is tested, not a
// re-implementation of it. `fetch` is stubbed to reject, which sends the page's
// init() straight down its error path and keeps evaluation side-effect-free.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
	ageBadge: (c: { dateLastActivity?: string }) => string;
	activityMs: (c: { dateLastActivity?: string }) => number;
};

function loadPageScript(): Page {
	const start = PAGE.indexOf("<script>") + "<script>".length;
	const script = PAGE.slice(start, PAGE.lastIndexOf("</script>"));
	const el = () => ({ innerHTML: "", value: "", disabled: false, onclick: null, classList: { add() {}, remove() {} }, style: {} });
	const document = { addEventListener() {}, getElementById: el, querySelectorAll: () => [], activeElement: null };
	const factory = new Function(
		"document",
		"fetch",
		"location",
		`${script}
		return {
			labelBadges: labelBadges, labelHue: labelHue, passesFilter: passesFilter,
			isPersonal: isPersonal, setFilter: setFilter, FILTER_LABELS: FILTER_LABELS,
			configureFromLists: configureFromLists, ageBadge: ageBadge, activityMs: activityMs,
			// CTX and friends are reassigned by configureFromLists, so hand back a
			// getter rather than the values captured at load time.
			layout: function(){ return { CTX, INBOX, WAITING, DONE, BIGROCKS, MOVE_TARGETS, OVERVIEW, LIST_NAMES }; },
		};`,
	);
	return factory(document, () => Promise.reject(new Error("no network in tests")), { href: "", search: "" });
}

const {
	labelBadges, labelHue, passesFilter, isPersonal, setFilter, FILTER_LABELS,
	configureFromLists, layout, ageBadge, activityMs,
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

describe("big-rock age badge", () => {
	const daysAgo = (n: number) => ({ dateLastActivity: new Date(Date.now() - n * 86400000).toISOString() });

	it("names the rot: months untouched, in red past a quarter", () => {
		// The live board has rocks last touched 5, 7 and 13 months ago.
		const h = ageBadge(daysAgo(400));
		expect(h).toContain("untouched 13 months");
		expect(h).toContain("age buried");
	});

	it("flags a month of drift more gently than a quarter", () => {
		expect(ageBadge(daysAgo(35))).toContain("age drifting");
		expect(ageBadge(daysAgo(35))).not.toContain("buried");
		expect(ageBadge(daysAgo(100))).toContain("age buried");
	});

	it("stays quiet for a rock touched recently", () => {
		expect(ageBadge(daysAgo(3))).toContain("untouched 3 days");
		expect(ageBadge(daysAgo(3))).not.toMatch(/drifting|buried/);
		expect(ageBadge(daysAgo(0))).toContain("touched today");
	});

	it("scales the unit: days, then weeks, then months", () => {
		expect(ageBadge(daysAgo(1))).toContain("1 day");
		expect(ageBadge(daysAgo(20))).toContain("2 weeks");
		expect(ageBadge(daysAgo(90))).toContain("3 months");
	});

	it("renders nothing, and sorts last, when the card has no activity date", () => {
		expect(ageBadge({})).toBe("");
		expect(activityMs({})).toBe(Infinity);
		expect(activityMs({ dateLastActivity: "not-a-date" })).toBe(Infinity);
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
