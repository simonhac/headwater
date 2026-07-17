import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { applyFilters, resolveBrief } from "@/lib/filter/engine";
import { buildAttachment, buildPostPayload, attachmentHash } from "@/lib/slack/format";
import { postToSlack, updateSlack } from "@/lib/slack/post";
import { StoryStore, storyKey, addOutlet, addBriefLabel, otherOutlets, type Outlet, type StoryRow } from "@/lib/story";
import { feedConfig } from "@/config/feed.config";
import { simhash64, hammingDistance } from "@/lib/simhash";
import { buildSketch, phraseNearDup, type PhraseSketch } from "@/lib/nearmatch";
import { stationCodeFor, viewerUrlForRaw } from "@/lib/meltwater/station-resolve";
import { stationNameForCode, upsertStationName } from "@/lib/meltwater/stations";
import { looksLikePerson } from "@/lib/meltwater/outlets";
import { broadcastMediumLabel, broadcastAirtime } from "@/lib/slack/format";
import { enqueueStationRender } from "@/do/client";
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
  /** Kept mentions whose Slack post/update failed — un-`seen`, so a replay/reconcile retries them. */
  failed: number;
  results: DocResult[];
}

const outletOf = (m: NormalizedMention): Outlet => ({
  name: m.sourceName ?? "Unknown source",
  url: m.url,
  reach: m.reach,
});

/**
 * Resolve a broadcast item's station WITHOUT rendering (rendering is deferred to the StationRenderer
 * DO, which drains serially under the free-tier limits). In order:
 *   1. D1 code→name cache — a station named earlier by any means wins.
 *   2. authorName-trust — a station-like header IS the station; keep it and seed the map so every
 *      future item of this station (and the redecode backfill) resolves for free, render-free.
 *   3. otherwise it's a presenter's name → don't show a person as the outlet: move them to the byline,
 *      show a neutral medium masthead, and enqueue the code for the background renderer.
 * Best-effort; a resolution failure just leaves the safety-net card, never throws into the pipeline.
 */
async function resolveBroadcastOutlet(env: Env, mention: NormalizedMention, now: number): Promise<void> {
  const codeInfo = await stationCodeFor(env, mention.raw); // {docId, code} | null (caches docId→code)
  const code = codeInfo?.code ?? null;

  // 1. Known station → promote it, demoting any presenter currently in the header to the byline.
  const known = code ? await stationNameForCode(env.DB, code) : null;
  if (known) {
    promoteStation(mention, known);
    return;
  }

  // 2. Station-like header → trust it and seed the map (burst-proof; no browser; 0 render attempts).
  const header = mention.sourceName?.trim() || null;
  if (header && !looksLikePerson(header)) {
    if (code) await upsertStationName(env.DB, code, header, now, 0);
    return;
  }

  // 3. A presenter's name with no known station → safety net + queue the code for the serial renderer.
  if (header && !mention.author) mention.author = header;
  mention.sourceName = broadcastMediumLabel(mention.mediaType);
  const url = viewerUrlForRaw(mention.raw);
  if (code && url) await enqueueStationRender(env, code, url);
}

/** Promote a resolved station to the masthead, demoting any presenter currently there to the byline. */
function promoteStation(mention: NormalizedMention, station: string): void {
  if (station.toLowerCase() === (mention.sourceName ?? "").toLowerCase()) return;
  if (!mention.author && mention.sourceName) mention.author = mention.sourceName;
  mention.sourceName = station;
}

/** The primary mention's title + snippet, recovered from a story row (null on any parse failure). */
function primaryOf(row: StoryRow): { title: string | null; snippet: string | null } {
  try {
    const p = JSON.parse(row.primary_mention_json) as { title?: string | null; snippet?: string | null };
    return { title: p.title ?? null, snippet: p.snippet ?? null };
  } catch {
    return { title: null, snippet: null };
  }
}

/** Broadcast air-time (epoch ms) parsed from a title's RFC tail, or null when absent/unparseable. */
function airtimeMs(title: string | null): number | null {
  const tail = broadcastAirtime(title);
  if (!tail) return null;
  const t = Date.parse(tail);
  return Number.isNaN(t) ? null : t;
}

