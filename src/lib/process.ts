import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { applyFilters, resolveBrief } from "@/lib/filter/engine";
import { buildAttachment, buildPostPayload } from "@/lib/slack/format";
import { postToSlack, updateSlack } from "@/lib/slack/post";
import { StoryStore, storyKey, addOutlet, addBriefLabel, type Outlet, type StoryRow } from "@/lib/story";
import { feedConfig } from "@/config/feed.config";
import { simhash64, hammingDistance } from "@/lib/simhash";
import { resolveStationName } from "@/lib/meltwater/station-resolve";
import { decide } from "@/lib/decide";
import { sha256Hex } from "@/lib/ids";

/** Only merge syndications seen within this window; older repeats are treated as new stories. */
const SYNDICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

const nd = feedConfig.nearDuplicate;

/** Does this media type opt into SimHash near-duplicate merging (radio/TV)? */
function isBroadcast(mediaType: string | null): boolean {
  const t = (mediaType ?? "").toLowerCase();
  return !!t && nd.mediaTypes.some((x) => t.includes(x.toLowerCase()));
}

export interface DocResult {
  title: string | null;
  source: string | null;
  url: string | null;
  brief?: string;
  /** "preview" = passed filters but POSTING_ENABLED=false. "merged" = folded into an existing story. */
  decision: "posted" | "dropped" | "duplicate" | "preview" | "merged";
  reason?: string;
  /** The built attachment (classic Slack attachment), kept for the /inspect preview. */
  blocks?: unknown;
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

/** Closest recent broadcast story whose transcript SimHash is within the configured Hamming distance. */
async function findNearDup(stories: StoryStore, fp: bigint, now: number): Promise<StoryRow | null> {
  const since = now - nd.windowHours * 60 * 60 * 1000;
  let best: StoryRow | null = null;
  let bestDist = nd.maxHammingDistance + 1;
  for (const c of await stories.recentWithSimhash(since)) {
    if (!c.simhash) continue;
    const dist = hammingDistance(fp, BigInt(c.simhash));
    if (dist <= nd.maxHammingDistance && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
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
    // Broadcast: the station name isn't in the payload — resolve it (cached) and prefer it as the
    // outlet, demoting any reporter in `sourceName` to the byline.
    if (isBroadcast(mention.mediaType)) {
      const station = await resolveStationName(env, mention.raw);
      if (station && station.toLowerCase() !== (mention.sourceName ?? "").toLowerCase()) {
        if (!mention.author && mention.sourceName) mention.author = mention.sourceName;
        mention.sourceName = station;
      }
    }

    const channel = brief.channel ?? env.SLACK_DEFAULT_CHANNEL ?? "";
    const blocks = buildAttachment(mention, brief); // stored on DocResult for the /inspect preview
    const base = { title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, blocks };
    // Brief-scoped so the SAME article matched by a DIFFERENT brief isn't silently dropped as a
    // duplicate — it flows into the merge path below and is recorded as "also matched".
    const canonical = mention.url ?? `${mention.sourceName}|${mention.title}`;
    const dedupeKey = await sha256Hex(`${brief.id}|${canonical}`);
    const isSeen = await seen.has(dedupeKey);

    // Fingerprint + existing-story lookup are only needed when we might actually post/merge.
    let simhashStr: string | null = null;
    let key: string | null = null;
    let existing: StoryRow | null = null;
    if (!isSeen && postingEnabled) {
      const simFp = nd.enabled && isBroadcast(mention.mediaType) ? simhash64(mention.snippet, nd.shingleSize) : null;
      simhashStr = simFp === null ? null : simFp.toString();
      key = mention.title ? await storyKey(mention.title) : null;
      existing = key ? await stories.getFresh(key, now - SYNDICATION_WINDOW_MS) : null;
      if (!existing && simFp !== null) existing = await findNearDup(stories, simFp, now);
    }

    const action = decide({ seen: isSeen, postingEnabled, existing: !!existing });

    if (action === "duplicate") {
      duplicates++;
      results.push({ ...base, decision: "duplicate" });
      continue;
    }

    if (action === "preview") {
      results.push({ ...base, decision: "preview", reason: "POSTING_ENABLED=false" });
      continue;
    }

    if (action === "merge" && existing) {
      const outlets = addOutlet(JSON.parse(existing.outlets_json) as Outlet[], outletOf(mention));
      const briefLabels = addBriefLabel(JSON.parse(existing.brief_labels_json || "[]") as string[], brief.label);
      const primary = JSON.parse(existing.primary_mention_json) as NormalizedMention;
      const primaryBrief = resolveBrief(primary, feedConfig);
      const upd = await updateSlack(env, {
        channel: existing.channel,
        ts: existing.slack_ts,
        attachments: [buildAttachment(primary, primaryBrief, otherOutletNames(outlets, primary), briefLabels.slice(1))],
      });
      if (upd.ok) await stories.updateOutlets(existing.story_key, outlets, briefLabels, now);
      await seen.add(dedupeKey, mention.url ?? "", now);
      merged++;
      results.push({
        ...base,
        decision: "merged",
        reason: upd.ok ? `folded into ${existing.slack_ts}` : `update_failed:${upd.error ?? "?"}`,
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
          briefLabels: [brief.label],
          primary: mention,
          outlets: [outletOf(mention)],
          simhash: simhashStr,
          mediaType: mention.mediaType,
          now,
        });
      }
      await seen.add(dedupeKey, mention.url ?? "", now);
      posted++;
      results.push({ ...base, decision: "posted", slackTs: r.ts });
    } else {
      results.push({ ...base, decision: "dropped", reason: `slack_error:${r.error ?? "unknown"}` });
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
