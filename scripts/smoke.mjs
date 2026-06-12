/**
 * File: scripts/smoke.mjs
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: Lightweight smoke test against real Trello using direct fetch.
 *              Verifies (a) credentials work, (b) the list/board IDs hard-coded
 *              in src/trello/constants.ts match reality, (c) the basic
 *              create/move/archive round-trip Claude will exercise via the
 *              connector works end-to-end.
 *
 *              Reads creds from ~/.claude/.mcp.json (same source as the local
 *              Python MCP) — no .env shenanigans.
 *
 *              Run: node scripts/smoke.mjs
 *
 * Change log:
 *   1.0.0 (2026-06-12) — Initial.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- Constants mirrored from src/trello/constants.ts ----
// (kept here as JS literals so this script has no TypeScript dependency)

const BOARD = {
	"dann-to-do": "58cbce31043f1a89cfc6b42c",
	zoo: "64ff6c30bf9776f75b04e3fa",
};

const LIST = {
	inbox: "59bd69c743b67aa0d621b3a9",
	"@computer": "59be51ab95ff1052eac74429",
	"@home": "59be516a18d71ddd80868e9d",
	"meeting-backlog": "64ff6c42e3007b77b033504c",
	"meeting-actions": "68427e948a34e68a8ec183aa",
};

const FORBIDDEN_LIST_BUTLER = "59be61509a1e3922fb72ddf7";
const READ_ONLY_LIST_BIG_ROCKS = "5b6189409662065780670709";

// ---- Setup ----

// Prefer env vars (TRELLO_KEY / TRELLO_TOKEN), fall back to legacy ~/.claude/.mcp.json
// where the retired local Python MCP used to keep the same credentials.
let KEY = process.env.TRELLO_KEY ?? process.env.TRELLO_API_KEY;
let TOKEN = process.env.TRELLO_TOKEN;
if (!KEY || !TOKEN) {
	const cfgPath = join(homedir(), ".claude", ".mcp.json");
	try {
		const text = readFileSync(cfgPath, "utf8").trim();
		if (text) {
			const env = JSON.parse(text)?.mcpServers?.trello?.env;
			KEY ??= env?.TRELLO_API_KEY;
			TOKEN ??= env?.TRELLO_TOKEN;
		}
	} catch {
		/* fall through to error below */
	}
}
if (!KEY || !TOKEN) {
	console.error("Set TRELLO_KEY and TRELLO_TOKEN env vars (or restore ~/.claude/.mcp.json).");
	process.exit(1);
}

const BASE = "https://api.trello.com/1";

async function trello(method, path, params = {}) {
	const url = new URL(`${BASE}${path}`);
	url.searchParams.set("key", KEY);
	url.searchParams.set("token", TOKEN);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) url.searchParams.set(k, String(v));
	}
	const r = await fetch(url, { method, headers: { Accept: "application/json" } });
	if (!r.ok) {
		const body = await r.text();
		throw new Error(`Trello ${r.status} on ${method} ${path}: ${body.slice(0, 200)}`);
	}
	const ct = r.headers.get("content-type") ?? "";
	return ct.includes("application/json") ? r.json() : null;
}

// ---- Tests ----

let passed = 0, failed = 0;
const created = [];

