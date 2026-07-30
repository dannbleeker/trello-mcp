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

function loadPageScript(): { labelBadges: (c: { labels: unknown[] }) => string; labelHue: (c: string) => string } {
	const start = PAGE.indexOf("<script>") + "<script>".length;
	const script = PAGE.slice(start, PAGE.lastIndexOf("</script>"));
	const el = () => ({ innerHTML: "", value: "", disabled: false, onclick: null, classList: { add() {}, remove() {} }, style: {} });
	const document = { addEventListener() {}, getElementById: el, querySelectorAll: () => [], activeElement: null };
	const factory = new Function(
		"document",
		"fetch",
		"location",
		`${script}\nreturn { labelBadges: labelBadges, labelHue: labelHue };`,
	);
	return factory(document, () => Promise.reject(new Error("no network in tests")), { href: "" });
}

const { labelBadges, labelHue } = loadPageScript();

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
