-- Usage tracking (v1.21.0) — the D1 mirror behind /api/usage and the
-- dashboard's Usage panel. See src/usage.ts and docs/usage-tracking.md.
--
-- ALREADY APPLIED to the `trello-mcp-usage` database
-- (8e58b547-28c7-43b5-a356-a3e9cef39617). This file exists so the schema is
-- reproducible and reviewable in the repo rather than living only in
-- Cloudflare. Every statement is idempotent, so re-applying is harmless:
--   wrangler d1 execute trello-mcp-usage --remote --file=migrations/0001_usage_events.sql
--
-- One table, not two, discriminated by `kind`:
--   kind='tool' — one MCP tool call    (name = the tool, e.g. list_cards)
--   kind='http' — one Trello REST call (name = "GET /cards/{id}", templated)
-- They are not 1:1 — weekly_review_pack is one tool row and a dozen http rows,
-- which is exactly the fan-out the endpoint view is for.
--
-- What is deliberately NOT here: argument values. Card titles, comment bodies
-- and search queries are personal data and never leave the Worker.

CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,          -- epoch ms
  kind        TEXT    NOT NULL,          -- 'tool' | 'http'
  surface     TEXT    NOT NULL,          -- 'mcp' | 'dashboard' | 'cron'
  name        TEXT    NOT NULL,          -- tool name, or "METHOD /templated/path"
  outcome     TEXT    NOT NULL,          -- 'ok' | 'guard' | 'trello' | 'internal' | 'denied'
  status      INTEGER,                   -- HTTP status      (kind='http' only)
  attempts    INTEGER,                   -- >1 means a retry (kind='http' only)
  duration_ms INTEGER,
  login       TEXT
);

-- D1 bills rows SCANNED, not returned, and hitting the daily read cap halts
-- WRITES as well as reads. Every /api/usage query is bounded by ts, so these
-- two indexes are what keep the panel's cost flat as the table grows.
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_kind_name_ts ON usage_events(kind, name, ts);