async function step(name, fn) {
	const t0 = Date.now();
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}  (${Date.now() - t0}ms)`);
	} catch (e) {
		failed++;
		console.log(`  FAIL ${name}  (${Date.now() - t0}ms)  ${e.message}`);
	}
}

async function main() {
	console.log("=== Trello connector smoke test ===\n");

	// 1. Credentials work
	await step("auth: list /members/me/boards", async () => {
		const boards = await trello("GET", "/members/me/boards", {
			fields: "name,closed",
			filter: "open",
		});
		if (!Array.isArray(boards) || boards.length < 1) throw new Error("no boards");
	});

	// 2. Hard-coded board IDs match reality
	console.log("\nBoard ID validation:");
	for (const [alias, id] of Object.entries(BOARD)) {
		await step(`board ${alias} (${id}) resolves`, async () => {
			const b = await trello("GET", `/boards/${id}`, { fields: "name,closed" });
			if (b.closed) throw new Error(`board "${alias}" is closed`);
		});
	}

	// 3. Hard-coded list IDs match reality, attached to the expected board
	console.log("\nList ID validation:");
	for (const [alias, id] of Object.entries(LIST)) {
		await step(`list ${alias} (${id}) resolves`, async () => {
			const l = await trello("GET", `/lists/${id}`, { fields: "name,idBoard,closed" });
			if (l.closed) throw new Error(`list "${alias}" is closed`);
		});
	}

	// 4. Forbidden + read-only lists exist
	console.log("\nGuard target validation:");
	await step("Butler list exists (FORBIDDEN target)", async () => {
		const l = await trello("GET", `/lists/${FORBIDDEN_LIST_BUTLER}`, { fields: "name" });
		if (!l.name?.toLowerCase().includes("butler")) {
			throw new Error(`expected "Butler" in name, got "${l.name}"`);
		}
	});
	await step("Rolling Big Rocks exists (READ_ONLY target)", async () => {
		const l = await trello("GET", `/lists/${READ_ONLY_LIST_BIG_ROCKS}`, { fields: "name" });
		if (!l.name?.toLowerCase().includes("rolling")) {
			throw new Error(`expected "Rolling" in name, got "${l.name}"`);
		}
	});

	// 5. End-to-end round-trip on a [MCP-TEST] card
	console.log("\nEnd-to-end round-trip:");
	let cardId = "";
	await step("create [MCP-TEST] card on @computer", async () => {
		const c = await trello("POST", "/cards", {
			idList: LIST["@computer"],
			name: "[MCP-TEST] smoke test card",
			desc: "Will be archived on completion.",
		});
		cardId = c.id;
		created.push(cardId);
	});
	await step("move to @home", async () => {
		const c = await trello("PUT", `/cards/${cardId}`, { idList: LIST["@home"] });
		if (c.idList !== LIST["@home"]) throw new Error(`expected idList=@home, got ${c.idList}`);
	});
	await step("move back to @computer", async () => {
		await trello("PUT", `/cards/${cardId}`, { idList: LIST["@computer"] });
	});
	await step("update desc", async () => {
		await trello("PUT", `/cards/${cardId}`, { desc: "Updated by smoke test." });
	});
	await step("add comment", async () => {
		await trello("POST", `/cards/${cardId}/actions/comments`, { text: "Smoke test comment." });
	});
	await step("set due + mark complete", async () => {
		const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		await trello("PUT", `/cards/${cardId}`, { due, dueComplete: true });
	});
	let checkItemId = "";
	await step("create + populate checklist", async () => {
		const cl = await trello("POST", `/cards/${cardId}/checklists`, { name: "Checklist" });
		const item1 = await trello("POST", `/checklists/${cl.id}/checkItems`, { name: "Subtask 1" });
		await trello("POST", `/checklists/${cl.id}/checkItems`, { name: "Subtask 2" });
		checkItemId = item1.id;
	});
	await step("tick checklist item (set_checklist_item_state)", async () => {
		const r = await trello("PUT", `/cards/${cardId}/checkItem/${checkItemId}`, {
			state: "complete",
		});
		if (r.state !== "complete") throw new Error(`expected state=complete, got ${r.state}`);
	});
	await step("untick checklist item", async () => {
		const r = await trello("PUT", `/cards/${cardId}/checkItem/${checkItemId}`, {
			state: "incomplete",
		});
		if (r.state !== "incomplete") throw new Error(`expected state=incomplete, got ${r.state}`);
	});

	let attachmentId = "";
	await step("add URL attachment", async () => {
		const a = await trello("POST", `/cards/${cardId}/attachments`, {
			url: "https://example.com/smoke-test",
			name: "Smoke test attachment",
		});
		if (!a.id) throw new Error("no attachment id");
		attachmentId = a.id;
	});
	await step("list attachments shows the URL we added", async () => {
		const list = await trello("GET", `/cards/${cardId}/attachments`, { fields: "id,name,url" });
		const found = list.find((a) => a.id === attachmentId);
		if (!found) throw new Error("attachment not found in list");
		if (found.url !== "https://example.com/smoke-test") {
			throw new Error(`url mismatch: ${found.url}`);
		}
	});
	await step("remove attachment", async () => {
		await trello("DELETE", `/cards/${cardId}/attachments/${attachmentId}`);
		const list = await trello("GET", `/cards/${cardId}/attachments`, { fields: "id" });
		if (list.find((a) => a.id === attachmentId)) {
			throw new Error("attachment still present after delete");
		}
	});
	await step("add + remove BESTSELLER label", async () => {
		const labels = await trello("GET", `/boards/${BOARD["dann-to-do"]}/labels`, { fields: "name" });
		const bs = labels.find((l) => l.name === "BESTSELLER");
		if (!bs) throw new Error("BESTSELLER label not found on dann-to-do");
		await trello("POST", `/cards/${cardId}/idLabels`, { value: bs.id });
		await trello("DELETE", `/cards/${cardId}/idLabels/${bs.id}`);
	});

	// 6. Cleanup
	console.log("\nCleanup:");
	for (const id of created) {
		try {
			await trello("PUT", `/cards/${id}`, { closed: "true" });
			console.log(`  archived ${id}`);
		} catch (e) {
			console.log(`  FAIL to archive ${id}: ${e.message}`);
		}
	}

	console.log(`\n=== Result === passed: ${passed}, failed: ${failed}`);
	if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
	console.error("Fatal:", e);
	for (const id of created) {
		try { await trello("PUT", `/cards/${id}`, { closed: "true" }); } catch {}
	}
	process.exit(2);
});
