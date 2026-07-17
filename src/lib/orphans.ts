/**
 * Orphan sweep: delete the bot's own CARD messages whose ts has no backing `stories` row.
 *
 * A story is one Slack message (`stories.slack_ts`). If a story row is removed but its Slack message
 * isn't (e.g. a `chat.delete` during coalesce that reported done without actually removing it, or a ts
 * mismatch), the card lingers as an ORPHAN — visible in the channel, tracked by nothing. This walks the
 * channel history (like {@link replay.purgeBotMessages}) and deletes only attachment-bearing bot
 * messages whose ts isn't a current story's ts. Text posts (heartbeat alerts have no attachment) are
 * never touched. dryRun previews; capped per call + re-runnable (idempotent).
 */
import type { Env } from "@/env";
import { deleteSlack } from "@/lib/slack/post";

export interface OrphanSample {
  ts: string;
  label: string; // masthead (+ headline) of the orphan card, for the dryRun report
}

export interface OrphanResult {
  dryRun: boolean;
  channel: string;
  scanned: number; // bot card messages seen in the channel
  stories: number; // story rows (valid ts) loaded from D1
  orphans: number; // bot cards with no backing story
  deleted: number; // orphans removed (0 on dryRun)
  failed: number; // chat.delete failures (kept for a re-run)
  remaining: number; // orphans left unprocessed because the per-call cap was hit — re-run
  note?: string; // why the scan stopped (e.g. a Slack history error)
  samples: OrphanSample[]; // capped preview of the orphans found
}

// Cap chat.delete calls per invocation to stay under Cloudflare's subrequest limit (mirrors coalesce/
// redecode). Excess orphans are reported as `remaining`; re-run until it's 0.
const MAX_DELETES_PER_CALL = 40;
const MAX_SAMPLES = 200;

/** Every valid story message ts (across channels) — the allow-list an orphan is NOT in. */
async function loadStoryTs(env: Env): Promise<Set<string>> {
  const res = await env.DB.prepare("SELECT slack_ts FROM stories").all<{ slack_ts: string }>();
  return new Set((res.results ?? []).map((r) => r.slack_ts));
}

interface HistoryMessage {
  ts: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  user?: string;
  attachments?: { author_name?: string; title?: string }[];
}

export async function sweepOrphans(env: Env, opts: { dryRun: boolean }): Promise<OrphanResult> {
  const channel = env.SLACK_DEFAULT_CHANNEL ?? "";
  const res: OrphanResult = {
    dryRun: opts.dryRun,
    channel,
    scanned: 0,
    stories: 0,
    orphans: 0,
    deleted: 0,
    failed: 0,
    remaining: 0,
    samples: [],
  };
  if (!env.SLACK_BOT_TOKEN || !channel) {
    res.note = "no_token_or_channel";
    return res;
  }

  const valid = await loadStoryTs(env);
  res.stories = valid.size;

  let cursor: string | undefined;
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({ channel, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const r = await fetch("https://slack.com/api/conversations.history?" + params.toString(), {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await r.json().catch(() => null)) as
      | { ok?: boolean; error?: string; messages?: HistoryMessage[]; response_metadata?: { next_cursor?: string } }
      | null;
    if (!data?.ok) {
      res.note = `history:${data?.error ?? "unknown"}`;
      break;
    }
    for (const m of data.messages ?? []) {
      // Only the bot's own CARD posts — an attachment-bearing bot message. Skips heartbeat/text posts
      // (no attachment) and any human messages, so those are never at risk.
      const isBotCard = !!(m.bot_id || m.app_id || m.subtype === "bot_message") && (m.attachments?.length ?? 0) > 0;
      if (!isBotCard) continue;
      res.scanned++;
      if (valid.has(m.ts)) continue; // has a backing story → keep
      res.orphans++;
      if (res.samples.length < MAX_SAMPLES) {
        const a = m.attachments?.[0];
        const label = a?.author_name ? `${a.author_name}${a.title ? ": " + a.title : ""}` : (a?.title ?? "(card)");
        res.samples.push({ ts: m.ts, label });
      }
      if (opts.dryRun) continue;
      if (res.deleted + res.failed >= MAX_DELETES_PER_CALL) {
        res.remaining++;
        continue;
      }
      const del = await deleteSlack(env, channel, m.ts).catch(() => ({ ok: false, error: "throw" }) as const);
      if (del.ok || del.error === "message_not_found") res.deleted++;
      else res.failed++;
    }
    cursor = data.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return res;
}
