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

type Page = {
	labelBadges: (c: { labels: unknown[] }) => string;
	labelHue: (c: string) => string;
	passesFilter: (c: { labels: unknown[] }) => boolean;
	isPersonal: (c: { labels: unknown[] }) => boolean;
	setFilter: (k: string) => void;
	FILTER_LABELS: { key: string; label: string }[];
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
		};`,
	);
	return factory(document, () => Promise.reject(new Error("no network in tests")), { href: "" });
}

const { labelBadges, labelHue, passesFilter, isPersonal, setFilter, FILTER_LABELS } = loadPageScript();

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
