# Usage tracking

Per-tool and per-endpoint usage for the MCP connector, added in v1.21.0.

The Cloudflare request count tells you the Worker was busy. It cannot tell you
*which of the 102 tools Claude actually reaches for* — which is the number you
need before deciding whether a 102-tool surface earns the context it costs on
every conversation. That is what this records.

## What gets recorded

Two event kinds, in one table and one Analytics Engine dataset:

| kind | one row per | `name` |
|---|---|---|
| `tool` | MCP tool call | the tool, e.g. `list_cards` |
| `http` | Trello REST call | `GET /cards/{id}` — method + templated path |

They are deliberately not 1:1. `weekly_review_pack` is **one** `tool` row and
about a dozen `http` rows; that fan-out is the whole point of having both.

Every row also carries:

- **`surface`** — `mcp`, `dashboard` or `cron`. All three share the Trello
  client, so without this a dashboard refresh looks like MCP traffic.
- **`outcome`** — `ok`, `guard`, `trello`, `internal`, `denied`. The failure
  modes are kept apart on purpose: a tool that routinely returns `guard` is
  usually a *tool-description* problem (Claude calling it wrongly), which is far
  cheaper to fix than anything else on the list.
- **`status`** / **`attempts`** (`http` only) — `attempts > 1` means a retry
  happened, so "429s that eventually succeeded" and "429s that gave up" are
  distinguishable.
- **`duration_ms`**, **`login`**.

### What is never recorded

Argument **values**. Card titles, comment bodies and search queries are personal
data and must not end up in a log store. The recorder has no argument channel at
all — `src/usage.ts` accepts a name, an outcome and timings, and nothing else.
`test/usage.test.ts` pins this.

Nor does the raw request URL ever reach a sink: it carries `key` and `token` in
its query string, so the client passes the *path* to be templated instead.

## Where it goes

Three sinks, all optional, all fail-soft — a broken recorder must never turn a
working tool call into an error.

### 1. Analytics Engine (`USAGE`)

The long-term instrument. Writes are non-blocking (`writeDataPoint` returns
`void`; no `await`, no added latency) and the dataset is created automatically
on the first write — there is nothing to provision.

Retention is **3 months**. Free-plan allowance is 100,000 data points/day, which
this Worker will not come close to.

The data point is shaped to the documented limits, which are enforced in code
because neither local dev nor production will tell you when you exceed them —
miniflare's `writeDataPoint` is an empty function, and the real runtime silently
*drops* a malformed point:

| field | contents |
|---|---|
| `indexes[0]` | `name`, clamped to 96 bytes |
| `blobs` | `kind`, `surface`, `name`, `outcome`, `login` |
| `doubles` | `durationMs`, `status`, `attempts` |

Indexing by `name` is deliberate: Analytics Engine samples *per index*, so this
keeps per-tool counts exact even if volume ever triggers sampling.

### 2. D1 (`USAGE_DB`)

Unlimited retention, and — unlike Analytics Engine — readable from inside the
Worker. That is what lets the dashboard's Usage panel exist without shipping a
Cloudflare API token to the Worker just to draw a chart.

Rows are **buffered and flushed once per unit of work**, so a tool that makes 12
Trello calls costs one batched `INSERT`, not 13.

Schema: `migrations/0001_usage_events.sql` (already applied).

### 3. Workers Logs (`console.log`)

Free, already enabled via `observability` in `wrangler.jsonc`, and structured as
JSON so the fields are indexed rather than text-matched:

```json
{"evt":"usage","kind":"tool","surface":"mcp","name":"list_cards","outcome":"ok","ms":142}
```

Query it in the Workers Observability dashboard with `evt = "usage"`. Retention
is 3 days on the Workers Free plan, 7 on Paid — which is exactly why it is the
convenience sink and not the record.

## Reading the data

### The dashboard panel

`/dashboard` → **Usage**. Collapsed by default and lazy-loaded (it is a
diagnostic, not part of the daily board); the open/closed state persists. Tabs
switch between tools and Trello endpoints, over 7 / 30 / 90 days.

Reads `GET /api/usage?days=N` behind the existing session + allowlist gate.

### Analytics Engine SQL

Needs a Cloudflare API token with **Account → Account Analytics → Read**
(created at <https://dash.cloudflare.com/profile/api-tokens>; the
"Edit Cloudflare Workers" deploy token does **not** carry this permission) and
your 32-character account ID.

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  --data "SELECT blob3 AS tool, SUM(_sample_interval) AS calls
          FROM trello_mcp_usage
          WHERE timestamp > NOW() - INTERVAL '30' DAY AND blob1 = 'tool'
          GROUP BY tool ORDER BY calls DESC"
```

> **Always `SUM(_sample_interval)`, never `count()`.** Analytics Engine samples
> at high volume and `count()` silently under-reports once it kicks in. At this
> Worker's volume the sample interval is 1 and the two agree — which is exactly
> what makes the mistake easy to ship and hard to notice.

Column mapping: `blob1` kind, `blob2` surface, `blob3` name, `blob4` outcome,
`blob5` login, `double1` durationMs, `double2` status, `double3` attempts.

Busiest Trello endpoints:

```sql
SELECT blob3 AS endpoint, SUM(_sample_interval) AS calls
FROM trello_mcp_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'http'
GROUP BY endpoint ORDER BY calls DESC
```

Tools that fail most often:

```sql
SELECT blob3 AS tool, blob4 AS outcome, SUM(_sample_interval) AS n
FROM trello_mcp_usage
WHERE timestamp > NOW() - INTERVAL '30' DAY AND blob1 = 'tool' AND blob4 != 'ok'
GROUP BY tool, outcome ORDER BY n DESC
```

### D1 directly

```bash
wrangler d1 execute trello-mcp-usage --remote \
  --command "SELECT name, COUNT(*) c FROM usage_events WHERE kind='tool' GROUP BY name ORDER BY c DESC LIMIT 20"
```

**Which tools have never been called** — the question this whole feature exists
to answer. Compare the result against the tool table in the README:

```sql
SELECT DISTINCT name FROM usage_events WHERE kind = 'tool' ORDER BY name;
```

## Operational notes

- **Both bindings are optional.** With neither present the recorder no-ops, so
  the Worker runs unchanged — same fail-soft pattern as `RESEND_API_KEY`.
- **Local dev writes nothing.** Miniflare simulates the Analytics Engine binding
  with an empty function. The recorder code path still runs, so path-templating
  bugs surface locally; datapoint-shape mistakes do not, which is why they are
  unit-tested instead.
- **D1 bills rows scanned, not returned**, and hitting the daily read cap halts
  *writes* too. Every query above is bounded by `ts`, which the index covers.
- **If a deploy ever fails with `10089 no_access_to_analytics_engine`**, enable
  Analytics Engine at `dash.cloudflare.com/<account-id>/workers/analytics-engine`
  (under Workers & Pages — *not* Storage & Databases, a widely-repeated wrong
  path). No token change helps; there is no Analytics Engine token permission.
- **Pruning.** Nothing ages out of D1 automatically. If the table ever gets
  inconvenient: `DELETE FROM usage_events WHERE ts < <epoch-ms>;`
