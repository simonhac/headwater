import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { EventLog } from "@/lib/store/eventLog";
import { SeenStore } from "@/lib/store/seen";
import { parseWebhookPayload } from "@/lib/meltwater/parse";
import { applyFilters, resolveBrief } from "@/lib/filter/engine";
import { buildAttachment, buildStoryAttachment, buildPostPayload, attachmentHash } from "@/lib/slack/format";
import { postToSlack, updateSlack } from "@/lib/slack/post";
import { StoryStore, storyKeyAt, storyKeyPrefix, outletOf, addOutlet, addBriefLabel, type Outlet, type StoryRow } from "@/lib/story";
import { feedConfig } from "@/config/feed.config";
import { simhash64 } from "@/lib/simhash";
import { buildSketch, type PhraseSketch } from "@/lib/nearmatch";
import { isNearDupPair, sideForStory, airtimeMs, normMediaType, type NearDupSide } from "@/lib/neardup";
import { stationCodeFor, viewerUrlForRaw } from "@/lib/meltwater/station-resolve";
import { stationNameForCode, upsertStationName } from "@/lib/meltwater/stations";
import { looksLikePerson } from "@/lib/meltwater/outlets";
import { broadcastMediumLabel } from "@/lib/slack/format";
import { enqueueStationRender, resolveStationNow } from "@/do/client";
import { decide } from "@/lib/decide";
import { sha256Hex } from "@/lib/ids";
import { channelsFor, loadRouting } from "@/lib/routing";

/** Only merge syndications seen within this window; older repeats are treated as new stories. */
const SYNDICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

const nd = feedConfig.nearDuplicate;

/** Best-effort synchronous station-name render budget at ingest (ms). A healthy Meltwater viewer
 * titles in ~1-2s; past this we fall back to the neutral masthead + deferred renderer so a slow or
 * broken viewer never stalls the queue consumer. */
const STATION_RESOLVE_DEADLINE_MS = 9000;

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
  /** The Slack channel this result concerns. A mention routed to N channels yields N results. */
  channel?: string;
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


/**
 * Resolve a broadcast item's station. In order:
 *   1. D1 code→name cache — a station named earlier by any means wins (no browser).
 *   2. authorName-trust — a station-like header IS the station; keep it and seed the map so every
 *      future item of this station (and the redecode backfill) resolves for free, render-free.
 *   3. a presenter's name with no known station → on the live post/merge path (`sync=true`) try a
 *      best-effort SYNCHRONOUS render (via the StationRenderer DO, so budget/spacing/backoff stay
 *      centralized) so the near-dup decision sees the real outlet; on a miss (or when `sync=false`)
 *      fall back to moving the presenter to the byline, a neutral medium masthead, and enqueuing the
 *      code for the deferred background renderer.
 * Best-effort; a resolution failure just leaves the safety-net card, never throws into the pipeline.
 */
async function resolveBroadcastOutlet(env: Env, mention: NormalizedMention, now: number, sync = false): Promise<void> {
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

  // 3. A presenter's name with no known station. On the live post/merge path (`sync`), try a
  //    best-effort SYNCHRONOUS render first, so the near-dup decision below sees the real outlet. The
  //    candidate side reads the story's FROZEN sourceName, so an ABC TV↔radio simulcast only folds if
  //    the name is resolved BEFORE the story row is created — resolving it here (usually seconds) is
  //    what prevents a second, separately-notified card. On a miss (budget/spacing/slow viewer) fall
  //    back to the neutral masthead + deferred renderer, exactly as before.
  const url = viewerUrlForRaw(mention.raw);
  if (sync && code && url) {
    const name = await resolveStationNow(env, code, url, STATION_RESOLVE_DEADLINE_MS);
    if (name) {
      promoteStation(mention, name);
      return;
    }
  }
  if (header && !mention.author) mention.author = header;
  mention.sourceName = broadcastMediumLabel(mention.mediaType);
  if (code && url) await enqueueStationRender(env, code, url);
}

