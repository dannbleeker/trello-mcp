# Snooze v2 — design note (not built)

*Written 2026-07-10, after the v1.15.0 Snooze read/wake integration. Status:
researched and deliberately **not** built. This note preserves the findings and
the design so it can be picked up later without redoing the investigation.*

## The goal it would serve

Let the owner **create** snoozes from our surfaces — an MCP `snooze_card` tool
("snooze this card until Monday" in chat) and a per-card snooze control on the
web dashboard. v1.15.0 already covers the *read* half (`list_snoozed_cards`,
dashboard panel, digest "Waking today") and the *wake* half (`wake_card`).

## Why we can't create genuine Power-Up snoozes (settled, don't re-research)

- The board's Snooze Power-Up (`SNOOZE_PLUGIN_ID` in `src/trello/constants.ts`)
  is **"Card Snooze" — first-party, made by Trello Inc**, hosted at
  `card-snooze.trello.services`. There is no vendor backend or API to call.
  It archives the card, writes card-scoped pluginData
  (`{"snooze":{"idCard","unixTime"}}`), and an internal Trello scheduler
  unarchives at `unixTime`.
- **pluginData is GET-only over REST, for everyone.** Official docs, verbatim:
  "Currently, PUT, POST, and DELETE methods are not supported for managing
  pluginData." No exception for a plugin's own API key.
- Trello's web client writes pluginData through an **undocumented internal
  endpoint** (`POST /1/{scope}/{idModel}/pluginData`) authenticated by browser
  session cookie + a `dsc` CSRF token — unusable from a Worker, and the write
  is bound to the calling plugin's iframe identity, so data attributed to
  Card Snooze cannot be forged. (Community prior art confirms the key+token
  attempt is a dead end.)
- **Butler cannot express the wake half**: it can archive on a trigger, but
  scheduled/calendar commands can never select archived cards, and due-date
  triggers die on archive.

## The design that works: replicate the mechanism with primitives we own

**Snooze (write):** archive the card + record the wake time in a **`WakeAt`
Custom Field** (date type). The Custom Fields Power-Up is enabled on the board
(no fields defined as of writing — greenfield), it is fully REST-writable, and
`create_custom_field` / `set_card_custom_field` tools already exist. Using a
custom field (not the native `due` date) avoids clobbering real due dates.

**Wake:** the Worker cron scans archived cards and unarchives those whose
`WakeAt` has passed. One API call covers the scan:
`GET /boards/{id}/cards?filter=closed&customFieldItems=true`.
Granularity decision (was left open): the existing 02/03/04 UTC crons give
daily wakes at ~04:00 alongside the digest; adding `0 * * * *` gives hourly
wakes ("snooze until this afternoon") at the cost of one cron line.

**Unified interface:** `list_snoozed_cards` merges both sources — Power-Up
pluginData snoozes (Trello's scheduler wakes those) and `WakeAt` snoozes (our
cron wakes those) — so the dashboard panel, digest "Waking today", and chat
see one list. `wake_card` needs its not-a-blind-unarchiver guard widened to
accept either marker. New surface: `snooze_card {cardId, until}` MCP tool and
`POST /api/snooze` + a snooze control on dashboard cards (e.g. tomorrow /
next week / pick a date).

## Known pitfalls (design around all three)

1. **Archived cards fire no due-date reminders and Butler ignores them** — the
   cron must own waking entirely (it already does for v1.15.0 reads).
2. **Archived cards are hidden from default search** — all reads must opt in
   via `filter=closed` (v1.15.0 already does).
3. **Asymmetry with the Power-Up**: snoozes we create won't appear in Trello's
   own Card Snooze UI (its backend only knows pluginData it wrote), and its
   scheduler won't wake them. Ours-wake-ours, theirs-wake-theirs; our surfaces
   display both.

## Cleanup rule

On wake (cron or `wake_card`), clear the card's `WakeAt` value so a stale date
can't re-trigger a snooze-scan later. Mirror the v1.14.1 lesson: the clear must
be fail-soft — a failed field-clear after a successful unarchive must not
throw, only log (and the scan should treat `WakeAt <= now` on an OPEN card as
already-woken, never as actionable).

## Known limitation of the v1.15 read path (documented, not fixable)

A card woken via `wake_card` / "Wake now" keeps its Snooze pluginData forever
(REST cannot clear another plugin's data). If that card is later archived
normally, it re-appears in `list_snoozed_cards`, the dashboard panel, and the
digest as an eternal "overdue wake" — indistinguishable from a genuine
Power-Up wake that hasn't fired yet. Whether Trello's Card Snooze backend
cleans its own pluginData when its scheduled fire becomes a no-op is
undetermined. Mitigation if it ever bothers: waking via the Trello UI's own
Snooze button (instead of ours) lets the Power-Up clean up after itself; or
un-archive + re-archive from the Trello UI archive view.

## Effort estimate

v1.15.0-sized: one custom-field bootstrap (create `WakeAt` if missing), one
tool + one API route + dashboard control, cron scan extension, ~12 tests.
The read/wake infrastructure from v1.15.0 does half the work.
