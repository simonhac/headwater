/**
 * One-off (but permanent) maintenance sweep: coalesce broadcast duplicates that were posted as
 * SEPARATE Slack messages BEFORE the live shared-phrase near-dup detection deployed. Each such dup
 * is its own `stories` row with its own `slack_ts`. Going forward the pipeline folds these in place
 * (`process.ts` merge branch); this backfill does the same thing retroactively, IN PLACE — it edits
 * the oldest ("canonical") message to list all outlets and DELETES the redundant messages. It never
 * wipes/reposts, so reactions/threads/timestamps on the survivor are preserved (unlike
 * `/admin/replay?reset=1&purge=1`).
 *
 * Faithfulness: clusters are formed by the SAME `isNearDupPair` predicate the live engine uses, in a
 * STAR around the oldest anchor (the live engine compares a new mention only against a story's
 * primary and never re-clusters folded snippets — a transitive union-find would over-merge, since
 * the predicate is non-transitive). Two coalesce-only guards compensate for scanning a week instead
 * of the live 12h window: a receipt-time fallback for air-time-less items, and same-channel only.
 * Mirrors `redecode.ts`: dryRun, per-call Slack-call cap + `remaining`, re-runnable/idempotent.
 */
import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { resolveBrief } from "@/lib/filter/engine";
import { buildStoryAttachment, attachmentHash } from "@/lib/slack/format";
import { updateSlack, deleteSlack } from "@/lib/slack/post";
import { StoryStore, outletOf, addOutlet, addBriefLabel, otherOutlets, type Outlet, type StoryRow } from "@/lib/story";
import { feedConfig } from "@/config/feed.config";
import { isNearDupPair, sideForStory, type NearDupSide } from "@/lib/neardup";
import { reparseStory, resolveBroadcast } from "@/lib/redecode";
import { isBroadcastMedium } from "@/lib/meltwater/parse";
import { docIdFromLinks } from "@/lib/meltwater/station-resolve";
import { loadDocIdStationNames } from "@/lib/meltwater/stations";

const nd = feedConfig.nearDuplicate;

const MAX_CHANGES_REPORTED = 200;
// Cap total Slack calls (updates + deletes) per invocation to stay under Cloudflare's per-request
// subrequest limit (mirrors redecode's MAX_UPDATES_PER_CALL). Clusters past the cap are reported as
// `remaining`; re-run (it's idempotent) until `remaining` is 0.
const MAX_SLACK_CALLS_PER_CALL = 40;

export interface CoalesceChange {
  /** ts of the surviving (oldest) message the duplicates fold into. */
  canonicalTs: string;
  /** ts of each duplicate message to be (or that was) deleted. */
  dupTs: string[];
  /** Merged outlet names shown on the canonical card after coalescing. */
  outlets: string[];
}

export interface CoalesceResult {
  windowHours: number;
  dryRun: boolean;
  scanned: number; // broadcast stories loaded in the window
  clusters: number; // groups of >1 story found (duplicates to coalesce)
  updated: number; // canonical cards chat.update'd (0 on dryRun / when hash already matched)
  deleted: number; // duplicate messages chat.delete'd + their story rows removed (0 on dryRun)
  failed: number; // canonical updates that failed (cluster aborted) or dup deletes that failed (row kept)
  skippedCanonicalMissing: number; // canonical message already gone (message_not_found) — not merged
  remaining: number; // clusters left unprocessed because the per-call cap was hit — re-run to finish
  changes: CoalesceChange[]; // capped report (populated for both dryRun and real runs)
}

/** A story row plus its precomputed comparison side, air-time, channel and recency. */
interface Cand {
  row: StoryRow;
  side: NearDupSide;
  createdAt: number;
  channel: string;
}

export interface StoryCluster {
  canonical: StoryRow;
  dups: StoryRow[];
}

/**
 * Star-cluster broadcast stories (oldest-first) by re-running the live per-candidate near-dup loop
 * against the set of established anchors. Pure + exported for testing. `rows` MUST be ordered
 * `created_at ASC`. Returns only anchors that gathered ≥1 duplicate; the canonical is always the
 * oldest member. Union-find is deliberately NOT used: `isNearDupPair` is non-transitive, so its
 * transitive closure would collapse stories the live engine never judged equal.
 */
