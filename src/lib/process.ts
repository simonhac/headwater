import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { applyFilters, resolveBrief } from "@/lib/filter/engine";
import { buildBlocks, buildPostPayload } from "@/lib/slack/format";
import { postToSlack, updateSlack } from "@/lib/slack/post";
import { StoryStore, storyKey, addOutlet, type Outlet } from "@/lib/story";
import { feedConfig } from "@/config/feed.config";
import { sha256Hex } from "@/lib/ids";

/** Only merge syndications seen within this window; older repeats are treated as new stories. */
const SYNDICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface DocResult {
  title: string | null;
  source: string | null;
  url: string | null;
  brief?: string;
  /** "preview" = passed filters but POSTING_ENABLED=false. "merged" = folded into an existing story. */
  decision: "posted" | "dropped" | "duplicate" | "preview" | "merged";
  reason?: string;
  blocks?: unknown[];
  slackTs?: string;
}

export interface ProcessSummary {
  total: number;
  posted: number;
  dropped: number;
  duplicates: number;
  merged: number;
  results: DocResult[];
}

const outletOf = (m: NormalizedMention): Outlet => ({
  name: m.sourceName ?? "Unknown source",
  url: m.url,
  reach: m.reach,
});

/** Outlet names other than the headlined (primary) one. */
function otherOutletNames(outlets: Outlet[], primary: NormalizedMention): string[] {
  const primName = (primary.sourceName ?? "").toLowerCase();
  return outlets.filter((o) => o.url !== primary.url && o.name.toLowerCase() !== primName).map((o) => o.name);
}

/** parse → filter → dedupe → (syndication-merge | post) → record per-doc results. */
export async function processEvent(
  env: Env,
  eventLog: EventLog,
  seen: SeenStore,
  eventId: string,
  payload: unknown,
): Promise<ProcessSummary> {
  const postingEnabled = env.POSTING_ENABLED === "true";
  const stories = new StoryStore(env.DB);
  const mentions = parseWebhookPayload(payload);
  const { kept, dropped } = applyFilters(mentions, feedConfig);

  const results: DocResult[] = [];
  let posted = 0;
  let duplicates = 0;
  let merged = 0;
  const now = Date.now();

  for (const d of dropped) {
    results.push({
      title: d.mention.title,
      source: d.mention.sourceName,
      url: d.mention.url,
      decision: "dropped",
      reason: d.reason,
    });
  }

  for (const { mention, brief } of kept) {
    const channel = brief.channel ?? env.SLACK_DEFAULT_CHANNEL ?? "";
    const blocks = buildBlocks(mention, brief);
    const dedupeKey = mention.url
      ? await sha256Hex(mention.url)
      : await sha256Hex(`${mention.sourceName}|${mention.title}`);

    if (await seen.has(dedupeKey)) {
      duplicates++;
      results.push({ title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, decision: "duplicate", blocks });
      continue;
    }

    if (!postingEnabled) {
      results.push({ title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, decision: "preview", reason: "POSTING_ENABLED=false", blocks });
      continue;
    }

    // --- syndication: is this the same story as one we already posted? ---
    const key = mention.title ? await storyKey(mention.title) : null;
    const existing = key ? await stories.getFresh(key, now - SYNDICATION_WINDOW_MS) : null;

    if (existing && key) {
      const outlets = addOutlet(JSON.parse(existing.outlets_json) as Outlet[], outletOf(mention));
      const primary = JSON.parse(existing.primary_mention_json) as NormalizedMention;
      const primaryBrief = resolveBrief(primary, feedConfig);
      const upd = await updateSlack(env, {
        channel: existing.channel,
        ts: existing.slack_ts,
        text: `${primary.sourceName ?? "News"}: ${primary.title ?? ""}`,
        blocks: buildBlocks(primary, primaryBrief, otherOutletNames(outlets, primary)),
      });
      if (upd.ok) await stories.updateOutlets(key, outlets, now);
      await seen.add(dedupeKey, mention.url ?? "", now);
      merged++;
      results.push({
        title: mention.title,
        source: mention.sourceName,
        url: mention.url,
        brief: brief.label,
        decision: "merged",
        reason: upd.ok ? `folded into ${existing.slack_ts}` : `update_failed:${upd.error ?? "?"}`,
        blocks,
      });
      continue;
    }

    // --- new story: post it ---
    const r = await postToSlack(env, buildPostPayload(mention, brief, channel));
    if (r.ok && r.ts) {
      if (key) {
        await stories.create({
          key,
          slackTs: r.ts,
          channel,
          briefLabel: brief.label,
          primary: mention,
          outlets: [outletOf(mention)],
          now,
        });
      }
      await seen.add(dedupeKey, mention.url ?? "", now);
      posted++;
      results.push({ title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, decision: "posted", slackTs: r.ts, blocks });
    } else {
      results.push({ title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, decision: "dropped", reason: `slack_error:${r.error ?? "unknown"}`, blocks });
    }
  }

  const summary: ProcessSummary = { total: mentions.length, posted, dropped: dropped.length, duplicates, merged, results };

  const decision =
    posted > 0 ? "posted" : merged > 0 ? "merged" : kept.length > 0 && !postingEnabled ? "preview" : dropped.length && !kept.length ? "dropped" : "logged";
  const firstTs = results.find((r) => r.slackTs)?.slackTs ?? null;
  await eventLog.markProcessed(eventId, {
    parsed: summary,
    decision,
    posted: posted > 0,
    source: mentions[0]?.sourceName ?? null,
    slackTs: firstTs,
  });

  return summary;
}
