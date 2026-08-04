/**
 * File: src/index.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-06-12
 * Last Updated: 2026-06-12
 * Version: 1.0.0
 * Description: Worker entry. Wraps a TrelloMCP Durable Object behind the
 *              OAuthProvider (GitHub upstream). Tool registrations (99) and the
 *              allowlist guard live in src/register-tools.ts since v1.16.0;
 *              this file is only the wiring: DO class, OAuthProvider config,
 *              and the { fetch, scheduled } export.
 *
 *              On a non-allowlisted login the server still registers tools but
 *              every handler refuses with a clear message — easier to debug
 *              than silently hiding tools, and OAuth has already completed by
 *              the time tool calls arrive so we cannot reject earlier without
 *              forking the OAuth handler.
 *
 * Change log:
 *   1.21.0 (2026-08-04) — init() builds one UsageRecorder per MCP session and
 *                         hands it to BOTH the Trello client and the tool
 *                         registrations. That sharing is the point: a single
 *                         flush per tool call then persists the tool event and
 *                         every Trello request that tool made. See src/usage.ts.
 *   1.16.0 (2026-07-10) — Registrations extracted to src/register-tools.ts (~1,300
 *                         lines out); MCP version now tracks package.json; +1 tool:
 *                         send_digest. Total: 99.
 *   1.15.0 (2026-07-10) — +2 tools: list_snoozed_cards, wake_card (Snooze Power-Up
 *                         integration via pluginData reads). Total: 98.
 *   1.14.0 (2026-07-10) — Default export widened to { fetch, scheduled }: fetch
 *                         delegates to the unchanged OAuthProvider; scheduled runs
 *                         the daily email digest (src/digest/*). No HTTP-surface
 *                         changes.
 *   1.12.0 (2026-07-10) — ALLOWED_LOGINS moved to src/allowlist.ts so the new web
 *                         dashboard (src/dashboard/*) shares it. No MCP-surface changes.
 *   1.11.0 (2026-07-02) — Added vitest test suite (82 unit tests across 7 files);
 *                         no runtime code changes. See test/ + CHANGELOG.md.
 *   1.10.0 (2026-07-02) — Audit-surfaced refactor pass. No behavior changes.
 *                         See CHANGELOG.md for details.
 *   1.9.0 (2026-07-02) — 18 audit-surfaced bug fixes across guards, timezone, response
 *                        shapes, comment-family guards, and client-layer HTTP handling.
 *                        Tool signature changes: reaction tools gained optional cardId
 *                        (auto-derived if omitted); mark_all_notifications_read dropped
 *                        its broken `filter` param.
 *   1.8.0 (2026-07-02) — +19 tools: single-entity fetches (get_label, get_attachment),
 *                        actions & reactions (list_comment_reactions_summary, get_action,
 *                        get_action_display), custom fields (8 tools), plugins/power-ups
 *                        (4 tools), batch_get, list_archived_cards. Total: 96.
 *   1.7.1 (2026-07-02) — Fix set_card_cover color-not-persisting bug.
 *   1.7.0 (2026-06-13) — +12 tools: voting (vote/unvote/list_voters), comment reactions
 *                        (add/remove/list), copy_checklist, mark_card_notifications_read,
 *                        broader activity (list/my actions), memberships, get_member.
 *                        Total: 77.
 *   1.6.0 (2026-06-13) — +17 tools across 6 themes: list mgmt (create/rename/archive/move
 *                        + bulk move-all/archive-all cards), card cover (set/clear),
 *                        checklist-item updates (due/member/reorder), update_label,
 *                        subscribe (card/list), notifications (list/mark/mark-all).
 *                        Total: 65.
 *   1.5.0 (2026-06-13) — +13 tools: members (list/add/remove + list_my_cards_assigned),
 *                        named checklists (create/rename/delete), copy_card,
 *                        set_due_reminder, comment edits (update/delete),
 *                        weekly_review_pack composite. Total: 48.
 *   1.4.1 (2026-06-13) — Add delete_label (board-wide, destructive). Total: 35.
 *   1.4.0 (2026-06-13) — Add 14 reflect/engage tools (due/snooze reads, advanced
 *                        search, labels, checklist ops, batch ops, activity log).
 *                        Total tool surface: 34.
 *   1.3.0 (2026-06-12) — Add add_file_attachment (base64 → multipart upload).
 *   1.2.0 (2026-06-12) — Add set_checklist_item_state + 3 URL-attachment tools (19 tools).
 *   1.0.0 (2026-06-12) — Initial; 15 tools, allowlist=[dannbleeker].
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

import pkg from "../package.json";
import { runScheduledDigest } from "./digest/scheduler";
import { GitHubHandler } from "./github-handler";
import { registerTrelloTools } from "./register-tools";
import { UsageRecorder } from "./usage";
import type { Props } from "./utils";

import { TrelloClient } from "./trello/client";

export class TrelloMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Trello (Dann)",
		// Tracks package.json so the advertised MCP version can never drift again.
		version: pkg.version,
	});

	async init() {
		// One recorder per MCP session, shared by the tool wrapper and the Trello
		// client. That sharing is what lets a single flush per tool call also
		// persist the Trello requests that tool made (src/usage.ts).
		const usage = new UsageRecorder(this.env, "mcp", this.props!.login);
		registerTrelloTools(
			this.server,
			this.props!.login,
			new TrelloClient(this.env.TRELLO_KEY, this.env.TRELLO_TOKEN, usage),
			this.env,
			usage,
		);
	}
}

const oauthProvider = new OAuthProvider({
	apiHandler: TrelloMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});

// The OAuthProvider handles ALL HTTP exactly as before; `scheduled` is the
// cron entry for the daily digest (see src/digest/scheduler.ts for the
// UTC-fires-thrice / sends-once-at-04:00-Copenhagen design).
export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauthProvider.fetch(request, env, ctx),
	scheduled: async (_controller: ScheduledController, env: Env, _ctx: ExecutionContext) => {
		const result = await runScheduledDigest(env, Date.now());
		console.log(`digest cron: ${result}`);
	},
};
