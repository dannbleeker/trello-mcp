/**
 * File: scripts/verify-dashboard.mjs
 * Author: Dann Bleeker Pedersen
 * Created: 2026-08-05
 * Last Updated: 2026-08-05
 * Version: 1.0.0
 * Description: Renders src/dashboard/page.html in a real browser against stubbed
 *              API responses and the production security headers, then asserts
 *              the things only a browser can answer.
 *
 *              The vitest suite (test/dashboard-labels.test.ts,
 *              test/dashboard-usage.test.ts) evaluates the page's script in a
 *              stub DOM. That catches logic, but it cannot tell you whether the
 *              page RENDERS — the v1.21.0 Usage panel shipped without anything
 *              ever running it, and a ReferenceError there would have surfaced
 *              only as a silently missing section on the live dashboard.
 *
 *              What this adds on top of the unit tests:
 *                • the page actually renders, with no page errors
 *                • no CSP violations under the exact policy handler.ts sends —
 *                  a wrong directive breaks the dashboard silently
 *                • a hostile list name produces NO live DOM node. The unit test
 *                  asserts on the HTML string; this asserts the browser did not
 *                  build an <img> out of it, which is the thing that matters.
 *
 *              Deliberately NOT wired into CI: it needs a browser binary, and
 *              adding that to every PR run is a bigger call than a bug fix.
 *              Run it by hand when page.html changes.
 *
 *              Run: pnpm verify:dashboard
 *                   pnpm verify:dashboard --theme dark --out /tmp/dash.png
 *
 *              First time on a new machine: npx playwright install chromium
 *
 * Change log:
 *   1.0.0 (2026-08-05) — Initial. Extracted from the throwaway harness used to
 *                        verify the v1.21.0 Usage panel and the v1.21.3 CSP.
 */

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const THEME = flag("theme", "light");
const OUT = flag("out", "");
const PORT = Number(flag("port", "8099"));
const PAGE = readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8");

/**
 * The exact policy src/dashboard/handler.ts sends. Kept in sync by hand — a
 * mismatch here would make this script pass while the real page breaks, so the
 * script also asserts the two agree (see checkPolicyMatchesHandler).
 */
const CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"img-src 'self' data:; connect-src 'self'; manifest-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * A list name carrying an XSS payload. If escaping regresses, the browser
 * builds a real <img> from this and fires its onerror — which is exactly what
 * a string assertion in the unit tests cannot observe.
 */
const HOSTILE_LIST = '@Ops<img src=x onerror="window.__XSS__=true"> (WIP limit 3)';

const LISTS = [
	{ closed: false, id: "l-inbox", name: "Inbox" },
	{ closed: false, id: "l-computer", name: "@Computer (WIP limit 7)" },
	{ closed: false, id: "l-hostile", name: HOSTILE_LIST },
	{ closed: false, id: "l-waiting", name: "Waiting for…" },
	{ closed: false, id: "l-done", name: "Done-do" },
	{ closed: false, id: "l-rocks", name: "Rolling Big Rocks" },
];

const card = (id, name, idList) => ({
	dateLastActivity: new Date(Date.now() - 3 * 86_400_000).toISOString(),
	desc: "",
	due: null,
	dueComplete: false,
	id,
	idList,
	labels: [],
	name,
	url: `https://trello.com/c/${id}`,
});

const CARDS = [
	card("c1", "Draft the Q3 board review", "l-computer"),
	card("c2", "Waiting on legal sign-off", "l-waiting"),
	card("c3", "Clarify: conference invite", "l-inbox"),
	card("c4", "Ship usage tracking", "l-rocks"),
];

/** Mirrors the shape GET /api/usage returns (src/dashboard/api.ts). */
const USAGE = {
	days: 30,
	enabled: true,
	endpoints: [
		{ avgMs: 130, calls: 402, errors: 0, name: "GET /boards/{id}/cards" },
		{ avgMs: 88, calls: 288, errors: 4, name: "GET /cards/{id}" },
		{ avgMs: 140, calls: 12, errors: 0, name: "GET /boards/{id}/cards/closed" },
	],
	tools: [
		{ avgMs: 118, calls: 142, errors: 0, name: "list_cards" },
		{ avgMs: 1420, calls: 88, errors: 1, name: "weekly_review_pack" },
		{ avgMs: 187, calls: 31, errors: 9, name: "move_card" },
		{ avgMs: 90, calls: 1, errors: 1, name: "delete_label" },
	],
	totals: { distinctTools: 14, errors: 17, httpCalls: 1187, rateLimited: 3, toolCalls: 412 },
};

const ROUTES = {
	"/api/cards": { cards: CARDS, customFields: [], lists: LISTS },
	"/api/snoozed": { snoozed: [] },
	"/api/usage": USAGE,
};

const failures = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);

/**
 * The policy this script tests must be the policy the Worker sends. Compare
 * against handler.ts rather than trusting the copy above.
 */
