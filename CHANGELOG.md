# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.18.0] — 2026-07-27

Second custom-fields pass, closing the gaps the v1.17.0 review left open. Two
new tools (99 → 101), two real defects fixed, and custom-field values now
appear everywhere cards are shown instead of only in `get_card`.

### Fixed
- **`copy_card` could not preserve custom-field values — and refused to try.**
  `COPY_KEEP_TOKENS` omitted `customFields`, and because the guard validates
  tokens *before* calling Trello (Trello silently ignores unrecognised ones),
  passing it was rejected outright. Atlassian's own announcement — "Custom
  Fields now required to be specified in keepFromSource when copying a card" —
  is about exactly this parameter, so `all` is not a safe assumption. The token
  is now accepted and both tool descriptions say to name it explicitly.
- **Custom-field edits were invisible in `card_activity_log`.** The default
  filter covered moves, due dates, labels, attachments, comments and
  checklists, but not `updateCustomFieldItem` — so "when did Priority change to
  High?" was unanswerable even though Trello records it.

### Added
- **`batch_set_card_custom_field`** — set the same field to the same value
  across up to 50 cards. The win is the resolution work, not the writes: the
  field is resolved and the value type-checked once per board rather than once
  per card. Follows the `batch_add_label` shape (continues past per-card
  failures, reports them in `skipped`).
- **`rename_custom_field_option`** — Trello's Custom Fields API has GET / POST /
  DELETE on options but no PUT, so an option's label is immutable, and the
  obvious workaround (delete + re-add) silently clears the field on every card
  pointing at the old option. This builds the rename from the primitives that do
  exist, in the order that's safe if it dies halfway: add the new option →
  re-point affected cards → delete the old one. If any card fails to move it
  stops and leaves **both** options in place rather than destroying values.
- **`create_card` accepts a `customFields` array.** Trello can't set custom
  fields on `POST /cards`, so they're applied as follow-up calls and reported
  per field. A failure does not fail the tool: the card already exists, and
  reporting a hard error would invite a retry that creates a duplicate.
- **`customFields: true` on every card-listing read** — `list_cards`,
  `list_cards_by_list`, `search_cards`, `search_cards_advanced` and
  `weekly_review_pack`, joining `get_card` from v1.17.0. Cost is bounded by the
  number of boards touched, not cards: values ride along on the card fetch, and
  definitions are memoised.
- **Dashboard and digest render custom-field values as badges** when the board
  has any — deliberately quieter than the label badges, since a custom field is
  data *about* a card rather than a flag *on* it. Both surfaces degrade to
  rendering nothing if the definitions can't be read, matching how the digest
  already treats snoozed cards: the morning email must never die because a
  Power-Up read failed.

### Changed
- **Custom-field definitions are memoised per board on the client.** v1.17.0
  made every custom-field write resolve its definition first (to type-check the
  value), which turned a bulk update into an extra GET per card. A `TrelloClient`
  is built per MCP session / dashboard request, so the cache is naturally
  short-lived and bounded; all five mutations invalidate it, so a stale
  definition can never outlive its own change.
- **`add_custom_field_option` and `delete_custom_field_option` take a `board`**
  for name resolution, consistent with the other custom-field tools.

### Known limitations
- `search_cards_advanced` still cannot *filter* on custom-field values —
  Trello's search syntax has no operator for them. `customFields: true`
  annotates the results so the returned rows can be filtered, but it cannot
  narrow the search itself.
- The `customFields` token fix is based on Atlassian's published announcement;
  it has not been verified against a live copy, because the board this server
  targets currently has no custom fields defined to copy.

## [1.17.0] — 2026-07-27

Custom-fields pass. The eight custom-field tools worked, but they were the
least ergonomic corner of the server: raw 24-char IDs everywhere, no type
safety, and read output you had to join by hand. No new tools — still 99.

### Fixed
- **`updateCustomField` silently opted out of the retry loop** (`client.ts`) —
  it hand-builds its URL so Trello's `display/cardFront` key keeps its literal
  slash (`URLSearchParams` emits `%2F` and Trello drops the key), and it
  hand-rolled `fetch()` to match. That skipped `retryableFetch`, so a 429 or a
  transient 5xx during a field rename threw instead of backing off — the only
  call in the client without that protection. It now passes the pre-built URL
  to `retryableFetch` and keeps the slash.

### Added
- **Fields resolve by name, not just ID** — every custom-field tool accepts a
  field name (case-insensitive) wherever it took a `customFieldId`, matching
  how boards, lists and plugins already resolve. List-type options resolve by
  their label too. Names are looked up on the tool's `board` param (default
  board when omitted); `set_card_custom_field` infers the board from the card.
  An ambiguous name is refused with the candidate IDs rather than guessed.
- **`get_card({ customFields: true })`** — includes the card's custom-field
  values, named and typed. Opt-in: the values ride along on the existing
  request, but joining them to their definitions costs one extra call and
  `get_card` is a hot path.

### Changed
- **`set_card_custom_field` validates the value against the field's type** —
  sending `{ text }` to a number field previously produced an opaque Trello 400
  or a silent no-op. It now refuses before spending the write, naming the key
  that field actually wants. It also refuses a `listOptionId` belonging to a
  different field; Trello accepts a foreign option ID and stores an
  unresolvable reference.