export function clusterBroadcastStories(rows: StoryRow[]): StoryCluster[] {
  const cands: Cand[] = rows.map((row) => ({
    row,
    side: sideForStory(row, nd),
    createdAt: row.created_at,
    channel: row.channel,
  }));

  const anchors: { anchor: Cand; dups: Cand[] }[] = [];
  const receiptFallbackMs = nd.windowHours * 60 * 60 * 1000;

  for (const s of cands) {
    let matched: { anchor: Cand; dups: Cand[] } | null = null;
    let bestOverlap = -1;
    for (const a of anchors) {
      // Coalesce guard 4 — same channel only, so a bulk sweep never yanks a message out of one
      // channel into another (live folds across channels, but that's surprising in bulk).
      if (a.anchor.channel !== s.channel) continue;
      // Coalesce guard 2b — receipt-time fallback. The live engine's only temporal bound for
      // air-time-less broadcasts is its 12h candidate window; scanning a week here drops that, so
      // require the two stories to have been received within `windowHours` when EITHER lacks an
      // air-time. When both parse, the ±maxAirtimeGapHours guard inside isNearDupPair is the bound.
      const eitherNoAir = a.anchor.side.airtime === null || s.side.airtime === null;
      if (eitherNoAir && Math.abs(a.anchor.createdAt - s.createdAt) > receiptFallbackMs) continue;

      const v = isNearDupPair(s.side, a.anchor.side, nd);
      if (v.fast) {
        matched = a; // fast path — fold into the first (oldest) all-but-identical anchor.
        break;
      }
      if (v.match && v.overlap > bestOverlap) {
        matched = a;
        bestOverlap = v.overlap;
      }
    }
    if (matched) matched.dups.push(s);
    else anchors.push({ anchor: s, dups: [] });
  }

  return anchors
    .filter((a) => a.dups.length > 0)
    .map((a) => ({ canonical: a.anchor.row, dups: a.dups.map((d) => d.row) }));
}

/** Current station name for a broadcast doc from the preloaded docId→name map, or null on a miss. */
function stationNameForRaw(raw: unknown, nameByDoc: Map<string, string>): string | null {
  const docId = docIdFromLinks((raw as { links?: unknown } | null)?.links);
  return docId ? (nameByDoc.get(docId) ?? null) : null;
}

/** Re-resolve a stored story's primary under the current station map — mirrors redecode's per-story
 * resolution (reparse the raw, then re-derive the broadcast headline from the D1 name), so a presenter
 * byline / neutral masthead frozen at ingestion is upgraded to the real station. Falls back to the
 * stored snapshot when there's no re-parseable raw. */
function resolvePrimary(row: StoryRow, nameByDoc: Map<string, string>): { primary: NormalizedMention; oldPrimary: NormalizedMention } {
  const { oldPrimary, reparsed } = reparseStory(row);
  if (!reparsed) return { primary: oldPrimary, oldPrimary };
  const primary = isBroadcastMedium(reparsed.mediaType)
    ? resolveBroadcast(reparsed, oldPrimary, stationNameForRaw(reparsed.raw, nameByDoc))
    : reparsed;
  return { primary, oldPrimary };
}

/**
 * Fold a cluster into one card's inputs, RE-RESOLVING every station from the current map so the merged
 * card shows real station names — not the presenter byline / neutral "Radio"/"TV" masthead frozen at
 * ingestion. The canonical's re-resolved primary becomes the headline; every member contributes its
 * re-resolved primary as an outlet, plus any extra outlets it had already merged — those too are
 * re-resolved, via the docId embedded in their stored tracking url (their per-mention raw is gone, but
 * the url carries the same id). A url with no resolvable docId keeps its stored name. Deduped by url/name.
 */
function resolveAndMerge(
  cluster: StoryCluster,
  nameByDoc: Map<string, string>,
): { primary: NormalizedMention; outlets: Outlet[]; briefLabels: string[] } {
  const members = [cluster.canonical, ...cluster.dups];
  let outlets: Outlet[] = [];
  let briefLabels: string[] = [];
  let canonicalPrimary: NormalizedMention | null = null;
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    const { primary, oldPrimary } = resolvePrimary(member, nameByDoc);
    if (i === 0) canonicalPrimary = primary;
    outlets = addOutlet(outlets, outletOf(primary));
    for (const o of otherOutlets(JSON.parse(member.outlets_json) as Outlet[], oldPrimary)) {
      // Re-resolve an already-merged outlet from its stored url's docId (the url is the same tracking
      // link docIdFromLinks unwraps). Keep the stored name when the url carries no resolvable docId.
      const docId = docIdFromLinks({ source: o.url });
      const resolved = docId ? nameByDoc.get(docId) : undefined;
      outlets = addOutlet(outlets, resolved ? { ...o, name: resolved } : o);
    }
    for (const bl of JSON.parse(member.brief_labels_json || "[]") as string[]) {
      briefLabels = addBriefLabel(briefLabels, bl);
    }
  }
  return { primary: canonicalPrimary!, outlets, briefLabels };
}