function checkPolicyMatchesHandler() {
	const handler = readFileSync(new URL("../src/dashboard/handler.ts", import.meta.url), "utf8");
	for (const directive of CSP.split(";").map((d) => d.trim()).filter(Boolean)) {
		if (!handler.includes(directive)) {
			fail(`CSP drift: handler.ts does not contain "${directive}" — this script is testing a stale policy.`);
			return;
		}
	}
	ok("the tested CSP matches the one handler.ts sends");
}

/**
 * playwright resolves its own browser when installed via `npx playwright
 * install`. In sandboxes that pre-stage browsers under PLAYWRIGHT_BROWSERS_PATH
 * the build number often will not match this playwright version, so fall back
 * to whatever chromium is actually on disk there.
 */
async function launch() {
	try {
		return await chromium.launch();
	} catch (e) {
		const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
		const candidate = root && existsSync(root)
			? readdirSync(root)
					.filter((d) => d.startsWith("chromium") && !d.includes("headless"))
					.map((d) => join(root, d, "chrome-linux", "chrome"))
					.find((p) => existsSync(p))
			: undefined;
		if (!candidate) {
			console.error(
				`\nCould not launch Chromium: ${e instanceof Error ? e.message : e}\n` +
					`Install it once with:  npx playwright install chromium\n`,
			);
			process.exit(2);
		}
		return chromium.launch({ executablePath: candidate });
	}
}

const server = createServer((req, res) => {
	const path = req.url.split("?")[0];
	if (path === "/" || path === "/dashboard") {
		// Served with the production headers, so a CSP that breaks the page
		// breaks it here too.
		res.writeHead(200, {
			"Content-Security-Policy": CSP,
			"Content-Type": "text/html",
			"X-Frame-Options": "DENY",
		});
		return res.end(PAGE);
	}
	if (ROUTES[path]) {
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify(ROUTES[path]));
	}
	// The page requests /manifest.webmanifest and /icon.svg; a 404 on those is
	// expected here and must not be reported as a failure.
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "not stubbed" }));
});

await new Promise((r) => server.listen(PORT, r));
console.log(`\nverify:dashboard — rendering page.html (${THEME} theme) under the production CSP\n`);

const browser = await launch();
const ctx = await browser.newContext({
	colorScheme: THEME === "dark" ? "dark" : "light",
	deviceScaleFactor: 2,
	viewport: { height: 1400, width: 1100 },
});
const page = await ctx.newPage();

page.on("pageerror", (e) => fail(`uncaught page error: ${e.message}`));
page.on("console", (m) => {
	const text = m.text();
	if (/Content Security Policy|Refused to/i.test(text)) fail(`CSP violation: ${text}`);
	// 404s for the unstubbed PWA assets are expected noise.
	else if (m.type() === "error" && !text.includes("404")) fail(`console error: ${text}`);
});

try {
	checkPolicyMatchesHandler();

	await page.addInitScript(() => localStorage.setItem("dann_dash_usage_open", "1"));
	await page.goto(`http://127.0.0.1:${PORT}/dashboard`, { waitUntil: "networkidle" });

	// 1. The board rendered at all.
	await page.waitForSelector(".health", { timeout: 10_000 });
	ok("the board renders");

	// 2. The Usage panel populated — the section that shipped unrendered.
	const usageRows = await page.locator(".usg-row").count();
	if (usageRows === USAGE.tools.length) ok(`the Usage panel renders (${usageRows} rows)`);
	else fail(`Usage panel rendered ${usageRows} rows, expected ${USAGE.tools.length}`);

	// 3. THE XSS CHECK. A string assertion cannot see this: if escaping breaks,
	//    the browser builds a live <img> and fires onerror.
	const xssFired = await page.evaluate(() => Boolean(window.__XSS__));
	const injectedImgs = await page.locator("img").count();
	if (xssFired) fail("XSS: a hostile list name executed script in the page");
	else if (injectedImgs > 0) fail(`XSS: a hostile list name created ${injectedImgs} live <img> node(s)`);
	else ok("a hostile list name is inert — no node built, no script run");

	// 4. The escaped text is still displayed, i.e. escaping did not eat the name.
	const shown = await page.locator(".wip").filter({ hasText: "@Ops" }).count();
	if (shown > 0) ok("the escaped list name is still shown to the user");
	else fail("the hostile list name vanished from the health bar entirely");

	// 5. connect-src 'self' must not have blocked the page's own API calls.
	const cardsRendered = await page.locator(".card").count();
	if (cardsRendered > 0) ok(`same-origin /api/* calls succeeded under CSP (${cardsRendered} cards)`);
	else fail("no cards rendered — connect-src may be blocking the page's own API calls");

	if (OUT) {
		await page.screenshot({ fullPage: true, path: OUT });
		console.log(`\n  screenshot → ${OUT}`);
	}
} finally {
	await browser.close();
	server.close();
}

if (failures.length) {
	console.error(`\n✘ ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
	process.exit(1);
}
console.log("\n✓ dashboard verified\n");