- **`list_card_custom_fields` joins against the board's definitions** — rows
  now carry `name` and `type`, list-type values resolve to the option's
  **label** rather than only an opaque `idValue`, and fields that have never
  been set are returned with `value: null`. Trello omits unset fields entirely,
  which made "unset" and "no such field" indistinguishable. Items whose
  definition has since been deleted are dropped rather than surfaced with a
  bogus name. `id` is now `string | null` (null for a never-set field).
- **`delete_custom_field` requires `confirm: true`** — it erases the field's
  value on every card on the board, the only cross-card destructive operation
  in the server (there is still no hard delete for cards anywhere). The
  refusal names the field; the success response reports what was removed.
- **"Power-Up not enabled" is now an actionable error** — Trello returns `[]`
  both when the Custom Fields Power-Up is off and when it's on with no fields
  defined. The empty path is now disambiguated against `list_board_plugins`
  and, when the Power-Up is off, the error names the `enable_board_plugin`
  call that fixes it. Applies to `list_custom_fields` and `create_custom_field`.
- **`add_custom_field_option` / `delete_custom_field_option` refuse non-list
  fields** — previously passed straight through to Trello.
- **`color` on `add_custom_field_option` is an enum** — Trello's palette is
  fixed, so a bad token fails at the tool boundary instead of at Trello.
- **`set_card_custom_field`'s `value` union is `.strict()`** — a two-key value
  like `{ text, number }` is now rejected. Non-strict Zod objects silently
  dropped the extra key and wrote whichever one matched first.

### Known limitation
- `search_cards_advanced` still cannot filter on custom-field values — Trello's
  search syntax has no support for them, so it would need client-side filtering
  after a fetch. Documented in the README rather than worked around.

## [1.16.1] — 2026-07-10

Refactor + bug-hunt pass over the v1.15/v1.16 code (previous hunts covered
through v1.14.1).

### Fixed
- **Wake-now success no longer reported as failure** (`page.html`) — a failed
  board refresh after a successful `/api/wake` showed "Couldn't wake",
  re-enabled the button (whose retry then errors), and left a stale snooze
  row. Wake and refresh errors are now handled separately (same rule as
  capture).
- **Optimistic Done/Move updates survive concurrent refreshes** — the update
  mutated a card object captured before the await; a `visibilitychange`
  refetch replacing `CARDS` in between orphaned it, popping the card back
  into its old column. The card is now re-found after the await.
- **Transient `/api/snoozed` failure no longer zeroes the panel** — the
  refresh error path kept `SNOOZED = []`, flipping the stat to 0 and an open
  panel to "nothing snoozed"; previously-loaded data is now kept.
- **`/api/undo-done` reordered for failure-safety** — it cleared `dueComplete`
  before moving back, so a mid-sequence Trello failure stranded the card in
  Done-do, flag cleared, invisible to board and Butler. It now moves back
  first (Butler triggers on the marking action, not state, so no bounce);
  a failed flag-clear leaves the card visible. Test pins the order.
- **Overdue badges carry the year when it differs** (`dueBadge`) — the
  dashboard's new badge had reintroduced the "15 Jul could be last year"
  defect the digest fixed in v1.14.1.
- **Dark mode: overdue-wake text readable** — `.snz-row .meta.overdue` kept
  its light-mode red (contrast ≈2.1:1 on the dark row); now `#f2b8b5` like
  every other red element.