/**
 * Coalesce broadcast duplicate messages posted within the last `hours` in place. `now` is injected
 * (route passes Date.now()) to keep this deterministic. See the module doc for the strict ordering:
 * per cluster we chat.update the canonical, persist the merged outlets IMMEDIATELY (before any
 * delete, closing the crash window that would let `heal`/`redecode` revert the card), then delete
 * each duplicate message and remove its row only once Slack confirms it's gone.
 */
export async function coalesceDuplicateStories(
  env: Env,
  opts: { hours: number; dryRun: boolean; now: number },
): Promise<CoalesceResult> {
  const stories = new StoryStore(env.DB);
  // hours <= 0 means "all history" (day 0) — bound the load window otherwise.
  const sinceMs = opts.hours > 0 ? opts.now - opts.hours * 60 * 60 * 1000 : 0;
  const rows = await stories.broadcastStoriesSince(sinceMs);
  const clusters = clusterBroadcastStories(rows);
  // Preload the docId→station-name map once so re-resolving every clustered member is in-memory
  // (no per-item D1 read / browser). The map is complete for these items (all carry raw).
  const nameByDoc = await loadDocIdStationNames(env.DB);

  const res: CoalesceResult = {
    windowHours: opts.hours,
    dryRun: opts.dryRun,
    scanned: rows.length,
    clusters: clusters.length,
    updated: 0,
    deleted: 0,
    failed: 0,
    skippedCanonicalMissing: 0,
    remaining: 0,
    changes: [],
  };

  let slackCalls = 0;

  for (const cluster of clusters) {
    const canonical = cluster.canonical;
    const { primary, outlets, briefLabels } = resolveAndMerge(cluster, nameByDoc);
    const card = buildStoryAttachment(primary, resolveBrief(primary, feedConfig), outlets, briefLabels.slice(1), canonical.created_at);
    const newHash = attachmentHash(card);

    if (res.changes.length < MAX_CHANGES_REPORTED) {
      res.changes.push({ canonicalTs: canonical.slack_ts, dupTs: cluster.dups.map((d) => d.slack_ts), outlets: outlets.map((o) => o.name) });
    }

    if (opts.dryRun) continue; // report-only: no Slack, no D1.

    // Per-call cap: stop at a cluster boundary once we've spent our Slack-call budget. Always make
    // progress on at least the first cluster (slackCalls starts at 0).
    if (slackCalls >= MAX_SLACK_CALLS_PER_CALL) {
      res.remaining++;
      continue;
    }

    // 1. Update the canonical card — unless a prior partial run already merged it (hash-gate). A
    //    matching render_hash implies the merged outlets were already persisted (step 2 stores both
    //    together), so we can skip straight to retrying the deletes.
    if (canonical.render_hash !== newHash) {
      const upd = await updateSlack(env, { channel: canonical.channel, ts: canonical.slack_ts, attachments: [card] });
      slackCalls++;
      if (!upd.ok) {
        // Abort the cluster, touch nothing — re-runnable. Distinguish a canonical that's been
        // manually deleted (don't promote a new canonical in v1) from a real Slack failure.
        if (upd.error === "message_not_found") res.skippedCanonicalMissing++;
        else res.failed++;
        continue;
      }
      // 2. Persist the re-resolved primary + merged outlets + new render hash IMMEDIATELY, before any
      //    delete. This closes the window where the Slack card shows outlets D1 doesn't record —
      //    otherwise a crash mid-delete lets heal/redecode rebuild from the stale snapshot and revert.
      await stories.coalesceInto(canonical.story_key, primary, outlets, briefLabels, newHash, opts.now);
      res.updated++;
    }

    // 3. Delete each duplicate message, then remove its row once Slack confirms it's gone. Never
    //    delete the row first: a row-gone-but-message-still-there state orphans a visible duplicate
    //    that heal ignores forever. message_not_found = already gone = success (idempotent re-run).
    for (const dup of cluster.dups) {
      const del = await deleteSlack(env, dup.channel, dup.slack_ts);
      slackCalls++;
      if (del.ok || del.error === "message_not_found") {
        await stories.deleteStory(dup.story_key);
        res.deleted++;
      } else {
        res.failed++; // keep the row so a re-run retries this delete.
      }
    }
  }

  return res;
}
