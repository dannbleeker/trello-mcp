/**
 * File: src/allowlist.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: Single source of truth for the GitHub-login allowlist. Shared by
 *              the MCP tool guard (src/index.ts) and the web dashboard
 *              (src/dashboard/*): removing a login here revokes both surfaces.
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Extracted from src/index.ts unchanged (v1.12.0 dashboard release).
 */

/** Only these GitHub logins may call any tool or open the dashboard. Any other authenticated user is refused. */
export const ALLOWED_LOGINS = new Set<string>(["dannbleeker"]);
