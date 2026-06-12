/**
 * File: src/index.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: Worker entry. Wraps a TrelloMCP Durable Object behind the
 *              OAuthProvider (GitHub upstream), enforces a hard-coded
 *              GitHub-login allowlist, and registers the 20 Trello tools.
 *
 *              On a non-allowlisted login the server still registers tools but
 *              every handler refuses with a clear message — easier to debug
 *              than silently hiding tools, and OAuth has already completed by
 *              the time tool calls arrive so we cannot reject earlier without
 *              forking the OAuth handler.
 *
 * Change log:
 *   1.3.0 (2026-06-12) — Add add_file_attachment (base64 → multipart upload).
 *   1.2.0 (2026-06-12) — Add set_checklist_item_state + 3 URL-attachment tools (19 tools).
 *   1.0.0 (2026-06-12) — Initial; 15 tools, allowlist=[dannbleeker].
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import { GitHubHandler } from "./github-handler";
import type { Props } from "./utils";

import { TrelloClient, TrelloError } from "./trello/client";
import { GuardError } from "./trello/guards";
import {
	add_attachment,
	add_checklist_item,
	add_comment,
	add_file_attachment,
	add_label,
	archive_card,
	create_card,
	get_card,
	list_attachments,
	list_boards,
	list_cards,
	list_checklist_items,
	list_lists,
	move_card,
	remove_attachment,
	remove_label,
	search_cards,
	set_checklist_item_state,
	set_due_complete,
	update_card,
} from "./trello/tools";

/** Only these GitHub logins may call any tool. Any other authenticated user is refused. */
const ALLOWED_LOGINS = new Set<string>(["dannbleeker"]);

/**
 * Format a tool's result for an MCP response. Tools return JSON-safe objects;
 * MCP wants them as text content (JSON-stringified).
 */
function ok(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Turn an internal error into an MCP error response. GuardError messages are
 * surfaced verbatim (they were written for the caller). TrelloError gets a
 * cleaner shape. Anything else is a generic 500.
 */
function err(e: unknown) {
	if (e instanceof GuardError) {
		return { content: [{ type: "text" as const, text: `Guard refused: ${e.message}` }], isError: true };
	}
	if (e instanceof TrelloError) {
		return { content: [{ type: "text" as const, text: `Trello ${e.status}: ${e.body.slice(0, 300)}` }], isError: true };
	}
	const msg = e instanceof Error ? e.message : String(e);
	return { content: [{ type: "text" as const, text: `Internal error: ${msg}` }], isError: true };
}

/** Wrap a tool handler with auth check + uniform error mapping. */
function guarded<TIn>(
	login: string,
	fn: (input: TIn) => Promise<unknown>,
) {
	return async (input: TIn) => {
		if (!ALLOWED_LOGINS.has(login)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Access denied. GitHub user "${login}" is not on this connector's allowlist.`,
					},
				],
				isError: true,
			};
		}
		try {
			return ok(await fn(input));
		} catch (e) {
			return err(e);
		}
	};
}