/**
 * The recent broadcast story this mention duplicates, or null. Two hard guardrails gate every
 * candidate FIRST — same media type, and broadcast air-times within `maxAirtimeGapHours` — so a
 * radio clip never folds into a TV story and a phrase re-used a day later never collapses. Then an
 * identical SimHash is a free accept (fast path); otherwise the transcripts must clear phrase
 * containment AND a contiguous verbatim run (`phraseNearDup`). Highest-overlap candidate wins.
 */
async function findNearDup(
  stories: StoryStore,
  mention: NormalizedMention,
  fp: bigint | null,
  sketch: PhraseSketch | null,
  now: number,
): Promise<StoryRow | null> {
  const since = now - nd.windowHours * 60 * 60 * 1000;
  const mediaType = (mention.mediaType ?? "").toLowerCase();
  const mAir = airtimeMs(mention.title);
  const maxGapMs = nd.maxAirtimeGapHours * 60 * 60 * 1000;

  let best: StoryRow | null = null;
  let bestOverlap = -1;
  for (const c of await stories.recentWithSimhash(since)) {
    // Guard 1 — same media type only (radio↔radio, tv↔tv), even with overlapping transcripts.
    if ((c.media_type ?? "").toLowerCase() !== mediaType) continue;
    const prim = primaryOf(c);
    // Guard 2 — air-time proximity. Only enforced when both air-times parse; otherwise the
    // `windowHours` receipt-time bound above is the sole temporal cap.
    if (mAir !== null) {
      const cAir = airtimeMs(prim.title);
      if (cAir !== null && Math.abs(cAir - mAir) > maxGapMs) continue;
    }
    // Fast path — an all-but-identical fingerprint is the same reading; accept without phrase work.
    if (fp !== null && c.simhash && hammingDistance(fp, BigInt(c.simhash)) <= nd.maxHammingDistance) {
      return c;
    }
    // Primary signal — k-gram containment + contiguous verbatim run over the transcripts.
    if (!sketch) continue;
    const cand = buildSketch(prim.snippet, nd.containmentShingleSize);
    if (!cand) continue;
    const { overlap, match } = phraseNearDup(sketch, cand, {
      minPhraseOverlap: nd.minPhraseOverlap,
      minContiguousRun: nd.minContiguousRun,
    });
    if (match && overlap > bestOverlap) {
      best = c;
      bestOverlap = overlap;
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
  /** The webhook-receipt time (epoch ms) from `webhook_events.received_at`. This is the single
   * source of truth for "now" — used for dedupe/story timestamps AND the card's footer date — so
   * replays reproduce the original moment instead of stamping the wall-clock. Never `Date.now()`. */
  receivedAtMs: number,
): Promise<ProcessSummary> {
  const postingEnabled = env.POSTING_ENABLED === "true";
  const stories = new StoryStore(env.DB);
  const mentions = parseWebhookPayload(payload);
  const { kept, dropped } = applyFilters(mentions, feedConfig);

  const results: DocResult[] = [];
  let posted = 0;
  let duplicates = 0;
  let merged = 0;
  let failed = 0;
  const now = receivedAtMs;

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
    const broadcast = isBroadcast(mention.mediaType);
    // Broadcast items carry no station in the payload — resolve it (cached; a cold miss hits Browser
    // Rendering). Resolve BEFORE the dedupe key only in the rare url-less case where the station is
    // part of the key; otherwise defer until we know the mention is un-`seen` (below). This keeps the
    // reconcile — which re-drives the 72h window every 15 min — from re-resolving (and re-rendering)
    // already-handled broadcast items, which would otherwise re-launch Browser Rendering each tick
    // for any clip whose station never resolved, exhausting the daily budget.
    if (broadcast && !mention.url) await resolveBroadcastOutlet(env, mention, now);

    // Brief-scoped so the SAME article matched by a DIFFERENT brief isn't silently dropped as a
    // duplicate — it flows into the merge path below and is recorded as "also matched".
    const canonical = mention.url ?? `${mention.sourceName}|${mention.title}`;
    const dedupeKey = await sha256Hex(`${brief.id}|${canonical}`);
    const isSeen = await seen.has(dedupeKey);

    // A url-bearing broadcast we're actually about to post/merge still needs its station for the card
    // (`buildAttachment` below). Duplicates skip this — their card is only a debug preview.
    if (broadcast && mention.url && !isSeen) await resolveBroadcastOutlet(env, mention, now);

    const channel = brief.channel ?? env.SLACK_DEFAULT_CHANNEL ?? "";
    const blocks = buildAttachment(mention, brief, [], [], now); // stored on DocResult for the /inspect preview
    const base = { title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, blocks };

    // Fingerprint + existing-story lookup are only needed when we might actually post/merge.
    let simhashStr: string | null = null;
    let key: string | null = null;
    let existing: StoryRow | null = null;
    if (!isSeen && postingEnabled) {
      const doNearDup = nd.enabled && broadcast;
      const simFp = doNearDup ? simhash64(mention.snippet, nd.shingleSize) : null;
      simhashStr = simFp === null ? null : simFp.toString();
      const sketch = doNearDup ? buildSketch(mention.snippet, nd.containmentShingleSize) : null;
      key = mention.title ? await storyKey(mention.title) : null;
      // Same-title syndication first; then broadcast near-duplicate by shared phrase.
      existing = key ? await stories.getFresh(key, now - SYNDICATION_WINDOW_MS) : null;
      if (!existing && (simFp !== null || sketch !== null)) {
        existing = await findNearDup(stories, mention, simFp, sketch, now);
      }
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
      const mergedCard = buildAttachment(primary, primaryBrief, otherOutlets(outlets, primary), briefLabels.slice(1), existing.created_at);
      const upd = await updateSlack(env, { channel: existing.channel, ts: existing.slack_ts, attachments: [mergedCard] });
      // Only commit state when the update landed — mirror the post path. A failed update leaves the
      // mention un-`seen` and un-counted so a replay/reconcile retries it (the G1 fix). Committing
      // unconditionally would mark it `seen` forever and drop the syndicated outlet permanently.
      if (upd.ok) {
        await stories.updateOutlets(existing.story_key, outlets, briefLabels, attachmentHash(mergedCard), now);
        await seen.add(dedupeKey, mention.url ?? "", now);
        merged++;
        results.push({ ...base, decision: "merged", reason: `folded into ${existing.slack_ts}` });
      } else {
        failed++;
        results.push({ ...base, decision: "dropped", reason: `merge_failed:${upd.error ?? "unknown"}` });
      }
      continue;
    }

    // --- new story: post it ---
    const r = await postToSlack(env, buildPostPayload(mention, brief, channel, now));
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
          renderHash: attachmentHash(blocks), // `blocks` is the attachment we just posted (buildPostPayload)
          now,
        });
      }
      await seen.add(dedupeKey, mention.url ?? "", now);
      posted++;
      results.push({ ...base, decision: "posted", slackTs: r.ts });
    } else {
      failed++;
      results.push({ ...base, decision: "dropped", reason: `slack_error:${r.error ?? "unknown"}` });
    }
  }

  const summary: ProcessSummary = { total: mentions.length, posted, dropped: dropped.length, duplicates, merged, failed, results };

  // Event-level decision, most-significant outcome first. `duplicate` (an all-`seen` re-run) and
  // `error` (a Slack failure that delivered nothing) are terminal states the reconcile / drift
  // gauge rely on: `duplicate` keeps a healthy re-run out of the drift count, `error` flags a real
  // undelivered event. See EventLog.markProcessed (monotonic — this never downgrades a posted row).
  const decision =
    posted > 0 ? "posted"
    : merged > 0 ? "merged"
    : duplicates > 0 ? "duplicate"
    : kept.length > 0 && !postingEnabled ? "preview"
    : dropped.length && !kept.length ? "dropped"
    : failed > 0 ? "error"
    : "logged";
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
