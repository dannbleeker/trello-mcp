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

	// add_file_attachment (multipart file upload): mirrors what the Worker does
	// at runtime — build FormData with a Blob and POST to /attachments.
	let fileAttachmentId = "";
	await step("add_file_attachment: multipart file upload", async () => {
		const text = "Hello from the smoke test.\nThis was uploaded via multipart.\n";
		const blob = new Blob([text], { type: "text/markdown" });
		const form = new FormData();
		form.append("name", "smoke-upload.md");
		form.append("file", blob, "smoke-upload.md");
		const url = new URL(`${BASE}/cards/${cardId}/attachments`);
		url.searchParams.set("key", KEY);
		url.searchParams.set("token", TOKEN);
		const r = await fetch(url, { method: "POST", body: form });
		if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
		const a = await r.json();
		if (!a.id) throw new Error("no attachment id");
		if (a.url?.startsWith("http") === false) throw new Error(`url looks wrong: ${a.url}`);
		fileAttachmentId = a.id;
	});
	await step("list attachments shows the uploaded file", async () => {
		const list = await trello("GET", `/cards/${cardId}/attachments`, { fields: "id,name,bytes,mimeType" });
		const found = list.find((a) => a.id === fileAttachmentId);
		if (!found) throw new Error("uploaded file not in attachments list");
		if (found.name !== "smoke-upload.md") throw new Error(`name mismatch: ${found.name}`);
		if (!found.bytes || found.bytes < 10) throw new Error(`bytes looks wrong: ${found.bytes}`);
	});
	await step("remove uploaded file attachment", async () => {
		await trello("DELETE", `/cards/${cardId}/attachments/${fileAttachmentId}`);
	});

	await step("add + remove BESTSELLER label", async () => {
		const labels = await trello("GET", `/boards/${BOARD["dann-to-do"]}/labels`, { fields: "name" });
		const bs = labels.find((l) => l.name === "BESTSELLER");
		if (!bs) throw new Error("BESTSELLER label not found on dann-to-do");
		await trello("POST", `/cards/${cardId}/idLabels`, { value: bs.id });
		await trello("DELETE", `/cards/${cardId}/idLabels/${bs.id}`);
	});

	// 6. v1.4.0 — reflect / engage tools

	console.log("\nv1.4.0 — reflect/engage tools:");

	await step("set_card_position: top", async () => {
		const r = await trello("PUT", `/cards/${cardId}`, { pos: "top" });
		if (typeof r.pos !== "number") throw new Error(`pos missing on response: ${JSON.stringify(r.pos)}`);
	});

	let startDate = "";
	await step("set_start_date: set + clear", async () => {
		startDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		let r = await trello("PUT", `/cards/${cardId}`, { start: startDate });
		if (!r.start) throw new Error("start not set");
		r = await trello("PUT", `/cards/${cardId}`, { start: "" });
		if (r.start) throw new Error(`start should be null after clear, got ${r.start}`);
	});

	let createdLabelId = "";
	await step("create_label: lime [MCP-TEST]", async () => {
		const lb = await trello("POST", "/labels", {
			name: "[MCP-TEST] smoke label",
			idBoard: BOARD["dann-to-do"],
			color: "lime",
		});
		if (!lb.id) throw new Error("no label id");
		if (lb.color !== "lime") throw new Error(`expected color=lime, got ${lb.color}`);
		createdLabelId = lb.id;
	});
	await step("list_labels finds the new label", async () => {
		const labels = await trello("GET", `/boards/${BOARD["dann-to-do"]}/labels`, { fields: "id,name,color" });
		const found = labels.find((l) => l.id === createdLabelId);
		if (!found) throw new Error("created label not found in list");
	});

	let checklist2Id = "";
	let checkItem2Id = "";
	await step("remove_checklist_item: add then delete", async () => {
		const cl = await trello("POST", `/cards/${cardId}/checklists`, { name: "RemoveTest" });
		checklist2Id = cl.id;
		const item = await trello("POST", `/checklists/${cl.id}/checkItems`, { name: "Will be removed" });
		checkItem2Id = item.id;
		await trello("DELETE", `/checklists/${cl.id}/checkItems/${item.id}`);
	});

	let convertedCardId = "";
	await step("convert_checklist_item_to_card", async () => {
		// Need a fresh item on the same checklist since the previous one was removed.
		const item = await trello("POST", `/checklists/${checklist2Id}/checkItems`, {
			name: "Promote to card",
		});
		const newCard = await trello(
			"POST",
			`/cards/${cardId}/checklist/${checklist2Id}/checkItem/${item.id}/convertToCard`,
		);
		if (!newCard?.id) throw new Error(`no new card returned: ${JSON.stringify(newCard).slice(0, 120)}`);
		convertedCardId = newCard.id;
		created.push(convertedCardId);
	});

	await step("add_comment + read_comments returns it chronologically", async () => {
		const c1 = "First smoke comment.";
		const c2 = "Second smoke comment.";
		await trello("POST", `/cards/${cardId}/actions/comments`, { text: c1 });
		await trello("POST", `/cards/${cardId}/actions/comments`, { text: c2 });
		const actions = await trello("GET", `/cards/${cardId}/actions`, {
			filter: "commentCard",
			limit: 10,
		});
		// Trello returns newest-first; we'd sort chronologically in tools — verify count only here.
		const texts = actions.map((a) => a.data?.text).filter((t) => typeof t === "string");
		if (!texts.includes(c1) || !texts.includes(c2)) {
			throw new Error(`comments missing from feed: ${JSON.stringify(texts)}`);
		}
	});

	await step("card_activity_log returns updateCard/commentCard entries", async () => {
		const filter = [
			"createCard",
			"updateCard:idList",
			"updateCard:due",
			"commentCard",
			"convertToCardFromCheckItem",
		].join(",");
		const actions = await trello("GET", `/cards/${cardId}/actions`, { filter, limit: 25 });
		if (!Array.isArray(actions) || actions.length < 1) {
			throw new Error(`expected ≥1 action, got ${actions?.length}`);
		}
	});

	await step("list_cards_due: overdue scope (count >= 0, doesn't crash)", async () => {
		const cards = await trello("GET", `/boards/${BOARD["dann-to-do"]}/cards`, {
			fields: "name,due,dueComplete,dueReminder,closed",
		});
		const now = Date.now();
		const overdue = cards.filter(
			(c) => !c.closed && c.due && Date.parse(c.due) < now && !c.dueComplete,
		);
		if (!Array.isArray(overdue)) throw new Error("overdue filter failed");
	});

	await step("search_cards_advanced: due:overdue operator", async () => {
		const r = await trello("GET", "/search", {
			query: "due:overdue",
			modelTypes: "cards",
			cards_limit: 10,
			partial: true,
		});
		if (!r.cards) throw new Error("search returned no cards key");
	});

	await step("snooze_read style: filter cards with dueReminder set", async () => {
		const cards = await trello("GET", `/boards/${BOARD["dann-to-do"]}/cards`, {
			fields: "due,dueReminder,closed",
		});
		const snoozed = cards.filter(
			(c) => !c.closed && c.dueReminder !== null && c.dueReminder !== -1,
		);
		if (!Array.isArray(snoozed)) throw new Error("snooze filter failed");
	});

	// Cleanup the test label
	await step("cleanup: delete test label", async () => {
		if (createdLabelId) await trello("DELETE", `/labels/${createdLabelId}`);
	});

	// 7. Cleanup
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