export class TrelloMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Trello (Dann)",
		version: "1.3.0",
	});

	async init() {
		const login = this.props!.login;
		const client = new TrelloClient(this.env.TRELLO_KEY, this.env.TRELLO_TOKEN);

		// ---- READS ----

		this.server.tool(
			"list_boards",
			"List all open Trello boards the authenticated user belongs to. Returns id, alias (if known), name, url.",
			{},
			guarded(login, async () => list_boards(client)),
		);

		this.server.tool(
			"list_lists",
			"List the lists on a board. `board` accepts an alias (e.g. \"dann-to-do\", \"zoo\") or a raw board ID. Defaults to dann-to-do.",
			{ board: z.string().optional().describe("Board alias or ID. Default: dann-to-do.") },
			guarded(login, async (i: { board?: string }) => list_lists(client, i)),
		);

		this.server.tool(
			"list_cards",
			"List cards on a list (if `list` is given) or on a board. Optional filters: `label` (by name), `staleDays` (only cards untouched for N+ days). `list`/`board` accept aliases or raw IDs.",
			{
				list: z.string().optional().describe("List alias (e.g. \"inbox\", \"@computer\") or ID."),
				board: z.string().optional().describe("Board alias or ID. Used only if `list` is omitted. Default: dann-to-do."),
				label: z.string().optional().describe("Filter to cards carrying this label name."),
				staleDays: z.number().int().positive().optional().describe("Filter to cards untouched for at least this many days."),
			},
			guarded(login, async (i: { list?: string; board?: string; label?: string; staleDays?: number }) =>
				list_cards(client, i),
			),
		);

		this.server.tool(
			"get_card",
			"Get full details (including description) for one card by its 24-char Trello ID.",
			{ cardId: z.string().describe("Trello card ID.") },
			guarded(login, async (i: { cardId: string }) => get_card(client, i)),
		);

		this.server.tool(
			"search_cards",
			"Fuzzy search cards by name. Scoped to one board if `board` is given, otherwise searches all boards the user belongs to.",
			{
				query: z.string().min(1).describe("Search text. Trello matches loosely on card name."),
				board: z.string().optional().describe("Board alias or ID to scope the search."),
			},
			guarded(login, async (i: { query: string; board?: string }) => search_cards(client, i)),
		);

		this.server.tool(
			"list_checklist_items",
			"List the checklists and their items on a card.",
			{ cardId: z.string().describe("Trello card ID.") },
			guarded(login, async (i: { cardId: string }) => list_checklist_items(client, i)),
		);

		// ---- WRITES ----

		this.server.tool(
			"create_card",
			"Create a new card on a list. Refused if the list is Butler / Repeater Cards / Rolling Big Rocks. Emits a WIP-limit warning if the list name contains \"(WIP limit N)\" and the post-create count exceeds N.",
			{
				list: z.string().describe("Destination list alias or ID."),
				name: z.string().min(1).describe("Card title."),
				desc: z.string().optional().describe("Card description (Markdown supported by Trello)."),
				due: z.string().optional().describe("Due date in ISO 8601 (e.g. 2026-06-30T15:00:00Z)."),
				labels: z.array(z.string()).optional().describe("Label IDs to attach at creation."),
			},
			guarded(login, async (i: { list: string; name: string; desc?: string; due?: string; labels?: string[] }) =>
				create_card(client, i),
			),
		);

		this.server.tool(
			"move_card",
			"Move a card to a different list. Refused if source OR destination is Butler / Repeater Cards / Rolling Big Rocks. WIP warning emitted but not blocking.",
			{
				cardId: z.string().describe("Card to move."),
				list: z.string().describe("Destination list alias or ID."),
			},
			guarded(login, async (i: { cardId: string; list: string }) => move_card(client, i)),
		);

		this.server.tool(
			"update_card",
			"Edit a card's name, description, or due date. Pass `null` for `due` to clear the due date. Refused on Butler / Repeater Cards.",
			{
				cardId: z.string().describe("Card to update."),
				name: z.string().optional(),
				desc: z.string().optional(),
				due: z.union([z.string(), z.null()]).optional().describe("ISO 8601 due date, or null to clear."),
			},
			guarded(login, async (i: { cardId: string; name?: string; desc?: string; due?: string | null }) =>
				update_card(client, i),
			),
		);

		this.server.tool(
			"archive_card",
			"Archive a card (Trello's `closed=true`). Soft delete only — cards can be restored via the Trello UI. There is no hard-delete tool.",
			{ cardId: z.string().describe("Card to archive.") },
			guarded(login, async (i: { cardId: string }) => archive_card(client, i)),
		);

		this.server.tool(
			"set_due_complete",
			"Mark a card's due date as complete (or incomplete). Triggers Butler automations that move done cards to the Done-do list.",
			{
				cardId: z.string(),
				complete: z.boolean().describe("true = mark done, false = unmark."),
			},
			guarded(login, async (i: { cardId: string; complete: boolean }) => set_due_complete(client, i)),
		);

		this.server.tool(
			"add_label",
			"Add a label to a card. `label` accepts either the Trello label ID or the label name (case-insensitive, scoped to the card's board).",
			{
				cardId: z.string(),
				label: z.string().describe("Label ID or name."),
			},
			guarded(login, async (i: { cardId: string; label: string }) => add_label(client, i)),
		);

		this.server.tool(
			"remove_label",
			"Remove a label from a card. `label` accepts ID or name.",
			{
				cardId: z.string(),
				label: z.string().describe("Label ID or name."),
			},
			guarded(login, async (i: { cardId: string; label: string }) => remove_label(client, i)),
		);

		this.server.tool(
			"add_comment",
			"Append a comment to a card. Comments are useful for triage notes and decision logs during weekly review.",
			{
				cardId: z.string(),
				text: z.string().min(1).describe("Comment body (Markdown supported by Trello)."),
			},
			guarded(login, async (i: { cardId: string; text: string }) => add_comment(client, i)),
		);

		this.server.tool(
			"add_checklist_item",
			"Append an item to the card's checklist. Creates a checklist named \"Checklist\" if the card doesn't have one yet.",
			{
				cardId: z.string(),
				text: z.string().min(1).describe("Item text."),
			},
			guarded(login, async (i: { cardId: string; text: string }) => add_checklist_item(client, i)),
		);

		this.server.tool(
			"set_checklist_item_state",
			"Tick or untick a single checklist item. Use list_checklist_items first to find the itemId.",
			{
				cardId: z.string(),
				itemId: z.string().describe("Checklist item ID from list_checklist_items."),
				complete: z.boolean().describe("true = tick, false = untick."),
			},
			guarded(login, async (i: { cardId: string; itemId: string; complete: boolean }) =>
				set_checklist_item_state(client, i),
			),
		);

		this.server.tool(
			"list_attachments",
			"List attachments on a card. Returns id, name, url, date, mimeType.",
			{ cardId: z.string() },
			guarded(login, async (i: { cardId: string }) => list_attachments(client, i)),
		);

		this.server.tool(
			"add_attachment",
			"Attach a URL to a card. For real file uploads, use add_file_attachment instead.",
			{
				cardId: z.string(),
				url: z.string().url().describe("URL to attach."),
				name: z.string().optional().describe("Friendly name for the attachment (defaults to the URL)."),
			},
			guarded(login, async (i: { cardId: string; url: string; name?: string }) =>
				add_attachment(client, i),
			),
		);

		this.server.tool(
			"add_file_attachment",
			"Upload an actual file (not a URL) as a card attachment. Pass the file as base64 in `contentBase64`; the server decodes it and posts multipart to Trello. Hard cap 10 MB after decoding. For larger files, host them somewhere and use add_attachment with the URL.",
			{
				cardId: z.string(),
				filename: z.string().min(1).describe("File name as it should appear on the card, including extension (e.g. \"weekly-review.md\")."),
				mimeType: z.string().optional().describe("MIME type (e.g. \"text/markdown\", \"application/pdf\"). Defaults to application/octet-stream."),
				contentBase64: z.string().min(1).describe("File contents, base64-encoded. `data:...;base64,` prefix is tolerated."),
			},
			guarded(login, async (i: { cardId: string; filename: string; mimeType?: string; contentBase64: string }) =>
				add_file_attachment(client, i),
			),
		);

		this.server.tool(
			"remove_attachment",
			"Remove an attachment from a card. Use list_attachments first to find the attachmentId.",
			{
				cardId: z.string(),
				attachmentId: z.string().describe("Attachment ID from list_attachments."),
			},
			guarded(login, async (i: { cardId: string; attachmentId: string }) =>
				remove_attachment(client, i),
			),
		);
	}
}

export default new OAuthProvider({
	apiHandler: TrelloMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
