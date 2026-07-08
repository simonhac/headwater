# Headwater — reliability hardening

## Context

During the Headwater rebrand backfill, a full `/admin/replay` reported `posted: 29, merged: 15,
errors: 2` — 2 of 46 events threw transiently (a D1 / station-lookup hiccup during the burst). **No
data was lost** (see the durability model below) and a plain re-run filled the two gaps, but it
exposed two things worth fixing:

1. Feed *completeness* currently depends on a human noticing a failure and re-running replay.
2. There is one latent bug where a transient failure causes **permanent** loss of a syndicated
   outlet.

Goal of this doc: make transient failures **self-heal**, so no inbound mention is ever dropped from
the feed without operator action.

## Current durability model (what already protects us)

The design is sound at its core and should be preserved:

- **Archive-first.** `src/index.ts:61` writes the raw payload to `webhook_events.raw_json`
  **before** any processing. Processing runs in `waitUntil` and its only failure handling is to
  *log* the error (`src/index.ts:73`). So the inbound payload survives any downstream failure — D1,
  station lookup, or Slack. **The archive is the source of truth; the Slack channel is a derived,
  rebuildable projection.**
- **Idempotent replay.** `/admin/replay` (`src/lib/replay.ts`) reprocesses the archive through the
  same pipeline. Dedup (`seen_mentions`) and merge (`stories`) are keyed, so replay is safe to run
  repeatedly and only fills gaps. `reset=1` rebuilds dedup state from scratch; `purge=1` clears the
  channel first; `limit=N` regenerates just the most recent N.
- **Slack rate-limit handling.** `slackCall` (`src/lib/slack/post.ts`) honours HTTP 429
  `Retry-After` up to 8×. In the **post** path, a Slack failure leaves the mention un-`seen`
  (`src/lib/process.ts:193`, `seen.add` only inside `if (r.ok && r.ts)`) so a later replay retries it.

## Gaps

### G1 — merge path marks `seen` even on failure (correctness bug)
`src/lib/process.ts:166`:
```ts
if (upd.ok) await stories.updateOutlets(...);
await seen.add(dedupeKey, mention.url ?? "", now);   // ← runs even when upd FAILED
```
Unlike the post path, the merge path calls `seen.add` unconditionally. If a syndicated mention's
`chat.update` fails transiently, the mention is marked `seen`, so a normal (`reset`-less) replay
**skips it forever** — that outlet and its contribution to "N outlets · combined reach" are lost.
This is the only place a transient failure causes permanent loss today.

### G2 — recovery is manual
Nothing retries a failed event automatically; it stays archived-but-unposted until someone runs
replay.

### G3 — ingestion write is the one true single-point-of-loss
If `eventLog.append` (`src/index.ts:61`) throws, nothing is archived. It currently propagates to a
500 and relies on the sender (Meltwater) retrying — a policy we have not verified.

### G4 — no visibility into drift
There's no signal for "archived but never posted", so a gap is found by chance, not by monitoring.

## Plan (prioritized)

### P0-1 · Fix the merge `seen.add` (one line)
Gate `src/lib/process.ts:166` on `upd.ok`, mirroring the post path:
```ts
if (upd.ok) {
  await stories.updateOutlets(existing.story_key, outlets, briefLabels, now);
  await seen.add(dedupeKey, mention.url ?? "", now);
}
```
- **Effect:** a failed merge stays un-`seen`, so replay/reconcile retries it.
- **Verify:** stub `updateSlack` to fail once → mention not in `seen_mentions` → a follow-up replay
  folds the outlet in. Add an integration test for this.

### P0-2 · Scheduled reconcile (Cron Trigger) — the self-healing loop
`wrangler.jsonc` already has the placeholder (`"triggers": { "crons": ["*/15 * * * *"] }`).
- Add a `scheduled()` export to the Worker that calls a **windowed, non-reset** replay
  (`replayArchivedEvents` with a new `sinceMs`, bounded to the 72h syndication window).
- Because replay is `seen`-aware, the tick reprocesses the recent window and only the un-posted
  stragglers actually re-post; everything already done is skipped as a duplicate.
- **Depends on P0-1** — otherwise failed merges aren't recoverable and the reconcile can't catch them.
- **Verify:** force a transient Slack failure on one event, confirm the next cron tick reposts it and
  leaves everything else untouched.

### P1-1 · Harden ingestion (close G3)
- Retry `eventLog.append` a couple of times with a short backoff; on final failure return **5xx** so
  the sender retries (don't swallow it into a 200).
- Confirm Meltwater's retry behaviour on non-2xx.
- **Stretch:** put a **Cloudflare Queue** in front — the webhook handler enqueues the raw body and
  acks; a queue consumer processes with built-in retries + a dead-letter queue. This makes ingestion
  at-least-once end-to-end.

### P1-2 · Observability (close G4)
- Add to `/health`: counts of `decision = 'error'` and archived-but-unposted events (a drift gauge).
- Add a "failed" filter/badge to `/inspect`.
- Optional: emit to logs / Sentry when drift exceeds a threshold.

## Guiding principle

Replay idempotency is the linchpin — keep dedup/merge keyed and side-effect-safe so the reconcile
loop can run unattended. **P0-1 + P0-2 together deliver "transient failures self-heal, nothing
dropped"; P1 items are defense-in-depth.**

---
_Note: the repo also has a `doc/` (singular) directory (`doc/added-by.md`). This file was created at
`docs/` as requested; consider consolidating to one location._