/** Promote a resolved station to the masthead, demoting any presenter currently there to the byline. */
function promoteStation(mention: NormalizedMention, station: string): void {
  if (station.toLowerCase() === (mention.sourceName ?? "").toLowerCase()) return;
  if (!mention.author && mention.sourceName) mention.author = mention.sourceName;
  mention.sourceName = station;
}

/**
 * The recent broadcast story in the SAME channel that this mention duplicates, or null. Delegates
 * the per-candidate decision to the shared `isNearDupPair` predicate (same media type + air-time
 * proximity, then SimHash fast path or phrase containment + verbatim run), so ingestion and the
 * coalesce backfill judge dups
 * identically. An identical-enough fingerprint short-circuits to that candidate; otherwise the
 * highest phrase-overlap candidate wins.
 */
async function findNearDup(
  stories: StoryStore,
  mention: NormalizedMention,
  fp: bigint | null,
  sketch: PhraseSketch | null,
  now: number,
  channel: string,
): Promise<StoryRow | null> {
  const since = now - nd.windowHours * 60 * 60 * 1000;
  const inc: NearDupSide = {
    fp,
    sketch,
    airtime: airtimeMs(mention.title),
    mediaType: normMediaType(mention.mediaType),
    // Station resolved before this call (resolveBroadcastOutlet), so an ABC simulcast is identifiable.
    station: mention.sourceName,
  };

  let best: StoryRow | null = null;
  let bestOverlap = -1;
  for (const c of await stories.recentWithSimhash(since, channel)) {
    const v = isNearDupPair(inc, sideForStory(c, nd), nd);
    if (v.fast) return c; // fast path — accept the first (oldest) all-but-identical fingerprint.
    if (v.match && v.overlap > bestOverlap) {
      best = c;
      bestOverlap = v.overlap;
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
  const routing = await loadRouting(env.DB);
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

    // Where this brief posts: its routed channels, or the default channel when unrouted. Empty
    // means the brief was explicitly muted on /inspect/routing.
    const channels = channelsFor(brief.id, routing, env);
    if (channels.length === 0) {
      // Record it rather than dropping it on the floor: a muted brief must still be visible in
      // /inspect (and countable as `dropped`), or a mis-tick looks identical to a dead feed.
      dropped.push({ mention, reason: "muted: no channel routed for this brief" });
      results.push({
        title: mention.title,
        source: mention.sourceName,
        url: mention.url,
        brief: brief.label,
        decision: "dropped",
        reason: "muted: no channel routed for this brief",
      });
      continue;
    }

    // Brief- AND channel-scoped so the SAME article matched by a DIFFERENT brief — or destined for a
    // DIFFERENT channel — isn't silently dropped as a duplicate. A same-brief repeat flows into the
    // merge path below and is recorded as "also matched".
    const canonical = mention.url ?? `${mention.sourceName}|${mention.title}`;
    // TODO(fanout-cutover): drop `legacyKey` and the `defaultChannel` comparison once every
    // pre-fanout mention has aged out of the 72h reconcile window (deploy date + 72h).
    const legacyKey = await sha256Hex(`${brief.id}|${canonical}`);
    const defaultChannel = env.SLACK_DEFAULT_CHANNEL ?? "";
    const dedupeKeys = new Map<string, string>(); // channel → its per-channel seen key
    const seenByChannel = new Map<string, boolean>();
    for (const ch of channels) {
      const k = await sha256Hex(`${brief.id}|${ch}|${canonical}`);
      dedupeKeys.set(ch, k);
      // The default channel also honours the pre-fanout key, so the 72h reconcile doesn't repost
      // everything it already delivered. Heal forward: record the new key (INSERT OR IGNORE, so
      // re-writing an existing one is free) and the legacy branch can be deleted after cutover.
      const legacyApplies = ch === defaultChannel;
      const hit = await seen.hasAny(legacyApplies ? [k, legacyKey] : [k]);
      if (hit && legacyApplies) await seen.add(k, mention.url ?? "", now);
      seenByChannel.set(ch, hit);
    }
    const anyUnseen = channels.some((ch) => !seenByChannel.get(ch));

    // A url-bearing broadcast we're actually about to post/merge somewhere still needs its station
    // for the card (`buildAttachment` below). All-duplicate mentions skip this — their card is only
    // a debug preview. Resolved once per mention, not per channel: it mutates `mention`.
    if (broadcast && mention.url && anyUnseen) await resolveBroadcastOutlet(env, mention, now, true);

    const blocks = buildAttachment(mention, brief, [], [], now); // stored on DocResult for the /inspect preview
    const base = { title: mention.title, source: mention.sourceName, url: mention.url, brief: brief.label, blocks };

    // Fingerprints are channel-independent, so compute them once for the whole fanout — only the
    // story lookup below is per-channel.
    let simhashStr: string | null = null;
    let simFp: bigint | null = null;
    let sketch: PhraseSketch | null = null;
    if (anyUnseen && postingEnabled) {
      const doNearDup = nd.enabled && broadcast;
      simFp = doNearDup ? simhash64(mention.snippet, nd.shingleSize) : null;
      simhashStr = simFp === null ? null : simFp.toString();
      sketch = doNearDup ? buildSketch(mention.snippet, nd.containmentShingleSize) : null;
    }

    for (const channel of channels) {
      const dedupeKey = dedupeKeys.get(channel) as string;
      const isSeen = seenByChannel.get(channel) === true;
      const chBase = { ...base, channel };

      let key: string | null = null;
      let existing: StoryRow | null = null;
      if (!isSeen && postingEnabled) {
        // The prefix identifies the HEADLINE (for the merge lookup); the key identifies THIS card.
        // `now` is the event's received_at, so a replay recomputes the same key and re-merges.
        const prefix = mention.title ? await storyKeyPrefix(channel, mention.title) : null;
        key = prefix ? storyKeyAt(prefix, now) : null;
        // Same-title syndication first; then broadcast near-duplicate by shared phrase.
        existing = prefix ? await stories.getFresh(prefix, now - SYNDICATION_WINDOW_MS) : null;
        if (!existing && (simFp !== null || sketch !== null)) {
          existing = await findNearDup(stories, mention, simFp, sketch, now, channel);
        }
      }

      const action = decide({ seen: isSeen, postingEnabled, existing: !!existing });

      if (action === "duplicate") {
        duplicates++;
        results.push({ ...chBase, decision: "duplicate" });
        continue;
      }

      if (action === "preview") {
        results.push({ ...chBase, decision: "preview", reason: "POSTING_ENABLED=false" });
        continue;
      }

      if (action === "merge" && existing) {
        const outlets = addOutlet(JSON.parse(existing.outlets_json) as Outlet[], outletOf(mention));
        const briefLabels = addBriefLabel(JSON.parse(existing.brief_labels_json || "[]") as string[], brief.label);
        const primary = JSON.parse(existing.primary_mention_json) as NormalizedMention;
        const primaryBrief = resolveBrief(primary, feedConfig);
        const mergedCard = buildStoryAttachment(primary, primaryBrief, outlets, briefLabels.slice(1), existing.created_at);
        const upd = await updateSlack(env, { channel: existing.channel, ts: existing.slack_ts, attachments: [mergedCard] });
        // Only commit state when the update landed — mirror the post path. A failed update leaves the
        // mention un-`seen` and un-counted so a replay/reconcile retries it (the G1 fix). Committing
        // unconditionally would mark it `seen` forever and drop the syndicated outlet permanently.
        // Per channel, so a partial fanout failure only leaves the FAILED channel retryable.
        if (upd.ok) {
          await stories.updateOutlets(existing.story_key, outlets, briefLabels, attachmentHash(mergedCard), now);
          await seen.add(dedupeKey, mention.url ?? "", now);
          merged++;
          results.push({ ...chBase, decision: "merged", reason: `folded into ${existing.slack_ts}` });
        } else {
          failed++;
          results.push({ ...chBase, decision: "dropped", reason: `merge_failed:${upd.error ?? "unknown"}` });
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
        results.push({ ...chBase, decision: "posted", slackTs: r.ts });
      } else {
        failed++;
        results.push({ ...chBase, decision: "dropped", reason: `slack_error:${r.error ?? "unknown"}` });
      }
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