- **Documented** (docs/snooze-v2.md): a card woken via `wake_card` keeps its
  Power-Up pluginData forever (REST can't clear it), so re-archiving it later
  makes it reappear as an eternal "overdue wake" — with UI-side mitigations.

### Changed
- **Refactor (behavior-neutral)**: `src/cookies.ts` — one cookie parser
  replacing three hand-rolled copies in `workers-oauth-utils.ts` (+ the
  original in `dashboard/session.ts`), the dedup flagged back in the v1.13.0
  audit; `readString()` body-field helper in `dashboard/api.ts`;
  `requireSession()` gate shared by `/dashboard` and `/digest/preview`;
  `titleLink()` replacing the thrice-duplicated scheme-checked anchor in
  `digest/render.ts`.

## [1.16.0] — 2026-07-10

Improvements batch (11 items from the post-v1.15.0 review).

### Added
- **Installable dashboard (PWA-lite)**: web-app manifest + SVG icon
  (`/manifest.webmanifest`, `/icon.svg` — public routes), theme-color and
  apple-web-app meta tags. "Add to Home Screen" installs the dashboard as a
  standalone app.
- **Refresh on tab return**: the dashboard refetches board + snoozed data when
  the tab/app regains visibility (throttled to once per minute) — no more
  acting on an overnight-stale board.
- **Digest heartbeat (optional)**: set the `HEARTBEAT_URL` secret to a
  healthchecks.io-style ping URL and the Worker pings it after each successful
  cron send — a missing ping becomes an alert, so silent digest failures
  can't hide. Fail-soft: monitoring never fails the send.
- **`send_digest` MCP tool** (+1, total 99): send the "Todays Actions" email
  now from chat; marks the day's cron send done if inside the morning window.
- **Dark mode**: the dashboard follows `prefers-color-scheme` (full dark
  palette; `color-scheme: light dark`).
- **Due badges on dashboard cards**: red "overdue · 9 Jul" / "today HH:MM"
  badges — the digest's most useful signal, now on the live board.
- **Undo**: ✓ Done and Move toasts carry a 6-second Undo button. Undo-done
  uses a new `POST /api/undo-done` (clears `dueComplete` so Butler doesn't
  re-move the card, then moves it back).
- **Friday weekly-review digest**: on Fridays the email appends stale
  Waiting-for items (7+ days untouched) and could-do horizon counts — the
  GTD weekly-review nudge, from data already in the board snapshot.

### Changed
- **`src/index.ts` split**: all 99 tool registrations moved verbatim to
  `src/register-tools.ts` (~1,300 lines out); index.ts is now just the wiring
  (108 lines). The advertised MCP version now tracks `package.json` (was
  frozen at "1.11.0"). `snooze_read`'s description now points to
  `list_snoozed_cards` for real Power-Up state.
- **README**: documented the session kill switch — rotating
  `COOKIE_ENCRYPTION_KEY` instantly invalidates all dashboard sessions.
- **wrangler** 4.79 → 4.110.

## [1.15.0] — 2026-07-10

### Added
- **Snooze Power-Up integration** (read + wake; creating snoozes stays a
  Trello-UI action — Trello's REST API cannot write another plugin's data).
  Mechanism verified live: the Power-Up archives snoozed cards and stores the
  wake time in card-scoped `pluginData` (`{"snooze":{"idCard","unixTime"}}`),
  readable by our token; one call (`filter=closed&pluginData=true`) fetches
  everything. All parsing is fail-soft — the shape is undocumented.
  - **MCP** (+2 tools, total 98): `list_snoozed_cards` (name, home list,
    `wakeUp` ISO, `overdueWake` flag, sorted soonest-first) and `wake_card`
    (unarchives NOW; refuses cards not snoozed by the Power-Up, guards the
    home list). `snooze_read` (dueReminder-based) is unchanged.
  - **Dashboard**: fifth health-bar stat **"Snoozed"** — populated by a
    non-blocking fetch, click to expand a panel listing each snoozed card
    with wake time, home list, and a **Wake now** button
    (`GET /api/snoozed`, `POST /api/wake`; session/allowlist/Origin-gated
    like the rest).
  - **Digest**: **"Waking today"** section — snoozed cards whose wake time
    falls inside the local Copenhagen day (same DST-correct boundary as the
    due buckets), plus overdue wakes ("any moment"). Snoozed count added to
    the health bar. Best-effort: a failed snooze fetch omits the section,
    never kills the email.
- **Client**: `listArchivedCardsWithPluginData`, `getCardWithPluginData`,
  `unarchiveCard`; `TrelloCard` gains optional `pluginData`/`dateClosed`.
- **Tests** (+12, total 148): pluginData parsing (valid/foreign/malformed/
  bad-shape), snoozed listing (sorting, overdue flag, query pins), wake_card
  guard matrix + happy path, API routes, "Waking today" bucketing.

## [1.14.1] — 2026-07-10

### Fixed
Bug-hunt pass over the v1.14.0 digest code (security sweep was clean; these
are correctness/fidelity fixes):

- **KV sent-flag write no longer fails the run** — a transient KV error after
  a successful send previously threw out of `runScheduledDigest` (cron showed
  an exception) AND guaranteed a duplicate email from the next slot. The
  write is now fail-soft: logged, run still reports `sent`.
- **Manual test-send inside the 04–06 window now sets the sent flag** so a
  remaining cron slot doesn't email a near-identical digest minutes later.
  Outside the window it remains a pure test (never suppresses tomorrow's
  digest).
- **Email replica fidelity** (`src/digest/render.ts`):
  - Inbox column count badge now goes red whenever the inbox is non-empty,
    matching the dashboard's rule (the health-bar number already did).
  - The "Cards per list" overview panel is now included (was missing despite
    the full-replica goal).
  - Zero-width characters are stripped from description snippets, matching
    the dashboard (pasted content no longer shifts truncation or renders
    empty-looking snippets).
  - Overdue dates from a different year now include the year
    ("15 Jul 2024, 12:00") so a year-old card can't masquerade as recent.
- +6 regression tests (136 total).

## [1.14.0] — 2026-07-10

### Added
- **Daily email digest (Phase 2)** — "Todays Actions": a full, email-safe HTML
  replica of the dashboard, sent every day at 04:00 Europe/Copenhagen to
  `dann@bleeker-pedersen.dk` via [Resend](https://resend.com), with board data
  fetched at send time.
  - **DST-proof scheduling**: Cloudflare cron is UTC-only, so `wrangler.jsonc`
    fires at 02:00/03:00/04:00 UTC and `src/digest/scheduler.ts` sends exactly
    once, at the first firing whose Copenhagen hour is in [4, 6]. Later firings
    are free retry slots if the first attempt failed (Trello/Resend down).
    A KV sent-flag (keyed by local date, TTL 2 days, written only on success)
    guarantees once-per-day. EU DST switches at 01:00 UTC — before the first
    firing — so transition days need no special-casing.
  - **Email content** (`src/digest/render.ts`, pure function, no I/O): health
    bar with WIP status, an email-only **"Overdue & due today"** section
    (bucketed with the DST-correct local-day boundary from v1.13.0, actionable
    lists only), all five context columns, Waiting, Inbox, and Rolling Big
    Rocks — every card linking to Trello, plus a link to the live dashboard.
    Inline styles only; no JS, no external assets.
  - **Owner test routes** (session-gated like the rest of the dashboard):
    `GET /digest/preview` renders the exact email HTML in the browser;
    `POST /api/digest/send` sends one immediately.
  - **Fail-soft**: the Worker deploys and runs before the Resend account
    exists — a missing `RESEND_API_KEY` logs and skips instead of throwing.
    Resend failures are reported by status only (no upstream body leakage).
- **Tests** (+14, total 130): renderer zones/escaping/scheme-check, local-day
  due bucketing across the Copenhagen midnight, exclusion rules (dueComplete,
  closed, dividers, non-actionable lists), WIP-over marker, `hourInTz` on both
  2026 DST transition days, KV dedupe, retry-after-failure, fail-soft missing
  key, opaque Resend errors.

### Changed
- `src/index.ts` default export widened from the bare `OAuthProvider` to
  `{ fetch, scheduled }` — `fetch` delegates to the unchanged provider (HTTP
  behavior identical, verified against `wrangler dev`), `scheduled` runs the
  digest. New `triggers.crons` + `vars` (`DIGEST_FROM`/`DIGEST_TO`) in
  `wrangler.jsonc`; `RESEND_API_KEY` secret documented in README.

### Setup (manual, one-time)
- Resend account + verified sending domain (`bleeker-pedersen.dk`): three DNS
  records (DKIM TXT `resend._domainkey`, MX + SPF TXT on `send`) — they live on
  their own subdomains, so the root SPF/Simply mail setup is untouched.
- `wrangler secret put RESEND_API_KEY`.

## [1.13.0] — 2026-07-10

Audit release: full-codebase security review + bug hunt + maintainability pass.
The security review found **no exploitable vulnerabilities** (both OAuth flows,
cookie/HMAC primitives, dashboard API, page rendering, client, and guards were
examined); the low-confidence hardening notes it produced are fixed below.

### Fixed
- **`startOfDayMsInTz` DST day-boundary error** (`src/trello/tools.ts`) — the
  local-midnight computation assumed the UTC offset at midnight equals the
  offset now, so on the two Europe/Copenhagen DST transition days
  `list_cards_due scope:"today"` and `weekly_review_pack.due_today`
  mis-bucketed cards by one hour (and the returned midnight kept sub-second
  residue). Now derives the actual UTC instant of local 00:00:00 via a
  convergent two-pass offset correction. New regression tests pin the
  2026-03-29 spring-forward and 2026-10-25 fall-back days.
- **Non-idempotent POSTs are no longer retried on 5xx**
  (`src/trello/client.ts`) — a gateway 5xx can arrive after Trello committed
  the write (timeout-after-commit), so the automatic retry could duplicate
  cards/comments/attachments. 5xx retry is now limited to GET/PUT/DELETE;
  429 stays retried for every method (Trello rejected those before acting).
- **`/api/done` is now deterministic for cards without a due date**
  (`src/dashboard/api.ts`) — it still sets `dueComplete=true` (Butler triggers
  keep firing) but then moves the card to Done-do itself. Previously a
  no-due-date card silently stayed in its column forever (Butler's
  due-complete trigger never fires without a due date), and a page reload
  racing Butler "resurrected" done cards.
- **Trello 4xx no longer masquerade as 502** (`src/dashboard/api.ts`) — a
  stale/deleted cardId now returns 404 (422 for other Trello 4xx) with an
  opaque message; 502 is reserved for genuine Trello 5xx.
- **`batch_get` rejects paths containing commas** (`src/trello/tools.ts`) —
  Trello's `/batch` splits the joined parameter on commas with no escaping,
  so `?fields=name,desc` silently shattered into bogus extra requests and
  misaligned results. Now refused with a clear GuardError.
- **`/app/callback` failure handling** (`src/dashboard/handler.ts`) — a
  GitHub/token-exchange failure now returns a friendly 502 instead of an
  unhandled bare 500, and every exit path clears the one-time
  `__Host-DASH_STATE` cookie.
- **Dashboard page fixes** (`src/dashboard/page.html`):
  - `render()` no longer wipes half-typed quick-capture text (value, focus,
    and caret survive filter clicks and card actions).
  - After a failed Move, the dropdown resets to the placeholder so retrying
    the same destination re-fires (previously a silent no-op).
  - A successful capture followed by a failed board refresh no longer reports
    "Couldn't add" (which invited duplicate re-submits) — the created card is
    appended locally instead.
  - WIP-limit warnings returned by the API are now shown in the toast
    (previously dropped — the MCP surface warned, the dashboard didn't).

### Security hardening (no exploitable issue; defense-in-depth from the review)
- `esc()` in `page.html` now escapes single quotes; card links only render as
  anchors for `http(s)` URLs, mirroring the server's `sanitizeUrl` whitelist.

### Changed
- Small maintainability refactor in `src/dashboard/api.ts`: shared `trello()`
  client-construction helper.

## [1.12.0] — 2026-07-10

### Added
- **Web To-Do dashboard (Phase 1)** — a private, browser-accessible dashboard
  served by this same Worker, alongside (and without touching) the `/mcp`
  MCP surface. A later phase will add a daily email digest; this release is
  the interactive dashboard only.
  - **Routes** (all served by the OAuthProvider `defaultHandler`; the reserved
    `/authorize`, `/callback`, `/token`, `/register`, `/mcp` endpoints are
    untouched):
    - `GET /` → 302 to `/dashboard`.
    - `GET /dashboard` — the dashboard page (`src/dashboard/page.html`,
      imported as a wrangler Text module) for a valid allowlisted session;
      302 to `/app/login` otherwise.
    - `GET /app/login` / `GET /app/callback` / `GET /app/logout` — browser
      GitHub OAuth flow reusing the existing GitHub OAuth app
      (`scope read:user`), with a one-time `__Host-DASH_STATE` CSRF cookie
      (distinct from the MCP flow's `__Host-CONSENTED_STATE`).
    - `GET /api/cards?board=<id>` → `{ cards }`;
      `POST /api/move { cardId, list }` → `{ ok }`;
      `POST /api/done { cardId }` → `{ ok }` (sets `dueComplete=true`; the
      board's Butler automation moves the card to Done-do — same semantics
      as the `set_due_complete` tool);
      `POST /api/capture { name }` → 201 `{ card }` (destination is always
      the Inbox, chosen server-side).
  - **Auth**: `__Host-DASH_SESSION` cookie (`HttpOnly; Secure; SameSite=Lax;
    Path=/`, ~30-day expiry), payload `{ login, exp }` HMAC-SHA256-signed
    with the existing `COOKIE_ENCRYPTION_KEY`. Every gated request re-checks
    `ALLOWED_LOGINS`, so removing a login revokes dashboard access on the
    next request. `/api/*` returns JSON `401`/`403` (never a redirect);
    mutating routes also reject foreign `Origin` headers.
  - **Guard parity**: `/api/move` and `/api/capture` reuse the tools layer
    (`move_card`, `create_card`), so the dashboard obeys the exact same
    forbidden-list / read-only / WIP-warning guards as the MCP tools.
    Guard refusals surface as `403 { error }`; Trello upstream failures as
    an opaque `502` (no upstream body leakage); invalid input as `400`.
- **Tests** (+25, total 107): session cookie sign→verify round-trip, tamper /
  wrong-secret / expiry rejection, cookie-attribute pins (`dashboard-session.test.ts`);
  API session gate (401 no session, 401 tampered, 403 non-allowlisted,
  403 foreign Origin), `/api/cards` happy path + 400 + opaque 502,
  `/api/move` validation + happy path + guard refusal before any upstream
  call, `/api/done` semantics (`dueComplete=true` on the PUT), `/api/capture`
  validation + server-chosen Inbox destination (`dashboard-api.test.ts`).
  All with `globalThis.fetch` mocked — no real Trello calls.

### Changed
- `ALLOWED_LOGINS` moved from `src/index.ts` to `src/allowlist.ts` so the MCP
  guard and the dashboard share one allowlist. Import-only change; the MCP
  surface, tool registrations, and tool behavior are byte-for-byte unchanged.
- `signData` / `verifySignature` in `src/workers-oauth-utils.ts` are now
  exported (previously module-private) so the dashboard session cookie uses
  the exact same HMAC primitive as `__Host-APPROVED_CLIENTS`. No behavior
  change.
- `wrangler.jsonc`: added a Text module rule (`**/*.html`) so the dashboard
  page imports as a string. Additive; no effect on `/mcp`.

### Setup (manual, one-time)
- The GitHub OAuth app's **Authorization callback URL** must be broadened to
  the Worker origin root (e.g. `https://trello-mcp.<subdomain>.workers.dev/`)
  so both `/callback` (MCP flow) and `/app/callback` (dashboard flow)
  validate. GitHub accepts any `redirect_uri` at or below the registered
  path, so the existing MCP flow keeps working. See README → Setup.

## [1.11.0] — 2026-07-02

### Added
- **vitest test suite** — 82 unit tests across 7 files under `test/`:
  - `guards.test.ts` (14 tests) — every safety guard: FORBIDDEN refusal
    (Butler, Repeater Cards), READ_ONLY refusal (Rolling Big Rocks),
    composition via `assertCanWriteTo`, WIP-warning threshold logic.
  - `constants.test.ts` (16 tests) — `resolveBoard` / `resolveList` /
    `resolvePlugin` alias & raw-ID handling; reverse lookups; WIP-limit
    suffix parser.
  - `tools-helpers.test.ts` (17 tests) — `computeWakeUp` (null due,
    null reminder, `-1` reminder, valid case), `decodeBase64` (plain,
    data-URI prefix, whitespace, invalid, empty), `summariseCard` (missing
    `idMembers`, list alias resolution), `startOfDayMsInTz` (UTC baseline,
    CEST summer, CET winter).
  - `client-helpers.test.ts` (10 tests) — `clampLimit` (in-range,
    max ceiling, custom max, below-1 floor), `parseRetryAfterMs` (null,
    integer seconds, HTTP-date, past-date floor, unparseable fallback).
  - `client-request.test.ts` (5 tests) — mocks `globalThis.fetch` and
    verifies: 200 first try, 429→200 retry with `Retry-After` timing,
    persistent 5xx throws `TrelloError` after 3 attempts, non-retriable
    4xx does not retry, `key` + `token` land on the query string.
  - `client-methods.test.ts` (11 tests) — URL + param assertions for a
    representative sample of client methods. Includes explicit regression
    pins for:
    - v1.7.1: `setCardCover(color=purple)` does NOT put
      `idAttachment:null` in the cover blob.
    - v1.9.0: `updateCustomField(displayCardFront=true)` preserves the
      literal `/` in the URL (not `%2F`).
    - v1.9.0: `batchGet` normalises non-numeric response keys to
      `statusCode: 502` (not NaN).
    - v1.9.0: `markAllNotificationsRead` does not send the broken
      `ids=` param.
  - `set_card_custom_field.test.ts` (9 tests) — the polymorphic
    discriminated-union tool: `checkbox` / `date` / `number` / `text` /
    `listOptionId` / `null` payload dispatch, plus GuardError on invalid
    ISO date and non-finite number.
- **`test` job in CI** — `pnpm test` runs alongside `pnpm type-check` in
  `.github/workflows/ci.yml`.
- **Exports**: `computeWakeUp`, `decodeBase64`, `summariseCard`,
  `startOfDayMsInTz`, `clampLimit`, `parseRetryAfterMs` are now exported
  from their respective modules so tests can pin them directly. Also
  exported the `CardSummary` interface for test consumption.

### Fixed
- No runtime fixes in this release. The test suite validates existing
  behavior; if any assertion had failed, the corresponding fix would
  ship in v1.11.x.

## [1.10.0] — 2026-07-02

### Changed
Refactor pass surfaced by the v1.8.0 audit. No behavior changes except
`add_comment` now returns the created action ID (additive, not breaking).
Tool surface still 96.

**Extractions:**
- `CARD_FIELDS` + `MEMBER_FIELDS` constants in `constants.ts` — replaces
  12 duplicated field-selector strings across `client.ts`.
- `ROLLING_BIG_ROCKS_ID` constant now imported from `constants.ts` — was
  hardcoded in `tools.ts` with a misleading "pulled from constants.ts"
  comment.
- `warnIfWipExceeded(client, listId, boardId)` helper — replaces the 5-line
  post-write `[destCards, allLists] = Promise.all([...]); wipWarning(...)`
  pattern that appeared 4× (`create_card`, `move_card`, `copy_card`,
  `batch_move_cards`).
- `clampLimit(limit, max=1000)` helper — replaces 4 inline
  `Math.min(Math.max(limit, 1), 1000)` clamps.
- `retryableFetch(url, initFactory)` internal method on the client — the
  retry loop from `request()` and the entire duplicated retry loop from
  `addFileAttachment` now share one implementation. `addFileAttachment`
  shrunk from ~30 lines to ~15 while keeping FormData single-shot semantics
  (initFactory rebuilds the form per attempt).

**Type hygiene:**
- `ChecklistItem` interface now models `due?: string | null` and
  `idMember?: string | null` directly. The `ChecklistItemWithExtras`
  cast that shoehorned these in `tools.ts` is gone.
- `add_comment` returns `{ ok: true, commentId }`. Callers can immediately
  update / delete / react to the comment without a follow-up
  `read_comments` call. Previously the created action ID was thrown away.
- `list_my_actions` now returns `author` in each action, matching the
  siblings `card_activity_log` and `list_list_actions`. Was silently
  dropped before.

**Cosmetic:**
- Section comments in `tools.ts` — the stale `// READS (6)` /
  `// WRITES (9)` labels reflected v1.0.0 counts. Now explicitly labelled
  as v1.0.0-originals so future additions don't rewrite the boundaries.
- Trivial `aliasToId = alias => resolveList(alias)` local in
  `weekly_review_pack` removed; `resolveList` is called directly.

## [1.9.0] — 2026-07-02

### Fixed
All 18 bugs surfaced by the v1.8.0 audit workflow. No new tools; tool surface
still 96.

**READ_ONLY guard bypasses (4 tools):**
- `move_list`, `archive_list`, `archive_all_cards` — now refuse Rolling Big
  Rocks via `assertNotReadOnly` alongside the existing `assertWritable`.
- `convert_checklist_item_to_card` — refuses when the source card is on a
  READ_ONLY list and no `targetList` is provided (Trello births the new card
  on the source list otherwise).

**Silent-wrong-behavior:**
- `list_card_custom_fields` — parses Trello's `"true"`/`"false"` strings to
  booleans and stringified numbers to Numbers. Previously `"false"` was
  truthy and `"10"` sorted before `"9"`.
- `move_all_cards` — fetches the destination list directly via new
  `getList` client method instead of probing cards. Cross-board moves now
  work when the destination is empty.
- `batch_add_label` — real `TrelloError`s during label resolution are
  reported as "label lookup failed: {message}" instead of being collapsed
  to a spurious "label not found on board".
- `update_custom_field({displayCardFront})` — the `display/cardFront`
  param key is now sent with its literal slash instead of being
  `%2F`-encoded, which Trello was silently ignoring.

**Timezone (Cloudflare Workers run in UTC):**
- `list_cards_due({scope:"today"})` and `weekly_review_pack.due_today`
  now compute day boundaries in `Europe/Copenhagen` (new
  `DEFAULT_TIMEZONE` constant + `startOfDayMsInTz` helper).

**Response semantics:**
- `weekly_review_pack({board})` — throws `GuardError` for boards other
  than `dann-to-do`. The composite's list aliases resolve to that board
  only; calling it against `zoo` used to return all-zero buckets silently.
- `truncated` — false positive at exactly `MAX_RESULTS==200` items fixed
  in `list_cards`, `list_cards_by_list`, `list_archived_cards`,
  `list_my_cards_assigned`. Now compares pre-slice length.
- `list_notifications` — dropped the `.slice(0, MAX_RESULTS)` cap; the
  client already clamps to Trello's max of 1000, and the extra slice
  silently truncated `limit>200` requests.

**Comment / reaction guards:**
- `update_comment` / `delete_comment` — verify the `commentId`'s action
  belongs to the passed `cardId`. Previously a caller lying about
  `cardId` could touch a comment on a card whose list is FORBIDDEN.
- `add_comment_reaction` / `remove_comment_reaction` — gained optional
  `cardId`; either uses it as the verify check or derives the card from
  the action. Both now run `assertCardWritable`.
- `mark_all_notifications_read` — dropped the `filter` param. Trello's
  endpoint doesn't accept per-type filtering; the old code passed the
  type string as `ids=` (a Trello notification-ID list) and silently
  marked nothing. Type-filtered clearing must now be composed at the
  caller side via `list_notifications` + `mark_notification_read`.

**Client-layer HTTP:**
- `request()` retry — `Retry-After` header parsing now accepts RFC 7231
  HTTP-date format in addition to integer seconds. Previously HTTP-date
  values fell through to the 500 ms base delay.
- `batchGet` — non-numeric keys in Trello's response envelope (e.g.
  `{"error": "..."}`) now surface as `statusCode: 502` with the entry
  preserved, instead of `statusCode: NaN` that silently broke `>= 400`
  comparisons.

### Added
- `getList(listId)` client method — needed by `move_all_cards` fix; also
  exported for use by any future single-list read.
- `DEFAULT_TIMEZONE = "Europe/Copenhagen"` in `constants.ts`.

### Changed
- Tool signatures (breaking for anything hard-coding them):
  - `add_comment_reaction` and `remove_comment_reaction` now accept an
    optional `cardId` for verification.
  - `mark_all_notifications_read` no longer accepts `filter`.

## [1.8.0] — 2026-07-02

### Added
- **Custom Fields Power-Up (8 tools):** `list_custom_fields`, `create_custom_field`
  (checkbox / date / list / number / text), `update_custom_field`,
  `delete_custom_field`, `add_custom_field_option`, `delete_custom_field_option`,
  `list_card_custom_fields`, polymorphic `set_card_custom_field` accepting
  `{checked}` / `{date}` / `{number}` / `{text}` / `{listOptionId}` or `null`.
  Reverses the earlier "no Custom Fields" call.
- **Plugin / Power-Up management (4 tools):** `list_board_plugins`,
  `enable_board_plugin` (alias-aware: `custom-fields` / `card-aging` /
  `voting` / `calendar`), `disable_board_plugin` (takes the boardPlugin `id`
  from `list_board_plugins`, **not** the raw plugin id — Trello REST quirk),
  `get_plugin`.
- **Single-entity fetches (2 tools):** `get_label` (accepts ID or name +
  board), `get_attachment` (richer than `list_attachments` — `previews[]`,
  `edgeColor`, `pos`).
- **Actions & reactions (3 tools):** `list_comment_reactions_summary`
  (grouped counts), `get_action`, `get_action_display` (Trello's
  pre-rendered activity string).
- **Batch (1 tool):** `batch_get` — Trello `/batch`; up to 10 relative
  paths in one request; per-URL `{statusCode, body}`.
- **Archived reads (1 tool):** `list_archived_cards` — `/boards/{id}/cards/closed`
  with optional label + `staleDays` filters.
- New client types: `TrelloCustomField`, `TrelloCustomFieldOption`,
  `TrelloCustomFieldItem`, `TrelloReactionSummary`, `TrelloPlugin`,
  `TrelloBoardPlugin`.
- Client `request()` now supports JSON request bodies (required for the
  custom-field value setter).
- `PLUGIN_ALIASES` + `resolvePlugin` helper in `constants.ts`.

### Changed
- Tool surface: **77 → 96**.

## [1.7.1] — 2026-07-02

### Fixed
- `set_card_cover` no longer wipes the requested color. When only a color
  was supplied, the tool was coercing missing `attachmentId` to `null` and
  the client was writing `idAttachment: null` into the cover blob, which
  Trello treats as "clear the cover" and dropped the color too. Both the
  tool and client now strip `null` from the cover payload; only defined,
  non-null facets reach Trello.

## [1.7.0] — 2026-06-13

### Added
- **Voting (3 tools):** `vote_card`, `unvote_card`, `list_card_voters`.
- **Comment reactions (3 tools):** `add_comment_reaction` (Trello shortName
  like `"thumbsup"` / `"white_check_mark"`), `remove_comment_reaction`,
  `list_comment_reactions`.
- **Bulk hygiene (2 tools):** `copy_checklist` (via `idChecklistSource`),
  `mark_card_notifications_read` (`POST /cards/{id}/markAssociatedNotificationsRead`).
- **Inspection reads (4 tools):** `list_list_actions` (`/lists/{id}/actions`),
  `list_my_actions` (`/members/me/actions` cross-board),
  `list_board_memberships` (richer than `list_board_members` — adds
  `memberType` admin/normal/observer/virtual + confirmation state),
  `get_member` (any-member profile lookup).
- New client types: `TrelloReaction`, `TrelloMembership`.

### Changed
- Tool surface: **65 → 77**.

## [1.6.0] — 2026-06-13

### Added
- **List management (6 tools):** `create_list`, `rename_list`,
  `archive_list`, `move_list` (reposition + cross-board), `move_all_cards`
  (bulk; destination board derived from a probe), `archive_all_cards`.
- **Card cover (2 tools):** `set_card_cover` (palette color OR existing
  attachment; optional `size` + `brightness`), `clear_card_cover`.
- **Checklist item updates (3 tools):** `set_checklist_item_due`,
  `assign_checklist_item_member`, `reorder_checklist_item` — all via one
  new `updateChecklistItem` client method.
- **Label edit (1 tool):** `update_label` (rename + recolor).
- **Subscribe (2 tools):** `subscribe_card`, `subscribe_list`.
- **Notifications (3 tools):** `list_notifications` (filter + read-state +
  cursor pagination via `since`/`before`), `mark_notification_read`,
  `mark_all_notifications_read` (optional type filter).
- New client types: `TrelloNotification`, `TrelloCardCover`.
- `TrelloCard` gains `subscribed` + `cover`; `TrelloList` gains `pos` +
  `subscribed`.

### Changed
- Tool surface: **48 → 65**.

## [1.5.0] — 2026-06-13

### Added
- **Members (4 tools):** `list_board_members`, `list_card_members`,
  `add_member_to_card`, `remove_member_from_card` — `member` accepts ID /
  username / full name resolved on the card's board.
- **Named checklists (3 tools):** `create_checklist(name)`,
  `rename_checklist`, `delete_checklist`.
- **Card ops (2 tools):** `copy_card` (`idCardSource` + `keepFromSource`,
  with token validation), `set_due_reminder` (minutes-before-due, `null`
  clears).
- **Comment edits (2 tools):** `update_comment`, `delete_comment` via
  `PUT/DELETE /actions/{id}`.
- **Cross-board (1 tool):** `list_my_cards_assigned` via
  `/members/me/cards`.
- **Composite (1 tool):** `weekly_review_pack` — single call returning
  inbox sample + overdue + due-today + due-this-week + context-list counts
  + waiting-stale + could-do horizon counts + snoozed + big-rocks.
- New client type: `TrelloMember`. `TrelloCard` gains `idMembers`.
- `CardSummary` + `CardDetail` gain `memberIds`.

### Changed
- Tool surface: **35 → 48**.
- `updateCard` learns `dueReminder`.

## [1.4.1] — 2026-06-13

### Added
- `delete_label` — board-wide destructive delete via `DELETE /labels/{id}`.
  Accepts label ID or name (resolved against the named board).

### Changed
- Tool surface: **34 → 35**.

## [1.4.0] — 2026-06-13

### Added
- **Reads (7 tools):** `list_cards_due` (`today` / `overdue` /
  `next_seven_days`; decorated with `snoozed` + `wakeUp`),
  `list_cards_by_list` (per-list with `excludeDueDates` /
  `includeSnoozedOnly` / `staleDays`), `search_cards_advanced` (Trello
  operators + multi-board), `read_comments` (chronological),
  `list_labels`, `card_activity_log` (curated filter set), `snooze_read`
  (cards with `dueReminder`, sorted by computed wake-up).
- **Writes (7 tools):** `set_card_position` (top / bottom / numeric),
  `set_start_date`, `create_label` (palette-validated),
  `remove_checklist_item`, `convert_checklist_item_to_card` (native Trello
  endpoint; optional `targetList`), `batch_add_label` (≤50 cards,
  per-card skip reasons), `batch_move_cards` (≤50 cards, guards + WIP).
- `TrelloCard` gains `start` + `dueReminder`. New types: `TrelloAction`,
  `TrelloComment`.

### Notes
- **Snooze semantics.** Trello has no native snooze in its REST API. The
  `snooze_read` tool surfaces `dueReminder` (a reminder OFFSET, minutes
  before due) under the GTD vocabulary. `wakeUp = due - dueReminder min`.

### Changed
- Tool surface: **20 → 34**.

## [1.3.0] — 2026-06-12

### Added
- `add_file_attachment` — real file uploads via base64 → multipart. Hard
  cap 10 MB decoded. Client `addFileAttachment` builds `FormData` with a
  `Blob` and posts to `/cards/{id}/attachments` with the standard `file`
  field. Auth stays on the query string. `data:...;base64,` prefix is
  tolerated.

### Changed
- Tool surface: **19 → 20**.

## [1.2.0] — 2026-06-12

### Added
- **Checklist state (1 tool):** `set_checklist_item_state` — tick / untick
  a single checklist item.
- **URL attachments (3 tools):** `list_attachments`, `add_attachment`
  (URL-only), `remove_attachment`.

### Changed
- Tool surface: **15 → 19**.

## [1.1.0] — 2026-06-12

### Fixed
- `list_cards` and `search_cards` responses now include `desc` (regression
  vs the retired local Python MCP). `CardDetail` no longer duplicates the
  field.

## [1.0.0] — 2026-06-12

### Added
- Initial Cloudflare Workers MCP server with GitHub OAuth (allowlist:
  `dannbleeker`).
- 15 generic Trello tools covering board / list / card reads and card
  writes (create, move, update, archive, label add/remove, comment,
  checklist add, due-complete, checklist item listing).
- Friendly aliases for boards (`dann-to-do`, `zoo`) and 18 lists.
- Server-side guards: FORBIDDEN_LISTS (Butler, Repeater Cards),
  READ_ONLY_LISTS (Rolling Big Rocks), WIP-limit warnings.

[1.11.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/dannbleeker/trello-mcp/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/dannbleeker/trello-mcp/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dannbleeker/trello-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dannbleeker/trello-mcp/releases/tag/v1.0.0
