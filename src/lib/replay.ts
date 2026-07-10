import type { Env } from "@/env";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { deleteSlack } from "@/lib/slack/post";
import { processEvent } from "@/lib/process";

export interface ReplayResult {
  reset: boolean;
  purged: number; // old bot messages deleted from the channel
  purgeNote?: string; // why the purge stopped (e.g. a Slack error like "missing_scope")
  events: number; // real events reprocessed
  skipped: number; // synthetic/unparseable events skipped
  posted: number;
  merged: number;
  failed: number; // kept mentions whose Slack call failed this pass (still un-`seen` → retried next tick)
  errors: number; // events that threw during reprocessing
}

/** Delete this bot's own messages in a channel (clean slate before a backfill). Best-effort. */
async function purgeBotMessages(env: Env, channel: string): Promise<{ deleted: number; note?: string }> {
  if (!env.SLACK_BOT_TOKEN || !channel) return { deleted: 0, note: "no_token_or_channel" };
  let cursor: string | undefined;
  let deleted = 0;
  let seenMsgs = 0;
  try {
    for (let page = 0; page < 30; page++) {
      const params = new URLSearchParams({ channel, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch("https://slack.com/api/conversations.history?" + params.toString(), {
        headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; messages?: { ts: string; bot_id?: string; app_id?: string; subtype?: string; user?: string }[]; response_metadata?: { next_cursor?: string } }
        | null;
      if (!data?.ok) return { deleted, note: `history:${data?.error ?? "unknown"}` };
      for (const msg of data.messages ?? []) {
        seenMsgs++;
        if (msg.bot_id || msg.app_id || msg.subtype === "bot_message") {
          const del = await deleteSlack(env, channel, msg.ts).catch(() => ({ ok: false }));
          if (del.ok) deleted++;
        }
      }
      cursor = data.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (e) {
    return { deleted, note: `error:${String(e)} (deleted ${deleted})` };
  }
  return { deleted, note: deleted === 0 ? `no_bot_messages_matched (saw ${seenMsgs})` : `done (saw ${seenMsgs})` };
}

/**
 * Reparse the verbatim payloads archived in `webhook_events` and run them back through the
 * pipeline — used to backfill the channel after a parser/format fix without waiting for new
 * webhooks. Synthetic `documents[]`-shape test injections are skipped; only the real "Every
 * Mention" webhooks are replayed, oldest first (so syndication/near-dup merging recomputes in order).
 * `reset` clears `seen_mentions` + `stories` first so dedupe/merge state is rebuilt from scratch.
 */
export async function replayArchivedEvents(
  env: Env,
  opts: { reset?: boolean; purge?: boolean; purgeOnly?: boolean; limit?: number; sinceMs?: number; untilMs?: number } = {},
): Promise<ReplayResult> {
  const db = env.DB;
  const res: ReplayResult = { reset: !!opts.reset, purged: 0, events: 0, skipped: 0, posted: 0, merged: 0, failed: 0, errors: 0 };

  if (opts.purge || opts.purgeOnly) {
    const p = await purgeBotMessages(env, env.SLACK_DEFAULT_CHANNEL ?? "");
    res.purged = p.deleted;
    res.purgeNote = p.note;
  }
  if (opts.purgeOnly) return res; // purge without reposting (re-runnable until the channel is clear)

  if (opts.reset) {
    await db.prepare("DELETE FROM seen_mentions").run();
    await db.prepare("DELETE FROM stories").run();
    // A reset is a rebuild-from-scratch: also blank each event's derived processing columns so the
    // rebuild reflects current config. Without this, the monotonic `markProcessed` would preserve a
    // stale `posted`/`slack_ts` on an event that now (e.g. under tightened filters) drops. Skipped
    // for a `limit` reset, which selects `WHERE posted = 1` and must see the pre-reset posted rows.
    // Leave `decision = 'error'` rows untouched: an un-parseable (non-JSON) event is skipped by the
    // reprocess loop below, so blanking it would erase its error signal with nothing to recompute it
    // (a valid-JSON Slack-failure error IS reprocessed, and the monotonic CASE lets its new outcome
    // win, so those still rebuild correctly without blanking).
    if (!opts.limit) {
      await db
        .prepare("UPDATE webhook_events SET decision = 'logged', posted = 0, slack_ts = NULL, parsed_json = NULL, error = NULL, reason = NULL WHERE decision != 'error'")
        .run();
    }
  }

  // Full backfill: every event oldest-first (so syndication/near-dup merging recomputes in order).
  // With `limit`: just the N most recent *posted* real events — still processed oldest-first — for a
  // small spot-check regen after a wipe.
  // With `sinceMs`/`untilMs` (the reconcile cron): a bounded receipt-time window, oldest-first —
  // seen-aware, so already-handled mentions are skipped as duplicates and only un-posted stragglers
  // actually re-post/merge. Never falls into the DESC/`posted=1` limit branch.
  type Row = { id: string; raw_json: string; received_at: number };
  let rows: Row[];
  if (opts.limit && opts.limit > 0) {
    rows = (
      (await db
        .prepare("SELECT id, raw_json, received_at FROM webhook_events WHERE posted = 1 ORDER BY received_at DESC LIMIT ?")
        .bind(opts.limit)
        .all<Row>()).results ?? []
    ).reverse();
  } else {
    // Full backfill, or a bounded reconcile window when sinceMs/untilMs are given — the defaults
    // (0 … MAX) span everything, so this one query serves both, always oldest-first.
    const since = opts.sinceMs ?? 0;
    const until = opts.untilMs ?? Number.MAX_SAFE_INTEGER;
    rows =
      (await db
        .prepare("SELECT id, raw_json, received_at FROM webhook_events WHERE received_at >= ?1 AND received_at < ?2 ORDER BY received_at ASC")
        .bind(since, until)
        .all<Row>()).results ?? [];
  }

  const eventLog = new EventLog(db);
  const seen = new SeenStore(db);

  for (const r of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.raw_json);
    } catch {
      res.skipped++;
      continue;
    }
    // Skip the synthetic `documents[]` test injections — replay only the real "Every Mention" feed.
    if (payload && typeof payload === "object" && Array.isArray((payload as { documents?: unknown }).documents)) {
      res.skipped++;
      continue;
    }
    try {
      const summary = await processEvent(env, eventLog, seen, r.id, payload, r.received_at);
      res.events++;
      res.posted += summary.posted;
      res.merged += summary.merged;
      res.failed += summary.failed;
    } catch {
      res.errors++;
    }
  }

  return res;
}
