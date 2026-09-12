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

## External monitoring (2026-09-12, revised same day)

Everything above is *internal*: it runs inside the Worker. That is the same shape as the failure
that made liveone's 2026-09-11 outage silent for 8h20m — *"every check that watched LiveOne ran
inside LiveOne and queried the database it was judging."* headwater's own ingestion heartbeat posts
to Slack from inside the Worker, so a dead Worker, a deleted cron trigger, or an uninstalled Slack
app all produce silence rather than an alert. That is what this closes.

### `/health` is the single assertion point

One BetterStack `keyword` monitor (4921263) polls `https://feed.moofer.com/health` every 180 s and
requires a 2xx **and** the literal `"configOk":true`. Verified empirically on 2026-09-12 — by
pointing a throwaway monitor at a 503 that still contained the keyword, which went `down` — and
**not** documented by BetterStack. It is the mechanism everything here rests on: *any* condition
that makes `/health` non-2xx is caught in ~6 minutes, with no new monitoring resource.

So every fault below is surfaced by failing `/health` closed rather than by adding a heartbeat. A
heartbeat's detection floor is its own period (1 h here); the monitor's is 180 s. Converting
improves detection roughly **20x** while consuming zero heartbeat slots — which matters, the account
is at its 10-heartbeat quota.

| check | fails when | catches |
| --- | --- | --- |
| `dbOk` | any `/health` D1 read throws | dead or unmigrated database |
| `checks.hourly` | the `0 * * * *` marker is older than 2 h | Worker deleted, broken deploy, cron trigger removed, account suspended |
| `checks.quarterHourly` | the 15-minute marker is older than 45 min | the reconcile / render-poke / digest-send tick has stopped |
| `checks.processing` | events arrived, are still `decision='logged'` past 45 min, inside a 24 h window | queue consumer **and** reconcile both failing |
| `checks.feed` | no processed mention within the time-of-week threshold | ingestion stalled — the 2026-07 outage |
| `checks.failures` | a failed event is older than the reconcile heal window | drift that will never self-heal |

### The trade-off, and what pays for it

One monitor means one alarm, so the diagnosis moves out of the alert's *name* and into its *body*.
Two things pay that back and both are load-bearing: every condition is a **separately visible
boolean/number** in the JSON (read `checks` first when this goes red), and every predicate is a
**pure function with unit tests** (`src/lib/health.ts`, `test/health.test.ts`) — because the risk of
a single assertion point is a bug that silently narrows coverage with nothing testing it.

### `null` is healthy; staleness is the signal

A marker that has never been written, or an archive with nothing in it, reads **healthy**. Absence
only occurs before the first tick after a fresh database, and failing there would 503 every
deployment for up to 15 minutes — paging on a routine deploy. Only a marker that has gone *stale*
is a fault.

### Cron tick markers replaced the dead-man's-switch pings

`ops_state` records `cron:last_hourly_at` and `cron:last_quarter_hourly_at` at the end of each
`scheduled()` branch. Writing a marker proves D1 is **writable**, which is strictly stronger than
the ping it replaced (a successful *read*), and it is asserted on every 180 s rather than once an
hour. The two BetterStack heartbeats were therefore removed rather than kept alongside: they never
pinged in their short life, and a never-pinged heartbeat sits in `pending`, which is
indistinguishable from healthy and cannot alarm.

The hourly marker is written only when `runHeartbeat` resolved — it cannot resolve without two
successful D1 reads, so a resolved result *is* the liveness evidence. It deliberately does **not**
gate on `heal()`: the healer is a best-effort re-render, its failure is not a liveness failure, and
gating on it would let a failed Slack update silence the liveness signal. The quarter-hourly marker
is written unconditionally at the end of its chain — every step already swallows its own failure, so
reaching the end means the tick *ran*. It sits outside `reconcile()`, which early-returns when
`POSTING_ENABLED` is not `"true"`: a deliberately paused feed must not read as a dead cron.

The two hourly jobs still run **concurrently** inside one `waitUntil`. They must not be awaited in
sequence: `runHeartbeat`'s alert path calls `slackFetch`, which has no timeout and honours an
uncapped `Retry-After`, so a pending heartbeat would block the healer indefinitely.

### The stall threshold is measured, and time-of-week aware

`HEARTBEAT_MAX_SILENCE_HOURS` defaulted to 24 — an unmeasured guess that cost ~28 h to notice a
stall. Measured over 2,618 processed mentions across 66 days of production D1 (2026-09-12): mean gap
**0.6 h**; 25 gaps over 6 h; **every** gap of 10 h or more fell on a Sat/Sun; weekday maximum
**8.8 h**; weekend maximum **20.3 h**; and exactly one gap over 24 h — the 26-hour outage itself.

So the threshold is **16 h on a weekday, 24 h at the weekend** (`stallThresholdHours`, Melbourne
local day): 7.2 h of headroom over the worst weekday gap on record, and weekday detection in ~16 h
instead of ~28 h. Public holidays behave like weekdays — that is what the headroom is for.

It is **one shared predicate**, used by `/health` and by the in-Worker Slack alert, so the two can
never disagree about what "stalled" means. `HEARTBEAT_MAX_SILENCE_HOURS`, when set, still overrides
both days with one flat value.

### Two gauges, not one

`latestMentionReceivedAt()` was misnamed: `source` is NULL at `append()` time and set only by
`markProcessed()`, so it required successful **processing**, not arrival. A dead queue consumer was
therefore indistinguishable from a silent upstream, and both took ~28 h to detect. `/health` now
reports `lastReceivedAt` (unfiltered) alongside `lastProcessedAt` (renamed
`latestProcessedMentionAt`). Recent received + stale processed is an unambiguous "our pipeline is
broken", available in minutes, and it separates two faults with completely different responses.

### Why `checks.processing` tolerates 45 minutes

Reconcile re-processes *every* event in its 72 h window on each 15-minute tick, so a dead queue
consumer alone is healed within a tick or two and costs only latency. An event still unprocessed
after three reconcile cycles means the consumer **and** the reconcile are both failing. The 24 h
window is what lets a genuinely poisoned event age out instead of pinning the monitor red forever.

### Still not covered

- **Slack delivery is not asserted.** `checks.feed` proves mentions *arrive*, not that they are
  posted. A feed ingesting normally while every Slack post fails reads healthy until those failures
  age past the heal window and trip `checks.failures`.
- **`headwater-ingest-dlq` has no consumer** and is referenced nowhere in the code. Messages failing
  5 retries land there and stay; depth is unobservable. Reconcile's 72 h window means it is not the
  only recovery path, and `checks.processing` catches the *consequence*, but not the queue itself.
- **Queues, the Durable Object and Browser Rendering are unmonitored** beyond their effects.
- **A wiped database reads healthy**, because empty gauges are treated as "no evidence yet".
- **Nothing monitors the monitor.** Re-run the throwaway-heartbeat drill on a calendar rather than
  assuming BetterStack is fine.
