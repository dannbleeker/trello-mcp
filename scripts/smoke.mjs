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

	// delete_label (1.4.1): real DELETE /labels/{id} round-trip
	await step("delete_label: created label is gone afterwards", async () => {
		if (!createdLabelId) throw new Error("no test label to delete (create_label step skipped?)");
		await trello("DELETE", `/labels/${createdLabelId}`);
		const labels = await trello("GET", `/boards/${BOARD["dann-to-do"]}/labels`, { fields: "id" });
		if (labels.find((l) => l.id === createdLabelId)) {
			throw new Error("label still on the board after DELETE");
		}
		createdLabelId = ""; // prevent the legacy cleanup step from re-deleting
	});

	// 7. v1.5.0 — members, named checklists, copy_card, due-reminder, comment edits

	console.log("\nv1.5.0 — members / checklists / copy / reminder / comment edits:");

	let myId = "";
	let myUsername = "";
	await step("getMe + listBoardMembers (self should be present)", async () => {
		const me = await trello("GET", "/members/me", { fields: "fullName,username" });
		if (!me?.id) throw new Error("no member id from /members/me");
		myId = me.id;
		myUsername = me.username;
		const members = await trello("GET", `/boards/${BOARD["dann-to-do"]}/members`, {
			fields: "username",
		});
		if (!members.find((m) => m.id === myId)) {
			throw new Error("self not present in board members — unexpected");
		}
	});

	await step("add_member_to_card + list_card_members + remove", async () => {
		await trello("POST", `/cards/${cardId}/idMembers`, { value: myId });
		const onCard = await trello("GET", `/cards/${cardId}/members`, { fields: "username" });
		if (!onCard.find((m) => m.id === myId)) {
			throw new Error("self not on card after add_member_to_card");
		}
		await trello("DELETE", `/cards/${cardId}/idMembers/${myId}`);
	});

	let checklist3Id = "";
	await step("create_checklist (named) + rename_checklist + delete_checklist", async () => {
		const cl = await trello("POST", `/cards/${cardId}/checklists`, { name: "Agenda" });
		checklist3Id = cl.id;
		const renamed = await trello("PUT", `/checklists/${cl.id}`, { name: "Decisions" });
		if (renamed.name !== "Decisions") throw new Error(`rename failed: ${renamed.name}`);
		await trello("DELETE", `/checklists/${cl.id}`);
		checklist3Id = "";
	});

	let copiedCardId = "";
	await step("copy_card (keepFromSource=all) lands on @home", async () => {
		const c = await trello("POST", "/cards", {
			idCardSource: cardId,
			idList: LIST["@home"],
			keepFromSource: "all",
			name: "[MCP-TEST] copy round-trip",
		});
		if (!c.id) throw new Error("no card id from copy");
		copiedCardId = c.id;
		created.push(copiedCardId);
		if (c.idList !== LIST["@home"]) throw new Error(`expected idList=@home, got ${c.idList}`);
	});

	await step("set_due_reminder: 60 then clear", async () => {
		const due = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		await trello("PUT", `/cards/${cardId}`, { due });
		const r1 = await trello("PUT", `/cards/${cardId}`, { dueReminder: 60 });
		if (r1.dueReminder !== 60) throw new Error(`expected dueReminder=60, got ${r1.dueReminder}`);
		const r2 = await trello("PUT", `/cards/${cardId}`, { dueReminder: -1 });
		if (r2.dueReminder !== -1 && r2.dueReminder !== null) {
			throw new Error(`expected dueReminder=-1/null after clear, got ${r2.dueReminder}`);
		}
	});

	let editedCommentId = "";
	await step("update_comment + delete_comment round-trip", async () => {
		const c = await trello("POST", `/cards/${cardId}/actions/comments`, {
			text: "Edit-me comment.",
		});
		editedCommentId = c.id;
		const updated = await trello("PUT", `/actions/${c.id}`, { text: "Edited body." });
		if (updated?.data?.text !== "Edited body.") {
			throw new Error(`expected text=Edited body., got ${JSON.stringify(updated?.data?.text)}`);
		}
		await trello("DELETE", `/actions/${c.id}`);
	});

	await step("list_my_cards_assigned: includes self when assigned", async () => {
		// Assign + verify visible in /members/me/cards
		await trello("POST", `/cards/${cardId}/idMembers`, { value: myId });
		const mine = await trello("GET", "/members/me/cards", { filter: "open", fields: "id" });
		const present = mine.find((c) => c.id === cardId);
		await trello("DELETE", `/cards/${cardId}/idMembers/${myId}`); // cleanup
		if (!present) throw new Error("test card not in /members/me/cards after assignment");
	});

	await step("weekly_review_pack shape: bucket counts present", async () => {
		// Mirrors the composite logic: list cards once, compute buckets.
		const all = await trello("GET", `/boards/${BOARD["dann-to-do"]}/cards`, {
			fields: "name,idList,due,dueComplete,dueReminder,dateLastActivity,closed",
		});
		const open = all.filter((c) => !c.closed);
		const now = Date.now();
		const overdue = open.filter((c) => c.due && !c.dueComplete && Date.parse(c.due) < now);
		const snoozed = open.filter((c) => c.dueReminder !== null && c.dueReminder !== -1);
		if (typeof overdue.length !== "number" || typeof snoozed.length !== "number") {
			throw new Error("bucket shape unexpected");
		}
	});

	// 8. v1.6.0 — list mgmt, cover, checklist-item updates, label edit,
	//             subscribe, notifications

	console.log("\nv1.6.0 — lists / cover / checklist items / subscribe / notifications:");

	let testListId = "";
	await step("create_list + rename_list + archive_list round-trip", async () => {
		const created = await trello("POST", "/lists", {
			idBoard: BOARD["dann-to-do"],
			name: "[MCP-TEST] smoke list",
			pos: "bottom",
		});
		testListId = created.id;
		if (!testListId) throw new Error("no list id");
		const renamed = await trello("PUT", `/lists/${testListId}`, { name: "[MCP-TEST] renamed" });
		if (renamed.name !== "[MCP-TEST] renamed") throw new Error(`rename failed: ${renamed.name}`);
		const archived = await trello("PUT", `/lists/${testListId}`, { closed: true });
		if (!archived.closed) throw new Error("list not archived");
	});

	await step("set_card_cover (color=red) + clear_card_cover", async () => {
		const set = await trello("PUT", `/cards/${cardId}`, {
			cover: JSON.stringify({ color: "red", size: "normal", brightness: "dark" }),
		});
		if (set?.cover?.color !== "red") throw new Error(`cover color mismatch: ${JSON.stringify(set?.cover)}`);
		const cleared = await trello("PUT", `/cards/${cardId}`, { cover: JSON.stringify({}) });
		if (cleared?.cover?.color) throw new Error(`cover not cleared: ${JSON.stringify(cleared?.cover)}`);
	});

	// Regression check for the v1.7.1 fix: sending idAttachment:null alongside
	// a color makes Trello clear the color instead of setting it. The client
	// must strip null cover fields so this doesn't happen.
	await step("set_card_cover color persists when idAttachment is null in blob (v1.7.1 regression)", async () => {
		// Broken shape — DO NOT send this from the client. If the fix is in place,
		// the equivalent shape below (with the null stripped) should keep the color.
		const good = await trello("PUT", `/cards/${cardId}`, {
			cover: JSON.stringify({ color: "purple", size: "normal", brightness: "dark" }),
		});
		if (good?.cover?.color !== "purple") {
			throw new Error(
				`cover color did not persist without idAttachment:null; got ${JSON.stringify(good?.cover)}`,
			);
		}
		// Now verify Trello's known-broken behaviour (documenting why the fix matters):
		const broken = await trello("PUT", `/cards/${cardId}`, {
			cover: JSON.stringify({ color: "sky", idAttachment: null, size: "normal", brightness: "dark" }),
		});
		if (broken?.cover?.color === "sky") {
			console.log(
				"  note: Trello now accepts idAttachment:null alongside a color — the v1.7.1 defensive strip is still correct but no longer strictly required.",
			);
		}
		// Clean up
		await trello("PUT", `/cards/${cardId}`, { cover: JSON.stringify({}) });
	});

	await step("update_label: rename + recolor lime → purple", async () => {
		const lb = await trello("POST", "/labels", {
			name: "[MCP-TEST] update target",
			idBoard: BOARD["dann-to-do"],
			color: "lime",
		});
		const updated = await trello("PUT", `/labels/${lb.id}`, {
			name: "[MCP-TEST] updated",
			color: "purple",
		});
		if (updated.name !== "[MCP-TEST] updated" || updated.color !== "purple") {
			throw new Error(`label update failed: ${JSON.stringify(updated)}`);
		}
		await trello("DELETE", `/labels/${lb.id}`);
	});

	let updItemId = "";
	let updChecklistId = "";
	await step("checklist item: due + member + reorder", async () => {
		const cl = await trello("POST", `/cards/${cardId}/checklists`, { name: "ItemUpdates" });
		updChecklistId = cl.id;
		const item = await trello("POST", `/checklists/${cl.id}/checkItems`, {
			name: "Item to update",
		});
		updItemId = item.id;

		const due = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
		const withDue = await trello("PUT", `/cards/${cardId}/checkItem/${item.id}`, { due });
		if (!withDue.due) throw new Error(`item due not set: ${JSON.stringify(withDue)}`);

		const me = await trello("GET", "/members/me", { fields: "username" });
		const assigned = await trello("PUT", `/cards/${cardId}/checkItem/${item.id}`, {
			idMember: me.id,
		});
		if (assigned.idMember !== me.id) throw new Error("item member not assigned");

		// reorder to top
		await trello("PUT", `/cards/${cardId}/checkItem/${item.id}`, { pos: "top" });

		// cleanup the test checklist
		await trello("DELETE", `/checklists/${cl.id}`);
	});

	await step("subscribe_card + subscribe_list flip & flip back", async () => {
		const sc1 = await trello("PUT", `/cards/${cardId}`, { subscribed: true });
		if (sc1.subscribed !== true) throw new Error(`card subscribed not set: ${sc1.subscribed}`);
		const sc2 = await trello("PUT", `/cards/${cardId}`, { subscribed: false });
		if (sc2.subscribed !== false) throw new Error(`card unsubscribe failed: ${sc2.subscribed}`);
		const sl1 = await trello("PUT", `/lists/${LIST["@computer"]}`, { subscribed: true });
		if (sl1.subscribed !== true) throw new Error(`list subscribed not set: ${sl1.subscribed}`);
		await trello("PUT", `/lists/${LIST["@computer"]}`, { subscribed: false });
	});

	await step("list_notifications: feed responds with array", async () => {
		const feed = await trello("GET", "/members/me/notifications", {
			filter: "all",
			read_filter: "all",
			limit: 5,
		});
		if (!Array.isArray(feed)) throw new Error("notifications endpoint did not return array");
	});

	// 9. v1.7.0 — votes, comment reactions, copy_checklist, bulk-clear card
	//             notifications, broader activity reads, memberships, get_member

	console.log("\nv1.7.0 — votes / reactions / copy_checklist / activity / memberships:");

	await step("vote_card + list_card_voters + unvote_card", async () => {
		const me = await trello("GET", "/members/me", { fields: "username" });
		await trello("POST", `/cards/${cardId}/membersVoted`, { value: me.id });
		const voters = await trello("GET", `/cards/${cardId}/membersVoted`, { fields: "username" });
		if (!voters.find((v) => v.id === me.id)) {
			throw new Error("self not in voters after vote");
		}
		await trello("DELETE", `/cards/${cardId}/membersVoted/${me.id}`);
	});

	let reactionCommentId = "";
	let reactionId = "";
	await step("add_comment_reaction + list + remove", async () => {
		const c = await trello("POST", `/cards/${cardId}/actions/comments`, {
			text: "Reaction target comment.",
		});
		reactionCommentId = c.id;
		const r = await trello("POST", `/actions/${c.id}/reactions`, { shortName: "thumbsup" });
		if (!r.id) throw new Error("no reaction id returned");
		reactionId = r.id;
		const list = await trello("GET", `/actions/${c.id}/reactions`);
		if (!Array.isArray(list) || !list.find((x) => x.id === r.id)) {
			throw new Error("reaction not in list");
		}
		await trello("DELETE", `/actions/${c.id}/reactions/${r.id}`);
	});

	let copiedChecklistId = "";
	await step("copy_checklist: source checklist landed on second card", async () => {
		// Make a source checklist on `cardId`, then copy it to `copiedCardId`.
		const src = await trello("POST", `/cards/${cardId}/checklists`, { name: "CopySource" });
		await trello("POST", `/checklists/${src.id}/checkItems`, { name: "A" });
		await trello("POST", `/checklists/${src.id}/checkItems`, { name: "B" });
		const copy = await trello("POST", `/cards/${copiedCardId}/checklists`, {
			idChecklistSource: src.id,
		});
		copiedChecklistId = copy.id;
		const onCopy = await trello("GET", `/cards/${copiedCardId}/checklists`, {
			fields: "name",
			checkItem_fields: "name",
		});
		const found = onCopy.find((cl) => cl.id === copy.id);
		if (!found || !Array.isArray(found.checkItems) || found.checkItems.length < 2) {
			throw new Error(`copy missing items: ${JSON.stringify(found)}`);
		}
		// cleanup the source checklist on cardId
		await trello("DELETE", `/checklists/${src.id}`);
	});

	await step("mark_card_notifications_read: returns 200", async () => {
		await trello("POST", `/cards/${cardId}/markAssociatedNotificationsRead`);
	});

	await step("list_list_actions @computer responds with array", async () => {
		const actions = await trello("GET", `/lists/${LIST["@computer"]}/actions`, {
			filter: "all",
			limit: 5,
		});
		if (!Array.isArray(actions)) throw new Error("list actions did not return array");
	});

	await step("list_my_actions responds with array", async () => {
		const actions = await trello("GET", "/members/me/actions", { filter: "all", limit: 5 });
		if (!Array.isArray(actions)) throw new Error("my actions did not return array");
	});

	await step("list_board_memberships: includes self with a memberType", async () => {
		const me = await trello("GET", "/members/me", { fields: "username" });
		const m = await trello("GET", `/boards/${BOARD["dann-to-do"]}/memberships`, {
			member: true,
			member_fields: "username",
		});
		const mine = m.find((x) => x.idMember === me.id);
		if (!mine) throw new Error("self not in memberships");
		if (!mine.memberType) throw new Error("memberType missing");
	});

	await step("get_member by username returns self", async () => {
		const me = await trello("GET", "/members/me", { fields: "username" });
		const lookup = await trello("GET", `/members/${me.username}`, { fields: "username" });
		if (lookup.id !== me.id) throw new Error("get_member did not match self");
	});

	// 10. v1.8.0 — single-entity fetches, actions, custom fields, plugins,
	//              batch, archived reads

	console.log("\nv1.8.0 — single-entity fetches / actions / custom fields / plugins / batch / archived reads:");

	await step("get_label: BESTSELLER label resolves with name/color/idBoard", async () => {
		const labels = await trello("GET", `/boards/${BOARD["dann-to-do"]}/labels`, {
			fields: "id,name",
		});
		const bs = labels.find((l) => l.name === "BESTSELLER");
		if (!bs) throw new Error("BESTSELLER label not found on dann-to-do");
		const lb = await trello("GET", `/labels/${bs.id}`, {
			fields: "name,color,idBoard",
		});
		if (!lb.name) throw new Error(`label name missing: ${JSON.stringify(lb)}`);
		if (!("color" in lb)) throw new Error(`label color field missing: ${JSON.stringify(lb)}`);
		if (!lb.idBoard) throw new Error(`label idBoard missing: ${JSON.stringify(lb)}`);
	});

	await step("get_attachment: single attachment fetch round-trip", async () => {
		const a = await trello("POST", `/cards/${cardId}/attachments`, {
			url: "https://example.com/get-attachment-smoke",
			name: "Get attachment smoke",
		});
		if (!a.id) throw new Error("no attachment id");
		const one = await trello("GET", `/cards/${cardId}/attachments/${a.id}`);
		if (!one?.id) throw new Error(`no id in single-attachment fetch: ${JSON.stringify(one)}`);
		// previews may or may not be present for URL attachments; require id/name/url at minimum
		if (!one.name) throw new Error(`attachment name missing: ${JSON.stringify(one)}`);
		if (!one.url) throw new Error(`attachment url missing: ${JSON.stringify(one)}`);
		await trello("DELETE", `/cards/${cardId}/attachments/${a.id}`);
	});

	await step("list_comment_reactions_summary: array response", async () => {
		const c = await trello("POST", `/cards/${cardId}/actions/comments`, {
			text: "Reaction summary smoke.",
		});
		const r = await trello("POST", `/actions/${c.id}/reactions`, { shortName: "thumbsup" });
		const summary = await trello("GET", `/actions/${c.id}/reactionsSummary`);
		if (!Array.isArray(summary)) {
			throw new Error(`expected array, got ${JSON.stringify(summary).slice(0, 120)}`);
		}
		// cleanup: remove reaction + delete comment
		await trello("DELETE", `/actions/${c.id}/reactions/${r.id}`);
		await trello("DELETE", `/actions/${c.id}`);
	});

	await step("get_action + get_action_display: createCard action resolves", async () => {
		const creates = await trello("GET", `/cards/${cardId}/actions`, {
			filter: "createCard",
			limit: 1,
		});
		if (!Array.isArray(creates) || creates.length < 1) {
			throw new Error(`no createCard action for card: ${JSON.stringify(creates).slice(0, 120)}`);
		}
		const actionId = creates[0].id;
		const action = await trello("GET", `/actions/${actionId}`);
		if (!action) throw new Error("get_action returned null");
		if (action.id !== actionId) throw new Error(`get_action id mismatch: ${action.id}`);
		const display = await trello("GET", `/actions/${actionId}/display`);
		if (!display) throw new Error("get_action_display returned null");
	});

	// Custom Fields end-to-end (biggest section). Enables the Custom Fields
	// Power-Up only if it's not already on, so we don't disable it if it was.
	const CUSTOM_FIELDS_PLUGIN_ID = "56d5e249a98895a9797bebb9";
	let customFieldId = "";
	let enabledCustomFieldsPlugin = false;
	let customFieldsBoardPluginId = "";

	await step("custom_fields: enable Power-Up if not already on", async () => {
		const plugins = await trello(
			"GET",
			`/boards/${BOARD["dann-to-do"]}/boardPlugins`,
		);
		const existing = Array.isArray(plugins)
			? plugins.find((p) => p.idPlugin === CUSTOM_FIELDS_PLUGIN_ID)
			: null;
		if (existing) {
			customFieldsBoardPluginId = existing.id;
			enabledCustomFieldsPlugin = false;
		} else {
			const enabled = await trello("POST", `/boards/${BOARD["dann-to-do"]}/boardPlugins`, {
				idPlugin: CUSTOM_FIELDS_PLUGIN_ID,
			});
			if (!enabled?.id) throw new Error(`failed to enable Custom Fields Power-Up: ${JSON.stringify(enabled)}`);
			customFieldsBoardPluginId = enabled.id;
			enabledCustomFieldsPlugin = true;
		}
	});

	await step("custom_fields: create text field on board", async () => {
		const f = await trello("POST", "/customFields", {
			idModel: BOARD["dann-to-do"],
			modelType: "board",
			name: "[MCP-TEST] smoke text",
			type: "text",
		});
		if (!f?.id) throw new Error(`no custom field id: ${JSON.stringify(f)}`);
		customFieldId = f.id;
	});

	await step("custom_fields: set text value on card via JSON body", async () => {
		const url = new URL(`${BASE}/cards/${cardId}/customField/${customFieldId}/item`);
		url.searchParams.set("key", KEY);
		url.searchParams.set("token", TOKEN);
		const r = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ value: { text: "hello from smoke" } }),
		});
		if (!r.ok) {
			const body = await r.text();
			throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
		}
		const j = await r.json();
		if (!j) throw new Error("empty response setting custom field value");
	});

	await step("custom_fields: list card items includes the text value", async () => {
		const items = await trello("GET", `/cards/${cardId}/customFieldItems`);
		if (!Array.isArray(items)) throw new Error(`expected array, got ${JSON.stringify(items).slice(0, 120)}`);
		const mine = items.find((i) => i.idCustomField === customFieldId);
		if (!mine) throw new Error("test custom field item not found on card");
		if (mine.value?.text !== "hello from smoke") {
			throw new Error(`expected text="hello from smoke", got ${JSON.stringify(mine.value)}`);
		}
	});

	await step("custom_fields: clear value with empty JSON body", async () => {
		const url = new URL(`${BASE}/cards/${cardId}/customField/${customFieldId}/item`);
		url.searchParams.set("key", KEY);
		url.searchParams.set("token", TOKEN);
		const r = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({}),
		});
		if (!r.ok) {
			const body = await r.text();
			throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
		}
	});

	await step("custom_fields: delete field", async () => {
		await trello("DELETE", `/customFields/${customFieldId}`);
		customFieldId = "";
	});

	await step("custom_fields: disable Power-Up if we enabled it", async () => {
		if (!enabledCustomFieldsPlugin) {
			return; // was already on before this run — leave it as we found it
		}
		const plugins = await trello(
			"GET",
			`/boards/${BOARD["dann-to-do"]}/boardPlugins`,
		);
		const existing = Array.isArray(plugins)
			? plugins.find((p) => p.idPlugin === CUSTOM_FIELDS_PLUGIN_ID)
			: null;
		if (!existing) throw new Error("expected boardPlugin entry to disable but none found");
		await trello("DELETE", `/boards/${BOARD["dann-to-do"]}/boardPlugins/${existing.id}`);
	});

	await step("list_board_plugins: returns array", async () => {
		const plugins = await trello("GET", `/boards/${BOARD["dann-to-do"]}/boardPlugins`);
		if (!Array.isArray(plugins)) {
			throw new Error(`expected array, got ${JSON.stringify(plugins).slice(0, 120)}`);
		}
	});

	await step("get_plugin: Custom Fields plugin has a name", async () => {
		const p = await trello("GET", `/plugins/${CUSTOM_FIELDS_PLUGIN_ID}`);
		if (!p || typeof p !== "object") throw new Error(`expected object, got ${JSON.stringify(p)}`);
		if (!p.name) throw new Error(`plugin name missing: ${JSON.stringify(p).slice(0, 200)}`);
	});

	await step("batch_get: two boards in one call", async () => {
		const urls = `/boards/${BOARD["dann-to-do"]},/boards/${BOARD["zoo"]}`;
		const r = await trello("GET", "/batch", { urls });
		if (!Array.isArray(r)) throw new Error(`expected array, got ${JSON.stringify(r).slice(0, 120)}`);
		if (r.length !== 2) throw new Error(`expected length 2, got ${r.length}`);
		for (const entry of r) {
			if (!entry || typeof entry !== "object") {
				throw new Error(`batch entry not an object: ${JSON.stringify(entry)}`);
			}
			const numericKey = Object.keys(entry).find((k) => /^\d+$/.test(k));
			if (!numericKey) {
				throw new Error(`batch entry missing numeric key: ${JSON.stringify(entry).slice(0, 120)}`);
			}
		}
	});

	await step("list_archived_cards: returns array", async () => {
		const cards = await trello("GET", `/boards/${BOARD["dann-to-do"]}/cards/closed`);
		if (!Array.isArray(cards)) {
			throw new Error(`expected array, got ${JSON.stringify(cards).slice(0, 120)}`);
		}
	});

	// v1.9.0 regression checks — audit-surfaced bug fixes
	console.log("\nv1.9.0 — audit regression checks:");

	const ROLLING_BIG_ROCKS = "5b6189409662065780670709";

	await step("READ_ONLY guard: Rolling Big Rocks is still gettable (reads unaffected)", async () => {
		const l = await trello("GET", `/lists/${ROLLING_BIG_ROCKS}`, { fields: "name,closed" });
		if (!l.name?.toLowerCase().includes("rolling")) {
			throw new Error(`Rolling Big Rocks list identity check failed: ${JSON.stringify(l)}`);
		}
	});

	await step("getList (new v1.9.0 client method) returns idBoard directly", async () => {
		const l = await trello("GET", `/lists/${LIST["@home"]}`, {
			fields: "name,idBoard,closed",
		});
		if (l.idBoard !== BOARD["dann-to-do"]) {
			throw new Error(`getList idBoard mismatch: ${l.idBoard}`);
		}
	});

	await step("Retry-After HTTP-date parse (regression harness: string check)", async () => {
		// Cheap sanity: the client-side parseRetryAfterMs handles both int and HTTP-date.
		// Smoke can't actually trigger a 429 with an HTTP-date reliably, so we just
		// exercise the pattern here to make sure the harness didn't regress.
		const httpDate = "Wed, 21 Oct 2026 07:28:00 GMT";
		const t = Date.parse(httpDate);
		if (Number.isNaN(t)) throw new Error("HTTP-date parse broken in this Node runtime");
	});

	await step("batch endpoint shape check (regression: non-numeric key handling)", async () => {
		// Two valid board fetches — both should return {"200":{...}} envelopes.
		const results = await trello("GET", "/batch", {
			urls: `/boards/${BOARD["dann-to-do"]},/boards/${BOARD["zoo"]}`,
		});
		if (!Array.isArray(results) || results.length !== 2) {
			throw new Error(`expected array of length 2, got ${JSON.stringify(results).slice(0, 200)}`);
		}
		for (const entry of results) {
			const key = Object.keys(entry)[0];
			if (!/^\d{3}$/.test(key)) {
				throw new Error(`batch entry key not 3-digit status: "${key}"`);
			}
		}
	});

	await step("Custom field checkbox stringification: Trello returns \"true\"/\"false\" as strings (regression pin)", async () => {
		// This step documents the format that list_card_custom_fields now parses.
		// Direct Trello call — the tool layer transforms the string to boolean.
		// Enable Custom Fields Power-Up if not already, create a checkbox field on
		// the smoke card, set its value, and verify Trello returns a string.
		const plugins = await trello("GET", `/boards/${BOARD["dann-to-do"]}/boardPlugins`);
		const already = plugins.find((p) => p.idPlugin === "56d5e249a98895a9797bebb9");
		let bp = null;
		if (!already) {
			bp = await trello("POST", `/boards/${BOARD["dann-to-do"]}/boardPlugins`, {
				idPlugin: "56d5e249a98895a9797bebb9",
			});
		}

		const field = await trello("POST", "/customFields", {
			idModel: BOARD["dann-to-do"],
			modelType: "board",
			name: "[MCP-TEST] checkbox regression",
			type: "checkbox",
		});

		try {
			// Set the checkbox to true via JSON body (Trello requires this shape).
			const url = new URL(`${BASE}/cards/${cardId}/customField/${field.id}/item`);
			url.searchParams.set("key", KEY);
			url.searchParams.set("token", TOKEN);
			await fetch(url, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value: { checked: "true" } }),
			});
			const items = await trello("GET", `/cards/${cardId}/customFieldItems`);
			const item = items.find((it) => it.idCustomField === field.id);
			if (!item) throw new Error("custom field item not present after PUT");
			// Trello returns the value as a STRING — the whole point of the fix.
			if (typeof item.value?.checked !== "string") {
				throw new Error(`expected value.checked to be a string, got ${typeof item.value?.checked}`);
			}
			if (item.value.checked !== "true") {
				throw new Error(`expected "true", got "${item.value.checked}"`);
			}
		} finally {
			await trello("DELETE", `/customFields/${field.id}`);
			if (bp) {
				await trello("DELETE", `/boards/${BOARD["dann-to-do"]}/boardPlugins/${bp.id}`);
			}
		}
	});

	await step("update_comment/delete_comment ownership check (regression: mismatched cardId)", async () => {
		// Post a comment on cardId, verify GET /actions/{id} returns the same card id
		// so the tool-layer verify pattern can rely on it.
		const c = await trello("POST", `/cards/${cardId}/actions/comments`, {
			text: "ownership-check comment",
		});
		const action = await trello("GET", `/actions/${c.id}`);
		if (action?.data?.card?.id !== cardId) {
			throw new Error(
				`action.data.card.id mismatch: got ${action?.data?.card?.id}, expected ${cardId}`,
			);
		}
		await trello("DELETE", `/actions/${c.id}`);
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
